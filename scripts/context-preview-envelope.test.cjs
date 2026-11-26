// Real SQLite and production snapshot/prefix assembly; no copied prompt builder.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const projectRoot = path.resolve(__dirname, '..')
let production

function declaration(file, name) {
  const source = readFileSync(path.join(projectRoot, file), 'utf8')
  const start = new RegExp(`^(?:export )?(?:async )?function ${name}(?=[\\s(<])`, 'm').exec(source)
  assert.ok(start, `production declaration missing: ${name}`)
  const end = /^}\r?$/m.exec(source.slice(start.index))
  assert.ok(end && end.index > 0)
  return source.slice(start.index, start.index + end.index + 1)
}

before(async () => {
  const result = await esbuild.build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `
        import { buildExecutionSnapshot } from './src/main/executionSnapshot';
        import { ContextV2Service, contextPrefixHash } from './src/main/contextV2';
        import { contextPreviewSchema } from './src/shared/ipcSchemas';
        import { grillMeOutlineHash, createGrillMeState, canonicalizeGrillMePayload, grillMeGateRequired } from './src/shared/grillMe';
        import { canonicalizeAgentPlanApproval, validateAgentPlanExecution } from './src/main/agentPlan';
        import { loadMemory } from './src/main/memory';
        import { createRepository } from './src/main/db/repository';
        import { createContextService } from './src/main/contextService';
        import { attachmentZipHandle } from './src/main/attachedZip';
        import { buildNarrativeFactsFromGrill } from './src/main/narrative/factRegistry';
        import { DesktopExtensionService } from './src/main/extensions/DesktopExtensionService';
        let userData, repository;
        class IpcError extends Error { constructor(code, message) { super(message); this.code = code; } }
        export function setRepository(value) { repository = value; }
        let desktopExtensions;
        const app = { getPath: () => userData };
        function ensureDesktopExtensions() {
          if (!desktopExtensions) throw new Error('isolated desktop extension service not initialized');
          return desktopExtensions;
        }
        // Opaque file-ref read adapter: identical first-round invocation on
        // preview and accept. No real credentials or user files are read.
        async function buildAttachmentMessage(ref, sessionId, lease) {
          return { role: 'user', content: JSON.stringify({ ref, sessionId, lease, body: '隔离附件内容' }) };
        }
        ${declaration('src/main/index.ts', 'buildRunPrefix')}
        ${declaration('src/main/index.ts', 'buildContextPreviewEnvelope')}
        export function setUserData(value) {
          userData = value;
          desktopExtensions = new DesktopExtensionService({ registryDir: value + '/extensions', nodeExecutable: process.execPath,
            chooseSkillDirectory: async () => null, authorizeStart: async () => false,
            writeEvidence: () => { throw new Error('preview must not execute a tool plugin'); } });
          return desktopExtensions;
        }
        export { buildExecutionSnapshot, buildRunPrefix, buildContextPreviewEnvelope,
          ContextV2Service, contextPrefixHash, contextPreviewSchema, grillMeOutlineHash, loadMemory,
          createRepository, createContextService, buildNarrativeFactsFromGrill, createGrillMeState };
      `,
      loader: 'ts', resolveDir: projectRoot
    },
    bundle: true, platform: 'node', format: 'cjs', tsconfigRaw: {}, write: false, logLevel: 'silent',
    plugins: [{ name: 'workspace-source-boundary', setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (!args.path.startsWith('.') && args.path !== 'electron') return { path: args.path, external: true }
        const target = args.path === 'electron' ? path.join(projectRoot, 'src/cli/host.ts') : path.resolve(args.resolveDir, args.path)
        const resolved = ['', '.ts', '.tsx', '.js', '/index.ts'].map(extension => target + extension).find(existsSync)
        if (!resolved || !resolved.startsWith(projectRoot + path.sep)) throw new Error(`Unexpected test import: ${args.path}`)
        return { path: resolved, namespace: 'workspace-source' }
      })
      build.onLoad({ filter: /.*/, namespace: 'workspace-source' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
    }}]
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', '__dirname', '__filename', result.outputFiles[0].text)(require, loaded, loaded.exports, __dirname, __filename)
  production = loaded.exports
})

