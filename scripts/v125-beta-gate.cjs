'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const DOCS_DIR = path.join(ROOT, 'docs')
const RUNS_DIR = path.join(DOCS_DIR, 'v125-beta-gate-runs')
const LATEST_FILE = path.join(DOCS_DIR, 'v125-beta-gate-latest.json')
const PACKAGE_FILE = path.join(ROOT, 'package.json')
const ESBUILD_CLI = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild')
const NODE_BIN = process.execPath
const GATE_VERSION = 'v1.2.5-beta'
const SCHEMA_VERSION = 1

function readPackage() {
  return JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'))
}

function relativeDisplay(filePath) {
  const relative = path.relative(ROOT, filePath)
  return relative ? relative.split(path.sep).join('/') : '.'
}

function isWithin(parentPath, targetPath) {
  const parent = path.resolve(parentPath)
  const target = path.resolve(targetPath)
  const relative = path.relative(parent, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertNoSymlinkComponents(targetPath, stopPath) {
  const target = path.resolve(targetPath)
  const stop = path.resolve(stopPath)
  if (!isWithin(stop, target)) throw new Error(`path escapes containment root: ${target}`)
  let cursor = target
  while (true) {
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false })
    if (stat && stat.isSymbolicLink()) {
      throw new Error(`symlink path component is not allowed: ${cursor}`)
    }
    if (cursor === stop) return
    const parent = path.dirname(cursor)
    if (parent === cursor) throw new Error(`containment root was not reached: ${stop}`)
    cursor = parent
  }
}

function assertContainedFile(filePath, allowedParent, containmentRoot = ROOT, directChild = false) {
  const target = path.resolve(filePath)
  const parent = path.resolve(allowedParent)
  const root = path.resolve(containmentRoot)
  if (!isWithin(root, parent) || !isWithin(parent, target)) {
    throw new Error(`output path escapes containment: ${target}`)
  }
  if (directChild && path.dirname(target) !== parent) {
    throw new Error(`output path must be a direct child of ${parent}: ${target}`)
  }
  assertNoSymlinkComponents(target, root)
  return target
}

function assertEvidenceRoots() {
  if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) throw new Error(`workspace root is not a directory: ${ROOT}`)
  if (!fs.existsSync(DOCS_DIR) || !fs.statSync(DOCS_DIR).isDirectory()) throw new Error(`docs root is not a directory: ${DOCS_DIR}`)
  assertNoSymlinkComponents(DOCS_DIR, ROOT)
  const rootReal = fs.realpathSync.native(ROOT)
  const docsReal = fs.realpathSync.native(DOCS_DIR)
  if (!isWithin(rootReal, docsReal)) throw new Error(`docs realpath escapes workspace: ${docsReal}`)
  if (fs.existsSync(RUNS_DIR)) {
    if (!fs.statSync(RUNS_DIR).isDirectory()) throw new Error(`gate runs root is not a directory: ${RUNS_DIR}`)
    assertNoSymlinkComponents(RUNS_DIR, ROOT)
    const runsReal = fs.realpathSync.native(RUNS_DIR)
    if (!isWithin(docsReal, runsReal)) throw new Error(`gate runs realpath escapes docs: ${runsReal}`)
  } else {
    assertNoSymlinkComponents(RUNS_DIR, ROOT)
    fs.mkdirSync(RUNS_DIR)
  }
}

function makeRunId() {
  return `run-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${crypto.randomBytes(8).toString('hex')}`
}

function createRunDirectory() {
  assertEvidenceRoots()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const runId = makeRunId()
    const runDir = path.join(RUNS_DIR, runId)
    assertContainedFile(runDir, RUNS_DIR, ROOT, true)
    try {
      fs.mkdirSync(runDir)
      assertNoSymlinkComponents(runDir, ROOT)
      const runsReal = fs.realpathSync.native(RUNS_DIR)
      const runReal = fs.realpathSync.native(runDir)
      if (!isWithin(runsReal, runReal) || path.dirname(runReal) !== runsReal) {
        throw new Error(`run directory realpath escaped runs root: ${runReal}`)
      }
      return { runId, runDir }
    } catch (error) {
      if (error && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('could not allocate a unique v125 beta gate run directory')
}

function writeRunManifestExclusive(manifestPath, value, runDir, containmentRoot = ROOT) {
  const target = assertContainedFile(manifestPath, runDir, containmentRoot, true)
  const text = `${JSON.stringify(value, null, 2)}\n`
  const fd = fs.openSync(target, 'wx')
  try {
    fs.writeFileSync(fd, text, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  return target
}

function writeLatestAtomic(latestPath, value, docsRoot = DOCS_DIR, containmentRoot = ROOT) {
  const target = assertContainedFile(latestPath, docsRoot, containmentRoot, true)
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`latest output cannot follow a symlink: ${target}`)
  }
  const tempName = `.v125-beta-gate-latest-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`
  const tempPath = assertContainedFile(path.join(docsRoot, tempName), docsRoot, containmentRoot, true)
  const text = `${JSON.stringify(value, null, 2)}\n`
  let tempCreated = false
  try {
    const fd = fs.openSync(tempPath, 'wx')
    tempCreated = true
    try {
      fs.writeFileSync(fd, text, 'utf8')
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.renameSync(tempPath, target)
      tempCreated = false
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error && error.code)) throw error
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
        throw new Error(`latest output cannot follow a symlink: ${target}`)
      }
      if (fs.existsSync(target)) fs.unlinkSync(target)
      fs.renameSync(tempPath, target)
      tempCreated = false
    }
  } finally {
    if (tempCreated && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
  return target
}

function quoteArg(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:=+@%-]+$/.test(text)) return text
  return `"${text.replace(/(["\\])/g, '\\$1')}"`
}

