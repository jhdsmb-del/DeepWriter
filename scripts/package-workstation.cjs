'use strict'
// Windows workstation build: use the same builders, runtime inventory and
// receipt readers used by the release pipeline, not a second packaging format.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildCliArtifact } = require('./build-cli.cjs')
const { NODE_VERSION, packageCli, sourceState } = require('./package-cli.cjs')
const { packageDesktopCli } = require('./package-desktop-cli.cjs')

async function main() {
  const root = fs.realpathSync(path.resolve(__dirname, '..'))
  const version = require('../package.json').version
  const argv = process.argv.slice(2)
  if (argv.length && !(argv.length === 2 && argv[0] === '--node-runtime')) throw new Error('用法：npm run package:windows -- [--node-runtime 目录]')
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此命令在 Windows x64 上运行')
  const state = sourceState(root)
  if (state.sourceDirty) throw new Error('请先提交用于交付的改动，使桌面、CLI 和指南来自同一个提交')
  const runtime = path.resolve(root, argv[1] || 'out/runtime-node-' + NODE_VERSION)
  for (const file of ['node.exe', 'LICENSE', 'LICENSE.source.json']) fs.accessSync(path.join(runtime, file))
  const stem = path.join('out', 'delivery', 'v' + version + '-' + state.sourceCommit.slice(0, 8))
  let base = stem
  for (let n = 2; fs.existsSync(path.join(root, base)); ++n) base = stem + '-' + n
  const build = path.join(base, 'cli-build'), cli = path.join(base, 'cli'), desktop = path.join(base, 'desktop')
  const npm = process.env.npm_execpath
  if (!npm) throw new Error('请通过 npm run package:windows 运行')
  await buildCliArtifact({ root, output: build, version, sourceCommit: state.sourceCommit })
  const packed = await packageCli({ root, output: cli, version, sourceCommit: state.sourceCommit, bundle: path.join(build, 'deepwriter.cjs'),
    metafile: path.join(build,'cli-metafile.json'), nodeExe: path.join(runtime,'node.exe'), nodeLicense: path.join(runtime,'LICENSE') })
  if (!packed.complete) throw new Error('CLI 运行时清单不完整：' + packed.inventory.reviewNeeded.map(gap => gap.code + ':' + gap.subject).join(', '))
  execFileSync(process.execPath, [npm, 'run', 'dist', '--', '--x64', '--publish', 'never',
    '--config.directories.output=' + desktop.replaceAll('\\','/'), '--config.electronDist=node_modules/electron/dist'], { cwd: root, stdio: 'inherit' })
  execFileSync(process.execPath, [npm, 'run', 'release:asar', '--', '--dir=' + desktop], { cwd: root, stdio: 'inherit' })
  const after = sourceState(root)
  if (after.sourceCommit !== state.sourceCommit || after.sourceDirty) throw new Error('构建过程中源码发生了变化；不合并两个版本的制品')
  const result = await packageDesktopCli({ desktopDir: desktop, cliDir: cli, output: path.join(base, 'DeepWriter-' + version + '-complete.zip') })
  console.log('DeepWriter ' + version + ' 完整包：' + result.output)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
