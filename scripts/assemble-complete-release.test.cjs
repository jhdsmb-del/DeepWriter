'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { test } = require('node:test')
const { unzipSync, zipSync } = require('fflate')
const { assembleCompleteRelease, collectCompleteInputs, verifyZipBytes, main, parseArgs } = require('./assemble-complete-release.cjs')
const { verifyCompleteDownload } = require('./verify-complete-download.cjs')
const { collectInventory } = require('./distribution-inventory.cjs')
const { installNativeFixture } = require('./native-notice-fixture.cjs')
const VERSION = '1.3.1'
const SOURCE = 'a'.repeat(40)
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value))
}
function receipt(directory, name) {
  const bytes = fs.readFileSync(path.join(directory, name))
  return { name, size: bytes.length, sha256: hash(bytes) }
}
async function fixture(task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-complete-test-'))
  try {
    const releaseDir = path.join(root, 'release', `v${VERSION}`)
    const cliDir = path.join(root, 'cli-built')
    const electronDir = path.join(root, 'electron-built')
    const evidence = path.join(root, 'evidence')
    write(path.join(root, 'package.json'), { name: 'deepwriter', version: VERSION, license: 'MIT' })
    write(path.join(root, 'package-lock.json'), { version: VERSION, packages: { '': { version: VERSION } } })
    write(path.join(root, 'LICENSE'), 'Synthetic project license fixture; no legal conclusion.\n')
    for (const name of ['QUICKSTART.md', 'PRIVACY.md', 'OPERATIONS.md', 'CLI.md', 'VALIDATION.md', 'LICENSE_DECISION.md', 'EXTENSIONS_RESEARCH.md', 'PROVIDER_EXPANSION_RESEARCH.md']) write(path.join(root, 'docs', name), `# Synthetic ${name} document\n`)
    write(path.join(root, 'PACKAGE_README.md'), '# Synthetic complete-package getting started guide\n')
    write(path.join(root, 'SECURITY.md'), '# Synthetic security guide\n')
    const binary = Buffer.alloc(1024 * 1024)
    binary.write('MZ')
    const installer = `DeepWriter-${VERSION}-x64-setup.exe`
    const portable = `DeepWriter-${VERSION}-x64-portable.exe`
    write(path.join(releaseDir, installer), binary)
    write(path.join(releaseDir, portable), binary)
    write(path.join(releaseDir, `SBOM_DEPENDENCIES_${VERSION}.md`), 'Synthetic SBOM fixture.\n')
    write(path.join(releaseDir, 'installation-verification.json'), { version: VERSION, sourceCommit: SOURCE, upgradedFrom: '1.2.6', installerSha256: hash(binary), baselineSha256: 'b'.repeat(64), cleanInstall: true, upgradeHistory: true, upgradeCredentials: true, uninstallPreservesData: true })
    const desktopFiles = [installer, portable, `SBOM_DEPENDENCIES_${VERSION}.md`, 'installation-verification.json'].map(name => receipt(releaseDir, name))
    write(path.join(releaseDir, 'release.json'), { version: VERSION, tag: `v${VERSION}`, sourceCommit: SOURCE, buildPlatform: 'win32', targetPlatform: 'win32', targetArch: 'x64', unsigned: true, publisher: null, files: desktopFiles })
    write(path.join(releaseDir, 'SHA256SUMS.txt'), [...desktopFiles, receipt(releaseDir, 'release.json')].map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n')
    write(path.join(electronDir, 'resources', 'app.asar'), 'Synthetic archive hash fixture; not an Electron acceptance artifact.')
    write(path.join(electronDir, 'LICENSE'), 'Synthetic Electron license.\n')
    write(path.join(electronDir, 'LICENSES.chromium.html'), '<html>Synthetic Chromium notices.</html>\n')
    const inventory = path.join(evidence, 'distribution-inventory.json')
    const notices = path.join(evidence, 'THIRD_PARTY_NOTICES.txt')
    write(notices, 'Synthetic desktop third-party notices.\n')
    write(inventory, { schemaVersion: 1, application: { name: 'deepwriter', version: VERSION }, inventoryComplete: true, reviewNeeded: [], source: { packageSha256: receipt(root, 'package.json').sha256, lockSha256: receipt(root, 'package-lock.json').sha256 }, projectLicense: { sourceResource: receipt(root, 'LICENSE') }, notices: receipt(evidence, 'THIRD_PARTY_NOTICES.txt'), actual: { archiveSha256: receipt(electronDir, 'resources/app.asar').sha256, runtimeNotices: ['LICENSE', 'LICENSES.chromium.html'].map(name => ({ ...receipt(electronDir, name), ...(name === 'LICENSE' ? { sourceName: 'LICENSE', actualName: name, layout: 'electron-upstream' } : {}) })) } })
    write(path.join(cliDir, 'deepwriter.cjs'), "console.log('synthetic CLI bundle; not implementation evidence')\n")
    write(path.join(cliDir, 'deepwriter.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0deepwriter.cjs" %*\r\n')
    write(path.join(cliDir, 'runtime/node.exe'), binary)
    write(path.join(cliDir, 'runtime/LICENSE'), 'Synthetic Node runtime license.\n')
    write(path.join(cliDir, 'runtime/LICENSE.source.json'), { version: '22.23.0', sourceUrl: 'https://raw.githubusercontent.com/nodejs/node/v22.23.0/LICENSE', ...receipt(cliDir, 'runtime/LICENSE'), name: 'LICENSE', retrievedAt: '2026-10-03T00:00:00.000Z', diagnosticFixture: true })
    write(path.join(cliDir, 'LICENSE'), fs.readFileSync(path.join(root, 'LICENSE')))
    write(path.join(cliDir, 'build/cli-build.json'), { schemaVersion: 1, application: { name: 'deepwriter-cli', version: VERSION }, sourceCommit: SOURCE, sourceDirty: false,
      source: { packageSha256: receipt(root, 'package.json').sha256, lockSha256: receipt(root, 'package-lock.json').sha256 },
      buildPolicy: { implementation: 'src/cli/build.mjs', implementationSha256: 'd'.repeat(64), platform: 'node', format: 'cjs', target: 'node22', entrypoint: 'src/cli/main.ts' },
      bundle: { ...receipt(cliDir, 'deepwriter.cjs'), name: 'out/synthetic-cli/deepwriter.cjs' }, metafile: { name: 'out/synthetic-cli/cli-metafile.json', size: 1, sha256: 'c'.repeat(64) }, warnings: [], diagnosticFixture: true })
    write(path.join(cliDir, 'THIRD_PARTY_NOTICES.txt'), 'Synthetic CLI notices.\n')
    const runtime = { name: 'node', version: '22.23.0', platform: 'win32', arch: 'x64', executable: 'runtime/node.exe', license: 'runtime/LICENSE', licenseSource: 'runtime/LICENSE.source.json' }
    const cliFiles = ['deepwriter.cjs', 'deepwriter.cmd', 'LICENSE', 'build/cli-build.json', runtime.executable, runtime.license, runtime.licenseSource, 'THIRD_PARTY_NOTICES.txt']
    write(path.join(cliDir, 'cli-inventory.json'), { schemaVersion: 1, application: { name: 'deepwriter-cli', version: VERSION }, sourceCommit: SOURCE, sourceDirty: false, inventoryComplete: true, reviewNeeded: [], source: { packageSha256: receipt(root, 'package.json').sha256, lockSha256: receipt(root, 'package-lock.json').sha256, bundleSha256: receipt(cliDir, 'deepwriter.cjs').sha256, buildReceiptSha256: receipt(cliDir, 'build/cli-build.json').sha256, metafileSha256: 'c'.repeat(64) }, runtime: { name: 'node', version: runtime.version, platform: 'win32', arch: 'x64', executableSha256: receipt(cliDir, runtime.executable).sha256, license: { ...receipt(cliDir, runtime.license), sourceUrl: `https://raw.githubusercontent.com/nodejs/node/v${runtime.version}/LICENSE` } }, files: cliFiles.map(name => receipt(cliDir, name)) })
    write(path.join(cliDir, 'cli-release.json'), { schemaVersion: 1, name: 'deepwriter-cli', version: VERSION, sourceCommit: SOURCE, entrypoint: 'deepwriter.cjs', runtime, inventory: 'cli-inventory.json', notices: 'THIRD_PARTY_NOTICES.txt', files: [...cliFiles, 'cli-inventory.json'].map(name => receipt(cliDir, name)) })
    const options = { root, releaseDir, cliDir, inventory, notices, electronDir, sourceCommit: SOURCE }
    await task(options)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
function mutateJson(file, task) { const data = JSON.parse(fs.readFileSync(file)); task(data); write(file, data) }
function rebindCli(options) {
  mutateJson(path.join(options.cliDir, 'cli-release.json'), manifest => { manifest.files = manifest.files.map(entry => receipt(options.cliDir, entry.name)) })
}
function copyCanonicalDesktop(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const name of fs.readdirSync(source)) fs.copyFileSync(path.join(source, name), path.join(target, name), fs.constants.COPYFILE_EXCL)
}
function flatDownload(options, result, canonical = true) {
  const directory = path.join(options.root, 'received-flat')
  fs.mkdirSync(directory)
  for (const file of [result.output, `${result.output}.manifest.json`, `${result.output}.SHA256SUMS.txt`]) fs.copyFileSync(file, path.join(directory, path.basename(file)), fs.constants.COPYFILE_EXCL)
  if (canonical) copyCanonicalDesktop(options.releaseDir, directory)
  return directory
}
function rebindDesktop(directory) {
  mutateJson(path.join(directory, 'release.json'), metadata => { metadata.files = metadata.files.map(entry => receipt(directory, entry.name)) })
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'release.json')))
  write(path.join(directory, 'SHA256SUMS.txt'), [...metadata.files, receipt(directory, 'release.json')].map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n')
}
// Rebind only the aggregate ZIP layers. Component receipts and canonical desktop assets stay untouched.
function rebindReceivedArchive(result, mutate) {
  const unpacked = unzipSync(fs.readFileSync(result.output))
  mutate(unpacked)
  const manifest = JSON.parse(fs.readFileSync(`${result.output}.manifest.json`))
  manifest.files = Object.entries(unpacked).filter(([name]) => !['complete-manifest.json', 'SHA256SUMS.txt'].includes(name)).map(([name, bytes]) => ({ name, size: bytes.length, sha256: hash(bytes) }))
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  unpacked['complete-manifest.json'] = manifestBytes
  unpacked['SHA256SUMS.txt'] = Buffer.from([...manifest.files, { name: 'complete-manifest.json', sha256: hash(manifestBytes) }].map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n')
  write(result.output, Buffer.from(zipSync(unpacked, { level: 0 })))
  write(`${result.output}.manifest.json`, manifestBytes)
  write(`${result.output}.SHA256SUMS.txt`, `${hash(fs.readFileSync(result.output))}  ${path.basename(result.output)}\n${hash(manifestBytes)}  ${path.basename(result.output)}.manifest.json\n`)
}
function mutateMemberJson(unpacked, name, mutate) {
  const value = JSON.parse(Buffer.from(unpacked[name]))
  mutate(value)
  unpacked[name] = Buffer.from(JSON.stringify(value))
}
// Rebase the CLI receipt layers too, so identity/source guards—not stale hashes—must reject.
function rebindReceivedCli(unpacked) {
  const entry = name => { const bytes = unpacked[`cli/${name}`]; return { name, size: bytes.length, sha256: hash(bytes) } }
  mutateMemberJson(unpacked, 'cli/cli-inventory.json', inventory => {
    inventory.files = inventory.files.map(file => entry(file.name))
    inventory.source.buildReceiptSha256 = entry('build/cli-build.json').sha256
    inventory.source.bundleSha256 = entry('deepwriter.cjs').sha256
  })
  mutateMemberJson(unpacked, 'cli/cli-release.json', cli => { cli.files = cli.files.map(file => entry(file.name)) })
}

test('receiver accepts the flat GitHub release download without extracting ZIP or changing received files', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const directory = flatDownload(options, result)
  const before = fs.readdirSync(directory).sort().map(name => receipt(directory, name))
  const verified = await verifyCompleteDownload(directory, VERSION, SOURCE)
  assert.equal(verified.verifiedMembers, Object.keys(unzipSync(fs.readFileSync(result.output))).length)
  assert.equal(fs.existsSync(path.join(directory, `v${VERSION}`)), false)
  assert.deepEqual(fs.readdirSync(directory).sort().map(name => receipt(directory, name)), before)
}))