function displayPart(part) {
  return [part.display || relativeDisplay(part.file), ...part.args].map(quoteArg).join(' ')
}

function displayCommand(parts) {
  return parts.map(displayPart).join(' && ')
}

function existingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function validateCliPath(candidatePath, { label, fileName, packageName, expectedRoot = null }) {
  const candidate = path.resolve(candidatePath)
  if (!existingFile(candidate)) return { realPath: null, reason: `${label} is not an existing file: ${candidate}` }

  let realPath
  try {
    realPath = fs.realpathSync.native(candidate)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { realPath: null, reason: `${label} realpath failed for ${candidate}: ${detail}` }
  }
  if (!existingFile(realPath)) return { realPath: null, reason: `${label} realpath is not a file: ${realPath}` }

  try {
    assertNoSymlinkComponents(candidate, path.parse(candidate).root)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { realPath: null, reason: `${label} symlink check failed: ${detail}` }
  }

  const realFileName = path.basename(realPath).toLowerCase()
  const realBinName = path.basename(path.dirname(realPath)).toLowerCase()
  const realPackageName = path.basename(path.dirname(path.dirname(realPath))).toLowerCase()
  if (realFileName !== fileName.toLowerCase() || realBinName !== 'bin' || realPackageName !== packageName.toLowerCase()) {
    return {
      realPath: null,
      reason: `${label} must resolve to ${packageName}/bin/${fileName}: ${realPath}`
    }
  }

  if (expectedRoot) {
    let rootRealPath
    try {
      rootRealPath = fs.realpathSync.native(path.resolve(expectedRoot))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { realPath: null, reason: `${label} expected root realpath failed: ${detail}` }
    }
    if (!isWithin(rootRealPath, realPath)) {
      return { realPath: null, reason: `${label} realpath escapes expected root: ${realPath}` }
    }
  }

  return { realPath, reason: null }
}

function resolveNpmCliPath() {
  const configured = process.env.npm_execpath
  const configuredPath = configured ? path.resolve(configured) : null
  const configuredCheck = configuredPath
    ? validateCliPath(configuredPath, { label: 'npm_execpath', fileName: 'npm-cli.js', packageName: 'npm' })
    : { realPath: null, reason: 'npm_execpath is not set' }
  if (configuredCheck.realPath) return configuredCheck.realPath

  const fallbackPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const fallbackCheck = validateCliPath(fallbackPath, {
    label: 'fallback npm CLI',
    fileName: 'npm-cli.js',
    packageName: 'npm',
    expectedRoot: path.join(path.dirname(process.execPath), 'node_modules', 'npm')
  })
  if (fallbackCheck.realPath) return fallbackCheck.realPath

  throw new Error(`npm runner unavailable: ${configuredCheck.reason}; ${fallbackCheck.reason}`)
}

function npmPart(script, forwardedArgs = []) {
  const args = ['run', script]
  if (forwardedArgs.length > 0) args.push('--', ...forwardedArgs)
  return { file: NODE_BIN, args: [resolveNpmCliPath(), ...args], display: 'npm', runner: 'npm' }
}

function npmVersionPart() {
  return { file: NODE_BIN, args: [resolveNpmCliPath(), '--version'], display: 'npm', runner: 'npm' }
}

function resolveEsbuildCliPath() {
  const check = validateCliPath(ESBUILD_CLI, {
    label: 'esbuild CLI',
    fileName: 'esbuild',
    packageName: 'esbuild',
    expectedRoot: path.join(ROOT, 'node_modules', 'esbuild')
  })
  if (check.realPath) return check.realPath
  throw new Error(`esbuild runner unavailable: ${check.reason}`)
}

