import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import { checkModelReadPolicy, MODEL_READ_MAX_BYTES } from '../src/main/fileRef'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import { streamChat, longGenerate, estimateTokens } from '../src/main/deepseek'
import { buildContext } from '../src/main/context'
import type { DsMessage, PermissionDecision, PermissionSettings, SessionMessageSnapshot, SessionMeta, MemoryInfo, ImportedFileInfo, RenpyProjectInfo, RenpyLintResult } from '../src/shared/types'
import type { ToolDef } from '../src/main/tools'
import type { MetricDistribution, RawSection, TextStyleStats, StylometryProfile, ExemplarPair, StyleGenTask, CandidateEvaluation } from '../src/shared/styleV2'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

const BASE = 'http://127.0.0.1:18789'
const API_KEY = 'test-key'
const MODEL = 'deepseek-v4-flash'

let passed = 0
let failed = 0
let blocked = 0
const blockedNotes: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ==================== 运行时模块加载（契约模块 + agentTools 的 electron 顶层依赖） ====================

const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as {
  build(opts: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>
}

const ELECTRON_SHIM = {
  name: 'electron-shim',
  setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
      contents: 'export const app = { getPath: (n) => String(n), isPackaged: false };\nexport const dialog = { showMessageBox: async () => ({ response: 1 }) };',
      loader: 'js'
    }))
  }
}

