/**
 * R74 / WP6 independent acceptance for the production longform workflow
 * authority.
 *
 * Baseline red (recorded before this rewrite): the former script imported
 * AgentRunEngine and looked for a non-production authority export, so it ran
 * only 1 PASS / 1 FAIL (`workflow_authority_missing`).  It also carried a
 * test-local reducer/state model.  This script deliberately has no reducer:
 * every transition, hash, action list, snapshot read/write, and corruption
 * decision below comes from src/shared/longformWorkflow.ts or
 * src/main/longformWorkflow.ts.  Recall is exercised through the production
 * SceneWorkingSet projection helper; a standalone selector result is not
 * evidence of that wiring.
 */
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRepository, type Repository, type RunRow } from '../src/main/db/repository'
import { buildSceneMemoryCard, sceneMemoryCardHash, sha256Text } from '../src/main/narrative/sceneMemoryCard'
import { buildSceneContractPlan } from '../src/main/narrative/sceneContract'
import { compileSceneWorkingSet, sceneRecallSourceSnapshotSetHash } from '../src/main/narrative/sceneContextCompiler'
import { buildDeterministicRecallIndex, SCENE_RECALL_BM25_VERSION, SCENE_RECALL_TOKENIZER_VERSION, sceneRecallAuthorityHash, sceneRecallSourceCardSetHash, sceneRecallSourceSnapshotHash } from '../src/main/narrative/recallIndex'
import * as productionMainWorkflow from '../src/main/longformWorkflow'
import {
  buildLongformWorkflowMutation,
  longformWorkflowHash,
  projectLongformWorkflowRecallAudit,
  stableLongformWorkflowJson,
  type LongformWorkflowAction,
  type LongformWorkflowMutation,
  type LongformWorkflowSnapshot
} from '../src/shared/longformWorkflow'
import * as productionSharedWorkflow from '../src/shared/longformWorkflow'
import type { GrillMeOutline } from '../src/shared/grillMe'
import type { SceneMemoryCard, SceneMemorySourceSegment, SceneRecallCorpusItem, SceneRecallCorpusSnapshot, SceneRecallQuery } from '../src/shared/types'

let passed = 0
let failed = 0

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AssertionError') return error.message
    const code = (error as Error & { code?: unknown }).code
    return typeof code === 'string' ? code : error.message
  }
  return String(error)
}

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${name} — ${messageOf(error)}`)
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${name} — ${messageOf(error)}`)
  }
}

async function expectCode(code: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn()
  } catch (error) {
    assert.equal(messageOf(error), code)
    return
  }
  throw new Error(`expected_${code}`)
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableLongformWorkflowJson(left) === stableLongformWorkflowJson(right)
}

function sameRepositoryJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mutation(
  snapshot: LongformWorkflowSnapshot,
  operationId: string,
  action: LongformWorkflowMutation['action'],
  payload: unknown,
  extra: Partial<LongformWorkflowMutation> = {}
): LongformWorkflowMutation {
  return buildLongformWorkflowMutation({
    workflowId: snapshot.workflowId,
    operationId,
    action,
    expectedRevision: snapshot.authoritativeRevision,
    payload,
    ...extra
  })
}

