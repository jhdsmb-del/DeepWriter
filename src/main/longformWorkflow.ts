import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import {
  allowedLongformWorkflowActions,
  applyLongformWorkflowMutation,
  buildLongformWorkflowMutation,
  createLongformWorkflowSnapshot,
  longformWorkflowHash,
  type LongformWorkflowCreateInput,
  type LongformWorkflowDraft,
  type LongformWorkflowMutation,
  type LongformWorkflowMutationInput,
  type LongformWorkflowMutationResult,
  type LongformWorkflowRecallResult,
  type LongformWorkflowSnapshot,
  LongformWorkflowError,
  validateLongformWorkflowSnapshot
} from '../shared/longformWorkflow'
export { selectLongformWorkflowRecall, longformWorkflowRecallAudit, selectRecall, recallSelect, projectLongformWorkflowRecallAudit } from '../shared/longformWorkflow'

export interface LongformWorkflowSnapshotStore {
  save(snapshot: LongformWorkflowSnapshot): Promise<void> | void
  get(workflowId: string): Promise<LongformWorkflowSnapshot | null> | LongformWorkflowSnapshot | null
  getAtRevision?(workflowId: string, revision: number): Promise<LongformWorkflowSnapshot | null> | LongformWorkflowSnapshot | null
}

/** The existing repository snapshot table is the preferred production store.
 *  The optional list method is deliberately structural so old test doubles
 *  and file stores remain source compatible. */
export interface LongformWorkflowRepositorySnapshotRow {
  snapshotId: string
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision: number
  runId: string
  workflowKey: string
  workflowRevision: number
  status: string
  payload: unknown
  payloadHash: string
  createdAt: number
  updatedAt: number
}

export interface LongformWorkflowRepositoryPort {
  saveLongformWorkflowSnapshot(input: {
    snapshotId: string
    storyId: string
    projectId: string
    branchId: string
    validityEpoch: number
    storyRevision: number
    runId: string
    workflowKey: string
    workflowRevision: number
    status: string
    payload: unknown
    payloadHash: string
    createdAt?: number
  }): void
  getLongformWorkflowSnapshot(runId: string, workflowKey: string, workflowRevision?: number): LongformWorkflowRepositorySnapshotRow | null
  listLongformWorkflowSnapshots?(workflowKey: string): LongformWorkflowRepositorySnapshotRow[]
}

interface FileWorkflowRecord {
  schemaVersion: 1
  workflowId: string
  snapshots: LongformWorkflowSnapshot[]
}

const WORKFLOW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u

