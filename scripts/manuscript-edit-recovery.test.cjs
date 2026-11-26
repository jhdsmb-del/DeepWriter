const assert = require('node:assert/strict')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const path = require('node:path')
const root = path.resolve(__dirname, '..'), loaded = { exports: {} }
const built = buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: "export * from './src/main/manuscriptEdit'" },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
const { planManuscriptEdit: plan, ManuscriptEditMatchError } = loaded.exports
function miss(text, old_text, extra = {}) {
  try { plan(text, { old_text, new_text: '改文', ...extra }); assert.fail('must refuse rather than guess') }
  catch (error) { assert.ok(error instanceof ManuscriptEditMatchError, error.message); return error.recovery }
}

test('exact text wins over typography-equivalent occurrences, with unchanged literal replacement rules', () => {
  const source = '她说：“别走。”\r\n她说："别走。"\n后记。'
  const result = plan(source, { old_text: '她说："别走。"', new_text: '$& $1 $$' })
  assert.deepEqual(result, { text: '她说：“别走。”\r\n$& $1 $$\n后记。', count: 1, lines: [2] })
  assert.throws(() => plan('同一句。\n同一句。', { old_text: '同一句。', new_text: '改文' }), /匹配到 2 处/)
})

test('quote/space misses return original bytes and Unicode line/column ranges for an exact retry', () => {
  const source = '\ufeff序章\n𠮷：她说：“别\u00a0\u00a0走。”\t\r\n\u3000她转身。\r\n\n尾声 — ①。'
  const old_text = '她说："别 走。"\n她转身。'
  const recovery = miss(source, old_text)
  assert.equal(recovery.kind, 'formatting_candidates'); assert.equal(recovery.count, 1)
  const candidate = recovery.candidates[0]
  assert.deepEqual(candidate, { start_line: 2, start_column: 3, end_line: 3, end_column: 6,
    retry: { old_text: '她说：“别\u00a0\u00a0走。”\t\r\n\u3000她转身。', at_line: 2 },
    read_file: { start_line: 2, start_column: 3, line_count: 2 } })
  const result = plan(source, { ...candidate.retry, new_text: '她没有挽留。\n她转身。' })
  assert.equal(result.text, '\ufeff序章\n𠮷：她没有挽留。\r\n她转身。\r\n\n尾声 — ①。')
  assert.deepEqual(result.lines, [2])
})

test('ambiguous candidates never write and at_line confines both exact and recovery searches', () => {
  const source = '前言\n她说：“走。”\n\n她说：“走。”\n后记'
  const old = '她说："走。"'
  const recovery = miss(source, old)
  assert.equal(recovery.count, 2); assert.deepEqual(recovery.candidates.map(c => c.start_line), [2, 4])
  assert.equal(miss(source, old, { at_line: 2 }).count, 1)
  assert.equal(miss(source, old, { at_line: 3 }), undefined)
  assert.equal(miss(source, old, { at_line: 40 }), undefined)
  const selected = plan(source, { ...recovery.candidates[1].retry, new_text: '她说：“留下。”' })
  assert.equal(selected.text, '前言\n她说：“走。”\n\n她说：“留下。”\n后记')
})

test('meaningful punctuation, compatibility characters, words, and paragraph boundaries are not normalized', () => {
  for (const [source, old] of [
    ['风—停了。', '风-停了。'], ['温度−1。', '温度-1。'], ['她停下……', '她停下...'],
    ['第一幕①', '第一幕1'], ['１２点', '12点'], ['ABC', 'abc'], ['走，别等。', '走,别等。'],
    ['她说：「走。」', '她说："走。"'], ['她的手', '他的手'], ['别走', '别 走'],
    ['甲。\n\n乙。', '甲。\n乙。'], ['甲。\n乙。', '甲。 乙。'], ['甲\u200b乙', '甲乙'],
  ]) assert.equal(miss(source, old), undefined, JSON.stringify([source, old]))
  assert.equal(miss('甲\n\n乙', ' \n '), undefined)
})

test('line-edge spaces may guide a retry, but are never removed from the manuscript implicitly', () => {
  const source = '\t“回来。”  \n\t尾声'
  const recovery = miss(source, '   "回来。" ')
  assert.deepEqual(recovery.candidates[0].retry, { old_text: '“回来。”', at_line: 1 })
  assert.equal(plan(source, { ...recovery.candidates[0].retry, new_text: '“别回来了。”' }).text, '\t“别回来了。”  \n\t尾声')
})

test('candidate samples are bounded; large passages and replace_all get read coordinates, not a changed scope', () => {
  const source = '“走。”\n'.repeat(100)
  const recovery = miss(source, '"走。"')
  assert.equal(recovery.count, 100); assert.equal(recovery.candidates.length, 3)
  assert.ok(JSON.stringify(recovery).length < 2000)
  const huge = miss('“' + '甲'.repeat(5000) + '”', '"' + '甲'.repeat(5000) + '"')
  assert.equal(huge.candidates[0].retry, undefined)
  assert.deepEqual(huge.candidates[0].read_file, { start_line: 1, start_column: 1, line_count: 1 })
  assert.ok(JSON.stringify(huge).length < 500)
  assert.ok(miss(source, '"走。"', { replace_all: true }).candidates.every(c => c.retry === undefined))
})

test('mixed LF/CRLF, literal no-op, UTF-8 BOM, astral text and untouched punctuation survive exact retry', () => {
  const original = '\ufeff前记。\r\n“𠮷说。”\n后记 — ①。\r\n'
  const retry = miss(original, '"𠮷说。"').candidates[0].retry
  assert.deepEqual(Buffer.from(plan(original, { ...retry, new_text: retry.old_text }).text), Buffer.from(original))
})
