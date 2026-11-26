'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { test } = require('node:test')
const asar = require('@electron/asar')
const { finished } = require('node:stream/promises')
const { sourceAssets, stagePackageNotices, packedSupplements, packedArchiveAssets, STAGED, CATALOG_SHA256 } = require('./package-notice-resources.cjs')
const { collectPackageBindings, transformDependencyManifest, TRANSFORMER_PIN } = require('./distribution-package-bindings.cjs')
const { collectInventory } = require('./distribution-inventory.cjs')
const REPO = path.resolve(__dirname, '..')
function write(root, name, bytes) {
  const target = path.join(root, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.isBuffer(bytes) || typeof bytes === 'string' ? bytes : JSON.stringify(bytes))
}
async function fixture(t, name = 'png-js', stage = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-package-notice-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceLock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json')))
  const location = 'node_modules/' + name
  // Synthetic unknown-metadata negative survives removal of the real unknown
  // implementation. Frozen formal 22-gap evidence remains untouched separately.
  const source = name === 'buffers' ? Buffer.from(JSON.stringify({ name, version: '0.1.1', main: 'index.js' })) : fs.readFileSync(path.join(REPO, location, 'package.json'))
  const manifest = JSON.parse(source)
  const identity = { name: 'deepwriter', version: '1.3.1', license: 'MIT', dependencies: { [name]: manifest.version } }
  const lock = { version: identity.version, packages: { '': identity,
    [location]: name === 'buffers' ? { version: '0.1.1', resolved: 'https://registry.npmjs.org/buffers/-/buffers-0.1.1.tgz', integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}` } : sourceLock.packages[location], 'node_modules/app-builder-lib': sourceLock.packages['node_modules/app-builder-lib'] } }
  write(root, 'package.json', identity)
  write(root, 'package-lock.json', lock)
  const projectNotice = name === 'lazy-val' ? fs.readFileSync(path.join(REPO, 'LICENSE')) : Buffer.from('Synthetic project notice.\n')
  write(root, 'LICENSE', projectNotice)
  write(root, location + '/package.json', source)
  for (const relative of ['node_modules/app-builder-lib/package.json', TRANSFORMER_PIN.implementation]) write(root, relative, fs.readFileSync(path.join(REPO, relative)))
  const dependencyLocations = name === 'png-js' ? ['node_modules/browserify-zlib', 'node_modules/pako'] : []
  for (const dependency of dependencyLocations) {
    lock.packages[dependency] = sourceLock.packages[dependency]
    write(root, dependency + '/package.json', fs.readFileSync(path.join(REPO, dependency, 'package.json')))
  }
  write(root, 'package-lock.json', lock)
  write(root, 'out/main/index.js', '// Inert offline fixture, never executed.\n')
  if (stage) stagePackageNotices(root)
  const packed = new Map([['package.json', Buffer.from(JSON.stringify(identity))], ['LICENSE', projectNotice],
    [location + '/package.json', transformDependencyManifest(source)]])
  if (stage && fs.existsSync(path.join(root, STAGED))) for (const filename of fs.readdirSync(path.join(root, STAGED))) packed.set(STAGED + '/' + filename, fs.readFileSync(path.join(root, STAGED, filename)))
  for (const dependency of dependencyLocations) {
    packed.set(dependency + '/package.json', transformDependencyManifest(fs.readFileSync(path.join(root, dependency, 'package.json'))))
    for (const filename of fs.readdirSync(path.join(REPO, dependency)).filter(name => /^licen[cs]e/i.test(name))) packed.set(dependency + '/' + filename, fs.readFileSync(path.join(REPO, dependency, filename)))
  }
  const readPacked = name => { assert.ok(packed.has(name), 'Missing ' + name); return packed.get(name) }
  const binding = () => collectPackageBindings({ root, lock, projectManifest: identity, packageLocations: [location, ...dependencyLocations], readPacked })
  const packedRoot = path.join(root, 'packed')
  for (const [name, bytes] of packed) write(packedRoot, name, bytes)
  const electronDir = path.join(root, 'electron')
  write(electronDir, 'LICENSE.electron.txt', 'Synthetic actual builder-layout Electron notice.\n')
  write(electronDir, 'LICENSES.chromium.html', '<html>Synthetic notice.</html>\n')
  const archive = path.join(electronDir, 'resources/app.asar')
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  const writer = await asar.createPackage(packedRoot, archive)
  if (writer?.once) await finished(writer)
  return { root, location, packed, readPacked, binding, lock, asarPath: archive, electronDir }
}
test('fixed original resources disclose declarations vs complete text without manufacturing copyright', () => {
  const { catalog, assets } = sourceAssets()
  assert.equal(assets[0].sha256, CATALOG_SHA256)
  assert.equal(catalog.packages.length, 9)
  assert.equal(catalog.legalCompliance, 'not-assessed')
  for (const entry of catalog.packages) {
    assert.match(entry.integrity, /^sha512-/)
    assert.match(entry.sourceCommit, /^[a-f0-9]{40}$/)
    assert.ok(entry.publishedTarball.sourceUrl.endsWith(entry.name + '-' + entry.version + '.tgz'))
    if (['brotli', 'dfa', 'dingbat-to-unicode', 'fontkit', 'lazy-val'].includes(entry.name)) {
      assert.equal(entry.notice.noticeKind, 'publisher-license-declaration')
      assert.equal(entry.notice.completeLicenseText, false)
      assert.equal(entry.notice.copyrightCoverage, 'unknown')
    } else assert.equal(entry.notice.completeLicenseText, true)
  }
  assert.equal(catalog.packages.some(entry => ['binary', 'buffers', 'chainsaw'].includes(entry.name)), false)
  const png = catalog.packages.find(entry => entry.name === 'png-js')
  assert.equal(png.declaredLicense, 'unknown')
  assert.equal(png.reviewedSourceLicense, 'MIT')
  assert.ok(assets.find(entry => entry.name === 'saxes-5.0.1.txt').bytes.toString().includes('Isaac Z. Schlueter'))
})
test('real source/consumption binding and actual ASAR resources disclose PNG original unknown metadata separately', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.binding().reviewNeeded, [])
  const { report, notices } = collectInventory(f)
  assert.equal(report.inventoryComplete, true, JSON.stringify(report.reviewNeeded))
  const row = report.actual.packages.find(row => row.name === 'png-js')
  assert.equal(row.license, 'unknown')
  assert.equal(row.reviewedSourceLicense.identifier, 'MIT')
  assert.deepEqual(row.notices, []) // no fabricated package LICENSE path
  assert.equal(row.publisherNoticeSupplement.resources[1].noticeKind, 'complete-publisher-license')
  assert.equal(report.legalCompliance, 'not-assessed')
  const files = packedArchiveAssets(f.asarPath, f.lock, report, f.root)
  assert.equal(files.length, 2)
  assert.ok(notices.includes(sourceAssets().assets.find(entry => entry.name === 'png-js-1.1.0.txt').bytes.toString()))
  const changed = structuredClone(report)
  changed.actual.packageNoticeSupplements[0].actualManifest.sha256 = 'f'.repeat(64)
  assert.throws(() => packedArchiveAssets(f.asarPath, f.lock, changed, f.root), /inventory differs/)
})
test('publisher declaration is preserved as the exact whole resource and never reported as complete text', async t => {
  // Dingbat has no dependencies; its full published manifest is the declaration.
  const f = await fixture(t, 'dingbat-to-unicode')
  const { report } = collectInventory(f)
  assert.equal(report.inventoryComplete, true, JSON.stringify(report.reviewNeeded))
  const supplement = report.actual.packageNoticeSupplements[0]
  assert.equal(supplement.resources[1].noticeKind, 'publisher-license-declaration')
  assert.equal(supplement.resources[1].completeLicenseText, false)
  assert.equal(supplement.resources[1].copyrightCoverage, 'unknown')
})

test('lazy-val updater dependency carries exact published MIT declaration and existing MIT terms, never invented copyright', async t => {
  const f = await fixture(t, 'lazy-val')
  assert.deepEqual(f.binding().reviewNeeded, [])
  const { report, notices } = collectInventory(f)
  assert.equal(report.inventoryComplete, true, JSON.stringify(report.reviewNeeded))
  const row = report.actual.packages.find(row => row.name === 'lazy-val')
  assert.equal(row.license, 'MIT'); assert.deepEqual(row.notices, [])
  assert.equal(row.publisherNoticeSupplement.reviewedSourceLicense, null)
  const resource = row.publisherNoticeSupplement.resources[1]
  assert.equal(resource.noticeKind, 'publisher-license-declaration')
  assert.equal(resource.completeLicenseText, false); assert.equal(resource.copyrightCoverage, 'unknown')
  const declaration = sourceAssets().assets.find(asset => asset.name === 'lazy-val-1.0.5.txt').bytes
  assert.deepEqual(declaration, fs.readFileSync(path.join(REPO, 'node_modules/lazy-val/package.json')))
  assert.equal(JSON.parse(declaration).author, 'Vladimir Krivosheev')
  assert.equal(JSON.parse(declaration).license, 'MIT'); assert.ok(!declaration.toString().includes('Copyright'))
  assert.ok(notices.includes(declaration.toString()))
  // Full MIT terms already ship as the project's correctly attributed LICENSE;
  // they are not relabelled as a missing publisher copyright notice.
  const existingMit = fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8')
  assert.ok(notices.includes(existingMit)); assert.ok(existingMit.includes('Permission is hereby granted'))
  assert.ok(existingMit.includes('THE SOFTWARE IS PROVIDED "AS IS"'))
  assert.equal(report.legalCompliance, 'not-assessed')
  const archived = packedArchiveAssets(f.asarPath, f.lock, report, f.root)
  assert.deepEqual(archived.map(asset => asset.name).sort(), ['licenses/packages/catalog.json', 'licenses/packages/lazy-val-1.0.5.txt'])
  const bindings = f.binding().bindings.filter(row => row.name === 'lazy-val')
  const wrongVersion = structuredClone(bindings); wrongVersion[0].version = '1.0.6'
  assert.throws(() => packedSupplements(f.readPacked, wrongVersion), /binding differs/)
  f.packed.set(STAGED + '/lazy-val-1.0.5.txt', Buffer.from('MIT License\nCopyright (c) invented'))
  assert.throws(() => packedSupplements(f.readPacked, bindings), /fixed publisher bytes/)
})
test('unknown buffers is not covered by any unrelated MIT resource', async t => {
  const f = await fixture(t, 'buffers')
  const { report } = collectInventory(f)
  assert.equal(report.inventoryComplete, false)
  assert.ok(report.reviewNeeded.some(entry => entry.code === 'PACKAGED_LICENSE_UNKNOWN' && entry.subject === f.location))
  assert.ok(report.reviewNeeded.some(entry => entry.code === 'PACKAGED_NOTICE_MISSING' && entry.subject === f.location))
  assert.deepEqual(report.actual.packageNoticeSupplements, [])
})
test('missing staged publisher resource keeps notice and original unknown-license blockers', async t => {
  const f = await fixture(t, 'png-js', false)
  const { report } = collectInventory(f)
  assert.ok(report.reviewNeeded.some(entry => entry.code === 'PACKAGED_PUBLISHER_NOTICE_BINDING_INVALID'))
  assert.ok(report.reviewNeeded.some(entry => entry.code === 'PACKAGED_LICENSE_UNKNOWN'))
  assert.ok(report.reviewNeeded.some(entry => entry.code === 'PACKAGED_NOTICE_MISSING'))
})
test('manifest/version/SRI/source/actual resource drift cannot borrow a fixed declaration', async t => {
  const f = await fixture(t)
  const bindings = f.binding().bindings.filter(row => row.name === 'png-js')
  for (const mutate of [
    rows => { rows[0].status = 'unresolved' },
    rows => { rows[0].version = '1.1.1' },
    rows => { rows[0].sourceIdentity.integrity += 'changed' },
    rows => { rows[0].sourceIdentity.resolved += 'changed' },
    rows => { rows[0].sourceCandidates[0].sourceManifest.sha256 = 'f'.repeat(64) },
    rows => { rows[0].sourceCandidates[0].exactExpectedManifestMatch = false }
  ]) {
    const changed = structuredClone(bindings)
    mutate(changed)
    assert.throws(() => packedSupplements(f.readPacked, changed), /binding differs/)
  }
  const name = STAGED + '/png-js-1.1.0.txt'
  f.packed.set(name, Buffer.from('invented license text'))
  assert.throws(() => packedSupplements(f.readPacked, bindings), /fixed publisher bytes/)
  f.packed.set(name, sourceAssets().assets.find(entry => entry.name === 'png-js-1.1.0.txt').bytes)
  f.packed.set(STAGED + '/catalog.json', Buffer.from('{}'))
  assert.throws(() => packedSupplements(f.readPacked, bindings), /fixed publisher bytes/)
})
test('stage refuses stale data and linked paths without overwriting earlier evidence', async t => {
  const f = await fixture(t)
  assert.equal(stagePackageNotices(f.root).applicable, true)
  const name = path.join(f.root, STAGED, 'png-js-1.1.0.txt')
  fs.appendFileSync(name, 'changed')
  assert.throws(() => stagePackageNotices(f.root), /fixed publisher bytes/)
  assert.ok(fs.readFileSync(name, 'utf8').endsWith('changed'))
  const installed = path.join(f.root, f.location, 'package.json')
  fs.appendFileSync(installed, ' ')
  assert.throws(() => stagePackageNotices(f.root), /fixed publisher bytes/)
})
