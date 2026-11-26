'use strict'
// Offline test fixture only. Copies inert upstream bytes; never loads a native addon.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const asar = require('@electron/asar')
const { finished } = require('node:stream/promises')
const { sourceAssets, stageNativeNotices, STAGED } = require('./native-notice-resources.cjs')
const { transformDependencyManifest, TRANSFORMER_PIN } = require('./distribution-package-bindings.cjs')
const { stagePackageNotices, STAGED: PUBLISHER_STAGED } = require('./package-notice-resources.cjs')
const REAL_ROOT = path.resolve(__dirname, '..')
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value))
}
async function installNativeFixture(root, electronDir, stage = true, publisherFixture = false) {
  const absolute = path.resolve(root)
  const relative = path.relative(os.tmpdir(), absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Native fixture is restricted to temporary test directories')
  const { catalog } = sourceAssets()
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')))
  const realLock = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'package-lock.json')))
  lock.packages[catalog.packageLocation] = realLock.packages[catalog.packageLocation]
  lock.packages[catalog.parentLocation] = realLock.packages[catalog.parentLocation]
  lock.packages['node_modules/app-builder-lib'] = realLock.packages['node_modules/app-builder-lib']
  const identity = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
  identity.dependencies = { ...identity.dependencies, [catalog.parentName]: catalog.parentVersion }
  lock.packages[''] = { ...lock.packages[''], ...identity }
  write(path.join(root, 'package.json'), identity)
  write(path.join(root, 'package-lock.json'), lock)
  for (const relative of ['node_modules/app-builder-lib/package.json', TRANSFORMER_PIN.implementation]) write(path.join(root, relative), fs.readFileSync(path.join(REAL_ROOT, relative)))
  const packed = path.join(root, 'native-packed')
  if (publisherFixture) {
    identity.dependencies['png-js'] = realLock.packages['node_modules/png-js'].version
    lock.packages[''] = { ...lock.packages[''], ...identity }
    for (const location of ['node_modules/png-js', 'node_modules/browserify-zlib', 'node_modules/pako']) {
      lock.packages[location] = realLock.packages[location]
      const bytes = fs.readFileSync(path.join(REAL_ROOT, location, 'package.json'))
      write(path.join(root, location, 'package.json'), bytes)
      write(path.join(packed, location, 'package.json'), transformDependencyManifest(bytes))
      if (location !== 'node_modules/png-js') for (const name of fs.readdirSync(path.join(REAL_ROOT, location)).filter(name => /^licen[cs]e/i.test(name))) {
        write(path.join(packed, location, name), fs.readFileSync(path.join(REAL_ROOT, location, name)))
      }
    }
    write(path.join(root, 'package.json'), identity)
    write(path.join(root, 'package-lock.json'), lock)
  }
  for (const relative of [`${catalog.packageLocation}/package.json`, ...catalog.runtimeResources.map(entry => `${catalog.packageLocation}/${entry.name}`), `${catalog.parentLocation}/package.json`, `${catalog.parentLocation}/LICENSE`]) {
    const source = path.join(REAL_ROOT, relative)
    for (const base of [root, packed]) {
      const target = path.join(base, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
    }
  }
  for (const location of [catalog.parentLocation, catalog.packageLocation]) {
    write(path.join(packed, location, 'package.json'), transformDependencyManifest(fs.readFileSync(path.join(root, location, 'package.json'))))
  }
  write(path.join(root, 'out/main/index.js'), '// Synthetic offline build fixture; never executed.\n')
  if (stage) {
    stageNativeNotices(root)
    for (const name of fs.readdirSync(path.join(root, STAGED))) {
      write(path.join(packed, STAGED, name), fs.readFileSync(path.join(root, STAGED, name)))
    }
  }
  if (publisherFixture) {
    stagePackageNotices(root)
    for (const name of fs.readdirSync(path.join(root, PUBLISHER_STAGED))) write(path.join(packed, PUBLISHER_STAGED, name), fs.readFileSync(path.join(root, PUBLISHER_STAGED, name)))
  }
  write(path.join(packed, 'package.json'), fs.readFileSync(path.join(root, 'package.json')))
  write(path.join(packed, 'LICENSE'), fs.readFileSync(path.join(root, 'LICENSE')))
  const archive = path.join(electronDir, 'resources/app.asar')
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  const result = await asar.createPackageWithOptions(packed, archive, { unpack: '**/*.node' })
  if (result?.once) await finished(result)
  return { root, asarPath: archive, electronDir, catalog, packed }
}
module.exports = { installNativeFixture, write }
