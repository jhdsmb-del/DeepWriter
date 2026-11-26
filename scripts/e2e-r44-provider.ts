import * as path from 'node:path'
import * as url from 'node:url'
import * as http from 'node:http'
import { execSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { _electron as electron } from '@playwright/test'

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
let passed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`)
  passed += 1
  console.log(`  PASS  ${name}`)
}

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'e2e-reasoner', name: 'E2E Reasoner' }] }))
    return
  }
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    const body = JSON.parse(raw) as { stream?: boolean }
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"id":"e2e-chat","choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\ndata: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 4, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 1 } } }))
    }
  })
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const userData = await mkdtemp(path.join(tmpdir(), 'deepwriter-r44-e2e-'))
const app = await electron.launch({
  args: [path.join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData }
})

try {
  console.log('\n[R44-E2E] 真实 Electron Provider→凭据→discover→probe→Profile')
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByTestId('provider-registry').waitFor({ state: 'visible' })
  await page.getByLabel('提供方').locator('option', { hasText: 'DeepSeek（内置）' }).waitFor({ state: 'attached' })
  check('设置页可见内置 DeepSeek 与默认 Profile 入口', await page.getByLabel('提供方').locator('option', { hasText: 'DeepSeek（内置）' }).count() > 0 && await page.getByLabel('新任务默认 Profile').count() === 1)

  await page.getByText('添加自定义 Provider').click()
  const providerBlock = page.locator('details.dw-provider-block').filter({ hasText: '添加自定义 Provider' })
  await providerBlock.getByLabel('名称').fill('E2E Local Provider')
  await providerBlock.getByLabel('API Host（不含路径）').fill(`http://127.0.0.1:${port}`)
  await providerBlock.getByLabel('网络范围').selectOption('loopback_http')
  await providerBlock.getByRole('button', { name: '创建 Provider' }).click()
  await page.getByText('Provider 已创建；请继续添加凭据和模型。').waitFor()
  check('自定义 Provider 经 UI 创建并切换为当前项', await page.getByLabel('提供方').inputValue().then((value) => value.startsWith('provider.custom.')))

  const credentialSection = page.getByRole('region', { name: '凭据' })
  await credentialSection.getByLabel('凭据名称').fill('E2E key')
  await credentialSection.getByLabel('API Key').fill('sk-e2e-never-export')
  await credentialSection.getByRole('button', { name: '保存新凭据' }).click()
  await page.getByText('凭据已加密保存；明文不可读回。').waitFor()
  check('凭据输入保存后立即清空且只显示尾号', await credentialSection.getByLabel('API Key').inputValue() === '' && await credentialSection.getByText(/••••port/).count() > 0)

  const modelSection = page.getByRole('region', { name: '模型' })
  await modelSection.getByRole('button', { name: '获取模型' }).click()
  await page.getByText('已保存 1 个模型。').waitFor()
  await modelSection.getByRole('button', { name: /E2E Reasoner/ }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await modelSection.getByRole('button', { name: '探测所选模型推理能力' }).click()
  await page.getByText('能力探测完成；结果和 usage 已持久化。').waitFor()
  check('显式 probe 后能力证据变为已验证', await modelSection.getByText(/推理：已验证/).count() > 0)

  const profileSection = page.getByRole('region', { name: '写作 Profile' })
  await profileSection.getByLabel('名称').fill('E2E 强推理写作')
  await profileSection.getByLabel('推理模式').selectOption('enabled')
  await profileSection.getByLabel('推理强度').selectOption('high')
  await profileSection.getByRole('button', { name: '保存并用于新任务' }).click()
  await page.getByText('已设为新任务默认 Profile；运行中的任务保持原快照。').waitFor()
  check('Profile 成为新任务默认且推理选项来自 capability', await page.getByLabel('新任务默认 Profile').locator('option:checked').textContent() === 'E2E 强推理写作')

  const providerId = await page.getByLabel('提供方').inputValue()
  const profileId = await page.getByLabel('新任务默认 Profile').inputValue()
  const runId = `r44-e2e-run-${Date.now()}`
  await page.evaluate(async (id: string) => (window as any).ds.chatStart({ id, sessionId: `session-${id}`, mode: 'agent', text: '验证自定义模型链路', fixedPrefix: [], attachments: [] }), runId)
  let billing: any = null
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    billing = await page.evaluate(async (id: string) => (window as any).ds.runsGetBilling(id), runId)
    if (billing?.attempts?.some((attempt: any) => attempt.outcome === 'success')) break
    await page.waitForTimeout(200)
  }
  const attempt = billing?.attempts?.find((entry: any) => entry.outcome === 'success')
  check('真实 chat 主链使用所选 provider/model/profile 并落 provider attempt', attempt?.providerId === providerId && attempt?.modelId === 'e2e-reasoner' && attempt?.profileId === profileId, JSON.stringify(attempt))
  check('自定义兼容端点费用保持 unknown/null，不伪造 0', attempt?.costStatus === 'unknown' && attempt?.costAmount === null && billing?.cost?.status === 'unknown')

  await page.getByText('导入与导出（不含密钥）').click()
  const importBlock = page.locator('details.dw-provider-block').filter({ hasText: '导入与导出（不含密钥）' })
  await importBlock.getByRole('button', { name: '生成导出内容' }).click()
  const exported = await importBlock.getByLabel('Provider 配置 JSON').inputValue()
  check('导出内容没有 secret、credentialRef、maskedHint', !/sk-e2e|credentialRef|maskedHint|encrypted|authorization/i.test(exported), exported.slice(0, 120))

  const snapshot = await page.evaluate(async () => (window as any).ds.providerSnapshot())
  check('renderer DTO 不含 encrypted blob 或可读 secret', snapshot.ok === true && !/sk-e2e-never-export|encrypted_blob/i.test(JSON.stringify(snapshot)))
  console.log(`\n[R44-E2E] ${passed}/${passed} PASS`)
} finally {
  try {
    const page = app.windows().find((candidate) => !candidate.url().includes('window=float'))
    await page?.evaluate(async () => (window as any).ds.testShutdown()).catch(() => undefined)
    const guard = setTimeout(() => {
      try {
        if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${app.process().pid}`, { stdio: 'ignore' })
        else process.kill(app.process().pid, 'SIGKILL')
      } catch { /* already closed */ }
    }, 20_000)
    await app.close().catch(() => undefined)
    clearTimeout(guard)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(userData, { recursive: true, force: true })
  }
}
