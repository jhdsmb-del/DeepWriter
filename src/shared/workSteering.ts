export const WORK_STEERING_MAX_CHARS = 8000
// Length framing makes arbitrary safe IDs unambiguous across runs.
export const workSteeringTurnPrefix = (runId: string): string => 'steer_' + runId.length + '_' + runId + '_'
export interface WorkSteeringInput { runId: string; sessionId: string; requestId: string; text: string }
export interface WorkSteeringMessage extends WorkSteeringInput {
  schemaVersion: 1
  sequence: number
  status: 'pending' | 'applied'
  createdAt: number
  appliedAt?: number
  turnId?: string
}
export interface WorkSteeringView {
  runId: string
  sessionId: string
  runStatus: string
  messages: WorkSteeringMessage[]
}
export function isWorkSteeringConfig(config: Record<string, unknown>): boolean {
  return config.runMode === 'agent' && config.longMode !== true && config.planMode !== true
}
