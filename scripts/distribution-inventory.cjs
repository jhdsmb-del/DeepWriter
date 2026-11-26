'use strict'

// Evidence collection, not a license compatibility decision or release signer.
// Reads manifests and license/notice resources only; never reads userData.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { packedSupplement } = require('./native-notice-resources.cjs')
const { packedSupplements } = require('./package-notice-resources.cjs')
const { collectPackageBindings } = require('./distribution-package-bindings.cjs')

const ROOT = path.resolve(__dirname, '..')
const PACKAGE_PATH = /^node_modules\/(?:@[^/]+\/[^/]+|[^@/][^/]*)(?:\/node_modules\/(?:@[^/]+\/[^/]+|[^@/][^/]*))*$/
const NOTICE_NAME = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i
const UNKNOWN_LICENSE = /^(?:unknown|unlicensed|none|NOASSERTION)$/i
const LIMIT = 64 * 1024 * 1024

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function within(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function readRegular(file, limit = LIMIT) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Resource must be a bounded regular file')
  const bytes = fs.readFileSync(file)
  if (bytes.length > limit) throw new Error('Resource exceeds limit')
  return bytes
}
function noLinkedParents(root, target) {
  if (!within(root, target)) throw new Error('Path escapes project root')
  const relative = path.relative(root, target)
  let current = root
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component)
    if (fs.existsSync(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked resource path rejected')
    }
  }
}
function licenseValue(raw) {
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (raw && typeof raw.type === 'string' && raw.type.trim()) return raw.type.trim()
  if (Array.isArray(raw)) return raw.map(licenseValue).filter(value => value !== 'unknown').join(' OR ') || 'unknown'
  return 'unknown'
}
function isKnownLicense(value) { return !UNKNOWN_LICENSE.test(value) }
function resource(name, bytes) { return { name, size: bytes.length, sha256: digest(bytes) } }
function localNotices(directory) {
  return fs.readdirSync(directory).filter(name => NOTICE_NAME.test(name)).sort().map(name => {
    const bytes = readRegular(path.join(directory, name))
    return { ...resource(name, bytes), text: bytes.toString('utf8') }
  })
}
function publicResource({ text, ...metadata }) { return metadata }
function electronRuntimeNoticeNames(notices) {
  if (!Array.isArray(notices) || notices.length !== 2) throw new Error('Electron runtime notice receipt set differs')
  const license = notices.filter(entry => entry.name === 'LICENSE' || entry.name === 'LICENSE.electron.txt')
  if (license.length !== 1 || license[0].missing || license[0].sourceName !== 'LICENSE' || license[0].actualName !== license[0].name ||
      license[0].layout !== (license[0].name === 'LICENSE.electron.txt' ? 'electron-builder-packed' : 'electron-upstream') ||
      notices.filter(entry => entry.name === 'LICENSES.chromium.html' && !entry.missing).length !== 1) throw new Error('Electron runtime notice identity differs')
  return [license[0].name, 'LICENSES.chromium.html']
}
function parseArgs(argv) {
  const options = { root: ROOT }
  const allowed = new Map([['--root', 'root'], ['--asar', 'asarPath'], ['--electron-dir', 'electronDir'], ['--report', 'report'], ['--notices', 'notices']])
  for (let i = 0; i < argv.length; i++) {
    const parts = argv[i].split('=')
    const key = allowed.get(parts[0])
    if (!key) throw new Error('Unknown inventory option')
    const value = parts.length > 1 ? argv[i].slice(parts[0].length + 1) : argv[++i]
    if (!value || value.startsWith('--')) throw new Error('Inventory option requires a value')
    if (Object.prototype.hasOwnProperty.call(options, key) && key !== 'root') throw new Error('Duplicate inventory option')
    options[key] = value
  }
  return options
}