async function loadTsModule(rel: string): Promise<Record<string, unknown> | null> {
  const abs = path.resolve(__dirname, '..', rel)
  if (!fs.existsSync(abs)) {
    blockedNotes.push(`${rel} 未落地（测试按契约编写，等待主负责人实现）`)
    return null
  }
  const outfile = path.resolve(__dirname, '..', 'out', `vmod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: desktopSourceExternals(abs, ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate']),
      logLevel: 'silent',
      plugins: [ELECTRON_SHIM]
    })
    const mod = await import(url.pathToFileURL(outfile).href)
    return mod as Record<string, unknown>
  } catch (e) {
    blockedNotes.push(`${rel} 加载失败：${(e as Error).message}`)
    return null
  } finally {
    try {
      await fs.promises.unlink(outfile)
    } catch {
      /* 清理失败忽略 */
    }
  }
}

// ==================== [1]~[5] 既有测试组 ====================

async function testStreamChat(): Promise<void> {
  console.log('\n[1] streamChat：SSE 流式解析 / 思考内容 / usage 采集')
  let text = ''
  let reasoning = ''
  let usage = null
  let finish = null
  await streamChat(
    { apiKey: API_KEY, baseUrl: BASE, model: MODEL, messages: [{ role: 'user', content: '生成文档' }], thinking: { enabled: true, effort: 'high' } },
    (ev) => {
      if (ev.type === 'text') text += ev.delta ?? ''
      if (ev.type === 'reasoning') reasoning += ev.delta ?? ''
      if (ev.type === 'done') {
        finish = ev.finishReason
        usage = ev.usage
      }
    }
  )
  check('文本增量拼接', text === '我来生成文档。', text)
  check('思考内容分离', reasoning.length > 0, reasoning)
  check('finish_reason 传递', finish === 'tool_calls', String(finish))
  check('usage 采集（缓存命中字段）', usage !== null && usage.prompt_cache_hit_tokens === 6, JSON.stringify(usage))
}

async function testLongGenerate(): Promise<void> {
  console.log('\n[2] longGenerate：length 截断 → 自动续写拼接')
  let text = ''
  let usageHit = 0
  const { rounds, finalFinishReason } = await longGenerate({
    params: { apiKey: API_KEY, baseUrl: BASE, model: MODEL, thinking: { enabled: false, effort: 'high' }, maxTokens: 1024 },
    messages: [{ role: 'user', content: '写一个长故事' }],
    maxRounds: 5,
    onEvent: (ev) => {
      if (ev.type === 'text') text += ev.delta ?? ''
      if (ev.type === 'done' && ev.usage) usageHit += ev.usage.prompt_cache_hit_tokens
    },
    onRound: () => undefined
  })
  check('两段内容拼接（第一段+第二段）', text.includes('第一段内容') && text.includes('第二段内容'), text)
  check('rounds 计数为 2', rounds === 2, String(rounds))
  check('最终 finish_reason 为 stop', finalFinishReason === 'stop', String(finalFinishReason))
  check('usage 事件跨轮累加（6+6=12）', usageHit === 12, String(usageHit))
}

async function testToolLoop(): Promise<void> {
  console.log('\n[3] longGenerate：tool_calls 循环（参数跨 chunk 累积 → 执行 → 继续）')
  let text = ''
  let executed: string | null = null
  let toolArgs: unknown = null
  await longGenerate({
    params: { apiKey: API_KEY, baseUrl: BASE, model: MODEL, thinking: { enabled: false, effort: 'high' } },
    messages: [{ role: 'user', content: '帮我生成文档' }],
    maxRounds: 5,
    onEvent: (ev) => {
      if (ev.type === 'text') text += ev.delta ?? ''
    },
    onRound: () => undefined,
    executor: async (name, args) => {
      executed = name
      toolArgs = args
      return '已保存到 /tmp/a.md'
    }
  })
  check('工具名跨 chunk 累积正确', executed === 'generate_markdown_doc', String(executed))
  check('工具 JSON 参数解析正确', (toolArgs as any)?.filename === 'a.md' && (toolArgs as any)?.content === 'hi', JSON.stringify(toolArgs))
  check('工具结果反馈后模型总结', text.includes('工具执行完成'), text)
}

async function testContext(): Promise<void> {
  console.log('\n[4] buildContext：历史裁剪 / 自动摘要 / 缓存命中估算')
  const history: DsMessage[] = []
  for (let i = 0; i < 30; i++) {
    history.push({ role: 'user', content: `第${i}条长消息，包含一些剧情细节和设定信息以便撑大token预算。` })
    history.push({ role: 'assistant', content: `回答第${i}条的内容，继续推进情节。` })
  }
  const result = await buildContext(
    [{ role: 'system', content: '固定系统提示词（模拟剧情引擎，永远不裁剪）' }],
    history,
    { historyBudgetTokens: 400, summarizeOld: true },
    async (oldMsgs) => {
      const { streamChat: sc } = await import('../src/main/deepseek')
      let s = ''
      await sc(
        { apiKey: API_KEY, baseUrl: BASE, model: MODEL, messages: [...oldMsgs, { role: 'user', content: '总结历史' }], thinking: { enabled: false, effort: 'high' } },
        (ev) => {
          if (ev.type === 'text') s += ev.delta ?? ''
        }
      )
      return s
    }
  )
  check('旧消息被裁剪（dropped > 0）', result.dropped > 0, `dropped=${result.dropped}`)
  check('摘要注入前缀', result.summary !== null && result.summary.includes('摘要'), String(result.summary))
  check('固定前缀计入缓存命中估算', result.estimatedCacheHitTokens > 10, `hit=${result.estimatedCacheHitTokens}`)
  check('系统消息排在消息首位', result.messages[0].role === 'system', JSON.stringify(result.messages[0]))
  check('估算 token 数合理', result.estimatedPromptTokens > 0 && result.estimatedPromptTokens < 20000, String(result.estimatedPromptTokens))
}

async function testEstimate(): Promise<void> {
  console.log('\n[5] estimateTokens：中英混合估算')
  const cjk = estimateTokens('这是中文测试，大约十个字')
  const en = estimateTokens('hello world this is english text')
  check('中文按字估算', cjk >= 10 && cjk <= 14, String(cjk))
  check('英文按 4 字符/token', en >= 5 && en <= 8, String(en))
}

// ==================== [6] 权限系统 ====================

interface PermissionManagerShim {
  getSettings(): PermissionSettings
  updateSettings(s: PermissionSettings): Promise<void>
  decide(type: 'command' | 'path', target: string): Promise<PermissionDecision>
}

async function testPermissionSystem(): Promise<void> {
  console.log('\n[6] 权限系统：模式 / 白名单 / 规则优先 / 路径归一化 / 仅一次 / 持久化')
  const mod = await loadTsModule('src/main/permissions.ts')
  if (!mod) {
    blocked++
    console.log('  BLOCK  [6] 权限系统模块不可用，跳过')
    return
  }
  const { createPermissionManager } = mod as {
    createPermissionManager(baseDir: string, askUser?: (type: string, target: string) => Promise<{ action: 'allow' | 'deny'; remember: boolean }>): PermissionManagerShim
  }
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-verify-perm-'))
  try {
    const asks: Array<{ type: string; target: string }> = []
    const askUser = async (type: string, target: string) => {
      asks.push({ type, target })
      return { action: 'allow' as const, remember: false }
    }
    const pm = createPermissionManager(baseDir, askUser)
    const init = pm.getSettings()
    check('初始设置：工作区自动，无预授权规则', init.mode === 'auto' && init.rules.length === 0, JSON.stringify(init))
    await pm.updateSettings({ mode: 'safe', rules: [] })
    let d = await pm.decide('command', 'rm -rf /')
    check('safe 无规则：rm -rf / 触发询问（askUser 被调用）', d.action === 'allow' && asks.length === 1, JSON.stringify(d))
    d = await pm.decide('command', 'ls')
    check('safe 模式：ls 同样触发询问', d.action === 'allow' && asks.length === 2, JSON.stringify(d))

    await pm.updateSettings({ mode: 'auto', rules: [] })
    let nBefore = asks.length
    d = await pm.decide('command', 'ls -la')
    check('auto：ls -la 命中只读白名单 → allow（不询问）', d.action === 'allow' && asks.length === nBefore, JSON.stringify(d))
    d = await pm.decide('command', 'git status')
    check('auto：git status → allow（不询问）', d.action === 'allow' && asks.length === nBefore, JSON.stringify(d))
    d = await pm.decide('command', 'rm -rf x')
    check('auto：rm -rf x 不在白名单 → 询问', d.action === 'allow' && asks.length === nBefore + 1, JSON.stringify(d))
    d = await pm.decide('command', 'git push')
    check('auto：git push → 询问', d.action === 'allow' && asks.length === nBefore + 2, JSON.stringify(d))

    await pm.updateSettings({ mode: 'auto', rules: [{ id: 'r1', type: 'command', pattern: 'git push origin main', action: 'deny', persistent: true }] })
    d = await pm.decide('command', 'git push origin main')
    check('规则优先：deny 规则精确命中 git push origin main → deny', d.action === 'deny' && d.ruleId === 'r1', JSON.stringify(d))
    // Gate 1：前缀放大被阻止 —— 规则 'git push' 不得命中 'git push -f origin main'
    await pm.updateSettings({ mode: 'auto', rules: [{ id: 'r1b', type: 'command', pattern: 'git push', action: 'deny', persistent: true }] })
    d = await pm.decide('command', 'git push -f origin main')
    check('规则收紧：前缀规则 git push 不命中 git push -f origin main（防追加参数绕过）', d.action !== 'deny' && d.ruleId !== 'r1b', JSON.stringify(d))
    await pm.updateSettings({ mode: 'auto', rules: [{ id: 'r6', type: 'command', pattern: 'ls -la', action: 'deny', persistent: true }] })
    d = await pm.decide('command', 'ls -la')
    check('规则优先于白名单：字面量 deny 覆盖 ls 白名单', d.action === 'deny' && d.ruleId === 'r6', JSON.stringify(d))
    // Gate 1：auto 白名单命令在规则精确不匹配时仍放行
    d = await pm.decide('command', 'ls')
    check('规则收紧：ls（无参数）不被 ls -la 规则误伤，仍走白名单', d.action === 'allow', JSON.stringify(d))

    const nBefore2 = asks.length
    await pm.updateSettings({ mode: 'safe', rules: [{ id: 'r2', type: 'path', pattern: 'C:\\Temp\\PROJ', action: 'allow', persistent: true }] })
    d = await pm.decide('path', 'c:\\temp\\proj\\sub\\file.txt')
    check('path 规则大小写不敏感前缀匹配 → allow（不询问）', d.action === 'allow' && d.ruleId === 'r2' && asks.length === nBefore2, JSON.stringify(d))
    d = await pm.decide('path', 'C:\\Temp\\OTHER\\file.txt')
    check('path 未命中规则 → 询问', asks.length === nBefore2 + 1, JSON.stringify(d))

    await pm.updateSettings({ mode: 'auto', rules: [{ id: 'r3', type: 'command', pattern: 'bogus-cmd --x', action: 'allow', persistent: false }] })
    d = await pm.decide('command', 'bogus-cmd --x')
    check('仅一次规则命中 → allow 且带 ruleId', d.action === 'allow' && d.ruleId === 'r3', JSON.stringify(d))
    check('仅一次规则使用后从 rules 移除', !pm.getSettings().rules.some((r) => r.id === 'r3'), JSON.stringify(pm.getSettings().rules))
    const nBefore3 = asks.length
    d = await pm.decide('command', 'bogus-cmd --x')
    check('仅一次规则消耗后再次请求 → 询问', asks.length === nBefore3 + 1, JSON.stringify(d))

    await pm.updateSettings({
      mode: 'auto',
      rules: [
        { id: 'r4', type: 'command', pattern: 'git push -f origin main', action: 'deny', persistent: true },
        { id: 'r5', type: 'path', pattern: 'C:\\Temp\\PROJ', action: 'allow', persistent: true }
      ]
    })
    const pm2 = createPermissionManager(baseDir)
    const s2 = pm2.getSettings()
    check('持久化：新实例读回 settings 一致', s2.mode === 'auto' && s2.rules.length === 2, JSON.stringify(s2))
    d = await pm2.decide('command', 'git push -f origin main')
    check('持久化：deny 规则跨实例生效', d.action === 'deny' && d.ruleId === 'r4', JSON.stringify(d))
    d = await pm2.decide('path', 'c:/temp/proj/data/file.txt')
    check('持久化：path 规则跨实例生效', d.action === 'allow' && d.ruleId === 'r5', JSON.stringify(d))

    const pm3 = createPermissionManager(path.join(baseDir, 'nouser'))
    await pm3.updateSettings({ mode: 'safe', rules: [] })
    d = await pm3.decide('command', 'ls')
    check('严格确认且无 UI：需询问的操作默认拒绝', d.action === 'deny', JSON.stringify(d))
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true })
  }
}

// ==================== [7] 会话存储 ====================

interface SessionStoreShim {
  createSession(id: string, title: string, model: string): Promise<void>
  appendMessage(id: string, msg: SessionMessageSnapshot): Promise<void>
  loadSession(id: string): Promise<SessionMessageSnapshot[]>
  listSessions(): Promise<SessionMeta[]>
  deleteSession(id: string): Promise<void>
}

async function testSessionStore(): Promise<void> {
  console.log('\n[7] 会话存储：追加 / 覆盖去重 / meta / 删除')
  const mod = await loadTsModule('src/main/sessionStore.ts')
  if (!mod) {
    blocked++
    console.log('  BLOCK  [7] 会话存储模块不可用，跳过')
    return
  }
  const { createSessionStore } = mod as { createSessionStore(baseDir: string): SessionStoreShim }
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-verify-sess-'))
  try {
    const store = createSessionStore(baseDir)
    const snap = (id: string, role: 'user' | 'assistant', content: string): SessionMessageSnapshot => ({
      id,
      role,
      content,
      reasoning: '',
      status: 'done',
      usage: null,
      rounds: 0,
      toolNames: [],
      createdAt: Date.now()
    })
    await store.createSession('s1', '测试会话', 'deepseek-v4-flash')
    let list = await store.listSessions()
    check(
      'createSession 后 meta 写入',
      list.length === 1 && list[0].id === 's1' && list[0].title === '测试会话' && list[0].model === 'deepseek-v4-flash' && list[0].messageCount === 0,
      JSON.stringify(list)
    )
    await store.appendMessage('s1', snap('m1', 'user', '你好'))
    await store.appendMessage('s1', snap('m2', 'assistant', '嗨，有什么可以帮你？'))
    await store.appendMessage('s1', snap('m1', 'user', '你好（覆盖更新）'))
    const loaded = await store.loadSession('s1')
    check('同 id 覆盖去重：loadSession 返回 2 条', loaded.length === 2, JSON.stringify(loaded.map((m) => m.id)))
    check('覆盖后内容为后者', loaded[0].content === '你好（覆盖更新）', JSON.stringify(loaded[0].content))
    check('顺序正确（首次出现序）', loaded[0].id === 'm1' && loaded[1].id === 'm2', loaded.map((m) => m.id).join(','))
    list = await store.listSessions()
    check('meta：messageCount 为追加计数 3', list[0].messageCount === 3, String(list[0].messageCount))
    check('meta：updatedAt >= createdAt', list[0].updatedAt >= list[0].createdAt, JSON.stringify(list[0]))
    check('meta：首个 user 消息作为标题', list[0].title === '你好', list[0].title)
    await store.deleteSession('s1')
    check('deleteSession 后 list 为空', (await store.listSessions()).length === 0, JSON.stringify(await store.listSessions()))
    check('deleteSession 后 loadSession 为空', (await store.loadSession('s1')).length === 0)
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true })
  }
}

// ==================== [8] 记忆层 ====================

async function testMemory(): Promise<void> {
  console.log('\n[8] 记忆层：AGENTS.md 向上查找 / userData 记忆 / 空返回')
  const mod = await loadTsModule('src/main/memory.ts')
  if (!mod) {
    blocked++
    console.log('  BLOCK  [8] 记忆层模块不可用，跳过')
    return
  }
  const { loadMemory } = mod as { loadMemory(workDir: string, userDataDir: string): Promise<MemoryInfo> }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-verify-mem-'))
  try {
    const workDir = path.join(root, 'proj')
    const sub = path.join(workDir, 'sub')
    const userData = path.join(root, 'userData')
    await fsp.mkdir(sub, { recursive: true })
    await fsp.mkdir(userData, { recursive: true })
    await fsp.writeFile(path.join(workDir, 'AGENTS.md'), '项目说明：这是项目级记忆。', 'utf-8')
    await fsp.writeFile(path.join(userData, 'memory.md'), '用户长期记忆：喜欢蓝色。', 'utf-8')
    const info = await loadMemory(sub, userData)
    check(
      '向上查找到 workDir/AGENTS.md',
      info.projectMemoryPath !== null && path.resolve(info.projectMemoryPath) === path.resolve(path.join(workDir, 'AGENTS.md')),
      String(info.projectMemoryPath)
    )
    check('项目记忆内容读取', info.projectMemoryContent.includes('项目级记忆'), info.projectMemoryContent)
    check('用户记忆路径正确', info.userMemoryPath === path.join(userData, 'memory.md'), info.userMemoryPath)
    check('用户记忆内容读取', info.userMemoryContent.includes('喜欢蓝色'), info.userMemoryContent)

    const root2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-verify-mem2-'))
    const sub2 = path.join(root2, 'a', 'b')
    const userData2 = path.join(root2, 'ud')
    await fsp.mkdir(sub2, { recursive: true })
    await fsp.mkdir(userData2, { recursive: true })
    const info2 = await loadMemory(sub2, userData2)
    check('均不存在：projectMemoryPath 为 null', info2.projectMemoryPath === null, String(info2.projectMemoryPath))
    check('均不存在：内容为空串', info2.projectMemoryContent === '' && info2.userMemoryContent === '', JSON.stringify(info2))
    await fsp.rm(root2, { recursive: true, force: true })
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

// ==================== [9] agent 工具（真实执行） ====================

async function testAgentTools(): Promise<void> {
  console.log('\n[9] agent 工具：文件读写 / 编辑 / 搜索 / 列表 / 命令执行（真实执行，无 mock API）')
  const mod = await loadTsModule('src/main/agentTools.ts')
  if (!mod) {
    blocked++
    console.log('  BLOCK  [9] agentTools 不可用（含 electron 顶层依赖），跳过')
    return
  }
  const m = mod as {
    agentTools: ToolDef[]
    setSessionTrusted(v: boolean): void
    setPermissionManager(pm: unknown | null): void
  }
  const permMod = await loadTsModule('src/main/permissions.ts')
  if (!permMod) {
    blocked++
    console.log('  BLOCK  [9] 依赖权限模块不可用，跳过')
    return
  }
  const { createPermissionManager } = permMod as {
    createPermissionManager(baseDir: string, askUser?: (type: string, target: string) => Promise<{ action: 'allow' | 'deny'; remember: boolean }>): PermissionManagerShim
  }
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-verify-agent-'))
  const permDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-verify-agperm-'))
  try {
    const pmAllow = createPermissionManager(permDir, async () => ({ action: 'allow', remember: false }))
    m.setPermissionManager(pmAllow)
    const env = { workDir, docDir: workDir }
    const run = (name: string, args: Record<string, unknown>) => m.agentTools.find((t) => t.name === name)!.execute(args, workDir, env)

    let r = await run('write_file', { path: 'sub/a.txt', content: 'hello agent\nline2\n' })
    check('write_file 写入成功', r.ok === true, JSON.stringify(r))
    r = await run('read_file', { path: 'sub/a.txt' })
    check('read_file 读回内容一致', r.ok === true && r.message.includes('hello agent'), r.message)
    r = await run('edit_file', { path: 'sub/a.txt', old_text: 'line2', new_text: 'line2b' })
    check('edit_file 唯一匹配替换成功', r.ok === true, JSON.stringify(r))
    r = await run('read_file', { path: 'sub/a.txt' })
    check('edit_file 后内容已更新', r.message.includes('line2b'), r.message)
    await run('write_file', { path: 'multi.txt', content: 'x\ny\nx\n' })
    r = await run('edit_file', { path: 'multi.txt', old_text: 'x', new_text: 'z' })
    check('edit_file 多匹配返回失败', r.ok === false && r.message.includes('匹配到'), r.message)
    r = await run('edit_file', { path: 'multi.txt', old_text: 'zzz', new_text: 'z' })
    check('edit_file 无匹配返回失败', r.ok === false && r.message.includes('未找到'), r.message)
    r = await run('search_files', { pattern: 'line2b', path: 'sub' })
    check('search_files 命中且行号正确', r.ok === true && r.message.includes('a.txt:2'), r.message)
    r = await run('list_files', { path: '.', depth: 2 })
    check('list_files 输出含目录标记与文件', r.ok === true && r.message.includes('sub/') && r.message.includes('multi.txt'), r.message)
    r = await run('run_command', { command: 'echo hello' })
    check('run_command（权限注入 allow）退出码 0 且输出含 hello', r.ok === true && r.message.includes('hello'), r.message)

    const pmDeny = createPermissionManager(path.join(permDir, 'deny'), async () => ({ action: 'deny', remember: false }))
    m.setPermissionManager(pmDeny)
    r = await run('run_command', { command: 'echo hello' })
    check('run_command 注入 deny → 拒绝执行', r.ok === false && r.message.includes('拒绝'), r.message)

    m.setPermissionManager(null)
    m.setSessionTrusted(true)
    r = await run('run_command', { command: 'echo hello' })
    check('无权限管理器 + 会话信任 → 直接执行', r.ok === true && r.message.includes('hello'), r.message)
    m.setSessionTrusted(false)
    r = await run('run_command', { command: 'echo hello' })
    check('无权限管理器 + 无信任（node 无 UI）→ 拒绝', r.ok === false && r.message.includes('拒绝'), r.message)
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
    await fsp.rm(permDir, { recursive: true, force: true })
  }
}

// ==================== [10] Checkpoint（写前备份 / restore 回滚 / 越界拒绝 / makeDiff） ====================

interface CheckpointStoreShim {
  beforeWrite(filePath: string, sessionId: string): Promise<{ backupId: string; existed: boolean }>
  restore(backupId: string, sessionId: string): Promise<{ ok: boolean; path: string; message: string }>
  clearSession(sessionId: string): Promise<void>
}

async function listFilesRec(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) await walk(p)
      else out.push(p)
    }
  }
  await walk(dir)
  return out
}

async function testCheckpoint(): Promise<void> {
  console.log('\n[10] Checkpoint：写前备份 / restore 回滚 / 越界拒绝 / makeDiff（临时目录真实文件）')
  const mod = await loadTsModule('src/main/checkpoint.ts')
  if (!mod) {
    blocked++
    console.log('  BLOCK  [10] checkpoint 模块未落地，跳过')
    return
  }
  const m = mod as {
    createCheckpointStore(baseDir: string): CheckpointStoreShim
    makeDiff?(oldText: string, newText: string, filePath: string): unknown
  }
  if (typeof m.createCheckpointStore !== 'function') {
    blocked++
    blockedNotes.push('src/main/checkpoint.ts 未导出 createCheckpointStore（契约冲突）')
    console.log('  BLOCK  [10] createCheckpointStore 未导出，跳过')
    return
  }
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-verify-cp-'))
  const outside = path.join(baseDir, '..', `ds-outside-${Date.now()}.txt`)
  try {
    const store = m.createCheckpointStore(baseDir)
    const file = path.join(baseDir, 'a.txt')
    await fsp.writeFile(file, 'v1\n', 'utf-8')
    const r1 = await store.beforeWrite(file, 's1')
    check('beforeWrite 已存在文件 → existed=true', r1.existed === true, JSON.stringify(r1))
    check('backupId 非空', typeof r1.backupId === 'string' && r1.backupId.length > 0, String(r1.backupId))
    let files = await listFilesRec(baseDir)
    check('备份文件生成（checkpoint 目录下 .bak 存在）', files.some((f) => f.endsWith('.bak') || f.toLowerCase().includes('backup')), files.join(', '))
    check('原文件未被改动', (await fsp.readFile(file, 'utf-8')) === 'v1\n')
    const backupFilesBefore = files.filter((f) => f.endsWith('.bak') || f.toLowerCase().includes('backup')).length

    const newFile = path.join(baseDir, 'new.txt')
    const r2 = await store.beforeWrite(newFile, 's1')
    check('beforeWrite 未存在文件 → existed=false', r2.existed === false, JSON.stringify(r2))
    files = await listFilesRec(baseDir)
    const backupFilesAfter = files.filter((f) => f.endsWith('.bak') || f.toLowerCase().includes('backup')).length
    check('未存在文件 → 无备份生成', backupFilesAfter === backupFilesBefore, `before=${backupFilesBefore} after=${backupFilesAfter}`)

    await fsp.writeFile(file, 'v2\n', 'utf-8')
    const rr = await store.restore(r1.backupId, 's1')
    check('restore → ok=true 且原内容恢复', rr.ok === true && (await fsp.readFile(file, 'utf-8')) === 'v1\n', JSON.stringify(rr))
    check('restore → path 指向原文件', rr.ok === true && path.resolve(rr.path) === path.resolve(file), String(rr.path))

    let badRestore = false
    try {
      const rb = await store.restore('no-such-backup-id', 's1')
      badRestore = rb.ok === false
    } catch {
      badRestore = true
    }
    check('无效 backupId → restore 拒绝', badRestore)

    await fsp.writeFile(outside, 'outside-content', 'utf-8')
    let escRejected = false
    try {
      const rOut = await store.beforeWrite(outside, 's1')
      if (rOut.existed) {
        try {
          const re = await store.restore(rOut.backupId, 's1')
          escRejected = re.ok === false
        } catch {
          escRejected = true
        }
      }
    } catch {
      escRejected = true
    }
    check('越界路径（allowedRoots 之外）→ 拒绝（beforeWrite/restore）', escRejected)

    const r3 = await store.beforeWrite(file, 's1')
    await fsp.writeFile(file, 'v3\n', 'utf-8')
    await store.clearSession('s1')
    let cleared = false
    try {
      const rc = await store.restore(r3.backupId, 's1')
      cleared = rc.ok === false
    } catch {
      cleared = true
    }
    check('clearSession 后对应备份被清理（restore 失败）', cleared)

    const md = (typeof m.makeDiff === 'function' ? m.makeDiff : (store as Record<string, unknown>).makeDiff) as
      | ((oldText: string, newText: string, filePath: string) => unknown)
      | undefined
    if (typeof md !== 'function') {
      blocked++
      blockedNotes.push('src/main/checkpoint.ts 未导出 makeDiff（模块级或实例级，契约冲突）')
      console.log('  BLOCK  [10] makeDiff 不可用，跳过')
      return
    }
    const anyMd = md as (oldText: string, newText: string, filePath: string) => any
    const d0 = anyMd('同一段文本', '同一段文本', 'x.md')
    check('makeDiff 相同文本 → null', d0 === null, JSON.stringify(d0))
    const old1 = '第一行\n第二行\n第三行\n'
    const new1 = '第一行\n第二行（改动）\n第三行\n'
    const d1 = anyMd(old1, new1, 'docs/ch1.md')
    check('单行修改 → added=1 removed=1', d1 !== null && d1.added === 1 && d1.removed === 1, JSON.stringify(d1))
    check('单行修改 → content 含 + 行与 - 行', d1 !== null && /^\+[^+]/m.test(d1.content) && /^-[^-]/m.test(d1.content), String(d1?.content))
    check('makeDiff → path 字段正确', d1 !== null && d1.path === 'docs/ch1.md', String(d1?.path))
    const old2 = 'a\nb\nc\nd\n'
    const new2 = 'a\nx\nc\nd\nz\n'
    const d2 = anyMd(old2, new2, 'multi.md')
    check('多行增删 → added=2 removed=1', d2 !== null && d2.added === 2 && d2.removed === 1, JSON.stringify(d2))
    check('多行增删 → content 含 + 行与 - 行', d2 !== null && /^\+[^+]/m.test(d2.content) && /^-[^-]/m.test(d2.content), String(d2?.content))
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(outside, { force: true })
  }
}

// ==================== [11] API 错误分类 ====================

async function testErrorClassification(): Promise<void> {
  console.log('\n[11] classifyApiError：401 / 429 / 500 / 网络 / Abort 分类（mock 错误路由 + 真实死端口）')
  const mod = await loadTsModule('src/main/deepseek.ts')
  const classify = mod && typeof (mod as Record<string, unknown>).classifyApiError === 'function' ? ((mod as Record<string, unknown>).classifyApiError as (err: unknown) => any) : null
  if (!classify) {
    blocked++
    blockedNotes.push('src/main/deepseek.ts 未导出 classifyApiError（V0.2 #3 契约冲突：错误分类未落地）')
    console.log('  BLOCK  [11] classifyApiError 未落地，跳过')
    return
  }
  const withStatus = (status: number): unknown => Object.assign(new Error(`mock api ${status}`), { status })
  const c401 = classify(withStatus(401))
  check('401 → kind=unauthorized', c401.kind === 'unauthorized', JSON.stringify(c401))
  check('401 → retryable=false', c401.retryable === false, String(c401.retryable))
  const c429 = classify(withStatus(429))
  check('429 → kind=rate_limited', c429.kind === 'rate_limited', JSON.stringify(c429))
  check('429 → retryable=true', c429.retryable === true, String(c429.retryable))
  const c500 = classify(withStatus(500))
  check('500 → kind=server_error', c500.kind === 'server_error', JSON.stringify(c500))
  check('500 → retryable=true', c500.retryable === true, String(c500.retryable))
  check('500 → 中文可读文案非空', typeof c500.message === 'string' && c500.message.length > 0, String(c500.message))

  let netErr: unknown = null
  try {
    await fetch('http://127.0.0.1:18799/chat/completions', { method: 'POST', body: '{}' })
  } catch (e) {
    netErr = e
  }
  const cn = classify(netErr)
  check('fetch 失败（死端口）→ kind=network', cn.kind === 'network', JSON.stringify(cn))
  check('网络错误 → retryable=true', cn.retryable === true, String(cn.retryable))

  const ac = new AbortController()
  ac.abort()
  let abortErr: unknown = null
  try {
    await fetch('http://127.0.0.1:18789/ping', { method: 'POST', body: '{}', signal: ac.signal })
  } catch (e) {
    abortErr = e
  }
  const ca = classify(abortErr)
  check('AbortError → retryable=false（不重试）', ca.retryable === false, JSON.stringify(ca))
}

// ==================== [12] streamChat 错误传播结构 ====================

async function testErrorPropagation(): Promise<void> {
  console.log('\n[12] streamChat：非 2xx 抛带 status 的错误（ApiStatusError 传播结构，mock 401 路由）')
  const mod = await loadTsModule('src/main/deepseek.ts')
  if (!mod) {
    blocked++
    console.log('  BLOCK  [12] deepseek 模块不可用，跳过')
    return
  }
  let thrown: any = null
  try {
    await streamChat(
      { apiKey: API_KEY, baseUrl: BASE, model: MODEL, messages: [{ role: 'user', content: 'err401' }], thinking: { enabled: false, effort: 'high' } },
      () => undefined
    )
  } catch (e) {
    thrown = e
  }
  if (!thrown || typeof thrown.status === 'undefined') {
    blocked++
    blockedNotes.push('src/main/deepseek.ts 未落地错误传播契约：非 2xx 未抛带 status 的错误（当前为裸 Error，V0.2 #3 进行中）')
    console.log('  BLOCK  [12] 错误传播契约未落地，跳过')
    return
  }
  check('401 响应抛错（非静默成功）', true)
  check('错误携带 status===401', thrown.status === 401, String(thrown.status))
  const ApiStatusError = (mod as Record<string, unknown>).ApiStatusError
  if (typeof ApiStatusError === 'function') {
    check('错误为 ApiStatusError 实例', thrown instanceof (ApiStatusError as new (...a: unknown[]) => unknown))
  }
  check('错误信息非空（含状态详情）', typeof thrown.message === 'string' && thrown.message.length > 0, String(thrown.message))
}

// ==================== [13] 文件导入（临时目录真实文件） ====================

type ImportFileFn = (filePath: string, maxChars?: number) => Promise<{ ok: true; info: ImportedFileInfo } | { ok: false; error: string }>

const PNG_1X1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfab4d0000000049454e44ae426082', 'hex')

async function testFileImport(): Promise<void> {
  console.log('\n[13] 文件导入：UTF-8/GBK/BOM/md/rpy/docx/epub/图片/不存在/二进制（临时目录真实文件）')
  const mod = await loadTsModule('src/main/fileImport.ts')
  const importFile = mod && typeof (mod as Record<string, unknown>).importFile === 'function' ? ((mod as Record<string, unknown>).importFile as ImportFileFn) : null
  if (!importFile) {
    blocked++
    blockedNotes.push('src/main/fileImport.ts 未导出 importFile（V0.3 #1 契约：importFile(filePath, maxChars?) → {ok,info}|{ok:false,error}）')
    console.log('  BLOCK  [13] importFile 未落地，跳过')
    return
  }
  const requireDep = createRequire(import.meta.url)
  let iconv: { encode(text: string, enc: string): Buffer } | null = null
  let fflate: { zipSync(o: Record<string, unknown>, o2?: Record<string, unknown>): Uint8Array; strToU8(s: string): Uint8Array } | null = null
  let docx: { Document: new (o: Record<string, unknown>) => unknown; Packer: { toBuffer(doc: unknown): Promise<Buffer> }; Paragraph: new (text: string) => unknown } | null = null
  try {
    iconv = requireDep('iconv-lite')
  } catch {
    blockedNotes.push('iconv-lite 不可用，GBK 用例无法构造')
  }
  try {
    fflate = requireDep('fflate')
  } catch {
    blockedNotes.push('fflate 不可用，epub 用例无法构造')
  }
  try {
    docx = requireDep('docx')
  } catch {
    blockedNotes.push('docx 库不可用，docx 用例无法构造')
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-verify-imp-'))
  try {
    const utf8Text = '第一章 海边的约定\n莎拉站在海岸线上，望着远方的帆船。'
    const utf8File = path.join(dir, 'chapter.txt')
    await fsp.writeFile(utf8File, utf8Text, 'utf-8')
    let r = await importFile(utf8File)
    check('UTF-8 中文 txt → ok', r.ok === true, JSON.stringify(r).slice(0, 120))
    check('UTF-8 中文 txt → source=utf8', r.ok && r.info.source === 'utf8', r.ok ? r.info.source : '-')
    check('UTF-8 中文 txt → 内容一致', r.ok && r.info.text === utf8Text, r.ok ? r.info.text : '-')
    check('UTF-8 中文 txt → info 字段齐全', r.ok && typeof r.info.name === 'string' && typeof r.info.path === 'string' && typeof r.info.size === 'number' && r.info.truncated === false, JSON.stringify(r).slice(0, 120))

    if (iconv) {
      const gbkText = '这是GBK编码的中文小说文本，用来测试解码不乱码。'
      const gbkFile = path.join(dir, 'gbk.txt')
      await fsp.writeFile(gbkFile, iconv.encode(gbkText, 'gbk'))
      r = await importFile(gbkFile)
      check('GBK txt → source=gbk', r.ok && r.info.source === 'gbk', r.ok ? r.info.source : '-')
      check('GBK txt → 解码无乱码（text 含原中文）', r.ok && r.info.text.includes('GBK编码的中文小说文本'), r.ok ? r.info.text : '-')

      const longText = Array.from({ length: 60 }, (_, i) => `段落${i}：海风轻轻吹过甲板，故事从这里慢慢展开。`).join('\n')
      const gbkLongFile = path.join(dir, 'gbk-long.txt')
      await fsp.writeFile(gbkLongFile, iconv.encode(longText, 'gbk'))
      r = await importFile(gbkLongFile, 50)
      check('GBK 长文本 + maxChars=50 → truncated=true', r.ok && r.info.truncated === true, r.ok ? `len=${r.info.text.length}` : '-')
      check('GBK 长文本截断 → text.length<=50', r.ok && r.info.text.length <= 50, r.ok ? String(r.info.text.length) : '-')
    } else {
      blocked++
      console.log('  BLOCK  [13] GBK 用例（iconv-lite 不可用）')
    }

    const bomFile = path.join(dir, 'bom.txt')
    await fsp.writeFile(bomFile, Buffer.from('\uFEFF带着BOM的中文内容', 'utf-8'))
    r = await importFile(bomFile)
    check('UTF-8 BOM → 无 BOM 字符残留（text[0]!==\\uFEFF）', r.ok && r.info.text.length > 0 && r.info.text[0] !== '\uFEFF', r.ok ? JSON.stringify(r.info.text[0]) : '-')

    const mdFile = path.join(dir, 'doc.md')
    await fsp.writeFile(mdFile, '# 标题\n正文内容', 'utf-8')
    r = await importFile(mdFile)
    check('.md → source=utf8', r.ok && r.info.source === 'utf8', r.ok ? r.info.source : '-')
    const rpyFile = path.join(dir, 'script.rpy')
    await fsp.writeFile(rpyFile, 'define config.name = "测试"\nlabel start:\n    pass\n', 'utf-8')
    r = await importFile(rpyFile)
    check('.rpy → source=utf8', r.ok && r.info.source === 'utf8', r.ok ? r.info.source : '-')

    if (docx) {
      const d = new docx.Document({
        sections: [{ properties: {}, children: [new docx.Paragraph('第一章 中文段落'), new docx.Paragraph('莎拉轻声说道。')] }]
      })
      const docxFile = path.join(dir, 'book.docx')
      await fsp.writeFile(docxFile, await docx.Packer.toBuffer(d))
      r = await importFile(docxFile)
      check('.docx → ok && source=docx', r.ok && r.info.source === 'docx', r.ok ? r.info.source : '-')
      check('.docx → text 含中文段落', r.ok && r.info.text.includes('第一章 中文段落'), r.ok ? r.info.text : '-')
    } else {
      blocked++
      console.log('  BLOCK  [13] .docx 用例（docx 库不可用）')
    }

    if (fflate) {
      const epubFile = path.join(dir, 'book.epub')
      const zip = fflate.zipSync({
        mimetype: [fflate.strToU8('application/epub+zip'), { level: 0 }],
        'META-INF/container.xml': fflate.strToU8(
          '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
        ),
        'OEBPS/content.opf': fflate.strToU8(
          '<?xml version="1.0" encoding="UTF-8"?><package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:deepwriter:verify:book</dc:identifier><dc:title>测试书</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c1"/></spine></package>'
        ),
        'OEBPS/nav.xhtml': fflate.strToU8(
          '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">第一章</a></li></ol></nav></body></html>'
        ),
        'OEBPS/c1.xhtml': fflate.strToU8(
          '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><p>中文章节内容，海边的故事。</p></body></html>'
        )
      })
      await fsp.writeFile(epubFile, zip)
      r = await importFile(epubFile)
      check('.epub → ok && source=epub', r.ok && r.info.source === 'epub', r.ok ? r.info.source : '-')
      check('.epub → text 含中文（html 去标签）', r.ok && r.info.text.includes('中文章节内容'), r.ok ? r.info.text : '-')
    } else {
      blocked++
      console.log('  BLOCK  [13] .epub 用例（fflate 不可用）')
    }

    const imgFile = path.join(dir, 'pic.png')
    await fsp.writeFile(imgFile, PNG_1X1)
    r = await importFile(imgFile)
    check('图片（1x1 PNG）→ ok && source=image', r.ok && r.info.source === 'image', r.ok ? r.info.source : '-')
    check('图片 → text 非空（素材说明）', r.ok && r.info.text.length > 0, r.ok ? r.info.text : '-')

    r = await importFile(path.join(dir, 'no-such-file.txt'))
    check('不存在文件 → {ok:false} 且 error 非空', r.ok === false && typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r))

    const binFile = path.join(dir, 'data.bin')
    await fsp.writeFile(binFile, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x00]))
    r = await importFile(binFile)
    check('二进制 .bin（含 \\0）→ {ok:false}', r.ok === false, JSON.stringify(r).slice(0, 120))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

// ==================== [14] Galgame 扫描 + [15] lint 失败路径 ====================

const RENPY_SAMPLE = `define config.name = "海之约"
define sara = Character("莎拉", color="#f00")
define kai = Character("凯")

label start:
    $ sara_affection += 1
    sara "你好"
    menu:
        "选项A":
            $ sara_affection += 2
            jump route_a

label route_a:
    pass
`

async function writeRenpySample(root: string): Promise<string> {
  const scriptDir = path.join(root, 'game', 'script')
  await fsp.mkdir(scriptDir, { recursive: true })
  await fsp.writeFile(path.join(scriptDir, 'chapter1.rpy'), RENPY_SAMPLE, 'utf-8')
  await fsp.writeFile(path.join(scriptDir, 'chapter2.rpy'), 'define mei = Character("梅")\n\nlabel route_b:\n    mei "再见"\n', 'utf-8')
  return root
}

async function testGalgameScan(): Promise<void> {
  console.log('\n[14] Galgame 扫描：config.name / Character / 好感度变量 / label / script 文件（临时目录最小项目）')
  const mod = await loadTsModule('src/main/galgame.ts')
  const scan = mod && typeof (mod as Record<string, unknown>).scanRenpyProject === 'function' ? ((mod as Record<string, unknown>).scanRenpyProject as (dir: string) => Promise<RenpyProjectInfo>) : null
  if (!scan) {
    blocked++
    blockedNotes.push('src/main/galgame.ts 未导出 scanRenpyProject（V0.3 #2 契约：scanRenpyProject(dir) → RenpyProjectInfo）')
    console.log('  BLOCK  [14] scanRenpyProject 未落地，跳过')
    return
  }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-verify-galgame-'))
  try {
    const proj = await writeRenpySample(path.join(root, 'mygame'))
    const info = await scan(proj)
    check('gameName=海之约（config.name）', info.gameName === '海之约', String(info.gameName))
    check('scriptFiles 2 个（game/script 下 .rpy）', Array.isArray(info.scriptFiles) && info.scriptFiles.length === 2, JSON.stringify(info.scriptFiles))
    check('scriptDir 指向 game/script', typeof info.scriptDir === 'string' && info.scriptDir.replace(/\\/g, '/').includes('game/script'), String(info.scriptDir))
    const hasChar = (v: string, d: string) => info.characters.some((c) => c.varName === v && c.displayName === d)
    check('characters 含 sara(莎拉)', hasChar('sara', '莎拉'), JSON.stringify(info.characters))
    check('characters 含 kai(凯)', hasChar('kai', '凯'), JSON.stringify(info.characters))
    check('affinityVars 含 sara_affection（$ += 提取）', Array.isArray(info.affinityVars) && info.affinityVars.includes('sara_affection'), JSON.stringify(info.affinityVars))
    check('labels 含 start', Array.isArray(info.labels) && info.labels.includes('start'), JSON.stringify(info.labels))
    check('labels 含 route_a', info.labels.includes('route_a'), JSON.stringify(info.labels))

    let empty: RenpyProjectInfo | null = null
    let threw = false
    try {
      empty = await scan(path.join(root, 'does-not-exist'))
    } catch {
      threw = true
    }
    check('不存在的目录 → 空结构不抛', !threw && empty !== null, threw ? 'threw' : JSON.stringify(empty))
    check(
      '不存在的目录 → 空数组/null 字段',
      empty !== null && empty.scriptFiles.length === 0 && empty.characters.length === 0 && empty.affinityVars.length === 0 && empty.labels.length === 0 && empty.gameName === null,
      JSON.stringify(empty)
    )
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

async function testGalgameLint(): Promise<void> {
  console.log('\n[15] lint 失败路径：lintRenpyProject(不存在的 renpy.exe, 项目目录) → {ok:false, exitCode:null, output 非空}')
  const mod = await loadTsModule('src/main/galgame.ts')
  const lint = mod && typeof (mod as Record<string, unknown>).lintRenpyProject === 'function' ? ((mod as Record<string, unknown>).lintRenpyProject as (sdkPath: string, dir: string) => Promise<RenpyLintResult>) : null
  if (!lint) {
    blocked++
    blockedNotes.push('src/main/galgame.ts 未导出 lintRenpyProject（V0.3 #2 契约：lintRenpyProject(sdkPath, dir) → {ok,output,exitCode}）')
    console.log('  BLOCK  [15] lintRenpyProject 未落地，跳过')
    return
  }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-verify-lint-'))
  try {
    const proj = await writeRenpySample(path.join(root, 'proj'))
    const result = await Promise.race([
      lint('C:/nonexistent/renpy.exe', proj),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lint 调用超时（10s，可能 spawn error 未处理）')), 10000))
    ])
    check('lint 失败路径 → ok=false', result.ok === false, JSON.stringify(result))
    check('lint 失败路径 → exitCode=null', result.exitCode === null, String(result.exitCode))
    check('lint 失败路径 → output 非空（错误信息）', typeof result.output === 'string' && result.output.length > 0, String(result.output).slice(0, 120))
  } catch (e) {
    check('lint 失败路径 → 不抛、不挂起（10s 内返回）', false, (e as Error).message)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

// ==================== [16] 小说模式纯函数 ====================

interface NovelModuleShim {
  buildNovelMaterial(messages: DsMessage[], maxChars?: number): { material: string; truncated: boolean }
  buildNovelRequest(material: string): DsMessage[]
}

async function testNovel(): Promise<void> {
  console.log('\n[16] 小说模式：buildNovelMaterial 拼接/截断 + buildNovelRequest 请求构造（纯函数）')
  const mod = await loadTsModule('src/main/novel.ts')
  const m = mod as NovelModuleShim | null
  if (!mod) {
    blocked++
    blockedNotes.push('src/main/novel.ts 未落地（V0.3.5 #1 契约：buildNovelMaterial / buildNovelRequest）')
    console.log('  BLOCK  [16] novel 模块未落地，跳过')
    return
  }
  if (typeof m?.buildNovelMaterial !== 'function' || typeof m?.buildNovelRequest !== 'function') {
    blocked++
    blockedNotes.push('src/main/novel.ts 契约冲突：buildNovelMaterial / buildNovelRequest 未导出')
    console.log('  BLOCK  [16] novel 导出缺失，跳过')
    return
  }

  const msgs: DsMessage[] = [
    { role: 'user', content: '我想写一个海边相遇的故事' },
    { role: 'assistant', content: '好，主角叫什么名字？' },
    { role: 'user', content: '' },
    { role: 'user', content: '主角叫阿海，女主叫小岚。'.repeat(20) },
    { role: 'assistant', content: '记下了，继续。' }
  ]
  const m1 = m.buildNovelMaterial(msgs)
  check('素材含全部非空内容拼接', ['我想写一个海边相遇的故事', '好，主角叫什么名字？', '主角叫阿海', '记下了，继续。'].every((s) => m1.material.includes(s)), m1.material.slice(0, 120))
  check('拼接顺序正确（user/assistant 交错保持）', m1.material.indexOf('我想写一个海边相遇的故事') < m1.material.indexOf('好，主角叫什么名字？') && m1.material.indexOf('主角叫阿海') < m1.material.indexOf('记下了，继续。'), m1.material.slice(0, 120))
  check('默认 maxChars → 不截断', m1.truncated === false, JSON.stringify(m1))

  const m2 = m.buildNovelMaterial(msgs, 100)
  check('maxChars=100 → truncated=true', m2.truncated === true, JSON.stringify(m2))
  check('截断后 material.length<=100', m2.material.length <= 100, String(m2.material.length))

  const material = '素材：海边相遇，阿海与小岚的约定。'
  const req = m.buildNovelRequest(material)
  check('messages.length===2', Array.isArray(req) && req.length === 2, JSON.stringify(req))
  check('messages[0] 为 system 且含"小说整理专家"', req[0]?.role === 'system' && req[0].content.includes('小说整理专家'), JSON.stringify(req[0]?.content))
  check('messages[1] 为 user 且 content===material', req[1]?.role === 'user' && req[1].content === material, JSON.stringify(req[1]?.content))

  const empty = m.buildNovelMaterial([{ role: 'user', content: '' }, { role: 'assistant', content: '' }])
  check('全部消息为空 → material 空串不抛', empty.material === '' && empty.truncated === false, JSON.stringify(empty))

  const direct = m.buildDirectNovelRequest('# 剧情引擎（Story Engine）\n体裁：悬疑', '少年在小镇发现旧钟楼的秘密')
  check('直接生成：messages.length===2', Array.isArray(direct) && direct.length === 2, JSON.stringify(direct))
  check('直接生成：system 为剧情引擎 prompt', direct[0]?.role === 'system' && direct[0].content.includes('剧情引擎'), JSON.stringify(direct[0]?.content))
  check('直接生成：user 为剧情简介', direct[1]?.role === 'user' && direct[1].content === '少年在小镇发现旧钟楼的秘密', JSON.stringify(direct[1]?.content))

  const novelMode = m.buildNovelModeSystem()
  check('成书模式提示词非空且含创作累积', typeof novelMode === 'string' && novelMode.includes('创作累积模式'), novelMode.slice(0, 80))
}

// ==================== [17] 安全回归（外部审计反例） ====================

async function testSecurityRegression(): Promise<void> {
  console.log('\n[17] 安全回归：shell 串联 / 路径边界 / .. 穿越 / SSE 尾帧 / 三轮上下文')
  const mod = await loadTsModule('src/main/permissions.ts')
  if (!mod || typeof mod.isSafeAutoCommand !== 'function') {
    console.log('  BLOCK  [17] isSafeAutoCommand 未导出，跳过')
    return
  }
  const { isSafeAutoCommand, createPermissionManager: cpm } = mod as {
    isSafeAutoCommand: (cmd: string) => boolean
    createPermissionManager: (dir: string, ask?: (t: string, target: string) => Promise<{ action: string; remember: boolean }>) => {
      updateSettings: (s: unknown) => Promise<void>
      decide: (type: string, target: string) => Promise<{ action: string; reason: string }>
    }
  }
  const SAFE: [string, boolean][] = [
    ['git status & echo PWNED', false],
    ['dir && del important.txt', false],
    ['echo x > sensitive.txt', false],
    ['rm -rf /', false],
    ['ls -la; whoami', false],
    ['cd C:\\Windows', false],
    ['git status', true],
    ['git diff --stat', true],
    ['git log --oneline', true],
    ['git branch -a', true],
    ['git remote -v', true],
    ['git push origin master', false],
    ['ls -la', true],
    ['node --version', false],
    ['pip list', false],
    ['npm ls', false],
    ['echo hello', true],
    ['pwd', true]
  ]
  for (const [cmd, expect] of SAFE) {
    check(`isSafeAutoCommand('${cmd}') → ${expect}`, isSafeAutoCommand(cmd) === expect, isSafeAutoCommand(cmd) ? '放行' : '拒绝')
  }

  const askLog: string[] = []
  const pm = cpm(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sec-')), async (t, target) => {
    askLog.push(`${t}:${target}`)
    return { action: 'deny', remember: false }
  })
  await pm.updateSettings({ mode: 'auto', rules: [] })
  const m1 = await pm.decide('command', 'git status & echo PWNED')
  check('auto 模式：shell 串联命令被询问（不再自动放行）', m1.action !== 'allow', `${m1.action} ${m1.reason}`)
  const m2 = await pm.decide('command', 'git status')
  check('auto 模式：安全只读命令自动放行', m2.action === 'allow', `${m2.action} ${m2.reason}`)
  const m3 = await pm.decide('command', 'git push origin main')
  check('auto 模式：git push 被询问', m3.action !== 'allow', `${m3.action} ${m3.reason}`)

  const pm2 = cpm(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sec2-')), async () => ({ action: 'deny', remember: false }))
  const safeRoot = path.resolve(os.tmpdir(), 'dw-safe-project')
  const siblingRoot = path.resolve(os.tmpdir(), 'dw-safe-project-evil')
  await pm2.updateSettings({
    mode: 'safe',
    rules: [{ id: 'r1', type: 'path', pattern: safeRoot, action: 'allow', persistent: true }]
  })
  const p1 = await pm2.decide('path', path.join(safeRoot, 'a.txt'))
  check('路径边界：同目录命中规则', p1.action === 'allow' && p1.ruleId === 'r1', `${p1.action} ${p1.ruleId}`)
  const p2 = await pm2.decide('path', path.join(siblingRoot, 'secret.txt'))
  check('路径边界：project-evil 不被误匹配', p2.action !== 'allow', `${p2.action}`)
  const p3 = await pm2.decide('path', path.join(safeRoot, '..', path.basename(siblingRoot), 'secret.txt'))
  check('路径边界：.. 穿越不被误匹配', p3.action !== 'allow', `${p3.action}`)
  const p4 = await pm2.decide('path', path.join(safeRoot, 'sub', 'deep.txt'))
  check('路径边界：子目录命中规则', p4.action === 'allow' && p4.ruleId === 'r1', `${p4.action} ${p4.ruleId}`)

  console.log('  -- SSE 尾帧（无结尾换行）--')
  const http = require('node:http') as typeof import('node:http')
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"index":0,"delta":{"content":"前段"},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"index":0,"delta":{"content":"尾段"},"finish_reason":"stop"}]}')
    res.end()
  })
  await new Promise<void>((r) => srv.listen(18889, '127.0.0.1', r))
  try {
    let text = ''
    let finish: string | null = null
    await streamChat(
      { apiKey: 'k', baseUrl: 'http://127.0.0.1:18889', model: 'm', messages: [{ role: 'user', content: 'hi' }], thinking: { enabled: false, effort: 'low' } },
      (ev) => {
        if (ev.type === 'text') text += ev.delta ?? ''
        if (ev.type === 'done') finish = ev.finishReason
      }
    )
    check('SSE 尾帧：无换行尾事件被解析', text.includes('尾段'), text)
    check('SSE 尾帧：finish_reason 正常', finish === 'stop', String(finish))
  } finally {
    await new Promise<void>((r) => srv.close(() => r()))
  }

  console.log('  -- 三轮 length 截断上下文完整（独立临时 SSE）--')
  const srv2 = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const { messages } = JSON.parse(body)
      const asstCount = messages.filter((m: { role: string }) => m.role === 'assistant').length
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `轮${asstCount + 1}`, role: 'assistant' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => srv2.listen(18890, '127.0.0.1', r))
  try {
    const { longGenerate: lg } = await loadTsModule('src/main/deepseek.ts')
    let reqBodies: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      reqBodies.push(String(init?.body ?? ''))
      return origFetch(input as RequestInfo, init)
    }) as typeof fetch
    try {
      await lg({
        params: { apiKey: 'k', baseUrl: 'http://127.0.0.1:18890', model: 'm', thinking: { enabled: false, effort: 'low' }, maxTokens: 10 },
        messages: [{ role: 'user', content: 'start' }],
        maxRounds: 5,
        onEvent: () => undefined,
        onRound: () => undefined
      })
    } finally {
      globalThis.fetch = origFetch
    }
    const thirdBody = reqBodies[2] ?? ''
    check('三轮截断：第三轮请求包含第一轮内容', thirdBody.includes('轮1'), thirdBody.slice(0, 300))
    check('三轮截断：第三轮请求包含第二轮内容', thirdBody.includes('轮2'), thirdBody.slice(0, 300))
    check('三轮截断：第三轮含续写指令', thirdBody.includes('续写'), '')
  } finally {
    await new Promise<void>((r) => srv2.close(() => r()))
  }
}

// ==================== [18] Activity 协议与 reducer ====================

function mkActivityEvent(seq: number, type: string, phase: string, extra: Record<string, unknown> = {}): any {
  return {
    schemaVersion: 1,
    runId: 'run-test',
    sessionId: 'sess-test',
    seq,
    timestamp: 1000 + seq,
    elapsedMs: seq * 10,
    type,
    phase,
    title: `t${seq}`,
    ...extra
  }
}

async function testActivityProtocol(): Promise<void> {
  console.log('\n[18] Activity 协议：reducer 幂等 / 乱序 / 缺 seq / 终态 / 脱敏 / 校验')
  const mod = await loadTsModule('src/shared/activity.ts')
  if (!mod || typeof mod.createRunReducer !== 'function') {
    console.log('  BLOCK  [18] src/shared/activity.ts 未落地，跳过')
    return
  }
  const { createRunReducer, validateActivityEvent, safeToolInputSummary, safeOutputPreview, ACTIVITY_SCHEMA_VERSION } = mod as {
    createRunReducer: () => (s: any, ev: any) => any
    validateActivityEvent: (raw: unknown) => { ok: boolean; ev?: unknown; error?: string }
    safeToolInputSummary: (raw: unknown, max?: number) => string
    safeOutputPreview: (out: string, max?: number) => string
    ACTIVITY_SCHEMA_VERSION: number
  }
  const reducer = createRunReducer()

  let s: any = null
  s = reducer(s, mkActivityEvent(0, 'run.started', 'understanding', { title: '开始' }))
  s = reducer(s, mkActivityEvent(1, 'phase.changed', 'reading', { title: '读取文件' }))
  check('[18] 顺序应用：steps 追加', s.steps.length === 1 && s.lastSeq === 1, JSON.stringify(s.lastSeq))
  check('[18] 顺序应用：status 跟随 phase', s.status === 'reading', s.status)

  const dup = reducer(s, mkActivityEvent(1, 'phase.changed', 'reading', { title: '读取文件' }))
  check('[18] 重复事件幂等（seq 相同忽略）', dup.steps.length === 1 && dup.lastSeq === 1, JSON.stringify(dup.steps.length))

  const outOfOrder = reducer(s, mkActivityEvent(1, 'phase.changed', 'reading', { title: 'x' }))
  check('[18] 乱序事件被忽略', outOfOrder.steps.length === 1, '')

  s = reducer(s, mkActivityEvent(3, 'phase.changed', 'writing', { title: '撰写正文' }))
  check('[18] 缺 seq（1→3）触发 needsResync', s.needsResync === true, String(s.needsResync))
  s = reducer(s, mkActivityEvent(2, 'phase.changed', 'thinking', { title: '思考' }))
  check('[18] 缺口后的旧 seq 按乱序忽略（由 UI resync 修复）', s.lastSeq === 3 && s.steps.length === 2 && s.needsResync === true, `seq=${s.lastSeq} steps=${s.steps.length} resync=${s.needsResync}`)

  s = reducer(s, mkActivityEvent(4, 'tool.started', 'executing_tool', { payload: { kind: 'tool', toolCallId: 'c1', toolName: 'read_file', safeInputSummary: 'a.txt' } }))
  check('[18] tool.started 进入时间线', s.steps.some((st: any) => st.type === 'tool.started'), JSON.stringify(s.steps.map((st: any) => st.type)))
  s = reducer(s, mkActivityEvent(5, 'tool.completed', 'executing_tool', { payload: { kind: 'tool', toolCallId: 'c1', toolName: 'read_file', safeInputSummary: 'a.txt', durationMs: 12 } }))
  check('[18] 工具生命周期合并到 toolsById', s.toolsById['c1']?.status === 'done' && s.toolsById['c1']?.durationMs === 12, JSON.stringify(s.toolsById['c1']))

  s = reducer(s, mkActivityEvent(6, 'usage.updated', 'writing', { payload: { kind: 'usage', source: 'estimated', inputTokens: 100 } }))
  s = reducer(s, mkActivityEvent(7, 'usage.updated', 'writing', { payload: { kind: 'usage', source: 'actual', inputTokens: 88, cacheHitTokens: 50 } }))
  check('[18] usage estimated 被 actual 替换（非相加）', s.usage?.source === 'actual' && s.usage?.inputTokens === 88, JSON.stringify(s.usage))

  s = reducer(s, mkActivityEvent(8, 'run.completed', 'completed', { title: '完成' }))
  check('[18] 终态 terminal 记录', s.terminal?.state === 'completed' && s.status === 'completed', JSON.stringify(s.terminal))

  const late = reducer(s, mkActivityEvent(9, 'phase.changed', 'writing', { title: '迟到' }))
  check('[18] 终态后迟到事件被忽略', late.lastSeq === 8 && late.status === 'completed', String(late.lastSeq))

  const s2: any = null
  let r2 = reducer(s2, mkActivityEvent(0, 'run.started', 'understanding', { title: 's' }))
  for (let i = 1; i <= 250; i++) {
    r2 = reducer(r2, mkActivityEvent(i, 'activity.message', 'writing', { title: `m${i}` }))
  }
  check('[18] steps 上限 200', r2.steps.length <= 200 && r2.steps.length === 200, String(r2.steps.length))

  const okEv = validateActivityEvent(mkActivityEvent(0, 'run.started', 'understanding'))
  check('[18] validate：合法事件通过', okEv.ok === true, String(okEv.ok))
  const bad1 = validateActivityEvent({ schemaVersion: ACTIVITY_SCHEMA_VERSION, runId: '', sessionId: 's', seq: 0, timestamp: 1, elapsedMs: 1, type: 'run.started', phase: 'understanding' })
  check('[18] validate：空 runId 拒绝', bad1.ok === false, String(bad1.error))
  const bad2 = validateActivityEvent(mkActivityEvent(0, 'not.a.type', 'understanding'))
  check('[18] validate：非法 type 拒绝', bad2.ok === false, String(bad2.error))
  const bad3 = validateActivityEvent(mkActivityEvent(0, 'run.started', 'nonsense-phase'))
  check('[18] validate：非法 phase 拒绝', bad3.ok === false, String(bad3.error))

  const scrubbed = safeToolInputSummary('rm -rf / && echo $HOME "x" | whoami')
  check('[18] 脱敏：移除 shell 元字符', !/[&|;$"'`]/.test(scrubbed), scrubbed)
  const longSum = safeToolInputSummary('a'.repeat(300))
  check('[18] 脱敏：超长截断', longSum.length <= 161 && longSum.endsWith('…'), String(longSum.length))
  const outPreview = safeOutputPreview('line1\n' + 'x'.repeat(5000))
  check('[18] 输出预览：截断且含总字符说明', /共 \d+ 字符/.test(outPreview), outPreview.slice(-40))
}

