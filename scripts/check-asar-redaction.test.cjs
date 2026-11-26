'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { finished } = require('node:stream/promises')
const { test } = require('node:test')
const asar = require('@electron/asar')
const esbuild = require('esbuild')

test('actual ASAR failure logs do not disclose synthetic credentials, including filenames', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-asar-redaction-'))
  // Only synthetic values are used. Assertions never echo them on failure.
  const key = `sk-${'SyntheticScannerFixture1234'.repeat(3)}`
  const encrypted = 'synthetic-encrypted-fixture-must-not-be-logged'
  try {
    const input = path.join(temporary, 'input')
    const output = path.join(temporary, 'artifact', 'resources')
    fs.mkdirSync(input, { recursive: true })
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(input, `${key}.txt`), JSON.stringify({ apiKeyEnc: encrypted, note: key, path: 'C:/Users/synthetic/fixture' }))
    fs.writeFileSync(path.join(input, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', apiKeyEnc: encrypted }))
    const writer = await asar.createPackage(input, path.join(output, 'app.asar'))
    if (writer?.once) await finished(writer)
    const executable = path.join(temporary, 'check-asar.mjs')
    const source = fs.readFileSync(path.join(__dirname, 'check-asar.ts'), 'utf8')
    fs.writeFileSync(executable, esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'node22' }).code)
    const result = spawnSync(process.execPath, [executable, '--dir', path.join(temporary, 'artifact')], {
      encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules') }, timeout: 30_000
    })
    assert.equal(result.error, undefined, 'Scanner should start normally')
    assert.equal(result.status, 1, 'Synthetic credentials must still fail the artifact check')
    const log = result.stdout + result.stderr
    assert.equal(log.includes(key), false, 'Scanner must not disclose a synthetic API key')
    assert.equal(log.includes(encrypted), false, 'Scanner must not disclose an encrypted credential')
    assert.equal(/api-key-plain|API key 明文/.test(log), true, 'Log should retain the failed check category')
    assert.equal(/api-key-enc-value|apiKeyEnc 非空值/.test(log), true, 'Log should retain the encrypted credential category')
    assert.equal(log.includes('[REDACTED'), true, 'Log should explain that sensitive diagnostics were redacted')
    const selftest = spawnSync(process.execPath, [executable, '--selftest'], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(selftest.status, 0, 'All existing scanner false-positive and true-positive selftests must remain green')
    assert.match(selftest.stdout, /SELFTEST: (\d+)\/\1 通过/)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
