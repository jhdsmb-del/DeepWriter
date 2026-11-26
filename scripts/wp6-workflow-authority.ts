/** WP6 focused red tests for the durable longform workflow authority. */
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  LONGFORM_WORKFLOW_STAGES,
  allowedLongformWorkflowActions,
  applyLongformWorkflowMutation,
  buildLongformWorkflowMutation,
  createLongformWorkflowSnapshot,
  longformWorkflowHash,
  longformMutationPayloadHash,
  type LongformSemanticReviewFence,
  type LongformWorkflowDecisionFence,
  type LongformWorkflowMutation,
  type LongformWorkflowSnapshot
} from '../src/shared/longformWorkflow'
import { createLongformWorkflowAuthority, createMemoryLongformWorkflowSnapshotStore } from '../src/main/longformWorkflow'

let passed = 0
let failed = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

function fixture(): LongformWorkflowSnapshot {
  return createLongformWorkflowSnapshot({
    workflowId: 'wp6-workflow',
    storyId: 'wp6-story',
    projectId: 'wp6-project',
    branchId: 'main',
    sessionId: 'wp6-session',
    activeRunId: null,
    now: 1
  })
}

function mutation(state: LongformWorkflowSnapshot, operationId: string, action: LongformWorkflowMutation['action'], payload: unknown, extra: Partial<LongformWorkflowMutation> = {}): LongformWorkflowMutation {
  return buildLongformWorkflowMutation({
    workflowId: state.workflowId,
    operationId,
    action,
    expectedRevision: state.authoritativeRevision,
    payload,
    ...extra
  })
}

