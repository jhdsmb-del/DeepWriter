const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { before, test } = require('node:test')
const { build } = require('esbuild')
let api
before(async () => {
  const root = path.resolve(__dirname, '..')
  const bundled = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export * from './src/main/creativeModel'; export {ProviderRegistryService} from './src/main/providerRegistry';
    export {extractSkeleton,generateCandidate,reviseSpan,evaluateWithModel} from './src/main/style/modelCalls';
    export {createStyleService} from './src/main/style/styleService'; export {createExemplarStore} from './src/main/style/styleJobStore';
    export {createNovelWorkflow} from './src/main/novel/novelWorkflow'; export {createDraftStore} from './src/main/novel/draftStore';
    export {generateScenePatch,galgameApiFromEffectiveProfile} from './src/main/galgame';
    export {buildStylometryProfile,textStats} from './src/shared/styleV2'; export {executableProfileStages} from './src/shared/providerRegistry';
  ` }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const module = { exports: {} }; new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, module, module.exports); api = module.exports
  // Only the external SDK diagnostic boundary is synthetic here. Repair
  // routing, project reads, model HTTP, JSON validation and diff are production.
  const repair = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `export {repairLoop} from './src/main/galgame'` }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false, logLevel: 'silent', plugins: [{ name: 'synthetic-lint-diagnostic', setup(builder) {
    builder.onResolve({ filter: /\/renpySdk$/ }, () => ({ path: 'diagnostic', namespace: 'synthetic-lint' }))
    builder.onLoad({ filter: /.*/, namespace: 'synthetic-lint' }, () => ({ contents: `export const resolveRenpySdkLayout=async()=>({}); export const validateRenpySdkLayout=async()=>({}); export const runRenpyLint=async()=>({ok:false,output:'game/script.rpy, 2: synthetic diagnostic',exitCode:1});`, loader: 'ts' }))
  } }] })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', repair.outputFiles[0].text)(require, loaded, loaded.exports); api.repairWithDiagnostic = loaded.exports.repairLoop
})
const vault = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() }
const prose = '灯亮了。他把手从开关上移开，窗外的风吹动纸角。她看完便条，沿走廊走向楼梯。'
const skeleton = { facts: [], eventOrder: [], pov: '第三', emotionalArc: [], paragraphFunctions: [], dialogueIntents: [] }
const task = { sceneType: '叙述', narrativeFunctions: [], pov: '第三', emotionalArc: [], targetChars: 40, userPrompt: '合成本地测试', outputFormat: 'prose', requiredFacts: [], forbiddenFacts: [], fidelity: 'balanced' }
async function fixture(action) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-creative-routing-'))
  const registry = new api.ProviderRegistryService(path.join(dir, 'registry.db'), vault)
  const receipts = []; let onRequest = () => {}, unauthorized = false
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', value => { raw += value }); req.on('end', () => {
      const body = JSON.parse(raw), receipt = { path: req.url, headers: req.headers, body }; receipts.push(receipt); onRequest(receipt)
      if (unauthorized) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"invalid credential"}}'); return }
      const all = JSON.stringify(body)
      const text = all.includes('内容骨架抽取器') ? JSON.stringify(skeleton) : all.includes('风格差异评审器') ? '{"styleScore":0.5,"naturalness":0.7,"notes":"本地传输样例"}'
        : all.includes('ScenePatch') || all.includes('补丁 JSON') || all.includes('operations') ? JSON.stringify({ file: 'game/script.rpy', operations: [{ op: 'insert_after', anchor: 'label start:', lines: ['    "灯亮了。"'] }] }) : prose
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (req.url.endsWith('/responses')) res.end(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n`)
      else if (req.url.endsWith('/messages')) res.end(`event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: 'text_delta', text } })}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {}\n\n`)
      else res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, profiles = {}, providers = {}, credentials = {}
  try {
  for (const [stage, protocol, header] of [['planning', 'openai-chat', 'Authorization'], ['draft', 'openai-responses', 'api-key'], ['review', 'anthropic-messages', 'x-api-key'], ['polish', 'openai-chat', 'X-Model-Key']]) {
    const suffix = protocol === 'openai-responses' ? '/responses' : protocol === 'anthropic-messages' ? '/messages' : '/chat/completions'
    const provider = await registry.createCustomProvider({ displayName: stage, baseUrl: origin, chatPath: '/' + stage + suffix, modelsPath: null, authStyle: 'bearer', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true, protocol, authHeaderName: header, extraHeaders: { 'X-Creative-Test': stage }, ...(protocol === 'anthropic-messages' ? { fixedHeaders: { 'anthropic-version': '2023-06-01' } } : {}) } })
    credentials[stage] = registry.createCredential(provider.id, 'Synthetic only', 'synthetic-' + stage).id
    const model = registry.addManualModel({ providerId: provider.id, remoteModelId: 'model-' + stage, displayName: stage })
    const profile = registry.ensureModelProfile(model.id)
    registry.upsertProfile({ ...profile, generation: { temperature: .27, topP: .81, maxOutputTokens: 256, stream: true } })
    providers[stage] = provider; profiles[stage] = profile.id
  }
  const bindings = { defaultProfileId: profiles.draft, ...Object.fromEntries(Object.entries(profiles).map(([stage, id]) => [stage + 'ProfileId', id])) }
  registry.setBindings(bindings)
  const getApi = stage => api.resolveCreativeStageForRequest({ registry, stage: stage ?? 'draft', legacy: async () => { throw new Error('must not borrow synthetic-legacy-wrong-provider') } })
  await action({ dir, registry, getApi, receipts, profiles, providers, credentials, bindings, onRequest: callback => { onRequest = callback }, unauthorized: () => { unauthorized = true } }) }
  finally { registry.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

test('real style jobs use separate selected draft/review/polish protocols and credentials, retaining the in-flight selection', async () => fixture(async f => {
  let resolveFinished
  const finished = new Promise(resolve => { resolveFinished = resolve })
  const styles = api.createStyleService({ baseDir: f.dir, getApi: f.getApi, onJobUpdate: job => { if (['done', 'failed'].includes(job.stage)) resolveFinished(job) } })
  const store = api.createExemplarStore(f.dir)
  await store.saveProfile('sample', api.buildStylometryProfile([api.textStats(prose)])); await store.saveCorpus('sample', []); await store.saveForbidden('sample', []); await store.saveExemplars('sample', [])
  let changed = false
  f.onRequest(receipt => { if (!changed && receipt.path.startsWith('/draft/')) { changed = true; f.registry.setBindings({ ...f.bindings, draftProfileId: f.profiles.polish }) } })
  const { jobId } = await styles.startJob('sample', task)
  let timer
  const job = await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('style completion timeout')), 5000) })]).finally(() => clearTimeout(timer))
  assert.equal(job.stage, 'done', job.error)
  assert.deepEqual(f.receipts.map(item => item.path), ['/draft/responses', '/draft/responses', '/review/messages', '/review/messages'])
  for (const receipt of f.receipts) {
    const stage = receipt.path.split('/')[1], header = stage === 'draft' ? 'api-key' : 'x-api-key'
    assert.equal(receipt.headers[header], 'synthetic-' + stage); assert.equal(receipt.headers.authorization, undefined)
    assert.equal(receipt.headers['x-creative-test'], stage); assert.equal(receipt.body.model, 'model-' + stage)
    assert.equal(receipt.body.temperature, .27)
    assert.equal(stage === 'draft' ? receipt.body.max_output_tokens : receipt.body.max_tokens, 256)
    assert(!JSON.stringify(receipt.body).includes('synthetic-'))
  }
  await styles.revise(jobId, { candidateId: job.candidates[0].id, spanStart: 0, spanEnd: prose.length, spanText: prose, preserveFacts: [], failedRules: [], leftContext: '', rightContext: '' })
  assert.equal(f.receipts.at(-1).path, '/polish/chat/completions'); assert.equal(f.receipts.at(-1).headers['x-model-key'], 'synthetic-polish')
  const saved = await fs.readFile(path.join(f.dir, 'styles-v2', 'jobs', jobId + '.json'), 'utf8'); assert(!saved.includes('synthetic-'))
}))

