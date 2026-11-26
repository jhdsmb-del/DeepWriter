import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.3 Gate 6：真实对比基准 runner（DeepSeek V4 Flash） ====================
// 目的：可复算的真实 DeepSeek V4 Flash 基准管道（复审要求的同模型/同 API/同任务对比）。
// 链路：executionSnapshot 快照（冻结 provider/模式契约）→ contextService 组装（总预算 + manifest）
//       → runKernelAdapter.createModelCallAdapter → streamChat（真实 SSE / 本地 mock SSE）。
// 任务集（冻结在脚本内）：continuation-10k / continuation-30k / multi-turn-consistency /
//       style-sample / renpy-scene / renpy-lint-fix，每任务 = { id, prompt, targetChars, mode }。
// 每样本记录：TTFT（首 token 延迟）、输出 token/s、汉字/s、总耗时、cache-miss/hit input tokens、
//       output tokens、总轮数、finish_reason、有效正文率、失败/重试次数。
//
// 构建与运行（在项目根目录执行）：
//   npx esbuild scripts/benchmark-real.ts --bundle --format=esm --platform=node --outfile=out/benchmark-real.mjs
//   node out/benchmark-real.mjs --mock --task=continuation-10k --repeats=2   # 快速验证（synthetic）
//   node out/benchmark-real.mjs --mock --repeats=5                            # mock 全任务
//   node out/benchmark-real.mjs --real --repeats=3                            # 真实 DeepSeek V4 Flash
//   node out/benchmark-real.mjs --real --task=renpy-scene --repeats=3
//
// 参数：
//   --mock | --real        模式二选一；mock=本地确定性模型（输出带 "synthetic": true）
//   --task=<id>            只跑单个任务（默认全部 6 个）
//   --repeats=N            每任务重复次数（默认 5）
//   --model=NAME           模型名（默认 deepseek-v4-flash）
//   --out-dir=PATH         输出目录（默认 out/）
//   --max-cost-cny=N       可选：整次基准费用上限（不是单样本额度）
//   --price-profile=PATH --trust-price-profile-hash=SHA --pricing-provider-id=ID
//                         启用费用上限时，real 必须显式授权精确价格
//
// 真实模式环境变量（API key 只从环境变量读取，绝不落盘、绝不写入任何输出/JSONL）：
//   DEEPSEEK_API_KEY       API key（缺失 → 打印 blocked 并以 exit 0 结束，不伪造结果）
//   DEEPSEEK_BASE_URL      端点（默认 https://api.deepseek.com；JSONL 头部与样本行带 endpoint）
//
// 输出：
//   out/benchmark-<mode>-<timestamp>.jsonl  每行一个原始样本（JSON）：
//     第一行为头部（type=header）：mode/synthetic/provider/endpoint/model/repeats/tasks/generatedAt；
//     样本行：ttftMs/totalMs/rounds/inputTokens/outputTokens/cacheHitTokens/cacheMissTokens/
//       outputChars/cjkChars/effectiveBodyChars/bodyRatio/finishReason/status/failures/retries/
//       promptHash（请求 messages 的 sha256，可复算）/requestSummary（仅 user 请求摘要：role+chars+预览 40 字）。
//     铁律：API key 与完整响应原文绝不落盘——响应只落 token 统计与正文长度。
//   stdout 打印每任务汇总表格（mean/p50/p95 的 TTFT、tok/s、汉字/s、总 token、失败率）
//   与诚实结论模板："以上为 <mode> 数据；mock=synthetic 仅验证管道，不得用于产品宣传"。
//
// 退出码：real 缺 key → exit 0（blocked，不伪造）；mock 出现失败样本（管道坏）→ exit 1；其余 0。

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as os from "node:os"
import * as http from "node:http"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { buildEvaluationSnapshot, type EvaluationSnapshotRuntime } from './eval-execution-budget'
import { createSyntheticEvalPriceProfile, evalProfileHash, freezeEvalPricing, pricingForFrozenEvalConfig, type FrozenEvalPricing } from './eval-pricing'
import { loadPriceProfile } from './eval-preflight'
import { assertCostReservation, makeRunBudgetState, reserveProviderAttemptBudget, reserveProviderCostBudget, settleProviderCostBudget, RunBudgetExceededError } from '../src/main/jobs/providerBudgetPolicy'
import type { ProviderCostQuote, RunBudgetState, RunConfig } from '../src/main/jobs/types'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const require = createRequire(import.meta.url)
const esbuild = require("esbuild") as { build(opts: Record<string, unknown>): Promise<unknown> }

