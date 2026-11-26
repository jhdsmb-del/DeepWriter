const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let production

before(async () => {
  const result = await esbuild.build({ absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', tsconfigRaw: {}, logLevel: 'silent',
    stdin: { resolveDir: root, loader: 'ts', contents: `
      export {createRepository} from './src/main/db/repository';
      export {buildExecutionSnapshot} from './src/main/executionSnapshot';
      export {createRunStorePort} from './src/main/runKernelAdapter';
      export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
      export {grillMeOutlineHash} from './src/shared/grillMe';
      export {extensionIdSchema,extensionEnabledSchema,extensionSelectionSchema,extensionsEmptySchema} from './src/shared/ipcSchemas';
    ` }, plugins: [{ name: 'unused-electron-boundary', setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'unused-electron' }))
      build.onLoad({ filter: /.*/, namespace: 'unused-electron' }, () => ({ loader: 'js', contents: 'export const app={getPath:()=>"",isPackaged:false};export const dialog={};export const safeStorage={};' }))
    } }, { name: 'workspace-source-boundary', setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (!args.path.startsWith('.')) return { path: args.path, external: true }
        const target = path.resolve(args.resolveDir, args.path)
        const resolved = ['', '.ts', '.tsx', '.js', '/index.ts'].map(suffix => target + suffix).find(existsSync)
        if (!resolved || !resolved.startsWith(root + path.sep)) throw new Error('Unexpected source boundary')
        return { path: resolved, namespace: 'workspace-source' }
      })
      build.onLoad({ filter: /.*/, namespace: 'workspace-source' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
    } }] })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__dirname', '__filename', result.outputFiles[0].text)(require, module, module.exports, __dirname, __filename)
  production = module.exports
})

function prose(prefix, round) {
  const points = Array.from(prefix)
  while (points.length < 119) points.push(String.fromCodePoint(0x20000 + round * 400 + points.length))
  return points.join('') + '。'
}
async function fixture(concrete, body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-commercial-narrative-'))
  const database = path.join(directory, 'run.db')
  const artifacts = path.join(directory, 'artifacts')
  const runId = 'commercial-two-scenes', sessionId = 'commercial-session'
  const answers = concrete ? [{ slotId: 'characters', value: '林舟、沈遥', source: 'user' }, { slotId: 'setting', value: '雾港灯塔', source: 'user' }, { slotId: 'conflict', value: '林舟抵达灯塔，沈遥点亮灯塔', source: 'user' }] : []
  const beats = concrete ? ['林舟抵达灯塔', '沈遥点亮灯塔'] : ['产生一个可验证的现场变化', '留下下一步行动线索']
  const outline = { title: '隔离回归', premise: '真实两场提交与恢复边界', targetChars: 240, sections: [1, 2].map(index => ({ id: 's' + index, title: '第' + index + '场', purpose: '场景推进', targetChars: 120, beats, sourceSlotIds: answers.map(answer => answer.slotId) })) }
  const config = production.buildExecutionSnapshot({ payload: { id: runId, mode: 'longwrite', workspace: 'novel', phase: 'execute', longMode: true, targetChars: 240, text: '写作', strongConstraints: { enabled: false }, grillMe: { stateId: 'confirmed-test-state', originalTask: '灯塔故事', targetChars: 240, answers, assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash: production.grillMeOutlineHash(outline) } }, settings: { model: 'isolated-synthetic', baseUrl: 'http://127.0.0.1:9', maxTokens: 4096, temperature: .7, topP: 1, thinkingEnabled: false, reasoningEffort: 'high', workDir: directory, docDir: directory, novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000, strongConstraintEnabled: false }, sessionId, memory: { projectPath: '', projectContent: '', userContent: '' } })
  let repository = production.createRepository(database); repository.open()
  let calls = 0
  const makeEngine = () => production.createAgentRunEngine({ store: production.createRunStorePort(repository, artifacts), getConfig: () => config,
    modelCall: async () => { const text = prose(concrete ? '林舟抵达灯塔。沈遥点亮灯塔。' : '雾里没有人开口，灯光在雨中摇晃。', ++calls); return { async *[Symbol.asyncIterator]() { yield { type: 'text', delta: text }; yield { type: 'finish', finishReason: 'stop' } } } },
    toolExecutor: async () => '', onEvent: () => undefined, onRunUpdate: () => undefined,
    publishLongwriteArtifact: async ({ content, contentHash }) => { await fs.writeFile(path.join(directory, 'result.md'), content); return { displayName: 'result.md', relativePath: 'result.md', contentHash } }
  })
  let engine = makeEngine()
  const restart = async (restore = true) => { repository.close(); repository = production.createRepository(database); repository.open(); engine = makeEngine(); if (restore) await engine.restore(runId); return engine }
  const step = async () => { try { await engine.step(runId) } catch (error) { const row = repository.getRun(runId); if (row?.status !== 'waiting_user') throw error } }
  try { assert.equal((await engine.start({ runId, sessionId, config })).ok, true); await body({ runId, config, database, step, restart, get engine() { return engine }, get repository() { return repository }, get calls() { return calls } }) }
  finally { repository.close(); await fs.rm(directory, { recursive: true, force: true }) }
}

