// ==================== R4.6 Gate 7 发布工程：ASAR 内容安全检查（fail closed） ====================
// 检查 electron-builder 产物目录中 app.asar 的内容，断言不得包含：
//   1. API key 明文（sk- 开头 32+ 字符 / DEEPSEEK_API_KEY / apiKeyEnc 非空值）
//   2. 测试 fixture 目录（fixtures/、e2e-screenshots/、test fixture 文件）
//   3. 源码 bundle（code-bundle.txt、docs/）
//   4. 用户语料 / 本地绝对路径（C:\Users\ 路径、userData 路径等）
// 用法：
//   node out/check-asar.mjs --dir=dist        # 显式指定 electron-builder 产物目录
//   node out/check-asar.mjs                    # 默认 dist（package.json build.directories.output）
//   node out/check-asar.mjs --selftest         # 回归自检（PASS 组不误报 / FAIL 组不漏报）
// 退出码：
//   0 = 全部检查通过 / 自检全部通过
//   1 = 检出敏感项（报告清单打印后退出）/ 自检存在失败项
//   2 = 没有 asar 可查（"no asar provided"，需先 npm run dist）
//
// R17 返工（修复 R16 两处误报 + 降级扫描模式）：
//   - 扫描主模式改为 @electron/asar 精确解析（项目实际安装的包；旧代码 require('asar') 不存在，
//     导致真实产物退化为启发式扫描）：listPackage 取条目路径清单（路径检查），extractAll 解包后
//     逐文件读内容（内容检查）。路径检查与内容检查严格分离。
//   - URL 上下文判定：内容中 https?:// 或协议相对 // 的整段 URL 被等长空格遮蔽后再跑路径形态
//     规则，因此网页 URL 里的 /docs/、/users/ 不构成路径命中；ASAR 条目路径、反斜杠路径、裸路径
//     串等非 URL 上下文仍按路径命中（fail-closed 不降级）。
//   - 回退启发式扫描的头解析改为兼容现代 @electron/asar pickle 布局（旧解析器对真实产物失效，
//     曾退化为整包二进制扫描）。
//   - 检查范围分离（与 R16 审计口径一致，见 docs/r46-r16-release-evidence/b-asar-sbom/summary.txt）：
//       密钥类（api-key-plain / api-key-env / api-key-enc-value）覆盖全部条目含 node_modules——
//       依赖内嵌真实密钥同样是泄漏，fail-closed 全范围；
//       制品类（test-fixtures / source-bundle / user-paths）仅覆盖项目自有条目（out/**、package.json
//       等，即非 node_modules 条目）——node_modules 属 SBOM 管理的第三方包发布物，其自带测试文件、
//       站点元数据、构建机/作者本机路径字符串是包内容固有部分，不构成项目制品/用户语料泄漏。
//     （精确扫描对真实 asar 曾检出 169 处 node_modules 内 *.test.* 路径与 22 处依赖构建路径内容，
//     均为第三方包内容；项目自有内容 0 命中。--selftest 含范围边界回归用例。）
//   - 新增 --selftest 回归自检，覆盖 R16 两处误报与六类规则的真阳性，防止回归。

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as url from 'node:url'
import * as crypto from 'node:crypto'
import { createRequire } from 'node:module'

