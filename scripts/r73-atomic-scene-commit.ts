import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRepository, type ManuscriptSegmentRow, type RunRow, type SceneMemoryProjectionInput } from '../src/main/db/repository'
import { buildSceneContractPlan, buildSceneCompletionDecision } from '../src/main/narrative/sceneContract'
import { buildEmptyNarrativeStateDelta, stableNarrativeJson } from '../src/main/narrative/stateDelta'
import { buildSceneMemoryCard, makeSceneMemorySourceSpan, sceneMemoryCardHash, sceneContentHashForSegments, sha256Text, sourceSpanEvidence, stableSceneMemoryJson } from '../src/main/narrative/sceneMemoryCard'
import { classifyAssistantOutput, manuscriptAcceptanceEvidenceIdentity, manuscriptSegmentHash } from '../src/main/manuscript'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import type { ManuscriptSegment, SceneCommitManifest, SceneContract, SceneMemoryCardValidationContext, SceneMemorySourceSegment, SceneCommitInput, SceneMemoryCard } from '../src/shared/types'
import { codePointLength } from '../src/shared/textMetrics'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function row(segment: ManuscriptSegment): ManuscriptSegmentRow {
  return {
    segment_id: segment.segmentId,
    run_id: segment.runId,
    session_id: segment.sessionId,
    source_turn_id: segment.sourceTurnId ?? null,
    section_id: segment.sectionId ?? null,
    scene_id: segment.sceneId ?? null,
    chunk_index: segment.chunkIndex,
    revision: segment.revision,
    status: segment.status,
    kind: segment.kind,
    content: segment.content,
    content_hash: segment.contentHash,
    char_count: segment.charCount,
    supersedes_segment_id: segment.supersedesSegmentId ?? null,
    created_at: segment.createdAt,
    updated_at: segment.updatedAt,
    accepted_at: segment.acceptedAt ?? null
  }
}

function segment(input: { runId: string; sessionId: string; id: string; sceneId: string; status: ManuscriptSegment['status']; content: string }): ManuscriptSegment {
  const classified = classifyAssistantOutput(input.content)
  const at = 100
  return {
    schemaVersion: 1,
    segmentId: input.id,
    runId: input.runId,
    sessionId: input.sessionId,
    sourceTurnId: undefined,
    sectionId: 'section-1',
    sceneId: input.sceneId,
    chunkIndex: 1,
    revision: 1,
    status: input.status,
    kind: classified.kind === 'prose' ? 'prose' : 'meta',
    content: input.content,
    contentHash: manuscriptSegmentHash(input.content),
    charCount: codePointLength(input.content),
    createdAt: at,
    updatedAt: at,
    ...(input.status === 'accepted' ? { acceptedAt: at } : {})
  }
}

function runRow(runId: string, sessionId: string): RunRow {
  return { run_id: runId, session_id: sessionId, status: 'running', phase: 'writing', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null, client_request_id: null }
}

function makePlan() {
  const outline: GrillMeOutline = { title: 'WP5', premise: '林舟抵达灯塔。', targetChars: 100, sections: [{ id: 'section-1', title: '雨夜', purpose: '林舟抵达灯塔。', targetChars: 100, beats: ['林舟抵达灯塔'], sourceSlotIds: [] }] }
  return buildSceneContractPlan({ outline, outlineHash: grillMeOutlineHash(outline), outlineRevision: 1, answers: [], characterNames: ['林舟'], strongConstraints: { forbiddenTerms: [], mustKeep: [] } })
}

function manifest(contract: SceneContract, runId: string, candidate: ManuscriptSegment, decision: ReturnType<typeof buildSceneCompletionDecision>, deltaHash: string): SceneCommitManifest {
  return {
    schemaVersion: 1,
    runId,
    sceneId: contract.sceneId,
    contractId: contract.contractId,
    contractHash: contract.frozenHash,
    acceptedSegments: [{ segmentId: candidate.segmentId, contentHash: candidate.contentHash, charCount: candidate.charCount, chunkIndex: candidate.chunkIndex, revision: candidate.revision }],
    sceneContentHash: candidate.contentHash,
    sceneCharCount: candidate.charCount,
    completionDecisionHash: manuscriptSegmentHash(stableNarrativeJson(decision)),
    stateDeltaHash: deltaHash
  }
}

