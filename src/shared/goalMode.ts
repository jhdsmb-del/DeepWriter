/** Optional, frozen ordinary-Agent supervision. Absence preserves legacy execution. */
export type GoalMode = 'guided' | 'autonomous'
export const GOAL_TOOL = 'update_goal'
export const GOAL_EVIDENCE_KIND = 'goal_mode_v1'
export interface GoalEvidence {
  kind: 'tool' | 'answer'
  reference: string
  quote: string
  reason: string
}
export interface GoalOutcome {
  id: string
  description: string
  check: string
  verification: 'answer' | 'tool'
  status: 'pending' | 'done'
  evidence: GoalEvidence[]
}
export interface GoalBlocker {
  kind: 'clarification' | 'missing_input' | 'permission' | 'external'
  reason: string
  nextAction: string
  recommendation?: string
}
export interface GoalSnapshot {
  schemaVersion: 1
  runId: string
  mode: GoalMode
  /** Never replaced by the model's interpretation or a steering reply. */
  objective: string
  status: 'planning' | 'active' | 'reviewing' | 'completed' | 'blocked' | 'stopped' | 'failed'
  outcomes: GoalOutcome[]
  progress: string
  blockedOn?: GoalBlocker
  revision: number
  updatedAt: number
  candidateTurnId?: string
  lastCandidateTurnId?: string
  originalObjectiveReview?: string
  /** Durable supervision watermarks; restart never resets the stall gate. */
  stalledRounds: number
  lastToolCallId?: string
  lastReminder?: string
  reviewAfterTurnSeq?: number
  definedAtTurnSeq?: number
}
export function isGoalModeConfig(config: Record<string, unknown>): boolean {
  return config.runMode === 'agent' && config.longMode !== true && config.planMode !== true &&
    (config.goalMode === 'guided' || config.goalMode === 'autonomous')
}
export function readGoalSnapshot(json: string): GoalSnapshot | null {
  try {
    const x = JSON.parse(json) as GoalSnapshot
    if (x.schemaVersion !== 1 || typeof x.runId !== 'string' || !['guided', 'autonomous'].includes(x.mode) ||
      typeof x.objective !== 'string' || !x.objective.trim() || !['planning','active','reviewing','completed','blocked','stopped','failed'].includes(x.status) ||
      !Array.isArray(x.outcomes) || x.outcomes.length > 20 || typeof x.progress !== 'string' ||
      !Number.isSafeInteger(x.revision) || x.revision < 0 || !Number.isSafeInteger(x.updatedAt) ||
      !Number.isSafeInteger(x.stalledRounds) || x.stalledRounds < 0) return null
    if (x.outcomes.some(o => !o || typeof o.id !== 'string' || typeof o.description !== 'string' || typeof o.check !== 'string' ||
      !['answer','tool'].includes(o.verification) || !['pending','done'].includes(o.status) || !Array.isArray(o.evidence) ||
      o.evidence.some(e => !e || !['tool','answer'].includes(e.kind) || typeof e.reference !== 'string' || typeof e.quote !== 'string' || typeof e.reason !== 'string'))) return null
    if (x.blockedOn && (!['clarification','missing_input','permission','external'].includes(x.blockedOn.kind) || typeof x.blockedOn.reason !== 'string' || typeof x.blockedOn.nextAction !== 'string')) return null
    return x
  } catch { return null }
}
