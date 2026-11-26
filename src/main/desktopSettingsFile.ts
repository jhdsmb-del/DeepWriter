import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export function parseSettingsObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ('docDir' in value && typeof value.docDir !== 'string')
    || ('baseUrl' in value && typeof value.baseUrl !== 'string')) throw new Error('设置文件格式无效')
  return value as Record<string, unknown>
}

export async function findSettingsSource(file: string, read: (path: string) => Promise<string>): Promise<string | null> {
  for (const candidate of [file, file + '.bak']) {
    let raw: string
    try { raw = await read(candidate) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    try { parseSettingsObject(raw); return raw } catch { /* try the previous valid document */ }
  }
  return null
}

export function serializeEdits() {
  let prior: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = prior.then(work, work)
    prior = next.then(() => {}, () => {})
    return next
  }
}

/** A reference persisted on disk can only resolve in the process which issued
 * it, for the exact endpoint. A restarted app cannot resurrect a prior key. */
export class SessionCredential {
  private entry?: { ref: string; url: string; key: string }
  prepare(url: string, key: string): { ref: string; commit(): void } {
    const next = this.entry?.url === url && this.entry.key === key ? this.entry : { url, key, ref: randomUUID() }
    return { ref: next.ref, commit: () => { this.entry = next } }
  }
  resolve(url: string, ref: unknown): string {
    return this.entry && this.entry.ref === ref && this.entry.url === url ? this.entry.key : ''
  }
  clear(): void { this.entry = undefined }
}

async function atomicText(file: string, content: string): Promise<void> {
  const temp = path.join(path.dirname(file), '.dw-settings-' + randomUUID() + '.tmp')
  const handle = await fs.open(temp, 'wx', 0o600)
  try {
    try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
    await fs.rename(temp, file)
  } finally { await fs.rm(temp, { force: true }) }
}

/** Rotate only a readable object. Never replace a good recovery file with
 * corrupt primary bytes, or copy a legacy plaintext key into a second file. */
export async function writeSettingsDocument(file: string, stored: Record<string, unknown>, preserveLockedKey = false): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  let previous: string | undefined
  try { previous = await fs.readFile(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (previous !== undefined) {
    let prior: Record<string, unknown> | undefined
    try { prior = parseSettingsObject(previous) } catch { /* retain existing recovery file */ }
    if (prior) {
      if (preserveLockedKey && stored.apiKeyStorage === 'none' && stored.baseUrl === prior.baseUrl && typeof prior.apiKeyEnc === 'string' && prior.apiKeyEnc) {
        stored.apiKeyStorage = 'safeStorage'
        stored.apiKeyEnc = prior.apiKeyEnc
      }
      delete prior.apiKey
      await atomicText(file + '.bak', JSON.stringify(prior, null, 2))
    }
  }
  await atomicText(file, JSON.stringify(stored, null, 2))
}
