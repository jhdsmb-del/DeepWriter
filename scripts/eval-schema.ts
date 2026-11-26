// ==================== eval-schema.ts：任务集 schema 类型 + 校验 + 加载 ====================
// 数据化任务集的类型定义、JSON 校验与版本/哈希计算。
// 任务集（scripts/eval-tasks/tasks.json）是评测的唯一事实源，不得硬编码进 runner。

import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"

export const EVAL_TASKS_SCHEMA_VERSION = 1
export const EVAL_TASKS_ID = "deepwriter-eval-tasks-v1"

/** 一篇任务可用的垂类 mode（与 src/main/modeProfiles.ts 的 DeepWriterMode 对齐） */
export type TaskMode = "agent" | "longwrite" | "style" | "galgame"

/** 任务类别（任务书 §四 五类） */
export type TaskCategory = "longform" | "character-consistency" | "style-transfer" | "renpy" | "failure-recovery"

/** 单阶段的产出约束与回灌说明 */
export interface EvalStage {
  stageId: string
  role: "user" | "assistant"
  /** 阶段提示模板，支持占位符：{n}、{material:xxx}、{content:xxx}、{targetCharsPerChapter}、{carryover:stageId} */
  template: string
  /** 本阶段产出最低字符数（校验器 minChars 依据之一） */
  expectMinChars?: number
  /**
   * 该 stage 的输出目标字数（scale 缩放前）；R24-P0-01 fail-closed。
   * 逐 stage 单一真源：runner/validator 一律读此字段，不再回退到 task 级 targetChars。
   */
  targetChars: number
  /** 阶段重复次数（同一阶段连续执行 N 次，实现时用 {n} 区分轮次） */
  repeats?: number
  /** 回灌说明（上一阶段摘要/设定如何注入本轮） */
  carryOver?: string
}

/** 一个评测任务 */
export interface EvalTask {
  id: string
  category: TaskCategory
  title: string
  /** "all" 表示三组变体都跑（本轮全部任务均为 all） */
  variants: "all" | string[]
  /** 目标档位（字符），可用 --scale 统一缩放 */
  targetChars: number
  /** 该任务对应的垂类 mode（deepwriter_hardened_candidate 使用） */
  mode: TaskMode
  longMode: boolean
  /** 素材相对路径（相对 tasks.json 所在目录） */
  materials: string[]
  stages: EvalStage[]
  validatorRef: string
}

export interface EvalTaskSet {
  schemaVersion: number
  id: string
  description?: string
  tasks: EvalTask[]
}

/**
 * 逐阶段调用清单展开（R20 A2 统一接口：runner 与 preflight 共用同一展开口径）。
 * 阶段带 repeats 时连续展开 N 次（n=1 起）。longform=4 / character=6 / style=2 /
 * renpy=1 / failure-recovery=2，合计 15 阶段请求/任务。
 */
export function expandStages(task: Pick<EvalTask, "stages">): Array<{ stageId: string; n: number }> {
  const out: Array<{ stageId: string; n: number }> = []
  for (const st of task.stages) {
    const repCount = Math.max(1, st.repeats ?? 1)
    for (let n = 1; n <= repCount; n++) out.push({ stageId: st.stageId, n })
  }
  return out
}

/**
 * R21-R03 主代理统一：requestTraceHash 的规范序列（runner 与独立 validator 用同一实现）。
 * 固定字段集 + ordinal 排序，保证 manifest.requestTraceHash 可被 validator 精确重建。
 */
export function canonicalTraceSequence(traces: Array<Partial<RequestTrace>>): string {
  const norm = traces.map((t) => ({
    ordinal: t.ordinal ?? 0,
    sampleId: t.sampleId ?? "",
    variantId: t.variantId ?? "",
    stageId: t.stageId ?? "",
    roles: t.roles ?? [],
    userHash: t.userHash ?? "",
    assistantHash: t.assistantHash ?? "",
    historyCount: t.historyCount ?? 0,
    systemHash: t.systemHash ?? "",
    assembledHash: t.assembledHash ?? "",
    mockHistoryPairs: t.mockHistoryPairs
  }))
  norm.sort((a, b) => (a.ordinal - b.ordinal) || a.sampleId.localeCompare(b.sampleId))
  return JSON.stringify(norm)
}

