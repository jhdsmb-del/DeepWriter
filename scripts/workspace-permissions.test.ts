import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createPermissionManager, type PermissionIdentity } from '../src/main/permissions'
import { createPermissionRequestController } from '../src/main/permissionRequests'
import { buildExecutionSnapshot } from '../src/main/executionSnapshot'
import { chatStartSchema, runsResumeSchema } from '../src/shared/ipcSchemas'
import { executeTool } from '../src/main/tools'
import { agentTools, setPermissionManager } from '../src/main/agentTools'
import { createCheckpointStore, setCheckpointStore } from '../src/main/checkpoint'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-permission-policy-'))
const workspace = path.join(root, 'workspace')
await fs.mkdir(workspace)
after(async () => { setPermissionManager(null); setCheckpointStore(null); await fs.rm(root, { recursive: true, force: true }) })
const owner: PermissionIdentity = { webContentsId: 1, sessionId: 'session-a', runId: 'run-a', workspaceRoot: workspace, permissionMode: 'auto', operation: 'read' }

test('新装默认auto，但只有明确工作区内低风险操作免确认', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'default'), async () => { asks++; return { action: 'deny', remember: false } })
  assert.equal(pm.getSettings().mode, 'auto')
  for (const operation of ['read', 'create', 'edit'] as const) assert.equal((await pm.decide('path', path.join(workspace, '报告.md'), { ...owner, operation })).action, 'allow')
  for (const input of [
    { target: path.join(root, '外部.md'), identity: owner },
    { target: path.join(workspace, '报告.md'), identity: { ...owner, operation: 'overwrite' as const } },
    { target: path.join(workspace, '.env'), identity: owner },
    { target: path.join(workspace, 'credentials.txt'), identity: owner },
    { target: path.join(workspace, 'setup.ps1'), identity: { ...owner, operation: 'create' as const } },
    { target: path.join(workspace, '报告.md'), identity: { ...owner, workspaceRoot: undefined } }
  ]) assert.equal((await pm.decide('path', input.target, input.identity)).action, 'deny')
  assert.equal((await pm.decide('command', 'echo harmless', owner)).action, 'deny')
  assert.equal(asks, 7)
})

test('严格档、旧冻结运行与显式deny不被新默认放大', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'strict'), async () => { asks++; return { action: 'deny', remember: false } })
  assert.equal((await pm.decide('path', path.join(workspace, '报告.md'), { ...owner, permissionMode: 'safe' })).action, 'deny')
  assert.equal((await pm.decide('path', path.join(workspace, '报告.md'), { ...owner, permissionMode: undefined })).action, 'deny')
  await pm.updateSettings({ mode: 'auto', rules: [{ id: 'denied', type: 'path', pattern: workspace, action: 'deny', persistent: true }] })
  assert.equal((await pm.decide('path', path.join(workspace, '报告.md'), owner)).action, 'deny')
  assert.equal(asks, 2)
  const old = createPermissionManager(path.join(root, 'strict'), undefined)
  assert.equal(old.getSettings().rules[0].action, 'deny')
})

test('本任务同类授权隔离窗口、会话、任务、工作区与操作类型', async () => {
  const views: Array<{ canAllowForRun: boolean }> = []
  const pm = createPermissionManager(path.join(root, 'scope'), async (_type, _target, _identity, view) => { views.push(view!); return { action: 'allow', remember: false, scope: 'run' } }, 'safe')
  const identity = { ...owner, permissionMode: 'safe' as const }
  const file = path.join(workspace, '一.md')
  await pm.decide('path', file, identity)
  await pm.decide('path', path.join(workspace, '二.md'), identity)
  assert.equal(views.length, 1)
  for (const patch of [{ webContentsId: 2 }, { sessionId: 'session-b' }, { runId: 'run-b' }, { workspaceRoot: root }, { operation: 'create' as const }]) await pm.decide('path', file, { ...identity, ...patch })
  assert.equal(views.length, 6)
  await pm.decide('path', file, { ...identity, operation: 'overwrite' })
  assert.equal(views.at(-1)?.canAllowForRun, false)
  pm.revokeLeasesByRunId('run-a')
  await pm.decide('path', file, identity)
  assert.equal(views.length, 8)
})

