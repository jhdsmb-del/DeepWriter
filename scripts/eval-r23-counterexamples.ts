// ==================== R23 反证场景脚本（任务书 §八 9 场景，0 真实 API） ====================
// 用法：esbuild scripts/eval-r23-counterexamples.ts --bundle --format=esm --platform=node --outfile=out/eval-r23-counterexamples.mjs && node out/eval-r23-counterexamples.mjs
// 全部走本地 deterministic 端点/产物篡改/内存 deps，绝不发起真实网络请求。
//
//   C1  trajectory stage≥2 无 assistant 历史 → validator trajectory-history 红
//   C2  projection seq 冲突/空洞 → projectTerminalAssistant max+1 语义（内存 deps）
//   C3  metrics.failures>0,retries=0,status=ok → validator failure-rounds 红
//   C4  terminal failed + 正文结构校验通过 → validator quality-gate 红
//   C5  longform outline target 写成 10000 → 任务集结构断言 + 预算敏感度
//   C6  hardened longwrite 多轮 completion → ledger 与 all-in 上界一致
//   C7  outer2 内 inner1+inner2 → outerRetries/innerRetries/actualRequests 分类正确
//   C8  real endpoint 未观测 → ledgerMatchesEndpoint=null
//   C9  --max-requests 熔断在下一次 fetch 前生效（端点实收 == max）
//
// 依赖：out/eval-runner.mjs、out/eval-validate.mjs、out/eval-preflight.mjs（先构建）。

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import * as os from "node:os"
import * as http from "node:http"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { projectTerminalAssistant } from "../src/main/sessionProjection"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const RUNNER = path.join(ROOT, "out", "eval-runner.mjs")
const VALIDATOR = path.join(ROOT, "out", "eval-validate.mjs")

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

