// ==================== eval-validators.ts：每类任务的结构校验器 ====================
// 与模型无关、可本地运行的结构校验（synthetic / real 通用）。
// 每个校验器输入：任务 + stageResults（每 stage 产出正文）+ 素材内容；输出统一 ValidationResult。
// 原则：只做"结构级"可判定（长度、出现、差异、n-gram、Ren'Py 规则、可达性、重复），
//       不做语义好坏判断——语义盲评交给 subagent B。

import { createHash } from "node:crypto"

export interface ValidationCheck {
  id: string
  passed: boolean
  detail: string
}

export interface ValidationResult {
  validatorRef: string
  passed: boolean
  checks: ValidationCheck[]
}

export interface StageOutput {
  stageId: string
  content: string
  chars: number
  /** R23-R02：该 stage 产出正文的 sha256（validator 逐序验证 trajectory 历史接力，不落正文） */
  contentSha256: string
  /** R24-P0-02：多轮 completion 明细——每轮 assistant 正文 chars/hash（validator 复核完整正文） */
  turnChars?: number[]
  turnHashes?: string[]
  /** R25-P1-03：声明目标（unscaled，tasks.json 单一真源） */
  declaredTargetChars?: number
  /** R25-P1-03：执行目标 = round(declared × scale) */
  executionTargetChars?: number
  /** R25-P1-03：mock 公平长度 = clamp(execution, 200, 1600)；real 为 null */
  mockFairLength?: number | null
  /** R25-P1-03：执行口径 expectMinChars = max(1, round(declaredExpect × scale))；无声明为 null */
  expectMinCharsExecution?: number | null
}

/** 校验器上下文：素材文本按相对路径给到（如 "materials/style-sample-a.txt"） */
export interface ValidatorContext {
  taskId: string
  targetChars: number
  stages: StageOutput[]
  /** 任务声明的材料（相对路径 → 文本内容） */
  rawMaterials: Record<string, string>
  /** 各 stage 声明的 expectMinChars（stageId → 值） */
  expectMinChars: Record<string, number>
}

function cjkCount(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x3000 && c <= 0x9fff) n++
  }
  return n
}

// ---------------- 通用工具 ----------------

/** 构造单个 check 的辅助 */
function chk(id: string, passed: boolean, detail: string): ValidationCheck {
  return { id, passed, detail }
}

function summarize(checks: ValidationCheck[]): ValidationResult {
  return { validatorRef: "", passed: checks.every((c) => c.passed), checks }
}

/** 两段文本的最长公共子串长度（O(n*m)，输入规模 ~几百到几万字符，够用） */
function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0
  // 用较短串作外循环，减少内存
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  const dp = new Array(l.length + 1).fill(0)
  let best = 0
  for (let i = 0; i < s.length; i++) {
    for (let j = l.length - 1; j >= 0; j--) {
      if (s[i] === l[j]) {
        dp[j + 1] = dp[j] + 1
        if (dp[j + 1] > best) best = dp[j + 1]
      } else {
        dp[j + 1] = 0
      }
    }
  }
  return best
}

// ---------------- 1. longform（长篇连续写作） ----------------

export function validateLongform(ctx: ValidatorContext): ValidationResult {
  const checks: ValidationCheck[] = []
  // 阶段完整性：至少 outline + 若干 chapter
  const stageIds = ctx.stages.map((s) => s.stageId)
  checks.push(chk("hasOutline", stageIds.includes("outline"), `阶段含 outline：${stageIds.includes("outline")}`))
  const chapterCount = ctx.stages.filter((s) => s.stageId.startsWith("chapter") || s.stageId === "chapter").length
  checks.push(chk("minChapters", chapterCount >= 3, `章节阶段数 ${chapterCount} >= 3`))

  // 每阶段满足 expectMinChars
  for (const s of ctx.stages) {
    const exp = ctx.expectMinChars[s.stageId] ?? 0
    const ok = s.chars >= exp
    checks.push(chk(`minChars:${s.stageId}`, ok, `${s.stageId} 产出 ${s.chars} 字符 >= ${exp}`))
  }
  // 总产出达到（缩放后）目标的一定比例（mock 有 cap，这里放宽为 > 0 且 >= 各阶段最小值之和的判定）
  const total = ctx.stages.reduce((a, s) => a + s.chars, 0)
  checks.push(chk("totalNonEmpty", total > 0, `总产出 ${total} 字符 > 0`))
  // 章节正文应为汉字为主（结构级：正文含 CJK）
  const body = ctx.stages.filter((s) => s.stageId !== "outline").map((s) => s.content).join("")
  const cjk = cjkCount(body)
  const cjkRatio = body.length > 0 ? cjk / body.length : 0
  checks.push(chk("cjkDominated", cjkRatio > 0.5, `正文 CJK 占比 ${(cjkRatio * 100).toFixed(1)}% > 50%`))

  return { validatorRef: "longform", passed: checks.every((c) => c.passed), checks }
}

