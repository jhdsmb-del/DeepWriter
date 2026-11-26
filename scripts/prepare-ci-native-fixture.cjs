'use strict'
// Install the exact Windows payload as inert test data on non-Windows CI.
// npm ci correctly omits foreign optional packages; do not change that policy.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const tar = require('tar')
const { sourceAssets, verifyBinding } = require('./native-notice-resources.cjs')
function prepareNativeFixture(archive, root = path.resolve(__dirname, '..')) {
  const { catalog } = sourceAssets()
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')))
  const locked = lock.packages[catalog.packageLocation]
  if (locked?.integrity !== catalog.integrity || locked.version !== catalog.packageVersion) throw Error('Native fixture lock differs from reviewed catalog')
  const bytes = fs.readFileSync(archive)
  const actual = 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64')
  if (actual !== catalog.integrity) throw Error('Native fixture archive integrity mismatch')
  const target = path.join(root, catalog.packageLocation)
  if (fs.existsSync(target)) throw Error('Native fixture destination already exists')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = fs.mkdtempSync(path.join(path.dirname(target), '.native-fixture-'))
  try {
    tar.x({ file: archive, cwd: temporary, strip: 1, sync: true, filter: (name, entry) => {
      if (!name.startsWith('package/') || name.split('/').includes('..') || !['File', 'Directory'].includes(entry.type)) throw Error('Unsafe native fixture entry')
      return true
    } })
    const manifest = fs.readFileSync(path.join(temporary, 'package.json'))
    if (manifest.length !== catalog.packageManifestSource.size || crypto.createHash('sha256').update(manifest).digest('hex') !== catalog.packageManifestSource.sha256) throw Error('Native fixture manifest differs')
    verifyBinding(catalog, lock, JSON.parse(manifest), JSON.parse(fs.readFileSync(path.join(root, catalog.parentLocation, 'package.json'))), name => fs.readFileSync(name.startsWith(catalog.packageLocation + '/') ? path.join(temporary, name.slice(catalog.packageLocation.length + 1)) : path.join(root, name)))
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  return target
}
if (require.main === module) {
  try { prepareNativeFixture(path.resolve(process.argv[2])); console.log('Prepared exact inert Windows native fixture') }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { prepareNativeFixture }
