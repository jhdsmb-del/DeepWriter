import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== DeepWriter R20 写作核心 — Phase C 强制红灯 10 项（任务书 §六） ====================
// 角色：S5 Adversarial Verification。只写/运行会打红的独立测试，禁止参与任何被测实现。
//
// 跨组接口（S1/S2/S4 按此实现，本文件按此断言；当前 HEAD 旧实现这些接口不存在 → 全部红）：
//   - S4 (src/main)：longGenerate 返回 LongGenerateResult{ measuredChars,targetChars,reachedTarget,
//     needsContinuation,partial,roundBudgets }；buildContext summarize 失败不丢历史；
//     buildNovelMaterial 返回 evidence{...wellFormed}；
//     runNovelExport 的 partial 语义（partialContent/partialChars/draftPath/不 emit done）经活路径
//     longGenerateImpl 注入缝离线性验证（writingService 已随 runChat 一并删除，见 R21 Codex P1-04）。
//
// 结构：esbuild + electron-shim 在运行时把 src/main 模块 bundle 成临时 ESM 加载（照抄 eval-runner.ts）。
//       每项「正常 PASS + 注入失败 FAIL」双面验证；任一红项在旧 HEAD 应为 FAIL。
// 通过判定（跑绿约定）：本文件对「新实现」应 10/10 PASS；对「旧实现」应 10/10 FAIL。
//   → 通过 = 全部断言 PASS；但测试框架会打印 expectedOnOldHead 矩阵，便于新旧对比。
//
// 运行：
//   node_modules\.bin\esbuild.cmd scripts/writing-core-red-tests.ts --bundle --format=esm --platform=node --outfile=out/writing-core-red-tests.mjs
//   node out/writing-core-red-tests.mjs
//
// 0 次真实 API 请求：任何 streamChat 依赖都被注入的 mock 覆盖，绝不触碰网络。

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
// R21-R06 主代理应用（S5 patch 语义）：--impl-root <dir> 被测实现源码根（默认=主树根），
// 让同一测试接口离线驱动 git archive 隔离的旧实现，产出真实 old/new matrix（取代硬编码 expectRedOnOldHead）。
const IMPL_ROOT_ARG = (() => {
  const i = process.argv.indexOf("--impl-root")
  return i >= 0 ? process.argv[i + 1] : undefined
})()
const OUT_JSON_ARG = (() => {
  const i = process.argv.indexOf("--out-json")
  return i >= 0 ? process.argv[i + 1] : undefined
})()
const ROOT = IMPL_ROOT_ARG ? path.resolve(IMPL_ROOT_ARG) : path.resolve(__dirname, "..")
const require = createRequire(import.meta.url)
const esbuild = require(require.resolve("esbuild", { paths: [ROOT, __dirname] })) as { build(opts: Record<string, unknown>): Promise<unknown> }

// ---------------- electron-shim（照抄 eval-runner.ts） ----------------

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

// ---------------- 模块加载 ----------------

type DsMessage = { role: string; content: string; tool_calls?: unknown[]; reasoning_content?: string }
type Usage = Record<string, number>

/** 把 src/scripts 下的 TS 模块 bundle 成临时 ESM 加载（自愈清理） */
async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(ROOT, rel)
  const outfile = path.resolve(ROOT, "out", `wcore-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

/** 读 src/main 某文件源码文本（纯静态断言用，不执行） */
function readSource(rel: string): string {
  return fs.readFileSync(path.resolve(ROOT, rel), "utf-8")
}

// ---------------- 结果记录 ----------------

interface RedResult {
  id: string
  name: string
  /** 断言是否通过（对"新实现"应 true） */
  pass: boolean
  /** 本测试在旧 HEAD 上的期望（本文件全部期望 false=红） */
  expectRedOnOldHead: boolean
  detail: string
}

const results: RedResult[] = []

function record(id: string, name: string, pass: boolean, detail: string): void {
  // 本文件 10 项全部为新接口，旧 HEAD 应当红；硬编码期望矩阵与文件头约定一致。
  results.push({ id, name, pass, expectRedOnOldHead: true, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${id} ${name}${detail ? " — " + detail : ""}`)
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

// ---------------- mock 注入工具 ----------------

/**
 * 单次 streamChat 的 mock 返回：一段确定性正文 + usage + finish_reason。
 * 用于经 longGenerate 驱动多轮长文（通过 finish_reason='length' 触发续写）。
 */