function makeRun(runId: string): RunRow {
  return {
    run_id: runId,
    session_id: 'r74-session',
    status: 'running',
    phase: 'writing',
    started_at: 1,
    updated_at: 1,
    config_json: JSON.stringify({
      storyScope: { schemaVersion: 1, storyId: 'r74-story', projectId: 'r74-project', branchId: 'main' }
    }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  }
}

function repositorySentinel(repo: Repository, runId: string): unknown {
  const scope = repo.getStoryLedgerScope(runId)
  if (!scope) throw new Error('story_ledger_scope_missing')
  const ledger = repo.getStoryLedger({
    schemaVersion: 1,
    storyId: 'r74-story',
    projectId: 'r74-project',
    branchId: 'main'
  })
  const cards = repo.listSceneMemoryCards({
    storyId: 'r74-story',
    projectId: 'r74-project',
    branchId: 'main',
    validityEpoch: 1,
    includeHidden: true
  })
  return { scope, ledger, cards }
}

async function createFileAuthority(baseDir: string, now = 100): Promise<ReturnType<typeof productionMainWorkflow.createLongformWorkflowAuthority>> {
  return productionMainWorkflow.createLongformWorkflowAuthority({ baseDir, now: () => now })
}

async function assertRestart(
  baseDir: string,
  expected: LongformWorkflowSnapshot,
  label: string
): Promise<ReturnType<typeof productionMainWorkflow.createLongformWorkflowAuthority>> {
  const reopened = await createFileAuthority(baseDir, expected.updatedAt + 1)
  const restored = await reopened.get(expected.workflowId)
  assert.ok(restored)
  assert.ok(sameJson(restored, expected), `${label}: restored snapshot differs`)
  const actions = await reopened.listAllowedActions(expected.workflowId)
  assert.ok(sameJson(actions, expected.allowedActions), `${label}: server actions differ`)
  return reopened
}

async function mutationContractChecks(): Promise<void> {
  const memory = productionMainWorkflow.createLongformWorkflowAuthority({
    store: productionMainWorkflow.createMemoryLongformWorkflowSnapshotStore(),
    now: () => 10
  })
  const initial = await memory.create({
    workflowId: 'r74-memory-contract',
    storyId: 'r74-story',
    projectId: 'r74-project',
    branchId: 'main',
    sessionId: 'r74-session',
    now: 10
  })
  const first = mutation(initial, 'op-contract-1', 'resolve_stage', { answer: 'confirmed' }, {
    targetStage: 'outline',
    targetStatus: 'candidate'
  })
  const serverInitialActions = await memory.listAllowedActions(initial.workflowId)
  const applied = await memory.mutateResult(first)
  await checkAsync('memory authority applies production mutation at revision 1', async () => {
    assert.equal(applied.idempotent, false)
    assert.equal(applied.snapshot.authoritativeRevision, 1)
    assert.equal(applied.snapshot.stage, 'outline')
    assert.equal(applied.snapshot.status, 'candidate')
  })

  await checkAsync('same operation + same complete payload is idempotent', async () => {
    const replay = await memory.mutateResult(first)
    assert.equal(replay.idempotent, true)
    assert.ok(sameJson(replay.snapshot, applied.snapshot))
  })

  let laterSnapshot: LongformWorkflowSnapshot | null = null
  await checkAsync('a later distinct mutation advances the authority once', async () => {
    const later = await memory.mutateResult(mutation(applied.snapshot, 'op-contract-later', 'accept_candidate', { answer: 'later' }, {
      targetStage: 'scene_direction',
      targetStatus: 'ready'
    }))
    assert.equal(later.idempotent, false)
    assert.equal(later.snapshot.authoritativeRevision, applied.snapshot.authoritativeRevision + 1)
    laterSnapshot = later.snapshot
  })

  if (laterSnapshot) {
    await checkAsync('replay of an earlier operation after a later success is idempotent and does not regress authority', async () => {
      const replay = await memory.mutateResult(first)
      assert.equal(replay.idempotent, true)
      // Production stores the operation hash and returns the current
      // authoritative projection (not a historical result); it must never
      // append a revision or return the pre-later state.
      assert.equal(replay.snapshot.authoritativeRevision, laterSnapshot?.authoritativeRevision)
      assert.ok(sameJson(replay.snapshot, await memory.get(initial.workflowId)))
    })

    await checkAsync('same operation + different payload still conflicts after a later success', async () => {
      const changedAfterLater = buildLongformWorkflowMutation({
        workflowId: initial.workflowId,
        operationId: first.operationId,
        action: first.action,
        expectedRevision: initial.authoritativeRevision,
        payload: { answer: 'tampered-after-later' },
        targetStage: 'outline',
        targetStatus: 'candidate'
      })
      await expectCode('longform_operation_conflict', () => memory.mutate(changedAfterLater))
    })
  }

  await checkAsync('same operation + different payload returns conflict', async () => {
    const changed = buildLongformWorkflowMutation({
      workflowId: initial.workflowId,
      operationId: first.operationId,
      action: first.action,
      expectedRevision: initial.authoritativeRevision,
      payload: { answer: 'tampered' },
      targetStage: 'outline',
      targetStatus: 'candidate'
    })
    await expectCode('longform_operation_conflict', () => memory.mutate(changed))
  })

  await checkAsync('stale expected revision returns conflict diff', async () => {
    const stale = mutation(initial, 'op-contract-stale', 'stop', { reason: 'stale' }, {
      targetStage: 'requirements',
      targetStatus: 'draft'
    })
    await expectCode('longform_revision_conflict', () => memory.mutate(stale))
  })

  await checkAsync('caller supplied wrong canonical hash fails closed', async () => {
    await expectCode('longform_payload_hash_mismatch', () => buildLongformWorkflowMutation({
      workflowId: initial.workflowId,
      operationId: 'op-contract-bad-hash',
      action: 'stop',
      expectedRevision: applied.snapshot.authoritativeRevision,
      payload: { reason: 'bad-hash' },
      targetStage: 'outline',
      targetStatus: 'draft',
      canonicalPayloadHash: '0'.repeat(64)
    }))
  })

  check('server-derived actions at requirements', () => {
    assert.deepEqual(serverInitialActions, ['resolve_stage', 'stop'])
  })
  const serverCurrentActions = await memory.listAllowedActions(applied.snapshot.workflowId)
  check('server-derived actions remain the persisted projection after later mutation', () => {
    assert.ok(laterSnapshot)
    assert.deepEqual(serverCurrentActions, laterSnapshot?.allowedActions)
    assert.deepEqual(laterSnapshot?.allowedActions, ['resolve_stage', 'stop'])
  })
}

async function phaseRestartChecks(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-r74-phase-'))
  const workflowId = 'r74-phase-restart'
  let authority = await createFileAuthority(root, 100)
  let state = await authority.create({
    workflowId,
    storyId: 'r74-story',
    projectId: 'r74-project',
    branchId: 'main',
    sessionId: 'r74-session',
    now: 100
  })
  const expected = new Map<number, LongformWorkflowSnapshot>([[state.authoritativeRevision, state]])

  const restart = async (label: string): Promise<void> => {
    authority = await assertRestart(root, state, label)
    const restored = await authority.get(workflowId)
    assert.ok(restored)
    state = restored
    expected.set(state.authoritativeRevision, state)
  }

  await checkAsync('restart preserves requirements ready phase', async () => {
    await restart('requirements')
    assert.equal(state.stage, 'requirements')
    assert.equal(state.status, 'ready')
  })

  const apply = async (
    label: string,
    operationId: string,
    action: LongformWorkflowAction,
    payload: unknown,
    extra: Partial<LongformWorkflowMutation>
  ): Promise<void> => {
    const result = await authority.mutateResult(mutation(state, operationId, action, payload, extra))
    assert.equal(result.idempotent, false)
    state = result.snapshot
    expected.set(state.authoritativeRevision, state)
    await restart(label)
  }

  await checkAsync('restart preserves candidate phase', async () => {
    await apply('outline-candidate', 'op-phase-outline', 'resolve_stage', { stage: 'requirements', output: 'candidate' }, {
      targetStage: 'outline',
      targetStatus: 'candidate'
    })
    assert.equal(state.stage, 'outline')
    assert.equal(state.status, 'candidate')
    assert.deepEqual(await authority.listAllowedActions(workflowId), ['accept_candidate', 'stop'])
  })

  await checkAsync('restart preserves provider_failure phase', async () => {
    await apply('provider-failure', 'op-phase-provider-failure', 'accept_candidate', { stage: 'outline', output: 'accepted' }, {
      targetStage: 'scene_direction',
      targetStatus: 'provider_failed',
      note: 'provider unavailable'
    })
    assert.equal(state.stage, 'scene_direction')
    assert.equal(state.status, 'provider_failed')
    assert.deepEqual(await authority.listAllowedActions(workflowId), ['retry_provider', 'stop'])
  })

  await checkAsync('restart preserves waiting phase after provider retry', async () => {
    await apply('provider-waiting', 'op-phase-provider-retry', 'retry_provider', { attempt: 2 }, {
      targetStage: 'scene_direction',
      targetStatus: 'waiting_user'
    })
    assert.equal(state.stage, 'scene_direction')
    assert.equal(state.status, 'waiting_user')
    assert.deepEqual(await authority.listAllowedActions(workflowId), ['resolve_stage', 'stop'])
  })

  await checkAsync('restart preserves recall transition and candidate gate', async () => {
    await apply('recall-ready', 'op-phase-recall-ready', 'resolve_stage', { stage: 'scene_direction', output: 'ready' }, {
      targetStage: 'recall',
      targetStatus: 'ready'
    })
    await apply('recall-candidate', 'op-phase-recall-candidate', 'start_recall', { cards: ['scene-1'] }, {
      targetStage: 'recall',
      targetStatus: 'candidate'
    })
    assert.equal(state.stage, 'recall')
    assert.equal(state.status, 'candidate')
    assert.deepEqual(await authority.listAllowedActions(workflowId), ['accept_candidate', 'stop'])
  })

  await checkAsync('stop saves only draft at the exact draft phase', async () => {
    await apply('draft-ready', 'op-phase-draft-ready', 'accept_candidate', { stage: 'recall', output: 'accepted' }, {
      targetStage: 'draft',
      targetStatus: 'ready'
    })
    const beforeStop = state
    const draftText = '未提交正文：R74 draft checkpoint'
    const stopped = await authority.stop({
      workflowId,
      operationId: 'op-phase-stop-draft',
      expectedRevision: state.authoritativeRevision,
      payload: { reason: 'user_stop' },
      draft: {
        text: draftText,
        contentHash: longformWorkflowHash(draftText),
        segmentId: 'segment-uncommitted',
        sceneId: 'scene-1',
        savedAt: 500
      },
      note: 'user_stop'
    })
    state = stopped
    expected.set(state.authoritativeRevision, state)
    authority = await assertRestart(root, state, 'draft-stop')
    const restored = await authority.get(workflowId)
    assert.ok(restored)
    state = restored
    expected.set(state.authoritativeRevision, state)
    assert.equal(state.stage, beforeStop.stage)
    assert.equal(state.status, 'draft')
    assert.equal(state.stageStatus, 'waiting_user')
    assert.equal(state.draft?.text, draftText)
    assert.equal(state.commitId, beforeStop.commitId)
    assert.equal(state.acceptedSegmentId, beforeStop.acceptedSegmentId)
    assert.deepEqual(await authority.listAllowedActions(workflowId), ['resume_draft', 'stop'])
  })

  await checkAsync('resume draft is an explicit production operation', async () => {
    state = await authority.resume({
      workflowId,
      operationId: 'op-phase-resume-draft',
      expectedRevision: state.authoritativeRevision,
      payload: { reason: 'resume' },
      note: 'resume draft'
    })
    expected.set(state.authoritativeRevision, state)
    assert.equal(state.status, 'running')
    assert.equal(state.stage, 'draft')
  })

  await checkAsync('restart preserves review phase', async () => {
    await apply('draft-candidate', 'op-phase-draft-candidate', 'start_draft', { output: 'candidate' }, {
      targetStage: 'draft',
      targetStatus: 'candidate'
    })
    await apply('critique-ready', 'op-phase-critique-ready', 'accept_candidate', { output: 'draft accepted' }, {
      targetStage: 'critique',
      targetStatus: 'ready'
    })
    await apply('critique-candidate', 'op-phase-critique-candidate', 'start_critique', { output: 'candidate' }, {
      targetStage: 'critique',
      targetStatus: 'candidate'
    })
    await apply('revision-ready', 'op-phase-revision-ready', 'accept_candidate', { output: 'critique accepted' }, {
      targetStage: 'revision',
      targetStatus: 'ready'
    })
    await apply('revision-candidate', 'op-phase-revision-candidate', 'start_revision', { output: 'candidate' }, {
      targetStage: 'revision',
      targetStatus: 'candidate'
    })
    await apply('semantic-review', 'op-phase-semantic-review', 'accept_candidate', { output: 'review' }, {
      targetStage: 'semantic_review',
      targetStatus: 'review'
    })
    assert.equal(state.stage, 'semantic_review')
    assert.equal(state.status, 'review')
    assert.ok((await authority.listAllowedActions(workflowId)).includes('approve_review'))
  })

  await checkAsync('restart preserves commit phase and explicit commit gate', async () => {
    await apply('commit-ready', 'op-phase-commit-ready', 'approve_review', { output: 'approved' }, {
      targetStage: 'commit',
      targetStatus: 'ready'
    })
    assert.equal(state.stage, 'commit')
    assert.equal(state.status, 'ready')
    assert.deepEqual(await authority.listAllowedActions(workflowId), ['commit', 'stop'])
  })

  await checkAsync('export_failed retries only export and preserves completed scene markers', async () => {
    await apply('export-ready', 'op-phase-commit', 'commit', {
      commitId: 'commit-r74-1',
      acceptedSegmentId: 'scene-segment-1'
    }, {
      mainOnly: true,
      targetStage: 'export',
      targetStatus: 'ready',
      reviewDecisionFence: {
        decisionId: 'r74-review-decision',
        packetHash: longformWorkflowHash('r74-review-packet'),
        expectedRevision: Math.max(1, state.authoritativeRevision - 1),
        canonicalPayloadHash: longformWorkflowHash('r74-review-decision')
      }
    })
    const completedMarkers = { acceptedSegmentId: state.acceptedSegmentId, commitId: state.commitId }
    await apply('export-failed', 'op-phase-export-failed', 'export', { attempt: 1 }, {
      targetStage: 'export',
      targetStatus: 'export_failed',
      note: 'export destination unavailable'
    })
    assert.equal(state.stage, 'export')
    assert.equal(state.status, 'export_failed')
    assert.deepEqual(await authority.listAllowedActions(workflowId), ['retry_export', 'stop'])
    assert.ok(!(await authority.listAllowedActions(workflowId)).includes('retry_provider'))
    await apply('export-completed', 'op-phase-export-retry', 'retry_export', { attempt: 2 }, {
      targetStage: 'export',
      targetStatus: 'completed'
    })
    assert.equal(state.stage, 'export')
    assert.equal(state.status, 'completed')
    assert.deepEqual({ acceptedSegmentId: state.acceptedSegmentId, commitId: state.commitId }, completedMarkers)
    assert.deepEqual(await authority.listAllowedActions(workflowId), [])
  })

  await checkAsync('file authority replays every persisted phase revision exactly', async () => {
    for (const [revision, snapshot] of expected) {
      const replay = await authority.getAtRevision(workflowId, revision)
      assert.ok(replay, `missing revision ${revision}`)
      assert.ok(sameJson(replay, snapshot), `revision ${revision} changed after restart`)
    }
    assert.equal(state.authoritativeRevision, Math.max(...expected.keys()))
  })
}

async function repositoryStopInvariantChecks(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-r74-stop-db-'))
  const authorityRoot = path.join(root, 'workflow')
  const dbPath = path.join(root, 'story.sqlite')
  const repo = createRepository(dbPath)
  repo.open()
  const runId = 'r74-stop-run'
  repo.createRun(makeRun(runId))
  const before = repositorySentinel(repo, runId)
  const authority = await createFileAuthority(authorityRoot, 100)
  let state = await authority.create({
    workflowId: 'r74-stop-ledger',
    storyId: 'r74-story',
    projectId: 'r74-project',
    branchId: 'main',
    sessionId: 'r74-session',
    activeRunId: runId,
    now: 100
  })
  state = await authority.mutate(mutation(state, 'op-stop-prep', 'resolve_stage', { output: 'outline candidate' }, {
    targetStage: 'outline',
    targetStatus: 'candidate'
  }))
  const draftText = 'draft remains outside the story ledger'
  const stopped = await authority.stop({
    workflowId: state.workflowId,
    operationId: 'op-stop-ledger',
    expectedRevision: state.authoritativeRevision,
    payload: { reason: 'user_stop' },
    draft: { text: draftText, contentHash: longformWorkflowHash(draftText), savedAt: 200 }
  })
  const after = repositorySentinel(repo, runId)
  repo.close()
  await checkAsync('stop persists draft without changing story ledger/head/card', async () => {
    assert.equal(stopped.status, 'draft')
    assert.equal(stopped.draft?.text, draftText)
    assert.ok(sameRepositoryJson(after, before))
  })
}

async function repositoryAuthorityChecks(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-r74-repository-store-'))
  const dbPath = path.join(root, 'workflow.sqlite')
  const runId = 'r74-repository-run'
  const repository = createRepository(dbPath)
  repository.open()
  try {
    repository.createRun(makeRun(runId))
    const firstAuthority = productionMainWorkflow.createLongformWorkflowAuthority({
      store: productionMainWorkflow.createRepositoryLongformWorkflowSnapshotStore(repository),
      now: () => 60
    })
    const initial = await firstAuthority.create({
      workflowId: 'r74-repository-authority',
      storyId: 'r74-story',
      projectId: 'r74-project',
      branchId: 'main',
      sessionId: 'r74-session',
      activeRunId: runId,
      now: 60
    })
    const advanced = await firstAuthority.mutate(mutation(initial, 'op-repository-outline', 'resolve_stage', { output: 'candidate' }, {
      targetStage: 'outline',
      targetStatus: 'candidate'
    }))
    await checkAsync('repository snapshot store persists an authoritative revision', async () => {
      assert.equal(advanced.authoritativeRevision, 1)
      const row = repository.getLongformWorkflowSnapshot(runId, initial.workflowId, 1)
      assert.ok(row)
      assert.equal(row.workflowRevision, 1)
      assert.equal(row.payloadHash, longformWorkflowHash(advanced))
    })
    repository.close()
    const reopenedRepository = createRepository(dbPath)
    reopenedRepository.open()
    try {
      const secondAuthority = productionMainWorkflow.createLongformWorkflowAuthority({
        store: productionMainWorkflow.createRepositoryLongformWorkflowSnapshotStore(reopenedRepository),
        now: () => 61
      })
      const restored = await secondAuthority.get(initial.workflowId)
      await checkAsync('repository authority restart recovers exact stage/status/revision', async () => {
        assert.ok(restored)
        assert.ok(sameJson(restored, advanced))
        const revision = await secondAuthority.getAtRevision(initial.workflowId, 0)
        assert.ok(revision)
        assert.equal(revision.authoritativeRevision, 0)
      })
    } finally {
      reopenedRepository.close()
    }
  } finally {
    try { repository.close() } catch { /* already closed after restart */ }
  }
}

async function hybridPreRunBindingChecks(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-r74-hybrid-'))
  const authorityRoot = path.join(root, 'pre-run-workflows')
  const dbPath = path.join(root, 'hybrid.sqlite')
  const runId = 'r74-hybrid-run'
  const workflowId = 'r74-hybrid-binding'
  const repository = createRepository(dbPath)
  repository.open()
  try {
    repository.createRun(makeRun(runId))
    const store = () => productionMainWorkflow.createHybridLongformWorkflowSnapshotStore({ repository, baseDir: authorityRoot })
    const preRunAuthority = productionMainWorkflow.createLongformWorkflowAuthority({ store: store(), now: () => 70 })
    const preRun = await preRunAuthority.create({
      workflowId,
      storyId: 'r74-story',
      projectId: 'r74-project',
      branchId: 'main',
      sessionId: 'r74-session',
      now: 70
    })
    await checkAsync('hybrid authority persists pre-run workflow without activeRunId', async () => {
      assert.equal(preRun.activeRunId, null)
      assert.equal(preRun.authoritativeRevision, 0)
      const fileBytes = JSON.parse(await fs.readFile(path.join(authorityRoot, `${workflowId}.json`), 'utf8')) as { snapshots?: LongformWorkflowSnapshot[] }
      assert.equal(fileBytes.snapshots?.length, 1)
      assert.ok(sameJson(fileBytes.snapshots?.[0], preRun))
      assert.equal(repository.listLongformWorkflowSnapshots?.(workflowId)?.length ?? 0, 0)
    })

    const restartedPreRunAuthority = productionMainWorkflow.createLongformWorkflowAuthority({ store: store(), now: () => 71 })
    const restoredPreRun = await restartedPreRunAuthority.get(workflowId)
    await checkAsync('hybrid pre-run restart recovers exact file snapshot', async () => {
      assert.ok(restoredPreRun)
      assert.ok(sameJson(restoredPreRun, preRun))
      assert.equal(restoredPreRun?.activeRunId, null)
    })

    const boundMutation = mutation(restoredPreRun!, 'op-hybrid-bind-run', 'resolve_stage', { bind: runId }, {
      activeRunId: runId,
      targetStage: 'outline',
      targetStatus: 'candidate'
    })
    const bound = await restartedPreRunAuthority.mutate(boundMutation)
    await checkAsync('hybrid binding migrates the next revision to repository authority', async () => {
      assert.equal(bound.activeRunId, runId)
      assert.equal(bound.authoritativeRevision, 1)
      const row = repository.getLongformWorkflowSnapshot(runId, workflowId, 1)
      assert.ok(row)
      assert.equal(row?.workflowRevision, 1)
      assert.equal(row?.payloadHash, longformWorkflowHash(bound))
      assert.equal(repository.listLongformWorkflowSnapshots?.(workflowId)?.length ?? 0, 1)
    })

    const afterBindingRestart = productionMainWorkflow.createLongformWorkflowAuthority({ store: store(), now: () => 72 })
    const restoredBound = await afterBindingRestart.get(workflowId)
    await checkAsync('hybrid restart merges bound repository history with pre-run file history', async () => {
      assert.ok(restoredBound)
      assert.ok(sameJson(restoredBound, bound))
      assert.equal(restoredBound?.activeRunId, runId)
      const revisionZero = await afterBindingRestart.getAtRevision(workflowId, 0)
      const revisionOne = await afterBindingRestart.getAtRevision(workflowId, 1)
      assert.ok(revisionZero)
      assert.ok(revisionOne)
      assert.ok(sameJson(revisionZero, preRun))
      assert.ok(sameJson(revisionOne, bound))
    })
  } finally {
    repository.close()
  }
}

async function concurrentMutationChecks(): Promise<void> {
  const memory = productionMainWorkflow.createLongformWorkflowAuthority({
    store: productionMainWorkflow.createMemoryLongformWorkflowSnapshotStore(),
    now: () => 20
  })
  const initial = await memory.create({ workflowId: 'r74-concurrent-memory', now: 20 })
  const a = mutation(initial, 'op-concurrent-a', 'resolve_stage', { winner: 'a' }, { targetStage: 'outline', targetStatus: 'candidate' })
  const b = mutation(initial, 'op-concurrent-b', 'resolve_stage', { winner: 'b' }, { targetStage: 'outline', targetStatus: 'candidate' })
  const outcomes = await Promise.allSettled([memory.mutateResult(a), memory.mutateResult(b)])
  const successes = outcomes.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof memory.mutateResult>>> => item.status === 'fulfilled')
  const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
  const final = await memory.get(initial.workflowId)
  await checkAsync('concurrent mutations have one winner and no lost update', async () => {
    assert.equal(successes.length, 1)
    assert.equal(failures.length, 1)
    assert.equal(messageOf(failures[0]!.reason), 'longform_revision_conflict')
    assert.ok(final)
    assert.equal(final.authoritativeRevision, 1)
    assert.equal(Object.keys(final.appliedOperations).length, 1)
  })

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-r74-concurrent-file-'))
  const first = await createFileAuthority(root, 30)
  const second = await createFileAuthority(root, 30)
  const fileInitial = await first.create({ workflowId: 'r74-concurrent-file', now: 30 })
  const left = mutation(fileInitial, 'op-file-left', 'resolve_stage', { winner: 'left' }, { targetStage: 'outline', targetStatus: 'candidate' })
  const right = mutation(fileInitial, 'op-file-right', 'resolve_stage', { winner: 'right' }, { targetStage: 'outline', targetStatus: 'candidate' })
  const fileOutcomes = await Promise.allSettled([first.mutateResult(left), second.mutateResult(right)])
  const fileSuccesses = fileOutcomes.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof first.mutateResult>>> => item.status === 'fulfilled')
  const fileFinal = await first.get(fileInitial.workflowId)
  await checkAsync('concurrent file-authority mutations do not overwrite a revision', async () => {
    assert.equal(fileSuccesses.length, 1, JSON.stringify(fileOutcomes.map((item) => item.status === 'fulfilled' ? { status: item.status, revision: item.value.snapshot.authoritativeRevision } : { status: item.status, error: messageOf(item.reason) })))
    assert.ok(fileFinal)
    assert.equal(fileFinal.authoritativeRevision, 1, JSON.stringify(fileOutcomes.map((item) => item.status)))
    assert.equal(Object.keys(fileFinal.appliedOperations).length, 1, JSON.stringify(fileFinal.appliedOperations))
  })
}

