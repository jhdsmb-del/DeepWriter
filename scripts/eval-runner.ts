import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== eval-runner.ts：DeepWriter R19 评测 runner ====================
// 三组同模型对照：generic_baseline / deepwriter_current_product / deepwriter_hardened_candidate。
// 数据化任务集（scripts/eval-tasks/tasks.json）驱动；结构校验器见 eval-validators.ts。
//
// 构建：
//   npx esbuild scripts/eval-runner.ts --bundle --format=esm --platform=node --outfile=out/eval-runner.mjs
// 运行：
//   node out/eval-runner.mjs --mock --task=longform-multichapter --repeats=1 --scale=0.1
//   node out/eval-runner.mjs --mock --scale=0.1 --repeats=1        # 全任务 15 样本
//   node out/eval-runner.mjs --real --task=style-transfer           # 无 key 时 blocked + exit 0
//
// 输出：out/eval/run-<ts>/samples.json + manifest.json（+ out/eval/<run>/renpy/*.rpy 产物）
// 铁律：--real 的 API key 只从 DEEPSEEK_API_KEY 读，只查存在/不存在；绝不落 key 值、绝不过度联网；
//       real 缺 key → 打印 blocked/not_run + exit 0。

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as os from "node:os"
import * as http from "node:http"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { freezeEvalPricing, createSyntheticEvalPriceProfile, pricingForFrozenEvalConfig, isEvalDurablePause, type FrozenEvalPricing } from './eval-pricing'
import { publishCliManuscript } from '../src/cli/manuscript'
import { buildEvaluationSnapshot } from './eval-execution-budget'

import {
  loadEvalTasks,
  loadGoldenHistory,
  goldenHistoryForOrdinal,
  goldenTurnForStage,
  goldenHistoryHash,
  renderTemplate,
  countHistoryPairs,
  roleHash,
  assembledHash,
  systemHash,
  sha256,
  isExperimentMode,
  expandStages,
  canonicalTraceSequence,
  canonicalLedger,
  type EvalTask,
  type EvalTaskSet,
  type TranscriptTurn,
  type RequestTrace,
  type RequestAttempt,
  type ProviderAttemptInfo,
  type ExperimentMode,
  type GoldenHistorySet,
  type GoldenHistoryTurn,
  stageTargetsHash
} from "./eval-schema"
import { runValidator, type ValidationResult, type StageOutput } from "./eval-validators"
import {
  VARIANT_IDS,
  DEFAULT_SAMPLING,
  buildGenericBaseline,
  buildSpecializedStory,
  variantContractHash,
  loadDeepWriterOrchestrationRuntime,
  type VariantId,
  type VariantContract,
  type SamplingParams,
  type DeepWriterOrchestrationRuntime
} from "./eval-variants"
import {
  makeSpyInstrumentation,
  assertSameOrchestrationRuntime,
  ORCHESTRATION_MODULE,
  ORCHESTRATION_FN,
  type OrchestrationTrace
} from "./eval-instrumentation"
import {
  computeExitDecision,
  manifestValidate,
  loadPriceProfile,
  computeSampleCost,
  matchPriceEntry,
  priceProfileHash,
  utf8BodyTokenCeiling,
  FRAMING_TOKENS_BASE,
  FRAMING_TOKENS_PER_MESSAGE,
  type PriceProfile
} from "./eval-preflight"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const require = createRequire(import.meta.url)
const esbuild = require("esbuild") as { build(opts: Record<string, unknown>): Promise<unknown> }

// ---------------- electron-shim（照抄 benchmark-real.ts） ----------------

const ELECTRON_SHIM = {
  name: "electron-shim",
  setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "electron-shim" }))
    build.onLoad({ filter: /.*/, namespace: "electron-shim" }, () => ({
      contents: [
        "export const app = { getPath: (n) => String(n), isPackaged: false };",
        "export const dialog = { showMessageBox: async () => ({ response: 1 }) };",
        "export const ipcMain = { handle: () => undefined, on: () => undefined };",
        "export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => null, decryptString: () => \"\" };",
        "export const shell = { openExternal: () => undefined, openPath: async () => \"\" };",
        "export const clipboard = { writeText: () => undefined };",
        "export const Menu = { buildFromTemplate: (t) => ({ popup: () => undefined, template: t }) };"
      ].join("\n"),
      loader: "js"
    }))
  }
}

/** 把项目 TS 模块 bundle 成临时 ESM 并加载 */
async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(ROOT, rel)
  const outfile = path.resolve(ROOT, "out", `bmmod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: true,
      outfile,
      external: desktopSourceExternals(abs, ["iconv-lite", "pdf-parse", "mammoth", "fflate", "node:sqlite"]),
      logLevel: "silent",
      plugins: [ELECTRON_SHIM]
    })
    const mod = await import(url.pathToFileURL(outfile).href)
    return mod as Record<string, unknown>
  } finally {
    try {
      await fs.promises.unlink(outfile)
    } catch {
      /* 清理失败忽略 */
    }
  }
}

// ---------------- 确定性 mock SSE（照抄 benchmark-real.ts 思路） ----------------

/** 生成一个满足 renpy 校验器的确定性 .rpy 骨架（label/menu/jump/return 全可达） */
function mockRenpySkeleton(_targetChars: number): string {
  return [
    "define linmo = Character(\"林默\", color=\"#99ccff\")",
    "define suwan = Character(\"苏晚\", color=\"#ff99cc\")",
    "define laozhou = Character(\"老周\", color=\"#ccff99\")",
    "label start:",
    "    scene bg rooftop",
    "    show suwan happy",
    "    suwan \"你来了。\"",
    "    linmo \"嗯。\"",
    "    menu:",
    "        \"追问父亲的下落\":",
    "            jump good_end",
    "        \"转身离开\":",
    "            jump bad_end",
    "label good_end:",
    "    linmo \"告诉我实话。\"",
    "    suwan \"好，我告诉你。\"",
    "    return",
    "label bad_end:",
    "    linmo \"算了。\"",
    "    suwan \"……\"",
    "    return"
  ].join("\n")
}

/** 生成一个含三人物名 + 语气词差异的确定性合成正文（满足 character-consistency 校验器） */
function mockCharacterText(targetChars: number, rand: () => number): string {
  const pool = "的了一是在不有和这大为上以到说要去你全会着没有看好他出来就小么也等多对自能下那得后于里可家还年发成只天过她用行面想作种如开从当来"
  const names = ["林默", "苏晚", "老周"]
  const interjections = ["嘛", "啦", "得嘞", "中"]
  let text = ""
  let i = 0
  while (text.length < targetChars) {
    if (i % 37 === 0) {
      text += names[i % 3]
    } else if (i % 53 === 13) {
      text += interjections[i % 4]
    } else {
      text += pool[Math.floor(rand() * pool.length)]
    }
    i++
  }
  return text
}

/**
 * mock 公平性约束（主代理硬性要求）：mock SSE 的输出长度必须**只**由 (taskId, targetChars, scale, seed) 决定，
 * 绝不得从请求文本里解析"声明字数"。这里把 length 与 seed 编码为确定性凭证：
 *   fairLength = clamp( round(targetChars * scale), [200, 1600] )   —— 长度函数，纯由 (targetChars, scale) 决定
 *   fairSeed   = sha256(taskId:targetChars:scale:seed).slice(0,16)  —— 内容 PRNG 种子，纯由 4-tuple 决定
 * 凭证字符串 `mock-<fairLength>-<fairSeed>` 作为 mock 的 apiKey（Authorization: Bearer 头），
 * 同时被 generic（fetch）与 deepwriter（streamChat 的 params.apiKey）透传；mock 据此确定长度，
 * 从而三组 variant 的 mock 输出长度严格一致（共享测量的公平性）。
 */
function mockFairAuth(taskId: string, targetChars: number, scale: number, seed: string): string {
  const fairLength = Math.max(200, Math.min(Math.max(0, Math.round(targetChars * scale)), 1600))
  const fairSeed = createHash("sha256").update(`${taskId}:${targetChars}:${scale}:${seed}`).digest("hex").slice(0, 16)
  return `mock-${fairLength}-${fairSeed}`
}

/** 从 mock 凭证解析出公平长度与公平种子；非凭证（real 场景）回退 */
function parseMockAuth(auth: string | undefined): { fairLength: number; fairSeed: string | null } | null {
  if (!auth) return null
  const m = /^Bearer\s+mock-(\d+)-([0-9a-f]{16})$/i.exec(auth.trim())
  if (!m) return null
  return { fairLength: Number(m[1]), fairSeed: m[2] }
}

function startMockSse(): Promise<{ server: http.Server; port: number; getReceivedCount: () => number }> {
  // R22 主代理对账：端点实收请求计数（每个到达本端点的 HTTP 请求 +1），
  // 供 manifest.localEndpointReceived 与 ledger.length 三方核对（actualRequests == ledger.length == 实收数）。
  let receivedRequests = 0
  const server = http.createServer((req, res) => {
    receivedRequests++
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      let messages: Array<{ role: string; content: string }> = []
      try {
        messages = (JSON.parse(body || "{}").messages ?? []) as Array<{ role: string; content: string }>
      } catch {
        messages = []
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      // R20 公平性：内容生成的种子只取自「非 system」消息（user/assistant）。
      // 三组的 system 提示不同（被测变量），若种子含 system 则三组产出正文不同 →
      // assistantHash 不等价（假红）。排除 system 后，等价输入 → 等价产出。
      const nonSystem = messages.filter((m) => m.role !== "system")
      const joined = nonSystem.map((m) => m.content ?? "").join(" ")
      const auth = req.headers["authorization"] as string | undefined
      const fair = parseMockAuth(auth)

      // R20 公平性：mock 独立检测「本请求 messages 中的历史轮次对数」。
      // 若某 variant 缺历史（失忆）而另两组有，这里检测到的对数会偏小 → 写入 HISTORY-PAIRS 标记，
      // 供 runner 逐 ordinal 比对 mockHistoryPairs 三组是否一致。
      const mockHistoryPairs = countHistoryPairs(messages)

      // 内容 PRNG 种子：fairSeed（纯由 4-tuple 决定）+ 本请求内容 sha256（按阶段区分，
      // 使同任务的多个 stage 产出内容可区分，而长度仍由 fairLength 统一决定——公平性只约束长度）。
      // R23 反证 C6 修正：加入 historyPairs——同 stage 的 continuation 多轮历史对递增 → 内容逐轮演进，
      // 与真实模型「历史不同 → 输出不同」同构（避免确定性 mock 多轮同文被 duplicate 检测卡死）。
      // 回退路径（无凭证）：仅请求内容 sha256。
      let a: number
      if (fair?.fairSeed) {
        a = createHash("sha256").update(fair.fairSeed + "\u0000" + joined + "\u0000" + String(mockHistoryPairs)).digest().readUInt32LE(0) >>> 0
      } else {
        a = createHash("sha256").update(joined).digest().readUInt32LE(0) >>> 0
      }
      const rand = (): number => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const pool = "的了一是在不有和这大为上以到说要去你全会着没有看好他出来就小么也等多对自能下那得后于里可家还年发成只天过她用行面想作种如开从当来"

      // 长度：优先用公平凭证决定（三组一致）；回退到旧的"声明字数"解析仅作兜底。
      let targetChars: number
      if (fair) {
        targetChars = fair.fairLength
      } else {
        const declared = joined.match(/(\d{4,5})\s*字/)
        targetChars = declared ? Math.min(Number(declared[1]), 1600) : 800
        targetChars = Math.max(200, targetChars)
      }

      // 类别感知的确定性合成：让 structural 校验器在 mock 下真实通过（仍是合成占位文本）
      const hasRenpy = joined.includes("Ren'Py") || joined.includes(".rpy") || joined.includes("galgame")
      const hasChar = joined.includes("林默") && joined.includes("苏晚") && joined.includes("老周")

      let text = ""
      if (hasRenpy) {
        text = mockRenpySkeleton(targetChars)
      } else if (hasChar) {
        text = mockCharacterText(targetChars, rand)
      } else {
        while (text.length < targetChars) text += pool[Math.floor(rand() * pool.length)]
      }
      const promptTokens = Math.max(10, Math.ceil(joined.length / 3))
      const completionTokens = Math.max(10, Math.ceil(text.length / 2))
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_cache_hit_tokens: Math.floor(promptTokens * 0.6),
        prompt_cache_miss_tokens: Math.ceil(promptTokens * 0.4),
        completion_tokens_details: { reasoning_tokens: 3 },
        mockHistoryPairs
      }
      // 历史检测标记注入 reasoning_content（非正文，不改动 content 长度/内容 → 长度公平性不变）。
      // generic 与 deepwriter 两条路径都会把 reasoning_content 以 `reasoning` 事件透出（见 deepseek.ts）。
      const chunks: Array<Record<string, unknown>> = [
        { id: "m", choices: [{ index: 0, delta: { reasoning_content: `（模拟推理）[HISTORY-PAIRS:${mockHistoryPairs}]`, role: "assistant" }, finish_reason: null }], usage: null }
      ]
      for (let i = 0; i < text.length; i += 40) {
        chunks.push({ id: "m", choices: [{ index: 0, delta: { content: text.slice(i, i + 40) }, finish_reason: null }], usage: null })
      }
      chunks.push({ id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })
      let i = 0
      const writeNext = (): void => {
        if (i >= chunks.length) {
          res.write("data: [DONE]\n\n")
          res.end()
          return
        }
        res.write(`data: ${JSON.stringify(chunks[i])}\n\n`)
        i++
        setTimeout(writeNext, 4)
      }
      setTimeout(writeNext, 12)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number } | null
      resolve({ server, port: addr?.port ?? 0, getReceivedCount: () => receivedRequests })
    })
  })
}

/**
 * R21 集成测试用「system-sensitive」本地 deterministic 端点（可选，--sensitive-endpoint）。
 * 与 mock 的区别：输出正文由请求 system 消息的 sha256 前 4 位决定（映射到不同文本模板），
 * 从而三组 variant（system 不同）输出正文不同 → 复现 Codex P0-01 的红场景。
 * 但长度仍由 (taskId, targetChars, scale) 决定（fairLength），与 system 无关 → 长度口径仍公平。
 * 全程本地、0 真实请求。辅助函数：
 *   systemSig(messages) = sha256(全部 system 内容拼接).slice(0,4)
 * 模板映射：sig 的首 hex 数码 % 4 选择不同正文生成器；正文确定性、长度统一为 fairLength。
 */
function sensitiveBodyFor(sig: string, targetChars: number, seed: number): string {
  // 用 sig 的首字符（0-15）选模板族；seed 供同类体内确定性 PRNG
  const idx = parseInt(sig[0], 16) % 4
  const pool = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥清水江雾闸门老街面人物沉默追问旧事伏笔回收"
  const prng = (): number => {
    let b = (seed ^ 0x9e3779b9) | 0
    return (() => {
      b |= 0
      b = (b + 0x6d2b79f5) | 0
      let t = Math.imul(b ^ (b >>> 15), 1 | b)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    })()
  }
  const prefixes = ["【甲案】", "【乙案】", "【丙案】", "【丁案】"]
  const suffixes = ["——其一", "——其二", "——其三", "——其四"]
  let text = prefixes[idx]
  let i = 0
  while (text.length < targetChars) {
    text += pool[Math.floor(prng() * pool.length)]
    if (++i % 103 === 0) text += suffixes[idx]
  }
  return text
}

function startSensitiveSse(): Promise<{ server: http.Server; port: number; getReceivedCount: () => number }> {
  let receivedRequests = 0
  const server = http.createServer((req, res) => {
    receivedRequests++
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      let messages: Array<{ role: string; content: string }> = []
      try {
        messages = (JSON.parse(body || "{}").messages ?? []) as Array<{ role: string; content: string }>
      } catch {
        messages = []
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      const auth = req.headers["authorization"] as string | undefined
      const fair = parseMockAuth(auth)
      const mockHistoryPairs = countHistoryPairs(messages)
      // system-sensitive 关键：正文由 system 摘要决定（三组 system 不同 → 正文不同）
      const sysText = messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n")
      const sig = createHash("sha256").update(sysText).digest("hex").slice(0, 4)
      const seedNum = (parseInt(fair?.fairSeed ?? "0", 16) || 0) >>> 0
      // 长度仍公平（纯由 fairLength 决定），与 system 无关
      const targetChars = fair ? fair.fairLength : 800
      const text = sensitiveBodyFor(sig, targetChars, seedNum)
      const promptTokens = Math.max(10, Math.ceil(sysText.length / 3 + messages.filter((m) => m.role !== "system").map((m) => m.content ?? "").join(" ").length / 3))
      const completionTokens = Math.max(10, Math.ceil(text.length / 2))
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_cache_hit_tokens: Math.floor(promptTokens * 0.6),
        prompt_cache_miss_tokens: Math.ceil(promptTokens * 0.4),
        completion_tokens_details: { reasoning_tokens: 3 },
        mockHistoryPairs
      }
      const chunks: Array<Record<string, unknown>> = [
        { id: "m", choices: [{ index: 0, delta: { reasoning_content: `（模拟推理，system-sensitive）[HISTORY-PAIRS:${mockHistoryPairs}][SYS-SIG:${sig}]`, role: "assistant" }, finish_reason: null }], usage: null }
      ]
      for (let i = 0; i < text.length; i += 40) {
        chunks.push({ id: "m", choices: [{ index: 0, delta: { content: text.slice(i, i + 40) }, finish_reason: null }], usage: null })
      }
      chunks.push({ id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })
      let i = 0
      const writeNext = (): void => {
        if (i >= chunks.length) {
          res.write("data: [DONE]\n\n")
          res.end()
          return
        }
        res.write(`data: ${JSON.stringify(chunks[i])}\n\n`)
        i++
        setTimeout(writeNext, 4)
      }
      setTimeout(writeNext, 12)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number } | null
      resolve({ server, port: addr?.port ?? 0, getReceivedCount: () => receivedRequests })
    })
  })
}

// ---------------- 统计工具 ----------------

function countCjk(text: string): number {
  let n = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code >= 0x3000 && code <= 0x9fff) n++
  }
  return n
}

/** 逐阶段展开（与 eval-schema.expandStages 同口径，本地复制避免额外 import） */
function expandStagesLocal(task: Pick<EvalTask, "stages">): Array<{ stageId: string; n: number }> {
  const out: Array<{ stageId: string; n: number }> = []
  for (const st of task.stages) {
    const repCount = Math.max(1, st.repeats ?? 1)
    for (let n = 1; n <= repCount; n++) out.push({ stageId: st.stageId, n })
  }
  return out
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------- CLI 帮助 ----------------

function printHelp(): void {
  console.log(`DeepWriter R19 评测 runner（三组同模型对照 variant）
用法：
  node out/eval-runner.mjs --mock [选项]     # 本地确定性 synthetic 模型（验证管道，不联网）
  node out/eval-runner.mjs --real [选项]     # 真实 DeepSeek（key 从环境变量 DEEPSEEK_API_KEY 读）

选项：
  --mock | --real           模式二选一（必填）
  --task=<id>               只跑单个任务 id（默认全部 5 个）
  --repeats=N               每个 (task × variant) 的重跑次数（默认 1）
  --model=NAME              模型名（默认 deepseek-v4-flash）
  --scale=N                 目标字数统一缩放系数（默认 1；mock 冒烟建议 0.1）
  --out-dir=PATH            输出根目录（默认 out/；实际写 out/eval/run-<ts>/）
  --save-content            real 模式也落盘正文（默认 real 不落正文，只落统计）
  --experiment=MODE        实验模式：controlled（默认，golden history 输入等价）| trajectory（自然回灌 + lineage 断言）
  --sensitive-endpoint      用本地 system-sensitive 端点（正文随 system 变、长度不变），用于复现 system-sensitive 红场景
  --probe-history-gap       红测：generic 第二轮起不携带 transcript（模拟失忆），验证等价 validator 拒绝
  --price-profile=PATH      授权参考价格文件（real 必须显式提供与信任hash，不冒称官方证据）
  --trust-price-profile-hash=SHA256  明确信任该规范化价格profile hash（价格改动即失效）
  --pricing-provider-id=ID  请求provider身份；官方DeepSeek origin默认deepseek，其余需显式指定
  --help                    打印本帮助

真实模式环境变量：
  DEEPSEEK_API_KEY          API key（缺失 → blocked + exit 0，不伪造、不联网）
  DEEPSEEK_BASE_URL         端点（默认 https://api.deepseek.com）

退出码：
  real 缺 key → 0（blocked）；mock 有失败样本（管道坏）→ 1；transcript 不等价（公平性阻断）→ 1；其它错误 → 2；正常 → 0
输出：
  out/eval/run-<ts>/samples.json  +  manifest.json  +  renpy/*.rpy`)
}

// ---------------- 样本类型 ----------------

interface Sample {
  sampleId: string
  taskId: string
  variantId: VariantId
  repeat: number
  mode: "mock" | "real"
  synthetic: boolean
  model: string
  seed: string
  promptHash: string
  variantContractHash: string
  rounds: number
  stageResults: Array<{ stageId: string; chars: number; valid: boolean }>
  /** R23-R02：每 stage 产出（contentSha256 供 trajectory-history 逐序验证） */
  stageOutputs: StageOutput[]
  content: string
  usage: {
    promptTokens: number; completionTokens: number; totalTokens: number
    cacheHitTokens: number; cacheMissTokens: number | null; raw: Record<string, unknown>
  }
  metrics: {
    ttftMs: number | null; totalMs: number; outputChars: number; cjkChars: number
    finishReason: string | null; status: "ok" | "failed"; failures: number; retries: number
  }
  validation: ValidationResult
  requestTraces: RequestTrace[]
  canonicalTranscript: TranscriptTurn[]
  fairnessFail: boolean
  usageStatus: "present" | "missing"
  /** R22-R02 / Codex P0-02：runtime 编排复用证据（生产 handler 与 eval candidate 同一 handleChatStart） */
  orchestrationTrace: OrchestrationTrace | null
  /** R22-R01：每 stage 的真实 runId / terminal 状态 / ledger requestId 关联 */
  runIds: string[]
  terminalStatus: string[]
  requestIds: string[]
  /** R23-R03：本样本是否可进盲评与质量聚合（status ok + validation 过 + deepwriter 全 completed） */
  eligibleForReview: boolean
  /** R23-R03：结构化失败原因（本样本任一 stage/attempt 的失败明细，非终态原因不落） */
  failureReasons: string[]
}