test('实际文件工具：默认新建与带快照局改免确认，覆盖/外部/严控拒绝不落盘', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'live'), async () => { asks++; return { action: 'deny', remember: false } })
  setPermissionManager(pm)
  setCheckpointStore(createCheckpointStore(path.join(root, 'checkpoints')))
  const env = { workDir: workspace, docDir: workspace, sessionId: 'author', runId: 'live', permissionMode: 'auto' as const, permissionWorkspaceRoot: workspace }
  const write = agentTools.find(tool => tool.name === 'write_file')!
  const edit = agentTools.find(tool => tool.name === 'edit_file')!
  const file = path.join(workspace, '正文.md')
  assert.equal((await write.execute({ path: file, content: '原稿一行，还有其余段落保持不变。' }, workspace, env)).ok, true)
  const result = await edit.execute({ path: file, old_text: '原稿', new_text: '新稿' }, workspace, env)
  assert.equal(result.ok, true); assert.ok(result.backupId)
  assert.equal(await fs.readFile(file, 'utf8'), '新稿一行，还有其余段落保持不变。')
  assert.equal((await write.execute({ path: file, content: '不能覆盖' }, workspace, env)).ok, false)
  assert.equal((await edit.execute({ path: file, old_text: '新稿', new_text: '严控' }, workspace, { ...env, permissionMode: 'safe' })).ok, false)
  assert.equal(await fs.readFile(file, 'utf8'), '新稿一行，还有其余段落保持不变。')
  assert.equal((await write.execute({ path: path.join(root, 'outside.md'), content: '外部' }, workspace, env)).ok, false)
  assert.equal(asks, 3)
  assert.equal((await edit.execute({ path: file, old_text: '新稿一行，还有其余段落保持不变。', new_text: '全部', replace_all: true }, workspace, env)).ok, false)
  await fs.writeFile(path.join(workspace, 'credentials.txt'), 'sensitive-needle')
  const search = agentTools.find(tool => tool.name === 'search_files')!
  const resultSearch = await search.execute({ path: workspace, pattern: 'sensitive-needle' }, workspace, env)
  assert.ok(!resultSearch.message.includes('credentials.txt:1:'))
  assert.ok(resultSearch.message.includes('未获读取授权'))
})

test('两处短人名替换有快照时自动完成；严格档、无快照与外部目录仍确认', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'rename'), async () => { asks++; return { action: 'deny', remember: false } })
  setPermissionManager(pm)
  setCheckpointStore(createCheckpointStore(path.join(root, 'rename-checkpoints')))
  const env = { workDir: workspace, docDir: workspace, sessionId: 'rename', runId: 'rename-run', permissionMode: 'auto' as const, permissionWorkspaceRoot: workspace }
  const edit = agentTools.find(tool => tool.name === 'edit_file')!
  const file = path.join(workspace, '河岸.md'), original = '小曲过桥。\r\n水向东流。\r\n小曲回头。'
  const args = { path: file, old_text: '小曲', new_text: '小禾$&', replace_all: true }
  await fs.writeFile(file, original)
  const changed = await edit.execute(args, workspace, env)
  assert.equal(changed.ok, true); assert.deepEqual(changed.edit, { count: 2, lines: [1, 3] }); assert.ok(changed.backupId)
  assert.equal(await fs.readFile(file, 'utf8'), original.replaceAll('小曲', () => '小禾$&'))
  assert.equal(asks, 0)
  await fs.writeFile(file, original)
  assert.equal((await edit.execute(args, workspace, { ...env, permissionMode: 'safe' })).ok, false)
  setCheckpointStore(null)
  assert.equal((await edit.execute(args, workspace, env)).ok, false)
  setCheckpointStore(createCheckpointStore(path.join(root, 'rename-checkpoints')))
  const outside = path.join(root, '外部改名.md')
  await fs.writeFile(outside, original)
  assert.equal((await edit.execute({ ...args, path: outside }, workspace, env)).ok, false)
  assert.equal(await fs.readFile(outside, 'utf8'), original)
  assert.equal(await fs.readFile(file, 'utf8'), original)
  assert.equal(asks, 3)
})