function buildCard(input: { runId: string; storyId: string; projectId: string; branchId: string; contract: SceneContract; candidate: ManuscriptSegment; commitManifestHash: string; stateDeltaHash: string; storyRevision: number }): { card: ReturnType<typeof buildSceneMemoryCard>; context: SceneMemoryCardValidationContext } {
  const source: SceneMemorySourceSegment = { segmentId: input.candidate.segmentId, content: input.candidate.content, contentHash: input.candidate.contentHash, segmentRevision: input.candidate.revision, status: 'accepted', sceneId: input.contract.sceneId, commitId: `${input.runId}:${input.contract.sceneId}`, commitManifestHash: input.commitManifestHash, chunkIndex: input.candidate.chunkIndex }
  const span = makeSceneMemorySourceSpan({ spanId: 'wp5-span-1', segmentId: source.segmentId, segmentHash: source.contentHash, segmentRevision: source.segmentRevision, manifestHash: source.commitManifestHash, content: source.content, startUtf16: 0, endUtf16: source.content.length })
  const context: SceneMemoryCardValidationContext = { sourceSegments: [source], expectedScope: { storyId: input.storyId, projectId: input.projectId, branchId: input.branchId }, expectedValidityEpoch: 1, expectedStoryRevision: input.storyRevision, expectedContract: { contractId: input.contract.contractId, contractHash: input.contract.frozenHash }, expectedBindings: { sceneContentHash: source.contentHash, commitManifestHash: input.commitManifestHash, stateDeltaHash: input.stateDeltaHash }, ledgerClaims: [] }
  const sourceEvidence = sourceSpanEvidence(span)
  const card = buildSceneMemoryCard({ schemaVersion: 1, status: 'canonical', cardId: 'wp5-card-1', storyId: input.storyId, projectId: input.projectId, branchId: input.branchId, validityEpoch: 1, storyRevision: input.storyRevision, runId: input.runId, sceneId: input.contract.sceneId, sceneOrder: input.contract.order, contractId: input.contract.contractId, contractHash: input.contract.frozenHash, sceneContentHash: source.contentHash, commitManifestHash: input.commitManifestHash, stateDeltaHash: input.stateDeltaHash, povCharacterId: null, participants: [], locations: [], objects: [], dramaticQuestion: null, valueShift: null, decisiveAction: '林舟抵达灯塔', turn: null, cost: null, factsEstablished: [], beliefChanges: [], relationshipChanges: [], threads: [], motifs: [], distinctivePhrases: [], sourceSegments: [source], sourceSpans: [span], fieldEvidence: { decisiveAction: [sourceEvidence] }, expectedScope: context.expectedScope, expectedValidityEpoch: 1, expectedStoryRevision: input.storyRevision, expectedContract: context.expectedContract, expectedBindings: context.expectedBindings, ledgerClaims: [] })
  return { card, context }
}

type CommitEnvelope = SceneCommitInput & { projection?: SceneMemoryProjectionInput }

type HookMap = Record<string, (() => void) | undefined>

interface Fixture {
  repo: ReturnType<typeof createRepository>
  dbPath: string
  runId: string
  sessionId: string
  storyId: string
  projectId: string
  branchId: string
  contract: SceneContract
  candidate: ManuscriptSegment
  decision: ReturnType<typeof buildSceneCompletionDecision>
  delta: ReturnType<typeof buildEmptyNarrativeStateDelta>
  projection: SceneMemoryProjectionInput
  commit: CommitEnvelope
}

interface Counts {
  sceneState: number
  committedState: number
  acceptedSegments: number
  commits: number
  manifests: number
  ledger: number
  ledgerRevisions: number
  cards: number
  canonicalCards: number
  outbox: number
  publishedOutbox: number
  indexMeta: number
  readyIndex: number
  headRevision: number
  cursorRevision: number
}

// These are the production test-hook names.  Keep this list exact: aliases
// would let the harness report coverage while the repository ignored the
// injected failure point.
const CARD_HOOKS = {
  before: 'beforeSceneMemoryCardInsert',
  after: 'afterSceneMemoryCardInsert'
} as const

const INDEX_HOOKS = {
  before: 'beforeSceneRecallIndexMetaWrite',
  after: 'afterSceneRecallIndexMetaWrite'
} as const

