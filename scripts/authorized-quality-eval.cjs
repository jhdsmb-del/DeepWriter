'use strict'

// One owner-authorized, bounded assessment. This is not a key export command.
// The existing desktop settings are read only; decryption and the child key
// remain in process memory. Neither a key nor a decrypted settings file is saved.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { remainingAuthorization } = require('./authorized-eval-budget.cjs')

const root = path.resolve(__dirname, '..')
const checkOnly = process.argv.includes('--check')
const followup = process.argv.includes('--followup')
const finalRepair = process.argv.includes('--repair-final')
if (followup && finalRepair) throw new Error('Choose one explicit assessment batch')
const sourceSettings = path.join(process.env.APPDATA || '', 'DeepWriter', 'settings.json')
const temporaryProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-authorized-eval-'))
// Windows OSCrypt needs the profile's DPAPI-wrapped encryption key. Copy only
// its encrypted Local State into the isolated process, never the live database.
const encryptionState = path.join(path.dirname(sourceSettings), 'Local State')
if (fs.existsSync(encryptionState)) fs.copyFileSync(encryptionState, path.join(temporaryProfile, 'Local State'), fs.constants.COPYFILE_EXCL)
app.setPath('userData', temporaryProfile)
app.commandLine.appendSwitch('disable-gpu')
let child = null
let key = ''
let timer = null
let exitCode = 1

const finish = (code) => {
  if (timer) clearTimeout(timer)
  key = ''
  try { fs.unlinkSync(path.join(temporaryProfile, 'Local State')) } catch { /* already absent */ }
  try { fs.rmSync(temporaryProfile, { recursive: true, force: true }) } catch { /* open runtime files may remain, with no copied encryption state */ }
  app.exit(code)
}

const cleanText = (value) => {
  const text = String(value)
  return key ? text.split(key).join('[REDACTED]') : text
}
app.whenReady().then(() => {
  if (new Date().toISOString().slice(0, 10) !== '2026-10-03') throw new Error('This authorization price snapshot is dated 2026-10-03; reverify prices before another run')
  const settings = JSON.parse(fs.readFileSync(sourceSettings, 'utf8'))
  if (settings.baseUrl !== 'https://api.deepseek.com') throw new Error('Saved endpoint is not the authorized DeepSeek endpoint')
  if (!safeStorage.isEncryptionAvailable() || typeof settings.apiKeyEnc !== 'string' || !settings.apiKeyEnc) throw new Error('Existing encrypted DeepSeek credential is unavailable')
  key = safeStorage.decryptString(Buffer.from(settings.apiKeyEnc, 'base64'))
  if (!key.trim()) throw new Error('Existing DeepSeek credential is empty')
  if (checkOnly) {
    console.log(JSON.stringify({ credentialAvailable: true, endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', maxCostCny: 5, networkRequests: 0 }))
    exitCode = 0
    finish(exitCode)
    return
  }
  const entry = path.join(root, 'out', 'eval-runner.mjs')
  if (!fs.existsSync(entry)) throw new Error('Build the existing eval runner before this bounded assessment')
  const evidenceDir = path.join(root, 'out', 'commercial-quality')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const firstAuthorization = path.join(evidenceDir, 'owner-authorization-20261003.json')
  let limit = { maxCostCny: 5, maxRequests: 40 }
  if (followup || finalRepair) {
    if (!fs.existsSync(firstAuthorization)) throw new Error('Original owner-authorized assessment is missing')
    const previousManifest = path.join(evidenceDir, 'eval', 'run-2026-10-03T02-15-07-849Z', 'manifest.json')
    const manifests = [previousManifest]
    if (finalRepair) {
      if (!fs.existsSync(path.join(evidenceDir, 'owner-authorization-followup-20261003.json'))) throw new Error('Previous repair assessment is missing')
      manifests.push(path.join(evidenceDir, 'eval', 'run-2026-10-03T02-57-24-678Z', 'manifest.json'))
    }
    limit = { ...remainingAuthorization(manifests.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))), previousManifests: manifests.map((file) => path.relative(root, file)) }
  }
  // A failed run is not an implicit authorization for another ¥5 run.
  const authorizationPath = finalRepair ? path.join(evidenceDir, 'owner-authorization-repair-final-20261003.json') : followup ? path.join(evidenceDir, 'owner-authorization-followup-20261003.json') : firstAuthorization
  fs.writeFileSync(authorizationPath, JSON.stringify({ date: '2026-10-03', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com', ...limit, status: 'started' }, null, 2), { flag: 'wx' })
  const args = [entry, '--real', '--experiment=trajectory', '--task=longform-multichapter', '--repeats=1', '--scale=1', '--save-content', '--model=deepseek-flash', `--max-requests=${limit.maxRequests}`, `--max-cost-cny=${limit.maxCostCny}`, `--price-profile=${path.join(__dirname, 'eval-prices-deepseek-flash-20261003.json')}`, '--trust-price-profile-hash=9fd3dd98ca199438aef3b4f6e0e254cafb19db31c79930c6c6d15b666287422f', '--pricing-provider-id=deepseek', '--out-dir=out/commercial-quality']
  child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DEEPSEEK_API_KEY: key, DEEPSEEK_BASE_URL: 'https://api.deepseek.com' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // Buffer by line so a secret split across chunks cannot escape redaction.
  const pipe = (stream, target) => {
    let pending = ''
    stream.on('data', (chunk) => {
      pending += chunk.toString()
      let split
      while ((split = pending.indexOf('\n')) >= 0) {
        target.write(cleanText(pending.slice(0, split + 1)))
        pending = pending.slice(split + 1)
      }
    })
    stream.on('end', () => { if (pending) target.write(cleanText(pending)) })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  timer = setTimeout(() => { console.error('Assessment time limit reached; result is incomplete, not PASS'); child.kill(); }, 30 * 60 * 1000)
  child.on('error', () => { console.error('Assessment child could not start'); finish(1) })
  child.on('close', (code) => { exitCode = Number.isInteger(code) ? code : 1; finish(exitCode) })
}).catch((error) => { console.error(cleanText(error.message)); finish(1) })
app.on('will-quit', () => {
  if (timer) clearTimeout(timer)
  key = ''
  // Only remove the exact isolated profile created above, never owner data.
  if (path.dirname(temporaryProfile) === os.tmpdir() && path.basename(temporaryProfile).startsWith('deepwriter-authorized-eval-')) {
    try { fs.rmSync(temporaryProfile, { recursive: true, force: true }) } catch { /* an open Electron file may remain */ }
  }
  process.exitCode = exitCode
})
