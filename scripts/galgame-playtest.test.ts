import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { GalgameStudioPlaytestService, renpyPlaytestCommand, type GalgameStudioPlaytestDeps } from '../src/main/galgameStudioPlaytest'
import { activeChildProcesses, spawnTracked } from '../src/main/childRegistry'
import { createGalgameStudioState, type GalgameStudioState } from '../src/shared/galgameStudio'
import { galgameStudioPlaytestSchema } from '../src/shared/ipcSchemas'
import { apiCapture, invocations } from './fixtures/galgame-playtest-electron'

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(condition: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await condition())) { assert.ok(Date.now() < deadline, 'condition timed out'); await pause(20) }
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function fixture(overrides: Partial<GalgameStudioPlaytestDeps> = {}, program = 'setInterval(() => {}, 1000)'): Promise<{
  service: GalgameStudioPlaytestService; state: GalgameStudioState; calls: { confirm: number; lint: number; spawn: number; children: ChildProcess[] }; root: string; cleanup: () => Promise<void>
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-playtest-'))
  const project = path.join(root, 'project space 中文')
  const sdk = path.join(root, 'sdk')
  await fs.mkdir(path.join(project, 'game'), { recursive: true })
  await fs.mkdir(sdk)
  const layout = { root: sdk, pythonPath: path.join(sdk, 'python.exe'), renpyScriptPath: path.join(sdk, 'renpy.py'), launcherPath: null }
  await fs.writeFile(layout.pythonPath, 'fixture interpreter')
  await fs.writeFile(layout.renpyScriptPath, '# fixture SDK')
  const state = createGalgameStudioState({ studioId: 'studio_fixture', sessionId: 'session_fixture', projectId: 'project_fixture', projectDir: project, projectMode: 'create', projectName: '隔离试玩' })
  state.sdkReady = true
  state.sdk = { source: 'explicit', root: sdk, pythonPath: layout.pythonPath, renpyScriptPath: layout.renpyScriptPath, version: '8.5.2', verifiedAt: Date.now(), command: 'fixture' }
  state.lint = { ok: true, verified: true, output: '', errorCount: 0, warningCount: 0, command: 'fixture', checkedAt: Date.now() }
  state.stage = 'done'
  state.generatedFile = path.join(project, 'game', 'deepwriter_generated.rpy')
  state.generatedAt = Date.now()
  state.production = { status: 'agent_applied', integration: 'connected', message: 'fixture', requestedAt: Date.now(), completedAt: Date.now() }
  const calls = { confirm: 0, lint: 0, spawn: 0, children: [] as ChildProcess[] }
  const service = new GalgameStudioPlaytestService({
    getStudio: async id => id === 'studio_fixture' || id === 'studio_alias' ? structuredClone({ ...state, studioId: id }) : null,
    isAuthorizedDir: async () => true,
    confirmExecution: async () => { calls.confirm++; return true },
    resolveSdk: async () => layout,
    validateSdk: async () => ({ source: 'explicit', version: '8.5.2', versionOutput: 'fixture', layout, evidence: state.sdk! }),
    lint: async () => { calls.lint++; return { ok: true, verified: true, output: '', exitCode: 0, command: 'fixture' } },
    spawnProcess: (_command, _args, opts) => {
      assert.equal(opts?.windowsHide, false, 'game windows must be visible, unlike background lint/probe processes')
      assert.equal(opts?.shell, false)
      calls.spawn++
      const child = spawnTracked(process.execPath, ['-e', program], { ...opts, windowsHide: true })
      calls.children.push(child)
      return child
    },
    startupObservationMs: 70,
    ...overrides
  })
  return { root, state, calls, service, cleanup: async () => { await service.shutdown(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }) } }
}

test('preload invokes only the three id-based allowlisted channels; schema rejects paths/commands', async () => {
  await import('../src/preload/index')
  for (const operation of ['Start', 'Stop', 'Status']) {
    await apiCapture.value![`galgameStudioPlaytest${operation}`]('studio_fixture')
  }
  assert.deepEqual(invocations, ['Start', 'Stop', 'Status'].map(op => ({ channel: `galgameStudio:playtest${op}`, input: { studioId: 'studio_fixture' } })))
  assert.equal(galgameStudioPlaytestSchema.safeParse({ studioId: 'studio_fixture' }).success, true)
  for (const input of [{ studioId: '../escape' }, { studioId: 'studio_fixture', projectDir: 'C:\\other' }, { studioId: 'studio_fixture', command: 'cmd.exe' }, { studioId: '' }]) assert.equal(galgameStudioPlaytestSchema.safeParse(input).success, false)
})

