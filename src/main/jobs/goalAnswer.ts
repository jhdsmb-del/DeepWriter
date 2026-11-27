import { AGENT_OUTPUT_CONTINUE, AGENT_OUTPUT_PART } from './agentContinuation'

type GoalTurn = { role: string; content: string; turnId?: string; turn_id?: string; planState?: string | null; plan_state?: string | null }

/** Only the accepted stop and its consecutive length-continuation pieces belong
 * to the delivery. Earlier drafts and tool commentary remain in the run history. */
export function goalCandidateTurns<T extends GoalTurn>(turns: readonly T[], candidateTurnId?: string): T[] {
  if (!candidateTurnId) return []
  let at = turns.findIndex(t => (t.turnId ?? t.turn_id) === candidateTurnId && t.role === 'assistant')
  if (at < 0) return []
  const end = at
  while (at >= 2) {
    const marker = turns[at-1], part = turns[at-2]
    if (marker.role !== 'system' || marker.content !== AGENT_OUTPUT_CONTINUE || part.role !== 'assistant' || (part.planState ?? part.plan_state) !== AGENT_OUTPUT_PART) break
    at -= 2
  }
  return turns.slice(at, end+1).filter(t => t.role === 'assistant')
}
