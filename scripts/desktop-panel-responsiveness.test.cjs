// QA: populated model/settings controls (not shells), actual click->rAF,
// shared local IPC reads, persisted reasoning, catalog mutations, draft reset,
// rapid close/reopen, session switch, and native-window/viewport isolation.
// Compare a preserved build with DW_PANEL_BEFORE_BUILD; no provider calls.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { _electron, expect } = require('@playwright/test')
const { DatabaseSync } = require('node:sqlite')
const root = path.resolve(__dirname, '..'), evidence = path.join(root, 'out/panel-latency')

const isolatedMain = `
const Module = require('node:module'), electron = require('electron');
const OriginalWindow = electron.BrowserWindow;
const HiddenWindow = new Proxy(OriginalWindow, {
 construct(Target, [options]) {
  const win = new Target({ ...options, show: false, focusable: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
  win.show = win.showInactive = win.focus = () => {};
  return win;
 },
 get(Target, key) { const value = Reflect.get(Target, key); return typeof value === 'function' && key !== 'prototype' ? value.bind(Target) : value; }
});
const isolatedElectron = Object.create(electron);
Object.defineProperty(isolatedElectron, 'BrowserWindow', { value: HiddenWindow });
const load = Module._load;
Module._load = function(request, parent, main) { return request === 'electron' ? isolatedElectron : load.call(this, request, parent, main); };
globalThis.__panelIPC = { started: 0, completed: 0 };
const handle = electron.ipcMain.handle.bind(electron.ipcMain);
electron.ipcMain.handle = (channel, listener) => handle(channel, channel === 'provider:snapshot' ? async (...args) => {
 globalThis.__panelIPC.started++;
 await new Promise(resolve => setTimeout(resolve, Number(process.env.DW_PANEL_DELAY_MS || 0)));
 const result = await listener(...args); globalThis.__panelIPC.completed++; return result;
} : channel === 'runs:getBilling' ? async (...args) => {
 await new Promise(resolve => setTimeout(resolve, 200)); return listener(...args);
} : listener);
require(process.env.DW_PANEL_ENTRY);
`