// ---------------- electron-shim（照抄 scripts/r41-regressions.ts；加载含 electron 依赖的项目模块） ----------------

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

/** 把项目 TS 模块 bundle 成临时 ESM 并加载（bundle 后立即删除临时文件） */
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

// ---------------- 任务集（冻结：R4.3 Gate 6 复审基准的固定任务） ----------------

interface BenchmarkTask {
  id: string
  desc: string
  mode: "agent" | "longwrite" | "style" | "galgame"
  targetChars: number
  rounds: number
  longMode?: boolean
  prompt: string
  /** 多轮任务的后续轮提示（第 r 轮，r>=2） */
  followUp?: (round: number) => string
}

const TASK_SET: BenchmarkTask[] = [
  {
    id: "continuation-10k",
    desc: "10k 字续写：给定章节片段续写约一万字，保持人物/时间线/伏笔一致",
    mode: "longwrite",
    targetChars: 10000,
    rounds: 1,
    longMode: true,
    prompt:
      "以下是当前小说章节的片段（约 600 字）：\n\n【章节片段】\n雨是在后半夜停的。林默在客运站的长椅上醒来时，肩上的外套还带着苏晚家洗衣粉的气味。他记得自己是怎么到这里的——昨晚十点，他接到电话，说苏晚在城东的老街迷了路。三年了，她不该出现在这座小城。\n\n他在出站口找到她的时候，她正蹲在路灯下数地上的水洼。听到脚步声，她抬起头，笑了一下，像他们十七岁那年夏天一样。\n\n“你瘦了。”她说。\n\n林默没有回答。他把外套披在她肩上，转身往车站外走。老街尽头的面馆还亮着灯，老板老周从窗口探出头来，看见他，又看见他身后的人，愣了一下，然后咧嘴笑了。\n\n“两碗阳春面？”\n\n【续写要求】\n请续写约 10000 字。要求：1）保持林默（克制内敛）与苏晚（外热内冷）的人物设定与说话方式；2）延续雨夜重逢的基调，推进一条明确的情节线（可围绕三年前不告而别的原因展开）；3）时间线连续、伏笔有收有放；4）只输出续写正文，不输出任何说明文字。"
  },
  {
    id: "continuation-30k",
    desc: "30k 字续写：给定章节片段续写约三万字（长文本吞吐与续写能力）",
    mode: "longwrite",
    targetChars: 30000,
    rounds: 1,
    longMode: true,
    prompt:
      "以下是当前小说章节的片段（约 800 字）：\n\n【章节片段】\n档案馆的走廊很长，灯坏了一半，脚步声在水泥地上回响。林默攥着那封没有寄出的信，信封上的邮戳是十七年前。档案员是个头发花白的女人，她看了林默一眼，什么都没问，只把一摞泛黄的卷宗推过来。\n\n卷宗里夹着一张合影。照片上的人他认得——他父亲年轻时候，站在一座水坝的工地上，身边是另一个穿中山装的男人。照片背面用钢笔写着两行字，墨水已经洇开：\"老周，坝成之日，切记。\"\n\n林默翻遍了整摞卷宗，没找到第二张照片。档案员忽然开口：\"你父亲不是第一个来找这份档案的人。\"\n\n\"谁？\"\n\n\"三个月前，一个姓苏的姑娘。\"\n\n【续写要求】\n请续写约 30000 字。要求：1）以三幕结构推进：追查档案真相 → 揭开十七年前水坝事故 → 与苏晚的旧事收束；2）保持悬疑氛围与人物一致性（林默第一人称克制视角）；3）章节间自然过渡，伏笔全部回收；4）只输出续写正文，不输出任何说明文字。"
  },
  {
    id: "multi-turn-consistency",
    desc: "5 轮角色一致性：同一角色设定下连续追问，验证角色立场/记忆/语气一致",
    mode: "agent",
    targetChars: 400,
    rounds: 5,
    prompt:
      "现在开始角色扮演。你扮演林默：17 岁，江南小城高三学生，性格内敛克制，说话简短，母亲早逝、由开面馆的父亲带大，最好的朋友是邻居苏晚。用第一人称回答，每次回答不超过 3 句话。\n\n第一问：介绍一下你自己，包括年龄和家庭。",
    followUp: (r: number): string =>
      [
        "第二问（保持角色）：你最好的朋友是谁？你们是怎么认识的？",
        "第三问（保持角色）：你父亲是什么样的人？你对他的态度如何？",
        "第四问（保持角色）：你最大的遗憾是什么？",
        "第五问（保持角色）：用一句话描述你的性格，再复述一遍第一问时你介绍的自己的年龄。"
      ][r - 2] ?? "（保持角色）继续。"
  },
  {
    id: "style-sample",
    desc: "风格画像 + 生成：按给定风格画像生成一段 800 字样章",
    mode: "style",
    targetChars: 800,
    rounds: 1,
    prompt:
      "【风格画像】白描冷峻，短句为主，动词精确，少形容词；视角克制，情感通过动作与环境呈现；避免比喻堆砌，偶用一句留白收尾。\n\n【任务】按上述风格画像，写一段 800 字左右的场景：傍晚的渡口，一个中年男人在等最后一班船。只输出正文。"
  },
  {
    id: "renpy-scene",
    desc: "Ren'Py 新场景：基于现有角色与设定，编写一个新场景脚本（.rpy）",
    mode: "galgame",
    targetChars: 1200,
    rounds: 1,
    prompt:
      "以下为现有 Ren'Py 项目片段：\n\n```rpy\ndefine sara = Character(\"莎拉\", color=\"#ff99cc\")\ndefine lin = Character(\"林默\", color=\"#99ccff\")\nlabel schoolyard:\n    scene bg school\n    show sara happy\n    sara \"又在偷偷看小说？\"\n    lin \"没有。\"\n    sara \"书包都露出来了。\"\n    return\n```\n\n【任务】请为该项目编写一个新的场景脚本（纯 .rpy 代码，不要解释）：放学后的天台，莎拉向林默提起下个月的转学。要求：1）使用已有角色 define（sara/lin）；2）包含 scene/show、对话、至少一处 menu 选择、根据选择跳转到不同 label（good_end/bye_label）；3）遵守 Ren'Py 缩进与语法规范。"
  },
  {
    id: "renpy-lint-fix",
    desc: "Ren'Py lint 修复：修复给定 .rpy 中的语法错误并说明",
    mode: "galgame",
    targetChars: 0,
    rounds: 1,
    prompt:
      "以下 .rpy 代码存在若干语法/规范错误，请逐条指出并给出修复后的完整代码：\n\n```rpy\nlabel start:\n    \"欢迎来到小镇。\"\n    jump next\nlabel next:\n\t$ love = 0\n    if love >= 10:\n    sara \"你终于来了。\"\n        else:\n    sara \"哼。\"\n    menu:\n        \"道歉\":\n        jump sorry\n        \"沉默\":\n        jump silent\nlabel sorry:\n    sara \"算了。\"\nreturn\nlabel silent:\n    \"沉默是金。\"\nreturn\n```\n\n要求：指出缩进、label 定义、menu 结构、return 位置等方面的错误；然后给出修复后的完整正确代码。"
  }
]

