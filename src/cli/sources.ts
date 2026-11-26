import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRepository, type Repository } from '../main/db/repository'
import { runFileEvidence } from '../main/fileEvidenceView'
import type { Emit } from './runtime'

export function readRunSources(repo: Repository, runId: string, rawOffset?: unknown) {
  if (!runId.trim() || !repo.getRun(runId)) throw new Error('运行不存在；用 list 查看任务编号')
  const cursor = rawOffset === undefined ? '0' : String(rawOffset)
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new Error('offset 需要非负整数，请使用上一页返回的位置')
  return { runId, ...runFileEvidence(repo, runId, Number(cursor)) }
}

/** Uses only the saved tool receipts. Reading a citation neither opens the source nor contacts a provider. */
export async function printRunSources(dataDir: string, args: string[], offset: unknown, emit: Emit): Promise<void> {
  if (args.length !== 2) throw new Error('用法：sources RUN [--offset N]')
  const db = path.join(dataDir, 'deepwriter.sqlite')
  try { await fs.access(db) } catch { throw new Error('此数据目录没有运行记录；请指定原来的 --data-dir') }
  const repo = createRepository(db)
  try { await repo.open(); emit('sources', readRunSources(repo, args[1], offset)) }
  finally { repo.close() }
}
