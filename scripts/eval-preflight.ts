// ==================== DeepWriter R19 评测基建 — Cost & Reproducibility ====================
// 职责：价格 profile、费用估算、preflight/dry-run、manifest 构建与完整性校验。
// 构建：esbuild bundle 到 out/eval-preflight.mjs（不新增依赖、不改 package.json）。
// 自测：node out/eval-preflight.mjs --selftest（selftest 逻辑只存在于 CLI main，不进导出）。
//
// 铁律（本文件遵守）：
// - 价格 profile 均为「参考配置」，显式标注 source/updatedAt，非实时抓取、非硬编码声称最新事实；
// - API key 逻辑只查「存在/不存在」布尔值，任何输出/日志/文件不得含 key 值；
// - 无 usage（null）或 profile 缺失 → cost=unknown，不得伪估为 actual。

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import { createHash } from "node:crypto"
import { expandStages as expandStagesShared } from "./eval-schema"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

// ==================== 类型 ====================

export interface PriceEntry {
  model: string
  inputPer1M: number
  outputPer1M: number
  cacheHitPer1M: number
}

export interface PriceProfile {
  schemaVersion: number
  profileId: string
  /** R25-P0-01：provider 身份（如 deepseek）；价格条目只在同 provider 的 canonical endpoint 上可信 */
  providerId: string
  /** R25-P0-01：本 profile 可信的 canonical endpoint origins（仅 scheme+host+port，禁止 path/query） */
  endpointOrigins: string[]
  currency: string
  unit: string
  source: string
  updatedAt: string
  prices: PriceEntry[]
}

export interface TokenRange {
  lo: number
  hi: number
}

export interface TaskDef {
  id: string
  desc?: string
  /** 任务类别（longform / character-consistency / style-transfer / renpy / failure-recovery） */
  category?: string
  /** [旧] 任务阶段数（legacy 兼容字段；有 stagesPlan 时忽略） */
  stages: number
  /** [旧] 每阶段模板提示词字符数（legacy 兼容字段；有 stagesPlan 时忽略） */
  templateChars?: number
  /** 目标输出字符数 */
  targetChars: number
  /** 是否需要重试（real 模式重试 1 次 → 请求上限 ×2） */
  retry?: boolean
  /** [旧] 多轮轮数（legacy 兼容字段；有 stagesPlan 时忽略） */
  rounds?: number
  /** 是否为 longwrite（多轮 completion）任务；hardened longwrite 候选据此启用 maxTurns 多轮 */
  longMode?: boolean
  /**
   * [新] 逐阶段（逐个 API 调用，repeats 已展开）计划明细。
   * 有该字段时，token 估算按逐阶段累积 transcript 精确计算；无该字段时回退 legacy 聚合估算。
   */
  stagesPlan?: StagePlanDef[]
}

/** 单个阶段调用（重复已展开）的计划输入：模板字符、注入素材字符、目标产出字符。 */
export interface StagePlanDef {
  stageId: string
  templateChars: number
  materialChars: number
  targetChars: number
}

/** 单个阶段调用的 token 估算结果（含历史 transcript 累积量，供审计逐阶段是否递增）。 */
export interface StageEstimate {
  stageId: string
  /** 前序各阶段产出 re-injected 成 input 的 token 估算（第 1 阶段恒 0） */
  historyTokens: number
  input: TokenRange
  output: TokenRange
}

/** 单个 task×variant 的逐阶段 token 明细 + 合计。 */
export interface TaskEstimate {
  taskId: string
  variantId: string
  category?: string
  /** 该 task×variant 下的阶段调用数（= plannedRequests(task)） */
  requests: number
  stages: StageEstimate[]
  input: TokenRange
  output: TokenRange
}

export interface VariantDef {
  id: string
  desc?: string
  /** 变体相对基准的 input 放大系数（如 memorypack 更省 input，可 <1） */
  inputScale?: number
  /** 变体相对基准的 output 放大系数 */
  outputScale?: number
  /** 该变体对 longwrite 任务是否做多轮 completion（hardened longwrite 候选 = true） */
  multiroundLongwrite?: boolean
}

export interface SamplePlan {
  taskId: string
  variantId: string
  /** 重复次数（同一 task×variant 的样本数） */
  repeats: number
  inputTokens: TokenRange
  outputTokens: TokenRange
  requests: TokenRange
}

export interface CostRange {
  currency: string
  total: TokenRange
  perVariant: TokenRange
}

/** 样本 usage 是否存在：present（provider 返回 usage）/ missing（provider 未返回，cost=unknown，绝不写 0）。 */
export type UsageStatus = "present" | "missing"

/** usage 覆盖率统计：present 为有 usage 的样本数，missing 为无 usage 的样本数。 */
export interface UsageCoverage {
  present: number
  missing: number
  total: number
}

/** 样本计数统计：success+failed=total；validationPassed+validationFailed=total。 */
export interface SampleCounts {
  total: number
  success: number
  failed: number
  validationPassed: number
  validationFailed: number
}

/** 产物文件哈希：samples 产物 / variants 产物的 sha256（manifest 自哈希由 validator 后置计算）。 */
export interface ArtifactHashes {
  samplesSha256: string
  variantsSha256: string
}

/** 实验模式：controlled（对照）/ trajectory（轨迹）。 */
export type ExperimentMode = "controlled" | "trajectory"

export interface RunPlan {
  samples: number
  requests: TokenRange
  tokens: { input: TokenRange; output: TokenRange }
  estDurationMinutes: TokenRange
  cost: CostRange | "unknown"
  assumptions: string[]
  /** 理想无重试请求总数（= Σ tasks × variants × repeats，与 requests.lo 一致） */
  plannedRequests: number
  /** runner 外层重试预算（重试 1 次 → = plannedRequests；即 requests.hi - plannedRequests） */
  outerRetriesBudget: number
  /** adapter 内层重试预算（deepseek.ts streamChat MAX_RETRIES=1，仅 !receivedAny 时重试；另行计，不并入 requests.hi） */
  innerRetriesBudget: number
  /**
   * ==================== R05 all-in 费用上界（variant 感知） ====================
   * 覆盖 completion 多轮（hardened longwrite maxTurns）+ outer retry + inner retry。
   */
  /** 每 stage 基础 1 次 provider call × variants × repeats（= plannedRequests；多轮/重试前的基础调用数） */
  baseProviderCalls: number
  /** completion 多轮的 provider call 总数（hardened longwrite 每 stage=ΣmaxTurns；current/generic=1/轮） */
  maxCompletionRounds: number
  /** 外层重试额外 provider call 上限（MAX_ATTEMPTS real=2 → 每 stage 额外重跑全部 completion 轮 1 次） */
  maxOuterRetryCalls: number
  /** 内层重试额外 provider call 上限（MAX_RETRIES=1 → 每 provider call 额外 1 次） */
  maxInnerRetryCalls: number
  /** all-in 请求上界 = Σ_stage [rounds × (1+inner) × (1+outer)] × variants × repeats（见 estimateRunPlan 注释） */
  allInRequestMax: number
  /** all-in token 上界（按 stage target 与历史回灌公式，含多轮 output × retry 放大） */
  allInInputTokens: TokenRange
  allInOutputTokens: TokenRange
  /** all-in 费用上界（使用现有价格 profile 单价，输入+输出） */
  allInCostCny: CostRange | "unknown"
  /** 逐 task×variant 明细（含逐 stage） */
  perTask: TaskEstimate[]
  /** 逐 variant → 逐 task → 逐 stage 的 all-in 分解（cap 推导自真实 maxTurns；重试缩放前口径） */
  perVariantAllIn: VariantAllIn[]
}

/** 单个 stage 的 all-in 分解（重试缩放前）。 */
export interface VariantStageAllIn {
  stageId: string
  /** 该 stage 的 provider-call cap：generic=1；current=maxTurns=6；hardened=任务 longMode 决定的 maxTurns */
  cap: number
  /** 该 stage 的 completion 轮数（= cap；工具循环/continuation 不含额外 provider call） */
  rounds: number
  /** 该 stage 内逐轮历史回灌后的 input 上界（= C×首轮input.hi + maxTokens×C(C-1)/2，重试缩放前） */
  inputHi: number
  /** 该 stage output 上界（= C×maxTokens，重试缩放前） */
  outputHi: number
}

/** 单个 task 的 all-in 分解（重试缩放前）。 */
export interface VariantTaskAllIn {
  taskId: string
  stages: VariantStageAllIn[]
}

/** 单个 variant 的 all-in 逐 task 分解。 */
export interface VariantAllIn {
  variantId: string
  tasks: VariantTaskAllIn[]
}

export interface EvalManifest {
  schemaVersion: number
  commit: string
  dirtyFiles: string[]
  nodeVersion: string
  electronVersion: string | null
  platform: string
  taskSchemaHash: string
  variantContractHashes: Record<string, string>
  runnerSourceHash: string
  seed: number
  argv: string[]
  synthetic: boolean
  real: boolean
  startedAt: string
  finishedAt: string
  priceProfileHash: string
  priceProfileId: string
  model: string
  repeats: number
  tasks: Array<{ id: string; targetChars: number; stages: number }>
  variants: Array<{ id: string }>
  /** 实际耗时（ms）= finishedAt - startedAt；与时间戳一致性在 manifestValidate 校验 */
  durationMs: number
  /** 理想无重试请求总数（plan 口径） */
  plannedRequests: number
  /** 实际发出的请求数（runner 落盘时统计） */
  actualRequests: number
  /** 实际发生的外层重试次数（runner 落盘时统计） */
  outerRetries: number
  /** 实际发生的 adapter 内层重试次数（runner 落盘时统计） */
  innerRetries: number
  /** usage 覆盖率统计 */
  usageCoverage: UsageCoverage
  /** requestTraces 序列 sha256（由 S1 的 runner 计算好传入） */
  requestTraceHash: string
  /** 实验模式（controlled/trajectory）——本轮起必填 */
  experimentMode: ExperimentMode
  /** 样本计数统计（success+failed=total；validationPassed+validationFailed=total）——必填 */
  sampleCounts: SampleCounts
  /** 产物文件哈希（samplesSha256/variantsSha256，各 64-hex）——必填 */
  artifactHashes: ArtifactHashes
  /** R25-P1-03：目标字数缩放系数（validator 据此重算 executionTarget=round(declared*scale)） */
  scale: number
}

export interface ManifestBuildArgs {
  schemaVersion?: number
  commit: string
  dirtyFiles?: string[]
  nodeVersion: string
  electronVersion?: string | null
  platform: string
  taskSchemaHash: string
  variantContractHashes: Record<string, string>
  runnerSourceHash: string
  seed: number
  argv?: string[]
  synthetic: boolean
  real: boolean
  /** 评测开始时间戳（第一项工作之前记录，非执行结束后的临时 new Date()） */
  startedAt: string
  /** 评测结束时间戳（全部落盘与校验完成后记录） */
  finishedAt: string
  priceProfileHash: string
  priceProfileId: string
  model: string
  repeats: number
  tasks: Array<{ id: string; targetChars: number; stages: number }>
  variants: Array<{ id: string }>
  /** 可选：显式指定耗时；缺省时由 startedAt/finishedAt 计算 */
  durationMs?: number
  plannedRequests?: number
  actualRequests?: number
  outerRetries?: number
  innerRetries?: number
  usageCoverage?: UsageCoverage
  requestTraceHash?: string
  experimentMode?: ExperimentMode
  sampleCounts?: SampleCounts
  artifactHashes?: ArtifactHashes
  /** R25-P1-03：目标字数缩放系数（缺省 1） */
  scale?: number
}

export interface ScanHit {
  file: string
  pattern: string
  matched: string
}

export interface SampleUsage {
  inputTokens?: number | null
  outputTokens?: number | null
  cacheHitTokens?: number | null
  cacheMissTokens?: number | null
  prompt_tokens?: number | null
  completion_tokens?: number | null
  prompt_cache_hit_tokens?: number | null
  prompt_cache_miss_tokens?: number | null
}

export interface SampleCost {
  /** actual：cache miss 部分按普通 input 价（R25-P1-02 修正，不再 double-count） */
  input: number
  output: number
  cacheHit: number
  total: number
  /** 本请求 actual 是否可按 provider 字段一致推导（矛盾/负数/NaN/hit>prompt → false） */
  actualKnown: boolean
  /** 保守 upper：全部 prompt 按普通 input 价 + completion 按 output 价（与 actual 分栏，供 cap 对账） */
  upper: number
}

// ==================== 价格 profile：加载 / 校验 / 哈希 ====================

/**
 * 默认 profile 路径：优先 scripts/eval-prices.json（源码同目录）；bundle 到 out/ 后 __dirname 会变，
 * 故依次尝试多个候选，任一命中即返回。
 */
function defaultProfilePath(): string {
  const candidates = [
    path.resolve(__dirname, "eval-prices.json"),
    path.resolve(__dirname, "..", "scripts", "eval-prices.json"),
    path.resolve(process.cwd(), "scripts", "eval-prices.json")
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]
}

/** 加载价格 profile；缺文件/解析失败/校验不过 → null（调用方 cost=unknown 回退，不崩）。 */
export function loadPriceProfile(filePath?: string): PriceProfile | null {
  const p = filePath ?? defaultProfilePath()
  let raw: string
  try {
    raw = fs.readFileSync(p, "utf-8")
  } catch {
    return null
  }
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  const profile = obj as PriceProfile
  const v = priceProfileValidate(profile)
  if (!v.ok) return null
  return profile
}

/** 确定性 sha256（字段序稳定：按固定路径逐个取字段拼 JSON，不以对象键序遍历）。 */
export function priceProfileHash(p: PriceProfile): string {
  const canon = {
    schemaVersion: p.schemaVersion,
    profileId: p.profileId,
    providerId: p.providerId,
    endpointOrigins: [...p.endpointOrigins].sort(),
    currency: p.currency,
    unit: p.unit,
    source: p.source,
    updatedAt: p.updatedAt,
    prices: p.prices.map((e) => ({
      model: e.model,
      inputPer1M: e.inputPer1M,
      outputPer1M: e.outputPer1M,
      cacheHitPer1M: e.cacheHitPer1M
    }))
  }
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex")
}

const ALLOWED_CURRENCIES = ["CNY", "USD", "EUR", "JPY", "GBP"]
const ALLOWED_UNITS = ["per-1M-tokens", "per-1K-tokens", "per-token"]
/** canonical origin：仅 scheme + host + port，禁止 path/query/userinfo（R25-P0-01/P0-03）。 */
export const CANONICAL_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9._~-]+(?::\d{1,5})?$/

