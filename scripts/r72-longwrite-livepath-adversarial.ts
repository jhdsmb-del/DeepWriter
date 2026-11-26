import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRepository, type ManuscriptSegmentRow } from '../src/main/db/repository'
import { buildSceneContractPlan } from '../src/main/narrative/sceneContract'
import { buildDeterministicRecallIndex, SCENE_RECALL_BM25_VERSION, SCENE_RECALL_TOKENIZER_VERSION, sceneRecallAuthorityHash, sceneRecallSourceCardSetHash, sceneRecallSourceSnapshotHash } from '../src/main/narrative/recallIndex'
import { compileSceneWorkingSet, sceneRecallSourceSnapshotSetHash, sceneWorkingSetHash } from '../src/main/narrative/sceneContextCompiler'
import { createContextService } from '../src/main/contextService'
import { createModelCallAdapter, type KernelApi } from '../src/main/runKernelAdapter'
import { sceneMemoryCardHash, stableSceneMemoryJson } from '../src/main/narrative/sceneMemoryCard'
import { makeManuscriptSegment } from '../src/main/manuscript'
import { buildNarrativeFactsFromGrill } from '../src/main/narrative/factRegistry'
import { storyLedgerGenesisHeadHash } from '../src/main/narrative/storyLedger'
import { grillMeOutlineHash } from '../src/shared/grillMe'
import type { ContextManifestV2, ContextPolicyV2, FrozenContextSnapshotV2 } from '../src/shared/contextV2'
import type { DsMessage, NarrativeFact, SceneContextCompilerInput, SceneRecallCorpusItem, SceneRecallCorpusSnapshot, SceneRecallIndexResult, SceneRecallQuery, SceneRecallRequiredFact, SceneRecallScope, SceneMemoryCard, SceneMemorySourceSegment, SceneStateRecord, SceneContractPlan } from '../src/shared/types'

type AnyRecord = Record<string, unknown>

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

function sha(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableSceneMemoryJson(value), 'utf8').digest('hex')
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

const RUN_ID = 'r72-livepath-run'
const SESSION_ID = 'r72-livepath-session'
const STORY_ID = 'r72-livepath-story'
const PROJECT_ID = 'r72-livepath-project'
const BRANCH_ID = 'main'
const CURRENT_SCENE_ID = 'r72-livepath-current-scene'
const CARD_ID = 'r72-livepath-card'
const FACT_SLOT_ID = 'r72-grill-source-slot'
const FACT_TEXT = 'R72-GRILL-CANONICAL-FACT：林舟确认唯一源事实。'
const HEAD_HASH = sha('r72-livepath-head')
const GENESIS_SCOPE = { schemaVersion: 1 as const, storyId: STORY_ID, projectId: PROJECT_ID, branchId: BRANCH_ID }
const GENESIS_HEAD_HASH = storyLedgerGenesisHeadHash(GENESIS_SCOPE, 1)
const USER_INPUT = '继续写作，只输出当前场景正文。'
const PREFIX = 'R72-FROZEN-PREFIX'
const LEGACY_SUMMARY = 'R72-LEGACY-SUMMARY-MUST-NOT-REACH-PROVIDER'
const LEGACY_RECENT = 'R72-LEGACY-RECENT-MUST-NOT-REACH-PROVIDER'
const LEGACY_CURRENT_SCENE = 'R72-LEGACY-CURRENT-SCENE-MUST-NOT-REACH-PROVIDER'
const DURABLE_PARTIAL = 'R72-DURABLE-PARTIAL-ROUND-1（尚未接受）'
const LARGE_DURABLE_PARTIAL = `R72-LARGE-DURABLE-PARTIAL-${'中'.repeat(13_000)}`

function makeContractPlan(sourceSlotIds: string[] = []): SceneContractPlan {
  const outline = {
    title: 'R72 活路径反证场景',
    premise: '验证唯一 compiler Working Set 的真实生产接线。',
    targetChars: 800,
    sections: [{
      id: 'r72-section',
      title: 'R72 唯一场景',
      purpose: '推进 R72 的 source-bound 场景事实。',
      targetChars: 800,
      beats: ['林舟确认 R72 源事实'],
      sourceSlotIds: [...sourceSlotIds]
    }]
  }
  return buildSceneContractPlan({ outline, outlineHash: grillMeOutlineHash(outline), characterNames: ['林舟'] })
}

function makeCanonicalFact(): NarrativeFact {
  const fact = buildNarrativeFactsFromGrill({
    sessionId: SESSION_ID,
    runId: RUN_ID,
    answers: [{ slotId: FACT_SLOT_ID, value: FACT_TEXT, source: 'user' }],
    now: 1
  })[0]
  if (!fact) throw new Error('r72 fact fixture missing')
  return fact
}

function requiredFact(fact: NarrativeFact, requiredId = FACT_SLOT_ID): SceneRecallRequiredFact {
  return {
    requiredId,
    factId: fact.factId,
    version: fact.version,
    canonicalStatement: fact.canonicalStatement,
    canonicalHash: fact.canonicalHash,
    provenanceHash: fact.provenanceHash,
    sourceSlotIds: [...fact.sourceSlotIds].sort()
  }
}

function makeCard(scope: SceneRecallScope): { card: SceneMemoryCard; segment: SceneMemorySourceSegment } {
  const content = 'R72-CANONICAL-SOURCE：林舟确认了唯一的源事实。'
  const contentHash = sha(content)
  const segment: SceneMemorySourceSegment = {
    segmentId: `${CARD_ID}-segment`,
    content,
    contentHash,
    segmentRevision: 1,
    status: 'accepted',
    sceneId: 'r72-livepath-previous-scene',
    commitId: `${CARD_ID}-commit`,
    commitManifestHash: sha(`${CARD_ID}-manifest`),
    chunkIndex: 0
  }
  const evidence = [{ kind: 'source_span' as const, id: `${CARD_ID}-span`, hash: contentHash, spanId: `${CARD_ID}-span` }]
  const card: SceneMemoryCard = {
    schemaVersion: 1,
    status: 'canonical',
    cardId: CARD_ID,
    storyId: scope.storyId,
    projectId: scope.projectId,
    branchId: scope.branchId,
    validityEpoch: scope.validityEpoch,
    storyRevision: scope.storyRevision - 1,
    runId: RUN_ID,
    sceneId: segment.sceneId,
    sceneOrder: scope.storyRevision - 1,
    contractId: 'r72-livepath-previous-contract',
    contractHash: sha('r72-livepath-previous-contract'),
    sceneContentHash: contentHash,
    commitManifestHash: segment.commitManifestHash,
    stateDeltaHash: sha(`${CARD_ID}-delta`),
    povCharacterId: null,
    participants: [],
    locations: [],
    objects: [],
    dramaticQuestion: null,
    valueShift: null,
    decisiveAction: 'R72-CANONICAL-SOURCE',
    turn: null,
    cost: null,
    factsEstablished: [],
    beliefChanges: [],
    relationshipChanges: [],
    threads: [],
    motifs: [],
    distinctivePhrases: [],
    sourceSegmentIds: [segment.segmentId],
    sourceSpans: [{
      spanId: `${CARD_ID}-span`,
      segmentId: segment.segmentId,
      segmentHash: contentHash,
      segmentRevision: 1,
      manifestHash: segment.commitManifestHash,
      startUtf16: 0,
      endUtf16: content.length,
      text: content,
      spanHash: contentHash
    }],
    embedding: { status: 'unavailable', version: null, modelId: null, dimensions: null, vectorHash: null },
    fieldEvidence: { decisiveAction: evidence },
    cardHash: '',
    createdAt: 1
  }
  card.cardHash = sceneMemoryCardHash(card)
  return { card, segment }
}