// ==================== R20 公平性：canonical transcript 模型 ====================
// 三组 variant 逐阶段共享同一份 canonical transcript（user/assistant 对），
// 作为等价输入的唯一事实源；每个真实请求在发出前生成一条 RequestTrace 以证明
// 三组被喂了等价的历史。

/** canonical transcript 中的一轮（一次 user→assistant 交换）。失败轮次不 push。 */
export interface TranscriptTurn {
  role: "user" | "assistant"
  content: string
  /** 正文字符数（与 sample.stageResults.chars 同口径：content.length） */
  chars: number
  /** content 的 sha256（hex） */
  sha256: string
}

/** 一次真实模型请求的可审计 trace（发出前确定性生成并落盘）。 */
export interface RequestTrace {
  /** 全局请求序号（1 起，跨样本跨 variant 递增） */
  ordinal: number
  sampleId: string
  variantId: string
  stageId: string
  /** 本次请求实际发往模型的 messages 角色序列（如 ["system","user","assistant","user"]） */
  roles: string[]
  /** 本次请求内全部 user 内容拼接的 sha256 */
  userHash: string
  /** 本次请求内全部 assistant 内容拼接的 sha256（无则 ""） */
  assistantHash: string
  /** 请求内的历史轮次对数（user/assistant 对，不含当前 user） */
  historyCount: number
  /** controlled 模式：本次请求注入的 golden history 的规范化 sha256（三组应逐 ordinal 一致；trajectory 模式不填） */
  goldenHistoryHash?: string
  /** 本次请求 system 消息 sha256（variant 差异只允许在这里） */
  systemHash: string
  /** 整条请求 messages 的 sha256 */
  assembledHash: string
  /** mock 检测到的历史轮对数（三组应逐 ordinal 一致；失忆时该值偏小） */
  mockHistoryPairs?: number
}

/** sha256 hex 简写 */
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

// ==================== R22：provider 边界 request-attempt ledger ====================
// Codex P0-02/P0-03：request trace 是「staticSystem+historyTurns+live」的推测重建，
// 不是 provider 边界实测。ledger 记录最终 provider 请求边界（实际 fetch 前后），
// 绝不落 key/正文，只落 token 数安全字段与 messages 的角色/hash。

/**
 * 单次 provider 请求尝试（一次真实 fetch）。
 * deepwriter 链：由 src/main/deepseek.ts streamChat 在实际 fetch 前后回调；
 * generic 链：由 eval-variants.ts streamOpenAiCompatible 在 fetch 前后回调。
 */
export interface RequestAttempt {
  /** 全局唯一请求 id（如 "att-<n>"，跨样本跨 variant 递增） */
  requestId: string
  sampleId: string
  variantId: string
  taskId: string
  repeat: number
  stageId: string
  /** 该 attempt 所属的阶段序号（1 起；同 stageId 可能 repeats 多次，靠它区分）——扩展字段 */
  stageOrdinal: number
  /** deepwriter=orchestration runId；generic=null */
  runId: string | null
  /** runner 层尝试序（1 起） */
  outerAttempt: number
  /** adapter 内尝试序（1 起；无内层重试=1；未观测时 null —— 不得用 0 冒充未观测） */
  innerAttempt: number | null
  startedAt: string
  finishedAt: string
  durationMs: number
  outcome: "success" | "http_error" | "transport_error" | "aborted"
  httpStatus: number | null
  usagePresent: boolean
  /** 安全字段（token 数），无正文/key */
  usage: Record<string, number> | null
  actualMessageRoles: string[]
  actualUserHash: string
  actualHistoryHash: string
  actualSystemHash: string
  actualAssembledHash: string
  /** messages 每条 content 的 sha256 hex（顺序与 messages 一致；缺省 []） */
  actualMessageContentHashes?: string[]
  /** history 部分（最后一条 user 之前的 user/assistant）逐条 { role, sha256 }；缺省 [] */
  actualHistoryTurnHashes?: Array<{ role: string; sha256: string }>
}

/**
 * provider 边界实测回调的信息包（deepseek.ts / eval-variants.ts 在 fetch 前后产出）。
 * 不含 sample/variant/task/repeat/requestId/outerAttempt/runId 等 runner 层标识——
 * 它们由 runner 在回调用闭包补齐后合并成完整 RequestAttempt。
 */
