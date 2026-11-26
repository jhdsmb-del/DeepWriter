const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { before, test } = require('node:test')
const { crc32, deflateSync } = require('node:zlib')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export {buildGalgameNames,GalgameStudioService,createRenpyProject} from './src/main/galgameStudio';
    export {inspectRenpySdk,runRenpyLint} from './src/main/renpySdk';
    export {grillMeOutlineHash} from './src/shared/grillMe';
  ` }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  api = loaded.exports
})
const snapshot = names => Object.fromEntries(Object.entries(names).map(([key, value]) => [key, [...value].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]))
const character = id => ({ id, name: id, setting: '人物设定' })
const sprite = (id, characterId, expression) => ({ id, characterId, expression, fileRefId: id })

test('unique English names retain their existing tags and filename stems', () => {
  const names = api.buildGalgameNames({ characters: [character('hero')], sprites: [sprite('hero_happy', 'hero', 'happy')], backgrounds: [{ id: 'room' }], audio: [{ id: 'theme' }] })
  assert.equal(names.characters.get('hero'), 'dw_hero')
  assert.equal(names.sprites.get('hero_happy'), 'dw_hero_happy')
  assert.equal(names.backgrounds.get('room'), 'dw_bg_room')
  assert.equal(names.assetStems.get('hero_happy'), 'hero_happy')
  assert.equal(names.assetStems.get('theme'), 'theme')
})

test('Chinese/English normalization collisions stay distinct across images, variables and case-insensitive files', () => {
  const manifest = {
    characters: [character('角色'), character('character'), character('narrator'), character('bg')],
    sprites: [sprite('Smile', '角色', '微笑'), sprite('smile', '角色', '惊讶'), sprite('默认', '角色', 'default'), sprite('cross', 'bg', 'room')],
    backgrounds: [{ id: '场景' }, { id: 'background' }, { id: 'room' }], audio: [{ id: '音乐' }, { id: 'asset' }]
  }
  const names = api.buildGalgameNames(manifest)
  assert.equal(new Set(names.characters.values()).size, manifest.characters.length)
  assert.ok(![...names.characters.values()].includes('dw_narrator'))
  assert.equal(new Set([...names.sprites.values(), ...names.backgrounds.values()]).size, 7)
  assert.notEqual(names.sprites.get('Smile'), names.sprites.get('默认'))
  assert.notEqual(names.sprites.get('cross'), names.backgrounds.get('room'))
  assert.notEqual(names.assetStems.get('Smile').toLowerCase(), names.assetStems.get('smile').toLowerCase())
  assert.notEqual(names.assetStems.get('音乐'), names.assetStems.get('asset'))
  const reversed = Object.fromEntries(Object.entries(manifest).map(([key, items]) => [key, [...items].reverse()]))
  assert.deepEqual(snapshot(api.buildGalgameNames(reversed)), snapshot(names), 'mapping does not depend on array order')
})

function pixel(red, green, blue) {
  const chunk = (name, data) => { const body = Buffer.concat([Buffer.from(name), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), out.length - 4); return out }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0,red,green,blue,255]))), chunk('IEND', Buffer.alloc(0))])
}

test('two different PNGs and Chinese expressions keep their own images, first staging and Agent references', { timeout: 60000 }, async t => {
  const realSdk = process.env.DW_RENPY_NAMES_SDK
  const output = realSdk ? path.join(root, 'out', 'renpy-compat', 'names-' + Date.now()) : await fs.mkdtemp(path.join(os.tmpdir(), 'dw-renpy-names-'))
  await fs.mkdir(output, { recursive: true })
  try {
    const red = pixel(255, 0, 0), blue = pixel(0, 0, 255)
    assert.notDeepEqual(red, blue)
    const sourceFiles = { smile: path.join(output, 'smile.png'), surprise: path.join(output, 'surprise.png'), room: path.join(output, 'room.png') }
    await fs.writeFile(sourceFiles.smile, red); await fs.writeFile(sourceFiles.surprise, blue); await fs.writeFile(sourceFiles.room, pixel(32,32,32))
    const project = await api.createRenpyProject({ parentDir: output, name: '两个中文表情', sessionId: 'name-fixture' })
    const manifest = {
      schemaVersion: 1, characters: [character('夏澄')],
      sprites: [sprite('微笑图', '夏澄', '微笑'), sprite('惊讶图', '夏澄', '惊讶')].map((item, i) => ({ ...item, fileRefId: i === 0 ? 'smile' : 'surprise' })),
      backgrounds: [{ id: '门厅', name: '门厅', fileRefId: 'room' }], audio: []
    }
    const names = api.buildGalgameNames(manifest)
    const outline = { title: '门外的来信', premise: '夏澄在门口收到一封信。', targetChars: 1000, sections: [{ id: 'arrival', title: '开门', purpose: '辨认来信', targetChars: 1000, beats: ['从微笑变为惊讶'], sourceSlotIds: [] }] }
    const outlineHash = api.grillMeOutlineHash(outline)
    const grill = { stateId: 'grill', sessionId: 'name-fixture', status: 'confirmed', approvedOutline: outline, outlineHash }
    let sceneSpec, generatedBeforeAgent
    const service = new api.GalgameStudioService({
      baseDir: output, getGrillState: async () => grill,
      resolveAssetRef: async id => ({ realpath: sourceFiles[id], displayName: id + '.png' }),
      runProductionAgent: async input => {
        sceneSpec = input.sceneSpec
        const target = path.join(input.projectDir, input.targetFile)
        generatedBeforeAgent = await fs.readFile(target, 'utf8')
        const smileTag = names.sprites.get('微笑图'), surpriseTag = names.sprites.get('惊讶图'), speaker = names.characters.get('夏澄')
        // Deterministic local consumer of the actual Agent handoff. No model
        // is called and this scaffold is not reported as a completed story.
        const calls = `\n    show ${smileTag}\n    ${speaker} "我以为是你的回信。"\n    hide ${smileTag}\n    show ${surpriseTag}\n    ${speaker} "上面怎么是我的名字？"\n    hide ${surpriseTag}`
        await fs.writeFile(target, generatedBeforeAgent.replace('    # DeepWriter Agent insertion point', '    # DeepWriter Agent insertion point' + calls))
        return { status: 'skeleton_handoff', message: 'local naming fixture only' }
      }
    })
    const studio = await service.create({ sessionId: 'name-fixture', project })
    let candidate
    if (realSdk) {
      const inspected = await service.inspectSdk(studio.studioId, realSdk)
      assert.equal(inspected.status, 'ready', inspected.message)
      candidate = inspected.candidate
    } else {
      await service.save({ ...studio, sdkReady: true })
    }
    assert.equal((await service.setAssets(studio.studioId, { manifest })).ok, true)
    const state = await service.snapshot(studio.studioId)
    await service.confirmOutlineBranch(studio.studioId, { outlineHash, branchHash: state.branchHash })
    const result = await service.generate(studio.studioId)
    assert.equal(result.production.status, 'skeleton_handoff')
    const definitions = [...generatedBeforeAgent.matchAll(/^image (\w+) = "([^"]+)"$/gm)]
    assert.equal(new Set(definitions.map(match => match[1])).size, 3)
    const smileTag = names.sprites.get('微笑图'), surpriseTag = names.sprites.get('惊讶图')
    assert.notEqual(smileTag, surpriseTag)
    const imagePath = tag => path.join(project.projectDir, 'game', definitions.find(match => match[1] === tag)[2])
    assert.deepEqual(await fs.readFile(imagePath(smileTag)), red)
    assert.deepEqual(await fs.readFile(imagePath(surpriseTag)), blue)
    assert.notEqual(imagePath(smileTag), imagePath(surpriseTag))
    assert.equal(/^    show (\w+)/m.exec(generatedBeforeAgent)[1], smileTag)
    assert.equal(/^    scene (\w+)/m.exec(generatedBeforeAgent)[1], names.backgrounds.get('门厅'))
    assert.ok(sceneSpec.includes(`微笑（素材 微笑图）`) && sceneSpec.includes(`image ${smileTag}；调用：show ${smileTag}`))
    assert.ok(sceneSpec.includes(`惊讶（素材 惊讶图）`) && sceneSpec.includes(`image ${surpriseTag}；调用：show ${surpriseTag}`))
    assert.ok(sceneSpec.includes(`对白变量：${names.characters.get('夏澄')}`))
    assert.ok(sceneSpec.includes(`调用：scene ${names.backgrounds.get('门厅')}`))
    const script = await fs.readFile(result.generatedFile, 'utf8')
    assert.ok(script.includes(`show ${smileTag}`) && script.includes(`show ${surpriseTag}`))
    // Only this newly created test project's entry point is updated.
    await fs.writeFile(path.join(project.projectDir, 'game', 'script', 'script.rpy'), 'label start:\n    jump dw_start\n')
    let lint = null
    if (candidate) {
      lint = await api.runRenpyLint(candidate.layout, project.projectDir)
      assert.equal(lint.ok, true, lint.output)
      await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify({ sdk: candidate.evidence, project, generatedFile: result.generatedFile, names: snapshot(names), sceneSpec, lint }, null, 2))
      console.log(`REAL Ren'Py ${candidate.version}: distinct red/blue Chinese expressions + correct staging/Agent names + lint PASS; ${output}`)
    } else t.diagnostic('real SDK lint not requested; file/Agent mapping assertions still exercised')
  } finally {
    if (!realSdk) await fs.rm(output, { recursive: true, force: true })
  }
})
