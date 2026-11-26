/** Built-ins whose successful receipt can identify a file actually written. */
export const FILE_WRITE_TOOLS = ['write_file', 'edit_file', 'generate_markdown_doc', 'generate_docx_doc', 'generate_xlsx_doc', 'generate_pdf_doc'] as const

export type ChatFileAnchor =
  | { kind: 'message'; sessionId: string; messageId: string; candidate: string }
  | { kind: 'artifact'; runId: string; artifactId: string }
export interface ChatFileView { candidate: string; path: string; state: 'ready' | 'missing'; canOpen: boolean }
export interface ChatFileActionResult { ok: boolean; message?: string }
export type ChatFileAction = 'open' | 'reveal' | 'copy-absolute'

// Shell-open only passive document/media formats; never scripts, executables,
// shortcuts, HTML, SVG, macro documents or URLs (including file: and UNC).
const passiveFile = /\.(?:md|txt|pdf|docx|xlsx|pptx|csv|tsv|rtf|odt|ods|odp|json|jsonl|ya?ml|toml|ini|log|epub|zip|7z|tar|gz|bz2|xz|png|jpe?g|gif|webp|bmp|mp3|ogg|wav|mp4|webm)$/i
export function chatFileCandidate(value: string): string | null {
  let candidate = value.trim()
  if (!candidate || candidate.length > 2048 || /[\u0000-\u001f<>|"?*]/.test(candidate)) return null
  try { candidate = decodeURIComponent(candidate) } catch { return null }
  if (/^(?:[a-z][\w+.-]*:|[\\/]{2})/i.test(candidate) && !/^[a-z]:[\\/]/i.test(candidate)) return null
  if (candidate.includes(':') && !/^[a-z]:[\\/][^:]+$/i.test(candidate)) return null
  // Other file types can be located/copied only when a successful receipt
  // establishes the exact target. Their extension never authorizes shell-open.
  if (!/\.[a-z0-9]{1,16}$/i.test(candidate) || /[\u0000-\u001f<>|"?*]/.test(candidate)) return null
  return candidate
}

export function chatFileCanOpen(value: string): boolean {
  const candidate = chatFileCandidate(value)
  return candidate !== null && passiveFile.test(candidate)
}

/** Inline code and local Markdown links, excluding fenced code examples. */
export function chatFileCandidates(content: string): string[] {
  const text = content.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, '')
  const found = [...text.matchAll(/`([^`\n]+)`|\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)]
    .map(match => match[1] ?? match[2] ?? match[3]).filter(value => chatFileCandidate(value) !== null)
  return [...new Set(found)].slice(0, 128)
}
