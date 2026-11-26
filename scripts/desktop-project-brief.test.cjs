const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { _electron } = require('@playwright/test')

test('桌面在明确的工作目录编辑写作约定，保存、取消和外部修改各不混淆', async () => {
  const root = path.resolve(__dirname, '..')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-brief-ui-'))
  const book = path.join(home, '河岸'); await fs.mkdir(book)
  const file = path.join(book, 'DEEPWRITER.md')
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: book, docDir: book }))
  let app
  try {
    app = await _electron.launch({ args: [root, '--user-data-dir='+home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
    const page = await app.firstWindow(); page.setDefaultTimeout(10000)
    const open = async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('button', { name: '项目约定', exact: true }).click()
      return page.getByLabel('写给这个项目的要求')
    }
    const save = page.getByRole('button', { name: '保存并关闭', exact: true })
    let box = await open(); await box.fill('只写小禾看见的事。她不知道那封信是谁寄的。')
    await save.click(); await box.waitFor({ state: 'hidden' })
    assert.equal(await fs.readFile(file, 'utf8'), '只写小禾看见的事。她不知道那封信是谁寄的。')
    box = await open(); await box.fill('取消的内容')
    await page.getByRole('button', { name: '取消', exact: true }).last().click(); await box.waitFor({ state: 'hidden' })
    box = await open(); assert.ok((await box.inputValue()).includes('小禾'))
    if (process.env.DW_BRIEF_SCREENSHOT) await page.screenshot({ path: process.env.DW_BRIEF_SCREENSHOT, animations: 'disabled', scale: 'css' })
    await box.fill('仍在编辑的副本'); await fs.writeFile(file, '她知道寄信人了。')
    await save.click(); await page.getByRole('alert').filter({ hasText: '已在别处修改' }).waitFor()
    assert.equal(await fs.readFile(file, 'utf8'), '她知道寄信人了。')
    await page.getByRole('button', { name: '重新载入' }).click()
    await page.waitForFunction(() => document.querySelector('#dw-project-brief')?.value === '她知道寄信人了。')
  } finally {
    if (app) await app.close()
    if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-brief-ui-')) await fs.rm(home, { recursive: true, force: true })
  }
})
