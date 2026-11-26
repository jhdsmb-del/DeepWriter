const { deflateRawSync } = require('node:zlib')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const table = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function zip(entries) {
  const locals = [], central = []
  let offset = 0
  for (const item of entries) {
    const name = Buffer.isBuffer(item.name) ? item.name : Buffer.from(item.name), input = Buffer.from(item.text ?? item.bytes ?? '')
    const method = item.method ?? 8, payload = method === 8 ? deflateRawSync(input) : input, flags = item.flags ?? 0x800
    const crc = item.crc ?? crc32(input), size = item.size ?? input.length
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26)
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(payload.length, 20); cd.writeUInt32LE(size, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42)
    locals.push(local, name, payload); central.push(cd, name); offset += local.length + name.length + payload.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
const sourceEntry = 'src/中文目录/交接[杉+7].ts'
const prefix = Array.from({ length: 1300 }, (_, i) => `核对${i.toString(36)}🌊，`).join('')
const sourceQuote = 'export const custody = { keeper: "闻澜", cabinet: "青柜-812" }; // 交接[杉+7]实际保管结论'
function projectZip() {
  return zip([
    { name: '潮汐工程/README.md', text: '# 潮汐工程\n这是合成工程，不含真实用户材料。\n项目代号“潮汐档案”；启动入口是 src/main.ts。\n实际交接记录见 src/中文目录/交接[杉+7].ts，而不是旧记录。\n' },
    { name: '潮汐工程/package.json', text: JSON.stringify({ name: 'tidal-archive-fixture', scripts: { start: 'node src/main.ts' } }, null, 2) },
    { name: `潮汐工程/${sourceEntry}`, text: '// 开头说明用途，不包含实际保管人。\n' + prefix + sourceQuote + '\n' },
    { name: '潮汐工程/src/旧交接.ts', text: '// 相似诱饵，已废弃。\nexport const custody = { keeper: "旧名", cabinet: "旧柜-0" };\n' },
    ...Array.from({ length: 115 }, (_, i) => ({ name: `潮汐工程/src/parts/模块-${i}.py`, text: `# 合成模块${i}\nVALUE = ${i}\n` })),
    { name: '潮汐工程/assets/样图-a.bin', bytes: randomBytes(6_750_000), method: 0 },
    { name: '潮汐工程/assets/样图-b.bin', bytes: randomBytes(6_750_000), method: 0 },
    { name: '潮汐工程/vendor/嵌套.zip', bytes: zip([{ name: '不应递归.txt', text: '嵌套内容不自动读取' }]) }
  ])
}
async function createProjectFixture(directory) {
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, '潮汐工程-13.5MB.zip'), buffer = projectZip()
  await fs.writeFile(file, buffer)
  return { file, bytes: buffer.length, entries: 122, sourceEntry: `潮汐工程/${sourceEntry}`, sourceColumn: Array.from(prefix).length + 1, sourceQuote }
}
module.exports = { zip, projectZip, createProjectFixture, sourceEntry: `潮汐工程/${sourceEntry}`, sourceColumn: Array.from(prefix).length + 1, sourceQuote }
if (require.main === module) createProjectFixture(path.resolve(process.argv[2] || 'out/project-archive-fixture')).then(result => console.log(JSON.stringify(result, null, 2)))
