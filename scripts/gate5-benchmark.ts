// ==================== Gate 5：Benchmark 模式可信度（任务一） ====================
// 验证：
// 1. real runner 未实现时，任何非 --mock 调用必须非零退出且不生成报告（有无 key 都一样）
// 2. mock 结果必须 mode=mock，所有性能/Token/质量 Gate 为 false（N/A），不得为 true
// 3. mock 使用固定 seed，--seed 相同则结果可复现
// 运行：npx esbuild scripts/gate5-benchmark.ts --bundle --format=esm --platform=node --outfile=out/gate5.mjs && node out/gate5.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'out')
const MOCK_REPORT = path.join(OUT, 'benchmark-pipeline-mock.md')
const MOCK_JSON = path.join(OUT, 'benchmark-pipeline-mock.json')

function runBenchmark(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(OUT, 'benchmark.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 60000
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

async function main(): Promise<void> {
  // 先构建 benchmark.mjs
  const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }
  await esbuild.build({ entryPoints: [path.join(ROOT, 'scripts', 'benchmark.ts')], bundle: true, format: 'esm', platform: 'node', target: 'node20', write: true, outfile: path.join(OUT, 'benchmark.mjs'), logLevel: 'silent' })

  // 清理旧报告
  for (const f of [MOCK_REPORT, MOCK_JSON, path.join(ROOT, 'docs', 'BENCHMARK_PIPELINE_MOCK.md'), path.join(ROOT, 'docs', 'BENCHMARK_RESULTS.md')]) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* 不存在 */
    }
  }

  console.log('\n[G5-1] real runner 未实现：非 --mock 调用必须拒绝（无 key）')
  const r1 = runBenchmark(['--repeats=1'])
  check('无 --mock 无 key → 非零退出', r1.code !== 0, `code=${r1.code}`)
  check('无 --mock 无 key → 不生成 mock 报告文件', !fs.existsSync(MOCK_REPORT) && !fs.existsSync(MOCK_JSON))
  check('无 --mock 无 key → 不生成 real 报告文件', !fs.existsSync(path.join(ROOT, 'docs', 'BENCHMARK_RESULTS.md')))

  console.log('\n[G5-2] real runner 未实现：非 --mock 调用必须拒绝（有 key 也拒绝）')
  const r2 = runBenchmark(['--repeats=1'], { DEEPSEEK_API_KEY: 'sk-test-not-real' })
  check('无 --mock 有 key → 非零退出', r2.code !== 0, `code=${r2.code}`)
  check('无 --mock 有 key → 不生成任何报告', !fs.existsSync(MOCK_REPORT) && !fs.existsSync(MOCK_JSON))
  check('拒绝信息明确（不输出随机运行）', r2.stderr.includes('real') || r2.stdout.includes('real') || r2.stdout.includes('拒绝'), `${r2.stdout.slice(0, 120)} ${r2.stderr.slice(0, 120)}`)

  console.log('\n[G5-3] --mock：生成 mock 报告且 Gate 全为 N/A（不得 true）')
  const r3 = runBenchmark(['--mock', '--repeats=2'])
  check('--mock 正常退出 0', r3.code === 0, `code=${r3.code} ${r3.stderr.slice(0, 200)}`)
  check('mock JSON 报告生成', fs.existsSync(MOCK_JSON))
  check('mock Markdown 报告生成（out/benchmark-pipeline-mock.md）', fs.existsSync(MOCK_REPORT))
  const json = JSON.parse(fs.readFileSync(MOCK_JSON, 'utf-8')) as { mode: string; gates: { timeReduction20: boolean; tokenReduction25: boolean; qualityNonInferior: boolean | null; claimAllowed: string } }
  check('报告 mode=mock', json.mode === 'mock', `mode=${json.mode}`)
  check('Gate timeReduction20 不得为 true', json.gates.timeReduction20 === false, `=${json.gates.timeReduction20}`)
  check('Gate tokenReduction25 不得为 true', json.gates.tokenReduction25 === false, `=${json.gates.tokenReduction25}`)
  check('质量 Gate 为 null（未执行）', json.gates.qualityNonInferior === null, `=${json.gates.qualityNonInferior}`)
  check('claimAllowed 明确禁止（mock 无结论）', /mock|禁止|N\/A|不代表/i.test(json.gates.claimAllowed), json.gates.claimAllowed)

  console.log('\n[G5-4] --mock 固定 seed：结果可复现')
  const r4a = runBenchmark(['--mock', '--repeats=2', '--seed=42'])
  const j4a = JSON.parse(fs.readFileSync(MOCK_JSON, 'utf-8')) as { runs: { totalMs: number }[] }
  const r4b = runBenchmark(['--mock', '--repeats=2', '--seed=42'])
  const j4b = JSON.parse(fs.readFileSync(MOCK_JSON, 'utf-8')) as { runs: { totalMs: number }[] }
  check('同 seed 两次运行 runs 完全一致', JSON.stringify(j4a.runs) === JSON.stringify(j4b.runs))
  check('--mock 两次运行退出码 0', r4a.code === 0 && r4b.code === 0, `${r4a.code}/${r4b.code}`)

  console.log(`\n===== Gate 5 Benchmark 可信度结果：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Gate 5 执行异常：', e)
  process.exit(2)
})
