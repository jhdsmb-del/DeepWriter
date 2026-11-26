import { codePointLength, takeCodePoints } from '../../shared/textMetrics'

export interface StreamText {
  text: string
  codePoints: number
  endsWithHighSurrogate: boolean
}

const highSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff
export function streamText(text: string): StreamText {
  return { text, codePoints: codePointLength(text), endsWithHighSurrogate: highSurrogate(text.charCodeAt(text.length - 1)) }
}

/** Count only the new fragment, including a surrogate pair split across SSE
 * events. A writing limit remains Unicode code points, not model tokens.
 * Remember the tail: indexing the accumulated rope may flatten it each time. */
export function appendStreamText(previous: StreamText, delta: string, limit?: number): StreamText & { clipped: boolean } {
  const { text, codePoints } = previous
  if (limit !== undefined && codePoints > limit) {
    return { ...streamText(takeCodePoints(text, limit)), clipped: true }
  }
  const low = delta.charCodeAt(0)
  const joinedPair = previous.endsWithHighSurrogate && low >= 0xdc00 && low <= 0xdfff ? 1 : 0
  const accepted = limit === undefined ? delta : takeCodePoints(delta, Math.max(0, limit - codePoints + joinedPair))
  return {
    text: text + accepted,
    codePoints: codePoints + codePointLength(accepted) - (accepted ? joinedPair : 0),
    endsWithHighSurrogate: accepted ? highSurrogate(accepted.charCodeAt(accepted.length - 1)) : previous.endsWithHighSurrogate,
    clipped: accepted !== delta
  }
}
