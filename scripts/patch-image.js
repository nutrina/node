#!/usr/bin/env node
'use strict'

// Applies patches.json to an official Node.js image during docker build.
// Upgrades distro packages, upgrades npm when the image ships an older one,
// and replaces npm's bundled dependencies with the versions named in the file.
// A replacement stays on the same major version and never downgrades a package
// that is already newer than the pin.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const NPM_ROOT = '/usr/local/lib/node_modules'

function main() {
  const patchesPath = process.argv[2]
  const baseTag = process.argv[3] || ''
  if (!patchesPath) {
    throw new Error('usage: patch-image.js <patches.json> [base-tag]')
  }

  const patches = JSON.parse(fs.readFileSync(patchesPath, 'utf8'))
  if (!patches.npm || !patches.packages) {
    throw new Error('patches.json must contain "npm" and "packages"')
  }

  upgradeOperatingSystem()
  const npmVersion = upgradeNpm(patches.npm)
  const packageVersions = patchPackages(patches.packages)

  const record = {
    baseTag,
    npm: npmVersion,
    packages: packageVersions,
    patchedAt: new Date().toISOString(),
  }
  fs.writeFileSync('/etc/node-image-patch.json', `${JSON.stringify(record, null, 2)}\n`)
  console.log(JSON.stringify(record))
}

function upgradeOperatingSystem() {
  if (fs.existsSync('/usr/bin/apt-get')) {
    console.log('upgrading debian packages')
    const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
    const apt = (args) => execFileSync('apt-get', args, { stdio: 'inherit', env })
    apt(['update', '-o', 'Acquire::Retries=3'])
    apt([
      'upgrade',
      '-y',
      '--no-install-recommends',
      '--with-new-pkgs',
      '-o', 'Dpkg::Options::=--force-confdef',
      '-o', 'Dpkg::Options::=--force-confold',
    ])
    apt(['autoremove', '-y'])
    apt(['clean'])
    fs.rmSync('/var/lib/apt/lists', { recursive: true, force: true })
    fs.mkdirSync('/var/lib/apt/lists/partial', { recursive: true })
    return
  }

  if (fs.existsSync('/sbin/apk')) {
    console.log('upgrading alpine packages')
    execFileSync('apk', ['upgrade', '--no-cache'], { stdio: 'inherit' })
    return
  }

  throw new Error('no supported package manager (expected apt-get or apk)')
}

function upgradeNpm(target) {
  const installed = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
  const order = compare(installed, target)
  if (order > 0) {
    console.log(`npm ${installed} is newer than the pin ${target}; leaving it`)
    return installed
  }
  if (order === 0) {
    console.log(`npm ${installed} already matches the pin`)
    return installed
  }

  console.log(`upgrading npm ${installed} -> ${target}`)
  execFileSync('npm', ['install', '--global', `npm@${target}`], {
    stdio: 'inherit',
    env: npmEnv(),
  })
  const now = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
  if (compare(now, target) < 0) {
    throw new Error(`npm is ${now} after install; expected at least ${target}`)
  }
  return now
}

