import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback
}

export async function readTextBounded(file: string, maxChars: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(maxChars * 4 + 4)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    signal?.throwIfAborted()
    const decoder = new StringDecoder('utf8')
    const text = decoder.write(buffer.subarray(0, bytesRead))
    return text.slice(0, maxChars)
  } finally {
    await handle.close()
  }
}

// Serialize the final comparison and rename across writes made by this process.
const pendingRenames = new Map<string, Promise<void>>()
async function commitFile(file: string, action: () => Promise<void>): Promise<void> {
  const resolved = path.resolve(file)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const previous = pendingRenames.get(key) ?? Promise.resolve()
  const current = previous.then(action)
  const tail = current.catch(() => {})
  pendingRenames.set(key, tail)
  try { await current } finally { if (pendingRenames.get(key) === tail) pendingRenames.delete(key) }
}

export async function writeTextAtomically(file: string, content: string, signal?: AbortSignal, beforeCommit?: () => Promise<void>): Promise<void> {
  return writeBytesAtomically(file, Buffer.from(content, 'utf8'), signal, beforeCommit)
}

/** Same guarded atomic rename as tool writes; restores retain the exact bytes. */
export async function writeBytesAtomically(file: string, content: Buffer, signal?: AbortSignal, beforeCommit?: () => Promise<void>, requireExisting = false): Promise<void> {
  signal?.throwIfAborted()
  if (!requireExisting) await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = path.join(path.dirname(file), `.deepwriter-${randomUUID()}.tmp`)
  let mode: number | undefined
  try { mode = (await fs.stat(file)).mode } catch (error) {
    if (requireExisting || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    const handle = await fs.open(temp, 'wx', mode)
    try {
      await handle.writeFile(content, { encoding: 'utf8', signal })
      await handle.sync()
    } finally {
      await handle.close()
    }
    signal?.throwIfAborted()
    await commitFile(file, async () => {
      signal?.throwIfAborted()
      await beforeCommit?.()
      signal?.throwIfAborted()
      await fs.rename(temp, file)
    })
  } finally {
    await fs.unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  }
}