// ---------------- 2. character-consistency（三人物一致性） ----------------

export function validateCharacterConsistency(ctx: ValidatorContext): ValidationResult {
  const checks: ValidationCheck[] = []
  const allText = ctx.stages.map((s) => s.content).join("\n")

  // 1) 人物名全部出现
  const rawSet = ctx.rawMaterials
  const charsJson = rawSet["materials/characters.json"]
  let names: string[] = []
  if (charsJson) {
    try {
      const parsed = JSON.parse(charsJson) as { characters?: Array<{ name?: string }> }
      names = (parsed.characters ?? []).map((c) => c.name ?? "").filter(Boolean)
    } catch {
      /* 忽略，names 为空会在 namePresent 里体现为失败 */
    }
  }
  const present = names.map((n) => allText.includes(n))
  checks.push(chk("allNamesPresent", names.length >= 3 && present.every(Boolean), `人物 ${names.join(" / ")} 出现：${present.map((p) => (p ? "是" : "否")).join(" / ")}（需 ≥3 人物全部出现）`))

  // 2) 场景轮数足够（≥5 + setup 共 ≥6 轮产出且非空）
  const sceneStages = ctx.stages.filter((s) => s.stageId !== "setup")
  checks.push(chk("sceneRounds", sceneStages.length >= 5, `场景推进轮数 ${sceneStages.length} >= 5`))
  const nonEmptyRounds = ctx.stages.filter((s) => s.chars > 0).length
  checks.push(chk("roundsNonEmpty", nonEmptyRounds >= 6, `非空产出轮数 ${nonEmptyRounds} >= 6`))

  // 3) 每轮产出满足 expectMinChars
  for (const s of ctx.stages) {
    const exp = ctx.expectMinChars[s.stageId] ?? 0
    checks.push(chk(`minChars:${s.stageId}`, s.chars >= exp, `${s.stageId} 产出 ${s.chars} >= ${exp}`))
  }

  // 4) 语气词差异（结构级）：三人物说话方式应有语气词差异——检查是否至少一种语气词（嘛/啦/得嘞/中）出现
  const interjections = ["嘛", "啦", "得嘞", "中", "哼"]
  const foundIj = interjections.filter((w) => allText.includes(w))
  checks.push(chk("voiceVariety", foundIj.length >= 1, `检测到语气词差异样本：${foundIj.length ? foundIj.join(" / ") : "无"}（>=1）`))

  return { validatorRef: "character-consistency", passed: checks.every((c) => c.passed), checks }
}

// ---------------- 3. style-transfer（风格迁移） ----------------

