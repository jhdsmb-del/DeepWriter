'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { collectPackageBindings, transformDependencyManifest, TRANSFORMER_PIN } = require('./distribution-package-bindings.cjs')
const { createTransformer } = require('../node_modules/app-builder-lib/out/fileTransformer.js')
const REPO = path.resolve(__dirname, '..')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const SRI = `sha512-${Buffer.alloc(64, 7).toString('base64')}`
const SRI_OTHER = `sha512-${Buffer.alloc(64, 8).toString('base64')}`
const source = (location, name, version, dependencies = {}, extra = {}) => ({ location, manifest: { name, version, main: 'index.js', license: 'MIT', dependencies, scripts: { test: 'fixture-only' }, keywords: ['fixture'], bugs: 'fixture.invalid', ...extra } })

async function fixture(t, { sources, dependencies = { consumer: '1.0.0' }, config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-package-bindings-'))
  const parent = path.resolve(os.tmpdir())
  assert.equal(path.dirname(root), parent)
  assert.match(path.basename(root), /^deepwriter-package-bindings-/)
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent)
    assert.match(path.basename(root), /^deepwriter-package-bindings-/)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const write = (relative, bytes) => {
    const target = path.resolve(root, ...relative.split('/'))
    assert.ok(target.startsWith(`${root}${path.sep}`))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
  }
  const projectManifest = { name: 'binding-fixture', version: '1.0.0', dependencies, devDependencies: { 'app-builder-lib': '26.15.3' }, build: config }
  const lockedBuilder = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'))).packages['node_modules/app-builder-lib']
  const lock = { name: projectManifest.name, version: projectManifest.version, lockfileVersion: 3, packages: {
    '': { name: projectManifest.name, version: projectManifest.version, dependencies, devDependencies: projectManifest.devDependencies },
    'node_modules/app-builder-lib': lockedBuilder
  } }
  write('package.json', JSON.stringify(projectManifest, null, 2))
  write('node_modules/app-builder-lib/package.json', fs.readFileSync(path.join(REPO, 'node_modules/app-builder-lib/package.json')))
  write(TRANSFORMER_PIN.implementation, fs.readFileSync(path.join(REPO, TRANSFORMER_PIN.implementation)))
  const packed = new Map([['package.json', Buffer.from(JSON.stringify(projectManifest))]])
  const transformer = createTransformer(root, config, null, null)
  for (const item of sources ?? [source('node_modules/consumer', 'consumer', '1.0.0', { leaf: '^1.0.0' }), source('node_modules/consumer/node_modules/leaf', 'leaf', '1.0.0')]) {
    const p = item.manifest
    lock.packages[item.location] = { version: p.version, resolved: `https://registry.npmjs.org/${p.name}/-/${p.name.split('/').pop()}-${p.version}.tgz`, integrity: item.integrity ?? SRI,
      ...Object.fromEntries(['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'].filter(key => p[key] !== undefined).map(key => [key, p[key]])),
      ...(item.dev ? { dev: true } : {}), ...(item.lockExtra ?? {}) }
    const original = item.bytes ?? Buffer.from(JSON.stringify(p, null, 2) + '\n')
    write(`${item.location}/package.json`, original)
    if (item.ship !== false) {
      const destination = item.destination ?? item.location
      const transformed = await transformer(path.join(root, ...item.location.split('/'), 'package.json'))
      packed.set(`${destination}/package.json`, transformed == null ? original : Buffer.from(transformed))
    }
  }
  const saveLock = () => write('package-lock.json', JSON.stringify(lock, null, 2))
  saveLock()
  const readPacked = (name, limit) => {
    const bytes = packed.get(name)
    assert.ok(bytes, `Missing actual fixture resource: ${name}`)
    assert.ok(bytes.length <= limit)
    return Buffer.from(bytes)
  }
  const collect = () => collectPackageBindings({ root, lock, projectManifest,
    packageLocations: [...packed.keys()].filter(key => key !== 'package.json').map(key => key.slice(0, -13)), readPacked })
  return { root, packed, lock, projectManifest, readPacked, collect, write, saveLock }
}
function row(result, location) { return result.bindings.find(item => item.location === location) }
function has(result, code) { return result.reviewNeeded.some(item => item.code === code) }

