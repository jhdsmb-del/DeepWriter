export const SCENE_CONTRACT_V2_SCHEMA_VERSION = 2 as const
export const DRAMATIC_CRITIC_SCHEMA_VERSION = 1 as const
export const REORIENTATION_SCHEMA_VERSION = 1 as const

export const DEFAULT_WP7_FEATURE_FLAGS = Object.freeze({
  sceneContractV2: false,
  deterministicDirector: false,
  dramaticCritic: false,
  localizedRevision: false,
  reorientation: false
} as const)

export const WP7_FEATURE_FLAGS_DEFAULT = DEFAULT_WP7_FEATURE_FLAGS
export const DEFAULT_EXPERIMENTAL_NARRATIVE_FLAGS = DEFAULT_WP7_FEATURE_FLAGS

export type Wp7FeatureFlags = {
  sceneContractV2: boolean
  deterministicDirector: boolean
  dramaticCritic: boolean
  localizedRevision: boolean
  reorientation: boolean
}

export function resolveWp7FeatureFlags(flags?: Partial<Wp7FeatureFlags> | null): Wp7FeatureFlags {
  return {
    sceneContractV2: flags?.sceneContractV2 === true,
    deterministicDirector: flags?.deterministicDirector === true,
    dramaticCritic: flags?.dramaticCritic === true,
    localizedRevision: flags?.localizedRevision === true,
    reorientation: flags?.reorientation === true
  }
}

export type SceneFunctionV2 =
  | 'reaction'
  | 'discovery'
  | 'decision'
  | 'confrontation'
  | 'aftermath'
  | 'setup'
  | 'payoff'
  | 'reversal'
  | 'transition'
  | 'other'

export type HardConstraintKindV2 =
  | 'fact'
  | 'knowledge_boundary'
  | 'timeline'
  | 'forbidden'
  | 'required'
  | 'must_preserve'

export type SoftIntentKindV2 =
  | 'structure'
  | 'pacing'
  | 'tone'
  | 'voice'
  | 'imagery'
  | 'distance'
  | 'advisory'

export interface SceneConstraintV2 {
  id: string
  kind: HardConstraintKindV2
  statement: string
  source?: string | null
}

export interface SceneSoftIntentV2 {
  id: string
  kind: SoftIntentKindV2
  statement: string
  priority?: number
}

export interface SceneDesiresV2 {
  pov: string
  opposition: string
  hiddenNeed?: string | null
}

export interface SceneFailureStrategiesV2 {
  pov: string[]
  opposition: string[]
}

export interface SceneEscalationV2 {
  pressure: string
  stakes?: string | null
  irreversibleIfIgnored?: string | null
}

export interface SceneChoiceV2 {
  actor: string
  action: string
  alternatives?: string[]
  irreversible?: boolean
}

export interface SceneCostV2 {
  payer: string
  immediate: string
  lasting?: string | null
}

export interface SceneTurnV2 {
  from: string
  to: string
  trigger?: string | null
}

export interface SceneValueShiftV2 {
  from: string
  to: string
}

export interface ReaderKnowledgeDeltaV2 {
  before: string[]
  after: string[]
}

export interface CharacterKnowledgeDeltaV2 {
  characterId: string
  learns: string[]
  forgets?: string[]
  remainsUnknown?: string[]
}

export interface SceneKnowledgeDeltaV2 {
  reader: ReaderKnowledgeDeltaV2
  characters: CharacterKnowledgeDeltaV2[]
}

export interface SceneRelationshipDeltaV2 {
  relationship: string
  from: string
  to: string
}

export interface SceneExitVectorV2 {
  unresolvedQuestion: string
  nextPressure: string
  requiredDirection?: string | null
  forbiddenResolution?: string | null
}

export interface SceneContractV2 {
  schemaVersion: typeof SCENE_CONTRACT_V2_SCHEMA_VERSION
  contractId: string
  sceneId: string
  revision: number
  sceneFunction: SceneFunctionV2
  povCharacterId: string | null
  entrySituation: string
  dramaticQuestion: string
  desires: SceneDesiresV2
  failureStrategies: SceneFailureStrategiesV2
  escalation: SceneEscalationV2
  choice: SceneChoiceV2
  cost: SceneCostV2
  turn: SceneTurnV2
  valueShift: SceneValueShiftV2
  revelationAndInterpretation: string
  readerStateDelta: ReaderKnowledgeDeltaV2
  characterKnowledgeDelta: CharacterKnowledgeDeltaV2[]
  relationshipDelta: SceneRelationshipDeltaV2[]
  threadsToAdvance: string[]
  threadsNotToResolve: string[]
  exitVector: SceneExitVectorV2
  hardConstraints: SceneConstraintV2[]
  softIntent: SceneSoftIntentV2[]
  frozenHash: string
  sourceHash?: string | null
  povWant?: string
  oppositionWant?: string
  tacticsAlreadyFailed?: string[]
  pressureEscalation?: string
  choiceCost?: string
  readerCharacterKnowledge?: SceneKnowledgeDeltaV2
}

export interface SceneContractV2Draft extends Omit<SceneContractV2, 'schemaVersion' | 'frozenHash' | 'revision' | 'characterKnowledgeDelta'> {
  revision?: number
  characterKnowledgeDelta?: CharacterKnowledgeDeltaV2[]
  frozenHash?: string
}

