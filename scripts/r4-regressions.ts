// ==================== R4 回归测试（R4-1 FileRef 修绿 + 剩余红灯） ====================
// 运行：npx esbuild scripts/r4-regressions.ts --bundle --format=esm --platform=node --outfile=out/r4.mjs && node out/r4.mjs
// 状态：FILE-01~08 应为绿（R4-1 已实现 FileRef）；DB-01 仍为红灯（R4-3 修）。

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

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
        'export const shell = { openExternal: () => undefined, openPath: async () => "" };',
        'export const clipboard = { writeText: () => undefined };',
        'export const Menu = { buildFromTemplate: (t) => ({ popup: () => undefined, template: t }) };'
      ].join('\n'),
      loader: 'js'
    }))
  }
}

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `r4mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r4-'))

  console.log('\n[R4-FILE] 文件引用生命周期（R4-1 FileRef：inspect/预览不消费，scope 必填，变化检测，硬上限）')
  const refMod = await loadTsModule('src/main/fileRef.ts')
  const FileRefRegistry = refMod.FileRefRegistry as new () => {
    register(paths: string[], scope: unknown, source: string): Promise<{ refs: Array<{ fileRefId: string; displayName: string; kind: string; size: number }>; failed: number }>
    inspect(refId: string, scope: unknown): { fileRefId: string } | null
    resolveForOperation(refId: string, op: string, scope: unknown): Promise<{ fileRefId: string; realpath: string; kind: string; displayName: string; size: number } | null>
    size: number
  }
  const f = path.join(tmp, 'r4-file.txt')
  await fsp.writeFile(f, 'hello r4 file content', 'utf-8')
  const scopeA = { kind: 'session', sessionId: 'sess-A', draftId: 'current' }
  const scopeB = { kind: 'session', sessionId: 'sess-B', draftId: 'current' }

  const reg1 = new FileRefRegistry()
  const { refs: refs1 } = await reg1.register([f], scopeA, 'dialog')
  check('FILE-01 注册成功（fileRefId 生成）', refs1.length === 1 && refs1[0].fileRefId.length === 32)
  const pv1 = await reg1.resolveForOperation(refs1[0].fileRefId, 'preview', scopeA)
  check('FILE-01 预览（preview）成功', pv1 !== null && pv1.kind === 'file')
  const send1 = await reg1.resolveForOperation(refs1[0].fileRefId, 'read-for-model', scopeA)
  check('FILE-01 预览后 read-for-model 仍成功（身份不被消费）', send1 !== null, send1 === null ? '预览后引用失效' : '')

  const reg2 = new FileRefRegistry()
  const { refs: refs2 } = await reg2.register([f], scopeA, 'dialog')
  const view2 = reg2.inspect(refs2[0].fileRefId, scopeA)
  check('FILE-02 存在非消耗 inspect 接口且返回视图', view2 !== null && view2.fileRefId === refs2[0].fileRefId)
  const send2 = await reg2.resolveForOperation(refs2[0].fileRefId, 'read-for-model', scopeA)
  check('FILE-02 inspect 后 read-for-model 仍成功', send2 !== null)

  const reg3 = new FileRefRegistry()
  const { refs: refs3 } = await reg3.register([f], scopeA, 'dialog')
  reg3.inspect(refs3[0].fileRefId, scopeA) // 菜单展示
  const send3 = await reg3.resolveForOperation(refs3[0].fileRefId, 'read-for-model', scopeA)
  check('FILE-03 菜单 inspect（含复制路径场景）后发送仍成功', send3 !== null)

  const reg4 = new FileRefRegistry()
  const { refs: refs4 } = await reg4.register([f], scopeA, 'dialog')
  const attach4 = await reg4.resolveForOperation(refs4[0].fileRefId, 'attach-to-draft', scopeA)
  check('FILE-04 attach-to-draft 解析成功', attach4 !== null)
  const send4 = await reg4.resolveForOperation(refs4[0].fileRefId, 'read-for-model', scopeA)
  check('FILE-04 附加后发送仍成功', send4 !== null)

  const reg5 = new FileRefRegistry()
  const { refs: refs5 } = await reg5.register([f], scopeA, 'dialog')
  const wrong5 = await reg5.resolveForOperation(refs5[0].fileRefId, 'read-for-model', scopeB)
  check('FILE-05 跨 session scope 拒绝', wrong5 === null)
  const badScope5 = await reg5.resolveForOperation(refs5[0].fileRefId, 'read-for-model', { kind: 'run', sessionId: 'sess-A', runId: 'r1' })
  check('FILE-05 不同 scope 类型拒绝', badScope5 === null)
  check('FILE-05 引用未被跨 scope 尝试破坏（同 scope inspect 仍有效）', reg5.inspect(refs5[0].fileRefId, scopeA) !== null)

  const reg7 = new FileRefRegistry()
  const { refs: refs7 } = await reg7.register([f], scopeA, 'dialog')
  await new Promise((r) => setTimeout(r, 30))
  await fsp.writeFile(f, 'modified content after issue', 'utf-8')
  const read7 = await reg7.resolveForOperation(refs7[0].fileRefId, 'read-for-model', scopeA)
  check('FILE-07 文件内容变化后 read-for-model 拒绝（变化即作废）', read7 === null, read7 !== null ? '未检测内容变化' : '')

  const reg8 = new FileRefRegistry()
  const files8: string[] = []
  for (let i = 0; i < 510; i++) {
    const p = path.join(tmp, `f8-${i}.txt`)
    await fsp.writeFile(p, String(i), 'utf-8')
    files8.push(p)
  }
  const r8 = await reg8.register(files8, scopeA, 'dialog')
  check('FILE-08 批量 510 超上限 500 硬拒绝（failed ≥ 10）', r8.failed >= 10, `refs=${r8.refs.length} failed=${r8.failed}`)
  check('FILE-08 注册后容量不超上限', reg8.size <= 500, `size=${reg8.size}`)

  console.log('\n[R4-SEC] endpoint credential / permission off（R4-1 已修绿）')
  const schemas = await loadTsModule('src/shared/ipcSchemas.ts')
  const settingsSetSchema = schemas.settingsSetSchema as { safeParse(v: unknown): { success: boolean } }
  const evilWhole = settingsSetSchema.safeParse({ kind: 'whole', settings: { model: 'deepseek-v4-flash', baseUrl: 'https://evil.example.com/v1', apiKey: '__CONFIGURED__' } })
  check('SEC-01 非官方 origin 整份设置被拒绝', evilWhole.success === false)
  const okWhole = settingsSetSchema.safeParse({ kind: 'whole', settings: { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'k' } })
  check('SEC-01 官方 origin 允许', okWhole.success === true)
  const openCodeGo = settingsSetSchema.safeParse({ kind: 'whole', settings: { model: 'deepseek-v4-flash', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' } })
  check('SEC-01 OpenCode Go 精确兼容地址允许', openCodeGo.success === true)
  const openCodeWrongPath = settingsSetSchema.safeParse({ kind: 'whole', settings: { model: 'deepseek-v4-flash', baseUrl: 'https://opencode.ai/zen/go', apiKey: 'k' } })
  check('SEC-01 OpenCode Go 非精确路径拒绝', openCodeWrongPath.success === false)
  const openCodeQuery = settingsSetSchema.safeParse({ kind: 'whole', settings: { model: 'deepseek-v4-flash', baseUrl: 'https://opencode.ai/zen/go/v1?redirect=evil', apiKey: 'k' } })
  check('SEC-01 OpenCode Go query 变体拒绝', openCodeQuery.success === false)
  const openCodeLookalike = settingsSetSchema.safeParse({ kind: 'whole', settings: { model: 'deepseek-v4-flash', baseUrl: 'https://opencode.ai.evil.example/zen/go/v1', apiKey: 'k' } })
  check('SEC-01 OpenCode Go 相似域名拒绝', openCodeLookalike.success === false)
  const localWhole = settingsSetSchema.safeParse({ kind: 'whole', settings: { model: 'deepseek-v4-flash', baseUrl: 'http://127.0.0.1:18789', apiKey: 'k' } })
  check('SEC-01 本地开发端点允许', localWhole.success === true)
  const permissionsUpdateSchema = schemas.permissionsUpdateSchema as { safeParse(v: unknown): { success: boolean } }
  const offPerm = permissionsUpdateSchema.safeParse({ mode: 'off', rules: [] })
  check('SEC-02 permissions:update 直接提交 off 被 schema 拒绝', offPerm.success === false)
  const safePerm = permissionsUpdateSchema.safeParse({ mode: 'safe', rules: [] })
  check('SEC-02 safe 模式允许', safePerm.success === true)

  console.log('\n[R4-DB] 迁移 fail closed（DB-01 仍为红灯，R4-3 修）')
  const migrationsMod = await loadTsModule('src/main/db/migrations.ts')
  const openDb = migrationsMod.openDb as (p: string) => import('node:sqlite').DatabaseSync
  const SCHEMA_V1 = (await loadTsModule('src/main/db/schema.ts')).SCHEMA_V1 as string
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const dbDir = path.join(tmp, 'db-immutable')
  await fsp.mkdir(dbDir, { recursive: true })
  const legacyPath = path.join(dbDir, 'legacy.db')
  const legacy = new DatabaseSync(legacyPath)
  legacy.exec(SCHEMA_V1)
  legacy.exec('PRAGMA user_version = 1')
  legacy.prepare("INSERT INTO runs (run_id, session_id, status, phase, started_at, updated_at) VALUES ('r1','s1','completed','completed',1,1)").run()
  legacy.close()
  await fsp.mkdir(`${legacyPath}.pre-v1.bak`, { recursive: true }) // 占用备份目标 → VACUUM INTO 失败
  let db01Upgraded = false
  let db01Threw = false
  try {
    const db01 = openDb(legacyPath)
    const v = db01.prepare('PRAGMA user_version').get() as { user_version: number }
    db01Upgraded = v.user_version >= 2
    db01.close()
  } catch {
    db01Threw = true
  }
  check('DB-01 备份失败时有数据迁移不启动/不升级（红灯：当前 warn 后继续升级）', db01Upgraded === false, `升级=${db01Upgraded} threw=${db01Threw}`)

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4 回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('失败明细（修绿目标）：')
    for (const f2 of failures) console.log(`  - ${f2}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4 回归执行异常：', e)
  process.exit(2)
})
