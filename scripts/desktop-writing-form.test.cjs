const { test } = require('node:test')
const assert = require('node:assert/strict')
const { _electron, expect } = require('@playwright/test')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const launch = home => _electron.launch({ args: [process.env.DW_UI_BUILD_DIR ? path.join(root, process.env.DW_UI_BUILD_DIR, 'main/index.js') : root, '--user-data-dir=' + home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
function fixtures() {
  const mod = { exports: {} }
  const built = buildSync({ stdin: { contents: `export { createRepository } from './src/main/db/repository'; export { createGrillMeState, grillMeOutlineHash } from './src/shared/grillMe';`, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['node:sqlite'] })
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, mod, mod.exports)
  return mod.exports
}

test('桌面新采访可从会话列表跨重开找回，普通新会话不会被旧采访夺回', { timeout: 50000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-form-ui-'))
  let app
  try {
    const task = '围绕河岸仓库的那份值班记录写一篇长文。'
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, baseUrl: 'http://127.0.0.1:1' }))
    await fs.writeFile(path.join(home, '作者稿件.md'), '作者的现有稿件，不能被采访覆盖。')
    app = await launch(home)
    let page = await app.firstWindow(); page.setDefaultTimeout(12000)
    await page.getByRole('button', { name: '长文', exact: true }).click()
    const input = page.getByRole('textbox', { name: '创作构想', exact: true })
    await input.fill(task)
    await input.locator('..').locator('..').getByRole('button', { name: '开始梳理', exact: true }).click()
    await page.getByText('这篇稿子想用哪种写法？', { exact: true }).waitFor()
    const options = page.getByRole('group', { name: '快速回答' })
    const labels = await options.getByRole('button').allTextContents()
    assert.ok(labels.some(x => x.includes('说明或论述'))); assert.ok(labels.some(x => x.includes('小说或剧本')))
    const saved = await page.evaluate(async () => {
      for (const session of await window.ds.sessionsList()) { const state = await window.ds.grillGet(session.id); if (state) return state }
    })
    assert.ok(saved, 'A started interview must have a canonical session row')
    assert.equal(saved.genre, '未定'); assert.equal(saved.writingForm, 'open'); assert.equal(saved.interview.callCount, 0)
    await page.evaluate(async ({ id, task }) => {
      await window.ds.sessionsRename(id, '作者命名的值班记录')
      await window.ds.grillStart({ sessionId: id, originalTask: task, targetChars: 8000, genre: '未定', kind: '长文' })
    }, { id: saved.sessionId, task })
    const indexed = await page.evaluate(() => window.ds.sessionsList())
    assert.equal(indexed.find(s => s.id === saved.sessionId).title, '作者命名的值班记录')
    assert.equal(await page.evaluate(() => window.ds.grillLatestUnconsumed('unrelated-new-session')), null)
    await page.keyboard.press('Control+n')
    await page.getByRole('textbox', { name: '创作构想', exact: true }).waitFor()
    assert.equal(await page.locator('.grill-me-workbench').count(), 0)
    await app.close(); app = null
    app = await launch(home); page = await app.firstWindow(); page.setDefaultTimeout(12000)
    await page.locator('.session-item-main').filter({ hasText: '作者命名的值班记录' }).click()
    await page.getByText('这篇稿子想用哪种写法？', { exact: true }).waitFor()
    await expect(page.locator('main.workspace-novel')).toBeVisible()
    const restored = await page.evaluate(id => window.ds.grillGet(id), saved.sessionId)
    assert.equal(restored.stateId, saved.stateId); assert.equal(restored.writingForm, 'open'); assert.equal(restored.interview.callCount, 0)
    assert.equal(await fs.readFile(path.join(home, '作者稿件.md'), 'utf8'), '作者的现有稿件，不能被采访覆盖。')
    if (process.env.DW_FORM_SCREENSHOT) await page.screenshot({ path: process.env.DW_FORM_SCREENSHOT, scale: 'css' })
  } finally {
    if (app) await app.close()
    if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-form-ui-')) await fs.rm(home, { recursive: true, force: true })
  }
})

