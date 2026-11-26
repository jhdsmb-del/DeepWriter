import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { settingsSetSchema, wp7FeatureFlagsSchema } from '../src/shared/ipcSchemas'
import { wp7FeatureFlagsEnabled, wp7FeatureFlagsForToggle } from '../src/renderer/src/store'

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const readSource = async (relativePath: string): Promise<string> => fsp.readFile(path.join(root, relativePath), 'utf8')

const falseFlags = {
  sceneContractV2: false,
  deterministicDirector: false,
  dramaticCritic: false,
  localizedRevision: false,
  reorientation: false
} as const

const trueFlags = {
  sceneContractV2: true,
  deterministicDirector: true,
  dramaticCritic: true,
  localizedRevision: true,
  reorientation: true
} as const

function checkSchema(): void {
  assert.equal(wp7FeatureFlagsSchema.safeParse(falseFlags).success, true, '完整 false flags 应通过 schema')
  assert.equal(wp7FeatureFlagsSchema.safeParse(trueFlags).success, true, '完整 true flags 应通过 schema')
  for (const value of [true, false, 1, 0, 'true', null, undefined, {}, { ...falseFlags, extra: false }]) {
    assert.equal(wp7FeatureFlagsSchema.safeParse(value).success, false, `malformed flags 应拒绝：${String(value)}`)
  }
  assert.equal(wp7FeatureFlagsSchema.safeParse({ ...falseFlags, sceneContractV2: 'true' }).success, false, '字符串 flag 应拒绝')
  assert.equal(wp7FeatureFlagsSchema.safeParse({ ...falseFlags, dramaticCritic: 1 }).success, false, '数字 flag 应拒绝')
  assert.equal(wp7FeatureFlagsSchema.safeParse({ sceneContractV2: true }).success, false, 'partial flags 应拒绝')
  assert.equal(settingsSetSchema.safeParse({ kind: 'patch', key: 'wp7FeatureFlags', value: true }).success, false, 'IPC 不得接受总开关字符串/数字替身')
  assert.equal(settingsSetSchema.safeParse({ kind: 'patch', key: 'wp7FeatureFlags', value: falseFlags }).success, true, 'IPC 应接受完整 false flags')
  assert.equal(settingsSetSchema.safeParse({ kind: 'patch', key: 'wp7FeatureFlags', value: { ...trueFlags, unknownFlag: true } }).success, false, 'IPC 不得接受未知 flag')
}