async function corruptSnapshotChecks(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-r74-corrupt-'))
  const authority = await createFileAuthority(root, 40)
  const initial = await authority.create({ workflowId: 'r74-corrupt-json', now: 40 })
  const target = path.join(root, `${initial.workflowId}.json`)
  await fs.writeFile(target, '{"schemaVersion":1,"workflowId":"r74-corrupt-json","snapshots":[', 'utf8')
  await checkAsync('corrupt snapshot JSON fails closed', async () => {
    await expectCode('longform_snapshot_corrupt', () => authority.get(initial.workflowId))
  })

  const authorityCorruptRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-r74-authority-corrupt-'))
  const authorityCorrupt = await createFileAuthority(authorityCorruptRoot, 41)
  const valid = await authorityCorrupt.create({ workflowId: 'r74-corrupt-authority', now: 41 })
  const authorityTarget = path.join(authorityCorruptRoot, `${valid.workflowId}.json`)
  const parsed = JSON.parse(await fs.readFile(authorityTarget, 'utf8')) as { snapshots: Array<Record<string, unknown>> }
  parsed.snapshots[0]!.allowedActions = ['stop']
  await fs.writeFile(authorityTarget, JSON.stringify(parsed), 'utf8')
  await checkAsync('tampered allowedActions snapshot fails closed', async () => {
    await expectCode('longform_snapshot_authority_corrupt', () => authorityCorrupt.get(valid.workflowId))
  })
}

