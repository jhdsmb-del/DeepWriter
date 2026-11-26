const ONE_MB = 1024 * 1024
const EPUB_MAX_ENTRIES = 500
const EPUB_MAX_UNCOMPRESSED = 200 * ONE_MB
const EPUB_MAX_SINGLE = 64 * ONE_MB
const EPUB_MAX_RATIO = 200

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
export function zipCrc32(buffer: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buffer) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
/**
 * ZIP 中央目录预检（Gate 1 / P0-08）：在 unzipSync 全量解压之前解析
 * End of Central Directory + Central Directory 条目，检查条目数、单条/总解压大小与压缩比。
 * 返回 null 表示通过；否则返回拒绝原因。任何异常一律拒绝（fail closed）。
 */
export function preflightZip(buf: Buffer, maxEntries = EPUB_MAX_ENTRIES, maxTotal = EPUB_MAX_UNCOMPRESSED, maxSingle = EPUB_MAX_SINGLE, maxRatio = EPUB_MAX_RATIO): string | null {
  try {
    const EOCD_SIG = 0x06054b50
    const CD_SIG = 0x02014b50
    const searchStart = Math.max(0, buf.length - 65557)
    let eocd = -1
    // 从末尾向前找 EOCD（最后 22 字节起，注释最长 65535）
    for (let i = buf.length - 22; i >= searchStart; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return 'ZIP 结构无效（未找到中央目录尾记录）'
    const totalEntries = buf.readUInt16LE(eocd + 10)
    const cdSize = buf.readUInt32LE(eocd + 12)
    const cdOffset = buf.readUInt32LE(eocd + 16)
    if (totalEntries > maxEntries) return `条目过多（${totalEntries} > ${maxEntries}）`
    if (cdOffset + cdSize > buf.length || cdSize > buf.length) return '中央目录越界'
    let total = 0
    let pos = cdOffset
    for (let i = 0; i < totalEntries; i++) {
      if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CD_SIG) return '中央目录条目损坏'
      const method = buf.readUInt16LE(pos + 10)
      const csize = buf.readUInt32LE(pos + 20)
      const usize = buf.readUInt32LE(pos + 24)
      const nameLen = buf.readUInt16LE(pos + 28)
      const extraLen = buf.readUInt16LE(pos + 30)
      const commentLen = buf.readUInt16LE(pos + 32)
      total += usize
      if (total > maxTotal) return `解压总大小超过限制（${Math.round(total / ONE_MB)}MB）`
      if (usize > maxSingle) return `单条目解压超过 ${Math.round(maxSingle / ONE_MB)}MB（${Math.round(usize / ONE_MB)}MB）`
      // 压缩比检查：仅对已压缩条目（method !== 0）生效；防超高压缩比 zip bomb
      if (method !== 0 && csize > 0 && usize / csize > maxRatio) return `压缩比异常（${(usize / csize).toFixed(1)}x > ${maxRatio}x，疑似 zip bomb）`
      pos += 46 + nameLen + extraLen + commentLen
      if (pos > buf.length) return '中央目录条目越界'
    }
    return null
  } catch {
    return 'ZIP 预检失败'
  }
}
