// ==================== DeepWriter R19 评测基建 — dry-run / preflight（任务书 §六） ====================
// 不联网打印评测计划：任务数、请求上限（45/90）、输入/输出 token 区间、预计时长、预计费用区间。
// 桥接：scripts/eval-tasks/tasks.json（任务集 v1）→ eval-preflight（估算器）。
// 用法：node out/eval-dryrun.mjs [--repeats=N] [--scale=N] [--price=path]
// 铁律：只读本地文件，不发起任何网络请求；无 price profile 时 cost=unknown。
//
// R19-R02 修复说明：请求数按「逐阶段调用清单」计算（expandStages），不再「一样本=一请求」。
// 5 类任务阶段数：longform=4 / character=6 / style=2 / renpy=1 / failure-recovery=2，合计 15；
// ×3 variants ×repeats → plannedRequests = 45×repeats。
// R05 修复：requests.hi 改为 all-in 上界，覆盖 hardened longwrite 的 completion 多轮（target-derived maxTurns≥4）+ adapter 内层
// 重试（MAX_RETRIES=1）+ runner 外层重试（MAX_ATTEMPTS real=2）；不再单列 inner 于上限之外。

import { readFileSync, existsSync } from "node:fs"
import * as path from "node:path"
import * as url from "node:url"
import { loadEvalTasks } from "./eval-schema"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
interface PreflightMod {
  loadPriceProfile(p?: string): unknown
  priceProfileHash(p: unknown): string
  expandStages(task: { stages: Array<{ stageId: string; repeats?: number }> }): Array<{ stageId: string; n: number }>
  plannedRequests(task: { stages: Array<{ stageId: string; repeats?: number }> }): number
  estimateRunPlan(
    tasks: Array<{
      id: string
      category?: string
      stages: number
      targetChars: number
      retry: boolean
      longMode?: boolean
      stagesPlan?: Array<{ stageId: string; templateChars: number; materialChars: number; targetChars: number }>
    }>,
    variants: Array<{ id: string; multiroundLongwrite?: boolean }>,
    repeats: number,
    profile: unknown
  ): {
    samples: number
    requests: { lo: number; hi: number }
    tokens: { input: { lo: number; hi: number }; output: { lo: number; hi: number } }
    estDurationMinutes: { lo: number; hi: number }
    cost: { currency: string; total: { lo: number; hi: number } } | "unknown"
    assumptions: string[]
    plannedRequests: number
    outerRetriesBudget: number
    innerRetriesBudget: number
    baseProviderCalls: number
    maxCompletionRounds: number
    maxOuterRetryCalls: number
    maxInnerRetryCalls: number
    allInRequestMax: number
    allInInputTokens: { lo: number; hi: number }
    allInOutputTokens: { lo: number; hi: number }
    allInCostCny: { currency: string; total: { lo: number; hi: number } } | "unknown"
    perTask: Array<{
      taskId: string
      variantId: string
      category?: string
      requests: number
      stages: Array<{ stageId: string; historyTokens: number; input: { lo: number; hi: number }; output: { lo: number; hi: number } }>
      input: { lo: number; hi: number }
      output: { lo: number; hi: number }
    }>
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const numArg = (flag: string, dflt: number): number => {
    const hit = args.find((a) => a.startsWith(`${flag}=`))
    const v = Number(hit?.split("=")[1] ?? dflt)
    return Number.isFinite(v) && v >= 0 ? v : dflt
  }
  const repeats = numArg("--repeats", 1)
  const scale = numArg("--scale", 1)
  const pricePath = args.find((a) => a.startsWith("--price="))?.split("=")[1]

  const tasksPath = path.resolve(ROOT, "scripts", "eval-tasks", "tasks.json")
  // R24-P0-01：改走 eval-schema.loadEvalTasks（normalized），不再直接 JSON.parse raw。
  // normalized 后 EvalStage.targetChars 已被 validateTask 校验为 finite 正数并复制进 checkedStages。
  let taskSet: ReturnType<typeof loadEvalTasks>
  try {
    taskSet = loadEvalTasks(tasksPath)
  } catch (e) {
    console.error(`[eval-dryrun] 无法加载任务集 ${tasksPath}：${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }
  const tasks = taskSet.tasks
  if (tasks.length === 0) {
    console.error("[eval-dryrun] 任务集为空")
    process.exit(2)
  }

  const preflight = (await import(url.pathToFileURL(path.resolve(ROOT, "out", "eval-preflight.mjs")).href)) as PreflightMod
  const profile = preflight.loadPriceProfile(pricePath) as { profileId?: string; currency?: string } | null
  const profileHash = profile ? preflight.priceProfileHash(profile) : "none"

  const variants = [
    { id: "generic_baseline" },
    { id: "deepwriter_current_product" },
    { id: "deepwriter_hardened_candidate", multiroundLongwrite: true }
  ]

  const tasksBaseDir = path.dirname(tasksPath)

  // 读素材字符总量（只读本地文件，token 估算用；{content:...}/{material:...} 占位符在运行时注入这些内容）
  const materialCharsOf = (mats: string[]): number => {
    let total = 0
    for (const m of mats) {
      const abs = path.resolve(tasksBaseDir, m)
      if (!existsSync(abs)) continue
      try {
        total += readFileSync(abs, "utf-8").length
      } catch {
        /* 二进制/无权限 → 跳过 */
      }
    }
    return total
  }

  const taskDefs = tasks.map((t) => {
    const stages = t.stages
    const matChars = materialCharsOf(t.materials)
    // 逐阶段展开：repeats 已展开为逐个调用；素材字符只注入第一个调用（大块 {content:...} 通常在首阶段）
    const expanded = preflight.expandStages({ stages: stages.map((s) => ({ stageId: s.stageId, repeats: s.repeats })) })
    const templateByStage = new Map(stages.map((s) => [s.stageId, s.template]))
    const targetByStage = new Map(stages.map((s) => [s.stageId, s.targetChars]))
    // R24-P0-01：逐 stage 估算用 normalized stages[].targetChars（loadEvalTasks 已 fail-closed 校验为 finite 正数）。
    // stage.targetChars 是 scale 缩放前目标，这里只做 × scale；不再有 expectMinChars / task 级均摊兜底。
    const stagesPlan = expanded.map((e, i) => {
      const templateChars = (templateByStage.get(e.stageId) ?? "").length
      const stageTarget = targetByStage.get(e.stageId)
      const targetChars = Math.max(0, Math.round((stageTarget ?? 0) * scale))
      // 素材仅注入首调用（避免同一素材在每轮重复计）
      const materialChars = i === 0 ? matChars : 0
      return { stageId: `${e.stageId}${e.n > 1 ? `#${e.n}` : ""}`, templateChars, materialChars, targetChars }
    })
    return {
      id: t.id,
      category: t.category,
      stages: Math.max(1, stages.length),
      targetChars: Math.max(0, Math.round(t.targetChars * scale)),
      retry: true,
      longMode: t.longMode === true,
      stagesPlan
    }
  })

  const plan = preflight.estimateRunPlan(taskDefs, variants, repeats, profile)

  console.log("===== eval dry-run（不联网，仅估算） =====")
  console.log(`任务集: ${taskSet.id} (schemaVersion=${taskSet.schemaVersion})，${tasks.length} 任务 × 3 variants × ${repeats} repeats，scale=${scale}`)
  console.log(`样本数: ${plan.samples}（task×variant 实验单元）`)
  console.log(`理想请求数: ${plan.plannedRequests}（= 逐阶段调用数 × variants × repeats）`)
  console.log(`请求数区间: [${plan.requests.lo}, ${plan.requests.hi}]（lo=planned；hi=all-in 上界，见下）`)
  console.log("")
  console.log("=== R05 all-in 请求与费用上界 ===")
  console.log(`baseProviderCalls: ${plan.baseProviderCalls}（= plannedRequests，每 stage 基础 1 次 × variants × repeats）`)
  console.log(`maxCompletionRounds: ${plan.maxCompletionRounds}（hardened longwrite 每 stage maxTurns=min(128,max(4,ceil(targetChars/1000)))；current=6、generic=1/轮）`)
  console.log(`maxOuterRetryCalls: ${plan.maxOuterRetryCalls}（runner MAX_ATTEMPTS real=2 → 每 stage 额外重跑全部 completion 轮 1 次）`)
  console.log(`maxInnerRetryCalls: ${plan.maxInnerRetryCalls}（adapter MAX_RETRIES=1 → 每 provider call 额外 1 次）`)
  console.log(`allInRequestMax: ${plan.allInRequestMax}（= Σ_stage [rounds × (1+inner) × (1+outer)] × variants × repeats）`)
  console.log(`requests.hi == allInRequestMax: ${plan.requests.hi === plan.allInRequestMax ? "YES" : "NO"}（${plan.requests.hi} vs ${plan.allInRequestMax}）`)
  console.log(`all-in 输入 token: [${plan.allInInputTokens.lo.toLocaleString()}, ${plan.allInInputTokens.hi.toLocaleString()}]`)
  console.log(`all-in 输出 token: [${plan.allInOutputTokens.lo.toLocaleString()}, ${plan.allInOutputTokens.hi.toLocaleString()}]`)
  if (plan.allInCostCny === "unknown") {
    console.log(`all-in 费用: unknown（无 price profile 或不支持的单位）`)
  } else {
    console.log(`all-in 费用(CNY): [${plan.allInCostCny.total.lo}, ${plan.allInCostCny.total.hi}]`)
  }
  console.log("")
  console.log("逐任务请求明细（每 variant 阶段调用数）：")
  for (const t of taskDefs) {
    const cnt = t.stagesPlan?.length ?? 0
    console.log(`  ${t.id}  (${t.category ?? "-"}): ${cnt} 次/variant  → ×3 variants ×${repeats} repeats = ${cnt * 3 * repeats}`)
  }
  console.log("")
  console.log("=== stage targets parity（dryrun 逐 stage 目标 vs normalized stages[].targetChars × scale） ===")
  // 打印每 stage 的 target（runner 口径一致）；并核对与 normalized stages[].targetChars×scale 一致。
  // R24-P0-01：stages[].targetChars 来自 loadEvalTasks 的 normalized EvalStage（必填 finite 正数），
  // 与上面 stagesPlan 的 per-stage target 完全同源（不再经过 expectMinChars/task 均摊兜底）。
  let parityAllOk = true
  for (const t of tasks) {
    const stages = t.stages
    for (const s of stages) {
      const sid = s.stageId
      const rawTarget = s.targetChars
      const expected = Math.round(rawTarget * scale)
      const planEntry = taskDefs.find((d) => d.id === t.id)?.stagesPlan?.find((p) => p.stageId === sid || p.stageId.startsWith(sid + "#"))
      const planTarget = planEntry?.targetChars
      const ok = planTarget === expected
      if (planTarget !== expected) parityAllOk = false
      console.log(`  ${t.id}.${sid}: targetChars=${rawTarget} × scale=${scale} → ${expected}；dryrun 估算 target=${planTarget ?? "?"}  [${ok ? "OK" : "MISMATCH"}]`)
    }
  }
  console.log(`  stage targets parity: ${parityAllOk ? "ALL OK" : "MISMATCH/FALLBACK"}`)
  console.log("")
  console.log(`输入 token 区间(base): [${plan.tokens.input.lo.toLocaleString()}, ${plan.tokens.input.hi.toLocaleString()}]`)
  console.log(`输出 token 区间(base): [${plan.tokens.output.lo.toLocaleString()}, ${plan.tokens.output.hi.toLocaleString()}]`)
  console.log(`预计时长: ${plan.estDurationMinutes.lo}–${plan.estDurationMinutes.hi} 分钟（吞吐假设见下）`)
  if (plan.cost === "unknown") {
    console.log(`预计费用(base): unknown（无 price profile 或不支持的单位）`)
  } else {
    console.log(`预计费用(base): ${plan.cost.currency} [${plan.cost.total.lo}, ${plan.cost.total.hi}]`)
  }
  console.log(`price profile: ${profile?.profileId ?? "无"} (hash=${profileHash.slice(0, 12)}…)`)
  console.log("")
  console.log("逐任务逐阶段 token 明细（首个 variant 抽样，展示累积 transcript）：")
  const seen = new Set<string>()
  for (const pt of plan.perTask) {
    if (seen.has(pt.taskId)) continue
    seen.add(pt.taskId)
    const first = pt.stages[0]
    const last = pt.stages[pt.stages.length - 1]
    console.log(`  ${pt.taskId}: ${pt.stages.length} 阶段 | 首阶段 input=[${first.input.lo},${first.input.hi}] hist=0 | 末阶段 input=[${last.input.lo},${last.input.hi}] hist=${last.historyTokens} | 任务 input=[${pt.input.lo},${pt.input.hi}] output=[${pt.output.lo},${pt.output.hi}]`)
  }
  console.log("")
  console.log("假设：")
  for (const a of plan.assumptions) console.log(`  - ${a}`)
  console.log("说明：以上为估算区间，不是实际使用量；实际以运行 manifest 与 provider usage 原值为准。")
  console.log("      requests.hi 为 all-in 上界（含 completion 多轮 + outer + inner retry）。")
  console.log("      generic 变体缺 stream_options.include_usage 时真实服务可能不返回 usage（usageStatus=missing→cost=unknown，绝不写 0），该字段由 S1 补。")
}

main().catch((e) => {
  console.error("eval-dryrun 执行异常：", e)
  process.exit(2)
})