function assertWorkflowId(workflowId: string): void {
  if (typeof workflowId !== 'string' || !WORKFLOW_ID_RE.test(workflowId)) throw new LongformWorkflowError('longform_workflow_id_invalid')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// A file-backed store can be opened by more than one authority instance in a
// single Electron process (for example a restart harness).  Atomic rename
// alone prevents torn JSON but not a lost update, so serialize the complete
// read/compare/write transaction by canonical file path.
const fileSaveQueues = new Map<string, Promise<unknown>>()
function withFileSaveLock<T>(target: string, work: () => Promise<T>): Promise<T> {
  const previous = fileSaveQueues.get(target) ?? Promise.resolve()
  const result = previous.then(work)
  const tracked = result.then(() => undefined, () => undefined)
  fileSaveQueues.set(target, tracked)
  void result.then(() => {
    if (fileSaveQueues.get(target) === tracked) fileSaveQueues.delete(target)
  }, () => {
    if (fileSaveQueues.get(target) === tracked) fileSaveQueues.delete(target)
  })
  return result
}

function snapshotHash(snapshot: LongformWorkflowSnapshot): string {
  return longformWorkflowHash(snapshot)
}

function snapshotStorageStatus(snapshot: LongformWorkflowSnapshot): 'paused' | 'failed' | 'ready' | 'completed' | 'cancelled' {
  if (snapshot.status === 'completed') return 'completed'
  if (snapshot.status === 'cancelled') return 'cancelled'
  if (snapshot.status === 'provider_failed' || snapshot.status === 'export_failed' || snapshot.stageStatus === 'blocked') return 'failed'
  return snapshot.status === 'draft' || snapshot.stageStatus === 'waiting_user' || snapshot.stageStatus === 'needs_recovery' ? 'paused' : 'ready'
}

/**
 * File-backed append-only store used before a workflow has a run/ledger row.
 * It intentionally stores every authoritative revision: a restart can read
 * the last exact projection without deriving a phase from activity events.
 */
export function createFileLongformWorkflowSnapshotStore(baseDir: string): LongformWorkflowSnapshotStore {
  if (typeof baseDir !== 'string' || baseDir.length === 0) throw new LongformWorkflowError('longform_store_directory_invalid')
  const fileFor = (workflowId: string): string => {
    assertWorkflowId(workflowId)
    return path.join(baseDir, `${workflowId}.json`)
  }

  const readRecord = async (workflowId: string): Promise<FileWorkflowRecord | null> => {
    try {
      const raw = await fs.readFile(fileFor(workflowId), 'utf8')
      const parsed = JSON.parse(raw) as FileWorkflowRecord
      if (!parsed || parsed.schemaVersion !== 1 || parsed.workflowId !== workflowId || !Array.isArray(parsed.snapshots)) throw new Error('record_invalid')
      const snapshots = parsed.snapshots.map((item) => validateLongformWorkflowSnapshot(item))
      for (let index = 1; index < snapshots.length; index += 1) {
        if (snapshots[index]!.authoritativeRevision !== snapshots[index - 1]!.authoritativeRevision + 1) throw new Error('revision_gap')
      }
      return { schemaVersion: 1, workflowId, snapshots }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ENOENT') return null
      if (error instanceof SyntaxError || error instanceof LongformWorkflowError || error instanceof Error && error.message === 'record_invalid' || error instanceof Error && error.message === 'revision_gap') throw new LongformWorkflowError('longform_snapshot_corrupt')
      throw error
    }
  }

  const writeRecord = async (record: FileWorkflowRecord): Promise<void> => {
    await fs.mkdir(baseDir, { recursive: true })
    const target = fileFor(record.workflowId)
    const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
    const json = JSON.stringify(record)
    try {
      await fs.writeFile(temp, json, 'utf8')
      await fs.rename(temp, target)
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined)
      throw error
    }
  }

  return {
    async save(snapshot) {
      const checked = validateLongformWorkflowSnapshot(clone(snapshot))
      const target = fileFor(checked.workflowId)
      await withFileSaveLock(target, async () => {
        const existing = await readRecord(checked.workflowId)
        if (!existing) {
          if (checked.authoritativeRevision !== 0) throw new LongformWorkflowError('longform_revision_gap')
          await writeRecord({ schemaVersion: 1, workflowId: checked.workflowId, snapshots: [checked] })
          return
        }
        const prior = existing.snapshots.find((item) => item.authoritativeRevision === checked.authoritativeRevision)
        if (prior) {
          if (snapshotHash(prior) !== snapshotHash(checked)) throw new LongformWorkflowError('longform_snapshot_conflict')
          return
        }
        const latest = existing.snapshots[existing.snapshots.length - 1]
        if (!latest || checked.authoritativeRevision !== latest.authoritativeRevision + 1) throw new LongformWorkflowError('longform_revision_gap')
        await writeRecord({ ...existing, snapshots: [...existing.snapshots, checked] })
      })
    },
    async get(workflowId) {
      assertWorkflowId(workflowId)
      const record = await readRecord(workflowId)
      return record?.snapshots[record.snapshots.length - 1] ?? null
    },
    async getAtRevision(workflowId, revision) {
      if (!Number.isInteger(revision) || revision < 0) throw new LongformWorkflowError('longform_revision_invalid')
      const record = await readRecord(workflowId)
      return record?.snapshots.find((item) => item.authoritativeRevision === revision) ?? null
    }
  }
}

function repositoryRowToSnapshot(row: LongformWorkflowRepositorySnapshotRow): LongformWorkflowSnapshot {
  if (!row || typeof row.payload !== 'object' || row.payload === null) throw new LongformWorkflowError('longform_snapshot_corrupt')
  const snapshot = validateLongformWorkflowSnapshot(clone(row.payload))
  if (snapshot.workflowId !== row.workflowKey || snapshot.storyId !== row.storyId || snapshot.projectId !== row.projectId || snapshot.branchId !== row.branchId || snapshot.validityEpoch !== row.validityEpoch || snapshot.authoritativeRevision !== row.workflowRevision || snapshot.activeRunId !== null && snapshot.activeRunId !== row.runId || longformWorkflowHash(snapshot) !== row.payloadHash) throw new LongformWorkflowError('longform_snapshot_authority_corrupt')
  return snapshot
}

