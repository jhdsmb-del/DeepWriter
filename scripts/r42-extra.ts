import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.2 补充验收（任务书要求补全）：A3 hash 冻结 / A4 owner 决策 / A5 工具大输出落 artifact / A6 usage revision 去重 / A7 session revoke ====================
// 运行：npx esbuild scripts/r42-extra.ts --bundle --format=esm --platform=node --outfile=out/r42-extra.mjs && node out/r42-extra.mjs

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
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r42-extra-'))

  console.log('\n[R42-EXTRA] 任务书补全：A3 hash 冻结 / A4 owner 决策 / A5 artifact 摘要 / A6 revision 去重 / A7 session revoke')

  // ---- A5：工具大输出落 artifact，只向模型发摘要 ----
  const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => {
    start(input: Record<string, unknown>): Promise<{ ok: boolean }>
    step(runId: string): Promise<void>
    getState(runId: string): Promise<{ turns: Array<{ role: string; content: string }>; toolCalls: Array<{ name: string; resultJson?: string }> }>
  }
  const ARTIFACT_SPILL_CHARS = engineMod.ARTIFACT_SPILL_CHARS as number
  const summarizeToolOutput = engineMod.summarizeToolOutput as (result: string, name: string) => string
  check('R42-EXTRA-A5 导出 ARTIFACT_SPILL_CHARS 阈值（数值）', typeof ARTIFACT_SPILL_CHARS === 'number' && ARTIFACT_SPILL_CHARS > 0, String(ARTIFACT_SPILL_CHARS))
  const big = 'x'.repeat(30000)
  const bigJson = JSON.stringify({ ok: true, message: big })
  const summary = summarizeToolOutput(big, 'mock_tool')
  check('R42-EXTRA-A5 大输出摘要远小于原文且含 artifact 引用', summary.length < 5000 && summary.includes('[完整输出已存 artifact') && !summary.includes(big), `len=${summary.length}`)
  const small = summarizeToolOutput('小结果', 'mock_tool')
  check('R42-EXTRA-A5 小输出原样返回（不落 artifact）', small === '小结果')

  const repoMod = await loadTsModule('src/main/db/repository.ts')
  const createRepository = repoMod.createRepository as (p: string) => {
    open(): void
    close(): void
    getArtifactsByRun(runId: string): Array<{ artifact_id: string; artifact_type: string; display_name: string; hash: string | null; char_count: number }>
  }
  const repo = createRepository(path.join(tmp, 'extra.db'))
  repo.open()
  const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createRunStorePort = storePortMod.createRunStorePort as (r: unknown, artifactDir: string) => Record<string, unknown>
  const artifactDir = path.join(tmp, 'artifacts')
  let savedArtifacts: string[] = []
  const engine = createAgentRunEngine({
    store: createRunStorePort(repo as never, artifactDir),
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; tool?: { index: number; id: string; name: string; arguments: string }; finishReason?: string }> {
        yield { type: 'tool_call', tool: { index: 0, id: 'tc-1', name: 'mock_tool', arguments: '{}' } }
        yield { type: 'finish', finishReason: 'tool_calls' }
      }
    }),
    toolExecutor: async () => JSON.stringify({ ok: true, message: big }),
    getConfig: () => ({ maxTurns: 2 }),
    onEvent: (_r: string, ev: { type: string }) => {
      if (ev.type === 'tool') savedArtifacts.push('tool-event')
    },
    onRunUpdate: () => undefined,
    artifactDir
  })
  await engine.start({ sessionId: 's-extra', runId: 'run-extra', config: { maxTurns: 2 } })
  await engine.step('run-extra')
  const st = await engine.getState('run-extra')
  const toolTurn = st.turns.find((t) => t.role === 'tool')
  check('R42-EXTRA-A5 工具 turn 只含摘要（不含 30000 字符原文）', toolTurn !== undefined && toolTurn.content.length < 5000 && toolTurn.content.includes('[完整输出已存 artifact'), `len=${toolTurn?.content.length ?? 0}`)
  const arts = repo.getArtifactsByRun('run-extra')
  check('R42-EXTRA-A5 artifact 元数据落库（tool-output + char_count>=30000）', arts.length === 1 && arts[0]?.artifact_type === 'tool-output' && (arts[0]?.char_count ?? 0) >= 30000, JSON.stringify(arts))
  const files = await fsp.readdir(artifactDir).catch(() => [] as string[])
  check('R42-EXTRA-A5 artifact 内容写磁盘对象（文件名=hash，无用户路径）', files.length === 1 && /^[0-9a-f]{64}\.txt$/.test(files[0] ?? ''), JSON.stringify(files))
  if (files[0]) {
    const content = await fsp.readFile(path.join(artifactDir, files[0]), 'utf-8')
    check('R42-EXTRA-A5 磁盘 artifact 内容=完整工具输出（可恢复）', content === bigJson, `len=${content.length}`)
  }
  // 第二轮：模型消息应只含摘要（tool turn 摘要）
  const modelMsgLen = toolTurn?.content.length ?? 0
  check('R42-EXTRA-A5 模型可见工具消息为摘要（<5KB）', modelMsgLen < 5000, `len=${modelMsgLen}`)

  // ---- A3：attachment asset hashes 冻结进 execution snapshot ----
  const snapMod = await loadTsModule('src/main/executionSnapshot.ts')
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => { attachments: Array<{ fileRefId: string; hash?: string }> }
  const snap = buildExecutionSnapshot({
    payload: { id: 'req-hash', mode: 'agent', attachments: [{ fileRefId: 'ref-h1', name: 'a.txt', size: 100 }] },
    settings: { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 8192, temperature: 1, topP: 1, thinkingEnabled: true, reasoningEffort: 'high', workDir: 'C:/w', docDir: 'C:/d', novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000 },
    sessionId: 's-hash',
    memory: { projectPath: '', projectContent: '', userContent: '' },
    attachmentHashes: { 'ref-h1': 'abc123def456' }
  })
  check('R42-EXTRA-A3 snapshot.attachments 冻结 asset hash', snap.attachments[0]?.fileRefId === 'ref-h1' && snap.attachments[0]?.hash === 'abc123def456', JSON.stringify(snap.attachments))
  const snap2 = buildExecutionSnapshot({
    payload: { id: 'req-hash2', mode: 'agent', attachments: [{ fileRefId: 'ref-h2', name: 'b.txt', size: 10 }] },
    settings: { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 8192, temperature: 1, topP: 1, thinkingEnabled: true, reasoningEffort: 'high', workDir: 'C:/w', docDir: 'C:/d', novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000 },
    sessionId: 's-hash2',
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  check('R42-EXTRA-A3 无 hash 输入时 hash 缺省（不伪造）', snap2.attachments[0]?.hash === undefined, JSON.stringify(snap2.attachments))

  // ---- A4：recoverDecide 窗口 owner 校验 ----
  const ownMod = await loadTsModule('src/main/runOwnership.ts')
  const runOwnedByWindow = ownMod.runOwnedByWindow as (kernelWins: ReadonlyMap<string, { webContents: { id: number } }>, runId: string, webContentsId: number) => boolean
  const wins = new Map<string, { webContents: { id: number } }>([['run-ow', { webContents: { id: 7 } }]])
  check('R42-EXTRA-A4 领养窗口可决策', runOwnedByWindow(wins, 'run-ow', 7) === true)
  check('R42-EXTRA-A4 其他窗口不可决策', runOwnedByWindow(wins, 'run-ow', 8) === false)
  check('R42-EXTRA-A4 未领养 run 不可决策', runOwnedByWindow(wins, 'run-nope', 7) === false)

  // ---- A6：UI 端 usage revision 去重（迟到/重连不重复累计） ----
  const accMod = await loadTsModule('src/shared/usageAccumulator.ts')
  const createUsageAccumulator = accMod.createUsageAccumulator as () => {
    apply(runId: string, revision: number, inputTokens: number, outputTokens: number): { inputTokens: number; outputTokens: number } | null
    reset(runId: string): void
  }
  const acc = createUsageAccumulator()
  const r1 = acc.apply('run-u1', 1, 10, 5)
  const r2 = acc.apply('run-u1', 2, 30, 12)
  check('R42-EXTRA-A6 revision 递增时累计', r1?.inputTokens === 10 && r2?.inputTokens === 30 && r2?.outputTokens === 12, JSON.stringify([r1, r2]))
  const r3 = acc.apply('run-u1', 1, 999, 999)
  check('R42-EXTRA-A6 迟到旧 revision 被丢弃（不重复累计）', r3 === null, JSON.stringify(r3))
  const r4 = acc.apply('run-u1', 2, 999, 999)
  check('R42-EXTRA-A6 重复 revision 被丢弃', r4 === null, JSON.stringify(r4))
  const r5 = acc.apply('run-u2', 1, 7, 3)
  check('R42-EXTRA-A6 不同 run 独立累计', r5?.inputTokens === 7, JSON.stringify(r5))
  acc.reset('run-u1')
  const r6 = acc.apply('run-u1', 1, 1, 1)
  check('R42-EXTRA-A6 重连 resync 后 reset 可重新累计', r6?.inputTokens === 1, JSON.stringify(r6))

  // ---- A7：session 生命周期 revoke（FileRef scope 列表 + asset lease 释放） ----
  const fileRefMod = await loadTsModule('src/main/fileRef.ts')
  const FileRefRegistry = fileRefMod.FileRefRegistry as new (max?: number) => {
    register(paths: string[], scope: unknown, source: string): Promise<{ refs: Array<{ fileRefId: string }> }>
    listRefIds(scope: unknown): string[]
    revokeScope(scope: unknown): void
    inspect(refId: string, scope: unknown): unknown
  }
  const registry = new FileRefRegistry()
  const scopeA = { kind: 'session', sessionId: 'sess-A', draftId: 'current' }
  const scopeB = { kind: 'session', sessionId: 'sess-B', draftId: 'current' }
  const fa = path.join(tmp, 'fa.txt')
  const fb = path.join(tmp, 'fb.txt')
  await fsp.writeFile(fa, 'AAA', 'utf-8')
  await fsp.writeFile(fb, 'BBB', 'utf-8')
  const ra = await registry.register([fa], scopeA, 'dialog')
  const rb = await registry.register([fb], scopeB, 'dialog')
  const idsA = registry.listRefIds(scopeA)
  const idsB = registry.listRefIds(scopeB)
  check('R42-EXTRA-A7 listRefIds 按 scope 精确返回', idsA.length === 1 && idsA[0] === ra.refs[0]?.fileRefId && idsB.length === 1 && idsB[0] === rb.refs[0]?.fileRefId, JSON.stringify([idsA, idsB]))
  registry.revokeScope(scopeA)
  check('R42-EXTRA-A7 revokeScope 后 session A 引用失效', registry.inspect(ra.refs[0]?.fileRefId ?? '', scopeA) === null)
  check('R42-EXTRA-A7 revokeScope 不影响 session B', registry.inspect(rb.refs[0]?.fileRefId ?? '', scopeB) !== null)

  repo.close()
  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.2 补充验收：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.2 补充验收执行异常：', e)
  process.exit(2)
})