test('receiver accepts matching nested and flat canonical desktop receipts', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const directory = path.dirname(result.output)
  copyCanonicalDesktop(options.releaseDir, directory)
  assert.ok((await verifyCompleteDownload(directory, VERSION, SOURCE)).verifiedMembers > 0)
}))

test('flat receiver requires independently downloaded canonical assets, not only the complete ZIP trio', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  await assert.rejects(verifyCompleteDownload(flatDownload(options, result, false), VERSION, SOURCE), /Canonical desktop release assets are missing/)
}))

test('flat receiver rejects missing installation proof instead of trusting the ZIP member', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const directory = flatDownload(options, result)
  fs.unlinkSync(path.join(directory, 'installation-verification.json'))
  await assert.rejects(verifyCompleteDownload(directory, VERSION, SOURCE))
}))

test('flat receiver rejects a canonical release from a different version', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const directory = flatDownload(options, result)
  mutateJson(path.join(directory, 'release.json'), metadata => { metadata.version = '1.3.0'; metadata.tag = 'v1.3.0' })
  rebindDesktop(directory)
  await assert.rejects(verifyCompleteDownload(directory, VERSION, SOURCE), /Official release identity differs/)
}))

test('receiver fails closed when individually valid nested and flat canonical receipts conflict', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const directory = path.dirname(result.output)
  copyCanonicalDesktop(options.releaseDir, directory)
  fs.appendFileSync(path.join(directory, `SBOM_DEPENDENCIES_${VERSION}.md`), 'Different independently rehashed canonical bytes.\n')
  rebindDesktop(directory)
  await assert.rejects(verifyCompleteDownload(directory, VERSION, SOURCE), /Nested and flat canonical desktop receipts conflict/)
}))

