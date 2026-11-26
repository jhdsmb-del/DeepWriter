import { build } from 'esbuild'
import { readFileSync, existsSync, writeFileSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const sourceRequire = createRequire(path.join(root, 'package.json'))
function sourceModule(file) {
  const absolute = path.resolve(file)
  const relative = path.relative(root, absolute).replaceAll('\\', '/')
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('CLI source boundary')
  let current = absolute
  while (true) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('CLI source boundary: linked resource')
    if (current.toLowerCase() === root.toLowerCase()) break
    current = path.dirname(current)
  }
  if (!lstatSync(absolute).isFile()) throw new Error('CLI source boundary: regular file required')
  return { path: relative, namespace: 'cli-source' }
}
export async function buildCli({ outfile = path.join(root, 'out/cli/deepwriter.cjs'), write = true, metafile = true, version = packageVersion } = {}) {
return build({
  absWorkingDir: root, entryPoints: [path.join(root, 'src/cli/main.ts')], outfile,
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', tsconfigRaw: {},
  define: { __DEEPWRITER_VERSION__: JSON.stringify(version) },
  metafile, write,
  plugins: [{
    name: 'cli-node-platform',
    setup(builder) {
      builder.onResolve({ filter: /^diff$/ }, () => sourceModule(sourceRequire.resolve('diff')))
      builder.onResolve({ filter: /^\.\/pdfText$/ }, args => args.resolveDir === path.join(root, 'src/main') ? sourceModule(path.join(root, 'src/cli/pdfTextUnavailable.ts')) : undefined)
      // These lazy optional modules are not CLI capabilities. Alias to a real
      // audited source that fails explicitly, rather than unresolved npm code.
      builder.onResolve({ filter: /^(fflate|sql\.js|docx|exceljs|pdfkit)$/ }, () => sourceModule(path.join(root, 'src/cli/unsupported-exporters.ts')))
      // DOCX uses the same registered Mammoth importer as desktop. Resolve its
      // static dependency closure inside the audited source boundary instead
      // of leaving runtime node_modules or untracked loaders in the bundle.
      builder.onResolve({ filter: /^[^./\\][^:]*$/ }, (args) => {
        if (args.path === 'electron') return sourceModule(path.join(root, 'src/cli/host.ts'))
        if (isBuiltin(args.path)) return { path: args.path, external: true }
        const resolver = createRequire(path.join(args.resolveDir || root, '__cli_resolve__.cjs'))
        return sourceModule(resolver.resolve(args.path))
      })
      builder.onResolve({ filter: /^(electron|\.\.?\/|[A-Za-z]:[\\/]|\/)/ }, (args) => {
        const target = args.path === 'electron' ? path.join(root, 'src/cli/host.ts') : path.resolve(args.resolveDir || root, args.path)
        const found = ['', '.ts', '.tsx', '.js', '.json', '/index.ts', '/index.js'].map((extension) => target + extension).find(file => existsSync(file) && lstatSync(file).isFile())
        if (!found) throw new Error(`CLI source boundary: ${args.path}`)
        return sourceModule(found)
      })
      builder.onLoad({ filter: /.*/, namespace: 'cli-source' }, (args) => {
        const file = path.resolve(root, args.path)
        if (sourceModule(file).path !== args.path) throw new Error('CLI source boundary: noncanonical module path')
        return { contents: readFileSync(file, 'utf8'), loader: file.endsWith('.json') ? 'json' : file.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: path.dirname(file) }
      })
    }
  }]
})
}
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
if (process.argv[1] && samePath(realpathSync(process.argv[1]), realpathSync(fileURLToPath(import.meta.url)))) {
  const outfile = process.argv.find((value) => value.startsWith('--outfile='))?.slice(10) ?? path.join(root, 'out/cli/deepwriter.cjs')
  const metafile = process.argv.find((value) => value.startsWith('--metafile='))?.slice(11) ?? outfile + '.meta.json'
  const result = await buildCli({ outfile })
  writeFileSync(metafile, JSON.stringify(result.metafile, null, 2) + '\n')
  console.log(`DeepWriter CLI ${packageVersion}: ${outfile}`)
}
