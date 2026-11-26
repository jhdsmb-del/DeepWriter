/** Focused source-build Electron acceptance: isolated profile + loopback only.
 * Bundle to out/compact-composer-ui.mjs; run from the repository root.
 * Does not change production capabilities or use an external model/API key. */
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { closeElectronGracefully } from './electron-shutdown'

const ROOT = process.cwd()
const screenshotsOnly = process.argv.includes('--screenshots-only')
const evidence = path.join(ROOT, 'out', 'compact-composer-ui', new Date().toISOString().replace(/[:.]/g, '-'))
await fs.mkdir(evidence, { recursive: true })
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-compact-composer-'))
const attachmentDir = path.join(userData, 'attachment-fixture')
const workDir = path.join(userData, 'workspace-fixture')
await fs.mkdir(attachmentDir)
await fs.mkdir(workDir)
await fs.writeFile(path.join(attachmentDir, 'note.txt'), '紧凑输入区的附件验证正文。', 'utf8')
await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ workDir: userData, docDir: userData, apiKey: '', baseUrl: 'http://127.0.0.1:1' }), 'utf8')
const calls: Array<{ model: string; thinking?: { type: string }; reasoning_effort?: string; messages: Array<{ content: string }> }> = []
let pendingResponse: ServerResponse | null = null
const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    if (request.method !== 'POST' || !request.url?.includes('/chat/completions')) { response.writeHead(404).end(); return }
    calls.push(JSON.parse(body))
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ id: 'compact-local', choices: [{ index: 0, delta: { role: 'assistant', content: '本地界面验收正在运行。' }, finish_reason: null }] })}\n\n`)
    pendingResponse = response
    response.once('close', () => { if (pendingResponse === response) pendingResponse = null })
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
let app: ElectronApplication | null = null
let page: Page | null = null
let passed = 0
let failed = 0
const rendererErrors: string[] = []
const errors: string[] = []
const viewportEvidence: Array<Record<string, unknown>> = []
const check = (label: string, condition: boolean): void => {
  if (condition) { passed++; console.log(`PASS ${label}`) } else { failed++; errors.push(`Assertion failed: ${label}`); console.error(`FAIL ${label}`) }
}

async function setWidth(width: number): Promise<void> {
  if (!app || !page) throw new Error('application not started')
  await app.evaluate(({ BrowserWindow }, requestedWidth) => {
    const win = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('window=float'))
    if (!win) throw new Error('no main window')
    if (win.isMaximized()) win.unmaximize()
    win.setContentSize(requestedWidth, 900, false)
    win.center()
  }, width)
  // Windows fractional display scaling can round one CSS pixel upward. Adjust
  // the actual BrowserWindow, never a synthetic Playwright viewport.
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = await page.evaluate(() => innerWidth)
    if (actual === width) break
    await app.evaluate(({ BrowserWindow }, difference) => {
      const win = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('window=float'))!
      const [contentWidth, contentHeight] = win.getContentSize()
      win.setContentSize(contentWidth + difference, contentHeight, false)
    }, width - actual)
    await page.waitForTimeout(100)
  }
  await expect.poll(() => page!.evaluate(() => innerWidth)).toBe(width)
}

async function screenshotRegion(name: string): Promise<void> {
  if (!page) throw new Error('no page')
  const composer = await page.locator('.composer').boundingBox()
  const panel = await page.getByTestId('model-reasoning-panel').boundingBox()
  if (!composer || !panel) throw new Error('missing native screenshot bounds')
  const x = Math.max(0, Math.min(composer.x, panel.x) - 5)
  const y = Math.max(0, Math.min(composer.y, panel.y) - 5)
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.screenshot({ path: path.join(evidence, name), animations: 'disabled', clip: {
    x, y, width: Math.min(viewport.width, Math.max(composer.x + composer.width, panel.x + panel.width) + 5) - x,
    height: Math.min(viewport.height, Math.max(composer.y + composer.height, panel.y + panel.height) + 5) - y
  } })
}

async function selectedReasoning(): Promise<{ mode: string; effort: string | null }> {
  return page!.evaluate(async () => {
    const snapshot = (await (window as any).ds.providerSnapshot()).data
    return snapshot.profiles.find((profile: any) => profile.id === (snapshot.bindings.draftProfileId ?? snapshot.bindings.defaultProfileId)).reasoning
  })
}

async function closeModel(): Promise<void> {
  await page!.keyboard.press('Escape')
  await page!.getByTestId('model-reasoning-panel').waitFor({ state: 'detached' })
}

try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [ROOT, '--force-device-scale-factor=1'], env: {
    ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData, DW_TEST_FIXTURE_DIR: attachmentDir, DW_TEST_SETTINGS_FIXTURE_DIR: workDir
  } })
  page = await app.firstWindow()
  page.on('pageerror', error => rendererErrors.push(error.message))
  await page.locator('.composer').waitFor()
  const trigger = page.getByTestId('model-reasoning-trigger')
  const slider = page.getByRole('slider', { name: '思考强度', exact: true })
  const tools = page.getByTestId('composer-tools-trigger')
  const draft = page.getByRole('textbox', { name: '任务内容', exact: true })
  await draft.fill('把模型与思考强度收成一个简洁入口。')
  await trigger.click()
  await slider.focus()
  await page.keyboard.press('Home')
  await expect.poll(selectedReasoning).toMatchObject({ mode: 'disabled', effort: null })
  await expect(slider).toBeEnabled()
  await slider.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(selectedReasoning).toMatchObject({ mode: 'enabled', effort: 'low' })
  check('键盘 Home / ArrowRight 保存真实关闭与低档 Profile', (await slider.getAttribute('aria-valuetext')) === '低')
  await expect(slider).toBeEnabled()
  await slider.focus()
  await page.keyboard.press('End')
  await expect.poll(selectedReasoning).toMatchObject({ mode: 'enabled', effort: 'max' })
  check('键盘 End 仅提交已验证最高档，不伪装 Ultra', (await slider.getAttribute('aria-valuetext')) === '最高' && !(await trigger.innerText()).includes('Ultra'))
  await expect(slider).toBeEnabled()
  await slider.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(selectedReasoning).toMatchObject({ mode: 'enabled', effort: 'high' })
  await expect(slider).toBeEnabled()
  await closeModel()
  await page.locator('.toast').waitFor({ state: 'hidden' })

  for (const width of [1280, 800]) {
    await setWidth(width)
    await expect(page.locator('.composer-tools-panel')).not.toBeVisible()
    const row = await page.locator('.composer-modebar').evaluate(element => {
      const attach = element.querySelector('.modebar-attachment')!.getBoundingClientRect()
      const model = element.querySelector('[data-testid="model-reasoning-trigger"]')!.getBoundingClientRect()
      const send = element.querySelector('.composer-send')!.getBoundingClientRect()
      return Math.abs((attach.y + attach.height / 2) - (send.y + send.height / 2)) < 2 && Math.abs((model.y + model.height / 2) - (send.y + send.height / 2)) < 2 && attach.right < model.left && model.right < send.left && getComputedStyle(element).borderTopWidth === '0px'
    })
    check(`${width}px 实际 Electron：附件、模型、圆形发送同一排无分隔线`, row)
    check(`${width}px 默认无目录/预设堆叠且模型入口唯一`, await trigger.count() === 1 && !await page.getByTestId('agent-preset-trigger').isVisible() && !await page.locator('.working-directory-btn').isVisible())
    const fullWindowPng = await page.screenshot({ path: path.join(evidence, `composer-${width}.png`), animations: 'disabled' })
    const observed = await page.evaluate(() => ({ devicePixelRatio: window.devicePixelRatio, innerWidth, innerHeight,
      textareaCssHeight: getComputedStyle(document.querySelector('.composer > textarea')!).height,
      bottomBarCssHeight: getComputedStyle(document.querySelector('.composer-modebar')!).height,
      composerCssHeight: document.querySelector('.composer')!.getBoundingClientRect().height,
      sendCssWidth: getComputedStyle(document.querySelector('.composer-send')!).width
    }))
    const nativeWindow = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('window=float'))!
      return { contentSize: win.getContentSize(), bounds: win.getBounds() }
    })
    viewportEvidence.push({ requestedWidth: width, observed, nativeWindow, pngPixels: { width: fullWindowPng.readUInt32BE(16), height: fullWindowPng.readUInt32BE(20) } })
    check(`${width}px PNG像素与实测DPR及innerWidth一致`, Math.abs(fullWindowPng.readUInt32BE(16) - observed.innerWidth * observed.devicePixelRatio) <= 1)
    await page.locator('.composer').screenshot({ path: path.join(evidence, `composer-region-${width}.png`), animations: 'disabled' })
    await trigger.click()
    const panel = page.getByTestId('model-reasoning-panel')
    await panel.waitFor({ state: 'visible' })
    const bounds = await panel.boundingBox()
    check(`${width}px 强度卡片300px内且全部在视口中`, Boolean(bounds && bounds.width <= 301 && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.height < 180))
    const order = await panel.evaluate(element => {
      const value = element.querySelector('.dw-model-strength-value')!.getBoundingClientRect()
      const model = element.querySelector('.dw-model-current')!.getBoundingClientRect()
      const range = element.querySelector('input[type="range"]')!.getBoundingClientRect()
      return value.bottom <= model.top + 1 && model.bottom < range.top && !element.querySelector('.dw-model-strength-stops')
    })
    check(`${width}px 当前强度→模型→离散滑杆，无重复标题/密集刻度`, order)
    await page.screenshot({ path: path.join(evidence, `strength-${width}.png`), animations: 'disabled' })
    await panel.screenshot({ path: path.join(evidence, `strength-card-${width}.png`), animations: 'disabled' })
    await screenshotRegion(`composer-and-strength-${width}.png`)
    await panel.getByRole('button', { name: '选择模型', exact: true }).click()
    const selected = panel.getByRole('option', { selected: true })
    check(`${width}px 模型入口和列表只显示模型名`, await trigger.innerText() === 'DeepSeek V4.1-Flash' && !(await selected.innerText()).includes('deepseek-v4-flash') && await selected.locator('small').count() === 0 && await selected.getAttribute('title') === null)
    await page.screenshot({ path: path.join(evidence, `models-${width}.png`), animations: 'disabled' })
    await panel.screenshot({ path: path.join(evidence, `models-card-${width}.png`), animations: 'disabled' })
    if (screenshotsOnly) { await closeModel(); continue }
    await selected.focus()
    const expectedNextId = await panel.locator('.dw-model-reasoning-models').evaluate(element => {
      const enabled = [...element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = enabled.findIndex(button => button.getAttribute('aria-selected') === 'true')
      return enabled[(index + 1) % enabled.length]?.textContent
    })
    await page.keyboard.press('ArrowDown')
    check(`${width}px 模型列表箭头移动到真实可选模型`, await panel.evaluate((element, expected) => element.contains(document.activeElement) && document.activeElement?.textContent === expected, expectedNextId))
    await panel.getByRole('button', { name: '‹ 选择模型', exact: true }).click()
    await panel.getByRole('button', { name: '高级', exact: true }).click()
    await panel.getByRole('button', { name: '优化 · 推荐', exact: true }).click()
    await expect(panel.getByRole('button', { name: '优化 · 推荐', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await panel.getByRole('button', { name: '查看本次上下文明细', exact: true }).click()
    const context = page.getByRole('dialog', { name: '本次运行上下文', exact: true })
    await context.waitFor({ state: 'visible' })
    check(`${width}px 上下文明细真实可达且模型卡片不叠在后面`, await page.getByTestId('model-reasoning-panel').getAttribute('aria-hidden') === 'true')
    await page.keyboard.press('Escape')
    await context.waitFor({ state: 'detached' })
    await tools.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.composer-tools-panel')).toBeVisible()
    await page.locator('.working-directory-btn').click()
    await expect.poll(() => page!.evaluate(async () => (await (window as any).ds.getSettings()).workDir)).toBe(workDir)
    check(`${width}px 更多工具中的目录选择保留真实授权主路径`, true)
    await page.getByTestId('agent-preset-trigger').click()
    const preset = page.getByTestId('agent-preset-panel')
    await preset.getByTestId('agent-preset-input').fill('先给结论，保持简洁。')
    await preset.getByRole('button', { name: '保存并启用', exact: true }).click()
    await preset.waitFor({ state: 'detached' })
    await expect.poll(() => page!.evaluate(async () => (await (window as any).ds.getSettings()).userPresetPrompt)).toBe('先给结论，保持简洁。')
    check(`${width}px 折叠内自定义指令仍可编辑保存且未发送草稿完整`, await draft.inputValue() === '把模型与思考强度收成一个简洁入口。')
    await page.keyboard.press('Escape')
    check(`${width}px 更多工具 Escape 恢复summary焦点`, await tools.evaluate(element => document.activeElement === element) && !await page.locator('.composer-tools-panel').isVisible())
    await trigger.click()
    await expect(panel).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    check(`${width}px 弹层 Shift+Tab 循环到最后可聚焦slider`, await slider.evaluate(element => document.activeElement === element))
    await page.keyboard.press('Tab')
    check(`${width}px 弹层 Tab 回到高级按钮`, await panel.getByRole('button', { name: '高级', exact: true }).evaluate(element => document.activeElement === element))
    await closeModel()
    check(`${width}px 模型 Escape 焦点还原且草稿完整`, await trigger.evaluate(element => document.activeElement === element) && await draft.inputValue() === '把模型与思考强度收成一个简洁入口。')
    await trigger.click()
    await draft.click()
    await panel.waitFor({ state: 'detached' })
    check(`${width}px 外点关闭模型卡片；没有横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await trigger.click()
  check('减少动态效果禁用模型卡片动画', await page.getByTestId('model-reasoning-panel').evaluate(element => getComputedStyle(element).animationName === 'none'))
  await closeModel()
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  if (!screenshotsOnly) {

  // Redirect ONLY the fresh isolated DB's bundled provider. The bundled
  // verified capabilities stay unchanged; ordinary UI/IPC drives selection.
  const database = new DatabaseSync(path.join(userData, 'deepwriter.db'))
  try { database.prepare("UPDATE provider_registry SET base_url=?,auth_style='none',default_credential_ref_id=NULL,transport_policy_json=? WHERE builtin_locked=1").run(origin, JSON.stringify({ scope: 'loopback_http', allowNonDefaultPort: true, protocol: 'deepseek-chat' })) } finally { database.close() }
  const snapshot = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data)
  const profile = snapshot.profiles.find((item: any) => item.id === (snapshot.bindings.draftProfileId ?? snapshot.bindings.defaultProfileId))
  const priced = await page.evaluate(async modelId => (window as any).ds.providerPricingUpsert({ modelId, currency: 'CNY', unit: 'per_1m_tokens', inputPrice: .02, outputPrice: .04, cacheHitInputPrice: .002, reasoningBillingRule: 'included_in_output', validFrom: '2026-01-01T00:00:00.000Z', acknowledgeReferenceOnly: true }), profile.modelId)
  if (!priced.ok) throw new Error('isolated user reference price rejected')
  await page.evaluate(() => window.dispatchEvent(new Event('deepwriter:provider-registry-changed')))
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await expect(page.locator('.attach-chip')).toContainText('note.txt')
  await expect(page.locator('.attach-state')).toHaveCount(0)
  check('左侧＋通过原选择器完成真实附件预览', true)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => calls.length).toBe(1)
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible()
  const runId = await page.evaluate(async () => (await (window as any).ds.runsListRecent(10))[0].runId)
  await trigger.click()
  await slider.focus()
  await page.keyboard.press('End')
  await expect.poll(selectedReasoning).toMatchObject({ mode: 'enabled', effort: 'max' })
  const frozen = await page.evaluate(async id => (window as any).ds.runsGet(id), runId)
  check('运行中切换最高仅影响下一次；已发HTTP与冻结Profile仍是high', calls[0].reasoning_effort === 'high' && frozen.config.providerProfileSnapshots.draft.wireReasoning.thinking.effort === 'high')
  check('真实HTTP正文包含附件与自定义指令', calls[0].messages.some(message => message.content.includes('紧凑输入区的附件验证正文。')) && calls[0].messages.some(message => message.content.includes('先给结论，保持简洁。')))
  await closeModel()
  await tools.click()
  check('运行中的工作目录保持禁用', !await page.locator('.working-directory-btn').isEnabled())
  await page.keyboard.press('Escape')
  await draft.fill('运行中的下一条未发送草稿。')
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
  await expect.poll(() => page!.evaluate(async id => (await (window as any).ds.runsGet(id)).status, runId)).toBe('cancelled')
  check('圆形停止真实取消任务并保留下一条草稿', await draft.inputValue() === '运行中的下一条未发送草稿。' && calls.length === 1)

  // A real manual unknown model remains unknown. No capability is invented.
  const manual = await page.evaluate(async baseUrl => {
    const ds = (window as any).ds
    const provider = await ds.providerCreateCustom({ displayName: '紧凑UI本地未知提供方', baseUrl, chatPath: '/v1/chat/completions', modelsPath: null, authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true, protocol: 'openai-chat' } })
    if (!provider.ok) throw new Error('manual provider rejected')
    const model = await ds.modelAddManual({ providerId: provider.data.id, remoteModelId: 'compact-unknown', displayName: '未知能力本地模型', contextWindow: null, maxOutputTokens: null })
    if (!model.ok) throw new Error('manual model rejected')
    const createdProfile = await ds.profileUpsert({ id: 'compact-unknown-profile', name: '未知能力界面Profile', providerId: provider.data.id, modelId: model.data.id, credentialRefId: null, generation: { temperature: null, topP: null, maxOutputTokens: null, stream: true }, reasoning: { mode: 'default', effort: null, budgetTokens: null }, compatibilityMappingId: null })
    if (!createdProfile.ok) throw new Error('manual profile rejected')
    const bound = await ds.profileSetBindings({ defaultProfileId: createdProfile.data.id, draftProfileId: createdProfile.data.id })
    if (!bound.ok) throw new Error('manual binding rejected')
    window.dispatchEvent(new Event('deepwriter:provider-registry-changed'))
    return model.data.capabilities.reasoning.state
  }, origin)
  await expect(trigger).toHaveAttribute('aria-label', /未知能力本地模型.*不可调/)
  await trigger.click()
  await expect(slider).toBeDisabled()
  check('未知真实Provider能力保持unknown，slider禁用而不是最高/Ultra', manual === 'unknown' && (await slider.getAttribute('aria-valuetext')) === '不可调')
  await page.getByTestId('model-reasoning-panel').locator('summary', { hasText: '为何不可调' }).click()
  await expect(page.getByText('思考能力未验证，暂不可切换。', { exact: true })).toBeVisible()
  check('不可调原因可按需查看', true)
  await page.screenshot({ path: path.join(evidence, 'unknown-strength-800.png'), animations: 'disabled' })
  await closeModel()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('模型上下文能力未知，已安全停止，草稿已保留', { exact: true })).toBeVisible()
  check('必要失败信息保留；未知上下文拒发，草稿完整且无新请求', calls.length === 1 && await draft.inputValue() === '运行中的下一条未发送草稿。')
  }
  check('没有未处理Renderer错误', rendererErrors.length === 0)
} catch (error) {
  failed++
  errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
  console.error(errors.at(-1))
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png'), animations: 'disabled' }).catch(() => undefined)
} finally {
  ;(pendingResponse as ServerResponse | null)?.end()
  if (app) {
    try { await closeElectronGracefully(app, { profile: userData, diagnosticsDir: evidence }); check('隔离Electron自然退出', true) } catch { check('隔离Electron自然退出', false) }
  }
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed, failed, sourceBuild: true, userData, requestedDeviceScaleFactor: 1, viewportEvidence, screenshotsOnly, loopbackOrigin: origin, generationCalls: calls.length, externalApiCalls: 0, mainSha256: createHash('sha256').update(await fs.readFile(path.join(ROOT, 'out/main/index.js'))).digest('hex'), rendererErrors, errors }, null, 2))
}
console.log(`Compact composer UI: ${passed} PASS / ${failed} FAIL`)
console.log(`Native Electron screenshots: ${evidence}`)
process.exitCode = failed ? 1 : 0
