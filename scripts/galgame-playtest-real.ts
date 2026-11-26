// Opt-in local SDK verification. Never discovers or touches existing projects.
// esbuild scripts/galgame-playtest-real.ts --bundle --platform=node --format=esm --packages=external --outfile=out/galgame-playtest-real.mjs
// node out/galgame-playtest-real.mjs <sdk-root> [<sdk-root>...]
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { GalgameStudioPlaytestService, renpyPlaytestCommand } from '../src/main/galgameStudioPlaytest'
import { resolveRenpySdkLayout, validateRenpySdkLayout, runRenpyLint } from '../src/main/renpySdk'
import { createGalgameStudioState } from '../src/shared/galgameStudio'
import { activeChildProcesses, spawnTracked } from '../src/main/childRegistry'

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const roots = process.argv.slice(2)
assert.ok(roots.length, 'Pass at least one explicit local SDK root')
const evidenceDir = path.resolve('out', `galgame-playtest-real-${Date.now()}`)
await fs.mkdir(evidenceDir, { recursive: true })
const reports: unknown[] = []
for (const sdkRoot of roots) {
  const layout = await resolveRenpySdkLayout(sdkRoot)
  const candidate = await validateRenpySdkLayout(layout, { source: 'explicit' })
  const projectPath = path.join(evidenceDir, `RenPy ${candidate.version} 中文隔离试玩`)
  await fs.mkdir(path.join(projectPath, 'game'), { recursive: true })
  const projectDir = await fs.realpath(projectPath)
  const marker = path.join(projectDir, 'played.txt')
  // Python unicode escapes keep this same fixture valid on Python 2 and 3.
  const pyString = (value: string): string => 'u"' + [...value].map(char => char.charCodeAt(0) > 127 ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char === '\\' ? '\\\\' : char === '"' ? '\\"' : char).join('') + '"'
  await fs.writeFile(path.join(projectDir, 'game', 'script.rpy'), [
    `define config.name = "DeepWriter isolated ${candidate.version}"`,
    `define config.window_title = "DeepWriter PLAYTEST ${candidate.version}"`,
    'define config.save_directory = None',
    'define config.autosave_on_quit = False',
    'define config.screen_width = 640',
    'define config.screen_height = 360',
    'label main_menu:',
    '    jump start',
    'label start:',
    '    scene expression Solid("#182335")',
    `    show text "DeepWriter PLAYTEST ${candidate.version}\\nReal SDK / isolated project" at truecenter`,
    '    $ renpy.pause(0.3, hard=True)',
    `    $ open(${pyString(marker)}, "w").write("real RenPy project running")`,
    '    $ renpy.pause(120, hard=True)',
    '    $ renpy.quit()',
    ''
  ].join('\n'))
  const state = createGalgameStudioState({ studioId: 'studio_real', sessionId: 'session_real', projectId: 'project_real', projectDir, projectMode: 'import', projectName: `隔离 RenPy ${candidate.version}` })
  state.sdkReady = true
  state.sdk = candidate.evidence
  let gamePid: number | undefined
  let confirmationCount = 0
  const lintResults: Array<{ ok: boolean; exitCode: number | null }> = []
  const service = new GalgameStudioPlaytestService({
    getStudio: async () => structuredClone(state),
    isAuthorizedDir: async dir => dir === projectDir,
    confirmExecution: async project => { assert.equal(project.projectDir, projectDir); confirmationCount++; return true },
    lint: async (sdk, project, options) => {
      const result = await runRenpyLint(sdk, project, options)
      lintResults.push({ ok: result.ok, exitCode: result.exitCode })
      await fs.writeFile(path.join(projectDir, `lint-${lintResults.length}.txt`), result.output)
      return result
    },
    spawnProcess: (command, args, options) => { const child = spawnTracked(command, args, options); gamePid = child.pid; return child }
  })
  try {
    assert.equal(await service.confirmProjectExecution(projectDir), true)
    const before = structuredClone(state)
    assert.equal(state.lint, null)
    assert.equal(state.generatedFile, null)
    const start = await service.start('studio_real')
    assert.equal(start.status, 'running', JSON.stringify(start))
    const deadline = Date.now() + 30_000
    while (!(await fs.stat(marker).catch(() => null))) { assert.ok(Date.now() < deadline, `game did not reach actual project execution: ${JSON.stringify(await service.status('studio_real'))}`); await pause(100) }
    assert.equal((await service.status('studio_real')).status, 'running')
    assert.ok(gamePid && activeChildProcesses().some(child => child.pid === gamePid))
    console.log(`RUNNING RenPy ${candidate.version} PID ${gamePid}; marker ${marker}`)
    await pause(Number(process.env.DW_PLAYTEST_OBSERVE_MS ?? 1500))
    const stop = await service.stop('studio_real')
    assert.equal(stop.status, 'stopped', JSON.stringify(stop))
    assert.equal((await service.status('studio_real')).status, 'stopped')
    assert.equal(activeChildProcesses().some(child => child.pid === gamePid), false)
    // A previously passing Studio cannot start a project broken on disk later.
    await fs.writeFile(path.join(projectDir, 'game', 'broken.rpy'), 'label invalid:\n    this is not a valid renpy statement\n')
    const broken = await service.start('studio_real')
    assert.equal(broken.status, 'failed', JSON.stringify(broken))
    assert.equal(confirmationCount, 1)
    assert.deepEqual(state, before, 'imported original playtest must not alter Studio production state')
    const report = { version: candidate.version, command: await renpyPlaytestCommand(layout, projectDir), originalImportedWithoutStudioLint: true, studioStateUnchanged: true, freshLintResults: lintResults, gamePid, projectExecutionMarker: marker, start, stop, broken, confirmationCount }
    reports.push(report)
    console.log(JSON.stringify(report))
  } finally { await service.shutdown() }
}
await fs.writeFile(path.join(evidenceDir, 'report.json'), JSON.stringify(reports, null, 2))
console.log(`PASS real SDK playtest; evidence ${evidenceDir}`)
