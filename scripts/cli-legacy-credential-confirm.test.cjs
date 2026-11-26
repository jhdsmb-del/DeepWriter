const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const built = buildSync({ stdin: { contents: `export {resolveFrozenCliSecret} from './src/cli/runtime'; export {credentialFingerprint} from './src/cli/config'`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
const { resolveFrozenCliSecret, credentialFingerprint } = loaded.exports

test('only unscoped old foreign default environment credentials require confirmation of the original origin and fingerprint', () => {
  // This test process uses only synthetic values; no network, engine.step or
  // inherited credential is read to exercise these recovery branches.
  const key = 'synthetic-original-key', foreign = 'https://legacy-compatible.invalid', official = 'https://api.deepseek.com'
  const customName = 'DW_LEGACY_CONFIRM_SYNTHETIC'
  process.env.DEEPWRITER_API_KEY = key; process.env[customName] = key
  const frozen = (baseUrl, keyEnv = 'DEEPWRITER_API_KEY', fields = {}) => ({ config: { baseUrl, keyEnv, ...fields }, fingerprint: credentialFingerprint(key, baseUrl, fields.authHeaderName) })
  const current = { baseUrl: foreign }
  try {
    const unknown = frozen(foreign)
    assert.throws(() => resolveFrozenCliSecret(unknown, current, {}, ''), /--key-env DEEPWRITER_API_KEY/)
    assert.throws(() => resolveFrozenCliSecret(unknown, current, { 'key-env': customName }, ''), /--key-env DEEPWRITER_API_KEY/)
    assert.throws(() => resolveFrozenCliSecret(unknown, { baseUrl: 'https://different.invalid' }, { 'key-env': 'DEEPWRITER_API_KEY' }, ''), /核对原服务/)
    assert.equal(resolveFrozenCliSecret(unknown, current, { 'key-env': 'DEEPWRITER_API_KEY' }, ''), key)
    process.env.DEEPWRITER_API_KEY = 'synthetic-changed-key'
    assert.throws(() => resolveFrozenCliSecret(unknown, current, { 'key-env': 'DEEPWRITER_API_KEY' }, ''), /凭据缺失或已更换/)
    process.env.DEEPWRITER_API_KEY = key
    assert.equal(resolveFrozenCliSecret(frozen(official), { baseUrl: official }, {}, ''), key)
    assert.equal(resolveFrozenCliSecret(frozen(foreign, customName), current, {}, ''), key)
    assert.equal(resolveFrozenCliSecret(frozen(foreign, 'DEEPWRITER_API_KEY', { keyEnvOrigin: foreign }), current, {}, ''), key)
    assert.equal(resolveFrozenCliSecret({ ...unknown, explicitConfigPath: path.join(root, 'synthetic-config.json') }, current, {}, key), key)
  } finally { delete process.env.DEEPWRITER_API_KEY; delete process.env[customName] }
})
