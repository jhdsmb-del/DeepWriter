import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.1 阻断项红灯回归（复审可复现故障） ====================
// 覆盖：B-01 设置补丁旁路 / B-02 权限持久化 off / B-03 流式文本重复 / B-04 会话重启丢失（repository 层）
// 运行：npx esbuild scripts/r41-regressions.ts --bundle --format=esm --platform=node --outfile=out/r41.mjs && node out/r41.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import * as http from 'node:http'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const ELECTRON_SHIM = {
  name: 'electron-shim',
  setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
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
      ].join('\n'),
      loader: 'js'
    }))
  }
}

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `r41mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: desktopSourceExternals(abs, ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']),
      logLevel: 'silent',
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

const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r41-'))

  console.log('\n[R41-B03] 流式文本精确重建（STREAM-TEXT-01：三 chunk 甲/乙/丙 → 必须严格等于"甲乙丙"）')
  const adapter = await loadTsModule('src/main/runKernelAdapter.ts')
  const createChunkTranslator = adapter.createChunkTranslator as () => (
    ev: { type: string; turn?: { role: string; content: string; reasoningContent?: string; toolCallsJson?: string }; toolCall?: unknown; phase?: string; usage?: unknown; run?: { status: string; errorMessage?: string } },
    runId: string,
    planMode?: boolean
  ) => Array<{ type: string; delta?: string; finishReason?: string }>
  const translate = createChunkTranslator()
  // 引擎 checkpoint 事件携带"当前 turn 的完整累计 content"（复审探针复现）
  const events = [
    { type: 'turn', turn: { role: 'assistant', content: '甲' } },
    { type: 'turn', turn: { role: 'assistant', content: '甲乙' } },
    { type: 'turn', turn: { role: 'assistant', content: '甲乙丙' } }
  ]
  const rendered: string[] = []
  for (const ev of events) {
    for (const chunk of translate(ev as never, 'run-x')) {
      if (chunk.type === 'text' && chunk.delta) rendered.push(chunk.delta)
    }
  }
  check('STREAM-TEXT-01 三 chunk 精确重建（不得重复）', rendered.join('') === '甲乙丙', `实际="${rendered.join('')}"（期望="甲乙丙"）`)
  // EVENT-TERMINAL-01：terminal exactly once
  const t = createChunkTranslator()
  const term = { type: 'terminal', run: { status: 'completed' } }
  const once1 = t(term as never, 'run-y').length
  const once2 = t(term as never, 'run-y').length
  check('EVENT-TERMINAL-01 terminal exactly once', once1 === 1 && once2 === 0, `first=${once1} second=${once2}`)
  // STREAM-TEXT-02：重复投递相同 seq 不重复（增量协议天然满足——同内容第二次无增量）
  const t2 = createChunkTranslator()
  const d1 = t2(events[1] as never, 'run-z')
  const d2 = t2(events[1] as never, 'run-z')
  check('STREAM-TEXT-02 重复投递相同内容无重复增量', d1.length === 1 && d2.length === 0, `${d1.length}/${d2.length}`)

  console.log('\n[R41-B01] 设置补丁旁路（SEC-PATCH-01/02/03）')
  const schemas = await loadTsModule('src/shared/ipcSchemas.ts')
  const settingsSetSchema = schemas.settingsSetSchema as { safeParse(v: unknown): { success: boolean; error?: unknown } }
  // 当前 schema：patch 允许任意 key+unknown value——patch key='baseUrl' value='https://evil.example.com' 应被拒（红灯）
  const evilPatch = settingsSetSchema.safeParse({ kind: 'patch', key: 'baseUrl', value: 'https://evil.example.com/v1' })
  check('SEC-PATCH-01 补丁写恶意 endpoint 被拒（红灯：当前 patch 任意值通过）', evilPatch.success === false, evilPatch.success ? '补丁通过（绕过 allowlist）' : '')
  const offPatch = settingsSetSchema.safeParse({ kind: 'patch', key: 'permissionMode', value: 'off' })
  check('SEC-PATCH-02 补丁写 permissionMode=off 被拒（红灯：当前 patch 任意值通过）', offPatch.success === false, offPatch.success ? '补丁通过' : '')
  const unknownPatch = settingsSetSchema.safeParse({ kind: 'patch', key: 'totallyUnknownField', value: 123 })
  check('SEC-PATCH-03 未知 key 被拒（红灯：当前 patch 任意 key 通过）', unknownPatch.success === false, unknownPatch.success ? '未知 key 通过' : '')

  console.log('\n[R41-B02] 权限 off 持久化（SEC-PERM-RESTART-01）')
  const permissionsMod = await loadTsModule('src/main/permissions.ts')
  const createPermissionManager = permissionsMod.createPermissionManager as (
    dir: string,
    ask?: unknown
  ) => {
    updateSettings(s: { mode: string; rules: unknown[] }): Promise<void>
    getSettings(): { mode: string; rules: unknown[] }
  }
  const pmDir = path.join(tmp, 'perm')
  const pm = createPermissionManager(pmDir)
  // R4.1：普通持久化路径拒绝 off（抛错），不再静默接受并落盘
  let offRejected = false
  try {
    await pm.updateSettings({ mode: 'off', rules: [] })
  } catch {
    offRejected = true
  }
  check('SEC-PERM-RESTART-01 普通 updateSettings 拒绝 off（不写入持久配置）', offRejected, '')
  await pm.updateSettings({ mode: 'auto', rules: [] })
  const reloaded = createPermissionManager(pmDir).getSettings()
  check('SEC-PERM-RESTART-01 重启后权限为持久安全值（auto）', reloaded.mode === 'auto', `重载 mode=${reloaded.mode}`)

  console.log('\n[R41-CTX] 每轮稳定前缀（CTX-PREFIX-01）与模式差异（MODE-BEHAVIOR-01）')
  // CTX-PREFIX-01：modelCall 每轮都调用 buildPrefix（system 策略不因轮次丢失）
  const createModelCallAdapter2 = adapter.createModelCallAdapter as (opts: unknown) => (input: { runId: string; phase: string; turnSeq: number; round: number; messages: Array<{ role: string; content: string }> }) => Promise<unknown>
  const buildPrefixCalls: number[] = []
  const mca = createModelCallAdapter2({
    getApi: () => ({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', model: 'm', maxTokens: 100, thinking: { enabled: false, effort: 'high' }, temperature: 1, topP: 1 }),
    buildPrefix: async (_rc: unknown, round: number) => {
      buildPrefixCalls.push(round)
      return []
    },
    getSignal: () => undefined,
    getConfig: () => ({})
  })
  await mca({ runId: 'r', phase: 'thinking', turnSeq: 2, round: 1, messages: [] })
  await mca({ runId: 'r', phase: 'thinking', turnSeq: 3, round: 2, messages: [] })
  check('CTX-PREFIX-01 第二轮仍调用 buildPrefix（稳定 system 前缀每轮注入）', buildPrefixCalls.length === 2 && buildPrefixCalls[1] === 2, JSON.stringify(buildPrefixCalls))

  // MODE-BEHAVIOR-01：四种模式 profile 有可观察差异（system prompt 不同）
  const modeProfiles = await loadTsModule('src/main/modeProfiles.ts')
  const getModeProfile = modeProfiles.getModeProfile as (m: string) => { id: string; systemPrompt: string }
  const agentP = getModeProfile('agent').systemPrompt
  const longP = getModeProfile('longwrite').systemPrompt
  const styleP = getModeProfile('style').systemPrompt
  const galP = getModeProfile('galgame').systemPrompt
  check('MODE-BEHAVIOR-01 四种实际 UI 模式 system prompt 各不相同（agent/longwrite/style/galgame）', new Set([agentP, longP, styleP, galP]).size === 4, '')
  check('MODE-BEHAVIOR-01 未知模式回退 agent', getModeProfile('bogus').systemPrompt === agentP, '')

  console.log('\n[R41-S05] FileRef 模型读取统一 policy（FILEREF-MODEL-SIZE/TYPE）')
  const refMod = await loadTsModule('src/main/fileRef.ts')
  const checkModelReadPolicy = refMod.checkModelReadPolicy as (realpath: string, size: number) => { ok: boolean; error?: string }
  check('FILEREF-MODEL-TYPE-01 不支持类型被拒（.exe 进不了模型）', checkModelReadPolicy('C:/x/evil.exe', 100).ok === false, '')
  check('FILEREF-MODEL-SIZE-01 超大文件被拒（>50MB 进不了模型）', checkModelReadPolicy('C:/x/big.txt', 51 * 1024 * 1024).ok === false, '')
  check('FILEREF-MODEL 合法 txt 通过', checkModelReadPolicy('C:/x/note.txt', 1024).ok === true, '')

  console.log('\n[R41-METRICS] TOKEN-METRICS-01：usage 事件含 segment 拆分与缓存前缀哈希')
  const mockSse = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok', role: 'assistant' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => mockSse.listen(0, '127.0.0.1', r))
  const mockAddr = mockSse.address() as { port: number } | null
  const mockPort = mockAddr?.port ?? 0
  console.log('[r41:debug] mockPort=', mockPort)
  const mca2 = createModelCallAdapter2({
    getApi: () => ({ apiKey: 'k', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'm', maxTokens: 100, thinking: { enabled: false, effort: 'high' }, temperature: 1, topP: 1 }),
    buildPrefix: async (_rc: unknown) => [{ role: 'system', content: '静态系统策略' }, { role: 'user', content: '附件内容' }],
    getSignal: () => undefined,
    getConfig: () => ({})
  })
  const it = await mca2({ runId: 'r-m', phase: 'thinking', turnSeq: 1, round: 1, messages: [{ role: 'user', content: '历史消息' }] })
  let usageEv: { usage?: { segmentBreakdown?: Array<{ label: string; tokens: number; cacheable: boolean }>; cacheablePrefixHash?: string } } = {}
  for await (const ev of it as AsyncIterable<{ type: string; usage?: unknown }>) {
    if (ev.type === 'usage') usageEv = ev as never
  }
  await new Promise<void>((r) => mockSse.close(() => r()))
  const sb = usageEv.usage?.segmentBreakdown ?? []
  check('TOKEN-METRICS-01 usage 含 segment 拆分（system/attachments/history 三段）', sb.length === 3 && sb[0]?.label === 'static-system' && sb[2]?.label === 'history-and-user', JSON.stringify(sb))
  check('TOKEN-METRICS-01 静态段标记 cacheable', sb[0]?.cacheable === true && sb[1]?.cacheable === false, JSON.stringify(sb))
  check('TOKEN-METRICS-01 提供 cacheablePrefixHash（前缀稳定可验证）', typeof usageEv.usage?.cacheablePrefixHash === 'string' && usageEv.usage.cacheablePrefixHash.length === 64, usageEv.usage?.cacheablePrefixHash ?? '')

  console.log('\n[R41-B04] 会话持久化投影（PERSIST-RESTART-01 的 repository 层）')
  const migrationsMod = await loadTsModule('src/main/db/migrations.ts')
  const openDb = migrationsMod.openDb as (p: string) => import('node:sqlite').DatabaseSync
  const db = openDb(path.join(tmp, 'sess.db'))
  const sessionTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','session_messages')").all() as Array<{ name: string }>
  check('PERSIST-RESTART-01 存在 canonical session 表（红灯：当前无 sessions/session_messages，UI 仍读 JSONL）', sessionTable.length === 2, JSON.stringify(sessionTable))
  db.close()

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.1 红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.1 红灯回归执行异常：', e)
  process.exit(2)
})
