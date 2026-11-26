import type { Interface } from 'node:readline/promises'

export class CliPromptInterrupted extends Error {}

/** readline.question drops extra lines from a pasted chunk while its promise
 * resumes. Keep one line queue for both normal prompts and multi-line input. */
export function createTerminalQuestion(terminal: Interface) {
  const lines: string[] = []
  let closed = false
  let waiting: { resolve: (line: string) => void; reject: (error: Error) => void; cleanup: () => void } | null = null
  terminal.on('line', (line: string) => {
    if (!waiting) { lines.push(line); return }
    const current = waiting; waiting = null
    current.cleanup(); current.resolve(line)
  })
  terminal.on('close', () => {
    closed = true; lines.length = 0
    const current = waiting; waiting = null
    current?.cleanup(); current?.reject(new CliPromptInterrupted('已保存当前状态'))
  })
  const question = (message: string, signal: AbortSignal): Promise<string> => {
    terminal.setPrompt(message ? `${message}\n> ` : '… ')
    terminal.prompt()
    if (closed || signal.aborted) { lines.length = 0; return Promise.reject(new CliPromptInterrupted('已保存当前状态')) }
    if (lines.length) return Promise.resolve(lines.shift()!)
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        lines.length = 0
        const current = waiting; waiting = null
        current?.cleanup(); current?.reject(new CliPromptInterrupted('已保存当前状态'))
      }
      waiting = { resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) }
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  return Object.assign(question, { discardPending: () => { lines.length = 0 } })
}
