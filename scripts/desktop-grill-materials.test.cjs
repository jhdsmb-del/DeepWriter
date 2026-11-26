const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { buildSync } = require('esbuild')
const { _electron, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '..')
function load(contents) {
  const built = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['node:sqlite'] })
  const mod = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, mod, mod.exports); return mod.exports
}
const production = load(`export { FileRefRegistry } from './src/main/fileRef'; export { ContentAssetStore } from './src/main/assetStore'; export { createAttachmentService } from './src/main/attachmentService'; export * from './src/main/grillAttachments'; export { createRepository } from './src/main/db/repository'; export { createGrillMeState, grillMeOutlineHash, buildGrillMeQuestionPrompt, buildGrillMePlanningPrompt } from './src/shared/grillMe';`)
const wire = ref => ({ fileRefId: ref.fileRefId, name: ref.displayName, size: ref.size })
const scope = sessionId => ({ kind: 'session', sessionId, draftId: 'current' })
async function cleanup(home) { if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-grill-materials-')) await fs.rm(home, { recursive: true, force: true }) }

test('素材沿现有授权/解析读取，冻结身份与有界摘录；跨会话、变更和替换均拒绝', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-grill-materials-unit-'))
  try {
    const a = path.join(home, 'A.txt'), b = path.join(home, 'B.txt')
    await fs.writeFile(a, 'A独有证据。'.repeat(2000)); await fs.writeFile(b, 'B独有证据。')
    const registry = new production.FileRefRegistry()
    const assets = new production.ContentAssetStore({ baseDir: path.join(home, 'assets'), maxMemoryBytes: 100000, spillThresholdBytes: 100000, readText: async file => ({ ok: true, info: { text: await fs.readFile(file, 'utf8'), source: 'utf8', size: (await fs.stat(file)).size } }) })
    const service = production.createAttachmentService(registry, assets)
    const [ar] = (await registry.register([a], scope('a'), 'dialog')).refs
    const [br] = (await registry.register([b], scope('b'), 'dialog')).refs
    const attachments = await production.captureGrillAttachments(registry, service, 'a', [{ ...wire(ar), name: '伪造名称', size: 1 }])
    assert.equal(attachments[0].name, 'A.txt'); assert.equal(attachments[0].size, ar.size)
    assert.equal(attachments[0].excerpt.length, 4000); assert.match(attachments[0].contentHash, /^[a-f0-9]{64}$/)
    const state = production.createGrillMeState({ stateId: 'a', sessionId: 'a', originalTask: '根据附件解释记录中的观测值。', targetChars: 2000, attachments })
    assert.ok(production.buildGrillMeQuestionPrompt(state).includes('A独有证据'))
    assert.ok(production.buildGrillMePlanningPrompt(state).includes('A独有证据'))
    assert.ok(!JSON.stringify(state).includes(home)); await production.readFrozenGrillAttachment(service, state.sessionId, { ...attachments[0], hash: attachments[0].contentHash })
    await assert.rejects(production.captureGrillAttachments(registry, service, 'a', [wire(br)]), /B.txt/)
    const [wrong] = (await registry.register([b], scope('a'), 'dialog')).refs
    await assert.rejects(production.rebindGrillAttachment(registry, service, state, ar.fileRefId, wire(wrong)), /不是素材「A.txt」的原内容/)
    const oldStat = await fs.stat(a)
    await fs.writeFile(a, 'X独有证据。'.repeat(2000)); await fs.utimes(a, oldStat.atime, oldStat.mtime)
    await assert.rejects(production.readFrozenGrillAttachment(service, state.sessionId, { ...attachments[0], hash: attachments[0].contentHash }), /素材「A.txt」/)
    assert.equal((await production.grillAttachmentStatuses(new production.FileRefRegistry(), state))[0].available, false)
    assert.equal(state.attachments[0].fileRefId, ar.fileRefId)
  } finally { await cleanup(home) }
})

