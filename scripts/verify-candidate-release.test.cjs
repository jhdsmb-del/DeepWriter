'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { verifyCandidateRelease, hashFile } = require('./verify-candidate-release.cjs')

const version = '1.3.0'
const sourceCommit = 'a'.repeat(40)

async function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-candidate-'))
  const installer = `DeepWriter-${version}-x64-setup.exe`
  const names = [installer, `DeepWriter-${version}-x64-portable.exe`, 'installation-verification.json', `SBOM_DEPENDENCIES_${version}.md`]
  const metadata = { version, tag: `v${version}`, sourceCommit, buildPlatform: 'win32', targetPlatform: 'win32', targetArch: 'x64', unsigned: true, publisher: null, files: [] }
  async function refresh() {
    metadata.files = await Promise.all(names.map(async (name) => ({ name, size: fs.statSync(path.join(dir, name)).size, sha256: await hashFile(path.join(dir, name)) })))
    fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(metadata))
    const entries = [...metadata.files, { name: 'release.json', sha256: await hashFile(path.join(dir, 'release.json')) }]
    fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), entries.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n')
  }
  try {
    const binary = Buffer.alloc(1024 * 1024)
    binary.write('MZ')
    for (const name of names.filter((name) => name.endsWith('.exe'))) fs.writeFileSync(path.join(dir, name), binary)
    const proof = { version, sourceCommit, upgradedFrom: '1.2.6', installerSha256: await hashFile(path.join(dir, installer)), baselineSha256: 'b'.repeat(64), cleanInstall: true, upgradeHistory: true, upgradeCredentials: true, uninstallPreservesData: true }
    fs.writeFileSync(path.join(dir, 'installation-verification.json'), JSON.stringify(proof))
    fs.writeFileSync(path.join(dir, `SBOM_DEPENDENCIES_${version}.md`), 'Fixture only; not a distributable SBOM.')
    await refresh()
    await run({ dir, metadata, proof, refresh })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('an unchanged complete unsigned candidate binds hashes, source and installation proof', async () => fixture(async ({ dir }) => {
  const metadata = await verifyCandidateRelease(dir, version, sourceCommit)
  assert.equal(metadata.unsigned, true)
  await assert.rejects(verifyCandidateRelease(dir, version, 'c'.repeat(40)), /identity/)
}))

test('modified executable cannot be promoted or pass downloaded-release verification', async () => fixture(async ({ dir }) => {
  fs.appendFileSync(path.join(dir, `DeepWriter-${version}-x64-portable.exe`), 'changed')
  await assert.rejects(verifyCandidateRelease(dir, version, sourceCommit), /checksum differs/)
}))

test('a missing portable cannot publish a partial release', async () => fixture(async ({ dir }) => {
  fs.unlinkSync(path.join(dir, `DeepWriter-${version}-x64-portable.exe`))
  await assert.rejects(verifyCandidateRelease(dir, version, sourceCommit), /missing or unexpected/)
}))

test('stale or failed installation evidence is rejected even with freshly computed hashes', async () => fixture(async ({ dir, proof, refresh }) => {
  for (const changed of [{ ...proof, sourceCommit: 'c'.repeat(40) }, { ...proof, upgradeCredentials: false }, { ...proof, installerSha256: 'd'.repeat(64) }]) {
    fs.writeFileSync(path.join(dir, 'installation-verification.json'), JSON.stringify(changed))
    await refresh()
    await assert.rejects(verifyCandidateRelease(dir, version, sourceCommit), /installation evidence/)
  }
}))

test('duplicate or path-traversal checksum entries are refused before reading files', async () => fixture(async ({ dir, refresh }) => {
  const file = path.join(dir, 'SHA256SUMS.txt')
  const original = fs.readFileSync(file, 'utf8')
  fs.appendFileSync(file, original.split('\n')[0] + '\n')
  await assert.rejects(verifyCandidateRelease(dir, version, sourceCommit), /duplicate checksum/)
  await refresh()
  fs.appendFileSync(file, `${'a'.repeat(64)}  ../outside.exe\n`)
  await assert.rejects(verifyCandidateRelease(dir, version, sourceCommit), /Unexpected/)
}))

test('the candidate route rejects signed-status claims and unexpected assets', async () => fixture(async ({ dir, metadata, refresh }) => {
  metadata.unsigned = false
  metadata.publisher = 'Invented Publisher'
  await refresh()
  await assert.rejects(verifyCandidateRelease(dir, version, sourceCommit), /unsigned status/)
  metadata.unsigned = true
  metadata.publisher = null
  await refresh()
  fs.writeFileSync(path.join(dir, 'unexpected.exe'), 'unexpected')
  await assert.rejects(verifyCandidateRelease(dir, version, sourceCommit), /unexpected assets/)
}))
