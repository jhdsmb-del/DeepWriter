// ==================== Gate 4：Galgame golden projects（本地 E2E） ====================
// golden 项目覆盖：label/call/jump/menu/screen/translate/Python block、重复 anchor、
// 多语言与资源引用。验证扫描/分支图/资源/变量/patch 成功路径与 fail-closed 拒绝。
// lint 需要真实 SDK——此处只覆盖"SDK 不存在"失败路径（成功路径需 CI 接真实 SDK）。
// 运行：npx esbuild scripts/gate4-galgame.ts --bundle --format=esm --platform=node --outfile=out/gate4.mjs && node out/gate4.mjs

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

const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

const ELECTRON_SHIM = {
  name: 'electron-shim',
  setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
      contents: 'export const app = { getPath: (n) => String(n), isPackaged: false };\nexport const dialog = { showMessageBox: async () => ({ response: 1 }) };',
      loader: 'js'
    }))
  }
}

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `g4mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate'],
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

// ---- golden 项目内容 ----

const GOLDEN_SCRIPT = `# golden: label/call/jump/menu/好感度/重复 anchor/资源引用
define e = Character("艾米")
define sara = Character("莎拉")
define rin = Character("凛")
default sara_affection = 0
default rin_affection = 0

label start:
    scene bg school with dissolve
    play music "bgm/school.ogg" loop
    show sara happy at center with dissolve
    sara "你好，我是莎拉。"
    menu:
        "问凛的事":
            jump ask_rin
        "保持沉默":
            $ sara_affection += 1
            sara "……"
            jump start_after
    label start_after:
    call scene_rin
    return

label ask_rin:
    show rin smile at right with dissolve
    rin "在聊我吗？"
    jump start_after

label scene_rin:
    $ rin_affection += 1
    rin "今天我们去看海吧。"
    return

label common_line:
    "重复的锚点行"
    return

label another:
    "重复的锚点行"
    return
`

const GOLDEN_SCREEN = `# golden: screen / translate / Python block
screen hud():
    text "好感度："
    text "[sara_affection]"

translate chinese start_45a2b3c4:
    e "你好，我是莎拉。" -> e "你好，我是莎拉。（中文）"

init python:
    def add_bonus(amount):
        return amount * 2
`

const GOLDEN_UI = `# golden: 资源引用（缺失与存在）
label resource_test:
    scene bg beach with dissolve
    play sound "sfx/waves.ogg"
    show sara happy at center
    return
