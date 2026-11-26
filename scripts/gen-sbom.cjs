'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function parseArgs(argv) {
  const options = {
    version: undefined,
    output: undefined,
    root: ROOT,
    allowOutputRoot: undefined
  }
  const valueOptions = new Map([
    ['--version', 'version'],
    ['--expected-version', 'version'],
    ['--output', 'output'],
    ['--output-doc', 'output'],
    ['--allow-output-root', 'allowOutputRoot'],
    ['--root', 'root'],
    ['--project-dir', 'root']
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const equals = arg.indexOf('=')
    const name = equals >= 0 ? arg.slice(0, equals) : arg
    const key = valueOptions.get(name)
    if (!key) throw new Error(`unknown option: ${arg}`)
    const value = equals >= 0 ? arg.slice(equals + 1) : argv[++index]
    if (typeof value !== 'string' || value === '') throw new Error(`${name} requires a value`)
    options[key] = value
  }

  options.root = path.resolve(options.root)
  return options
}

function normalizeVersion(value) {
  const version = String(value ?? '').trim()
  if (!version) throw new Error('version is required')
  if (version.includes('/') || version.includes('\\') || version === '.' || version === '..') {
    throw new Error(`invalid version for output path: ${version}`)
  }
  return version
}

function normalizeLicense(raw) {
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.type === 'string' && raw.type.trim() !== '') return raw.type.trim()
    if (Array.isArray(raw.licenses)) {
      const parts = raw.licenses
        .map((license) => (license && typeof license.type === 'string' ? license.type : null))
        .filter(Boolean)
      if (parts.length) return parts.join(' OR ')
    }
  }
  if (Array.isArray(raw)) {
    const parts = raw.filter((license) => typeof license === 'string' && license.trim() !== '')
    if (parts.length) return parts.join(' OR ')
  }
  return 'unknown'
}

function manifestHash(bytes) {
  return `sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}`
}

function lockEntry(lock, name) {
  return lock?.packages?.[`node_modules/${name}`] ?? null
}

function readInstalled(root, lock, name) {
  const manifestPath = path.join(root, 'node_modules', ...name.split('/'), 'package.json')
  try {
    const bytes = fs.readFileSync(manifestPath)
    const raw = JSON.parse(bytes.toString('utf8'))
    const installed = typeof raw.version === 'string' && raw.version !== '' ? raw.version : 'unknown'
    const packageName = typeof raw.name === 'string' && raw.name !== '' ? raw.name : name
    return {
      name: packageName,
      version: installed,
      license: normalizeLicense(raw.license ?? raw.licenses),
      manifestHash: manifestHash(bytes),
      integrity: lockEntry(lock, name)?.integrity ?? 'unknown'
    }
  } catch {
    return {
      name,
      version: 'unknown',
      license: 'unknown',
      manifestHash: 'unknown',
      integrity: lockEntry(lock, name)?.integrity ?? 'unknown'
    }
  }
}

function collect(root, lock, declarations = {}) {
  return Object.keys(declarations)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const installed = readInstalled(root, lock, name)
      return {
        name: installed.name,
        declared: declarations[name],
        installed: installed.version,
        license: installed.license,
        manifestHash: installed.manifestHash,
        integrity: installed.integrity
      }
    })
}

function table(rows) {
  const lines = ['| 包名 | 已安装版本 | 声明范围 | 许可证 | 安装 manifest SHA-256 | 锁定 integrity |', '|---|---|---|---|---|---|']
  for (const row of rows) {
    lines.push(`| ${row.name} | ${row.installed} | \`${row.declared}\` | ${row.license} | \`${row.manifestHash}\` | \`${row.integrity}\` |`)
  }
  return lines.join('\n')
}

function safeVersionFilePart(version) {
  return version.replace(/[^A-Za-z0-9._-]/g, '_')
}

function isWithinRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function chooseDefaultOutput(root, version) {
  return path.join(root, 'docs', `SBOM_DEPENDENCIES_${safeVersionFilePart(version)}.md`)
}

function resolveOutput(root, version, output, allowOutputRoot) {
  const outputRoot = allowOutputRoot === undefined ? path.resolve(root) : path.resolve(allowOutputRoot)
  let outputRootStat
  try {
    outputRootStat = fs.lstatSync(outputRoot)
  } catch (error) {
    throw new Error(`allow-output-root is not readable: ${outputRoot} (${error.message})`)
  }
  if (!outputRootStat.isDirectory()) throw new Error(`allow-output-root is not a directory: ${outputRoot}`)
  const outputPath = output === undefined
    ? chooseDefaultOutput(outputRoot, version)
    : (path.isAbsolute(output) ? path.normalize(output) : path.resolve(outputRoot, output))
  if (!isWithinRoot(outputRoot, outputPath)) throw new Error(`SBOM output escapes allowed output root: ${outputPath}`)
  if (fs.existsSync(outputPath)) throw new Error(`output already exists; refusing to overwrite: ${outputPath}`)
  return { outputPath, outputRoot }
}

