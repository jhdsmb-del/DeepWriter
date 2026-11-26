'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { unzipSync } = require('fflate')
const { packageCliArchive, collectCliArchiveInputs } = require('./package-cli-archive.cjs')
const VERSION = '8.0.0', SOURCE = 'a'.repeat(40), NAME = `DeepWriter-${VERSION}-cli-win-x64.zip`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let work, bundle
test.before(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-cli-archive-')))
  const target = path.join(work, 'real-cli.cjs')
  await (await import('../src/cli/build.mjs')).buildCli({ outfile: target, version: VERSION })
  bundle = fs.readFileSync(target)
})
test.after(() => { if (work) fs.rmSync(work, { recursive: true, force: true }) })
function write(root, name, value) {
  const target = path.join(root, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value) + '\n')
}
function receipt(root, name) { const bytes = fs.readFileSync(path.join(root, name)); return { name, size: bytes.length, sha256: hash(bytes) } }
function fixture(t, actual = false) {
  const root = fs.mkdtempSync(path.join(work, 'fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(root, 'package.json', { name: 'deepwriter', version: VERSION, license: 'MIT' })
  write(root, 'package-lock.json', { version: VERSION, packages: { '': { version: VERSION } } })
  write(root, 'LICENSE', 'Synthetic fixture project license\n')
  write(root, 'docs/CLI.md', '# CLI fixture usage\n.\\cli\\deepwriter.cmd --version\n')
  const cliDir = path.join(root, 'cli-built')
  write(cliDir, 'deepwriter.cjs', actual ? bundle : 'console.log("synthetic fixture")\n')
  write(cliDir, 'deepwriter.cmd', '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0deepwriter.cjs" %*\r\n')
  const syntheticRuntime = Buffer.alloc(1024 * 1024); syntheticRuntime.write('MZ synthetic runtime fixture')
  write(cliDir, 'runtime/node.exe', actual && process.platform === 'win32' ? fs.readFileSync(process.execPath) : syntheticRuntime)
  write(cliDir, 'runtime/LICENSE', 'Synthetic fixture Node notice\n')
  write(cliDir, 'runtime/LICENSE.source.json', { version: process.versions.node, sourceUrl: 'https://nodejs.org/' })
  write(cliDir, 'THIRD_PARTY_NOTICES.txt', 'Synthetic fixture bundled dependency notices\n')
  write(cliDir, 'LICENSE', fs.readFileSync(path.join(root, 'LICENSE')))
  write(cliDir, 'build/cli-build.json', { schemaVersion: 1, diagnosticFixture: true })
  const runtime = { name: 'node', version: process.versions.node, platform: 'win32', arch: 'x64', executable: 'runtime/node.exe', license: 'runtime/LICENSE', licenseSource: 'runtime/LICENSE.source.json' }
  const files = ['deepwriter.cjs', 'deepwriter.cmd', 'runtime/node.exe', 'runtime/LICENSE', 'runtime/LICENSE.source.json', 'THIRD_PARTY_NOTICES.txt', 'LICENSE', 'build/cli-build.json']
  write(cliDir, 'cli-inventory.json', { schemaVersion: 1, application: { name: 'deepwriter-cli', version: VERSION }, sourceCommit: SOURCE, inventoryComplete: true, reviewNeeded: [],
    source: { packageSha256: receipt(root, 'package.json').sha256, lockSha256: receipt(root, 'package-lock.json').sha256 },
    runtime: { ...runtime, executableSha256: receipt(cliDir, runtime.executable).sha256 }, files: files.map(name => receipt(cliDir, name)) })
  write(cliDir, 'cli-release.json', { schemaVersion: 1, name: 'deepwriter-cli', version: VERSION, sourceCommit: SOURCE, entrypoint: 'deepwriter.cjs', runtime,
    inventory: 'cli-inventory.json', notices: 'THIRD_PARTY_NOTICES.txt', files: [...files, 'cli-inventory.json'].map(name => receipt(cliDir, name)) })
  return { root, cliDir, sourceCommit: SOURCE, output: path.join('out', NAME) }
}
function mutateManifest(options, fn) {
  const file = path.join(options.cliDir, 'cli-release.json')
  const value = JSON.parse(fs.readFileSync(file)); fn(value); fs.writeFileSync(file, JSON.stringify(value))
}

test('standalone ZIP carries identical CLI inventory, entrypoint, runtime and notices and runs --version', async t => {
  const options = fixture(t, true)
  write(options.cliDir, 'unlisted-user-file.txt', 'Must not ship this unrelated file')
  const result = await packageCliArchive(options)
  assert.equal(path.basename(result.output), NAME)
  const unpacked = unzipSync(fs.readFileSync(result.output))
  const manifest = JSON.parse(fs.readFileSync(path.join(options.cliDir, 'cli-release.json')))
  const expectedCli = [...manifest.files.map(entry => 'cli/' + entry.name), 'cli/cli-release.json'].sort()
  assert.deepEqual(Object.keys(unpacked).filter(name => name.startsWith('cli/')).sort(), expectedCli)
  for (const name of expectedCli) assert.deepEqual(Buffer.from(unpacked[name]), fs.readFileSync(path.join(options.cliDir, name.slice(4))))
  for (const name of ['README.md', 'docs/CLI.md', 'LICENSE', 'cli-archive-manifest.json', 'SHA256SUMS.txt']) assert.ok(unpacked[name], name)
  assert.ok(!Object.keys(unpacked).some(name => name.startsWith('desktop/') || name.includes('node_modules') || name.includes('unlisted-user-file')))
  assert.match(Buffer.from(unpacked['README.md']).toString('utf8'), /deepwriter\.cmd --version/)
  const received = path.join(options.root, 'received')
  fs.mkdirSync(received)
  for (const name of ['cli/deepwriter.cjs', 'cli/deepwriter.cmd', 'cli/runtime/node.exe']) write(received, name, Buffer.from(unpacked[name]))
  const execution = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', path.join(received, 'cli/deepwriter.cmd'), '--version'], { cwd: received, encoding: 'utf8' })
    : spawnSync(process.execPath, [path.join(received, 'cli/deepwriter.cjs'), '--version'], { cwd: received, encoding: 'utf8' })
  assert.equal(execution.status, 0, execution.stdout + execution.stderr)
  assert.equal(execution.stdout.trim(), VERSION)
  assert.equal(fs.existsSync(path.join(received, '.deepwriter-cli')), false)
  assert.equal(fs.readFileSync(result.output + '.SHA256SUMS.txt', 'utf8'), `${hash(fs.readFileSync(result.output))}  ${NAME}\n`)
  await assert.rejects(packageCliArchive(options), /fresh|overwrit/)
})

test('corrupt, missing, duplicate and source-mismatched signed-off resources reject before creating an archive', async t => {
  for (const mutation of [
    options => fs.appendFileSync(path.join(options.cliDir, 'deepwriter.cjs'), 'corrupt'),
    options => fs.unlinkSync(path.join(options.cliDir, 'THIRD_PARTY_NOTICES.txt')),
    options => mutateManifest(options, manifest => { manifest.files.push({ ...manifest.files[0], name: 'DEEPWRITER.CJS' }) }),
    options => mutateManifest(options, manifest => { manifest.version = '7.0.0' }),
    options => write(options.root, 'package-lock.json', { changed: true }),
    options => mutateManifest(options, manifest => { manifest.files = manifest.files.filter(entry => entry.name !== 'runtime/LICENSE.source.json') })
  ]) {
    const options = fixture(t); mutation(options)
    await assert.rejects(packageCliArchive(options))
    assert.equal(fs.existsSync(path.join(options.root, 'out')), false)
  }
})

test('inventory resource gaps cannot be hidden by rebinding the manifest', async t => {
  const options = fixture(t)
  const inventory = JSON.parse(fs.readFileSync(path.join(options.cliDir, 'cli-inventory.json')))
  inventory.files = inventory.files.filter(entry => entry.name !== 'THIRD_PARTY_NOTICES.txt')
  write(options.cliDir, 'cli-inventory.json', inventory)
  mutateManifest(options, manifest => { manifest.files = manifest.files.map(entry => receipt(options.cliDir, entry.name)) })
  await assert.rejects(collectCliArchiveInputs(options), /omits/)
  inventory.inventoryComplete = false
  write(options.cliDir, 'cli-inventory.json', inventory)
  mutateManifest(options, manifest => { manifest.files = manifest.files.map(entry => receipt(options.cliDir, entry.name)) })
  await assert.rejects(packageCliArchive(options), /incomplete/)
})

test('fresh exact archive names, real paths and exclusive publication protect existing user files', async t => {
  const options = fixture(t)
  await assert.rejects(packageCliArchive({ ...options, output: 'out/wrong-name.zip' }), /must be named/)
  await assert.rejects(packageCliArchive({ ...options, output: '../' + NAME }), /unsafe|fresh/i)
  fs.mkdirSync(path.join(options.root, 'out'))
  const target = path.join(options.root, options.output)
  fs.writeFileSync(target, 'keep me')
  await assert.rejects(packageCliArchive(options), /fresh|overwrit/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me')
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [NAME])
  const outside = fs.mkdtempSync(path.join(work, 'outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.symlinkSync(outside, path.join(options.root, 'linked'), 'junction')
  await assert.rejects(packageCliArchive({ ...options, output: path.join('linked', NAME) }), /Linked/)
  assert.deepEqual(fs.readdirSync(outside), [])
  fs.symlinkSync(options.cliDir, path.join(options.root, 'cli-linked'), 'junction')
  await assert.rejects(collectCliArchiveInputs({ ...options, cliDir: 'cli-linked' }), /Linked/)
})
