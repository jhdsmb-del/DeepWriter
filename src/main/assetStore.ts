// ==================== R4.2 A7：内容寻址附件资产存储（ContentAssetStore） ====================
// 解决 S-04：buildAttachmentMessage 用 `realpath:size` 作缓存 key，同路径同大小内容变更会
// 命中旧缓存。本模块以内容寻址 + 按字节 LRU + 大文本落盘 + lease 绑定重构附件文本缓存。
// - 内容寻址：对文件原始字节流式 sha256，hash 是模型读取/解析缓存的唯一 key——
//   字节变 → hash 变 → 绝不命中旧缓存；
// - 按字节 LRU：内存只缓存提取文本（UTF-16 字节数 = length*2），超过 maxMemoryBytes
//   按 lastAccess 逐出最旧条目（逐出只清内存，磁盘副本保留）；
// - 大文本落盘：textSize > spillThresholdBytes 写 baseDir/<hash>.txt（文件名仅 hash，
//   无用户路径），内存只留摘要；getText 读回即进内存并参与 LRU，磁盘副本保留；
// - lease 绑定：import 隐式绑定 lease；getText 即使缓存命中也必须 leaseId 在条目
//   lease 集合内（缓存命中不等于授权）；lease 数归零后可被 LRU 逐出；
// - 错误不泄露：模块内任何 Error message 为固定文案，不含 realpath 或正文片段。
// 纯 Node 实现（不 import electron），主进程注入 readText（importFile 适配）即可使用。

import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import * as path from 'path'

export interface AssetMeta {
  hash: string // sha256（对文件原始字节计算，不是提取文本）
  size: number // 原始文件字节数
  textSize: number // 提取文本字符数
  source: string // 透传 importFile 的 source 字段（utf8/gbk/docx/...）
  importedAt: number
  lastAccess: number
  memory: boolean // 当前是否在内存缓存
  disk: boolean // 当前是否在磁盘对象库
}

export interface AssetStoreOpts {
  baseDir: string // 磁盘对象库根目录（主进程会传 userData/assets）
  maxMemoryBytes: number // 内存字节预算（默认 32*1024*1024）
  spillThresholdBytes: number // 超过该字节数的文本落盘（默认 512*1024）
  readText: (realpath: string) => Promise<{ ok: true; info: { text: string; source: string; size: number } } | { ok: false; error: string }>
}

/** 条目内部状态：text 仅在 memory 时驻留；disk 条目保留 baseDir/<hash>.txt 副本 */
interface AssetEntry {
  hash: string
  size: number
  textSize: number
  source: string
  importedAt: number
  lastAccess: number
  memory: boolean
  disk: boolean
  text: string | null
  leases: Set<string>
}

const DEFAULT_MAX_MEMORY_BYTES = 32 * 1024 * 1024
const DEFAULT_SPILL_THRESHOLD_BYTES = 512 * 1024

/** 对文件原始字节流式计算 sha256（不整体载入内存；50MB 上限由调用方保证） */
async function sha256File(p: string): Promise<string> {
  const h = createHash('sha256')
  const stream = createReadStream(p)
  for await (const chunk of stream) h.update(chunk as Buffer)
  return h.digest('hex')
}

export class ContentAssetStore {
  private readonly opts: AssetStoreOpts
  private entries = new Map<string, AssetEntry>()
  private leaseIndex = new Map<string, Set<string>>() // leaseId → hash 集合（releaseLease 反查）
  private memoryBytes = 0

  constructor(opts: AssetStoreOpts) {
    this.opts = {
      ...opts,
      maxMemoryBytes: opts.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES,
      spillThresholdBytes: opts.spillThresholdBytes ?? DEFAULT_SPILL_THRESHOLD_BYTES
    }
  }

  /**
   * 导入：读原始字节算 sha256 → readText 提取文本 → 内容寻址缓存。
   * 同 hash 已存在则只刷新 lease 与访问时间（cached=true）。
   */
  async import(realpath: string, leaseId: string): Promise<{ hash: string; text: string; source: string; size: number; cached: boolean }> {
    // 1) 原始字节哈希：失败抛固定文案（不泄露路径）
    let hash: string
    try {
      hash = await sha256File(realpath)
    } catch {
      throw new Error('附件读取失败')
    }
    // 2) 提取文本：readText 由调用方注入；失败不透传其 error（防路径/正文外泄）
    const r = await this.opts.readText(realpath)
    if (!r.ok) throw new Error('附件解析失败')
    const { text, source, size } = r.info
    // 3) 内容寻址：同 hash 命中 → 只刷新 lease 与访问时间
    const existing = this.entries.get(hash)
    if (existing) {
      this.addLease(existing, hash, leaseId)
      existing.lastAccess = Date.now()
      if (existing.memory && existing.text !== null) {
        return { hash, text: existing.text, source: existing.source, size: existing.size, cached: true }
      }
      if (existing.disk) {
        const t = await this.readDisk(hash)
        if (t !== null) {
          this.setMemory(existing, t) // 读回即进内存缓存并参与 LRU；磁盘副本保留
          this.evict(hash)
          return { hash, text: t, source: existing.source, size: existing.size, cached: true }
        }
        // 磁盘副本缺失 → 条目失效，走重建
      }
      this.deleteEntry(hash)
    }
    // 4) 新条目
    const now = Date.now()
    const entry: AssetEntry = {
      hash,
      size,
      textSize: text.length,
      source,
      importedAt: now,
      lastAccess: now,
      memory: false,
      disk: false,
      text: null,
      leases: new Set()
    }
    this.entries.set(hash, entry)
    this.addLease(entry, hash, leaseId) // import 隐式绑定 lease
    if (text.length > this.opts.spillThresholdBytes) {
      if (await this.writeDisk(hash, text)) {
        entry.disk = true // 内存只保留摘要（meta）
      } else {
        this.setMemory(entry, text) // 落盘失败回退内存（不抛错、不泄露路径）
      }
    } else {
      this.setMemory(entry, text)
    }
    this.evict(hash)
    return { hash, text, source, size, cached: false }
  }

