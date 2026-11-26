import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopSourceExternals } from './desktop-source-boundary.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'scripts/agent-foundation.ts')
await build({
  absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  outfile: path.join(root, 'out/agent-foundation.mjs'),
  external: desktopSourceExternals(entry),
  alias: { electron: path.join(root, 'scripts/electron-test-shim.ts') }
})
