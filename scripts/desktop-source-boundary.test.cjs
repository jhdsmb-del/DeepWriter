'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const sourceEntry = path.join(root, 'src/main/agentTools.ts')
let boundary
before(async () => { boundary = await import(pathToFileURL(path.join(__dirname, 'desktop-source-boundary.mjs')).href) })

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-exceljs-boundary-'))
  const sourceLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')))
  const manifest = { name: 'deepwriter', dependencies: { exceljs: '^4.4.0' }, overrides: { exceljs: { unzipper: '0.12.5' } } }
  const lock = { packages: { '': { dependencies: { ...manifest.dependencies } } } }
  for (const name of ['exceljs', 'unzipper']) {
    const location = `node_modules/${name}`
    lock.packages[location] = { ...sourceLock.packages[location] }
    fs.mkdirSync(path.join(directory, location), { recursive: true })
    fs.writeFileSync(path.join(directory, location, 'package.json'), JSON.stringify({ name, version: lock.packages[location].version, main: 'index.js' }))
    fs.writeFileSync(path.join(directory, location, 'index.js'), 'module.exports = {}\n')
  }
  const save = () => {
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify(lock))
  }
  save()
  return { directory, manifest, lock, save, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

test('real Desktop boundary binds the direct declaration, published lock/SRI and ExcelJS-owned unzipper resolution', () => {
  const receipt = boundary.verifyDesktopExcelJsBoundary(sourceEntry)
  assert.equal(receipt.root, fs.realpathSync(root))
  assert.equal(receipt.exceljs.version, '4.4.0')
  assert.equal(receipt.unzipper.version, '0.12.5')
  const owner = createRequire(receipt.exceljs.entryPath)
  assert.equal(owner.resolve('unzipper'), receipt.unzipper.entryPath)
  assert.match(receipt.exceljs.manifestSha256, /^[a-f0-9]{64}$/)
  assert.match(receipt.unzipper.entrySha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(boundary.desktopSourceExternals(sourceEntry, ['node:sqlite', 'exceljs']), ['node:sqlite', 'exceljs'])
  assert.equal(fs.existsSync(path.join(root, 'node_modules/@aws-sdk/client-s3')), false)
})

for (const [label, change] of [
  ['missing direct dependency', f => { delete f.manifest.dependencies.exceljs }],
  ['direct declaration/lock drift', f => { f.lock.packages[''].dependencies.exceljs = '*' }],
  ['missing scoped override', f => { delete f.manifest.overrides.exceljs }],
  ['wrong published SRI', f => { f.lock.packages['node_modules/exceljs'].integrity = 'sha512-forged' }],
  ['wrong published source', f => { f.lock.packages['node_modules/unzipper'].resolved = 'https://example.invalid/unzipper.tgz' }],
  ['dev-only dependency', f => { f.lock.packages['node_modules/exceljs'].dev = true }],
  ['missing locked consumer identity', f => { delete f.lock.packages['node_modules/unzipper'] }]
]) test(`boundary rejects ${label}`, () => {
  const f = fixture()
  try { change(f); f.save(); assert.throws(() => boundary.desktopSourceExternals(f.directory), /Desktop ExcelJS boundary:/) }
  finally { f.dispose() }
})

test('boundary rejects installed version drift, missing module and symlink escape', () => {
  const f = fixture()
  try {
    const manifestPath = path.join(f.directory, 'node_modules/exceljs/package.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ name: 'exceljs', version: '0.0.0', main: 'index.js' }))
    assert.throws(() => boundary.desktopSourceExternals(f.directory), /installed version\/location\/lock\/SRI mismatch/)
    fs.rmSync(path.dirname(manifestPath), { recursive: true })
    assert.throws(() => boundary.desktopSourceExternals(f.directory), /Cannot find module|ENOENT/)
    fs.symlinkSync(path.join(root, 'node_modules/exceljs'), path.dirname(manifestPath), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => boundary.desktopSourceExternals(f.directory), /escaped project|symlink/)
  } finally { f.dispose() }
})

test('the boundary cannot externalize a missing SDK or accept a relative source', () => {
  assert.throws(() => boundary.desktopSourceExternals(sourceEntry, ['@aws-sdk/client-s3']), /invalid external/)
  assert.throws(() => boundary.desktopSourceExternals('src/main/agentTools.ts'), /absolute source/)
})

const affected = [
  'benchmark-real.ts', 'build-live-test.mjs', 'eval-runner.ts', 'eval-orchestration-selftest.ts', 'gate1-security.ts',
  'p0-1-manuscript-boundary.ts', 'p0-1-provider-budget.ts', 'p1-2-narrative-state.ts', 'p1-b-manuscript-recovery.ts', 'p1-token-budget.ts',
  'p2-completion-combo.ts', 'p2-scene-state.ts', 'r32-writing-exact.ts', 'r39-strong-constraints.ts', 'r41-regressions.ts',
  'r42-atomic.ts', 'r42-extra.ts', 'r42-recovery.ts', 'r42-snapshot.ts', 'r42-usage.ts', 'r43-completion-integration.ts',
  'r43-faults.ts', 'r43-toolpolicy.ts', 'r44-completion-observe.ts', 'r45-g1.ts', 'r45-g2.ts', 'r45-g4.ts', 'r45-g5.ts',
  'r54-agent-preset.ts', 'r60-longwrite-collaboration.ts', 'r61-run-cost-budget.ts', 'r62-scene-semantic-review.ts',
  'r64-review-lifecycle.ts', 'r65-actuality-contract.ts', 'r65-review-recovery.ts', 'r66-actuality-scope.ts',
  'r68-review-recovery-electron.ts', 'soak-smoke.ts', 'verify.ts', 'wp7-runtime-phase1.ts', 'wp7-runtime-phase2.ts', 'wp7-runtime-phase3.ts', 'writing-core-red-tests.ts'
]
test('all inventoried affected source/eval loaders and direct agent test share the real dependency boundary', () => {
  assert.equal(affected.length, 43)
  for (const file of affected) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
    assert.match(source, /import \{ desktopSourceExternals \} from '\.\/desktop-source-boundary\.mjs'/, file)
    assert.match(source, /external:\s*desktopSourceExternals\(/, file)
    assert.doesNotMatch(source, /external:[^\n]*@aws-sdk/, file)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
  const agentCommands = pkg.scripts['test:agent'].split(/\s*&&\s*/)
  assert.deepEqual(agentCommands.slice(0, 2), ['node scripts/build-agent-foundation.mjs', 'node out/agent-foundation.mjs'], 'the real direct agent entry is built through the boundary and then executed')
  const providerTests = agentCommands.find(command => command.startsWith('node --test '))?.split(/\s+/).slice(2) ?? []
  for (const file of ['scripts/provider-budget-policy.test.cjs', 'scripts/provider-cost-recovery.test.cjs']) assert.ok(providerTests.includes(file), `${file} remains on the direct agent path`)
  assert.match(fs.readFileSync(path.join(__dirname, 'build-agent-foundation.mjs'), 'utf8'), /external: desktopSourceExternals\(entry\)/)
})

const electronShim = {
  name: 'only-electron-ui-shim', setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'only-electron-ui-shim' }))
    build.onLoad({ filter: /.*/, namespace: 'only-electron-ui-shim' }, () => ({ loader: 'js', contents: `
      export const app = {getPath:()=>${JSON.stringify(os.tmpdir())},isPackaged:false};
      export const dialog={showMessageBox:async()=>{throw new Error('unexpected dialog')},showSaveDialog:async()=>{throw new Error('unexpected dialog')}};
    ` }))
  }
}
test('original inline options still reproduce the exact missing optional SDK failure without a request', async () => {
  await assert.rejects(esbuild.build({ absWorkingDir: root, entryPoints: [sourceEntry], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    external: ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate'], plugins: [electronShim]
  }), error => error.errors?.some(item => item.text.includes('Could not resolve "@aws-sdk/client-s3"')) === true)
})

