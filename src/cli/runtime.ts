import { AGENT_OUTPUT_PART } from '../main/jobs/agentContinuation'
import { WORK_PLAN_TOOL } from '../shared/workPlan'
import { GOAL_TOOL } from '../shared/goalMode'
import { getRunGoal } from '../main/goalMode'
import { goalCandidateTurns } from '../main/jobs/goalAnswer'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { createRepository } from '../main/db/repository'
import { createAgentRunEngine, type AgentRunEngine } from '../main/jobs/AgentRunEngine'
import { searchRunConversation } from '../main/conversationSearch'
import { CONVERSATION_SEARCH_TOOL } from '../shared/conversationSearch'
import { createRunStorePort, createModelCallAdapter, createToolExecutor, allowListFromConfig } from '../main/runKernelAdapter'
import { createContextService } from '../main/contextService'
import { ContextV2Service, contextHash } from '../main/contextV2'
import { buildExecutionSnapshot, applySnapshotGate } from '../main/executionSnapshot'
import { savedAgentPlan, rejectAgentPlan } from '../main/agentPlan'
import { isReadOnlyAgentPlan, planToolAllowList } from '../shared/agentPlanPolicy'
import { startChatRun, type ChatStartPayload } from '../main/chatStart'
import { createPermissionManager } from '../main/permissions'
import { setPermissionManager } from '../main/agentTools'
import { readProjectBrief } from '../main/projectBrief'
import { createCheckpointStore, setCheckpointStore } from '../main/checkpoint'
import { CredentialMissingError } from '../main/credentialRegistry'
import { streamChat } from '../main/deepseek'
import { buildGrillMePlanningPrompt, buildGrillMePlanningRepairPrompt, applyPlanningModelResult, markPlanningRunning, canonicalizeGrillMePayload, grillMeInterviewReadyForOutline, grillMeHasBodyRun, type GrillMeState } from '../shared/grillMe'
import type { RunEngineEvent } from '../main/jobs/types'
import type { DsMessage } from '../shared/types'
import { configureTerminalHost } from './host'
import { cliAgentRunBudget, cliEnvironmentSecret, cliModelContext, credentialFingerprint, kernelApi, redactCliSecrets, validateCliModel, validateCliProvider, type CliConfig, type CliOptions } from './config'
import { approveAgentMutation } from './toolApproval'
import { WEB_TOOL_NAMES } from '../shared/agentToolPolicy'
import { WORK_FILE_TOOL_NAMES } from '../shared/workFileTools'
import { publishCliManuscript } from './manuscript'
import { readRunManuscript } from '../main/manuscriptView'
import { undoEdit } from './changes'
import { freezeRunWebAccess, frozenRunWebAccess } from '../main/runWebAccess'
import { createRunProviderWeb } from '../main/providerWebRuntime'
import { removeRunCallLimit } from '../main/runCallLimitAuthorization'
import { ExtensionRegistry } from '../main/extensions/ExtensionRegistry'
import { ExtensionActivation, extensionIds, freezeExtensions, skillMessages, type ExtensionSnapshot } from '../main/extensions/ExtensionActivation'

export type CliRuntime = Awaited<ReturnType<typeof createCliRuntime>>
export type Emit = (type: string, data: unknown) => void
type FrozenCliProvider = { config: CliConfig; fingerprint: string; explicitConfigPath?: string; tools: boolean; unknownCostAccepted: boolean }
const TOOL_ALLOW_LIST = ['read_file', 'list_files', 'search_files', ...WORK_FILE_TOOL_NAMES, 'write_file', 'edit_file', 'run_command']

export function resolveFrozenCliSecret(frozen: Pick<FrozenCliProvider, 'config' | 'fingerprint' | 'explicitConfigPath'>, current: CliConfig, options: CliOptions, currentSecret: string): string {
  const origin = new URL(frozen.config.baseUrl).origin
  if (frozen.config.keyEnvOrigin === undefined && !frozen.explicitConfigPath && frozen.config.keyEnv === 'DEEPWRITER_API_KEY' && origin !== 'https://api.deepseek.com') {
    if (options['key-env'] !== 'DEEPWRITER_API_KEY' || current.baseUrl !== origin) throw new CredentialMissingError(null,
      `旧运行未记录默认环境密钥对此 origin 的授权；核对原服务 ${origin} 后，使用 --base-url ${origin} --key-env DEEPWRITER_API_KEY 恢复，不自动跨服务发送`)
  }
  // Explicit files retain their historical priority; every source must still
  // match the original origin/header/key fingerprint, never a new credential.
  const secret = frozen.explicitConfigPath ? currentSecret : cliEnvironmentSecret(frozen.config)
  if (credentialFingerprint(secret, frozen.config.baseUrl, frozen.config.authHeaderName) !== frozen.fingerprint) throw new CredentialMissingError(null, 'CLI 凭据缺失或已更换；不能用新密钥自动恢复旧运行')
  return secret
}

