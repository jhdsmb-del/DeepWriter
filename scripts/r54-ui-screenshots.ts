import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { _electron as electron, type Page } from '@playwright/test'

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const shotDir = path.join(root, 'e2e-screenshots')

async function resizeMainWindow(app: Awaited<ReturnType<typeof electron.launch>>, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow, screen }, size: { width: number; height: number }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('window=float'))
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea
    const safeHeight = Math.min(size.height, Math.max(640, workArea.height - 80))
    win.setContentSize(Math.min(size.width, workArea.width), safeHeight, false)
    win.center()
  }, { width, height })
}

async function assertNarrowLayout(page: Page, width: number): Promise<void> {
  const metrics = await page.evaluate(() => {
    const main = document.querySelector('main.dw-workspace')
    const actions = document.querySelector('.dw-task-center-actions')
    const modelTrigger = document.querySelector<HTMLElement>('[data-testid="model-reasoning-trigger"]')
    const rails = [...document.querySelectorAll<HTMLElement>('.dw-activity-rail, .dw-activity-rail-trigger')]
      .filter((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && rect.width > 0 && rect.height > 0
      })
    if (!main || (!actions && !modelTrigger)) return { error: '缺少当前工作区的操作入口' }
    const mainRect = main.getBoundingClientRect()
    const actionRect = actions?.getBoundingClientRect()
    const modelRect = modelTrigger?.getBoundingClientRect()
    const viewport = { right: window.innerWidth, bottom: window.innerHeight }
    const intersects = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
    const railOverlap = Boolean(actionRect && rails.some((rail) => intersects(actionRect, rail.getBoundingClientRect())))
    return {
      mainScrollWidth: main.scrollWidth,
      mainClientWidth: main.clientWidth,
      action: actionRect ? { left: actionRect.left, right: actionRect.right, top: actionRect.top, bottom: actionRect.bottom } : null,
      model: modelRect ? { left: modelRect.left, right: modelRect.right, top: modelRect.top, bottom: modelRect.bottom } : null,
      main: { left: mainRect.left, right: mainRect.right, top: mainRect.top, bottom: mainRect.bottom },
      viewport,
      railCount: rails.length,
      railOverlap
    }
  })
  if ('error' in metrics) throw new Error(`R54 ${width}px 布局断言失败：${metrics.error}`)
  const actionInMain = !metrics.action || (metrics.action.left >= metrics.main.left - 1 && metrics.action.right <= metrics.main.right + 1 && metrics.action.top >= metrics.main.top - 1 && metrics.action.bottom <= metrics.main.bottom + 1)
  const actionInViewport = !metrics.action || (metrics.action.left >= -1 && metrics.action.right <= metrics.viewport.right + 1 && metrics.action.top >= -1 && metrics.action.bottom <= metrics.viewport.bottom + 1)
  const modelInViewport = !metrics.model || (metrics.model.left >= -1 && metrics.model.right <= metrics.viewport.right + 1 && metrics.model.top >= -1 && metrics.model.bottom <= metrics.viewport.bottom + 1)
  if (metrics.mainScrollWidth > metrics.mainClientWidth + 1 || !actionInMain || !actionInViewport || !modelInViewport || metrics.railOverlap || metrics.railCount !== 0) {
    throw new Error(`R55 ${width}px 布局断言失败：${JSON.stringify({ ...metrics, actionInMain, actionInViewport, modelInViewport })}`)
  }
}

async function assertModelPopover(page: Page): Promise<void> {
  const trigger = page.getByTestId('model-reasoning-trigger')
  await trigger.click()
  const panel = page.getByTestId('model-reasoning-panel')
  await panel.waitFor({ state: 'visible' })
  const geometry = await page.evaluate(() => {
    const main = document.querySelector('main.dw-workspace')?.getBoundingClientRect()
    const panel = document.querySelector<HTMLElement>('[data-testid="model-reasoning-panel"]')?.getBoundingClientRect()
    const list = document.querySelector('[data-testid="model-reasoning-panel"] [role="listbox"]')
    return { main, panel, modelOptions: list?.querySelectorAll('[role="option"]').length ?? 0, viewportRight: window.innerWidth }
  })
  if (!geometry.panel || !geometry.main || geometry.panel.left < -1 || geometry.panel.right > geometry.viewportRight + 1 || geometry.modelOptions < 1) {
    throw new Error(`R55 模型浮层几何断言失败：${JSON.stringify(geometry)}`)
  }
  const lowEffort = panel.getByRole('radio', { name: '低', exact: true })
  if (await lowEffort.isDisabled()) throw new Error('R55 内置模型推理强度不可选择')
  await lowEffort.click()
  await page.waitForFunction(() => document.querySelector('[data-testid="model-reasoning-trigger"]')?.getAttribute('aria-label')?.includes('思考低'))
  const binding = await page.evaluate(async () => {
    const result = await (window as any).ds?.providerSnapshot?.()
    if (!result?.ok) return null
    const profileId = result.data.bindings?.defaultProfileId
    const profile = result.data.profiles.find((item: { id: string }) => item.id === profileId)
    const model = result.data.models.find((item: { id: string }) => item.id === profile?.modelId)
    return { effort: profile?.reasoning?.effort, remoteModelId: model?.remoteModelId }
  })
  if (binding?.effort !== 'low' || !binding.remoteModelId) throw new Error(`R55 模型选择未写入新任务 Profile：${JSON.stringify(binding)}`)
  await page.keyboard.press('Escape')
  const restored = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'model-reasoning-trigger')
  if (!restored) throw new Error('R55 模型浮层关闭后焦点未回到入口')
}

