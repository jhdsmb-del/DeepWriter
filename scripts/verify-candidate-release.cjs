'use strict'
const { upgradeBaseline } = require('./upgrade-baseline.cjs')

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

// Promotion verifies the existing Windows build; it never rebuilds or edits it.
async function verifyCandidateRelease(dir, version, sourceCommit) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid candidate identity')
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
  const metadata = read('release.json')
  if (metadata.version !== version || metadata.tag !== `v${version}` || metadata.sourceCommit !== sourceCommit || metadata.buildPlatform !== 'win32' || metadata.targetPlatform !== 'win32' || metadata.targetArch !== 'x64' || metadata.unsigned !== true || metadata.publisher !== null) throw new Error('Candidate identity or unsigned status differs')
  const names = [`DeepWriter-${version}-x64-setup.exe`, `DeepWriter-${version}-x64-portable.exe`, 'installation-verification.json', `SBOM_DEPENDENCIES_${version}.md`]
  if (!Array.isArray(metadata.files) || metadata.files.length !== names.length || names.some((name) => metadata.files.filter((file) => file.name === name).length !== 1)) throw new Error('Candidate asset set is incomplete or unexpected')
  const expected = [...names, 'release.json']
  const lines = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/)
  const checksums = new Map()
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match || !expected.includes(match[2]) || checksums.has(match[2])) throw new Error('Unexpected or duplicate checksum entry')
    checksums.set(match[2], match[1])
  }
  if (checksums.size !== expected.length) throw new Error('Candidate checksums are incomplete')
  const actual = fs.readdirSync(dir).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected, 'SHA256SUMS.txt'].sort())) throw new Error('Candidate directory contains missing or unexpected assets')
  for (const name of expected) {
    const file = path.join(dir, name)
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) throw new Error(`Candidate asset is not a regular file: ${name}`)
    const hash = await hashFile(file)
    if (hash !== checksums.get(name)) throw new Error(`Candidate checksum differs: ${name}`)
    if (name !== 'release.json') {
      const entry = metadata.files.find((item) => item.name === name)
      if (entry.sha256 !== hash || entry.size !== stat.size) throw new Error(`Candidate metadata differs: ${name}`)
    }
    if (name.endsWith('.exe')) {
      const fd = fs.openSync(file, 'r')
      try {
        const header = Buffer.alloc(2)
        if (stat.size < 1024 * 1024 || fs.readSync(fd, header, 0, 2, 0) !== 2 || header.toString() !== 'MZ') throw new Error(`Invalid Windows executable: ${name}`)
      } finally { fs.closeSync(fd) }
    }
  }
  const proof = read('installation-verification.json')
  if (proof.version !== version || proof.sourceCommit !== sourceCommit || proof.upgradedFrom !== upgradeBaseline(version) || ['cleanInstall', 'upgradeHistory', 'upgradeCredentials', 'uninstallPreservesData'].some((key) => proof[key] !== true) || proof.installerSha256 !== checksums.get(names[0]) || !/^[a-f0-9]{64}$/.test(proof.baselineSha256 || '')) throw new Error('Candidate installation evidence is incomplete or stale')
  return metadata
}

module.exports = { verifyCandidateRelease, hashFile }
if (require.main === module) {
  const [dir, version, sourceCommit] = process.argv.slice(2)
  verifyCandidateRelease(dir, version, sourceCommit).then(() => console.log(`Verified unchanged unsigned Windows candidate ${version} from ${sourceCommit}`)).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