test('Ren’Py 7/8 direct interpreter commands preserve spaces/Chinese and do not use a launcher or shell', async () => {
  const layout = { root: path.resolve('sdk space 中文'), pythonPath: path.resolve('sdk space 中文/lib/py2-windows-x86_64/python.exe'), renpyScriptPath: path.resolve('sdk space 中文/renpy.py'), launcherPath: path.resolve('sdk space 中文/renpy.exe') }
  const project = path.resolve('project space 中文')
  assert.deepEqual(await renpyPlaytestCommand(layout, project), { command: layout.pythonPath, args: ['renpy.py', project, 'run'], cwd: layout.root })
  const f = await fixture()
  try {
    const gui = path.join(path.dirname(f.state.sdk!.pythonPath), 'pythonw.exe')
    await fs.writeFile(gui, 'isolated GUI interpreter')
    const command = await renpyPlaytestCommand({ ...f.state.sdk!, launcherPath: null }, f.state.projectDir)
    assert.equal(command.command, process.platform === 'win32' ? gui : f.state.sdk!.pythonPath)
  } finally { await f.cleanup() }
})

test('requires authorized existing project, selected SDK and verified passing lint before any confirmation/execution', async () => {
  const f = await fixture({ isAuthorizedDir: async () => false })
  try {
    assert.equal((await f.service.start('studio_fixture')).status, 'failed')
    assert.equal(f.calls.confirm + f.calls.lint + f.calls.spawn, 0)
    assert.equal((await f.service.start('missing')).status, 'failed')
  } finally { await f.cleanup() }
  for (const field of ['sdk', 'lint', 'verified'] as const) {
    const g = await fixture()
    try {
      if (field === 'sdk') g.state.sdk = null
      if (field === 'lint') g.state.lint!.ok = false
      if (field === 'verified') g.state.lint!.verified = false
      assert.equal((await g.service.start('studio_fixture')).status, 'failed')
      assert.equal(g.calls.confirm + g.calls.spawn, 0)
    } finally { await g.cleanup() }
  }
})

test('explicit refusal never executes SDK probes, lint, or game code', async () => {
  let validated = 0
  const f = await fixture({ confirmExecution: async () => false, validateSdk: async () => { validated++; throw new Error('must not run') } })
  try {
    assert.equal((await f.service.start('studio_fixture')).status, 'stopped')
    assert.equal(validated + f.calls.lint + f.calls.spawn, 0)
  } finally { await f.cleanup() }
})

test('an existing imported work can play without assets/model/new generation; Studio production state stays unchanged', async () => {
  const f = await fixture()
  try {
    Object.assign(f.state, { projectMode: 'import', stage: 'assets_ready', generatedFile: null, generatedAt: null, production: null, lint: null })
    const before = structuredClone(f.state)
    assert.equal((await f.service.start('studio_fixture')).status, 'running')
    assert.equal(f.calls.confirm, 1)
    assert.equal(f.calls.lint, 1, 'an imported original must still pass fresh real SDK lint')
    assert.deepEqual(f.state, before, 'playing the original must not mark a new story done')
    assert.equal((await f.service.stop('studio_fixture')).status, 'stopped')
  } finally { await f.cleanup() }
  for (const mode of ['create', 'import-integration-required', 'import-unfinished-generation']) {
    const g = await fixture()
    try {
      Object.assign(g.state, { projectMode: mode === 'create' ? 'create' : 'import', stage: 'generate', lint: null })
      if (mode !== 'import-unfinished-generation') g.state.generatedFile = null
      if (mode === 'import-integration-required') g.state.production!.integration = 'required'
      assert.equal((await g.service.start('studio_fixture')).status, 'failed')
      assert.equal(g.calls.confirm + g.calls.lint + g.calls.spawn, 0)
    } finally { await g.cleanup() }
  }
})

test('same real project is idempotent across concurrent starts and Studio aliases; stop is targeted and repeatable', async () => {
  const f = await fixture()
  const unrelated = spawnTracked(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    const results = await Promise.all([f.service.start('studio_fixture'), f.service.start('studio_fixture'), f.service.start('studio_alias')])
    assert.ok(results.every(result => result.status === 'running'))
    assert.equal(f.calls.spawn, 1)
    assert.equal(f.calls.confirm, 1)
    const child = f.calls.children[0]
    assert.ok(child.pid && alive(child.pid))
    assert.ok(activeChildProcesses().includes(child))
    assert.equal((await f.service.status('studio_alias')).status, 'running')
    assert.equal((await f.service.stop('studio_alias')).status, 'stopped')
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.equal((await f.service.status('studio_fixture')).status, 'stopped')
    assert.equal((await f.service.stop('studio_fixture')).status, 'stopped')
    assert.ok(unrelated.pid && alive(unrelated.pid), 'stopping a game must not stop unrelated work')
    assert.equal((await f.service.start('studio_fixture')).status, 'running')
    assert.equal(f.calls.confirm, 1, 'same project trust decision is reused this app session')
    const stopping = f.service.stop('studio_fixture')
    const restarting = f.service.start('studio_alias')
    assert.equal((await stopping).status, 'stopped')
    assert.equal((await restarting).status, 'running', 'a new start waits for an in-flight stop rather than adopting its dying process')
    assert.equal(f.calls.spawn, 3)
  } finally { unrelated.kill(); await f.cleanup() }
})