async function assertCompactModebar(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const modebar = document.querySelector('.composer-modebar')
    const text = modebar?.textContent ?? ''
    return {
      text,
      hasContextControl: Boolean(modebar?.querySelector('.dw-context-mode, .dw-context-detail')),
      hasPermissionControl: Boolean(modebar?.querySelector('[class*="perm-"]')),
      hasQuickDirect: text.includes('快速直写'),
      hasHardcodedModelTip: text.includes('DeepSeek V4 ·')
    }
  })
  if (result.hasContextControl || result.hasPermissionControl || result.hasQuickDirect || result.hasHardcodedModelTip) {
    throw new Error(`R55 底栏精简断言失败：${JSON.stringify(result)}`)
  }
}

async function assertLongformWorkspace(page: Page, width: number): Promise<void> {
  const novelEntry = page.getByRole('button', { name: '长文', exact: true })
  if (await novelEntry.isVisible()) await novelEntry.click()
  const shell = page.getByTestId('longform-workflow-shell')
  await shell.waitFor({ state: 'visible' })
  await page.waitForSelector('main.dw-workspace.workspace-novel')

  const contract = shell.locator('details.dw-longform-contract')
  if (await contract.getAttribute('open') === null) await contract.locator('summary').click()
  const input = page.locator('input[aria-label="长文目标篇幅"]')
  await input.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '开始梳理', exact: true }).waitFor({ state: 'visible' })

  await input.fill('12345')
  await input.press('Enter')
  if (await input.inputValue() !== '12345') throw new Error('WP6 目标篇幅手动值未保留精确整数')
  await input.fill('2000000')
  await input.press('Enter')
  if (await input.inputValue() !== '2000000') throw new Error('WP6 目标篇幅上界未保留精确整数')
  await input.fill('1999')
  await input.press('Enter')
  if (await input.inputValue() !== '2000') throw new Error('WP6 目标篇幅下界未归一化')
  const toast = page.locator('.toast')
  if (await toast.isVisible().catch(() => false)) await toast.waitFor({ state: 'hidden', timeout: 5000 })

  const visual = await page.evaluate(() => {
    const isVisible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const shellNode = document.querySelector<HTMLElement>('[data-testid="longform-workflow-shell"]')
    const canvas = document.querySelector<HTMLElement>('.dw-workspace-canvas')
    const main = document.querySelector<HTMLElement>('main.dw-workspace.workspace-novel')
    if (!shellNode || !canvas || !main) return { error: '小说工作区或 LongformWorkflowShell 缺失' }
    const shellRect = shellNode.getBoundingClientRect()
    const mainRect = main.getBoundingClientRect()
    const shellStyle = getComputedStyle(shellNode)
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const touchTargets = [...shellNode.querySelectorAll<HTMLElement>('.dw-longform-stepper button, .dw-longform-contract summary, .dw-longform-link')].filter(isVisible)
    const regularControls = [...shellNode.querySelectorAll<HTMLElement>('button, input, textarea, summary')].filter(isVisible)
    const activityTrigger = shellNode.querySelector<HTMLElement>('.dw-longform-activity-trigger')
    const badFonts = [...shellNode.querySelectorAll<HTMLElement>('h1,h2,h3,p,button,input,textarea,summary')]
      .filter(isVisible)
      .filter((element) => /Times New Roman|Georgia|Cambria|Garamond|Courier New/i.test(getComputedStyle(element).fontFamily))
    const legacy = [...document.querySelectorAll<HTMLElement>('.story-panel, .scene-wf-project, .scene-wf-actions, .novel-panel')].filter(isVisible)
    const overflowNodes = [...shellNode.querySelectorAll<HTMLElement>('*')]
      .filter(isVisible)
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .slice(0, 8)
      .map((element) => ({ tag: element.tagName.toLowerCase(), className: element.className, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    const textColors = [...shellNode.querySelectorAll<HTMLElement>('h1,h2,h3,p,button,input,textarea,summary')]
      .filter(isVisible)
      .map((element) => getComputedStyle(element).color)
    return {
      shell: { left: shellRect.left, right: shellRect.right, top: shellRect.top, bottom: shellRect.bottom, scrollWidth: shellNode.scrollWidth, clientWidth: shellNode.clientWidth },
      main: { left: mainRect.left, right: mainRect.right, top: mainRect.top, bottom: mainRect.bottom, scrollWidth: main.scrollWidth, clientWidth: main.clientWidth },
      canvas: { scrollWidth: canvas.scrollWidth, clientWidth: canvas.clientWidth, scrollHeight: canvas.scrollHeight, clientHeight: canvas.clientHeight },
      viewport,
      primarySurfaceCount: shellNode.querySelectorAll('.dw-longform-current').length,
      mainColumnCount: shellNode.querySelectorAll('.dw-longform-main-column').length,
      legacyPanels: legacy.length,
      overflowNodes,
      touchMinHeight: touchTargets.length > 0 ? Math.min(...touchTargets.map((element) => element.getBoundingClientRect().height)) : 0,
      regularMinHeight: regularControls.length > 0 ? Math.min(...regularControls.map((element) => element.getBoundingClientRect().height)) : 0,
      activityTriggerWidth: activityTrigger && isVisible(activityTrigger) ? activityTrigger.getBoundingClientRect().width : null,
      bottomPadding: Number.parseFloat(shellStyle.paddingBottom) || 0,
      bodyFont: getComputedStyle(document.body).fontFamily,
      badFonts: badFonts.length,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      headingColor: getComputedStyle(shellNode.querySelector('h1') ?? shellNode).color,
      textColors
    }
  })
  if ('error' in visual) throw new Error(`WP6 ${width}px 工作区断言失败：${visual.error}`)
  const inViewport = visual.shell.left >= -1 && visual.shell.right <= visual.viewport.width + 1
  const noOverflow = visual.shell.scrollWidth <= visual.shell.clientWidth + 1 && visual.main.scrollWidth <= visual.main.clientWidth + 1 && visual.canvas.scrollWidth <= visual.canvas.clientWidth + 1
  const primarySurface = visual.primarySurfaceCount === 1 && visual.mainColumnCount === 1
  const paletteOk = visual.bodyBackground === 'rgb(11, 11, 12)' && visual.headingColor !== 'rgb(255, 0, 0)' && visual.textColors.every((color) => color !== 'rgb(255, 0, 0)')
  const activityTargetOk = visual.activityTriggerWidth === null || visual.activityTriggerWidth >= 40
  const bottomSafe = visual.bottomPadding >= 64
  const shotPath = path.join(shotDir, `novel-${width}.png`)
  const failed = !inViewport || !noOverflow || !primarySurface || visual.legacyPanels > 0 || visual.touchMinHeight < 44 || visual.regularMinHeight < 30 || visual.badFonts > 0 || !paletteOk || !activityTargetOk || !bottomSafe
  if (failed) {
    await page.screenshot({ path: shotPath })
    console.log(`FAIL WP6 novel ${width}px screenshot: ${shotPath}`)
    throw new Error(`WP6 ${width}px 视觉断言失败：${JSON.stringify({ ...visual, inViewport, noOverflow, primarySurface, paletteOk, activityTargetOk, bottomSafe })}`)
  }
  await page.screenshot({ path: shotPath })
  console.log(`PASS WP6 novel ${width}px screenshot: ${shotPath}`)
}

async function captureProviderSettings(page: Page, shotDir: string): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const registry = page.getByTestId('provider-registry')
  await registry.waitFor({ state: 'visible' })
  const customProvider = page.getByText('添加自定义 Provider', { exact: true })
  if (await customProvider.isVisible()) await customProvider.click()
  const firstSelect = registry.locator('.dw-select-trigger').first()
  if (await firstSelect.isVisible()) await firstSelect.click()
  await page.screenshot({ path: path.join(shotDir, 'r55-settings-provider-open.png') })
  console.log(`PASS R55 provider settings screenshot: ${path.join(shotDir, 'r55-settings-provider-open.png')}`)
  if (await firstSelect.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
}

async function captureGalgameEntry(page: Page, shotDir: string): Promise<void> {
  await page.locator('.dw-creative-tools > summary').click()
  await page.getByRole('button', { name: 'Galgame', exact: true }).first().click()
  const studio = page.locator('.galgame-studio')
  await studio.waitFor({ state: 'visible' })
  const facts = await studio.evaluate((node) => ({
    text: node.textContent ?? '',
    cards: node.querySelectorAll('.studio-card').length,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth
  }))
  if (!facts.text.includes('创建或导入项目') || facts.cards !== 1 || facts.scrollWidth > facts.clientWidth + 1 || /R55 WORKBENCH|STEP 0|ENVIRONMENT/.test(facts.text)) {
    throw new Error(`R55 Galgame 入口断言失败：${JSON.stringify(facts)}`)
  }
  await page.screenshot({ path: path.join(shotDir, 'r55-galgame-entry.png') })
  console.log(`PASS R55 Galgame regression screenshot: ${path.join(shotDir, 'r55-galgame-entry.png')}`)
  await page.getByRole('button', { name: 'Agent', exact: true }).first().click()
}

async function main(): Promise<void> {
  await fsp.mkdir(shotDir, { recursive: true })
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r54-ui-'))
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [...(process.env.DW_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), ...(process.env.DW_E2E_PASSWORD_STORE ? [`--password-store=${process.env.DW_E2E_PASSWORD_STORE}`] : []), path.join(root, 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userDataDir }
  })
  const page = await app.firstWindow()
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('.composer', { timeout: 15000 })
    await page.waitForSelector('[data-testid="model-reasoning-trigger"]', { timeout: 15000 })
    for (const width of [1280, 1024, 800]) {
      await resizeMainWindow(app, width, 900)
      await page.waitForTimeout(700)
      await assertNarrowLayout(page, width)
      await page.getByRole('button', { name: '任务中心', exact: true }).click()
      await page.getByRole('heading', { name: '任务中心', exact: true }).waitFor({ state: 'visible' })
      await assertNarrowLayout(page, width)
      await page.getByRole('button', { name: 'Agent', exact: true }).click()
      await page.locator('.composer').waitFor({ state: 'visible' })
      await assertCompactModebar(page)
      const shotPath = path.join(shotDir, `agent-${width}.png`)
      await page.screenshot({ path: shotPath })
      console.log(`PASS R55 agent ${width}px screenshot: ${shotPath}`)
    }
    await resizeMainWindow(app, 800, 900)
    await page.waitForTimeout(400)
    await assertModelPopover(page)
    console.log('PASS R55 model popover regression')
    const longformFailures: string[] = []
    for (const width of [1280, 1024, 800]) {
      await resizeMainWindow(app, width, 900)
      await page.waitForTimeout(500)
      try {
        await assertLongformWorkspace(page, width)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        longformFailures.push(`${width}px: ${message}`)
      }
    }
    await page.getByRole('button', { name: 'Agent', exact: true }).first().click()
    await page.waitForSelector('[data-testid="model-reasoning-trigger"]', { state: 'visible' })
    await resizeMainWindow(app, 1280, 900)
    await page.waitForTimeout(500)
    await page.getByTestId('model-reasoning-trigger').click()
    await page.getByTestId('model-reasoning-panel').waitFor({ state: 'visible' })
    await page.screenshot({ path: path.join(shotDir, 'r55-model-reasoning-open.png') })
    console.log(`PASS R55 model reasoning screenshot: ${path.join(shotDir, 'r55-model-reasoning-open.png')}`)
    await page.keyboard.press('Escape')
    const presetTrigger = page.getByTestId('agent-preset-trigger')
    await presetTrigger.click()
    await page.getByTestId('agent-preset-panel').waitFor({ state: 'visible' })
    await page.screenshot({ path: path.join(shotDir, 'r54-agent-preset-open.png') })
    console.log(`PASS R54 agent preset screenshot: ${path.join(shotDir, 'r54-agent-preset-open.png')}`)
    await page.keyboard.press('Escape')
    await captureProviderSettings(page, shotDir)
    await captureGalgameEntry(page, shotDir)
    if (longformFailures.length > 0) throw new Error(`WP6 长文工作区视觉失败：\n${longformFailures.join('\n')}`)
  } finally {
    await app.close()
  }
}

void main().catch((error: unknown) => {
  console.error('FAIL r54/WP6 UI screenshots', error)
  process.exitCode = 1
})
