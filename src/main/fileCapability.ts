// ==================== 文件/目录 Capability Registry（任务二） ====================
// renderer 只持有主进程签发的 capId；裸路径字符串不能形成任何授权。
// cap 绑定：realpath（防 junction/symlink 逃逸）、kind、size、source、scope、有效期、剩余次数。

import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import * as path from 'path'

export type CapKind = 'file' | 'dir'
export type CapSource = 'dialog' | 'drop' | 'settings' | 'project'

export interface FileCapability {
  capId: string
  realpath: string
  kind: CapKind
  size: number
  source: CapSource
  sessionScope?: string
  projectScope?: string
  issuedAt: number
  expiresAt: number
  usesLeft: number
}

export interface IssueOptions {
  kind: CapKind
  source: CapSource
  sessionScope?: string
  projectScope?: string
  /** 有效期 ms，默认 10 分钟 */
  ttlMs?: number
  /** 可使用次数，默认 1 */
  uses?: number
}

/** 逐级 realpath（父目录存在性解析，防 junction/symlink 逃逸；不存在返回 null） */
export async function resolveRealpath(p: string): Promise<string | null> {
  let cur = p
  const suffix: string[] = []
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...suffix.reverse())
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      const parent = path.dirname(cur)
      if (parent === cur) return null
      suffix.push(path.basename(cur))
      cur = parent
    }
  }
}

export class FileCapabilityRegistry {
  private caps = new Map<string, FileCapability>()

  constructor(private maxCaps = 500) {}

  /** 签发能力：路径必须存在且类型匹配；返回 cap 列表（失败项跳过并计数） */
  async issue(paths: string[], opts: IssueOptions): Promise<{ caps: FileCapability[]; failed: number }> {
    if (this.caps.size + paths.length > this.maxCaps) this.prune()
    const caps: FileCapability[] = []
    let failed = 0
    for (const p of paths) {
      const real = await resolveRealpath(p)
      if (!real) {
        failed++
        continue
      }
      let st: import('fs').Stats
      try {
        st = await fs.stat(real)
      } catch {
        failed++
        continue
      }
      if (opts.kind === 'file' && !st.isFile()) {
        failed++
        continue
      }
      if (opts.kind === 'dir' && !st.isDirectory()) {
        failed++
        continue
      }
      const now = Date.now()
      const cap: FileCapability = {
        capId: randomBytes(16).toString('hex'),
        realpath: real,
        kind: opts.kind,
        size: st.size,
        source: opts.source,
        sessionScope: opts.sessionScope,
        projectScope: opts.projectScope,
        issuedAt: now,
        expiresAt: now + (opts.ttlMs ?? 10 * 60 * 1000),
        usesLeft: opts.uses ?? 1
      }
      caps.push(cap)
      this.caps.set(cap.capId, cap)
    }
    return { caps, failed }
  }

  /**
   * 解析并核销：校验存在/未过期/次数/范围；消费后 usesLeft-1。
   * 再次 realpath 对比，防止 symlink 在签发后被替换指向其他文件。
   * 校验失败一律返回 null（fail closed）。
   */
  async resolve(capId: string, opts?: { sessionScope?: string; projectScope?: string }): Promise<FileCapability | null> {
    this.prune()
    const cap = this.caps.get(capId)
    if (!cap) return null
    const now = Date.now()
    if (now > cap.expiresAt) {
      this.caps.delete(capId)
      return null
    }
    if (cap.usesLeft <= 0) {
      this.caps.delete(capId)
      return null
    }
    if (opts?.sessionScope && cap.sessionScope && cap.sessionScope !== opts.sessionScope) return null
    if (opts?.projectScope && cap.projectScope && cap.projectScope !== opts.projectScope) return null
    // 目标仍存在且 realpath 未变（防签发后 symlink 替换或文件被删除后路径被复用）
    let cur: string | null = null
    try {
      cur = await fs.realpath(cap.realpath)
    } catch {
      cur = null
    }
    if (!cur || cur !== cap.realpath) {
      this.caps.delete(capId)
      return null
    }
    cap.usesLeft -= 1
    return cap
  }

  /** 按 scope 撤销（切会话/项目清理） */
  revokeScope(scope: { sessionScope?: string; projectScope?: string }): void {
    for (const [id, cap] of this.caps) {
      if (scope.sessionScope && cap.sessionScope === scope.sessionScope) this.caps.delete(id)
      if (scope.projectScope && cap.projectScope === scope.projectScope) this.caps.delete(id)
    }
  }

  clear(): void {
    this.caps.clear()
  }

  get size(): number {
    return this.caps.size
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, cap] of this.caps) {
      if (cap.expiresAt < now || cap.usesLeft <= 0) this.caps.delete(id)
    }
  }
}

export const fileCapabilityRegistry = new FileCapabilityRegistry()