export interface ProviderAttemptInfo {
  /** adapter 内尝试序（1 起） */
  innerAttempt: number
  outcome: "success" | "http_error" | "transport_error" | "aborted"
  httpStatus: number | null
  usagePresent: boolean
  usage: Record<string, number> | null
  actualMessageRoles: string[]
  actualUserHash: string
  actualHistoryHash: string
  actualSystemHash: string
  actualAssembledHash: string
  actualMessageContentHashes?: string[]
  actualHistoryTurnHashes?: Array<{ role: string; sha256: string }>
  startedAt: string
  durationMs: number
}

/**
 * 规范化请求 messages 的 history 部分（user/assistant 轮，不含最后一轮当前 user）的 sha256。
 * 规则与 countHistoryPairs 的「历史」口径一致：从倒数第二条向前，排除 system，排除最后一条 user。
 * 与 src/main/deepseek.ts 内联实现严格同口径（deepseek.ts 不能 import scripts/，须保持字节一致）。
 */
export function historyHash(messages: Array<{ role: string; content?: string }>): string {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break }
  }
  const history = lastUserIdx > 0
    ? messages.slice(0, lastUserIdx).filter((m) => m.role === "user" || m.role === "assistant")
    : []
  return sha256(JSON.stringify(history.map((m) => ({ role: m.role, content: m.content ?? "" }))))
}

/**
 * ledger 的规范序列（requestId 升序 + 固定字段集），供 ledgerSha256 在 runner 与独立 validator
 * 之间精确重建。绝不落 key/正文（usage 只含 token 数安全字段）。
 */
export function canonicalLedger(ledger: Array<Partial<RequestAttempt>>): string {
  const norm = ledger
    .map((a) => ({
      requestId: a.requestId ?? "",
      sampleId: a.sampleId ?? "",
      variantId: a.variantId ?? "",
      taskId: a.taskId ?? "",
      repeat: a.repeat ?? 0,
      stageId: a.stageId ?? "",
      stageOrdinal: a.stageOrdinal ?? 0,
      runId: a.runId ?? null,
      outerAttempt: a.outerAttempt ?? 0,
      innerAttempt: a.innerAttempt ?? 0,
      startedAt: a.startedAt ?? "",
      durationMs: a.durationMs ?? 0,
      outcome: a.outcome ?? "",
      httpStatus: a.httpStatus ?? null,
      usagePresent: a.usagePresent ?? false,
      usage: a.usage ?? null,
      actualMessageRoles: a.actualMessageRoles ?? [],
      actualUserHash: a.actualUserHash ?? "",
      actualHistoryHash: a.actualHistoryHash ?? "",
      actualSystemHash: a.actualSystemHash ?? "",
      actualAssembledHash: a.actualAssembledHash ?? "",
      actualMessageContentHashes: a.actualMessageContentHashes ?? [],
      actualHistoryTurnHashes: a.actualHistoryTurnHashes ?? []
    }))
    .sort((a, b) => a.requestId.localeCompare(b.requestId))
  return JSON.stringify(norm)
}

/**
 * 计算请求 messages 里的历史轮次对数（user/assistant 成对，不含最后一条当前 user 消息）。
 * 规则：从倒数第二条开始向前扫描（当前 user 消息视为本轮新输入、不计入历史），
 * 统计相邻的 (user, assistant) 对数量。等价于 prompt 里已完成的「回合」数。
 */
export function countHistoryPairs(messages: Array<{ role: string; content?: string }>): number {
  // 找到最后一条 user 消息（当前输入）的索引；若无 user 则全算历史。
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break }
  }
  // 历史 = [0, lastUserIdx) 中的消息（不含当前 user）
  const history = lastUserIdx > 0 ? messages.slice(0, lastUserIdx) : messages
  let pairs = 0
  for (let i = 0; i + 1 < history.length; i++) {
    if (history[i].role === "user" && history[i + 1].role === "assistant") pairs++
  }
  return pairs
}

/** 拼接给定角色集合的内容并返回 sha256；assistant 无内容时返回 "" */
export function roleHash(messages: Array<{ role: string; content?: string }>, role: "user" | "assistant"): string {
  const joined = messages.filter((m) => m.role === role).map((m) => m.content ?? "").join("\n")
  return joined.length === 0 && role === "assistant" ? "" : sha256(joined)
}

