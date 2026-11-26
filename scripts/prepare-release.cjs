'use strict'
const { upgradeBaseline } = require('./upgrade-baseline.cjs')

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifiedSignatures(root, version, commit, publisher) {
  if (!publisher?.trim()) throw new Error('Signed release requires an expected publisher')
  const file = path.join(root, 'dist', 'signature-verification.json')
  const proof = JSON.parse(fs.readFileSync(file, 'utf8'))
  const expected = [`DeepWriter-${version}-x64-setup.exe`, `DeepWriter-${version}-x64-portable.exe`, 'win-unpacked/DeepWriter.exe', 'verified-uninstaller.exe']
  if (proof.version !== version || proof.sourceCommit !== commit || !Array.isArray(proof.files) || proof.files.length !== expected.length) throw new Error('Signature proof identity differs from source')
  for (const name of expected) {
    const entries = proof.files.filter((entry) => entry.name === name)
    const entry = entries[0]
    if (entries.length !== 1 || entry.status !== 'Valid' || entry.publisher !== publisher || !/^[A-Fa-f0-9]{40}$/.test(entry.signerThumbprint || '') || !/^[A-Fa-f0-9]{40}$/.test(entry.timestampThumbprint || '')) throw new Error(`Invalid publisher or timestamp proof: ${name}`)
    if (entry.sha256 !== await hashFile(path.join(root, 'dist', name))) throw new Error(`Signed artifact changed after verification: ${name}`)
  }
  return proof
}

async function verifiedInstallation(directory, version, commit, installer) {
  const installation = JSON.parse(fs.readFileSync(path.join(directory, 'installation-verification.json'), 'utf8'))
  if (installation.version !== version || installation.sourceCommit !== commit || installation.upgradedFrom !== upgradeBaseline(version) || ['cleanInstall', 'upgradeHistory', 'upgradeCredentials', 'uninstallPreservesData'].some((key) => installation[key] !== true)) throw new Error('Installation verification is incomplete or stale')
  if (installation.installerSha256 !== await hashFile(installer) || !/^[a-f0-9]{64}$/.test(installation.baselineSha256 || '')) throw new Error('Installation evidence differs from verified artifacts')
  return installation
}

async function prepareRelease(root = path.resolve(__dirname, '..'), sourceCommit, options = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = pkg.version
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be a three-part version')
  const tag = `v${version}`
  const commit = sourceCommit ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Invalid source commit')
  const requireSigning = options.requireSigning ?? (process.env.DW_REQUIRE_SIGNING === '1')
  const requireInstallation = options.requireInstallation ?? (process.env.GITHUB_REF?.startsWith('refs/tags/') || process.env.DW_REQUIRE_INSTALLATION === '1')
  const publisher = options.publisher ?? process.env.DW_SIGNING_PUBLISHER
  const hasSignature = fs.existsSync(path.join(root, 'dist', 'signature-verification.json'))
  const signatures = (requireSigning || hasSignature) ? await verifiedSignatures(root, version, commit, publisher) : null
  if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== tag) throw new Error('Release tag and package version differ')
  const packed = JSON.parse(require('@electron/asar').extractFile(path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar'), 'package.json').toString())
  if (packed.version !== version || packed.name !== 'deepwriter') throw new Error('Packaged application identity differs from source')
  const names = [`DeepWriter-${version}-x64-setup.exe`, `DeepWriter-${version}-x64-portable.exe`]
  // Validate both artifacts before staging either one. Never publish a partial pair.
  for (const name of names) {
    const file = path.join(root, 'dist', name)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size < 1024 * 1024) throw new Error(`Invalid Windows artifact: ${name}`)
    const fd = fs.openSync(file, 'r')
    try {
      const header = Buffer.alloc(2)
      if (fs.readSync(fd, header, 0, 2, 0) !== 2 || header.toString() !== 'MZ') throw new Error(`Not a Windows executable: ${name}`)
    } finally { fs.closeSync(fd) }
  }
  const dir = path.join(root, 'release', tag)
  const sbom = `SBOM_DEPENDENCIES_${version}.md`
  if (!fs.statSync(path.join(dir, sbom)).isFile()) throw new Error('Release SBOM is missing')
  const hasInstallation = fs.existsSync(path.join(root, 'dist', 'installation-verification.json'))
  const checkInstallation = requireInstallation || signatures || hasInstallation
  const evidence = [...(signatures ? ['signature-verification.json'] : []), ...(checkInstallation ? ['installation-verification.json'] : [])]
  if (checkInstallation) await verifiedInstallation(path.join(root, 'dist'), version, commit, path.join(root, 'dist', names[0]))
  for (const name of [...names, ...evidence, 'release.json', 'SHA256SUMS.txt']) {
    if (fs.existsSync(path.join(dir, name))) throw new Error(`Refusing to overwrite staged release file: ${name}`)
  }
  for (const name of [...names, ...evidence]) fs.copyFileSync(path.join(root, 'dist', name), path.join(dir, name), fs.constants.COPYFILE_EXCL)
  const files = []
  for (const name of [...names, ...evidence, sbom]) files.push({ name, size: fs.statSync(path.join(dir, name)).size, sha256: await hashFile(path.join(dir, name)) })
  const metadata = { version, tag, sourceCommit: commit, buildPlatform: process.platform, targetPlatform: 'win32', targetArch: 'x64', unsigned: !signatures, publisher: signatures ? publisher : null, generatedAt: new Date().toISOString(), files }
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' })
  files.push({ name: 'release.json', sha256: await hashFile(path.join(dir, 'release.json')) })
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n', { flag: 'wx' })
  console.log(`Release staged: ${tag}; source ${commit}; installer, portable, SBOM and SHA-256 checksums`)
  return { dir, metadata }
}

