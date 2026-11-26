import type { LegacyManuscriptBackfillSource, LegacyManuscriptBackfillState, ManuscriptSegment } from '../shared/types'
import { codePointLength } from '../shared/textMetrics'
import type { RunRecord, TurnRecord } from './jobs/types'
import { classifyAssistantOutput, legacyBackfillCompletionMarker, legacyBackfillSourceSummaryHash, makeManuscriptSegment, manuscriptSegmentHash } from './manuscript'

export interface LegacyBackfillArtifact {
  artifactId: string
  hash: string
  charCount: number
  content: string
}

export function legacyBackfillSourceTurns(turns: readonly TurnRecord[]): LegacyManuscriptBackfillSource[] {
  return turns
    .filter((turn) => turn.role === 'assistant' && !turn.toolCallsJson && turn.content.trim())
    .map((turn) => ({
      sourceTurnId: turn.turnId,
      sourceTurnSeq: turn.turnSeq,
      sourceContentHash: manuscriptSegmentHash(turn.content),
      sourceCharCount: codePointLength(turn.content)
    }))
}

export function legacyBackfillSegment(run: Pick<RunRecord, 'runId' | 'sessionId'>, turn: TurnRecord, accepted: boolean): ManuscriptSegment {
  const classified = classifyAssistantOutput(turn.content)
  const content = classified.kind === 'prose' ? classified.content : ''
  return makeManuscriptSegment({
    runId: run.runId,
    sessionId: run.sessionId,
    turnId: turn.turnId,
    segmentId: `${run.runId}:legacy:${turn.turnId}`,
    sourceTurnId: turn.turnId,
    chunkIndex: turn.turnSeq,
    content,
    status: accepted && classified.kind === 'prose' && classified.complete
      ? 'accepted'
      : classified.kind === 'prose'
        ? (classified.complete ? 'candidate' : 'partial')
        : 'rejected',
    kind: classified.kind,
    createdAt: turn.createdAt
  })
}

export function buildLegacyBackfillPlan(
  run: Pick<RunRecord, 'runId' | 'sessionId' | 'status'>,
  turns: readonly TurnRecord[],
  artifact: LegacyBackfillArtifact | null,
  timestamp = Date.now()
): { state: LegacyManuscriptBackfillState; segments: ManuscriptSegment[] } {
  const sources = legacyBackfillSourceTurns(turns)
  const sourceIds = new Set(sources.map((source) => source.sourceTurnId))
  const sourceTurns = turns.filter((turn) => sourceIds.has(turn.turnId))
  const classified = sourceTurns.map((turn) => ({ turn, output: classifyAssistantOutput(turn.content) }))
  const proseOutputs = classified.filter((item) => item.output.kind === 'prose')
  const proseComplete = proseOutputs.length > 0 && proseOutputs.every((item) => item.output.complete)
  const proseText = proseOutputs.map((item) => item.output.content).join('')
  const exact = run.status === 'completed' && sources.length > 0 && artifact !== null && proseComplete && proseText === artifact.content
  const verification: LegacyManuscriptBackfillState['verification'] = exact
    ? 'artifact_exact'
    : run.status !== 'completed'
      ? 'active_run'
      : artifact === null
        ? 'artifact_missing'
        : 'source_mismatch'
  const segments = sourceTurns.map((turn) => legacyBackfillSegment(run, turn, exact))
  const acceptedSegmentIds = segments.filter((segment) => segment.status === 'accepted').map((segment) => segment.segmentId)
  const acceptedText = segments.filter((segment) => acceptedSegmentIds.includes(segment.segmentId)).map((segment) => segment.content).join('')
  return {
    state: {
      schemaVersion: 1,
      runId: run.runId,
      status: 'in_progress',
      verification,
      sourceTurns: sources,
      sourceSummaryHash: legacyBackfillSourceSummaryHash(sources),
      expectedSourceCount: sources.length,
      expectedSegmentCount: sources.length,
      expectedAcceptedCharCount: exact ? codePointLength(acceptedText) : 0,
      expectedAcceptedContentHash: exact ? manuscriptSegmentHash(acceptedText) : null,
      expectedArtifactId: artifact?.artifactId ?? null,
      expectedArtifactHash: artifact?.hash ?? null,
      expectedArtifactCharCount: artifact?.charCount ?? null,
      processedSourceTurnIds: [],
      acceptedSegmentIds,
      completionMarker: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    },
    segments
  }
}

export function advanceLegacyBackfillState(state: LegacyManuscriptBackfillState, sourceTurnId: string, timestamp = Date.now()): LegacyManuscriptBackfillState {
  const processedSourceTurnIds = state.processedSourceTurnIds.includes(sourceTurnId)
    ? [...state.processedSourceTurnIds]
    : [...state.processedSourceTurnIds, sourceTurnId]
  const complete = processedSourceTurnIds.length === state.expectedSourceCount &&
    state.sourceTurns.every((source, index) => processedSourceTurnIds[index] === source.sourceTurnId)
  const next: LegacyManuscriptBackfillState = {
    ...state,
    status: complete && state.verification === 'artifact_exact' ? 'complete' : complete ? 'unverified' : 'in_progress',
    processedSourceTurnIds,
    updatedAt: timestamp,
    completedAt: complete ? timestamp : null,
    completionMarker: null
  }
  return next.status === 'complete' ? { ...next, completionMarker: legacyBackfillCompletionMarker(next) } : next
}
