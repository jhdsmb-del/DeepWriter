import type {
  DramaticCriticIssue,
  DramaticCriticReport,
  DramaticImpact,
  DramaticIssueCode,
  DramaticRevisionTarget,
  ExactTextSpan,
  SceneContractV2,
  Wp7FeatureFlags
} from '../../shared/narrativeV2'
import { DRAMATIC_CRITIC_SCHEMA_VERSION, resolveWp7FeatureFlags } from '../../shared/narrativeV2'
import { contentHash, makeExactTextSpan, normalizeExactTextSpan, spanContains, spanForNeedle, spanIntersects, wholeTextSpan } from './textSpans'

export interface DramaticCriticInput {
  candidate: string
  contract: SceneContractV2
  mustPreserveSpans?: ExactTextSpan[]
  allowedRevisionSpans?: ExactTextSpan[]
}

interface SentencePart {
  span: ExactTextSpan
  normalized: string
}

function sentenceParts(value: string): SentencePart[] {
  const parts: SentencePart[] = []
  const matcher = /[^。！？!?\n]+[。！？!?]?/gu
  for (const match of value.matchAll(matcher)) {
    const raw = match[0] ?? ''
    const start = match.index ?? 0
    const leftTrim = raw.search(/\S/u)
    const rightTrim = raw.search(/\s*$/u)
    const startUtf16 = start + Math.max(0, leftTrim)
    const endUtf16 = start + Math.max(startUtf16 - start, rightTrim < 0 ? raw.length : rightTrim)
    if (endUtf16 <= startUtf16) continue
    const span = makeExactTextSpan(value, startUtf16, endUtf16)
    parts.push({ span, normalized: span.text.replace(/[\s“”「」『』"']/gu, '').toLocaleLowerCase() })
  }
  return parts.length > 0 ? parts : [{ span: wholeTextSpan(value), normalized: value.replace(/\s/gu, '') }]
}

function containsSignal(candidate: string, desired: string): boolean {
  const text = desired.replace(/\s+/gu, '').trim()
  if (!text) return true
  if (candidate.includes(text)) return true
  const tokens = text.split(/[，。！？、；：,!?;:\s]+/u).filter((token) => token.length >= 2)
  return tokens.length > 0 && tokens.some((token) => candidate.includes(token))
}

function firstMissingSpan(candidate: string, desired: string): ExactTextSpan {
  const parts = sentenceParts(candidate)
  const best = parts.find((part) => part.span.text.trim().length > 0)
  return best?.span ?? wholeTextSpan(candidate)
}

function issueImpact(code: DramaticIssueCode): DramaticImpact {
  if (code === 'hard_constraint_violation' || code === 'knowledge_boundary_violation') return 'blocking'
  if (code === 'choice_missing' || code === 'choice_cost_missing' || code === 'turn_missing' || code === 'value_shift_missing' || code === 'dramatic_question_unresolved' || code === 'exit_vector_missing') return 'major'
  if (code === 'repeated_scene_pattern') return 'minor'
  return 'advisory'
}

function issueObjective(code: DramaticIssueCode): string {
  return `revise:${code}`
}

function preserveSpans(candidate: string, input: DramaticCriticInput): ExactTextSpan[] {
  const result: ExactTextSpan[] = []
  for (const span of input.mustPreserveSpans ?? []) {
    const exact = normalizeExactTextSpan(candidate, span)
    if (exact && !result.some((item) => item.startUtf16 === exact.startUtf16 && item.endUtf16 === exact.endUtf16)) result.push(exact)
  }
  for (const constraint of input.contract.hardConstraints) {
    if (constraint.kind !== 'must_preserve' || !constraint.statement) continue
    const exact = spanForNeedle(candidate, constraint.statement)
    if (exact && !result.some((item) => item.startUtf16 === exact.startUtf16 && item.endUtf16 === exact.endUtf16)) result.push(exact)
  }
  return result.sort((a, b) => a.startUtf16 - b.startUtf16 || a.endUtf16 - b.endUtf16)
}

function revisionTarget(input: DramaticCriticInput, span: ExactTextSpan, code: DramaticIssueCode): DramaticRevisionTarget | null {
  const exactSpan = normalizeExactTextSpan(input.candidate, span)
  if (!exactSpan) return null
  let allowed: ExactTextSpan | null = null
  if (input.allowedRevisionSpans === undefined) {
    allowed = exactSpan
  } else {
    for (const candidate of input.allowedRevisionSpans) {
      const exactCandidate = normalizeExactTextSpan(input.candidate, candidate)
      if (exactCandidate && spanContains(exactCandidate, exactSpan)) {
        allowed = exactCandidate
        break
      }
    }
  }
  if (!allowed) return null
  return {
    targetId: `target:${code}:${exactSpan.startUtf16}:${exactSpan.endUtf16}`,
    allowedSpan: allowed,
    objective: issueObjective(code),
    issueCodes: [code]
  }
}

function addIssue(out: DramaticCriticIssue[], input: DramaticCriticInput, code: DramaticIssueCode, span: ExactTextSpan, preserved: ExactTextSpan[]): void {
  const target = revisionTarget(input, span, code)
  const issue: DramaticCriticIssue = {
    issueId: `issue:${code}:${span.startUtf16}:${span.endUtf16}`,
    code,
    span,
    impact: issueImpact(code),
    mustPreserveSpans: preserved,
    revisionTargets: target ? [target] : []
  }
  if (!out.some((item) => item.issueId === issue.issueId)) out.push(issue)
}

function repeatedIssues(candidate: string, input: DramaticCriticInput, preserved: ExactTextSpan[], out: DramaticCriticIssue[]): void {
  const seen = new Map<string, SentencePart>()
  for (const part of sentenceParts(candidate)) {
    if (part.normalized.length < 8) continue
    const previous = seen.get(part.normalized)
    if (previous && !spanIntersects(previous.span, part.span)) addIssue(out, input, 'repeated_scene_pattern', part.span, preserved)
    else if (!previous) seen.set(part.normalized, part)
  }
}

function addFieldIssue(candidate: string, input: DramaticCriticInput, code: DramaticIssueCode, value: string, preserved: ExactTextSpan[], out: DramaticCriticIssue[]): void {
  if (!value || containsSignal(candidate, value)) return
  addIssue(out, input, code, firstMissingSpan(candidate, value), preserved)
}

function buildIssues(input: DramaticCriticInput): { issues: DramaticCriticIssue[]; preserved: ExactTextSpan[] } {
  const preserved = preserveSpans(input.candidate, input)
  const issues: DramaticCriticIssue[] = []
  for (const constraint of input.contract.hardConstraints) {
    if (!constraint.statement) continue
    const contains = input.candidate.includes(constraint.statement)
    if (constraint.kind === 'forbidden' && contains) {
      const exact = spanForNeedle(input.candidate, constraint.statement) ?? wholeTextSpan(input.candidate)
      addIssue(issues, input, 'hard_constraint_violation', exact, preserved)
    }
    if (constraint.kind === 'knowledge_boundary' && contains && /(?:不得|不能|不知道|未知|禁止)/u.test(constraint.statement)) {
      const exact = spanForNeedle(input.candidate, constraint.statement) ?? wholeTextSpan(input.candidate)
      addIssue(issues, input, 'knowledge_boundary_violation', exact, preserved)
    }
    if (constraint.kind === 'required' && !containsSignal(input.candidate, constraint.statement)) {
      addIssue(issues, input, 'hard_constraint_violation', firstMissingSpan(input.candidate, constraint.statement), preserved)
    }
  }
  addFieldIssue(input.candidate, input, 'choice_missing', input.contract.choice.action, preserved, issues)
  addFieldIssue(input.candidate, input, 'choice_cost_missing', input.contract.cost.immediate, preserved, issues)
  addFieldIssue(input.candidate, input, 'turn_missing', input.contract.turn.to, preserved, issues)
  addFieldIssue(input.candidate, input, 'value_shift_missing', input.contract.valueShift.to, preserved, issues)
  addFieldIssue(input.candidate, input, 'dramatic_question_unresolved', input.contract.dramaticQuestion, preserved, issues)
  addFieldIssue(input.candidate, input, 'exit_vector_missing', input.contract.exitVector.nextPressure, preserved, issues)
  if (input.contract.sceneFunction === 'other') addIssue(issues, input, 'scene_function_missing', firstMissingSpan(input.candidate, input.contract.sceneFunction), preserved)
  repeatedIssues(input.candidate, input, preserved, issues)
  return { issues, preserved }
}

export function buildDramaticCritic(input: DramaticCriticInput): DramaticCriticReport {
  const { issues, preserved } = buildIssues(input)
  const revisionTargets = issues.flatMap((issue) => issue.revisionTargets)
  const dedupTargets = revisionTargets.filter((target, index, all) => all.findIndex((item) => item.targetId === target.targetId) === index)
  return {
    schemaVersion: DRAMATIC_CRITIC_SCHEMA_VERSION,
    candidateHash: contentHash(input.candidate),
    contractHash: input.contract.frozenHash,
    issues,
    mustPreserveSpans: preserved,
    revisionTargets: dedupTargets
  }
}

export const runDramaticCriticCore = buildDramaticCritic
export const evaluateDramaticCritic = buildDramaticCritic

export function runDramaticCritic(input: DramaticCriticInput, flags?: Partial<Wp7FeatureFlags> | null): DramaticCriticReport {
  const resolved = resolveWp7FeatureFlags(flags)
  if (!resolved.dramaticCritic) {
    return {
      schemaVersion: DRAMATIC_CRITIC_SCHEMA_VERSION,
      candidateHash: contentHash(input.candidate),
      contractHash: input.contract.frozenHash,
      issues: [],
      mustPreserveSpans: [],
      revisionTargets: []
    }
  }
  return buildDramaticCritic(input)
}

export function criticOnlyProducesLocalDiagnostics(report: DramaticCriticReport): boolean {
  return report.issues.every((issue) => Boolean(issue.code) && Boolean(issue.span) && Boolean(issue.impact) && Array.isArray(issue.mustPreserveSpans) && Array.isArray(issue.revisionTargets))
}
