import type {
  DramaticRevisionTarget,
  ExactTextSpan,
  LocalRevision,
  LocalRevisionErrorCode,
  LocalRevisionResult,
  Wp7FeatureFlags
} from '../../shared/narrativeV2'
import { resolveWp7FeatureFlags } from '../../shared/narrativeV2'
import { contentHash, normalizeExactTextSpan, spanContains, spanIntersects } from './textSpans'

export interface LocalizedRevisionInput {
  originalText: string
  revisions: LocalRevision[]
  allowedRevisionSpans?: Array<ExactTextSpan | DramaticRevisionTarget>
  mustPreserveSpans?: ExactTextSpan[]
  expectedSourceHash?: string
  sourceHash?: string
  expectedCandidateHash?: string
  candidateHash?: string
}

function failure(originalText: string, error: LocalRevisionErrorCode): LocalRevisionResult {
  return { ok: false, error, text: originalText, contentHash: contentHash(originalText) }
}

function targetSpan(value: ExactTextSpan | DramaticRevisionTarget): unknown {
  if (value && typeof value === 'object' && 'allowedSpan' in value) return value.allowedSpan
  return value
}

function distinctSpans(spans: ExactTextSpan[]): ExactTextSpan[] {
  return spans.filter((span, index, all) => all.findIndex((candidate) => candidate.startUtf16 === span.startUtf16 && candidate.endUtf16 === span.endUtf16) === index)
}

function verifyHash(value: string, expected: string | undefined): boolean {
  return expected === undefined || expected === contentHash(value)
}

function normalizeSpans(value: string, spans: unknown[]): ExactTextSpan[] | null {
  const normalized: ExactTextSpan[] = []
  for (const span of spans) {
    const exact = normalizeExactTextSpan(value, span)
    if (!exact) return null
    normalized.push(exact)
  }
  return distinctSpans(normalized)
}

function applyLocalizedRevisionCore(input: LocalizedRevisionInput): LocalRevisionResult {
  const originalText = input.originalText
  const expectedHash = input.expectedSourceHash ?? input.sourceHash ?? input.expectedCandidateHash ?? input.candidateHash
  if (!verifyHash(originalText, expectedHash)) return failure(originalText, 'revision_source_hash_mismatch')

  const allowed = normalizeSpans(originalText, (input.allowedRevisionSpans ?? []).map(targetSpan))
  const preserved = normalizeSpans(originalText, input.mustPreserveSpans ?? [])
  if (!allowed) return failure(originalText, 'revision_allowed_span_missing')
  if (!preserved) return failure(originalText, 'revision_span_invalid')
  for (let i = 0; i < allowed.length; i += 1) {
    for (let j = i + 1; j < allowed.length; j += 1) {
      if (spanIntersects(allowed[i]!, allowed[j]!)) return failure(originalText, 'revision_target_overlap')
    }
  }
  for (let i = 0; i < preserved.length; i += 1) {
    for (let j = i + 1; j < preserved.length; j += 1) {
      if (spanIntersects(preserved[i]!, preserved[j]!)) return failure(originalText, 'revision_must_preserve_overlap')
    }
  }

  const ranges: Array<{ revision: LocalRevision; span: ExactTextSpan }> = []
  for (const revision of input.revisions ?? []) {
    if (!revision || typeof revision !== 'object' || typeof revision.revisionId !== 'string' || typeof revision.replacement !== 'string') return failure(originalText, 'revision_span_invalid')
    const span = normalizeExactTextSpan(originalText, revision.span)
    if (!span) return failure(originalText, 'revision_span_hash_mismatch')
    if (revision.sourceHash !== undefined && revision.sourceHash !== contentHash(originalText)) return failure(originalText, 'revision_source_hash_mismatch')
    const containing = allowed.find((candidate) => spanContains(candidate, span))
    if (!containing) return failure(originalText, 'revision_target_out_of_bounds')
    if (preserved.some((candidate) => spanIntersects(candidate, span))) return failure(originalText, 'revision_must_preserve_violation')
    ranges.push({ revision, span })
  }
  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      if (spanIntersects(ranges[i]!.span, ranges[j]!.span)) return failure(originalText, 'revision_target_overlap')
    }
  }
  if (ranges.length === 0) return { ok: true, text: originalText, contentHash: contentHash(originalText), changed: false, appliedRevisionIds: [] }

  const sorted = [...ranges].sort((left, right) => right.span.startUtf16 - left.span.startUtf16 || right.span.endUtf16 - left.span.endUtf16)
  let text = originalText
  for (const entry of sorted) text = `${text.slice(0, entry.span.startUtf16)}${entry.revision.replacement}${text.slice(entry.span.endUtf16)}`
  return {
    ok: true,
    text,
    contentHash: contentHash(text),
    changed: text !== originalText,
    appliedRevisionIds: ranges.map((entry) => entry.revision.revisionId)
  }
}

export function applyLocalizedRevision(input: LocalizedRevisionInput): LocalRevisionResult {
  return applyLocalizedRevisionCore(input)
}

export const applyLocalRevision = applyLocalizedRevision
export const applyDramaticRevisions = applyLocalizedRevision
export const applyRevisionTargets = applyLocalizedRevision

export function runLocalizedRevision(input: LocalizedRevisionInput, flags?: Partial<Wp7FeatureFlags> | null): LocalRevisionResult {
  const resolved = resolveWp7FeatureFlags(flags)
  if (!resolved.localizedRevision) return { ok: true, text: input.originalText, contentHash: contentHash(input.originalText), changed: false, appliedRevisionIds: [] }
  return applyLocalizedRevisionCore(input)
}

export function revisionApplicationIsFailClosed(result: LocalRevisionResult, originalText: string): boolean {
  return result.ok || (result.text === originalText && result.contentHash === contentHash(originalText))
}
