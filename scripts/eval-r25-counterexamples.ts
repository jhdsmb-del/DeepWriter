// ==================== R25 反证场景脚本（任务书 §四 12 项，0 真实 API） ====================
// 构建：esbuild scripts/eval-r25-counterexamples.ts --bundle --format=esm --platform=node --outfile=out/eval-r25-counterexamples.mjs
// 运行：node out/eval-r25-counterexamples.mjs
// 全部走本地 deterministic HTTP 端点/产物篡改/内存函数调用，绝不发起真实网络请求。
//
//   CE1  未知 model + max-cost：runner 非零，端点实收 0（禁止首条回退）
//   CE2  OpenCode endpoint + 仅 DeepSeek 官方 profile：provider scope mismatch，实收 0
//   CE3  transport error：cap 只够 1 个 reservation → 实收恰 1
//   CE4  transport error：cap 够 2 个 reservation → 实收 2，spentUpper=2×reservation，actualCostKnown=false
//   CE5  HTTP 500 / abort(首字节超时) / transport 断流同口径：均不按 0 释放
//   CE6  success usage missing 不无限发（cap 只够 2 个 reservation → 实收 2）
//   CE7  cache hit/miss 手算常量精确相等；旧双计公式必须红
//   CE8  rare Unicode/tool schema 的 byte ceiling 覆盖完整 body；旧 content.length 估算必须红
//   CE9  scale=0.1 longform 产物 200/20/200 与 3300/330/330；篡改任一值 validator 红
//   CE10 manifest 删除 model/provider/profile 任一字段 → real+cost validator 非零
//   CE11 profile hash 漂移 → validator 红；currency/endpoint/model 错配 → fetch 前拒绝实收 0
//   CE12 inner/outer retry 与 generic/current/hardened 共用同一 upper-bound 账本（恒等式与不变量）

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import * as os from "node:os"
import * as http from "node:http"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
// 静态复用 preflight（esbuild bundle 内联）：computeSampleCost / utf8BodyTokenCeiling / 常量
import { computeSampleCost, utf8BodyTokenCeiling, priceProfileHash, type PriceProfile, type SampleUsage } from "./eval-preflight"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

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

