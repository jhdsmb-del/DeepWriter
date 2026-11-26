// R42: real Electron renderer/main/SQLite with a local synthetic SSE provider. 0 external API.
import * as path from 'node:path'
import * as url from 'node:url'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`) } else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
function cpLen(text: string): number { return Array.from(text).length }
function fillUnique(prefix: string, count: number, seed = 0): string {
  const rest = Math.max(0, count - cpLen(prefix))
  return Array.from(prefix + Array.from({ length: rest }, (_, i) => String.fromCodePoint(0x4e00 + ((seed + i) % 18000))).join('')).slice(0, count).join('')
}

const BAD_TAIL = '人生的意义在于不断前进。这告诉我们，每个人都应该超越眼前的小事，唯有坚持才能抵达彼岸。'
const WRITER = `${fillUnique('海边灯塔的守夜人把旧钥匙压在掌心，潮声从门缝里一阵阵涌来。', 4000 - cpLen(BAD_TAIL) - 1, 300)}\n${BAD_TAIL}`
type Request = { messages: Array<{ role: string; content: string }> }

async function startMock(): Promise<{ server: http.Server; port: number; requests: Request[]; purposes: string[] }> {
  const requests: Request[] = []
  const purposes: string[] = []
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return }
    let raw = ''
    req.on('data', (chunk) => { raw += String(chunk) })
    req.on('end', () => {
      const request = JSON.parse(raw) as Request
      requests.push(request)
      const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
      const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      let purpose = 'writer'
      let content = WRITER
      if (system.includes('你是文字审校员')) {
        purpose = 'critic'
        const body = JSON.parse(user) as { candidateHash: string }
        content = JSON.stringify({ schemaVersion: 1, candidateHash: body.candidateHash, issues: [] })
      } else if (system.includes('你是定点文字编辑')) {
        purpose = 'editor'
        const body = JSON.parse(user) as any
        const issue = body.issue
        const replacement = fillUnique('灯影掠过潮面，他把那句未出口的话留给了风。', issue.endCp - issue.startCp, 9000)
        content = JSON.stringify({ schemaVersion: 1, candidateHash: body.candidateHash, patches: [{ issueId: issue.issueId, startCp: issue.startCp, endCp: issue.endCp, quote: issue.quote, replacement }] })
      } else if (user.includes('普通 Agent')) {
        content = '普通 Agent 正常回答，没有套用写作审校。'
      }
      purposes.push(purpose)
      const chars = Array.from(content)
      const chunks = Array.from({ length: Math.ceil(chars.length / 180) }, (_, i) => chars.slice(i * 180, (i + 1) * 180).join(''))
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      let i = 0
      const timer = setInterval(() => {
        if (res.destroyed) { clearInterval(timer); return }
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify({ id: `r42-${requests.length}`, choices: [{ index: 0, delta: { role: 'assistant', content: chunks[i++] }, finish_reason: null }], usage: null })}\n\n`)
          return
        }
        clearInterval(timer)
        res.write(`data: ${JSON.stringify({ id: `r42-${requests.length}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 31, completion_tokens: chars.length, total_tokens: chars.length + 31, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 28 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      }, purpose === 'writer' ? 18 : 35)
      res.on('close', () => clearInterval(timer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as { port: number }).port, requests, purposes }
}

async function configure(page: Page, port: number): Promise<void> {
  await page.evaluate(async (mockPort) => {
    const ds = (window as any).ds
    const current = await ds.getSettings()
    await ds.setSettings({
      ...current, apiKey: 'r42-local-synthetic', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'deepseek-v4-flash', thinkingEnabled: false, toolsEnabled: false, planMode: false,
      strongConstraintEnabled: true, strongConstraintLevel: 'balanced', themeLockMode: 'strong', expressionFreedom: 'high', antiMoralizingEnabled: true,
      strongConstraintPerspective: 'auto', strongConstraintGenre: '', strongConstraintMustKeep: '', strongConstraintAvoid: ''
    })
  }, port)
}
async function chooseMode(page: Page, name: '长文' | 'Agent'): Promise<void> { await page.locator('.mode-popover-wrap > .modebar-btn').click(); await page.locator('.mode-item', { hasText: name }).click() }
async function waitTerminal(page: Page): Promise<void> { await page.locator('.composer .btn.stop').waitFor({ state: 'hidden', timeout: 90_000 }); await page.waitForTimeout(250) }
async function quit(app: ElectronApplication): Promise<number> {
  const child = app.process(); const exited = new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 0)))
  await app.evaluate(({ app: a }) => a.quit()).catch(() => undefined)
  return Promise.race([exited, new Promise<number>((resolve) => setTimeout(() => resolve(255), 15_000))])
}

