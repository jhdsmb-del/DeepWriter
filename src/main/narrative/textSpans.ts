import { createHash } from 'node:crypto'
import type { ExactTextSpan } from '../../shared/narrativeV2'

export function textHashUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function contentHash(value: string): string {
  return textHashUtf8(value)
}

export function codePointLength(value: string): number {
  return Array.from(value).length
}

export function utf16ToCodePointOffset(value: string, utf16Offset: number): number {
  if (!Number.isInteger(utf16Offset) || utf16Offset < 0 || utf16Offset > value.length) throw new Error('span_utf16_offset_invalid')
  return Array.from(value.slice(0, utf16Offset)).length
}

function isCodePointBoundary(value: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > value.length) return false
  if (offset === 0 || offset === value.length) return true
  const previous = value.charCodeAt(offset - 1)
  const current = value.charCodeAt(offset)
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff)
}

export function makeExactTextSpan(value: string, startUtf16: number, endUtf16: number): ExactTextSpan {
  if (!isCodePointBoundary(value, startUtf16) || !isCodePointBoundary(value, endUtf16) || endUtf16 < startUtf16) throw new Error('span_boundary_invalid')
  const text = value.slice(startUtf16, endUtf16)
  const startCodePoint = utf16ToCodePointOffset(value, startUtf16)
  const endCodePoint = utf16ToCodePointOffset(value, endUtf16)
  return {
    startUtf16,
    endUtf16,
    startCodePoint,
    endCodePoint,
    start: startUtf16,
    end: endUtf16,
    startCp: startCodePoint,
    endCp: endCodePoint,
    text,
    textHash: textHashUtf8(text)
  }
}

function numeric(value: unknown): number | null {
  return Number.isInteger(value) ? Number(value) : null
}

export function spanOffsets(span: Partial<ExactTextSpan> & { start?: unknown; end?: unknown }): { start: number; end: number } | null {
  const start = numeric(span.startUtf16 ?? span.start)
  const end = numeric(span.endUtf16 ?? span.end)
  return start !== null && end !== null ? { start, end } : null
}

export function validateExactTextSpan(value: string, span: unknown): span is ExactTextSpan {
  if (!span || typeof span !== 'object') return false
  const candidate = span as Partial<ExactTextSpan> & { start?: unknown; end?: unknown }
  const offsets = spanOffsets(candidate)
  if (!offsets || offsets.start < 0 || offsets.end < offsets.start || offsets.end > value.length) return false
  if (!isCodePointBoundary(value, offsets.start) || !isCodePointBoundary(value, offsets.end)) return false
  const expected = value.slice(offsets.start, offsets.end)
  if (typeof candidate.text !== 'string' || candidate.text !== expected) return false
  if (typeof candidate.textHash !== 'string' || candidate.textHash !== textHashUtf8(expected)) return false
  const startCp = utf16ToCodePointOffset(value, offsets.start)
  const endCp = utf16ToCodePointOffset(value, offsets.end)
  if (candidate.start !== undefined && candidate.start !== offsets.start) return false
  if (candidate.end !== undefined && candidate.end !== offsets.end) return false
  if (candidate.startCodePoint !== undefined && candidate.startCodePoint !== startCp) return false
  if (candidate.endCodePoint !== undefined && candidate.endCodePoint !== endCp) return false
  if (candidate.startCp !== undefined && candidate.startCp !== startCp) return false
  if (candidate.endCp !== undefined && candidate.endCp !== endCp) return false
  return true
}

export function normalizeExactTextSpan(value: string, span: unknown): ExactTextSpan | null {
  if (!span || typeof span !== 'object') return null
  const candidate = span as Partial<ExactTextSpan> & { start?: unknown; end?: unknown }
  const offsets = spanOffsets(candidate)
  if (!offsets || offsets.start < 0 || offsets.end < offsets.start || offsets.end > value.length) return null
  try {
    const exact = makeExactTextSpan(value, offsets.start, offsets.end)
    return validateExactTextSpan(value, span) ? exact : null
  } catch {
    return null
  }
}

export function spanContains(container: ExactTextSpan, nested: ExactTextSpan): boolean {
  return container.startUtf16 <= nested.startUtf16 && nested.endUtf16 <= container.endUtf16
}

export function spanIntersects(left: ExactTextSpan, right: ExactTextSpan): boolean {
  return left.startUtf16 < right.endUtf16 && right.startUtf16 < left.endUtf16
}

export function spanEquals(left: ExactTextSpan, right: ExactTextSpan): boolean {
  return left.startUtf16 === right.startUtf16 && left.endUtf16 === right.endUtf16 && left.textHash === right.textHash
}

export function spanForNeedle(value: string, needle: string, fromUtf16 = 0): ExactTextSpan | null {
  if (!needle) return null
  const start = value.indexOf(needle, Math.max(0, fromUtf16))
  return start < 0 ? null : makeExactTextSpan(value, start, start + needle.length)
}

export function wholeTextSpan(value: string): ExactTextSpan {
  return makeExactTextSpan(value, 0, value.length)
}