function esbuildPart(entry, outfile, extras = []) {
  return {
    file: NODE_BIN,
    args: [
      resolveEsbuildCliPath(),
      entry,
      '--bundle',
      '--format=esm',
      '--platform=node',
      '--target=node20',
      `--outfile=${outfile}`,
      ...extras
    ],
    display: 'esbuild',
    runner: 'esbuild'
  }
}

function esbuildVersionPart() {
  return { file: NODE_BIN, args: [resolveEsbuildCliPath(), '--version'], display: 'esbuild', runner: 'esbuild' }
}

function nodePart(file) {
  return { file: NODE_BIN, args: [file], display: 'node' }
}

function commandStep({ id, label, parts, command, blockedReason = null }) {
  return {
    id,
    label,
    parts,
    command: command || displayCommand(parts),
    blockedReason
  }
}

function npmStep(pkg, id, label, script, forwardedArgs = []) {
  const exists = Boolean(pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, script))
  const parts = [npmPart(script, forwardedArgs)]
  return commandStep({
    id,
    label,
    parts,
    command: `npm run ${script}${forwardedArgs.length ? ` -- ${forwardedArgs.map(quoteArg).join(' ')}` : ''}`,
    blockedReason: exists ? null : `npm script missing: ${script}`
  })
}

function directTypeScriptStep({ id, label, entry, outfile, extras = ['--external:node:sqlite'] }) {
  const parts = [
    esbuildPart(entry, outfile, extras),
    nodePart(outfile)
  ]
  const extrasText = extras.map((extra) => ` ${extra}`).join('')
  return commandStep({
    id,
    label,
    parts,
    command: `esbuild ${entry} --bundle --format=esm --platform=node --target=node20 --outfile=${relativeDisplay(outfile)}${extrasText} && node ${relativeDisplay(outfile)}`
  })
}

function directJavaScriptStep({ id, label, entry }) {
  const parts = [nodePart(entry)]
  return commandStep({
    id,
    label,
    parts,
    command: `node ${relativeDisplay(entry)}`
  })
}