test('byte-exact cleanup agrees with real pinned createTransformer, including unchanged original bytes', async t => {
  for (const config of [{}, { removePackageScripts: false }, { removePackageKeywords: false }, { removePackageScripts: false, removePackageKeywords: false }]) {
    const f = await fixture(t, { config })
    const filename = path.join(f.root, 'node_modules/consumer/package.json')
    const original = fs.readFileSync(filename)
    const primary = await createTransformer(f.root, config, null, null)(filename)
    assert.deepEqual(transformDependencyManifest(original, config), primary == null ? original : Buffer.from(primary))
  }
  for (const dependencies of [{}, { 'babel-core': '*' }]) {
    const manifest = { name: 'leaf', version: '1.0.0', dependencies, babel: { presets: ['fixture'] }, _private: true, devDependencies: { keep: '*' }, contributors: ['removed'] }
    const f = await fixture(t, { dependencies: { leaf: '1.0.0' }, sources: [{ location: 'node_modules/leaf', manifest }] })
    const bytes = fs.readFileSync(path.join(f.root, 'node_modules/leaf/package.json'))
    assert.deepEqual(transformDependencyManifest(bytes), f.packed.get('node_modules/leaf/package.json'))
    assert.deepEqual(JSON.parse(transformDependencyManifest(bytes)).devDependencies, { keep: '*' })
  }
  const bytes = Buffer.from('{ "name": "leaf", "version": "1.0.0", "license": "MIT" }\n')
  assert.deepEqual(transformDependencyManifest(bytes), bytes)
})

test('normal production hoist retains every same-identity source and both real consumer edges', async t => {
  const f = await fixture(t, { dependencies: { a: '1.0.0', b: '1.0.0' }, sources: [
    source('node_modules/a', 'a', '1.0.0', { leaf: '1.0.0' }), source('node_modules/b', 'b', '1.0.0', { leaf: '1.0.0' }),
    { ...source('node_modules/a/node_modules/leaf', 'leaf', '1.0.0'), destination: 'node_modules/leaf' },
    { ...source('node_modules/b/node_modules/leaf', 'leaf', '1.0.0'), ship: false },
    { ...source('node_modules/leaf', 'leaf', '2.0.0'), dev: true, ship: false }
  ] })
  const result = f.collect()
  assert.deepEqual(result.reviewNeeded, [])
  assert.ok(result.bindings.every(item => item.status === 'bound'))
  const leaf = row(result, 'node_modules/leaf')
  assert.equal(leaf.version, '1.0.0')
  assert.deepEqual(leaf.lockLocations, ['node_modules/a/node_modules/leaf', 'node_modules/b/node_modules/leaf'])
  assert.equal(leaf.consumedBy.length, 2)
  assert.ok(leaf.consumedBy.every(edge => edge.verified))
  assert.ok(leaf.sourceCandidates.every(candidate => candidate.sourceManifest.sha256 !== candidate.expectedPackagedManifest.sha256 && candidate.expectedPackagedManifest.sha256 === leaf.manifestSha256))
  assert.equal(leaf.sourceIdentity.integrity, SRI)
  assert.equal('notices' in leaf, false)
})

test('ordinary exact-layout packages bind with raw source, expected transformed and actual hashes distinct', async t => {
  const f = await fixture(t)
  const result = f.collect()
  assert.deepEqual(result.reviewNeeded, [])
  const leaf = row(result, 'node_modules/consumer/node_modules/leaf')
  assert.equal(leaf.sourceCandidates.length, 1)
  assert.equal(leaf.manifestSha256, sha(f.packed.get(`${leaf.location}/package.json`)))
  assert.equal(result.transformer.implementationSha256, TRANSFORMER_PIN.implementationSha256)
  assert.ok(leaf.sourceCandidates[0].lockedMetadata.dependencies)
})

test('DEV-only global name/version is never a production binding', async t => {
  const f = await fixture(t, { sources: [source('node_modules/consumer', 'consumer', '1.0.0', { leaf: '^1.0.0' }),
    { ...source('node_modules/consumer/node_modules/leaf', 'leaf', '1.0.0'), ship: false },
    { ...source('node_modules/leaf', 'leaf', '2.0.0'), dev: true }
  ] })
  const result = f.collect()
  assert.ok(has(result, 'PACKAGED_BINDING_SOURCE_NOT_PRODUCTION'))
  assert.equal(row(result, 'node_modules/leaf').status, 'unresolved')
})

test('a globally production-reachable version still fails the wrong consumer exact locked edge', async t => {
  const f = await fixture(t, { dependencies: { a: '1.0.0', b: '1.0.0' }, sources: [
    source('node_modules/a', 'a', '1.0.0', { leaf: '^1.0.0' }), source('node_modules/b', 'b', '1.0.0', { leaf: '^2.0.0' }),
    { ...source('node_modules/a/node_modules/leaf', 'leaf', '1.0.0'), ship: false },
    { ...source('node_modules/b/node_modules/leaf', 'leaf', '2.0.0'), destination: 'node_modules/leaf' }
  ] })
  const result = f.collect()
  assert.ok(has(result, 'PACKAGED_BINDING_CONSUMPTION_DRIFT'))
  assert.equal(row(result, 'node_modules/leaf').status, 'unresolved')
  assert.ok(row(result, 'node_modules/a').consumptionEdges.some(edge => !edge.verified))
})