test('短匹配累计大比例替换、巨量替换或插入及整篇重写仍需确认', async () => {
  const operations: string[] = []
  const pm = createPermissionManager(path.join(root, 'impact'), async (_type, _target, _identity, view) => { operations.push(view!.operation); return { action: 'deny', remember: false } })
  setPermissionManager(pm)
  setCheckpointStore(createCheckpointStore(path.join(root, 'impact-checkpoints')))
  const env = { workDir: workspace, docDir: workspace, sessionId: 'impact', runId: 'impact-run', permissionMode: 'auto' as const, permissionWorkspaceRoot: workspace }
  const edit = agentTools.find(tool => tool.name === 'edit_file')!
  const file = path.join(workspace, '大替换.md')
  for (const candidate of [
    { text: '甲'.repeat(80) + '余'.repeat(20), old_text: '甲', new_text: '乙' },
    { text: '甲'.repeat(4100) + '余'.repeat(20000), old_text: '甲', new_text: '乙' },
    { text: '甲' + '余'.repeat(100), old_text: '甲', new_text: '新增'.repeat(50) },
    { text: '原稿全文与尾声', old_text: '原稿全文与尾声', new_text: '全部重写' }
  ]) {
    await fs.writeFile(file, candidate.text)
    const result = await edit.execute({ path: file, old_text: candidate.old_text, new_text: candidate.new_text, replace_all: true }, workspace, env)
    assert.equal(result.ok, false)
    assert.equal(await fs.readFile(file, 'utf8'), candidate.text)
  }
  assert.equal(operations.length, 4)
  assert.ok(operations.every(operation => operation === '覆盖已有文件'))
})

test('后台读取不能弹窗扩权；请求答复验证owner、可兑现范围与取消', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'background'), async () => { asks++; return { action: 'allow', remember: false } })
  assert.equal((await pm.decide('path', path.join(root, 'outside.md'), { ...owner, nonInteractive: true })).action, 'deny')
  assert.equal(asks, 0)
  const controller = createPermissionRequestController(() => {})
  const abort = new AbortController()
  const waiting = controller.request(1, { type: 'command', target: 'echo test', operation: '运行命令', reason: '需要确认', workspaceRoot: null, canAllowForRun: false }, abort.signal)
  const id = controller.list(1)[0].id
  assert.equal(controller.answer(2, id, 'allow_once'), false)
  assert.equal(controller.answer(1, id, 'allow_run'), false)
  abort.abort()
  assert.equal(await waiting, 'deny'); assert.deepEqual(controller.list(1), [])
  assert.equal(controller.answer(1, id, 'allow_once'), false)
  const once = controller.request(1, { type: 'path', target: workspace, operation: '读取', reason: '严格', workspaceRoot: workspace, canAllowForRun: true })
  assert.equal(controller.answer(1, controller.list(1)[0].id, 'allow_once'), true)
  assert.equal(await once, 'allow_once')
})

test('文件结果保留缺少交互授权、人工拒绝与策略禁止的真实原因', async () => {
  const file = path.join(workspace, '拒绝原因.md'), original = '原稿内容与其余段落均应保留。'
  await fs.writeFile(file, original)
  setCheckpointStore(createCheckpointStore(path.join(root, 'reason-checkpoints')))
  const env = { workDir: workspace, docDir: workspace, sessionId: 'reason', runId: 'reason-run', permissionMode: 'safe' as const, permissionWorkspaceRoot: workspace }
  for (const scenario of ['noninteractive', 'human', 'policy']) {
    let asks = 0
    const pm = createPermissionManager(path.join(root, 'reason-' + scenario), async () => {
      asks++
      return { action: 'deny', remember: false, ...(scenario === 'noninteractive' ? { reason: '当前为非交互执行，需要交互授权；本次操作未获批准' } : {}) }
    })
    if (scenario === 'policy') await pm.updateSettings({ mode: 'safe', rules: [{ id: 'deny-reason', type: 'path', pattern: workspace, action: 'deny', persistent: true }] })
    setPermissionManager(pm)
    for (const [name, args] of [
      ['read_file', { path: file }], ['write_file', { path: file, content: '不应覆盖' }],
      ['edit_file', { path: file, old_text: '原稿', new_text: '不应修改' }], ['find_files', { path: workspace, pattern: '*.md' }]
    ] as const) {
      const result = await agentTools.find(tool => tool.name === name)!.execute(args, workspace, env)
      assert.equal(result.ok, false)
      assert.match(result.message, scenario === 'noninteractive' ? /需要交互授权.*未获批准/ : scenario === 'human' ? /用户已拒绝/ : /权限策略规则禁止/)
      if (scenario !== 'human') assert.doesNotMatch(result.message, /用户.*拒绝/)
    }
    assert.equal(asks, scenario === 'policy' ? 0 : 4)
    assert.equal(await fs.readFile(file, 'utf8'), original)
  }
})


