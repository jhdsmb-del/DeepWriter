// ==================== DeepWriter R21-R04 评估 — endpoint-down 退出码集成测试 ====================
// S3（Manifest & Exit）交付。验证 runner 在「endpoint 不可达 / real 无 key」下的退出码与失败退出口径。
//
// 场景 A（endpoint-down，旧行为红证据）：
//   起一个本地 http server 但**不 listen**（端口必然拒绝连接），设 DEEPSEEK_BASE_URL 指向它 + 假 key，
//   以子进程跑 out/eval-runner.mjs --real --repeats=1 --task=style-transfer。
//   - 期望目标（R21-R04 新口语）：exit 非 0。
//   - 当前旧 runner：endpoint-down 时样本次轮失败但 exit 0（红）——本测试记录该旧行为。
// 场景 B（blocked 无 key）：
//   DEEPSEEK_BASE_URL 同样指死端口，但**不**设 key，跑 --real。
//   - 期望：exit 0 且输出含 blocked / not_run（R20 语义保持，不创建伪 real 结果）。
//
// 用法：
//   node out/eval-exit-integration.mjs                # 断言新口语（endpoint-down 非 0；blocked 0）
//   node out/eval-exit-integration.mjs --expect-old-fail   # 记录旧 runner 行为（endpoint-down 应为 0 = 红）
//
// 铁律：0 次真实 API 请求（DEEPSEEK_BASE_URL 指向必拒不监听的死端口，假 key "test-key"）；不 git 写操作。

import * as http from "node:http"
import * as path from "node:path"
import * as url from "node:url"
import { spawnSync } from "node:child_process"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const RUNNER = path.join(ROOT, "out", "eval-runner.mjs")

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** 返回一个「已释放、必拒不监听」的死端口：listen 拿到真实端口后 close，后续连接必 ECONNREFUSED。 */
async function reserveDeadPort(): Promise<number> {
  const s = http.createServer()
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()))
  const addr = s.address() as { port: number } | null
  const port = addr?.port ?? 0
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

function spawnRunner(env: Record<string, string>, extraArgs: string[]): RunResult {
  const r = spawnSync(process.execPath, [RUNNER, "--real", "--repeats=1", "--task=style-transfer", ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 120_000
  })
  const code = r.status ?? (r.error ? 127 : 1)
  return { exitCode: code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const expectOldFail = args.includes("--expect-old-fail")

  const deadPort = await reserveDeadPort()
  const deadBase = `http://127.0.0.1:${deadPort}`

  console.log(`===== eval-exit-integration（endpoint-down 退出码口径） =====`)
  console.log(`runner: ${RUNNER}`)
  console.log(`dead endpoint: ${deadBase}（从未 listen，连接必然 ECONNREFUSED）`)
  console.log(`模式: ${expectOldFail ? "记录旧行为（红）" : "断言新口语（绿）"}`)
  console.log("")

  // 场景 A：endpoint-down（有假 key，非 blocked）
  const envDown = { DEEPSEEK_BASE_URL: deadBase, DEEPSEEK_API_KEY: "test-key" }
  console.log("--- 场景 A：endpoint-down（假 key） ---")
  const a = spawnRunner(envDown, [])
  console.log(`  exitCode=${a.exitCode}`)
  console.log(`  stdout(尾): ${a.stdout.trim().split("\n").slice(-4).join(" | ")}`)
  if (a.stderr.trim()) console.log(`  stderr(尾): ${a.stderr.trim().split("\n").slice(-4).join(" | ")}`)

  // 场景 B：blocked（无 key）
  const envBlocked = { DEEPSEEK_BASE_URL: deadBase, DEEPSEEK_API_KEY: "" }
  console.log("")
  console.log("--- 场景 B：blocked（无 key） ---")
  const b = spawnRunner(envBlocked, [])
  console.log(`  exitCode=${b.exitCode}`)
  const combined = (b.stdout + "\n" + b.stderr)
  const blockedHit = /blocked|not_run|missing_api_key/i.test(combined)
  console.log(`  输出含 blocked/not_run: ${blockedHit}`)

  console.log("")
  let aOk = true
  let bOk = true

  if (expectOldFail) {
    // 记录旧行为：endpoint-down 旧 runner 应 exit 0（红）；blocked 应 exit 0（绿）
    aOk = a.exitCode === 0
    bOk = b.exitCode === 0 && blockedHit
    console.log("  [expect-old-fail] 记录结果：")
    console.log(`    场景 A endpoint-down 旧行为: exit=${a.exitCode}（期望 0 = 旧实现绿/新口语的红证据）`)
    console.log(`    场景 B blocked: exit=${b.exitCode} blockedHit=${blockedHit}（期望 0 且命中 blocked）`)
  } else {
    // 新口语断言：endpoint-down 非 0；blocked 0 且含 blocked
    aOk = a.exitCode !== 0
    bOk = b.exitCode === 0 && blockedHit
    console.log("  [expect-new] 断言结果：")
    console.log(`    场景 A endpoint-down: exit=${a.exitCode}（期望 非 0） → ${aOk ? "PASS" : "FAIL"}`)
    console.log(`    场景 B blocked: exit=${b.exitCode} blockedHit=${blockedHit}（期望 0 且命中） → ${bOk ? "PASS" : "FAIL"}`)
  }

  const overall = aOk && bOk
  console.log("")
  console.log(`===== 结果: ${overall ? "PASS" : "FAIL"} =====`)
  if (!overall) process.exit(1)
}

main().catch((e) => {
  console.error("eval-exit-integration 执行异常：", e)
  process.exit(2)
})