const SCRIPT_DIR = path.dirname(url.fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..')
const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// 敏感模式定义（R4.6 六类规则原样保留，仅内容层增加 URL 上下文遮蔽）
// ---------------------------------------------------------------------------

// 1) API key 明文：sk- 开头 32+ 字符（[A-Za-z0-9_-]）。注意与源码中的脱敏正则
//    /sk-[A-Za-z0-9]{16,}/ 不冲突：`sk-` 后紧跟 `[` 不满足字符类，不会误报。
const SK_KEY_RE = /sk-[A-Za-z0-9_-]{32,}/g
// 1) DEEPSEEK_API_KEY 环境变量名被烘进产物（真实 key 的 env 入口字符串不应出现）
//    注意：不使用 /g（配合 .test() 逐文件调用时 lastIndex 会漂移导致漏报）
const DEEPSEEK_ENV_RE = /DEEPSEEK_API_KEY/
// 1) apiKeyEnc 带非空值（settings.json 的 JSON 形态 "apiKeyEnc":"..."；排除代码里的属性访问
//    parsed.apiKeyEnc = enc / p.apiKeyEnc === 'string' —— 键必须带引号且值为引号括起的非空串）
const APIKEY_ENC_VALUE_RE = /["']?apiKeyEnc["']?\s*:\s*["']([^"']{2,})["']/g
// 2) 项目自有测试 fixture 目录 / 测试文件（第三方 node_modules 范围见 runScan）
const FIXTURE_PATH_RE = /(?:^|\/|\\)(?:fixtures?|__tests__|test-data|e2e-screenshots)(?:\/|\\|$)|\.(?:test|spec)\.(?:[jt]sx?|mjs|cjs)$/i
// 3) 项目自有源码 bundle / 文档（第三方 node_modules 范围见 runScan）
const SOURCE_BUNDLE_PATH_RE = /(?:^|\/)code-bundle\.txt$|(?:^|\/|\\)docs(?:\/|\\|$)/i
// 4) 本地绝对路径（用户语料 / userData 路径）——单反斜杠形态（真实路径 / 原始内容）
// 不使用 /g：路径层会对多个条目连续调用 .test()；全局正则的 lastIndex 会造成隔条漏检。
// 内容层需要遍历全部命中时，基于 source 单独创建带 /g 的局部正则。
const USER_PATH_RE =
  /(?:[A-Za-z]:[\\/]Users[\\/]|[\\/]Users[\\/]|[\\/]home[\\/]|[\\/]AppData[\\/]Roaming[\\/]|Library[\\/]Application Support[\\/])/i

// URL 上下文遮蔽：https?:// 整段 URL，以及协议相对 //（前缀为行首/空白/引号/左括号/等号等 URL
// 边界字符）。被遮蔽的整段 URL 以等长空格替换（偏移保持），其中的 /docs/、/users/、/home/ 等
// 不再被路径形态规则命中；非 URL 上下文（裸路径串、反斜杠路径、ASAR 条目路径）不受影响。
const URL_SPAN_RE = /((?:^|[\s"'([=])\/\/|https?:\/\/)[^\s"'<>`()]*/g
function maskUrlSpans(text: string): string {
  return text.replace(URL_SPAN_RE, (m) => ' '.repeat(m.length))
}

interface Finding {
  check: string
  detail: string
}

interface Check {
  id: string
  label: string
  /** 对文件路径清单的检查：返回命中片段数组（空数组 = 通过）——条目路径永不做 URL 遮蔽 */
  matchPaths: (paths: string[]) => string[]
  /** 对文件内容/原始字节的检查：返回命中片段数组（空数组 = 通过） */
  matchContent: (text: string) => string[]
}

const CHECKS: Check[] = [
  {
    id: 'api-key-plain',
    label: 'API key 明文（sk- 开头 32+ 字符）',
    matchPaths: () => [],
    matchContent: (t) => {
      SK_KEY_RE.lastIndex = 0
      const hits: string[] = []
      for (const _match of t.matchAll(SK_KEY_RE)) hits.push('[REDACTED_API_KEY]')
      return dedupe(hits)
    }
  },
  {
    id: 'api-key-env',
    label: 'DEEPSEEK_API_KEY（env 名烘入产物）',
    matchPaths: (ps) => ps.filter((p) => /DEEPSEEK_API_KEY/.test(p)),
    matchContent: (t) => (DEEPSEEK_ENV_RE.test(t) ? ['DEEPSEEK_API_KEY'] : [])
  },
  {
    id: 'api-key-enc-value',
    label: 'apiKeyEnc 非空值（settings.json 加密字段值烘入产物）',
    matchPaths: (ps) => ps.filter((p) => /["']?apiKeyEnc["']?\s*:\s*["'][^"']{2,}["']/.test(p)),
    matchContent: (t) => {
      APIKEY_ENC_VALUE_RE.lastIndex = 0
      const hits: string[] = []
      for (const _match of t.matchAll(APIKEY_ENC_VALUE_RE)) hits.push('[REDACTED_ENCRYPTED_CREDENTIAL]')
      return dedupe(hits)
    }
  },
  {
    id: 'test-fixtures',
    label: '项目自有测试 fixture 目录/文件（fixtures/、e2e-screenshots/、*.test.* 等）',
    matchPaths: (ps) => ps.filter((p) => FIXTURE_PATH_RE.test(p)),
    matchContent: (t) => {
      // 内容扫描仅兜底（fixture 目录本质是路径问题）；整包二进制扫描命中时给出片段
      const hits: string[] = []
      const re = /(?:fixtures?|e2e-screenshots|__tests__|test-data)[\\/]/gi
      for (const m of t.matchAll(re)) hits.push(snippet(m[0]))
      return dedupe(hits)
    }
  },
  {
    id: 'source-bundle',
    label: '项目自有源码 bundle / 文档（code-bundle.txt、docs/）',
    matchPaths: (ps) => ps.filter((p) => SOURCE_BUNDLE_PATH_RE.test(p)),
    matchContent: (t) => {
      // R17：URL 上下文中的 /docs/（如 https://.../docs/... 的网页 URL 路径）不是本地源码
      // bundle 路径，先遮蔽 URL 再扫描；裸路径 /docs/、code-bundle.txt 串仍按路径命中。
      const masked = maskUrlSpans(t)
      const hits: string[] = []
      const re = /code-bundle\.txt|[\\/]docs[\\/]/gi
      for (const m of masked.matchAll(re)) hits.push(snippet(m[0]))
      return dedupe(hits)
    }
  },
  {
    id: 'user-paths',
    label: '项目自有用户语料 / 本地绝对路径（C:\\Users\\、/Users/、AppData、userData 路径）',
    matchPaths: (ps) => ps.filter((p) => USER_PATH_RE.test(p)),
    matchContent: (t) => {
      // R17：https://github.com/users/xxx 等 URL 中的 /users/ 是网页 URL 路径，不是本机用户路径，
      // 先遮蔽 URL 再扫描；C:\Users\、/Users/、/home/、AppData\Roaming 等非 URL 形态仍命中。
      const masked = maskUrlSpans(t)
      const userPathGlobalRe = new RegExp(USER_PATH_RE.source, 'gi')
      const hits: string[] = []
      // Never copy surrounding content into diagnostics: a neighboring value
      // may be a credential, including one truncated below a detection limit.
      for (const _match of masked.matchAll(userPathGlobalRe)) hits.push('[REDACTED_LOCAL_PATH]')
      return dedupe(hits)
    }
  }
]

function redactDiagnostic(s: string): string {
  // Redact before shortening. This also protects filenames and directory hints,
  // not only findings classified as credential checks.
  return s
    .replace(new RegExp(SK_KEY_RE.source, 'g'), '[REDACTED_API_KEY]')
    .replace(new RegExp(APIKEY_ENC_VALUE_RE.source, 'g'), '[REDACTED_ENCRYPTED_CREDENTIAL]')
}

function snippet(s: string, max = 120): string {
  const flat = redactDiagnostic(s).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)]
}

function dedupeFindings(fs_: Finding[]): Finding[] {
  const seen = new Set<string>()
  return fs_.filter((f) => {
    const k = `${f.check}|${f.detail}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---------------------------------------------------------------------------
// 统一扫描执行器：条目路径检查与文件内容检查严格分离
// ---------------------------------------------------------------------------

// 制品类规则 id（范围限定为项目自有条目）；密钥类规则不在集合内 → 覆盖全部条目
const ARTIFACT_CHECK_IDS = new Set(['test-fixtures', 'source-bundle', 'user-paths'])
const NODE_MODULES = 'node_modules'

/** 项目自有条目判定：非 node_modules 顶层及其子树（node_modules 属 SBOM 管理的第三方包内容） */
function isProjectOwnedEntry(p: string): boolean {
  return p !== NODE_MODULES && !p.startsWith(`${NODE_MODULES}/`)
}

interface ScanInput {
  mode: string
  entryCount: number
  /** 条目路径清单（文件 + 目录，'/'-分隔、无前导斜杠；仅用于 matchPaths） */
  entryPaths: string[]
  /** 解包后的逐文件内容（仅文件；用于 matchContent） */
  fileContents: Array<{ relPath: string; text: string }>
}

interface ScanResult {
  mode: string
  entryCount: number
  findings: Finding[]
}

function runScan(input: ScanInput): ScanResult {
  const findings: Finding[] = []
  // 1) 条目路径层（不做 URL 遮蔽：ASAR 条目路径永远是"路径"语义）
  //    制品类规则仅对项目自有条目运行（跳过 node_modules 第三方包内容）
  for (const c of CHECKS) {
    const scope = ARTIFACT_CHECK_IDS.has(c.id) ? input.entryPaths.filter(isProjectOwnedEntry) : input.entryPaths
    for (const p of c.matchPaths(scope)) {
      findings.push({ check: c.id, detail: `path: ${snippet(p)}` })
    }
  }
  // 2) 内容层（逐文件，先经各检查自身的 URL 上下文遮蔽逻辑；制品类规则同样跳过 node_modules 文件）
  for (const f of input.fileContents) {
    for (const c of CHECKS) {
      if (ARTIFACT_CHECK_IDS.has(c.id) && !isProjectOwnedEntry(f.relPath)) continue
      const hits = c.matchContent(f.text)
      if (hits.length) {
        findings.push({ check: c.id, detail: `file ${snippet(f.relPath)}: ${hits[0]}` })
      }
    }
  }
  return { mode: input.mode, entryCount: input.entryCount, findings: dedupeFindings(findings) }
}

/** 条目路径归一化：@electron/asar listPackage 在 Windows 上返回反斜杠+前导斜杠，统一为 '/' */
function normalizeEntryPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '')
}

// ---------------------------------------------------------------------------
// 参数解析 / 查找 app.asar
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dir?: string; selftest?: boolean } {
  const out: { dir?: string; selftest?: boolean } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--dir=')) out.dir = a.slice('--dir='.length)
    else if (a === '--dir') {
      out.dir = argv[i + 1] ?? ''
      i++
    } else if (a === '--selftest') out.selftest = true
  }
  return out
}

/** 在产物目录下有限深度内查找 app.asar（覆盖 win-unpacked/linux-unpacked/mac 布局） */
function findAsarFiles(dir: string, maxDepth = 5): string[] {
  const found: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules') continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile() && e.name === 'app.asar') found.push(full)
    }
  }
  walk(dir, 0)
  return found
}

/** 读取 package.json 的 build.files / directories.output 配置用于提示 */
function readBuildHints(): { files: unknown; outputDir: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'))
    return {
      files: pkg?.build?.files ?? null,
      outputDir: pkg?.build?.directories?.output ?? 'dist'
    }
  } catch {
    return { files: null, outputDir: 'dist' }
  }
}

// ---------------------------------------------------------------------------
// 扫描模式
// ---------------------------------------------------------------------------

interface AsarApi {
  listPackage: (archivePath: string) => string[]
  extractAll: (archivePath: string, dest: string) => void
}

/** 主模式 A：@electron/asar 精确解析（listPackage 条目路径 + extractAll 解包逐文件内容） */
function scanWithElectronAsar(asarPath: string): ScanResult {
  const asar = require('@electron/asar') as AsarApi
  const entryPaths = asar.listPackage(asarPath).map(normalizeEntryPath)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-asar-'))
  try {
    asar.extractAll(asarPath, tmp)
    const fileContents: Array<{ relPath: string; text: string }> = []
    const walk = (d: string, rel: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        const relPath = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          walk(full, relPath)
        } else if (e.isFile()) {
          // latin1 逐字节无损映射，ASCII 敏感模式不受编码影响
          fileContents.push({ relPath, text: fs.readFileSync(full, 'latin1') })
        }
      }
    }
    walk(tmp, '')
    return runScan({
      mode: '@electron/asar 精确解析（listPackage 条目路径 + extractAll 解包逐文件内容）',
      entryCount: entryPaths.length,
      entryPaths,
      fileContents
    })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * 解析 asar 头。优先现代 @electron/asar pickle 布局，回退旧版布局：
 *   现代: [4B sizePickle=4][4B headerPickleLen][4B pickleLen][4B strLen][JSON...][payload]
 *   旧版: [4B headerLen][JSON...][payload]
 */
function parseAsarHeader(buf: Buffer): { paths: string[]; payloadStart: number } | null {
  const walk = (
    node: Record<string, { files?: unknown }>,
    prefix: string,
    paths: string[]
  ): void => {
    for (const [name, child] of Object.entries(node)) {
      const p = prefix ? `${prefix}/${name}` : name
      paths.push(p)
      if (child && typeof child === 'object' && child.files && typeof child.files === 'object') {
        walk(child.files as Record<string, { files?: unknown }>, p, paths)
      }
    }
  }
  const build = (jsonText: string, payloadStart: number): { paths: string[]; payloadStart: number } => {
    const header = JSON.parse(jsonText) as { files?: Record<string, { files?: unknown }> }
    const paths: string[] = []
    if (header.files) walk(header.files, '', paths)
    return { paths, payloadStart }
  }
  try {
    // 现代布局：sizePickle 载荷恒为 4
    if (buf.length >= 16 && buf.readUInt32LE(0) === 4) {
      const headerPickleLen = buf.readUInt32LE(4)
      const strLen = buf.readUInt32LE(12)
      if (headerPickleLen > 0 && strLen > 0 && 16 + strLen <= buf.length) {
        const t = buf.subarray(16, 16 + strLen).toString('utf8')
        if (t.trimStart().startsWith('{')) {
          return build(t, 8 + headerPickleLen)
        }
      }
    }
    // 旧版布局
    if (buf.length >= 12) {
      const headerLen = buf.readUInt32LE(4)
      if (headerLen > 0 && 8 + headerLen <= buf.length) {
        const t = buf.subarray(8, 8 + headerLen).toString('utf8')
        if (t.trimStart().startsWith('{')) {
          return build(t, 8 + headerLen)
        }
      }
    }
    return null
  } catch {
    return null
  }
}

/** 回退模式 B/C：@electron/asar 不可用时的启发式扫描（B 解析头 JSON，C 整包二进制）。
 *  注意：回退模式下内容为整包 blob，无法按条目区分文件归属，制品类规则对整个 payload 扫描
 *  （保守处理）；正常构建 @electron/asar 可用，走精确模式。 */
function scanHeuristic(asarPath: string): ScanResult {
  const buf = fs.readFileSync(asarPath)
  const header = parseAsarHeader(buf)
  if (header) {
    const payload = buf.subarray(header.payloadStart).toString('latin1')
    return runScan({
      mode: 'heuristic（asar 头解析 + payload 字节扫描，@electron/asar 不可用时的回退）',
      entryCount: header.paths.length,
      entryPaths: header.paths.map(normalizeEntryPath),
      fileContents: [{ relPath: '<payload>', text: payload }]
    })
  }
  return runScan({
    mode: 'heuristic（整包二进制扫描，asar 头不可解析）',
    entryCount: -1,
    entryPaths: [],
    fileContents: [{ relPath: '<raw-bytes>', text: buf.toString('latin1') }]
  })
}

// ---------------------------------------------------------------------------
// --selftest 回归自检：PASS 组（不得误报）+ FAIL 组（不得漏报）
// ---------------------------------------------------------------------------

function runSelfTest(): boolean {
  const results: Array<{ name: string; ok: boolean; note: string }> = []
  const record = (name: string, ok: boolean, note = ''): void => {
    results.push({ name, ok, note })
  }
  const contentHits = (text: string): string[] =>
    CHECKS.flatMap((c) => c.matchContent(text).map((h) => c.id))
  const pathHits = (paths: string[]): string[] =>
    CHECKS.flatMap((c) => c.matchPaths(paths).map((h) => c.id))

  // ---- PASS 组（不得误报）----
  {
    const t = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript'
    const h = contentHits(t)
    record('PASS 组: 内容 https://developer.mozilla.org/en-US/docs/... 必须不触发 docs 规则', h.length === 0, `实际命中: ${h.join(',') || '无'}`)
  }
  {
    const t = 'https://github.com/users/alice'
    const h = contentHits(t)
    record('PASS 组: 内容 https://github.com/users/alice 必须不触发 users 规则', h.length === 0, `实际命中: ${h.join(',') || '无'}`)
  }
  {
    const h = pathHits(['out/main/index.js'])
    record('PASS 组: 条目 out/main/index.js 必须无任何命中', h.length === 0, `实际命中: ${h.join(',') || '无'}`)
  }
  {
    const t = 'See //cdn.example.com/docs/guide for details'
    const h = contentHits(t)
    record('PASS 组: 协议相对 URL //cdn.example.com/docs/guide 必须不触发', h.length === 0, `实际命中: ${h.join(',') || '无'}`)
  }
  {
    const t = 'ref https://example.com/users/name/docs/x and https://example.com/home/'
    const h = contentHits(t)
    record('PASS 组: 多个 URL（users/docs/home 路径段）必须全部不触发', h.length === 0, `实际命中: ${h.join(',') || '无'}`)
  }
  {
    const r = runScan({
      mode: 'selftest',
      entryCount: 2,
      entryPaths: ['out/main/index.js', 'package.json'],
      fileContents: [{ relPath: 'package.json', text: '{"name":"deepwriter"}' }]
    })
    record('PASS 组: 端到端干净条目+内容 → 0 findings', r.findings.length === 0, `实际命中: ${r.findings.map((f) => f.detail).join(',') || '无'}`)
  }

  // ---- FAIL 组（不得漏报：真阳性必须命中对应规则）----
  const failCases: Array<{ name: string; hit: string[]; want: string[] }> = [
    {
      name: 'FAIL 组: 条目 docs/x.md 必须命中 source-bundle',
      hit: pathHits(['docs/x.md']),
      want: ['source-bundle']
    },
    {
      name: 'FAIL 组: 条目 code-bundle.txt 必须命中 source-bundle',
      hit: pathHits(['code-bundle.txt']),
      want: ['source-bundle']
    },
    {
      name: 'FAIL 组: 条目 e2e-screenshots/main.png 必须命中 test-fixtures',
      hit: pathHits(['e2e-screenshots/main.png']),
      want: ['test-fixtures']
    },
    {
      name: 'FAIL 组: 条目 fixtures/data.json 必须命中 test-fixtures',
      hit: pathHits(['fixtures/data.json']),
      want: ['test-fixtures']
    },
    {
      name: 'FAIL 组: 内容 C:\\Users\\name\\AppData\\Roaming\\... 必须命中 user-paths',
      hit: contentHits('C:\\Users\\name\\AppData\\Roaming\\DeepWriter\\settings.json'),
      want: ['user-paths']
    },
    {
      name: 'FAIL 组: 内容 /Users/name/Documents/... 必须命中 user-paths',
      hit: contentHits('/Users/name/Documents/notes.md'),
      want: ['user-paths']
    },
    {
      name: 'FAIL 组: 内容 /home/name/.config/... 必须命中 user-paths',
      hit: contentHits('/home/name/.config/app/config.json'),
      want: ['user-paths']
    },
    {
      name: 'FAIL 组: 内容 C:/Users/x/AppData/Roaming 必须命中 user-paths',
      hit: contentHits('C:/Users/x/AppData/Roaming/app'),
      want: ['user-paths']
    },
    {
      name: 'FAIL 组: 内容 sk- 开头 32+ 字符必须命中 api-key-plain',
      hit: contentHits('sk-Abcdefghij1234567890Abcdefghij1234567890'),
      want: ['api-key-plain']
    },
    {
      name: 'FAIL 组: 内容 DEEPSEEK_API_KEY 字符串必须命中 api-key-env',
      hit: contentHits('process.env.DEEPSEEK_API_KEY'),
      want: ['api-key-env']
    },
    {
      name: 'FAIL 组: 内容 "apiKeyEnc":"abc123" 必须命中 api-key-enc-value',
      hit: contentHits('{"apiKeyEnc":"abc123"}'),
      want: ['api-key-enc-value']
    },
    {
      name: 'FAIL 组: 内容裸 /docs/ 串（非 URL 上下文）必须命中 source-bundle',
      hit: contentHits('path = /docs/release-notes.md'),
      want: ['source-bundle']
    },
    {
      name: 'FAIL 组: 内容裸 code-bundle.txt 串必须命中 source-bundle',
      hit: contentHits('artifact: code-bundle.txt'),
      want: ['source-bundle']
    }
  ]
  for (const c of failCases) {
    record(c.name, c.want.every((w) => c.hit.includes(w)), `实际命中: ${c.hit.join(',') || '无'}`)
  }

  // ---- 端到端 FAIL：条目命中 + 内容命中同时检出 ----
  {
    const r = runScan({
      mode: 'selftest',
      entryCount: 2,
      entryPaths: ['out/main/index.js', 'docs/x.md'],
      fileContents: [{ relPath: 'package.json', text: '{"apiKeyEnc":"abc123"}' }]
    })
    const ids = new Set(r.findings.map((f) => f.check))
    record(
      'FAIL 组: 端到端 docs/x.md 条目 + apiKeyEnc 内容 → source-bundle + api-key-enc-value',
      ids.has('source-bundle') && ids.has('api-key-enc-value'),
      `实际命中: ${[...ids].join(',') || '无'}`
    )
  }

  // ---- 检查范围边界回归（制品类规则跳过 node_modules 第三方包内容；密钥类规则全范围） ----
  {
    const r = runScan({
      mode: 'selftest',
      entryCount: 3,
      entryPaths: [
        'node_modules/lib/tests/all-errors.test.ts',
        'node_modules/lib/tests/e2e-screenshots/x.png',
        'node_modules/lib/dist/docs.md'
      ],
      fileContents: [
        { relPath: 'node_modules/lib/dist/index.js', text: '/Users/builder/AppData/Roaming/x' }
      ]
    })
    record(
      'PASS 组: node_modules 内自带测试/站点/构建路径内容 → 制品类规则不命中（第三方包范围外）',
      r.findings.length === 0,
      `实际命中: ${r.findings.map((f) => f.check).join(',') || '无'}`
    )
  }
  {
    const input: ScanInput = {
      mode: 'selftest',
      entryCount: 2,
      entryPaths: ['C:/Users/alice/project-a', 'D:/Users/bob/project-b'],
      fileContents: []
    }
    const r = runScan(input)
    const hits = r.findings.filter((f) => f.check === 'user-paths')
    record(
      'FAIL 组: 两条连续匹配路径必须全部命中（无 lastIndex 隔条漏检）',
      hits.length === 2,
      `实际命中数: ${hits.length}`
    )
  }
  {
    const r = runScan({
      mode: 'selftest',
      entryCount: 3,
      entryPaths: ['C:/Users/alice/project-a', 'out/main/index.js', 'D:/Users/bob/project-b'],
      fileContents: []
    })
    const hits = r.findings.filter((f) => f.check === 'user-paths')
    record(
      'FAIL 组: 不匹配路径夹在两条匹配路径之间时前后均须命中',
      hits.length === 2,
      `实际命中数: ${hits.length}`
    )
  }
  {
    const input: ScanInput = {
      mode: 'selftest',
      entryCount: 2,
      entryPaths: ['C:/Users/alice/project-a', 'D:/Users/bob/project-b'],
      fileContents: []
    }
    const first = runScan(input).findings.filter((f) => f.check === 'user-paths').length
    const second = runScan(input).findings.filter((f) => f.check === 'user-paths').length
    record(
      'FAIL 组: 连续多次路径扫描结果必须确定且一致',
      first === 2 && second === 2,
      `第一次: ${first}，第二次: ${second}`
    )
  }
  {
    const r = runScan({
      mode: 'selftest',
      entryCount: 2,
      entryPaths: ['out/main/index.js'],
      fileContents: [{ relPath: 'out/main/index.js', text: 'ref C:\\Users\\name\\AppData\\Roaming\\app' }]
    })
    const ids = new Set(r.findings.map((f) => f.check))
    record(
      'FAIL 组: 项目自有文件内容含本机路径 → user-paths 仍命中',
      ids.has('user-paths'),
      `实际命中: ${[...ids].join(',') || '无'}`
    )
  }
  {
    const r = runScan({
      mode: 'selftest',
      entryCount: 2,
      entryPaths: ['out/main/index.js'],
      fileContents: [{ relPath: 'node_modules/lib/index.js', text: 'sk-Abcdefghij1234567890Abcdefghij1234567890' }]
    })
    const ids = new Set(r.findings.map((f) => f.check))
    record(
      'FAIL 组: node_modules 内真实密钥形态 → api-key-plain 仍命中（密钥类规则全范围）',
      ids.has('api-key-plain'),
      `实际命中: ${[...ids].join(',') || '无'}`
    )
  }

  console.log('')
  console.log('===== check-asar 自检（--selftest）=====')
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? `  (${r.note})` : ''}`)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log('')
  console.log(`SELFTEST: ${results.length - failed}/${results.length} 通过${failed ? `，${failed} 项失败` : ''}`)
  return failed === 0
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.selftest) {
    process.exit(runSelfTest() ? 0 : 1)
  }
  const build = readBuildHints()
  const dirArg = args.dir ?? ''
  const dir = dirArg
    ? path.resolve(process.cwd(), dirArg)
    : path.join(PROJECT_ROOT, String(build.outputDir))

  console.log(`[check-asar] 产物目录: ${redactDiagnostic(dir)}`)

  if (!fs.existsSync(dir)) {
    console.log('no asar provided')
    console.log(`[check-asar] 目录不存在：${redactDiagnostic(dir)}`)
    console.log(`[check-asar] 提示：请先运行 npm run dist（electron-vite build && electron-builder --win），产物输出到 ${redactDiagnostic(build.outputDir)}/`)
    console.log(`[check-asar] 提示：package.json build.files 配置为 ${redactDiagnostic(JSON.stringify(build.files))}，仅 out/** 与 package.json 会进包；dist 中预期出现 win-unpacked/resources/app.asar`)
    process.exit(2)
  }

  const asarFiles = findAsarFiles(dir)
  if (asarFiles.length === 0) {
    console.log('no asar provided')
    console.log(`[check-asar] ${redactDiagnostic(dir)} 下未找到 app.asar（已递归查找）`)
    console.log(`[check-asar] 提示：electron-builder 产物布局通常是 ${redactDiagnostic(path.join(build.outputDir, 'win-unpacked', 'resources', 'app.asar'))}；请先运行 npm run dist 再检查`)
    process.exit(2)
  }

  console.log(`[check-asar] 找到 ${asarFiles.length} 个 app.asar：`)
  let asarPkgAvailable = false
  try {
    require.resolve('@electron/asar')
    asarPkgAvailable = true
  } catch {
    asarPkgAvailable = false
  }
  if (!asarPkgAvailable) {
    console.log('[check-asar] 提示: @electron/asar 包不可用，采用启发式扫描（heuristic），命中片段需人工复核')
  }
  let allFindings: Finding[] = []
  for (const f of asarFiles) {
    console.log(`  - ${redactDiagnostic(f)}`)
    const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
    console.log(`[check-asar]   ASAR SHA256: ${sha}`)
    const res = asarPkgAvailable ? scanWithElectronAsar(f) : scanHeuristic(f)
    console.log(`[check-asar] 模式: ${res.mode}${res.entryCount >= 0 ? `，条目数: ${res.entryCount}` : '，条目数: 未知（头不可解析）'}`)
    allFindings = allFindings.concat(res.findings)
  }

  console.log('')
  console.log('===== 检查结果 =====')
  let passed = 0
  const failed: Array<{ check: Check; findings: Finding[] }> = []
  for (const c of CHECKS) {
    const hits = allFindings.filter((f) => f.check === c.id)
    if (hits.length === 0) {
      passed++
      console.log(`  PASS  ${c.label}`)
    } else {
      failed.push({ check: c, findings: hits })
      console.log(`  FAIL  ${c.label}（命中 ${hits.length} 处）`)
      for (const h of hits.slice(0, 10)) {
        console.log(`        - ${h.detail}`)
      }
      if (hits.length > 10) console.log(`        - … 其余 ${hits.length - 10} 处省略`)
    }
  }
  console.log('')

  if (failed.length === 0) {
    console.log(`RESULT: PASS（${passed}/${CHECKS.length} 项检查通过，敏感项 0 处）`)
    process.exit(0)
  } else {
    console.log(`RESULT: FAIL（${passed}/${CHECKS.length} 项通过，${failed.length} 项检出敏感项，共 ${allFindings.length} 处）`)
    console.log('处置：检出项必须人工确认并从产物中排除后重新 dist，再跑本检查直至 PASS。')
    process.exit(1)
  }
}

main()
