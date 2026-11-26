// Actual Electron responsive-layout evidence. Isolated persisted fixtures only;
// no CSS injection, remote API, model generation, or build performed here.
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { _electron: electron, expect } = require('@playwright/test')
const ROOT = process.cwd()
const baseline = process.argv.includes('--baseline')
const nativeDpi = process.argv.includes('--native-dpi')
const output = path.join(ROOT, 'out/compact-window-layout', `${baseline ? 'before' : 'after'}-${nativeDpi ? 'native-dpi-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}`)
const draftText = '最大化后，内容区应自然展开，输入框保持原有比例。'
const sha = file => fs.readFile(path.join(ROOT, file)).then(bytes => createHash('sha256').update(bytes).digest('hex'))
const walk = node => [node, ...(node.children ?? []).flatMap(walk), ...(node.shadowRoots ?? []).flatMap(walk)]
let passed = 0, failed = 0
const checks = [], errors = [], observations = []
const check = (name, condition) => { checks.push({ name, pass: condition }); condition ? passed++ : failed++; console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`) }

;(async () => {
  await fs.mkdir(output, { recursive: true })
  const html = await fs.readFile(path.join(ROOT, 'out/renderer/index.html'), 'utf8')
  const js = 'out/renderer/' + html.match(/src="\.\/(assets\/index-[^"]+\.js)"/)[1]
  const css = 'out/renderer/' + html.match(/href="\.\/(assets\/index-[^"]+\.css)"/)[1]
  const bundles = async () => ({ main: await sha('out/main/index.js'), rendererJs: await sha(js), rendererCss: await sha(css), rendererHtml: await sha('out/renderer/index.html') })
  const hashesBefore = await bundles()
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const sourceDirty = execFileSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' })
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-window-layout-'))
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ workDir: userData, docDir: userData, apiKey: '', baseUrl: 'http://127.0.0.1:1', thinkingEnabled: true, reasoningEffort: 'high' }))
  // The supported legacy import writes canonical persisted messages on startup.
  // Open them through the actual session sidebar, not by mutating renderer state.
  const sessions = path.join(userData, 'sessions')
  await fs.mkdir(sessions)
  await fs.writeFile(path.join(sessions, 'index.json'), JSON.stringify([{ id: 'window-layout-fixture', title: '窗口布局验收', createdAt: Date.now(), updatedAt: Date.now(), model: 'deepseek-chat' }]))
  await fs.writeFile(path.join(sessions, 'window-layout-fixture.jsonl'), [
    { type: 'message', message: { id: 'layout-user', role: 'user', content: '请帮我把这段文字整理得清楚一点。', status: 'done' } },
    { type: 'message', message: { id: 'layout-assistant', role: 'assistant', content: '## 清楚表达，保留留白\n\n窗口变宽时，写作空间也应该舒展开来。输入区、消息和活动信息沿同一个中心轴排列，避免最大化后仍挤在一条窄栏里。\n\n正文保持舒适的阅读行长。这里是一段本地保存的布局验收文字，不是模型生成结果。\n\n- 内容区随窗口展开\n- 字号与按钮保持稳定\n- 恢复窗口后，草稿和浮层继续可用', status: 'done' } }
  ].map(item => JSON.stringify(item)).join('\n'))
  const app = await electron.launch({ executablePath: require('electron'), args: [ROOT, ...(nativeDpi ? [] : ['--force-device-scale-factor=1'])], env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData } })
  const page = await app.firstWindow()
  const reachableWideWidth = nativeDpi ? await app.evaluate(({ screen }) => Math.min(1920, screen.getPrimaryDisplay().workArea.width - 40)) : 1920
  const child = app.process()
  const logs = { stdout: '', stderr: '' }
  child.stdout?.on('data', chunk => { logs.stdout += chunk })
  child.stderr?.on('data', chunk => { logs.stderr += chunk })
  let exitStatus = null
  child.once('exit', (code, signal) => { exitStatus = { code, signal } })
  page.on('pageerror', error => errors.push(error.stack ?? error.message))
  const setWidth = async width => {
    await app.evaluate(({ BrowserWindow }, w) => {
      const win = BrowserWindow.getAllWindows().find(item => !item.webContents.getURL().includes('window=float'))
      if (win.isMaximized()) win.unmaximize()
      win.setContentSize(w, 900, false)
      win.center()
    }, width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(width - 2)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(width + 2)
  }
  const snapshot = async label => {
    await page.waitForTimeout(180)
    const windowInfo = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find(item => !item.webContents.getURL().includes('window=float'))
      const display = screen.getDisplayMatching(win.getBounds())
      return { title: win.getTitle(), contentSize: win.getContentSize(), bounds: win.getBounds(), maximized: win.isMaximized(), zoomFactor: win.webContents.getZoomFactor(), zoomLevel: win.webContents.getZoomLevel(), display: { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor } }
    })
    const dom = await page.evaluate(() => {
      const geometry = selector => {
        const element = document.querySelector(selector)
        if (!element) return null
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, fontSize: style.fontSize, maxWidth: style.maxWidth, padding: style.padding, display: style.display }
      }
      return { dpr: devicePixelRatio, innerWidth, innerHeight, title: document.title, overflow: document.documentElement.scrollWidth > innerWidth, workspace: geometry('.dw-workspace'), dock: geometry('.dw-composer-dock'), composer: geometry('.composer'), textarea: geometry('.composer textarea'), footer: geometry('.composer-modebar'), send: geometry('.composer-send'), transcript: geometry('.message-list'), messageColumn: geometry('.message-list-inner'), assistant: geometry('.msg.assistant .msg-bubble'), markdown: geometry('.msg.assistant .markdown-body'), empty: geometry('.dw-empty-state') }
    })
    const info = { label, windowInfo, dom }
    observations.push(info)
    check(`${label}: native viewport/zoom and111px/32px controls`, windowInfo.zoomFactor === 1 && Math.abs(windowInfo.contentSize[0] - dom.innerWidth) <= 1 && dom.composer.height === 111 && dom.send.width === 32 && dom.footer.height === 42 && dom.textarea.fontSize === '14px' && !dom.overflow)
    const pixels = await page.screenshot({ path: path.join(output, `${label}.png`), animations: 'disabled' })
    info.pngPixels = { width: pixels.readUInt32BE(16), height: pixels.readUInt32BE(20) }
    console.log(JSON.stringify(info))
    return info
  }
  try {
    await page.locator('.composer').waitFor()
    await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(draftText)
    await setWidth(1280)
    await snapshot('empty-1280')
    await page.getByRole('button', { name: /^窗口布局验收/ }).click()
    await page.locator('.msg.assistant').waitFor()
    await page.locator('.msg.assistant .markdown-body').waitFor()
    await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(draftText)
    const widths = []
    for (const width of [800, 1024, 1280, reachableWideWidth]) {
      await setWidth(width)
      widths.push(await snapshot(`messages-${width}`))
    }
    await setWidth(1280)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('window=float')).maximize())
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('window=float')).isMaximized())).toBe(true)
    const maximized = await snapshot('messages-maximized')
    if (!baseline) {
      const middle = widths[2].dom, wide = widths[3].dom
      check(`${reachableWideWidth}/maximized: composer/message column expand beyond1280`, [wide, maximized.dom].every(layout => layout.composer.width > middle.composer.width + 200 && layout.messageColumn.width > middle.messageColumn.width + 200))
      check('shared content axis at every width', [...widths, maximized].every(({ dom }) => Math.abs(dom.composer.x - dom.messageColumn.x) <= 2 && Math.abs(dom.composer.width - dom.messageColumn.width) <= 2))
      check('wide assistant remains readable', wide.markdown.width <= 900 && wide.markdown.width < wide.messageColumn.width)
    }
    const restoreRequest = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(item => !item.webContents.getURL().includes('window=float'))
      const before = { maximized: win.isMaximized(), bounds: win.getBounds(), normalBounds: win.getNormalBounds() }
      win.unmaximize()
      return { before, immediatelyAfter: { maximized: win.isMaximized(), bounds: win.getBounds() } }
    })
    observations.push({ label: 'native-unmaximize-request', ...restoreRequest })
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('window=float')).isMaximized())).toBe(false)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(1278)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(1282)
    const restored = await snapshot('messages-restored-1280')
    check('native restore preserves width/draft', Math.abs(restored.dom.composer.width - widths[2].dom.composer.width) <= 1 && await page.getByRole('textbox', { name: '任务内容', exact: true }).inputValue() === draftText)
    const trigger = page.getByTestId('model-reasoning-trigger')
    await trigger.click()
    const panel = page.getByTestId('model-reasoning-panel')
    await panel.waitFor()
    await expect.poll(async () => (await panel.boundingBox()).width).toBe(300)
    const slider = page.getByRole('slider', { name: '思考强度', exact: true })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
    const nodes = walk((await cdp.send('DOM.getDocument', { depth: -1, pierce: true })).root)
    const range = nodes.find(node => node.nodeName === 'INPUT' && node.attributes?.includes('range'))
    const descendants = walk(range)
    const track = descendants.find(node => node.attributes?.includes('track'))
    const thumb = descendants.find(node => node.attributes?.includes('thumb'))
    const trackBox = (await cdp.send('DOM.getBoxModel', { nodeId: track.nodeId })).model
    const thumbBox = (await cdp.send('DOM.getBoxModel', { nodeId: thumb.nodeId })).model
    const popup = await panel.boundingBox()
    check('restored model popup300px/native capsule14px/thumb26px', popup.width === 300 && popup.height <= 134 && trackBox.height === 14 && thumbBox.width === 26 && thumbBox.height === 26)
    await slider.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab')
    const focus = await slider.evaluate(element => ({ visible: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineWidth, radius: getComputedStyle(element).borderRadius }))
    check('keyboard capsule focus preserved', focus.visible && focus.outline === '2px' && focus.radius === '999px')
    await panel.screenshot({ path: path.join(output, 'strength-keyboard-focus.png'), animations: 'disabled' })
    const composer = await page.locator('.composer').boundingBox()
    await page.screenshot({ path: path.join(output, 'composer-and-strength.png'), animations: 'disabled', clip: { x: composer.x - 4, y: popup.y - 4, width: composer.width + 8, height: composer.y + composer.height - popup.y + 8 } })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reducedTransition = (await cdp.send('CSS.getComputedStyleForNode', { nodeId: thumb.nodeId })).computedStyle.find(style => style.name === 'transition-duration')?.value
    check('native thumb reduced-motion0s', reducedTransition === '0s')
    await panel.getByRole('button', { name: '选择模型', exact: true }).click()
    const names = await panel.locator('.dw-model-reasoning-option b').allTextContents()
    check('names-only current model and alias folding', await trigger.innerText() === 'DeepSeek V4.1-Flash' && names.filter(name => name === 'DeepSeek V4.1-Flash').length === 1 && await panel.locator('small').count() === 0)
    await panel.screenshot({ path: path.join(output, 'models-card.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    check('ESC restores focus and draft', await trigger.evaluate(element => document.activeElement === element) && await page.getByRole('textbox', { name: '任务内容', exact: true }).inputValue() === draftText)
    observations.push({ label: 'restored-controls', popup, trackBox, thumbBox, focus, reducedTransition, names })
    const profileBefore = await page.evaluate(async () => {
      const snapshot = (await window.ds.providerSnapshot()).data
      return snapshot.profiles.find(profile => profile.id === (snapshot.bindings.draftProfileId ?? snapshot.bindings.defaultProfileId))
    })
    await page.getByRole('button', { name: '长文', exact: true }).click()
    await page.getByTestId('longform-workflow-shell').waitFor()
    const longform = []
    for (const label of ['1280', String(reachableWideWidth), 'maximized']) {
      if (label === 'maximized') {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('window=float')).maximize())
        await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('window=float')).isMaximized())).toBe(true)
      } else await setWidth(Number(label))
      await page.waitForTimeout(180)
      const layout = await page.evaluate(() => {
        const rect = selector => { const element = document.querySelector(selector); if (!element) return null; const box = element.getBoundingClientRect(); return { x: box.x, width: box.width, maxWidth: getComputedStyle(element).maxWidth } }
        return { innerWidth, innerHeight, dpr: devicePixelRatio, workspace: rect('.dw-workspace'), flow: rect('.dw-workspace-flow'), shell: rect('.longform-workflow-shell'), main: rect('.dw-longform-main-column'), grill: rect('.grill-me-workbench'), question: rect('.grill-me-question') }
      })
      longform.push(layout)
      await page.screenshot({ path: path.join(output, `longform-${label}.png`), animations: 'disabled' })
      console.log(`longform-${label}: ${JSON.stringify(layout)}`)
    }
    // At1280 the rail is1197px with the native scroll gutter;1440px is
    // a243px expansion, not250px. Assert the actual cap plus clear growth.
    if (!baseline) check('longform rail expands to1440 beyond1280 without nested cap', longform[1].flow.width === 1440 && longform[1].flow.width > longform[0].flow.width + 200 && longform[1].shell.width === longform[1].flow.width)
    observations.push({ label: 'longform-rails', layouts: longform, grillRendered: longform.some(layout => layout.grill !== null) })
    await setWidth(1280)
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    const profileAfter = await page.evaluate(async () => {
      const snapshot = (await window.ds.providerSnapshot()).data
      return snapshot.profiles.find(profile => profile.id === (snapshot.bindings.draftProfileId ?? snapshot.bindings.defaultProfileId))
    })
    check('workspace resize preserves draft/model/real reasoning Profile', await page.getByRole('textbox', { name: '任务内容', exact: true }).inputValue() === draftText && profileBefore.modelId === profileAfter.modelId && JSON.stringify(profileBefore.reasoning) === JSON.stringify(profileAfter.reasoning))
    const recoverable = await page.evaluate(async () => await window.ds.runsRecoverable())
    check('no recoverable runs created by layout verification', Array.isArray(recoverable) && recoverable.length === 0)
    check('new native/document title', maximized.windowInfo.title === 'DeepWriter — 文本写作助手' && maximized.dom.title === maximized.windowInfo.title)
    check('no renderer errors', errors.length === 0)
  } catch (error) {
    failed++; errors.push(error.stack); console.error(error.stack)
    const nativeFailure = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ id: win.id, url: win.webContents.getURL(), maximized: win.isMaximized(), bounds: win.getBounds(), normalBounds: win.getNormalBounds() }))).catch(() => null)
    observations.push({ label: 'native-failure-state', windows: nativeFailure })
    await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }).catch(() => {})
  } finally {
    const shutdownStarted = Date.now()
    const exit = new Promise(resolve => { if (exitStatus) return resolve(exitStatus); child.once('exit', (code, signal) => resolve({ code, signal })); setTimeout(() => resolve({ code: null, signal: null, timeout: true }), 15000).unref() })
    void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('window=float')).close()).catch(() => {})
    exitStatus = await exit
    exitStatus.elapsedMs = Date.now() - shutdownStarted
    check('natural Electron exit0', exitStatus.code === 0 && exitStatus.signal === null)
    const hashesAfter = await bundles()
    check('bundle hashes stable throughout verification', JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter))
    await fs.writeFile(path.join(output, 'electron-stdout.log'), logs.stdout)
    await fs.writeFile(path.join(output, 'electron-stderr.log'), logs.stderr)
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ baseline, verificationScope: 'existing-compiled-bundle-layout-only', sourceBuildPerformed: false, productionBuildTest: false, productionBuildAcceptance: false, existingBundleLayoutAcceptance: !baseline && failed === 0, cssInjection: false, generationInvokedByVerifier: false, requestedDeviceScaleFactor: nativeDpi ? null : 1, passed, failed, sourceCommit, sourceDirty, js, css, hashesBefore, hashesAfter, userData, exitStatus, checks, errors, observations }, null, 2))
    console.log(`Window layout scoped: ${passed} PASS / ${failed} FAIL\n${output}`)
    process.exitCode = failed ? 1 : 0
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
