import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== Gate 1 安全攻击测试套件（fail closed 矩阵） ====================
// 覆盖：路径逃逸 / shell 元字符 / 记忆规则前缀放大 / 伪造 IPC sender / 恶意载荷 /
//       zip bomb 预检 / 恶意 patch 路径 / 重复 anchor / base drift / checkpoint 失败不写盘 /
//       repairLoop 只出提案不写盘。
// 全部必须 fail closed（拒绝且磁盘保持原状态）。
// 运行：npx esbuild scripts/gate1-security.ts --bundle --format=esm --platform=node --outfile=out/gate1.mjs && node out/gate1.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---- 模块加载（esbuild + electron shim；ipcMain 需 stub） ----

const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as {
  build(opts: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>
}

const ELECTRON_SHIM = {
  name: 'electron-shim',
  setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
      contents: [
        'export const app = { getPath: (n) => String(n), isPackaged: false };',
        'export const dialog = { showMessageBox: async () => ({ response: 1 }) };',
        'export const ipcMain = { handle: () => undefined, on: () => undefined };',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => null, decryptString: () => "" };',
        'export const shell = { openExternal: () => undefined, openPath: async () => "" };'
      ].join('\n'),
      loader: 'js'
    }))
  }
}

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  if (!fs.existsSync(abs)) throw new Error(`模块不存在：${rel}`)
  const outfile = path.resolve(__dirname, '..', 'out', `g1mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: desktopSourceExternals(abs, ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate']),
      logLevel: 'silent',
      plugins: [ELECTRON_SHIM]
    })
    const mod = await import(url.pathToFileURL(outfile).href)
    return mod as Record<string, unknown>
  } finally {
    try {
      await fs.promises.unlink(outfile)
    } catch {
      /* 清理失败忽略 */
    }
  }
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-g1-'))

  // ---- [S-1] parseCommandLine：未引用 shell 元字符全部拒绝 ----
  console.log('\n[S-1] parseCommandLine：shell 元字符 / 引号 / 换行')
  const permMod = await loadTsModule('src/main/permissions.ts')
  const parseCommandLine = permMod.parseCommandLine as (cmd: string) => string[] | null
  const isSafeAutoCommand = permMod.isSafeAutoCommand as (cmd: string) => boolean
  const isSafeRulePattern = permMod.isSafeRulePattern as (cmd: string) => boolean
  const createPermissionManager = permMod.createPermissionManager as (
    dir: string,
    ask?: (t: string, target: string) => Promise<{ action: string; remember: boolean }>
  ) => {
    updateSettings(s: unknown): Promise<void>
    decide(type: string, target: string): Promise<{ action: string; reason: string; ruleId?: string }>
    getSettings(): { mode: string; rules: Array<{ id: string; pattern: string; persistent: boolean; literal?: boolean }> }
  }

  const META_REJECT: [string, string][] = [
    ['git status & echo PWNED', '未引用 &'],
    ['dir && del important.txt', '未引用 &&'],
    ['echo x > sensitive.txt', '重定向 >'],
    ['ls -la; whoami', '未引用 ;'],
    ['echo $(whoami)', '命令替换 $('],
    ['echo `id`', '反引号'],
    ['echo *', '通配符 *'],
    ['echo a | findstr b', '管道 |'],
    ['type a.txt\ndir', '换行']
  ]
  for (const [cmd, why] of META_REJECT) {
    check(`parseCommandLine 拒绝：${why}（${cmd.slice(0, 30)}）`, parseCommandLine(cmd) === null, String(parseCommandLine(cmd)))
  }
  check('parseCommandLine 解析引号内元字符（echo "a&b"）', JSON.stringify(parseCommandLine('echo "a&b"')) === JSON.stringify(['echo', 'a&b']))
  check('parseCommandLine 解析普通命令', JSON.stringify(parseCommandLine('git diff --stat')) === JSON.stringify(['git', 'diff', '--stat']))
  check('isSafeRulePattern 拒绝元字符命令', isSafeRulePattern('git status & whoami') === false)
  check('isSafeRulePattern 接受普通命令', isSafeRulePattern('git status') === true)
  check('isSafeAutoCommand 拒绝 git push', isSafeAutoCommand('git push origin main') === false)
  check('isSafeAutoCommand 拒绝 git diff --no-index', isSafeAutoCommand('git diff --no-index a b') === false)
  check('isSafeAutoCommand 拒绝 git diff --ext-diff', isSafeAutoCommand('git diff --ext-diff') === false)
  check('git branch 只读列表允许自动执行', isSafeAutoCommand('git branch -avv') && isSafeAutoCommand('git branch --show-current'))
  check('改变或创建分支不能按只读处理', !isSafeAutoCommand('git branch -D draft') && !isSafeAutoCommand('git branch draft'))
  check('isSafeAutoCommand 接受 git status', isSafeAutoCommand('git status') === true)

  // ---- [S-2] 前缀放大：规则精确匹配（防追加参数绕过） ----
  console.log('\n[S-2] 记忆规则：argv 精确匹配，前缀放大被阻止')
  const pmDir = path.join(tmp, 'perm')
  const pm = createPermissionManager(pmDir, async () => ({ action: 'deny', remember: false }))
  await pm.updateSettings({
    mode: 'safe',
    rules: [
      { id: 'r1', type: 'command', pattern: 'npm test', action: 'allow', persistent: true },
      { id: 'r2', type: 'command', pattern: 'type a.txt', action: 'allow', persistent: true }
    ]
  })
  const d1 = await pm.decide('command', 'npm test')
  check('规则精确命中 npm test → allow', d1.action === 'allow' && d1.ruleId === 'r1', JSON.stringify(d1))
  const d2 = await pm.decide('command', 'npm testevil')
  check('前缀放大阻止：npm test 规则不命中 npm testevil', d2.action !== 'allow' && d2.ruleId !== 'r1', JSON.stringify(d2))
  const d3 = await pm.decide('command', 'npm test --coverage')
  check('前缀放大阻止：npm test 规则不命中 npm test --coverage', d3.action !== 'allow' && d3.ruleId !== 'r1', JSON.stringify(d3))
  const d4 = await pm.decide('command', 'type a.txt & del important.txt')
  check('前缀放大阻止：type a.txt 规则不命中带元字符命令（tokenize 失败）', d4.action !== 'allow' && d4.ruleId !== 'r2', JSON.stringify(d4))

  // ---- [S-3] runCommand：路径逃逸 + cmd 内置 containment ----
  console.log('\n[S-3] runCommand：type/findstr 路径 containment + 元字符拒绝')
  const agentMod = await loadTsModule('src/main/agentTools.ts')
  const runCommand = agentMod.runCommand as (cmd: string, cwd: string, timeoutMs?: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>
  const work = path.join(tmp, 'work')
  const secretDir = path.join(tmp, 'secret')
  await fsp.mkdir(work, { recursive: true })
  await fsp.mkdir(secretDir, { recursive: true })
  await fsp.writeFile(path.join(work, 'a.txt'), 'hello-in-work', 'utf-8')
  await fsp.writeFile(path.join(secretDir, 'secret.txt'), 'TOP-SECRET-CONTENT', 'utf-8')

  const r1 = await runCommand('type a.txt', work)
  check('type 读取工作目录内文件成功', r1.exitCode === 0 && r1.stdout.includes('hello-in-work'), r1.stderr || r1.stdout)
  const r2 = await runCommand(`type ../secret/secret.txt`, work)
  check('type 越出工作目录被拒（.. 逃逸）', r2.exitCode !== 0 && r2.stderr.includes('拒绝'), `${r2.exitCode} ${r2.stderr}`)
  const r3 = await runCommand(`type ${secretDir.replace(/\\/g, '/')}/secret.txt`, work)
  check('type 绝对路径越界被拒', r3.exitCode !== 0 && r3.stderr.includes('拒绝'), `${r3.exitCode} ${r3.stderr}`)
  const r4 = await runCommand('findstr hello a.txt', work)
  check('findstr 工作目录内搜索成功', r4.exitCode === 0 && r4.stdout.includes('a.txt'), r4.stderr || r4.stdout)
  const r5 = await runCommand('findstr TOP ../secret/secret.txt', work)
  check('findstr 越出工作目录被拒', r5.exitCode !== 0 && r5.stderr.includes('拒绝'), `${r5.exitCode} ${r5.stderr}`)
  const r6 = await runCommand('type a.txt & del important.txt', work)
  check('runCommand 拒绝未引用元字符命令', r6.exitCode !== 0 && r6.stderr.includes('元字符'), r6.stderr)
  const r7 = await runCommand('where cmd', work)
  check('where 系统命令禁用', r7.exitCode !== 0 && r7.stderr.includes('禁用'), r7.stderr)
  const r8 = await runCommand('tasklist', work)
  check('tasklist 系统命令禁用', r8.exitCode !== 0 && r8.stderr.includes('禁用'), r8.stderr)
  check('越界读取未发生（secret 内容未泄漏到输出）', !r1.stdout.includes('TOP-SECRET') && !r2.stdout.includes('TOP-SECRET') && !r5.stdout.includes('TOP-SECRET'), '')

  // ---- [S-4] ipcGuard：sender 伪造拒绝 + schema 载荷 ----
  console.log('\n[S-4] ipcGuard：伪造 sender / 非主 frame / 恶意载荷')
  const guardMod = await loadTsModule('src/main/ipcGuard.ts')
  const assertTrustedSender = guardMod.assertTrustedSender as (event: unknown) => void
  const IpcError = guardMod.IpcError as { new (code: string, message: string): Error }
  const fakeSender = (frameUrl: string, isMainFrame: boolean): unknown => ({
    senderFrame: { url: frameUrl },
    sender: { mainFrame: { url: isMainFrame ? frameUrl : 'https://main.example/' } }
  })
  // 非主 frame
  const e1 = fakeSender('file:///C:/evil/page.html', false)
  let rejected = false
  try {
    assertTrustedSender(e1)
  } catch (e) {
    rejected = (e as Error).name === 'IpcError' || (e as Error).message.includes('sender')
  }
  check('非主 frame 的 IPC 调用被拒绝', rejected, '')
  // 未知 origin
  const e2 = fakeSender('https://evil.example/x', true)
  rejected = false
  try {
    assertTrustedSender(e2)
  } catch {
    rejected = true
  }
  check('未知 origin 被拒绝', rejected, '')
  // 缺 senderFrame
  rejected = false
  try {
    assertTrustedSender({ sender: { mainFrame: {} } })
  } catch {
    rejected = true
  }
  check('缺 senderFrame 被拒绝', rejected, '')

  // schema 载荷校验（zod）：settingsSet / attachmentRead
  const schemas = await loadTsModule('src/shared/ipcSchemas.ts')
  const settingsSetSchema = schemas.settingsSetSchema as { safeParse(v: unknown): { success: boolean } }
  check('settings:set whole 缺 apiKey 三件套被拒', settingsSetSchema.safeParse({ kind: 'whole', settings: { model: 'm', baseUrl: 'https://x' } }).success === false)
  check('settings:set patch 合法', settingsSetSchema.safeParse({ kind: 'patch', key: 'temperature', value: 0.7 }).success === true)
  check('settings:set whole 合法（含三件套）', settingsSetSchema.safeParse({ kind: 'whole', settings: { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'k' } }).success === true)
  const attachmentPreviewSchema = schemas.attachmentPreviewSchema as { safeParse(v: unknown): { success: boolean } }
  check('attachments:preview 缺 refId 被拒', attachmentPreviewSchema.safeParse({ sessionId: 's1' }).success === false)
  check('attachments:preview 合法 payload 通过', attachmentPreviewSchema.safeParse({ refId: 'abc', sessionId: 's1' }).success === true)

  // ---- [S-5] preflightZip：zip bomb 预检 ----
  console.log('\n[S-5] preflightZip：zip bomb 在解压前被拒绝')
  const fileImportMod = await loadTsModule('src/main/fileImport.ts')
  const preflightZip = fileImportMod.preflightZip as (buf: Buffer, maxEntries?: number, maxTotal?: number, maxSingle?: number, maxRatio?: number) => string | null
  const fflate: any = await import('fflate')
  // 正常 zip：通过
  const okZip = fflate.zipSync({ 'game/script/a.rpy': fflate.strToU8('label start:\n    "hello"\n') })
  check('正常 zip 预检通过', preflightZip(Buffer.from(okZip)) === null, String(preflightZip(Buffer.from(okZip))))
  // zip bomb：100MB 重复内容（解压 100MB > 64MB 单条上限，且在 unzip 之前就被拒绝）
  const bombBuf = Buffer.from(fflate.zipSync({ 'a.rpy': new Uint8Array(100 * 1024 * 1024).fill(0x61) }))
  const bombResult = preflightZip(bombBuf)
  check('zip bomb（100MB 单条）预检拒绝', bombResult !== null, String(bombResult))
  // 高压缩比 bomb：64MB 上限内但压缩比 > 200（50MB 数据 → 需要 ratio > 200；10MB zeros 压缩后 ~10KB，ratio 1000）
  const ratioBuf = Buffer.from(fflate.zipSync({ 'b.rpy': new Uint8Array(30 * 1024 * 1024).fill(0x00) }))
  const ratioResult = preflightZip(ratioBuf, 500, 200 * 1024 * 1024, 64 * 1024 * 1024, 200)
  check('zip bomb（30MB→~30KB 高压缩比）预检拒绝', ratioResult !== null && ratioResult.includes('压缩比'), String(ratioResult))
  // 条目数超限
  const entries: Record<string, Uint8Array> = {}
  for (let i = 0; i < 600; i++) entries[`f${i}.txt`] = fflate.strToU8('x')
  const manyBuf = Buffer.from(fflate.zipSync(entries))
  check('条目数 600 > 500 预检拒绝', preflightZip(manyBuf) !== null, String(preflightZip(manyBuf)))
  // 损坏 zip
  const badBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
  check('损坏 zip 预检拒绝（fail closed）', preflightZip(badBuf) !== null, String(preflightZip(badBuf)))

  // ---- [S-6] validatePatch：恶意路径拒绝 ----
  console.log('\n[S-6] validatePatch：恶意 file / 超限操作')
  const galgameMod = await loadTsModule('src/main/galgame.ts')
  const validatePatch = galgameMod.validatePatch as (v: unknown) => { ok: boolean; error?: string }
  const makePatch = (file: string, ops: unknown[] = [{ op: 'insert_after', anchor: 'label start:', lines: ['    "x"'] }]) => ({ file, operations: ops })
  check('game/ 内路径合法', validatePatch(makePatch('game/script/a.rpy')).ok === true)
  check('拒绝 ../ 穿越', validatePatch(makePatch('../evil.rpy')).ok === false)
  check('拒绝绝对路径', validatePatch(makePatch('/etc/passwd')).ok === false)
  check('拒绝盘符路径', validatePatch(makePatch('C:\\evil\\a.rpy')).ok === false)
  check('拒绝非 game/ 前缀', validatePatch(makePatch('script/a.rpy')).ok === false)
  const manyOps = Array.from({ length: 21 }, () => ({ op: 'insert_after', anchor: 'x', lines: ['y'] }))
  check('拒绝 >20 条 operations', validatePatch(makePatch('game/script/a.rpy', manyOps)).ok === false)

  // ---- [S-7] applyRenpyPatch：重复 anchor / base drift / checkpoint 失败 → 磁盘不变 ----
  console.log('\n[S-7] applyRenpyPatch：唯一 anchor / base hash / checkpoint 硬失败')
  const projectDir = path.join(tmp, 'renpy')
  const gameDir = path.join(projectDir, 'game', 'script')
  await fsp.mkdir(gameDir, { recursive: true })
  const scriptPath = path.join(gameDir, 'a.rpy')
  await fsp.writeFile(scriptPath, 'label start:\n    "line1"\n    return\n\nlabel other:\n    "line1"\n    return\n', 'utf-8')

  const applyRenpyPatch = galgameMod.applyRenpyPatch as (input: { projectDir: string; patch: unknown; sessionId?: string; baseSha256?: string }) => Promise<{
    ok: boolean; diff: string | null; file: string; baseSha256?: string; error?: string
  }>

  const before = await fsp.readFile(scriptPath, 'utf-8')
  // 重复 anchor（"line1" 出现两次）→ 拒绝且磁盘不变
  const dupPatch = makePatch('game/script/a.rpy', [{ op: 'insert_after', anchor: '"line1"', lines: ['    "INSERTED"'] }])
  const a1 = await applyRenpyPatch({ projectDir, patch: dupPatch })
  check('重复 anchor 被拒（不唯一）', a1.ok === false && String(a1.error ?? '').includes('不唯一'), JSON.stringify(a1))
  check('重复 anchor 后磁盘不变', (await fsp.readFile(scriptPath, 'utf-8')) === before)
  // base drift：错误 baseSha256 → 拒绝
  const goodPatch = makePatch('game/script/a.rpy', [{ op: 'insert_after', anchor: 'label start:', lines: ['    "INSERTED"'] }])
  const a2 = await applyRenpyPatch({ projectDir, patch: goodPatch, baseSha256: '0'.repeat(64) })
  check('base hash 不匹配被拒（base drift）', a2.ok === false && String(a2.error ?? '').includes('base hash'), JSON.stringify(a2))
  check('base drift 后磁盘不变', (await fsp.readFile(scriptPath, 'utf-8')) === before)
  // 正确应用
  const a3 = await applyRenpyPatch({ projectDir, patch: goodPatch })
  check('唯一 anchor + 正确 base 应用成功', a3.ok === true && a3.baseSha256 !== undefined, JSON.stringify(a3))
  check('应用后文件包含新行', (await fsp.readFile(scriptPath, 'utf-8')).includes('INSERTED'))
  // 恶意 patch file 越界 → 拒绝
  const a4 = await applyRenpyPatch({ projectDir, patch: makePatch('../outside.rpy') })
  check('patch file 越界被拒', a4.ok === false, JSON.stringify(a4))
  // 备份失败（.dw-backups 被同名文件占用）→ 拒绝写盘且磁盘不变（fail closed）
  await fsp.rm(path.join(projectDir, '.dw-backups'), { recursive: true, force: true })
  await fsp.writeFile(path.join(projectDir, '.dw-backups'), 'not-a-dir', 'utf-8')
  const before2 = await fsp.readFile(scriptPath, 'utf-8')
  const a5 = await applyRenpyPatch({ projectDir, patch: makePatch('game/script/a.rpy', [{ op: 'insert_after', anchor: 'label other:', lines: ['    "X"'] }]) })
  check('写前备份失败 → 拒绝写盘', a5.ok === false && String(a5.error ?? '').includes('备份失败'), JSON.stringify(a5))
  check('写前备份失败后磁盘不变', (await fsp.readFile(scriptPath, 'utf-8')) === before2)
  await fsp.rm(path.join(projectDir, '.dw-backups'), { force: true })

  // ---- [S-8] buildPatchPreview 不写盘 + repairLoop propose 不写盘 ----
  console.log('\n[S-8] buildPatchPreview / repairLoop：只出提案不写盘')
  const buildPatchPreview = galgameMod.buildPatchPreview as (projectDir: string, patch: unknown) => Promise<{ ok: boolean; diff: string | null; error?: string }>
  const before3 = await fsp.readFile(scriptPath, 'utf-8')
  const pv = await buildPatchPreview(projectDir, makePatch('game/script/a.rpy', [{ op: 'insert_after', anchor: 'label start:', lines: ['    "PREVIEW"'] }]))
  check('buildPatchPreview 生成 diff 预览', pv.ok === true && pv.diff !== null && pv.diff.includes('PREVIEW'), JSON.stringify(pv))
  check('buildPatchPreview 不写盘', (await fsp.readFile(scriptPath, 'utf-8')) === before3)

  // repairLoop propose 模式（坏项目 + 空 apiKey → 不产生提案且不写盘；核心是「不自动写盘」路径不触发）
  const repairLoop = galgameMod.repairLoop as (input: { projectDir: string; sdkPath: string; api: { apiKey: string; baseUrl: string; model: string; maxTokens: number }; maxRepairs?: number; mode?: 'propose' | 'apply' }) => Promise<{ proposals: unknown[]; autoApplied: boolean; diagnostics: unknown[] }>
  const lintRenpyProject = galgameMod.lintRenpyProject as (sdkPath: string, projectDir: string) => Promise<unknown>
  const before4 = await fsp.readFile(scriptPath, 'utf-8')
  // 无 sdkPath 时 lintRenpyProject 会失败返回 ok:false —— repairLoop 用 lint 输出继续；无 apiKey 时直接 break
  const rl = await repairLoop({ projectDir, sdkPath: 'not-exist', api: { apiKey: '', baseUrl: 'http://x', model: 'm', maxTokens: 1 }, mode: 'propose' })
  check('repairLoop propose 模式不自动写盘（autoApplied=false）', rl.autoApplied === false, JSON.stringify(rl))
  check('repairLoop propose 后磁盘不变', (await fsp.readFile(scriptPath, 'utf-8')) === before4)

  // ---- [S-9] capability：伪造/过期/用尽/跨作用域/junction 漂移/URL origin 精确匹配 ----
  console.log('\n[S-9] capability registry 负向矩阵（任务二）')
  const capMod = await loadTsModule('src/main/fileCapability.ts')
  const registry = (capMod.fileCapabilityRegistry as { clear(): void }).clear()
  void registry
  const FileCapabilityRegistry = capMod.FileCapabilityRegistry as new () => {
    issue(paths: string[], opts: unknown): Promise<{ caps: Array<{ capId: string; kind: string; realpath: string }>; failed: number }>
    resolve(capId: string, opts?: unknown): Promise<{ capId: string; kind: string; realpath: string } | null>
  }
  const reg = new FileCapabilityRegistry()
  const capFile = path.join(tmp, 'cap-file.txt')
  await fsp.writeFile(capFile, 'capability test content', 'utf-8')

  // 1. 合法签发 + 解析
  const { caps } = await reg.issue([capFile], { kind: 'file', source: 'dialog' })
  check('签发合法文件 cap', caps.length === 1 && caps[0].kind === 'file', JSON.stringify(caps))
  const resolved1 = await reg.resolve(caps[0].capId)
  check('解析合法 cap → realpath 一致', resolved1 !== null && resolved1.realpath === (await fsp.realpath(capFile)), JSON.stringify(resolved1))
  // 2. 伪造 capId
  check('伪造 capId 拒绝', (await reg.resolve('deadbeef'.repeat(4))) === null)
  // 3. 用尽（uses=1 已消费）
  check('单用途 cap 用尽后拒绝', (await reg.resolve(caps[0].capId)) === null)
  // 4. 过期（ttl=1ms + 等待）
  const { caps: c2 } = await reg.issue([capFile], { kind: 'file', source: 'dialog', ttlMs: 1 })
  await new Promise((r) => setTimeout(r, 20))
  check('过期 cap 拒绝', (await reg.resolve(c2[0].capId)) === null)
  // 5. 跨 session scope 拒绝
  const { caps: c3 } = await reg.issue([capFile], { kind: 'file', source: 'dialog', sessionScope: 'sess-A', uses: 3 })
  check('跨 session 复用拒绝', (await reg.resolve(c3[0].capId, { sessionScope: 'sess-B' })) === null)
  check('同 session 允许', (await reg.resolve(c3[0].capId, { sessionScope: 'sess-A' })) !== null)
  // 6. 签发后文件删除 → realpath 漂移拒绝
  const { caps: c4 } = await reg.issue([capFile], { kind: 'file', source: 'dialog' })
  await fsp.unlink(capFile)
  check('签发后文件消失 → resolve 拒绝（fail closed）', (await reg.resolve(c4[0].capId)) === null)
  await fsp.writeFile(capFile, 'restored', 'utf-8')
  // 7. 目录 kind 不匹配（用文件路径签发 dir → failed）
  const rDirKind = await reg.issue([capFile], { kind: 'dir', source: 'dialog' })
  check('文件路径签发 dir cap → failed', rDirKind.failed === 1 && rDirKind.caps.length === 0, JSON.stringify(rDirKind))

  // 8. dev URL origin 精确匹配（防前缀混淆）
  const guardMod2 = await loadTsModule('src/main/ipcGuard.ts')
  const isTrustedSenderUrl = guardMod2.isTrustedSenderUrl as (url: string) => boolean
  const origDev = process.env.ELECTRON_RENDERER_URL
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
  try {
    check('同 origin 精确匹配（dev）', isTrustedSenderUrl('http://localhost:5173/index.html') === true)
    check('前缀混淆拒绝（localhost:5173.evil.com）', isTrustedSenderUrl('http://localhost:5173.evil.com/x') === false)
    check('端口不同拒绝', isTrustedSenderUrl('http://localhost:51730/x') === false)
    check('https 不同协议拒绝', isTrustedSenderUrl('https://localhost:5173/x') === false)
    check('userinfo 混淆拒绝', isTrustedSenderUrl('http://evil@localhost:5173/x') === false)
  } finally {
    if (origDev === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = origDev
  }
  check('无 dev 环境：任意 http 拒绝', isTrustedSenderUrl('http://localhost:5173/x') === false)

  // ---- [S-10] 原生文件右键菜单（任务三）：动作构建/相对路径边界/剪贴板执行 ----
  console.log('\n[S-10] fileContextMenu：cap 解析 / 相对路径边界 / 动作执行')
  const fcmMod = await loadTsModule('src/main/fileContextMenu.ts')
  const buildFileContextActions = fcmMod.buildFileContextActions as (
    cap: { kind: string; realpath: string },
    workDir: string
  ) => Array<{ id: string; label: string; enabled: boolean }>
  const executeFileContextAction = fcmMod.executeFileContextAction as (
    actionId: string,
    cap: { kind: string; realpath: string },
    workDir: string,
    deps: unknown
  ) => Promise<{ ok: boolean; message?: string }>
  const workDirC = path.join(tmp, 'ctx-work')
  const insideFile = path.join(workDirC, 'docs', 'a.md')
  const outsideFile = path.join(tmp, 'outside.md')
  await fsp.mkdir(path.join(workDirC, 'docs'), { recursive: true })
  await fsp.writeFile(insideFile, 'x', 'utf-8')
  await fsp.writeFile(outsideFile, 'y', 'utf-8')

  const capInside = { kind: 'file' as const, realpath: insideFile }
  const capOutside = { kind: 'file' as const, realpath: outsideFile }
  const actsIn = buildFileContextActions(capInside, workDirC)
  const actsOut = buildFileContextActions(capOutside, workDirC)
  check('菜单包含 5 个动作', actsIn.length === 5, JSON.stringify(actsIn))
  check('工作区内对象：复制相对路径可用', actsIn.find((a) => a.id === 'copy-relative')?.enabled === true)
  check('工作区外对象：复制相对路径禁用', actsOut.find((a) => a.id === 'copy-relative')?.enabled === false)
  check('工作区内相对路径正确（docs/a.md）', /docs[\\/]a\.md/.test(actsIn.find((a) => a.id === 'copy-relative')?.label ?? ''), actsIn.find((a) => a.id === 'copy-relative')?.label)
  check('目录对象：附加到下一次请求禁用', buildFileContextActions({ kind: 'dir', realpath: workDirC }, workDirC).find((a) => a.id === 'attach')?.enabled === false)

  const clip: string[] = []
  const depsMock = {
    writeClipboard: (t: string): void => {
      clip.push(t)
    },
    openPath: async () => true,
    showItemInFolder: () => undefined,
    emitAttach: () => undefined
  }
  const rAbs = await executeFileContextAction('copy-absolute', capInside, workDirC, depsMock)
  check('复制绝对路径写入剪贴板', rAbs.ok === true && clip[clip.length - 1] === insideFile)
  const rRel = await executeFileContextAction('copy-relative', capInside, workDirC, depsMock)
  check('复制相对路径写入相对值', rRel.ok === true && clip[clip.length - 1] === path.join('docs', 'a.md'))
  const rRelOut = await executeFileContextAction('copy-relative', capOutside, workDirC, depsMock)
  check('工作区外复制相对路径拒绝', rRelOut.ok === false, JSON.stringify(rRelOut))
  const rUnknown = await executeFileContextAction('delete', capInside, workDirC, depsMock)
  check('未知动作拒绝', rUnknown.ok === false)

  // schema：fileContextOpen 拒绝非法 anchorKind
  const schemas2 = await loadTsModule('src/shared/ipcSchemas.ts')
  const fileContextOpenSchema = schemas2.fileContextOpenSchema as { safeParse(v: unknown): { success: boolean } }
  check('fileContext:open 合法 payload 通过', fileContextOpenSchema.safeParse({ fileRefId: 'abc', anchorKind: 'attachment', sessionId: 's1' }).success === true)
  check('fileContext:open 非法 anchorKind 拒绝', fileContextOpenSchema.safeParse({ fileRefId: 'abc', anchorKind: 'evil' }).success === false)
  check('fileContext:open 缺 fileRefId 拒绝', fileContextOpenSchema.safeParse({ anchorKind: 'file' }).success === false)

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== Gate 1 安全测试结果：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Gate 1 安全测试执行异常：', e)
  process.exit(2)
})
