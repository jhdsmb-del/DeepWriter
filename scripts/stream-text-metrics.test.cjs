const {test} = require('node:test')
const assert = require('node:assert/strict')
const ts = require('esbuild').buildSync({entryPoints: [require.resolve('../src/shared/textMetrics.ts')], bundle:true, platform:'node', format:'cjs', write:false})
const m = {exports:{}}; new Function('module', 'exports', ts.outputFiles[0].text)(m, m.exports)
const {codePointLength, takeCodePoints} = m.exports
test('streamed character counts and prefixes preserve complete and isolated UTF-16 surrogates', () => {
  for (const s of ['', '中文abc', '🌾𠮷e\u0301', '\ud800中🌾\udc00', 'a'.repeat(1023) + '🌙结束']) {
    const points = Array.from(s)
    assert.equal(codePointLength(s), points.length)
    for (const n of [-1, 0, 0.5, 1, 2, 2.7, 3, 4, 1023, 1024, 1025, Infinity]) {
      assert.equal(takeCodePoints(s, n), points.slice(0, Math.max(0,n)).join(''))
    }
  }
})
