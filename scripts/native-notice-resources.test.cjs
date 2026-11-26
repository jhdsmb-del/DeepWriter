'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { test } = require('node:test')
const { sourceAssets, verifyBinding, stageNativeNotices, packedSupplement, packedArchiveAssets, read, STAGED, CATALOG_SHA256 } = require('./native-notice-resources.cjs')
const { installNativeFixture, write } = require('./native-notice-fixture.cjs')
const { collectInventory } = process.env.DW_NATIVE_NOTICE_BASELINE_SOURCE ? require(path.resolve(process.env.DW_NATIVE_NOTICE_BASELINE_SOURCE)) : require('./distribution-inventory.cjs')
const { transformDependencyManifest } = require('./distribution-package-bindings.cjs')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function syntheticBinding() {
  const catalog = structuredClone(sourceAssets().catalog)
  const resources = new Map([[`${catalog.parentLocation}/LICENSE`, Buffer.from('Synthetic parent notice; not upstream license evidence.\n')]])
  catalog.licenses[0] = { ...catalog.licenses[0], size: resources.get(`${catalog.parentLocation}/LICENSE`).length, sha256: sha(resources.get(`${catalog.parentLocation}/LICENSE`)) }
  catalog.runtimeResources = catalog.runtimeResources.map(entry => {
    const bytes = Buffer.from(`Synthetic inert ${entry.name} fixture.`)
    resources.set(`${catalog.packageLocation}/${entry.name}`, bytes)
    return { ...entry, size: bytes.length, sha256: sha(bytes) }
  })
  return { catalog, lock: { packages: {
    [catalog.packageLocation]: { version: catalog.packageVersion, integrity: catalog.integrity },
    [catalog.parentLocation]: { version: catalog.parentVersion, integrity: catalog.parentIntegrity }
  } }, manifest: { name: catalog.packageName, version: catalog.packageVersion, license: 'MIT' }, parent: { name: catalog.parentName, version: catalog.parentVersion, license: 'MIT' }, resources }
}
function bound(f) { return verifyBinding(f.catalog, f.lock, f.manifest, f.parent, name => { if (!f.resources.has(name)) throw new Error('Missing synthetic resource'); return f.resources.get(name) }) }

