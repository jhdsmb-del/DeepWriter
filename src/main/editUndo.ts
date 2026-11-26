import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileEditUndoMetadata, FileEditUndoRef, UndoFileEditInput, UndoFileEditResult } from '../shared/editUndo'
import type { Repository, ToolCallRow } from './db/repository'
import type { CheckpointStore } from './checkpoint'
import { writeBytesAtomically } from './agentFiles'
import { decodeManuscript, planManuscriptEdit } from './manuscriptEdit'
import { unwrapToolResult } from './toolResultView'

type Roots = { workDir: string; docDir: string }
type ReadPort = Pick<Repository, 'getRun' | 'getRunEvidence'>
type UndoPort = ReadPort & Pick<Repository, 'getToolCallById' | 'saveRunEvidenceIfAbsent' | 'saveRunEvidence'>
const identity = (bytes: Buffer) => ({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
const within = (file: string, root: string): boolean => {
  const relative = path.relative(root, file)
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
}
const sameBytes = (bytes: Buffer, expected: FileEditUndoMetadata['before']): boolean => bytes.length === expected.bytes && identity(bytes).sha256 === expected.sha256
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const absolute = (value: unknown): value is string => typeof value === 'string' && value.length <= 16_384 && path.isAbsolute(value)
const fingerprint = (value: unknown): boolean => object(value) && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.sha256) && Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0

function metadata(value: unknown): value is FileEditUndoMetadata {
  return object(value) && value.schemaVersion === 1 && id(value.runId) && id(value.sessionId) && id(value.toolCallId)
    && typeof value.backupId === 'string' && value.backupId.length > 0 && value.backupId.length <= 65_536
    && absolute(value.targetPath) && absolute(value.requestedPath) && absolute(value.checkpointRoot) && object(value.roots)
    && (value.authorizedRoot === 'workDir' || value.authorizedRoot === 'docDir')
    && ['workDir', 'docDir'].every(key => absolute((value.roots as Record<string, unknown>)[key]))
    && ['realWorkDir', 'realDocDir'].every(key => (value.roots as Record<string, unknown>)[key] === null || absolute((value.roots as Record<string, unknown>)[key]))
    && absolute((value.roots as Record<string, unknown>)[value.authorizedRoot === 'workDir' ? 'realWorkDir' : 'realDocDir'])
    && fingerprint(value.before) && fingerprint(value.after) && (value.before as Record<string, unknown>).sha256 !== (value.after as Record<string, unknown>).sha256
}

/** Called only for a changed edit with an existing checkpoint. Incomplete old
 * tool environments remain usable, but cannot advertise safe undo. */
export async function makeFileEditUndoMetadata(input: {
  sessionId?: string; runId?: string; toolCallId?: string; backupId: string; checkpointRoot?: string
  requestedPath: string; targetPath: string; workDir: string; docDir: string; before: Buffer; after: Buffer
}): Promise<FileEditUndoMetadata | undefined> {
  if (!id(input.sessionId) || !id(input.runId) || !id(input.toolCallId) || !input.backupId || !absolute(input.checkpointRoot)) return undefined
  const [realWorkDir, realDocDir] = await Promise.all([fs.realpath(input.workDir).catch(() => null), fs.realpath(input.docDir).catch(() => null)])
  const roots = { workDir: path.resolve(input.workDir), docDir: path.resolve(input.docDir), realWorkDir, realDocDir }
  const authorizedRoot = (['workDir', 'docDir'] as const).find(key => {
    const real = roots[key === 'workDir' ? 'realWorkDir' : 'realDocDir']
    return real !== null && within(input.requestedPath, roots[key]) && within(input.targetPath, real)
  })
  if (!authorizedRoot) return undefined
  return {
    schemaVersion: 1, sessionId: input.sessionId, runId: input.runId, toolCallId: input.toolCallId,
    backupId: input.backupId, checkpointRoot: input.checkpointRoot, requestedPath: path.resolve(input.requestedPath), targetPath: input.targetPath,
    authorizedRoot, roots,
    before: identity(input.before), after: identity(input.after)
  }
}

function editMetadata(row: Pick<ToolCallRow, 'name' | 'status' | 'result_json' | 'run_id' | 'tool_call_id'>): FileEditUndoMetadata | undefined {
  const { payload } = unwrapToolResult(row.result_json)
  if (row.name !== 'edit_file' || row.status !== 'completed' || payload?.ok !== true || typeof payload.error === 'string'
    || !object(payload.edit) || typeof payload.edit.count !== 'number' || payload.edit.count <= 0 || !metadata(payload.editUndo)) return undefined
  const edit = payload.editUndo
  return edit.runId === row.run_id && edit.toolCallId === row.tool_call_id && payload.backupId === edit.backupId ? edit : undefined
}

const evidenceKind = (toolCallId: string): string => 'file_edit_undo_v1:' + toolCallId
type UndoRecord = UndoFileEditInput & { schemaVersion: 1; before: string; after: string; status: 'pending' | 'undone'; updatedAt: number }
function recordMatches(value: unknown, edit: FileEditUndoMetadata): value is UndoRecord {
  return object(value) && value.schemaVersion === 1 && value.runId === edit.runId && value.sessionId === edit.sessionId && value.toolCallId === edit.toolCallId
    && value.before === edit.before.sha256 && value.after === edit.after.sha256 && (value.status === 'pending' || value.status === 'undone')
}
function readUndoRecord(repo: ReadPort, edit: FileEditUndoMetadata): { present: boolean; record?: UndoRecord } {
  const stored = repo.getRunEvidence(edit.runId, evidenceKind(edit.toolCallId))
  if (!stored) return { present: false }
  try { const value: unknown = JSON.parse(stored.json); return { present: true, ...(recordMatches(value, edit) ? { record: value } : {}) } }
  catch { return { present: true } }
}

/** Bounded historical/live receipt projection. Availability is only a hint;
 * undoFileEdit rechecks disk, checkpoint, authorization and durable identity. */
export function fileEditUndoRef(repo: ReadPort, row: Pick<ToolCallRow, 'name' | 'status' | 'result_json' | 'run_id' | 'tool_call_id'>): FileEditUndoRef | undefined {
  const edit = editMetadata(row)
  if (!edit || repo.getRun(edit.runId)?.session_id !== edit.sessionId) return undefined
  const stored = readUndoRecord(repo, edit)
  return { sessionId: edit.sessionId, runId: edit.runId, toolCallId: edit.toolCallId,
    status: !stored.present ? 'available' : stored.record?.status === 'undone' ? 'undone' : 'blocked' }
}

class UndoBlocked extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
function deny(code: string, message: string): never { throw new UndoBlocked(code, message) }

async function noSymlinksBelow(file: string, root: string): Promise<void> {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    // An existing configured root may itself live below a stable junction
    // (for example Documents). Its frozen realpath is checked separately.
    if (samePath(current, root)) return
    if ((await fs.lstat(current)).isSymbolicLink()) deny('path_changed', '文件路径包含符号链接或目录联接，未撤销')
    if (current === path.dirname(current)) deny('path_not_allowed', '文件不在授权目录内，未撤销')
  }
}

