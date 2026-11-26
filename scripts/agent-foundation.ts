import { readProjectBrief, saveProjectBrief } from '../src/main/projectBrief'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCommand, agentTools } from '../src/main/agentTools'
import { activeChildProcesses } from '../src/main/childRegistry'
import { createCheckpointStore, getCheckpointStore, setCheckpointStore } from '../src/main/checkpoint'
import { boundedInteger, readTextBounded, writeTextAtomically } from '../src/main/agentFiles'
import { normalizeLongTarget } from '../src/renderer/src/writingMode'
import { decodeToolResult } from '../src/main/toolResultView'
import { parseCommandLine } from '../src/main/permissions'
import { modelVisibleOutput } from '../src/main/jobs/toolTurnOutput'
import { parseFileSources } from '../src/shared/fileEvidence'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-agent-foundation-'))
const runScript = async (name: string, source: string, signal?: AbortSignal, timeout = 3000) => {
  const file = path.join(root, name + '.cjs')
  await fs.writeFile(file, source)
  return runCommand(`"${process.execPath}" "${file}"`, root, timeout, signal)
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('Windows 引号路径保留目录分隔符、UNC 和空格', () => {
  assert.deepEqual(parseCommandLine(String.raw`"C:\Program Files\node.exe" "C:\work\中文 文件.cjs"`, 'win32'), [String.raw`C:\Program Files\node.exe`, String.raw`C:\work\中文 文件.cjs`])
  assert.deepEqual(parseCommandLine(String.raw`"\\server\share\tool.exe" "C:\work\\" "say \"hello\""`, 'win32'), [String.raw`\\server\share\tool.exe`, 'C:\\work\\', 'say "hello"'])
  assert.equal(parseCommandLine(String.raw`"C:\tools\node.exe" && echo bad`, 'win32'), null)
})

test('POSIX 双引号保留普通反斜杠并正确解开引号转义', () => {
  assert.deepEqual(parseCommandLine(String.raw`echo "C:\files\文稿.txt" "a\\b\"c"`, 'linux'), ['echo', String.raw`C:\files\文稿.txt`, 'a\\b"c'])
  assert.equal(parseCommandLine('echo "unfinished', 'linux'), null)
})

test('持久化工具结果解开引擎包装，保留目录输出和退出码', () => {
  const message = '目录结构：\nREADME.md\npackage.json\nnotes.txt'
  assert.deepEqual(decodeToolResult({ status: 'completed', resultJson: JSON.stringify({ content: JSON.stringify({ ok: true, message, exitCode: 0 }) }) }), { ok: true, result: message, exitCode: 0 })
  assert.deepEqual(decodeToolResult({ status: 'completed', resultJson: JSON.stringify({ ok: true, message }) }), { ok: true, result: message, exitCode: null })
})

test('执行器返回失败与引擎失败都不会展示为成功', () => {
  assert.deepEqual(decodeToolResult({ status: 'completed', resultJson: JSON.stringify({ content: JSON.stringify({ ok: false, message: '用户拒绝了该路径访问', exitCode: 1 }) }) }), { ok: false, result: '用户拒绝了该路径访问', exitCode: 1 })
  assert.deepEqual(decodeToolResult({ status: 'failed', resultJson: JSON.stringify({ error: '工具参数 JSON 解析失败' }) }), { ok: false, result: '工具参数 JSON 解析失败', exitCode: null })
  assert.equal(decodeToolResult({ status: 'cancelled', resultJson: JSON.stringify({ ok: true, message: '已停止' }) }).ok, false)
})

test('普通文本、摘要与旧工具记录可读，错误类型不伪造退出码', () => {
  for (const result of ['直接输出', '[结果已保存为附件]', '{broken']) {
    assert.equal(decodeToolResult({ status: 'completed', resultJson: JSON.stringify({ content: result }) }).result, result)
    assert.equal(decodeToolResult({ status: 'completed', resultJson: result }).result, result)
  }
  assert.equal(decodeToolResult({ status: 'completed', resultJson: JSON.stringify({ content: JSON.stringify({ message: '完成', exitCode: '0' }) }) }).exitCode, null)
})

test('命令输出跨 UTF-8 字节边界仍完整', async () => {
  const result = await runScript('utf8', "const b=Buffer.from('中文输出'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),20)")
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, '中文输出')
  assert.equal(activeChildProcesses().length, 0)
})