test('name/version/hash/unknown identity changes cannot be normalized or granted', async t => {
  const f = await fixture(t)
  const location = 'node_modules/consumer/node_modules/leaf'
  const original = f.packed.get(`${location}/package.json`)
  for (const change of [{ name: 'other' }, { version: '9.0.0' }, { version: 'unknown' }, { license: 'changed' }, { main: 'different.js' }]) {
    f.packed.set(`${location}/package.json`, Buffer.from(JSON.stringify({ ...JSON.parse(original), ...change }, null, 2)))
    const result = f.collect()
    assert.equal(row(result, location).status, 'unresolved')
    assert.equal(row(result, location).manifestSha256, sha(f.packed.get(`${location}/package.json`)))
    assert.ok(result.reviewNeeded.length)
  }
  f.packed.set(`${location}/package.json`, Buffer.from(JSON.stringify(JSON.parse(original))))
  assert.ok(has(f.collect(), 'PACKAGED_BINDING_MANIFEST_DRIFT'))
})

test('equal actual transformed bytes but distinct locked SRI or original source hashes remain ambiguous', async t => {
  for (const change of ['integrity', 'sourceBytes']) {
    const second = source('node_modules/b/node_modules/leaf', 'leaf', '1.0.0')
    if (change === 'integrity') second.integrity = SRI_OTHER
    else second.manifest.scripts = { test: 'a different discarded script' }
    const f = await fixture(t, { dependencies: { a: '1.0.0', b: '1.0.0' }, sources: [
      source('node_modules/a', 'a', '1.0.0', { leaf: '1.0.0' }), source('node_modules/b', 'b', '1.0.0', { leaf: '1.0.0' }),
      { ...source('node_modules/a/node_modules/leaf', 'leaf', '1.0.0'), destination: 'node_modules/leaf' }, { ...second, ship: false }
    ] })
    const result = f.collect()
    assert.ok(has(result, 'PACKAGED_BINDING_SOURCE_AMBIGUOUS'))
    assert.equal(row(result, 'node_modules/leaf').sourceCandidates.length, 2)
  }
})

test('missing required source, missing resolved/SRI and source declaration tampering fail closed', async t => {
  for (const change of ['missingFile', 'integrity', 'resolved', 'declarations']) {
    const f = await fixture(t)
    const location = 'node_modules/consumer/node_modules/leaf'
    if (change === 'missingFile') fs.unlinkSync(path.join(f.root, ...location.split('/'), 'package.json'))
    else if (change === 'declarations') f.lock.packages[location].dependencies = { absent: '1.0.0' }
    else delete f.lock.packages[location][change]
    f.saveLock()
    const result = f.collect()
    assert.ok(has(result, 'PACKAGED_BINDING_REQUIRED_SOURCE_MISSING'))
    assert.equal(row(result, location).status, 'unresolved')
  }
})

test('unknown strip configuration and unpinned builder implementation fail closed', async t => {
  for (const config of [{ removePackageScripts: 'false' }, { removePackageKeywords: 0 }, { extends: 'external-config' }, { extraMetadata: { dependencies: {} } }]) {
    const f = await fixture(t, { config })
    const result = f.collect()
    assert.ok(has(result, 'PACKAGED_BINDING_TRANSFORM_UNATTESTED'))
    assert.ok(result.bindings.every(item => item.status === 'unresolved'))
  }
  const f = await fixture(t)
  f.write(TRANSFORMER_PIN.implementation, '// Not the attested primary implementation\n')
  assert.ok(has(f.collect(), 'PACKAGED_BINDING_TRANSFORM_UNATTESTED'))
})

test('missing required packaged dependency and an unconsumed duplicate stay red; absent optional may be omitted', async t => {
  const missing = await fixture(t)
  missing.packed.delete('node_modules/consumer/node_modules/leaf/package.json')
  assert.ok(has(missing.collect(), 'PACKAGED_BINDING_CONSUMPTION_DRIFT'))
  const duplicate = await fixture(t)
  duplicate.packed.set('node_modules/leaf/package.json', duplicate.packed.get('node_modules/consumer/node_modules/leaf/package.json'))
  assert.ok(has(duplicate.collect(), 'PACKAGED_BINDING_UNCONSUMED'))
  const optional = await fixture(t, { sources: [source('node_modules/consumer', 'consumer', '1.0.0', {}, { optionalDependencies: { absent: '1.0.0' } })] })
  assert.deepEqual(optional.collect().reviewNeeded, [])
})

