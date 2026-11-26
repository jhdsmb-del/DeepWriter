import { dialog } from 'electron'
import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import * as path from 'path'
import type { PermissionAction, PermissionDecision, PermissionMode, PermissionRule, PermissionSettings, PermissionTargetType } from '../shared/types'
import type { PermissionContext, PermissionRequestView } from '../shared/permissionRequest'

export interface AskUserResult {
  action: PermissionAction
  remember: boolean
  scope?: 'run'
  reason?: string
}

export type AskUserFn = (type: PermissionTargetType, target: string, identity?: PermissionIdentity, view?: Omit<PermissionRequestView, 'id'>) => Promise<AskUserResult>

/** R4.2 A2：执行身份——decide() 必须接收，不得读取进程全局 mode（S-02） */
export interface PermissionIdentity extends PermissionContext {
  legacyReadRoots?: string[]
  webContentsId?: number
  sessionId?: string
  runId?: string
  signal?: AbortSignal
}

/** R4.2 A2：owner-scoped permission lease（临时完全访问只能影响明确的 window/session/run/scope） */
export interface PermissionLease {
  leaseId: string
  webContentsId: number
  sessionId: string
  runId: string | null // null = 该 session 内任意 run（仅同窗口同 session）；绑定则只授权该 run
  scopes: 'full' | PermissionTargetType[]
  issuedAt: number
  expiresAt: number
  /** 全局递增；审计用——旧 timer/旧 lease 的撤销绝不触碰新 lease */
  revision: number
}

export interface PermissionManager {
  getSettings(): PermissionSettings
  updateSettings(s: PermissionSettings): Promise<void>
  decide(type: PermissionTargetType, target: string, identity?: PermissionIdentity): Promise<PermissionDecision>
  /** R4.2 A2：签发 owner-scoped lease（替代全局 volatile mode；进程重启一律失效） */
  issueLease(input: { webContentsId: number; sessionId: string; runId?: string | null; scopes: 'full' | PermissionTargetType[]; ttlMs: number }): PermissionLease
  revokeLease(leaseId: string): void
  revokeLeasesByWebContentsId(webContentsId: number): void
  revokeLeasesByRunId(runId: string): void
  revokeLeasesBySessionId(sessionId: string): void
  /** 惰性过期清理（decide/list 内部也会触发） */
  pruneExpiredLeases(): void
  listLeases(): PermissionLease[]
  /** UI 显示用：该窗口是否有生效的临时全开 lease（显示宽松、判定严格） */
  getActiveFullAccess(webContentsId: number): { expiresAt: number } | null
}

const SAFE_AUTO_EXES = new Set(['ls', 'dir', 'pwd', 'echo', 'type', 'findstr', 'git'])
const SAFE_GIT_SUBS = new Set(['status', 'diff', 'log', 'branch', 'show', 'remote'])
/** 需要在主进程内以 Node 原生实现执行的 cmd 内置命令（不能 spawn 出独立进程） */
export const CMD_BUILTINS = new Set(['type', 'dir', 'findstr', 'echo', 'cd', 'pwd', 'ls', 'where', 'tasklist'])
/** 未加引号即出现的 shell 元字符 → 整个命令拒绝（argv 执行模型下元字符只能安全地出现在参数内） */
const SHELL_META_RE = /[&|;<>`$(){}\[\]*?~!]/
const QUOTE_CHARS = new Set(['"', "'"])

/**
 * 命令字符串 → argv 数组（引号感知、按平台处理双引号内的反斜杠）。
 * 出现未加引号的 shell 元字符、换行、空 program 时返回 null（拒绝）。
 * 该 tokenizer 是权限判定与安全执行共用的唯一解析器。
 */
export function parseCommandLine(cmd: string, platform: NodeJS.Platform = process.platform): string[] | null {
  if (!cmd || cmd.includes('\r') || cmd.includes('\n')) return null
  const tokens: string[] = []
  let cur = ''
  let inQuote: '"' | "'" | null = null
  let started = false
  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]
    if (inQuote) {
      if (ch === '\\' && inQuote === '"' && i + 1 < cmd.length) {
        if (platform === 'win32') {
          let end = i
          while (cmd[end] === '\\') end++
          const count = end - i
          if (cmd[end] === '"') {
            cur += '\\'.repeat(Math.floor(count / 2))
            if (count % 2 === 1) {
              cur += '"'
              i = end + 1
            } else i = end
          } else {
            cur += '\\'.repeat(count)
            i = end
          }
          continue
        }
        // POSIX double quotes only escape these characters. In particular,
        // quoted Windows paths must not lose each directory separator.
        if ('\\"$`'.includes(cmd[i + 1])) {
          cur += cmd[i + 1]
          i += 2
          continue
        }
      }
      if (ch === inQuote) {
        inQuote = null
        i++
        continue
      }
      cur += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      started = true
      i++
      continue
    }
    if (ch === '\\' && i + 1 < cmd.length && cmd[i + 1] === '"') {
      cur += '"'
      i += 2
      continue
    }
    if (SHELL_META_RE.test(ch)) return null
    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(cur)
        cur = ''
        started = false
      }
      i++
      continue
    }
    cur += ch
    started = true
    i++
  }
  if (inQuote) return null
  if (started) tokens.push(cur)
  if (tokens.length === 0 || tokens[0].length === 0) return null
  return tokens
}

