'use strict'
// Exercise the shipped app with an isolated profile and a copy of the included
// example. Only directory-picker answers and the explicit trust click are supplied.
const { _electron, expect } = require('@playwright/test')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')

async function main() {
  const [binary, sdk] = process.argv.slice(2)
  if (!binary || !sdk) throw new Error('Usage: node scripts/packaged-studio-smoke.cjs <DeepWriter.exe> <SDK directory>')
  const base = await fs.realpath(path.resolve('out'))
  const folder = await fs.mkdtemp(path.join(base, 'studio-package-'))
  const project = path.join(folder, 'last-ferry'), profile = path.join(folder, 'profile')
  await fs.cp(path.resolve('examples/last-ferry'), project, { recursive: true })
  await fs.mkdir(profile)
  const app = await _electron.launch({ executablePath:path.resolve(binary), args:[], env:{ ...process.env, NODE_ENV:'production', DW_TEST_USERDATA:profile, RENPY_PATH_TO_SAVES:path.join(folder,'saves'), RENPY_DISABLE_SOUND:'1' }, timeout:30000 })
  try {
    const pkg = await app.evaluate(({ app }) => ({ version:app.getVersion(), packaged:app.isPackaged }))
    assert.equal(pkg.packaged,true); assert.equal(pkg.version,require('../package.json').version)
    await app.evaluate(({dialog}, dirs) => {
      const queue = dirs.slice()
      dialog.showOpenDialog = async () => {
        const next = queue.shift(); if (!next) throw new Error('Unexpected extra directory picker')
        return {canceled:false,filePaths:[next]}
      }
      dialog.showMessageBox = async (...args) => {
        const o = args.at(-1)
        if (o.title !== '运行此 Galgame 项目？' || !o.detail.includes(dirs[0])) return {response:o.cancelId ?? 0}
        const at=o.buttons.indexOf('信任此项目并运行'); if (at < 0) throw new Error('Missing user trust choice')
        return {response:at,checkboxChecked:false}
      }
    },[project,path.resolve(sdk)])
    const page = await app.firstWindow()
    await page.getByText('创作工具',{exact:true}).click()
    await page.getByRole('button',{name:'Galgame',exact:true}).click()
    await page.getByRole('button',{name:'导入现有项目',exact:true}).click()
    await page.getByRole('button',{name:'选择 SDK 目录'}).click()
    const play = page.getByRole('button',{name:'试玩原项目',exact:true})
    await expect(play).toBeEnabled({timeout:25000})
    await play.click()
    const stop=page.getByRole('button',{name:'停止试玩',exact:true});await expect(stop).toBeEnabled({timeout:35000})
    await stop.click();await expect(play).toBeEnabled({timeout:15000})
    assert.equal(await fs.readFile(path.join(project,'game','script.rpy'),'utf8'),await fs.readFile('examples/last-ferry/game/script.rpy','utf8'))
    console.log('PASS packaged '+pkg.version+': import → SDK → trust → play original → stop; original script unchanged')
  } finally { await app.close() }
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
