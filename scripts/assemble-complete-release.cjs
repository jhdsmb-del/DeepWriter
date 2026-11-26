'use strict'
const { exampleMembers } = require('./release-examples.cjs')

// Assemble verified inputs, never build them or walk unrelated directories.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { packedArchiveAssets } = require('./native-notice-resources.cjs')
const { packedArchiveAssets: packedPublisherAssets } = require('./package-notice-resources.cjs')
const { electronRuntimeNoticeNames } = require('./distribution-inventory.cjs')
const { execFileSync } = require('node:child_process')
const { Zip, ZipPassThrough } = require('fflate')
const { createInflateRaw } = require('node:zlib')
const { verifyOfficialRelease, hashFile } = require('./prepare-release.cjs')
const ROOT = path.resolve(__dirname, '..')
const HASH = /^[a-f0-9]{64}$/
const LIMIT = 2 * 1024 * 1024 * 1024
const TEXT_LIMIT = 64 * 1024 * 1024
const DOCUMENTS = ['QUICKSTART.md', 'PRIVACY.md', 'OPERATIONS.md', 'CLI.md', 'VALIDATION.md', 'LICENSE_DECISION.md', 'EXTENSIONS_RESEARCH.md', 'PROVIDER_EXPANSION_RESEARCH.md']
const FORBIDDEN = /^(?:userData|work|scratch|tmp|node_modules|\.git|\.aws|\.codex|pnpm(?:[-.].*)?|credentials?(?:[._-].*)?|keys?(?:[._-].*)?|settings(?:[._-].*)?|\.env(?:\..*)?)$/i
const PRIVATE_EXTENSION = /\.(?:key|pem|pfx|p12|db(?:-wal|-shm|-journal)?|sqlite3?|jsonl|log)$/i
const SECRET = /sk-[A-Za-z0-9_-]{32,}|["']?apiKeyEnc["']?\s*:\s*["'][^"']{2,}["']/

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function safeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || /[<>:"|?*\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.endsWith('/') || SECRET.test(name)) throw new Error('Unsafe archive member path')
  const parts = name.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || FORBIDDEN.test(part) || /[ .]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) || PRIVATE_EXTENSION.test(name)) throw new Error('Private or unsafe archive member path rejected')
  return name
}
function securePath(base, name) {
  safeName(name)
  base = path.resolve(base)
  if (!fs.lstatSync(base).isDirectory() || fs.lstatSync(base).isSymbolicLink()) throw new Error('Input directory must be a real directory')
  let target = base
  for (const part of name.split('/')) {
    target = path.join(target, part)
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Linked input resource rejected')
  }
  return target
}
function readResource(base, name, limit = TEXT_LIMIT) {
  const file = securePath(base, name)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size > limit || stat.size === 0) throw new Error('Required resource must be a nonempty bounded regular file')
  const bytes = fs.readFileSync(file)
  if (bytes.length !== stat.size || bytes.length > limit) throw new Error('Resource changed while reading')
  return bytes
}
function assertFileEntry(entry) {
  if (!entry || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > LIMIT || !HASH.test(entry.sha256 || '')) throw new Error('Invalid manifest file receipt')
  safeName(entry.name)
}
async function member(base, relative, name, receipt) {
  safeName(name)
  const file = securePath(base, relative)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size <= 0 || stat.size > LIMIT) throw new Error('Archive input must be a nonempty bounded regular file')
  const hash = await hashFile(file)
  if (receipt && (receipt.size !== stat.size || receipt.sha256 !== hash)) throw new Error('Manifest does not match actual input bytes')
  return { name, size: stat.size, sha256: hash, file }
}
function sameReceipt(resource, entry) { return resource && entry && resource.sha256 === entry.sha256 && resource.size === entry.size }
function peExecutable(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const header = Buffer.alloc(2)
    if (fs.fstatSync(fd).size < 1024 * 1024 || fs.readSync(fd, header, 0, 2, 0) !== 2 || header.toString() !== 'MZ') throw new Error('Runtime is not a Windows executable')
  } finally { fs.closeSync(fd) }
}

