'use strict'

// Synthetic fixtures validate engineering gates, not a real CLI/runtime release.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { test } = require('node:test')
const { packageCli, collectCliPackage, parseArgs } = require('./package-cli.cjs')
const SOURCE = 'a'.repeat(40)
const VERSION = '1.3.1'
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data))
}
function receipt(root, name) { const bytes = fs.readFileSync(path.join(root, name)); return { name, size: bytes.length, sha256: sha(bytes) } }
function edit(file, task) { const json = JSON.parse(fs.readFileSync(file)); task(json); write(file, json) }
async function fixture(task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-cli-package-test-'))
  try {
    write(path.join(root, 'package.json'), { name: 'deepwriter', version: VERSION, license: 'MIT' })
    write(path.join(root, 'package-lock.json'), { version: VERSION, packages: { '': { version: VERSION }, 'node_modules/example': { version: '1.0.0', license: 'MIT' }, 'node_modules/not-shipped': { version: '2.0.0', license: 'MIT' } } })
    write(path.join(root, 'LICENSE'), 'Synthetic DeepWriter license fixture.\n')
    write(path.join(root, 'src/cli/main.ts'), 'import { value } from "example"; console.log(value)\n')
    write(path.join(root, 'node_modules/example/package.json'), { name: 'example', version: '1.0.0', license: 'MIT' })
    write(path.join(root, 'node_modules/example/index.js'), 'exports.value=1\n')
    write(path.join(root, 'node_modules/example/LICENSE'), 'Synthetic dependency license fixture.\n')
    write(path.join(root, 'node_modules/not-shipped/package.json'), { name: 'not-shipped', version: '2.0.0', license: 'MIT' })
    write(path.join(root, 'node_modules/not-shipped/index.js'), 'exports.value=2\n')
    const bundle = path.join(root, 'out/cli-build/deepwriter.cjs')
    const metafile = path.join(root, 'out/cli-build/cli-metafile.json')
    const buildReceipt = path.join(root, 'out/cli-build/cli-build.json')
    write(bundle, '"use strict"; require("node:fs"); console.log("synthetic bundle")\n')
    const inputNames = ['src/cli/main.ts', 'node_modules/example/index.js', 'node_modules/not-shipped/index.js']
    write(metafile, { inputs: Object.fromEntries(inputNames.map(name => [name, { bytes: receipt(root, name).size, imports: [] }])), outputs: { 'out/cli-build/deepwriter.cjs': { bytes: receipt(root, 'out/cli-build/deepwriter.cjs').size, entryPoint: 'src/cli/main.ts', inputs: { 'src/cli/main.ts': { bytesInOutput: 30 }, 'node_modules/example/index.js': { bytesInOutput: 10 }, 'node_modules/not-shipped/index.js': { bytesInOutput: 0 } }, imports: [{ path: 'node:fs', kind: 'require-call', external: true }] } } })
    write(buildReceipt, { schemaVersion: 1, application: { name: 'deepwriter-cli', version: VERSION }, sourceCommit: SOURCE, sourceDirty: false, source: { packageSha256: receipt(root, 'package.json').sha256, lockSha256: receipt(root, 'package-lock.json').sha256 }, bundle: receipt(root, 'out/cli-build/deepwriter.cjs'), metafile: receipt(root, 'out/cli-build/cli-metafile.json'), inputs: inputNames.map(name => receipt(root, name)), warnings: [] })
    const runtime = Buffer.alloc(1024 * 1024)
    runtime.write('MZ'); runtime.writeUInt32LE(128, 60); runtime.write('PE\0\0', 128); runtime.writeUInt16LE(0x8664, 132)
    const nodeExe = path.join(root, 'runtime-source/node.exe')
    const nodeLicense = path.join(root, 'runtime-source/LICENSE')
    write(nodeExe, runtime)
    write(nodeLicense, 'Synthetic full Node LICENSE fixture; not a real notice.\n')
    write(`${nodeLicense}.source.json`, { version: '24.19.0', sourceUrl: 'https://raw.githubusercontent.com/nodejs/node/v24.19.0/LICENSE', size: receipt(root, 'runtime-source/LICENSE').size, sha256: receipt(root, 'runtime-source/LICENSE').sha256, retrievedAt: '2026-10-03T00:00:00.000Z' })
    const ports = { nodeSha256: sha(runtime), nodeLicenseSha256: receipt(root, 'runtime-source/LICENSE').sha256, probeRuntime: () => ({ node: '24.19.0', platform: 'win32', arch: 'x64' }), sourceState: () => ({ sourceCommit: SOURCE, sourceDirty: false }) }
    const options = { root, version: VERSION, sourceCommit: SOURCE, bundle, metafile, buildReceipt, nodeExe, nodeLicense, output: path.join(root, 'out/cli-package') }
    await task(options, ports)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
function rebindBuild(options) {
  edit(options.buildReceipt, json => { json.bundle = receipt(options.root, path.relative(options.root, options.bundle).replaceAll('\\', '/')); json.metafile = receipt(options.root, path.relative(options.root, options.metafile).replaceAll('\\', '/')); json.inputs = Object.keys(JSON.parse(fs.readFileSync(options.metafile)).inputs).map(name => receipt(options.root, name)) })
}

test('explicit actual bundle dependencies form complete inventory without copying node_modules', async () => fixture(async (options, ports) => {
  const result = await packageCli(options, ports)
  assert.equal(result.complete, true)
  const manifest = JSON.parse(fs.readFileSync(path.join(options.output, 'cli-release.json')))
  const inventory = JSON.parse(fs.readFileSync(path.join(options.output, manifest.inventory)))
  assert.equal(manifest.version, VERSION)
  assert.equal(manifest.sourceCommit, SOURCE)
  assert.equal(manifest.runtime.version, '24.19.0')
  assert.equal(inventory.inventoryComplete, true)
  assert.equal(inventory.legalCompliance, 'not-assessed')
  assert.deepEqual(inventory.dependencies.map(item => item.name), ['example'])
  assert.equal(fs.existsSync(path.join(options.output, 'node_modules')), false)
  assert.equal(fs.existsSync(path.join(options.output, 'runtime/node.exe')), true)
  assert.deepEqual(fs.readFileSync(path.join(options.output, 'runtime/LICENSE')), fs.readFileSync(options.nodeLicense))
  assert.equal(fs.readFileSync(path.join(options.output, 'deepwriter.cmd'), 'utf8').includes('"%~dp0runtime\\node.exe" "%~dp0deepwriter.cjs" %*'), true)
  for (const item of manifest.files) assert.deepEqual(receipt(options.output, item.name), item)
  for (const item of inventory.files) assert.deepEqual(receipt(options.output, item.name), item)
  assert.ok(fs.readFileSync(path.join(options.output, 'THIRD_PARTY_NOTICES.txt'), 'utf8').includes('Synthetic dependency license'))
}))
test('unknown license is diagnostic and never produces a complete release declaration', async () => fixture(async (options, ports) => {
  edit(path.join(options.root, 'node_modules/example/package.json'), json => { json.license = 'UNLICENSED' })
  const result = await packageCli(options, ports)
  assert.equal(result.complete, false)
  assert.equal(result.inventory.inventoryComplete, false)
  assert.ok(result.inventory.reviewNeeded.some(item => item.code === 'BUNDLE_LICENSE_UNKNOWN'))
  assert.equal(fs.existsSync(path.join(options.output, 'cli-release.json')), false)
}))
test('missing dependency notice resources cannot borrow lockfile license metadata', async () => fixture(async (options, ports) => {
  fs.unlinkSync(path.join(options.root, 'node_modules/example/LICENSE'))
  const result = await collectCliPackage(options, ports)
  assert.ok(result.inventory.reviewNeeded.some(item => item.code === 'BUNDLE_NOTICE_MISSING'))
  assert.equal(result.complete, false)
}))

function bindNoticeFixture(options, name) {
  const sourceRoot = path.resolve(__dirname, '..'), actual = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'node_modules', name, 'package.json')))
  write(path.join(options.root, 'node_modules/example/package.json'), actual)
  const locked = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package-lock.json'))).packages['node_modules/' + name]
  edit(path.join(options.root, 'package-lock.json'), json => { json.packages['node_modules/example'] = locked })
  if (name === 'isarray') {
    fs.unlinkSync(path.join(options.root, 'node_modules/example/LICENSE'))
    fs.copyFileSync(path.join(sourceRoot, 'node_modules/isarray/README.md'), path.join(options.root, 'node_modules/example/README.md'))
  } else if (name === 'dingbat-to-unicode' || name === 'saxes') {
    fs.unlinkSync(path.join(options.root, 'node_modules/example/LICENSE'))
    const resourcePath = `resources/cli-notices/${name}/${actual.version}`
    const folder = path.join(options.root, resourcePath)
    fs.mkdirSync(folder, { recursive: true })
    for (const file of ['LICENSE', 'SOURCE.json', 'UPSTREAM.package.json']) fs.copyFileSync(path.join(sourceRoot, resourcePath, file), path.join(folder, file))
  } else if (name === 'pako') {
    fs.copyFileSync(path.join(sourceRoot, 'node_modules/pako/LICENSE'), path.join(options.root, 'node_modules/example/LICENSE'))
    write(path.join(options.root, 'node_modules/example/lib/zlib/deflate.js'), fs.readFileSync(path.join(sourceRoot, 'node_modules/pako/lib/zlib/deflate.js')))
  }
  edit(options.buildReceipt, json => { json.source.lockSha256 = receipt(options.root, 'package-lock.json').sha256 })
}