test('valid nested assets do not hide a partial flat canonical download', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const directory = path.dirname(result.output)
  fs.copyFileSync(path.join(options.releaseDir, 'release.json'), path.join(directory, 'release.json'))
  await assert.rejects(verifyCompleteDownload(directory, VERSION, SOURCE))
}))

test('valid flat assets do not hide wrong-version nested canonical proof', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const directory = flatDownload(options, result)
  const nested = path.join(directory, `v${VERSION}`)
  copyCanonicalDesktop(options.releaseDir, nested)
  mutateJson(path.join(nested, 'release.json'), metadata => { metadata.version = '1.3.0'; metadata.tag = 'v1.3.0' })
  rebindDesktop(nested)
  await assert.rejects(verifyCompleteDownload(directory, VERSION, SOURCE), /Official release identity differs/)
}))

test('flat receiver still binds a rehashed ZIP installer to the unchanged canonical installation proof', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  rebindReceivedArchive(result, unpacked => { unpacked[`desktop/DeepWriter-${VERSION}-x64-setup.exe`][128] ^= 1 })
  await assert.rejects(verifyCompleteDownload(flatDownload(options, result), VERSION, SOURCE), /Desktop component receipt/)
}))

test('receiver rejects rehashed ZIP installer specifically against unchanged canonical desktop proof', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const proofBefore = fs.readFileSync(path.join(options.releaseDir, 'installation-verification.json'))
  rebindReceivedArchive(result, unpacked => { unpacked[`desktop/DeepWriter-${VERSION}-x64-setup.exe`][128] ^= 1 })
  assert.deepEqual(fs.readFileSync(path.join(options.releaseDir, 'installation-verification.json')), proofBefore)
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE), /Desktop component receipt/)
}))