export async function acquireCliLock(dataDir: string): Promise<() => Promise<void>> {
  const file = path.join(dataDir, 'execution.lock')
  const content = JSON.stringify({ pid: process.pid, nonce: randomUUID() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600)
      try { await handle.writeFile(content, 'utf8') } finally { await handle.close() }
      return async () => { if (await fs.readFile(file, 'utf8').catch(() => '') === content) await fs.unlink(file) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const previous = await fs.readFile(file, 'utf8')
      let pid: number
      try { pid = JSON.parse(previous).pid } catch { throw new Error('CLI 执行锁损坏，拒绝并发写入；请检查 execution.lock') }
      if (!Number.isInteger(pid) || pid < 1) throw new Error('CLI 执行锁无效')
      try { process.kill(pid, 0); throw new Error('已有 CLI 正在执行；可在另一个终端使用 status / pause / cancel') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      if (await fs.readFile(file, 'utf8') !== previous) throw new Error('CLI 执行锁已改变，请重试')
      await fs.unlink(file)
    }
  }
  throw new Error('无法获取 CLI 执行锁')
}

export async function createCliRuntime(input: {
  dataDir: string; config: CliConfig; secret: string; options: CliOptions; emit: Emit; ask?: (message: string) => Promise<boolean>
}) {
  const { dataDir, options, emit } = input
  const credentialSecrets = new Set<string>([input.secret])
  let config = { ...input.config }
  const selectedSkills = extensionIds(options.skill)
  const selectedPlugins = extensionIds(options.plugin)
  const startGrants = extensionIds(options['allow-plugin-start'])
  const extensions = new ExtensionActivation({
    nodeExecutable: process.execPath,
    authorizeStart: async (id, hash, runId) => {
      const allowed = startGrants.includes(id) || Boolean(cfgFor(runId).goalMode !== 'autonomous' && input.ask && await input.ask(`启动第一方Node插件 ${id}（${hash}）？没有OS沙箱；只读当前冻结工作/文档目录。输入 allow 才启动`))
      repo.saveRunEvidence(runId, `extension_start_grant_${randomUUID()}`, JSON.stringify({ id, packageHash: hash, decision: allowed ? 'allow' : 'deny', at: Date.now(), actor: 'cli', source: startGrants.includes(id) ? 'explicit_flag' : 'terminal_or_non_tty_denial' }))
      return allowed
    },
    onStarted: (runId, pin, pid, roots) => {
      repo.saveRunEvidence(runId, `extension_host_started_${randomUUID()}`, JSON.stringify({ id: pin.record.id, packageHash: pin.record.packageHash, pid, roots, protocolVersion: '2025-11-25', at: Date.now() }))
      emit('extension', { runId, id: pin.record.id, state: 'started', packageHash: pin.record.packageHash, protocolVersion: '2025-11-25' })
    },
    onStopped: (runId, result) => {
      repo.saveRunEvidence(runId, `extension_host_stopped_${randomUUID()}`, JSON.stringify({ ...result, at: Date.now() }))
      emit('extension', { runId, state: result.exited ? 'exited' : 'close_unconfirmed', pid: result.pid, remainingPids: result.remainingPids })
    },
    onRevoked: async (runId, message) => {
      repo.saveRunEvidence(runId, `extension_permission_revoked_${randomUUID()}`, JSON.stringify({ message, at: Date.now() }))
      emit('extension', { runId, state: 'permission_revoked', message })
      await engine.pause(runId)
    }
  })
  configureTerminalHost({ dataDir, docDir: config.docDir, ask: input.ask })
  await fs.mkdir(path.join(dataDir, 'temp'), { recursive: true })
  const repo = createRepository(path.join(dataDir, 'deepwriter.sqlite'))
  await repo.open()
  const permissions = createPermissionManager(dataDir, async (type, target, _identity, view) => {
    if (!input.ask) return { action: 'deny', remember: false, reason: '当前为非交互执行，需要交互授权；本次操作未获批准' }
    return { action: await input.ask(`${view?.operation ?? type}：${target}\n${view?.reason ?? '需要单独授权'}\n输入 allow 才会允许`) ? 'allow' : 'deny', remember: false }
  })
  setPermissionManager(permissions)
  const checkpoints = createCheckpointStore(path.join(dataDir, 'checkpoints'))
  setCheckpointStore(checkpoints)
  const contextV2 = new ContextV2Service(path.join(dataDir, 'deepwriter.sqlite'))
  const context = createContextService(repo, contextV2)
  let engine: AgentRunEngine
  let activeRun: string | null = null
  let planningController: AbortController | null = null
  let activeStep: Promise<void> | null = null
  const cfgFor = (runId: string): Record<string, unknown> => {
    const row = repo.getRun(runId)
    if (!row) throw new Error('运行不存在')
    return JSON.parse(row.config_json) as Record<string, unknown>
  }
  const safeProviderError = (error: unknown): unknown => {
    if (error instanceof Error) {
      const message = redactCliSecrets(error.message, credentialSecrets)
      if (message !== error.message) error.message = message
      if (error.stack) {
        const stack = redactCliSecrets(error.stack, credentialSecrets)
        if (stack !== error.stack) error.stack = stack
      }
    }
    return error
  }
  const frozenSecret = (frozen: FrozenCliProvider): string => {
    const secret = resolveFrozenCliSecret(frozen, config, options, input.secret)
    credentialSecrets.add(secret)
    return secret
  }
  const trackAttempt: NonNullable<Parameters<typeof createModelCallAdapter>[0]['onProviderAttempt']> = (attempt) => {
    const id = `${attempt.logicalCallId}:${attempt.event.innerAttempt}`
    const ev = attempt.event
    if (ev.type === 'started') repo.startProviderAttempt({
      attempt_id: id, run_id: attempt.runId, logical_call_id: attempt.logicalCallId, attempt_no: ev.innerAttempt,
      stage_id: attempt.stageId, actor: attempt.actor, subtype: attempt.subtype, provider_id: attempt.providerId,
      provider_endpoint_origin: attempt.endpointOrigin, model_id: attempt.modelId, provider_request_id: null,
      outcome: 'in_flight', http_status: null, started_at: ev.startedAt, first_token_at: null, ended_at: null,
      input_tokens: null, output_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null, reasoning_tokens: null,
      cost_status: 'unknown', cost_amount: null, cost_currency: null, price_snapshot_id: null,
      adapter_id: attempt.adapterId, profile_id: attempt.profileId, credential_ref_id: null,
      applied_mappings_json: '[]', omitted_controls_json: '[]', context_manifest_id: attempt.contextManifestId, context_mode: attempt.contextMode
    })
    else if (ev.type === 'first_token') repo.markProviderAttemptFirstToken(id, ev.firstTokenAt)
    else repo.finishProviderAttempt(id, {
      outcome: ev.outcome, http_status: ev.httpStatus, provider_request_id: ev.providerRequestId, ended_at: ev.endedAt,
      input_tokens: ev.usage?.prompt_tokens ?? null, output_tokens: ev.usage?.completion_tokens ?? null,
      cache_hit_tokens: ev.usage?.prompt_cache_hit_tokens ?? null, cache_miss_tokens: ev.usage?.prompt_cache_miss_tokens ?? null,
      reasoning_tokens: ev.usage?.reasoning_tokens ?? null, cost_status: 'unknown', cost_amount: null, cost_currency: null, price_snapshot_id: null
    })
  }
  engine = createAgentRunEngine({
    store: createRunStorePort(repo, path.join(dataDir, 'artifacts')),
    artifactDir: path.join(dataDir, 'artifacts'), getConfig: cfgFor,
    publishLongwriteArtifact: publishCliManuscript,
    modelCall: async (call) => {
      const goalDraft = Boolean(cfgFor(call.runId).goalMode)
      const adapter = createModelCallAdapter({
        getApi: (runId) => {
          const frozen = cfgFor(runId).cliProvider as FrozenCliProvider | undefined
          if (!frozen?.fingerprint || frozen.config.schemaVersion !== 1) throw new CredentialMissingError(null, '缺少 CLI 冻结 Provider 配置')
          return kernelApi(frozen.config, frozenSecret(frozen), frozen.tools)
        },
        getConfig: cfgFor, getSignal: (runId) => engine.abortSignal(runId),
        getToolSpecs: async (runId) => {
          const cfg = cfgFor(runId)
          if (cfg.planMode === true) return []
          const frozen = cfg.extensionsFrozen as ExtensionSnapshot | undefined
          return frozen ? extensions.getToolSpecs(runId, frozen, [String(cfg.workDir), String(cfg.docDir)], engine.abortSignal(runId)) : []
        },
        buildPrefix: async (cfg) => cfg.frozenSystemMessages as DsMessage[],
        assembleContext: async (...args) => { const result = await context.assembleRunContext(...args); return { ...result, contextV2: result.contextV2 ?? null } },
        persistContext: (manifest, messages, live, projection) => context.persistContext(manifest, messages, live, projection),
        onProviderAttempt: trackAttempt
      })
      let iterable: Awaited<ReturnType<typeof adapter>>
      try { iterable = await adapter(call) } catch (error) { throw safeProviderError(error) }
      // Raw streaming is labelled provisional. Only engine accepted projection
      // and terminal/artifact events establish successful output.
      return (async function* () {
        try {
          for await (const event of iterable) {
            if (event.type === 'text' && event.delta) emit('delta', { runId: call.runId, actor: call.purpose ?? 'writer', provisional: true, ...(goalDraft && { goalCandidate: true }), text: event.delta })
            yield event
          }
        } catch (error) { throw safeProviderError(error) }
      })()
    },
    toolExecutor: async (name, argsJson, toolCallId, runId, hooks) => {
      const cfg = cfgFor(runId); const frozen = cfg.extensionsFrozen as ExtensionSnapshot | undefined
      const allowList = allowListFromConfig(cfg) ?? []
      if (!allowList.includes(name)) throw new Error('tool_not_allowed_by_mode：工具不在当前冻结白名单')
      await approveAgentMutation({ name, argsJson, config: cfg, ask: input.ask, managedByPermissionController: true, redact: text => redactCliSecrets(text, credentialSecrets), record: allowed => repo.saveRunEvidence(runId, `cli_tool_approval_${toolCallId}`, JSON.stringify({ toolCallId, name, allowed, at: Date.now() })) })
      if (frozen && extensions.has(frozen, name)) return extensions.execute(runId, frozen, name, argsJson, allowList, engine.abortSignal(runId))
      return createToolExecutor({
      searchConversation: (runId, args, budget) => searchRunConversation(contextV2, cfgFor(runId), args, budget),
      getSignal: (runId) => engine.abortSignal(runId),
      getAllowList: (runId) => allowListFromConfig(cfgFor(runId)),
      getProviderWeb: (runId, toolCallId, executionHooks) => createRunProviderWeb({ repository: repo, runId, toolCallId, config: cfgFor(runId), hooks: executionHooks,
        resolveCredential: reference => {
          const cfg = cfgFor(runId), access = frozenRunWebAccess(cfg)
          const frozen = cfg.cliProvider as FrozenCliProvider | undefined
          if (!access || !frozen || reference.credentialRefId !== access.profile.credential?.credentialRefId || reference.providerId !== access.profile.provider.id || reference.version !== 1) throw new CredentialMissingError(null, 'CLI 联网凭据不属于当前冻结模型')
          return frozenSecret(frozen)
        } }),
      getEnv: (runId) => {
        const cfg = cfgFor(runId)
        return { ...(cfg.goalMode === 'autonomous' ? { goalMode: 'autonomous' as const, webContentsId: 0 } : {}), pagedFileReads: cfg.pagedFileReads === true, workDir: String(cfg.workDir), docDir: String(cfg.docDir), permissionMode: (cfg.cliToolPolicy as { requireWriteApproval?: boolean } | undefined)?.requireWriteApproval === true && (name === 'write_file' || name === 'edit_file') ? 'safe' as const : cfg.permissionMode === 'auto' ? 'auto' as const : 'safe' as const, permissionWorkspaceRoot: typeof cfg.permissionWorkspaceRoot === 'string' ? cfg.permissionWorkspaceRoot : undefined, sessionId: String(cfg.sessionId), runId, signal: engine.abortSignal(runId) }
      }
      })(name, argsJson, toolCallId, runId, hooks)
    },
    onEvent: (runId, event: RunEngineEvent) => emit('event', { runId, ...event }),
    onRunUpdate: (run) => emit('run', { runId: run.runId, sessionId: run.sessionId, status: run.status, phase: run.phase, errorCode: run.errorCode, errorMessage: run.errorMessage })
  })
  const ensureProvider = async (): Promise<void> => {
    if (!config.loopback && !input.secret) throw new Error(config.keyEnvOrigin !== new URL(config.baseUrl).origin
      ? '此 origin 尚未授权环境密钥；请用 --key-env NAME 明确选择该服务的密钥变量，或使用该服务的显式 --config（不会自动转发官方 Key）'
      : `请通过 ${config.keyEnv} 或显式 --config 文件提供密钥；不会读取桌面加密配置`)
    await validateCliProvider(config)
  }
  const runText = (runId: string): string => {
    const cfg = cfgFor(runId)
    if (cfg.goalMode) {
      const goal = getRunGoal(repo, runId)
      if (goal?.status === 'completed' && repo.getRun(runId)?.status === 'completed') return goalCandidateTurns(repo.getTurnsByRun(runId), goal.candidateTurnId).map(t => t.content).join('')
      return goal?.blockedOn ? [goal.blockedOn.reason, goal.blockedOn.nextAction].filter(Boolean).join('\n') : ''
    }
    if (cfg.runMode === 'longwrite' && cfg.longMode === true) {
      if (!repo.getManuscriptSegmentsByRun(runId).some(segment => segment.status === 'accepted' && segment.kind === 'prose')) return ''
      return readRunManuscript(repo, runId, repo.getRun(runId)?.status === 'completed' ? 'manuscript' : 'draft', hash => {
        try { return readFileSync(path.join(dataDir, 'artifacts', hash + '.txt'), 'utf8') }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      }).content
    }
    const turns = repo.getTurnsByRun(runId).filter(turn => turn.role === 'assistant' && turn.content)
    return turns.map((turn,index) => (index && turns[index-1].plan_state !== AGENT_OUTPUT_PART ? '\n\n' : '') + turn.content).join('')
  }
  const runStep = async (runId: string): Promise<void> => {
    extensions.beginRun(runId)
    activeRun = runId
    const poll = setInterval(() => {
      const intent = repo.getRunEvidence(runId, 'cli_control')
      if (!intent) return
      const command = JSON.parse(intent.json) as { action: string }
      repo.saveRunEvidence(runId, 'cli_control', JSON.stringify({ action: 'handled' }))
      if (command.action === 'cancel') void engine.cancel(runId).catch(() => undefined)
      if (command.action === 'pause') void engine.pause(runId).catch(() => undefined)
    }, 150)
    let stepError: unknown = null
    try { await engine.step(runId) } catch (error) { stepError = error } finally { clearInterval(poll); activeRun = null; permissions.revokeLeasesByRunId(runId); await extensions.closeRun(runId) }
    const row = repo.getRun(runId)!
    const cfg = cfgFor(runId)
    const content = runText(runId)
    // Canonical session projection is a host concern, not another run state.
    if (content) {
      const old = repo.getSessionMessages(row.session_id)
      const existing = old.find((item) => item.msg_id === `m_${runId}_assistant`)
      repo.appendSessionMessage({ msg_id: `m_${runId}_assistant`, session_id: row.session_id, seq: existing?.seq ?? Math.max(0, ...old.map((item) => item.seq)) + 1, role: 'assistant', content, status: row.status === 'completed' ? 'done' : row.status, created_at: existing?.created_at ?? Date.now() })
    }
    if (cfg.goalMode && row.status === 'completed' && content) emit('goal_answer', { runId, content })
    const usage = repo.getUsageTotals(runId)
    const attempts = repo.getProviderAttempts(runId)
    emit('result', { runId, sessionId: row.session_id, status: row.status, model: (cfg.cliProvider as FrozenCliProvider).config.model,
      elapsedMs: Math.max(0, Date.now() - row.started_at), usage: { calls: attempts.length,
        input_tokens: attempts.every((attempt) => attempt.input_tokens !== null) ? usage.input_tokens : null,
        output_tokens: attempts.every((attempt) => attempt.output_tokens !== null) ? usage.output_tokens : null }, amountStatus: 'unknown', amount: null,
      ...(row.status === 'completed' && isReadOnlyAgentPlan(cfg) ? { plan: savedAgentPlan(repo, runId) } : {}),
      ...(cfg.goalMode ? { goal: getRunGoal(repo, runId) } : {}),
      errorCode: row.error_code, errorMessage: row.error_message, artifacts: repo.getArtifactsByRun(runId).filter((artifact) => artifact.artifact_type === 'manuscript') })
    if (stepError && !['waiting_user', 'recovery_required', 'failed', 'cancelled'].includes(row.status)) throw stepError
  }
  const start = async (payload: ChatStartPayload, agent = options['agent-session'] === true): Promise<void> => {
    await ensureProvider()
    if (config.contextSource === 'conservative_default') emit('notice', { message: `所选模型尚无可信窗口规格，当前使用 ${config.contextWindow} tokens 保守运行预算；这不是官方规格，可在该模型配置中补充真实窗口。` })
    const projectBrief = payload.grillMe && !payload.grillMe.quickBypass ? undefined : await readProjectBrief(config.workDir)
    const frozenExtensions = selectedSkills.length || selectedPlugins.length
      ? await freezeExtensions(new ExtensionRegistry(path.resolve(String(options['extensions-dir'] ?? process.env.DEEPWRITER_EXTENSIONS_DIR ?? path.join(dataDir, 'extensions')))), selectedSkills, selectedPlugins)
      : undefined
    const localTools = agent || options.tools === true
    const guardedAgent = agent && payload.mode === 'agent' && !payload.longMode
    const web = payload.mode === 'agent' && !payload.longMode && config.webAccessEnabled !== false && options['no-web'] !== true
    const requestedTools = [...(guardedAgent && payload.goalMode ? [GOAL_TOOL] : []), ...(guardedAgent ? [WORK_PLAN_TOOL, CONVERSATION_SEARCH_TOOL] : []), ...(localTools ? TOOL_ALLOW_LIST : []), ...(web ? WEB_TOOL_NAMES : []), ...(frozenExtensions?.toolSpecs.map(tool => tool.function.name) ?? [])]
    if (payload.goalMode && config.supportsTools === false) throw new Error('目标模式需要支持工具调用的模型。请切换模型后再开始。')
    const grantedTools = config.supportsTools === false ? [] : requestedTools
    const allowList = payload.phase === 'plan' ? planToolAllowList({ planMode: true, runMode: payload.mode, longMode: payload.longMode, agentPlan: payload.planAccess === 'read_only' ? { schemaVersion: 1, access: 'read_only' } : undefined, toolPolicy: { allowList: grantedTools } })! : grantedTools
    const hasTools = allowList.length > 0
    if (requestedTools.length && !hasTools) emit('notice', { message: '当前 Provider 声明不支持工具，本次仅文本回复；需要联网或文件操作请更换支持工具的模型，再用 --tool-support 明确启用。' })
    await startChatRun({
      repository: repo,
      runKernel: { start: async (args) => {
        const accepted = await engine.start(args)
        if (accepted.ok && args.newlyAccepted && args.config.goalMode === 'autonomous') {
          await permissions.issueAutonomousTaskGrant({ webContentsId: 0, runId: args.runId, sessionId: args.sessionId, workspaceRoot: String(args.config.permissionWorkspaceRoot ?? '') })
        }
        return accepted
      }, step: (runId) => { activeStep = runStep(runId); return activeStep } },
      loadSettings: async () => ({ model: config.model, historyBudgetTokens: 16000 }),
      buildConfig: (p, _settings, sessionId) => {
        const modelContext = cliModelContext(config)
        const snapshot = buildExecutionSnapshot({ payload: p, sessionId, modelContext, workBudget: cliAgentRunBudget(config),
          settings: { model: config.model, baseUrl: config.baseUrl, maxTokens: config.maxTokens, outputTokenLimit: config.outputTokenLimit, temperature: 0.7, topP: 0.9,
            thinkingEnabled: config.thinking !== false, reasoningEffort: config.effort as import('../shared/types').Settings['reasoningEffort'], workDir: config.workDir, docDir: config.docDir, permissionMode: permissions.getSettings().mode, permissionWorkspaceRoot: config.workDir,
            novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 16000,
            agentRunBudget: cliAgentRunBudget(config),
            completionTokenBudget: config.tokenBudget ?? 0, completionWallClockMs: config.timeBudgetMs ?? 0,
            strongConstraintEnabled: options['no-review'] !== true },
          memory: { projectPath: '', projectContent: '', userContent: '', projectBrief: projectBrief?.text }
        }) as unknown as Record<string, unknown>
        snapshot.toolPolicy = { allowList: planToolAllowList({ ...snapshot, toolPolicy: { allowList } }) ?? allowList }
        if (guardedAgent) snapshot.cliToolPolicy = { schemaVersion: 1, requireWriteApproval: p.goalMode !== 'autonomous' }
        if (frozenExtensions) {
          snapshot.extensionsFrozen = frozenExtensions
          snapshot.frozenSystemMessages = [...snapshot.frozenSystemMessages as DsMessage[], ...skillMessages(frozenExtensions)]
        }
        snapshot.cliProvider = { config: { ...config }, fingerprint: credentialFingerprint(input.secret, config.baseUrl, config.authHeaderName), tools: hasTools,
          unknownCostAccepted: true,
          ...(typeof options.config === 'string' ? { explicitConfigPath: path.resolve(options.config) } : {}) } satisfies FrozenCliProvider
        freezeRunWebAccess(snapshot, web)
        snapshot.frozenContext = contextV2.freezeForRun({ automatic: true, sessionId, draftText: p.text ?? '', attachments: p.attachments ?? [],
          outputReserveTokens: modelContext.outputReserveTokens, capabilityFingerprint: contextHash(JSON.stringify({ origin: config.baseUrl, model: config.model, ...modelContext })) })
        return snapshot
      }
    }, payload)
    if (activeStep) await activeStep
  }
  return {
    repo, engine, ensureProvider,
    undoEdit(runId: string, toolCallId: string) { return undoEdit(repo, checkpoints, config, runId, toolCallId) },
    completedText(runId: string): string {
      const row = repo.getRun(runId)
      if (!row) throw new Error('运行不存在')
      if (row.status !== 'completed') throw new Error('仅可导出 completed 运行；半成品请先查看 status / resume')
      return isReadOnlyAgentPlan(cfgFor(runId)) ? savedAgentPlan(repo, runId).text : runText(runId)
    },
    draftText(runId: string): string { return readRunManuscript(repo, runId, 'draft').content },
    setModel(model: string): string {
      const next = { ...config, model: model.trim() }
      validateCliModel(next)
      const modelContext = cliModelContext(next)
      Object.assign(next, { contextWindow: modelContext.maxContextTokens ?? 8192, maxTokens: modelContext.outputReserveTokens,
        contextSource: modelContext.contextSource, contextModel: next.model, contextOrigin: next.baseUrl })
      config = next
      return config.model
    },
    async chat(text: string, sessionId?: string) { await start({ id: `cli_${randomUUID()}`, sessionId, text, mode: 'agent', phase: 'execute' }) },
    savedPlan(runId: string) { return savedAgentPlan(repo, runId) },
    async plan(text: string, sessionId?: string) { await start({ id: `cli_${randomUUID()}`, sessionId, text, mode: 'agent', phase: 'plan', planAccess: 'read_only' }, true) },
    async approvePlan(runId: string, hash: string) {
      const plan = savedAgentPlan(repo, runId)
      await start({ id: `cli_${randomUUID()}`, sessionId: plan.sessionId, mode: 'agent', phase: 'execute', planApproval: { runId, hash } }, true)
    },
    rejectPlan(runId: string, hash: string) { rejectAgentPlan(repo, { runId, hash }); return savedAgentPlan(repo, runId) },
    async agent(text: string, sessionId?: string, goalMode?: 'guided' | 'autonomous') { await start({ id: `cli_${randomUUID()}`, sessionId, text, mode: 'agent', phase: 'execute', ...(goalMode && { goalMode }) }, true) },
    async write(state: GrillMeState) {
      const canonical = canonicalizeGrillMePayload({ ...state, approvedOutline: state.approvedOutline! } as never, state, state.sessionId)
      await start({ id: `cli_${randomUUID()}`, sessionId: state.sessionId, text: state.originalTask, mode: 'longwrite', longMode: true, targetChars: state.targetChars, phase: 'execute', grillMe: canonical })
    },
    async outline(state: GrillMeState) {
      if (!grillMeInterviewReadyForOutline(state)) throw new Error('采访尚未就绪，或大纲已经确认；拒绝跳过采访')
      if (grillMeHasBodyRun(state, repo.listRunsBySession(state.sessionId))) throw new Error('本次采访已启动正文；拒绝重规划')
      await ensureProvider()
      let running = markPlanningRunning(state, new URL(config.baseUrl).hostname, config.model)
      repo.saveGrillMeState(running)
      let prompt = buildGrillMePlanningPrompt(state)
      planningController = new AbortController()
      try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let text = ''
        try {
          const api = kernelApi(config, input.secret)
          const result = await streamChat({ apiKey: api.apiKey, baseUrl: api.baseUrl, model: api.model, maxTokens: api.maxTokens,
            thinking: api.thinking, temperature: api.temperature, topP: api.topP,
            provider: { adapterId: api.adapterId!, protocol: config.protocol, chatPath: config.chatPath,
              authStyle: api.authStyle!, transportPolicy: api.transportPolicy!, reasoning: { mode: api.reasoningMode!, effort: api.thinking.effort }, compatibilityMappingId: null,
              authHeaderName: api.authHeaderName, extraHeaders: api.extraHeaders },
            messages: [{ role: 'user', content: prompt }]
          }, (event) => { if (event.type === 'text') { text += event.delta ?? ''; emit('planning_delta', { sessionId: state.sessionId, provisional: true, text: event.delta }) } }, planningController.signal)
          running = applyPlanningModelResult(running, { text, providerId: api.providerId, modelId: api.model, usage: result.usage ? { inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens, reasoningTokens: result.usage.reasoning_tokens ?? null } : undefined })
        } catch { running = applyPlanningModelResult(running, { text: '' }) }
        repo.saveGrillMeState(running)
        if (running.planning.status === 'success' && running.status === 'awaiting_outline_confirmation' && running.outline && running.outlineHash) return running
        if (!running.planning.error?.includes('没有标注已确认信息来源') || attempt === 1) throw new Error(running.planning.error ?? '规划失败，未确认/启动正文')
        prompt = buildGrillMePlanningRepairPrompt(state, text, running.planning.error)
        running = markPlanningRunning(running, new URL(config.baseUrl).hostname, config.model)
        repo.saveGrillMeState(running)
      }
      throw new Error('规划失败')
      } finally { planningController = null }
    },
    async resume(runId: string, renewGoalGrant = options['no-questions'] === true) {
      const row = repo.getRun(runId)
      if (!row) throw new Error('运行不存在')
      if (['completed', 'failed', 'cancelled'].includes(row.status)) throw new Error(`运行已结束：${row.status}；拒绝重复调用`)
      const cfg = cfgFor(runId)
      if (renewGoalGrant && cfg.goalMode !== 'autonomous') throw new Error('只有原本自主执行的目标任务可以重新授权；其他运行不改变原权限')
      if (cfg.goalMode === 'autonomous' && !renewGoalGrant) throw new Error('恢复这个自主目标需要重新授权：resume RUN --no-questions')
      if (!applySnapshotGate(repo, runId, cfg).ok) throw new Error('冻结快照版本不兼容')
      const frozen = cfg.cliProvider as FrozenCliProvider
      if (!frozen?.config) throw new Error('不是 CLI 运行，拒绝借用桌面配置恢复')
      const originalHeader = (frozen.config.authHeaderName ?? (frozen.config.protocol === 'anthropic-messages' ? 'x-api-key' : 'Authorization')).toLowerCase()
      if (config.authHeaderName !== originalHeader) throw new Error('认证Header与原冻结配置不一致；拒绝悄然恢复或发送凭据')
      if (frozen.explicitConfigPath && path.resolve(String(options.config ?? '')) !== frozen.explicitConfigPath) throw new CredentialMissingError(null, '恢复需要原来的显式 --config 文件')
      if (frozen.explicitConfigPath && config.baseUrl !== frozen.config.baseUrl) throw new CredentialMissingError(null, '显式配置的 origin 与原运行不一致；请恢复原配置后继续，不跨服务借用密钥')
      frozenSecret(frozen)
      if (cfg.extensionsFrozen) await extensions.verify(cfg.extensionsFrozen as ExtensionSnapshot)
      await validateCliProvider(frozen.config)
      if (options['max-calls'] !== undefined) {
        if (options['max-calls'] !== 'unlimited') throw new Error('恢复不改写原有限调用次数；解除本任务限制请用 resume RUN --max-calls unlimited')
        const authorization = removeRunCallLimit(repo, runId)
        if (!authorization.resume) return
      } else if (['waiting_user', 'recoverable'].includes(row.status) && row.error_code === 'run_provider_call_cap') {
        throw new Error('原调用次数限制仍有效；明确解除并续跑：resume RUN --max-calls unlimited（其余预算与冻结凭据保持不变）')
      }
      await engine.restore(runId)
      const restored = repo.getRun(runId)!
      if (restored.status === 'recovery_required' || restored.error_code === 'scene_semantic_review_required') throw new Error('需要明确恢复/语义审查决策：先运行 recover-info / review，不自动重放')
      if (cfg.goalMode === 'autonomous') await permissions.issueAutonomousTaskGrant({ webContentsId: 0, runId, sessionId: row.session_id, workspaceRoot: String(cfg.permissionWorkspaceRoot ?? '') })
      await runStep(runId)
    },
    async interrupt(action: 'pause' | 'cancel') { planningController?.abort(); if (activeRun) await engine[action](activeRun) },
    async close() { try { await extensions.close() } finally { permissions.revokeLeasesByWebContentsId(0); setPermissionManager(null); setCheckpointStore(null); contextV2.close(); repo.close() } }
  }
}