test('Windows 短路径 deny 与真实文件身份一致，不转成人工允许或扩大 allow 规则', { skip: process.platform !== 'win32' }, async t => {
  const canonical = await fs.realpath(workspace)
  const short = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${canonical}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim()
  if (short.toLowerCase() === canonical.toLowerCase()) { t.skip('此卷未启用 8.3 短路径'); return }
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'short-path-reason'), async () => { asks++; return { action: 'allow', remember: false } })
  await pm.updateSettings({ mode: 'auto', rules: [{ id: 'short-deny', type: 'path', pattern: short, action: 'deny', persistent: true }] })
  setPermissionManager(pm)
  const file = path.join(canonical, 'short-reason.md'), original = 'original content'
  await fs.writeFile(file, original)
  const env = { workDir: canonical, docDir: canonical, sessionId: 'short-reason', runId: 'short-reason', permissionMode: 'auto' as const, permissionWorkspaceRoot: canonical }
  for (const [name, args] of [
    ['read_file', { path: file }], ['write_file', { path: file, content: 'must not overwrite' }],
    ['edit_file', { path: file, old_text: 'original', new_text: 'changed' }], ['find_files', { path: canonical, pattern: '*.md' }],
    ['write_file', { path: path.join(canonical, 'not-created', 'new.md'), content: 'must not create' }]
  ] as const) {
    const result = await agentTools.find(tool => tool.name === name)!.execute(args, canonical, env)
    assert.equal(result.ok, false, name)
    assert.match(result.message, /权限策略规则禁止/, name)
  }
  assert.equal(asks, 0, 'deny must not fall through to either auto or a permissive confirmation')
  assert.equal(await fs.readFile(file, 'utf8'), original)
  await assert.rejects(fs.stat(path.join(canonical, 'not-created')), { code: 'ENOENT' })
  const sibling = canonical + '-sibling'
  assert.equal((await pm.decide('path', path.join(sibling, 'file.md'), { ...owner, permissionMode: 'safe' })).action, 'allow')
  assert.equal(asks, 1, 'canonical containment must not deny a prefix-sharing sibling')
  await pm.updateSettings({ mode: 'safe', rules: [{ id: 'short-allow', type: 'path', pattern: short, action: 'allow', persistent: true }] })
  assert.equal((await pm.decide('path', file, { ...owner, permissionMode: 'safe' })).ruleId, undefined)
  assert.equal(asks, 2, 'physical alias matching must not expand a remembered allow rule')
})


