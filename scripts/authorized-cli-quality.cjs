'use strict'

// Preparation and one bounded, two-phase assessment of the actual default CLI.
// No credential lookup occurs on import, --preflight, or in the local tests.
// The old three paid assessments remain read-only. 80 is our internal attempt
// guard, NOT a new owner authorization; the owner's cumulative cap remains ¥5.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const https = require('node:https')
const { spawn } = require('node:child_process')
const { createHash, randomBytes } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { remainingAuthorization } = require('./authorized-eval-budget.cjs')

const ROOT = path.resolve(__dirname, '..')
const MODEL = 'deepseek-flash'
const ORIGIN = 'https://api.deepseek.com'
const DATE = '2026-10-03'
const PRICE_HASH = '9fd3dd98ca199438aef3b4f6e0e254cafb19db31c79930c6c6d15b666287422f'
const PRICE_WINDOW_MS = 30 * 60 * 1000
const PRICE_SOURCE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const OFF_PEAK_SCHEDULE = 'utc_weekdays_peak_01-04_06-10_else_off_peak_no_holiday_override'
const DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003')
const SECOND_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r2')
const THIRD_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r3')
const FOURTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r4')
const FIFTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r5')
const SIXTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r6')
const SEVENTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r7')
const EIGHTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r8')
const NINTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r9')
const TENTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r10')
const ELEVENTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r11')
const TWELFTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r12')
const THIRTEENTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r13')
const FOURTEENTH_DIRECTORY = path.join(ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r14')
const PREVIOUS = ['2026-10-03T02-15-07-849Z', '2026-10-03T02-57-24-678Z', '2026-10-03T05-18-09-126Z'].map(id => path.join(ROOT, 'out/commercial-quality/eval', 'run-' + id, 'manifest.json'))
const children = new Set()
const TASK = '写一篇8000字单篇第三人称有限视角悬疑小说。故事完全虚构：海边旧灯塔，同一晚23:00至次日破晓，主视角林舟。在场有且只有林舟和顾岚；两人是旧友，克制地互相试探，不新增具名人物。起点是值班室，林舟持手电筒，顾岚持档案柜钥匙；地点只限值班室、档案室、塔顶。顾岚要关停灯塔，林舟要取回旧海难档案附页；通过具体行动和少量对白揭示顾岚隐瞒那晚一次错误开闸记录。附页最终被保留；两人不和解，但作出保护档案的决定。无超自然、无新增支线、无大段回忆，不写标题分章或作者说教。注意同晚相对时间和物品归属，留余味但完整结束。只输出连续小说正文。'
const ANSWERS = Object.freeze({
  goal: '林舟取回旧海难档案附页，揭示顾岚隐瞒那晚一次错误开闸记录；附页最终被保留。',
  audience: '读者范围未指定；结尾留余味，但故事必须完整结束。',
  tone: '悬疑，克制互相试探，通过具体行动和少量对白揭示隐瞒；不要作者说教。',
  scope: '地点只限值班室、档案室、塔顶；在场有且只有林舟和顾岚。不新增具名人物、支线、超自然或大段回忆。',
  evidence: '全部素材为本次测试明确提供的虚构设定，不引用真实海难或私人文件；未指定的细节不要猜成既定事实。',
  format: '8000字单篇第三人称有限视角小说，主视角林舟，只输出连续正文，无标题分章。',
  conflict: '顾岚要关停灯塔；林舟要取回旧海难档案附页。顾岚隐瞒那晚一次错误开闸记录。',
  structure: '从两人在值班室起步，通过具体行动和少量对白推进到隐瞒被揭示；不新增支线或大段回忆。',
  ending: '附页最终被保留，两人不和解，但作出保护档案的决定；留余味但完整结束。',
  characters: '林舟为唯一主视角，顾岚是其旧友；在场有且只有两人，克制互相试探，不新增具名人物。',
  setting: '海边旧灯塔，同一晚23:00至次日破晓；起点值班室，地点只限值班室、档案室、塔顶。无超自然。',
  references: '未提供具体作品或作者风格参考。不要大段回忆、标题分章或作者说教。',
  mustKeep: '林舟起初持手电筒，顾岚起初持档案柜钥匙；保持物品归属和同晚相对时间。顾岚隐瞒错误开闸记录，附页最终被保留，两人不和解但保护档案。'
})
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const micros = value => { if (!Number.isFinite(value) || value < 0) throw new Error('Invalid financial amount'); return Math.ceil(value * 1e6) }
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
function atomicJson(file, value) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp'
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  try { fs.renameSync(temporary, file) } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}
function exclusiveJson(file, value) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp'
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    fs.linkSync(temporary, file) // Atomic publication, refusing an existing record.
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}
async function accountingHelpers(directory) {
  fs.mkdirSync(directory, { recursive: true })
  const outfile = path.join(directory, 'existing-accounting.mjs')
  await require('esbuild').build({ absWorkingDir: ROOT, entryPoints: [path.join(ROOT, 'scripts/eval-preflight.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', tsconfigRaw: {}, plugins: [{ name: 'bounded-existing-accounting-source', setup(builder) {
    builder.onResolve({ filter: /^(\.\.?\/|[A-Za-z]:[\\/])/ }, args => {
      const target = path.resolve(args.resolveDir || ROOT, args.path)
      const found = ['', '.ts'].map(extension => target + extension).find(fs.existsSync)
      if (!found || !found.startsWith(path.join(ROOT, 'scripts') + path.sep)) throw new Error('Accounting helper left the existing script boundary')
      return { path: found, namespace: 'bounded-accounting' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'bounded-accounting' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
  } }] })
  return import(pathToFileURL(outfile).href)
}
function inheritedAuthorization(files = PREVIOUS, read = json) {
  const manifests = files.map(file => read(file))
  for (const item of manifests) if (item.endpointOrigin !== ORIGIN || item.priceProfileHash !== PRICE_HASH || item.model !== MODEL) throw new Error('Previous paid assessment identity changed')
  const limit = remainingAuthorization(manifests, 5, 80)
  return { ...limit, ownerCapCny: 5, internalCumulativeRequestGuard: 80, previousManifests: files.map((file, index) => ({ path: path.relative(ROOT, file).replaceAll('\\', '/'), sha256: sha(JSON.stringify(manifests[index])) })) }
}
function verifyPrice(helpers, profile) {
  if (!helpers.priceProfileValidate(profile).ok || profile.updatedAt !== DATE || profile.providerId !== 'deepseek' || profile.currency !== 'CNY' || profile.unit !== 'per-1M-tokens' || helpers.priceProfileHash(profile) !== PRICE_HASH) throw new Error('Dated trusted price reference changed')
  const match = helpers.matchPriceEntry(profile, MODEL, ORIGIN, 'CNY')
  if (!match.ok || match.entry.inputPer1M !== 1 || match.entry.outputPer1M !== 4 || match.entry.cacheHitPer1M !== 0.02) throw new Error('Native provider price identity changed')
  return match.entry
}
function isOffPeak(at) {
  if (!Number.isSafeInteger(at)) return false
  const date = new Date(at); const day = date.getUTCDay(); const hour = date.getUTCHours()
  if (!Number.isFinite(date.getTime())) return false
  // Official UTC peak hours: weekdays 01-04 and 06-10. Public-holiday
  // exceptions are deliberately not inferred; a peak weekday fails closed.
  return day === 0 || day === 6 || !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
}
function verificationTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) throw new Error('Price verification time is not explicit UTC')
  const at = Date.parse(value)
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('Price verification time is invalid')
  return at
}
function verifyPriceVerification({ directory, expectedSha256, at = Date.now(), read = fs.readFileSync }) {
  const assessment = directory === SECOND_DIRECTORY ? 'r2' : directory === THIRD_DIRECTORY ? 'r3' : directory === FOURTH_DIRECTORY ? 'r4' : directory === FIFTH_DIRECTORY ? 'r5' : directory === SIXTH_DIRECTORY ? 'r6' : directory === SEVENTH_DIRECTORY ? 'r7' : directory === EIGHTH_DIRECTORY ? 'r8' : directory === NINTH_DIRECTORY ? 'r9' : directory === TENTH_DIRECTORY ? 'r10' : directory === FOURTEENTH_DIRECTORY ? 'r14' : directory === THIRTEENTH_DIRECTORY ? 'r13' : directory === TWELFTH_DIRECTORY ? 'r12' : directory === ELEVENTH_DIRECTORY ? 'r11' : null
  if (!assessment || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha256) || !Number.isSafeInteger(at)) throw new Error('Only fixed r2/r3/r4/r5/r6/r7/r8/r9/r10/r11/r12/r13/r14 may use explicitly hash-pinned price verification')
  const bytes = read(path.join(directory, 'price-verification.json'))
  if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024 || sha(bytes) !== expectedSha256) throw new Error('Price verification receipt is missing or changed')
  const receipt = JSON.parse(bytes.toString('utf8'))
  const peakPricingMode = directory === FOURTEENTH_DIRECTORY ? 'r14_peak_price_upper_bound_only' : directory === THIRTEENTH_DIRECTORY ? 'r13_peak_price_upper_bound_only' : directory === TWELFTH_DIRECTORY ? 'r12_peak_price_upper_bound_only' : directory === ELEVENTH_DIRECTORY ? 'r11_peak_price_upper_bound_only' : directory === TENTH_DIRECTORY ? 'r10_peak_price_upper_bound_only' : directory === NINTH_DIRECTORY ? 'r9_peak_price_upper_bound_only' : directory === EIGHTH_DIRECTORY ? 'r8_peak_price_upper_bound_only' : 'r7_peak_price_upper_bound_only'
  const peakUpperOnly = (directory === SEVENTH_DIRECTORY || directory === EIGHTH_DIRECTORY || directory === NINTH_DIRECTORY || directory === TENTH_DIRECTORY || directory === ELEVENTH_DIRECTORY || directory === TWELFTH_DIRECTORY || directory === THIRTEENTH_DIRECTORY || directory === FOURTEENTH_DIRECTORY) && receipt.purpose === peakPricingMode
  if (receipt.schemaVersion !== 1 || (!peakUpperOnly && receipt.purpose !== 'equivalent_price_window_only') || receipt.assessment !== assessment || receipt.canonicalOrigin !== ORIGIN || receipt.model !== MODEL || receipt.currency !== 'CNY' || receipt.unit !== 'per-1M-tokens' || receipt.priceProfileHash !== PRICE_HASH || receipt.sourceUrl !== PRICE_SOURCE_URL || receipt.priceBand !== (peakUpperOnly ? 'peak' : 'off_peak') || receipt.schedule !== OFF_PEAK_SCHEDULE) throw new Error('Price verification identity is not the original native price authorization')
  if (receipt.entry?.model !== MODEL || receipt.entry?.inputPer1M !== 1 || receipt.entry?.outputPer1M !== 4 || receipt.entry?.cacheHitPer1M !== 0.02) throw new Error('Verified price is not equivalent to the original conservative entry')
  const effective = receipt.effectivePriceBound
  if (peakUpperOnly && (!effective || JSON.stringify(Object.keys(effective).sort()) !== JSON.stringify(['cacheHitPer1M', 'inputPer1M', 'model', 'outputPer1M', 'sourceSha256', 'sourceUrl']) || effective.model !== MODEL || effective.inputPer1M !== 2 || effective.cacheHitPer1M !== 0.04 || effective.outputPer1M !== 8 || effective.sourceUrl !== PRICE_SOURCE_URL || effective.sourceSha256 !== receipt.sourceSha256)) throw new Error(directory === FOURTEENTH_DIRECTORY ? 'R14 peak conservative price bound or its pinned source changed' : directory === THIRTEENTH_DIRECTORY ? 'R13 peak conservative price bound or its pinned source changed' : directory === TWELFTH_DIRECTORY ? 'R12 peak conservative price bound or its pinned source changed' : directory === ELEVENTH_DIRECTORY ? 'R11 peak conservative price bound or its pinned source changed' : directory === TENTH_DIRECTORY ? 'R10 peak conservative price bound or its pinned source changed' : directory === NINTH_DIRECTORY ? 'R9 peak conservative price bound or its pinned source changed' : directory === EIGHTH_DIRECTORY ? 'R8 peak conservative price bound or its pinned source changed' : 'R7 peak conservative price bound or its pinned source changed')
  if ((directory === SEVENTH_DIRECTORY || directory === EIGHTH_DIRECTORY || directory === NINTH_DIRECTORY || directory === TENTH_DIRECTORY || directory === ELEVENTH_DIRECTORY || directory === TWELFTH_DIRECTORY || directory === THIRTEENTH_DIRECTORY || directory === FOURTEENTH_DIRECTORY) && !peakUpperOnly && effective !== undefined) throw new Error(directory === FOURTEENTH_DIRECTORY ? 'Effective peak price bounds are restricted to explicitly pinned R14 peak mode' : directory === THIRTEENTH_DIRECTORY ? 'Effective peak price bounds are restricted to explicitly pinned R13 peak mode' : directory === TWELFTH_DIRECTORY ? 'Effective peak price bounds are restricted to explicitly pinned R12 peak mode' : directory === ELEVENTH_DIRECTORY ? 'Effective peak price bounds are restricted to explicitly pinned R11 peak mode' : directory === TENTH_DIRECTORY ? 'Effective peak price bounds are restricted to explicitly pinned R10 peak mode' : directory === NINTH_DIRECTORY ? 'Effective peak price bounds are restricted to explicitly pinned R9 peak mode' : directory === EIGHTH_DIRECTORY ? 'Effective peak price bounds are restricted to explicitly pinned R8 peak mode' : 'Effective peak price bounds are restricted to explicitly pinned R7 peak mode')
  const sourceFetchedAt = verificationTime(receipt.sourceFetchedAt); const verifiedAt = verificationTime(receipt.verifiedAt); const expiresAt = verificationTime(receipt.expiresAt)
  if (sourceFetchedAt > verifiedAt || verifiedAt > at || expiresAt <= at || expiresAt <= verifiedAt || expiresAt > sourceFetchedAt + PRICE_WINDOW_MS || (!peakUpperOnly && !isOffPeak(at))) throw new Error('Price verification is future, stale, expired or outside off-peak time')
  const source = read(path.join(directory, 'price-verification-source.html'))
  if (!Buffer.isBuffer(source) || !source.length || source.length > 2 * 1024 * 1024 || typeof receipt.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.sourceSha256) || sha(source) !== receipt.sourceSha256) throw new Error('Pinned official price evidence is missing or changed')
  // The root explicitly audits the fetched official fields and pins this raw
  // receipt hash. Merely writing a self-referential source hash is not approval.
  const verification = { receiptSha256: expectedSha256, sourceSha256: receipt.sourceSha256, priceProfileHash: PRICE_HASH, sourceFetchedAt, verifiedAt, expiresAt }
  return peakUpperOnly ? { ...verification, pricingMode: peakPricingMode, effectivePriceBound: { model: MODEL, inputPer1M: 2, cacheHitPer1M: 0.04, outputPer1M: 8, sourceUrl: PRICE_SOURCE_URL, sourceSha256: receipt.sourceSha256 } } : verification
}
function verifyRequestExtension({ directory, expectedSha256, authorization, originalAuthorizationHash, financialStartedAt, at = Date.now(), read = fs.readFileSync }) {
  if (![ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].includes(directory) || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha256) || !Number.isSafeInteger(at)) throw new Error('Only fixed R11/R12/R13/R14 may use explicitly pinned original supplemental owner request authorization')
  if (!authorization || authorization.ownerCapCny !== 5 || authorization.internalCumulativeRequestGuard !== 80 || authorization.previousRequests !== 30 || authorization.maxRequests !== 50 || micros(authorization.previousSpentUpperCny) + micros(authorization.maxCostCny) !== 5000000 || originalAuthorizationHash !== sha(JSON.stringify(authorization)) || !Number.isSafeInteger(financialStartedAt)) throw new Error('Original R11 financial authorization identity changed')
  const bytes = read(path.join(ELEVENTH_DIRECTORY, 'owner-request-extension.json')) // R12/R13/R14 reuse the immutable original R11 owner receipt; no new authorization.
  if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 || sha(bytes) !== expectedSha256) throw new Error('Supplemental owner request authorization is missing or changed')
  const receipt = JSON.parse(bytes.toString('utf8'))
  const keys = ['additionalRequests', 'approvedAt', 'assessment', 'effectiveCumulativeRequestGuard', 'financialStartedAt', 'originalAuthorizationHash', 'originalCumulativeRequestGuard', 'ownerApproval', 'ownerCapCny', 'purpose', 'schemaVersion']
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(keys) || receipt.schemaVersion !== 1 || receipt.purpose !== 'r11_owner_request_guard_extension_only' || receipt.assessment !== 'r11' || receipt.ownerApproval !== 'explicit_user_approval' || receipt.originalAuthorizationHash !== originalAuthorizationHash || receipt.financialStartedAt !== financialStartedAt || receipt.originalCumulativeRequestGuard !== 80 || receipt.additionalRequests !== 40 || receipt.effectiveCumulativeRequestGuard !== 120 || receipt.ownerCapCny !== 5) throw new Error('Supplemental owner authorization cannot change financial identity, fees or approved request bounds')
  const approvedAt = verificationTime(receipt.approvedAt)
  if (approvedAt < financialStartedAt || approvedAt > at) throw new Error('Supplemental owner authorization time is invalid')
  return { receiptSha256: expectedSha256, originalAuthorizationHash, financialStartedAt, additionalRequests: 40, effectiveCumulativeRequestGuard: 120, effectiveLedgerRequestGuard: 90 }
}
function createLedger({ file, authorization, profile, helpers, phase, now = Date.now, directory = DIRECTORY, priceVerification, requestExtension }) {
  assessmentDirectory(directory)
  if ([ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].includes(directory) && !requestExtension) throw new Error('Fixed R11 requires explicitly pinned original supplemental owner request authorization')
  if (![ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].includes(directory) && requestExtension) throw new Error('Supplemental request authorization is restricted to fixed R11/R12/R13/R14')
  const requestExtensionPin = requestExtension?.expectedSha256
  let requestExtensionVerification = null
  let effectiveRequestGuard = authorization.maxRequests
  let r7PeakPriceBound = null
  const peakPricingMode = directory === FOURTEENTH_DIRECTORY ? 'r14_peak_price_upper_bound_only' : directory === THIRTEENTH_DIRECTORY ? 'r13_peak_price_upper_bound_only' : directory === TWELFTH_DIRECTORY ? 'r12_peak_price_upper_bound_only' : directory === ELEVENTH_DIRECTORY ? 'r11_peak_price_upper_bound_only' : directory === TENTH_DIRECTORY ? 'r10_peak_price_upper_bound_only' : directory === NINTH_DIRECTORY ? 'r9_peak_price_upper_bound_only' : directory === EIGHTH_DIRECTORY ? 'r8_peak_price_upper_bound_only' : 'r7_peak_price_upper_bound_only'
  if (priceVerification && ![SECOND_DIRECTORY, THIRD_DIRECTORY, FOURTH_DIRECTORY, FIFTH_DIRECTORY, SIXTH_DIRECTORY, SEVENTH_DIRECTORY, EIGHTH_DIRECTORY, NINTH_DIRECTORY, TENTH_DIRECTORY, ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].includes(directory)) throw new Error('Price-window renewal is restricted to fixed r2/r3/r4/r5/r6/r7/r8/r9/r10/r11/r12/r13/r14 assessments')
  if (directory === THIRD_DIRECTORY || directory === FOURTH_DIRECTORY || directory === FIFTH_DIRECTORY || directory === SIXTH_DIRECTORY || directory === SEVENTH_DIRECTORY || directory === EIGHTH_DIRECTORY || directory === NINTH_DIRECTORY || directory === TENTH_DIRECTORY || directory === ELEVENTH_DIRECTORY || directory === TWELFTH_DIRECTORY || directory === THIRTEENTH_DIRECTORY || directory === FOURTEENTH_DIRECTORY) {
    if (!priceVerification) throw new Error('Later assessment requires explicitly hash-pinned equivalent price verification')
    const verification = verifyPriceVerification({ ...priceVerification, directory, at: now() })
    if ((directory === SEVENTH_DIRECTORY || directory === EIGHTH_DIRECTORY || directory === NINTH_DIRECTORY || directory === TENTH_DIRECTORY || directory === ELEVENTH_DIRECTORY || directory === TWELFTH_DIRECTORY || directory === THIRTEENTH_DIRECTORY || directory === FOURTEENTH_DIRECTORY) && verification.pricingMode === peakPricingMode) r7PeakPriceBound = verification.effectivePriceBound
  }
  if (directory !== DIRECTORY && !fs.existsSync(file)) throw new Error('Later assessment cannot create a new original financial ledger')
  const entry = verifyPrice(helpers, profile)
  const authorizationHash = sha(JSON.stringify(authorization))
  let state
  if (fs.existsSync(file)) {
    state = json(file)
    if (state.authorizationHash !== authorizationHash || state.model !== MODEL || state.endpointOrigin !== ORIGIN || state.priceProfileHash !== PRICE_HASH || state.hardCapProtected !== true || !Array.isArray(state.attempts) || !Number.isSafeInteger(state.startedAt)) throw new Error('Financial ledger identity or protection is invalid')
    if (requestExtension) {
      requestExtensionVerification = verifyRequestExtension({ ...requestExtension, expectedSha256: requestExtensionPin, directory, authorization, originalAuthorizationHash: authorizationHash, financialStartedAt: state.startedAt, at: now() })
      effectiveRequestGuard = requestExtensionVerification.effectiveLedgerRequestGuard
    }
    const ids = new Set()
    for (const item of state.attempts) {
      if (!Number.isInteger(item.id) || item.id < 1 || ids.has(item.id) || !Number.isSafeInteger(item.reservedMicros) || item.reservedMicros < 0 || !['pending', 'settled'].includes(item.status) || (item.status === 'settled' && (!Number.isSafeInteger(item.chargedUpperMicros) || item.chargedUpperMicros < 0))) throw new Error('Financial ledger attempt is invalid')
      ids.add(item.id)
    }
    const spent = state.attempts.filter(item => item.status === 'settled').reduce((sum, item) => sum + item.chargedUpperMicros, 0)
    const pending = state.attempts.filter(item => item.status === 'pending').reduce((sum, item) => sum + item.reservedMicros, 0)
    if (state.requestsUsed !== state.attempts.length || state.spentUpperMicros !== spent || state.inflightReservedMicros !== pending || !Number.isSafeInteger(spent + pending) || spent + pending > micros(authorization.maxCostCny) || state.requestsUsed > effectiveRequestGuard) throw new Error('Financial ledger totals are inconsistent')
    // A crashed process cannot free an uncertain request. Charge its entire
    // pre-egress reservation before permitting any later phase to send.
    for (const item of state.attempts) if (item.status === 'pending') { item.status = 'settled'; item.outcome = 'previous_process_unsettled'; item.chargedUpperMicros = item.reservedMicros; item.actualMicros = null; item.settledAt = now() }
    state.spentUpperMicros += pending; state.inflightReservedMicros = 0
    atomicJson(file, state)
  } else {
    state = { schemaVersion: 1, model: MODEL, endpointOrigin: ORIGIN, priceProfileHash: PRICE_HASH, authorizationHash, authorization, hardCapProtected: true, requestsUsed: 0, spentUpperMicros: 0, inflightReservedMicros: 0, attempts: [], startedAt: now() }
    atomicJson(file, state)
  }
  const persist = () => atomicJson(file, state)
  const snapshot = () => structuredClone({ ...state, spentUpperCny: state.spentUpperMicros / 1e6, inflightReservedCny: state.inflightReservedMicros / 1e6, cumulativeSpentUpperCny: (micros(authorization.previousSpentUpperCny) + state.spentUpperMicros + state.inflightReservedMicros) / 1e6, cumulativeRequests: authorization.previousRequests + state.requestsUsed })
  const assertRequestExtension = (at = now()) => requestExtension ? verifyRequestExtension({ ...requestExtension, expectedSha256: requestExtensionPin, directory, authorization, originalAuthorizationHash: authorizationHash, financialStartedAt: state.startedAt, at }) : null
  const assertWindow = () => {
    const at = now()
    assertRequestExtension(at)
    if (priceVerification) return verifyPriceVerification({ ...priceVerification, directory, at })
    if (at < state.startedAt || at - state.startedAt > PRICE_WINDOW_MS) throw new Error('Dated assessment window exhausted before egress')
    return null
  }
  return {
    snapshot, assertWindow,
    reserve(bodyJson) {
      if (!state.hardCapProtected) throw new Error('Financial cap is no longer provable')
      const verification = assertWindow() // Re-read/pin evidence before EVERY route/attempt.
      const extension = requestExtensionVerification // Only fixed R11/R12/R13/R14 derive 90 local / 120 cumulative; original authorization is immutable.
      if (directory === THIRD_DIRECTORY || directory === FOURTH_DIRECTORY || directory === FIFTH_DIRECTORY || directory === SIXTH_DIRECTORY || directory === SEVENTH_DIRECTORY || directory === EIGHTH_DIRECTORY || directory === NINTH_DIRECTORY || directory === TENTH_DIRECTORY || directory === ELEVENTH_DIRECTORY || directory === TWELFTH_DIRECTORY || directory === THIRTEENTH_DIRECTORY || directory === FOURTEENTH_DIRECTORY) {
        verifyPrice(helpers, profile)
        if (JSON.stringify(json(file)) !== JSON.stringify(state)) throw new Error('Original financial ledger changed before egress')
      }
      let body; try { body = JSON.parse(bodyJson) } catch { throw new Error('Request body is not JSON') }
      if (body.model !== MODEL || body.stream !== true || !Array.isArray(body.messages) || !body.messages.length || !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 4096) throw new Error('Request is outside the native/default CLI authorization')
      if (body.thinking && body.thinking.type !== 'disabled') throw new Error('This assessment uses the default non-thinking CLI route')
      const bound = helpers.utf8BodyTokenCeiling(bodyJson)
      if (r7PeakPriceBound && (verification?.pricingMode !== peakPricingMode || JSON.stringify(verification.effectivePriceBound) !== JSON.stringify(r7PeakPriceBound))) throw new Error(directory === FOURTEENTH_DIRECTORY ? 'R14 peak price bound changed before egress' : directory === THIRTEENTH_DIRECTORY ? 'R13 peak price bound changed before egress' : directory === TWELFTH_DIRECTORY ? 'R12 peak price bound changed before egress' : directory === ELEVENTH_DIRECTORY ? 'R11 peak price bound changed before egress' : directory === TENTH_DIRECTORY ? 'R10 peak price bound changed before egress' : directory === NINTH_DIRECTORY ? 'R9 peak price bound changed before egress' : directory === EIGHTH_DIRECTORY ? 'R8 peak price bound changed before egress' : 'R7 peak price bound changed before egress')
      const effectiveEntry = r7PeakPriceBound || entry
      const reservedMicros = micros((bound.ceiling * effectiveEntry.inputPer1M + body.max_tokens * effectiveEntry.outputPer1M) / 1e6)
      if (state.requestsUsed >= effectiveRequestGuard) throw new Error('Cumulative internal request guard reached')
      if (state.spentUpperMicros + state.inflightReservedMicros + reservedMicros > micros(authorization.maxCostCny)) throw new Error('Cumulative owner financial cap would be exceeded')
      const attempt = { id: state.requestsUsed + 1, phase, requestHash: sha(bodyJson), requestBytes: bound.bytes, inputTokenCeiling: bound.ceiling, outputTokenCeiling: body.max_tokens, reservedMicros, status: 'pending', reservedAt: now() }
      if (verification) attempt.priceVerificationSha256 = verification.receiptSha256
      if (extension) { attempt.requestExtensionReceiptSha256 = extension.receiptSha256; attempt.effectiveCumulativeRequestGuard = extension.effectiveCumulativeRequestGuard; attempt.effectiveLedgerRequestGuard = extension.effectiveLedgerRequestGuard }
      if (r7PeakPriceBound) { attempt.pricingMode = peakPricingMode; attempt.effectivePriceBound = structuredClone(r7PeakPriceBound); attempt.actualAmountConfirmed = false }
      state.requestsUsed++; state.inflightReservedMicros += reservedMicros; state.attempts.push(attempt)
      persist() // This must succeed BEFORE an upstream request is constructed.
      return attempt.id
    },
    settle(id, usage, outcome) {
      const attempt = state.attempts.find(item => item.id === id)
      if (!attempt || attempt.status !== 'pending') throw new Error('Reservation is absent or already settled')
      if (requestExtension) {
        const extension = assertRequestExtension(attempt.reservedAt)
        if (attempt.requestExtensionReceiptSha256 !== extension.receiptSha256 || attempt.effectiveCumulativeRequestGuard !== 120 || attempt.effectiveLedgerRequestGuard !== effectiveRequestGuard || JSON.stringify(json(file)) !== JSON.stringify(state)) throw new Error('R11/R12/R13/R14 reserved owner request pin or original financial ledger changed before settlement')
      }
      const safeUsage = usage && Object.fromEntries(['prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'reasoning_tokens'].filter(key => usage[key] !== undefined).map(key => [key, usage[key]]))
      const validUsage = safeUsage && Object.values(safeUsage).every(value => Number.isSafeInteger(value) && value >= 0)
      if (r7PeakPriceBound) {
        // Settlement re-reads the SAME root pin/source at reservation time,
        // not a later discount. Drift/concurrent ledger writes cannot refund
        // the already held upper reservation. This never confirms a bill.
        const verification = verifyPriceVerification({ ...priceVerification, directory, at: attempt.reservedAt })
        if (attempt.pricingMode !== peakPricingMode || verification.pricingMode !== attempt.pricingMode || attempt.priceVerificationSha256 !== verification.receiptSha256 || JSON.stringify(attempt.effectivePriceBound) !== JSON.stringify(r7PeakPriceBound) || JSON.stringify(verification.effectivePriceBound) !== JSON.stringify(r7PeakPriceBound) || JSON.stringify(json(file)) !== JSON.stringify(state)) throw new Error(directory === FOURTEENTH_DIRECTORY ? 'R14 reserved pin/effective price bound or original ledger changed before settlement' : directory === THIRTEENTH_DIRECTORY ? 'R13 reserved pin/effective price bound or original ledger changed before settlement' : directory === TWELFTH_DIRECTORY ? 'R12 reserved pin/effective price bound or original ledger changed before settlement' : directory === ELEVENTH_DIRECTORY ? 'R11 reserved pin/effective price bound or original ledger changed before settlement' : directory === TENTH_DIRECTORY ? 'R10 reserved pin/effective price bound or original ledger changed before settlement' : directory === NINTH_DIRECTORY ? 'R9 reserved pin/effective price bound or original ledger changed before settlement' : directory === EIGHTH_DIRECTORY ? 'R8 reserved pin/effective price bound or original ledger changed before settlement' : 'R7 reserved pin/effective price bound or original ledger changed before settlement')
        const trustedUsage = outcome === 'success' && validUsage && Number.isSafeInteger(safeUsage.prompt_tokens) && Number.isSafeInteger(safeUsage.completion_tokens)
        const usageUpper = trustedUsage ? micros((safeUsage.prompt_tokens * r7PeakPriceBound.inputPer1M + safeUsage.completion_tokens * r7PeakPriceBound.outputPer1M) / 1e6) : attempt.reservedMicros
        const exceeded = trustedUsage && (safeUsage.prompt_tokens > attempt.inputTokenCeiling || safeUsage.completion_tokens > attempt.outputTokenCeiling || usageUpper > attempt.reservedMicros)
        if (exceeded) state.hardCapProtected = false
        const charged = exceeded ? Math.max(usageUpper, attempt.reservedMicros) : usageUpper
        attempt.status = 'settled'; attempt.outcome = outcome; attempt.chargedUpperMicros = charged
        attempt.actualMicros = null; attempt.actualAmountConfirmed = false; attempt.usage = validUsage ? safeUsage : null; attempt.settledAt = now()
        attempt.upperBoundBasis = trustedUsage ? 'reported_usage_all_miss_at_pinned_peak_not_actual_billed' : 'full_pinned_peak_pre_egress_reservation'
        state.inflightReservedMicros -= attempt.reservedMicros; state.spentUpperMicros += charged
        persist()
        return
      }
      const cost = validUsage ? helpers.computeSampleCost(safeUsage, profile, MODEL) : 'unknown'
      const known = outcome === 'success' && cost !== 'unknown' && cost.actualKnown === true
      // Always charge a conservative all-miss upper, even when actual cache
      // pricing is known. Invalid/absent usage keeps the entire reservation.
      const charged = known ? Math.max(micros(cost.upper), micros(cost.total)) : attempt.reservedMicros
      if (known && (safeUsage.prompt_tokens > attempt.inputTokenCeiling || safeUsage.completion_tokens > attempt.outputTokenCeiling || charged > attempt.reservedMicros)) state.hardCapProtected = false
      attempt.status = 'settled'; attempt.outcome = outcome; attempt.chargedUpperMicros = charged
      attempt.actualMicros = known ? micros(cost.total) : null; attempt.usage = validUsage ? safeUsage : null; attempt.settledAt = now()
      state.inflightReservedMicros -= attempt.reservedMicros; state.spentUpperMicros += charged
      persist()
    },
    settlePending(outcome = 'relay_closed_without_trusted_usage') {
      for (const attempt of state.attempts.filter(item => item.status === 'pending')) this.settle(attempt.id, null, outcome)
    }
  }
}

function responseEvidenceWarning(id) {
  try { process.stderr.write(`Private response evidence unavailable for attempt ${id}\n`) } catch {}
}
function privateResponseEvidence({ directory, attempt, secrets }) {
  const maxCapturedSseBytes = 2 * 1024 * 1024
  const needles = secrets.map(secret => Buffer.from(secret))
  const tailBytes = Math.max(...needles.map(needle => needle.length)) - 1
  const chunks = []; let capturedBytes = 0; let observedSseBytes = 0; let tail = Buffer.alloc(0); let redacted = false
  if (!Number.isSafeInteger(attempt?.id) || attempt.id < 1 || typeof attempt.phase !== 'string' || attempt.phase.length > 64 || !/^[a-f0-9]{64}$/u.test(attempt.requestHash)) throw new Error('Response evidence identity unavailable')
  return {
    observe(chunk) {
      observedSseBytes += chunk.length
      if (!redacted) {
        const scan = Buffer.concat([tail, chunk])
        redacted = needles.some(needle => scan.includes(needle))
        tail = scan.subarray(Math.max(0, scan.length - tailBytes))
      }
      const retained = Math.min(chunk.length, maxCapturedSseBytes - capturedBytes)
      if (retained > 0) { chunks.push(Buffer.from(chunk.subarray(0, retained))); capturedBytes += retained }
    },
    finish(outcome) {
      try {
        // A secret anywhere in the stream discards the entire private payload,
        // including any partial secret at the capture boundary. Forwarding is unchanged.
        const payload = redacted ? Buffer.from('[REDACTED_SECRET_ECHO]') : Buffer.concat(chunks)
        const truncated = observedSseBytes > capturedBytes
        const completed = outcome === 'success' && !truncated
        const payloadBase64 = payload.toString('base64')
        const evidence = { schemaVersion: 1, attemptId: attempt.id, phase: attempt.phase, requestHash: attempt.requestHash, outcome, completed, truncated, redacted,
          maxCapturedSseBytes, observedSseBytes, capturedSseBytes: payload.length, payloadEncoding: 'base64', encodedPayloadBytes: payloadBase64.length,
          capturedSha256: sha(payload), rawSha256: completed && !redacted ? sha(payload) : null, payloadBase64 }
        // Base64 has fixed 4/3 storage overhead; the retained upstream SSE is <=2MiB.
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(directory, `attempt-${String(attempt.id).padStart(6, '0')}.json`), JSON.stringify(evidence) + '\n', { flag: 'wx', mode: 0o600 })
      } catch { responseEvidenceWarning(attempt.id) }
    }
  }
}

async function createRelay({ ledger, apiKey, target = ORIGIN, synthetic = false, timeoutMs = 180000, responseEvidenceDirectory }) {
  const url = new URL(target)
  if (synthetic ? !(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.origin === target) : target !== ORIGIN) throw new Error('Relay target is not the authorized exact origin')
  if (responseEvidenceDirectory && !synthetic && ![THIRD_DIRECTORY, FOURTH_DIRECTORY, FIFTH_DIRECTORY, SIXTH_DIRECTORY, SEVENTH_DIRECTORY, EIGHTH_DIRECTORY, NINTH_DIRECTORY, TENTH_DIRECTORY, ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].some(directory => responseEvidenceDirectory === path.join(directory, 'response-evidence'))) throw new Error('Private real response evidence is restricted to fixed r3/r4/r5/r6/r7/r8/r9/r10/r11/r12/r13/r14')
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)) throw new Error('Relay credential is unavailable')
  const localToken = randomBytes(32).toString('hex')
  const active = new Set()
  let closing = false
  let closePromise = null
  const server = http.createServer((req, res) => {
    if (closing || req.method !== 'POST' || req.url !== '/chat/completions' || req.headers.authorization !== 'Bearer ' + localToken || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { req.resume(); res.writeHead(403); res.end('Relay authorization refused'); return }
    const chunks = []; let size = 0
    req.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(); else chunks.push(chunk) })
    req.on('error', () => { if (!res.headersSent) res.writeHead(400); res.end('Request unavailable') })
    req.on('end', () => {
      let id; const bytes = Buffer.concat(chunks); const bodyJson = bytes.toString('utf8')
      if (!Buffer.from(bodyJson).equals(bytes) || bodyJson.includes(apiKey) || bodyJson.includes(localToken)) { res.writeHead(400); res.end('Unsafe request body'); return }
      try { id = ledger.reserve(bodyJson) } catch { res.writeHead(429); res.end('Bounded authorization refused before egress'); return }
      let settled = false; let usage = null; let usageInvalid = false; let doneSeen = false; let pending = ''; let responseEvidence = null
      const record = { upstream: null, finish: null }
      const finish = outcome => {
        if (settled) return
        settled = true; active.delete(record)
        try { ledger.settle(id, usageInvalid ? null : usage, outcome) } catch { closing = true; server.close(); res.destroy() }
        finally { responseEvidence?.finish(outcome) }
      }
      record.finish = finish; active.add(record)
      // node http(s).request never follows redirects. No caller-supplied
      // target, headers, proxy, or credential gets forwarded to another host.
      const upstream = (synthetic ? http : https).request(target + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', 'content-length': bytes.length }, timeout: timeoutMs }, response => {
        if (response.statusCode !== 200 || !/^text\/event-stream(?:;|$)/i.test(response.headers['content-type'] || '')) { response.resume(); finish(response.statusCode >= 300 && response.statusCode < 400 ? 'redirect_refused' : 'http_error'); res.writeHead(502); res.end('Provider response unavailable'); return }
        if (responseEvidenceDirectory) {
          try { responseEvidence = privateResponseEvidence({ directory: responseEvidenceDirectory, attempt: ledger.snapshot().attempts.find(attempt => attempt.id === id), secrets: [apiKey, localToken] }) }
          catch { responseEvidenceWarning(id) }
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        response.on('data', chunk => {
          responseEvidence?.observe(chunk)
          pending += chunk.toString('utf8')
          if (pending.length > 1024 * 1024) { usageInvalid = true; upstream.destroy(); finish('response_bound_exceeded'); res.destroy(); return }
          let split
          while ((split = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, split).replace(/\r$/, ''); pending = pending.slice(split + 1)
            if (!line.startsWith('data: ')) continue
            if (line === 'data: [DONE]') { doneSeen = true; continue }
            try { const event = JSON.parse(line.slice(6)); if (event.usage) { if (usage && JSON.stringify(usage) !== JSON.stringify(event.usage)) usageInvalid = true; usage = event.usage } } catch { usageInvalid = true }
          }
          res.write(chunk)
        })
        response.on('end', () => { finish(doneSeen ? 'success' : 'truncated_response'); res.end() })
        response.on('error', () => { finish('transport_error'); res.destroy() })
        response.on('aborted', () => { finish('aborted'); res.destroy() })
      })
      record.upstream = upstream
      upstream.on('timeout', () => { upstream.destroy(); finish('timeout'); res.destroy() })
      upstream.on('error', () => { finish('transport_error'); if (!res.headersSent) res.writeHead(502); res.end('Provider transport unavailable') })
      res.on('close', () => { if (!settled) { upstream.destroy(); finish('client_cancelled') } })
      upstream.end(bytes)
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, localToken,
    close() {
      if (!closePromise) closePromise = (async () => {
        closing = true
        for (const record of [...active]) { record.upstream?.destroy(); record.finish('relay_closed_without_trusted_usage') }
        ledger.settlePending()
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
        apiKey = ''
      })()
      return closePromise
    }
  }
}

function childEnvironment(localToken) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(name)))
  return { ...env, ELECTRON_RUN_AS_NODE: '1', DEEPWRITER_API_KEY: localToken }
}
async function cliCommand(bundle, args, relay, directory, { timeoutMs = 25 * 60 * 1000, redact = value => String(value).split(relay.localToken).join('[REDACTED]') } = {}) {
  // This child receives only the relay's ephemeral token, not the upstream
  // credential. Explicitly bind that selected env source to this relay origin;
  // a default official-origin key must never silently follow --base-url.
  const flags = ['--data-dir', path.join(directory, 'data'), '--base-url', relay.baseUrl, '--key-env', 'DEEPWRITER_API_KEY', '--loopback', '--json', '--doc-dir', path.join(directory, 'manuscripts'), '--work-dir', path.join(directory, 'workspace')]
  const child = spawn(process.execPath, [bundle, ...args, ...flags], { cwd: ROOT, env: childEnvironment(relay.localToken), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let stdout = '', stderr = '', exceeded = false
  const capture = (name, chunk) => { if (name === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString(); if (stdout.length + stderr.length > 4 * 1024 * 1024) { exceeded = true; child.kill() } }
  child.stdout.on('data', chunk => capture('stdout', chunk)); child.stderr.on('data', chunk => capture('stderr', chunk))
  let hardKill = null
  const timer = setTimeout(() => { child.kill(); hardKill = setTimeout(() => child.kill('SIGKILL'), 10000) }, timeoutMs)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', value => resolve(value)) }).finally(() => { children.delete(child); clearTimeout(timer); if (hardKill) clearTimeout(hardKill) })
  if (exceeded) throw new Error('CLI evidence exceeded its bounded output limit')
  const result = { code, stdout: redact(stdout), stderr: redact(stderr) }
  result.events = result.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  return result
}
function stateFrom(result) {
  if (result.code !== 0) throw new Error('CLI phase failed: ' + result.stderr.slice(0, 1000))
  const state = result.events.find(event => event.type === 'state')?.data
  if (!state) throw new Error('Actual CLI did not emit a durable interview state')
  return state
}
function factsHash(state) {
  if (!state || typeof state.stateId !== 'string' || !state.stateId || typeof state.sessionId !== 'string' || !state.sessionId || state.originalTask !== TASK || state.targetChars !== 8000 || !Array.isArray(state.slots) || !Array.isArray(state.answers) || !Array.isArray(state.assumptions)) throw new Error('Saved/durable original task or interview facts are invalid')
  return sha(JSON.stringify({ stateId: state.stateId, sessionId: state.sessionId, originalTask: state.originalTask, targetChars: state.targetChars,
    slots: state.slots.map(({ id, label, required, answer, source }) => ({ id, label, required, answer, source })),
    answers: state.answers.map(({ questionId, value, decision, source, kind }) => ({ questionId, value, decision, source, kind })), assumptions: state.assumptions }))
}
function savedOriginal(directory, bundle) {
  const bytes = fs.readFileSync(path.join(directory, 'outline.json')), record = JSON.parse(bytes.toString('utf8'))
  if (record.schemaVersion !== 1 || record.taskHash !== sha(TASK) || record.bundleSha256 !== sha(fs.readFileSync(bundle)) || record.sessionId !== record.state?.sessionId || !record.outlineHash || record.outlineHash !== record.state.outlineHash || record.state.outlineRevision !== 1 || record.state.status !== 'awaiting_outline_confirmation' || record.state.approvedOutline !== null || !record.state.outline) throw new Error('Saved original outline/session/task/bundle identity changed')
  return { record, bytes, sha256: sha(bytes), factsSha256: factsHash(record.state) }
}
function assertOriginalUnchanged(directory, bundle, original) {
  if (sha(fs.readFileSync(path.join(directory, 'outline.json'))) !== original.sha256 || sha(fs.readFileSync(bundle)) !== original.record.bundleSha256) throw new Error('Original outline bytes or prepared bundle changed during phase')
}
function freshWriteEvidence(directory) {
  if (['explicit-outline-approval.json', 'write-result.json'].some(file => fs.existsSync(path.join(directory, file)))) throw new Error('Existing approval/write result is not an authorization to replay')
}
function reoutlineFence(directory, bundle) {
  freshWriteEvidence(directory)
  if (fs.existsSync(path.join(directory, 'reoutline-attempt.json')) || fs.readdirSync(directory).some(name => name.startsWith('outline-revision-'))) throw new Error('Existing revision evidence: reoutline is allowed only once')
  return savedOriginal(directory, bundle)
}
function selectedOutline(directory, bundle, outlineRevision = 1) {
  if (![1, 2].includes(outlineRevision)) throw new Error('Only original or explicit outline revision2 is supported')
  if (fs.readdirSync(directory).some(name => name.startsWith('outline-revision-') && name !== 'outline-revision-2.json')) throw new Error('Unexpected additional outline revision evidence')
  const original = savedOriginal(directory, bundle)
  if (outlineRevision === 1) {
    if (fs.existsSync(path.join(directory, 'reoutline-attempt.json')) || fs.existsSync(path.join(directory, 'outline-revision-2.json'))) throw new Error('Separate explicit revision2 approval is required after reoutline')
    return { ...original, original, outlineRevision }
  }
  const attemptBytes = fs.readFileSync(path.join(directory, 'reoutline-attempt.json')), attempt = JSON.parse(attemptBytes)
  const bytes = fs.readFileSync(path.join(directory, 'outline-revision-2.json')), record = JSON.parse(bytes)
  if (attempt.schemaVersion !== 1 || attempt.phase !== 'reoutline' || attempt.outlineRevision !== 2 || attempt.originalOutlineSha256 !== original.sha256 || attempt.originalOutlineHash !== original.record.outlineHash || attempt.sessionId !== original.record.sessionId || attempt.bundleSha256 !== original.record.bundleSha256 || attempt.taskHash !== original.record.taskHash || attempt.factsSha256 !== original.factsSha256
    || record.schemaVersion !== 1 || record.outlineRevision !== 2 || record.originalOutlineSha256 !== original.sha256 || record.originalOutlineHash !== original.record.outlineHash || record.reoutlineAttemptSha256 !== sha(attemptBytes) || record.bundleSha256 !== original.record.bundleSha256 || record.taskHash !== original.record.taskHash || record.sessionId !== original.record.sessionId || !record.outlineHash || record.outlineHash === original.record.outlineHash || record.outlineHash !== record.state?.outlineHash || record.state.outlineRevision !== 2 || record.state.status !== 'awaiting_outline_confirmation' || record.state.approvedOutline !== null || factsHash(record.state) !== original.factsSha256) throw new Error('Explicit revision2 saved outline/attempt/original chain is invalid')
  return { record, bytes, sha256: sha(bytes), original, outlineRevision }
}
function unconfirmedState(state, saved, revision, factsSha256) {
  if (state.status !== 'awaiting_outline_confirmation' || state.approvedOutline !== null || state.sessionId !== saved.sessionId || state.outlineHash !== saved.outlineHash || state.outlineRevision !== revision || factsHash(state) !== factsSha256 || JSON.stringify(state.outline) !== JSON.stringify(saved.state.outline)) throw new Error('Durable CLI outline/facts changed or was already approved')
}
async function noBodyRuns(bundle, relay, directory, sessionId, command) {
  const result = await command(bundle, ['list'], relay, directory)
  const list = result.events?.find(event => event.type === 'list')?.data
  // Native `list` returns unfiltered recent runs plus all sessions. Requiring
  // zero runs globally fails closed even when its 100-row limit is reached.
  if (result.code !== 0 || !Array.isArray(list?.runs) || list.runs.length !== 0 || !Array.isArray(list.sessions) || list.sessions.length !== 1 || list.sessions[0].session_id !== sessionId) throw new Error('Isolated assessment has a body run or another/missing session')
}
async function reoutlinePhase({ bundle, relay, directory, command = cliCommand }) {
  if (directory === FIFTH_DIRECTORY) throw new Error('Fixed R5 never permits reoutline')
  if (directory === SIXTH_DIRECTORY) throw new Error('Fixed R6 never permits reoutline')
  if (directory === SEVENTH_DIRECTORY) throw new Error('Fixed R7 never permits reoutline')
  if (directory === EIGHTH_DIRECTORY) throw new Error('Fixed R8 never permits reoutline')
  if (directory === NINTH_DIRECTORY) throw new Error('Fixed R9 never permits reoutline')
  if (directory === TENTH_DIRECTORY) throw new Error('Fixed R10 never permits reoutline')
  if (directory === ELEVENTH_DIRECTORY) throw new Error('Fixed R11 never permits reoutline')
  if (directory === TWELFTH_DIRECTORY) throw new Error('Fixed R12 never permits reoutline')
  if (directory === THIRTEENTH_DIRECTORY) throw new Error('Fixed R13 never permits reoutline')
  if (directory === FOURTEENTH_DIRECTORY) throw new Error('Fixed R14 never permits reoutline')
  if (command === cliCommand && directory !== FOURTH_DIRECTORY) throw new Error('Real reoutline is restricted to fixed R4')
  const original = reoutlineFence(directory, bundle)
  const before = stateFrom(await command(bundle, ['status', original.record.sessionId], relay, directory))
  unconfirmedState(before, original.record, 1, original.factsSha256)
  await noBodyRuns(bundle, relay, directory, before.sessionId, command)
  assertOriginalUnchanged(directory, bundle, original)
  exclusiveJson(path.join(directory, 'reoutline-attempt.json'), { schemaVersion: 1, phase: 'reoutline', outlineRevision: 2, sessionId: before.sessionId, taskHash: original.record.taskHash, bundleSha256: original.record.bundleSha256, originalOutlineHash: original.record.outlineHash, originalOutlineSha256: original.sha256, factsSha256: original.factsSha256, startedAt: Date.now() })
  // The marker consumes this one explicit request even on failure/interruption.
  const state = stateFrom(await command(bundle, ['outline', before.sessionId], relay, directory))
  if (state.outlineRevision !== 2 || !state.outlineHash || state.outlineHash === original.record.outlineHash) throw new Error('Reoutline did not produce one new unconfirmed revision2')
  const saved = { schemaVersion: 1, outlineRevision: 2, taskHash: original.record.taskHash, bundleSha256: original.record.bundleSha256, sessionId: before.sessionId, outlineHash: state.outlineHash, state, approval: 'pending_explicit_root_confirmation', originalOutlineHash: original.record.outlineHash, originalOutlineSha256: original.sha256, reoutlineAttemptSha256: sha(fs.readFileSync(path.join(directory, 'reoutline-attempt.json'))) }
  unconfirmedState(state, saved, 2, original.factsSha256)
  unconfirmedState(stateFrom(await command(bundle, ['status', before.sessionId], relay, directory)), saved, 2, original.factsSha256)
  await noBodyRuns(bundle, relay, directory, before.sessionId, command)
  assertOriginalUnchanged(directory, bundle, original); freshWriteEvidence(directory)
  exclusiveJson(path.join(directory, 'outline-revision-2.json'), saved)
  return { sessionId: state.sessionId, outlineHash: state.outlineHash, outlineRevision: 2, status: state.status, targetChars: 8000 }
}
async function outlinePhase({ bundle, relay, directory, command = cliCommand }) {
  if (fs.existsSync(path.join(directory, 'outline.json'))) throw new Error('Existing outline must be inspected, not implicitly regenerated')
  let state = stateFrom(await command(bundle, ['write', TASK, '--target', '8000'], relay, directory))
  for (let turn = 0; turn < 32 && state.status !== 'outline_ready'; turn++) {
    if (!['interviewing', 'manual_completion'].includes(state.status) || !state.currentQuestion) throw new Error('Interview requires an explicit decision; no assumptions are automatically accepted')
    const question = state.currentQuestion
    const answer = question.kind === 'final_check' ? '没有了' : question.slotIds.map(id => ANSWERS[id] || '').join('\n')
    if (!answer.trim()) throw new Error('Question is outside the owner-specified fictional facts')
    state = stateFrom(await command(bundle, ['answer', state.sessionId, '--question', question.id, '--text', answer], relay, directory))
  }
  if (state.status !== 'outline_ready') throw new Error('Grill interview did not reach outline readiness')
  state = stateFrom(await command(bundle, ['outline', state.sessionId], relay, directory))
  if (state.status !== 'awaiting_outline_confirmation' || !state.outlineHash || state.targetChars !== 8000 || state.approvedOutline) throw new Error('Real outline has not reached the required separate approval fence')
  if (directory === SIXTH_DIRECTORY && state.outlineRevision !== 1) throw new Error('Fixed R6 outline must remain its original revision1')
  if (directory === SEVENTH_DIRECTORY && state.outlineRevision !== 1) throw new Error('Fixed R7 outline must remain its original revision1')
  if (directory === EIGHTH_DIRECTORY && state.outlineRevision !== 1) throw new Error('Fixed R8 outline must remain its original revision1')
  if (directory === NINTH_DIRECTORY && state.outlineRevision !== 1) throw new Error('Fixed R9 outline must remain its original revision1')
  if (directory === TENTH_DIRECTORY && state.outlineRevision !== 1) throw new Error('Fixed R10 outline must remain its original revision1')
  if (directory === ELEVENTH_DIRECTORY && state.outlineRevision !== 1) throw new Error('Fixed R11 outline must remain its original revision1')
  if (directory === TWELFTH_DIRECTORY && state.outlineRevision !== 1) throw new Error('Fixed R12 outline must remain its original revision1')
  if (directory === THIRTEENTH_DIRECTORY && state.outlineRevision !== 1) throw new Error('Fixed R13 outline must remain its original revision1')
  if (directory === FOURTEENTH_DIRECTORY && state.outlineRevision !== 1) throw new Error('Fixed R14 outline must remain its original revision1')
  atomicJson(path.join(directory, 'outline.json'), { schemaVersion: 1, taskHash: sha(TASK), bundleSha256: sha(fs.readFileSync(bundle)), sessionId: state.sessionId, outlineHash: state.outlineHash, state, approval: 'pending_explicit_root_confirmation' })
  return { sessionId: state.sessionId, outlineHash: state.outlineHash, status: 'awaiting_outline_confirmation', targetChars: 8000 }
}
async function writePhase({ bundle, relay, directory, approvedOutlineHash, outlineRevision = 1, command = cliCommand }) {
  if (directory === FIFTH_DIRECTORY && outlineRevision !== 1) throw new Error('Fixed R5 permits only its original revision1 outline')
  if (directory === SIXTH_DIRECTORY && outlineRevision !== 1) throw new Error('Fixed R6 permits only its original revision1 outline')
  if (directory === SEVENTH_DIRECTORY && outlineRevision !== 1) throw new Error('Fixed R7 permits only its original revision1 outline')
  if (directory === EIGHTH_DIRECTORY && outlineRevision !== 1) throw new Error('Fixed R8 permits only its original revision1 outline')
  if (directory === NINTH_DIRECTORY && outlineRevision !== 1) throw new Error('Fixed R9 permits only its original revision1 outline')
  if (directory === TENTH_DIRECTORY && outlineRevision !== 1) throw new Error('Fixed R10 permits only its original revision1 outline')
  if (directory === ELEVENTH_DIRECTORY && outlineRevision !== 1) throw new Error('Fixed R11 permits only its original revision1 outline')
  if (directory === TWELFTH_DIRECTORY && outlineRevision !== 1) throw new Error('Fixed R12 permits only its original revision1 outline')
  if (directory === THIRTEENTH_DIRECTORY && outlineRevision !== 1) throw new Error('Fixed R13 permits only its original revision1 outline')
  if (directory === FOURTEENTH_DIRECTORY && outlineRevision !== 1) throw new Error('Fixed R14 permits only its original revision1 outline')
  freshWriteEvidence(directory)
  const selected = selectedOutline(directory, bundle, outlineRevision), outline = selected.record
  if (!approvedOutlineHash || approvedOutlineHash !== outline.outlineHash) throw new Error('Separate explicit approval of this exact saved outline/bundle is required')
  const state = stateFrom(await command(bundle, ['status', outline.sessionId], relay, directory))
  unconfirmedState(state, outline, outlineRevision, selected.original.factsSha256)
  await noBodyRuns(bundle, relay, directory, state.sessionId, command)
  assertOriginalUnchanged(directory, bundle, selected.original)
  if (sha(fs.readFileSync(path.join(directory, outlineRevision === 2 ? 'outline-revision-2.json' : 'outline.json'))) !== selected.sha256) throw new Error('Selected saved outline changed before approval')
  exclusiveJson(path.join(directory, 'explicit-outline-approval.json'), { sessionId: state.sessionId, outlineHash: approvedOutlineHash, outlineRevision, outlineRecordSha256: selected.sha256, originalOutlineSha256: selected.original.sha256, actor: 'root_explicit_hash_command', approvedAt: Date.now() })
  const response = await command(bundle, ['confirm', state.sessionId, '--hash', approvedOutlineHash], relay, directory)
  const result = response.events.find(event => event.type === 'result')?.data
  const proof = result ? manuscriptProof(directory, result) : { status: 'incomplete', cliExitCode: response.code, error: response.stderr.slice(0, 1000) }
  exclusiveJson(path.join(directory, 'write-result.json'), { ...proof, outlineRevision, outlineHash: approvedOutlineHash, cliExitCode: response.code, realLiteraryQualityAccepted: false, note: 'File/hash/default-route evidence is not literary quality acceptance. No automatic continue, resume, semantic approval, or fact injection.' })
  return proof
}
function manuscriptProof(directory, result) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path.join(directory, 'data/deepwriter.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('select config_json,status,error_code from runs where run_id=?').get(result.runId)
    if (!row) throw new Error('Actual CLI run is absent from SQLite')
    const cfg = JSON.parse(row.config_json)
    if (cfg.grillMe?.targetChars !== 8000 || cfg.completionContract?.targetChars?.min !== 8000 || cfg.strongConstraints?.enabled !== true || cfg.cliProvider?.config?.model !== MODEL || cfg.cliProvider?.config?.maxTokens !== 4096 || cfg.cliProvider?.config?.thinking !== false || cfg.longMode !== true) throw new Error('Assessment is not the 8000-char actual default review-on CLI')
    const artifacts = db.prepare("select relative_path,hash,char_count,status from artifacts where run_id=? and artifact_type='manuscript'").all(result.runId)
    const attempts = db.prepare('select count(*) n from provider_call_attempts where run_id=?').get(result.runId).n
    const proof = { status: row.status, runId: result.runId, errorCode: row.error_code, targetChars: 8000, reviewEnabled: true, nativeModel: MODEL, cliProviderAttempts: attempts, artifacts }
    if (row.status !== 'completed') { if (artifacts.some(item => item.status === 'completed')) throw new Error('Incomplete run falsely registered a completed manuscript'); return proof }
    if (artifacts.length !== 1 || artifacts[0].status !== 'completed') throw new Error('Completed run lacks one genuine manuscript artifact')
    const artifact = artifacts[0]; const actualPath = fs.realpathSync(artifact.relative_path)
    if (path.dirname(actualPath) !== fs.realpathSync(path.join(directory, 'manuscripts'))) throw new Error('Manuscript escaped its isolated delivery directory')
    const content = fs.readFileSync(actualPath, 'utf8')
    const accepted = db.prepare("select content from manuscript_segments where run_id=? and status='accepted' and kind='prose' order by chunk_index,revision,created_at").all(result.runId).map(item => item.content).join('')
    const chars = Array.from(content).length
    if (content !== accepted || sha(content) !== artifact.hash || chars !== artifact.char_count || chars < 8000 || !/[。！？.!?][”’」』）)]*\s*$/u.test(content)) throw new Error('Manuscript file/hash/accepted projection/8000-char natural-close evidence is inconsistent')
    return { ...proof, manuscript: actualPath, sha256: artifact.hash, chars, acceptedProjectionMatchesFile: true, naturalSentenceClose: true }
  } finally { db.close() }
}

function assessmentDirectory(directory) {
  if (![DIRECTORY, SECOND_DIRECTORY, THIRD_DIRECTORY, FOURTH_DIRECTORY, FIFTH_DIRECTORY, SIXTH_DIRECTORY, SEVENTH_DIRECTORY, EIGHTH_DIRECTORY, NINTH_DIRECTORY, TENTH_DIRECTORY, ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].includes(directory)) throw new Error('Assessment directory is not an audited fixed leaf')
  return directory
}
function assessmentPaths(directory = DIRECTORY) {
  return { directory: assessmentDirectory(directory), budgetFile: path.join(DIRECTORY, 'relay-budget.json'), lockFile: path.join(DIRECTORY, 'authorized-execution.lock') }
}
function assertFreshR5Outline(directory) {
  if (directory !== FIFTH_DIRECTORY) return
  const paidState = ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']
  if (paidState.some(file => fs.existsSync(path.join(directory, file))) || (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith('outline-revision-')))) throw new Error('Fixed R5 outline attempt or paid state already exists; no retry or preparation overwrite')
}
function claimR5OutlineAttempt({ directory, prepared, ledger, now = Date.now }) {
  if (directory !== FIFTH_DIRECTORY) throw new Error('One-shot original outline marker is restricted to fixed R5')
  const paths = assessmentPaths(directory)
  const lock = json(paths.lockFile)
  if (lock.pid !== process.pid || lock.phase !== 'outline') throw new Error('Fixed R5 requires ownership of the original shared outline lock')
  ledger.assertWindow()
  const snapshot = ledger.snapshot()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...durable } = snapshot
  if (JSON.stringify(json(paths.budgetFile)) !== JSON.stringify(durable) || snapshot.authorizationHash !== sha(JSON.stringify(prepared.authorization)) || !/^[a-f0-9]{64}$/u.test(prepared.bundleSha256 || '') || !/^[a-f0-9]{64}$/u.test(prepared.buildReceiptSha256 || '')) throw new Error('Fixed R5 prepared identity or original financial ledger changed before its outline marker')
  assertFreshR5Outline(directory)
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt)) throw new Error('Fixed R5 outline attempt timestamp is invalid')
  const attempt = { schemaVersion: 1, assessment: 'r5', phase: 'outline', outlineRevision: 1, taskHash: sha(TASK), bundleSha256: prepared.bundleSha256, buildReceiptSha256: prepared.buildReceiptSha256, authorizationHash: snapshot.authorizationHash, financialStartedAt: snapshot.startedAt, startedAt }
  exclusiveJson(path.join(directory, 'outline-attempt.json'), attempt)
  return attempt
}
function assertFreshR6Outline(directory) {
  if (directory !== SIXTH_DIRECTORY) return
  const paidState = ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']
  if (paidState.some(file => fs.existsSync(path.join(directory, file))) || (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith('outline-revision-')))) throw new Error('Fixed R6 outline attempt or paid state already exists; no retry or preparation overwrite')
}
function claimR6OutlineAttempt({ directory, prepared, ledger, now = Date.now }) {
  if (directory !== SIXTH_DIRECTORY) throw new Error('One-shot original outline marker is restricted to fixed R6')
  const paths = assessmentPaths(directory)
  const lock = json(paths.lockFile)
  if (lock.pid !== process.pid || lock.phase !== 'outline') throw new Error('Fixed R6 requires ownership of the original shared outline lock')
  ledger.assertWindow()
  const snapshot = ledger.snapshot()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...durable } = snapshot
  if (JSON.stringify(json(paths.budgetFile)) !== JSON.stringify(durable) || snapshot.authorizationHash !== sha(JSON.stringify(prepared.authorization)) || !/^[a-f0-9]{64}$/u.test(prepared.bundleSha256 || '') || !/^[a-f0-9]{64}$/u.test(prepared.buildReceiptSha256 || '')) throw new Error('Fixed R6 prepared identity or original financial ledger changed before its outline marker')
  assertFreshR6Outline(directory)
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt)) throw new Error('Fixed R6 outline attempt timestamp is invalid')
  const attempt = { schemaVersion: 1, assessment: 'r6', phase: 'outline', outlineRevision: 1, taskHash: sha(TASK), bundleSha256: prepared.bundleSha256, buildReceiptSha256: prepared.buildReceiptSha256, authorizationHash: snapshot.authorizationHash, financialStartedAt: snapshot.startedAt, startedAt }
  exclusiveJson(path.join(directory, 'outline-attempt.json'), attempt)
  return attempt
}
function assertFreshR7Outline(directory) {
  if (directory !== SEVENTH_DIRECTORY) return
  const paidState = ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']
  if (paidState.some(file => fs.existsSync(path.join(directory, file))) || (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith('outline-revision-')))) throw new Error('Fixed R7 outline attempt or paid state already exists; no retry or preparation overwrite')
}
function claimR7OutlineAttempt({ directory, prepared, ledger, now = Date.now }) {
  if (directory !== SEVENTH_DIRECTORY) throw new Error('One-shot original outline marker is restricted to fixed R7')
  const paths = assessmentPaths(directory)
  const lock = json(paths.lockFile)
  if (lock.pid !== process.pid || lock.phase !== 'outline') throw new Error('Fixed R7 requires ownership of the original shared outline lock')
  ledger.assertWindow()
  const snapshot = ledger.snapshot()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...durable } = snapshot
  if (JSON.stringify(json(paths.budgetFile)) !== JSON.stringify(durable) || snapshot.authorizationHash !== sha(JSON.stringify(prepared.authorization)) || !/^[a-f0-9]{64}$/u.test(prepared.bundleSha256 || '') || !/^[a-f0-9]{64}$/u.test(prepared.buildReceiptSha256 || '')) throw new Error('Fixed R7 prepared identity or original financial ledger changed before its outline marker')
  assertFreshR7Outline(directory)
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt)) throw new Error('Fixed R7 outline attempt timestamp is invalid')
  const attempt = { schemaVersion: 1, assessment: 'r7', phase: 'outline', outlineRevision: 1, taskHash: sha(TASK), bundleSha256: prepared.bundleSha256, buildReceiptSha256: prepared.buildReceiptSha256, authorizationHash: snapshot.authorizationHash, financialStartedAt: snapshot.startedAt, startedAt }
  exclusiveJson(path.join(directory, 'outline-attempt.json'), attempt)
  return attempt
}
function assertFreshR8Outline(directory) {
  if (directory !== EIGHTH_DIRECTORY) return
  const paidState = ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']
  if (paidState.some(file => fs.existsSync(path.join(directory, file))) || (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith('outline-revision-')))) throw new Error('Fixed R8 outline attempt or paid state already exists; no retry or preparation overwrite')
}
function claimR8OutlineAttempt({ directory, prepared, ledger, now = Date.now }) {
  if (directory !== EIGHTH_DIRECTORY) throw new Error('One-shot original outline marker is restricted to fixed R8')
  const paths = assessmentPaths(directory)
  const lock = json(paths.lockFile)
  if (lock.pid !== process.pid || lock.phase !== 'outline') throw new Error('Fixed R8 requires ownership of the original shared outline lock')
  ledger.assertWindow()
  const snapshot = ledger.snapshot()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...durable } = snapshot
  if (JSON.stringify(json(paths.budgetFile)) !== JSON.stringify(durable) || snapshot.authorizationHash !== sha(JSON.stringify(prepared.authorization)) || !/^[a-f0-9]{64}$/u.test(prepared.bundleSha256 || '') || !/^[a-f0-9]{64}$/u.test(prepared.buildReceiptSha256 || '')) throw new Error('Fixed R8 prepared identity or original financial ledger changed before its outline marker')
  assertFreshR8Outline(directory)
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt)) throw new Error('Fixed R8 outline attempt timestamp is invalid')
  const attempt = { schemaVersion: 1, assessment: 'r8', phase: 'outline', outlineRevision: 1, taskHash: sha(TASK), bundleSha256: prepared.bundleSha256, buildReceiptSha256: prepared.buildReceiptSha256, authorizationHash: snapshot.authorizationHash, financialStartedAt: snapshot.startedAt, startedAt }
  exclusiveJson(path.join(directory, 'outline-attempt.json'), attempt)
  return attempt
}
function assertFreshR9Outline(directory) {
  if (directory !== NINTH_DIRECTORY) return
  const paidState = ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']
  if (paidState.some(file => fs.existsSync(path.join(directory, file))) || (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith('outline-revision-')))) throw new Error('Fixed R9 outline attempt or paid state already exists; no retry or preparation overwrite')
}
function claimR9OutlineAttempt({ directory, prepared, ledger, now = Date.now }) {
  if (directory !== NINTH_DIRECTORY) throw new Error('One-shot original outline marker is restricted to fixed R9')
  const paths = assessmentPaths(directory)
  const lock = json(paths.lockFile)
  if (lock.pid !== process.pid || lock.phase !== 'outline') throw new Error('Fixed R9 requires ownership of the original shared outline lock')
  ledger.assertWindow()
  const snapshot = ledger.snapshot()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...durable } = snapshot
  if (JSON.stringify(json(paths.budgetFile)) !== JSON.stringify(durable) || snapshot.authorizationHash !== sha(JSON.stringify(prepared.authorization)) || !/^[a-f0-9]{64}$/u.test(prepared.bundleSha256 || '') || !/^[a-f0-9]{64}$/u.test(prepared.buildReceiptSha256 || '')) throw new Error('Fixed R9 prepared identity or original financial ledger changed before its outline marker')
  assertFreshR9Outline(directory)
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt)) throw new Error('Fixed R9 outline attempt timestamp is invalid')
  const attempt = { schemaVersion: 1, assessment: 'r9', phase: 'outline', outlineRevision: 1, taskHash: sha(TASK), bundleSha256: prepared.bundleSha256, buildReceiptSha256: prepared.buildReceiptSha256, authorizationHash: snapshot.authorizationHash, financialStartedAt: snapshot.startedAt, startedAt }
  exclusiveJson(path.join(directory, 'outline-attempt.json'), attempt)
  return attempt
}
function assertFreshR10Outline(directory) {
  if (directory !== TENTH_DIRECTORY) return
  const paidState = ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']
  if (paidState.some(file => fs.existsSync(path.join(directory, file))) || (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith('outline-revision-')))) throw new Error('Fixed R10 outline attempt or paid state already exists; no retry or preparation overwrite')
}
function claimR10OutlineAttempt({ directory, prepared, ledger, now = Date.now }) {
  if (directory !== TENTH_DIRECTORY) throw new Error('One-shot original outline marker is restricted to fixed R10')
  const paths = assessmentPaths(directory)
  const lock = json(paths.lockFile)
  if (lock.pid !== process.pid || lock.phase !== 'outline') throw new Error('Fixed R10 requires ownership of the original shared outline lock')
  ledger.assertWindow()
  const snapshot = ledger.snapshot()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...durable } = snapshot
  if (JSON.stringify(json(paths.budgetFile)) !== JSON.stringify(durable) || snapshot.authorizationHash !== sha(JSON.stringify(prepared.authorization)) || !/^[a-f0-9]{64}$/u.test(prepared.bundleSha256 || '') || !/^[a-f0-9]{64}$/u.test(prepared.buildReceiptSha256 || '')) throw new Error('Fixed R10 prepared identity or original financial ledger changed before its outline marker')
  assertFreshR10Outline(directory)
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt)) throw new Error('Fixed R10 outline attempt timestamp is invalid')
  const attempt = { schemaVersion: 1, assessment: 'r10', phase: 'outline', outlineRevision: 1, taskHash: sha(TASK), bundleSha256: prepared.bundleSha256, buildReceiptSha256: prepared.buildReceiptSha256, authorizationHash: snapshot.authorizationHash, financialStartedAt: snapshot.startedAt, startedAt }
  exclusiveJson(path.join(directory, 'outline-attempt.json'), attempt)
  return attempt
}
function assertFreshR11Outline(directory) {
  if (directory !== ELEVENTH_DIRECTORY) return
  const paidState = ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']
  if (paidState.some(file => fs.existsSync(path.join(directory, file))) || (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith('outline-revision-')))) throw new Error('Fixed R11 outline attempt or paid state already exists; no retry or preparation overwrite')
}
function claimR11OutlineAttempt({ directory, prepared, ledger, now = Date.now }) {
  if (directory !== ELEVENTH_DIRECTORY) throw new Error('One-shot original outline marker is restricted to fixed R11')
  const paths = assessmentPaths(directory)
  const lock = json(paths.lockFile)
  if (lock.pid !== process.pid || lock.phase !== 'outline') throw new Error('Fixed R11 requires ownership of the original shared outline lock')
  ledger.assertWindow()
  const snapshot = ledger.snapshot()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...durable } = snapshot
  if (JSON.stringify(json(paths.budgetFile)) !== JSON.stringify(durable) || snapshot.authorizationHash !== sha(JSON.stringify(prepared.authorization)) || !/^[a-f0-9]{64}$/u.test(prepared.bundleSha256 || '') || !/^[a-f0-9]{64}$/u.test(prepared.buildReceiptSha256 || '')) throw new Error('Fixed R11 prepared identity or original financial ledger changed before its outline marker')
  assertFreshR11Outline(directory)
  assertFreshR12Outline(directory)
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt)) throw new Error('Fixed R11 outline attempt timestamp is invalid')
  const attempt = { schemaVersion: 1, assessment: 'r11', phase: 'outline', outlineRevision: 1, taskHash: sha(TASK), bundleSha256: prepared.bundleSha256, buildReceiptSha256: prepared.buildReceiptSha256, authorizationHash: snapshot.authorizationHash, financialStartedAt: snapshot.startedAt, startedAt }
  exclusiveJson(path.join(directory, 'outline-attempt.json'), attempt)
  return attempt
}
function assertFreshR12Outline(directory) {
  if (directory !== TWELFTH_DIRECTORY) return
  const paidState = ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']
  if (paidState.some(file => fs.existsSync(path.join(directory, file))) || (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith('outline-revision-')))) throw new Error('Fixed R12 outline attempt or paid state already exists; no retry or preparation overwrite')
}
function claimR12OutlineAttempt({ directory, prepared, ledger, now = Date.now }) {
  if (directory !== TWELFTH_DIRECTORY) throw new Error('One-shot original outline marker is restricted to fixed R12')
  const paths = assessmentPaths(directory)
  const lock = json(paths.lockFile)
  if (lock.pid !== process.pid || lock.phase !== 'outline') throw new Error('Fixed R12 requires ownership of the original shared outline lock')
  ledger.assertWindow()
  const snapshot = ledger.snapshot()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...durable } = snapshot
  if (JSON.stringify(json(paths.budgetFile)) !== JSON.stringify(durable) || snapshot.authorizationHash !== sha(JSON.stringify(prepared.authorization)) || !/^[a-f0-9]{64}$/u.test(prepared.bundleSha256 || '') || !/^[a-f0-9]{64}$/u.test(prepared.buildReceiptSha256 || '')) throw new Error('Fixed R12 prepared identity or original financial ledger changed before its outline marker')
  assertFreshR12Outline(directory)
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt)) throw new Error('Fixed R12 outline attempt timestamp is invalid')
  const attempt = { schemaVersion: 1, assessment: 'r12', phase: 'outline', outlineRevision: 1, taskHash: sha(TASK), bundleSha256: prepared.bundleSha256, buildReceiptSha256: prepared.buildReceiptSha256, authorizationHash: snapshot.authorizationHash, financialStartedAt: snapshot.startedAt, startedAt }
  exclusiveJson(path.join(directory, 'outline-attempt.json'), attempt)
  return attempt
}
function assertFreshR13Outline(directory) {
  if (directory !== THIRTEENTH_DIRECTORY) return
  const paidState = ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']
  if (paidState.some(file => fs.existsSync(path.join(directory, file))) || (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith('outline-revision-')))) throw new Error('Fixed R13 outline attempt or paid state already exists; no retry or preparation overwrite')
}
function claimR13OutlineAttempt({ directory, prepared, ledger, now = Date.now }) {
  if (directory !== THIRTEENTH_DIRECTORY) throw new Error('One-shot original outline marker is restricted to fixed R13')
  const paths = assessmentPaths(directory)
  const lock = json(paths.lockFile)
  if (lock.pid !== process.pid || lock.phase !== 'outline') throw new Error('Fixed R13 requires ownership of the original shared outline lock')
  ledger.assertWindow()
  const snapshot = ledger.snapshot()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...durable } = snapshot
  if (JSON.stringify(json(paths.budgetFile)) !== JSON.stringify(durable) || snapshot.authorizationHash !== sha(JSON.stringify(prepared.authorization)) || !/^[a-f0-9]{64}$/u.test(prepared.bundleSha256 || '') || !/^[a-f0-9]{64}$/u.test(prepared.buildReceiptSha256 || '')) throw new Error('Fixed R13 prepared identity or original financial ledger changed before its outline marker')
  assertFreshR13Outline(directory)
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt)) throw new Error('Fixed R13 outline attempt timestamp is invalid')
  const attempt = { schemaVersion: 1, assessment: 'r13', phase: 'outline', outlineRevision: 1, taskHash: sha(TASK), bundleSha256: prepared.bundleSha256, buildReceiptSha256: prepared.buildReceiptSha256, authorizationHash: snapshot.authorizationHash, financialStartedAt: snapshot.startedAt, startedAt }
  exclusiveJson(path.join(directory, 'outline-attempt.json'), attempt)
  return attempt
}
function assertFreshR14Outline(directory) {
  if (directory !== FOURTEENTH_DIRECTORY) return
  const paidState = ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']
  if (paidState.some(file => fs.existsSync(path.join(directory, file))) || (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith('outline-revision-')))) throw new Error('Fixed R14 outline attempt or paid state already exists; no retry or preparation overwrite')
}
function claimR14OutlineAttempt({ directory, prepared, ledger, now = Date.now }) {
  if (directory !== FOURTEENTH_DIRECTORY) throw new Error('One-shot original outline marker is restricted to fixed R14')
  const paths = assessmentPaths(directory)
  const lock = json(paths.lockFile)
  if (lock.pid !== process.pid || lock.phase !== 'outline') throw new Error('Fixed R14 requires ownership of the original shared outline lock')
  ledger.assertWindow()
  const snapshot = ledger.snapshot()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...durable } = snapshot
  if (JSON.stringify(json(paths.budgetFile)) !== JSON.stringify(durable) || snapshot.authorizationHash !== sha(JSON.stringify(prepared.authorization)) || !/^[a-f0-9]{64}$/u.test(prepared.bundleSha256 || '') || !/^[a-f0-9]{64}$/u.test(prepared.buildReceiptSha256 || '')) throw new Error('Fixed R14 prepared identity or original financial ledger changed before its outline marker')
  assertFreshR14Outline(directory)
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt)) throw new Error('Fixed R14 outline attempt timestamp is invalid')
  const attempt = { schemaVersion: 1, assessment: 'r14', phase: 'outline', outlineRevision: 1, taskHash: sha(TASK), bundleSha256: prepared.bundleSha256, buildReceiptSha256: prepared.buildReceiptSha256, authorizationHash: snapshot.authorizationHash, financialStartedAt: snapshot.startedAt, startedAt }
  exclusiveJson(path.join(directory, 'outline-attempt.json'), attempt)
  return attempt
}
async function prepare({ buildCli = false, directory = DIRECTORY } = {}) {
  assessmentDirectory(directory)
  assertFreshR5Outline(directory)
  assertFreshR6Outline(directory)
  assertFreshR7Outline(directory)
  assertFreshR8Outline(directory)
  assertFreshR9Outline(directory)
  assertFreshR10Outline(directory)
  assertFreshR11Outline(directory)
  assertFreshR12Outline(directory)
  assertFreshR13Outline(directory)
  assertFreshR14Outline(directory)
  if (['outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json'].some(file => fs.existsSync(path.join(directory, file)))) throw new Error('Refusing to overwrite an assessment with paid CLI state')
  if (buildCli && fs.existsSync(path.join(directory, 'build'))) throw new Error('Refusing to overwrite the prepared CLI bundle')
  fs.mkdirSync(directory, { recursive: true })
  const helpers = await accountingHelpers(path.join(directory, 'accounting'))
  const authorization = inheritedAuthorization()
  const profile = json(path.join(ROOT, 'scripts/eval-prices-deepseek-flash-20261003.json'))
  verifyPrice(helpers, profile)
  let build = null
  if (buildCli) {
    build = await require('./build-cli.cjs').buildCliArtifact({ root: ROOT, output: path.join(directory, 'build') })
  }
  const receiptPath = path.join(directory, 'build/cli-build.json')
  const preflight = { schemaVersion: 1, date: DATE, nativeOrigin: ORIGIN, model: MODEL, priceProfileHash: PRICE_HASH, authorization, targetChars: 8000, reviewEnabled: true, taskHash: sha(TASK), phases: ['outline_only_then_stop', 'separate_explicit_root_hash_confirmation'], credentialsRead: false, realRequests: 0, bundleSha256: build?.receipt.bundle.sha256 || (fs.existsSync(receiptPath) ? json(receiptPath).bundle.sha256 : null), buildReceiptSha256: fs.existsSync(receiptPath) ? sha(fs.readFileSync(receiptPath)) : null, note: 'Reference pricing is owner-authorized and dated; no independent current-price or literary-quality claim.' }
  atomicJson(path.join(directory, 'preflight.json'), preflight)
  if (preflight.bundleSha256) verifyPreparedBuild({ directory })
  return preflight
}
function verifyPreparedBuild({ directory = DIRECTORY, root = ROOT } = {}) {
  // Entirely key-free: every identity check precedes Electron/profile/settings
  // initialization. A package/script-only change still invalidates the receipt.
  const prepared = json(path.join(directory, 'preflight.json'))
  const bundle = path.join(directory, 'build/deepwriter.cjs')
  if (!prepared.bundleSha256 || prepared.bundleSha256 !== sha(fs.readFileSync(bundle))) throw new Error('Build the audited coherent CLI with --preflight --build-cli first')
  const receipt = json(path.join(directory, 'build/cli-build.json'))
  if (prepared.buildReceiptSha256 !== sha(fs.readFileSync(path.join(directory, 'build/cli-build.json'))) || !Array.isArray(receipt.inputs) || !receipt.inputs.length || receipt.buildPolicy?.entrypoint !== 'src/cli/main.ts') throw new Error('Actual CLI build receipt is absent or changed')
  if (directory === SIXTH_DIRECTORY && (receipt.sourceDirty !== false || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit || ''))) throw new Error('Fixed R6 requires an original CLI receipt from a frozen clean commit')
  if (directory === SEVENTH_DIRECTORY && (receipt.sourceDirty !== false || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit || ''))) throw new Error('Fixed R7 requires an original CLI receipt from a frozen clean commit')
  if (directory === EIGHTH_DIRECTORY && (receipt.sourceDirty !== false || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit || ''))) throw new Error('Fixed R8 requires an original CLI receipt from a frozen clean commit')
  if (directory === NINTH_DIRECTORY && (receipt.sourceDirty !== false || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit || ''))) throw new Error('Fixed R9 requires an original CLI receipt from a frozen clean commit')
  if (directory === TENTH_DIRECTORY && (receipt.sourceDirty !== false || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit || ''))) throw new Error('Fixed R10 requires an original CLI receipt from a frozen clean commit')
  if (directory === ELEVENTH_DIRECTORY && (receipt.sourceDirty !== false || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit || ''))) throw new Error('Fixed R11 requires an original CLI receipt from a frozen clean commit')
  if (directory === TWELFTH_DIRECTORY && (receipt.sourceDirty !== false || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit || ''))) throw new Error('Fixed R12 requires an original CLI receipt from a frozen clean commit')
  if (directory === THIRTEENTH_DIRECTORY && (receipt.sourceDirty !== false || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit || ''))) throw new Error('Fixed R13 requires an original CLI receipt from a frozen clean commit')
  if (directory === FOURTEENTH_DIRECTORY && (receipt.sourceDirty !== false || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit || ''))) throw new Error('Fixed R14 requires an original CLI receipt from a frozen clean commit')
  const packageBytes = fs.readFileSync(path.join(root, 'package.json'))
  const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json'))
  const pkg = JSON.parse(packageBytes); const lock = JSON.parse(lockBytes)
  if (receipt.application?.name !== 'deepwriter-cli' || receipt.application?.version !== pkg.version || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version || receipt.source?.packageSha256 !== sha(packageBytes) || receipt.source?.lockSha256 !== sha(lockBytes)) throw new Error('Package/lock identity changed since the audited prepared build')
  if (receipt.buildPolicy?.implementation !== 'src/cli/build.mjs' || receipt.buildPolicy?.platform !== 'node' || receipt.buildPolicy?.format !== 'cjs' || receipt.buildPolicy?.target !== 'node22' || receipt.buildPolicy?.implementationSha256 !== sha(fs.readFileSync(path.join(root, 'src/cli/build.mjs')))) throw new Error('CLI builder identity changed since the audited prepared build')
  for (const item of receipt.inputs) if (typeof item.name !== 'string' || path.isAbsolute(item.name) || item.name.split(/[\\/]/).includes('..') || sha(fs.readFileSync(path.join(root, item.name))) !== item.sha256) throw new Error('CLI source changed since the audited prepared build')
  return { prepared, bundle, receipt }
}
async function realPhase(phase, approvedOutlineHash, directory = DIRECTORY, priceVerificationSha256, outlineRevision = 1, requestExtensionSha256) {
  // This branch is never entered by local preflight. A human/root audit must
  // precede executing the explicit Electron --real command.
  if (!['outline', 'reoutline', 'write'].includes(phase) || (phase === 'reoutline' && directory !== FOURTH_DIRECTORY) || (outlineRevision === 2 && (phase !== 'write' || directory !== FOURTH_DIRECTORY))) throw new Error('Choose one audited explicit phase/revision')
  const paths = assessmentPaths(directory)
  const priceVerification = priceVerificationSha256 ? { expectedSha256: priceVerificationSha256 } : undefined
  const requestExtension = requestExtensionSha256 ? { expectedSha256: requestExtensionSha256 } : undefined
  if ([ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].includes(directory) && !requestExtension) throw new Error('Fixed R11 requires its explicit owner request-extension receipt pin')
  if (![ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].includes(directory) && requestExtension) throw new Error('Owner request extension is restricted to fixed R11/R12/R13/R14')
  if ((directory === THIRD_DIRECTORY || directory === FOURTH_DIRECTORY || directory === FIFTH_DIRECTORY || directory === SIXTH_DIRECTORY || directory === SEVENTH_DIRECTORY || directory === EIGHTH_DIRECTORY || directory === NINTH_DIRECTORY || directory === TENTH_DIRECTORY || directory === ELEVENTH_DIRECTORY || directory === TWELFTH_DIRECTORY || directory === THIRTEENTH_DIRECTORY || directory === FOURTEENTH_DIRECTORY) && !priceVerification) throw new Error('Later assessment requires one explicit price-verification receipt hash')
  if (priceVerification) verifyPriceVerification({ directory, ...priceVerification })
  else if (new Date().toISOString().slice(0, 10) !== DATE) throw new Error('Reverify price/date before any later date; only pinned fixed-r2/r3/r4/r5/r6/r7/r8/r9/r10/r11/r12/r13/r14 evidence can renew the price window')
  if (directory !== DIRECTORY && !fs.existsSync(paths.budgetFile)) throw new Error('Later assessment cannot start without the original financial ledger')
  if (requestExtension) {
    const original = json(paths.budgetFile)
    verifyRequestExtension({ ...requestExtension, directory, authorization: original.authorization, originalAuthorizationHash: original.authorizationHash, financialStartedAt: original.startedAt })
  }
  if (phase === 'outline') assertFreshR5Outline(directory)
  if (phase === 'outline') assertFreshR6Outline(directory)
  if (phase === 'outline') assertFreshR7Outline(directory)
  if (phase === 'outline') assertFreshR8Outline(directory)
  if (phase === 'outline') assertFreshR9Outline(directory)
  if (phase === 'outline') assertFreshR10Outline(directory)
  if (phase === 'outline') assertFreshR11Outline(directory)
  if (phase === 'outline') assertFreshR12Outline(directory)
  if (phase === 'outline') assertFreshR13Outline(directory)
  if (phase === 'outline') assertFreshR14Outline(directory)
  const { prepared, bundle } = verifyPreparedBuild({ directory })
  const authorization = inheritedAuthorization()
  if (sha(JSON.stringify(prepared.authorization)) !== sha(JSON.stringify(authorization))) throw new Error('Earlier paid authorization evidence changed')
  const profile = json(path.join(ROOT, 'scripts/eval-prices-deepseek-flash-20261003.json'))
  if (phase === 'reoutline') reoutlineFence(directory, bundle)
  if (phase === 'write') { freshWriteEvidence(directory); if (!approvedOutlineHash || selectedOutline(directory, bundle, outlineRevision).record.outlineHash !== approvedOutlineHash) throw new Error('Root must inspect and explicitly approve the selected saved real outline hash first') }
  // All phases and all fixed source assessments serialize on ONE original lock and
  // ONE financial ledger. A new build/data directory cannot reset any spend,
  // failed attempt, pending reservation, request guard or original startedAt.
  // Only separate explicit price evidence can renew r2/r3/r4/r5/r6/r7/r8/r9/r10/r11/r12/r13/r14's price-validity window.
  const lock = paths.lockFile
  const lockFd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, phase })); fs.closeSync(lockFd)
  let isolatedProfile = null; let key = ''; let relay = null; let interrupted = false
  const { app, safeStorage } = require('electron')
  const stop = () => { interrupted = true; for (const child of children) child.kill(); if (relay) void relay.close().catch(() => undefined) }
  try {
    if (!app || !safeStorage) throw new Error('Real launcher requires the installed Electron runtime')
    const sourceSettings = path.join(process.env.APPDATA || '', 'DeepWriter/settings.json')
    isolatedProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-authorized-cli-'))
    const stateFile = path.join(path.dirname(sourceSettings), 'Local State')
    if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, path.join(isolatedProfile, 'Local State'), fs.constants.COPYFILE_EXCL)
    // Configure the isolated OSCrypt profile synchronously before the first
    // await, exactly as the earlier memory-only encrypted-key launcher does.
    app.setPath('userData', isolatedProfile); app.commandLine.appendSwitch('disable-gpu')
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    const helpers = await accountingHelpers(path.join(DIRECTORY, 'accounting'))
    verifyPrice(helpers, profile)
    const ledger = createLedger({ file: paths.budgetFile, authorization, profile, helpers, phase, directory, priceVerification, requestExtension })
    ledger.assertWindow()
    // A failed/interrupted R5 outline consumes this assessment exactly once.
    // Claim only after shared-lock/price/prepared/original-ledger validation,
    // before credentials or any CLI command; ordinary write never reclaims it.
    if (phase === 'outline' && directory === FIFTH_DIRECTORY) claimR5OutlineAttempt({ directory, prepared, ledger })
    if (phase === 'outline' && directory === SIXTH_DIRECTORY) claimR6OutlineAttempt({ directory, prepared, ledger })
    if (phase === 'outline' && directory === SEVENTH_DIRECTORY) claimR7OutlineAttempt({ directory, prepared, ledger })
    if (phase === 'outline' && directory === EIGHTH_DIRECTORY) claimR8OutlineAttempt({ directory, prepared, ledger })
    if (phase === 'outline' && directory === NINTH_DIRECTORY) claimR9OutlineAttempt({ directory, prepared, ledger })
    if (phase === 'outline' && directory === TENTH_DIRECTORY) claimR10OutlineAttempt({ directory, prepared, ledger })
    if (phase === 'outline' && directory === ELEVENTH_DIRECTORY) claimR11OutlineAttempt({ directory, prepared, ledger })
    if (phase === 'outline' && directory === TWELFTH_DIRECTORY) claimR12OutlineAttempt({ directory, prepared, ledger })
    if (phase === 'outline' && directory === THIRTEENTH_DIRECTORY) claimR13OutlineAttempt({ directory, prepared, ledger })
    if (phase === 'outline' && directory === FOURTEENTH_DIRECTORY) claimR14OutlineAttempt({ directory, prepared, ledger })
    if (interrupted) throw new Error('Interrupted before credential lookup')
    await app.whenReady()
    ledger.assertWindow()
    if (interrupted) throw new Error('Interrupted before credential lookup')
    const settings = json(sourceSettings)
    if (settings.baseUrl !== ORIGIN || !safeStorage.isEncryptionAvailable() || typeof settings.apiKeyEnc !== 'string' || !settings.apiKeyEnc) throw new Error('Read-only encrypted native DeepSeek credential is unavailable')
    key = safeStorage.decryptString(Buffer.from(settings.apiKeyEnc, 'base64'))
    if (!key.trim()) throw new Error('Native DeepSeek credential is empty')
    relay = await createRelay({ ledger, apiKey: key, responseEvidenceDirectory: directory === THIRD_DIRECTORY || directory === FOURTH_DIRECTORY || directory === FIFTH_DIRECTORY || directory === SIXTH_DIRECTORY || directory === SEVENTH_DIRECTORY || directory === EIGHTH_DIRECTORY || directory === NINTH_DIRECTORY || directory === TENTH_DIRECTORY || directory === ELEVENTH_DIRECTORY || directory === TWELFTH_DIRECTORY || directory === THIRTEENTH_DIRECTORY || directory === FOURTEENTH_DIRECTORY ? path.join(directory, 'response-evidence') : undefined })
    if (interrupted) throw new Error('Interrupted before the first CLI command')
    const command = (bundle, args, relay, directory) => { if (interrupted) throw new Error('Interrupted before another CLI command'); return cliCommand(bundle, args, relay, directory, { redact: value => String(value).split(key).join('[REDACTED]').split(relay.localToken).join('[REDACTED]') }) }
    const result = phase === 'outline' ? await outlinePhase({ bundle, relay, directory, command }) : phase === 'reoutline' ? await reoutlinePhase({ bundle, relay, directory, command }) : await writePhase({ bundle, relay, directory, approvedOutlineHash, outlineRevision, command })
    await relay.close(); relay = null
    console.log(JSON.stringify({ ...result, budget: ledger.snapshot(), realLiteraryQualityAccepted: false }))
    return !interrupted && (result.status === 'completed' || result.status === 'awaiting_outline_confirmation') ? 0 : 2
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    if (relay) await relay.close()
    key = ''
    fs.unlinkSync(lock)
    if (isolatedProfile && path.dirname(isolatedProfile) === os.tmpdir() && path.basename(isolatedProfile).startsWith('deepwriter-authorized-cli-')) fs.rmSync(isolatedProfile, { recursive: true, force: true })
  }
}
async function main(argv = process.argv.slice(2)) {
  try {
    const assessments = argv.filter(item => item.startsWith('--assessment='))
    if (assessments.length > 1 || assessments.some(item => !['--assessment=r2', '--assessment=r3', '--assessment=r4', '--assessment=r5', '--assessment=r6', '--assessment=r7', '--assessment=r8', '--assessment=r9', '--assessment=r10', '--assessment=r11', '--assessment=r12', '--assessment=r13', '--assessment=r14'].includes(item))) throw new Error('Choose one audited fixed assessment')
    const directory = assessments[0] === '--assessment=r14' ? FOURTEENTH_DIRECTORY : assessments[0] === '--assessment=r13' ? THIRTEENTH_DIRECTORY : assessments[0] === '--assessment=r12' ? TWELFTH_DIRECTORY : assessments[0] === '--assessment=r11' ? ELEVENTH_DIRECTORY : assessments[0] === '--assessment=r10' ? TENTH_DIRECTORY : assessments[0] === '--assessment=r9' ? NINTH_DIRECTORY : assessments[0] === '--assessment=r8' ? EIGHTH_DIRECTORY : assessments[0] === '--assessment=r7' ? SEVENTH_DIRECTORY : assessments[0] === '--assessment=r6' ? SIXTH_DIRECTORY : assessments[0] === '--assessment=r5' ? FIFTH_DIRECTORY : assessments[0] === '--assessment=r4' ? FOURTH_DIRECTORY : assessments[0] === '--assessment=r3' ? THIRD_DIRECTORY : assessments[0] === '--assessment=r2' ? SECOND_DIRECTORY : DIRECTORY
    if (directory === FIFTH_DIRECTORY && ['--preflight', '--build-cli'].some(flag => argv.filter(item => item === flag).length > 1)) throw new Error('Duplicate fixed R5 preparation flags')
    if (directory === SIXTH_DIRECTORY && ['--preflight', '--build-cli'].some(flag => argv.filter(item => item === flag).length > 1)) throw new Error('Duplicate fixed R6 preparation flags')
    if (directory === SEVENTH_DIRECTORY && ['--preflight', '--build-cli'].some(flag => argv.filter(item => item === flag).length > 1)) throw new Error('Duplicate fixed R7 preparation flags')
    if (directory === EIGHTH_DIRECTORY && ['--preflight', '--build-cli'].some(flag => argv.filter(item => item === flag).length > 1)) throw new Error('Duplicate fixed R8 preparation flags')
    if (directory === NINTH_DIRECTORY && ['--preflight', '--build-cli'].some(flag => argv.filter(item => item === flag).length > 1)) throw new Error('Duplicate fixed R9 preparation flags')
    if (directory === TENTH_DIRECTORY && ['--preflight', '--build-cli'].some(flag => argv.filter(item => item === flag).length > 1)) throw new Error('Duplicate fixed R10 preparation flags')
    if (directory === ELEVENTH_DIRECTORY && ['--preflight', '--build-cli'].some(flag => argv.filter(item => item === flag).length > 1)) throw new Error('Duplicate fixed R11 preparation flags')
  if (directory === TWELFTH_DIRECTORY && ['--preflight', '--build-cli'].some(flag => argv.filter(item => item === flag).length > 1)) throw new Error('Duplicate fixed R12 preparation flags')
  if (directory === THIRTEENTH_DIRECTORY && ['--preflight', '--build-cli'].some(flag => argv.filter(item => item === flag).length > 1)) throw new Error('Duplicate fixed R13 preparation flags')
  if (directory === FOURTEENTH_DIRECTORY && ['--preflight', '--build-cli'].some(flag => argv.filter(item => item === flag).length > 1)) throw new Error('Duplicate fixed R14 preparation flags')
    if (argv.every(item => ['--preflight', '--build-cli', '--assessment=r2', '--assessment=r3', '--assessment=r4', '--assessment=r5', '--assessment=r6', '--assessment=r7', '--assessment=r8', '--assessment=r9', '--assessment=r10', '--assessment=r11', '--assessment=r12', '--assessment=r13', '--assessment=r14'].includes(item)) && argv.includes('--preflight')) { console.log(JSON.stringify(await prepare({ buildCli: argv.includes('--build-cli'), directory }))); return 0 }
    const single = prefix => { const values = argv.filter(item => item.startsWith(prefix)); if (values.length > 1) throw new Error('Duplicate explicit phase/hash/revision'); return values[0]?.slice(prefix.length) }
    const phase = single('--phase='), hash = single('--approved-outline-hash='), revision = single('--outline-revision=')
    if (!['outline', 'reoutline', 'write'].includes(phase) || argv.filter(item => item === '--real').length !== 1 || (phase === 'reoutline' && directory !== FOURTH_DIRECTORY) || (phase !== 'write' && hash !== undefined) || (phase === 'write' && (!hash || !/^[a-f0-9]{16}$/u.test(hash))) || (revision !== undefined && (revision !== '2' || phase !== 'write' || directory !== FOURTH_DIRECTORY))) throw new Error('Invalid explicit phase/hash/revision syntax')
    const pricePins = argv.filter(item => item.startsWith('--price-verification-sha256='))
    if (pricePins.length > 1) throw new Error('Price verification requires one explicit receipt hash')
    const pricePin = pricePins[0]?.slice('--price-verification-sha256='.length)
    const requestPins = argv.filter(item => item.startsWith('--request-extension-sha256='))
    const requestPin = requestPins[0]?.slice('--request-extension-sha256='.length)
    if (requestPins.length > 1 || (requestPins.length && ![ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].includes(directory)) || ([ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].includes(directory) && (!requestPin || !/^[a-f0-9]{64}$/u.test(requestPin)))) throw new Error('Fixed R11 requires one explicit owner request-extension receipt hash')
    if (pricePins.length && (!pricePin || ![SECOND_DIRECTORY, THIRD_DIRECTORY, FOURTH_DIRECTORY, FIFTH_DIRECTORY, SIXTH_DIRECTORY, SEVENTH_DIRECTORY, EIGHTH_DIRECTORY, NINTH_DIRECTORY, TENTH_DIRECTORY, ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY].includes(directory))) throw new Error('Only fixed r2/r3/r4/r5/r6/r7/r8/r9/r10/r11/r12/r13/r14 may explicitly renew its price-validity window')
    if (argv.includes('--real') && argv.every(item => item === '--real' || item === '--assessment=r2' || item === '--assessment=r3' || item === '--assessment=r4' || item === '--assessment=r5' || item === '--assessment=r6' || item === '--assessment=r7' || item === '--assessment=r8' || item === '--assessment=r9' || item === '--assessment=r10' || item === '--assessment=r11' || item === '--assessment=r12' || item === '--assessment=r13' || item === '--assessment=r14' || item.startsWith('--phase=') || item.startsWith('--approved-outline-hash=') || item.startsWith('--outline-revision=') || item.startsWith('--price-verification-sha256=') || item.startsWith('--request-extension-sha256='))) return await realPhase(phase, hash, directory, pricePin, revision === '2' ? 2 : 1, requestPin)
    throw new Error('Use --preflight [--build-cli]; audited real phases use --real --phase=outline, then --real --phase=write --approved-outline-hash=HASH')
  } catch { console.error('Bounded CLI assessment refused or incomplete; inspect isolated state/ledger. No literary-quality acceptance is implied.'); return 2 }
}
if (require.main === module) main().then(code => { process.exitCode = code; if (process.argv.includes('--real')) { const electron = require('electron'); if (electron.app) electron.app.exit(code) } })
module.exports = { ROOT, MODEL, ORIGIN, DATE, PRICE_HASH, PRICE_WINDOW_MS, PRICE_SOURCE_URL, OFF_PEAK_SCHEDULE, DIRECTORY, SECOND_DIRECTORY, THIRD_DIRECTORY, FOURTH_DIRECTORY, FIFTH_DIRECTORY, SIXTH_DIRECTORY, SEVENTH_DIRECTORY, EIGHTH_DIRECTORY, NINTH_DIRECTORY, TENTH_DIRECTORY, ELEVENTH_DIRECTORY, TWELFTH_DIRECTORY, THIRTEENTH_DIRECTORY, FOURTEENTH_DIRECTORY, TASK, ANSWERS, sha, accountingHelpers, inheritedAuthorization, verifyPrice, verifyPriceVerification, isOffPeak, createLedger, createRelay, cliCommand, outlinePhase, reoutlinePhase, writePhase, manuscriptProof, prepare, verifyPreparedBuild, assessmentDirectory, assessmentPaths, assertFreshR5Outline, claimR5OutlineAttempt, assertFreshR6Outline, claimR6OutlineAttempt, assertFreshR7Outline, claimR7OutlineAttempt, assertFreshR8Outline, claimR8OutlineAttempt, assertFreshR9Outline, claimR9OutlineAttempt, assertFreshR10Outline, claimR10OutlineAttempt, assertFreshR11Outline, claimR11OutlineAttempt, assertFreshR12Outline, claimR12OutlineAttempt, assertFreshR13Outline, claimR13OutlineAttempt, assertFreshR14Outline, claimR14OutlineAttempt, verifyRequestExtension, main }
