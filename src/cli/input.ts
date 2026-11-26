import { createReadStream } from 'node:fs'
import { TextDecoder } from 'node:util'

export const MAX_PROMPT_CHARS = 1_000_000
const MAX_PROMPT_BYTES = MAX_PROMPT_CHARS * 4

/** Decode once across byte boundaries; never silently replace broken UTF-8. */
export async function readPromptStream(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''; let bytes = 0
  for await (const chunk of stream) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (bytes > MAX_PROMPT_BYTES) throw new Error('输入超过100万字符上限')
    try { text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }) }
    catch { throw new Error('输入必须是有效 UTF-8 文本') }
    if (text.length > MAX_PROMPT_CHARS) throw new Error('输入超过100万字符上限')
  }
  try { text += decoder.decode() } catch { throw new Error('输入必须是有效 UTF-8 文本') }
  return validatePrompt(text)
}

export function validatePrompt(text: string): string {
  if (text.length > MAX_PROMPT_CHARS) throw new Error('输入超过100万字符上限')
  if (text.includes('\0')) throw new Error('输入含 NUL 字节；请使用 UTF-8 文本，不接受二进制或 UTF-16 文件')
  if (!text.trim()) throw new Error('任务或答案不能为空；使用文字、--input UTF-8文件 或管道输入')
  return text.trim()
}

export async function readPrompt(positional: string, inputFile?: string): Promise<string> {
  if (inputFile && positional) throw new Error('--input 不能与任务文字或 --text 同时使用')
  const source = inputFile ?? (positional === '-' || !positional && !process.stdin.isTTY ? '-' : undefined)
  if (source === '-') {
    if (process.stdin.isTTY) throw new Error('标准输入是交互终端；请使用管道输入，或 --input UTF-8文件')
    return readPromptStream(process.stdin)
  }
  if (source) {
    try { return await readPromptStream(createReadStream(source)) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code) throw new Error(`无法读取输入文件（${code}）；请检查路径与读取权限`)
      throw error
    }
  }
  return validatePrompt(positional)
}
