export type ContextMode = 'full' | 'optimized' | 'minimal'

export type ContextSourceKind =
  | 'frozen_system'
  | 'hard_constraint'
  | 'current_task'
  | 'approved_plan'
  | 'story_bible'
  | 'policy_memory'
  | 'pinned_message'
  | 'pinned_fact'
  | 'current_attachment'
  | 'active_tool_pair'
  | 'rolling_summary'
  | 'recent_turn'
  | 'retrieved_history'
  | 'retrieved_material'
  | 'optional_memory'
  /** P4 optimized longwrite: structured, durable narrative state manifest. */
  | 'narrative_manifest'
  | 'current_input'

export type ContextSelectionReason =
  | 'required'
  | 'recent'
  | 'summary_active'
  | 'retrieval_score'
  | 'direct_reference'
  | 'duplicate'
  | 'mode_excluded'
  | 'below_score'
  | 'budget'
  | 'superseded'
  | 'unconfirmed'
  | 'source_invalid'

export interface ContextPolicyV2 {
  /** New runs use model-aware automatic selection; omission preserves legacy modes. */
  management?: 'model_auto_v1'
  schemaVersion: 2
  mode: ContextMode
  revision: number
  recentBundles: { optimized: number; minimal: number }
  retrieval: { enabled: boolean; algorithm: 'bm25-local-v1'; maxItems: number; maxEstimatedTokens: number; minScore: number }
  summary: { enabled: boolean; schemaVersion: 1; triggerBundles: number }
  /** Frozen on new optimized runs; older snapshots omit it. */
  olderToolReads?: 'excerpt_v1'
  failClosed: true
  outputReserveTokens: number
}

export interface ContextSourceRef {
  sourceType: ContextSourceKind
  canonicalId: string
  revision: number | null
  contentHash: string
  span: { start: number; end: number } | null
  displayLabel: string
}

export interface ContextSourceDecision {
  itemId: string
  /** Exact excerpt projection of a durable rolling summary, when bounded. */
  summaryItemIds?: string[]
  source: ContextSourceRef
  required: boolean
  included: boolean
  selectionReason: ContextSelectionReason
  rankScore: number | null
  selectedEstimatedTokens: number | null
  providerActualTokens: null
}

export interface TokenMeasurement {
  value: number | null
  kind: 'local_estimate' | 'provider_exact_count' | 'provider_actual' | 'unknown'
  sourceId: string | null
  estimatorVersion: string | null
}

export interface ContextSavings {
  selectedInput: TokenMeasurement
  fullBaselineInput: TokenMeasurement
  savedTokens: TokenMeasurement
  savingsRatio: number | null
  comparable: boolean
  reasonUnknown: string | null
}

export interface ContextManifestV2 {
  /** Automatic input budget includes tool schemas and wire framing. */
  wireReserveTokens?: number
  schemaVersion: 2
  manifestId: string
  runId: string
  stageId: string
  requestId: string
  roundIndex: number
  createdAt: string
  mode: ContextMode
  policySnapshot: ContextPolicyV2
  policyRevision: number
  providerId: string
  modelId: string
  capabilityFingerprint: string
  inputBudgetTokens: number | null
  outputReserveTokens: number
  selectedEstimate: TokenMeasurement
  fullBaselineEstimate: TokenMeasurement
  estimatedSavedTokens: number | null
  estimatedSavingsRatio: number | null
  summaryRef: { summaryId: string; version: number; hash: string } | null
  retrieval: { retrieverVersion: string; indexVersion: string; queryHash: string } | null
  pinRevision: number
  sourceSetHash: string
  envelopeHash: string
  decisions: ContextSourceDecision[]
  persistedBeforeProviderSend: true
  /** v1.2.5 longwrite_v2 binding.  This does not replace the generic
   * envelope hash; it records the exact Scene Working Set fence carried by
   * the envelope so recovery/inspection can prove which narrative context
   * was compiled. */
  narrativeWorkingSet?: {
    workingSetId: string
    workingSetHash: string
    manifestHash: string
    messageHash: string
    sourceSnapshotHash: string
    sourceCardSetHash: string
    queryHash: string
    indexHash: string
    validityEpoch: number
    storyRevision: number
    headRevision: number
    headHash: string
  }
}