/** 整条 messages 规范化后的 sha256 */
export function assembledHash(messages: Array<{ role: string; content?: string }>): string {
  return sha256(JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content ?? "" }))))
}

/** 规范化请求中全部 system 消息内容的 sha256（variant 差异只允许发生在这里） */
export function systemHash(messages: Array<{ role: string; content?: string }>): string {
  return sha256(messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n"))
}

// ==================== R21 实验语义：两套实验模式 + golden history ====================
// Codex P0-01 修复：把评测拆成 controlled-stage 与 trajectory 两套实验，消除
// 「三组各自产生历史却要求 assistantHash 相同」的自我阻断。

/**
 * 实验模式：
 *  - controlled：每 stage 使用任务集中预先冻结、与 variant 无关的 canonical（golden）history；
 *                本 stage 输出只评分与 trace、不回灌下一 stage；等价校验器只断「输入等价」。
 *  - trajectory：三组各自输出自然回灌；validator 改 lineage（只断同起点/同协议/无丢重复串线，
 *                不要求 assistantHash 相等——分叉是 treatment effect）。
 */
export type ExperimentMode = "controlled" | "trajectory"

export const EXPERIMENT_MODES: ExperimentMode[] = ["controlled", "trajectory"]

export function isExperimentMode(v: string): v is ExperimentMode {
  return (EXPERIMENT_MODES as string[]).includes(v)
}

/** golden history 中的一轮（user 或 assistant） */
export interface GoldenHistoryTurn {
  role: "user" | "assistant"
  content: string
}

/**
 * golden-history.json 顶层结构（合成、冻结、与 variant 无关）。
 * tasks[taskId][stageOrdinal].history = 该 stage 之前所有已冻结轮的 user/assistant 序列。
 * stageOrdinal 从 2 开始（第 1 阶段无历史）。
 */
export interface GoldenHistorySet {
  schemaVersion: number
  note?: string
  tasks: Record<string, Record<string, { history: GoldenHistoryTurn[] }>>
}

export const GOLDEN_HISTORY_SCHEMA_VERSION = 1

/** 冻结的历史序列（规范化为 JSON 后的 sha256），供三组逐 ordinal 比对 goldenHistoryHash */
export function goldenHistoryHash(history: GoldenHistoryTurn[]): string {
  return sha256(JSON.stringify(history.map((t) => ({ role: t.role, content: t.content }))))
}

/**
 * 加载 golden-history.json（fail-closed：schemaVersion 不匹配/结构非法即抛错）。
 */
export function loadGoldenHistory(goldenPath: string): GoldenHistorySet {
  const abs = path.resolve(goldenPath)
  if (!fs.existsSync(abs)) {
    throw new Error(`[eval-schema] golden-history.json 不存在：${abs}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(abs, "utf-8"))
  } catch (e) {
    throw new Error(`[eval-schema] golden-history.json JSON 解析失败：${(e as Error).message}`)
  }
  const root = parsed as Record<string, unknown>
  if (!root || typeof root !== "object") throw new Error("[eval-schema] golden-history.json 根节点必须是对象")
  if (root.schemaVersion !== GOLDEN_HISTORY_SCHEMA_VERSION)
    throw new Error(`[eval-schema] golden-history.json schemaVersion 不匹配：期望 ${GOLDEN_HISTORY_SCHEMA_VERSION}，实际 ${String(root.schemaVersion)}`)
  const tasks = root.tasks as Record<string, Record<string, { history: GoldenHistoryTurn[] }>> | undefined
  if (!tasks || typeof tasks !== "object") throw new Error("[eval-schema] golden-history.json 缺少 tasks")
  for (const [taskId, byOrdinal] of Object.entries(tasks)) {
    if (!byOrdinal || typeof byOrdinal !== "object")
      throw new Error(`[eval-schema] golden-history.json tasks.${taskId} 必须是对象`)
    for (const [ordinal, entry] of Object.entries(byOrdinal)) {
      const hist = entry?.history
      if (!Array.isArray(hist))
        throw new Error(`[eval-schema] golden-history.json tasks.${taskId}.${ordinal}.history 必须是数组`)
      for (const turn of hist) {
        if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.content !== "string")
          throw new Error(`[eval-schema] golden-history.json tasks.${taskId}.${ordinal} 含非法 turn`)
      }
    }
  }
  return { schemaVersion: GOLDEN_HISTORY_SCHEMA_VERSION, note: typeof root.note === "string" ? root.note : undefined, tasks }
}

/** 某 task、某 stageOrdinal 的输入历史（该 stage 之前所有已冻结轮，第 1 阶段为空） */
export function goldenHistoryForOrdinal(set: GoldenHistorySet, taskId: string, stageOrdinal: number): GoldenHistoryTurn[] {
  if (stageOrdinal <= 1) return []
  return set.tasks[taskId]?.[String(stageOrdinal)]?.history ?? []
}

/**
 * 某 task 的 stage ordinal 对应的「冻结轮」（该 stage 自身的 golden user + golden assistant）。
 * 由下一个 ordinals 的 history 末两项反推（history 交替 user/assistant）。
 * 这是 controlled 模式回灌给下一 stage 的冻结产出；最后一阶段返回 null（此后无下一阶段）。
 */
export function goldenTurnForStage(set: GoldenHistorySet, taskId: string, stageOrdinal: number): { user: GoldenHistoryTurn; assistant: GoldenHistoryTurn } | null {
  const next = set.tasks[taskId]?.[String(stageOrdinal + 1)]?.history
  if (!next || next.length < 2) return null
  const user = next[next.length - 2]
  const assistant = next[next.length - 1]
  if (user.role !== "user" || assistant.role !== "assistant") return null
  return { user, assistant }
}

// ---------------- 校验 ----------------

const CATEGORIES: TaskCategory[] = ["longform", "character-consistency", "style-transfer", "renpy", "failure-recovery"]
const MODES: TaskMode[] = ["agent", "longwrite", "style", "galgame"]

function fail(msg: string): never {
  throw new Error(`[eval-schema] 任务集校验失败：${msg}`)
}

function isStr(v: unknown): v is string {
  return typeof v === "string"
}

/** 校验单个任务对象并返回 typed 任务 */
function validateTask(raw: unknown, baseDir: string, materials: string[]): EvalTask {
  const t = raw as Record<string, unknown>
  if (!t || typeof t !== "object") fail("任务必须是对象")
  if (!isStr(t.id) || !t.id.trim()) fail("任务缺少 id")
  if (!isStr(t.title)) fail(`任务 ${t.id} 缺少 title`)
  if (!isStr(t.category) || !CATEGORIES.includes(t.category as TaskCategory))
    fail(`任务 ${t.id} 的 category 非法：${String(t.category)}（应为 ${CATEGORIES.join(" | ")}）`)
  if (!isStr(t.mode) || !MODES.includes(t.mode as TaskMode))
    fail(`任务 ${t.id} 的 mode 非法：${String(t.mode)}`)
  if (typeof t.longMode !== "boolean") fail(`任务 ${t.id} 缺少 longMode（boolean）`)
  if (typeof t.targetChars !== "number" || t.targetChars < 0) fail(`任务 ${t.id} 的 targetChars 非法`)
  if (t.variants !== "all") fail(`任务 ${t.id} 的 variants 必须为 "all"（本轮仅支持全变体）`)
  if (!isStr(t.validatorRef) || !t.validatorRef.trim()) fail(`任务 ${t.id} 缺少 validatorRef`)

  const stages = t.stages
  if (!Array.isArray(stages) || stages.length === 0) fail(`任务 ${t.id} 缺少 stages`)
  const checkedStages: EvalStage[] = stages.map((sRaw, idx) => {
    const s = sRaw as Record<string, unknown>
    if (!s || typeof s !== "object") fail(`任务 ${t.id} stages[${idx}] 必须是对象`)
    if (!isStr(s.stageId) || !s.stageId.trim()) fail(`任务 ${t.id} stages[${idx}] 缺少 stageId`)
    if (s.role !== "user" && s.role !== "assistant") fail(`任务 ${t.id} stages[${idx}] 的 role 非法`)
    if (!isStr(s.template) || s.template.length === 0) fail(`任务 ${t.id} stages[${idx}] 缺少 template`)
    const expectMinChars = s.expectMinChars
    if (expectMinChars !== undefined && (typeof expectMinChars !== "number" || expectMinChars < 0))
      fail(`任务 ${t.id} stages[${idx}] expectMinChars 非法`)
    // R24-P0-01：targetChars 必须为 finite 正数（缺失/非法/NaN/<=0 → fail-closed）
    const targetChars = s.targetChars
    if (typeof targetChars !== "number" || !Number.isFinite(targetChars) || targetChars <= 0)
      fail(`任务 ${t.id} stages[${idx}]（stageId=${String(s.stageId)}）缺少合法 targetChars：必须为 finite 正数`)
    const repeats = s.repeats
    if (repeats !== undefined && (typeof repeats !== "number" || repeats < 1 || !Number.isInteger(repeats)))
      fail(`任务 ${t.id} stages[${idx}] repeats 必须为正整数`)
    if (s.carryOver !== undefined && !isStr(s.carryOver)) fail(`任务 ${t.id} stages[${idx}] carryOver 必须为字符串`)
    return { stageId: s.stageId as string, role: s.role as "user" | "assistant", template: s.template as string, expectMinChars: expectMinChars as number | undefined, targetChars: targetChars as number, repeats: repeats as number | undefined, carryOver: s.carryOver as string | undefined }
  })
  // stageId 唯一
  const seen = new Set<string>()
  for (const s of checkedStages) {
    if (seen.has(s.stageId)) fail(`任务 ${t.id} 存在重复 stageId: ${s.stageId}`)
    seen.add(s.stageId)
  }

  // 校验 materials 引用存在
  const mats = t.materials
  if (!Array.isArray(mats)) fail(`任务 ${t.id} 缺少 materials`)
  for (const m of mats) {
    if (!isStr(m)) fail(`任务 ${t.id} materials 元素必须为字符串`)
    const abs = path.resolve(baseDir, m)
    if (!fs.existsSync(abs)) fail(`任务 ${t.id} 引用素材不存在：${m}`)
    materials.push(m)
  }

  return {
    id: t.id as string,
    category: t.category as TaskCategory,
    title: t.title as string,
    variants: "all",
    targetChars: t.targetChars as number,
    mode: t.mode as TaskMode,
    longMode: t.longMode as boolean,
    materials: mats as string[],
    stages: checkedStages,
    validatorRef: t.validatorRef as string
  }
}

/**
 * 加载并校验任务集。返回 typed EvalTaskSet；同时填充：
 * - set._baseDir（tasks.json 所在绝对目录）
 * - set.materialsHash（素材文件内容联合 sha256）
 * - set.taskHash（任务集规范化 sha256，见 schemaJsonToHash）
 * 校验失败抛错（fail-closed）。
 */
export function loadEvalTasks(tasksPath: string): EvalTaskSet & { _baseDir: string; taskHash: string; materialsHash: string } {
  const abs = path.resolve(tasksPath)
  if (!fs.existsSync(abs)) fail(`任务集文件不存在：${abs}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(abs, "utf-8"))
  } catch (e) {
    fail(`任务集 JSON 解析失败：${(e as Error).message}`)
  }
  const root = parsed as Record<string, unknown>
  if (!root || typeof root !== "object") fail("任务集根节点必须是对象")
  if (root.schemaVersion !== EVAL_TASKS_SCHEMA_VERSION)
    fail(`schemaVersion 不匹配：期望 ${EVAL_TASKS_SCHEMA_VERSION}，实际 ${String(root.schemaVersion)}`)
  if (root.id !== EVAL_TASKS_ID) fail(`任务集 id 不匹配：期望 ${EVAL_TASKS_ID}，实际 ${String(root.id)}`)
  if (!Array.isArray(root.tasks) || root.tasks.length === 0) fail("任务集缺少 tasks")

  const baseDir = path.dirname(abs)
  const materials: string[] = []
  const tasks = root.tasks.map((t) => validateTask(t, baseDir, materials))
  // 任务 id 唯一
  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) fail(`任务 id 重复：${t.id}`)
    ids.add(t.id)
  }
  // 5 类全覆盖
  const covered = new Set(tasks.map((t) => t.category))
  for (const c of CATEGORIES) {
    if (!covered.has(c)) fail(`任务集缺少类别 ${c} 的任务`)
  }

  const taskHash = schemaJsonToHash({ schemaVersion: EVAL_TASKS_SCHEMA_VERSION, id: EVAL_TASKS_ID, tasks })
  const materialsHash = materials
    .sort()
    .map((m) => createHash("sha256").update(fs.readFileSync(path.join(baseDir, m))).digest("hex"))
    .join(",") !== ""
    ? createHash("sha256").update(materials.sort().map((m) => fs.readFileSync(path.join(baseDir, m), "utf-8")).join("\u0000")).digest("hex")
    : createHash("sha256").update("").digest("hex")

  return { schemaVersion: EVAL_TASKS_SCHEMA_VERSION, id: EVAL_TASKS_ID, description: typeof root.description === "string" ? root.description : undefined, tasks, _baseDir: baseDir, taskHash, materialsHash }
}