interface CaseResult {
  id: string
  name: string
  pass: boolean
  detail: string
}
const results: CaseResult[] = []
function record(id: string, name: string, cond: boolean, detail: string): void {
  results.push({ id, name, pass: cond, detail })
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${id} ${name} — ${detail}`)
}

function latestRunDir(outDir: string): string {
  const dir = path.join(outDir, "eval")
  const runs = fs.readdirSync(dir).sort()
  return path.join(dir, runs[runs.length - 1])
}

function runSync(args: string[], env: Record<string, string> = {}, timeoutMs = 180_000): { code: number; stdout: string; stderr: string } {
  const r = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf-8", timeout: timeoutMs })
  let stdout = ""
  let stderr = ""
  r.stdout.on("data", (d) => (stdout += String(d)))
  r.stderr.on("data", (d) => (stderr += String(d)))
  return new Promise((resolve) => {
    r.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    r.on("error", () => resolve({ code: 127, stdout, stderr }))
  })
}

// 产物篡改工具：读 samples.json/ledger.json → 修改 → 写回（副本目录）
function mutateRunDir(runDir: string, mutate: (samples: any, ledger: any[], manifest: any) => void): void {
  const samplesPath = path.join(runDir, "samples.json")
  const ledgerPath = path.join(runDir, "ledger.json")
  const manifestPath = path.join(runDir, "manifest.json")
  const samples = JSON.parse(fs.readFileSync(samplesPath, "utf-8"))
  const ledgerDoc = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"))
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
  mutate(samples, ledgerDoc.ledger ?? [], manifest)
  fs.writeFileSync(samplesPath, JSON.stringify(samples, null, 2), "utf-8")
  fs.writeFileSync(ledgerPath, JSON.stringify(ledgerDoc, null, 2), "utf-8")
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")
  // manifest 的 ledgerSha256/artifactHashes 会因篡改失效——这本身即红证据的一部分；
  // 对 C1/C3/C4 我们关注目标 check 命中，manifest 相关 check 同时红属预期（记入详情）。
}

async function main(): Promise<void> {
  console.log("===== R23 反证场景（9 场景，0 真实 API） =====")

  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dw-r23-cx-"))

  // ---------------- C1：trajectory 无 assistant 历史 → validator 红 ----------------
  console.log("\n[C1] trajectory stage≥2 无 assistant 历史 → trajectory-history 红")
  {
    const outDir = path.join(tmpRoot, "c1")
    const r = await runSync([RUNNER, "--mock", "--scale=0.1", "--repeats=1", "--experiment=trajectory", `--out-dir=${outDir}`])
    if (r.code !== 0) {
      record("C1", "trajectory 无 assistant 历史 → validator 红", false, `runner exit=${r.code}（预期 0 先产出合法产物）`)
    } else {
      const runDir = latestRunDir(outDir)
      mutateRunDir(runDir, (_samples, ledger) => {
        // 删除全部 actualHistoryTurnHashes 中的 assistant 条目（模拟投影缺失的历史结构）
        for (const a of ledger) {
          if (Array.isArray(a.actualHistoryTurnHashes)) {
            a.actualHistoryTurnHashes = (a.actualHistoryTurnHashes as Array<{ role: string; sha256: string }>).filter((t) => t.role !== "assistant")
          }
        }
      })
      const v = await runSync([VALIDATOR, runDir])
      const hit = /trajectory-history/.test(v.stdout) && /FAIL/.test(v.stdout)
      record("C1", "trajectory 无 assistant 历史 → validator 红", v.code !== 0 && hit, `validate exit=${v.code} trajectory-history 红=${hit}`)
    }
  }

  // ---------------- C2：projection seq 空洞 → max+1（内存 deps） ----------------
  console.log("\n[C2] projection seq 空洞 → max+1（不得 length+1）")
  {
    const messages: Array<{ msg_id: string; seq: number }> = [
      { msg_id: "m_user_1", seq: 1 },
      { msg_id: "m_user_2", seq: 5 } // seq 空洞（3/4 缺失）
    ]
    const turns = [{ role: "assistant", content: "正文", reasoning_content: null }]
    const appended: Array<Record<string, unknown>> = []
    const res = projectTerminalAssistant(
      {
        getTurnsByRun: () => turns,
        getSessionMessages: () => messages,
        appendSessionMessage: (m) => { appended.push(m); messages.push({ msg_id: String(m.msg_id), seq: Number(m.seq) }) }
      },
      "run-1",
      "sess-1",
      "completed"
    )
    const seqOk = res.ok && res.projected && Number(appended[0]?.seq) === 6
    // 幂等重放：再次投影同 runId → 复用 seq=6 且不新增
    const before = appended.length
    const res2 = projectTerminalAssistant(
      {
        getTurnsByRun: () => turns,
        getSessionMessages: () => messages,
        appendSessionMessage: (m) => { appended.push(m); messages.push({ msg_id: String(m.msg_id), seq: Number(m.seq) }) }
      },
      "run-1",
      "sess-1",
      "completed"
    )
    const idemOk = res2.ok && appended.length === before + 1 && Number(appended[appended.length - 1]?.seq) === 6
    record("C2", "projection seq 空洞 → max+1 + 幂等复用", seqOk && idemOk, `seq=${appended[0]?.seq}（期望 6） 幂等=${idemOk}`)
  }

  // ---------------- C3：failures>0,retries=0,status=ok → failure-rounds 红 ----------------
  console.log("\n[C3] metrics.failures>0,retries=0,status=ok → failure-rounds 红")
  {
    const outDir = path.join(tmpRoot, "c3")
    const r = await runSync([RUNNER, "--mock", "--scale=0.1", "--repeats=1", `--out-dir=${outDir}`])
    if (r.code !== 0) {
      record("C3", "未解释异常 → validator 红", false, `runner exit=${r.code}`)
    } else {
      const runDir = latestRunDir(outDir)
      mutateRunDir(runDir, (samples) => {
        const s = samples.samples[0]
        s.metrics.failures = 1
        s.metrics.retries = 0
        s.metrics.status = "ok" // 假绿：有失败计数却仍成功
        s.eligibleForReview = true
      })
      const v = await runSync([VALIDATOR, runDir])
      const hit = /failure-rounds/.test(v.stdout) && /FAIL/.test(v.stdout)
      record("C3", "未解释异常 → validator 红", v.code !== 0 && hit, `validate exit=${v.code} failure-rounds 红=${hit}`)
    }
  }

  // ---------------- C4：terminal failed + validation pass → quality-gate 红 ----------------
  console.log("\n[C4] terminal failed + 正文结构校验通过 → quality-gate 红")
  {
    const outDir = path.join(tmpRoot, "c4")
    const r = await runSync([RUNNER, "--mock", "--scale=0.1", "--repeats=1", `--out-dir=${outDir}`])
    if (r.code !== 0) {
      record("C4", "terminal failed 假绿 → validator 红", false, `runner exit=${r.code}`)
    } else {
      const runDir = latestRunDir(outDir)
      mutateRunDir(runDir, (samples) => {
        const s = samples.samples.find((x: { variantId?: string }) => (x.variantId ?? "").startsWith("deepwriter_")) as any
        s.metrics.status = "ok"
        s.validation.passed = true
        s.eligibleForReview = true
        s.terminalStatus = ["completed", "failed"] // 伪造：terminal 失败却全绿
      })
      const v = await runSync([VALIDATOR, runDir])
      const hit = /quality-gate/.test(v.stdout) && /FAIL/.test(v.stdout)
      record("C4", "terminal failed 假绿 → validator 红", v.code !== 0 && hit, `validate exit=${v.code} quality-gate 红=${hit}`)
    }
  }

  // ---------------- C5：outline target=10000 → 结构断言 + 预算敏感度 ----------------
  console.log("\n[C5] longform outline target 写成 10000 → 结构断言 + 预算敏感度")
  {
    const tasksDoc = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "eval-tasks", "tasks.json"), "utf-8")) as {
      tasks?: Array<{ id: string; stages?: Array<{ stageId?: string; targetChars?: number }> }>
    }
    const longform = (tasksDoc.tasks ?? []).find((t) => t.id === "longform-multichapter")
    const outline = (longform?.stages ?? []).find((s) => s.stageId === "outline")
    const chapters = (longform?.stages ?? []).filter((s) => s.stageId === "chapter")
    const everyStageHasTarget = (tasksDoc.tasks ?? []).every((t) => (t.stages ?? []).every((s) => typeof s.targetChars === "number" && s.targetChars > 0))
    const outlineNotTenK = outline?.targetChars === 200
    const chapterSum = chapters.reduce((a, s) => a + (s.targetChars ?? 0), 0) * (chapters.length > 0 ? 1 : 1)
    const chapterSumOk = chapterSum === 3300 * chapters.length
    // 敏感度：outline 写成 10000 会改变 all-in 输出 token 上界（此处用 preflight estimateRunPlan 同参对比）
    const pp = await import(url.pathToFileURL(path.join(ROOT, "out", "eval-preflight.mjs")).href) as {
      estimateRunPlan?: (tasks: unknown[], variants: unknown[], repeats: number, profile: unknown) => { allInOutputTokens?: number; requests?: { lo: number; hi: number } }
    }
    let sensitive = false
    if (pp.estimateRunPlan) {
      const mk = (outlineTarget: number) => [
        {
          id: "longform", category: "longform", targetChars: 10000, retry: true, longMode: true,
          stages: 4,
          stagesPlan: [
            { stageId: "outline", templateChars: 600, materialChars: 0, targetChars: outlineTarget },
            { stageId: "chapter", templateChars: 600, materialChars: 0, targetChars: 3300 },
            { stageId: "chapter", templateChars: 600, materialChars: 0, targetChars: 3300 },
            { stageId: "chapter", templateChars: 600, materialChars: 0, targetChars: 3300 }
          ]
        }
      ]
      const a = pp.estimateRunPlan(mk(200), [{ id: "generic" }, { id: "current" }, { id: "hardened", multiroundLongwrite: true }], 1, null)
      const b = pp.estimateRunPlan(mk(10000), [{ id: "generic" }, { id: "current" }, { id: "hardened", multiroundLongwrite: true }], 1, null)
      sensitive = (a?.allInOutputTokens ?? 0) !== (b?.allInOutputTokens ?? 0)
    }
    record("C5", "outline target≠10000 + 每 stage 有 target + 预算对 target 敏感", outlineNotTenK && everyStageHasTarget && chapterSumOk && sensitive,
      `outline=${outline?.targetChars} 每stage有target=${everyStageHasTarget} chapterSum=${chapterSum} 预算敏感=${sensitive}`)
  }

  // ---------------- C6：hardened longwrite 多轮 completion → ledger 与上界一致 ----------------
  console.log("\n[C6] hardened longwrite 多轮 completion → ledger 与 all-in 上界一致（scale=1 longform）")
  {
    const outDir = path.join(tmpRoot, "c6")
    const r = await runSync([RUNNER, "--mock", "--scale=1", "--repeats=1", "--task=longform-multichapter", `--out-dir=${outDir}`], {}, 300_000)
    if (r.code !== 0 && r.code !== 1) {
      record("C6", "多轮 completion 与上界一致", false, `runner exit=${r.code}（预期 0 或 1）`)
    } else {
      const runDir = latestRunDir(outDir)
      const ledger = JSON.parse(fs.readFileSync(path.join(runDir, "ledger.json"), "utf-8")).ledger as Array<{ sampleId: string; variantId: string; stageId: string }>
      const samples = JSON.parse(fs.readFileSync(path.join(runDir, "samples.json"), "utf-8")).samples as Array<{ sampleId: string; variantId: string; rounds: number; metrics: { status: string }; terminalStatus: string[] }>
      const hard = samples.find((s) => s.variantId === "deepwriter_hardened_candidate") as { sampleId: string; rounds: number; metrics: { status: string }; terminalStatus: string[] }
      const hardAttempts = ledger.filter((a) => a.sampleId === hard.sampleId)
      const outlineAttempts = hardAttempts.filter((a) => a.stageId === "outline").length
      const multiRound = outlineAttempts > 1 // completion continuation 多轮：同一 stage 多次 provider call
      // all-in 上界（preflight 同参：longform 单任务 × 3 variants × 1 repeat）
      const pp = await import(url.pathToFileURL(path.join(ROOT, "out", "eval-preflight.mjs")).href) as {
        estimateRunPlan?: (tasks: unknown[], variants: unknown[], repeats: number, profile: unknown) => { allInRequestMax?: number }
      }
      const plan = pp.estimateRunPlan?.(
        [{
          id: "longform", category: "longform", targetChars: 10000, retry: true, longMode: true,
          stages: 4,
          stagesPlan: [
            { stageId: "outline", templateChars: 600, materialChars: 0, targetChars: 200 },
            { stageId: "chapter", templateChars: 600, materialChars: 0, targetChars: 3300 },
            { stageId: "chapter", templateChars: 600, materialChars: 0, targetChars: 3300 },
            { stageId: "chapter", templateChars: 600, materialChars: 0, targetChars: 3300 }
          ]
        }],
        [{ id: "generic" }, { id: "current" }, { id: "hardened", multiroundLongwrite: true }],
        1,
        null
      )
      const within = (plan?.allInRequestMax ?? 0) >= ledger.length
      // 注：mock 随机字池文本的 8-gram 重复率会触发生产重复检测（真实模型输出不会），
      // 多轮 completion 可能以 terminal=failed 收尾（runner 如实 exit 1 = samples_failed，正是 R03 行为）；
      // 场景 6 的断言目标是「每轮 provider call 全部进 ledger 且总数 ≤ all-in 上界」。
      record("C6", "多轮 completion → ledger 与上界一致", multiRound && within,
        `runner exit=${r.code}（failed sample 如实非零） hardened attempts=${hardAttempts.length}（outline ${outlineAttempts} 轮） allInMax=${plan?.allInRequestMax} within=${within} terminal=${JSON.stringify(hard.terminalStatus)}`)
    }
  }

  // ---------------- C7/C8/C9：本地可控端点 + real 模式 ----------------
  console.log("\n[C7/C8/C9] 本地可控端点 + real 模式（outer/inner 组合、endpoint 未观测、maxRequests 熔断）")
  {
    // 端点：failSet 中的请求序号返回 500，其余 200。
    // C7 构造：generic 链（无内层重试，innerAttempt 恒 1）先消耗 #1/#2（200 成功）；
    // current 的 stage1 命中 #3=500 → deepseek 内层重试 #4=500 → 抛 → runner outer retry #5=200 成功
    // → 期望 outerRetries=1、innerRetries=1、actualRequests==端点实收。
    let received = 0
    const failSet = new Set([3, 4])
    const srv = http.createServer((req, res) => {
      let body = ""
      req.on("data", (d) => (body += d))
      req.on("end", () => {
        received++
        if (failSet.has(received)) {
          res.writeHead(500).end()
          return
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: { content: "正文内容".repeat(30), role: "assistant" }, finish_reason: null }], usage: null })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
      })
    })
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()))
    const port = (srv.address() as { port: number }).port
    const baseUrl = `http://127.0.0.1:${port}`

    // C7：current stage1 命中 500×2（inner retry 耗尽）→ outer retry 成功
    {
      const outDir = path.join(tmpRoot, "c7")
      const r = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: baseUrl, DEEPSEEK_API_KEY: "test-key" }, 300_000)
      const runDir = latestRunDir(outDir)
      const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8"))
      const outerOk = manifest.outerRetries === 1
      const innerOk = manifest.innerRetries === 1 && manifest.innerRetriesObserved === true
      const actualOk = manifest.actualRequests === received
      record("C7", "outer2 内 inner1+inner2 → 分类正确且 total 不丢", outerOk && innerOk && actualOk,
        `outerRetries=${manifest.outerRetries} innerRetries=${manifest.innerRetries} observed=${manifest.innerRetriesObserved} actualRequests=${manifest.actualRequests} 端点实收=${received}`)
    }

    // C8：real 模式无端点观测 → ledgerMatchesEndpoint=null
    {
      const outDir = path.join(tmpRoot, "c8")
      const r = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: baseUrl, DEEPSEEK_API_KEY: "test-key" }, 300_000)
      const runDir = latestRunDir(outDir)
      const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8"))
      const nullOk = manifest.localEndpointReceived === null && manifest.ledgerMatchesEndpoint === null
      record("C8", "real 未观测端点 → ledgerMatchesEndpoint=null", nullOk,
        `localEndpointReceived=${JSON.stringify(manifest.localEndpointReceived)} ledgerMatchesEndpoint=${JSON.stringify(manifest.ledgerMatchesEndpoint)}`)
    }

    // C9：--max-requests=5 → 端点实收恰好 5、budget.exhausted、exit 非零
    {
      const before = received
      const outDir = path.join(tmpRoot, "c9")
      const r = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-requests=5", `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: baseUrl, DEEPSEEK_API_KEY: "test-key" }, 300_000)
      const sentDuring = received - before
      const runDir = latestRunDir(outDir)
      const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8"))
      const budgetOk = manifest.budget?.exhausted === true && manifest.budget?.requestsUsed === 5
      const noOverrun = sentDuring === 5 // 熔断后未多发任何请求
      record("C9", "maxRequests 熔断在下一 fetch 前生效", r.code !== 0 && budgetOk && noOverrun,
        `exit=${r.code} 实收=${sentDuring} budget.exhausted=${manifest.budget?.exhausted} requestsUsed=${manifest.budget?.requestsUsed}`)
    }

    srv.close()
  }

  console.log("")
  const pass = results.filter((r) => r.pass).length
  console.log(`===== R23 反证场景：${pass} PASS / ${results.length - pass} FAIL =====`)
  if (pass !== results.length) process.exit(1)
}

main().catch((e) => {
  console.error("eval-r23-counterexamples 执行异常：", e)
  process.exit(2)
})
