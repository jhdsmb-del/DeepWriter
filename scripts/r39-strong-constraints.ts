import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// R39: default-on strong writing constraints. All provider calls are injected synthetic streams.
import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }
const expectRed = process.argv.includes('--expect-red')
const expectR391Red = process.argv.includes('--expect-r391-red')
let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const loaded = new Map<string, Promise<Record<string, unknown>>>()
async function load(rel: string): Promise<Record<string, unknown>> {
  const cached = loaded.get(rel)
  if (cached) return cached
  const pending = (async () => {
    const outfile = path.join(ROOT, 'out', `r39-${createHash('sha1').update(rel).digest('hex').slice(0, 12)}.mjs`)
    await esbuild.build({
      entryPoints: [path.join(ROOT, rel)], bundle: true, format: 'esm', platform: 'node', target: 'node20', write: true, outfile,
      external: desktopSourceExternals(path.join(ROOT, rel), ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']), logLevel: 'silent',
      plugins: [{
        name: 'electron-shim',
        setup(build: { onResolve(o: unknown, cb: () => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
          build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({ contents: 'export const app={getPath:()=>"."}; export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true})};', loader: 'js' }))
        }
      }]
    })
    return await import(`${url.pathToFileURL(outfile).href}?v=${Date.now()}`) as Record<string, unknown>
  })()
  loaded.set(rel, pending)
  return pending
}

const SETTINGS = {
  model: 'synthetic-r39', baseUrl: 'http://127.0.0.1:9', maxTokens: 8192, temperature: 1, topP: 1,
  thinkingEnabled: false, reasoningEffort: 'high', workDir: 'C:/w', docDir: 'C:/d', novelMode: false,
  galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000,
  completionTokenBudget: 200000, completionWallClockMs: 0,
  strongConstraintEnabled: true, strongConstraintLevel: 'balanced', strongConstraintPerspective: 'auto',
  strongConstraintGenre: '', strongConstraintMustKeep: '', strongConstraintAvoid: ''
}
const TASK = '写一个发生在海边灯塔的守夜人悬疑故事，4000字，不要说教。'

async function buildConfig(input: { id: string; mode?: string; target?: number; phase?: 'plan' | 'execute'; enabled?: boolean; visibleTask?: string; task?: string; mustKeep?: string; genre?: string; perspective?: 'auto' | 'first' | 'third' }): Promise<Record<string, any>> {
  const mod = await load('src/main/executionSnapshot.ts')
  const build = mod.buildExecutionSnapshot as (v: Record<string, unknown>) => Record<string, any>
  const mode = input.mode ?? 'longwrite'
  return build({
    payload: {
      id: input.id, mode, workspace: mode === 'longwrite' ? 'novel' : 'chat', longMode: mode === 'longwrite',
      targetChars: input.target ?? (mode === 'longwrite' ? 4000 : 0), phase: input.phase ?? 'execute',
      text: input.phase === 'execute' && input.visibleTask ? '' : (input.task ?? TASK),
      strongConstraints: mode === 'longwrite' ? {
        task: input.visibleTask ?? input.task ?? TASK, enabled: input.enabled ?? true,
        level: 'balanced', perspective: input.perspective ?? 'auto', genre: input.genre ?? '', mustKeep: input.mustKeep ?? '', avoid: ''
      } : undefined
    },
    settings: SETTINGS, sessionId: `${input.id}-session`, memory: { projectPath: '', projectContent: '', userContent: '' }, now: 1_700_000_000_000
  })
}

function exact(text: string, count: number): string {
  return Array.from(text.repeat(Math.ceil(count / Math.max(1, Array.from(text).length)))).slice(0, count).join('')
}

function validSegment(round: number, count = 1000): string {
  const prefix = `灯塔旁的守夜人沿着海雾继续巡查，旧铜门在风里发出低响。第${round}夜，`
  const chars = Array.from({ length: count }, (_, i) => String.fromCodePoint(0x4e00 + ((round * 2400 + i) % 18_000))).join('')
  const segment = Array.from(prefix + chars).slice(0, count)
  segment[segment.length - 1] = '。'
  return segment.join('')
}

const BAD = exact('人生的意义在于不断追求成功。这告诉我们，每个人都应该超越眼前的小事，为社会创造更大的价值。', 1000)

type EngineResult = {
  repo: any; port: any; engine: any; config: Record<string, any>; runId: string
  calls: Array<Array<{ role: string; content: string }>>; phases: Array<{ title?: string; detail?: string }>
  rendered: string
  state: { run: { status: string; errorCode?: string } | null; turns: Array<{ role: string; content: string }> }
}

async function runEngineCase(input: { name: string; outputs: string[]; mode?: string; target?: number; enabled?: boolean; task?: string; perspective?: 'auto' | 'first' | 'third' }): Promise<EngineResult> {
  const [repoMod, engineMod, portMod] = await Promise.all([
    load('src/main/db/repository.ts'), load('src/main/jobs/AgentRunEngine.ts'), load('src/main/runKernelAdapter.ts')
  ])
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dw-r39-${input.name}-`))
  const repo = (repoMod.createRepository as (p: string) => any)(path.join(tmp, 'run.db'))
  repo.open()
  const port = (portMod.createRunStorePort as (r: unknown, dir: string) => any)(repo, path.join(tmp, 'artifacts'))
  const translate = (portMod.createChunkTranslator as () => (ev: Record<string, unknown>, runId: string) => Array<{ type: string; delta?: string }>)()
  const runId = `r39-${input.name}`
  const config = await buildConfig({ id: runId, mode: input.mode, target: input.target, enabled: input.enabled, task: input.task, perspective: input.perspective })
  const calls: Array<Array<{ role: string; content: string }>> = []
  const phases: Array<{ title?: string; detail?: string }> = []
  let rendered = ''
  let call = 0
  const engine = (engineMod.createAgentRunEngine as (o: Record<string, unknown>) => any)({
    store: port,
    modelCall: async (request: { messages: Array<{ role: string; content: string }> }) => {
      calls.push(request.messages.map((m) => ({ role: m.role, content: m.content })))
      const output = input.outputs[Math.min(call++, input.outputs.length - 1)] ?? ''
      return { async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> { yield { type: 'text', delta: output }; yield { type: 'finish', finishReason: 'stop' } } }
    },
    toolExecutor: async () => '', getConfig: () => config, artifactDir: path.join(tmp, 'artifacts'),
    publishLongwriteArtifact: async ({ content }: { content: string }) => {
      const outputPath = path.join(tmp, `${runId}.md`)
      fs.writeFileSync(outputPath, content, 'utf8')
      return { displayName: `${runId}.md`, relativePath: outputPath }
    },
    onEvent: (_id: string, event: Record<string, unknown>) => {
      if (event.type === 'phase') phases.push({ title: event.title as string | undefined, detail: event.detail as string | undefined })
      for (const chunk of translate(event, runId)) {
        if (chunk.type === 'text') rendered += chunk.delta ?? ''
        if (chunk.type === 'text_replace') rendered = chunk.delta ?? ''
      }
    },
    onRunUpdate: () => undefined
  })
  await engine.start({ sessionId: `${runId}-session`, runId, config })
  let seq = 1
  for (const message of config.frozenSystemMessages as Array<{ role: 'system'; content: string }>) {
    await port.appendTurn({ turnId: `${runId}-sys-${seq}`, runId, turnSeq: seq++, role: 'system', content: message.content, createdAt: 1_700_000_000_000 })
  }
  await port.appendTurn({ turnId: `${runId}-user`, runId, turnSeq: seq, role: 'user', content: input.task ?? TASK, createdAt: 1_700_000_000_001 })
  await engine.step(runId)
  const state = await engine.getState(runId)
  return { repo, port, engine, config, runId, calls, phases, rendered, state }
}

async function redEvidence(): Promise<void> {
  const result = await runEngineCase({ name: 'red', outputs: [exact(BAD, 4000)], target: 4000, enabled: false })
  const text = result.state.turns.filter((t) => t.role === 'assistant').map((t) => t.content).join('')
  check('RED 无强约束时完成门接受说教跑题正文', result.state.run?.status === 'completed', `status=${result.state.run?.status}`)
  check('RED 正文命中说教模板', text.includes('人生的意义') && text.includes('这告诉我们'))
  check('RED 主题锚点完全丢失', !text.includes('灯塔') && !text.includes('守夜人'))
  result.repo.close()
}

async function r391RedEvidence(): Promise<void> {
  const tasks = [
    '写一个发生在海边灯塔的守夜人悬疑故事，4000字。',
    '请创作月球温室里植物学家的孤独故事，约四千字。',
    '讲述旧城钟楼修表匠寻找失踪女儿的悬疑小说，不要说教。',
    '续写：暴雨中的边境车站，巡警发现一只无人认领的红箱子，保持第三人称。'
  ]
  const configs = await Promise.all(tasks.map((task, index) => buildConfig({ id: `r391-anchor-${index}`, task })))
  check('RED39.1 四类自然任务至少一类无法自动提取主题锚点', configs.some((config) => config.strongConstraints.themeAnchors.length === 0), JSON.stringify(configs.map((config) => config.strongConstraints.themeAnchors)))

  const unrelated = (round: number): string => Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + round * 1700 + i)).join('')
  const tailPatch = await runEngineCase({ name: 'r391-tail-patch', task: tasks[0], outputs: [unrelated(1), unrelated(2), unrelated(3), validSegment(4)] })
  check('RED39.1 前 3000 跑题、末段补灯塔仍会 completed', tailPatch.state.run?.status === 'completed', `status=${tailPatch.state.run?.status}`)
  tailPatch.repo.close()

  const firstPerson = (round: number): string => exact(`我看见潮水退去，我想到旧日，我沿着街道走。我记得第${round}次风声。`, 1000)
  const thirdTail = exact('他看见灯塔亮起，他沿着海边走，守夜人转身望向旧门。', 1000)
  const perspective = await runEngineCase({ name: 'r391-perspective', task: tasks[0], perspective: 'third', outputs: [firstPerson(1), firstPerson(2), firstPerson(3), thirdTail] })
  check('RED39.1 前三段第一人称、末段补第三人称信号仍会 completed', perspective.state.run?.status === 'completed', `status=${perspective.state.run?.status}`)
  perspective.repo.close()
}

async function snapshotAndPureChecks(): Promise<void> {
  const [snapMod, strongMod] = await Promise.all([load('src/main/executionSnapshot.ts'), load('src/main/strongConstraints.ts')])
  const cfg = await buildConfig({ id: 'snapshot' })
  check('R39-SNAPSHOT 当前 schema v5、兼容 v4 且拒绝 v3', cfg.snapshotVersion === 5 && (snapMod.snapshotVersionOk as (c: object) => boolean)({ snapshotVersion: 4 }) === true && (snapMod.snapshotVersionOk as (c: object) => boolean)({ snapshotVersion: 3 }) === false)
  check('R39-SNAPSHOT 长文默认开启并从自然任务冻结主题锚点', cfg.strongConstraints.enabled === true && cfg.strongConstraints.sourceTask === TASK && cfg.strongConstraints.themeAnchors.includes('灯塔'))
  const explicit = await buildConfig({ id: 'snapshot-explicit', mustKeep: '灯塔；守夜人' })
  check('R39-SNAPSHOT 用户补充 mustKeep 作为附加约束冻结', explicit.strongConstraints.mustKeep.includes('灯塔') && explicit.strongConstraints.mustKeep.includes('守夜人'))
  const frozenBytes = JSON.stringify(cfg.frozenSystemMessages)
  const computed = (snapMod.computePromptHash as (...args: any[]) => string)(cfg.runMode, cfg.story, cfg.deepWrite.targetChars, cfg.galgame, cfg.strongConstraints.hash, cfg.frozenSystemMessages)
  check('R39-FROZEN-PROMPT promptHash 等于冻结 system messages bytes', computed === cfg.promptHash)
  check('R39-PROMPT 明确使用场景化收束且不拔高主题', frozenBytes.includes('场景、动作或声音自然收住') && frozenBytes.includes('不否定整段正文'))
  const plan = await buildConfig({ id: 'plan', phase: 'plan' })
  const execute = await buildConfig({ id: 'execute', phase: 'execute', visibleTask: TASK })
  check('R39-PLAN 计划阶段不套正文漂移门禁', plan.strongConstraints.enabled === false && !plan.completionContract?.validators?.some((v: any) => v.id === 'strongConstraints'))
  check('R39-PLAN plan→execute 保留原始任务并启用门禁', execute.strongConstraints.enabled === true && execute.strongConstraints.sourceTask === TASK)
  const agent = await buildConfig({ id: 'agent', mode: 'agent', target: 0 })
  const disabled = await buildConfig({ id: 'disabled', enabled: false })
  check('R39-SCOPE 普通 Agent 不受强约束影响', agent.strongConstraints.enabled === false && agent.completionContract == null)
  check('R39-SCOPE 用户关闭后不注入强约束 validator', disabled.strongConstraints.enabled === false && !disabled.completionContract.validators.some((v: any) => v.id === 'strongConstraints'))
  const evaluate = strongMod.evaluateStrongConstraints as (s: any, d: string, l: string, o: object) => { ok: boolean; violations: any[] }
  const normal = exact('灯塔下，守夜人望着潮水，想起父亲留下的旧表。他没有得出答案，只把表收好，继续沿礁石巡查。', 4000)
  const normalResult = evaluate(cfg.strongConstraints, normal, normal, { atTarget: true })
  check('R39-FP 克制的文学反思不被误判为说教', normalResult.ok, JSON.stringify(normalResult.violations))
  const badResult = evaluate(cfg.strongConstraints, exact(BAD, 4000), exact(BAD, 1000), { atTarget: true })
  check('R39-DRIFT 确定性规则同时识别主题丢失/说教收尾', badResult.violations.some((v: any) => v.code === 'topic_anchor_missing') && badResult.violations.some((v: any) => v.code === 'preachy_ending'))
  const naturalTasks = [
    ['写一个发生在海边灯塔的守夜人悬疑故事，4000字。', '灯塔'],
    ['请创作月球温室里植物学家的孤独故事，约四千字。', '温室'],
    ['讲述旧城钟楼修表匠寻找失踪女儿的悬疑小说，不要说教。', '女儿'],
    ['续写：暴雨中的边境车站，巡警发现一只无人认领的红箱子，保持第三人称。', '车站']
  ] as const
  for (const [task, expected] of naturalTasks) {
    const natural = await buildConfig({ id: `natural-${expected}`, task })
    const anchors = natural.strongConstraints.themeAnchors as string[]
    check(`R39-ANCHOR 自然任务自动提取 ${expected}`, anchors.length > 0 && anchors.some((anchor) => anchor.includes(expected)) && anchors.every((anchor) => !/(?:4000|四千)字|写一篇|不要说教/u.test(anchor)), JSON.stringify(anchors))
  }
  const third = await buildConfig({ id: 'perspective-pure', perspective: 'third' })
  const firstPerson = exact('我看见潮水退去，我想到旧日，我沿着街道走，我记得风声。', 1000)
  const perspectiveBad = evaluate(third.strongConstraints, firstPerson, firstPerson, { atTarget: false, checkSegmentPerspective: true })
  check('R39-POV 候选段明显违背第三人称会被识别', perspectiveBad.violations.some((v: any) => v.code === 'perspective_mismatch'))
  const dialogue = exact('守夜人走到灯塔门边。她说：“我看见潮水，我记得那一夜，我知道那扇门，我不会离开。”她转身检查门锁。', 1000)
  const perspectiveNormal = evaluate(third.strongConstraints, dialogue, dialogue, { atTarget: false, checkSegmentPerspective: true, requireThemeInSegment: true })
  check('R39-POV 对话中的第一人称不误判叙事视角', !perspectiveNormal.violations.some((v: any) => v.code === 'perspective_mismatch'), JSON.stringify(perspectiveNormal.violations))
  const laterWithoutRepeat = exact('潮水退到礁石外，旧门后的脚步声忽近忽远，雾里没有人回答。', 1000)
  const balancedLater = evaluate(cfg.strongConstraints, validSegment(1) + laterWithoutRepeat, laterWithoutRepeat, { atTarget: false, requireThemeInSegment: false })
  check('R39-THEME balanced 后续段不要求机械复读主题词', !balancedLater.violations.some((v: any) => v.code === 'topic_anchor_missing'), JSON.stringify(balancedLater.violations))
}

async function engineChecks(): Promise<void> {
  const good = await runEngineCase({ name: 'bad-good', outputs: [BAD, validSegment(1), validSegment(2), validSegment(3), validSegment(4)] })
  const text = good.state.turns.filter((t) => t.role === 'assistant').map((t) => t.content).join('')
  const count = Array.from(text).length
  check('R39-ENGINE 跑偏段自动撤回并重写后完成', good.state.run?.status === 'completed' && good.calls.length === 5, `status=${good.state.run?.status} calls=${good.calls.length}`)
  check('R39-ENGINE canonical/durable/UI 同为精确 4000 code points', count === 4000 && good.rendered === text, `durable=${count} ui=${Array.from(good.rendered).length}`)
  check('R39-ENGINE 最终正文移除说教段并保留主题', !text.includes('人生的意义') && text.includes('灯塔') && text.includes('守夜人'))
  const fixedPrompt = (good.config.frozenSystemMessages as Array<{ content: string }>).find((m) => m.content.includes('本次创作坐标'))?.content ?? ''
  check('R39-FREEZE 每轮 provider 都带同一份冻结约束 bytes', fixedPrompt.length > 0 && good.calls.every((call) => call.some((m) => m.role === 'system' && m.content === fixedPrompt)))
  check('R39-REPAIR 修复轮携带约束 hash 且明确自然回到正文', good.calls.slice(1).some((call) => call.some((m) => m.content.includes(good.config.strongConstraints.hash) && m.content.includes('候选段已撤回'))))
  check('R39-ACTIVITY 详情记录检查/类别/修复结果', good.phases.some((p) => p.title === '检查是否偏题') && good.phases.some((p) => p.title === '正在纠正偏移' && p.detail?.includes('说教式收尾')) && good.phases.some((p) => p.title === '偏移已纠正'))
  const attempts = good.repo.getCompletionAttempts(good.runId) as Array<{ attempt: number; json: string }>
  const evidence = good.repo.getRunEvidence(good.runId, 'strong_constraint_latest') as { json: string } | null
  check('R39-DURABLE 修复尝试与最新 constraint evidence 独立落库', attempts.some((a) => a.attempt < 0 && JSON.parse(a.json).status === 'passed') && JSON.parse(evidence?.json ?? '{}').status === 'passed')
  good.repo.close()

  const unrelated = (round: number): string => Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + round * 1700 + i)).join('')
  const tailPatch = await runEngineCase({ name: 'tail-patch-green', outputs: [unrelated(1), unrelated(2), unrelated(3), validSegment(4)] })
  check('R39-THEME 前 3000 跑题、末段补关键词不能 completed', tailPatch.state.run?.status !== 'completed' && !tailPatch.state.turns.filter((turn) => turn.role === 'assistant').some((turn) => turn.content === unrelated(1)), `status=${tailPatch.state.run?.status}`)
  tailPatch.repo.close()

  const firstPerson = exact('我看见潮水退去，我想到旧日，我沿着街道走，我记得风声。', 1000)
  const thirdSegment = (round: number): string => {
    const prefix = `他看见灯塔亮起，守夜人沿海边走到旧门。第${round}夜，`
    const segment = Array.from(prefix + Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + round * 2300 + i)).join('')).slice(0, 1000)
    segment[segment.length - 1] = '。'
    return segment.join('')
  }
  const pov = await runEngineCase({ name: 'pov-bad-good', perspective: 'third', outputs: [firstPerson, thirdSegment(1), thirdSegment(2), thirdSegment(3), thirdSegment(4)] })
  const povText = pov.state.turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.content).join('')
  check('R39-POV 视角坏段撤回后四轮正确正文完成', pov.state.run?.status === 'completed' && pov.calls.length === 5 && !povText.includes('我看见') && Array.from(povText).length === 4000, `status=${pov.state.run?.status} calls=${pov.calls.length}`)
  pov.repo.close()

  const bad = await runEngineCase({ name: 'always-bad', outputs: [BAD], target: 4000 })
  const badText = bad.state.turns.filter((t) => t.role === 'assistant').map((t) => t.content).join('')
  check('R39-EXHAUST 持续跑偏在预算后 waiting_user，不假完成', bad.state.run?.status === 'waiting_user' && bad.state.run?.errorCode === 'strong_constraint_repair_exhausted' && bad.calls.length === 3, `status=${bad.state.run?.status} calls=${bad.calls.length}`)
  check('R39-EXHAUST 失败候选未进入 durable/UI 正文', badText === '' && bad.rendered === '')
  const restoredConfig = JSON.parse(bad.repo.getRun(bad.runId).config_json) as Record<string, any>
  const engine2 = (await load('src/main/jobs/AgentRunEngine.ts')).createAgentRunEngine as (o: Record<string, unknown>) => any
  const restored = engine2({ store: bad.port, modelCall: async () => { throw new Error('not called') }, toolExecutor: async () => '', getConfig: () => restoredConfig, artifactDir: os.tmpdir(), onEvent: () => undefined, onRunUpdate: () => undefined })
  await restored.restore(bad.runId)
  check('R39-RECOVERY 重建引擎仍读取冻结 hash 与 durable 修复水位', restoredConfig.strongConstraints.hash === bad.config.strongConstraints.hash && bad.repo.getCompletionAttempts(bad.runId).filter((a: any) => a.attempt < 0).length === 3)
  bad.repo.close()

  const disabled = await runEngineCase({ name: 'disabled-engine', outputs: [`${exact(BAD, 3999)}。`], enabled: false })
  check('R39-DISABLED 关闭设置后按原完成契约交付', disabled.state.run?.status === 'completed' && disabled.calls.length === 1)
  disabled.repo.close()
  const agent = await runEngineCase({ name: 'agent-engine', outputs: ['这告诉我们，普通问答仍按用户请求直接返回。'], mode: 'agent', target: 0 })
  check('R39-AGENT 普通工具 Agent 未错误套用正文门禁', agent.state.run?.status === 'completed' && agent.calls.length === 1)
  agent.repo.close()
}

async function boundaryChecks(): Promise<void> {
  const adapter = await load('src/main/runKernelAdapter.ts')
  const translate = (adapter.createChunkTranslator as () => (e: any, r: string) => any[])()
  translate({ type: 'turn', turn: { turnId: 'a', role: 'assistant', content: '新正文' } }, 'late')
  const replacement = translate({ type: 'content_replace', content: '', revision: 1, contentHash: 'x' }, 'late')
  translate({ type: 'terminal', run: { runId: 'late', status: 'completed' } }, 'late')
  const late = translate({ type: 'content_replace', content: '迟到旧正文', revision: 2, contentHash: 'y' }, 'late')
  check('R39-STREAM replace 有显式 revision，terminal 后迟到 replace 丢弃', replacement[0]?.type === 'text_replace' && replacement[0]?.replaceRevision === 1 && late.length === 0)

  const ctrlMod = await load('src/main/completion/CompletionController.ts')
  const Controller = ctrlMod.CompletionController as new (o: any) => any
  const controller = new Controller({
    contract: { schemaVersion: 1, runId: 'unknown', validators: [{ id: 'future-validator', severity: 'soft', config: {} }], maxRepairAttempts: 1, createdAt: Date.now() },
    store: { saveEvaluation: () => undefined, getLatestEvaluation: () => null }
  })
  const ev = controller.submitCandidate({ artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
  check('R39-GATE 未知 validator fail-closed', ev.state !== 'completed' && ev.hardFailures.some((f: any) => f.code === 'unknown_validator'))

  const storeSource = fs.readFileSync(path.join(ROOT, 'src/renderer/src/store.ts'), 'utf8')
  const inspectorSource = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/RunInspector/RunInspector.tsx'), 'utf8')
  const panelSource = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8')
  check('R39-UI 设置写入串行且 resync 不允许 lastSeq 回退', storeSource.includes('settingsWriteQueue') && storeSource.includes('snap.lastSeq < current.lastSeq'))
  check('R39-UI 长文面板可查看/编辑当前约束', panelSource.includes('主题锁定') && panelSource.includes('必须原文保留') && panelSource.includes('不要出现'))
  check('R39-UI RunInspector 仅展示结构化检查事实', inspectorSource.includes('data-testid="strong-constraint-progress"') && inspectorSource.includes('检查是否偏题') && inspectorSource.includes('偏移已纠正'))
}

async function main(): Promise<void> {
  if (expectR391Red) await r391RedEvidence()
  else if (expectRed) await redEvidence()
  else {
    await snapshotAndPureChecks()
    await engineChecks()
    await boundaryChecks()
  }
  console.log(`\nR39 ${expectRed ? 'red evidence' : 'strong constraints'}: ${passed} PASS / ${failed} FAIL`)
  if (failed > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
}

main().catch((error) => { console.error(error); process.exit(2) })
