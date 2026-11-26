// ==================== DeepWriter Benchmark（Gate 5） ====================
// 用法：
//   node out/benchmark.mjs --mock [--seed 42] [--repeats 3]   # 本地 mock 管道基准（可复现，无性能结论）
//   node out/benchmark.mjs                                    # real 模式：runner 未实现，一律拒绝退出
//
// 输出（mock）：out/benchmark-pipeline-mock.json + docs/BENCHMARK_PIPELINE_MOCK.md
//
// 可信度铁律（任务一）：
// - real runner 未实现前，任何非 --mock 调用立即非零退出，不生成任何报告；
// - mock 结果单独输出，所有性能/Token/质量 Gate 为 N/A（false/null），不得为 true；
// - mock 使用固定 seed（--seed 可覆盖），结果可复现；
// - 禁止把随机 mock 数值写成性能提升结论。

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** mulberry32：固定 seed 的确定性伪随机（可复现） */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------- 指标结构 ----------------

export interface RunMetrics {
  taskId: string
  strategy: string
  repeat: number
  startedAt: number
  ttftMs: number | null
  totalMs: number
  stableTokPerSec: number | null
  effectiveCharsPerSec: number | null
  chars: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  reasoningTokens: number
  toolRounds: number
  retries: number
  adopted: boolean
  humanEditsRatio: number | null
  factErrors: number | null
  continuityErrors: number | null
  error?: string
}

export interface BenchmarkReport {
  schemaVersion: 1
  generatedAt: string
  mode: 'mock' | 'real'
  model: string
  baseUrl: string
  taskSet: string[]
  strategies: string[]
  runs: RunMetrics[]
  summary: Record<string, {
    ttftP50: number | null
    ttftP95: number | null
    totalP50: number | null
    tokPerSecP50: number | null
    charsPerSecP50: number | null
    cacheMissOutputP50: number | null
    toolRoundsP50: number | null
    retriesTotal: number
    medianImprovementVsBaseline: number | null
  }>
  gates: {
    timeReduction20: boolean
    tokenReduction25: boolean
    qualityNonInferior: boolean | null
    claimAllowed: string
  }
}

// ---------------- 任务集 ----------------

export const TASK_SET = {
  novel: { id: 'novel-scene', desc: '中文长篇小说场景生成（目标 2000 字，场景卡+人物状态+伏笔上下文）', targetChars: 2000, system: '你是中文小说场景生成器。只输出场景正文，不输出分析。' },
  style: { id: 'style-candidate', desc: '风格参考候选生成（画像规则+exemplar，目标 800 字）', targetChars: 800, system: '你是风格化文本生成器。严格按画像规则输出候选正文。' },
  agent: { id: 'agent-tool-loop', desc: 'Agent 工具循环（读取文件→修改→总结）', targetChars: 0, system: '你是文件操作助手。使用工具完成任务，输出简短总结。' }
} as const

export type TaskKey = keyof typeof TASK_SET

// ---------------- 指标计算 ----------------

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return Math.round(sorted[idx])
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

export function buildReport(runs: RunMetrics[], mode: 'mock' | 'real', model: string, baseUrl: string, taskIds: string[], strategies: string[]): BenchmarkReport {
  const byStrategy: Record<string, RunMetrics[]> = {}
  for (const r of runs) (byStrategy[r.strategy] ??= []).push(r)
  const summary: BenchmarkReport['summary'] = {}
  for (const [strategy, rs] of Object.entries(byStrategy)) {
    summary[strategy] = {
      ttftP50: percentile(rs.map((r) => r.ttftMs ?? 0).sort((a, b) => a - b), 50),
      ttftP95: percentile(rs.map((r) => r.ttftMs ?? 0).sort((a, b) => a - b), 95),
      totalP50: median(rs.map((r) => r.totalMs)),
      tokPerSecP50: median(rs.map((r) => r.stableTokPerSec ?? 0)),
      charsPerSecP50: median(rs.map((r) => r.effectiveCharsPerSec ?? 0)),
      cacheMissOutputP50: median(rs.map((r) => r.cacheMissTokens + r.outputTokens)),
      toolRoundsP50: median(rs.map((r) => r.toolRounds)),
      retriesTotal: rs.reduce((a, r) => a + r.retries, 0),
      medianImprovementVsBaseline: null
    }
  }
  // 相对基线策略（strategy === 'baseline'）的中位总耗时下降率
  const base = summary['baseline']?.totalP50
  if (base && base > 0) {
    for (const [strategy, s] of Object.entries(summary)) {
      if (strategy === 'baseline' || s.totalP50 === null) continue
      s.medianImprovementVsBaseline = Math.round(((base - s.totalP50) / base) * 1000) / 10
    }
  }
  const timeReduction20 = mode === 'real' && Object.values(summary).some((s) => (s.medianImprovementVsBaseline ?? -Infinity) >= 20)
  const tokenReduction25 = mode === 'real' && Object.values(summary).some((s) => {
    const b = summary['baseline']?.cacheMissOutputP50
    return b !== null && b > 0 && s.cacheMissOutputP50 !== null && (b - s.cacheMissOutputP50) / b >= 0.25
  })
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    model,
    baseUrl,
    taskSet: taskIds,
    strategies: Object.keys(summary),
    runs,
    summary,
    gates: {
      timeReduction20,
      tokenReduction25,
      qualityNonInferior: null,
      claimAllowed:
        mode === 'mock'
          ? 'mock 管道数据不代表真实性能：所有性能/Token/质量 Gate 为 N/A；真实结论需 real runner + 冻结数据集 + 人类盲评'
          : '仅当 (timeReduction20 或 tokenReduction25) 且质量非劣（人类盲评 ≤2pp 下降）才可写"显著更快/更省"；否则如实保留实验标签'
    }
  }
}