export interface SceneDirectorInputV2 {
  contractId?: string
  sceneId: string
  revision?: number
  sceneFunction?: SceneFunctionV2
  povCharacterId?: string | null
  entrySituation?: string
  dramaticQuestion?: string
  desires?: Partial<SceneDesiresV2>
  povDesire?: string
  oppositionDesire?: string
  povWant?: string
  oppositionWant?: string
  failureStrategies?: Partial<SceneFailureStrategiesV2>
  tacticsAlreadyFailed?: string[]
  escalation?: Partial<SceneEscalationV2>
  pressureEscalation?: string
  choice?: Partial<SceneChoiceV2>
  cost?: Partial<SceneCostV2>
  choiceCost?: string
  turn?: Partial<SceneTurnV2>
  valueShift?: Partial<SceneValueShiftV2>
  revelationAndInterpretation?: string
  readerStateDelta?: Partial<ReaderKnowledgeDeltaV2>
  readerCharacterKnowledge?: SceneKnowledgeDeltaV2
  characterKnowledgeDelta?: CharacterKnowledgeDeltaV2[]
  relationshipDelta?: SceneRelationshipDeltaV2[]
  threadsToAdvance?: string[]
  threadsNotToResolve?: string[]
  exitVector?: Partial<SceneExitVectorV2>
  hardConstraints?: SceneConstraintV2[]
  softIntent?: SceneSoftIntentV2[]
  sourceHash?: string | null
}

export interface SceneContractV2Validation {
  ok: boolean
  errors: string[]
  hardCount: number
  softCount: number
  hashValid: boolean
}

export type ExactSpanUnit = 'utf16' | 'codepoint'

export interface ExactTextSpan {
  startUtf16: number
  endUtf16: number
  startCodePoint: number
  endCodePoint: number
  text: string
  textHash: string
  start?: number
  end?: number
  startCp?: number
  endCp?: number
}

export interface DramaticRevisionTarget {
  targetId: string
  allowedSpan: ExactTextSpan
  objective: string
  issueCodes: string[]
}

export type DramaticImpact = 'blocking' | 'major' | 'minor' | 'advisory'

export type DramaticIssueCode =
  | 'hard_constraint_violation'
  | 'knowledge_boundary_violation'
  | 'scene_function_missing'
  | 'dramatic_question_unresolved'
  | 'choice_missing'
  | 'choice_cost_missing'
  | 'turn_missing'
  | 'value_shift_missing'
  | 'exit_vector_missing'
  | 'repeated_scene_pattern'
  | 'soft_intent_drift'
  | 'localized_revision_required'

export interface DramaticCriticIssue {
  issueId: string
  code: DramaticIssueCode
  span: ExactTextSpan
  impact: DramaticImpact
  mustPreserveSpans: ExactTextSpan[]
  revisionTargets: DramaticRevisionTarget[]
}

export interface DramaticCriticReport {
  schemaVersion: typeof DRAMATIC_CRITIC_SCHEMA_VERSION
  candidateHash: string
  contractHash: string
  issues: DramaticCriticIssue[]
  mustPreserveSpans: ExactTextSpan[]
  revisionTargets: DramaticRevisionTarget[]
}

export interface LocalRevision {
  revisionId: string
  targetId?: string
  span: ExactTextSpan
  replacement: string
  sourceHash?: string
}

export type LocalRevisionErrorCode =
  | 'revision_source_hash_mismatch'
  | 'revision_candidate_hash_mismatch'
  | 'revision_span_invalid'
  | 'revision_span_hash_mismatch'
  | 'revision_target_out_of_bounds'
  | 'revision_target_overlap'
  | 'revision_must_preserve_violation'
  | 'revision_allowed_span_missing'
  | 'revision_must_preserve_overlap'

export interface LocalRevisionFailure {
  ok: false
  error: LocalRevisionErrorCode
  text: string
  contentHash: string
}

export interface LocalRevisionSuccess {
  ok: true
  text: string
  contentHash: string
  changed: boolean
  appliedRevisionIds: string[]
}

export type LocalRevisionResult = LocalRevisionFailure | LocalRevisionSuccess

export interface ReorientationIntentV2 {
  sceneFunction?: SceneFunctionV2 | null
  chapterObjective: string
  agencyFocus: string
  pressureToEscalate: string
  payoffToAdvance?: string | null
  nextIrreversibleChoice: string
  avoidRepeating?: string[]
}

export interface ReorientationInputV2 {
  storyId?: string
  chapterId?: string
  completedSceneCount: number
  lastReorientationScene?: number
  sceneIds?: string[]
  priorIntent?: ReorientationIntentV2 | null
  chapterObjective?: string
  agencyFocus?: string
  pressureToEscalate?: string
  payoffToAdvance?: string | null
  nextIrreversibleChoice?: string
  avoidRepeating?: string[]
  acceptedSceneHashes?: string[]
}

export interface ReorientationFutureWindowV2 {
  minScenes: number
  maxScenes: number
}

export interface ReorientationPlanV2 {
  schemaVersion: typeof REORIENTATION_SCHEMA_VERSION
  due: boolean
  overdue: boolean
  afterScene: number
  sourceSceneIds: string[]
  sourceSceneHashes: string[]
  futureWindow: ReorientationFutureWindowV2
  futureIntent: ReorientationIntentV2 | null
  inputHash: string
  planHash: string
}

export interface Wp7DisabledResult<T> {
  enabled: false
  value: T
}

export function wp7Disabled<T>(value: T): Wp7DisabledResult<T> {
  return { enabled: false, value }
}