function mockStream(opts: {
  text: string
  finishReason?: string
  usage?: Partial<Usage>
  throwAfter?: number // 若 >0，在第 N 次调用后抛错（模拟 abort/断流）
}): (params: unknown, onEvent: ((ev: Record<string, unknown>) => void) | undefined) => Promise<{ finishReason: string | null; usage: Usage | null }> {
  let calls = 0
  const baseUsage: Usage = {
    prompt_tokens: 100,
    completion_tokens: Math.ceil(opts.text.length / 2) + 5,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
    reasoning_tokens: 0
  }
  return async (params: unknown, onEvent) => {
    calls++
    if (opts.throwAfter && calls > opts.throwAfter) {
      throw new Error("mock stream aborted")
    }
    // 逐字 emit text
    for (const ch of opts.text) {
      onEvent?.({ type: "text", delta: ch })
    }
    const usage = { ...baseUsage, ...(opts.usage ?? {}) }
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
    onEvent?.({ type: "usage", usage: { ...usage } })
    onEvent?.({ type: "finish", finishReason: opts.finishReason ?? "stop" })
    return { finishReason: opts.finishReason ?? "stop", usage }
  }
}

// ==================== 测试 1：长文连续多轮每轮 assembledTokens ≤ budget ====================

/** 注入缝探测：S4 契约要求 longGenerate 接受 streamChatImpl 注入（离线测试 seam）。
 *  返回 true 表示本进程注入的 mock streamChatImpl 被 longGenerate 采纳（可离线驱动）；
 *  返回 false 表示 longGenerate 硬编码 streamChat（旧实现），无法离线驱动 → 红。 */
async function probeStreamChatInjection(): Promise<{ injectable: boolean; reason: string }> {
  const deepseek = await loadTsModule("src/main/deepseek.ts")
  const longGenerate = deepseek.longGenerate as ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined
  if (typeof longGenerate !== "function") return { injectable: false, reason: "缺失 longGenerate" }
  let injectedCalled = false
  const mockImpl = async (): Promise<{ finishReason: string; usage: Record<string, number> | null }> => {
    injectedCalled = true
    return {
      finishReason: "stop",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, reasoning_tokens: 0 }
    }
  }
  try {
    await longGenerate({
      params: { apiKey: "x", model: "m", baseUrl: "http://127.0.0.1:9", thinking: { enabled: false }, maxTokens: 8192 },
      messages: [{ role: "system", content: "x" }, { role: "user", content: "写" }],
      maxRounds: 1,
      targetChars: 0,
      contextBudgetTokens: 100000,
      outputReserveTokens: 0,
      streamChatImpl: mockImpl,     // S4 契约注入缝
      _injectStreamChat: mockImpl,  // 备选键名
      onEvent: () => undefined,
      onRound: () => undefined
    })
    if (injectedCalled) return { injectable: true, reason: "采纳注入的 streamChatImpl" }
    return { injectable: false, reason: "忽略注入缝（硬编码 streamChat），走真实 fetch" }
  } catch (e) {
    if (injectedCalled) return { injectable: true, reason: "注入被采纳（但其它环节抛错）" }
    return { injectable: false, reason: `硬编码 streamChat → ${e instanceof Error ? e.message.slice(0, 60) : String(e)}` }
  }
}

async function core01(): Promise<void> {
  const deepseek = await loadTsModule("src/main/deepseek.ts")
  const longGenerate = deepseek.longGenerate as
    | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
    | undefined
  if (typeof longGenerate !== "function") {
    record("C1", "长文连续多轮每轮 assembledTokens ≤ budget（roundBudgets 字段）", false, "缺失接口 longGenerate")
    return
  }
  const inj = await probeStreamChatInjection()
  if (!inj.injectable) {
    record("C1", "长文连续多轮每轮 assembledTokens ≤ budget（roundBudgets 字段）", false,
      `无 streamChatImpl 注入缝（旧实现硬编码 streamChat）：${inj.reason}`)
    return
  }
  let result: Record<string, unknown>
  try {
    // 主代理修复：测试主调用必须传 streamChatImpl（每轮 finishReason=length 驱动多轮循环）
    const mockStream = async (): Promise<{ finishReason: string; usage: Record<string, number> | null }> => ({
      finishReason: "length",
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, reasoning_tokens: 0 }
    })
    result = await longGenerate({
      params: { apiKey: "x", model: "m", baseUrl: "http://127.0.0.1:9", thinking: { enabled: false }, maxTokens: 8192, temperature: 0.8 },
      messages: [{ role: "system", content: "x" }, { role: "user", content: "写 500 字" }],
      maxRounds: 3,
      contextBudgetTokens: 8192,
      outputReserveTokens: 0,
      targetChars: 50000,
      streamChatImpl: mockStream,
      onEvent: () => undefined,
      onRound: () => undefined
    })
  } catch (e) {
    record("C1", "长文连续多轮每轮 assembledTokens ≤ budget（roundBudgets 字段）", false,
      `运行异常：${e instanceof Error ? e.message.slice(0, 80) : String(e)}`)
    return
  }
  // 旧实现返回 { totalUsage, rounds, finalFinishReason }，无 roundBudgets → 红
  const rb = (result as { roundBudgets?: Array<{ round: number; estimatedTokens: number; compressed: boolean; droppedChars: number }> }).roundBudgets
  if (!Array.isArray(rb) || rb.length === 0) {
    record("C1", "长文连续多轮每轮 assembledTokens ≤ budget（roundBudgets 字段）", false, `旧实现返回键=${Object.keys(result).join(",")}（缺 roundBudgets）`)
    return
  }
  // 主代理修复：S4 的 RoundBudgetRecord 无 budget 字段；预算=测试传入的 contextBudgetTokens-outputReserveTokens=8192
  const budget = 8192
  const violated = rb.filter((r) => r.estimatedTokens > budget)
  const allBounded = violated.length === 0 && rb.every((r) => typeof r.estimatedTokens === "number")
  record("C1", "长文连续多轮每轮 assembledTokens ≤ budget（roundBudgets 字段）", allBounded,
    `rounds=${rb.length} budget=${budget} 越界轮数=${violated.length} 首轮=${JSON.stringify(rb[0])}`)
}