function buildPlan(pkg, runDir, compileDir = path.join(os.tmpdir(), 'deepwriter-v125-beta-gate-preview')) {
  const steps = [
    npmStep(pkg, 'typecheck', 'typecheck', 'typecheck'),
    npmStep(pkg, 'build', 'build', 'build'),
    npmStep(pkg, 'verify', 'verify', 'verify'),
    npmStep(pkg, 'authority-ui-contracts', 'authority UI contracts', 'ui:contracts'),
    npmStep(pkg, 'authority-gate0', 'authority gate0 regressions', 'gate0'),
    npmStep(pkg, 'authority-gate1', 'authority gate1 security', 'gate1'),
    npmStep(pkg, 'authority-gate2', 'authority gate2 database', 'gate2'),
    npmStep(pkg, 'authority-gate4', 'authority gate4 galgame', 'gate4'),
    npmStep(pkg, 'authority-gate5', 'authority gate5 benchmark', 'gate5'),
    npmStep(pkg, 'authority-r46-g2', 'authority r46 g2', 'r46:g2'),
    npmStep(pkg, 'authority-r46-g3', 'authority r46 g3', 'r46:g3'),
    npmStep(pkg, 'authority-r46-g4', 'authority r46 g4', 'r46:g4'),
    npmStep(pkg, 'authority-r39-constraints', 'authority r39 strong constraints', 'r39:constraints'),
    npmStep(pkg, 'authority-r42-quality', 'authority r42 writing quality', 'r42:quality'),
    npmStep(pkg, 'authority-r42-pipeline', 'authority r42 writing pipeline', 'r42:pipeline'),
    npmStep(pkg, 'authority-p2-completion-combo', 'authority p2 completion combo', 'p2-completion-combo'),
    npmStep(pkg, 'authority-e2e', 'authority e2e', 'e2e'),
    npmStep(pkg, 'authority-e2e-r43', 'authority e2e r43', 'e2e:r43'),
    npmStep(pkg, 'authority-e2e-r45', 'authority e2e r45', 'e2e:r45'),
    npmStep(pkg, 'authority-e2e-r46-g5', 'authority e2e r46 g5', 'e2e:r46:g5')
  ]

  for (let phase = 0; phase <= 3; phase += 1) {
    const entry = `scripts/wp7-runtime-phase${phase}.ts`
    const outfile = path.join(compileDir, `wp7-runtime-phase${phase}.mjs`)
    steps.push(directTypeScriptStep({
      id: `wp7-phase${phase}`,
      label: `WP7 runtime phase${phase}`,
      entry,
      outfile,
      extras: ['--external:node:sqlite']
    }))
  }

  steps.push(directTypeScriptStep({
    id: 'wp7-settings-ui',
    label: 'WP7 settings contracts/schema (no e2e)',
    entry: 'scripts/wp7-settings-ui.ts',
    outfile: path.join(compileDir, 'wp7-settings-ui.mjs'),
    extras: ['--external:@playwright/test', '--external:node:sqlite']
  }))

  steps.push(
    npmStep(pkg, 'r65-actuality', 'r65 actuality contract', 'r65:actuality-contract'),
    npmStep(pkg, 'r65-recovery', 'r65 review recovery', 'r65:review-recovery'),
    npmStep(pkg, 'r68-electron-recovery', 'r68 Electron recovery', 'r68:review-recovery-electron'),
    npmStep(pkg, 'p1-3-epoch', 'p1-3 story-ledger epoch', 'p1-3:story-ledger-epoch'),
    npmStep(pkg, 'p2-integrity', 'p2 story-ledger integrity', 'p2:story-ledger-integrity'),
    npmStep(pkg, 'r69', 'r69 scene-memory card', 'r69:scene-memory-card'),
    npmStep(pkg, 'r70', 'r70 scene-memory persistence', 'r70:scene-memory-persistence'),
    npmStep(pkg, 'r71', 'r71 recall index', 'r71:recall-index'),
    npmStep(pkg, 'r72', 'r72 scene working set', 'r72:scene-working-set'),
    npmStep(pkg, 'r73', 'r73 atomic scene commit', 'r73:scene-commit:adversarial'),
    npmStep(pkg, 'r74', 'r74 longform workflow recovery', 'r74:longform-workflow-recovery'),
    npmStep(pkg, 'wp6-authority', 'wp6 workflow authority', 'wp6:workflow-authority'),
    npmStep(pkg, 'wp6-pause', 'wp6 pause', 'wp6:pause'),
    npmStep(pkg, 'wp8-t0', 'wp8 t0 stress', 'wp8:t0'),
    directTypeScriptStep({
      id: 'v125-upgrade-gate',
      label: 'v1.2.5 upgrade gate',
      entry: 'scripts/v125-upgrade-gate.ts',
      outfile: path.join(compileDir, 'v125-upgrade-gate.mjs'),
      extras: ['--external:node:sqlite']
    }),
    directJavaScriptStep({
      id: 'release-scripts-selftest',
      label: 'release scripts selftest',
      entry: 'scripts/release-scripts-selftest.cjs'
    }),
    npmStep(pkg, 'release-asar-selftest', 'release asar selftest', 'release:asar', ['--selftest'])
  )

  return steps
}

function gitMeta() {
  let head = 'unknown'
  let status = ''
  try {
    head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'unknown'
  } catch {}
  try {
    status = spawnSync('git', ['status', '--porcelain=v1'], { cwd: ROOT, encoding: 'utf8' }).stdout || ''
  } catch {}
  const dirtyFiles = status.split(/\r?\n/).filter(Boolean).map((line) => line.length > 3 ? line.slice(3).trim() : line.trim())
  return { head, dirtyFiles }
}

function parsePassNumbers(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const passLines = lines.filter((line) => /^PASS(?:\b|\s)/i.test(line))
  const failLines = lines.filter((line) => /^FAIL(?:\b|\s)/i.test(line))
  const summaryLines = lines.filter((line) => /\bPASS\b|\bFAIL\b/i.test(line)).slice(-12)
  let pass = null
  let fail = null
  let total = null
  const summary = output.match(/(\d+)\s+PASS\s*\/\s*(\d+)\s+FAIL/i)
    || output.match(/(\d+)\s+PASS\s*,\s*(\d+)\s+FAIL/i)
    || output.match(/RESULT:\s*PASS\s*[\(（]\s*(\d+)\s*\/\s*(\d+)\s*[\)）]/i)
  if (summary) {
    pass = Number(summary[1])
    if (/RESULT:/i.test(summary[0])) {
      total = Number(summary[2])
      fail = total - pass
    } else {
      fail = Number(summary[2])
      total = pass + fail
    }
  } else {
    const passed = output.match(/(?:passed|pass(?:ed)?)[\s:=]+(\d+)/i)
    if (passed) pass = Number(passed[1])
    else if (passLines.length > 0) pass = passLines.length
    const failed = output.match(/(?:failed|fail(?:ed)?)[\s:=]+(\d+)/i)
    if (failed) fail = Number(failed[1])
    else if (failLines.length > 0) fail = failLines.length
    if (pass !== null && fail !== null) total = pass + fail
  }
  return {
    pass,
    fail,
    total,
    passNumbers: { pass, fail, total },
    passLines: passLines.slice(-20),
    failLines: failLines.slice(-20),
    summaryLines
  }
}

