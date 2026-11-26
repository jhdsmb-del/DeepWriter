import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code }

async function publishExclusive(temp: string, target: string): Promise<void> {
  try { await fs.link(temp, target) }
  catch (error) {
    if (process.platform !== 'win32' || !['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'UNKNOWN'].includes(code(error) ?? '')) throw error
    // FAT/exFAT do not implement hard links. The two-argument .NET Move is
    // same-volume and refuses an existing target, unlike fs.rename on Windows.
    const command = "try { [IO.File]::Move($env:DW_MANUSCRIPT_TEMP,$env:DW_MANUSCRIPT_DEST) } catch { if ($_.Exception.GetBaseException() -is [IO.IOException] -and [IO.File]::Exists($env:DW_MANUSCRIPT_DEST)) { exit 73 }; exit 1 }"
    try {
      await promisify(execFile)(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, DW_MANUSCRIPT_TEMP: temp, DW_MANUSCRIPT_DEST: target } })
    } catch (cause) {
      if ((cause as { code?: number }).code === 73) throw Object.assign(new Error('输出文件已存在'), { code: 'EEXIST' })
      throw cause
    }
  }
}

/** Link or move a fully synced file into place. An existing target always wins. */
export async function publishUtf8Exclusive(target: string, content: string): Promise<void> {
  const temp = path.join(path.dirname(target), `.dw-${randomUUID()}.tmp`)
  const handle = await fs.open(temp, 'wx', 0o600)
  try {
    try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
    await publishExclusive(temp, target)
  } finally {
    try { await fs.unlink(temp) } catch (error) { if (code(error) !== 'ENOENT') throw error }
  }
}