// Used after downloading the exact staged assets, before official publication.
// Authenticode trust is established on Windows before staging; this rechecks its
// bound proof when present, and never treats unsigned status as an installation bypass.
async function verifyOfficialRelease(directory, tag, sourceCommit) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid official release identity')
  const version = tag.slice(1)
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
  const metadata = read('release.json')
  if (metadata.tag !== tag || metadata.version !== version || metadata.sourceCommit !== sourceCommit || metadata.targetPlatform !== 'win32' || metadata.targetArch !== 'x64' || typeof metadata.unsigned !== 'boolean') throw new Error('Official release identity differs from source')
  const required = [`DeepWriter-${version}-x64-setup.exe`, `DeepWriter-${version}-x64-portable.exe`, `SBOM_DEPENDENCIES_${version}.md`, 'installation-verification.json']
  if (!Array.isArray(metadata.files) || metadata.files.some(file => !file || typeof file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) || new Set(metadata.files.map(file => file.name)).size !== metadata.files.length || required.some(name => !metadata.files.some(file => file.name === name))) throw new Error('Official release assets are incomplete or invalid')
  const names = [...metadata.files.map(file => file.name), 'release.json']
  const checksums = new Map()
  for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match || !names.includes(match[2]) || checksums.has(match[2])) throw new Error('Official checksums contain an unexpected or duplicate asset')
    checksums.set(match[2], match[1])
  }
  if (checksums.size !== names.length || JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify([...names, 'SHA256SUMS.txt'].sort())) throw new Error('Official release file set differs from checksums')
  for (const name of names) {
    const file = path.join(directory, name)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Official release asset is not a regular file')
    const hash = await hashFile(file)
    const entry = metadata.files.find(item => item.name === name)
    if (hash !== checksums.get(name) || (entry && (entry.sha256 !== hash || entry.size !== stat.size))) throw new Error(`Official release asset hash or size differs: ${name}`)
  }
  await verifiedInstallation(directory, version, sourceCommit, path.join(directory, required[0]))
  const hasSignature = names.includes('signature-verification.json')
  if (metadata.unsigned) {
    if (metadata.publisher !== null || hasSignature) throw new Error('Unsigned release cannot claim a publisher or signature proof')
  } else {
    if (!hasSignature || typeof metadata.publisher !== 'string' || !metadata.publisher.trim()) throw new Error('Signed release requires a publisher and signature proof')
    const proof = read('signature-verification.json')
    const expected = [required[0], required[1], 'win-unpacked/DeepWriter.exe', 'verified-uninstaller.exe']
    if (proof.version !== version || proof.sourceCommit !== sourceCommit || !Array.isArray(proof.files) || proof.files.length !== expected.length) throw new Error('Signature proof identity differs from source')
    for (const name of expected) {
      const entries = proof.files.filter(file => file.name === name)
      const entry = entries[0]
      if (entries.length !== 1 || entry.status !== 'Valid' || entry.publisher !== metadata.publisher || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !/^[A-Fa-f0-9]{40}$/.test(entry.signerThumbprint || '') || !/^[A-Fa-f0-9]{40}$/.test(entry.timestampThumbprint || '') || (checksums.has(name) && checksums.get(name) !== entry.sha256)) throw new Error('Optional signature proof is incomplete or stale')
    }
  }
  return metadata
}

module.exports = { prepareRelease, hashFile, verifiedSignatures, verifiedInstallation, verifyOfficialRelease }
if (require.main === module) prepareRelease().catch((error) => { console.error(error.message); process.exitCode = 1 })
