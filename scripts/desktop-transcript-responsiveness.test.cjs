// Actual Electron main -> preload -> store -> virtualized transcript workload.
// Replay fixed IPC deltas, not model output speed. No content is omitted.
// QA: unchanged text on reasoning/tool/receipt updates, changed text and GFM
// references, copy feedback/focus, manual scroll/follow, history and rapid switch.
// Optional same-input comparison: DW_TRANSCRIPT_BEFORE_BUILD=out/transcript-before
// DW_UI_BUILD_DIR=out/transcript-after node --test scripts/desktop-transcript-responsiveness.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '..'), evidence = path.join(root, 'out/transcript-latency')
const marker = 'TRANSCRIPT_PERF_SENTINEL'
const body = `# ${marker}\n\n已经写好：\`报告.md\`。\n\n` + Array.from({ length: 52 }, (_, i) =>
  `## 第 ${i + 1} 节\n\n这是**同一篇长回复**的内容，保留中文、😀、链接[后文定义][source]与所有段落。${'证据与叙述相互校正，读取历史不应重做语法分析。'.repeat(7)}\n\n| 项目 | 状态 |\n| --- | --- |\n| ${i} | 已核对 |\n\n`).join('') +
  '\n```javascript\nconst answer = "保留复制状态";\n```\n\n[source]: https://example.com/evidence\n'
assert(body.length < 20000, 'fixture is fully visible under the existing display limit')
const hiddenMain = `
const Module = require('node:module'), electron = require('electron');
const OriginalWindow = electron.BrowserWindow;
const HiddenWindow = new Proxy(OriginalWindow, {
 construct(Target, [options]) {
  const win = new Target({ ...options, show: false, focusable: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
  win.show = win.showInactive = win.focus = () => {}; return win;
 },
 get(Target, key) { const value = Reflect.get(Target, key); return typeof value === 'function' && key !== 'prototype' ? value.bind(Target) : value; }
});
const isolatedElectron = Object.create(electron);
Object.defineProperty(isolatedElectron, 'BrowserWindow', { value: HiddenWindow });
const load = Module._load;
Module._load = function(request, parent, main) { return request === 'electron' ? isolatedElectron : load.call(this, request, parent, main); };
const handle = electron.ipcMain.handle.bind(electron.ipcMain);
electron.ipcMain.handle = (channel, listener) => handle(channel, channel === 'chatFiles:resolve' ? async (...args) => {
 await new Promise(resolve => setTimeout(resolve, 100)); return listener(...args);
} : listener);
require(process.env.DW_TRANSCRIPT_ENTRY);
`

