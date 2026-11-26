import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// R32 user-path regression: exact delivery length + Unicode-safe streaming progress.
// This test uses the real AgentRunEngine/CompletionController path with an injected
// model stream, so it never calls a real provider.

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }
let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', `r32-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: true,
    outfile,
    external: desktopSourceExternals(path.join(ROOT, rel), ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']),
    logLevel: 'silent',
    plugins: [{
      name: 'electron-shim',
      setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
        build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
          contents: 'export const app={getPath:()=>"."}; export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true})};',
          loader: 'js'
        }))
      }
    }]
  })
  try {
    return await import(url.pathToFileURL(outfile).href) as Record<string, unknown>
  } finally {
    try { fs.unlinkSync(outfile) } catch { /* test artifact cleanup is best effort */ }
  }
}

type Engine = {
  start(input: Record<string, unknown>): Promise<{ ok: boolean }>
  step(runId: string): Promise<void>
  getState(runId: string): Promise<{ run: { status: string; phase: string; errorCode?: string } | null; turns: Array<{ role: string; content: string }> }>
}

const SETTINGS = {
  model: 'deepseek-v4-flash', baseUrl: 'http://127.0.0.1:9', maxTokens: 8192, temperature: 1, topP: 1,
  thinkingEnabled: false, reasoningEffort: 'high', workDir: 'C:/w', docDir: 'C:/d', novelMode: false,
  galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000
}

