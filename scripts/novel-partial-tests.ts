// ==================== DeepWriter R21-R08 生产 partial 恢复活路径验证 ====================
// 角色：S6 Product Edge。从真实 runNovelExport 函数驱动（活路径），不测 writingService。
// 验证：
//   1. longGenerateImpl 先 onEvent 部分正文后抛错 → runNovelExport 返回 partial 语义；
//   2. 草稿文件落盘到 userData/deepwriter-partial/<sessionId>-<ts>.md 且存在；
//   3. 不 emit stage='done'；
//   4. continueNovelExport / continueFrom 续写请求不含完整 partial 原文（只注入尾部）。
//
// 运行：
//   node_modules\.bin\esbuild.cmd scripts/novel-partial-tests.ts --bundle --format=esm --platform=node --outfile=out/novel-partial-tests.mjs
//   node out/novel-partial-tests.mjs
//
// 0 次真实 API 请求（mock 注入 longGenerateImpl）；不写 git。

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import * as os from "node:os"
import { createRequire } from "node:module"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const require = createRequire(import.meta.url)
const esbuild = require("esbuild") as { build(opts: Record<string, unknown>): Promise<unknown> }

// 用独立临时 userData，避免污染真实用户数据，也便于断言草稿路径。
const USER_DATA_DIR = path.join(os.tmpdir(), `dw-partial-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
fs.mkdirSync(USER_DATA_DIR, { recursive: true })

// ---------------- electron-shim（getPath 指向临时 userData） ----------------
const ELECTRON_SHIM = {
  name: "electron-shim",
  setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "electron-shim" }))
    build.onLoad({ filter: /.*/, namespace: "electron-shim" }, () => ({
      contents: [
        `const USER_DATA = ${JSON.stringify(USER_DATA_DIR)};`,
        "export const app = { getPath: (n) => n === 'userData' ? USER_DATA : '/tmp/'+String(n), isPackaged: false };",
        "export const dialog = { showMessageBox: async () => ({ response: 1 }), showSaveDialog: async () => ({ canceled: true }) };",
        "export const ipcMain = { handle: () => undefined, on: () => undefined };",
        "export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => null, decryptString: () => \"\" };",
        "export const shell = { openExternal: () => undefined, openPath: async () => \"\" };",
        "export const clipboard = { writeText: () => undefined };",
        "export const Menu = { buildFromTemplate: (t) => ({ popup: () => undefined, template: t }) };"
      ].join("\n"),
      loader: "js"
    }))
  }
}

async function loadNovelModule(): Promise<Record<string, unknown>> {
  const abs = path.resolve(ROOT, "src/main/novel.ts")
  const outfile = path.resolve(ROOT, "out", `partial-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: true,
      outfile,
      external: ["iconv-lite", "pdf-parse", "mammoth", "fflate", "node:sqlite", "docx"],
      logLevel: "silent",
      plugins: [ELECTRON_SHIM]
    })
    return (await import(url.pathToFileURL(outfile).href)) as Record<string, unknown>
  } finally {
    try { await fs.promises.unlink(outfile) } catch { /* ignore */ }
  }
}