test('fixed official catalog and all original notice bytes retain full hashes and partial scope', () => {
  const { catalog, assets } = sourceAssets()
  assert.equal(assets[0].sha256, CATALOG_SHA256)
  assert.deepEqual(assets.map(entry => entry.size), [4513, 1075, 1507, 25185])
  assert.equal(catalog.packageVersion, '0.1.80')
  assert.equal(catalog.icuVersion, '74.2')
  assert.equal(catalog.nativeGraphCoverage.status, 'partial')
  assert.equal(catalog.nativeGraphCoverage.unresolvedVersions, 'unknown')
  assert.equal(catalog.nativeGraphCoverage.legalCompliance, 'not-assessed')
  for (const resource of catalog.licenses) {
    assert.match(resource.sourceCommit, /^[a-f0-9]{40}$/)
    assert.ok(resource.sourceUrl.includes(resource.sourceCommit))
  }
  assert.equal(assets[3].bytes.toString('utf8').startsWith('UNICODE LICENSE V3'), true)
  assert.ok(assets[3].bytes.toString('utf8').includes('Third-Party Software Licenses'))
})
test('generic binding requires both exact runtime resources and exact parent notice', () => {
  const f = syntheticBinding()
  const output = bound(f)
  assert.deepEqual(output.map(entry => entry.name), f.catalog.runtimeResources.map(entry => `${f.catalog.packageLocation}/${entry.name}`))
  assert.ok(output.every(entry => entry.sha256 === sha(f.resources.get(entry.name))))
})
test('exact native manifest binding accepts the original and the real official builder derivation only', () => {
  const { catalog, assets } = sourceAssets()
  const root = path.resolve(__dirname, '..')
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')))
  const original = read(root, catalog.packageLocation + '/package.json')
  const packed = transformDependencyManifest(original)
  assert.equal(packed.length, 542)
  assert.equal(sha(packed), catalog.packagedManifest.sha256)
  assert.equal(original.length, 715)
  const resources = new Map(assets.map(entry => [STAGED + '/' + entry.name, entry.bytes]))
  const reader = name => resources.has(name) ? resources.get(name) : read(root, name)
  for (const [bytes, kind] of [[original, 'exact-upstream-source'], [packed, 'exact-official-builder-derivation']]) {
    resources.set(catalog.packageLocation + '/package.json', bytes)
    const result = packedSupplement(lock, reader, [catalog.packageLocation])
    assert.equal(result.manifestBinding, kind)
    assert.equal(result.actualManifest.sha256, sha(bytes))
  }
  resources.set(catalog.packageLocation + '/package.json', Buffer.concat([packed, Buffer.from(' ')]))
  assert.throws(() => packedSupplement(lock, reader, [catalog.packageLocation]), /fixed upstream bytes/)
})
for (const [name, mutate] of [
  ['native name drift', f => { f.manifest.name = '@other/native' }],
  ['native version drift', f => { f.manifest.version = '0.1.81' }],
  ['parent name drift', f => { f.parent.name = '@other/canvas' }],
  ['parent version drift', f => { f.parent.version = '0.1.79' }],
  ['unknown native license', f => { delete f.manifest.license }],
  ['unknown parent license', f => { f.parent.license = 'unknown' }],
  ['native lock integrity drift', f => { f.lock.packages[f.catalog.packageLocation].integrity += 'changed' }],
  ['parent lock integrity drift', f => { f.lock.packages[f.catalog.parentLocation].integrity += 'changed' }],
  ['parent lock version drift', f => { f.lock.packages[f.catalog.parentLocation].version = '0.1.82' }],
  ['native bytes changed', f => { f.resources.get(`${f.catalog.packageLocation}/skia.win32-x64-msvc.node`)[0] ^= 1 }],
  ['ICU bytes changed', f => { f.resources.get(`${f.catalog.packageLocation}/icudtl.dat`)[0] ^= 1 }],
  ['parent notice changed', f => { f.resources.get(`${f.catalog.parentLocation}/LICENSE`)[0] ^= 1 }],
  ['ICU absent', f => { f.resources.delete(`${f.catalog.packageLocation}/icudtl.dat`) }]
]) test(`binding rejects ${name}`, () => { const f = syntheticBinding(); mutate(f); assert.throws(() => bound(f)) })

