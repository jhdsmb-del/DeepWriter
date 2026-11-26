// Manual ConPTY smoke: starts an isolated local provider and real interactive CLI.
// No owner data or credentials are read. /exit prints request/session evidence.
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
async function main() {
  const paste = process.argv.includes('--paste')
  const writing = process.argv.includes('--write')
  const agent = writing || process.argv.includes('--agent')
  const root = path.resolve(__dirname, '..')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-tty-smoke-'))
  const bundle = path.join(dir, 'deepwriter.cjs')
  const build = spawn(process.execPath, ['src/cli/build.mjs', `--outfile=${bundle}`], { cwd: root, stdio: 'inherit' })
  await new Promise((resolve, reject) => build.on('exit', (code) => code === 0 ? resolve() : reject(new Error('build failed'))))
  const target = path.join(dir, 'manuscript.md')
  if (writing) await fs.writeFile(target, '用户原稿。')
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const data = JSON.parse(body)
      const messages = data.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content }))
      requests.push({ model: data.model, messages, tools: data.tools?.map(tool => tool.function.name) })
      const last = messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (text) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`)
      if (writing && !data.messages.some(message => message.role === 'tool')) {
        assert.ok(data.tools.some(tool => tool.function.name === 'write_file'))
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tty-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: target, content: '明确授权后的新稿。' }) } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      } else if (String(last).includes('slow')) {
        send('慢流已开始。')
        const timer = setInterval(() => send('继续。'), 1000)
        res.on('close', () => clearInterval(timer))
      } else {
        send('本机接口回复完成。')
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  console.log(`ISOLATED_TTY ${JSON.stringify({ stdin: process.stdin.isTTY, stdout: process.stdout.isTTY, stderr: process.stderr.isTTY })}`)
  const child = spawn(process.execPath, [bundle, ...(agent ? ['agent'] : []), '--data-dir', dir, '--base-url', `http://127.0.0.1:${server.address().port}`, '--loopback', '--no-review', ...(writing ? ['--work-dir', dir] : [])], { cwd: root, stdio: 'inherit', env: { ...process.env, DEEPWRITER_API_KEY: 'synthetic-tty-smoke-key' } })
  // ConPTY delivers Ctrl+C to the process group: leave the fixture alive so
  // the CLI can handle it and we can inspect the durable evidence on /exit.
  const signal = () => {}
  process.on('SIGINT', signal)
  const code = await new Promise((resolve) => child.on('exit', resolve))
  process.removeListener('SIGINT', signal)
  console.log('SMOKE_REQUESTS', JSON.stringify(requests.map((request) => ({ model: request.model, userMessages: request.messages.filter((message) => message.role === 'user').map((message) => message.content) }))))
  console.log('SMOKE_EXIT', code)
  console.log('SMOKE_DATA', dir)
  await new Promise((resolve) => server.close(resolve))
  assert.equal(code, 0)
  assert.equal(requests.length, writing ? 2 : paste ? 1 : 4, 'expected one request per message, no replay')
  assert.ok(requests.every((request) => request.model === 'smoke-model'))
  if (agent) assert.ok(requests.every(request => request.tools?.includes('read_file') && request.tools.includes('web_search')), 'TTY agent must freeze web and local schemas')
  assert.deepEqual(requests.map((request) => request.messages.filter((message) => message.role === 'user').map((message) => message.content)), writing ? [['write my manuscript'], ['write my manuscript']] : paste ? [['first paragraph.\n\n  second paragraph.']] : [
    ['slow first'], ['slow first', 'after pause'], ['new session message'], ['slow first', 'after pause', 'restored session message']
  ], 'session switch must restore only that session history')
  if (writing) assert.equal(await fs.readFile(target, 'utf8'), '明确授权后的新稿。')
  assert.equal(path.dirname(dir), os.tmpdir())
  assert.ok(path.basename(dir).startsWith('deepwriter-tty-smoke-'))
  await fs.rm(dir, { recursive: true, force: true })
  console.log(writing ? 'SMOKE_PASS real TTY agent overwrite required one explicit allow; two requests; final file verified; temporary data removed' : paste ? 'SMOKE_PASS real TTY batched multiline paste; one request; paragraph breaks and indentation preserved; temporary data removed' : 'SMOKE_PASS 4 requests; pause returned to prompt; sessions isolated; temporary data removed')
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