/** Adapt the already-authoritative repository snapshot table.  The workflow
 * key is the public workflowId and activeRunId binds it to the existing run
 * and story-ledger fence; no second database or renderer-owned state is used. */
export function createRepositoryLongformWorkflowSnapshotStore(repository: LongformWorkflowRepositoryPort): LongformWorkflowSnapshotStore {
  if (!repository || typeof repository.saveLongformWorkflowSnapshot !== 'function' || typeof repository.getLongformWorkflowSnapshot !== 'function') throw new LongformWorkflowError('longform_repository_unavailable')
  const runIds = new Map<string, string>()
  const remember = (snapshot: LongformWorkflowSnapshot): string => {
    const current = runIds.get(snapshot.workflowId)
    const runId = snapshot.activeRunId ?? current
    if (!runId) throw new LongformWorkflowError('longform_repository_run_required')
    runIds.set(snapshot.workflowId, runId)
    return runId
  }
  const rowsFor = (workflowId: string): LongformWorkflowRepositorySnapshotRow[] => {
    const runId = runIds.get(workflowId)
    if (runId) {
      const latest = repository.getLongformWorkflowSnapshot(runId, workflowId)
      return latest ? [latest] : []
    }
    const listed = repository.listLongformWorkflowSnapshots?.(workflowId) ?? []
    return listed.slice().sort((left, right) => right.workflowRevision - left.workflowRevision)
  }
  return {
    save(snapshot) {
      const checked = validateLongformWorkflowSnapshot(clone(snapshot))
      const runId = remember(checked)
      const existing = repository.getLongformWorkflowSnapshot(runId, checked.workflowId, checked.authoritativeRevision)
      if (existing) {
        const prior = repositoryRowToSnapshot(existing)
        if (longformWorkflowHash(prior) !== longformWorkflowHash(checked)) throw new LongformWorkflowError('longform_snapshot_conflict')
        return
      }
      repository.saveLongformWorkflowSnapshot({
        snapshotId: `${checked.workflowId}:snapshot:${checked.authoritativeRevision}`,
        storyId: checked.storyId,
        projectId: checked.projectId,
        branchId: checked.branchId,
        validityEpoch: checked.validityEpoch,
        storyRevision: 0,
        runId,
        workflowKey: checked.workflowId,
        workflowRevision: checked.authoritativeRevision,
        status: snapshotStorageStatus(checked),
        payload: checked,
        payloadHash: longformWorkflowHash(checked),
        createdAt: checked.updatedAt
      })
    },
    get(workflowId) {
      assertWorkflowId(workflowId)
      const row = rowsFor(workflowId)[0]
      return row ? repositoryRowToSnapshot(row) : null
    },
    getAtRevision(workflowId, revision) {
      assertWorkflowId(workflowId)
      if (!Number.isInteger(revision) || revision < 0) throw new LongformWorkflowError('longform_revision_invalid')
      const runId = runIds.get(workflowId)
      const row = runId ? repository.getLongformWorkflowSnapshot(runId, workflowId, revision) : (repository.listLongformWorkflowSnapshots?.(workflowId) ?? []).find((candidate) => candidate.workflowRevision === revision)
      return row ? repositoryRowToSnapshot(row) : null
    }
  }
}

/** Hybrid durable store for the lifecycle before and after a real run exists.
 * Pre-run Grill/requirements state is durable in the app data directory; once
 * a run is bound, revisions are written to the existing Repository table.
 * Reads merge both histories, which makes restart/recovery exact across the
 * binding boundary without inventing a fake run or touching the story ledger. */
