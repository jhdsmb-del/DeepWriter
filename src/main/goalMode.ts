import type { DsTool } from './deepseek'
import type { Repository } from './db/repository'
import type { ToolCallRecord, TurnRecord } from './jobs/types'
import { decodeToolResult, unwrapToolResult } from './toolResultView'
import { GOAL_EVIDENCE_KIND, GOAL_TOOL, readGoalSnapshot, type GoalSnapshot, type GoalEvidence, type GoalBlocker } from '../shared/goalMode'
import { WORK_PLAN_TOOL } from '../shared/workPlan'
import { goalCandidateTurns } from './jobs/goalAnswer'

export function getRunGoal(repo: Pick<Repository, 'getRunEvidence'>, runId: string): GoalSnapshot | null {
  const row = repo.getRunEvidence(runId, GOAL_EVIDENCE_KIND)
  const goal = row && readGoalSnapshot(row.json)
  return goal && goal.runId === runId ? goal : null
}

const short = (x: unknown, max = 2000): x is string => typeof x === 'string' && !!x.trim() && x.length <= max && !x.includes('\0')
const bare = (text: string): boolean => /^(?:done|completed|finished|ok(?:ay)?|完成(?:了)?|已完成|好的|已做好|任务完成)[.!。！\s]*$/iu.test(text.trim()) || !text.trim()
export const goalToolSpec: DsTool = { type: 'function', function: {
  name: GOAL_TOOL,
  description: '目标模式的持久化目标与验收。先 define 把原始目标转为具体可核对的成果，不能只列活动。progress 记录实际进展；blocked 只用于真实依赖。交付实际答案后，程序要求 review 原始目标和每项成果；通过时必须引用真实工具回执或候选答案中的原句。清单完成或口头 done 都不是证据。',
  parameters: { type: 'object', additionalProperties: false, required: ['action','progress'], properties: {
    action: { type: 'string', enum: ['define','progress','review','blocked'] },
    progress: { type: 'string', maxLength: 2000 },
    outcomes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['id','description','check','verification'], properties: {
      id: { type: 'string', maxLength: 64 }, description: { type: 'string', maxLength: 600 }, check: { type: 'string', maxLength: 600 }, verification: { type: 'string', enum: ['answer','tool'] }
    } } },
    originalObjectiveReview: { type: 'string', maxLength: 4000, description: '对照用户原始目标，核对遗漏、负面约束、范围和实际结果，而不是复述清单。发现遗漏必须返回修复。' },
    checks: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['id','satisfied','reason','evidence'], properties: {
      id: { type: 'string' }, satisfied: { type: 'boolean' }, reason: { type: 'string', maxLength: 2000 },
      evidence: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['kind','reference','quote','reason'], properties: {
        kind: { type: 'string', enum: ['tool','answer'] }, reference: { type: 'string', description: '真实 toolCallId 或程序给出的 candidateTurnId；不是路径和臆造 ID' },
        quote: { type: 'string', maxLength: 2000, description: '该回执或答案中确实存在的原句' }, reason: { type: 'string', maxLength: 2000, description: '原句如何验证此项检查；任意成功回执不能证明无关目标' }
      } } }
    } } },
    originalSatisfied: { type: 'boolean', description: '即使原清单有遗漏，仍须依据原目标判断；false 必须继续纠正。' },
    blockedOn: { type: 'object', additionalProperties: false, required: ['kind','reason','nextAction'], properties: {
      kind: { type: 'string', enum: ['clarification','missing_input','permission','external'] }, reason: { type: 'string', maxLength: 2000 }, nextAction: { type: 'string', maxLength: 2000 }, recommendation: { type: 'string', maxLength: 2000 }
    } }
  } }
} }

/** Stage-specific bookkeeping keeps a small-context Agent able to read the
 * actual work. This changes neither the frozen external tool permissions nor
 * the host validator, which remains authoritative for forged calls. */