function scopeConfig(storyId: string, projectId: string, branchId: string): Record<string, unknown> {
  return { schemaVersion: 1, storyId, projectId, branchId }
}

function queryNumber(db: DatabaseSync, sql: string, ...args: Array<string | number>): number {
  const value = db.prepare(sql).get(...args) as { value?: number } | undefined
  return Number(value?.value ?? 0)
}

function readCounts(fixture: Pick<Fixture, 'dbPath' | 'runId' | 'storyId' | 'projectId' | 'branchId' | 'contract'>): Counts {
  const db = new DatabaseSync(fixture.dbPath)
  try {
    const scopeArgs = [fixture.storyId, fixture.projectId, fixture.branchId] as Array<string | number>
    return {
      sceneState: queryNumber(db, 'SELECT COUNT(*) AS value FROM scene_states WHERE run_id=? AND scene_id=?', fixture.runId, fixture.contract.sceneId),
      committedState: queryNumber(db, "SELECT COUNT(*) AS value FROM scene_states WHERE run_id=? AND scene_id=? AND lifecycle='committed'", fixture.runId, fixture.contract.sceneId),
      acceptedSegments: queryNumber(db, "SELECT COUNT(*) AS value FROM manuscript_segments WHERE run_id=? AND scene_id=? AND status='accepted'", fixture.runId, fixture.contract.sceneId),
      commits: queryNumber(db, 'SELECT COUNT(*) AS value FROM narrative_commits WHERE run_id=? AND scene_id=?', fixture.runId, fixture.contract.sceneId),
      manifests: queryNumber(db, 'SELECT COUNT(*) AS value FROM scene_commit_manifests WHERE run_id=? AND scene_id=?', fixture.runId, fixture.contract.sceneId),
      ledger: queryNumber(db, 'SELECT COUNT(*) AS value FROM narrative_ledger WHERE run_id=? AND scene_id=?', fixture.runId, fixture.contract.sceneId),
      ledgerRevisions: queryNumber(db, 'SELECT COUNT(*) AS value FROM story_ledger_revisions WHERE run_id=? AND scene_id=?', fixture.runId, fixture.contract.sceneId),
      cards: queryNumber(db, 'SELECT COUNT(*) AS value FROM scene_memory_cards WHERE run_id=? AND scene_id=?', fixture.runId, fixture.contract.sceneId),
      canonicalCards: queryNumber(db, "SELECT COUNT(*) AS value FROM scene_memory_cards WHERE run_id=? AND scene_id=? AND status='canonical' AND visibility='active'", fixture.runId, fixture.contract.sceneId),
      outbox: queryNumber(db, 'SELECT COUNT(*) AS value FROM scene_memory_card_outbox WHERE story_id=? AND project_id=? AND branch_id=? AND scene_id=?', ...scopeArgs, fixture.contract.sceneId),
      publishedOutbox: queryNumber(db, "SELECT COUNT(*) AS value FROM scene_memory_card_outbox WHERE story_id=? AND project_id=? AND branch_id=? AND scene_id=? AND status='published'", ...scopeArgs, fixture.contract.sceneId),
      indexMeta: queryNumber(db, 'SELECT COUNT(*) AS value FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND story_revision=1', ...scopeArgs),
      readyIndex: queryNumber(db, "SELECT COUNT(*) AS value FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND story_revision=1 AND status='ready'", ...scopeArgs),
      headRevision: queryNumber(db, 'SELECT COALESCE(MAX(high_watermark),0) AS value FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?', ...scopeArgs),
      cursorRevision: queryNumber(db, 'SELECT COALESCE(MAX(current_revision),0) AS value FROM story_ledger_runs WHERE run_id=?', fixture.runId)
    }
  } finally {
    db.close()
  }
}

function sameCounts(left: Counts, right: Counts): boolean {
  return (Object.keys(left) as Array<keyof Counts>).every((key) => left[key] === right[key])
}

interface ProjectionFingerprint {
  cardHash: string | null
  cardJson: string | null
  outboxHash: string | null
  outboxPayload: string | null
  indexHash: string | null
  indexStatus: string | null
}

