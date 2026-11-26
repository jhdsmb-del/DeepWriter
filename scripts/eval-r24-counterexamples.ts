// ==================== R24 反证场景脚本（任务书 §二/§三 + 矩阵第 5/8/9 项，0 真实 API） ====================
// 构建：esbuild scripts/eval-r24-counterexamples.ts --bundle --format=esm --platform=node --outfile=out/eval-r24-counterexamples.mjs
// 运行：node out/eval-r24-counterexamples.mjs
// 全部走本地 deterministic HTTP 端点/产物篡改/内存 deps，绝不发起真实网络请求。
//
//   C1  stage-targets 全链：runner mock scale=0.1 longform → manifest.stageTargets（outline=200, chapter=3300×3）+ validator PASS；篡改 201 → validator stage-targets 红
//   C2  stageTargetsHash 篡改 → validator stage-targets 红
//   C3  scale=0.1 执行 target：manifest.stageTargets 保持 unscaled（200/3300），样本正常产出
//   C4  多轮一致性：compose(turns).content == measuredChars == 投影正文（A+B+C=12000 无分隔）
//   C5  费用小数解析：--max-cost-cny=0.01 → manifest.budget.maxCostCny === 0.01（不得变 null）
//   C6a cap=0.001 < 单请求预留 → fetch 前拒发（spent=0 即熔断）
//   C6b 端点超发（10 元）→ 对账后立即停止（实收 1，不静默继续）
//   C7  cap 只够 1 个 reservation → 实收恰 1（repeats=2 同 stage 预留相同 → 区间存在；二分逼近）
//   C8  usage 缺失 fail-closed：第 1 个请求后 costKnown=false → 第 2 个被拒，实收恰 1
//   C9  inner retry 重新 reserve：failSet 触发 inner retry，retry 请求计入 requestsUsed 且 reservation 对账后 reservedCny≈0
//   C10 retry 指标事实化：deepwriter stage 失败一次（terminal=failed）→ metrics.failures>=1 且 retries>=1（真实下一 attempt），样本最终 ok
//   C11 trajectory retry 隔离：attempt1 部分正文后断流失败、attempt2 成功 → 下一 stage 历史不含 attempt1 的 partial assistant hash
//   C12 real 未观测端点 → ledgerMatchesEndpoint=null

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import * as os from "node:os"
import * as http from "node:http"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { priceProfileHash, type PriceProfile } from "./eval-preflight"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const require = createRequire(import.meta.url)
const esbuild = require("esbuild") as { build(opts: Record<string, unknown>): Promise<unknown> }

const RUNNER = path.join(ROOT, "out", "eval-runner.mjs")
const VALIDATOR = path.join(ROOT, "out", "eval-validate.mjs")
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

interface CaseResult { id: string; name: string; pass: boolean; detail: string }
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

/** R25-P0-01：费用探针的可信临时价格 profile（绑定本机探针 origin，允许本地端点跑 cost cap）。 */
function writeTrustedProfile(port: number, dir: string, profileId = "r24-probe-trusted"): string {
  const p = path.join(dir, `profile-${port}.json`)
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: 1,
    profileId,
    providerId: "probe-provider",
    endpointOrigins: [`http://127.0.0.1:${port}`],
    currency: "CNY",
    unit: "per-1M-tokens",
    source: "R24 counterexamples local probe",
    updatedAt: "2026-08-16",
    prices: [{ model: "deepseek-v4-flash", inputPer1M: 2.0, outputPer1M: 8.0, cacheHitPer1M: 0.4 }]
  }, null, 2), "utf-8")
  return p
}

