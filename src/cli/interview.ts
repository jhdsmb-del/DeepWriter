import { readProjectBrief } from '../main/projectBrief'
import { randomUUID } from 'node:crypto'
import { createGrillMeState, answerGrillMe, acceptAssumptions, confirmGrillMeOutline, type GrillMeState } from '../shared/grillMe'
import type { CliConfig } from './config'
import type { CliRuntime, Emit } from './runtime'
import { required } from './arguments'
import { questionAnswer, questionText } from './presentation'

export function createInterviewController(runtime: CliRuntime, config: CliConfig, emit: Emit, question: (message: string) => Promise<string>, beforeWrite: () => void) {
  const getState = (session: unknown): GrillMeState => {
    const state = runtime.repo.getGrillMeState(required(session, 'SESSION'))
    if (!state) throw new Error('采访不存在')
    return state
  }
  const newInterview = async (task: string, target: number): Promise<GrillMeState> => {
    const brief = await readProjectBrief(config.workDir)
    const sessionId = `s_cli_${randomUUID()}`
    const state = createGrillMeState({ projectBrief: brief.text, stateId: `grill_${randomUUID()}`, sessionId, originalTask: task, targetChars: target })
    runtime.repo.createSession(sessionId, state.originalTask.slice(0, 60), config.model)
    runtime.repo.saveGrillMeState(state)
    return state
  }
  const interactiveWrite = async (initial: GrillMeState): Promise<void> => {
    let state = initial
    process.stderr.write(`长文 ${state.sessionId} · ${config.model} · 目标 ${state.targetChars} 字\n`)
    while (['interviewing', 'manual_completion', 'assumption_review'].includes(state.status)) {
      if (state.status === 'assumption_review') {
        const decision = (await question(`待确认假设：\n${state.assumptions.map((item) => `- ${item}`).join('\n')}\n输入 accept 采用、reject 继续澄清、/back 保存返回`)).trim()
        if (decision === '/back') { process.exitCode = 2; return }
        if (!['accept', 'reject'].includes(decision)) { process.stderr.write('假设未确认。\n'); continue }
        state = acceptAssumptions(state, decision === 'accept')
      } else {
        if (!state.currentQuestion) throw new Error('当前采访缺少可回答问题')
        const answer = (await question(questionText(state.currentQuestion))).trim()
        if (answer === '/back') { process.exitCode = 2; return }
        try { state = answerGrillMe(state, state.currentQuestion.id, questionAnswer(state.currentQuestion, answer)) }
        catch (error) { process.stderr.write((error as Error).message + '\n'); continue }
      }
      runtime.repo.saveGrillMeState(state)
    }
    if (state.status === 'outline_ready') state = await runtime.outline(state)
    emit('state', state)
    if (state.status === 'awaiting_outline_confirmation') {
      if ((await question(`以上大纲尚未确认。输入 confirm ${state.outlineHash} 才会开始正文；其他输入保存返回`)).trim() !== `confirm ${state.outlineHash}`) { process.exitCode = 2; return }
      state = confirmGrillMeOutline(state, state.outlineHash); runtime.repo.saveGrillMeState(state)
    }
    if (state.status !== 'confirmed') throw new Error('采访状态尚未允许正文')
    beforeWrite()
    await runtime.write(state)
  }
  return { getState, newInterview, interactiveWrite }
}
