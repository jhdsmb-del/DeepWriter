const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { before, test } = require('node:test')
const esbuild = require('esbuild')

const projectRoot = path.resolve(__dirname, '..')
let createAgentRunEngine
let createRepository
let createRunStorePort
let buildExecutionSnapshot

before(async () => {
  const result = await esbuild.build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `
        export { createAgentRunEngine } from './src/main/jobs/AgentRunEngine';
        export { createRepository } from './src/main/db/repository';
        export { createRunStorePort } from './src/main/runKernelAdapter';
        export { buildExecutionSnapshot } from './src/main/executionSnapshot';
      `,
      loader: 'ts',
      resolveDir: projectRoot
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfigRaw: {},
    plugins: [{
      name: 'workspace-source-boundary',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (!args.path.startsWith('.') && args.path !== 'electron') return { path: args.path, external: true }
          const target = args.path === 'electron'
            ? path.join(projectRoot, 'scripts/electron-test-shim.ts')
            : path.resolve(args.resolveDir, args.path)
          const resolved = ['', '.ts', '.tsx', '.js', '/index.ts'].map((extension) => target + extension).find(existsSync)
          if (!resolved || !resolved.startsWith(projectRoot + path.sep)) throw new Error(`Unexpected test import: ${args.path}`)
          return { path: resolved, namespace: 'workspace-source' }
        })
        build.onLoad({ filter: /.*/, namespace: 'workspace-source' }, (args) => ({
          contents: readFileSync(args.path, 'utf8'),
          loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
          resolveDir: path.dirname(args.path)
        }))
      }
    }],
    write: false,
    logLevel: 'silent'
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', '__dirname', '__filename', result.outputFiles[0].text)(require, loaded, loaded.exports, __dirname, __filename)
  ;({ createAgentRunEngine, createRepository, createRunStorePort, buildExecutionSnapshot } = loaded.exports)
})

const hash = (content) => createHash('sha256').update(content, 'utf8').digest('hex')
const prose = Array.from({ length: 800 }, (_, index) => index % 80 === 79 ? '。' : String.fromCodePoint(0x20000 + index)).join('')

