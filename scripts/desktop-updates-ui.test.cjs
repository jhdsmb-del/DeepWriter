'use strict'
// Real desktop render/bridge check. Ready-state delivery is synthetic here;
// the isolated NSIS A/B rehearsal covers the real download/install transition.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { _electron, expect } = require('@playwright/test')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
const root = path.resolve(__dirname, '..')

test('updates settings, persistent preference, discoverable ready action and deliberate cancellation fit the desktop', { timeout: 45000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-updates-ui-'))
  const app = await _electron.launch({ args: [root], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(8000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '应用更新', exact: true }).click()
    await expect(page.getByRole('heading', { name: '应用更新', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeDisabled()
    assert.equal((await page.evaluate(() => window.ds.updatesCheck())).installKind, 'development')
    await page.evaluate(() => window.ds.updatesPreference(false))
    assert.equal((await page.evaluate(() => window.ds.getSettings())).autoCheckUpdates, false)
    assert.equal(JSON.parse(await fs.readFile(path.join(home, 'settings.json'), 'utf8')).autoCheckUpdates, false)
    const ready = { ...(await page.evaluate(() => window.ds.updatesGet())), installKind: 'nsis', currentVersion: '8.0.0', phase: 'ready', version: '8.1.0', progress: 100, message: '8.1.0 已下载。完成写作后，可重启并安装。' }
    await app.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('updates:state', state), ready)
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.getByRole('button', { name: '有可用更新', exact: true }).click()
    await expect(page.getByRole('heading', { name: '应用更新', exact: true })).toBeVisible()
    await app.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('updates:state', state), ready)
    await page.getByRole('button', { name: '重启并安装…', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认重启并安装', exact: true })).toBeVisible()
    await page.screenshot({ path: path.join(root, 'out/updates-ui-ready-final.png') })
    await page.getByRole('button', { name: '继续写作', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认重启并安装', exact: true })).toHaveCount(0)
    assert.equal((await page.evaluate(() => window.ds.updatesGet())).phase, 'idle', 'cancelling a synthetic ready prompt does not invoke restart')
    await page.setViewportSize({ width: 800, height: 640 })
    await page.getByRole('button', { name: '重启并安装…', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认重启并安装', exact: true })).toBeInViewport()
    const box = await page.getByRole('dialog').boundingBox()
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 801 && box.y + box.height <= 641)
    await page.screenshot({ path: path.join(root, 'out/updates-ui-800-final.png') })
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close()
  }
})