async function collectCompleteInputs(options) {
  const root = path.resolve(options.root || ROOT)
  const pkgBytes = readResource(root, 'package.json', 1024 * 1024)
  const pkg = JSON.parse(pkgBytes)
  const version = pkg.version
  const sourceCommit = options.sourceCommit || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid complete release identity')
  if (!options.releaseDir) throw new Error('A verified desktop release directory is required')
  const releaseDir = path.resolve(root, options.releaseDir)
  const desktop = await verifyOfficialRelease(releaseDir, `v${version}`, sourceCommit)
  if (options.desktopOnly) return { root, version, sourceCommit, complete: false, diagnosticOnly: true, desktop, members: [] }
  if (!options.cliDir || !options.inventory || !options.notices || !options.electronDir) throw new Error('Complete release requires built CLI, actual desktop inventory, notices and Electron resources')
  const members = []
  for (const entry of desktop.files) {
    const item = await member(releaseDir, entry.name, `desktop/${entry.name}`, entry)
    if (entry.name === `DeepWriter-${version}-x64-setup.exe` || entry.name === `DeepWriter-${version}-x64-portable.exe`) peExecutable(item.file)
    members.push(item)
  }
  for (const name of ['release.json', 'SHA256SUMS.txt']) members.push(await member(releaseDir, name, `desktop/${name}`))
  const projectLicense = await member(root, 'LICENSE', 'LICENSE')
  members.push(projectLicense)
  const docsDir = path.resolve(root, options.docsDir || 'docs')
  for (const name of DOCUMENTS) members.push(await member(docsDir, name, `docs/${name}`))
  for (const name of exampleMembers(version)) members.push(await member(root, name, name))
  if (exampleMembers(version).length) members.push(await member(docsDir, `RELEASE_NOTES_${version}.md`, `docs/RELEASE_NOTES_${version}.md`))
  members.push(await member(root, 'PACKAGE_README.md', 'README.md'))
  members.push(await member(root, 'SECURITY.md', 'SECURITY.md'))

  const inventoryPath = path.resolve(root, options.inventory)
  const inventoryBytes = readResource(path.dirname(inventoryPath), path.basename(inventoryPath))
  const inventory = JSON.parse(inventoryBytes)
  if (inventory.application?.name !== pkg.name || inventory.application?.version !== version || inventory.inventoryComplete !== true || !Array.isArray(inventory.reviewNeeded) || inventory.reviewNeeded.length || !inventory.actual || !HASH.test(inventory.actual.archiveSha256 || '') || inventory.source?.packageSha256 !== sha(pkgBytes) || inventory.source?.lockSha256 !== sha(readResource(root, 'package-lock.json', 8 * 1024 * 1024))) throw new Error('Desktop inventory is incomplete or stale')
  if (!sameReceipt(inventory.projectLicense?.sourceResource, projectLicense)) throw new Error('Project license differs from the actual inventory resource')
  const electronDir = path.resolve(root, options.electronDir)
  const archive = securePath(electronDir, 'resources/app.asar')
  if (await hashFile(archive) !== inventory.actual.archiveSha256) throw new Error('Desktop inventory does not match actual ASAR')
  if (inventory.actual.nativeNoticeSupplements?.length || inventory.actual.packages?.some(entry => entry.name === '@napi-rs/canvas-win32-x64-msvc')) {
    members.push(...packedArchiveAssets(archive, JSON.parse(readResource(root, 'package-lock.json', 8 * 1024 * 1024)), inventory))
  }
  if (inventory.actual.packageNoticeSupplements?.length) members.push(...packedPublisherAssets(archive, JSON.parse(readResource(root, 'package-lock.json', 8 * 1024 * 1024)), inventory, root))
  const runtimeNoticeNames = electronRuntimeNoticeNames(inventory.actual.runtimeNotices)
  const actualLicenseNames = ['LICENSE', 'LICENSE.electron.txt'].filter(name => fs.existsSync(path.join(electronDir, name)))
  if (actualLicenseNames.length !== 1 || actualLicenseNames[0] !== runtimeNoticeNames[0]) throw new Error('Desktop runtime notice filename is missing, ambiguous or differs from actual inventory')
  for (const name of runtimeNoticeNames) {
    const entry = await member(electronDir, name, `runtime/electron/${name}`)
    if (!sameReceipt(inventory.actual.runtimeNotices?.find(item => item.name === name), entry)) throw new Error('Desktop runtime notice differs from actual inventory')
    members.push(entry)
  }
  members.push(await member(path.dirname(inventoryPath), path.basename(inventoryPath), 'distribution-inventory.json'))
  const noticePath = path.resolve(root, options.notices)
  const desktopNotices = await member(path.dirname(noticePath), path.basename(noticePath), 'THIRD_PARTY_NOTICES.txt')
  if (!sameReceipt(inventory.notices, desktopNotices)) throw new Error('Desktop third-party notices differ from the actual inventory receipt')
  members.push(desktopNotices)

  const cliDir = path.resolve(root, options.cliDir)
  const cliBytes = readResource(cliDir, 'cli-release.json', 8 * 1024 * 1024)
  const cli = JSON.parse(cliBytes)
  if (cli.name !== 'deepwriter-cli' || cli.version !== version || cli.sourceCommit !== sourceCommit || cli.runtime?.name !== 'node' || cli.runtime?.platform !== 'win32' || cli.runtime?.arch !== 'x64' || !/^\d+\.\d+\.\d+$/.test(cli.runtime?.version || '') || !Array.isArray(cli.files) || cli.files.length === 0 || cli.files.length > 4096) throw new Error('CLI artifact identity or runtime differs from complete release')
  const runtimeVersion = cli.runtime.version.split('.').map(Number)
  if (runtimeVersion[0] < 22 || (runtimeVersion[0] === 22 && runtimeVersion[1] < 13)) throw new Error('CLI Node runtime must satisfy the application minimum')
  const required = [cli.entrypoint, cli.runtime.executable, cli.runtime.license, cli.inventory, cli.notices]
  required.forEach(safeName)
  if (new Set(required).size !== required.length) throw new Error('CLI entrypoint and required resources must be distinct')
  const entries = new Map()
  for (const entry of cli.files) {
    assertFileEntry(entry)
    const key = entry.name.toLowerCase()
    if (entries.has(key) || key === 'cli-release.json') throw new Error('CLI contains duplicate or reserved manifest file entries')
    entries.set(key, entry)
    members.push(await member(cliDir, entry.name, `cli/${entry.name}`, entry))
  }
  if (required.some(name => !entries.has(name.toLowerCase()))) throw new Error('CLI manifest omits a required bundled runtime resource')
  peExecutable(securePath(cliDir, cli.runtime.executable))
  const cliInventory = JSON.parse(readResource(cliDir, cli.inventory, 8 * 1024 * 1024))
  if (cliInventory.application?.name !== 'deepwriter-cli' || cliInventory.application?.version !== version || cliInventory.sourceCommit !== sourceCommit || cliInventory.inventoryComplete !== true || !Array.isArray(cliInventory.reviewNeeded) || cliInventory.reviewNeeded.length || cliInventory.runtime?.name !== 'node' || cliInventory.runtime?.version !== cli.runtime.version || cliInventory.runtime?.executableSha256 !== entries.get(cli.runtime.executable.toLowerCase()).sha256 || !Array.isArray(cliInventory.files)) throw new Error('CLI inventory is incomplete or stale')
  for (const name of [cli.entrypoint, cli.runtime.executable, cli.runtime.license, cli.notices]) {
    const records = cliInventory.files.filter(item => item.name === name)
    if (records.length !== 1 || !sameReceipt(records[0], entries.get(name.toLowerCase()))) throw new Error('CLI inventory does not bind the actual bundle and runtime resources')
  }
  members.push(await member(cliDir, 'cli-release.json', 'cli/cli-release.json'))
  const names = members.map(entry => entry.name.toLowerCase())
  if (new Set(names).size !== names.length) throw new Error('Complete archive contains duplicate paths')
  if (members.reduce((sum, entry) => sum + entry.size, 0) > 3 * 1024 * 1024 * 1024) throw new Error('Complete archive exceeds the ZIP32 safety limit')
  return { root, version, sourceCommit, complete: true, members: members.sort((a, b) => a.name.localeCompare(b.name)), desktop, cli }
}

