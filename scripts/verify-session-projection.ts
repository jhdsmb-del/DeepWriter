// ==================== R23-R01 sessionProjection 验证（0 真实 API，electron-shim） ====================
// 用 electron-shim 方式（eval-orchestration-selftest 的 loadTsModule 同款）加载
// src/main/sessionProjection.ts，构造内存 deps 验证 projectTerminalAssistant 语义：
//   1) 正常投影 seq = max(seq)+1
//   2) 同 msg_id 重放幂等（原 seq 覆盖不重复）
//   3) appendSessionMessage 抛错 → ok=false
//   4) 无 assistant turn → projected=false
//   5) R24 P0-02 多轮：composeRunAssistantContent 累计全部 assistant 正文（无分隔、乱序 seq 排序、
//      逐轮 chars/hashes），projectTerminalAssistant 投影正文 === A+B+C（幂等重放仍同）
import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import { createRequire } from "node:module"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const require = createRequire(import.meta.url)
const esbuild = require("esbuild") as { build(opts: Record<string, unknown>): Promise<unknown> }

const ELECTRON_SHIM = {
  name: "electron-shim",
  setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "electron-shim" }))
    build.onLoad({ filter: /.*/, namespace: "electron-shim" }, () => ({ contents: "export {};", loader: "js" }))
  }
}

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(ROOT, rel)
  const outfile = path.resolve(ROOT, "out", `verify-proj-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs], bundle: true, format: "esm", platform: "node", target: "node20",
      write: true, outfile, external: ["iconv-lite", "pdf-parse", "mammoth", "fflate", "node:sqlite"],
      logLevel: "silent", plugins: [ELECTRON_SHIM]
    })
    return (await import(url.pathToFileURL(outfile).href)) as Record<string, unknown>
  } finally {
    try { await fs.promises.unlink(outfile) } catch { /* ignore */ }
  }
}

const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail = ""): void => { checks.push({ name, ok, detail }) }

const mod = await loadTsModule("src/main/sessionProjection.ts")
const projectTerminalAssistant = mod.projectTerminalAssistant as (deps: Record<string, unknown>, runId: string, sessionId: string, runStatus: string) => { ok: boolean; projected: boolean; msgId?: string; reason?: string }
const composeRunAssistantContent = mod.composeRunAssistantContent as (turns: Array<{ role: string; content: string; reasoning_content?: string | null; turn_seq?: number }>) => { content: string; reasoning: string; turnCount: number; turnChars: number[]; turnHashes: string[] }

// --- 场景 1：正常投影，seq 取 max(seq)+1（现有消息 seq 有空洞：1, 3, 5） ---
{
  const turns = [
    { role: "user", content: "user turn", reasoning_content: null },
    { role: "assistant", content: "", reasoning_content: "" },
    { role: "assistant", content: "final answer", reasoning_content: "reasoning text" }
  ]
  const messages = [
    { msg_id: "m_other_1", seq: 1 },
    { msg_id: "m_other_2", seq: 3 },
    { msg_id: "m_other_3", seq: 5 }
  ]
  const appended: Array<Record<string, unknown>> = []
  let touched = 0
  const res = projectTerminalAssistant({
    getTurnsByRun: () => turns,
    getSessionMessages: () => messages,
    appendSessionMessage: (m) => { appended.push(m) },
    touchSession: () => { touched += 1 }
  }, "run_1", "sess_1", "completed")
  check("正常投影 ok=true", res.ok === true, JSON.stringify(res))
  check("正常投影 projected=true", res.projected === true, JSON.stringify(res))
  check("seq = max(seq)+1 = 6（不走 length+1=4）", appended[0]?.seq === 6, `seq=${appended[0]?.seq}`)
  check("msg_id = m_run_1_assistant", appended[0]?.msg_id === "m_run_1_assistant", `msg_id=${appended[0]?.msg_id}`)
  check("status = done（completed）", appended[0]?.status === "done", `status=${appended[0]?.status}`)
  check("content 为最后一条 assistant", appended[0]?.content === "final answer", `content=${appended[0]?.content}`)
  check("reasoning 透传", appended[0]?.reasoning === "reasoning text", `reasoning=${appended[0]?.reasoning}`)
  check("touchSession 被调用", touched === 1, `touched=${touched}`)
}

// --- 场景 2：同 msg_id 重放幂等（原 seq 覆盖，不重复 append） ---
{
  const turns = [{ role: "assistant", content: "answer", reasoning_content: null }]
  const messages = [
    { msg_id: "m_run_2_assistant", seq: 7 },
    { msg_id: "m_other", seq: 2 }
  ]
  let appendCount = 0
  const appended: Array<Record<string, unknown>> = []
  const res = projectTerminalAssistant({
    getTurnsByRun: () => turns,
    getSessionMessages: () => messages,
    appendSessionMessage: (m) => { appendCount += 1; appended.push(m) },
    touchSession: () => {}
  }, "run_2", "sess_2", "cancelled")
  check("重放 ok=true", res.ok === true, JSON.stringify(res))
  check("重放 projected=true", res.projected === true, JSON.stringify(res))
  check("重放复用原 seq=7", appended[0]?.seq === 7, `seq=${appended[0]?.seq}`)
  check("重放不重复追加（append 仅 1 次）", appendCount === 1, `appendCount=${appendCount}`)
  check("status = stopped（cancelled）", appended[0]?.status === "stopped", `status=${appended[0]?.status}`)
}

// --- 场景 3：appendSessionMessage 抛错 → ok=false, reason=String(err) ---
{
  const turns = [{ role: "assistant", content: "answer", reasoning_content: null }]
  const res = projectTerminalAssistant({
    getTurnsByRun: () => turns,
    getSessionMessages: () => [],
    appendSessionMessage: () => { throw new Error("db locked") },
    touchSession: () => {}
  }, "run_3", "sess_3", "completed")
  check("抛错 ok=false", res.ok === false, JSON.stringify(res))
  check("抛错 reason=String(err)", res.reason === "Error: db locked", `reason=${res.reason}`)
}

// --- 场景 4：无 assistant turn → projected=false（非失败） ---
{
  const res1 = projectTerminalAssistant({
    getTurnsByRun: () => [{ role: "user", content: "only user", reasoning_content: null }],
    getSessionMessages: () => [],
    appendSessionMessage: () => {},
    touchSession: () => {}
  }, "run_4", "sess_4", "completed")
  check("无 assistant（全 user）→ projected=false", res1.ok === true && res1.projected === false, JSON.stringify(res1))

  // assistant 存在但 content 与 reasoning_content 均空 → 仍视为无内容，projected=false
  const res2 = projectTerminalAssistant({
    getTurnsByRun: () => [{ role: "assistant", content: "", reasoning_content: null }],
    getSessionMessages: () => [],
    appendSessionMessage: () => {},
    touchSession: () => {}
  }, "run_4b", "sess_4b", "completed")
  check("assistant 内容全空 → projected=false", res2.ok === true && res2.projected === false, JSON.stringify(res2))
}

// --- 场景 5：R24 P0-02 多轮正文累计（composeRunAssistantContent + projectTerminalAssistant） ---
{
  const { createHash } = await import("node:crypto")
  const A = "正文第一部分"
  const B = "正文第二部分（更长）"
  const C = "正文第三部分收尾"

  // 乱序输入：turn_seq 3, 1, 2；中间夹 user turn 与空 content assistant turn（应被过滤）
  const turns = [
    { role: "assistant", content: C, reasoning_content: "reason C", turn_seq: 3 },
    { role: "user", content: "user 干扰项", reasoning_content: null },
    { role: "assistant", content: A, reasoning_content: "reason A", turn_seq: 1 },
    { role: "assistant", content: "", reasoning_content: "empty content", turn_seq: 4 },
    { role: "assistant", content: B, reasoning_content: null, turn_seq: 2 }
  ]

  const composed = composeRunAssistantContent(turns)
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex")

  check("compose content === A+B+C（无分隔）", composed.content === A + B + C, `content=${JSON.stringify(composed.content)}`)
  check("compose content.length === lenA+lenB+lenC", composed.content.length === A.length + B.length + C.length, `len=${composed.content.length} vs ${A.length + B.length + C.length}`)
  check("compose turnCount === 3", composed.turnCount === 3, `turnCount=${composed.turnCount}`)
  check("compose turnChars === [lenA,lenB,lenC]", JSON.stringify(composed.turnChars) === JSON.stringify([A.length, B.length, C.length]), `turnChars=${JSON.stringify(composed.turnChars)}`)
  check("compose turnHashes === [sha(A),sha(B),sha(C)]", JSON.stringify(composed.turnHashes) === JSON.stringify([sha(A), sha(B), sha(C)]), `turnHashes=${JSON.stringify(composed.turnHashes)}`)
  check("compose reasoning === reason A\nreason C（按 turn 顺序换行）", composed.reasoning === "reason A\nreason C", `reasoning=${JSON.stringify(composed.reasoning)}`)

  // projectTerminalAssistant 投影正文 === A+B+C，幂等重放仍同 seq 不重复
  const messages = [{ msg_id: "m_run_5_assistant", seq: 9 }]
  const appended: Array<Record<string, unknown>> = []
  const res = projectTerminalAssistant({
    getTurnsByRun: () => turns,
    getSessionMessages: () => messages,
    appendSessionMessage: (m) => { appended.push(m) },
    touchSession: () => {}
  }, "run_5", "sess_5", "completed")
  check("多轮投影 ok=true", res.ok === true, JSON.stringify(res))
  check("多轮投影 projected=true", res.projected === true, JSON.stringify(res))
  check("多轮投影正文 === A+B+C", appended[0]?.content === A + B + C, `content=${JSON.stringify(appended[0]?.content)}`)
  check("多轮投影 reasoning === reason A\nreason C", appended[0]?.reasoning === "reason A\nreason C", `reasoning=${JSON.stringify(appended[0]?.reasoning)}`)
  check("多轮投影复用原 seq=9（幂等）", appended[0]?.seq === 9, `seq=${appended[0]?.seq}`)

  // 幂等重放：再次以同 msg_id 投影，正文仍 A+B+C，不重复追加
  const appended2: Array<Record<string, unknown>> = []
  const res2 = projectTerminalAssistant({
    getTurnsByRun: () => turns,
    getSessionMessages: () => messages,
    appendSessionMessage: (m) => { appended2.push(m) },
    touchSession: () => {}
  }, "run_5", "sess_5", "completed")
  check("多轮幂等重放 ok=true", res2.ok === true, JSON.stringify(res2))
  check("多轮幂等重放正文仍 A+B+C", appended2[0]?.content === A + B + C, `content=${JSON.stringify(appended2[0]?.content)}`)
}

const failed = checks.filter((c) => !c.ok)
for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`)
console.log(`\n===== sessionProjection 验证 ${failed.length === 0 ? "PASS" : "FAIL"}：${checks.length - failed.length}/${checks.length} 通过 =====`)
process.exit(failed.length === 0 ? 0 : 1)
