#!/usr/bin/env node
'use strict'

// Checks whether any advisory ignored in .grype.yaml now has a fix this repo
// can apply. Runs in CI after the Grype scan and before the push.
//
//   check-ignored-fixes.js <ignore-rules.json> <patches.json> <grype-report.json>...
//
// <ignore-rules.json> is the `ignore` list from .grype.yaml converted to JSON.
// Each report is Grype JSON output produced with that config, so the ignored
// findings are under `ignoredMatches`.
//
// A fix counts as applicable when either:
//   - the advisory lists a fixed version on the same major as the installed
//     copy, so it can be pinned in patches.json, or
//   - the copy sits inside npm, and a newer npm release (the latest on the
//     pinned major, or npm's `latest` tag) bundles only fixed copies, so the
//     npm pin can move.
//
// Exits 1 when any ignored advisory has an applicable fix. A rule that matched
// nothing in these reports gets a warning, since the rules are shared across
// flavors and a package may exist in only some of them.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const NPM_DIR = '/usr/local/lib/node_modules/npm/'

function main() {
  const [rulesPath, patchesPath, ...reportPaths] = process.argv.slice(2)
  if (!rulesPath || !patchesPath || reportPaths.length === 0) {
    throw new Error('usage: check-ignored-fixes.js <ignore-rules.json> <patches.json> <grype-report.json>...')
  }

  const rules = (JSON.parse(fs.readFileSync(rulesPath, 'utf8')) || []).filter((rule) => rule.vulnerability)
  const npmPin = JSON.parse(fs.readFileSync(patchesPath, 'utf8')).npm
  const reports = reportPaths.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))

  const npmCandidates = new NpmCandidates(npmPin)
  const lines = []
  let fixable = 0

  try {
    for (const rule of rules) {
      const label = `${rule.vulnerability} (${rule.package?.name || 'any package'})`
      const findings = ignoredFindings(reports, rule)
      if (findings.length === 0) {
        lines.push(`WARN  ${label}: no ignored finding in this image. Remove the rule if no flavor needs it.`)
        continue
      }

      for (const finding of findings) {
        const where = `${finding.name}@${finding.version} at ${finding.location}`
        const fixes = applicableFixes(finding, npmCandidates)
        if (fixes.length === 0) {
          lines.push(`OK    ${label}: no applicable fix yet for ${where} (advisory fixed in ${finding.fixVersions.join(', ') || 'no version'})`)
          continue
        }
        fixable += 1
        for (const fix of fixes) {
          lines.push(`FIX   ${label}: ${where}. ${fix} Then remove the rule from .grype.yaml.`)
        }
      }
    }
  } finally {
    npmCandidates.cleanup()
  }

  if (rules.length === 0) lines.push('No advisory rules in .grype.yaml.')
  for (const line of lines) console.log(line)
  writeSummary(lines, fixable)

  if (fixable > 0) {
    console.error(`${fixable} ignored finding(s) have a fix that can be applied. The image was not pushed.`)
    process.exit(1)
  }
}

// Ignored findings this rule applied to, deduplicated across platforms.
function ignoredFindings(reports, rule) {
  const seen = new Map()
  for (const report of reports) {
    for (const item of report.ignoredMatches || []) {
      const applied = (item.appliedIgnoreRules || []).some((r) =>
        r.vulnerability === rule.vulnerability &&
        (r.package?.name || '') === (rule.package?.name || '') &&
        (r.package?.location || '') === (rule.package?.location || ''))
      if (!applied) continue
      const location = item.artifact.locations?.[0]?.path || ''
      const key = `${item.artifact.name}@${item.artifact.version}@${location}`
      if (seen.has(key)) continue
      seen.set(key, {
        name: item.artifact.name,
        version: item.artifact.version,
        type: item.artifact.type,
        location,
        fixVersions: item.vulnerability.fix?.versions || [],
      })
    }
  }
  return [...seen.values()]
}

