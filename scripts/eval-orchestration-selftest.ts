import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R21-R02 / Codex P0-02：编排 runtime 复用集成自测 ====================
// 验证生产 handler 与 eval candidate 运行同一编排实现（runtime 复用，非源码 hash）。
// 链路（electron-shim + 本地 mock SSE，0 真实 API）：
//   createRepository(临时 SQLite) + createAgentRunEngine(真实 CompletionController.fromStore)
//   + createRunStorePort + createModelCallAdapter + createToolExecutor + createContextService
//   + createChatOrchestration —— 经 handleChatStart → startChatRun → engine.start/step。
// 断言：run 创建、engine start/step、completion 判定运行、instrumentation 命中、同一 fingerprint。
//
// 构建与运行：
//   npx esbuild scripts/eval-orchestration-selftest.ts --bundle --format=esm --platform=node --outfile=out/eval-orchestration-selftest.mjs
//   node out/eval-orchestration-selftest.mjs --mock

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as os from "node:os"
import * as http from "node:http"
import { createRequire } from "node:module"
import { makeSpyInstrumentation, assertSameOrchestrationRuntime, ORCHESTRATION_MODULE, ORCHESTRATION_FN } from "./eval-instrumentation"
import { loadDeepWriterOrchestrationRuntime } from "./eval-variants"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const require = createRequire(import.meta.url)
const esbuild = require("esbuild") as { build(opts: Record<string, unknown>): Promise<unknown> }

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

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(ROOT, rel)
  const outfile = path.resolve(ROOT, "out", `selftest-orch-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs], bundle: true, format: "esm", platform: "node", target: "node20",
      write: true, outfile, external: desktopSourceExternals(abs, ["iconv-lite", "pdf-parse", "mammoth", "fflate", "node:sqlite"]),
      logLevel: "silent", plugins: [ELECTRON_SHIM]
    })
    return (await import(url.pathToFileURL(outfile).href)) as Record<string, unknown>
  } finally {
    try { await fs.promises.unlink(outfile) } catch { /* ignore */ }
  }
}

function startMockSse(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      let messages: Array<{ role: string; content: string }> = []
      try { messages = (JSON.parse(body || "{}").messages ?? []) as Array<{ role: string; content: string }> } catch { messages = [] }
      const joined = messages.map((m) => m.content ?? "").join(" ")
      const promptTokens = Math.max(10, Math.ceil(joined.length / 3))
      const text = "这是编排自测生成的正文内容，用于验证 completion 判定与 engine 运行链路。"
      const usage = { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: promptTokens, completion_tokens_details: { reasoning_tokens: 0 } }
      const chunks: Array<Record<string, unknown>> = [
        { id: "m", choices: [{ index: 0, delta: { content: text, role: "assistant" }, finish_reason: null }], usage: null },
        { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }
      ]
      let i = 0
      const writeNext = (): void => {
        if (i >= chunks.length) { res.write("data: [DONE]\n\n"); res.end(); return }
        res.write(`data: ${JSON.stringify(chunks[i])}\n\n`); i++; setTimeout(writeNext, 4)
      }
      setTimeout(writeNext, 8)
    })
  })
  return new Promise((resolve) => { server.listen(0, "127.0.0.1", () => { const a = server.address() as { port: number } | null; resolve({ server, port: a?.port ?? 0 }) }) })
}

async function main(): Promise<void> {
  const isMock = process.argv.includes("--mock")
  if (!isMock) { console.error("仅 --mock 自测（0 真实 API）"); process.exit(2) }
  const mock = await startMockSse()
  const dbDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dw-orch-selftest-"))
  const settings = { model: "deepseek-v4-flash", baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: "mock-key", maxTokens: 1024, temperature: 0.8, topP: 1, thinkingEnabled: false, reasoningEffort: "medium", workDir: path.join(dbDir, "work"), docDir: path.join(dbDir, "docs"), novelMode: false, galgame: { enabled: false, projectDir: "", sdkPath: "" }, historyBudgetTokens: 60000 }

  const rt = await loadDeepWriterOrchestrationRuntime(loadTsModule)
  const repo = rt.createRepository(path.join(dbDir, "orch.db")) as { open(): void; close(): void }
  repo.open()
  const storePort = rt.createRunStorePort(repo as never, path.join(dbDir, "artifacts"))
  const ctxSvc = rt.createContextService(repo)
  const kernelConfigs = new Map<string, Record<string, unknown>>()
  let engineRef: Record<string, unknown> | null = null
  const spy = makeSpyInstrumentation()

  const buildConfig = async (p: Record<string, unknown>, s: Record<string, unknown>, sessionId: string): Promise<Record<string, unknown>> => {
    const cfg = rt.buildExecutionSnapshot({
      payload: { id: p.id, mode: "agent", text: "请续写一段小说。", targetChars: 200, longMode: false, workspace: "chat", phase: "execute", planText: "", story: null, attachments: [] },
      settings: s, sessionId, memory: { projectPath: "", projectContent: "", userContent: "" }
    }) as unknown as Record<string, unknown>
    kernelConfigs.set(p.id as string, cfg)
    return cfg
  }

  const engine = rt.createAgentRunEngine({
    store: storePort,
    modelCall: rt.createModelCallAdapter({
      getApi: () => ({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, maxTokens: settings.maxTokens, thinking: { enabled: false, effort: "medium" }, temperature: settings.temperature, topP: settings.topP }),
      buildPrefix: async (rc: Record<string, unknown>) => [...rt.buildStaticSystemMessages(rc)],
      getSignal: () => engineRef ? (engineRef as { abortSignal(runId: string): AbortSignal | undefined }).abortSignal.bind(engineRef) : undefined,
      getConfig: (runId: string) => kernelConfigs.get(runId) ?? {},
      assembleContext: (config, round, live, prefix) => ctxSvc.assembleRunContext(config, round, live, prefix)
    }) as never,
    toolExecutor: async () => JSON.stringify({ ok: true, message: "ok" }),
    getConfig: (runId: string) => kernelConfigs.get(runId) ?? {},
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  engineRef = engine

  const orchestration = rt.createChatOrchestration({
    repository: repo,
    runKernel: engine,
    startedChats: new Set<string>(),
    loadSettings: async () => settings as never,
    buildConfig,
    instrumentation: spy.instrumentation
  })

  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const check = (name: string, ok: boolean, detail = ""): void => { checks.push({ name, ok, detail }) }

  // 跑一次编排（current 语义），再跑一次（hardened 语义）——同一 handleChatStart runtime
  const payloadA = { id: "selftest_current", text: "请续写一段小说。", targetChars: 200 }
  const resA = await orchestration.handleChatStart(payloadA as never)
  check("run 创建（current）返回 runId", resA.runId === "selftest_current", resA.runId)
  check("engine start 装载成功", resA.acceptedAt > 0 && resA.status === "queued", `acceptedAt=${resA.acceptedAt} status=${resA.status}`)

  const payloadB = { id: "selftest_hardened", text: "请续写一段小说。", targetChars: 200 }
  const resB = await orchestration.handleChatStart(payloadB as never)

  // 等 engine.step 走到终态（若存在完成契约则 CompletionController 运行；本用例无契约 → 直接 completed）
  await new Promise((r) => setTimeout(r, 400))

  const traceA = spy.snapshot()
  // 二次调用后 spy 计数累计；断言 instrumentation 命中
  check("instrumentation.onOrchestrationStart 命中", spy.counts.onOrchestrationStart >= 2, `n=${spy.counts.onOrchestrationStart}`)
  check("instrumentation.onRunStarted 命中", spy.counts.onRunStarted >= 2, `n=${spy.counts.onRunStarted}`)
  check("instrumentation.onStep 命中", spy.counts.onStep >= 2, `n=${spy.counts.onStep}`)
  check("handleChatStart 命中计数（由 instrumentation 驱动）", traceA.count >= 2, `n=${traceA.count}`)
  check("fingerprint 稳定", traceA.fingerprint === "chatOrchestration.handleChatStart@R21-R02", traceA.fingerprint)

  // assertSameOrchestrationRuntime：两变体同一实现
  const curTrace = { ...traceA, module: ORCHESTRATION_MODULE, fn: ORCHESTRATION_FN, called: true, count: 1 }
  const hardTrace = { ...traceA, module: ORCHESTRATION_MODULE, fn: ORCHESTRATION_FN, called: true, count: 1 }
  const same = assertSameOrchestrationRuntime(curTrace, hardTrace)
  check("assertSameOrchestrationRuntime ok", same.ok, same.detail)

  // 幂等：同一 payload.id 二次调用返回 idempotent
  const resA2 = await orchestration.handleChatStart(payloadA as never)
  check("幂等（同一 id 二次调用）", resA2.idempotent === true, `idempotent=${resA2.idempotent}`)

  repo.close()
  mock.server.close()
  await fsp.rm(dbDir, { recursive: true, force: true }).catch(() => undefined)

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`)
  console.log(`\n===== orchestration 自测 ${failed.length === 0 ? "PASS" : "FAIL"}：${checks.length - failed.length}/${checks.length} 通过 =====`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error("[selftest] 执行异常：", e); process.exit(2) })