/** 校验 price profile：缺字段/币种非法/单位非法/负价格/origin 非 canonical → FAIL（红灯 7 用）。 */
export function priceProfileValidate(p: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  if (typeof p !== "object" || p === null) {
    return { ok: false, errors: ["profile is not an object"] }
  }
  const o = p as Record<string, unknown>
  if (o.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  if (typeof o.profileId !== "string" || !o.profileId) errors.push("profileId must be a non-empty string")
  // R25-P0-01：providerId / endpointOrigins 必填；origin 必须 canonical（scheme+host+port，无 path/query）
  if (typeof o.providerId !== "string" || !o.providerId) errors.push("providerId must be a non-empty string")
  if (!Array.isArray(o.endpointOrigins) || o.endpointOrigins.length === 0) {
    errors.push("endpointOrigins must be a non-empty array of canonical origins")
  } else {
    o.endpointOrigins.forEach((v, i) => {
      if (typeof v !== "string" || !CANONICAL_ORIGIN_RE.test(v)) {
        errors.push(`endpointOrigins[${i}] must be a canonical origin (scheme+host+port only, no path/query; got ${JSON.stringify(v)})`)
      }
    })
  }
  if (typeof o.currency !== "string" || !ALLOWED_CURRENCIES.includes(o.currency)) {
    errors.push(`currency invalid (got ${JSON.stringify(o.currency)}; allowed ${ALLOWED_CURRENCIES.join("/")})`)
  }
  if (typeof o.unit !== "string" || !ALLOWED_UNITS.includes(o.unit)) {
    errors.push(`unit invalid (got ${JSON.stringify(o.unit)}; allowed ${ALLOWED_UNITS.join("/")})`)
  }
  if (typeof o.source !== "string" || !o.source) errors.push("source must be a non-empty string")
  if (typeof o.updatedAt !== "string" || !o.updatedAt) errors.push("updatedAt must be a non-empty string")
  if (!Array.isArray(o.prices) || o.prices.length === 0) {
    errors.push("prices must be a non-empty array")
    return { ok: false, errors }
  }
  const seenModels = new Set<string>()
  o.prices.forEach((e, i) => {
    const it = e as Record<string, unknown>
    if (typeof it !== "object" || it === null) {
      errors.push(`prices[${i}] is not an object`)
      return
    }
    if (typeof it.model !== "string" || !it.model) errors.push(`prices[${i}].model must be a non-empty string`)
    else if (seenModels.has(it.model)) errors.push(`prices[${i}].model duplicates ${it.model}（同 profile 内模型必须唯一，禁止歧义条目）`)
    else seenModels.add(it.model)
    for (const f of ["inputPer1M", "outputPer1M", "cacheHitPer1M"]) {
      const v = it[f]
      if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`prices[${i}].${f} must be a finite number`)
      else if (v < 0) errors.push(`prices[${i}].${f} must not be negative (got ${v})`)
    }
  })
  return { ok: errors.length === 0, errors }
}

// ==================== R25-P0-01：精确价格匹配（禁止首条回退） ====================

export interface PriceMatchOk {
  ok: true
  entry: PriceEntry
  providerId: string
  /** 匹配命中的 canonical origin（profile 内条目，非请求侧字符串） */
  trustedOrigin: string
}

export interface PriceMatchFail {
  ok: false
  reason: string
}

export type PriceMatch = PriceMatchOk | PriceMatchFail

/**
 * 精确匹配价格条目：provider + canonical endpoint origin + 精确 model + currency 四者全等才算可信。
 * 禁止回退 prices[0]、相近模型或跨 provider 价格（R25-P0-01）。
 * @param expectedCurrency 期望币种（--max-cost-cny 时为 "CNY"）；不传则不校验币种（仅一致性用途）。
 */
export function matchPriceEntry(profile: PriceProfile | null, model: string, endpointOrigin: string, expectedCurrency?: string): PriceMatch {
  if (!profile) return { ok: false, reason: "price-profile-missing" }
  if (typeof endpointOrigin !== "string" || !CANONICAL_ORIGIN_RE.test(endpointOrigin)) {
    return { ok: false, reason: `endpoint-origin-not-canonical:${endpointOrigin}` }
  }
  if (!profile.endpointOrigins.includes(endpointOrigin)) {
    return { ok: false, reason: `endpoint-origin-not-trusted:${endpointOrigin}（profile ${profile.profileId} 只信任 ${profile.endpointOrigins.join(" / ")}）` }
  }
  const entry = profile.prices.find((e) => e.model === model)
  if (!entry) {
    return { ok: false, reason: `model-not-priced:${model}（profile ${profile.profileId} 无该模型的精确条目，禁止首条/相近模型回退）` }
  }
  if (expectedCurrency !== undefined && profile.currency !== expectedCurrency) {
    return { ok: false, reason: `currency-mismatch:profile=${profile.currency},expected=${expectedCurrency}` }
  }
  return { ok: true, entry, providerId: profile.providerId, trustedOrigin: endpointOrigin }
}

// ==================== R25-P1-01：输入 reservation 的可证明 byte/token ceiling ====================

/** 无官方 tokenizer 时的 provider chat-template framing 常数（显式假设，入 manifest.inputCeiling 供审计）。 */
export const FRAMING_TOKENS_BASE = 64
export const FRAMING_TOKENS_PER_MESSAGE = 16

/**
 * 输入 token ceiling（无官方 tokenizer 口径）：
 *   ceiling = utf8ByteLength(bodyJson) + FRAMING_TOKENS_BASE + FRAMING_TOKENS_PER_MESSAGE × messages.length
 * 论证：完整 request body 的 UTF-8 字节数 ≥ 全体 message 内容字符数（UTF-8 每字符 ≥1 字节，JSON 还含
 * role/包装/转义开销）；任何 token 都至少覆盖 1 字节，故 token 数 ≤ 字节数；chat template 的特殊
 * token/分隔符以固定常数兜底。emoji/组合字符/稀见 Unicode/tool schema/JSON 转义全部包含在 body 字节内。
 */
export function utf8BodyTokenCeiling(bodyJson: string): { bytes: number; messages: number; ceiling: number } {
  const bytes = Buffer.byteLength(bodyJson, "utf-8")
  let messages = 0
  try {
    const parsed = JSON.parse(bodyJson) as { messages?: unknown }
    if (Array.isArray(parsed.messages)) messages = parsed.messages.length
  } catch {
    messages = 0
  }
  const ceiling = bytes + FRAMING_TOKENS_BASE + FRAMING_TOKENS_PER_MESSAGE * messages
  return { bytes, messages, ceiling }
}

// ==================== 阶段展开（跨组接口：S1 在 eval-schema.ts 落地 expandStages） ====================

/** 阶段的最小形状（preflight 侧自定义，与 eval-schema 的 EvalStage 语义同构）。 */
export interface EvalStageLike {
  stageId: string
  template?: string
  repeats?: number
  expectMinChars?: number
  /** 本阶段输出目标字数（scale 缩放前）；R04 起为 tasks.json 的单一真源 */
  targetChars?: number
}

/** 任务的最小形状（preflight 侧自定义，与 eval-schema 的 EvalTask 语义同构）。 */
export interface EvalTaskLike {
  id: string
  category?: string
  targetChars?: number
  longMode?: boolean
  stages: EvalStageLike[]
}

/**
 * 阶段展开统一接口（R20 主代理整合）：委托 eval-schema.ts 的 expandStages（runner 与 preflight 同一展开口径），
 * 仅做 EvalTaskLike → EvalStage 的最小形状适配。longform=4 / character=6 / style=2 / renpy=1 / failure=2。
 */
export function expandStages(task: EvalTaskLike): Array<{ stageId: string; n: number }> {
  return expandStagesShared({
    stages: task.stages.map((s) => ({ stageId: s.stageId, role: "user" as const, template: s.template ?? "", repeats: s.repeats, expectMinChars: s.expectMinChars, targetChars: s.targetChars }))
  })
}

/** 单个任务的计划请求数（= expandStages(task).length，longform=4 / character=6 / style=2 / renpy=1 / failure=2）。 */
export function plannedRequests(task: EvalTaskLike): number {
  return expandStages(task).length
}

/** 全部任务 × variants × repeats 的理想无重试请求总数（= Σ plannedRequests(task) × variantCount × repeats）。 */
export function plannedRequestsAll(tasks: EvalTaskLike[], variantCount: number, repeats: number): number {
  const perTask = tasks.reduce((a, t) => a + plannedRequests(t), 0)
  return perTask * Math.max(0, Math.floor(variantCount)) * Math.max(0, Math.floor(repeats))
}

// ==================== 逐阶段 token 估算（修复 R19-R02：删除 stages×templateChars×rounds 相乘歧义） ====================

const CHARS_PER_INPUT_TOKEN = 3 // 中文约 3 字符/ token（模板与素材的粗略换算）
const OUTPUT_TOKENS_PER_CHAR = 1.1 // 每中文字符约 1.1 token（含标点/结构余量）
const INPUT_BAND = { lo: 0.7, hi: 1.3 } // input 区间上下界系数
const OUTPUT_BAND = { lo: 0.9, hi: 1.2 } // output 区间上下界系数

/**
 * 单个 task 逐阶段 token 估算（累积 transcript）。
 *
 * 口径（显式声明为「估算」，非 measured）：
 * - 每个阶段调用 input = 模板字符/3 + 注入素材字符/3 + 历史 transcript token；
 * - 历史 transcript：第 k 阶段 input 包含前 k-1 阶段产出的 token 估算（历史按各阶段 targetChars 累加后 /3 折算），
 *   使「第 k 阶段 input > 第 1 阶段 input」恒成立（多轮回灌成本如实放大后序阶段）；
 * - output = 该阶段 targetChars × 1.1 token/字（targetChars=0 时用模板+素材字符的 0.5 兜底，避免 0 区间）；
 * - variant 缩放系数（inputScale/outputScale）默认 1。
 *
 * 已删除旧实现的「stages × templateChars × rounds」相乘逻辑（它把已聚合量再相乘，导致 token 区间扭曲）。
 */
export function estimateTaskTokens(
  taskId: string,
  stagesPlan: StagePlanDef[],
  scale?: { input?: number; output?: number }
): { stages: StageEstimate[]; input: TokenRange; output: TokenRange } {
  const inScale = scale?.input ?? 1
  const outScale = scale?.output ?? 1
  const stages: StageEstimate[] = []
  let historyChars = 0
  let inLo = 0
  let inHi = 0
  let outLo = 0
  let outHi = 0

  for (const sp of stagesPlan) {
    const templateTokens = Math.max(0, sp.templateChars) / CHARS_PER_INPUT_TOKEN
    const materialTokens = Math.max(0, sp.materialChars) / CHARS_PER_INPUT_TOKEN
    const historyTokens = Math.round(historyChars / CHARS_PER_INPUT_TOKEN)

    const inputMid = Math.max(1, Math.round((templateTokens + materialTokens + historyTokens) * inScale))
    const inputLo = Math.max(1, Math.round(inputMid * INPUT_BAND.lo))
    const inputHi = Math.max(inputLo, Math.round(inputMid * INPUT_BAND.hi))

    const outMid = sp.targetChars > 0 ? sp.targetChars * OUTPUT_TOKENS_PER_CHAR : Math.max(1, (sp.templateChars + sp.materialChars) * 0.5)
    const outputLo = Math.max(1, Math.round(outMid * OUTPUT_BAND.lo * outScale))
    const outputHi = Math.max(outputLo, Math.round(outMid * OUTPUT_BAND.hi * outScale))

    stages.push({
      stageId: sp.stageId,
      historyTokens,
      input: { lo: inputLo, hi: inputHi },
      output: { lo: outputLo, hi: outputHi }
    })

    // 本轮产出回灌：按 targetChars（0 时按模板+素材的 0.5 兜底）累加到历史 transcript
    historyChars += sp.targetChars > 0 ? sp.targetChars : Math.max(0, (sp.templateChars + sp.materialChars) * 0.5)

    inLo += inputLo
    inHi += inputHi
    outLo += outputLo
    outHi += outputHi
  }

  return { stages, input: { lo: inLo, hi: inHi }, output: { lo: outLo, hi: outHi } }
}

/**
 * 从 TaskDef 构造逐阶段计划（stagesPlan）。有显式 stagesPlan 时原样返回；
 * 否则由 legacy 聚合字段（stages/templateChars/rounds）重建为等规模单一阶段（不再相乘，仅作兼容，
 * 供旧调用方保持可运行——结果仅用于占位，真实评测应走 stagesPlan 富路径）。
 */
function resolveStagesPlan(t: TaskDef): StagePlanDef[] {
  if (t.stagesPlan && t.stagesPlan.length > 0) return t.stagesPlan
  const n = Math.max(1, Math.floor(t.stages || 1))
  const templateChars = Math.max(0, t.templateChars ?? 0)
  const targetChars = Math.max(0, t.targetChars ?? 0)
  const perStageChars = Math.round(templateChars / n)
  const perStageTarget = Math.round(targetChars / n)
  const out: StagePlanDef[] = []
  for (let i = 0; i < n; i++) {
    out.push({ stageId: `legacy-stage-${i + 1}`, templateChars: perStageChars, materialChars: 0, targetChars: perStageTarget })
  }
  return out
}

// ==================== 运行计划（RunPlan） ====================

const REQUEST_RETRY_MULTIPLIER_REAL = 2 // runner 外层重试 1 次 → 请求上限 ×2（理想无重试时 requests.lo = plannedRequests）
const THROUGHPUT_TOK_PER_SEC = { lo: 20, hi: 60 } // 假设吞吐区间（tok/s），见 assumptions
const INNER_RETRY_MAX = 1 // adapter 内层重试上限（deepseek.ts streamChat MAX_RETRIES=1，仅 !receivedAny 时重试；generic 无内层，见 innerRetryForVariant）
const OUTER_RETRY_MAX = 1 // runner 外层重试额外次数上限（MAX_ATTEMPTS real=2 → 额外 1 次）
const COMPLETION_CHARS_PER_ROUND = 1000 // longwrite 保守轮数预算：短轮模型每轮至少按 1000 code point 推导
const COMPLETION_MIN_ROUNDS = 4 // longwrite 最少 completion 轮数（executionSnapshot maxTurns 下界）
const COMPLETION_MAX_ROUNDS = 128 // 与 executionSnapshot 的极长目标安全上限一致
// executionSnapshot.ts：deriveLongwriteMaxTurns = min(128, max(4, ceil(targetChars/1000)))
const MAX_TURNS_NON_LONGWRITE = 6 // 非 longwrite 时 engine 的 maxTurns 兜底（executionSnapshot.ts L179）
// 每 completion 轮 output 上界 = runner sampling.maxTokens（eval-variants.ts DEFAULT_SAMPLING.maxTokens = 8192）
const MAX_OUTPUT_TOKENS_PER_ROUND = 8192

