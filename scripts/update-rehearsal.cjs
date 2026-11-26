'use strict'

// Manual entry point: node scripts/update-rehearsal.cjs, ONLY on the disposable
// Windows GitHub-hosted runner in update-rehearsal.yml. See the companion .md.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function requireDisposableRunner(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32', 'Update rehearsal requires Windows')
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Never install on a developer machine')
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Never install on a self-hosted runner')
  assert.equal(env.RUNNER_OS, 'Windows')
  assert.ok(env.RUNNER_TEMP && path.isAbsolute(env.RUNNER_TEMP), 'Runner temporary directory is required')
}
function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function versions(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Rehearse a stable candidate')
  const [major, minor, patch] = version.split('.').map(Number)
  return { baseVersion: version, targetVersion: `${major}.${minor}.${patch + 1}` }
}
function events(evidence) {
  const file = path.join(evidence, 'updater-events.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function until(probe, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await sleep(200)
  }
  throw new Error(`Timed out: ${description}`)
}
function command(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 600_000, ...options })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Command failed: ${path.basename(file)}${result.stderr ? `\n${result.stderr}` : ''}`)
  return result.stdout
}
function native(mode, executable, evidence, background = false) {
  const args = ['-NoProfile', '-File', path.join(__dirname, 'update-rehearsal-native.ps1'), '-Mode', mode, '-Executable', executable, '-Evidence', evidence]
  if (!background) return command('pwsh.exe', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 210_000 })
  const child = spawn('pwsh.exe', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  child.stdout.on('data', chunk => output.push(chunk.toString()))
  child.stderr.on('data', chunk => output.push(chunk.toString()))
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => {
      fs.writeFileSync(path.join(evidence, `native-${mode}.log`), output.join(''))
      code === 0 ? resolve() : reject(new Error(`Scoped native ${mode} failed: ${output.join('')}`))
    })
  })
  // The caller awaits this after the real app exits; keep early failures handled.
  completion.catch(() => undefined)
  return { child, completion }
}

async function fixtureServer(feed, evidence) {
  const fixture = { online: false, models: 0, modelResponses: [], reply: '升级验收：这份历史应保留。', requests: [] }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    fixture.requests.push({ at: new Date().toISOString(), method: req.method, path: url.pathname, range: req.headers.range || null })
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      req.resume()
      if (req.headers.authorization !== 'Bearer update-rehearsal-fixture-only') { res.writeHead(401).end(); return }
      fixture.models++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'update-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: fixture.reply }, finish_reason: null }] })}\n\n`)
      fixture.modelResponses.push(res) // Keep a real writing operation active until explicitly released.
      return
    }
    if (!url.pathname.startsWith('/feed/')) { res.writeHead(404).end(); return }
    if (!fixture.online) { res.writeHead(503).end('deliberate rehearsal outage'); return }
    const basename = url.pathname.slice('/feed/'.length)
    // A basename-only allowlist; never turn request input into a filesystem path.
    const allowed = fs.readdirSync(feed).filter(name => /^(latest\.yml|DeepWriter-[\d.]+-x64-setup\.exe(?:\.blockmap)?)$/.test(name))
    if (!allowed.includes(basename)) { res.writeHead(404).end(); return }
    const file = path.join(feed, basename)
    const size = fs.statSync(file).size
    let start = 0, end = size - 1
    if (req.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
      if (!range) { res.writeHead(416).end(); return }
      start = Number(range[1]); end = range[2] ? Number(range[2]) : end
      if (start > end || end >= size) { res.writeHead(416).end(); return }
    }
    res.writeHead(req.headers.range ? 206 : 200, {
      'Content-Type': basename.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
    })
    const stream = fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 })
    res.on('close', () => stream.destroy())
    try {
      // A bounded slow transfer gives the UI time to prove writing continues.
      for await (const chunk of stream) {
        if (res.destroyed) break
        if (!res.write(chunk)) await Promise.race([new Promise(resolve => res.once('drain', resolve)), new Promise(resolve => res.once('close', resolve))])
        if (basename.endsWith('.exe')) await sleep(8)
      }
      res.end()
    } catch (error) { res.destroy(error) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixture.origin = `http://127.0.0.1:${server.address().port}`
  fixture.finishModel = () => {
    for (const response of fixture.modelResponses.splice(0)) {
      response.write(`data: ${JSON.stringify({ id: 'update-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
  }
  fixture.close = async () => {
    fixture.finishModel()
    fs.writeFileSync(path.join(evidence, 'http-requests.json'), JSON.stringify(fixture.requests, null, 2) + '\n')
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
  }
  return fixture
}

function testConfiguration(manifest, temporary, evidence, version) {
  const config = structuredClone(manifest.build)
  config.directories = { ...config.directories, output: path.join(temporary, `build-${version}`) }
  config.extraMetadata = { ...config.extraMetadata, version, main: 'update-rehearsal-bootstrap.cjs' }
  config.files = [...config.files,
    { from: __dirname, to: '.', filter: ['update-rehearsal-bootstrap.cjs'] },
    { from: temporary, to: '.', filter: ['update-rehearsal.json'] }]
  config.win.target = ['nsis'] // No portable or duplicate CLI/complete packages.
  // Rehearsal copies are intentionally unsigned and never publication artifacts.
  delete config.win.signtoolOptions; delete config.win.azureSignOptions; delete config.win.sign
  config.forceCodeSigning = false
  assert.equal(config.nsis.include, 'build/installer.nsh', 'Use the actual installer marker macro')
  assert.equal(config.nsis.deleteAppDataOnUninstall, false)
  fs.writeFileSync(path.join(evidence, `test-builder-${version}.json`), JSON.stringify(config, null, 2) + '\n')
  return config
}

async function main() {
  requireDisposableRunner() // Before creating files, building, or installing.
  const manifestText = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  const manifest = JSON.parse(manifestText)
  const evidence = path.join(root, 'out/update-rehearsal')
  assert.ok(!fs.existsSync(evidence), 'Refuse to overwrite prior rehearsal evidence')
  fs.mkdirSync(evidence, { recursive: true })
  const report = { outcome: 'running', sourceCommit: process.env.GITHUB_SHA, ...versions(manifest.version), checks: [], startedAt: new Date().toISOString(), syntheticVersions: true, unsignedTestCopies: true, productionMainUnchanged: true }
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  const pass = check => { report.checks.push(check); console.log(`PASS ${check}`); save() }
  save()
  const runnerTemp = fs.realpathSync.native(process.env.RUNNER_TEMP)
  const temporary = fs.mkdtempSync(path.join(runnerTemp, 'dw-update-rehearsal-'))
  const installDir = path.join(temporary, 'application', 'DeepWriter')
  const executable = path.join(installDir, 'DeepWriter.exe')
  const profile = path.join(temporary, 'profile')
  const fixtureDir = path.join(temporary, 'work')
  fs.mkdirSync(fixtureDir)
  for (const target of [temporary, executable, profile]) assert.ok(inside(runnerTemp, target), 'All install/profile paths must stay inside runner temporary storage')
  fs.writeFileSync(path.join(temporary, 'update-rehearsal.json'), JSON.stringify({ executable, profile, fixtureDir, runtime: path.join(temporary, 'runtime.json'), evidence }))
  const { baseVersion, targetVersion } = report
  let fixture, active, nativeInstaller
  const { _electron, expect } = require('@playwright/test')
  require('esbuild').buildSync({ entryPoints: [path.join(__dirname, 'electron-shutdown.ts')], outfile: path.join(temporary, 'shutdown.cjs'), platform: 'node', format: 'cjs', bundle: true })
  const { closeElectronGracefully } = require(path.join(temporary, 'shutdown.cjs'))
  const close = async app => closeElectronGracefully(app, { profile, diagnosticsDir: evidence, timeoutMs: 20_000 })
  const launch = async expectedVersion => {
    const application = await _electron.launch({ executablePath: executable, args: [], env: { ...process.env, DEEPWRITER_API_KEY: '', DW_TEST_USERDATA: profile, NODE_ENV: 'test' }, timeout: 45_000 })
    active = application
    const identity = await application.evaluate(({ app }) => ({ version: app.getVersion(), executable: process.execPath, profile: app.getPath('userData'), packaged: app.isPackaged }))
    assert.equal(identity.version, expectedVersion)
    assert.equal(path.resolve(identity.executable).toLowerCase(), executable.toLowerCase())
    assert.equal(path.resolve(identity.profile).toLowerCase(), profile.toLowerCase())
    assert.equal(identity.packaged, true)
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.locator('.composer').waitFor()
    assert.ok(page.url().includes('app.asar'), 'Exercise packaged renderer, not a development page')
    await expect.poll(() => page.evaluate(() => window.ds.updatesGet())).toMatchObject({ installKind: 'nsis', currentVersion: expectedVersion })
    await page.evaluate(() => window.ds.updatesPreference(false))
    return { application, page, identity }
  }
  const showUpdates = async page => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '应用更新', exact: true }).click()
    await expect(page.locator('.dw-updates-page')).toBeVisible()
  }
  const prompt = '这份会话应在真实自动更新后保留。'
  const instruction = '升级验收专用：请保持简洁。'
  const draft = '未发送草稿：更新重启前的最后一次编辑。'
  const finalDraft = `${draft}再次启动后新加的内容。`
  const copyTraces = label => {
    for (const name of ['shutdown-trace.json', 'shutdown-trace-progress.json']) {
      if (fs.existsSync(path.join(profile, name))) fs.copyFileSync(path.join(profile, name), path.join(evidence, `${label}-${name}`))
    }
  }
  const dataSnapshot = page => page.evaluate(async () => {
    const settings = await window.ds.getSettings()
    const sessions = await window.ds.sessionsList()
    return { settings: { userPresetPrompt: settings.userPresetPrompt, credentialConfigured: settings.apiKey === '__CONFIGURED__', autoCheckUpdates: settings.autoCheckUpdates }, drafts: await window.ds.composerDraftsList(), sessions: await Promise.all(sessions.map(async session => ({ id: session.id, messages: await window.ds.sessionsLoad(session.id) }))) }
  })
  try {
    // Build the application once. Only version/entry metadata and test bootstrap
    // differ in two NSIS copies; no production source or manifest is rewritten.
    const { build: buildDesktop } = await import('electron-vite')
    await buildDesktop({ build: { minify: 'esbuild' } })
    require('./native-notice-resources.cjs').stageNativeNotices()
    require('./package-notice-resources.cjs').stagePackageNotices()
    const { build, Platform, Arch } = require('electron-builder')
    for (const version of [baseVersion, targetVersion]) {
      await build({ targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never', config: testConfiguration(manifest, temporary, evidence, version) })
    }
    assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), manifestText)
    pass('Built two test-only NSIS versions from one unchanged candidate output; published nothing')
    const feed = path.join(temporary, `build-${targetVersion}`)
    fixture = await fixtureServer(feed, evidence)
    fs.writeFileSync(path.join(temporary, 'runtime.json'), JSON.stringify({ origin: fixture.origin }))
    const installer = path.join(temporary, `build-${baseVersion}`, `DeepWriter-${baseVersion}-x64-setup.exe`)
    assert.ok(fs.statSync(installer).isFile())
    command(installer, ['/currentuser', '/S', `/D=${installDir}`], { timeout: 180_000 }) // /D MUST be last.
    await until(() => fs.existsSync(executable), 'actual A installation')
    assert.equal(fs.readFileSync(path.join(installDir, 'deepwriter-install.channel'), 'utf8').trim(), 'nsis')
    const first = await launch(baseVersion)
    pass('Installed A with actual NSIS; packaged desktop identifies itself as an NSIS installation')
    await first.page.evaluate(async ({ origin, instruction }) => {
      const directory = await window.ds.chooseDir('settings')
      if (!directory?.view?.fileRefId) throw new Error('Fixture directory did not receive real path authority')
      await window.ds.setSettings({ ...(await window.ds.getSettings()), baseUrl: origin, apiKey: 'update-rehearsal-fixture-only', model: 'deepseek-v4-flash', userPresetPrompt: instruction, webAccessEnabled: false, workDir: { value: directory.path, dirRefId: directory.view.fileRefId } })
    }, { origin: fixture.origin, instruction })
    await showUpdates(first.page)
    await first.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(first.page.getByRole('button', { name: '重试检查与下载', exact: true })).toBeEnabled()
    assert.equal((await first.page.evaluate(() => window.ds.updatesGet())).phase, 'error')
    await first.page.screenshot({ path: path.join(evidence, '01-offline-retry.png') })
    pass('Private loopback outage produces retryable error without quitting the installed app')
    await first.page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await first.page.getByRole('textbox', { name: '任务内容' }).fill(prompt)
    await first.page.getByRole('button', { name: '发送', exact: true }).click()
    await until(() => fixture.models === 1, 'real model stream to the loopback fixture')
    await showUpdates(first.page)
    await first.page.evaluate(() => { window.__updateRehearsalStates = []; window.ds.onUpdatesState(state => window.__updateRehearsalStates.push(state)) })
    fixture.online = true
    await first.page.getByRole('button', { name: '重试检查与下载', exact: true }).click()
    await expect(first.page.getByRole('progressbar', { name: '更新下载进度' })).toBeVisible({ timeout: 30_000 })
    assert.ok(fixture.modelResponses.length === 1, 'The existing writing stream must remain active during download')
    await first.page.screenshot({ path: path.join(evidence, '02-writing-during-download.png') })
    await expect(first.page.getByRole('button', { name: '重启并安装…', exact: true })).toBeEnabled({ timeout: 180_000 })
    const states = await first.page.evaluate(() => window.__updateRehearsalStates)
    fs.writeFileSync(path.join(evidence, 'desktop-update-states.json'), JSON.stringify(states, null, 2) + '\n')
    for (const phase of ['checking', 'downloading', 'ready']) assert.ok(states.some(state => state.phase === phase), `Missing actual desktop ${phase} state`)
    pass('Actual upstream updater downloads B while the existing writing stream continues')
    await first.page.getByRole('button', { name: '重启并安装…', exact: true }).click()
    await first.page.getByRole('button', { name: '确认重启并安装', exact: true }).click()
    await expect(first.page.getByText('仍有任务或操作正在进行，请完成后再重启。', { exact: true })).toBeVisible()
    assert.equal((await first.page.evaluate(() => window.ds.updatesGet())).phase, 'ready')
    assert.equal(events(evidence).filter(event => event.event === 'upstream-quitAndInstall').length, 0)
    assert.equal(fixture.modelResponses.length, 1)
    await first.page.screenshot({ path: path.join(evidence, '03-busy-restart-refused.png') })
    pass('Real active writing blocks explicit restart without cancelling or interrupting the stream')
    fixture.finishModel()
    await expect.poll(() => first.page.evaluate(async () => (await window.ds.runsListRecent(5)).filter(run => run.status === 'completed' && run.durableCompleted).length), { timeout: 30_000 }).toBe(1)
    await first.page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await first.page.getByRole('textbox', { name: '任务内容' }).fill(draft)
    await close(first.application); active = null
    copyTraces('ordinary-quit')
    await sleep(1500)
    assert.equal(events(evidence).filter(event => event.event === 'upstream-doInstall' || event.event === 'upstream-quitAndInstall').length, 0)
    const second = await launch(baseVersion)
    const preserved = await dataSnapshot(second.page)
    assert.equal(preserved.settings.userPresetPrompt, instruction)
    assert.equal(preserved.settings.credentialConfigured, true)
    assert.equal(preserved.settings.autoCheckUpdates, false)
    assert.ok(preserved.drafts.some(value => value.text === draft))
    assert.deepEqual(preserved.sessions[0].messages.map(message => message.content), [prompt, fixture.reply])
    pass('Ordinary quit does not install B; actual relaunch is still A with settings, credentials, history and draft')
    await showUpdates(second.page)
    await second.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(second.page.getByRole('button', { name: '重启并安装…', exact: true })).toBeEnabled({ timeout: 180_000 })
    const cachedInstaller = events(evidence).filter(event => event.event === 'upstream-downloaded').at(-1)?.installer
    assert.ok(cachedInstaller && path.isAbsolute(cachedInstaller) && fs.statSync(cachedInstaller).isFile())
    assert.equal(path.basename(cachedInstaller), `DeepWriter-${targetVersion}-x64-setup.exe`)
    nativeInstaller = native('Installer', cachedInstaller, evidence, true)
    const exited = new Promise(resolve => second.application.process().once('exit', (code, signal) => resolve({ code, signal })))
    // A fresh edit, not only the already-durable draft from the ordinary quit.
    // Do not explicitly save or wait for the debounce; use the real flush barrier.
    await second.page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await second.page.getByRole('textbox', { name: '任务内容' }).fill(finalDraft)
    await showUpdates(second.page)
    await second.page.getByRole('button', { name: '重启并安装…', exact: true }).click()
    await second.page.screenshot({ path: path.join(evidence, '04-explicit-restart-confirmation.png') })
    await second.page.getByRole('button', { name: '确认重启并安装', exact: true }).click()
    const exit = await Promise.race([exited, sleep(30_000).then(() => { throw new Error('Explicit restart failed to close A naturally') })])
    assert.deepEqual(exit, { code: 0, signal: null })
    await second.application.close().catch(() => undefined); active = null
    copyTraces('update-restart')
    await nativeInstaller.completion
    const restarted = await until(() => events(evidence).find(event => event.event === 'renderer-ready' && event.version === targetVersion), 'actual automatic B restart and packaged UI probe', 90_000)
    assert.equal(path.resolve(restarted.profile).toLowerCase(), profile.toLowerCase())
    assert.equal(restarted.snapshot.update.currentVersion, targetVersion)
    assert.equal(restarted.snapshot.update.installKind, 'nsis')
    assert.equal(restarted.snapshot.settings.userPresetPrompt, instruction)
    assert.equal(restarted.snapshot.settings.credentialConfigured, true)
    assert.equal(restarted.snapshot.settings.autoCheckUpdates, false)
    assert.ok(restarted.snapshot.drafts.some(value => value.text === finalDraft))
    assert.deepEqual(restarted.snapshot.sessions[0].messages.map(message => message.content), [prompt, fixture.reply])
    const identity = JSON.parse(native('Identity', executable, evidence))
    assert.equal(identity.productVersion.split('.').slice(0, 3).join('.'), targetVersion)
    assert.ok(identity.pids.includes(restarted.pid), 'The reported B desktop must really be running from the updated binary')
    fs.writeFileSync(path.join(evidence, 'restarted-identity.json'), JSON.stringify({ ...identity, desktop: restarted }, null, 2) + '\n')
    const updateEvents = events(evidence)
    assert.deepEqual(updateEvents.find(event => event.event === 'upstream-quitAndInstall')?.args, [false, true], 'Preserve actual production non-silent quitAndInstall arguments')
    assert.equal(updateEvents.filter(event => event.event === 'upstream-doInstall').length, 1)
    assert.equal(updateEvents.find(event => event.event === 'upstream-doInstall').args[0].isSilent, false)
    assert.ok(updateEvents.filter(event => event.event === 'upstream-check').every(event => event.autoDownload === false && event.autoInstallOnAppQuit === false && event.allowDowngrade === false && event.allowPrerelease === false))
    pass('Explicit desktop confirmation invokes original non-silent NSIS updater and automatically starts the actual B binary')
    pass('Automatically restarted B retains real settings, encrypted credential marker, conversation and unsent draft')
    native('CloseApplication', executable, evidence)
    copyTraces('updated-b-quit')
    const uninstallerName = fs.readdirSync(installDir).find(name => /^Uninstall.*\.exe$/i.test(name))
    assert.ok(uninstallerName, 'Actual installed uninstaller is required')
    const uninstaller = path.join(installDir, uninstallerName)
    assert.ok(inside(runnerTemp, uninstaller))
    command(uninstaller, ['/currentuser', '/S'], { timeout: 180_000 })
    await until(() => !fs.existsSync(executable), 'real NSIS uninstall cleanup', 45_000)
    assert.ok(fs.existsSync(path.join(profile, 'deepwriter.db')), 'Uninstall must preserve data')
    pass('Scoped real NSIS uninstall preserves fixture user data')
    report.outcome = 'passed'
  } catch (error) {
    report.outcome = 'failed'; report.error = error.stack || error.message
    throw error
  } finally {
    if (fixture) await fixture.close()
    if (active) await close(active).catch(error => { report.cleanupError = error.message })
    if (nativeInstaller) await nativeInstaller.completion.catch(error => { report.nativeError = error.message })
    report.completedAt = new Date().toISOString(); save()
    // Keep only small evidence in artifacts, not either 300MB test installer,
    // decrypted fixture profile, or private loopback bootstrap configuration.
    console.log(`Rehearsal evidence: ${evidence}`)
  }
}

module.exports = { requireDisposableRunner, inside, versions, fixtureServer, testConfiguration }
if (require.main === module) main().catch(error => { console.error(`FAIL NSIS update rehearsal: ${error.stack || error.message}`); process.exitCode = 1 })
