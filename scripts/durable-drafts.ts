import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createRepository, type AcceptChatStartInput } from '../src/main/db/repository'
import { createDraftPersistence } from '../src/renderer/src/draftPersistence'
import { createDraftFlushBarrier } from '../src/main/draftFlush'
import { composerDraftWriteSchema } from '../src/shared/ipcSchemas'
import type { ComposerDraftWriteResult, PersistedComposerDraft } from '../src/shared/composerDraft'

async function fixture(run: (dbPath: string, repo: ReturnType<typeof createRepository>) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'dw-drafts-'))
  const dbPath = path.join(root, 'drafts.db')
  const repo = createRepository(dbPath)
  repo.open()
  try { await run(dbPath, repo) } finally { repo.close(); await rm(root, { recursive: true, force: true }) }
}

function chat(sessionId: string, text: string): AcceptChatStartInput {
  const runId = `${sessionId}-run`
  return {
    sessionId, title: text, model: 'synthetic',
    run: { run_id: runId, session_id: sessionId, status: 'queued', phase: 'queued', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null, client_request_id: runId },
    userTurn: { turn_id: `${runId}-turn`, run_id: runId, turn_seq: 1, role: 'user', content: text, reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: 1 },
    userMsg: { msg_id: `${runId}-message`, role: 'user', content: text, created_at: 1 }
  }
}

test('unsent Unicode drafts survive restart without creating messages, sessions or tasks', async () => fixture((dbPath, repo) => {
  const saved = repo.saveComposerDraft({ sessionId: 'unsent-one', text: '未发送的任务 👩🏽‍💻\n下一行。', expectedRevision: 0 })
  assert.equal(saved.ok, true)
  assert.deepEqual(repo.listSessions(), [])
  assert.deepEqual(repo.listRecentRuns(50), [])
  repo.close()
  const reopened = createRepository(dbPath)
  reopened.open()
  try { assert.deepEqual(reopened.listComposerDrafts(), [saved.draft]) } finally { reopened.close() }
}))

test('stale draft writes cannot overwrite newer text; clearing does not resurrect an old revision', async () => fixture((_dbPath, repo) => {
  repo.saveComposerDraft({ sessionId: 'one', text: '原始', expectedRevision: 0 })
  const fresh = repo.saveComposerDraft({ sessionId: 'one', text: '新修改', expectedRevision: 1 })
  const stale = repo.saveComposerDraft({ sessionId: 'one', text: '迟到旧修改', expectedRevision: 1 })
  assert.equal(stale.ok, false)
  assert.deepEqual(stale.draft, fresh.draft)
  const cleared = repo.saveComposerDraft({ sessionId: 'one', text: '', expectedRevision: 2 })
  assert.equal(cleared.ok, true)
  assert.deepEqual(repo.listComposerDrafts(), [])
  assert.equal(repo.saveComposerDraft({ sessionId: 'one', text: '原始', expectedRevision: 1 }).ok, false)
}))

test('successful acceptance clears only the accepted draft inside the same transaction', async () => fixture((_dbPath, repo) => {
  repo.saveComposerDraft({ sessionId: 'sent', text: '  提交任务  ', expectedRevision: 0 })
  assert.equal(repo.acceptChatStart(chat('sent', '提交任务')).ok, true)
  assert.deepEqual(repo.listComposerDrafts(), [])
  assert.equal(repo.getSessionMessages('sent').length, 1)
  repo.saveComposerDraft({ sessionId: 'edited', text: 'ACK 前的新任务', expectedRevision: 0 })
  assert.equal(repo.acceptChatStart(chat('edited', '已提交的任务')).ok, true)
  assert.equal(repo.listComposerDrafts()[0]?.text, 'ACK 前的新任务')
}))

test('failed acceptance rolls back both draft clearing and canonical message creation', async () => fixture((_dbPath, repo) => {
  repo.saveComposerDraft({ sessionId: 'failure', text: '保留任务', expectedRevision: 0 })
  assert.throws(() => repo.acceptChatStart(chat('failure', '保留任务'), { beforeInsertMessage: () => { throw new Error('injected rejection') } }), /injected rejection/)
  assert.equal(repo.listComposerDrafts()[0]?.text, '保留任务')
  assert.deepEqual(repo.getSessionMessages('failure'), [])
  assert.deepEqual(repo.listSessions(), [])
}))

test('deleting sent or unsent sessions removes their durable drafts', async () => fixture((_dbPath, repo) => {
  repo.saveComposerDraft({ sessionId: 'unsent', text: '删除的草稿', expectedRevision: 0 })
  repo.createSession('sent', '历史会话', 'synthetic')
  repo.saveComposerDraft({ sessionId: 'sent', text: '下一条任务', expectedRevision: 0 })
  repo.deleteSession('unsent')
  assert.deepEqual(repo.listComposerDrafts().map((draft) => draft.sessionId), ['sent'])
  repo.deleteSession('sent')
  assert.deepEqual(repo.listComposerDrafts(), [])
}))

test('v1.2.6 database upgrade preserves canonical history and is repeatable', async () => fixture((dbPath, repo) => {
  repo.createSession('existing', '已有会话', 'synthetic')
  repo.appendSessionMessage({ msg_id: 'history', session_id: 'existing', seq: 1, role: 'user', content: '已有消息', created_at: 1 })
  repo.close()
  const old = new DatabaseSync(dbPath)
  old.exec('DROP TABLE composer_drafts; PRAGMA user_version=29')
  old.prepare("UPDATE meta SET value='29' WHERE key='schema_version'").run()
  old.close()
  for (let i = 0; i < 2; i++) {
    repo.open()
    assert.equal(repo.getSessionMessages('existing')[0]?.content, '已有消息')
    assert.deepEqual(repo.listComposerDrafts(), [])
    repo.close()
  }
}))