/**
 * R24 P1-01：单个 stage 的 provider-call cap（真实 cap 推导，非 R23 的「1 次调用」近似）。
 *
 * 核实依据（见报告）：
 * - engine doCycle（AgentRunEngine.ts L493-507）：每轮 1 次 provider call，`rounds > maxTurns` 即 finalize max_turns；
 *   工具循环（L721 continue）、continueOnLength（L723）、completion continuation（L764 !gate→continue）全部
 *   走同一 doCycle 循环、共享 rounds 计数器，故每 stage provider-call cap = maxTurns。
 * - getConfig(runId) = buildExecutionSnapshot 产物，顶层含 maxTurns 字段（executionSnapshot.ts L261）；
 *   engine 读 getConfig(runId).maxTurns ?? 12（L496）——实际读到快照顶层 maxTurns，兜底 12 永不触发。
 * - 三 variant 口径（eval-runner.ts L1187-1189）：
 *     generic_baseline            → 直连单次 fetch（无 engine），cap = 1，无内层重试；
 *     deepwriter_current_product  → engine，mode=agent 且 longMode 强制 false → maxTurns = 6；
 *     deepwriter_hardened_candidate → engine，longMode = task.longMode → maxTurns = longMode ? min(128, max(4, ceil/1000)) : 6。
 */
function providerCallCapPerStage(variantId: string, stageTargetChars: number, taskLongMode: boolean): number {
  const tc = Math.max(0, stageTargetChars)
  if (variantId === "generic_baseline") return 1 // 直连单次 fetch，无 engine 多轮
  if (variantId === "deepwriter_current_product") return MAX_TURNS_NON_LONGWRITE // longMode 强制 false → 6
  // deepwriter_hardened_candidate（及任何未知 deepwriter-ish id 兜底）：
  return taskLongMode
    ? Math.min(COMPLETION_MAX_ROUNDS, Math.max(COMPLETION_MIN_ROUNDS, Math.ceil(tc / COMPLETION_CHARS_PER_ROUND)))
    : MAX_TURNS_NON_LONGWRITE
}

/**
 * adapter 内层重试次数（真实口径）：generic 直连无内层重试（eval-variants.ts streamOpenAiCompatible 注释
 * 「generic 无内层重试，innerAttempt 恒 1」）；deepwriter 走 deepseek.ts streamChat MAX_RETRIES=1
 * （仅 !receivedAny 且 retryable 时重试 1 次）。
 */
function innerRetryForVariant(variantId: string): number {
  return variantId === "generic_baseline" ? 0 : 1
}

/**
 * 汇总一次评测运行的估算计划（R24 P1-01 重写：all-in 上界从真实 cap 推导，不再预设 1 或 264）。
 *
 * 请求口径：
 * - samples = Σ(task × variant × repeats)：实验单元数（一个 task 一次完整多阶段运行为 1 样本）；
 * - plannedRequests = Σ plannedRequests(task) × variantCount × repeats（= 45 × repeats，repeats=1 → 45）；
 * - requests.lo = plannedRequests（理想无重试、单轮）；requests.hi = allInRequestMax（见下）。
 *
 * all-in 上界推导（每 stage s 的 provider-call cap = C(s) = providerCallCapPerStage(variant, targetChars, longMode)）：
 *   per stage provider call 上界 = C(s) × (1 + inner) × (1 + outer)
 *   allInRequestMax = Σ_variant Σ_stage [C(s) × (1+inner(v)) × (1+outer)] × repeats
 * 其中 inner(v) = innerRetryForVariant(variant)=generic 0 / deepwriter 1，
 *      outer = (retry ? OUTER_RETRY_MAX : 0) = 1（每 stage 额外重跑全部 completion 轮 1 次）。
 * 分解恒等式（新口径下仍成立）：allInRequestMax = maxCompletionRounds + maxOuterRetryCalls + maxInnerRetryCalls
 *   - maxCompletionRounds = Σ C(s) × variants × repeats（cap 驱动的 base 调用数）
 *   - maxOuterRetryCalls = Σ C(s)×outer × variants × repeats
 *   - maxInnerRetryCalls = Σ C(s)×(1+outer)×inner(v) × variants × repeats
 *
 * all-in token 上界（stage 内历史增长入 input，R24 P1-01 新增）：
 *   每 stage C 轮；第 r 轮 input 上界 = 首轮 input.hi + (r-1)×maxTokens（前 r-1 轮产出回灌），
 *   每轮 output 上界 = maxTokens。故（重试缩放前）：
 *     inputHi(s)  = C×首轮input.hi + maxTokens×C(C-1)/2
 *     outputHi(s) = C×maxTokens
 *   再 ×(1+inner)(1+outer)×repeats。lo 侧以每轮 output lo=1 兜底对称（hi 为有意义的上界）。
 */
export function estimateRunPlan(tasks: TaskDef[], variants: VariantDef[], repeats: number, profile: PriceProfile | null, model: string = "deepseek-v4-flash"): RunPlan {
  const assumptions: string[] = [
    "input token 按逐阶段 (模板字符/3 + 素材字符/3 + 历史 transcript) 估算，±30%",
    "历史 transcript 按前序阶段 targetChars 累加 /3 折算（第 k 阶段 input 含前 k-1 轮产出回灌）",
    "output token 按逐阶段 targetChars × 1.1 token/字 估算，-10%/+20%",
    "请求数 = 逐阶段调用数 × variants × repeats（理想无重试）；requests.hi = all-in 上界（含 cap 多轮 + outer + inner retry）",
    "每 stage provider-call cap 按真实 engine maxTurns 推导：generic=1、current=6、hardened=longMode?min(128,max(4,ceil(targetChars/1000))):6（executionSnapshot.ts deriveLongwriteMaxTurns）",
    "stage 内逐轮历史回灌入 input 上界：第 r 轮 input = 首轮 input + (r-1)×maxTokens（每轮 output 上界 = maxTokens = sampling.maxTokens 8192）",
    "时长按吞吐 20–60 tok/s 估算（假设区间，非实测）",
    "价格 profile 为参考配置（非实时抓取），币种/单位以 profile 声明为准"
  ]

  const n = Math.max(0, Math.floor(repeats))
  // 先算每 task×variant 的明细，再汇总
  const perTask: TaskEstimate[] = []
  const perVariantAllIn: VariantAllIn[] = []
  let samples = 0
  let planned = 0
  let reqLo = 0
  let reqHi = 0
  let inLo = 0
  let inHi = 0
  let outLo = 0
  let outHi = 0

  // all-in 累积器
  let maxCompletionRounds = 0
  let maxOuterRetryCalls = 0
  let maxInnerRetryCalls = 0
  let allInRequestMax = 0
  let allInInLo = 0
  let allInInHi = 0
  let allInOutLo = 0
  let allInOutHi = 0

  for (const v of variants) {
    const variantAllIn: VariantAllIn = { variantId: v.id, tasks: [] }
    for (const t of tasks) {
      const stagesPlan = resolveStagesPlan(t)
      const perTaskReq = stagesPlan.length
      const est = estimateTaskTokens(t.id, stagesPlan, { input: v.inputScale, output: v.outputScale })
      const reqForUnit = perTaskReq * n
      const retry = t.retry === true
      const outerMult = retry ? REQUEST_RETRY_MULTIPLIER_REAL : 1 // 1 + outer（retry=false 则无外层重试）
      const inner = innerRetryForVariant(v.id)
      const innerMult = 1 + inner // 1 + inner（generic 内层=0）
      samples += n
      planned += reqForUnit
      reqLo += reqForUnit

      // all-in：逐 stage 累加 cap 轮数与 token 放大（含 stage 内逐轮历史回灌）
      let variantRounds = 0
      let variantAllInReq = 0
      let variantAllInInLo = 0
      let variantAllInInHi = 0
      let variantAllInOutLo = 0
      let variantAllInOutHi = 0
      const taskStagesAllIn: VariantStageAllIn[] = []
      for (let i = 0; i < est.stages.length; i++) {
        const stageTarget = stagesPlan[i]?.targetChars ?? 0
        const cap = providerCallCapPerStage(v.id, stageTarget, t.longMode === true)
        const sest = est.stages[i]
        // 重试缩放前：每 stage C 轮，第 r 轮 input = 首轮 input + (r-1)×maxTokens，output 每轮 = maxTokens
        const tri = cap * (cap - 1) / 2 // Σ_{r=1..C}(r-1)
        const stageInHi = cap * sest.input.hi + MAX_OUTPUT_TOKENS_PER_ROUND * tri
        const stageInLo = cap * sest.input.lo + tri // output lo=1 兜底
        const stageOutHi = cap * MAX_OUTPUT_TOKENS_PER_ROUND
        const stageOutLo = cap * 1
        const retryMult = innerMult * outerMult

        variantRounds += cap
        variantAllInReq += cap * retryMult
        variantAllInInLo += stageInLo * retryMult
        variantAllInInHi += stageInHi * retryMult
        variantAllInOutLo += stageOutLo * retryMult
        variantAllInOutHi += stageOutHi * retryMult
        taskStagesAllIn.push({ stageId: sest.stageId, cap, rounds: cap, inputHi: stageInHi, outputHi: stageOutHi })
      }
      maxCompletionRounds += variantRounds * n
      maxOuterRetryCalls += variantRounds * (outerMult - 1) * n
      maxInnerRetryCalls += variantRounds * outerMult * (innerMult - 1) * n
      allInRequestMax += variantAllInReq * n
      allInInLo += variantAllInInLo * n
      allInInHi += variantAllInInHi * n
      allInOutLo += variantAllInOutLo * n
      allInOutHi += variantAllInOutHi * n

      inLo += n * est.input.lo
      inHi += n * est.input.hi
      outLo += n * est.output.lo
      outHi += n * est.output.hi
      perTask.push({
        taskId: t.id,
        variantId: v.id,
        category: t.category,
        requests: perTaskReq,
        stages: est.stages,
        input: est.input,
        output: est.output
      })
      variantAllIn.tasks.push({ taskId: t.id, stages: taskStagesAllIn })
    }
    perVariantAllIn.push(variantAllIn)
  }

  // requests.hi = all-in 上界（含 completion 多轮 + outer + inner retry）
  reqHi = allInRequestMax

  // 外层 retry 预算 = 理想无重试请求数（重试 1 次上限，下界 0 = 理想无重试）
  const outerRetriesBudget = planned
  // 内层 retry 预算：each outer request may retry INNER_RETRY_MAX times when !receivedAny
  const innerRetriesBudget = planned * INNER_RETRY_MAX

  // 时长：output token 总量 / 吞吐；吞吐区间反转后 lo/hi 对应 hi/lo
  const durLoMin = outLo > 0 ? outLo / THROUGHPUT_TOK_PER_SEC.hi / 60 : 0
  const durHiMin = outHi > 0 ? outHi / THROUGHPUT_TOK_PER_SEC.lo / 60 : 0
  const estDurationMinutes: TokenRange = {
    lo: Math.round(durLoMin * 10) / 10,
    hi: Math.round(durHiMin * 10) / 10
  }

  const cost = computePlanCost(inLo, inHi, outLo, outHi, profile, model)
  const allInCostCny = computePlanCost(allInInLo, allInInHi, allInOutLo, allInOutHi, profile, model)

  return {
    samples,
    requests: { lo: reqLo, hi: reqHi },
    tokens: { input: { lo: inLo, hi: inHi }, output: { lo: outLo, hi: outHi } },
    estDurationMinutes,
    cost,
    assumptions,
    plannedRequests: planned,
    outerRetriesBudget,
    innerRetriesBudget,
    baseProviderCalls: planned,
    maxCompletionRounds,
    maxOuterRetryCalls,
    maxInnerRetryCalls,
    allInRequestMax,
    allInInputTokens: { lo: allInInLo, hi: allInInHi },
    allInOutputTokens: { lo: allInOutLo, hi: allInOutHi },
    allInCostCny,
    perTask,
    perVariantAllIn
  }
}

function computePlanCost(inLo: number, inHi: number, outLo: number, outHi: number, profile: PriceProfile | null, model?: string): CostRange | "unknown" {
  if (!profile) return "unknown"
  if (profile.unit !== "per-1M-tokens") return "unknown"
  // R25-P0-01：精确 model 匹配，禁止回退首条/相近模型
  const entry = profile.prices.find((e) => e.model === model)
  if (!entry) return "unknown"
  // 总成本 = input×input价 + output×output价（cache hit 单独口径见 computeSampleCost）
  const totalLo = (inLo * entry.inputPer1M + outLo * entry.outputPer1M) / 1_000_000
  const totalHi = (inHi * entry.inputPer1M + outHi * entry.outputPer1M) / 1_000_000
  // perVariant 为区间（非标量），取上/下界各自的半区间（单变体时与 total 一致）
  const round2 = (x: number): number => Math.round(x * 100) / 100
  return {
    currency: profile.currency,
    total: { lo: round2(totalLo), hi: round2(totalHi) },
    perVariant: { lo: round2(totalLo), hi: round2(totalHi) }
  }
}

// ==================== 样本实际成本 ====================

/**
 * 计算单样本实际成本。无 usage（null）/profile 缺失/模型无精确条目 → "unknown"，绝不伪造 actual。
 * R25-P1-02 公式修正：不得再算 prompt×input + hit×cacheHit（hit 已含于 prompt，属双计）。
 * 优先口径：miss×input + hit×cacheHit + completion×output；hit+miss==prompt 才称 actual；
 * 只有 prompt 与 hit、没有 miss 时以 prompt-hit 重建并验证范围；矛盾/负数/NaN/hit>prompt → actual unknown。
 * upper（与 actual 分栏）：全部 prompt 按普通 input 价 + completion 按 output 价（保守上界，供 cap 对账）。
 */