export function validateStyleTransfer(ctx: ValidatorContext): ValidationResult {
  const checks: ValidationCheck[] = []
  // 阶段：extract + generate
  const generate = ctx.stages.find((s) => s.stageId === "generate")
  const extract = ctx.stages.find((s) => s.stageId === "extract")
  checks.push(chk("hasGenerate", !!generate, `含 generate 阶段：${!!generate}`))
  checks.push(chk("hasExtract", !!extract, `含 extract（风格画像）阶段：${!!extract}`))

  if (extract) {
    const exp = ctx.expectMinChars["extract"] ?? 0
    checks.push(chk("extractMinChars", extract.chars >= exp, `风格画像 ${extract.chars} >= ${exp}`))
  }

  // 产出长度
  if (generate) {
    const exp = ctx.expectMinChars["generate"] ?? 0
    checks.push(chk("generateMinChars", generate.chars >= exp, `生成正文 ${generate.chars} >= ${exp}`))
  }

  // n-gram 防复刻：与每份样本的最长公共子串不得超过阈值（默认 20 字）
  const THRESHOLD = 20
  const samples = ["materials/style-sample-a.txt", "materials/style-sample-b.txt", "materials/style-sample-c.txt"]
  let maxLcs = 0
  const lcsDetails: string[] = []
  for (const k of samples) {
    const sample = ctx.rawMaterials[k] ?? ""
    if (!sample) continue
    const l = (generate?.content ? longestCommonSubstring(generate.content, sample) : 0)
    if (l > maxLcs) maxLcs = l
    lcsDetails.push(`${k}:${l}`)
  }
  const antiCopyOk = maxLcs <= THRESHOLD
  checks.push(chk("antiCopy", antiCopyOk, `与样本最长公共子串 ${maxLcs} 字 <= ${THRESHOLD}（${lcsDetails.join("; ")}）`))

  return { validatorRef: "style-transfer", passed: checks.every((c) => c.passed), checks }
}

// ---------------- 4. renpy（场景生成 + lint 修复 + 分支可达性） ----------------

/** 提取 .rpy 文本中定义的 label 名 */
function extractLabels(code: string): string[] {
  const out: string[] = []
  const re = /^\s*label\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) out.push(m[1])
  return out
}

/** 从 menu 块解析选择 → jump 目标。返回 { choices, jumps } 用于可达性。 */
function parseMenuJumps(code: string): Array<{ choice: string; target: string }> {
  const out: Array<{ choice: string; target: string }> = []
  // 粗略解析：menu: 块内形如 "选项": 换行缩进 jump label
  const menuRe = /menu\s*:/g
  let m: RegExpExecArray | null
  while ((m = menuRe.exec(code)) !== null) {
    // 取 menu 之后的块，直到下一个同级 label/menu/return（简化：取后 2000 字符，找 jump）
    const after = code.slice(m.index + m[0].length)
    const seg = after.slice(0, 2000)
    // 匹配 "xxx": + 换行 + 缩进 jump label
    const choiceRe = /"([^"]+)"\s*:\s*\n\s*jump\s+([A-Za-z_][A-Za-z0-9_]*)/g
    let c: RegExpExecArray | null
    while ((c = choiceRe.exec(seg)) !== null) {
      out.push({ choice: c[1], target: c[2] })
    }
  }
  return out
}

/** 分支可达性 BFS：menu 中的 jump 目标 label 是否全部存在且可达（存在即可达，Ren'Py jump 直达） */
function checkReachability(code: string): { ok: boolean; labels: string[]; missingTargets: string[]; details: string[] } {
  const labels = extractLabels(code)
  const labelSet = new Set(labels)
  const jumps = parseMenuJumps(code)
  const missingTargets: string[] = []
  const details: string[] = []
  for (const j of jumps) {
    if (!labelSet.has(j.target)) missingTargets.push(j.target)
    details.push(`"${j.choice}" -> ${j.target} ${labelSet.has(j.target) ? "✓" : "✗(缺失)"}`)
  }
  // 起点可达性：从 start 或首个 label BFS
  const start = labelSet.has("start") ? "start" : (labels[0] ?? "")
  const reachable = new Set<string>()
  const queue: string[] = []
  if (start) { queue.push(start); reachable.add(start) }
  // 通过 jump 边 BFS
  const jumpEdges = parseJumpEdges(code)
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const nxt of jumpEdges[cur] ?? []) {
      if (!reachable.has(nxt)) { reachable.add(nxt); queue.push(nxt) }
    }
  }
  const unreachable = labels.filter((l) => !reachable.has(l))
  return {
    ok: missingTargets.length === 0 && unreachable.length === 0,
    labels,
    missingTargets,
    details: [...details, `可达 labels: ${[...reachable].join(",") || "无"}`, `不可达 labels: ${unreachable.join(",") || "无"}`]
  }
}

