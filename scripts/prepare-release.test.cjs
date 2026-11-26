'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const asar = require('@electron/asar')
const { finished } = require('node:stream/promises')
const { prepareRelease: prepare, verifiedSignatures, verifyOfficialRelease, hashFile } = require('./prepare-release.cjs')
// Local artifact fixtures deliberately omit installation acceptance by default.
const prepareRelease = (root, commit) => prepare(root, commit, { requireSigning: false, requireInstallation: false })
const version = require('../package.json').version
const sourceCommit = 'a'.repeat(40)

async function fixture(run, packedVersion = version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-release-'))
  try {
    const dir = path.join(root, 'dist', 'win-unpacked', 'resources')
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(path.join(root, 'app'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'deepwriter', version }))
    fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({ name: 'deepwriter', version: packedVersion }))
    const writer = await asar.createPackage(path.join(root, 'app'), path.join(dir, 'app.asar'))
    if (writer?.once) await finished(writer)
    const binary = Buffer.alloc(1024 * 1024, 0)
    binary.write('MZ')
    for (const kind of ['setup', 'portable']) fs.writeFileSync(path.join(root, 'dist', `DeepWriter-${version}-x64-${kind}.exe`), binary)
    const releaseDir = path.join(root, 'release', `v${version}`)
    fs.mkdirSync(releaseDir, { recursive: true })
    fs.writeFileSync(path.join(releaseDir, `SBOM_DEPENDENCIES_${version}.md`), 'Fixture SBOM only; never a publishable artifact.')
    await run(root, releaseDir)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('both Windows artifacts, version identity and every published checksum match', async () => fixture(async (root, dir) => {
  const { metadata } = await prepareRelease(root, sourceCommit)
  assert.equal(metadata.sourceCommit, sourceCommit)
  assert.equal(metadata.version, version)
  for (const line of fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')) {
    const [hash, name] = line.split('  ')
    assert.equal(hash, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex'))
  }
  await assert.rejects(prepareRelease(root, sourceCommit), /Refusing to overwrite/)
}))

test('missing portable cannot stage a partial installer release', async () => fixture(async (root, dir) => {
  fs.unlinkSync(path.join(root, 'dist', `DeepWriter-${version}-x64-portable.exe`))
  await assert.rejects(prepareRelease(root, sourceCommit), /ENOENT/)
  assert.equal(fs.existsSync(path.join(dir, `DeepWriter-${version}-x64-setup.exe`)), false)
}))

test('non-Windows binary is rejected', async () => fixture(async (root) => {
  const file = path.join(root, 'dist', `DeepWriter-${version}-x64-setup.exe`)
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, Buffer.from('EL'), 0, 2, 0)
  fs.closeSync(fd)
  await assert.rejects(prepareRelease(root, sourceCommit), /Not a Windows executable/)
}))

test('stale packaged application version prevents publication', async () => fixture(async (root) => {
  await assert.rejects(prepareRelease(root, sourceCommit), /Packaged application identity/)
}, '1.2.5'))

test('explicit signing requirements reject missing signing evidence before staging any executable', async () => fixture(async (root, dir) => {
  await assert.rejects(prepare(root, sourceCommit, { requireSigning: true, publisher: 'Fixture' }), /ENOENT/)
  assert.equal(fs.existsSync(path.join(dir, `DeepWriter-${version}-x64-setup.exe`)), false)
}))

async function withOfficialEnvironment(task, extra = {}) {
  const values = { GITHUB_REF: `refs/tags/v${version}`, RELEASE_TAG: `v${version}`, DW_REQUIRE_SIGNING: undefined, DW_REQUIRE_INSTALLATION: undefined, DW_SIGNING_PUBLISHER: undefined, ...extra }
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  try { return await task() } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}
async function installationFixture(root, mutation = {}) {
  const report = { version, sourceCommit, upgradedFrom: '1.2.6', installerSha256: await hashFile(path.join(root, 'dist', `DeepWriter-${version}-x64-setup.exe`)), baselineSha256: 'c'.repeat(64), cleanInstall: true, upgradeHistory: true, upgradeCredentials: true, uninstallPreservesData: true, ...mutation }
  fs.writeFileSync(path.join(root, 'dist', 'installation-verification.json'), JSON.stringify(report))
  return report
}
test('official unsigned release is allowed only with current installation evidence', async () => fixture(async (root) => {
  await installationFixture(root)
  const { metadata } = await withOfficialEnvironment(() => prepare(root, sourceCommit))
  assert.equal(metadata.unsigned, true)
  assert.equal(metadata.publisher, null)
  assert.ok(metadata.files.some(file => file.name === 'installation-verification.json'))
}))
test('official unsigned release rejects missing installation before staging any executable', async () => fixture(async (root, dir) => {
  await withOfficialEnvironment(() => assert.rejects(prepare(root, sourceCommit), /ENOENT|Installation/))
  assert.equal(fs.existsSync(path.join(dir, `DeepWriter-${version}-x64-setup.exe`)), false)
}))
test('official unsigned release rejects stale source, version, hash and failed retention evidence', async () => fixture(async (root, dir) => {
  for (const mutation of [{ sourceCommit: 'b'.repeat(40) }, { version: '0.0.1' }, { installerSha256: 'd'.repeat(64) }, { uninstallPreservesData: false }]) {
    await installationFixture(root, mutation)
    await withOfficialEnvironment(() => assert.rejects(prepare(root, sourceCommit), /incomplete or stale|differs/))
    assert.equal(fs.existsSync(path.join(dir, `DeepWriter-${version}-x64-setup.exe`)), false)
  }
}))
test('official unsigned release rejects an explicit signing requirement', async () => fixture(async (root, dir) => {
  await installationFixture(root)
  await withOfficialEnvironment(() => assert.rejects(prepare(root, sourceCommit), /expected publisher/), { DW_REQUIRE_SIGNING: '1' })
  assert.equal(fs.existsSync(path.join(dir, `DeepWriter-${version}-x64-setup.exe`)), false)
}))
test('installation requirement can be enabled explicitly outside an official tag', async () => fixture(async (root, dir) => {
  await assert.rejects(prepare(root, sourceCommit, { requireSigning: false, requireInstallation: true }), /ENOENT|Installation/)
  assert.equal(fs.existsSync(path.join(dir, `DeepWriter-${version}-x64-setup.exe`)), false)
}))

