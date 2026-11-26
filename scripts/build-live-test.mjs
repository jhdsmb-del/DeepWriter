import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// 构建 scripts/live-test.ts（带 electron shim，供真实 API 冒烟测试）
// 用法：node scripts/build-live-test.mjs && DEEPSEEK_API_KEY=xxx node out/live-test.mjs
const esbuild = require('esbuild')
const path = require('path')

const ELECTRON_SHIM = {
  name: 'electron-shim',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'shim' }))
    build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
      contents: 'export const app = { getPath: (n) => String(n), isPackaged: false };\nexport const dialog = { showMessageBox: async () => ({ response: 1 }) };',
      loader: 'js'
    }))
  }
}

esbuild
  .build({
    entryPoints: [path.resolve(__dirname, 'live-test.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: path.resolve(__dirname, '..', 'out', 'live-test.mjs'),
    external: desktopSourceExternals(path.resolve(__dirname, 'live-test.ts'), ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate']),
    logLevel: 'silent',
    plugins: [ELECTRON_SHIM]
  })
  .then(() => console.log('built out/live-test.mjs（真实 API 冒烟，需 DEEPSEEK_API_KEY）'))
  .catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
