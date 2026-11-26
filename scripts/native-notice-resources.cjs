'use strict'

// Fixed npm-package notice supplement, not a native dependency graph or legal audit.
// Runtime paths and original upstream notice bytes must both match before inheritance.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const ROOT = path.resolve(__dirname, '..')
const SOURCE = 'build/native-notices/canvas-0.1.80'
const STAGED = 'out/main/native-notices/canvas-0.1.80'
const ARCHIVED = 'licenses/native/canvas-0.1.80'
const CATALOG_SHA256 = 'fdba69b65e904e9138c18d901b4fd6fc8af1feb4892614ea6405339d71ed86cd'
const LIMIT = 64 * 1024 * 1024
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const receipt = (name, bytes) => ({ name, size: bytes.length, sha256: sha(bytes) })
function noLinks(root, name) {
  if (typeof name !== 'string' || !name || /[\\<>:"|?*\x00-\x1f\x7f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe native notice resource path')
  root = path.resolve(root)
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('Native notice root must be a real directory')
  let current = root
  for (const part of name.split('/')) {
    current = path.join(current, part)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked native notice resource rejected')
  }
  return current
}
function read(root, name) {
  const file = noLinks(root, name)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size <= 0 || stat.size > LIMIT) throw new Error('Invalid native notice resource')
  const bytes = fs.readFileSync(file)
  if (bytes.length !== stat.size) throw new Error('Native notice resource changed while reading')
  return bytes
}
function exact(bytes, expected) {
  if (bytes.length !== expected.size || sha(bytes) !== expected.sha256) throw new Error('Native notice resource differs from fixed upstream bytes')
}
function sourceAssets() {
  const bytes = read(ROOT, `${SOURCE}/catalog.json`)
  if (sha(bytes) !== CATALOG_SHA256) throw new Error('Native notice catalog differs from fixed source')
  const catalog = JSON.parse(bytes)
  const assets = [{ ...receipt('catalog.json', bytes), bytes }]
  for (const entry of catalog.licenses) {
    const original = read(ROOT, `${SOURCE}/${entry.name}`)
    exact(original, entry)
    assets.push({ ...entry, bytes: original })
  }
  return { catalog, assets }
}

// Kept pure so small synthetic tests can exercise binding failures. Production
// callers always supply the immutable catalog loaded by sourceAssets().
function verifyBinding(catalog, lock, manifest, parent, readResource) {
  for (const [location, name, version, integrity, actual] of [
    [catalog.packageLocation, catalog.packageName, catalog.packageVersion, catalog.integrity, manifest],
    [catalog.parentLocation, catalog.parentName, catalog.parentVersion, catalog.parentIntegrity, parent]
  ]) {
    const planned = lock.packages?.[location]
    if (actual?.name !== name || actual.version !== version || actual.license !== catalog.license || planned?.version !== version || planned.integrity !== integrity) throw new Error('Native notice package/parent/lock binding differs')
  }
  const parentNotice = readResource(`${catalog.parentLocation}/LICENSE`)
  exact(parentNotice, catalog.licenses[0])
  return catalog.runtimeResources.map(entry => {
    const name = `${catalog.packageLocation}/${entry.name}`
    const bytes = readResource(name)
    exact(bytes, entry)
    return { ...entry, ...receipt(name, bytes) }
  })
}

function stageNativeNotices(root = ROOT) {
  const { catalog, assets } = sourceAssets()
  const installed = noLinks(root, catalog.packageLocation)
  if (!fs.existsSync(installed)) return { applicable: false }
  const lock = JSON.parse(read(root, 'package-lock.json'))
  const manifestBytes = read(root, `${catalog.packageLocation}/package.json`)
  exact(manifestBytes, catalog.packageManifestSource)
  verifyBinding(catalog, lock, JSON.parse(manifestBytes), JSON.parse(read(root, `${catalog.parentLocation}/package.json`)), name => read(root, name))
  // The normal dist command already ran electron-vite. Never create a fake build.
  read(root, 'out/main/index.js')
  const target = noLinks(root, STAGED)
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isDirectory() || fs.readdirSync(target).sort().join('\n') !== assets.map(entry => entry.name).sort().join('\n')) throw new Error('Existing native notice stage differs')
    for (const asset of assets) exact(read(root, `${STAGED}/${asset.name}`), asset)
    return { applicable: true, resources: assets.map(({ bytes, ...entry }) => entry) }
  }
  const parent = path.dirname(target)
  fs.mkdirSync(parent, { recursive: true })
  noLinks(root, STAGED)
  const temporary = fs.mkdtempSync(path.join(parent, '.canvas-notices-'))
  try {
    for (const asset of assets) {
      fs.writeFileSync(path.join(temporary, asset.name), asset.bytes, { flag: 'wx' })
      exact(read(temporary, asset.name), asset)
    }
    fs.renameSync(temporary, target)
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true })
  }
  return { applicable: true, resources: assets.map(({ bytes, ...entry }) => entry) }
}