function readProjectionFingerprint(fixture: Pick<Fixture, 'dbPath' | 'runId' | 'storyId' | 'projectId' | 'branchId' | 'contract'>): ProjectionFingerprint {
  const db = new DatabaseSync(fixture.dbPath)
  try {
    const card = db.prepare('SELECT card_hash, card_json FROM scene_memory_cards WHERE run_id=? AND scene_id=? ORDER BY updated_at DESC LIMIT 1').get(fixture.runId, fixture.contract.sceneId) as { card_hash?: string; card_json?: string } | undefined
    const outbox = db.prepare('SELECT card_hash, payload_json FROM scene_memory_card_outbox WHERE story_id=? AND project_id=? AND branch_id=? AND scene_id=? ORDER BY updated_at DESC LIMIT 1').get(fixture.storyId, fixture.projectId, fixture.branchId, fixture.contract.sceneId) as { card_hash?: string; payload_json?: string } | undefined
    const index = db.prepare('SELECT index_hash, status FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND story_revision=1 ORDER BY built_at DESC LIMIT 1').get(fixture.storyId, fixture.projectId, fixture.branchId) as { index_hash?: string; status?: string } | undefined
    return {
      cardHash: card?.card_hash ?? null,
      cardJson: card?.card_json ?? null,
      outboxHash: outbox?.card_hash ?? null,
      outboxPayload: outbox?.payload_json ?? null,
      indexHash: index?.index_hash ?? null,
      indexStatus: index?.status ?? null
    }
  } finally {
    db.close()
  }
}

function sameProjectionFingerprint(left: ProjectionFingerprint, right: ProjectionFingerprint): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function setHook(hooks: HookMap, hook: string, fn: () => void): void {
  hooks[hook] = fn
}

function prepareFixture(repo: ReturnType<typeof createRepository>, dbPath: string, input: { runId: string; sessionId: string; storyId: string; projectId: string; branchId?: string }): Fixture {
  const branchId = input.branchId ?? 'main'
  const { runId, sessionId, storyId, projectId } = input
  repo.createRun({ ...runRow(runId, sessionId), config_json: JSON.stringify({ storyScope: scopeConfig(storyId, projectId, branchId) }) })
  const plan = makePlan()
  const contract = plan.contracts[0]!
  repo.ensureSceneStates(runId, plan, 1)
  repo.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: 1, from: 'planned', to: 'writing', at: 2 })
  const candidate = segment({ runId, sessionId, id: `${runId}-segment-1`, sceneId: contract.sceneId, status: 'candidate', content: '林舟抵达灯塔。' })
  repo.saveManuscriptSegment(row(candidate))
  const writing = repo.getSceneStates(runId)[0]!
  repo.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: writing.revision, from: 'writing', to: 'candidate', candidateSegmentId: candidate.segmentId, candidateHash: candidate.contentHash, at: 3 })
  const decision = buildSceneCompletionDecision(contract, candidate.content, { candidateSegmentId: candidate.segmentId, scenePrefix: '', at: 4 })
  if (decision.status !== 'complete') throw new Error(`scene fixture did not complete: ${decision.status}`)
  const delta = buildEmptyNarrativeStateDelta({ runId, sceneId: contract.sceneId, acceptedSegmentId: candidate.segmentId, acceptedContentHash: candidate.contentHash, contractHash: contract.frozenHash })
  const commitManifest = manifest(contract, runId, candidate, decision, delta.deltaHash)
  const commitManifestHash = sha256Text(stableSceneMemoryJson(commitManifest))
  const projection = buildCard({ runId, storyId, projectId, branchId, contract, candidate, commitManifestHash, stateDeltaHash: delta.deltaHash, storyRevision: 1 })
  repo.saveRunEvidence(runId, `scene_completion_decision:${candidate.segmentId}`, JSON.stringify({ schemaVersion: 1, runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, candidateSegmentId: candidate.segmentId, candidateHash: candidate.contentHash, decision, stateDeltaHash: delta.deltaHash, savedAt: 4 }))
  const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({ runId, segmentId: candidate.segmentId, candidateHash: candidate.contentHash, candidateCharCount: candidate.charCount, evidenceRevision: candidate.revision, sceneId: contract.sceneId, evidenceRefs: {} })
  repo.saveRunEvidence(runId, 'manuscript_acceptance_ready', JSON.stringify({ schemaVersion: 1, runId, segmentId: candidate.segmentId, candidateHash: candidate.contentHash, candidateCharCount: candidate.charCount, evidenceRevision: candidate.revision, evidenceIdentity, sceneId: contract.sceneId, evidenceRefs: {}, preparedAt: 4 }))
  const commit: CommitEnvelope = {
    acceptance: { runId, segmentId: candidate.segmentId, expectedContentHash: candidate.contentHash, expectedCharCount: candidate.charCount, evidenceRevision: candidate.revision, evidenceIdentity, sceneId: contract.sceneId, acceptedAt: 5 },
    contractId: contract.contractId,
    contractHash: contract.frozenHash,
    expectedSceneRevision: repo.getSceneStates(runId)[0]!.revision,
    decision,
    completionEvidenceHash: decision.evidenceHash,
    stateDelta: delta,
    manifest: commitManifest,
    committedAt: 5,
    projection
  }
  return { repo, dbPath, runId, sessionId, storyId, projectId, branchId, contract, candidate, decision, delta, projection, commit }
}

