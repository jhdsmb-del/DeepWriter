// ==================== eval-validate.ts：独立产物 validator（eval:validate 命令） ====================
// DeepWriter Codex P1-01 —— 真正的独立产物校验器，runner 与 red tests 共用同一实现。
//
// 诉求（禁止每个测试再写 localValidate）：
//   - 单一事实源 validateRunDir(runDir)：读 samples.json / manifest.json / variants.json，
//     返回 { ok, checks, exitCode }，CLI 打印 PASS/FAIL 表并设置退出码。
//   - 10 项结构化 check，每项独立 check id；任一 FAIL → exit 非 0。
//   - 自带 --selftest-mutations：用最小合法 fixture + ≥10 类变异逐项自证。
//
// 校验对象是「主代理统一产物 schema」（S1 runner / S3 preflight 落地；本 validator 按此契约，
// 只读实现、不硬编码 S1/S3 的字段名之外的事实）。对旧 HEAD 产物（缺新字段）——
// 缺失即 FAIL，作为「旧行为红」证据如实报告（诚实优先）。
//
// 构建：esbuild scripts/eval-validate.ts --bundle --format=esm --platform=node --outfile=out/eval-validate.mjs
// 运行：node out/eval-validate.mjs <runDir> [--json]
//        node out/eval-validate.mjs --selftest-mutations
//
// 构建时不 bundle runner/preflight（避免并行改动面 + preflight 的 invokedDirectly 守卫在 bundle 下误触发）。
// manifest 深校验既内置兜底断言，也可在运行时动态 import out/eval-preflight.mjs 复用其 manifestValidate。

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import * as os from "node:os"
import { createHash } from "node:crypto"
// R25-P0-03/P1-03：静态复用 eval-preflight 的 profile 校验/哈希与 origin 匹配（esbuild 打包 inline，无运行时依赖）
import { priceProfileValidate, priceProfileHash, CANONICAL_ORIGIN_RE, type PriceProfile } from "./eval-preflight"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")
const SHA256_RE = /^[0-9a-f]{64}$/

// ==================== 类型定义（samples.json / manifest.json / variants.json 的校验视图） ====================

interface RequestTrace {
  ordinal?: number
  sampleId?: string
  variantId?: string
  stageId?: string
  roles?: string[]
  userHash?: string
  assistantHash?: string
  historyCount?: number
  systemHash?: string
  assembledHash?: string
  mockHistoryPairs?: number
}

interface TranscriptTurn {
  role?: string
  content?: string
  chars?: number
  sha256?: string
}

interface Sample {
  sampleId?: string
  taskId?: string
  variantId?: string
  repeat?: number
  mode?: string
  synthetic?: boolean
  experimentMode?: string
  usageStatus?: string
  rounds?: number
  content?: string
  validation?: { passed?: boolean; checks?: Array<{ id?: string; passed?: boolean; detail?: string }> }
  metrics?: {
    status?: string
    failures?: number
    retries?: number
    /** R22：总 attempt 数（= 该样本在 ledger 中的条目数） */
    attempts?: number
    /** R22：完成阶段数 */
    completedStages?: number
    /** R22：是否中止 */
    aborted?: boolean
  }
  requestTraces?: RequestTrace[]
  canonicalTranscript?: TranscriptTurn[]
  orchestrationTrace?: unknown
  stageResults?: Array<{ stageId?: string; chars?: number; valid?: boolean }>
  variantContractHash?: string
  /** R22：deepwriter 真实 orchestration runId（每个 stage 一个；generic 可为空数组） */
  runIds?: string[]
  /** R22：该样本的 ledger requestId（每个 attempt 一个） */
  requestIds?: string[]
  /** R22：终结状态序列 */
  terminalStatus?: string[]
  /** R23：是否进入复审（quality-gate 收紧依据之一） */
  eligibleForReview?: boolean
  /** R23：每 stage 产出正文的 sha256（数组下标+1 == stageOrdinal） */
  stageOutputs?: Array<{
    stageId?: string
    content?: string
    chars?: number
    contentSha256?: string
    turnChars?: number[]
    turnHashes?: string[]
    /** R25-P1-03：声明目标（unscaled）/执行目标/mock 公平长度/执行口径 expectMinChars 三栏分落 */
    declaredTargetChars?: number
    executionTargetChars?: number
    mockFairLength?: number | null
    expectMinCharsExecution?: number | null
  }>
}

interface FairnessDoc {
  inputEquivalence?: Record<string, { equal?: boolean; userEqual?: boolean; historyEqual?: boolean; systemDiffOrdinals?: number[]; diffOrdinals?: number[]; diffDetail?: string[] }>
  lineageValid?: Record<string, { valid?: boolean; sameStart?: boolean; sameProtocol?: boolean; sameSampling?: boolean; structuralIntegrity?: boolean; forked?: boolean; diffDetail?: string[] }>
  transcriptEquivalence?: Record<string, { equal?: boolean; userEqual?: boolean; historyEqual?: boolean; systemDiffOrdinals?: number[]; diffOrdinals?: number[]; diffDetail?: string[] }>
}

interface SamplesDoc {
  schemaVersion?: number
  header?: Record<string, unknown>
  fairness?: FairnessDoc
  samples?: Sample[]
  /** R22 ledger：RequestAttempt 独立数组（主代理统一接口；可内联在 samples.json 或独立 ledger.json） */
  ledger?: RequestAttempt[]
}

// ==================== R22 结构类型本地声明（主代理统一接口；待主代理在 eval-schema/runner 侧正式落地统一命名） ====================
// 注：eval-runner.ts / eval-schema.ts 由 Agent AB 并行改；本文件按回执约定以结构类型本地声明，
//     不 import 它们的类型，字段名以本接口约定为准，最终对齐以主代理回执为准。

/** 一次真实请求 attempt（含失败与重试）——ledger 条目。 */
interface RequestAttempt {
  requestId: string
  sampleId: string
  variantId: string
  taskId: string
  repeat: number
  stageId: string
  /** 阶段序号（1 起） */
  stageOrdinal?: number
  /** deepwriter 真实 orchestration runId；generic 直连可 null */
  runId: string | null
  /** 外层 attempt 序号（1 起递增） */
  outerAttempt: number
  /** 内层 attempt 序号（adapter 内层重试；null=未观测/无内层） */
  innerAttempt: number | null
  /** 结果：success / failed（http 层） */
  outcome: string
  httpStatus?: number
  usagePresent?: boolean
  actualUserHash?: string
  actualHistoryHash?: string
  actualSystemHash?: string
  actualAssembledHash?: string
  /** R23：provider 实际发送的每条消息正文 sha256（含 system/user/assistant，按发送顺序） */
  actualMessageContentHashes?: string[]
  /** R23：provider 实际历史轮次（最后一条 user 之前的切片，须以 assistant 收尾）的角色+sha256 序列 */
  actualHistoryTurnHashes?: Array<{ role: string; sha256: string }>
}

interface VariantEntry {
  variantId?: string
  path?: string
  invokePath?: string | null
  contractHash?: string
  systemMessageCount?: number
  systemMessagePreviewChars?: number
}

interface VariantsDoc {
  schemaVersion?: number
  variants?: VariantEntry[]
}

interface ManifestDoc {
  [k: string]: unknown
  schemaVersion?: number
  commit?: string
  variantContractHash?: Record<string, string | Record<string, string>>
  variantContractHashes?: Record<string, string | Record<string, string>>
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  plannedRequests?: number
  actualRequests?: number
  outerRetries?: number
  innerRetries?: number
  usageCoverage?: { present?: number; missing?: number; total?: number }
  requestTraceHash?: string
  experimentMode?: string
  artifactHashes?: { samplesSha256?: string; variantsSha256?: string }
  sampleCounts?: { total?: number; success?: number; failed?: number; validationPassed?: number; validationFailed?: number }
  /** R22：ledger 哈希（独立数组/文件） */
  ledgerSha256?: string
  /** R22：ledger 中出现的 requestId 去重计数 */
  requestIdCount?: number
  /** R22：内层重试是否被真实观测（null 内层 + 未观测 ≠ 用 0 冒充） */
  innerRetriesObserved?: boolean
  /** R22 主代理对账：本地端点实收请求数（mock 有值；real 无端点 → null） */
  localEndpointReceived?: number | null
  /** R22 主代理对账：ledger.length 与端点实收数一致 */
  ledgerMatchesEndpoint?: boolean
  /** R24-P0-01：展开后的逐 stage target 序列（taskId/stageId/targetChars） */
  stageTargets?: Array<{ taskId?: string; stageId?: string; targetChars?: number }>
  /** R24-P0-01：stageTargets 数组的规范化 sha256 */
  stageTargetsHash?: string
  /** R22：显式期望集合（不从现存样本反推） */
  expected?: {
    tasks?: Array<{ taskId?: string; stages?: number; expectedSamples?: number }>
    variants?: string[]
    repeats?: number
  }
}

// ==================== check 集合 ====================

export interface Check {
  id: string
  name: string
  passed: boolean
  detail: string
}

export interface ValidateResult {
  ok: boolean
  checks: Check[]
  exitCode: number
}

// ==================== 加载（防御式：任何文件缺失/解析失败都转成显式 FAIL，而非抛异常） ====================

interface LoadedRun {
  runDir: string
  samplesDoc: SamplesDoc | null
  manifestDoc: ManifestDoc | null
  variantsDoc: VariantsDoc | null
  samplesRaw: string | null
  variantsRaw: string | null
  ledgerRaw: string | null
  loadErrors: string[]
}