function applicableFixes(finding, npmCandidates) {
  const fixes = []
  const installed = tryParse(finding.version)
  const sameMajor = installed
    ? finding.fixVersions.filter((v) => {
      const fix = tryParse(v)
      return fix && fix.parts[0] === installed.parts[0] && compare(fix, installed) > 0
    })
    : []
  if (sameMajor.length > 0) {
    const where = finding.type === 'npm' ? ' Pin it in patches.json.' : ''
    fixes.push(`The advisory now lists ${sameMajor.join(', ')} on the installed major.${where}`)
  }

  if (finding.type === 'npm' && finding.location.startsWith(NPM_DIR)) {
    for (const candidate of npmCandidates.list()) {
      const copies = npmCandidates.bundledVersions(candidate, finding.name)
      const unfixed = copies.filter((v) => !isFixed(v, finding.fixVersions))
      if (unfixed.length === 0) {
        const bundled = copies.length ? `bundles ${finding.name} ${copies.join(', ')}` : `no longer bundles ${finding.name}`
        fixes.push(`npm ${candidate} ${bundled}. Move the npm pin in patches.json to ${candidate}.`)
      }
    }
  }
  return fixes
}

// A version is fixed when the advisory lists a fixed version on its major and it
// is at or above that version, or when it is on a newer major than every fix.
function isFixed(version, fixVersions) {
  const v = tryParse(version)
  const fixes = fixVersions.map(tryParse).filter(Boolean)
  if (!v || fixes.length === 0) return false
  const onMajor = fixes.filter((f) => f.parts[0] === v.parts[0])
  if (onMajor.length > 0) return onMajor.some((f) => compare(v, f) >= 0)
  return v.parts[0] > Math.max(...fixes.map((f) => f.parts[0]))
}

// npm releases newer than the pin: the latest on the pinned major and npm's
// `latest` tag. Each is downloaded once and read for its bundled packages.
class NpmCandidates {
  constructor(pin) {
    this.pin = pin
    this.dirs = new Map()
    this.tmp = null
    this.versions = null
  }

  list() {
    if (this.versions) return this.versions
    const onMajor = [].concat(npmView([`npm@${parse(this.pin).parts[0]}`, 'version']))
    const latest = npmView(['npm', 'dist-tags.latest'])
    const all = [...onMajor, latest].filter((v) => tryParse(v) && compare(parse(v), parse(this.pin)) > 0)
    all.sort((a, b) => compare(parse(a), parse(b)))
    const newestOnMajor = all.filter((v) => parse(v).parts[0] === parse(this.pin).parts[0]).pop()
    this.versions = [...new Set([newestOnMajor, latest].filter((v) => v && all.includes(v)))]
    return this.versions
  }

  bundledVersions(version, name) {
    const root = this.extract(version)
    const versions = new Set()
    const walk = (dir) => {
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const full = path.join(dir, entry.name)
        if (entry.name.startsWith('@')) {
          walk(full)
          continue
        }
        const manifest = path.join(full, 'package.json')
        if (fs.existsSync(manifest)) {
          const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
          if (pkg.name === name && pkg.version) versions.add(pkg.version)
        }
        const nested = path.join(full, 'node_modules')
        if (fs.existsSync(nested)) walk(nested)
      }
    }
    walk(path.join(root, 'node_modules'))
    return [...versions]
  }

  extract(version) {
    if (this.dirs.has(version)) return this.dirs.get(version)
    this.tmp ||= fs.mkdtempSync(path.join(os.tmpdir(), 'npm-candidates-'))
    const dest = path.join(this.tmp, version)
    fs.mkdirSync(dest)
    const tarball = execFileSync('npm', ['pack', `npm@${version}`, '--pack-destination', dest, '--silent'], {
      encoding: 'utf8',
      env: npmEnv(),
    }).trim().split('\n').pop()
    execFileSync('tar', ['-xzf', path.join(dest, tarball), '-C', dest, '--strip-components=1'])
    this.dirs.set(version, dest)
    return dest
  }

  cleanup() {
    if (this.tmp) fs.rmSync(this.tmp, { recursive: true, force: true })
  }
}

function npmView(args) {
  return JSON.parse(execFileSync('npm', ['view', ...args, '--json'], { encoding: 'utf8', env: npmEnv() }))
}

function writeSummary(lines, fixable) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) return
  const heading = fixable > 0
    ? `### Ignored advisories: ${fixable} finding(s) can be fixed now`
    : '### Ignored advisories: no applicable fix yet'
  fs.appendFileSync(file, `${heading}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`)
}

function npmEnv() {
  return {
    ...process.env,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'error',
  }
}

function compare(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

function tryParse(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(version || ''))
  if (!match) return null
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || '' }
}

function parse(version) {
  const parsed = tryParse(version)
  if (!parsed) throw new Error(`unsupported version: ${version}`)
  return parsed
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