test('saxes 5.0.1 retains its complete upstream license and existing xmlchars notice without a build or package write', async () => fixture(async (options, ports) => {
  bindNoticeFixture(options, 'saxes')
  const sourceRoot = path.resolve(__dirname, '..')
  const xmlchars = 'node_modules/xmlchars'
  for (const file of ['package.json', 'LICENSE']) write(path.join(options.root, xmlchars, file), fs.readFileSync(path.join(sourceRoot, xmlchars, file)))
  write(path.join(options.root, xmlchars, 'index.js'), 'exports.value=2\n')
  const locked = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package-lock.json'))).packages[xmlchars]
  edit(path.join(options.root, 'package-lock.json'), json => { json.packages[xmlchars] = locked })
  edit(options.metafile, json => {
    json.inputs[`${xmlchars}/index.js`] = { bytes: receipt(options.root, `${xmlchars}/index.js`).size, imports: [] }
    Object.values(json.outputs)[0].inputs[`${xmlchars}/index.js`] = { bytesInOutput: 10 }
  })
  edit(options.buildReceipt, json => { json.source.lockSha256 = receipt(options.root, 'package-lock.json').sha256 })
  rebindBuild(options)
  const result = await collectCliPackage(options, ports)
  assert.equal(result.complete, true, JSON.stringify(result.inventory.reviewNeeded))
  assert.equal(fs.existsSync(options.output), false)
  const dependency = result.inventory.dependencies.find(item => item.name === 'saxes')
  assert.equal(dependency.license, 'ISC')
  assert.deepEqual(dependency.notices.map(item => item.name), ['LICENSE'])
  const notice = dependency.notices[0]
  assert.equal(notice.outputPath, 'third-party/saxes/5.0.1/LICENSE')
  const resource = result.files.find(item => item.name === notice.outputPath)
  assert.deepEqual(resource.bytes, fs.readFileSync(path.join(sourceRoot, 'resources/cli-notices/saxes/5.0.1/LICENSE')))
  const proof = JSON.parse(result.files.find(item => item.name === notice.provenance).bytes)
  assert.equal(proof.sourceCommit, '6ef6a275b20f19cb67808daf0d8f64e06aaf5b0e')
  assert.equal(proof.publishedSource.tag, 'v5.0.1')
  assert.equal(proof.publishedSource.tarballIntegrity, proof.package.integrity)
  assert.equal(JSON.parse(result.files.find(item => item.name === 'third-party/saxes/5.0.1/UPSTREAM.package.json').bytes).version, '5.0.1')
  const text = result.files.find(item => item.name === 'THIRD_PARTY_NOTICES.txt').bytes.toString('utf8')
  assert.ok(text.includes(resource.bytes.toString('utf8')))
  assert.match(text, /Copyright \(c\) Contributors/)
  assert.match(text, /Copyright \(c\) Isaac Z\. Schlueter and Contributors/)
  assert.match(text, /Copyright Mathias Bynens/)
  assert.match(text, /is no longer used, but it can/)
  const transitive = result.inventory.dependencies.find(item => item.name === 'xmlchars')
  assert.equal(transitive.version, '2.2.0'); assert.equal(transitive.license, 'MIT')
  assert.deepEqual(transitive.notices.map(item => item.name), ['LICENSE'])
  assert.ok(text.includes(fs.readFileSync(path.join(sourceRoot, xmlchars, 'LICENSE'), 'utf8')))
}))