test('receiver rejects a rehashed CLI bundle against unchanged component receipts', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  rebindReceivedArchive(result, unpacked => { unpacked['cli/deepwriter.cjs'][0] ^= 1 })
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE), /CLI component receipt/)
}))

test('receiver rejects CLI source identity drift even with matching names and rebased outer hashes', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  rebindReceivedArchive(result, unpacked => { const cli = JSON.parse(Buffer.from(unpacked['cli/cli-release.json'])); cli.sourceCommit = 'b'.repeat(40); unpacked['cli/cli-release.json'] = Buffer.from(JSON.stringify(cli)) })
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE), /CLI component identity/)
}))

test('receiver requires actual canonical desktop installation proof instead of ZIP-only claimed proof', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  fs.unlinkSync(path.join(options.releaseDir, 'installation-verification.json'))
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE))
}))

for (const [name, member, mutate, error] of [
  ['dirty CLI inventory', 'cli/cli-inventory.json', inventory => { inventory.sourceDirty = true }, /CLI inventory identity/],
  ['CLI package-lock source drift', 'cli/cli-inventory.json', inventory => { inventory.source.lockSha256 = 'e'.repeat(64) }, /CLI inventory source tuple/],
  ['stale CLI build source', 'cli/build/cli-build.json', build => { build.sourceCommit = 'b'.repeat(40) }, /CLI build receipt source identity/],
  ['dirty CLI build', 'cli/build/cli-build.json', build => { build.sourceDirty = true }, /CLI build receipt source identity/],
  ['CLI metafile receipt drift', 'cli/build/cli-build.json', build => { build.metafile.sha256 = 'e'.repeat(64) }, /CLI build receipt source identity/],
  ['wrong-version Node license provenance', 'cli/runtime/LICENSE.source.json', source => { source.version = '22.13.0' }, /CLI Node license source receipt/],
  ['Node license text hash drift', 'cli/runtime/LICENSE.source.json', source => { source.sha256 = 'e'.repeat(64) }, /CLI Node license source receipt/],
  ['duplicate CLI component receipts', 'cli/cli-release.json', cli => { cli.files.push({ ...cli.files[0] }) }, /CLI component receipt is invalid or duplicated/],
  ['incomplete CLI inventory file coverage', 'cli/cli-inventory.json', inventory => { inventory.files = inventory.files.filter(file => file.name !== 'runtime/LICENSE') }, /CLI inventory receipt set/]
]) test(`receiver rejects ${name} even after rebasing aggregate and component hashes`, async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  rebindReceivedArchive(result, unpacked => { mutateMemberJson(unpacked, member, mutate); rebindReceivedCli(unpacked) })
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE), error)
}))