function packedSupplement(lock, readPacked, packageLocations) {
  const { catalog, assets } = sourceAssets()
  if (!packageLocations.includes(catalog.packageLocation)) return null
  const manifestBytes = readPacked(`${catalog.packageLocation}/package.json`)
  // Only the exact original or the pinned official builder derivation is valid.
  // Source installation still requires the original upstream manifest above.
  if (manifestBytes.length === catalog.packageManifestSource.size && sha(manifestBytes) === catalog.packageManifestSource.sha256) exact(manifestBytes, catalog.packageManifestSource)
  else exact(manifestBytes, catalog.packagedManifest)
  const manifest = JSON.parse(manifestBytes)
  const parent = JSON.parse(readPacked(`${catalog.parentLocation}/package.json`))
  const runtimeResources = verifyBinding(catalog, lock, manifest, parent, readPacked)
  const resources = assets.map(asset => {
    const name = `${STAGED}/${asset.name}`
    const bytes = readPacked(name)
    exact(bytes, asset)
    const { bytes: ignored, ...source } = asset
    return { ...source, ...receipt(name, bytes), archiveName: `${ARCHIVED}/${asset.name}` }
  })
  return {
    packageLocation: catalog.packageLocation, packageName: catalog.packageName, packageVersion: catalog.packageVersion,
    scope: catalog.scope, inheritedFrom: { location: catalog.parentLocation, name: catalog.parentName, version: catalog.parentVersion,
      resource: { name: `${catalog.parentLocation}/LICENSE`, size: catalog.licenses[0].size, sha256: catalog.licenses[0].sha256 },
      sourceCommit: catalog.parentCommit, sourceUrl: catalog.licenses[0].sourceUrl },
    actualManifest: receipt(`${catalog.packageLocation}/package.json`, manifestBytes),
    manifestBinding: sha(manifestBytes) === catalog.packageManifestSource.sha256 ? 'exact-upstream-source' : 'exact-official-builder-derivation',
    runtimeResources, resources, nativeGraphCoverage: catalog.nativeGraphCoverage
  }
}

function packedArchiveAssets(archive, lock, inventory) {
  const asar = require('@electron/asar')
  const entries = asar.listPackage(archive).map(name => name.replace(/\\/g, '/').replace(/^\/+/, ''))
  const packageLocations = entries.filter(name => /^node_modules\/(?:@[^/]+\/[^/]+|[^@/][^/]*)$/.test(name) && asar.statFile(archive, path.normalize(name), false).files)
  const readPacked = name => {
    const stat = asar.statFile(archive, path.normalize(name), false)
    if (stat.link || stat.files || stat.size <= 0 || stat.size > LIMIT) throw new Error('Invalid packed native notice resource')
    const bytes = stat.unpacked ? read(`${archive}.unpacked`, name) : asar.extractFile(archive, path.normalize(name), false)
    if (bytes.length !== stat.size) throw new Error('Packed native notice size differs')
    return bytes
  }
  const actual = packedSupplement(lock, readPacked, packageLocations)
  if (JSON.stringify(actual ? [actual] : []) !== JSON.stringify(inventory.actual.nativeNoticeSupplements || [])) throw new Error('Native notice inventory differs from actual ASAR resources')
  return actual ? actual.resources.map(entry => ({ name: entry.archiveName, size: entry.size, sha256: entry.sha256, bytes: readPacked(entry.name) })) : []
}

module.exports = { sourceAssets, verifyBinding, stageNativeNotices, packedSupplement, packedArchiveAssets, read, sha, receipt, STAGED, ARCHIVED, CATALOG_SHA256 }