// ---------------- 统计工具 ----------------

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return Math.round(sorted[idx])
}

function mean(arr: number[]): number | null {
  if (arr.length === 0) return null
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** CJK 汉字计数（0x3000-0x9fff，同 deepseek.ts isCjk 范围） */
function countCjk(text: string): number {
  let n = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code >= 0x3000 && code <= 0x9fff) n++
  }
  return n
}

// ---------------- 本地确定性 mock SSE 模型 ----------------
// 输出文本由 seed（prompt sha256）确定性生成（长度 = min(targetChars, 1600)，防拖慢）；
// 首块延迟 12ms（模拟 TTFT）；每 40 字符一块、块间隔 4ms；usage 确定性返回。

function startMockSse(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
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
      const joined = messages.map((m) => m.content ?? "").join(" ")
      // 确定性 seed：请求内容 sha256 → 固定输出文本
      const seed = createHash("sha256").update(joined).digest()
      let a = seed.readUInt32LE(0) >>> 0
      const rand = (): number => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const pool = "的了一是在不有和这大为上以到说要去你全会着没有看好他出来就小么也等多对自能下那得后于里可家还年发成只天过她用行面想作种如开从当来"
      // 输出长度按提示词声明的目标字数缩放（上限 1600，防拖慢 mock）
      const declared = joined.match(/(\d{4,5})\s*字/)
      let targetChars = declared ? Math.min(Number(declared[1]), 1600) : 800
      targetChars = Math.max(200, targetChars)
      let text = ""
      while (text.length < targetChars) text += pool[Math.floor(rand() * pool.length)]
      const promptTokens = Math.max(10, Math.ceil(joined.length / 3))
      const completionTokens = Math.max(10, Math.ceil(text.length / 2))
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_cache_hit_tokens: Math.floor(promptTokens * 0.6),
        prompt_cache_miss_tokens: Math.ceil(promptTokens * 0.4),
        completion_tokens_details: { reasoning_tokens: 3 }
      }
      const chunks: Array<Record<string, unknown>> = [
        { id: "m", choices: [{ index: 0, delta: { reasoning_content: "（模拟推理）", role: "assistant" }, finish_reason: null }], usage: null }
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
      setTimeout(writeNext, 12) // 确定性首块延迟（模拟 TTFT）
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number } | null
      resolve({ server, port: addr?.port ?? 0 })
    })
  })
}