test('novel drafting/revision and Galgame production use the selected protocol rather than legacy DeepSeek transport', async () => fixture(async f => {
  const novel = api.createNovelWorkflow({ baseDir: f.dir, getApi: f.getApi })
  const project = await novel.startProject({ title: '本地测试', targetChars: 40, scenes: [{ title: '第一节', wordTarget: 40 }] })
  const bible = await api.createDraftStore(f.dir).loadBible(project.projectId), scene = bible.scenes[0].id
  assert.equal((await novel.generateScene(project.projectId, scene, '写灯')).stage, 'committed')
  assert.equal((await novel.reviseScene(project.projectId, scene, [], '修句')).stage, 'committed')
  assert.equal(f.receipts[0].path, '/draft/responses'); assert.equal(f.receipts[1].path, '/polish/chat/completions')
  const projectDir = path.join(f.dir, 'galgame'); await fs.mkdir(path.join(projectDir, 'game'), { recursive: true }); await fs.writeFile(path.join(projectDir, 'game', 'script.rpy'), 'label start:\n    return\n')
  const patch = await api.generateScenePatch({ projectDir, sceneSpec: '输出补丁 JSON', api: api.galgameApiFromEffectiveProfile(f.registry.resolveForRequest(f.profiles.draft)) })
  assert.equal(patch.ok, true, patch.error); assert.equal(f.receipts.at(-1).path, '/draft/responses'); assert.equal(f.receipts.at(-1).headers['api-key'], 'synthetic-draft')
}))