test('receiver rejects unlisted CLI members and contradictory desktop unsigned status', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  rebindReceivedArchive(result, unpacked => { unpacked['cli/unlisted.cjs'] = Buffer.from('Synthetic unlisted code; never executed.\n') })
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE), /CLI component receipt set/)
  mutateJson(`${result.output}.manifest.json`, manifest => { manifest.desktopUnsigned = false })
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE), /Desktop component unsigned identity/)
}))

test('streaming ZIP metadata capture is limited and does not expose nonrequested binary contents', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const expected = JSON.parse(fs.readFileSync(`${result.output}.manifest.json`)).files
  const unpacked = unzipSync(fs.readFileSync(result.output))
  for (const name of ['complete-manifest.json', 'SHA256SUMS.txt']) expected.push({ name, size: unpacked[name].length, sha256: hash(unpacked[name]) })
  await assert.rejects(verifyZipBytes(result.output, expected, { capture: ['cli/cli-release.json'], maxCaptureBytes: 1 }), /metadata capture limit/)
  await assert.rejects(verifyZipBytes(result.output, expected, { capture: ['cli/missing.json'] }), /Missing or duplicate ZIP metadata capture/)
  await assert.rejects(verifyZipBytes(result.output, expected, { capture: ['cli/cli-release.json', 'cli/cli-release.json'] }), /Missing or duplicate ZIP metadata capture/)
  await assert.rejects(verifyZipBytes(result.output, expected, { capture: ['cli/cli-release.json'], maxCaptureBytes: 8 * 1024 * 1024 + 1 }), /metadata capture limit/)
  const five = ['cli/cli-release.json', 'cli/cli-inventory.json', 'distribution-inventory.json', 'cli/build/cli-build.json', 'cli/runtime/LICENSE.source.json']
  await assert.rejects(verifyZipBytes(result.output, expected.map(entry => five.includes(entry.name) ? { ...entry, size: 8 * 1024 * 1024 } : entry), { capture: five }), /metadata capture limit/)
  const result2 = await verifyZipBytes(result.output, expected, { capture: ['cli/cli-release.json'], maxCaptureBytes: 8 * 1024 * 1024 })
  assert.equal(result2.captured.size, 1)
  assert.deepEqual(result2.captured.get('cli/cli-release.json'), Buffer.from(unpacked['cli/cli-release.json']))
  assert.equal(result2.captured.has(`desktop/DeepWriter-${VERSION}-x64-setup.exe`), false)
  assert.deepEqual(await verifyZipBytes(result.output, expected), { verifiedMembers: expected.length })
}))

test('complete ZIP contains exact installer, portable, built CLI/runtime, licensing/docs and both checksum layers', async () => fixture(async options => {
  write(path.join(options.cliDir, 'unlisted-userData.txt'), 'This unlisted file must never be recursively included.')
  const originalMetadata = fs.readFileSync(path.join(options.releaseDir, 'release.json'))
  const result = await assembleCompleteRelease(options)
  assert.equal(result.complete, true)
  const unpacked = unzipSync(fs.readFileSync(result.output))
  for (const name of [`desktop/DeepWriter-${VERSION}-x64-setup.exe`, `desktop/DeepWriter-${VERSION}-x64-portable.exe`, 'cli/deepwriter.cjs', 'cli/runtime/node.exe', 'cli/runtime/LICENSE', 'cli/cli-inventory.json', 'LICENSE', 'docs/CLI.md', 'distribution-inventory.json', 'THIRD_PARTY_NOTICES.txt', 'runtime/electron/LICENSES.chromium.html', 'complete-manifest.json', 'SHA256SUMS.txt']) assert.ok(unpacked[name], name)
  assert.equal(Object.keys(unpacked).some(name => name.includes('unlisted-userData')), false)
  for (const line of Buffer.from(unpacked['SHA256SUMS.txt']).toString().trim().split('\n')) {
    const [expected, name] = line.split('  ')
    assert.equal(hash(unpacked[name]), expected)
  }
  assert.deepEqual(fs.readFileSync(path.join(options.releaseDir, 'release.json')), originalMetadata)
  assert.equal(fs.existsSync(`${result.output}.manifest.json`), true)
  assert.equal(fs.existsSync(`${result.output}.SHA256SUMS.txt`), true)
  const received = await verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE)
  assert.equal(received.verifiedMembers, Object.keys(unpacked).length)
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, 'b'.repeat(40)), /expected release/)
}))