test('Renderer 冻结启动时的 A 素材，确认/预览不读取 B 草稿或吞掉它', async () => {
  globalThis.window = { ds: {} }
  const { useStore } = load(`export { useStore } from './src/renderer/src/store';`)
  const initial = useStore.getState(), a = { fileRefId: 'a', name: 'A.txt', size: 2, state: 'ready' }, b = { fileRefId: 'b', name: 'B.txt', size: 2, state: 'ready' }
  const ready = { previewId: 'preview', mode: 'optimized', policyRevision: 0, budget: { status: 'ready' } }
  let preview, accepted
  window.ds = { contextPreview: async input => { preview = input; return ready }, chatStart: async input => { accepted = input; return { runId: input.id, status: 'queued' } } }
  useStore.setState({ ...initial, currentSessionId: 'a', pendingAttachments: [a], settings: { planMode: false }, loadContext: async () => {}, workspace: 'novel', longMode: true })
  assert.equal(useStore.getState().startGuidedLongwrite('根据这份记录解释观测值为何不同。', [a]), true)
  const request = useStore.getState().grillLaunchRequest
  useStore.setState({ pendingAttachments: [b] })
  assert.deepEqual(request.attachments, [wire({ ...a, displayName: a.name })]); assert.equal(request.sessionId, 'a')
  const state = { sessionId: 'a', stateId: 'grill-a', originalTask: request.task, targetChars: 2000, attachments: [{ ...a, contentHash: 'a'.repeat(64), excerpt: 'A' }], slots: [], assumptions: [], approvedOutline: {}, outlineRevision: 1, outlineHash: 'outline' }
  assert.equal((await useStore.getState().send(state.originalTask, [b], state)).ok, true)
  assert.deepEqual(preview.attachments, [wire({ ...a, displayName: a.name })])
  assert.deepEqual(accepted.attachments, preview.attachments)
  assert.equal(useStore.getState().pendingAttachments[0].fileRefId, 'b')
})

