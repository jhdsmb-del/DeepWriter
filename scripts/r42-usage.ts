import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.2 A6 红灯回归：独立 usage 协议（USAGE-CHUNK-*） ====================
// 复审 S-06：usage 伪装成 done/usage_snapshot——污染"唯一 terminal"语义，UI/统计依赖 finishReason 特例。
// 本测试证明：
//  1) shared ChunkEvent 有 typed usage（独立 chunk 类型，不占用 terminal）；
//  2) reducer 中 metrics 与 lifecycle 分开：usage 只累计不改变终态；terminal exactly once；
//  3) 多次 usage 更新带 revision 递增；terminal 后迟到 usage 被丢弃（不改变终态、不重复累计）；
//  4) provider 不返回 usage 时无 usage chunk（UI 显示 unknown，不伪造 0）。
// 运行：npx esbuild scripts/r42-usage.ts --bundle --format=esm --platform=node --outfile=out/r42-usage.mjs && node out/r42-usage.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'

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
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r42-usage-'))

  console.log('\n[R42-A6] USAGE-CHUNK：独立 usage 协议（metrics 与 lifecycle 分离）')
  const typesMod = await loadTsModule('src/shared/types.ts')
  // ChunkEventType/UsageChunk 是纯类型（无运行时导出）——通过 translator 行为与编译期类型证明；
  // 运行时验证 types 模块可加载且 estimateTokens 存在（协议文件无运行时损坏）
  check('USAGE-CHUNK-01 shared types 模块可加载（协议无损坏）', typeof typesMod.estimateTokens === 'function', typeof typesMod.estimateTokens)

  const adapterMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createChunkTranslator = adapterMod.createChunkTranslator as () => (ev: Record<string, unknown>, runId: string, planMode?: boolean) => Array<Record<string, unknown>>

  // ---- USAGE-CHUNK-01：usage 是独立 chunk，不再伪装 done/usage_snapshot ----
  const tr1 = createChunkTranslator()
  const chunks1 = tr1({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 3, revision: 1, kind: 'actual', segmentBreakdown: [{ label: 'static-system', tokens: 8, cacheable: true }], cacheablePrefixHash: 'ab'.repeat(32) } }, 'r1')
  check('USAGE-CHUNK-01 usage 事件 → 独立 usage chunk（不是 done）', chunks1.length === 1 && chunks1[0]?.type === 'usage', JSON.stringify(chunks1))
  check('USAGE-CHUNK-01 usage chunk 携带 typed 字段（revision/kind/tokens/segment/cacheablePrefixHash）', chunks1[0]?.usageChunk && typeof chunks1[0].usageChunk.revision === 'number' && chunks1[0].usageChunk.kind === 'actual' && chunks1[0].usageChunk.inputTokens === 10 && chunks1[0].usageChunk.outputTokens === 5 && chunks1[0].usageChunk.cacheHitTokens === 3 && Array.isArray(chunks1[0].usageChunk.segmentBreakdown) && chunks1[0].usageChunk.cacheablePrefixHash === 'ab'.repeat(32), JSON.stringify(chunks1[0]?.usageChunk))
  check('USAGE-CHUNK-01 无任何 done chunk（terminal 语义不被污染）', !chunks1.some((c) => c.type === 'done'), JSON.stringify(chunks1))

  // ---- USAGE-CHUNK-02：多次 usage 更新带 revision 递增 ----
  const tr2 = createChunkTranslator()
  const c2a = tr2({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, revision: 1, kind: 'partial' } }, 'r2')
  const c2b = tr2({ type: 'usage', usage: { inputTokens: 30, outputTokens: 12, revision: 2, kind: 'partial' } }, 'r2')
  const c2c = tr2({ type: 'usage', usage: { inputTokens: 30, outputTokens: 15, revision: 3, kind: 'actual' } }, 'r2')
  check('USAGE-CHUNK-02 三次 usage 更新各自发出独立 chunk', c2a[0]?.type === 'usage' && c2b[0]?.type === 'usage' && c2c[0]?.type === 'usage')
  check('USAGE-CHUNK-02 revision 递增（1→2→3）', c2a[0]?.usageChunk?.revision === 1 && c2b[0]?.usageChunk?.revision === 2 && c2c[0]?.usageChunk?.revision === 3, JSON.stringify([c2a[0]?.usageChunk?.revision, c2b[0]?.usageChunk?.revision, c2c[0]?.usageChunk?.revision]))
  check('USAGE-CHUNK-02 partial→actual 的 kind 覆盖规则透传', c2a[0]?.usageChunk?.kind === 'partial' && c2c[0]?.usageChunk?.kind === 'actual', JSON.stringify([c2a[0]?.usageChunk?.kind, c2c[0]?.usageChunk?.kind]))

  // ---- USAGE-CHUNK-03：terminal exactly once + terminal 前 usage 不改变终态 + 迟到 usage 丢弃 ----
  const tr3 = createChunkTranslator()
  const c3a = tr3({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, revision: 1, kind: 'actual' } }, 'r3')
  const c3b = tr3({ type: 'terminal', run: { status: 'completed', errorMessage: undefined } }, 'r3')
  check('USAGE-CHUNK-03 terminal 前 usage 不改变终态（独立事件）', c3a[0]?.type === 'usage' && !c3a.some((c) => c.type === 'done'), JSON.stringify(c3a))
  check('USAGE-CHUNK-03 terminal 是唯一 done 事件', c3b.filter((c) => c.type === 'done').length === 1, JSON.stringify(c3b))
  const c3b2 = tr3({ type: 'terminal', run: { status: 'completed' } }, 'r3')
  check('USAGE-CHUNK-03 terminal exactly once（第二次 terminal 无输出）', c3b2.length === 0, JSON.stringify(c3b2))
  const c3c = tr3({ type: 'usage', usage: { inputTokens: 99, outputTokens: 99, revision: 4, kind: 'actual' } }, 'r3')
  check('USAGE-CHUNK-03 terminal 后迟到 usage 被丢弃（不重复累计）', c3c.length === 0, JSON.stringify(c3c))

  // ---- USAGE-CHUNK-04：provider 不返回 usage → 无 usage chunk（UI 显示 unknown，不伪造 0）----
  const tr4 = createChunkTranslator()
  const c4 = tr4({ type: 'terminal', run: { status: 'completed' } }, 'r4')
  check('USAGE-CHUNK-04 无 usage 数据时 terminal 不伪造 usage（usage 为 null/缺省）', c4[0]?.type === 'done' && (c4[0]?.usage === null || c4[0]?.usage === undefined), JSON.stringify(c4))
  const c4b = tr4({ type: 'usage', usage: undefined }, 'r4')
  check('USAGE-CHUNK-04 usage 事件无数据不产生 chunk（不伪造 0）', c4b.length === 0, JSON.stringify(c4b))

  // ---- USAGE-CHUNK-05：engine 集成——流中 usage 事件带 revision，terminal 后无追加 ----
  const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => {
    start(input: Record<string, unknown>): Promise<{ ok: boolean }>
    step(runId: string): Promise<void>
  }
  const repoMod = await loadTsModule('src/main/db/repository.ts')
  const createRepository = repoMod.createRepository as (p: string) => {
    open(): void
    close(): void
  }
  const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createRunStorePort = storePortMod.createRunStorePort as (r: unknown) => Record<string, unknown>
  const repo = createRepository(path.join(tmp, 'usage.db'))
  repo.open()
  const emitted: Array<{ type: string; usage?: { revision?: number; kind?: string } }> = []
  const engine = createAgentRunEngine({
    store: createRunStorePort(repo as never),
    modelCall: async () => {
      let sent = 0
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; usage?: { inputTokens: number; outputTokens: number; revision: number; kind: string }; finishReason?: string }> {
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, revision: 1, kind: 'partial' } }
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12, revision: 2, kind: 'actual' } }
          yield { type: 'finish', finishReason: 'stop' }
          void sent
        }
      }
    },
    toolExecutor: async () => '',
    getConfig: () => ({ maxTurns: 3 }),
    onEvent: (_runId: string, ev: { type: string; usage?: { revision?: number; kind?: string } }) => emitted.push(ev as never),
    onRunUpdate: () => undefined
  })
  await engine.start({ sessionId: 's-u', runId: 'run-u', config: { maxTurns: 3 } })
  await engine.step('run-u')
  const usageEvs = emitted.filter((e) => e.type === 'usage')
  check('USAGE-CHUNK-05 引擎发出 2 次 usage 事件（流中多次更新）', usageEvs.length === 2, JSON.stringify(usageEvs))
  check('USAGE-CHUNK-05 usage 事件带递增 revision（1→2）', usageEvs[0]?.usage?.revision === 1 && usageEvs[1]?.usage?.revision === 2, JSON.stringify(usageEvs.map((e) => e.usage?.revision)))
  const terminals = emitted.filter((e) => e.type === 'terminal')
  check('USAGE-CHUNK-05 terminal 恰好一次', terminals.length === 1, JSON.stringify(terminals.length))
  repo.close()

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.2-A6 红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.2-A6 红灯回归执行异常：', e)
  process.exit(2)
})