test('no Windows native payload means no invented inclusion or stage; linked paths are rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-absence-'))
  try {
    assert.deepEqual(stageNativeNotices(root), { applicable: false })
    assert.equal(fs.existsSync(path.join(root, STAGED)), false)
    assert.equal(packedSupplement({}, () => { throw new Error('Must not read absent payload') }, []), null)
    write(path.join(root, 'real/file.txt'), 'Synthetic ordinary file')
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => read(root, 'linked/file.txt'), /Linked/)
    assert.throws(() => read(root, '../outside'), /Unsafe/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('actual ASAR/unpacked native payload receives precise package supplement without fabricated notice paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-actual-'))
  try {
    const identity = { name: 'deepwriter', version: '1.3.1', license: 'MIT' }
    write(path.join(root, 'package.json'), identity)
    write(path.join(root, 'package-lock.json'), { version: identity.version, packages: { '': identity } })
    write(path.join(root, 'LICENSE'), 'Synthetic project notice only.\n')
    const electronDir = path.join(root, 'electron-built')
    write(path.join(electronDir, 'LICENSE'), 'Synthetic Electron license.\n')
    write(path.join(electronDir, 'LICENSES.chromium.html'), '<html>Synthetic runtime notice.</html>\n')
    const options = await installNativeFixture(root, electronDir)
    const { report, notices } = collectInventory(options)
    assert.equal(report.inventoryComplete, true, JSON.stringify(report.reviewNeeded))
    const native = report.actual.packages.find(entry => entry.name === options.catalog.packageName)
    assert.deepEqual(native.notices, [])
    assert.equal(native.noticeSupplement.inheritedFrom.resource.name, `${options.catalog.parentLocation}/LICENSE`)
    assert.equal(native.noticeSupplement.resources.length, 4)
    assert.equal(native.noticeSupplement.manifestBinding, 'exact-official-builder-derivation')
    assert.equal(native.noticeSupplement.runtimeResources.length, 2)
    assert.equal(report.nativeGraphCoverage.status, 'partial')
    assert.equal(report.nativeGraphCoverage.unresolvedVersions, 'unknown')
    assert.equal(report.legalCompliance, 'not-assessed')
    assert.equal(report.releaseReadiness, 'not-assessed')
    for (const original of sourceAssets().assets.slice(1)) assert.ok(notices.includes(original.bytes.toString('utf8')))
    const files = packedArchiveAssets(options.asarPath, JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))), report)
    assert.equal(files.length, 4)
    for (const file of files) assert.equal(file.sha256, sha(file.bytes))
    const omitted = structuredClone(report)
    delete omitted.actual.nativeNoticeSupplements
    assert.throws(() => packedArchiveAssets(options.asarPath, JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))), omitted), /inventory differs/)
    const unpackedNode = path.join(`${options.asarPath}.unpacked`, options.catalog.packageLocation, 'skia.win32-x64-msvc.node')
    const nodeBytes = fs.readFileSync(unpackedNode)
    const changed = Buffer.from(nodeBytes)
    changed[0] ^= 1
    fs.writeFileSync(unpackedNode, changed)
    const corrupted = collectInventory(options).report
    assert.equal(corrupted.inventoryComplete, false)
    assert.ok(corrupted.reviewNeeded.some(entry => entry.code === 'PACKAGED_NATIVE_NOTICE_BINDING_INVALID'))
    assert.ok(corrupted.reviewNeeded.some(entry => entry.code === 'PACKAGED_NOTICE_MISSING' && entry.subject === options.catalog.packageLocation))
    fs.writeFileSync(unpackedNode, nodeBytes)
    const lockFile = path.join(root, 'package-lock.json')
    const lockBytes = fs.readFileSync(lockFile)
    const drifted = JSON.parse(lockBytes)
    drifted.packages[options.catalog.packageLocation].integrity += 'changed'
    write(lockFile, drifted)
    assert.ok(collectInventory(options).report.reviewNeeded.some(entry => entry.code === 'PACKAGED_NATIVE_NOTICE_BINDING_INVALID'))
    fs.writeFileSync(lockFile, lockBytes)
    assert.equal(stageNativeNotices(root).applicable, true)
    const staged = path.join(root, STAGED, 'LICENSE_ICU')
    fs.appendFileSync(staged, 'changed')
    assert.throws(() => stageNativeNotices(root), /differs/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('actual native payload without its shipped supplement remains a missing-notice blocker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-unstaged-'))
  try {
    const identity = { name: 'deepwriter', version: '1.3.1', license: 'MIT' }
    write(path.join(root, 'package.json'), identity)
    write(path.join(root, 'package-lock.json'), { version: identity.version, packages: { '': identity } })
    write(path.join(root, 'LICENSE'), 'Synthetic project notice.\n')
    const electronDir = path.join(root, 'electron-built')
    write(path.join(electronDir, 'LICENSE'), 'Synthetic Electron license.\n')
    write(path.join(electronDir, 'LICENSES.chromium.html'), '<html>Synthetic runtime notice.</html>\n')
    const options = await installNativeFixture(root, electronDir, false)
    const { report } = collectInventory(options)
    assert.equal(report.inventoryComplete, false)
    assert.ok(report.reviewNeeded.some(entry => entry.code === 'PACKAGED_NATIVE_NOTICE_BINDING_INVALID'))
    assert.ok(report.reviewNeeded.some(entry => entry.code === 'PACKAGED_NOTICE_MISSING' && entry.subject === options.catalog.packageLocation))
    assert.deepEqual(report.actual.nativeNoticeSupplements, [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