// ==================== 测试 2：目标 50k 只生成 10k → runNovelExport 不得 done ====================
// S3 修正：目标函数改为 runNovelExport。注入 mock longGenerateImpl 返回 reachedTarget=false，
// 断言 runNovelExport 不 emit stage='done' 且返回 ok:false / partial 语义。
// 旧实现：runNovelExport 无条件 emit stage='done' 且无注入缝 → 红。

async function core02(): Promise<void> {
  const novelMod = await loadTsModule("src/main/novel.ts")
  const runNovelExport = novelMod.runNovelExport as
    | ((opts: Record<string, unknown>) => Promise<{ ok: boolean; path?: string; usage?: unknown }>)
    | undefined
  if (typeof runNovelExport !== "function") {
    record("C2", "目标 50k 只生成 10k → runNovelExport 不得 done", false, "缺失接口 runNovelExport")
    return
  }
  // 注入缝检测：S4 契约要求 runNovelExport 接受 mock longGenerateImpl（经 opts 注入）。
  // 旧实现直接 import { longGenerate } 硬调用，无注入缝 → 无法离线驱动，本体即红证据。
  let emitted: string[] = []
  let injectedCalled = false
  const onEvent = (ev: { stage: string; error?: string; path?: string }): void => {
    emitted.push(ev.stage)
  }
  // 尝试经 opts 注入 mock longGenerateImpl（若旧实现忽略此字段，则走真实 longGenerate → 硬编码 streamChat → fetch failed）
  const mockLongGenerateImpl = async (): Promise<{
    totalUsage: Record<string, number>; rounds: number; finalFinishReason: string | null
    measuredChars: number; targetChars: number; reachedTarget: boolean; needsContinuation: boolean; partial: boolean; partialContent: string
  }> => {
    injectedCalled = true
    // 模拟：目标 50k 只生成 10k，reachedTarget=false，needsContinuation=true，非中断(partial=false)
    return {
      totalUsage: { prompt_tokens: 100, completion_tokens: 5000, total_tokens: 5100 },
      rounds: 3, finalFinishReason: 'length',
      measuredChars: 10000, targetChars: 50000, reachedTarget: false, needsContinuation: true, partial: false, partialContent: ''
    }
  }
  let okFlag = false
  let runResult: { ok: boolean } | null = null
  let detailSuffix = ""
  try {
    runResult = await runNovelExport({
      sessionId: "s-test",
      format: "md",
      request: [{ role: "system", content: "x" }, { role: "user", content: "写 50k" }],
      materialNote: "素材",
      suggestedName: "novel",
      apiKey: "x",
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      maxTokens: 8192,
      targetChars: 50000,
      onEvent,
      // S4 契约注入缝（旧实现忽略 → 走真实 longGenerate → fetch failed）
      longGenerateImpl: mockLongGenerateImpl,
      _injectLongGenerate: mockLongGenerateImpl
    })
    if (!injectedCalled) {
      // 旧实现忽略注入缝：fetch failed 恰好产生「不 emit done + ok=false」的表象，不能算完成契约成立
      record("C2", "目标 50k 只生成 10k → runNovelExport 不得 done（未达标不 complete）", false,
        `无注入缝（longGenerateImpl 未被采纳）：真实 longGenerate 触发 fetch failed / 保存对话框，emitted=[${emitted.join(",")}]——旧实现不可离线验证=红`)
      return
    }
    // 注入成功（未走真实流）：断言未 emit done 且 ok=false
    const didNotEmitDone = !emitted.includes("done")
    okFlag = didNotEmitDone && runResult.ok === false
    detailSuffix = `注入采纳 emit stages=[${emitted.join(",")}] ok=${runResult.ok}（未达标却${didNotEmitDone ? "未" : "仍"}emit done）`
  } catch (e) {
    // 旧实现：无注入缝 → 走真实 longGenerate → fetch failed 抛错，或无条件 done
    const didEmitDone = emitted.includes("done")
    if (injectedCalled) {
      okFlag = false
      detailSuffix = `注入采纳但抛错：${e instanceof Error ? e.message : String(e)}`
    } else if (didEmitDone) {
      // 旧实现无条件 done（本轮 mock 被忽略但流被真实调用前就 emit done）
      okFlag = false
      detailSuffix = `uncond.done：emitted=[${emitted.join(",")}]（旧实现无条件 emit done）`
    } else {
      // 无注入缝，真实 longGenerate 硬编码 streamChat → 网络失败，无法证明 done 语义（返回体无 done）
      okFlag = false
      detailSuffix = `无注入缝：真实 longGenerate 触发 fetch failed（${e instanceof Error ? e.message : String(e)}），emitted=[${emitted.join(",")}]——旧实现不可离线验证=红`
    }
  }
  record("C2", "目标 50k 只生成 10k → runNovelExport 不得 done（未达标不 complete）", okFlag, detailSuffix)
}

