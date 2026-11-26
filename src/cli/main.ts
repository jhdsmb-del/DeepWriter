import { readProjectBrief, saveProjectBrief } from '../main/projectBrief'
import { getRunWorkPlan } from '../main/workPlan'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { answerGrillMe, acceptAssumptions, confirmGrillMeOutline, type GrillMeDecision } from '../shared/grillMe'
import type { RecoveryDecision } from '../main/jobs/types'
import type { NarrativeSemanticReviewDecision } from '../shared/types'
import { loadCliConfig, redactCliSecrets } from './config'
import { acquireCliLock, createCliRuntime } from './runtime'
import { createHumanOutput } from './presentation'
import { ExtensionRegistry } from '../main/extensions/ExtensionRegistry'

import { HELP, parse, required, integer } from './arguments'
import { createInterviewController } from './interview'
import { runInteractive } from './interactive'
import { createTerminalQuestion, CliPromptInterrupted } from './terminal'
import { readPrompt } from './input'
import { printRunSources } from './sources'
import { runLocalEdits } from './localEdits'
import { localSteering } from './steering'
import { prepareOutput, saveOutput } from './output'

declare const __DEEPWRITER_VERSION__: string

const knownSecrets = new Set<string>()
const rememberSecret = (secret: string): void => { if (secret) knownSecrets.add(secret) }
rememberSecret(process.env.DEEPWRITER_API_KEY ?? '')
const redactError = (text: string): string => redactCliSecrets(text, knownSecrets)