async function checkContracts(): Promise<void> {
  const [main, store, modal, css] = await Promise.all([
    readSource('src/main/index.ts'),
    readSource('src/renderer/src/store.ts'),
    readSource('src/renderer/src/components/SettingsModal.tsx'),
    readSource('src/renderer/src/ui-takeover.css')
  ])
  assert.match(main, /wp7FeatureFlags:\s*\{ \.\.\.DEFAULT_WP7_FEATURE_FLAGS \}/, 'main 默认设置必须全关')
  assert.match(main, /wp7FeatureFlagsSchema.safeParse/, '磁盘设置与 IPC 使用同一严格 schema')
  assert.match(main, /wp7FlagsMigrated/, '旧 settings 缺字段必须迁移为全关')
  assert.match(store, /wp7FeatureFlagsForToggle\(enabled: boolean\)/, 'store 必须提供总开关到五项 flags 的映射')
  assert.match(store, /wp7FeatureFlagsEnabled\(value: unknown\)/, 'store 必须严格判断总开关状态')
  assert.match(modal, /data-testid="wp7-experiment-settings"/, '设置页必须有 WP7 实验区')
  assert.match(modal, /可选能力默认关闭，仅影响新任务。/, '设置页页头必须明确实验能力默认关闭且只影响新任务')
  assert.match(modal, /关闭后，新任务回到稳定模式；进行中的任务不会变化。/, '设置页说明必须明确关闭后的新任务与进行中任务语义')
  assert.match(modal, /description="场景规划与局部审校。"/, '紧凑实验开关只显示场景规划与局部审校')
  assert.doesNotMatch(modal, /场景规划、局部审校与剧情重定向/, '紧凑实验开关不得暴露已排除的剧情重定向')
  assert.match(modal, /wp7FeatureFlagsForToggle\(enabled\)/, 'UI 开关必须同步五项 flags')
  assert.match(css, /\.dw-experimental-setting\s*\{/, '实验区沿用单色设置样式')
}

async function runScreenshots(): Promise<void> {
  const { _electron: electron } = await import('@playwright/test')
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-wp7-settings-'))
  const shotDir = path.join(root, 'e2e-screenshots')
  await fsp.mkdir(shotDir, { recursive: true })
  const app = await electron.launch({
    args: [path.join(root, 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('.composer', { timeout: 15000 })
    await page.locator('[aria-label="设置"]').click()
    const dialog = page.locator('.dw-settings-modal[role="dialog"]')
    await dialog.waitFor({ state: 'visible' })
    await dialog.locator('.dw-settings-nav button', { hasText: '实验' }).click()
    const section = page.locator('[data-testid="wp7-experiment-settings"]')
    const toggle = section.locator('input[type="checkbox"]')
    await toggle.waitFor({ state: 'visible' })
    assert.equal(await toggle.isChecked(), false, '全新 settings 的 WP7 开关必须默认关闭')
    await page.screenshot({ path: path.join(shotDir, 'wp7-settings-off.png') })
    await toggle.focus()
    await page.keyboard.press('Space')
    assert.equal(await toggle.isChecked(), true, 'WP7 开关应可用键盘/原生 checkbox 打开')
    await page.screenshot({ path: path.join(shotDir, 'wp7-settings-on.png') })
    const afterOn = await page.evaluate(() => (window as any).ds.getSettings())
    assert.deepEqual(afterOn.wp7FeatureFlags, falseFlags, '保存前主进程仍应保持旧值')
    await dialog.getByRole('button', { name: '保存并关闭' }).click()
    await dialog.waitFor({ state: 'hidden' })
    const persistedOn = await page.evaluate(() => (window as any).ds.getSettings())
    assert.deepEqual(persistedOn.wp7FeatureFlags, trueFlags, '打开后应持久化五项 true')
    await page.locator('[aria-label="设置"]').click()
    await dialog.waitFor({ state: 'visible' })
    await dialog.locator('.dw-settings-nav button', { hasText: '实验' }).click()
    const reopenedToggle = page.locator('[data-testid="wp7-experiment-settings"] input[type="checkbox"]')
    await reopenedToggle.focus()
    await page.keyboard.press('Space')
    await dialog.getByRole('button', { name: '保存并关闭' }).click()
    await dialog.waitFor({ state: 'hidden' })
    const persistedOff = await page.evaluate(() => (window as any).ds.getSettings())
    assert.deepEqual(persistedOff.wp7FeatureFlags, falseFlags, '关闭后应持久化五项 false')
    console.log(`WP7 settings screenshots: ${path.join(shotDir, 'wp7-settings-off.png')}, ${path.join(shotDir, 'wp7-settings-on.png')}`)
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
  }
}

async function main(): Promise<void> {
  checkSchema()
  await checkContracts()
  assert.deepEqual(wp7FeatureFlagsForToggle(false), falseFlags, 'store 关闭必须生成全 false')
  assert.deepEqual(wp7FeatureFlagsForToggle(true), trueFlags, 'store 开启必须生成全 true')
  assert.equal(wp7FeatureFlagsEnabled(falseFlags), false, 'store 全 false 应视为关闭')
  assert.equal(wp7FeatureFlagsEnabled(trueFlags), true, 'store 全 true 应视为开启')
  assert.equal(wp7FeatureFlagsEnabled({ sceneContractV2: true }), false, 'store partial flags 不得视为开启')
  assert.equal(wp7FeatureFlagsEnabled({ ...trueFlags, unknownFlag: true }), false, 'store unknown flags 不得视为开启')
  if (process.argv.includes('--e2e')) await runScreenshots()
  console.log('WP7 SETTINGS PASS')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
