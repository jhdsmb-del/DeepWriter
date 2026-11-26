'use strict'

// Receipt wrapper around the single CLI build implementation/alias policy.
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { normalizedInputs, sourceState, resource, sha, read, outputPath, json } = require('./package-cli.cjs')
const ROOT = path.resolve(__dirname, '..')
async function buildCliArtifact(options, ports = {}) {
  const root = path.resolve(options.root || ROOT)
  const output = outputPath(root, options.output)
  if (fs.existsSync(output)) throw new Error('Refusing to overwrite CLI build artifacts')
  const pkgBytes = read(path.join(root, 'package.json'))
  const lockBytes = read(path.join(root, 'package-lock.json'))
  const pkg = JSON.parse(pkgBytes)
  const lock = JSON.parse(lockBytes)
  const version = options.version || pkg.version
  const before = (ports.sourceState || sourceState)(root)
  const sourceCommit = options.sourceCommit || before.sourceCommit
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit) || pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version || sourceCommit !== before.sourceCommit || typeof before.sourceDirty !== 'boolean') throw new Error('CLI build identity differs from actual source/version')
  const outfile = path.join(output, 'deepwriter.cjs')
  const builder = ports.builder || (await import(pathToFileURL(path.join(root, 'src/cli/build.mjs')).href)).buildCli
  if (typeof builder !== 'function') throw new Error('CLI build implementation is unavailable')
  const result = await builder({ outfile, write: false, metafile: true, version })
  if (!Array.isArray(result.outputFiles) || result.outputFiles.length !== 1 || path.resolve(result.outputFiles[0].path) !== outfile || !result.metafile || !Array.isArray(result.warnings)) throw new Error('CLI builder did not produce one complete in-memory CJS result')
  const bundleBytes = Buffer.from(result.outputFiles[0].contents)
  const metafileBytes = json(result.metafile)
  const inputs = normalizedInputs(root, result.metafile).map(({ name, size, sha256 }) => ({ name, size, sha256 }))
  const after = (ports.sourceState || sourceState)(root)
  if (after.sourceCommit !== before.sourceCommit || after.sourceDirty !== before.sourceDirty || sha(read(path.join(root, 'package.json'))) !== sha(pkgBytes) || sha(read(path.join(root, 'package-lock.json'))) !== sha(lockBytes)) throw new Error('CLI source changed during build; no stable receipt can be issued')
  const relative = file => path.relative(root, file).replaceAll('\\', '/')
  const receipt = {
    schemaVersion: 1, application: { name: 'deepwriter-cli', version }, sourceCommit, sourceDirty: before.sourceDirty,
    source: { packageSha256: sha(pkgBytes), lockSha256: sha(lockBytes) },
    buildPolicy: { implementation: 'src/cli/build.mjs', implementationSha256: ports.builder ? null : sha(read(path.join(root, 'src/cli/build.mjs'))), platform: 'node', format: 'cjs', target: 'node22', entrypoint: 'src/cli/main.ts' },
    bundle: resource(relative(outfile), bundleBytes), metafile: resource(relative(path.join(output, 'cli-metafile.json')), metafileBytes), inputs,
    warnings: result.warnings.map(warning => ({ id: warning.id || 'unspecified' }))
  }
  const files = [{ name: 'deepwriter.cjs', bytes: bundleBytes }, { name: 'cli-metafile.json', bytes: metafileBytes }, { name: 'cli-build.json', bytes: json(receipt) }]
  fs.mkdirSync(path.dirname(output), { recursive: true })
  outputPath(root, output)
  fs.mkdirSync(output)
  const created = []
  try {
    for (const file of files) {
      const target = path.join(output, file.name)
      fs.writeFileSync(target, file.bytes, { flag: 'wx', mode: 0o600 }); created.push(target)
      if (sha(read(target, 64 * 1024 * 1024)) !== sha(file.bytes)) throw new Error('CLI build artifact differs from the in-memory result')
    }
  } catch (error) {
    for (const target of created.reverse()) fs.unlinkSync(target)
    fs.rmdirSync(output)
    throw error
  }
  return { output, receipt }
}
function parseArgs(argv) {
  const options = { root: ROOT }
  const keys = new Map([['--root', 'root'], ['--output', 'output'], ['--version', 'version'], ['--source-commit', 'sourceCommit']])
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const equal = argv[i].indexOf('=')
    const flag = equal < 0 ? argv[i] : argv[i].slice(0, equal)
    const key = keys.get(flag)
    if (!key) throw new Error('Unknown CLI build option')
    if (seen.has(key)) throw new Error('Duplicate CLI build option')
    seen.add(key)
    const value = equal < 0 ? argv[++i] : argv[i].slice(equal + 1)
    if (!value || value.startsWith('--')) throw new Error('CLI build option requires a value')
    options[key] = value
  }
  return options
}
async function main(argv = process.argv.slice(2)) {
  try {
    const result = await buildCliArtifact(parseArgs(argv))
    console.log(`CLI build ${result.receipt.application.version}: sourceDirty=${result.receipt.sourceDirty}; inputs=${result.receipt.inputs.length}; bundleSHA256=${result.receipt.bundle.sha256}`)
    return 0
  } catch { console.error('CLI build receipt failed; no clean source or release status is implied.'); return 2 }
}
if (require.main === module) main().then(code => { process.exitCode = code })
module.exports = { buildCliArtifact, parseArgs, main }