test('compiled actual tools generate XLSX and the installed public reader preserves Chinese rows/columns; real agent entry stays available', async () => {
  const privateRoot = path.join(root, 'out/private')
  fs.mkdirSync(privateRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(privateRoot, 'desktop-source-boundary-'))
  const outfile = path.join(directory, 'actual-tools.cjs')
  try {
    const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
      export {runCommand, agentTools} from './src/main/agentTools';
      export {executeTool, buildToolSpecs} from './src/main/tools';
    ` }, bundle: true, platform: 'node', format: 'cjs', outfile, write: true, metafile: true, logLevel: 'silent',
      external: boundary.desktopSourceExternals(sourceEntry, ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate']), plugins: [electronShim]
    })
    assert.equal(Object.keys(built.metafile.inputs).some(file => /node_modules\/(?:exceljs|unzipper|@aws-sdk)\//.test(file)), false)
    assert.ok(Object.values(built.metafile.outputs).some(output => output.imports.some(item => item.external && item.path === 'exceljs')))
    const api = require(outfile)
    assert.equal(typeof api.runCommand, 'function')
    assert.ok(api.buildToolSpecs(true).some(tool => tool.function.name === 'generate_xlsx_doc'))
    const file = path.join(directory, '真实中文.xlsx')
    const rows = [['中文标题', '数量'], ['灯塔 🌊', 42], ['第二行', '=不是公式']]
    const result = await api.executeTool('generate_xlsx_doc', { path: file, sheetName: '实际工具', rows }, directory, { workDir: directory, docDir: directory })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.path, file)
    assert.equal(result.size, fs.statSync(file).size)
    const receipt = boundary.verifyDesktopExcelJsBoundary(sourceEntry)
    const realRequire = createRequire(path.join(receipt.root, 'package.json'))
    const ExcelJS = realRequire('exceljs')
    const restored = new ExcelJS.Workbook()
    await restored.xlsx.read(fs.createReadStream(file))
    assert.deepEqual(restored.worksheets.map(sheet => sheet.name), ['实际工具'])
    assert.equal(restored.worksheets[0].rowCount, 3)
    assert.equal(restored.worksheets[0].columnCount, 2)
    for (let index = 0; index < rows.length; index++) assert.deepEqual(restored.worksheets[0].getRow(index + 1).values.slice(1), rows[index].map(String))
    const listing = await api.agentTools.find(tool => tool.name === 'list_files').execute({ path: directory, depth: 1 }, directory, { workDir: directory, docDir: directory })
    assert.equal(listing.ok, true, listing.message)
    assert.match(listing.message, /真实中文\.xlsx/)
  } finally { delete require.cache[outfile]; fs.rmSync(directory, { recursive: true, force: true }) }
})
