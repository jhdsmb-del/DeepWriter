import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Repository, RunRow } from './db/repository'
import { chatFileCandidate, chatFileCanOpen, type ChatFileAnchor, type ChatFileView } from '../shared/chatFiles'

export type ChatFileTarget = { ok: true; path: string; state: 'ready' | 'missing'; canOpen: boolean } | { ok: false; message: string }
const same = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const messageRunId = (id: string): string => id.startsWith('m_') && id.endsWith('_assistant') ? id.slice(2, -10) : id
const rootsOf = (config: Record<string, unknown>): string[] => [...new Set([config.workDir, config.docDir].filter((v): v is string => typeof v === 'string' && path.isAbsolute(v)).map(v => path.resolve(v)))]
// One lookup request may mention many files in the same directory. Share only
// in-flight realpath/stat work within that request; actions always start fresh.
function inspectionIO(): { realpath: typeof fs.realpath; stat: typeof fs.stat } {
  const realpaths = new Map<string, ReturnType<typeof fs.realpath>>()
  const stats = new Map<string, ReturnType<typeof fs.stat>>()
  return {
    realpath: ((target: string) => {
      let result = realpaths.get(target)
      if (!result) { result = fs.realpath(target); realpaths.set(target, result) }
      return result
    }) as typeof fs.realpath,
    stat: ((target: string) => {
      let result = stats.get(target)
      if (!result) { result = fs.stat(target); stats.set(target, result) }
      return result
    }) as typeof fs.stat
  }
}
interface LookupScope {
  run: RunRow
  config: Record<string, unknown>
  roots: string[]
  facts: ReturnType<Repository['getRunWrittenFiles']>
  mentions: Set<string>
  io: ReturnType<typeof inspectionIO>
}
function within(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}
async function inspect(target: string, roots: string[], receipt: boolean, canonicalPath?: string, io = inspectionIO()): Promise<ChatFileTarget> {
  if (!chatFileCandidate(target)) return { ok: false, message: '不是可确认的本地文件路径' }
  try {
    const real = await io.realpath(target)
    // A receipt authorizes its exact original path, not a later symlink/junction
    // redirection. Workspace lookups additionally require real-root containment.
    if (receipt && !same(real, canonicalPath ?? target)) return { ok: false, message: '文件路径已改变，请重新确认文件位置' }
    if (!receipt && !(await Promise.all(roots.map(async root => {
      try { return within(await io.realpath(root), real) } catch { return false }
    }))).some(Boolean)) return { ok: false, message: '文件不在该任务授权目录内' }
    if (!(await io.stat(real)).isFile() || !chatFileCandidate(real)) return { ok: false, message: '目标不是可确认的本地文件' }
    const canOpen = chatFileCanOpen(real)
    if (!receipt && !canOpen) return { ok: false, message: '此类文件需要该任务的确切写入回执' }
    return { ok: true, path: real, state: 'ready', canOpen }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return receipt
      ? { ok: true, path: target, state: 'missing', canOpen: chatFileCanOpen(target) }
      : { ok: false, message: '文件已移动或删除，请确认原文件位置' }
    return { ok: false, message: '无法访问该文件，请检查文件位置和权限' }
  }
}