// ---------------- R22-R01 / Codex P0-01：统一编排 runtime ----------------
// 评分样本本身走真实编排：删除 throwaway 探针（旧 loadDeepChain 的 modelCall 旁路 + 独立
// throwaway run）。deepwriter 两变体每个 stage 都经 createChatOrchestration.handleChatStart →
// startChatRun → engine.start/step 真实运行，正文从真实 store（getTurnsByRun）取回。
// 一个 runtime 承载编排与内容生成（同一实例），orchestrationTrace 是真实证据。

/** repository 的最小结构接口（跨 bundle 结构兼容，不做静态类型检查） */
interface RepoLike {
  open(): void
  close(): void
  createSession(sessionId: string, title: string, model: string): void
  deleteSession(sessionId: string): void
  appendSessionMessage(m: Record<string, unknown>): void
  getSessionMessages(sessionId: string): Array<{ msg_id: string; seq: number; role: string; content: string }>
  getRun(runId: string): { run_id: string; status: string; phase: string; error_code?: string | null } | null
  getTurnsByRun(runId: string): Array<{ turn_id: string; run_id: string; turn_seq: number; role: string; content: string; reasoning_content: string | null }>
  touchSession(sessionId: string): void
}

/** 一个 stage 的真实运行结果 */
interface StageRunResult {
  runId: string
  terminalStatus: string
  content: string
  /** R24-P0-02：多轮 composed 明细（turnChars/turnHashes 供 validator 完整性复核） */
  reasoning: string
  turnCount: number
  turnChars: number[]
  turnHashes: string[]
  /** R23-R01：terminal 投影是否成功（共享 projectTerminalAssistant 结果；失败必须阻断 stage） */
  projectionOk: boolean
  projectionReason?: string
  errorCode?: string
}

