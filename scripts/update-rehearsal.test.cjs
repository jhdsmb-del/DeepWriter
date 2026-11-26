'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { requireDisposableRunner, inside, versions, fixtureServer, testConfiguration } = require('./update-rehearsal.cjs')

test('install entry point rejects local and self-hosted execution before side effects', () => {
  const allowed = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_TEMP: os.tmpdir() }
  assert.doesNotThrow(() => requireDisposableRunner(allowed, 'win32'))
  assert.throws(() => requireDisposableRunner({}, 'win32'), /developer machine/)
  assert.throws(() => requireDisposableRunner({ ...allowed, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'), /self-hosted/)
  assert.throws(() => requireDisposableRunner(allowed, 'linux'), /Windows/)
  assert.equal(inside(os.tmpdir(), path.join(os.tmpdir(), 'owned', 'application')), true)
  assert.equal(inside(os.tmpdir(), os.tmpdir()), false)
  assert.equal(inside(os.tmpdir(), path.resolve(os.tmpdir(), '..', 'unowned')), false)
})

test('synthetic A/B are strictly ordered stable versions; actual builder overlay finds only test bootstrap/config', async () => {
  assert.deepEqual(versions('8.0.0'), { baseVersion: '8.0.0', targetVersion: '8.0.1' })
  assert.throws(() => versions('8.0.0-beta.1'), /stable candidate/)
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-update-config-test-'))
  try {
    const manifest = require('../package.json')
    const before = JSON.stringify(manifest)
    const config = testConfiguration(manifest, temporary, temporary, '8.0.1')
    assert.equal(JSON.stringify(manifest), before)
    assert.equal(config.extraMetadata.main, 'update-rehearsal-bootstrap.cjs')
    assert.equal(config.extraMetadata.version, '8.0.1')
    assert.deepEqual(config.win.target, ['nsis'])
    assert.equal(manifest.main, 'out/main/index.js')
    assert.equal(JSON.stringify(manifest.build.files).includes('update-rehearsal'), false)
    assert.equal(config.nsis.oneClick, manifest.build.nsis.oneClick)
    assert.equal(config.nsis.include, 'build/installer.nsh')
    fs.writeFileSync(path.join(temporary, 'update-rehearsal.json'), '{}')
    const { getFileMatchers } = require('app-builder-lib/out/fileMatcher')
    const { computeFileSets, getDestinationPath } = require('app-builder-lib/out/util/appFileCopier')
    const destination = path.join(temporary, 'app')
    const matchers = getFileMatchers({ files: config.files.slice(-2) }, 'files', destination, { defaultSrc: path.resolve(__dirname, '..'), macroExpander: value => value, customBuildOptions: {}, globalOutDir: path.join(temporary, 'out') })
    const sets = await computeFileSets(matchers, null, { info: { areNodeModulesHandledExternally: false } }, false)
    assert.deepEqual(sets.flatMap(set => set.files.map(file => path.relative(destination, getDestinationPath(file, set)))).sort(), ['update-rehearsal-bootstrap.cjs', 'update-rehearsal.json'])
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

test('private fixture supports retry, metadata, real full/range bytes, and denies traversal', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-update-feed-test-'))
  let fixture
  try {
    fs.writeFileSync(path.join(temporary, 'latest.yml'), 'version: 8.0.1\n')
    fs.writeFileSync(path.join(temporary, 'DeepWriter-8.0.1-x64-setup.exe'), 'fixture-installer-bytes')
    fs.writeFileSync(path.join(temporary, 'not-public.txt'), 'private')
    fixture = await fixtureServer(temporary, temporary)
    assert.match(fixture.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal((await fetch(`${fixture.origin}/feed/latest.yml`)).status, 503)
    fixture.online = true
    assert.equal(await (await fetch(`${fixture.origin}/feed/latest.yml`)).text(), 'version: 8.0.1\n')
    assert.equal(await (await fetch(`${fixture.origin}/feed/DeepWriter-8.0.1-x64-setup.exe`)).text(), 'fixture-installer-bytes')
    const range = await fetch(`${fixture.origin}/feed/DeepWriter-8.0.1-x64-setup.exe`, { headers: { Range: 'bytes=2-6' } })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), 'xture')
    assert.equal(range.headers.get('content-range'), 'bytes 2-6/23')
    assert.equal((await fetch(`${fixture.origin}/feed/not-public.txt`)).status, 404)
    assert.equal((await fetch(`${fixture.origin}/feed/%2e%2e%2fnot-public.txt`)).status, 404)
    assert.equal((await fetch(`${fixture.origin}/feed/DeepWriter-8.0.1-x64-setup.exe`, { headers: { Range: 'bytes=999-1000' } })).status, 416)
  } finally {
    if (fixture) await fixture.close()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