test('missing selected credentials never fall back; true legacy-only inputs remain usable; frozen review keeps its original version', async () => fixture(async f => {
  const legacy = { apiKey: 'synthetic-legacy-only', baseUrl: 'http://127.0.0.1:1', model: 'old-model', maxTokens: 128 }
  assert.equal(await api.resolveCreativeStageForRequest({ registry: { shouldUseRegistry: () => false }, stage: 'draft', legacy: async () => legacy }), legacy)
  const frozen = f.registry.freezeStageProfiles(f.bindings, { maxTokens: 128, temperature: .7, topP: 1, thinking: { enabled: false, effort: 'high' } }, ['review']).review
  f.registry.replaceCredential(f.credentials.review, 'synthetic-new-review')
  const original = api.creativeApiFromFrozenProfile(frozen, f.registry.resolveFrozenCredential(frozen.credential))
  assert.equal(original.apiKey, 'synthetic-review'); assert.equal(original.provider.protocol, 'anthropic-messages')
  await api.evaluateWithModel(original, prose, [])
  assert.equal(f.receipts.at(-1).headers['x-api-key'], 'synthetic-review')
  f.registry.deleteCredential(f.credentials.draft)
  await assert.rejects(f.getApi('draft'), error => error.code === 'credential_missing')
  assert.equal(f.receipts.length, 1, 'failed new selected credential sends no request')
  assert(api.executableProfileStages({ deepWrite: { experiment: { enabled: true } } }).includes('review'))
}))

test('exemplar extraction uses planning and an authorized keyless local provider stays keyless in Galgame generation', async () => fixture(async f => {
  const styles = api.createStyleService({ baseDir: f.dir, getApi: f.getApi }), store = api.createExemplarStore(f.dir)
  await store.saveProfile('sample', api.buildStylometryProfile([api.textStats(prose)])); await store.saveForbidden('sample', [])
  await store.saveCorpus('sample', [{ id: 'example-1', sourceId: 'source', sourceName: '合成样段', workTitle: '测试', chapterOrdinal: 1, sectionIndex: 0,
    text: prose, maskedText: prose, charCount: [...prose].length, split: 'example', sceneType: '叙述', narrativeFunctions: [], dialogueRatio: 0, sha256: 'synthetic-source' }])
  assert.equal((await styles.buildExemplars('sample')).count, 1)
  assert.equal(f.receipts[0].path, '/planning/chat/completions'); assert.equal(f.receipts[0].headers.authorization, 'Bearer synthetic-planning')
  const effective = f.registry.resolveForRequest(f.profiles.draft)
  effective.provider.authStyle = 'none'; effective.secret = 'must-never-be-sent'
  const projectDir = path.join(f.dir, 'keyless-game'); await fs.mkdir(path.join(projectDir, 'game'), { recursive: true }); await fs.writeFile(path.join(projectDir, 'game', 'script.rpy'), 'label start:\n    return\n')
  const result = await api.generateScenePatch({ projectDir, sceneSpec: '补丁 JSON', api: api.galgameApiFromEffectiveProfile(effective) })
  assert.equal(result.ok, true, result.error)
  assert.equal(f.receipts.at(-1).headers['api-key'], undefined); assert.equal(f.receipts.at(-1).headers.authorization, undefined)
  const before = await fs.readFile(path.join(projectDir, 'game', 'script.rpy'), 'utf8')
  const repair = await api.repairWithDiagnostic({ projectDir, sdkPath: 'synthetic-sdk-diagnostic', api: api.galgameApiFromEffectiveProfile(effective), maxRepairs: 1 })
  assert.equal(repair.repairRounds, 1, 'keyless repair must actually call its configured local model')
  assert.equal(repair.proposals.length, 1); assert.equal(repair.autoApplied, false)
  assert.equal(f.receipts.at(-1).headers['api-key'], undefined)
  assert.equal(await fs.readFile(path.join(projectDir, 'game', 'script.rpy'), 'utf8'), before)
}))

test('style authentication failure is surfaced once instead of quietly trying all candidates or reporting a score', async () => fixture(async f => {
  f.unauthorized()
  await assert.rejects(api.evaluateWithModel(await f.getApi('review'), prose, []), error => error.status === 401)
  assert.equal(f.receipts.length, 1)
  const store = api.createExemplarStore(f.dir)
  await store.saveProfile('sample', api.buildStylometryProfile([api.textStats(prose)])); await store.saveCorpus('sample', []); await store.saveForbidden('sample', []); await store.saveExemplars('sample', [])
  let resolveFinished
  const finished = new Promise(resolve => { resolveFinished = resolve })
  const styles = api.createStyleService({ baseDir: f.dir, getApi: f.getApi, onJobUpdate: job => { if (['done', 'failed'].includes(job.stage)) resolveFinished(job) } })
  await styles.startJob('sample', task)
  let timer
  const failed = await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('failed style completion timeout')), 5000) })]).finally(() => clearTimeout(timer))
  assert.equal(failed.stage, 'failed'); assert.match(failed.error, /401/)
  assert.equal(f.receipts.length, 2, 'only the first candidate is attempted after authentication is refused')
}))
