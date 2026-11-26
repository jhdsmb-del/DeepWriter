// Source-local regression for the production Grill lifecycle seam. The
// Electron entry cannot be imported into Node, so extract its actual
// functions; no test-local projection/reducer replaces production behavior.
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
  const start = new RegExp(`^(?:export )?(?:(?:async )?function|class) ${name}(?=[\\s(<])`, 'm').exec(source)
  assert.ok(start, `production declaration missing: ${name}`)
  // These top-level declarations close at column zero. The complete slice
  // is subsequently parsed by esbuild; no body is copied into this test.
  const end = /^}\r?$/m.exec(source.slice(start.index))
  assert.ok(end && end.index > 0, `production declaration unterminated: ${name}`)
  return source.slice(start.index, start.index + end.index + 1)
}

before(async () => {
  const sync = declaration('src/main/index.ts', 'syncGrillWorkflow')
  const syncProjection = declaration('src/main/index.ts', 'syncGrillWorkflowProjection')
  const queueLine = readFileSync(path.join(projectRoot, 'src/main/index.ts'), 'utf8').split(/\r?\n/u).find(line => line.startsWith('const grillWorkflowSyncQueues ='))
  assert.ok(queueLine, 'production Grill sync queue missing')
  const bind = declaration('src/main/index.ts', 'bindLongformWorkflowRun')
  const queue = declaration('src/main/index.ts', 'queueGrillWorkflowProjection')
  const recall = declaration('src/main/index.ts', 'projectConfirmedLongformRecall')
  const start = declaration('src/main/index.ts', 'bindAndStartLongformWorkflowRun')
  const stage = declaration('src/main/index.ts', 'projectLongformStage')
  const ipcError = declaration('src/main/ipcGuard.ts', 'IpcError')
  const rendererError = declaration('src/renderer/src/components/LongformWorkflowShell.tsx', 'grillLaunchErrorMessage')
  const result = await esbuild.build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `
        import { createRepository } from './src/main/db/repository';
        import { createHybridLongformWorkflowSnapshotStore, createLongformWorkflowAuthority, projectLongformWorkflowSceneWorkingSet } from './src/main/longformWorkflow';
        import { createGrillMeState, answerGrillMe } from './src/shared/grillMe';
        import { LongformWorkflowError, longformWorkflowHash } from './src/shared/longformWorkflow';
        let authority;
        function requireLongformWorkflowAuthority() { return authority; }
        ${ipcError}
        ${queueLine}
        ${queue}
        ${sync}
        ${syncProjection}
        ${bind}
        ${recall}
        ${start}
        ${stage}
        ${rendererError}
        export function setAuthority(next) { authority = next; }
        export { createRepository, createHybridLongformWorkflowSnapshotStore, createLongformWorkflowAuthority,
          createGrillMeState, answerGrillMe, LongformWorkflowError, longformWorkflowHash,
          syncGrillWorkflow, bindLongformWorkflowRun, projectConfirmedLongformRecall, bindAndStartLongformWorkflowRun, grillLaunchErrorMessage };
      `,
      loader: 'ts', resolveDir: projectRoot
    },
    bundle: true, platform: 'node', format: 'cjs', tsconfigRaw: {},
    plugins: [{
      name: 'workspace-source-boundary',
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (!args.path.startsWith('.')) return { path: args.path, external: true }
          const target = path.resolve(args.resolveDir, args.path)
          const resolved = ['', '.ts', '.tsx', '.js', '/index.ts'].map(extension => target + extension).find(existsSync)
          if (!resolved || !resolved.startsWith(projectRoot + path.sep)) throw new Error(`Unexpected test import: ${args.path}`)
          return { path: resolved, namespace: 'workspace-source' }
        })
        build.onLoad({ filter: /.*/, namespace: 'workspace-source' }, args => ({
          contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path)
        }))
      }
    }],
    write: false, logLevel: 'silent'
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', '__dirname', '__filename', result.outputFiles[0].text)(require, loaded, loaded.exports, __dirname, __filename)
  production = loaded.exports
})