test('complete ZIP binds exact actual native notice assets while retaining partial graph and unknown versions', async () => fixture(async options => {
  const actual = await installNativeFixture(options.root, options.electronDir)
  const { report, notices } = collectInventory(actual)
  assert.equal(report.inventoryComplete, true, JSON.stringify(report.reviewNeeded))
  write(options.inventory, report)
  write(options.notices, notices)
  // Only the temporary fixture's lock changed; keep its existing CLI source tuple coherent.
  const lockSha256 = receipt(options.root, 'package-lock.json').sha256
  const packageSha256 = receipt(options.root, 'package.json').sha256
  mutateJson(path.join(options.cliDir, 'build/cli-build.json'), build => { build.source.lockSha256 = lockSha256; build.source.packageSha256 = packageSha256 })
  mutateJson(path.join(options.cliDir, 'cli-inventory.json'), inventory => {
    inventory.source.lockSha256 = lockSha256
    inventory.source.packageSha256 = packageSha256
    inventory.source.buildReceiptSha256 = receipt(options.cliDir, 'build/cli-build.json').sha256
    inventory.files = inventory.files.map(entry => receipt(options.cliDir, entry.name))
  })
  rebindCli(options)
  const result = await assembleCompleteRelease(options)
  const unpacked = unzipSync(fs.readFileSync(result.output))
  const supplement = report.actual.nativeNoticeSupplements[0]
  for (const asset of supplement.resources) {
    const bytes = Buffer.from(unpacked[asset.archiveName])
    assert.equal(bytes.length, asset.size)
    assert.equal(hash(bytes), asset.sha256)
    assert.deepEqual(result.manifest.files.find(entry => entry.name === asset.archiveName), { name: asset.archiveName, size: asset.size, sha256: asset.sha256 })
  }
  assert.equal(JSON.parse(Buffer.from(unpacked['distribution-inventory.json'])).nativeGraphCoverage.status, 'partial')
  await verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE)
  unpacked[supplement.resources[3].archiveName][0] ^= 1
  write(result.output, Buffer.from(zipSync(unpacked)))
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE), /ZIP member/)
  const originalArchiveHash = report.actual.archiveSha256
  report.actual.nativeNoticeSupplements[0].runtimeResources[1].sha256 = 'f'.repeat(64)
  write(options.inventory, report)
  assert.equal(report.actual.archiveSha256, originalArchiveHash)
  await assert.rejects(collectCompleteInputs(options), /Native notice inventory differs/)
  delete report.actual.nativeNoticeSupplements
  write(options.inventory, report)
  await assert.rejects(collectCompleteInputs(options), /Native notice inventory differs/)
}))

test('packed Electron filename stays exact through assembly and receiver; missing/duplicate/source metadata reject', async () => fixture(async options => {
  fs.renameSync(path.join(options.electronDir, 'LICENSE'), path.join(options.electronDir, 'LICENSE.electron.txt'))
  mutateJson(options.inventory, inventory => {
    inventory.actual.runtimeNotices[0] = { ...receipt(options.electronDir, 'LICENSE.electron.txt'), sourceName: 'LICENSE', actualName: 'LICENSE.electron.txt', layout: 'electron-builder-packed' }
  })
  const result = await assembleCompleteRelease(options)
  const members = unzipSync(fs.readFileSync(result.output))
  assert.ok(members['runtime/electron/LICENSE.electron.txt'])
  assert.equal(members['runtime/electron/LICENSE'], undefined)
  await verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE)
  rebindReceivedArchive(result, unpacked => {
    unpacked['runtime/electron/LICENSE'] = unpacked['runtime/electron/LICENSE.electron.txt']
    delete unpacked['runtime/electron/LICENSE.electron.txt']
  })
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE), /runtime notice|filename/)
  const good = JSON.parse(fs.readFileSync(options.inventory))
  write(path.join(options.electronDir, 'LICENSE'), 'Unexpected second runtime LICENSE')
  await assert.rejects(collectCompleteInputs(options), /runtime notice filename/)
  fs.unlinkSync(path.join(options.electronDir, 'LICENSE'))
  for (const mutate of [
    inventory => { inventory.actual.runtimeNotices[0].sourceName = 'invented-LICENSE' },
    inventory => { inventory.actual.runtimeNotices[0].actualName = 'LICENSE' },
    inventory => { inventory.actual.runtimeNotices.push({ ...inventory.actual.runtimeNotices[0], name: 'LICENSE' }) },
    inventory => { inventory.actual.runtimeNotices = inventory.actual.runtimeNotices.filter(entry => entry.name !== 'LICENSE.electron.txt') }
  ]) {
    const changed = structuredClone(good); mutate(changed); write(options.inventory, changed)
    await assert.rejects(collectCompleteInputs(options), /runtime notice|identity|receipt/)
  }
  write(options.inventory, good)
}))

