/** Match the ordinary read_file header gate before a search publishes an
 * alleged text hit. A renamed container must not yield an unreadable citation. */
export function isUnsupportedTextHead(head: Buffer): boolean {
  return head.includes(0) || /^(?:%PDF-|PK\x03\x04|MZ|\x7fELF|\x89PNG|GIF8)/u.test(head.toString('latin1'))
}