function makeSnapshot(contractPlan: SceneContractPlan, includeCard = true, requiredFacts: readonly SceneRecallRequiredFact[] = [], contractIndex = 0): { snapshot: SceneRecallCorpusSnapshot; recall: SceneRecallIndexResult; query: SceneRecallQuery; compilerInput: SceneContextCompilerInput } {
  const contract = contractPlan.contracts[contractIndex]
  if (!contract) throw new Error(`r72 contract fixture missing: ${contractIndex}`)
  const scopeBase = {
    storyId: STORY_ID,
    projectId: PROJECT_ID,
    branchId: BRANCH_ID,
    branchLineage: [BRANCH_ID],
    validityEpoch: 1,
    storyRevision: 2,
    sceneId: contract.sceneId,
    headRevision: 2,
    headHash: HEAD_HASH,
    expectedSourceCardSetHash: sha('placeholder')
  }
  const corpus: SceneRecallCorpusItem[] = []
  if (includeCard) {
    const made = makeCard(scopeBase)
    const authorityBase = {
      storyId: STORY_ID,
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      branchLineage: [BRANCH_ID],
      validityEpoch: 1,
      storyRevision: made.card.storyRevision,
      headRevision: 2,
      headHash: HEAD_HASH,
      sourceSnapshotHash: sceneRecallSourceSnapshotHash(made.card, [made.segment]),
      cardHash: made.card.cardHash
    }
    corpus.push({
      card: made.card,
      sourceSegments: [made.segment],
      sourceValidated: true,
      authority: { ...authorityBase, authorityHash: sceneRecallAuthorityHash(authorityBase) }
    })
  }
  const sourceCardSetHash = sceneRecallSourceCardSetHash(corpus)
  const scope: SceneRecallScope = { ...scopeBase, expectedSourceCardSetHash: sourceCardSetHash }
  const snapshot: SceneRecallCorpusSnapshot = {
    schemaVersion: 1,
    runId: RUN_ID,
    sceneId: contract.sceneId,
    scope,
    sourceSnapshotHash: sceneRecallSourceSnapshotSetHash(corpus),
    sourceCardSetHash,
    corpus
  }
  const query: SceneRecallQuery = {
    scope,
    requiredFactIds: requiredFacts.map((fact) => fact.factId),
    requiredFacts: requiredFacts.map((fact) => ({ ...fact, sourceSlotIds: [...fact.sourceSlotIds] })),
    queryText: [contract.title, contract.objective, contract.desire, contract.obstacle, contract.conflict, contract.expectedTurn, contract.reveal].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n'),
    queryTerms: [],
    tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION,
    bm25Version: SCENE_RECALL_BM25_VERSION,
    topK: 6,
    budget: 6
  }
  const recall = buildDeterministicRecallIndex({ corpus: snapshot.corpus, query })
  const compilerInput: SceneContextCompilerInput = {
    snapshot,
    recall,
    recallQuery: query,
    contract,
    hardConstraints: '（未提供硬约束；不得自行补写。）',
    requiredFacts: requiredFacts.map((fact) => ({ ...fact, sourceSlotIds: [...fact.sourceSlotIds] })),
    budgetTokens: 4096
  }
  return { snapshot, recall, query, compilerInput }
}

function makeState(plan: SceneContractPlan, contractIndex = 0): SceneStateRecord {
  const contract = plan.contracts[contractIndex]
  if (!contract) throw new Error(`r72 state fixture missing: ${contractIndex}`)
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    sceneId: contract.sceneId,
    sectionId: contract.sectionId,
    contractId: contract.contractId,
    contractHash: contract.frozenHash,
    order: contract.order,
    lifecycle: 'writing',
    revision: 1,
    candidateSegmentId: null,
    candidateHash: null,
    acceptedSegmentId: null,
    acceptedHash: null,
    completionDecision: null,
    completionEvidenceHash: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    committedAt: null
  }
}

function policy(): ContextPolicyV2 {
  return {
    schemaVersion: 2,
    mode: 'minimal',
    revision: 1,
    recentBundles: { optimized: 6, minimal: 2 },
    retrieval: { enabled: false, algorithm: 'bm25-local-v1', maxItems: 6, maxEstimatedTokens: 12000, minScore: 0.05 },
    summary: { enabled: false, schemaVersion: 1, triggerBundles: 12 },
    failClosed: true,
    outputReserveTokens: 128
  }
}

function frozenContext(): FrozenContextSnapshotV2 {
  return {
    schemaVersion: 2,
    mode: 'minimal',
    policy: policy(),
    policyRevision: 1,
    pinRevision: 0,
    pins: [],
    summary: null,
    retrieverVersion: null,
    retrievalIndexVersion: null,
    estimatorVersion: 'local-heuristic-v2',
    capabilityFingerprint: 'r72-livepath'
  }
}

function makeConfig(plan: SceneContractPlan, overrides: AnyRecord = {}): AnyRecord {
  return {
    clientRequestId: RUN_ID,
    sessionId: SESSION_ID,
    runMode: 'longwrite',
    longMode: true,
    model: 'r72-fixture-model',
    task: USER_INPUT,
    planMode: false,
    sceneContracts: plan,
    frozenContext: frozenContext(),
    contextPolicy: { contextWindowTokens: 65536, outputReserveTokens: 128 },
    sceneWorkingSetBudgetTokens: 4096,
    strongConstraints: { enabled: false },
    ...overrides
  }
}

type Persisted = AnyRecord & {
  workingSetHash: string
  status: string
  manifestHash: string
  workingSetMessageHash: string
  workingSet?: AnyRecord
  manifest?: AnyRecord
  workingSetMessage?: AnyRecord
}

