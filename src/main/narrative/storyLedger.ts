import { createHash } from 'node:crypto'
import type { NarrativeLedgerScope, NarrativeLedgerScopeInfo, NarrativeLedgerScopeInput } from '../../shared/types'
import { stableNarrativeJson } from './stateDelta'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export const STORY_LEDGER_SCHEMA_VERSION = 1 as const
/**
 * The scope schema and the node-hash schema are deliberately independent.
 * Scope v1 is still the public story identifier contract; node hashes moved
 * from the pre-v1.2.4 shape to a parent-bound chain in schema v2.
 */
export const STORY_LEDGER_HASH_SCHEMA_VERSION = 2 as const
export const STORY_LEDGER_LEGACY_HASH_SCHEMA_VERSION = 1 as const
export const DEFAULT_STORY_BRANCH_ID = 'main'

/**
 * A revision-zero ledger has no row to hash and therefore stores a SQL NULL
 * head hash.  Recall/Working-Set scopes still need a normal content address
 * so they can use the same immutable 64-hex fence as non-empty ledgers.  This
 * sentinel is deliberately derived from the complete scope, epoch, and
 * revision-zero identity; it is not a substitute for a missing non-zero
 * ledger hash and must only be used for the empty genesis state.
 */
export function storyLedgerGenesisHeadHash(scopeInput: NarrativeLedgerScope, validityEpoch: number): string {
  const scope = validateNarrativeLedgerScope(scopeInput)
  if (!Number.isInteger(validityEpoch) || validityEpoch < 1) throw new Error('story_ledger_genesis_epoch_invalid')
  return createHash('sha256').update(stableNarrativeJson({
    schemaVersion: 1,
    kind: 'story-ledger-genesis-head',
    hashSchemaVersion: STORY_LEDGER_HASH_SCHEMA_VERSION,
    scope,
    validityEpoch,
    revision: 0,
    parentHash: null
  }), 'utf8').digest('hex')
}

/**
 * `rebase` is a normal accepted-state node whose parent is an earlier
 * tombstone head.  Keeping it distinct from `revision` makes the first write
 * in a new validity epoch auditable without changing the v2 hash envelope.
 */
export type StoryLedgerNodeType = 'revision' | 'rebase' | 'retraction'

export interface StoryLedgerRevisionHashInput {
  storyId: string
  projectId: string
  branchId: string
  revision: number
  parentRevision: number
  runId: string | null
  sceneId: string | null
  deltaHash: string
  manifestHash: string | null
}

export interface StoryLedgerTombstoneHashInput {
  storyId: string
  projectId: string
  branchId: string
  revision: number
  parentRevision: number
  targetRevision: number
  targetRevisionHash: string
  targetRunId: string | null
  targetSceneId: string | null
  reason: string
}

export interface StoryLedgerRevisionHashV2Input extends StoryLedgerRevisionHashInput {
  parentHash: string | null
  nodeType: 'revision' | 'rebase'
  hashSchemaVersion: typeof STORY_LEDGER_HASH_SCHEMA_VERSION
}

export interface StoryLedgerTombstoneHashV2Input extends StoryLedgerTombstoneHashInput {
  parentHash: string | null
  nodeType: 'retraction'
  hashSchemaVersion: typeof STORY_LEDGER_HASH_SCHEMA_VERSION
}

/**
 * Content-address the ledger node independently of the run's local revision.
 * Keep this helper in the scope module so migrations and repository writes use
 * exactly the same canonical representation.
 */
export function storyLedgerRevisionHash(input: StoryLedgerRevisionHashInput): string {
  return createHash('sha256').update(stableNarrativeJson(input), 'utf8').digest('hex')
}

/** Hash the complete v2 revision node, including its predecessor. */
export function storyLedgerRevisionHashV2(input: StoryLedgerRevisionHashV2Input): string {
  return createHash('sha256').update(stableNarrativeJson(input), 'utf8').digest('hex')
}

/** Content-address an append-only retraction node without changing the hash
 * of the revision it supersedes.  Retractions are ledger nodes in their own
 * table because they do not contain accepted prose or a NarrativeStateDelta.
 */
export function storyLedgerTombstoneHash(input: StoryLedgerTombstoneHashInput): string {
  return createHash('sha256').update(stableNarrativeJson({ nodeType: 'retraction', ...input }), 'utf8').digest('hex')
}

/** Hash the complete v2 retraction node, including its predecessor. */
export function storyLedgerTombstoneHashV2(input: StoryLedgerTombstoneHashV2Input): string {
  return createHash('sha256').update(stableNarrativeJson(input), 'utf8').digest('hex')
}

export interface ParsedNarrativeLedgerScope {
  scope: NarrativeLedgerScope
  parentRevision: number | null
  parentBranchId: string | null
  explicit: boolean
}

/**
 * Immutable read-side snapshot used to fence a provider call.  A run may
 * retain an older cursor for inspection, but only a snapshot whose cursor,
 * branch head and validity epoch still agree is executable.
 */
export interface StoryLedgerFreshness {
  runId: string
  scope: NarrativeLedgerScope
  /** Authoritative root-to-branch lineage used by recall snapshots.  Older
   * in-memory/test ports may omit this field; production repository always
   * supplies it. */
  branchLineage?: readonly string[]
  runRevision: number
  runHash: string | null
  validityEpoch: number
  headRevision: number
  headHash: string | null
  headValidityEpoch: number
  epochValid: boolean
  headMatchesCursor: boolean
  fresh: boolean
}

/** Expected snapshot captured before a provider call or scene commit. */
export interface StoryLedgerFreshnessExpectation {
  runId: string
  expectedRevision: number
  expectedEpoch: number
  expectedHeadRevision: number
  expectedHeadHash: string | null
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24)
}