// ==================== 测试 3：maxRounds 耗尽 → needsContinuation/partial ====================

async function core03(): Promise<void> {
  const deepseek = await loadTsModule("src/main/deepseek.ts")
  const longGenerate = deepseek.longGenerate as
    | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
    | undefined
  if (typeof longGenerate !== "function") {
    record("C3", "maxRounds 耗尽 → needsContinuation/partial", false, "缺失接口 longGenerate")
    return
  }
  const inj = await probeStreamChatInjection()
  if (!inj.injectable) {
    record("C3", "maxRounds 耗尽 → needsContinuation/partial", false, `无 streamChatImpl 注入缝：${inj.reason}`)
    return
  }
  let result: Record<string, unknown>
  try {
    const mockStream = async (): Promise<{ finishReason: string; usage: Record<string, number> | null }> => ({
      finishReason: "length",
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, reasoning_tokens: 0 }
    })
    result = await longGenerate({
      params: { apiKey: "x", model: "m", baseUrl: "http://127.0.0.1:9", thinking: { enabled: false }, maxTokens: 8192 },
      messages: [{ role: "system", content: "x" }, { role: "user", content: "写" }],
      maxRounds: 2,
      targetChars: 999999,
      contextBudgetTokens: 100000,
      outputReserveTokens: 0,
      streamChatImpl: mockStream,
      onEvent: () => undefined,
      onRound: () => undefined
    })
  } catch (e) {
    record("C3", "maxRounds 耗尽 → needsContinuation/partial", false,
      `运行异常：${e instanceof Error ? e.message.slice(0, 80) : String(e)}`)
    return
  }
  const r = result as { needsContinuation?: boolean; partial?: boolean; reachedTarget?: boolean; rounds?: number }
  // 任务书 §六.3：maxRounds 耗尽 → needsContinuation/partial（needsContinuation 必真；partial 仅在流中断时为真，二者为或关系）
  const exhausted = r.needsContinuation === true && r.reachedTarget === false
  record("C3", "maxRounds 耗尽 → needsContinuation/partial", exhausted,
    `rounds=${r.rounds} needsContinuation=${r.needsContinuation} partial=${r.partial} reachedTarget=${r.reachedTarget}`)
}

// ==================== 测试 4：summarize 抛错/null/abort → 旧历史不丢 ====================

async function core04(): Promise<void> {
  const ctxMod = await loadTsModule("src/main/context.ts")
  const buildContext = ctxMod.buildContext as
    | ((fixedPrefix: DsMessage[], history: DsMessage[], config: Record<string, unknown>, summarize: (m: DsMessage[]) => Promise<string | null>) => Promise<{ messages: DsMessage[]; dropped: number; summary: string | null }>)
    | undefined
  if (typeof buildContext !== "function") {
    record("C4", "summarize 抛错/返回 null/被 abort → 旧历史不丢", false, "缺失接口 buildContext")
    return
  }
  // R21-R06 主代理应用（S5 patch）：判别「成功裁剪」与「失败保留」的差异，而非绝对保留数。
  //   旧实现：summarize 失败仍执行 history=keptBundles.flat()（半分裁剪），保留数与成功裁剪相同 → 红。
  //   新实现：失败/null 时不半分，仅预算截断，保留数应明显多于成功裁剪。
  const history: DsMessage[] = []
  for (let i = 0; i < 100; i++) {
    history.push({ role: "user", content: `第${i}章：${"很长的正文内容填充".repeat(40)}` })
  }
  const historyMsgCount = history.length

  // total ≈ 36300 tokens；budget=22000 ∈ (total/2=18150, total/1.5=24200)：
  //   成功摘要 → 半分裁剪保留 ~50%；null/抛错 → 新实现仅预算截断保留 ~60%（>50），旧实现仍半分（=50）。
  const config = { historyBudgetTokens: 22000, summarizeOld: true }
  const summarizeOk = async (): Promise<string> => "这是一段摘要内容，概括了被裁剪的旧历史。"
  const ctxSuccess = await buildContext([], history.map((m) => ({ ...m })), config, summarizeOk)
  const ctxThrow = await buildContext([], history.map((m) => ({ ...m })), config, async () => { throw new Error("summarize aborted") })
  const ctxNull = await buildContext([], history.map((m) => ({ ...m })), config, async () => null)

  const keptSuccess = ctxSuccess.messages.filter((m) => m.role === "user" || m.role === "assistant").length
  const keptThrow = ctxThrow.messages.filter((m) => m.role === "user" || m.role === "assistant").length
  const keptNull = ctxNull.messages.filter((m) => m.role === "user" || m.role === "assistant").length
  const throwPreserved = keptThrow >= keptSuccess + 8
  const nullPreserved = keptNull >= keptSuccess + 8
  const preserved = throwPreserved && nullPreserved
  record("C4", "summarize 抛错/返回 null/被 abort → 旧历史不丢", preserved,
    `历史=${historyMsgCount} 成功裁剪保留=${keptSuccess}(dropped=${ctxSuccess.dropped}) 抛错后保留=${keptThrow}(dropped=${ctxThrow.dropped}) 返回null后保留=${keptNull}(dropped=${ctxNull.dropped})`)
}

