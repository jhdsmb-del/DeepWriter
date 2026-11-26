import { buildSceneContractPlan, isOpaqueSceneBeatRequirement } from './narrative/sceneContract'
import type { GrillMeOutline, GrillMeState } from '../shared/grillMe'

/** Advisory only. Uses the real contract compiler; never edits the outline or
 * permits an unbound prose/state commit. Unknown verbs are not hard rejected. */
export function previewGrillOutlineApplicability(state: GrillMeState, outline: GrillMeOutline): { outlineHash: string; scenes: Array<{ sceneId: string; title: string; beats: string[] }> } {
  const plan = buildSceneContractPlan({ outline, outlineRevision: state.outlineRevision,
    answers: state.slots.filter(slot => slot.answer.trim()).map(slot => ({ slotId: slot.id, value: slot.answer, source: slot.source ?? 'assumption' })) })
  return { outlineHash: plan.outlineHash, scenes: plan.contracts.flatMap(contract => {
    // The compiler may retain the entire unparsed phrase as an actor hint.
    // That hint alone is not an observable predicate; keep this advisory.
    const opaque = (contract.requiredBeatEvidence ?? []).filter(isOpaqueSceneBeatRequirement)
    return opaque.length > 0 ? [{ sceneId: contract.sceneId, title: contract.title, beats: opaque.map(beat => beat.source) }] : []
  }) }
}