function openFixture(root: string, suffix: string, hooks: HookMap = {}): Fixture {
  const dbPath = path.join(root, `${suffix}.sqlite`)
  const repo = createRepository(dbPath, hooks as never)
  repo.open()
  return prepareFixture(repo, dbPath, { runId: `${suffix}-run`, sessionId: `${suffix}-session`, storyId: `${suffix}-story`, projectId: `${suffix}-project` })
}

function prepareSecondRevision(repo: ReturnType<typeof createRepository>, dbPath: string, first: Fixture, suffix: string): Fixture {
  const second = prepareFixture(repo, dbPath, {
    runId: `${suffix}-run`,
    sessionId: `${suffix}-session`,
    storyId: first.storyId,
    projectId: first.projectId,
    branchId: first.branchId
  })
  const freshness = repo.getStoryLedgerFreshness(second.runId)
  if (!freshness) throw new Error('r73 second revision freshness missing')
  const storyRevision = freshness.headRevision + 1
  const cardPayload = { ...second.projection.card, cardId: 'wp5-card-2', storyRevision }
  const card = { ...cardPayload, cardHash: sceneMemoryCardHash(cardPayload) }
  second.projection = {
    ...second.projection,
    card,
    context: { ...second.projection.context, expectedStoryRevision: storyRevision }
  }
  second.commit = {
    ...second.commit,
    projection: second.projection,
    expectedLedgerFence: {
      expectedRevision: freshness.runRevision,
      expectedEpoch: freshness.validityEpoch,
      expectedHeadRevision: freshness.headRevision,
      expectedHeadHash: freshness.headHash
    }
  }
  return second
}

function cloneCommit(fixture: Fixture): CommitEnvelope {
  return structuredClone(fixture.commit) as CommitEnvelope
}

type LedgerFence = {
  expectedRevision: number
  expectedEpoch: number
  expectedHeadRevision: number
  expectedHeadHash: string | null
}

function initialLedgerFence(): LedgerFence {
  return { expectedRevision: 0, expectedEpoch: 1, expectedHeadRevision: 0, expectedHeadHash: null }
}

function callCommit(fixture: Fixture, commit: CommitEnvelope = fixture.commit): { threw: boolean; error: string } {
  try {
    fixture.repo.commitScene(commit as never)
    return { threw: false, error: '' }
  } catch (error) {
    return { threw: true, error: error instanceof Error ? error.message : String(error) }
  }
}

async function testExpectedLedgerFence(root: string): Promise<void> {
  const cases: Array<{ name: string; fence: LedgerFence; error: string }> = [
    {
      name: 'stale expected head/cursor revision',
      fence: { ...initialLedgerFence(), expectedRevision: 1, expectedHeadRevision: 1 },
      error: 'story_ledger_concurrent_head_conflict'
    },
    {
      name: 'stale expected head hash',
      fence: { ...initialLedgerFence(), expectedHeadHash: sha256Text('wrong-head-hash') },
      error: 'story_ledger_concurrent_head_conflict'
    },
    {
      name: 'stale expected ledger epoch',
      fence: { ...initialLedgerFence(), expectedEpoch: 2 },
      error: 'story_ledger_epoch_invalidated'
    }
  ]
  for (const [index, item] of cases.entries()) {
    const fixture = openFixture(root, `r73-fence-${index}`)
    try {
      const before = readCounts(fixture)
      const commit = cloneCommit(fixture)
      commit.expectedLedgerFence = item.fence
      const result = callCommit(fixture, commit)
      const after = readCounts(fixture)
      check(`expectedLedgerFence rejects ${item.name} with exact error`, result.threw && result.error === item.error, result.error)
      check(`expectedLedgerFence rejection ${item.name} leaves no canonical writes`, sameCounts(before, after) && after.commits === 0 && after.committedState === 0 && after.canonicalCards === 0 && after.readyIndex === 0, JSON.stringify({ before, after }))
    } finally {
      close(fixture)
    }
  }
}

