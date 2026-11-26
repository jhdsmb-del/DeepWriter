// ==================== eval-variants.ts：三组同模型对照 variant ====================
// 三个 variant 的代码边界（必须可审计）：
//
//   generic_baseline    ：完全不加载 src/main 任何模块（0 import）。node 全局 fetch 直接
//                         POST {baseUrl}/chat/completions（OpenAI 兼容），system 是固定中性通用指令，
//                         messages = [system, ...任务消息]，sampling 与另两组一致。
//   deepwriter_current_product   ：照抄 benchmark-real.ts 的链——electron-shim bundle 加载
//                         src/main/db/repository.ts / executionSnapshot.ts / contextService.ts /
//                         runKernelAdapter.ts；executionSnapshot.buildExecutionSnapshot(payload.mode="agent")
//                         → buildStaticSystemMessages → contextService.assembleRunContext →
//                         createModelCallAdapter。走普通 Agent 真实上下文/快照/模型适配路径。
//   deepwriter_hardened_candidate：同一 runKernelAdapter 链，payload.mode 用任务对应垂类
//                         （longform→longwrite 且 longMode=true、character→agent+story 契约、
//                         style→style、renpy→longwrite+story(renpy) 契约、failure-recovery→longwrite）。
//                         R22 口径：renpy 任务为聊天正文生成（只输出 .rpy 文本），不走 galgame
//                         工程 fail-closed 契约（要求真实 renpy 产物 + SDK lint 证据，mock 不得伪造）。
//
// variantContractHash = sha256(JSON.stringify({ mode, longMode, systemMessages, sampling }))
// 其中 systemMessages 是"实际组装出的 system 消息数组"。
// 三组的 system 契约允许不同（这是被测变量）；若 normal 与 specialized 实际组出的 system
// messages 完全相同，必须如实报告——这正是红灯 1 的观察点。

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as nodePath from "node:path"
import type { EvalTask } from "./eval-schema"
import { roleHash, systemHash, assembledHash, historyHash, type ProviderAttemptInfo } from "./eval-schema"

export type VariantId = "generic_baseline" | "deepwriter_current_product" | "deepwriter_hardened_candidate"
export const VARIANT_IDS: VariantId[] = ["generic_baseline", "deepwriter_current_product", "deepwriter_hardened_candidate"]

/** 单条 raw 字符串的 sha256 hex（本文件 local helper，不 import scripts/eval-schema 的私有 sha256） */
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

/** history 切片（与 eval-schema.historyHash 同口径）：最后一条 user 之前的 user/assistant 消息 */
function historyTurns(messages: Array<{ role: string; content?: string }>): Array<{ role: string; content: string }> {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break }
  }
  return lastUserIdx > 0
    ? messages.slice(0, lastUserIdx).filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content ?? "" }))
    : []
}

/** 三组共用的采样参数（完全相同，保证同模型对照口径一致） */
export interface SamplingParams {
  temperature: number
  topP: number
  maxTokens: number
  thinkingEnabled: boolean
}

export const DEFAULT_SAMPLING: SamplingParams = { temperature: 0.9, topP: 1, maxTokens: 8192, thinkingEnabled: false }

/** variant 组装出的"契约"——被 hash 的对象 */
export interface VariantContract {
  variantId: VariantId
  /** 实际生效的垂类 mode（generic 为 "generic"；normal 固定 "agent"；specialized 为任务 mode） */
  mode: string
  longMode: boolean
  /** 实际组装出的 system 消息数组（被测变量） */
  systemMessages: Array<{ role: string; content: string }>
  sampling: SamplingParams
}

/** 计算 variantContractHash（与回执/样本/manifest 一致） */
export function variantContractHash(c: VariantContract): string {
  return createHash("sha256")
    .update(JSON.stringify({ mode: c.mode, longMode: c.longMode, systemMessages: c.systemMessages, sampling: c.sampling }))
    .digest("hex")
}

/** 任务 category → 垂类映射（供 specialized 与校验审计使用） */
export function modeForTask(task: EvalTask): { mode: string; longMode: boolean } {
  return { mode: task.mode, longMode: task.longMode }
}