async function assertRootsAndPath(edit: FileEditUndoMetadata, frozen: Roots, current: Roots): Promise<void> {
  for (const key of ['workDir', 'docDir'] as const) {
    if (!absolute(frozen[key]) || !absolute(current[key]) || !samePath(frozen[key], edit.roots[key]) || !samePath(current[key], frozen[key])) deny('project_changed', '当前项目目录与当时改稿的冻结目录不同，未撤销')
  }
  const requestedRoot = edit.roots[edit.authorizedRoot]
  const targetRoot = edit.roots[edit.authorizedRoot === 'workDir' ? 'realWorkDir' : 'realDocDir']
  if (!targetRoot || !samePath(await fs.realpath(current[edit.authorizedRoot]), targetRoot)) deny('project_changed', '项目目录的真实路径已变化，未撤销')
  if (!within(edit.targetPath, targetRoot) || !within(edit.requestedPath, requestedRoot)) deny('path_not_allowed', '原稿不在本次运行的授权目录内，未撤销')
  await noSymlinksBelow(edit.requestedPath, requestedRoot)
  await noSymlinksBelow(edit.targetPath, targetRoot)
  if (!samePath(await fs.realpath(edit.requestedPath), edit.targetPath) || !(await fs.stat(edit.targetPath)).isFile()) deny('path_changed', '原稿路径已变化，未撤销')
}

/** The only user-facing edit-undo operation. A durable claim precedes the
 * guarded atomic rename. A crash/ambiguous write is never replayed; completed
 * tombstones make repeats harmless even after another edit or another undo. */