test('自主任务授权只适用于明确项目和运行身份，不写入全局模式或规则', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'goal-scope'), async () => { asks++; return { action: 'allow', remember: true } }, 'safe')
  const autonomous: PermissionIdentity = { ...owner, goalMode: 'autonomous', commandCwd: workspace, permissionMode: 'safe' }
  const target = path.join(workspace, 'program.ts')
  assert.equal((await pm.decide('path', target, autonomous)).action, 'deny', 'frozen goalMode alone is not a grant')
  await pm.issueAutonomousTaskGrant({ webContentsId: 1, sessionId: 'session-a', runId: 'run-a', workspaceRoot: workspace })
  for (const operation of ['read', 'create', 'edit', 'overwrite'] as const) assert.equal((await pm.decide('path', target, { ...autonomous, operation })).action, 'allow')
  assert.equal((await pm.decide('command', 'echo project-command', autonomous)).action, 'allow')
  for (const patch of [{ webContentsId: 2 }, { sessionId: 'session-b' }, { runId: 'run-b' }, { workspaceRoot: root }, { workspaceRoot: undefined }]) {
    assert.equal((await pm.decide('path', target, { ...autonomous, ...patch })).action, 'deny', JSON.stringify(patch))
  }
  assert.equal(asks, 0)
  assert.deepEqual(pm.getSettings(), { mode: 'safe', rules: [] })
  assert.deepEqual(pm.listLeases(), [], 'not an off/full lease')
  await assert.rejects(fs.stat(path.join(root, 'goal-scope', 'permissions.json')), { code: 'ENOENT' })
  pm.revokeAutonomousTaskGrant('run-a')
  assert.equal((await pm.decide('path', target, autonomous)).action, 'deny')
  const restarted = createPermissionManager(path.join(root, 'goal-scope'), async () => { throw new Error('must not ask') })
  assert.equal((await restarted.decide('path', target, autonomous)).action, 'deny', 'a new manager/resume never reconstructs grants')
})

test('自主模式项目外、敏感、deny、ask和非法命令立即拒绝，不被允许规则或全开覆盖', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'goal-deny'), async () => { asks++; throw new Error('autonomous must never ask') })
  const autonomous: PermissionIdentity = { ...owner, goalMode: 'autonomous', commandCwd: workspace }
  await pm.issueAutonomousTaskGrant({ webContentsId: 1, sessionId: 'session-a', runId: 'run-a', workspaceRoot: workspace })
  pm.issueLease({ webContentsId: 1, sessionId: 'session-a', runId: 'run-a', scopes: 'full', ttlMs: 60_000 })
  await pm.updateSettings({ mode: 'auto', rules: [
    { id: 'broad-allow', type: 'path', pattern: root, action: 'allow', persistent: true },
    { id: 'deny-private', type: 'path', pattern: path.join(workspace, 'private'), action: 'deny', persistent: true },
    { id: 'deny-command', type: 'command', pattern: 'echo forbidden', action: 'deny', literal: true, persistent: true },
    { id: 'ask-command', type: 'command', pattern: 'echo ask', action: 'ask', literal: true, persistent: true }
  ] })
  for (const target of [path.join(root, 'outside.md'), path.join(workspace, 'private', 'file.md'), path.join(workspace, '.env'), path.join(workspace, 'credentials.txt')]) {
    assert.equal((await pm.decide('path', target, autonomous)).action, 'deny', target)
  }
  for (const command of ['echo forbidden', 'echo ask', 'echo first && echo second', 'echo bad\nline']) assert.equal((await pm.decide('command', command, autonomous)).action, 'deny', command)
  assert.equal((await pm.decide('command', 'echo safe', { ...autonomous, commandCwd: root })).action, 'deny')
  assert.equal((await pm.decide('command', 'echo safe', { ...autonomous, commandCwd: undefined })).action, 'deny')
  const aborted = new AbortController(); aborted.abort()
  assert.equal((await pm.decide('path', path.join(workspace, 'report.md'), { ...autonomous, signal: aborted.signal })).action, 'deny')
  assert.equal(asks, 0)
  await assert.rejects(pm.issueAutonomousTaskGrant({ webContentsId: 1, sessionId: 'session-a', runId: 'disk', workspaceRoot: path.parse(workspace).root }), /整个磁盘/)
})