/** 统一编排 runtime：一个 repo + engine + orchestration，评分与内容生成同源 */
interface UnifiedOrchestration {
  rt: DeepWriterOrchestrationRuntime
  repo: RepoLike
  kernelConfigs: Map<string, Record<string, unknown>>
  fairKeys: Map<string, string>
  evidencePaths: Readonly<{ databasePath: string; artifactDir: string; documentsDir: string }>
  /** spy 用于记录 handleChatStart 命中计数（最终 runtime 复用断言用） */
  spy: ReturnType<typeof makeSpyInstrumentation>
  /**
   * 真实运行一个 stage：构建快照 → handleChatStart → 轮询终端 → 从 store 取回正文。
   * controlled 模式调用方需先经 prewriteGoldenHistory 写入 golden 历史。
   */
  runStage(params: {
    runId: string
    sessionId: string
    userText: string
    mode: string
    longMode: boolean
    story: Record<string, unknown> | null
    settings: Record<string, unknown>
    fairAuth: string
    targetChars: number
  }): Promise<StageRunResult>
  /** 预先写入 golden 历史到样本 session（controlled 模式；idempotent，按序覆盖） */
  prewriteGoldenHistory(sessionId: string, goldenKey: string, turns: GoldenHistoryTurn[]): void
  close(): void
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"])

export async function createUnifiedOrchestration(opts: { baseUrl: string; model: string; settings: Record<string, unknown>; sampling: SamplingParams; pricing: FrozenEvalPricing | null; maxCostCny?: number | null; evidenceDir?: string; publishArtifacts?: boolean }): Promise<UnifiedOrchestration> {
  if (opts.maxCostCny != null && (!Number.isFinite(opts.maxCostCny) || opts.maxCostCny <= 0)) throw new Error('Evaluation maxCostCny must be a finite positive amount')
  const rt = await loadDeepWriterOrchestrationRuntime(loadTsModule)

  const dbDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dw-eval-"))
  const dbPath = path.join(dbDir, "eval.db")
  const evidenceRoot = opts.evidenceDir ? path.resolve(opts.evidenceDir) : dbDir
  await fsp.mkdir(evidenceRoot, { recursive: true })
  const documentsDir = path.join(await fsp.realpath(evidenceRoot), 'docs')
  const artifactDir = path.join(dbDir, 'artifacts')
  const evidencePaths = Object.freeze({ databasePath: dbPath, artifactDir, documentsDir })
  const repo = rt.createRepository(dbPath) as unknown as RepoLike
  repo.open()

  const storePort = rt.createRunStorePort(repo as never, artifactDir)
  const ctxSvc = rt.createContextService(repo as never)
  const kernelConfigs = new Map<string, Record<string, unknown>>()
  const fairKeys = new Map<string, string>()
  const spy = makeSpyInstrumentation()

  // buildPrefix：复制生产 buildRunPrefix（mode profile + 快照记忆；无附件）
  const buildPrefix = async (rc: Record<string, unknown>): Promise<Array<{ role: string; content: string }>> => {
    const pfx: Array<{ role: string; content: string }> = [...rt.buildStaticSystemMessages(rc)]
    const memSnap = (rc as { memory?: { projectPath?: string; projectContent?: string; userContent?: string } }).memory
    if (memSnap) {
      if (memSnap.projectPath && memSnap.projectContent?.trim())
        pfx.push({ role: "system", content: `## 项目记忆（${memSnap.projectPath}）\n${memSnap.projectContent}` })
      if (memSnap.userContent?.trim())
        pfx.push({ role: "system", content: `## 用户记忆\n${memSnap.userContent}` })
    }
    return pfx
  }

  // engine 引用（供 getSignal 自引用）
  let engineRef: { abortSignal(runId: string): AbortSignal | undefined } | null = null
  // R23-R01：terminal assistant → session 投影结果（engine onEvent terminal 同步执行，runStage 轮询等待）。
  // 与生产 index.ts 同函数同时机（projectTerminalAssistant 唯一权威实现），投影失败必须阻断 stage。
  const projectionResults = new Map<string, { ok: boolean; projected: boolean; reason?: string }>()
  const engine = rt.createAgentRunEngine({
    store: storePort,
    ...(opts.publishArtifacts === false ? {} : {
      publishLongwriteArtifact: async (input: { runId: string; content: string; contentHash: string; config: Record<string, unknown> }) => {
        // Eval never inherits a desktop/user document directory. Its accepted snapshot owns this isolated evidence root.
        if (input.config.docDir !== documentsDir) throw new Error('评测稿件目录与冻结 evidence 目录不一致')
        await fsp.mkdir(documentsDir, { recursive: true })
        if ((await fsp.lstat(documentsDir)).isSymbolicLink() || await fsp.realpath(documentsDir) !== documentsDir) throw new Error('评测稿件目录不能是链接或重定向目录')
        return publishCliManuscript(input)
      }
    }),
    modelCall: rt.createModelCallAdapter({
      getApi: (runId: string) => {
        const cfg = kernelConfigs.get(runId) ?? {}
        return {
          apiKey: fairKeys.get(runId) ?? (opts.settings as { apiKey: string }).apiKey,
          baseUrl: opts.baseUrl,
          model: (cfg.model as string) ?? opts.model,
          maxTokens: (cfg.maxTokens as number) ?? opts.sampling.maxTokens,
          outputTokenLimit: (cfg.outputTokenLimit as number) ?? opts.sampling.maxTokens,
          thinking: { enabled: false, effort: "medium" },
          temperature: (cfg.temperature as number) ?? opts.sampling.temperature,
          topP: (cfg.topP as number) ?? opts.sampling.topP,
          providerId: opts.pricing?.record.providerId,
          pricing: opts.pricing ? pricingForFrozenEvalConfig(cfg, opts.pricing.record.providerId, opts.pricing.record.currency) : null
        }
      },
      buildPrefix,
      getSignal: (runId: string) => engineRef?.abortSignal(runId),
      getConfig: (runId: string) => kernelConfigs.get(runId) ?? {},
      assembleContext: (config: Record<string, unknown>, round: number, live: Array<{ role: string; content: string }>, prefix: Array<{ role: string; content: string }>) =>
        (ctxSvc as { assembleRunContext(config: Record<string, unknown>, round: number, live: Array<{ role: string; content: string }>, prefix: Array<{ role: string; content: string }>): Promise<Record<string, unknown>> }).assembleRunContext(config, round, live, prefix)
    }) as never,
    toolExecutor: async () => JSON.stringify({ ok: true, message: "eval" }),
    getConfig: (runId: string) => kernelConfigs.get(runId) ?? {},
    onEvent: (runId: string, ev: unknown) => {
      // R23-R01：与生产 index.ts 同分支同时机——terminal 事件同步投影 assistant 到 canonical session。
      const e = ev as { type?: string; run?: { status?: string } }
      if (e.type === "terminal") {
        const cfg = kernelConfigs.get(runId) ?? {}
        const sessionId = (cfg as { sessionId?: string }).sessionId
        if (sessionId) {
          const res = rt.projectTerminalAssistant(
            {
              getTurnsByRun: (r: string) => repo.getTurnsByRun(r),
              getSessionMessages: (s: string) => repo.getSessionMessages(s),
              appendSessionMessage: (m: Record<string, unknown>) => repo.appendSessionMessage(m),
              touchSession: (s: string) => repo.touchSession(s)
            },
            runId,
            sessionId,
            e.run?.status ?? ""
          )
          projectionResults.set(runId, res)
        } else {
          projectionResults.set(runId, { ok: false, projected: false, reason: "missing-session-id" })
        }
      }
    },
    onRunUpdate: () => undefined
  }) as { abortSignal(runId: string): AbortSignal | undefined; cancel(runId: string): Promise<void> }
  engineRef = engine

  const buildConfig = async (p: Record<string, unknown>, settings: Record<string, unknown>, sessionId: string): Promise<Record<string, unknown>> => {
    const payload = p as { id: string; text?: string; mode?: string; longMode?: boolean; story?: unknown; targetChars?: number }
    const cfg = buildEvaluationSnapshot(rt, {
      payload: {
        id: payload.id,
        mode: payload.mode ?? "agent",
        text: payload.text ?? "",
        targetChars: payload.targetChars ?? 0,
        longMode: payload.longMode ?? false,
        workspace: "chat",
        phase: "execute",
        planText: "",
        story: payload.story ?? null,
        attachments: []
      },
      settings: { ...settings, docDir: documentsDir },
      sessionId,
      memory: { projectPath: "", projectContent: "", userContent: "" },
      pricingSnapshots: opts.pricing ? [structuredClone(opts.pricing.record)] : []
    }, opts.maxCostCny)
    if (opts.pricing) cfg.evalPricingProvenance = structuredClone(opts.pricing.provenance)
    kernelConfigs.set(payload.id, cfg)
    return cfg
  }

  const orchestration = rt.createChatOrchestration({
    repository: repo as never,
    runKernel: engine as never,
    startedChats: new Set<string>(),
    loadSettings: async () => opts.settings,
    buildConfig,
    instrumentation: spy.instrumentation
  })

  const waitTerminal = async (runId: string, timeoutMs: number): Promise<StageRunResult["terminalStatus"]> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const run = repo.getRun(runId)
      if (isEvalDurablePause(run?.status)) return run!.status
      if (run && TERMINAL_STATUSES.has(run.status)) return run.status
      if (Date.now() > deadline) {
        return run ? run.status : "missing"
      }
      await delay(25)
    }
  }

  // R23-R01：等待「terminal 状态落库」且「投影回调已记录」（projectionResults 有值）。
  // engine 的 finalize 先 patchRun（status 落 terminal）再 emit terminal（onEvent 同步执行投影）——
  // 两件事在同一 microtask 序列内，但轮询者可能插队在 patchRun 与 emit 之间，
  // 故此处显式等投影记录，保证返回时 session 已含 assistant 投影。
  const waitTerminalWithProjection = async (runId: string, timeoutMs: number): Promise<StageRunResult["terminalStatus"]> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const run = repo.getRun(runId)
      if (isEvalDurablePause(run?.status)) return run!.status
      const terminal = run && TERMINAL_STATUSES.has(run.status)
      if (terminal && projectionResults.has(runId)) return run!.status
      if (Date.now() > deadline) {
        if (terminal && !projectionResults.has(runId)) projectionResults.set(runId, { ok: false, projected: false, reason: "projection-timeout" })
        return run ? run.status : "missing"
      }
      await delay(10)
    }
  }

  const runStage = async (params: {
    runId: string
    sessionId: string
    userText: string
    mode: string
    longMode: boolean
    story: Record<string, unknown> | null
    settings: Record<string, unknown>
    fairAuth: string
    targetChars: number
  }): Promise<StageRunResult> => {
    fairKeys.set(params.runId, params.fairAuth)
    const payload = {
      id: params.runId,
      sessionId: params.sessionId,
      mode: params.mode,
      text: params.userText,
      targetChars: params.targetChars,
      longMode: params.longMode,
      workspace: "chat",
      phase: "execute" as const,
      planText: "",
      story: params.story,
      attachments: []
    }
    // 先 buildConfig（快照进 kernelConfigs，保证 getConfig/幂等键就绪）
    await buildConfig(payload as unknown as Record<string, unknown>, params.settings, params.sessionId)
    projectionResults.delete(params.runId)
    await orchestration.handleChatStart(payload as never)
    // R23-R01：等待 terminal 状态落库且投影回调已执行（projectionResults 有记录），
    // 保证 runStage 返回时 canonical session 已含本 run 的 assistant 投影。
    const terminalStatus = await waitTerminalWithProjection(params.runId, 120000)
    // R25 CE5 收尾：等待超时（engine 悬挂，如端点挂起不响应）→ 主动 cancel 中止在途模型流，
    // 触发 provider attempt 的 settle/ledger 落账（aborted 转 spentUpper，不得孤儿悬挂），
    // 随后以最终 terminal（cancelled）如实判失败。
    let finalStatus = terminalStatus
    if (!TERMINAL_STATUSES.has(terminalStatus) && !isEvalDurablePause(terminalStatus)) {
      try {
        await engineCancelSafe(params.runId)
      } catch {
        /* cancel 失败按原超时状态返回 */
      }
      finalStatus = await waitTerminalWithProjection(params.runId, 8000)
    }
    // R24-P0-02：从真实 store 取回正文——多轮 run 按 turn_seq 拼接全部非空 assistant content
    //（与 CompletionController 的 measuredChars 同口径，与生产投影 composeRunAssistantContent 同函数）。
    // 禁止只取最后一轮（Codex P0-02：A+B+C=12000 完成时只留 C 会丢 8000 字）。
    const turns = repo.getTurnsByRun(params.runId)
    const composed = rt.composeRunAssistantContent(
      turns.map((t) => ({ role: t.role, content: t.content, reasoning_content: t.reasoning_content, turn_seq: t.turn_seq })) as never
    )
    const content = composed.content
    const proj = projectionResults.get(params.runId)
    const projectionOk = !!proj && proj.ok
    const projectionReason = proj && !proj.ok ? (proj.reason ?? "projection-failed") : (!proj ? "projection-not-recorded" : undefined)
    return {
      runId: params.runId,
      terminalStatus: finalStatus,
      content,
      reasoning: composed.reasoning,
      turnCount: composed.turnCount,
      turnChars: composed.turnChars,
      turnHashes: composed.turnHashes,
      projectionOk,
      projectionReason,
      errorCode: repo.getRun(params.runId)?.error_code ?? undefined
    }
  }

  const engineCancelSafe = (runId: string): Promise<void> => Promise.resolve(engine.cancel(runId)).catch(() => undefined)

  const prewriteGoldenHistory = (sessionId: string, goldenKey: string, turns: GoldenHistoryTurn[]): void => {
    // 幂等 upsert：固定 msg_id（goldenKey 区分样本），seq 从 1 递增，重复调用覆盖不重复
    let seq = 0
    for (const t of turns) {
      seq++
      repo.appendSessionMessage({
        msg_id: `m_golden_${goldenKey}_${seq}`,
        session_id: sessionId,
        seq,
        role: t.role,
        content: t.content,
        reasoning: "",
        status: "done",
        usage_json: "null",
        rounds: 0,
        tool_names_json: "[]",
        plan: null,
        created_at: Date.now()
      })
    }
  }

  return { rt, repo, kernelConfigs, fairKeys, evidencePaths, spy, runStage, prewriteGoldenHistory, close: () => repo.close() }
}

