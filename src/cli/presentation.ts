import { sourcePageText } from './sourceText'
import type { SourceReceiptPage } from './sourceText'
import type { GrillMeQuestion, GrillMeState } from '../shared/grillMe'

const line = (value: unknown, limit = 240): string => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, limit)
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : []

export function questionText(question: GrillMeQuestion): string {
  return [question.text, ...(question.options ?? []).map((option, index) => `${index + 1}. ${option.label}`), '输入编号，可在编号后补充文字；也可直接输入完整答案。/back 保存并返回。'].join('\n')
}

export function questionAnswer(question: GrillMeQuestion, input: string): string {
  const text = input.trim()
  if (!text) throw new Error('答案不能为空')
  const selected = /^(\d+)(?:\s+([\s\S]+))?$/.exec(text)
  if (!selected) return text
  const option = question.options?.[Number(selected[1]) - 1]
  if (!option) throw new Error('选项编号无效；也可输入完整答案')
  // The shared interview reducer remains authoritative. No local readiness,
  // assumption acceptance or confirmation is inferred from an option.
  return option.value + (selected[2] ? `\n补充：${selected[2].trim()}` : '')
}

export function stateText(state: GrillMeState): string {
  const text = [`会话 ${state.sessionId} · ${state.status} · 目标 ${state.targetChars} 字`]
  if (state.status === 'assumption_review') text.push('待确认假设：', ...state.assumptions.map((item) => `- ${item}`))
  if (state.currentQuestion) text.push(`问题 ID：${state.currentQuestion.id}`, questionText(state.currentQuestion))
  if (state.outline) {
    text.push(`大纲：${state.outline.title}`, state.outline.premise)
    for (const section of state.outline.sections) text.push(`${section.title} · ${section.targetChars} 字：${section.purpose}`, `推进点：${section.beats.join('；')}`)
    text.push(`大纲 hash：${state.outlineHash}`, state.status === 'confirmed' ? '此版本已确认。' : '正文尚未启动；确认必须匹配此 hash。')
  } else if (state.status === 'outline_ready') text.push(`采访已就绪：outline ${state.sessionId}`)
  return text.join('\n')
}