test('自主真实工具可写程序、覆盖并保留快照、运行命令，撤销后无写入或交互', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'goal-live'), async () => { asks++; throw new Error('must not ask') }, 'safe')
  setPermissionManager(pm)
  setCheckpointStore(createCheckpointStore(path.join(root, 'goal-live-checkpoints')))
  const env = { workDir: workspace, docDir: root, webContentsId: 3, sessionId: 'goal-live', runId: 'goal-live', goalMode: 'autonomous' as const, permissionMode: 'safe' as const, permissionWorkspaceRoot: workspace }
  await pm.issueAutonomousTaskGrant({ webContentsId: 3, sessionId: env.sessionId, runId: env.runId, workspaceRoot: workspace })
  const write = agentTools.find(tool => tool.name === 'write_file')!, command = agentTools.find(tool => tool.name === 'run_command')!
  const file = path.join(workspace, 'goal-live.ts')
  assert.equal((await write.execute({ path: file, content: 'first' }, root, env)).ok, true)
  const overwritten = await write.execute({ path: file, content: 'second' }, root, env)
  assert.equal(overwritten.ok, true); assert.ok(overwritten.backupId)
  assert.equal((await command.execute({ command: 'echo project-fixture' }, root, env)).ok, true)
  assert.equal((await command.execute({ command: 'where node' }, root, env)).ok, false, 'disabled system commands stay disabled')
  const outside = path.join(root, 'goal-outside.ts')
  assert.equal((await write.execute({ path: outside, content: 'outside' }, root, env)).ok, false)
  await assert.rejects(fs.stat(outside), { code: 'ENOENT' })
  pm.revokeLeasesByRunId(env.runId)
  assert.equal((await write.execute({ path: file, content: 'revoked' }, root, env)).ok, false)
  assert.equal((await command.execute({ command: 'echo revoked' }, root, env)).ok, false)
  assert.equal(await fs.readFile(file, 'utf8'), 'second')
  setPermissionManager(null)
  assert.equal((await write.execute({ path: file, content: 'missing manager' }, root, env)).ok, false)
  assert.equal((await command.execute({ command: 'echo missing-manager' }, root, env)).ok, false)
  assert.equal(asks, 0)
})

test('撤销窗口、会话和pending签发均使自主任务失效；普通和引导仍逐项确认', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'goal-revocation'), async () => { asks++; return { action: 'deny', remember: false } }, 'safe')
  const autonomous: PermissionIdentity = { ...owner, goalMode: 'autonomous', commandCwd: workspace, permissionMode: 'safe' }
  const issue = () => pm.issueAutonomousTaskGrant({ webContentsId: 1, sessionId: 'session-a', runId: 'run-a', workspaceRoot: workspace })
  for (const revoke of [() => pm.revokeLeasesByWebContentsId(1), () => pm.revokeLeasesBySessionId('session-a')]) {
    await issue(); revoke()
    assert.equal((await pm.decide('path', path.join(workspace, 'file.md'), autonomous)).action, 'deny')
  }
  const pending = issue(); pm.revokeLeasesByRunId('run-a')
  await assert.rejects(pending, /已撤销/)
  await issue()
  for (const goalMode of [undefined, 'guided'] as const) assert.equal((await pm.decide('command', 'echo still-needs-consent', { ...owner, permissionMode: 'safe', goalMode })).action, 'deny')
  assert.equal(asks, 2)
})


test('自主文档导出未填路径使用项目目录，不等待保存对话框；junction不能逃出项目', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'goal-export'), async () => { asks++; throw new Error('must not ask') })
  setPermissionManager(pm)
  const env = { workDir: workspace, docDir: root, webContentsId: 4, sessionId: 'goal-export', runId: 'goal-export', goalMode: 'autonomous' as const, permissionWorkspaceRoot: workspace }
  await pm.issueAutonomousTaskGrant({ webContentsId: 4, sessionId: env.sessionId, runId: env.runId, workspaceRoot: workspace })
  const result = await executeTool('generate_markdown_doc', { title: '目标导出', filename: 'goal-export.md', content: '真实项目导出内容' }, root, env)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.path, path.join(workspace, 'goal-export.md'))
  const outsideDir = path.join(root, 'outside-goal-project'); await fs.mkdir(outsideDir)
  const junction = path.join(workspace, 'goal-escape')
  await fs.symlink(outsideDir, junction, process.platform === 'win32' ? 'junction' : 'dir')
  const denied = await agentTools.find(tool => tool.name === 'write_file')!.execute({ path: path.join(junction, 'must-not-write.md'), content: 'escaped' }, root, env)
  assert.equal(denied.ok, false, denied.message)
  await assert.rejects(fs.stat(path.join(outsideDir, 'must-not-write.md')), { code: 'ENOENT' })
  assert.equal(asks, 0)
})