/** Resolve from the reply/run's durable facts, never the currently selected cwd. */
async function resolveScopedChatFile(repo: Repository, anchor: ChatFileAnchor, scope?: LookupScope, forMenu = false): Promise<ChatFileTarget> {
  const runId = anchor.kind === 'artifact' ? anchor.runId : messageRunId(anchor.messageId)
  const run = scope?.run ?? repo.getRun(runId)
  if (!run || (anchor.kind === 'message' && (run.session_id !== anchor.sessionId || !(scope ? scope.mentions.has(anchor.candidate) : repo.chatFileMessageMentions(anchor.sessionId, runId, anchor.candidate)))))
    return { ok: false, message: '该回复没有可确认的文件记录' }
  let config: Record<string, unknown>
  try { config = scope?.config ?? JSON.parse(run.config_json) } catch { return { ok: false, message: '该任务缺少原始目录记录' } }
  if (!config || typeof config !== 'object') return { ok: false, message: '该任务缺少原始目录记录' }
  const roots = scope?.roots ?? rootsOf(config)
  const io = scope?.io ?? inspectionIO()
  if (anchor.kind === 'artifact') {
    const artifact = repo.getArtifactsByRun(runId).find(a => a.artifact_id === anchor.artifactId)
    const root = typeof config.docDir === 'string' && path.isAbsolute(config.docDir) ? path.resolve(config.docDir) : ''
    if (!artifact || artifact.status !== 'completed' || artifact.artifact_type !== 'manuscript' || !artifact.relative_path || !artifact.hash || !root)
      return { ok: false, message: '稿件没有已完成的文件记录' }
    const target = path.resolve(root, artifact.relative_path)
    if (!within(root, target)) return { ok: false, message: '稿件不在原始输出目录内' }
    const result = await inspect(target, [root], false, undefined, io)
    if (!result.ok) return result
    if (forMenu) return result // Integrity is checked when an action is chosen, not to draw a menu.
    if (createHash('sha256').update(await fs.readFile(result.path)).digest('hex') !== artifact.hash)
      return { ok: false, message: '稿件内容已改变，无法通过原产物校验' }
    return result
  }
  const candidate = chatFileCandidate(anchor.candidate)
  if (!candidate) return { ok: false, message: '不是可打开的本地文档路径' }
  const normalized = candidate.replace(/[\\/]/g, path.sep)
  const bare = path.basename(normalized) === normalized
  const candidatePaths = path.isAbsolute(normalized) ? [path.resolve(normalized)] : roots.map(root => path.resolve(root, normalized)).filter(p => roots.some(root => within(root, p)))
  const facts = scope?.facts ?? repo.getRunWrittenFiles(runId)
  const written: Array<{ target: string; canonical?: string }> = []
  for (const fact of facts) {
    const base = fact.name === 'write_file' || fact.name === 'edit_file' ? config.workDir : config.docDir
    const raw = typeof fact.result_path === 'string' && path.isAbsolute(fact.result_path) ? fact.result_path
      : typeof fact.args_path === 'string' && typeof base === 'string' && path.isAbsolute(base) ? path.resolve(base, fact.args_path) : null
    if (!raw) continue // Old save-dialog filenames are suggestions, not paths.
    const target = path.resolve(raw)
    const canonical = typeof fact.canonical_path === 'string' && path.isAbsolute(fact.canonical_path) ? path.resolve(fact.canonical_path) : undefined
    if (bare ? same(path.basename(target), normalized) : candidatePaths.some(p => same(p, target) || !!canonical && same(p, canonical))) written.push({ target, canonical })
  }
  const unique = [...new Set(written.map(({ target, canonical }) => process.platform === 'win32' ? (canonical ?? target).toLowerCase() : (canonical ?? target)))]
  if (unique.length > 1) return { ok: false, message: '该任务有多个同名文件，请使用完整相对路径' }
  if (written.length) {
    const file = written[0]
    // The receipt establishes menu identity without disk I/O. No shell action
    // consumes this preview; readyChatFile re-resolves the original path fresh.
    if (forMenu) {
      const target = file.canonical ?? file.target
      if (!chatFileCandidate(file.target) || !chatFileCandidate(target)) return { ok: false, message: '不是可确认的本地文件路径' }
      return { ok: true, path: target, state: 'ready', canOpen: chatFileCanOpen(target) }
    }
    return inspect(file.target, roots, true, file.canonical, io)
  }
  // A legacy save dialog may have chosen a different location. Do not turn its
  // suggested filename into a different, coincidentally existing workspace file.
  if (facts.some(f => !f.result_path && !f.args_path && f.filename && same(path.basename(f.filename), path.basename(normalized))))
    return { ok: false, message: '旧记录未保存实际文件位置，无法确认目标文件' }
  const confirmed = await Promise.all(candidatePaths.filter(p => roots.some(root => within(root, p))).map(p => inspect(p, roots, false, undefined, io)))
  const valid = confirmed.filter((r): r is Extract<ChatFileTarget, {ok: true}> => r.ok)
  const real = valid.filter((r, i) => valid.findIndex(v => same(v.path, r.path)) === i)
  if (real.length > 1) return { ok: false, message: '原任务目录内有多个同名文件，请使用完整路径' }
  return real[0] ?? { ok: false, message: '文件已移动或删除，请确认原文件位置' }
}

export function resolveChatFile(repo: Repository, anchor: ChatFileAnchor): Promise<ChatFileTarget> {
  return resolveScopedChatFile(repo, anchor)
}

export function prepareChatFileMenu(repo: Repository, anchor: ChatFileAnchor): Promise<ChatFileTarget> {
  return resolveScopedChatFile(repo, anchor, undefined, true)
}

/** The actual chatFiles:resolve entry: one scoped DB projection per reply. */
export async function resolveChatFiles(repo: Repository, input: { sessionId: string; messageId: string; candidates: string[] }): Promise<ChatFileView[]> {
  const candidates = [...new Set(input.candidates)].filter(candidate => chatFileCandidate(candidate) !== null)
  if (!candidates.length) return []
  const runId = messageRunId(input.messageId)
  const run = repo.getRun(runId)
  if (!run || run.session_id !== input.sessionId) return []
  let config: Record<string, unknown>
  try { config = JSON.parse(run.config_json) } catch { return [] }
  if (!config || typeof config !== 'object') return []
  const mentions = new Set(repo.chatFileMessageCandidates(input.sessionId, runId, candidates))
  if (!mentions.size) return []
  const scope: LookupScope = { run, config, roots: rootsOf(config), facts: repo.getRunWrittenFiles(runId), mentions, io: inspectionIO() }
  const results = await Promise.all(candidates.filter(candidate => mentions.has(candidate)).map(async candidate => {
    const target = await resolveScopedChatFile(repo, { kind: 'message', sessionId: input.sessionId, messageId: input.messageId, candidate }, scope)
    return target.ok ? { candidate, path: target.path, state: target.state, canOpen: target.canOpen } : null
  }))
  return results.filter((result): result is ChatFileView => result !== null)
}

export async function readyChatFile(repo: Repository, anchor: ChatFileAnchor, expectedPath?: string): Promise<ChatFileTarget> {
  const result = await resolveChatFile(repo, anchor)
  if (!result.ok) return result
  if (result.state === 'missing') return { ok: false, message: '文件已移动或删除，请确认原文件位置' }
  if (expectedPath && !same(expectedPath, result.path)) return { ok: false, message: '文件路径已改变，请重新打开菜单' }
  return result
}