function runSync(args: string[], env: Record<string, string> = {}, timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string }> {
  // Only this suite's explicit loopback synthetic fixtures authorize a price hash; never a real provider file.
  const authorizedArgs = [...args]
  const profilePath = args.find((arg) => arg.startsWith("--price-profile="))?.slice("--price-profile=".length)
  if (args[0] === RUNNER && profilePath) {
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as PriceProfile
    if (profile.providerId === "probe-provider" && profile.source === "R24 counterexamples local probe" && profile.endpointOrigins.every((origin) => /^http:\/\/127\.0\.0\.1:\d+$/.test(origin))) {
      authorizedArgs.push(`--trust-price-profile-hash=${priceProfileHash(profile)}`, "--pricing-provider-id=probe-provider")
    }
  }
  return new Promise((resolve) => {
    const r = spawn(process.execPath, authorizedArgs, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf-8", timeout: timeoutMs })
    let stdout = ""
    let stderr = ""
    r.stdout.on("data", (d) => (stdout += String(d)))
    r.stderr.on("data", (d) => (stderr += String(d)))
    r.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    r.on("error", () => resolve({ code: 127, stdout, stderr }))
  })
}

/** 本地可控 SSE 端点：按策略返回 200（可选 usage 注入）/500/断流 */
function startEndpoint(opts: {
  failSet?: Set<number>
  textBytes?: number
  hugeUsage?: boolean
  noUsage?: boolean
  cutMid?: Set<number>
  cutDelta?: string
}): Promise<{ port: number; received: () => number; close: () => void }> {
  let received = 0
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      received++
      const idx = received
      if (opts.failSet?.has(idx)) {
        res.writeHead(500).end()
        return
      }
      if (opts.cutMid?.has(idx)) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: { content: opts.cutDelta ?? "PARTIAL", role: "assistant" }, finish_reason: null }], usage: null })}\n\n`)
        res.destroy()
        return
      }
      const text = "正文".repeat(Math.max(1, Math.floor((opts.textBytes ?? 400) / 2)))
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: { content: text, role: "assistant" }, finish_reason: null }], usage: null })}\n\n`)
      const usage = opts.noUsage ? null : (opts.hugeUsage
        ? { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 }
        : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      res.write(`data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port
      resolve({ port, received: () => received, close: () => srv.close() })
    })
  })
}

async function main(): Promise<void> {
  console.log("===== R24 反证场景（12 例，0 真实 API） =====")
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dw-r24-cx-"))

  // ---------------- C1：stage-targets 全链 + 篡改红 ----------------
  console.log("\n[C1] stage-targets 全链（scale=0.1 longform；篡改 201 → 红）")
  {
    const outDir = path.join(tmpRoot, "c1")
    const r = await runSync([RUNNER, "--mock", "--scale=0.1", "--repeats=1", "--task=longform-multichapter", `--out-dir=${outDir}`])
    const runDir = latestRunDir(outDir)
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8"))
    const st = manifest.stageTargets ?? []
    const outlineOk = st.filter((e: { stageId?: string }) => e.stageId === "outline").every((e: { targetChars?: number }) => e.targetChars === 200)
    const chapterOk = st.filter((e: { stageId?: string }) => e.stageId === "chapter").length === 3 && st.filter((e: { stageId?: string }) => e.stageId === "chapter").every((e: { targetChars?: number }) => e.targetChars === 3300)
    const v1 = await runSync([VALIDATOR, runDir])
    fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ ...manifest, stageTargets: st.map((e: { stageId?: string; targetChars?: number }) => (e.stageId === "outline" ? { ...e, targetChars: 201 } : e)) }, null, 2), "utf-8")
    const v2 = await runSync([VALIDATOR, runDir])
    const hit = /stage-targets/.test(v2.stdout) && /FAIL/.test(v2.stdout)
    record("C1", "stage-targets 全链 + 篡改 201 红", outlineOk && chapterOk && v1.code === 0 && v2.code !== 0 && hit,
      `outline=${outlineOk} chapter×3=${chapterOk} 正常 validate=${v1.code} 篡改 validate=${v2.code} 命中=${hit}`)
  }

  // ---------------- C2：stageTargetsHash 篡改红 ----------------
  console.log("\n[C2] stageTargetsHash 篡改 → validator 红")
  {
    const outDir = path.join(tmpRoot, "c2")
    await runSync([RUNNER, "--mock", "--scale=0.1", "--repeats=1", "--task=style-transfer", `--out-dir=${outDir}`])
    const runDir = latestRunDir(outDir)
    const manifestPath = path.join(runDir, "manifest.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    manifest.stageTargetsHash = "0".repeat(64)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")
    const v = await runSync([VALIDATOR, runDir])
    const hit = /stage-targets/.test(v.stdout) && /FAIL/.test(v.stdout)
    record("C2", "stageTargetsHash 篡改 → 红", v.code !== 0 && hit, `validate=${v.code} 命中=${hit}`)
  }

  // ---------------- C3：scale=0.1 执行 target（unscaled 序列不变） ----------------
  console.log("\n[C3] scale=0.1：manifest.stageTargets 保持 unscaled")
  {
    const outDir = path.join(tmpRoot, "c3")
    const r = await runSync([RUNNER, "--mock", "--scale=0.1", "--repeats=1", "--task=longform-multichapter", `--out-dir=${outDir}`])
    const runDir = latestRunDir(outDir)
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8"))
    const st = manifest.stageTargets ?? []
    const unscaledOk = st.filter((e: { stageId?: string }) => e.stageId === "outline").every((e: { targetChars?: number }) => e.targetChars === 200) && st.filter((e: { stageId?: string }) => e.stageId === "chapter").every((e: { targetChars?: number }) => e.targetChars === 3300)
    record("C3", "scale=0.1 下 stageTargets 仍为 unscaled 真源", r.code === 0 && unscaledOk, `runner=${r.code} unscaled=${unscaledOk}`)
  }

  // ---------------- C4：多轮一致性（共享 composer 三等式） ----------------
  console.log("\n[C4] 多轮一致性：compose(turns) == measuredChars == 投影正文（A+B+C=12000）")
  {
    const seg = (ch: string, tail: string): string => ch.repeat(3200) + tail.repeat(160)
    const A = seg("甲", "正文段落甲")
    const B = seg("乙", "正文段落乙")
    const C = seg("丙", "正文段落丙")
    const projMod = await (async () => {
      const outfile = path.join(ROOT, "out", `r24-c4-${Date.now()}.mjs`)
      await esbuild.build({ entryPoints: [path.join(ROOT, "src", "main", "sessionProjection.ts")], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent" })
      const mod = await import(url.pathToFileURL(outfile).href)
      try { await fs.promises.unlink(outfile) } catch { /* ignore */ }
      return mod
    })()
    const compose = projMod.composeRunAssistantContent as (turns: Array<{ role: string; content: string; reasoning_content?: string | null; turn_seq?: number }>) => { content: string; reasoning: string; turnCount: number; turnChars: number[]; turnHashes: string[] }
    const turns = [A, B, C].map((content, i) => ({ role: "assistant", content, reasoning_content: null, turn_seq: i + 1 }))
    const composed = compose(turns)
    const measuredChars = turns.reduce((a, t) => a + t.content.length, 0)
    const projected: Array<Record<string, unknown>> = []
    const messages: Array<{ msg_id: string; seq: number }> = []
    const projRes = (projMod.projectTerminalAssistant as (deps: Record<string, unknown>, runId: string, sessionId: string, runStatus: string) => { ok: boolean; projected: boolean })({
      getTurnsByRun: () => turns,
      getSessionMessages: () => messages,
      appendSessionMessage: (m: Record<string, unknown>) => { projected.push(m); messages.push({ msg_id: String(m.msg_id), seq: Number(m.seq) }) }
    }, "run-c4", "sess-c4", "completed")
    const composedEq = composed.content === A + B + C && composed.content.length === measuredChars && measuredChars === 12000
    const projectionEq = projRes.ok && projRes.projected && String(projected[0]?.content ?? "") === A + B + C
    const turnHashOk = composed.turnHashes[2] === sha256(C) && composed.turnChars.join(",") === [A.length, B.length, C.length].join(",")
    record("C4", "多轮四者一致（compose==measuredChars==投影==逐轮 hash）", composedEq && projectionEq && turnHashOk,
      `content=${composed.content.length} measured=${measuredChars} 投影=${String(projected[0]?.content ?? "").length} turnChars=${composed.turnChars.join("+")} lastHashOk=${turnHashOk}`)
  }

  // ---------------- C5~C9：费用硬上限 ----------------
  console.log("\n[C5~C9] 费用小数解析 / 冲穿拒绝 / reservation / usage 缺失 / inner retry reserve")
  {
    // C5：0.01 解析（可信探针 profile 下运行，验证小数原样保留）
    {
      const ep = await startEndpoint({})
      const profilePath = writeTrustedProfile(ep.port, tmpRoot)
      const outDir = path.join(tmpRoot, "c5")
      const r = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=0.01", `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
      const manifest = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir), "manifest.json"), "utf-8"))
      const ok = manifest.budget?.maxCostCny === 0.01
      ep.close()
      record("C5", "--max-cost-cny=0.01 原样保留（非 null）", ok, `manifest.budget.maxCostCny=${JSON.stringify(manifest.budget?.maxCostCny)} runner exit=${r.code}`)
    }
    // C6a：cap 小于单请求预留 → fetch 前拒发
    {
      const ep = await startEndpoint({})
      const profilePath = writeTrustedProfile(ep.port, tmpRoot)
      const outDir = path.join(tmpRoot, "c6a")
      const r = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=0.001", `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
      const manifest = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir), "manifest.json"), "utf-8"))
      const okA = ep.received() === 0 && manifest.budget?.exhausted === true && manifest.budget?.spentActualCny === 0
      ep.close()
      record("C6a", "cap=0.001 < 单请求预留 → fetch 前拒发（spent=0 即熔断）", r.code !== 0 && okA,
        `端点实收=0 exhausted=${manifest.budget?.exhausted} spentActual=${manifest.budget?.spentActualCny}`)
    }
    // C6b：端点超发（10 元）→ 契约违约：如实入账 + hardCapProtected=false + 立即停止（实收 1，不静默继续）
    {
      const ep = await startEndpoint({ hugeUsage: true })
      const profilePath = writeTrustedProfile(ep.port, tmpRoot)
      const outDir = path.join(tmpRoot, "c6b")
      const r = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=1", `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
      const manifest = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir), "manifest.json"), "utf-8"))
      const okB = ep.received() === 1 && manifest.budget?.exhausted === true && (manifest.budget?.spentActualCny ?? 0) > 1 && manifest.budget?.hardCapProtected === false
      const detail = `端点实收=${ep.received()} spentActual=${manifest.budget?.spentActualCny} hardCapProtected=${manifest.budget?.hardCapProtected} exhausted=${manifest.budget?.exhausted} reason=${String(manifest.budget?.reason).slice(0, 50)}`
      ep.close()
      record("C6b", "端点超发（10 元）→ 契约违约即熔断（实收 1，不静默继续）", r.code !== 0 && okB, detail)
    }
    // C7：cap 只够 1 个 reservation → 实收恰 1。
    // repeats=2 下同 stage 两个 repeat 的请求消息相同 → 预留 R 相同，cap ∈ [R, a+R) 区间存在（a=单请求实际成本）。
    {
      const ep0 = await startEndpoint({})
      const profilePath0 = writeTrustedProfile(ep0.port, tmpRoot)
      const outDir0 = path.join(tmpRoot, "c7a")
      await runSync([RUNNER, "--real", "--repeats=2", "--task=renpy-scene-branch", `--price-profile=${profilePath0}`, `--out-dir=${outDir0}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep0.port}`, DEEPSEEK_API_KEY: "test-key" })
      const m0 = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir0), "manifest.json"), "utf-8"))
      ep0.close()
      const actualPerReq = (m0.budget?.spentActualCny ?? 0) / Math.max(1, m0.budget?.requestsUsed ?? 1)
      let lo = 0
      let hi = 1
      let boundary = 0
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2
        const ep = await startEndpoint({})
        const profilePath = writeTrustedProfile(ep.port, tmpRoot, `r24-c7-${i}`)
        const outDir = path.join(tmpRoot, `c7c-${i}`)
        await runSync([RUNNER, "--real", "--repeats=2", "--task=renpy-scene-branch", `--max-cost-cny=${mid}`, `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
        const got = ep.received()
        ep.close()
        if (got === 0) { lo = mid; boundary = mid } else { hi = mid }
      }
      const cap = boundary + actualPerReq / 2
      const ep2 = await startEndpoint({})
      const profilePath2 = writeTrustedProfile(ep2.port, tmpRoot)
      const outDir2 = path.join(tmpRoot, "c7b")
      await runSync([RUNNER, "--real", "--repeats=2", "--task=renpy-scene-branch", `--max-cost-cny=${cap}`, `--price-profile=${profilePath2}`, `--out-dir=${outDir2}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep2.port}`, DEEPSEEK_API_KEY: "test-key" })
      const m2 = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir2), "manifest.json"), "utf-8"))
      const ok = ep2.received() === 1 && m2.budget?.exhausted === true
      const detail = `边界≈${boundary.toFixed(6)} 单请求≈${actualPerReq.toFixed(6)} cap=${cap.toFixed(6)} 实收=${ep2.received()} exhausted=${m2.budget?.exhausted}`
      ep2.close()
      record("C7", "cap 只够 1 个 reservation → 实收恰 1", ok, detail)
    }
    // C8：usage 缺失不按 0 释放——reservation 转 spentUpper，cap 只够 1 个 reservation → 实收恰 1
    {
      let rBoundary = 0
      let rLo = 0
      let rHi = 1
      for (let i = 0; i < 16; i++) {
        const mid = (rLo + rHi) / 2
        const ep = await startEndpoint({ noUsage: true })
        const profilePath = writeTrustedProfile(ep.port, tmpRoot, `r24-c8b-${i}`)
        const outDir = path.join(tmpRoot, `c8b-${i}`)
        await runSync([RUNNER, "--real", "--repeats=1", "--task=renpy-scene-branch", `--max-cost-cny=${mid}`, `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
        const got = ep.received()
        ep.close()
        if (got === 0) { rLo = mid; rBoundary = mid } else { rHi = mid }
      }
      const cap = rBoundary * 1.5
      const ep = await startEndpoint({ noUsage: true })
      const profilePath = writeTrustedProfile(ep.port, tmpRoot)
      const outDir = path.join(tmpRoot, "c8")
      await runSync([RUNNER, "--real", "--repeats=1", "--task=renpy-scene-branch", `--max-cost-cny=${cap}`, `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
      const manifest = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir), "manifest.json"), "utf-8"))
      const ok = ep.received() === 1 && manifest.budget?.actualCostKnown === false && manifest.budget?.exhausted === true && (manifest.budget?.spentUpperCny ?? 0) > 0
      const detail = `端点实收=${ep.received()} actualCostKnown=${manifest.budget?.actualCostKnown} spentUpper=${manifest.budget?.spentUpperCny} exhausted=${manifest.budget?.exhausted}`
      ep.close()
      record("C8", "usage 缺失不按 0 释放（转 spentUpper，cap 内不发第 2 个）", ok, detail)
    }
    // C9：inner retry 重新 reserve
    {
      const ep = await startEndpoint({ failSet: new Set([3, 4]) })
      const profilePath = writeTrustedProfile(ep.port, tmpRoot)
      const outDir = path.join(tmpRoot, "c9")
      await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
      const manifest = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir), "manifest.json"), "utf-8"))
      const ok = manifest.innerRetries === 1 && manifest.outerRetries === 1 && manifest.budget?.requestsUsed === ep.received() && manifest.budget?.inflightReservedCny < 1e-9
      const detail = `inner=${manifest.innerRetries} outer=${manifest.outerRetries} requestsUsed=${manifest.budget?.requestsUsed} 实收=${ep.received()} inflight=${manifest.budget?.inflightReservedCny}`
      ep.close()
      record("C9", "inner retry 重新 reserve 且对账释放", ok, detail)
    }
  }

  // ---------------- C10：retry 指标事实化 ----------------
  console.log("\n[C10] retry 指标事实化（terminal=failed 后成功）")
  {
    const ep = await startEndpoint({ failSet: new Set([3, 4]) })
    const outDir = path.join(tmpRoot, "c10")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const runDir = latestRunDir(outDir)
    const samples = JSON.parse(fs.readFileSync(path.join(runDir, "samples.json"), "utf-8")).samples as Array<{ variantId: string; metrics: { failures: number; retries: number; status: string } }>
    const cur = samples.find((s) => s.variantId === "deepwriter_current_product")
    const ok = cur !== undefined && cur.metrics.failures >= 1 && cur.metrics.retries >= 1
    const detail = `current failures=${cur?.metrics.failures} retries=${cur?.metrics.retries} status=${cur?.metrics.status}`
    ep.close()
    record("C10", "非异常失败也计 failures/retries 且最终成功", ok, detail)
  }

  // ---------------- C11：trajectory retry 隔离 ----------------
  console.log("\n[C11] trajectory retry 隔离（失败 attempt partial 不污染下一 stage 历史）")
  {
    const PARTIAL = "PARTIAL-污染-标记-正文"
    const ep = await startEndpoint({ cutMid: new Set([3]), cutDelta: PARTIAL })
    const outDir = path.join(tmpRoot, "c11")
    const r = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--experiment=trajectory", `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const runDir = latestRunDir(outDir)
    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, "ledger.json"), "utf-8")).ledger as Array<{ sampleId: string; stageOrdinal: number; actualHistoryTurnHashes?: Array<{ role: string; sha256: string }> }>
    const partialHash = sha256(PARTIAL)
    const leaked = ledger.filter((a) => a.stageOrdinal >= 2 && (a.actualHistoryTurnHashes ?? []).some((t) => t.sha256 === partialHash))
    const ok = leaked.length === 0
    ep.close()
    record("C11", "失败 attempt partial 不污染下一 stage 历史", ok, `runner=${r.code} 泄漏条目=${leaked.length}`)
  }

  // ---------------- C12：real 未观测 → null ----------------
  console.log("\n[C12] real 未观测端点 → ledgerMatchesEndpoint=null")
  {
    const ep = await startEndpoint({})
    const outDir = path.join(tmpRoot, "c12")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const manifest = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir), "manifest.json"), "utf-8"))
    const ok = manifest.localEndpointReceived === null && manifest.ledgerMatchesEndpoint === null
    ep.close()
    record("C12", "real 未观测 → ledgerMatchesEndpoint=null", ok, `local=${JSON.stringify(manifest.localEndpointReceived)} match=${JSON.stringify(manifest.ledgerMatchesEndpoint)}`)
  }

  console.log("")
  const pass = results.filter((r) => r.pass).length
  console.log(`===== R24 反证场景：${pass} PASS / ${results.length - pass} FAIL =====`)
  if (pass !== results.length) process.exit(1)
}

main().catch((e) => {
  console.error("eval-r24-counterexamples 执行异常：", e)
  process.exit(2)
})