test('chat:start目标模式必须显式提交、冻结且仅普通执行；恢复重授只有true可用', () => {
  const settings = { model: 'test-model', baseUrl: 'https://api.deepseek.com', maxTokens: 4096, temperature: .7, topP: 1, thinkingEnabled: false, reasoningEffort: 'default' as const, workDir: workspace, docDir: root, permissionMode: 'safe' as const, permissionWorkspaceRoot: workspace, novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 8000 }
  const snapshot = (goalMode?: 'guided' | 'autonomous') => buildExecutionSnapshot({ payload: { id: 'goal-contract', mode: 'agent', phase: 'execute', text: '构建项目', ...(goalMode ? { goalMode } : {}) }, settings, sessionId: 'contract', memory: { projectPath: '', projectContent: '', userContent: '' }, now: 1 })
  assert.equal(snapshot().goalMode, undefined)
  for (const goalMode of ['guided', 'autonomous'] as const) {
    assert.equal(chatStartSchema.parse({ id: 'r', mode: 'agent', goalMode }).goalMode, goalMode)
    const frozen = snapshot(goalMode)
    assert.equal(frozen.goalMode, goalMode); assert.equal(frozen.permissionMode, 'safe'); assert.equal(frozen.permissionWorkspaceRoot, workspace)
  }
  for (const payload of [
    { id: 'r', mode: 'style', goalMode: 'autonomous' },
    { id: 'r', mode: 'longwrite', goalMode: 'autonomous' },
    { id: 'r', mode: 'galgame', goalMode: 'autonomous' },
    { id: 'r', mode: 'agent', longMode: true, goalMode: 'autonomous' },
    { id: 'r', mode: 'agent', phase: 'plan', goalMode: 'autonomous' },
    { id: 'r', goalMode: 'off' }
  ]) assert.equal(chatStartSchema.safeParse(payload).success, false, JSON.stringify(payload))
  assert.equal(runsResumeSchema.safeParse({ runId: 'r', reauthorizeGoal: true }).success, true)
  assert.equal(runsResumeSchema.safeParse({ runId: 'r', reauthorizeGoal: false }).success, false)
  assert.equal(runsResumeSchema.safeParse({ runId: 'r', reauthorizeGoal: 'true' }).success, false)
  assert.throws(() => buildExecutionSnapshot({ payload: { id: 'plan', mode: 'agent', phase: 'plan', goalMode: 'autonomous' }, settings, sessionId: 'contract', memory: { projectPath: '', projectContent: '', userContent: '' } }), /普通 Agent 执行/)
})