// ==================== 测试 5：400k+ 素材 → 保留最新剧情 + 锚点 + 裁剪证据 ====================

async function core05(): Promise<void> {
  const novelMod = await loadTsModule("src/main/novel.ts")
  const buildNovelMaterial = novelMod.buildNovelMaterial as
    | ((messages: { role: string; content: string }[], maxChars?: number) => { material: string; truncated: boolean; evidence?: Record<string, unknown> })
    | undefined
  if (typeof buildNovelMaterial !== "function") {
    record("C5", "400k+ 素材 → 保留最新剧情 + 锚点 + 裁剪证据（evidence 完整）", false, "缺失接口 buildNovelMaterial")
    return
  }
  // 600k+ 素材：先塞大量旧内容，末尾放"最新剧情锚点"（3000 条×约 245 字 ≈ 735k 字符，确保触发 400k 截断）
  const anchor = "最新剧情锚点：主角在雾江坝发现真相。"
  const messages: { role: string; content: string }[] = []
  for (let i = 0; i < 3000; i++) {
    messages.push({ role: "user", content: `旧设定${i}：${"前情铺垫内容".repeat(40)}` })
  }
  messages.push({ role: "assistant", content: anchor + "后续正文".repeat(200) })

  const out = buildNovelMaterial(messages, 400000)
  // 主代理修复：对齐 S4 实际 evidence 字段 {originalChars,maxChars,keptIntervals,droppedChars,anchorsKept,wellFormed,keptTailChars}
  const ev = out.evidence as { wellFormed?: boolean; originalChars?: number; maxChars?: number; droppedChars?: number; anchorsKept?: boolean; keptTailChars?: number; keptIntervals?: Array<{ from: number; to: number; reason: string }> } | undefined
  const hasEvidence = !!ev && typeof ev === "object"
  const wellFormed = hasEvidence && ev.wellFormed === true
  const truncated = hasEvidence && typeof ev.droppedChars === "number" && ev.droppedChars > 0
  const anchorKept = hasEvidence && ev.anchorsKept === true
  const hasCounts = hasEvidence && typeof ev.originalChars === "number" && typeof ev.keptTailChars === "number" && (ev.keptTailChars as number) <= (ev.originalChars as number)
  const tailHasLatest = out.material.includes("最新剧情锚点")
  const ok = hasEvidence && wellFormed && truncated && anchorKept && hasCounts && tailHasLatest
  record("C5", "400k+ 素材 → 保留最新剧情 + 锚点 + 裁剪证据（evidence 完整）", ok,
    `返回键=${Object.keys(out).join(",")} evidence=${ev ? JSON.stringify({ wellFormed: ev.wellFormed, droppedChars: ev.droppedChars, anchorsKept: ev.anchorsKept, keptTailChars: ev.keptTailChars }) : "缺失"}`)
}

// ==================== 测试 6：emoji/扩展汉字截断后 wellFormed（无孤立代理项） ====================

// JavaScript 字符串按 UTF-16 码元截断会产生孤立代理项；正确实现按 code point 截断。
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

async function core06(): Promise<void> {
  const novelMod = await loadTsModule("src/main/novel.ts")
  const buildNovelMaterial = novelMod.buildNovelMaterial as
    | ((messages: { role: string; content: string }[], maxChars?: number) => { material: string; truncated: boolean; evidence?: Record<string, unknown> })
    | undefined
  if (typeof buildNovelMaterial !== "function") {
    record("C6", "emoji/扩展汉字截断后 wellFormed（无孤立代理项）", false, "缺失接口 buildNovelMaterial")
    return
  }
  // 用 emoji（UTF-16 代理对）与扩展汉字（BMP 外）填充，故意令上限落在代理对中间
  const emoji = "😂📚🎭"
  const extHan = "𠀀𠀁𠀂" // 扩展 B 区汉字（代理对）
  let content = ""
  while (content.length < 1000) content += emoji + extHan + "正文"
  const out = buildNovelMaterial([{ role: "user", content }], 500) // 500 UTF-16 码元 → 必然可能切断代理对
  const wellFormed = !hasLoneSurrogate(out.material)
  const evWellFormed = (out.evidence as { wellFormed?: boolean } | undefined)?.wellFormed
  // 旧实现：material.slice(0, maxChars) 按码元切 → 可能留下孤立代理项；且无 evidence.wellFormed
  const ok = wellFormed && evWellFormed === true
  record("C6", "emoji/扩展汉字截断后 wellFormed（无孤立代理项）", ok,
    `孤立代理项=${hasLoneSurrogate(out.material)} evidence.wellFormed=${evWellFormed}`)
}