function runSync(args: string[], env: Record<string, string> = {}, timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string }> {
  // Explicit authorization is scoped to this suite's own synthetic loopback prices, not repository/provider profiles.
  const authorizedArgs = [...args]
  const profilePath = args.find((arg) => arg.startsWith("--price-profile="))?.slice("--price-profile=".length)
  if (args[0] === RUNNER && profilePath) {
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as PriceProfile
    if (profile.providerId === "probe-provider" && profile.source === "R25 counterexamples local probe" && profile.endpointOrigins.every((origin) => /^http:\/\/127\.0\.0\.1:\d+$/.test(origin))) {
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

function writeTrustedProfile(port: number, dir: string, opts: { profileId?: string; currency?: string; prices?: Array<Record<string, number | string>> } = {}): string {
  const p = path.join(dir, `profile-${port}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: 1,
    profileId: opts.profileId ?? "r25-probe-trusted",
    providerId: "probe-provider",
    endpointOrigins: [`http://127.0.0.1:${port}`],
    currency: opts.currency ?? "CNY",
    unit: "per-1M-tokens",
    source: "R25 counterexamples local probe",
    updatedAt: "2026-08-16",
    prices: opts.prices ?? [{ model: "deepseek-v4-flash", inputPer1M: 2.0, outputPer1M: 8.0, cacheHitPer1M: 0.4 }]
  }, null, 2), "utf-8")
  return p
}

/** 本地可控 SSE 端点（计数实收）：正常 200+usage / 500 / 断流 / 挂起不响应 / 无 usage / 超发 usage */
function startEndpoint(opts: {
  failSet?: Set<number>
  cutAll?: boolean
  cutMid?: Set<number>
  holdOpen?: Set<number>
  noUsage?: boolean
  hugeUsage?: boolean
  textBytes?: number
}): Promise<{ port: number; received: () => number; close: () => void }> {
  let received = 0
  const sockets = new Set<import("node:net").Socket>()
  const srv = http.createServer((req, res) => {
    sockets.add(req.socket)
    req.socket.on("close", () => sockets.delete(req.socket))
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      received++
      const idx = received
      if (opts.holdOpen?.has(idx)) return // 挂起：首字节超时 → aborted
      if (opts.failSet?.has(idx)) {
        res.writeHead(500).end()
        return
      }
      if (opts.cutAll || opts.cutMid?.has(idx)) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: { content: "PARTIAL-断流", role: "assistant" }, finish_reason: null }], usage: null })}\n\n`)
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
      resolve({ port, received: () => received, close: () => { for (const s of sockets) s.destroy(); srv.closeAllConnections?.(); srv.close() } })
    })
  })
}

/** transport 断流端点的单请求 reservation 上界（二分逼近；10 轮精度 ~1e-3 元，足够 cap 区间断言） */
async function transportReservationBoundary(tmpRoot: string, task: string, extraArgs: string[] = []): Promise<number> {
  let lo = 0
  let hi = 1
  let boundary = 0
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2
    const ep = await startEndpoint({ cutAll: true })
    const profilePath = writeTrustedProfile(ep.port, tmpRoot, { profileId: `r25-bnd-${i}` })
    const outDir = path.join(tmpRoot, `bnd-${Date.now()}-${i}`)
    await runSync([RUNNER, "--real", "--repeats=1", `--task=${task}`, `--max-cost-cny=${mid}`, `--price-profile=${profilePath}`, ...extraArgs, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const got = ep.received()
    ep.close()
    if (got === 0) { lo = mid; boundary = mid } else { hi = mid }
  }
  return boundary
}

async function main(): Promise<void> {
  console.log("===== R25 反证场景（12 例，0 真实 API） =====")
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dw-r25-cx-"))

  // ---------------- CE1：未知 model + max-cost → fetch 前拒绝，实收 0 ----------------
  console.log("\n[CE1] 未知 model + max-cost：runner 非零，端点实收 0")
  {
    const ep = await startEndpoint({})
    const profilePath = writeTrustedProfile(ep.port, tmpRoot)
    const outDir = path.join(tmpRoot, "ce1")
    const r = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=1", "--model=unpriced-model-codex-probe", `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const ok = r.code !== 0 && ep.received() === 0 && (r.stderr + r.stdout).includes("model-not-priced")
    ep.close()
    record("CE1", "未知 model 无首条回退（fetch 前拒绝实收 0）", ok, `exit=${r.code} 实收=${ep.received()} reason=${(r.stderr + r.stdout).includes("model-not-priced") ? "model-not-priced" : "?"}`)
  }

  // ---------------- CE2：OpenCode endpoint + DeepSeek-only profile → scope mismatch 实收 0 ----------------
  console.log("\n[CE2] OpenCode endpoint + 仅 DeepSeek 官方 profile → provider scope mismatch，实收 0")
  {
    // (a) 真实 OpenCode URL：fetch 前拒绝（不触碰网络）
    const outDirA = path.join(tmpRoot, "ce2a")
    const rA = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=1", `--out-dir=${outDirA}`], { DEEPSEEK_BASE_URL: "https://opencode.ai/zen/go", DEEPSEEK_API_KEY: "test-key" })
    // (b) 本地探针 + 仓库默认 profile（只信任 api.deepseek.com）：拒绝且本地实收 0
    const ep = await startEndpoint({})
    const outDirB = path.join(tmpRoot, "ce2b")
    const rB = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=1", `--out-dir=${outDirB}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const okA = rA.code !== 0 && (rA.stderr + rA.stdout).includes("endpoint-origin-not-trusted")
    const okB = rB.code !== 0 && ep.received() === 0 && (rB.stderr + rB.stdout).includes("endpoint-origin-not-trusted")
    ep.close()
    record("CE2", "OpenCode/非信任 origin + DeepSeek profile → scope mismatch 实收 0", okA && okB, `opencode exit=${rA.code}；本地探针 exit=${rB.code} 实收=${ep.received()}`)
  }

  // ---------------- CE3：transport error，cap 只够 1 个 reservation → 实收恰 1 ----------------
  console.log("\n[CE3] transport error：cap 只够 1 个 reservation → 实收恰 1")
  {
    const R = await transportReservationBoundary(tmpRoot, "renpy-scene-branch")
    const cap = R * 1.5
    const ep = await startEndpoint({ cutAll: true })
    const profilePath = writeTrustedProfile(ep.port, tmpRoot)
    const outDir = path.join(tmpRoot, "ce3")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=renpy-scene-branch", `--max-cost-cny=${cap}`, `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const m = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir), "manifest.json"), "utf-8"))
    const ok = ep.received() === 1 && m.budget?.exhausted === true && m.budget?.actualCostKnown === false && m.budget?.spentActualCny === 0 && (m.budget?.spentUpperCny ?? 0) > 0
    ep.close()
    record("CE3", "断流 reservation 不按 0 释放（cap 恰 1 → 实收 1）", ok, `R≈${R.toFixed(6)} cap=${cap.toFixed(6)} 实收=${ep.received()} spentUpper=${m.budget?.spentUpperCny} actualCostKnown=${m.budget?.actualCostKnown}`)
  }

  // ---------------- CE4：cap 够 2 个 reservation → 实收 2，spentUpper=2 份 ----------------
  console.log("\n[CE4] transport error：cap 够 2 个 reservation → 实收 2 且 spentUpper=2×reservation")
  {
    // 先实收 1 拿精确单请求 reservation（= 该请求转 spentUpper 后的值；避免二分边界的近似误差）
    const RApprox = await transportReservationBoundary(tmpRoot, "renpy-scene-branch")
    const ep0 = await startEndpoint({ cutAll: true })
    const profile0 = writeTrustedProfile(ep0.port, tmpRoot, { profileId: "r25-ce4-r0" })
    const out0 = path.join(tmpRoot, "ce4-r0")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=renpy-scene-branch", `--max-cost-cny=${RApprox * 1.5}`, `--price-profile=${profile0}`, `--out-dir=${out0}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep0.port}`, DEEPSEEK_API_KEY: "test-key" })
    const m0 = JSON.parse(fs.readFileSync(path.join(latestRunDir(out0), "manifest.json"), "utf-8"))
    const R = m0.budget?.spentUpperCny ?? 0
    const okR0 = ep0.received() === 1 && R > 0
    ep0.close()
    const cap = R * 2.5
    const ep = await startEndpoint({ cutAll: true })
    const profilePath = writeTrustedProfile(ep.port, tmpRoot)
    const outDir = path.join(tmpRoot, "ce4")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=renpy-scene-branch", `--max-cost-cny=${cap}`, `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const m = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir), "manifest.json"), "utf-8"))
    const spentUpper = m.budget?.spentUpperCny ?? 0
    const ok = okR0 && ep.received() === 2 && m.budget?.requestsUsed === 2 && m.budget?.actualCostKnown === false && m.budget?.spentActualCny === 0 && Math.abs(spentUpper - 2 * R) < 1e-9
    ep.close()
    record("CE4", "cap 够 2 份 → 实收 2，spentUpper=2×reservation", ok, `R=${R.toFixed(6)} cap=${cap.toFixed(6)} 实收=${ep.received()} spentUpper=${spentUpper} 2R=${(2 * R).toFixed(6)}`)
  }

  // ---------------- CE5：HTTP 500 / abort / timeout 与 transport 同口径，均不按 0 ----------------
  console.log("\n[CE5] HTTP 500 / abort / transport 同口径（reservation 转 spentUpper，不按 0）")
  {
    // (a) HTTP 500（inner retry 前）
    const epA = await startEndpoint({ failSet: new Set([3]) })
    const profileA = writeTrustedProfile(epA.port, tmpRoot)
    const outA = path.join(tmpRoot, "ce5a")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=10", `--price-profile=${profileA}`, `--out-dir=${outA}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${epA.port}`, DEEPSEEK_API_KEY: "test-key" })
    const mA = JSON.parse(fs.readFileSync(path.join(latestRunDir(outA), "manifest.json"), "utf-8"))
    const ledgerA = JSON.parse(fs.readFileSync(path.join(latestRunDir(outA), "ledger.json"), "utf-8")).ledger
    const has500 = ledgerA.some((a: { outcome?: string }) => a.outcome === "http_error")
    const okA = has500 && mA.spentActualCny > 0 && mA.spentUpperCny > mA.spentActualCny && mA.actualCostKnown === false
    epA.close()
    // (b) abort（首字节超时，env 缩短为 2s）：holdOpen 第 3 个请求（current stage1 inner1）
    const epB = await startEndpoint({ holdOpen: new Set([3]) })
    const profileB = writeTrustedProfile(epB.port, tmpRoot)
    const outB = path.join(tmpRoot, "ce5b")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=10", `--price-profile=${profileB}`, `--out-dir=${outB}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${epB.port}`, DEEPSEEK_API_KEY: "test-key", DEEPSEEK_EVAL_FIRST_BYTE_TIMEOUT_MS: "2000" })
    const mB = JSON.parse(fs.readFileSync(path.join(latestRunDir(outB), "manifest.json"), "utf-8"))
    const ledgerB = JSON.parse(fs.readFileSync(path.join(latestRunDir(outB), "ledger.json"), "utf-8")).ledger
    const hasAborted = ledgerB.some((a: { outcome?: string }) => a.outcome === "aborted")
    const okB = hasAborted && mB.spentUpperCny > mB.spentActualCny && mB.actualCostKnown === false
    epB.close()
    // (c) transport 断流（cutMid 第 1 个请求）
    const epC = await startEndpoint({ cutMid: new Set([1]) })
    const profileC = writeTrustedProfile(epC.port, tmpRoot)
    const outC = path.join(tmpRoot, "ce5c")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=10", `--price-profile=${profileC}`, `--out-dir=${outC}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${epC.port}`, DEEPSEEK_API_KEY: "test-key" })
    const mC = JSON.parse(fs.readFileSync(path.join(latestRunDir(outC), "manifest.json"), "utf-8"))
    const ledgerC = JSON.parse(fs.readFileSync(path.join(latestRunDir(outC), "ledger.json"), "utf-8")).ledger
    const hasTransport = ledgerC.some((a: { outcome?: string }) => a.outcome === "transport_error")
    const okC = hasTransport && mC.spentUpperCny > mC.spentActualCny && mC.actualCostKnown === false
    epC.close()
    record("CE5", "HTTP500/abort/transport 同口径不按 0（均转 spentUpper）", okA && okB && okC, `500=${has500} aborted=${hasAborted} transport=${hasTransport}`)
  }

  // ---------------- CE6：success usage missing 不无限发（cap 只够 2 份 → 实收 2） ----------------
  console.log("\n[CE6] success usage missing：cap 只够 2 个 reservation → 实收 2（不无限发）")
  {
    const R = await transportReservationBoundary(tmpRoot, "renpy-scene-branch")
    const cap = R * 2.5
    const ep = await startEndpoint({ noUsage: true })
    const profilePath = writeTrustedProfile(ep.port, tmpRoot)
    const outDir = path.join(tmpRoot, "ce6")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=renpy-scene-branch", `--max-cost-cny=${cap}`, `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const m = JSON.parse(fs.readFileSync(path.join(latestRunDir(outDir), "manifest.json"), "utf-8"))
    const ok = ep.received() === 2 && m.budget?.exhausted === true && m.budget?.actualCostKnown === false && m.budget?.spentActualCny === 0 && (m.budget?.spentUpperCny ?? 0) > 0
    ep.close()
    record("CE6", "usage 缺失不按 0 也不无限发（cap 内 2 个即停）", ok, `cap=${cap.toFixed(6)} 实收=${ep.received()} spentUpper=${m.budget?.spentUpperCny} exhausted=${m.budget?.exhausted}`)
  }

  // ---------------- CE7：cache hit/miss 手算精确；旧双计公式红 ----------------
  console.log("\n[CE7] cache miss/hit 费用手算恒等；旧双计公式必须红")
  {
    const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "eval-prices.json"), "utf-8")) as Parameters<typeof computeSampleCost>[1]
    const usage: SampleUsage = { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 }
    const sc = computeSampleCost(usage, profile, "deepseek-v4-flash")
    const handNew = (400 * 2 + 600 * 0.4 + 500 * 8) / 1_000_000
    const handOldDoubleCount = (1000 * 2 + 600 * 0.4 + 500 * 8) / 1_000_000
    const ok = typeof sc === "object" && sc.actualKnown === true && Math.abs(sc.total - handNew) < 1e-12 && Math.abs(handOldDoubleCount - handNew) > 1e-9
    record("CE7", "cache actual=miss×input+hit×cache+out×output 且旧双计必红", ok,
      `actual=${typeof sc === "object" ? sc.total.toFixed(9) : "unknown"} 手算=${handNew.toFixed(9)} 旧双计=${handOldDoubleCount.toFixed(9)}`)
  }

  // ---------------- CE8：byte ceiling 覆盖完整 body；旧 content.length 估算红 ----------------
  console.log("\n[CE8] rare Unicode/tool schema 的 byte ceiling；旧 content.length 估算必须红")
  {
    const bodyJson = JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 8192,
      tools: [{ type: "function", function: { name: "query_archive", description: "查询档案（含罕见符号 🗄️）", parameters: { type: "object", properties: { q: { type: "string", description: "关键字" } } } } }],
      messages: [
        { role: "system", content: "你是写作助手。\n\"转义\\与换行\n" },
        { role: "user", content: "罕见字𠀀𠀁🚀🧠e\u0301（组合字符）与中文，请写 3300 字正文。" }
      ]
    })
    const { bytes, ceiling } = utf8BodyTokenCeiling(bodyJson)
    const messages = JSON.parse(bodyJson).messages as Array<{ content?: string }>
    const oldCharsEstimate = messages.reduce((a, m) => a + (m.content ?? "").length, 0)
    const ok = bytes >= [...bodyJson].length && ceiling >= bytes && bytes > oldCharsEstimate
    record("CE8", "utf8-body-byte ceiling ≥ 旧字符估算（旧口径必红）", ok, `bytes=${bytes} 字符数=${[...bodyJson].length} 旧估算=${oldCharsEstimate} ceiling=${ceiling}`)
  }

  // ---------------- CE9：scale=0.1 longform 三栏分落 200/20/200 与 3300/330/330；篡改红 ----------------
  console.log("\n[CE9] scale=0.1 longform 200/20/200 与 3300/330/330；篡改任一值 validator 红")
  {
    const outDir = path.join(tmpRoot, "ce9")
    const r = await runSync([RUNNER, "--mock", "--scale=0.1", "--repeats=1", "--task=longform-multichapter", `--out-dir=${outDir}`])
    const runDir = latestRunDir(outDir)
    const samples = JSON.parse(fs.readFileSync(path.join(runDir, "samples.json"), "utf-8")).samples as Array<{ variantId: string; stageOutputs: Array<{ stageId: string; declaredTargetChars?: number; executionTargetChars?: number; mockFairLength?: number | null }> }>
    const cur = samples.find((s) => s.variantId === "deepwriter_current_product")
    const outline = cur?.stageOutputs.find((s) => s.stageId === "outline")
    const chapter = cur?.stageOutputs.find((s) => s.stageId === "chapter")
    const fieldsOk = outline?.declaredTargetChars === 200 && outline?.executionTargetChars === 20 && outline?.mockFairLength === 200
      && chapter?.declaredTargetChars === 3300 && chapter?.executionTargetChars === 330 && chapter?.mockFairLength === 330
    // 篡改 executionTargetChars → validator 红
    const samplesDoc = JSON.parse(fs.readFileSync(path.join(runDir, "samples.json"), "utf-8"))
    const tamper = samplesDoc.samples.find((s: { variantId: string }) => s.variantId === "deepwriter_current_product")
    const o = tamper.stageOutputs.find((s: { stageId: string }) => s.stageId === "outline")
    o.executionTargetChars = 21
    fs.writeFileSync(path.join(runDir, "samples.json"), JSON.stringify(samplesDoc, null, 2), "utf-8")
    const v = await runSync([VALIDATOR, runDir])
    const ok = r.code === 0 && fieldsOk && v.code !== 0 && (v.stdout + v.stderr).includes("stage-length-facts")
    record("CE9", "200/20/200 与 3300/330/330 分栏 + 篡改必红", ok,
      `outline=${outline?.declaredTargetChars}/${outline?.executionTargetChars}/${outline?.mockFairLength} chapter=${chapter?.declaredTargetChars}/${chapter?.executionTargetChars}/${chapter?.mockFairLength} 篡改后 validator exit=${v.code}`)
  }

  // ---------------- CE10：manifest 删计价字段 → real+cost validator 非零 ----------------
  console.log("\n[CE10] manifest 删除 model/provider/profile 任一字段 → real+cost validator 非零")
  {
    const ep = await startEndpoint({})
    const profilePath = writeTrustedProfile(ep.port, tmpRoot)
    const outDir = path.join(tmpRoot, "ce10")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=10", `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const runDir = latestRunDir(outDir)
    const original = fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8")
    const fields = ["model", "providerId", "priceProfileHash", "endpointOrigin", "priceProfileCurrency", "spentActualCny", "actualCostKnown"]
    const exitCodes: Array<{ f: string; code: number }> = []
    for (const f of fields) {
      const m = JSON.parse(original)
      delete m[f]
      fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(m, null, 2), "utf-8")
      const v = await runSync([VALIDATOR, runDir, `--price-profile=${profilePath}`])
      exitCodes.push({ f, code: v.code })
      fs.writeFileSync(path.join(runDir, "manifest.json"), original, "utf-8")
    }
    ep.close()
    const ok = exitCodes.every((e) => e.code !== 0)
    record("CE10", "删任一计价/预算字段 validator 非零", ok, exitCodes.map((e) => `${e.f}=${e.code}`).join(" "))
  }

  // ---------------- CE11：profile hash 漂移 validator 红；currency/endpoint/model 错配 fetch 前拒绝 ----------------
  console.log("\n[CE11] profile hash 漂移红 + currency/endpoint/model 错配 fetch 前拒绝实收 0")
  {
    // (a) hash 漂移：runner 用 profile A 跑，validator 用被改价后的 profile B → hash 漂移红
    const epA = await startEndpoint({})
    const profileA = writeTrustedProfile(epA.port, tmpRoot, { profileId: "r25-drift" })
    const outA = path.join(tmpRoot, "ce11a")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=10", `--price-profile=${profileA}`, `--out-dir=${outA}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${epA.port}`, DEEPSEEK_API_KEY: "test-key" })
    const runDirA = latestRunDir(outA)
    const drifted = JSON.parse(fs.readFileSync(profileA, "utf-8"))
    drifted.prices[0].inputPer1M = 2.5
    const profileB = path.join(tmpRoot, "ce11-drifted.json")
    fs.writeFileSync(profileB, JSON.stringify(drifted, null, 2), "utf-8")
    const vA = await runSync([VALIDATOR, runDirA, `--price-profile=${profileB}`])
    const okA = vA.code !== 0 && (vA.stdout + vA.stderr).includes("pricing-identity")
    epA.close()
    // (b) currency 错配：USD profile + --max-cost-cny → fetch 前拒绝实收 0
    const epB = await startEndpoint({})
    const profileUsd = writeTrustedProfile(epB.port, tmpRoot, { currency: "USD" })
    const outB = path.join(tmpRoot, "ce11b")
    const rB = await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=1", `--price-profile=${profileUsd}`, `--out-dir=${outB}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${epB.port}`, DEEPSEEK_API_KEY: "test-key" })
    const okB = rB.code !== 0 && epB.received() === 0 && (rB.stderr + rB.stdout).includes("currency-mismatch")
    epB.close()
    record("CE11", "hash 漂移 validator 红 + currency 错配 fetch 前拒绝实收 0（endpoint/model 见 CE1/CE2）", okA && okB, `drift exit=${vA.code}；USD cap exit=${rB.code} 实收=${epB.received()}`)
  }

  // ---------------- CE12：inner/outer retry 与 generic/current/hardened 共用同一 upper 账本 ----------------
  console.log("\n[CE12] inner/outer retry 与三 variant 共用同一 upper-bound 账本")
  {
    const ep = await startEndpoint({ failSet: new Set([3, 4, 5]) })
    const profilePath = writeTrustedProfile(ep.port, tmpRoot)
    const outDir = path.join(tmpRoot, "ce12")
    await runSync([RUNNER, "--real", "--repeats=1", "--task=style-transfer", "--max-cost-cny=10", `--price-profile=${profilePath}`, `--out-dir=${outDir}`], { DEEPSEEK_BASE_URL: `http://127.0.0.1:${ep.port}`, DEEPSEEK_API_KEY: "test-key" })
    const runDir = latestRunDir(outDir)
    const m = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8"))
    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, "ledger.json"), "utf-8")).ledger as Array<{ innerAttempt?: number; outerAttempt?: number; outcome?: string }>
    const hasInnerRetry = ledger.some((a) => (a.innerAttempt ?? 1) >= 2)
    const hasOuterRetry = ledger.some((a) => (a.outerAttempt ?? 1) >= 2)
    const variantsSeen = new Set(ledger.map((a) => (a as { variantId?: string }).variantId))
    const invariants = m.budget?.requestsUsed === ledger.length
      && m.budget?.inflightReservedCny === 0
      && m.spentActualCny <= m.spentUpperCny + 1e-9
      && m.budget?.spentUpperCny > m.budget?.spentActualCny
      && m.budget?.actualCostKnown === false
      && m.budget?.hardCapProtected === true
    const ok = hasInnerRetry && hasOuterRetry && invariants && variantsSeen.size === 3
    record("CE12", "五路径共用账本（inner/outer/generic/current/hardened 恒等式成立）", ok,
      `inner≥2=${hasInnerRetry} outer≥2=${hasOuterRetry} variants=${[...variantsSeen].join(",")} spentActual=${m.spentActualCny} spentUpper=${m.spentUpperCny} inflight=${m.budget?.inflightReservedCny}`)
  }

  console.log("")
  const pass = results.filter((r) => r.pass).length
  console.log(`===== R25 反证场景：${pass} PASS / ${results.length - pass} FAIL =====`)
  process.exit(pass !== results.length ? 1 : 0)
}

main().catch((e) => {
  console.error("eval-r25-counterexamples 执行异常：", e)
  process.exit(2)
})
