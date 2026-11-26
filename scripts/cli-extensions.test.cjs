const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { DatabaseSync } = require('node:sqlite')
const { pathToFileURL } = require('node:url')
const { before, after, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let api, dir, bundle, server, baseUrl, requests = [], mode = 'resource', toolPath
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-extensions-'))
  const result = await esbuild.build({
    absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
      export { ExtensionRegistry } from './src/main/extensions/ExtensionRegistry';
      export { StdioToolClient } from './src/main/extensions/StdioToolClient';
      export { ExtensionActivation, freezeExtensions } from './src/main/extensions/ExtensionActivation';
      export { activeChildProcesses } from './src/main/childRegistry';
      export { createModelCallAdapter } from './src/main/runKernelAdapter';
    ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent',
    plugins: [{ name: 'actual-extension-source', setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.path.startsWith('.') && args.path !== 'electron') return { path: args.path, external: true }
        const target = args.path === 'electron' ? path.join(root, 'src/cli/host.ts') : path.resolve(args.resolveDir, args.path)
        const found = ['', '.ts', '.js', '/index.ts'].map((ext) => target + ext).find(existsSync)
        if (!found || !found.startsWith(root + path.sep)) throw new Error('Source outside workspace')
        return { path: found, namespace: 'source' }
      })
      build.onLoad({ filter: /.*/, namespace: 'source' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
    } }]
  })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, loaded, loaded.exports); api = loaded.exports
  bundle = path.join(dir, 'deepwriter.cjs')
  await (await import(pathToFileURL(path.join(root, 'src/cli/build.mjs')).href)).buildCli({ outfile: bundle })
  server = http.createServer((request, response) => {
    let raw = ''; request.on('data', (chunk) => { raw += chunk }); request.on('end', () => {
      try {
        const body = JSON.parse(raw); requests.push(body); response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (mode === 'slow') {
          response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '灯塔候选正文' }, finish_reason: null }] }) + '\n\n')
          const timer = setTimeout(() => response.end('data: [DONE]\n\n'), 20000); response.on('close', () => clearTimeout(timer)); return
        }
        const toolMessage = [...body.messages].reverse().find((item) => item.role === 'tool')
        if (!toolMessage && mode !== 'plain') {
          const spec = body.tools.find((tool) => mode === 'resource' ? tool.function.name === 'read_skill_resource' : tool.function.name.startsWith('dw_'))
          assert.ok(spec, 'real declared extension schema required before requesting it')
          const args = mode === 'resource' ? { id: 'deepwriter/structure-review', path: 'references/checklist.md' } : { path: toolPath }
          response.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'actual-extension', type: 'function', function: { name: spec.function.name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
        } else {
          if (mode === 'resource') assert.match(JSON.parse(toolMessage.content).message, /Unicode code points/)
          if (mode === 'plugin') { const result = JSON.parse(toolMessage.content); assert.equal(result.ok, true); assert.equal(JSON.parse(result.message).chars, 9) }
          if (mode === 'plugin-deny') { const result = JSON.parse(toolMessage.content); assert.equal(result.ok, false); assert.match(result.message, /outside_authorized_roots/) }
          response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '已按真实技能参考与工具结果处理稿件。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n')
        }
        response.end('data: [DONE]\n\n')
      } catch (error) { response.destroy(error) }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); baseUrl = 'http://127.0.0.1:' + server.address().port
})
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); assert.equal(api.activeChildProcesses().length, 0); assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^deepwriter-extensions-/); await fs.rm(dir, { recursive: true, force: true }) })
function launch(args) {
  const child = spawn(process.execPath, [bundle, ...args], { cwd: root, env: { ...process.env, DEEPWRITER_API_KEY: 'synthetic-extension-key' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk }); child.stderr.on('data', (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill(), 15000)
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, events: stdout.split(/\r?\n/).filter((line) => line.startsWith('{')).map(JSON.parse) }) }) })
  return { child, done, stdout: () => stdout }
}
const run = (args) => launch(args).done
const flags = (dataDir) => ['--data-dir', dataDir, '--base-url', baseUrl, '--loopback', '--work-dir', dataDir, '--doc-dir', path.join(dataDir, 'documents'), '--max-tokens', '4096', '--token-budget', '2000000', '--json']
test('两项真实技能安装默认disabled；明确启停/卸载不删除旧冻结资源', async () => {
  const registry = new api.ExtensionRegistry(path.join(dir, 'skills'))
  assert.equal(registry.catalog().filter((item) => item.kind === 'skill').length, 2)
  for (const id of ['deepwriter/structure-review', 'deepwriter/prose-polish']) {
    const item = await registry.install('builtin:' + id, 'skill')
    assert.equal(item.enabled, false); await assert.rejects(registry.freeze(id, 'skill'), /未启用/)
    await registry.setEnabled(id, true)
    const pin = await registry.freeze(id, 'skill')
    assert.match(pin.instructions[0].content, /不得|不要/)
    const resource = item.files.find((file) => file.path.startsWith('references/')).path
    assert.ok((await registry.resource(pin, resource)).length > 50)
    await registry.setEnabled(id, false); await registry.setEnabled(id, false, true)
    assert.ok(!(await registry.list()).some((entry) => entry.id === id))
    await registry.verify(pin.record); assert.ok(await registry.resource(pin, resource))
  }
  assert.equal(api.activeChildProcesses().length, 0)
})
test('本地AgentSkills和Claude单技能子集可导入；版本升级不改旧pin', async () => {
  const source = path.join(dir, 'local'); await fs.mkdir(source)
  const skill = (text) => '---\nname: test-writing\ndescription: >\n  写作检查技能\n  按需读取而不执行脚本\n---\n' + text
  await fs.writeFile(path.join(source, 'SKILL.md'), skill('原版指令'))
  const registry = new api.ExtensionRegistry(path.join(dir, 'local-registry'))
  await registry.install(source, 'skill'); await registry.setEnabled('local/test-writing', true)
  const old = await registry.freeze('local/test-writing', 'skill')
  await fs.writeFile(path.join(source, 'SKILL.md'), skill('新版指令'))
  const updated = await registry.install(source, 'skill')
  assert.equal(updated.enabled, false); assert.notEqual(updated.packageHash, old.record.packageHash)
  assert.match(await registry.resource(old, 'SKILL.md'), /原版指令/)
  const claude = path.join(dir, 'claude'); await fs.mkdir(path.join(claude, '.claude-plugin'), { recursive: true }); await fs.mkdir(path.join(claude, 'skills/test-writing'), { recursive: true })
  await fs.writeFile(path.join(claude, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'writing-plugin', version: '1.0.0', skills: './skills/test-writing' }))
  await fs.writeFile(path.join(claude, 'skills/test-writing/SKILL.md'), skill('Claude子集真实指令'))
  assert.equal((await registry.install(claude, 'skill')).id, 'local/writing-plugin')
  await fs.writeFile(path.join(claude, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'writing-plugin', skills: './skills/test-writing', hooks: './hooks.json' }))
  await assert.rejects(registry.install(claude, 'skill'), /不支持\/未知组件/)
  await fs.writeFile(path.join(source, 'package.json'), '{"scripts":{"install":"must-not-run"}}')
  await assert.rejects(registry.install(source, 'skill'), /第三方工具\/安装脚本/)
  assert.equal(api.activeChildProcesses().length, 0)
})
test('实际冻结hash/路径校验拒绝篡改和越界读取', async () => {
  const registry = new api.ExtensionRegistry(path.join(dir, 'tamper'))
  const record = await registry.install('builtin:deepwriter/structure-review', 'skill'); await registry.setEnabled(record.id, true)
  const pin = await registry.freeze(record.id, 'skill')
  await assert.rejects(registry.resource(pin, '../registry.json'), /path_invalid/)
  await assert.rejects(registry.resource(pin, 'references/not-pinned.md'), /inventory/)
  const target = path.join(registry.root, 'packages', ...record.id.split('/'), record.packageHash, 'SKILL.md')
  await fs.writeFile(target, pin.instructions[0].content.replace('稿件', '文章'))
  await assert.rejects(registry.verify(pin.record), /content_changed/)
  await assert.rejects(registry.freeze(record.id, 'skill'), /content_changed/)
})
test('第一方工具安装不启动；启动独立授权；真实stdio调用/越界拒绝/取消退出', async () => {
  const registry = new api.ExtensionRegistry(path.join(dir, 'tools'))
  const installed = await registry.install('builtin:deepwriter/manuscript-inspector', 'tool')
  assert.equal(installed.enabled, false); assert.equal(api.activeChildProcesses().length, 0)
  await registry.setEnabled(installed.id, true); const pin = await registry.freeze(installed.id, 'tool')
  const client = new api.StdioToolClient(registry, pin)
  await assert.rejects(client.start({ nodeExecutable: process.execPath, roots: [dir], authorized: false }), /permission_required/)
  assert.equal(client.pid, undefined)
  const allowed = path.join(dir, 'documents'); await fs.mkdir(allowed)
  const file = path.join(allowed, '稿件.md'); const text = '灯塔🌊。真实稿件'; await fs.writeFile(file, text)
  const controller = new AbortController()
  const input = { nodeExecutable: process.execPath, roots: [allowed], authorized: true, signal: controller.signal }
  const pendingA = client.start(input); const pendingB = client.start(input)
  assert.equal(pendingA, pendingB, 'concurrent callers must share complete initialization')
  const [tools, duplicate] = await Promise.all([pendingA, pendingB]); assert.deepEqual(duplicate, tools)
  assert.equal(tools[0].name, 'count_manuscript'); assert.ok(client.pid)
  const pid = client.pid
  const result = await client.call(tools[0].name, { path: file }); assert.equal(result.isError, false)
  const value = JSON.parse(result.content[0].text); assert.equal(value.chars, Array.from(text).length); assert.equal(value.sha256, createHash('sha256').update(text).digest('hex'))
  const outside = path.join(dir, 'private.txt'); await fs.writeFile(outside, '不应读取')
  const denied = await client.call(tools[0].name, { path: outside }); assert.equal(denied.isError, true); assert.match(denied.content[0].text, /outside_authorized_roots/); assert.ok(!JSON.stringify(denied).includes('不应读取'))
  await assert.rejects(client.call('undeclared', {}), /not_declared/)
  controller.abort()
  const shutdown = await client.close(); assert.equal(shutdown.exited, true); assert.deepEqual(shutdown.remainingPids, []); assert.equal(shutdown.pid, pid)
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH')
  for (let count = 0; count < 40 && api.activeChildProcesses().length; count++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(api.activeChildProcesses().length, 0)
})
test('受控真实Electron-as-Node传输握手、并发启动和await退出；非Electron父进程拒绝冒充', async () => {
  const registry = new api.ExtensionRegistry(path.join(dir, 'electron-tools'))
  await registry.install('builtin:deepwriter/manuscript-inspector', 'tool'); await registry.setEnabled('deepwriter/manuscript-inspector', true)
  const pin = await registry.freeze('deepwriter/manuscript-inspector', 'tool')
  const invalid = new api.StdioToolClient(registry, pin)
  await assert.rejects(invalid.start({ nodeExecutable: process.execPath, electronAsNode: true, roots: [dir], authorized: true }), /not_current_controlled_host/)
  assert.equal(invalid.pid, undefined)
  const electron = require('electron')
  const controller = path.join(dir, 'electron-controller.cjs')
  const result = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    import { ExtensionRegistry } from './src/main/extensions/ExtensionRegistry';
    import { StdioToolClient } from './src/main/extensions/StdioToolClient';
    import { activeChildProcesses } from './src/main/childRegistry';
    import assert from 'node:assert/strict';
    import { promises as fs } from 'node:fs';
    async function main() {
      const registry = new ExtensionRegistry(process.argv[2]);
      const pin = await registry.freeze('deepwriter/manuscript-inspector', 'tool');
      const client = new StdioToolClient(registry, pin);
      const options = {nodeExecutable:process.execPath,electronAsNode:true,roots:[process.argv[3]],authorized:true};
      const first=client.start(options); const second=client.start(options);
      assert.equal(first,second);
      const tools=await first; assert.equal(tools.length,1);
      const pid=client.pid!;
      const value:any=await client.call('count_manuscript',{path:process.argv[4]});
      assert.equal(value.isError,false); assert.equal(JSON.parse(value.content[0].text).chars,5);
      const closed=await client.close(); assert.equal(closed.exited,true); assert.deepEqual(closed.remainingPids,[]);
      assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');
      assert.equal(activeChildProcesses().length,0);
      process.stdout.write(JSON.stringify({electron:process.versions.electron,node:process.versions.node,closed})+'\\n');
    }
    main().catch(e=>{process.stderr.write(e.message);process.exitCode=1});
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent',
    plugins: [{ name: 'controlled-electron-source', setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.path.startsWith('.')) return { path: args.path, external: true }
        const target = path.resolve(args.resolveDir, args.path); const found = ['', '.ts'].map((ext) => target + ext).find(existsSync)
        if (!found || !found.startsWith(root + path.sep)) throw new Error('Source outside workspace')
        return { path: found, namespace: 'source' }
      })
      build.onLoad({ filter: /.*/, namespace: 'source' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
    } }] })
  await fs.writeFile(controller, result.outputFiles[0].text)
  const file = path.join(dir, 'electron-稿件.md'); await fs.writeFile(file, '灯塔🌊。夜')
  const env = { ELECTRON_RUN_AS_NODE: '1', SYNTHETIC_SECRET_MUST_NOT_INHERIT: 'fake-sensitive' }; if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  const child = spawn(electron, [controller, registry.root, dir, file], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk }); child.stderr.on('data', (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill(), 12000)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) }); clearTimeout(timer)
  assert.equal(code, 0, stderr); const report = JSON.parse(stdout); assert.ok(report.electron); assert.equal(report.closed.exited, true)
})
test('共享Activation同run并发只授权/启动一次；关闭撤销阻止调用，明确恢复需重新授权', async () => {
  const registry = new api.ExtensionRegistry(path.join(dir, 'activation'))
  await registry.install('builtin:deepwriter/manuscript-inspector', 'tool'); await registry.setEnabled('deepwriter/manuscript-inspector', true)
  const frozen = await api.freezeExtensions(registry, [], ['deepwriter/manuscript-inspector'])
  let grants = 0, starts = 0, pid, stopped; let allow = true
  const activation = new api.ExtensionActivation({ nodeExecutable: process.execPath, authorizeStart: async () => { grants++; return allow }, onStarted: (_run, _pin, value) => { starts++; pid = value }, onStopped: (_run, value) => { stopped = value } })
  activation.beginRun('run')
  const [a, b] = await Promise.all([activation.getToolSpecs('run', frozen, [dir]), activation.getToolSpecs('run', frozen, [dir])])
  assert.deepEqual(a, b); assert.equal(grants, 1); assert.equal(starts, 1)
  await activation.closeRun('run'); assert.equal(stopped.exited, true); assert.deepEqual(stopped.remainingPids, []); assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH')
  await assert.rejects(activation.getToolSpecs('run', frozen, [dir]), /closed_or_cancelled/)
  await assert.rejects(activation.execute('run', frozen, a[0].function.name, '{}', [a[0].function.name]), /宿主已关闭/)
  activation.beginRun('run'); allow = false
  await assert.rejects(activation.getToolSpecs('run', frozen, [dir]), /permission_required/)
  assert.equal(grants, 2); assert.equal(starts, 1); assert.equal(api.activeChildProcesses().length, 0)
  await activation.close()
})
test('Windows真实跨进程读句柄短暂占用：原子registry替换有限重试，不重跑work或丢更新', { skip: process.platform !== 'win32' }, async () => {
  const registry = new api.ExtensionRegistry(path.join(dir, 'registry-sharing'))
  const plugin = await registry.install('builtin:deepwriter/manuscript-inspector', 'tool')
  await registry.install('builtin:deepwriter/prose-polish', 'skill'); await registry.setEnabled(plugin.id, true)
  const pin = await registry.freeze(plugin.id, 'tool')
  const file = path.join(registry.root, 'registry.json'); const previous = await fs.readFile(file, 'utf8')
  const reader = spawn(process.execPath, ['-e', `
    const fs = require('node:fs'); const handle = fs.openSync(process.argv[1], 'r');
    let released = false; const release = () => { if (released) return; released = true; clearTimeout(timer); fs.closeSync(handle); process.stdin.destroy() };
    const timer = setTimeout(release, 5000); process.stdin.once('data', release); process.stdout.write('ready\\n');
  `, file], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const releaseReader = () => { if (!reader.stdin.writableEnded && !reader.stdin.destroyed) reader.stdin.end('release') }
  let stdout = '', stderr = ''; reader.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve, reject) => { reader.once('error', reject); reader.once('exit', (code, signal) => resolve({ code, signal })) })
  await new Promise((resolve, reject) => {
    reader.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('ready\n')) resolve() })
    reader.once('error', reject); reader.once('exit', () => { if (!stdout.includes('ready\n')) reject(new Error(stderr || 'reader exited before ready')) })
  })
  const originalRename = fs.rename; const attempts = []; let releaseScheduled = false
  fs.rename = async (from, to) => {
    if (to !== file) return originalRename(from, to)
    attempts.push(Date.now())
    try { return await originalRename(from, to) } catch (error) {
      assert.equal(error.code, 'EPERM'); assert.equal(error.syscall, 'rename')
      if (!releaseScheduled) {
        releaseScheduled = true
        assert.equal(await fs.readFile(file, 'utf8'), previous, 'old durable registry remains intact during sharing failure')
        await assert.rejects(new api.ExtensionRegistry(registry.root).setEnabled('deepwriter/prose-polish', true), /正被另一个进程修改/)
        setTimeout(releaseReader, 90)
      }
      throw error
    }
  }
  try {
    await registry.setEnabled(plugin.id, false, true)
    const sharingAttempts = attempts.slice()
    assert.ok(sharingAttempts.length > 1 && sharingAttempts.length <= 6, 'real sharing conflict must retry with a finite bound')
    assert.ok(sharingAttempts[1] - sharingAttempts[0] >= 8, 'retry uses genuine backoff, not a busy loop')
    const replaced = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(replaced.revision, JSON.parse(previous).revision + 1, 'work and revision increment happen once')
    assert.equal(replaced.extensions.find((item) => item.id === plugin.id).removed, true)
    await assert.rejects(registry.assertPluginEnabled(pin), /permission_revoked/)
    await registry.setEnabled('deepwriter/prose-polish', true)
    const later = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(later.revision, replaced.revision + 1)
    assert.equal(later.extensions.find((item) => item.id === plugin.id).removed, true, 'next writer preserves completed revocation')
    assert.equal(later.extensions.find((item) => item.id === 'deepwriter/prose-polish').enabled, true)
    assert.ok(!(await fs.readdir(registry.root)).some((name) => name === 'registry.lock' || name.startsWith('.registry-')))
    console.log('registry real-sharing proof ' + JSON.stringify({ attempts: sharingAttempts.length, backoffMs: sharingAttempts.slice(1).map((time, index) => time - sharingAttempts[index]), revision: [JSON.parse(previous).revision, replaced.revision, later.revision] }))
  } finally { fs.rename = originalRename; releaseReader(); assert.deepEqual(await exited, { code: 0, signal: null }, stderr) }
})
test('registry持续sharing型拒绝有界失败且保留旧durable状态；非sharing错误不重试', async () => {
  const registry = new api.ExtensionRegistry(path.join(dir, 'registry-terminal-errors'))
  const record = await registry.install('builtin:deepwriter/prose-polish', 'skill')
  const file = path.join(registry.root, 'registry.json'); const previous = await fs.readFile(file, 'utf8')
  const originalRename = fs.rename
  try {
    for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'EXDEV', 'EROFS']) {
      let attempts = 0
      const denied = Object.assign(new Error('synthetic registry rename denial'), { code, syscall: 'rename', path: file + '.tmp', dest: file })
      fs.rename = async (from, to) => { if (to !== file) return originalRename(from, to); attempts++; throw denied }
      const started = Date.now()
      await assert.rejects(registry.setEnabled(record.id, true), (error) => error === denied)
      const retryable = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(code)
      assert.equal(attempts, retryable ? 6 : 1)
      if (retryable) assert.ok(Date.now() - started >= 300, 'bounded attempts include real asynchronous backoff')
      assert.equal(await fs.readFile(file, 'utf8'), previous)
      assert.ok(!(await fs.readdir(registry.root)).some((name) => name === 'registry.lock' || name.startsWith('.registry-')))
    }
  } finally { fs.rename = originalRename }
})
test('Windows实际只读registry的永久权限拒绝不重试、不删除目的文件', { skip: process.platform !== 'win32' }, async () => {
  const registry = new api.ExtensionRegistry(path.join(dir, 'registry-readonly'))
  const record = await registry.install('builtin:deepwriter/prose-polish', 'skill')
  const file = path.join(registry.root, 'registry.json'); const previous = await fs.readFile(file, 'utf8')
  const originalRename = fs.rename; let attempts = 0
  fs.rename = async (from, to) => { if (to === file) attempts++; return originalRename(from, to) }
  await fs.chmod(file, 0o444)
  try {
    await assert.rejects(registry.setEnabled(record.id, true), (error) => error.code === 'EPERM' || error.code === 'EACCES')
    assert.equal(attempts, 1)
    assert.equal(await fs.readFile(file, 'utf8'), previous)
    assert.ok(!(await fs.readdir(registry.root)).some((name) => name === 'registry.lock' || name.startsWith('.registry-')))
  } finally { fs.rename = originalRename; await fs.chmod(file, 0o666) }
})
test('真实跨CLI disable/remove撤销活动插件并await PIDgone；原pin不可新调用/恢复', async () => {
  for (const action of ['disable', 'remove']) {
    const dataDir = path.join(dir, 'cross-revoke-' + action)
    await run(['plugins', 'install', 'builtin:deepwriter/manuscript-inspector', '--data-dir', dataDir]); await run(['plugins', 'enable', 'deepwriter/manuscript-inspector', '--data-dir', dataDir])
    requests = []; mode = 'slow'
    const live = launch(['chat', '持续稿件', '--plugin', 'deepwriter/manuscript-inspector', '--allow-plugin-start', 'deepwriter/manuscript-inspector', ...flags(dataDir)])
    for (let i = 0; i < 180 && !live.stdout().includes('候选正文'); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    const runId = JSON.parse(live.stdout().split(/\r?\n/).find((line) => line.includes('"type":"run"'))).data.runId
    const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
    const started = JSON.parse(db.prepare("select json from run_evidence where run_id=? and kind like 'extension_host_started_%'").get(runId).json); db.close()
    assert.ok(started.pid); process.kill(started.pid, 0)
    const changed = await run(['plugins', action, 'deepwriter/manuscript-inspector', '--data-dir', dataDir]); assert.equal(changed.code, 0, changed.stderr)
    const done = await live.done; assert.equal(done.code, 2, done.stderr)
    assert.throws(() => process.kill(started.pid, 0), (error) => error.code === 'ESRCH')
    assert.ok(done.events.some((event) => event.type === 'extension' && event.data.state === 'permission_revoked'))
    const count = requests.length
    const resumed = await run(['resume', runId, '--allow-plugin-start', 'deepwriter/manuscript-inspector', ...flags(dataDir)])
    assert.equal(resumed.code, 1); assert.match(resumed.stderr, /permission_revoked/); assert.equal(requests.length, count)
  }
})
test('待决grant期间撤权，不允许迟到授权启动；已有宿主停用后0新工具调用', async () => {
  const registry = new api.ExtensionRegistry(path.join(dir, 'pending-revoke'))
  await registry.install('builtin:deepwriter/manuscript-inspector', 'tool'); await registry.setEnabled('deepwriter/manuscript-inspector', true)
  const frozen = await api.freezeExtensions(registry, [], ['deepwriter/manuscript-inspector'])
  let resolveGrant, entered; const enteredPromise = new Promise((resolve) => { entered = resolve })
  const host = new api.ExtensionActivation({ nodeExecutable: process.execPath, authorizeStart: async () => { entered(); return new Promise((resolve) => { resolveGrant = resolve }) } })
  host.beginRun('pending')
  const pending = host.getToolSpecs('pending', frozen, [dir]); await enteredPromise
  await registry.setEnabled('deepwriter/manuscript-inspector', false); resolveGrant(true)
  await assert.rejects(pending, /permission_revoked/); assert.equal(api.activeChildProcesses().length, 0)
  await host.close()
  await registry.setEnabled('deepwriter/manuscript-inspector', true)
  let stopped, pid
  const active = new api.ExtensionActivation({ nodeExecutable: process.execPath, authorizeStart: async () => true, onStarted: (_id, _pin, value) => { pid = value }, onStopped: (_id, value) => { stopped = value } })
  active.beginRun('active'); const specs = await active.getToolSpecs('active', frozen, [dir]); await registry.setEnabled('deepwriter/manuscript-inspector', false)
  await assert.rejects(active.execute('active', frozen, specs[0].function.name, JSON.stringify({ path: path.join(dir, 'private.txt') }), [specs[0].function.name]), /permission_revoked/)
  for (let i = 0; i < 120 && !stopped; i++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(stopped.exited, true); assert.deepEqual(stopped.remainingPids, []); assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH')
  await active.close()
})
test('CLI真实生命周期+选中技能指令进actual HTTP，按需资源走durable工具链', async () => {
  mode = 'resource'; requests = []; const dataDir = path.join(dir, 'cli-skills')
  let reply = await run(['skills', 'catalog', '--data-dir', dataDir, '--json'])
  assert.equal(reply.code, 0); assert.equal(reply.events[0].data.length, 2)
  reply = await run(['skills', 'install', 'builtin:deepwriter/structure-review', '--data-dir', dataDir, '--json'])
  assert.equal(reply.code, 0, reply.stderr); assert.equal(reply.events[0].data.enabled, false)
  const denied = await run(['chat', '实际审阅稿件', '--skill', 'deepwriter/structure-review', ...flags(dataDir)])
  assert.equal(denied.code, 1); assert.equal(requests.length, 0)
  assert.equal((await run(['skills', 'enable', 'deepwriter/structure-review', '--data-dir', dataDir])).code, 0)
  reply = await run(['chat', '请按选择的技能读取检查标准，实际审阅稿件', '--skill', 'deepwriter/structure-review', ...flags(dataDir)])
  assert.equal(reply.code, 0, reply.stderr)
  assert.ok(requests[0].messages.some((message) => message.role === 'system' && message.content.includes('# 稿件结构审阅')))
  assert.ok(!requests[0].messages.some((message) => message.content.includes('核对四项：')))
  // This loopback fixture has no frozen, supported provider-account web grant.
  // Selecting a skill authorizes only its pinned resource reader, not free web tools.
  assert.deepEqual(requests[0].tools.map((tool) => tool.function.name).sort(), ['read_skill_resource'])
  assert.ok(requests[1].messages.some((message) => message.role === 'tool' && message.content.includes('核对四项：')))
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
  const config = JSON.parse(db.prepare('select config_json from runs').get().config_json)
  assert.equal(config.extensionsFrozen.skills[0].record.id, 'deepwriter/structure-review')
  assert.equal(config.webAccess, undefined)
  assert.ok(!config.toolPolicy.allowList.some(name => ['web_search', 'read_web_page'].includes(name)))
  assert.equal(db.prepare('select status from toolcalls').get().status, 'completed'); db.close()
  assert.equal((await run(['skills', 'disable', 'deepwriter/structure-review', '--data-dir', dataDir])).code, 0)
  assert.equal((await run(['skills', 'inspect', 'deepwriter/structure-review', '--data-dir', dataDir, '--json'])).events[0].data.enabled, false)
  assert.equal((await run(['skills', 'remove', 'deepwriter/structure-review', '--data-dir', dataDir])).code, 0)
  assert.equal((await run(['skills', 'list', '--data-dir', dataDir, '--json'])).events[0].data.length, 0)
})
test('CLI启用≠启动：无另行授权0 HTTP；授权后real stdio schema/读文件/越界拒绝', async () => {
  requests = []; const dataDir = path.join(dir, 'cli-plugin'); await fs.mkdir(path.join(dataDir, 'documents'), { recursive: true })
  toolPath = path.join(dataDir, 'documents/实际稿件.md'); await fs.writeFile(toolPath, '灯塔🌊。真实稿件。')
  assert.equal(Array.from('灯塔🌊。真实稿件。').length, 9)
  assert.equal((await run(['plugins', 'install', 'builtin:deepwriter/manuscript-inspector', '--data-dir', dataDir])).code, 0)
  assert.equal((await run(['plugins', 'enable', 'deepwriter/manuscript-inspector', '--data-dir', dataDir])).code, 0)
  mode = 'plugin'
  const denied = await run(['chat', '检查实际稿件', '--plugin', 'deepwriter/manuscript-inspector', ...flags(dataDir)])
  assert.notEqual(denied.code, 0); assert.match(denied.stdout + denied.stderr, /permission_required/); assert.equal(requests.length, 0)
  const reply = await run(['chat', '检查实际稿件', '--plugin', 'deepwriter/manuscript-inspector', '--allow-plugin-start', 'deepwriter/manuscript-inspector', ...flags(dataDir)])
  assert.equal(reply.code, 0, reply.stderr)
  const name = requests[0].tools.find(tool => tool.function.name.startsWith('dw_')).function.name; assert.match(name, /^dw_[a-f0-9]{12}_count_manuscript$/)
  assert.ok(requests[1].messages.some((message) => message.role === 'tool' && message.content.includes(createHash('sha256').update('灯塔🌊。真实稿件。').digest('hex'))))
  mode = 'plugin-deny'; toolPath = path.join(dir, 'private-outside.txt'); await fs.writeFile(toolPath, '私密不应读取')
  const outside = await run(['chat', '读取越界文件', '--plugin', 'deepwriter/manuscript-inspector', '--allow-plugin-start', 'deepwriter/manuscript-inspector', ...flags(dataDir)])
  assert.equal(outside.code, 0, outside.stderr); assert.ok(!outside.stdout.includes('私密不应读取'))
  assert.equal(await fs.readFile(toolPath, 'utf8'), '私密不应读取')
})
test('升级/卸载不改resume旧技能pin与原预算；allowed-tools不自动授权', async () => {
  const dataDir = path.join(dir, 'cli-resume'); const source = path.join(dir, 'resume-skill'); await fs.mkdir(source)
  const skill = (body) => '---\nname: frozen-writing\ndescription: 恢复必须使用原内容\nallowed-tools: write_file\n---\n' + body
  await fs.writeFile(path.join(source, 'SKILL.md'), skill('旧版写作指令'))
  await run(['skills', 'install', source, '--data-dir', dataDir]); await run(['skills', 'enable', 'local/frozen-writing', '--data-dir', dataDir])
  requests = []; mode = 'slow'
  const live = launch(['chat', '持续稿件', '--skill', 'local/frozen-writing', ...flags(dataDir)])
  for (let i = 0; i < 150 && !live.stdout().includes('候选正文'); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  const runId = JSON.parse(live.stdout().split(/\r?\n/).find((line) => line.includes('"type":"run"'))).data.runId
  await run(['pause', runId, ...flags(dataDir)]); assert.equal((await live.done).code, 2)
  assert.ok(!requests[0].tools.some((tool) => tool.function.name === 'write_file'), 'skill allowed-tools must not grant authorization')
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true }); const old = JSON.parse(db.prepare('select config_json from runs where run_id=?').get(runId).config_json); db.close()
  await fs.writeFile(path.join(source, 'SKILL.md'), skill('新版写作指令'))
  await run(['skills', 'install', source, '--data-dir', dataDir]); await run(['skills', 'enable', 'local/frozen-writing', '--data-dir', dataDir]); await run(['skills', 'remove', 'local/frozen-writing', '--data-dir', dataDir])
  mode = 'plain'
  const beforeResume = requests.length
  const refused = await run(['resume', runId, '--skill', 'missing/not-installed', '--max-calls', '512', ...flags(dataDir)])
  assert.equal(refused.code, 1); assert.match(refused.stderr, /恢复不改写原有限调用次数/)
  assert.equal(requests.length, beforeResume, 'rejected budget mutation must not make another provider request')
  const resumed = await run(['resume', runId, '--skill', 'missing/not-installed', ...flags(dataDir)])
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.ok(requests.at(-1).messages.some((message) => message.content.includes('旧版写作指令')))
  assert.ok(!requests.at(-1).messages.some((message) => message.content.includes('新版写作指令')))
  const final = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true }); const cfg = JSON.parse(final.prepare('select config_json from runs where run_id=?').get(runId).config_json); final.close()
  assert.deepEqual(cfg.providerCallBudget, old.providerCallBudget); assert.deepEqual(cfg.extensionsFrozen, old.extensionsFrozen)
})
test('暂停run旧pin被篡改：恢复拒绝且0新HTTP，不借当前最新版', async () => {
  const dataDir = path.join(dir, 'cli-corrupt')
  await run(['skills', 'install', 'builtin:deepwriter/prose-polish', '--data-dir', dataDir]); await run(['skills', 'enable', 'deepwriter/prose-polish', '--data-dir', dataDir])
  requests = []; mode = 'slow'
  const live = launch(['chat', '持续稿件', '--skill', 'deepwriter/prose-polish', ...flags(dataDir)])
  for (let i = 0; i < 150 && !live.stdout().includes('候选正文'); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  const runId = JSON.parse(live.stdout().split(/\r?\n/).find((line) => line.includes('"type":"run"'))).data.runId
  await run(['pause', runId, ...flags(dataDir)]); assert.equal((await live.done).code, 2)
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true }); const frozen = JSON.parse(db.prepare('select config_json from runs where run_id=?').get(runId).config_json).extensionsFrozen; db.close()
  const pin = frozen.skills[0]; const file = path.join(frozen.registryRoot, 'packages', ...pin.record.id.split('/'), pin.record.packageHash, 'SKILL.md')
  await fs.writeFile(file, '未经冻结的新指令')
  const count = requests.length; mode = 'plain'
  const reply = await run(['resume', runId, ...flags(dataDir)])
  assert.equal(reply.code, 1); assert.match(reply.stderr, /content_changed/); assert.equal(requests.length, count)
})
test('共享adapter在实际body预算前合并schema，拒绝重名，仍执行冻结allowList过滤', async () => {
  const cfg = { contextBudget: { contextWindowTokens: 64000, maxOutputTokens: 256 }, toolPolicy: { allowList: ['extension_ok'] } }
  const spec = (name) => ({ type: 'function', function: { name, description: '实际附加工具', parameters: { type: 'object', properties: {} } } })
  const make = (specs) => api.createModelCallAdapter({
    getApi: () => ({ apiKey: '', baseUrl, model: 'fixture', maxTokens: 256, thinking: { enabled: false, effort: 'low' }, temperature: 0.7, topP: 0.9, profileId: 'actual-extension-test', adapterId: 'builtin.deepseek', protocol: 'deepseek-chat', chatPath: '/chat/completions', authStyle: 'none', supportsTools: true, transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }),
    getConfig: () => cfg, getSignal: () => undefined, buildPrefix: async () => [{ role: 'system', content: '写作' }], getToolSpecs: async () => specs
  })
  const input = { runId: 'adapter-test', phase: 'execute', turnSeq: 1, round: 1, messages: [{ role: 'user', content: '写作' }] }
  const count = requests.length
  await assert.rejects(make([spec('read_file')])(input), /name_conflict/)
  assert.equal(requests.length, count)
  mode = 'plain'; let exact
  const iterable = await make([spec('extension_ok'), spec('extension_filtered')])({ ...input, beforeProviderAttempt: ({ request }) => { exact = request.bodyJson } })
  for await (const event of iterable) { if (event.type === 'error') throw new Error(event.error) }
  assert.deepEqual(JSON.parse(exact).tools.map((tool) => tool.function.name), ['extension_ok'])
  assert.deepEqual(requests.at(-1).tools, JSON.parse(exact).tools)
})
test('Claude静态本地marketplace来源真实校验；远程/command/hook来源拒绝', async () => {
  const catalog = path.join(dir, 'marketplace'); await fs.mkdir(path.join(catalog, '.claude-plugin'), { recursive: true }); await fs.mkdir(path.join(catalog, 'packs/writing'), { recursive: true })
  await fs.writeFile(path.join(catalog, 'packs/writing/SKILL.md'), '---\nname: writing\ndescription: 真实本地写作技能\n---\n审阅结构，不执行代码')
  const file = path.join(catalog, '.claude-plugin/marketplace.json')
  await fs.writeFile(file, JSON.stringify({ name: 'local-writers', plugins: [{ name: 'writing', source: './packs/writing' }] }))
  const registry = new api.ExtensionRegistry(path.join(dir, 'marketplace-registry')); const items = await registry.localCatalog(catalog)
  assert.equal(items[0].source, await fs.realpath(path.join(catalog, 'packs/writing'))); assert.match(items[0].catalogHash, /^[a-f0-9]{64}$/)
  assert.equal((await registry.install(items[0].source, 'skill')).enabled, false)
  await fs.writeFile(file, JSON.stringify({ name: 'local-writers', plugins: [{ name: 'writing', source: { source: 'npm', package: 'untrusted' } }] }))
  await assert.rejects(registry.localCatalog(catalog), /远程来源被拒绝/)
  await fs.writeFile(file, JSON.stringify({ name: 'local-writers', plugins: [{ name: 'writing', source: '../outside' }] }))
  await assert.rejects(registry.localCatalog(catalog), /path_invalid/)
  assert.equal(api.activeChildProcesses().length, 0)
})
