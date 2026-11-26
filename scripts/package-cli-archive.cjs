'use strict'

// A second envelope for the SAME signed-off CLI directory used in complete
// releases. No new build, runtime acquisition, dependency walk or network.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { writeZip, verifyZipBytes, safeName } = require('./assemble-complete-release.cjs')
const { hashFile } = require('./prepare-release.cjs')
const { read, sha, json } = require('./package-cli.cjs')
const ROOT = path.resolve(__dirname, '..')
const HASH = /^[a-f0-9]{64}$/

function noLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked archive path rejected') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (path.dirname(current) === current) break
  }
}
async function member(base, name, receipt, prefix = '') {
  safeName(name)
  const file = path.resolve(base, ...name.split('/'))
  noLinks(file)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size <= 0 || stat.size > 512 * 1024 * 1024) throw new Error('CLI archive requires bounded regular input files')
  const sha256 = await hashFile(file)
  if (receipt && (stat.size !== receipt.size || sha256 !== receipt.sha256)) throw new Error('CLI file differs from the signed-off release receipt')
  return { name: prefix + name, size: stat.size, sha256, file }
}
function equal(a, b) { return a && b && a.size === b.size && a.sha256 === b.sha256 }

async function collectCliArchiveInputs(options = {}) {
  const root = path.resolve(options.root || ROOT)
  const pkgBytes = read(path.join(root, 'package.json'))
  const pkg = JSON.parse(pkgBytes)
  const version = pkg.version
  const sourceCommit = options.sourceCommit || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit) || !options.cliDir) throw new Error('CLI archive needs a versioned source identity and built CLI directory')
  const cliDir = path.resolve(root, options.cliDir)
  const cli = JSON.parse(read(path.join(cliDir, 'cli-release.json')))
  if (cli.name !== 'deepwriter-cli' || cli.version !== version || cli.sourceCommit !== sourceCommit || cli.entrypoint !== 'deepwriter.cjs' || cli.runtime?.name !== 'node' || cli.runtime?.platform !== 'win32' || cli.runtime?.arch !== 'x64' || !/^\d+\.\d+\.\d+$/.test(cli.runtime?.version || '') || !Array.isArray(cli.files) || !cli.files.length || cli.files.length > 4090) throw new Error('CLI identity or runtime differs from this release')
  const [major, minor] = cli.runtime.version.split('.').map(Number)
  if (major < 22 || major === 22 && minor < 13) throw new Error('CLI runtime is below Node 22.13')
  const required = ['deepwriter.cmd', cli.entrypoint, cli.runtime.executable, cli.runtime.license, cli.runtime.licenseSource, cli.inventory, cli.notices, 'LICENSE', 'build/cli-build.json']
  required.forEach(safeName)
  if (new Set(required.map(name => name.toLowerCase())).size !== required.length) throw new Error('CLI required resources must be distinct')
  const entries = new Map()
  const members = []
  for (const entry of cli.files) {
    safeName(entry.name)
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || !HASH.test(entry.sha256 || '') || entries.has(entry.name.toLowerCase()) || entry.name.toLowerCase() === 'cli-release.json') throw new Error('Invalid or duplicate CLI manifest resource')
    entries.set(entry.name.toLowerCase(), entry)
    members.push(await member(cliDir, entry.name, entry, 'cli/'))
  }
  if (required.some(name => !entries.has(name.toLowerCase()))) throw new Error('CLI manifest omits an entrypoint, runtime or notice')
  const executable = path.join(cliDir, cli.runtime.executable)
  const header = Buffer.alloc(2)
  const fd = fs.openSync(executable, 'r')
  try {
    if (fs.fstatSync(fd).size < 1024 * 1024 || fs.readSync(fd, header, 0, 2, 0) !== 2 || header.toString() !== 'MZ') throw new Error('CLI runtime is not a Windows executable')
  } finally { fs.closeSync(fd) }
  const inventory = JSON.parse(read(path.join(cliDir, cli.inventory)))
  if (inventory.application?.name !== 'deepwriter-cli' || inventory.application?.version !== version || inventory.sourceCommit !== sourceCommit || inventory.inventoryComplete !== true || !Array.isArray(inventory.reviewNeeded) || inventory.reviewNeeded.length || !Array.isArray(inventory.files) || inventory.source?.packageSha256 !== sha(pkgBytes) || inventory.source?.lockSha256 !== sha(read(path.join(root, 'package-lock.json'))) || inventory.runtime?.name !== 'node' || inventory.runtime?.version !== cli.runtime.version || inventory.runtime?.platform !== 'win32' || inventory.runtime?.arch !== 'x64' || inventory.runtime?.executableSha256 !== entries.get(cli.runtime.executable.toLowerCase()).sha256) throw new Error('CLI inventory is incomplete, stale or not bound to this runtime/source')
  const inventoryEntries = new Map()
  for (const entry of inventory.files) {
    safeName(entry.name)
    if (inventoryEntries.has(entry.name.toLowerCase()) || !equal(entry, entries.get(entry.name.toLowerCase()))) throw new Error('CLI inventory resources differ from the release manifest')
    inventoryEntries.set(entry.name.toLowerCase(), entry)
  }
  if (cli.files.some(entry => entry.name !== cli.inventory && !inventoryEntries.has(entry.name.toLowerCase()))) throw new Error('CLI inventory omits a shipped resource')
  const license = await member(root, 'LICENSE')
  if (!equal(license, entries.get('license'))) throw new Error('CLI project license differs from this release')
  members.push(await member(cliDir, 'cli-release.json', undefined, 'cli/'), license, await member(root, 'docs/CLI.md'))
  const readme = Buffer.from(`# DeepWriter CLI ${version}\n\nWindows x64 独立命令行包，含 Node 运行时，无需安装 Node、npm 或桌面版。完整解压并保留 cli 目录。\n\n在本目录打开 PowerShell：\n\n\`\`\`powershell\n.\\cli\\deepwriter.cmd --version\n.\\cli\\deepwriter.cmd --help\n.\\cli\\deepwriter.cmd update check\n\`\`\`\n\n开始聊天、隐藏输入 Key、恢复任务及更新方法见 [docs/CLI.md](docs/CLI.md)。更新下载只保存并校验 ZIP，不安装或执行代码。\n\n旧会话与稿件仍保存在原数据目录；使用原来的 --data-dir，不要将会话或 Key 复制到 cli 中。许可证见 LICENSE、cli/THIRD_PARTY_NOTICES.txt 和 cli/runtime/LICENSE。\n`, 'utf8')
  members.push({ name: 'README.md', size: readme.length, sha256: sha(readme), bytes: readme })
  if (members.reduce((total, item) => total + item.size, 0) > 480 * 1024 * 1024) throw new Error('CLI archive exceeds the lightweight 480 MiB input limit')
  return { root, cliDir, version, sourceCommit, members: members.sort((a, b) => a.name.localeCompare(b.name)) }
}

