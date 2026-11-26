const assert = require('node:assert/strict')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const built = buildSync({ entryPoints: [path.resolve(__dirname, '../src/cli/presentation.ts')], bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = new Module(__filename)
loaded._compile(built.outputFiles[0].text, __filename)
const { createHumanOutput, humanText } = loaded.exports

test('session listing identifies current durable session and bounds titles', () => {
  const text = humanText('sessions', { currentSessionId: 's2', sessions: [
    { session_id: 's1', title: '第一\n会话', model: 'm1' },
    { session_id: 's2', title: '第二会话', model: 'm2' }
  ] })
  assert.match(text, /第一 会话/)
  assert.match(text, /\* s2 · 第二会话 · m2/)
  assert.equal(humanText('sessions', { sessions: [] }), '暂无会话；输入任务或 /new 新建。')
})

test('human stream suppresses duplicate durable run updates but preserves content and result', () => {
  let out = '', error = ''
  const emit = createHumanOutput((text) => { out += text }, (text) => { error += text })
  for (let i = 0; i < 10; i++) emit('run', { runId: 'r1', status: 'running', phase: 'execute' })
  emit('event', { type: 'phase', title: '正在写作', detail: '正文' })
  emit('event', { type: 'phase', title: '正在写作', detail: '正文' })
  emit('delta', { actor: 'writer', text: '实际回复' })
  emit('result', { runId: 'r1', status: 'waiting_user' })
  assert.equal(out, '实际回复\n')
  assert.equal(error, '正在写作 · 正文\nr1 · waiting_user\n')
})

test('edit history names the exact durable tool and exposes a bounded undo action', () => {
  const text = humanText('changes', { changes: [{ runId: 'run-1', toolCallId: 'provider-call-27', summary: '已替换 2 处', before: '小曲', after: '小禾', undo: { status: 'available' } }] })
  assert.match(text, /RUN run-1 · TOOL provider-call-27/)
  assert.match(text, /撤销：undo-edit run-1 provider-call-27/)
  assert.match(humanText('changes', { changes: [{ runId: 'r', toolCallId: 't', undo: { status: 'undone' } }] }), /已撤销/)
  assert.ok(!humanText('changes', { changes: [{ runId: 'r', toolCallId: 'evil\u001b[31m', undo: { status: 'available' } }] }).includes('\u001b'))
  let out = ''
  const emit = createHumanOutput(text => { out += text }, () => {})
  emit('undo_edit', { ok: false, status: 'blocked', code: 'file_changed', message: '稿件后来又有修改，未覆盖' })
  assert.equal(out, '稿件后来又有修改，未覆盖 · file_changed\n')
})


const fs = require('node:fs/promises')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const ioBuilt = buildSync({ stdin: { contents: `export * from './src/cli/input'; export * from './src/cli/output'; export * from './src/cli/terminal'`, resolveDir: path.resolve(__dirname, '..'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false })
const ioLoaded = new Module(__filename)
ioLoaded._compile(ioBuilt.outputFiles[0].text, __filename)
const { readPromptStream, prepareOutput, saveOutput, createTerminalQuestion, CliPromptInterrupted } = ioLoaded.exports

test('UTF-8 chunks split inside Chinese and emoji stay intact; invalid and overlarge input fails', async () => {
  async function* chunks(values) { yield* values }
  const text = '灯塔🌊\n\n第二段。'
  const bytes = Buffer.from(text)
  assert.equal(await readPromptStream(chunks(Array.from(bytes, byte => Buffer.from([byte])))), text)
  await assert.rejects(readPromptStream(chunks([Buffer.from([0xe4, 0xb8])])), /UTF-8/)
  await assert.rejects(readPromptStream(chunks(['x'.repeat(1_000_001)])), /100万/)
  await assert.rejects(readPromptStream(chunks(['  \n'])), /不能为空/)
})

test('final output publishes whole text exclusively, preserving a racing user file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-cli-output-'))
  try {
    const target = await prepareOutput(path.join(dir, '正文.md'))
    await fs.writeFile(target, '用户先保存的稿件')
    await assert.rejects(saveOutput(target, '模型正文'), /拒绝覆盖/)
    assert.equal(await fs.readFile(target, 'utf8'), '用户先保存的稿件')
    assert.deepEqual(await fs.readdir(dir), ['正文.md'])
    await assert.rejects(prepareOutput(target), /拒绝覆盖/)
    const fresh = await prepareOutput(path.join(dir, '新稿.md'))
    await saveOutput(fresh, '最终正文🌊\n\n第二段。')
    assert.equal(await fs.readFile(fresh, 'utf8'), '最终正文🌊\n\n第二段。')
    assert.deepEqual((await fs.readdir(dir)).sort(), ['新稿.md', '正文.md'].sort())
  } finally {
    assert.equal(path.dirname(dir), os.tmpdir())
    assert.ok(path.basename(dir).startsWith('deepwriter-cli-output-'))
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('terminal queues every pasted line including blanks and clears pending input on interrupt', async () => {
  const terminal = new EventEmitter()
  terminal.setPrompt = () => {}; terminal.prompt = () => {}
  const question = createTerminalQuestion(terminal)
  const controller = new AbortController()
  const first = question('DeepWriter', controller.signal)
  for (const line of ['/paste', '第一段', '', '  第二段', '/send']) terminal.emit('line', line)
  assert.equal(await first, '/paste')
  assert.equal(await question('', controller.signal), '第一段')
  assert.equal(await question('', controller.signal), '')
  assert.equal(await question('', controller.signal), '  第二段')
  assert.equal(await question('', controller.signal), '/send')
  const pending = question('DeepWriter', controller.signal)
  controller.abort()
  await assert.rejects(pending, CliPromptInterrupted)
  const next = question('DeepWriter', new AbortController().signal)
  terminal.emit('line', '新的输入')
  assert.equal(await next, '新的输入')
  terminal.emit('line', 'allow')
  question.discardPending()
  const auth = new AbortController()
  const permission = question('授权', auth.signal)
  auth.abort()
  await assert.rejects(permission, CliPromptInterrupted, 'pretyped allow must not authorize a later action')
  const closing = question('DeepWriter', new AbortController().signal)
  terminal.emit('close')
  await assert.rejects(closing, CliPromptInterrupted)
  await assert.rejects(question('DeepWriter', new AbortController().signal), CliPromptInterrupted)
})