export function computeSampleCost(usage: SampleUsage | null, profile: PriceProfile | null, model?: string): SampleCost | "unknown" {
  if (!usage || !profile) return "unknown"
  if (profile.unit !== "per-1M-tokens") return "unknown"
  // R25-P0-01：精确 model 匹配，禁止回退首条/相近模型
  const entry = profile.prices.find((e) => e.model === model)
  if (!entry) return "unknown"

  const prompt = usage.prompt_tokens ?? usage.inputTokens
  const completion = usage.completion_tokens ?? usage.outputTokens
  const hit = usage.prompt_cache_hit_tokens ?? usage.cacheHitTokens ?? null
  const miss = usage.prompt_cache_miss_tokens ?? usage.cacheMissTokens ?? null

  // prompt/completion 缺失或非法 → actual 不可推导（upper 亦无依据）→ 整体 unknown（调用方按保守 reservation 对账）
  if (typeof prompt !== "number" || !Number.isFinite(prompt) || prompt < 0) return "unknown"
  if (typeof completion !== "number" || !Number.isFinite(completion) || completion < 0) return "unknown"
  const bad = (v: number | null): boolean => v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)
  if (bad(hit) || bad(miss)) return "unknown"

  const round6 = (x: number): number => Math.round(x * 1_000_000) / 1_000_000
  const inputCny = (tok: number): number => round6((tok * entry.inputPer1M) / 1_000_000)
  const hitCny = (tok: number): number => round6((tok * entry.cacheHitPer1M) / 1_000_000)
  const outCny = (tok: number): number => round6((tok * entry.outputPer1M) / 1_000_000)

  // upper 恒可计算（与 actual 分栏）：全部 prompt 按普通 input 价
  const upper = round6(inputCny(prompt) + outCny(completion))

  const output = outCny(completion)
  if (hit === null && miss === null) {
    // 无 cache 明细 → actual = prompt×input + completion×output（无缓存折扣，合法 actual）
    const input = inputCny(prompt)
    return { input, output, cacheHit: 0, total: round6(input + output), actualKnown: true, upper }
  }
  if (bad(hit) || (miss !== null && bad(miss))) return { input: 0, output, cacheHit: 0, total: round6(output), actualKnown: false, upper }
  const hitV = hit as number
  if (hitV > prompt) {
    // hit > prompt 矛盾 → actual unknown（字段矛盾必须 unknown，不得静默）
    return { input: 0, output, cacheHit: 0, total: round6(output), actualKnown: false, upper }
  }
  let missV: number
  if (miss !== null) {
    missV = miss as number
    if (hitV + missV !== prompt) {
      // hit+miss != prompt 矛盾 → actual unknown
      return { input: 0, output, cacheHit: 0, total: round6(output), actualKnown: false, upper }
    }
  } else {
    // 只有 prompt 与 hit、无 miss：以 prompt-hit 重建（已验证 0 ≤ prompt-hit ≤ prompt）
    missV = prompt - hitV
  }
  const input = inputCny(missV)
  const cacheHit = hitCny(hitV)
  return { input, output, cacheHit, total: round6(input + cacheHit + output), actualKnown: true, upper }
}

// ==================== usage 覆盖率与缺失 usage 校验（修复 R19-R03 usage 口径） ====================

/** 样本的最小形状（preflight 侧自定义）：usageStatus 标记该样本 provider 是否返回 usage。 */
export interface SampleUsageLike {
  usageStatus?: UsageStatus
}

/**
 * usage 覆盖率统计：present = provider 返回 usage 的样本数；missing = 未返回的样本数。
 * missing 的样本 cost 恒为 unknown、绝不写 0 参与比较（通用服务在请求缺 stream_options.include_usage=true 时
 * 可能不返回 usage，属口径失真而非真实 0 用量）。
 */
export function usageCoverage(samples: SampleUsageLike[]): UsageCoverage {
  let present = 0
  let missing = 0
  for (const s of samples) {
    if (s.usageStatus === "present") present++
    else missing++
  }
  return { present, missing, total: present + missing }
}

/**
 * 断言样本 usage 可参与聚合：仅当 usageStatus === "present" 时返回 true。
 * README：generic 侧缺 include_usage 时真实服务可能不返回 usage —— 由 S1 在 eval-variants.ts 的
 * streamOpenAiCompatible 请求体补 `stream_options: { include_usage: true }`；本函数只负责「校验语义」：
 * 缺失 usage 的样本禁入聚合，绝不把 cost 写 0。
 */
export function assertUsagePresent(sample: SampleUsageLike): boolean {
  return sample.usageStatus === "present"
}

// ==================== manifest 构建与校验 ====================

/**
 * 构建评测 manifest。commit / electronVersion 由调用方传入（git rev-parse HEAD 只读；
 * 无 electron 环境时 electronVersion 传 null）。
 *
 * 时间边界（修复 R19-R05）：startedAt 须在「第一项工作之前」记录、finishedAt 须在「全部落盘与校验完成后」记录，
 * 不得在执行结束后临时 new Date() 冒充。durationMs 由两者差值计算（也可显式传入覆盖），
 * 其与时间戳的一致性由 manifestValidate 校验（|finishedAt - startedAt - durationMs| < 2s 且 durationMs >= 0）。
 */
export function buildRunManifest(args: ManifestBuildArgs): EvalManifest {
  const startedMs = Date.parse(args.startedAt)
  const finishedMs = Date.parse(args.finishedAt)
  const durationMs = args.durationMs !== undefined
    ? args.durationMs
    : Number.isFinite(startedMs) && Number.isFinite(finishedMs)
      ? Math.max(0, finishedMs - startedMs)
      : 0
  return {
    schemaVersion: args.schemaVersion ?? 1,
    commit: args.commit,
    dirtyFiles: args.dirtyFiles ?? [],
    nodeVersion: args.nodeVersion,
    electronVersion: args.electronVersion ?? null,
    platform: args.platform,
    taskSchemaHash: args.taskSchemaHash,
    variantContractHashes: args.variantContractHashes ?? {},
    runnerSourceHash: args.runnerSourceHash,
    seed: args.seed,
    argv: args.argv ?? [],
    synthetic: args.synthetic,
    real: args.real,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    priceProfileHash: args.priceProfileHash,
    priceProfileId: args.priceProfileId,
    model: args.model,
    repeats: args.repeats,
    tasks: args.tasks.map((t) => ({ id: t.id, targetChars: t.targetChars, stages: t.stages })),
    variants: args.variants.map((v) => ({ id: v.id })),
    durationMs,
    plannedRequests: args.plannedRequests ?? 0,
    actualRequests: args.actualRequests ?? 0,
    outerRetries: args.outerRetries ?? 0,
    innerRetries: args.innerRetries ?? 0,
    usageCoverage: args.usageCoverage ?? { present: 0, missing: 0, total: 0 },
    requestTraceHash: args.requestTraceHash ?? "none",
    experimentMode: args.experimentMode ?? "controlled",
    sampleCounts: args.sampleCounts ?? { total: 0, success: 0, failed: 0, validationPassed: 0, validationFailed: 0 },
    artifactHashes: args.artifactHashes ?? { samplesSha256: "none", variantsSha256: "none" },
    scale: args.scale ?? 1
  }
}

const DURATION_CONSISTENCY_TOLERANCE_MS = 2000

/** 校验 durationMs 与 startedAt/finishedAt 的一致性（|finishedAt - startedAt - durationMs| < 2s 且 durationMs >= 0）。 */
export function durationConsistent(startedAt: string, finishedAt: string, durationMs: number): boolean {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return false
  const s = Date.parse(startedAt)
  const f = Date.parse(finishedAt)
  if (!Number.isFinite(s) || !Number.isFinite(f)) return false
  return Math.abs((f - s) - durationMs) < DURATION_CONSISTENCY_TOLERANCE_MS
}

const SHA256_RE = /^[0-9a-f]{64}$/

/** 校验 manifest：必填字段缺失/类型错/hash 字段非法 → FAIL（红灯 8 用）。
 *  R25-P0-03：opts.priceProfile 传入时，real + max-cost 模式还会核对计价身份（provider/endpoint/model/profile hash/currency）
 *  与 profile 的一致性——缺失、错配、hash 漂移一律 FAIL；priceProfileTrustedForEndpoint 必须为 true。 */