// ---------------- 样本指标 ----------------

interface SampleMetrics {
  ts: string
  mode: "mock" | "real"
  synthetic?: boolean
  provider?: string
  endpoint?: string
  model: string
  taskId: string
  repeat: number
  ttftMs: number | null
  totalMs: number
  rounds: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputChars: number
  cjkChars: number
  effectiveBodyChars: number
  bodyRatio: number
  finishReason: string | null
  status: "ok" | "failed"
  failures: number
  retries: number
  promptHash: string
  requestSummary: Array<{ role: string; chars: number; preview: string }>
}

// ---------------- 主流程 ----------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`DeepWriter benchmark
  --mock | --real  模式二选一；--mock 使用新建的本地模拟服务
  --task=ID --repeats=N --model=NAME --out-dir=PATH
  --max-cost-cny=N  可选的整次费用上限，包含失败与重试的预请求上界
  设置费用上限时，real 还需：
    --price-profile=PATH --trust-price-profile-hash=SHA --pricing-provider-id=ID
  未设置费用上限时保留原调用方式；real 凭据仅从环境变量读取。
  费用拒绝在 fetch 前执行，exit 2；未知价格不转成无限制。`)
    return
  }
  const isMock = args.includes("--mock")
  const isReal = args.includes("--real")
  if (isMock === isReal) {
    console.error("[benchmark] 必须且只能指定一个模式：--mock 或 --real")
    process.exit(2)
  }
  const numArg = (flag: string, dflt: number): number => {
    const hit = args.find((a) => a.startsWith(`${flag}=`))
    const v = Number(hit?.split("=")[1] ?? dflt)
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt
  }
  const repeats = numArg("--repeats", 5)
  const taskFilter = args.find((a) => a.startsWith("--task="))?.split("=")[1] ?? ""
  const model = args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "deepseek-v4-flash"
  const outDir = path.resolve(ROOT, args.find((a) => a.startsWith("--out-dir="))?.split("=")[1] ?? "out")
  const costArg = args.find(a => a.startsWith('--max-cost-cny='))?.slice('--max-cost-cny='.length)
  const maxCostCny = costArg === undefined ? null : Number(costArg)
  if (maxCostCny !== null && (!Number.isFinite(maxCostCny) || maxCostCny <= 0)) throw new Error('--max-cost-cny 必须是有限正数')
  const priceProfilePath = args.find(a => a.startsWith('--price-profile='))?.slice('--price-profile='.length)

  // 真实模式：API key 只从环境变量读取；缺失 → blocked + exit 0（不伪造结果）
  const apiKey = process.env.DEEPSEEK_API_KEY ?? ""
  if (isReal && !apiKey) {
    console.log("[benchmark] real mode blocked: DEEPSEEK_API_KEY not set")
    process.exit(0)
  }
  if (isReal && maxCostCny !== null && !priceProfilePath) throw new Error('启用 --max-cost-cny 需要显式 --price-profile，fetch前拒绝')
  const endpoint = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"

  const tasks = taskFilter ? TASK_SET.filter((t) => t.id === taskFilter) : TASK_SET
  if (tasks.length === 0) {
    console.error(`[benchmark] 未知任务 id: ${taskFilter}（可用：${TASK_SET.map((t) => t.id).join(" / ")}）`)
    process.exit(2)
  }

  // 临时工作区（db/目录全部在系统临时目录，不污染工作树）
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "dw-bm-"))
  const workDir = path.join(tmp, "work")
  const docDir = path.join(tmp, "docs")
  await fsp.mkdir(workDir, { recursive: true })
  await fsp.mkdir(docDir, { recursive: true })

  // mock 模型（mock 模式才启动）
  let mock: { server: http.Server; port: number } | null = null
  if (isMock) mock = await startMockSse()
  const baseUrl = isMock ? `http://127.0.0.1:${mock?.port}` : endpoint
  const syntheticPrice = maxCostCny !== null && isMock && !priceProfilePath ? createSyntheticEvalPriceProfile(new URL(baseUrl).origin, model) : null
  let pricing: FrozenEvalPricing | null = null
  try {
    if (maxCostCny !== null) pricing = freezeEvalPricing({
      profile: syntheticPrice ?? loadPriceProfile(priceProfilePath),
      providerId: syntheticPrice?.providerId ?? args.find(a => a.startsWith('--pricing-provider-id='))?.slice('--pricing-provider-id='.length) ?? '',
      trustedProfileHash: syntheticPrice ? evalProfileHash(syntheticPrice) : args.find(a => a.startsWith('--trust-price-profile-hash='))?.slice('--trust-price-profile-hash='.length) ?? '',
      canonicalOrigin: new URL(baseUrl).origin, model, currency: 'CNY'
    })
  } catch {
    mock?.server.close()
    await fsp.rm(tmp, { recursive: true, force: true })
    throw new Error('benchmark 价格来源/授权hash/精确身份未通过，fetch前拒绝')
  }

  // 加载项目模块（electron-shim bundle）
  const repoMod = await loadTsModule("src/main/db/repository.ts")
  const adapterMod = await loadTsModule("src/main/runKernelAdapter.ts")
  const ctxMod = await loadTsModule("src/main/contextService.ts")
  const snapMod = await loadTsModule("src/main/executionSnapshot.ts")

  const createRepository = repoMod.createRepository as (p: string) => {
    open(): void
    close(): void
    createSession(sessionId: string, title: string, model: string): void
    createRun(r: Record<string, unknown>): void
    appendSessionMessage(m: Record<string, unknown>): void
    getSessionMessages(sessionId: string): Array<{ msg_id: string; seq: number; role: string; content: string }>
    saveContextManifest(runId: string, round: number, manifestJson: string): void
  }
  const createModelCallAdapter = adapterMod.createModelCallAdapter as (opts: Record<string, unknown>) => (input: Record<string, unknown>) => Promise<AsyncIterable<Record<string, unknown>>>
  const createContextService = ctxMod.createContextService as (repo: unknown) => {
    assembleRunContext(config: Record<string, unknown>, round: number, live: Array<{ role: string; content: string }>, prefix: Array<{ role: string; content: string }>): Promise<Record<string, unknown>>
  }
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const snapshotRuntime: EvaluationSnapshotRuntime = { buildExecutionSnapshot, deriveProviderCallBudget: snapMod.deriveProviderCallBudget as EvaluationSnapshotRuntime['deriveProviderCallBudget'] }
  const buildStaticSystemMessages = snapMod.buildStaticSystemMessages as (snap: Record<string, unknown>) => Array<{ role: "system"; content: string }>

  const repo = createRepository(path.join(tmp, "bm.db"))
  repo.open()

  const settings = {
    model,
    baseUrl,
    apiKey: isMock ? "mock-key" : apiKey, // mock 占位 key；real key 仅在内存，绝不落盘/输出
    maxTokens: 8192,
    outputTokenLimit: 8192,
    temperature: 0.9,
    topP: 1,
    thinkingEnabled: false, // 基准统一关闭思考（TTFT/吞吐口径一致）
    reasoningEffort: "medium" as const,
    workDir,
    docDir,
    novelMode: false,
    galgame: { enabled: false, projectDir: "", sdkPath: "" },
    historyBudgetTokens: 60000
  }

  // buildPrefix：复制生产 buildRunPrefix（mode profile + 快照记忆；无附件）
  const buildRunPrefix = async (rc: Record<string, unknown>): Promise<Array<{ role: string; content: string }>> => {
    const prefix: Array<{ role: string; content: string }> = [...buildStaticSystemMessages(rc)]
    const memSnap = rc.memory as { projectPath?: string; projectContent?: string; userContent?: string } | undefined
    if (memSnap) {
      if (memSnap.projectPath && memSnap.projectContent?.trim()) {
        prefix.push({ role: "system", content: `## 项目记忆（${memSnap.projectPath}）\n${memSnap.projectContent}` })
      }
      if (memSnap.userContent?.trim()) {
        prefix.push({ role: "system", content: `## 用户记忆\n${memSnap.userContent}` })
      }
    }
    return prefix
  }

  const contextService = createContextService(repo)
  const configs = new Map<string, Record<string, unknown>>()
  let budgetState: RunBudgetState | null = null
  let budgetDenied = false
  const modelCall = createModelCallAdapter({
    getApi: (runId: string) => ({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      maxTokens: settings.maxTokens,
      outputTokenLimit: (configs.get(runId)?.outputTokenLimit as number) ?? settings.outputTokenLimit,
      thinking: { enabled: false, effort: "medium" as const },
      temperature: 0.9,
      topP: 1,
      ...(pricing ? { providerId: pricing.record.providerId,
        pricing: pricingForFrozenEvalConfig(configs.get(runId) ?? {}, pricing.record.providerId, pricing.record.currency) } : {})
    }),
    beforeProviderAttempt: (attempt: { logicalCallId: string; innerAttempt: number; actor: 'writer' | 'critic' | 'editor'; costQuote?: ProviderCostQuote }) => {
      if (maxCostCny === null) return // Original no-amount benchmark contract.
      if (!budgetState) throw new Error('benchmark 费用账本尚未冻结')
      try {
        assertCostReservation(budgetState, attempt.costQuote)
        reserveProviderAttemptBudget(budgetState, attempt.actor, attempt.innerAttempt, false, Date.now())
        reserveProviderCostBudget(budgetState, attempt.logicalCallId, attempt.innerAttempt, attempt.costQuote, Date.now())
        // This non-resumable benchmark charges the entire pre-fetch upper,
        // including failed/retried requests. It never infers a provider bill.
        settleProviderCostBudget(budgetState, [`${attempt.logicalCallId}\u0000${attempt.innerAttempt}`], Date.now())
      } catch (error) {
        budgetDenied = true
        throw error
      }
    },
    buildPrefix: buildRunPrefix,
    getSignal: () => undefined,
    getConfig: (runId: string) => configs.get(runId) ?? {},
    assembleContext: (config: Record<string, unknown>, round: number, live: Array<{ role: string; content: string }>, prefix: Array<{ role: string; content: string }>) => contextService.assembleRunContext(config, round, live, prefix)
  })

  console.log(`Benchmark(${isMock ? "mock,synthetic" : "real"}): tasks=${tasks.map((t) => t.id).join(",")} repeats=${repeats} model=${model}${isMock ? "" : ` endpoint=${endpoint}`}`)

  // ---------------- 执行每个样本 ----------------

  const samples: SampleMetrics[] = []
  const MAX_ATTEMPTS = isMock ? 1 : 2 // real 模式允许 1 次外部重试；mock 不允许（确定性管道必须一次成功）

  for (const task of tasks) {
    for (let rep = 1; rep <= repeats; rep++) {
      const runId = `bm_${task.id}_${rep}`
      const sessionId = `sess_bm_${task.id}_${rep}`
      repo.createSession(sessionId, task.id, model)
      repo.createRun({
        run_id: runId,
        session_id: sessionId,
        status: "queued",
        phase: "queued",
        started_at: Date.now(),
        updated_at: Date.now(),
        config_json: "{}",
        parent_run_id: null,
        error_code: null,
        error_message: null,
        client_request_id: runId
      })
      // 执行快照（冻结 provider/模式契约/目标字数；credential 只存 origin 引用）
      const snapshotInput = {
        payload: {
          id: runId,
          mode: task.mode,
          text: task.prompt,
          targetChars: task.targetChars,
          longMode: task.longMode ?? false,
          workspace: "chat",
          phase: "execute",
          planText: "",
          story: null,
          attachments: []
        },
        settings,
        sessionId,
        memory: { projectPath: "", projectContent: "", userContent: "" },
        ...(pricing ? { pricingSnapshots: [structuredClone(pricing.record)] } : {})
      }
      const config = maxCostCny === null ? buildExecutionSnapshot(snapshotInput) : buildEvaluationSnapshot(snapshotRuntime, snapshotInput, maxCostCny)
      configs.set(runId, config)
      if (maxCostCny !== null) budgetState ??= makeRunBudgetState('benchmark', config as RunConfig, Date.now(), Date.now())

      const sampleStart = Date.now()
      let ttftMs: number | null = null
      let outputTokens = 0
      let inputTokens = 0
      let cacheHitTokens = 0
      let cacheMissTokens = 0
      let contentChars = 0
      let reasoningChars = 0
      let effectiveBodyChars = 0
      let cjkChars = 0
      let lastFinishReason: string | null = null
      let failures = 0
      let retries = 0
      let sampleFailed = false
      const allRequestMessages: Array<{ role: string; content: string }> = []
      const requestSummary: Array<{ role: string; chars: number; preview: string }> = []
      let executedRounds = 0

      // 每轮：live = 当前 user 消息（canonical session 只存已完成的过往轮次，避免与 live 重复）
      for (let r = 1; r <= task.rounds; r++) {
        const userMsg = r === 1 ? task.prompt : (task.followUp?.(r) ?? "")
        const live: Array<{ role: string; content: string }> = [{ role: "user", content: userMsg }]
        allRequestMessages.push(...live)
        requestSummary.push({ role: "user", chars: userMsg.length, preview: userMsg.slice(0, 40) })
        const roundStart = Date.now()
        let roundOk = false
        let roundContent = "" // 本轮正文只存内存 + 临时 DB（canonical 历史），绝不写入 JSONL
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            const iter = await modelCall({ runId, phase: "thinking", turnSeq: r, round: r, messages: live })
            for await (const ev of iter) {
              if (ev.type === "text" && typeof ev.delta === "string") {
                if (ttftMs === null) ttftMs = Date.now() - roundStart
                roundContent += ev.delta
                contentChars += ev.delta.length
                effectiveBodyChars += ev.delta.trim().length
                cjkChars += countCjk(ev.delta)
              } else if (ev.type === "reasoning" && typeof ev.delta === "string") {
                reasoningChars += ev.delta.length
              } else if (ev.type === "usage" && ev.usage) {
                const u = ev.usage as { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number }
                inputTokens += u.inputTokens ?? 0
                outputTokens += u.outputTokens ?? 0
                cacheHitTokens += u.cacheHitTokens ?? 0
                cacheMissTokens += u.cacheMissTokens ?? 0
              } else if (ev.type === "finish" && typeof ev.finishReason === "string") {
                lastFinishReason = ev.finishReason
              }
            }
            roundOk = true
            break
          } catch (error) {
            failures++
            if (error instanceof RunBudgetExceededError || budgetDenied) break
            if (attempt < MAX_ATTEMPTS) {
              retries++
              await delay(1000)
            }
          }
        }
        if (!roundOk) {
          sampleFailed = true
          break
        }
        executedRounds = r
        // 已完成轮次写入 canonical session（该轮 user 消息此时才落库，防止与 live 重复组装；
        // 会话正文仅存于临时 DB，运行结束即删除——JSONL 只落统计与正文长度，不落响应原文）
        repo.appendSessionMessage({
          msg_id: `m_${runId}_user_${r}`,
          session_id: sessionId,
          seq: r * 2 - 1,
          role: "user",
          content: userMsg,
          reasoning: "",
          status: "done",
          usage_json: "null",
          rounds: 0,
          tool_names_json: "[]",
          plan: null,
          created_at: Date.now()
        })
        repo.appendSessionMessage({
          msg_id: `m_${runId}_asst_${r}`,
          session_id: sessionId,
          seq: r * 2,
          role: "assistant",
          content: roundContent,
          reasoning: "",
          status: "done",
          usage_json: "null",
          rounds: 0,
          tool_names_json: "[]",
          plan: null,
          created_at: Date.now()
        })
      }

      const totalMs = Date.now() - sampleStart
      const outputChars = contentChars + reasoningChars
      const sample: SampleMetrics = {
        ts: new Date().toISOString(),
        mode: isMock ? "mock" : "real",
        ...(isMock ? { synthetic: true } : { provider: model, endpoint }),
        model,
        taskId: task.id,
        repeat: rep,
        ttftMs,
        totalMs,
        rounds: executedRounds,
        inputTokens,
        outputTokens,
        cacheHitTokens,
        cacheMissTokens,
        outputChars,
        cjkChars,
        effectiveBodyChars,
        bodyRatio: outputChars > 0 ? Math.round((effectiveBodyChars / outputChars) * 1000) / 1000 : 0,
        finishReason: lastFinishReason,
        status: sampleFailed ? "failed" : "ok",
        failures,
        retries,
        promptHash: createHash("sha256").update(JSON.stringify(allRequestMessages)).digest("hex"),
        requestSummary
      }
      samples.push(sample)
      const statusMark = sample.status === "ok" ? "ok" : "FAIL"
      console.log(
        `  ${task.id}#${rep} ${statusMark}: ttft=${sample.ttftMs ?? "—"}ms total=${totalMs}ms out=${outputTokens}t chars=${outputChars} rounds=${executedRounds} retries=${retries}`
      )
    }
  }

  // ---------------- 输出 JSONL（原始样本；无 key、无完整响应原文） ----------------

  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const jsonlPath = path.join(outDir, `benchmark-${isMock ? "mock" : "real"}-${ts}.jsonl`)
  const headerLine = {
    type: "header",
    schemaVersion: 1,
    mode: isMock ? "mock" : "real",
    ...(isMock ? { synthetic: true } : { provider: model, endpoint }),
    model,
    repeats,
    tasks: tasks.map((t) => t.id),
    generatedAt: new Date().toISOString(),
    ...(budgetState ? { budget: { maxCostCny: budgetState.limits.maxCost?.amount, spentUpperCny: budgetState.spentCostUpper, requestsUsed: budgetState.totalCalls, exhausted: budgetDenied, actualAmountConfirmed: false } } : {}),
    note: isMock ? "synthetic：本地确定性 mock，仅验证管道，不得用于产品宣传" : "real：真实 DeepSeek V4 Flash 采样；API key 与完整响应原文不落盘"
  }
  const lines = [JSON.stringify(headerLine), ...samples.map((s) => JSON.stringify(s))]
  await fsp.mkdir(outDir, { recursive: true })
  await fsp.writeFile(jsonlPath, lines.join("\n") + "\n", "utf-8")
  console.log(`\n已写入 ${jsonlPath}（${samples.length} 样本行 + 1 头部行）`)

  // ---------------- 汇总表格 ----------------

  console.log("\n===== 汇总（按任务；mean/p50/p95） =====")
  console.log("| 任务 | TTFT mean | TTFT p50 | TTFT p95 | tok/s mean | tok/s p50 | tok/s p95 | 汉字/s mean | 汉字/s p50 | 汉字/s p95 | 总token mean | 失败率 |")
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|")
  for (const task of tasks) {
    const rs = samples.filter((s) => s.taskId === task.id)
    const ok = rs.filter((s) => s.status === "ok")
    const ttfts = ok.map((s) => s.ttftMs ?? 0).sort((a, b) => a - b)
    const toksPerSec = ok.map((s) => (s.totalMs > 0 ? (s.outputTokens / (s.totalMs / 1000)) * 10 : 0)).map((v) => Math.round(v) / 10).sort((a, b) => a - b)
    const charsPerSec = ok.map((s) => (s.totalMs > 0 ? (s.cjkChars / (s.totalMs / 1000)) * 10 : 0)).map((v) => Math.round(v) / 10).sort((a, b) => a - b)
    const totalTokens = ok.map((s) => s.inputTokens + s.outputTokens)
    const failRate = rs.length > 0 ? Math.round((rs.filter((s) => s.status === "failed").length / rs.length) * 1000) / 10 : 0
    console.log(
      `| ${task.id} | ${mean(ttfts) ?? "—"}ms | ${percentile(ttfts, 50) ?? "—"}ms | ${percentile(ttfts, 95) ?? "—"}ms | ` +
        `${mean(toksPerSec) ?? "—"} | ${percentile(toksPerSec, 50) ?? "—"} | ${percentile(toksPerSec, 95) ?? "—"} | ` +
        `${mean(charsPerSec) ?? "—"} | ${percentile(charsPerSec, 50) ?? "—"} | ${percentile(charsPerSec, 95) ?? "—"} | ${mean(totalTokens) ?? "—"} | ${failRate}% |`
    )
  }

  // ---------------- 诚实结论模板 ----------------
  console.log("")
  if (isMock) {
    console.log("以上为 mock 数据；mock=synthetic 仅验证管道，不得用于产品宣传")
  } else {
    console.log(`以上为 real 数据（provider=${model}, endpoint=${endpoint}）；真实 API 采样，指标受网络/负载影响，仅供参考`)
  }

  repo.close()
  mock?.server.close()
  try {
    await fsp.rm(tmp, { recursive: true, force: true })
  } catch {
    /* 清理失败忽略 */
  }

  // mock 模式下任何失败样本 = 管道坏 → 非零退出；real 模式失败计入数据（网络波动），exit 0
  const failedSamples = samples.filter((s) => s.status === "failed").length
  if (budgetDenied) { process.exitCode = 2; return }
  if (isMock && failedSamples > 0) {
    console.error(`[benchmark] mock 管道出现 ${failedSamples} 个失败样本（mock 应确定性成功），请检查链路`)
    process.exitCode = 1
    return
  }
  // Let retry/fetch handles finish closing; forced exit can abort libuv on Windows.
  process.exitCode = 0
}

main().catch((e) => {
  console.error("[benchmark] 执行异常：", e)
  process.exit(2)
})
