// ==================== R4.2 Task A7：内容寻址附件资产存储（ContentAssetStore） ====================
// 覆盖：ATTACH-SAME-SIZE-MUTATION-01 / ATTACH-LRU-BYTES-01 / ATTACH-LEASE-CACHE-01 /
//       ATTACH-SPILL-DISK-01 / ATTACH-NO-LEAK-01
// 目标：修复 S-04（`realpath:size` 缓存 key 在同路径同大小内容变更时命中旧缓存）——
//       内容寻址 + 按字节 LRU + 大文本落盘 + lease 绑定。
// 运行：npx esbuild scripts/r42-assets.ts --bundle --format=esm --platform=node --outfile=out/r42-assets.mjs && node out/r42-assets.mjs

import * as path from 'node:path'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { ContentAssetStore } from '../src/main/assetStore'

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

/** 测试用 readText：读文件 UTF-8 解码（与主进程 importFile 文本路径等效的注入实现） */
function fileReadText(realpath: string): Promise<{ ok: true; info: { text: string; source: string; size: number } } | { ok: false; error: string }> {
  return fsp
    .readFile(realpath)
    .then((buf) => ({ ok: true as const, info: { text: buf.toString('utf-8'), source: 'utf8', size: buf.length } }))
    .catch(() => ({ ok: false as const, error: '读取失败' }))
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r42-'))

  console.log('\n[R42-A7-01] 内容寻址：同路径同大小内容变更（ATTACH-SAME-SIZE-MUTATION-01）')
  {
    const base = path.join(tmp, 'assets-mut')
    const store = new ContentAssetStore({ baseDir: base, maxMemoryBytes: 32 * 1024 * 1024, spillThresholdBytes: 10 * 1024 * 1024, readText: fileReadText })
    const p = path.join(tmp, 'mut.txt')
    await fsp.writeFile(p, 'A'.repeat(1000), 'utf-8')
    const r1 = await store.import(p, 'lease-1')
    await fsp.writeFile(p, 'B'.repeat(1000), 'utf-8') // 同路径、完全相同长度、内容不同
    const r2 = await store.import(p, 'lease-1')
    check('ATTACH-SAME-SIZE-MUTATION-01 字节变 → hash 变（绝不命中旧缓存）', r2.hash !== r1.hash && r2.cached === false, `h1=${r1.hash} h2=${r2.hash}`)
    const t2 = await store.getText(r2.hash, 'lease-1')
    check('ATTACH-SAME-SIZE-MUTATION-01 getText(hash2) 返回新文本', t2?.text === 'B'.repeat(1000), `实际=${t2?.text.slice(0, 8)}…`)
    const t1 = await store.getText(r1.hash, 'lease-1')
    check('ATTACH-SAME-SIZE-MUTATION-01 getText(hash1) 仍返回旧文本（互不污染）', t1?.text === 'A'.repeat(1000), `实际=${t1?.text.slice(0, 8)}…`)
  }

  console.log('\n[R42-A7-02] 内存字节预算 LRU（ATTACH-LRU-BYTES-01）')
  {
    const base = path.join(tmp, 'assets-lru')
    const store = new ContentAssetStore({ baseDir: base, maxMemoryBytes: 4000, spillThresholdBytes: 10 * 1024 * 1024, readText: fileReadText })
    const hashes: string[] = []
    for (let i = 0; i < 5; i++) {
      const p = path.join(tmp, `lru-${i}.txt`)
      await fsp.writeFile(p, String(i).repeat(1500), 'utf-8') // 5 个不同内容，各 1500 字符 = 3000 UTF-16 字节
      const r = await store.import(p, 'lease-lru')
      hashes.push(r.hash)
    }
    const st = store.stats()
    check('ATTACH-LRU-BYTES-01 内存预算生效（memoryBytes <= 4000）', st.memoryBytes <= 4000, `memoryBytes=${st.memoryBytes}`)
    check('ATTACH-LRU-BYTES-01 条目不因逐出丢失（entries=5）', st.entries === 5, `entries=${st.entries}`)
    check('ATTACH-LRU-BYTES-01 最早导入条目被逐出（memory=false）', store.getMeta(hashes[0])?.memory === false, '')
    check('ATTACH-LRU-BYTES-01 最近导入条目仍在内存（memory=true）', store.getMeta(hashes[4])?.memory === true, '')
    const evicted = await store.getText(hashes[0], 'lease-lru')
    check('ATTACH-LRU-BYTES-01 被逐出条目（lease 有效）getText 返回 null', evicted === null, `实际=${JSON.stringify(evicted)?.slice(0, 30)}`)
    const recent = await store.getText(hashes[4], 'lease-lru')
    check('ATTACH-LRU-BYTES-01 内存条目仍可读', recent?.text === '4'.repeat(1500), '')
  }

  console.log('\n[R42-A7-03] lease 绑定：缓存命中也必须验证（ATTACH-LEASE-CACHE-01）')
  {
    const base = path.join(tmp, 'assets-lease')
    const store = new ContentAssetStore({ baseDir: base, maxMemoryBytes: 32 * 1024 * 1024, spillThresholdBytes: 10 * 1024 * 1024, readText: fileReadText })
    const p = path.join(tmp, 'lease.txt')
    await fsp.writeFile(p, 'lease-content', 'utf-8')
    const r1 = await store.import(p, 'leaseA')
    const r2 = await store.import(p, 'leaseA')
    check('ATTACH-LEASE-CACHE-01 同 hash 二次导入 cached=true（首次 false）', r1.cached === false && r2.cached === true, `c1=${r1.cached} c2=${r2.cached}`)
    const before = await store.getText(r1.hash, 'leaseA')
    check('ATTACH-LEASE-CACHE-01 lease 有效时可读', before?.text === 'lease-content', '')
    store.releaseLease('leaseA')
    const afterRelease = await store.getText(r1.hash, 'leaseA')
    check('ATTACH-LEASE-CACHE-01 releaseLease 后缓存命中仍须 lease 有效 → null', afterRelease === null, `实际=${JSON.stringify(afterRelease)?.slice(0, 30)}`)
    const unbound = await store.getText(r1.hash, 'leaseB')
    check('ATTACH-LEASE-CACHE-01 未绑定 lease 无授权 → null', unbound === null, '')
    check('ATTACH-LEASE-CACHE-01 hasLease 语义正确', store.hasLease(r1.hash, 'leaseA') === false && store.hasLease(r1.hash, 'leaseB') === false, '')
    store.bindLease(r1.hash, 'leaseB')
    const bound = await store.getText(r1.hash, 'leaseB')
    check('ATTACH-LEASE-CACHE-01 bindLease 后恢复可读', bound?.text === 'lease-content' && store.hasLease(r1.hash, 'leaseB') === true, '')
  }

  console.log('\n[R42-A7-04] 大文本落盘（ATTACH-SPILL-DISK-01）')
  {
    const base = path.join(tmp, 'assets-spill')
    const store = new ContentAssetStore({ baseDir: base, maxMemoryBytes: 32 * 1024 * 1024, spillThresholdBytes: 200, readText: fileReadText })
    const p = path.join(tmp, 'spill.txt')
    const content = 's'.repeat(500)
    await fsp.writeFile(p, content, 'utf-8')
    const r = await store.import(p, 'lease-spill')
    const meta = store.getMeta(r.hash)
    check('ATTACH-SPILL-DISK-01 大文本落盘（meta.disk=true）', meta?.disk === true, `disk=${meta?.disk}`)
    check('ATTACH-SPILL-DISK-01 落盘后内存只保留摘要（meta.memory=false）', meta?.memory === false, `memory=${meta?.memory}`)
    const diskFile = path.join(base, r.hash + '.txt')
    const onDisk = await fsp.readFile(diskFile, 'utf-8').catch(() => null)
    check('ATTACH-SPILL-DISK-01 磁盘对象库文件存在（文件名仅 hash，无用户路径）', onDisk !== null && onDisk === content, `file=${diskFile}`)
    const t = await store.getText(r.hash, 'lease-spill')
    check('ATTACH-SPILL-DISK-01 从磁盘读回原文', t?.text === content, `实际=${t?.text.slice(0, 8)}…`)
    const m2 = store.getMeta(r.hash)
    check('ATTACH-SPILL-DISK-01 读回进内存缓存且磁盘副本保留', m2?.memory === true && m2?.disk === true, `memory=${m2?.memory} disk=${m2?.disk}`)
    const st = store.stats()
    check('ATTACH-SPILL-DISK-01 stats 统计磁盘文件数', st.diskFiles === 1, `diskFiles=${st.diskFiles}`)
  }

  console.log('\n[R42-A7-05] 错误不泄露路径（ATTACH-NO-LEAK-01）')
  {
    const base = path.join(tmp, 'assets-noleak')
    const store = new ContentAssetStore({
      baseDir: base,
      maxMemoryBytes: 32 * 1024 * 1024,
      spillThresholdBytes: 10 * 1024 * 1024,
      readText: async () => ({ ok: false as const, error: '读取失败' })
    })
    const p = path.join(tmp, 'secret-dir', 'secret-file.txt')
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, 'top secret', 'utf-8')
    let errMsg = ''
    try {
      await store.import(p, 'lease-x')
    } catch (e) {
      errMsg = (e as Error).message
    }
    check('ATTACH-NO-LEAK-01 解析失败抛出错误', errMsg.length > 0, '')
    check('ATTACH-NO-LEAK-01 错误消息不含 realpath', errMsg.length > 0 && !errMsg.includes(p), `msg="${errMsg}"`)
  }

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.2 A7 资产存储回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('失败明细：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.2 A7 资产存储回归执行异常：', e)
  process.exit(2)
})