function buildDocument({ packageData, packageVersion, version, prod, dev, electron, builder }) {
  const now = new Date().toISOString()
  const generatedCommand = `node scripts/gen-sbom.cjs --version ${version}`
  const unknown = [...prod, ...dev].filter((row) => row.license === 'unknown' || row.installed === 'unknown' || row.manifestHash === 'unknown' || row.integrity === 'unknown')
  return `# DeepWriter SBOM 依赖清单（SBOM_DEPENDENCIES）

> 生成时间：${now}　|　生成命令：\`${generatedCommand}\`　|　项目版本：${version}（${packageData.name}）
> package.json 当前版本：${packageVersion}。
> 数据来源：\`package.json\` 声明 + \`node_modules/<pkg>/package.json\` 的已安装 \`version\` / \`license\` 字段；manifest SHA-256 为该文件原始字节的 SHA-256，可直接复算；integrity 来自 package-lock.json。
> 任何包读不到已安装元数据时，该行版本/许可证/hash 标 \`unknown\`，表示**需人工确认**。

## 1. 运行 SBOM（production dependencies —— 随 asar 进入安装包的运行时依赖）

共 ${prod.length} 个包。

${table(prod)}

## 2. 开发依赖（devDependencies —— 不进入安装包，单列备查）

共 ${dev.length} 个包。

${table(dev)}

## 3. 已知 Electron 供应链风险说明（如实标注，unknown = 未自动核验，需人工确认）

> 以下状态为**自动采集的已安装版本号、manifest SHA-256 与 lock integrity**；维护活跃度、CVE 公告、上游仓库健康度**未自动核验**，发布前需人工逐一确认（本文件不声称已审计）。

- **Electron**：已安装 ${electron.version}（声明 \`${packageData.devDependencies?.electron ?? 'unknown'}\`，manifest SHA-256 \`${electron.manifestHash}\`，integrity \`${electron.integrity}\`）。Chromium/Node 内核迭代快，历史 CVE 密集；**维护状态：unknown，需人工确认**当前版本是否处于支持窗口并核对已知漏洞。
- **electron-builder**：已安装 ${builder.version}（声明 \`${packageData.devDependencies?.['electron-builder'] ?? 'unknown'}\`，manifest SHA-256 \`${builder.manifestHash}\`，integrity \`${builder.integrity}\`）。构建链自身即供应链攻击面（打包脚本、下载二进制、NSIS/签名工具链）；**维护状态：unknown，需人工确认**。
- **解析/文档处理库**（处理用户上传附件与导出，最易受恶意文件触发的攻击面）：
  - \`pdf-parse\`：已安装 ${readInstalledFromRows(prod, dev, 'pdf-parse').version} —— **维护状态：unknown，需人工确认**。
  - \`mammoth\`：已安装 ${readInstalledFromRows(prod, dev, 'mammoth').version} —— **维护状态：unknown，需人工确认**。
  - \`fflate\`：已安装 ${readInstalledFromRows(prod, dev, 'fflate').version} —— **维护状态：unknown，需人工确认**（zip 解压需关注 zip bomb / 路径逃逸防护）。
  - 相邻的 \`docx\` / \`exceljs\` / \`pdfkit\`（文档生成）：**维护状态：unknown，需人工确认**。
- **一般性说明**：所有包按 package-lock.json 锁定安装；manifest hash 可由对应 package.json 原始字节复算。许可证字段、版本、hash 或 integrity 为 \`unknown\` 的包在商用分发前需人工核验。

## 4. 复核记录（人工确认后填写）

| 日期 | 确认人 | 已核验项 | 结论 |
|---|---|---|---|
| （待填） | （待填） | Electron / electron-builder / 解析库维护状态 | pending |

<!-- unknown rows: ${unknown.length} -->
`
}

function readInstalledFromRows(prod, dev, name) {
  return [...prod, ...dev].find((row) => row.name === name) ?? { version: 'unknown' }
}

function generateSbom({ root = ROOT, version, output, allowOutputRoot } = {}) {
  const projectRoot = path.resolve(root)
  const packageData = readJson(path.join(projectRoot, 'package.json'))
  const lockPath = path.join(projectRoot, 'package-lock.json')
  let lock = null
  try {
    lock = readJson(lockPath)
  } catch {
    lock = null
  }
  const packageVersion = normalizeVersion(packageData.version)
  const targetVersion = normalizeVersion(version === undefined ? packageVersion : version)
  const resolvedOutput = resolveOutput(projectRoot, targetVersion, output, allowOutputRoot)
  const outputPath = resolvedOutput.outputPath
  const prod = collect(projectRoot, lock, packageData.dependencies ?? {})
  const dev = collect(projectRoot, lock, packageData.devDependencies ?? {})
  const electron = readInstalled(projectRoot, lock, 'electron')
  const builder = readInstalled(projectRoot, lock, 'electron-builder')
  const document = buildDocument({ packageData, packageVersion, version: targetVersion, prod, dev, electron, builder })
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, document, 'utf8')
  return {
    root: projectRoot,
    packageVersion,
    version: targetVersion,
    outputPath,
    outputRoot: resolvedOutput.outputRoot,
    prod,
    dev,
    unknown: [...prod, ...dev].filter((row) => row.license === 'unknown' || row.installed === 'unknown' || row.manifestHash === 'unknown' || row.integrity === 'unknown')
  }
}

function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
    const result = generateSbom(options)
    console.log(`[gen-sbom] 已生成 ${path.relative(result.root, result.outputPath) || result.outputPath}`)
    console.log(`[gen-sbom] project version: ${result.packageVersion}; SBOM version: ${result.version}`)
    console.log(`[gen-sbom] production deps: ${result.prod.length}，dev deps: ${result.dev.length}`)
    console.log(`[gen-sbom] 版本/许可证/hash/integrity unknown 待人工确认: ${result.unknown.length} 项${result.unknown.length ? '（' + result.unknown.map((row) => row.name).join(', ') + '）' : ''}`)
    return 0
  } catch (error) {
    console.error(`[gen-sbom] FAIL ${error.message}`)
    return 1
  }
}

if (require.main === module) process.exitCode = main()

module.exports = {
  buildDocument,
  chooseDefaultOutput,
  collect,
  generateSbom,
  manifestHash,
  normalizeLicense,
  parseArgs,
  readInstalled,
  resolveOutput
}
