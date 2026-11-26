'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { isBuiltin, createRequire } = require('node:module')
const { test } = require('node:test')
const { buildCliArtifact, parseArgs } = require('./build-cli.cjs')
const { sha } = require('./package-cli.cjs')
const SOURCE = 'a'.repeat(40)
const ROOT = path.resolve(__dirname, '..')
function copyRuntimeDependency(name, from, target, seen = new Set()) {
  if (isBuiltin(name)) return
  const resolver = createRequire(path.join(from, '__fixture__.cjs'))
  let directory = path.dirname(resolver.resolve(name))
  while (!fs.existsSync(path.join(directory, 'package.json')) || JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).name !== name) {
    const parent = path.dirname(directory); assert.notEqual(parent, directory); directory = parent
  }
  if (seen.has(directory)) return
  seen.add(directory)
  const relative = path.relative(fs.realpathSync(ROOT), fs.realpathSync(directory))
  assert.ok(relative.startsWith('node_modules' + path.sep), relative)
  fs.cpSync(directory, path.join(target, relative), { recursive: true })
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')))
  for (const dependency of Object.keys(pkg.dependencies || {})) copyRuntimeDependency(dependency, directory, target, seen)
}
async function fixture(task) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-cli-build-test-')))
  try {
    fs.mkdirSync(path.join(root, 'src/cli'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src/cli/main.ts'), 'console.log("synthetic fixture")\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'deepwriter', version: '1.3.1' }))
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.3.1', packages: { '': { version: '1.3.1' } } }))
    const options = { root, version: '1.3.1', sourceCommit: SOURCE, output: 'out/cli-build' }
    const ports = { sourceState: () => ({ sourceCommit: SOURCE, sourceDirty: true }), builder: async ({ outfile, write, metafile, version }) => {
      assert.equal(write, false); assert.equal(metafile, true); assert.equal(version, '1.3.1')
      const bytes = Buffer.from('console.log("synthetic bundled fixture")\n')
      return { outputFiles: [{ path: outfile, contents: bytes }], warnings: [], metafile: { inputs: { 'src/cli/main.ts': { bytes: fs.statSync(path.join(root, 'src/cli/main.ts')).size, imports: [] } }, outputs: { [outfile]: { bytes: bytes.length, entryPoint: 'src/cli/main.ts', inputs: { 'src/cli/main.ts': { bytesInOutput: 30 } }, imports: [] } } } }
    } }
    await task(options, ports)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
test('one builder result binds actual bundle, raw metafile, inputs and dirty source honestly', async () => fixture(async (options, ports) => {
  const result = await buildCliArtifact(options, ports)
  const receipt = JSON.parse(fs.readFileSync(path.join(result.output, 'cli-build.json')))
  assert.equal(receipt.sourceDirty, true)
  assert.equal(receipt.sourceCommit, SOURCE)
  assert.equal(receipt.bundle.sha256, sha(fs.readFileSync(path.join(result.output, 'deepwriter.cjs'))))
  assert.equal(receipt.metafile.sha256, sha(fs.readFileSync(path.join(result.output, 'cli-metafile.json'))))
  assert.equal(receipt.inputs[0].sha256, sha(fs.readFileSync(path.join(options.root, 'src/cli/main.ts'))))
  assert.equal(receipt.inputs[0].name, 'src/cli/main.ts')
  assert.deepEqual(fs.readdirSync(result.output).sort(), ['cli-build.json', 'cli-metafile.json', 'deepwriter.cjs'])
}))
test('version/source mismatch and source changes during build never publish a receipt', async () => fixture(async (options, ports) => {
  await assert.rejects(buildCliArtifact({ ...options, version: '1.3.2' }, ports), /identity/)
  let calls = 0
  await assert.rejects(buildCliArtifact(options, { ...ports, sourceState: () => ({ sourceCommit: ++calls === 1 ? SOURCE : 'b'.repeat(40), sourceDirty: true }) }), /source changed/)
  assert.equal(fs.existsSync(path.join(options.root, options.output)), false)
}))
test('build output cannot overwrite old artifacts or write into release history', async () => fixture(async (options, ports) => {
  const result = await buildCliArtifact(options, ports)
  const old = fs.readFileSync(path.join(result.output, 'cli-build.json'))
  await assert.rejects(buildCliArtifact(options, ports), /overwrite/)
  assert.deepEqual(fs.readFileSync(path.join(result.output, 'cli-build.json')), old)
  await assert.rejects(buildCliArtifact({ ...options, output: 'release/v1.3.1' }, ports), /output/)
}))
test('build flags require explicit values and reject duplicates/unsupported options', () => {
  assert.throws(() => parseArgs(['--sign']), /Unknown/)
  assert.throws(() => parseArgs(['--version', '1.3.1', '--version', '1.3.1']), /Duplicate/)
})