test('真实桌面 A/B 素材独立保存；重开实名恢复原文件，预览/正文拒绝调包', { timeout: 60000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-grill-materials-ui-'))
  const afile = path.join(home, '潮位记录A.txt'), bfile = path.join(home, '灯具记录B.txt')
  const aText = 'A独有资料：潮位缺测留空，真实零值填写0。', bText = 'B独有资料：灯具使用蓝色编号，不涉及潮位。'
  const requests = []
  const server = http.createServer((req, res) => { let body = ''; req.on('data', x => { body += x }); req.on('end', () => { requests.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: aText.repeat(100) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2000, total_tokens: 2100 } }) + '\n\ndata: [DONE]\n\n') }) })
  let app
  const launch = () => _electron.launch({ args: [process.env.DW_UI_BUILD_DIR ? path.join(root, process.env.DW_UI_BUILD_DIR, 'main/index.js') : root, '--user-data-dir=' + home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
  const pick = file => app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await fs.writeFile(afile, aText); await fs.writeFile(bfile, bText)
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'deepseek-v4-flash', toolsEnabled: false, planMode: false }))
    app = await launch(); let page = await app.firstWindow(); page.setDefaultTimeout(12000)
    await page.getByRole('button', { name: '长文', exact: true }).click()
    const begin = async (file, task) => {
      await pick(file); await page.getByRole('button', { name: '添加素材', exact: true }).click()
      await expect(page.locator('.dw-longform-material-picker')).toContainText(path.basename(file)); await expect(page.locator('.dw-longform-material-picker')).not.toContainText('解析中')
      const input = page.getByRole('textbox', { name: '创作构想', exact: true }); await input.fill(task)
      await input.locator('..').locator('..').getByRole('button', { name: '开始梳理', exact: true }).click()
      await page.getByText('这篇稿子想用哪种写法？', { exact: true }).waitFor()
      const state = await page.evaluate(async task => { for (const s of await window.ds.sessionsList()) { const g = await window.ds.grillGet(s.id); if (g?.originalTask === task) return g } }, task)
      assert.ok(state); return state
    }
    const a = await begin(afile, '围绕这份潮位记录与值班笔记写一篇长文。')
    assert.equal(a.attachments[0].name, path.basename(afile)); assert.equal(a.attachments[0].excerpt, aText)
    await page.keyboard.press('Control+n')
    const b = await begin(bfile, '围绕这份灯具记录与检修笔记写一篇长文。')
    assert.equal(b.attachments[0].excerpt, bText)
    await page.locator('.session-item-main').filter({ hasText: a.originalTask }).click()
    await expect(page.locator('.grill-me-materials')).toContainText('已选素材')
    await page.locator('.grill-me-materials summary').click()
    await expect(page.locator('.grill-me-materials')).toContainText(path.basename(afile))
    await expect(page.locator('.grill-me-materials')).not.toContainText(path.basename(bfile))
    await app.close(); app = null
    // Complete only the deterministic fixture state while the process is closed;
    // selections themselves came from the actual desktop picker and IPC above.
    const repo = production.createRepository(path.join(home, 'deepwriter.db')); repo.open()
    const saved = repo.getGrillMeState(a.sessionId)
    const outline = { title: '潮位记录指南', premise: '区分缺测和真实零值，按原素材填写记录。', targetChars: 2000, sections: [{ id: 's1', title: '填写潮位', purpose: '解释缺测和零值的区别', beats: ['缺测留空，零值填写0'], targetChars: 2000, sourceSlotIds: ['original_task'] }] }
    repo.saveGrillMeState({ ...saved, targetChars: 2000, writingForm: 'expository', status: 'confirmed', currentQuestion: null, approvedOutline: outline, outline, outlineRevision: 1, outlineHash: production.grillMeOutlineHash(outline) }); repo.close()
    app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(12000)
    await page.locator('.session-item-main').filter({ hasText: a.originalTask }).click()
    const restore = page.getByRole('button', { name: `重新选择素材：${path.basename(afile)}`, exact: true })
    await restore.waitFor()
    const blocked = await page.evaluate(async id => {
      const ds = window.ds, actual = await ds.grillGet(id), pref = await ds.contextGetPreference(id)
      const grillMe = { stateId: actual.stateId, originalTask: actual.originalTask, targetChars: actual.targetChars, answers: [], assumptions: [], approvedOutline: actual.approvedOutline, outlineRevision: actual.outlineRevision, outlineHash: actual.outlineHash }
      try { await ds.contextPreview({ sessionId: id, mode: pref.mode, preferenceRevision: pref.revision, draftText: actual.originalTask, attachments: [], runMode: 'longwrite', longMode: true, phase: 'execute', targetChars: 2000, grillMe }); return 'unexpected success' }
      catch (error) { return String(error) }
    }, a.sessionId)
    assert.ok(blocked.includes(path.basename(afile)) && blocked.includes('重新选择原文件')); assert.equal(requests.length, 0)
    const interviewBlocked = await page.evaluate(async id => {
      const ds = window.ds, state = await ds.grillGet(id)
      await ds.grillAnswer({ sessionId: id, questionId: state.currentQuestion.id, value: '说明或论述', decision: 'answer' })
      for (let i = 0; i < 50; i++) {
        const current = await ds.grillGet(id)
        if (current.interview.status !== 'running') return current.interview.error
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }, b.sessionId)
    assert.ok(interviewBlocked.includes(path.basename(bfile))); assert.equal(requests.length, 0)
    await pick(bfile); await restore.click()
    await expect(page.getByRole('alert')).toContainText(`不是素材「${path.basename(afile)}」的原内容`)
    await pick(afile); await restore.focus(); await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(id => window.ds.grillGet(id).then(state => state.attachments[0].fileRefId), a.sessionId)).not.toBe(a.attachments[0].fileRefId)
    await expect(page.locator('.grill-me-materials summary')).not.toContainText('需重新选择')
    if (await page.locator('.grill-me-materials').getAttribute('open') === null) await page.locator('.grill-me-materials summary').click()
    await expect(restore).toHaveText('重新选择')
    if (process.env.DW_MATERIAL_SCREENSHOT) await page.locator('.grill-me-workbench').screenshot({ path: process.env.DW_MATERIAL_SCREENSHOT, animations: 'disabled', scale: 'css' })
    const result = await page.evaluate(async ({ a, b }) => {
      const ds = window.ds; await ds.setSettings({ ...(await ds.getSettings()), apiKey: 'synthetic-material-key' })
      const actual = await ds.grillGet(a.sessionId), pref = await ds.contextGetPreference(a.sessionId)
      const grillMe = { stateId: actual.stateId, originalTask: actual.originalTask, targetChars: actual.targetChars, answers: [], assumptions: [], approvedOutline: actual.approvedOutline, outlineRevision: actual.outlineRevision, outlineHash: actual.outlineHash }
      // A must win even against a forged B selection in both wire requests.
      const wrong = b.attachments.map(({ name, size, fileRefId }) => ({ name, size, fileRefId }))
      const preview = await ds.contextPreview({ sessionId: a.sessionId, mode: pref.mode, preferenceRevision: pref.revision, draftText: actual.originalTask, attachments: wrong, runMode: 'longwrite', longMode: true, phase: 'execute', targetChars: 2000, grillMe })
      const ack = await ds.chatStart({ id: 'materials-a-run', sessionId: a.sessionId, text: actual.originalTask, attachments: wrong, mode: 'longwrite', longMode: true, phase: 'execute', targetChars: 2000, grillMe, contextSelection: { mode: preview.mode, preferenceRevision: preview.policyRevision, previewId: preview.previewId } })
      return { state: actual, ack, config: (await ds.runsGet(ack.runId)).config, b: await ds.grillGet(b.sessionId) }
    }, { a, b })
    assert.equal(result.config.attachments.length, 1); assert.equal(result.config.attachments[0].name, path.basename(afile))
    assert.equal(result.config.attachments[0].hash, a.attachments[0].contentHash)
    assert.equal(result.config.grillMe.attachmentSelectionFrozen, true)
    assert.equal(result.b.attachments[0].contentHash, b.attachments[0].contentHash)
    await expect.poll(() => requests.length).toBeGreaterThan(0)
    const first = JSON.stringify(requests[0].messages)
    assert.ok(first.includes(aText)); assert.ok(!first.includes(bText)); assert.ok(!first.includes(path.basename(bfile)))
    await page.evaluate(id => window.ds.chatStop(id), result.ack.runId)
    // The reopened interview UI shows the correct original selection, never B.

  } finally { if (app) await app.close(); server.closeAllConnections(); server.close(); await cleanup(home) }
})