// ==================== 测试 7：流收部分 delta 后断开 → 正式历史无 done 半成品 ====================
// R21 Codex P1-04 改：writingService 已删除（死代码），partial 语义改为「活路径等价断言」——
// 直接驱动 runNovelExport（production 真实入口）的 partial 场景，与 scripts/novel-partial-tests.ts
// 同一断言逻辑（partialContent/partialChars/不 emit done/ok=false）。旧实现无此活路径 → 红。

async function core07(): Promise<void> {
  const novelMod = await loadTsModule("src/main/novel.ts")
  const runNovelExport = novelMod.runNovelExport as
    | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
    | undefined
  if (typeof runNovelExport !== "function") {
    record("C7", "流收部分 delta 后断开 → 正式历史无 done 半成品（partial 语义）", false, "缺失接口 runNovelExport")
    return
  }
  // 构造一段确定正文，longGenerateImpl 先逐字 emit 再抛错（模拟流中断）
  let fullText = ""
  for (let i = 0; i < 20; i++) fullText += `第${i}段：这是已经生成的小说正文内容。`
  fullText += "（流在此中断）"
  let injectedCalled = false
  const mockThrowAfterPartial = async (opts: { onEvent?: (ev: { type: string; delta?: string }) => void }): Promise<never> => {
    injectedCalled = true
    for (const ch of fullText) {
      opts.onEvent?.({ type: "text", delta: ch })
    }
    throw new Error("stream broken mid-flight")
  }
  const emittedStages: string[] = []
  const onEvent = (ev: { stage: string; message?: string; error?: string; path?: string }): void => {
    emittedStages.push(ev.stage)
  }
  try {
    const result = await runNovelExport({
      sessionId: "sess-c7",
      format: "md",
      request: [{ role: "system", content: "小说整理" }, { role: "user", content: "写小说" }],
      suggestedName: "novel",
      apiKey: "x",
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      maxTokens: 8192,
      targetChars: 50000,
      onEvent,
      longGenerateImpl: mockThrowAfterPartial
    })
    if (!injectedCalled) {
      record("C7", "流收部分 delta 后断开 → 正式历史无 done 半成品（partial 语义）", false,
        `longGenerateImpl 未被采纳（旧实现无注入缝）→ 无法离线验证 partial 语义`)
      return
    }
    const partial = result.partial === true
    const partialContent = (result.partialContent as string) ?? ""
    const partialChars = result.partialChars as number
    const contentMatches = partialContent === fullText
    const charsOk = typeof partialChars === "number" && partialChars === Array.from(fullText).length
    const okFalse = result.ok === false
    const noDone = !emittedStages.includes("done")
    const hasErrorStage = emittedStages.includes("error")
    const ok = partial && okFalse && contentMatches && charsOk && noDone && hasErrorStage
    record("C7", "流收部分 delta 后断开 → 正式历史无 done 半成品（partial 语义）", ok,
      `partial=${partial} ok=${result.ok} content匹配=${contentMatches} partialChars=${partialChars}(期望${Array.from(fullText).length}) stages=[${emittedStages.join(",")}]`)
  } catch (e) {
    record("C7", "流收部分 delta 后断开 → 正式历史无 done 半成品（partial 语义）", false,
      `运行异常：${e instanceof Error ? e.message.slice(0, 80) : String(e)}`)
  }
}

// ==================== 测试 8：相同 client request 重放不重复正文 ====================
// S3 修正：幂等由真实入口 startChatRun → acceptChatStart 的 (session_id, client_request_id) 幂等键承担，
// 而非 writingService。断言 acceptChatStart 幂等键存在且「重放 → duplicate 返回既有 run，不重复插正文」。