test('非交互命令的 stdin 关闭，不会等待用户输入', async () => {
  const result = await runScript('stdin', "process.stdin.on('end',()=>process.stdout.write('closed')); process.stdin.resume()")
  assert.equal(result.stdout, 'closed')
  assert.equal(result.timedOut, false)
})

test('已取消的命令不启动进程', async () => {
  const controller = new AbortController()
  controller.abort()
  const marker = path.join(root, 'should-not-exist')
  const result = await runScript('pre-abort', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`, controller.signal)
  assert.equal(result.cancelled, true)
  assert.equal(result.timedOut, false)
  await assert.rejects(fs.access(marker))
})

test('命令超时与用户取消分别报告', async () => {
  const result = await runScript('timeout', 'setInterval(()=>{},1000)', undefined, 100)
  assert.equal(result.timedOut, true)
  assert.equal(result.cancelled, false)
  assert.equal(activeChildProcesses().length, 0)
})

test('停止命令时同时终止派生的子进程', async () => {
  const heartbeat = path.join(root, 'heartbeat')
  const source = `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(heartbeat)},'ready'); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20)`
  const child = path.join(root, 'descendant.cjs')
  await fs.writeFile(child, source)
  const controller = new AbortController()
  const execution = runScript('parent', `require('child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'ignore'}); setInterval(()=>{},1000)`, controller.signal, 5000)
  try {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try { await fs.access(heartbeat); break } catch { await new Promise((r) => setTimeout(r, 20)) }
    }
    await fs.access(heartbeat)
    controller.abort()
    const result = await execution
    assert.equal(result.cancelled, true)
    assert.equal(result.timedOut, false)
    const size = (await fs.stat(heartbeat)).size
    await new Promise((r) => setTimeout(r, 200))
    assert.equal((await fs.stat(heartbeat)).size, size, '派生进程不能在停止后继续写文件')
    assert.equal(activeChildProcesses().length, 0)
  } finally {
    controller.abort()
    await execution
  }
})

test('启动失败直接拒绝，不由 close 事件伪装成执行结果', async () => {
  await assert.rejects(runCommand('deepwriter-command-that-does-not-exist', root), { code: 'ENOENT' })
  assert.equal(activeChildProcesses().length, 0)
})

test('Windows .cmd 与省略扩展名路径均可取消', { skip: process.platform !== 'win32' }, async () => {
  const file = path.join(root, 'slow-command.cmd')
  const slow = path.join(root, 'slow-command.cjs')
  await fs.writeFile(slow, 'setInterval(()=>{},1000)')
  await fs.writeFile(file, `@"${process.execPath}" "${slow}"\r\n`)
  for (const program of [file, file.slice(0, -4)]) {
    const controller = new AbortController()
    const running = runCommand(`"${program}"`, root, 5000, controller.signal)
    setTimeout(() => controller.abort(), 200)
    const result = await running
    assert.equal(result.cancelled, true)
    assert.equal(result.timedOut, false)
  }
})

test('大文件按字符上限读取，保留完整中文', async () => {
  const file = path.join(root, 'large.txt')
  await fs.writeFile(file, '中文'.repeat(1_000_000))
  assert.equal(await readTextBounded(file, 13), '中文中文中文中文中文中文中')
  assert.equal(boundedInteger('invalid', 50, 1, 200), 50)
  assert.equal(boundedInteger(-1, 50, 1, 200), 1)
})

test('原子写入保留权限并清理临时文件', async () => {
  const file = path.join(root, 'atomic.txt')
  await fs.writeFile(file, 'before', { mode: 0o640 })
  const mode = (await fs.stat(file)).mode
  await writeTextAtomically(file, 'after')
  assert.equal(await fs.readFile(file, 'utf8'), 'after')
  assert.equal((await fs.stat(file)).mode, mode)
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.deepwriter-')), false)
})

test('取消写入保留原文件；提交失败清理临时文件', async () => {
  const file = path.join(root, 'cancelled.txt')
  await fs.writeFile(file, 'keep')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(writeTextAtomically(file, 'replace', controller.signal))
  assert.equal(await fs.readFile(file, 'utf8'), 'keep')
  await assert.rejects(writeTextAtomically(root, 'not a directory'))
  assert.equal((await fs.readdir(path.dirname(root))).some((name) => name.startsWith('.deepwriter-')), false)
})