export interface ContextPreviewV1 {
  /** Declared/catalog/default operating budget, not a claim of official capacity. */
  modelSpecSource?: string
  schemaVersion: 1
  previewId: string
  sessionId: string
  expiresAt: string
  mode: ContextMode
  policyRevision: number
  canonicalHighWatermark: number
  pinRevision: number
  draftHash: string
  attachmentSetHash: string
  /** Hash of the exact frozen system/memory/attachment prefix used by preview. */
  prefixHash: string
  capabilityFingerprint: string
  budget: {
    maxContextTokens: number | null
    outputReserveTokens: number
    inputBudgetTokens: number | null
    status: 'ready' | 'overflow' | 'unknown'
  }
  savings: ContextSavings
  decisions: ContextSourceDecision[]
  warnings: Array<{ code: string; message: string }>
}

export interface ContextSourceSnippetView {
  manifestId: string
  itemId: string
  status: 'available' | 'source_changed' | 'not_available'
  label: string
  snippet: string | null
}

export interface ContextPreferenceView {
  sessionId: string
  mode: ContextMode
  revision: number
  pinRevision: number
  persisted: boolean
}

export interface ContextPinView {
  pinId: string
  sessionId: string
  kind: 'message' | 'fact'
  sourceId: string | null
  sourceHash: string
  factText: string | null
  displayLabel: string
  revision: number
  status: 'active' | 'revoked'
  createdAt: string
  updatedAt: string
}

export type SummaryConfirmationKind = 'user_confirmed' | 'story_committed' | 'run_evidence' | 'extractive_source' | 'draft_unconfirmed' | 'disputed'

export interface SummarySourceRef {
  kind: 'message' | 'story_bible' | 'artifact' | 'run_evidence' | 'pin'
  id: string
  revision: number | null
  hash: string
  spanStart: number | null
  spanEnd: number | null
}

export interface SummaryItemV1 {
  itemId: string
  /** Present on v2 extractive memory; attributes quotes without asserting facts. */
  sourceRole?: 'user' | 'assistant'
  section: 'goal' | 'constraint' | 'decision' | 'story_state' | 'completed_action' | 'open_question'
  text: string
  confirmation: SummaryConfirmationKind
  sources: SummarySourceRef[]
  contentHash: string
}

export interface RollingSummaryV1 {
  schemaVersion: 1
  summaryId: string
  sessionId: string
  version: number
  previousSummaryHash: string | null
  sourceHighWatermark: number
  sourceSetHash: string
  summaryHash: string
  generator: 'deterministic-extractive-v1' | 'deterministic-extractive-v2' | 'model-candidate-v1' | 'user-edited-v1'
  status: 'building' | 'active' | 'superseded' | 'draft_unconfirmed' | 'failed'
  items: SummaryItemV1[]
  createdAt: string
  activatedAt: string | null
}

export interface FrozenContextSnapshotV2 {
  /** New automatic runs cannot ingest messages appended after acceptance. */
  historyHighWatermark?: number
  schemaVersion: 2
  mode: ContextMode | 'legacy_v1'
  policy: ContextPolicyV2 | null
  policyRevision: number
  pinRevision: number
  pins: Array<{ pinId: string; sourceHash: string; revision: number }>
  summary: { summaryId: string; version: number; hash: string } | null
  retrieverVersion: string | null
  retrievalIndexVersion: string | null
  estimatorVersion: string
  capabilityFingerprint: string
}

export interface ContextRequestBillingView {
  manifestId: string
  requestId: string
  stageId: string
  roundIndex: number
  mode: ContextMode
  selectedInputEstimate: number | null
  fullBaselineEstimate: number | null
  estimatedSavedTokens: number | null
  estimatedSavingsRatio: number | null
  actualInputTokens: number | null
  actualCachedInputTokens: number | null
  actualSavedTokens: null
  actualSavingsRatio: null
  decisions: ContextSourceDecision[]
  summaryRef: ContextManifestV2['summaryRef']
  retrieval: ContextManifestV2['retrieval']
  estimatorVersion: string | null
  envelopeHash: string
}