export function createHybridLongformWorkflowSnapshotStore(input: {
  repository: LongformWorkflowRepositoryPort
  baseDir: string
}): LongformWorkflowSnapshotStore {
  const repositoryStore = createRepositoryLongformWorkflowSnapshotStore(input.repository)
  const fileStore = createFileLongformWorkflowSnapshotStore(input.baseDir)
  const choose = (left: LongformWorkflowSnapshot | null, right: LongformWorkflowSnapshot | null): LongformWorkflowSnapshot | null => {
    if (!left) return right
    if (!right) return left
    if (left.authoritativeRevision !== right.authoritativeRevision) return left.authoritativeRevision > right.authoritativeRevision ? left : right
    if (longformWorkflowHash(left) !== longformWorkflowHash(right)) throw new LongformWorkflowError('longform_snapshot_conflict')
    return left
  }
  return {
    async save(snapshot) {
      const checked = validateLongformWorkflowSnapshot(clone(snapshot))
      if (checked.activeRunId) return repositoryStore.save(checked)
      return fileStore.save(checked)
    },
    async get(workflowId) {
      const [fromRepository, fromFile] = await Promise.all([repositoryStore.get(workflowId), fileStore.get(workflowId)])
      return choose(fromRepository, fromFile)
    },
    async getAtRevision(workflowId, revision) {
      const [fromRepository, fromFile] = await Promise.all([repositoryStore.getAtRevision?.(workflowId, revision) ?? null, fileStore.getAtRevision?.(workflowId, revision) ?? null])
      return choose(fromRepository, fromFile)
    }
  }
}

export function createMemoryLongformWorkflowSnapshotStore(): LongformWorkflowSnapshotStore {
  const records = new Map<string, LongformWorkflowSnapshot[]>()
  return {
    save(snapshot) {
      const checked = validateLongformWorkflowSnapshot(clone(snapshot))
      const list = records.get(checked.workflowId) ?? []
      const prior = list.find((item) => item.authoritativeRevision === checked.authoritativeRevision)
      if (prior) {
        if (snapshotHash(prior) !== snapshotHash(checked)) throw new LongformWorkflowError('longform_snapshot_conflict')
        return
      }
      const latest = list[list.length - 1]
      if (!latest && checked.authoritativeRevision !== 0 || latest && checked.authoritativeRevision !== latest.authoritativeRevision + 1) throw new LongformWorkflowError('longform_revision_gap')
      records.set(checked.workflowId, [...list, checked])
    },
    get(workflowId) {
      const list = records.get(workflowId)
      return list?.[list.length - 1] ? clone(list[list.length - 1]!) : null
    },
    getAtRevision(workflowId, revision) {
      const item = records.get(workflowId)?.find((candidate) => candidate.authoritativeRevision === revision)
      return item ? clone(item) : null
    }
  }
}

export interface LongformWorkflowAuthorityOptions {
  store?: LongformWorkflowSnapshotStore
  /** If no store is supplied, this directory receives atomic JSON snapshots. */
  baseDir?: string
  now?: () => number
  onSnapshot?: (snapshot: LongformWorkflowSnapshot) => void
}

export interface LongformWorkflowStopInput {
  workflowId: string
  operationId: string
  expectedRevision: number
  payload?: unknown
  draft?: LongformWorkflowDraft | null
  note?: string | null
}

export interface LongformWorkflowAuthority {
  create(input: LongformWorkflowCreateInput): Promise<LongformWorkflowSnapshot>
  get(workflowId: string): Promise<LongformWorkflowSnapshot | null>
  getAtRevision(workflowId: string, revision: number): Promise<LongformWorkflowSnapshot | null>
  mutate(input: LongformWorkflowMutationInput | LongformWorkflowMutation): Promise<LongformWorkflowSnapshot>
  mutateResult(input: LongformWorkflowMutationInput | LongformWorkflowMutation): Promise<LongformWorkflowMutationResult>
  stop(input: LongformWorkflowStopInput): Promise<LongformWorkflowSnapshot>
  resume(input: { workflowId: string; operationId: string; expectedRevision: number; payload?: unknown; note?: string | null }): Promise<LongformWorkflowSnapshot>
  recover(workflowId: string): Promise<LongformWorkflowSnapshot | null>
  subscribe(workflowId: string, listener: (snapshot: LongformWorkflowSnapshot) => void): () => void
  listAllowedActions(workflowId: string): Promise<LongformWorkflowSnapshot['allowedActions']>
}