export function humanText(type: string, value: unknown): string {
  const data = record(value)
  if (type === 'steering') return [`运行 ${line(data.runId)} · ${line(data.runStatus)}`, ...rows(data.messages).map(message =>
    `${message.sequence}. ${message.status === 'applied' ? '已加入运行上下文' : '已保存，待处理'} · ${line(message.requestId)}\n${line(message.text, 8000)}`),
    rows(data.messages).some(message => message.status === 'pending') ? '待处理补充不会越过暂停、批准或恢复决策；运行若已结束，补充仍保存在此列表，可复制到新任务。' : ''].filter(Boolean).join('\n')
  if (type === 'plan') return `${data.text}\n\n只读方案 ${line(data.runId)} · ${line(data.decision)}\n${data.decision === 'pending' ? `批准：approve ${line(data.runId)} --hash ${line(data.hash)}\n拒绝：reject-plan ${line(data.runId)} --hash ${line(data.hash)}` : data.executionRunId ? `执行 ${line(data.executionRunId)}` : '已拒绝；需重新审阅才能提出新方案。'}`
  if (type === 'state') return stateText(value as GrillMeState)
  if (type === 'config') return [`模型 ${line(data.model)} · ${line(data.protocol)} · 思考 ${data.thinking == null ? '按模型默认' : data.thinking ? '启用' : '关闭'} / ${line(data.effort)}`, `Provider ${line(data.baseUrl)}${line(data.chatPath)} · 认证头 ${line(data.authHeaderName)}`, `Provider 调用次数 ${data.maxCalls === null ? '不限' : data.maxCalls}（--max-calls 明确冻结覆盖） · token 上限 ${data.tokenBudget === null ? '不限' : data.tokenBudget} · 轮数 ${data.maxTurns == null ? '不限' : data.maxTurns} · 耗时ms ${data.timeBudgetMs == null ? '不限' : data.timeBudgetMs} · 金额 ${data.costBudget == null ? '未设置' : data.costBudget + ' ' + (data.costCurrency ?? '首次可信报价币种')}`, `上下文 ${data.contextWindow} tokens · ${data.contextSource === 'conservative_default' ? '保守运行预算，非官方规格' : data.contextSource === 'model_declaration' ? '用户模型规格' : '内置模型规格'}`, `工作目录 ${line(data.workDir)}`, `文档目录 ${line(data.docDir)}`, `工具能力 ${data.supportsTools === false ? '不支持（仅文本）' : '可用'} · 新对话联网 ${data.webAccessEnabled === false ? '关闭' : '开启'}；--web|--no-web 修改`, `密钥来源 ${line(data.keyEnv)}（环境源绑定 ${line(data.keyEnvOrigin)}）或显式 --config；不显示密钥`].join('\n')
  if (type === 'list') return rows(data.runs).map((run) => `${line(run.runId)} · ${line(run.status)} / ${line(run.phase)}${run.errorCode ? ` · ${line(run.errorCode)}` : ''}`).join('\n') || '暂无运行。'
  if (type === 'sessions') return rows(data.sessions).map((session) => `${session.session_id === data.currentSessionId ? '* ' : '  '}${line(session.session_id)} · ${line(session.title)} · ${line(session.model)}`).join('\n') || '暂无会话；输入任务或 /new 新建。'
  if (type === 'sources') return sourcePageText(value as SourceReceiptPage)
  if (type === 'changes') {
    const clean = (s: unknown, limit = 1000): string => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, c => c === '\n' ? ' ↵ ' : ' ').trim().slice(0, limit)
    return rows(data.changes).map(item => {
      const undo = record(item.undo)
      const ids = [String(item.runId ?? ''), String(item.toolCallId ?? '')]
      const args = Array.isArray(undo.command) ? undo.command.map(String) : ['undo-edit', ...ids]
      const quote = (word: string): string => /^[A-Za-z0-9_.:/\\-]+$/.test(word) ? word
        : "'" + word.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'"
      const command = data.interactive ? `/undo-edit ${ids.map(id => /^[A-Za-z0-9_.:-]+$/.test(id) ? id : JSON.stringify(id)).join(' ')}` : args.map(quote).join(' ')
      const actionable = args.every(word => !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(word))
      return [clean(item.summary), `  RUN ${clean(item.runId)} · TOOL ${clean(item.toolCallId)}`,
        ...(typeof item.before === 'string' ? ['  − ' + clean(item.before, 200), '  + ' + (clean(item.after, 200) || '（删除）')] : []),
        undo.status === 'available' && actionable ? `  撤销：${command}` : undo.status === 'undone' ? '  已撤销' : undo.status === 'blocked' ? '  撤销待核对；未自动覆盖' : '  此记录无法安全撤销'
      ].join('\n')
    }).join('\n\n') || '没有已完成的文件工具改动。'
  }
  if (type === 'undo_edit') return `${line(data.message, 600)}${data.code ? ` · ${line(data.code)}` : ''}${data.path ? '\n' + line(data.path, 1000) : ''}`
  if (type === 'usage') {
    const tokens = record(data.tokens)
    return `正文调用 ${tokens.calls ?? 0} · 输入 ${tokens.inputTokens ?? '?'} / 输出 ${tokens.outputTokens ?? '?'} tokens · 金额未知\n规划用量单列为最近一次结果，不计作完整费用总账。`
  }
  if (type === 'status' || type === 'result') {
    if (data.active) return rows(data.active).map((run) => `${line(run.runId)} · ${line(run.status)}${run.errorCode ? ` · ${line(run.errorCode)}` : ''}`).join('\n') || '暂无活动运行。'
    if (data.intent) return `${line(data.runId)} · 已记录 ${line(data.intent)} 意图；由执行进程在安全边界处理。`
    const usage = record(data.usage)
    const text = [`${line(data.runId)} · ${line(data.status)}${data.phase ? ` / ${line(data.phase)}` : ''}${data.model ? ` · ${line(data.model)}` : ''}`]
    if (data.elapsedMs !== undefined) text.push(`用时 ${(Number(data.elapsedMs) / 1000).toFixed(1)} s · 请求 ${usage.calls ?? '?'} · 输入 ${usage.input_tokens ?? '?'} / 输出 ${usage.output_tokens ?? '?'} tokens · 金额未知`)
    if (data.plan) { const plan = record(data.plan); text.push(`只读方案已保存；批准：approve ${line(plan.runId)} --hash ${line(plan.hash)}`) }
    const workSteps = rows(record(data.workPlan).steps)
    if (workSteps.length) text.push('任务清单', ...workSteps.map((step) => `${step.status === 'done' ? '✓' : step.status === 'in_progress' ? '●' : '○'} ${line(step.text, 1000)}`))
    if (workSteps.length && record(data.workPlan).blockedOn) text.push(`等待：${line(record(data.workPlan).blockedOn, 1000)}`)
    if (data.errorCode) text.push(`${line(data.errorCode)}：${line(data.errorMessage, 600)}`)
    text.push(...rows(data.artifacts).map((artifact) => `稿件 ${line(artifact.relative_path, 1000)} · SHA256 ${line(artifact.hash)}`))
    if (data.budget) text.push('冻结预算已持久化；--json 可查看结构化详情。')
    return text.join('\n')
  }
  // Review/recovery facts must remain visible, but are opt-in commands rather
  // than unsolicited per-token state dumps. Preserve their exact contract.
  return JSON.stringify(value, null, 2)
}