function runPart(part) {
  const env = { ...process.env }
  if (part.runner === 'npm') env.npm_execpath = part.args[0]
  const started = Date.now()
  let result
  try {
    result = spawnSync(part.file, part.args, {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    })
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error)
    return {
      exit: 1,
      status: null,
      durationMs: Date.now() - started,
      output: `spawnSync threw before starting the child process:\n${detail}\n`,
      spawnError: detail
    }
  }
  const outputParts = [result.stdout || '', result.stderr || '']
  const spawnError = result.error
    ? result.error.stack || result.error.message || String(result.error)
    : null
  if (spawnError) outputParts.push(`spawnSync child-process error:\n${spawnError}\n`)
  if (result.status === null) {
    outputParts.push(`spawnSync returned status=null${result.signal ? ` (signal=${result.signal})` : ''}.\n`)
  }
  return {
    exit: typeof result.status === 'number' ? result.status : 1,
    status: result.status,
    signal: result.signal || null,
    durationMs: Date.now() - started,
    output: outputParts.join(''),
    spawnError
  }
}

function runStep(step) {
  const started = Date.now()
  const chunks = []
  let exit = 0
  let signal = null
  if (step.blockedReason) {
    return {
      status: 'blocked',
      exit: null,
      exitCode: null,
      signal: null,
      durationMs: 0,
      output: '',
      passNumbers: { pass: null, fail: null, total: null },
      reason: step.blockedReason
    }
  }
  for (const part of step.parts) {
    const result = runPart(part)
    chunks.push(result.output)
    exit = result.exit
    signal = result.signal || null
    if (exit !== 0) break
  }
  const output = chunks.join('')
  return {
    status: exit === 0 ? 'pass' : 'fail',
    exit,
    exitCode: exit,
    signal,
    durationMs: Date.now() - started,
    output,
    passNumbers: parsePassNumbers(output),
    reason: exit === 0 ? null : `command exited with ${signal ? `signal ${signal}` : `code ${exit}`}`
  }
}

function evidenceEntry({ runId, startedAt, finishedAt, durationMs, status, stopReason, steps, head, dirtyFiles }) {
  const notRun = [
    ['real-provider', 'not_run', '真实 provider 请求未执行；本地门禁仅使用 mock/synthetic/fixture。'],
    ['blind-review', 'not_run', '盲评未执行。'],
    ['two-hour-soak', 'not_run', '2h soak 未执行。'],
    ['clean-install', 'not_run', 'clean install 未执行。'],
    ['nvda', 'not_run', 'NVDA 无障碍验证未执行。'],
    ['signing', 'not_run', '签名验证未执行。'],
    ['experimental-wp7-phase4', 'excluded_from_1.2.5_beta', 'Phase4A/Phase4B 未达到身份验证与接线要求，源码/test 已干净回退；Beta 仅包含默认关闭的 WP7 Phase0–3，不声明 reorientation 已实现。']
  ].map(([id, status, reason]) => ({ id, status, reason, countsTowardLocalPass: false }))
  const counts = {
    executed: steps.filter((step) => step.status === 'pass' || step.status === 'fail').length,
    passed: steps.filter((step) => step.status === 'pass').length,
    failed: steps.filter((step) => step.status === 'fail').length,
    blocked: steps.filter((step) => step.status === 'blocked').length,
    stepNotRun: steps.filter((step) => step.status === 'not_run').length,
    notRun: notRun.length,
    notRunEvidence: notRun
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    gate: GATE_VERSION,
    runId,
    status,
    exitCode: status === 'pass' ? 0 : status === 'blocked' ? 2 : 1,
    stopReason: stopReason || null,
    startedAt,
    finishedAt,
    durationMs,
    head,
    dirtyFiles,
    realRequests: 0,
    realProviderRequests: 0,
    realRequestDeclaration: '本门禁真实 provider 请求数为 0；本地 PASS 不代表真实 provider、盲评、soak、安装、NVDA 或 signing 通过。',
    legacyArtifactPolicy: {
      expectedVersion: '1.2.5',
      oldVersionedArtifactsScanned: false,
      note: 'release asar selftest 只运行规则自检 fixture，不扫描或采信 dist-1.2.4 等旧制品。'
    },
    localPass: status === 'pass' && steps.length > 0 && counts.failed === 0 && counts.blocked === 0 && counts.passed === steps.length,
    localPassDefinition: 'localPass 只表示本地门禁步骤全部通过；notRunEvidence（含排除的 experimental-wp7-phase4）明确不纳入 localPass，也不等同于真实发布通过。',
    wp7BetaScope: {
      includedPhases: ['phase0', 'phase1', 'phase2', 'phase3'],
      defaultFlags: 'off',
      excludedPhase4: 'Phase4A/Phase4B excluded_from_1.2.5_beta; no identity/wiring evidence and no reorientation implementation claim.'
    },
    counts,
    notRunEvidence: notRun,
    steps,
    runDirectory: relativeDisplay(path.join(RUNS_DIR, runId)),
    latestFile: relativeDisplay(LATEST_FILE)
  }
}

