const assert = require('node:assert/strict')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const compiled = buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: "export {readRunManuscript} from './src/main/manuscriptView'; export {saveManuscriptDraft,manuscriptDraftInfo} from './src/main/manuscriptDraftExport'; export {runsSaveDraftSchema} from './src/shared/ipcSchemas'" }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
const moduleValue = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, moduleValue, moduleValue.exports)
const { readRunManuscript } = moduleValue.exports
const hash = text => createHash('sha256').update(text).digest('hex')
function fixture(status = 'completed', delivered = '已收稿第一节。\n\n已收稿第二节。') {
  const rows = [
    { status: 'accepted', kind: 'prose', section_id: 'first', content: '已收稿第一节。' },
    { status: 'partial', kind: 'prose', section_id: 'second', content: '不完整残句' },
    { status: 'candidate', kind: 'prose', section_id: 'second', content: '尚未经审校的完整候选。' },
    { status: 'accepted', kind: 'prose', section_id: 'second', content: '已收稿第二节。' },
    { status: 'accepted', kind: 'report', content: '模型说已完成。' }
  ]
  const repo = { getRun: () => ({ status, config_json: JSON.stringify({ runMode: 'longwrite', longMode: true, grillMe: { writingForm: 'expository' }, deliveryContract: { manuscriptFile: true } }) }),
    getManuscriptSegmentsByRun: () => rows,
    getArtifactsByRun: () => [{ artifact_type: 'manuscript', status: 'completed', hash: hash(delivered), char_count: Array.from(delivered).length }] }
  return { repo, rows }
}
test('draft uses accepted prose only, with section spacing but no mutation or completion claim', () => {
  const { repo, rows } = fixture('waiting_user'), before = JSON.stringify(rows)
  assert.deepEqual(readRunManuscript(repo, 'run', 'draft'), { kind: 'draft', content: '已收稿第一节。\n\n已收稿第二节。', acceptedChars: 14, runStatus: 'waiting_user' })
  assert.equal(JSON.stringify(rows), before)
  assert.throws(() => readRunManuscript(repo, 'run', 'manuscript'), /尚未完成/)
})
test('final view uses existing artifact bytes and retains old raw-join delivery identity', () => {
  const old = '已收稿第一节。已收稿第二节。', { repo } = fixture('completed', old)
  assert.equal(readRunManuscript(repo, 'run', 'manuscript').content, old)
  assert.equal(readRunManuscript(repo, 'run', 'manuscript', () => old).content, old)
  assert.throws(() => readRunManuscript(repo, 'run', 'manuscript', () => '损坏内容'), /对象损坏/)
  assert.equal(readRunManuscript(repo, 'run', 'draft').content, '已收稿第一节。\n\n已收稿第二节。')
})

test('native-dialog draft port cancels without writes, saves failed-run accepted prose and refuses every existing destination', async () => {
  const fs = require('node:fs/promises'), os = require('node:os'), {saveManuscriptDraft,manuscriptDraftInfo,runsSaveDraftSchema} = moduleValue.exports
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-draft-save-'))
  const {repo, rows} = fixture('failed'), before = JSON.stringify(rows), target = path.join(dir, '草稿.md')
  try {
    assert.deepEqual(manuscriptDraftInfo(repo, 'run'), {acceptedChars:14})
    assert.equal(runsSaveDraftSchema.safeParse({runId:'run',path:target}).success, false)
    assert.deepEqual(await saveManuscriptDraft(repo, 'run', async () => ({canceled:true,filePath:target})), {ok:true,cancelled:true})
    assert.deepEqual(await fs.readdir(dir), [])
    const saved = await saveManuscriptDraft(repo, 'run', async name => { assert(name.includes('草稿')); return {canceled:false,filePath:target} })
    assert.equal(saved.acceptedChars, 14); assert.equal(await fs.readFile(target,'utf8'), '已收稿第一节。\n\n已收稿第二节。')
    await assert.rejects(saveManuscriptDraft(repo,'run',async () => ({canceled:false,filePath:target})), /未覆盖/)
    assert.equal(await fs.readFile(target,'utf8'), '已收稿第一节。\n\n已收稿第二节。')
    assert.equal(JSON.stringify(rows), before)
    assert.equal(repo.getRun().status, 'failed')
  } finally { assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir,{recursive:true,force:true}) }
})