/** 提取 label → 其 jump 目标（跨整个文件，用于 BFS） */
function parseJumpEdges(code: string): Record<string, string[]> {
  const edges: Record<string, string[]> = {}
  const labels = extractLabels(code)
  for (const l of labels) edges[l] = []
  // 找到每个 label 块，收集其中的 jump target
  const labelRe = /^\s*label\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gm
  const positions: Array<{ name: string; start: number }> = []
  let m: RegExpExecArray | null
  while ((m = labelRe.exec(code)) !== null) positions.push({ name: m[1], start: m.index })
  const jumpAll = /\bjump\s+([A-Za-z_][A-Za-z0-9_]*)/g
  positions.forEach((p, i) => {
    const end = i + 1 < positions.length ? positions[i + 1].start : code.length
    const seg = code.slice(p.start, end)
    let j: RegExpExecArray | null
    while ((j = jumpAll.exec(seg)) !== null) {
      if (!edges[p.name]) edges[p.name] = []
      edges[p.name].push(j[1])
    }
    jumpAll.lastIndex = 0
  })
  return edges
}

/** 内置 Ren'Py 规则校验（无 SDK 时用）：缩进为 4 空格、label 定义、menu 结构、return 位置、非空 */
export function validateRenpy(ctx: ValidatorContext): ValidationResult {
  const checks: ValidationCheck[] = []
  const gen = ctx.stages.find((s) => s.stageId === "generate" || s.stageId === "scene")
  const code = gen?.content ?? ""
  const lines = code.split("\n")

  // 非空
  checks.push(chk("nonEmpty", code.trim().length > 0, `脚本非空：${code.trim().length} 字符`))
  // 产出长度
  const exp = ctx.expectMinChars[gen?.stageId ?? ""] ?? 0
  if (gen) checks.push(chk("minChars", gen.chars >= exp, `脚本 ${gen.chars} >= ${exp}`))

  // label 定义存在
  const labels = extractLabels(code)
  checks.push(chk("hasLabels", labels.length >= 1, `label 定义数 ${labels.length} >= 1`))

  // 缩进违纪：检测 tab 或非 4 倍数空格缩进（行首空白）
  let badIndent = 0
  for (const ln of lines) {
    const m = /^([ \t]*)\S/.exec(ln)
    if (!m) continue
    const w = m[1]
    if (w.includes("\t")) badIndent++
    else if (w.length % 4 !== 0) badIndent++
  }
  checks.push(chk("indentOk", badIndent === 0, `缩进违纪行数 ${badIndent} == 0（4 空格缩进、无 tab）`))

  // menu 结构：menu: 需有选择分支
  const hasMenu = /\bmenu\s*:/.test(code)
  const menuCount = (code.match(/\bmenu\s*:/g) ?? []).length
  const choices = parseMenuJumps(code)
  checks.push(chk("hasMenu", hasMenu, `含 menu 块：${hasMenu}（${menuCount} 处）`))
  checks.push(chk("menuChoices", choices.length >= 2, `menu 选择项 ≥2：${choices.length}`))

  // return 位置：每个 label 块应以 return 结尾（结构级：return 总数 >= label 数 - 允许 start 无 return）
  const returnCount = (code.match(/\breturn\b/g) ?? []).length
  checks.push(chk("returnsPresent", returnCount >= Math.max(0, labels.length - 1), `return 数 ${returnCount} >= label 数 ${labels.length} - 1`))

  // 分支可达性
  const reach = checkReachability(code)
  checks.push(chk("reachability", reach.ok, `分支可达性：${reach.ok ? "全部可达" : "存在缺失/不可达标签"}（${reach.details.join("; ")}）`))

  return { validatorRef: "renpy", passed: checks.every((c) => c.passed), checks }
}

// ---------------- 5. failure-recovery（失败恢复） ----------------