async function measure(page, name, trigger, panel, control) {
  await page.evaluate(({ name, panel, control }) => {
    window.__panelMeasure = { name }
    document.addEventListener('click', () => {
      const record = window.__panelMeasure; record.start = performance.now()
      const frame = () => {
        const surface = document.querySelector(panel), target = surface?.querySelector(control)
        let opacity = 1
        for (let element = surface; element; element = element.parentElement) {
          const style = getComputedStyle(element)
          if (style.visibility === 'hidden' || style.display === 'none') opacity = 0
          opacity *= Number(style.opacity)
        }
        const painted = surface && opacity >= 0.05
        if (surface && !record.visibleMs) {
          const bounds = surface.getBoundingClientRect()
          if (bounds.width && bounds.height && painted) record.visibleMs = performance.now() - record.start
        }
        const bounds = target?.getBoundingClientRect()
        const hit = bounds && document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        if (painted && target && !target.disabled && !surface.closest('[inert]') && target.contains(hit)) { record.readyMs = performance.now() - record.start; return }
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }, { once: true, capture: true })
  }, { name, panel, control })
  await trigger.click()
  await page.waitForFunction(() => window.__panelMeasure.readyMs !== undefined)
  return page.evaluate(() => window.__panelMeasure)
}

async function sample(buildDir, label, functional = false) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-panel-latency-'))
  let app
  try {
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, webAccessEnabled: false }))
    const bootstrap = path.join(home, 'isolated-main.cjs'); await fs.writeFile(bootstrap, isolatedMain)
    app = await _electron.launch({ cwd: root, args: [bootstrap, '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'], env: { ...process.env, DEEPWRITER_API_KEY: '', NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home, DW_PANEL_ENTRY: path.resolve(root, buildDir, 'main/index.js'), DW_PANEL_DELAY_MS: process.env.DW_PANEL_DELAY_MS ?? '200' } })
    const page = await app.firstWindow(); page.setDefaultTimeout(12000)
    await page.getByRole('textbox', { name: '任务内容' }).waitFor()
    await expect.poll(() => app.evaluate(() => globalThis.__panelIPC.completed)).toBeGreaterThan(0)
    await page.waitForTimeout(100)
    const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), size: window.getSize() })))
    assert(native.length > 0 && native.every(window => !window.visible && !window.focused), 'test windows never appear in the user foreground')
    const reads = () => app.evaluate(() => globalThis.__panelIPC.started)
    const metrics = [], startReads = await reads()
    const model = page.getByTestId('model-reasoning-trigger'), settings = page.getByRole('button', { name: '设置', exact: true })
    for (const name of ['model-first-open', 'model-reopen']) {
      metrics.push(await measure(page, name, model, '#dw-model-reasoning-panel', 'input[type=range]'))
      await expect(page.getByRole('slider', { name: '思考强度', exact: true })).toHaveAttribute('aria-valuetext', '默认')
      if (functional && name === 'model-reopen') await page.screenshot({ path: path.join(evidence, 'model-populated.png'), animations: 'disabled', scale: 'css' })
      await page.keyboard.press('Escape'); await page.waitForTimeout(180)
    }
    for (const name of ['settings-first-open', 'settings-reopen']) {
      metrics.push(await measure(page, name, settings, '.dw-settings-modal', '.dw-provider-simple-models button'))
      await expect(page.getByRole('textbox', { name: '当前供应商 Base URL', exact: true })).toHaveValue('https://api.deepseek.com')
      assert.equal(await page.locator('.dw-provider-simple-models > .dw-provider-model-row').count(), 1, 'actual catalog is populated')
      if (functional && name === 'settings-reopen') await page.screenshot({ path: path.join(evidence, 'settings-populated.png'), animations: 'disabled', scale: 'css' })
      await page.getByRole('button', { name: '关闭设置', exact: true }).click(); await page.waitForTimeout(180)
    }
    const catalogReadsDuringOpen = await reads() - startReads
    if (functional) {
      assert.equal(catalogReadsDuringOpen, 0, 'mounting/opening/closing does not refetch the catalog')
      // Changing a real reasoning control persists and is visible after reopen.
      await model.click(); const slider = page.getByRole('slider', { name: '思考强度', exact: true })
      await slider.focus(); await page.keyboard.press('End'); await expect(slider).toHaveAttribute('aria-valuetext', '最高')
      await expect(slider).toBeEnabled(); await page.keyboard.press('Escape'); await page.waitForTimeout(180)
      await model.click(); await expect(slider).toHaveAttribute('aria-valuetext', '最高')
      await slider.focus(); await page.keyboard.press('Home'); await expect(slider).toHaveAttribute('aria-valuetext', '默认'); await expect(slider).toBeEnabled()
      await page.keyboard.press('Escape'); await page.waitForTimeout(180)
      // Closing an unsaved edit must not leak it into a newly opened settings panel.
      await settings.click(); const endpoint = page.getByRole('textbox', { name: '当前供应商 Base URL', exact: true })
      await endpoint.fill('https://uncommitted.invalid'); await page.getByRole('button', { name: '关闭设置', exact: true }).click()
      await page.waitForTimeout(180); await settings.click(); await expect(endpoint).toHaveValue('https://api.deepseek.com')
      // Local metadata write only: no model discovery/test/generation network request.
      await page.getByRole('textbox', { name: '添加模型 ID', exact: true }).fill('panel-fixture-new')
      await page.getByRole('button', { name: '添加模型', exact: true }).click()
      await expect(page.getByRole('button', { name: 'panel-fixture-new 选择', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '关闭设置', exact: true }).click(); await page.waitForTimeout(180)
      await page.getByRole('button', { name: '新建会话', exact: true }).click()
      await model.click(); await page.getByRole('button', { name: '选择模型', exact: true }).click()
      const originalModel = await page.getByRole('option', { selected: true }).getAttribute('aria-label')
      const newModel = page.getByRole('option', { name: /panel-fixture-new/ })
      await expect(newModel).toBeVisible(); await newModel.click()
      await expect(model).toContainText('panel-fixture-new'); await expect(slider).toBeDisabled()
      await page.getByRole('button', { name: '选择模型', exact: true }).click()
      await page.getByRole('option', { name: originalModel, exact: true }).click()
      await expect(slider).toBeEnabled(); await expect(slider).toHaveAttribute('aria-valuetext', '默认')
      await page.keyboard.press('Escape')
      // Rapid reversals exercise the exit timer without waiting for unmount.
      for (let index = 0; index < 3; index++) { await model.click(); await page.keyboard.press('Escape') }
      await model.click(); await expect(page.getByTestId('model-reasoning-panel')).toHaveAttribute('data-state', 'open')
      const fit = await page.getByTestId('model-reasoning-panel').evaluate(element => { const rect = element.getBoundingClientRect(); return rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight && element.scrollWidth <= element.clientWidth })
      assert(fit); await page.keyboard.press('Escape')
      // Real task rows and real repository billing; no synthetic model output.
      const db = new DatabaseSync(path.join(home, 'deepwriter.db')), now = Date.now()
      try {
        for (const [id, title] of [['task-a-001', '弹层任务 A'], ['task-b-002', '弹层任务 B']]) {
          db.prepare('INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run(id, title, now, now)
          db.prepare('INSERT INTO runs(run_id,session_id,status,phase,started_at,updated_at,config_json) VALUES(?,?,?,?,?,?,?)').run(id, id, 'failed', 'failed', now, now, JSON.stringify({ model: 'panel-fixture', workDir: home, docDir: home, runMode: 'agent' }))
        }
      } finally { db.close() }
      await page.getByRole('button', { name: '任务中心', exact: true }).click()
      const rowA = page.locator('.dw-task-recent').filter({ hasText: '弹层任务 A' })
      const rowB = page.locator('.dw-task-recent').filter({ hasText: '弹层任务 B' })
      await rowA.getByRole('button', { name: '账单', exact: true }).click()
      const billing = page.getByTestId('run-billing-panel')
      await expect(billing).toContainText('task-a-001')
      // Stage a new target while the dialog stays mounted; normal close/open
      // is also exercised below. Old billing must disappear during the read.
      await rowB.getByRole('button', { name: '账单', exact: true }).evaluate(button => button.click())
      await expect(billing).toHaveCount(0)
      await expect(billing).toContainText('task-b-002'); await expect(billing).not.toContainText('task-a-001')
      await page.screenshot({ path: path.join(evidence, 'task-billing-current.png'), animations: 'disabled', scale: 'css' })
      await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
      await rowA.getByRole('button', { name: /查看详情/ }).click()
      await expect(page.getByRole('dialog', { name: '任务详情', exact: true })).toBeVisible()
      await page.getByRole('tab', { name: '账单', exact: true }).click(); await expect(billing).toContainText('task-a-001')
      await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
      const exploreUntil = Date.now() + Number(process.env.DW_PANEL_EXPLORE_MS ?? 0)
      while (Date.now() < exploreUntil) {
        await page.getByRole('button', { name: 'Agent', exact: true }).click()
        await model.click(); await page.getByRole('button', { name: '选择模型', exact: true }).click()
        await page.keyboard.press('Escape')
        await settings.click()
        await page.getByRole('button', { name: '完成与预算', exact: true }).click()
        await page.getByRole('button', { name: '工作区', exact: true }).click()
        await page.getByRole('button', { name: '模型与接口', exact: true }).click()
        await page.getByRole('button', { name: '当前供应商 API 格式', exact: true }).click()
        await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
        await page.waitForTimeout(180)
        await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCount(0)
      }
    }
    return { label, native, catalogReadsDuringOpen, metrics }
  } finally {
    if (app) await app.close()
    assert.equal(path.dirname(home), os.tmpdir()); assert(path.basename(home).startsWith('dw-panel-latency-'))
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

test('isolated production Electron panels are populated, reusable and race-safe; controlled click latency', { timeout: 90000 }, async () => {
  await fs.mkdir(evidence, { recursive: true })
  const trials = Number(process.env.DW_PANEL_TRIALS ?? 1), before = [], after = []
  for (let index = 0; index < trials; index++) {
    if (process.env.DW_PANEL_BEFORE_BUILD) before.push(await sample(process.env.DW_PANEL_BEFORE_BUILD, `before-${index}`))
    after.push(await sample(process.env.DW_PANEL_BUILD || 'out', `after-${index}`, index === trials - 1))
  }
  const result = { metric: 'renderer capture-phase click to first rAF with effective opacity >= 0.05 / enabled populated control also hit-testable at its center, milliseconds; not shell-only or universal hardware timings', snapshotIpcDelayMs: Number(process.env.DW_PANEL_DELAY_MS ?? 200), before, after }
  await fs.writeFile(path.join(evidence, 'controlled-comparison.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
})
