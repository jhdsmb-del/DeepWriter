const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')
const js = buildSync({ entryPoints: [path.resolve(__dirname, '../src/main/jobs/toolTurnOutput.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' }).outputFiles[0].text
const mod = { exports: {} }; new Function('require', 'module', 'exports', js)(require, mod, mod.exports)
const { prepareToolTurnOutput, replayToolTurnOutput } = mod.exports
const unchanged = async value => value

test('本机保留撤销凭据；模型只看改稿结果，恢复时也相同', async () => {
  const publicPart = { ok: true, message: '河岸.md：已替换 2 处', edit: { count: 2, lines: [3, 8] }, exitCode: null }
  const raw = JSON.stringify({ ...publicPart, backupId: 'checkpoint-123', editUndo: { targetPath: '/private/desk/河岸.md', roots: { workDir: '/private/desk' } } })
  const result = await prepareToolTurnOutput('edit_file', raw, unchanged)
  assert.deepEqual(JSON.parse(result.content), publicPart)
  assert.equal(JSON.parse(result.resultJson).content, raw)
  assert.equal(replayToolTurnOutput({ name: 'edit_file', resultJson: result.resultJson }), result.content)
  // Even if the tool output spills, its artifact never contains local receipts
  // and a missing model turn can be rebuilt from the exact saved summary.
  const spilled = await prepareToolTurnOutput('edit_file', raw, async shown => {
    assert.deepEqual(JSON.parse(shown), publicPart); return '已保存工具输出摘录'
  })
  assert.equal(replayToolTurnOutput({ name: 'edit_file', resultJson: spilled.resultJson }), spilled.content)
  assert.equal(JSON.parse(spilled.resultJson).content, raw)
})

test('旧版写入回执不发送备份 ID；读稿正文中的同名文本保留', async () => {
  const raw = JSON.stringify({ ok: true, message: '写入完成', backupId: 'local-only' })
  assert.deepEqual(JSON.parse(replayToolTurnOutput({ name: 'write_file', resultJson: JSON.stringify({ content: raw }) })), { ok: true, message: '写入完成' })
  assert.equal((await prepareToolTurnOutput('read_file', raw, unchanged)).content, raw)
  assert.equal(replayToolTurnOutput({ name: 'edit_file', resultJson: JSON.stringify({ error: '未找到原文' }) }), '未找到原文')
})
