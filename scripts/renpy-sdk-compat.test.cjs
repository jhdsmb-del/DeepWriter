const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const { crc32, deflateSync } = require('node:zlib')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export * from './src/main/renpySdk';
    export {GalgameStudioService,createRenpyProject} from './src/main/galgameStudio';
    export {lintRenpyProject} from './src/main/galgame';
    export {createGalgameStudioState} from './src/shared/galgameStudio';
    export {grillMeOutlineHash} from './src/shared/grillMe';
  ` }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  api = loaded.exports
})
const sandbox = async body => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-renpy-compat-'))
  try { await body(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
async function fixtureSdk(dir, version = '8.5.2', runtime = 'py3-windows-x86_64') {
  await Promise.all(['renpy', 'launcher/game', 'lib/' + runtime].map(name => fs.mkdir(path.join(dir, name), { recursive: true })))
  await fs.writeFile(path.join(dir, 'renpy.py'), '# fixture: never executed')
  await fs.writeFile(path.join(dir, 'renpy.exe'), '')
  await fs.writeFile(path.join(dir, 'launcher/game/project.rpy'), '# SDK launcher fixture')
  await fs.writeFile(path.join(dir, 'renpy/vc_version.py'), `version = u'${version}.12345678'`)
  await fs.writeFile(path.join(dir, 'renpy/lint.py'), '# --error-code')
  await fs.writeFile(path.join(dir, 'lib', runtime, 'python.exe'), '')
  return dir
}
const runner = version => async () => ({ code: 0, output: `Ren'Py ${version}.12345678` })

test('7 uses bundled Python 2 (including i686/legacy layout), 8 uses Python 3', () => sandbox(async dir => {
  for (const [version, runtime, pythonMajor] of [['7.8.7', 'py2-windows-x86_64', 2], ['7.8.7', 'py2-windows-i686', 2], ['7.3.5', 'windows-i686', 2], ['8.5.2', 'py3-windows-x86_64', 3]]) {
    const sdk = await fixtureSdk(path.join(dir, runtime), version, runtime)
    const result = await api.inspectRenpySdk({ userDataDir: dir, explicitPath: sdk, runCommand: runner(version) })
    assert.equal(result.status, 'ready', result.message)
    assert.equal(result.candidate.version, version)
    assert.equal(result.candidate.layout.pythonMajor, pythonMajor)
    assert.equal(result.candidate.layout.pythonPath, path.join(sdk, 'lib', runtime, 'python.exe'))
  }
}))

test('SDK root, renpy.exe, renpy.py, bundled interpreter and wrapper select the same SDK', () => sandbox(async dir => {
  const sdk = await fixtureSdk(path.join(dir, 'wrapper', 'renpy-8.5.2-sdk'))
  for (const selected of [sdk, path.join(sdk, 'renpy.exe'), path.join(sdk, 'renpy.py'), path.join(sdk, 'lib/py3-windows-x86_64/python.exe'), path.join(sdk, 'lib/py3-windows-x86_64'), path.dirname(sdk)]) {
    assert.equal((await api.resolveRenpySdkLayout(selected)).root, sdk)
  }
}))

test('an invalid explicit SDK never falls back to managed/discovered SDK or runs another executable', () => sandbox(async dir => {
  const managed = path.join(api.managedSdkInstallsDir(dir), 'valid')
  await fixtureSdk(managed, '8.5.3')
  const discovered = await fixtureSdk(path.join(dir, 'downloads', 'renpy-8.5.2-sdk'))
  let calls = 0
  const result = await api.inspectRenpySdk({ userDataDir: dir, explicitPath: path.join(dir, 'removed-sdk'), discoveryRoots: [path.dirname(discovered)], runCommand: async () => { calls++; return { code: 0, output: "Ren'Py 8.5.3" } } })
  assert.equal(result.status, 'invalid')
  assert.match(result.message, /路径不存在/)
  assert.equal(result.managed.checked, 0)
  assert.equal(result.discovered.checked, 0)
  assert.equal(calls, 0)
}))

test('distributed game and incomplete SDK fail before any command is executed', () => sandbox(async dir => {
  const game = await fixtureSdk(path.join(dir, 'a-game'))
  await fs.rm(path.join(game, 'launcher'), { recursive: true })
  let calls = 0
  const result = await api.inspectRenpySdk({ userDataDir: dir, explicitPath: game, runCommand: async () => { calls++; return { code: 0, output: "Ren'Py 8.5.2" } } })
  assert.equal(result.status, 'invalid')
  assert.match(result.message, /游戏目录或不完整 SDK/)
  assert.equal(calls, 0)
  const lint = await api.lintRenpyProject(path.join(game, 'renpy.exe'), path.join(dir, 'project'))
  assert.equal(lint.ok, false)
  assert.match(lint.output, /不会启动/)
}))

