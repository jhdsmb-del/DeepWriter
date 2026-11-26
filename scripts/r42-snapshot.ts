import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.2 A3 红灯回归：Versioned RunExecutionSnapshot（SNAPSHOT-SETTINGS 完整化） ====================
// 复审 S-01/B-03：provider 部分字段来自 config，但 API key fallback、novelMode、galgame 参数、
// workDir/docDir 和 memory 内容仍在每轮从 currentSettings 或磁盘读取——长任务运行中修改设置，
// 后续轮次语义和工具边界改变；重启恢复旧 run 时使用新目录或新凭据。
// 本测试证明：
//  1) 快照冻结 provider origin/model/maxTokens/thinking/sampling、workDir/docDir、galgame、
//     mode profile version、prompt hash、tool policy/output contract/context policy、
//     memory snapshot+hash、deep-write policy、attachment 引用；
//  2) 运行中修改全局设置，第二轮请求的 model/maxTokens/temperature 与首轮一致（来自快照）；
//  3) credential 与快照 origin 绑定：origin 不匹配时 fail closed（key 绝不发给错误 origin）；
//  4) 恢复时 snapshot 版本不兼容 → 明确 recovery 状态，绝不读取当前全局设置替代。
// 运行：npx esbuild scripts/r42-snapshot.ts --bundle --format=esm --platform=node --outfile=out/r42-snapshot.mjs && node out/r42-snapshot.mjs

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
      external: desktopSourceExternals(abs, ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']),
      logLevel: 'silent',
      plugins: [
        {
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
      ]
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
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r42-snap-'))

  console.log('\n[R42-A3] SNAPSHOT：Versioned RunExecutionSnapshot（冻结 + origin 绑定 + 恢复门）')
  const snapMod = await loadTsModule('src/main/executionSnapshot.ts')
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const snapshotVersionOk = snapMod.snapshotVersionOk as (cfg: Record<string, unknown>) => boolean
  const applySnapshotGate = snapMod.applySnapshotGate as (
    repo: { getRun(runId: string): { status: string } | null; updateRun(runId: string, patch: Record<string, unknown>): void },
    runId: string,
    cfg: Record<string, unknown>
  ) => { ok: boolean; reason?: string }

  const baseSettings = {
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    maxTokens: 8192,
    temperature: 1,
    topP: 1,
    thinkingEnabled: true,
    reasoningEffort: 'high' as const,
    workDir: 'C:/work/snap',
    docDir: 'C:/docs/snap',
    novelMode: false,
    galgame: { enabled: true, projectDir: 'C:/gal/proj', sdkPath: 'C:/gal/renpy.exe' },
    historyBudgetTokens: 60000
  }

  // ---- SNAPSHOT-02-01：冻结字段完整性 ----
  const snap = buildExecutionSnapshot({
    payload: { id: 'req-1', mode: 'longwrite', workspace: 'chat', phase: 'execute', planText: '计划P', longMode: true, targetChars: 12000, story: { enabled: true, genre: 'Galgame 恋爱日常', intensity: 'standard', structure: 'three-act', outputFormat: 'novel', tone: '', characters: [], worldSetting: '' }, attachments: [{ fileRefId: 'ref1', name: 'a.txt', size: 100 }] },
    settings: baseSettings,
    sessionId: 'sess-snap',
    memory: { projectPath: 'C:/work/snap/memory.md', projectContent: '项目记忆内容', userContent: '用户记忆内容' },
    now: 1234567890
  })
  check('SNAPSHOT-02-01 snapshotVersion=4', snap.snapshotVersion === 4, String(snap.snapshotVersion))
  check('SNAPSHOT-02-01 provider 参数冻结（model/baseUrl/maxTokens/temperature/topP/thinking）', snap.model === 'deepseek-v4-flash' && snap.baseUrl === 'https://api.deepseek.com' && snap.maxTokens === 8192 && snap.temperature === 1 && snap.topP === 1 && snap.thinking?.enabled === true)
  check('SNAPSHOT-02-01 credentialRef 只存 origin 引用（无明文 key）', typeof snap.credentialRef?.origin === 'string' && snap.credentialRef.origin === 'https://api.deepseek.com' && !('apiKey' in (snap.credentialRef ?? {})), JSON.stringify(snap.credentialRef))
  check('SNAPSHOT-02-01 workDir/docDir/galgame 冻结', snap.workDir === 'C:/work/snap' && snap.docDir === 'C:/docs/snap' && snap.galgame?.projectDir === 'C:/gal/proj' && snap.galgame?.sdkPath === 'C:/gal/renpy.exe')
  check('SNAPSHOT-02-01 mode profile ID/version 冻结', snap.runMode === 'longwrite' && typeof snap.modeProfileVersion === 'number')
  check('SNAPSHOT-02-01 promptHash 为 64 位 hex（静态 system 稳定哈希）', typeof snap.promptHash === 'string' && snap.promptHash.length === 64)
  check('SNAPSHOT-02-01 memory snapshot+hash 冻结', snap.memory?.projectContent === '项目记忆内容' && typeof snap.memory?.hash === 'string' && snap.memory.hash.length === 64)
  check('SNAPSHOT-02-01 toolPolicy/outputContract/contextPolicy/deepWrite 冻结', Array.isArray(snap.toolPolicy?.allowList) && snap.outputContract?.format === 'prose' && typeof snap.contextPolicy?.historyBudgetTokens === 'number' && snap.deepWrite?.targetChars === 12000 && snap.deepWrite?.continueOnLength === true)
  check('SNAPSHOT-02-01 attachment 引用冻结（fileRefId 无正文）', Array.isArray(snap.attachments) && snap.attachments[0]?.fileRefId === 'ref1' && !('content' in (snap.attachments[0] ?? {})), JSON.stringify(snap.attachments))
  check('SNAPSHOT-02-01 contextWindow/outputReserve 冻结（总预算依据）', snap.contextPolicy?.contextWindowTokens === 1_048_576 && snap.contextPolicy?.outputReserveTokens === 8192)

  // ---- SNAPSHOT-02-02：运行中修改设置，第二轮请求参数与首轮一致（来自快照） ----
  const adapterMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createModelCallAdapter = adapterMod.createModelCallAdapter as (opts: Record<string, unknown>) => (input: Record<string, unknown>) => Promise<AsyncIterable<{ type: string }>>
  const requests: Array<{ body: { model: string; max_tokens: number; temperature: number } }> = []
  const mockSse = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { model: string; max_tokens: number; temperature: number }
        requests.push({ body: parsed })
      } catch {
        requests.push({ body: { model: 'BROKEN', max_tokens: -1, temperature: -1 } })
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok', role: 'assistant' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 5 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => mockSse.listen(0, '127.0.0.1', r))
  const mockPort = (mockSse.address() as { port: number }).port
  // 可变"当前设置"：模拟运行中修改全局设置
  let mutableSettings = { apiKey: 'k', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'deepseek-v4-flash', maxTokens: 8192, thinking: { enabled: true, effort: 'high' }, temperature: 1, topP: 1 }
  const snapCfg = {
    ...snap,
    baseUrl: `http://127.0.0.1:${mockPort}`, // 测试用本地 mock origin（快照冻结值）
    credentialRef: { origin: `http://127.0.0.1:${mockPort}`, model: 'deepseek-v4-flash', issuedAt: 0 },
    memory: { projectPath: 'C:/work/snap/memory.md', projectContent: '快照记忆A', userContent: '快照记忆B', hash: 'h' }
  }
  const buildPrefix = async (rc: Record<string, unknown>): Promise<Array<{ role: string; content: string }>> => {
    const out: Array<{ role: string; content: string }> = []
    const mem = rc.memory as { projectPath?: string; projectContent?: string; userContent?: string } | undefined
    if (mem?.projectContent?.trim()) out.push({ role: 'system', content: `## 项目记忆（${mem.projectPath}）\n${mem.projectContent}` })
    if (mem?.userContent?.trim()) out.push({ role: 'system', content: `## 用户记忆\n${mem.userContent}` })
    return out
  }
  const mca = createModelCallAdapter({
    getApi: () => mutableSettings,
    buildPrefix,
    getSignal: () => undefined,
    getConfig: () => snapCfg
  })
  const it1 = await mca({ runId: 'r-snap', phase: 'thinking', turnSeq: 1, round: 1, messages: [{ role: 'user', content: '你好' }] })
  for await (const _ev of it1) {
    /* drain */
  }
  // 模拟运行中修改设置
  mutableSettings = { apiKey: 'k2', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'deepseek-v4-pro', maxTokens: 999, thinking: { enabled: false, effort: 'low' }, temperature: 0.1, topP: 0.5 }
  const it2 = await mca({ runId: 'r-snap', phase: 'thinking', turnSeq: 1, round: 2, messages: [{ role: 'user', content: '你好' }] })
  for await (const _ev of it2) {
    /* drain */
  }
  await new Promise<void>((r) => mockSse.close(() => r()))
  check('SNAPSHOT-02-02 收到两轮请求', requests.length === 2, `n=${requests.length}`)
  check('SNAPSHOT-02-02 第二轮 model 仍为快照值（改设置不影响）', requests[1]?.body.model === 'deepseek-v4-flash', JSON.stringify(requests[1]?.body))
  check('SNAPSHOT-02-02 第二轮 max_tokens 仍为快照值', requests[1]?.body.max_tokens === 8192, JSON.stringify(requests[1]?.body))
  check('SNAPSHOT-02-02 第二轮未携带被修改设置的值（temperature≠0.1、无 pro 模型）', requests[1]?.body.temperature !== 0.1 && requests[1]?.body.model !== 'deepseek-v4-pro', JSON.stringify(requests[1]?.body))
  check('SNAPSHOT-02-02 两轮请求参数逐项一致', requests[0]?.body.model === requests[1]?.body.model && requests[0]?.body.max_tokens === requests[1]?.body.max_tokens && JSON.stringify(requests[0]?.body.messages) === JSON.stringify(requests[1]?.body.messages))

  // ---- SNAPSHOT-02-03：credential origin 绑定（fail closed） ----
  let received = 0
  const mockSse2 = http.createServer((_req, res) => {
    received++
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise<void>((r) => mockSse2.listen(0, '127.0.0.1', r))
  const mockPort2 = (mockSse2.address() as { port: number }).port
  const mcaBad = createModelCallAdapter({
    getApi: () => ({ apiKey: 'SECRET-KEY', baseUrl: `http://127.0.0.1:${mockPort2}`, model: 'm', maxTokens: 100, thinking: { enabled: false, effort: 'high' }, temperature: 1, topP: 1 }),
    buildPrefix: async () => [],
    getSignal: () => undefined,
    // 快照 origin 与当前凭据 origin 不一致
    getConfig: () => ({ ...snap, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', maxTokens: 8192, temperature: 1, topP: 1, thinking: { enabled: true, effort: 'high' } })
  })
  let originThrew = false
  let originMsg = ''
  try {
    const itBad = await mcaBad({ runId: 'r-bad', phase: 'thinking', turnSeq: 1, round: 1, messages: [{ role: 'user', content: 'x' }] })
    for await (const _ev of itBad) {
      /* drain */
    }
  } catch (e) {
    originThrew = true
    originMsg = (e as Error).message
  }
  check('SNAPSHOT-02-03 快照 origin ≠ 当前凭据 origin 时拒绝发送（fail closed）', originThrew, originMsg)
  check('SNAPSHOT-02-03 拒绝时未向错误 origin 发出任何请求', received === 0, `received=${received}`)
  check('SNAPSHOT-02-03 错误信息不含明文 key', !originMsg.includes('SECRET-KEY'), originMsg)
  await new Promise<void>((r) => mockSse2.close(() => r()))

  // ---- SNAPSHOT-02-04：恢复版本门（不兼容 → 明确 recovery，不读当前设置替代） ----
  check('SNAPSHOT-02-04 snapshotVersionOk(4) 通过', snapshotVersionOk({ snapshotVersion: 4 }) === true)
  check('SNAPSHOT-02-04b 旧 snapshotVersion=3 拒绝', snapshotVersionOk({ snapshotVersion: 3 }) === false)
  check('SNAPSHOT-02-04 snapshotVersionOk(2) 拒绝（旧快照不兼容）', snapshotVersionOk({ snapshotVersion: 2 }) === false)
  check('SNAPSHOT-02-04 无 snapshotVersion（旧 v1 config）拒绝', snapshotVersionOk({ schemaVersion: 1, model: 'x' }) === false)
  const repoMod = await loadTsModule('src/main/db/repository.ts')
  const createRepository = repoMod.createRepository as (p: string) => {
    open(): void
    close(): void
    createRun(r: Record<string, unknown>): void
    getRun(runId: string): { status: string } | null
    updateRun(runId: string, patch: Record<string, unknown>): void
  }
  const repo = createRepository(path.join(tmp, 'snap.db'))
  repo.open()
  const now = Date.now()
  repo.createRun({ run_id: 'run-old', session_id: 's1', status: 'queued', phase: 'queued', started_at: now, updated_at: now, config_json: JSON.stringify({ schemaVersion: 1, model: 'x' }), parent_run_id: null, error_code: null, error_message: null, client_request_id: null })
  const g1 = applySnapshotGate(repo, 'run-old', { schemaVersion: 1, model: 'x' })
  check('SNAPSHOT-02-04 版本不兼容 → 拒绝恢复', g1.ok === false && g1.reason === 'snapshot_version_incompatible', JSON.stringify(g1))
  const g1Run = repo.getRun('run-old')
  check('SNAPSHOT-02-04 不兼容 run 进入 recovery_required（明确恢复状态）', g1Run?.status === 'recovery_required', JSON.stringify(g1Run))
  repo.createRun({ run_id: 'run-new', session_id: 's2', status: 'queued', phase: 'queued', started_at: now, updated_at: now, config_json: JSON.stringify({ snapshotVersion: 4, model: 'x' }), parent_run_id: null, error_code: null, error_message: null, client_request_id: null })
  const g2 = applySnapshotGate(repo, 'run-new', { snapshotVersion: 4, model: 'x' })
  check('SNAPSHOT-02-04 版本兼容 → 允许恢复', g2.ok === true, JSON.stringify(g2))
  repo.close()

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.2-A3 红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.2-A3 红灯回归执行异常：', e)
  process.exit(2)
})