async function writeZip(file, members) {
  const fd = fs.openSync(file, 'wx', 0o600)
  let failure
  let ended = false
  const zipper = new Zip((error, data, final) => {
    if (error) { failure = error; return }
    try { let offset = 0; while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset) } catch (error) { failure = error }
    if (final) ended = true
  })
  try {
    for (const entry of members) {
      const input = new ZipPassThrough(entry.name)
      input.mtime = new Date('2020-01-01T00:00:00Z')
      zipper.add(input)
      const hash = crypto.createHash('sha256')
      let size = 0
      let tail = ''
      const chunks = entry.bytes ? [entry.bytes] : fs.createReadStream(entry.file, { highWaterMark: 1024 * 1024 })
      for await (const chunk of chunks) {
        size += chunk.length
        if (size > entry.size) throw new Error('Archive source changed during assembly')
        hash.update(chunk)
        const diagnosticText = tail + Buffer.from(chunk).toString('latin1')
        if (SECRET.test(diagnosticText)) throw new Error('Sensitive credential pattern detected; content is not logged')
        tail = diagnosticText.slice(-512)
        input.push(chunk)
        if (failure) throw failure
      }
      if (size !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error('Archive source bytes differ from the verified receipt')
      input.push(new Uint8Array(), true)
    }
    zipper.end()
    if (failure) throw failure
    if (!ended) throw new Error('Archive writer did not finish')
  } finally { fs.closeSync(fd) }
}