test('release identity, Python line and lint error-exit capability are not guessed', () => sandbox(async dir => {
  const sdk = await fixtureSdk(path.join(dir, 'sdk'))
  const mismatch = await api.inspectRenpySdk({ userDataDir: dir, explicitPath: sdk, runCommand: runner('8.5.3') })
  assert.equal(mismatch.status, 'invalid')
  assert.match(mismatch.message, /版本身份不一致/)
  await fs.writeFile(path.join(sdk, 'renpy/vc_version.py'), "version='7.8.7.1'")
  await assert.rejects(api.resolveRenpySdkLayout(sdk), /Python 2/)
  await fs.writeFile(path.join(sdk, 'renpy/vc_version.py'), "version='8.5.2.1'")
  await fs.writeFile(path.join(sdk, 'renpy/lint.py'), '# no exit status contract')
  await assert.rejects(api.resolveRenpySdkLayout(sdk), /lint --error-code/)
}))

test('local 8.5.2 is allowed but the managed downloader remains pinned to its manifest', () => sandbox(async dir => {
  const layout = await api.resolveRenpySdkLayout(await fixtureSdk(path.join(dir, 'sdk')))
  assert.equal((await api.validateRenpySdkLayout(layout, { source: 'explicit', runCommand: runner('8.5.2') })).version, '8.5.2')
  await assert.rejects(api.validateRenpySdkLayout(layout, { source: 'managed', runCommand: runner('8.5.2') }), /托管下载固定为 8.5.3/)
}))

test('both lines keep exact argv order and Unicode/space paths; failures expose the process result', () => sandbox(async dir => {
  const sdk = await fixtureSdk(path.join(dir, 'SDK with spaces'))
  const layout = await api.resolveRenpySdkLayout(sdk), project = path.join(dir, '雨夜 来信')
  let invocation
  const lint = await api.runRenpyLint(layout, project, { runCommand: async (...args) => { invocation = args; return { code: 1, output: 'line 3: expected statement' } } })
  assert.deepEqual(invocation.slice(0, 3), [layout.pythonPath, ['renpy.py', project, 'lint', '--error-code'], sdk])
  assert.equal(lint.ok, false)
  assert.equal(lint.exitCode, 1)
  assert.match(lint.output, /line 3/)
  const inspected = await api.inspectRenpySdk({ userDataDir: dir, explicitPath: sdk, runCommand: async () => ({ code: 5, output: 'runtime DLL not found' }) })
  assert.match(inspected.message, /exit 5.*runtime DLL not found/)
}))

test('changing SDK invalidates only lint; same SDK preserves it and persisted state survives reopen', () => sandbox(async dir => {
  const firstRoot = await fixtureSdk(path.join(dir, 'first'), '8.5.2')
  const secondRoot = await fixtureSdk(path.join(dir, 'second'), '7.8.7', 'py2-windows-x86_64')
  const inspect = input => api.inspectRenpySdk({ userDataDir: dir, ...input, runCommand: async (_command, _args, cwd) => ({ code: 0, output: cwd === firstRoot ? "Ren'Py 8.5.2" : "Ren'Py 7.8.7" }) })
  let started, complete
  const lintStarted = new Promise(resolve => { started = resolve })
  const service = new api.GalgameStudioService({ baseDir: dir, inspectSdk: inspect, lint: async () => { started(); return new Promise(resolve => { complete = resolve }) } })
  const original = api.createGalgameStudioState({ studioId: 'fixture', sessionId: 'session', projectId: 'project', projectDir: dir, projectMode: 'create', projectName: 'fixture' })
  const first = await inspect({ explicitPath: firstRoot })
  const done = { ...original, sdkReady: true, sdk: first.candidate.evidence, assetsReady: true, assets: { kept: true }, grillConfirmed: true, outlineBranchConfirmed: true, outlineHash: 'outline', branchHash: 'branch', generatedFile: path.join(dir, 'game/script.rpy'), production: { status: 'agent_applied' }, lint: { ok: true, verified: true, command: 'first SDK lint' }, stage: 'done' }
  await service.save(done)
  await service.inspectSdk('fixture', firstRoot)
  assert.deepEqual((await service.get('fixture')).lint, done.lint)
  const pendingLint = service.lintStudio('fixture')
  await lintStarted
  await service.inspectSdk('fixture', secondRoot)
  complete({ ok: true, verified: true, output: '', command: 'late old SDK lint', exitCode: 0 })
  await assert.rejects(pendingLint, /SDK 已变化/)
  const changed = await new api.GalgameStudioService({ baseDir: dir }).get('fixture')
  assert.equal(changed.sdk.version, '7.8.7')
  assert.equal(changed.lint, null)
  assert.equal(changed.stage, 'lint/repair')
  for (const key of ['assets', 'outlineHash', 'branchHash', 'generatedFile', 'production']) assert.deepEqual(changed[key], done[key])
}))

