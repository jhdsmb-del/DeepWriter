const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { writeZip, verifyZipBytes } = require('./assemble-complete-release.cjs')

test('embedded ZIP descriptor bytes in an executable cannot truncate archive verification', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-zip-signature-'))
  try {
    const bytes = Buffer.concat([Buffer.from('MZfixture'), Buffer.alloc(60000, 120), Buffer.from('504b0708000000000000000000000000', 'hex'), Buffer.alloc(60000, 121)])
    const entry = { name: 'desktop/fixture.exe', bytes, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    const archive = path.join(directory, 'complete.zip')
    await writeZip(archive, [entry])
    assert.deepEqual(await verifyZipBytes(archive, [entry]), { verifiedMembers: 1 })
    const corrupt = await fs.readFile(archive)
    const payload = 30 + corrupt.readUInt16LE(26) + corrupt.readUInt16LE(28)
    corrupt[payload + 25] ^= 1
    const damaged = path.join(directory, 'damaged.zip')
    await fs.writeFile(damaged, corrupt)
    await assert.rejects(verifyZipBytes(damaged, [entry]))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
