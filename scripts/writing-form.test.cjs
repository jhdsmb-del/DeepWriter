const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')
const mod = { exports: {} }
const build = buildSync({ entryPoints: [path.resolve(__dirname, '../src/shared/grillMe.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' })
new Function('module', 'exports', build.outputFiles[0].text)(mod, mod.exports)
const { createGrillMeState, answerGrillMe, hydrateGrillMeState, buildGrillMePlanningPrompt, buildGrillMeQuestionPrompt, applyPlanningModelResult, canonicalizeGrillMePayload, grillMeOutlineHash } = mod.exports
const initial = (originalTask, overrides = {}) => createGrillMeState({ originalTask, stateId: 'i', sessionId: 's', targetChars: 8000, now: 10, ...overrides })
test('同一灯塔题材按交付物提问，而不是按题材名猜成小说', () => {
  const a = initial('写一份灯塔夜班交接指南，面向新值班员。')
  const b = initial('写一篇灯塔夜班的小说，不要在结尾说教。')
  assert.equal(a.writingForm, 'expository'); assert.equal(b.writingForm, 'narrative')
  assert.ok(!a.slots.some(s => ['characters','conflict','setting'].includes(s.id)))
  assert.ok(b.slots.some(s => s.id === 'characters'))
  assert.match(buildGrillMePlanningPrompt(a), /各节|每一节回答/); assert.doesNotMatch(buildGrillMePlanningPrompt(a), /说明人物做了什么/)
  assert.match(buildGrillMePlanningPrompt(b), /说明人物做了什么/)
  assert.match(buildGrillMeQuestionPrompt(a), /读者要解决的问题/); assert.doesNotMatch(buildGrillMeQuestionPrompt(b), /说明或论述类委托/)
  assert.equal(initial('写一篇关于悬疑小说的分析报告').writingForm, 'expository')
  assert.equal(initial('把观察报告改写成短篇小说').writingForm, 'narrative')
  assert.equal(initial('给我写一篇长文。参考素材：她手边放着小说。').writingForm, 'open')
})
test('未指定写法用已有格式问题做选择，答案随重开与确认保留；旧采访不重新分类', () => {
  const open = initial('围绕灯塔夜班的那份记录写一篇长文。')
  assert.equal(open.writingForm, 'open'); assert.deepEqual(open.currentQuestion.slotIds, ['format'])
  assert.equal(open.currentQuestion.text, '这篇稿子想用哪种写法？')
  for (const [label, form] of [['说明或论述','expository'], ['小说或剧本','narrative']]) {
    const answer = open.currentQuestion.options.find(o => o.label === label)
    const next = hydrateGrillMeState(answerGrillMe(open, open.currentQuestion.id, answer.value), 20)
    assert.equal(next.writingForm, form); assert.equal(next.slots.find(s=>s.id==='format').answer, label)
    const outline = { title:'灯塔夜班', premise:'监测站夜班记录与交接', targetChars:8000, sections:[{id:'s1',title:'交班之前',purpose:'说明起始记录的含义',targetChars:8000,beats:['判断符号含义'],sourceSlotIds:['original_task']}] }
    const hash = grillMeOutlineHash(outline)
    const confirmed = { ...next,status:'confirmed',approvedOutline:outline,outline,outlineHash:hash }
    const canonical = canonicalizeGrillMePayload({ ...confirmed,writingForm:form === 'narrative'?'expository':'narrative' }, confirmed, 's')
    assert.equal(canonical.writingForm, form)
    const legacy = structuredClone(confirmed); delete legacy.writingForm
    assert.equal(hydrateGrillMeState(legacy).writingForm, undefined)
    assert.equal(canonicalizeGrillMePayload(confirmed,legacy,'s').writingForm, undefined)
  }
})
test('作者明确不适用的维度不是必须引用的材料；可以追溯到原始任务，不能凭空引用人物', () => {
  let state = initial('写一份灯塔夜班交接指南。')
  for (let i=0; i<16 && state.currentQuestion; ++i) {
    const q = state.currentQuestion; const final = q.kind === 'final_check'
    state = answerGrillMe(state,q.id,final?'没有了':'不适用',final?'answer':'not_applicable')
  }
  assert.equal(state.status,'outline_ready')
  const candidate = {title:'灯塔交班',premise:'帮助值班员填写夜间交接记录',sections:[{id:'s1',title:'交接记录',purpose:'说明哪些记录要逐项交给下一班',beats:['区分缺测与零值'],targetChars:8000,sourceSlotIds:['original_task']}]}
  const plan = obj => applyPlanningModelResult(state,{text:JSON.stringify(obj)},30)
  assert.ok(plan(candidate).outline,plan(candidate).planning.error)
  const bad=structuredClone(candidate);bad.sections[0].sourceSlotIds=['evidence']
  assert.equal(plan(bad).outline,null)
  const confirmed=structuredClone(state); confirmed.slots.find(s=>s.id==='evidence').source='user'; confirmed.slots.find(s=>s.id==='evidence').answer='缺测用空格，零值填 0。'
  assert.equal(applyPlanningModelResult(confirmed,{text:JSON.stringify(candidate)},30).outline,null)
})
