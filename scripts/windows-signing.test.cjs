'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { signingConfiguration } = require('./windows-signing.cjs')
const base = { win: { target: ['nsis', 'portable'] }, nsis: { deleteAppDataOnUninstall: false } }
const azure = { DW_SIGNING_MODE: 'azure', DW_SIGNING_PUBLISHER: 'Fixture Publisher', DW_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net/', DW_SIGNING_ACCOUNT: 'fixture-account', DW_SIGNING_PROFILE: 'fixture-profile', AZURE_TENANT_ID: 'fixture-tenant', AZURE_CLIENT_ID: 'fixture-client', AZURE_CLIENT_SECRET: 'fixture-secret' }

test('official tags allow truthful unsigned builds by default', () => {
  for (const env of [{ GITHUB_REF: 'refs/tags/v1.3.0' }, { GITHUB_REF: 'refs/tags/v1.3.0', DW_SIGNING_MODE: 'unsigned' }]) assert.equal(signingConfiguration(base, env).forceCodeSigning, false)
  assert.equal(signingConfiguration(base, { GITHUB_REF: 'refs/heads/release/v1.3.0' }).forceCodeSigning, false)
})
test('explicit signing requirements still reject every unsigned fallback', () => {
  for (const env of [{ DW_REQUIRE_SIGNING: '1' }, { GITHUB_REF: 'refs/tags/v1.3.0', DW_REQUIRE_SIGNING: '1', DW_SIGNING_MODE: 'unsigned' }]) assert.throws(() => signingConfiguration(base, env), /requires trusted Windows code signing/)
})
test('Azure signing requires complete authentication, pins SHA-256 and preserves installation behavior', () => {
  const config = signingConfiguration(base, azure)
  assert.equal(config.forceCodeSigning, true)
  assert.equal(config.win.azureSignOptions.timestampDigest, 'SHA256')
  assert.equal(config.nsis.deleteAppDataOnUninstall, false)
  assert.equal(config.win.signtoolOptions, undefined)
  assert.equal(JSON.stringify(config).includes(azure.AZURE_CLIENT_SECRET), false)
  for (const key of Object.keys(azure).filter((name) => name !== 'DW_SIGNING_MODE')) assert.throws(() => signingConfiguration(base, { ...azure, [key]: '' }), /requires/)
})
test('certificate credentials stay outside generated config and missing credentials fail', () => {
  const env = { DW_SIGNING_MODE: 'certificate', DW_SIGNING_PUBLISHER: 'Fixture Publisher', WIN_CSC_LINK: 'fixture-private-certificate', WIN_CSC_KEY_PASSWORD: 'fixture-password' }
  const config = signingConfiguration(base, env)
  assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, ['sha256'])
  assert.equal(JSON.stringify(config).includes(env.WIN_CSC_LINK), false)
  assert.equal(JSON.stringify(config).includes(env.WIN_CSC_KEY_PASSWORD), false)
  assert.throws(() => signingConfiguration(base, { ...env, WIN_CSC_KEY_PASSWORD: '' }), /requires/)
})
test('unknown backends and credential-bearing or foreign Azure endpoints are rejected', () => {
  assert.throws(() => signingConfiguration(base, { DW_SIGNING_MODE: 'other', DW_SIGNING_PUBLISHER: 'Fixture' }), /Unknown/)
  for (const endpoint of ['http://weu.codesigning.azure.net/', 'https://untrusted.invalid/', 'https://user:password@weu.codesigning.azure.net/', 'https://weu.codesigning.azure.net/?token=x']) assert.throws(() => signingConfiguration(base, { ...azure, DW_SIGNING_ENDPOINT: endpoint }), /Invalid/)
})