async function main(): Promise<void> {
  const userData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dw-r42-ui-'))
  const mock = await startMock()
  let app: ElectronApplication | null = null
  let uiText = ''
  let inspector = ''
  try {
    app = await electron.launch({ args: [path.join(ROOT, 'out', 'main', 'index.js')], env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData } })
    const page = await app.firstWindow(); await page.waitForSelector('.composer', { timeout: 15000 })
    await configure(page, mock.port); await page.reload(); await page.waitForSelector('.composer', { timeout: 15000 })
    await page.locator('[aria-label="设置"]').click()
    const settings = page.locator('.dw-settings-modal[role="dialog"]'); await settings.waitFor()
    await settings.locator('.dw-settings-nav button', { hasText: '完成与预算' }).click()
    await settings.locator('.dw-writing-settings > summary').click()
    check('UI-two-visible-axes', await settings.getByText('主题锁定').isVisible() && await settings.getByText('表达自由').isVisible())
    check('UI-anti-moralizing-visible', await settings.getByText('自动检查说教式收尾').isVisible())
    await settings.locator('button', { hasText: '保存并关闭' }).click()
    await chooseMode(page, '长文')
    const panel = page.locator('[aria-label="深度写作控制"]'); await panel.waitFor(); await panel.locator('input[type="range"]').fill('4000')
    const constraintCard = panel.locator('[data-testid="strong-constraint-card"]')
    await constraintCard.locator('button', { hasText: '查看当前约束' }).click()
    check('UI-longwrite-card-exposes-axes', await constraintCard.getByText('主题锁定').isVisible() && await constraintCard.getByText('表达自由').isVisible() && await constraintCard.getByText('检查说教式收尾').isVisible())
    await page.locator('.composer textarea').fill('写一个发生在海边灯塔的守夜人悬疑故事，4000字，保持克制。')
    await page.locator('.composer .btn.primary').click()
    await page.locator('[data-testid="stream-progress"]').waitFor({ state: 'visible', timeout: 15000 })
    await waitTerminal(page)
    uiText = await page.locator('.msg.assistant .msg-bubble').last().evaluate((element) => element.textContent ?? '')
    await page.locator('.msg.assistant .ghost-btn', { hasText: '查看任务详情' }).last().click()
    const dialog = page.locator('.run-inspector[role="dialog"]'); await dialog.waitFor(); inspector = await dialog.innerText()
    check('UI-inspector-local-edit-facts', inspector.includes('局部修订') && inspector.includes('保留率') && inspector.includes('critic'), inspector.slice(0, 500))
    check('UI-inspector-token-time-details', inspector.includes('用量明细') && inspector.includes('输入') && inspector.includes('writer 第1轮') && inspector.includes('TTFT') && inspector.includes('缓存命中') && inspector.includes('推理未知') && inspector.includes('费用未知') && inspector.includes('审校总计') && !inspector.includes('费用 ¥0.0000'))
    await page.locator('[aria-label="关闭任务详情"]').click()
    await page.reload(); await page.waitForSelector('.composer', { timeout: 15000 })
    await page.locator('.session-item').first().waitFor({ timeout: 15000 }); await page.locator('.session-item').first().click()
    await page.locator('.msg.assistant .msg-bubble').last().waitFor({ timeout: 15000 })
    check('UI-completed-draft-survives-reload', (await page.locator('.msg.assistant .msg-bubble').last().evaluate((element) => element.textContent ?? '')) === uiText)
    await chooseMode(page, 'Agent')
    await page.locator('.composer textarea').fill('普通 Agent 请简短回答。'); await page.locator('.composer .btn.primary').click(); await waitTerminal(page)
    check('UI-agent-unaffected', (await page.locator('.msg.assistant .msg-bubble').last().innerText()).includes('普通 Agent 正常回答'))
    const exit = await quit(app); check('UI-natural-exit', exit === 0, `exit=${exit}`)
  } finally {
    if (app) await app.close().catch(() => undefined)
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  }
  const db = new DatabaseSync(path.join(userData, 'deepwriter.db'))
  try {
    const run = db.prepare("SELECT run_id,status,config_json FROM runs WHERE config_json LIKE '%longwrite%' ORDER BY started_at LIMIT 1").get() as { run_id: string; status: string; config_json: string }
    const durable = (db.prepare("SELECT content FROM turns WHERE run_id=? AND role='assistant' ORDER BY turn_seq").all(run.run_id) as Array<{ content: string }>).map((x) => x.content).join('')
    const projected = (db.prepare("SELECT content FROM session_messages WHERE msg_id=?").get(`m_${run.run_id}_assistant`) as { content: string } | undefined)?.content ?? ''
    const evidence = JSON.parse((db.prepare("SELECT json FROM run_evidence WHERE run_id=? AND kind='writing_pipeline_latest'").get(run.run_id) as { json: string }).json) as any
    const strongEvidence = JSON.parse((db.prepare("SELECT json FROM run_evidence WHERE run_id=? AND kind='strong_constraint_latest'").get(run.run_id) as { json: string }).json) as any
    const usage = db.prepare('SELECT call_type,input_tokens,output_tokens,cache_hit,cache_miss FROM usage_log WHERE run_id=? ORDER BY id').all(run.run_id) as Array<{ call_type: string; input_tokens: number; output_tokens: number }>
    const agentRun = db.prepare("SELECT run_id,status FROM runs WHERE run_id<>? ORDER BY started_at DESC LIMIT 1").get(run.run_id) as { run_id: string; status: string }
    const agentUsage = db.prepare('SELECT call_type FROM usage_log WHERE run_id=? ORDER BY id').all(agentRun.run_id) as Array<{ call_type: string }>
    const assistantTurns = db.prepare("SELECT turn_id,content FROM turns WHERE run_id=? AND role='assistant' ORDER BY turn_seq").all(run.run_id) as Array<{ turn_id: string; content: string }>
    const manifests = (db.prepare('SELECT round,manifest_json FROM context_manifests WHERE run_id=? ORDER BY round').all(run.run_id) as Array<{ round: number; manifest_json: string }>).map((row) => ({ round: row.round, value: JSON.parse(row.manifest_json) as any }))
    const uiChars = Array.from(uiText); const dbChars = Array.from(durable); const diffAt = uiChars.findIndex((ch, i) => ch !== dbChars[i])
    check('UI-turns-session-canonical-exact-4000', run.status === 'completed' && cpLen(uiText) === 4000 && uiText === durable && projected === durable && !durable.includes('人生的意义'), `status=${run.status} ui=${cpLen(uiText)} turns=${cpLen(durable)} session=${cpLen(projected)} same=${uiText === durable && projected === durable} diffAt=${diffAt} ui=${JSON.stringify(uiChars.slice(diffAt, diffAt + 30).join(''))} db=${JSON.stringify(dbChars.slice(diffAt, diffAt + 30).join(''))}`)
    const expectedPrefix = Array.from(WRITER).slice(0, Array.from(WRITER).lastIndexOf('\n') + 1).join('')
    check('UI-prefix-hash-preserved', evidence.stage === 'accepted' && evidence.retentionRate > 0.9 && evidence.prefixHash === createHash('sha256').update(expectedPrefix).digest('hex'), `stage=${evidence.stage} retention=${evidence.retentionRate} prefix=${evidence.prefixHash} expected=${createHash('sha256').update(expectedPrefix).digest('hex')}`)
    check('UI-provider-call-order', mock.purposes.slice(0, 4).join(',') === 'writer,critic,editor,critic', mock.purposes.join(','))
    check('UI-provider-purpose-isolated-by-run', usage.map((row) => row.call_type).join(',') === 'kernel-chat,kernel-critic,kernel-editor,kernel-critic' && agentRun.status === 'completed' && agentUsage.map((row) => row.call_type).join(',') === 'kernel-chat', `long=${usage.map((row) => row.call_type).join(',')} agent=${agentUsage.map((row) => row.call_type).join(',')} endpoint=${mock.purposes.join(',')}`)
    const lastAssistant = assistantTurns[assistantTurns.length - 1]
    check('UI-final-constraint-evidence-binds-full-draft', strongEvidence.status === 'passed' && strongEvidence.draftHash === createHash('sha256').update(durable).digest('hex') && strongEvidence.latestSegmentHash === createHash('sha256').update(lastAssistant?.content ?? '').digest('hex') && evidence.turnId === lastAssistant?.turn_id && evidence.candidateHash === createHash('sha256').update(lastAssistant?.content ?? '').digest('hex'), `turns=${assistantTurns.length} evidenceTurn=${evidence.turnId} last=${lastAssistant?.turn_id} draft=${strongEvidence.draftHash}`)
    check('UI-usage-writer-critic-editor', ['kernel-chat', 'kernel-critic', 'kernel-editor'].every((kind) => usage.some((row) => row.call_type === kind)))
    check('UI-aux-context-manifest-isolated', manifests.some((m) => m.round < 0 && m.value.segments.some((s: any) => s.sourceIds?.some((id: string) => id.startsWith('internal:critic:')))) && manifests.some((m) => m.round < 0 && m.value.segments.some((s: any) => s.sourceIds?.some((id: string) => id.startsWith('internal:editor:')))))
    check('UI-aux-does-not-copy-history', manifests.filter((m) => m.round < 0).every((m) => !m.value.segments.some((s: any) => s.kind === 'history' && (s.actualTokens ?? 0) > 0)))
  } finally { db.close() }
  console.log(`R42 Electron UI: ${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => { console.error(error); process.exit(2) })