export function manifestValidate(m: unknown, opts?: { priceProfile?: PriceProfile | null }): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  if (typeof m !== "object" || m === null) return { ok: false, errors: ["manifest is not an object"] }
  const o = m as Record<string, unknown>
  // 主代理整合桥接：runner 用 dirty/node/electron 命名（任务书 §六 语义一致），此处归一为 C 的字段名
  if (o.dirtyFiles === undefined && Array.isArray(o.dirty)) o.dirtyFiles = o.dirty
  else if (o.dirtyFiles === undefined && typeof o.dirty === "string") o.dirtyFiles = [o.dirty]
  if (o.nodeVersion === undefined && typeof o.node === "string") o.nodeVersion = o.node
  if (o.electronVersion === undefined && o.electron !== undefined) o.electronVersion = o.electron
  if (o.real === undefined && typeof o.synthetic === "boolean") o.real = !o.synthetic

  const expectString = (k: string): void => {
    if (typeof o[k] !== "string" || !o[k]) errors.push(`${k} must be a non-empty string`)
  }
  const expectNumber = (k: string): void => {
    if (typeof o[k] !== "number" || !Number.isFinite(o[k])) errors.push(`${k} must be a finite number`)
  }
  const expectBool = (k: string): void => {
    if (typeof o[k] !== "boolean") errors.push(`${k} must be a boolean`)
  }
  const expectHash = (k: string): void => {
    expectString(k)
    if (typeof o[k] === "string" && !SHA256_RE.test(o[k])) errors.push(`${k} must be a valid sha256 hex (64 hex chars)`)
  }

  if (o.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  expectString("commit")
  if (!Array.isArray(o.dirtyFiles) || o.dirtyFiles.some((x) => typeof x !== "string")) errors.push("dirtyFiles must be an array of strings")
  expectString("nodeVersion")
  if (o.electronVersion !== null && (typeof o.electronVersion !== "string" || !o.electronVersion)) errors.push("electronVersion must be null or a non-empty string")
  expectString("platform")
  expectHash("taskSchemaHash")
  // 主代理整合桥接：兼容 runner 的单数 variantContractHash 与 C 扩展的复数 variantContractHashes（任务书 §六 只要求「variant contract hash」在场）
  const vch = (o.variantContractHashes ?? o.variantContractHash) as Record<string, unknown> | undefined
  if (typeof vch !== "object" || vch === null || Array.isArray(vch) || Object.keys(vch).length === 0) {
    errors.push("variantContractHashes must be a non-empty object (also accepts singular variantContractHash)")
  } else {
    for (const [k, v] of Object.entries(vch)) {
      const vv = v as unknown
      if (typeof vv === "string") {
        if (!SHA256_RE.test(vv)) errors.push(`variantContractHashes[${k}] must be a valid sha256 hex`)
      } else if (typeof vv === "object" && vv !== null) {
        for (const [k2, v2] of Object.entries(vv as Record<string, unknown>)) {
          if (typeof v2 !== "string" || !SHA256_RE.test(v2)) errors.push(`variantContractHashes[${k}.${k2}] must be a valid sha256 hex`)
        }
      } else {
        errors.push(`variantContractHashes[${k}] must be a sha256 hex or object of sha256 hex`)
      }
    }
  }
  expectHash("runnerSourceHash")
  // 主代理整合桥接：seed 允许非空字符串（runner 用 sha256 形式 seed）或有限数字
  if (typeof o.seed === "string") {
    if (!o.seed) errors.push("seed must be a non-empty string or a finite number")
  } else {
    expectNumber("seed")
  }
  if (!Array.isArray(o.argv) || o.argv.some((x) => typeof x !== "string")) errors.push("argv must be an array of strings")
  expectBool("synthetic")
  expectBool("real")
  expectString("startedAt")
  expectString("finishedAt")
  // 主代理整合桥接：以下为 C 扩展字段——存在则校验，缺失不 FAIL（任务书 §六 最小集合不含它们；无 profile 时 runner 不写价格字段）
  if (o.priceProfileHash !== undefined && o.priceProfileHash !== "none") expectHash("priceProfileHash")
  if (o.priceProfileId !== undefined) expectString("priceProfileId")
  if (o.model !== undefined) expectString("model")
  if (o.repeats !== undefined) expectNumber("repeats")
  if (o.tasks !== undefined) {
    if (!Array.isArray(o.tasks) || o.tasks.length === 0) {
      errors.push("tasks must be a non-empty array")
    } else {
      for (const [i, t] of o.tasks.entries()) {
        const tt = t as Record<string, unknown>
        if (typeof tt !== "object" || tt === null || typeof tt.id !== "string" || !tt.id) errors.push(`tasks[${i}].id must be a non-empty string`)
        if (typeof tt.targetChars !== "number" || !Number.isFinite(tt.targetChars)) errors.push(`tasks[${i}].targetChars must be a finite number`)
        if (typeof tt.stages !== "number" || !Number.isFinite(tt.stages)) errors.push(`tasks[${i}].stages must be a finite number`)
      }
    }
  }
  if (o.variants !== undefined) {
    if (!Array.isArray(o.variants) || o.variants.length === 0) {
      errors.push("variants must be a non-empty array")
    } else {
      for (const [i, v] of o.variants.entries()) {
        const vv = v as Record<string, unknown>
        if (typeof vv !== "object" || vv === null || typeof vv.id !== "string" || !vv.id) errors.push(`variants[${i}].id must be a non-empty string`)
      }
    }
  }
  // ===== R21-R04 事实字段：本轮起强制新口径，全部必填，旧 manifest（缺任一）→ FAIL =====
  if (o.durationMs === undefined) {
    errors.push("durationMs is required (mandatory since R21)")
  } else if (typeof o.durationMs !== "number" || !Number.isFinite(o.durationMs) || o.durationMs < 0) {
    errors.push("durationMs must be a finite number >= 0")
  } else if (typeof o.startedAt === "string" && typeof o.finishedAt === "string") {
    if (!durationConsistent(o.startedAt, o.finishedAt, o.durationMs)) {
      errors.push("durationMs inconsistent with startedAt/finishedAt (|finishedAt - startedAt - durationMs| must be < 2000ms)")
    }
  }
  const expectNonNegInt = (k: string): void => {
    if (typeof o[k] !== "number" || !Number.isInteger(o[k]) || o[k] < 0) errors.push(`${k} must be a non-negative integer`)
  }
  const expectRequiredNonNegInt = (k: string): void => {
    if (o[k] === undefined) errors.push(`${k} is required (mandatory since R21)`)
    else expectNonNegInt(k)
  }
  expectRequiredNonNegInt("plannedRequests")
  expectRequiredNonNegInt("actualRequests")
  expectRequiredNonNegInt("outerRetries")
  // R22 主代理对账：innerRetries 在内层 attempt 未观测时合法为 null（禁止用 0 冒充未观测），
  // 观测到（innerRetriesObserved=true）时必须是非负整数；null 与 observed=true 互斥（矛盾）。
  if (o.innerRetries === undefined) {
    errors.push("innerRetries is required (mandatory since R21)")
  } else if (o.innerRetries !== null) {
    expectNonNegInt("innerRetries")
  }
  if (o.innerRetriesObserved !== undefined && typeof o.innerRetriesObserved !== "boolean") {
    errors.push("innerRetriesObserved must be a boolean")
  }
  if (o.innerRetries === null && o.innerRetriesObserved === true) {
    errors.push("innerRetries=null conflicts with innerRetriesObserved=true")
  }
  if (typeof o.innerRetries === "number" && o.innerRetriesObserved === false) {
    errors.push("innerRetries numeric conflicts with innerRetriesObserved=false (禁止用数字冒充未观测)")
  }
  if (o.usageCoverage === undefined) {
    errors.push("usageCoverage is required (mandatory since R21)")
  } else {
    const uc = o.usageCoverage as Record<string, unknown>
    if (typeof uc !== "object" || uc === null || Array.isArray(uc)) {
      errors.push("usageCoverage must be an object { present, missing, total }")
    } else {
      for (const f of ["present", "missing", "total"]) {
        if (typeof uc[f] !== "number" || !Number.isInteger(uc[f]) || uc[f] < 0) errors.push(`usageCoverage.${f} must be a non-negative integer`)
      }
      if (Number.isInteger(uc.present) && Number.isInteger(uc.missing) && Number.isInteger(uc.total) && (uc.present as number) + (uc.missing as number) !== (uc.total as number)) {
        errors.push("usageCoverage.total must equal present + missing")
      }
    }
  }
  if (o.requestTraceHash === undefined) {
    errors.push("requestTraceHash is required (mandatory since R21)")
  } else if (o.requestTraceHash !== "none") {
    expectHash("requestTraceHash")
  }

  // experimentMode：∈ {"controlled","trajectory"}，必填
  if (o.experimentMode === undefined) {
    errors.push("experimentMode is required (mandatory since R21)")
  } else if (o.experimentMode !== "controlled" && o.experimentMode !== "trajectory") {
    errors.push(`experimentMode must be "controlled" or "trajectory" (got ${JSON.stringify(o.experimentMode)})`)
  }

  // sampleCounts：success+failed=total；validationPassed+validationFailed=total，必填
  if (o.sampleCounts === undefined) {
    errors.push("sampleCounts is required (mandatory since R21)")
  } else {
    const sc = o.sampleCounts as Record<string, unknown>
    if (typeof sc !== "object" || sc === null || Array.isArray(sc)) {
      errors.push("sampleCounts must be an object { total, success, failed, validationPassed, validationFailed }")
    } else {
      for (const f of ["total", "success", "failed", "validationPassed", "validationFailed"]) {
        if (typeof sc[f] !== "number" || !Number.isInteger(sc[f]) || sc[f] < 0) errors.push(`sampleCounts.${f} must be a non-negative integer`)
      }
      const int = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v)
      if (int(sc.success) && int(sc.failed) && int(sc.total) && (sc.success as number) + (sc.failed as number) !== (sc.total as number)) {
        errors.push("sampleCounts.total must equal success + failed")
      }
      if (int(sc.validationPassed) && int(sc.validationFailed) && int(sc.total) && (sc.validationPassed as number) + (sc.validationFailed as number) !== (sc.total as number)) {
        errors.push("sampleCounts.total must equal validationPassed + validationFailed")
      }
    }
  }

  // artifactHashes：各 64-hex，必填
  if (o.artifactHashes === undefined) {
    errors.push("artifactHashes is required (mandatory since R21)")
  } else {
    const ah = o.artifactHashes as Record<string, unknown>
    if (typeof ah !== "object" || ah === null || Array.isArray(ah)) {
      errors.push("artifactHashes must be an object { samplesSha256, variantsSha256 }")
    } else {
      for (const f of ["samplesSha256", "variantsSha256"]) {
        if (typeof ah[f] !== "string" || !SHA256_RE.test(ah[f] as string)) errors.push(`artifactHashes.${f} must be a valid sha256 hex (64 hex chars)`)
      }
    }
  }

  // ===== R25-P0-03：计价身份与预算事实（real + max-cost 模式强制存在且与 profile 一致；hash 漂移判 FAIL） =====
  if (typeof o.scale === "number" && Number.isFinite(o.scale) && o.scale > 0) {
    /* ok */
  } else {
    errors.push("scale must be a finite positive number (mandatory since R25)")
  }
  const budgetObj = (typeof o.budget === "object" && o.budget !== null && !Array.isArray(o.budget)) ? o.budget as Record<string, unknown> : null
  const costCapActive = o.real === true && budgetObj !== null && (budgetObj.maxCostCny === undefined || budgetObj.maxCostCny === null) === false && typeof budgetObj.maxCostCny === "number" && budgetObj.maxCostCny > 0
  // 一致性（所有模式）：对不可信端点/缺失 profile 的 real 运行，actualCostKnown 不得为 true（禁止伪造精确费用结论）
  if (o.real === true && o.actualCostKnown === true && o.priceProfileTrustedForEndpoint !== true) {
    errors.push("actualCostKnown=true conflicts with priceProfileTrustedForEndpoint!=true (real 且价格不可信时不得声称精确费用)")
  }
  if (costCapActive) {
    expectString("providerId")
    if (typeof o.endpointOrigin !== "string" || !CANONICAL_ORIGIN_RE.test(o.endpointOrigin as string)) {
      errors.push(`endpointOrigin must be a canonical origin (scheme+host+port only; got ${JSON.stringify(o.endpointOrigin)})`)
    }
    expectString("model")
    expectString("priceProfileId")
    expectHash("priceProfileHash")
    expectString("priceProfileCurrency")
    if (o.priceProfileTrustedForEndpoint !== true) errors.push("priceProfileTrustedForEndpoint must be true in real + max-cost mode（必须来自结构化匹配，不得手写 true）")
    const expectNonNegFinite = (k: string): void => {
      if (typeof o[k] !== "number" || !Number.isFinite(o[k]) || (o[k] as number) < 0) errors.push(`${k} must be a finite number >= 0`)
    }
    expectNonNegFinite("spentActualCny")
    expectNonNegFinite("spentUpperCny")
    expectNonNegFinite("inflightReservedCny")
    expectBool("actualCostKnown")
    expectBool("hardCapProtected")
    if (typeof o.spentActualCny === "number" && typeof o.spentUpperCny === "number" && (o.spentActualCny as number) > (o.spentUpperCny as number) + 1e-9) {
      errors.push("spentActualCny must not exceed spentUpperCny（actual 是 upper 的子集）")
    }
    if (typeof o.exhausted !== "boolean") {
      errors.push("exhausted must be a boolean")
    } else if (o.exhausted === true) {
      if (typeof o.reason !== "string" || !o.reason) errors.push("reason must be a non-empty string when exhausted=true")
    } else if (o.reason !== null && typeof o.reason !== "string") {
      errors.push("reason must be a string or null")
    }
    if (o.hardCapProtected === false && o.exhausted !== true) {
      errors.push("hardCapProtected=false requires exhausted=true（上界失效必须阻断并熔断）")
    }
    // profile 对照（hash 漂移/身份错配）：opts.priceProfile 提供时逐一核对
    const pp = opts?.priceProfile ?? null
    if (pp) {
      if (o.providerId !== pp.providerId) errors.push(`providerId mismatch: manifest=${JSON.stringify(o.providerId)} profile=${pp.providerId}`)
      if (typeof o.endpointOrigin === "string" && !pp.endpointOrigins.includes(o.endpointOrigin)) errors.push(`endpointOrigin not trusted by profile: ${JSON.stringify(o.endpointOrigin)}（profile 信任 ${pp.endpointOrigins.join(" / ")}）`)
      if (typeof o.model === "string" && !pp.prices.some((e) => e.model === o.model)) errors.push(`model has no exact price entry in profile: ${JSON.stringify(o.model)}`)
      if (o.priceProfileId !== pp.profileId) errors.push(`priceProfileId mismatch: manifest=${JSON.stringify(o.priceProfileId)} profile=${pp.profileId}`)
      if (typeof o.priceProfileHash === "string" && o.priceProfileHash !== priceProfileHash(pp)) errors.push(`priceProfileHash drift: manifest=${(o.priceProfileHash as string).slice(0, 12)}… != current profile hash`)
      if (o.priceProfileCurrency !== pp.currency) errors.push(`priceProfileCurrency mismatch: manifest=${JSON.stringify(o.priceProfileCurrency)} profile=${pp.currency}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

// ==================== R21-R04 失败退出口径 ====================

/** 失败退出的判定输入（truth 由 runner 汇聚后传入）。 */
export interface ExitDecisionState {
  mode: "mock" | "real"
  /** --real 无 key（blocked，未运行） */
  blockedNoKey: boolean
  samplesTotal: number
  /** 成功样本数（metrics.status === "ok"） */
  samplesOk: number
  /** 校验通过数（validation.passed === true） */
  validationPassed: number
  /** 必需样本校验通过数阈值（必需样本总数；缺省 = samplesTotal，保持旧调用方向后兼容） */
  validationRequired?: number
  /** 中止（aborted）样本数——aborted 样本不计入成功但也不等于普通失败 */
  samplesAborted?: number
  /** R23-R03：失败样本数（metrics.status !== "ok"）——mock/real 统一：>0 必须非零 */
  samplesFailed?: number
  /** R23-R05：请求/费用熔断已触发（budget_exhausted）→ exit 非 0 */
  budgetExhausted?: boolean
  /** controlled 输入不等价 / trajectory lineage 断裂 */
  fairnessFail: boolean
  /** manifest 预检/完整性校验通过与否 */
  manifestOk: boolean
  /** 样本配对比期望少（缺 variant / 缺 sample） */
  missingVariants: boolean
  /** 样本配对比期望少（缺 sample） */
  missingSamples: boolean
  /** R22 主代理对账：请求账本与本地端点实收数不一致（少计/多计）→ exit 非 0 */
  accountingBroken?: boolean
}

export interface ExitDecision {
  exitCode: number
  reason: string
}

/**
 * 失败退出口径唯一事实源（runner 在大循环结束后、落盘完成前调用一次）。
 * 判定顺序（先到先得）：
 *   blockedNoKey → 0 "blocked_not_run"
 *   samplesOk===0 → 1 "all_samples_failed"（real 全失败也必须非零）
 *   missingVariants/missingSamples → 1 "incomplete_pairing"
 *   fairnessFail → 1 "fairness_blocked"
 *   accountingBroken → 1 "ledger_endpoint_mismatch"（R22：ledger 与端点实收数不一致）
 *   !manifestOk → 1 "manifest_invalid"
 *   samplesFailed>0 → 1 "samples_failed"（R23-R03：mock/real 统一——任一 required sample 失败必须非零，
 *     替代原 mock 专用 mock_pipeline_broken）
 *   budgetExhausted → 1 "budget_exhausted"（R23-R05：请求/费用熔断）
 *   validationPassed < validationRequired → 1 "incomplete_quality_validation"（P0-04：全部 HTTP 成功但 validation=0 也必须非零）
 *   samplesAborted>0 → 1 "aborted_samples"
 *   其余 → 0 "ok"
 */
export function computeExitDecision(state: ExitDecisionState): ExitDecision {
  if (state.blockedNoKey) return { exitCode: 0, reason: "blocked_not_run" }
  if (state.samplesOk === 0) return { exitCode: 1, reason: "all_samples_failed" }
  if (state.missingVariants || state.missingSamples) return { exitCode: 1, reason: "incomplete_pairing" }
  if (state.fairnessFail) return { exitCode: 1, reason: "fairness_blocked" }
  if (state.accountingBroken) return { exitCode: 1, reason: "ledger_endpoint_mismatch" }
  if (!state.manifestOk) return { exitCode: 1, reason: "manifest_invalid" }
  // R23-R03：mock/real 统一的失败样本阻断（Codex P0-02——real 模式 failed sample 亦必须非零）。
  // 缺省 fallback = 总样本 - 成功 - 中止（aborted 样本单独计，不属于「普通失败」也不计成功）。
  if ((state.samplesFailed ?? (state.samplesTotal - state.samplesOk - (state.samplesAborted ?? 0))) > 0) return { exitCode: 1, reason: "samples_failed" }
  // R23-R05：请求/费用熔断（达到上限立即停止，不得先超支再报告）
  if (state.budgetExhausted) return { exitCode: 1, reason: "budget_exhausted" }
  // R22-R04 新增：质量校验阻断（P0-04）——全部 HTTP 成功但 validationPassed=0 也必须非零。
  const required = state.validationRequired ?? state.samplesTotal
  if (state.validationPassed < required) return { exitCode: 1, reason: "incomplete_quality_validation" }
  // R22-R04 新增：存在 aborted 样本 → 非零（区分「一次失败尝试+重试成功」的正常重试与真中止）。
  if ((state.samplesAborted ?? 0) > 0) return { exitCode: 1, reason: "aborted_samples" }
  return { exitCode: 0, reason: "ok" }
}

// ==================== 泄漏扫描（红灯 9） ====================

const LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai-key", re: /sk-[A-Za-z0-9]{16,}/g },
  { name: "deepseek-key", re: /sk-[A-Za-z0-9]{20,}/g },
  { name: "generic-bearer", re: /Bearer\s+[A-Za-z0-9._~+/-]{16,}/gi },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-pat", re: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { name: "win-abs-path", re: /[A-Za-z]:\\Users\\/g },
  { name: "unix-home-path", re: /\/home\/[A-Za-z0-9._-]+/g }
]

const SETTING_KEYWORDS = ["apiKey", "api_key", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "accessToken", "secret_key"]

/**
 * 扫描文本/文件是否含疑似 API key / 本机绝对路径 / 用户真实设置关键词。
 * 仅返回命中位置与模式名，绝不打印 key 值本身（matched 一律打成占位符 + 长度）。
 */
export function scanForLeaks(textOrFiles: string[]): { hits: ScanHit[] } {
  const hits: ScanHit[] = []
  const checkText = (text: string, file: string): void => {
    if (!text) return
    for (const p of LEAK_PATTERNS) {
      const m = text.match(p.re)
      if (m && m.length > 0) {
        // matched 打码：只保留模式名 + 命中长度，绝不回显 key 内容
        hits.push({ file, pattern: p.name, matched: `<redacted:${m.length} matches>` })
      }
    }
    for (const kw of SETTING_KEYWORDS) {
      // 关键词命中需后跟赋值/等号 + 非空值，避免把文档里纯提到「apiKey」当作泄漏
      const re = new RegExp(`${escapeRegExp(kw)}\\s*[:=]\\s*["']?[^\\s"']{4,}`, "gi")
      if (re.test(text)) {
        re.lastIndex = 0
        hits.push({ file, pattern: "setting-keyword", matched: `<redacted:keyword=${kw}>` })
      }
    }
  }
  for (const item of textOrFiles) {
    if (!item) continue
    // 若像是文件路径且存在，读内容；否则当作裸文本扫描
    if (item.length <= 4096 && fs.existsSync(item)) {
      let content = ""
      try {
        content = fs.readFileSync(item, "utf-8")
      } catch {
        /* 二进制/无权限 → 跳过 */
      }
      checkText(content, item)
    } else {
      checkText(item, "<text>")
    }
  }
  return { hits }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ==================== CLI main（含 --selftest，不进导出） ====================

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes("--selftest")) {
    await selftest()
    return
  }
  // 仅真正作为 CLI 独立执行（argv[1] 就是本 bundle 名）时打印用法；
  // 被打包进 runner/validator/反证脚本时（bundled 也会命中 invokedDirectly）保持静默。
  if (path.basename(process.argv[1] ?? "") === "eval-preflight.mjs") {
    console.log("eval-preflight：无 --selftest 时无默认动作（库模块，供 runner / 主代理 import）。")
    console.log("用法：node out/eval-preflight.mjs --selftest")
  }
}