async function rebindFixtureReceipt(directory, mutate = () => {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'))
  mutate(metadata)
  for (const entry of metadata.files) {
    const file = path.join(directory, entry.name)
    entry.size = fs.statSync(file).size
    entry.sha256 = await hashFile(file)
  }
  fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify(metadata))
  const entries = [...metadata.files, { name: 'release.json', sha256: await hashFile(path.join(directory, 'release.json')) }]
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), entries.map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n')
}
test('official downloaded unsigned assets verify installation, source identity and complete checksums', async () => fixture(async (root, dir) => {
  await installationFixture(root)
  await prepare(root, sourceCommit, { requireSigning: false, requireInstallation: true })
  const metadata = await verifyOfficialRelease(dir, `v${version}`, sourceCommit)
  assert.equal(metadata.unsigned, true)
  await assert.rejects(verifyOfficialRelease(dir, `v${version}`, 'b'.repeat(40)), /identity differs/)
  fs.appendFileSync(path.join(dir, `DeepWriter-${version}-x64-setup.exe`), 'tampered')
  await assert.rejects(verifyOfficialRelease(dir, `v${version}`, sourceCommit), /hash or size differs/)
}))
test('official downloaded unsigned assets reject installation removed from the manifest', async () => fixture(async (root, dir) => {
  await installationFixture(root)
  await prepare(root, sourceCommit, { requireSigning: false, requireInstallation: true })
  await rebindFixtureReceipt(dir, metadata => { metadata.files = metadata.files.filter(file => file.name !== 'installation-verification.json') })
  await assert.rejects(verifyOfficialRelease(dir, `v${version}`, sourceCommit), /incomplete or invalid/)
}))
test('official download verification rejects rehashed but stale installation proofs', async () => fixture(async (root, dir) => {
  const original = await installationFixture(root)
  await prepare(root, sourceCommit, { requireSigning: false, requireInstallation: true })
  for (const mutation of [{ sourceCommit: 'b'.repeat(40) }, { version: '0.0.1' }, { installerSha256: 'd'.repeat(64) }, { uninstallPreservesData: false }]) {
    fs.writeFileSync(path.join(dir, 'installation-verification.json'), JSON.stringify({ ...original, ...mutation }))
    await rebindFixtureReceipt(dir)
    await assert.rejects(verifyOfficialRelease(dir, `v${version}`, sourceCommit), /incomplete or stale|differs/)
  }
}))

test('unsigned preflight includes real installation evidence without claiming a signed release', async () => fixture(async (root) => {
  const file = path.join(root, 'dist', 'installation-verification.json')
  const report = { version, sourceCommit, upgradedFrom: '1.2.6', installerSha256: await hashFile(path.join(root, 'dist', `DeepWriter-${version}-x64-setup.exe`)), baselineSha256: 'c'.repeat(64), cleanInstall: true, upgradeHistory: true, upgradeCredentials: true, uninstallPreservesData: true }
  fs.writeFileSync(file, JSON.stringify({ ...report, sourceCommit: 'b'.repeat(40) }))
  await assert.rejects(prepareRelease(root, sourceCommit), /incomplete or stale/)
  fs.writeFileSync(file, JSON.stringify(report))
  const { metadata } = await prepareRelease(root, sourceCommit)
  assert.equal(metadata.unsigned, true)
  assert.equal(metadata.publisher, null)
  assert.equal(metadata.files.some((entry) => entry.name === 'installation-verification.json'), true)
  assert.equal(metadata.files.some((entry) => entry.name === 'signature-verification.json'), false)
}))

