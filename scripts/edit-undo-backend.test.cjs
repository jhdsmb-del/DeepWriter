const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export {agentTools} from './src/main/agentTools';
    export {createCheckpointStore,setCheckpointStore} from './src/main/checkpoint';
    export {createRepository} from './src/main/db/repository';
    export {undoFileEdit,fileEditUndoRef} from './src/main/editUndo';
  ` }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  api = loaded.exports
})

async function fixture(body, initial = Buffer.from('\ufeff小曲过桥。\r\n船靠岸。\r\n')) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-edit-undo-'))
  const workDir = path.join(home, 'work'), docDir = path.join(home, 'docs'), data = path.join(home, 'data')
  await Promise.all([workDir, docDir, data].map(dir => fs.mkdir(dir)))
  const file = path.join(workDir, '河岸.md'), db = path.join(data, 'deepwriter.sqlite')
  await fs.writeFile(file, initial)
  const checkpoints = api.createCheckpointStore(data)
  api.setCheckpointStore(checkpoints)
  let repo = api.createRepository(db); repo.open()
  repo.createSession('session', 'fixture', '')
  repo.createRun({ run_id: 'run', session_id: 'session', status: 'completed', phase: 'completed', started_at: 1, updated_at: 2, config_json: JSON.stringify({ sessionId: 'session', workDir, docDir }), parent_run_id: null, error_code: null, error_message: null })
  repo.appendTurn({ turn_id: 'turn', run_id: 'run', turn_seq: 0, role: 'assistant', content: '完成', reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: 1 })
  repo.appendSessionMessage({ msg_id: 'm_run_assistant', session_id: 'session', seq: 1, role: 'assistant', content: '完成', created_at: 1 })
  const f = {
    home, workDir, docDir, data, file, initial, checkpoints,
    get repo() { return repo },
    async reopen() { repo.close(); repo = api.createRepository(db); repo.open() },
    async edit(toolCallId = 'edit1', old_text = '小曲', new_text = '小禾', extra = {}) {
      const args = { path: '河岸.md', old_text, new_text, ...extra }
      const result = await api.agentTools.find(tool => tool.name === 'edit_file').execute(args, docDir, { sessionId: 'session', runId: 'run', toolCallId, workDir, docDir, includeFileDiff: false })
      repo.upsertToolCall({ tool_call_id: toolCallId, run_id: 'run', turn_id: 'turn', name: 'edit_file', args_json: JSON.stringify(args), args_hash: toolCallId, status: 'completed', result_json: JSON.stringify({ content: JSON.stringify(result) }), started_at: 1, completed_at: 2 })
      return result
    },
    undo(toolCallId = 'edit1', extra = {}) { return api.undoFileEdit({ repository: repo, checkpoints, currentRoots: { workDir, docDir }, ...extra }, { sessionId: 'session', runId: 'run', toolCallId }) },
    input: { sessionId: 'session', runId: 'run', toolCallId: 'edit1' }
  }
  try { await body(f) } finally { api.setCheckpointStore(null); repo.close(); await fs.rm(home, { recursive: true, force: true }) }
}

test('real edit tool returns original-text recovery before any checkpoint; an exact retry remains undoable after restart', async () => fixture(async f => {
  const new_text = '她说：“先走吧。”\n她没有动。'
  const miss = await f.edit('miss', '她说："别 走。"\n她没有动。', new_text)
  assert.equal(miss.ok, false); assert.match(miss.message, /候选，未修改/)
  assert.deepEqual(await fs.readFile(f.file), f.initial)
  assert.equal((await f.checkpoints.listCheckpoints('session')).length, 0)
  assert.equal((await f.undo('miss')).code, 'undo_unavailable')
  const candidate = miss.editRecovery.candidates[0]
  const result = await f.edit('retry', candidate.retry.old_text, new_text, { at_line: candidate.retry.at_line })
  assert.equal(result.ok, true); assert.deepEqual(result.edit, { count: 1, lines: [2] })
  assert.equal(await fs.readFile(f.file, 'utf8'), '\ufeff前记。\n她说：“先走吧。”\r\n她没有动。\r\n\n尾声 — ①。')
  assert.equal((await f.checkpoints.listCheckpoints('session')).length, 1)
  await f.reopen()
  assert.equal((await f.undo('retry')).status, 'undone')
  assert.deepEqual(await fs.readFile(f.file), f.initial)
}, Buffer.from('\ufeff前记。\n她说：“别\u00a0走。”\t\r\n  她没有动。\r\n\n尾声 — ①。')))

test('real edit, SQLite close/reopen, bounded historical ref and byte-exact atomic undo', async () => fixture(async f => {
  const result = await f.edit()
  assert.equal(result.ok, true)
  assert.equal(result.editUndo.before.bytes, f.initial.length)
  assert.notEqual(result.editUndo.before.sha256, result.editUndo.after.sha256)
  await f.reopen()
  const row = f.repo.getSessionEditTools('session', 'm_run_assistant', 0)[0]
  assert.deepEqual(api.fileEditUndoRef(f.repo, row), { ...f.input, status: 'available' })
  assert.equal((await f.undo()).status, 'undone')
  assert.deepEqual(await fs.readFile(f.file), f.initial)
  assert.equal((await f.checkpoints.listCheckpoints('session')).length, 1, 'undo reuses the existing checkpoint; no extra backup')
  await f.reopen()
  assert.equal(api.fileEditUndoRef(f.repo, row).status, 'undone')
  await fs.writeFile(f.file, '作者重新写了一段。')
  const before = await fs.stat(f.file)
  assert.equal((await f.undo()).status, 'already_undone')
  assert.equal(await fs.readFile(f.file, 'utf8'), '作者重新写了一段。')
  assert.equal((await fs.stat(f.file)).mtimeMs, before.mtimeMs)
  assert.deepEqual((await fs.readdir(f.workDir)).filter(name => name.startsWith('.deepwriter-')), [])
}))

test('whole-file external edits and missing files are never overwritten or recreated', async () => fixture(async f => {
  await f.edit()
  await fs.appendFile(f.file, '作者后来补的结尾。')
  const authored = await fs.readFile(f.file)
  assert.equal((await f.undo()).code, 'file_changed')
  assert.deepEqual(await fs.readFile(f.file), authored)
  assert.equal(f.repo.getRunEvidence('run', 'file_edit_undo_v1:edit1'), null)
  await fs.unlink(f.file)
  assert.equal((await f.undo()).status, 'blocked')
  await assert.rejects(fs.access(f.file), { code: 'ENOENT' })
}))

test('multiple edits unwind newest first; repeated newer undo cannot replay over older undo', async () => fixture(async f => {
  await f.edit('edit1', '小曲', '小禾')
  await f.edit('edit2', '小禾', '小舟')
  const later = await fs.readFile(f.file)
  assert.equal((await f.undo('edit1')).code, 'file_changed')
  assert.deepEqual(await fs.readFile(f.file), later)
  assert.equal((await f.undo('edit2')).status, 'undone')
  assert.equal((await f.undo('edit1')).status, 'undone')
  assert.deepEqual(await fs.readFile(f.file), f.initial)
  assert.equal((await f.undo('edit2')).status, 'already_undone')
  assert.deepEqual(await fs.readFile(f.file), f.initial)
}))

test('no-op, failed, legacy and identity-conflicting records cannot authorize an undo', async () => fixture(async f => {
  const noop = await f.edit('noop', '小曲', '小曲')
  assert.equal(noop.edit.count, 0)
  assert.equal(noop.editUndo, undefined)
  assert.equal((await f.undo('noop')).code, 'undo_unavailable')
  const failed = await f.edit('miss', '没有的人名', '小禾')
  assert.equal(failed.ok, false)
  assert.equal((await f.undo('miss')).code, 'undo_unavailable')
  await f.edit()
  const original = f.repo.getToolCallById('edit1'), changed = await fs.readFile(f.file)
  assert.equal((await api.undoFileEdit({ repository: f.repo, checkpoints: f.checkpoints, currentRoots: f }, { ...f.input, sessionId: 'other' })).code, 'edit_not_found')
  const payload = JSON.parse(JSON.parse(original.result_json).content)
  delete payload.editUndo
  f.repo.upsertToolCall({ ...original, result_json: JSON.stringify(payload) })
  assert.equal((await f.undo()).code, 'undo_unavailable')
  assert.equal(api.fileEditUndoRef(f.repo, f.repo.getToolCallById('edit1')), undefined)
  f.repo.upsertToolCall(original)
  const conflicting = JSON.parse(JSON.parse(original.result_json).content)
  conflicting.editUndo.runId = 'another-run'
  f.repo.upsertToolCall({ ...original, result_json: JSON.stringify(conflicting) })
  assert.equal((await f.undo()).code, 'undo_unavailable')
  assert.deepEqual(await fs.readFile(f.file), changed)
}))

test('current project and frozen roots are checked independently of a shared document directory', async () => fixture(async f => {
  await f.edit()
  const changed = await fs.readFile(f.file), other = path.join(f.home, 'another-project')
  await fs.mkdir(other)
  assert.equal((await f.undo('edit1', { currentRoots: { workDir: other, docDir: f.docDir } })).code, 'project_changed')
  const run = f.repo.getRun('run'), cfg = JSON.parse(run.config_json)
  f.repo.updateRun('run', { config_json: JSON.stringify({ ...cfg, workDir: other }) })
  assert.equal((await f.undo()).code, 'project_changed')
  assert.deepEqual(await fs.readFile(f.file), changed)
}))

test('checkpoint tampering, cleanup and absent checkpoint service all fail closed', async () => fixture(async f => {
  const result = await f.edit(), changed = await fs.readFile(f.file)
  const backup = path.join(f.data, 'checkpoints', 'session', result.backupId + '.bak')
  await fs.writeFile(backup, '不是原稿。')
  assert.equal((await f.undo()).code, 'checkpoint_changed')
  await fs.unlink(backup)
  assert.equal((await f.undo()).status, 'blocked')
  assert.equal((await f.undo('edit1', { checkpoints: null })).code, 'checkpoint_missing')
  assert.deepEqual(await fs.readFile(f.file), changed)
}))

test('a changed directory junction cannot redirect undo into another project', async t => fixture(async f => {
  await f.edit()
  const elsewhere = path.join(f.home, 'elsewhere'), parked = path.join(f.home, 'original-work')
  await fs.mkdir(elsewhere)
  const otherFile = path.join(elsewhere, '河岸.md')
  await fs.copyFile(f.file, otherFile)
  const otherBytes = await fs.readFile(otherFile)
  await fs.rename(f.workDir, parked)
  try { await fs.symlink(elsewhere, f.workDir, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS does not allow directory links'); throw error }
  assert.equal((await f.undo()).code, 'project_changed')
  assert.deepEqual(await fs.readFile(otherFile), otherBytes)
}))

test('pre-rename external change survives, and its durable pending claim is never replayed', async () => fixture(async f => {
  await f.edit()
  const repository = { ...f.repo, saveRunEvidenceIfAbsent(...args) {
    const saved = f.repo.saveRunEvidenceIfAbsent(...args)
    fsSync.writeFileSync(f.file, '作者在撤销前保存的新稿。')
    return saved
  } }
  assert.equal((await f.undo('edit1', { repository })).code, 'file_changed')
  await f.reopen()
  assert.equal((await f.undo()).code, 'undo_uncertain')
  assert.equal(await fs.readFile(f.file, 'utf8'), '作者在撤销前保存的新稿。')
}))

test('missing durable claim cannot write; a post-rename DB failure can only confirm without another write', async () => fixture(async f => {
  await f.edit()
  const changed = await fs.readFile(f.file)
  const noState = { ...f.repo, saveRunEvidenceIfAbsent() { throw new Error('disk full') } }
  assert.equal((await f.undo('edit1', { repository: noState })).status, 'blocked')
  assert.deepEqual(await fs.readFile(f.file), changed)
  const noFinal = { ...f.repo, saveRunEvidence() { throw new Error('post-rename DB failure') } }
  assert.equal((await f.undo('edit1', { repository: noFinal })).status, 'blocked')
  assert.deepEqual(await fs.readFile(f.file), f.initial)
  await f.reopen()
  const before = await fs.stat(f.file)
  assert.equal((await f.undo()).status, 'already_undone')
  assert.equal((await fs.stat(f.file)).mtimeMs, before.mtimeMs)
}))

test('same-millisecond checkpoints keep unique immutable snapshots with the existing ID format', async () => fixture(async f => {
  const now = Date.now
  Date.now = () => 123456789
  try {
    const first = await f.checkpoints.beforeWrite(f.file, 'session')
    await fs.writeFile(f.file, '第二份原稿。')
    const second = await f.checkpoints.beforeWrite(f.file, 'session')
    assert.notEqual(first.backupId, second.backupId)
    assert.deepEqual(await f.checkpoints.readForEditUndo(first.backupId, 'session', f.file), f.initial)
    assert.equal((await f.checkpoints.readForEditUndo(second.backupId, 'session', f.file)).toString(), '第二份原稿。')
  } finally { Date.now = now }
}))

test('separate SQLite clients claiming the same edit cannot both restore it', async () => fixture(async f => {
  await f.edit()
  const other = api.createRepository(path.join(f.data, 'deepwriter.sqlite')); other.open()
  try {
    const results = await Promise.all([f.undo(), f.undo('edit1', { repository: other })])
    assert.equal(results.filter(result => result.status === 'undone').length, 1)
    assert.ok(results.every(result => ['undone', 'already_undone', 'blocked'].includes(result.status)))
    assert.deepEqual(await fs.readFile(f.file), f.initial)
    assert.equal((await f.undo()).status, 'already_undone')
  } finally { other.close() }
}))

test('an unchanged configured directory junction remains a valid author root', async t => fixture(async f => {
  const realWork = path.join(f.home, 'real-work'), dataAlias = path.join(f.home, 'data-alias')
  await fs.rename(f.workDir, realWork)
  try {
    await fs.symlink(realWork, f.workDir, process.platform === 'win32' ? 'junction' : 'dir')
    await fs.symlink(f.data, dataAlias, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS does not allow directory links'); throw error }
  await f.edit()
  assert.equal((await f.undo('edit1', { checkpoints: api.createCheckpointStore(dataAlias) })).status, 'undone')
  assert.deepEqual(await fs.readFile(f.file), f.initial)
}))

test('an unused missing doc root does not disable undo or acquire authority when later created', async () => fixture(async f => {
  await fs.rmdir(f.docDir)
  const result = await f.edit()
  assert.equal(result.ok, true)
  assert.equal(result.editUndo.authorizedRoot, 'workDir')
  assert.equal(result.editUndo.roots.realDocDir, null)
  await fs.mkdir(f.docDir)
  assert.equal((await f.undo()).status, 'undone')
  assert.deepEqual(await fs.readFile(f.file), f.initial)
}))

test('a checkpoint base junction retargeted even to a copied snapshot cannot restore', async t => fixture(async f => {
  await f.edit()
  const alias = path.join(f.home, 'checkpoint-link'), other = path.join(f.home, 'other-data')
  await fs.cp(f.data, other, { recursive: true })
  try { await fs.symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS does not allow directory links'); throw error }
  const changed = await fs.readFile(f.file)
  const denied = await f.undo('edit1', { checkpoints: api.createCheckpointStore(alias) })
  assert.equal(denied.status, 'blocked')
  assert.match(denied.message, /检查点目录.*变化/)
  assert.deepEqual(await fs.readFile(f.file), changed)
}))
