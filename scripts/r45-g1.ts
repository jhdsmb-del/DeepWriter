import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.5 Gate 1：封死 Galgame completion 绕过（红灯先行） ====================
// 复审 B-01：validator 对无 renpy artifact fail-open；普通 galgame:lint 不绑定业务 run；
// lint evidence 与业务 artifact 无 durable manifest 关系——系统可能"说完成但没验证"。
// 本测试验收（全部先红后绿）：
//  GAL-CONTRACT-FAILCLOSED-01   契约层：galgame 契约必须有 requiredArtifacts(renpy≥1) + renpyLint validator
//  GAL-COMP-NO-ARTIFACT-01     行为层：模型只输出 rpy 文本未登记 artifact → blocked（不能 completed）
//  GAL-COMP-ARTIFACT-NO-LINT-01 有 artifact 无匹配 evidence → blocked（lint_not_run）
//  GAL-LINT-RUN-BIND-01        有 artifact + manifest 匹配 evidence(ok) → completed
//  GAL-LINT-HASH-DRIFT-01      文件内容变化（artifact hash 变）→ manifest 不匹配 → evidence 失效 blocked
//  GAL-LINT-EVIDENCE-01        runGalgameLintForRun：扫描→manifest→lint→evidence 字段齐全（注入 lint）
//  GAL-LINT-EVIDENCE-FAIL-01   lint ok=false → evidence ok=false 落库
//  GAL-LINT-OWNER-01           canLintRunForBusiness：不存在 run / 终态 run 拒绝
//  GAL-LINT-MANIFEST-01        computeManifestHash 确定性（排序稳定、内容敏感）

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
  const outfile = path.resolve(__dirname, '..', 'out', `r45mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

interface EngineLike {
  start(input: Record<string, unknown>): Promise<{ ok: boolean }>
  step(runId: string): Promise<void>
  getState(runId: string): Promise<{ run: { status: string; errorCode?: string; phase: string } | null }>
}

async function makeEngine(repo: { open(): void; close(): void }, artifactDir: string, outputs: string[], cfgOverride?: Record<string, unknown>): Promise<{ engine: EngineLike; events: Array<{ type: string; state?: string }> }> {
  const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => EngineLike
  const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createRunStorePort = storePortMod.createRunStorePort as (r: unknown, artifactDir?: string) => Record<string, unknown>
  const events: Array<{ type: string; state?: string }> = []
  let callIdx = 0
  const engine = createAgentRunEngine({
    store: createRunStorePort(repo as never, artifactDir),
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string }> {
        yield { type: 'text', delta: outputs[Math.min(callIdx++, outputs.length - 1)] }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => cfgOverride ?? engineCfg,
    onEvent: (_r: string, ev: { type: string; state?: string }) => events.push(ev as never),
    onRunUpdate: () => undefined,
    artifactDir
  })
  return { engine, events }
}

const SNAPSHOT_SETTINGS = {
  model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 8192, temperature: 1, topP: 1,
  thinkingEnabled: true, reasoningEffort: 'high' as const, workDir: 'C:/w', docDir: 'C:/d', novelMode: false,
  galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000
}

const GALGAME_SETTINGS = {
  ...SNAPSHOT_SETTINGS,
  galgame: { enabled: true, projectDir: 'C:/galproj', sdkPath: 'C:/renpy/renpy.exe' }
}

/** 契约必须由真实 buildExecutionSnapshot 生成（禁止手写） */
async function makeRealGalgameConfig(): Promise<Record<string, unknown>> {
  const snapMod = await loadTsModule('src/main/executionSnapshot.ts')
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const snap = buildExecutionSnapshot({
    payload: { id: 'req-gal', mode: 'galgame', longMode: false, targetChars: 0, text: '为项目写一个 Ren\'Py 场景' },
    settings: GALGAME_SETTINGS as never,
    sessionId: 's-gal',
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  return { maxTurns: 8, completionContract: snap.completionContract }
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r45-g1-'))
  const artifactDir = path.join(tmp, 'artifacts')

  console.log('\n[R4.5-G1] 封死 Galgame completion 绕过（契约 fail-closed + lint 绑定业务 run + manifest hash）')

  const snapshotMod = await loadTsModule('src/main/executionSnapshot.ts')
  const buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const repoMod = await loadTsModule('src/main/db/repository.ts')
  const createRepository = repoMod.createRepository as (p: string) => {
    open(): void
    close(): void
    getLatestCompletionEvaluation(runId: string): { revision: number; state: string } | null
    saveArtifact(a: Record<string, unknown>): void
    saveRunEvidence(runId: string, kind: string, json: string): void
    getRun(runId: string): { run_id: string; status: string; started_at: number } | null
  }
  const evidenceMod = await loadTsModule('src/main/galgameEvidence.ts')
  const canLintRunForBusiness = evidenceMod.canLintRunForBusiness as (repo: Record<string, unknown>, runId: string) => Promise<{ ok: true; run: Record<string, unknown> } | { ok: false; reason: string }>
  const runGalgameLintForRun = evidenceMod.runGalgameLintForRun as (input: Record<string, unknown>) => Promise<Record<string, unknown>>
  const renpyLintMod = await loadTsModule('src/main/completion/validators/renpyLint.ts')
  const computeManifestHash = renpyLintMod.computeManifestHash as (files: Array<{ path: string; hash: string }>) => string
  const validateRenpyLint = renpyLintMod.validateRenpyLint as (evidence: Record<string, unknown>) => Array<{ code: string }>

  // ---- GAL-CONTRACT-FAILCLOSED-01：契约层 fail-closed ----
  {
    const snap = buildExecutionSnapshot({
      payload: { id: 'req-gal-c', mode: 'galgame', longMode: false, targetChars: 0, text: '写场景' },
      settings: GALGAME_SETTINGS as never,
      sessionId: 's-gc',
      memory: { projectPath: '', projectContent: '', userContent: '' }
    }) as { completionContract: { requiredArtifacts?: Array<{ kind: string; minCount?: number }>; validators: Array<{ id: string }> } | null }
    const cc = snap.completionContract
    check(
      'GAL-CONTRACT-FAILCLOSED-01 galgame 契约要求 renpy 产物 ≥1（无产物不许 completed）',
      cc !== null && (cc.requiredArtifacts ?? []).some((a) => a.kind === 'renpy' && (a.minCount ?? 0) >= 1),
      JSON.stringify(cc?.requiredArtifacts)
    )
    const ids = (cc?.validators ?? []).map((v) => v.id)
    check('GAL-CONTRACT-FAILCLOSED-01 galgame 契约含 renpyLint + requiredArtifacts + noPendingTools', ['renpyLint', 'requiredArtifacts', 'noPendingTools'].every((x) => ids.includes(x)), ids.join(','))
  }

  // ---- validator 层：无 renpy artifact 必须 fail-closed（missing_artifact） ----
  {
    const fs1 = validateRenpyLint({ artifacts: [], pendingToolCount: 0, pendingToolNames: [] } as never)
    check('GAL-VALIDATOR-FAILCLOSED-01 无 renpy artifact → hard missing_artifact（不允许跳过 lint）', fs1.some((f) => f.code === 'missing_artifact'), JSON.stringify(fs1.map((f) => f.code)))
    const fs2 = validateRenpyLint({ artifacts: [{ kind: 'renpy', path: 'a.rpy', hash: 'h1' }], pendingToolCount: 0, pendingToolNames: [] } as never)
    check('GAL-VALIDATOR-FAILCLOSED-02 有 artifact 无 evidence → lint_not_run', fs2.some((f) => f.code === 'lint_not_run'), JSON.stringify(fs2.map((f) => f.code)))
  }

  // ---- GAL-COMP-NO-ARTIFACT-01：模型只输出 rpy 文本（未登记 artifact）→ blocked ----
  {
    const repo = createRepository(path.join(tmp, 'g1.db'))
    repo.open()
    const outputs = ['label start:\n    "你好"'.repeat(30), 'label b:\n    "续写"'.repeat(30), 'label c:\n    "再续"'.repeat(30)]
    const { engine } = await makeEngine(repo, artifactDir, outputs, await makeRealGalgameConfig())
    await engine.start({ sessionId: 's-g1', runId: 'run-g1', config: await makeRealGalgameConfig() })
    await engine.step('run-g1')
    const st = await engine.getState('run-g1')
    check(
      'GAL-COMP-NO-ARTIFACT-01 模型输出 rpy 文本但未登记 artifact → 完成门 blocked（禁止 completed）',
      st.run?.status !== 'completed',
      JSON.stringify(st.run)
    )
    repo.close()
  }

  // ---- GAL-COMP-ARTIFACT-NO-LINT-01：有 renpy artifact 但无匹配 evidence → blocked ----
  {
    const repo = createRepository(path.join(tmp, 'g2.db'))
    repo.open()
    const content = 'label start:\n    "你好"\n'
    const outputs = ['x'.repeat(2000), 'y'.repeat(2000), 'z'.repeat(2000)]
    const { engine } = await makeEngine(repo, artifactDir, outputs, await makeRealGalgameConfig())
    await engine.start({ sessionId: 's-g2', runId: 'run-g2', config: await makeRealGalgameConfig() })
    repo.saveArtifact({
      artifact_id: 'art-1', run_id: 'run-g2', session_id: 's-g2', artifact_type: 'renpy',
      display_name: 'scene1.rpy', relative_path: 'game/scene1.rpy', hash: sha256(content),
      char_count: content.length, status: 'completed', created_at: Date.now()
    })
    await engine.step('run-g2')
    const st = await engine.getState('run-g2')
    check(
      'GAL-COMP-ARTIFACT-NO-LINT-01 有 renpy artifact 无 lint evidence → blocked（lint_not_run，不允许 completed）',
      st.run?.status !== 'completed',
      JSON.stringify(st.run)
    )
    repo.close()
  }

  // ---- GAL-LINT-RUN-BIND-01：artifact + manifest 匹配 evidence(ok) → completed ----
  {
    const repo = createRepository(path.join(tmp, 'g3.db'))
    repo.open()
    const content = 'label start:\n    "绑定成功"\n'
    const artifact = {
      artifact_id: 'art-3', run_id: 'run-g3', session_id: 's-g3', artifact_type: 'renpy',
      display_name: 'scene1.rpy', relative_path: 'game/scene1.rpy', hash: sha256(content),
      char_count: content.length, status: 'completed', created_at: Date.now()
    }
    const outputs = ['x'.repeat(2000)]
    const { engine } = await makeEngine(repo, artifactDir, outputs, await makeRealGalgameConfig())
    await engine.start({ sessionId: 's-g3', runId: 'run-g3', config: await makeRealGalgameConfig() })
    repo.saveArtifact(artifact)
    const manifestHash = computeManifestHash([{ path: 'game/scene1.rpy', hash: artifact.hash }])
    repo.saveRunEvidence('run-g3', 'renpy_lint', JSON.stringify({
      manifest_hash: manifestHash, sdk_version: 'test-sdk-1.0', ok: true,
      error_count: 0, warning_count: 2, output_digest: sha256('lint ok'), linted_at: Date.now()
    }))
    await engine.step('run-g3')
    const st = await engine.getState('run-g3')
    check(
      'GAL-LINT-RUN-BIND-01 artifact + 匹配 manifest evidence(ok) → completed（业务 run 消费同一份 evidence）',
      st.run?.status === 'completed',
      JSON.stringify(st.run)
    )
    repo.close()
  }

  // ---- GAL-LINT-HASH-DRIFT-01：文件内容变化（artifact hash 变）→ manifest 不匹配 → blocked ----
  {
    const repo = createRepository(path.join(tmp, 'g4.db'))
    repo.open()
    const contentOld = 'label start:\n    "旧内容"\n'
    const contentNew = 'label start:\n    "新内容（补丁应用后）"\n'
    const outputs = ['x'.repeat(2000), 'y'.repeat(2000), 'z'.repeat(2000)]
    const { engine } = await makeEngine(repo, artifactDir, outputs, await makeRealGalgameConfig())
    await engine.start({ sessionId: 's-g4', runId: 'run-g4', config: await makeRealGalgameConfig() })
    // 登记的是新内容 artifact（写盘后的真实状态），evidence 是旧内容时的 manifest
    repo.saveArtifact({
      artifact_id: 'art-4', run_id: 'run-g4', session_id: 's-g4', artifact_type: 'renpy',
      display_name: 'scene1.rpy', relative_path: 'game/scene1.rpy', hash: sha256(contentNew),
      char_count: contentNew.length, status: 'completed', created_at: Date.now()
    })
    const oldManifest = computeManifestHash([{ path: 'game/scene1.rpy', hash: sha256(contentOld) }])
    repo.saveRunEvidence('run-g4', 'renpy_lint', JSON.stringify({
      manifest_hash: oldManifest, sdk_version: 'test-sdk-1.0', ok: true,
      error_count: 0, warning_count: 0, output_digest: sha256('old lint'), linted_at: Date.now()
    }))
    await engine.step('run-g4')
    const st = await engine.getState('run-g4')
    check(
      'GAL-LINT-HASH-DRIFT-01 文件变化后旧 manifest evidence 失效 → blocked（不允许用旧 lint 结果完成）',
      st.run?.status !== 'completed',
      JSON.stringify(st.run)
    )
    repo.close()
  }

  // ---- GAL-LINT-MANIFEST-01：manifest hash 确定性 ----
  {
    const m1 = computeManifestHash([{ path: 'b.rpy', hash: 'h2' }, { path: 'a.rpy', hash: 'h1' }])
    const m2 = computeManifestHash([{ path: 'a.rpy', hash: 'h1' }, { path: 'b.rpy', hash: 'h2' }])
    check('GAL-LINT-MANIFEST-01 manifest hash 与输入顺序无关（排序稳定）', m1 === m2, m1)
    const m3 = computeManifestHash([{ path: 'a.rpy', hash: 'h1' }, { path: 'b.rpy', hash: 'h2' }])
    check('GAL-LINT-MANIFEST-01 相同输入 → 相同 hash（确定性）', m3 === m2, '')
    const m4 = computeManifestHash([{ path: 'a.rpy', hash: 'h1-changed' }, { path: 'b.rpy', hash: 'h2' }])
    check('GAL-LINT-MANIFEST-01 内容 hash 变化 → manifest 变化（内容敏感）', m4 !== m2, '')
  }

  // ---- GAL-LINT-EVIDENCE-01：runGalgameLintForRun 真实扫描 + 写 evidence（注入 lint） ----
  {
    const proj = await fsp.mkdtemp(path.join(tmp, 'galproj-'))
    await fsp.mkdir(path.join(proj, 'game'), { recursive: true })
    const fileA = 'label start:\n    "场景 A"\n'
    const fileB = 'label second:\n    "场景 B"\n'
    await fsp.writeFile(path.join(proj, 'game', 'scene_a.rpy'), fileA, 'utf8')
    await fsp.writeFile(path.join(proj, 'game', 'scene_b.rpy'), fileB, 'utf8')

    const saved: Array<{ runId: string; kind: string; json: string }> = []
    const result = await runGalgameLintForRun({
      runId: 'run-ev1',
      projectDir: proj,
      sdkPath: '/fake/renpy',
      sdkVersion: '8.3.0-test',
      saveEvidence: (runId: string, kind: string, json: string) => saved.push({ runId, kind, json }),
      lint: async () => ({ ok: true, output: 'All checks passed.\n0 errors\n2 warnings', exitCode: 0 }),
      scan: async () => ({
        scriptFiles: [
          path.join(proj, 'game', 'scene_a.rpy'),
          path.join(proj, 'game', 'scene_b.rpy')
        ]
      })
    })
    check('GAL-LINT-EVIDENCE-01 服务返回 ok', result.ok === true, JSON.stringify(result).slice(0, 200))
    const ev = saved.find((s) => s.kind === 'renpy_lint')
    check('GAL-LINT-EVIDENCE-01 evidence 已写入（kind=renpy_lint）', ev !== undefined, '')
    let parsed: Record<string, unknown> | null = null
    if (ev) {
      parsed = JSON.parse(ev.json) as Record<string, unknown>
      const expectedManifest = computeManifestHash([
        { path: 'game/scene_a.rpy', hash: sha256(fileA) },
        { path: 'game/scene_b.rpy', hash: sha256(fileB) }
      ])
      check('GAL-LINT-EVIDENCE-01 manifest_hash 正确（路径+内容 hash+排序）', parsed.manifest_hash === expectedManifest, `expected=${expectedManifest} got=${String(parsed.manifest_hash)}`)
      check('GAL-LINT-EVIDENCE-01 sdk_version 记录', parsed.sdk_version === '8.3.0-test', '')
      check('GAL-LINT-EVIDENCE-01 ok/error_count/warning_count/output_digest 齐全', parsed.ok === true && parsed.error_count === 0 && parsed.warning_count === 2 && typeof parsed.output_digest === 'string', JSON.stringify(parsed))
    }
    check('GAL-LINT-EVIDENCE-01 runId 绑定业务 run', ev !== undefined && ev.runId === 'run-ev1', '')
    await fsp.rm(proj, { recursive: true, force: true }).catch(() => undefined)
  }

  // ---- GAL-LINT-EVIDENCE-FAIL-01：lint ok=false → evidence ok=false 落库（fail-closed 写入端） ----
  {
    const saved: Array<{ kind: string; json: string }> = []
    await runGalgameLintForRun({
      runId: 'run-ev2',
      projectDir: tmp,
      sdkPath: '/fake/renpy',
      saveEvidence: (_r: string, kind: string, json: string) => saved.push({ kind, json }),
      lint: async () => ({ ok: false, output: 'line 3: syntax error near "label"', exitCode: 1 }),
      scan: async () => ({ scriptFiles: [] })
    })
    const ev = saved.find((s) => s.kind === 'renpy_lint')
    let parsed: Record<string, unknown> | null = null
    if (ev) parsed = JSON.parse(ev.json) as Record<string, unknown>
    check('GAL-LINT-EVIDENCE-FAIL-01 lint 失败 → evidence ok=false 落库（完成门将据此 blocked）', parsed !== null && parsed.ok === false && parsed.error_count > 0, JSON.stringify(parsed))
  }

  // ---- GAL-LINT-OWNER-01：canLintRunForBusiness 拒绝不存在/终态 run ----
  {
    const repo = createRepository(path.join(tmp, 'g5.db'))
    repo.open()
    const g = await canLintRunForBusiness(repo as never, 'run-not-exists')
    check('GAL-LINT-OWNER-01 不存在的 runId → 拒绝（run_not_found）', g.ok === false && 'reason' in g && (g as { reason: string }).reason === 'run_not_found', JSON.stringify(g))
    // 终态 run（completed）：engine 跑一条一轮达标的长文 run
    const longSnap = buildExecutionSnapshot({
      payload: { id: 'req-owner', mode: 'longwrite', longMode: true, targetChars: 1000, text: '写' },
      settings: SNAPSHOT_SETTINGS as never,
      sessionId: 's-owner',
      memory: { projectPath: '', projectContent: '', userContent: '' }
    }) as { completionContract: Record<string, unknown> }
    const ownerCfg = { maxTurns: 4, completionContract: longSnap.completionContract }
    const { engine } = await makeEngine(repo, artifactDir, ['y'.repeat(2000)], ownerCfg)
    await engine.start({ sessionId: 's-owner', runId: 'run-done', config: ownerCfg })
    await engine.step('run-done')
    const stDone = await engine.getState('run-done')
    check('GAL-LINT-OWNER-01 前置：终态 run 已 completed', stDone.run?.status === 'completed', JSON.stringify(stDone.run))
    const g2 = await canLintRunForBusiness(repo as never, 'run-done')
    check('GAL-LINT-OWNER-01 终态 run → 拒绝（run_terminal，终态不许补 evidence）', g2.ok === false && 'reason' in g2 && (g2 as { reason: string }).reason === 'run_terminal', JSON.stringify(g2))
    repo.close()
  }

  console.log(`\n===== R4.5-G1 红灯测试：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('失败项：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('R4.5-G1 运行异常（红灯阶段预期：目标模块/接口尚未实现）:', e instanceof Error ? e.message : String(e))
  process.exitCode = 2
})
