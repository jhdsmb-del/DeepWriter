const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const esbuild = require('esbuild')
const source = fs.readFileSync(path.join(__dirname, 'electron-shutdown.ts'), 'utf8')
const match = /export function verifiedMainWindowUrl\(raw: string\): boolean \{[\s\S]*?^}/m.exec(source)
assert.ok(match)
const code = esbuild.transformSync(match[0], { loader: 'ts', format: 'cjs' }).code
const moduleObject = { exports: {} }
new Function('module', 'exports', code)(moduleObject, moduleObject.exports)
const accepts = moduleObject.exports.verifiedMainWindowUrl
test('real shutdown selector never treats loading/blank/floating windows as main', () => {
  for (const value of ['', 'about:blank', 'file:///fixture/index.html?window=float', 'file:///fixture/index.html?window=other', 'file:///fixture/float.html', 'https://example.com/index.html', 'invalid']) assert.equal(accepts(value), false, value)
  assert.equal(accepts('file:///C:/fixture/out/renderer/index.html'), true)
  assert.equal(accepts('file:///C:/fixture/app.asar/out/renderer/index.html'), true)
})
