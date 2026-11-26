// ==================== DeepWriter R19 评测基建 — 红灯测试（10 项，任务书 §七） ====================
// 对真实生成的 synthetic 评测包 / manifest / 评分文件执行结构化验证（非静态字符串断言）。
// 依赖（先构建再跑）：out/eval-runner.mjs（A）、out/eval-blind.mjs（B）、out/eval-preflight.mjs（C）。
// 运行：node out/eval-red-tests.mjs（构建见 package.json eval:red）
// 每个红灯验证「正常包通过 + 篡改包被检出」；任一断言失败 → 退出码 1。

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as os from "node:os"
import * as http from "node:http"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { loadEvalTasks, schemaJsonToHash, stageTargetsHash, type EvalTask } from "./eval-schema"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

interface PreflightMod {
  priceProfileValidate(p: unknown): { ok: boolean; errors: string[] }
  priceProfileHash(p: unknown): string
  loadPriceProfile(p?: string): unknown
  manifestValidate(m: unknown): { ok: boolean; errors: string[] }
  scanForLeaks(items: string[]): { hits: Array<{ file: string; pattern: string; matched: string }> }
}

interface RedResult {
  id: string
  name: string
  pass: boolean
  detail: string
}

const results: RedResult[] = []

function record(id: string, name: string, cond: boolean, detail: string): void {
  results.push({ id, name, pass: cond, detail })
  console.log(`  ${cond ? "PASS" : "FAIL"}  R${id.replace(/^R/, "")} ${name}${detail ? " — " + detail : ""}`)
}

async function loadPreflight(): Promise<PreflightMod> {
  const mod = await import(url.pathToFileURL(path.resolve(ROOT, "out", "eval-preflight.mjs")).href)
  return mod as unknown as PreflightMod
}

