const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { isBuiltin } = require('node:module')
const { before, after, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let api, baseDir
async function compile(contents) {
  return esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent',
    plugins: [{ name: 'desktop-extension-production-source', setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.path.startsWith('.') && args.path !== 'electron') {
          // A generated controller lives in an isolated temp directory. Bind its
          // external imports to this checkout's declared dependencies, just as the
          // desktop package supplies node_modules beside its production bundle.
          // Do not inherit NODE_PATH or loosen the controlled child process env.
          return { path: isBuiltin(args.path) ? args.path : require.resolve(args.path, { paths: [args.resolveDir, root] }), external: true }
        }
        const target = args.path === 'electron' ? path.join(root, 'src/cli/host.ts') : path.resolve(args.resolveDir, args.path)
        const found = ['', '.ts', '.js', '/index.ts'].map((ext) => target + ext).find(existsSync)
        if (!found || !found.startsWith(root + path.sep)) throw new Error('test source outside workspace')
        return { path: found, namespace: 'source' }
      })
      build.onLoad({ filter: /.*/, namespace: 'source' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
    } }] })
}
before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-desktop-extensions-'))
  const result = await compile(`
    export {DesktopExtensionService,desktopExtensionResult} from './src/main/extensions/DesktopExtensionService';
    export {ExtensionRegistry} from './src/main/extensions/ExtensionRegistry';
    export {activeChildProcesses} from './src/main/childRegistry';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {createRepository} from './src/main/db/repository';
    export {createRunStorePort,createModelCallAdapter,createToolExecutor,allowListFromConfig} from './src/main/runKernelAdapter';
    export {freezeRunWebAccess} from './src/main/runWebAccess';
    export {createRunProviderWeb} from './src/main/providerWebRuntime';
    export {secureProviderFetch} from './src/main/providerSecurity';
    export {unknownModelCapabilities} from './src/shared/providerRegistry';
    export {streamChat} from './src/main/deepseek';
    export {decodeToolResult} from './src/main/toolResultView';
    export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {extensionsEmptySchema,extensionSelectionSchema,extensionEnabledSchema} from './src/shared/ipcSchemas';
  `)
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, loaded, loaded.exports); api = loaded.exports
})
after(async () => {
  assert.equal(api.activeChildProcesses().length, 0)
  assert.equal(path.dirname(baseDir), os.tmpdir()); assert.match(path.basename(baseDir), /^deepwriter-desktop-extensions-/)
  await fs.rm(baseDir, { recursive: true, force: true })
})
const waitUntil = async (predicate, message) => {
  for (let attempt = 0; attempt < 160; attempt++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)) }
  assert.fail(message)
}
const pidGone = (pid) => assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH')
const inspectorId = 'deepwriter/manuscript-inspector', skillId = 'deepwriter/structure-review'
function bareService(directory, extra = {}) {
  return new api.DesktopExtensionService({ registryDir: path.join(directory, 'extensions'), nodeExecutable: process.execPath, chooseSkillDirectory: async () => null, authorizeStart: async () => false, writeEvidence: () => {}, ...extra })
}
async function fixture(name, { selected = 'plugin', mode = 'plugin', authorize, budget = 200000, strictPolicy = false } = {}) {
  const dir = path.join(baseDir, name); await fs.mkdir(path.join(dir, 'documents'), { recursive: true })
  const file = path.join(dir, 'documents', '稿件.md'); await fs.writeFile(file, '灯塔🌊。夜')
  const bodies = [], evidence = []; let release, grantCalls = 0, enteredResolve
  const entered = new Promise((resolve) => { enteredResolve = resolve })
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', (chunk) => { raw += chunk }); request.on('end', () => {
      try {
        const body = JSON.parse(raw); bodies.push(body)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
        const priorTool = [...body.messages].reverse().find((item) => item.role === 'tool')
        if (mode === 'slow') {
          send({ choices: [{ delta: { content: '灯塔候选正文。' }, finish_reason: null }] })
          const timer = setTimeout(() => response.end('data: [DONE]\n\n'), 15000); response.on('close', () => clearTimeout(timer)); return
        }
        if (!priorTool && ['resource', 'plugin', 'outside'].includes(mode)) {
          const expectedName = mode === 'resource' ? 'read_skill_resource' : body.tools?.find((tool) => tool.function.name.startsWith('dw_'))?.function.name
          const spec = body.tools?.find((tool) => tool.function.name === expectedName)
          assert.ok(spec, 'the actual desktop adapter must declare the tool before the server requests it')
          const args = mode === 'resource' ? { id: skillId, path: 'references/checklist.md' } : { path: mode === 'outside' ? path.join(baseDir, 'private.txt') : file }
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'desktop-ext-call', type: 'function', function: { name: expectedName, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
        } else {
          if (mode === 'resource') assert.match(JSON.parse(priorTool.content).message, /Unicode code points/)
          if (mode === 'plugin') { const value = JSON.parse(priorTool.content); assert.equal(value.ok, true); assert.equal(JSON.parse(value.message).chars, 5) }
          if (mode === 'outside') { const value = JSON.parse(priorTool.content); assert.equal(value.ok, false); assert.match(value.message, /outside_authorized_roots/); assert.ok(!value.message.includes('private-content')) }
          send({ choices: [{ delta: { content: '已检查真实稿件。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })
        }
        response.end('data: [DONE]\n\n')
      } catch (error) { response.destroy(error) }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const repo = api.createRepository(path.join(dir, 'runs.sqlite')); repo.open()
  const runId = name, sessionId = name + '-session'; repo.createSession(sessionId, '桌面扩展', 'fixture')
  const config = api.buildExecutionSnapshot({ payload: { id: runId, sessionId, text: '检查灯塔稿件。', mode: 'agent', phase: 'execute' }, sessionId, memory: { projectPath: '', projectContent: '', userContent: '' }, settings: {
    model: 'desktop-fixture', baseUrl, maxTokens: 128, temperature: 0.7, topP: 0.9, thinkingEnabled: false, reasoningEffort: 'low', workDir: dir, docDir: path.join(dir, 'documents'), novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 8000, strongConstraintEnabled: false
  } })
  config.providerCallBudget = { maxCalls: 8, maxTokens: budget, maxCost: null, maxCostCny: null, maxWallClockMs: 30000 }
  const service = bareService(dir, { authorizeStart: async (input) => {
    grantCalls++; enteredResolve(input)
    if (authorize === 'pending') return new Promise((resolve) => { release = resolve })
    return authorize !== false
  }, writeEvidence: (run, kind, json) => { repo.saveRunEvidence(run, kind, json); evidence.push({ run, kind, value: JSON.parse(json) }) } })
  if (selected !== 'none') {
    const id = selected === 'skill' ? skillId : inspectorId
    await service.installCatalog(id); await service.setEnabled(id, true)
    await service.setSelection({ skills: selected === 'skill' ? [id] : [], plugins: selected === 'plugin' ? [id] : [] })
  }
  await service.freezeForNewRun(config)
  if (strictPolicy) config.toolPolicy.allowList = []
  let engine
  const adapter = api.createModelCallAdapter({
    getApi: () => ({ apiKey: '', baseUrl, model: 'desktop-fixture', maxTokens: 128, temperature: 0.7, topP: 0.9, thinking: { enabled: false, effort: 'low' }, supportsTools: true, protocol: 'deepseek-chat', adapterId: 'builtin.deepseek', chatPath: '/chat/completions', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }),
    getConfig: () => config, getSignal: () => engine.abortSignal(runId), buildPrefix: async () => config.frozenSystemMessages,
    getToolSpecs: (run) => service.getToolSpecs(run)
  })
  const store = api.createRunStorePort(repo, path.join(dir, 'artifacts'))
  engine = api.createAgentRunEngine({ store, modelCall: adapter, getConfig: () => config, toolExecutor: (name, args, _call, run) => service.execute(run, name, args), onEvent: () => {}, onRunUpdate: () => {} })
  service.attachEngine(engine, () => config)
  assert.equal((await engine.start({ runId, sessionId, config })).ok, true)
  await store.appendTurn({ runId, turnId: name + '-user', turnSeq: 1, role: 'user', content: '检查灯塔稿件。', createdAt: Date.now() })
  return { dir, service, repo, engine, config, runId, baseUrl, bodies, evidence, entered, grantCalls: () => grantCalls, release: () => release?.(true),
    close: async () => { await service.close(); repo.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) } }
}

test('桌面管理实际持久化与禁renderer路径/授权字段；安装默认关闭，选择和卸载保留旧pin', async () => {
  const dir = path.join(baseDir, 'management'); await fs.mkdir(dir)
  const source = path.join(dir, 'skill-import'); await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: selected-local\ndescription: 写作检查\n---\n完整本地技能指令，不授权工具。')
  const service = bareService(dir, { chooseSkillDirectory: async () => source })
  try {
    const catalog = (await service.snapshot()).catalog
    assert.equal(catalog.length, 3); assert.equal(catalog.filter((item) => item.kind === 'skill').length, 2)
    assert.ok(catalog.every((item) => item.source.startsWith('builtin:') && item.license === 'MIT'))
    const imported = await service.importSkill(); assert.equal(imported.id, 'local/selected-local'); assert.equal(imported.enabled, false)
    await assert.rejects(service.setSelection({ skills: [imported.id], plugins: [] }), /未启用/)
    await service.setEnabled(imported.id, true); await service.setSelection({ skills: [imported.id], plugins: [] })
    const reopened = new api.ExtensionRegistry(service.registry.root)
    assert.deepEqual(await reopened.selection(), { skills: [imported.id], plugins: [] })
    const pin = await reopened.freeze(imported.id, 'skill')
    await service.remove(imported.id)
    assert.deepEqual((await service.snapshot()).selectedForNewRuns, { skills: [], plugins: [] })
    assert.match(await reopened.resource(pin, 'SKILL.md'), /完整本地技能指令/)
    assert.equal(api.activeChildProcesses().length, 0)
    for (const value of [{ path: source }, { authorized: true }, { executable: process.execPath }]) assert.equal(api.extensionsEmptySchema.safeParse(value).success, false)
    assert.equal(api.extensionEnabledSchema.safeParse({ id: inspectorId, enabled: true, grant: true }).success, false)
    assert.equal(api.extensionSelectionSchema.safeParse({ skills: [skillId], plugins: [skillId] }).success, false)
  } finally { await service.close() }
})

test('真实桌面扩展允许初始化时的祖先路径别名，并固定规范注册表身份', async () => {
  const directory = path.join(baseDir, 'canonical-ancestor'), actual = path.join(directory, 'actual'), alias = path.join(directory, 'alias')
  await fs.mkdir(actual, { recursive: true })
  await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const service = bareService(alias)
  try {
    const installed = await service.installCatalog(skillId)
    const lexicalPackage = path.join(alias, 'extensions', 'packages', ...installed.id.split('/'), installed.packageHash)
    assert.notEqual((await fs.realpath(lexicalPackage)).toLowerCase(), lexicalPackage.toLowerCase(), 'fixture must exercise an actual path alias, not only casing')
    await service.setEnabled(skillId, true)
    await service.setSelection({ skills: [skillId], plugins: [] })
    assert.equal(service.registry.root, await fs.realpath(path.join(actual, 'extensions')))
    const pin = await service.registry.freeze(skillId, 'skill')
    assert.match(await service.registry.resource(pin, 'references/checklist.md'), /Unicode code points/)
    // Reinstall verifies the already-present immutable version through the real service.
    assert.equal((await service.installCatalog(skillId)).packageHash, installed.packageHash)
    assert.equal((await service.inspect(skillId)).enabled, false)
    const reopened = bareService(alias)
    try { await reopened.setEnabled(skillId, true); assert.equal((await reopened.registry.freeze(skillId, 'skill')).record.packageHash, pin.record.packageHash) }
    finally { await reopened.close() }
  } finally { await service.close() }
})

test('规范身份不接受初始化后祖先/注册表/包/资源junction替换，完整inventory和hash仍被验证', async () => {
  for (const replaced of ['ancestor', 'registry', 'packages', 'resources']) {
    const directory = path.join(baseDir, 'canonical-retarget-' + replaced), actual = path.join(directory, 'actual'), alias = path.join(directory, 'alias')
    await fs.mkdir(actual, { recursive: true })
    await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const service = bareService(alias)
    try {
      const installed = await service.installCatalog(skillId)
      await service.setEnabled(skillId, true)
      const pin = await service.registry.freeze(skillId, 'skill')
      await assert.rejects(service.registry.verify({ ...pin.record, version: 'changed' }), /extension_inventory_changed/)
      const packageRoot = path.join(service.registry.root, 'packages', ...installed.id.split('/'), installed.packageHash)
      const target = replaced === 'ancestor' ? alias : replaced === 'registry' ? service.registry.root : replaced === 'packages' ? path.join(service.registry.root, 'packages') : path.join(packageRoot, 'references')
      const replacement = path.join(directory, 'replacement')
      // Identical bytes must not hide a changed filesystem boundary.
      await fs.cp(replaced === 'ancestor' ? actual : target, replacement, { recursive: true })
      if (replaced === 'ancestor') await fs.unlink(alias)
      else await fs.rename(target, path.join(directory, 'original'))
      await fs.symlink(replacement, target, process.platform === 'win32' ? 'junction' : 'dir')
      const failure = replaced === 'resources' ? /extension_content_changed/ : replaced === 'packages' ? /extension_package_root_changed/ : /extension_registry_root_changed/
      await assert.rejects(service.registry.verify(pin.record), failure)
      await assert.rejects(service.registry.resource(pin, 'references/checklist.md'), failure)
      await assert.rejects(service.setEnabled(skillId, true), failure)
      if (replaced === 'ancestor' || replaced === 'registry') await assert.rejects(service.snapshot(), failure)
    } finally { await service.close() }
  }
})

test('注册表缺失尾目录在初始化后被junction插入时拒绝读写，不创建外部包', async () => {
  const directory = path.join(baseDir, 'canonical-missing-tail'), actual = path.join(directory, 'actual'), replacement = path.join(directory, 'replacement')
  await fs.mkdir(actual, { recursive: true }); await fs.mkdir(replacement)
  const service = bareService(actual)
  try {
    assert.equal(existsSync(service.registry.root), false)
    await fs.symlink(replacement, service.registry.root, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(service.snapshot(), /extension_registry_root_changed/)
    await assert.rejects(service.installCatalog(skillId), /extension_registry_root_changed/)
    assert.deepEqual(await fs.readdir(replacement), [])
  } finally { await service.close() }
})

test('初始化后插入的悬空注册表junction不是缺失目录，不接受空snapshot或创建包', async () => {
  const directory = path.join(baseDir, 'canonical-dangling-tail'), actual = path.join(directory, 'actual'), missingTarget = path.join(directory, 'missing-target')
  await fs.mkdir(actual, { recursive: true })
  const service = bareService(actual)
  try {
    await fs.symlink(missingTarget, service.registry.root, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await fs.lstat(service.registry.root)).isSymbolicLink(), true)
    assert.equal(existsSync(missingTarget), false)
    await assert.rejects(service.snapshot(), /extension_registry_root_changed/)
    await assert.rejects(service.installCatalog(skillId), /extension_registry_root_changed/)
    assert.equal(existsSync(missingTarget), false)
  } finally { await service.close() }
})

test('桌面技能冻结完整prefix，真实HTTP schema/按需资源与实际body预算走共享adapter', async () => {
  const f = await fixture('skill-body', { selected: 'skill', mode: 'resource' })
  try {
    const body = f.config.extensionsFrozen.skills[0].instructions[0].content
    await f.engine.step(f.runId)
    assert.equal(f.repo.getRun(f.runId).status, 'completed')
    assert.equal(f.grantCalls(), 0); assert.equal(f.bodies.length, 2)
    assert.ok(f.bodies[0].messages.some((message) => message.role === 'system' && message.content.includes(body)))
    assert.ok(f.bodies[0].tools.find((tool) => tool.function.name === 'read_skill_resource'))
    const ledger = JSON.parse(f.repo.getRunEvidence(f.runId, 'run_provider_budget_v1').json)
    assert.equal(ledger.totalCalls, 2); assert.equal(ledger.tokenReservationCorrupt, false)
    assert.equal(api.activeChildProcesses().length, 0)
  } finally { await f.close() }
})

/** The only endpoint relay is this in-process fixture. Both the real Responses
 * stream parser and authenticated provider search transport use a local HTTP peer;
 * production receives no endpoint override, synthetic model or environment grant. */
async function hostedSkillFixture(name, { enabled = true, supported = true, validSearch = true, operation = 'web_search', costCap = null, terminal = 'completed' } = {}) {
  const dir = path.join(baseDir, name); await fs.mkdir(dir)
  const modelBodies = [], providerRequests = [], paths = [], evidence = [], finishReasons = []
  const secret = 'synthetic-extension-hosted-current-key'
  const source = { url: 'https://example.com/provider-source', title: 'Fixture provider source' }
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk }); request.on('end', () => {
      try {
        const body = JSON.parse(raw); paths.push(request.url)
        if (request.url === '/v1/responses') {
          providerRequests.push({ body, authorization: request.headers.authorization })
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ id: 'resp_hosted_fixture', status: 'completed', output: [
            ...(validSearch ? [{ type: 'web_search_call', id: 'ws_hosted_fixture', status: 'completed', action: { type: 'search', sources: [source] } }] : []),
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Observed provider search result.', annotations: validSearch ? [{ type: 'url_citation', ...source }] : [] }] }
          ], usage: { input_tokens: 50, output_tokens: 10 } }))
          return
        }
        assert.equal(request.url, '/model', 'no free search/fetch or other outbound endpoint is part of this fixture')
        modelBodies.push(body)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = value => response.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n')
        const replies = body.input.filter(item => item.type === 'function_call_output')
        if (terminal === 'text-only') send({ type: 'response.output_text.delta', delta: '不需要工具的普通文本答复。' })
        else if (replies.length < 2) {
          const resource = replies.length === 0
          if (!resource) assert.match(JSON.parse(replies[0].output).message, /Unicode code points/)
          const name = resource ? 'read_skill_resource' : operation
          if (resource) assert.ok(body.tools.some(tool => tool.name === name), 'selected resource schema must be on the actual Responses wire')
          // When web is denied the peer deliberately forges this call, exercising
          // the engine/executor boundary rather than merely inspecting metadata.
          const args = resource ? { id: skillId, path: 'references/checklist.md' }
            : operation === 'web_search' ? { query: 'public source evidence' } : { url: source.url }
          send({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: resource ? 'fc_resource' : 'fc_web', call_id: resource ? 'ext-resource' : 'ext-web', name, arguments: JSON.stringify(args) } })
        } else {
          const web = JSON.parse(replies[1].output)
          if (enabled && supported && validSearch && operation === 'web_search') { assert.equal(web.ok, true); assert.match(web.message, /Observed provider search result/); assert.match(web.message, /https:\/\/example.com\/provider-source/) }
          else {
            assert.ok(web.ok === false || typeof web.error === 'string', 'the actual tool turn must contain an explicit failure')
            assert.ok(!JSON.stringify(web).includes(secret))
          }
          send({ type: 'response.output_text.delta', delta: '已核对技能工具与供应商联网实际结果。' })
        }
        if (terminal === 'incomplete') send({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 40, output_tokens: 20 } } })
        else if (terminal === 'failed') send({ type: 'response.failed', response: { status: 'failed', error: { message: 'fixture error must stay redacted ' + secret } } })
        else send({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 40, output_tokens: 20 } } })
        response.end()
      } catch (error) { response.destroy(error) }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const localUrl = 'http://127.0.0.1:' + server.address().port
  const repo = api.createRepository(path.join(dir, 'runs.sqlite')); repo.open()
  const runId = name, sessionId = name + '-session'; repo.createSession(sessionId, '扩展与账户联网', 'gpt-5.4')
  const price = { id: 'zero-token-fixture', currency: 'USD', unit: 'per_1m_tokens', inputMissPerMillion: 0, cacheHitPerMillion: 0, outputPerMillion: 0, reasoningBillingRule: 'included_in_output' }
  const profile = { version: 1, profileId: 'hosted-profile', fingerprint: 'hosted-frozen-profile',
    provider: { id: 'hosted-provider', adapterId: 'custom.openai-compatible-chat', baseUrl: supported ? 'https://api.openai.com' : 'https://proxy.invalid', chatPath: '/v1/responses', authStyle: 'bearer', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false, protocol: 'openai-responses' } },
    model: { id: 'hosted-model', remoteModelId: 'gpt-5.4', contextWindow: 64000, maxOutputTokens: 256, capabilityProof: api.unknownModelCapabilities(), pricing: price },
    credential: { providerId: 'hosted-provider', credentialRefId: 'frozen-hosted-ref', version: 4 }, generation: { maxOutputTokens: 256 }, supportsTools: true }
  const config = api.buildExecutionSnapshot({ payload: { id: runId, sessionId, mode: 'agent', text: '核对公开来源' }, sessionId, memory: { projectPath: '', projectContent: '', userContent: '' },
    settings: { model: 'gpt-5.4', baseUrl: profile.provider.baseUrl, maxTokens: 256, workDir: dir, docDir: dir, thinkingEnabled: false, reasoningEffort: 'low', novelMode: false, galgame: { enabled: false }, strongConstraintEnabled: false, historyBudgetTokens: 8000 } })
  config.providerProfileSnapshots = { version: 1, draft: profile, planning: null }
  config.providerCallBudget = { maxCalls: 8, maxTokens: 200000, maxCost: costCap === null ? null : { amount: costCap, currency: 'USD', unknownPolicy: 'deny' }, maxWallClockMs: 30000 }
  config.toolPolicy.allowList = []
  api.freezeRunWebAccess(config, enabled)
  const service = bareService(dir, { writeEvidence: (run, kind, json) => { repo.saveRunEvidence(run, kind, json); evidence.push({ kind, json }) } })
  await service.installCatalog(skillId); await service.setEnabled(skillId, true); await service.setSelection({ skills: [skillId], plugins: [] }); await service.freezeForNewRun(config)
  let engine, keyResolutions = 0, resourceReads = 0
  const adapter = api.createModelCallAdapter({ getConfig: () => config, getSignal: () => engine.abortSignal(runId), buildPrefix: async () => config.frozenSystemMessages,
    getApi: () => ({ profileId: profile.profileId, providerId: profile.provider.id, apiKey: secret, baseUrl: profile.provider.baseUrl, model: profile.model.remoteModelId, maxTokens: 256,
      temperature: .7, topP: .9, thinking: { enabled: false, effort: 'low' }, supportsTools: true, pricing: price, protocol: 'openai-responses',
      adapterId: profile.provider.adapterId, chatPath: profile.provider.chatPath, authStyle: 'bearer', transportPolicy: profile.provider.transportPolicy }),
    getToolSpecs: run => service.getToolSpecs(run),
    streamChatImpl: (params, ...ports) => {
      assert.equal(params.baseUrl, profile.provider.baseUrl); assert.equal(params.model, profile.model.remoteModelId); assert.equal(params.apiKey, secret)
      return api.streamChat({ ...params, baseUrl: localUrl, provider: { ...params.provider, chatPath: '/model', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } } },
        event => { if (event.type === 'done') finishReasons.push(event.finishReason); ports[0](event) }, ...ports.slice(1))
    }
  })
  const store = api.createRunStorePort(repo, path.join(dir, 'artifacts'))
  const executor = api.createToolExecutor({ getAllowList: () => api.allowListFromConfig(config), getSignal: () => engine.abortSignal(runId), getEnv: () => ({ workDir: dir, docDir: dir, sessionId }),
    getProviderWeb: (_run, toolCallId, hooks) => api.createRunProviderWeb({ repository: repo, runId, toolCallId, config, hooks,
      resolveCredential: ref => { assert.deepEqual(ref, profile.credential); keyResolutions++; return secret }, dependencies: {
        transport: (url, init, _policy, _resolver, limits) => {
          assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + secret)
          return api.secureProviderFetch(localUrl + '/v1/responses', init, { scope: 'loopback_http', allowNonDefaultPort: true }, undefined, limits)
        }
      } }) })
  engine = api.createAgentRunEngine({ store, getConfig: () => config, modelCall: adapter,
    toolExecutor: (name, args, call, run, hooks) => {
      if (service.has(config, name)) { resourceReads++; return service.execute(run, name, args) }
      return executor(name, args, call, run, hooks)
    }, onEvent: () => {}, onRunUpdate: () => {} })
  service.attachEngine(engine, () => config)
  assert.equal((await engine.start({ runId, sessionId, config })).ok, true)
  await store.appendTurn({ runId, turnId: 'user', turnSeq: 1, role: 'user', content: '核对公开来源', createdAt: Date.now() })
  return { repo, engine, runId, config, modelBodies, providerRequests, paths, evidence, finishReasons, keyResolutions: () => keyResolutions, resourceReads: () => resourceReads,
    close: async () => { await service.close(); repo.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

test('选中技能与已授权hosted search在真实Responses HTTP/共享engine共存；冻结Key、来源与调用凭证落库', async () => {
  const f = await hostedSkillFixture('hosted-skill-supported')
  try {
    await f.engine.step(f.runId)
    assert.equal(f.repo.getRun(f.runId).status, 'completed', f.repo.getRun(f.runId).error_message ?? '')
    assert.deepEqual(f.modelBodies[0].tools.map(tool => tool.name).sort(), ['read_skill_resource', 'web_search'])
    assert.equal(f.modelBodies.length, 3); assert.equal(f.providerRequests.length, 1); assert.equal(f.keyResolutions(), 1)
    assert.deepEqual(f.finishReasons, ['tool_calls', 'tool_calls', 'stop']); assert.equal(f.resourceReads(), 1)
    const wire = f.providerRequests[0]
    assert.equal(wire.authorization, 'Bearer synthetic-extension-hosted-current-key')
    assert.equal(wire.body.model, 'gpt-5.4'); assert.equal(wire.body.input, 'public source evidence')
    assert.equal(Object.hasOwn(wire.body, 'max_tool_calls'), false); assert.equal(wire.body.tool_choice, 'required')
    assert.ok(!JSON.stringify(wire.body).includes('# 稿件结构审阅'), 'provider search request must not receive private history or skill instructions')
    const rows = f.repo.getToolCallsByRun(f.runId)
    assert.deepEqual(rows.map(row => row.name).sort(), ['read_skill_resource', 'web_search'])
    assert.ok(rows.every(row => row.status === 'completed'))
    const attempts = f.repo.getProviderAttempts(f.runId)
    assert.equal(attempts.length, 1); assert.equal(attempts[0].model_id, 'gpt-5.4'); assert.equal(attempts[0].cost_status, 'unknown')
    const receipt = f.repo.getRunEvidence(f.runId, 'provider_web:ext-web:' + attempts[0].logical_call_id)
    assert.ok(receipt); assert.match(receipt.json, /ws_hosted_fixture/)
    assert.ok(!JSON.stringify({ rows, attempts, receipt, config: f.config }).includes('synthetic-extension-hosted-current-key'))
    assert.equal(api.activeChildProcesses().length, 0)
  } finally { await f.close() }
})

test('技能不授予免费联网：禁用/不支持/fetch越权均拒绝真实伪造call且0供应商请求；原生无search证据失败不降级', async () => {
  for (const [name, options, expectedCalls] of [
    ['disabled', { enabled: false }, 0], ['unsupported', { supported: false }, 0],
    ['fetch-denied', { operation: 'read_web_page' }, 0], ['ungrounded', { validSearch: false }, 1]
  ]) {
    const f = await hostedSkillFixture('hosted-skill-' + name, options)
    try {
      await f.engine.step(f.runId)
      const names = f.modelBodies[0].tools.map(tool => tool.name)
      assert.ok(names.includes('read_skill_resource')); assert.ok(!names.includes('read_web_page'))
      assert.equal(names.includes('web_search'), !['disabled', 'unsupported'].includes(name))
      assert.equal(f.providerRequests.length, expectedCalls); assert.equal(f.keyResolutions(), expectedCalls)
      const rejected = f.repo.getToolCallsByRun(f.runId).find(row => row.name === (options.operation ?? 'web_search'))
      assert.ok(rejected); assert.equal(api.decodeToolResult({ status: rejected.status, resultJson: rejected.result_json }).ok, false)
      assert.match(rejected.result_json, expectedCalls ? /可核验的联网结果/ : /tool_not_allowed_by_mode|白名单/)
      assert.ok(f.paths.every(value => ['/model', '/v1/responses'].includes(value)))
      assert.equal(api.activeChildProcesses().length, 0)
    } finally { await f.close() }
  }
})

test('有技能与hosted搜索授权也不能绕过硬费用上限：未知总价在外呼前停下', async () => {
  const f = await hostedSkillFixture('hosted-skill-cost-cap', { costCap: .1 })
  try {
    await f.engine.step(f.runId)
    assert.equal(f.repo.getRun(f.runId).status, 'waiting_user')
    assert.equal(f.repo.getRun(f.runId).error_code, 'run_cost_unknown_price')
    assert.equal(f.providerRequests.length, 0); assert.equal(f.repo.getProviderAttempts(f.runId).length, 0)
    assert.ok(f.modelBodies[0].tools.some(tool => tool.name === 'web_search'))
    assert.equal(api.activeChildProcesses().length, 0)
  } finally { await f.close() }
})

test('Responses真实终态保留stop/length/error：截断或失败中的function_call不执行扩展或供应商工具', async () => {
  for (const [terminal, expected] of [['text-only', ['stop']], ['incomplete', ['length', 'length']], ['failed', []]]) {
    const f = await hostedSkillFixture('hosted-terminal-' + terminal, { terminal })
    try {
      await f.engine.step(f.runId)
      assert.deepEqual(f.finishReasons, expected)
      assert.equal(f.resourceReads(), 0); assert.equal(f.providerRequests.length, 0); assert.equal(f.keyResolutions(), 0)
      assert.equal(f.modelBodies.length, terminal === 'incomplete' ? 2 : 1)
      if (terminal === 'incomplete') assert.equal(f.repo.getRun(f.runId).error_code, 'agent_output_stalled', 'a second clipped request must not dispatch either partial tool')
      if (terminal === 'failed') { assert.equal(f.repo.getRun(f.runId).status, 'failed'); assert.ok(!f.repo.getRun(f.runId).error_message.includes('synthetic-extension-hosted-current-key')) }
      assert.equal(api.activeChildProcesses().length, 0)
    } finally { await f.close() }
  }
})

test('生产桌面IPC结果封套与preload/UI一致，失败不泄露任意异常源文本', async () => {
  const dir = path.join(baseDir, 'ipc-envelope'); await fs.mkdir(dir)
  const service = bareService(dir)
  try {
    const before = await api.desktopExtensionResult(() => service.snapshot())
    assert.equal(before.ok, true); assert.equal(before.data.catalog.length, 3)
    const installed = await api.desktopExtensionResult(() => service.installCatalog(skillId))
    assert.equal(installed.ok, true); assert.equal(installed.data.enabled, false)
    const denied = await api.desktopExtensionResult(() => service.setSelection({ skills: [skillId], plugins: [] }))
    assert.equal(denied.ok, false); assert.equal(denied.error.code, 'extension_rejected')
    const unsafe = await api.desktopExtensionResult(async () => { throw new Error('SYNTHETIC_SECRET_IN_PARSER_EXCEPTION') })
    assert.equal(unsafe.ok, false); assert.ok(!JSON.stringify(unsafe).includes('SYNTHETIC_SECRET_IN_PARSER_EXCEPTION'))
    assert.equal(api.activeChildProcesses().length, 0)
  } finally { await service.close() }
})

test('桌面第一方stdio的schema/读取/终态await PIDgone；启动与安装/启用分开', async () => {
  const f = await fixture('plugin-body')
  try {
    assert.equal(api.activeChildProcesses().length, 0)
    const one = f.engine.step(f.runId), two = f.engine.step(f.runId); assert.equal(one, two)
    await one
    assert.equal(f.repo.getRun(f.runId).status, 'completed'); assert.equal(f.grantCalls(), 1); assert.equal(f.bodies.length, 2)
    const started = f.evidence.find((item) => item.kind.startsWith('extension_host_started_')).value
    const stopped = f.evidence.find((item) => item.kind.startsWith('extension_host_stopped_')).value
    assert.ok(started.pid); assert.equal(stopped.exited, true); assert.deepEqual(stopped.remainingPids, []); pidGone(started.pid)
    assert.equal(f.service.hasActiveHosts, false)
    await assert.rejects(f.service.execute(f.runId, f.config.extensionsFrozen.bindings[0].name, JSON.stringify({ path: path.join(f.dir, 'documents', '稿件.md') })), /宿主已关闭/)
  } finally { await f.close() }
  const denied = await fixture('plugin-denied', { authorize: false })
  try {
    await denied.engine.step(denied.runId)
    assert.notEqual(denied.repo.getRun(denied.runId).status, 'completed'); assert.equal(denied.grantCalls(), 1)
    assert.equal(denied.bodies.length, 0); assert.equal(api.activeChildProcesses().length, 0)
  } finally { await denied.close() }
})

test('桌面frozen allowList/root交集：无权限0启动/0请求，已授权目录外实际读取拒绝', async () => {
  await fs.writeFile(path.join(baseDir, 'private.txt'), 'private-content')
  const blocked = await fixture('plugin-policy', { strictPolicy: true })
  try { await blocked.engine.step(blocked.runId); assert.equal(blocked.bodies.length, 0); assert.equal(blocked.grantCalls(), 0); assert.equal(api.activeChildProcesses().length, 0) } finally { await blocked.close() }
  const outside = await fixture('plugin-outside', { mode: 'outside' })
  try { await outside.engine.step(outside.runId); assert.equal(outside.repo.getRun(outside.runId).status, 'completed'); assert.equal(outside.bodies.length, 2); assert.equal(api.activeChildProcesses().length, 0) } finally { await outside.close() }
})

test('桌面暂停/取消/应用close令待决grant settle；迟到allow永不spawn或fetch', async () => {
  for (const action of ['pause', 'cancel', 'close']) {
    const f = await fixture('pending-' + action, { authorize: 'pending', mode: 'slow' })
    try {
      const pending = f.engine.step(f.runId); await f.entered
      if (action === 'close') await f.service.close(); else await f.engine[action](f.runId)
      f.release(); await pending
      assert.equal(f.bodies.length, 0); assert.equal(api.activeChildProcesses().length, 0)
      assert.ok(f.evidence.some((item) => item.kind.startsWith('extension_start_grant_') && item.value.decision === 'deny'))
      if (action === 'pause') assert.equal(f.repo.getRun(f.runId).status, 'waiting_user')
      if (action === 'cancel') assert.equal(f.repo.getRun(f.runId).status, 'cancelled')
    } finally { await f.close() }
  }
})

test('桌面和另进程共享durable撤权：disable/remove后PIDgone+暂停；旧plugin pin不能恢复fetch', async () => {
  for (const action of ['local-disable', 'external-remove']) {
    const f = await fixture('revoke-' + action, { mode: 'slow' })
    try {
      const pending = f.engine.step(f.runId)
      await waitUntil(() => f.bodies.length > 0, 'first actual desktop HTTP request required')
      const started = f.evidence.find((item) => item.kind.startsWith('extension_host_started_')).value
      process.kill(started.pid, 0)
      if (action === 'local-disable') await f.service.setEnabled(inspectorId, false)
      else {
        const controller = path.join(f.dir, 'registry-revoke.cjs')
        const result = await compile(`import {ExtensionRegistry} from './src/main/extensions/ExtensionRegistry'; new ExtensionRegistry(process.argv[2]).setEnabled('deepwriter/manuscript-inspector',false,true).catch(e=>{process.stderr.write(e.message);process.exitCode=1});`)
        await fs.writeFile(controller, result.outputFiles[0].text)
        const child = spawn(process.execPath, [controller, f.service.registry.root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk }); assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) }), 0, stderr)
      }
      await pending
      assert.equal(f.repo.getRun(f.runId).status, 'waiting_user'); pidGone(started.pid)
      assert.equal(api.activeChildProcesses().length, 0); assert.equal(f.bodies.length, 1)
      await assert.rejects(f.engine.restore(f.runId), /permission_revoked/); assert.equal(f.bodies.length, 1)
    } finally { await f.close() }
  }
})