type FixtureRepo = AnyRecord & {
  freshness: AnyRecord
  snapshot: SceneRecallCorpusSnapshot
  state: SceneStateRecord
  persisted: Persisted | null
  evidence: Map<string, string>
}

type RepoOptions = { genesis?: boolean }

function persistedWorkingSetHash(workingSet: AnyRecord): string {
  const identityKeys = ['runId', 'sceneId', 'storyId', 'projectId', 'branchId', 'validityEpoch', 'storyRevision', 'headRevision', 'headHash', 'sourceSnapshotHash', 'sourceCardSetHash', 'currentSceneTailHash', 'queryHash', 'indexHash', 'contractId', 'contractHash', 'contractContentHash', 'budgetTokens', 'estimatorVersion']
  const identity = Object.fromEntries(identityKeys.map((key) => [key, workingSet[key]]))
  const sections = Array.isArray(workingSet.sections)
    ? workingSet.sections.map((section) => {
      const value = section as AnyRecord
      return { id: value.id, required: value.required, included: value.included, contentHash: value.contentHash, sourceCardIds: value.sourceCardIds, omissionReason: value.omissionReason }
    })
    : workingSet.sections
  return sha({ identity, sections, omitted: workingSet.omitted })
}

function assertPersistedWorkingSet(record: Persisted): void {
  const workingSet = record.workingSet
  const manifest = record.manifest
  const message = record.workingSetMessage
  if (!workingSet || !manifest || !message) throw new Error('scene_working_set_canonical_missing')
  const manifestHash = manifest.manifestHash
  const { manifestHash: _manifestHash, ...manifestCore } = manifest
  const integrity = {
    workingSetHash: workingSet.workingSetHash === persistedWorkingSetHash(workingSet),
    manifestHash: manifestHash === sha(manifestCore),
    workingSetManifestBinding: workingSet.manifestHash === manifestHash,
    workingSetMessageBinding: workingSet.workingSetMessageHash === message.messageHash,
    manifestMessageBinding: manifest.workingSetMessageHash === message.messageHash,
    messageManifestBinding: message.manifestHash === manifestHash,
    messageHash: message.messageHash === sha(message.messages)
  }
  if (Object.values(integrity).some((ok) => !ok)) throw new Error(`scene_working_set_canonical_tampered:${JSON.stringify(integrity)}`)
  if (record.workingSetHash !== workingSet.workingSetHash || record.manifestHash !== manifestHash || record.workingSetMessageHash !== message.messageHash) throw new Error('scene_working_set_column_mismatch')
}

function makeRepo(snapshot: SceneRecallCorpusSnapshot, state: SceneStateRecord, tamper?: (record: Persisted) => void, facts: readonly NarrativeFact[] = [], options: RepoOptions = {}): FixtureRepo {
  const genesis = options.genesis === true
  const freshness = {
    runId: RUN_ID,
    scope: { schemaVersion: 1, storyId: STORY_ID, projectId: PROJECT_ID, branchId: BRANCH_ID },
    branchLineage: [BRANCH_ID],
    runRevision: genesis ? 0 : snapshot.scope.storyRevision,
    runHash: genesis ? null : HEAD_HASH,
    validityEpoch: snapshot.scope.validityEpoch,
    headRevision: genesis ? 0 : snapshot.scope.headRevision,
    headHash: genesis ? null : HEAD_HASH,
    headValidityEpoch: snapshot.scope.validityEpoch,
    epochValid: true,
    headMatchesCursor: true,
    fresh: true
  }
  const repo: FixtureRepo = {
    freshness,
    snapshot: clone(snapshot),
    state: clone(state),
    persisted: null,
    evidence: new Map<string, string>(),
    getStoryLedgerFreshness(this: FixtureRepo) { return clone(this.freshness) },
    assertStoryLedgerFresh(this: FixtureRepo, expected: AnyRecord) {
      const now = this.freshness
      const headMatches = genesis
        ? (expected.expectedHeadHash === null || expected.expectedHeadHash === GENESIS_HEAD_HASH)
        : expected.expectedHeadHash === now.headHash
      if (expected.runId !== RUN_ID || expected.expectedRevision !== now.runRevision || expected.expectedEpoch !== now.validityEpoch || expected.expectedHeadRevision !== now.headRevision || !headMatches) throw new Error('story_ledger_freshness_mismatch')
      return clone(now)
    },
    getSceneStates(this: FixtureRepo) { return [clone(this.state)] },
    getSceneRecallCorpusSnapshot(this: FixtureRepo, input?: AnyRecord) {
      const expected = input?.expectedFence as AnyRecord | undefined
      const scope = this.snapshot.scope
      if (genesis && expected && expected.headHash !== null && expected.headHash !== GENESIS_HEAD_HASH) throw new Error('scene_working_set_snapshot_fence_mismatch')
      if (!genesis && expected && (expected.storyId !== scope.storyId || expected.projectId !== scope.projectId || expected.branchId !== scope.branchId || expected.validityEpoch !== scope.validityEpoch || expected.storyRevision !== scope.storyRevision || expected.headRevision !== scope.headRevision || expected.headHash !== scope.headHash)) throw new Error('scene_working_set_snapshot_fence_mismatch')
      return clone(this.snapshot)
    },
    saveSceneWorkingSet(this: FixtureRepo, input: AnyRecord) {
      const payload = (input.payload ?? {}) as AnyRecord
      const workingSet = (input.workingSet ?? payload.workingSet) as AnyRecord | undefined
      const manifest = (input.manifest ?? payload.manifest) as AnyRecord | undefined
      const workingSetMessage = (input.workingSetMessage ?? payload.workingSetMessage) as AnyRecord | undefined
      const record: Persisted = {
        ...clone(input),
        status: 'active',
        workingSetHash: String(input.workingSetHash ?? workingSet?.workingSetHash ?? ''),
        manifestHash: String(input.manifestHash ?? manifest?.manifestHash ?? ''),
        workingSetMessageHash: String(input.workingSetMessageHash ?? workingSetMessage?.messageHash ?? ''),
        workingSet: clone(workingSet),
        manifest: clone(manifest),
        workingSetMessage: clone(workingSetMessage)
      }
      tamper?.(record)
      this.persisted = record
    },
    bindSceneWorkingSetFinalEnvelope(this: FixtureRepo, input: AnyRecord) {
      if (!this.persisted) throw new Error('scene_working_set_missing')
      const hash = Array.isArray(input.finalEnvelope)
        ? envelopeHash(input.finalEnvelope as DsMessage[])
        : String(input.finalEnvelopeHash ?? '')
      if (this.persisted.finalEnvelopeHash && this.persisted.finalEnvelopeHash !== hash) throw new Error('scene_working_set_final_envelope_conflict')
      this.persisted.finalEnvelopeHash = hash
    },
    getSceneWorkingSet(this: FixtureRepo) {
      if (!this.persisted) return null
      const record = clone(this.persisted)
      assertPersistedWorkingSet(record)
      return record
    },
    saveRunEvidence(this: FixtureRepo, _runId: string, kind: string, json: string) { this.evidence.set(kind, json) },
    saveRunEvidenceIfAbsent(this: FixtureRepo, _runId: string, kind: string, json: string) { if (this.evidence.has(kind)) return false; this.evidence.set(kind, json); return true },
    saveContextManifest() { return undefined },
    getNarrativeLedger() { return [] },
    getNarrativeLedgerScope() { return null },
    getNarrativeFacts() { return clone(facts) },
    upsertNarrativeFact() { return undefined },
    getAcceptedNarrativePrefixSnapshot() { return { schemaVersion: 1, hash: sha('empty-prefix'), acceptedCharCount: 0, acceptedSegmentCount: 0, recentProse: [], readBytes: 0, cacheHit: true, cacheRevision: 0 } }
  } as unknown as FixtureRepo
  return repo
}