function patchPackages(packages) {
  const wanted = new Map(Object.entries(packages))
  for (const [name, version] of wanted) {
    parseVersion(version)
    if (!name) throw new Error('empty package name in patches.json')
  }

  const installed = findPackages(NPM_ROOT, new Set(wanted.keys()))
  const byName = new Map()
  for (const found of installed) {
    const list = byName.get(found.name) || []
    list.push(found)
    byName.set(found.name, list)
  }

  for (const name of wanted.keys()) {
    if (!byName.has(name)) {
      throw new Error(
        `patches.json asks for ${name}, and that package is not installed under ${NPM_ROOT}. ` +
        'Update patches.json if a newer npm stopped shipping it.',
      )
    }
  }

  const staged = new Map()
  const temps = []
  try {
    for (const [name, copies] of byName) {
      const target = wanted.get(name)
      const needs = copies.filter((copy) => compare(copy.version, target) < 0)
      if (needs.length === 0) {
        console.log(`${name} already at ${copies.map((c) => c.version).join(', ')}`)
        continue
      }
      for (const copy of needs) {
        if (major(copy.version) !== major(target)) {
          throw new Error(
            `${name}@${copy.version} at ${copy.dir} is a different major than ${target}. ` +
            'Refusing to replace it. Pin a version on the same major, or remove the pin.',
          )
        }
      }
      const stage = stagePackage(name, target)
      temps.push(path.dirname(stage))
      assertDependenciesPresent(stage, needs)
      staged.set(name, { stage, copies: needs })
    }

    for (const [name, { stage, copies }] of staged) {
      for (const copy of copies) {
        console.log(`replacing ${name}@${copy.version} -> ${wanted.get(name)} at ${copy.dir}`)
        fs.rmSync(copy.dir, { recursive: true, force: true })
        fs.cpSync(stage, copy.dir, { recursive: true })
      }
    }
  } finally {
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
    try {
      execFileSync('npm', ['cache', 'clean', '--force'], { stdio: 'inherit', env: npmEnv() })
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
    }
  }

  const after = findPackages(NPM_ROOT, new Set(wanted.keys()))
  const result = {}
  for (const name of wanted.keys()) {
    const versions = [...new Set(after.filter((item) => item.name === name).map((item) => item.version))]
    versions.sort(compare)
    const lowest = versions[0]
    if (!lowest || compare(lowest, wanted.get(name)) < 0) {
      throw new Error(`${name} is ${versions.join(', ') || 'missing'} after patching; expected ${wanted.get(name)}`)
    }
    result[name] = versions.join(', ')
  }
  return result
}

function stagePackage(name, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-patch-'))
  execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', tmp], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...npmEnv(), npm_config_loglevel: 'warn' },
  })
  const tarball = fs.readdirSync(tmp).find((file) => file.endsWith('.tgz'))
  if (!tarball) throw new Error(`npm pack produced no tarball for ${name}@${version}`)
  const dest = path.join(tmp, 'package')
  fs.mkdirSync(dest)
  execFileSync('tar', ['-xzf', path.join(tmp, tarball), '-C', dest, '--strip-components=1'])
  const packed = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'))
  if (packed.name !== name || packed.version !== version) {
    throw new Error(`packed ${packed.name}@${packed.version}, expected ${name}@${version}`)
  }
  return dest
}

function assertDependenciesPresent(stageDir, copies) {
  const pkg = JSON.parse(fs.readFileSync(path.join(stageDir, 'package.json'), 'utf8'))
  const dependencies = pkg.dependencies || {}
  for (const depName of Object.keys(dependencies)) {
    for (const copy of copies) {
      if (!dependencyInstalled(copy.dir, depName)) {
        throw new Error(
          `${pkg.name}@${pkg.version} needs ${depName}, which is not installed next to ${copy.dir}`,
        )
      }
    }
  }
}

function dependencyInstalled(packageDir, depName) {
  let dir = packageDir
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules', depName, 'package.json'))) return true
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

function findPackages(root, names) {
  const found = []
  function walk(dir) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue
      const full = path.join(dir, entry.name)
      if (entry.name === 'node_modules' || entry.name.startsWith('@')) {
        walk(full)
        continue
      }
      const manifest = path.join(full, 'package.json')
      if (!fs.existsSync(manifest)) continue
      let pkg
      try {
        pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      } catch {
        continue
      }
      if (names.has(pkg.name) && pkg.version) {
        found.push({ name: pkg.name, version: pkg.version, dir: full })
      }
      const nested = path.join(full, 'node_modules')
      if (fs.existsSync(nested)) walk(nested)
    }
  }
  if (!fs.existsSync(root)) {
    throw new Error(`node modules directory does not exist: ${root}`)
  }
  walk(root)
  return found
}

function npmEnv() {
  return {
    ...process.env,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  }
}

function major(version) {
  return parseVersion(version).parts[0]
}

function compare(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) throw new Error(`unsupported version: ${version}`)
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] || '',
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