// ---------------- 主流程 ----------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    process.exit(0)
  }
  const isMock = args.includes("--mock")
  const isReal = args.includes("--real")
  if (isMock === isReal) {
    console.error("[eval-runner] 必须且只能指定一个模式：--mock 或 --real")
    process.exit(2)
  }
  const numArg = (flag: string, dflt: number): number => {
    const hit = args.find((a) => a.startsWith(`${flag}=`))
    const v = Number(hit?.split("=")[1] ?? dflt)
    return Number.isFinite(v) && v >= 0 ? (flag === "--repeats" || flag === "--scale" ? v : Math.floor(v)) : dflt
  }
  const strArg = (flag: string, dflt: string): string => args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1] ?? dflt
  const repeats = Math.max(1, Math.floor(numArg("--repeats", 1)))
  const taskFilter = strArg("--task", "")
  const model = strArg("--model", "deepseek-v4-flash")
  const scale = numArg("--scale", 1) || 1
  const outRoot = path.resolve(ROOT, strArg("--out-dir", "out"))
  const saveContent = args.includes("--save-content")
  // R20 公平性红测开关：让 generic 从第二轮起不携带 transcript（模拟失忆），
  // 用于验证等价 validator 能拒绝 + mock 能标 HISTORY-PAIRS 偏小 + exit 非 0。
  const probeHistoryGap = args.includes("--probe-history-gap")
  // R21 实验模式（缺省 controlled）
  const experimentRaw = strArg("--experiment", "controlled")
  if (!isExperimentMode(experimentRaw)) {
    console.error(`[eval-runner] 非法 --experiment：${experimentRaw}（应为 controlled | trajectory）`)
    process.exit(2)
  }
  const experiment: ExperimentMode = experimentRaw as ExperimentMode
  // R21 system-sensitive 本地端点（复现 system-sensitive 红场景，全程本地）
  const useSensitiveEndpoint = args.includes("--sensitive-endpoint")

  // R23-R05：请求/费用硬熔断（--max-requests / --max-cost-cny）。
  // R24-P0-03：严格解析——--max-requests 仅正整数；--max-cost-cny 有限正小数原样保留精度；
  // 0/负数/NaN/空值均显式报错退出，禁止静默变「无限制」（旧 numArg 的 Math.floor 会把 0.01 变 0）。
  const maxRequestsRaw = args.find((a) => a.startsWith("--max-requests="))?.split("=")[1]
  const maxCostCnyRaw = args.find((a) => a.startsWith("--max-cost-cny="))?.split("=")[1]
  const parseMaxRequests = (): number | null => {
    if (maxRequestsRaw === undefined) return null
    const v = Number(maxRequestsRaw)
    if (!Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
      console.error(`[eval-runner] --max-requests 必须是正整数（got ${JSON.stringify(maxRequestsRaw)}），禁止静默变无限制`)
      process.exit(2)
    }
    return Math.floor(v)
  }
  const parseMaxCostCny = (): number | null => {
    if (maxCostCnyRaw === undefined) return null
    const v = Number(maxCostCnyRaw)
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`[eval-runner] --max-cost-cny 必须是有限正数（got ${JSON.stringify(maxCostCnyRaw)}），禁止静默变无限制`)
      process.exit(2)
    }
    return v // 原样保留小数精度（不得 Math.floor）
  }
  const budget = {
    maxRequests: parseMaxRequests(),
    maxCostCny: parseMaxCostCny(),
    requestsUsed: 0,
    exhausted: false,
    reason: null as string | null
  }
  // R25-P0-01：--price-profile 显式指定价格 profile（反证/测试用可信临时 profile；缺省用仓库内参考 profile）
  const priceProfilePath = args.find((a) => a.startsWith("--price-profile="))?.split("=")[1]
  let priceProfile: PriceProfile | null = loadPriceProfile(priceProfilePath)

  // R21-R03 主代理接线：startedAt 在第一项样本工作前捕获（非执行结束伪造）
  const runStartedAtIso = new Date().toISOString()
  const runStartedAtMs = Date.now()

  // 真实模式 key 只查存在/不存在
  let apiKey = ""
  let apiKeyPresent = false
  if (isReal) {
    apiKey = process.env.DEEPSEEK_API_KEY ?? ""
    apiKeyPresent = apiKey.length > 0
    if (!apiKeyPresent) {
      console.log("[eval-runner] blocked: DEEPSEEK_API_KEY not set（real 模式拒绝联网、拒绝伪造）")
      console.log("[eval-runner] status=not_run reason=missing_api_key task=" + (taskFilter || "all") + " variants=" + VARIANT_IDS.join(","))
      process.exit(0)
    }
  }
  const endpoint = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"
  const sampling: SamplingParams = DEFAULT_SAMPLING

  // 加载任务集
  const tasksPath = path.join(ROOT, "scripts", "eval-tasks", "tasks.json")
  const taskSet = loadEvalTasks(tasksPath) as EvalTaskSet & { _baseDir: string; taskHash: string; materialsHash: string }
  const baseDir = taskSet._baseDir
  const tasks = taskFilter ? taskSet.tasks.filter((t) => t.id === taskFilter) : taskSet.tasks
  if (tasks.length === 0) {
    console.error(`[eval-runner] 未知任务 id: ${taskFilter}（可用：${taskSet.tasks.map((t) => t.id).join(" / ")}）`)
    process.exit(2)
  }

  // 加载 golden history（controlled 模式必需；trajectory 亦可加载用于写 header 作证据）
  const goldenPath = path.join(ROOT, "scripts", "eval-tasks", "golden-history.json")
  let goldenSet: GoldenHistorySet | null = null
  if (experiment === "controlled") {
    goldenSet = loadGoldenHistory(goldenPath)
    // 显式校验：controlled 模式下每个任务的每个 stageOrdinal(≥2) 都必须有 golden history
    for (const t of tasks) {
      const expanded = expandStagesLocal(t)
      for (let ord = 2; ord <= expanded.length; ord++) {
        if (goldenHistoryForOrdinal(goldenSet, t.id, ord).length === 0) {
          console.error(`[eval-runner] controlled 模式缺少 golden history：task=${t.id} stageOrdinal=${ord}`)
          process.exit(2)
        }
      }
    }
  }

  // 输出目录
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const runDir = path.join(outRoot, "eval", `run-${ts}`)
  const renpyDir = path.join(outRoot, "eval", `run-${ts}`, "renpy")
  await fsp.mkdir(renpyDir, { recursive: true })

  // seed：本次运行的随机种子字符串
  const seed = createHash("sha256").update(`${ts}-${taskFilter}-${repeats}-${scale}-${model}`).digest("hex")

  // commit / dirty（只读）
  let commit = "unknown"
  let dirty: string[] = []
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim()
    const status = execFileSync("git", ["status", "--short"], { cwd: ROOT, encoding: "utf-8" })
    dirty = status.split("\n").filter(Boolean).map((l) => l.trim())
  } catch {
    /* git 不可用则留空 */
  }

  // mock 模型（或 R21 system-sensitive 端点）
  let mock: { server: http.Server; port: number } | null = null
  if (isMock) mock = useSensitiveEndpoint ? await startSensitiveSse() : await startMockSse()
  const baseUrl = isMock ? `http://127.0.0.1:${mock?.port}` : endpoint

  // Production-like eval 也经过引擎费用边界；所有变体必须使用明确授权、精确绑定的同一价格快照。
  // 任一不匹配/缺 profile/hash → 第一条 fetch 前非零退出，不以仅请求数上限绕过未知价格。
  const endpointOrigin = new URL(baseUrl).origin
  let trustedPriceHash = strArg('--trust-price-profile-hash', '')
  let pricingProviderId = strArg('--pricing-provider-id', endpointOrigin === 'https://api.deepseek.com' ? 'deepseek' : '')
  if (isMock && !priceProfilePath) {
    priceProfile = createSyntheticEvalPriceProfile(endpointOrigin, model)
    trustedPriceHash = priceProfileHash(priceProfile)
    pricingProviderId = priceProfile.providerId
  }
  let frozenPricing: FrozenEvalPricing
  try {
    if (isReal && !priceProfilePath) throw new Error('Real eval requires an explicit price profile')
    frozenPricing = freezeEvalPricing({ profile: priceProfile, providerId: pricingProviderId, model, canonicalOrigin: endpointOrigin, currency: budget.maxCostCny != null ? 'CNY' : priceProfile?.currency ?? 'CNY', trustedProfileHash: trustedPriceHash })
  } catch {
    console.error('[eval-runner] 价格来源/授权hash/精确身份未通过，所有变体在fetch前拒绝（实收0）；需要显式 --price-profile、--trust-price-profile-hash 与 --pricing-provider-id')
    mock?.server.close()
    process.exit(2)
  }
  const priceTrust = matchPriceEntry(priceProfile, model, endpointOrigin, budget.maxCostCny != null ? "CNY" : undefined)
  if (budget.maxCostCny != null && !priceTrust.ok) {
    console.error(`[eval-runner] --max-cost-cny 需要可证明的计价身份，fetch 前拒绝（实收 0）：${priceTrust.reason}`)
    console.error(`[eval-runner] origin=${endpointOrigin} model=${model} profile=${priceProfile?.profileId ?? "none"}`)
    process.exit(2)
  }

  const settings = {
    model,
    baseUrl,
    apiKey: isMock ? "mock-key" : apiKey,
    maxTokens: sampling.maxTokens,
    temperature: sampling.temperature,
    topP: sampling.topP,
    thinkingEnabled: sampling.thinkingEnabled,
    reasoningEffort: "medium",
    workDir: path.join(runDir, "work"),
    docDir: path.join(runDir, "docs"),
    novelMode: false,
    galgame: { enabled: false, projectDir: "", sdkPath: "" },
    historyBudgetTokens: 60000
  }

  // R22-R01：统一编排 runtime（deepwriter 两变体评分+内容生成同源；generic 走 direct fetch）
  const unified = await createUnifiedOrchestration({ baseUrl, model, settings: settings as unknown as Record<string, unknown>, sampling, pricing: frozenPricing, maxCostCny: budget.maxCostCny, evidenceDir: runDir })
  settings.docDir = unified.evidencePaths.documentsDir

  // generic baseline 契约（只用于 contract；invoke 时按任务用公平凭证重建）
  const genericContractInstance = await buildGenericBaseline({ baseUrl, apiKey: settings.apiKey, model, sampling })
  const genericContract = genericContractInstance.contract

  // 计算三组 contract（探测；normal/specialized 用 unified.rt 的 executionSnapshot）
  const contracts = new Map<VariantId, VariantContract>()
  contracts.set("generic_baseline", genericContract)

  function probeDeepContract(variantId: VariantId, task: EvalTask, mode: string, longMode: boolean, story: Record<string, unknown> | null): VariantContract {
    const probeConfig = buildEvaluationSnapshot(unified.rt, {
      payload: { id: `probe_${variantId}_${task.id}`, mode, text: "", targetChars: Math.max(0, Math.round(task.targetChars * scale)), longMode, workspace: "chat", phase: "execute", planText: "", story, attachments: [] },
      settings,
      sessionId: "probe",
      memory: { projectPath: "", projectContent: "", userContent: "" },
      pricingSnapshots: [structuredClone(frozenPricing.record)]
    }, budget.maxCostCny)
    const sys = unified.rt.buildStaticSystemMessages(probeConfig)
    return {
      variantId,
      mode,
      longMode,
      systemMessages: sys.map((m) => ({ role: m.role, content: m.content })),
      sampling
    }
  }

  // 用第一个任务探测 normal/specialized 契约（三组契约不随任务变，仅随 variant 变——但 mode 随任务变）
  // 注意：normal 固定 agent；specialized 的 mode 随任务 category 变。因此 contract 需按 (task) 展示。
  // 我们按任务计算 specialized 契约，normal 契约对任一任务固定。
  const normalContract = probeDeepContract("deepwriter_current_product", tasks[0], "agent", false, null)
  contracts.set("deepwriter_current_product", normalContract)

  console.log(`DeepWriter Eval(${isMock ? "mock,synthetic" : "real"}): tasks=${tasks.map((t) => t.id).join(",")} repeats=${repeats} scale=${scale} model=${model}`)

  const samples: Sample[] = []
  const specializedContracts = new Map<string, VariantContract>() // taskId -> contract
  const MAX_ATTEMPTS = isMock ? 1 : 2
  // 全局请求序号（跨样本跨 variant 递增，供 RequestTrace.ordinal 与逐 ordinal 等价比对）
  let globalOrdinal = 0

  // ---------------- R22-R02 / Codex P0-02：provider 边界 request-attempt ledger ----------------
  // 记录点 = 最终 provider 请求边界（deepseek.ts 实际 fetch 前后 / generic fetch 前后）。
  // deepwriter 链经 globalThis.__evalStreamAttempt 兜底缝桥接（runKernelAdapter 不传 onAttempt 参数）。
  // 每个 attempt 由「当前上下文」闭包补齐 sample/variant/task/repeat/stage/runId/outerAttempt。
  const ledger: RequestAttempt[] = []
  let requestSeq = 0
  const currentAttemptCtx = {
    sampleId: "",
    variantId: "" as VariantId,
    taskId: "",
    repeat: 0,
    stageId: "",
    stageOrdinal: 0,
    runId: null as string | null,
    outerAttempt: 1
  }
  const mergeAttempt = (info: ProviderAttemptInfo): void => {
    requestSeq++
    const startedMs = Date.parse(info.startedAt)
    const finishedAt = Number.isFinite(startedMs) ? new Date(startedMs + (info.durationMs || 0)).toISOString() : info.startedAt
    ledger.push({
      requestId: `att-${requestSeq}`,
      sampleId: currentAttemptCtx.sampleId,
      variantId: currentAttemptCtx.variantId,
      taskId: currentAttemptCtx.taskId,
      repeat: currentAttemptCtx.repeat,
      stageId: currentAttemptCtx.stageId,
      stageOrdinal: currentAttemptCtx.stageOrdinal,
      runId: currentAttemptCtx.runId,
      outerAttempt: currentAttemptCtx.outerAttempt,
      innerAttempt: info.innerAttempt,
      startedAt: info.startedAt,
      finishedAt,
      durationMs: info.durationMs,
      outcome: info.outcome,
      httpStatus: info.httpStatus,
      usagePresent: info.usagePresent,
      usage: info.usage,
      actualMessageRoles: info.actualMessageRoles,
      actualUserHash: info.actualUserHash,
      actualHistoryHash: info.actualHistoryHash,
      actualSystemHash: info.actualSystemHash,
      actualAssembledHash: info.actualAssembledHash,
      actualMessageContentHashes: info.actualMessageContentHashes,
      actualHistoryTurnHashes: info.actualHistoryTurnHashes
    })
    // R24-P0-03：费用对账由 __evalPostRequest（usage 到达时）统一执行——此处不再重复累计。
  }
  ;(globalThis as unknown as { __evalStreamAttempt?: (info: ProviderAttemptInfo) => void }).__evalStreamAttempt = mergeAttempt

  // ==================== R25-P0-02：五字段费用账本（upper-bound 制） ====================
  // 语义：
  //   spentActualCny       —— 只累计「有可信 usage + 价格精确匹配」的实际成本；
  //   spentUpperCny        —— 实际成本 + 所有「已发出但 usage 未知」的保守 reservation（绝不按 0 释放）；
  //   inflightReservedCny  —— 尚未 settle 的在途预留；
  //   actualCostKnown      —— 是否所有已发请求都有可信 actual；
  //   hardCapProtected     —— 是否仍可证明 upper bound（契约违约/账本异常 → false → 立即阻断）。
  // fetch 前判定：spentUpper + inflight + nextReservation <= maxCostCny（R25 任务书口径）。
  // 失败（http/transport/abort/timeout）无 usage 一律把 reservation 转 spentUpper（保守），
  // 允许 cap 仍覆盖多个保守 reservation 时继续 retry；但绝不释放成 0。
  // 当前 runner 单线程顺序执行（无并发），reserve/settle 同步天然原子；若未来引入并发必须加互斥。
  const budgetRes = {
    spentActualCny: 0,
    spentUpperCny: 0,
    inflightReservedCny: 0,
    actualCostKnown: true as boolean,
    hardCapProtected: true as boolean
  }
  const MAX_RESERVATION_LOOKBACK = 8 // 未对账 reservation 上限（防御：漏调 post 钩子时不无限累积）
  const reservationStack: Array<{ token: string; reservedCny: number }> = []
  const estimateReservedCny = (bodyJson: string, reqModel: string, maxTokens: number): number => {
    // R25-P0-01/P1-01：cap 模式预检已保证 provider+origin+model+currency 精确匹配；
    // 保守 input 上界 = 完整 request body 的 UTF-8 字节数 + 明确 framing 常数（含 role/tool schema/JSON 转义）；
    // 保守 output 上界 = 请求 maxTokens。
    if (!priceTrust.ok) return Number.POSITIVE_INFINITY
    const entry = priceTrust.entry
    const { ceiling } = utf8BodyTokenCeiling(bodyJson)
    const outputTokens = Math.max(0, maxTokens)
    const inputCny = (ceiling * entry.inputPer1M) / 1_000_000
    const outputCny = (outputTokens * entry.outputPer1M) / 1_000_000
    return inputCny + outputCny
  }
  const preRequestGate = (bodyJson: string, reqModel: string, maxTokens: number): { blocked: boolean; reason?: string; reservedCny: number } => {
    if (budget.maxRequests != null && budget.requestsUsed >= budget.maxRequests) {
      budget.exhausted = true
      budget.reason = budget.reason ?? `max-requests=${budget.maxRequests} reached (${budget.requestsUsed} sent)`
      return { blocked: true, reason: budget.reason, reservedCny: 0 }
    }
    if (budget.maxCostCny == null) {
      // 无 cost cap：仅请求计数闸门（R25-P0-01 §5）；不产生 reservation
      budget.requestsUsed++
      return { blocked: false, reservedCny: 0 }
    }
    if (!budgetRes.hardCapProtected) {
      // 上界已不可证明（契约违约/账本异常）→ 立即阻断，不得继续请求或声称预算仍可信（R24 复审 §6 口径）
      budget.exhausted = true
      budget.reason = budget.reason ?? "hard-cap-no-longer-protected"
      return { blocked: true, reason: budget.reason, reservedCny: 0 }
    }
    const reserved = estimateReservedCny(bodyJson, reqModel, maxTokens)
    if (!Number.isFinite(reserved) || reserved < 0) {
      budget.exhausted = true
      budget.reason = budget.reason ?? "reservation-not-computable"
      return { blocked: true, reason: budget.reason, reservedCny: 0 }
    }
    if (budgetRes.spentUpperCny + budgetRes.inflightReservedCny + reserved > budget.maxCostCny) {
      budget.exhausted = true
      budget.reason = budget.reason ?? `max-cost-cny=${budget.maxCostCny} would be exceeded (spentUpper=${budgetRes.spentUpperCny.toFixed(6)} inflight=${budgetRes.inflightReservedCny.toFixed(6)} next=${reserved.toFixed(6)})`
      return { blocked: true, reason: budget.reason, reservedCny: 0 }
    }
    const token = `res-${reservationStack.length}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    reservationStack.push({ token, reservedCny: reserved })
    budgetRes.inflightReservedCny += reserved
    budget.requestsUsed++ // 本请求获准发送 → 计入已发数（usage 缺失不影响「已发」事实）
    if (reservationStack.length > MAX_RESERVATION_LOOKBACK) {
      // 防御：post 钩子应逐一对账，堆栈超长即视为账本异常 → 上界不可证明，fail-closed
      budgetRes.hardCapProtected = false
      budget.exhausted = true
      budget.reason = budget.reason ?? "reservation-lookback-exceeded"
      return { blocked: true, reason: budget.reason, reservedCny: 0 }
    }
    return { blocked: false, reservedCny: reserved }
  }
  const postRequestGate = (usage: Record<string, number | null> | null, reservedCny: number, outcome: "success" | "http_error" | "transport_error" | "aborted" | "budget_blocked"): void => {
    // 对账：释放本请求的 reservation（FIFO 取栈顶——单线程下栈顶即本请求；budget_blocked 无 reservation 不弹栈）
    const top = reservationStack.pop()
    if (top) budgetRes.inflightReservedCny = Math.max(0, budgetRes.inflightReservedCny - top.reservedCny)
    if (outcome === "budget_blocked") return
    const toUpper = (): void => {
      // R25-P0-02：任何已发但无可信 usage 的请求，reservation 一律转 spentUpper（保守），绝不按 0 释放
      if (top) budgetRes.spentUpperCny += top.reservedCny
      budgetRes.actualCostKnown = false
    }
    if (outcome !== "success") {
      // http_error / transport_error / aborted / timeout 且无 usage：同口径转 spentUpper（不得 0 元对账）
      toUpper()
      return
    }
    if (usage == null) {
      // 成功但 usage 缺失：reservation 转 spentUpper，actualCostKnown=false（cap 覆盖时可继续，绝不无限发）
      toUpper()
      return
    }
    const sc = priceTrust.ok ? computeSampleCost(usage as never, priceProfile, model) : "unknown"
    if (typeof sc !== "object" || sc === null || sc.actualKnown !== true || typeof sc.total !== "number") {
      // usage 存在但矛盾/不可推导/端点不可信 → 按保守 upper 对账
      toUpper()
      return
    }
    // R24 复审 §6 口径：actual 超过本请求预留（provider 违反 max_tokens/计费契约）→ 契约违约，
    // 上界不再可信：如实入账 + hardCapProtected=false + 立即熔断（不静默继续）。
    // 仅在本请求确有 reservation（cap 模式）时判定；无 cap 模式无预留可对比，不得误熔断。
    if (top && sc.total > top.reservedCny + 1e-9) {
      budgetRes.hardCapProtected = false
      budget.exhausted = true
      budget.reason = budget.reason ?? "contract-breach: actual exceeds reservation"
    }
    budgetRes.spentActualCny += sc.total
    budgetRes.spentUpperCny += sc.total
  }
  ;(globalThis as unknown as {
    __evalPreRequest?: (bodyJson: string, model: string, maxTokens: number) => { blocked: boolean; reason?: string; reservedCny: number }
  }).__evalPreRequest = preRequestGate
  ;(globalThis as unknown as {
    __evalPostRequest?: (usage: Record<string, number | null> | null, reservedCny: number, outcome: "success" | "http_error" | "transport_error" | "aborted" | "budget_blocked") => void
  }).__evalPostRequest = postRequestGate

  for (const task of tasks) {
    // specialized contract 按任务 category 计算
    const specStory = buildSpecializedStory(task, baseDir)
    const specializedContract = probeDeepContract("deepwriter_hardened_candidate", task, task.mode, task.longMode, specStory)
    specializedContracts.set(task.id, specializedContract)
    contracts.set("deepwriter_hardened_candidate", specializedContract)

    // 每任务一份公平凭证（mock 输出长度的唯一决定因子）；generic invoke 按任务重建以携带此凭证
    // R23-R04：公平凭证改 stage 级（mock 输出长度由 stage target 驱动；三组同 stage 同凭证）。
    // generic 链的 invoke 亦在 stage 循环内以 stage 凭证重建，保证三组长度口径一致。
    const stageFairAuthFor = (stageId: string, stageTargetUnscaled: number): string =>
      isMock ? mockFairAuth(`${task.id}:${stageId}`, stageTargetUnscaled, scale, seed) : settings.apiKey

    // 读取素材文本（validator 用）
    const rawMaterials: Record<string, string> = {}
    for (const m of task.materials) {
      rawMaterials[m] = fs.readFileSync(path.join(baseDir, m), "utf-8")
    }
    const expectMinChars: Record<string, number> = {}
    // expectMinChars 随 --scale 等比例缩放（与 targetChars 一致），floor=1
    for (const s of task.stages) if (s.expectMinChars !== undefined) expectMinChars[s.stageId] = Math.max(1, Math.round(s.expectMinChars * scale))

    for (const variantId of VARIANT_IDS) {
      for (let rep = 1; rep <= repeats; rep++) {
        const sample: Sample = {
          sampleId: `s-${task.id}-${variantId}-r${rep}`,
          taskId: task.id,
          variantId,
          repeat: rep,
          mode: isMock ? "mock" : "real",
          synthetic: isMock,
          model,
          seed,
          promptHash: "",
          variantContractHash: "",
          rounds: 0,
          stageResults: [],
          stageOutputs: [],
          content: "",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: null, raw: {} },
          metrics: { ttftMs: null, totalMs: 0, outputChars: 0, cjkChars: 0, finishReason: null, status: "ok", failures: 0, retries: 0 },
          validation: { validatorRef: task.validatorRef, passed: false, checks: [] },
          requestTraces: [],
          canonicalTranscript: [],
          fairnessFail: false,
          usageStatus: "missing",
          orchestrationTrace: null,
          runIds: [],
          terminalStatus: [],
          requestIds: [],
          eligibleForReview: false,
          failureReasons: []
        }
        sample.variantContractHash = contracts.get(variantId) ? variantContractHash(contracts.get(variantId)!) : ""

        const sampleStart = Date.now()
        let ttftMs: number | null = null
        let outputChars = 0
        let cjkChars = 0
        let lastFinishReason: string | null = null
        let failures = 0
        let retries = 0
        let sampleFailed = false
        const allRequestMessages: Array<{ role: string; content: string }> = []
        const stageResults: Sample["stageResults"] = []
        const stageOutputs: StageOutput[] = []
        const carry: Record<string, string> = {}
        // R20 公平性：本样本的 canonical transcript（user/assistant 对，跨三组同一驱动逻辑）
        const canonicalTranscript: TranscriptTurn[] = []

        // R24-P1-03：session 按 (stage, outer attempt) 隔离——失败 attempt 的 user/partial assistant
        // 投影留在其私有 session，不得污染下一 attempt/下一 stage；每个 attempt 播种
        // 「上一个成功 stage 的 canonical transcript」（trajectory）或 frozen golden history（controlled）。
        const sessionFor = (stageOrdinal: number, attempt: number): string =>
          `sess_eval_${task.id}_${variantId}_${rep}_s${stageOrdinal}_a${attempt}`
        const modeForVariant = variantId === "deepwriter_current_product" ? "agent" : task.mode
        const longModeForVariant = variantId === "deepwriter_current_product" ? false : task.longMode
        const storyForVariant = variantId === "deepwriter_current_product" ? null : buildSpecializedStory(task, baseDir)
        if (variantId !== "generic_baseline") {
          // 首 stage 首 attempt 的 session（供 runStage 幂等键与投影使用）
          unified.repo.createSession(sessionFor(1, 1), `${task.id}:${variantId}`, model)
        }

        // R20 公平性：本样本实际发往模型的 static system 消息（generic 固定中性单 system；
        //  deepwriter 由 src 组装，这里仅作 planning trace 元数据，等价断言读 ledger 不读此处）
        const staticSystem: Array<{ role: string; content: string }> =
          variantId === "generic_baseline"
            ? [{ role: "system", content: genericContract.systemMessages[0]?.content ?? "" }]
            : []

        // 展开 stages（处理 repeats）
        const expandedStages: Array<{ stage: EvalTask["stages"][number]; n: number }> = []
        for (const st of task.stages) {
          const repCount = st.repeats ?? 1
          for (let n = 1; n <= repCount; n++) expandedStages.push({ stage: st, n })
        }

        for (let stageIdx = 0; stageIdx < expandedStages.length; stageIdx++) {
          const { stage, n } = expandedStages[stageIdx]
          const stageOrdinal = stageIdx + 1 // 1-based stage 序号（对应 golden-history 的 stageOrdinal）
          // R24-P0-01：stage target 单一真源——只能来自 normalized stages[].targetChars（loader fail-closed）。
          // 删除 task-level/chapter fallback：缺失直接退出非零（禁止静默回退到 task 级 10000）。
          const stageTargetRaw = (stage as { targetChars?: number }).targetChars
          if (typeof stageTargetRaw !== "number" || !Number.isFinite(stageTargetRaw) || stageTargetRaw <= 0) {
            console.error(`[eval-runner] 任务 ${task.id} stage ${stage.stageId} 缺少合法 targetChars（${JSON.stringify(stageTargetRaw)}）——拒绝 fallback，exit 非 0`)
            process.exit(2)
          }
          const stageTargetUnscaled = stageTargetRaw
          const stageTarget = Math.max(1, Math.round(stageTargetUnscaled * scale))
          const targetCharsPerChapter = stage.stageId === "chapter" ? stageTargetUnscaled : 0
          const userMsg = renderTemplate(stage.template, { n, targetCharsPerChapter, carry, baseDir })
          const live = [{ role: "user", content: userMsg }]

          // ---- R21 实验语义：组装本 stage 的历史 ----
          // controlled：历史 = 预先冻结的 golden history（与 variant 无关），本 stage 输出不回灌。
          // trajectory：历史 = 本 variant 自有 canonicalTranscript（R20 自然回灌行为）。
          const historyTurns: Array<{ role: string; content: string }> =
            experiment === "controlled"
              ? goldenHistoryForOrdinal(goldenSet!, task.id, stageOrdinal).map((t) => ({ role: t.role, content: t.content }))
              : canonicalTranscript.map((t) => ({ role: t.role, content: t.content }))

          // ---- 组装本 stage 的 runId（R22-R01：每 stage 一个真实 runId；R23 反证 C7：
          //      deepwriter 的 runner 外层重试必须用新 runId——同 runId 会被 acceptChatStart
          //      幂等键拦截成 no-op，outer retry 将永不产生真实请求） ----
          const stageRunIdBase = `eval_${task.id}_${variantId}_r${rep}_s${stageOrdinal}`

          let genericSend: Array<{ role: string; content: string }>
          if (variantId === "generic_baseline") {
            const withHistory = !(probeHistoryGap && stageOrdinal > 1)
            genericSend = withHistory
              ? [...staticSystem, ...historyTurns, ...live]
              : [...staticSystem, ...live]
          } else {
            genericSend = [...live] // 占位（deepwriter 仅交 live，历史由 repository 回灌）
          }

          // planning 元数据 trace（等价断言改读 ledger，此处仅保留为审计层元数据）
          const traceMessages: Array<{ role: string; content: string }> =
            variantId === "generic_baseline"
              ? genericSend
              : [...staticSystem, ...historyTurns, ...live]

          const goldenTurn = experiment === "controlled" ? goldenTurnForStage(goldenSet!, task.id, stageOrdinal) : null

          const roundStart = Date.now()
          let roundOk = false
          let roundContent = ""
          let roundMockHistoryPairs: number | null = null
          // R23-R03：本 attempt 的结构化失败原因（roundOk 只能在此为 null 时置 true）
          let roundFailure: string | null = null
          let roundPaused = false
          // R24-P0-02：成功 stage 的多轮明细（供 stageOutputs 落盘；每 stage 重置）
          let lastTurnChars: number[] = []
          let lastTurnHashes: string[] = []

          // R23-R05：熔断已触发 → 立即停止后续 stage（不再发起任何 provider 请求）
          if (budget.exhausted) {
            sampleFailed = true
            sample.failureReasons.push(`s${stageOrdinal}: budget_exhausted(${budget.reason ?? "budget"})`)
            break
          }

          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            // R23 反证 C7：deepwriter 外层重试用「新 runId」——同 runId 会被 acceptChatStart
            // 幂等键（session_id+client_request_id）拦截成 no-op，outer retry 永远不产生真实请求。
            const attemptRunId = variantId === "generic_baseline" ? null : `${stageRunIdBase}_a${attempt}`
            // R24-P1-03：每 attempt 隔离 session（失败 attempt 的投影/user 写入留在私有 session 丢弃）
            const attemptSessionId = variantId === "generic_baseline" ? "" : sessionFor(stageOrdinal, attempt)
            // 设置当前 attempt 上下文（供 ledger mergeAttempt 补齐标识）
            currentAttemptCtx.sampleId = sample.sampleId
            currentAttemptCtx.variantId = variantId
            currentAttemptCtx.taskId = task.id
            currentAttemptCtx.repeat = rep
            currentAttemptCtx.stageId = stage.stageId
            currentAttemptCtx.stageOrdinal = stageOrdinal
            currentAttemptCtx.runId = attemptRunId
            currentAttemptCtx.outerAttempt = attempt

            // R24-P1-02：每个 outer attempt 开始时清零临时状态（禁止 partial stream 与重试成功正文拼接）
            roundContent = ""
            roundMockHistoryPairs = null
            roundFailure = null
            roundPaused = false

            try {
              if (variantId === "generic_baseline") {
                // R23-R04：generic 亦按 stage 凭证（长度口径与 deepwriter 同 stage 一致）
                const stageGeneric = await buildGenericBaseline({ baseUrl, apiKey: stageFairAuthFor(stage.stageId, stageTargetUnscaled), model, sampling, onAttempt: mergeAttempt })
                const iter = await stageGeneric.invoke(genericSend.slice(staticSystem.length))
                let firstText = true
                for await (const ev of iter) {
                  if (ev.type === "text" && ev.delta) {
                    if (ttftMs === null && firstText) { ttftMs = Date.now() - roundStart; firstText = false }
                    roundContent += ev.delta; outputChars += ev.delta.length; cjkChars += countCjk(ev.delta)
                  } else if (ev.type === "reasoning" && ev.delta) {
                    const m = /\[HISTORY-PAIRS:(\d+)\]/.exec(String(ev.delta))
                    if (m) roundMockHistoryPairs = Number(m[1])
                  } else if (ev.type === "finish") lastFinishReason = ev.finishReason
                }
                if (roundContent.length === 0) roundFailure = "empty-content"
                lastTurnChars = [roundContent.length]
                lastTurnHashes = [sha256(roundContent)]
              } else {
                // R22-R01：deepwriter 走真实编排（handleChatStart → engine → store 取正文）。
                // R24-P1-03：每 attempt 新 session 并播种历史——controlled 用 frozen golden；
                // trajectory 用「上一个成功 stage 的 canonical transcript」（不含本 stage 任何失败产物）。
                unified.repo.deleteSession(attemptSessionId)
                unified.repo.createSession(attemptSessionId, `${task.id}:${variantId}`, model)
                if (experiment === "controlled") {
                  unified.prewriteGoldenHistory(
                    attemptSessionId,
                    `${sample.sampleId}_o${stageOrdinal}_a${attempt}`,
                    goldenHistoryForOrdinal(goldenSet!, task.id, stageOrdinal)
                  )
                } else {
                  unified.prewriteGoldenHistory(
                    attemptSessionId,
                    `${sample.sampleId}_t${stageOrdinal}_a${attempt}`,
                    canonicalTranscript.map((t) => ({ role: t.role, content: t.content }))
                  )
                }
                const res = await unified.runStage({
                  runId: attemptRunId!,
                  sessionId: attemptSessionId,
                  userText: userMsg,
                  mode: modeForVariant,
                  longMode: longModeForVariant,
                  story: storyForVariant,
                  settings: settings as unknown as Record<string, unknown>,
                  fairAuth: stageFairAuthFor(stage.stageId, stageTargetUnscaled),
                  targetChars: stageTarget
                })
                roundContent = res.content
                outputChars += roundContent.length
                cjkChars += countCjk(roundContent)
                lastFinishReason = "stop"
                lastTurnChars = res.turnChars
                lastTurnHashes = res.turnHashes
                sample.runIds.push(res.runId)
                sample.terminalStatus.push(res.terminalStatus)
                // R23-R03：roundOk 只能在 terminal、正文、投影全部完成后置 true。
                // terminal 非 completed（含 failed/cancelled/partial）→ 本 attempt 失败，不得伪装成功。
                if (res.terminalStatus !== "completed") {
                  roundPaused = isEvalDurablePause(res.terminalStatus)
                  roundFailure = `terminal=${res.terminalStatus}${res.errorCode ? `;errorCode=${res.errorCode}` : ''}`
                } else if (roundContent.length === 0) {
                  roundFailure = "empty-content"
                } else if (!res.projectionOk) {
                  // R23-R01：投影失败必须阻断（Codex 根因 C——不得 console 后继续）
                  roundFailure = `projection:${res.projectionReason ?? "failed"}`
                }
              }
            } catch (err) {
              const stackLine = err instanceof Error && err.stack ? String(err.stack).split("\n").slice(0, 3).join(" < ") : ""
              roundFailure = `exception:${err instanceof Error ? err.message : String(err)} [${stackLine}]`
            }
            // R24-P1-02：所有失败（异常或非异常：terminal/empty/projection/exception）统一计 failures；
            // 只有确实将启动下一 outer attempt 才计 retries。roundOk 唯一置位点。
            if (roundFailure !== null) {
              failures++
              sample.failureReasons.push(`s${stageOrdinal}a${attempt}: ${roundFailure}`)
              if (attempt < MAX_ATTEMPTS && !roundPaused) { retries++; await delay(1000) }
            }
            roundOk = roundFailure === null
            if (roundOk || roundPaused) break
          }
          if (!roundOk) { sampleFailed = true; break }

          // 记录本次请求的 planning trace（元数据；等价断言读 ledger）
          globalOrdinal++
          const trace: RequestTrace = {
            ordinal: globalOrdinal,
            sampleId: sample.sampleId,
            variantId: sample.variantId,
            stageId: stage.stageId,
            roles: traceMessages.map((m) => m.role),
            userHash: roleHash(traceMessages, "user"),
            assistantHash: roleHash(traceMessages, "assistant"),
            historyCount: countHistoryPairs(traceMessages),
            systemHash: systemHash(traceMessages),
            assembledHash: assembledHash(traceMessages)
          }
          if (experiment === "controlled") {
            trace.goldenHistoryHash = goldenHistoryHash(historyTurns.map((t) => ({ role: t.role as "user" | "assistant", content: t.content })))
          }
          if (roundMockHistoryPairs !== null) trace.mockHistoryPairs = roundMockHistoryPairs
          sample.requestTraces.push(trace)
          allRequestMessages.push(...live)

          stageResults.push({ stageId: stage.stageId, chars: roundContent.length, valid: roundContent.length >= (expectMinChars[stage.stageId] ?? (stage.expectMinChars ?? 0)) })
          // R23-R02：每 stage 产出落 contentSha256（validator 逐序验证 trajectory 历史接力）
          // R24-P0-02：多轮 completion 明细一并落（turnChars/turnHashes——validator 复核完整正文，只留最后一轮必红）
          stageOutputs.push({
            stageId: stage.stageId,
            content: roundContent,
            chars: roundContent.length,
            contentSha256: sha256(roundContent),
            turnChars: lastTurnChars,
            turnHashes: lastTurnHashes,
            // R25-P1-03：声明/执行/mock 三栏分落（validator 从 tasks loader + manifest.scale + mock 规则独立重算）
            declaredTargetChars: stageTargetUnscaled,
            executionTargetChars: stageTarget,
            mockFairLength: isMock ? Math.max(200, Math.min(stageTarget, 1600)) : null,
            expectMinCharsExecution: stage.expectMinChars !== undefined ? Math.max(1, Math.round(stage.expectMinChars * scale)) : null
          })
          carry[stage.stageId] = roundContent

          // R21 写回语义（canonicalTranscript 仅作审计元数据；公平性读 ledger）
          if (experiment === "controlled") {
            const gUser = goldenTurn?.user?.content ?? userMsg
            const gAsst = goldenTurn?.assistant?.content ?? roundContent
            canonicalTranscript.push({ role: "user", content: gUser, chars: gUser.length, sha256: sha256(gUser) })
            canonicalTranscript.push({ role: "assistant", content: gAsst, chars: gAsst.length, sha256: sha256(gAsst) })
          } else {
            canonicalTranscript.push({ role: "user", content: userMsg, chars: userMsg.length, sha256: sha256(userMsg) })
            canonicalTranscript.push({ role: "assistant", content: roundContent, chars: roundContent.length, sha256: sha256(roundContent) })
          }
        }

        sample.rounds = stageResults.length
        sample.stageResults = stageResults
        sample.stageOutputs = stageOutputs
        sample.canonicalTranscript = canonicalTranscript
        // usage / usageStatus 从 ledger（provider 边界实测）派生；绝不写 0（无 usage → missing）
        const sampleAttempts = ledger.filter((a) => a.sampleId === sample.sampleId)
        sample.requestIds = sampleAttempts.map((a) => a.requestId)
        const successAttempts = sampleAttempts.filter((a) => a.usagePresent && a.usage != null)
        const hasUsage = successAttempts.length > 0
        sample.usageStatus = hasUsage ? "present" : "missing"
        let lp = 0, lo = 0, lh = 0, lm: number | null = null
        for (const a of successAttempts) {
          const u = a.usage!
          lp += u.prompt_tokens ?? 0
          lo += u.completion_tokens ?? 0
          lh += u.prompt_cache_hit_tokens ?? 0
          const miss = u.prompt_cache_miss_tokens ?? null
          if (miss != null) lm = (lm ?? 0) + miss
        }
        sample.promptHash = createHash("sha256").update(JSON.stringify(allRequestMessages)).digest("hex")
        sample.content = stageOutputs.map((s) => s.content).join("\n\n")
        sample.usage = {
          promptTokens: lp, completionTokens: lo, totalTokens: lp + lo,
          cacheHitTokens: lh, cacheMissTokens: lm, raw: {}
        }
        // outputChars/cjkChars 已在每 stage 累计（deepwriter 从 store 正文，generic 从流）
        sample.metrics = {
          ttftMs, totalMs: Date.now() - sampleStart, outputChars, cjkChars,
          finishReason: lastFinishReason, status: sampleFailed ? "failed" : "ok", failures, retries
        }
        // runtime 复用证据：本样本 handleChatStart 命中计数（同一 runtime spy）
        sample.orchestrationTrace = variantId === "generic_baseline" ? null : unified.spy.snapshot()

        // 校验
        const ctx = { taskId: task.id, targetChars: Math.round(task.targetChars * scale), stages: stageOutputs, rawMaterials, expectMinChars }
        sample.validation = runValidator(task.validatorRef, ctx)

        // R23-R03：eligibleForReview = status ok + validation 过 + deepwriter 最终 terminal 为 completed。
        // （terminalStatus 按 attempt 顺序记录：retry-success 样本含失败的中间 attempt，合法；
        //   最终态非 completed → 不得进盲评。partial/failed 正文只作诊断证据。）
        const finalTerminal = sample.terminalStatus.length > 0 ? sample.terminalStatus[sample.terminalStatus.length - 1] : "missing"
        const terminalAllCompleted = variantId === "generic_baseline" || finalTerminal === "completed"
        sample.eligibleForReview = sample.metrics.status === "ok" && sample.validation.passed && terminalAllCompleted

        // renpy 产物落盘
        if (task.category === "renpy" && variantId !== "generic_baseline") {
          const gen = stageOutputs.find((s) => s.stageId === "generate" || s.stageId === "scene")
          if (gen) await fsp.writeFile(path.join(renpyDir, `${task.id}-${variantId}-r${rep}.rpy`), gen.content, "utf-8")
        }

        samples.push(sample)
        const mark = sample.metrics.status === "ok" && sample.validation.passed ? "ok" : (sample.metrics.status === "ok" ? "VALFAIL" : "FAIL")
        console.log(`  ${task.id}/${variantId}#${rep} ${mark}: chars=${outputChars} rounds=${sample.rounds} ttft=${ttftMs ?? "—"}ms val=${sample.validation.passed ? "ok" : "fail"}`)
      }
    }
  }

  // 落正文：mock 始终落；real 仅 --save-content
  for (const s of samples) {
    if (!isMock && !saveContent) s.content = ""
  }

  // ---------------- R22-R03 公平性：基于 ledger 实际 messages ----------------
  // 删除推测式 requestTraces 作为权威证据：inputEquivalence（controlled）与 lineageValid（trajectory）
  // 的 userHash/historyHash/systemHash 断言一律读 ledger 的 actualUserHash/actualHistoryHash/actualSystemHash。
  // 同 task/stage/repeat 三组 actualUserHash/actualHistoryHash 等价（controlled）；systemHash 允许不同。
  interface InputEquivalence {
    equal: boolean
    userEqual: boolean
    historyEqual: boolean
    /** systemHash 允许不同的 explicit 记录（唯一允许差异） */
    systemDiffOrdinals: number[]
    diffOrdinals: number[]
    diffDetail: string[]
  }
  interface Lineage {
    valid: boolean
    sameStart: boolean
    sameProtocol: boolean
    sameSampling: boolean
    structuralIntegrity: boolean
    forked: boolean
    diffDetail: string[]
  }

  // 每 (sampleId, stageOrdinal) 取第一条 attempt 作公平性代表（内容跨 retry 不变，任何一条等价）
  const ledgerRep = new Map<string, RequestAttempt>()
  for (const a of ledger) {
    const key = `${a.sampleId}|${a.stageOrdinal}`
    if (!ledgerRep.has(key)) ledgerRep.set(key, a)
  }
  const ledgerHashFor = (sampleId: string, stageOrdinal: number): { user: string; history: string; system: string } | null => {
    const a = ledgerRep.get(`${sampleId}|${stageOrdinal}`)
    return a ? { user: a.actualUserHash, history: a.actualHistoryHash, system: a.actualSystemHash } : null
  }

  const inputEquivalenceByTask = new Map<string, InputEquivalence>()
  const lineageByTask = new Map<string, Lineage>()
  const unfairSamples = new Set<string>()
  const expectedStageCount = new Map<string, number>()
  for (const task of tasks) expectedStageCount.set(task.id, expandStagesLocal(task).length)

  for (const task of tasks) {
    const taskSamples = samples.filter((s) => s.taskId === task.id)
    const reps = new Set(taskSamples.map((s) => s.repeat))
    const diffDetail: string[] = []
    const diffOrdinals: number[] = []
    const systemDiffOrdinals: number[] = []
    let userEqualAll = true
    let historyEqualAll = true
    let sameStartAll = true
    let sameProtocolAll = true
    let structuralAll = true
    let forked = false

    for (const rep of [...reps].sort((a, b) => a - b)) {
      const byVariant = new Map<VariantId, Sample>()
      for (const vid of VARIANT_IDS) {
        const s = taskSamples.find((x) => x.variantId === vid && x.repeat === rep)
        if (s) byVariant.set(vid, s)
      }
      const gen = byVariant.get("generic_baseline")
      const nrm = byVariant.get("deepwriter_current_product")
      const spc = byVariant.get("deepwriter_hardened_candidate")
      if (!gen || !nrm || !spc) continue
      const markUnfair = (detail: string): void => {
        unfairSamples.add(gen.sampleId); unfairSamples.add(nrm.sampleId); unfairSamples.add(spc.sampleId)
        diffDetail.push(detail)
      }

      const expCount = expectedStageCount.get(task.id) ?? 0
      // 阶段数一致（用 ledger 的代表 attempt 计数 = requestTraces 阶段数）
      const stageCount = (s: Sample) => new Set(ledger.filter((a) => a.sampleId === s.sampleId).map((a) => a.stageOrdinal)).size
      const cntG = stageCount(gen), cntN = stageCount(nrm), cntC = stageCount(spc)
      if (cntG !== cntN || cntG !== cntC) {
        markUnfair(`rep=${rep} 阶段数不一致 generic=${cntG} normal=${cntN} specialized=${cntC}`)
        structuralAll = false
      }
      if (cntG !== expCount || cntN !== expCount || cntC !== expCount) structuralAll = false

      // 逐 stageOrdinal 比对（公平性读 ledger actual*）
      const K = Math.min(cntG, cntN, cntC, expCount)
      for (let ord = 1; ord <= K; ord++) {
        const hg = ledgerHashFor(gen.sampleId, ord)
        const hn = ledgerHashFor(nrm.sampleId, ord)
        const hc = ledgerHashFor(spc.sampleId, ord)
        if (!hg || !hn || !hc) {
          markUnfair(`rep=${rep} ordinal=${ord} 缺 ledger attempt（generic=${!!hg}/normal=${!!hn}/specialized=${!!hc}）`)
          structuralAll = false
          continue
        }
        const userEq = hg.user === hn.user && hg.user === hc.user
        const histEq = hg.history === hn.history && hg.history === hc.history
        const sysEq = hg.system === hn.system && hg.system === hc.system

        if (!userEq) {
          userEqualAll = false
          diffOrdinals.push(ord)
          markUnfair(`ordinal=${ord} actualUserHash 不等价 (generic/normal/specialized=${hg.user.slice(0,8)}/${hn.user.slice(0,8)}/${hc.user.slice(0,8)})`)
        }
        if (!histEq) {
          historyEqualAll = false
          diffOrdinals.push(ord)
          // controlled：历史必须冻结等价，不等价即不公平；
          // trajectory：各变体历史自然发散（generic 与 deepwriter 产出不同正文），只记录、不判不公平（lineage 才是 trajectory 的公平准则）。
          if (experiment === "controlled") {
            markUnfair(`ordinal=${ord} actualHistoryHash 不等价 (generic/normal/specialized=${hg.history.slice(0,8)}/${hn.history.slice(0,8)}/${hc.history.slice(0,8)})`)
          } else {
            diffDetail.push(`ordinal=${ord} actualHistoryHash 不等价 (generic/normal/specialized=${hg.history.slice(0,8)}/${hn.history.slice(0,8)}/${hc.history.slice(0,8)})（trajectory 自然发散，不判不公平）`)
          }
        }
        // systemHash 允许不同（被测变量），显式列出差异 ordinal
        if (!sysEq) systemDiffOrdinals.push(ord)

        // lineage 第 1 阶段同起点（actualUserHash 等价）
        if (ord === 1 && !userEq) {
          sameStartAll = false
          markUnfair(`rep=${rep} 第 1 阶段 actualUserHash 不等价（lineage 同起点失败）`)
        }
      }

      // lineage：sampleId/rounds 结构完整（无串线）
      for (const s of [gen, nrm, spc]) {
        if (s.rounds !== expCount) {
          structuralAll = false
          diffDetail.push(`${s.sampleId} rounds=${s.rounds}（应=${expCount}）`)
        }
        if (!s.sampleId.startsWith(`s-${task.id}-`) || !s.sampleId.endsWith(`-r${rep}`)) {
          structuralAll = false
          diffDetail.push(`sampleId 串线：${s.sampleId}`)
        }
      }
    }

    // sampling 参数同协议（三组共享 DEFAULT_SAMPLING，固化断言）
    const specSamples = [...specializedContracts.values()]
    const samplingConsistent =
      !!contracts.get("generic_baseline")?.sampling &&
      JSON.stringify(contracts.get("generic_baseline")!.sampling) === JSON.stringify(normalContract.sampling) &&
      (specSamples.length === 0 || JSON.stringify(normalContract.sampling) === JSON.stringify(specSamples[0].sampling))

    const inputEq: InputEquivalence = {
      equal: userEqualAll && historyEqualAll,
      userEqual: userEqualAll,
      historyEqual: historyEqualAll,
      systemDiffOrdinals: [...new Set(systemDiffOrdinals)].sort((a, b) => a - b),
      diffOrdinals: [...new Set(diffOrdinals)].sort((a, b) => a - b),
      diffDetail
    }
    inputEquivalenceByTask.set(task.id, inputEq)

    const lineage: Lineage = {
      valid: sameStartAll && sameProtocolAll && samplingConsistent && structuralAll,
      sameStart: sameStartAll,
      sameProtocol: sameProtocolAll,
      sameSampling: samplingConsistent,
      structuralIntegrity: structuralAll,
      forked,
      diffDetail: [...diffDetail]
    }
    lineageByTask.set(task.id, lineage)
  }

  // 打 fairnessFail 标记
  for (const s of samples) {
    if (unfairSamples.has(s.sampleId)) s.fairnessFail = true
  }

  const anyFairnessFail =
    experiment === "controlled"
      ? [...inputEquivalenceByTask.values()].some((eq) => !eq.equal)
      : [...lineageByTask.values()].some((l) => !l.valid)

  const fairness = {
    experimentMode: experiment,
    inputEquivalence: Object.fromEntries([...inputEquivalenceByTask.entries()].map(([tid, eq]) => [tid, eq])),
    lineageValid: Object.fromEntries([...lineageByTask.entries()].map(([tid, l]) => [tid, l])),
    anyFairnessFail,
    probeHistoryGap
  }

  // ---------------- 输出 samples.json + manifest.json ----------------

  const header = {
    schemaVersion: 1,
    mode: isMock ? "mock" : "real",
    experimentMode: experiment,
    goldenHistory: experiment === "controlled" ? { path: "scripts/eval-tasks/golden-history.json", synthetic: true } : undefined,
    sensitiveEndpoint: isMock ? useSensitiveEndpoint : false,
    model,
    seed,
    repeats,
    scale,
    tasks: tasks.map((t) => t.id),
    taskSchemaHash: taskSet.taskHash,
    generatedAt: new Date().toISOString(),
    note: isMock ? "synthetic：本地确定性 mock，仅验证管道，不得用于产品宣传" : "real：真实 API 采样；key 与完整响应原文不落盘（正文仅 --save-content 时落）"
  }
  await fsp.writeFile(path.join(runDir, "samples.json"), JSON.stringify({ schemaVersion: 1, header, fairness, samples }, null, 2), "utf-8")

  const runnerSource = fs.readFileSync(path.join(ROOT, "scripts", "eval-runner.ts"), "utf-8")
  const variantsSource = fs.readFileSync(path.join(ROOT, "scripts", "eval-variants.ts"), "utf-8")
  const runnerSourceHash = createHash("sha256").update(runnerSource + "\u0000" + variantsSource).digest("hex")

  // ---------------- variants.json：三组 variant 的证据（红灯1 直接断言） ----------------
  // path：generic_baseline 写死 "direct-fetch"（证明它走直接 fetch，0 src/main import）；
  //       deepwriter_current_product / deepwriter_hardened_candidate 写 "deepwriter-chain"（走执行快照+上下文+适配器链）。
  // systemMessagePreviewChars：取所有 system 消息的字符总数（非内容泄露，只落字数用于审计）。
  const sysCharCount = (contract: VariantContract): number => contract.systemMessages.reduce((a, m) => a + (m.content ?? "").length, 0)
  const variantEntries: Array<{ variantId: string; path: string; invokePath: string | null; contractHash: string; systemMessageCount: number; systemMessagePreviewChars: number }> = []
  variantEntries.push({
    variantId: "generic_baseline",
    path: "direct-fetch",
    invokePath: null,
    contractHash: variantContractHash(contracts.get("generic_baseline")!),
    systemMessageCount: contracts.get("generic_baseline")!.systemMessages.length,
    systemMessagePreviewChars: sysCharCount(contracts.get("generic_baseline")!)
  })
  variantEntries.push({
    variantId: "deepwriter_current_product",
    path: "deepwriter-chain",
    invokePath: `${ORCHESTRATION_MODULE}::${ORCHESTRATION_FN}`,
    contractHash: variantContractHash(normalContract),
    systemMessageCount: normalContract.systemMessages.length,
    systemMessagePreviewChars: sysCharCount(normalContract)
  })
  // specialized 按任务有多个契约（mode/story 不同）；逐一列出，供红灯1 两两比对
  for (const [tid, c] of specializedContracts.entries()) {
    variantEntries.push({
      variantId: `deepwriter_hardened_candidate:${tid}`,
      path: "deepwriter-chain",
      invokePath: `${ORCHESTRATION_MODULE}::${ORCHESTRATION_FN}`,
      contractHash: variantContractHash(c),
      systemMessageCount: c.systemMessages.length,
      systemMessagePreviewChars: sysCharCount(c)
    })
  }
  await fsp.writeFile(
    path.join(runDir, "variants.json"),
    JSON.stringify({ schemaVersion: 1, variants: variantEntries }, null, 2),
    "utf-8"
  )

  // ---------------- R22-R03 主代理接线：manifest 事实字段（统一口径，finishedAt=全部非 manifest 产物落盘后） ----------------
  // ledger 独立落盘 ledger.json（绝不落 key/正文）；ledgerSha256 = 规范序列 sha256
  const ledgerJson = JSON.stringify({ schemaVersion: 1, ledger }, null, 2)
  await fsp.writeFile(path.join(runDir, "ledger.json"), ledgerJson, "utf-8")
  const ledgerSha256 = createHash("sha256").update(canonicalLedger(ledger)).digest("hex")

  const samplesBytes = await fsp.readFile(path.join(runDir, "samples.json"))
  const variantsBytes = await fsp.readFile(path.join(runDir, "variants.json"))
  const allTraces = samples.flatMap((s) => s.requestTraces ?? [])
  const usagePresent = samples.filter((s) => s.usageStatus === "present").length
  const usageMissing = samples.filter((s) => s.usageStatus === "missing").length
  const plannedTotal = tasks.reduce((a, t) => a + expandStages(t).length, 0) * VARIANT_IDS.length * repeats
  const okCount = samples.filter((s) => s.metrics.status === "ok").length
  const failedCount = samples.filter((s) => s.metrics.status === "failed").length
  const valPassed = samples.filter((s) => s.validation.passed).length
  const finishedAtIso = new Date().toISOString()
  // R22-R02：ledger 全量计数（含失败尝试）
  const actualRequests = ledger.length
  // R23-R06：outerRetries 按唯一 (sampleId, stageOrdinal, outerAttempt>1) 计数——
  // 同一 outer attempt 内发生多个 inner attempt 时不得重复计（Codex P1-02）。
  const outerRetryKeys = new Set(ledger.filter((a) => a.outerAttempt > 1).map((a) => `${a.sampleId}|${a.stageOrdinal}|${a.outerAttempt}`))
  const outerRetries = outerRetryKeys.size
  // R22 主代理对账：provider 边界 ledger 与本地端点实收数三方核对（actualRequests == ledger.length == 实收数）。
  // 任何一条请求到达端点却没进 ledger（或反之）→ accountingBroken → exit 非 0（防请求账本少计/多计）。
  const endpointReceived = isMock && mock ? mock.getReceivedCount() : null
  const accountingBroken = isMock && endpointReceived !== null && endpointReceived !== ledger.length
  if (accountingBroken) {
    console.error(`[eval-runner] 请求账本与端点实收不一致：ledger.length=${ledger.length} 端点实收=${endpointReceived}（差额=${endpointReceived! - ledger.length}）`)
  }
  // R22 主代理对账：内层 attempt 序号由 provider 边界回调实测（deepseek.ts / generic 直连均回调），
  // 所有 attempt 均带 innerAttempt>=1 时才算「观测到」；否则 innerRetries=null（禁止用 0 冒充未观测）。
  const innerRetriesObserved = ledger.length > 0 && ledger.every((a) => typeof a.innerAttempt === "number" && (a.innerAttempt as number) >= 1)
  const innerRetries: number | null = innerRetriesObserved
    ? ledger.reduce((acc, a) => acc + ((a.innerAttempt as number) - 1), 0)
    : null
  const manifest = {
    schemaVersion: 1,
    experimentMode: experiment,
    commit,
    dirty,
    node: process.version,
    electron: process.versions.electron ?? "n/a",
    platform: process.platform,
    taskSchemaHash: taskSet.taskHash,
    materialsHash: taskSet.materialsHash,
    // R25-P1-03：目标字数缩放系数（validator 独立重算 declared/execution/mockFairLength 三栏的事实输入）
    scale,
    // R25-P0-03：计价身份与预算事实（真实 manifest 强制记录；validator real+cap 模式强制校验）
    providerId: priceTrust.ok ? priceTrust.providerId : priceProfile?.providerId ?? null,
    endpointOrigin,
    model,
    priceProfileId: priceProfile?.profileId ?? null,
    priceProfileHash: priceProfile ? priceProfileHash(priceProfile) : null,
    priceProfileCurrency: priceProfile?.currency ?? null,
    priceProfileTrustedForEndpoint: priceTrust.ok,
    frozenPricing: { ...frozenPricing.provenance, priceSnapshotId: frozenPricing.record.id, priceSnapshotHash: frozenPricing.record.priceProfileHash, source: frozenPricing.record.source },
    hostDelivery: { publisher: 'publishCliManuscript', ...unified.evidencePaths },
    spentActualCny: Number(budgetRes.spentActualCny.toFixed(6)),
    spentUpperCny: Number(budgetRes.spentUpperCny.toFixed(6)),
    inflightReservedCny: Number(budgetRes.inflightReservedCny.toFixed(6)),
    actualCostKnown: budgetRes.actualCostKnown,
    hardCapProtected: budgetRes.hardCapProtected,
    exhausted: budget.exhausted,
    reason: budget.reason,
    // R24-P0-01：逐 stage target 单一真源的执行证据——展开后的 stage target 序列 + 规范化 hash
    //（validator 加载 tasks.json 重算比对；改任一 stage target 或删字段 → hash 必变/loader fail-closed）
    stageTargets: (() => {
      const seq: Array<{ taskId: string; stageId: string; targetChars: number }> = []
      for (const t of tasks) {
        for (const st of t.stages) {
          const n = st.repeats ?? 1
          for (let i = 0; i < n; i++) seq.push({ taskId: t.id, stageId: st.stageId, targetChars: st.targetChars })
        }
      }
      return seq
    })(),
    stageTargetsHash: stageTargetsHash(tasks),
    goldenHistoryHash: goldenSet ? sha256(JSON.stringify(goldenSet.tasks)) : null,
    variantContractHash: {
      generic_baseline: variantContractHash(contracts.get("generic_baseline")!),
      deepwriter_current_product: variantContractHash(normalContract),
      deepwriter_hardened_candidate: Object.fromEntries([...specializedContracts.entries()].map(([k, v]) => [k, variantContractHash(v)]))
    },
    runnerSourceHash,
    seed,
    argv: process.argv.slice(2),
    synthetic: isMock,
    startedAt: runStartedAtIso,
    finishedAt: finishedAtIso,
    durationMs: Date.now() - runStartedAtMs,
    plannedRequests: plannedTotal,
    actualRequests,
    outerRetries,
    innerRetries,
    innerRetriesObserved,
    ledgerSha256,
    requestIdCount: ledger.length,
    // R22 主代理对账：本地端点实收请求数（仅 mock 有端点；real 为 null）。
    // R23-R06：real 模式无端点可观测 → ledgerMatchesEndpoint=null（not_checked），禁止虚报 matched=true。
    localEndpointReceived: endpointReceived,
    ledgerMatchesEndpoint: isMock ? !accountingBroken : null,
    usageCoverage: { present: usagePresent, missing: usageMissing, total: samples.length },
    requestTraceHash: createHash("sha256").update(canonicalTraceSequence(allTraces)).digest("hex"),
    // R22 主代理对账：显式期望集合落 manifest（validator 的 pairing check 据此比对，禁止从样本反推）
    expected: {
      variants: [...VARIANT_IDS],
      repeats,
      tasks: tasks.map((t) => ({
        taskId: t.id,
        stages: expandStages(t).length,
        expectedSamples: VARIANT_IDS.length * repeats
      }))
    },
    artifactHashes: {
      samplesSha256: createHash("sha256").update(samplesBytes).digest("hex"),
      variantsSha256: createHash("sha256").update(variantsBytes).digest("hex")
    },
    sampleCounts: { total: samples.length, success: okCount, failed: failedCount, validationPassed: valPassed, validationFailed: samples.length - valPassed },
    // R23-R05/R24-P0-03/R25-P0-02：请求/费用熔断账本（上限、实际使用、upper 对账、五字段事实）
    budget: {
      maxRequests: budget.maxRequests,
      maxCostCny: budget.maxCostCny,
      requestsUsed: budget.requestsUsed,
      spentActualCny: Number(budgetRes.spentActualCny.toFixed(6)),
      spentUpperCny: Number(budgetRes.spentUpperCny.toFixed(6)),
      inflightReservedCny: Number(budgetRes.inflightReservedCny.toFixed(6)),
      actualCostKnown: budgetRes.actualCostKnown,
      hardCapProtected: budgetRes.hardCapProtected,
      exhausted: budget.exhausted,
      reason: budget.reason,
      // R25-P1-01：input ceiling 口径（无官方 tokenizer：utf8-body-bytes + 明确 framing 常数）
      inputCeiling: {
        mode: "utf8-body-bytes+framing",
        framingBaseTokens: FRAMING_TOKENS_BASE,
        framingPerMessageTokens: FRAMING_TOKENS_PER_MESSAGE
      }
    }
  }
  await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8")

  // ---------------- 打印三组契约 hash 与差异 ----------------

  console.log("\n===== variantContractHash（三组） =====")
  console.log(`  generic_baseline      : ${variantContractHash(contracts.get("generic_baseline")!)}`)
  console.log(`  deepwriter_current_product     : ${variantContractHash(normalContract)}`)
  for (const [tid, c] of specializedContracts.entries()) {
    console.log(`  deepwriter_hardened_candidate[${tid}] : ${variantContractHash(c)}`)
  }
  // 差异报告（红灯 1 观察点）
  const normalHash = variantContractHash(normalContract)
  const sameAsNormal = [...specializedContracts.values()].filter((c) => variantContractHash(c) === normalHash)
  if (sameAsNormal.length > 0) {
    console.log(`\n[红灯1观察点] deepwriter_hardened_candidate 在以下任务与 normal 的 system 契约完全相同（hash 一致）：`)
    for (const [tid, c] of specializedContracts.entries()) {
      if (variantContractHash(c) === normalHash) console.log(`  - ${tid}`)
    }
    console.log("  提示：若某类别下 normal(agent) 与 specialized(垂类) 组出的 system messages 一字不差，需在回执中如实报告。")
  } else {
    console.log(`\n[OK] deepwriter_hardened_candidate 各任务契约与 normal 均不同（normal 固定 agent）。`)
  }
  const scs = [...specializedContracts.values()]
  const allSame = scs.length > 1 && scs.every((c) => variantContractHash(c) === variantContractHash(scs[0]))
  if (allSame) {
    console.log("  [注意] specialized 各任务之间的 contract 也相同（说明垂类 system prompt 未随 category 变化），请核查 mode 映射。")
  }

  // ---------------- 汇总 ----------------

  const okSamples = samples.filter((s) => s.metrics.status === "ok")
  const valPass = samples.filter((s) => s.validation.passed)
  console.log(`\n===== 汇总 =====`)
  console.log(`  样本总数 ${samples.length}；成功 ${okSamples.length}；校验通过 ${valPass.length}`)
  console.log(`  已写入 ${path.join(runDir, "samples.json")}`)
  console.log(`  已写入 ${path.join(runDir, "manifest.json")}`)

  console.log(`\n===== ${experiment === "controlled" ? "inputEquivalence（controlled，逐 ordinal 输入等价，读 ledger）" : "lineage（trajectory，同起点/协议/采样/结构）"} =====`)
  if (experiment === "controlled") {
    for (const [tid, eq] of inputEquivalenceByTask.entries()) {
      console.log(`  ${eq.equal ? "OK " : "FAIL"} ${tid}: equal=${eq.equal} userEqual=${eq.userEqual} historyEqual=${eq.historyEqual} diffOrdinals=[${eq.diffOrdinals.join(",")}] systemDiffOrdinals=[${eq.systemDiffOrdinals.join(",")}]`)
      for (const d of eq.diffDetail) console.log(`      - ${d}`)
    }
  } else {
    for (const [tid, l] of lineageByTask.entries()) {
      console.log(`  ${l.valid ? "OK " : "FAIL"} ${tid}: valid=${l.valid} sameStart=${l.sameStart} sameProtocol=${l.sameProtocol} sameSampling=${l.sameSampling} structuralIntegrity=${l.structuralIntegrity} forked=${l.forked}`)
      for (const d of l.diffDetail) console.log(`      - ${d}`)
    }
  }

  // 清理
  unified.close()
  mock?.server.close()

  // ---------------- R21-R02 / Codex P0-02：runtime 编排复用断言 ----------------
  // current 与 hardened 必须都命中同一 handleChatStart runtime；缺任一命中 exit 非 0。
  const curTrace = samples.find((s) => s.variantId === "deepwriter_current_product")?.orchestrationTrace ?? null
  const hardTrace = samples.find((s) => s.variantId === "deepwriter_hardened_candidate")?.orchestrationTrace ?? null
  const orchAssert = assertSameOrchestrationRuntime(curTrace, hardTrace)
  console.log(`\n===== runtime 编排复用（P0-02） =====`)
  console.log(`  ${orchAssert.ok ? "OK " : "FAIL"} current.called=${curTrace?.called ?? false}(count=${curTrace?.count ?? 0}) hardened.called=${hardTrace?.called ?? false}(count=${hardTrace?.count ?? 0}) ${orchAssert.detail}`)
  if (!orchAssert.ok) {
    console.error(`[eval-runner] 编排复用阻断：production handler 与 eval candidate 未命中同一 handleChatStart runtime，exit 非 0`)
    process.exit(1)
  }

  // ---------------- R21-R04 主代理接线：统一失败退出口径（computeExitDecision 单入口） ----------------
  // manifest 自校验（与独立 validator 同源 preflight.manifestValidate）
  const manifestCheck = manifestValidate(manifest as never, { priceProfile })
  // 配对完整性：每 (task × variant × repeat) 必须恰有一个样本
  const expectedKeys = new Set<string>()
  for (const t of tasks) for (const v of VARIANT_IDS) for (let r = 1; r <= repeats; r++) expectedKeys.add(`${t.id}|${v}|${r}`)
  const actualKeys = new Set(samples.map((s) => `${s.taskId}|${s.variantId}|${s.repeat}`))
  const missingKeys = [...expectedKeys].filter((k) => !actualKeys.has(k))
  const extraKeys = [...actualKeys].filter((k) => !expectedKeys.has(k))
  const pairingIncomplete = missingKeys.length > 0 || extraKeys.length > 0
  if (pairingIncomplete) {
    console.error(`[eval-runner] 配对不完整：缺 ${missingKeys.length} 个（${missingKeys.slice(0, 3).join(" / ")}）多 ${extraKeys.length} 个（${extraKeys.slice(0, 3).join(" / ")}）`)
  }
  if (!manifestCheck.ok) {
    console.error(`[eval-runner] manifest 自校验失败：${manifestCheck.errors.slice(0, 5).join("；")}`)
  }
  const decision = computeExitDecision({
    mode: isMock ? "mock" : "real",
    blockedNoKey: false, // blocked 分支已早期 exit 0
    samplesTotal: samples.length,
    samplesOk: okCount,
    validationPassed: valPass,
    // R23-R03：失败样本数与中止样本数实际传入（Codex P0-02：real failed 也必须非零）
    samplesFailed: failedCount,
    samplesAborted: 0,
    budgetExhausted: budget.exhausted,
    fairnessFail: fairness.anyFairnessFail,
    manifestOk: manifestCheck.ok,
    missingVariants: pairingIncomplete,
    missingSamples: pairingIncomplete,
    accountingBroken
  })
  console.log(`\n===== exit 决策 =====`)
  console.log(`  exit=${decision.exitCode} reason=${decision.reason}`)
  process.exit(decision.exitCode)
}

const invokedDirectly = !!process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) main().catch((e) => {
  console.error("[eval-runner] 执行异常：", e)
  process.exit(2)
})