function makeV2() {
  const manifests: ContextManifestV2[] = []
  return {
    manifests,
    resolveFrozenPins() { return [] },
    historyCandidates() { return [] },
    resolveFrozenSummary() { return null },
    summaryCandidate() { return null },
    appendManifest(value: ContextManifestV2) { manifests.push(clone(value)) }
  }
}

function envelopeHash(messages: DsMessage[]): string {
  return createHash('sha256').update(messages.map((message) => `${message.role.length}:${message.role}${Buffer.byteLength(message.content ?? '', 'utf8')}:${message.content ?? ''}`).join('|'), 'utf8').digest('hex')
}

/** Mutate the real SQLite canonical row into another internally consistent
 * envelope binding.  This intentionally bypasses the repository API: it is
 * the adversarial storage-corruption side of the production fence test. */
function rewriteRealCanonicalEnvelope(dbPath: string, workingSetId: string): string {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('SELECT canonical_json FROM scene_working_sets WHERE working_set_id=?').get(workingSetId) as { canonical_json?: unknown } | undefined
    if (!row || typeof row.canonical_json !== 'string') throw new Error('r72 real canonical row missing')
    const record = JSON.parse(row.canonical_json) as AnyRecord
    const alternateEnvelope: DsMessage[] = [
      { role: 'system', content: 'R72-ALTERNATE-VALID-ENVELOPE' },
      { role: 'user', content: USER_INPUT }
    ]
    const alternateHash = envelopeHash(alternateEnvelope)
    record.finalEnvelopeHash = alternateHash
    const canonicalJson = stableSceneMemoryJson(record)
    const canonicalHash = sha(record)
    const result = db.prepare('UPDATE scene_working_sets SET payload_json=?, canonical_json=?, canonical_hash=?, final_envelope_hash=? WHERE working_set_id=?').run(canonicalJson, canonicalJson, canonicalHash, alternateHash, workingSetId) as { changes?: number }
    if (Number(result.changes ?? 0) !== 1) throw new Error('r72 real canonical row update failed')
    return alternateHash
  } finally {
    db.close()
  }
}

function oldMarkers(messages: DsMessage[]): string[] {
  const joined = messages.map((message) => message.content ?? '').join('\n')
  return [LEGACY_SUMMARY, LEGACY_RECENT, LEGACY_CURRENT_SCENE].filter((marker) => joined.includes(marker))
}

type ProviderRun = {
  providerCalls: number
  messages: DsMessage[]
  output: string
  context: ContextManifestV2 | null
  error: unknown
  repo: FixtureRepo
  v2: ReturnType<typeof makeV2>
}

type InvokeOptions = {
  /** Mirror streamChat's final before-fetch callback in the provider seam. */
  runBeforeProviderAttempt?: boolean
  round?: number
  logicalCallId?: string
  providerDelta?: string
  runId?: string
}

async function invoke(config: AnyRecord, repo: FixtureRepo, requestMessages: DsMessage[] = [{ role: 'user', content: USER_INPUT }], options: InvokeOptions = {}): Promise<ProviderRun> {
  const v2 = makeV2()
  const service = createContextService(repo as never, v2 as never)
  let providerCalls = 0
  let messages: DsMessage[] = []
  let output = ''
  let context: ContextManifestV2 | null = null
  const api: KernelApi = {
    apiKey: 'r72-fixture-key',
    baseUrl: 'https://r72.invalid',
    model: 'r72-fixture-model',
    maxTokens: 512,
    thinking: { enabled: false, effort: 'high' },
    temperature: 0.2,
    topP: 1,
    profileId: 'r72-profile',
    providerId: 'r72-provider'
  }
  const adapter = createModelCallAdapter({
    getApi: () => api,
    buildPrefix: async () => [{ role: 'system', content: PREFIX }],
    getSignal: () => undefined,
    getConfig: () => config,
    assembleContext: async (rc, round, live, prefix, purpose, requestId, stageId) => {
      const assembled = await service.assembleRunContext(rc, round, live, prefix, purpose, requestId, stageId)
      return { ...assembled, contextV2: assembled.contextV2 ?? null }
    },
    persistContext: (manifest, fullMessages, live) => {
      context = service.persistContext(manifest, fullMessages, live)
      return context
    },
    streamChatImpl: async (params, onEvent, _signal, _onRetry, _onAttempt, _onAttemptLifecycle, beforeAttempt) => {
      if (options.runBeforeProviderAttempt !== false) await beforeAttempt?.(1)
      providerCalls += 1
      messages = clone(params.messages)
      if (options.providerDelta) {
        output += options.providerDelta
        onEvent({ type: 'text', delta: options.providerDelta })
      }
      onEvent({ type: 'done', finishReason: 'stop', usage: { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 17, reasoning_tokens: 0, cache_tokens_known: true, reasoning_tokens_known: true } })
      return { finishReason: 'stop', usage: null }
    }
  })
  let error: unknown = null
  try {
    const iterable = await adapter({ runId: options.runId ?? RUN_ID, phase: 'writing', turnSeq: options.round ?? 1, round: options.round ?? 1, messages: requestMessages, purpose: 'writer', logicalCallId: options.logicalCallId ?? 'r72-logical-call' })
    for await (const _event of iterable) { /* drain */ }
  } catch (caught) {
    error = caught
  }
  return { providerCalls, messages, output, context, error, repo, v2 }
}