  /** 取文本：hash 命中且 leaseId 有效才返回（缓存命中也必须验证 lease）；miss 返回 null */
  async getText(hash: string, leaseId: string): Promise<{ text: string; source: string } | null> {
    const e = this.entries.get(hash)
    if (!e) return null
    if (!e.leases.has(leaseId)) return null // 缓存命中不等于授权
    e.lastAccess = Date.now()
    if (e.memory && e.text !== null) return { text: e.text, source: e.source }
    if (e.disk) {
      const t = await this.readDisk(hash)
      if (t === null) {
        this.deleteEntry(hash) // 磁盘副本缺失 → 条目不可用
        return null
      }
      this.setMemory(e, t) // 读回即进内存缓存并参与 LRU；磁盘副本保留
      this.evict(hash)
      return { text: t, source: e.source }
    }
    return null
  }

  /** 绑定 lease 到条目（import 已隐式绑定；用于恢复场景） */
  bindLease(hash: string, leaseId: string): void {
    const e = this.entries.get(hash)
    if (!e) return
    this.addLease(e, hash, leaseId)
  }

  /** 释放 lease（run terminal/chip 删除）；条目 lease 数归零后可被 LRU 逐出 */
  releaseLease(leaseId: string): void {
    const hashes = this.leaseIndex.get(leaseId)
    if (!hashes) return
    for (const h of hashes) {
      const e = this.entries.get(h)
      if (e) e.leases.delete(leaseId)
    }
    this.leaseIndex.delete(leaseId)
  }

  hasLease(hash: string, leaseId: string): boolean {
    return this.entries.get(hash)?.leases.has(leaseId) ?? false
  }

  getMeta(hash: string): AssetMeta | null {
    const e = this.entries.get(hash)
    if (!e) return null
    return {
      hash: e.hash,
      size: e.size,
      textSize: e.textSize,
      source: e.source,
      importedAt: e.importedAt,
      lastAccess: e.lastAccess,
      memory: e.memory,
      disk: e.disk
    }
  }

  stats(): { entries: number; memoryBytes: number; diskFiles: number } {
    let diskFiles = 0
    for (const e of this.entries.values()) if (e.disk) diskFiles++
    return { entries: this.entries.size, memoryBytes: this.memoryBytes, diskFiles }
  }

  /** 清空内存结构（磁盘对象库为内容寻址文件，文件名仅 hash，孤儿文件无害） */
  clear(): void {
    for (const e of this.entries.values()) this.dropFromMemory(e)
    this.entries.clear()
    this.leaseIndex.clear()
  }

  // ---------------- 内部实现 ----------------

  private diskFilePath(hash: string): string {
    return path.join(this.opts.baseDir, hash + '.txt')
  }

  /** 落盘（自动建目录）；失败返回 false 由调用方回退内存，不抛错、不泄露路径 */
  private async writeDisk(hash: string, text: string): Promise<boolean> {
    try {
      await fs.mkdir(this.opts.baseDir, { recursive: true })
      await fs.writeFile(this.diskFilePath(hash), text, 'utf-8')
      return true
    } catch {
      return false
    }
  }

  /** 磁盘读回；文件缺失/读取失败返回 null */
  private async readDisk(hash: string): Promise<string | null> {
    try {
      return await fs.readFile(this.diskFilePath(hash), 'utf-8')
    } catch {
      return null
    }
  }

  private addLease(e: AssetEntry, hash: string, leaseId: string): void {
    e.leases.add(leaseId)
    let s = this.leaseIndex.get(leaseId)
    if (!s) {
      s = new Set()
      this.leaseIndex.set(leaseId, s)
    }
    s.add(hash)
  }

  /** 置入内存并记账（UTF-16 字节数 = length*2） */
  private setMemory(e: AssetEntry, text: string): void {
    e.text = text
    e.memory = true
    this.memoryBytes += text.length * 2
  }

  /** 清出内存（磁盘副本若存在则保留） */
  private dropFromMemory(e: AssetEntry): void {
    if (!e.memory || e.text === null) return
    this.memoryBytes -= e.text.length * 2
    e.text = null
    e.memory = false
  }

  /**
   * 按字节预算逐出：优先逐出 lastAccess 最旧且非本次操作 keepHash 的条目；
   * 单条目本身超预算时也允许逐出 keepHash（防内存无上限）。
   */
  private evict(keepHash?: string): void {
    while (this.memoryBytes > this.opts.maxMemoryBytes) {
      const inMemory = [...this.entries.values()].filter((e) => e.memory)
      if (inMemory.length === 0) return
      inMemory.sort((a, b) => a.lastAccess - b.lastAccess)
      const victim = inMemory.find((e) => e.hash !== keepHash) ?? inMemory[0]
      this.dropFromMemory(victim)
    }
  }

  /** 删除条目：清内存记账 + 从 leaseIndex 摘除引用 */
  private deleteEntry(hash: string): void {
    const e = this.entries.get(hash)
    if (!e) return
    this.dropFromMemory(e)
    for (const leaseId of e.leases) {
      const s = this.leaseIndex.get(leaseId)
      if (s) {
        s.delete(hash)
        if (s.size === 0) this.leaseIndex.delete(leaseId)
      }
    }
    this.entries.delete(hash)
  }
}