test('桌面旧skill pin升级/卸载仍恢复原完整prefix，不读取新的全局selection', async () => {
  const f = await fixture('old-skill', { selected: 'skill', mode: 'slow' })
  try {
    const old = f.config.extensionsFrozen.skills[0]
    const first = f.engine.step(f.runId); await waitUntil(() => f.bodies.length > 0, 'first desktop skill request required')
    assert.equal(f.service.hasActiveHosts, false, 'skill-only run must not add a plugin shutdown trace')
    await f.engine.pause(f.runId); await first
    await f.service.remove(skillId)
    await f.service.installCatalog('deepwriter/prose-polish'); await f.service.setEnabled('deepwriter/prose-polish', true)
    await f.service.setSelection({ skills: ['deepwriter/prose-polish'], plugins: [] })
    await f.engine.restore(f.runId)
    const resumed = f.engine.step(f.runId); await waitUntil(() => f.bodies.length === 2, 'resumed desktop request required')
    await f.engine.pause(f.runId); await resumed
    assert.ok(f.bodies[1].messages.some((message) => message.content?.includes(old.instructions[0].content)))
    assert.ok(!f.bodies[1].messages.some((message) => message.content?.includes('deepwriter/prose-polish')))
    assert.equal(f.config.extensionsFrozen.skills[0].record.packageHash, old.record.packageHash)
    assert.equal(f.grantCalls(), 0)
  } finally { await f.close() }
})

