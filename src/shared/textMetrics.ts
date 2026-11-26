// UTF-16 code units already equal code points for BMP text (including Chinese).
const HIGH_SURROGATE = /[\uD800-\uDBFF]/
function isSurrogatePair(text: string, at: number): boolean {
  const hi = text.charCodeAt(at), lo = text.charCodeAt(at + 1)
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff
}

/**
 * User-visible character metrics. JavaScript's String.length counts UTF-16
 * code units, while the writing contract is expressed in Unicode code points.
 */
export function codePointLength(text: string): number {
  let result = text.length
  const first = text.search(HIGH_SURROGATE)
  if (first >= 0) for (let i = first; i + 1 < text.length; i++) {
    if (isSurrogatePair(text, i)) { result--; i++ }
  }
  return result
}

/**
 * Take at most count Unicode code points without splitting a surrogate pair.
 * The input is never padded or otherwise rewritten.
 */
export function takeCodePoints(text: string, count: number): string {
  if (count <= 0 || !text) return ''
  if (!Number.isFinite(count)) return text
  const limit = Math.max(0, Math.floor(count))
  if (limit >= text.length) return text
  const prefix = text.slice(0, limit)
  const first = prefix.search(HIGH_SURROGATE)
  if (first === -1) return prefix
  let end = first, remaining = limit - first
  while (remaining-- > 0 && end < text.length) end += isSurrogatePair(text, end) ? 2 : 1
  return text.slice(0, end)
}

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…'])
const SENTENCE_CLOSER = new Set(['”', '’', '」', '』', '）', ')', '】', ']', '》', '〉'])

export interface NaturalEndingSelection {
  text: string
  endCodePoint: number
  /** true when the selected sentence end falls inside the requested delivery window. */
  withinWindow: boolean
}

/**
 * Select a complete sentence boundary without splitting Unicode code points.
 *
 * A boundary inside [minimum, maximum] is preferred by distance to `target`
 * (ties prefer the slightly longer draft). If none exists, the latest complete
 * sentence no earlier than `fallbackMinimum` is returned so the caller can
 * persist that safe prefix and ask the model for one final closing paragraph.
 * Returning null means the current segment contains no safe sentence boundary.
 */
export function selectNaturalEnding(
  text: string,
  target: number,
  minimum: number,
  maximum: number,
  fallbackMinimum = 0
): NaturalEndingSelection | null {
  const points = Array.from(text)
  const floor = Math.max(0, Math.floor(minimum))
  const ceiling = Math.min(points.length, Math.max(floor, Math.floor(maximum)))
  const desired = Math.min(ceiling, Math.max(floor, Math.floor(target)))
  const fallbackFloor = Math.max(0, Math.floor(fallbackMinimum))
  const boundaries: number[] = []
  for (let i = 0; i < ceiling; i++) {
    if (!SENTENCE_END.has(points[i])) continue
    let end = i + 1
    // Ellipses and closing quotation/bracket marks belong to the same sentence.
    while (end < ceiling && (points[end] === '…' || SENTENCE_CLOSER.has(points[end]))) end++
    boundaries.push(end)
  }
  const inWindow = boundaries.filter((end) => end >= floor && end <= ceiling)
  if (inWindow.length > 0) {
    inWindow.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired) || b - a)
    const endCodePoint = inWindow[0]
    return { text: points.slice(0, endCodePoint).join(''), endCodePoint, withinWindow: true }
  }
  const fallback = boundaries.filter((end) => end >= fallbackFloor && end <= ceiling).at(-1)
  if (fallback === undefined) return null
  return { text: points.slice(0, fallback).join(''), endCodePoint: fallback, withinWindow: false }
}

export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}