export function isSafeAutoCommand(cmd: string): boolean {
  const argv = parseCommandLine(cmd)
  if (!argv) return false
  const program = argv[0]
  if (!SAFE_AUTO_EXES.has(program)) return false
  if (program === 'git') {
    const sub = argv[1]
    if (!sub || !SAFE_GIT_SUBS.has(sub)) return false
    // Plain branch names create branches; only inspection forms are automatic.
    if (sub === 'branch') {
      const flags = argv.slice(2)
      if (!flags.every(flag => /^-[arvl]+$/.test(flag) || ['--all', '--list', '--remotes', '--verbose', '--show-current'].includes(flag))) return false
    }
    // git remote 只允许 -v
    if (sub === 'remote' && !(argv[2] === '-v' && argv.length === 3)) return false
    // git diff/show/log 等不允许 --ext-diff/--textconv/--no-index/--output 等危险选项
    for (const a of argv.slice(2)) {
      if (/^--(ext-diff|textconv|no-index|output|paginate|no-pager)/.test(a)) return false
    }
    return true
  }
  if (program === 'type' || program === 'findstr') {
    // 路径参数是否在 workDir 内的 containment 由执行端（runCommand 原生实现）强制
    return true
  }
  return true
}

const normPath = (p: string): string => path.normalize(p).replace(/\\/g, '/').toLowerCase()

export function defaultAskUser(type: PermissionTargetType, target: string, _identity?: PermissionIdentity, view?: Omit<PermissionRequestView, 'id'>): Promise<AskUserResult> {
  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    return Promise.resolve({ action: 'deny', remember: false, reason: '需要交互授权，但当前没有可用的确认界面；本次操作未获批准' })
  }
  const isCmd = type === 'command'
  return dialog
    .showMessageBox({
      type: 'warning',
      buttons: ['允许一次', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      title: isCmd ? '命令执行授权' : '路径访问授权',
      message: view?.operation ?? (isCmd ? '运行命令' : '访问文件'),
      detail: `${isCmd ? '命令' : '目标'}：${target}\n\n${view?.reason ?? '此操作需要你的明确授权。'}`
    })
    .then((r) => {
      if (r.response === 0) return { action: 'allow' as PermissionAction, remember: false }
      return { action: 'deny' as PermissionAction, remember: false }
    })
}