test('root manifest and supplied source metadata are fenced independently', async t => {
  const f = await fixture(t)
  f.packed.set('package.json', Buffer.from(JSON.stringify({ ...f.projectManifest, dependencies: {} })))
  assert.ok(has(f.collect(), 'PACKAGED_BINDING_ROOT_MANIFEST_DRIFT'))
  assert.ok(f.collect().bindings.every(item => item.status === 'unresolved'))
  assert.throws(() => collectPackageBindings({ root: f.root, lock: { ...f.lock, version: 'different' }, projectManifest: f.projectManifest,
    packageLocations: [], readPacked: f.readPacked }), /differs from real source/)
})

test('actual builder ASAR: every manifest binds without changing the original license/notice evidence', { skip: !process.env.DW_PACKAGE_BINDING_ASAR }, () => {
  const archive = path.resolve(process.env.DW_PACKAGE_BINDING_ASAR)
  const metadataPath = path.resolve(process.env.DW_PACKAGE_BINDING_METADATA)
  const metadataBytes = fs.readFileSync(metadataPath)
  const metadata = JSON.parse(metadataBytes)
  assert.equal(sha(fs.readFileSync(archive)), metadata.archive)
  const asar = require('@electron/asar')
  const entries = asar.listPackage(archive).map(name => name.replace(/\\/g, '/').replace(/^\/+/, ''))
  assert.ok(entries.every(name => !name.split('/').some(part => part === '.' || part === '..')))
  const packageLocations = entries.filter(name => /^node_modules\/(?:@[^/]+\/[^/]+|[^@/][^/]*)(?:\/node_modules\/(?:@[^/]+\/[^/]+|[^@/][^/]*))*$/.test(name) && asar.statFile(archive, path.normalize(name), false).files)
  const readPacked = (name, limit) => {
    const stat = asar.statFile(archive, path.normalize(name), false)
    assert.ok(!stat.link && !stat.files && typeof stat.size === 'number' && stat.size <= limit)
    let bytes
    if (stat.unpacked) {
      const unpacked = `${archive}.unpacked`
      const target = path.resolve(unpacked, ...name.split('/'))
      assert.ok(target.startsWith(`${unpacked}${path.sep}`))
      let current = unpacked
      assert.equal(fs.lstatSync(current).isSymbolicLink(), false)
      for (const component of path.relative(unpacked, target).split(path.sep)) { current = path.join(current, component); assert.equal(fs.lstatSync(current).isSymbolicLink(), false) }
      assert.ok(fs.lstatSync(target).isFile())
      bytes = fs.readFileSync(target)
    } else bytes = asar.extractFile(archive, path.normalize(name), false)
    assert.equal(bytes.length, stat.size)
    return bytes
  }
  const result = collectPackageBindings({ root: REPO, packageLocations, readPacked })
  assert.equal(result.bindings.length, metadata.packageCount)
  assert.deepEqual(result.reviewNeeded, [])
  assert.ok(result.bindings.every(item => item.status === 'bound'))
  const driftRows = metadata.packageRows.filter(item => item.issues.some(issue => issue.code === 'PACKAGED_LOCK_DRIFT'))
  assert.equal(driftRows.length, 7)
  for (const old of driftRows) {
    const binding = row(result, old.location)
    assert.equal(binding.name, old.name)
    assert.equal(binding.version, old.version)
    assert.equal(binding.manifestSha256, old.actualManifest.sha256)
    assert.deepEqual(binding.lockLocations, old.sourceCandidates.map(candidate => candidate.location).sort())
    for (const candidate of binding.sourceCandidates) {
      const evidence = old.sourceCandidates.find(item => item.location === candidate.location)
      assert.equal(candidate.sourceManifest.sha256, evidence.sourceManifest.sha256)
      assert.equal(candidate.expectedPackagedManifest.sha256, evidence.builderManifest.sha256)
      assert.equal(candidate.lockedIntegrity, evidence.integrity)
    }
  }
  assert.equal(metadata.reviewNeeded.length, 22)
  assert.equal(metadata.reviewNeeded.filter(item => item.code === 'PACKAGED_LICENSE_UNKNOWN').length, 2)
  assert.ok(metadata.reviewNeeded.some(item => item.code === 'PACKAGED_NOTICE_MISSING'))
  assert.deepEqual(fs.readFileSync(metadataPath), metadataBytes)
  console.log(`Actual ASAR manifest bindings=${result.bindings.length}; lock relocations=${driftRows.length}; binding gaps=${result.reviewNeeded.length}; original evidence gaps=${metadata.reviewNeeded.length}`)
})
