import { promises as fs } from 'fs'
import { diffLines } from 'diff'
import * as path from 'path'
import type { FileDiff } from '../shared/types'

export interface CheckpointInfo {
  backupId: string
  path: string
  ts: number
}

export interface CheckpointStore {
  beforeWrite(filePath: string, sessionId: string): Promise<{ backupId: string; existed: boolean }>
  listCheckpoints(sessionId: string): Promise<CheckpointInfo[]>
  restore(backupId: string, sessionId: string, allowedRoots?: string[]): Promise<{ ok: boolean; path: string; message: string }>
  /** Guarded edit undo reads an existing snapshot; it never calls restore(). */
  getUndoRoot?(): Promise<string>
  readForEditUndo?(backupId: string, sessionId: string, targetPath: string, expectedRoot?: string): Promise<Buffer>
  clearSession(sessionId: string): Promise<void>
}

const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_')

const isWithin = (p: string, root: string): boolean => {
  const a = path.resolve(p)
  const r = path.resolve(root)
  return a === r || a.toLowerCase().startsWith(r.toLowerCase() + path.sep)
}

export function createCheckpointStore(baseDir: string): CheckpointStore {
  const sessionDir = (sessionId: string): string => path.join(baseDir, 'checkpoints', safeId(sessionId))

  const encodePath = (filePath: string): string => encodeURIComponent(path.resolve(filePath))

  const decodePath = (encoded: string): string => {
    try {
      return decodeURIComponent(encoded)
    } catch {
      return ''
    }
  }

  return {
    async beforeWrite(filePath, sessionId) {
      const abs = path.resolve(filePath)
      try {
        await fs.access(abs)
      } catch {
        return { backupId: '', existed: false }
      }
      let content: Buffer
      try {
        content = await fs.readFile(abs)
      } catch {
        return { backupId: '', existed: false }
      }
      const dir = sessionDir(sessionId)
      await fs.mkdir(dir, { recursive: true })
      // Preserve the timestamp/path ID format, but never replace another edit's
      // checkpoint when two writes happen in the same millisecond.
      for (let ts = Date.now(); ; ts++) {
        const backupId = `${ts}_${encodePath(abs)}`
        try {
          await fs.writeFile(path.join(dir, `${backupId}.bak`), content, { flag: 'wx' })
          return { backupId, existed: true }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
    },

    getUndoRoot() { return fs.realpath(baseDir) },

    async readForEditUndo(backupId, sessionId, targetPath, expectedRoot) {
      if (expectedRoot && await fs.realpath(baseDir) !== expectedRoot) throw new Error('原稿检查点目录的真实路径已变化')
      const sep = backupId.indexOf('_')
      if (sep <= 0 || !/^\d+$/u.test(backupId.slice(0, sep)) || decodePath(backupId.slice(sep + 1)) !== path.resolve(targetPath)) throw new Error('原稿检查点身份不一致')
      const dir = path.resolve(sessionDir(sessionId))
      const file = path.resolve(dir, `${backupId}.bak`)
      if (path.dirname(file) !== dir || !isWithin(file, baseDir)) throw new Error('原稿检查点标识无效')
      // Deny links within the checkpoint store. The configured base itself
      // may live under a stable user-directory junction.
      for (let current = file; ; current = path.dirname(current)) {
        if (current === path.resolve(baseDir)) break
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('原稿检查点路径包含符号链接')
        if (current === path.dirname(current)) throw new Error('原稿检查点路径无效')
      }
      if (!(await fs.stat(file)).isFile()) throw new Error('原稿检查点不是文件')
      return fs.readFile(file)
    },

    async listCheckpoints(sessionId) {
      const dir = sessionDir(sessionId)
      let entries: string[]
      try {
        entries = await fs.readdir(dir)
      } catch {
        return []
      }
      const out: CheckpointInfo[] = []
      for (const name of entries) {
        if (!name.endsWith('.bak')) continue
        const base = name.slice(0, -4)
        const sep = base.indexOf('_')
        if (sep <= 0) continue
        const ts = Number(base.slice(0, sep))
        const decoded = decodePath(base.slice(sep + 1))
        if (!decoded) continue
        out.push({ backupId: base, path: decoded, ts })
      }
      return out.sort((a, b) => b.ts - a.ts)
    },

    async restore(backupId, sessionId, allowedRoots = [baseDir]) {
      const dir = sessionDir(sessionId)
      const backupFile = path.resolve(dir, `${backupId}.bak`)
      if (!backupFile.toLowerCase().startsWith(dir.toLowerCase() + path.sep)) {
        return { ok: false, path: '', message: '备份标识无效' }
      }
      const sep = backupId.indexOf('_')
      if (sep <= 0) return { ok: false, path: '', message: '备份标识无效' }
      const target = decodePath(backupId.slice(sep + 1))
      if (!target) return { ok: false, path: '', message: '备份标识中的路径无效' }
      if (!allowedRoots.some((r) => isWithin(target, r))) {
        return { ok: false, path: '', message: '目标路径不在允许范围内，已拒绝回滚' }
      }
      let content = ''
      try {
        content = await fs.readFile(backupFile, 'utf-8')
      } catch {
        return { ok: false, path: '', message: '备份文件不存在或已清理' }
      }
      try {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content, 'utf-8')
        return { ok: true, path: target, message: '已从快照恢复' }
      } catch (e) {
        return { ok: false, path: '', message: `恢复失败: ${(e as Error).message}` }
      }
    },

    async clearSession(sessionId) {
      try {
        await fs.rm(sessionDir(sessionId), { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
}

export function makeDiff(oldText: string, newText: string, filePath: string): FileDiff | null {
  if (oldText === newText) return null
  const parts = diffLines(oldText, newText)
  const lines: string[] = [`--- ${filePath}`, `+++ ${filePath}`]
  let added = 0
  let removed = 0
  for (const part of parts) {
    const prefix = part.added ? '+' : part.removed ? '-' : ' '
    const chunk = part.value.replace(/\n$/, '')
    if (chunk === '') continue
    const chunkLines = chunk.split('\n')
    for (const line of chunkLines) {
      lines.push(prefix + line)
      if (part.added) added++
      else if (part.removed) removed++
    }
  }
  return { path: filePath, backupId: '', content: lines.join('\n'), added, removed }
}

let checkpointStore: CheckpointStore | null = null

export function setCheckpointStore(store: CheckpointStore | null): void {
  checkpointStore = store
}

export function getCheckpointStore(): CheckpointStore | null {
  return checkpointStore
}

/**
 * R4.5 Gate 5（复审 S-03）：rollback/checkpoint 恢复边界——只从 run 快照的 workDir/docDir
 * 与固定内部目录生成，禁止混入 currentSettings（运行中修改目录设置不得扩大旧 run 的回滚边界）。
 * 纯函数（快照缺失的异常路径由调用方 fail-closed 决策）。
 */
export function buildRollbackRoots(snapshotDirs: { workDir?: unknown; docDir?: unknown }, fixedDirs: string[]): string[] {
  const dirs = [snapshotDirs.workDir, snapshotDirs.docDir, ...fixedDirs]
  return [...new Set(dirs.filter((d): d is string => typeof d === 'string' && d.length > 0))]
}