// ---------------- Mock 管道（验证框架与指标，不测模型质量） ----------------

function mockRun(taskId: string, strategy: string, repeat: number, targetChars: number, rand: () => number): RunMetrics {
  // startedAt 固定为 0（synthetic：不依赖真实时钟，保证同 seed 完全可复现）
  const startedAt = 0
  const ttftMs = 40 + Math.floor(rand() * 120)
  const perCharMs = strategy === 'baseline' ? 3.2 : strategy === 'memorypack' ? 2.4 : 2.8
  const chars = Math.min(targetChars, Math.max(200, Math.round(targetChars * (0.9 + rand() * 0.2))))
  const totalMs = ttftMs + chars * perCharMs
  const outputTokens = Math.round(chars * 0.9)
  const cacheMissTokens = strategy === 'baseline' ? Math.round(chars * 1.8) : Math.round(chars * 1.1)
  return {
    taskId,
    strategy,
    repeat,
    startedAt,
    ttftMs,
    totalMs,
    stableTokPerSec: Math.round((outputTokens / (totalMs / 1000)) * 10) / 10,
    effectiveCharsPerSec: Math.round((chars / (totalMs / 1000)) * 10) / 10,
    chars,
    inputTokens: Math.round(chars * 0.5),
    outputTokens,
    cacheHitTokens: 0,
    cacheMissTokens,
    reasoningTokens: 0,
    toolRounds: strategy === 'agent-full' ? 3 : 0,
    retries: rand() < 0.1 ? 1 : 0,
    adopted: true,
    humanEditsRatio: null,
    factErrors: null,
    continuityErrors: null
  }
}

// ---------------- CLI ----------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const isMock = args.includes('--mock')
  const repeats = Number(args.find((a) => a.startsWith('--repeats='))?.split('=')[1] ?? 3)
  const seed = Number(args.find((a) => a.startsWith('--seed='))?.split('=')[1] ?? 20260811)
  const taskKey = (args.find((a) => a.startsWith('--task='))?.split('=')[1] ?? 'novel') as TaskKey
  const strategies = args.includes('--all-strategies') ? ['baseline', 'memorypack', 'agent-full'] : ['baseline', 'memorypack']
  const task = TASK_SET[taskKey]
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

  // 任务一铁律：real runner 未实现前，非 --mock 一律拒绝，不生成任何报告（有无 key 都一样）
  if (!isMock) {
    console.error('[benchmark] real runner 尚未实现：拒绝执行。请使用 --mock（管道自测）或等待 real runner 接入。')
    console.error('[benchmark] 未生成任何报告；禁止把 synthetic 数据标记为 real。')
    process.exit(2)
  }

  const rand = seededRandom(seed)
  console.log(`Benchmark(mock): task=${task.id} repeats=${repeats} strategies=${strategies.join(',')} seed=${seed}（synthetic，无性能结论）`)

  const runs: RunMetrics[] = []
  for (const strategy of strategies) {
    for (let r = 1; r <= repeats; r++) {
      const m = mockRun(task.id, strategy, r, task.targetChars, rand)
      runs.push(m)
      console.log(`  run ${strategy}#${r}: total=${m.totalMs}ms ttft=${m.ttftMs}ms chars=${m.chars} tok/s=${m.stableTokPerSec}`)
    }
  }

  const report = buildReport(runs, 'mock', model, baseUrl, [task.id], strategies)
  const outDir = path.resolve(__dirname, '..', 'out')
  await fsp.mkdir(outDir, { recursive: true })
  await fsp.writeFile(path.join(outDir, 'benchmark-pipeline-mock.json'), JSON.stringify(report, null, 2), 'utf-8')

  // Markdown 报告（mock 独立文件名，禁止覆盖 real 报告位）
  const lines = ['# Benchmark 管道自测（mock，synthetic）', '', `> 生成：${report.generatedAt} · 模式：${report.mode} · seed：${seed} · 模型占位：${report.model}`, '> **本报告由固定 seed 随机数据生成，不代表任何真实性能/Token/质量结论。**', '', '## 汇总（P50，synthetic）', '', '| 策略 | TTFT p50 | TTFT p95 | 总耗时 p50 | tok/s | 汉字/s | cache-miss+output | 工具轮数 | 重试 |', '|---|---|---|---|---|---|---|---|---|']
  for (const [s, v] of Object.entries(report.summary)) {
    lines.push(`| ${s} | ${v.ttftP50 ?? '—'}ms | ${v.ttftP95 ?? '—'}ms | ${v.totalP50 ?? '—'}ms | ${v.tokPerSecP50 ?? '—'} | ${v.charsPerSecP50 ?? '—'} | ${v.cacheMissOutputP50 ?? '—'} | ${v.toolRoundsP50 ?? '—'} | ${v.retriesTotal} |`)
  }
  lines.push('', '## 发布声明门槛', `- 总耗时下降 ≥20%：N/A（mock）`, `- cache-miss+output 下降 ≥25%：N/A（mock）`, `- 质量非劣（人类盲评 ≤2pp）：未执行`, `- ${report.gates.claimAllowed}`, '')
  await fsp.writeFile(path.join(outDir, 'benchmark-pipeline-mock.md'), lines.join('\n'), 'utf-8')
  console.log('written out/benchmark-pipeline-mock.json + out/benchmark-pipeline-mock.md（synthetic，无性能结论；不污染工作树）')
}

main().catch((e) => {
  console.error('benchmark 执行异常：', e)
  process.exit(1)
})
