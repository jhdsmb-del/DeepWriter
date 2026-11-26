import * as path from 'node:path'
import * as url from 'node:url'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { closeElectronGracefully } from './electron-shutdown'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const phase = process.argv.find(argument => argument.startsWith('--phase='))?.slice('--phase='.length) ?? (process.argv.includes('--native-wire') ? 'after-native-wire' : process.argv.includes('--after') ? 'after' : 'before')
if (!/^[a-z][a-z0-9-]{0,48}$/u.test(phase)) throw new Error('invalid evidence phase')
const evidence = path.join(ROOT, 'tmp', 'commercial-ui')
await fs.mkdir(evidence, { recursive: true })
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-commercial-ui-'))
// Configure only the newly created test profile before Electron starts;
// normal directory changes still require the production picker/dirRefId.
await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ workDir: userData, docDir: userData, apiKey: '', baseUrl: 'http://127.0.0.1:1' }), 'utf8')
await fs.writeFile(path.join(userData, 'AGENTS.md'), '隔离界面截图目录。', 'utf8')
let app: ElectronApplication | null = null
let failed = 0
let passed = 0
let requests = 0
let skillHash: string | null = null
let baselineCalls = 0
const wires: Array<{ model?: string; thinking?: { type?: string }; reasoning_effort?: string }> = []
const server = createServer((request, response) => { requests++; let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => { const parsed = JSON.parse(body); wires.push({ model: parsed.model, thinking: parsed.thinking, reasoning_effort: parsed.reasoning_effort }); response.writeHead(500); response.end('intentional local synthetic failure') }) })
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const check = (label: string, ok: boolean): void => {
  if (ok) { passed++; console.log(`PASS ${label}`) } else { failed++; console.log(`FAIL ${label}`) }
}
// waitForFunction treats an async predicate's Promise as truthy. Await IPC in
// the Node runner before testing its actual Boolean, with a bounded deadline.
async function pollIpc(predicate: () => Promise<boolean>, label: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`actual IPC state timeout: ${label}`)
}
async function waitNewFailedRun(page: Awaited<ReturnType<ElectronApplication['firstWindow']>>, known: string[]): Promise<string> {
  let id = ''
  await pollIpc(async () => {
    const next = await page.evaluate(async previous => (await (window as any).ds.runsListRecent(10)).filter((run: { runId: string }) => !previous.includes(run.runId)), known)
    if (next.length > 1) throw new Error('more than one new run created by a single send')
    if (!next.length) return false
    id = next[0].runId
    return next[0].status === 'failed'
  }, 'single newly accepted run reaches the intentionally failing local provider terminal')
  return id
}
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [ROOT, `--user-data-dir=${userData}`], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: userData } })
  const expectedVersion = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version
  const actualVersion = await app.evaluate(({ app: runningApp }) => runningApp.getVersion())
  const mainHash = createHash('sha256').update(await fs.readFile(path.join(ROOT, 'out/main/index.js'))).digest('hex')
  console.log(`Evidence mode=source-local version=${actualVersion} mainSha256=${mainHash} phase=${phase}; isolated synthetic loopback only`)
  check('actual Electron application version matches source package', actualVersion === expectedVersion)
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.name))
  await page.locator('.dw-global-nav').getByRole('button', { name: 'Agent', exact: true }).click()
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('这是隔离界面的未发送草稿。')
  for (const width of [1280, 1024, 800]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: path.join(evidence, `composer-${phase}-${width}.png`), animations: 'disabled' })
    await page.getByTestId('model-reasoning-trigger').click()
    const dialog = page.getByRole('dialog', { name: '模型与思考', exact: true })
    await dialog.waitFor({ state: 'visible' })
    check(`${width} first card has strength slider without model list or context controls`, await dialog.getByRole('slider', { name: '思考强度', exact: true }).isVisible() && await dialog.getByRole('listbox').count() === 0 && await dialog.getByRole('group', { name: '上下文范围', exact: true }).count() === 0)
    await page.screenshot({ path: path.join(evidence, `model-strength-${phase}-${width}.png`), animations: 'disabled' })
    await dialog.getByRole('button', { name: '选择模型', exact: true }).click()
    const selected = dialog.getByRole('option', { selected: true })
    const snapshot = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data)
    const profile = snapshot.profiles.find((entry: { id: string }) => entry.id === (snapshot.bindings.draftProfileId ?? snapshot.bindings.defaultProfileId))
    const model = snapshot.models.find((entry: { id: string }) => entry.id === profile.modelId)
    check(`${width} selected option contains only its model name and selection`, (await selected.innerText()).includes('DeepSeek') && await selected.locator('small').count() === 0)
    await dialog.getByRole('button', { name: '选择模型', exact: true }).click()
    await dialog.getByRole('button', { name: '高级', exact: true }).click()
    await dialog.locator('.dw-model-identity > summary').click()
    check(`${width} selected remote identity retained in on-demand model details`, (await dialog.locator('.dw-model-identity').innerText()).includes(model.remoteModelId))
    await dialog.getByRole('button', { name: '高级设置', exact: true }).click()
    await dialog.getByRole('button', { name: '选择模型', exact: true }).click()
    check(`${width} dropdown inside viewport`, await dialog.evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight }))
    await page.screenshot({ path: path.join(evidence, `model-dropdown-${phase}-${width}.png`), animations: 'disabled' })
    await dialog.getByRole('button', { name: '选择模型', exact: true }).click()
    await dialog.getByRole('button', { name: '高级', exact: true }).click()
    check(`${width} advanced omits manual context modes and global window override`, await dialog.getByRole('group', { name: '上下文范围', exact: true }).count() === 0 && await dialog.locator('.dw-model-context-option, input[name="contextWindowTokens"]').count() === 0)
    const detailsButton = dialog.getByRole('button', { name: '查看本次上下文明细', exact: true })
    await detailsButton.focus()
    await page.keyboard.press('Enter')
    const contextDialog = page.getByRole('dialog', { name: '本次运行上下文', exact: true })
    await contextDialog.waitFor({ state: 'visible' })
    check(`${width} keyboard opens automatic context details with editable pinned facts`, (await contextDialog.innerText()).includes('按模型自动管理') && await contextDialog.getByPlaceholder('添加必须保留的事实').isVisible() && await contextDialog.getByRole('button', { name: '固定事实', exact: true }).count() === 1)
    await page.keyboard.press('Escape')
    await contextDialog.waitFor({ state: 'detached' })
    await page.getByTestId('model-reasoning-trigger').click()
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: '高级', exact: true }).click()
    await page.screenshot({ path: path.join(evidence, `model-advanced-${phase}-${width}.png`), animations: 'disabled' })
    await dialog.getByRole('button', { name: '高级设置', exact: true }).click()
    check(`${width} advanced returns to accessible first-level strength`, await dialog.getByRole('slider', { name: '思考强度', exact: true }).isVisible() && await dialog.getByRole('group', { name: '上下文范围', exact: true }).count() === 0)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.getByTestId('model-reasoning-panel').waitFor({ state: 'detached' })
    check(`${width} escape preserves unsent draft`, await page.getByRole('textbox', { name: '任务内容', exact: true }).inputValue() === '这是隔离界面的未发送草稿。')
    check(`${width} escape restores focus to compact model entry`, await page.getByTestId('model-reasoning-trigger').evaluate(element => document.activeElement === element))
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByTestId('model-reasoning-trigger').click()
  const reducedPanel = page.getByTestId('model-reasoning-panel')
  await reducedPanel.waitFor({ state: 'visible' })
  check('reduced motion disables model opening animation', await reducedPanel.evaluate(element => getComputedStyle(element).animationName === 'none'))
  await page.keyboard.press('Escape')
  await page.getByTestId('model-reasoning-panel').waitFor({ state: 'detached' })
  // Only this fresh test DB is redirected, with explicit loopback policy and
  // no credential. Capability evidence is the real bundled manifest; effort
  // changes themselves go through the ordinary control and registry IPC.
  const database = new DatabaseSync(path.join(userData, 'deepwriter.db'))
  try { database.prepare("UPDATE provider_registry SET base_url=?,auth_style='none',default_credential_ref_id=NULL,transport_policy_json=? WHERE builtin_locked=1").run(origin, JSON.stringify({ scope: 'loopback_http', allowNonDefaultPort: true, protocol: 'deepseek-chat' })) } finally { database.close() }
  const builtinSnapshot = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data)
  const builtinProfile = builtinSnapshot.profiles.find((entry: { id: string }) => entry.id === (builtinSnapshot.bindings.draftProfileId ?? builtinSnapshot.bindings.defaultProfileId))
  const builtinModel = builtinSnapshot.models.find((entry: { id: string }) => entry.id === builtinProfile.modelId)
  const builtinPrice = await page.evaluate(async (modelId) => (window as any).ds.providerPricingUpsert({ modelId, currency: 'CNY', unit: 'per_1m_tokens', inputPrice: .02, outputPrice: .04, cacheHitInputPrice: .002, reasoningBillingRule: 'included_in_output', validFrom: '2026-01-01T00:00:00.000Z', acknowledgeReferenceOnly: true }), builtinModel.id)
  if (!builtinPrice.ok) throw new Error('isolated built-in synthetic reference pricing rejected')
  await page.evaluate(() => window.dispatchEvent(new Event('deepwriter:provider-registry-changed')))
  await page.getByTestId('model-reasoning-trigger').click()
  const strength = page.getByRole('slider', { name: '思考强度', exact: true })
  await strength.focus()
  await page.keyboard.press('End')
  await pollIpc(() => page.evaluate(async () => { const result = (await (window as any).ds.providerSnapshot()).data; const id = result.bindings.draftProfileId ?? result.bindings.defaultProfileId; return result.profiles.find((entry: any) => entry.id === id).reasoning.effort === 'max' }), 'keyboard max actual Profile')
  const keyboardProfile = await page.evaluate(async () => { const result = (await (window as any).ds.providerSnapshot()).data; return result.profiles.find((entry: any) => entry.id === (result.bindings.draftProfileId ?? result.bindings.defaultProfileId)) })
  check('discrete range keyboard End commits actual supported max to normal Profile', keyboardProfile.reasoning.mode === 'enabled' && keyboardProfile.reasoning.effort === 'max')
  for (const effort of ['max', 'low', 'high', 'none']) {
    if (effort !== 'max') {
      await page.getByTestId('model-reasoning-trigger').click()
      await strength.waitFor()
      if (effort === 'low') {
        const bounds = await strength.boundingBox()
        if (!bounds) throw new Error('strength range not reachable')
        await page.mouse.click(bounds.x + bounds.width / 3, bounds.y + bounds.height * .5)
      } else { await strength.focus(); await page.keyboard.press(effort === 'none' ? 'Home' : 'ArrowRight') }
    }
    await pollIpc(() => page.evaluate(async expected => { const result = (await (window as any).ds.providerSnapshot()).data; const id = result.bindings.draftProfileId ?? result.bindings.defaultProfileId; const reasoning = result.profiles.find((entry: any) => entry.id === id).reasoning; return expected === 'none' ? reasoning.mode === 'disabled' && reasoning.effort === null : reasoning.mode === 'enabled' && reasoning.effort === expected }, effort), `${effort} actual Profile`)
    check(`${effort} native stop has actual Profile and visible strength card value with model-name-only entry`, (await page.locator('.dw-model-strength-value').innerText()) === ({ max: '最高', low: '低', high: '高', none: '思考关' } as Record<string, string>)[effort] && (await strength.getAttribute('aria-valuetext')) === ({ max: '最高', low: '低', high: '高', none: '思考关' } as Record<string, string>)[effort])
    await page.getByTestId('model-reasoning-trigger').click()
    await page.getByTestId('model-reasoning-panel').waitFor({ state: 'detached' })
    const beforeRequests = wires.length
    const beforeRuns = await page.evaluate(async () => (await (window as any).ds.runsListRecent(10)).map((run: { runId: string }) => run.runId))
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const strengthRunId = await waitNewFailedRun(page, beforeRuns)
    const strengthRun = await page.evaluate(async id => (window as any).ds.runsGet(id), strengthRunId)
    check(`${effort} next actual loopback HTTP request agrees with frozen real reasoning`, wires.length > beforeRequests && wires.slice(beforeRequests).every(wire => wire.model === builtinModel.remoteModelId && (effort === 'none' ? wire.thinking?.type === 'disabled' && wire.reasoning_effort === undefined : wire.thinking?.type === 'enabled' && wire.reasoning_effort === effort)) && strengthRun.config.providerProfileSnapshots.draft.wireReasoning.thinking.enabled === (effort !== 'none') && (effort === 'none' || strengthRun.config.providerProfileSnapshots.draft.wireReasoning.thinking.effort === effort))
    await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('这是隔离界面的未发送草稿。')
  }
  baselineCalls = requests
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('这是隔离界面的未发送草稿。')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分类', exact: true }).getByRole('button', { name: '扩展', exact: true }).click()
  const extensions = page.getByTestId('extensions-panel')
  await extensions.getByRole('region', { name: '第一方扩展目录', exact: true }).waitFor()
  const catalogRow = extensions.getByRole('region', { name: '第一方扩展目录', exact: true }).locator('.dw-extension-row').filter({ hasText: 'deepwriter/structure-review' })
  await catalogRow.getByRole('button', { name: '安装', exact: true }).click()
  const installedRegion = extensions.getByRole('region', { name: '已安装扩展', exact: true })
  const skillRow = installedRegion.locator('.dw-extension-row').filter({ hasText: 'deepwriter/structure-review' })
  await skillRow.getByRole('button', { name: '启用', exact: true }).waitFor()
  const freshExtensions = await page.evaluate(async () => (await (window as any).ds.extensionsSnapshot()).data)
  const skill = freshExtensions.installed.find((item: { id: string }) => item.id === 'deepwriter/structure-review')
  skillHash = skill.packageHash
  check('normal settings catalog installation defaults disabled with immutable hash and no executable grant', skill.enabled === false && /^[a-f0-9]{64}$/.test(skill.packageHash) && freshExtensions.selectedForNewRuns.skills.length === 0 && !(await skillRow.getByRole('checkbox').isEnabled()))
  await skillRow.getByRole('button', { name: '启用', exact: true }).click()
  await skillRow.getByRole('checkbox').click()
  await pollIpc(() => page.evaluate(async () => (await (window as any).ds.extensionsSnapshot()).data.selectedForNewRuns.skills.includes('deepwriter/structure-review')), 'actual selected skill persistence')
  await extensions.getByRole('status').filter({ hasText: '新任务选择已保存' }).waitFor()
  await skillRow.getByRole('button', { name: '查看 structure-review 详情', exact: true }).click()
  const details = extensions.getByRole('region', { name: '扩展详情', exact: true })
  await details.waitFor()
  check('normal skill selection and details use actual durable source/version/hash/permissions', (await details.innerText()).includes(skillHash!) && (await details.innerText()).includes('builtin:deepwriter/structure-review') && (await (await page.evaluate(async () => (window as any).ds.extensionsSnapshot())).data.selectedForNewRuns.skills).includes(skill.id))
  for (const width of [1280, 1024, 800]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: path.join(evidence, `extensions-skills-${phase}-${width}.png`), animations: 'disabled' })
    check(`${width} settings extension details have no horizontal overflow`, await extensions.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1))
  }
  await extensions.getByRole('tab', { name: '插件', exact: true }).click()
  const pluginCatalog = extensions.getByRole('region', { name: '第一方扩展目录', exact: true }).locator('.dw-extension-row').filter({ hasText: 'deepwriter/manuscript-inspector' })
  await pluginCatalog.getByRole('button', { name: '安装', exact: true }).click()
  const pluginRow = installedRegion.locator('.dw-extension-row').filter({ hasText: 'deepwriter/manuscript-inspector' })
  await pluginRow.getByRole('button', { name: '启用', exact: true }).click()
  await pluginRow.getByRole('checkbox').click()
  await pollIpc(() => page.evaluate(async () => (await (window as any).ds.extensionsSnapshot()).data.selectedForNewRuns.plugins.includes('deepwriter/manuscript-inspector')), 'actual selected plugin persistence')
  await extensions.getByRole('status').filter({ hasText: '新任务选择已保存' }).waitFor()
  const selectedPlugin = await page.evaluate(async () => (await (window as any).ds.extensionsSnapshot()).data)
  check('plugin selected through actual UI still has no renderer startup grant', selectedPlugin.selectedForNewRuns.plugins.includes('deepwriter/manuscript-inspector') && !/runtime|grant|pid/.test(JSON.stringify(selectedPlugin)))
  await pluginRow.getByRole('button', { name: '停用', exact: true }).click()
  await pluginRow.getByRole('button', { name: '启用', exact: true }).waitFor()
  const disabledPlugin = await page.evaluate(async () => (await (window as any).ds.extensionsSnapshot()).data)
  check('normal plugin disable immediately clears durable new-run selection', disabledPlugin.selectedForNewRuns.plugins.length === 0 && disabledPlugin.installed.find((item: { id: string }) => item.id === 'deepwriter/manuscript-inspector').enabled === false && !(await pluginRow.getByRole('checkbox').isEnabled()))
  await pluginRow.getByRole('button', { name: '移除', exact: true }).click()
  await pluginRow.getByRole('button', { name: '确认移除', exact: true }).click()
  await pluginRow.waitFor({ state: 'detached' })
  check('normal plugin removal is durable', !(await page.evaluate(async () => (await (window as any).ds.extensionsSnapshot()).data.installed)).some((item: { id: string }) => item.id === 'deepwriter/manuscript-inspector'))
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  const created = await page.evaluate(async (baseUrl) => (window as any).ds.providerCreateCustom({ displayName: '参考价界面本地夹具', baseUrl, chatPath: '/v1/chat/completions', modelsPath: null, authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true, protocol: 'openai-chat' } }), origin)
  if (!created.ok) throw new Error('normal isolated provider IPC rejected')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const panel = page.getByTestId('provider-registry')
  await panel.getByRole('button', { name: '提供方', exact: true }).click()
  await page.getByRole('option', { name: /^参考价界面本地夹具/ }).click()
  const manual = panel.locator('details').filter({ has: page.locator('summary', { hasText: /^手动添加模型$/ }) }).first()
  await manual.locator(':scope > summary').click()
  await manual.getByLabel('手动模型 ID', { exact: true }).fill('unknown-fixture')
  await manual.getByLabel('手动模型名称', { exact: true }).fill('规格未知夹具')
  await manual.getByRole('button', { name: '保存模型', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: '模型已保存' }).waitFor()
  let snapshot = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data)
  const unknown = snapshot.models.find((entry: { remoteModelId: string }) => entry.remoteModelId === 'unknown-fixture')
  check('manual UI omitted specs remain null, not guessed from model ID', unknown.contextWindow === null && unknown.maxOutputTokens === null && unknown.source === 'manual' && unknown.capabilities.reasoning.state === 'unknown')
  await panel.locator('.dw-provider-models button').filter({ hasText: '规格未知夹具' }).click()
  const profiles = panel.locator('section[aria-labelledby="provider-profiles-title"]')
  await profiles.getByRole('button', { name: '保存并用于新任务', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: '已设为新任务默认 Profile' }).waitFor()
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await page.getByTestId('model-reasoning-trigger').click()
  await page.getByTestId('model-reasoning-panel').locator('summary', { hasText: '为何不可调' }).click()
  check('unknown manual reasoning stays disabled without fictional native stops', !(await page.getByRole('slider', { name: '思考强度', exact: true }).isEnabled()) && await page.getByText('思考能力未验证，暂不可切换。', { exact: true }).isVisible())
  await page.keyboard.press('Escape')
  await page.getByTestId('model-reasoning-panel').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByText('模型上下文能力未知，已安全停止，草稿已保留', { exact: true }).waitFor()
  check('normal manual unknown-spec profile refuses send and preserves draft without a request', requests === baselineCalls && await page.getByRole('textbox', { name: '任务内容', exact: true }).inputValue() === '这是隔离界面的未发送草稿。')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await panel.getByRole('button', { name: '提供方', exact: true }).click()
  await page.getByRole('option', { name: /^参考价界面本地夹具/ }).click()
  await manual.locator(':scope > summary').click()
  await manual.getByLabel('手动模型 ID', { exact: true }).fill('finite-fixture')
  await manual.getByLabel('手动模型名称', { exact: true }).fill('有限规格夹具')
  await manual.locator('summary').filter({ hasText: /^更多参数/ }).click()
  await manual.getByLabel('手动模型上下文上限', { exact: true }).fill('131072')
  await manual.getByLabel('手动模型单次输出上限', { exact: true }).fill('8192')
  await manual.getByRole('button', { name: '保存模型', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: '模型已保存' }).waitFor()
  snapshot = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data)
  const finite = snapshot.models.find((entry: { remoteModelId: string }) => entry.remoteModelId === 'finite-fixture')
  check('normal manual UI/IPC persists user-declared finite caps without fake reasoning verification', finite.contextWindow === 131072 && finite.maxOutputTokens === 8192 && finite.source === 'manual' && finite.capabilities.reasoning.state === 'unknown')
  await panel.locator('.dw-provider-models button').filter({ hasText: '有限规格夹具' }).click()
  const pricing = panel.locator('details.dw-provider-pricing')
  check('user reference pricing starts collapsed', await pricing.getAttribute('open') === null)
  await pricing.locator(':scope > summary').click()
  await pricing.getByLabel('输入参考价', { exact: true }).fill('0.02')
  await pricing.getByLabel('输出参考价', { exact: true }).fill('0.04')
  await pricing.getByLabel('缓存命中输入参考价', { exact: true }).fill('0.002')
  await pricing.getByRole('button', { name: '参考价推理计费方式', exact: true }).click()
  await page.getByRole('option', { name: '已包含在输出价中', exact: true }).click()
  check('price save requires explicit non-bill acknowledgement', !(await pricing.getByRole('button', { name: '保存用户参考价', exact: true }).isEnabled()))
  await pricing.getByLabel('确认参考价不是实际账单', { exact: true }).check()
  await pricing.getByRole('button', { name: '保存用户参考价', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: '用户参考价已保存' }).waitFor()
  snapshot = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data)
  const priced = snapshot.models.find((entry: { id: string }) => entry.id === finite.id)
  check('normal pricing UI persists exact user-source identity/hash with unknown optional rates null', priced.pricing.source === 'user_supplied' && priced.pricing.canonicalOrigin === origin && priced.pricing.remoteModelId === finite.remoteModelId && /^[a-f0-9]{64}$/.test(priced.pricing.priceProfileHash) && priced.pricing.cacheWritePerMillion === null && priced.pricing.reasoningPerMillion === null)
  await profiles.getByRole('button', { name: '保存并用于新任务', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: '已设为新任务默认 Profile' }).waitFor()
  for (const width of [1280, 1024, 800]) {
    await page.setViewportSize({ width, height: 900 })
    await pricing.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(evidence, `provider-reference-price-${phase}-${width}.png`), animations: 'disabled' })
    check(`${width} pricing form has no horizontal viewport overflow`, await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1))
  }
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await page.getByTestId('model-reasoning-trigger').click()
  const finiteSnapshot = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data)
  const boundProfile = finiteSnapshot.profiles.find((entry: { id: string }) => entry.id === finiteSnapshot.bindings.defaultProfileId)
  const frozenReadback = await page.evaluate(async (profileId) => (window as any).ds.profileResolveEffective(profileId), boundProfile.id)
  check('normal Profile readback retains declared finite caps and exact user price identity', frozenReadback.ok && frozenReadback.data.model.contextWindow === 131072 && frozenReadback.data.model.maxOutputTokens === 8192 && frozenReadback.data.model.pricing.priceProfileHash === priced.pricing.priceProfileHash)
  await page.getByTestId('model-reasoning-trigger').click()
  check('pricing/spec form operations cause no additional generation calls', requests === baselineCalls)
  await page.getByTestId('model-reasoning-panel').waitFor({ state: 'detached' })
  // One intentionally failing local generation verifies the actual accepted
  // run snapshot. This is not a successful model response or quality claim.
  const knownRuns = await page.evaluate(async () => (await (window as any).ds.runsListRecent(10)).map((run: { runId: string }) => run.runId))
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const acceptedRunId = await waitNewFailedRun(page, knownRuns)
  const accepted = await page.evaluate(async id => (window as any).ds.runsGet(id), acceptedRunId)
  const frozen = accepted.config?.providerProfileSnapshots?.draft
  check('actual chat:start freezes normal UI declared caps and exact price before local provider failure', requests > baselineCalls && frozen?.model?.contextWindow === 131072 && frozen?.model?.maxOutputTokens === 8192 && frozen?.model?.pricing?.priceProfileHash === priced.pricing.priceProfileHash && frozen.provider.baseUrl === origin && frozen.model.remoteModelId === 'finite-fixture' && accepted.config.providerCallBudget.maxCost.currency === 'CNY' && accepted.config.providerCallBudget.maxCost.amount > 0)
  check('actual new chat freezes selected skill hash and exact instructions in production prefix', accepted.config.extensionsFrozen?.skills.some((pin: { record: { id: string; packageHash: string } }) => pin.record.id === 'deepwriter/structure-review' && pin.record.packageHash === skillHash) && accepted.config.frozenSystemMessages.some((message: { content: string }) => message.content.includes('稿件结构审阅')) && accepted.config.extensionsFrozen.plugins.length === 0)
  check('no renderer unhandled errors', errors.length === 0)
} catch (error) {
  failed++
  console.log(`FAIL UI smoke: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await fs.writeFile(path.join(evidence, `wire-evidence-${phase}.json`), JSON.stringify({ mode: 'source-local', userData, wires, requests, syntheticHttpStatus: 500, qualitySuccessClaimed: false }, null, 2), 'utf8')
  if (app) {
    try {
      await closeElectronGracefully(app, { profile: userData, timeoutMs: 8000, diagnosticsDir: evidence })
      check('isolated Electron natural exit', true)
    } catch {
      check('isolated Electron natural exit', false)
    }
    await app.close().catch(() => undefined)
  }
  await new Promise<void>(resolve => server.close(() => resolve()))
}
console.log(`Commercial UI source-local (${phase}): ${passed} PASS / ${failed} FAIL`)
console.log(`Isolated fixture retained: ${userData}`)
process.exitCode = failed ? 1 : 0
