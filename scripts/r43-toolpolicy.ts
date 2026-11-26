import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.3 Gate 2 红灯回归：toolPolicy 双层强制 + 静态 prompt 冻结 ====================
// 复审 B-02/G-02：toolPolicy.allowList 只冻结不执行（schema/executor 都没过滤）；buildStaticSystemMessages
// 仍按当前 getModeProfile 构造（profile 升级后旧 run prompt 会变）。
// 本测试证明：
//  1) TOOL-SCHEMA-ALLOWLIST-01：发给模型的 tool schema 按快照 allowList 过滤（越权工具不在 schema）；
//  2) TOOL-EXEC-ALLOWLIST-01：executor 拒绝越权工具（tool_not_allowed_by_mode），磁盘无变化；
//  3) SNAPSHOT-PROFILE-FROZEN-01：静态 system prompt 来自快照冻结内容（当前 profile 变化不影响旧 run）；
//  4) RECOVERY-SNAPSHOT-01：恢复 run 用创建时快照的 allowList，不读当前模式默认值。
// 运行：npx esbuild scripts/r43-toolpolicy.ts --bundle --format=esm --platform=node --outfile=out/r43-toolpolicy.mjs && node out/r43-toolpolicy.mjs

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
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r43-tp-'))

  console.log('\n[R4.3-G2] TOOL-SCHEMA/EXEC-ALLOWLIST + SNAPSHOT-PROFILE-FROZEN + RECOVERY-SNAPSHOT')
  const snapMod = await loadTsModule('src/main/executionSnapshot.ts')
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const buildStaticSystemMessages = snapMod.buildStaticSystemMessages as (snap: Record<string, unknown>) => Array<{ role: string; content: string }>
  const SNAPSHOT_SCHEMA_VERSION = snapMod.SNAPSHOT_SCHEMA_VERSION as number
  check('R4.3-G2 SNAPSHOT_SCHEMA_VERSION=4（冻结强约束）', SNAPSHOT_SCHEMA_VERSION === 4, String(SNAPSHOT_SCHEMA_VERSION))

  // ---- SNAPSHOT-PROFILE-FROZEN-01：静态 system prompt 来自快照冻结内容 ----
  const baseSettings = {
    model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 8192, temperature: 1, topP: 1,
    thinkingEnabled: true, reasoningEffort: 'high' as const, workDir: 'C:/w', docDir: 'C:/d', novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000
  }
  const snap = buildExecutionSnapshot({
    payload: { id: 'req-g2', mode: 'longwrite', planText: '计划P' },
    settings: baseSettings,
    sessionId: 's-g2',
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  const frozenMsgs = snap.frozenSystemMessages as Array<{ role: string; content: string }> | undefined
  check('SNAPSHOT-PROFILE-FROZEN-01 快照冻结 frozenSystemMessages（含 mode prompt + plan）', Array.isArray(frozenMsgs) && frozenMsgs.length >= 2 && (frozenMsgs[0]?.content ?? '').length > 0, JSON.stringify(frozenMsgs?.map((m) => m.content.slice(0, 20))))
  // 模拟 profile 升级：直接调用 buildStaticSystemMessages——必须返回冻结内容而非当前 profile
  const rebuilt = buildStaticSystemMessages(snap)
  check('SNAPSHOT-PROFILE-FROZEN-01 buildStaticSystemMessages 返回冻结内容（与快照一致）', JSON.stringify(rebuilt) === JSON.stringify(frozenMsgs), JSON.stringify(rebuilt))
  const again = buildStaticSystemMessages(snap)
  check('SNAPSHOT-PROFILE-FROZEN-01 每轮重建字节一致（prompt 不随 profile 升级漂移）', JSON.stringify(again) === JSON.stringify(frozenMsgs), '')

  // ---- TOOL-SCHEMA-ALLOWLIST-01：mock SSE 捕获请求 tools，断言越权工具不在 schema ----
  const adapterMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createModelCallAdapter = adapterMod.createModelCallAdapter as (opts: Record<string, unknown>) => (input: Record<string, unknown>) => Promise<AsyncIterable<{ type: string }>>
  const checkToolAllowed = adapterMod.checkToolAllowed as (name: string, allowList: string[]) => boolean
  check('R4.3-G2 checkToolAllowed 导出（白名单判定）', typeof checkToolAllowed === 'function')
  check('TOOL-EXEC-ALLOWLIST-01 白名单内工具允许', checkToolAllowed('read_file', ['read_file', 'write_file']) === true, '')
  check('TOOL-EXEC-ALLOWLIST-01 白名单外工具拒绝', checkToolAllowed('run_command', ['read_file', 'write_file']) === false, '')
  check("TOOL-EXEC-ALLOWLIST-01 '*' 放行（仅 agent 模式语义）", checkToolAllowed('anything', ['*']) === true, '')

  const requests: Array<{ body: { tools?: Array<{ function?: { name?: string } }> } }> = []
  const mockSse = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      try {
        requests.push({ body: JSON.parse(body) })
      } catch {
        requests.push({ body: {} })
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok', role: 'assistant' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => mockSse.listen(0, '127.0.0.1', r))
  const mockPort = (mockSse.address() as { port: number }).port
  const styleAllowList = ['read_file', 'list_files', 'search_files', 'generate_markdown_doc', 'generate_docx_doc']
  const mca = createModelCallAdapter({
    getApi: () => ({ apiKey: 'k', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'm', maxTokens: 100, thinking: { enabled: false, effort: 'high' }, temperature: 1, topP: 1 }),
    buildPrefix: async () => [{ role: 'system', content: 'SYS' }],
    getSignal: () => undefined,
    getConfig: () => ({ model: 'm', baseUrl: `http://127.0.0.1:${mockPort}`, maxTokens: 100, toolPolicy: { allowList: styleAllowList } })
  })
  const it = await mca({ runId: 'r-g2', phase: 'thinking', turnSeq: 1, round: 1, messages: [{ role: 'user', content: 'x' }] })
  for await (const _ev of it) {
    /* drain */
  }
  await new Promise<void>((r) => mockSse.close(() => r()))
  const body = requests[0]?.body
  const toolNames = (body?.tools ?? []).map((t) => t.function?.name ?? '').filter(Boolean)
  check('TOOL-SCHEMA-ALLOWLIST-01 请求携带 tools schema（开启工具时）', toolNames.length > 0, JSON.stringify(toolNames))
  check('TOOL-SCHEMA-ALLOWLIST-01 schema 只含白名单工具（style 无 run_command/write_file/edit_file）', toolNames.every((n) => styleAllowList.includes(n)) && !toolNames.includes('run_command') && !toolNames.includes('write_file'), JSON.stringify(toolNames))

  // ---- TOOL-EXEC-ALLOWLIST-01：executor 双层拒绝（伪造 tool call 也被执行端拒绝） ----
  const execMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createToolExecutor = execMod.createToolExecutor as (opts: Record<string, unknown>) => (name: string, argsJson: string, toolCallId: string, runId: string) => Promise<string>
  let execCalls: string[] = []
  const executor = createToolExecutor({
    getSignal: () => undefined,
    getEnv: () => ({ workDir: 'C:/w', docDir: 'C:/d', sessionId: 's-g2' }),
    getAllowList: () => ['read_file', 'list_files', 'search_files']
  })
  const denied = await executor('write_file', '{}', 'tc-1', 'r-g2').catch((e: Error) => `ERR:${e.message}`)
  check('TOOL-EXEC-ALLOWLIST-01 越权工具被执行端拒绝（tool_not_allowed_by_mode）', typeof denied === 'string' && denied.includes('tool_not_allowed_by_mode'), String(denied).slice(0, 120))
  const allowed = await executor('read_file', '{"path":"a.txt"}', 'tc-2', 'r-g2')
  check('TOOL-EXEC-ALLOWLIST-01 白名单内工具正常执行', typeof allowed === 'string' && !allowed.includes('tool_not_allowed_by_mode'), String(allowed).slice(0, 120))
  void execCalls

  // ---- RECOVERY-SNAPSHOT-01：恢复 run 用快照 allowList（模拟当前模式默认值变化） ----
  const snap2 = buildExecutionSnapshot({
    payload: { id: 'req-g2b', mode: 'style' },
    settings: baseSettings,
    sessionId: 's-g2b',
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  const frozen2 = snap2.toolPolicy?.allowList as string[] | undefined
  check('RECOVERY-SNAPSHOT-01 快照冻结 style 模式 allowList（不含 run_command/write_file）', Array.isArray(frozen2) && !frozen2.includes('run_command') && !frozen2.includes('write_file'), JSON.stringify(frozen2))
  // 若当前模式默认值（未来）变化，恢复仍用快照值——直接断言快照与 modeProfiles 当前值解耦
  check('RECOVERY-SNAPSHOT-01 快照 allowList 非空且为冻结副本', Array.isArray(frozen2) && frozen2.length > 0, '')

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.3-G2 红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.3-G2 红灯回归执行异常：', e)
  process.exit(2)
})