test('actual CLI uses canonical source paths and identical bundle bytes across checkouts', async (t) => {
  const parent = path.join(ROOT, 'out')
  fs.mkdirSync(parent, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(parent, 'cli-build-path-test-'))
  try {
    const roots = ['first-checkout', 'second-checkout-with-a-different-length'].map(name => path.join(temporary, name))
    // Freeze one actual source/dependency snapshot before either build. Taking
    // the second checkout from the live workspace after the first build would
    // compare concurrent edits, not canonical paths for identical inputs.
    const snapshot = path.join(temporary, 'source-snapshot')
    fs.mkdirSync(snapshot)
    fs.cpSync(path.join(ROOT, 'src'), path.join(snapshot, 'src'), { recursive: true })
    for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, name), path.join(snapshot, name))
    const copied = new Set()
    for (const dependency of ['diff', 'mammoth', 'iconv-lite', 'saxes']) copyRuntimeDependency(dependency, ROOT, snapshot, copied)
    for (const root of roots) fs.cpSync(snapshot, root, { recursive: true })
    const bundles = []
    const receipts = []
    const modules = []
    for (const root of roots) {
      const result = await buildCliArtifact({ root, output: 'out/cli-build', sourceCommit: SOURCE }, { sourceState: () => ({ sourceCommit: SOURCE, sourceDirty: false }) })
      const bundle = fs.readFileSync(path.join(result.output, 'deepwriter.cjs'))
      const metafileBytes = fs.readFileSync(path.join(result.output, 'cli-metafile.json'))
      const metafile = JSON.parse(metafileBytes)
      for (const text of [bundle.toString('utf8'), metafileBytes.toString('utf8')]) {
        assert.equal(text.includes(root), false)
        assert.equal(text.includes(root.replaceAll('\\', '/')), false)
        assert.doesNotMatch(text, /cli-source:(?:[A-Za-z]:|[\\/])/)
      }
      const namespaceInputs = Object.keys(metafile.inputs).filter(name => name.startsWith('cli-source:'))
      assert.ok(namespaceInputs.includes('cli-source:src/cli/main.ts'))
      assert.ok(namespaceInputs.includes('cli-source:src/cli/host.ts'))
      assert.ok(namespaceInputs.includes('cli-source:src/cli/unsupported-exporters.ts'))
      assert.ok(namespaceInputs.some(name => name.startsWith('cli-source:node_modules/diff/')))
      for (const name of namespaceInputs) assert.ok(result.receipt.inputs.some(input => input.name === name.slice('cli-source:'.length) && input.sha256 === sha(fs.readFileSync(path.join(root, input.name)))))
      for (const output of Object.values(metafile.outputs)) for (const imported of output.imports) assert.ok(imported.external === true && isBuiltin(imported.path))
      assert.equal(result.receipt.sourceDirty, false)
      assert.equal(result.receipt.bundle.sha256, sha(bundle))
      bundles.push(bundle)
      receipts.push(result.receipt)
      modules.push(await import(pathToFileURL(path.join(root, 'src/cli/build.mjs')).href))
    }
    const firstInputs = new Map(receipts[0].inputs.map(input => [input.name, input.sha256]))
    const secondInputs = new Map(receipts[1].inputs.map(input => [input.name, input.sha256]))
    const changedInputs = [...new Set([...firstInputs.keys(), ...secondInputs.keys()])].filter(name => firstInputs.get(name) !== secondInputs.get(name))
    assert.equal(changedInputs.length, 0, `Checkout source identities differ: ${changedInputs.slice(0, 10).join(', ')}`)
    // Deep-equality diagnostics attempt to render every changed Buffer byte;
    // a multi-megabyte bundle must fail with a bounded, useful identity report.
    assert.ok(bundles[0].equals(bundles[1]), `CLI bytes differ across checkouts; inputs changed: ${changedInputs.slice(0, 10).join(', ') || 'none'}; first=${receipts[0].bundle.sha256}; second=${receipts[1].bundle.sha256}`)
    t.diagnostic(`Actual CLI cross-checkout bundle SHA256=${sha(bundles[0])}`)

    const outside = path.join(temporary, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'escape.ts'), 'console.log("outside boundary")\n')
    fs.writeFileSync(path.join(roots[0], 'src/cli/main.ts'), 'import "../../../outside/escape.ts"\n')
    await assert.rejects(modules[0].buildCli({ write: false, outfile: path.join(roots[0], 'out/outside.cjs') }), /CLI source boundary/)
    const linked = path.join(roots[0], 'src/cli/linked')
    fs.symlinkSync(outside, linked, 'junction')
    fs.writeFileSync(path.join(roots[0], 'src/cli/main.ts'), 'import "./linked/escape.ts"\n')
    await assert.rejects(modules[0].buildCli({ write: false, outfile: path.join(roots[0], 'out/linked.cjs') }), /CLI source boundary: linked resource/)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})