test('saxes upstream notices cannot be reused for drifted identity, integrity, bytes or provenance', async () => {
  for (const mutation of ['version', 'integrity', 'notice', 'upstream-manifest', 'source-url', 'source-commit', 'manifest-source-url', 'missing-notice']) await fixture(async (options, ports) => {
    bindNoticeFixture(options, 'saxes')
    const folder = path.join(options.root, 'resources/cli-notices/saxes/5.0.1')
    if (mutation === 'version') edit(path.join(options.root, 'node_modules/example/package.json'), json => { json.version = '5.0.2' })
    if (mutation === 'integrity') {
      edit(path.join(options.root, 'package-lock.json'), json => { json.packages['node_modules/example'].integrity = 'sha512-not-the-reviewed-tarball' })
      edit(options.buildReceipt, json => { json.source.lockSha256 = receipt(options.root, 'package-lock.json').sha256 })
    }
    if (mutation === 'notice') fs.appendFileSync(path.join(folder, 'LICENSE'), '\nchanged')
    if (mutation === 'upstream-manifest') edit(path.join(folder, 'UPSTREAM.package.json'), json => { json.version = '5.0.2' })
    if (mutation === 'source-url') edit(path.join(folder, 'SOURCE.json'), json => { json.sourceUrl = 'https://example.invalid/LICENSE' })
    if (mutation === 'source-commit') edit(path.join(folder, 'SOURCE.json'), json => { json.sourceCommit = 'f'.repeat(40) })
    if (mutation === 'manifest-source-url') edit(path.join(folder, 'SOURCE.json'), json => { json.upstreamManifest.sourceUrl = 'https://example.invalid/package.json' })
    if (mutation === 'missing-notice') fs.unlinkSync(path.join(folder, 'LICENSE'))
    const result = await collectCliPackage(options, ports)
    assert.equal(result.complete, false, mutation)
    assert.equal(result.files.some(file => file.name.startsWith('third-party/saxes/')), false, mutation)
    assert.ok(result.inventory.reviewNeeded.some(item => item.code === (mutation === 'version' || mutation === 'integrity' ? 'BUNDLE_NOTICE_BINDING_MISMATCH' : 'BUNDLE_NOTICE_RESOURCE_INVALID')), mutation)
    assert.ok(result.inventory.reviewNeeded.some(item => item.code === 'BUNDLE_NOTICE_MISSING'), mutation)
  })
})

