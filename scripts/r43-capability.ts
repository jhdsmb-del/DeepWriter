// ==================== R4.3 Gate 6 红灯回归：provider capability profile（复审 S-04） ====================
// 上下文窗口不再硬编码 1M——按 provider/model capability 解析；未知 provider 用保守上限（不默认 1M）；
// 用户覆盖允许但校验危险值。
// 运行：npx esbuild scripts/r43-capability.ts --bundle --format=esm --platform=node --outfile=out/r43-capability.mjs && node out/r43-capability.mjs

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
      external: ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite'],
      logLevel: 'silent'
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
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r43-cap-'))

  console.log('\n[R4.3-G6] PROVIDER-CAPABILITY：能力解析 + 保守上限 + 覆盖校验')
  const capMod = await loadTsModule('src/main/providerCapability.ts')
  const resolveProviderCapability = capMod.resolveProviderCapability as (
    model: string,
    overrides?: Partial<{ contextWindowTokens: number; maxOutputTokens: number; supportsTools: boolean; supportsThinking: boolean }>
  ) => { contextWindowTokens: number; maxOutputTokens: number; supportsTools: boolean; supportsThinking: boolean }
  const validateCapabilityOverride = capMod.validateCapabilityOverride as (
    o: Partial<{ contextWindowTokens: number; maxOutputTokens: number; supportsTools: boolean; supportsThinking: boolean }>
  ) => { ok: boolean; error?: string }

  const flash = resolveProviderCapability('deepseek-v4-flash')
  check('PROVIDER-CAPABILITY-01 已知模型解析能力（deepseek-v4-flash 1M 上下文）', flash.contextWindowTokens === 1_048_576 && flash.maxOutputTokens > 0 && flash.supportsTools === true, JSON.stringify(flash))
  const unknown = resolveProviderCapability('some-gateway-model-xyz')
  check('PROVIDER-CAPABILITY-01 未知 provider 用保守上限（不默认 1M）', unknown.contextWindowTokens < 1_048_576 && unknown.contextWindowTokens >= 8000, JSON.stringify(unknown))
  check('PROVIDER-CAPABILITY-01 未知 provider 保守输出上限', unknown.maxOutputTokens > 0 && unknown.maxOutputTokens <= 65536, JSON.stringify(unknown))

  const overridden = resolveProviderCapability('deepseek-v4-flash', { contextWindowTokens: 200_000, maxOutputTokens: 16_384 })
  check('PROVIDER-CAPABILITY-01 用户覆盖合并生效', overridden.contextWindowTokens === 200_000 && overridden.maxOutputTokens === 16_384 && overridden.supportsTools === true, JSON.stringify(overridden))

  const bad1 = validateCapabilityOverride({ contextWindowTokens: 1024 })
  check('PROVIDER-CAPABILITY-01 危险值被拒（contextWindow < 8K）', bad1.ok === false, JSON.stringify(bad1))
  const bad2 = validateCapabilityOverride({ maxOutputTokens: 100 })
  check('PROVIDER-CAPABILITY-01 危险值被拒（maxOutput < 256）', bad2.ok === false, JSON.stringify(bad2))
  const bad3 = validateCapabilityOverride({ contextWindowTokens: 999999999 })
  check('PROVIDER-CAPABILITY-01 危险值被拒（超大窗口 > 10M）', bad3.ok === false, JSON.stringify(bad3))
  const good = validateCapabilityOverride({ contextWindowTokens: 200_000 })
  check('PROVIDER-CAPABILITY-01 合法覆盖通过', good.ok === true, JSON.stringify(good))

  // 快照集成：contextPolicy.contextWindowTokens 来自 capability 解析
  const snapMod = await loadTsModule('src/main/executionSnapshot.ts')
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => { contextPolicy: { contextWindowTokens: number; outputReserveTokens: number } }
  const snap = buildExecutionSnapshot({
    payload: { id: 'req-cap', mode: 'agent' },
    settings: { model: 'some-gateway-model-xyz', baseUrl: 'https://gateway.example', maxTokens: 8192, temperature: 1, topP: 1, thinkingEnabled: true, reasoningEffort: 'high', workDir: 'C:/w', docDir: 'C:/d', novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000 },
    sessionId: 's-cap',
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  check('PROVIDER-CAPABILITY-01 快照冻结未知 provider 的保守窗口（不默认 1M）', snap.contextPolicy.contextWindowTokens < 1_048_576, JSON.stringify(snap.contextPolicy))

  // 覆盖经快照 input 生效
  const snap2 = buildExecutionSnapshot({
    payload: { id: 'req-cap2', mode: 'agent' },
    settings: { model: 'some-gateway-model-xyz', baseUrl: 'https://gateway.example', maxTokens: 8192, temperature: 1, topP: 1, thinkingEnabled: true, reasoningEffort: 'high', workDir: 'C:/w', docDir: 'C:/d', novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000, providerCapabilityOverride: { contextWindowTokens: 300_000 } },
    sessionId: 's-cap2',
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  check('PROVIDER-CAPABILITY-01 快照经覆盖合并（300K）', snap2.contextPolicy.contextWindowTokens === 300_000, JSON.stringify(snap2.contextPolicy))

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.3-G6 红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.3-G6 红灯回归执行异常：', e)
  process.exit(2)
})