function expectCode(code: string, fn: () => void): void {
  assert.throws(fn, (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === code)
}

function pendingSemanticFence(provisionalOperationId: string): LongformSemanticReviewFence {
  return {
    runId: 'wp6-run',
    sceneId: 'wp6-scene',
    candidateSegmentId: 'wp6-segment',
    candidateHash: longformWorkflowHash('wp6-candidate'),
    contractHash: longformWorkflowHash('wp6-contract'),
    packetRevision: 1,
    packetHash: longformWorkflowHash('wp6-review-packet'),
    decisionId: provisionalOperationId,
    decisionRevision: null,
    decisionCanonicalPayloadHash: null,
    decision: null,
    status: 'pending'
  }
}

/** Walk the real shared reducer through every public stage gate before the
 * main-only semantic-review packet is projected.  No test-local reducer or
 * allowed-action list is used here. */
function semanticReviewPendingState(): { state: LongformWorkflowSnapshot; provisionalOperationId: string } {
  let state = fixture()
  const step = (operationId: string, action: LongformWorkflowMutation['action'], payload: unknown, extra: Partial<LongformWorkflowMutation>): void => {
    state = applyLongformWorkflowMutation(state, mutation(state, operationId, action, payload, extra), 2 + state.authoritativeRevision)
  }
  step('wp6-outline', 'resolve_stage', { step: 'outline' }, { targetStage: 'outline', targetStatus: 'candidate' })
  step('wp6-scene-direction', 'accept_candidate', { step: 'scene_direction' }, { targetStage: 'scene_direction', targetStatus: 'ready' })
  step('wp6-recall-ready', 'resolve_stage', { step: 'recall-ready' }, { targetStage: 'recall', targetStatus: 'ready' })
  step('wp6-recall-candidate', 'start_recall', { step: 'recall-candidate' }, { targetStage: 'recall', targetStatus: 'candidate' })
  step('wp6-draft-ready', 'accept_candidate', { step: 'draft-ready' }, { targetStage: 'draft', targetStatus: 'ready' })
  step('wp6-draft-candidate', 'start_draft', { step: 'draft-candidate' }, { targetStage: 'draft', targetStatus: 'candidate' })
  step('wp6-critique-ready', 'accept_candidate', { step: 'critique-ready' }, { targetStage: 'critique', targetStatus: 'ready' })
  step('wp6-critique-candidate', 'start_critique', { step: 'critique-candidate' }, { targetStage: 'critique', targetStatus: 'candidate' })
  step('wp6-revision-ready', 'accept_candidate', { step: 'revision-ready' }, { targetStage: 'revision', targetStatus: 'ready' })
  step('wp6-revision-candidate', 'start_revision', { step: 'revision-candidate' }, { targetStage: 'revision', targetStatus: 'candidate' })
  step('wp6-review-ready', 'accept_candidate', { step: 'review-ready' }, { targetStage: 'semantic_review', targetStatus: 'review' })
  const provisionalOperationId = 'wp6-review-op'
  const fence = pendingSemanticFence(provisionalOperationId)
  state = applyLongformWorkflowMutation(state, mutation(state, provisionalOperationId, 'review_pending', { kind: 'semantic-review-packet', packetHash: fence.packetHash }, {
    mainOnly: true,
    targetStage: 'semantic_review',
    targetStatus: 'review',
    semanticReviewFence: fence
  }), 2 + state.authoritativeRevision)
  return { state, provisionalOperationId }
}

function acceptedDecisionFor(state: LongformWorkflowSnapshot): { semanticFence: LongformSemanticReviewFence; reviewFence: LongformWorkflowDecisionFence } {
  const pending = state.semanticReviewFence
  assert.ok(pending?.status === 'pending')
  const decisionId = 'wp6-decision-1'
  const decisionCanonicalPayloadHash = longformWorkflowHash({ decisionId, decision: 'accept_delta', packetHash: pending.packetHash })
  const semanticFence: LongformSemanticReviewFence = {
    ...pending,
    decisionId,
    decisionRevision: state.authoritativeRevision,
    decisionCanonicalPayloadHash,
    decision: 'accept_delta',
    status: 'accepted'
  }
  const reviewFence: LongformWorkflowDecisionFence = {
    decisionId,
    packetHash: pending.packetHash,
    expectedRevision: state.authoritativeRevision,
    canonicalPayloadHash: decisionCanonicalPayloadHash
  }
  return { semanticFence, reviewFence }
}

function pureChecks(): void {
  check('canonical stage order is fixed and includes semantic review/export', () => {
    assert.deepEqual(LONGFORM_WORKFLOW_STAGES, ['requirements', 'outline', 'scene_direction', 'recall', 'draft', 'critique', 'revision', 'semantic_review', 'commit', 'reorientation', 'export'])
  })

  check('mutation hash covers operation/revision/delta/note and is deterministic', () => {
    const state = fixture()
    const first = mutation(state, 'op-1', 'resolve_stage', { answer: 'confirmed' }, { targetStage: 'outline', targetStatus: 'candidate', note: 'user note' })
    const reordered = { ...first, payload: { answer: 'confirmed' }, note: 'user note' }
    assert.equal(first.canonicalPayloadHash, longformMutationPayloadHash(reordered))
    assert.notEqual(first.canonicalPayloadHash, longformMutationPayloadHash({ ...first, note: 'changed' }))
    assert.notEqual(first.canonicalPayloadHash, longformMutationPayloadHash({ ...first, expectedRevision: first.expectedRevision + 1 }))
  })

  check('same operation and same complete payload are idempotent', () => {
    const state = fixture()
    const first = mutation(state, 'op-1', 'resolve_stage', { answer: 'confirmed' }, { targetStage: 'outline', targetStatus: 'candidate' })
    const next = applyLongformWorkflowMutation(state, first, 2)
    const replay = applyLongformWorkflowMutation(next, { ...first, expectedRevision: state.authoritativeRevision }, 3)
    assert.deepEqual(replay, next)
  })

  check('same operation and different payload conflict', () => {
    const state = fixture()
    const first = mutation(state, 'op-1', 'resolve_stage', { answer: 'confirmed' }, { targetStage: 'outline', targetStatus: 'candidate' })
    const next = applyLongformWorkflowMutation(state, first, 2)
    const changed = { ...first, payload: { answer: 'tampered' }, canonicalPayloadHash: longformMutationPayloadHash({ ...first, payload: { answer: 'tampered' } }) }
    expectCode('longform_operation_conflict', () => applyLongformWorkflowMutation(next, changed, 3))
  })

  check('stale expected revision conflicts before mutation', () => {
    const state = fixture()
    const first = mutation(state, 'op-1', 'resolve_stage', { answer: 'confirmed' }, { targetStage: 'outline', targetStatus: 'candidate' })
    const next = applyLongformWorkflowMutation(state, first, 2)
    const stale = mutation(state, 'op-2', 'stop', { reason: 'user_stop' }, { targetStage: 'requirements', targetStatus: 'draft' })
    expectCode('longform_revision_conflict', () => applyLongformWorkflowMutation(next, stale, 3))
  })

  check('stage transitions are explicit; a provider failure cannot skip to export', () => {
    const state = fixture()
    const invalid = mutation(state, 'op-skip', 'resolve_stage', { result: 'done' }, { targetStage: 'export', targetStatus: 'completed' })
    expectCode('longform_stage_transition_invalid', () => applyLongformWorkflowMutation(state, invalid, 2))
  })

  check('stop keeps stage and records only uncommitted draft', () => {
    const state = { ...fixture(), stage: 'draft' as const, stageStatus: 'running' as const, status: 'running' as const, acceptedSegmentId: null, commitId: null }
    const stopped = applyLongformWorkflowMutation(state, mutation(state, 'op-stop', 'stop', { reason: 'user_stop', draftText: '未提交正文' }, { targetStage: 'draft', targetStatus: 'draft', draft: { text: '未提交正文', contentHash: longformWorkflowHash('未提交正文') } }), 2)
    assert.equal(stopped.stage, 'draft')
    assert.equal(stopped.status, 'draft')
    assert.equal(stopped.stageStatus, 'waiting_user')
    assert.equal(stopped.commitId, null)
    assert.equal(stopped.acceptedSegmentId, null)
    assert.equal(stopped.draft?.text, '未提交正文')
  })
}

function semanticFenceChecks(): void {
  const { state: pending, provisionalOperationId } = semanticReviewPendingState()
  const decision = acceptedDecisionFor(pending)
  const decisionMutation = mutation(pending, 'wp6-decision-apply', 'review_decision_applied', { decision: 'accept_delta' }, {
    mainOnly: true,
    targetStage: 'commit',
    targetStatus: 'ready',
    semanticReviewFence: decision.semanticFence,
    reviewDecisionFence: decision.reviewFence
  })
  let decided: LongformWorkflowSnapshot | null = null
  let committed: LongformWorkflowSnapshot | null = null

  check('server-derived semantic-review actions are public-safe and do not expose raw commit', () => {
    assert.deepEqual(pending.allowedActions, ['approve_review', 'accept_delta', 'accept_unknown', 'accept_prose_no_state', 'reject_rewrite', 'stop'])
    assert.deepEqual(allowedLongformWorkflowActions(pending), pending.allowedActions)
    assert.ok(!pending.allowedActions.includes('commit'))
  })

  check('pending semantic fence retains provisional narrative-review operation identity', () => {
    const fence = pending.semanticReviewFence
    assert.equal(fence?.status, 'pending')
    // This is the exact identity gate used by runs:narrativeReviewDecide.
    // decisionRevision/hash must remain null while the packet is pending.
    assert.equal(fence?.decisionId, provisionalOperationId)
    assert.equal(fence?.decisionRevision, null)
    assert.equal(fence?.decisionCanonicalPayloadHash, null)
  })

  check('draft content hash mismatch is rejected without a revision', () => {
    const draftState: LongformWorkflowSnapshot = {
      ...fixture(),
      stage: 'draft',
      stageStatus: 'running',
      status: 'running',
      allowedActions: ['start_draft', 'stop']
    }
    const before = draftState.authoritativeRevision
    const invalidDraft = mutation(draftState, 'wp6-draft-hash-mismatch', 'stop', { reason: 'user_stop' }, {
      targetStage: 'draft',
      targetStatus: 'draft',
      draft: { text: 'draft', contentHash: longformWorkflowHash('different-text') }
    })
    expectCode('longform_draft_invalid', () => applyLongformWorkflowMutation(draftState, invalidDraft, 3))
    assert.equal(draftState.authoritativeRevision, before)
  })

  check('pending fence plus correct engine decision opens the commit stage', () => {
    decided = applyLongformWorkflowMutation(pending, decisionMutation, 30)
    assert.equal(decided.stage, 'commit')
    assert.equal(decided.status, 'ready')
    assert.equal(decided.semanticReviewFence?.status, 'accepted')
    assert.deepEqual(decided.reviewDecisionFence, decision.reviewFence)
  })

  check('commit without a decision fence is rejected and does not advance', () => {
    assert.ok(decided)
    const noFence = { ...decided, reviewDecisionFence: null }
    const before = noFence.authoritativeRevision
    const commitWithoutFence = mutation(noFence, 'wp6-commit-without-fence', 'commit', { commitId: 'wp6-commit-no-fence' }, {
      mainOnly: true,
      targetStage: 'export',
      targetStatus: 'ready'
    })
    expectCode('longform_review_fence_required', () => applyLongformWorkflowMutation(noFence, commitWithoutFence, 31))
    assert.equal(noFence.authoritativeRevision, before)
  })

  check('wrong revision, decision id, and decision hash are rejected without revision drift', () => {
    assert.ok(decided)
    const before = decided.authoritativeRevision
    const staleCommit = mutation(decided, 'wp6-commit-stale-revision', 'commit', { commitId: 'wp6-stale' }, {
      mainOnly: true,
      expectedRevision: decided.authoritativeRevision - 1,
      targetStage: 'export',
      targetStatus: 'ready',
      reviewDecisionFence: decision.reviewFence
    })
    expectCode('longform_revision_conflict', () => applyLongformWorkflowMutation(decided!, staleCommit, 32))

    const wrongId = { ...decision.reviewFence, decisionId: 'wp6-wrong-decision' }
    const wrongIdCommit = mutation(decided, 'wp6-commit-wrong-id', 'commit', { commitId: 'wp6-wrong-id' }, {
      mainOnly: true,
      targetStage: 'export',
      targetStatus: 'ready',
      reviewDecisionFence: wrongId
    })
    expectCode('longform_review_fence_conflict', () => applyLongformWorkflowMutation(decided!, wrongIdCommit, 33))

    const wrongHash = { ...decision.reviewFence, canonicalPayloadHash: '0'.repeat(64) }
    const wrongHashCommit = mutation(decided, 'wp6-commit-wrong-hash', 'commit', { commitId: 'wp6-wrong-hash' }, {
      mainOnly: true,
      targetStage: 'export',
      targetStatus: 'ready',
      reviewDecisionFence: wrongHash
    })
    expectCode('longform_review_fence_conflict', () => applyLongformWorkflowMutation(decided!, wrongHashCommit, 34))
    assert.equal(decided.authoritativeRevision, before)
  })

  check('main-only commit with the correct fence advances to export', () => {
    assert.ok(decided)
    committed = applyLongformWorkflowMutation(decided, mutation(decided, 'wp6-commit-correct-fence', 'commit', { commitId: 'wp6-commit-1', acceptedSegmentId: 'wp6-segment' }, {
      mainOnly: true,
      targetStage: 'export',
      targetStatus: 'ready',
      reviewDecisionFence: decision.reviewFence
    }), 35)
    assert.equal(committed.stage, 'export')
    assert.equal(committed.status, 'ready')
    assert.equal(committed.commitId, 'wp6-commit-1')
  })

  check('same decision operation is idempotent after a later successful commit', () => {
    assert.ok(committed)
    const replay = applyLongformWorkflowMutation(committed, decisionMutation, 36)
    assert.deepEqual(replay, committed)
    assert.equal(replay.authoritativeRevision, committed.authoritativeRevision)
  })

  check('same decision operation with a different payload conflicts after commit', () => {
    assert.ok(committed)
    const changed = { ...decisionMutation, payload: { decision: 'tampered' }, canonicalPayloadHash: longformMutationPayloadHash({ ...decisionMutation, payload: { decision: 'tampered' } }) }
    expectCode('longform_operation_conflict', () => applyLongformWorkflowMutation(committed!, changed, 37))
  })
}

async function durableChecks(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-wp6-authority-'))
  const first = createLongformWorkflowAuthority({ baseDir: root, now: () => 10 })
  const initial = await first.create({ workflowId: 'wp6-durable', storyId: 'story', projectId: 'project', branchId: 'main', sessionId: 'session' })
  let event: LongformWorkflowSnapshot | null = null
  const unsubscribe = first.subscribe(initial.workflowId, (snapshot) => { event = snapshot })
  const advanced = await first.mutate(mutation(initial, 'op-outline', 'resolve_stage', { answer: 'ok' }, { targetStage: 'outline', targetStatus: 'candidate' }))
  check('authority persists mutation and emits one authoritative event', () => {
    assert.equal(advanced.authoritativeRevision, 1)
    assert.equal(event?.authoritativeRevision, 1)
    assert.equal(event?.workflowId, initial.workflowId)
  })
  unsubscribe()
  const stopped = await first.stop({ workflowId: initial.workflowId, expectedRevision: advanced.authoritativeRevision, operationId: 'op-stop', payload: { reason: 'user_stop', draftText: 'draft' }, draft: { text: 'draft', contentHash: longformWorkflowHash('draft') } })
  check('authority stop persists draft without ledger callback', () => {
    assert.equal(stopped.status, 'draft')
    assert.equal(stopped.stage, 'outline')
    assert.equal(stopped.draft?.text, 'draft')
  })
  const reopened = createLongformWorkflowAuthority({ baseDir: root, now: () => 20 })
  const restored = await reopened.get(initial.workflowId)
  check('new authority instance recovers the exact stage/status/revision', () => {
    assert.equal(restored?.workflowId, initial.workflowId)
    assert.equal(restored?.authoritativeRevision, stopped.authoritativeRevision)
    assert.equal(restored?.stage, stopped.stage)
    assert.equal(restored?.status, 'draft')
    assert.equal(restored?.draft?.text, 'draft')
  })
}

async function main(): Promise<void> {
  pureChecks()
  semanticFenceChecks()
  await durableChecks()
  console.log(`\nWP6 workflow authority: ${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  failed += 1
  console.error(error)
  process.exitCode = 1
})