export function goalToolSpecForStage(stage: GoalSnapshot['status'] = 'planning'): DsTool {
  const source = goalToolSpec.function.parameters as { properties:Record<string,unknown> }
  const fields = stage === 'planning' ? ['action','progress','outcomes','blockedOn']
    : stage === 'reviewing' ? ['action','progress','originalObjectiveReview','originalSatisfied','checks','blockedOn']
      : ['action','progress','outcomes','blockedOn']
  const properties = Object.fromEntries(fields.map(k=>[k,source.properties[k]]))
  properties.action = { type:'string', enum:stage === 'planning' ? ['define','blocked'] : stage === 'reviewing' ? ['review','blocked'] : ['progress','define','blocked'] }
  return { type:'function', function:{ name:GOAL_TOOL, description:stage === 'reviewing' ? '对照原目标验收：每项通过须引用真实候选答案或成功工具回执原句，并解释相关性；缺口返回失败继续修复。' : '记录具体成果与验收条件，实际进展或真实阻塞；清单不代替执行。',
    parameters:{type:'object',additionalProperties:false,required:['action','progress'],properties} } }
}

export function compactGoalHistory(messages: import('../shared/types').DsMessage[]): import('../shared/types').DsMessage[] {
  const remove = new Set<number>()
  const lastAccepted = messages.findLastIndex(m=>m.role === 'tool' && (()=>{try{return JSON.parse(m.content).ok === true}catch{return false}})())
  for (let i=0;i<messages.length;i++) {
    const m = messages[i]
    if (m.role === 'system' && m.content.startsWith('[目标监护]')) { remove.add(i); continue }
    const result = messages[i+1]
    if (m.role !== 'assistant' || m.content.trim() || m.tool_calls?.length !== 1 || m.tool_calls[0].name !== GOAL_TOOL ||
      result?.role !== 'tool' || result.tool_call_id !== m.tool_calls[0].id) continue
    if (i < lastAccepted) { remove.add(i); remove.add(i+1); continue }
    try { if (JSON.parse(result.content).ok === true) { remove.add(i); remove.add(i+1) } } catch { /* Keep invalid receipts visible for repair. */ }
  }
  return messages.filter((_,i)=>!remove.has(i))
}

/** Preserve names, types, required fields, enums and exact behavior flags while
 * shortening repeated prose on small-context Goal runs. Runtime authorization
 * still uses the full native definitions. */
export function compactGoalToolSpecs(tools: DsTool[]): DsTool[] {
  const trim = (value:unknown):unknown => Array.isArray(value) ? value.map(trim) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key])=>key !== 'description').map(([key,v])=>[key,trim(v)])) : value
  return tools.filter(t=>t.function.name !== WORK_PLAN_TOOL).map(t=>t.function.name === GOAL_TOOL ? t : {
    ...t,function:{...t.function,description:Array.from(t.function.description ?? '').slice(0,32).join(''),parameters:trim(t.function.parameters) as Record<string,unknown>}
  })
}

export function goalModePrompt(goal: GoalSnapshot): string {
  const state = { status:goal.status, outcomes:goal.outcomes.map(({id,description,check,verification,status})=>({id,description,check,verification,status})),
    ...(goal.candidateTurnId ? { candidateTurnId:goal.candidateTurnId } : {}), ...(goal.originalObjectiveReview && goal.status === 'active' ? { repair:goal.originalObjectiveReview } : {}),
    ...(goal.blockedOn ? { blockedOn:goal.blockedOn } : {}) }
  return `[目标模式：${goal.mode === 'autonomous' ? '自主' : '协作'}]\n` +
    (goal.mode === 'autonomous' ? '在现有授权内自行作任务决定、选可逆默认并告知；不问偏好，不伪造用户授权。' : '先查项目已有事实；只有答案实质影响交付才澄清，一次给问题与推荐答案。') +
    '保留原目标范围与负面约束；真实缺输入/权限/外部依赖用 blocked 停下。遵守停止、恢复和显式预算，不重放副作用。\n' +
    (goal.status === 'planning' ? '先 define 具体成果和可核对条件，再实际执行；纯文字用 answer 证据，无需制造文件。'
      : goal.status === 'reviewing' ? `回到原始目标逐项验收：${goal.objective}\n调用 review；引用真实答案/成功工具回执原句并解释相关性，清单勾选不是证据。发现缺口 satisfied:false 后继续修复，不缩小目标。`
        : '继续实际工作并给完整可用答案；stop 仅提交候选，不是成功。缺口须修复，不能仅复述进度或说 done。') +
    `\n当前目标：${JSON.stringify(state)}`
}