// Instrument a throwaway copy of the built parser, never application source.
// The measured region is the actual synchronous ReactMarkdown parse/transform
// and React-tree construction, excluding highlight, layout and network time.
async function instrument(buildDir, home) {
  const target = path.join(home, 'build'); await fs.cp(path.resolve(root, buildDir), target, { recursive: true })
  await fs.symlink(path.join(root, 'node_modules'), path.join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const assets = path.join(target, 'renderer/assets')
  let hits = 0
  for (const name of await fs.readdir(assets)) {
    if (!name.endsWith('.js')) continue
    const file = path.join(assets, name), original = await fs.readFile(file, 'utf8')
    const needle = 'return post(processor.runSync(processor.parse(file), file), options);'
    if (!original.includes(needle)) continue
    const replacement = `const __start = performance.now(); const __result = post(processor.runSync(processor.parse(file), file), options);
      if (String(options.children).includes('${marker}')) { const p = window.__markdownProbe ??= { calls: 0, ms: 0 }; p.calls++; p.ms += performance.now() - __start; } return __result;`
    await fs.writeFile(file, original.replace(needle, replacement)); hits++
  }
  assert.equal(hits, 1, 'instrument exactly the production synchronous parser')
  return path.join(target, 'main/index.js')
}
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

async function sample(buildDir, label, functional) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-transcript-perf-'))
  let app, db
  try {
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, webAccessEnabled: false }))
    await fs.writeFile(path.join(home, '报告.md'), '真实文件回执作用域。')
    const entry = await instrument(buildDir, home), bootstrap = path.join(home, 'main.cjs')
    await fs.writeFile(bootstrap, hiddenMain)
    app = await _electron.launch({ cwd: root, args: [bootstrap, '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'], env: { ...process.env, DEEPWRITER_API_KEY: '', NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home, DW_TRANSCRIPT_ENTRY: entry } })
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.getByRole('textbox', { name: '任务内容' }).waitFor()
    db = new DatabaseSync(path.join(home, 'deepwriter.db')); db.exec('PRAGMA busy_timeout=3000')
    const now = Date.now(), runId = 'transcript-run', messageId = `m_${runId}_assistant`
    for (const [id, title, content] of [['transcript-a', '长回复性能 A', body], ['transcript-b', '独立历史 B', '另一会话，不应出现 A 的文件链接。']]) {
      db.prepare('INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run(id, title, now, now)
      db.prepare('INSERT INTO session_messages(msg_id,session_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run(id === 'transcript-a' ? messageId : 'history-b', id, 1, 'assistant', content, now)
    }
    db.prepare('INSERT INTO runs(run_id,session_id,status,phase,started_at,updated_at,config_json) VALUES(?,?,?,?,?,?,?)').run(runId, 'transcript-a', 'completed', 'completed', now, now, JSON.stringify({ runMode: 'agent', workDir: home, docDir: home }))
    db.prepare('INSERT INTO turns(turn_id,run_id,turn_seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run('transcript-turn', runId, 1, 'assistant', body, now)
    await page.reload(); await page.getByRole('textbox', { name: '任务内容' }).waitFor()
    const a = page.locator('.session-item').filter({ hasText: '长回复性能 A' }).getByRole('button').first()
    const b = page.locator('.session-item').filter({ hasText: '独立历史 B' }).getByRole('button').first()
    await a.click()
    await expect(page.locator('.markdown-body h2')).toHaveCount(52)
    await expect(page.locator('.file-action-link')).toHaveCount(1)
    assert.equal(await page.locator('.file-action-link').getAttribute('title'), path.join(home, '报告.md'))
    assert.equal(await page.locator('a[href="https://example.com/evidence"]').count(), 52, 'whole-document reference links stay resolved')
    const initial = await page.evaluate(() => ({ ...window.__markdownProbe }))
    const emit = ev => app.evaluate(({ BrowserWindow }, data) => BrowserWindow.getAllWindows()[0].webContents.send('chat:event', data), { id: messageId, ev })
    // Mount the thinking view before timing, then ensure every replayed delta
    // commits (no claim based on coalescing/dropping unseen intermediate work).
    await emit({ type: 'reasoning', delta: '开始核对。' })
    await expect(page.locator('.message-process')).toHaveCount(1)
    await page.locator('.message-process > summary').click()
    await page.getByRole('button', { name: /思考过程/ }).click()
    await expect(page.locator('.thinking-body')).toContainText('开始核对。')
    await frames(page)
    await page.evaluate(() => { window.__markdownProbe = { calls: 0, ms: 0 } })
    const updateMs = [], start = performance.now()
    for (let i = 0; i < 24; i++) {
      const delta = `[核对${i}]`, tick = performance.now()
      await emit({ type: 'reasoning', delta })
      await expect(page.locator('.thinking-body')).toContainText(delta)
      await frames(page); updateMs.push(performance.now() - tick)
    }
    const reasoning = { ...(await page.evaluate(() => ({ ...window.__markdownProbe }))), wallMs: performance.now() - start, updateMs }
    await page.evaluate(() => { window.__markdownProbe = { calls: 0, ms: 0 } })
    for (let i = 0; i < 4; i++) {
      await emit({ type: 'tool_call', tool: { id: `read-${i}`, name: 'read_file', arguments: '{}' } })
      await expect(page.locator('.tool-card')).toHaveCount(i + 1)
      await emit({ type: 'tool_result', toolResult: { toolId: `read-${i}`, name: 'read_file', ok: true, result: `已读取${i}` } })
      await expect(page.locator('.tool-card.done')).toHaveCount(i + 1)
    }
    // Wait for the real delayed file-resolution response after the last revision.
    await expect(page.locator('.file-action-link')).toHaveCount(1); await frames(page)
    const tools = await page.evaluate(() => ({ ...window.__markdownProbe }))
    if (functional) {
      assert.equal(reasoning.calls, 0, 'reasoning does not parse unchanged body')
      assert.equal(tools.calls, 0, 'tool states and async receipt refresh do not parse unchanged body')
      await page.locator('.message-list').evaluate(element => { element.scrollTop = element.scrollHeight })
      await frames(page)
      const codeCopy = page.locator('.code-block-header button')
      await codeCopy.click(); await expect(codeCopy).toHaveText('已复制')
      await codeCopy.focus()
      await emit({ type: 'reasoning', delta: '[保留按钮状态]' })
      await expect(page.locator('.thinking-body')).toContainText('[保留按钮状态]')
      await expect(codeCopy).toHaveText('已复制'); await expect(codeCopy).toBeFocused()
      const scroller = page.locator('.message-list')
      await scroller.hover(); await page.mouse.wheel(0, -450); await frames(page)
      await expect(page.getByRole('button', { name: '↓ 回到最新' })).toBeVisible()
      const scrollBefore = await scroller.evaluate(element => element.scrollTop)
      await emit({ type: 'reasoning', delta: '[手动上滚后保持位置]' })
      await expect(page.locator('.thinking-body')).toContainText('[手动上滚后保持位置]'); await frames(page)
      assert(Math.abs(await scroller.evaluate(element => element.scrollTop) - scrollBefore) < 3)
      await page.getByRole('button', { name: '↓ 回到最新' }).click(); await frames(page)
      assert(await scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight) < 96)
      // A real text delta must still reparse, including references defined at
      // the document end; replacement/retry/terminal ordering remains in store.
      const beforeText = await page.evaluate(() => window.__markdownProbe.calls)
      await emit({ type: 'text', delta: '\n\n新增正文 [再看证据][source]。' })
      await expect(page.locator('.markdown-body')).toContainText('新增正文')
      await expect(page.locator('a[href="https://example.com/evidence"]')).toHaveCount(53)
      assert(await page.evaluate(() => window.__markdownProbe.calls) > beforeText)
      await emit({ type: 'done', finishReason: 'stopped' })
      await expect(page.locator('.msg-meta')).toContainText('已停止')
      await page.getByRole('textbox', { name: '任务内容' }).fill('未发送的草稿')
      const beforeTyping = await page.evaluate(() => window.__markdownProbe.calls)
      await page.getByRole('textbox', { name: '任务内容' }).press('End')
      await page.getByRole('textbox', { name: '任务内容' }).pressSequentially('继续输入', { delay: 1 })
      await frames(page); assert.equal(await page.evaluate(() => window.__markdownProbe.calls), beforeTyping)
      // Switch while a delayed resolution is outstanding, then switch back.
      await b.click(); await expect(page.locator('.msg.assistant')).toContainText('另一会话')
      await a.click(); await expect(page.locator('.markdown-body h2')).toHaveCount(52)
      await b.click(); await expect(page.locator('.msg.assistant')).toContainText('另一会话')
      await page.waitForTimeout(180); assert.equal(await page.locator('.file-action-link').count(), 0)
      await a.click(); await expect(page.locator('.file-action-link')).toHaveCount(1)
      await expect(page.getByRole('textbox', { name: '任务内容' })).toHaveValue('未发送的草稿继续输入')
      await page.locator('.message-list').evaluate(element => { element.scrollTop = 0 }); await frames(page)
      await page.screenshot({ path: path.join(evidence, 'transcript-history.png'), animations: 'disabled', scale: 'css' })
    }
    const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })))
    assert(native.every(w => !w.visible && !w.focused), 'isolated QA never takes the user foreground')
    return { label, bodyUtf16Units: body.length, bodyCodePoints: Array.from(body).length, reasoningCommits: 24, toolCycles: 4, initial, reasoning, tools }
  } finally {
    db?.close(); await app?.close().catch(() => {})
    assert.equal(path.dirname(home), os.tmpdir()); assert(path.basename(home).startsWith('dw-transcript-perf-'))
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

test('Electron unchanged long reply skips Markdown parsing without losing file, code, text, scroll or history behavior', { timeout: 120000 }, async t => {
  await fs.mkdir(evidence, { recursive: true })
  const results = []
  if (process.env.DW_TRANSCRIPT_BEFORE_BUILD) results.push(await sample(process.env.DW_TRANSCRIPT_BEFORE_BUILD, 'before', false))
  results.push(await sample(process.env.DW_UI_BUILD_DIR || 'out', 'after', true))
  const report = { environment: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model }, scope: 'Electron renderer replay over actual main/preload IPC; fixed history and 24 separately committed reasoning deltas plus 4 tool cycles; parser CPU and harness update-to-two-rAF wall time, not provider TPS', results }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  for (const r of results) t.diagnostic(JSON.stringify(r))
})