test('自主命令不是cwd沙箱：解释器、网络和git默认拒绝，项目读取逐项保留路径与敏感限制', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'goal-command-boundary'), async () => { asks++; throw new Error('must not ask') })
  setPermissionManager(pm)
  const env = { workDir: workspace, docDir: root, webContentsId: 5, sessionId: 'goal-command', runId: 'goal-command', goalMode: 'autonomous' as const, permissionWorkspaceRoot: workspace }
  await pm.issueAutonomousTaskGrant({ webContentsId: 5, sessionId: env.sessionId, runId: env.runId, workspaceRoot: workspace })
  const command = agentTools.find(tool => tool.name === 'run_command')!
  const file = path.join(workspace, 'goal-command-readable.txt'); await fs.writeFile(file, 'ordinary-project-needle')
  const outside = path.join(root, 'goal-command-outside.txt'); await fs.writeFile(outside, 'outside-private-needle')
  const sensitive = path.join(workspace, '.env'); await fs.writeFile(sensitive, 'sensitive-project-needle')
  const marker = path.join(root, 'must-not-run-interpreter.txt')
  const script = path.join(workspace, 'goal-command-interpreter.cjs')
  await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'UNSAFE')`)
  for (const cmd of [
    `node "${script}"`, `"${process.execPath}" "${script}"`,
    'python -c "print(123)"', 'powershell -Command "Write-Output 123"',
    'cmd /c echo harmless', 'curl https://example.invalid', 'git status',
    'git diff --ext-diff', `type "${outside}"`, 'type .env',
    `findstr needle "${outside}"`, 'findstr /s needle .', 'findstr needle .',
    'dir /s', 'ls --recursive', 'pwd ignored-argument'
  ]) {
    const result = await command.execute({ command: cmd }, root, env)
    assert.equal(result.ok, false, cmd)
    assert.match(result.message, /未执行|拒绝|只接受/)
    assert.doesNotMatch(result.message, /outside-private-needle|sensitive-project-needle/)
  }
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
  assert.match((await command.execute({ command: `type "${file}"` }, root, env)).message, /ordinary-project-needle/)
  const searched = await command.execute({ command: `findstr /i needle "${file}"` }, root, env)
  assert.equal(searched.ok, true); assert.match(searched.message, /ordinary-project-needle/)
  const listed = await command.execute({ command: 'dir /b' }, root, env)
  assert.equal(listed.ok, true); assert.match(listed.message, /goal-command-readable.txt/)
  assert.equal((await command.execute({ command: 'echo "literal && not-a-shell"' }, root, env)).ok, true)
  const blockedDirectory = path.join(workspace, '.goal-private'); await fs.mkdir(blockedDirectory)
  await fs.writeFile(path.join(blockedDirectory, 'secret.txt'), 'secret-through-alias')
  const alias = path.join(workspace, 'goal-command-alias')
  await fs.symlink(blockedDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const aliasRead = await command.execute({ command: `type "${path.join(alias, 'secret.txt')}"` }, root, env)
  assert.equal(aliasRead.ok, false); assert.doesNotMatch(aliasRead.message, /secret-through-alias/)
  await pm.updateSettings({ mode: 'auto', rules: [{ id: 'command-file-denied', type: 'path', pattern: file, action: 'deny', persistent: true }] })
  assert.equal((await command.execute({ command: `type "${file}"` }, root, env)).ok, false)
  assert.equal((await command.execute({ command: `findstr needle "${file}"` }, root, env)).ok, false)
  assert.equal(asks, 0)
})

test('复杂自主命令仅消费准确argv允许规则，追加参数、前缀、拒绝和一次授权耗尽均不能继承', async () => {
  let asks = 0
  const pm = createPermissionManager(path.join(root, 'goal-command-exact'), async () => { asks++; throw new Error('must not ask') })
  setPermissionManager(pm)
  const env = { workDir: workspace, docDir: workspace, webContentsId: 6, sessionId: 'goal-exact', runId: 'goal-exact', goalMode: 'autonomous' as const, permissionWorkspaceRoot: workspace }
  await pm.issueAutonomousTaskGrant({ webContentsId: 6, sessionId: env.sessionId, runId: env.runId, workspaceRoot: workspace })
  const script = path.join(workspace, 'goal-exact-script.cjs')
  const marker = path.join(workspace, 'goal-exact-authorized.txt')
  await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'explicit-command-allow')`)
  const exact = `node "${script}"`
  const allow = { id: 'explicit-exact-command', type: 'command' as const, pattern: exact, action: 'allow' as const, literal: true, persistent: false }
  await pm.updateSettings({ mode: 'auto', rules: [allow] })
  const command = agentTools.find(tool => tool.name === 'run_command')!
  for (const cmd of [`${exact} extra`, `${exact} --eval harmless`, `node "${script}.other"`]) assert.equal((await command.execute({ command: cmd }, workspace, env)).ok, false, cmd)
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
  const permitted = await command.execute({ command: exact }, workspace, env)
  assert.equal(permitted.ok, true, permitted.message)
  assert.equal(await fs.readFile(marker, 'utf8'), 'explicit-command-allow')
  assert.equal(pm.getSettings().rules.length, 0, 'one-use command approval is consumed')
  assert.equal((await command.execute({ command: exact }, workspace, env)).ok, false)
  await pm.updateSettings({ mode: 'auto', rules: [
    { ...allow, persistent: true },
    { id: 'explicit-deny-wins', type: 'command', pattern: exact, action: 'deny', literal: true, persistent: true }
  ] })
  assert.equal((await command.execute({ command: exact }, workspace, env)).ok, false, 'deny wins even when an exact allow precedes it')
  assert.equal(asks, 0)
})
