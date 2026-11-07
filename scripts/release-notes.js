#!/usr/bin/env node
'use strict'

// Builds the release for one publish day from the per-image result records
// that the image jobs upload.
//
//   release-notes.js <results-dir> <previous-images.json | -> <out-dir>
//
// Each record in <results-dir> is one image job's result (see "Record the
// result" in .github/workflows/images.yml). <previous-images.json> is the
// images.json of the release already published for the same day, when a
// second run that day updates it. Writes <out-dir>/notes.md and
// <out-dir>/images.json, and prints the number of published images.
//
// Environment: RELEASE_DATE (YYYYMMDD), RUN_URL, GITHUB_SHA.

const fs = require('node:fs')
const path = require('node:path')

function main() {
  const [resultsDir, previousPath, outDir] = process.argv.slice(2)
  if (!resultsDir || !previousPath || !outDir) {
    throw new Error('usage: release-notes.js <results-dir> <previous-images.json | -> <out-dir>')
  }
  const date = requireEnv('RELEASE_DATE')
  const runUrl = requireEnv('RUN_URL')
  const sha = requireEnv('GITHUB_SHA')

  const records = fs.readdirSync(resultsDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8')))

  const previous = previousPath === '-' ? [] : JSON.parse(fs.readFileSync(previousPath, 'utf8')).images || []

  // One entry per image and tag. A record from this run replaces an earlier one,
  // except that a failure never replaces an image that was already published today.
  const byKey = new Map()
  for (const entry of previous) byKey.set(key(entry), entry)
  for (const record of records) {
    const entry = record.status === 'published'
      ? { ...record, run: runUrl, commit: sha }
      : { ...record, run: runUrl }
    const earlier = byKey.get(key(entry))
    if (entry.status !== 'published' && earlier?.status === 'published') continue
    byKey.set(key(entry), entry)
  }

  const entries = [...byKey.values()].sort((a, b) => key(a).localeCompare(key(b)))
  const published = entries.filter((e) => e.status === 'published')
  const failed = entries.filter((e) => e.status !== 'published')

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'images.json'), `${JSON.stringify({ date: isoDate(date), images: entries }, null, 2)}\n`)
  fs.writeFileSync(path.join(outDir, 'notes.md'), notes(date, published, failed))
  console.log(published.length)
}

function notes(date, published, failed) {
  const out = []
  out.push(`Images published on ${isoDate(date)}. Every tag below points at the digest in its row.`)
  out.push('')

  if (published.length > 0) {
    out.push('| Image | Tags | Official base | Digest |')
    out.push('| --- | --- | --- | --- |')
    for (const e of published) {
      const tags = e.tags.map((t) => `\`${t.slice(t.lastIndexOf(':') + 1)}\``).join('<br>')
      out.push(`| \`${e.image}\` | ${tags} | \`${e.base}\` | \`${e.digest}\` |`)
    }
    out.push('')

    out.push('### Pull by digest')
    out.push('')
    out.push('```sh')
    for (const e of published) out.push(`docker pull docker.io/${e.image}@${e.digest}`)
    out.push('```')
    out.push('')

    out.push('### What each build changed')
    out.push('')
    for (const e of published) {
      out.push(`- \`${e.image}:${e.tag}\`: ${describeChanges(e.changes)}. Built from [\`${short(e.revision)}\`](${commitUrl(e.revision)}), published by [run ${e.run.split('/').pop()}](${e.run}).`)
    }
    out.push('')
  }

  if (failed.length > 0) {
    out.push('### Not published')
    out.push('')
    out.push('These images failed the scan, the ignored-advisory check, the smoke test, or the push. The previous tags stay as they were.')
    out.push('')
    for (const e of failed) out.push(`- \`${e.image}:${e.tag}\`: see [the run](${e.run}).`)
    out.push('')
  }

  out.push('`images.json` lists the same images for scripts.')
  out.push('')
  return out.join('\n')
}

// Node images record npm and the replaced npm packages. Alpine images record the
// apk packages that were upgraded, one "name (old -> new)" per line.
function describeChanges(changes) {
  if (!changes) return 'no change record in the image'
  if (Array.isArray(changes)) {
    return changes.length === 0
      ? 'Alpine had no package upgrades'
      : `Alpine upgraded ${changes.join(', ')}`
  }
  const packages = Object.entries(changes.packages || {}).map(([name, version]) => `${name} ${version}`)
  const parts = [`npm ${changes.npm}`]
  if (packages.length > 0) parts.push(`npm dependencies ${packages.join(', ')}`)
  return parts.join('; ')
}

function key(entry) {
  return `${entry.image}:${entry.tag}`
}

function short(sha) {
  return (sha || 'unknown').slice(0, 7)
}

function commitUrl(sha) {
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const repo = process.env.GITHUB_REPOSITORY || 'nutrina/node'
  return `${server}/${repo}/commit/${sha}`
}

function isoDate(date) {
  if (!/^\d{8}$/.test(date)) throw new Error(`RELEASE_DATE must be YYYYMMDD, got ${date}`)
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