// ==================== [19] journal 与 bus ====================

async function testJournalAndBus(): Promise<void> {
  console.log('\n[19] Activity Journal / Bus：持久化 / seq / 唯一终态 / prune')
  const journalMod = await loadTsModule('src/main/runJournal.ts')
  const busMod = await loadTsModule('src/main/activityBus.ts')
  if (!journalMod || typeof journalMod.createRunJournal !== 'function' || !busMod || typeof busMod.createActivityBus !== 'function') {
    console.log('  BLOCK  [19] runJournal/activityBus 未落地，跳过')
    return
  }
  const { createRunJournal } = journalMod as { createRunJournal: (dir: string) => any }
  const { createActivityBus } = busMod as {
    createActivityBus: (opts: { baseDir: string; push: (ev: any) => void }) => { startRun: (i: { sessionId: string; runId: string }) => any; getSnapshot: (runId: string) => Promise<any>; listActive: () => string[] }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-activity-'))
  const pushed: any[] = []
  const bus = createActivityBus({ baseDir: dir, push: (ev) => pushed.push(ev) })

  const run = bus.startRun({ sessionId: 's1', runId: 'run-abc' })
  await new Promise((r) => setTimeout(r, 20))
  check('[19] startRun 自动发 run.started', pushed[0]?.type === 'run.started' && pushed[0]?.seq === 0, JSON.stringify(pushed[0]?.type))
  await run.setPhase('reading', '读取文件')
  await run.emit({ type: 'activity.message', phase: 'reading', title: '读取 3 个文件' } as any)
  await run.emit({ type: 'tool.started', phase: 'executing_tool', title: 'read_file', payload: { kind: 'tool', toolCallId: 'c1', toolName: 'read_file', safeInputSummary: 'x' } } as any)
  await run.emit({ type: 'tool.completed', phase: 'executing_tool', title: 'read_file 完成', payload: { kind: 'tool', toolCallId: 'c1', toolName: 'read_file', safeInputSummary: 'x', durationMs: 5 } } as any)
  await run.complete('完成')
  check('[19] seq 严格递增', pushed.every((e, i) => e.seq === i), JSON.stringify(pushed.map((e) => e.seq)))
  check('[19] 事件先入 journal 后 push（顺序与数量一致）', pushed.length >= 5, String(pushed.length))

  const snap = await bus.getSnapshot('run-abc')
  check('[19] snapshot：status=completed 且 terminal 存在', snap?.status === 'completed' && snap?.terminal?.state === 'completed', JSON.stringify(snap?.terminal))
  check('[19] snapshot：steps 含 phase/message/tool.started/tool.completed 4 条', snap?.steps?.length === 4, JSON.stringify(snap?.steps?.map((s: any) => s.type)))
  check('[19] snapshot：toolsById 合并为 done', snap?.toolsById?.['c1']?.status === 'done' && snap?.toolsById?.['c1']?.durationMs === 5, JSON.stringify(snap?.toolsById))

  const pushedBefore = pushed.length
  const after = await run.emit({ type: 'activity.message', phase: 'writing', title: '迟到' } as any)
  check('[19] 终态后 emit 不新增推送（仅 warn）', pushed.length === pushedBefore, `${pushed.length} vs ${pushedBefore}`)
  check('[19] 终态后 emit 返回 stub（不入 journal）', after !== null && after.seq <= snap?.lastSeq + 1, String(after?.seq))

  const bus2 = createActivityBus({ baseDir: dir, push: () => undefined })
  const snap2 = await bus2.getSnapshot('run-abc')
  check('[19] 冷启动从 journal 恢复 snapshot', snap2?.status === 'completed' && snap2?.lastSeq === (snap?.lastSeq ?? 0), String(snap2?.lastSeq))

  const jr = createRunJournal(dir)
  await jr.append('run-b', { schemaVersion: 1, runId: 'run-b', sessionId: 's', seq: 0, timestamp: 1, elapsedMs: 0, type: 'run.started', phase: 'queued' })
  await jr.append('run-c', { schemaVersion: 1, runId: 'run-c', sessionId: 's', seq: 0, timestamp: 1, elapsedMs: 0, type: 'run.started', phase: 'queued' })
  await jr.prune(2)
  const runs = await jr.listRuns()
  check('[19] prune 保留最近 N 个', runs.length === 2, JSON.stringify(runs.map((r: any) => r.runId)))
  let rejected = false
  try {
    await jr.append('../evil', { schemaVersion: 1, runId: '../evil', sessionId: 's', seq: 0, timestamp: 1, elapsedMs: 0, type: 'run.started', phase: 'queued' })
  } catch {
    rejected = true
  }
  check('[19] 非法 runId 被拒绝', rejected, '')
}

// ==================== [20] 风格参照：统计 / 画像 / 防复制 ====================

async function testStyleMode(): Promise<void> {
  console.log('\n[20] 风格参照：本地统计 / 画像构建 / 防复制检测')
  const mod = await loadTsModule('src/shared/style.ts')
  if (!mod || typeof mod.analyzeText !== 'function') {
    console.log('  BLOCK  [20] src/shared/style.ts 未落地，跳过')
    return
  }
  const { analyzeText, extractForbiddenPhrases, buildProfile, buildStylePrompt, checkOverlap } = mod as {
    analyzeText: (t: string) => any
    extractForbiddenPhrases: (t: string, min?: number, max?: number) => string[]
    buildProfile: (i: { name: string; sources: any[]; sourceHashes: string[] }) => any
    buildStylePrompt: (p: any) => string
    checkOverlap: (t: string, s: string) => any
  }

  const shortSentences = '他来了。风停了。她笑。天很蓝。雨落了。走吧。别回头。'
  const longText = '清晨的海风裹着咸味，穿过小镇的街道。她站在栈桥尽头，望着远方，想起很多年前那个约定。那一天，海浪拍打着礁石，发出低沉的轰鸣。'
  const dialogueText = '「你怎么来了？！」她惊讶地抬起头。「我说过会等你。」他笑了，声音很轻。「可是……已经太晚了。」她低下头，声音有些颤抖。「不晚，永远都不晚！」'

  const st1 = analyzeText(shortSentences)
  check('[20] 短句统计：句均长度偏短', st1.sentenceLenMean < 8, `mean=${st1.sentenceLenMean}`)
  check('[20] 短句统计：感叹/停顿合理', st1.sentenceVar >= 0, '')
  const st2 = analyzeText(longText)
  check('[20] 长句统计：句均长度更长', st2.sentenceLenMean > st1.sentenceLenMean, `a=${st1.sentenceLenMean} b=${st2.sentenceLenMean}`)
  const st3 = analyzeText(dialogueText)
  check('[20] 对白占比：引号文本被统计', st3.dialogueRatio > 0.4, `ratio=${st3.dialogueRatio}`)
  check('[20] 省略号密度：省略号被统计', st3.ellipsisDensity > 0, `d=${st3.ellipsisDensity}`)
  check('[20] 感叹密度：感叹句被统计', st3.exclamRatio > 0.1, `r=${st3.exclamRatio}`)

  const phrases = extractForbiddenPhrases('主角叫林晚，林晚住在海边的小镇，林晚每天清晨都会去码头。码头边有一家旧书店，旧书店的老板姓陈。林晚和陈老板成了忘年交。')
  check('[20] 防复制词表：高频专名短语被提取', phrases.some((p) => p.includes('林晚')), JSON.stringify(phrases))

  const profile = buildProfile({
    name: '测试画像',
    sources: [
      { name: 's1', stats: st1, weight: 1 },
      { name: 's2', stats: st2, weight: 1 }
    ],
    sourceHashes: ['h1', 'h2']
  })
  check('[20] 画像：14 个维度', profile.dimensions.length === 14, String(profile.dimensions.length))
  check('[20] 画像：生成写作规则', profile.positiveRules.length >= 5, JSON.stringify(profile.positiveRules.slice(0, 2)))
  check('[20] 画像：句子长度规则与数据一致', profile.positiveRules.some((r: string) => r.includes('短促') || r.includes('长句')), '')

  const prompt = buildStylePrompt(profile)
  check('[20] 画像 prompt：含防抄袭纪律', prompt.includes('防抄袭纪律'), prompt.slice(0, 100))
  check('[20] 画像 prompt：含写作要求', prompt.includes('写作要求'), '')

  const sourceText = '夜色像墨水一样浓稠。她沿着空无一人的街道慢慢走，路灯把影子拉得很长。远处传来海浪的声音，一遍又一遍，像是某种召唤。'
  const overlapText = sourceText + '。她终于停下脚步，回头望向那盏还在亮着的灯。'
  const report = checkOverlap(overlapText, sourceText)
  check('[20] 防复制：连续重叠被检出（≥12 字）', report.longestMatch >= 12, `longest=${report.longestMatch}`)
  check('[20] 防复制：相似度合理', report.similarity > 0.3 && report.similarity <= 1, String(report.similarity))
  const cleanText = '风把她的头发吹乱。她想着明天的船票，想着那封信，心里乱糟糟的。也许一切都会好起来吧。'
  const clean = checkOverlap(cleanText, sourceText)
  check('[20] 防复制：独立文本无重叠', clean.longestMatch === 0 && clean.matches.length === 0, `longest=${clean.longestMatch}`)

  const bigSource = ('潮水退去，沙滩上留下细碎的痕迹。'.repeat(200))
  const bigText = bigSource + '不一样的结尾。'
  const t0 = Date.now()
  const big = checkOverlap(bigText, bigSource)
  const elapsed = Date.now() - t0
  check('[20] 防复制：大文本性能（<2s）', elapsed < 2000 && big.longestMatch >= 12, `${elapsed}ms longest=${big.longestMatch}`)

  const styleMod = await loadTsModule('src/main/styleModule.ts')
  if (!styleMod || typeof styleMod.createStyleModule !== 'function') {
    console.log('  BLOCK  [20] styleModule 未落地，跳过持久化部分')
    return
  }
  const { createStyleModule: csm } = styleMod as { createStyleModule: (dir: string) => any }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-style-'))
  const srcTxt = path.join(dir, 'sample.txt')
  await fsp.writeFile(srcTxt, '他站在雨里，等了一个晚上。雨一直下，街灯把影子拉长。她始终没有来。后来他才知道，那天她在医院，发着高烧。', 'utf-8')
  const sm = csm(dir)
  const added = await sm.addSources([srcTxt])
  check('[20] 模块：样本导入并分析', added.length === 1 && added[0].status === 'analyzed', JSON.stringify(added))
  const dup = await sm.addSources([srcTxt])
  check('[20] 模块：重复样本去重', dup.length === 0, String(dup.length))
  const built = await sm.buildProfile({ name: '雨夜风', sourceIds: [added[0].id] })
  check('[20] 模块：画像构建含维度与规则', built.id.length > 0 && built.dimensions.length === 14, built.id)
  await sm.setActive(built.id)
  const active = await sm.getActiveProfile()
  check('[20] 模块：激活与读取', active?.id === built.id, String(active?.id))
  const rep = await sm.checkOverlap(built.id, '他站在雨里，等了一个晚上。雨一直下。')
  check('[20] 模块：防复制检测回源', rep.longestMatch >= 12 && rep.sourceName === 'sample.txt', `longest=${rep.longestMatch} src=${rep.sourceName}`)
  const state = await sm.listState()
  check('[20] 模块：状态持久化', state.profiles.length === 1 && state.sources.length === 1 && state.activeProfileId === built.id, JSON.stringify({ p: state.profiles.length, s: state.sources.length }))
  await sm.deleteProfile(built.id)
  const after = await sm.getActiveProfile()
  check('[20] 模块：删除画像后激活清空', after === null, String(after))
}

// ==================== [21] styleV2 本地核心测试 ====================

interface StyleV2Shim {
  computeDistribution(values: number[]): MetricDistribution
  segmentText(text: string): RawSection[]
  splitChunksByParagraph(sections: RawSection[], minChars?: number, maxChars?: number): { workTitle: string; chapterOrdinal: number; text: string }[]
  splitCorpusByChapter(chunks: { chapterOrdinal: number }[], profileRatio?: number, exampleRatio?: number): { split: string }[]
  dedupeChunks(chunks: { sha256: string; text: string }[]): { sha256: string; text: string }[]
  collectFrequentNames(chunks: { text: string }[], minCount?: number, maxNames?: number): Set<string>
  maskContent(text: string, names: Set<string>): string
  textStats(text: string): TextStyleStats
  buildStylometryProfile(statsList: TextStyleStats[]): StylometryProfile
  retrieveExemplars(exemplars: ExemplarPair[], task: Pick<StyleGenTask, 'sceneType' | 'narrativeFunctions' | 'pov'>, k?: number): ExemplarPair[]
  metricScore(value: number, dist: MetricDistribution): { z: number; score: number }
  evaluateCandidate(text: string, opts: { profile: StylometryProfile; requiredFacts: string[]; forbiddenFacts: string[]; sources: { text: string; sourceName: string }[]; forbiddenPhrases: string[] }): CandidateEvaluation
  rankCandidates(evaluations: CandidateEvaluation[]): CandidateEvaluation[]
}

async function testStyleV2Core(): Promise<void> {
  console.log('\n[21] styleV2 本地核心：分布/切分/分段/三分/去重/遮蔽/统计/画像/检索/评分/四路/边界')
  const mod = await loadTsModule('src/shared/styleV2.ts')
  if (!mod) {
    blocked++
    blockedNotes.push('src/shared/styleV2.ts 未落地（V0.5 #1 契约：本地纯函数集）')
    console.log('  BLOCK  [21] src/shared/styleV2.ts 不可用，跳过')
    return
  }
  const required = ['computeDistribution', 'segmentText', 'splitChunksByParagraph', 'splitCorpusByChapter', 'dedupeChunks', 'collectFrequentNames', 'maskContent', 'textStats', 'buildStylometryProfile', 'retrieveExemplars', 'metricScore', 'scoreStylometry', 'scoreContent', 'scoreNovelty', 'scoreNaturalness', 'evaluateCandidate', 'rankCandidates']
  const missing = required.filter((f) => typeof (mod as Record<string, unknown>)[f] !== 'function')
  if (missing.length > 0) {
    blocked++
    blockedNotes.push(`src/shared/styleV2.ts 契约冲突：未导出 ${missing.join('/')}`)
    console.log('  BLOCK  [21] styleV2 导出缺失，跳过')
    return
  }
  const sv = mod as unknown as StyleV2Shim

  const d1 = sv.computeDistribution([1, 2, 3, 4, 5, 6, 7, 8, 9])
  check('[21] 分布：n=9', d1.n === 9, String(d1.n))
  check('[21] 分布：p50=5', d1.p50 === 5, String(d1.p50))
  check('[21] 分布：mean=5', d1.mean === 5, String(d1.mean))
  check('[21] 分布：std>0（样本标准差）', d1.std > 0, String(d1.std))
  check('[21] 分布：P10=1 P90=9（1..9 边界）', d1.p10 === 1 && d1.p90 === 9, `p10=${d1.p10} p90=${d1.p90}`)
  check('[21] 分布：分位数单调', d1.p10 <= d1.p25 && d1.p25 <= d1.p50 && d1.p50 <= d1.p75 && d1.p75 <= d1.p90, JSON.stringify([d1.p10, d1.p25, d1.p50, d1.p75, d1.p90]))
  const dEmpty = sv.computeDistribution([])
  check('[21] 分布：空数组 n=0 不抛', dEmpty.n === 0 && dEmpty.mean === 0 && dEmpty.p50 === 0, JSON.stringify(dEmpty))
  const dOne = sv.computeDistribution([7])
  check('[21] 边界：单值分布 n=1 std=0', dOne.n === 1 && dOne.mean === 7 && dOne.std === 0, JSON.stringify(dOne))

  const chapterText = '第一章 海边的约定\n海风裹着咸味，她站在栈桥尽头。\n\n第二章 码头\n旧书店的灯还亮着。\n\n第三章 归途\n船笛声响起，她笑了。\n'
  const segs = sv.segmentText(chapterText)
  check('[21] 切分：三章标题 → 3 section', segs.length === 3, String(segs.length))
  check('[21] 切分：标题作为 workTitle', segs.map((s) => s.workTitle).join('|') === '第一章 海边的约定|第二章 码头|第三章 归途', JSON.stringify(segs.map((s) => s.workTitle)))
  check('[21] 切分：chapterOrdinal 递增 1/2/3', segs.map((s) => s.chapterOrdinal).join(',') === '1,2,3', JSON.stringify(segs.map((s) => s.chapterOrdinal)))
  check('[21] 切分：正文不含标题行', segs.every((s) => !s.text.includes('第') && !s.text.includes('章')), '')
  const segNo = sv.segmentText('没有章节标题的正文，只是长长的一段叙述，没有换行分章。')
  check('[21] 切分：无章节标题 → 1 section', segNo.length === 1, String(segNo.length))
  check('[21] 切分：无标题 → workTitle=未命名', segNo[0]?.workTitle === '未命名', segNo[0]?.workTitle)

  const chunks = sv.splitChunksByParagraph(sv.segmentText(Array.from({ length: 5 }, () => '海'.repeat(150)).join('\n')), 200, 500)
  check('[21] 分段：长文本 chunk 数 > 1', chunks.length > 1, String(chunks.length))
  check('[21] 分段：每 chunk 长度在 [200,650] 合理范围', chunks.every((c) => c.text.length >= 200 && c.text.length <= 650), JSON.stringify(chunks.map((c) => c.text.length)))
  check('[21] 分段：workTitle 透传', chunks.every((c) => c.workTitle === '未命名'), JSON.stringify(chunks.map((c) => c.workTitle)))
  const chunksShort = sv.splitChunksByParagraph(sv.segmentText('她推开窗，海风迎面扑来，远处的帆船缓缓驶过。'.repeat(3)), 200, 500)
  check('[21] 分段：短文本 → 1 chunk', chunksShort.length === 1, String(chunksShort.length))

  const ch10 = Array.from({ length: 10 }, (_, i) => ({ chapterOrdinal: i + 1 }))
  const splits = sv.splitCorpusByChapter(ch10)
  const cnt = (s: string): number => splits.filter((x) => x.split === s).length
  check('[21] 三分：10 章 → profile 6', cnt('profile') === 6, `profile=${cnt('profile')}`)
  check('[21] 三分：example 2~3（2.5 下取整）', cnt('example') >= 2 && cnt('example') <= 3, `example=${cnt('example')}`)
  check('[21] 三分：holdout 覆盖剩余', cnt('holdout') === 10 - cnt('profile') - cnt('example'), `holdout=${cnt('holdout')}`)
  check('[21] 三分：全部 chunk 有归属', splits.length === 10 && splits.every((x) => x.split === 'profile' || x.split === 'example' || x.split === 'holdout'), '')
  const mixed = sv.splitCorpusByChapter([{ chapterOrdinal: 1 }, { chapterOrdinal: 1.4 }, { chapterOrdinal: 2 }, { chapterOrdinal: 2.9 }])
  check('[21] 三分：同章多 chunk 同归属', mixed[0]?.split === mixed[1]?.split && mixed[2]?.split === mixed[3]?.split, JSON.stringify(mixed.map((m) => m.split)))

  const dedup = sv.dedupeChunks([
    { sha256: 'abc', text: '内容1' },
    { sha256: 'abc', text: '内容1' },
    { sha256: 'def', text: '内容2' }
  ])
  check('[21] 去重：相同 sha256 两份 → 保留 1', dedup.length === 2 && dedup.filter((c) => c.sha256 === 'abc').length === 1, JSON.stringify(dedup.map((c) => c.sha256)))

  const nameText = '林晚住在海边小镇，林晚每天清晨去码头，林晚喜欢旧书店，林晚常在海边看日落，林晚的船是蓝色的。'
  const names = sv.collectFrequentNames([{ text: nameText }])
  check('[21] 遮蔽：重复专名"林晚"×5 被收集', names.has('林晚'), JSON.stringify([...names]))
  const masked = sv.maskContent('林晚在2024年5月去了码头，买了三本书。', names)
  check('[21] 遮蔽：数字 → ⟨NUM⟩', masked.includes('⟨NUM⟩'), masked)
  check('[21] 遮蔽：专名 → ⟨NAME⟩（原文消失）', masked.includes('⟨NAME⟩') && !masked.includes('林晚'), masked)
  check('[21] 遮蔽：保留标点与常用词', masked.includes('。') && masked.includes('码头') && masked.includes('三本书'), masked)

  const stShort = sv.textStats('他来了。风停了。她笑。天很蓝。雨落了。')
  const stLong = sv.textStats('清晨的海风裹着咸味，穿过小镇的街道，她站在栈桥尽头，望着远方，想起很多年前那个约定，海浪拍打着礁石，发出低沉的轰鸣。')
  const meanLen = (l: number[]): number => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0)
  check('[21] 统计：短句文本句均 < 8', meanLen(stShort.sentLens) < 8, String(meanLen(stShort.sentLens)))
  check('[21] 统计：长句文本句均 > 20', meanLen(stLong.sentLens) > 20, String(meanLen(stLong.sentLens)))
  check('[21] 统计：句均差异显著（长 > 2×短）', meanLen(stLong.sentLens) > meanLen(stShort.sentLens) * 2, `短=${meanLen(stShort.sentLens)} 长=${meanLen(stLong.sentLens)}`)
  const stDia = sv.textStats('「你怎么来了？！」她惊讶地抬起头。「我说过会等你。」他笑了。「可是……已经太晚了。」她低下头。「不晚，永远都不晚！」')
  check('[21] 统计：引号对白 diaRatios > 0.3', stDia.diaRatios.some((r) => r > 0.3), JSON.stringify(stDia.diaRatios))
  check('[21] 统计：感叹密度 > 0', stDia.exclamRatios.some((r) => r > 0), JSON.stringify(stDia.exclamRatios))
  check('[21] 统计：省略号密度 > 0', stDia.ellipsisDens.some((d) => d > 0), JSON.stringify(stDia.ellipsisDens))

  const prof = sv.buildStylometryProfile([stShort, stLong])
  const distFields = ['sentenceLen', 'paraLen', 'sentenceVar', 'dialogueRatio', 'exclamRatio', 'ellipsisDensity', 'punctDensity', 'actionDensity', 'psychDensity', 'sensoryDensity', 'colorDensity', 'idiomDensity', 'firstPersonRatio'] as const
  check('[21] 画像：13 个分布字段齐全且 n>0', distFields.every((f) => { const v = prof[f]; return v && v.n > 0 }), JSON.stringify(distFields.filter((f) => !prof[f])))
  check('[21] 画像：sentenceLen 分布有效', prof.sentenceLen.n > 0 && prof.sentenceLen.mean > 0, JSON.stringify(prof.sentenceLen))
  check('[21] 画像：dialogueNext 五键齐全', ['action', 'psych', 'sensory', 'narrative', 'none'].every((k) => typeof (prof.dialogueNext as Record<string, number>)[k] === 'number' && (prof.dialogueNext as Record<string, number>)[k] >= 0), JSON.stringify(Object.keys(prof.dialogueNext)))

  const mkEx = (id: string, chunkId: string, scene: string, ratio: number): ExemplarPair => ({
    id,
    chunkId,
    sceneType: scene,
    narrativeFunctions: ['对话'],
    dialogueRatio: ratio,
    representativeness: 0.8,
    leakageRisk: 0,
    skeleton: { facts: [], eventOrder: [], pov: '第三人称', emotionalArc: [], paragraphFunctions: [], dialogueIntents: [] }
  })
  const picked = sv.retrieveExemplars(
    [mkEx('e1', 'c1', '海港', 0.5), mkEx('e2', 'c2', '海港', 0.5), mkEx('e3', 'c3', '码头', 0.7), mkEx('e4', 'c4', '码头', 0.3), mkEx('e5', 'c5', '码头', 0.1)],
    { sceneType: '海港', narrativeFunctions: ['对话'], pov: '第三人称' },
    3
  )
  check('[21] 检索：k=3 返回 3 个', picked.length === 3, String(picked.length))
  check('[21] 检索：场景匹配优先（首位同场景）', picked[0]?.sceneType === '海港', JSON.stringify(picked.map((p) => p.sceneType)))
  check('[21] 检索：MMR 去冗余（同 dialogueRatio 只取 1）', new Set(picked.map((p) => p.dialogueRatio)).size === picked.length, JSON.stringify(picked.map((p) => p.dialogueRatio)))

  const dist10 = sv.computeDistribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const atMean = sv.metricScore(dist10.mean, dist10)
  check('[21] 评分：值=均值 → z≈0', Math.abs(atMean.z) <= 0.01, String(atMean.z))
  check('[21] 评分：值=均值 → score≈1', atMean.score > 0.99, String(atMean.score))
  const off2 = sv.metricScore(dist10.mean + 2 * dist10.std, dist10)
  check('[21] 评分：偏离 2σ → z≈2', Math.abs(off2.z - 2) <= 0.1, String(off2.z))
  check('[21] 评分：偏离 2σ → score < 0.2', off2.score < 0.2, String(off2.score))
  const noDist = sv.metricScore(3, { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, mean: 0, std: 0, n: 0 })
  check('[21] 评分：空分布 → z=0 score=1', noDist.z === 0 && noDist.score === 1, JSON.stringify(noDist))

  const authorText = '他来了。风裹着咸味穿过小镇，她站在栈桥尽头望着远方。天色暗了。我们走吧。'
  const authorProfile = sv.buildStylometryProfile([sv.textStats(authorText)])
  const opts = {
    profile: authorProfile,
    requiredFacts: [] as string[],
    forbiddenFacts: [] as string[],
    sources: [{ text: '轮船在夜间离港，汽笛长鸣，值班水手把缆绳一圈圈绕紧在铁桩上，甲板湿漉漉的，油灯在风里摇晃。', sourceName: '其它来源' }],
    forbiddenPhrases: [] as string[]
  }
  const evGood = sv.evaluateCandidate(authorText, opts)
  check('[21] 四路：作者风格文本 → stylometryScore > 0.5', evGood.stylometryScore > 0.5, String(evGood.stylometryScore))
  check('[21] 四路：硬门槛全通过（content/novelty/fluency）', evGood.hardGates.content && evGood.hardGates.novelty && evGood.hardGates.fluency, JSON.stringify(evGood.hardGates))
  check('[21] 四路：stylometry 13 项评分', evGood.stylometry.length === 13, String(evGood.stylometry.length))

  const evMiss = sv.evaluateCandidate('灯塔下没有她的影子，风很大。', { ...opts, requiredFacts: ['灯塔管理员出现'] })
  check('[21] 四路：缺 requiredFact → content 硬门槛 false', evMiss.hardGates.content === false, JSON.stringify(evMiss.hardGates))
  check('[21] 四路：缺 requiredFact → contentScore < 1', evMiss.contentScore < 1, String(evMiss.contentScore))

  const src30 = '夜色像墨水一样浓稠，她沿着空无一人的街道慢慢走，路灯把影子拉得很长，远处传来海浪的声音，一遍又一遍。'
  const evCopy = sv.evaluateCandidate(src30 + '她终于停下脚步。', { ...opts, sources: [{ text: src30, sourceName: '原书' }] })
  check('[21] 四路：30 字原文重叠 → novelty 硬门槛 hardFail', evCopy.hardGates.novelty === false && evCopy.noveltyScore < 1, `gate=${evCopy.hardGates.novelty} score=${evCopy.noveltyScore}`)
  check('[21] 四路：novelty 检出 ≥24 字重叠', evCopy.overlaps.some((o) => o.length >= 24), JSON.stringify(evCopy.overlaps.slice(0, 2)))
  check('[21] 四路：重叠回源 sourceName=原书', evCopy.overlaps.some((o) => o.sourceName === '原书'), '')
  if (evCopy.hardGates.novelty === true) {
    blockedNotes.push('src/shared/styleV2.ts scoreNovelty 缺陷（line 529）：扩展循环内 gram 未增长（gram + clean[i+k] 应为 clean.slice(i, i+k+1)），连续重叠检出上限 13 字，longest>=24 硬门槛不可达 → 30 字原文防复制 hardFail 失效，等主负责人修复')
  }
  const evLeak = sv.evaluateCandidate('夜色像墨水一样浓稠，她沿着空无一人的街道慢慢走。', { ...opts, sources: [], forbiddenPhrases: ['夜色像墨水一样浓稠'] })
  check('[21] 四路：防复制词表命中 → novelty hardFail（leakage 通道）', evLeak.hardGates.novelty === false && evLeak.noveltyScore < 1, `gate=${evLeak.hardGates.novelty} score=${evLeak.noveltyScore}`)

  const evRankGood: CandidateEvaluation = { candidateId: 'a', hardGates: { content: true, novelty: true, fluency: true }, stylometry: [], stylometryScore: 0.9, contentScore: 1, noveltyScore: 0.8, naturalnessScore: 0.9, overlaps: [], failedSpans: [] }
  const evRankBad: CandidateEvaluation = { candidateId: 'b', hardGates: { content: false, novelty: true, fluency: true }, stylometry: [], stylometryScore: 0.7, contentScore: 0.5, noveltyScore: 0.9, naturalnessScore: 0.8, overlaps: [], failedSpans: [] }
  const ranked = sv.rankCandidates([evRankBad, evRankGood])
  check('[21] 排序：硬门槛失败者 finalRank=-1', ranked.find((r) => r.candidateId === 'b')?.finalRank === -1, JSON.stringify(ranked.map((r) => [r.candidateId, r.finalRank])))
  check('[21] 排序：失败者排最后', ranked[0]?.candidateId === 'a' && ranked[1]?.candidateId === 'b', JSON.stringify(ranked.map((r) => r.candidateId)))
  check('[21] 排序：通过者 finalRank 为正', (ranked[0]?.finalRank ?? 0) > 0, String(ranked[0]?.finalRank))

  let evEmpty: CandidateEvaluation | null = null
  let emptyThrew = false
  try {
    evEmpty = sv.evaluateCandidate('', { ...opts, sources: [] })
  } catch {
    emptyThrew = true
  }
  check('[21] 边界：空文本 evaluateCandidate 不抛', !emptyThrew && evEmpty !== null, emptyThrew ? 'threw' : 'ok')
  check('[21] 边界：空文本 → fluency 硬门槛 false', evEmpty !== null && evEmpty.hardGates.fluency === false, JSON.stringify(evEmpty?.hardGates))
  check('[21] 边界：空文本 → naturalnessScore=0', evEmpty !== null && evEmpty.naturalnessScore === 0, String(evEmpty?.naturalnessScore))
  let evTiny: CandidateEvaluation | null = null
  let tinyThrew = false
  try {
    evTiny = sv.evaluateCandidate('你好。', { ...opts, sources: [] })
  } catch {
    tinyThrew = true
  }
  check('[21] 边界：超短文本不抛且 13 项评分齐全', !tinyThrew && evTiny !== null && evTiny.stylometry.length === 13 && typeof evTiny.stylometryScore === 'number', tinyThrew ? 'threw' : String(evTiny?.stylometry.length))
  check('[21] 边界：单句文本 → fluency 硬门槛 false', evTiny !== null && evTiny.hardGates.fluency === false, JSON.stringify(evTiny?.hardGates))
}

