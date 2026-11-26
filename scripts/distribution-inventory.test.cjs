'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { finished } = require('node:stream/promises')
const { test } = require('node:test')
const asar = require('@electron/asar')
const { collectInventory, parseArgs, writeNew, main } = require('./distribution-inventory.cjs')
const { TRANSFORMER_PIN } = require('./distribution-package-bindings.cjs')
const REPO = path.resolve(__dirname, '..')
const SRI = `sha512-${Buffer.alloc(64, 7).toString('base64')}`

function writeFixture(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
async function fixture(options, task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-inventory-'))
  const identity = { name: 'deepwriter', version: '1.3.0', license: 'MIT' }
  const packageLocation = 'node_modules/nested-runtime'
  try {
    writeFixture(path.join(root, 'package.json'), { ...identity, dependencies: { 'nested-runtime': '1.0.0' } })
    writeFixture(path.join(root, 'LICENSE'), 'Synthetic project notice, not a legal fixture license.\n')
    writeFixture(path.join(root, 'package-lock.json'), { name: identity.name, version: identity.version, packages: {
      '': identity,
      [packageLocation]: { version: '1.0.0', license: 'MIT', resolved: 'https://registry.npmjs.org/nested-runtime/-/nested-runtime-1.0.0.tgz', integrity: SRI },
      'node_modules/other-platform-optional': { version: '1.0.0', optional: true, license: 'MIT' },
      'node_modules/build-only': { version: '2.0.0', dev: true, license: 'MIT' }
    } })
    const packedRoot = path.join(root, 'packed')
    writeFixture(path.join(packedRoot, 'package.json'), { ...identity, dependencies: { 'nested-runtime': '1.0.0' }, version: options.identityVersion || identity.version, license: options.packedProjectLicense || identity.license })
    if (!options.missingManifest) writeFixture(path.join(packedRoot, packageLocation, 'package.json'), {
      name: 'nested-runtime', version: options.packedVersion || '1.0.0', ...(options.unknownLicense ? {} : { license: 'MIT' })
    })
    if (!options.missingPackageNotice) writeFixture(path.join(packedRoot, packageLocation, 'LICENSE'), 'Synthetic third-party notice: 中文; retain these exact bytes.\n')
    if (options.nestedScoped) {
      const lockPath = path.join(root, 'package-lock.json')
      const lock = JSON.parse(fs.readFileSync(lockPath))
      for (const location of ['node_modules/@vendor/outer', `${packageLocation}/node_modules/@vendor/inner`]) {
        const name = location.slice(location.lastIndexOf('node_modules/') + 13)
        lock.packages[location] = { version: '1.0.0', license: 'MIT', resolved: `https://registry.npmjs.org/${name}/-/fixture-1.0.0.tgz`, integrity: SRI }
        writeFixture(path.join(packedRoot, location, 'package.json'), { name, version: '1.0.0', license: 'MIT' })
        writeFixture(path.join(packedRoot, location, 'LICENSE'), 'Synthetic scoped notice.\n')
      }
      const dependencies = { 'nested-runtime': '1.0.0', '@vendor/outer': '1.0.0' }
      writeFixture(path.join(root, 'package.json'), { ...identity, dependencies })
      writeFixture(path.join(packedRoot, 'package.json'), { ...identity, dependencies })
      lock.packages[packageLocation].dependencies = { '@vendor/inner': '1.0.0' }
      writeFixture(path.join(packedRoot, packageLocation, 'package.json'), { name: 'nested-runtime', version: '1.0.0', license: 'MIT', dependencies: lock.packages[packageLocation].dependencies })
      writeFixture(lockPath, lock)
    }
    // Actual source manifests and declared consumption edges, not a lock-only waiver.
    const fixtureLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')))
    const sourceIdentity = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
    fixtureLock.packages[''] = { ...identity, dependencies: sourceIdentity.dependencies }
    fixtureLock.packages['node_modules/app-builder-lib'] = { ...JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'))).packages['node_modules/app-builder-lib'], dev: true }
    for (const relative of ['node_modules/app-builder-lib/package.json', TRANSFORMER_PIN.implementation]) {
      writeFixture(path.join(root, relative), fs.readFileSync(path.join(REPO, relative)).toString())
    }
    for (const [location, locked] of Object.entries(fixtureLock.packages)) {
      if (location === 'node_modules/app-builder-lib' || !location || !locked.resolved) continue
      const name = location.slice(location.lastIndexOf('node_modules/') + 13)
      writeFixture(path.join(root, location, 'package.json'), { name, version: locked.version, license: 'MIT', ...(locked.dependencies ? { dependencies: locked.dependencies } : {}) })
    }
    writeFixture(path.join(root, 'package-lock.json'), fixtureLock)
    const electronDir = path.join(root, 'dist', 'win-unpacked')
    const archive = path.join(electronDir, 'resources', 'app.asar')
    fs.mkdirSync(path.dirname(archive), { recursive: true })
    if (!options.missingElectron) writeFixture(path.join(electronDir, options.packedElectron ? 'LICENSE.electron.txt' : 'LICENSE'), 'Synthetic Electron notice.\n')
    if (options.duplicateElectron) writeFixture(path.join(electronDir, 'LICENSE.electron.txt'), 'Synthetic duplicate notice.\n')
    if (!options.missingChromium) writeFixture(path.join(electronDir, 'LICENSES.chromium.html'), '<html>Synthetic Chromium notice.</html>\n')
    const writer = await asar.createPackage(packedRoot, archive)
    if (writer?.once) await finished(writer)
    if (options.linkedUnpacked) {
      const unpackedWriter = await asar.createPackageWithOptions(packedRoot, archive, { unpack: '**/LICENSE' })
      if (unpackedWriter?.once) await finished(unpackedWriter)
      const saved = path.join(root, 'saved-unpacked')
      fs.renameSync(`${archive}.unpacked`, saved)
      fs.symlinkSync(saved, `${archive}.unpacked`, process.platform === 'win32' ? 'junction' : 'dir')
    }
    await task({ root, asarPath: archive, packageLocation, electronDir })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('lock plan is not promoted to shipped evidence; optional platform omissions are informational', async () => {
  await fixture({}, ({ root }) => {
    const { report } = collectInventory({ root })
    assert.equal(report.actual, null)
    assert.equal(report.lockPlan.productionCount, 2)
    assert.equal(report.lockPlan.developmentCount, 2) // inert pinned builder implementation now included
    assert.deepEqual(report.reviewNeeded.map(item => item.code), ['ACTUAL_ASAR_NOT_PROVIDED'])
    assert.equal(report.inventoryComplete, false)
    assert.equal(report.legalCompliance, 'not-assessed')
  })
})
test('actual ASAR manifests, exact resource hashes and Electron/Chromium notices are recorded', async () => {
  await fixture({}, options => {
    const { report, notices } = collectInventory(options)
    assert.equal(report.inventoryComplete, true, JSON.stringify({ review: report.reviewNeeded, actual: report.actual.packages }))
    assert.equal(report.actual.packages.length, 1)
    assert.equal(report.actual.runtimeNotices.length, 2)
    assert.equal(report.actual.packages[0].license, 'MIT')
    const bytes = asar.extractFile(options.asarPath, path.normalize(`${options.packageLocation}/LICENSE`))
    assert.equal(report.actual.packages[0].notices[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'))
    assert.ok(notices.includes(bytes.toString('utf8')))
    assert.ok(notices.includes('Synthetic Chromium notice'))
    assert.equal(report.notices.size, Buffer.byteLength(notices, 'utf8'))
    assert.equal(report.notices.sha256, crypto.createHash('sha256').update(notices, 'utf8').digest('hex'))
    assert.equal(report.releaseReadiness, 'not-assessed')
  })
})
test('packaged license unknown is a review blocker even when the lock plan declares MIT', async () => {
  await fixture({ unknownLicense: true }, options => {
    const { report } = collectInventory(options)
    assert.equal(report.inventoryComplete, false)
    assert.ok(report.reviewNeeded.some(item => item.code === 'PACKAGED_LICENSE_UNKNOWN'))
  })
})
test('missing actual third-party notice is not satisfied by metadata', async () => {
  await fixture({ missingPackageNotice: true }, options => {
    const { report } = collectInventory(options)
    assert.ok(report.reviewNeeded.some(item => item.code === 'PACKAGED_NOTICE_MISSING'))
  })
})
test('package directories with no manifest cannot disappear from the actual inventory', async () => {
  await fixture({ missingManifest: true }, options => {
    const { report } = collectInventory(options)
    assert.equal(report.actual.packages.length, 1)
    assert.ok(report.reviewNeeded.some(item => item.code === 'PACKAGED_METADATA_UNREADABLE'))
  })
})
test('missing actual Chromium notices cannot be satisfied by the Electron dependency manifest', async () => {
  await fixture({ missingChromium: true }, options => {
    const { report } = collectInventory(options)
    assert.ok(report.reviewNeeded.some(item => item.code === 'ELECTRON_NOTICE_MISSING' && item.subject === 'LICENSES.chromium.html'))
  })
})
test('normal builder-renamed Electron license records the exact source and actual filenames', async () => {
  await fixture({ packedElectron: true }, options => {
    const { report } = collectInventory(options)
    assert.equal(report.inventoryComplete, true, JSON.stringify(report.reviewNeeded))
    const license = report.actual.runtimeNotices.find(entry => entry.sourceName === 'LICENSE')
    assert.equal(license.name, 'LICENSE.electron.txt')
    assert.equal(license.actualName, license.name)
    assert.equal(license.layout, 'electron-builder-packed')
  })
})
test('missing or duplicated Electron license stays red rather than selecting any LICENSE-like file', async () => {
  for (const flags of [{ missingElectron: true }, { duplicateElectron: true }]) await fixture(flags, options => {
    const { report } = collectInventory(options)
    assert.equal(report.inventoryComplete, false)
    assert.ok(report.reviewNeeded.some(entry => entry.code === 'ELECTRON_NOTICE_MISSING'))
    if (flags.duplicateElectron) assert.ok(report.reviewNeeded.some(entry => entry.code === 'ELECTRON_NOTICE_AMBIGUOUS'))
  })
})
test('packaged runtime version drift is a review blocker', async () => {
  await fixture({ packedVersion: '9.9.9' }, options => {
    assert.ok(collectInventory(options).report.reviewNeeded.some(item => item.code === 'PACKAGED_BINDING_SOURCE_NOT_PRODUCTION' || item.code === 'PACKAGED_BINDING_MANIFEST_DRIFT'))
  })
})
test('packaged application version drift is a review blocker', async () => {
  await fixture({ identityVersion: '1.2.6' }, options => {
    assert.ok(collectInventory(options).report.reviewNeeded.some(item => item.code === 'PACKAGED_IDENTITY_DRIFT'))
  })
})
test('packaged project license drift cannot borrow the current source decision', async () => {
  await fixture({ packedProjectLicense: 'unknown' }, options => {
    assert.ok(collectInventory(options).report.reviewNeeded.some(item => item.code === 'PACKAGED_PROJECT_LICENSE_DRIFT'))
  })
})
test('scoped and nested package manifests are inventoried without treating namespace folders as packages', async () => {
  await fixture({ nestedScoped: true }, options => {
    const { report } = collectInventory(options)
    assert.equal(report.actual.packages.length, 3)
    assert.deepEqual(report.reviewNeeded, [])
  })
})
test('linked unpacked resource roots are rejected before reading their resources', async () => {
  await fixture({ linkedUnpacked: true }, options => {
    assert.ok(collectInventory(options).report.reviewNeeded.some(item => item.code === 'PACKAGED_METADATA_UNREADABLE'))
  })
})
test('unsafe lock paths are rejected before reading any external manifest', async () => {
  await fixture({}, ({ root }) => {
    const lockPath = path.join(root, 'package-lock.json')
    const lock = JSON.parse(fs.readFileSync(lockPath))
    lock.packages['node_modules/../../outside'] = { version: '0.0.0' }
    writeFixture(lockPath, lock)
    assert.throws(() => collectInventory({ root }), /Invalid locked package path/)
  })
})
test('reports cannot overwrite receipts or escape the project root', async () => {
  await fixture({}, ({ root }) => {
    writeNew(root, 'evidence/report.json', '{}')
    assert.throws(() => writeNew(root, 'evidence/report.json', 'replacement'), /EEXIST/)
    assert.throws(() => writeNew(root, '../outside.json', '{}'), /escapes/)
    assert.equal(fs.readFileSync(path.join(root, 'evidence/report.json'), 'utf8'), '{}')
  })
})
test('linked output parents are rejected', async () => {
  await fixture({}, ({ root }) => {
    const target = path.join(root, 'real-output')
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(root, 'linked-output'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => writeNew(root, 'linked-output/report.json', '{}'), /Linked resource/)
  })
})
test('arguments reject unsupported/duplicate options', () => {
  assert.throws(() => parseArgs(['--unknown']), /Unknown/)
  assert.throws(() => parseArgs(['--asar']), /requires/)
  assert.throws(() => parseArgs(['--report=a', '--report=b']), /Duplicate/)
})
test('plan-only command returns an incomplete evidence status instead of a pass', async () => {
  await fixture({}, ({ root }) => {
    const output = []
    const previous = console.log
    console.log = line => output.push(line)
    try { assert.equal(main(['--root', root]), 1) } finally { console.log = previous }
    assert.ok(output.some(line => line.includes('ACTUAL_ASAR_NOT_PROVIDED')))
    assert.ok(output.some(line => line.includes('not assessed')))
  })
})