/** 规范化后的 argv 精确相等（顺序敏感；防前缀放大与追加参数绕过） */
function argvEqual(a: string[] | null, b: string[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function matchRule(rules: PermissionRule[], type: PermissionTargetType, target: string): PermissionRule | undefined {
  const targetArgv = type === 'command' ? parseCommandLine(target) : null
  for (const rule of rules) {
    if (rule.type !== type) continue
    if (type === 'command') {
      if (rule.literal === false) continue // 旧正则规则视为 legacy，不再生效（防绕过），迁移后由用户重新授权
      if (argvEqual(parseCommandLine(rule.pattern), targetArgv)) return rule
    } else if (normPath(target) === normPath(rule.pattern) || normPath(target).startsWith(normPath(rule.pattern) + '/')) {
      return rule
    }
  }
  return undefined
}

/** 命令记忆规则必须是可解析、非危险结构的命令（tokenizer 成功；program 不含路径分隔/点号前缀） */
export function isSafeRulePattern(cmd: string): boolean {
  const argv = parseCommandLine(cmd)
  if (!argv) return false
  const program = argv[0]
  if (program.includes('/') || program.includes('\\') || program.startsWith('.') || program.includes(':')) return false
  return true
}

export function createPermissionManager(baseDir: string, askUser?: AskUserFn, initialMode: PermissionMode = 'auto'): PermissionManager {
  const settingsFile = path.join(baseDir, 'permissions.json')
  const auditFile = path.join(baseDir, 'audit.log')
  const askUserFn = askUser ?? defaultAskUser
  let cached: PermissionSettings | null = null
  const runGrants = new Set<string>()
  const sensitive = (target: string): boolean => /(^|[\\/])(\.[^\\/]+|credentials?|secrets?|tokens?)([\\/]|\.|$)|\.(pem|key|kdbx)$/iu.test(target)
  const ordinaryDocument = (target: string): boolean => /\.(md|txt|docx|pdf|xlsx|pptx|csv|tsv|epub)$/iu.test(target) && !sensitive(target)
  const workspaceTarget = async (target: string, identity?: PermissionIdentity): Promise<string | null> => {
    if (!identity?.workspaceRoot) return null
    try {
      const root = await fs.realpath(identity.workspaceRoot)
      if (root === path.parse(root).root) return null
      let current = path.resolve(target), suffix: string[] = []
      for (;;) {
        try { current = path.join(await fs.realpath(current), ...suffix.reverse()); break }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
          const parent = path.dirname(current)
          if (parent === current) return null
          suffix.push(path.basename(current)); current = parent
        }
      }
      const relative = path.relative(root, current)
      return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) ? root : current === root && identity.operation === 'read' ? root : null
    } catch { return null }
  }

  const normalize = (s: PermissionSettings): PermissionSettings => {
    // R4.1：off 不得作为持久化模式；加载/写入时一律归一为 safe/auto
    const mode: PermissionMode = s.mode === 'off' ? 'safe' : s.mode === 'auto' ? 'auto' : 'safe'
    return {
      mode,
      rules: Array.isArray(s.rules) ? s.rules : []
    }
  }

  // R4.2 A2：owner-scoped lease（替代全局 volatile mode）
  // - 不落盘：进程退出即失效，重启后自动恢复持久模式；
  // - lease A 不能授权窗口/任务 B（webContentsId+sessionId 必匹配；runId 绑定则仅限该 run）；
  // - 窗口销毁 / run terminal / 到期 / 显式撤销均立即失效；
  // - 按 leaseId 管理 + revision 审计：旧 timer/旧 lease 的撤销绝不触碰新 lease。
  const leases = new Map<string, PermissionLease>()
  let leaseRevision = 0

  const pruneExpiredLeases = (): void => {
    const now = Date.now()
    for (const [id, l] of leases) {
      if (l.expiresAt < now) leases.delete(id)
    }
  }

  /** 匹配 identity 的活跃 lease（严格：webContentsId+sessionId 必匹配；runId 绑定则必须相等；scope 覆盖） */
  const matchLease = (identity: PermissionIdentity | undefined, type: PermissionTargetType): PermissionLease | null => {
    if (!identity || typeof identity.webContentsId !== 'number' || typeof identity.sessionId !== 'string') return null
    pruneExpiredLeases()
    for (const l of leases.values()) {
      if (l.webContentsId !== identity.webContentsId) continue
      if (l.sessionId !== identity.sessionId) continue
      if (l.runId !== null && l.runId !== identity.runId) continue
      if (l.scopes !== 'full' && !l.scopes.includes(type)) continue
      return l
    }
    return null
  }

  const writeAudit = async (
    type: PermissionTargetType,
    target: string,
    decision: PermissionAction,
    ruleId: string | undefined,
    mode: PermissionSettings['mode']
  ): Promise<void> => {
    try {
      await fs.mkdir(baseDir, { recursive: true })
      await fs.appendFile(auditFile, JSON.stringify({ ts: Date.now(), type, target, decision, ruleId: ruleId ?? null, mode }) + '\n', 'utf-8')
    } catch {
      /* 审计失败不阻断决策 */
    }
  }

  const writeSettings = async (): Promise<void> => {
    await fs.mkdir(baseDir, { recursive: true })
    await fs.writeFile(settingsFile, JSON.stringify(cached, null, 2), 'utf-8')
  }

  const getSettings = (): PermissionSettings => {
    if (cached) return cached
    try {
      const raw = fsSync.readFileSync(settingsFile, 'utf-8')
      cached = normalize(JSON.parse(raw))
    } catch (error) {
      cached = { mode: (error as NodeJS.ErrnoException).code === 'ENOENT' && initialMode === 'auto' ? 'auto' : 'safe', rules: [] }
    }
    return cached
  }
  const askAndResolve = async (type: PermissionTargetType, target: string, mode: PermissionSettings['mode'], identity?: PermissionIdentity): Promise<PermissionDecision> => {
    if (identity?.signal?.aborted) return { action: 'deny', reason: '任务已停止，本次操作未执行' }
    if (identity?.nonInteractive) return { action: 'deny', reason: '后台读取需要额外授权，当前不允许发起交互确认' }
    const root = type === 'path' ? await workspaceTarget(target, identity) : null
    const lowRisk = Boolean(root && !sensitive(target) && identity?.operation && ['read', 'create', 'edit'].includes(identity.operation) && (identity.operation === 'read' || ordinaryDocument(target)))
    const grantKey = lowRisk && identity?.runId && identity.sessionId && identity.webContentsId !== undefined ? JSON.stringify([identity.webContentsId, identity.sessionId, identity.runId, root, identity.operation]) : null
    if (grantKey && runGrants.has(grantKey)) return { action: 'allow', reason: '本任务同工作区同类文件操作已允许' }
    const labels = { read: '读取文件或目录', create: '新建文件', edit: '修改文件（保留原稿）', overwrite: '覆盖已有文件', command: '运行命令' }
    const operation = identity?.operation ?? (type === 'command' ? 'command' : 'read')
    const view = { type, target, runId: identity?.runId, operation: labels[operation], workspaceRoot: root, canAllowForRun: Boolean(grantKey),
      reason: type === 'command' ? '命令可能修改文件、启动程序或访问网络。' : !root ? '此目标位于本任务授权的工作区之外。' : operation === 'overwrite' ? '现有内容将被替换或大幅修改。' : sensitive(target) ? '此文件可能包含凭据或敏感信息。' : mode === 'safe' ? '此任务要求逐项确认。' : '此文件类型需要单独授权。' }
    const res = await askUserFn(type, target, identity, view)
    if (identity?.signal?.aborted) return { action: 'deny', reason: '任务已停止' }
    if (res.action === 'allow' && res.scope === 'run' && grantKey) runGrants.add(grantKey)
    let ruleId: string | undefined
    if (res.remember) {
      if (type === 'command' && !isSafeRulePattern(target)) {
        await writeAudit(type, target, res.action, undefined, mode)
        return { action: res.action, reason: res.reason || (res.action === 'allow' ? '用户已允许（不安全命令不记忆规则）' : '用户已拒绝（命令规则未保存）') }
      }
      const rule: PermissionRule = {
        id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        type,
        pattern: type === 'path' ? normPath(target) : target,
        action: res.action,
        persistent: true,
        literal: true,
        label: type === 'command' ? `命令：${target.slice(0, 80)}` : `路径：${target}`
      }
      const s = getSettings()
      cached = normalize({ ...s, rules: [...s.rules, rule] })
      await writeSettings()
      ruleId = rule.id
    }
    await writeAudit(type, target, res.action, ruleId, mode)
    return { action: res.action, ruleId, reason: res.reason || (res.action === 'allow' ? '用户已允许' : '用户已拒绝') }
  }

  return {
    getSettings,

    async updateSettings(s) {
      // R4.1：普通持久化路径拒绝 off（off 只能走 owner-scoped lease）
      if (s.mode === 'off') throw new Error('permissionMode=off 只能通过临时授权（owner-scoped lease）启用，不写入持久配置')
      cached = normalize(s)
      await writeSettings()
    },

    async decide(type, target, identity) {
      const s = getSettings()
      // R4.2 A2：owner-scoped lease——只有 identity 匹配（window/session/run/scope）的 lease 才放行，
      // 不再存在"进程级全局 off 模式"（S-02）
      const lease = matchLease(identity, type)
      if (lease) {
        await writeAudit(type, target, 'allow', undefined, 'off')
        return { action: 'allow', reason: '临时完全访问授权中（owner-scoped lease）' }
      }
      const mode = identity?.permissionMode === 'safe' || s.mode === 'safe' ? 'safe' : identity?.permissionMode === 'auto' ? 'auto' : identity ? 'safe' : s.mode
      const rule = matchRule(s.rules, type, target)
      if (rule) {
        if (rule.action === 'ask') return askAndResolve(type, target, mode, identity)
        if (!rule.persistent) {
          cached = { ...s, rules: s.rules.filter((r) => r.id !== rule.id) }
          await writeSettings()
        }
        await writeAudit(type, target, rule.action, rule.id, mode)
        return { action: rule.action, ruleId: rule.id, reason: rule.action === 'allow' ? '命中允许规则' : '权限策略规则禁止此操作' }
      }
      if (type === 'path' && identity?.operation === 'read' && !identity.workspaceRoot && !sensitive(target)) {
        for (const root of identity.legacyReadRoots ?? []) {
          if (await workspaceTarget(target, { ...identity, workspaceRoot: root })) {
            await writeAudit(type, target, 'allow', undefined, mode)
            return { action: 'allow', reason: '保留已冻结目录的既有只读权限' }
          }
        }
      }
      if (mode === 'auto') {
        const root = type === 'path' ? await workspaceTarget(target, identity) : null
        if (root && !sensitive(target) && identity?.operation && ['read', 'create', 'edit'].includes(identity.operation) && (identity.operation === 'read' || ordinaryDocument(target))) {
          await writeAudit(type, target, 'allow', undefined, mode)
          return { action: 'allow', reason: '已选工作区内的普通文件操作' }
        }
        if (!identity && type === 'command' && isSafeAutoCommand(target)) {
          await writeAudit(type, target, 'allow', undefined, mode)
          return { action: 'allow', reason: '只读命令白名单' }
        }
        return askAndResolve(type, target, mode, identity)
      }
      return askAndResolve(type, target, mode, identity)
    },

    // ---- R4.2 A2：owner-scoped lease API ----
    issueLease(input) {
      pruneExpiredLeases()
      const now = Date.now()
      const lease: PermissionLease = {
        leaseId: `lease_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        webContentsId: input.webContentsId,
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        scopes: input.scopes,
        issuedAt: now,
        expiresAt: now + input.ttlMs,
        revision: ++leaseRevision
      }
      leases.set(lease.leaseId, lease)
      return lease
    },

    revokeLease(leaseId) {
      leases.delete(leaseId)
    },

    revokeLeasesByWebContentsId(webContentsId) {
      for (const key of runGrants) if (JSON.parse(key)[0] === webContentsId) runGrants.delete(key)
      for (const [id, l] of leases) {
        if (l.webContentsId === webContentsId) leases.delete(id)
      }
    },

    revokeLeasesByRunId(runId) {
      for (const key of runGrants) if (JSON.parse(key)[2] === runId) runGrants.delete(key)
      for (const [id, l] of leases) {
        if (l.runId === runId) leases.delete(id)
      }
    },

    revokeLeasesBySessionId(sessionId) {
      for (const key of runGrants) if (JSON.parse(key)[1] === sessionId) runGrants.delete(key)
      for (const [id, l] of leases) {
        if (l.sessionId === sessionId) leases.delete(id)
      }
    },

    pruneExpiredLeases,

    listLeases() {
      pruneExpiredLeases()
      return [...leases.values()]
    },

    getActiveFullAccess(webContentsId) {
      pruneExpiredLeases()
      let expiresAt = 0
      for (const l of leases.values()) {
        if (l.webContentsId === webContentsId && l.scopes === 'full' && l.expiresAt > expiresAt) expiresAt = l.expiresAt
      }
      return expiresAt > Date.now() ? { expiresAt } : null
    }
  }
}