async function packageCliArchive(options = {}) {
  const inputs = await collectCliArchiveInputs(options)
  const name = `DeepWriter-${inputs.version}-cli-win-x64.zip`
  const output = path.resolve(inputs.root, options.output || path.join('out', name))
  const relative = path.relative(inputs.root, output).replaceAll('\\', '/')
  safeName(relative)
  if (path.basename(output) !== name) throw new Error(`CLI archive must be named ${name}`)
  const paths = [output, output + '.manifest.json', output + '.SHA256SUMS.txt']
  const checkOutput = () => {
    noLinks(output)
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || paths.some(file => { try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } })) throw new Error('Choose a fresh CLI archive inside the project; existing files are never overwritten')
    const cliRelative = path.relative(inputs.cliDir, output)
    if (!cliRelative || cliRelative !== '..' && !cliRelative.startsWith('..' + path.sep) && !path.isAbsolute(cliRelative)) throw new Error('CLI ZIP must not alter its input directory')
  }
  checkOutput()
  fs.mkdirSync(path.dirname(output), { recursive: true })
  checkOutput()
  const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.dw-cli-archive-'))
  const created = []
  try {
    const manifest = { schemaVersion: 1, name: 'deepwriter-cli-archive', version: inputs.version, sourceCommit: inputs.sourceCommit, files: inputs.members.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }
    const manifestBytes = json(manifest)
    const members = [...inputs.members, { name: 'cli-archive-manifest.json', size: manifestBytes.length, sha256: sha(manifestBytes), bytes: manifestBytes }]
    const sums = Buffer.from(members.map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n')
    members.push({ name: 'SHA256SUMS.txt', size: sums.length, sha256: sha(sums), bytes: sums })
    const archive = path.join(temporary, 'cli.zip')
    await writeZip(archive, members)
    const verification = await verifyZipBytes(archive, members)
    const archiveSha256 = await hashFile(archive)
    const resources = [archive, path.join(temporary, 'manifest.json'), path.join(temporary, 'sums.txt')]
    fs.writeFileSync(resources[1], manifestBytes, { flag: 'wx' })
    fs.writeFileSync(resources[2], `${archiveSha256}  ${name}\n`, { flag: 'wx' })
    checkOutput()
    for (const [index, file] of resources.entries()) { fs.copyFileSync(file, paths[index], fs.constants.COPYFILE_EXCL); created.push(paths[index]) }
    await verifyZipBytes(output, members)
    return { output, version: inputs.version, sourceCommit: inputs.sourceCommit, archiveSha256, ...verification }
  } catch (error) {
    for (const file of created) fs.unlinkSync(file)
    throw error
  } finally {
    // No recursive removal across a computed boundary; only our reserved files.
    noLinks(temporary)
    for (const name of ['cli.zip', 'manifest.json', 'sums.txt']) {
      try { fs.unlinkSync(path.join(temporary, name)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    fs.rmdirSync(temporary)
  }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.length !== 2) { console.error('Usage: node scripts/package-cli-archive.cjs CLI_DIR OUTPUT/DeepWriter-VERSION-cli-win-x64.zip'); process.exitCode = 2 }
  else packageCliArchive({ cliDir: args[0], output: args[1] }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
module.exports = { packageCliArchive, collectCliArchiveInputs }