/**
 * R20 Phase B（主代理整合）：hardened 变体与生产共用同一 CompletionController 模块——
 * 不复制判定算法，只读取其源码哈希作为契约证据（红灯 9(c) 断言 eval 侧引用该模块）。
 *
 * R21-R02 / Codex P0-02 升级：源码 hash 已不作为 runtime 复用的权威证据（P0-02 判定 FAIL：
 * "读源码 hash 冒充 runtime 复用"）。真正的 runtime 复用证据由 loadDeepWriterOrchestrationRuntime
 * 提供——它 electron-shim bundle 加载 src/main/chatOrchestration.ts + jobs/AgentRunEngine.ts
 * + completion/CompletionController.ts 并**真实实例化运行**，通过 orchestration.handleChatStart
 * 记录 instrumentation 计数。本 hash 函数仅保留作为源码指纹（供 manifest 审计），不再冒充 runtime 证据。
 */
export function completionControllerSourceHash(projectRoot: string): string {
  try {
    const p = nodePath.join(projectRoot, "src", "main", "completion", "CompletionController.ts")
    if (!fs.existsSync(p)) return ""
    return createHash("sha256").update(fs.readFileSync(p, "utf-8")).digest("hex")
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// R21-R02 / Codex P0-02：runtime 编排复用（生产 handler 与 eval candidate 同一实现）
// ---------------------------------------------------------------------------

/** loadDeepWriterOrchestrationRuntime 的装配结果：一个能真实运行 handleChatStart 的编排句柄 */
export interface DeepWriterOrchestrationRuntime {
  /** src/main/chatOrchestration.ts 的 createChatOrchestration（真实 module export） */
  createChatOrchestration: (deps: Record<string, unknown>) => {
    handleChatStart(payload: Record<string, unknown>): Promise<{ runId: string; acceptedAt: number; status: string; idempotent: boolean }>
    __orchestrationFingerprint: string
  }
  /** src/main/sessionProjection.ts 的 projectTerminalAssistant（生产 terminal 投影唯一权威实现） */
  projectTerminalAssistant: (deps: Record<string, unknown>, runId: string, sessionId: string, runStatus: string) => { ok: boolean; projected: boolean; msgId?: string; reason?: string }
  /** src/main/sessionProjection.ts 的 composeRunAssistantContent（多轮 assistant 正文/理由组合，R24 P0-02） */
  composeRunAssistantContent: (turns: Array<{ role: string; content: string; reasoning_content?: string | null; turn_seq?: number }>) => { content: string; reasoning: string; turnCount: number; turnChars: number[]; turnHashes: string[] }
  /** src/main/db/repository.ts 的 createRepository */
  createRepository: (dbPath: string) => Record<string, unknown>
  /** src/main/jobs/AgentRunEngine.ts 的 createAgentRunEngine */
  createAgentRunEngine: (opts: Record<string, unknown>) => Record<string, unknown>
  /** src/main/runKernelAdapter.ts 的 createRunStorePort / createModelCallAdapter / createToolExecutor */
  createRunStorePort: (repo: Record<string, unknown>, artifactDir?: string) => Record<string, unknown>
  createModelCallAdapter: (opts: Record<string, unknown>) => (input: Record<string, unknown>) => Promise<AsyncIterable<Record<string, unknown>>>
  createToolExecutor: (opts: Record<string, unknown>) => (name: string, argsJson: string, toolCallId: string, runId: string) => Promise<string>
  /** src/main/contextService.ts 的 createContextService */
  createContextService: (repo: Record<string, unknown>) => { assembleRunContext(config: Record<string, unknown>, round: number, live: Array<{ role: string; content: string }>, prefix: Array<{ role: string; content: string }>): Promise<Record<string, unknown>> }
  /** src/main/executionSnapshot.ts 的 buildExecutionSnapshot / buildStaticSystemMessages */
  buildExecutionSnapshot: (input: Record<string, unknown>) => Record<string, unknown>
  deriveProviderCallBudget: import('./eval-execution-budget').EvaluationSnapshotRuntime['deriveProviderCallBudget']
  buildStaticSystemMessages: (snap: Record<string, unknown>) => Array<{ role: "system"; content: string }>
  /** src/main/completion/CompletionController.ts 的 CompletionController（真实类，非 hash） */
  CompletionController: unknown
}

/**
 * R21-R02 / Codex P0-02：加载并真实装配生产编排链（electron-shim bundle）。
 * 关键区别于旧 loadDeepChain：这里同时加载 chatOrchestration.ts 与 CompletionController.ts，
 * 使 eval candidate 能以**运行时**方式（真实 handleChatStart → startChatRun → engine.start，
 * 其中 engine 真实实例化 CompletionController.fromStore）命中生产同一实现——而非读源码 hash。
 */
export async function loadDeepWriterOrchestrationRuntime(
  loadTsModule: (rel: string) => Promise<Record<string, unknown>>
): Promise<DeepWriterOrchestrationRuntime> {
  const [orchMod, repoMod, engineMod, adapterMod, ctxMod, snapMod, ccMod, projMod] = await Promise.all([
    loadTsModule("src/main/chatOrchestration.ts"),
    loadTsModule("src/main/db/repository.ts"),
    loadTsModule("src/main/jobs/AgentRunEngine.ts"),
    loadTsModule("src/main/runKernelAdapter.ts"),
    loadTsModule("src/main/contextService.ts"),
    loadTsModule("src/main/executionSnapshot.ts"),
    loadTsModule("src/main/completion/CompletionController.ts"),
    loadTsModule("src/main/sessionProjection.ts")
  ])

  return {
    createChatOrchestration: orchMod.createChatOrchestration as DeepWriterOrchestrationRuntime["createChatOrchestration"],
    projectTerminalAssistant: projMod.projectTerminalAssistant as DeepWriterOrchestrationRuntime["projectTerminalAssistant"],
    composeRunAssistantContent: projMod.composeRunAssistantContent as DeepWriterOrchestrationRuntime["composeRunAssistantContent"],
    createRepository: repoMod.createRepository as DeepWriterOrchestrationRuntime["createRepository"],
    createAgentRunEngine: engineMod.createAgentRunEngine as DeepWriterOrchestrationRuntime["createAgentRunEngine"],
    createRunStorePort: adapterMod.createRunStorePort as DeepWriterOrchestrationRuntime["createRunStorePort"],
    createModelCallAdapter: adapterMod.createModelCallAdapter as DeepWriterOrchestrationRuntime["createModelCallAdapter"],
    createToolExecutor: adapterMod.createToolExecutor as DeepWriterOrchestrationRuntime["createToolExecutor"],
    createContextService: ctxMod.createContextService as DeepWriterOrchestrationRuntime["createContextService"],
    buildExecutionSnapshot: snapMod.buildExecutionSnapshot as DeepWriterOrchestrationRuntime["buildExecutionSnapshot"],
    deriveProviderCallBudget: snapMod.deriveProviderCallBudget as DeepWriterOrchestrationRuntime["deriveProviderCallBudget"],
    buildStaticSystemMessages: snapMod.buildStaticSystemMessages as DeepWriterOrchestrationRuntime["buildStaticSystemMessages"],
    CompletionController: ccMod.CompletionController as unknown
  }
}

/**
 * deepwriter_hardened_candidate 的 story 契约：character 类通过 story 引擎在 system 契约上与 normal 区分。
 * story.enabled=true 会让 executionSnapshot 用 buildStorySystemPrompt 覆盖 mode 的默认 systemPrompt。
 * renpy 类同理由 story 引擎提供 Ren'Py 语法输出契约（outputFormat=renpy）——R22 主代理口径：
 * renpy-scene-branch 是聊天正文生成任务（只输出 .rpy 文本），不走 galgame 工程 fail-closed 契约
 * （该契约要求真实 renpy 产物 + SDK lint 证据，mock 环境无法且不得伪造），故任务 mode=longwrite。
 * 其它类别（style/longwrite）本身已有各自 mode 的独立 systemPrompt，天然区分于 normal 的 agent。
 */
export function buildSpecializedStory(task: EvalTask, baseDir: string): Record<string, unknown> | null {
  if (task.category !== "character-consistency" && task.category !== "renpy") return null
  // 从 characters.json 读角色卡并映射到 StoryConfig
  let characters: Array<{ name: string; role: string; traits: string; motivation: string; voice: string }> = []
  try {
    const charsJson = JSON.parse(fs.readFileSync(nodePath.join(baseDir, "materials", "characters.json"), "utf-8")) as {
      characters?: Array<{ name?: string; role?: string; traits?: string; motivation?: string; voice?: string }>
    }
    characters = (charsJson.characters ?? []).map((c) => ({
      name: c.name ?? "",
      role: c.role ?? "",
      traits: c.traits ?? "",
      motivation: c.motivation ?? "",
      voice: c.voice ?? ""
    }))
  } catch {
    characters = []
  }
  return {
    enabled: true,
    genre: "悬疑推理",
    intensity: "standard",
    structure: "three-act",
    // renpy 类：Ren'Py 剧本输出契约（story.ts 在 outputFormat=renpy 时注入 RENPY_SYNTAX）
    outputFormat: task.category === "renpy" ? "renpy" : "novel",
    tone: "冷峻、克制",
    characters,
    worldSetting: "南方小城岚城，雾江坝旧案"
  }
}

/** 固定中性通用 system prompt（generic_baseline 用；不依赖 src/main） */
export const GENERIC_SYSTEM_PROMPT = "你是一名写作助手，按要求完成任务。只输出用户要求的正文/大纲/脚本，不输出任何解释、说明或额外文字。"

/**
 * generic_baseline：完全不加载 src/main。直接 fetch OpenAI 兼容 SSE（或 mock）。
 * 返回契约 + 一个可复用的"调用函数"（runner 用它逐轮请求）。
 */
export async function buildGenericBaseline(opts: {
  baseUrl: string
  apiKey: string
  model: string
  sampling: SamplingParams
  /** provider 边界 request-attempt 回调（runner 补齐标识后并入 ledger） */
  onAttempt?: (info: ProviderAttemptInfo) => void
}): Promise<{
  contract: VariantContract
  invoke: (messages: Array<{ role: string; content: string }>) => Promise<AsyncIterable<GenericChunk>>
}> {
  const contract: VariantContract = {
    variantId: "generic_baseline",
    mode: "generic",
    longMode: false,
    systemMessages: [{ role: "system", content: GENERIC_SYSTEM_PROMPT }],
    sampling: opts.sampling
  }
  const invoke = async (messages: Array<{ role: string; content: string }>) => {
    const full = [contract.systemMessages[0], ...messages]
    return streamOpenAiCompatible({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: full,
      sampling: opts.sampling,
      onAttempt: opts.onAttempt
    })
  }
  return { contract, invoke }
}

/** OpenAI 兼容 SSE 流式（generic variant 用；不依赖 src/main） */
async function* streamOpenAiCompatible(opts: {
  baseUrl: string
  apiKey: string
  model: string
  messages: Array<{ role: string; content: string }>
  sampling: SamplingParams
  /** provider 边界 request-attempt 回调（generic 无内层重试，innerAttempt 恒 1） */
  onAttempt?: (info: ProviderAttemptInfo) => void
}): AsyncIterable<GenericChunk> {
  const url = opts.baseUrl.replace(/\/+$/, "") + "/chat/completions"
  const body = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.sampling.temperature,
    top_p: opts.sampling.topP,
    max_tokens: opts.sampling.maxTokens,
    stream: true,
    // R20 主代理修复（Codex R19-R03）：与生产 deepseek.ts 同口径，确保 provider 返回 usage
    stream_options: { include_usage: true }
  }
  const startedAtMs = Date.now()
  let outcome: "success" | "http_error" | "transport_error" | "aborted" = "transport_error"
  let httpStatus: number | null = null
  let usage: Record<string, number | null> | null = null
  // R25-P1-01：实际即将发送的 request body 序列化一次（byte ceiling 口径），fetch 与 reservation 共用。
  const bodyJson = JSON.stringify(body)
  // R24-P0-03：fetch 前费用 reservation（带实际请求 body）；usage 到达后经 __evalPostRequest 对账。
  const preGate = (globalThis as unknown as {
    __evalPreRequest?: (bodyJson: string, model: string, maxTokens: number) => { blocked: boolean; reason?: string; reservedCny: number }
  }).__evalPreRequest
  let reservedCny = 0
  if (preGate) {
    const gate = preGate(bodyJson, opts.model, opts.sampling.maxTokens ?? 8192)
    if (gate.blocked) throw new Error(`budget exhausted: ${gate.reason ?? "budget exhausted"}`)
    reservedCny = gate.reservedCny ?? 0
  }
  const postGate = (globalThis as unknown as {
    __evalPostRequest?: (usage: Record<string, number | null> | null, reservedCny: number, outcome: "success" | "http_error" | "transport_error" | "aborted" | "budget_blocked") => void
  }).__evalPostRequest
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: bodyJson
    })
    httpStatus = resp.status
    if (!resp.ok || !resp.body) {
      outcome = "http_error"
      throw new Error(`OpenAI 兼容接口返回 ${resp.status}`)
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let finishReason: string | null = null
    let rawUsage: Record<string, number> | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const data = trimmed.slice(5).trim()
        if (data === "[DONE]") continue
        try {
          const ev = JSON.parse(data) as {
            choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>
            usage?: Record<string, number> | null
          }
          const delta = ev.choices?.[0]?.delta
          if (delta?.content) yield { type: "text", delta: String(delta.content) }
          if (delta?.reasoning_content) yield { type: "reasoning", delta: String(delta.reasoning_content) }
          const fr = ev.choices?.[0]?.finish_reason
          if (fr) finishReason = fr
          if (ev.usage) rawUsage = ev.usage
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }
    outcome = "success"
    if (rawUsage) {
      usage = {
        prompt_tokens: rawUsage.prompt_tokens ?? null,
        completion_tokens: rawUsage.completion_tokens ?? null,
        total_tokens: rawUsage.total_tokens ?? null,
        // R25-P1-02：cache hit/miss 缺失保持 null（不得归一成 0 → 假矛盾）
        prompt_cache_hit_tokens: rawUsage.prompt_cache_hit_tokens ?? null,
        prompt_cache_miss_tokens: rawUsage.prompt_cache_miss_tokens ?? null
      }
    }
    if (usage) yield { type: "usage", usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, cacheHitTokens: usage.prompt_cache_hit_tokens ?? null, cacheMissTokens: usage.prompt_cache_miss_tokens ?? null } }
    yield { type: "finish", finishReason: finishReason ?? "stop" }
  } catch (e) {
    if (outcome !== "http_error") outcome = (e as Error)?.name === "AbortError" ? "aborted" : "transport_error"
    throw e
  } finally {
    // R24-P0-03：reservation 对账（usage 到达或缺失均 settle；成功无 usage → 保守 upper）。
    // R25-P0-02：无 cost cap 时 reservedCny=0 也必须 settle（否则 actual 不入账却声称 costKnown）。
    if (postGate) {
      postGate(usage, reservedCny, outcome)
      reservedCny = 0
    }
    if (opts.onAttempt) {
      opts.onAttempt({
        innerAttempt: 1,
        outcome,
        httpStatus,
        usagePresent: usage != null,
        usage,
        actualMessageRoles: opts.messages.map((m) => m.role),
        actualUserHash: roleHash(opts.messages, "user"),
        actualHistoryHash: historyHash(opts.messages),
        actualSystemHash: systemHash(opts.messages),
        actualAssembledHash: assembledHash(opts.messages),
        actualMessageContentHashes: opts.messages.map((m) => sha256(m.content ?? "")),
        actualHistoryTurnHashes: historyTurns(opts.messages).map((m) => ({ role: m.role, sha256: sha256(m.content ?? "") })),
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs: Date.now() - startedAtMs
      })
    }
  }
}

export type GenericChunk =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number; cacheMissTokens: number | null } }
  | { type: "finish"; finishReason: string }
