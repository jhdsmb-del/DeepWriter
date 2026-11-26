const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const { crc32, deflateSync } = require('node:zlib')
const { applyProductionFixture, productionPatch } = require('./fixtures/galgame-production.cjs')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export * from './src/main/galgameStudio';
    export {validateStudioStory} from './src/main/galgameProduction';
    export {generateScenePatch,applyRenpyPatch,buildBranchGraph} from './src/main/galgame';
    export {runRenpyLint} from './src/main/renpySdk';
    export {grillMeOutlineHash} from './src/shared/grillMe';
    export {studioGate} from './src/shared/galgameStudio';
  ` }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports); api = loaded.exports
})
function pixel(red = 255, green = 255, blue = 255) {
  const chunk = (name, data) => { const body = Buffer.concat([Buffer.from(name), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), out.length - 4); return out }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0,red,green,blue,255]))), chunk('IEND', Buffer.alloc(0))])
}
async function setup(dir, options = {}) {
  const project = await api.createRenpyProject({ parentDir: dir, name: options.name ?? '雨夜 来信', sessionId: 'session' })
  if (options.imported) { project.mode = 'import'; await fs.writeFile(path.join(project.projectDir, 'game/script/script.rpy'), 'label start:\n    "作者已完成的开场。"\n    return\n') }
  const sprite = path.join(dir, 'hero.png'), background = path.join(dir, 'room.png')
  await fs.writeFile(sprite, pixel(255,0,0)); await fs.writeFile(background, pixel(0,0,255))
  const outline = { title: '雨夜来信', premise: '等候一封旧信。', targetChars: 1000, sections: [{ id: 's1', title: '信封', purpose: '辨认字迹', targetChars: 500, beats: ['拿起信封'], sourceSlotIds: [] }, { id: 's2', title: '邮戳', purpose: '确定去向', targetChars: 500, beats: ['看清邮戳'], sourceSlotIds: [] }] }
  const grill = { sessionId: 'session', stateId: 'grill', status: 'confirmed', approvedOutline: outline, outlineHash: api.grillMeOutlineHash(outline) }
  let calls = 0
  const sdk = { root: dir, source: 'explicit', version: '8.5.3', pythonPath: 'python', renpyScriptPath: 'renpy.py', verifiedAt: 1, command: 'fixture --version' }
  const manifest = { schemaVersion: 1, characters: [{ id: 'hero', name: '夏澄', setting: '不肯承认自己一直在等回信', personality: '克制', notes: '不替对方作决定' }], sprites: [{ id: 'hero_default', characterId: 'hero', expression: 'default', fileRefId: 'sprite' }], backgrounds: [{ id: 'room', name: '门厅', fileRefId: 'background' }], audio: [] }
  const service = new api.GalgameStudioService({ baseDir: path.join(dir, 'state'), getGrillState: async () => grill, resolveAssetRef: async id => ({ realpath: id === 'sprite' ? sprite : background, displayName: id + '.png' }), inspectSdk: async () => ({ candidate: { evidence: sdk, layout: {} } }), lint: async () => ({ ok: true, verified: true, output: '', exitCode: 0, command: 'fixture lint' }), runProductionAgent: async input => { calls++; return options.agent ? options.agent(input) : applyProductionFixture(api, input, { branch: options.branch }) } })
  const state = await service.create({ sessionId: 'session', project })
  await service.save({ ...state, sdkReady: true, sdk })
  assert.equal((await service.setAssets(state.studioId, { manifest })).ok, true)
  await service.confirmOutlineBranch(state.studioId, { outlineHash: grill.outlineHash, branchHash: (await service.snapshot(state.studioId)).branchHash })
  return { service, id: state.studioId, project, grill, manifest, calls: () => calls }
}
async function sandbox(body) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-studio-production-')); try { await body(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) } }
const inventory = async dir => {
  const files = (await fs.readdir(dir, { recursive: true, withFileTypes: true })).filter(x => x.isFile())
  return Promise.all(files.map(async f => { const file = path.join(f.parentPath, f.name); return [path.relative(dir, file), (await fs.readFile(file)).toString('base64')] })).then(x => x.sort(([a], [b]) => a.localeCompare(b)))
}

test('confirmed story is reachable; real writes and lint are distinct; repeats preserve author edits', () => sandbox(async dir => {
  const h = await setup(dir, { branch: true })
  const generated = await h.service.generate(h.id)
  assert.equal(generated.ok, true, generated.error)
  assert.equal(generated.production.integration, 'connected')
  assert.equal((await h.service.get(h.id)).stage, 'lint/repair')
  assert.equal((await h.service.get(h.id)).lint, null)
  const graph = await api.buildBranchGraph(h.project.projectDir)
  assert.deepEqual(graph.diagnostics.filter(x => /missing|unreachable|duplicate/.test(x.code)), [])
  assert.ok(graph.edges.some(x => x.choice?.includes('拆开')))
  assert.ok(graph.edges.some(x => x.choice?.includes('留在')))
  const choices = graph.edges.filter(x => x.choice)
  const closedRoom = choices.find(x => x.choice.includes('留在')).to
  assert.equal(graph.edges.some(x => x.from === closedRoom && x.to.endsWith('_scene_2')), false, 'staying home does not silently enter the train ending')
  const renamedChoice = structuredClone(graph); renamedChoice.edges.find(x => x.choice).choice += '（改选项）'
  assert.notEqual(api.hashGalgameBranchGraph(graph), api.hashGalgameBranchGraph(renamedChoice))
  await fs.appendFile(generated.generatedFile, '\n# 作者的修改，重试不得消失\n')
  const before = await inventory(path.join(h.project.projectDir, 'game'))
  assert.equal((await h.service.generate(h.id)).generatedFile, generated.generatedFile)
  assert.equal(h.calls(), 1)
  assert.deepEqual(await inventory(path.join(h.project.projectDir, 'game')), before)
  await h.service.lintStudio(h.id)
  assert.equal((await h.service.get(h.id)).stage, 'done')
}))

test('linear outline stays linear; imported start and same-name files/assets are never replaced', () => sandbox(async dir => {
  const h = await setup(dir, { imported: true })
  const original = await fs.readFile(path.join(h.project.projectDir, 'game/script/script.rpy'), 'utf8')
  const sameName = path.join(h.project.projectDir, 'game/deepwriter_generated.rpy')
  await fs.writeFile(sameName, '# authored same-name file\n')
  await fs.writeFile(path.join(h.project.projectDir, 'game/images/characters/hero_default.png'), 'authors original art')
  // File inventory changed after confirmation: a fresh plan confirmation is required.
  await h.service.confirmOutlineBranch(h.id, { branchHash: (await h.service.snapshot(h.id)).branchHash })
  const generated = await h.service.generate(h.id)
  assert.equal(generated.ok, true, generated.error)
  assert.equal(generated.production.integration, 'required')
  assert.match(generated.production.message, new RegExp(`call ${generated.production.entryLabel}`))
  assert.doesNotMatch(await fs.readFile(generated.generatedFile, 'utf8'), /menu:|"继续"/)
  assert.equal(await fs.readFile(sameName, 'utf8'), '# authored same-name file\n')
  assert.equal(await fs.readFile(path.join(h.project.projectDir, 'game/images/characters/hero_default.png'), 'utf8'), 'authors original art')
  assert.equal(await fs.readFile(path.join(h.project.projectDir, 'game/script/script.rpy'), 'utf8'), original)
  await h.service.lintStudio(h.id)
  assert.equal((await h.service.get(h.id)).stage, 'lint/repair')
  assert.equal(api.studioGate(await h.service.get(h.id), 'done').ok, false)
  // The author chooses the exact integration location; Studio observes it.
  await fs.writeFile(path.join(h.project.projectDir, 'game/script/script.rpy'), original.replace('    return', `    call ${generated.production.entryLabel}\n    return`))
  await h.service.lintStudio(h.id)
  assert.equal((await h.service.get(h.id)).production.integration, 'connected')
  assert.equal((await h.service.get(h.id)).stage, 'done')
}))

test('no-op, truncated, cosmetic-menu and failed retries never publish or finish', () => sandbox(async dir => {
  for (const mode of ['noop', 'truncated', 'cosmetic', 'identical', 'error', 'handoff']) {
    const h = await setup(dir, { name: mode, agent: async input => {
      if (mode === 'error') throw new Error('fixture network failure')
      if (mode === 'handoff') return { status: 'skeleton_handoff', message: 'fixture model unavailable' }
      if (mode !== 'noop') {
        const patch = await productionPatch(input, { branch: mode === 'identical' })
        if (mode === 'identical') {
          const lines = patch.operations[0].lines
          const responses = lines.map((line, i) => /钥匙还在信封|我把门灯留/.test(line) ? i : -1).filter(i => i >= 0)
          lines[responses[1]] = lines[responses[0]]
          const waitReturn = responses[1] + 1
          lines[waitReturn] = lines[responses[0] + 1]
        } else if (mode === 'truncated') patch.operations[0].lines.pop()
        else {
          const first = patch.operations[0].lines.findIndex(x => /label .*_scene_1:/.test(x))
          patch.operations[0].lines.splice(first + 2, 0, '    menu:', '        "继续":', '            "毫无选择。"')
        }
        await api.applyRenpyPatch({ projectDir: input.projectDir, patch })
      }
      return { status: 'agent_applied', message: 'fixture claimed success' }
    } })
    const before = await inventory(path.join(h.project.projectDir, 'game'))
    const result = await h.service.generate(h.id)
    assert.equal(result.ok, false, mode)
    assert.equal(result.production.completedAt, null)
    assert.equal((await h.service.get(h.id)).stage, 'generate')
    assert.equal((await h.service.get(h.id)).generatedFile, null)
    assert.deepEqual(await inventory(path.join(h.project.projectDir, 'game')), before)
    assert.equal((await h.service.generate(h.id)).ok, false)
    assert.deepEqual(await inventory(path.join(h.project.projectDir, 'game')), before)
  }
}))

test('plan drift blocks writes; concurrent generation is exclusive; changed assets invalidate confirmation', () => sandbox(async dir => {
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const h = await setup(dir, { agent: async input => { started(); await new Promise(resolve => { release = resolve }); return applyProductionFixture(api, input) } })
  const pending = h.service.generate(h.id)
  await ready
  await assert.rejects(h.service.generate(h.id), /正在制作/)
  const newAssets = structuredClone(h.manifest); newAssets.characters[0].setting = '已改变的人物设定'
  await h.service.setAssets(h.id, { manifest: newAssets })
  release()
  assert.equal((await pending).ok, false)
  assert.equal((await h.service.get(h.id)).outlineBranchConfirmed, false)
  assert.equal((await fs.readdir(path.join(h.project.projectDir, 'game'))).some(x => x.startsWith('deepwriter_')), false)
}))

test('Studio model request carries complete long outline, new-label contract and exact target anchor', () => sandbox(async dir => {
  let seen
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    seen = JSON.parse(body)
    const patch = { file: 'game/story.rpy', operations: [{ op: 'insert_after', anchor: '    # fixture insertion', lines: ['    "模型接口 fixture。"', '    return'] }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(patch) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await fs.mkdir(path.join(dir, 'game')); await fs.writeFile(path.join(dir, 'game/story.rpy'), 'label start:\n    # fixture insertion\n')
    const result = await api.generateScenePatch({ projectDir: dir, sceneSpec: '详细大纲'.repeat(1200) + '\nMARKER_AFTER_3000', studioProduction: true, api: { apiKey: '', model: 'local-fixture', baseUrl: `http://127.0.0.1:${server.address().port}`, maxTokens: 1024, provider: { baseUrl: `http://127.0.0.1:${server.address().port}`, adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat', reasoning: { mode: 'disabled', effort: null }, compatibilityMappingId: null, authStyle: 'none', chatPath: '/v1/chat/completions', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } } } })
    assert.equal(result.ok, true, result.error)
    assert.match(seen.messages.find(x => x.role === 'user').content, /MARKER_AFTER_3000/)
    assert.match(seen.messages.find(x => x.role === 'system').content, /允许.*新增 label/)
    assert.equal((await fs.readFile(path.join(dir, 'game/story.rpy'), 'utf8')).includes('模型接口'), false)
  } finally { await new Promise(resolve => server.close(resolve)) }
}))

