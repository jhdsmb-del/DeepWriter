import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { createRepository } from '../main/db/repository'
import { createCheckpointStore } from '../main/checkpoint'
import type { CliOptions } from './config'
import { acquireCliLock, type Emit } from './runtime'
import { changesFor, undoEdit } from './changes'
import { required } from './arguments'

/** Local author actions need directory preferences, not a valid model, endpoint
 * or credential. Never recover roots from the old run as fresh authorization. */
async function currentRoots(dataDir: string, options: CliOptions): Promise<{ workDir: string; docDir: string }> {
  let saved: Record<string, unknown> = {}
  try {
    const text = await fs.readFile(typeof options.config === 'string' ? path.resolve(options.config) : path.join(dataDir, 'config.json'), 'utf8')
    if (text.length > 64_000) throw new Error('CLI 配置文件过大')
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new Error('CLI 配置 JSON 无效（不显示源内容）') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CLI 配置必须为 JSON 对象')
    saved = parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.config) throw error
  }
  const directory = (name: 'workDir' | 'docDir', flag: string, fallback: string): string => {
    const value = options[flag] ?? saved[name] ?? fallback
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${flag} 必须为有效目录路径`)
    return path.resolve(value)
  }
  return { workDir: directory('workDir', 'work-dir', process.cwd()), docDir: directory('docDir', 'doc-dir', path.join(dataDir, 'documents')) }
}

/** Provider-free entry point. Undo holds the usual execution lock; listing
 * only projects receipts and does not read manuscript content. */
export async function runLocalEdits(command: 'changes' | 'undo-edit', args: string[], dataDir: string, options: CliOptions, emit: Emit): Promise<void> {
  if (args.length !== (command === 'changes' ? 2 : 3)) throw new Error(command === 'changes' ? '用法：changes RUN' : '用法：undo-edit RUN TOOL')
  const runId = required(args[1], 'RUN')
  const dbPath = path.join(dataDir, 'deepwriter.sqlite')
  try { await fs.access(dbPath) } catch { throw new Error('此数据目录没有运行记录；请指定原来的 --data-dir') }
  const release = command === 'undo-edit' ? await acquireCliLock(dataDir) : async () => undefined
  const repo = createRepository(dbPath)
  try {
    await repo.open()
    if (!repo.getRun(runId)) throw new Error('运行不存在；用 list 查看运行编号')
    if (command === 'changes') {
      const result = changesFor(repo, [runId])
      // The printed command must reopen this history, not a new default DB.
      const context = ['--data-dir', dataDir]
      for (const flag of ['config', 'work-dir', 'doc-dir']) if (typeof options[flag] === 'string') context.push('--' + flag, path.resolve(options[flag] as string))
      for (const change of result.changes) if (change.undo?.command) {
        const ids = [change.runId, change.toolCallId]
        change.undo.command = ids.some(id => id.startsWith('--'))
          ? ['undo-edit', ...context, '--', ...ids] : [...change.undo.command, ...context]
      }
      emit('changes', result)
    }
    else {
      required(args[2], 'TOOL')
      // Keep the established CLI checkpoint root, including its historical
      // nested checkpoints directory. The shared service reads the snapshot.
      const result = await undoEdit(repo, createCheckpointStore(path.join(dataDir, 'checkpoints')), await currentRoots(dataDir, options), runId, args[2])
      emit('undo_edit', { runId, toolCallId: args[2], ...result })
      process.exitCode = result.ok ? 0 : 2
    }
  } finally { try { repo.close() } finally { await release() } }
}