function printOutput(step, output) {
  if (!output) return
  process.stdout.write(`\n[${step.id}] output\n${output}`)
  if (!output.endsWith('\n')) process.stdout.write('\n')
}

function printPlan(plan, dryRun) {
  process.stdout.write(`${dryRun ? '[dry-run] ' : ''}${GATE_VERSION} gate plan (${plan.length} steps)\n`)
  plan.forEach((step, index) => {
    const suffix = step.blockedReason ? ` [blocked: ${step.blockedReason}]` : ''
    process.stdout.write(`${String(index + 1).padStart(2, '0')}. ${step.label}\n    ${step.command}${suffix}\n`)
  })
}

function usage() {
  process.stdout.write([
    'Usage: node scripts/v125-beta-gate.cjs [--list|--dry-run|--selftest]',
    '',
    '--list     print the ordered gate plan and do not execute commands',
    '--dry-run  print the ordered plan, including blocked checks, and do not write evidence',
    '--selftest  run parser, containment, symlink, exclusive-write, and no-write CLI checks',
    '',
    'Without a flag, execute in order and stop at the first fail or blocked item.'
  ].join('\n') + '\n')
}

function ownOutputSnapshot() {
  const describe = (filePath) => {
    if (!fs.existsSync(filePath) && !fs.lstatSync(filePath, { throwIfNoEntry: false })) return null
    const stat = fs.lstatSync(filePath)
    return {
      path: filePath,
      type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
      size: stat.isFile() ? stat.size : null,
      mtimeMs: stat.mtimeMs
    }
  }
  const runs = fs.existsSync(RUNS_DIR)
    ? fs.readdirSync(RUNS_DIR).sort().map((entry) => describe(path.join(RUNS_DIR, entry)))
    : null
  return JSON.stringify({ latest: describe(LATEST_FILE), runs })
}

function expectThrow(fn, pattern) {
  try {
    fn()
  } catch (error) {
    return !pattern || pattern.test(String(error && error.message ? error.message : error))
  }
  return false
}