test('complete ZIP rereads actual publisher assets and rejects altered resources or binding evidence', async () => fixture(async options => {
  const actual = await installNativeFixture(options.root, options.electronDir, true, true)
  const { report, notices } = collectInventory(actual)
  assert.equal(report.inventoryComplete, true, JSON.stringify(report.reviewNeeded))
  write(options.inventory, report); write(options.notices, notices)
  const source = { packageSha256: receipt(options.root, 'package.json').sha256, lockSha256: receipt(options.root, 'package-lock.json').sha256 }
  mutateJson(path.join(options.cliDir, 'build/cli-build.json'), build => { Object.assign(build.source, source) })
  mutateJson(path.join(options.cliDir, 'cli-inventory.json'), inventory => {
    Object.assign(inventory.source, source)
    inventory.source.buildReceiptSha256 = receipt(options.cliDir, 'build/cli-build.json').sha256
    inventory.files = inventory.files.map(entry => receipt(options.cliDir, entry.name))
  })
  rebindCli(options)
  const result = await assembleCompleteRelease(options)
  const unpacked = unzipSync(fs.readFileSync(result.output))
  const supplement = report.actual.packageNoticeSupplements.find(entry => entry.packageName === 'png-js')
  for (const entry of supplement.resources) {
    assert.equal(hash(unpacked[entry.archiveName]), entry.sha256)
    assert.equal(unpacked[entry.archiveName].length, entry.size)
    assert.deepEqual(result.manifest.files.find(file => file.name === entry.archiveName), { name: entry.archiveName, size: entry.size, sha256: entry.sha256 })
  }
  await verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE)
  const changed = structuredClone(report)
  changed.actual.packageBindings.bindings.find(entry => entry.name === 'png-js').sourceIdentity.integrity += 'changed'
  write(options.inventory, changed)
  await assert.rejects(collectCompleteInputs(options), /actual binding evidence differs/)
  write(options.inventory, report)
  report.actual.packageNoticeSupplements[0].resources[1].sha256 = 'f'.repeat(64)
  write(options.inventory, report)
  await assert.rejects(collectCompleteInputs(options), /Package notice inventory differs/)
}))