test('文件工具在已取消时拒绝写入，空替换片段拒绝执行', async () => {
  const controller = new AbortController()
  controller.abort()
  const env = { workDir: root, docDir: root, signal: controller.signal }
  const write = agentTools.find((tool) => tool.name === 'write_file')!
  const edit = agentTools.find((tool) => tool.name === 'edit_file')!
  const file = path.join(root, 'tool.txt')
  await fs.writeFile(file, 'unchanged')
  assert.equal((await write.execute({ path: file, content: 'bad' }, root, env)).ok, false)
  assert.equal((await edit.execute({ path: file, old_text: 'unchanged', new_text: 'bad' }, root, env)).ok, false)
  assert.equal((await edit.execute({ path: file, old_text: '', new_text: 'bad' }, root)).ok, false)
  assert.equal(await fs.readFile(file, 'utf8'), 'unchanged')
})

test('目录列表有上限，超大目录显式提示继续查看', async () => {
  const dir = path.join(root, 'wide')
  await fs.mkdir(dir)
  for (let i = 0; i < 220; i++) await fs.writeFile(path.join(dir, `${i}-${'x'.repeat(90)}.txt`), '')
  const list = agentTools.find((tool) => tool.name === 'list_files')!
  const result = await list.execute({ path: dir, depth: 'invalid' }, root)
  assert.equal(result.ok, true)
  assert.ok(result.message.length < 16100)
  assert.match(result.message, /目录较大/)
  const missing = await list.execute({ path: path.join(root, 'missing') }, root)
  assert.equal(missing.ok, false)
  assert.match(missing.message, /列目录失败/)
})

test('搜索保留命中，并报告跳过的大文件和结果上限', async () => {
  const dir = path.join(root, 'search')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, 'a-large.txt'), 'needle'.repeat(400_000))
  await fs.writeFile(path.join(dir, 'b-small.txt'), 'needle\nneedle\n')
  const search = agentTools.find((tool) => tool.name === 'search_files')!
  const result = await search.execute({ path: dir, pattern: 'needle', max_results: 1 }, root)
  assert.equal(result.ok, true)
  assert.match(result.message, /b-small.txt:1:/)
  assert.match(result.message, /跳过 1 个大于 2 MB/)
  assert.match(result.message, /结果条数上限/)
  const controller = new AbortController()
  controller.abort()
  assert.equal((await search.execute({ path: dir, pattern: 'needle' }, root, { workDir: root, docDir: root, signal: controller.signal })).ok, false)
})

test('长文目标统一限制范围并拒绝非有限数值', () => {
  assert.equal(normalizeLongTarget(NaN), 2000)
  assert.equal(normalizeLongTarget(Infinity), 2000)
  assert.equal(normalizeLongTarget(-100), 2000)
  assert.equal(normalizeLongTarget(10000.99), 10000)
  assert.equal(normalizeLongTarget(9000000), 2000000)
})

const readTool = agentTools.find(tool => tool.name === 'read_file')!
const pageEnv = { workDir: root, docDir: root, pagedFileReads: true }
const readPage = (file: string, args: Record<string, unknown> = {}) => readTool.execute({ path: file, ...args }, root, pageEnv)
const bodyOf = (message: string) => message.slice(message.indexOf('\n') + 1)
const cursorOf = (message: string) => message.split('\n', 1)[0].match(/cursor=(p1:[0-9a-z.:-]+)/)?.[1]

test('在子目录搜索后，命中的路径和行号能直接读取原稿', async () => {
  await fs.mkdir(path.join(root, 'manuscript'))
  const rows = Array.from({ length: 1200 }, (_, i) => i === 920 ? '铜钥匙在渡口出现。' : '这一页记事：' + (i + 1))
  await fs.writeFile(path.join(root, 'manuscript', '河岸.md'), rows.join('\r\n'))
  const search = agentTools.find(tool => tool.name === 'search_files')!
  const hit = await search.execute({ path: 'manuscript', pattern: '铜钥匙' }, root, pageEnv)
  const found = /([^\r\n:]+\.md):(\d+):/.exec(hit.message)
  assert.ok(found, hit.message)
  assert.equal(+found[2], 921)
  const excerpt = await readPage(found[1], { start_line: +found[2] - 1, line_count: 3 })
  assert.equal(excerpt.ok, true, excerpt.message)
  assert.equal(bodyOf(excerpt.message), rows.slice(919, 922).join('\r\n') + '\r\n')
  assert.ok(cursorOf(excerpt.message))
  const last = await readPage(found[1], { start_line: 1200 })
  assert.equal(bodyOf(last.message), rows[1199]); assert.equal(cursorOf(last.message), undefined)
  assert.equal((await readPage(found[1], { start_line: 1201 })).ok, false)
})