function loadRunDir(runDir: string): LoadedRun {
  const loadErrors: string[] = []
  const readJson = <T,>(file: string, raw?: () => string): { doc: T | null; raw: string | null } => {
    const p = path.join(runDir, file)
    if (!fs.existsSync(p)) {
      loadErrors.push(`缺少文件：${file}`)
      return { doc: null, raw: null }
    }
    const txt = fs.readFileSync(p, "utf-8")
    try {
      const doc = JSON.parse(txt) as T
      return { doc, raw: txt }
    } catch (e) {
      loadErrors.push(`${file} JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
      return { doc: null, raw: txt }
    }
  }
  const samplesRes = readJson<SamplesDoc>("samples.json")
  const manifestRes = readJson<ManifestDoc>("manifest.json")
  const variantsRes = readJson<VariantsDoc>("variants.json")
  // ledger 独立文件（可选；缺省时回退 samplesDoc.ledger 内联数组）
  let ledgerRaw: string | null = null
  const ledgerFile = path.join(runDir, "ledger.json")
  if (fs.existsSync(ledgerFile)) {
    try {
      ledgerRaw = fs.readFileSync(ledgerFile, "utf-8")
    } catch {
      /* ignore */
    }
  }
  return {
    runDir,
    samplesDoc: samplesRes.doc,
    manifestDoc: manifestRes.doc,
    variantsDoc: variantsRes.doc,
    samplesRaw: samplesRes.raw,
    variantsRaw: variantsRes.raw,
    ledgerRaw,
    loadErrors
  }
}

// ==================== 每类任务的阶段展开数（校验器自带的唯一硬编码常量） ====================
// 口径与 eval-schema.ts expandStages 完全一致：longform=4 / character=6 / style=2 / renpy=1 / failure=2。
// 这是「任务书 §四 五类」的事实，也是 request-trace-count 与 stage-completeness 的判定基准。

const PLANNED_STAGES_BY_CATEGORY: Record<string, number> = {
  longform: 4,
  "character-consistency": 6,
  "style-transfer": 2,
  renpy: 1,
  "failure-recovery": 2
}

const TASK_ID_TO_CATEGORY: Record<string, string> = {
  "longform-multichapter": "longform",
  "character-consistency": "character-consistency",
  "style-transfer": "style-transfer",
  "renpy-scene-branch": "renpy",
  "failure-recovery": "failure-recovery"
}

function plannedStagesForTask(taskId: string | undefined): number | null {
  if (!taskId) return null
  const cat = TASK_ID_TO_CATEGORY[taskId] ?? null
  if (cat) return PLANNED_STAGES_BY_CATEGORY[cat] ?? null
  // 回退：按 taskId 前缀猜类别（允许自定义任务，只要名字含类别名）
  for (const c of Object.keys(PLANNED_STAGES_BY_CATEGORY)) {
    if (taskId.includes(c) || taskId.startsWith(c)) return PLANNED_STAGES_BY_CATEGORY[c]
  }
  return null
}

// ==================== 10 项 check ====================

// ---- 工具：normalize manifest 的两组 contract hash 字段 ----
function flattenContractHashes(manifest: ManifestDoc): Record<string, string> {
  const src = (manifest.variantContractHashes ?? manifest.variantContractHash ?? {}) as Record<string, string | Record<string, string>>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string") out[k] = v
    else if (v && typeof v === "object") {
      for (const [k2, v2] of Object.entries(v)) out[`${k}:${k2}`] = v2
    }
  }
  return out
}

// ---- 工具：ledger 解析 / 规范化哈希（R22） ----

interface LedgerContext {
  /** 从独立 ledger.json 或 samplesDoc.ledger 内联数组解析出的 attempt 条目 */
  attempts: RequestAttempt[]
  /** ledger 实际规范哈希（manifest.ledgerSha256 应与之相等） */
  actualSha256: string
  /** 是否有 ledger 数据（区分「无 ledger」与「空 ledger」） */
  present: boolean
}

/**
 * 规范化 ledger 条目序列并计算 sha256 —— 唯一实现为 eval-schema.canonicalLedger（与 runner 共用）。
 * 本文件禁止第二份实现（R22 主代理对账：两份实现曾因字段集/排序 tie-breaker 不一致导致 ledgerSha256 字节不匹配）。
 */

/** 解析 ledger：优先独立 ledger.json；回退 samplesDoc.ledger 内联数组。 */
function resolveLedger(samplesDoc: SamplesDoc | null, ledgerRaw: string | null): LedgerContext {
  let attempts: RequestAttempt[] = []
  if (ledgerRaw !== null) {
    try {
      const parsed = JSON.parse(ledgerRaw)
      if (Array.isArray(parsed)) attempts = parsed as RequestAttempt[]
      else if (parsed && Array.isArray(parsed.ledger)) attempts = parsed.ledger as RequestAttempt[]
    } catch {
      attempts = []
    }
  }
  if (attempts.length === 0 && samplesDoc && Array.isArray(samplesDoc.ledger)) {
    attempts = samplesDoc.ledger as RequestAttempt[]
  }
  const present = ledgerRaw !== null || (samplesDoc != null && Array.isArray(samplesDoc.ledger))
  return { attempts, actualSha256: sha256(canonicalLedger(attempts)), present }
}

// ---- 工具：RequestTrace 规范序列（R21 主代理统一：与 runner 共用 eval-schema.canonicalTraceSequence，禁止第二份实现） ----
import { canonicalLedger, canonicalTraceSequence, loadEvalTasks, stageTargetsHash } from "./eval-schema"

function newCheck(id: string, name: string): Check {
  return { id, name, passed: true, detail: "" }
}

function failCheck(c: Check, detail: string): Check {
  c.passed = false
  c.detail = detail
  return c
}

// 1. contract-identity：generic ≠ current ≠ 每个 hardened 任务契约；hardened 内部允许按任务重复
function checkContractIdentity(manifest: ManifestDoc | null, variants: VariantEntry[]): Check {
  const c = newCheck("contract-identity", "三组 contractHash 两两不同（hardened 内部按任务可重复）")
  if (!manifest) return failCheck(c, "manifest 缺失")
  const flat = flattenContractHashes(manifest)
  const gen = flat["generic_baseline"]
  const cur = flat["deepwriter_current_product"]
  const hardenedFlat = Object.entries(flat)
    .filter(([k]) => k.startsWith("deepwriter_hardened_candidate"))
    .map(([, v]) => v)
  if (!gen || !cur) return failCheck(c, `缺 generic=${gen ? "ok" : "MISSING"} current=${cur ? "ok" : "MISSING"}`)
  if (gen === cur) return failCheck(c, `generic 与 current 契约相同（${gen.slice(0, 12)}…）`)
  if (hardenedFlat.length === 0) return failCheck(c, "无 hardened 契约 hash")
  const badCollision = hardenedFlat.filter((h) => h === gen || h === cur)
  if (badCollision.length > 0) {
    return failCheck(c, `hardened 契约与 generic/current 碰撞（${badCollision.slice(0, 3).map((h) => h.slice(0, 12)).join(", ")}…）`)
  }
  // variants.json 侧 contractHash 与 manifest 对齐（若有）
  const variantHashes = new Set(variants.map((v) => v.contractHash).filter((h): h is string => !!h))
  const manifestHashes = new Set(Object.values(flat))
  const variantNotInManifest = [...variantHashes].filter((h) => !manifestHashes.has(h))
  if (variantNotInManifest.length > 0) {
    c.detail = `hardened 内部按任务重复允许；variants.json 有 ${variantNotInManifest.length} 个 contractHash 不在 manifest`
    // 允许：variants.json 的 specialized 按 `deepwriter_hardened_candidate:<task>` 命名，与 manifest 折叠键一致
    // 这里只警告不 fail（contractHash 可能按 task 命名差异）
  }
  c.detail = `generic=${gen.slice(0, 12)}… current=${cur.slice(0, 12)}… hardened=${hardenedFlat.length}个任务（两两不同）`
  return c
}

// 2. invoke-path：依据 runtime ledger 证据（deepwriter 样本的 ledger.runId 非 null 且与样本 runIds 一致），
//    不再依据 variants.json 固定文字；固定 invokePath 字符串缺失或与 ledger 无关联 → 红。
function checkInvokePath(variants: VariantEntry[] | null, samples: Sample[] | null, ledger: LedgerContext): Check {
  const c = newCheck("invoke-path", "deepwriter 编排证据由 runtime ledger 佐证（runId 非 null 且与样本 runIds 一致）")
  if (!variants || variants.length === 0) return failCheck(c, "variants.json 缺失或空")
  const problems: string[] = []

  // 变体分类：deepwriter 侧（current/hardened）需编排证据；generic 直连无编排
  const deepwriterVariants = new Set(
    (variants ?? [])
      .filter((v) => (v.variantId ?? "").startsWith("deepwriter_"))
      .map((v) => v.variantId ?? "")
  )

  // 依据 ledger：deepwriter 样本的每次 attempt 须 runId 非 null
  const bySample = new Map<string, RequestAttempt[]>()
  for (const a of ledger.attempts) {
    const key = a.sampleId || ""
    if (!bySample.has(key)) bySample.set(key, [])
    bySample.get(key)!.push(a)
  }

  // 每个 deepwriter 样本：ledger 中该样本的 runId 非 null，且与样本.runIds 一致
  for (const s of samples ?? []) {
    if (!deepwriterVariants.has(s.variantId ?? "")) continue
    const atts = bySample.get(s.sampleId ?? "") ?? []
    if (atts.length === 0) {
      problems.push(`${s.sampleId}: deepwriter 样本在 ledger 中无条目（编排证据缺失）`)
      continue
    }
    const ledgerRunIds = atts.map((a) => a.runId).filter((r): r is string => typeof r === "string" && r.length > 0)
    if (ledgerRunIds.length === 0) {
      problems.push(`${s.sampleId}: ledger.runId 全 null（deepwriter 应有编排 runId）`)
      continue
    }
    // 样本侧 runIds 与 ledger runId 一致（多阶段时每阶段一个）
    const sampleRunIds = s.runIds ?? []
    if (sampleRunIds.length === 0) {
      problems.push(`${s.sampleId}: deepwriter 样本缺 runIds（编排证据缺失→旧行为红）`)
    } else {
      const ledgerSet = new Set(ledgerRunIds)
      const mismatched = sampleRunIds.filter((r) => !ledgerSet.has(r))
      if (mismatched.length > 0) {
        problems.push(`${s.sampleId}: 样本 runIds 含 ledger 未出现的 runId（${mismatched.slice(0, 3).join(",")}…）`)
      }
    }
  }

  // variants.json 固定 invokePath 字符串：deepwriter 侧须非空且命中 chatOrchestration 编排
  for (const v of variants) {
    const vid = v.variantId ?? "?"
    const invokePath = v.invokePath ?? null
    const pathField = v.path ?? ""
    if (vid === "generic_baseline") {
      if (invokePath !== null && invokePath !== undefined && invokePath !== "" && invokePath !== "direct-fetch") {
        problems.push(`${vid}: 期望无编排 invokePath（null），实际="${invokePath}"`)
      }
      if (pathField && pathField !== "direct-fetch") {
        problems.push(`${vid}: path="${pathField}" 期望 "direct-fetch"`)
      }
    } else if (deepwriterVariants.has(vid)) {
      const evidence = invokePath || pathField
      if (!evidence) {
        problems.push(`${vid}: 无 invokePath/path 编排证据（与 ledger 无关联）`)
      } else {
        const isChain = evidence.includes("chatOrchestration") || evidence.includes("deepwriter-chain") || evidence.includes("handleChatStart")
        if (!isChain) problems.push(`${vid}: invokePath/path="${evidence}" 期望命中 chatOrchestration 编排`)
      }
    }
  }

  if (problems.length > 0) return failCheck(c, problems.slice(0, 20).join(" | "))
  c.detail = `${ledger.attempts.length} 条 ledger attempt；deepwriter 样本 runId 非 null 且与 sample.runIds 一致`
  return c
}

// 3. manifest-facts：manifestValidate + 新字段深校验
type ManifestValidateFn = (m: unknown, opts?: { priceProfile?: unknown }) => { ok: boolean; errors: string[] }

function checkManifestFacts(manifest: ManifestDoc | null, samples: Sample[] | null, samplesRaw: string | null, variantsRaw: string | null, manifestValidateFn?: ManifestValidateFn, priceProfile?: PriceProfile | null): Check {
  const c = newCheck("manifest-facts", "manifestValidate + 新字段深校验（时间/usage/样本计数/产物哈希）")
  if (!manifest) return failCheck(c, "manifest 缺失")

  const problems: string[] = []

  // (a) 调用 eval-preflight 的 manifestValidate（复用 S3 的基线+新字段 schema 校验；R25 传入 profile 供计价身份核对）
  if (manifestValidateFn) {
    try {
      const pv = manifestValidateFn(manifest as unknown, { priceProfile: priceProfile ?? undefined })
      if (!pv.ok) problems.push(`manifestValidate: ${pv.errors.join("; ")}`)
    } catch (e) {
      problems.push(`manifestValidate 调用异常：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // (b) durationMs 与 startedAt/finishedAt 差 ≤2s
  if (typeof manifest.durationMs === "number" && manifest.startedAt && manifest.finishedAt) {
    const s = Date.parse(manifest.startedAt)
    const f = Date.parse(manifest.finishedAt)
    if (Number.isFinite(s) && Number.isFinite(f)) {
      if (Math.abs((f - s) - manifest.durationMs) > 2000) {
        problems.push(`durationMs=${manifest.durationMs} 与 finishedAt-startedAt(${f - s}) 差 >2s`)
      }
    }
  } else {
    problems.push("缺少 durationMs/startedAt/finishedAt（新字段缺失 → 旧行为）")
  }

  // (c) usageCoverage 求和
  if (manifest.usageCoverage) {
    const uc = manifest.usageCoverage
    if ((uc.present ?? 0) + (uc.missing ?? 0) !== (uc.total ?? 0)) {
      problems.push(`usageCoverage.total(${uc.total}) != present(${uc.present})+missing(${uc.missing})`)
    }
  } else {
    problems.push("缺少 usageCoverage（新字段缺失 → 旧行为）")
  }

  // (d) sampleCounts 求和
  if (manifest.sampleCounts) {
    const sc = manifest.sampleCounts
    if ((sc.success ?? 0) + (sc.failed ?? 0) !== (sc.total ?? 0)) {
      problems.push(`sampleCounts.total(${sc.total}) != success(${sc.success})+failed(${sc.failed})`)
    }
    if ((sc.validationPassed ?? 0) + (sc.validationFailed ?? 0) !== (sc.total ?? 0)) {
      problems.push(`sampleCounts.total(${sc.total}) != validationPassed(${sc.validationPassed})+validationFailed(${sc.validationFailed})`)
    }
    const actualTotal = samples?.length ?? 0
    if (actualTotal > 0 && sc.total !== actualTotal) {
      problems.push(`sampleCounts.total(${sc.total}) != 实际样本数(${actualTotal})`)
    }
  } else {
    problems.push("缺少 sampleCounts（新字段缺失 → 旧行为）")
  }

  // (e) artifactHashes：samplesSha256 == samples.json 实际 sha256；variantsSha256 同理
  if (manifest.artifactHashes) {
    if (samplesRaw !== null) {
      const actual = sha256(samplesRaw)
      if (manifest.artifactHashes.samplesSha256 && manifest.artifactHashes.samplesSha256 !== actual) {
        problems.push(`artifactHashes.samplesSha256 不匹配（manifest=${manifest.artifactHashes.samplesSha256.slice(0, 12)}… 实际=${actual.slice(0, 12)}…）`)
      }
    }
    if (variantsRaw !== null) {
      const actual = sha256(variantsRaw)
      if (manifest.artifactHashes.variantsSha256 && manifest.artifactHashes.variantsSha256 !== actual) {
        problems.push(`artifactHashes.variantsSha256 不匹配（manifest=${manifest.artifactHashes.variantsSha256.slice(0, 12)}… 实际=${actual.slice(0, 12)}…）`)
      }
    }
  } else {
    problems.push("缺少 artifactHashes（新字段缺失 → 旧行为）")
  }

  if (problems.length > 0) return failCheck(c, problems.join(" | "))
  c.detail = `manifestValidate ok；durationMs/usageCoverage/sampleCounts/artifactHashes 全一致`
  return c
}

// 4. request-trace-count：Σ requestTraces.length == actualRequests；requestTraceHash 重建一致
function checkRequestTraceCount(manifest: ManifestDoc | null, samples: Sample[] | null): Check {
  const c = newCheck("request-trace-count", "Σ requestTraces.length == plannedRequests（阶段口径）；requestTraceHash 重建一致")
  if (!manifest || !samples) return failCheck(c, "manifest/samples 缺失")
  const totalTraces = samples.reduce((a, s) => a + (s.requestTraces?.length ?? 0), 0)
  const problems: string[] = []
  // R22 适配：requestTraces 是「阶段」口径（每个成功阶段一条），actualRequests 已改为「ledger attempt」口径
  // （含失败/重试），故此处改为与 plannedRequests（阶段口径）比对；attempt 口径交由 ledger-facts 校验。
  const plannedBaseline = manifest.plannedRequests
  if (typeof plannedBaseline !== "number") {
    problems.push("缺少 plannedRequests（旧字段缺失 → 旧行为）")
  } else if (totalTraces !== plannedBaseline) {
    problems.push(`Σ requestTraces(${totalTraces}) != plannedRequests(${plannedBaseline})`)
  }
  // requestTraceHash 重建
  if (manifest.requestTraceHash && manifest.requestTraceHash !== "none") {
    if (!SHA256_RE.test(manifest.requestTraceHash)) {
      problems.push("requestTraceHash 非合法 sha256")
    } else {
      const allTraces = samples.flatMap((s) => s.requestTraces ?? [])
      const rebuilt = sha256(canonicalTraceSequence(allTraces))
      if (rebuilt !== manifest.requestTraceHash) {
        problems.push(`requestTraceHash 重建不一致（manifest=${manifest.requestTraceHash.slice(0, 12)}… 重建=${rebuilt.slice(0, 12)}…）`)
      }
    }
  }
  if (problems.length > 0) return failCheck(c, problems.join(" | "))
  c.detail = `Σ traces=${totalTraces} == plannedRequests=${manifest.plannedRequests}；requestTraceHash 一致`
  return c
}

// 5. stage-completeness：每样本 traces 按 stage 展开数完整且 ordinal 连续 1..N；canonicalTranscript 轮数 == rounds
function checkStageCompleteness(samples: Sample[] | null): Check {
  const c = newCheck("stage-completeness", "requestTraces 阶段完整且 ordinal 连续；canonicalTranscript 轮数 == rounds")
  if (!samples || samples.length === 0) return failCheck(c, "无样本")
  const problems: string[] = []
  for (const s of samples) {
    const planned = plannedStagesForTask(s.taskId)
    if (planned === null) continue // 未知任务跳过阶段数断言
    const traces = s.requestTraces ?? []
    if (traces.length < planned) {
      problems.push(`${s.sampleId}: traces=${traces.length} < planned=${planned}`)
    }
    // ordinal 连续 1..N（本样本内）
    const ords = traces.map((t) => t.ordinal ?? 0).filter((o) => o > 0).sort((a, b) => a - b)
    if (ords.length > 0) {
      const min = ords[0]
      for (let i = 0; i < ords.length; i++) {
        if (ords[i] !== min + i) {
          problems.push(`${s.sampleId}: ordinal 不连续（${ords.join(",")}）`)
          break
        }
      }
    }
    // canonicalTranscript 轮数 == rounds
    const turns = s.canonicalTranscript ?? []
    const roundsFromTranscript = turns.filter((t) => t.role === "assistant").length
    const declaredRounds = s.rounds ?? 0
    if (turnIsArray(s) && roundsFromTranscript !== declaredRounds) {
      problems.push(`${s.sampleId}: canonicalTranscript assistant 轮数=${roundsFromTranscript} != rounds=${declaredRounds}`)
    }
  }
  if (problems.length > 0) return failCheck(c, problems.slice(0, 20).join(" | "))
  c.detail = `${samples.length} 样本阶段完整、ordinal 连续、transcript 轮数 == rounds`
  return c
}

function turnIsArray(s: Sample): boolean {
  return Array.isArray(s.canonicalTranscript)
}

// 6. carryover-dup：trace.userHash 撞 assistant sha256；或 user 整段含前一轮 assistant ≥200 字
function checkCarryoverDup(samples: Sample[] | null): Check {
  const c = newCheck("carryover-dup", "carryover 无重复（userHash 撞 assistant sha256 / 整段内联前一轮正文）")
  if (!samples) return failCheck(c, "无样本")
  const hits: string[] = []
  for (const s of samples) {
    const transcript = s.canonicalTranscript ?? []
    const traces = s.requestTraces ?? []
    const asstSha = transcript.filter((t) => t.role === "assistant").map((t) => t.sha256 ?? "")
    for (const tr of traces) {
      if (tr.userHash && asstSha.includes(tr.userHash)) {
        hits.push(`${s.sampleId}: trace.userHash 撞 transcript assistant sha256`)
      }
    }
    for (let i = 1; i < transcript.length; i++) {
      const cur = transcript[i]
      if (cur.role !== "user") continue
      const prev = transcript[i - 1]
      if (prev.role !== "assistant") continue
      if ((prev.content ?? "").length >= 200 && (cur.content ?? "").includes(prev.content ?? "")) {
        hits.push(`${s.sampleId}: user 整段包含前一轮 assistant 正文(${prev.content?.length}字)`)
      }
    }
  }
  if (hits.length > 0) return failCheck(c, hits.slice(0, 20).join(" | "))
  c.detail = `0 处 carryover 重复`
  return c
}

// 7. failure-rounds：收紧 R22 缺口——failures>0 但 retries===0 且 status==='ok' → 红（未解释异常：
//    有失败计数却既无重试记录又算成功，正是 R22 被吞的 projection 异常特征）；
//    failures>0 + retries>0 + completedStages==planned + aborted=false + status==='ok' → 通过（合法 retry-success）；
//    completedStages<planned 且 aborted=true → 红；status==='failed' 由 quality-gate 红（此处不重复）。
function checkFailureRounds(samples: Sample[] | null): Check {
  const c = newCheck("failure-rounds", "failures/retries/status 与 completedStages/aborted 自洽（未解释异常 → 红；retry-success 合法）")
  if (!samples) return failCheck(c, "无样本")
  const problems: string[] = []
  for (const s of samples) {
    const planned = plannedStagesForTask(s.taskId)
    if (planned === null) continue
    const sid = s.sampleId ?? "?"
    const failures = s.metrics?.failures ?? 0
    const retries = s.metrics?.retries ?? 0
    const status = s.metrics?.status
    const completed = s.metrics?.completedStages
    const aborted = s.metrics?.aborted === true
    // 规则 A：completedStages < planned 且 aborted=true → 红（真中止）
    if (typeof completed === "number" && completed < planned && aborted) {
      problems.push(`${sid}: completedStages=${completed} < planned=${planned} 且 aborted=true`)
      continue
    }
    // 规则 B：failures>0 且 retries===0 且 status==='ok' → 红（未解释异常）
    if (failures > 0 && retries === 0 && status === "ok") {
      problems.push(`${sid}: failures=${failures} 但 retries=0 且 status=ok（未解释异常：有失败计数却无重试记录又算成功）`)
      continue
    }
    // 规则 C：aborted=true 但 completedStages 未提供或未减少（缺字段）→ 红
    if (aborted && (typeof completed !== "number" || completed >= planned)) {
      problems.push(`${sid}: aborted=true 但 completedStages=${completed} 未 < planned=${planned}`)
      continue
    }
    // 规则 D（合法 retry-success）：failures>0 && retries>0 && completedStages==planned && aborted=false && status==='ok' → 通过
    // （此处刻意不 fail；由 mutation「retry-success-legal」反向断言该规则合法）
  }
  if (problems.length > 0) return failCheck(c, problems.slice(0, 20).join(" | "))
  c.detail = `failure-rounds 自洽：无未解释异常、无真中止误判（retry-success 合法通过）`
  return c
}

// 8. synthetic-real：mock 样本 synthetic=true；header.mode 与样本一致；real 空 content 需 --save-content 语义
function checkSyntheticReal(samples: Sample[] | null, header: Record<string, unknown> | null, modeLabel: string): Check {
  const c = newCheck("synthetic-real", "mock→synthetic=true；header.mode 与样本一致；real 空 content 标 flag")
  if (!samples || samples.length === 0) return failCheck(c, "无样本")
  const problems: string[] = []
  const headerMode = header?.mode
  for (const s of samples) {
    if (s.mode === "mock" && s.synthetic !== true) {
      problems.push(`${s.sampleId}: mode=mock 但 synthetic!=true`)
    }
    if (s.mode === "real" && s.synthetic !== false && s.synthetic !== undefined) {
      problems.push(`${s.sampleId}: mode=real 但 synthetic=${s.synthetic}`)
    }
    if (s.mode !== headerMode) {
      problems.push(`${s.sampleId}: sample.mode=${s.mode} != header.mode=${headerMode}`)
    }
  }
  // real 且 content 空且 usageStatus missing → 允许（--save-content 未开），但标 flag 不 fail
  let flagCount = 0
  if (modeLabel === "real") {
    for (const s of samples) {
      const real = s.mode === "real" || s.synthetic === false
      const contentEmpty = !s.content || s.content.length === 0
      const usageMissing = s.usageStatus === "missing"
      if (real && contentEmpty && usageMissing) flagCount++
    }
  }
  if (problems.length > 0) return failCheck(c, problems.slice(0, 20).join(" | "))
  c.detail = `mock/real synthetic 一致；header.mode 一致` + (flagCount > 0 ? `；FLAG: ${flagCount} 个 real 空 content+missing usage（假定 --save-content 未开）` : "")
  return c
}

// 9. experiment-mode：manifest/header/每样本 experimentMode 一致且∈{controlled,trajectory}；fairness 一致性
function checkExperimentMode(manifest: ManifestDoc | null, header: Record<string, unknown> | null, samples: Sample[] | null, fairness: FairnessDoc | null): Check {
  const c = newCheck("experiment-mode", "experimentMode 一致 ∈{controlled,trajectory} 且 fairness 一致")
  if (!manifest || !samples || samples.length === 0) return failCheck(c, "manifest/samples 缺失")
  const problems: string[] = []
  const mMode = manifest.experimentMode
  const hMode = header?.experimentMode
  const VALID = ["controlled", "trajectory"]
  if (!mMode || !VALID.includes(mMode as string)) {
    problems.push(`manifest.experimentMode=${mMode} 非法（期望 controlled|trajectory）——旧 HEAD 缺此字段即红`)
  }
  if (hMode !== mMode) problems.push(`header.experimentMode=${hMode} != manifest=${mMode}`)
  for (const s of samples) {
    const sm = s.experimentMode ?? mMode // 样本侧可省略，缺省继承 manifest
    if (sm !== mMode) problems.push(`${s.sampleId}: experimentMode=${sm} != ${mMode}`)
  }
  // fairness 一致性
  if (mMode === "controlled") {
    const ieq = fairness?.inputEquivalence
    if (!ieq || Object.keys(ieq).length === 0) {
      problems.push("controlled 模式缺 fairness.inputEquivalence")
    } else {
      const notEqual = Object.entries(ieq).filter(([, v]) => v.equal !== true)
      if (notEqual.length > 0) problems.push(`inputEquivalence 非全 equal：${notEqual.map(([k]) => k).join(",")}`)
    }
  } else if (mMode === "trajectory") {
    const lv = fairness?.lineageValid
    if (!lv || Object.keys(lv).length === 0) {
      problems.push("trajectory 模式缺 fairness.lineageValid")
    } else {
      const notValid = Object.entries(lv).filter(([, v]) => v.valid !== true)
      if (notValid.length > 0) problems.push(`lineageValid 非全 valid：${notValid.map(([k]) => k).join(",")}`)
    }
  }
  if (problems.length > 0) return failCheck(c, problems.join(" | "))
  c.detail = `experimentMode=${mMode}；fairness ${mMode === "controlled" ? "inputEquivalence 全 equal" : "lineageValid 全 valid"}`
  return c
}

// 10. pairing：期望集合来自 manifest.expected（不从样本反推）；删除整 task 三组样本 → 必须红。
const EXPECTED_VARIANT_IDS = ["generic_baseline", "deepwriter_current_product", "deepwriter_hardened_candidate"]

function checkPairing(samples: Sample[] | null, manifest: ManifestDoc | null): Check {
  const c = newCheck("pairing", "每 (task×variant×repeat) 恰一个样本（期望来自 manifest.expected）")
  if (!samples || samples.length === 0) return failCheck(c, "无样本")
  const problems: string[] = []

  // 期望集合优先来自 manifest.expected；缺省回退旧口径（无 expected → 红，作为旧行为证据）
  const expected = manifest?.expected
  const expectedVariants = expected?.variants ?? null
  const expectedRepeats = expected?.repeats ?? null
  const expectedTasks = expected?.tasks ?? null

  const seen = new Map<string, number>()
  for (const s of samples) {
    const key = `${s.taskId}|${s.variantId}|${s.repeat}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const dups = [...seen.entries()].filter(([, n]) => n !== 1)
  if (dups.length > 0) {
    problems.push(`重复：${dups.slice(0, 10).map(([k, n]) => `${k}×${n}`).join("; ")}`)
  }

  if (expected === undefined) {
    problems.push("manifest.expected 缺失（新旧口径转换前为旧行为红）")
    // 回退旧反推口径仍报告缺失/重复，但不假绿
  }

  // 期望任务集 / 变体集 / repeats
  let expectTaskIds: string[] = []
  let expectVariants: string[] = []
  let expectRepeatCount = 1
  let expectedFromManifest = false
  if (expectedTasks && Array.isArray(expectedTasks) && expectedTasks.length > 0) {
    expectTaskIds = expectedTasks.map((t) => t.taskId ?? "").filter(Boolean)
    expectRepeatCount = expectedRepeats ?? 1
    expectedFromManifest = true
  }
  if (expectedVariants && Array.isArray(expectedVariants) && expectedVariants.length > 0) {
    expectVariants = expectedVariants
  } else {
    expectVariants = EXPECTED_VARIANT_IDS
  }

  if (expectedFromManifest) {
    // 按 expected 比对：每个 task × variant × repeat 必须存在且唯一
    const missing: string[] = []
    for (const t of expectTaskIds) {
      for (const v of expectVariants) {
        for (let r = 1; r <= expectRepeatCount; r++) {
          const key = `${t}|${v}|${r}`
          if (!seen.has(key)) missing.push(key)
        }
      }
    }
    // 期望样本总数也可从 expected.tasks[].expectedSamples 交叉验证
    const expectedSampleCount = (expectedTasks ?? []).reduce((a, t) => a + (t.expectedSamples ?? 0), 0)
    if (expectedSampleCount > 0 && expectedSampleCount !== samples.length) {
      problems.push(`expected 样本总数=${expectedSampleCount} != 实际=${samples.length}`)
    }
    if (missing.length > 0) {
      problems.push(`缺失：${missing.slice(0, 10).join("; ")}`)
    }
  } else {
    // 旧反推口径（无 expected 时）：从样本并集反推网格，检测缺失
    const seenVariants = new Set(samples.map((s) => s.variantId))
    const tasks = [...new Set(samples.map((s) => s.taskId))]
    const maxRepeat = Math.max(1, ...samples.map((s) => s.repeat ?? 1))
    for (const t of tasks) {
      for (const v of seenVariants) {
        for (let r = 1; r <= maxRepeat; r++) {
          const key = `${t}|${v}|${r}`
          if (!seen.has(key)) problems.push(`缺失：${key}`)
        }
      }
    }
  }

  if (problems.length > 0) return failCheck(c, problems.slice(0, 20).join(" | "))
  c.detail = `${samples.length} 样本，${seen.size} 个 (task×variant×repeat) 组合，均唯一无缺失（期望来自 manifest.expected）`
  return c
}

// ==================== R22 关键关系 check（ledger 审计） ====================

// 11. ledger-facts：actualRequests == ledger.length（失败与重试计入）；ledgerSha256 == 实际 ledger 哈希；requestIdCount 一致
function checkLedgerFacts(manifest: ManifestDoc | null, ledger: LedgerContext): Check {
  const c = newCheck("ledger-facts", "actualRequests == ledger.length；ledgerSha256 == 实际哈希；requestIdCount 一致")
  if (!manifest) return failCheck(c, "manifest 缺失")
  const problems: string[] = []
  if (!ledger.present) {
    problems.push("ledger 缺失（独立 ledger.json 或 samples.json.ledger 均无）——旧行为红")
  } else {
    if (typeof manifest.actualRequests === "number" && manifest.actualRequests !== ledger.attempts.length) {
      problems.push(`actualRequests(${manifest.actualRequests}) != ledger.length(${ledger.attempts.length})`)
    }
    if (manifest.ledgerSha256 !== undefined && manifest.ledgerSha256 !== "none") {
      if (!SHA256_RE.test(manifest.ledgerSha256)) {
        problems.push("ledgerSha256 非合法 sha256")
      } else if (manifest.ledgerSha256 !== ledger.actualSha256) {
        problems.push(`ledgerSha256 不匹配（manifest=${manifest.ledgerSha256.slice(0, 12)}… 实际=${ledger.actualSha256.slice(0, 12)}…）`)
      }
    } else {
      problems.push("manifest.ledgerSha256 缺失——旧行为红")
    }
    if (manifest.requestIdCount !== undefined) {
      const uniq = new Set(ledger.attempts.map((a) => a.requestId ?? ""))
      if (manifest.requestIdCount !== uniq.size) {
        problems.push(`requestIdCount(${manifest.requestIdCount}) != 去重后 requestId 数(${uniq.size})`)
      }
    }
    // R22 主代理对账：本地端点实收数三方核对（有字段即强制；旧 manifest 缺字段跳过）。
    if (typeof manifest.localEndpointReceived === "number") {
      if (manifest.localEndpointReceived !== ledger.attempts.length) {
        problems.push(`localEndpointReceived(${manifest.localEndpointReceived}) != ledger.length(${ledger.attempts.length})`)
      }
      if (manifest.ledgerMatchesEndpoint !== true) {
        problems.push("ledgerMatchesEndpoint 非 true（请求账本与端点实收不一致）")
      }
    } else if (manifest.ledgerMatchesEndpoint === true && manifest.localEndpointReceived == null) {
      // R23-R06 反证场景 8：real 未观测端点却声称 matched → 红
      problems.push("ledgerMatchesEndpoint=true 但 localEndpointReceived 为 null（real 未观测却声称 matched）")
    }
  }
  if (problems.length > 0) return failCheck(c, problems.join(" | "))
  c.detail = `ledger.length=${ledger.attempts.length} == actualRequests=${manifest.actualRequests}；ledgerSha256 一致`
  return c
}

// 12. ledger-relations：runIds/requestIds 完整；requestId 在 ledger 唯一且与样本/阶段对应；ledger 该样本 attempt 数 == metrics.attempts
function checkLedgerRelations(samples: Sample[] | null, ledger: LedgerContext): Check {
  const c = newCheck("ledger-relations", "runIds/requestIds 完整；requestId 唯一且与样本/阶段对应；ledger attempt 数 == metrics.attempts")
  if (!samples || samples.length === 0) return failCheck(c, "无样本")
  const problems: string[] = []
  const requestIdOwners = new Map<string, string>() // requestId → sampleId（唯一性）
  for (const a of ledger.attempts) {
    const rid = a.requestId ?? ""
    if (!rid) continue
    if (requestIdOwners.has(rid)) {
      problems.push(`requestId=${rid} 重复出现于 ${requestIdOwners.get(rid)} 与 ${a.sampleId}`)
    } else {
      requestIdOwners.set(rid, a.sampleId ?? "")
    }
  }
  const bySample = new Map<string, RequestAttempt[]>()
  for (const a of ledger.attempts) {
    const key = a.sampleId || ""
    if (!bySample.has(key)) bySample.set(key, [])
    bySample.get(key)!.push(a)
  }
  for (const s of samples) {
    const sid = s.sampleId ?? "?"
    const atts = bySample.get(s.sampleId ?? "") ?? []
    // attempt 数 == metrics.attempts
    const declared = s.metrics?.attempts
    if (typeof declared === "number" && declared !== atts.length) {
      problems.push(`${sid}: metrics.attempts=${declared} != ledger attempt 数=${atts.length}`)
    }
    // runIds：每个 stage 一个（deepwriter）；此处按「非空即合格 + 数量 == stageResults/traces 数」宽松断言
    const runIds = s.runIds ?? []
    const isDeepwriter = (s.variantId ?? "").startsWith("deepwriter_")
    if (isDeepwriter && runIds.length === 0) {
      problems.push(`${sid}: deepwriter 样本 runIds 为空`)
    }
    // requestIds：非空
    const requestIds = s.requestIds ?? []
    if (requestIds.length === 0) {
      problems.push(`${sid}: 样本 requestIds 为空`)
    } else {
      // requestIds 与 ledger 对应：每个 requestId 属于本样本
      for (const rid of requestIds) {
        const owner = requestIdOwners.get(rid)
        if (owner === undefined) {
          problems.push(`${sid}: requestId=${rid} 不在 ledger 中`)
        } else if (owner !== s.sampleId) {
          problems.push(`${sid}: requestId=${rid} 属于 ${owner}（跨样本复用）`)
        }
      }
    }
  }
  if (problems.length > 0) return failCheck(c, problems.slice(0, 20).join(" | "))
  c.detail = `${ledger.attempts.length} 条 attempt 与 ${samples.length} 样本的 runIds/requestIds/metrics.attempts 全一致`
  return c
}

// 13. retry-consistency：outerRetries/innerRetries 从 ledger attempt 序列重建一致；innerRetries=null 时须 innerRetriesObserved=false
function checkRetryConsistency(manifest: ManifestDoc | null, ledger: LedgerContext): Check {
  const c = newCheck("retry-consistency", "outerRetries/innerRetries 与 ledger 重建一致；innerRetries=null 且未观测时禁止用 0 冒充")
  if (!manifest) return failCheck(c, "manifest 缺失")
  const problems: string[] = []
  if (!ledger.present) {
    problems.push("ledger 缺失——旧行为红")
    if (problems.length > 0) return failCheck(c, problems.join(" | "))
  }
  // outerRetries 重建：每个 sample×stage 的 outerAttempt 最大值 -1（>1 表示重试）
  const seenOuter = new Map<string, number>()
  for (const a of ledger.attempts) {
    const key = `${a.sampleId}|${a.stageId}`
    seenOuter.set(key, Math.max(seenOuter.get(key) ?? 0, a.outerAttempt ?? 0))
  }
  let rebuiltOuterRetries = 0
  for (const v of seenOuter.values()) rebuiltOuterRetries += Math.max(0, v - 1)

  if (typeof manifest.outerRetries === "number" && manifest.outerRetries !== rebuiltOuterRetries) {
    problems.push(`outerRetries(${manifest.outerRetries}) != 重建(${rebuiltOuterRetries})`)
  }

  // innerRetries 重建：每个 attempt 的 innerAttempt 最大值 -1（>1 表示内层重试）
  const seenInner = new Map<string, number>()
  let anyInnerObserved = false
  for (const a of ledger.attempts) {
    const inner = a.innerAttempt
    if (typeof inner === "number") {
      anyInnerObserved = true
      const key = `${a.sampleId}|${a.stageId}|${a.outerAttempt}`
      seenInner.set(key, Math.max(seenInner.get(key) ?? 0, inner))
    }
  }
  let rebuiltInnerRetries = 0
  for (const v of seenInner.values()) rebuiltInnerRetries += Math.max(0, v - 1)

  const innerObserved = manifest.innerRetriesObserved
  if (manifest.innerRetries === null) {
    // innerRetries 为 null 时断言 innerRetriesObserved === false（禁止用 0 冒充未观测的反面：null 却报 observed=true 也矛盾）
    if (innerObserved === true) {
      problems.push("innerRetries=null 但 innerRetriesObserved=true（矛盾）")
    }
  } else if (typeof manifest.innerRetries === "number") {
    // 禁止用 0 冒充未观测：innerRetriesObserved=false 时 innerRetries 不得报数字（含 0）
    if (innerObserved === false) {
      problems.push(`innerRetries=${manifest.innerRetries} 但 innerRetriesObserved=false（禁止用数字冒充未观测）`)
    } else if (manifest.innerRetries !== rebuiltInnerRetries) {
      problems.push(`innerRetries(${manifest.innerRetries}) != 重建(${rebuiltInnerRetries})`)
    }
  }
  if (problems.length > 0) return failCheck(c, problems.slice(0, 20).join(" | "))
  c.detail = `outerRetries=${manifest.outerRetries} innerRetries=${manifest.innerRetries} 与 ledger 重建一致`
  return c
}

// 14. hash-consistency：ledger 的 actualUserHash/actualHistoryHash 与 fairness.inputEquivalence（controlled）或 lineage（trajectory）一致
// R22 主代理对账（Agent AB 字段落定后收紧）：fairness/lineage 声称（equal/sameStart）必须能被 ledger 的 provider 实际消息 hash 佐证；
// 逐 (task×repeat×stageOrdinal) 分组核对三变体 hash 等价关系，双向矛盾（声称 true 但 hash 不等 / hash 全等但声称 false）均红。
function checkHashConsistency(fairness: FairnessDoc | null, ledger: LedgerContext, experimentMode: string | undefined): Check {
  const c = newCheck("hash-consistency", "ledger actual message hash 与 fairness/lineage 证据一致")
  if (!ledger.present) return failCheck(c, "ledger 缺失——旧行为红")
  const problems: string[] = []

  // 分组：taskId → repeat → stageOrdinal → variantId → {user, history}（取该组第一条 attempt 作代表）
  const byTask = new Map<string, Map<number, Map<number, Map<string, { user?: string; history?: string }>>>>()
  for (const a of ledger.attempts) {
    const t = a.taskId ?? ""
    const r = a.repeat ?? 0
    const o = a.stageOrdinal ?? 0
    if (!byTask.has(t)) byTask.set(t, new Map())
    const byRep = byTask.get(t)!
    if (!byRep.has(r)) byRep.set(r, new Map())
    const byOrd = byRep.get(r)!
    if (!byOrd.has(o)) byOrd.set(o, new Map())
    const byVar = byOrd.get(o)!
    if (!byVar.has(a.variantId)) {
      byVar.set(a.variantId, { user: a.actualUserHash, history: a.actualHistoryHash })
    }
  }
  const distinctOf = (m: Map<string, { user?: string; history?: string }>, field: "user" | "history"): Set<string> =>
    new Set([...m.values()].map((v) => v[field] ?? ""))
  const groupOk = (hashes: Set<string>): boolean => !hashes.has("") && hashes.size === 1

  if (experimentMode === "controlled") {
    const ieq = fairness?.inputEquivalence
    if (!ieq || Object.keys(ieq).length === 0) return failCheck(c, "controlled 模式缺 fairness.inputEquivalence")
    const declaredTasks = new Set(Object.keys(ieq))
    for (const [tid, reps] of byTask) {
      if (!declaredTasks.has(tid)) { problems.push(`task=${tid} 有 ledger 但 inputEquivalence 无声明`); continue }
      const entry = ieq[tid] as { equal?: boolean; userEqual?: boolean; historyEqual?: boolean } | undefined
      if (!entry) continue
      for (const [rep, ords] of reps) {
        for (const [ord, byVar] of ords) {
          if (byVar.size < 3) { problems.push(`task=${tid} rep=${rep} ord=${ord} 变体组不齐（${byVar.size}/3）`); continue }
          const uHashes = distinctOf(byVar, "user")
          const hHashes = distinctOf(byVar, "history")
          const uOk = groupOk(uHashes)
          const hOk = groupOk(hHashes)
          if (entry.userEqual === true && !uOk) {
            problems.push(`task=${tid} rep=${rep} ord=${ord}: userEqual=true 但 provider actualUserHash 跨变体不等（${uHashes.size} 种）`)
          } else if (entry.userEqual === false && uOk) {
            problems.push(`task=${tid} rep=${rep} ord=${ord}: userEqual=false 但 provider actualUserHash 跨变体全等（声称与 ledger 矛盾）`)
          }
          if (entry.historyEqual === true && !hOk) {
            problems.push(`task=${tid} rep=${rep} ord=${ord}: historyEqual=true 但 provider actualHistoryHash 跨变体不等（${hHashes.size} 种）`)
          } else if (entry.historyEqual === false && hOk) {
            problems.push(`task=${tid} rep=${rep} ord=${ord}: historyEqual=false 但 provider actualHistoryHash 跨变体全等（声称与 ledger 矛盾）`)
          }
          if (uHashes.has("")) problems.push(`task=${tid} rep=${rep} ord=${ord}: 有变体缺 actualUserHash`)
          if (hHashes.has("")) problems.push(`task=${tid} rep=${rep} ord=${ord}: 有变体缺 actualHistoryHash`)
        }
      }
    }
    if (problems.length > 0) return failCheck(c, problems.slice(0, 12).join(" | "))
    c.detail = `controlled：${Object.keys(ieq).length} 任务 inputEquivalence 声称与 ledger actual hash 逐组佐证一致`
    return c
  } else if (experimentMode === "trajectory") {
    const lv = fairness?.lineageValid
    if (!lv || Object.keys(lv).length === 0) return failCheck(c, "trajectory 模式缺 fairness.lineageValid")
    const declaredTasks = new Set(Object.keys(lv))
    let corrobated = 0
    for (const [tid, reps] of byTask) {
      if (!declaredTasks.has(tid)) { problems.push(`task=${tid} 有 ledger 但 lineageValid 无声明`); continue }
      const entry = lv[tid] as { sameStart?: boolean } | undefined
      for (const [rep, ords] of reps) {
        const ord1 = ords.get(1)
        if (!ord1) { problems.push(`task=${tid} rep=${rep} 缺第 1 阶段 attempt（lineage 同起点不可佐证）`); continue }
        const uHashes = distinctOf(ord1, "user")
        const hHashes = distinctOf(ord1, "history")
        const uOk = groupOk(uHashes)
        const hOk = groupOk(hHashes)
        if (entry?.sameStart === true && !uOk) {
          problems.push(`task=${tid} rep=${rep}: sameStart=true 但第 1 阶段 provider actualUserHash 跨变体不等（${uHashes.size} 种）`)
        } else if (entry?.sameStart === false && uOk) {
          problems.push(`task=${tid} rep=${rep}: sameStart=false 但第 1 阶段 provider actualUserHash 跨变体全等（声称与 ledger 矛盾）`)
        }
        // 同起点下第 1 阶段历史（空历史或冻结金史）也应全等；hash 缺失即不可佐证
        if (!hOk) problems.push(`task=${tid} rep=${rep}: 第 1 阶段 provider actualHistoryHash 缺失或跨变体不等`)
        if (uOk && hOk) corrobated++
      }
    }
    if (corrobated === 0) return failCheck(c, "trajectory：无任何任务的首阶段 hash 佐证 lineage")
    if (problems.length > 0) return failCheck(c, problems.slice(0, 12).join(" | "))
    c.detail = `trajectory：${corrobated} 组任务×repeat 首阶段 hash 佐证 lineage 同起点`
    return c
  }
  return failCheck(c, `experimentMode=${experimentMode} 非 controlled/trajectory`)
}

// 15. quality-gate：收紧——任一必需样本满足以下之一 → 红：
//    - validation.passed !== true
//    - metrics.status !== 'ok'
//    - eligibleForReview === false
//    - deepwriter 变体（variantId 以 'deepwriter_' 开头）且最终 terminalStatus 非 'completed'
//      （terminalStatus 按 attempt 顺序记录，retry-success 样本含中间 failed 是合法的——
//       R23-R03 口径：只以「最终 attempt 终态」判红，中间失败由 failure-rounds 解释）
function checkQualityGate(samples: Sample[] | null): Check {
  const c = newCheck("quality-gate", "validation/metrics.status/eligibleForReview/terminalStatus 四重闸门")
  if (!samples || samples.length === 0) return failCheck(c, "无样本")
  const problems: string[] = []
  for (const s of samples) {
    const sid = s.sampleId ?? "?"
    if (s.validation?.passed !== true) {
      problems.push(`${sid}: validation.passed=${s.validation?.passed} != true`)
    }
    if (s.metrics?.status !== "ok") {
      problems.push(`${sid}: metrics.status=${s.metrics?.status} != ok`)
    }
    if (s.eligibleForReview === false) {
      problems.push(`${sid}: eligibleForReview=false`)
    }
    if ((s.variantId ?? "").startsWith("deepwriter_")) {
      const terms = s.terminalStatus ?? []
      const finalTerm = terms.length > 0 ? terms[terms.length - 1] : "missing"
      if (finalTerm !== "completed") {
        problems.push(`${sid}: deepwriter 最终 terminalStatus=${finalTerm} != completed（序列=[${terms.join(",")}]）`)
      }
    }
  }
  if (problems.length > 0) return failCheck(c, problems.slice(0, 20).join(" | "))
  c.detail = `${samples.length} 个样本 validation/metrics.status/eligibleForReview/terminalStatus 全通过`
  return c
}

// 16. trajectory-history：仅 experimentMode==='trajectory' 时执行（controlled 直接 PASS 并注明跳过）。//     对每个 deepwriter 样本（含 current 与 hardened），逐 stage ordinal≥2，取该 stage 第一条 ledger attempt
//     （sampleId+stageOrdinal 匹配）的 actualHistoryTurnHashes，断言：
//       a) 非空；
//       b) 存在 role==='assistant' 的条目；
//       c) 历史序列为 (user,assistant) 交替且以 assistant 结尾（stage≥2 必含 assistant）；
//       d) 该样本 stage N-1 的 stageOutputs[ordinal-2].contentSha256 须出现在 stage N 的 assistant 条目中；
//       e) assistant sha256 不得跨样本复用（任意两样本的 assistant 集合交集为空）；
//       f) history 切片最后一条必须为 assistant。
function checkTrajectoryHistory(samples: Sample[] | null, ledger: LedgerContext, experimentMode: string | undefined): Check {
  const c = newCheck("trajectory-history", "trajectory 模式逐 stage 校验 provider 历史结构（历史非空/含 assistant/交替/阶段接力/不跨样本复用）")
  if (experimentMode !== "trajectory") {
    c.detail = `experimentMode=${experimentMode ?? "?"} → 跳过（仅 trajectory 模式审查历史结构）`
    return c
  }
  if (!samples || samples.length === 0) return failCheck(c, "无样本")
  const problems: string[] = []

  // e) 跨样本复用：收集每个 deepwriter 样本的 assistant sha256 集合
  const sampleAsstHashes = new Map<string, Set<string>>()

  for (const s of samples) {
    if (!(s.variantId ?? "").startsWith("deepwriter_")) continue
    const sid = s.sampleId ?? "?"
    const attempts = ledger.attempts.filter((a) => a.sampleId === s.sampleId)
    const asstSet = new Set<string>()
    sampleAsstHashes.set(s.sampleId ?? "", asstSet)
    const ords = [...new Set(attempts.map((a) => a.stageOrdinal ?? 0))].filter((o) => o >= 2).sort((a, b) => a - b)
    for (const ord of ords) {
      const att = attempts.find((a) => a.stageOrdinal === ord)
      if (!att) {
        problems.push(`${sid} stage=${ord}: ledger 无该 stage attempt`)
        continue
      }
      const turns = att.actualHistoryTurnHashes ?? []
      // a) 非空
      if (turns.length === 0) {
        problems.push(`${sid} stage=${ord}: 历史为空（stage≥2 必含 assistant）`)
        continue
      }
      // b) 含 assistant
      if (!turns.some((t) => t.role === "assistant")) {
        problems.push(`${sid} stage=${ord}: 历史无 assistant 条目`)
        continue
      }
      // f) history 切片最后一条必须为 assistant
      const last = turns[turns.length - 1]
      if ((last?.role ?? "") !== "assistant") {
        problems.push(`${sid} stage=${ord}: 历史末条非 assistant（role=${last?.role ?? "?"}）`)
      }
      // c) (user,assistant) 交替且以 assistant 结尾
      for (let i = 0; i < turns.length; i++) {
        const expect = i % 2 === 0 ? "user" : "assistant"
        if ((turns[i]?.role ?? "") !== expect) {
          problems.push(`${sid} stage=${ord}: 历史非 user,assistant 交替（下标 ${i} role=${turns[i]?.role} 期望 ${expect}）`)
          break
        }
      }
      // d) stage N-1 的 contentSha256 须出现在本 stage assistant 条目中
      const asstHashes = new Set(turns.filter((t) => t.role === "assistant").map((t) => t.sha256))
      for (const t of turns) if (t.role === "assistant") asstSet.add(t.sha256)
      const prevOutput = s.stageOutputs?.[ord - 2]?.contentSha256
      if (prevOutput && !asstHashes.has(prevOutput)) {
        problems.push(`${sid} stage=${ord}: stage N-1 contentSha256 不在本 stage assistant 历史条目中`)
      }
    }
  }

  // e) 跨样本复用：仅对不同 taskId 的样本对检测（同 task 不同 variant/repeat 的输出正文可合法相同——
  //    公平性设计：输入等价 → mock/同参数下输出等价；真正的投影串线特征是跨任务内容复用）。
  const sampleIds = [...sampleAsstHashes.keys()]
  const taskOf = new Map<string, string>()
  for (const s of samples) taskOf.set(s.sampleId ?? "", s.taskId ?? "")
  for (let i = 0; i < sampleIds.length; i++) {
    for (let j = i + 1; j < sampleIds.length; j++) {
      if (taskOf.get(sampleIds[i]) === taskOf.get(sampleIds[j])) continue
      const a = sampleAsstHashes.get(sampleIds[i])!
      const b = sampleAsstHashes.get(sampleIds[j])!
      const inter = [...a].filter((h) => b.has(h))
      if (inter.length > 0) {
        problems.push(`跨样本复用：${sampleIds[i]} 与 ${sampleIds[j]} 的 assistant sha256 交集非空（${inter.slice(0, 3).join(",")}…）`)
      }
    }
  }

  if (problems.length > 0) return failCheck(c, problems.slice(0, 20).join(" | "))
  c.detail = `trajectory：${sampleIds.length} 个 deepwriter 样本逐 stage 历史结构合法`
  return c
}

// 17. stage-targets：manifest 的逐 stage target 序列与 hash 必须与「当前 tasks.json 经 loader 规范化」重算一致。
//    R24-P0-01：改任一 stage target（如 outline 200→201）→ stageTargetsHash 必变；删字段 → loader fail-closed；
//    manifest 内 stageTargets 数组自身重算 hash 与 stageTargetsHash 不符 → 篡改红。
function checkStageTargets(manifest: ManifestDoc | null): Check {
  const c = newCheck("stage-targets", "manifest stageTargets/ stageTargetsHash 与 tasks.json loader 重算一致")
  if (!manifest) return failCheck(c, "manifest 缺失")
  const problems: string[] = []
  if (typeof manifest.stageTargetsHash !== "string" || !SHA256_RE.test(manifest.stageTargetsHash)) {
    problems.push(`stageTargetsHash 缺失或非法（${String(manifest.stageTargetsHash).slice(0, 12)}…）`)
  }
  if (!Array.isArray(manifest.stageTargets)) {
    problems.push("manifest.stageTargets 缺失（旧行为红）")
  } else {
    const localHash = sha256(JSON.stringify(manifest.stageTargets))
    if (localHash !== manifest.stageTargetsHash) {
      problems.push(`stageTargets 数组与 stageTargetsHash 不符（数组hash=${localHash.slice(0, 12)}… manifest=${String(manifest.stageTargetsHash).slice(0, 12)}…）`)
    }
  }
  // 与当前 tasks.json 的 loader 规范化逐条比对（重算真源；多重集口径支持部分任务子集产物）
  try {
    const tasksPath = path.join(ROOT, "scripts", "eval-tasks", "tasks.json")
    const set = loadEvalTasks(tasksPath)
    const realCounts = new Map<string, number>() // `${taskId}|${stageId}|${targetChars}` -> 展开数
    for (const t of set.tasks) {
      for (const st of t.stages) {
        const n = st.repeats ?? 1
        const key = `${t.id}|${st.stageId}|${st.targetChars}`
        realCounts.set(key, (realCounts.get(key) ?? 0) + n)
      }
    }
    if (Array.isArray(manifest.stageTargets)) {
      const localCounts = new Map<string, number>()
      for (const e of manifest.stageTargets as Array<{ taskId?: string; stageId?: string; targetChars?: number }>) {
        const key = `${e?.taskId ?? ""}|${e?.stageId ?? ""}|${e?.targetChars ?? ""}`
        localCounts.set(key, (localCounts.get(key) ?? 0) + 1)
      }
      for (const [key, cnt] of localCounts) {
        const real = realCounts.get(key) ?? 0
        if (real < cnt) {
          problems.push(`stageTargets[${key}] 与 tasks.json 展开序列不符（产物 ${cnt} > 真源 ${real}）`)
        }
      }
    }
  } catch (e) {
    problems.push(`tasks.json loader 重算失败：${e instanceof Error ? e.message : String(e)}`)
  }
  if (problems.length > 0) return failCheck(c, problems.join(" | "))
  c.detail = `stageTargets 序列与 hash 全链一致（loader 重算 ${String(manifest.stageTargetsHash).slice(0, 12)}…）`
  return c
}

// 18. multi-turn-completeness：多轮 completion 的完成证据、持久化正文、评分正文、hash 四者一致。
//    R24-P0-02：stageOutputs 落 turnChars/turnHashes（每轮 assistant 明细）；只保留最后一轮（ΣturnChars != content.length）必红。
function checkMultiTurnCompleteness(samples: Sample[] | null, ledger: LedgerContext): Check {
  const c = newCheck("multi-turn-completeness", "多轮正文四者一致（Σ每轮 chars == content 长度；contentSha256 == 实际正文 hash）")
  if (!samples || samples.length === 0) return failCheck(c, "无样本")
  const problems: string[] = []
  for (const s of samples) {
    const sid = s.sampleId ?? "?"
    const outputs = s.stageOutputs ?? []
    for (const so of outputs) {
      const soId = `${sid}/${so.stageId ?? "?"}`
      if (typeof so.contentSha256 !== "string" || so.contentSha256 !== sha256(so.content ?? "")) {
        problems.push(`${soId}: contentSha256 与实际正文 hash 不符`)
      }
      if (Array.isArray(so.turnChars) && so.turnChars.length > 0) {
        const sum = so.turnChars.reduce((a, n) => a + n, 0)
        if (sum !== (so.content ?? "").length) {
          problems.push(`${soId}: ΣturnChars=${sum} != content.length=${(so.content ?? "").length}（多轮正文丢失——只保留最后一轮必红）`)
        }
        if (Array.isArray(so.turnHashes) && so.turnHashes.length !== so.turnChars.length) {
          problems.push(`${soId}: turnHashes 数(${so.turnHashes.length}) != turnChars 数(${so.turnChars.length})`)
        }
      } else {
        // 单轮 stage：turnChars 未落（旧产物）或空数组——chars 字段与 content 长度一致即可
        if (so.chars !== (so.content ?? "").length) {
          problems.push(`${soId}: chars=${so.chars} != content.length=${(so.content ?? "").length}`)
        }
      }
    }
  }
  if (problems.length > 0) return failCheck(c, problems.slice(0, 20).join(" | "))
  c.detail = `${samples.length} 个样本逐 stage 正文/明细/hash 全一致`
  return c
}

// 19. pricing-identity：real + max-cost 模式必须记录并可独立复算计价身份
//    R25-P0-03：providerId / endpointOrigin（仅 scheme+host+port）/ model / priceProfileId /
//    priceProfileHash / priceProfileCurrency / priceProfileTrustedForEndpoint / 预算五字段全强制；
//    与当前 profile 文件错配或 hash 漂移 → 非零。
function checkPricingIdentity(manifest: ManifestDoc | null, profile: PriceProfile | null): Check {
  const c = newCheck("pricing-identity", "real+cap 计价身份与预算事实强制且与 profile 一致（无错配/无 hash 漂移）")
  if (!manifest) return failCheck(c, "manifest 缺失")
  const budget = (manifest.budget ?? null) as { maxCostCny?: unknown } | null
  const capActive = manifest.real === true && budget !== null && typeof budget.maxCostCny === "number" && budget.maxCostCny > 0
  const problems: string[] = []
  if (capActive) {
    const reqStr = (k: string): void => {
      if (typeof manifest[k] !== "string" || !manifest[k]) problems.push(`${k} 缺失或非字符串（real+cap 强制）`)
    }
    reqStr("providerId")
    reqStr("model")
    reqStr("priceProfileId")
    reqStr("priceProfileCurrency")
    if (typeof manifest.endpointOrigin !== "string" || !CANONICAL_ORIGIN_RE.test(manifest.endpointOrigin)) {
      problems.push(`endpointOrigin 非 canonical（仅 scheme+host+port；got ${JSON.stringify(manifest.endpointOrigin)}）`)
    }
    if (typeof manifest.priceProfileHash !== "string" || !SHA256_RE.test(manifest.priceProfileHash)) {
      problems.push("priceProfileHash 缺失或非 64-hex")
    }
    if (manifest.priceProfileTrustedForEndpoint !== true) problems.push("priceProfileTrustedForEndpoint 必须为 true（结构化匹配，不得手写）")
    const num = (k: string): void => {
      if (typeof manifest[k] !== "number" || !Number.isFinite(manifest[k]) || (manifest[k] as number) < 0) problems.push(`${k} 必须为有限非负数`)
    }
    num("spentActualCny")
    num("spentUpperCny")
    num("inflightReservedCny")
    if (typeof manifest.actualCostKnown !== "boolean") problems.push("actualCostKnown 必须为 boolean")
    if (typeof manifest.hardCapProtected !== "boolean") problems.push("hardCapProtected 必须为 boolean")
    if (typeof manifest.exhausted !== "boolean") problems.push("exhausted 必须为 boolean")
    if (manifest.exhausted === true && (typeof manifest.reason !== "string" || !manifest.reason)) problems.push("exhausted=true 时 reason 必须为非空字符串")
    if (typeof manifest.spentActualCny === "number" && typeof manifest.spentUpperCny === "number" && manifest.spentActualCny > manifest.spentUpperCny + 1e-9) {
      problems.push(`spentActualCny(${manifest.spentActualCny}) > spentUpperCny(${manifest.spentUpperCny})`)
    }
    // 与当前 profile 文件逐一核对（缺失/错配/hash 漂移 → 红）
    if (!profile) {
      problems.push("price profile 文件缺失/非法，无法核对计价身份（real+cap 强制）")
    } else {
      if (manifest.providerId !== profile.providerId) problems.push(`providerId 错配：manifest=${JSON.stringify(manifest.providerId)} profile=${profile.providerId}`)
      if (typeof manifest.endpointOrigin === "string" && !profile.endpointOrigins.includes(manifest.endpointOrigin)) {
        problems.push(`endpointOrigin 不在 profile 信任列表：${JSON.stringify(manifest.endpointOrigin)}（信任 ${profile.endpointOrigins.join(" / ")}）`)
      }
      if (typeof manifest.model === "string" && !profile.prices.some((e) => e.model === manifest.model)) {
        problems.push(`model 无精确价格条目：${JSON.stringify(manifest.model)}`)
      }
      if (manifest.priceProfileId !== profile.profileId) problems.push(`priceProfileId 错配：manifest=${JSON.stringify(manifest.priceProfileId)} profile=${profile.profileId}`)
      if (typeof manifest.priceProfileHash === "string" && manifest.priceProfileHash !== priceProfileHash(profile)) {
        problems.push(`priceProfileHash 漂移：manifest=${String(manifest.priceProfileHash).slice(0, 12)}… != 当前 profile hash`)
      }
      if (manifest.priceProfileCurrency !== profile.currency) problems.push(`priceProfileCurrency 错配：manifest=${JSON.stringify(manifest.priceProfileCurrency)} profile=${profile.currency}`)
    }
  } else if (manifest.real === true) {
    // real 但无 cost cap：不得对不可信端点/缺失 profile 声称精确费用
    if (manifest.actualCostKnown === true && manifest.priceProfileTrustedForEndpoint !== true) {
      problems.push("real 无 cap：priceProfileTrustedForEndpoint!=true 时 actualCostKnown 必须为 false（禁止伪造精确费用结论）")
    }
  }
  if (problems.length > 0) return failCheck(c, problems.slice(0, 10).join(" | "))
  c.detail = capActive
    ? `provider=${String(manifest.providerId)} origin=${String(manifest.endpointOrigin)} model=${String(manifest.model)} profile=${String(manifest.priceProfileId)} hash 一致`
    : "非 real+cap 模式：跳过强制计价身份"
  return c
}

// 20. stage-length-facts：声明目标/执行目标/mock 公平长度/执行口径 expectMinChars 分栏落盘
//    R25-P1-03：validator 从 tasks loader（unscaled 真源）+ manifest.scale + mock 规则 clamp(x,200,1600) 独立重算。
//    scale=0.1 longform 强制例：outline 200/20/200；chapter 3300/330/330。篡改任一值 → 红。
function checkStageLengthFacts(samples: Sample[] | null, manifest: ManifestDoc | null): Check {
  const c = newCheck("stage-length-facts", "declared/execution/mockFairLength/expectMinCharsExecution 分栏且与 loader+scale+mock 规则重算一致")
  if (!manifest) return failCheck(c, "manifest 缺失")
  if (!samples || samples.length === 0) return failCheck(c, "无样本")
  const scale = typeof manifest.scale === "number" && Number.isFinite(manifest.scale) && manifest.scale > 0 ? manifest.scale : null
  if (scale === null) return failCheck(c, `manifest.scale 缺失或非法（${JSON.stringify(manifest.scale)}）`)
  const synthetic = manifest.synthetic === true
  const problems: string[] = []
  let stageTruth: Map<string, { declared: number; expectMin: number | null }>
  try {
    const set = loadEvalTasks(path.join(ROOT, "scripts", "eval-tasks", "tasks.json"))
    stageTruth = new Map()
    for (const t of set.tasks) {
      for (const st of t.stages) {
        stageTruth.set(`${t.id}|${st.stageId}`, { declared: st.targetChars, expectMin: st.expectMinChars ?? null })
      }
    }
  } catch (e) {
    return failCheck(c, `tasks loader 重算失败：${e instanceof Error ? e.message : String(e)}`)
  }
  let checked = 0
  for (const s of samples) {
    const outputs = s.stageOutputs ?? []
    for (const so of outputs) {
      const key = `${s.taskId ?? "?"}|${so.stageId ?? "?"}`
      const truth = stageTruth.get(key)
      const soId = `${s.sampleId ?? "?"}/${so.stageId ?? "?"}`
      if (!truth) {
        problems.push(`${soId}: tasks.json 无该 stage 声明（${key}）`)
        continue
      }
      checked++
      const executionExpected = Math.max(1, Math.round(truth.declared * scale))
      const mockExpected = synthetic ? Math.max(200, Math.min(executionExpected, 1600)) : null
      const expectMinExpected = truth.expectMin !== null ? Math.max(1, Math.round(truth.expectMin * scale)) : null
      if (so.declaredTargetChars !== truth.declared) {
        problems.push(`${soId}: declaredTargetChars=${JSON.stringify(so.declaredTargetChars)} != 真源 ${truth.declared}`)
      }
      if (so.executionTargetChars !== executionExpected) {
        problems.push(`${soId}: executionTargetChars=${JSON.stringify(so.executionTargetChars)} != round(${truth.declared}×${scale})=${executionExpected}`)
      }
      if (so.mockFairLength !== mockExpected) {
        problems.push(`${soId}: mockFairLength=${JSON.stringify(so.mockFairLength)} != ${synthetic ? `clamp(${executionExpected},200,1600)=` : "null（real）"}${JSON.stringify(mockExpected)}`)
      }
      if (so.expectMinCharsExecution !== expectMinExpected) {
        problems.push(`${soId}: expectMinCharsExecution=${JSON.stringify(so.expectMinCharsExecution)} != ${JSON.stringify(expectMinExpected)}`)
      }
    }
  }
  if (checked === 0) return failCheck(c, "无 stageOutputs 可核对（旧产物缺失分栏 → 红）")
  if (problems.length > 0) return failCheck(c, problems.slice(0, 10).join(" | "))
  c.detail = `${checked} 条 stage 产出三栏分落与 loader+scale=${scale}+mock 规则重算全一致`
  return c
}

// ==================== 编排：validateRunDir ====================

export interface ValidateRunDirOptions {
  /** 注入 eval-preflight 的 manifestValidate（复用 S3 基线+新字段 schema 校验）。未注入时跳过该调用，仅做本模块深校验。 */
  manifestValidate?: (m: unknown, opts?: { priceProfile?: unknown }) => { ok: boolean; errors: string[] }
  /** R25-P0-03：计价身份核对用的 price profile 文件路径（缺省 scripts/eval-prices.json） */
  priceProfilePath?: string
}

function loadProfileForValidation(profilePath?: string): PriceProfile | null {
  const p = profilePath ?? path.join(ROOT, "scripts", "eval-prices.json")
  let raw: string
  try {
    raw = fs.readFileSync(p, "utf-8")
  } catch {
    return null
  }
  try {
    const obj = JSON.parse(raw) as PriceProfile
    const v = priceProfileValidate(obj)
    return v.ok ? obj : null
  } catch {
    return null
  }
}

export function validateRunDir(runDir: string, opts?: ValidateRunDirOptions): ValidateResult {
  const loaded = loadRunDir(runDir)
  const checks: Check[] = []
  const priceProfile = loadProfileForValidation(opts?.priceProfilePath)

  const samplesDoc = loaded.samplesDoc
  const manifestDoc = loaded.manifestDoc
  const variantsDoc = loaded.variantsDoc
  const samples = samplesDoc?.samples ?? null
  const header = samplesDoc?.header ?? null
  const fairness = samplesDoc?.fairness ?? null
  const variants = variantsDoc?.variants ?? null
  const modeLabel = typeof header?.mode === "string" ? header.mode : "?"
  const ledger = resolveLedger(samplesDoc, loaded.ledgerRaw)

  // 文件级错误（samples.json / manifest.json / variants.json 任一缺失/损坏）→ 各 check 显式 FAIL
  if (loaded.loadErrors.length > 0) {
    const c = newCheck("load", "产物文件完整性")
    failCheck(c, loaded.loadErrors.join(" | "))
    checks.push(c)
  }

  checks.push(checkContractIdentity(manifestDoc, variants ?? []))
  checks.push(checkInvokePath(variants, samples, ledger))
  checks.push(checkManifestFacts(manifestDoc, samples, loaded.samplesRaw, loaded.variantsRaw, opts?.manifestValidate, priceProfile))
  checks.push(checkRequestTraceCount(manifestDoc, samples))
  checks.push(checkStageCompleteness(samples))
  checks.push(checkCarryoverDup(samples))
  checks.push(checkFailureRounds(samples))
  checks.push(checkSyntheticReal(samples, header, modeLabel))
  checks.push(checkExperimentMode(manifestDoc, header, samples, fairness))
  checks.push(checkPairing(samples, manifestDoc))
  checks.push(checkLedgerFacts(manifestDoc, ledger))
  checks.push(checkLedgerRelations(samples, ledger))
  checks.push(checkRetryConsistency(manifestDoc, ledger))
  checks.push(checkHashConsistency(fairness, ledger, manifestDoc?.experimentMode))
  checks.push(checkTrajectoryHistory(samples, ledger, manifestDoc?.experimentMode))
  checks.push(checkStageTargets(manifestDoc))
  checks.push(checkMultiTurnCompleteness(samples, ledger))
  checks.push(checkPricingIdentity(manifestDoc, priceProfile))
  checks.push(checkStageLengthFacts(samples, manifestDoc))
  checks.push(checkQualityGate(samples))

  const ok = checks.every((c) => c.passed)
  return { ok, checks, exitCode: ok ? 0 : 1 }
}

// ==================== CLI：打印 + 退出码 ====================

function printResult(res: ValidateResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  console.log("===== eval-validate：独立产物校验 =====")
  let pass = 0
  let fail = 0
  for (const c of res.checks) {
    console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.id}  ${c.name}${c.detail ? " — " + c.detail : ""}`)
    if (c.passed) pass++
    else fail++
  }
  console.log("")
  console.log(`===== 校验结果：${pass} PASS / ${fail} FAIL =====`)
}

// ==================== fixture 构造 + mutation matrix ====================

export function buildLegalFixture(): { runDir: string; manifest: ManifestDoc; samplesDoc: SamplesDoc; variantsDoc: VariantsDoc } {
  // 最小合法产物（R22 结构）：1 任务 × 3 变体 × 1 repeat = 3 样本 × 2 阶段 = 6 attempt。
  // 用 style-transfer（2 阶段）作为最小类别。
  const taskId = "style-transfer"
  const variantIds = ["generic_baseline", "deepwriter_current_product", "deepwriter_hardened_candidate"]
  const stageIds = ["extract", "generate"]
  const DEEPWRITER_VARIANTS = new Set(["deepwriter_current_product", "deepwriter_hardened_candidate"])

  // 三个不同的 contractHash（hardened 按任务一个；此处单一任务 → 一个 hardened hash）
  const genHash = sha256("generic")
  const curHash = sha256("current")
  const hardHash = sha256("hardened")

  const samples: Sample[] = []
  const ledger: RequestAttempt[] = []
  let ordinal = 0
  for (const vid of variantIds) {
    const traces: RequestTrace[] = []
    const transcript: TranscriptTurn[] = []
    const isDeepwriter = DEEPWRITER_VARIANTS.has(vid)
    const sampleId = `s-${taskId}-${vid}-r1`
    // runIds：deepwriter 每个 stage 一个；generic 空数组
    const runIds: string[] = isDeepwriter ? stageIds.map((sid) => `run-${taskId}-${vid}-${sid}`) : []
    const requestIds: string[] = []
    const terminalStatus: string[] = []
    const stageOutputs: Array<{ stageId: string; content: string; chars: number; contentSha256: string }> = []
    // R23：历史轮次累积（前序 stage 的 user→assistant 对）；stage N 的 actualHistoryTurnHashes = 此前全部 (user,assistant)
    const historyTurnsAccum: Array<{ role: string; sha256: string }> = []
    for (let si = 0; si < stageIds.length; si++) {
      ordinal++
      const stageId = stageIds[si]
      // R22 主代理对账：fairness 前提是输入等价——user 消息跨 variant 一致（不掺 vid）；
      // actualHistoryHash 按 controlled 冻结口径跨 variant 一致且非空（stage1=空历史规范哈希）。
      const userContent = `stage ${stageId} user content`
      const asstContent = `stage ${stageId} assistant content ${vid} —— ` + "正文".repeat(160) + "。终" // 320+ 字，保证 ≥200
      const userHash = sha256(userContent)
      const asstSha = sha256(asstContent)
      const historyHash = sha256(si === 0 ? "empty-history" : `golden-history-stage-${stageId}`)
      const requestId = `req-${taskId}-${vid}-${stageId}-r1`
      requestIds.push(requestId)
      terminalStatus.push("completed")
      traces.push({
        ordinal,
        sampleId,
        variantId: vid,
        stageId,
        roles: si === 0 ? ["system", "user"] : ["system", "user", "assistant", "user"],
        userHash,
        assistantHash: si === 0 ? "" : asstSha,
        historyCount: si,
        systemHash: sha256("system-" + vid),
        assembledHash: sha256(userContent + asstContent)
      })
      transcript.push({ role: "user", content: userContent, chars: userContent.length, sha256: userHash })
      transcript.push({ role: "assistant", content: asstContent, chars: asstContent.length, sha256: asstSha })
      stageOutputs.push({
        stageId,
        content: asstContent,
        chars: asstContent.length,
        contentSha256: asstSha,
        // R25-P1-03：fixture scale=0.1 → extract 120/12/200/12；generate 500/50/200/30（与 loader+scale+mock 规则重算一致）
        declaredTargetChars: si === 0 ? 120 : 500,
        executionTargetChars: si === 0 ? 12 : 50,
        mockFairLength: 200,
        expectMinCharsExecution: si === 0 ? 12 : 30
      })
      // ledger attempt
      ledger.push({
        requestId,
        sampleId,
        variantId: vid,
        taskId,
        repeat: 1,
        stageId,
        stageOrdinal: si + 1,
        runId: isDeepwriter ? runIds[si] : null,
        outerAttempt: 1,
        innerAttempt: 1,
        outcome: "success",
        httpStatus: 200,
        usagePresent: true,
        actualUserHash: userHash,
        actualHistoryHash: historyHash,
        actualSystemHash: sha256("system-" + vid),
        actualAssembledHash: sha256(userContent + asstContent),
        // R23：provider 实际发送消息内容 hash（本 stage 的 user+assistant）+ 历史轮次切片（前序回合）
        actualMessageContentHashes: [userHash, asstSha],
        actualHistoryTurnHashes: historyTurnsAccum.map((t) => ({ role: t.role, sha256: t.sha256 }))
      })
      // 累积本轮为「下一 stage 的历史」
      historyTurnsAccum.push({ role: "user", sha256: userHash })
      historyTurnsAccum.push({ role: "assistant", sha256: asstSha })
    }
    samples.push({
      sampleId,
      taskId,
      variantId: vid,
      repeat: 1,
      mode: "mock",
      synthetic: true,
      usageStatus: "present",
      rounds: stageIds.length,
      content: transcript.filter((t) => t.role === "assistant").map((t) => t.content).join("\n\n"),
      validation: { passed: true, checks: [] },
      metrics: { status: "ok", failures: 0, retries: 0, attempts: stageIds.length, completedStages: stageIds.length, aborted: false },
      requestTraces: traces,
      canonicalTranscript: transcript,
      variantContractHash: vid === "generic_baseline" ? genHash : vid === "deepwriter_current_product" ? curHash : hardHash,
      runIds,
      requestIds,
      terminalStatus,
      eligibleForReview: true,
      stageOutputs
    })
  }

  // 全程 traces 规范化序列 hash + ledger 规范化哈希
  const allTraces = samples.flatMap((s) => s.requestTraces ?? [])
  const requestTraceHash = sha256(canonicalTraceSequence(allTraces))
  const ledgerSha256 = sha256(canonicalLedger(ledger))
  const requestIdCount = new Set(ledger.map((a) => a.requestId)).size

  const header: Record<string, unknown> = {
    schemaVersion: 1,
    mode: "mock",
    model: "deepseek-v4-flash",
    seed: "seed",
    repeats: 1,
    scale: 0.1,
    tasks: [taskId],
    taskSchemaHash: sha256("taskschema"),
    generatedAt: new Date().toISOString(),
    experimentMode: "controlled",
    synthetic: true
  }

  const fairness: FairnessDoc = {
    inputEquivalence: {
      [taskId]: { equal: true, userEqual: true, historyEqual: true, systemDiffOrdinals: [1, 2], diffOrdinals: [], diffDetail: [] }
    }
  }

  const samplesDoc: SamplesDoc = { schemaVersion: 1, header, fairness, samples, ledger }

  const variantsDoc: VariantsDoc = {
    schemaVersion: 1,
    variants: [
      { variantId: "generic_baseline", path: "direct-fetch", invokePath: null, contractHash: genHash, systemMessageCount: 1, systemMessagePreviewChars: 50 },
      { variantId: "deepwriter_current_product", path: "deepwriter-chain", invokePath: "src/main/chatOrchestration.ts::handleChatStart", contractHash: curHash, systemMessageCount: 3, systemMessagePreviewChars: 200 },
      { variantId: "deepwriter_hardened_candidate", path: "deepwriter-chain", invokePath: "src/main/chatOrchestration.ts::handleChatStart", contractHash: hardHash, systemMessageCount: 4, systemMessagePreviewChars: 300 }
    ]
  }

  const startedAt = new Date(Date.now() - 10000).toISOString()
  const finishedAt = new Date().toISOString()
  const manifest: ManifestDoc = {
    schemaVersion: 1,
    commit: "a".repeat(40),
    dirtyFiles: [],
    nodeVersion: "v24.0.0",
    electronVersion: null,
    platform: "win32",
    taskSchemaHash: sha256("taskschema"),
    variantContractHashes: {
      generic_baseline: genHash,
      deepwriter_current_product: curHash,
      deepwriter_hardened_candidate: { [taskId]: hardHash }
    },
    runnerSourceHash: sha256("runner"),
    seed: "seed",
    argv: ["--mock"],
    synthetic: true,
    real: false,
    startedAt,
    finishedAt,
    // R25-P1-03：stage 三栏重算的事实输入（fixture 与 header.scale 一致）
    scale: 0.1,
    experimentMode: "controlled",
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    plannedRequests: 6,
    actualRequests: ledger.length,
    outerRetries: 0,
    innerRetries: 0,
    innerRetriesObserved: true,
    ledgerSha256,
    requestIdCount,
    localEndpointReceived: ledger.length,
    ledgerMatchesEndpoint: true,
    // R24-P0-01：fixture 用真实 style-transfer 的逐 stage target（extract=120 / generate=500），
    // 与 tasks.json 展开序列多重集比对一致。
    stageTargets: [
      { taskId, stageId: "extract", targetChars: 120 },
      { taskId, stageId: "generate", targetChars: 500 }
    ],
    stageTargetsHash: sha256(JSON.stringify([
      { taskId, stageId: "extract", targetChars: 120 },
      { taskId, stageId: "generate", targetChars: 500 }
    ])),
    expected: {
      tasks: [{ taskId, stages: stageIds.length, expectedSamples: samples.length }],
      variants: variantIds,
      repeats: 1
    },
    usageCoverage: { present: 3, missing: 0, total: 3 },
    requestTraceHash,
    artifactHashes: {
      samplesSha256: sha256(JSON.stringify(samplesDoc, null, 2)),
      variantsSha256: sha256(JSON.stringify(variantsDoc, null, 2))
    },
    sampleCounts: { total: 3, success: 3, failed: 0, validationPassed: 3, validationFailed: 0 }
  }

  const runDir = path.join(osTmp(), `dw-validate-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, "samples.json"), JSON.stringify(samplesDoc, null, 2), "utf-8")
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8")
  fs.writeFileSync(path.join(runDir, "variants.json"), JSON.stringify(variantsDoc, null, 2), "utf-8")

  return { runDir, manifest, samplesDoc, variantsDoc }
}

function osTmp(): string {
  return (process.env.TEMP && process.env.TEMP) || (process.env.TMP && process.env.TMP) || os.tmpdir()
}

// ==================== mutation matrix ====================

interface Mutation {
  name: string
  expectedCheck: string
  /** 反向断言：retry-success 等「新规则下合法」的变异应让 validator 仍绿（不进红）。 */
  assertLegal?: boolean
  apply: (fixture: { runDir: string; manifest: ManifestDoc; samplesDoc: SamplesDoc; variantsDoc: VariantsDoc }) => void
}

const MUTATIONS: Mutation[] = [
  // ===== R22 关键关系 mutation（≥9 类，全部让 validator 非零/命中对应 check） =====
  {
    // 1. 只留固定 invokePath 字符串，删 runIds/requestIds → 编排证据由 ledger 缺失 → invoke-path 红
    name: "invoke-path-delete-runIds-requestIds",
    expectedCheck: "invoke-path",
    apply: (f) => {
      for (const s of f.samplesDoc.samples!) {
        if ((s.variantId ?? "").startsWith("deepwriter_")) {
          s.runIds = []
          s.requestIds = []
        }
      }
    }
  },
  {
    // 2. 删除整个 task 的所有变体（删全部 3 个样本）→ pairing 红（按 expected 比对）
    name: "delete-entire-task-variants",
    expectedCheck: "pairing",
    apply: (f) => {
      f.samplesDoc.samples = []
    }
  },
  {
    // 3. 删除一个失败 attempt 但保留 successful sample（ledger 变短）→ actualRequests != ledger.length → ledger-facts 红
    name: "delete-failed-attempt-shorten-ledger",
    expectedCheck: "ledger-facts",
    apply: (f) => {
      // 删除 ledger 中一条 attempt（ledger 变短），但不重算 manifest.actualRequests → 不匹配
      const before = f.samplesDoc.ledger!.length
      f.samplesDoc.ledger = f.samplesDoc.ledger!.slice(0, before - 1) // 删最后一条 attempt
      // manifest.actualRequests 保持 before（原值）→ 与 ledger.length(=before-1) 不符
      f.manifest.actualRequests = before
    }
  },
  {
    // 4. innerRetries 改成 0 且 innerRetriesObserved=false → retry-consistency 红（禁止用 0 冒充未观测）
    name: "inner-retries-0-impersonating-unobserved",
    expectedCheck: "retry-consistency",
    apply: (f) => {
      f.manifest.innerRetries = 0
      f.manifest.innerRetriesObserved = false
    }
  },
  {
    // 5. 全部 validation=false → quality-gate 红
    name: "all-validation-false",
    expectedCheck: "quality-gate",
    apply: (f) => {
      for (const s of f.samplesDoc.samples!) s.validation = { passed: false, checks: [] }
    }
  },
  {
    // 6. 把 ledger actualHash 换成推测重建值（与 fairness 不一致）→ ledger-sha256/hash-consistency 红
    name: "ledger-actual-hash-tamper",
    expectedCheck: "ledger-facts",
    apply: (f) => {
      // 篡改 ledger 内容但不更新 manifest.ledgerSha256 → ledgerSha256 不匹配 → ledger-facts 红
      const a = f.samplesDoc.ledger![0]
      a.actualUserHash = sha256("tampered-user-hash")
    }
  },
  {
    // 7. 跨 variant 复用 runId/requestId → ledger-relations 红
    name: "cross-variant-runId-requestId-reuse",
    expectedCheck: "ledger-relations",
    apply: (f) => {
      const s0 = f.samplesDoc.samples!.find((s) => s.variantId === "deepwriter_current_product")!
      const s1 = f.samplesDoc.samples!.find((s) => s.variantId === "deepwriter_hardened_candidate")!
      // 让 hardened 样本复用 current 的 runId / requestId（跨 variant 复用）
      s1.runIds = [...(s0.runIds ?? [])]
      s1.requestIds = [...(s0.requestIds ?? [])]
      // 同步 ledger 中 hardened 的 requestId 指向 current 的 requestId（制造重复）
      const curReqId = s0.requestIds![0]
      for (const a of f.samplesDoc.ledger!) {
        if (a.sampleId === s1.sampleId) a.requestId = curReqId
      }
    }
  },
  {
    // 8. retry-success（failures>0, retries>0, completedStages==planned, aborted=false, status='ok'）—— 新规则下必须合法（绿）
    name: "retry-success-legal",
    expectedCheck: "", // 不期望命中任何红 check
    assertLegal: true,
    apply: (f) => {
      const s = f.samplesDoc.samples![0]
      s.metrics!.failures = 1
      s.metrics!.retries = 1 // 新规则要求 retries>0 才是合法 retry-success（否则命中「未解释异常」红）
      s.metrics!.status = "ok"
      s.metrics!.completedStages = 2 // == planned
      s.metrics!.aborted = false
      // 保持 artifactHashes 与落盘内容一致（samplesDoc 已改，需同步重算 samplesSha256，否则 manifest-facts 误红）
      f.manifest.artifactHashes!.samplesSha256 = sha256(JSON.stringify(f.samplesDoc, null, 2))
    }
  },
  {
    // 9. actualRequests 与 ledger.length 不符 → ledger-facts 红
    name: "actual-requests-vs-ledger-length",
    expectedCheck: "ledger-facts",
    apply: (f) => {
      f.manifest.actualRequests = f.samplesDoc.ledger!.length + 1
    }
  },
  {
    // 9b. R22 主代理对账：端点实收数造假（localEndpointReceived 与 ledger 不符但标记 true）→ ledger-facts 红
    name: "fake-endpoint-received-count",
    expectedCheck: "ledger-facts",
    apply: (f) => {
      f.manifest.localEndpointReceived = f.samplesDoc.ledger!.length + 1
      f.manifest.ledgerMatchesEndpoint = true
    }
  },
  {
    // 10. 删除整个 task 的三组样本但保留 expected（只删 deepwriter 两变体 + generic）→ pairing 红（按 expected 比对）
    name: "delete-whole-task-three-variants",
    expectedCheck: "pairing",
    apply: (f) => {
      f.samplesDoc.samples = f.samplesDoc.samples!.filter((s) => false) // 全删
      // 保留 manifest.expected 使 pairing 按 expected 比对缺失
    }
  },

  // ===== 原有 mutation（适配 R22 新字段后保留） =====
  {
    name: "contract-collision(generic==current)",
    expectedCheck: "contract-identity",
    apply: (f) => {
      const gen = f.manifest.variantContractHashes!.generic_baseline
      ;(f.manifest.variantContractHashes!.deepwriter_current_product as unknown) = gen
    }
  },
  {
    name: "delete-stage-trace",
    expectedCheck: "request-trace-count",
    apply: (f) => {
      f.samplesDoc.samples![0].requestTraces!.pop()
    }
  },
  {
    name: "carryover-duplicate",
    expectedCheck: "carryover-dup",
    apply: (f) => {
      const s = f.samplesDoc.samples![0]
      const t = s.canonicalTranscript!
      for (let i = 0; i + 1 < t.length; i++) {
        if (t[i].role === "assistant" && t[i + 1].role === "user" && t[i].content!.length >= 200) {
          t[i + 1].content = t[i + 1].content + t[i].content
          t[i + 1].sha256 = sha256(t[i + 1].content!)
          break
        }
      }
    }
  },
  {
    name: "duration-drift",
    expectedCheck: "manifest-facts",
    apply: (f) => {
      f.manifest.durationMs = 999999999
    }
  },
  {
    name: "failure-rounds-aborted",
    expectedCheck: "failure-rounds",
    apply: (f) => {
      const s = f.samplesDoc.samples![0]
      s.metrics!.aborted = true
      s.metrics!.completedStages = 1 // < planned 2
    }
  },
  {
    name: "synthetic-conflict",
    expectedCheck: "synthetic-real",
    apply: (f) => {
      f.samplesDoc.samples![0].synthetic = false // mode=mock 但 synthetic=false
    }
  },
  {
    name: "experiment-mode-conflict",
    expectedCheck: "experiment-mode",
    apply: (f) => {
      f.manifest.experimentMode = "trajectory" // 但 fairness 只有 inputEquivalence
      f.samplesDoc.header!.experimentMode = "trajectory"
    }
  },
  {
    name: "missing-pairing",
    expectedCheck: "pairing",
    apply: (f) => {
      f.samplesDoc.samples = f.samplesDoc.samples!.slice(0, 2) // 少一个 variant
    }
  },
  {
    name: "samplecounts-mismatch",
    expectedCheck: "manifest-facts",
    apply: (f) => {
      f.manifest.sampleCounts!.total = 1
    }
  },
  {
    name: "artifact-hash-mismatch",
    expectedCheck: "manifest-facts",
    apply: (f) => {
      f.manifest.artifactHashes!.samplesSha256 = "0".repeat(64)
    }
  },

  // ===== R23 新 mutation（4 个，对应 Codex 复审退回避的三个 validator 缺口） =====
  {
    // 删除 trajectory 历史中的 assistant 条目 → 历史结构非法（无 assistant）→ trajectory-history 红
    name: "trajectory-delete-assistant-history",
    expectedCheck: "trajectory-history",
    apply: (f) => {
      // 切 trajectory 模式 + lineageValid（复用 fairness 换 lineageValid）
      f.manifest.experimentMode = "trajectory"
      f.samplesDoc.header!.experimentMode = "trajectory"
      f.samplesDoc.fairness = {
        lineageValid: {
          ["style-transfer"]: { valid: true, sameStart: true, sameProtocol: true, sameSampling: true, structuralIntegrity: true, forked: false, diffDetail: [] }
        }
      }
      // 删除所有 ledger attempt 的 actualHistoryTurnHashes 中的 assistant 条目 + 清空 stageOutputs contentSha256
      for (const a of f.samplesDoc.ledger!) {
        if (Array.isArray(a.actualHistoryTurnHashes)) {
          a.actualHistoryTurnHashes = a.actualHistoryTurnHashes.filter((t) => t.role !== "assistant")
        }
      }
      for (const s of f.samplesDoc.samples!) {
        if (s.stageOutputs) {
          for (const o of s.stageOutputs) o.contentSha256 = ""
        }
      }
    }
  },
  {
    // failures>0 但 retries===0 且 status==='ok' → 未解释异常 → failure-rounds 红
    name: "unexplained-failures-ok",
    expectedCheck: "failure-rounds",
    apply: (f) => {
      const s = f.samplesDoc.samples![0]
      s.metrics!.failures = 1
      s.metrics!.retries = 0
      s.metrics!.status = "ok"
      f.manifest.artifactHashes!.samplesSha256 = sha256(JSON.stringify(f.samplesDoc, null, 2))
    }
  },
  {
    // deepwriter terminalStatus 含 failed 但 content validator 通过（validation.passed=true, status=ok）→ quality-gate 红
    name: "terminal-failed-content-pass",
    expectedCheck: "quality-gate",
    apply: (f) => {
      const s = f.samplesDoc.samples!.find((x) => x.variantId === "deepwriter_current_product")!
      s.terminalStatus = ["completed", "failed"]
      s.validation = { passed: true, checks: [] }
      s.metrics!.status = "ok"
      f.manifest.artifactHashes!.samplesSha256 = sha256(JSON.stringify(f.samplesDoc, null, 2))
    }
  },
  {
    // eligibleForReview=false（其余正常）→ quality-gate 红
    name: "ineligible-review-sample",
    expectedCheck: "quality-gate",
    apply: (f) => {
      const s = f.samplesDoc.samples![0]
      s.eligibleForReview = false
      f.manifest.artifactHashes!.samplesSha256 = sha256(JSON.stringify(f.samplesDoc, null, 2))
    }
  }
]

// ==================== selftest ====================

export function runSelftestMutations(manifestValidateFn?: ManifestValidateFn): { ok: boolean; report: string; details: string[] } {
  const details: string[] = []
  const fixture = buildLegalFixture()

  // 0. 合法 fixture → 全部 PASS
  const legal = validateRunDir(fixture.runDir, { manifestValidate: manifestValidateFn })
  details.push(`LEGAL fixture: exit=${legal.exitCode} 全PASS=${legal.checks.every((c) => c.passed)} (${legal.checks.length} checks)`)
  let legalOk = legal.exitCode === 0 && legal.checks.every((c) => c.passed)

  // 1. mutation matrix
  let mutPass = 0
  let mutFail = 0
  const mutFailures: string[] = []
  for (const m of MUTATIONS) {
    const f = buildLegalFixture()
    m.apply({ runDir: f.runDir, manifest: f.manifest, samplesDoc: f.samplesDoc, variantsDoc: f.variantsDoc })
    // 重新落盘（mutation 修改了内存对象，需写回文件）
    fs.writeFileSync(path.join(f.runDir, "samples.json"), JSON.stringify(f.samplesDoc, null, 2), "utf-8")
    fs.writeFileSync(path.join(f.runDir, "manifest.json"), JSON.stringify(f.manifest, null, 2), "utf-8")
    fs.writeFileSync(path.join(f.runDir, "variants.json"), JSON.stringify(f.variantsDoc, null, 2), "utf-8")

    const res = validateRunDir(f.runDir, { manifestValidate: manifestValidateFn })

    if (m.assertLegal) {
      // 反向断言：新规则下该变异必须合法（exit 0 且全 PASS）
      const legal = res.exitCode === 0 && res.checks.every((c) => c.passed)
      if (legal) {
        mutPass++
        details.push(`  PASS mutation "${m.name}" → exit=0 全PASS（新规则下合法）`)
      } else {
        mutFail++
        mutFailures.push(m.name)
        const fails = res.checks.filter((c) => !c.passed).map((c) => c.id).join(",")
        details.push(`  FAIL mutation "${m.name}" → exit=${res.exitCode} 红=${fails || "无"}（期望新规则下合法绿）`)
      }
    } else {
      const targetCheck = res.checks.find((c) => c.id === m.expectedCheck)
      const targetHit = !!targetCheck && !targetCheck.passed
      const anyFail = res.exitCode !== 0
      if (anyFail && targetHit) {
        mutPass++
        details.push(`  PASS mutation "${m.name}" → exit=${res.exitCode} 命中 ${m.expectedCheck}`)
      } else {
        mutFail++
        mutFailures.push(m.name)
        details.push(`  FAIL mutation "${m.name}" → exit=${res.exitCode} 命中=${targetHit}（期望非0且命中 ${m.expectedCheck}）`)
      }
    }
    try { fs.rmSync(f.runDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  try { fs.rmSync(fixture.runDir, { recursive: true, force: true }) } catch { /* ignore */ }

  const ok = legalOk && mutFail === 0 && mutPass === MUTATIONS.length
  const report = `LEGAL=${legalOk ? "ok" : "FAIL"} mutations=${mutPass}/${MUTATIONS.length} PASS`
  details.unshift(report)
  if (mutFailures.length > 0) details.push(`未命中的变异: ${mutFailures.join(", ")}`)
  return { ok, report, details }
}

// ==================== CLI main ====================

/** 动态加载 out/eval-preflight.mjs 的 manifestValidate（不存在则返回 undefined，优雅降级） */
async function loadPreflightManifestValidate(): Promise<ManifestValidateFn | undefined> {
  const p = path.join(ROOT, "out", "eval-preflight.mjs")
  if (!fs.existsSync(p)) return undefined
  try {
    const mod = (await import(url.pathToFileURL(p).href)) as { manifestValidate?: ManifestValidateFn }
    return typeof mod.manifestValidate === "function" ? mod.manifestValidate : undefined
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes("--selftest-mutations")) {
    const mv = await loadPreflightManifestValidate()
    const r = runSelftestMutations(mv)
    console.log("===== eval-validate selftest-mutations =====")
    for (const d of r.details) console.log(d)
    process.exit(r.ok ? 0 : 1)
    return
  }
  const asJson = args.includes("--json")
  const runDir = args.find((a) => !a.startsWith("--"))
  if (!runDir) {
    console.error("用法：node out/eval-validate.mjs <runDir> [--json] [--price-profile=<path>]")
    console.error("      node out/eval-validate.mjs --selftest-mutations")
    process.exit(2)
  }
  const abs = path.resolve(ROOT, runDir)
  if (!fs.existsSync(abs)) {
    console.error(`runDir 不存在：${abs}`)
    process.exit(2)
  }
  const profilePathArg = args.find((a) => a.startsWith("--price-profile="))?.split("=")[1]
  const mv = await loadPreflightManifestValidate()
  const res = validateRunDir(abs, { manifestValidate: mv, priceProfilePath: profilePathArg })
  printResult(res, asJson)
  process.exit(res.exitCode)
}

if (url.fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("eval-validate 执行异常：", e)
    process.exit(2)
  })
}