function close(fixture: Pick<Fixture, 'repo'>): void {
  try { fixture.repo.close() } catch { /* test cleanup */ }
}

async function testInitialProjectionRed(root: string): Promise<void> {
  const fixture = openFixture(root, 'r73-baseline')
  try {
    const result = callCommit(fixture)
    check('commitScene baseline canonical chain commits', !result.threw, result.error)
    const counts = readCounts(fixture)
    check('WP5 red: commitScene must publish exactly one canonical SceneMemoryCard', counts.canonicalCards === 1, JSON.stringify(counts))
    check('WP5 red: commitScene must publish exactly one ready recall index row', counts.readyIndex === 1, JSON.stringify(counts))
  } finally {
    close(fixture)
  }
}

async function testHookRollback(root: string): Promise<void> {
  const cases: Array<{ name: string; hook: string }> = [
    { name: 'before card projection write', hook: CARD_HOOKS.before },
    { name: 'after card projection write', hook: CARD_HOOKS.after },
    { name: 'before recall index write', hook: INDEX_HOOKS.before },
    { name: 'after recall index write', hook: INDEX_HOOKS.after }
  ]
  for (const [index, item] of cases.entries()) {
    const hooks: HookMap = {}
    setHook(hooks, item.hook, () => { throw new Error(`r73-injected:${item.name}`) })
    const fixture = openFixture(root, `r73-hook-${index}`, hooks)
    try {
      const before = readCounts(fixture)
      const result = callCommit(fixture)
      const after = readCounts(fixture)
      check(`atomic rollback ${item.name} raises injected fault`, result.threw && result.error.includes('r73-injected'), result.error)
      check(`atomic rollback ${item.name} leaves every canonical write point unchanged`, sameCounts(before, after), JSON.stringify({ before, after }))
      check(`atomic rollback ${item.name} leaves no committed SceneMemoryCard/index`, after.committedState === 0 && after.canonicalCards === 0 && after.readyIndex === 0, JSON.stringify(after))
    } finally {
      close(fixture)
    }
  }
}

async function testReplayRestartAndEmbedding(root: string): Promise<void> {
  const fixture = openFixture(root, 'r73-replay')
  try {
    const first = callCommit(fixture)
    const afterFirst = readCounts(fixture)
    const second = callCommit(fixture, cloneCommit(fixture))
    const afterReplay = readCounts(fixture)
    check('same operation/decision replay is idempotent', !first.threw && !second.threw, JSON.stringify({ first, second }))
    check('same operation/decision replay creates one commit/card/index only', afterReplay.commits === 1 && afterReplay.canonicalCards === 1 && afterReplay.readyIndex === 1 && afterReplay.outbox === 1, JSON.stringify(afterReplay))
    check('embedding unavailable/failure does not block canonical commit', fixture.projection.card.embedding.status === 'unavailable' && afterFirst.canonicalCards === 1, JSON.stringify(afterFirst))
    const beforeChangedProjection = readProjectionFingerprint(fixture)
    const changedReplay = cloneCommit(fixture)
    const changedCardPayload = { ...changedReplay.projection!.card, decisiveAction: '林舟离开灯塔。' }
    changedReplay.projection = {
      ...changedReplay.projection!,
      card: { ...changedCardPayload, cardHash: sceneMemoryCardHash(changedCardPayload) }
    }
    const changedProjectionResult = callCommit(fixture, changedReplay)
    const afterChangedProjection = readProjectionFingerprint(fixture)
    check('same operation replay with changed projection bytes is rejected', changedProjectionResult.threw, changedProjectionResult.error)
    check('changed projection replay adds or overwrites no card/outbox/index bytes', sameProjectionFingerprint(beforeChangedProjection, afterChangedProjection) && afterReplay.commits === 1 && afterReplay.canonicalCards === 1 && afterReplay.readyIndex === 1 && afterReplay.outbox === 1, JSON.stringify({ beforeChangedProjection, afterChangedProjection, changedProjectionResult }))
    close(fixture)
    const reopened = createRepository(fixture.dbPath)
    reopened.open()
    const afterRestart = readCounts(fixture)
    check('restart restores one committed state and one canonical projection', afterRestart.committedState === 1 && afterRestart.canonicalCards === 1 && afterRestart.readyIndex === 1, JSON.stringify(afterRestart))
    check('restart has no duplicate pending/committed outbox state', afterRestart.outbox === 1 && afterRestart.publishedOutbox === 1, JSON.stringify(afterRestart))
    reopened.close()
  } finally {
    close(fixture)
  }
}