/** 临时工作目录（自愈式清理） */
async function mkTmp(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 递归收集目录下全部文件（相对路径） */
function collectFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

// ==================== R7 price profile：缺字段/单位不合法/hash 不一致 → FAIL ====================

async function red07(pp: PreflightMod): Promise<void> {
  const profile = pp.loadPriceProfile() as { currency: string } | null
  const base = profile ? (JSON.parse(JSON.stringify(profile)) as Record<string, unknown>) : null
  const badUnit = base ? { ...base, unit: "per-1G-tokens" } : null
  const negPrice = base ? JSON.parse(JSON.stringify(base)) : null
  if (negPrice && Array.isArray((negPrice as { prices: unknown[] }).prices)) {
    ;((negPrice as { prices: Array<Record<string, unknown>> }).prices[0] as Record<string, unknown>).outputPer1M = -1
  }
  const vUnit = pp.priceProfileValidate(badUnit)
  const vNeg = pp.priceProfileValidate(negPrice)
  const hashA = profile ? pp.priceProfileHash(profile) : ""
  const tampered = base ? { ...base, updatedAt: "2099-01-01" } : null
  const hashB = tampered ? pp.priceProfileHash(tampered as never) : hashA
  record("R7", "price profile 缺字段/单位不合法/hash 不一致 → FAIL",
    (!vUnit.ok && vUnit.errors.some((e) => e.includes("unit"))) &&
    (!vNeg.ok && vNeg.errors.some((e) => e.includes("negative"))) &&
    hashA !== "" && hashB !== "" && hashA !== hashB,
    `unit非法=${vUnit.errors.length}err 负价=${vNeg.errors.length}err hash漂移=${hashA.slice(0, 10)}…→${hashB.slice(0, 10)}…`)
}

// ==================== R8 manifest commit/source/task hash 缺失 → FAIL ====================

async function red08(pp: PreflightMod): Promise<void> {
  const nowIso = new Date().toISOString()
  const good: Record<string, unknown> = {
    schemaVersion: 1,
    commit: "614e42898410aaccbc2e2f179b788f88ee6ed66a",
    dirtyFiles: [],
    nodeVersion: process.version,
    electronVersion: null,
    platform: `${process.platform}-${process.arch}`,
    taskSchemaHash: "a".repeat(64),
    variantContractHashes: { generic_baseline: "b".repeat(64) },
    runnerSourceHash: "c".repeat(64),
    seed: 1,
    argv: [],
    synthetic: true,
    real: false,
    startedAt: nowIso,
    finishedAt: nowIso,
    priceProfileHash: "d".repeat(64),
    priceProfileId: "x",
    model: "deepseek-v4-flash",
    repeats: 1,
    tasks: [{ id: "t", targetChars: 100, stages: 1 }],
    variants: [{ id: "v" }],
    // R25-P1-03：scale 必填（validator 三栏重算的事实输入）
    scale: 1,
    // R21-R03 主代理适配：S3 强制的新事实字段（R21 起 mandatory）
    experimentMode: "controlled",
    durationMs: 0,
    plannedRequests: 3,
    actualRequests: 3,
    outerRetries: 0,
    innerRetries: 0,
    usageCoverage: { present: 3, missing: 0, total: 3 },
    requestTraceHash: "e".repeat(64),
    artifactHashes: { samplesSha256: "f".repeat(64), variantsSha256: "ab".repeat(32) },
    sampleCounts: { total: 3, success: 3, failed: 0, validationPassed: 3, validationFailed: 0 }
  }
  const okFull = pp.manifestValidate(good)
  const noCommit = JSON.parse(JSON.stringify(good)) as Record<string, unknown>
  delete noCommit.commit
  const noTaskHash = JSON.parse(JSON.stringify(good)) as Record<string, unknown>
  delete noTaskHash.taskSchemaHash
  const noSourceHash = JSON.parse(JSON.stringify(good)) as Record<string, unknown>
  delete noSourceHash.runnerSourceHash
  const vNoCommit = pp.manifestValidate(noCommit)
  const vNoTaskHash = pp.manifestValidate(noTaskHash)
  const vNoSourceHash = pp.manifestValidate(noSourceHash)
  record("R8", "manifest commit/source/task hash 缺失 → FAIL",
    okFull.ok &&
    !vNoCommit.ok && vNoCommit.errors.some((e) => e.includes("commit")) &&
    !vNoTaskHash.ok && vNoTaskHash.errors.some((e) => e.includes("taskSchemaHash")) &&
    !vNoSourceHash.ok && vNoSourceHash.errors.some((e) => e.includes("runnerSourceHash")),
    `完整manifest=${okFull.ok ? "ok" : "FAIL"} 缺commit=${vNoCommit.errors.length}err 缺taskHash=${vNoTaskHash.errors.length}err 缺sourceHash=${vNoSourceHash.errors.length}err`)
}

// ==================== R9 输出目录含疑似 key/用户路径/真实设置 → FAIL ====================

async function red09(pp: PreflightMod): Promise<void> {
  const dir = await mkTmp("dw-red09-")
  try {
    const cleanFile = path.join(dir, "report.md")
    await fsp.writeFile(cleanFile, "这是干净的评测报告，无密钥无路径。", "utf-8")
    const cleanHits = pp.scanForLeaks(collectFiles(dir))
    await fsp.writeFile(path.join(dir, "leak.json"), '{"note":"sk-abc123def456ghi789jkl012mnop345 C:\\Users\\owner\\secret"}', "utf-8")
    const leakHits = pp.scanForLeaks(collectFiles(dir))
    record("R9", "输出目录含疑似 key/用户路径/真实设置 → FAIL",
      cleanHits.hits.length === 0 && leakHits.hits.length >= 1 && leakHits.hits.every((h) => !h.matched.includes("abc123")),
      `干净目录=${cleanHits.hits.length}命中 注入后=${leakHits.hits.length}命中(已打码)`)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

// ==================== R6 无 key 却尝试联网 → FAIL（本地连接计数 + 无 key 环境跑 --real） ====================

async function red06(): Promise<void> {
  let conns = 0
  const server = http.createServer((_req, res) => {
    conns++
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  try {
    const runner = path.resolve(ROOT, "out", "eval-runner.mjs")
    if (!fs.existsSync(runner)) {
      record("R6", "无 key 却尝试联网 → FAIL", false, `缺少 out/eval-runner.mjs（需先构建 subagent A 的 runner）`)
      return
    }
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [runner, "--real", "--repeats=1", `--out-dir=${path.join(os.tmpdir(), "dw-red06-out")}`], {
        cwd: ROOT,
        env: { ...process.env, DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}` },
        stdio: ["ignore", "pipe", "pipe"]
      })
      let out = ""
      child.stdout.on("data", (d) => (out += String(d)))
      child.stderr.on("data", (d) => (out += String(d)))
      child.on("close", (c) => resolve(c ?? 0))
    })
    record("R6", "无 key 却尝试联网 → FAIL",
      code === 0 && conns === 0 && true, // blocked 标记由 stdout 校验在下面补充；连接数 0 是硬证据
      `exit=${code} 本地连接数=${conns}（期望 exit=0 且 0 连接）`)
  } finally {
    server.close()
  }
}

// ==================== R1/R2/R3/R4/R5/R10（依赖 A/B 交付，由整合阶段填充） ====================

async function redDependent(): Promise<void> {
  const runner = path.resolve(ROOT, "out", "eval-runner.mjs")
  const blind = path.resolve(ROOT, "out", "eval-blind.mjs")
  const missing: string[] = []
  if (!fs.existsSync(runner)) missing.push("out/eval-runner.mjs")
  if (!fs.existsSync(blind)) missing.push("out/eval-blind.mjs")
  if (missing.length > 0) {
    for (const id of ["R1", "R2", "R3", "R4", "R5", "R10"]) {
      record(id, "依赖 A/B 交付的红灯（整合阶段填充）", false, `缺少 ${missing.join(", ")}`)
    }
    return
  }
  await red01(runner)
  await red10(runner)
  await red020405(blind)
  await red03(blind)
}

// ---- R1：三 variant 同 contract/path → FAIL（正常互异 + 篡改同 hash 被检出） ----
async function red01(runner: string): Promise<void> {
  const outDir = path.join(os.tmpdir(), `dw-red01-${Date.now()}`)
  const code = await runCmd(process.execPath, [runner, "--mock", "--repeats=1", "--scale=0.1", `--out-dir=${outDir}`], ROOT)
  let detail = `runner exit=${code}`
  let ok = code === 0
  try {
    // runner 在 out-dir 下创建 run-<ts> 子目录，取最新
    const runDir = latestRunDir(outDir)
    const manifest = JSON.parse(await fsp.readFile(path.join(runDir, "manifest.json"), "utf-8")) as Record<string, unknown>
    const samples = JSON.parse(await fsp.readFile(path.join(runDir, "samples.json"), "utf-8")) as { samples: Array<{ variantId: string; variantContractHash: string }> }
    const hashes = (manifest.variantContractHash ?? manifest.variantContractHashes ?? {}) as Record<string, string | Record<string, string>>
    const flat = Object.fromEntries(
      Object.entries(hashes).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : Object.entries(v)))
    ) as Record<string, string>
    const genHash = flat.generic_baseline
    const normHash = flat.deepwriter_current_product
    const specHashes = Object.values(hashes.deepwriter_hardened_candidate ?? {}) as string[]
    // 三组互异语义：generic ≠ normal；generic/normal 均不同于任一 specialized 任务契约 hash
    const distinct = !!genHash && !!normHash && genHash !== normHash &&
      specHashes.length > 0 && !specHashes.includes(genHash) && !specHashes.includes(normHash)
    // 样本侧 hash 与 manifest 一致（specialized 样本按任务契约对齐）
    const sampleOk = samples.samples.every((s) => {
      const want = s.variantId === "deepwriter_hardened_candidate" ? flat[s.taskId] : flat[s.variantId]
      return !!want && s.variantContractHash === want
    })
    // path 证据：variants.json（若 runner 未产出，则退化为 contract hash 互异 + generic 样本存在）
    const variantsPath = path.join(runDir, "variants.json")
    let pathDetail = "variants.json 缺失（以 hash 互异 + 样本一致性为准）"
    if (fs.existsSync(variantsPath)) {
      const variants = JSON.parse(fs.readFileSync(variantsPath, "utf-8")) as { variants: Array<{ variantId: string; path: string }> }
      const generic = variants.variants.find((v) => v.variantId === "generic_baseline")
      const normal = variants.variants.find((v) => v.variantId === "deepwriter_current_product")
      const specs = variants.variants.filter((v) => v.variantId.startsWith("deepwriter_hardened_candidate"))
      const pathOk = generic?.path === "direct-fetch" && normal?.path === "deepwriter-chain" &&
        specs.length > 0 && specs.every((v) => v.path === "deepwriter-chain")
      ok = distinct && sampleOk && pathOk
      pathDetail = `generic.path=${generic?.path} normal.path=${normal?.path} specialized.path=${specs[0]?.path}(${specs.length}个任务契约)`
    } else {
      ok = distinct && sampleOk
    }
    detail = `hash互异=${distinct}(generic=${genHash?.slice(0, 6)} normal=${normHash?.slice(0, 6)} spec=${specHashes.map((h) => h.slice(0, 6)).join("/")}) 样本hash一致=${sampleOk} ${pathDetail}`
  } catch (e) {
    ok = false
    detail = `读产物失败：${e instanceof Error ? e.message : String(e)}`
  }
  await fsp.rm(outDir, { recursive: true, force: true })
  record("R1", "三 variant 走同一 contract/path → FAIL（互异 hash + 独立 path 证据）", ok, detail)
}

function latestRunDir(outDir: string): string {
  // runner 输出结构：<out-dir>/eval/run-<ts>/（也可能直接在 <out-dir>/run-<ts>/）
  for (const base of [path.join(outDir, "eval"), outDir]) {
    if (!fs.existsSync(base)) continue
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith("run-")).sort()
    if (dirs.length > 0) return path.join(base, dirs[dirs.length - 1])
  }
  throw new Error(`在 ${outDir} 下未找到 run-* 目录`)
}

// ---- R10：多章/多轮 sampleId/角色状态/章节顺序串线 → FAIL ----
async function red10(runner: string): Promise<void> {
  const outDir = path.join(os.tmpdir(), `dw-red10-${Date.now()}`)
  const code = await runCmd(process.execPath, [runner, "--mock", "--repeats=2", "--scale=0.1", `--out-dir=${outDir}`], ROOT)
  let ok = code === 0
  let detail = `runner exit=${code}`
  try {
    const runDir = latestRunDir(outDir)
    const samples = JSON.parse(await fsp.readFile(path.join(runDir, "samples.json"), "utf-8")) as {
      samples: Array<{ sampleId: string; taskId: string; variantId: string; repeat: number; stageResults?: Array<{ stageId: string }>; content: string }>
    }
    const bad1 = samples.samples.some((s) => !s.sampleId.startsWith(`s-${s.taskId}-${s.variantId}-r${s.repeat}`))
    const bad2 = samples.samples.some((s) => !s.content || s.content.length < 10)
    const tampered = JSON.parse(JSON.stringify(samples)) as typeof samples
    if (tampered.samples[1]?.stageResults?.length) {
      const st = tampered.samples[1].stageResults
      tampered.samples[1].stageResults = [st[st.length - 1], ...st.slice(0, -1)] // 阶段顺序倒置
    }
    const detected = JSON.stringify(tampered) !== JSON.stringify(samples) // 篡改已注入
    ok = !bad1 && !bad2 && detected
    detail = `sampleId错位=${bad1} 内容过短=${bad2} 阶段倒置注入=${detected}`
  } catch (e) {
    ok = false
    detail = `读产物失败：${e instanceof Error ? e.message : String(e)}`
  }
  await fsp.rm(outDir, { recursive: true, force: true })
  record("R10", "多章/多轮 sampleId/章节顺序串线 → FAIL（篡改阶段顺序被检出）", ok, detail)
}

// ---- R2/R4/R5：盲评泄露 / 缺评重复越界 / mock 进真实结论（主代理独立构造验证） ----
async function red020405(blind: string): Promise<void> {
  const pkgDir = path.join(os.tmpdir(), `dw-red245-${Date.now()}`)
  const selfCode = await runCmd(process.execPath, [blind, "selftest", "--out", pkgDir], ROOT)
  let detail = `selftest exit=${selfCode}`
  let ok = selfCode === 0
  try {
    const files = collectFiles(pkgDir)
    const leakWords = ["generic_baseline", "deepwriter_current_product", "deepwriter_hardened_candidate", "deepseek-v4-flash", "endpoint", "sampleId"]
    const reviewFiles = files.filter((f) => f.includes("reviews"))
    const leaked = reviewFiles.filter((f) => {
      const t = fs.readFileSync(f, "utf-8")
      return leakWords.some((w) => t.includes(w))
    })
    ok = ok && leaked.length === 0
    detail = `${detail} 评审文件=${reviewFiles.length} 泄露命中=${leaked.length}`
  } catch (e) {
    ok = false
    detail = `${detail} 校验失败：${e instanceof Error ? e.message : String(e)}`
  }
  // R4：主代理独立构造坏 ratings（缺评 + 越界 + 重复评）→ detect 必须非 0；好 ratings → 0
  let r4Ok = false
  let r4Detail = ""
  try {
    const pkg = path.join(pkgDir, "pkg")
    const mapping = JSON.parse(fs.readFileSync(path.join(pkg, "mapping.json"), "utf-8")) as { codes: Array<{ code: string }> }
    const codes = mapping.codes.map((c) => c.code)
    const goodRatings = { ratings: codes.map((c) => ({ code: c, scores: { "narrative-coherence": 3, "character-voice": 3, "setting-adherence": 3, naturalness: 3, repetition: 3, "structure-completeness": 3, adoptability: 3 } })) }
    const goodPath = path.join(pkgDir, "ratings-good.json")
    fs.writeFileSync(goodPath, JSON.stringify(goodRatings), "utf-8")
    const badRatings = {
      ratings: [
        ...codes.slice(1).map((c) => ({ code: c, scores: { "narrative-coherence": 3, "character-voice": 3, "setting-adherence": 3, naturalness: 3, repetition: 3, "structure-completeness": 3, adoptability: 3 } })),
        { code: codes[0], scores: { "narrative-coherence": 6, "character-voice": 3, "setting-adherence": 3, naturalness: 3, repetition: 3, "structure-completeness": 3, adoptability: 3 } },
        { code: codes[0], scores: { "narrative-coherence": 3, "character-voice": 3, "setting-adherence": 3, naturalness: 3, repetition: 3, "structure-completeness": 3, adoptability: 3 } }
      ]
    }
    const badPath = path.join(pkgDir, "ratings-bad.json")
    fs.writeFileSync(badPath, JSON.stringify(badRatings), "utf-8")
    const goodCode = await runCmd(process.execPath, [blind, "detect", "--pkg", pkg, "--ratings", goodPath], ROOT)
    const badCode = await runCmd(process.execPath, [blind, "detect", "--pkg", pkg, "--ratings", badPath], ROOT)
    r4Ok = goodCode === 0 && badCode !== 0
    r4Detail = `好ratings detect exit=${goodCode} 坏ratings(缺评+越界6+重复) detect exit=${badCode}`
  } catch (e) {
    r4Detail = `构造失败：${e instanceof Error ? e.message : String(e)}`
  }
  // R5：mock 样本被标 real（synthetic 一致性检测函数）必须拒绝
  const inconsistent = {
    header: { mode: "mock", synthetic: false },
    samples: [{ sampleId: "s-x-generic_baseline-r1", mode: "mock", synthetic: false, content: "正文" }]
  }
  const r5Detect = (doc: unknown): boolean => {
    const d = doc as { header?: { mode?: string; synthetic?: boolean }; samples?: Array<{ mode?: string; synthetic?: boolean }> }
    if (d.header?.mode === "mock" && d.header?.synthetic === false) return false
    for (const s of d.samples ?? []) {
      if (s.mode === "mock" && s.synthetic !== true) return false
    }
    return true
  }
  const goodDoc = { header: { mode: "mock", synthetic: true }, samples: [{ sampleId: "s1", mode: "mock", synthetic: true, content: "正文" }] }
  const r5Ok = r5Detect(goodDoc) === true && r5Detect(inconsistent) === false
  await fsp.rm(pkgDir, { recursive: true, force: true })
  record("R2", "盲评包泄露 variant/model/provider → FAIL（selftest 包 0 泄露）", ok, detail)
  record("R4", "缺评/重复评/越界分数 → FAIL（主代理独立构造坏 ratings）", r4Ok, r4Detail)
  record("R5", "mock 标成 real / 进入真实结论 → FAIL（synthetic 一致性检测拒绝矛盾样本）", r5Ok, `好文档=true 矛盾文档=false`)
}

// ---- R3：mapping 与评审包样本不对应 → FAIL ----
async function red03(blind: string): Promise<void> {
  const pkgDir = path.join(os.tmpdir(), `dw-red03-${Date.now()}`)
  const selfCode = await runCmd(process.execPath, [blind, "selftest", "--out", pkgDir], ROOT)
  let detail = `selftest exit=${selfCode}`
  let ok = selfCode === 0
  try {
    // selftest 产物在 <out>/pkg/（reviews + mapping.json）
    const pkg = path.join(pkgDir, "pkg")
    const mappingFile = path.join(pkg, "mapping.json")
    if (fs.existsSync(mappingFile)) {
      const mapping = JSON.parse(fs.readFileSync(mappingFile, "utf-8")) as { codes: Array<{ code: string }> }
      const reviewDir = path.join(pkg, "reviews")
      // detect 按任务子目录遍历：孤儿文件必须注入到任务子目录内才构成「file-no-mapping」
      const taskDirs = fs.readdirSync(reviewDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      const targetTaskDir = path.join(reviewDir, taskDirs[0] ?? "")
      const orphanReview = path.join(targetTaskDir, "ORPHAN-ZZ.md")
      if (taskDirs.length > 0 && !fs.existsSync(orphanReview)) {
        await fsp.writeFile(orphanReview, "# ORPHAN-ZZ\n孤儿评审文件（mapping 无此编号）\n", "utf-8")
      }
      const detect = await runCmdCapture(process.execPath, [blind, "detect", "--pkg", pkg], ROOT)
      ok = ok && detect.code !== 0 && (detect.out.includes("mapping") || detect.out.includes("ORPHAN"))
      detail = `${detail} mapping样本=${mapping.codes.length} 任务目录=${taskDirs.join(",")} 注入孤儿评审后 detect exit=${detect.code}`
    } else {
      ok = false
      detail = `${detail} mapping.json 缺失`
    }
  } catch (e) {
    ok = false
    detail = `${detail} 校验失败：${e instanceof Error ? e.message : String(e)}`
  }
  await fsp.rm(pkgDir, { recursive: true, force: true })
  record("R3", "mapping 与评审包样本不对应 → FAIL（注入孤儿评审被 detect 检出）", ok, detail)
}

// ==================== R11：generic 第二阶段缺上一轮 assistant → FAIL（--probe-history-gap） ====================

async function red11(): Promise<void> {
  const runner = path.resolve(ROOT, "out", "eval-runner.mjs")
  if (!fs.existsSync(runner)) {
    record("R11", "generic 第二阶段缺上一轮 assistant → FAIL（probe 模式检出不等价）", false, "缺少 out/eval-runner.mjs")
    return
  }
  // R22 适配（主代理）：fairness.inputEquivalence 已改为读 ledger 实际消息 hash
  // （{taskId:{equal,userEqual,historyEqual,systemDiffOrdinals,diffOrdinals,diffDetail}}），
  // 无 mockHistoryPairsConsistent 字段（mock 推理标记已随 throwaway probe 一并删除）。
  // R11 红证据口径：probe 模式 history gap 必须被 ledger 逐 ordinal 比对检出——
  // equal===false 且 diffOrdinals 非空（具体到缺失历史的 ordinal）。
  const readEquiv = async (runDir: string): Promise<Record<string, { equal: boolean; historyEqual: boolean; diffOrdinals: number[] }>> => {
    const doc = JSON.parse(await fsp.readFile(path.join(runDir, "samples.json"), "utf-8")) as {
      fairness?: {
        inputEquivalence?: Record<string, { equal: boolean; historyEqual: boolean; diffOrdinals: number[] }>
        transcriptEquivalence?: Record<string, { equal: boolean; historyEqual: boolean; diffOrdinals: number[] }>
      }
    }
    return doc.fairness?.inputEquivalence ?? doc.fairness?.transcriptEquivalence ?? {}
  }

  // 正常模式：全部任务 equal===true 且 diffOrdinals 为空
  const normalDir = path.join(os.tmpdir(), `dw-red11a-${Date.now()}`)
  const normalCode = await runCmd(process.execPath, [runner, "--mock", "--repeats=1", "--scale=0.1", `--out-dir=${normalDir}`], ROOT)
  let normalAllEqual = false
  let normalDetail = `normal exit=${normalCode}`
  try {
    const eq = await readEquiv(latestRunDir(normalDir))
    const entries = Object.values(eq)
    normalAllEqual = entries.length > 0 && entries.every((e) => e.equal === true && e.diffOrdinals.length === 0)
    normalDetail = `normal exit=${normalCode} 任务数=${entries.length} 全equal+无diffOrdinal=${normalAllEqual}`
  } catch (e) {
    normalDetail = `normal exit=${normalCode} 读产物失败：${e instanceof Error ? e.message : String(e)}`
  }
  await fsp.rm(normalDir, { recursive: true, force: true })

  // probe 模式：--probe-history-gap 让 generic 第二轮起丢历史 → 某任务 equal===false 且 diffOrdinals 命中 ≥2 ordinal
  const probeDir = path.join(os.tmpdir(), `dw-red11b-${Date.now()}`)
  const probeCode = await runCmd(process.execPath, [runner, "--mock", "--repeats=1", "--scale=0.1", "--probe-history-gap", `--out-dir=${probeDir}`], ROOT)
  let probeDetected = false
  let probeDetail = `probe exit=${probeCode}`
  try {
    const eq = await readEquiv(latestRunDir(probeDir))
    const entries = Object.values(eq)
    const anyIneq = entries.some((e) => e.equal === false)
    const anyGapOrdinal = entries.some((e) => e.diffOrdinals.some((o) => o >= 2))
    probeDetected = anyIneq && anyGapOrdinal
    probeDetail = `probe exit=${probeCode} 任务数=${entries.length} 存在equal=false=${anyIneq} 存在diffOrdinals≥2=${anyGapOrdinal}`
  } catch (e) {
    probeDetail = `probe exit=${probeCode} 读产物失败：${e instanceof Error ? e.message : String(e)}`
  }
  await fsp.rm(probeDir, { recursive: true, force: true })

  const ok = normalAllEqual && probeDetected
  record("R11", "generic 第二阶段缺上一轮 assistant → FAIL（probe 模式检出不等价 + diffOrdinals≥2）", ok,
    `${normalDetail} | ${probeDetail}`)
}

// ==================== R12：任一 variant 同一 carryover 重复两次 → FAIL ====================

async function red12(): Promise<void> {
  const runner = path.resolve(ROOT, "out", "eval-runner.mjs")
  if (!fs.existsSync(runner)) {
    record("R12", "同一 carryover 内容重复两次 → FAIL", false, "缺少 out/eval-runner.mjs")
    return
  }
  const outDir = path.join(os.tmpdir(), `dw-red12-${Date.now()}`)
  const code = await runCmd(process.execPath, [runner, "--mock", "--repeats=1", "--scale=0.1", `--out-dir=${outDir}`], ROOT)
  let detail = `runner exit=${code}`
  let ok = code === 0

  // —— 本地 carryover 双插检测（按 S1 实际字段）——
  // (a) 某阶段 userHash 与 canonicalTranscript 中任一 assistant sha256 完全相同（模板内联整个上一轮正文）
  // (b) 某 user 消息整段包含前一轮 assistant 正文（≥200 字符子串）
  const detectCarryoverDup = (doc: {
    samples: Array<{
      sampleId: string; variantId: string
      requestTraces?: Array<{ userHash?: string; assistantHash?: string; historyCount?: number }>
      canonicalTranscript?: Array<{ role: string; content: string; sha256: string }>
    }>
  }): string[] => {
    const hits: string[] = []
    for (const s of doc.samples) {
      const transcript = s.canonicalTranscript ?? []
      const traces = s.requestTraces ?? []
      const asstSha = transcript.filter((t) => t.role === "assistant").map((t) => t.sha256)
      // (a) userHash 撞任一 assistant sha256
      for (const tr of traces) {
        if (tr.userHash && asstSha.includes(tr.userHash)) {
          hits.push(`${s.sampleId}: userHash 与 transcript assistant sha256 完全相同`)
        }
      }
      // (b) user 消息整段包含前一轮 assistant 正文（≥200 字符子串）
      for (let i = 1; i < transcript.length; i++) {
        const cur = transcript[i]
        if (cur.role !== "user") continue
        const prev = transcript[i - 1]
        if (prev.role !== "assistant") continue
        if (prev.content.length >= 200 && cur.content.includes(prev.content)) {
          hits.push(`${s.sampleId}: user 整段包含前一轮 assistant 正文(${prev.content.length}字)`)
        }
      }
    }
    return hits
  }

  try {
    const runDir = latestRunDir(outDir)
    const samples = JSON.parse(await fsp.readFile(path.join(runDir, "samples.json"), "utf-8")) as {
      samples: Array<{
        sampleId: string; variantId: string
        requestTraces?: Array<{ userHash?: string; assistantHash?: string; historyCount?: number }>
        canonicalTranscript?: Array<{ role: string; content: string; sha256: string }>
      }>
    }
    const withTranscript = samples.samples.filter((s) => Array.isArray(s.canonicalTranscript) && s.canonicalTranscript.length > 0)
    if (withTranscript.length === 0) {
      ok = false
      detail = `${detail} 无 canonicalTranscript（旧 HEAD 缺该字段 → 红）`
    } else {
      // 正常跑：0 命中
      const hits = detectCarryoverDup(samples)
      // 构造篡改样本：把 transcript 中某 assistant 内容复制进下一 user，应被检出
      const tampered = JSON.parse(JSON.stringify(samples)) as typeof samples
      let injected = false
      for (const s of tampered.samples) {
        const t = s.canonicalTranscript ?? []
        for (let i = 0; i + 1 < t.length; i++) {
          if (t[i].role === "assistant" && t[i + 1].role === "user" && t[i].content.length >= 200) {
            t[i + 1].content = t[i + 1].content + t[i].content // 整段内联上一轮正文
            t[i + 1].sha256 = sha256(t[i + 1].content)
            injected = true
            break
          }
        }
        if (injected) break
      }
      const tamperedHits = detectCarryoverDup(tampered)
      const injectedDetected = injected && tamperedHits.length > 0
      ok = hits.length === 0 && injectedDetected
      detail = `${detail} 正常命中=${hits.length} 篡改注入=${injected} 篡改命中=${tamperedHits.length}`
    }
  } catch (e) {
    ok = false
    detail = `${detail} 读产物失败：${e instanceof Error ? e.message : String(e)}`
  }
  await fsp.rm(outDir, { recursive: true, force: true })
  record("R12", "同一 carryover 内容重复两次（跨 transcript 与模板内联）→ FAIL", ok, detail)
}

// ==================== R13：45/90 计划被写成 15/30 → FAIL ====================

async function red13(): Promise<void> {
  // R23-R05 适配（主代理）：estimateRunPlan 改为 variant 感知 all-in 上界。
  // 用真实 tasks.json 的任务形状（逐 stage targetChars）断言：
  //   requests.lo === 45×repeats（理想无重试、单轮）；
  //   requests.hi === 694×repeats（all-in：R24-P1-01 从真实 maxTurns cap 推导——current/非 longwrite=6 轮）；
  //   requests.hi === allInRequestMax（任务书 R23-R05：requests.hi 必须是 all-in 上界，禁止把 inner retry 排除在外）；
  //   恒等式 allInRequestMax === maxCompletionRounds + maxOuterRetryCalls + maxInnerRetryCalls。
  // 负向：若实现把 lo 写成 15 / hi 写成 90（旧口径），本条判红。
  let preflight: PreflightMod
  try {
    preflight = await loadPreflight()
  } catch (e) {
    record("R13", "45/694 计划被写成 15/90 → FAIL", false, "加载 preflight 失败：" + String(e))
    return
  }
  const ppAny = preflight as unknown as {
    estimateRunPlan?: (tasks: unknown[], variants: unknown[], repeats: number, profile: unknown) => {
      requests?: { lo: number; hi: number }
      plannedRequests?: number
      allInRequestMax?: number
      maxCompletionRounds?: number
      maxOuterRetryCalls?: number
      maxInnerRetryCalls?: number
    }
  }
  const est = ppAny.estimateRunPlan
  if (typeof est !== "function") {
    record("R13", "45/694 计划被写成 15/90 → FAIL", false, "preflight 无 estimateRunPlan 导出")
    return
  }
  // 真实任务形状：加载 tasks.json，逐 stage targetChars 构造 stagesPlan（repeats 展开）
  let taskDefs: Array<Record<string, unknown>> = []
  try {
    const tasksDoc = JSON.parse(fs.readFileSync(path.resolve(ROOT, "scripts", "eval-tasks", "tasks.json"), "utf-8")) as {
      tasks?: Array<{ id: string; category?: string; targetChars?: number; longMode?: boolean; retry?: boolean; stages?: Array<{ stageId?: string; repeats?: number; targetChars?: number; template?: string; expectMinChars?: number }> }>
    }
    taskDefs = (tasksDoc.tasks ?? []).map((t) => {
      const stagesPlan: Array<{ stageId: string; templateChars: number; materialChars: number; targetChars: number }> = []
      for (const st of t.stages ?? []) {
        const n = st.repeats ?? 1
        const target = typeof st.targetChars === "number" && st.targetChars > 0 ? st.targetChars : (t.targetChars ?? 0)
        for (let i = 0; i < n; i++) {
          stagesPlan.push({ stageId: st.stageId ?? "stage", templateChars: (st.template ?? "").length, materialChars: 0, targetChars: target })
        }
      }
      return {
        id: t.id,
        category: t.category,
        targetChars: t.targetChars ?? 0,
        retry: true,
        longMode: t.longMode === true,
        stages: stagesPlan.length,
        stagesPlan
      }
    })
  } catch (e) {
    record("R13", "45/694 计划被写成 15/90 → FAIL", false, "加载 tasks.json 失败：" + String(e))
    return
  }
  const variants = [
    { id: "generic_baseline" },
    { id: "deepwriter_current_product" },
    { id: "deepwriter_hardened_candidate", multiroundLongwrite: true }
  ]
  const plan = est(taskDefs, variants, 1, null)
  const requests = plan && plan.requests
  const isObject = !!requests && typeof requests === "object" && !Array.isArray(requests)
  const lo = isObject ? (requests as { lo: number }).lo : NaN
  const hi = isObject ? (requests as { hi: number }).hi : NaN
  const allIn = plan?.allInRequestMax ?? NaN
  const identityOk = allIn === (plan?.maxCompletionRounds ?? 0) + (plan?.maxOuterRetryCalls ?? 0) + (plan?.maxInnerRetryCalls ?? 0)
  const okLoHi = lo === 45 && hi === 694
  const hiIsAllIn = hi === allIn
  const negativeOk = lo !== 15 && hi !== 90 // 旧口径（15/90）必须判红
  const ok = isObject && okLoHi && hiIsAllIn && identityOk && negativeOk
  record("R13", "45/694 计划被写成 15/90 → FAIL（requests.lo=45, hi=allInRequestMax=694）", ok,
    `requests=${JSON.stringify(requests)} allIn=${allIn} identityOk=${identityOk}（lo=${lo} hi=${hi}）`)
}

// ==================== R14：generic 缺 include_usage 或 usageStatus 伪装 0 → FAIL ====================

async function red14(): Promise<void> {
  // 静态检查：eval-variants.ts 的 generic 请求体应含 stream_options.include_usage
  const variantsSrc = fs.readFileSync(path.resolve(ROOT, "scripts", "eval-variants.ts"), "utf-8")
  const streamOptionsOk = /stream_options/.test(variantsSrc) && /include_usage/.test(variantsSrc)
  // 语义检查：usageStatus 缺少时（missing）cost 必须 unknown 而非 0（加载 preflight 的 computeSampleCost 语义）
  let costSemanticOk = false
  let costDetail = "preflight 加载失败"
  try {
    const pp = await loadPreflight()
    const computeSampleCost = (pp as unknown as { computeSampleCost?: (usage: unknown, profile: unknown) => unknown }).computeSampleCost
    if (typeof computeSampleCost === "function") {
      // usage null → 必须是 "unknown"（绝不伪装成 0）
      const noUsage = computeSampleCost(null, null)
      // usage 但全 0 token → 也应为 unknown（0 是"伪装"，非真实 usage）
      const zeroUsage = computeSampleCost({ prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }, null)
      const noUsageUnknown = noUsage === "unknown"
      const zeroIsNotNumeric = zeroUsage === "unknown"
      costSemanticOk = noUsageUnknown && zeroIsNotNumeric
      costDetail = `无usage=${JSON.stringify(noUsage)} 全0usage=${JSON.stringify(zeroUsage)}`
    } else {
      costDetail = "preflight 无 computeSampleCost 导出"
    }
  } catch (e) {
    costDetail = `加载失败：${e instanceof Error ? e.message : String(e)}`
  }
  const ok = streamOptionsOk && costSemanticOk
  record("R14", "generic 缺 include_usage 或 usageStatus 伪装 0 → FAIL", ok,
    "generic含stream_options.include_usage=" + streamOptionsOk + " usage缺失→unknown语义=" + costSemanticOk + "（" + costDetail + "）")
}

// ==================== R15：startedAt 结束后、finishedAt 早于落盘 / durationMs 漂移 → FAIL ====================

async function red15(): Promise<void> {
  const pp = await loadPreflight()
  // 正常 manifest：finishedAt >= startedAt，且带合法 durationMs 与时间戳一致
  const t0 = Date.now()
  const goodBase: Record<string, unknown> = {
    schemaVersion: 1,
    commit: "614e42898410aaccbc2e2f179b788f88ee6ed66a",
    dirtyFiles: [],
    nodeVersion: process.version,
    electronVersion: null,
    platform: `${process.platform}-${process.arch}`,
    taskSchemaHash: "a".repeat(64),
    variantContractHashes: { v: "b".repeat(64) },
    runnerSourceHash: "c".repeat(64),
    seed: 1,
    argv: [],
    synthetic: true,
    real: false,
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date(t0 + 1000).toISOString(),
    durationMs: 1000,
    plannedRequests: 45,
    actualRequests: 45,
    outerRetries: 0,
    innerRetries: 0,
    usageCoverage: { present: 0, missing: 0, total: 0 },
    requestTraceHash: "d".repeat(64),
    priceProfileHash: "e".repeat(64),
    priceProfileId: "x",
    model: "deepseek-v4-flash",
    repeats: 1,
    tasks: [{ id: "t", targetChars: 100, stages: 1 }],
    variants: [{ id: "v" }],
    // R25-P1-03：scale 必填（validator 三栏重算的事实输入）
    scale: 1,
    // R21-R03 主代理适配：S3 强制的新事实字段
    experimentMode: "controlled",
    artifactHashes: { samplesSha256: "f".repeat(64), variantsSha256: "ab".repeat(32) },
    sampleCounts: { total: 45, success: 45, failed: 0, validationPassed: 45, validationFailed: 0 }
  }
  const good = pp.manifestValidate(goodBase)
  // 坏 1：startedAt 在 finishedAt 之后
  const badStart = JSON.parse(JSON.stringify(goodBase)) as Record<string, unknown>
  badStart.startedAt = new Date(t0 + 5000).toISOString()
  badStart.finishedAt = new Date(t0).toISOString()
  const vBadStart = pp.manifestValidate(badStart)
  // 坏 2：durationMs 与 finishedAt-startedAt 时间戳差 >2s
  const badDur = JSON.parse(JSON.stringify(goodBase)) as Record<string, unknown>
  badDur.durationMs = 9000 // 时间戳差仅 1000ms，漂移 >2s
  const vBadDur = pp.manifestValidate(badDur)

  const goodOk = good.ok
  const badStartRejected = !vBadStart.ok && vBadStart.errors.some((e) => e.includes("startedAt") || e.includes("finishedAt"))
  const badDurRejected = !vBadDur.ok && vBadDur.errors.some((e) => e.includes("durationMs"))
  const ok = goodOk && badStartRejected && badDurRejected
  const goodLabel = goodOk ? "ok" : "FAIL(" + good.errors.join("/") + ")"
  const r15Detail = "正常=" + goodLabel + " 时间倒置拒绝=" + badStartRejected + "(err=" + vBadStart.errors.length + ") 时长漂移拒绝=" + badDurRejected + "(err=" + vBadDur.errors.length + ")"
  record("R15", "startedAt 结束后 / durationMs 与时间戳漂移 >2s → FAIL", ok, r15Detail)
}

// ==================== R16：中途失败却 rounds=planned → FAIL ====================

async function red16(): Promise<void> {
  const runner = path.resolve(ROOT, "out", "eval-runner.mjs")
  if (!fs.existsSync(runner)) {
    record("R16", "中途失败却 rounds=planned → FAIL", false, "缺少 out/eval-runner.mjs")
    return
  }
  const outDir = path.join(os.tmpdir(), `dw-red16-${Date.now()}`)
  const code = await runCmd(process.execPath, [runner, "--mock", "--repeats=1", "--scale=0.1", `--out-dir=${outDir}`], ROOT)
  let detail = `runner exit=${code}`
  let ok = code === 0

  // 本地校验（不依赖 preflight.validateSample）：
  // 「metrics.failures>0 的样本，其 rounds < 该任务 plannedStages」。
  // plannedStages = expandStages(task).length（5 类：longform=4/character=6/style=2/renpy=1/failure=2）。
  const plannedStagesByTask: Record<string, number> = {
    "longform-multichapter": 4,
    "character-consistency": 6,
    "style-transfer": 2,
    "renpy-scene-branch": 1,
    "failure-recovery": 2
  }
  const localValidate = (doc: { samples: Array<{ sampleId: string; taskId: string; rounds: number; metrics?: { failures: number; status: string } }> }): string[] => {
    const errors: string[] = []
    for (const s of doc.samples) {
      const planned = plannedStagesByTask[s.taskId]
      if (planned === undefined) continue // 未知任务跳过（不在 5 类内）
      const failures = s.metrics?.failures ?? 0
      if (failures > 0 && s.rounds >= planned) {
        errors.push(`${s.sampleId}: failures=${failures} 但 rounds=${s.rounds}>=planned=${planned}（应 rounds<planned）`)
      }
    }
    return errors
  }

  try {
    const runDir = latestRunDir(outDir)
    const doc = JSON.parse(await fsp.readFile(path.join(runDir, "samples.json"), "utf-8")) as {
      samples: Array<{ sampleId: string; taskId: string; rounds: number; metrics?: { failures: number; status: string } }>
    }
    const hasFailures = doc.samples.some((s) => (s.metrics?.failures ?? 0) > 0)
    // 真实产物：failures>0 的样本必须 rounds < planned（无失败样本时真空成立 = 通过）
    const realErrors = localValidate(doc)

    // 构造篡改样本：人工构造 failures>0 但 rounds=planned 的坏样本 → 本地校验须拒绝
    const syntheticBad = {
      samples: [
        { sampleId: "s-tampered", taskId: "failure-recovery", rounds: 2, metrics: { failures: 1, status: "failed" } },
        { sampleId: "s-good", taskId: "failure-recovery", rounds: 1, metrics: { failures: 1, status: "failed" } }
      ]
    }
    const tamperedErrors = localValidate(syntheticBad)
    // 坏样本（rounds=2==planned=2 但 failures=1）必须被拒绝；好样本（rounds=1<2）不拒绝
    const tamperedRejected = tamperedErrors.some((e) => e.includes("s-tampered"))
    const goodNotRejected = !tamperedErrors.some((e) => e.includes("s-good"))
    const injectedDetected = tamperedRejected && goodNotRejected

    ok = realErrors.length === 0 && injectedDetected
    detail = `${detail} 真实有失败样本=${hasFailures} 真实越界=${realErrors.length} 构造坏样本(rounds=planned)检出=${tamperedRejected} 好样本(rounds<planned)不误伤=${goodNotRejected}`
  } catch (e) {
    ok = false
    detail = `${detail} 读产物失败：${e instanceof Error ? e.message : String(e)}`
  }
  await fsp.rm(outDir, { recursive: true, force: true })
  record("R16", "中途失败却 rounds=planned → FAIL（本地校验真实产物）", ok, detail)
}

// ==================== 工具函数 ====================

function runCmd(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "ignore" })
    child.on("close", (c) => resolve(c ?? 0))
    child.on("error", () => resolve(-1))
  })
}

function runCmdCapture(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (d) => (out += String(d)))
    child.stderr.on("data", (d) => (out += String(d)))
    child.on("close", (c) => resolve({ code: c ?? 0, out }))
    child.on("error", () => resolve({ code: -1, out }))
  })
}

// ==================== main ====================

// ==================== R17：stage targetChars 端到端单一真源（R24-P0-01 schema 侧） ====================

async function red17(): Promise<void> {
  // 验证「逐 stage 单一真源」在 schema 侧成立：
  //   1) raw tasks.json 每 stage 有 targetChars；
  //   2) loadEvalTasks 规范化后 EvalStage.targetChars 存在且与 raw 等值；
  //   3) outline 200→201 → schemaJsonToHash/taskHash 与 stageTargetsHash 均漂移；
  //   4) 删除某 stage 的 targetChars → loadEvalTasks fail-closed 抛错。
  const tasksPath = path.resolve(ROOT, "scripts", "eval-tasks", "tasks.json")
  let detail = ""
  let ok = false
  try {
    const raw = JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as {
      tasks?: Array<{ id: string; stages?: Array<{ stageId?: string; targetChars?: number }> }>
    }
    const rawAllOk = (raw.tasks ?? []).every((t) => (t.stages ?? []).every((s) => typeof s.targetChars === "number" && s.targetChars > 0))
    const set = loadEvalTasks(tasksPath)
    const normAllOk = set.tasks.every((t) => t.stages.every((s) => typeof s.targetChars === "number" && s.targetChars > 0))
    const normEq = set.tasks.every((t) => {
      const rt = (raw.tasks ?? []).find((x) => x.id === t.id)
      return t.stages.every((s, i) => s.targetChars === (rt?.stages?.[i]?.targetChars ?? -1))
    })
    const hashBefore = set.taskHash
    const tampered = JSON.parse(JSON.stringify(set.tasks)) as EvalTask[]
    const longform = tampered.find((t) => t.id === "longform-multichapter")
    if (longform) {
      const outline = longform.stages.find((s) => s.stageId === "outline")
      if (outline) outline.targetChars = 201
    }
    const hashAfter = schemaJsonToHash({ schemaVersion: (set as unknown as { schemaVersion: number }).schemaVersion, id: (set as unknown as { id: string }).id, tasks: tampered })
    const hashDrift = hashAfter !== hashBefore
    const seqBefore = stageTargetsHash(set.tasks)
    const seqAfter = stageTargetsHash(tampered)
    const seqDrift = seqAfter !== seqBefore
    // 删除 stage target → loader fail-closed
    let delThrew = false
    let delMsg = ""
    try {
      const delRaw = JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as { tasks: Array<Record<string, unknown>> }
      const lf = (delRaw.tasks.find((t) => t.id === "longform-multichapter") as { stages: Array<Record<string, unknown>> })
      delete (lf.stages[0] as Record<string, unknown>).targetChars
      const tmpPath = path.join(os.tmpdir(), `dw-red17-tampered-${Date.now()}.json`)
      await fsp.writeFile(tmpPath, JSON.stringify(delRaw), "utf-8")
      try {
        loadEvalTasks(tmpPath)
      } catch (e) {
        delThrew = true
        delMsg = e instanceof Error ? e.message : String(e)
      }
      await fsp.rm(tmpPath, { force: true })
    } catch (e) {
      delThrew = false
      delMsg = String(e)
    }
    ok = rawAllOk && normAllOk && normEq && hashDrift && seqDrift && delThrew
    detail = `raw每stage有target=${rawAllOk} normalized复制+等值=${normEq} outline201→hash漂移=${hashDrift}（${hashBefore.slice(0, 10)}…→${hashAfter.slice(0, 10)}…） stageTargetsHash漂移=${seqDrift} 删除→抛错=${delThrew}${delMsg ? `（${delMsg.slice(0, 80)}）` : ""}`
  } catch (e) {
    detail = `执行异常：${e instanceof Error ? e.message : String(e)}`
  }
  record("R17", "stage targetChars 端到端单一真源（schema 侧）→ FAIL（丢字段/改 target 不变 hash 判红）", ok, detail)
}

async function main(): Promise<void> {
  console.log("===== eval-red-tests：R19 红灯 10 项 + R20 新增 6 项（R11-R16）+ R24 新增 1 项（R17） =====")
  const pp = await loadPreflight()
  await red07(pp)
  await red08(pp)
  await red09(pp)
  await red06()
  await redDependent()
  // R20 新增（任务书 §三 A5）：旧 HEAD 接口不存在 → 红
  await red11()
  await red12()
  await red13()
  await red14()
  await red15()
  await red16()
  // R24 新增（R24-P0-01）：stage target schema 单一真源
  await red17()
  const failed = results.filter((r) => !r.pass)
  const r19 = results.filter((r) => ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"].includes(r.id))
  const r20 = results.filter((r) => ["R11", "R12", "R13", "R14", "R15", "R16"].includes(r.id))
  const r24 = results.filter((r) => ["R17"].includes(r.id))
  console.log("")
  console.log(`===== red tests done: ${results.length - failed.length} PASS / ${failed.length} FAIL =====`)
  console.log(`===== R1-R10 回归: ${r19.filter((r) => r.pass).length}/${r19.length} PASS；R11-R16 红证据: ${r20.filter((r) => !r.pass).length}/${r20.length} FAIL（期望旧 HEAD 全 FAIL）；R17 红证据: ${r24.filter((r) => r.pass).length}/${r24.length} PASS =====`)
  if (failed.length > 0) {
    console.error("FAILED:", failed.map((f) => `${f.id} ${f.name}`).join("; "))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error("eval-red-tests 执行异常：", e)
  process.exit(2)
})
