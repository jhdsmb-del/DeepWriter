import * as fs from 'node:fs'
import * as path from 'node:path'

const DEFAULT_MAX_BYTES = 256 * 1024
const DEFAULT_MAX_FILES = 3
const MAX_DEPTH = 4
const MAX_KEYS = 40
const MAX_ARRAY_ITEMS = 20
const MAX_STRING_CHARS = 1200
const SENSITIVE_KEY = /^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|body|request[_-]?body|messages|prompt|content)$/iu

export interface DiagnosticRecord {
  type: string
  [key: string]: unknown
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/gu, 'sk-[REDACTED]')
    .replace(/((?:api[_-]?key|authorization)\s*["']?\s*[:=]\s*)[^\s,;"'}]+/giu, '$1[REDACTED]')
    .replace(/((?:\brequest\s*[_-]?\s*body\b|\bbody\b|\bprompt\b|\bmessages\b)\s*["']?\s*[:=]\s*)[\s\S]*$/iu, '$1[REDACTED]')
    .slice(0, MAX_STRING_CHARS)
}

/** Pure, bounded diagnostic serialization: secrets and request-like payloads never enter logs. */
export function sanitizeDiagnosticValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= MAX_DEPTH) return '[TRUNCATED]'
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeDiagnosticValue(item, key, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      out[childKey] = sanitizeDiagnosticValue(childValue, childKey, depth + 1)
    }
    return out
  }
  return String(value)
}

export function formatDiagnosticLine(record: DiagnosticRecord, now = Date.now()): string {
  const safe = sanitizeDiagnosticValue({ ts: now, ...record })
  return `${JSON.stringify(safe)}\n`
}

export interface DiagnosticLoggerOptions {
  dir: string
  maxBytes?: number
  maxFiles?: number
  fileName?: string
}

export interface DiagnosticLogger {
  record(record: DiagnosticRecord): void
  filePath: string
}

function rotate(filePath: string, maxFiles: number): void {
  if (maxFiles <= 1 || !fs.existsSync(filePath)) {
    if (maxFiles <= 1) fs.rmSync(filePath, { force: true })
    return
  }
  for (let i = maxFiles - 2; i >= 1; i--) {
    const from = `${filePath}.${i}`
    const to = `${filePath}.${i + 1}`
    if (!fs.existsSync(from)) continue
    fs.renameSync(from, to)
  }
  fs.renameSync(filePath, `${filePath}.1`)
}

/** Synchronous crash-path logger with bounded size and numbered rotation. */
export function createDiagnosticLogger(options: DiagnosticLoggerOptions): DiagnosticLogger {
  const maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES))
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES))
  const filePath = path.join(options.dir, options.fileName ?? 'app.log')
  return {
    filePath,
    record(record) {
      try {
        const line = formatDiagnosticLine(record)
        fs.mkdirSync(options.dir, { recursive: true })
        const currentBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
        if (currentBytes > 0 && currentBytes + Buffer.byteLength(line, 'utf8') > maxBytes) rotate(filePath, maxFiles)
        fs.appendFileSync(filePath, line, 'utf8')
      } catch {
        // Diagnostics must never become a second crash source.
      }
    }
  }
}

export function describeDiagnosticError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    const stackLines = error.stack?.split(/\r?\n/gu).slice(1).join('\n').trim()
    return { name: error.name, message: error.message, ...(stackLines ? { stack: stackLines } : {}) }
  }
  return { name: 'UnknownError', message: String(error) }
}

/**
 * Shared fatal guard for process-level failures. The first failure is logged and
 * asks Electron to enter its existing quit coordinator; later failures are ignored.
 */
export function createFatalDiagnosticHandler(
  record: (entry: DiagnosticRecord) => void,
  quit: () => void
): (entry: DiagnosticRecord) => void {
  let handled = false
  return (entry) => {
    if (handled) return
    handled = true
    try {
      record(entry)
    } finally {
      try {
        quit()
      } catch {
        // A fatal path must not throw a second exception while requesting quit.
      }
    }
  }
}
