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

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function loadTsModule(relativePath: string, external: string[] = []): Promise<Record<string, unknown>> {
  const entry = path.resolve(__dirname, '..', relativePath)
  const outfile = path.resolve(__dirname, '..', 'out', `r51-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'node20', write: true, outfile, external, logLevel: 'silent' })
    return await import(url.pathToFileURL(outfile).href) as Record<string, unknown>
  } finally {
    await fsp.unlink(outfile).catch(() => undefined)
  }
}

async function main(): Promise<void> {
  const capabilityModule = await loadTsModule('src/main/providerCapability.ts')
  const resolve = capabilityModule.resolveRegistryContextCapability as (input: Record<string, unknown>) => { maxContextTokens: number | null; outputReserveTokens: number; contextSource: string }
  const builtinRow = {
    providerKind: 'builtin', adapterId: 'builtin.deepseek', remoteModelId: 'deepseek-v4-flash',
    declaredContextWindow: null, declaredMaxOutputTokens: null, profileMaxOutputTokens: 65536, settingsMaxOutputTokens: 8192
  }
  const current = resolve(builtinRow)
  check('R51 当前 registry 行（builtin DeepSeek + context_window=NULL）恢复 1M 能力', current.maxContextTokens === 1_048_576, JSON.stringify(current))
  check('R51 当前 registry 行可生成 ready 预览预算', current.maxContextTokens !== null && current.maxContextTokens > current.outputReserveTokens, JSON.stringify(current))

  const customRow = { ...builtinRow, providerKind: 'custom', adapterId: 'custom.openai-compatible-chat' }
  const customUnknown = resolve(customRow)
  check('R51 自定义 Provider 同名模型不继承内置 1M', customUnknown.maxContextTokens === null, JSON.stringify(customUnknown))
  check('R51 未知能力保持 fail-closed', customUnknown.contextSource === 'unknown', JSON.stringify(customUnknown))
  const chatBudget = resolve({ ...customRow, allowConservativeFallback: true })
  check('自定义普通对话使用有限运行预算，不伪造模型规格', chatBudget.maxContextTokens === 8192 && chatBudget.outputReserveTokens === 2048 && chatBudget.contextSource === 'conservative_default', JSON.stringify(chatBudget))
  const smallWindow = resolve({ ...customRow, declaredContextWindow: 8192, declaredMaxOutputTokens: 4096, settingsMaxOutputTokens: 32768, profileMaxOutputTokens: null, allowConservativeFallback: true })
  check('小窗口模型输出预留保留输入空间', smallWindow.outputReserveTokens === 4096 && smallWindow.maxContextTokens === 8192, JSON.stringify(smallWindow))
  const lowOutput = resolve({ ...customRow, declaredContextWindow: 32768, declaredMaxOutputTokens: 1024, allowConservativeFallback: true })
  check('预览输出预留不超过模型声明上限', lowOutput.outputReserveTokens === 1024, JSON.stringify(lowOutput))
  const userLimit = resolve({ ...customRow, allowConservativeFallback: true, override: { maxOutputTokens: 512 } })
  check('旧全局输出覆盖不改写自动模型预算', userLimit.outputReserveTokens === 2048, JSON.stringify(userLimit))

  const declaredWins = resolve({ ...customRow, declaredContextWindow: 65536, override: { contextWindowTokens: 200000 } })
  check('R51 Provider 明确声明优先于 settings 覆盖', declaredWins.maxContextTokens === 65536 && declaredWins.contextSource === 'model_declaration', JSON.stringify(declaredWins))
  const overridden = resolve({ ...customRow, override: { contextWindowTokens: 200000 } })
  check('旧全局窗口覆盖不能替无声明模型伪造规格', overridden.maxContextTokens === null && overridden.contextSource === 'unknown', JSON.stringify(overridden))
  const invalidOverride = resolve({ ...customRow, override: { contextWindowTokens: 1024 } })
  check('R51 非法 settings 覆盖不会放宽未知模型', invalidOverride.maxContextTokens === null, JSON.stringify(invalidOverride))
  const cappedOutput = resolve({ ...builtinRow, override: { maxOutputTokens: 16384 } })
  check('模型 Profile 的输出预算优先于旧全局覆盖', cappedOutput.outputReserveTokens === 65536, JSON.stringify(cappedOutput))

  const contextModule = await loadTsModule('src/main/contextV2.ts', ['node:sqlite'])
  const ContextV2Service = contextModule.ContextV2Service as new (dbPath: string) => { preview(input: Record<string, unknown>): { budget: { status: string } }; close(): void }
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r51-context-cap-'))
  const service = new ContextV2Service(path.join(tempDir, 'deepwriter.db'))
  try {
    const ready = service.preview({ sessionId: 'r51-current', mode: 'optimized', draftText: '正文', attachments: [], maxContextTokens: current.maxContextTokens, outputReserveTokens: current.outputReserveTokens, capabilityFingerprint: 'r51', requiredPrefix: [], requiredAliases: [], prefixHash: '' })
    check('R51 当前 registry 行进入 ContextV2 后状态为 ready', ready.budget.status === 'ready', JSON.stringify(ready.budget))
    const unknown = service.preview({ sessionId: 'r51-custom', mode: 'optimized', draftText: '正文', attachments: [], maxContextTokens: customUnknown.maxContextTokens, outputReserveTokens: customUnknown.outputReserveTokens, capabilityFingerprint: 'r51', requiredPrefix: [], requiredAliases: [], prefixHash: '' })
    check('R51 自定义未知能力进入 ContextV2 后保持 unknown', unknown.budget.status === 'unknown', JSON.stringify(unknown.budget))
  } finally {
    service.close()
    await fsp.rm(tempDir, { recursive: true, force: true })
  }

  console.log(`\n===== R51 context capability：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('R51 context capability 执行异常：', error)
  process.exit(2)
})