test('长段分页无漏字重字：补充平面字符、JSON 转义、CRLF 和空行原样保留', async () => {
  const file = 'long-paragraph.md'
  const draft = '\uFEFF' + '叙𠮷🙂'.repeat(8100) + '\r\n\r\n' + '"\\\t\u0001'.repeat(2300) + '结尾。'
  await fs.writeFile(path.join(root, file), draft)
  let cursor: string | undefined, text = '', pages = 0
  do {
    const r = await readPage(file, cursor ? { cursor } : {})
    assert.equal(r.ok, true, r.message.slice(0, 150))
    // Provider pages stay below spill size. The local receipt additionally
    // retains the exact source snapshot for author review, never paid twice.
    assert.ok(modelVisibleOutput('read_file', JSON.stringify(r)).length < 20000)
    assert.ok(JSON.stringify(r).length < 50000)
    assert.equal(parseFileSources(r.sources)[0]?.excerpt, bodyOf(r.message))
    const page = bodyOf(r.message)
    assert.ok(page.length > 0 && !/[\uD800-\uDFFF]/u.test(page))
    text += page; cursor = cursorOf(r.message)
    assert.ok(++pages < 15)
  } while (cursor)
  assert.ok(pages >= 4)
  assert.equal(text, draft)
  const one = await readPage(file, { start_line: 1, max_chars: 3 })
  assert.equal(bodyOf(one.message), '\uFEFF叙𠮷')
})

test('续读需要同一版本的稿件；旧任务及显式前缀读取保持原行为', async () => {
  const file = 'cursor-version.md', dest = path.join(root, file), original = '甲'.repeat(12000)
  await fs.writeFile(dest, original); await fs.writeFile(path.join(root, 'other.md'), original)
  const c = cursorOf((await readPage(file)).message)
  assert.ok(c)
  assert.equal((await readPage('other.md', { cursor: c })).ok, false)
  assert.equal((await readPage(file, { cursor: c, start_line: 1 })).ok, false)
  assert.equal((await readPage(file, { cursor: 'garbled' })).ok, false)
  assert.equal(bodyOf((await readTool.execute({ path: file }, root)).message), original)
  assert.equal(bodyOf((await readPage(file, { max_chars: 12000 })).message), original)
  await fs.writeFile(dest, '乙'.repeat(12000)); const t = new Date(Date.now() + 5000); await fs.utimes(dest, t, t)
  const stale = await readPage(file, { cursor: c })
  assert.equal(stale.ok, false); assert.match(stale.message, /文件已更改/)
  const controller = new AbortController(); controller.abort()
  assert.equal((await readTool.execute({ path: file, start_line: 1 }, root, { ...pageEnv, signal: controller.signal })).ok, false)
})

const editTool = agentTools.find(tool => tool.name === 'edit_file')!
const doEdit = (file: string, args: Record<string, unknown>) => editTool.execute({ path: file, ...args }, root)
test('改稿定位、逐字写入、原稿行号：混合换行、BOM 与美元符号均保留', async () => {
  const file = path.join(root, 'literal.md')
  const before = '\uFEFF序章。\n她说。\r\n天亮了。\r\n后记。\n她说。\r\n天亮了。'
  await fs.writeFile(file, before)
  const payload = { old_text: '她说。\n天亮了。', new_text: "她说 $&、$$、$' 与 $1。\n雪停了。" }
  const ambiguous = await doEdit(file, payload)
  assert.equal(ambiguous.ok, false); assert.match(ambiguous.message, /匹配到 2 处（第 2、5 行/); assert.equal(await fs.readFile(file, 'utf8'), before)
  const selected = await doEdit(file, { ...payload, at_line: 5 })
  assert.ok(selected.ok, selected.message); assert.deepEqual(selected.edit, { count: 1, lines: [5] })
  const expected = before.slice(0, before.lastIndexOf('她说。')) + payload.new_text.replace('\n', '\r\n')
  assert.equal(await fs.readFile(file, 'utf8'), expected)
  assert.match(selected.diffText!, /\+雪停了。/); assert.equal(selected.diffAdded, 2); assert.equal(selected.diffRemoved, 2)
  const all = await doEdit(file, { old_text: '她说', new_text: '他问', replace_all: true })
  assert.ok(all.ok, all.message); assert.deepEqual(all.edit, { count: 2, lines: [2, 5] })
  assert.equal(await fs.readFile(file, 'utf8'), expected.split('她说').join('他问'))
})

