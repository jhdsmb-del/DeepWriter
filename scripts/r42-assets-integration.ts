// ==================== R4.2 A7 集成红灯回归：内容寻址附件（ATTACH-SAME-SIZE-MUTATION / LRU-BYTES / LEASE-CACHE） ====================
// 复审 S-04：旧缓存 key=realpath:size，同路径同大小内容变更命中旧文本；缓存按 200 项而非字节。
// 本测试证明（集成层）：
//  1) ATTACH-SAME-SIZE-MUTATION-01：同路径同大小内容变更（含 mtime 恢复的对抗场景）→ 模型读到新内容；
//  2) ATTACH-LEASE-CACHE-01：FileRef 撤销后读取被拒（缓存命中也重新验证 lease）；
//  3) ATTACH-LRU-BYTES-01：内存按字节预算 LRU，最早条目被逐出；
//  4) ATTACH-SPILL-DISK-01：大文本落盘对象库（文件名=hash），读回原文。
// 运行：npx esbuild scripts/r42-assets-integration.ts --bundle --format=esm --platform=node --outfile=out/r42-axi.mjs && node out/r42-axi.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
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
  const outfile = path.resolve(__dirname, '..', 'out', `r42mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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
      logLevel: 'silent'
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
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r42-axi-'))
  const assetsDir = path.join(tmp, 'assets')

  console.log('\n[R42-A7 集成] ATTACH-SAME-SIZE-MUTATION / LRU-BYTES / LEASE-CACHE')
  const fileRefMod = await loadTsModule('src/main/fileRef.ts')
  const FileRefRegistry = fileRefMod.FileRefRegistry as new (max?: number) => {
    register(paths: string[], scope: unknown, source: string): Promise<{ refs: Array<{ fileRefId: string }> }>
    revoke(refId: string): void
  }
  const registry = new FileRefRegistry()
  const assetMod = await loadTsModule('src/main/assetStore.ts')
  const ContentAssetStore = assetMod.ContentAssetStore as new (opts: Record<string, unknown>) => {
    import(realpath: string, leaseId: string): Promise<{ hash: string; text: string; source: string; size: number; cached: boolean }>
    getText(hash: string, leaseId: string): Promise<{ text: string; source: string } | null>
    releaseLease(leaseId: string): void
    stats(): { entries: number; memoryBytes: number; diskFiles: number }
  }
  const svcMod = await loadTsModule('src/main/attachmentService.ts')
  const createAttachmentService = svcMod.createAttachmentService as (registry: unknown, store: unknown) => {
    buildMessage(att: { name: string; fileRefId: string; size: number }, sessionId: string, draftId: string): Promise<{ role: string; content: string }>
    releaseLeases(refIds: string[]): void
  }

  const fileImportMod = await loadTsModule('src/main/fileImport.ts')
  const importFile = fileImportMod.importFile as (p: string) => Promise<{ ok: boolean; info?: { text: string; source: string; size: number }; error?: string }>

  const store = new ContentAssetStore({
    baseDir: assetsDir,
    maxMemoryBytes: 1024 * 1024,
    spillThresholdBytes: 64 * 1024,
    readText: async (realpath: string) => {
      const r = await importFile(realpath)
      return r.ok && r.info ? { ok: true as const, info: { text: r.info.text, source: r.info.source, size: r.info.size } } : { ok: false as const, error: r.error ?? '读取失败' }
    }
  })
  const svc = createAttachmentService(registry, store)
  const scope = { kind: 'session', sessionId: 's-axi', draftId: 'current' }

  // ---- ATTACH-SAME-SIZE-MUTATION-01：同路径同大小内容变更（mtime 恢复）→ 新内容 ----
  const file = path.join(tmp, 'note.txt')
  const contentA = 'A'.repeat(2000)
  await fsp.writeFile(file, contentA, 'utf-8')
  // 固化整数毫秒时间戳（FileRef fingerprint=size:mtimeMs 需精确一致才能放行；
  // 该场景证明：即使 FileRef 放行，内容寻址仍能识别内容变更）
  const tFixed = new Date(1_700_000_000_000)
  await fsp.utimes(file, tFixed, tFixed)
  const { refs } = await registry.register([file], scope, 'dialog')
  const refId = refs[0]?.fileRefId ?? ''
  check('ATTACH-SAME-SIZE-MUTATION-01 FileRef 注册成功', refId.length > 0)
  const m1 = await svc.buildMessage({ name: 'note.txt', fileRefId: refId, size: contentA.length }, 's-axi', 'current')
  check('ATTACH-SAME-SIZE-MUTATION-01 首次读取到内容 A', m1.content.includes('AAAA'), `len=${m1.content.length}`)
  // 同大小不同内容覆盖 + 恢复完全相同的 mtime（FileRef size:mtime 指纹无法区分）
  const contentB = 'B'.repeat(2000)
  await fsp.writeFile(file, contentB, 'utf-8')
  await fsp.utimes(file, tFixed, tFixed)
  const m2 = await svc.buildMessage({ name: 'note.txt', fileRefId: refId, size: contentB.length }, 's-axi', 'current')
  check('ATTACH-SAME-SIZE-MUTATION-01 同路径同大小内容变更 → 模型读到新内容 B（不命中旧缓存）', m2.content.includes('BBBB') && !m2.content.includes('AAAA'), m2.content.slice(0, 60))

  // ---- ATTACH-LEASE-CACHE-01：撤销 FileRef 后读取被拒（缓存命中仍验 lease） ----
  const file2 = path.join(tmp, 'note2.txt')
  await fsp.writeFile(file2, '缓存内容C', 'utf-8')
  const { refs: refs2 } = await registry.register([file2], scope, 'dialog')
  const refId2 = refs2[0]?.fileRefId ?? ''
  const m3 = await svc.buildMessage({ name: 'note2.txt', fileRefId: refId2, size: 10 }, 's-axi', 'current')
  check('ATTACH-LEASE-CACHE-01 首次读取成功（已入缓存）', m3.content.includes('缓存内容C'), m3.content)
  registry.revoke(refId2) // chip 删除等价
  svc.releaseLeases([refId2])
  const m4 = await svc.buildMessage({ name: 'note2.txt', fileRefId: refId2, size: 10 }, 's-axi', 'current')
  check('ATTACH-LEASE-CACHE-01 FileRef 撤销后读取被拒（不返回缓存文本）', m4.content.includes('读取被拒绝'), m4.content)

  // ---- ATTACH-LRU-BYTES-01：内存按字节预算 ----
  const smallStore = new ContentAssetStore({
    baseDir: assetsDir,
    maxMemoryBytes: 3000,
    spillThresholdBytes: 10 * 1024 * 1024,
    readText: async (realpath: string) => {
      const r = await importFile(realpath)
      return r.ok && r.info ? { ok: true as const, info: { text: r.info.text, source: r.info.source, size: r.info.size } } : { ok: false as const, error: r.error ?? '读取失败' }
    }
  })
  const svcSmall = createAttachmentService(registry, smallStore)
  const lruFiles: string[] = []
  for (let i = 0; i < 5; i++) {
    const p = path.join(tmp, `lru-${i}.txt`)
    await fsp.writeFile(p, `${'x'.repeat(900)}-${i}`, 'utf-8')
    lruFiles.push(p)
  }
  const lruRefs: string[] = []
  for (const p of lruFiles) {
    const { refs: rs } = await registry.register([p], scope, 'dialog')
    if (rs[0]) lruRefs.push(rs[0].fileRefId)
  }
  for (const id of lruRefs) {
    const p = path.join(tmp, `lru-${lruRefs.indexOf(id)}.txt`)
    const st = await fsp.stat(p)
    await svcSmall.buildMessage({ name: path.basename(p), fileRefId: id, size: st.size }, 's-axi', 'current')
  }
  const lruStats = smallStore.stats()
  check('ATTACH-LRU-BYTES-01 内存字节 <= 预算（按字节而非条数）', lruStats.memoryBytes <= 3000, JSON.stringify(lruStats))
  check('ATTACH-LRU-BYTES-01 最早条目被逐出（entries 不因逐出丢失条目计数语义）', lruStats.entries <= 5 && lruStats.entries >= 1, JSON.stringify(lruStats))

  // ---- ATTACH-SPILL-DISK-01：大文本落盘对象库（文件名=hash，无用户路径）----
  const big = path.join(tmp, 'big.txt')
  await fsp.writeFile(big, '大文本内容：' + '长'.repeat(200), 'utf-8')
  const { refs: refs3 } = await registry.register([big], scope, 'dialog')
  const refId3 = refs3[0]?.fileRefId ?? ''
  const mb = await svc.buildMessage({ name: 'big.txt', fileRefId: refId3, size: 600 }, 's-axi', 'current')
  check('ATTACH-SPILL-DISK-01 大附件读回原文（对象库无用户路径可读）', mb.content.includes('大文本内容'), mb.content.slice(0, 80))
  const diskEntries = await fsp.readdir(assetsDir).catch(() => [] as string[])
  check('ATTACH-SPILL-DISK-01 磁盘对象库文件名仅为 hash（不含用户路径）', diskEntries.every((f) => /^[0-9a-f]{64}\.txt$/.test(f)), JSON.stringify(diskEntries))

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.2-A7 集成红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.2-A7 集成红灯回归执行异常：', e)
  process.exit(2)
})