function readAt(fd, size, position) {
  const bytes = Buffer.alloc(size)
  if (fs.readSync(fd, bytes, 0, size, position) !== size) throw new Error('Truncated ZIP structure')
  return bytes
}
function centralReceipts(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < 22 || size > 0xffffffff) throw new Error('Unsupported ZIP size')
    const tail = readAt(fd, Math.min(size, 65557), size - Math.min(size, 65557))
    let end = -1
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10)) throw new Error('ZIP end directory is incomplete')
    const count = tail.readUInt16LE(end + 10)
    const centralSize = tail.readUInt32LE(end + 12)
    const centralOffset = tail.readUInt32LE(end + 16)
    if (count > 4096 || centralSize > 8 * 1024 * 1024 || centralOffset + centralSize !== size - tail.length + end) throw new Error('Invalid ZIP central directory bounds')
    const bytes = readAt(fd, centralSize, centralOffset)
    const receipts = new Map()
    const ranges = []
    let offset = 0
    for (let i = 0; i < count; i++) {
      if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50 || bytes.readUInt16LE(offset + 8) & 1) throw new Error('Unsupported ZIP central entry')
      const nameLength = bytes.readUInt16LE(offset + 28)
      const length = 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
      if (offset + length > bytes.length) throw new Error('Truncated ZIP central entry')
      const name = safeName(bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
      if ([...receipts.keys()].some(existing => existing.toLowerCase() === name.toLowerCase())) throw new Error('Duplicate ZIP central member')
      const localOffset = bytes.readUInt32LE(offset + 42)
      const local = readAt(fd, 30, localOffset)
      const localNameLength = local.readUInt16LE(26)
      const packedSize = bytes.readUInt32LE(offset + 20)
      const mode = bytes.readUInt32LE(offset + 38) >>> 16
      const method = bytes.readUInt16LE(offset + 10)
      if ((mode & 0xf000) === 0xa000 || ![0, 8].includes(method) || local.readUInt16LE(8) !== method || local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) & 1 || localOffset + 30 + localNameLength + local.readUInt16LE(28) + packedSize > centralOffset || readAt(fd, localNameLength, localOffset + 30).toString('utf8') !== name) throw new Error('ZIP local and central member identities differ')
      const unpackedSize = bytes.readUInt32LE(offset + 24)
      const crc = bytes.readUInt32LE(offset + 16)
      const dataOffset = localOffset + 30 + localNameLength + local.readUInt16LE(28)
      let recordEnd = dataOffset + packedSize
      if (local.readUInt16LE(6) !== bytes.readUInt16LE(offset + 8)) throw new Error('ZIP member flags differ')
      if (local.readUInt16LE(6) & 8) {
        const signed = readAt(fd, 4, recordEnd).readUInt32LE(0) === 0x08074b50
        const descriptorSize = signed ? 16 : 12
        if (recordEnd + descriptorSize > centralOffset) throw new Error('Truncated ZIP data descriptor')
        const descriptor = readAt(fd, 12, recordEnd + (signed ? 4 : 0))
        if (descriptor.readUInt32LE(0) !== crc || descriptor.readUInt32LE(4) !== packedSize || descriptor.readUInt32LE(8) !== unpackedSize) throw new Error('ZIP data descriptor differs from central receipt')
        recordEnd += descriptorSize
      } else if (local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== packedSize || local.readUInt32LE(22) !== unpackedSize) throw new Error('ZIP local sizes differ from central receipt')
      ranges.push({ start: localOffset, end: recordEnd })
      receipts.set(name, { size: unpackedSize, crc, dataOffset, packedSize, method })
      offset += length
    }
    if (offset !== bytes.length) throw new Error('ZIP central directory contains unexpected records')
    let nextOffset = 0
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      if (range.start !== nextOffset) throw new Error('ZIP local records overlap or contain unexpected data')
      nextOffset = range.end
    }
    if (nextOffset !== centralOffset) throw new Error('ZIP local directory is incomplete')
    return receipts
  } finally { fs.closeSync(fd) }
}
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0 })
async function verifyZipBytes(file, expectedEntries, options = {}) {
  const central = centralReceipts(file)
  const expected = new Map(expectedEntries.map(entry => [entry.name, entry]))
  if (expected.size !== expectedEntries.length || central.size !== expected.size || [...central.keys()].some(name => !expected.has(name))) throw new Error('ZIP member set differs from complete manifest')
  const requested = options.capture ?? []
  const captureLimit = options.maxCaptureBytes ?? 8 * 1024 * 1024
  if (!Array.isArray(requested) || requested.length > 5 || !Number.isSafeInteger(captureLimit) || captureLimit <= 0 || captureLimit > 8 * 1024 * 1024) throw new Error('Invalid ZIP metadata capture limit')
  const captureNames = new Set()
  let captureTotal = 0
  for (const name of requested) {
    safeName(name)
    if (captureNames.has(name) || [...captureNames].some(existing => existing.toLowerCase() === name.toLowerCase()) || !expected.has(name)) throw new Error('Missing or duplicate ZIP metadata capture request')
    const size = expected.get(name).size
    if (!Number.isSafeInteger(size) || size <= 0 || size > captureLimit) throw new Error('ZIP metadata capture limit exceeded')
    captureTotal += size
    if (captureTotal > 32 * 1024 * 1024) throw new Error('ZIP metadata capture limit exceeded')
    captureNames.add(name)
  }
  const captured = new Map()
  const completed = new Set()
  // Read the exact central-directory bounds, not signature-delimited streams:
  // embedded executables may legitimately contain ZIP descriptor signatures.
  for (const [name, member] of central) {
    const receipt = expected.get(name)
    if (!Number.isSafeInteger(receipt.size) || receipt.size < 0 || receipt.size !== member.size) throw new Error('ZIP member size differs from source receipt')
    const hash = crypto.createHash('sha256')
    const metadata = captureNames.has(name) ? Buffer.alloc(receipt.size) : null
    let size = 0
    let crc = 0xffffffff
    const source = member.packedSize ? fs.createReadStream(file, { start: member.dataOffset, end: member.dataOffset + member.packedSize - 1, highWaterMark: 1024 * 1024 }) : null
    const inflater = member.method === 8 ? createInflateRaw() : null
    if (inflater && source) source.on('error', error => inflater.destroy(error))
    const chunks = inflater ? (source ? source.pipe(inflater) : inflater.end()) : source ?? []
    try {
      for await (const bytes of chunks) {
        size += bytes.length
        if (size > receipt.size) throw new Error('ZIP member expands beyond receipt')
        if (metadata) metadata.set(bytes, size - bytes.length)
        hash.update(bytes)
        for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ crc >>> 8
      }
      if (size !== receipt.size || ((crc ^ 0xffffffff) >>> 0) !== member.crc || hash.digest('hex') !== receipt.sha256 || (inflater && inflater.bytesWritten !== member.packedSize)) throw new Error('ZIP member bytes or CRC differ from source receipt')
      completed.add(name)
      if (metadata) captured.set(name, metadata)
    } finally {
      source?.destroy()
      inflater?.destroy()
    }
  }
  if (completed.size !== expected.size) throw new Error('ZIP member extraction is incomplete')
  if (captured.size !== captureNames.size) throw new Error('ZIP requested metadata capture is incomplete')
  return captureNames.size ? { verifiedMembers: completed.size, captured } : { verifiedMembers: completed.size }
}