function persistDurablePartial(repo: ReturnType<typeof createRepository>, plan: SceneContractPlan, runId: string, sessionId: string, content = DURABLE_PARTIAL): ManuscriptSegmentRow {
  const contract = plan.contracts[0]!
  const segment = makeManuscriptSegment({
    runId,
    sessionId,
    turnId: `${runId}:round-1-turn`,
    chunkIndex: 1,
    revision: 1,
    content,
    status: 'partial',
    kind: 'prose',
    sectionId: contract.sectionId,
    sceneId: contract.sceneId,
    createdAt: 2,
    updatedAt: 2
  })
  const row: ManuscriptSegmentRow = {
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
    accepted_at: null
  }
  repo.saveManuscriptSegment(row)
  return row
}

type TwoOuterRoundProbe = {
  round1: ProviderRun
  round2: ProviderRun
  partialRows: ManuscriptSegmentRow[]
}

async function runTwoOuterRoundProbe(label: string, round2LogicalCallId: string, partialContent = DURABLE_PARTIAL): Promise<TwoOuterRoundProbe> {
  const root = mkdtempSync(join(tmpdir(), `deepwriter-r72-two-round-${label}-`))
  const dbPath = join(root, 'deepwriter.sqlite')
  const repo = createRepository(dbPath)
  const genesis = genesisFixture()
  const runId = `${RUN_ID}-${label}`
  const sessionId = `${SESSION_ID}-${label}`
  const config = makeConfig(genesis.plan, { clientRequestId: runId, sessionId })
  try {
    repo.open()
    repo.createRun({
      run_id: runId,
      session_id: sessionId,
      status: 'running',
      phase: 'writing',
      started_at: 1,
      updated_at: 1,
      config_json: JSON.stringify({ storyScope: GENESIS_SCOPE }),
      parent_run_id: null,
      error_code: null,
      error_message: null,
      client_request_id: null
    })
    repo.ensureSceneStates(runId, genesis.plan, 1)
    const round1 = await invoke(config, repo as unknown as FixtureRepo, [{ role: 'user', content: USER_INPUT }], { runId, round: 1, logicalCallId: `${runId}:round-1`, providerDelta: partialContent })
    // Real manuscript segments are FK-linked to their source assistant turn.
    // AgentRunEngine appends that turn before persisting a durable partial;
    // reproduce that ordering instead of weakening this repository-backed probe.
    repo.appendTurn({
      turn_id: `${runId}:round-1-turn`,
      run_id: runId,
      turn_seq: 1,
      role: 'assistant',
      content: partialContent,
      reasoning_content: null,
      tool_calls_json: null,
      tool_result_json: null,
      plan_state: null,
      created_at: 2
    })
    persistDurablePartial(repo, genesis.plan, runId, sessionId, partialContent)
    const partialRows = repo.getManuscriptSegmentsByRun(runId).filter((row) => row.status === 'partial')
    const round2 = await invoke(config, repo as unknown as FixtureRepo, [{ role: 'user', content: USER_INPUT }], { runId, round: 2, logicalCallId: round2LogicalCallId, providerDelta: 'R72-ROUND-2-PROVIDER' })
    return { round1, round2, partialRows }
  } finally {
    try { repo.close() } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true })
  }
}

function compilerFixture(): { plan: SceneContractPlan; snapshot: SceneRecallCorpusSnapshot; recall: SceneRecallIndexResult; query: SceneRecallQuery; compilerInput: SceneContextCompilerInput; state: SceneStateRecord } {
  const plan = makeContractPlan()
  const parts = makeSnapshot(plan)
  return { plan, ...parts, state: makeState(plan) }
}

function factFixture(fact: NarrativeFact): { plan: SceneContractPlan; snapshot: SceneRecallCorpusSnapshot; recall: SceneRecallIndexResult; query: SceneRecallQuery; compilerInput: SceneContextCompilerInput; state: SceneStateRecord; required: SceneRecallRequiredFact } {
  const plan = makeContractPlan([FACT_SLOT_ID])
  const required = requiredFact(fact)
  const parts = makeSnapshot(plan, false, [required])
  return { plan, ...parts, state: makeState(plan), required }
}

function genesisFixture(): { plan: SceneContractPlan; snapshot: SceneRecallCorpusSnapshot; state: SceneStateRecord } {
  const plan = makeContractPlan()
  const parts = makeSnapshot(plan, false)
  const snapshot = clone(parts.snapshot) as SceneRecallCorpusSnapshot
  const scope = snapshot.scope as unknown as AnyRecord
  scope.storyRevision = 0
  scope.headRevision = 0
  // The durable ledger stores SQL NULL at genesis.  Recall/Working-Set
  // authority must map that raw value to the scope-bound sentinel before it
  // reaches the compiler; the fixture never promotes genesis to revision 1.
  scope.headHash = GENESIS_HEAD_HASH
  snapshot.scope = scope as unknown as SceneRecallScope
  return { plan, snapshot, state: makeState(plan) }
}

