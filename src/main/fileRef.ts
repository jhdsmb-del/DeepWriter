import { TEXT_FILE_EXTENSIONS, isProjectTextName } from '../shared/fileFormats'
// ==================== FileRef Registry + Operation Policy（R4-1） ====================
// 替代"单次消耗 capability"：文件身份引用（FileRef）与操作授权分离。
// - renderer 只持有 fileRefId + 显示信息（FileRefView），真实路径永不出主进程；
// - 每次操作（inspect/preview/read-for-model/open/reveal/copy/attach）都经
//   resolveForOperation(refId, op, expectedScope) 重新校验：scope 必填严格相等、
//   引用有效、realpath+stat、按 operation 检查类型/大小/工作区 containment/内容变化；
// - inspect 与菜单展示不消费文件身份；删除附件/结束草稿/切项目显式 revoke；
// - registry 容量为硬上限，超限拒绝并记录审计。

import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import * as path from 'path'

export type FileRefKind = 'file' | 'dir'
export type FileRefSource = 'dialog' | 'drop' | 'artifact' | 'project'
export type FileRefState = 'registered' | 'changed' | 'revoked' | 'expired'

export type FileScope =
  | { kind: 'session'; sessionId: string; draftId: string }
  | { kind: 'run'; sessionId: string; runId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'style-job'; projectId: string; jobId: string }

export type FileOperation =
  | 'inspect'
  | 'preview'
  | 'read-for-model'
  | 'open'
  | 'reveal'
  | 'copy-absolute-path'
  | 'copy-relative-path'
  | 'attach-to-draft'

/** renderer 可见视图：不含任何路径 */
export interface FileRefView {
  fileRefId: string
  displayName: string
  kind: FileRefKind
  size: number
  source: FileRefSource
  state: FileRefState
}

interface FileRefInternal {
  fileRefId: string
  realpath: string
  displayName: string
  kind: FileRefKind
  size: number
  source: FileRefSource
  scope: FileScope
  fingerprint: string // `${size}:${mtimeMs}`
  issuedAt: number
  expiresAt: number
  revoked: boolean
}

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 小时（附件生命周期到草稿/run 结束）
const MAX_REFS = 500

function scopeKey(scope: FileScope): string {
  switch (scope.kind) {
    case 'session':
      return `session:${scope.sessionId}:${scope.draftId}`
    case 'run':
      return `run:${scope.sessionId}:${scope.runId}`
    case 'project':
      return `project:${scope.projectId}`
    case 'style-job':
      return `style:${scope.projectId}:${scope.jobId}`
  }
}

function scopeMatches(a: FileScope, b: FileScope): boolean {
  return scopeKey(a) === scopeKey(b)
}

async function statFingerprint(p: string): Promise<{ size: number; mtimeMs: number; fingerprint: string } | null> {
  try {
    const st = await fs.stat(p)
    return { size: st.size, mtimeMs: st.mtimeMs, fingerprint: `${st.size}:${st.mtimeMs}` }
  } catch {
    return null
  }
}

/** 逐级 realpath（父目录存在性解析；不存在返回 null） */
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

export class FileRefRegistry {
  private refs = new Map<string, FileRefInternal>()

  constructor(private maxRefs = MAX_REFS) {}

  /** 注册文件/目录 → FileRefView 列表（失败项计数）；容量为硬上限 */
  async register(paths: string[], scope: FileScope, source: FileRefSource): Promise<{ refs: FileRefView[]; failed: number }> {
    this.prune()
    const refs: FileRefView[] = []
    let failed = 0
    for (const p of paths) {
      if (this.refs.size >= this.maxRefs) {
        failed++
        continue // 硬上限：拒绝，不回收不清除
      }
      const real = await resolveRealpath(p)
      if (!real) {
        failed++
        continue
      }
      const st = await statFingerprint(real)
      if (!st) {
        failed++
        continue
      }
      const kind: FileRefKind = (await fs.stat(real)).isDirectory() ? 'dir' : 'file'
      const now = Date.now()
      const ref: FileRefInternal = {
        fileRefId: randomBytes(16).toString('hex'),
        realpath: real,
        displayName: path.basename(real),
        kind,
        size: st.size,
        source,
        scope,
        fingerprint: st.fingerprint,
        issuedAt: now,
        expiresAt: now + DEFAULT_TTL_MS,
        revoked: false
      }
      this.refs.set(ref.fileRefId, ref)
      refs.push(this.toView(ref))
    }
    return { refs, failed }
  }