async function testLiveRebuildRevisionScope(root: string): Promise<void> {
  const dbPath = path.join(root, 'r73-rebuild-scope.sqlite')
  const repo = createRepository(dbPath)
  repo.open()
  const first = prepareFixture(repo, dbPath, { runId: 'r73-rebuild-first-run', sessionId: 'r73-rebuild-first-session', storyId: 'r73-rebuild-story', projectId: 'r73-rebuild-project' })
  try {
    const firstResult = callCommit(first)
    const second = prepareSecondRevision(repo, dbPath, first, 'r73-rebuild-second')
    const secondResult = callCommit(second)
    const db = new DatabaseSync(dbPath)
    let liveHash: string | null = null
    try {
      const row = db.prepare('SELECT index_hash FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=1 AND story_revision=2').get(first.storyId, first.projectId, first.branchId) as { index_hash?: string } | undefined
      liveHash = row?.index_hash ?? null
    } finally {
      db.close()
    }
    const scoped = repo.rebuildSceneMemoryProjection({ storyId: first.storyId, projectId: first.projectId, branchId: first.branchId, validityEpoch: 1, storyRevision: 2, sceneId: second.contract.sceneId }, [second.projection])
    const dbAfterScoped = new DatabaseSync(dbPath)
    let activeAfterScoped = 0
    try {
      activeAfterScoped = Number((dbAfterScoped.prepare('SELECT COUNT(*) AS value FROM scene_memory_cards WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=1 AND visibility=\'active\'').get(first.storyId, first.projectId, first.branchId) as { value?: number } | undefined)?.value ?? 0)
    } finally {
      dbAfterScoped.close()
    }
    check('revisioned live commit and scoped rebuild both succeed', !firstResult.threw && !secondResult.threw, JSON.stringify({ firstResult, secondResult }))
    check('live cumulative index hash equals scoped rebuild hash', Boolean(liveHash) && liveHash === scoped.indexHash, JSON.stringify({ liveHash, scoped }))
    check('scoped rebuild keeps prior revision active for cumulative index', activeAfterScoped === 2, String(activeAfterScoped))
    const full = repo.rebuildSceneMemoryProjection({ storyId: first.storyId, projectId: first.projectId, branchId: first.branchId, validityEpoch: 1 }, [second.projection])
    const dbAfterFull = new DatabaseSync(dbPath)
    try {
      const rows = dbAfterFull.prepare('SELECT story_revision, visibility FROM scene_memory_cards WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=1 ORDER BY story_revision').all(first.storyId, first.projectId, first.branchId) as Array<{ story_revision?: number; visibility?: string }>
      check('full-scope rebuild stales omitted cards across revisions', rows.length === 2 && rows[0]?.story_revision === 1 && rows[0]?.visibility === 'stale' && rows[1]?.story_revision === 2 && rows[1]?.visibility === 'active', JSON.stringify(rows))
      check('full-scope rebuild index becomes cumulative over remaining active cards', full.cardCount === 1 && full.indexHash !== liveHash, JSON.stringify(full))
    } finally {
      dbAfterFull.close()
    }
  } finally {
    close(first)
  }
}

