// ==================== Gate 0 三项确定性回归测试（先红后绿） ====================
// 固化自复审报告可复现的三项确定性回归，作为 Gate 0 的 failing tests：
//   G0-1 novelv2 创建项目后必须写出可解析的 manifest.json
//   G0-2 自定义 scenes 创建不得崩溃，且场景顺序/状态/数量正确
//   G0-3 单作品（一个文件整本书）语料必须按章节 group-aware 划分，
//        profile/example/holdout 不能为空；不足时必须明确失败而非静默全进 profile
//
// 运行：npm run gate0-regressions（esbuild bundle + node 执行）
// 这些测试只依赖临时目录与纯 Node 模块，不触网、不写项目内数据。

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

// ---- 与 scripts/verify.ts 相同的 esbuild + electron shim 模块加载 ----

const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as {
  build(opts: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>
}

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
  if (!fs.existsSync(abs)) throw new Error(`模块不存在：${rel}`)
  const outfile = path.resolve(__dirname, '..', 'out', `g0mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

const FAKE_API = () => ({ apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1', model: 'deepseek-v4-flash', maxTokens: 1024 })

// ---- G0-1 / G0-2：novelv2 项目创建 ----

async function testNovelManifestAndCustomScenes(tmp: string): Promise<void> {
  console.log('\n[G0-1] novelv2 创建项目后必须写出可解析 manifest.json')
  const novel = await loadTsModule('src/main/novel/novelWorkflow.ts')
  const createNovelWorkflow = novel.createNovelWorkflow as (opts: { baseDir: string; getApi: () => unknown }) => {
    startProject(input: { title: string; targetChars: number; notes?: string; scenes?: { title: string; chars?: string[]; wordTarget: number }[] }): Promise<{ projectId: string; sceneCount: number }>
    projectStatus(projectId: string): Promise<unknown>
  }
  const wf = createNovelWorkflow({ baseDir: tmp, getApi: FAKE_API })

  const { projectId } = await wf.startProject({ title: '回归测试项目', targetChars: 8000 })
  const novelRoot = path.join(tmp, 'novels', projectId)
  const manifestPath = path.join(novelRoot, 'manifest.json')

  let manifestValid = false
  let manifestDetail = `manifest.json 不存在（${manifestPath}）`
  try {
    const raw = await fsp.readFile(manifestPath, 'utf-8')
    const m = JSON.parse(raw) as { projectId?: string; scenes?: unknown[]; updatedAt?: number }
    manifestValid = m.projectId === projectId && Array.isArray(m.scenes) && typeof m.updatedAt === 'number'
    manifestDetail = JSON.stringify(m).slice(0, 200)
  } catch (e) {
    manifestDetail = (e as Error).message
  }
  check('G0-1 创建后存在可解析 manifest.json（projectId/scenes/updatedAt 齐全）', manifestValid, manifestDetail)

  const bibleExists = await fsp.readFile(path.join(novelRoot, 'bible.json'), 'utf-8').then(() => true).catch(() => false)
  check('G0-1 bible.json 存在（事实源）', bibleExists)

  console.log('\n[G0-2] 自定义 scenes 创建不得崩溃，且状态/顺序/数量正确')
  let customErr = ''
  let customSceneCount = -1
  let customProjectId = ''
  try {
    const r = await wf.startProject({
      title: '自定义场景项目',
      targetChars: 4000,
      scenes: [
        { title: '开场', wordTarget: 2000 },
        { title: '高潮', wordTarget: 2000 },
        { title: '收尾', wordTarget: 2000 }
      ]
    })
    customSceneCount = r.sceneCount
    customProjectId = r.projectId
  } catch (e) {
    customErr = (e as Error).message
  }
  check('G0-2 自定义 scenes 创建不抛异常', customErr === '', customErr || `sceneCount=${customSceneCount}`)
  check('G0-2 sceneCount 等于输入场景数（3）', customSceneCount === 3, `sceneCount=${customSceneCount}`)

  // 校验落盘 bible 的场景顺序、编号、状态（直接用返回的 projectId，避免 readdir 顺序歧义）
  let orderOk = false
  let titlesOk = false
  let bibleDetail = '自定义项目 bible.json 不存在'
  try {
    const customRoot = path.join(tmp, 'novels', customProjectId)
    const bible = JSON.parse(await fsp.readFile(path.join(customRoot, 'bible.json'), 'utf-8')) as {
      scenes: { id: string; sceneNo: number; title: string; status: string; version: number }[]
    }
    orderOk = bible.scenes.length === 3 && bible.scenes.every((s, i) => s.sceneNo === i + 1 && s.status === 'planned' && s.version === 0)
    titlesOk = bible.scenes.map((s) => s.title).join(',') === '开场,高潮,收尾'
    bibleDetail = JSON.stringify(bible.scenes.map((s) => ({ n: s.sceneNo, st: s.status, v: s.version, t: s.title })))
  } catch (e) {
    bibleDetail = (e as Error).message
  }
  check('G0-2 场景顺序（sceneNo 1..3）、status=planned、version=0', orderOk, bibleDetail)
  check('G0-2 场景标题顺序正确', titlesOk, bibleDetail)
}

async function listNovelDirs(tmp: string): Promise<string[]> {
  const novels = path.join(tmp, 'novels')
  return (await fsp.readdir(novels).catch(() => [] as string[])).filter((n) => !n.startsWith('.'))
}

// ---- G0-3：单作品语料划分 ----

async function testSingleWorkCorpusSplit(tmp: string): Promise<void> {
  console.log('\n[G0-3] 单作品（一个文件整本书）语料按章节 group-aware 划分')
  const style = await loadTsModule('src/main/style/styleService.ts')
  const createStyleService = style.createStyleService as (opts: { baseDir: string; getApi: () => unknown }) => {
    buildProfile(sourceTexts: { name: string; text: string }[]): Promise<{ stats: { splits: Record<string, number>; chunks: number } }>
  }
  const svc = createStyleService({ baseDir: tmp, getApi: FAKE_API })

  // 构造"一个文件整本书"：8 章 × 约 2500 字，带章节标记
  const parasPerChapter = 20
  const paraText = '他站在雨里，看着远方山脊上最后一抹光沉下去。风穿过街巷，卷起落叶，也卷起他外套的衣角。这个城市在黄昏里慢慢安静下来，只剩下雨声和远处钟楼的回响。'
  const bookChapters: string[] = []
  for (let ch = 1; ch <= 8; ch++) {
    const paras: string[] = []
    for (let p = 0; p < parasPerChapter; p++) {
      paras.push(`第${ch}章第${p + 1}段。${paraText}`)
    }
    bookChapters.push(`第${ch}章\n${paras.join('\n')}`)
  }
  const book = bookChapters.join('\n')

  const res = await svc.buildProfile([{ name: '整本书.txt', text: book }])
  const splits = res.stats.splits
  const detail = JSON.stringify({ chunks: res.stats.chunks, splits })
  // 单文件整本书必须能切出 example 与 holdout（当前实现按作品名分组，全部进 profile）
  check('G0-3 example 非空（单文件整本书必须按章节切出 example）', splits.example > 0, detail)
  check('G0-3 holdout 非空（单文件整本书必须按章节切出 holdout）', splits.holdout > 0, detail)
  check('G0-3 profile 非空', splits.profile > 0, detail)
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-gate0-'))
  try {
    await testNovelManifestAndCustomScenes(tmp)
    await testSingleWorkCorpusSplit(tmp)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
  console.log(`\n===== Gate 0 回归结果：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Gate 0 回归执行异常：', e)
  process.exit(2)
})