  /** 非消耗检查：展示/菜单用；不改变状态。expectedScope 必填严格匹配。 */
  inspect(refId: string, expectedScope: FileScope): FileRefView | null {
    this.prune()
    const ref = this.refs.get(refId)
    if (!ref || ref.revoked) return null
    if (!scopeMatches(ref.scope, expectedScope)) return null
    return this.toView(ref)
  }

  /**
   * 按操作解析并重新校验（每次操作独立授权，不消费身份）。
   * expectedScope 必填；realpath+stat；按 operation 检查；内容变化（fingerprint 漂移）→ 拒绝。
   * 返回内部对象（realpath 仅 main 内部使用），失败返回 null。
   */
  async resolveForOperation(refId: string, op: FileOperation, expectedScope: FileScope, opts?: { workDir?: string }): Promise<FileRefInternal | null> {
    this.prune()
    const ref = this.refs.get(refId)
    if (!ref || ref.revoked) return null
    if (!scopeMatches(ref.scope, expectedScope)) return null
    // 目标仍存在
    const curReal = await resolveRealpath(ref.realpath)
    if (!curReal || curReal !== ref.realpath) return null
    // 内容变化检测（size/mtime）：模型读取与预览必须一致，防签发后替换
    const st = await statFingerprint(ref.realpath)
    if (!st) return null
    if (op !== 'inspect' && st.fingerprint !== ref.fingerprint) {
      ref.revoked = true // 变化即作废，防继续使用
      return null
    }
    // 按 operation 校验
    switch (op) {
      case 'read-for-model':
      case 'preview': {
        if (ref.kind !== 'file') return null
        break
      }
      case 'open':
      case 'reveal':
      case 'copy-absolute-path':
      case 'copy-relative-path':
        break
      case 'attach-to-draft':
        if (ref.kind !== 'file') return null
        break
      case 'inspect':
        break
    }
    if (opts?.workDir && (op === 'copy-relative-path' || op === 'read-for-model')) {
      // 工作区 containment：相对路径与模型读取的 workspace 边界由调用方另行执行（此处提供 workDir 可检查）
      const realRoot = await resolveRealpath(path.resolve(opts.workDir))
      if (realRoot) {
        const a = ref.realpath.toLowerCase()
        const r = realRoot.toLowerCase()
        const within = a === r || a.startsWith(r + path.sep)
        if (op === 'copy-relative-path' && !within) return null
      }
    }
    return ref
  }

  /** 显式撤销单个引用（删除附件/取消附加） */
  revoke(refId: string): void {
    this.refs.delete(refId)
  }

  /** 按 scope 撤销（切会话/项目/草稿结束） */
  revokeScope(scope: FileScope): void {
    const key = scopeKey(scope)
    for (const [id, ref] of this.refs) {
      if (scopeKey(ref.scope) === key) this.refs.delete(id)
    }
  }

  /** R4.2 A7 补充：列出 scope 内全部 refId（session 生命周期 revoke 时释放关联资产 lease 用） */
  listRefIds(scope: FileScope): string[] {
    const key = scopeKey(scope)
    const out: string[] = []
    for (const [id, ref] of this.refs) {
      if (scopeKey(ref.scope) === key) out.push(id)
    }
    return out
  }

  get size(): number {
    return this.refs.size
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, ref] of this.refs) {
      if (ref.expiresAt < now) this.refs.delete(id)
    }
  }

  private toView(ref: FileRefInternal): FileRefView {
    return {
      fileRefId: ref.fileRefId,
      displayName: ref.displayName,
      kind: ref.kind,
      size: ref.size,
      source: ref.source,
      state: ref.revoked ? 'revoked' : 'registered'
    }
  }
}

export const fileRefRegistry = new FileRefRegistry()

// ---------------- R4.1 S-05：模型读取统一 policy（preview 与 read-for-model 共用） ----------------

export const MODEL_READ_EXT_WHITELIST = new Set<string>([...TEXT_FILE_EXTENSIONS, 'zip', 'xlsx', 'pptx', 'docx', 'pdf', 'epub', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'ogg', 'wav'])
export const MODEL_READ_MAX_BYTES = 50 * 1024 * 1024

/** 模型读取前的统一类型/大小检查（与 preview 同一 policy，防绕过 FILEREF-MODEL-SIZE/TYPE） */
export function checkModelReadPolicy(realpath: string, size: number): { ok: true } | { ok: false; error: string } {
  const ext = path.extname(realpath).toLowerCase().slice(1)
  if (!MODEL_READ_EXT_WHITELIST.has(ext) && !isProjectTextName(path.basename(realpath))) return { ok: false, error: '不支持的附件类型' }
  if (size > MODEL_READ_MAX_BYTES) return { ok: false, error: '附件超过 50MB 限制' }
  return { ok: true }
}