export function createHumanOutput(writeOut: (text: string) => void, writeError: (text: string) => void) {
  let lastPhase = ''; let bodyOpen = false; let planningShown = false
  return (type: string, value: unknown): void => {
    const data = record(value)
    if (type === 'delta' && data.actor === 'writer') { writeOut(String(data.text ?? '')); bodyOpen = true }
    else if (type === 'notice') writeError(line(data.message, 1000) + '\n')
    else if (type === 'extension') writeError(`插件 ${line(data.id)} · ${line(data.state)} · ${line(data.protocolVersion)}\n`)
    else if (type === 'planning_delta') { if (!planningShown) { writeError('正在生成候选大纲（尚未确认）…\n'); planningShown = true } }
    else if (type === 'event') {
      if (data.type === 'phase') {
        const phase = [line(data.title), line(data.detail)].filter(Boolean).join(' · ')
        if (phase && phase !== lastPhase) { writeError(phase + '\n'); lastPhase = phase }
      } else if (data.type === 'content_replace') writeError('候选正文已校正；最终内容以文件产物和结构化 content_replace 为准。\n')
      else if (data.type === 'tool') {
        const tool = record(data.tool)
        if (tool.status === 'failed' || tool.status === 'denied') writeError(`工具 ${line(tool.name)} · ${line(tool.status)}：${line(tool.resultJson, 500)}\n`)
      }
    } else if (type === 'run') {
      // Durable updates are frequent and duplicate phase/result events. Human
      // output shows those meaningful boundaries; JSON retains every update.
    } else if (['result', 'plan', 'state', 'status', 'usage', 'sources', 'changes', 'undo_edit', 'list', 'sessions', 'config', 'review', 'recovery'].includes(type)) {
      if (bodyOpen) { writeOut('\n'); bodyOpen = false }
      const text = humanText(type, value) + '\n'
      if (type === 'result') { writeError(text); lastPhase = ''; planningShown = false }
      else writeOut(text)
    }
  }
}