test('received complete archive rejects changed CLI bytes or duplicate receipt paths', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const unpacked = unzipSync(fs.readFileSync(result.output))
  unpacked['cli/deepwriter.cjs'] = Buffer.from('changed CLI bytes')
  write(result.output, Buffer.from(zipSync(unpacked)))
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE), /ZIP member/)
  mutateJson(`${result.output}.manifest.json`, manifest => { manifest.files.push({ ...manifest.files[0] }) })
  await assert.rejects(verifyCompleteDownload(path.dirname(result.output), VERSION, SOURCE), /duplicate/)
}))
test('missing CLI cannot produce a complete ZIP', async () => fixture(async options => {
  await assert.rejects(assembleCompleteRelease({ ...options, cliDir: undefined }), /requires built CLI/)
  assert.equal(fs.existsSync(path.join(options.root, 'release', `DeepWriter-${VERSION}-complete.zip`)), false)
}))
test('desktop-only remains diagnostic and does not create a complete ZIP', async () => fixture(async options => {
  const result = await assembleCompleteRelease({ ...options, desktopOnly: true, cliDir: undefined })
  assert.equal(result.complete, false)
  assert.equal(result.diagnosticOnly, true)
  const previous = console.log
  console.log = () => {}
  try { assert.equal(await main(['--root', options.root, '--release-dir', options.releaseDir, '--source-commit', SOURCE, '--desktop-only']), 1) } finally { console.log = previous }
  assert.equal(fs.existsSync(path.join(options.root, 'release', `DeepWriter-${VERSION}-complete.zip`)), false)
}))
test('CLI version and source must match the root and verified desktop identity', async () => fixture(async options => {
  const file = path.join(options.cliDir, 'cli-release.json')
  const original = JSON.parse(fs.readFileSync(file))
  for (const mutation of [{ version: '1.3.0' }, { sourceCommit: 'c'.repeat(40) }]) {
    write(file, { ...original, ...mutation })
    await assert.rejects(collectCompleteInputs(options), /CLI artifact identity/)
  }
}))
test('missing Node license or runtime inventory is rejected even when the files manifest is rehashed', async () => fixture(async options => {
  mutateJson(path.join(options.cliDir, 'cli-release.json'), manifest => { manifest.files = manifest.files.filter(entry => entry.name !== 'runtime/LICENSE') })
  await assert.rejects(collectCompleteInputs(options), /omits a required/)
}))
test('CLI inventory cannot claim different runtime bytes or skip bundle coverage', async () => fixture(async options => {
  const file = path.join(options.cliDir, 'cli-inventory.json')
  const original = JSON.parse(fs.readFileSync(file))
  write(file, { ...original, runtime: { ...original.runtime, executableSha256: 'd'.repeat(64) } })
  rebindCli(options)
  await assert.rejects(collectCompleteInputs(options), /CLI inventory is incomplete or stale/)
  write(file, { ...original, files: original.files.filter(entry => entry.name !== 'deepwriter.cjs') })
  rebindCli(options)
  await assert.rejects(collectCompleteInputs(options), /does not bind/)
}))
test('actual ASAR and runtime notices must match the desktop inventory', async () => fixture(async options => {
  fs.appendFileSync(path.join(options.electronDir, 'LICENSE'), 'tampered')
  await assert.rejects(collectCompleteInputs(options), /runtime notice differs/)
}))
test('desktop third-party notices must be the exact bytes bound by the actual inventory', async () => fixture(async options => {
  fs.appendFileSync(options.notices, 'Unrelated notices from a different build.\n')
  await assert.rejects(collectCompleteInputs(options), /Desktop third-party notices differ/)
}))
test('incomplete or stale desktop inventory cannot pass as a complete package', async () => fixture(async options => {
  mutateJson(options.inventory, inventory => { inventory.inventoryComplete = false })
  await assert.rejects(collectCompleteInputs(options), /Desktop inventory is incomplete/)
}))
test('explicit CLI paths reject traversal, private files, Windows alias paths and case collisions', async () => fixture(async options => {
  const file = path.join(options.cliDir, 'cli-release.json')
  const original = JSON.parse(fs.readFileSync(file))
  for (const name of ['../outside.txt', 'work/user.txt', 'keys/private.key', '.env', 'settings.json', 'runtime/CON.txt', 'runtime/node.exe:stream']) {
    write(file, { ...original, files: [...original.files, { name, size: 1, sha256: 'e'.repeat(64) }] })
    await assert.rejects(collectCompleteInputs(options), /unsafe|Unsafe|Private/)
  }
  write(file, { ...original, files: [...original.files, { ...original.files[0], name: original.files[0].name.toUpperCase() }] })
  await assert.rejects(collectCompleteInputs(options), /duplicate/)
}))
test('linked CLI resources are refused without following the link', async () => fixture(async options => {
  const directory = path.join(options.cliDir, 'runtime')
  const renamed = path.join(options.cliDir, 'saved-runtime')
  fs.renameSync(directory, renamed)
  fs.symlinkSync(renamed, directory, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(collectCompleteInputs(options), /Linked input/)
}))
test('existing complete package and original desktop evidence are never overwritten', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const bytes = fs.readFileSync(result.output)
  await assert.rejects(assembleCompleteRelease(options), /Refusing to overwrite/)
  assert.deepEqual(fs.readFileSync(result.output), bytes)
  await assert.rejects(assembleCompleteRelease({ ...options, output: path.join(options.releaseDir, 'complete.zip') }), /must not alter/)
  await assert.rejects(assembleCompleteRelease({ ...options, output: '../outside.zip' }), /inside the project/)
}))
test('sensitive input content fails closed without logging synthetic credentials', async () => fixture(async options => {
  const key = `sk-${'SyntheticCredentialFixture'.repeat(3)}`
  fs.appendFileSync(path.join(options.root, 'docs', 'CLI.md'), key)
  await assert.rejects(assembleCompleteRelease(options), error => error.message.includes('Sensitive credential') && !error.message.includes(key))
  assert.equal(fs.existsSync(path.join(options.root, 'release', `DeepWriter-${VERSION}-complete.zip`)), false)
}))
test('real ZIP extraction rejects changed bytes despite a matching filename', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const expected = result.manifest.files
  const unpacked = unzipSync(fs.readFileSync(result.output))
  const completeManifest = Buffer.from(unpacked['complete-manifest.json'])
  const innerChecksums = Buffer.from(unpacked['SHA256SUMS.txt'])
  expected.push({ name: 'complete-manifest.json', size: completeManifest.length, sha256: hash(completeManifest) }, { name: 'SHA256SUMS.txt', size: innerChecksums.length, sha256: hash(innerChecksums) })
  unpacked['cli/deepwriter.cjs'][0] ^= 1
  const corrupt = path.join(options.root, 'changed.zip')
  write(corrupt, Buffer.from(zipSync(unpacked, { level: 0 })))
  await assert.rejects(verifyZipBytes(corrupt, expected), /bytes or CRC differ/)
}))
test('truncated ZIP central directory is rejected instead of treating local records as complete', async () => fixture(async options => {
  const result = await assembleCompleteRelease(options)
  const bytes = fs.readFileSync(result.output)
  const corrupt = path.join(options.root, 'truncated.zip')
  write(corrupt, bytes.subarray(0, bytes.length - 22))
  await assert.rejects(verifyZipBytes(corrupt, result.manifest.files), /ZIP end directory/)
}))
test('unknown and duplicated assembly flags are rejected', () => {
  assert.throws(() => parseArgs(['--unknown']), /Unknown/)
  assert.throws(() => parseArgs(['--cli-dir']), /requires/)
  assert.throws(() => parseArgs(['--cli-dir=a', '--cli-dir=b']), /Duplicate/)
})