export async function undoFileEdit(options: { repository: UndoPort; checkpoints: CheckpointStore | null; currentRoots: Roots }, input: UndoFileEditInput): Promise<UndoFileEditResult> {
  const { repository: repo, checkpoints, currentRoots } = options
  try {
    if (!input || !id(input.sessionId) || !id(input.runId) || !id(input.toolCallId)) deny('invalid_identity', '改稿标识无效，未撤销')
    const run = repo.getRun(input.runId), row = repo.getToolCallById(input.toolCallId)
    if (!run || run.session_id !== input.sessionId || !row || row.run_id !== run.run_id) deny('edit_not_found', '此会话中找不到这笔改稿，未撤销')
    const edit = editMetadata(row)
    if (!edit || edit.sessionId !== input.sessionId || row.started_at === null || row.completed_at === null) deny('undo_unavailable', '这笔记录没有可核对的完整原稿和修改后身份，无法安全撤销')
    let config: Record<string, unknown>, args: Record<string, unknown>
    try { config = JSON.parse(run.config_json); args = JSON.parse(row.args_json) }
    catch { return deny('undo_unavailable', '原执行记录不完整，未撤销') }
    if (!object(config) || !object(args) || typeof args.path !== 'string' || typeof args.old_text !== 'string' || typeof args.new_text !== 'string'
      || (config.sessionId !== undefined && config.sessionId !== input.sessionId)
      || !samePath(path.resolve(edit.roots.workDir, args.path), edit.requestedPath)) deny('undo_unavailable', '原执行身份或路径无法核对，未撤销')
    const stored = readUndoRecord(repo, edit)
    if (stored.present && !stored.record) deny('undo_uncertain', '撤销记录无法核对，未再次写盘')
    if (stored.record?.status === 'undone') return { ok: true, status: 'already_undone', code: 'already_undone', message: '这一笔已经撤销，未再次写盘', path: edit.requestedPath }
    const frozen = { workDir: config.workDir, docDir: config.docDir } as Roots
    await assertRootsAndPath(edit, frozen, currentRoots)
    if (!checkpoints?.readForEditUndo) deny('checkpoint_missing', '原稿检查点不可用，未撤销')
    const before = await checkpoints.readForEditUndo(edit.backupId, edit.sessionId, edit.targetPath, edit.checkpointRoot)
    if (!sameBytes(before, edit.before)) deny('checkpoint_changed', '原稿检查点内容不一致，未撤销')
    const expectedAfter = Buffer.from(planManuscriptEdit(decodeManuscript(before), args).text, 'utf8')
    if (!sameBytes(expectedAfter, edit.after)) deny('undo_unavailable', '原改稿内容与执行记录不一致，未撤销')
    const current = await fs.readFile(edit.targetPath)
    const done: UndoRecord = { schemaVersion: 1, ...input, before: edit.before.sha256, after: edit.after.sha256, status: 'undone', updatedAt: Date.now() }
    if (stored.record) {
      if (!sameBytes(current, edit.before)) deny('undo_uncertain', '上次撤销未留下完成确认，未再次覆盖文件')
      repo.saveRunEvidence(edit.runId, evidenceKind(edit.toolCallId), JSON.stringify(done))
      return { ok: true, status: 'already_undone', code: 'already_undone', message: '已确认上次撤销完成，未再次写盘', path: edit.requestedPath }
    }
    if (!sameBytes(current, edit.after)) deny('file_changed', '稿件后来又有修改，未覆盖；请先处理后续改动')
    const pending: UndoRecord = { ...done, status: 'pending' }
    if (!repo.saveRunEvidenceIfAbsent(edit.runId, evidenceKind(edit.toolCallId), JSON.stringify(pending))) deny('undo_uncertain', '另一请求已经处理这笔撤销，未重复写盘')
    await writeBytesAtomically(edit.targetPath, before, undefined, async () => {
      await assertRootsAndPath(edit, frozen, currentRoots)
      if (!sameBytes(await fs.readFile(edit.targetPath), edit.after)) deny('file_changed', '稿件在撤销前又有修改，未覆盖')
      const latest = repo.getToolCallById(input.toolCallId)
      if (!latest || latest.run_id !== input.runId || latest.args_json !== row.args_json || latest.turn_id !== row.turn_id
        || JSON.stringify(editMetadata(latest)) !== JSON.stringify(edit) || repo.getRun(input.runId)?.config_json !== run.config_json) deny('edit_changed', '持久改稿记录已变化，未覆盖文件')
      const durable = readUndoRecord(repo, edit)
      if (durable.record?.status !== 'pending') deny('undo_uncertain', '撤销记录已变化，未覆盖文件')
    }, true)
    repo.saveRunEvidence(edit.runId, evidenceKind(edit.toolCallId), JSON.stringify(done))
    return { ok: true, status: 'undone', code: 'undone', message: '已撤销这一笔改稿', path: edit.requestedPath }
  } catch (error) {
    return { ok: false, status: 'blocked', code: error instanceof UndoBlocked ? error.code : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file_missing' : 'undo_failed',
      message: error instanceof UndoBlocked ? error.message : (error as NodeJS.ErrnoException).code === 'ENOENT' ? '稿件或原稿检查点已缺失，未撤销' : '撤销未能安全完成：' + (error as Error).message }
  }
}