export interface LongformWorkflowSceneWorkingSetProjection {
  runId: string
  sessionId: string
  storyId?: string
  projectId?: string
  branchId?: string
  sceneId?: string | null
  validityEpoch: number
  storyRevision: number
  workingSetHash: string
  manifestHash: string
  sourceSnapshotHash: string
  sourceCardSetHash: string
  queryHash: string
  indexHash: string
  audit: LongformWorkflowRecallResult
}

/**
 * Production observer used by contextService after it persists a real Scene
 * Working Set.  It is intentionally hosted beside the authority so a caller
 * cannot mark recall/draft progress by sending an arbitrary `sceneWorkingSet`
 * payload through IPC.  The only accepted audit is the projection generated
 * from the repository-authenticated corpus/index by contextService.
 */
export async function projectLongformWorkflowSceneWorkingSet(
  authority: LongformWorkflowAuthority,
  input: LongformWorkflowSceneWorkingSetProjection
): Promise<LongformWorkflowSnapshot> {
  let snapshot = await authority.get(input.sessionId)
  if (!snapshot) {
    snapshot = await authority.create({
      workflowId: input.sessionId,
      sessionId: input.sessionId,
      storyId: input.storyId,
      projectId: input.projectId,
      branchId: input.branchId,
      sceneId: input.sceneId,
      activeRunId: input.runId,
      validityEpoch: input.validityEpoch,
      now: Date.now()
    })
  }
  const stages = ['requirements', 'outline', 'scene_direction', 'recall', 'draft', 'critique', 'revision', 'semantic_review', 'commit', 'reorientation', 'export'] as const
  const targetSteps: Array<{ stage: 'scene_direction' | 'recall' | 'draft'; status: 'running' | 'candidate'; audit?: LongformWorkflowRecallResult }> = [
    { stage: 'scene_direction', status: 'running' },
    { stage: 'recall', status: 'candidate', audit: input.audit },
    { stage: 'draft', status: 'running', audit: input.audit }
  ]
  const payload = {
    kind: 'scene_working_set_recall',
    runId: input.runId,
    sceneId: input.sceneId ?? null,
    workingSetHash: input.workingSetHash,
    manifestHash: input.manifestHash,
    sourceSnapshotHash: input.sourceSnapshotHash,
    sourceCardSetHash: input.sourceCardSetHash,
    queryHash: input.queryHash,
    indexHash: input.indexHash,
    includedCardIds: input.audit.included,
    omitted: input.audit.omitted
  }
  for (const target of targetSteps) {
    const targetIndex = stages.indexOf(target.stage)
    const currentIndex = stages.indexOf(snapshot.stage as (typeof stages)[number])
    if (currentIndex > targetIndex) continue
    if (snapshot.activeRunId !== input.runId) {
      const bindId = `scene-bind:${input.runId}:${longformWorkflowHash({ workflowId: input.sessionId, runId: input.runId, revision: snapshot.authoritativeRevision }).slice(0, 48)}`
      snapshot = await authority.mutate({ workflowId: input.sessionId, operationId: bindId, expectedRevision: snapshot.authoritativeRevision, action: 'resolve_stage', targetStage: snapshot.stage, targetStatus: snapshot.status, activeRunId: input.runId, payload: { kind: 'bind_execution_run', runId: input.runId } })
    }
    while (true) {
      const stepCurrentIndex = stages.indexOf(snapshot.stage as (typeof stages)[number])
      if (stepCurrentIndex > targetIndex) break
      const sameStage = stepCurrentIndex === targetIndex
      // An older/quick-bypass snapshot may have materialized the outline as
      // `ready` without a candidate gate.  Promote it through the legal
      // same-stage outline edit before accepting it into scene direction;
      // never weaken accept_candidate to make an invalid edge pass.
      if (!sameStage && snapshot.stage === 'outline' && snapshot.status !== 'candidate') {
        const promoteId = `scene-outline-candidate:${input.runId}:${longformWorkflowHash({ workflowId: input.sessionId, runId: input.runId, revision: snapshot.authoritativeRevision, payload }).slice(0, 48)}`
        snapshot = await authority.mutate({
          workflowId: input.sessionId,
          operationId: promoteId,
          expectedRevision: snapshot.authoritativeRevision,
          action: 'update_outline',
          targetStage: 'outline',
          targetStatus: 'candidate',
          payload,
          activeRunId: input.runId
        })
        continue
      }
      const stepStage = sameStage ? target.stage : stages[stepCurrentIndex + 1]!
      // A fresh v2 working-set callback can be the first durable observer for
      // a long-form session.  Bootstrap the outline as a candidate so the
      // subsequent outline -> scene_direction edge is the same explicit
      // accept_candidate gate used by a confirmed Grill outline.  Starting it
      // as `ready` would make that legal edge unavailable and would leave the
      // accepted run without an authoritative phase.
      const stepStatus = sameStage ? target.status : stepStage === 'outline' ? 'candidate' as const : 'ready' as const
      const action = sameStage
        ? stepStage === 'recall' ? 'start_recall' as const
          : stepStage === 'draft' ? 'start_draft' as const
            : 'resolve_stage' as const
        : snapshot.status === 'candidate' || snapshot.stage === 'outline' && stepStage === 'scene_direction' ? 'accept_candidate' as const : 'resolve_stage' as const
      const operationId = `scene:${input.runId}:${longformWorkflowHash({ workflowId: input.sessionId, runId: input.runId, stage: stepStage, status: stepStatus, payload, audit: target.audit ?? null }).slice(0, 48)}`
      snapshot = await authority.mutate({
        workflowId: input.sessionId,
        operationId,
        expectedRevision: snapshot.authoritativeRevision,
        action,
        targetStage: stepStage,
        targetStatus: stepStatus,
        payload,
        activeRunId: input.runId,
        ...(target.audit === undefined ? {} : { recallAudit: target.audit }),
        ...(sameStage && (target.stage === 'recall' || target.stage === 'draft') ? { workingSetHash: input.workingSetHash, manifestHash: input.manifestHash, validityEpoch: input.validityEpoch } : {})
      })
      if (sameStage) break
    }
  }
  return snapshot
}