function validEvidence(value: unknown, goal: GoalSnapshot, outcome: GoalSnapshot['outcomes'][number], turns: TurnRecord[], tools: ToolCallRecord[]): value is GoalEvidence {
  const e = value as GoalEvidence
  if (!e || !short(e.reference, 256) || !short(e.quote) || !short(e.reason)) return false
  if (e.kind === 'answer') {
    const answer = e.reference === goal.candidateTurnId ? goalCandidateTurns(turns,e.reference).map(t=>t.content).join('') : ''
    return outcome.verification === 'answer' && !!answer && !bare(answer) && answer.includes(e.quote)
  }
  if (e.kind !== 'tool') return false
  const tool = tools.find(t => t.toolCallId === e.reference && t.name !== GOAL_TOOL && t.name !== WORK_PLAN_TOOL)
  if (!tool || !decodeToolResult(tool).ok || decodeToolResult(tool).exitCode && decodeToolResult(tool).exitCode !== 0) return false
  // Receipts may also come from the supervisor's read-back after delivery.
  const source = turns.find(t => t.turnId === tool.turnId)
  const candidate = turns.find(t => t.turnId === goal.candidateTurnId)
  if (!source || !candidate || source.turnSeq >= Math.max(0,...turns.map(t=>t.turnSeq)) || source.turnSeq <= (goal.definedAtTurnSeq ?? 0) ||
    outcome.status === 'pending' && source.turnSeq <= (goal.reviewAfterTurnSeq ?? 0)) return false
  if (e.quote.trim().length < 4 || /^(?:ok|success|成功|已完成|执行成功|操作成功|文件已写入)[.!。！\s]*$/iu.test(e.quote.trim())) return false
  return unwrapToolResult(tool.resultJson).text.includes(e.quote)
}

/** The engine owns identity, source evidence and state transitions. Tool JSON
 * cannot assert a terminal status, rewrite the raw objective or forge receipts. */
