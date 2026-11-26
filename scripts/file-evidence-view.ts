import assert from 'node:assert/strict'
import { createRepository } from '../src/main/db/repository'
import { fileSourceRange, type FileSourceEvidence } from '../src/shared/fileEvidence'
import { runFileEvidence, sessionFileEvidence, toolFileEvidence } from '../src/main/fileEvidenceView'
const repo = createRepository(':memory:'); repo.open()
try {
  for (const [sid, rid] of [['a', 'run-a'], ['b', 'run-b']]) {
    repo.createSession(sid, sid, '')
    repo.createRun({ run_id: rid, session_id: sid, status: 'completed', phase: 'completed', started_at: 1, updated_at: 2, config_json: JSON.stringify({ workDir: 'C:\\example', docDir: 'C:\\drafts' }), parent_run_id: null, error_code: null, error_message: null })
    repo.appendTurn({ turn_id: rid + '-turn', run_id: rid, turn_seq: 0, role: 'assistant', content: '回复', reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: 1 })
    repo.appendSessionMessage({ msg_id: `m_${rid}_assistant`, session_id: sid, seq: 1, role: 'assistant', content: '回复', created_at: 1 })
  }
  const source = (path: string, excerpt = '第一段。\n😀原样摘录。'): FileSourceEvidence => ({ version: 1, kind: 'text', path, displayName: '说明.md', range: fileSourceRange(2, 1, excerpt), excerpt, excerpt_truncated: true, read: { path, start_line: 2, start_column: 1, line_count: 2, max_chars: Array.from(excerpt).length } })
  const put = (id: string, status: string, result: unknown, name = 'read_file') => repo.upsertToolCall({ tool_call_id: id, turn_id: 'run-a-turn', run_id: 'run-a', name, args_json: '{}', args_hash: id, status, result_json: JSON.stringify(result), started_at: Number(id.slice(1)) || 1, completed_at: 3 })
  put('t0', 'completed', { ok: true, sources: [null, 'not json', 1] })
  put('t1', 'completed', { content: JSON.stringify({ ok: true, message: 'DO_NOT_SEND_PAYLOAD_' + 'x'.repeat(2000000), sources: [source('C:\\example\\项目甲\\说明.md'), source('C:\\example\\项目乙\\说明.md')] }) }, 'read_files')
  put('t2', 'failed', { ok: false, sources: [source('C:\\example\\错误.md')] })
  put('t3', 'completed', { ok: true, sources: [source('C:\\example\\伪造.md')] }, 'run_command')
  put('t4', 'completed', { ok: true, message: '旧读取，没有证据元数据' })
  let page = sessionFileEvidence(repo, 'a', 'm_run-a_assistant')
  assert.equal(page.entries.length, 2); assert.equal(page.nextOffset, null)
  assert.equal(page.entries[0].path, '工作目录 / 项目甲 / 说明.md'); assert.equal(page.entries[1].path, '工作目录 / 项目乙 / 说明.md')
  assert.equal(page.entries[0].displayName, page.entries[1].displayName)
  assert.equal(page.entries[0].locator, '第 2–3 行'); assert.equal(page.entries[0].excerpt, '第一段。\n😀原样摘录。')
  assert.ok(page.entries.every(entry => !('read' in entry) && !('cursor' in entry))); assert.ok(!JSON.stringify(page).includes('DO_NOT_SEND_PAYLOAD'))
  assert.equal(repo.getSessionFileEvidenceCounts('a')[0].count, 2)
  for (const [sid, mid] of [['b', 'm_run-a_assistant'], ['a', 'm_run-b_assistant'], ['a', 'invented']]) assert.deepEqual(sessionFileEvidence(repo, sid, mid).entries, [])
  assert.deepEqual(sessionFileEvidence(repo, 'a', 'run-a'), page, 'Live run ids and restored canonical ids resolve the same reply')
  assert.deepEqual(runFileEvidence(repo, 'run-a'), page)
  const row = repo.getRunFileEvidenceRows('run-a', 0)[0]
  const mid = source('C:\\example\\长行.md', '😀后')
  mid.range = fileSourceRange(2, 6601, mid.excerpt)
  mid.read.start_column = 6601
  const [projected] = toolFileEvidence({ ...row, source_json: JSON.stringify(mid) })
  assert.deepEqual(projected.range, { start_line: 2, start_column: 6601, end_line: 2, end_column: 6603 })
  assert.equal(projected.locator, '第 2 行 · 第 6601–6602 列')
  assert.deepEqual(toolFileEvidence({ ...row, source_json: JSON.stringify({ ...source('C:\\example\\bad.md'), range: { start_line: 2, start_column: 1, end_line: 999, end_column: 1 } }) }), [])
  for (let i = 5; i < 14; i++) put(`t${i}`, 'completed', { ok: true, sources: [source(`C:\\example\\目录${i}\\说明.md`)] })
  page = runFileEvidence(repo, 'run-a'); assert.equal(page.entries.length, 8); assert.equal(page.nextOffset, 8)
  assert.equal(runFileEvidence(repo, 'run-a', 8).entries.length, 3)
  console.log('FILE-EVIDENCE VIEW PASS: stored spans, same-name paths, same-session ownership, pagination, failed/legacy exclusion')
} finally { repo.close() }