async function main(): Promise<void> {
  const fixture = compilerFixture()
  const compiled = compileSceneWorkingSet(fixture.compilerInput)
  check('fixture compiler produces one ready Working Set', compiled.workingSet.status === 'ready' && compiled.manifest.manifestHash.length === 64 && compiled.workingSetMessage.messageHash.length === 64)

  const validRepo = makeRepo(fixture.snapshot, fixture.state)
  const valid = await invoke(makeConfig(fixture.plan), validRepo)
  const workingSetContent = compiled.workingSetMessage.messages[0]?.content ?? ''
  const providerWorkingSetMessages = valid.messages.filter((message) => message.role === 'system' && message.content === workingSetContent)
  check('real longwrite_v2 seam reaches provider with one compiler message', valid.error === null && valid.providerCalls === 1 && providerWorkingSetMessages.length === 1, String(valid.error ?? ''))
  const envelopeEvidence = [...valid.repo.evidence.entries()].find(([key]) => key.startsWith('scene_working_set_envelope:'))
  const actualEnvelopeHash = envelopeHash(valid.messages)
  let evidenceEnvelopeHash = ''
  try {
    evidenceEnvelopeHash = String((JSON.parse(envelopeEvidence?.[1] ?? '{}') as AnyRecord).envelopeHash ?? '')
  } catch {
    evidenceEnvelopeHash = ''
  }
  const persistedEnvelopeHash = valid.repo.persisted?.finalEnvelopeHash
  check('provider envelope hash is recomputable from actual messages', valid.context?.envelopeHash === actualEnvelopeHash && evidenceEnvelopeHash === actualEnvelopeHash && persistedEnvelopeHash === actualEnvelopeHash, JSON.stringify({ context: valid.context?.envelopeHash, persisted: persistedEnvelopeHash, evidence: evidenceEnvelopeHash, actual: actualEnvelopeHash, evidenceKey: envelopeEvidence?.[0] }))
  const narrative = valid.context?.narrativeWorkingSet
  check('provider context carries immutable Working Set identity', Boolean(narrative && narrative.manifestHash.length === 64 && narrative.messageHash.length === 64 && narrative.sourceCardSetHash === fixture.snapshot.sourceCardSetHash && narrative.indexHash === fixture.recall.indexHash), JSON.stringify(narrative))
  const sectionCounts = ['summary', 'recent_tail', 'current_scene', 'scene_contract'].map((section) => [section, valid.messages.filter((message) => message.content?.includes(`## ${section}`)).length] as const)
  check('summary/recent/current-scene legacy projections are not duplicated', oldMarkers(valid.messages).length === 0 && providerWorkingSetMessages.length === 1 && sectionCounts.every(([, count]) => count <= 1) && valid.messages.filter((message) => message.role === 'user').length === 1, JSON.stringify({ markers: oldMarkers(valid.messages), sectionCounts }))

  const canonicalFact = makeCanonicalFact()
  const firstScene = factFixture(canonicalFact)
  const firstSceneCompiled = compileSceneWorkingSet(firstScene.compilerInput)
  const firstSceneRepo = makeRepo(firstScene.snapshot, firstScene.state, undefined, [canonicalFact])
  const firstSceneRun = await invoke(makeConfig(firstScene.plan), firstSceneRepo)
  const firstSceneMessage = firstSceneRun.messages.find((message) => message.role === 'system' && message.content?.includes(FACT_TEXT))
  check('Grill sourceSlotId resolves through canonical NarrativeFact (empty card corpus still sends)', firstSceneRun.error === null && firstSceneRun.providerCalls === 1 && firstScene.snapshot.corpus.length === 0 && firstSceneMessage?.content === firstSceneCompiled.workingSetMessage.messages[0]?.content && firstSceneMessage.content.includes(`source:${FACT_SLOT_ID}`), JSON.stringify({ calls: firstSceneRun.providerCalls, error: String(firstSceneRun.error ?? ''), message: firstSceneMessage?.content }))
  check('first-scene fact is not matched against a SceneMemoryCard factId', firstSceneRun.providerCalls === 1 && firstSceneRun.context?.narrativeWorkingSet?.sourceCardSetHash === sceneRecallSourceCardSetHash([]) && firstSceneRun.messages.every((message) => !message.content?.includes(CARD_ID)), JSON.stringify({ calls: firstSceneRun.providerCalls, sourceCardSetHash: firstSceneRun.context?.narrativeWorkingSet?.sourceCardSetHash }))

  const missingFact = await invoke(makeConfig(firstScene.plan), makeRepo(firstScene.snapshot, firstScene.state))
  check('missing canonical fact denies provider before Working Set compile', missingFact.providerCalls === 0 && String(missingFact.error ?? '').includes('scene_working_set_required_fact_missing'), String(missingFact.error ?? 'provider unexpectedly called'))

  const pendingFact = { ...canonicalFact, status: 'pending_review' as const }
  const pendingFactRun = await invoke(makeConfig(firstScene.plan), makeRepo(firstScene.snapshot, firstScene.state, undefined, [pendingFact]))
  check('pending_review canonical fact denies provider', pendingFactRun.providerCalls === 0 && String(pendingFactRun.error ?? '').includes('scene_working_set_required_fact_missing'), String(pendingFactRun.error ?? 'provider unexpectedly called'))

  const tamperedFact = { ...canonicalFact, canonicalStatement: `${canonicalFact.canonicalStatement}-tampered` }
  const tamperedFactRun = await invoke(makeConfig(firstScene.plan), makeRepo(firstScene.snapshot, firstScene.state, undefined, [tamperedFact]))
  check('tampered canonical fact provenance denies provider', tamperedFactRun.providerCalls === 0 && String(tamperedFactRun.error ?? '').includes('scene_working_set_required_fact_invalid'), String(tamperedFactRun.error ?? 'provider unexpectedly called'))

  const genesis = genesisFixture()
  const genesisRun = await invoke(makeConfig(genesis.plan), makeRepo(genesis.snapshot, genesis.state, undefined, [], { genesis: true }))
  check('real story-ledger genesis revision=0/head_hash=null with empty corpus reaches provider', genesisRun.error === null && genesisRun.providerCalls === 1, JSON.stringify({ calls: genesisRun.providerCalls, error: String(genesisRun.error ?? '') }))

  // The fixture above isolates the adapter seam.  This second assertion uses
  // the actual SQLite Repository at its untouched revision-zero state so the
  // production snapshot/working-set persistence path proves NULL↔sentinel
  // mapping before the provider boundary.
  const realRoot = mkdtempSync(join(tmpdir(), 'deepwriter-r72-live-genesis-'))
  const realDbPath = join(realRoot, 'deepwriter.sqlite')
  const realRepo = createRepository(realDbPath)
  try {
    realRepo.open()
    realRepo.createRun({
      run_id: RUN_ID,
      session_id: SESSION_ID,
      status: 'running',
      phase: 'writing',
      started_at: 1,
      updated_at: 1,
      config_json: JSON.stringify({ storyScope: GENESIS_SCOPE }),
      parent_run_id: null,
      error_code: null,
      error_message: null,
      client_request_id: null
    })
    realRepo.ensureSceneStates(RUN_ID, genesis.plan, 1)
    const realGenesisRun = await invoke(makeConfig(genesis.plan), realRepo as unknown as FixtureRepo)
    const realFreshness = realRepo.getStoryLedgerFreshness(RUN_ID)
    const persistedGenesis = realGenesisRun.context?.narrativeWorkingSet?.workingSetId
      ? realRepo.getSceneWorkingSet(realGenesisRun.context.narrativeWorkingSet.workingSetId)
      : null
    check('actual Repository rev0 NULL head + empty corpus + nonempty contract reaches provider once', realGenesisRun.error === null && realGenesisRun.providerCalls === 1 && realFreshness?.runRevision === 0 && realFreshness.headRevision === 0 && realFreshness.headHash === null && persistedGenesis?.headHash === GENESIS_HEAD_HASH, JSON.stringify({ calls: realGenesisRun.providerCalls, error: String(realGenesisRun.error ?? ''), freshness: realFreshness, persistedHead: persistedGenesis?.headHash }))

    // After the exact envelope is bound, mutate the durable canonical payload
    // and final-envelope column together to another valid envelope.  The
    // retry fence must compare that stored hash with the bytes it is about to
    // send; checking only Working Set/manifest hashes is insufficient.
    const realWorkingSetId = realGenesisRun.context?.narrativeWorkingSet?.workingSetId
    const bindApi = realRepo as unknown as { bindSceneWorkingSetFinalEnvelope: (input: AnyRecord) => void }
    const originalBind = bindApi.bindSceneWorkingSetFinalEnvelope.bind(realRepo)
    let alternateEnvelopeHash = ''
    bindApi.bindSceneWorkingSetFinalEnvelope = (input: AnyRecord) => {
      originalBind(input)
      if (!alternateEnvelopeHash && realWorkingSetId) alternateEnvelopeHash = rewriteRealCanonicalEnvelope(realDbPath, realWorkingSetId)
    }
    const tamperedRetry = await invoke(makeConfig(genesis.plan), realRepo as unknown as FixtureRepo)
    bindApi.bindSceneWorkingSetFinalEnvelope = originalBind
    const tamperedPersisted = realWorkingSetId ? realRepo.getSceneWorkingSet(realWorkingSetId) : null
    check('real Repository self-consistent final-envelope tamper denies retry provider', tamperedRetry.providerCalls === 0 && alternateEnvelopeHash.length === 64 && tamperedPersisted?.finalEnvelopeHash === alternateEnvelopeHash, JSON.stringify({ calls: tamperedRetry.providerCalls, error: String(tamperedRetry.error ?? ''), alternateEnvelopeHash, persistedEnvelopeHash: tamperedPersisted?.finalEnvelopeHash }))
  } finally {
    try { realRepo.close() } catch { /* best effort */ }
    rmSync(realRoot, { recursive: true, force: true })
  }

  // True two-outer-round probes.  The first provider call produces a durable
  // partial; the second call keeps the same scene/head but changes only the
  // outer logical call id (the shape AgentRunEngine uses).  A separate probe
  // intentionally reuses the immutable Working Set id to verify fail-closed
  // behavior when the current-scene tail has changed.
  const differentWorkingSetIdProbe = await runTwoOuterRoundProbe('new-call-id', `${RUN_ID}-new-call-id:round-2`)
  const firstIdentity = differentWorkingSetIdProbe.round1.context?.narrativeWorkingSet
  const secondIdentity = differentWorkingSetIdProbe.round2.context?.narrativeWorkingSet
  check('two outer rounds persist round-1 provider partial before round 2', differentWorkingSetIdProbe.round1.error === null && differentWorkingSetIdProbe.round1.providerCalls === 1 && differentWorkingSetIdProbe.round1.output === DURABLE_PARTIAL && differentWorkingSetIdProbe.partialRows.length === 1 && differentWorkingSetIdProbe.partialRows[0]?.content === DURABLE_PARTIAL, JSON.stringify({ calls: differentWorkingSetIdProbe.round1.providerCalls, output: differentWorkingSetIdProbe.round1.output, partialRows: differentWorkingSetIdProbe.partialRows.length, error: String(differentWorkingSetIdProbe.round1.error ?? '') }))
  check('two outer rounds same scene/head reach provider despite a fresh outer call id', differentWorkingSetIdProbe.round2.error === null && differentWorkingSetIdProbe.round2.providerCalls === 1 && firstIdentity?.storyRevision === secondIdentity?.storyRevision && firstIdentity?.headRevision === secondIdentity?.headRevision && firstIdentity?.headHash === secondIdentity?.headHash, JSON.stringify({ calls: differentWorkingSetIdProbe.round2.providerCalls, error: String(differentWorkingSetIdProbe.round2.error ?? ''), first: firstIdentity, second: secondIdentity }))
  check('round-2 fresh-call provider envelope carries prior durable partial', differentWorkingSetIdProbe.round2.messages.some((message) => message.content?.includes(DURABLE_PARTIAL)), JSON.stringify({ messages: differentWorkingSetIdProbe.round2.messages, partial: DURABLE_PARTIAL }))

  const sameWorkingSetIdProbe = await runTwoOuterRoundProbe('same-call-id', `${RUN_ID}-same-call-id:round-1`)
  const sameIdError = String(sameWorkingSetIdProbe.round2.error ?? '')
  check('reusing immutable Working Set id after current-tail change fails closed before provider', sameWorkingSetIdProbe.round1.providerCalls === 1 && sameWorkingSetIdProbe.round2.providerCalls === 0 && sameIdError.includes('scene_working_set_identity_conflict'), JSON.stringify({ calls: sameWorkingSetIdProbe.round2.providerCalls, error: sameIdError }))
  const sameIdProviderReached = sameWorkingSetIdProbe.round2.error === null && sameWorkingSetIdProbe.round2.providerCalls > 0
  // Do not turn a pre-provider persistence denial into a second, unrelated
  // envelope failure.  If the provider boundary is reached, the assertion
  // is strict; otherwise the persistence check above is the distinguishing
  // red signal and this one is not applicable.
  check('round-2 provider envelope carries prior durable partial when provider is reached', !sameIdProviderReached || sameWorkingSetIdProbe.round2.messages.some((message) => message.content?.includes(DURABLE_PARTIAL)), JSON.stringify({ providerReached: sameIdProviderReached, calls: sameWorkingSetIdProbe.round2.providerCalls, error: String(sameWorkingSetIdProbe.round2.error ?? ''), messages: sameWorkingSetIdProbe.round2.messages, partial: DURABLE_PARTIAL }))

  const largePartialProbe = await runTwoOuterRoundProbe('large-partial', `${RUN_ID}-large-partial:round-2`, LARGE_DURABLE_PARTIAL)
  const largeTailMessage = largePartialProbe.round2.messages.find((message) => message.role === 'system' && message.content?.includes('## recent_tail'))
  const largeTailContent = largeTailMessage?.content ?? ''
  check('oversized durable partial sends a bounded source-authenticated suffix', largePartialProbe.round1.error === null && largePartialProbe.round2.error === null && largePartialProbe.round1.providerCalls === 1 && largePartialProbe.round2.providerCalls === 1 && largePartialProbe.partialRows.length === 1 && largePartialProbe.partialRows[0]?.content === LARGE_DURABLE_PARTIAL && largeTailContent.includes(`/${LARGE_DURABLE_PARTIAL.length}`) && largeTailContent.includes(LARGE_DURABLE_PARTIAL.slice(-256)) && !largeTailContent.includes(LARGE_DURABLE_PARTIAL), JSON.stringify({ round1Calls: largePartialProbe.round1.providerCalls, round2Calls: largePartialProbe.round2.providerCalls, tailChars: largeTailContent.length, fullChars: LARGE_DURABLE_PARTIAL.length, error: String(largePartialProbe.round2.error ?? '') }))

  const legacyRequest = [
    { role: 'system' as const, content: `${LEGACY_SUMMARY}\n${LEGACY_CURRENT_SCENE}` },
    { role: 'assistant' as const, content: LEGACY_RECENT },
    { role: 'user' as const, content: USER_INPUT }
  ]
  const legacyLeak = await invoke(makeConfig(fixture.plan), makeRepo(fixture.snapshot, fixture.state), legacyRequest)
  check('engine-shaped old summary/recent/current-scene input cannot enter v2 provider envelope', legacyLeak.providerCalls === 1 && oldMarkers(legacyLeak.messages).length === 0 && legacyLeak.messages.filter((message) => message.role === 'user').length === 1, JSON.stringify({ calls: legacyLeak.providerCalls, markers: oldMarkers(legacyLeak.messages), error: String(legacyLeak.error ?? '') }))

  const tamperCases: Array<[string, (record: Persisted) => void]> = [
    ['persisted head', (record) => { if (record.workingSet) record.workingSet.headHash = sha('tampered-head') }],
    ['persisted source-card-set', (record) => { if (record.workingSet) record.workingSet.sourceCardSetHash = sha('tampered-source-card-set') }],
    ['persisted index', (record) => { if (record.workingSet) record.workingSet.indexHash = sha('tampered-index') }],
    ['persisted manifest', (record) => { if (record.manifest) record.manifest.manifestHash = sha('tampered-manifest') }],
    ['persisted compiler message', (record) => { if (record.workingSetMessage) record.workingSetMessage.messageHash = sha('tampered-message') }],
    ['persisted final envelope', (record) => { record.finalEnvelopeHash = sha('tampered-final-envelope') }]
  ]
  for (const [label, tamper] of tamperCases) {
    const result = await invoke(makeConfig(fixture.plan), makeRepo(fixture.snapshot, fixture.state, tamper))
    check(`${label} at compile→persist→provider denies provider`, result.providerCalls === 0, String(result.error ?? 'provider unexpectedly called'))
  }

  const headRepo = makeRepo(fixture.snapshot, fixture.state)
  headRepo.freshness.headHash = sha('changed-live-head')
  const headChanged = await invoke(makeConfig(fixture.plan), headRepo)
  check('live head mutation before compile denies provider', headChanged.providerCalls === 0, String(headChanged.error ?? 'provider unexpectedly called'))

  const sourceTampered = clone(fixture.snapshot)
  sourceTampered.sourceCardSetHash = sha('changed-card-set')
  sourceTampered.scope.expectedSourceCardSetHash = sourceTampered.sourceCardSetHash
  const sourceChanged = await invoke(makeConfig(fixture.plan), makeRepo(sourceTampered, fixture.state))
  check('source card set mutation before compile denies provider', sourceChanged.providerCalls === 0, String(sourceChanged.error ?? 'provider unexpectedly called'))

  const overflow = await invoke(makeConfig(fixture.plan, {
    strongConstraints: { enabled: true, level: 'strict', mustKeep: ['R72-OVERFLOW-'.repeat(5000)], forbiddenTerms: [], themeLockMode: 'strong', expressionFreedom: 'controlled', antiMoralizingEnabled: true, sourceTask: USER_INPUT }
  }), makeRepo(fixture.snapshot, fixture.state))
  check('required overflow is rejected before provider', overflow.providerCalls === 0 && String(overflow.error ?? '').includes('scene_working_set_compile_failed'), String(overflow.error ?? 'provider unexpectedly called'))

  const blockedOutline = {
    title: 'R72 blocked', premise: 'historical thread source must be present', targetChars: 200,
    sections: [{
      id: 'r72-blocked-section', title: 'blocked', purpose: 'blocked', targetChars: 200, beats: ['blocked'], sourceSlotIds: [],
      scenes: [
        { id: 'r72-blocked-first', title: 'first', purpose: 'first', targetChars: 100, beats: ['first'], sourceSlotIds: [] },
        { id: 'r72-blocked-second', title: 'second', purpose: 'second', targetChars: 100, beats: ['second'], sourceSlotIds: [] }
      ]
    }]
  }
  const blockedPlan = buildSceneContractPlan({ outline: blockedOutline, outlineHash: grillMeOutlineHash(blockedOutline) })
  const blockedParts = makeSnapshot(blockedPlan, false, [], 1)
  const blocked = await invoke(makeConfig(blockedPlan), makeRepo(blockedParts.snapshot, makeState(blockedPlan, 1)))
  check('blocked required recall is rejected before provider', blocked.providerCalls === 0 && String(blocked.error ?? '').includes('scene_working_set_recall_blocked'), String(blocked.error ?? 'provider unexpectedly called'))

  const restartedRepo = makeRepo(fixture.snapshot, fixture.state)
  const first = await invoke(makeConfig(fixture.plan), restartedRepo)
  const persistedAcrossRestart = clone(restartedRepo.persisted)
  const secondRepo = makeRepo(fixture.snapshot, fixture.state)
  secondRepo.persisted = persistedAcrossRestart
  const second = await invoke(makeConfig(fixture.plan), secondRepo)
  check('restart reads the same Working Set and envelope identity', first.providerCalls === 1 && second.providerCalls === 1 && first.context?.narrativeWorkingSet?.manifestHash === second.context?.narrativeWorkingSet?.manifestHash && first.context?.envelopeHash === second.context?.envelopeHash && JSON.stringify(first.messages) === JSON.stringify(second.messages), JSON.stringify({ first: first.context?.envelopeHash, second: second.context?.envelopeHash }))

  const legacy = await invoke(makeConfig(fixture.plan, { frozenContext: { ...frozenContext(), mode: 'legacy_v1', policy: null } }), makeRepo(fixture.snapshot, fixture.state))
  const legacyNoCompiler = await invoke({ ...makeConfig(fixture.plan, { frozenContext: { ...frozenContext(), mode: 'legacy_v1', policy: null } }), sceneContracts: undefined }, makeRepo(fixture.snapshot, fixture.state))
  check('legacy_v1 behavior is unchanged and never receives Working Set', legacy.providerCalls === 1 && legacy.context?.narrativeWorkingSet === undefined && JSON.stringify(legacy.messages) === JSON.stringify(legacyNoCompiler.messages), JSON.stringify({ legacy: legacy.context, error: String(legacy.error ?? '') }))

  const nonLong = await invoke(makeConfig(fixture.plan, { runMode: 'agent', longMode: false }), makeRepo(fixture.snapshot, fixture.state))
  const nonLongNoCompiler = await invoke({ ...makeConfig(fixture.plan, { runMode: 'agent', longMode: false }), sceneContracts: undefined }, makeRepo(fixture.snapshot, fixture.state))
  check('non-longwrite behavior is unchanged and never receives Working Set', nonLong.providerCalls === 1 && nonLong.context?.narrativeWorkingSet === undefined && JSON.stringify(nonLong.messages) === JSON.stringify(nonLongNoCompiler.messages), JSON.stringify({ nonLong: nonLong.context, error: String(nonLong.error ?? '') }))

  console.log(`\nR72 longwrite live-path adversarial: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('R72 longwrite live-path adversarial 执行异常：', error)
  process.exitCode = 2
})
