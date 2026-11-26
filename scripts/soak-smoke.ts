import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.3 Gate 6：Soak 冒烟（缩短版，验证 soak 框架与管道可运行） ====================
// 目的：证明 soak 框架可运行——完整 2h/8h soak 由用户/CI 择机执行，本脚本为 60-120 秒缩短版。
// 链路：本地 mock SSE 模型（流式 chunks + tool_call 第一轮 + usage）驱动项目真实链路：
//   repository(SQLite) + executionSnapshot + startChatRun + AgentRunEngine + runKernelAdapter
//   （createRunStorePort / createModelCallAdapter / createToolExecutor / createChunkTranslator）+
//   contextService + modeProfiles，全部经 electron-shim 打包加载（同 scripts/r41-regressions.ts）。
// 行为：跑 N 轮对话（默认 10 轮）；每轮等 terminal 并断言 DB（run 终态 / turns 连续完整 /
//   session_messages 投影存在 / toolCalls 无未决 / usage 事件 / done chunk 恰好一次）；
//   每 sample-ms（默认 5000）采样一次 process.memoryUsage（soak 核心指标：内存爬升）；
//   中途随机注入 1 次取消（cancel 一个 run）验证取消收敛；任何 run 未到 terminal 或 DB 不一致 → 非零退出。
//
// 构建与运行（在项目根目录执行）：
//   npx esbuild scripts/soak-smoke.ts --bundle --format=esm --platform=node --outfile=out/soak-smoke.mjs
//   node out/soak-smoke.mjs --mock --rounds=3 --round-gap-ms=0      # 快速验证（约 3-6 秒）
//   node out/soak-smoke.mjs --mock                                   # 缩短版 soak（默认 10 轮，约 60-120 秒）
//   node out/soak-smoke.mjs --real --rounds=3                        # 真实 DeepSeek V4 Flash（需 DEEPSEEK_API_KEY）
//
// 参数：
//   --mock | --real        模式二选一；mock=本地确定性模型（synthetic），real=真实 API
//   --rounds=N             对话轮数（默认 10）
//   --round-gap-ms=N       轮间间隔毫秒（默认 5000；soak 时长主要由它控制）
//   --sample-ms=N          内存采样间隔毫秒（默认 5000）
//   --cancel-round=N       第 N 轮注入取消（默认随机 2..rounds）
//   --model=NAME           模型名（默认 deepseek-v4-flash）
//   --out=PATH             摘要 JSON 输出路径（默认 out/soak-result.json）
//
// 真实模式环境变量（API key 只从环境变量读取，绝不落盘、绝不写入任何输出）：
//   DEEPSEEK_API_KEY       API key（缺失 → 打印 blocked 并以 exit 0 结束，不伪造结果）
//   DEEPSEEK_BASE_URL      端点（默认 https://api.deepseek.com；真实模式摘要带 provider/endpoint）
//
// 输出：stdout 打印摘要 JSON；--out 写同一 JSON 到文件。任何断言失败 → 非零退出。
//   out/soak-result.json 字段：mode / synthetic / provider / endpoint / rounds / completed /
//   cancelled / recoveryRequired / failed / terminalAll / cancelRound / perRoundMs / roundP50 /
//   roundP95 / heapStartMB / heapPeakMB / heapGrowthMB / rssPeakMB / memorySamples /
//   totalDurationMs / generatedAt / checks{passed,failed,failures}

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as os from "node:os"
import * as http from "node:http"
import { createRequire } from "node:module"

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
  const outfile = path.resolve(ROOT, "out", `soakmod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

// ---------------- 本地轻量结构类型（跨 bundle 结构兼容，不做静态类型检查） ----------------

interface RunRowLite {
  run_id: string
  session_id: string
  status: string
  phase: string
  started_at: number
  updated_at: number
  config_json: string
  error_code: string | null
  error_message: string | null
}

interface TurnRowLite {
  turn_id: string
  run_id: string
  turn_seq: number
  role: string
  content: string
  reasoning_content: string | null
  tool_calls_json: string | null
  tool_result_json: string | null
  created_at: number
}

interface ToolCallRowLite {
  tool_call_id: string
  run_id: string
  name: string
  status: string
}

interface SessionMsgLite {
  msg_id: string
  session_id: string
  seq: number
  role: string
  content: string
  reasoning: string
  status: string
  usage_json: string
  rounds: number
  tool_names_json: string
  plan: string | null
  created_at: number
}

/** repository 的最小接口（结构兼容 createRepository 返回值） */
interface RepoLike {
  open(): void
  close(): void
  createSession(sessionId: string, title: string, model: string): void
  touchSession(sessionId: string, title?: string): void
  appendSessionMessage(m: Record<string, unknown>): void
  getSessionMessages(sessionId: string): SessionMsgLite[]
  getRun(runId: string): RunRowLite | null
  getTurnsByRun(runId: string): TurnRowLite[]
  getToolCallsByRun(runId: string): ToolCallRowLite[]
}

interface EngineEventLike {
  type: string
  phase?: string
  run?: { status: string; configJson?: string }
}

interface EngineLike {
  abortSignal(runId: string): AbortSignal | undefined
  cancel(runId: string): Promise<void>
}

// ---------------- 工具函数 ----------------

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return Math.round(sorted[idx])
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "recovery_required"])

// ---------------- 本地确定性 mock SSE 模型 ----------------
// 行为：第一轮（消息里无 tool 结果）→ 流式文本 chunks + tool_call（generate_markdown_doc）+ usage；
//       第二轮（已含 tool 结果）→ 流式文本 chunks + finish stop + usage。
// 每个 chunk 间隔 chunkDelayMs（默认 40ms），制造足够宽的"运行中"窗口供取消注入。

interface MockSse {
  server: http.Server
  port: number
  requests: number
}

function startMockSse(opts: { docDir: string; chunkDelayMs: number }): Promise<MockSse> {
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      let messages: Array<{ role: string; content: string }> = []
      try {
        messages = (JSON.parse(body || "{}").messages ?? []) as Array<{ role: string; content: string }>
      } catch {
        messages = []
      }
      const joined = messages.map((m) => m.content ?? "").join(" ")
      const promptTokens = Math.max(10, Math.ceil(joined.length / 3))
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: 12,
        total_tokens: promptTokens + 12,
        prompt_cache_hit_tokens: Math.floor(promptTokens * 0.6),
        prompt_cache_miss_tokens: Math.ceil(promptTokens * 0.4),
        completion_tokens_details: { reasoning_tokens: 2 }
      }
      const hasToolResult = messages.some((m) => m.role === "tool")
      // 第一轮：文本 → tool_call（参数 path 指向 docDir 内，避免触发保存对话框）→ finish tool_calls
      const toolArgs = JSON.stringify({
        path: path.join(opts.docDir, "soak.md"),
        filename: "soak.md",
        content: "冒烟测试文档正文。"
      })
      const chunks: Array<Record<string, unknown>> = hasToolResult
        ? [
            { id: "m", choices: [{ index: 0, delta: { content: "第二段内容，工具已执行完成。", role: "assistant" }, finish_reason: null }], usage: null },
            { id: "m", choices: [{ index: 0, delta: { content: "（收尾）本轮对话结束。", role: "assistant" }, finish_reason: null }], usage: null },
            { id: "m", choices: [{ index: 0, delta: { content: "总结：文档已生成，剧情继续推进。", role: "assistant" }, finish_reason: null }], usage: null },
            { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }
          ]
        : [
            { id: "m", choices: [{ index: 0, delta: { content: "第一段内容。", reasoning_content: "thinking…", role: "assistant" }, finish_reason: null }], usage: null },
            { id: "m", choices: [{ index: 0, delta: { content: "（截断处）", role: "assistant" }, finish_reason: null }], usage: null },
            { id: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_soak", type: "function", function: { name: "generate_markdown_", arguments: toolArgs.slice(0, Math.ceil(toolArgs.length / 2)) } }] }, finish_reason: null }], usage: null },
            { id: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_soak", function: { name: "doc", arguments: toolArgs.slice(Math.ceil(toolArgs.length / 2)) } }] }, finish_reason: null }], usage: null },
            { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }
          ]
      let i = 0
      const writeNext = (): void => {
        if (i >= chunks.length) {
          res.write("data: [DONE]\n\n")
          res.end()
          return
        }
        res.write(`data: ${JSON.stringify(chunks[i])}\n\n`)
        i++
        setTimeout(writeNext, opts.chunkDelayMs)
      }
      setTimeout(writeNext, 40) // 模拟首字节延迟
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number } | null
      resolve({ server, port: addr?.port ?? 0, requests: 0 })
    })
  })
}

// ---------------- 主流程 ----------------

interface SoakSummary {
  mode: string
  synthetic?: boolean
  provider?: string
  endpoint?: string
  model: string
  rounds: number
  completed: number
  cancelled: number
  recoveryRequired: number
  failed: number
  terminalAll: boolean
  cancelRound: number | null
  perRoundMs: number[]
  roundP50: number | null
  roundP95: number | null
  heapStartMB: number
  heapPeakMB: number
  heapGrowthMB: number
  rssPeakMB: number
  memorySamples: number
  totalDurationMs: number
  generatedAt: string
  checks: { passed: number; failed: number; failures: string[] }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const isMock = args.includes("--mock")
  const isReal = args.includes("--real")
  if (isMock === isReal) {
    console.error("[soak] 必须且只能指定一个模式：--mock 或 --real")
    process.exit(2)
  }
  const numArg = (flag: string, dflt: number): number => {
    const hit = args.find((a) => a.startsWith(`${flag}=`))
    const v = Number(hit?.split("=")[1] ?? dflt)
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt
  }
  const rounds = numArg("--rounds", 10)
  const roundGapMs = numArg("--round-gap-ms", 5000)
  const sampleMs = numArg("--sample-ms", 5000)
  const cancelArg = args.find((a) => a.startsWith("--cancel-round="))
  let cancelRound: number | null = cancelArg ? Number(cancelArg.split("=")[1]) : null
  if (cancelRound !== null && !Number.isFinite(cancelRound)) cancelRound = null
  const model = args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "deepseek-v4-flash"
  const outPath = path.resolve(ROOT, args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "out/soak-result.json")

  // 真实模式：API key 只从环境变量读取；缺失 → blocked + exit 0（不伪造结果）
  const apiKey = process.env.DEEPSEEK_API_KEY ?? ""
  if (isReal && !apiKey) {
    console.log("[soak] real mode blocked: DEEPSEEK_API_KEY not set")
    process.exit(0)
  }
  const realBaseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"
  // 随机注入取消轮（mock/real 都要验证取消收敛；默认取 2..rounds 之间随机一轮）
  if (cancelRound === null) cancelRound = 2 + Math.floor(Math.random() * Math.max(1, rounds - 2))

  // 临时工作区（workDir/docDir/db/artifacts 全部在系统临时目录，不污染工作树）
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "dw-soak-"))
  const workDir = path.join(tmp, "work")
  const docDir = path.join(tmp, "docs")
  await fsp.mkdir(workDir, { recursive: true })
  await fsp.mkdir(docDir, { recursive: true })
  const dbPath = path.join(tmp, "soak.db")

  // 1) mock 模型（本地确定性 SSE；mock 模式才启动）
  let mock: MockSse | null = null
  if (isMock) mock = await startMockSse({ docDir, chunkDelayMs: 40 })

  // 2) 加载项目模块（electron-shim bundle）
  const repoMod = await loadTsModule("src/main/db/repository.ts")
  const adapterMod = await loadTsModule("src/main/runKernelAdapter.ts")
  const ctxMod = await loadTsModule("src/main/contextService.ts")
  const snapMod = await loadTsModule("src/main/executionSnapshot.ts")
  const chatMod = await loadTsModule("src/main/chatStart.ts")
  const engineMod = await loadTsModule("src/main/jobs/AgentRunEngine.ts")

  const createRepository = repoMod.createRepository as (p: string) => RepoLike
  const createRunStorePort = adapterMod.createRunStorePort as (repo: RepoLike, artifactDir?: string) => Record<string, unknown>
  const createModelCallAdapter = adapterMod.createModelCallAdapter as (opts: Record<string, unknown>) => (input: Record<string, unknown>) => Promise<AsyncIterable<Record<string, unknown>>>
  const createToolExecutor = adapterMod.createToolExecutor as (opts: Record<string, unknown>) => (name: string, argsJson: string, toolCallId: string, runId: string) => Promise<string>
  const createChunkTranslator = adapterMod.createChunkTranslator as () => (ev: EngineEventLike, runId: string) => Array<{ type: string }>
  const createContextService = ctxMod.createContextService as (repo: RepoLike) => { assembleRunContext(config: Record<string, unknown>, round: number, live: Array<{ role: string; content: string }>, prefix: Array<{ role: string; content: string }>): Promise<Record<string, unknown>> }
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const buildStaticSystemMessages = snapMod.buildStaticSystemMessages as (snap: Record<string, unknown>) => Array<{ role: "system"; content: string }>
  const startChatRun = chatMod.startChatRun as (deps: Record<string, unknown>, payload: Record<string, unknown>) => Promise<{ runId: string }>
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => EngineLike & { getState(runId: string): Promise<Record<string, unknown>> }

  // 3) 装配真实链路（对齐生产 src/main/index.ts initRunKernel 的接线）
  const repo = createRepository(dbPath)
  repo.open()
  const settings = {
    model,
    baseUrl: isMock ? `http://127.0.0.1:${mock?.port}` : realBaseUrl,
    apiKey: isMock ? "mock-key" : apiKey, // mock 占位 key；real key 仅在内存，绝不落盘/输出
    maxTokens: 1024,
    temperature: 0.8,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: "medium" as const,
    workDir,
    docDir,
    novelMode: false,
    galgame: { enabled: false, projectDir: "", sdkPath: "" },
    historyBudgetTokens: 60000
  }

  const kernelConfigs = new Map<string, Record<string, unknown>>()
  const terminalStatuses = new Map<string, string>()
  const usageEvents = new Map<string, number>()
  const doneChunkCounts = new Map<string, number>()
  const failures: string[] = []
  let checksPassed = 0
  let checksFailed = 0
  const check = (name: string, cond: boolean, detail = ""): void => {
    if (cond) {
      checksPassed++
    } else {
      checksFailed++
      failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
      console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
    }
  }

  // buildPrefix：复制生产 buildRunPrefix（mode profile + 快照记忆；无附件）
  const buildRunPrefix = async (rc: Record<string, unknown>, round: number): Promise<Array<{ role: string; content: string }>> => {
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
    return prefix // 附件仅首轮注入（本脚本无附件）
  }

  // 取消注入：目标 run 进入 writing（流式正文中）后延迟 100ms cancel（mid-stream，可靠收敛）
  let cancelRunId: string | null = null
  let cancelInjected = false
  if (cancelRound !== null) cancelRunId = `soak_r${cancelRound}`

  const storePort = createRunStorePort(repo, path.join(tmp, "artifacts"))
  const contextService = createContextService(repo)
  const translator = createChunkTranslator()
  let engineRef: (EngineLike & { getState(runId: string): Promise<Record<string, unknown>> }) | null = null
  const engine = createAgentRunEngine({
    store: storePort,
    modelCall: createModelCallAdapter({
      getApi: () => ({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        maxTokens: settings.maxTokens,
        thinking: { enabled: false, effort: "medium" as const },
        temperature: 0.8,
        topP: 1
      }),
      buildPrefix: buildRunPrefix,
      getSignal: (runId: string) => engineRef?.abortSignal(runId),
      getConfig: (runId: string) => kernelConfigs.get(runId) ?? {},
      assembleContext: (config: Record<string, unknown>, round: number, live: Array<{ role: string; content: string }>, prefix: Array<{ role: string; content: string }>) => contextService.assembleRunContext(config, round, live, prefix)
    }),
    toolExecutor: createToolExecutor({
      getSignal: (runId: string) => engineRef?.abortSignal(runId),
      getEnv: (runId: string) => ({
        workDir,
        docDir,
        sessionId: (kernelConfigs.get(runId)?.sessionId as string | undefined) ?? "soak",
        signal: engineRef?.abortSignal(runId)
      })
    }),
    getConfig: (runId: string) => kernelConfigs.get(runId) ?? {},
    onEvent: (runId: string, ev: EngineEventLike) => {
      if (ev.type === "phase" && ev.phase === "writing" && runId === cancelRunId && !cancelInjected) {
        cancelInjected = true
        setTimeout(() => {
          void engineRef?.cancel(runId)
        }, 100)
      }
      if (ev.type === "usage") usageEvents.set(runId, (usageEvents.get(runId) ?? 0) + 1)
      if (ev.type === "terminal" && ev.run) {
        terminalStatuses.set(runId, ev.run.status)
        // 会话投影（复制生产 index.ts terminal 投影逻辑：terminal 前落 canonical assistant 消息）
        try {
          const runCfg = JSON.parse(ev.run.configJson ?? "{}") as { sessionId?: unknown }
          if (typeof runCfg.sessionId === "string") {
            const turns = repo.getTurnsByRun(runId)
            const final = [...turns].reverse().find((t) => t.role === "assistant" && (t.content || t.reasoning_content))
            if (final) {
              const existing = repo.getSessionMessages(runCfg.sessionId)
              const mine = existing.find((m) => m.msg_id === `m_${runId}_assistant`)
              repo.appendSessionMessage({
                msg_id: mine?.msg_id ?? `m_${runId}_assistant`,
                session_id: runCfg.sessionId,
                seq: mine?.seq ?? existing.length + 1,
                role: "assistant",
                content: final.content,
                reasoning: final.reasoning_content ?? "",
                status: ev.run.status === "completed" ? "done" : "stopped",
                created_at: mine?.created_at ?? Date.now()
              })
              repo.touchSession(runCfg.sessionId)
            }
          }
        } catch {
          /* 投影失败不阻断（与生产一致） */
        }
      }
      // chunk 转换器（全部 adapter 之一）：terminal 的 done chunk 必须恰好一次
      for (const chunk of translator(ev, runId)) {
        if (chunk.type === "done") doneChunkCounts.set(runId, (doneChunkCounts.get(runId) ?? 0) + 1)
      }
    },
    onRunUpdate: () => undefined
  })
  engineRef = engine

  // 4) 内存采样器（soak 核心指标：内存爬升）
  // R4.6 Gate 5：扩展指标——句柄数/未处理 rejection/DB 大小（win32 句柄近似 _getActiveHandles）
  let unhandledRejections = 0
  process.on('unhandledRejection', () => { unhandledRejections++ })
  const dbSize = (): number => {
    try { return fs.statSync(dbPath).size } catch { return 0 }
  }
  const samples: Array<{ t: number; heap: number; rss: number; handles: number; dbBytes: number; unhandled: number }> = []
  const t0 = Date.now()
  const firstMem = process.memoryUsage()
  samples.push({ t: 0, heap: firstMem.heapUsed, rss: firstMem.rss, handles: (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles?.().length ?? 0, dbBytes: dbSize(), unhandled: unhandledRejections })
  const sampler = setInterval(() => {
    const m = process.memoryUsage()
    samples.push({ t: Date.now() - t0, heap: m.heapUsed, rss: m.rss, handles: (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles?.().length ?? 0, dbBytes: dbSize(), unhandled: unhandledRejections })
  }, sampleMs)

  // 5) 跑 N 轮对话（每轮独立 session，模拟真实使用节奏）
  const prompts = [
    "请续写一段小说章节：主角在雨夜中发现了一封旧信。",
    "请总结刚才剧情要点，列出三条关键伏笔。",
    "请为故事中的角色林默写一段性格描写。",
    "请为下一章拟三个章节标题，并各配一句简介。"
  ]
  const perRoundMs: number[] = []
  const terminalStates: string[] = []
  let completedCount = 0
  let cancelledCount = 0
  let recoveryCount = 0
  let failedCount = 0
  const strict = isMock // mock 模式要求非取消轮全部 completed；real 模式只做通用一致性断言

  const waitForTerminal = async (runId: string, timeoutMs: number): Promise<RunRowLite> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const run = repo.getRun(runId)
      if (run && TERMINAL_STATUSES.has(run.status)) return run
      if (Date.now() > deadline) throw new Error(`等待 run 终态超时: ${runId} status=${run?.status ?? "missing"}`)
      await delay(25)
    }
  }

  for (let i = 1; i <= rounds; i++) {
    const runId = `soak_r${i}`
    const sessionId = `soak_sess_${i}`
    const isCancelRound = runId === cancelRunId
    const payload = {
      id: runId,
      sessionId,
      mode: "agent" as const,
      text: prompts[(i - 1) % prompts.length],
      targetChars: 300,
      longMode: false,
      workspace: "chat",
      phase: "execute" as const,
      planText: "",
      story: null,
      attachments: []
    }
    const config = buildExecutionSnapshot({
      payload,
      settings,
      sessionId,
      memory: { projectPath: "", projectContent: "", userContent: "" }
    }) as unknown as Record<string, unknown>
    kernelConfigs.set(runId, config) // 先于 startChatRun 装载（避免 step 竞态落到 getConfig 兜底）

    const startMs = Date.now()
    await startChatRun(
      {
        repository: repo,
        runKernel: engine,
        loadSettings: async () => settings,
        buildConfig: async () => config
      },
      payload as never
    )
    const run = await waitForTerminal(runId, 120000)
    perRoundMs.push(Date.now() - startMs)
    terminalStates.push(run.status)
    if (run.status === "completed") completedCount++
    else if (run.status === "cancelled") cancelledCount++
    else if (run.status === "recovery_required") recoveryCount++
    else failedCount++

    // ---- DB 断言 ----
    check(`R${i} run 终态（${run.status}）`, TERMINAL_STATUSES.has(run.status), run.status)
    const turns = repo.getTurnsByRun(runId)
    check(`R${i} turns 非空且 turn_seq 从 1 连续`, turns.length > 0 && turns.every((t, idx) => t.turn_seq === idx + 1), `n=${turns.length}`)
    if (isCancelRound) {
      check(`R${i} 取消收敛到 cancelled/recovery_required`, run.status === "cancelled" || run.status === "recovery_required", run.status)
      const last = turns[turns.length - 1]
      if (last && last.role === "assistant" && (last.content?.trim()?.length ?? 0) > 0) {
        const msgs = repo.getSessionMessages(sessionId)
        check(`R${i} 取消 run 有正文则投影存在`, msgs.some((m) => m.msg_id === `m_${runId}_assistant` && m.content.trim().length > 0), "")
      }
    } else if (strict) {
      check(`R${i} 非取消轮终态为 completed`, run.status === "completed", run.status)
      const last = turns[turns.length - 1]
      check(`R${i} 末 turn 为 assistant 且正文非空`, last?.role === "assistant" && (last.content?.trim()?.length ?? 0) > 0, `role=${last?.role} len=${last?.content?.length ?? 0}`)
      check(`R${i} 工具结果 turn 存在（mock 第一轮 tool_call）`, turns.some((t) => t.role === "tool"), "")
      const msgs = repo.getSessionMessages(sessionId)
      const proj = msgs.find((m) => m.msg_id === `m_${runId}_assistant`)
      check(`R${i} session_messages 投影存在且正文非空`, proj !== undefined && proj.content.trim().length > 0, `proj=${proj ? proj.content.length : "missing"}`)
    }
    const tcs = repo.getToolCallsByRun(runId)
    check(`R${i} toolCalls 无未决（无 running/requested/side_effect_unknown）`, tcs.every((t) => !["running", "requested", "side_effect_unknown"].includes(t.status)), JSON.stringify(tcs.map((t) => t.status)))
    // usage 事件只在流正常走到 finish 时产生；被取消的 run 在 usage 前中止 → 仅对 completed 断言
    if (!isCancelRound) {
      check(`R${i} usage 事件 ≥ 1（mock 每轮返回 usage）`, (usageEvents.get(runId) ?? 0) >= 1, `n=${usageEvents.get(runId) ?? 0}`)
    }
    check(`R${i} done chunk 恰好一次（terminal exactly once）`, (doneChunkCounts.get(runId) ?? 0) === 1, `n=${doneChunkCounts.get(runId) ?? 0}`)
    check(`R${i} 引擎 terminal 事件状态与 DB 一致`, terminalStatuses.get(runId) === run.status, `${terminalStatuses.get(runId)} vs ${run.status}`)
    console.log(`  round ${i}/${rounds} → ${run.status} (${Date.now() - startMs}ms)`)

    // 轮间间隔（模拟真实使用节奏；最后一轮不等待）
    if (i < rounds && roundGapMs > 0) await delay(roundGapMs)
  }
  clearInterval(sampler)
  const totalDurationMs = Date.now() - t0

  // 6) 内存统计
  const heapVals = samples.map((s) => s.heap)
  const rssVals = samples.map((s) => s.rss)
  const heapStart = heapVals[0] ?? 0
  const heapPeak = Math.max(...heapVals, 0)
  const rssPeak = Math.max(...rssVals, 0)
  const sortedRounds = [...perRoundMs].sort((a, b) => a - b)

  const summary: SoakSummary = {
    mode: isMock ? "mock" : "real",
    ...(isMock ? { synthetic: true } : { provider: model, endpoint: realBaseUrl }),
    model,
    rounds,
    completed: completedCount,
    cancelled: cancelledCount,
    recoveryRequired: recoveryCount,
    failed: failedCount,
    terminalAll: terminalStates.length === rounds,
    cancelRound,
    perRoundMs,
    roundP50: percentile(sortedRounds, 50),
    roundP95: percentile(sortedRounds, 95),
    heapStartMB: Math.round((heapStart / 1048576) * 100) / 100,
    heapPeakMB: Math.round((heapPeak / 1048576) * 100) / 100,
    heapGrowthMB: Math.round(((heapPeak - heapStart) / 1048576) * 100) / 100,
    rssPeakMB: Math.round((rssPeak / 1048576) * 100) / 100,
    memorySamples: samples.length,
    totalDurationMs,
    generatedAt: new Date().toISOString(),
    checks: { passed: checksPassed, failed: checksFailed, failures }
  }

  // 7) 输出摘要（stdout + --out 文件）
  const outJson = JSON.stringify(summary, null, 2)
  console.log("\n===== Soak 冒烟摘要 =====")
  console.log(outJson)
  await fsp.mkdir(path.dirname(outPath), { recursive: true })
  await fsp.writeFile(outPath, outJson, "utf-8")
  console.log(`\n已写入 ${outPath}`)
  if (isMock) console.log("模式：mock（synthetic，仅验证管道，不得用于性能结论）")
  else console.log(`模式：real（provider=${model} endpoint=${realBaseUrl}；API key 未落盘）`)

  repo.close()
  mock?.server.close()
  try {
    await fsp.rm(tmp, { recursive: true, force: true })
  } catch {
    /* 清理失败忽略 */
  }

  // 8) 退出码：任何断言失败 → 1
  if (checksFailed > 0) {
    console.error(`\n===== Soak 冒烟失败：${checksFailed} 项断言未通过 =====`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`\n===== Soak 冒烟通过：${checksPassed} 项断言全部通过 =====`)
  process.exit(0)
}

main().catch((e) => {
  console.error("[soak] 执行异常：", e)
  process.exit(2)
})