test('natural clean and abnormal exits update status; new service never restores a persisted running flag', async () => {
  for (const code of [0, 7]) {
    const f = await fixture({}, `setTimeout(() => process.exit(${code}), 400)`)
    try {
      assert.equal((await f.service.start('studio_fixture')).status, 'running')
      await until(async () => (await f.service.status('studio_fixture')).status !== 'running')
      const result = await f.service.status('studio_fixture')
      assert.equal(result.status, code === 0 ? 'stopped' : 'failed')
      if (code) assert.match(result.message!, /7/)
      const restarted = new GalgameStudioPlaytestService({ getStudio: async () => f.state, isAuthorizedDir: async () => true, confirmExecution: async () => true })
      assert.equal((await restarted.status('studio_fixture')).status, 'stopped')
      await restarted.shutdown()
    } finally { await f.cleanup() }
  }
})

test('spawn failure, immediate engine failure and new lint failure are not reported as running', async () => {
  const fixtures = [
    await fixture({ spawnProcess: (_command, _args, opts) => spawnTracked(path.join(os.tmpdir(), 'dw-nonexistent-runner.exe'), [], opts) }),
    await fixture({ startupObservationMs: 800 }, 'process.exit(9)'),
    await fixture({ lint: async () => ({ ok: false, verified: true, output: 'invalid project', exitCode: 1, command: 'fixture' }) }),
    await fixture({ validateSdk: async () => { throw new Error('SDK identity changed') } })
  ]
  for (const f of fixtures) {
    try {
      assert.equal((await f.service.start('studio_fixture')).status, 'failed')
      assert.equal((await f.service.status('studio_fixture')).status, 'failed')
      assert.ok(f.calls.children.every(child => child.exitCode !== null || child.signalCode !== null))
    } finally { await f.cleanup() }
  }
})

test('stop cancels pending confirmation and queued duplicate starts without waiting for the dialog', async () => {
  const confirmation = deferred<boolean>()
  const asked = deferred<void>()
  const f = await fixture({ confirmExecution: () => { asked.resolve(); return confirmation.promise } })
  try {
    const first = f.service.start('studio_fixture')
    await asked.promise
    const second = f.service.start('studio_alias')
    await pause(20)
    assert.equal((await f.service.stop('studio_fixture')).status, 'stopped')
    assert.equal(f.calls.spawn + f.calls.lint, 0)
    confirmation.resolve(true)
    assert.equal((await first).status, 'stopped')
    assert.equal((await second).status, 'stopped')
    assert.equal(f.calls.spawn + f.calls.lint, 0)
  } finally { confirmation.resolve(false); await f.cleanup() }
})

test('cancel during a real preflight command terminates its owned descendant tree', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>
  let preflightPid = 0
  f = await fixture({ lint: async (_layout, projectDir, options) => {
    const childFile = path.join(f.root, 'preflight-child.json')
    const execution = options!.runCommand!(process.execPath, ['-e', `const fs=require('fs'),cp=require('child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childFile)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000)`], projectDir, options!.signal)
    const result = await execution
    return { ok: result.code === 0, output: result.output, exitCode: result.code, verified: true, command: 'isolated Node preflight', cancelled: result.cancelled }
  } })
  try {
    const starting = f.service.start('studio_fixture')
    const childFile = path.join(f.root, 'preflight-child.json')
    await until(async () => Boolean(await fs.stat(childFile).catch(() => null)))
    const pids = JSON.parse(await fs.readFile(childFile, 'utf8')) as { parent: number; child: number }
    preflightPid = pids.parent
    assert.ok(alive(pids.parent) && alive(pids.child))
    assert.equal((await f.service.stop('studio_fixture')).status, 'stopped')
    assert.equal((await starting).status, 'stopped')
    await until(() => !alive(pids.parent) && !alive(pids.child))
    assert.equal(f.calls.spawn, 0)
  } finally { await f.cleanup(); assert.ok(!preflightPid || !alive(preflightPid)) }
})

test('lint and playtest share explicit project trust; shutdown stops the game and rejects future starts', async () => {
  const f = await fixture()
  try {
    assert.equal(await f.service.confirmProjectExecution(f.state.projectDir), true)
    assert.equal((await f.service.start('studio_fixture')).status, 'running')
    assert.equal(f.calls.confirm, 1)
    const pid = f.calls.children[0].pid!
    await f.service.shutdown()
    assert.ok(!alive(pid))
    assert.equal((await f.service.status('studio_fixture')).status, 'stopped')
    assert.equal((await f.service.start('studio_fixture')).status, 'stopped')
    assert.equal(f.calls.spawn, 1)
  } finally { await f.cleanup() }
})