test('saxes upstream notice support preserves the existing dingbat resource contract', async () => fixture(async (options, ports) => {
  bindNoticeFixture(options, 'dingbat-to-unicode')
  const result = await collectCliPackage(options, ports)
  assert.equal(result.complete, true, JSON.stringify(result.inventory.reviewNeeded))
  const notice = result.inventory.dependencies[0].notices[0]
  assert.equal(notice.sourceUrl, 'https://raw.githubusercontent.com/mwilliamson/dingbat-to-unicode/a89b69198c2dd030b097cbf44b4eb7dd8b85722d/js/LICENSE')
  assert.equal(fs.existsSync(options.output), false)
}))

test('exact isarray README and upstream dingbat copyright/license resources actually ship with provenance', async () => {
  for (const name of ['isarray', 'dingbat-to-unicode']) await fixture(async (options, ports) => {
    bindNoticeFixture(options, name)
    const result = await packageCli(options, ports)
    assert.equal(result.complete, true, JSON.stringify(result.inventory.reviewNeeded))
    const dependency = result.inventory.dependencies[0], notice = dependency.notices[0]
    assert.equal(dependency.name, name)
    assert.equal(notice.outputPath.startsWith(`third-party/${name}/${dependency.version}/`), true)
    assert.deepEqual(receipt(options.output, notice.outputPath), { name: notice.outputPath, size: notice.size, sha256: notice.sha256 })
    const source = JSON.parse(fs.readFileSync(path.join(options.output, notice.provenance)))
    assert.equal(source.package.name, name); assert.equal(source.package.version, dependency.version)
    const combined = fs.readFileSync(path.join(options.output, 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    assert.ok(combined.includes(fs.readFileSync(path.join(options.output, notice.outputPath), 'utf8')))
    assert.ok(combined.includes(notice.sourceUrl))
    if (name === 'dingbat-to-unicode') {
      assert.match(combined, /Copyright \(c\) 2021, Michael Williamson/)
      assert.equal(JSON.parse(fs.readFileSync(path.join(options.output, 'third-party/dingbat-to-unicode/1.0.1/UPSTREAM.package.json'))).version, '1.0.1')
      assert.match(source.scope, /published 1\.0\.1 tarball.*omit/)
    } else assert.match(combined, /Copyright \(c\) 2013 Julian Gruber/)
  })
})

test('version, lock integrity, changed README and changed upstream bytes cannot reuse a reviewed notice', async () => {
  for (const mutation of ['version', 'integrity', 'readme']) await fixture(async (options, ports) => {
    bindNoticeFixture(options, 'isarray')
    if (mutation === 'version') edit(path.join(options.root, 'node_modules/example/package.json'), json => { json.version = '1.0.1' })
    if (mutation === 'integrity') {
      edit(path.join(options.root, 'package-lock.json'), json => { json.packages['node_modules/example'].integrity = 'sha512-not-the-reviewed-tarball' })
      edit(options.buildReceipt, json => { json.source.lockSha256 = receipt(options.root, 'package-lock.json').sha256 })
    }
    if (mutation === 'readme') fs.appendFileSync(path.join(options.root, 'node_modules/example/README.md'), '\nchanged')
    const result = await collectCliPackage(options, ports)
    assert.equal(result.complete, false)
    assert.equal(result.files.some(file => file.name.startsWith('third-party/isarray/')), false)
    assert.ok(result.inventory.reviewNeeded.some(item => item.code.startsWith('BUNDLE_NOTICE_')))
  })
  await fixture(async (options, ports) => {
    bindNoticeFixture(options, 'dingbat-to-unicode')
    fs.appendFileSync(path.join(options.root, 'resources/cli-notices/dingbat-to-unicode/1.0.1/LICENSE'), '\nchanged')
    const result = await collectCliPackage(options, ports)
    assert.equal(result.complete, false); assert.ok(result.inventory.reviewNeeded.some(item => item.code === 'BUNDLE_NOTICE_RESOURCE_INVALID'))
  })
})

test('AND/OR license expressions retain meaning and pako includes its separate original Zlib notice', async () => fixture(async (options, ports) => {
  bindNoticeFixture(options, 'pako')
  const result = await packageCli(options, ports)
  assert.equal(result.complete, true, JSON.stringify(result.inventory.reviewNeeded))
  assert.equal(result.inventory.dependencies[0].license, '(MIT AND Zlib)')
  assert.deepEqual(result.inventory.dependencies[0].notices.map(item => item.name), ['LICENSE', 'ZLIB-NOTICE.txt'])
  const text = fs.readFileSync(path.join(options.output, 'THIRD_PARTY_NOTICES.txt'), 'utf8')
  assert.match(text, /Jean-loup Gailly and Mark Adler/); assert.match(text, /notice may not be removed or altered/)
  assert.ok(text.includes('Permission is hereby granted, free of charge'))
}))

test('a failed nested notice copy removes only its reserved output and all newly created parents', async () => fixture(async (options, ports) => {
  bindNoticeFixture(options, 'pako')
  const writeFileSync = fs.writeFileSync
  try {
    fs.writeFileSync = function (file, ...args) {
      if (file === path.join(options.output, 'third-party/pako/1.0.11/ZLIB-NOTICE.txt')) throw new Error('synthetic notice-copy failure')
      return writeFileSync.call(this, file, ...args)
    }
    await assert.rejects(packageCli(options, ports), /synthetic notice-copy failure/)
    assert.equal(fs.existsSync(options.output), false)
    assert.equal(fs.existsSync(options.bundle), true)
  } finally { fs.writeFileSync = writeFileSync }
}))

test('license arrays stay explicit unknown gates, while strings and legacy type objects are not reinterpreted', async () => {
  for (const [declaration, expected] of [[{ type: ' MIT ' }, 'MIT'], ['(MIT OR GPL-3.0-or-later)', '(MIT OR GPL-3.0-or-later)'], [[{ type: 'MIT' }, { type: 'GPL-3.0' }], 'unknown'], [{ type: '  ' }, 'unknown'], [[], 'unknown']]) await fixture(async (options, ports) => {
    edit(path.join(options.root, 'node_modules/example/package.json'), json => { json.license = declaration })
    const result = await collectCliPackage(options, ports), dependency = result.inventory.dependencies[0]
    assert.equal(dependency.license, expected); assert.deepEqual(dependency.licenseDeclaration, declaration)
    assert.equal(result.inventory.reviewNeeded.some(item => item.code === 'BUNDLE_LICENSE_UNKNOWN'), expected === 'unknown')
  })
})
test('runtime license must match the original versioned official resource receipt', async () => fixture(async (options, ports) => {
  fs.appendFileSync(options.nodeLicense, 'changed')
  await assert.rejects(collectCliPackage(options, ports), /Node license/)
}))
test('npm license or a made-up source URL cannot satisfy Node runtime notices', async () => fixture(async (options, ports) => {
  edit(`${options.nodeLicense}.source.json`, json => { json.sourceUrl = 'https://registry.npmjs.org/npm/LICENSE' })
  await assert.rejects(collectCliPackage(options, ports), /Node license/)
}))
test('runtime identity and PE architecture are verified without executing the CLI', async () => fixture(async (options, ports) => {
  await assert.rejects(collectCliPackage(options, { ...ports, probeRuntime: () => ({ node: '24.19.0', platform: 'win32', arch: 'arm64' }) }), /Node runtime identity/)
  const wrong = Buffer.from(fs.readFileSync(options.nodeExe)); wrong.writeUInt16LE(0xaa64, 132); write(options.nodeExe, wrong)
  await assert.rejects(collectCliPackage(options, { ...ports, nodeSha256: sha(wrong) }), /Windows x64/)
}))
test('stale bundle, metafile and source input bytes are rejected', async () => fixture(async (options, ports) => {
  const originalBundle = fs.readFileSync(options.bundle)
  write(options.bundle, Buffer.from(originalBundle.map(byte => byte === 99 ? 100 : byte)))
  await assert.rejects(collectCliPackage(options, ports), /build receipt/)
  write(options.bundle, originalBundle)
  const originalMetadata = fs.readFileSync(options.metafile)
  fs.appendFileSync(options.metafile, '\n')
  await assert.rejects(collectCliPackage(options, ports), /build receipt/)
  write(options.metafile, originalMetadata)
  fs.appendFileSync(path.join(options.root, 'src/cli/main.ts'), '\n// changed')
  await assert.rejects(collectCliPackage(options, ports), /source input/)
}))
test('a linked dependency directory is rejected without inventorying its target', async () => fixture(async (options, ports) => {
  const dependency = path.join(options.root, 'node_modules/example')
  const saved = path.join(options.root, 'node_modules/saved-example')
  fs.renameSync(dependency, saved)
  fs.symlinkSync(saved, dependency, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(collectCliPackage(options, ports), /Linked/)
}))
test('source commit mismatch and root package version mismatch are rejected', async () => fixture(async (options, ports) => {
  await assert.rejects(collectCliPackage({ ...options, sourceCommit: 'b'.repeat(40) }, ports), /identity/)
  await assert.rejects(collectCliPackage({ ...options, version: '1.3.2' }, ports), /identity/)
}))
test('dirty build state is retained as a gate instead of claiming a clean commit', async () => fixture(async (options, ports) => {
  edit(options.buildReceipt, json => { json.sourceDirty = true })
  const result = await packageCli(options, ports)
  assert.equal(result.complete, false)
  assert.ok(result.inventory.reviewNeeded.some(item => item.code === 'SOURCE_DIRTY'))
  assert.equal(fs.existsSync(path.join(options.output, 'cli-release.json')), false)
}))
test('unbundled npm external and dynamic require remain evidence gaps', async () => fixture(async (options, ports) => {
  edit(options.metafile, json => { Object.values(json.outputs)[0].imports.push({ path: 'example', external: true, kind: 'require-call' }) })
  rebindBuild(options)
  const external = await collectCliPackage(options, ports)
  assert.ok(external.inventory.reviewNeeded.some(item => item.code === 'NPM_EXTERNAL_UNBUNDLED'))
  edit(options.metafile, json => { Object.values(json.outputs)[0].imports.pop() })
  fs.appendFileSync(path.join(options.root, 'node_modules/example/index.js'), 'function f(name){return require(name)}\n')
  edit(options.metafile, json => { json.inputs['node_modules/example/index.js'].bytes = receipt(options.root, 'node_modules/example/index.js').size })
  rebindBuild(options)
  const dynamic = await collectCliPackage(options, ports)
  assert.ok(dynamic.inventory.reviewNeeded.some(item => item.code === 'DYNAMIC_MODULE_ACCESS'))
  assert.equal(dynamic.complete, false)
}))
test('dependency version drift is not silently relabeled using the lock plan', async () => fixture(async (options, ports) => {
  edit(path.join(options.root, 'node_modules/example/package.json'), json => { json.version = '9.0.0' })
  const result = await collectCliPackage(options, ports)
  assert.ok(result.inventory.reviewNeeded.some(item => item.code === 'BUNDLE_LOCK_VERSION_DRIFT'))
}))
test('input traversal, junctions and output safety are enforced', async () => fixture(async (options, ports) => {
  await assert.rejects(packageCli({ ...options, output: path.join(options.root, 'release/v1.3.1') }, ports), /output/)
  await assert.rejects(packageCli({ ...options, output: path.join(options.root, 'userData/cli') }, ports), /output/)
  edit(options.metafile, json => { json.inputs['../external.ts'] = { bytes: 1, imports: [] } })
  // Intentionally do not read any outside fixture file.
  edit(options.buildReceipt, json => { json.metafile = receipt(options.root, path.relative(options.root, options.metafile).replaceAll('\\', '/')) })
  await assert.rejects(collectCliPackage(options, ports), /source input|boundary/)
}))
test('existing output is never overwritten', async () => fixture(async (options, ports) => {
  await packageCli(options, ports)
  const before = fs.readFileSync(path.join(options.output, 'cli-release.json'))
  await assert.rejects(packageCli(options, ports), /overwrite/)
  assert.deepEqual(fs.readFileSync(path.join(options.output, 'cli-release.json')), before)
}))
test('credential patterns are refused without disclosing the actual test value', async () => fixture(async (options, ports) => {
  const key = `sk-${'OnlySyntheticTestFixture'.repeat(3)}`
  fs.appendFileSync(options.bundle, key)
  edit(options.metafile, json => { Object.values(json.outputs)[0].bytes = receipt(options.root, 'out/cli-build/deepwriter.cjs').size })
  rebindBuild(options)
  await assert.rejects(packageCli(options, ports), error => /Sensitive/.test(error.message) && !error.message.includes(key))
  assert.equal(fs.existsSync(options.output), false)
}))
test('duplicate and unsupported packaging options cannot expand scope', () => {
  assert.throws(() => parseArgs(['--upload']), /Unknown/)
  assert.throws(() => parseArgs(['--version', VERSION, '--version', VERSION]), /Duplicate/)
})