function outputPaths(root, output, version) {
  const file = path.resolve(root, output || `release/DeepWriter-${version}-complete.zip`)
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || !file.endsWith('.zip')) throw new Error('Complete output must be a ZIP inside the project')
  safeName(relative.split(path.sep).join('/'))
  let current = root
  for (const part of relative.split(path.sep).slice(0, -1)) { current = path.join(current, part); if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked output directory rejected') }
  const paths = [file, `${file}.manifest.json`, `${file}.SHA256SUMS.txt`]
  if (paths.some(target => fs.existsSync(target))) throw new Error('Refusing to overwrite an existing complete release or receipt')
  return paths
}
async function assembleCompleteRelease(options = {}) {
  const inputs = await collectCompleteInputs(options)
  if (!inputs.complete) return inputs
  const paths = outputPaths(inputs.root, options.output, inputs.version)
  if (path.dirname(paths[0]) === path.resolve(inputs.root, options.releaseDir)) throw new Error('Complete ZIP must not alter the verified desktop release directory')
  fs.mkdirSync(path.dirname(paths[0]), { recursive: true })
  const temporary = fs.mkdtempSync(path.join(path.dirname(paths[0]), '.dw-complete-'))
  const created = []
  try {
    const manifest = { schemaVersion: 1, name: 'deepwriter-complete', version: inputs.version, sourceCommit: inputs.sourceCommit, complete: true, desktopUnsigned: inputs.desktop.unsigned, files: inputs.members.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
    const members = [...inputs.members, { name: 'complete-manifest.json', size: manifestBytes.length, sha256: sha(manifestBytes), bytes: manifestBytes }]
    const checksumBytes = Buffer.from(members.map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n')
    members.push({ name: 'SHA256SUMS.txt', size: checksumBytes.length, sha256: sha(checksumBytes), bytes: checksumBytes })
    const archive = path.join(temporary, 'complete.zip')
    await writeZip(archive, members)
    const verification = await verifyZipBytes(archive, members)
    const archiveHash = await hashFile(archive)
    fs.writeFileSync(path.join(temporary, 'manifest.json'), manifestBytes, { flag: 'wx' })
    fs.writeFileSync(path.join(temporary, 'checksums.txt'), `${archiveHash}  ${path.basename(paths[0])}\n${sha(manifestBytes)}  ${path.basename(paths[1])}\n`, { flag: 'wx' })
    outputPaths(inputs.root, options.output, inputs.version)
    for (const [i, name] of ['complete.zip', 'manifest.json', 'checksums.txt'].entries()) {
      fs.copyFileSync(path.join(temporary, name), paths[i], fs.constants.COPYFILE_EXCL)
      created.push(paths[i])
    }
    // Verify the actual deliverable, not merely the temporary writer output.
    await verifyZipBytes(paths[0], members)
    if (await hashFile(paths[0]) !== archiveHash) throw new Error('Complete ZIP changed while being delivered')
    return { complete: true, output: paths[0], manifest, archiveSha256: archiveHash, ...verification }
  } catch (error) {
    for (const file of created) fs.unlinkSync(file)
    throw error
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
function parseArgs(argv) {
  const options = { root: ROOT }
  const values = new Map([['--root', 'root'], ['--release-dir', 'releaseDir'], ['--cli-dir', 'cliDir'], ['--inventory', 'inventory'], ['--notices', 'notices'], ['--electron-dir', 'electronDir'], ['--docs-dir', 'docsDir'], ['--source-commit', 'sourceCommit'], ['--output', 'output']])
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--desktop-only') { options.desktopOnly = true; continue }
    const equals = argv[i].indexOf('=')
    const flag = equals < 0 ? argv[i] : argv[i].slice(0, equals)
    const key = values.get(flag)
    if (!key) throw new Error('Unknown complete-release option')
    const value = equals < 0 ? argv[++i] : argv[i].slice(equals + 1)
    if (!value || value.startsWith('--')) throw new Error('Complete-release option requires a value')
    if (Object.prototype.hasOwnProperty.call(options, key) && key !== 'root') throw new Error('Duplicate complete-release option')
    options[key] = value
  }
  return options
}
async function main(argv = process.argv.slice(2)) {
  try {
    const result = await assembleCompleteRelease(parseArgs(argv))
    if (!result.complete) { console.log('Desktop diagnostic verified; complete delivery is NOT satisfied and no ZIP was created.'); return 1 }
    console.log(`Complete release verified: ${result.verifiedMembers} ZIP members; SHA256=${result.archiveSha256}`)
    return 0
  } catch (error) { console.error(`Complete release rejected: ${error.message}`); return 2 }
}
if (require.main === module) main().then(code => { process.exitCode = code })
module.exports = { assembleCompleteRelease, collectCompleteInputs, verifyZipBytes, writeZip, safeName, parseArgs, main }