async function testConcurrentHead(root: string): Promise<void> {
  const dbPath = path.join(root, 'r73-concurrent.sqlite')
  const repo = createRepository(dbPath)
  repo.open()
  const first = prepareFixture(repo, dbPath, { runId: 'r73-concurrent-a-run', sessionId: 'r73-concurrent-session-a', storyId: 'r73-concurrent-story', projectId: 'r73-concurrent-project' })
  const second = prepareFixture(repo, dbPath, { runId: 'r73-concurrent-b-run', sessionId: 'r73-concurrent-session-b', storyId: 'r73-concurrent-story', projectId: 'r73-concurrent-project' })
  try {
    const a = callCommit(first)
    const beforeLoser = readCounts(second)
    const b = callCommit(second)
    const countsA = readCounts(first)
    const countsB = readCounts(second)
    check('same-head concurrent commit has exactly one success', !a.threw && b.threw, JSON.stringify({ a, b }))
    check('stale concurrent loser is explicit story_ledger conflict', b.error === 'story_ledger_concurrent_head_conflict', b.error)
    check('stale concurrent loser writes no commit/card/index', countsB.commits === 0 && countsB.canonicalCards === 0 && sameCounts(beforeLoser, countsB), JSON.stringify({ beforeLoser, countsB }))
    check('same-head concurrent winner leaves one head revision', countsA.headRevision === 1 && countsA.cursorRevision === 1, JSON.stringify(countsA))
  } finally {
    close(first)
    close(second)
  }
}

async function testAuthorityRejects(root: string): Promise<void> {
  const cases: Array<{ name: string; mutate: (commit: CommitEnvelope) => void }> = [
    { name: 'contract mismatch', mutate: (commit) => { commit.contractHash = sha256Text('wrong-contract') } },
    { name: 'state delta hash mismatch', mutate: (commit) => { commit.stateDelta = { ...commit.stateDelta, deltaHash: sha256Text('wrong-delta') } } },
    { name: 'epoch mismatch', mutate: (commit) => {
      const projection = commit.projection!
      const card = { ...projection.card, validityEpoch: 2, cardHash: sha256Text('wrong-epoch-card') }
      commit.projection = { ...projection, card, context: { ...projection.context, expectedValidityEpoch: 2 } }
    } },
    { name: 'source span/content mismatch', mutate: (commit) => {
      const projection = commit.projection!
      const source = projection.context.sourceSegments[0]!
      commit.projection = { ...projection, context: { ...projection.context, sourceSegments: [{ ...source, content: '提供方伪造正文。' }] } }
    } },
    { name: 'card hash mismatch', mutate: (commit) => { commit.projection = { ...commit.projection!, card: { ...commit.projection!.card, cardHash: sha256Text('wrong-card-hash') } } } },
    { name: 'provider/critic partial output cannot become canonical', mutate: (commit) => {
      const projection = commit.projection!
      const partialCardPayload = { ...projection.card, status: 'partial' as const }
      const card = { ...partialCardPayload, cardHash: sceneMemoryCardHash(partialCardPayload) }
      commit.projection = { ...projection, card }
    } }
  ]
  for (const [index, item] of cases.entries()) {
    const fixture = openFixture(root, `r73-authority-${index}`)
    try {
      const result = callCommit(fixture, (() => { const next = cloneCommit(fixture); item.mutate(next); return next })())
      const counts = readCounts(fixture)
      check(`authority rejects ${item.name}`, result.threw, result.error)
      check(`authority rejection ${item.name} leaves no committed rows`, counts.commits === 0 && counts.canonicalCards === 0 && counts.readyIndex === 0 && counts.committedState === 0, JSON.stringify(counts))
    } finally {
      close(fixture)
    }
  }
}

async function main(): Promise<void> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dw-r73-wp5-'))
  try {
    await testInitialProjectionRed(root)
    await testHookRollback(root)
    await testReplayRestartAndEmbedding(root)
    await testLiveRebuildRevisionScope(root)
    await testExpectedLedgerFence(root)
    await testConcurrentHead(root)
    await testAuthorityRejects(root)
  } catch (error) {
    failed += 1
    console.error(`R73 WP5 harness exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nR73 WP5 atomic scene commit adversarial: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

void main().catch((error) => {
  console.error('R73 WP5 adversarial execution failed:', error)
  process.exitCode = 2
})
