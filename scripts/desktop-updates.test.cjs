'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { build } = require('esbuild')
const path = require('node:path')
const fs = require('node:fs')

async function load(file, electron) {
  const result = await build({ entryPoints: [path.resolve(__dirname, '..', file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], logLevel: 'silent' })
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', '__dirname', result.outputFiles[0].text)(name => name === 'electron' ? electron : require(name), mod, mod.exports, path.resolve(__dirname, '../src/main'))
  return mod.exports
}
class Backend extends EventEmitter {
  checks = 0; downloads = 0; installs = 0; version = '8.1.0'; fail = false
  async checkForUpdates() { this.checks++; await Promise.resolve(); if (this.fail) { this.emit('error', Error('offline')); throw Error('offline') } return { updateInfo: { version: this.version } } }
  async downloadUpdate() { this.downloads++; this.emit('download-progress', { percent: 42.5 }); if (this.failDownload) throw Error('download interrupted'); return ['installer.exe'] }
  quitAndInstall(silent, runAfter) { assert.equal(silent, false); assert.equal(runAfter, true); this.installs++ }
}
async function fixture(kind = 'nsis') {
  const { DesktopUpdates } = await load('src/main/desktopUpdates.ts')
  const backend = new Backend(), history = []; let busy = false, prepared = 0
  const updater = new DesktopUpdates({ kind, version: '8.0.0', autoCheck: true, backend, publish: s => history.push(s), busy: () => busy, prepareRestart: () => { prepared++; return true } })
  return { updater, backend, history, busy: value => { busy = value }, prepared: () => prepared, DesktopUpdates }
}

test('NSIS identity requires installer marker; portable wins; unpacked/dev never install', async () => {
  const { desktopInstallKind } = await load('src/main/desktopUpdates.ts')
  const base = { packaged: true, platform: 'win32', portable: false, marker: 'nsis\r\n' }
  assert.equal(desktopInstallKind(base), 'nsis')
  assert.equal(desktopInstallKind({ ...base, portable: true }), 'portable')
  assert.equal(desktopInstallKind({ ...base, marker: null }), 'unpacked')
  assert.equal(desktopInstallKind({ ...base, marker: 'nsis-web' }), 'unpacked')
  assert.equal(desktopInstallKind({ ...base, packaged: false }), 'development')
  assert.equal(desktopInstallKind({ ...base, platform: 'linux' }), 'unsupported')
})

test('development never checks the network even on explicit check/start', async () => {
  const { updater, backend } = await fixture('development')
  updater.start(); await updater.check(); updater.stop()
  assert.equal(backend.checks, 0); assert.equal(backend.downloads, 0)
  assert.equal(updater.restart().ok, false)
})

test('one async check downloads in background; no implicit installation, retry state and bounded progress', async () => {
  const { updater, backend, history } = await fixture()
  const a = updater.check(), b = updater.check(); assert.equal(a, b)
  assert.equal((await a).phase, 'ready'); assert.equal(backend.checks, 1); assert.equal(backend.downloads, 1)
  assert.equal(backend.installs, 0); assert.ok(history.some(s => s.phase === 'downloading' && s.progress === 42.5))
  assert.equal((await updater.check()).phase, 'ready'); assert.equal(backend.checks, 1)
  updater.stop(); assert.equal(backend.installs, 0, 'ordinary exit/stop never installs cached update')
})

test('active writing blocks restart and does not queue a future restart', async () => {
  const { updater, backend, busy, prepared } = await fixture()
  busy(true); await updater.check()
  assert.equal(updater.restart().ok, false); assert.equal(prepared(), 0); assert.equal(backend.installs, 0)
  busy(false); await Promise.resolve(); assert.equal(prepared(), 0, 'finishing work must not trigger restart')
  assert.equal(updater.restart().ok, true); assert.equal(prepared(), 1); assert.equal(backend.installs, 0)
  updater.restartCancelled('草稿未保存'); assert.equal(updater.snapshot().phase, 'ready'); assert.equal(backend.installs, 0)
  updater.restart(); updater.installPrepared(); assert.equal(backend.installs, 1)
})

test('a real asynchronous style job blocks restart until cancellation has finished saving', async () => {
  const { createStyleService } = await load('src/main/style/styleService.ts')
  const { DesktopUpdates } = await load('src/main/desktopUpdates.ts')
  const home = await require('node:fs/promises').mkdtemp(path.join(require('node:os').tmpdir(), 'dw-update-style-'))
  const service = createStyleService({ baseDir: home, getApi: () => ({ model: 'fixture', baseUrl: 'http://127.0.0.1:1', apiKey: '' }) })
  const profile = await service.buildProfile([{ name: '测试', text: '第一章\n\n他推开门，把书放在桌上。\n\n第二章\n\n风吹过走廊，她把窗户关了。' }])
  const { jobId } = await service.startJob(profile.profileId, { mode: 'new', targetChars: 100, sceneType: '叙述', narrativeFunctions: [], pov: '第三人称', requiredFacts: [], forbiddenFacts: [], emotionalArc: [], outputFormat: 'prose', fidelity: 'light', userPrompt: '测试' })
  // Stop before the asynchronous profile read/model stage: no model request.
  assert.equal(service.hasActiveJobs, true)
  const backend = new Backend(); let prepared = 0
  const updates = new DesktopUpdates({ kind: 'nsis', version: '8.0.0', autoCheck: false, backend, publish() {}, busy: () => service.hasActiveJobs, prepareRestart: () => { prepared++; return true } })
  await updates.check(); assert.equal(updates.restart().ok, false); assert.equal(prepared, 0)
  service.stopJob(jobId)
  const until = Date.now() + 3000
  while (service.hasActiveJobs && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(service.hasActiveJobs, false); assert.equal((await service.getJob(jobId)).stage, 'cancelled')
  assert.equal(prepared, 0); assert.equal(updates.restart().ok, true)
})

test('check/download failures remain retryable, and old/prerelease versions are not downloaded', async () => {
  const { updater, backend } = await fixture()
  backend.fail = true; assert.equal((await updater.check()).phase, 'error')
  backend.fail = false; backend.failDownload = true; assert.equal((await updater.check()).phase, 'error')
  backend.failDownload = false; backend.version = '7.9.0'; assert.equal((await updater.check()).phase, 'current')
  backend.version = '8.2.0-beta.1'; assert.equal((await updater.check()).phase, 'current')
  assert.equal(backend.downloads, 1)
  backend.version = '8.1.0'; assert.equal((await updater.check()).phase, 'ready')
})

test('portable/unpacked only notify with the exact public portable asset and never download/install', async () => {
  const { DesktopUpdates } = await load('src/main/desktopUpdates.ts')
  for (const kind of ['portable', 'unpacked']) {
    const backend = new Backend()
    const updater = new DesktopUpdates({ kind, version: '8.0.0', autoCheck: false, backend, publish() {}, busy: () => false, prepareRestart: () => { throw Error('must not restart') }, stableRelease: async () => ({ version: '8.1.0', portableUrl: 'https://github.com/jhdsmb-del/DeepWriter/releases/download/v8.1.0/DeepWriter-8.1.0-x64-portable.exe' }) })
    const state = await updater.check(); assert.equal(state.phase, 'available'); assert.ok(state.portableUrl.endsWith('8.1.0-x64-portable.exe'))
    assert.equal(updater.restart().ok, false); assert.equal(backend.checks + backend.downloads + backend.installs, 0)
    assert.equal(updater.preference(true).autoCheck, true)
  }
})

test('IPC restart barrier waits for admitted operations and rejects new work but admits draft flush', async () => {
  const handlers = new Map()
  const guard = await load('src/main/ipcGuard.ts', { ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} } })
  const frame = { url: require('node:url').pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href }
  const event = { senderFrame: frame, sender: { mainFrame: frame } }
  let finish
  guard.registerIpc('chat:start', {}, () => new Promise(resolve => { finish = resolve }))
  guard.registerIpc('composer:draftSave', {}, () => true)
  const started = handlers.get('chat:start')(event)
  assert.equal(guard.pendingDesktopOperations(), 1)
  guard.reserveUpdateRestart(true)
  await assert.rejects(() => handlers.get('chat:start')(event), /正在准备更新重启/)
  assert.equal(await handlers.get('composer:draftSave')(event), true)
  finish(); await started; assert.equal(guard.pendingDesktopOperations(), 0)
  guard.reserveUpdateRestart(false)
  guard.registerIpc('updates:preference', {}, () => new Promise(resolve => { finish = resolve }))
  const preference = handlers.get('updates:preference')(event)
  assert.equal(guard.pendingDesktopOperations(), 1, 'a pending preference write also prevents restart')
  finish(); await preference; assert.equal(guard.pendingDesktopOperations(), 0)
})

test('production updater is fixed stable GitHub; quit cannot trigger install and update path cannot cancel writing', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/main/index.ts'), 'utf8')
  assert.match(src, /new NsisUpdater\(\{ provider: 'github', owner: 'jhdsmb-del', repo: 'DeepWriter', releaseType: 'release' \}\)/)
  assert.match(src, /backend.autoInstallOnAppQuit = false/)
  assert.match(src, /backend.allowPrerelease = false/); assert.match(src, /backend.allowDowngrade = false/)
  assert.match(src, /if \(forUpdate && updateRestartBusy\(\)\).*cancelUpdateRestart/)
  assert.ok(src.indexOf('if (forUpdate && updateRestartBusy())', src.indexOf('composer_drafts_flushed')) < src.indexOf('await Promise.all(actives.map'))
  assert.ok(src.indexOf('db_checkpoint_close_completed') < src.indexOf('desktopUpdates?.installPrepared()'))
})