async function selftest(): Promise<void> {
  let pass = 0
  let fail = 0
  const failures: string[] = []

  const check = (name: string, cond: boolean): void => {
    if (cond) {
      pass++
      console.log(`  PASS  ${name}`)
    } else {
      fail++
      failures.push(name)
      console.log(`  FAIL  ${name}`)
    }
  }

  console.log("===== eval-preflight selftest =====")

  // R04/R05：构造逐 stage targetChars 与 tasks.json 同构的 stagesPlan（不再均摊 task.targetChars）
  const buildStagesPlanByTarget = (pairs: Array<[string, number, number]>): StagePlanDef[] =>
    pairs.map(([stageId, targetChars, reps]) => {
      const defs: StagePlanDef[] = []
      for (let i = 1; i <= reps; i++) defs.push({ stageId: `${stageId}${reps > 1 ? `#${i}` : ""}`, templateChars: 300, materialChars: 0, targetChars })
      return defs
    }).flat()

  // 1. 加载 profile → validate ok → hash 输出
  const profile = loadPriceProfile()
  check("load profile (non-null)", profile !== null)
  const vLoad = profile ? priceProfileValidate(profile) : { ok: false, errors: ["null"] }
  check("validate loaded profile ok", vLoad.ok)
  const hash = profile ? priceProfileHash(profile) : ""
  check("hash is 64-hex", /^[0-9a-f]{64}$/.test(hash))
  console.log(`       profileId=${profile?.profileId} currency=${profile?.currency} unit=${profile?.unit}`)
  console.log(`       hash=${hash}`)

  // 2. 篡改字段（删 unit）→ validate FAIL
  const tampered = profile ? JSON.parse(JSON.stringify(profile)) : null
  delete tampered.unit
  const vTampered = priceProfileValidate(tampered)
  check("validate tampered (deleted unit) FAIL", !vTampered.ok && vTampered.errors.some((e) => e.includes("unit")))

  // 3. 负价格 → FAIL
  const negPrice = profile ? JSON.parse(JSON.stringify(profile)) : null
  if (negPrice && negPrice.prices?.[0]) negPrice.prices[0].outputPer1M = -1
  const vNeg = priceProfileValidate(negPrice)
  check("validate negative price FAIL", !vNeg.ok)

  // 3b. R25-P0-01：provider/endpoint 绑定与精确匹配（禁止首条回退）
  check("profile providerId == deepseek", profile?.providerId === "deepseek")
  check("profile endpointOrigins 只含 DeepSeek canonical origin", Array.isArray(profile?.endpointOrigins) && (profile as PriceProfile).endpointOrigins.includes("https://api.deepseek.com"))
  if (profile) {
    const mExact = matchPriceEntry(profile, "deepseek-v4-flash", "https://api.deepseek.com", "CNY")
    check("matchPriceEntry exact (provider+origin+model+currency) ok", mExact.ok === true)
    const mUnknownModel = matchPriceEntry(profile, "unpriced-model-codex-probe", "https://api.deepseek.com", "CNY")
    check("matchPriceEntry unknown model FAIL（无首条回退）", !mUnknownModel.ok && mUnknownModel.reason.includes("model-not-priced"))
    const mOpenCode = matchPriceEntry(profile, "deepseek-v4-flash", "https://opencode.ai", "CNY")
    check("matchPriceEntry OpenCode origin FAIL（DeepSeek profile 不跨 provider）", !mOpenCode.ok && mOpenCode.reason.includes("endpoint-origin-not-trusted"))
    const mUsd = matchPriceEntry(profile, "deepseek-v4-flash", "https://api.deepseek.com", "USD")
    check("matchPriceEntry currency mismatch FAIL", !mUsd.ok && mUsd.reason.includes("currency-mismatch"))
    const mPath = matchPriceEntry(profile, "deepseek-v4-flash", "https://api.deepseek.com/v1/chat", "CNY")
    check("matchPriceEntry 非 canonical origin（含 path）FAIL", !mPath.ok && mPath.reason.includes("endpoint-origin-not-canonical"))
    const mNoProfile = matchPriceEntry(null, "deepseek-v4-flash", "https://api.deepseek.com", "CNY")
    check("matchPriceEntry 无 profile FAIL", !mNoProfile.ok)
    // 篡改：删 endpointOrigins → FAIL；重复 model 条目 → FAIL
    const noOrigins = JSON.parse(JSON.stringify(profile))
    delete noOrigins.endpointOrigins
    check("validate tampered (deleted endpointOrigins) FAIL", !priceProfileValidate(noOrigins).ok)
    const dupModel = JSON.parse(JSON.stringify(profile))
    dupModel.prices.push({ model: "deepseek-v4-flash", inputPer1M: 9, outputPer1M: 9, cacheHitPer1M: 9 })
    check("validate duplicate model entry FAIL", !priceProfileValidate(dupModel).ok)

    // 3c. R25-P1-01：byte ceiling ≥ 字符数（rare Unicode/emoji/组合字符/tool schema/JSON 转义覆盖）
    const bodyProbe = JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 8192,
      tools: [{ type: "function", function: { name: "query", description: "工具", parameters: { type: "object" } } }],
      messages: [{ role: "user", content: "罕见字𠀀𠀁🚀🧠e\u0301（组合）\n\"转义\"" }]
    })
    const ceil = utf8BodyTokenCeiling(bodyProbe)
    const charLen = [...bodyProbe].length
    check("utf8BodyTokenCeiling.bytes ≥ 全 body 字符数", ceil.bytes >= charLen)
    check("utf8BodyTokenCeiling.ceiling ≥ bytes", ceil.ceiling >= ceil.bytes)
    check("utf8BodyTokenCeiling messages 计数 == 1", ceil.messages === 1)
  } else {
    check("matchPriceEntry probe skipped (profile null)", false)
  }

  // 4. expandStages / plannedRequests 逐阶段展开（同构任务集：longform=4 / character=6 / style=2 / renpy=1 / failure=2，共 15）
  const isoTask = (id: string, cat: string, longMode: boolean, stages: Array<[string, number, number]>): EvalTaskLike => ({
    id,
    category: cat,
    targetChars: 1000,
    longMode,
    stages: stages.map(([stageId, reps, targetChars]) => ({ stageId, template: "x".repeat(300), repeats: reps, expectMinChars: 300, targetChars }))
  })
  const taskSet5: EvalTaskLike[] = [
    isoTask("longform-multichapter", "longform", true, [["outline", 1, 200], ["chapter", 3, 3300]]),          // 4
    isoTask("character-consistency", "character-consistency", false, [["setup", 1, 200], ["scene", 5, 200]]), // 6
    isoTask("style-transfer", "style-transfer", false, [["extract", 1, 120], ["generate", 1, 500]]),          // 2
    isoTask("renpy-scene-branch", "renpy", true, [["generate", 1, 800]]),                                      // 1
    isoTask("failure-recovery", "failure-recovery", true, [["truncated-continuation", 1, 150], ["partial-continue", 1, 450]]) // 2
  ]
  const perTaskCounts = taskSet5.map((t) => plannedRequests(t))
  check("expandStages longform == 4", perTaskCounts[0] === 4)
  check("expandStages character == 6", perTaskCounts[1] === 6)
  check("expandStages style == 2", perTaskCounts[2] === 2)
  check("expandStages renpy == 1", perTaskCounts[3] === 1)
  check("expandStages failure == 2", perTaskCounts[4] === 2)
  check("Σ plannedRequests == 15", perTaskCounts.reduce((a, b) => a + b, 0) === 15)
  check("plannedRequestsAll(5 tasks × 3 variants × 1) == 45", plannedRequestsAll(taskSet5, 3, 1) === 45)

  // 5. estimateRunPlan 请求数：all-in 上界（repeats=1），R05 覆盖 completion 多轮 + outer + inner retry
  const variants3: VariantDef[] = [{ id: "generic_baseline" }, { id: "deepwriter_current_product" }, { id: "deepwriter_hardened_candidate", multiroundLongwrite: true }]
  const taskDefs5: TaskDef[] = [
    { id: "longform-multichapter", category: "longform", stages: 4, targetChars: 10000, retry: true, longMode: true, stagesPlan: buildStagesPlanByTarget([["outline", 200, 1], ["chapter", 3300, 3]]) },
    { id: "character-consistency", category: "character-consistency", stages: 6, targetChars: 300, retry: true, longMode: false, stagesPlan: buildStagesPlanByTarget([["setup", 200, 1], ["scene", 200, 5]]) },
    { id: "style-transfer", category: "style-transfer", stages: 2, targetChars: 500, retry: true, longMode: false, stagesPlan: buildStagesPlanByTarget([["extract", 120, 1], ["generate", 500, 1]]) },
    { id: "renpy-scene-branch", category: "renpy", stages: 1, targetChars: 800, retry: true, longMode: true, stagesPlan: buildStagesPlanByTarget([["generate", 800, 1]]) },
    { id: "failure-recovery", category: "failure-recovery", stages: 2, targetChars: 600, retry: true, longMode: true, stagesPlan: buildStagesPlanByTarget([["truncated-continuation", 150, 1], ["partial-continue", 450, 1]]) }
  ]
  const plan5 = estimateRunPlan(taskDefs5, variants3, 1, profile)
  check("plan5.plannedRequests == 45", plan5.plannedRequests === 45)
  check("plan5.requests.lo == 45", plan5.requests.lo === 45)
  check("plan5.baseProviderCalls == 45 (= plannedRequests)", plan5.baseProviderCalls === 45)
  check("plan5.maxCompletionRounds == 181 (generic 15 + current 90 + hardened 76)", plan5.maxCompletionRounds === 181)
  check("plan5.maxOuterRetryCalls == 181", plan5.maxOuterRetryCalls === 181)
  check("plan5.maxInnerRetryCalls == 332 (current 180 + hardened 152; generic=0)", plan5.maxInnerRetryCalls === 332)
  check("plan5.allInRequestMax == 694 (generic 30 + current 360 + hardened 304)", plan5.allInRequestMax === 694)
  check("plan5.requests.hi == allInRequestMax (694)", plan5.requests.hi === plan5.allInRequestMax && plan5.requests.hi === 694)
  check("plan5.allInRequestMax == maxCompletionRounds + maxOuterRetryCalls + maxInnerRetryCalls", plan5.allInRequestMax === plan5.maxCompletionRounds + plan5.maxOuterRetryCalls + plan5.maxInnerRetryCalls)
  check("plan5.outerRetriesBudget == 45", plan5.outerRetriesBudget === 45)
  check("plan5.innerRetriesBudget == 45 (MAX_RETRIES=1, separate)", plan5.innerRetriesBudget === 45)
  check("plan5.samples == 15 (5 tasks × 3 variants × 1 repeat)", plan5.samples === 15)
  check("plan5.perTask length == 15", plan5.perTask.length === 15)
  const longformPerTask = plan5.perTask.find((p) => p.taskId === "longform-multichapter")!
  check("longform perTask.requests == 4", longformPerTask.requests === 4)
  check("longform stages count == 4", longformPerTask.stages.length === 4)
  // 逐阶段累积 transcript：第 k 阶段 input.lo > 第 1 阶段 input.lo（历史回灌）
  const cumulOk = longformPerTask.stages.every((s, i) => i === 0 || s.input.lo > longformPerTask.stages[0].input.lo)
  check("longform stage k input.lo > stage 1 input.lo (cumulative transcript)", cumulOk)
  const histInc = longformPerTask.stages.every((s, i) => i === 0 || s.historyTokens >= longformPerTask.stages[i - 1].historyTokens)
  check("longform historyTokens non-decreasing", histInc)
  check("longform stage[0].historyTokens == 0", longformPerTask.stages[0].historyTokens === 0)
  console.log(`       requests=[${plan5.requests.lo},${plan5.requests.hi}] planned=${plan5.plannedRequests} baseRounds=${plan5.maxCompletionRounds} outerRetry=${plan5.maxOuterRetryCalls} innerRetry=${plan5.maxInnerRetryCalls} allInMax=${plan5.allInRequestMax}`)

  // 5b. R24 P1-01：perVariantAllIn 逐 variant→task→stage 分解表（cap 推导自真实 maxTurns）
  check("plan5.perVariantAllIn length == 3", plan5.perVariantAllIn.length === 3)
  const pvaById = new Map(plan5.perVariantAllIn.map((p) => [p.variantId, p]))
  const mkV = (vid: string): VariantAllIn => pvaById.get(vid)!
  // generic：每 stage cap=1，共 15 阶段
  const genericAllIn = mkV("generic_baseline")
  check("perVariantAllIn.generic tasks == 5", genericAllIn.tasks.length === 5)
  check("perVariantAllIn.generic stage cap 恒 1", genericAllIn.tasks.every((t) => t.stages.every((s) => s.cap === 1)))
  const genericCapSum = genericAllIn.tasks.reduce((a, t) => a + t.stages.reduce((b, s) => b + s.cap, 0), 0)
  check("perVariantAllIn.generic cap sum == 15", genericCapSum === 15)
  // current：longMode 强制 false → 每 stage cap=6，共 15 阶段
  const currentAllIn = mkV("deepwriter_current_product")
  const currentCapSum = currentAllIn.tasks.reduce((a, t) => a + t.stages.reduce((b, s) => b + s.cap, 0), 0)
  check("perVariantAllIn.current cap sum == 90 (15×6)", currentCapSum === 90)
  check("perVariantAllIn.current 每 stage cap == 6", currentAllIn.tasks.every((t) => t.stages.every((s) => s.cap === 6)))
  // hardened：longMode 任务阶段 cap=min(128,max(4,ceil/1000))，非 longMode 阶段 cap=6；当前任务集 cap sum 仍为 76
  const hardenedAllIn = mkV("deepwriter_hardened_candidate")
  const hardenedCapSum = hardenedAllIn.tasks.reduce((a, t) => a + t.stages.reduce((b, s) => b + s.cap, 0), 0)
  check("perVariantAllIn.hardened cap sum == 76", hardenedCapSum === 76)
  // hardened longform outline(200) cap=4、chapter(3300) cap=4；character 非 longMode cap=6
  const hLf = hardenedAllIn.tasks.find((t) => t.taskId === "longform-multichapter")!
  check("hardened longform outline cap == 4", hLf.stages[0].cap === 4)
  check("hardened longform chapter cap == 4", hLf.stages[1].cap === 4)
  const hCh = hardenedAllIn.tasks.find((t) => t.taskId === "character-consistency")!
  check("hardened character(non-longMode) cap == 6", hCh.stages[0].cap === 6)
  // 逐轮历史回灌：cap=6 的 stage inputHi > 首轮 input.hi（output 回灌入 input 增长）
  const firstRoundInput = new Map<string, number>()
  for (const p of plan5.perTask) for (const s of p.stages) firstRoundInput.set(`${p.taskId}:${s.stageId}`, s.input.hi)
  const historyGrowthOk = currentAllIn.tasks.every((t) => t.stages.every((s) => {
    const base = firstRoundInput.get(`${t.taskId}:${s.stageId}`) ?? 0
    return s.inputHi > base
  }))
  check("current stage inputHi 含逐轮历史增长（cap>1 时 inputHi > 首轮 input.hi）", historyGrowthOk)

  // 6. repeats=2 → lo=90, hi=1388（all-in 上界按 repeats 线性放大）
  const plan5r2 = estimateRunPlan(taskDefs5, variants3, 2, profile)
  check("plan5(repeats=2).requests == [90, 1388]", plan5r2.requests.lo === 90 && plan5r2.requests.hi === 1388)
  check("plan5(repeats=2).plannedRequests == 90", plan5r2.plannedRequests === 90)
  check("plan5(repeats=2).allInRequestMax == 1388", plan5r2.allInRequestMax === 1388)

  // 7. legacy 旧调用方（无 stagesPlan 的 TaskDef）仍可运行（回退逐阶段兼容，不再相乘）
  const legacyTask: TaskDef = { id: "continuation-10k", stages: 3, templateChars: 600, targetChars: 10000, retry: true, rounds: 1 }
  const planLegacy = estimateRunPlan([legacyTask], variants3, 2, profile)
  check("legacy plan samples == 6 (1 task × 3 variants × 2)", planLegacy.samples === 6)
  check("legacy plan.requests.lo == 18 (3 stages × 3 variants × 2)", planLegacy.requests.lo === 18)
  check("legacy plan.requests.hi == 300 (generic 12 + current 144 + hardened 144 × 2 repeats; 无 longMode → cap=6)", planLegacy.requests.hi === 300)
  check("legacy plan still has token ranges (input.lo>0, output.hi>lo)", planLegacy.tokens.input.lo > 0 && planLegacy.tokens.output.hi > planLegacy.tokens.output.lo)
  check("legacy plan.cost is CostRange", typeof planLegacy.cost === "object" && planLegacy.cost !== "unknown")
  check("legacy estDurationMinutes.hi >= lo", planLegacy.estDurationMinutes.hi >= planLegacy.estDurationMinutes.lo)

  // 8. 无 profile（传 null）→ cost=unknown
  const planNoProfile = estimateRunPlan(taskDefs5, variants3, 1, null)
  check("plan(no profile).cost == 'unknown'", planNoProfile.cost === "unknown")
  check("plan(no profile).allInCostCny == 'unknown'", planNoProfile.allInCostCny === "unknown")

  // 8b. R04/R05：加载真实 tasks.json，校验每个 stage 都有 targetChars，并与 selftest 的 taskDefs5 逐 stage 一致
  const tasksJsonPath = path.resolve(__dirname, "..", "scripts", "eval-tasks", "tasks.json")
  const tasksJsonOk = fs.existsSync(tasksJsonPath)
  check("tasks.json exists (真实加载)", tasksJsonOk)
  let allStagesHaveTarget = false
  let parityOk = false
  let outlineTargetNot10000 = false
  if (tasksJsonOk) {
    const raw = JSON.parse(fs.readFileSync(tasksJsonPath, "utf-8")) as { tasks?: Array<{ id: string; longMode?: boolean; stages?: Array<{ stageId: string; targetChars?: number }> }> }
    const realTasks = raw.tasks ?? []
    // a) 所有 stage 都有 targetChars（真实校验）
    allStagesHaveTarget = realTasks.length > 0 && realTasks.every((t) => (t.stages ?? []).every((s) => typeof s.targetChars === "number" && Number.isFinite(s.targetChars!)))
    check("tasks.json 每个 stage 都有 targetChars（真实校验）", allStagesHaveTarget)
    // b) 各 stage target 与 selftest taskDefs5 一致（逐 stage 对齐）
    const realMap = new Map<string, number>()
    for (const t of realTasks) for (const s of t.stages ?? []) realMap.set(`${t.id}:${s.stageId}`, s.targetChars ?? -1)
    const defsMap = new Map<string, number>()
    const stageBaseById: Record<string, Array<[string, number]>> = {
      "longform-multichapter": [["outline", 200], ["chapter", 3300]],
      "character-consistency": [["setup", 200], ["scene", 200]],
      "style-transfer": [["extract", 120], ["generate", 500]],
      "renpy-scene-branch": [["generate", 800]],
      "failure-recovery": [["truncated-continuation", 150], ["partial-continue", 450]]
    }
    for (const [tid, pairs] of Object.entries(stageBaseById)) for (const [sid, tc] of pairs) defsMap.set(`${tid}:${sid}`, tc)
    parityOk = [...defsMap.keys()].every((k) => realMap.get(k) === defsMap.get(k)) && realMap.size === defsMap.size
    check("各 stage target 与 tasks.json 一致（parity）", parityOk)
    // c) longform outline 的 target 不是 10000（总目标不下沉到 outline）
    const outlineTarget = realMap.get("longform-multichapter:outline")
    outlineTargetNot10000 = typeof outlineTarget === "number" && outlineTarget !== 10000
    check("longform outline.targetChars != 10000", outlineTargetNot10000)
    console.log(`       tasks.json stages=${[...realMap.keys()].length} (all have targetChars=${allStagesHaveTarget}, parity=${parityOk}, outlineTarget=${outlineTarget})`)
  }

  // 8c. R05.2d：all-in 上界 ≥ base（单调性）
  const monotonicOk =
    plan5.allInRequestMax >= plan5.baseProviderCalls &&
    plan5.allInRequestMax >= plan5.maxCompletionRounds &&
    plan5.allInInputTokens.lo >= plan5.tokens.input.lo &&
    plan5.allInOutputTokens.hi >= plan5.tokens.output.hi
  check("all-in 上界 ≥ base（requests / tokens 单调性）", monotonicOk)

  // 9. computeSampleCost：有 usage → 数值；无 usage → unknown
  const usage: SampleUsage = { prompt_tokens: 1200, completion_tokens: 11000, prompt_cache_hit_tokens: 600 }
  const cost = computeSampleCost(usage, profile, "deepseek-v4-flash")
  check("computeSampleCost(usage) returns numbers", typeof cost === "object" && typeof (cost as SampleCost).total === "number")
  const costNoUsage = computeSampleCost(null, profile)
  check("computeSampleCost(null) == 'unknown'", costNoUsage === "unknown")
  const costNoProfile = computeSampleCost(usage, null)
  check("computeSampleCost(usage, null profile) == 'unknown'", costNoProfile === "unknown")
  const costUnknownModel = computeSampleCost(usage, profile, "unpriced-model-codex-probe")
  check("computeSampleCost(unknown model) == 'unknown'（无首条回退）", costUnknownModel === "unknown")

  // 9b. R25-P1-02：cache miss/hit 修正——新公式 ≠ 旧双计；手算恒等；upper 与 actual 分栏
  const usageCache: SampleUsage = { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 }
  const costCache = computeSampleCost(usageCache, profile, "deepseek-v4-flash")
  const handNew = (400 * 2 + 600 * 0.4 + 500 * 8) / 1_000_000
  const handOld = (1000 * 2 + 600 * 0.4 + 500 * 8) / 1_000_000
  const handUpper = (1000 * 2 + 500 * 8) / 1_000_000
  check("cache actual == miss×input+hit×cache+out×output（手算恒等）", typeof costCache === "object" && Math.abs(costCache.total - handNew) < 1e-9)
  check("旧双计公式 ≠ actual（旧公式必红）", Math.abs(handOld - handNew) > 1e-9)
  check("cache upper == prompt×input+out×output（与 actual 分栏）", typeof costCache === "object" && Math.abs(costCache.upper - handUpper) < 1e-9)
  const costHitGt = computeSampleCost({ prompt_tokens: 100, prompt_cache_hit_tokens: 150, completion_tokens: 10 }, profile, "deepseek-v4-flash")
  check("hit>prompt → actualKnown=false", typeof costHitGt === "object" && costHitGt.actualKnown === false)
  const costMismatch = computeSampleCost({ prompt_tokens: 1000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 500, completion_tokens: 10 }, profile, "deepseek-v4-flash")
  check("hit+miss!=prompt → actualKnown=false", typeof costMismatch === "object" && costMismatch.actualKnown === false)

  // 10. usageCoverage + assertUsagePresent（R19-R03 usage 口径）
  const samplesMixed: SampleUsageLike[] = [
    { usageStatus: "present" }, { usageStatus: "present" }, { usageStatus: "missing" }, { usageStatus: "present" }
  ]
  const uc = usageCoverage(samplesMixed)
  check("usageCoverage present == 3", uc.present === 3)
  check("usageCoverage missing == 1", uc.missing === 1)
  check("usageCoverage total == 4", uc.total === 4)
  check("usageCoverage empty → {0,0,0}", (() => { const e = usageCoverage([]); return e.present === 0 && e.missing === 0 && e.total === 0 })())
  check("assertUsagePresent(present) == true", assertUsagePresent({ usageStatus: "present" }) === true)
  check("assertUsagePresent(missing) == false", assertUsagePresent({ usageStatus: "missing" }) === false)
  check("assertUsagePresent(undefined status) == false", assertUsagePresent({}) === false)

  // 11. buildRunManifest 全字段 → manifestValidate ok
  const commit = "614e428000000000000000000000000000000000".slice(0, 40)
  const startedAt = new Date(Date.now() - 15000).toISOString()
  const finishedAt = new Date().toISOString()
  const manifest = buildRunManifest({
    commit,
    dirtyFiles: [],
    nodeVersion: "v24.19.0",
    electronVersion: null,
    platform: `${process.platform}-${process.arch}`,
    taskSchemaHash: hash,
    variantContractHashes: { baseline: hash, memorypack: hash },
    runnerSourceHash: hash,
    seed: 42,
    argv: ["--real", "--repeats=3"],
    synthetic: false,
    real: true,
    startedAt,
    finishedAt,
    priceProfileHash: hash,
    priceProfileId: profile?.profileId ?? "",
    model: "deepseek-v4-flash",
    repeats: 3,
    tasks: [{ id: "continuation-10k", targetChars: 10000, stages: 3 }],
    variants: [{ id: "baseline" }],
    plannedRequests: 45,
    actualRequests: 47,
    outerRetries: 2,
    innerRetries: 0,
    usageCoverage: { present: 45, missing: 2, total: 47 },
    requestTraceHash: hash,
    experimentMode: "controlled",
    sampleCounts: { total: 47, success: 45, failed: 2, validationPassed: 44, validationFailed: 3 },
    artifactHashes: { samplesSha256: hash, variantsSha256: hash }
  })
  const vManifest = manifestValidate(manifest)
  check("manifestValidate ok on full manifest", vManifest.ok)
  console.log(`       manifest commit=${manifest.commit} synthetic=${manifest.synthetic} real=${manifest.real} priceProfileId=${manifest.priceProfileId}`)

  // 11b. durationMs 一致性好/坏（R19-R05）
  check("manifest.durationMs >= 0", manifest.durationMs >= 0)
  check("manifest.durationMs ≈ finishedAt - startedAt", Math.abs((Date.parse(finishedAt) - Date.parse(startedAt)) - manifest.durationMs) < 2000)
  const goodDuration = manifestValidate(manifest)
  check("durationConsistent(good) == true", durationConsistent(manifest.startedAt, manifest.finishedAt, manifest.durationMs) === true)
  const badDurManifest: Record<string, unknown> = JSON.parse(JSON.stringify(manifest))
  badDurManifest.durationMs = 999999999 // 与真实时间戳差远超 2s
  const vBadDur = manifestValidate(badDurManifest)
  check("manifestValidate FAIL on inconsistent durationMs", !vBadDur.ok && vBadDur.errors.some((e) => e.includes("durationMs")))
  const negDurManifest: Record<string, unknown> = JSON.parse(JSON.stringify(manifest))
  negDurManifest.durationMs = -5
  const vNegDur = manifestValidate(negDurManifest)
  check("manifestValidate FAIL on negative durationMs", !vNegDur.ok && vNegDur.errors.some((e) => e.includes("durationMs")))

  // 11c. usageCoverage 校验：total != present+missing → FAIL
  const badUcManifest: Record<string, unknown> = JSON.parse(JSON.stringify(manifest))
  badUcManifest.usageCoverage = { present: 45, missing: 2, total: 46 }
  const vBadUc = manifestValidate(badUcManifest)
  check("manifestValidate FAIL when usageCoverage.total != present+missing", !vBadUc.ok && vBadUc.errors.some((e) => e.includes("usageCoverage")))

  // 12. 删 commit 字段 → FAIL
  const tamperedManifest: Record<string, unknown> = JSON.parse(JSON.stringify(manifest))
  delete tamperedManifest.commit
  const vManifestNoCommit = manifestValidate(tamperedManifest)
  check("manifestValidate FAIL after deleting commit", !vManifestNoCommit.ok && vManifestNoCommit.errors.some((e) => e.includes("commit")))

  // 12b. 老 manifest（无本轮新字段）→ FAIL（R21-R04：本轮起强制新口径，每个缺失字段都要报错）
  const legacyManifest: Record<string, unknown> = JSON.parse(JSON.stringify(manifest))
  delete legacyManifest.durationMs
  delete legacyManifest.plannedRequests
  delete legacyManifest.actualRequests
  delete legacyManifest.outerRetries
  delete legacyManifest.innerRetries
  delete legacyManifest.usageCoverage
  delete legacyManifest.requestTraceHash
  delete legacyManifest.experimentMode
  delete legacyManifest.sampleCounts
  delete legacyManifest.artifactHashes
  const vLegacy = manifestValidate(legacyManifest)
  check("manifestValidate FAIL on legacy manifest (R21 mandatory fields absent)", !vLegacy.ok)
  const requiredMissingFields = ["durationMs", "plannedRequests", "actualRequests", "outerRetries", "innerRetries", "usageCoverage", "requestTraceHash", "experimentMode", "sampleCounts", "artifactHashes"]
  check("legacy manifest reports every missing required field", requiredMissingFields.every((f) => vLegacy.errors.some((e) => e.startsWith(`${f} `) || e.includes(`${f}`))))

  // 12c. 新 manifest 事实字段断言（buildRunManifest 落位 + manifestValidate 全过）
  check("manifest.experimentMode is controlled", manifest.experimentMode === "controlled")
  check("manifest.sampleCounts.success+failed == total", manifest.sampleCounts.success + manifest.sampleCounts.failed === manifest.sampleCounts.total)
  check("manifest.sampleCounts.validationPassed+validationFailed == total", manifest.sampleCounts.validationPassed + manifest.sampleCounts.validationFailed === manifest.sampleCounts.total)
  check("manifest.artifactHashes.samplesSha256 is 64-hex", SHA256_RE.test(manifest.artifactHashes.samplesSha256))
  check("manifest.artifactHashes.variantsSha256 is 64-hex", SHA256_RE.test(manifest.artifactHashes.variantsSha256))
  check("manifest.actualRequests == 47 (trace count 口径由 validator 深校验)", manifest.actualRequests === 47)
  check("manifest.outerRetries == 2", manifest.outerRetries === 2)
  check("manifest.innerRetries == 0 (mock)", manifest.innerRetries === 0)

  // 12c-b. R22 主代理对账：innerRetries=null（内层未观测）必须被 manifestValidate 接受（禁止用 0 冒充未观测）
  const nullInnerManifest: Record<string, unknown> = JSON.parse(JSON.stringify(manifest))
  nullInnerManifest.innerRetries = null
  nullInnerManifest.innerRetriesObserved = false
  check("manifestValidate ACCEPTS innerRetries=null when innerRetriesObserved=false", manifestValidate(nullInnerManifest).ok)
  const lyingInnerManifest: Record<string, unknown> = JSON.parse(JSON.stringify(manifest))
  lyingInnerManifest.innerRetries = null
  lyingInnerManifest.innerRetriesObserved = true
  check("manifestValidate REJECTS innerRetries=null when innerRetriesObserved=true", !manifestValidate(lyingInnerManifest).ok)

  // 12d. experimentMode 非法 → FAIL；artifactHashes 非 64-hex → FAIL；sampleCounts 和不等 → FAIL
  const badModeManifest: Record<string, unknown> = JSON.parse(JSON.stringify(manifest))
  badModeManifest.experimentMode = "bogus"
  check("manifestValidate FAIL on invalid experimentMode", !manifestValidate(badModeManifest).ok && manifestValidate(badModeManifest).errors.some((e) => e.includes("experimentMode")))
  const badArtifactManifest: Record<string, unknown> = JSON.parse(JSON.stringify(manifest))
  badArtifactManifest.artifactHashes = { samplesSha256: "xyz", variantsSha256: hash }
  check("manifestValidate FAIL on non-64-hex artifactHashes.samplesSha256", !manifestValidate(badArtifactManifest).ok && manifestValidate(badArtifactManifest).errors.some((e) => e.includes("artifactHashes.samplesSha256")))
  const badScManifest: Record<string, unknown> = JSON.parse(JSON.stringify(manifest))
  badScManifest.sampleCounts = { total: 47, success: 40, failed: 2, validationPassed: 44, validationFailed: 3 }
  check("manifestValidate FAIL when sampleCounts.success+failed != total", !manifestValidate(badScManifest).ok && manifestValidate(badScManifest).errors.some((e) => e.includes("success + failed")))

  // 13. 坏 sha256 → FAIL
  const badHashManifest = JSON.parse(JSON.stringify(manifest))
  badHashManifest.runnerSourceHash = "not-a-hash"
  const vBadHash = manifestValidate(badHashManifest)
  check("manifestValidate FAIL on invalid hash", !vBadHash.ok && vBadHash.errors.some((e) => e.includes("runnerSourceHash")))

  // 14. scanForLeaks：含假 key 命中；正常文本 0 命中
  const fakeKeyText = "测试内容 sk-abc123def456ghi789jkl012mnop345"
  const cleanText = "这是一个正常的评测说明，无任何密钥或敏感路径。"
  const leakHits = scanForLeaks([fakeKeyText, cleanText])
  check("scanForLeaks hits on fake key (>=1, non-empty)", leakHits.hits.length >= 1)
  const cleanOnly = scanForLeaks([cleanText])
  check("scanForLeaks zero hits on clean text", cleanOnly.hits.length === 0)
  console.log(`       scanForLeaks hits=${leakHits.hits.length} (期望 >=1，且 matched 已打码)`)

  // 15. 假 key 打码验证：matched 绝不含原始 key 子串
  const anyKeyLeaked = leakHits.hits.some((h) => h.matched.includes("abc123def456"))
  check("scanForLeaks redacts matched (no raw key substring)", !anyKeyLeaked)

  // 16. computeExitDecision：每分支覆盖（≥8 用例，逐分支报 exitCode/reason）
  const base: ExitDecisionState = {
    mode: "mock",
    blockedNoKey: false,
    samplesTotal: 15,
    samplesOk: 15,
    validationPassed: 15,
    fairnessFail: false,
    manifestOk: true,
    missingVariants: false,
    missingSamples: false
  }
  const dec = (s: Partial<ExitDecisionState>): ExitDecision => computeExitDecision({ ...base, ...s })
  // 16a. ok
  check("exitDecision ok → {0,ok}", (() => { const d = dec({}); return d.exitCode === 0 && d.reason === "ok" })())
  // 16b. blockedNoKey
  check("exitDecision blockedNoKey → {0,blocked_not_run}", (() => { const d = dec({ blockedNoKey: true, samplesOk: 0 }); return d.exitCode === 0 && d.reason === "blocked_not_run" })())
  // 16c. all_samples_failed（real 全失败也必须非零）
  check("exitDecision samplesOk===0 → {1,all_samples_failed}", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 0, validationPassed: 0 }); return d.exitCode === 1 && d.reason === "all_samples_failed" })())
  // 16d. incomplete_pairing（missingVariants）
  check("exitDecision missingVariants → {1,incomplete_pairing}", (() => { const d = dec({ missingVariants: true }); return d.exitCode === 1 && d.reason === "incomplete_pairing" })())
  // 16e. incomplete_pairing（missingSamples）
  check("exitDecision missingSamples → {1,incomplete_pairing}", (() => { const d = dec({ missingSamples: true }); return d.exitCode === 1 && d.reason === "incomplete_pairing" })())
  // 16f. fairness_blocked
  check("exitDecision fairnessFail → {1,fairness_blocked}", (() => { const d = dec({ fairnessFail: true }); return d.exitCode === 1 && d.reason === "fairness_blocked" })())
  // 16g. manifest_invalid
  check("exitDecision !manifestOk → {1,manifest_invalid}", (() => { const d = dec({ manifestOk: false }); return d.exitCode === 1 && d.reason === "manifest_invalid" })())
  // 16h. R23-R03：mock/real 统一失败样本阻断（Codex P0-02 红灯口径，替代旧 mock_pipeline_broken）
  check("exitDecision mock failed>0 → {1,samples_failed}", (() => { const d = dec({ mode: "mock", samplesTotal: 15, samplesOk: 14 }); return d.exitCode === 1 && d.reason === "samples_failed" })())
  // 16i. R23-R03 红灯（Codex 要求删除旧「real partial failed → 0,ok」口径）：real 失败样本必须非零
  check("exitDecision real failed + validation pass → {1,samples_failed}", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 14, validationPassed: 15, validationRequired: 15 }); return d.exitCode === 1 && d.reason === "samples_failed" })())
  // 16i-b. R23-R05：请求/费用熔断
  check("exitDecision budgetExhausted → {1,budget_exhausted}", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 15, validationPassed: 15, budgetExhausted: true }); return d.exitCode === 1 && d.reason === "budget_exhausted" })())
  // 16j. 优先级：blockedNoKey 压过 all samples failed
  check("exitDecision blockedNoKey overrides samplesOk===0 → {0,blocked_not_run}", (() => { const d = dec({ mode: "real", blockedNoKey: true, samplesTotal: 15, samplesOk: 0 }); return d.exitCode === 0 && d.reason === "blocked_not_run" })())

  // 17. R22-R04 新分支：validationPassed < validationRequired → incomplete_quality_validation（P0-04）
  check("exitDecision validationPassed=0/samplesOk>0 → {1,incomplete_quality_validation}", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 15, validationPassed: 0, validationRequired: 15 }); return d.exitCode === 1 && d.reason === "incomplete_quality_validation" })())
  check("exitDecision validationPassed(5)<required(15) → {1,incomplete_quality_validation}", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 15, validationPassed: 5, validationRequired: 15 }); return d.exitCode === 1 && d.reason === "incomplete_quality_validation" })())
  check("exitDecision validationPassed==required → ok", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 15, validationPassed: 15, validationRequired: 15 }); return d.exitCode === 0 && d.reason === "ok" })())
  // validationRequired 缺省回退 samplesTotal（保持旧调用方向后兼容）
  check("exitDecision validationRequired defaults to samplesTotal (legacy caller ok)", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 15, validationPassed: 15 }); return d.exitCode === 0 && d.reason === "ok" })())
  // 全部 HTTP 成功（samplesOk==total）但 validationPassed=0 且未显式 required → 仍非零（P0-04 核心）
  check("exitDecision all-http-ok + validationPassed=0 (no explicit required) → nonzero", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 15, validationPassed: 0 }); return d.exitCode === 1 && d.reason === "incomplete_quality_validation" })())

  // 18. R22-R04 新分支：samplesAborted>0 → aborted_samples
  check("exitDecision samplesAborted=1 → {1,aborted_samples}", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 14, validationPassed: 14, validationRequired: 14, samplesAborted: 1 }); return d.exitCode === 1 && d.reason === "aborted_samples" })())
  check("exitDecision samplesAborted=0 → not aborted_samples", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 15, validationPassed: 15, validationRequired: 15, samplesAborted: 0 }); return d.exitCode === 0 && d.reason === "ok" })())
  // 优先级：validationFail 压过 aborted
  check("exitDecision validationFail overrides samplesAborted → {1,incomplete_quality_validation}", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 14, validationPassed: 5, validationRequired: 15, samplesAborted: 1 }); return d.exitCode === 1 && d.reason === "incomplete_quality_validation" })())

  // 19. R22-R04 retry-success（failures>0 但 completedStages==planned 且 aborted=false）→ 仍 ok
  //     （exit 判定只看 exit-侧事实：samplesOk>0、validation 达标、无 aborted；failures 属 validator 侧口径）
  check("exitDecision retry-success (failures>0, validation ok, aborted=0) → {0,ok}", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 15, validationPassed: 15, validationRequired: 15, samplesAborted: 0 }); return d.exitCode === 0 && d.reason === "ok" })())
  // 优先级：validationFail / aborted 位于 blocked 之后、ok 之前——不得压过 blocked
  check("exitDecision blockedNoKey beats validationFail → {0,blocked_not_run}", (() => { const d = dec({ blockedNoKey: true, samplesOk: 15, samplesTotal: 15, validationPassed: 0, validationRequired: 15, samplesAborted: 2 }); return d.exitCode === 0 && d.reason === "blocked_not_run" })())
  // 优先级：all_samples_failed 压过 validationFail（全失败时的根因更准）
  check("exitDecision samplesOk===0 beats validationFail → {1,all_samples_failed}", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 0, validationPassed: 0, validationRequired: 15 }); return d.exitCode === 1 && d.reason === "all_samples_failed" })())
  // 优先级：samples_failed 压过 validationFail（失败样本根因优先于校验口径；R23-R03 统一 mock/real）
  check("exitDecision samplesFailed beats validationFail → {1,samples_failed}", (() => { const d = dec({ mode: "mock", samplesTotal: 15, samplesOk: 14, validationPassed: 0, validationRequired: 15 }); return d.exitCode === 1 && d.reason === "samples_failed" })())
  // 边界：validationRequired=0 时不应因 validationPassed(0)<0 误判（0<0 false → ok 分支）
  check("exitDecision validationRequired=0 + validationPassed=0 → {0,ok}", (() => { const d = dec({ mode: "real", samplesTotal: 15, samplesOk: 15, validationPassed: 0, validationRequired: 0 }); return d.exitCode === 0 && d.reason === "ok" })())
  // R22 主代理对账：请求账本与端点实收不一致 → 非零（且压过 validationFail 之前的常规分支）
  check("exitDecision accountingBroken → {1,ledger_endpoint_mismatch}", (() => { const d = dec({ mode: "mock", samplesTotal: 15, samplesOk: 15, validationPassed: 15, accountingBroken: true }); return d.exitCode === 1 && d.reason === "ledger_endpoint_mismatch" })())

  console.log("")
  console.log(`===== selftest done: ${pass} PASS / ${fail} FAIL =====`)
  if (fail > 0) {
    console.error("FAILED:", failures.join(", "))
    process.exit(1)
  }
}

// 主代理整合修复：仅在直接执行时跑 main（被 import 时不得执行 CLI 分支）
const invokedDirectly = !!process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  main().catch((e) => {
    console.error("eval-preflight 执行异常：", e)
    process.exit(1)
  })
}