async function fixture(body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-grill-sync-'))
  const database = path.join(root, 'deepwriter.db')
  const baseDir = path.join(root, 'longform-workflows')
  let repository = production.createRepository(database)
  repository.open()
  const authority = () => production.createLongformWorkflowAuthority({
    store: production.createHybridLongformWorkflowSnapshotStore({ repository, baseDir })
  })
  let currentAuthority = authority()
  production.setAuthority(currentAuthority)
  let state = production.createGrillMeState({ stateId: 'fixture-grill', sessionId: 'fixture-session', originalTask: '写一篇海边旧灯塔与守夜人的长文。', targetChars: 8000 })
  repository.createSession(state.sessionId, '隔离梳理同步回归', 'fixture')
  repository.saveGrillMeState(state)
  const context = {
    get repository() { return repository },
    get authority() { return currentAuthority },
    get state() { return state },
    save(next) { state = next; repository.saveGrillMeState(next) },
    async reopen() {
      repository.close()
      repository = production.createRepository(database)
      repository.open()
      currentAuthority = authority()
      production.setAuthority(currentAuthority)
      state = repository.getGrillMeState(state.sessionId)
      assert.ok(state)
    }
  }
  try { await body(context) } finally {
    repository.close()
    // The target is the exact mkdtemp fixture, never a workspace/user root.
    assert.equal(path.dirname(root), os.tmpdir())
    assert.ok(path.basename(root).startsWith('deepwriter-grill-sync-'))
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('pre-run Grill sync omits undefined run identity and persists exact restart state', async () => {
  await fixture(async context => {
    await production.syncGrillWorkflow(context.state)
    const initial = await context.authority.get(context.state.sessionId)
    assert.equal(initial.stage, 'requirements')
    assert.equal(initial.status, 'waiting_user')
    assert.equal(initial.activeRunId, null)
    assert.equal(initial.authoritativeRevision, 1)
    await production.syncGrillWorkflow(context.state)
    assert.equal((await context.authority.get(context.state.sessionId)).authoritativeRevision, 1)
    context.save(production.answerGrillMe(context.state, context.state.currentQuestion.id, '', 'decide'))
    await production.syncGrillWorkflow(context.state)
    const answered = await context.authority.get(context.state.sessionId)
    assert.equal(answered.authoritativeRevision, 2)
    assert.equal(context.state.answers.length, 1)
    await context.reopen()
    assert.equal(context.state.answers.length, 1)
    assert.equal(production.longformWorkflowHash(await context.authority.get(context.state.sessionId)), production.longformWorkflowHash(answered))
    await production.syncGrillWorkflow(context.state)
    assert.equal((await context.authority.get(context.state.sessionId)).authoritativeRevision, 2)
  })
})

test('defined run identity crosses the hybrid file-to-real-SQLite binding and remains idempotent', async () => {
  await fixture(async context => {
    await production.syncGrillWorkflow(context.state)
    const initial = await context.authority.get(context.state.sessionId)
    const runId = 'fixture-writer-run'
    const scope = { schemaVersion: 1, storyId: initial.storyId, projectId: initial.projectId, branchId: initial.branchId }
    context.repository.createRun({ run_id: runId, session_id: context.state.sessionId, status: 'queued', phase: 'queued', started_at: Date.now(), updated_at: Date.now(), config_json: JSON.stringify({ storyScope: scope }), parent_run_id: null, error_code: null, error_message: null })
    await production.bindLongformWorkflowRun(context.state.sessionId, runId, scope)
    await production.syncGrillWorkflow(context.state, 'requirements', 'waiting_user', undefined, runId)
    const snapshot = await context.authority.get(context.state.sessionId)
    assert.equal(snapshot.activeRunId, runId)
    assert.ok(context.repository.getLongformWorkflowSnapshot(runId, context.state.sessionId))
    await context.reopen()
    assert.equal(production.longformWorkflowHash(await context.authority.get(context.state.sessionId)), production.longformWorkflowHash(snapshot))
    await production.syncGrillWorkflow(context.state, 'requirements', 'waiting_user', undefined, runId)
    assert.equal((await context.authority.get(context.state.sessionId)).authoritativeRevision, snapshot.authoritativeRevision)
  })
})

test('unknown undefined payloads remain refused with a bounded safe reason on the renderer error shape', async () => {
  assert.throws(() => production.longformWorkflowHash({ activeRunId: undefined }), error => error.code === 'longform_payload_undefined')
  await fixture(async context => {
    // A separate corrupt field proves the canonical boundary remains strict;
    // the lifecycle handler must not swallow it or launch a writer anyway.
    const corrupted = { ...context.state, outlineHash: undefined }
    let failure
    try { await production.syncGrillWorkflow(corrupted) } catch (error) { failure = error }
    assert.equal(failure?.code, 'longform_payload_undefined')
    assert.ok(failure.message.startsWith('[longform_payload_undefined]'))
    const electronErrorShape = new Error(`Error invoking remote method 'grill:start': IpcError: ${failure.message}`)
    assert.equal(production.grillLaunchErrorMessage(electronErrorShape), '长文工作流同步失败，当前进度已保留，请重试。')
    assert.equal((await context.authority.get(context.state.sessionId)).authoritativeRevision, 0)
    assert.equal(context.repository.getRun('fixture-writer-run'), null)
    // A rejected queue entry must neither disappear as success nor poison
    // the next valid durable operation.
    await production.syncGrillWorkflow(context.state)
    assert.equal((await context.authority.get(context.state.sessionId)).authoritativeRevision, 1)
  })
  const safe = production.grillLaunchErrorMessage(new Error('PRIVATE_KEY=/private/user/file.json'))
  assert.equal(safe, '梳理暂未启动，当前进度已保留，请稍后重试。')
  assert.ok(!safe.includes('PRIVATE_KEY') && !safe.includes('/private/'))
})

test('same operation ID still rejects recall payload drift and stale Grill reads never rewind the stage', async () => {
  await fixture(async context => {
    await production.syncGrillWorkflow(context.state)
    const initial = await context.authority.get(context.state.sessionId)
    await assert.rejects(
      production.syncGrillWorkflow(context.state, 'requirements', 'waiting_user', { included: [], omitted: [], audit: [] }),
      error => error.code === 'longform_operation_conflict'
    )
    assert.equal(production.longformWorkflowHash(await context.authority.get(context.state.sessionId)), production.longformWorkflowHash(initial))
    await production.syncGrillWorkflow(context.state, 'outline', 'running')
    const outline = await context.authority.get(context.state.sessionId)
    assert.equal(outline.stage, 'outline')
    await context.reopen()
    await production.syncGrillWorkflow(context.state)
    assert.equal(production.longformWorkflowHash(await context.authority.get(context.state.sessionId)), production.longformWorkflowHash(outline))
    const operationId = Object.keys(initial.appliedOperations)[0]
    // Submit the original complete canonical mutation, not merely an ID:
    // authority replay is idempotent even after the workflow advances.
    await context.authority.mutate({
      workflowId: context.state.sessionId, operationId, expectedRevision: 0,
      action: 'answer_requirements', targetStage: 'requirements', targetStatus: 'waiting_user',
      payload: { stateId: context.state.stateId, grillStatus: context.state.status, outlineRevision: context.state.outlineRevision, outlineHash: context.state.outlineHash }
    })
    assert.equal(production.longformWorkflowHash(await context.authority.get(context.state.sessionId)), production.longformWorkflowHash(outline))
  })
})

test('concurrent provider results and renderer polls serialize complete durable read/mutate transactions', async () => {
  await fixture(async context => {
    const original = context.state
    const firstAnswer = production.answerGrillMe(original, original.currentQuestion.id, '', 'decide')
    const secondAnswer = production.answerGrillMe(firstAnswer, firstAnswer.currentQuestion.id, '', 'decide')
    await Promise.all([
      production.syncGrillWorkflow(original),
      production.syncGrillWorkflow(firstAnswer),
      production.syncGrillWorkflow(secondAnswer),
      production.syncGrillWorkflow(original),
      production.syncGrillWorkflow(secondAnswer)
    ])
    const final = await context.authority.get(original.sessionId)
    assert.equal(final.authoritativeRevision, 3)
    assert.equal(Object.keys(final.appliedOperations).length, 3)
    context.save(secondAnswer)
    await context.reopen()
    await production.syncGrillWorkflow(context.state)
    assert.equal(production.longformWorkflowHash(await context.authority.get(original.sessionId)), production.longformWorkflowHash(final))
  })
})

test('early engine recall binds the real SQLite scope before projection; late ACK and stale polls cannot rewind it', async () => {
  await fixture(async context => {
    await production.syncGrillWorkflow(context.state)
    await production.syncGrillWorkflow(context.state, 'outline', 'candidate')
    const runId = 'early-confirmed-writer'
    const scope = { schemaVersion: 1, storyId: 'real-ledger-story', projectId: 'real-ledger-project', branchId: 'main' }
    context.repository.createRun({ run_id: runId, session_id: context.state.sessionId, status: 'running', phase: 'writing', started_at: 1, updated_at: 1, config_json: JSON.stringify({ storyScope: scope }), parent_run_id: null, error_code: null, error_message: null })
    const projection = { runId, sessionId: context.state.sessionId, ...scope, sceneId: 'early-scene', validityEpoch: 1, storyRevision: 0,
      workingSetHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64), sourceSnapshotHash: 'c'.repeat(64), sourceCardSetHash: 'd'.repeat(64), queryHash: 'e'.repeat(64), indexHash: 'f'.repeat(64), audit: { included: [], omitted: [], audit: [] } }
    await Promise.all([
      production.projectConfirmedLongformRecall(projection),
      production.bindAndStartLongformWorkflowRun(context.state.sessionId, runId, scope),
      production.syncGrillWorkflow(context.state)
    ])
    const snapshot = await context.authority.get(context.state.sessionId)
    assert.equal(snapshot.stage, 'draft')
    assert.equal(snapshot.activeRunId, runId)
    assert.equal(snapshot.storyId, scope.storyId)
    assert.equal(snapshot.projectId, scope.projectId)
    assert.ok(context.repository.getLongformWorkflowSnapshot(runId, context.state.sessionId))
    await context.reopen()
    await production.bindAndStartLongformWorkflowRun(context.state.sessionId, runId, scope)
    assert.equal(production.longformWorkflowHash(await context.authority.get(context.state.sessionId)), production.longformWorkflowHash(snapshot))
  })
})