test('真实 IPC 正文预览和接受使用同一确认大纲；旧孤儿采访补索引不覆盖标题与稿件', { timeout: 50000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-form-canonical-'))
  const { createRepository, createGrillMeState, grillMeOutlineHash } = fixtures()
  const task = '为灯塔值班员写一份交接记录说明指南。'
  let state = createGrillMeState({ stateId: 'approved-form', sessionId: 'approved-session', originalTask: task, targetChars: 2000, genre: '说明文', now: 10, projectBrief: '冻结约定：缺测留空，零值填零。' })
  state.slots = state.slots.map(slot => ({ ...slot, answer: slot.id === 'format' ? '说明或论述' : '以已批准的交接记录为依据。', source: 'user' }))
  const outline = { title: '灯塔交接指南', premise: '区分缺测和零值，解释交接表。', targetChars: 2000, sections: [{ id: 's1', title: '读懂交接记录', purpose: '解释缺测和零值的填写规则。', beats: ['区分缺测和零值'], targetChars: 2000, sourceSlotIds: state.slots.map(slot => slot.id) }] }
  state = { ...state, status: 'confirmed', currentQuestion: null, writingForm: 'expository', outline, approvedOutline: outline, outlineRevision: 1, outlineHash: grillMeOutlineHash(outline) }
  const repo = createRepository(path.join(home, 'deepwriter.db')); repo.open()
  repo.saveGrillMeState(state) // Simulate a pre-fix orphan, without a sessions row.
  repo.createSession('keep-session', '作者自己的标题', 'fixture')
  repo.appendSessionMessage({ msg_id: 'author-message', session_id: 'keep-session', seq: 1, role: 'assistant', content: '作者现有正文', created_at: 1 })
  repo.saveGrillMeState({ ...state, stateId: 'existing-form', sessionId: 'keep-session', originalTask: '不可成为覆盖标题的新需求', updatedAt: 20 })
  repo.close()
  let app, calls = 0
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', data => { body += data }); request.on('end', () => {
      if (!request.url.endsWith('/chat/completions')) return response.writeHead(404).end()
      calls++
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '交接记录中，缺测与零值应分别标注。'.repeat(180) }, finish_reason: null }] }) + '\n\n')
      response.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 2500, total_tokens: 2530 } }) + '\n\n')
      response.end('data: [DONE]\n\n')
    })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await fs.writeFile(path.join(home, 'DEEPWRITER.md'), '磁盘中的新约定，不应代替采访时的冻结约定。')
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'deepseek-v4-flash', toolsEnabled: false, planMode: false }))
    app = await launch(home); const page = await app.firstWindow(); page.setDefaultTimeout(12000)
    await page.locator('.composer textarea').waitFor()
    const result = await page.evaluate(async ({ task, identity }) => {
      const ds = window.ds
      await ds.setSettings({ ...(await ds.getSettings()), apiKey: 'synthetic-canonical-form-key' })
      const sessions = await ds.sessionsList()
      const preserved = await ds.sessionsLoad('keep-session')
      const actual = await ds.grillGet(identity.sessionId)
      const pref = await ds.contextGetPreference(identity.sessionId)
      // Same identity shell, but stale/malicious renderer content and no writingForm.
      const grillMe = { stateId: actual.stateId, originalTask: actual.originalTask, targetChars: actual.targetChars, answers: [{ slotId: 'format', value: '伪造小说', source: 'user' }], assumptions: ['伪造假设'], approvedOutline: { ...actual.approvedOutline, premise: '伪造小说大纲' }, outlineRevision: 999, outlineHash: actual.outlineHash }
      const preview = await ds.contextPreview({ sessionId: identity.sessionId, mode: pref.mode, preferenceRevision: pref.revision, draftText: '过时的输入内容，不是已确认的原任务。', attachments: [], runMode: 'longwrite', longMode: true, phase: 'execute', targetChars: 9000, grillMe })
      const ack = await ds.chatStart({ id: 'canonical-form-run', sessionId: identity.sessionId, text: task, attachments: [], mode: 'longwrite', longMode: true, phase: 'execute', targetChars: actual.targetChars, grillMe, contextSelection: { mode: preview.mode, preferenceRevision: preview.policyRevision, previewId: preview.previewId } })
      const detail = await ds.runsGet(ack.runId)
      ds.chatStop(ack.runId)
      const ungated = []
      for (const [id, longMode] of [['ordinary-session', false], ['quick-session', true]]) {
        const preference = await ds.contextGetPreference(id)
        const fresh = await ds.contextPreview({ sessionId: id, mode: preference.mode, preferenceRevision: preference.revision, draftText: '直接写一段说明。', attachments: [], runMode: longMode ? 'longwrite' : 'agent', longMode, phase: 'execute', targetChars: 2000 })
        const accepted = await ds.chatStart({ id: id + '-run', sessionId: id, text: '直接写一段说明。', attachments: [], mode: longMode ? 'longwrite' : 'agent', longMode, quickBypass: longMode, phase: 'execute', targetChars: 2000, contextSelection: { mode: fresh.mode, preferenceRevision: fresh.policyRevision, previewId: fresh.previewId } })
        const run = await ds.runsGet(accepted.runId)
        ungated.push({ longMode: run.config.longMode, grillMe: run.config.grillMe, frozen: Boolean(run.config.frozenContext) })
        ds.chatStop(accepted.runId)
      }
      return { sessions, preserved, previewId: preview.previewId, ack, config: detail.config, ungated }
    }, { task, identity: state })
    assert.equal(result.sessions.find(session => session.id === 'keep-session').title, '作者自己的标题')
    assert.equal(result.sessions.find(session => session.id === state.sessionId).title, task)
    assert.equal(result.preserved[0].content, '作者现有正文')
    assert.equal(result.ack.runId, 'canonical-form-run')
    assert.equal(result.config.deepWrite.targetChars, 2000)
    assert.equal(result.config.grillMe.targetChars, 2000)
    assert.equal(result.config.grillMe.writingForm, 'expository')
    assert.equal(result.config.grillMe.outlineRevision, 1)
    assert.equal(result.config.grillMe.approvedOutline.premise, outline.premise)
    assert.ok(!JSON.stringify(result.config.grillMe).includes('伪造'))
    assert.ok(result.config.frozenSystemMessages.some(message => message.content.includes('冻结约定：缺测留空')))
    assert.ok(!result.config.frozenSystemMessages.some(message => message.content.includes('磁盘中的新约定')))
    assert.equal(result.config.sceneContracts, undefined)
    assert.deepEqual(result.ungated, [{ longMode: false, grillMe: undefined, frozen: true }, { longMode: true, grillMe: undefined, frozen: true }])
    assert.ok(result.config.frozenContext, 'An accepted matching preview must freeze successfully instead of context_preview_stale')
  } finally {
    if (app) await app.close()
    server.closeAllConnections(); server.close()
    if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-form-canonical-')) await fs.rm(home, { recursive: true, force: true })
  }
})
