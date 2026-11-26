'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { signingConfiguration } = require('./windows-signing.cjs')
const { stageNativeNotices } = require('./native-notice-resources.cjs')
const { stagePackageNotices } = require('./package-notice-resources.cjs')

try {
  const configuration = signingConfiguration(require('../package.json').build)
  stageNativeNotices()
  stagePackageNotices()
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-windows-build-'))
  try {
    const file = path.join(temporary, 'builder.json')
    fs.writeFileSync(file, JSON.stringify(configuration), { mode: 0o600 })
    const cli = require.resolve('electron-builder/out/cli/cli.js')
    const result = spawnSync(process.execPath, [cli, '--win', '--config', file, ...process.argv.slice(2)], { stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status || (result.signal ? 1 : 0)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
} catch (error) { console.error(error.message); process.exitCode = 1 }