`

async function buildGoldenProject(dir: string): Promise<void> {
  const game = path.join(dir, 'game')
  await fsp.mkdir(path.join(game, 'script'), { recursive: true })
  await fsp.mkdir(path.join(game, 'images'), { recursive: true })
  await fsp.mkdir(path.join(game, 'audio', 'bgm'), { recursive: true })
  await fsp.writeFile(path.join(game, 'script', 'script.rpy'), GOLDEN_SCRIPT, 'utf-8')
  await fsp.writeFile(path.join(game, 'script', 'screen.rpy'), GOLDEN_SCREEN, 'utf-8')
  await fsp.writeFile(path.join(game, 'script', 'ui.rpy'), GOLDEN_UI, 'utf-8')
  // 存在的资源（bgm 引用存在；sfx/waves.ogg 缺失）
  await fsp.writeFile(path.join(game, 'audio', 'bgm', 'school.ogg'), 'x', 'binary')
  await fsp.writeFile(path.join(game, 'images', 'bg.png'), 'x', 'binary')
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-g4-'))
  const galgameMod = await loadTsModule('src/main/galgame.ts')
  const g = galgameMod as {
    scanRenpyProject(p: string): Promise<{
      root: string
      scriptDir: string
      scriptFiles: string[]
      characters: { varName: string; displayName: string }[]
      affinityVars: string[]
      labels: string[]
      gameName: string | null
    }>
    buildBranchGraph(p: string): Promise<{ labels: { name: string }[]; edges: { from: string; to: string; type: string }[]; diagnostics: { code: string; message: string }[] }>
    checkRenpyResources(p: string): Promise<{ missing: string[] }>
    checkRenpyVariables(p: string): Promise<{ undeclared: string[] }>
    lintRenpyProject(sdk: string, p: string): Promise<{ ok: boolean; output: string }>
    applyRenpyPatch(i: { projectDir: string; patch: unknown }): Promise<{ ok: boolean; error?: string }>
    validatePatch(v: unknown): { ok: boolean; patch?: unknown; error?: string }
  }

  console.log('\n[G4-1] golden 项目扫描：角色/好感度/label/脚本文件')
  const project = path.join(tmp, 'golden1')
  await buildGoldenProject(project)
  const info = await g.scanRenpyProject(project)
  check('角色识别（e/sara/rin）', ['e', 'sara', 'rin'].every((n) => info.characters.some((c) => c.varName === n)), JSON.stringify(info.characters))
  check('显示名识别（莎拉/凛）', info.characters.some((c) => c.varName === 'sara' && c.displayName === '莎拉') && info.characters.some((c) => c.varName === 'rin' && c.displayName === '凛'), JSON.stringify(info.characters))
  check('好感度变量识别（sara_affection/rin_affection）', ['sara_affection', 'rin_affection'].every((v) => info.affinityVars.includes(v)), JSON.stringify(info.affinityVars))
  check('label 收集（start/ask_rin/scene_rin）', ['start', 'ask_rin', 'scene_rin', 'resource_test'].every((l) => info.labels.includes(l)), JSON.stringify(info.labels))
  check('脚本文件收集（3 个 .rpy）', info.scriptFiles.length === 3, JSON.stringify(info.scriptFiles))

  console.log('\n[G4-2] 分支图：边/菜单/缺失目标诊断')
  const graph = await g.buildBranchGraph(project)
  const labelNames = graph.labels.map((l) => l.name)
  check('分支图 label 完整', ['start', 'ask_rin', 'scene_rin', 'common_line', 'another'].every((l) => labelNames.includes(l)), JSON.stringify(labelNames))
  check('jump 边（start→ask_rin）', graph.edges.some((e) => e.from === 'start' && e.to === 'ask_rin' && e.type === 'menu'), JSON.stringify(graph.edges))
  check('call 边（start_after→scene_rin）', graph.edges.some((e) => e.from === 'start_after' && e.to === 'scene_rin' && e.type === 'call'), JSON.stringify(graph.edges))

  console.log('\n[G4-3] 资源引用完整性（存在 vs 缺失）')
  const res = await g.checkRenpyResources(project)
  check('缺失资源被检出（sfx/waves.ogg）', res.missing.some((m) => m.toLowerCase().includes('waves')), JSON.stringify(res.missing))
  check('存在的资源不误报（bgm/school.ogg / images/bg.png）', !res.missing.some((m) => /school|bg\.png/i.test(m)), JSON.stringify(res.missing))

  console.log('\n[G4-4] 变量声明检查（default 声明排除）')
  const vars = await g.checkRenpyVariables(project)
  check('default 声明的好感度变量不报未声明', !vars.undeclared.some((u) => /affection/i.test(u)), JSON.stringify(vars.undeclared))

  console.log('\n[G4-5] lint 失败路径（SDK 不存在 → fail closed）')
  const lint = await g.lintRenpyProject(path.join(tmp, 'not-exist-sdk', 'renpy.exe'), project)
  check('SDK 不存在 → ok=false 不抛异常', lint.ok === false, JSON.stringify(lint).slice(0, 200))

  console.log('\n[G4-6] patch 成功路径 + 重复 anchor fail closed')
  const scriptPath = path.join(project, 'game', 'script', 'script.rpy')
  const before = await fsp.readFile(scriptPath, 'utf-8')
  // 合法 insert_after（唯一 anchor）
  const okPatch = { file: 'game/script/script.rpy', operations: [{ op: 'insert_after', anchor: 'label start_after:', lines: ['    e "新的对白行"'] }] }
  const r1 = await g.applyRenpyPatch({ projectDir: project, patch: okPatch })
  check('唯一 anchor insert_after 应用成功', r1.ok === true, JSON.stringify(r1))
  const after = await fsp.readFile(scriptPath, 'utf-8')
  check('应用后文件包含新行', after.includes('新的对白行'))
  // 重复 anchor（"重复的锚点行"出现两次）→ 拒绝且磁盘不变
  const before2 = await fsp.readFile(scriptPath, 'utf-8')
  const dupPatch = { file: 'game/script/script.rpy', operations: [{ op: 'insert_after', anchor: '"重复的锚点行"', lines: ['    e "X"'] }] }
  const r2 = await g.applyRenpyPatch({ projectDir: project, patch: dupPatch })
  check('重复 anchor 被拒（不唯一）', r2.ok === false && String(r2.error ?? '').includes('不唯一'), JSON.stringify(r2))
  check('重复 anchor 后磁盘不变', (await fsp.readFile(scriptPath, 'utf-8')) === before2)
  // 替换行成功路径（用唯一 anchor）
  const r3 = await g.applyRenpyPatch({ projectDir: project, patch: { file: 'game/script/script.rpy', operations: [{ op: 'replace_line', anchor: 'rin "今天我们去看海吧。"', lines: ['rin "今天我们去看海吧！（新版）"'] }] } })
  check('replace_line（唯一 anchor）应用成功', r3.ok === true, JSON.stringify(r3))
  check('替换后文件内容更新', (await fsp.readFile(scriptPath, 'utf-8')).includes('去看海吧！（新版）'))
  void before

  console.log('\n[G4-7] validatePatch：合法/非法矩阵')
  const v1 = g.validatePatch({ file: 'game/script/x.rpy', operations: [{ op: 'insert_after', anchor: 'a', lines: ['b'] }] })
  check('合法 patch 通过', v1.ok === true)
  check('game/ 外路径拒绝', g.validatePatch({ file: 'script/x.rpy', operations: [{ op: 'insert_after', anchor: 'a', lines: ['b'] }] }).ok === false)
  check('../ 穿越拒绝', g.validatePatch({ file: 'game/../evil.rpy', operations: [{ op: 'insert_after', anchor: 'a', lines: ['b'] }] }).ok === false)
  check('不支持的 op 拒绝', g.validatePatch({ file: 'game/script/x.rpy', operations: [{ op: 'delete', anchor: 'a', lines: ['b'] }] }).ok === false)
  check('空 anchor 拒绝', g.validatePatch({ file: 'game/script/x.rpy', operations: [{ op: 'insert_after', anchor: '  ', lines: ['b'] }] }).ok === false)

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== Gate 4 Galgame golden 结果：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Gate 4 Galgame 执行异常：', e)
  process.exit(2)
})
