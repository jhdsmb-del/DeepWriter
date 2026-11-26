'use strict'
const { exampleMembers } = require('./release-examples.cjs')
const { electronRuntimeNoticeNames } = require('./distribution-inventory.cjs')

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { verifyZipBytes, safeName } = require('./assemble-complete-release.cjs')
const { verifyOfficialRelease, hashFile } = require('./prepare-release.cjs')
const METADATA_LIMIT = 8 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const receipt = (name, bytes) => ({ name, size: bytes.length, sha256: hash(bytes) })
const equal = (left, right) => left && right && left.size === right.size && left.sha256 === right.sha256
function regular(file, limit = METADATA_LIMIT) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > limit) throw new Error('Invalid received metadata resource')
  return stat
}
function receipts(entries, label) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 4096) throw new Error(`${label} component receipt list is invalid`)
  const output = new Map(), lower = new Set()
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > 2 * 1024 * 1024 * 1024 || !HASH.test(entry.sha256 || '') || lower.has(entry.name.toLowerCase())) throw new Error(`${label} component receipt is invalid or duplicated`)
    safeName(entry.name); lower.add(entry.name.toLowerCase()); output.set(entry.name, entry)
  }
  return output
}
function json(captured, name) {
  const bytes = captured.get(name)
  if (!bytes || bytes.length > METADATA_LIMIT) throw new Error('Missing bounded component metadata')
  const value = JSON.parse(bytes.toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid component metadata object')
  return value
}
function verifyCliComponent(cli, inventory, build, licenseSource, desktopInventory, aggregate, version, sourceCommit) {
  const runtime = cli.runtime
  if (cli.schemaVersion !== 1 || cli.name !== 'deepwriter-cli' || cli.version !== version || cli.sourceCommit !== sourceCommit ||
      cli.entrypoint !== 'deepwriter.cjs' || cli.inventory !== 'cli-inventory.json' || cli.notices !== 'THIRD_PARTY_NOTICES.txt' ||
      runtime?.name !== 'node' || runtime.platform !== 'win32' || runtime.arch !== 'x64' || !/^\d+\.\d+\.\d+$/.test(runtime.version || '') ||
      runtime.executable !== 'runtime/node.exe' || runtime.license !== 'runtime/LICENSE' || runtime.licenseSource !== 'runtime/LICENSE.source.json') throw new Error('CLI component identity differs from the intended release')
  const [major, minor] = runtime.version.split('.').map(Number)
  if (major < 22 || major === 22 && minor < 13) throw new Error('CLI component runtime is below the supported minimum')
  const files = receipts(cli.files, 'CLI')
  const required = ['deepwriter.cjs', 'deepwriter.cmd', 'LICENSE', 'build/cli-build.json', runtime.executable, runtime.license, runtime.licenseSource, cli.inventory, cli.notices]
  if (required.some(name => !files.has(name)) || files.has('cli-release.json')) throw new Error('CLI component receipt omits required resources or claims a self hash')
  const archiveFiles = [...aggregate.keys()].filter(name => name.toLowerCase().startsWith('cli/'))
  if (archiveFiles.length !== files.size + 1 || archiveFiles.some(name => name !== 'cli/cli-release.json' && !files.has(name.slice(4)))) throw new Error('CLI component receipt set differs from complete archive')
  for (const [name, entry] of files) if (!equal(entry, aggregate.get(`cli/${name}`))) throw new Error('CLI component receipt differs from complete archive bytes')
  if (!equal(files.get('LICENSE'), aggregate.get('LICENSE'))) throw new Error('CLI component project license differs from desktop source')
  if (inventory.schemaVersion !== 1 || inventory.application?.name !== 'deepwriter-cli' || inventory.application.version !== version || inventory.sourceCommit !== sourceCommit || inventory.sourceDirty !== false ||
      inventory.inventoryComplete !== true || !Array.isArray(inventory.reviewNeeded) || inventory.reviewNeeded.length ||
      inventory.runtime?.name !== runtime.name || inventory.runtime.version !== runtime.version || inventory.runtime.platform !== runtime.platform || inventory.runtime.arch !== runtime.arch ||
      inventory.runtime.executableSha256 !== files.get(runtime.executable).sha256 || !equal(inventory.runtime.license, files.get(runtime.license)) || inventory.runtime.license?.name !== runtime.license ||
      inventory.runtime.license.sourceUrl !== `https://raw.githubusercontent.com/nodejs/node/v${runtime.version}/LICENSE`) throw new Error('CLI inventory identity, clean source or runtime evidence is incomplete')
  const source = inventory.source
  if (!source || !['packageSha256', 'lockSha256', 'bundleSha256', 'buildReceiptSha256', 'metafileSha256'].every(key => HASH.test(source[key] || '')) ||
      source.packageSha256 !== desktopInventory.source?.packageSha256 || source.lockSha256 !== desktopInventory.source?.lockSha256 ||
      source.bundleSha256 !== files.get(cli.entrypoint).sha256 || source.buildReceiptSha256 !== files.get('build/cli-build.json').sha256) throw new Error('CLI inventory source tuple differs from desktop or component bytes')
  if (build.schemaVersion !== 1 || build.application?.name !== cli.name || build.application.version !== version || build.sourceCommit !== sourceCommit || build.sourceDirty !== false ||
      build.source?.packageSha256 !== source.packageSha256 || build.source?.lockSha256 !== source.lockSha256 || !equal(build.bundle, files.get(cli.entrypoint)) ||
      !HASH.test(build.metafile?.sha256 || '') || build.metafile.sha256 !== source.metafileSha256 || !Number.isSafeInteger(build.metafile.size) || build.metafile.size <= 0 || build.metafile.size > METADATA_LIMIT ||
      typeof build.bundle?.name !== 'string' || path.posix.basename(build.bundle.name) !== cli.entrypoint || typeof build.metafile.name !== 'string' || path.posix.basename(build.metafile.name) !== 'cli-metafile.json' ||
      build.buildPolicy?.implementation !== 'src/cli/build.mjs' || !HASH.test(build.buildPolicy.implementationSha256 || '') || build.buildPolicy.platform !== 'node' || build.buildPolicy.format !== 'cjs' || build.buildPolicy.target !== 'node22' || build.buildPolicy.entrypoint !== 'src/cli/main.ts' ||
      !Array.isArray(build.warnings) || build.warnings.length) throw new Error('CLI build receipt source identity or bundle/metafile binding is invalid')
  safeName(build.bundle.name); safeName(build.metafile.name)
  if (licenseSource.version !== runtime.version || licenseSource.name !== 'LICENSE' || licenseSource.sourceUrl !== inventory.runtime.license.sourceUrl ||
      typeof licenseSource.retrievedAt !== 'string' || !Number.isFinite(Date.parse(licenseSource.retrievedAt)) || !equal(licenseSource, files.get(runtime.license))) throw new Error('CLI Node license source receipt differs from runtime license bytes or version')
  const inventoryFiles = receipts(inventory.files, 'CLI inventory')
  if (inventoryFiles.size !== files.size - 1 || inventoryFiles.has(cli.inventory)) throw new Error('CLI inventory receipt set differs from component manifest')
  for (const [name, entry] of files) {
    if (name !== cli.inventory && !equal(entry, inventoryFiles.get(name))) throw new Error('CLI inventory receipt differs from component manifest')
  }
}
function verifyDesktopInventory(inventory, aggregate, version) {
  if (inventory.schemaVersion !== 1 || inventory.application?.name !== 'deepwriter' || inventory.application.version !== version || inventory.inventoryComplete !== true ||
      !Array.isArray(inventory.reviewNeeded) || inventory.reviewNeeded.length || !HASH.test(inventory.source?.packageSha256 || '') || !HASH.test(inventory.source?.lockSha256 || '') ||
      !HASH.test(inventory.actual?.archiveSha256 || '') || !equal(inventory.projectLicense?.sourceResource, aggregate.get('LICENSE')) || !equal(inventory.notices, aggregate.get('THIRD_PARTY_NOTICES.txt'))) throw new Error('Desktop inventory source or resource evidence is incomplete')
  const notices = receipts(inventory.actual.runtimeNotices, 'Desktop inventory')
  for (const name of electronRuntimeNoticeNames(inventory.actual.runtimeNotices)) if (!equal(notices.get(name), aggregate.get(`runtime/electron/${name}`))) throw new Error('Desktop inventory runtime notice differs from complete archive')
}

const CANONICAL_DESKTOP_NAME = /^(?:release\.json|SHA256SUMS\.txt|installation-verification\.json|signature-verification\.json|DeepWriter-\d+\.\d+\.\d+-x64-(?:setup|portable)\.exe|SBOM_DEPENDENCIES_\d+\.\d+\.\d+\.md)$/i
async function desktopReceipts(directory, version, sourceCommit) {
  for (const name of ['release.json', 'SHA256SUMS.txt', 'installation-verification.json']) regular(path.join(directory, name))
  const metadata = await verifyOfficialRelease(directory, `v${version}`, sourceCommit)
  const files = new Map(metadata.files.map(entry => [`desktop/${entry.name}`, entry]))
  for (const name of ['release.json', 'SHA256SUMS.txt']) {
    const file = path.join(directory, name)
    files.set(`desktop/${name}`, { name, size: regular(file).size, sha256: await hashFile(file) })
  }
  return { metadata, files }
}
async function receivedDesktopReceipts(directory, version, sourceCommit) {
  const results = []
  const nested = path.join(directory, `v${version}`)
  let nestedStat
  try { nestedStat = fs.lstatSync(nested) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (nestedStat) {
    if (!nestedStat.isDirectory() || nestedStat.isSymbolicLink()) throw new Error('Canonical desktop release directory is invalid')
    results.push(await desktopReceipts(nested, version, sourceCommit))
  }
  const flatNames = fs.readdirSync(directory)
  if (flatNames.some(name => CANONICAL_DESKTOP_NAME.test(name))) {
    const releaseFile = path.join(directory, 'release.json')
    regular(releaseFile)
    const metadata = JSON.parse(fs.readFileSync(releaseFile, 'utf8'))
    if (!Array.isArray(metadata.files) || !metadata.files.length || metadata.files.length > 4096) throw new Error('Flat canonical desktop receipt list is invalid')
    const names = ['release.json', 'SHA256SUMS.txt', ...metadata.files.map(entry => entry?.name)]
    const lower = new Set()
    let totalSize = 0
    for (const name of names) {
      if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || lower.has(name.toLowerCase())) throw new Error('Flat canonical desktop file names are invalid or duplicated')
      safeName(name); lower.add(name.toLowerCase())
      totalSize += regular(path.join(directory, name), 2 * 1024 * 1024 * 1024).size
      if (totalSize > 3 * 1024 * 1024 * 1024) throw new Error('Flat canonical desktop exceeds the complete release size limit')
    }
    if (flatNames.some(name => CANONICAL_DESKTOP_NAME.test(name) && !lower.has(name.toLowerCase()))) throw new Error('Flat canonical desktop contains unexpected versioned assets')
    // GitHub release downloads are flat and also contain the complete ZIP trio.
    // Project only declared, regular canonical files into a private temporary
    // directory so the unchanged official verifier retains its exact-set check.
    const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-received-desktop-'))
    try {
      for (const name of names) fs.copyFileSync(path.join(directory, name), path.join(staged, name), fs.constants.COPYFILE_EXCL)
      const verified = await desktopReceipts(staged, version, sourceCommit)
      for (const name of names) {
        const original = path.join(directory, name)
        if (!equal(verified.files.get(`desktop/${name}`), { size: regular(original, 2 * 1024 * 1024 * 1024).size, sha256: await hashFile(original) })) throw new Error('Flat canonical desktop changed during verification')
      }
      results.push(verified)
    } finally { fs.rmSync(staged, { recursive: true, force: true }) }
  }
  if (!results.length) throw new Error('Canonical desktop release assets are missing')
  if (results.length === 2 && (results[0].files.size !== results[1].files.size || [...results[0].files].some(([name, entry]) => !equal(entry, results[1].files.get(name))))) throw new Error('Nested and flat canonical desktop receipts conflict')
  return results[0]
}

/** Verify received bytes against the intended release, without ZIP extraction or execution. */
async function verifyCompleteDownload(directory, version, sourceCommit) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid expected complete release identity')
  const archiveName = `DeepWriter-${version}-complete.zip`
  const manifestFile = path.join(directory, `${archiveName}.manifest.json`)
  regular(manifestFile)
  const bytes = fs.readFileSync(manifestFile)
  const manifest = JSON.parse(bytes)
  if (manifest.schemaVersion !== 1 || manifest.name !== 'deepwriter-complete' || manifest.complete !== true || manifest.version !== version || manifest.sourceCommit !== sourceCommit || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 4096) throw new Error('Complete archive does not match the expected release')
  const required = [...exampleMembers(version), 'LICENSE', 'README.md', 'SECURITY.md', 'docs/QUICKSTART.md', 'docs/PRIVACY.md', 'docs/OPERATIONS.md', 'docs/CLI.md',
    'docs/VALIDATION.md', 'docs/LICENSE_DECISION.md', 'docs/EXTENSIONS_RESEARCH.md', 'docs/PROVIDER_EXPANSION_RESEARCH.md',
    `desktop/DeepWriter-${version}-x64-setup.exe`, `desktop/DeepWriter-${version}-x64-portable.exe`,
    'desktop/release.json', 'desktop/SHA256SUMS.txt', 'desktop/installation-verification.json',
    'cli/deepwriter.cjs', 'cli/deepwriter.cmd', 'cli/cli-release.json', 'cli/cli-inventory.json',
    'cli/runtime/node.exe', 'cli/runtime/LICENSE', 'cli/THIRD_PARTY_NOTICES.txt',
    'distribution-inventory.json', 'THIRD_PARTY_NOTICES.txt', 'runtime/electron/LICENSES.chromium.html']
  const names = new Set()
  for (const entry of manifest.files) {
    if (!entry || typeof entry.name !== 'string' || !Number.isSafeInteger(entry.size) || entry.size <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || names.has(entry.name.toLowerCase())) throw new Error('Invalid or duplicate complete manifest entry')
    safeName(entry.name)
    names.add(entry.name.toLowerCase())
  }
  if (required.some(name => !names.has(name.toLowerCase())) || names.has('complete-manifest.json') || names.has('sha256sums.txt') || manifest.files.reduce((sum, entry) => sum + entry.size, 0) > 3 * 1024 * 1024 * 1024) throw new Error('Complete archive omits required deliverables or exceeds its limit')
  const aggregate = receipts(manifest.files, 'Complete')
  const { metadata: desktop, files: expectedDesktop } = await receivedDesktopReceipts(directory, version, sourceCommit)
  if (manifest.desktopUnsigned !== desktop.unsigned) throw new Error('Desktop component unsigned identity differs from canonical release')
  const desktopNames = [...aggregate.keys()].filter(name => name.toLowerCase().startsWith('desktop/'))
  if (desktopNames.length !== expectedDesktop.size || desktopNames.some(name => !expectedDesktop.has(name))) throw new Error('Desktop component receipt set differs from verified official assets')
  for (const [name, entry] of expectedDesktop) if (!equal(entry, aggregate.get(name))) throw new Error('Desktop component receipt differs from verified official assets')
  const members = [...manifest.files, receipt('complete-manifest.json', bytes)]
  const checksums = Buffer.from(members.map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n')
  members.push(receipt('SHA256SUMS.txt', checksums))
  const archive = path.join(directory, archiveName)
  if (fs.lstatSync(archive).isSymbolicLink()) throw new Error('Linked complete archive is not allowed')
  const result = await verifyZipBytes(archive, members, { capture: ['cli/cli-release.json', 'cli/cli-inventory.json', 'distribution-inventory.json', 'cli/build/cli-build.json', 'cli/runtime/LICENSE.source.json'], maxCaptureBytes: METADATA_LIMIT })
  const desktopInventory = json(result.captured, 'distribution-inventory.json')
  const runtimeNoticeNames = electronRuntimeNoticeNames(desktopInventory.actual?.runtimeNotices)
  if (!runtimeNoticeNames.every(name => names.has(`runtime/electron/${name}`.toLowerCase())) ||
      ['LICENSE', 'LICENSE.electron.txt'].filter(name => names.has(`runtime/electron/${name}`.toLowerCase())).length !== 1) throw new Error('Complete archive Electron license filename differs from actual receipts')
  verifyDesktopInventory(desktopInventory, aggregate, version)
  verifyCliComponent(json(result.captured, 'cli/cli-release.json'), json(result.captured, 'cli/cli-inventory.json'), json(result.captured, 'cli/build/cli-build.json'), json(result.captured, 'cli/runtime/LICENSE.source.json'), desktopInventory, aggregate, version, sourceCommit)
  return { version, sourceCommit, verifiedMembers: result.verifiedMembers }
}
if (require.main === module) verifyCompleteDownload(process.argv[2], process.argv[3], process.argv[4])
  .then(result => console.log(`Received complete release verified: ${result.version}; ${result.verifiedMembers} members`))
  .catch(() => { console.error('Received complete release failed identity or byte verification.'); process.exitCode = 1 })
module.exports = { verifyCompleteDownload }