async function main(): Promise<void> {
  const { args, options } = parse(process.argv.slice(2))
  if (typeof options['key-env'] === 'string') rememberSecret(process.env[options['key-env']] ?? '')
  if (options.version || args[0] === 'version') { process.stdout.write(`${__DEEPWRITER_VERSION__}\n`); return }
  const isTerminal = Boolean(process.stdin.isTTY && process.stderr.isTTY)
  if (options.help || (!args.length && !isTerminal) || args[0] === 'help') { process.stdout.write(HELP); return }
  const interactiveAgent = args[0] === 'agent' && args.length === 1 && !options.input && isTerminal
  const command = interactiveAgent ? 'interactive' : args[0] ?? 'interactive'
  if (command === 'update') {
    const { runCliUpdate } = await import('./update')
    await runCliUpdate(args, options, __DEEPWRITER_VERSION__)
    return
  }
  if (interactiveAgent) { options.tools = true; options['agent-session'] = true }
  const commands = ['interactive', 'brief', 'config', 'chat', 'agent', 'plan', 'plan-info', 'approve', 'reject-plan', 'write', 'interview', 'answer', 'assumptions', 'outline', 'confirm', 'start', 'resume', 'pause', 'cancel', 'list', 'status', 'usage', 'sources', 'changes', 'undo-edit', 'recover-info', 'recover', 'review', 'skills', 'plugins', 'export']
  commands.push('steer', 'steering', 'galgame')
  if (!commands.includes(command)) throw new Error(`未知命令：${command}；运行 --help 查看入口`)
  if (options.draft && command !== 'export') throw new Error('--draft 只用于 export RUN，取回已接纳正文而不宣告任务完成')
  if (options.input && !(command === 'brief' && args[1] === 'init') && !['chat', 'agent', 'plan', 'write', 'interview', 'answer'].includes(command)) throw new Error('--input 只用于 brief init / chat / agent / plan / write / interview / answer')
  if (options.output && !['chat', 'agent', 'plan', 'approve', 'confirm', 'start', 'resume', 'export'].includes(command)) throw new Error('--output 只用于 chat / agent / plan / approve / confirm / start / resume / export；长文完成后也可 export RUN')
  if (command === 'answer' && options.decision && options.decision !== 'answer' && (options.input || options.text)) throw new Error('decide / not_applicable 不接受 --text 或 --input；请明确选择答案或决策')
  if (command === 'galgame') {
    if (args.length !== 3 || args[1] !== 'routes') throw new Error('用法：deepwriter galgame routes <项目目录> [--json]')
    const { printGalgameRoutes } = await import('./galgameRoutes')
    process.exitCode = await printGalgameRoutes(args[2], Boolean(options.json))
    return
  }
  const output = options.output ? await prepareOutput(String(options.output)) : command === 'export' ? '-' : undefined
  const prompt = ['chat', 'agent', 'plan', 'write', 'interview'].includes(command)
    ? await readPrompt(args.slice(1).join(' '), typeof options.input === 'string' ? options.input : undefined)
    : command === 'answer' && (options.decision === undefined || options.decision === 'answer')
      ? await readPrompt(typeof options.text === 'string' ? options.text : '', typeof options.input === 'string' ? options.input : undefined)
      : undefined
  const dataDir = path.resolve(String(options['data-dir'] ?? path.join(process.cwd(), '.deepwriter-cli')))
  if (options.offset !== undefined && command !== 'sources') throw new Error('--offset 只用于 sources RUN')
  if (!['changes', 'undo-edit', 'sources', 'steer', 'steering'].includes(command)) await fs.mkdir(dataDir, { recursive: true })
  if (command === 'skills' || command === 'plugins') {
    // Extension management needs no credential, Provider config, SQLite run
    // or executing host. Install/enable therefore cannot start a process.
    const registry = new ExtensionRegistry(path.resolve(String(options['extensions-dir'] ?? process.env.DEEPWRITER_EXTENSIONS_DIR ?? path.join(dataDir, 'extensions'))))
    const kind = command === 'skills' ? 'skill' : 'tool'
    const verb = args[1] ?? 'list'
    let value: unknown
    if (verb === 'catalog') {
      if (args[2] && kind !== 'skill') throw new Error('第三方工具catalog blocked；本地静态目录只导入技能指令子集')
      value = args[2] ? await registry.localCatalog(args[2]) : registry.catalog().filter((item) => item.kind === kind)
    }
    else if (verb === 'list') value = await registry.list(kind)
    else if (verb === 'install') value = await registry.install(required(args[2], 'SOURCE（builtin:id 或本地技能目录）'), kind)
    else {
      const id = required(args[2], 'ID')
      const item = await registry.inspect(id)
      if (item.kind !== kind) throw new Error('扩展类型与命令不匹配')
      if (verb === 'inspect') { await registry.verify(item); value = item }
      else if (verb === 'enable' || verb === 'disable' || verb === 'remove') value = await registry.setEnabled(id, verb === 'enable', verb === 'remove')
      else throw new Error('扩展命令仅支持 catalog/list/install/enable/disable/remove/inspect')
    }
    if (options.json) process.stdout.write(JSON.stringify({ type: 'extensions', data: value }) + '\n')
    else {
      const items = (Array.isArray(value) ? value : [value]) as Array<{ id: string; version: string; enabled?: boolean; removed?: boolean; description: string; packageHash?: string }>
      process.stdout.write(items.length ? items.map((item) => `${item.id} · ${item.version} · ${item.removed ? '已卸载（原版本保留）' : item.enabled === undefined ? '可安装' : item.enabled ? 'enabled' : 'disabled'}\n${item.description.replace(/[\r\n\t]/g, ' ').slice(0, 1024)}${item.packageHash ? '\nSHA256 ' + item.packageHash : ''}`).join('\n') + '\n' : '暂无已安装扩展。\n')
    }
    return
  }
  const redact = redactError
  const humanOutput = createHumanOutput((text) => process.stdout.write(redact(text)), (text) => process.stderr.write(redact(text)))
  let completedRun: string | undefined
  const emit = (type: string, data: unknown): void => {
    if (type === 'result') {
      const result = data as { status: string; runId: string }
      completedRun = result.status === 'completed' ? result.runId : undefined
      process.exitCode = result.status === 'completed' ? 0 : result.status === 'failed' || result.status === 'cancelled' ? 1 : 2
    }
    if (options.json) process.stdout.write(JSON.stringify({ type, data }, (_key, value) => typeof value === 'string' ? redact(value) : value) + '\n')
    else if (!output || !['delta'].includes(type)) humanOutput(type, data)
  }
  if (command === 'sources') { await printRunSources(dataDir, args, options.offset, emit); return }
  if (command === 'steer' || command === 'steering') { await localSteering(command, args, dataDir, options, emit); return }
  if (command === 'changes' || command === 'undo-edit') {
    await runLocalEdits(command, args, dataDir, options, emit)
    return
  }
  const { config, secret } = await loadCliConfig(dataDir, options, rememberSecret)
  if (Object.values(config).some(value => typeof value === 'string' && knownSecrets.has(value))) throw new Error('非密钥配置字段中出现了密钥值，未保存或发送；请检查模型名称、端点和目录')
  if (command === 'brief') {
    const verb = args[1] ?? 'show'
    if (!['show', 'init'].includes(verb) || args.length > 2) throw new Error('用法：brief show 或 brief init [--input 文件]')
    const prior = await readProjectBrief(config.workDir)
    let brief = prior
    if (verb === 'init') {
      if (prior.state !== 'missing') throw new Error('项目约定已存在或不可写，不覆盖。用 brief show 查看位置。')
      const text = typeof options.input === 'string' ? await readPrompt('', options.input) : ''
      brief = await saveProjectBrief(config.workDir, { path: prior.path, text: '', exists: false }, text)
    }
    if (options.json) emit('brief', brief)
    else {
      const plain = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
      process.stdout.write(redact(plain([brief.path, brief.notice, verb === 'init' ? '已创建项目约定。' : brief.state === 'missing' ? '尚无项目约定；用 brief init 创建。' : brief.text].filter(Boolean).join('\n'))) + '\n')
    }
    if (brief.state === 'unavailable') process.exitCode = 1
    return
  }
  if (command === 'config') {
    if (!args[1] || args[1] === 'show') emit('config', config)
    else if (args[1] === 'set') {
      const temporary = path.join(dataDir, `.config-${randomUUID()}.tmp`)
      await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      try { await fs.rename(temporary, path.join(dataDir, 'config.json')) } finally { await fs.unlink(temporary).catch(() => undefined) }
      emit('config', config)
    } else throw new Error('config 仅支持 show / set')
    return
  }
  const readOnly = ['list', 'status', 'usage', 'recover-info', 'export', 'plan-info'].includes(command)
  const control = command === 'pause' || command === 'cancel'
  const release = readOnly || control ? async () => undefined : await acquireCliLock(dataDir)
  const terminal = isTerminal ? createInterface({ input: process.stdin, output: process.stderr }) : null
  const askLine = terminal ? createTerminalQuestion(terminal) : null
  let promptController: AbortController | null = null
  const question = async (message: string): Promise<string> => {
    if (!askLine) throw new Error('此操作需要交互终端；请使用 answer / assumptions / confirm 显式提供决策')
    const controller = new AbortController(); promptController = controller
    try { return await askLine(redact(message), controller.signal) }
    catch (error) { if (controller.signal.aborted) throw new CliPromptInterrupted('已保存当前状态'); throw error }
    finally { if (promptController === controller) promptController = null }
  }
  let runtime: Awaited<ReturnType<typeof createCliRuntime>>
  try { runtime = await createCliRuntime({ dataDir, config, secret, options, emit, ask: terminal ? async (message) => {
    // Text pasted before a permission prompt is never an authorization.
    askLine?.discardPending()
    return (await question(message)).trim() === 'allow'
  } : undefined }) }
  catch (error) { terminal?.close(); await release(); throw error }
  let handlingSignal = false
  let exitInteractive = false
  let interactiveBusy = false
  terminal?.on('close', () => { exitInteractive = true; promptController?.abort() })
  const onSignal = (): void => {
    if (handlingSignal) return
    handlingSignal = true
    exitInteractive = command !== 'interactive'
    process.exitCode = 2
    askLine?.discardPending(); promptController?.abort()
    process.stderr.write(interactiveBusy || command !== 'interactive' ? '\n正在保存并暂停；使用 /resume RUN 恢复。\n' : '\n已清空输入。/exit 退出。\n')
    void runtime.interrupt('pause').catch(() => { process.exitCode = 1 })
  }
  const onTerminate = (): void => { onSignal(); exitInteractive = true; terminal?.close() }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onTerminate)
  // readline consumes terminal Ctrl+C itself. Handle that real platform
  // event as well as process signals; do not emulate a TTY in tests.
  terminal?.on('SIGINT', onSignal)
  const { getState, newInterview, interactiveWrite } = createInterviewController(runtime, config, emit, question, () => { handlingSignal = false })
  const showUsage = (runId?: string): void => {
    const totals = runtime.repo.getUsageTotals(runId)
    emit('usage', { tokens: { calls: totals.calls, inputTokens: totals.input_tokens, outputTokens: totals.output_tokens, cacheHitTokens: totals.cache_hit, cacheMissTokens: totals.cache_miss }, billing: runId ? runtime.repo.getRunBilling(runId) : null, amountStatus: 'unknown', amount: null, currency: null,
      planning: runtime.repo.listSessions().map((session) => { const state = runtime.repo.getGrillMeState(session.session_id); return state ? { sessionId: session.session_id, latestPlanningUsage: state.planning.usage } : null }).filter(Boolean) })
  }
  try {
    if (command === 'interactive') {
      if (!terminal) throw new Error('interactive 需要交互终端；管道请用 chat - 或显式命令')
      await runInteractive({ runtime, config, options, emit, question, redact, interactiveWrite, newInterview, getState, showUsage, interrupted: () => exitInteractive, beforePrompt: () => { handlingSignal = false }, busy: (value) => { interactiveBusy = value } })
    } else if (command === 'list') emit('list', { runs: runtime.repo.listRecentRuns(100).map((row) => ({ runId: row.run_id, sessionId: row.session_id, status: row.status, phase: row.phase, errorCode: row.error_code })), sessions: runtime.repo.listSessions() })
    else if (command === 'status') {
      const id = args[1]
      const row = id ? runtime.repo.getRun(id) : null
      if (row) emit('status', { runId: row.run_id, sessionId: row.session_id, status: row.status, phase: row.phase, errorCode: row.error_code, errorMessage: row.error_message, artifacts: runtime.repo.getArtifactsByRun(row.run_id), budget: runtime.repo.getRunEvidence(row.run_id, 'run_provider_budget_v1'), workPlan: getRunWorkPlan(runtime.repo, row.run_id) })
      else if (id) emit('state', getState(id))
      else emit('status', { active: runtime.repo.listActiveRuns().map((run) => ({ runId: run.run_id, status: run.status, errorCode: run.error_code })) })
    } else if (command === 'usage') {
      showUsage(args[1])
    }
    else if (control) {
      const id = required(args[1], 'RUN'); const row = runtime.repo.getRun(id)
      if (!row) throw new Error('运行不存在')
      if (['completed', 'failed', 'cancelled'].includes(row.status)) throw new Error('运行已终态')
      // A separate terminal records an intent; only the owning execution
      // process may mutate its live engine. No PID killing or tool replay.
      runtime.repo.saveRunEvidence(id, 'cli_control', JSON.stringify({ action: command, requestedAt: Date.now() }))
      emit('status', { runId: id, intent: command, accepted: true, note: '执行进程将在安全边界处理；若进程已退出，使用 resume 处理此意图' })
    } else if (command === 'export') {
      completedRun = required(args[1], 'RUN')
    } else if (command === 'plan-info') emit('plan', runtime.savedPlan(required(args[1], 'RUN')))
    else if (command === 'approve') await runtime.approvePlan(required(args[1], 'RUN'), required(options.hash, 'hash'))
    else if (command === 'reject-plan') emit('plan', runtime.rejectPlan(required(args[1], 'RUN'), required(options.hash, 'hash')))
    else if (command === 'chat' || command === 'agent' || command === 'plan') {
      await runtime[command](prompt!, typeof options.session === 'string' ? options.session : undefined)
    } else if (command === 'write' || command === 'interview') {
      const state = await newInterview(prompt!, integer(options.target, 'target', 100))
      if (command === 'write' && terminal) await interactiveWrite(state)
      else emit('state', state)
    } else if (command === 'answer') {
      const state = getState(args[1])
      if (!['interviewing', 'manual_completion'].includes(state.status) || !state.currentQuestion) throw new Error('当前状态不接受采访答案')
      const decision = String(options.decision ?? 'answer') as GrillMeDecision
      if (!['answer', 'decide', 'not_applicable'].includes(decision)) throw new Error('采访决策无效')
      const id = required(options.question, 'question')
      if (id !== state.currentQuestion.id) throw new Error('question 与当前问题不一致，拒绝应用过期答案')
      const next = answerGrillMe(state, id, decision === 'answer' ? prompt! : '', decision)
      runtime.repo.saveGrillMeState(next); emit('state', next)
    } else if (command === 'assumptions') {
      const state = getState(args[1])
      if (state.status !== 'assumption_review' || Boolean(options.accept) === Boolean(options.reject)) throw new Error('必须在待确认假设状态下明确 --accept 或 --reject')
      const next = acceptAssumptions(state, options.accept === true); runtime.repo.saveGrillMeState(next); emit('state', next)
    } else if (command === 'outline') emit('state', await runtime.outline(getState(args[1])))
    else if (command === 'confirm' || command === 'start') {
      let state = getState(args[1])
      if (command === 'confirm') { state = confirmGrillMeOutline(state, required(options.hash, 'hash')); runtime.repo.saveGrillMeState(state) }
      if (state.status !== 'confirmed') throw new Error('大纲尚未确认，拒绝正文')
      await runtime.write(state)
    } else if (command === 'resume') await runtime.resume(required(args[1], 'RUN'))
    else if (command === 'recover-info') emit('recovery', await runtime.engine.recoverInfo(required(args[1], 'RUN')))
    else if (command === 'recover') {
      const decision = required(options.decision, 'decision') as RecoveryDecision
      if (!['confirm_applied', 'retry_not_applied', 'abandon'].includes(decision)) throw new Error('恢复决策无效；CLI 不提供未经检查点验证的自动回滚')
      const result = await runtime.engine.applyRecoveryDecision(required(args[1], 'RUN'), decision, { actor: 'cli' }); emit('recovery', result)
      if (!result.ok) process.exitCode = 2
    } else if (command === 'review') {
      const runId = required(args[1], 'RUN')
      if (!options.decision) emit('review', await runtime.engine.getNarrativeReview(runId))
      else {
        const decision = required(options.decision, 'decision') as NarrativeSemanticReviewDecision
        if (!['accept_unknown', 'accept_prose_no_state', 'reject_rewrite', 'abandon'].includes(decision)) throw new Error('CLI 语义决策无效')
        const row = runtime.repo.getRun(runId)
        // Every command is a new Node host. Rehydrate the shared engine's
        // original durable review fence, never step/capture a fresh head here.
        if (row && !['completed', 'failed', 'cancelled'].includes(row.status)) await runtime.engine.restore(runId)
        const result = await runtime.engine.applyNarrativeReviewDecision({ runId, decision, expectedRevision: integer(options.revision, 'revision'), decisionId: `cli_review_${randomUUID()}` }, { actor: 'cli' })
        emit('review', result); if (!result.ok) process.exitCode = 2
      }
    } else throw new Error(`未知命令：${command}；运行 --help 查看入口`)
    if (output && completedRun) {
      const content = redact(options.draft ? runtime.draftText(completedRun) : runtime.completedText(completedRun))
      if (output !== '-') await saveOutput(output, content)
      const receipt = { runId: completedRun, ...(options.draft ? { kind: 'draft', runStatus: runtime.repo.getRun(completedRun)?.status } : {}), path: output === '-' ? null : output, bytes: Buffer.byteLength(content), ...(output === '-' && options.json ? { content: redact(content) } : {}) }
      if (options.json) emit('export', receipt)
      else if (output === '-') process.stdout.write(redact(content))
      else process.stderr.write(`已导出${options.draft ? '已收稿部分' : ''} ${redact(output)} · ${receipt.bytes} bytes\n`)
    }
  } finally {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onTerminate)
    terminal?.removeListener('SIGINT', onSignal)
    terminal?.close(); try { await runtime.close() } finally { await release() }
  }
}

void main().catch((error: unknown) => {
  if (error instanceof CliPromptInterrupted) { process.exitCode = 2; return }
  // Provider errors are persisted by the shared engine. The top-level boundary
  // only emits our bounded operational messages, never a provider response dump.
  const text = redactError(error instanceof SyntaxError ? 'JSON 配置或持久化数据无效（不显示源内容）' : error instanceof Error ? error.message : 'CLI 操作失败').slice(0, 1000)
  const rawArgs = process.argv.slice(2)
  const end = rawArgs.indexOf('--')
  if ((end < 0 ? rawArgs : rawArgs.slice(0, end)).includes('--json')) process.stdout.write(JSON.stringify({ type: 'error', data: { code: 'cli_error', message: text } }) + '\n')
  process.stderr.write(`DeepWriter CLI: ${text}\n`)
  process.exitCode = 1
})
