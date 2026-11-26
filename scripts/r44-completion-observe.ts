import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.4 Gate 3：completion 可观察闭环（translator 层） ====================
// 覆盖：
//  COM-OBSERVE-01：completion 事件 → typed completion chunk（subtype/revision/进度字段）
//  COM-OBSERVE-02：terminal 后迟到 completion 丢弃（与 usage 同规则）
//  COM-OBSERVE-03：contract_created → continuation_required → completion_accepted 序列逐条转发
// 运行：npx esbuild scripts/r44-completion-observe.ts --bundle --format=esm --platform=node --outfile=out/r44-observe.mjs && node out/r44-observe.mjs

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
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r44-observe-'))

  console.log('\n[R4.4-G3] COM-OBSERVE：completion 事件贯通（typed chunk + 迟到丢弃 + 序列转发）')
  const adapterMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createChunkTranslator = adapterMod.createChunkTranslator as () => (ev: Record<string, unknown>, runId: string, planMode?: boolean) => Array<Record<string, unknown>>

  // COM-OBSERVE-03：contract_created → continuation_required → completion_accepted 逐条转发
  {
    const tr = createChunkTranslator()
    const c1 = tr({ type: 'completion', completion: { subtype: 'contract_created', state: 'planning', revision: 0, remainingWork: [] } }, 'r1')
    check('COM-OBSERVE-03 contract_created → typed completion chunk', c1.length === 1 && c1[0]?.type === 'completion' && (c1[0]?.completionChunk as { subtype?: string })?.subtype === 'contract_created', JSON.stringify(c1))
    const c2 = tr({ type: 'completion', completion: { subtype: 'continuation_required', state: 'continuing', revision: 2, measuredChars: 8400, targetChars: 10000, validatorPassed: 2, validatorTotal: 3, remainingWork: [{ code: 'below_target', message: '字数不足' }] } }, 'r1')
    const cc2 = c2[0]?.completionChunk as { measuredChars?: number; targetChars?: number; validatorPassed?: number; validatorTotal?: number; remainingWork?: unknown[] } | undefined
    check('COM-OBSERVE-03 continuation_required 携带客观进度（measured/target/validator）', cc2?.measuredChars === 8400 && cc2?.targetChars === 10000 && cc2?.validatorPassed === 2 && cc2?.validatorTotal === 3 && Array.isArray(cc2?.remainingWork) && cc2.remainingWork.length === 1, JSON.stringify(c2))
    const c3 = tr({ type: 'completion', completion: { subtype: 'completion_accepted', state: 'completed', revision: 3, measuredChars: 10000, targetChars: 10000, validatorPassed: 3, validatorTotal: 3, remainingWork: [] } }, 'r1')
    check('COM-OBSERVE-03 completion_accepted 到达（三事件序列逐条转发）', c3[0]?.type === 'completion' && (c3[0]?.completionChunk as { subtype?: string })?.subtype === 'completion_accepted', JSON.stringify(c3))
  }

  // COM-OBSERVE-01：blocked 事件含 blockedReason
  {
    const tr = createChunkTranslator()
    const cb = tr({ type: 'completion', completion: { subtype: 'completion_blocked', state: 'blocked', revision: 5, remainingWork: [{ code: 'below_target', message: '无进展' }] } }, 'r2')
    check('COM-OBSERVE-01 completion_blocked 转发（含 remainingWork）', cb.length === 1 && (cb[0]?.completionChunk as { subtype?: string })?.subtype === 'completion_blocked' && Array.isArray((cb[0]?.completionChunk as { remainingWork?: unknown[] })?.remainingWork), JSON.stringify(cb))
  }

  // COM-OBSERVE-02：terminal 后迟到 completion 丢弃（与 usage 同规则）
  {
    const tr = createChunkTranslator()
    const term = tr({ type: 'terminal', run: { status: 'completed' } }, 'r3')
    check('COM-OBSERVE-02 terminal 正常发出', term.some((c) => c.type === 'done'), '')
    const late = tr({ type: 'completion', completion: { subtype: 'validator_result', state: 'validating', revision: 9, remainingWork: [] } }, 'r3')
    check('COM-OBSERVE-02 terminal 后迟到 completion 丢弃（不重复累计）', late.length === 0, JSON.stringify(late))
  }

  // COM-OBSERVE-04：无 completion 数据不产生 chunk
  {
    const tr = createChunkTranslator()
    const none = tr({ type: 'completion', completion: undefined }, 'r4')
    check('COM-OBSERVE-04 completion 事件无数据不产生 chunk', none.length === 0, JSON.stringify(none))
  }

  // COM-OBSERVE-05：shared reducer revision 去重（renderer store 用同一逻辑）
  {
    const mod = await loadTsModule('src/shared/completionProgress.ts')
    const applyCompletionChunk = mod.applyCompletionChunk as (runId: string, chunk: Record<string, unknown>, current: Record<string, unknown> | undefined) => Record<string, unknown> | null
    const r1 = applyCompletionChunk('r5', { subtype: 'continuation_required', state: 'continuing', revision: 2, measuredChars: 8400, targetChars: 10000, validatorPassed: 1, validatorTotal: 2, remainingWork: [] }, undefined)
    check('COM-OBSERVE-05 首次 chunk 应用（进度保存）', r1 !== null && (r1 as { revision?: number })?.revision === 2 && (r1 as { measuredChars?: number })?.measuredChars === 8400, JSON.stringify(r1))
    const r2 = applyCompletionChunk('r5', { subtype: 'validator_result', state: 'validating', revision: 1, remainingWork: [] }, r1 as Record<string, unknown>)
    check('COM-OBSERVE-05 迟到旧 revision 丢弃（不覆盖新进度）', r2 === null, JSON.stringify(r2))
    const r3 = applyCompletionChunk('r5', { subtype: 'completion_accepted', state: 'completed', revision: 3, remainingWork: [] }, r1 as Record<string, unknown>)
    check('COM-OBSERVE-05 新 revision 覆盖（序列推进）', r3 !== null && (r3 as { revision?: number })?.revision === 3 && (r3 as { subtype?: string })?.subtype === 'completion_accepted', JSON.stringify(r3))
  }

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.4-G3 可观察闭环：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.4-G3 可观察闭环执行异常：', e)
  process.exit(2)
})