test('draft count and UTF-8 byte quotas reject new writes while preserving existing drafts', async () => fixture((_dbPath, repo) => {
  for (let i = 0; i < 200; i++) assert.equal(repo.saveComposerDraft({ sessionId: `small-${i}`, text: '任务', expectedRevision: 0 }).ok, true)
  assert.throws(() => repo.saveComposerDraft({ sessionId: 'overflow', text: '任务', expectedRevision: 0 }), /storage_limit/)
  assert.equal(repo.listComposerDrafts().length, 200)
  for (let i = 0; i < 200; i++) repo.deleteSession(`small-${i}`)
  const text = '字'.repeat(200_000)
  for (let i = 0; i < 34; i++) repo.saveComposerDraft({ sessionId: `large-${i}`, text, expectedRevision: 0 })
  assert.throws(() => repo.saveComposerDraft({ sessionId: 'too-many-bytes', text: text + text, expectedRevision: 0 }), /input_invalid/)
  assert.throws(() => repo.saveComposerDraft({ sessionId: 'large-34', text, expectedRevision: 0 }), /storage_limit/)
  assert.equal(repo.listComposerDrafts().length, 34)
}))

test('draft IPC rejects attachment capabilities, unknown fields, malformed ids and oversized text', () => {
  const base = { sessionId: 'one', text: '文字', expectedRevision: 0 }
  for (const input of [{ ...base, attachments: [{ fileRefId: 'old-capability' }] }, { ...base, sessionId: '../path' }, { ...base, text: 'x'.repeat(200_001) }, { ...base, expectedRevision: -1 }]) assert.equal(composerDraftWriteSchema.safeParse(input).success, false)
  assert.equal(composerDraftWriteSchema.safeParse(base).success, true)
})

test('queued edits coalesce and flush waits for the newest durable write', async () => {
  let release!: (result: ComposerDraftWriteResult) => void
  const writes: string[] = []
  const persistence = createDraftPersistence(async (input) => {
    writes.push(input.text)
    if (writes.length === 1) return new Promise((resolve) => { release = resolve })
    return { ok: true, draft: { sessionId: input.sessionId, text: input.text, revision: input.expectedRevision + 1, updatedAt: 1 } }
  }, () => undefined)
  persistence.queue('one', '第一次')
  await Promise.resolve()
  persistence.queue('one', '中间修改')
  persistence.queue('one', '最新 👩🏽‍💻')
  let flushed = false
  const flush = persistence.flush().then(() => { flushed = true })
  await Promise.resolve()
  assert.equal(flushed, false)
  release({ ok: true, draft: { sessionId: 'one', text: '第一次', revision: 1, updatedAt: 1 } })
  await flush
  assert.deepEqual(writes, ['第一次', '最新 👩🏽‍💻'])
})

test('save failure preserves the newest text and a later flush retries it', async () => {
  let fail = true
  const saved: string[] = []
  const persistence = createDraftPersistence(async (input) => {
    if (fail) throw new Error('injected storage error')
    saved.push(input.text)
    return { ok: true, draft: { sessionId: input.sessionId, text: input.text, revision: 1, updatedAt: 1 } }
  }, () => undefined)
  persistence.queue('one', '不可丢失')
  await assert.rejects(persistence.flush(), /injected storage error/)
  fail = false
  await persistence.flush()
  assert.deepEqual(saved, ['不可丢失'])
})

test('acceptance revision conflicts retry the newest edit and deletion blocks late callbacks', async () => {
  let current: PersistedComposerDraft = { sessionId: 'one', text: '', revision: 2, updatedAt: 1 }
  const writes: string[] = []
  const persistence = createDraftPersistence(async (input) => {
    if (input.expectedRevision !== current.revision) return { ok: false, reason: 'conflict', draft: current }
    writes.push(input.text)
    current = { ...current, text: input.text, revision: current.revision + 1 }
    return { ok: true, draft: current }
  }, () => undefined)
  persistence.queue('one', 'ACK 前的新文字')
  await persistence.flush()
  assert.equal(current.text, 'ACK 前的新文字')
  await persistence.beforeDelete('one')
  persistence.queue('one', '删除后的迟到修改')
  await persistence.flush()
  assert.deepEqual(writes, ['ACK 前的新文字'])
})

test('shutdown flush acknowledgement rejects another window, expired tokens and failed saves', async () => {
  const barrier = createDraftFlushBarrier(20)
  let token = ''
  const window = { id: 7, isDestroyed: () => false, send: (_channel: string, input: unknown) => { token = (input as { token: string }).token } }
  const success = barrier.request(window)
  assert.equal(barrier.acknowledge(8, token, true), false)
  assert.equal(barrier.acknowledge(7, 'wrong-token', true), false)
  assert.equal(barrier.acknowledge(7, token, true), true)
  assert.equal(await success, true)
  assert.equal(barrier.acknowledge(7, token, true), false)
  const failed = barrier.request(window)
  assert.equal(barrier.acknowledge(7, token, false), true)
  assert.equal(await failed, false)
  assert.equal(await barrier.request(window), false)
})
