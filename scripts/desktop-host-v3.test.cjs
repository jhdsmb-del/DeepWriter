const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, readFile, writeFile, readdir, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { buildSync } = require('esbuild')
const api = { exports: {} }
new Function('require', 'module', 'exports', buildSync({
  stdin: { contents: "export * from './src/main/manuscriptDelivery'; export * from './src/main/desktopSettingsFile'; export * from './src/shared/settingsSchema'; export * from './src/shared/agentToolPolicy'", resolveDir: path.join(__dirname, '..') },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text)(require, api, api.exports)
const { deliverManuscript, SessionCredential, writeSettingsDocument, findSettingsSource, settingsSetSchema } = api.exports
const inTemp = async run => { const root = await mkdtemp(path.join(tmpdir(), 'dw-host-')); try { await run(root) } finally { await rm(root, { force: true, recursive: true }) } }
const hash = s => createHash('sha256').update(s).digest('hex')
for (const host of ['desktop', 'terminal']) test(host + ': two runs cannot replace a manuscript, retry reuses identical bytes', () => inTemp(async dir => {
  const runId = '12345678-private-run'
  const make = content => ({ runId, config: { docDir: dir, grillMe: { approvedOutline: { title: '海上的灯' } } }, content, contentHash: hash(content) })
  const entries = [make('第一份。'), make('第二份。')]
  const settled = await Promise.allSettled(entries.map(input => deliverManuscript(input, host)))
  assert.equal(settled.filter(r => r.status === 'fulfilled').length, 1)
  assert.match(settled.find(r => r.status === 'rejected').reason.message, /拒绝覆盖/)
  const i = settled.findIndex(r => r.status === 'fulfilled')
  const { relativePath, displayName } = settled[i].value
  assert.equal(displayName, '海上的灯-' + (host === 'desktop' ? runId.slice(0, 8) : hash(runId).slice(0, 12)) + '.md')
  assert.equal(await readFile(relativePath, 'utf8'), entries[i].content)
  assert.deepEqual(await deliverManuscript(entries[i], host), settled[i].value)
  await writeFile(relativePath, '改过的。')
  await assert.rejects(deliverManuscript(entries[i], host), /拒绝覆盖/)
  const stale = { ...entries[i], content: '换内容但沿用旧交付哈希。' }
  await assert.rejects(deliverManuscript(stale, host), /交付哈希/)
  assert.deepEqual(await readdir(dir), [displayName])
}))
test('settings recovery will not rotate corruption or a plaintext legacy key into the recovery file', () => inTemp(async dir => {
  const file = path.join(dir, 'settings.json')
  const read = p => readFile(p, 'utf8')
  await writeFile(file, JSON.stringify({ apiKey: 'fixture-only', model: 'legacy' }))
  await writeSettingsDocument(file, { model: 'new' })
  assert.deepEqual(JSON.parse(await read(file+'.bak')), { model: 'legacy' })
  await writeFile(file, '{')
  assert.equal(JSON.parse(await findSettingsSource(file, read)).model, 'legacy')
  await writeSettingsDocument(file, { model: 'saved' })
  assert.equal(JSON.parse(await read(file+'.bak')).model, 'legacy')
  const locked = { baseUrl: 'https://example.invalid', apiKeyEnc: 'synthetic', apiKeyStorage: 'safeStorage' }
  await writeSettingsDocument(file, locked)
  await writeSettingsDocument(file, { baseUrl: locked.baseUrl, apiKeyStorage: 'none', temperature: 0.4 }, true)
  assert.equal(JSON.parse(await read(file)).apiKeyEnc, 'synthetic')
  await writeSettingsDocument(file, { baseUrl: locked.baseUrl, apiKeyStorage: 'none' }, false)
  assert.equal(JSON.parse(await read(file)).apiKeyEnc, undefined)
}))
test('session-only key survives a settings read, not a rotation, new origin or restart', () => {
  const session = new SessionCredential(), url = 'https://host.invalid'
  const issued = session.prepare(url, 'synthetic-A')
  assert.equal(session.resolve(url, issued.ref), '')
  issued.commit()
  assert.equal(session.resolve(url, issued.ref), 'synthetic-A')
  assert.equal(session.resolve(url+'/other', issued.ref), '')
  const next = session.prepare(url, 'synthetic-B')
  assert.equal(session.resolve(url, issued.ref), 'synthetic-A')
  next.commit()
  assert.equal(session.resolve(url, issued.ref), '')
  assert.equal(new SessionCredential().resolve(url, next.ref), '')
  session.clear(); assert.equal(session.resolve(url, next.ref), '')
})
test('legacy settings apply one contract to whole and patch; nested Galgame options retain shape', () => {
  const whole = { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', apiKey: '' }
  for (const [key, value, ok] of [['docDir',' ',false], ['completionWallClockMs',86400001,false], ['galgame',{enabled:true},true], ['galgame',{ sdkPath: 7 },false], ['reasoningEffort','high',true]]) {
    assert.equal(settingsSetSchema.safeParse({ kind: 'patch', key, value }).success, ok)
    assert.equal(settingsSetSchema.safeParse({ kind: 'whole', settings: {...whole, [key]:value} }).success, ok)
  }
})

test('only new general Agent runs explicitly acquire network tools; old wildcards remain local', () => {
  const { freezeAgentTools, toolAllowed, WEB_TOOL_NAMES } = api.exports
  for (const name of WEB_TOOL_NAMES) {
    assert.ok(toolAllowed(name, freezeAgentTools(true, true, ['search', 'fetch'])))
    assert.ok(toolAllowed(name, freezeAgentTools(false, true, ['search', 'fetch'])))
    assert.equal(toolAllowed(name, freezeAgentTools(true, true)), false, 'a switch alone cannot grant provider services')
    assert.equal(toolAllowed(name, freezeAgentTools(true, false)), false)
    assert.equal(toolAllowed(name, ['*']), false)
    assert.equal(toolAllowed(name, undefined), false)
  }
  assert.equal(toolAllowed('read_file', freezeAgentTools(false, true)), false)
  assert.ok(toolAllowed('read_file', ['*']))
})
