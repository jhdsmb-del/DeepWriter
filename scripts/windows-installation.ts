import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as http from 'node:http'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { closeElectronGracefully } from './electron-shutdown'

// This test uses the real default profile to verify uninstall behavior. Never run
// it against a developer's machine or replace an existing profile.
async function main(): Promise<void> {
  assert.equal(process.platform, 'win32', 'Installation acceptance requires Windows')
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run installation acceptance only in an ephemeral GitHub runner')
  assert.ok(process.env.RUNNER_TEMP && process.env.APPDATA && !process.env.DW_TEST_USERDATA)
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string
  const baseline = process.env.DW_UPGRADE_BASELINE || '1.2.6'
  const profile = path.join(process.env.APPDATA!, 'DeepWriter')
  assert.equal(fs.existsSync(profile), false, 'Refusing to touch an existing default profile')
  const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP!, 'dw-install-'))
  const installDir = path.join(temporary, 'application')
  const executable = path.join(installDir, 'DeepWriter.exe')
  const previous = path.resolve(process.env.DW_UPGRADE_INSTALLER || '')
  const candidate = path.join(root, 'dist', `DeepWriter-${version}-x64-setup.exe`)
  assert.ok(previous.toLowerCase().startsWith(path.resolve(process.env.RUNNER_TEMP!).toLowerCase() + path.sep), 'Upgrade baseline must be inside the ephemeral runner directory')
  assert.ok(fs.statSync(previous).isFile() && fs.statSync(candidate).isFile())
  const uninstaller = () => {
    const name = fs.readdirSync(installDir).find((entry) => /^Uninstall.*\.exe$/i.test(entry))
    assert.ok(name, 'Installed NSIS uninstaller is missing')
    return path.join(installDir, name)
  }
  const install = (file: string) => {
    // /D must be last. NSIS consumes its unquoted path including spaces.
    const result = spawnSync(file, ['/S', `/D=${installDir}`], { timeout: 180_000, windowsHide: true, stdio: 'inherit' })
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'Actual NSIS installation failed')
    assert.ok(fs.existsSync(executable))
  }
  const uninstall = async () => {
    const result = spawnSync(uninstaller(), ['/S'], { timeout: 180_000, windowsHide: true, stdio: 'inherit' })
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'Actual NSIS uninstallation failed')
    // NSIS delegates to a temporary copy; wait for that process to remove files.
    await expect.poll(() => fs.existsSync(executable), { timeout: 30_000 }).toBe(false)
    assert.ok(fs.existsSync(path.join(profile, 'deepwriter.db')), 'Uninstall removed user data')
  }
  let requests = 0
  const reply = '安装升级验收：历史、加密凭据和设置保留。'
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return }
      if (req.headers.authorization !== 'Bearer installation-fixture-only') { res.writeHead(401).end('Fixture credential rejected'); return }
      requests++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'install-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'install-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const launch = async (expectedVersion: string) => {
    const application = await electron.launch({ executablePath: executable, args: [], env: { ...process.env, NODE_ENV: 'test', DW_TEST_FIXTURE_DIR: temporary, DW_TEST_PRICING_ORIGIN: `http://127.0.0.1:${port}` } })
    try {
      const identity = await application.evaluate(({ app }) => ({ version: app.getVersion(), profile: app.getPath('userData'), packaged: app.isPackaged }))
      assert.equal(identity.version, expectedVersion)
      assert.equal(path.resolve(identity.profile).toLowerCase(), profile.toLowerCase(), 'Actual default userData path differs')
      assert.equal(identity.packaged, true)
      const page = await application.firstWindow()
      await page.locator('.composer').waitFor({ timeout: 15_000 })
      assert.ok(page.url().includes('app.asar'))
      return { application, page }
    } catch (error) { await application.close(); throw error }
  }
  const close = async (application: ElectronApplication) => {
    await closeElectronGracefully(application, { profile, diagnosticsDir: path.join(root, 'e2e-screenshots') })
  }
  const prompt = '这份会话应在升级后保留。'
  const instruction = '请保持简洁，完成后说明结果。'
  let sessionId = ''
  try {
    install(previous)
    const old = await launch(baseline)
    try {
      await old.page.evaluate(async ({ port, instruction }) => {
        const ds = (window as any).ds
        const directory = await ds.chooseDir('settings')
        if (!directory?.view?.fileRefId) throw new Error('Directory selection did not issue authority')
        await ds.setSettings({ ...(await ds.getSettings()), baseUrl: `http://127.0.0.1:${port}`, apiKey: 'installation-fixture-only', model: 'deepseek-v4-flash', userPresetPrompt: instruction, workDir: { value: directory.path, dirRefId: directory.view.fileRefId } })
        if ((await ds.getSettings()).apiKey !== '__CONFIGURED__') throw new Error('Windows credential encryption is unavailable')
      }, { port, instruction })
      await old.page.getByRole('textbox', { name: '任务内容' }).fill(prompt)
      await old.page.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(async () => old.page.evaluate(async () => (await (window as any).ds.runsListRecent(5)).filter((run: any) => run.status === 'completed' && run.durableCompleted).length), { timeout: 15_000 }).toBe(1)
      sessionId = await old.page.evaluate(async () => (await (window as any).ds.sessionsList())[0].id)
    } finally { await close(old.application) }
    assert.equal(requests, 1)

    install(candidate)
    const upgraded = await launch(version)
    try {
      const snapshot = await upgraded.page.evaluate(async (id) => ({ messages: await (window as any).ds.sessionsLoad(id), settings: await (window as any).ds.getSettings() }), sessionId)
      assert.deepEqual(snapshot.messages.map((message: any) => message.content), [prompt, reply])
      assert.equal(snapshot.settings.apiKey, '__CONFIGURED__')
      assert.equal(snapshot.settings.userPresetPrompt, instruction)
      assert.equal(path.resolve(snapshot.settings.workDir).toLowerCase(), temporary.toLowerCase())
      // A second actual request proves DPAPI decryption and migrated configuration.
      await upgraded.page.getByRole('textbox', { name: '任务内容' }).fill('升级后再次调用模型。')
      await upgraded.page.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(async () => upgraded.page.evaluate(async () => (await (window as any).ds.runsListRecent(5)).filter((run: any) => run.status === 'completed' && run.durableCompleted).length), { timeout: 15_000 }).toBe(2)
    } finally { await close(upgraded.application) }
    assert.equal(requests, 2)
    const builtHash = await hash(path.join(root, 'dist', 'win-unpacked', 'DeepWriter.exe'))
    assert.equal(await hash(executable), builtHash, 'Installed executable differs from packaged candidate')
    fs.copyFileSync(uninstaller(), path.join(root, 'dist', 'verified-uninstaller.exe'))
    await uninstall()
    const preserved = new DatabaseSync(path.join(profile, 'deepwriter.db'), { readOnly: true })
    try { assert.equal((preserved.prepare('SELECT COUNT(*) AS count FROM session_messages').get() as { count: number }).count, 4) } finally { preserved.close() }
    console.log('PASS actual installer upgrade: history, settings and encrypted credentials; uninstall preserves the real default profile')

    // Move only our fixture profile, on its own volume. Windows runners can
    // put APPDATA on C: and RUNNER_TEMP on D:, where rename would reject EXDEV.
    const preservedProfile = path.join(path.dirname(profile), `DeepWriter-install-verification-${path.basename(temporary)}`)
    assert.equal(fs.existsSync(preservedProfile), false, 'Refusing to replace another preserved profile')
    fs.renameSync(profile, preservedProfile)
    install(candidate)
    const clean = await launch(version)
    try {
      const state = await clean.page.evaluate(async () => ({ sessions: await (window as any).ds.sessionsList(), drafts: await (window as any).ds.composerDraftsList(), settings: await (window as any).ds.getSettings() }))
      assert.equal(state.sessions.length, 0)
      assert.equal(state.drafts.length, 0)
      assert.equal(state.settings.apiKey, '')
      await clean.page.getByRole('textbox', { name: '任务内容' }).fill('全新安装后的未发送草稿。')
    } finally { await close(clean.application) }
    await uninstall()
    const cleanDb = new DatabaseSync(path.join(profile, 'deepwriter.db'), { readOnly: true })
    try { assert.equal((cleanDb.prepare("SELECT text FROM composer_drafts WHERE text <> ''").get() as { text: string }).text, '全新安装后的未发送草稿。') } finally { cleanDb.close() }
    console.log('PASS actual clean installation: default profile, packaged UI and durable draft preserved after uninstall')
    fs.writeFileSync(path.join(root, 'dist', 'installation-verification.json'), JSON.stringify({ version, sourceCommit: process.env.GITHUB_SHA, upgradedFrom: baseline, installerSha256: await hash(candidate), baselineSha256: await hash(previous), cleanInstall: true, upgradeHistory: true, upgradeCredentials: true, uninstallPreservesData: true, verifiedAt: new Date().toISOString() }, null, 2) + '\n')
  } finally {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}

async function hash(file: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

main().catch((error) => { console.error(`FAIL Windows installation acceptance: ${error.message}`); process.exitCode = 1 })
