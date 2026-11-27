import { randomUUID } from 'node:crypto'
import type { CliConfig, CliOptions } from './config'
import type { CliRuntime, Emit } from './runtime'
import type { createInterviewController } from './interview'
import { integer, required } from './arguments'
import { validatePrompt } from './input'
import { readRunSources } from './sources'
import { changesFor, undoEditArguments } from './changes'

declare const __DEEPWRITER_VERSION__: string

import { CliPromptInterrupted } from './terminal'
const INTERACTIVE_HELP = '/new [标题] · /sessions · /session [ID] · /model [名称] · /agent 任务 · /goal [--no-questions] 任务 · /plan 任务 · /approve RUN HASH · /reject-plan RUN HASH · /paste 多行输入 · /write 字数 任务 · /interview SESSION · /resume RUN [--no-questions] · /sources [RUN] [OFFSET] · /changes [RUN] · /undo-edit RUN TOOL · /usage · /list · /help · /exit'

export async function runInteractive(input: {
  runtime: CliRuntime; config: CliConfig; options: CliOptions; emit: Emit
  question: (message: string) => Promise<string>; redact: (text: string) => string
  interactiveWrite: ReturnType<typeof createInterviewController>['interactiveWrite']
  newInterview: ReturnType<typeof createInterviewController>['newInterview']
  getState: ReturnType<typeof createInterviewController>['getState']
  showUsage: (runId?: string) => void; interrupted: () => boolean; beforePrompt: () => void; busy: (value: boolean) => void
}) {
  const { runtime, config, options, emit, question, redact, interactiveWrite, newInterview, getState, showUsage, interrupted, beforePrompt, busy } = input
  let sessionId = typeof options.session === 'string' ? options.session : `s_cli_${randomUUID()}`
  if (options.session && !runtime.repo.listSessions().some((session) => session.session_id === sessionId)) throw new Error('会话不存在；使用 /new 新建会话')
  const showSession = (): void => {
    const session = runtime.repo.listSessions().find((item) => item.session_id === sessionId)
    process.stderr.write(`会话 ${sessionId}${session ? ` · ${session.title.replace(/[\r\n\t]/g, ' ')}` : ' · 新会话'} · ${config.model}\n`)
  }
  process.stderr.write(`DeepWriter CLI ${__DEEPWRITER_VERSION__} · ${config.model}\n输入任务持续聊天；Ctrl+C 暂停后可继续输入。\n${INTERACTIVE_HELP}\n`)
  showSession()
  while (true) {
    if (interrupted()) break
    let task: string
    beforePrompt()
    try { task = (await question('DeepWriter')).trim() } catch (error) { if (error instanceof CliPromptInterrupted) { if (interrupted()) break; continue }; throw error }
    if (task === '/exit') break
    if (!task) continue
    beforePrompt()
    busy(true)
    try {
      if (task === '/help') process.stderr.write(INTERACTIVE_HELP + '\n')
      else if (task === '/new' || task.startsWith('/new ')) {
        sessionId = `s_cli_${randomUUID()}`
        runtime.repo.createSession(sessionId, task.slice(4).trim().slice(0, 60) || '新会话', config.model)
        showSession()
      } else if (task === '/sessions') emit('sessions', { sessions: runtime.repo.listSessions(), currentSessionId: sessionId })
      else if (task === '/session') showSession()
      else if (task.startsWith('/session ')) {
        const id = required(task.slice(9), 'SESSION')
        if (!runtime.repo.listSessions().some((session) => session.session_id === id)) throw new Error('会话不存在；使用 /sessions 查看可用会话')
        sessionId = id; showSession()
      } else if (task === '/model') process.stderr.write(`当前模型 ${config.model}；/model 名称 切换后续新运行，不改变已冻结的恢复配置。\n`)
      else if (task.startsWith('/model ')) {
        const model = required(task.slice(7), '模型名称')
        if (model.length > 200 || /[\r\n\x00-\x1f]/.test(model)) throw new Error('模型名称无效')
        config.model = runtime.setModel(model)
        process.stderr.write(`后续新运行使用 ${model}；恢复运行仍使用原冻结模型。\n`)
      } else if (task.startsWith('/plan ')) await runtime.plan(validatePrompt(task.slice(6)), sessionId)
      else if (task.startsWith('/plan-info ')) emit('plan', runtime.savedPlan(required(task.slice(11), 'RUN')))
      else if (task.startsWith('/approve ') || task.startsWith('/reject-plan ')) {
        const match = /^\/(approve|reject-plan)\s+(\S+)\s+([a-f0-9]{64})$/.exec(task)
        if (!match) throw new Error('用法：/approve RUN HASH 或 /reject-plan RUN HASH')
        if (match[1] === 'approve') await runtime.approvePlan(match[2], match[3])
        else emit('plan', runtime.rejectPlan(match[2], match[3]))
      } else if (task === '/goal' || task.startsWith('/goal ')) {
        const args = task.slice(5).trim()
        const autonomous = /^--no-questions(?:\s|$)/u.test(args)
        const request = (autonomous ? args.slice('--no-questions'.length) : args).trim()
        if (!request) process.stderr.write('用法：/goal [--no-questions] 任务\n')
        else await runtime.agent(validatePrompt(request), sessionId, autonomous ? 'autonomous' : 'guided')
      } else if (task.startsWith('/agent ')) await runtime.agent(validatePrompt(task.slice(7)), sessionId)
      else if (task === '/agent') process.stderr.write('用法：/agent 任务；在当前工作目录启用本地文件/命令工具，写入与危险操作仍需授权。\n')
      else if (task === '/sources' || task.startsWith('/sources ')) {
        const parts = task.trim().split(/\s+/)
        if (parts.length > 3) throw new Error('用法：/sources [RUN] [OFFSET]')
        const last = parts[1] ?? runtime.repo.listRunsBySession(sessionId)[0]?.run_id
        if (last) emit('sources', { ...readRunSources(runtime.repo, last, parts[2]), interactive: true })
        else process.stdout.write('本会话还没有任务。\n')
      }
      else if (task === '/changes') emit('changes', { ...changesFor(runtime.repo, runtime.repo.listRunsBySession(sessionId).reverse().map(r => r.run_id)), interactive: true })
      else if (task.startsWith('/changes ')) {
        const id = required(task.slice(9), 'RUN')
        if (!runtime.repo.getRun(id)) throw new Error('运行不存在；用 /list 查看运行编号')
        emit('changes', { ...changesFor(runtime.repo, [id]), interactive: true })
      } else if (task === '/undo-edit' || task.startsWith('/undo-edit ')) {
        const [runId, toolCallId] = undoEditArguments(task.slice(10))
        const result = await runtime.undoEdit(runId, toolCallId)
        emit('undo_edit', { runId, toolCallId, ...result })
        process.exitCode = result.ok ? 0 : 2
      }
      else if (task === '/usage') showUsage()
      else if (task === '/list') emit('list', { runs: runtime.repo.listRecentRuns(20).map((row) => ({ runId: row.run_id, status: row.status, phase: row.phase, errorCode: row.error_code })) })
      else if (task.startsWith('/resume ')) {
        const match = /^\/resume\s+(\S+)(?:\s+(--no-questions))?$/.exec(task)
        if (!match) throw new Error('用法：/resume RUN [--no-questions]')
        await runtime.resume(match[1], Boolean(match[2]))
      }
      else if (task.startsWith('/interview ')) await interactiveWrite(getState(task.slice(11)))
      else if (task.startsWith('/write ')) {
        const match = /^\/write\s+(\d+)\s+([\s\S]+)$/.exec(task)
        if (!match) throw new Error('用法：/write 字数 任务')
        await interactiveWrite(await newInterview(required(match[2], '任务'), integer(match[1], 'target', 100)))
      } else if (task.startsWith('/') && task !== '/paste') process.stderr.write(`未知命令；${INTERACTIVE_HELP}\n`)
      else {
        if (task === '/paste') {
          process.stderr.write('多行输入：每行回车继续；独立一行 /send 发送，/back 丢弃本次输入。\n')
          const lines: string[] = []
          let length = 0
          while (true) {
            const line = await question('')
            if (line === '/back') { lines.length = 0; break }
            if (line === '/send') break
            length += line.length + 1
            if (length > 1_000_000) throw new Error('输入超过100万字符上限')
            lines.push(line)
          }
          if (!lines.length) continue
          task = lines.join('\n')
        }
        await runtime.chat(validatePrompt(task), sessionId)
      }
    } catch (error) { if (!(error instanceof CliPromptInterrupted)) { process.stderr.write(redact((error as Error).message) + '\n'); process.exitCode = 1 } }
    finally { busy(false) }
  }

}