const realSdks = process.env.DW_RENPY_PRODUCTION_SDKS ? JSON.parse(process.env.DW_RENPY_PRODUCTION_SDKS) : []
test('real RenPy lint checks published linear and branching production fixtures, not just scaffolds', { skip: realSdks.length === 0, timeout: 180000 }, async () => {
  const output = path.join(root, 'out', 'galgame-production-' + Date.now()); await fs.mkdir(output, { recursive: true })
  for (const sdk of realSdks) for (const branch of [false, true]) {
    const dir = path.join(output, path.basename(sdk) + '-' + (branch ? 'branch' : 'linear')); await fs.mkdir(dir)
    const h = await setup(dir, { branch })
    // setup uses a fixture inspector; actual validation is deliberately separate.
    const realService = new api.GalgameStudioService({ baseDir: path.join(dir, 'real-sdk') })
    const restored = await h.service.get(h.id); await realService.save(restored)
    const actual = await realService.inspectSdk(h.id, sdk)
    assert.equal(actual.status, 'ready', actual.message)
    const generated = await h.service.generate(h.id)
    assert.equal(generated.ok, true, generated.error)
    const lint = await api.runRenpyLint(actual.candidate.layout, h.project.projectDir)
    assert.equal(lint.ok, true, lint.output); assert.equal(lint.verified, true)
    const graph = await api.buildBranchGraph(h.project.projectDir)
    assert.deepEqual(graph.diagnostics.filter(d => /unreachable|missing|duplicate/.test(d.code)), [])
    await fs.writeFile(path.join(dir, 'evidence.json'), JSON.stringify({ sdk: actual.candidate.evidence, model: 'deterministic local production fixture; no paid model', generated, lint, graph }, null, 2))
    console.log(`REAL RenPy ${actual.candidate.version} ${branch ? 'branching' : 'linear'} published story lint PASS: ${dir}`)
  }
})
