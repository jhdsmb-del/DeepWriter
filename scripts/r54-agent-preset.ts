import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import * as http from 'node:http'
import type { DsMessage, Settings } from '../src/shared/types'

const scriptDir = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

async function loadTsModule(relativePath: string): Promise<Record<string, unknown>> {
  const entry = path.resolve(scriptDir, '..', relativePath)
  const outfile = path.resolve(scriptDir, '..', 'out', `r54-preset-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'node20', write: true, outfile,
      external: desktopSourceExternals(entry, ['node:sqlite']), logLevel: 'silent',
      plugins: [{
        name: 'electron-shim',
        setup(build: { onResolve(options: unknown, callback: (args: unknown) => unknown): void; onLoad(options: unknown, callback: (args: unknown) => unknown): void }): void {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
          build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
            contents: [
              'export const app = { getPath: (n) => String(n), isPackaged: false };',
              'export const dialog = { showMessageBox: async () => ({ response: 1 }) };',
              'export const ipcMain = { handle: () => undefined, on: () => undefined };',
              'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => null, decryptString: () => "" };',
              'export const shell = { openExternal: () => undefined, openPath: async () => "" };',
              'export const clipboard = { writeText: () => undefined };',
              'export const Menu = { buildFromTemplate: (t) => ({ popup: () => undefined, template: t }) };'
            ].join('\n'), loader: 'js'
          }))
        }
      }]
    })
    return await import(url.pathToFileURL(outfile).href) as Record<string, unknown>
  } finally {
    await fsp.unlink(outfile).catch(() => undefined)
  }
}

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
}

const preset = '你是当前 Agent 的用户预设：保持事实准确，输出直接可执行的结果。'
const baseSettings: Settings = {
  apiKey: 'SECRET-KEY-MUST-NOT-LEAK',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com',
  thinkingEnabled: false,
  reasoningEffort: 'high',
  temperature: 1,
  topP: 1,
  maxTokens: 1024,
  toolsEnabled: true,
  docDir: 'C:/docs',
  historyBudgetTokens: 8000,
  workDir: 'C:/work',
  planMode: false,
  permissionMode: 'safe',
  novelMode: false,
  galgame: { enabled: false, projectDir: '', sdkPath: '' },
  userPresetPrompt: preset
}

const payload = {
  id: 'r54-preset-run',
  sessionId: 'r54-preset-session',
  phase: 'execute' as const,
  mode: 'longwrite' as const,
  longMode: true,
  targetChars: 1000,
  text: '写一篇短文',
  story: null
}

async function main(): Promise<void> {
const snapshotModule = await loadTsModule('src/main/executionSnapshot.ts')
const adapterModule = await loadTsModule('src/main/runKernelAdapter.ts')
const schemaModule = await loadTsModule('src/shared/ipcSchemas.ts')
const presetModule = await loadTsModule('src/shared/userPresetPrompt.ts')
const buildExecutionSnapshot = snapshotModule.buildExecutionSnapshot as (input: Record<string, unknown>) => {
  frozenSystemMessages: Array<{ role: 'system'; content: string }>
  userPresetPrompt: string
  userPresetPromptHash: string
  model: string
  baseUrl: string
}
const createModelCallAdapter = adapterModule.createModelCallAdapter as (opts: Record<string, unknown>) => (input: Record<string, unknown>) => Promise<AsyncIterable<{ type: string }>>
const settingsSetSchema = schemaModule.settingsSetSchema as { safeParse(input: unknown): { success: boolean; error?: { issues?: unknown } } }
const injectUserPresetSystemMessage = presetModule.injectUserPresetSystemMessage as (messages: DsMessage[], value: unknown) => DsMessage[]

const snapshot = buildExecutionSnapshot({
  payload,
  settings: baseSettings as unknown as Record<string, unknown>,
  sessionId: 'r54-preset-session',
  memory: { projectPath: '', projectContent: '', userContent: '' },
  now: 1700000000000
})

const presetMessage = snapshot.frozenSystemMessages.find((m) => m.content.includes(preset))
check('R54-PRESET-01 快照冻结当前 Agent 预设提示词', Boolean(presetMessage), JSON.stringify(snapshot.frozenSystemMessages))
check('R54-PRESET-01 预设提示词 hash 可审计', typeof snapshot.userPresetPromptHash === 'string' && snapshot.userPresetPromptHash.length === 64, String(snapshot.userPresetPromptHash))
check('R54-PRESET-01 快照保存规范化预设值', snapshot.userPresetPrompt === preset, JSON.stringify(snapshot.userPresetPrompt))
check('R54-PRESET-01 快照不含 API key', !JSON.stringify(snapshot).includes('SECRET-KEY-MUST-NOT-LEAK'), JSON.stringify(snapshot).slice(0, 200))

const mutableSettings = { ...baseSettings, userPresetPrompt: '后来修改的预设，不应进入已启动 run' }
const frozenAgain = buildExecutionSnapshot({
  payload: { ...payload, id: 'r54-preset-run-2' },
  settings: mutableSettings as unknown as Record<string, unknown>,
  sessionId: 'r54-preset-session',
  memory: { projectPath: '', projectContent: '', userContent: '' },
  now: 1700000000001
})
check('R54-PRESET-02 不同运行切换预设不串线', frozenAgain.userPresetPrompt === mutableSettings.userPresetPrompt && frozenAgain.userPresetPrompt !== snapshot.userPresetPrompt)
check('R54-PRESET-02 同一快照冻结内容不受 settings 后续修改影响', snapshot.userPresetPrompt === preset && snapshot.frozenSystemMessages.some((m) => m.content.includes(preset)))

const patchResult = settingsSetSchema.safeParse({ kind: 'patch', key: 'userPresetPrompt', value: preset })
check('R54-PRESET-03 settings patch 暴露用户预设契约', patchResult.success, patchResult.success ? '' : JSON.stringify(patchResult.error?.issues))
const wholeResult = settingsSetSchema.safeParse({ kind: 'whole', settings: { apiKey: '', model: baseSettings.model, baseUrl: baseSettings.baseUrl, userPresetPrompt: preset } })
check('R54-PRESET-03 settings whole 可持久化用户预设', wholeResult.success, wholeResult.success ? '' : JSON.stringify(wholeResult.error?.issues))
const grillPlanningMessages = injectUserPresetSystemMessage([{ role: 'user', content: '生成已确认大纲' }], preset)
check('R54-PRESET-03 Grill planning 请求复用当前 Agent 预设', grillPlanningMessages[0]?.role === 'system' && grillPlanningMessages[0]?.content.includes(preset), JSON.stringify(grillPlanningMessages))
const grillQuestionMessages = injectUserPresetSystemMessage([{ role: 'user', content: '生成下一采访问题' }], preset)
check('R54-PRESET-03 Grill interview 请求复用当前 Agent 预设', grillQuestionMessages[0]?.role === 'system' && grillQuestionMessages[0]?.content.includes(preset), JSON.stringify(grillQuestionMessages))

const requests: Array<{ purpose: string; messages: DsMessage[]; apiKey: string }> = []
const streamChatImpl = async (
  params: { messages: DsMessage[]; apiKey: string },
  onEvent: (event: { type: 'done'; finishReason: string | null; usage: null }) => void
): Promise<{ finishReason: string | null; usage: null }> => {
  requests.push({ purpose: 'captured', messages: params.messages, apiKey: params.apiKey })
  onEvent({ type: 'done', finishReason: 'stop', usage: null })
  return { finishReason: 'stop', usage: null }
}

const mockServer = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok', role: 'assistant' }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 } })}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
})
await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve))
const mockPort = (mockServer.address() as { port: number }).port
const adapterSnapshot = { ...snapshot, baseUrl: `http://127.0.0.1:${mockPort}`, credentialRef: { origin: `http://127.0.0.1:${mockPort}`, model: snapshot.model, issuedAt: 0 } }

const adapter = createModelCallAdapter({
  getApi: () => ({
    apiKey: baseSettings.apiKey,
    baseUrl: `http://127.0.0.1:${mockPort}`,
    model: baseSettings.model,
    maxTokens: baseSettings.maxTokens,
    thinking: { enabled: false, effort: 'high' },
    temperature: baseSettings.temperature,
    topP: baseSettings.topP
  }),
  buildPrefix: async () => snapshot.frozenSystemMessages,
  getSignal: () => undefined,
  getConfig: () => adapterSnapshot,
  streamChatImpl: streamChatImpl as never
})

for (const purpose of ['writer', 'critic', 'editor'] as const) {
  try {
    const iterator = await adapter({
      runId: `r54-${purpose}`,
      phase: 'execute',
      turnSeq: 1,
      round: 1,
      purpose,
      messages: purpose === 'writer'
        ? [{ role: 'user', content: '当前任务' }]
        : [{ role: 'system', content: `${purpose} 内部工作协议` }, { role: 'user', content: '候选正文' }]
    })
    for await (const _event of iterator) {
      // drain provider stream
    }
  } catch (error) {
    check(`R54-PRESET-04 ${purpose} provider adapter 可执行`, false, String(error))
  }
  const request = requests[requests.length - 1]
  const presetHits = request?.messages.filter((message) => message.role === 'system' && message.content.includes(preset)) ?? []
  check(`R54-PRESET-04 ${purpose} provider envelope 注入预设`, presetHits.length === 1, JSON.stringify(request?.messages))
  check(`R54-PRESET-04 ${purpose} provider envelope 不注入 API key`, request?.messages.every((message) => !message.content.includes(baseSettings.apiKey)), JSON.stringify(request?.messages))
}
check('R54-PRESET-04 生产 adapter 发送 writer/critic/editor 三类请求', requests.length === 3, `n=${requests.length}`)
await new Promise<void>((resolve) => mockServer.close(() => resolve()))

console.log(`R54 agent preset: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