async function fixture(body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-context-envelope-'))
  // Bound memory lookup to this isolated fixture rather than ancestor/user data.
  await fs.writeFile(path.join(root, 'AGENTS.md'), '项目记忆：旧灯塔。', 'utf8')
  await fs.writeFile(path.join(root, 'memory.md'), '用户记忆：保留悬念。', 'utf8')
  const extensions = production.setUserData(root)
  const service = new production.ContextV2Service(path.join(root, 'deepwriter.db'))
  const settings = {
    apiKey: '', model: 'deepseek-v4-flash', baseUrl: 'http://127.0.0.1:1',
    thinkingEnabled: false, reasoningEffort: 'low', temperature: 0.7, topP: 0.9,
    maxTokens: 8192, toolsEnabled: false, docDir: root, workDir: root,
    historyBudgetTokens: 64000, planMode: false, permissionMode: 'safe', novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' }, completionTokenBudget: 200000,
    completionWallClockMs: 0, strongConstraintsEnabled: true, themeLockMode: 'strong',
    expressionFreedom: 'high', antiMoralizingEnabled: true, userPresetPrompt: '保留用户原始命题。'
  }
  const outline = {
    title: '旧灯塔', premise: '守夜人发现灯塔中的真相。', targetChars: 8000,
    sections: [{ id: 'section-1', title: '灯塔之夜', purpose: '守夜人发现灯塔中的真相。', targetChars: 8000, beats: ['发现异常', '面对真相'], sourceSlotIds: ['conflict'] }]
  }
  const input = {
    sessionId: 'isolated-envelope-session', mode: 'optimized', preferenceRevision: 0,
    draftText: '写一篇守夜人与旧灯塔的小说。',
    attachments: [{ fileRefId: 'isolated-attachment', name: '灯塔资料.txt', size: 42 }],
    runMode: 'longwrite', longMode: true, phase: 'execute', planText: '', targetChars: 8000,
    grillMe: {
      stateId: 'isolated-grill', originalTask: '写一篇守夜人与旧灯塔的小说。', targetChars: 8000,
      answers: [{ slotId: 'conflict', value: '守夜人面对灯塔的真相。', source: 'user' }],
      assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash: production.grillMeOutlineHash(outline)
    }
  }
  const repository = production.createRepository(path.join(root, 'deepwriter.db'))
  repository.open()
  const base = production.createGrillMeState({ stateId: input.grillMe.stateId, sessionId: input.sessionId, originalTask: input.draftText, targetChars: input.targetChars, now: 1 })
  // This fixture predates writing-form classification. Preserve that legacy
  // contract; dedicated IPC tests cover the new explicit form.
  delete base.writingForm
  repository.saveGrillMeState({ ...base, status: 'confirmed', currentQuestion: null,
    slots: base.slots.map(slot => { const answer = input.grillMe.answers.find(item => item.slotId === slot.id); return answer ? { ...slot, answer: answer.value, source: answer.source } : slot }),
    assumptions: input.grillMe.assumptions, approvedOutline: outline, outline, outlineHash: input.grillMe.outlineHash, outlineRevision: 1 })
  production.setRepository(repository)
  const acceptPrefix = async (value = input, options = settings) => {
    const memory = await production.loadMemory(options.workDir, root)
    const snapshot = production.buildExecutionSnapshot({
      payload: { id: 'different-real-run-id', sessionId: value.sessionId, text: value.draftText,
        mode: value.runMode, longMode: value.longMode, phase: value.phase, planText: value.planText,
        targetChars: value.targetChars, attachments: value.attachments, grillMe: value.grillMe,
        story: value.story, strongConstraints: value.strongConstraints },
      settings: options, sessionId: value.sessionId,
      memory: { projectPath: memory.projectMemoryPath ?? '', projectContent: memory.projectMemoryContent ?? '', userContent: memory.userMemoryContent ?? '' }
    })
    await extensions.freezeForNewRun(snapshot)
    return production.buildRunPrefix(snapshot, 1)
  }
  const preview = envelope => service.preview({
    sessionId: input.sessionId, mode: input.mode, draftText: input.draftText, attachments: input.attachments,
    maxContextTokens: 131072, outputReserveTokens: 8192, capabilityFingerprint: 'isolated-model-a',
    requiredPrefix: envelope.prefix, requiredAliases: envelope.aliases, prefixHash: envelope.prefixHash
  })
  const freeze = (view, prefix, capabilityFingerprint = 'isolated-model-a') => service.freezeForRun({
    sessionId: input.sessionId,
    selection: { schemaVersion: 1, previewId: view.previewId, mode: view.mode, policyRevision: view.policyRevision },
    draftText: input.draftText, attachments: input.attachments, outputReserveTokens: 8192,
    capabilityFingerprint, prefixHash: production.contextPrefixHash(prefix)
  })
  try { await body({ service, extensions, settings, input, acceptPrefix, preview, freeze }) } finally {
    await extensions.close()
    repository.close()
    service.close()
    assert.equal(path.dirname(root), os.tmpdir())
    assert.ok(path.basename(root).startsWith('deepwriter-context-envelope-'))
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('true/false longMode and first-round attachments produce the exact accepted prefix, independent of run ID', async () => {
  await fixture(async ({ input, settings, acceptPrefix, preview, freeze }) => {
    for (const longMode of [true, false]) {
      const value = { ...input, longMode }
      assert.equal(production.contextPreviewSchema.parse(value).longMode, longMode)
      const envelope = await production.buildContextPreviewEnvelope(value, settings)
      const accepted = await acceptPrefix(value)
      assert.deepEqual(envelope.prefix, accepted)
      assert.equal(envelope.prefix.filter(message => message.role === 'user').length, 1)
      assert.ok(envelope.prefix.some(message => message.content.includes('隔离附件内容')))
      const view = preview(envelope)
      assert.equal(view.budget.status, 'ready')
      assert.equal(freeze(view, accepted).schemaVersion, 2)
    }
    const omitted = { ...input }
    delete omitted.longMode
    assert.deepEqual((await production.buildContextPreviewEnvelope(omitted, settings)).prefix, await acceptPrefix({ ...input, longMode: false }))
  })
})

test('old longMode=false preview is reproducibly stale for a confirmed longMode=true writer', async () => {
  await fixture(async ({ input, settings, acceptPrefix, preview, freeze }) => {
    const oldSemantics = await production.buildContextPreviewEnvelope({ ...input, longMode: false }, settings)
    const accepted = await acceptPrefix(input)
    assert.notEqual(oldSemantics.prefixHash, production.contextPrefixHash(accepted))
    assert.throws(() => freeze(preview(oldSemantics), accepted), error => error.code === 'context_preview_stale')
    const current = await production.buildContextPreviewEnvelope(input, settings)
    assert.equal(freeze(preview(current), accepted).schemaVersion, 2)
  })
})

test('model, phase, outline, longMode and user preset changes still refuse the old preview', async () => {
  await fixture(async ({ input, settings, acceptPrefix, preview, freeze }) => {
    const envelope = await production.buildContextPreviewEnvelope(input, settings)
    const view = preview(envelope)
    const unchanged = await acceptPrefix()
    assert.throws(() => freeze(view, unchanged, 'isolated-model-b'), error => error.code === 'context_preview_stale')
    const changedOutline = structuredClone(input)
    changedOutline.grillMe.approvedOutline.sections[0].purpose = '守夜人主动揭露真相。'
    changedOutline.grillMe.outlineRevision += 1
    changedOutline.grillMe.outlineHash = production.grillMeOutlineHash(changedOutline.grillMe.approvedOutline)
    for (const value of [{ ...input, phase: 'plan' }, { ...input, longMode: false }, changedOutline]) {
      const changed = await acceptPrefix(value)
      assert.notEqual(production.contextPrefixHash(changed), envelope.prefixHash)
      assert.throws(() => freeze(view, changed), error => error.code === 'context_preview_stale')
    }
    const changedPreset = await acceptPrefix(input, { ...settings, userPresetPrompt: '改为完全不同的叙事预设。' })
    assert.throws(() => freeze(view, changedPreset), error => error.code === 'context_preview_stale')
    assert.equal(freeze(view, unchanged).schemaVersion, 2)
  })
})

test('actual first-party skill selection freezes identical full instructions/hash/budget in preview and accept; old selection is stale', async () => {
  await fixture(async ({ extensions, input, settings, acceptPrefix, preview, freeze }) => {
    const baseline = preview(await production.buildContextPreviewEnvelope(input, settings))
    const skills = (await extensions.snapshot()).catalog.filter(item => item.kind === 'skill')
    assert.ok(skills.length >= 2)
    for (const skill of skills.slice(0, 2)) {
      assert.equal((await extensions.installCatalog(skill.id)).enabled, false)
      await extensions.setEnabled(skill.id, true)
    }
    await extensions.setSelection({ skills: [skills[0].id], plugins: [] })
    const envelope = await production.buildContextPreviewEnvelope(input, settings)
    const accepted = await acceptPrefix()
    const pin = await extensions.registry.freeze(skills[0].id, 'skill')
    assert.ok(pin.instructions.length > 0)
    for (const instruction of pin.instructions) assert.ok(accepted.some(message => message.content.includes(instruction.content)))
    assert.deepEqual(envelope.prefix, accepted)
    assert.equal(envelope.prefixHash, production.contextPrefixHash(accepted))
    const view = preview(envelope)
    const actualView = preview({ ...envelope, prefix: accepted, prefixHash: production.contextPrefixHash(accepted) })
    assert.equal(view.budget.status, 'ready')
    assert.deepEqual(view.savings.selectedInput, actualView.savings.selectedInput)
    assert.ok(view.savings.selectedInput.value > baseline.savings.selectedInput.value)
    assert.equal(freeze(view, accepted).schemaVersion, 2)
    await extensions.setSelection({ skills: [skills[1].id], plugins: [] })
    const changed = await acceptPrefix()
    assert.throws(() => freeze(view, changed), error => error.code === 'context_preview_stale')
    const current = await production.buildContextPreviewEnvelope(input, settings)
    assert.deepEqual(current.prefix, changed)
    assert.equal(freeze(preview(current), changed).schemaVersion, 2)
  })
})

async function v2Fixture(body, source = 'user', missing = false) {
  await fixture(async ({ input, settings }) => {
    const repo = production.createRepository(path.join(settings.workDir, 'deepwriter.db'))
    repo.open()
    const value = structuredClone(input)
    value.grillMe.answers = missing ? [] : value.grillMe.answers.map(answer => ({ ...answer, source }))
    const runId = 'isolated-confirmed-v2-run'
    const config = production.buildExecutionSnapshot({
      payload: { id: runId, sessionId: value.sessionId, text: value.draftText, mode: 'longwrite', longMode: true,
        phase: 'execute', targetChars: 8000, attachments: [], grillMe: value.grillMe },
      settings, sessionId: value.sessionId,
      memory: { projectPath: '', projectContent: '', userContent: '' }
    })
    config.frozenContext = { schemaVersion: 2, mode: 'optimized' }
    repo.createSession(value.sessionId, '隔离确认事实', 'fixture')
    repo.createRun({ run_id: runId, session_id: value.sessionId, status: 'running', phase: 'writing',
      started_at: 1, updated_at: 1, config_json: JSON.stringify(config), parent_run_id: null, error_code: null, error_message: null })
    repo.ensureSceneStates(runId, config.sceneContracts, 1)
    const context = production.createContextService(repo)
    let request = 0
    const assemble = next => context.assembleRunContext(next ?? config, ++request,
      [{ role: 'user', content: value.draftText }], [{ role: 'system', content: '只输出正文。' }], 'writer', `isolated-v2-${request}`)
    try { await body({ repo, config, input: value, runId, assemble }) } finally { repo.close() }
  })
}

test('V2 first writer materializes only durable confirmed sources, repeated calls do not duplicate facts', async () => {
  await v2Fixture(async ({ repo, config, input, assemble }) => {
    assert.equal(repo.getNarrativeFacts(input.sessionId, true).length, 0)
    const first = await assemble()
    assert.ok(first.sceneWorkingSetFence)
    assert.ok(first.messages.some(message => message.content.includes(input.grillMe.answers[0].value)))
    first.persistSceneEnvelope(first.messages)
    first.sceneWorkingSetFence(first.messages)
    const facts = repo.getNarrativeFacts(input.sessionId, true)
    assert.equal(facts.length, 1)
    assert.equal(facts[0].version, 1)
    assert.equal(facts[0].sources[0].sourceSlotId, 'conflict')
    await assemble()
    assert.deepEqual(repo.getNarrativeFacts(input.sessionId, true), facts)
    const callerChanged = structuredClone(config)
    callerChanged.grillMe.answers[0].value = '未经持久确认的调用者修改。'
    await assert.rejects(assemble(callerChanged), /scene_working_set_confirmed_grill_drift/)
    assert.deepEqual(repo.getNarrativeFacts(input.sessionId, true), facts)
  })
})

test('V2 missing or untrusted confirmation never becomes an active required fact', async () => {
  await v2Fixture(async ({ repo, input, assemble }) => {
    await assert.rejects(assemble(), /scene_working_set_required_fact_missing:conflict/)
    assert.equal(repo.getNarrativeFacts(input.sessionId, true).length, 0)
  }, 'user', true)
  await v2Fixture(async ({ repo, input, assemble }) => {
    await assert.rejects(assemble(), /scene_working_set_required_fact_missing:conflict/)
    const facts = repo.getNarrativeFacts(input.sessionId, true)
    assert.equal(facts.length, 1)
    assert.equal(facts[0].status, 'pending_review')
  }, 'unknown')
})

test('V2 later valid-hash source drift stays refused rather than being silently upserted back', async () => {
  await v2Fixture(async ({ repo, input, runId, assemble }) => {
    const first = await assemble()
    first.persistSceneEnvelope(first.messages)
    first.sceneWorkingSetFence(first.messages)
    const changed = production.buildNarrativeFactsFromGrill({ sessionId: input.sessionId, runId,
      answers: [{ slotId: 'conflict', value: '来源已被外部修订。', source: 'user' }] })[0]
    const altered = repo.upsertNarrativeFact(changed)
    assert.equal(altered.version, 2)
    await assert.rejects(assemble(), /scene_working_set_confirmed_fact_drift/)
    assert.equal(repo.getNarrativeFact(altered.factId).canonicalHash, altered.canonicalHash)
    assert.throws(() => first.sceneWorkingSetFence(first.messages), /scene_working_set/)
  })
})