export function applyGoalUpdate(goal: GoalSnapshot, args: Record<string, unknown>, turns: TurnRecord[], tools: ToolCallRecord[]): GoalSnapshot {
  if (!short(args.progress)) throw new Error('goal_invalid_progress：请记录具体实际进展')
  const next: GoalSnapshot = { ...goal, progress: args.progress.trim(), revision: goal.revision + 1, blockedOn: undefined }
  if (args.action === 'blocked') {
    const b = args.blockedOn as GoalBlocker
    if (!b || !['clarification','missing_input','permission','external'].includes(b.kind) || !short(b.reason) || !short(b.nextAction)) throw new Error('goal_invalid_blocker：需说明真实阻塞及解除行动')
    if (b.kind === 'clarification' && (goal.mode === 'autonomous' || !short(b.recommendation))) throw new Error('goal_preference_question：自主模式自行选择可逆默认；协作澄清必须附推荐答案。真实缺失输入请明确记为 missing_input')
    return { ...next, status: 'blocked', blockedOn: { kind: b.kind, reason: b.reason, nextAction: b.nextAction, ...(short(b.recommendation) ? { recommendation: b.recommendation } : {}) } }
  }
  if (args.action === 'define') {
    if (!Array.isArray(args.outcomes) || !args.outcomes.length || args.outcomes.length > 20) throw new Error('goal_invalid_outcomes：先明确具体成果和可核对的验收条件')
    const outcomes = args.outcomes as GoalSnapshot['outcomes']
    if (outcomes.some(o => !o || !short(o.id,64) || !/^[a-zA-Z0-9_-]+$/u.test(o.id) || !short(o.description,600) || !short(o.check,600) || !['answer','tool'].includes(o.verification)) || new Set(outcomes.map(o => o.id)).size !== outcomes.length) throw new Error('goal_invalid_outcomes：成果需唯一 ID、具体描述、检查条件及 answer/tool 证据类型')
    if (goal.outcomes.length && goal.status !== 'active') throw new Error('goal_review_first：先完成当前成果的原目标验收，再依据缺口更新成果')
    if (goal.outcomes.some(old => !outcomes.some(o => o.id === old.id && o.description === old.description && o.check === old.check && o.verification === old.verification))) throw new Error('goal_requirements_immutable：已定义成果不可删除、弱化或改写；保留原条件，仅可增补原目标遗漏的成果')
    return { ...next, status: 'active', candidateTurnId: undefined, stalledRounds:goal.outcomes.length === outcomes.length ? goal.stalledRounds+1 : 0,
      definedAtTurnSeq: goal.definedAtTurnSeq ?? Math.max(0,...turns.map(t=>t.turnSeq)), outcomes: outcomes.map(o => goal.outcomes.find(old=>old.id === o.id) ?? ({ id:o.id, description:o.description, check:o.check, verification:o.verification, status:'pending', evidence:[] })) }
  }
  if (!goal.outcomes.length) throw new Error('goal_define_first：先把原始目标转成具体成果，不能以进展说明代替')
  if (args.action === 'progress') return { ...next, status: goal.status === 'blocked' ? 'active' : goal.status, stalledRounds:goal.stalledRounds+1 }
  if (args.action !== 'review' || goal.status !== 'reviewing' || !goal.candidateTurnId) throw new Error('goal_candidate_required：先实际执行并交付候选答案，再由程序进入验收')
  if (!short(args.originalObjectiveReview,4000) || typeof args.originalSatisfied !== 'boolean' || !Array.isArray(args.checks) || args.checks.length !== goal.outcomes.length) throw new Error('goal_review_incomplete：需回到原始目标判断遗漏，并逐项提交验收理由及真实证据')
  const checks = args.checks as Array<{ id:string; satisfied:boolean; reason:string; evidence:GoalEvidence[] }>
  if (new Set(checks.map(c=>c.id)).size !== checks.length) throw new Error('goal_duplicate_check：不能重复验收同一项来遗漏其他成果')
  const outcomes = goal.outcomes.map(outcome => {
    const c = checks.find(item => item.id === outcome.id)
    if (!c || typeof c.satisfied !== 'boolean' || !short(c.reason) || !Array.isArray(c.evidence) || c.evidence.length > 8 || c.satisfied && (!c.evidence.length || !c.evidence.every(e => validEvidence(e,goal,outcome,turns,tools)))) throw new Error('goal_evidence_invalid：每项通过需绑定本任务真实候选答案或成功工具回执原句，并解释它如何验证该成果；不能用计划或失败回执')
    return { ...outcome, status: c.satisfied ? 'done' as const : 'pending' as const, evidence: c.satisfied ? c.evidence : [] }
  })
  const complete = args.originalSatisfied && outcomes.every(o=>o.status === 'done')
  return { ...next, outcomes, status: complete ? 'completed' : 'active', originalObjectiveReview: args.originalObjectiveReview,
    reviewAfterTurnSeq: Math.max(0,...turns.map(t=>t.turnSeq)), lastCandidateTurnId:goal.candidateTurnId, candidateTurnId: complete ? goal.candidateTurnId : undefined }
}

export function candidateIsBare(content: string): boolean { return bare(content) }