/** 任务集的规范化哈希（schemaVersion + id + 逐任务规范化字段；供 taskSchemaHash / 版本校验） */
export function schemaJsonToHash(set: { schemaVersion: number; id: string; tasks: EvalTask[] }): string {
  const norm = tasks => tasks.map((t) => ({
    id: t.id,
    category: t.category,
    title: t.title,
    variants: t.variants,
    targetChars: t.targetChars,
    mode: t.mode,
    longMode: t.longMode,
    materials: [...t.materials].sort(),
    stages: t.stages.map((s) => ({
      stageId: s.stageId, role: s.role, template: s.template,
      expectMinChars: s.expectMinChars ?? null, targetChars: s.targetChars, repeats: s.repeats ?? null, carryOver: s.carryOver ?? null
    })),
    validatorRef: t.validatorRef
  }))
  const canonical = { schemaVersion: set.schemaVersion, id: set.id, tasks: norm(set.tasks) }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

/**
 * 规范化「任务集逐 stage target 序列」的 sha256（R24-P0-01 stage target 单一真源）。
 * 规范化口径（与 loader/expandStages 同构、确定）：
 *   - 按任务数组顺序遍历任务，按 tasks[].stages 数组顺序遍历 stage；
 *   - 每个 stage 展开 repeats 次（repeats 缺省按 1；与 expandStages 的 Math.max(1, repeats) 一致），
 *     每次展开产出一条 { taskId, stageId, targetChars }；
 *   - 对展开后的条目序列做 JSON.stringify 后取 sha256 hex。
 * 供 runner manifest 与独立 validator 重算比对，与 schemaJsonToHash 的 taskSchemaHash 相互独立：
 * schemaJsonToHash 已把 stage.targetChars 纳入 hash（重复 stage 仅记一次字段），本函数则按重复展开成序列。
 */
export function stageTargetsHash(tasks: EvalTask[]): string {
  const seq: Array<{ taskId: string; stageId: string; targetChars: number }> = []
  for (const t of tasks) {
    for (const st of t.stages) {
      const repCount = Math.max(1, st.repeats ?? 1)
      for (let n = 1; n <= repCount; n++) {
        seq.push({ taskId: t.id, stageId: st.stageId, targetChars: st.targetChars })
      }
    }
  }
  return sha256(JSON.stringify(seq))
}

// ---------------- 占位符渲染工具（供 runner 使用） ----------------

/** 渲染 stage 模板。占位符：
 *  {n}                 → 当前重复轮次（1-based）
 *  {material:rel}      → 素材文件内容
 *  {content:rel}       → 素材文件内容（同 material）
 *  {targetCharsPerChapter} → 每次分章的近似字数
 *  {carryover:stageId} → 前一指定 stage 的产出正文（从 carry 映射读取）
 */
export function renderTemplate(
  template: string,
  ctx: { n?: number; targetCharsPerChapter?: number; carry?: Record<string, string>; baseDir: string }
): string {
  return template.replace(/\{(material|content):([^}]+)\}/g, (_m, _kind, rel: string) => {
    const abs = path.resolve(ctx.baseDir, rel.trim())
    try {
      return fs.readFileSync(abs, "utf-8")
    } catch {
      return `[素材缺失:${rel}]`
    }
  }).replace(/\{carryover:([^}]+)\}/g, (_m, stageId: string) => {
    return ctx.carry?.[stageId.trim()] ?? ""
  }).replace(/\{n\}/g, String(ctx.n ?? 1))
    .replace(/\{targetCharsPerChapter\}/g, String(ctx.targetCharsPerChapter ?? 0))
}
