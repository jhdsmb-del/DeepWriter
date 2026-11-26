// ==================== R4.6 Gate 3：防止 Agent 自欺式完成（行为测试，红灯先行） ====================
// 验收（任务书 §6）：
//  COMP-EVIDENCE-01   聊天声称完成但契约要求的文件不存在 → 拒绝完成（missing_file）
//  COMP-ARTIFACT-01   文件写入后损坏/内容与登记 hash 不符 → 拒绝完成（file_corrupt）
//  COMP-REN-PY-01     要求可运行 demo 时 lint 未通过 → 不得完成（lint_failed）
//  COMP-REMAINING-01  暂停状态列出的剩余工作可复算且与 validator 一致
//  COMP-RECOVERY-02   强杀恢复后不能跳过之前未通过的 validator（gate 重新评估全部）

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
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
  const outfile = path.resolve(__dirname, '..', 'out', `r46g3-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

interface EvalLike {
  state: string
  hardFailures: Array<{ code: string; message: string }>
  remainingWork: Array<{ code: string; message: string; hash: string }>
  blockedReason?: string
}

interface CtrlLike {
  submitCandidate(ev: Record<string, unknown>): EvalLike
  requestContinuation(): EvalLike
}

const EVIDENCE = (content: Record<string, string>, measuredChars = 10000): Record<string, unknown> => ({
  // buildCompletionContract uses target ±1%; 10,000 is the exact target.
  measuredChars,
  artifacts: Object.entries(content).map(([pathKey, c]) => ({ kind: 'text', path: pathKey, hash: sha256(c) })),
  pendingToolCount: 0,
  pendingToolNames: [],
  artifactContents: Object.fromEntries(Object.entries(content).map(([p, c]) => [sha256(c), c]))
})

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r46-g3-'))
  console.log('\n[R4.6-G3] 防止 Agent 自欺式完成（产物 evidence 覆盖）')

  const ctrlMod = await loadTsModule('src/main/completion/CompletionController.ts')
  const CompletionController = ctrlMod.CompletionController as new (opts: Record<string, unknown>) => CtrlLike
  const feMod = await loadTsModule('src/main/completion/validators/fileEvidence.ts')
  const validateFileEvidence = feMod.validateFileEvidence as (specs: Array<Record<string, unknown>>, ev: Record<string, unknown>) => Array<{ code: string }>
  const snapMod = await loadTsModule('src/main/executionSnapshot.ts')
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => { completionContract: Record<string, unknown> }

  const SNAPSHOT_SETTINGS = {
    model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 8192, temperature: 1, topP: 1,
    thinkingEnabled: true, reasoningEffort: 'high' as const, workDir: 'C:/w', docDir: 'C:/d', novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000,
    // G3 is scoped to artifact/file evidence.  Explicitly disable the
    // unrelated longwrite constraint validator so its findings do not mask
    // the missing/corrupt-file assertions below.
    strongConstraintEnabled: false as const,
    themeLockMode: 'off' as const,
    antiMoralizingEnabled: false as const
  }

  const contractWith = (requiredFiles: Array<Record<string, unknown>>): Record<string, unknown> => {
    const snap = buildExecutionSnapshot({
      payload: { id: 'req-g3', mode: 'longwrite', longMode: true, targetChars: 10000, text: '写', requiredFiles },
      settings: SNAPSHOT_SETTINGS as never,
      sessionId: 's-g3',
      memory: { projectPath: '', projectContent: '', userContent: '' }
    })
    return snap.completionContract
  }

  // ---- COMP-EVIDENCE-01：聊天声称完成但文件不存在 → 拒绝（missing_file） ----
  {
    const contract = contractWith([{ path: 'out/chapter1.md', kind: 'markdown', minChars: 100 }])
    const c = new CompletionController({ contract, store: { saveEvaluation: () => undefined, getLatestEvaluation: () => null }, now: () => Date.now() })
    // 模型声称完成：只输出文本，无 artifact 登记（文件从未存在）
    const ev = c.submitCandidate({ measuredChars: 10000, artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
    check('COMP-EVIDENCE-01 声称完成但契约文件不存在 → 拒绝（missing_file，非 completed）', ev.state !== 'completed' && ev.hardFailures.some((f) => f.code === 'missing_file'), JSON.stringify(ev.hardFailures.map((f) => f.code)))
    const cont = c.requestContinuation()
    check('COMP-EVIDENCE-01 缺口进入续作/暂停（不伪完成）', cont.state === 'continuing' || cont.state === 'waiting_user', `state=${cont.state}`)
  }

  // ---- COMP-ARTIFACT-01：文件登记但内容损坏（hash 漂移）→ 拒绝（file_corrupt） ----
  {
    const contract = contractWith([{ path: 'out/chapter1.md', kind: 'markdown', minChars: 100 }])
    const c = new CompletionController({ contract, store: { saveEvaluation: () => undefined, getLatestEvaluation: () => null }, now: () => Date.now() })
    // 登记 hash 是完整内容；磁盘读回的是损坏内容（截断/乱码）
    const goodContent = '第一章\n'.repeat(50)
    const corrupted = goodContent.slice(0, 20) // 截断损坏
    const ev = c.submitCandidate({
      measuredChars: 10000,
      artifacts: [{ kind: 'text', path: 'out/chapter1.md', hash: sha256(goodContent) }],
      pendingToolCount: 0,
      pendingToolNames: [],
      artifactContents: { [sha256(goodContent)]: corrupted } // 读回内容与登记 hash 不符
    })
    check('COMP-ARTIFACT-01 文件损坏（读回 hash 与登记不符）→ 拒绝（file_corrupt）', ev.hardFailures.some((f) => f.code === 'file_corrupt'), JSON.stringify(ev.hardFailures.map((f) => f.code)))
    // 内容不足（minChars）
    const ev2 = c.submitCandidate({
      measuredChars: 10000,
      artifacts: [{ kind: 'text', path: 'out/chapter1.md', hash: sha256('短内容') }],
      pendingToolCount: 0,
      pendingToolNames: [],
      artifactContents: { [sha256('短内容')]: '短内容' }
    })
    check('COMP-ARTIFACT-01 内容不足 minChars → 拒绝（file_corrupt）', ev2.hardFailures.some((f) => f.code === 'file_corrupt'), JSON.stringify(ev2.hardFailures.map((f) => f.code)))
    // 读回为空（文件被删）
    const ev3 = c.submitCandidate({
      measuredChars: 10000,
      artifacts: [{ kind: 'text', path: 'out/chapter1.md', hash: sha256(goodContent) }],
      pendingToolCount: 0,
      pendingToolNames: [],
      artifactContents: {} // 磁盘读回为空
    })
    check('COMP-ARTIFACT-01 读回为空（文件已删）→ 拒绝（file_corrupt）', ev3.hardFailures.some((f) => f.code === 'file_corrupt'), '')
  }

  // ---- COMP-EVIDENCE-01b：文件真实存在且完好 → 通过（配合字数达标 → completed） ----
  {
    const contract = contractWith([{ path: 'out/chapter1.md', kind: 'markdown', minChars: 100 }])
    const c = new CompletionController({ contract, store: { saveEvaluation: () => undefined, getLatestEvaluation: () => null }, now: () => Date.now() })
    const content = '第一章 完整内容\n'.repeat(60)
    const ev = c.submitCandidate(EVIDENCE({ 'out/chapter1.md': content }))
    check('COMP-EVIDENCE-01b 文件存在且完好 + 字数达标 → completed（全部 validator 通过）', ev.state === 'completed', JSON.stringify(ev.hardFailures.map((f) => f.code)))
  }

  // ---- COMP-REN-PY-01：要求可运行 demo 时 lint 未通过 → 不得完成 ----
  {
    const snap = buildExecutionSnapshot({
      payload: { id: 'req-gg3', mode: 'galgame', text: '写 demo' },
      settings: SNAPSHOT_SETTINGS as never,
      sessionId: 's-gg3',
      memory: { projectPath: '', projectContent: '', userContent: '' }
    })
    const c = new CompletionController({ contract: snap.completionContract, store: { saveEvaluation: () => undefined, getLatestEvaluation: () => null }, now: () => Date.now() })
    const rpyContent = 'label start:\n    "demo"\n'
    // lint 失败 evidence（ok=false）→ 拒绝
    const ev = c.submitCandidate({
      measuredChars: 100,
      artifacts: [{ kind: 'renpy', path: 'game/script.rpy', hash: sha256(rpyContent) }],
      pendingToolCount: 0,
      pendingToolNames: [],
      renpyLint: { ok: false, errorCount: 2, warningCount: 1, output: 'line 3: error', sdkVersion: '8.5.3' }
    })
    check('COMP-REN-PY-01 lint 未通过（ok=false）→ 拒绝完成（lint_failed）', ev.state !== 'completed' && ev.hardFailures.some((f) => f.code === 'lint_failed'), JSON.stringify(ev.hardFailures.map((f) => f.code)))
    // lint 通过 → 与契约其余条件共同判定
    const evOk = c.submitCandidate({
      measuredChars: 100,
      artifacts: [{ kind: 'renpy', path: 'game/script.rpy', hash: sha256(rpyContent) }],
      pendingToolCount: 0,
      pendingToolNames: [],
      renpyLint: { ok: true, errorCount: 0, warningCount: 0, output: '0 errors', sdkVersion: '8.5.3' }
    })
    check('COMP-REN-PY-01 lint 通过后契约可完成（其余条件满足）', evOk.state === 'completed', JSON.stringify(evOk.hardFailures.map((f) => f.code)))
  }

  // ---- COMP-REMAINING-01：暂停状态剩余工作与 validator 一致（可复算） ----
  {
    const contract = contractWith([{ path: 'out/chapter1.md', kind: 'markdown', minChars: 100 }])
    const c = new CompletionController({ contract, store: { saveEvaluation: () => undefined, getLatestEvaluation: () => null }, now: () => Date.now() })
    const ev = c.submitCandidate(EVIDENCE({}, 5000))
    check('COMP-REMAINING-01 未达标 + 缺文件 → validating（两个 hard finding）', ev.state === 'validating', JSON.stringify(ev.hardFailures.map((f) => f.code)))
    const cont = c.requestContinuation()
    check('COMP-REMAINING-01 续作剩余工作与 validator 输出一致（below_target + missing_file）', cont.remainingWork.map((w) => w.code).sort().join(',') === 'below_target,missing_file', JSON.stringify(cont.remainingWork.map((w) => w.code)))
    // 可复算：用同一 evidence 重跑 validator 得到相同 finding 集合
    const re = validateFileEvidence([{ path: 'out/chapter1.md', kind: 'markdown', minChars: 100 }], { artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
    check('COMP-REMAINING-01 validator 可复算（重跑得到相同 missing_file）', re.some((f) => f.code === 'missing_file'), JSON.stringify(re.map((f) => f.code)))
  }

  // ---- COMP-RECOVERY-02：强杀恢复后不能跳过之前未通过的 validator ----
  {
    const saved: Array<Record<string, unknown>> = []
    const store = {
      saveEvaluation: (_r: string, ev: Record<string, unknown>) => saved.push(ev),
      getLatestEvaluation: () => (saved.length ? saved[saved.length - 1] : null)
    }
    const contract = contractWith([{ path: 'out/chapter1.md', kind: 'markdown', minChars: 100 }])
    const c1 = new CompletionController({ contract, store: store as never, now: () => 1000 })
    c1.submitCandidate({ measuredChars: 5000, artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
    c1.requestContinuation()
    // 强杀恢复：fromStore 装载最新 evaluation（validating/continuing）——不得跳过 fileEvidence
    const ctrlMod2 = await loadTsModule('src/main/completion/CompletionController.ts')
    const fromStore = ctrlMod2.CompletionController.fromStore as (opts: Record<string, unknown>, latest: Record<string, unknown> | null) => CtrlLike
    const restored = fromStore({ contract, store: store as never, now: () => 2000 }, saved[saved.length - 1] as never)
    const evAfter = restored.submitCandidate({ measuredChars: 10000, artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
    check('COMP-RECOVERY-02 恢复后重新评估全部 validator（缺文件仍拒绝完成）', evAfter.state !== 'completed' && evAfter.hardFailures.some((f) => f.code === 'missing_file'), JSON.stringify(evAfter.hardFailures.map((f) => f.code)))
    // 恢复后文件补齐 → 可完成（validator 全部通过）
    const content = '完整内容\n'.repeat(60)
    const evFixed = restored.submitCandidate(EVIDENCE({ 'out/chapter1.md': content }))
    check('COMP-RECOVERY-02 恢复后补齐文件 → completed（不跳过 validator 也不误拦）', evFixed.state === 'completed', JSON.stringify(evFixed.hardFailures.map((f) => f.code)))
  }

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n===== R4.6-G3 行为测试：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('R4.6-G3 运行异常（红灯阶段预期：目标接口尚未实现）:', e instanceof Error ? e.message : String(e))
  process.exitCode = 2
})
