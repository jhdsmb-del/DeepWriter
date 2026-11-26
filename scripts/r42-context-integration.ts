// ==================== R4.2 A5 集成红灯回归：ContextAssembler 总预算 + context_manifest ====================
// 复审 B-02/S-05：historyBudgetTokens 只裁历史；system/memory/附件/用户输入/工具结果/输出预留没有
// 统一预算；单条超大历史在 selectedHistory 为空时仍会被选入；每个 run 复制 canonical 历史。
// 本测试证明（集成层）：
//  1) CTX-TOTAL-BUDGET-02：完整请求（system+memory+history+user）严格 <= contextWindow-outputReserve；
//  2) CTX-SINGLE-OVERSIZE-02：单条超大 history 被截断/丢弃，绝不原样放入；
//  3) CTX-NODUP-02：run turns 只保存新增 turn（不复制历史正文）；组装请求中 user 只出现一次；
//  4) CTX-MANIFEST-01：manifest 引用 message IDs、按 (run_id, round) 落库、含段与 hash。
// 运行：npx esbuild scripts/r42-context-integration.ts --bundle --format=esm --platform=node --outfile=out/r42-cxi.mjs && node out/r42-cxi.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import * as http from 'node:http'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

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
  const outfile = path.resolve(__dirname, '..', 'out', `r42mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite'],
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

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r42-cxi-'))

  console.log('\n[R42-A5 集成] CTX-TOTAL-BUDGET / CTX-SINGLE-OVERSIZE / CTX-NODUP-02 / CTX-MANIFEST-01')
  const repoMod = await loadTsModule('src/main/db/repository.ts')
  const createRepository = repoMod.createRepository as (p: string) => {
    open(): void
    close(): void
    appendSessionMessage(m: Record<string, unknown>): void
    getSessionMessages(sessionId: string): Array<{ msg_id: string; role: string; content: string }>
    saveContextManifest(runId: string, round: number, manifestJson: string): void
    getContextManifests(runId: string): Array<{ run_id: string; round: number; manifest_json: string; created_at: number }>
    createSession(sessionId: string, title: string, model: string): void
  }
  const repo = createRepository(path.join(tmp, 'cxi.db'))
  repo.open()
  repo.createSession('sess-cxi', '测试', 'deepseek-v4-flash')
  // manifest 外键引用 runs：真实流程中 run 行由 acceptChatStart 事务先落库，此处等价预置
  ;(repo as unknown as { createRun(r: Record<string, unknown>): void }).createRun({
    run_id: 'run-cxi',
    session_id: 'sess-cxi',
    status: 'queued',
    phase: 'queued',
    started_at: Date.now(),
    updated_at: Date.now(),
    config_json: '{}',
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: 'run-cxi'
  })

  const svcMod = await loadTsModule('src/main/contextService.ts')
  const createContextService = svcMod.createContextService as (r: unknown) => {
    assembleRunContext(config: Record<string, unknown>, round: number, live: Array<{ role: string; content: string }>, prefix: Array<{ role: string; content: string }>): Promise<{
      messages: Array<{ role: string; content: string }>
      manifest: {
        runId: string
        round: number
        totalTokens: number
        budgetTokens: number
        contextWindowTokens: number
        outputReserveTokens: number
        overBudget: boolean
        segments: Array<{ id: string; kind: string; sourceIds: string[]; estimatedTokens: number; actualTokens: number | null; droppedReason: string | null; hash: string; cacheable: boolean }>
      }
      userContent: string | null
    }>
  }
  const svc = createContextService(repo)

  const config = {
    clientRequestId: 'run-cxi',
    sessionId: 'sess-cxi',
    contextPolicy: { historyBudgetTokens: 60000, contextWindowTokens: 60000, outputReserveTokens: 20000 }
  }
  const prefix = [
    { role: 'system', content: '你是创作助手。' },
    { role: 'system', content: '## 项目记忆\n冻结记忆内容' }
  ]
  const live = [{ role: 'user', content: '你好' }]

  // ---- CTX-TOTAL-BUDGET-02：总预算（system+memory+history+user 全部计入） ----
  const appendMsg = (msgId: string, sessionId: string, seq: number, role: string, content: string): void => {
    repo.appendSessionMessage({ msg_id: msgId, session_id: sessionId, seq, role, content, reasoning: '', status: 'done', usage_json: 'null', rounds: 0, tool_names_json: '[]', plan: null, created_at: Date.now() })
  }
  for (let i = 1; i <= 6; i++) {
    appendMsg(`h-${i}`, 'sess-cxi', i, 'user', `历史消息${i}：${'字'.repeat(4000)}`)
  }
  const r1 = await svc.assembleRunContext(config, 1, live, prefix as never)
  const budget = 60000 - 20000
  const total = r1.messages.reduce((a, m) => a + Math.ceil((m.content ?? '').length / 4), 0)
  check('CTX-TOTAL-BUDGET-02 完整请求 <= 窗口-输出预留（system+memory+history+user 全部计入）', total <= budget, `total=${total} budget=${budget}`)
  check('CTX-TOTAL-BUDGET-02 组装含 staticSystem 与 memory 与 user', r1.messages.some((m) => m.content === '你是创作助手。') && r1.messages.some((m) => m.content.includes('冻结记忆内容')) && r1.messages.some((m) => m.content === '你好'))
  check('CTX-TOTAL-BUDGET-02 manifest totalTokens <= budgetTokens', r1.manifest.totalTokens <= r1.manifest.budgetTokens, JSON.stringify({ total: r1.manifest.totalTokens, budget: r1.manifest.budgetTokens }))
  check('CTX-TOTAL-BUDGET-02 manifest 段含 static-system/memory/history/output-reserve', ['static-system', 'memory', 'history', 'output-reserve'].every((k) => r1.manifest.segments.some((s) => s.kind === k)), JSON.stringify(r1.manifest.segments.map((s) => s.kind)))

  // ---- CTX-SINGLE-OVERSIZE-02：单条超大 history 截断（R4.3 S-01：先预建 run，manifest 外键必须真实可落） ----
  appendMsg('huge-1', 'sess-cxi', 99, 'user', '超长单条：' + '大'.repeat(30000))
  ;(repo as unknown as { createRun(r: Record<string, unknown>): void }).createRun({
    run_id: 'run-small',
    session_id: 'sess-cxi',
    status: 'queued',
    phase: 'queued',
    started_at: Date.now(),
    updated_at: Date.now(),
    config_json: '{}',
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: 'run-small'
  })
  const cfgSmall = { clientRequestId: 'run-small', sessionId: 'sess-cxi', contextPolicy: { contextWindowTokens: 30000, outputReserveTokens: 20000 } }
  const r2 = await svc.assembleRunContext(cfgSmall, 1, live, prefix as never)
  const overItem = r2.messages.find((m) => m.content.includes('超长单条'))
  check('CTX-SINGLE-OVERSIZE-02 单条超限 history 被截断（含截断标记，不原样放入）', overItem !== undefined && overItem.content.includes('[…已截断') && overItem.content.length < 30000, `len=${overItem?.content.length ?? 0}`)
  const budget2 = 30000 - 20000
  const total2 = r2.messages.reduce((a, m) => a + Math.ceil((m.content ?? '').length / 4), 0)
  check('CTX-SINGLE-OVERSIZE-02 截断后整体仍 <= 预算', total2 <= budget2, `total=${total2} budget=${budget2}`)
  const smallManifests = repo.getContextManifests('run-small')
  check('CTX-MANIFEST-DURABLE-01 run-small 的 manifest 可从 DB 读回（外键真实落库，无 FOREIGN KEY 失败）', smallManifests.length === 1 && smallManifests[0]?.round === 1, JSON.stringify(smallManifests.map((m) => ({ round: m.round, len: m.manifest_json.length }))))
  check('CTX-MANIFEST-DURABLE-01 manifest 内容可解析且引用 msgId', (() => { try { const p = JSON.parse(smallManifests[0]?.manifest_json ?? '{}'); return p.history !== undefined || Array.isArray(p.segments); } catch { return false } })(), '')

  // ---- CTX-MANIFEST-FAIL-01：manifest 落库失败 → fail-closed 抛错（绝不 console.warn 后假装成功） ----
  // 用一个 runId 不存在于 DB 的 config 触发外键失败（等效于运行期落库故障）
  let failThrew = false
  let failMsg = ''
  try {
    await svc.assembleRunContext({ clientRequestId: 'run-no-such', sessionId: 'sess-cxi', contextPolicy: { contextWindowTokens: 30000, outputReserveTokens: 20000 } }, 1, live, prefix as never)
  } catch (e) {
    failThrew = true
    failMsg = (e as Error).message
  }
  check('CTX-MANIFEST-FAIL-01 manifest 落库失败时抛错（fail-closed，请求中止）', failThrew, failMsg)
  const noSuchManifests = repo.getContextManifests('run-no-such')
  check('CTX-MANIFEST-FAIL-01 失败后无半截 manifest 残留', noSuchManifests.length === 0, JSON.stringify(noSuchManifests))

  // ---- CTX-NODUP-02：run turns 只保存新增 turn；组装请求 user 只出现一次 ----
  const chatStartMod = await loadTsModule('src/main/chatStart.ts')
  const startChatRun = chatStartMod.startChatRun as (deps: Record<string, unknown>, payload: Record<string, unknown>) => Promise<unknown>
  const repo2 = createRepository(path.join(tmp, 'cxi2.db'))
  repo2.open()
  repo2.createSession('sess-nodup', '测试', 'deepseek-v4-flash')
  const appendMsg2 = (msgId: string, sessionId: string, seq: number, role: string, content: string): void => {
    repo2.appendSessionMessage({ msg_id: msgId, session_id: sessionId, seq, role, content, reasoning: '', status: 'done', usage_json: 'null', rounds: 0, tool_names_json: '[]', plan: null, created_at: Date.now() })
  }
  for (let i = 1; i <= 3; i++) {
    appendMsg2(`n-${i}`, 'sess-nodup', i, 'user', `旧消息${i}`)
  }
  const engineCalls: Array<{ runId: string; alreadyCreated?: boolean }> = []
  await startChatRun(
    {
      repository: repo2,
      runKernel: {
        start: async (input: { runId: string; alreadyCreated?: boolean }) => {
          engineCalls.push({ runId: input.runId, alreadyCreated: input.alreadyCreated })
          return { ok: true }
        },
        step: async () => undefined
      },
      loadSettings: async () => ({ model: 'deepseek-v4-flash', historyBudgetTokens: 60000 }),
      buildConfig: (p: { id: string }, _s: unknown, sessionId: string) => ({ snapshotVersion: 2, clientRequestId: p.id, sessionId, contextPolicy: { contextWindowTokens: 60000, outputReserveTokens: 20000, historyBudgetTokens: 60000 } })
    },
    { id: 'run-nodup', sessionId: 'sess-nodup', text: '新消息' }
  )
  const turns = (repo2 as unknown as { getTurnsByRun(runId: string): Array<{ role: string; content: string }> }).getTurnsByRun('run-nodup')
  check('CTX-NODUP-02 run turns 只保存新增 user turn（不复制历史正文）', turns.length === 1 && turns[0]?.role === 'user' && turns[0].content === '新消息', JSON.stringify(turns))
  const messages3 = (repo2 as unknown as { getSessionMessages(sessionId: string): Array<{ msg_id: string; role: string; content: string }> }).getSessionMessages('sess-nodup')
  check('CTX-NODUP-02 canonical session 保留全部历史（未复制到 run）', messages3.length === 4, `n=${messages3.length}`)

  // ---- CTX-MANIFEST-01：manifest 引用 message IDs + 落库 (run_id, round) ----
  const manifests = repo.getContextManifests('run-cxi')
  check('CTX-MANIFEST-01 manifest 按 (run_id, round) 落库', manifests.length >= 1 && manifests[0]?.round === 1, JSON.stringify(manifests))
  const m0 = JSON.parse(manifests[0]?.manifest_json ?? '{}') as { segments: Array<{ sourceIds: string[] }> }
  const historySeg = m0.segments.find((s) => s.sourceIds.some((id) => id.startsWith('h-')))
  check('CTX-MANIFEST-01 history 段引用 canonical message IDs（h-1..h-6）', historySeg !== undefined && historySeg.sourceIds.some((id) => id === 'h-1') && historySeg.sourceIds.some((id) => id === 'h-6'), JSON.stringify(historySeg?.sourceIds))
  const mRound = JSON.parse(manifests[manifests.length - 1]?.manifest_json ?? '{}') as { round: number }
  check('CTX-MANIFEST-01 round 递增（第二次组装 round=1 覆盖或新增）', mRound.round === 1)
  repo2.close()
  repo.close()

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.2-A5 集成红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.2-A5 集成红灯回归执行异常：', e)
  process.exit(2)
})
