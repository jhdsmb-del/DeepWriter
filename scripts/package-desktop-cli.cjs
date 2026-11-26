'use strict'

// Assemble a local delivery from explicit, already-built desktop and CLI inputs.
// Installation/rollout evidence belongs to the separate official-release route.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const asar = require('@electron/asar')
const { writeZip, verifyZipBytes, safeName } = require('./assemble-complete-release.cjs')
const { hashFile } = require('./prepare-release.cjs')
const root = path.resolve(__dirname, '..')

async function packageDesktopCli(options) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const outputRoot = fs.realpathSync(path.join(root, 'out'))
  const insideOutput = file => {
    const relative = path.relative(outputRoot, file)
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Delivery paths must stay inside project out')
    return file
  }
  const desktopDir = insideOutput(fs.realpathSync(path.resolve(root, options.desktopDir)))
  const cliDir = insideOutput(fs.realpathSync(path.resolve(root, options.cliDir)))
  const output = insideOutput(path.resolve(root, options.output))
  const archive = path.join(desktopDir, 'win-unpacked/resources/app.asar')
  const desktopPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  const cli = JSON.parse(fs.readFileSync(path.join(cliDir, 'cli-release.json'), 'utf8'))
  if (desktopPackage.version !== version || cli.version !== version || cli.sourceCommit !== sourceCommit) throw new Error('Desktop, CLI and source must have the same release identity')
  const targets = [output, output + '.manifest.json', output + '.SHA256SUMS.txt']
  if (!output.endsWith('.zip') || targets.some(file => fs.existsSync(file))) throw new Error('Choose a fresh ZIP output')
  const members = []
  const names = new Set()
  const add = async (file, name, expected) => {
    safeName(name)
    if (names.has(name.toLowerCase())) throw new Error('Duplicate delivery member')
    names.add(name.toLowerCase())
    const actual = fs.realpathSync(file)
    if (actual !== path.resolve(file) || !fs.statSync(actual).isFile()) throw new Error('Delivery sources must be regular, unlinked files')
    const size = fs.statSync(actual).size
    const sha256 = await hashFile(actual)
    if (expected && (expected.size !== size || expected.sha256 !== sha256)) throw new Error('CLI source changed after packaging')
    members.push({ name, file: actual, size, sha256 })
  }
  for (const kind of ['setup', 'portable']) {
    const name = `DeepWriter-${version}-x64-${kind}.exe`
    await add(path.join(desktopDir, name), `desktop/${name}`)
  }
  for (const entry of cli.files) {
    safeName(entry.name)
    const file = insideOutput(path.resolve(cliDir, entry.name))
    if (!file.startsWith(cliDir + path.sep)) throw new Error('CLI member escapes its package')
    await add(file, `cli/${entry.name}`, entry)
  }
  await add(path.join(cliDir, 'cli-release.json'), 'cli/cli-release.json')
  await add(path.join(root, 'PACKAGE_README.md'), 'README.md')
  await add(path.join(root, 'LICENSE'), 'LICENSE')
  await add(path.join(root, 'SECURITY.md'), 'SECURITY.md')
  for (const name of [`RELEASE_NOTES_${version}.md`, 'QUICKSTART.md', 'CLI.md', 'PRIVACY.md', 'OPERATIONS.md', 'VALIDATION.md', 'EXTENSIONS_RESEARCH.md', 'PROVIDER_EXPANSION_RESEARCH.md']) await add(path.join(root, 'docs', name), `docs/${name}`)
  const manifest = { schemaVersion: 1, name: 'deepwriter-complete', version, sourceCommit,
    files: members.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  const { createHash } = require('node:crypto')
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  members.push({ name: 'complete-manifest.json', size: manifestBytes.length, sha256: sha(manifestBytes), bytes: manifestBytes })
  const sums = Buffer.from(members.map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n')
  members.push({ name: 'SHA256SUMS.txt', size: sums.length, sha256: sha(sums), bytes: sums })
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const outputDirectory = fs.realpathSync(path.dirname(output))
  if (outputDirectory !== outputRoot) insideOutput(outputDirectory)
  const temporary = output + '.' + randomUUID() + '.partial'
  try {
    await writeZip(temporary, members)
    await verifyZipBytes(temporary, members)
    const archiveSha256 = await hashFile(temporary)
    fs.copyFileSync(temporary, output, fs.constants.COPYFILE_EXCL)
    fs.writeFileSync(targets[1], manifestBytes, { flag: 'wx' })
    fs.writeFileSync(targets[2], `${archiveSha256}  ${path.basename(output)}\n`, { flag: 'wx' })
    return { output, version, sourceCommit, archiveSha256, members: members.length }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.length !== 3) { console.error('Usage: node scripts/package-desktop-cli.cjs DESKTOP_DIR CLI_DIR OUTPUT.zip'); process.exitCode = 2 }
  else packageDesktopCli({ desktopDir: args[0], cliDir: args[1], output: args[2] }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
module.exports = { packageDesktopCli }