async function signatureFixture(root) {
  const names = [`DeepWriter-${version}-x64-setup.exe`, `DeepWriter-${version}-x64-portable.exe`, 'win-unpacked/DeepWriter.exe', 'verified-uninstaller.exe']
  const files = []
  for (const name of names) {
    const file = path.join(root, 'dist', name)
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'Signature validation fixture only; not a signed executable.')
    files.push({ name, sha256: await hashFile(file), status: 'Valid', publisher: 'Fixture Publisher', signerThumbprint: 'A'.repeat(40), timestampThumbprint: 'B'.repeat(40) })
  }
  const proof = { version, sourceCommit, files }
  fs.writeFileSync(path.join(root, 'dist', 'signature-verification.json'), JSON.stringify(proof))
  return proof
}

test('optional signature evidence is never ignored when stale', async () => fixture(async root => {
  const proof = await signatureFixture(root)
  proof.sourceCommit = 'b'.repeat(40)
  fs.writeFileSync(path.join(root, 'dist', 'signature-verification.json'), JSON.stringify(proof))
  await assert.rejects(prepare(root, sourceCommit, { requireSigning: false, publisher: 'Fixture Publisher' }), /identity differs/)
}))

test('signature evidence binds each artifact to source, publisher and timestamp, rejecting tampering', async () => fixture(async (root) => {
  const proof = await signatureFixture(root)
  await verifiedSignatures(root, version, sourceCommit, 'Fixture Publisher')
  await assert.rejects(verifiedSignatures(root, version, 'b'.repeat(40), 'Fixture Publisher'), /identity/)
  await assert.rejects(verifiedSignatures(root, version, sourceCommit, 'Different Publisher'), /publisher/)
  const file = path.join(root, 'dist', 'signature-verification.json')
  for (const mutation of [() => { proof.files[0].timestampThumbprint = '' }, () => { proof.files[0].status = 'NotTrusted' }]) {
    mutation(); fs.writeFileSync(file, JSON.stringify(proof))
    await assert.rejects(verifiedSignatures(root, version, sourceCommit, 'Fixture Publisher'), /proof/)
  }
  await signatureFixture(root)
  fs.appendFileSync(path.join(root, 'dist', `DeepWriter-${version}-x64-setup.exe`), 'tampered')
  await assert.rejects(verifiedSignatures(root, version, sourceCommit, 'Fixture Publisher'), /changed/)
}))

test('signed staging requires actual installation evidence and includes its checksums', async () => fixture(async (root, dir) => {
  await signatureFixture(root)
  const options = { requireSigning: true, publisher: 'Fixture Publisher' }
  await assert.rejects(prepare(root, sourceCommit, options), /ENOENT/)
  const report = { version, sourceCommit, upgradedFrom: '1.2.6', installerSha256: await hashFile(path.join(root, 'dist', `DeepWriter-${version}-x64-setup.exe`)), baselineSha256: 'c'.repeat(64), cleanInstall: true, upgradeHistory: true, upgradeCredentials: true, uninstallPreservesData: false }
  const file = path.join(root, 'dist', 'installation-verification.json')
  fs.writeFileSync(file, JSON.stringify(report))
  await assert.rejects(prepare(root, sourceCommit, options), /incomplete/)
  assert.equal(fs.existsSync(path.join(dir, `DeepWriter-${version}-x64-setup.exe`)), false)
  report.uninstallPreservesData = true; fs.writeFileSync(file, JSON.stringify(report))
  const { metadata } = await prepare(root, sourceCommit, options)
  assert.equal(metadata.unsigned, false)
  assert.equal(metadata.publisher, 'Fixture Publisher')
  assert.equal(metadata.files.some((entry) => entry.name === 'installation-verification.json'), true)
}))

test('optional downloaded signature claims must retain bound publisher and timestamp evidence', async () => fixture(async (root, dir) => {
  await signatureFixture(root)
  await installationFixture(root)
  await prepare(root, sourceCommit, { requireSigning: false, requireInstallation: true, publisher: 'Fixture Publisher' })
  assert.equal((await verifyOfficialRelease(dir, `v${version}`, sourceCommit)).unsigned, false)
  const file = path.join(dir, 'signature-verification.json')
  const proof = JSON.parse(fs.readFileSync(file))
  proof.files[0].timestampThumbprint = ''
  fs.writeFileSync(file, JSON.stringify(proof))
  await rebindFixtureReceipt(dir)
  await assert.rejects(verifyOfficialRelease(dir, `v${version}`, sourceCommit), /Optional signature proof/)
  await rebindFixtureReceipt(dir, metadata => { metadata.unsigned = true; metadata.publisher = null })
  await assert.rejects(verifyOfficialRelease(dir, `v${version}`, sourceCommit), /Unsigned release cannot claim/)
}))