export function createLongformWorkflowAuthority(options: LongformWorkflowAuthorityOptions = {}): LongformWorkflowAuthority {
  const store = options.store ?? createFileLongformWorkflowSnapshotStore(options.baseDir ?? path.join(process.cwd(), 'longform-workflows'))
  const now = options.now ?? (() => Date.now())
  const subscribers = new Map<string, Set<(snapshot: LongformWorkflowSnapshot) => void>>()
  // A mutation is a read/validate/apply/persist unit.  Queue the whole unit,
  // rather than just the write, so two callers cannot both observe revision N.
  const workflowQueues = new Map<string, Promise<unknown>>()

  const enqueue = <T>(workflowId: string, work: () => Promise<T>): Promise<T> => {
    assertWorkflowId(workflowId)
    const previous = workflowQueues.get(workflowId) ?? Promise.resolve()
    const result = previous.then(work)
    const tracked = result.then(() => undefined, () => undefined)
    workflowQueues.set(workflowId, tracked)
    void result.then(() => {
      if (workflowQueues.get(workflowId) === tracked) workflowQueues.delete(workflowId)
    }, () => {
      if (workflowQueues.get(workflowId) === tracked) workflowQueues.delete(workflowId)
    })
    return result
  }

  const emit = (snapshot: LongformWorkflowSnapshot): void => {
    options.onSnapshot?.(clone(snapshot))
    for (const listener of subscribers.get(snapshot.workflowId) ?? []) {
      try { listener(clone(snapshot)) } catch { /* one subscriber cannot block state persistence */ }
    }
  }

  const read = async (workflowId: string): Promise<LongformWorkflowSnapshot | null> => {
    assertWorkflowId(workflowId)
    const snapshot = await store.get(workflowId)
    if (!snapshot) return null
    const checked = validateLongformWorkflowSnapshot(clone(snapshot))
    if (checked.workflowId !== workflowId) throw new LongformWorkflowError('longform_workflow_id_mismatch')
    const expectedActions = allowedLongformWorkflowActions(checked)
    if (JSON.stringify(expectedActions) !== JSON.stringify(checked.allowedActions)) throw new LongformWorkflowError('longform_snapshot_authority_corrupt')
    return checked
  }

  const persist = async (snapshot: LongformWorkflowSnapshot): Promise<void> => {
    await store.save(validateLongformWorkflowSnapshot(snapshot))
    emit(snapshot)
  }

  const create = (input: LongformWorkflowCreateInput): Promise<LongformWorkflowSnapshot> => enqueue(input.workflowId, async () => {
    const existing = await read(input.workflowId)
    if (existing) {
      const requested = createLongformWorkflowSnapshot({ ...input, now: existing.updatedAt })
      const scopeConflict = existing.storyId !== requested.storyId || existing.projectId !== requested.projectId || existing.branchId !== requested.branchId
      // A pre-run Grill snapshot may have been created before chat:start knew
      // the durable story scope.  It is allowed to acquire that scope exactly
      // once during the later real-run bind; active repository snapshots are
      // never silently re-scoped.
      if (existing.sessionId !== requested.sessionId || existing.activeRunId !== null && (scopeConflict || input.activeRunId !== undefined && existing.activeRunId !== requested.activeRunId) || existing.activeRunId === null && input.activeRunId !== undefined && scopeConflict) throw new LongformWorkflowError('longform_create_conflict')
      return existing
    }
    const snapshot = createLongformWorkflowSnapshot({ ...input, now: input.now ?? now() })
    await persist(snapshot)
    return snapshot
  })

  const mutateResult = (rawInput: LongformWorkflowMutationInput | LongformWorkflowMutation): Promise<LongformWorkflowMutationResult> => {
    // Build before entering the queue to reject malformed IPC payloads early;
    // all state-dependent checks still happen inside the serialized section.
    const input = buildLongformWorkflowMutation(rawInput)
    return enqueue(input.workflowId, async () => {
      const current = await read(input.workflowId)
      if (!current) throw new LongformWorkflowError('longform_workflow_not_found')
      const priorHash = current.appliedOperations[input.operationId]
      if (priorHash !== undefined && priorHash === input.canonicalPayloadHash) return { snapshot: current, idempotent: true }
      const next = applyLongformWorkflowMutation(current, input, now())
      await persist(next)
      return { snapshot: next, idempotent: false }
    })
  }

  return {
    create,
    async get(workflowId) {
      return read(workflowId)
    },
    async getAtRevision(workflowId, revision) {
      assertWorkflowId(workflowId)
      if (store.getAtRevision) {
        const result = await store.getAtRevision(workflowId, revision)
        return result ? validateLongformWorkflowSnapshot(clone(result)) : null
      }
      const latest = await read(workflowId)
      return latest?.authoritativeRevision === revision ? latest : null
    },
    async mutate(input) {
      return (await mutateResult(input)).snapshot
    },
    mutateResult,
    async stop(input) {
      const mutation = buildLongformWorkflowMutation({
        workflowId: input.workflowId,
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        action: 'stop',
        targetStatus: 'draft',
        payload: input.payload,
        note: input.note,
        draft: input.draft
      })
      return (await mutateResult(mutation)).snapshot
    },
    async resume(input) {
      const mutation = buildLongformWorkflowMutation({
        workflowId: input.workflowId,
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        action: 'resume_draft',
        targetStatus: 'running',
        payload: input.payload,
        note: input.note,
      })
      return (await mutateResult(mutation)).snapshot
    },
    async recover(workflowId) {
      // Recovery is read-only. In particular, do not infer a new stage from a
      // low-level run phase or auto-step a pending provider operation.
      return read(workflowId)
    },
    subscribe(workflowId, listener) {
      assertWorkflowId(workflowId)
      const set = subscribers.get(workflowId) ?? new Set<(snapshot: LongformWorkflowSnapshot) => void>()
      set.add(listener)
      subscribers.set(workflowId, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) subscribers.delete(workflowId)
      }
    },
    async listAllowedActions(workflowId) {
      const snapshot = await read(workflowId)
      if (!snapshot) throw new LongformWorkflowError('longform_workflow_not_found')
      return [...snapshot.allowedActions]
    }
  }
}

/** Useful when adapting the existing repository snapshot table. */
export function repositorySnapshotPayload(snapshot: LongformWorkflowSnapshot): { payload: LongformWorkflowSnapshot; payloadHash: string; status: 'paused' | 'failed' | 'ready' | 'completed' | 'cancelled' } {
  return { payload: clone(snapshot), payloadHash: longformWorkflowHash(snapshot), status: snapshotStorageStatus(snapshot) }
}