function collectInventory({ root = ROOT, asarPath, electronDir } = {}) {
  root = path.resolve(root)
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('Project root must be a real directory')
  const packageBytes = readRegular(path.join(root, 'package.json'), 1024 * 1024)
  const lockBytes = readRegular(path.join(root, 'package-lock.json'), 8 * 1024 * 1024)
  const pkg = JSON.parse(packageBytes)
  const lock = JSON.parse(lockBytes)
  if (!lock.packages || typeof lock.packages !== 'object') throw new Error('Lockfile packages are required')
  const reviewNeeded = []
  const issue = (code, subject) => reviewNeeded.push({ code, subject })
  const texts = []
  if (lock.version !== pkg.version || lock.packages['']?.version !== pkg.version) issue('SOURCE_VERSION_DRIFT', 'package-lock.json')
  const declaredLicense = licenseValue(pkg.license)
  const projectLicense = { declared: declaredLicense, sourceResource: null }
  if (!isKnownLicense(declaredLicense)) issue('PROJECT_LICENSE_DECLARATION_MISSING', 'package.json')
  try {
    const bytes = readRegular(path.join(root, 'LICENSE'))
    projectLicense.sourceResource = resource('LICENSE', bytes)
    texts.push({ subject: `${pkg.name}@${pkg.version} (source project license)`, name: 'LICENSE', text: bytes.toString('utf8') })
  } catch { issue('PROJECT_LICENSE_RESOURCE_MISSING', 'LICENSE') }

  const planned = Object.entries(lock.packages).filter(([location]) => location !== '').sort(([a], [b]) => a.localeCompare(b)).map(([location, entry]) => {
    if (!PACKAGE_PATH.test(location) || location.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid locked package path')
    const directory = path.resolve(root, ...location.split('/'))
    noLinkedParents(root, directory)
    const row = { location, version: entry.version || 'unknown', scope: entry.dev || entry.devOptional ? 'development' : 'production', optional: entry.optional === true, integrity: entry.integrity || 'unknown', installed: false, installedVersion: null, license: licenseValue(entry.license), notices: [] }
    if (fs.existsSync(directory)) {
      try {
        const bytes = readRegular(path.join(directory, 'package.json'), 1024 * 1024)
        const installed = JSON.parse(bytes)
        row.installed = true
        row.installedVersion = installed.version || 'unknown'
        row.license = licenseValue(installed.license ?? installed.licenses)
        row.manifestSha256 = digest(bytes)
        row.notices = localNotices(directory).map(publicResource)
      } catch { row.metadataUnreadable = true }
    }
    return row
  })
  const plannedReview = planned.filter(row => row.installed && (!isKnownLicense(row.license) || row.notices.length === 0 || row.installedVersion !== row.version))
    .map(row => ({ location: row.location, unknownLicense: !isKnownLicense(row.license), noNoticeResource: row.notices.length === 0, versionDrift: row.installedVersion !== row.version }))

  let actual = null
  if (!asarPath) {
    issue('ACTUAL_ASAR_NOT_PROVIDED', 'desktop distribution')
  } else {
    const archive = path.resolve(root, asarPath)
    if (!fs.lstatSync(archive).isFile() || fs.lstatSync(archive).isSymbolicLink()) throw new Error('ASAR must be a regular file')
    const asar = require('@electron/asar')
    const entries = asar.listPackage(archive).map(name => name.replace(/\\/g, '/').replace(/^\/+/, '')).sort()
    if (entries.some(name => name.split('/').some(part => part === '..' || part === '.'))) throw new Error('Invalid ASAR entry path')
    const entrySet = new Set(entries)
    const readPacked = (name, limit = LIMIT) => {
      const nativeName = path.normalize(name)
      const stat = asar.statFile(archive, nativeName, false)
      if (stat.link || stat.files || typeof stat.size !== 'number' || stat.size > limit) throw new Error('Packed resource must be a bounded regular file')
      let bytes
      if (stat.unpacked) {
        const unpackedRoot = `${archive}.unpacked`
        if (!fs.lstatSync(unpackedRoot).isDirectory() || fs.lstatSync(unpackedRoot).isSymbolicLink()) throw new Error('Unpacked resource root must be a real directory')
        const target = path.resolve(unpackedRoot, nativeName)
        noLinkedParents(unpackedRoot, target)
        bytes = readRegular(target, limit)
      } else bytes = asar.extractFile(archive, nativeName, false)
      if (bytes.length > limit || bytes.length !== stat.size) throw new Error('Packed resource length differs')
      return bytes
    }
    const identity = JSON.parse(readPacked('package.json', 1024 * 1024))
    if (identity.name !== pkg.name || identity.version !== pkg.version) issue('PACKAGED_IDENTITY_DRIFT', 'package.json')
    if (licenseValue(identity.license) !== declaredLicense) issue('PACKAGED_PROJECT_LICENSE_DRIFT', 'package.json')
    const packageLocations = entries.filter(name => PACKAGE_PATH.test(name) && asar.statFile(archive, path.normalize(name), false).files)
    const packageBindings = collectPackageBindings({ root, lock, projectManifest: pkg, packageLocations, readPacked })
    reviewNeeded.push(...packageBindings.reviewNeeded)
    const bindingsByPath = new Map(packageBindings.bindings.map(entry => [entry.location, entry]))
    let packageNoticeSupplements = []
    try { packageNoticeSupplements = packedSupplements(readPacked, packageBindings.bindings) }
    catch { issue('PACKAGED_PUBLISHER_NOTICE_BINDING_INVALID', 'Fixed publisher notice supplement') }
    let nativeNoticeSupplement = null
    try { nativeNoticeSupplement = packedSupplement(lock, readPacked, packageLocations) }
    catch { issue('PACKAGED_NATIVE_NOTICE_BINDING_INVALID', 'Fixed canvas notice supplement') }
    const packages = packageLocations.map(location => {
      try {
        const bytes = readPacked(`${location}/package.json`, 1024 * 1024)
        const manifest = JSON.parse(bytes)
        const license = licenseValue(manifest.license ?? manifest.licenses)
        const notices = entries.filter(entry => entry.startsWith(`${location}/`) && !entry.slice(location.length + 1).includes('/') && NOTICE_NAME.test(path.posix.basename(entry))).map(entry => {
          const bytes = readPacked(entry)
          texts.push({ subject: `${manifest.name || location}@${manifest.version || 'unknown'}`, name: entry, text: bytes.toString('utf8') })
          return resource(entry, bytes)
        })
        const publisherSupplement = packageNoticeSupplements.find(entry => entry.packageLocation === location)
        if (!isKnownLicense(license) && !publisherSupplement?.reviewedSourceLicense) issue('PACKAGED_LICENSE_UNKNOWN', location)
        const supplement = nativeNoticeSupplement?.packageLocation === location ? nativeNoticeSupplement : null
        if (notices.length === 0 && !supplement && !publisherSupplement) issue('PACKAGED_NOTICE_MISSING', location)
        return { location, name: manifest.name || location, version: manifest.version || 'unknown', license, manifestSha256: digest(bytes), notices,
          binding: bindingsByPath.get(location), ...(supplement ? { noticeSupplement: supplement } : {}),
          ...(publisherSupplement ? { publisherNoticeSupplement: publisherSupplement, reviewedSourceLicense: publisherSupplement.reviewedSourceLicense } : {}) }
      } catch (error) {
        issue('PACKAGED_METADATA_UNREADABLE', location)
        return { location, metadataUnreadable: true, errorCategory: error.name }
      }
    })
    const runtimeDirectory = electronDir ? path.resolve(root, electronDir) : path.dirname(path.dirname(archive))
    const availableElectronLicenses = ['LICENSE.electron.txt', 'LICENSE'].filter(name => fs.existsSync(path.join(runtimeDirectory, name)))
    if (availableElectronLicenses.length > 1) issue('ELECTRON_NOTICE_AMBIGUOUS', 'LICENSE / LICENSE.electron.txt')
    const electronLicenseName = availableElectronLicenses.length === 1 ? availableElectronLicenses[0] : 'LICENSE'
    const runtimeNotices = [electronLicenseName, 'LICENSES.chromium.html'].map(name => {
      try {
        if (name === electronLicenseName && availableElectronLicenses.length !== 1) throw new Error('Missing or ambiguous Electron license')
        noLinkedParents(root, path.join(runtimeDirectory, name))
        const bytes = readRegular(path.join(runtimeDirectory, name))
        texts.push({ subject: 'Electron/Chromium runtime (actual unpacked distribution)', name, text: bytes.toString('utf8') })
        return { ...resource(name, bytes), ...(name === electronLicenseName ? { sourceName: 'LICENSE', actualName: name,
          layout: name === 'LICENSE.electron.txt' ? 'electron-builder-packed' : 'electron-upstream' } : {}) }
      } catch { issue('ELECTRON_NOTICE_MISSING', name); return { name, missing: true } }
    })
    // Bundle-contained code cannot be identified from package.json entries.
    // Conservatively supplement notices from the full installed lock plan;
    // these rows are explicitly NOT claimed as shipped packages.
    const actualLocations = new Set(packages.map(row => row.location))
    const installedPlanSupplement = planned.filter(row => row.installed && !actualLocations.has(row.location)).map(row => {
      for (const notice of localNotices(path.join(root, ...row.location.split('/')))) texts.push({ subject: `${row.location}@${row.installedVersion} (installed lock-plan supplement; shipped inclusion not verified)`, name: `${row.location}/${notice.name}`, text: notice.text })
      return { location: row.location, scope: row.scope, installedVersion: row.installedVersion, license: row.license, notices: row.notices }
    })
    const projectLicensePacked = entrySet.has('LICENSE') ? resource('LICENSE', readPacked('LICENSE')) : null
    const nativeNoticeSupplements = nativeNoticeSupplement ? [nativeNoticeSupplement] : []
    for (const supplement of nativeNoticeSupplements) for (const entry of supplement.resources.filter(entry => entry.sourceUrl)) {
      texts.push({ subject: `${supplement.packageName}@${supplement.packageVersion} (fixed package-level supplement; native graph partial, legal compliance not assessed); ${entry.sourceUrl}`, name: entry.name, text: readPacked(entry.name).toString('utf8') })
    }
    for (const supplement of packageNoticeSupplements) for (const entry of supplement.resources.filter(entry => entry.sourceUrl)) {
      texts.push({ subject: `${supplement.packageName}@${supplement.packageVersion} (${entry.noticeKind}; completeLicenseText=${entry.completeLicenseText}; copyrightCoverage=${entry.copyrightCoverage}; legal compliance not assessed); ${entry.sourceUrl}`, name: entry.name, text: readPacked(entry.name).toString('utf8') })
    }
    actual = { archiveSha256: hashFile(archive), identity: { name: identity.name, version: identity.version }, packages, runtimeNotices, projectLicensePacked, installedPlanSupplement, nativeNoticeSupplements, packageBindings, packageNoticeSupplements }
  }
  const notices = texts.map(item => `===== ${item.subject} / ${item.name} =====\n\n${item.text}`).join('\n\n') + '\n'
  const noticesBytes = Buffer.from(notices, 'utf8')
  return {
    report: { schemaVersion: 1, application: { name: pkg.name, version: pkg.version }, source: { packageSha256: digest(packageBytes), lockSha256: digest(lockBytes) }, projectLicense,
      notices: { name: 'THIRD_PARTY_NOTICES.txt', size: noticesBytes.length, sha256: digest(noticesBytes) },
      lockPlan: { packages: planned, reviewItems: plannedReview, productionCount: planned.filter(row => row.scope === 'production').length, developmentCount: planned.filter(row => row.scope === 'development').length }, actual,
      reviewNeeded, inventoryComplete: reviewNeeded.length === 0, legalCompliance: 'not-assessed', releaseReadiness: 'not-assessed',
      nativeGraphCoverage: { status: actual?.nativeNoticeSupplements.length ? 'partial' : 'unknown', unresolvedVersions: 'unknown' },
      limitations: ['Lock plan and installed packages are not proof of shipped contents.', 'ASAR manifest inventory does not enumerate code embedded in bundles, native binaries, fonts or icons; those require separate owner review.', 'License identifiers and notice resources are collected, not interpreted for compatibility.', 'This report neither signs nor authorizes a release.'] },
    notices
  }
}
function hashFile(file) {
  const fd = fs.openSync(file, 'r')
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size)) } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}
function writeNew(root, destination, text) {
  const target = path.resolve(root, destination)
  noLinkedParents(root, target)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // Recheck after directory creation, and never overwrite an earlier receipt.
  noLinkedParents(root, target)
  fs.writeFileSync(target, text, { flag: 'wx', mode: 0o600 })
}
function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    const { report, notices } = collectInventory(options)
    const root = path.resolve(options.root)
    if (options.report) writeNew(root, options.report, JSON.stringify(report, null, 2) + '\n')
    if (options.notices) writeNew(root, options.notices, notices)
    console.log(`Distribution inventory: ${report.application.name} ${report.application.version}; lock production=${report.lockPlan.productionCount}, development=${report.lockPlan.developmentCount}; actual ASAR manifests=${report.actual?.packages.length ?? 'not provided'}`)
    console.log(`Evidence gaps=${report.reviewNeeded.length}; installed-plan review items=${report.lockPlan.reviewItems.length}; legal compliance and release readiness are not assessed.`)
    for (const item of report.reviewNeeded) console.log(`REVIEW ${item.code}: ${item.subject}`)
    return report.inventoryComplete ? 0 : 1
  } catch (error) { console.error(`Inventory failed: ${error.message}`); return 2 }
}
if (require.main === module) process.exitCode = main()
module.exports = { collectInventory, electronRuntimeNoticeNames, parseArgs, writeNew, main }
