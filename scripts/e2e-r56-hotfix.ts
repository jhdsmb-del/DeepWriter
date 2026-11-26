import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`)
  passed += 1
  console.log(`  PASS  ${name}`)
}

async function closeApp(app: ElectronApplication): Promise<void> {
  const main = app.windows().find((page) => !page.url().includes('window=float'))
  await main?.evaluate(async () => (window as any).ds?.testShutdown?.()).catch(() => undefined)
  await app.close().catch(() => undefined)
}

async function main(): Promise<void> {
  const sdk = process.env.DW_RENPY_SDK
  if (!sdk) throw new Error('DW_RENPY_SDK is required for the real SDK chooser smoke')
  const userData = await mkdtemp(path.join(tmpdir(), 'dw-r56-userdata-'))
  const parentDir = await mkdtemp(path.join(tmpdir(), 'dw-r56-projects-'))
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      args: [path.join(ROOT, 'out', 'main', 'index.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DW_TEST_USERDATA: userData,
        DW_TEST_FIXTURE_DIR: parentDir,
        DW_TEST_RENPY_SDK_DIR: sdk
      }
    })
    const page = await app.firstWindow()
    await page.waitForSelector('.dw-global-nav', { timeout: 15_000 })
    await page.locator('.dw-global-nav summary').filter({ hasText: '创作工具' }).click()
    await page.locator('.dw-global-nav').getByRole('button', { name: 'Galgame' }).click()
    const studio = page.getByRole('region', { name: 'Galgame Studio' })
    await studio.getByRole('button', { name: '选择父目录' }).click()
    await studio.getByLabel('项目名').fill('SDK 选择回归')
    await studio.getByRole('button', { name: "创建 Ren'Py 项目" }).click()
    await studio.getByRole('heading', { name: "选择 Ren'Py SDK" }).waitFor({ timeout: 15_000 })
    check('SDK card exposes auto scan, manual directory and official download',
      await studio.getByRole('button', { name: '自动扫描' }).isVisible() &&
      await studio.getByRole('button', { name: '选择 SDK 目录' }).isVisible() &&
      await studio.getByRole('button', { name: '下载官方 SDK' }).isVisible())
    await studio.getByRole('button', { name: '选择 SDK 目录' }).click()
    await studio.getByRole('heading', { name: '人物与素材' }).waitFor({ timeout: 30_000 })
    const switchSdk = studio.getByRole('button', { name: /^更换 SDK，当前为 Ren.Py / })
    await switchSdk.waitFor()
    if (process.env.DW_EXPECT_RENPY_VERSION) check('project toolbar names the selected runtime', (await switchSdk.innerText()).trim() === "Ren'Py " + process.env.DW_EXPECT_RENPY_VERSION)
    if (process.env.DW_STUDIO_SCREENSHOTS) {
      await mkdir(process.env.DW_STUDIO_SCREENSHOTS, { recursive: true })
      await page.screenshot({ path: path.join(process.env.DW_STUDIO_SCREENSHOTS, 'galgame-sdk.png') })
    }
    const result = await page.evaluate(async () => {
      const ds = (window as any).ds
      const settings = await ds.getSettings()
      return { sdkPath: settings.galgame.sdkPath }
    })
    check('manual SDK directory is validated and persisted', await realpath(result.sdkPath) === await realpath(sdk), JSON.stringify(result))
    const closed = app.waitForEvent('close', { timeout: 15_000 }).then(() => true).catch(() => false)
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes('window=float'))
      main?.close()
    })
    check('closing the main window exits through the shutdown coordinator', await closed)
    app = null
  } finally {
    if (app) await closeApp(app)
    await rm(userData, { recursive: true, force: true })
    await rm(parentDir, { recursive: true, force: true })
  }
  console.log(`\nR56 hotfix Electron smoke: ${passed}/${passed} PASS`)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
