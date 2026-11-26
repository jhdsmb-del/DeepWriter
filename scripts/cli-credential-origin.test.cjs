const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')
const root = path.resolve(__dirname, '..')
const officialKey = 'synthetic-official-"quoted\\key-value'
const compatKey = 'synthetic-compatible-env-value'
const fileKey = 'synthetic-explicit-file-key-value'
const compat = 'https://cli-compatible.invalid', other = 'https://cli-other.invalid'
const events = text => text.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))

function launch(bundle, args, cwd, preload, router) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), bundle, ...args], {
      cwd, env: { ...process.env, DEEPWRITER_API_KEY: officialKey, DW_CLI_SYNTHETIC_COMPAT_KEY: compatKey, DW_CLI_SYNTHETIC_ROUTER: router }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => child.kill(), 20000)
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, events: events(stdout) }) })
  })
}

test('actual CLI keeps official, explicit compatible and local no-key credentials at their selected origins', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-cli-credentials-'))
  let server
  try {
    const bundle = path.join(dir, 'deepwriter.cjs')
    const built = await launch(path.join(root, 'src/cli/build.mjs'), [`--outfile=${bundle}`], root)
    assert.equal(built.code, 0, built.stderr)
    const requests = []
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', bytes => { raw += bytes }); req.on('end', () => {
        const body = JSON.parse(raw); requests.push({ headers: req.headers, path: req.url, body })
        if (body.model === 'emit-auth-error') {
          res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'denied ' + req.headers.authorization } })); return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '实际模型 ' + body.model }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const local = `http://127.0.0.1:${server.address().port}`, preload = path.join(dir, 'local-only-wire.cjs')
    // Keep the real CLI/config/protocol serializers. Only transport is routed
    // to our HTTP fixture; no public DNS, HTTPS or paid request can escape.
    await fs.writeFile(preload, `
const dns=require('node:dns/promises'), https=require('node:https'), http=require('node:http');
const router=new URL(process.env.DW_CLI_SYNTHETIC_ROUTER), allowed=new Set(['api.deepseek.com','cli-compatible.invalid','cli-other.invalid']);
const originalLookup=dns.lookup; dns.lookup=async function(host,...args){if(allowed.has(host))return [{address:'1.1.1.1',family:4}];if(!['127.0.0.1','localhost','::1'].includes(host))throw Error('fixture denied DNS');return originalLookup(host,...args)};
https.request=function(options,callback){if(!allowed.has(options.hostname))throw Error('fixture denied HTTPS');return http.request({...options,protocol:'http:',hostname:'127.0.0.1',port:router.port,lookup:undefined,headers:{...options.headers,'x-fixture-origin':'https://'+options.hostname}},callback)};
const originalFetch=globalThis.fetch;globalThis.fetch=function(input,init={}){const u=new URL(typeof input==='string'?input:input.url??input);if(u.protocol==='https:'&&allowed.has(u.hostname)){const headers=new Headers(init.headers);headers.set('x-fixture-origin',u.origin);return originalFetch(new URL(u.pathname+u.search,router),{...init,headers})}if(u.origin===router.origin)return originalFetch(input,init);throw Error('fixture denied fetch')};
`)
    const run = (args, data) => launch(bundle, [...args, '--data-dir', data, '--json'], dir, preload, local)
    const checkRedacted = result => {
      for (const secret of [officialKey, compatKey, fileKey]) {
        assert.ok(!result.stdout.includes(secret)); assert.ok(!result.stderr.includes(secret))
        assert.ok(!result.stdout.includes(JSON.stringify(secret).slice(1, -1)))
      }
    }
    const officialData = path.join(dir, 'official')
    const saved = await run(['config', 'set'], officialData)
    assert.equal(saved.code, 0, saved.stderr); checkRedacted(saved)
    const preferences = JSON.parse(await fs.readFile(path.join(officialData, 'config.json'), 'utf8'))
    assert.equal(preferences.keyEnvOrigin, 'https://api.deepseek.com'); assert.equal(preferences.apiKey, undefined)
    const official = await run(['chat', '正常请求', '--no-web'], officialData)
    assert.equal(official.code, 0, official.stderr)
    assert.equal(requests.at(-1).headers.authorization, 'Bearer ' + officialKey)
    assert.equal(requests.at(-1).headers['x-fixture-origin'], 'https://api.deepseek.com')
    assert.equal(requests.at(-1).path, '/chat/completions'); assert.equal(requests.at(-1).body.model, 'deepseek-flash')
    let count = requests.length
    const cross = await run(['chat', '不转发官方密钥', '--base-url', compat + '/v1', '--protocol', 'openai-chat', '--model', 'compatible-model', '--no-web'], officialData)
    assert.equal(cross.code, 1); assert.match(cross.stderr, /不会自动转发官方 Key/); assert.equal(requests.length, count); checkRedacted(cross)

    const compatData = path.join(dir, 'compatible')
    const selected = await run(['config', 'set', '--base-url', compat + '/proxy/v2', '--protocol', 'openai-chat', '--model', 'precise-compatible-model', '--auth-header', 'api-key', '--key-env', 'DW_CLI_SYNTHETIC_COMPAT_KEY'], compatData)
    assert.equal(selected.code, 0, selected.stderr); checkRedacted(selected)
    const compatible = await run(['chat', '使用保存的明确服务', '--no-web'], compatData)
    assert.equal(compatible.code, 0, compatible.stderr)
    assert.equal(requests.at(-1).headers['api-key'], compatKey); assert.equal(requests.at(-1).headers.authorization, undefined)
    assert.equal(requests.at(-1).headers['x-fixture-origin'], compat); assert.equal(requests.at(-1).path, '/proxy/v2/chat/completions')
    assert.equal(requests.at(-1).body.model, 'precise-compatible-model')
    count = requests.length
    const moved = await run(['chat', '另一个服务不能继承', '--base-url', other + '/v1', '--no-web'], compatData)
    assert.equal(moved.code, 1); assert.equal(requests.length, count)
    const explicit = await run(['chat', '明确重选同名环境来源', '--base-url', other + '/v1', '--key-env', 'DW_CLI_SYNTHETIC_COMPAT_KEY', '--no-web'], compatData)
    assert.equal(explicit.code, 0, explicit.stderr); assert.equal(requests.at(-1).headers['api-key'], compatKey)
    assert.equal(requests.at(-1).headers['x-fixture-origin'], other)

    const localData = path.join(dir, 'local')
    const noKey = await run(['chat', '本地免密', '--base-url', local, '--protocol', 'deepseek-chat', '--model', 'local-exact-model', '--loopback', '--no-web'], localData)
    assert.equal(noKey.code, 0, noKey.stderr); assert.equal(requests.at(-1).headers.authorization, undefined)
    assert.equal(requests.at(-1).body.model, 'local-exact-model')
    const authorizedDefault = await run(['chat', '显式允许此环境密钥', '--base-url', local, '--loopback', '--key-env', 'DEEPWRITER_API_KEY', '--no-web'], localData)
    assert.equal(authorizedDefault.code, 0, authorizedDefault.stderr); assert.equal(requests.at(-1).headers.authorization, 'Bearer ' + officialKey)
    assert.equal((await run(['config', 'set', '--base-url', local, '--loopback', '--model', 'local-exact-model'], localData)).code, 0)
    const publicAgain = await run(['chat', '从本地切回官方', '--base-url', 'https://api.deepseek.com', '--no-loopback', '--model', 'deepseek-flash', '--no-web'], localData)
    assert.equal(publicAgain.code, 0, publicAgain.stderr); assert.equal(requests.at(-1).headers['x-fixture-origin'], 'https://api.deepseek.com')
    assert.equal(requests.at(-1).headers.authorization, 'Bearer ' + officialKey); assert.equal(requests.at(-1).body.model, 'deepseek-flash')

    const configPath = path.join(dir, 'explicit.json'), fileData = path.join(dir, 'file')
    await fs.writeFile(configPath, JSON.stringify({ baseUrl: compat, protocol: 'openai-chat', model: 'file-exact-model', apiKey: fileKey, keyEnv: 'DW_CLI_SYNTHETIC_COMPAT_KEY' }))
    const fromFile = await run(['chat', '显式文件优先于环境', '--config', configPath, '--key-env', 'DW_CLI_SYNTHETIC_COMPAT_KEY', '--no-web'], fileData)
    assert.equal(fromFile.code, 0, fromFile.stderr); assert.equal(requests.at(-1).headers.authorization, 'Bearer ' + fileKey)
    assert.equal(requests.at(-1).body.model, 'file-exact-model'); checkRedacted(fromFile)
    count = requests.length
    const fileMoved = await run(['chat', '不复用文件密钥', '--config', configPath, '--base-url', other, '--no-web'], fileData)
    assert.equal(fileMoved.code, 1); assert.match(fileMoved.stderr, /原 origin/); assert.equal(requests.length, count); checkRedacted(fileMoved)
    const keyOnly = path.join(dir, 'key-only.json'); await fs.writeFile(keyOnly, JSON.stringify({ apiKey: fileKey }))
    const paired = await run(['chat', '明确组合', '--config', keyOnly, '--base-url', other + '/v1', '--protocol', 'openai-chat', '--model', 'key-only-model', '--no-web'], fileData)
    assert.equal(paired.code, 0, paired.stderr); assert.equal(requests.at(-1).headers.authorization, 'Bearer ' + fileKey)
    const savedFile = await run(['config', 'set', '--config', configPath], fileData)
    assert.equal(savedFile.code, 0, savedFile.stderr); assert.ok(!(await fs.readFile(path.join(fileData, 'config.json'), 'utf8')).includes(fileKey))

    count = requests.length
    const mistakenModel = await run(['config', 'set', '--model', officialKey], compatData)
    assert.equal(mistakenModel.code, 1); checkRedacted(mistakenModel); assert.equal(requests.length, count)
    const error = await run(['chat', '错误回执也不得存密钥', '--model', 'emit-auth-error', '--no-web'], officialData)
    assert.equal(error.code, 1, error.stderr); checkRedacted(error)
    const db = new DatabaseSync(path.join(officialData, 'deepwriter.sqlite'), { readOnly: true })
    try {
      const durable = JSON.stringify(db.prepare('SELECT config_json,error_message FROM runs').all())
      assert.ok(!durable.includes(officialKey)); assert.ok(!durable.includes(JSON.stringify(officialKey).slice(1, -1)))
    } finally { db.close() }
    process.stdout.write(`# credential wire: ${requests.length} local-only requests; official/compatible/explicit-file/local-none verified; blocked origin switches made no request\n`)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('dw-cli-credentials-'))
    await fs.rm(dir, { recursive: true, force: true })
  }
})
