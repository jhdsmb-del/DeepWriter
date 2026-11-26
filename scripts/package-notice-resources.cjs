'use strict'

// Exact publisher bytes for fixed npm versions only. This is not a legal audit.
const fs = require('node:fs')
const path = require('node:path')
const { read, sha, receipt } = require('./native-notice-resources.cjs')
const ROOT = path.resolve(__dirname, '..')
const SOURCE = 'build/package-notices'
const STAGED = 'out/main/package-notices'
const ARCHIVED = 'licenses/packages'
const CATALOG_SHA256 = 'a57a8f3495a484639440942a7450f7859286d481fe6944ac4db60d2ec6c6d7a8'
function exact(bytes, expected) {
  if (bytes.length !== expected.size || sha(bytes) !== expected.sha256) throw new Error('Package notice resource differs from fixed publisher bytes')
}
function sourceAssets() {
  const bytes = read(ROOT, SOURCE + '/catalog.json')
  if (sha(bytes) !== CATALOG_SHA256) throw new Error('Package notice catalog differs from fixed source')
  const catalog = JSON.parse(bytes)
  const assets = [{ ...receipt('catalog.json', bytes), bytes }]
  for (const entry of catalog.packages) {
    const bytes = read(ROOT, SOURCE + '/' + entry.notice.name)
    exact(bytes, entry.notice)
    assets.push({ ...entry.notice, bytes })
  }
  return { catalog, assets }
}
function stagePackageNotices(root = ROOT) {
  const { catalog, assets } = sourceAssets()
  const lock = JSON.parse(read(root, 'package-lock.json'))
  const applicable = catalog.packages.filter(entry => fs.existsSync(path.join(root, entry.packageLocation)))
  if (!applicable.length) return { applicable: false }
  for (const entry of applicable) {
    const locked = lock.packages?.[entry.packageLocation]
    const bytes = read(root, entry.packageLocation + '/package.json')
    exact(bytes, entry.packageManifestSource)
    const manifest = JSON.parse(bytes)
    if (manifest.name !== entry.name || manifest.version !== entry.version || locked?.version !== entry.version ||
        locked.resolved !== entry.resolved || locked.integrity !== entry.integrity) throw new Error('Package notice installed source/lock differs')
  }
  read(root, 'out/main/index.js') // normal electron-vite build must already exist
  const target = path.resolve(root, STAGED)
  // read() rejects linked parents for every resource, including an existing stage.
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isDirectory() ||
        fs.readdirSync(target).sort().join('\n') !== assets.map(entry => entry.name).sort().join('\n')) throw new Error('Existing package notice stage differs')
    for (const asset of assets) exact(read(root, STAGED + '/' + asset.name), asset)
  } else {
    const parent = path.dirname(target)
    read(root, 'out/main/index.js')
    fs.mkdirSync(parent, { recursive: true })
    // Validate all parents before any staging write.
    let current = path.resolve(root)
    for (const part of STAGED.split('/').slice(0, -1)) {
      current = path.join(current, part)
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked package notice stage rejected')
    }
    const temporary = fs.mkdtempSync(path.join(parent, '.package-notices-'))
    try {
      for (const asset of assets) {
        fs.writeFileSync(path.join(temporary, asset.name), asset.bytes, { flag: 'wx' })
        exact(read(temporary, asset.name), asset)
      }
      fs.renameSync(temporary, target)
    } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true }) }
  }
  return { applicable: true, resources: assets.map(({ bytes, ...entry }) => entry) }
}
function packedSupplements(readPacked, bindings) {
  const { catalog, assets } = sourceAssets()
  const applicable = bindings.filter(row => catalog.packages.some(entry => entry.name === row.name))
  if (!applicable.length) return []
  exact(readPacked(STAGED + '/catalog.json'), assets[0])
  return applicable.map(binding => {
    const entry = catalog.packages.find(entry => entry.name === binding.name)
    const bytes = readPacked(binding.location + '/package.json')
    exact(bytes, entry.packagedManifest)
    if (binding.status !== 'bound' || binding.version !== entry.version || binding.sourceIdentity?.resolved !== entry.resolved ||
        binding.sourceIdentity?.integrity !== entry.integrity || binding.manifestSha256 !== sha(bytes) ||
        !binding.sourceCandidates.some(candidate => binding.lockLocations.includes(candidate.location) &&
          candidate.sourceManifest.size === entry.packageManifestSource.size && candidate.sourceManifest.sha256 === entry.packageManifestSource.sha256 &&
          candidate.exactExpectedManifestMatch)) throw new Error('Package notice actual source binding differs')
    const name = STAGED + '/' + entry.notice.name
    const notice = readPacked(name)
    exact(notice, entry.notice)
    return { packageLocation: binding.location, packageName: entry.name, packageVersion: entry.version,
      scope: entry.scope, legalCompliance: entry.legalCompliance, manifestDeclaredLicense: entry.declaredLicense,
      reviewedSourceLicense: entry.reviewedSourceLicense ? { identifier: entry.reviewedSourceLicense, basis: 'exact-publisher-license-resource', resourceName: name } : null,
      sourceIdentity: binding.sourceIdentity, actualManifest: receipt(binding.location + '/package.json', bytes),
      publishedTarball: entry.publishedTarball, sourceCommit: entry.sourceCommit,
      resources: [{ ...receipt(STAGED + '/catalog.json', readPacked(STAGED + '/catalog.json')), archiveName: ARCHIVED + '/catalog.json' },
        { ...entry.notice, ...receipt(name, notice), archiveName: ARCHIVED + '/' + entry.notice.name }] }
  })
}
function packedArchiveAssets(archive, lock, inventory, root = ROOT) {
  const asar = require('@electron/asar')
  const { collectPackageBindings } = require('./distribution-package-bindings.cjs')
  const entries = asar.listPackage(archive).map(name => name.replace(/\\/g, '/').replace(/^\/+/, ''))
  const packageLocations = entries.filter(name => /^node_modules\/(?:@[^/]+\/[^/]+|[^@/][^/]*)(?:\/node_modules\/(?:@[^/]+\/[^/]+|[^@/][^/]*))*$/.test(name) && asar.statFile(archive, path.normalize(name), false).files)
  const readPacked = (name, limit = 64 * 1024 * 1024) => {
    const stat = asar.statFile(archive, path.normalize(name), false)
    if (stat.link || stat.files || stat.size <= 0 || stat.size > limit) throw new Error('Invalid packed package notice resource')
    const bytes = stat.unpacked ? read(archive + '.unpacked', name) : asar.extractFile(archive, path.normalize(name), false)
    if (bytes.length !== stat.size) throw new Error('Packed package notice size differs')
    return bytes
  }
  const actualBindings = collectPackageBindings({ root, lock, packageLocations, readPacked })
  if (actualBindings.reviewNeeded.length || JSON.stringify(actualBindings) !== JSON.stringify(inventory.actual.packageBindings)) throw new Error('Package notice actual binding evidence differs')
  const supplements = packedSupplements(readPacked, actualBindings.bindings)
  if (JSON.stringify(supplements) !== JSON.stringify(inventory.actual.packageNoticeSupplements || [])) throw new Error('Package notice inventory differs from actual ASAR resources')
  const output = new Map()
  for (const supplement of supplements) for (const entry of supplement.resources) {
    const bytes = readPacked(entry.name)
    exact(bytes, entry)
    if (output.has(entry.archiveName) && sha(output.get(entry.archiveName).bytes) !== sha(bytes)) throw new Error('Conflicting package notice archive resource')
    output.set(entry.archiveName, { name: entry.archiveName, size: entry.size, sha256: entry.sha256, bytes })
  }
  return [...output.values()]
}
module.exports = { sourceAssets, stagePackageNotices, packedSupplements, packedArchiveAssets, STAGED, ARCHIVED, CATALOG_SHA256 }