test('实际Electron-as-Node桌面Service宿主独立授权/stdio/close后PIDgone，无监控阻止自然退出', async () => {
  const f = await fixture('controlled-electron', { selected: 'none', mode: 'plugin' })
  const dir = f.dir
  const service = f.service; await service.installCatalog(inspectorId); await service.setEnabled(inspectorId, true); await service.setSelection({ skills: [], plugins: [inspectorId] })
  const file = path.join(dir, 'documents', '稿件.md')
  const controller = path.join(dir, 'desktop-electron.cjs')
  const result = await compile(`
    import {DesktopExtensionService} from './src/main/extensions/DesktopExtensionService';
    import {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    import {createRepository} from './src/main/db/repository';
    import {createRunStorePort,createModelCallAdapter} from './src/main/runKernelAdapter';
    import {activeChildProcesses} from './src/main/childRegistry';
    import {buildExecutionSnapshot} from './src/main/executionSnapshot';
    import assert from 'node:assert/strict'; import path from 'node:path';
    async function main(){
      const dir=process.argv[2]; const repo=createRepository(path.join(dir,'electron.sqlite'));repo.open();repo.createSession('e-session','e','fixture');
      const cfg:any=buildExecutionSnapshot({payload:{id:'e-run',sessionId:'e-session',mode:'agent',text:'检查稿件'},sessionId:'e-session',memory:{projectPath:'',projectContent:'',userContent:''},settings:{model:'fixture',baseUrl:process.argv[4],maxTokens:128,workDir:dir,docDir:path.join(dir,'documents'),thinkingEnabled:false,reasoningEffort:'low',novelMode:false,galgame:{enabled:false},strongConstraintEnabled:false,historyBudgetTokens:8000}} as any);
      cfg.providerCallBudget={maxCalls:8,maxTokens:200000,maxCost:null,maxCostCny:null,maxWallClockMs:30000};
      let pid:number|undefined; let grants=0;
      const service=new DesktopExtensionService({registryDir:path.join(dir,'extensions'),nodeExecutable:process.execPath,electronAsNode:true,chooseSkillDirectory:async()=>null,authorizeStart:async()=>{grants++;return true},writeEvidence:(run,kind,json)=>{repo.saveRunEvidence(run,kind,json);if(kind.startsWith('extension_host_started'))pid=JSON.parse(json).pid}});
      await service.freezeForNewRun(cfg);
      const store=createRunStorePort(repo,path.join(dir,'artifacts'));let engine:any;
      const adapter=createModelCallAdapter({getApi:()=>({apiKey:'',baseUrl:process.argv[4],model:'fixture',maxTokens:128,temperature:0.7,topP:0.9,thinking:{enabled:false,effort:'low'},supportsTools:true,protocol:'deepseek-chat',adapterId:'builtin.deepseek',chatPath:'/chat/completions',authStyle:'none',transportPolicy:{scope:'loopback_http',allowNonDefaultPort:true}}),getConfig:()=>cfg,getSignal:()=>engine.abortSignal('e-run'),buildPrefix:async()=>cfg.frozenSystemMessages,getToolSpecs:(run)=>service.getToolSpecs(run)});
      engine=createAgentRunEngine({store,getConfig:()=>cfg,toolExecutor:(name,args,_call,run)=>service.execute(run,name,args),modelCall:adapter,onEvent:()=>{},onRunUpdate:()=>{}});
      service.attachEngine(engine,()=>cfg);assert.equal((await engine.start({runId:'e-run',sessionId:'e-session',config:cfg})).ok,true);
      await store.appendTurn({runId:'e-run',turnId:'user',turnSeq:1,role:'user',content:'检查稿件',createdAt:Date.now()});await engine.step('e-run');
      assert.equal(repo.getRun('e-run')!.status,'completed',repo.getRun('e-run')!.error_message??'');assert.equal(grants,1);assert.ok(pid);assert.throws(()=>process.kill(pid!,0),(e:any)=>e.code==='ESRCH');
      await service.close();assert.equal(activeChildProcesses().length,0);repo.close();process.stdout.write(JSON.stringify({electron:process.versions.electron,pid,closed:true})+'\\n');
    } main().catch(e=>{process.stderr.write(e.stack);process.exitCode=1});
  `)
  await fs.writeFile(controller, result.outputFiles[0].text)
  const env = { ELECTRON_RUN_AS_NODE: '1', SYNTHETIC_SECRET_MUST_NOT_INHERIT: 'fake-sensitive' }; if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  const child = spawn(require('electron'), [controller, dir, file, f.baseUrl], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk }); child.stderr.on('data', (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill(), 12000)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) }); clearTimeout(timer)
  try { assert.equal(code, 0, stderr); const report = JSON.parse(stdout); assert.ok(report.electron); assert.equal(report.closed, true); pidGone(report.pid); assert.equal(f.bodies.length, 2) } finally { await f.close() }
})