test('SQLite two-scene reviews are run-monotonic across restart; old decisions cannot authorize the next candidate', async () => fixture(false, async f => {
  await f.step()
  const first = await f.engine.getNarrativeReview(f.runId)
  assert.equal(first?.status, 'pending_review')
  const input = { runId: f.runId, decision: 'accept_prose_no_state', expectedRevision: first.revision, decisionId: 'commercial-first-decision' }
  assert.equal((await f.engine.applyNarrativeReviewDecision(input, { actor: 'test-user' })).ok, true)
  const decided = await f.engine.getNarrativeReview(f.runId)
  assert.equal(decided.status, 'accepted')
  await f.restart()
  await f.step()
  const second = await f.engine.getNarrativeReview(f.runId)
  assert.ok(second, 'second scene must expose a valid packet, not reuse a stale run-wide claim namespace')
  assert.equal(second.status, 'pending_review')
  assert.notEqual(second.sceneId, first.sceneId)
  assert.ok(second.revision > decided.revision)
  assert.notEqual(second.packetHash, first.packetHash)
  const rowsBefore = f.repository.getManuscriptSegmentsByRun(f.runId).filter(row => row.status === 'accepted')
  assert.equal((await f.engine.applyNarrativeReviewDecision(input, { actor: 'late-user' })).ok, false)
  assert.deepEqual(f.repository.getManuscriptSegmentsByRun(f.runId).filter(row => row.status === 'accepted'), rowsBefore)
  await f.restart()
  const restored = await f.engine.getNarrativeReview(f.runId)
  assert.equal(restored.packetHash, second.packetHash)
  assert.equal(restored.revision, second.revision)
  assert.equal(f.calls, 2)
}))

test('SQLite real committed card binds scene mutation and story revisions independently; hash and ledger drift still refuse', async () => fixture(true, async f => {
  await f.step()
  assert.equal(f.repository.getRun(f.runId).status, 'completed')
  const sqlite = new DatabaseSync(f.database)
  try {
    const manifest = sqlite.prepare('SELECT revision,manifest_hash FROM scene_commit_manifests ORDER BY rowid LIMIT 1').get()
    const row = sqlite.prepare('SELECT card_id,card_json FROM scene_memory_cards ORDER BY rowid LIMIT 1').get()
    assert.ok(row, 'card must be produced by actual scene commit, not seeded')
    const card = JSON.parse(row.card_json)
    assert.notEqual(manifest.revision, card.storyRevision, 'fixture exercises the formerly invalid equality check')
    const freshness = f.repository.getStoryLedgerFreshness(f.runId)
    const query = { runId: f.runId, sceneId: 'next-uncommitted-scene', povCharacterId: null, expectedFence: { ...freshness.scope, branchLineage: freshness.branchLineage, validityEpoch: freshness.validityEpoch, storyRevision: freshness.runRevision, headRevision: freshness.headRevision, headHash: freshness.headHash } }
    assert.ok(f.repository.getSceneRecallCorpusSnapshot(query).corpus.some(item => item.card.cardId === card.cardId))
    await f.restart(false)
    assert.ok(f.repository.getSceneRecallCorpusSnapshot(query).corpus.some(item => item.card.cardId === card.cardId))
    const original = manifest.manifest_hash
    sqlite.prepare('UPDATE scene_commit_manifests SET manifest_hash=? WHERE rowid=(SELECT MIN(rowid) FROM scene_commit_manifests)').run('0'.repeat(64))
    assert.throws(() => f.repository.getSceneRecallCorpusSnapshot(query), /manifest|card|hash/)
    sqlite.prepare('UPDATE scene_commit_manifests SET manifest_hash=? WHERE rowid=(SELECT MIN(rowid) FROM scene_commit_manifests)').run(original)
    sqlite.prepare('UPDATE scene_commit_manifests SET revision=revision+1 WHERE rowid=(SELECT MIN(rowid) FROM scene_commit_manifests)').run()
    assert.throws(() => f.repository.getSceneRecallCorpusSnapshot(query), /scene_recall_snapshot_scene_state_missing/)
    sqlite.prepare('UPDATE scene_commit_manifests SET revision=? WHERE rowid=(SELECT MIN(rowid) FROM scene_commit_manifests)').run(manifest.revision)
    sqlite.prepare('UPDATE story_ledger_revisions SET delta_hash=? WHERE revision=?').run('1'.repeat(64), card.storyRevision)
    assert.throws(() => f.repository.getSceneRecallCorpusSnapshot(query), /ledger|contract|binding|corrupt/)
  } finally { sqlite.close() }
}))

test('extension bridge rejects path/runtime grants, duplicate selections and unbounded ids', () => {
  assert.ok(production.extensionsEmptySchema.safeParse({}).success)
  assert.equal(production.extensionsEmptySchema.safeParse({ path: 'C:/private' }).success, false)
  assert.equal(production.extensionIdSchema.safeParse({ id: 'first-party/skill', runtime: 'node' }).success, false)
  assert.equal(production.extensionEnabledSchema.safeParse({ id: 'first-party/skill', enabled: true, grant: true }).success, false)
  assert.equal(production.extensionSelectionSchema.safeParse({ skills: ['first-party/skill', 'first-party/skill'], plugins: [] }).success, false)
  assert.equal(production.extensionSelectionSchema.safeParse({ skills: ['first-party/skill'], plugins: ['first-party/skill'] }).success, false)
  assert.equal(production.extensionSelectionSchema.safeParse({ skills: Array.from({ length: 9 }, (_, index) => 'first-party/skill-' + index), plugins: [] }).success, false)
})