interface Result { id: string; name: string; pass: boolean; detail: string }
const results: Result[] = []
function record(id: string, name: string, pass: boolean, detail: string): void {
  results.push({ id, name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${id} ${name}${detail ? " — " + detail : ""}`)
}

const cps = (s: string): number => Array.from(s).length

async function main(): Promise<void> {
  console.log("===== novel-partial-tests：R21-R08 生产 partial 恢复 =====")
  const mod = await loadNovelModule()
  const runNovelExport = mod.runNovelExport as
    | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
    | undefined
  const continueNovelExport = mod.continueNovelExport as
    | ((opts: Record<string, unknown>, partialContent: string) => Promise<Record<string, unknown>>)
    | undefined
  const buildContinueRequest = mod.buildContinueRequest as
    | ((baseRequest: Array<{ role: string; content: string }>, partialContent: string, tailChars?: number) => Array<{ role: string; content: string }>)
    | undefined
  if (typeof runNovelExport !== "function" || typeof continueNovelExport !== "function" || typeof buildContinueRequest !== "function") {
    console.error("缺少接口 runNovelExport / continueNovelExport / buildContinueRequest")
    process.exit(2)
  }

  // 用一段 >200 字的正文，确保「只注入尾部 200 字」不等于「注入全文」
  let fullText = ""
  for (let i = 0; i < 40; i++) fullText += `第${i}段：这是已经生成的小说正文内容，包含人物、情节与伏笔的持续推进。`
  fullText += "（流在此中断）"

  // ---------- mock longGenerateImpl：先 emit 部分正文，再抛错 ----------
  const mockThrowAfterPartial = async (opts: { onEvent?: (ev: { type: string; delta?: string }) => void }): Promise<never> => {
    for (const ch of fullText) {
      opts.onEvent?.({ type: "text", delta: ch })
    }
    throw new Error("stream broken mid-flight")
  }

  const emittedStages: string[] = []
  const emittedMessages: string[] = []
  const onEvent = (ev: { stage: string; message?: string; error?: string; path?: string }): void => {
    emittedStages.push(ev.stage)
    if (ev.message) emittedMessages.push(ev.message)
  }

  const baseOpts = {
    sessionId: "sess-p1",
    format: "md",
    request: [
      { role: "system", content: "你是一名小说整理专家。" },
      { role: "user", content: "把素材整理成小说。" }
    ],
    suggestedName: "novel",
    apiKey: "x",
    baseUrl: "http://127.0.0.1:9",
    model: "m",
    maxTokens: 8192,
    targetChars: 50000,
    onEvent,
    longGenerateImpl: mockThrowAfterPartial
  }

  const result = await runNovelExport(baseOpts)

  // 断言 1：返回 partial 语义
  const partial = result.partial === true
  const partialContent = (result.partialContent as string) ?? ""
  const partialChars = result.partialChars as number
  const partialContentMatches = partialContent === fullText
  const partialCharsOk = partialChars === cps(fullText)
  const okFalse = result.ok === false

  // 断言 2：草稿文件落盘且存在
  const draftPath = result.draftPath as string | undefined
  const draftExists = !!draftPath && fs.existsSync(draftPath)
  const draftDirOk = !!draftPath && path.dirname(draftPath).endsWith("deepwriter-partial")
  let draftContentMatches = false
  if (draftPath && draftExists) {
    draftContentMatches = fs.readFileSync(draftPath, "utf-8") === fullText
  }

  // 断言 3：不 emit done
  const noDone = !emittedStages.includes("done")
  const hasErrorStage = emittedStages.includes("error")
  const msgHasDraftPath = !!draftPath && emittedMessages.some((m) => m.includes(draftPath))

  record(
    "P1",
    "流中断→返回 partial 语义 + 草稿落盘 + 不 emit done",
    partial && okFalse && partialContentMatches && partialCharsOk && draftExists && draftDirOk && draftContentMatches && noDone && hasErrorStage && msgHasDraftPath,
    `ok=${result.ok} partial=${partial} partialChars=${partialChars}(期望${cps(fullText)}) content匹配=${partialContentMatches} draft存在=${draftExists} draft内容匹配=${draftContentMatches} stages=[${emittedStages.join(",")}] message含路径=${msgHasDraftPath}`
  )

  // 断言 4：continueNovelExport 续写请求不重复完整 partial 原文
  // 捕获续写实际传入 longGenerateImpl 的 messages（真实路径）
  let continueMessages: Array<{ role: string; content: string }> | null = null
  const continueMock = async (opts: { messages: Array<{ role: string; content: string }> }): Promise<never> => {
    continueMessages = opts.messages
    throw new Error("stop after capturing request")
  }
  const continueOpts = { ...baseOpts, longGenerateImpl: continueMock }
  const emittedStages2: string[] = []
  continueOpts.onEvent = (ev: { stage: string; message?: string }): void => { emittedStages2.push(ev.stage); if (ev.message) emittedMessages.push(ev.message) }
  delete continueOpts.targetChars
  void emittedStages2

  const contResult = await continueNovelExport({ ...continueOpts, targetChars: 50000 }, fullText)

  // 续写请求构造：只注入尾部 200 字，不能整段重复 fullText
  let continueRequestOk = false
  let tailInjected = false
  let fullDuplicated = false
  if (continueMessages) {
    const userContent = continueMessages.filter((m) => m.role === "user").map((m) => m.content).join("\n")
    // 不能包含完整 partial 原文
    fullDuplicated = userContent.includes(fullText)
    // 只能注入尾部 200 字（全文 < 200 字时全部注入；此处 fullText > 200，应只含尾部）
    const tail = Array.from(fullText).slice(-200).join("")
    tailInjected = userContent.includes(tail)
    continueRequestOk = !fullDuplicated && tailInjected
  }

  record(
    "P2",
    "continueNovelExport 请求只注入尾部、不重复完整 partial 原文",
    continueRequestOk && contResult.partial === true,
    `续写不重复全文=${!fullDuplicated} 注入尾部200字=${tailInjected} 续写返回partial=${contResult.partial}`
  )

  // 断言 5：buildContinueRequest 单元（尾部 200 字 + 不含全文）
  const req = buildContinueRequest(
    [{ role: "system", content: "S" }, { role: "user", content: "写小说" }],
    fullText
  )
  const userName = req.filter((m) => m.role === "user").map((m) => m.content).join("\n")
  const unitTailOk = userName.includes(Array.from(fullText).slice(-200).join(""))
  const unitNoFull = !userName.includes(fullText)
  record(
    "P3",
    "buildContinueRequest 只注入尾部200字、不含完整原文",
    unitTailOk && unitNoFull,
    `尾部注入=${unitTailOk} 不含全文=${unitNoFull}`
  )

  const passed = results.filter((r) => r.pass)
  const failed = results.filter((r) => !r.pass)
  console.log("")
  console.log(`===== novel-partial-tests done: ${passed.length} PASS / ${failed.length} FAIL =====`)

  // 清理临时 userData
  try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }) } catch { /* ignore */ }

  if (failed.length > 0) {
    console.error("FAILED:", failed.map((f) => `${f.id} ${f.name}`).join("; "))
    process.exit(1)
  }
  console.log(`all ${passed.length} partial tests green`)
}

main().catch((e) => {
  console.error("novel-partial-tests 异常：", e)
  process.exit(2)
})
