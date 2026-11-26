// ==================== DeepWriter R21-R07 截断证据严格重建验证 ====================
// 角色：S6 Product Edge。验证 buildNovelMaterial 的 evidence（keptIntervals + insertedSegments）
// 能从原文严格重建最终 material（逐 code point 相等），droppedChars 精确。
//
// 运行：
//   node_modules\.bin\esbuild.cmd scripts/truncation-recon-tests.ts --bundle --format=esm --platform=node --outfile=out/truncation-recon-tests.mjs
//   node out/truncation-recon-tests.mjs
//
// 0 次真实 API 请求；不写 git。

import * as path from "node:path"
import * as url from "node:url"
import * as fs from "node:fs"
import { createRequire } from "node:module"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const require = createRequire(import.meta.url)
const esbuild = require("esbuild") as { build(opts: Record<string, unknown>): Promise<unknown> }

// ---------------- electron-shim ----------------
const ELECTRON_SHIM = {
  name: "electron-shim",
  setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "electron-shim" }))
    build.onLoad({ filter: /.*/, namespace: "electron-shim" }, () => ({
      contents: [
        "export const app = { getPath: (n) => '/tmp/' + String(n), isPackaged: false };",
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
  const outfile = path.resolve(ROOT, "out", `trunc-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

// ---------------- 代码点工具 ----------------
const cps = (s: string): number => Array.from(s).length
// 孤立代理项判定（照抄 novel.ts hasLoneSurrogate，测试侧独立复现）
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

interface Result { id: string; name: string; pass: boolean; detail: string }
const results: Result[] = []
function record(id: string, name: string, pass: boolean, detail: string): void {
  results.push({ id, name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${id} ${name}${detail ? " — " + detail : ""}`)
}

// ---------------- 结果类型 ----------------
interface Ev {
  originalChars: number
  maxChars: number
  keptIntervals: Array<{ from: number; to: number; reason: string }>
  insertedSegments: Array<{ at: number; text: string }>
  droppedChars: number
  anchorsKept: boolean
  wellFormed: boolean
  keptTailChars: number
}

async function main(): Promise<void> {
  console.log("===== truncation-recon-tests：R21-R07 截断证据严格重建 =====")
  const mod = await loadNovelModule()
  const buildNovelMaterial = mod.buildNovelMaterial as
    | ((messages: { role: string; content: string }[], maxChars?: number) => { material: string; truncated: boolean; evidence: Ev })
    | undefined
  const reconstructMaterial = mod.reconstructMaterial as
    | ((original: string, keptIntervals: Ev["keptIntervals"], insertedSegments: Ev["insertedSegments"]) => string)
    | undefined
  if (typeof buildNovelMaterial !== "function" || typeof reconstructMaterial !== "function") {
    console.error("缺少接口 buildNovelMaterial / reconstructMaterial")
    process.exit(2)
  }

  let caseNo = 0
  const runCase = (name: string, messages: { role: string; content: string }[], maxChars: number): void => {
    caseNo++
    const out = buildNovelMaterial(messages, maxChars)
    const ev = out.evidence
    // 重建原文：严格镜像 buildNovelMaterial 内部的 join 逻辑
    const parts: string[] = []
    for (const m of messages) {
      if (m.role !== "user" && m.role !== "assistant") continue
      const content = String(m.content ?? "").trim()
      if (!content) continue
      parts.push(`【${m.role === "user" ? "用户" : "AI"}】${content}`)
    }
    const original = parts.join("\n")
    const rebuilt = reconstructMaterial(original, ev.keptIntervals, ev.insertedSegments)
    const strictEqual = rebuilt === out.material

    // 独立校验 droppedChars = totalCp - Σ区间长度
    const totalCp = cps(original)
    const keptSum = ev.keptIntervals.reduce((a, iv) => a + (iv.to - iv.from), 0)
    const droppedOk = ev.droppedChars === totalCp - keptSum

    // 区间互不重叠、升序
    let ordered = true
    for (let i = 1; i < ev.keptIntervals.length; i++) {
      if (ev.keptIntervals[i - 1].to > ev.keptIntervals[i].from) ordered = false
      if (ev.keptIntervals[i - 1].from > ev.keptIntervals[i].from) ordered = false
    }

    const ok = strictEqual && droppedOk && ordered && cps(out.material) <= maxChars
    record(
      `T${caseNo}`,
      name,
      ok,
      `orig=${ev.originalChars}cp kept=${keptSum}cp dropped=${ev.droppedChars}cp rebuild=${strictEqual ? "=" : "≠"}final materialLen=${cps(out.material)}cp 区间数=${ev.keptIntervals.length} 非重叠升序=${ordered} truncated=${out.truncated}`
    )
  }

  // 1. 标准超长（无截断边界争议）
  {
    const msgs: { role: string; content: string }[] = []
    for (let i = 0; i < 100; i++) msgs.push({ role: "user", content: `旧设定${i}：${"前情铺垫".repeat(60)}` })
    msgs.push({ role: "assistant", content: "最新剧情：主角的名字叫林晚，在雾江坝发现真相。" + "后续正文".repeat(200) })
    runCase("超长素材→锚点+尾部保留", msgs, 400000)
  }

  // 2. 锚点与尾部重叠（maxChars 极小 300）
  {
    const msgs: { role: string; content: string }[] = []
    for (let i = 0; i < 200; i++) msgs.push({ role: "user", content: `设定${i}：${"内容".repeat(50)}` })
    runCase("锚点与尾部重叠（maxChars=300）", msgs, 300)
  }

  // 3. 无人物锚点文本（不出现 名字/叫/角色名 等关键词）
  {
    const msgs: { role: string; content: string }[] = []
    for (let i = 0; i < 200; i++) msgs.push({ role: "user", content: `段落${i}${"这是没有人物关键词的普通叙述文字".repeat(40)}` })
    runCase("无人物锚点文本", msgs, 50000)
  }

  // 4. emoji / 扩展汉字（代理对）
  {
    const msgs: { role: string; content: string }[] = []
    let c = ""
    while (c.length < 2000) c += "😂📚🎭𠀀𠀁正文"
    msgs.push({ role: "user", content: c })
    runCase("emoji/扩展汉字截断", msgs, 800)
  }

  // 5. maxChars 恰好等于锚点标签长度（极小极值）
  {
    const msgs: { role: string; content: string }[] = []
    for (let i = 0; i < 100; i++) msgs.push({ role: "user", content: `x${i}${"many".repeat(30)}` })
    runCase("maxChars=标签长度极值(≈12)", msgs, 12)
  }

  // 6. 原文 < maxChars（无截断）
  {
    const msgs: { role: string; content: string }[] = [{ role: "user", content: "很短的一段素材，未超限。" }]
    runCase("原文<maxChars（无截断）", msgs, 400000)
  }

  // 7. 原文恰好略超 maxChars（截断边界）
  {
    const msgs: { role: string; content: string }[] = [{ role: "user", content: "第一章内容。".repeat(200) }]
    runCase("原文略超maxChars（边界截断）", msgs, 300)
  }

  // 8. 大量消息、多角色、含空内容与未知角色（过滤逻辑）
  {
    const msgs: { role: string; content: string }[] = []
    msgs.push({ role: "system", content: "应被过滤" })
    msgs.push({ role: "user", content: "  " })
    for (let i = 0; i < 150; i++) {
      msgs.push({ role: i % 2 ? "user" : "assistant", content: `第${i}条：${"正文内容".repeat(40)}` })
    }
    msgs.push({ role: "assistant", content: "结尾：角色名叫做苏苏。" + "续写".repeat(80) })
    runCase("多角色+空内容+未知角色过滤", msgs, 25000)
  }

  // ==================== P1-03 语义断言：保留的人物锚点 == 当初匹配到的人物句 ====================
  // 用与 novel.ts 一致的 Regex 在「原文完整 code-point 数组」上做匹配，得到“最后一个命中”的期望人物句；
  // 验证 evidence.keptIntervals 中 reason="character-anchor" 的区间对应的原文切片逐 code point 等于该人物句。
  const getNameMarkRe = (): RegExp => /[^\n。！？!?]*(?:名字|叫|称呼|角色名|姓名)[^\n。！？!?]*[。！？!?\n]?/g

  // 计算原文（messages 拼接后）中最后一个名字句的【code-point 区间】{from,to,text}。
  function lastCharAnchorOracle(original: string, openingAnchorEnd: number, tailStart: number): { from: number; to: number; text: string } | null {
    const src = Array.from(original)
    if (tailStart <= openingAnchorEnd) return null
    const midHead = src.slice(openingAnchorEnd, tailStart).join('')
    const re = getNameMarkRe()
    let last: { cpFrom: number; cpTo: number; text: string } | null = null
    let m: RegExpExecArray | null
    while ((m = re.exec(midHead)) !== null) {
      if (!m[0]) continue
      const cpFrom = Array.from(midHead.slice(0, m.index)).length
      const cpTo = cpFrom + Array.from(m[0]).length
      last = { from: openingAnchorEnd + cpFrom, to: openingAnchorEnd + cpTo, text: m[0] }
    }
    return last
  }

  // 语义断言：evidence 中的 character-anchor 区间对应原文切片，逐 code point 等于 oracle 人物句。
  function assertCharAnchorSemantics(
    name: string,
    original: string,
    ev: Ev,
    oracle: { from: number; to: number; text: string } | null,
    expectedText?: string
  ): boolean {
    const ca = ev.keptIntervals.filter((iv) => iv.reason === "character-anchor")
    // 无 oracle → 不应保留任何 character-anchor 区间
    if (oracle === null) {
      const ok = ca.length === 0
      record(`S${caseNo}`, name, ok, `无人物句 oracle；实际 character-anchor 区间数=${ca.length}（期望 0）`)
      return ok
    }
    if (ca.length !== 1) {
      record(`S${caseNo}`, name, false, `character-anchor 区间数=${ca.length}（期望 1）`)
      return false
    }
    const iv = ca[0]
    const src = Array.from(original)
    const slice = src.slice(iv.from, iv.to).join('')
    const textEq = slice === oracle.text
    // 区间长度 == 匹配文本 code-point 长度
    const lenEq = iv.to - iv.from === Array.from(oracle.text).length
    // 区间起点 == oracle 起点
    const fromEq = iv.from === oracle.from
    // 若调用方额外给出期望文本（如被 1000cp 截断后的锚点），则只验证“是 oracle 文本的前缀 + 等长切片”
    let prefixOk = true
    if (expectedText !== undefined) {
      prefixOk = slice === expectedText
    }
    const ok = textEq && lenEq && fromEq && prefixOk
    record(
      `S${caseNo}`,
      name,
      ok,
      `切片=${JSON.stringify(slice.slice(0, 12))}… oracle=${JSON.stringify(oracle.text.slice(0, 12))}… 逐cp相等=${textEq} 区间长=${iv.to - iv.from}(期望 ${Array.from(oracle.text).length}) from=${iv.from}(期望 ${oracle.from})`
    )
    return ok
  }

  // ==================== 新增语义用例（P1-03，≥6 用例） ====================
  // 关键点：原 8 用例从未触发“人物锚点”区间（名字句都在尾区/未截断），所以旧偏移 bug 从不暴露。
  // 下列用例把【含 astral/emoji 的前缀 + 名字句】放到中段 [openingAnchorEnd, tailStart)，
  // 使 buildNovelMaterial 真正提取 character-anchor，且 m.index(UTF-16) ≠ cp offset。

  // 复用 fixedInsertLen 与 tailStart/openingEnd 的算法（与 novel.ts 逐字对齐）
  const FIXED_INSERT_LEN = Array.from("【开局锚点】").length + 1 + Array.from("【人物锚点】").length + 1
  const tailStartOf = (totalCp: number, maxChars: number): number =>
    Math.max(0, totalCp - Math.max(0, maxChars - FIXED_INSERT_LEN))
  const openingEndOf = (tailStart: number): number => Math.min(500, tailStart)

  // 构造单条用户消息：head(不含名字句) + 前缀(含「。」分隔的 astral/emoji，制造 m.index≠cp 偏移)。
  // 总长 >> maxChars 且名字句落在中段 [openingEnd, tailStart)，从而触发 character-anchor 提取。
  function buildContent(prefix: string, nameSentence: string, headLen = 1000, tailLen = 12000): string {
    const head = "甲".repeat(headLen)
    const tail = "乙".repeat(tailLen)
    return head + prefix + nameSentence + tail
  }

  // 跑一条语义用例：返回 {original, out, oracle} 供后续断言；严格重建已在 runCase 内验过。
  function runSemanticCase(label: string, prefix: string, nameSentence: string, maxChars: number): { original: string; out: { material: string; truncated: boolean; evidence: Ev }; oracle: { from: number; to: number; text: string } | null } {
    const content = buildContent(prefix, nameSentence)
    const msgs: { role: string; content: string }[] = [{ role: "user", content }]
    runCase(`${label}（重建）`, msgs, maxChars) // 严格重建 + dropped + 区间序（复用原 runCase）
    const original = "【用户】" + content
    const out = buildNovelMaterial(msgs, maxChars)
    const totalCp = Array.from(original).length
    const tailStart = tailStartOf(totalCp, maxChars)
    const openingEnd = openingEndOf(tailStart)
    const oracle = lastCharAnchorOracle(original, openingEnd, tailStart)
    caseNo++
    assertCharAnchorSemantics(`${label}·锚点逐cp等于匹配人物句`, original, out.evidence, oracle)
    return { original, out, oracle }
  }

  // ---- 用例 9：emoji 在人物句前（Codex 复现用例同构）----
  runSemanticCase("emoji 在人物句前", "😀。😀。😀。", "然后角色名字叫小明。", 4000)

  // ---- 用例 10：多个 astral code point 在人物句前 ----
  runSemanticCase("多个 astral cp 在人物句前", "𠀀。𠀁。𠀂。".repeat(6), "她的称呼唤作小枫。", 4000)

  // ---- 用例 11：扩展汉字（U+20000+）在人物句前 ----
  runSemanticCase("扩展汉字 U+20000+ 在人物句前", "𠀃。𪚥。𪛖。".repeat(5), "这人姓名唤作赵铁柱。", 4000)

  // ---- 用例 12：多个人物句取最后一个（断言选中的是最后一个且完整保留）----
  {
    // 中段多个名字句，最后一个（阿丁）才是目标；其前混入 emoji/astral 制造偏移
    const prefix12 = "😀人物一名字叫阿甲。𠀀人物二名字叫阿乙。𪚥人物三名字叫阿丙。"
    const name12 = "结尾人物名字叫阿丁。"
    const { original, out, oracle } = runSemanticCase("多个人物句取最后一个", prefix12, name12, 4000)
    // 额外断言：oracle 是最后一句（含阿丁、不含阿丙）
    const oracleIsLast = oracle !== null && oracle.text.includes("阿丁") && !oracle.text.includes("阿丙")
    caseNo++
    record(`S${caseNo}`, "多人物句·确为最后一句(阿丁)", oracleIsLast,
      oracle ? `oracle=${JSON.stringify(oracle.text)} 含阿丁=${oracle.text.includes("阿丁")} 不含阿丙=${!oracle.text.includes("阿丙")}` : "oracle=null")
    void original; void out
  }

  // ---- 用例 13：锚点接近 opening 边界（人物句紧邻开局锚点区）----
  // head 精确 500cp（= openingAnchorEnd 上限），人物句紧随其后，其前缀含 emoji 制造偏移
  {
    const content = "甲".repeat(500) + "😀。名字叫小绿。" + "乙".repeat(12000)
    const msgs: { role: string; content: string }[] = [{ role: "user", content }]
    runCase("锚点接近 opening 边界（重建）", msgs, 4000)
    const original = "【用户】" + content
    const out = buildNovelMaterial(msgs, 4000)
    const totalCp = Array.from(original).length
    const tailStart = tailStartOf(totalCp, 4000)
    const openingEnd = openingEndOf(tailStart)
    const oracle = lastCharAnchorOracle(original, openingEnd, tailStart)
    caseNo++
    assertCharAnchorSemantics("锚点接近 opening 边界·逐cp相等", original, out.evidence, oracle)
  }

  // ---- 用例 14：锚点接近 tail 边界（人物句紧邻尾部区间）----
  // 名字句之后紧跟尾部；令 tailLen = maxChars - FIXED_INSERT_LEN，使名字句末尾恰好贴住 tailStart（仍在中段查询范围内）。
  {
    const prefix14 = "😀。😀。"
    const name14 = "最后角色叫小紫。"
    const maxChars = 1300
    const head = "甲".repeat(1000)
    const tailLen = maxChars - FIXED_INSERT_LEN
    const content = head + prefix14 + name14 + "乙".repeat(tailLen)
    const msgs: { role: string; content: string }[] = [{ role: "user", content }]
    runCase("锚点接近 tail 边界（重建）", msgs, maxChars)
    const original = "【用户】" + content
    const out = buildNovelMaterial(msgs, maxChars)
    const totalCp = Array.from(original).length
    const tailStart = tailStartOf(totalCp, maxChars)
    const openingEnd = openingEndOf(tailStart)
    const oracle = lastCharAnchorOracle(original, openingEnd, tailStart)
    caseNo++
    assertCharAnchorSemantics("锚点接近 tail 边界·逐cp相等", original, out.evidence, oracle)
  }

  // ==================== P1-03 旧算法红证据 ====================
  // 测试侧实现「把 m.index 当 code-point offset」的旧算法参考实现，证明其在 Codex 复现场景错切一位。
  {
    // midHead 前含「。」分隔的 emoji，使名字句的 m.index(UTF-16) 与 cp offset 不一致。
    const midHead = "😀。😀。😀。然后角色名字叫小明。尾巴B"
    const src = Array.from(midHead)
    const re = getNameMarkRe()
    const m = re.exec(midHead)
    if (!m || !m[0]) {
      record("R1", "旧算法红证据：正则未命中", false, "构造错误")
    } else {
      // 旧算法：hit.offset = m.index（UTF-16）直接当 cp offset
      const oldSlice = src.slice(m.index, m.index + Array.from(m[0]).length).join('')
      // 新算法：m.index → cpOffset = Array.from(midHead.slice(0, m.index)).length
      const cpFrom = Array.from(midHead.slice(0, m.index)).length
      const newSlice = src.slice(cpFrom, cpFrom + Array.from(m[0]).length).join('')
      const oldWrong = oldSlice !== m[0]
      const newRight = newSlice === m[0]
      const ok = oldWrong && newRight
      record("R1", "旧算法(m.index 当 cp offset)错切、新算法正确", ok,
        `m.index=${m.index} match=${JSON.stringify(m[0])} oldSlice=${JSON.stringify(oldSlice)} newSlice=${JSON.stringify(newSlice)}`)
    }
  }

  // ==================== P1-03 property/fuzz（固定 seed，50 例） ====================
  {
    // 固定 seed 的伪随机（xorshift），保证可复现。
    let seed = 0x9e3779b9
    const rnd = (): number => {
      seed ^= seed << 13; seed >>>= 0
      seed ^= seed >> 17
      seed ^= seed << 5; seed >>>= 0
      return seed / 0xffffffff
    }
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]
    const emoji = ["😂", "📚", "🎭", "😀", "🎉", "🧧", "🌙", "🔥"]
    const astral = ["𠀀", "𠀁", "𠀂", "𠀃", "𠀄"]
    const extHan = ["𠀀", "𠀁", "𠀂", "𪚥", "𪛖"] // 扩展区 code point（BMP 外）
    const cjk = ["人", "物", "名", "字", "叫", "称", "呼", "名", "字", "小明", "小红", "阿丙", "老王"]
    const nameFrag = ["名字叫", "唤作", "称呼", "姓名", "叫做", "叫"]
    let fuzzPass = 0
    let fuzzFail = 0
    for (let i = 0; i < 50; i++) {
      // 随机生成长文本（含 emoji/astral/扩展汉字/CJK），随机插入名字句
      let body = ""
      const nSeg = 8 + Math.floor(rnd() * 20)
      for (let s = 0; s < nSeg; s++) {
        const kind = rnd()
        if (kind < 0.3) body += pick(emoji)
        else if (kind < 0.45) body += pick(astral)
        else if (kind < 0.55) body += pick(extHan)
        else if (kind < 0.7) body += pick(cjk)
        else body += "正文内容"
        // 随机在某段塞入名字句
        if (rnd() < 0.15) body += pick(cjk) + pick(nameFrag) + pick(cjk) + "。"
      }
      const maxChars = 500 + Math.floor(rnd() * 8000)
      const out = buildNovelMaterial([{ role: "user", content: body }], maxChars)
      const ev = out.evidence
      const original = "【用户】" + body
      const rebuilt = reconstructMaterial(original, ev.keptIntervals, ev.insertedSegments)
      const strictEq = rebuilt === out.material
      const noLone = !hasLoneSurrogate(out.material)
      const totalCp = Array.from(original).length
      const keptSum = ev.keptIntervals.reduce((a, iv) => a + (iv.to - iv.from), 0)
      const droppedOk = ev.droppedChars === totalCp - keptSum
      // 区间升序互不重叠
      let ordered = true
      for (let k = 1; k < ev.keptIntervals.length; k++) {
        if (ev.keptIntervals[k - 1].to > ev.keptIntervals[k].from) ordered = false
        if (ev.keptIntervals[k - 1].from > ev.keptIntervals[k].from) ordered = false
      }
      // 语义：若有 character-anchor 区间，其切片必须等于对应匹配（用 oracle 校验）
      let semOk = true
      // 复用 oracle：此处 opening=min(500,tailStart), tailStart 同上
      const tailStartF = Math.max(0, totalCp - Math.max(0, maxChars - (Array.from("【开局锚点】").length + 1 + Array.from("【人物锚点】").length + 1)))
      const openingEndF = Math.min(500, tailStartF)
      const oracleF = lastCharAnchorOracle(original, openingEndF, tailStartF)
      const ca = ev.keptIntervals.filter((iv) => iv.reason === "character-anchor")
      if (oracleF === null) {
        semOk = ca.length === 0
      } else {
        semOk = ca.length === 1 && ca[0].from === oracleF.from && ca[0].to - ca[0].from === Array.from(oracleF.text).length
          && Array.from(original).slice(ca[0].from, ca[0].to).join('') === oracleF.text
      }
      const ok = strictEq && noLone && droppedOk && ordered && semOk && Array.from(out.material).length <= maxChars
      if (ok) fuzzPass++; else fuzzFail++
    }
    record("FZ", `property/fuzz 50 例（seed=${0x9e3779b9}）`, fuzzFail === 0,
      `PASS=${fuzzPass} FAIL=${fuzzFail}`)
    if (fuzzFail > 0) {
      console.error(`fuzz 失败 ${fuzzFail} 例：详见上方细节`)
    }
  }

  const passed = results.filter((r) => r.pass)
  const failed = results.filter((r) => !r.pass)
  console.log("")
  console.log(`===== truncation-recon-tests done: ${passed.length} PASS / ${failed.length} FAIL =====`)
  if (failed.length > 0) {
    console.error("FAILED:", failed.map((f) => `${f.id} ${f.name}`).join("; "))
    process.exit(1)
  }
  console.log(`all ${passed.length} recon cases strictly equal`)
}

main().catch((e) => {
  console.error("truncation-recon-tests 异常：", e)
  process.exit(2)
})
