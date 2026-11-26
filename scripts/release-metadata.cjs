'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const REQUIRED_BUILD_FILES = [
  'out/main/**',
  'out/preload/**',
  'out/renderer/**',
  'package.json',
  'build/icon.ico'
]

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function parseArgs(argv) {
  const options = {
    expectedVersion: undefined,
    artifactDir: undefined,
    outputDoc: undefined,
    allowOutputRoot: undefined,
    root: ROOT
  }
  const valueOptions = new Map([
    ['--expected-version', 'expectedVersion'],
    ['--version', 'expectedVersion'],
    ['--artifact-dir', 'artifactDir'],
    ['--dir', 'artifactDir'],
    ['--output-doc', 'outputDoc'],
    ['--output', 'outputDoc'],
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

function resolveFromRoot(root, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value)
}

function isWithinRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function resolveOutputPath(projectRoot, outputDoc, allowOutputRoot) {
  const outputRoot = allowOutputRoot === undefined ? projectRoot : path.resolve(allowOutputRoot)
  let outputRootStat
  try {
    outputRootStat = fs.lstatSync(outputRoot)
  } catch (error) {
    throw new Error(`allow-output-root is not readable: ${outputRoot} (${error.message})`)
  }
  if (!outputRootStat.isDirectory()) throw new Error(`allow-output-root is not a directory: ${outputRoot}`)
  const outputPath = resolveFromRoot(projectRoot, outputDoc)
  if (!isWithinRoot(outputRoot, outputPath)) {
    throw new Error(`output doc escapes allowed output root: ${outputPath}`)
  }
  return { outputPath, outputRoot }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase()
}

function collectArtifactFiles(artifactDir) {
  const files = []
  const walk = (directory, relativeDirectory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
      if (entry.isDirectory()) walk(fullPath, relativePath)
      else if (entry.isFile()) {
        files.push({
          path: relativePath.split(path.sep).join('/'),
          size: fs.statSync(fullPath).size,
          sha256: sha256File(fullPath)
        })
      }
    }
  }
  walk(artifactDir, '')
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function renderArtifactReport({ root, artifactDir, packageName, version, files }) {
  const relativeDir = path.relative(root, artifactDir).split(path.sep).join('/') || '.'
  const lines = [
    `# ${packageName} ${version} 发布候选制品元数据`,
    '',
    `> 构建目录：\`${relativeDir}\`　|　应用版本：${version}`,
    '',
    '## 制品校验',
    '',
    '| 制品 | 大小（bytes） | SHA-256 |',
    '|---|---:|---|'
  ]
  for (const file of files) lines.push(`| \`${file.path}\` | ${file.size} | \`${file.sha256}\` |`)
  if (files.length === 0) lines.push('| （空目录） | 0 | — |')
  lines.push('', '## 发布门禁', '', '- 元数据校验：PASS', '- 本文件由 `scripts/release-metadata.cjs` 生成。', '')
  return lines.join('\n')
}

function validateReleaseMetadata({
  root = ROOT,
  expectedVersion,
  artifactDir,
  outputDoc,
  allowOutputRoot
} = {}) {
  const projectRoot = path.resolve(root)
  const errors = []
  const check = (condition, message) => {
    if (!condition) errors.push(message)
  }
  let pkg
  let lock
  try {
    pkg = readJson(path.join(projectRoot, 'package.json'))
  } catch (error) {
    errors.push(`package.json unreadable: ${error.message}`)
  }
  try {
    lock = readJson(path.join(projectRoot, 'package-lock.json'))
  } catch (error) {
    errors.push(`package-lock.json unreadable: ${error.message}`)
  }

  const packageVersion = typeof pkg?.version === 'string' ? pkg.version : ''
  const targetVersion = typeof expectedVersion === 'string' && expectedVersion.trim() !== ''
    ? expectedVersion.trim()
    : packageVersion

  check(packageVersion !== '', 'package.version is missing')
  check(targetVersion !== '', 'expected version is missing')
  check(packageVersion === targetVersion, `package.version=${packageVersion}; expected=${targetVersion}`)
  check(lock?.version === packageVersion, `package-lock.version=${lock?.version}; package.version=${packageVersion}`)
  check(lock?.packages?.['']?.version === packageVersion, `package-lock root version=${lock?.packages?.['']?.version}; package.version=${packageVersion}`)
  check(lock?.packages?.['']?.name === pkg?.name, `package-lock root name=${lock?.packages?.['']?.name}; package.name=${pkg?.name}`)
  check(pkg?.name === 'deepwriter', `package.name=${pkg?.name}`)

  const build = pkg?.build ?? {}
  check(build.appId === 'com.deepwriter.app', `build.appId=${build.appId}`)
  check(build.productName === 'DeepWriter', `build.productName=${build.productName}`)
  check(build.asar === true, 'build.asar must be true')
  check(build.directories?.output === 'dist', `build.directories.output=${build.directories?.output}`)

  const iconPath = path.join(projectRoot, 'build', 'icon.ico')
  let iconStat
  try {
    iconStat = fs.lstatSync(iconPath)
  } catch (error) {
    errors.push(`build/icon.ico is not a readable regular file: ${error.message}`)
  }
  check(iconStat?.isFile() === true, `build/icon.ico must be a regular file: ${iconPath}`)

  for (const section of ['dependencies', 'devDependencies']) {
    const packageRanges = pkg?.[section]
    const lockRanges = lock?.packages?.['']?.[section]
    const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    const packageObject = isRecord(packageRanges) ? packageRanges : {}
    const lockObject = isRecord(lockRanges) ? lockRanges : {}
    if (packageRanges !== undefined && !isRecord(packageRanges)) {
      errors.push(`package.${section} must be an object`)
    }
    if (lockRanges !== undefined && !isRecord(lockRanges)) {
      errors.push(`package-lock root ${section} must be an object`)
    }
    const packageKeys = Object.keys(packageObject).sort()
    const lockKeys = Object.keys(lockObject).sort()
    const missing = packageKeys.filter((name) => !Object.prototype.hasOwnProperty.call(lockObject, name))
    const extra = lockKeys.filter((name) => !Object.prototype.hasOwnProperty.call(packageObject, name))
    check(missing.length === 0, `${section} missing from package-lock root: ${missing.join(', ')}`)
    check(extra.length === 0, `${section} extra in package-lock root: ${extra.join(', ')}`)
    for (const name of packageKeys) {
      check(typeof packageObject[name] === 'string', `package.${section}.${name} must be a range string`)
      check(typeof lockObject[name] === 'string', `package-lock root ${section}.${name} must be a range string`)
      check(lockObject[name] === packageObject[name], `${section} range drift for ${name}: package=${packageObject[name]}; lock=${lockObject[name]}`)
    }
  }

  const files = Array.isArray(build.files) ? build.files.map(String) : []
  for (const required of REQUIRED_BUILD_FILES) {
    check(files.includes(required), `build.files missing ${required}`)
  }
  const duplicateFiles = files.filter((file, index) => files.indexOf(file) !== index)
  const unexpectedFiles = files.filter((file) => !REQUIRED_BUILD_FILES.includes(file))
  check(duplicateFiles.length === 0, `build.files contains duplicates: ${[...new Set(duplicateFiles)].join(', ')}`)
  check(unexpectedFiles.length === 0, `build.files contains unexpected entries: ${unexpectedFiles.join(', ')}`)

  const targets = Array.isArray(build.win?.target) ? build.win.target : []
  const targetNames = targets.map((entry) => typeof entry === 'string' ? entry : entry?.target).filter(Boolean)
  check(targetNames.includes('nsis'), `win.target missing nsis: ${JSON.stringify(targets)}`)
  check(targetNames.includes('portable'), `win.target missing portable: ${JSON.stringify(targets)}`)
  check(build.nsis?.oneClick === false, 'nsis.oneClick must be false')
  check(build.nsis?.allowToChangeInstallationDirectory === true, 'nsis.allowToChangeInstallationDirectory must be true')
  check(build.nsis?.deleteAppDataOnUninstall === false, 'nsis.deleteAppDataOnUninstall must be false')
  check(build.nsis?.artifactName === 'DeepWriter-${version}-${arch}-setup.${ext}', `nsis.artifactName=${build.nsis?.artifactName}`)
  check(build.portable?.artifactName === 'DeepWriter-${version}-${arch}-portable.${ext}', `portable.artifactName=${build.portable?.artifactName}`)

  let resolvedArtifactDir
  let artifactFiles = []
  if (artifactDir !== undefined) {
    resolvedArtifactDir = resolveFromRoot(projectRoot, artifactDir)
    let stat
    try {
      stat = fs.statSync(resolvedArtifactDir)
    } catch (error) {
      errors.push(`artifact directory unreadable: ${resolvedArtifactDir} (${error.message})`)
    }
    check(stat?.isDirectory() === true, `artifact directory is not a directory: ${resolvedArtifactDir}`)
    if (stat?.isDirectory()) {
      try {
        artifactFiles = collectArtifactFiles(resolvedArtifactDir)
      } catch (error) {
        errors.push(`artifact directory scan failed: ${error.message}`)
      }
    }
  }

  let resolvedOutputDoc
  let resolvedOutputRoot
  if (outputDoc !== undefined) {
    try {
      const resolved = resolveOutputPath(projectRoot, outputDoc, allowOutputRoot)
      resolvedOutputDoc = resolved.outputPath
      resolvedOutputRoot = resolved.outputRoot
      if (fs.existsSync(resolvedOutputDoc)) errors.push(`output doc already exists; refusing to overwrite: ${resolvedOutputDoc}`)
    } catch (error) {
      errors.push(`output doc path rejected: ${error.message}`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    root: projectRoot,
    pkg,
    lock,
    version: targetVersion,
    files,
    targetNames,
    artifactDir: resolvedArtifactDir,
    artifactFiles,
    outputDoc: resolvedOutputDoc,
    outputRoot: resolvedOutputRoot
  }
}

function writeOutputDoc(result) {
  if (!result.outputDoc) return false
  const resolved = resolveOutputPath(result.root, result.outputDoc, result.outputRoot)
  if (fs.existsSync(resolved.outputPath)) throw new Error(`output doc already exists; refusing to overwrite: ${resolved.outputPath}`)
  const parent = path.dirname(result.outputDoc)
  fs.mkdirSync(parent, { recursive: true })
  const report = renderArtifactReport({
    root: result.root,
    artifactDir: result.artifactDir ?? result.root,
    packageName: result.pkg.name,
    version: result.version,
    files: result.artifactFiles
  })
  fs.writeFileSync(result.outputDoc, report, 'utf8')
  return true
}

function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`FAIL ${error.message}`)
    return 2
  }

  const result = validateReleaseMetadata(options)
  console.log(`DeepWriter release metadata: ${result.pkg?.name ?? 'unknown'} ${result.pkg?.version ?? 'unknown'}`)
  console.log(`targets: ${result.targetNames.join(', ') || 'none'}; asar=${result.pkg?.build?.asar === true}; output=${result.pkg?.build?.directories?.output ?? 'unset'}`)
  if (result.artifactDir) console.log(`artifact dir: ${path.relative(result.root, result.artifactDir) || '.'}; files=${result.artifactFiles.length}`)
  console.log('signing: use release.json and signature-verification.json from the verified release workflow')
  if (!result.ok) {
    for (const error of result.errors) console.error(`FAIL ${error}`)
    return 1
  }
  if (result.outputDoc) {
    try {
      writeOutputDoc(result)
      console.log(`output doc: ${path.relative(result.root, result.outputDoc) || result.outputDoc}`)
    } catch (error) {
      console.error(`FAIL output doc write failed: ${error.message}`)
      return 1
    }
  }
  console.log('PASS release metadata')
  return 0
}

if (require.main === module) process.exitCode = main()

module.exports = {
  REQUIRED_BUILD_FILES,
  collectArtifactFiles,
  main,
  parseArgs,
  renderArtifactReport,
  validateReleaseMetadata,
  writeOutputDoc
}