async function sceneWorkingSetRecallProjectionCheck(): Promise<void> {
  const storyId = 'r74-recall-story'
  const projectId = 'r74-recall-project'
  const branchId = 'main'
  const runId = 'r74-recall-run'
  const sessionId = 'r74-recall-projection'
  const sceneId = 'scene-current'
  const sourceSceneId = 'scene-old'
  const validityEpoch = 2
  const storyRevision = 3
  const headRevision = 3
  const headHash = sha256Text('r74-recall-head')
  const contractId = 'r74-recall-contract'
  const contractHash = sha256Text(contractId)
  const commitManifestHash = sha256Text('r74-recall-manifest')
  const stateDeltaHash = sha256Text('r74-recall-delta')

  function makeCard(cardId: string, content: string): { card: SceneMemoryCard; segment: SceneMemorySourceSegment } {
    const segmentId = `${cardId}-segment`
    const contentHash = sha256Text(content)
    const segment: SceneMemorySourceSegment = {
      segmentId,
      content,
      contentHash,
      segmentRevision: 1,
      status: 'accepted',
      sceneId: sourceSceneId,
      commitId: `${cardId}-commit`,
      commitManifestHash,
      chunkIndex: 0
    }
    const span = {
      spanId: `${cardId}-span`,
      segmentId,
      segmentHash: contentHash,
      segmentRevision: 1,
      manifestHash: commitManifestHash,
      startUtf16: 0,
      endUtf16: content.length,
      text: content,
      spanHash: contentHash
    }
    const card = buildSceneMemoryCard({
      schemaVersion: 1,
      status: 'canonical',
      cardId,
      storyId,
      projectId,
      branchId,
      validityEpoch,
      storyRevision,
      runId,
      sceneId: sourceSceneId,
      sceneOrder: 1,
      contractId,
      contractHash,
      sceneContentHash: contentHash,
      commitManifestHash,
      stateDeltaHash,
      povCharacterId: null,
      participants: [],
      locations: [],
      objects: [],
      dramaticQuestion: null,
      valueShift: null,
      decisiveAction: null,
      turn: null,
      cost: null,
      factsEstablished: [],
      beliefChanges: [],
      relationshipChanges: [],
      threads: [],
      motifs: [],
      distinctivePhrases: [],
      sourceSegments: [segment],
      sourceSpans: [span],
      fieldEvidence: {},
      expectedScope: { storyId, projectId, branchId },
      expectedValidityEpoch: validityEpoch,
      expectedStoryRevision: storyRevision,
      expectedContract: { contractId, contractHash },
      expectedBindings: { sceneContentHash: contentHash, commitManifestHash, stateDeltaHash },
      ledgerClaims: [],
      createdAt: 80
    })
    assert.equal(card.cardHash, sceneMemoryCardHash(card))
    return { card, segment }
  }

  function corpusItem(fixture: { card: SceneMemoryCard; segment: SceneMemorySourceSegment }): SceneRecallCorpusItem {
    const sourceSnapshotHash = sceneRecallSourceSnapshotHash(fixture.card, [fixture.segment])
    const authority = {
      storyId,
      projectId,
      branchId,
      branchLineage: [branchId],
      validityEpoch,
      storyRevision,
      headRevision,
      headHash,
      sourceSnapshotHash,
      cardHash: fixture.card.cardHash,
      authorityHash: ''
    }
    authority.authorityHash = sceneRecallAuthorityHash(authority)
    return { card: fixture.card, sourceSegments: [fixture.segment], sourceValidated: true, authority }
  }

  const included = corpusItem(makeCard('included', 'included-anchor production source'))
  const budgetOmitted = corpusItem(makeCard('omitted-budget', 'other-anchor production source'))
  const corpus: SceneRecallCorpusItem[] = [included, budgetOmitted]
  const sourceCardSetHash = sceneRecallSourceCardSetHash(corpus)
  const scope = {
    storyId,
    projectId,
    branchId,
    branchLineage: [branchId],
    validityEpoch,
    storyRevision,
    sceneId,
    headRevision,
    headHash,
    expectedSourceCardSetHash: sourceCardSetHash
  }
  const query: SceneRecallQuery = {
    scope,
    queryText: 'included-anchor',
    tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION,
    bm25Version: SCENE_RECALL_BM25_VERSION,
    topK: 1
  }
  const recall = buildDeterministicRecallIndex({ corpus, query })
  const corpusSnapshot: SceneRecallCorpusSnapshot = {
    schemaVersion: 1,
    runId,
    sceneId,
    scope,
    sourceSnapshotHash: sceneRecallSourceSnapshotSetHash(corpus),
    sourceCardSetHash,
    corpus
  }
  const outline: GrillMeOutline = {
    title: 'R74 recall projection',
    premise: 'production recall corpus',
    targetChars: 4000,
    sections: [{ id: 'section-r74-recall', title: 'Recall', purpose: 'verify projection', targetChars: 4000, beats: ['audit recall'], sourceSlotIds: [] }]
  }
  const contract = buildSceneContractPlan({ outline }).contracts[0]!
  const compiled = compileSceneWorkingSet({ snapshot: corpusSnapshot, recall, recallQuery: query, contract, hardConstraints: '只使用 production recall corpus。', budgetTokens: 4096 })
  const audit = projectLongformWorkflowRecallAudit({ recall, corpus })

  await checkAsync('production recall/corpus projection reaches authority snapshot and draft stage', async () => {
    assert.deepEqual(recall.candidates.map((candidate) => candidate.cardId), ['included'])
    assert.deepEqual(recall.omitted, [{ cardId: 'omitted-budget', reason: 'budget_omitted' }])
    assert.deepEqual(audit.included, ['included'])
    assert.deepEqual(audit.omitted.map((item) => ({ cardId: item.cardId, reason: item.reason })), [{ cardId: 'omitted-budget', reason: 'budget_omitted' }])
    assert.equal(audit.audit.length, 2)
    assert.ok(audit.audit.every((item) => item.source !== null && item.hash !== null))
    assert.equal(audit.audit.find((item) => item.cardId === 'included')?.hash, included.card.cardHash)
    assert.equal(audit.audit.find((item) => item.cardId === 'omitted-budget')?.hash, budgetOmitted.card.cardHash)

    const authority = productionMainWorkflow.createLongformWorkflowAuthority({
      store: productionMainWorkflow.createMemoryLongformWorkflowSnapshotStore(),
      now: () => 81
    })
    const projected = await productionMainWorkflow.projectLongformWorkflowSceneWorkingSet(authority, {
      runId,
      sessionId,
      storyId,
      projectId,
      branchId,
      sceneId,
      validityEpoch,
      storyRevision,
      workingSetHash: compiled.workingSet.workingSetHash,
      manifestHash: compiled.manifest.manifestHash,
      sourceSnapshotHash: corpusSnapshot.sourceSnapshotHash,
      sourceCardSetHash: corpusSnapshot.sourceCardSetHash,
      queryHash: recall.queryHash,
      indexHash: recall.indexHash,
      audit
    })
    const restored = await authority.get(sessionId)
    assert.ok(restored)
    assert.ok(sameJson(restored, projected))
    assert.equal(projected.activeRunId, runId)
    assert.equal(projected.stage, 'draft')
    assert.equal(projected.status, 'running')
    assert.equal(projected.stageStatus, 'running')
    assert.equal(projected.workingSetHash, compiled.workingSet.workingSetHash)
    assert.equal(projected.manifestHash, compiled.manifest.manifestHash)
    assert.equal(projected.validityEpoch, validityEpoch)
    assert.ok(sameJson(projected.recallAudit, audit))
    assert.deepEqual(projected.allowedActions, ['start_draft', 'stop'])
  })
}

