import {
  acceptAssumptions,
  answerGrillMe,
  applyPlanningModelResult,
  applyQuestionModelResult,
  advanceInterview,
  buildGrillMePlanningPrompt,
  buildGrillMePlanningRepairPrompt,
  buildGrillMeQuestionPrompt,
  canonicalizeGrillMePayload,
  createGrillMeState,
  hydrateGrillMeState,
  grillMeGateRequired,
  grillMeInterviewReadyForOutline,
  grillMeOutlineHash,
  grillMePlanningRetryableError,
  grillMeRequiredPrefix,
  requiredSlotIds,
  updateGrillMeOutline,
  confirmGrillMeOutline
} from '../src/shared/grillMe'
import { deriveWritingRunMode } from '../src/renderer/src/writingMode'
import { createRepository } from '../src/main/db/repository'
import { streamChat } from '../src/main/deepseek'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
function ok(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL ${message}`)
  passed++
  console.log(`PASS ${message}`)
}

ok(requiredSlotIds(1200).length === 6, '短文基础六维')
ok(requiredSlotIds(3000).length === 9, '中长文增加冲突结构结尾')
ok(requiredSlotIds(8000).length === 13, '长文增加人物背景参考与保留项')
const fiction = createGrillMeState({ stateId: 'fiction', sessionId: 'fiction', originalTask: '写一部悬疑小说', targetChars: 8000, genre: '悬疑小说' })
const nonfiction = createGrillMeState({ stateId: 'nonfiction', sessionId: 'nonfiction', originalTask: '分析行业趋势', targetChars: 8000, genre: '行业分析' })
ok(['characters', 'setting', 'conflict', 'ending'].includes(fiction.currentQuestion?.slotIds[0] ?? ''), '小说题材优先追问人物背景冲突或结尾')
ok(['goal', 'audience', 'evidence', 'structure'].includes(nonfiction.currentQuestion?.slotIds[0] ?? ''), '非虚构优先追问目标受众证据或结构')

const plain = createGrillMeState({ stateId: 'plain', sessionId: 'plain', originalTask: '写一篇文章', targetChars: 1200 })
ok(plain.currentQuestion?.slotIds[0] === 'goal', '写一篇文章不再臆测目标，仍然追问 goal')
const beforeMissing = plain.slots.filter((slot) => !slot.answer.trim()).length
const firstQuestion = plain.currentQuestion!
const oneAnswer = answerGrillMe(plain, firstQuestion.id, '给刚入行的读者一个可执行判断')
ok(beforeMissing - oneAnswer.slots.filter((slot) => !slot.answer.trim()).length === 1, '回答一个问题只减少一个 slot')
ok(oneAnswer.currentQuestion?.slotIds.length === 1 && oneAnswer.currentQuestion?.id !== firstQuestion.id, '每次只追问一个最高价值 slot 且不重复')
const selectedOption = firstQuestion.options?.[0]
const selectedState = answerGrillMe(plain, firstQuestion.id, selectedOption?.value ?? '')
ok(Boolean(selectedOption) && selectedState.slots.find((slot) => slot.id === firstQuestion.slotIds[0])?.answer === selectedOption?.label && selectedState.answers.at(-1)?.value === selectedOption?.label, '选择题持久化人类可读标签而不是 opaque option value')
const legacyOptionState = structuredClone(selectedState)
legacyOptionState.slots.find((slot) => slot.id === firstQuestion.slotIds[0])!.answer = selectedOption?.value ?? ''
legacyOptionState.answers[legacyOptionState.answers.length - 1].value = selectedOption?.value ?? ''
const hydratedOptionState = hydrateGrillMeState(legacyOptionState, 99)
ok(hydratedOptionState?.slots.find((slot) => slot.id === firstQuestion.slotIds[0])?.answer === selectedOption?.label && hydratedOptionState.answers.at(-1)?.value === selectedOption?.label, '旧 state 的 option value 在 hydrate 时恢复为人类可读标签')

let capped = createGrillMeState({ stateId: 'cap', sessionId: 'cap', originalTask: '写一部复杂长篇小说', targetChars: 8000, genre: '小说' })
while (capped.status === 'interviewing' && capped.currentQuestion && capped.questions.length < 30) {
  const question = capped.currentQuestion
  capped = answerGrillMe(capped, question.id, question.kind === 'final_check' ? '没有了' : `第 ${capped.questions.length + 1} 个明确回答`)
}
ok(capped.status === 'outline_ready' && capped.questions.some((question) => question.kind === 'final_check') && capped.questions.length <= 16, '长文按信息充分度提前进入 final_check，不机械问完十三项且仍有安全上限')

let manualProbe = createGrillMeState({ stateId: 'manual-probe', sessionId: 'manual-probe', originalTask: '写一篇文章', targetChars: 1200 })
while (manualProbe.status === 'interviewing' && manualProbe.currentQuestion && manualProbe.questions.length < 17) {
  const question = manualProbe.currentQuestion
  manualProbe = answerGrillMe(manualProbe, question.id, question.kind === 'final_check' ? '还有补充：再确认一条边界' : `细化第 ${manualProbe.questions.length + 1} 轮`)
}
ok(manualProbe.status === 'manual_completion' && manualProbe.currentQuestion?.kind === 'final_check', '重复补充达到安全上限后转手工 final_check，不无限循环')
const manualQuestionCount = manualProbe.questions.length
const manualAtCap = JSON.parse(JSON.stringify(manualProbe)) as typeof manualProbe
manualProbe = answerGrillMe(manualProbe, manualProbe.currentQuestion!.id, '还有补充：达到上限后仍需确认')
ok(manualProbe.status === 'manual_completion' && manualProbe.questions.length === manualQuestionCount && manualProbe.currentQuestion?.kind === 'followup', '达到 cap 后补充 followup 不再新增问题计数')
manualProbe = answerGrillMe(manualProbe, manualProbe.currentQuestion!.id, '补充 followup 的具体内容')
ok(manualProbe.status === 'manual_completion' && manualProbe.questions.length === manualQuestionCount && manualProbe.currentQuestion?.kind === 'final_check', '达到 cap 后 followup 回答仍回到手工 final_check 且不突破上限')
manualProbe = answerGrillMe(manualProbe, manualProbe.currentQuestion!.id, '没有了')
ok(manualProbe.status === 'outline_ready' && manualProbe.questions.length === manualQuestionCount && grillMeInterviewReadyForOutline(manualProbe), '手工 final_check 仍需明确没有补充才进入大纲阶段且 validator 可恢复 cap 后 final')
let earlyReview = createGrillMeState({ stateId: 'review', sessionId: 'review', originalTask: '写一篇文章', targetChars: 1200 })
earlyReview = answerGrillMe(earlyReview, earlyReview.currentQuestion!.id, '')
earlyReview = answerGrillMe(earlyReview, earlyReview.currentQuestion!.id, '')
ok(earlyReview.status === 'assumption_review', '连续两轮没有新信息进入假设审阅')
const resumed = acceptAssumptions(earlyReview, false)
ok(resumed.status === 'interviewing' && resumed.currentQuestion !== null, '拒绝默认值会真正推进到下一条问题')

const ready = (() => {
  let value = createGrillMeState({ stateId: 'ready', sessionId: 'ready', originalTask: '写一篇关于锚点事实的科幻小说', targetChars: 1200, genre: '科幻小说' })
  while (value.status === 'interviewing' && value.currentQuestion) value = answerGrillMe(value, value.currentQuestion.id, value.currentQuestion.kind === 'final_check' ? '没有了' : `确认 ${value.currentQuestion.slotIds[0]} 的具体要求`)
  return value.status === 'assumption_review' ? acceptAssumptions(value, true) : value
})()
ok(ready.status === 'outline_ready', '采访完成后进入大纲规划阶段')

const interviewJson = applyQuestionModelResult(plain, { text: JSON.stringify({ question: '读者读完后，最希望带走哪一个明确结论？' }), providerId: 'mock.provider', modelId: 'mock-model', durationMs: 37, usage: { inputTokens: 19, outputTokens: 11, reasoningTokens: null }, called: true })
ok(interviewJson.interview.status === 'success' && interviewJson.interview.callCount === 1 && interviewJson.currentQuestion?.text.includes('读者'), '采访模型只自然化当前单槽问题并记录调用事实')
ok(interviewJson.currentQuestion?.kind === 'slot' && (interviewJson.currentQuestion.options?.length ?? 0) >= 2 && (interviewJson.currentQuestion.options?.length ?? 0) <= 4, '旧 question-only 模型结果也迁移到带 2-4 个选项的 slot 契约')
ok(interviewJson.interview.durationMs === 37 && interviewJson.interview.usage.inputTokens === 19, '采访累计耗时与 token 用量单独持久化')
const interviewBad = applyQuestionModelResult(plain, { text: JSON.stringify({ question: 'system prompt sourceSlotIds targetChars' }), providerId: 'mock.provider', modelId: 'mock-model', called: true })
ok(interviewBad.interview.status === 'failed' && interviewBad.currentQuestion?.text.includes('还需要确认') && (interviewBad.currentQuestion.options?.length ?? 0) >= 2, '采访坏 JSON/泄漏失败时使用单槽中文 fallback')
ok(buildGrillMeQuestionPrompt(plain).includes('目标维度') && buildGrillMeQuestionPrompt(plain).includes('原始任务'), '采访 prompt 只绑定当前目标 slot')

let dynamic = createGrillMeState({ stateId: 'dynamic', sessionId: 'dynamic', originalTask: '写一篇面向新手的文章', targetChars: 1200 })
dynamic = answerGrillMe(dynamic, dynamic.currentQuestion!.id, '让读者学会做出第一步判断')
dynamic = answerGrillMe(dynamic, dynamic.currentQuestion!.id, '刚入行、缺少经验的读者')
dynamic = applyQuestionModelResult(dynamic, { text: JSON.stringify({ question: '如果只保留一个核心结论，你希望读者记住什么？', options: [{ id: 'action', label: '一个可执行动作', value: '记住一个可执行动作' }, { id: 'principle', label: '一条判断原则', value: '记住一条判断原则' }], readiness: 'insufficient', nextSlot: 'scope' }), called: true })
dynamic = answerGrillMe(dynamic, dynamic.currentQuestion!.id, '记住一个可执行动作')
ok(dynamic.currentQuestion?.kind === 'slot' && dynamic.currentQuestion?.slotIds[0] === 'scope' && dynamic.questions.filter((question) => question.kind === 'final_check').length === 0, '模型可基于已答内容动态选择下一个 required slot，但 readiness 不能跳过缺失项')
while (dynamic.currentQuestion?.kind !== 'final_check' && dynamic.status === 'interviewing') dynamic = answerGrillMe(dynamic, dynamic.currentQuestion!.id, `继续确认 ${dynamic.questions.length}`)
const dynamicFinal = answerGrillMe(dynamic, dynamic.currentQuestion!.id, '没有了')
ok(dynamicFinal.status === 'outline_ready', 'final_check 选择没有了才进入 outline_ready')

let readinessMissing = createGrillMeState({ stateId: 'readiness-missing', sessionId: 'readiness-missing', originalTask: '写一篇文章', targetChars: 1200 })
readinessMissing = answerGrillMe(readinessMissing, readinessMissing.currentQuestion!.id, '明确目标')
readinessMissing = answerGrillMe(readinessMissing, readinessMissing.currentQuestion!.id, '明确读者')
readinessMissing = answerGrillMe(readinessMissing, readinessMissing.currentQuestion!.id, '明确语气')
readinessMissing = applyQuestionModelResult(readinessMissing, { text: JSON.stringify({ question: '现在是否还需要确认一项核心限制？', options: [{ id: 'specific', label: '明确限制', value: '明确这项限制' }, { id: 'default', label: '按常见处理', value: '按常见方式处理这项限制' }], readiness: 'ready', nextSlot: 'final_check' }), called: true })
const readinessMissingSlots = readinessMissing.slots.filter((slot) => slot.required && !slot.answer.trim())
ok(readinessMissing.status === 'assumption_review' && readinessMissing.currentQuestion === null && readinessMissingSlots.length > 0 && readinessMissing.assumptions.length === readinessMissingSlots.length && readinessMissing.assumptions.every((item) => /保守默认值|默认/u.test(item)), '至少三轮后 readiness=ready 但仍有 required missing 时进入逐项假设审阅，不进入 final/outline')
ok(readinessMissing.questions.every((question) => question.answeredAt !== null), 'readiness 假设审阅不会把尚未回答的候选问题计入自动采访历史')
const rejectedReadiness = acceptAssumptions(readinessMissing, false)
ok(rejectedReadiness.status === 'interviewing' && rejectedReadiness.currentQuestion?.kind === 'slot' && rejectedReadiness.assumptions.length === 0 && rejectedReadiness.currentQuestion?.readiness === 'insufficient', '拒绝 readiness 假设会清掉 readiness 并继续逐题')
const rejectedReadyAgain = applyQuestionModelResult(rejectedReadiness, { text: JSON.stringify({ question: '继续确认这一项的具体边界。', options: [{ id: 'focused', label: '明确边界', value: '明确这项边界' }, { id: 'minimal', label: '保持最小', value: '只保留完成任务所需的最小边界' }], readiness: 'ready', nextSlot: 'final_check' }), called: true })
ok(rejectedReadyAgain.status === 'interviewing' && rejectedReadyAgain.currentQuestion?.kind === 'slot' && rejectedReadyAgain.currentQuestion?.readiness === 'insufficient', '拒绝后下一轮不会立即重复弹出假设审阅')
const acceptedReadiness = acceptAssumptions(readinessMissing, true)
const acceptedMissing = readinessMissingSlots.map((slot) => acceptedReadiness.slots.find((item) => item.id === slot.id)!)
ok(acceptedReadiness.status === 'interviewing' && acceptedReadiness.currentQuestion?.kind === 'final_check' && acceptedMissing.every((slot) => slot.source === 'assumption' && slot.answer.trim().length > 0) && !acceptedReadiness.slots.some((slot) => slot.required && !slot.answer.trim()), '接受假设会为每个 missing slot 持久化明确默认值并进入 final_check')
const acceptedFinal = answerGrillMe(acceptedReadiness, acceptedReadiness.currentQuestion!.id, '没有了')
ok(acceptedFinal.status === 'outline_ready' && grillMeInterviewReadyForOutline(acceptedFinal), '接受默认值后仍须 final_check 选择没有了才进入 outline_ready')
let advanceReadiness = createGrillMeState({ stateId: 'advance-readiness', sessionId: 'advance-readiness', originalTask: '写一篇文章', targetChars: 1200 })
advanceReadiness = answerGrillMe(advanceReadiness, advanceReadiness.currentQuestion!.id, '明确目标')
advanceReadiness = answerGrillMe(advanceReadiness, advanceReadiness.currentQuestion!.id, '明确读者')
advanceReadiness = answerGrillMe(advanceReadiness, advanceReadiness.currentQuestion!.id, '明确语气')
advanceReadiness.questions[advanceReadiness.questions.length - 1].readiness = 'ready'
advanceReadiness.currentQuestion = null
advanceReadiness = advanceInterview(advanceReadiness)
ok(advanceReadiness.status === 'assumption_review', 'advanceInterview 看到三轮后上一问 ready 且仍缺 required 时进入假设审阅')
ok(advanceReadiness.currentQuestion === null && advanceReadiness.assumptions.length === advanceReadiness.slots.filter((slot) => slot.required && !slot.answer.trim()).length, 'advanceInterview 假设审阅列出每个缺失维度的默认项')
ok(!advanceReadiness.questions.some((question) => question.kind === 'final_check'), 'required missing 时 readiness 不能由 advanceInterview 直接排队 final_check')
const failClosedFinal = (() => {
  const value = createGrillMeState({ stateId: 'fail-closed-final', sessionId: 'fail-closed-final', originalTask: '写一篇文章', targetChars: 1200 }) as any
  const forcedFinal = { id: 'final_guard_1', slotIds: [], text: '还有什么必须补充的吗？', askedAt: 1, answeredAt: null, kind: 'final_check', options: [{ id: 'none', label: '没有了', value: '没有了' }, { id: 'supplement', label: '还有补充', value: '还有补充' }], readiness: 'ready', nextSlot: null }
  value.questions.push(forcedFinal)
  value.currentQuestion = forcedFinal
  value.status = 'interviewing'
  return answerGrillMe(value, forcedFinal.id, '没有了')
})()
ok(failClosedFinal.status !== 'outline_ready' && failClosedFinal.slots.some((slot) => slot.required && !slot.answer.trim()), 'required missing 时 final_check 选择没有了也 fail-closed 并继续补齐缺失项')
ok(!grillMeInterviewReadyForOutline(failClosedFinal), 'outline validator 拒绝未完成采访')
const blockedPlan = applyPlanningModelResult(failClosedFinal, { text: '{}', providerId: 'mock', modelId: 'mock' })
ok(blockedPlan.status === failClosedFinal.status && blockedPlan.planning.status === 'failed', '未完成采访调用规划模型时保持原状态，不生成 outline-ready 假象')

const genericOptions = applyQuestionModelResult(plain, { text: JSON.stringify({ question: '请选择一个方向来继续确认目标。', options: [{ id: 'a', label: 'A', value: 'A' }, { id: 'b', label: 'B', value: 'B' }], readiness: 'insufficient', nextSlot: null }), called: true })
ok(genericOptions.interview.status === 'failed' && genericOptions.currentQuestion?.options?.some((option) => option.label === '明确行动目标'), '泛化 A/B 模型选项被拒绝并回退到当前 slot 相关选项')
const decideOptions = applyQuestionModelResult(plain, { text: JSON.stringify({ question: '请选择目标的确认方式与范围。', options: [{ id: 'decide', label: '你来决定', value: '你来决定' }, { id: 'other', label: '其他', value: '其他' }], readiness: 'insufficient', nextSlot: null }), called: true })
ok(decideOptions.interview.status === 'failed', '泛化你来决定式模型选项被拒绝')

let supplemented = createGrillMeState({ stateId: 'supplemented', sessionId: 'supplemented', originalTask: '写一篇文章', targetChars: 1200 })
while (supplemented.currentQuestion?.kind !== 'final_check' && supplemented.status === 'interviewing') supplemented = answerGrillMe(supplemented, supplemented.currentQuestion!.id, `回答 ${supplemented.questions.length}`)
const firstFinalId = supplemented.currentQuestion!.id
supplemented = answerGrillMe(supplemented, firstFinalId, '必须补充：结尾保留一个反转')
ok(supplemented.status === 'interviewing' && supplemented.currentQuestion?.kind === 'followup' && supplemented.answers.at(-1)?.kind === 'final_check' && supplemented.slots.find((slot) => slot.id === 'supplemental')?.source === 'user', 'final_check 自由补充会持久化 user provenance 并继续追问')
supplemented = answerGrillMe(supplemented, supplemented.currentQuestion!.id, '把反转落到最后一节')
ok(supplemented.currentQuestion?.kind === 'final_check', '补充 followup 回答后再次要求 final_check')
supplemented = answerGrillMe(supplemented, supplemented.currentQuestion!.id, '没有了')
ok(supplemented.status === 'outline_ready', '补充再次确认没有了才解除采访门禁')

let appendedSupplement = createGrillMeState({ stateId: 'appended-supplement', sessionId: 'appended-supplement', originalTask: '写一篇文章', targetChars: 1200 })
while (appendedSupplement.currentQuestion?.kind !== 'final_check' && appendedSupplement.status === 'interviewing') appendedSupplement = answerGrillMe(appendedSupplement, appendedSupplement.currentQuestion!.id, `补齐 ${appendedSupplement.questions.length}`)
appendedSupplement = answerGrillMe(appendedSupplement, appendedSupplement.currentQuestion!.id, '第一条额外要求')
const firstSupplement = appendedSupplement.slots.find((slot) => slot.id === 'supplemental')?.answer ?? ''
appendedSupplement = answerGrillMe(appendedSupplement, appendedSupplement.currentQuestion!.id, '第二条额外要求')
const combinedSupplement = appendedSupplement.slots.find((slot) => slot.id === 'supplemental')?.answer ?? ''
ok(combinedSupplement.includes(firstSupplement) && combinedSupplement.includes('第二条额外要求'), 'supplemental followup 追加内容而不是覆盖第一条补充')

const confirmedIds = ready.slots.filter((slot) => slot.answer.trim() && slot.source !== 'assumption').map((slot) => slot.id)
const sourceIds = confirmedIds.length ? confirmedIds : ['goal']
const validCandidate = { title: '锚点事实的星际回声', premise: '一次选择让人物必须面对已经发生的事实，并承担具体代价。', sections: [
  { id: 'a', title: '选择之前', purpose: '让读者看见人物处境和第一个关键选择', beats: ['呈现具体处境', '做出不可逆决定'], targetChars: 1, sourceSlotIds: sourceIds },
  { id: 'b', title: '代价与回应', purpose: '让选择产生后果并完成主题收束', beats: ['冲突升级', '回应原始要求'], targetChars: 3, sourceSlotIds: sourceIds }
] }
const capPlanned = applyPlanningModelResult(manualProbe, { text: JSON.stringify(validCandidate), providerId: 'mock', modelId: 'mock' })
ok(capPlanned.status === 'awaiting_outline_confirmation', '16轮 cap 后 manual final 没有了仍可通过 validator 进入规划确认')
const generic = applyPlanningModelResult(ready, { text: JSON.stringify({ title: '第1部分：推进主题与关键变化', premise: '围绕核心问题逐步展开。', sections: [{ title: '第1部分：推进主题与关键变化', purpose: '推进主题与关键变化', beats: ['推进'], targetChars: 1200, sourceSlotIds: sourceIds }] }), providerId: 'mock', modelId: 'mock' })
ok(generic.status === 'outline_ready' && generic.planning.status === 'failed', '通用模板大纲被拒绝，不冒充规划成功')
const badJson = applyPlanningModelResult(ready, { text: '{not-json', providerId: 'mock', modelId: 'mock' })
ok(badJson.status === 'outline_ready' && badJson.planning.status === 'failed', 'bad JSON 失败关闭')
const missingSources = applyPlanningModelResult(ready, { text: JSON.stringify({ ...validCandidate, sections: [{ ...validCandidate.sections[0], sourceSlotIds: [] }] }), providerId: 'mock', modelId: 'mock' })
ok(missingSources.status === 'outline_ready' && missingSources.planning.status === 'failed', '缺少显式 sourceSlotIds 时失败关闭')
const coverageReady = structuredClone(ready)
coverageReady.slots.push({ id: 'conflict', label: '核心矛盾', required: true, answer: '明确矛盾', source: 'user' })
const coverageSourceIds = [...sourceIds, 'conflict']
const coverageCandidate = { ...validCandidate, sections: validCandidate.sections.map((section) => ({ ...section, sourceSlotIds: coverageSourceIds })) }
const missingCoverageCandidate = {
  ...coverageCandidate,
  sections: coverageCandidate.sections.map((section) => ({ ...section, sourceSlotIds: coverageSourceIds.filter((id) => id !== 'conflict') }))
}
const missingCoverage = applyPlanningModelResult(coverageReady, { text: JSON.stringify(missingCoverageCandidate), providerId: 'mock' })
ok(missingCoverage.status === 'outline_ready' && missingCoverage.planning.status === 'failed' && grillMePlanningRetryableError(missingCoverage.planning.error), '合法来源漏掉全局 coverage 时首轮严格拒绝并标记可重试')
const repairPrompt = buildGrillMePlanningRepairPrompt(coverageReady, JSON.stringify(missingCoverageCandidate), missingCoverage.planning.error ?? '')
ok(repairPrompt.includes('首轮候选 JSON') && repairPrompt.includes('sourceSlotIds') && repairPrompt.includes('conflict'), '规划边界重试携带首轮候选与具体缺失来源')
const repairedCoverage = applyPlanningModelResult(coverageReady, { text: JSON.stringify(coverageCandidate), providerId: 'mock' })
ok(repairedCoverage.status === 'awaiting_outline_confirmation' && repairedCoverage.planning.status === 'success' && repairedCoverage.outline?.sections.some((section) => section.sourceSlotIds.includes('conflict')), '第二轮补齐合法来源后通过同一严格校验器')
const stillMissingCoverage = applyPlanningModelResult(coverageReady, { text: JSON.stringify(missingCoverageCandidate), providerId: 'mock' })
ok(stillMissingCoverage.status === 'outline_ready' && stillMissingCoverage.planning.status === 'failed', '第二轮仍漏合法来源时继续失败，不盲补 provenance')
const invalidSource = applyPlanningModelResult(coverageReady, { text: JSON.stringify({ ...coverageCandidate, sections: [{ ...coverageCandidate.sections[0], sourceSlotIds: ['invented-source'] }] }), providerId: 'mock' })
ok(invalidSource.status === 'outline_ready' && invalidSource.planning.status === 'failed' && !grillMePlanningRetryableError(invalidSource.planning.error) && /有效的采访事实来源/u.test(invalidSource.planning.error ?? ''), '未知来源 ID 仍保持 fail-closed 且不触发重试')
const planningPrompt = buildGrillMePlanningPrompt(coverageReady)
ok(planningPrompt.includes('必须覆盖的来源 id') && planningPrompt.includes('label') && coverageSourceIds.every((id) => planningPrompt.includes(`"${id}"`)), '规划提示明确声明全局来源 coverage 清单并携带人类可读标签')
const valid = applyPlanningModelResult(ready, { text: JSON.stringify(validCandidate), providerId: 'mock.provider', modelId: 'mock-model', durationMs: 321, usage: { inputTokens: 77, outputTokens: 55, reasoningTokens: null } })
ok(valid.status === 'awaiting_outline_confirmation' && valid.outline !== null, 'mock 规划结果进入可编辑大纲')
ok(valid.outline!.sections[0].targetChars === 300 && valid.outline!.sections[1].targetChars === 900, '章节预算按一比三模型权重分配并精确归一')
ok(valid.outline!.sections.reduce((sum, section) => sum + section.targetChars, 0) === ready.targetChars, '规划预算确定性归一为目标字数')
ok(valid.outline!.sections.every((section) => section.sourceSlotIds.every((id) => sourceIds.includes(id))), '大纲来源只允许已确认 slot id')
ok(valid.planning.durationMs === 321 && valid.planning.usage?.inputTokens === 77, '规划 provider/model/耗时/用量保存为事实')
ok(grillMeRequiredPrefix(ready).length === 0, '未确认大纲不生成正文冻结前缀')
ok(grillMeGateRequired({ longMode: true, phase: undefined }) && grillMeGateRequired({ longMode: true, phase: 'execute' }), '省略 mode 或 execute 不能绕过长文门禁')
ok(!grillMeGateRequired({ longMode: true, phase: 'plan' }) && !grillMeGateRequired({ longMode: true, phase: undefined, quickBypass: true }), '规划 intake 与显式快速直写是唯一旁路')

const edited = updateGrillMeOutline(valid, { ...valid.outline!, sections: valid.outline!.sections.map((section, index) => index === 0 ? { ...section, purpose: `${section.purpose}（用户确认）`, beats: [...section.beats, '用户补充推进点'] } : section) })
ok(edited.outlineRevision > valid.outlineRevision && edited.outlineHash !== valid.outlineHash && edited.outline!.sections[0].beats.length === 3, '编辑标题说明推进点递增 revision 并改变 hash')
const confirmed = confirmGrillMeOutline(edited, edited.outlineHash)
ok(confirmed.status === 'confirmed' && confirmed.approvedOutline?.sections[0].sourceSlotIds.length === sourceIds.length && grillMeRequiredPrefix(confirmed).length === 1, '二次确认冻结来源与大纲前缀后才允许正文')
const canonical = canonicalizeGrillMePayload({
  ...({ stateId: confirmed.stateId, originalTask: confirmed.originalTask, targetChars: confirmed.targetChars, outlineHash: confirmed.outlineHash } as any),
  answers: [{ slotId: 'goal', value: '伪造答案', source: 'user' }],
  assumptions: ['伪造假设'],
  approvedOutline: { ...confirmed.approvedOutline!, title: '伪造大纲' },
  outlineRevision: 999
}, confirmed, confirmed.sessionId)
ok(canonical.approvedOutline.title === confirmed.approvedOutline!.title && canonical.answers.every((answer) => answer.value !== '伪造答案') && canonical.outlineRevision === confirmed.outlineRevision, 'chat:start 同 hash 篡改答案/大纲时仍从 durable state 重建 canonical snapshot')
const legacy = JSON.parse(JSON.stringify(confirmed)) as any
legacy.schemaVersion = 1
for (const outline of [legacy.outline, legacy.approvedOutline]) for (const section of outline.sections) delete section.sourceSlotIds
legacy.outlineHash = grillMeOutlineHash(legacy.approvedOutline)
let legacyRejected = false
try { canonicalizeGrillMePayload(legacy, legacy, legacy.sessionId) } catch { legacyRejected = true }
ok(legacyRejected, '旧 confirmed state 缺 provenance 时 canonicalize 直接拒绝')
const migrationDir = mkdtempSync(join(tmpdir(), 'deepwriter-r46-'))
const migrationRepo = createRepository(join(migrationDir, 'grill.db'))
migrationRepo.open()
migrationRepo.saveGrillMeState(legacy)
const migrated = migrationRepo.getGrillMeState(legacy.sessionId)!
migrationRepo.close()
rmSync(migrationDir, { recursive: true, force: true })
ok(migrated.schemaVersion === 2 && migrated.status === 'outline_ready' && migrated.outline === null && migrated.approvedOutline === null && migrated.outlineHash === '' && migrated.planning.status === 'not_run' && migrated.interview.callCount === confirmed.interview.callCount, '旧 confirmed state hydrate 一次性清空旧大纲并保留采访事实与用量')
const oldInterview = JSON.parse(JSON.stringify(plain)) as any
for (const question of oldInterview.questions) { delete question.kind; delete question.options; delete question.readiness; delete question.nextSlot }
delete oldInterview.currentQuestion.kind
delete oldInterview.currentQuestion.options
delete oldInterview.currentQuestion.readiness
delete oldInterview.currentQuestion.nextSlot
const hydratedInterview = hydrateGrillMeState(oldInterview, 123)
ok(hydratedInterview?.schemaVersion === 2 && hydratedInterview.currentQuestion?.kind === 'slot' && (hydratedInterview.currentQuestion.options?.length ?? 0) >= 2, '旧采访 state 缺少 R47 字段时补齐 kind/options 且保留当前问题')
const isolatedQuestion = JSON.parse(JSON.stringify(plain)) as any
isolatedQuestion.questions = []
delete isolatedQuestion.currentQuestion.kind
delete isolatedQuestion.currentQuestion.options
const isolatedHydrated = hydrateGrillMeState(isolatedQuestion, 456)
ok(isolatedHydrated?.questions.length === 1 && isolatedHydrated.currentQuestion?.id === isolatedHydrated.questions[0]?.id, 'hydrate 将孤立 currentQuestion 补回 questions 以便重启后继续回答')
const legacyFinal = JSON.parse(JSON.stringify(appendedSupplement)) as any
legacyFinal.status = 'interviewing'
legacyFinal.currentQuestion = legacyFinal.questions.find((question: any) => question.kind === 'final_check' && question.answeredAt === null) ?? { id: 'legacy-final', slotIds: [], text: '还有什么必须补充的吗？', askedAt: 1, answeredAt: null }
delete legacyFinal.currentQuestion.kind
delete legacyFinal.currentQuestion.options
const hydratedFinal = hydrateGrillMeState(legacyFinal, 789)
ok(hydratedFinal?.currentQuestion?.kind === 'final_check' && hydratedFinal.questions.some((question) => question.id === hydratedFinal.currentQuestion?.id), 'hydrate 识别 slotIds=[] 的旧 final_check 并恢复继续回答')
const boundaryDir = mkdtempSync(join(tmpdir(), 'deepwriter-r47-boundary-'))
const boundaryRepo = createRepository(join(boundaryDir, 'grill.db'))
boundaryRepo.open()
boundaryRepo.saveGrillMeState(isolatedQuestion)
const persistedIsolated = boundaryRepo.getGrillMeState(isolatedQuestion.sessionId)!
ok(persistedIsolated.currentQuestion?.id === persistedIsolated.questions[0]?.id && persistedIsolated.questions.length === 1, 'repository 读取边界 hydrate 孤立 currentQuestion 并允许重启后继续回答')
boundaryRepo.saveGrillMeState(manualAtCap)
const persistedManual = boundaryRepo.getGrillMeState(manualAtCap.sessionId)!
ok(persistedManual.status === 'manual_completion' && persistedManual.currentQuestion?.kind === 'final_check' && persistedManual.questions.length === manualAtCap.questions.length && !persistedManual.questions.some((question) => question.id === persistedManual.currentQuestion?.id), 'repository 不把 cap 后手工 final 写入自动问题计数')
boundaryRepo.close()
rmSync(boundaryDir, { recursive: true, force: true })
const mainSource = readFileSync(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)), 'utf8')
const planningGuard = mainSource.indexOf('if (!grillMeInterviewReadyForOutline(state))')
const providerResolve = mainSource.indexOf('const resolved = resolveGrillModel()', planningGuard)
const handlerGuard = mainSource.indexOf('if (!grillMeInterviewReadyForOutline(state))', planningGuard + 1)
const handlerRun = mainSource.indexOf('return runGrillPlanning(state)', handlerGuard)
ok(planningGuard >= 0 && providerResolve > planningGuard, 'runGrillPlanning 在 resolveGrillModel 前 fail-closed')
ok(handlerGuard >= 0 && handlerRun > handlerGuard, 'outlineGenerate handler 在规划调用前 fail-closed')
ok(mainSource.includes('const firstCall = await runPlanningCall') && mainSource.includes('buildGrillMePlanningRepairPrompt(state, firstCall.text') && mainSource.includes('grillMePlanningRetryableError(first.planning.error)'), '生产规划边界只对 coverage 漏项定向重试一次')
const replanned = applyPlanningModelResult(migrated, { text: JSON.stringify(validCandidate), providerId: 'mock', modelId: 'mock' })
ok(replanned.status === 'awaiting_outline_confirmation' && replanned.outline !== null, '迁移后可重新规划并等待二次确认')
ok(JSON.parse(JSON.stringify(confirmed)).originalTask === confirmed.originalTask, '状态 JSON 可跨重启恢复且保留原始任务')
ok(buildGrillMePlanningPrompt(ready).includes('sourceSlotIds') && buildGrillMePlanningPrompt(ready).includes('targetChars'), '规划 prompt 包含来源契约与结构化约束')

// R46 entry contract: mode/workspace remain authoritative when the legacy boolean drifts.
const driftedEntry = deriveWritingRunMode({ mode: 'longwrite', workspace: 'novel', longMode: false })
ok(driftedEntry.longMode === true, 'mode=longwrite + workspace=novel 即使旧 longMode=false 仍为引导长文')
const entryRoute = (quickBypass: boolean): 'grillStart' | 'send' => driftedEntry.longMode && !quickBypass ? 'grillStart' : 'send'
ok(entryRoute(false) === 'grillStart', '普通长文提交路由为 grillStart')
ok(entryRoute(true) === 'send', '只有显式 quickBypass 才路由 send（正文调用）')
const composerSource = readFileSync(fileURLToPath(new URL('../src/renderer/src/components/Composer.tsx', import.meta.url)), 'utf8')
const grillWorkbenchSource = readFileSync(fileURLToPath(new URL('../src/renderer/src/components/GrillMeWorkbench.tsx', import.meta.url)), 'utf8')
const sidePanelSource = readFileSync(fileURLToPath(new URL('../src/renderer/src/components/SidePanel.tsx', import.meta.url)), 'utf8')
const longformSource = readFileSync(fileURLToPath(new URL('../src/renderer/src/components/LongformWorkflowShell.tsx', import.meta.url)), 'utf8')
ok(/const guidedLongwrite = deriveWritingRunMode\(\{ workspace, mode, longMode \}\)\.longMode/.test(composerSource), 'Composer 使用 canonical guidedLongwrite')
ok(/if \(guidedLongwrite && !quickBypass\)[\s\S]*startGuidedLongwrite\(t\)/.test(composerSource) && /aria-label=\{submitting \? '提交中' : guidedLongwrite \? '开始梳理' : [^}]*'发送'\}/.test(composerSource) && longformSource.includes('ds?.grillStart?.'), 'Composer 默认按钮与提交经统一工作流走 Grill Me')
ok(sidePanelSource.includes('<LongformWorkflowShell />') && !sidePanelSource.includes('LongWritePanel'), '长文只挂载统一工作流，不保留旧启动旁路')
ok(mainSource.includes('const activeGrillControllers = new Map<string, AbortController>()'), 'Grill Me provider 调用有独立可取消控制器')
ok((mainSource.match(/\}, signal\)/g) ?? []).length >= 2, '采访与大纲 provider 调用都透传 AbortSignal')
ok(mainSource.includes('activeGrillControllers.get(state.stateId)?.abort()'), 'grill:cancel 会中止在途 provider 请求')
ok(mainSource.includes("if (run.runId !== rid) continue"), '任务中心停止可识别 Grill Me activity run')
ok(!mainSource.includes('completedItems: answers') && mainSource.includes('正在判断信息是否足够'), '采访工作流不再显示固定 0/13，改为自适应状态文案')
ok(grillWorkbenchSource.includes('window.setInterval(sync, 650)'), 'Grill Me provider 在途时 renderer 会同步 durable state')

// No-network transport probe: abort must reject the in-flight provider call
// promptly, so the UI can leave 0/N instead of waiting for the 60s first-byte timeout.
const originalFetch = globalThis.fetch
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
})) as typeof fetch
const abortController = new AbortController()
const abortedRequest = streamChat({
  apiKey: 'synthetic-only',
  baseUrl: 'http://127.0.0.1:9',
  model: 'synthetic-only',
  messages: [{ role: 'user', content: 'synthetic abort probe' }],
  thinking: { enabled: false, effort: 'low' }
}, () => undefined, abortController.signal)
setTimeout(() => abortController.abort(), 10)
let abortedPromptly = false
try { await abortedRequest } catch (error) { abortedPromptly = (error as Error)?.name === 'AbortError' }
globalThis.fetch = originalFetch
ok(abortedPromptly, '在途 Grill provider 请求收到取消信号后立即收敛（无真实请求）')
console.log(`R46 Grill Me ${passed} PASS`)