function runSelftest() {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail })
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`)
  }

  check('full-width check-asar RESULT parser', (() => {
    const parsed = parsePassNumbers('RESULT: PASS（23/23）')
    return parsed.pass === 23 && parsed.fail === 0 && parsed.total === 23
  })())
  const countProbe = evidenceEntry({
    runId: 'selftest',
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    durationMs: 0,
    status: 'pass',
    stopReason: null,
    steps: [{ status: 'pass' }],
    head: 'selftest',
    dirtyFiles: []
  })
  check('counts.notRun contains seven excluded/not-run evidence items', countProbe.counts.notRun === 7 && countProbe.notRunEvidence.length === 7 && countProbe.counts.notRunEvidence.length === 7 && countProbe.notRunEvidence.some((item) => item.id === 'experimental-wp7-phase4' && item.status === 'excluded_from_1.2.5_beta') && countProbe.localPass && countProbe.localPassDefinition.includes('不纳入 localPass'))

  let npmSmoke
  try {
    npmSmoke = runPart(npmVersionPart())
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error)
    npmSmoke = { exit: 1, status: null, output: `${detail}\n`, spawnError: detail }
  }
  const npmSmokeOutput = (npmSmoke.output || '').trim()
  check('npm runner smoke starts via process.execPath, exits 0, and emits a version', npmSmoke.status === 0 && npmSmoke.exit === 0 && npmSmokeOutput.length > 0, npmSmoke.spawnError || npmSmokeOutput.split(/\r?\n/)[0])

  let esbuildSmoke
  try {
    esbuildSmoke = runPart(esbuildVersionPart())
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error)
    esbuildSmoke = { exit: 1, status: null, output: `${detail}\n`, spawnError: detail }
  }
  const esbuildSmokeOutput = (esbuildSmoke.output || '').trim()
  check('esbuild runner smoke starts via process.execPath, exits 0, and emits a version', esbuildSmoke.status === 0 && esbuildSmoke.exit === 0 && esbuildSmokeOutput.length > 0, esbuildSmoke.spawnError || esbuildSmokeOutput.split(/\r?\n/)[0])

  const before = ownOutputSnapshot()
  const listResult = spawnSync(NODE_BIN, [__filename, '--list'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  const dryResult = spawnSync(NODE_BIN, [__filename, '--dry-run'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  const after = ownOutputSnapshot()
  check('list exits 0 and does not write gate evidence', listResult.status === 0 && before === after)
  check('dry-run exits 0 and does not write gate evidence', dryResult.status === 0 && before === after)
  const previewPlan = buildPlan(readPackage(), path.join(RUNS_DIR, 'selftest-preview'))
  const previewText = `${listResult.stdout || ''}\n${dryResult.stdout || ''}`
  const uiContractSteps = previewPlan.filter((step) => step.command === 'npm run ui:contracts')
  const settingsSteps = previewPlan.filter((step) => step.id === 'wp7-settings-ui')
  const writingAuthorityCommands = ['npm run r39:constraints', 'npm run r42:quality', 'npm run r42:pipeline', 'npm run p2-completion-combo']
  check('Beta plan has 42 steps with writing authorities, ui:contracts once, WP7 settings contracts once, no e2e, and no phase4 command or blocker', previewPlan.length === 42 && writingAuthorityCommands.every((command) => previewPlan.filter((step) => step.command === command).length === 1) && uiContractSteps.length === 1 && !uiContractSteps[0].blockedReason && settingsSteps.length === 1 && !settingsSteps[0].blockedReason && !/--e2e/i.test(settingsSteps[0].command) && /--external:@playwright\/test/.test(settingsSteps[0].command) && /--external:node:sqlite/.test(settingsSteps[0].command) && previewPlan.every((step) => !/phase4/i.test(`${step.id} ${step.label} ${step.command}`) && !step.blockedReason) && !/phase4|BLOCKED/i.test(previewText))

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-v125-beta-gate-selftest-'))
  try {
    const tempDocs = path.join(tempRoot, 'docs')
    const tempRuns = path.join(tempDocs, 'v125-beta-gate-runs')
    fs.mkdirSync(tempRuns, { recursive: true })
    const tempRun = path.join(tempRuns, 'run-selftest')
    fs.mkdirSync(tempRun)
    const manifest = path.join(tempRun, 'manifest.json')
    const outside = path.join(tempRoot, 'outside.json')
    fs.writeFileSync(outside, 'sentinel', 'utf8')
    check('containment rejects path escape', expectThrow(() => assertContainedFile(outside, tempRuns, tempRoot), /escapes containment/))
    check('run manifest exclusive create succeeds once', (() => {
      writeRunManifestExclusive(manifest, { ok: true }, tempRun, tempRoot)
      return fs.readFileSync(manifest, 'utf8').includes('"ok": true')
    })())
    check('run manifest overwrite is rejected', expectThrow(() => writeRunManifestExclusive(manifest, { ok: false }, tempRun, tempRoot), /EEXIST|already exists/))

    const latest = path.join(tempDocs, 'v125-beta-gate-latest.json')
    writeLatestAtomic(latest, { revision: 1 }, tempDocs, tempRoot)
    writeLatestAtomic(latest, { revision: 2 }, tempDocs, tempRoot)
    check('latest own-path atomic replacement updates only latest', JSON.parse(fs.readFileSync(latest, 'utf8')).revision === 2 && fs.readFileSync(outside, 'utf8') === 'sentinel')

    const symlinkTarget = path.join(tempRoot, 'symlink-target.json')
    fs.writeFileSync(symlinkTarget, 'outside-sentinel', 'utf8')
    const symlinkManifest = path.join(tempRun, 'symlink-manifest.json')
    let symlinkSupported = true
    try {
      fs.symlinkSync(symlinkTarget, symlinkManifest, 'file')
    } catch (error) {
      symlinkSupported = false
      const outsideDir = path.join(tempRoot, 'symlink-target-dir')
      const linkedDocs = path.join(tempRoot, 'linked-docs')
      fs.mkdirSync(outsideDir)
      try {
        fs.symlinkSync(outsideDir, linkedDocs, 'junction')
        check('directory symlink setup is available for security selftest', true)
        check('symlink parent containment is rejected', expectThrow(() => assertContainedFile(path.join(linkedDocs, 'manifest.json'), linkedDocs, tempRoot, true), /symlink/))
        check('latest under symlink parent is rejected', expectThrow(() => writeLatestAtomic(path.join(linkedDocs, 'latest.json'), { bad: true }, linkedDocs, tempRoot), /symlink/))
      } catch (junctionError) {
        check('symlink setup is available for security selftest', false, `${error.message}; junction: ${junctionError.message}`)
      }
    }
    if (symlinkSupported) {
      check('manifest symlink overwrite is rejected', expectThrow(() => writeRunManifestExclusive(symlinkManifest, { bad: true }, tempRun, tempRoot), /symlink|EEXIST/))
      const symlinkLatest = path.join(tempDocs, 'symlink-latest.json')
      fs.symlinkSync(symlinkTarget, symlinkLatest, 'file')
      check('latest symlink replacement is rejected', expectThrow(() => writeLatestAtomic(symlinkLatest, { bad: true }, tempDocs, tempRoot), /symlink/))
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }

  const failed = checks.filter((item) => !item.ok)
  process.stdout.write(`v125 beta gate selftest: ${checks.length - failed.length} PASS / ${failed.length} FAIL\n`)
  return failed.length === 0 ? 0 : 1
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
    return 0
  }
  if (argv.includes('--selftest')) return runSelftest()
  const pkg = readPackage()
  const previewRunId = 'preview'
  const previewPlan = buildPlan(pkg, path.join(RUNS_DIR, previewRunId))
  if (argv.includes('--list')) {
    printPlan(previewPlan, false)
    return 0
  }
  if (argv.includes('--dry-run')) {
    printPlan(previewPlan, true)
    process.stdout.write('\nNo commands executed; no evidence files written.\n')
    return 0
  }
  const { runId, runDir } = createRunDirectory()
  const compileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-v125-beta-gate-'))
  try {
    const plan = buildPlan(pkg, runDir, compileDir)
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    const stepRecords = []
    let status = 'pass'
    let stopReason = null

    process.stdout.write(`${GATE_VERSION} gate run ${runId}\n`)
    for (const step of plan) {
      process.stdout.write(`\n[${step.id}] ${step.label}\n$ ${step.command}\n`)
      const result = runStep(step)
      printOutput(step, result.output)
      const meta = gitMeta()
      const record = {
        id: step.id,
        label: step.label,
        command: step.command,
        status: result.status,
        exit: result.exit,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        passNumbers: result.passNumbers,
        keyPassNumbers: result.passNumbers.passNumbers,
        passSummary: result.passNumbers.summaryLines,
        head: meta.head,
        dirtyFiles: meta.dirtyFiles,
        realRequests: 0,
        realProviderRequests: 0,
        realRequestDeclaration: '本项真实 provider 请求数为 0。',
        reason: result.reason
      }
      stepRecords.push(record)
      if (result.status !== 'pass') {
        status = result.status === 'blocked' ? 'blocked' : 'fail'
        stopReason = `${step.id}: ${result.reason || 'blocked'}`
        for (const remaining of plan.slice(stepRecords.length)) {
          const remainingMeta = gitMeta()
          stepRecords.push({
            id: remaining.id,
            label: remaining.label,
            command: remaining.command,
            status: 'not_run',
            exit: null,
            exitCode: null,
            signal: null,
            durationMs: 0,
            passNumbers: { pass: null, fail: null, total: null },
            keyPassNumbers: { pass: null, fail: null, total: null },
            passSummary: [],
            head: remainingMeta.head,
            dirtyFiles: remainingMeta.dirtyFiles,
            realRequests: 0,
            realProviderRequests: 0,
            realRequestDeclaration: '本项未执行；真实 provider 请求数为 0。',
            reason: `not_run after first ${status}`
          })
        }
        break
      }
    }

    const finishedAt = new Date().toISOString()
    const finalMeta = gitMeta()
    const evidence = evidenceEntry({
      runId,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      status,
      stopReason,
      steps: stepRecords,
      head: finalMeta.head,
      dirtyFiles: finalMeta.dirtyFiles
    })
    const manifestPath = writeRunManifestExclusive(path.join(runDir, 'manifest.json'), evidence, runDir, ROOT)
    const latestPath = writeLatestAtomic(LATEST_FILE, evidence, DOCS_DIR, ROOT)
    process.stdout.write(`\n${GATE_VERSION} gate ${status}; ${evidence.counts.passed} PASS, ${evidence.counts.failed} FAIL, ${evidence.counts.blocked} BLOCKED, ${evidence.counts.notRun} NOT_RUN\n`)
    process.stdout.write(`Evidence: ${relativeDisplay(manifestPath)}\nLatest: ${relativeDisplay(latestPath)}\n`)
    return evidence.exitCode
  } finally {
    if (fs.existsSync(compileDir)) fs.rmSync(compileDir, { recursive: true, force: true })
  }
}

if (require.main === module) process.exitCode = main()

module.exports = {
  assertContainedFile,
  assertEvidenceRoots,
  buildPlan,
  parsePassNumbers,
  runSelftest,
  writeLatestAtomic,
  writeRunManifestExclusive,
  main
}