// ==================== [22] Gate A 回归（复审整改验收） ====================

async function testGateA(): Promise<void> {
  console.log('\n[22] Gate A 回归：命令矩阵 / 路径矩阵 / 重试幂等 / 请求体 / 契约')
  const permMod = await loadTsModule('src/main/permissions.ts')
  if (!permMod || typeof permMod.isSafeAutoCommand !== 'function') {
    console.log('  BLOCK  [22] permissions.isSafeAutoCommand 未落地')
    return
  }
  const { isSafeAutoCommand, isSafeRulePattern, createPermissionManager: cpm22 } = permMod as {
    isSafeAutoCommand: (c: string) => boolean
    isSafeRulePattern: (c: string) => boolean
    createPermissionManager: (dir: string, ask?: (t: string, target: string) => Promise<{ action: string; remember: boolean }>) => any
  }

  const CMD_MATRIX: [string, boolean][] = [
    ['node evil.js', false],
    ['node --version', false],
    ['python payload.py', false],
    ['npm install lodash', false],
    ['npm ls', false],
    ['pip install requests', false],
    ['pip list', false],
    ['git status', true],
    ['git diff --stat', true],
    ['git push origin main', false],
    ['ls -la', true],
    ['echo hello', true],
    ['pwd', true],
    ['type file.txt', true],
    ['findstr hello file.txt', true]
  ]
  for (const [cmd, expect] of CMD_MATRIX) {
    check(`[22] B-03 命令矩阵：'${cmd}' → ${expect ? '放行' : '拒绝'}`, isSafeAutoCommand(cmd) === expect, isSafeAutoCommand(cmd) ? '放行' : '拒绝')
  }
  check('[22] B-03 记忆规则：含元字符命令不可存为规则', isSafeRulePattern('git status & whoami') === false, '')
  check('[22] B-03 记忆规则：安全命令可存为规则', isSafeRulePattern('git status') === true, '')

  const askLog22: string[] = []
  const pm22 = cpm22(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-gate-')), async (t, target) => {
    askLog22.push(`${t}:${target}`)
    return { action: 'deny', remember: false }
  })
  await pm22.updateSettings({ mode: 'auto', rules: [] })
  const d1 = await pm22.decide('path', 'C:\\Users\\someone\\Documents\\secret.txt')
  check('[22] B-04 auto 模式：越界路径不再无条件放行（走询问）', d1.action !== 'allow' && askLog22.length > 0, `${d1.action} asked=${askLog22.length}`)
  const d2 = await pm22.decide('command', 'node evil.js')
  check('[22] B-03 auto 模式：解释器命令不被自动放行', d2.action !== 'allow', `${d2.action}`)
  const d3 = await pm22.decide('command', 'git status')
  check('[22] B-03 auto 模式：安全只读命令放行', d3.action === 'allow', `${d3.action} ${d3.reason}`)

  const pm22b = cpm22(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-gate2-')), async () => ({ action: 'allow', remember: true }))
  await pm22b.updateSettings({ mode: 'safe', rules: [] })
  await pm22b.decide('command', 'git status --porcelain')
  const s22 = pm22b.getSettings()
  check('[22] B-03 记忆规则：保存为字面量（literal=true）', s22.rules[0]?.literal === true, JSON.stringify(s22.rules[0]))
  check('[22] B-03 记忆规则：字面量前缀匹配', s22.rules[0]?.pattern === 'git status --porcelain', JSON.stringify(s22.rules[0]?.pattern))

  console.log('  -- S-07 请求体与 B-05 幂等重试（独立临时 SSE）--')
  const http22 = require('node:http') as typeof import('node:http')
  let attempt = 0
  let bodies: any[] = []
  const srv22 = http22.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      attempt++
      bodies.push(JSON.parse(body))
      if (attempt === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'boom' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '正常输出', role: 'assistant' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => srv22.listen(18891, '127.0.0.1', r))
  try {
    let text = ''
    const retries: number[] = []
    const ds22 = await loadTsModule('src/main/deepseek.ts')
    await ds22.streamChat(
      { apiKey: 'k', baseUrl: 'http://127.0.0.1:18891', model: 'm', messages: [{ role: 'user', content: 'hi' }], thinking: { enabled: true, effort: 'high' } },
      (ev: any) => {
        if (ev.type === 'text') text += ev.delta ?? ''
      },
      undefined,
      (a: number) => retries.push(a)
    )
    check('[22] B-05 幂等重试：500 后自动重试一次', attempt === 2, `attempts=${attempt}`)
    check('[22] B-05 重试回调触发', retries.length === 1 && retries[0] === 1, JSON.stringify(retries))
    check('[22] B-05 重试后文本完整', text === '正常输出', text)

    const b1 = bodies[0]
    const b2 = bodies[1]
    check('[22] S-07 thinking 顶层含 reasoning_effort', b1.reasoning_effort === 'high', JSON.stringify(b1.reasoning_effort))
    check('[22] S-07 thinking 对象内无 reasoning_effort', b1.thinking?.reasoning_effort === undefined, JSON.stringify(b1.thinking))
    check('[22] S-07 thinking enabled 时无 temperature/top_p', b1.temperature === undefined && b1.top_p === undefined, JSON.stringify({ t: b1.temperature, p: b1.top_p }))
    check('[22] S-07 重试请求与首次同构', b2.reasoning_effort === 'high' && b2.thinking?.type === 'enabled', '')
  } finally {
    await new Promise<void>((r) => srv22.close(() => r()))
  }

  console.log('  -- B-01 / B-06 / B-07 / G-01 契约（源码静态断言）--')
  const indexSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'index.ts'), 'utf-8')
  const storeSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', 'src', 'store.ts'), 'utf-8')
  const preloadSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf-8')
  const deepseekSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'deepseek.ts'), 'utf-8')
  const snapshotSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'executionSnapshot.ts'), 'utf-8')

  const directStreamCalls = (indexSrc.match(/streamChat\(\{ \.\.\.base, messages: ctx\.messages \}/g) ?? []).length
  check('[22] B-01 默认模式接入工具循环（残留仅限 plan 分支）', directStreamCalls <= 1, `残留 ${directStreamCalls} 处`)
  // R21 Codex P1-04：轮数上限（longMode ? 4..ceil(targetChars/6000) : 6）原在 index.ts 死代码 runChat 内，
  // runChat 删除后该公式唯一落点迁移至 executionSnapshot.ts（buildExecutionSnapshot，生产单一源）。
  check('[22] B-01 非长分支走 longGenerate', snapshotSrc.includes('Math.ceil(targetChars / 6000)') || /longMode \? .* : 6/.test(snapshotSrc), '')
  const approvePlanStart = storeSrc.indexOf('approvePlan: async')
  const approvePlanSource = storeSrc.slice(approvePlanStart, storeSrc.indexOf('rejectPlan:', approvePlanStart))
  check('[22] B-06 approvePlan 使用新 runId', approvePlanSource.includes('const execId = crypto.randomUUID()') && approvePlanSource.includes('id: execId'), '')
  check('[22] B-07 单实例锁', indexSrc.includes('requestSingleInstanceLock'), '')
  check('[22] B-02 corpusStatus 已暴露', preloadSrc.includes('styleV2CorpusStatus'), '')
  check('[22] B-02 buildProfile 传 sourceIds 数组', preloadSrc.includes('styleV2BuildProfile: (sourceIds'), '')
  check('[22] B-02 revise 单数契约', preloadSrc.includes('styleV2Revise({ jobId, revision })') || preloadSrc.includes('styleV2Revise: (input: { jobId: string; revision'), '')
  check('[22] S-07 顶层 reasoning_effort 构造', deepseekSrc.includes('body.reasoning_effort') || deepseekSrc.includes('reasoning_effort:'), '')
  check('[22] G-01 错误终态单一（无 error: 前缀双发）', !/finishReason: `error:\$\{/.test(indexSrc), '')
  const errDoneCount = (indexSrc.match(/finishReason: 'error'/g) ?? []).length
  check('[22] G-01 错误 done 只发一次', errDoneCount <= 1, `count=${errDoneCount}`)
  const atLimit = checkModelReadPolicy('稿件.zip', MODEL_READ_MAX_BYTES)
  const tooBig = checkModelReadPolicy('稿件.zip', MODEL_READ_MAX_BYTES + 1)
  const disguised = checkModelReadPolicy('稿件.md.exe', 42)
  check('[22] 附件类型与大小策略', atLimit.ok && !tooBig.ok && !disguised.ok && checkModelReadPolicy('README', 42).ok, '')
}

// ==================== 入口 ====================

async function waitForServer(port: number, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/ping`, { method: 'POST', body: '{}' })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error('mock server 未就绪')
}

async function main(): Promise<void> {
  const mock = spawn(process.execPath, [path.resolve(__dirname, '../scripts/mock-v4-api.js')], { stdio: ['ignore', 'ignore', 'inherit'] })
  try {
    await waitForServer(18789)
    await testStreamChat()
    await testLongGenerate()
    await testToolLoop()
    await testContext()
    await testEstimate()
    await testPermissionSystem()
    await testSessionStore()
    await testMemory()
    await testAgentTools()
    await testCheckpoint()
    await testErrorClassification()
    await testErrorPropagation()
    await testFileImport()
    await testGalgameScan()
    await testGalgameLint()
    await testNovel()
    await testSecurityRegression()
    await testActivityProtocol()
    await testJournalAndBus()
    await testStyleMode()
    await testGateA()
    await testStyleV2Core()
  } finally {
    mock.kill()
  }
  if (blockedNotes.length > 0) {
    console.log('\n===== 阻塞项（未验证）=====')
    for (const n of blockedNotes) console.log(`  - ${n}`)
  }
  console.log(`\n===== 结果：${passed} PASS / ${failed} FAIL / ${blocked} BLOCKED =====`)
  process.exit(failed > 0 || blocked > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('VERIFY CRASH:', e)
  process.exit(1)
})
