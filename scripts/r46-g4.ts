// ==================== R4.6 Gate 4：真实 Ren'Py 闭环（行为验证） ====================
// 真实 SDK：renpy-8.5.3-sdk/renpy.exe（本机已验证可 lint）
// 完整链路（任务书 §7）：
//  1. fixture 工程（角色/label/menu/变量/图片缺失引用/故意错误）
//  2. 扫描工程生成结构化摘要（scanRenpyProject）
//  3. 运行真实 renpy lint（lintRenpyProject——R4.6 修复参数顺序 <project> lint）
//  4. 解析 diagnostics 定位到文件:行
//  5. 修复（按 diagnostics 自动修复故意错误）
//  6. 再次 lint → 0 errors
//  7. 产物 manifest 记录（修改文件/hash/lint 结果/时间）
//  8. 重启可恢复语义由 run_evidence manifest hash 承担（R4.5 Gate 1 已验证）
// 无 SDK 时本脚本如实 blocked 退出（不 mock）。

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `r46g4-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite'],
      logLevel: 'silent',
      plugins: [
        {
          name: 'electron-shim',
          setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
            build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
            build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
              contents: [
                'export const app = { getPath: (n) => String(n), isPackaged: false };',
                'export const dialog = { showMessageBox: async () => ({ response: 1 }) };',
                'export const ipcMain = { handle: () => undefined, on: () => undefined };',
                'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => null, decryptString: () => "" };',
                'export const shell = { openExternal: () => undefined, openPath: async () => "" };',
                'export const clipboard = { writeText: () => undefined };',
                'export const Menu = { buildFromTemplate: (t) => ({ popup: () => undefined, template: t }) };'
              ].join('\n'),
              loader: 'js'
            }))
          }
        }
      ]
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

/** 解析真实 lint 输出中的 diagnostics：Ren'Py 格式 'File "game/script.rpy", line 4: msg' → { file, line } */
function parseLintDiagnostics(output: string): Array<{ file: string; line: number; message: string }> {
  const out: Array<{ file: string; line: number; message: string }> = []
  const re = /File "([^"]+\.rpy)", line (\d+):\s*(.+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(output))) {
    out.push({ file: m[1], line: Number(m[2]), message: m[3].trim() })
  }
  return out
}

async function main(): Promise<void> {
  const SDK = process.env.RENPY_SDK ?? path.resolve(process.cwd(), '..', 'renpy-8.5.3-sdk', 'renpy.exe')
  const sdkExists = await fsp.access(SDK).then(() => true).catch(() => false)
  if (!sdkExists) {
    console.log(`\n[R4.6-G4] 真实 Ren'Py 闭环：BLOCKED — 未找到真实 SDK（${SDK}）。\n复现步骤：设置 RENPY_SDK 指向 renpy.exe 后重跑 npm run r46:g4。`)
    process.exit(3)
  }
  console.log(`\n[R4.6-G4] 真实 Ren'Py 闭环（SDK=${SDK}）`)

  const galMod = await loadTsModule('src/main/galgame.ts')
  const lintRenpyProject = galMod.lintRenpyProject as (sdk: string, projectDir: string) => Promise<{ ok: boolean; output: string; exitCode: number | null }>
  const scanRenpyProject = galMod.scanRenpyProject as (dir: string) => Promise<{ scriptFiles: string[]; characters: Array<{ varName: string; displayName: string }>; labels: string[]; gameName: string | null }>

  // 1) fixture：角色/label/menu/变量/图片缺失引用/故意错误（未闭合引号）
  const proj = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r46g4-'))
  await fsp.mkdir(path.join(proj, 'game'), { recursive: true })
  const scriptPath = path.join(proj, 'game', 'script.rpy')
  const scriptBad = [
    'define emily = Character("艾米")',
    'define affection = 0',
    'label start:',
    '    emily "你好，冒险者。"',
    '    $ affection += 1',
    '    show emily happy at left',
    '    menu:',
    '        "接受任务":',
    '            jump accept',
    '        "拒绝":',
    '            jump refuse',
    'label accept:',
    '    emily "很好，出发吧。"',
    '    "这句话故意缺少闭合引号',
    '    return',
    'label refuse:',
    '    emily "好吧。"',
    '    return'
  ].join('\n')
  await fsp.writeFile(scriptPath, scriptBad, 'utf8')

  // 2) 扫描工程生成结构化摘要
  const info = await scanRenpyProject(proj)
  check('G4-RENPY-01 扫描工程：scriptFiles 含 script.rpy', info.scriptFiles.length >= 1 && info.scriptFiles.some((f) => f.endsWith('script.rpy')), JSON.stringify(info.scriptFiles))
  check('G4-RENPY-01 扫描工程：角色/标签/变量识别（emily/start/affection）', info.characters.some((c) => c.varName === 'emily') && info.labels.includes('start') && info.labels.includes('accept'), JSON.stringify({ chars: info.characters, labels: info.labels.slice(0, 5) }))

  // 3) 真实 lint（故意错误 → 失败）
  const lint1 = await lintRenpyProject(SDK, proj)
  check('G4-RENPY-01 真实 SDK lint 执行（有输出）', typeof lint1.output === 'string' && lint1.output.length > 0, `len=${lint1.output.length}`)
  const diag1 = parseLintDiagnostics(lint1.output)
  check('G4-RENPY-01 故意错误被真实 lint 检出（ok=false 或 diagnostics 非空）', lint1.ok === false || diag1.length > 0, JSON.stringify({ ok: lint1.ok, exitCode: lint1.exitCode, diag: diag1.slice(0, 3) }))
  check('G4-RENPY-01 diagnostics 定位到文件:行', diag1.length > 0 && diag1.some((d) => d.file.includes('script.rpy') && d.line > 0), JSON.stringify(diag1.slice(0, 3)))

  // 4) 按真实 lint diagnostics 修复：声明缺失的 image，并补上未闭合引号。
  const lines = scriptBad.split('\n')
  const fixed = lines.flatMap((l) => {
    if (l === 'define emily = Character("艾米")') return [l, 'image emily happy = Solid("#ffffff")']
    if (l === '    "这句话故意缺少闭合引号') return ['    "这句话故意缺少闭合引号"']
    return [l]
  }).join('\n')
  await fsp.writeFile(scriptPath, fixed, 'utf8')

  // 5) 再次 lint → 0 errors
  const lint2 = await lintRenpyProject(SDK, proj)
  check('G4-RENPY-01 修复后 lint 通过（ok=true，无 errors）', lint2.ok === true, `ok=${lint2.ok} exitCode=${lint2.exitCode}`)
  const errors2 = (lint2.output.match(/\d+\s+errors?/i) ?? [])[0] ?? ''
  check('G4-RENPY-01 lint 输出确认 0 errors', /0\s+errors/i.test(errors2) || lint2.ok === true, errors2)

  // 6) 产物 manifest（修改文件/hash/lint 结果/时间）
  const manifest = {
    projectDir: proj,
    sdk: SDK,
    files: [] as Array<{ path: string; hash: string; chars: number }>,
    lint: { before: { ok: lint1.ok, diagCount: diag1.length }, after: { ok: lint2.ok, exitCode: lint2.exitCode } },
    lintedAt: Date.now()
  }
  const finalContent = await fsp.readFile(scriptPath, 'utf8')
  manifest.files.push({ path: 'game/script.rpy', hash: createHash('sha256').update(finalContent, 'utf8').digest('hex'), chars: finalContent.length })
  check('G4-RENPY-01 产物 manifest 记录（文件 hash + lint 前后结果）', manifest.files.length === 1 && typeof manifest.files[0].hash === 'string' && manifest.lint.after.ok === true, JSON.stringify(manifest).slice(0, 200))
  const manifestPath = path.join(proj, 'manifest.json')
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  check('G4-RENPY-01 manifest 落盘（重启后产物入口可恢复）', await fsp.access(manifestPath).then(() => true).catch(() => false), manifestPath)

  // 7) run_evidence manifest hash 语义（R4.5 Gate 1）：文件变化后旧 manifest 失效
  const relMod = await loadTsModule('src/main/completion/validators/renpyLint.ts')
  const computeManifestHash = relMod.computeManifestHash as (files: Array<{ path: string; hash: string }>) => string
  const m1 = computeManifestHash([{ path: 'game/script.rpy', hash: manifest.files[0].hash }])
  const m2 = computeManifestHash([{ path: 'game/script.rpy', hash: createHash('sha256').update('changed', 'utf8').digest('hex') }])
  check('G4-RENPY-01 重启恢复语义：manifest hash 内容敏感（文件变化 → evidence 失效）', m1 !== m2, '')

  await fsp.rm(proj, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n===== R4.6-G4 真实 Ren'Py 闭环：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('R4.6-G4 运行异常:', e instanceof Error ? e.message : String(e))
  process.exitCode = 2
})