test('不猜原文：重叠、错误参数、无效编码不落盘；同文不触碰文件', async () => {
  const file = path.join(root, 'unchanged-edit.txt'), text = '啦啦啦。\r\n没有改动。\n'
  await fs.writeFile(file, text)
  for (const args of [{ old_text: '啦啦', new_text: 'X' }, { old_text: '啦啦', new_text: 'X', replace_all: true },
    { old_text: '啦啦啦。', new_text: 'X', at_line: 2 }, { old_text: '没有改动。' }, { old_text: '。', new_text: '', replace_all: 'false' },
    { old_text: '。', new_text: '', at_line: 1, replace_all: true }]) assert.equal((await doEdit(file, args)).ok, false)
  const noChange = await doEdit(file, { old_text: '啦啦啦。\n没有改动。\n', new_text: text })
  assert.equal(noChange.ok, true); assert.equal(noChange.edit?.count, 0); assert.equal(await fs.readFile(file, 'utf8'), text)
  const binary = Buffer.from([0x61, 0xff, 0x62])
  await fs.writeFile(file, binary); assert.equal((await doEdit(file, { old_text: 'a', new_text: 'c' })).ok, false)
  assert.deepEqual(await fs.readFile(file), binary)
})

test('准备落盘期间作者另存的同长度改动不被覆盖', async () => {
  const file = path.join(root, 'concurrent-edit.txt')
  await fs.writeFile(file, '第一版。')
  const prior = getCheckpointStore(), store = createCheckpointStore(root)
  setCheckpointStore({ ...store, async beforeWrite(p, session) {
    const result = await store.beforeWrite(p, session)
    await fs.writeFile(p, '作者版。')
    return result
  } })
  try {
    const res = await editTool.execute({ path: file, old_text: '第一版', new_text: '助手版' }, root, { workDir: root, docDir: root, sessionId: 'author-edit' })
    assert.equal(res.ok, false); assert.match(res.message, /未覆盖/); assert.equal(await fs.readFile(file, 'utf8'), '作者版。')
  } finally { setCheckpointStore(prior) }
})

test('写作约定不会覆盖作者刚保存的修改，也不将目录链接外的文件作为约定', async () => {
  const dir = path.join(root, 'brief-work')
  await fs.mkdir(dir)
  const prior = await readProjectBrief(dir)
  const initial = { path: prior.path, text: '', exists: false }
  assert.equal(prior.state, 'missing')
  await saveProjectBrief(dir, initial, '只写目击者所见。')
  await assert.rejects(saveProjectBrief(dir, initial, '覆盖'), /修改/)
  const edited = await readProjectBrief(dir); await fs.writeFile(prior.path, '作者亲自改写。')
  await assert.rejects(saveProjectBrief(dir, { path: edited.path, text: edited.text, exists: true }, '替换'), /修改/)
  assert.equal(await fs.readFile(prior.path, 'utf8'), '作者亲自改写。')
  await fs.writeFile(prior.path, '𠮷'.repeat(6500)); const limited = await readProjectBrief(dir)
  assert.equal(limited.state, 'limited'); assert.equal(Array.from(limited.text).length, 6000)
  await assert.rejects(saveProjectBrief(dir, { path: limited.path, text: limited.text, exists: true }, '截断'), /修改/)
  const other = path.join(root, 'brief-other'); await fs.mkdir(other)
  await assert.rejects(saveProjectBrief(other, initial, '不写入切换后的目录'), /切换/)
  const linked = path.join(root, 'brief-linked')
  await fs.mkdir(linked); await fs.symlink(dir, path.join(linked, 'DEEPWRITER.md'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await readProjectBrief(linked)).state, 'unavailable')
})