function generatedId(prefix: string, value: string): string {
  return `${prefix}_${digest(value)}`
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

function invalid(code: string): never {
  throw new Error(code)
}

function normalizeId(value: unknown, code: string): string {
  if (!validId(value)) invalid(code)
  return value as string
}

function normalizeParentRevision(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) invalid('story_ledger_parent_revision_invalid')
  return value
}

export function validateNarrativeLedgerScope(scope: NarrativeLedgerScope): NarrativeLedgerScope {
  if (!scope || scope.schemaVersion !== STORY_LEDGER_SCHEMA_VERSION) invalid('story_ledger_scope_invalid')
  return {
    schemaVersion: STORY_LEDGER_SCHEMA_VERSION,
    storyId: normalizeId(scope.storyId, 'story_ledger_story_id_invalid'),
    projectId: normalizeId(scope.projectId, 'story_ledger_project_id_invalid'),
    branchId: normalizeId(scope.branchId, 'story_ledger_branch_id_invalid')
  }
}

export function parseNarrativeLedgerScopeInput(value: unknown): ParsedNarrativeLedgerScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('story_ledger_scope_invalid')
  const candidate = value as Record<string, unknown>
  const scope = validateNarrativeLedgerScope({
    schemaVersion: STORY_LEDGER_SCHEMA_VERSION,
    storyId: candidate.storyId as string,
    projectId: candidate.projectId as string,
    branchId: candidate.branchId as string
  })
  const parentBranchId = candidate.parentBranchId === undefined || candidate.parentBranchId === null
    ? null
    : normalizeId(candidate.parentBranchId, 'story_ledger_parent_branch_invalid')
  return {
    scope,
    parentRevision: normalizeParentRevision(candidate.parentRevision),
    parentBranchId,
    explicit: true
  }
}

export function defaultNarrativeLedgerScope(sessionId: string, config: Record<string, unknown> = {}): ParsedNarrativeLedgerScope {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) invalid('story_ledger_session_id_invalid')
  const requested = config.storyScope ?? config.narrativeScope
  if (requested !== undefined && requested !== null) return parseNarrativeLedgerScopeInput(requested)
  const projectSeed = typeof config.projectId === 'string' && config.projectId.trim()
    ? config.projectId
    : typeof config.workDir === 'string' && config.workDir.trim()
      ? config.workDir
      : sessionId
  return {
    scope: {
      schemaVersion: STORY_LEDGER_SCHEMA_VERSION,
      storyId: generatedId('story', sessionId),
      projectId: generatedId('project', projectSeed),
      branchId: DEFAULT_STORY_BRANCH_ID
    },
    parentRevision: null,
    parentBranchId: null,
    explicit: false
  }
}

export function narrativeLedgerScopeFromConfig(sessionId: string, configJson: string | Record<string, unknown> | null | undefined): ParsedNarrativeLedgerScope {
  let config: Record<string, unknown> = {}
  if (typeof configJson === 'string' && configJson.trim()) {
    try {
      const parsed = JSON.parse(configJson) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('story_ledger_config_invalid')
      config = parsed as Record<string, unknown>
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('story_ledger_')) throw error
      invalid('story_ledger_config_invalid')
    }
  } else if (configJson && typeof configJson === 'object' && !Array.isArray(configJson)) {
    config = configJson
  }
  return defaultNarrativeLedgerScope(sessionId, config)
}

export function narrativeLedgerScopeKey(scope: NarrativeLedgerScope): string {
  const valid = validateNarrativeLedgerScope(scope)
  return `${valid.storyId}\u0000${valid.projectId}\u0000${valid.branchId}`
}

export function narrativeLedgerScopeInfo(scope: NarrativeLedgerScope, input: { parentRevision?: number | null; parentBranchId?: string | null; currentRevision?: number; highWatermark?: number; validityEpoch?: number; headValidityEpoch?: number; epochValid?: boolean }): NarrativeLedgerScopeInfo {
  const valid = validateNarrativeLedgerScope(scope)
  const parentRevision = input.parentRevision ?? 0
  const currentRevision = input.currentRevision ?? parentRevision
  const highWatermark = input.highWatermark ?? currentRevision
  if (!Number.isInteger(parentRevision) || parentRevision < 0 || !Number.isInteger(currentRevision) || currentRevision < parentRevision || !Number.isInteger(highWatermark) || highWatermark < currentRevision) invalid('story_ledger_scope_info_invalid')
  const parentBranchId = input.parentBranchId ?? null
  if (parentBranchId !== null) normalizeId(parentBranchId, 'story_ledger_parent_branch_invalid')
  const validityEpoch = input.validityEpoch ?? 1
  const headValidityEpoch = input.headValidityEpoch ?? validityEpoch
  if (!Number.isInteger(validityEpoch) || validityEpoch < 1 || !Number.isInteger(headValidityEpoch) || headValidityEpoch < 1) invalid('story_ledger_scope_epoch_invalid')
  return { ...valid, parentRevision, parentBranchId, currentRevision, highWatermark, validityEpoch, headValidityEpoch, epochValid: input.epochValid ?? validityEpoch === headValidityEpoch }
}

export function scopeInputToConfig(input: NarrativeLedgerScopeInput): NarrativeLedgerScopeInput {
  const parsed = parseNarrativeLedgerScopeInput(input)
  return {
    ...parsed.scope,
    ...(parsed.parentRevision !== null ? { parentRevision: parsed.parentRevision } : {}),
    ...(parsed.parentBranchId !== null ? { parentBranchId: parsed.parentBranchId } : {})
  }
}