export function validateFailureRecovery(ctx: ValidatorContext): ValidationResult {
  const checks: ValidationCheck[] = []
  const cont = ctx.stages.find((s) => s.stageId === "truncated-continuation")
  const partial = ctx.stages.find((s) => s.stageId === "partial-continue")
  checks.push(chk("hasTruncated", !!cont, `含截断续写阶段：${!!cont}`))
  checks.push(chk("hasPartial", !!partial, `含部分完成继续阶段：${!!partial}`))

  // 截断续写：不得重复前文尾部 ≥50 字。前文尾部固定为 "是——" 之后（我们已知提示尾部）
  // 这里用启发：续写正文不应以 "是——" 开头或含大段前文尾（判据：续写前 50 字不能与已给前文尾 50 字重叠 > 阈值）
  // 但结构化实现：检查续写正文是否以已知断裂点前的内容（"你不该来这里"之后的片段）作为前缀重复。
  const FORBIDDEN_TAIL = "是——" // 断裂点标识
  if (cont) {
    const head = cont.content.slice(0, 20)
    const repeatsTail = head.includes(FORBIDDEN_TAIL)
    checks.push(chk("noPrefixRepeat", !repeatsTail, `续写开头不重述断裂点前文（"${FORBIDDEN_TAIL}"）：${repeatsTail ? "重复" : "未重复"}`))
    // 更长判定：与提示中前文尾部的半句（"来人的声音他认得"）最长公共子串 < 15
    const preamble = "来人的声音他认得"
    const lcsHead = longestCommonSubstring(cont.content, preamble)
    checks.push(chk("noTailCopied", lcsHead < 15, `与断裂点前文尾部最长公共子串 ${lcsHead} < 15`))
    const exp = ctx.expectMinChars["truncated-continuation"] ?? 0
    checks.push(chk("contMinChars", cont.chars >= exp, `续写 ${cont.chars} >= ${exp}`))
  }

  // 部分完成继续：第二轮基于第一轮继续，不得整段重复第一轮
  if (partial && cont) {
    const exp = ctx.expectMinChars["partial-continue"] ?? 0
    checks.push(chk("partialMinChars", partial.chars >= exp, `继续 ${partial.chars} >= ${exp}`))
    // 不得整段重复：partial 与 cont 的最长公共子串应远小于 cont 长度
    const lcs = longestCommonSubstring(partial.content, cont.content)
    const ratio = cont.chars > 0 ? lcs / cont.chars : 1
    checks.push(chk("noWholeRepeat", ratio < 0.8, `第二轮与第一轮最长公共子串占比 ${(ratio * 100).toFixed(1)}% < 80%（不得整段重复）`))
    // 衔接：第二轮不应为空且应与第一轮不同
    checks.push(chk("distinct", partial.content.trim() !== cont.content.trim(), `第二轮内容与第一轮不同：${partial.content.trim() !== cont.content.trim()}`))
  }

  return { validatorRef: "failure-recovery", passed: checks.every((c) => c.passed), checks }
}

// ---------------- 分发 ----------------

export function runValidator(validatorRef: string, ctx: ValidatorContext): ValidationResult {
  let res: ValidationResult
  switch (validatorRef) {
    case "longform": res = validateLongform(ctx); break
    case "character-consistency": res = validateCharacterConsistency(ctx); break
    case "style-transfer": res = validateStyleTransfer(ctx); break
    case "renpy": res = validateRenpy(ctx); break
    case "failure-recovery": res = validateFailureRecovery(ctx); break
    default: res = { validatorRef, passed: false, checks: [chk("unknownValidator", false, `未知校验器：${validatorRef}`)] }
  }
  res.validatorRef = validatorRef
  return res
}

/** 供测试/复用：导出若干内部工具 */
export const _internal = {
  longestCommonSubstring,
  cjkCount,
  extractLabels,
  parseMenuJumps,
  checkReachability
}

// 供别处复用（runner 记录校验摘要）用
export function hashChecks(checks: ValidationCheck[]): string {
  return createHash("sha256").update(JSON.stringify(checks)).digest("hex")
}