async function core08(): Promise<void> {
  const repoAbs = path.resolve(ROOT, "src", "main", "db", "repository.ts")
  const repoSrc = readSource("src/main/db/repository.ts")
  const chatSrc = readSource("src/main/chatStart.ts")
  // 幂等键语义：acceptChatStart 内按 (session_id, client_request_id) 查既有 run → duplicate
  const hasIdempotentKey = /client_request_id/.test(repoSrc) && /findRunByClientRequestId/.test(repoSrc) &&
    /reason:\s*['"]duplicate['"]|'duplicate'/.test(repoSrc)
  // startChatRun 用 payload.id 作为 client_request_id 传入 acceptChatStart
  const startUsesIdempotent = /client_request_id:\s*payload\.id|clientRequestId:\s*payload\.id/.test(chatSrc) ||
    /payload\.id/.test(chatSrc)
  // 纯 INSERT 禁止覆盖：runs 表的插入（含幂等键）不得用 OR REPLACE（A-05 原则）。
  // 只检查「插入 runs 表」的语句，忽略 settings_kv/meta 等无关表的合法 OR REPLACE。
  const runsInsertLines = repoSrc.split("\n").filter((l) => /INSERT\s+INTO\s+runs\b/i.test(l))
  const runsUsesOrReplace = runsInsertLines.some((l) => /OR\s+REPLACE/i.test(l))
  const noOrReplace = !runsUsesOrReplace
  const ok = hasIdempotentKey && startUsesIdempotent && noOrReplace
  record("C8", "相同 client request 重放不重复正文（acceptChatStart 幂等键）", ok,
    `幂等键(client_request_id+duplicate)=${hasIdempotentKey} startChatRun传payload.id=${startUsesIdempotent} runs表INSERT无OR_REPLACE=${noOrReplace}`)
}

// ==================== 测试 9：production handler 与 eval candidate 同一 orchestration ====================
// S3 重大发现修正 + R21 Codex P1-04：runChat 是死代码已删除；writingService 一并删除。
// 用户真实入口 = chat:start (registerIpc) → startChatRun → AgentRunEngine → CompletionController。
// 断言对象改为：
//   (a) index.ts 的 registerIpc('chat:start') 块内调用 startChatRun（而非死代码 runChat）；
//   (b) writingService.ts 已不存在 + index.ts 无 writingService import，生产完成判定单一源
//       （AgentRunEngine 引用 CompletionController，无第二份实现）；
//   (c) eval 侧 hardened 变体与生产共用同一 CompletionController 模块（import 路径一致）。

async function core09(): Promise<void> {
  const idxSrc = readSource("src/main/index.ts")
  const wsAbs = path.resolve(ROOT, "src", "main", "writingService.ts")
  const wsExists = fs.existsSync(wsAbs)

  // (a) chat:start 生产 handler 调用 startChatRun：提取 registerIpc('chat:start', ...) 块，断言块内出现 startChatRun
  const chatStartMatch = idxSrc.match(/registerIpc\(\s*['"]chat:start['"]\s*,/s)
  let chatStartUsesStartChatRun = false
  if (chatStartMatch) {
    // 取从 chat:start 匹配点到下一个 registerIpc 之间（handler 块）的文本
    const from = chatStartMatch.index ?? 0
    const rest = idxSrc.slice(from)
    const nextIpc = rest.search(/\nregisterIpc(?:On)?\(/)
    const block = nextIpc >= 0 ? rest.slice(0, nextIpc) : rest
    chatStartUsesStartChatRun = /startChatRun/.test(block)
  } else {
    chatStartUsesStartChatRun = false
  }
  // runChat 是死代码（已删除）：chat:start 块内不应再出现 runChat
  const blockUsesRunChat = (() => {
    if (!chatStartMatch) return false
    const from = chatStartMatch.index ?? 0
    const rest = idxSrc.slice(from)
    const nextIpc = rest.search(/\nregisterIpc(?:On)?\(/)
    const block = nextIpc >= 0 ? rest.slice(0, nextIpc) : rest
    return /runChat/.test(block)
  })()

  // (b) writingService.ts 已删除 + index.ts 无 writingService import；生产完成判定单一源：
  //     AgentRunEngine 引用 CompletionController（物理文件 src/main/completion/CompletionController.ts）。
  const wsGone = !wsExists
  const idxImportsWritingService = /from\s+['"]\.\/writingService['"]/.test(idxSrc)
  const agentEngineSrc = readSource("src/main/jobs/AgentRunEngine.ts")
  const prodUsesCc = /CompletionController/.test(agentEngineSrc) && /completion\/CompletionController/.test(agentEngineSrc)

  // (c) eval 侧与生产共用同一 CompletionController 模块（物理文件 src/main/completion/CompletionController.ts）
  // 生产侧 jobs/AgentRunEngine.ts 已 import '../completion/CompletionController'；
  // eval 侧（hardened 变体）必须引用同一模块（任意相对路径写法），否则 = 存在第二份完成判定。
  const evalRunnerSrc = readSource("scripts/eval-runner.ts")
  const evalVariantsSrc = readSource("scripts/eval-variants.ts")
  const evalUsesCc = /CompletionController/.test(evalRunnerSrc) || /CompletionController/.test(evalVariantsSrc)
  const aOk = chatStartUsesStartChatRun && !blockUsesRunChat
  const bOk = wsGone && !idxImportsWritingService && prodUsesCc
  const cOk = prodUsesCc && evalUsesCc
  const ok = aOk && bOk && cOk
  record("C9", "production handler 与 eval candidate 同一 orchestration（chat:start→startChatRun→CompletionController）", ok,
    `(a)chat:start→startChatRun=${chatStartUsesStartChatRun} 且块内无runChat=${!blockUsesRunChat}；(b)writingService已删除=${wsGone} index无writingService import=${!idxImportsWritingService} 生产AgentRunEngine引用CC=${prodUsesCc}；(c)生产共用CC=${prodUsesCc} eval共用CC=${evalUsesCc}`)
}

// ==================== 测试 10：普通短对话 targetChars=0 不受长文完成契约误伤 ====================
// S3 修正：断言对象改 longGenerate 直接（不依赖 writingService 的 chat 语义）。
// targetChars=0 时 reachedTarget 必须 true（无目标阈值，不得误判 needsContinuation）。

async function core10(): Promise<void> {
  const deepseek = await loadTsModule("src/main/deepseek.ts")
  const longGenerate = deepseek.longGenerate as
    | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
    | undefined
  if (typeof longGenerate !== "function") {
    record("C10", "targetChars=0 时 reachedTarget=true（短对话不误伤）", false, "缺失接口 longGenerate")
    return
  }
  const inj = await probeStreamChatInjection()
  if (!inj.injectable) {
    record("C10", "targetChars=0 时 reachedTarget=true（短对话不误伤）", false, `无 streamChatImpl 注入缝：${inj.reason}`)
    return
  }
  try {
    // 主代理修复：主调用传 streamChatImpl（finishReason=stop → 单轮完成，短对话不被阻断）
    const mockStream = async (): Promise<{ finishReason: string; usage: Record<string, number> | null }> => ({
      finishReason: "stop",
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, reasoning_tokens: 0 }
    })
    const result = await longGenerate({
      params: { apiKey: "x", model: "m", baseUrl: "http://127.0.0.1:9", thinking: { enabled: false }, maxTokens: 8192 },
      messages: [{ role: "system", content: "x" }, { role: "user", content: "写" }],
      maxRounds: 3,
      targetChars: 0,
      contextBudgetTokens: 100000,
      outputReserveTokens: 0,
      streamChatImpl: mockStream,
      onEvent: () => undefined,
      onRound: () => undefined
    })
    const r = result as { reachedTarget?: boolean; needsContinuation?: boolean; targetChars?: number }
    // targetChars=0：reachedTarget 必须 true，且不得 needsContinuation（短对话不被长文契约阻断）
    const reachedTrue = r.reachedTarget === true
    const noContinuation = r.needsContinuation !== true
    const ok = reachedTrue && noContinuation
    record("C10", "targetChars=0 时 reachedTarget=true（短对话不误伤）", ok,
      `reachedTarget=${r.reachedTarget} needsContinuation=${r.needsContinuation}（旧实现返回键=${Object.keys(result).join(",")}）`)
  } catch (e) {
    // 旧实现无 reachedTarget 字段 / 硬编码 streamChat → fetch failed → 红
    record("C10", "targetChars=0 时 reachedTarget=true（短对话不误伤）", false,
      `旧实现无 reachedTarget 语义或硬编码 streamChat：${e instanceof Error ? e.message.slice(0, 80) : String(e)}`)
  }
}

// ==================== main ====================

async function main(): Promise<void> {
  console.log(`===== writing-core-red-tests：Phase C 强制红灯 10 项（impl-root=${ROOT}） =====`)
  await core01()
  await core02()
  await core03()
  await core04()
  await core05()
  await core06()
  await core07()
  await core08()
  await core09()
  await core10()

  const passed = results.filter((r) => r.pass)
  const failed = results.filter((r) => !r.pass)
  console.log("")
  console.log(`===== writing-core-red-tests done: ${passed.length} PASS / ${failed.length} FAIL =====`)
  for (const r of results) {
    console.log(`  ${r.pass ? "GREEN" : "RED"}  ${r.id}  ${r.name}`)
  }

  // R21-R06：结构化矩阵导出（供主代理把「旧实现」与「新实现」两次运行的 actual 合并成 old/new matrix）。
  // 不再硬编码 expectRedOnOldHead：红证据必须来自本脚本对 --impl-root 指向实现的真实执行结果。
  if (OUT_JSON_ARG) {
    const outAbs = path.isAbsolute(OUT_JSON_ARG) ? OUT_JSON_ARG : path.resolve(process.cwd(), OUT_JSON_ARG)
    const rows = results.map((r) => ({
      id: r.id,
      name: r.name,
      actual: { exitCode: r.pass ? 0 : 1, failed: !r.pass, detail: r.detail }
    }))
    try {
      fs.writeFileSync(outAbs, JSON.stringify({ rows }, null, 2), "utf-8")
      console.log(`矩阵已写入：${outAbs}`)
    } catch (e) {
      console.error(`写 --out-json 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (failed.length > 0) {
    console.error("FAILED:", failed.map((f) => `${f.id} ${f.name}`).join("; "))
    // 对新实现 exit 1 = 未满足新接口（红证据）；对旧实现 exit 1 = 预期红（旧实现确证缺失接口）。
    process.exit(1)
  }
  console.log("all 10 green on current implementation (impl-root)")
}

main().catch((e) => {
  console.error("writing-core-red-tests 执行异常：", e)
  process.exit(2)
})