async function main(): Promise<void> {
  console.log('R74 baseline red recorded: old script expected AgentRunEngine authority; production export was absent (workflow_authority_missing).')
  check('production shared workflow snapshot API is present', () => {
    assert.equal(typeof productionSharedWorkflow.createLongformWorkflowSnapshot, 'function')
    assert.equal(typeof productionSharedWorkflow.buildLongformWorkflowMutation, 'function')
    assert.equal(typeof productionSharedWorkflow.longformWorkflowHash, 'function')
    assert.equal(typeof productionSharedWorkflow.projectLongformWorkflowRecallAudit, 'function')
  })
  check('production main workflow authority API is present', () => {
    assert.equal(typeof productionMainWorkflow.createLongformWorkflowAuthority, 'function')
    assert.equal(typeof productionMainWorkflow.createFileLongformWorkflowSnapshotStore, 'function')
    assert.equal(typeof productionMainWorkflow.createMemoryLongformWorkflowSnapshotStore, 'function')
    assert.equal(typeof productionMainWorkflow.createRepositoryLongformWorkflowSnapshotStore, 'function')
    assert.equal(typeof productionMainWorkflow.projectLongformWorkflowSceneWorkingSet, 'function')
  })
  check('production stage order is consumed without a test-local reducer', () => {
    assert.deepEqual(productionSharedWorkflow.LONGFORM_WORKFLOW_STAGES, [
      'requirements', 'outline', 'scene_direction', 'recall', 'draft', 'critique', 'revision', 'semantic_review', 'commit', 'reorientation', 'export'
    ])
  })
  await mutationContractChecks()
  await phaseRestartChecks()
  await repositoryAuthorityChecks()
  await hybridPreRunBindingChecks()
  await repositoryStopInvariantChecks()
  await concurrentMutationChecks()
  await corruptSnapshotChecks()
  await sceneWorkingSetRecallProjectionCheck()
  console.log(`\nR74 longform workflow recovery: ${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  failed += 1
  console.error(`R74 execution error: ${messageOf(error)}`)
  if (error instanceof Error && error.stack) console.error(error.stack)
  console.log(`\nR74 longform workflow recovery: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = 1
})
