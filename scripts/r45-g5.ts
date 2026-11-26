import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.5 Gate 5：credential slot/version 与 rollback roots 边界（红灯先行） ====================
// 复审 S-03：API Key 从 currentSettings 实时取（旧 run 换身份）；rollback roots 混入 currentSettings。
// 本测试验收：
//  CRED-VERSION-01   同 origin 换 key → version+1；旧 ref 解析 fail-closed（不退回新 key）
//  CRED-RESOLVE-01   同 version 解析 → 原 key（旧 run 不漂移）
//  CRED-DELETE-01    key 删除 → resolve missing（fail-closed）
//  CRED-NO-LEAK-01   registry refs/快照不暴露明文 key
//  CRED-ENGINE-MISSING-01 engine modelCall 抛 credential_missing → run waiting_user/auth_required（非 failed）
//  CRED-ENGINE-OK-01 正常解析 → run 完成（用原 version 的 key）
//  ROLLBACK-ROOTS-01 rollback roots 只含快照 workDir/docDir + 固定目录（不含 currentSettings 变化）

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
  const outfile = path.resolve(__dirname, '..', 'out', `r45g5-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

interface RegistryLike {
  register(origin: string, model: string, apiKey: string): { slotId: string; version: number; issuedAt: number }
  resolve(ref: { slotId: string; version: number; origin: string; model: string; issuedAt: number }): { apiKey: string; origin: string; model: string }
  acquire(runId: string, ref: unknown): void
  release(runId: string): void
  refs(): Array<Record<string, unknown>>
}

interface EngineLike {
  start(input: Record<string, unknown>): Promise<{ ok: boolean }>
  step(runId: string): Promise<void>
  getState(runId: string): Promise<{ run: { status: string; errorCode?: string; phase: string; errorMessage?: string } | null }>
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r45-g5-'))

  console.log('\n[R4.5-G5] credential slot/version 与 rollback roots 边界')

  const credMod = await loadTsModule('src/main/credentialRegistry.ts')
  const createCredentialRegistry = credMod.createCredentialRegistry as () => RegistryLike
  const CredentialMissingError = credMod.CredentialMissingError as new (ref: unknown, message?: string) => { code: string }

  // ---- CRED-VERSION-01 / CRED-RESOLVE-01 / CRED-DELETE-01 / CRED-NO-LEAK-01 ----
  {
    const reg = createCredentialRegistry()
    const v1 = reg.register('https://api.deepseek.com', 'deepseek-v4-flash', 'sk-old-key')
    check('CRED-VERSION-01 首次注册 version=1', v1.version === 1, JSON.stringify(v1))
    const ref1 = { slotId: v1.slotId, version: v1.version, origin: 'https://api.deepseek.com', model: 'deepseek-v4-flash', issuedAt: v1.issuedAt }
    const r1 = reg.resolve(ref1)
    check('CRED-RESOLVE-01 同 version 解析 → 原 key（sk-old-key）', r1.apiKey === 'sk-old-key', '')
    // 同 origin 换 key（模拟用户切换账号/密钥）
    const v2 = reg.register('https://api.deepseek.com', 'deepseek-v4-flash', 'sk-new-key')
    check('CRED-VERSION-01 换 key → version+1（不可变版本）', v2.version === v1.version + 1, `v1=${v1.version} v2=${v2.version}`)
    const r2 = reg.resolve({ ...ref1, version: v2.version })
    check('CRED-RESOLVE-01 新 version 解析 → 新 key', r2.apiKey === 'sk-new-key', '')
    // 旧 run 的 ref（v1）→ fail-closed（不退回新 key）
    let missing = false
    try {
      reg.resolve(ref1)
    } catch (e) {
      missing = (e as { code?: string }).code === 'credential_missing'
    }
    check('CRED-VERSION-01 旧 run 的 v1 ref 解析 → fail-closed（绝不退回当前任意 key）', missing, '')
    // 删除 key
    reg.register('https://api.deepseek.com', 'deepseek-v4-flash', '')
    let missing2 = false
    try {
      reg.resolve({ ...ref1, version: v2.version })
    } catch (e) {
      missing2 = (e as { code?: string }).code === 'credential_missing'
    }
    check('CRED-DELETE-01 key 删除 → resolve missing（fail-closed）', missing2, '')
    // 明文不泄露
    const refs = reg.refs()
    check('CRED-NO-LEAK-01 registry refs 不含明文 key', !JSON.stringify(refs).includes('sk-'), JSON.stringify(refs).slice(0, 120))
    // 同 key 幂等
    reg.register('https://api.deepseek.com', 'deepseek-v4-flash', 'sk-stable')
    const v3 = reg.register('https://api.deepseek.com', 'deepseek-v4-flash', 'sk-stable')
    const r3 = reg.resolve({ slotId: v3.slotId, version: v3.version, origin: '', model: '', issuedAt: 0 })
    check('CRED-RESOLVE-01 同 key 重复注册幂等（version 不变、可解析）', r3.apiKey === 'sk-stable', '')
    void new CredentialMissingError(null)
  }

  // ---- ROLLBACK-ROOTS-01：roots 只从快照 + 固定目录生成（不随 currentSettings 漂移） ----
  {
    const cpMod = await loadTsModule('src/main/checkpoint.ts')
    const buildRollbackRoots = cpMod.buildRollbackRoots as (snapshotDirs: { workDir?: unknown; docDir?: unknown }, fixedDirs: string[]) => string[]
    const fixed = ['C:/userData/deepwriter-data', 'C:/temp']
    const roots1 = buildRollbackRoots({ workDir: 'C:/snap-work', docDir: 'C:/snap-doc' }, fixed)
    check('ROLLBACK-ROOTS-01 roots 含快照 workDir/docDir + 固定内部目录', roots1.includes('C:/snap-work') && roots1.includes('C:/snap-doc') && roots1.includes('C:/userData/deepwriter-data'), JSON.stringify(roots1))
    // 运行中修改设置（currentSettings.workDir 变化）→ roots 不漂移（只取快照值）
    const roots2 = buildRollbackRoots({ workDir: 'C:/snap-work', docDir: 'C:/snap-doc' }, fixed)
    check('ROLLBACK-ROOTS-01 快照不变 → roots 不变（不随 currentSettings 漂移）', JSON.stringify(roots2) === JSON.stringify(roots1), '')
    const roots3 = buildRollbackRoots({ workDir: 'C:/changed-work', docDir: 'C:/snap-doc' }, fixed)
    check('ROLLBACK-ROOTS-01 仅当快照变化 roots 才变化（currentSettings 目录不会混入）', roots3.includes('C:/changed-work') && !roots3.includes('C:/current-work'), JSON.stringify(roots3))
    const roots4 = buildRollbackRoots({ workDir: undefined, docDir: undefined }, fixed)
    check('ROLLBACK-ROOTS-01 快照缺目录 → 只剩固定内部目录（fail-closed 不扩权）', roots4.length === fixed.length, JSON.stringify(roots4))
  }

  // ---- CRED-ENGINE-MISSING-01：凭据缺失 → waiting_user/auth_required（非 failed） ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
    const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => EngineLike
    const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
    const createRunStorePort = storePortMod.createRunStorePort as (r: unknown, artifactDir?: string) => Record<string, unknown>
    const repo = createRepository(path.join(tmp, 'cred.db'))
    repo.open()
    const contract = {
      schemaVersion: 1, runId: 'run-cred1', targetChars: { min: 10000, tolerance: 0.05 },
      validators: [{ id: 'targetChars', severity: 'hard', config: {} }, { id: 'noPendingTools', severity: 'hard', config: {} }],
      maxRepairAttempts: 3, createdAt: Date.now()
    }
    const engineCfg = { maxTurns: 4, completionContract: contract, deepWrite: { experiment: { enabled: false, maxConcurrent: 3, subagentTokenRatio: 0.35, characters: [] } } }
    const engine = createAgentRunEngine({
      store: createRunStorePort(repo as never, path.join(tmp, 'art')),
      modelCall: async () => {
        // 模拟 getApi(runId) 按 ref 解析失败（key 已删除/更换）——fail-closed 路径
        throw new CredentialMissingError(null)
      },
      toolExecutor: async () => '',
      getConfig: () => engineCfg,
      onEvent: () => undefined,
      onRunUpdate: () => undefined
    })
    await engine.start({ sessionId: 's-cred1', runId: 'run-cred1', config: engineCfg })
    await engine.step('run-cred1')
    const st = await engine.getState('run-cred1')
    check('CRED-ENGINE-MISSING-01 凭据缺失 → waiting_user + auth_required（fail-closed，非 failed 伪失败）', st.run?.status === 'waiting_user' && st.run?.errorCode === 'auth_required', JSON.stringify(st.run))
    repo.close()
  }

  // ---- CRED-ENGINE-OK-01：正常解析 → 完成 ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
    const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => EngineLike
    const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
    const createRunStorePort = storePortMod.createRunStorePort as (r: unknown, artifactDir?: string) => Record<string, unknown>
    const repo = createRepository(path.join(tmp, 'cred-ok.db'))
    repo.open()
    const contract = {
      schemaVersion: 1, runId: 'run-cred2', targetChars: { min: 10000, tolerance: 0.05 },
      validators: [{ id: 'targetChars', severity: 'hard', config: {} }, { id: 'noPendingTools', severity: 'hard', config: {} }],
      maxRepairAttempts: 3, createdAt: Date.now()
    }
    const engineCfg = { maxTurns: 4, completionContract: contract }
    const engine = createAgentRunEngine({
      store: createRunStorePort(repo as never, path.join(tmp, 'art2')),
      modelCall: async () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string }> {
          yield { type: 'text', delta: 'x'.repeat(12000) }
          yield { type: 'finish', finishReason: 'stop' }
        }
      }),
      toolExecutor: async () => '',
      getConfig: () => engineCfg,
      onEvent: () => undefined,
      onRunUpdate: () => undefined
    })
    await engine.start({ sessionId: 's-cred2', runId: 'run-cred2', config: engineCfg })
    await engine.step('run-cred2')
    const st = await engine.getState('run-cred2')
    check('CRED-ENGINE-OK-01 凭据正常 → run 完成（凭据解析不阻断主链）', st.run?.status === 'completed', JSON.stringify(st.run))
    repo.close()
  }

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n===== R4.5-G5 红灯测试：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('R4.5-G5 运行异常（红灯阶段预期：目标接口尚未实现）:', e instanceof Error ? e.message : String(e))
  process.exitCode = 2
})