async function deliveryFixture(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-delivery-recovery-'))
  const docDir = path.join(root, 'documents')
  const artifactDir = path.join(root, 'artifacts')
  const documentPath = path.join(docDir, '稿件.md')
  const databasePath = path.join(root, 'runs.sqlite')
  const runId = `delivery-${name}`
  const sessionId = `${runId}-session`
  let repository = createRepository(databasePath)
  repository.open()
  repository.createSession(sessionId, '稿件交付恢复', 'fixture')
  const config = buildExecutionSnapshot({
    payload: { id: runId, sessionId, mode: 'longwrite', workspace: 'novel', longMode: true, targetChars: 800, phase: 'execute', text: '写灯塔故事，只输出正文。' },
    settings: {
      apiKey: 'synthetic-only', model: 'synthetic-delivery', baseUrl: 'http://127.0.0.1',
      userPresetPrompt: '', thinkingEnabled: false, reasoningEffort: 'low', temperature: 0.7, topP: 0.9,
      maxTokens: 4096, toolsEnabled: false, docDir, historyBudgetTokens: 64000, workDir: root,
      planMode: false, permissionMode: 'safe', novelMode: false,
      galgame: { enabled: false, projectDir: '', sdkPath: '' }, completionTokenBudget: 0, completionWallClockMs: 0,
      strongConstraintEnabled: false, themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: false
    },
    sessionId,
    memory: { projectPath: '', projectContent: '', userContent: '' },
    now: Date.now()
  })
  let providerCalls = 0
  let publishCalls = 0
  // The engine owns when to enter delivery. This publisher uses real files
  // and the production publisher's immutable same-name/hash contract.
  const publisher = async ({ content, contentHash }) => {
    publishCalls += 1
    await fs.mkdir(docDir, { recursive: true })
    try {
      const existing = await fs.readFile(documentPath, 'utf8')
      if (hash(existing) !== contentHash) throw Object.assign(new Error('同名稿件已存在且内容不同，拒绝覆盖'), {code:'manuscript_destination_conflict'})
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await fs.writeFile(documentPath, content, { encoding: 'utf8', flag: 'wx' })
    }
    assert.equal(hash(await fs.readFile(documentPath, 'utf8')), contentHash)
    return { displayName: '稿件.md', relativePath: documentPath }
  }
  const modelCall = async () => ({
    async *[Symbol.asyncIterator]() {
      providerCalls += 1
      yield { type: 'text', delta: prose }
      yield { type: 'finish', finishReason: 'stop' }
    }
  })
  const engineOptions = (store) => ({
    store, modelCall, toolExecutor: async () => '', getConfig: () => config,
    publishLongwriteArtifact: publisher, onEvent: () => {}, onRunUpdate: () => {}
  })
  const firstStore = createRunStorePort(repository, artifactDir)
  const updateRun = firstStore.updateRun.bind(firstStore)
  firstStore.updateRun = async (id, patch) => {
    // Real crash boundary: accepted manuscript, completed evaluation and
    // artifact row are committed, but the terminal run row is not.
    if (patch.status === 'completed') throw new Error('fixture_terminal_write_interrupted')
    await updateRun(id, patch)
  }
  const first = createAgentRunEngine(engineOptions(firstStore))
  assert.equal((await first.start({ sessionId, runId, config })).ok, true)
  await firstStore.appendTurn({ turnId: `${runId}-user`, runId, turnSeq: 1, role: 'user', content: '写灯塔故事，只输出正文。', createdAt: Date.now() })
  await assert.rejects(first.step(runId), /fixture_terminal_write_interrupted/)
  const artifact = repository.getArtifactsByRun(runId).find((item) => item.artifact_type === 'manuscript')
  assert.ok(artifact)
  assert.equal(artifact.hash, hash(prose))
  assert.equal(repository.getLatestCompletionEvaluation(runId).state, 'completed')
  assert.equal(repository.getRun(runId).status, 'running')
  assert.equal(providerCalls, 1)
  repository.close()
  repository = createRepository(databasePath)
  repository.open()
  const resumedStore = createRunStorePort(repository, artifactDir)
  return {
    root, docDir, artifactDir, documentPath, artifact, store: resumedStore,
    counts: () => ({ providerCalls, publishCalls }),
    acceptedText: () => repository.getManuscriptSegmentsByRun(runId).filter((item) => item.status === 'accepted').map((item) => item.content).join(''),
    amendEvaluation: (patch) => {
      const previous = repository.getLatestCompletionEvaluation(runId)
      const next = { ...JSON.parse(previous.json), revision: previous.revision + 1, ...patch }
      repository.saveCompletionEvaluation(runId, next.revision, next.state, JSON.stringify(next))
    },
    requireAdditionalFile: () => {
      config.completionContract.requiredFiles = [{ path: path.join(docDir, '必须交付.md'), kind: 'markdown', minChars: 100 }]
      config.completionContract.validators.push({ id: 'fileEvidence', severity: 'hard', config: {} })
      repository.updateRun(runId, { config_json: JSON.stringify(config) })
    },
    recover: async (publisherOverride) => {
      publishCalls = 0
      const engine = createAgentRunEngine({ ...engineOptions(resumedStore), ...(publisherOverride ? { publishLongwriteArtifact: publisherOverride } : {}) })
      await engine.restore(runId)
      await engine.step(runId)
      return engine.getState(runId)
    },
    close: async () => {
      repository.close()
      // Only this freshly created fixture directory is cleaned up.
      assert.equal(path.dirname(root), os.tmpdir())
      assert.ok(path.basename(root).startsWith('deepwriter-delivery-recovery-'))
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}

test('恢复时文档文件缺失但 hash 缓存仍在：补回稿件，不再次调用模型', async () => {
  const fixture = await deliveryFixture('missing-document')
  try {
    await fs.unlink(fixture.documentPath)
    assert.equal(await fixture.store.getArtifactContent(fixture.artifact.hash), prose)
    const state = await fixture.recover()
    assert.equal(state.run.status, 'completed', JSON.stringify({ status: state.run.status, code: state.run.errorCode }))
    assert.equal(fixture.counts().publishCalls, 1, '缓存不能替代真实文件交付')
    assert.equal(await fs.readFile(fixture.documentPath, 'utf8'), prose)
    assert.equal(fixture.counts().providerCalls, 1)
  } finally { await fixture.close() }
})

test('恢复时用户已修改同名文档：保留文件和 accepted 正文，明确暂停交付而不伪完成', async () => {
  const fixture = await deliveryFixture('modified-document')
  try {
    const userContent = '用户在中断后编辑的稿件，必须保留。'
    await fs.writeFile(fixture.documentPath, userContent, 'utf8')
    assert.equal(await fixture.store.getArtifactContent(fixture.artifact.hash), prose)
    const state = await fixture.recover()
    assert.equal(state.run.status, 'waiting_user', JSON.stringify({ status: state.run.status, code: state.run.errorCode }))
    assert.equal(state.run.errorCode, 'longwrite_delivery_failed')
    assert.match(state.run.errorMessage, /正文已收稿.*拒绝覆盖/)
    assert.equal(await fs.readFile(fixture.documentPath, 'utf8'), userContent)
    assert.equal(fixture.acceptedText(), prose)
    assert.equal(fixture.counts().publishCalls, 1)
    assert.equal(fixture.counts().providerCalls, 1)
  } finally { await fixture.close() }
})

test('恢复时文档和 hash 缓存都缺失：从 durable accepted 正文补回交付', async () => {
  const fixture = await deliveryFixture('missing-both')
  try {
    await fs.unlink(fixture.documentPath)
    await fs.unlink(path.join(fixture.artifactDir, `${fixture.artifact.hash}.txt`))
    assert.equal(await fixture.store.getArtifactContent(fixture.artifact.hash), null)
    const state = await fixture.recover()
    assert.equal(state.run.status, 'completed', JSON.stringify({ status: state.run.status, code: state.run.errorCode }))
    assert.equal(fixture.counts().publishCalls, 1)
    assert.equal(await fs.readFile(fixture.documentPath, 'utf8'), prose)
    assert.equal(fixture.counts().providerCalls, 1)
  } finally { await fixture.close() }
})

test('健康恢复重新核对文件，保留同一 artifact 和 accepted 内容', async () => {
  const fixture = await deliveryFixture('healthy')
  try {
    const state = await fixture.recover()
    assert.equal(state.run.status, 'completed')
    assert.equal(await fs.readFile(fixture.documentPath, 'utf8'), prose)
    assert.equal(fixture.acceptedText(), prose)
    assert.deepEqual(fixture.counts(), { providerCalls: 1, publishCalls: 1 })
  } finally { await fixture.close() }
})

test('缓存内容损坏不能借健康文档或 completed 行恢复为完成', async () => {
  const fixture = await deliveryFixture('corrupt-cache')
  try {
    await fs.writeFile(path.join(fixture.artifactDir, `${fixture.artifact.hash}.txt`), '损坏缓存。', 'utf8')
    const state = await fixture.recover()
    assert.equal(state.run.status, 'failed')
    assert.equal(state.run.errorCode, 'longwrite_delivery_failed')
    assert.match(state.run.errorMessage, /artifact 内容校验失败/)
    assert.equal(await fs.readFile(fixture.documentPath, 'utf8'), prose)
    assert.equal(fixture.acceptedText(), prose)
    assert.deepEqual(fixture.counts(), { providerCalls: 1, publishCalls: 0 })
  } finally { await fixture.close() }
})

test('publisher 返回另一条路径不能借已有 artifact 宣布交付完成', async () => {
  const fixture = await deliveryFixture('changed-path')
  try {
    let replayCalls = 0
    const state = await fixture.recover(async () => {
      replayCalls += 1
      return { displayName: '另一个稿件.md', relativePath: path.join(fixture.docDir, '另一个稿件.md') }
    })
    assert.equal(state.run.status, 'failed')
    assert.equal(state.run.errorCode, 'longwrite_delivery_failed')
    assert.match(state.run.errorMessage, /发布路径.*不一致/)
    assert.equal(replayCalls, 1)
    assert.equal(await fs.readFile(fixture.documentPath, 'utf8'), prose)
    assert.equal(fixture.counts().providerCalls, 1)
  } finally { await fixture.close() }
})

test('completed 行的字数或冻结起点不匹配：恢复必须停在交付前', async () => {
  for (const patch of [{ measuredChars: 1 }, { startedAt: 1 }]) {
    const fixture = await deliveryFixture(`stale-evaluation-${Object.keys(patch)[0]}`)
    try {
      fixture.amendEvaluation(patch)
      const state = await fixture.recover()
      assert.equal(state.run.status, 'waiting_user')
      assert.equal(state.run.errorCode, 'manuscript_recovery_blocked')
      assert.equal(fixture.acceptedText(), prose)
      assert.deepEqual(fixture.counts(), { providerCalls: 1, publishCalls: 0 })
    } finally { await fixture.close() }
  }
})

test('当前冻结契约缺少必交付文件：旧 completed 行不能跳过当前硬校验', async () => {
  const fixture = await deliveryFixture('new-contract-evidence')
  try {
    fixture.requireAdditionalFile()
    const state = await fixture.recover()
    assert.equal(state.run.status, 'waiting_user')
    assert.equal(state.run.errorCode, 'manuscript_recovery_blocked')
    assert.equal(fixture.acceptedText(), prose)
    assert.deepEqual(fixture.counts(), { providerCalls: 1, publishCalls: 0 })
  } finally { await fixture.close() }
})
