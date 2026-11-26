'use strict'

// Copied ONLY into the disposable A/B ASARs by update-rehearsal.cjs. Neither
// package.json nor the shipping main entry includes this file or its feed hook.
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'update-rehearsal.json'), 'utf8'))
if (process.platform !== 'win32' || path.resolve(process.execPath).toLowerCase() !== path.resolve(config.executable).toLowerCase()) {
  throw new Error('Rehearsal bootstrap may run only inside its disposable installation')
}
const runtime = JSON.parse(fs.readFileSync(config.runtime, 'utf8'))
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.origin)) throw new Error('Rehearsal feed must be private loopback')
process.env.NODE_ENV = 'test'
process.env.DW_TEST_USERDATA = config.profile
process.env.DW_TEST_FIXTURE_DIR = config.fixtureDir
process.env.DW_TEST_PRICING_ORIGIN = runtime.origin
delete process.env.PORTABLE_EXECUTABLE_FILE
const log = (event, data = {}) => fs.appendFileSync(path.join(config.evidence, 'updater-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: app.getVersion(), event, ...data }) + '\n')
log('binary-started', { executable: process.execPath, packaged: app.isPackaged, appPath: app.getAppPath() })

const { NsisUpdater } = require('electron-updater')
const originalCheck = NsisUpdater.prototype.checkForUpdates
NsisUpdater.prototype.checkForUpdates = function (...args) {
  // This is the sole behavioral override: the actual application's hidden
  // NsisUpdater instance, state machine, downloads and installer stay intact.
  this.setFeedURL({ provider: 'generic', url: `${runtime.origin}/feed/` })
  log('upstream-check', { autoDownload: this.autoDownload, autoInstallOnAppQuit: this.autoInstallOnAppQuit, allowDowngrade: this.allowDowngrade, allowPrerelease: this.allowPrerelease })
  this.logger = {
    info: message => log('upstream-info', { message: String(message) }),
    warn: message => log('upstream-warning', { message: String(message) }),
    error: message => log('upstream-error', { message: String(message) }),
    debug: message => log('upstream-debug', { message: String(message) })
  }
  return originalCheck.apply(this, args)
}
for (const name of ['downloadUpdate', 'quitAndInstall', 'doInstall', 'spawnLog']) {
  const original = NsisUpdater.prototype[name]
  NsisUpdater.prototype[name] = function (...args) {
    log(`upstream-${name}`, { args })
    const result = original.apply(this, args)
    if (name === 'downloadUpdate') return Promise.resolve(result).then(value => {
      log('upstream-downloaded', { installer: this.installerPath })
      return value
    })
    return result
  }
}

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('did-finish-load', () => {
    const url = window.webContents.getURL()
    if (!url.startsWith('file:') || !url.includes('index.html') || url.includes('window=')) return
    setTimeout(async () => {
      try {
        const snapshot = await window.webContents.executeJavaScript(`(async () => {
          const settings = await window.ds.getSettings();
          const sessions = await window.ds.sessionsList();
          return {
            update: await window.ds.updatesGet(),
            settings: { userPresetPrompt: settings.userPresetPrompt, autoCheckUpdates: settings.autoCheckUpdates, credentialConfigured: settings.apiKey === '__CONFIGURED__' },
            drafts: await window.ds.composerDraftsList(),
            sessions: await Promise.all(sessions.map(async session => ({ id: session.id, messages: await window.ds.sessionsLoad(session.id) })))
          };
        })()`)
        log('renderer-ready', { profile: app.getPath('userData'), snapshot })
        const screenshot = await window.webContents.capturePage()
        fs.writeFileSync(path.join(config.evidence, `restarted-${app.getVersion()}-${process.pid}.png`), screenshot.toPNG())
      } catch (error) { log('renderer-probe-error', { message: error.message }) }
    }, 1500).unref()
  })
})
app.on('will-quit', () => log('binary-will-quit'))
require('./out/main/index.js')