function pixel() {
  const chunk = (name, data) => { const body = Buffer.concat([Buffer.from(name), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), out.length - 4); return out }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0,255,255,255,255]))), chunk('IEND', Buffer.alloc(0))])
}

// Explicit opt-in only. No download, system installation, model, or arbitrary
// existing project is run. Artifacts remain under the caller's out/ directory.
const realSdks = process.env.DW_RENPY_TEST_SDKS ? JSON.parse(process.env.DW_RENPY_TEST_SDKS) : []
test('real SDKs create and generate a project, reject broken syntax, then pass lint', { skip: realSdks.length === 0, timeout: 180000 }, async () => {
  const evidenceRoot = path.join(root, 'out', 'renpy-compat', 'evidence-' + Date.now())
  await fs.mkdir(evidenceRoot, { recursive: true })
  const results = []
  for (const sdkPath of realSdks) {
    const inspection = await api.inspectRenpySdk({ userDataDir: evidenceRoot, explicitPath: sdkPath })
    assert.equal(inspection.status, 'ready', inspection.message)
    const candidate = inspection.candidate, output = path.join(evidenceRoot, candidate.version)
    await fs.mkdir(output)
    const project = await api.createRenpyProject({ parentDir: output, name: '雨夜 来信', sessionId: 'compatibility-local' })
    const sprite = path.join(output, 'hero.png'), background = path.join(output, 'room.png')
    await fs.writeFile(sprite, pixel()); await fs.writeFile(background, pixel())
    const outline = { title: '雨夜来信', premise: '门外有封未署名的信。', targetChars: 1000, sections: [{ id: 'arrival', title: '门口', purpose: '决定是否开门', targetChars: 500, beats: ['听见敲门声'], sourceSlotIds: [] }, { id: 'choice', title: '回信', purpose: '选择给出回答', targetChars: 500, beats: ['写下第一句'], sourceSlotIds: [] }] }
    const outlineHash = api.grillMeOutlineHash(outline)
    const grill = { stateId: 'fixture-grill', sessionId: 'compatibility-local', status: 'confirmed', outline, approvedOutline: outline, outlineHash }
    const service = new api.GalgameStudioService({ baseDir: output, getGrillState: async () => grill, resolveAssetRef: async id => ({ realpath: id === 'sprite' ? sprite : background, displayName: id + '.png' }) })
    const studio = await service.create({ sessionId: 'compatibility-local', project })
    await service.inspectSdk(studio.studioId, sdkPath)
    const assets = await service.setAssets(studio.studioId, { manifest: { schemaVersion: 1, characters: [{ id: 'hero', name: '夏澄', setting: '谨慎，等候回信。' }], sprites: [{ id: 'hero_default', characterId: 'hero', expression: 'default', fileRefId: 'sprite' }], backgrounds: [{ id: 'room', name: '门厅', fileRefId: 'background' }], audio: [] } })
    assert.equal(assets.ok, true)
    const snapshot = await service.snapshot(studio.studioId)
    await service.confirmOutlineBranch(studio.studioId, { outlineHash, branchHash: snapshot.branchHash })
    const generated = await service.generate(studio.studioId)
    assert.equal(generated.production.status, 'skeleton_handoff', 'No model was invoked; this is the real Studio scaffold, not a completed story')
    assert.ok(generated.generatedFile)
    const brokenFile = path.join(project.projectDir, 'game', 'deliberately_broken.rpy')
    await fs.writeFile(brokenFile, 'label incompatible_fixture:\n    if\n')
    const broken = await api.runRenpyLint(candidate.layout, project.projectDir)
    assert.equal(broken.ok, false, broken.output)
    assert.notEqual(broken.exitCode, 0)
    await fs.unlink(brokenFile)
    const lint = await api.runRenpyLint(candidate.layout, project.projectDir)
    assert.equal(lint.ok, true, lint.output)
    const record = { sdk: candidate.evidence, project, generatedFile: generated.generatedFile, production: generated.production.status, broken, lint }
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(record, null, 2))
    results.push(record)
    console.log(`REAL Ren'Py ${candidate.version}: generated scaffold + invalid syntax rejection + lint PASS; ${output}`)
  }
  await fs.writeFile(path.join(evidenceRoot, 'summary.json'), JSON.stringify(results, null, 2))
})