async function makeConfig(targetChars: number): Promise<Record<string, unknown>> {
  const mod = await loadTsModule('src/main/executionSnapshot.ts')
  const build = mod.buildExecutionSnapshot as (input: Record<string, unknown>) => { completionContract: unknown; maxTurns: number }
  const snap = build({
    payload: { id: `r32-${targetChars}`, mode: 'longwrite', longMode: true, targetChars, text: '完成正文' },
    settings: SETTINGS,
    sessionId: 'r32-session',
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  return {
    runMode: 'longwrite', longMode: true, targetChars, manuscriptSegmentsVersion: 1,
    maxTurns: Math.max(8, snap.maxTurns), completionContract: snap.completionContract,
    strongConstraints: (snap as { strongConstraints?: unknown }).strongConstraints
  }
}

async function runCase(name: string, target: number, outputs: string[], expectedStatus = 'completed', exact = true): Promise<void> {
  const repoMod = await loadTsModule('src/main/db/repository.ts')
  const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
  const portMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createRepository = repoMod.createRepository as (p: string) => any
  const createEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => Engine
  const createPort = portMod.createRunStorePort as (r: unknown, dir: string) => unknown
  const createTranslator = portMod.createChunkTranslator as () => (ev: Record<string, unknown>, runId: string) => Array<{ type: string; delta?: string }>
  const translate = createTranslator()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-r32-'))
  const repo = createRepository(path.join(tmp, 'run.db'))
  repo.open()
  let call = 0
  let rendered = ''
  const config = await makeConfig(target)
  const engine = createEngine({
    store: createPort(repo, path.join(tmp, 'artifacts')),
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string }> {
        const text = outputs[Math.min(call++, outputs.length - 1)] ?? ''
        yield { type: 'text', delta: text }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    artifactDir: path.join(tmp, 'artifacts'),
    onEvent: (_runId: string, ev: Record<string, unknown>) => {
      for (const chunk of translate(ev, runId)) {
        if (chunk.type === 'text') rendered += chunk.delta ?? ''
      }
    },
    onRunUpdate: () => undefined
  })
  const runId = `r32-${name}`
  await engine.start({ sessionId: 'r32-s', runId, config })
  await engine.step(runId)
  const state = await engine.getState(runId)
  const text = state.turns.filter((t) => t.role === 'assistant').map((t) => t.content).join('')
  const metrics = await loadTsModule('src/shared/textMetrics.ts')
  const count = metrics.codePointLength as (s: string) => number
  const contract = config.completionContract as { targetChars?: { min?: number; max?: number; tolerance?: number } }
  check('R33-' + name + ' durable 正文与 UI 增量一致', count(rendered) === count(text), 'ui=' + count(rendered) + ' durable=' + count(text))
  if (target >= 10000) {
    check('R33-' + name + ' 目标推导轮数允许短轮模型', config.maxTurns >= Math.ceil(target / 1000), 'maxTurns=' + config.maxTurns)
  }
  check(`R32-${name} 真实引擎最终状态`, state.run?.status === expectedStatus, JSON.stringify(state.run))
  check(`R32-${name} 输出${exact ? '严格等于目标' : '不因重复内容假完成'}（Unicode code point）`, exact ? count(text) === target : state.run?.status !== 'completed', `actual=${count(text)} target=${target} status=${state.run?.status}`)
  check(`R32-${name} 契约为窄幅自然收束区间`, contract.targetChars?.min === target && contract.targetChars?.max === Math.ceil(target * 1.01) && contract.targetChars?.tolerance === 0.01, JSON.stringify(contract.targetChars))
  repo.close()
}

async function runMultiTurnTranslator(): Promise<void> {
  const adapter = await loadTsModule('src/main/runKernelAdapter.ts')
  const createTranslator = adapter.createChunkTranslator as () => (ev: Record<string, unknown>, runId: string) => Array<{ type: string; delta?: string }>
  const translate = createTranslator()
  const rendered: string[] = []
  const events = [
    { type: 'turn', turn: { turnId: 'turn-a', role: 'assistant', content: '甲' } },
    { type: 'turn', turn: { turnId: 'turn-a', role: 'assistant', content: '甲乙' } },
    { type: 'turn', turn: { turnId: 'turn-b', role: 'assistant', content: '丙' } },
    { type: 'turn', turn: { turnId: 'turn-b', role: 'assistant', content: '丙丁' } }
  ]
  for (const ev of events) {
    for (const chunk of translate(ev, 'r33-multi-turn')) {
      if (chunk.type === 'text') rendered.push(chunk.delta ?? '')
    }
  }
  check('R33-STREAM 多轮 turnId-aware 增量不吞新轮前缀', rendered.join('') === '甲乙丙丁', JSON.stringify(rendered))
}

async function runInterrupted(): Promise<void> {
  const repoMod = await loadTsModule('src/main/db/repository.ts')
  const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
  const portMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createRepository = repoMod.createRepository as (p: string) => any
  const createEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => Engine
  const createPort = portMod.createRunStorePort as (r: unknown, dir: string) => unknown
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-r32-interrupted-'))
  const repo = createRepository(path.join(tmp, 'run.db'))
  repo.open()
  const config = await makeConfig(20)
  const runId = 'r32-INTERRUPTED'
  const engine = createEngine({
    store: createPort(repo, path.join(tmp, 'artifacts')),
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string }> {
        yield { type: 'text', delta: '甲😀乙𠀀' }
        throw new Error('synthetic stream interruption')
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    artifactDir: path.join(tmp, 'artifacts'),
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  await engine.start({ sessionId: 'r32-s', runId, config })
  await engine.step(runId)
  const state = await engine.getState(runId)
  const text = state.turns.filter((t) => t.role === 'assistant').map((t) => t.content).join('')
  const metrics = await loadTsModule('src/shared/textMetrics.ts')
  const count = metrics.codePointLength as (s: string) => number
  check('R32-INTERRUPTED 流中断不假装完成', state.run?.status === 'failed' && state.run?.errorCode === 'model_error', JSON.stringify(state.run))
  check('R32-INTERRUPTED 已收到正文持久化为 partial', count(text) === 4 && text === '甲😀乙𠀀', `actual=${count(text)} text=${JSON.stringify(text)}`)
  repo.close()
}

async function runLongGenerateStopContinuation(): Promise<void> {
  const mod = await loadTsModule('src/main/deepseek.ts')
  const longGenerate = mod.longGenerate as (opts: Record<string, unknown>) => Promise<Record<string, unknown>>
  let calls = 0
  let streamed = ''
  const result = await longGenerate({
    params: { apiKey: 'synthetic', model: 'synthetic', baseUrl: 'http://127.0.0.1:9', thinking: { enabled: false }, maxTokens: 128 },
    messages: [{ role: 'user', content: '写一小段' }],
    targetChars: 8,
    maxRounds: 4,
    contextBudgetTokens: 100000,
    outputReserveTokens: 0,
    onEvent: (ev: { type: string; delta?: string }) => { if (ev.type === 'text') streamed += ev.delta ?? '' },
    onRound: () => undefined,
    streamChatImpl: async (_params: unknown, onEvent: (ev: { type: string; delta?: string }) => void) => {
      const text = calls++ === 0 ? '甲乙' : '😀丙丁戊己庚辛壬'
      onEvent({ type: 'text', delta: text })
      return { finishReason: 'stop', usage: null }
    }
  })
  const count = (await loadTsModule('src/shared/textMetrics.ts')).codePointLength as (s: string) => number
  check('R32-STOP-SHORT 模型 stop 且不足时自动续作', result.reachedTarget === true && result.needsContinuation !== true && result.rounds === 2, JSON.stringify(result))
  check('R32-STOP-SHORT 续作流最终严格等于目标', count(streamed) === 8, `actual=${count(streamed)} target=8`)
}

async function main(): Promise<void> {
  const metrics = await loadTsModule('src/shared/textMetrics.ts')
  const codePointLength = metrics.codePointLength as (s: string) => number
  const takeCodePoints = metrics.takeCodePoints as (s: string, n: number) => string
  const emojiText = '甲😀乙𠀀丙'
  check('R32-UNICODE code point 计数不按 UTF-16 码元', codePointLength(emojiText) === 5, `count=${codePointLength(emojiText)}`)
  check('R32-UNICODE 精确收敛不切 surrogate pair', takeCodePoints(emojiText, 4) === '甲😀乙𠀀', JSON.stringify(takeCodePoints(emojiText, 4)))
  const writingMode = await loadTsModule('src/renderer/src/writingMode.ts')
  const initialUiMode = { workspace: 'chat', mode: 'agent', longMode: false }
  const fromMode = (writingMode.transitionComposerMode as (s: Record<string, unknown>, m: string) => Record<string, unknown>)(initialUiMode, 'longwrite')
  const fromWorkspace = (writingMode.transitionWorkspace as (s: Record<string, unknown>, w: string) => Record<string, unknown>)(initialUiMode, 'novel')
  const fromToggle = (writingMode.transitionLongMode as (s: Record<string, unknown>, v: boolean) => Record<string, unknown>)(initialUiMode, true)
  const backToAgent = (writingMode.transitionComposerMode as (s: Record<string, unknown>, m: string) => Record<string, unknown>)(fromToggle, 'agent')
  const defensive = (writingMode.deriveWritingRunMode as (s: Record<string, unknown>) => Record<string, unknown>)({ workspace: 'novel', mode: 'agent', longMode: false })
  check('R36-MODE 选择长文统一 mode/workspace/开关', fromMode.mode === 'longwrite' && fromMode.workspace === 'novel' && fromMode.longMode === true, JSON.stringify(fromMode))
  check('R36-MODE 进入小说工作区统一为精确长文', fromWorkspace.mode === 'longwrite' && fromWorkspace.workspace === 'novel' && fromWorkspace.longMode === true, JSON.stringify(fromWorkspace))
  check('R36-MODE 开启深度写作统一为精确长文', fromToggle.mode === 'longwrite' && fromToggle.workspace === 'novel' && fromToggle.longMode === true, JSON.stringify(fromToggle))
  check('R36-MODE 明确切到 Agent 会关闭长文语义', backToAgent.mode === 'agent' && backToAgent.workspace === 'chat' && backToAgent.longMode === false, JSON.stringify(backToAgent))
  check('R36-MODE 发送边界防御修复 workspace/mode 漂移', defensive.mode === 'longwrite' && defensive.workspace === 'novel' && defensive.longMode === true, JSON.stringify(defensive))
  await runMultiTurnTranslator()
  await runCase('SHORT', 5, ['😀abc。def'])
  await runCase('CONTINUE', 8, ['甲。', '😀丙丁戊己。'])
  await runCase('LONG', 12, ['正文'.repeat(5) + '甲。' + '正文'.repeat(14)])
  await runCase('DUPLICATE', 16, ['abcdefg。', 'abcdefg。'], 'waiting_user', false)
  const tenKOutputs = Array.from({ length: 10 }, (_, round) =>
    Array.from({ length: 999 }, (_, i) => String.fromCodePoint(0x4e00 + round * 1000 + i)).join('') + '。'
  )
  await runCase('TEN_K_SHORT_TURNS', 10000, tenKOutputs)
  await runInterrupted()
  await runLongGenerateStopContinuation()

  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/MessageBubble.tsx'), 'utf8')
  const longStatus = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/LongWriteStatus.tsx'), 'utf8')
  check('R32-UI 长文使用实际字数进度', longStatus.includes('data-testid="long-write-status-progress"') && longStatus.includes('role="progressbar"'))
  check('R32-UI 进度使用 code point 计数', longStatus.includes("codePointLength(message?.content ?? '')"))
  check('R32-UI 状态支持 aria-live', longStatus.includes('aria-live="polite"'))
  check('R36-UI 任务详情来自实际运行', source.includes('openRunInspector(msg.id)') && longStatus.includes('id && openRunInspector(id)'))
  check('R36-UI 任务详情入口声明 dialog 可访问语义', source.includes('aria-haspopup="dialog"') && source.includes('aria-expanded={inspectorRunId === msg.id}'))
  check('Agent 不再显示默认长文进度', !source.includes('StreamProgress') && source.includes('isLongWrite && longStatusVisible'))
  const projection = await loadTsModule('src/main/sessionProjection.ts')
  const compose = projection.composeRunAssistantContent as (turns: Array<{ role: string; content: string; turn_seq?: number }>) => { content: string; turnChars: number[] }
  const projected = compose([{ role: 'assistant', content: '😀甲', turn_seq: 1 }, { role: 'assistant', content: '乙𠀀', turn_seq: 2 }])
  check('R33-PROJECTION turnChars 使用 Unicode code point', projected.turnChars.join(',') === '2,2' && codePointLength(projected.content) === 4, JSON.stringify(projected))

  console.log(`\n===== R32 writing exact: ${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
