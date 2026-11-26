'use strict'
// Public model specifications; no credentials, prices, or provider calls.
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
async function main() {
  const result = await esbuild.build({ absWorkingDir: root, entryPoints: ['src/shared/modelCatalog.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const module = { exports: {} }
  new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports)
  const response = await fetch(module.exports.MODEL_CATALOG_URL, { signal: AbortSignal.timeout(20000), redirect: 'error' })
  if (!response.ok) throw new Error('公开模型规格下载失败')
  const raw = await response.text()
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('公开规格目录过大')
  const catalog = module.exports.normalizeModelCatalog(JSON.parse(raw))
  fs.writeFileSync(path.join(root, 'src/shared/modelCatalog.generated.json'), JSON.stringify(catalog))
  console.log(`Model catalog: ${catalog.models.length} text-capable provider/model records; source=${catalog.sourceUrl}; date=${catalog.fetchedAt}`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
