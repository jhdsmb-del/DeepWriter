'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { build } = require('esbuild')
const ROOT = path.resolve(__dirname, '..')
const API = 'https://api.github.com/repos/jhdsmb-del/DeepWriter/releases/latest'
const VERSION = '8.0.0'
const NAME = `DeepWriter-${VERSION}-cli-win-x64.zip`
const URL = `https://github.com/jhdsmb-del/DeepWriter/releases/download/v${VERSION}/${NAME}`
const BYTES = Buffer.from('PK\x03\x04offline fixture CLI zip bytes')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function release(asset = {}) {
  return { tag_name: 'v' + VERSION, html_url: `https://github.com/jhdsmb-del/DeepWriter/releases/tag/v${VERSION}`, draft: false, prerelease: false,
    assets: [{ name: NAME, browser_download_url: URL, size: BYTES.length, digest: 'sha256:' + sha(BYTES), state: 'uploaded', ...asset }] }
}
let work, update, cli
test.before(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-update-tests-')))
  const module = path.join(work, 'update.cjs')
  await build({ entryPoints: [path.join(ROOT, 'src/cli/update.ts')], outfile: module, bundle: true, platform: 'node', format: 'cjs', target: 'node22' })
  update = require(module)
  cli = path.join(work, 'cli.cjs')
  await (await import('../src/cli/build.mjs')).buildCli({ outfile: cli, version: VERSION })
})
test.after(() => { if (work) fs.rmSync(work, { recursive: true, force: true }) })
function directory(t) {
  const dir = fs.mkdtempSync(path.join(work, 'received-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function fixture(data = release(), receive = () => new Response(BYTES)) {
  const calls = []
  return { calls, request: async (url, options) => {
    calls.push({ url, options })
    if (url === API) return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
    assert.equal(url, URL, 'only exact official asset is downloaded')
    assert.equal(options.headers.Authorization, undefined)
    return receive(options)
  } }
}

test('explicit check returns newer/current release without fetching assets or creating a profile', async () => {
  const f = fixture()
  assert.equal((await update.checkCliUpdate('7.0.0', f)).updateAvailable, true)
  assert.equal((await update.checkCliUpdate(VERSION, f)).updateAvailable, false)
  assert.equal((await update.checkCliUpdate('9.0.0', f)).updateAvailable, false)
  assert.ok(f.calls.every(call => call.url === API && call.options.credentials === 'omit'))
})

test('stream verified bytes stay private until complete, then publish the exact official CLI ZIP', async t => {
  const dir = directory(t)
  const f = fixture(release(), () => new Response(new ReadableStream({ start(controller) {
    assert.equal(fs.existsSync(path.join(dir, NAME)), false)
    controller.enqueue(BYTES.subarray(0, 4)); controller.enqueue(BYTES.subarray(4)); controller.close()
  } }), { headers: { 'content-length': String(BYTES.length) } }))
  const result = await update.downloadCliUpdate(dir, '7.0.0', f)
  assert.equal(result.status, 'downloaded')
  assert.equal(result.sha256, sha(BYTES))
  assert.equal(result.bytes, BYTES.length)
  assert.deepEqual(fs.readFileSync(result.path), BYTES)
  assert.deepEqual(fs.readdirSync(dir), [NAME])
  assert.deepEqual(f.calls.map(call => call.url), [API, URL])
})

test('already current still permits an explicit fresh download; no CLI never downloads a desktop asset', async t => {
  const dir = directory(t)
  assert.equal((await update.downloadCliUpdate(dir, VERSION, fixture())).updateAvailable, false)
  const missing = fixture({ ...release(), assets: [{ name: 'DeepWriter-8.0.0-x64-setup.exe' }] })
  const result = await update.downloadCliUpdate(directory(t), '7.0.0', missing)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.path, null)
  assert.deepEqual(missing.calls.map(call => call.url), [API])
})

test('missing digest, off-repository metadata, HTTP failures and corrupt release metadata refuse download', async t => {
  for (const [data, expected] of [[release({ digest: null }), /SHA-256/], [release({ browser_download_url: 'https://example.org/cli.zip' }), null]]) {
    const dir = directory(t), f = fixture(data)
    if (expected) await assert.rejects(update.downloadCliUpdate(dir, '7.0.0', f), expected)
    else assert.equal((await update.downloadCliUpdate(dir, '7.0.0', f)).status, 'unavailable')
    assert.deepEqual(fs.readdirSync(dir), [])
    assert.equal(f.calls.length, 1)
  }
  await assert.rejects(update.checkCliUpdate(VERSION, { request: async () => new Response('rate limited', { status: 429 }) }), /GitHub/)
  await assert.rejects(update.checkCliUpdate(VERSION, { request: async () => new Response('{}') }), /正式版本/)
})

test('corrupt, truncated, oversized, wrong-length, failed and interrupted transfers remove all partials', async t => {
  const cases = [
    [() => new Response(Buffer.from('x'.repeat(BYTES.length))), /SHA-256/],
    [() => new Response(BYTES.subarray(1)), /不完整/],
    [() => new Response(Buffer.concat([BYTES, BYTES])), /超过/],
    [() => new Response(BYTES, { headers: { 'content-length': '999' } }), /长度/],
    [() => new Response('service failed', { status: 503 }), /HTTP 503/],
    [() => new Response(new ReadableStream({ start(controller) { controller.enqueue(BYTES.subarray(0, 4)); controller.error(new Error('fixture disconnected')) } })), /disconnected/]
  ]
  for (const [receive, expected] of cases) {
    const dir = directory(t)
    await assert.rejects(update.downloadCliUpdate(dir, '7.0.0', fixture(release(), receive)), expected)
    assert.deepEqual(fs.readdirSync(dir), [])
  }
  const controller = new AbortController(), dir = directory(t)
  const f = fixture(release(), () => { controller.abort(new Error('fixture cancelled')); return new Response(BYTES) })
  await assert.rejects(update.downloadCliUpdate(dir, VERSION, { request: f.request, signal: controller.signal }), /cancelled/)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('existing files, dangling links and destination races cannot replace user content', async t => {
  const dir = directory(t), target = path.join(dir, NAME)
  fs.writeFileSync(target, 'my original file')
  const f = fixture()
  await assert.rejects(update.downloadCliUpdate(dir, VERSION, f), /拒绝覆盖/)
  assert.equal(f.calls.length, 1)
  assert.equal(fs.readFileSync(target, 'utf8'), 'my original file')
  fs.unlinkSync(target)
  const race = fixture(release(), () => { fs.writeFileSync(target, 'created during network request'); return new Response(BYTES) })
  await assert.rejects(update.downloadCliUpdate(dir, VERSION, race), /拒绝覆盖/)
  assert.deepEqual(fs.readdirSync(dir), [NAME])
  assert.equal(fs.readFileSync(target, 'utf8'), 'created during network request')
  fs.unlinkSync(target)
  fs.symlinkSync(path.join(dir, 'absent-directory'), target, 'junction')
  await assert.rejects(update.downloadCliUpdate(dir, VERSION, fixture()), /拒绝覆盖/)
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true)
})

test('missing, file and junction destinations reject before the first network request', async t => {
  const dir = directory(t), outside = directory(t), f = fixture()
  const file = path.join(dir, 'file'); fs.writeFileSync(file, 'original')
  const link = path.join(dir, 'linked'); fs.symlinkSync(outside, link, 'junction')
  for (const destination of [file, path.join(dir, 'missing'), link, path.join(link, 'missing')]) {
    await assert.rejects(update.downloadCliUpdate(destination, VERSION, f), /目录/)
  }
  assert.deepEqual(f.calls, [])
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('real CLI check is credential/config independent, current/no-asset guidance and errors stay scriptable', t => {
  const dir = directory(t)
  fs.mkdirSync(path.join(dir, '.deepwriter-cli'))
  fs.writeFileSync(path.join(dir, '.deepwriter-cli/config.json'), 'broken profile that must not be read')
  const preload = path.join(dir, 'fetch-fixture.cjs')
  const log = path.join(dir, 'network.log')
  const call = (args, data = release(), status = 200) => {
    fs.writeFileSync(preload, `global.fetch=async(url,options)=>{require('node:fs').appendFileSync(${JSON.stringify(log)},String(url)+'\\n');if(url===${JSON.stringify(URL)})return new Response(Buffer.from('${BYTES.toString('base64')}','base64'));if(url!==${JSON.stringify(API)})throw Error('unexpected network');return new Response(${JSON.stringify(JSON.stringify(data))},{status:${status}})}\n`)
    return spawnSync(process.execPath, ['--require', preload, cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, DEEPWRITER_API_KEY: '', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' } })
  }
  const check = call(['update', 'check', '--json'])
  assert.equal(check.status, 0, check.stderr)
  const envelope = JSON.parse(check.stdout)
  assert.equal(envelope.type, 'update')
  assert.equal(envelope.data.updateAvailable, false)
  assert.match(envelope.data.instruction, /新目录/)
  const noAsset = call(['update', 'check'], { ...release(), assets: [] })
  assert.equal(noAsset.status, 0, noAsset.stderr)
  assert.match(noAsset.stdout, /尚未发布独立 CLI 包/)
  assert.match(noAsset.stdout, /当前无需升级/)
  const unavailable = call(['update', 'download', dir, '--json'], { ...release(), assets: [] })
  assert.equal(unavailable.status, 0, unavailable.stderr)
  assert.equal(JSON.parse(unavailable.stdout).data.status, 'unavailable')
  const downloaded = call(['update', 'download', dir, '--json'])
  assert.equal(downloaded.status, 0, downloaded.stdout + downloaded.stderr)
  const download = JSON.parse(downloaded.stdout).data
  assert.equal(download.status, 'downloaded')
  assert.equal(download.sha256, sha(BYTES))
  assert.deepEqual(fs.readFileSync(download.path), BYTES)
  assert.match(download.instruction, /不会安装或运行/)
  const failed = call(['update', 'check', '--json'], release(), 503)
  assert.equal(failed.status, 1)
  assert.equal(JSON.parse(failed.stdout).type, 'error')
  const before = fs.readFileSync(log, 'utf8')
  for (const args of [['--version'], ['--help'], ['update', 'check', 'extra', '--json'], ['update', 'check', '--config', 'ignored.json', '--json'], ['update', 'download', '--json']]) {
    const result = call(args)
    assert.equal(result.status, args[0].startsWith('--') ? 0 : 1, result.stdout + result.stderr)
  }
  assert.equal(fs.readFileSync(log, 'utf8'), before, 'ordinary commands and invalid update calls never access the network')
  assert.equal(fs.readFileSync(path.join(dir, '.deepwriter-cli/config.json'), 'utf8'), 'broken profile that must not be read')
})
