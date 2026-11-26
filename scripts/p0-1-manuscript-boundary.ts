import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { classifyAssistantOutput, parseWriterStructuredEnvelope, validateWriterStructuredEnvelope } from '../src/main/manuscript'
import { codePointLength } from '../src/shared/textMetrics'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

let passed = 0
let failed = 0

const REFUSAL_FIXTURE = [
  '抱歉，我不能继续这个请求。', '很抱歉，我无法继续这个请求。', '对不起，我不能完成这个要求。',
  '很遗憾，我无法完成这个请求。', '很遗憾，我无法继续。', '抱歉，我不能帮助你完成这件事。',
  '很抱歉，我无法协助这个请求。', '对不起，我不可以提供这类内容。', '我不能帮助你。',
  '我无法帮助你完成该任务。', '我不可以执行这个请求。', '作为AI，我不能提供这类内容。',
  '作为一个AI，我无法协助这件事。', '作为人工智能，我不能这样做。', '由于安全原因，我不能继续。',
  '出于安全考虑，我无法提供相关内容。', '根据安全政策，我不能完成该请求。', '由于政策限制，我无法协助你。',
  '这类请求我不能满足。', '此类内容我无法提供。', '这个请求我不能执行。', '这个请求我无法完成。',
  '我不能按你的要求生成这段内容。', '我无法按照你的要求继续创作。', '我不能提供上述信息。',
  '我无法提供相关指引。', '我不会生成这类文本。', '我不会写出这类内容。', '我不能写这篇内容。',
  '我无法改写这段内容。', '我不能重现这段材料。', '我无法描述这类场景。', '我不能回答这个问题。',
  '我无法回答你的请求。', '我不能参与这项活动。', '我无法参与此类操作。', '我不能处理这个任务。',
  '我无法处理该请求。', '我不能访问你要求的资源。', '我无法执行你要求的操作。', '我不能确认这项内容。',
  '我无法绕过这个限制。', '我不能绕过安全措施。', '我无法越过这项权限限制。', '我没有能力提供这项服务。',
  '我不具备完成该任务的能力。', '不能为你提供这类帮助。', '无法为你完成这个请求。', '对此我只能拒绝。',
  '对此请求我必须拒绝。', '我需要拒绝这个请求。', '我必须拒绝提供相关内容。', '我只能拒绝执行该操作。',
  '请求被拒绝，无法继续。', '不能完成该请求，请换一个方向。', '无法满足你的要求。', '不能满足这项要求。',
  '我不能支持这个请求。', '我无法支持这类内容。', '我不能继续当前对话任务。', '我无法继续当前请求。',
  '我不能生成你要求的答案。', '我无法生成这类答案。', '我不能提供具体操作步骤。', '我无法提供这类操作说明。',
  '我不能给出相关建议。', '我无法给出该类建议。', '我不能说明如何完成这件事。', '我无法解释这类操作。',
  '这违反了安全要求，我不能继续。', '这会涉及不当内容，我无法协助。', '该请求不适合由我完成。',
  '这类内容不在我能协助的范围内。', '抱歉，但我不能执行你的要求。', '抱歉，不过我无法继续。',
  '很遗憾，但我不能提供帮助。', '遗憾的是，我无法满足这个请求。', '我很抱歉，我不能协助你。',
  '我深感抱歉，但我无法完成。', '很抱歉，这项请求我不能处理。', '对不起，这类请求我无法回应。',
  '我不能遵循这个指令。', '我无法遵循你的要求。', '我不可以继续执行此任务。',
  '我不能代替专业人士给出这个判断。', '我无法核实并提供这项信息。', '我不能披露这类信息。',
  '我无法分享这类资料。', '我不能帮助规避规则。', '我无法帮助绕过限制。', '我不会协助实施此操作。',
  '我不能提供未经授权的内容。', '我无法处理涉及隐私的请求。', '我不能生成违法或危险内容。',
  '我无法协助危险行为。', '根据使用规范，我不能继续。', '受安全限制影响，我无法完成。',
  '受限于权限，我不能访问该内容。', '我不能为这个请求提供答案。', '我无法为该任务生成结果。',
  '我必须停止并拒绝这个请求。', 'Sorry, I cannot continue with this request.',
  'I am sorry, but I cannot complete this request.', "I'm sorry, I can't help with that.",
  'I’m sorry, but I can’t assist with this.', 'I apologize, but I cannot comply.', 'I am unable to continue.',
  "I'm unable to help with this request.", 'I cannot help you complete this task.', "I can't assist with that request.",
  'I cannot provide this content.', "I can't provide the requested information.", 'I am not able to fulfill this request.',
  'I’m not able to comply with your instructions.', 'I cannot comply with this request.',
  "I can't comply with that request.", 'I must refuse this request.', 'I have to decline this request.',
  'I must decline to provide that.', 'I need to decline this request.', 'Unfortunately, I cannot continue.',
  "Unfortunately, I can't help with that.", 'Regrettably, I cannot assist.', 'I’m afraid I can’t do that.',
  'For safety reasons, I cannot help.', 'Due to safety concerns, I am unable to comply.',
  'Under my safety policy, I cannot provide this.', 'According to policy, I cannot complete the task.',
  'This request is not something I can assist with.', 'This content is not something I can provide.',
  'I cannot write the requested text.', "I can't write that content.", 'I cannot generate this material.',
  'I won’t generate that content.', 'I will not provide those instructions.', 'I cannot answer that question.',
  "I can't answer your request.", 'I cannot describe that scenario.', 'I’m unable to describe this content.',
  'I cannot reproduce that material.', "I can't rewrite this passage.", 'I cannot process this request.',
  "I can't process that task.", 'I cannot access the requested resource.', "I can't perform that operation.",
  'I cannot bypass this restriction.', "I can't help bypass safety measures.", 'I cannot fulfill your request.',
  "I can't fulfill this request.", 'I will not assist with this activity.', "I won't support that request.",
  'I cannot offer those instructions.', "I can't offer advice on this.", 'I do not have the ability to provide that.',
  "I don't have the ability to do that.", 'I am not permitted to continue.', 'I’m not allowed to provide this.',
  'This request is outside what I can do.', 'I cannot honor that request.', 'I can’t meet that request.',
  'I must not provide this information.', 'I should not assist with this request.', 'I cannot proceed with this task.',
  "I can't proceed with this request.", 'I am unable to comply with your request.', "I can't assist with that.",
  'I cannot assist with that.', 'I cannot complete this task.', "I can't complete this request.",
  'I cannot support this content.', 'I can’t support that.', 'I will not generate this answer.',
  "I won't write those instructions.", 'I cannot share this information.', "I can't disclose that information.",
  'I am unable to verify and provide that.', 'I cannot help with illegal activity.', "I can't assist with dangerous behavior.",
  'I cannot provide unauthorized content.', 'I must stop and refuse.', 'I’m sorry, I have to decline.'
] as const

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function loadTsModule(relativePath: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', `p0-1-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(ROOT, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: true,
    outfile,
    external: desktopSourceExternals(path.join(ROOT, relativePath), ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']),
    logLevel: 'silent',
    plugins: [{
      name: 'electron-shim',
      setup(build: { onResolve(options: unknown, callback: (result: { path: string; namespace: string }) => unknown): void; onLoad(options: unknown, callback: () => unknown): void }): void {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
        build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
          contents: 'export const app={getPath:(name)=>String(name),isPackaged:false}; export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true})}; export const ipcMain={handle:()=>undefined,on:()=>undefined}; export const safeStorage={isEncryptionAvailable:()=>false,encryptString:()=>null,decryptString:()=>""}; export const shell={openExternal:()=>undefined,openPath:async()=>""}; export const clipboard={writeText:()=>undefined}; export const Menu={buildFromTemplate:(template)=>({popup:()=>undefined,template})};',
          loader: 'js'
        }))
      }
    }]
  })
  try {
    return await import(url.pathToFileURL(outfile).href) as Record<string, unknown>
  } finally {
    await fsp.unlink(outfile).catch(() => undefined)
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function exactProse(length: number, prefix: string): string {
  const points = Array.from(prefix)
  const target = Math.max(1, Math.floor(length))
  while (points.length < target - 1) points.push(String.fromCodePoint(0x20000 + points.length))
  points.length = Math.max(0, target - 1)
  points.push('。')
  return points.join('')
}

function runAdversarialBoundaryCorpus(): void {
  const prose = '夜雨落在灯塔上。'
  const corpus: Array<{ name: string; input: string; kind: 'prose' | 'meta' | 'refusal'; content?: string; complete?: boolean }> = [
    { name: '拒绝前缀-非常抱歉', input: '非常抱歉，我不能继续这个请求。', kind: 'refusal' },
    { name: '拒绝前缀-不好意思', input: '不好意思，我无法继续。', kind: 'refusal' },
    { name: '拒绝前缀-恐怕', input: '恐怕我不能完成这个请求。', kind: 'refusal' },
    { name: '包装前缀-当然以下正文', input: '当然，以下是正文：\n' + prose, kind: 'prose', content: prose, complete: true },
    { name: '包装前缀-好的下面继续正文', input: '好的，下面继续正文：\n' + prose, kind: 'prose', content: prose, complete: true },
    { name: '包装前缀-没问题继续写', input: '没问题，我来继续写。\n' + prose, kind: 'prose', content: prose, complete: true },
    { name: '拒绝后缀-中文', input: prose + '\n很遗憾，我无法继续。', kind: 'prose', content: prose, complete: true },
    { name: '拒绝后缀-英文', input: prose + '\nSorry, I cannot continue with this request.', kind: 'prose', content: prose, complete: true },
    { name: '拒绝后缀-同一行', input: prose + '很遗憾，我无法继续。', kind: 'prose', content: prose, complete: true },
    { name: '元话语后缀-继续创作', input: prose + '\n我将为你继续创作。', kind: 'prose', content: prose, complete: true },
    { name: '标题后缀-保留不完整证据', input: prose + '\n标题：雾港夜班', kind: 'prose', content: prose, complete: false },
    { name: 'JSON后缀-保留不完整证据', input: prose + '\nJSON：{"outline":[]}', kind: 'prose', content: prose, complete: false },
    { name: '包装同一行-当然', input: '当然，以下是正文：' + prose, kind: 'prose', content: prose, complete: true },
    { name: '包装同一行-继续', input: '没问题，我来继续写。' + prose, kind: 'prose', content: prose, complete: true },
    { name: '角色对白-非常抱歉', input: '“非常抱歉，我不能跟你走。”林舟说。', kind: 'prose', complete: true },
    { name: '角色对白-恐怕', input: '林舟低声道：“恐怕我不能继续。”', kind: 'prose', complete: true },
    { name: '角色对白-不好意思', input: '“不好意思，我无法答应。”她低声道。', kind: 'prose', complete: true },
    { name: '角色对白-英文', input: '“Sorry, I cannot go with you,” she whispered.', kind: 'prose', complete: true },
    { name: '角色对白-无引号归属', input: '林舟说：恐怕我不能继续。', kind: 'prose', complete: true }
  ]
  let misses = 0
  for (const test of corpus) {
    const result = classifyAssistantOutput(test.input)
    const passedCase = result.kind === test.kind &&
      (test.content === undefined || result.content === test.content) &&
      (test.complete === undefined || result.complete === test.complete)
    if (!passedCase) misses += 1
    check('P0-2 对抗语料 ' + test.name, passedCase, JSON.stringify(result))
  }
  check('P0-2 对抗 corpus 红→绿后漏判为 0', misses === 0, 'cases=' + corpus.length + ', misses=' + misses)

  const splitCases = [
    ['当然，以下是', '正文：\n夜雨落在灯塔上。'],
    [prose + '\n很遗憾，', '我无法继续。'],
    [prose + '\n标题：', '雾港夜班'],
    ['{\"schemaVersion\":1,\"prose\":\"夜雨落在', '灯塔上。\",\"status\":\"complete\"}']
  ]
  let invariant = true
  for (const chunks of splitCases) {
    const joined = chunks.join('')
    let streamed = ''
    for (const chunk of chunks) streamed += chunk
    const wholeResult = classifyAssistantOutput(joined)
    const streamedResult = classifyAssistantOutput(streamed)
    if (JSON.stringify(wholeResult) !== JSON.stringify(streamedResult)) invariant = false
  }
  check('P0-2 stream 分块合并后分类结果不变', invariant, 'chunk_cases=' + splitCases.length)

  const validEnvelope = parseWriterStructuredEnvelope(JSON.stringify({
    schemaVersion: 1,
    prose,
    notes: ['status is kept out of prose'],
    status: 'complete'
  }))
  const validEnvelopeClassification = classifyAssistantOutput(JSON.stringify({
    schemaVersion: 1,
    prose,
    notes: ['status is kept out of prose'],
    status: 'complete'
  }))
  const partialEnvelope = classifyAssistantOutput(JSON.stringify({ schemaVersion: 1, prose, notes: [], status: 'partial' }))
  const refusalEnvelope = classifyAssistantOutput(JSON.stringify({ schemaVersion: 1, prose: '', notes: ['blocked'], status: 'refusal' }))
  const malformedInput = '{"schemaVersion":1,"prose":42,"notes":[]}'
  const malformedEnvelope = parseWriterStructuredEnvelope(malformedInput)
  const malformedClassification = classifyAssistantOutput(malformedInput)
  check('P0-2 valid envelope prose/notes/status 分通道', validEnvelope.detected && validEnvelope.ok && validEnvelope.envelope.prose === prose && validEnvelope.envelope.notes.length === 1 && validEnvelope.envelope.status === 'complete' && validEnvelopeClassification.content === prose && !validEnvelopeClassification.content.includes('status is kept out of prose'), JSON.stringify({ validEnvelope, validEnvelopeClassification }))
  check('P0-2 envelope status=partial 只能 candidate/partial', partialEnvelope.kind === 'prose' && !partialEnvelope.complete, JSON.stringify(partialEnvelope))
  check('P0-2 envelope status=refusal 不进入正文', refusalEnvelope.kind === 'refusal' && refusalEnvelope.content === '' && !refusalEnvelope.complete, JSON.stringify(refusalEnvelope))
  check('P0-2 envelope 结构解析失败 fail-closed', malformedEnvelope.detected && !malformedEnvelope.ok && malformedClassification.kind !== 'prose' && !malformedClassification.complete, JSON.stringify({ malformedEnvelope, malformedClassification }))
  check('P0-2 envelope validator 拒绝错误 notes/status', !validateWriterStructuredEnvelope({ schemaVersion: 1, prose, notes: [1] }).ok && !validateWriterStructuredEnvelope({ schemaVersion: 1, prose, status: 'unknown' }).ok)

  // The tail scanner must continue past the old four-line limit.  Include
  // both removable presentation lines and an unsafe structured block: the
  // former should be stripped, while the latter must either be gone or make
  // the candidate incomplete (and therefore un-acceptable).
  const pollutionUnits = [
    '我将为你继续创作。',
    '很遗憾，我无法继续。',
    '备注：以下内容仅供参考。',
    '已完成本次写作。',
    '说明：请忽略这段输出。',
    'JSON：{"notes":[]}',
    '我会继续处理这个请求。',
    '输出格式：纯正文。'
  ]
  for (const count of [5, 6, 20]) {
    const units = Array.from({ length: count }, (_, index) => pollutionUnits[index % pollutionUnits.length])
    const result = classifyAssistantOutput([prose, ...units].join('\n'))
    const accepted = result.kind === 'prose' && result.complete && result.content === [prose, ...units].join('\n')
    const safe = !accepted && (result.content === prose || !result.complete)
    check(`P0-R ${count} 个混合尾部污染单元不得进入 accepted`, safe, JSON.stringify(result))
  }
  const safeTwenty = [prose, ...Array.from({ length: 20 }, () => '我将为你继续创作。')].join('\n')
  const safeTwentyResult = classifyAssistantOutput(safeTwenty)
  check('P0-R 20 个可剥离 meta 单元全部剥离', safeTwentyResult.kind === 'prose' && safeTwentyResult.complete && safeTwentyResult.content === prose, JSON.stringify(safeTwentyResult))

  const multilineMixed = [
    prose,
    '我将为你继续创作。',
    '很遗憾，我无法继续。',
    'JSON：{',
    '  "status": "complete",',
    '  "notes": []',
    '}',
    '备注：输出结束。'
  ].join('\n')
  const multilineResult = classifyAssistantOutput(multilineMixed)
  check('P0-R 多行 meta/refusal/JSON 混合尾部剥离或 fail-closed', multilineResult.content === prose || !multilineResult.complete, JSON.stringify(multilineResult))

  const longProse = Array.from({ length: 300 }, (_, index) => `正文段落 ${index}。`).join('\n')
  const longProseResult = classifyAssistantOutput(longProse)
  check('P0-R 有界尾扫描不误伤正常长正文', longProseResult.kind === 'prose' && longProseResult.complete && longProseResult.content === longProse, JSON.stringify(longProseResult))
  const dialogueColon = '林舟: 我们走。'
  const dialogueColonResult = classifyAssistantOutput(dialogueColon)
  check('P0-R 残余结构检查不误伤冒号对白', dialogueColonResult.kind === 'prose' && dialogueColonResult.complete && dialogueColonResult.content === dialogueColon, JSON.stringify(dialogueColonResult))

  const overScan = [prose, ...Array.from({ length: 5000 }, (_, index) => `说明：尾部单元 ${index}`)].join('\n')
  const overScanResult = classifyAssistantOutput(overScan)
  check('P0-R 超过尾部扫描行上限时 fail-closed', overScanResult.kind !== 'prose' || !overScanResult.complete, JSON.stringify({ kind: overScanResult.kind, complete: overScanResult.complete, evidence: overScanResult.evidence.slice(-3) }))
  const oversizedTail = `${prose}\n说明：${'尾'.repeat(600_000)}`
  const oversizedTailResult = classifyAssistantOutput(oversizedTail)
  check('P0-R 超过尾部扫描字节上限时 fail-closed', oversizedTailResult.kind !== 'prose' || !oversizedTailResult.complete, JSON.stringify({ kind: oversizedTailResult.kind, complete: oversizedTailResult.complete, evidence: oversizedTailResult.evidence.slice(-3) }))
}

async function main(): Promise<void> {
  runAdversarialBoundaryCorpus()
  const corpusResults = REFUSAL_FIXTURE.map((sample) => classifyAssistantOutput(sample))
  check('P0-1 固定中英文拒绝语料不少于 100 条', REFUSAL_FIXTURE.length >= 100, `count=${REFUSAL_FIXTURE.length}`)
  check('P0-1 固定拒绝语料严重漏判为 0', corpusResults.every((result) => result.kind === 'refusal' && result.content === '' && result.complete === false), JSON.stringify({ total: corpusResults.length, missed: REFUSAL_FIXTURE.filter((_, index) => corpusResults[index]?.kind !== 'refusal') }))
  const stableInput = '很遗憾，我无法继续。'
  const stableA = classifyAssistantOutput(stableInput)
  const stableB = classifyAssistantOutput(stableInput)
  const stableVariant = classifyAssistantOutput('  很遗憾，\n我无法继续。  ')
  check('P0-1 分类 reason/evidence 重复计算稳定且容忍边界空白', stableA.reason.length > 0 && stableA.evidence.length > 0 && JSON.stringify(stableA) === JSON.stringify(stableB) && stableA.kind === stableVariant.kind && stableA.reason === stableVariant.reason && stableA.evidence.join('|') === stableVariant.evidence.join('|'), JSON.stringify({ stableA, stableB, stableVariant }))

  const boundaryCases: Array<{ name: string; input: string; kind: 'prose' | 'meta' | 'refusal' | 'plan'; content?: string; complete?: boolean }> = [
    { name: '中文说明行+正文', input: '我将为你继续创作。\n夜雨落在灯塔上。', kind: 'prose', content: '夜雨落在灯塔上。', complete: true },
    { name: '中文正文包装+正文', input: '以下是你要的小说正文如下：\n夜雨落在灯塔上。', kind: 'prose', content: '夜雨落在灯塔上。', complete: true },
    { name: '标题包装+正文', input: '标题：雾港夜班\n夜雨落在灯塔上。', kind: 'prose', content: '夜雨落在灯塔上。', complete: true },
    { name: 'Markdown fence+正文', input: '```markdown\n夜雨落在灯塔上。\n```', kind: 'prose', content: '夜雨落在灯塔上。', complete: true },
    { name: '说明+fence+正文', input: '以下是正文：\n```markdown\n夜雨落在灯塔上。\n```', kind: 'prose', content: '夜雨落在灯塔上。', complete: true },
    { name: '说明行+正文同一行', input: '以下是正文：夜雨落在灯塔上。', kind: 'prose', content: '夜雨落在灯塔上。', complete: true },
    { name: '报告行+正文', input: '已完成本次写作。\n夜雨落在灯塔上。', kind: 'prose', content: '夜雨落在灯塔上。', complete: true },
    { name: '说明纯文本不进入正文', input: '注：以下正文仅供参考。', kind: 'meta' },
    { name: '标题纯文本不进入正文', input: '# 雾港夜班', kind: 'meta' },
    { name: 'JSON 对象隔离', input: '{"outline":["收束"]}', kind: 'plan' },
    { name: 'JSON 标签隔离', input: 'JSON：{"outline":["收束"]}', kind: 'plan' },
    { name: 'JSON fence 隔离', input: '```json\n{"outline":["收束"]}\n```', kind: 'plan' },
    { name: '拒绝在说明后仍隔离', input: '下面是处理结果：\n很遗憾，我无法继续。', kind: 'refusal' },
    { name: '说明前缀同一行的拒绝仍隔离', input: '说明：很遗憾，我无法继续。', kind: 'refusal' },
    { name: '拒绝后附伪正文仍隔离', input: '抱歉，我不能继续。夜雨落在灯塔上。', kind: 'refusal' },
    { name: '全角半角空白与软换行拒绝仍隔离', input: '  Sorry，\n I cannot continue with this request.  ', kind: 'refusal' },
    { name: '残句保留 partial 语义', input: '门外传来急促的脚步声', kind: 'prose', content: '门外传来急促的脚步声', complete: false }
  ]
  for (const test of boundaryCases) {
    const result = classifyAssistantOutput(test.input)
    check(test.name, result.kind === test.kind && (test.content === undefined || result.content === test.content) && (test.complete === undefined || result.complete === test.complete), JSON.stringify(result))
  }

  const dialogueCases = [
    '“抱歉，我不能跟你走。”林舟说。',
    '林舟说：抱歉，我不能继续。',
    '她低声道：“我不能答应你。”',
    '“I’m sorry, but I can’t leave,” she whispered.',
    'He said, “I cannot help you with that.”',
    '林舟回答：“对不起，我无法回头。”\n雨水顺着他的袖口滴落。',
    '抱歉，我不能继续。你要求的是‘正文’。'
  ]
  const dialogueResults = dialogueCases.map((input) => classifyAssistantOutput(input))
  check('P0-1 真实小说对白中的抱歉/拒绝不被误删', dialogueResults.slice(0, -1).every((result) => result.kind === 'prose' && result.content.length > 0), JSON.stringify(dialogueResults))
  check('P0-1 对白保留后仍按自然结尾判断', dialogueResults.slice(0, 5).every((result) => result.complete), JSON.stringify(dialogueResults.map((result) => result.complete)))
  check('P0-1 引号只包住后缀时不能掩护前置拒绝', dialogueResults.at(-1)?.kind === 'refusal' && dialogueResults.at(-1)?.content === '', JSON.stringify(dialogueResults.at(-1)))

  const [snapshotMod, repoMod, portMod, engineMod] = await Promise.all([
    loadTsModule('src/main/executionSnapshot.ts'),
    loadTsModule('src/main/db/repository.ts'),
    loadTsModule('src/main/runKernelAdapter.ts'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts')
  ])
  const buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const createRepository = repoMod.createRepository as (dbPath: string) => {
    open(): void
    close(): void
    saveManuscriptSegment(segment: Record<string, unknown>): void
    acceptManuscriptSegmentsForTest(runId: string, segmentIds: string[], acceptedAt: number): void
    getManuscriptSegmentsByRun(runId: string): Array<Record<string, unknown>>
    getArtifactsByRun(runId: string): Array<Record<string, unknown>>
  }
  const createRunStorePort = portMod.createRunStorePort as (repository: unknown, artifactDir: string) => {
    getArtifactContent(hash: string): Promise<string | null>
  }
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => {
    start(input: Record<string, unknown>): Promise<{ ok: boolean }>
    step(runId: string): Promise<void>
    getState(runId: string): Promise<{ run: { status: string; errorCode?: string } | null }>
  }

  const targetChars = 240
  const runId = 'p0-1-boundary-e2e'
  const sessionId = 'p0-1-session'
  const settings = {
    model: 'synthetic-p0-1',
    baseUrl: 'http://127.0.0.1:9',
    maxTokens: 1024,
    temperature: 0.7,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    workDir: 'C:/p0-1-work',
    docDir: 'C:/p0-1-docs',
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 20000,
    strongConstraintEnabled: false
  }
  const config = buildExecutionSnapshot({
    payload: {
      id: runId,
      mode: 'longwrite',
      workspace: 'novel',
      phase: 'execute',
      longMode: true,
      targetChars,
      text: '请继续当前小说，只输出正文。'
    },
    settings,
    sessionId,
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  const firstAccepted = exactProse(100, '林舟推开灯塔的门，沈遥把钥匙放进他掌心，')
  const finalAccepted = exactProse(targetChars - 100, '雨声在身后合拢，远处的雾笛穿过礁石，')
  const outputs = [firstAccepted, '很遗憾，我无法继续。', finalAccepted]
  let providerCalls = 0
  const capturedMessages: Array<Array<{ role: string; content: string }>> = []
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p0-1-boundary-'))
  const repo = createRepository(path.join(tempDir, 'run.db'))
  repo.open()
  const store = createRunStorePort(repo, path.join(tempDir, 'artifacts'))
  let published: { content: string; contentHash: string } | null = null
  const engine = createAgentRunEngine({
    store,
    modelCall: async (input: { messages: Array<{ role: string; content: string }> }) => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
        const text = outputs[Math.min(providerCalls, outputs.length - 1)] ?? ''
        providerCalls += 1
        capturedMessages.push(input.messages.map((message) => ({ role: message.role, content: message.content })))
        for (let offset = 0; offset < text.length; offset += 256) yield { type: 'text', delta: text.slice(offset, offset + 256) }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async (input: { content: string; contentHash: string }) => {
      published = { content: input.content, contentHash: input.contentHash }
      return { displayName: 'p0-1-manuscript.md', relativePath: 'p0-1-manuscript.md' }
    }
  })

  try {
    const started = await engine.start({ sessionId, runId, config })
    await engine.step(runId)
    const state = await engine.getState(runId)
    const rows = repo.getManuscriptSegmentsByRun(runId)
    const accepted = rows.filter((row) => row.status === 'accepted')
    const rejected = rows.filter((row) => row.status === 'rejected')
    const acceptedText = accepted
      .sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index) || Number(a.revision) - Number(b.revision))
      .map((row) => String(row.content ?? ''))
      .join('')
    const artifacts = repo.getArtifactsByRun(runId)
    const manuscript = artifacts.find((artifact) => artifact.artifact_type === 'manuscript' && artifact.status === 'completed')
    const artifactContent = manuscript ? await store.getArtifactContent(String(manuscript.hash ?? '')) : null
    const assistantContext = capturedMessages.at(-1)?.filter((message) => message.role === 'assistant').map((message) => message.content).join('') ?? ''
    check('P0-1 真实 engine/repository 接受链完成', started.ok && state.run?.status === 'completed', JSON.stringify(state.run))
    check('P0-1 单次拒绝后正向接受链不污染 artifact', providerCalls === 3 && accepted.length === 2 && rejected.some((row) => row.kind === 'refusal') && !acceptedText.includes('无法继续') && !String(artifactContent ?? '').includes('无法继续'), JSON.stringify({ providerCalls, accepted: accepted.length, rejected: rejected.length, acceptedText: acceptedText.slice(0, 80) }))
    check('P0-1 accepted 正文、artifact 内容、字数、hash 完全一致', manuscript?.char_count === codePointLength(acceptedText) && manuscript?.hash === hash(acceptedText) && artifactContent === acceptedText && published?.content === acceptedText && published?.contentHash === hash(acceptedText), JSON.stringify({ acceptedChars: codePointLength(acceptedText), artifactChars: manuscript?.char_count, artifactHash: manuscript?.hash, publishedHash: published?.contentHash }))
    check('P0-1 rejected assistant 不泄漏到后续正文上下文', !assistantContext.includes('无法继续') && !assistantContext.includes('outline') && assistantContext.includes('林舟'), `assistantContextChars=${codePointLength(assistantContext)}`)

    // Keep the fail-closed no-progress behavior in an independent run so it
    // cannot prevent the positive publication chain above from completing.
    const zeroRunId = 'p0-1-boundary-zero-progress'
    const zeroSessionId = 'p0-1-zero-session'
    const zeroConfig = buildExecutionSnapshot({
      payload: { id: zeroRunId, mode: 'longwrite', workspace: 'novel', phase: 'execute', longMode: true, targetChars, text: '请继续当前小说，只输出正文。' },
      settings,
      sessionId: zeroSessionId,
      memory: { projectPath: '', projectContent: '', userContent: '' }
    })
    const zeroOutputs = [firstAccepted, '很遗憾，我无法继续。', '{"outline":["不得进入正文"]}', finalAccepted]
    let zeroCalls = 0
    const zeroEngine = createAgentRunEngine({
      store,
      modelCall: async () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
          const text = zeroOutputs[Math.min(zeroCalls, zeroOutputs.length - 1)] ?? ''
          zeroCalls += 1
          yield { type: 'text', delta: text }
          yield { type: 'finish', finishReason: 'stop' }
        }
      }),
      toolExecutor: async () => '',
      getConfig: () => zeroConfig,
      onEvent: () => undefined,
      onRunUpdate: () => undefined
    })
    await zeroEngine.start({ sessionId: zeroSessionId, runId: zeroRunId, config: zeroConfig })
    await zeroEngine.step(zeroRunId)
    const zeroState = await zeroEngine.getState(zeroRunId)
    const zeroRows = repo.getManuscriptSegmentsByRun(zeroRunId)
    const zeroAccepted = zeroRows.filter((row) => row.status === 'accepted')
    const zeroRejected = zeroRows.filter((row) => row.status === 'rejected')
    check('P0-1 连续两轮 0 accepted delta 有界暂停且污染不 accepted', zeroState.run?.status === 'waiting_user' && zeroState.run.errorCode === 'run_no_progress' && zeroCalls === 3 && zeroAccepted.length === 1 && zeroRejected.some((row) => row.kind === 'refusal') && zeroRejected.some((row) => row.kind === 'plan'), JSON.stringify({ run: zeroState.run, calls: zeroCalls, accepted: zeroAccepted.length, rejected: zeroRejected.map((row) => row.kind) }))
    const poisonContent = '很遗憾，我无法继续。'
    repo.saveManuscriptSegment({
      segment_id: `${runId}:poison`, run_id: runId, session_id: sessionId, source_turn_id: null,
      section_id: null, scene_id: null, chunk_index: 999, revision: 1, status: 'candidate', kind: 'prose',
      content: poisonContent, content_hash: hash(poisonContent), char_count: codePointLength(poisonContent),
      supersedes_segment_id: null, created_at: 999, updated_at: 999, accepted_at: null
    })
    let poisonRejected = false
    try { repo.acceptManuscriptSegmentsForTest(runId, [`${runId}:poison`], 1000) } catch { poisonRejected = true }
    const poisonRow = repo.getManuscriptSegmentsByRun(runId).find((row) => row.segment_id === `${runId}:poison`)
    check('P0-1 repository 接受前重新分类，伪标 refusal candidate 不得 accepted', poisonRejected && poisonRow?.status === 'candidate' && !acceptedText.includes(poisonContent), JSON.stringify(poisonRow))
    const envelopePoisonContent = '{"schemaVersion":1,"prose":42,"notes":[]}'
    repo.saveManuscriptSegment({
      segment_id: `${runId}:envelope-poison`, run_id: runId, session_id: sessionId, source_turn_id: null,
      section_id: null, scene_id: null, chunk_index: 1000, revision: 1, status: 'candidate', kind: 'prose',
      content: envelopePoisonContent, content_hash: hash(envelopePoisonContent), char_count: codePointLength(envelopePoisonContent),
      supersedes_segment_id: null, created_at: 1000, updated_at: 1000, accepted_at: null
    })
    let envelopePoisonRejected = false
    try { repo.acceptManuscriptSegmentsForTest(runId, [`${runId}:envelope-poison`], 1001) } catch { envelopePoisonRejected = true }
    const envelopePoisonRow = repo.getManuscriptSegmentsByRun(runId).find((row) => row.segment_id === `${runId}:envelope-poison`)
    check('P0-2 repository 重新分类后拒绝 malformed envelope', envelopePoisonRejected && envelopePoisonRow?.status === 'candidate', JSON.stringify(envelopePoisonRow))
  } finally {
    repo.close()
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\nP0-1 manuscript boundary: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P0-1 manuscript boundary 执行异常：', error)
  process.exitCode = 2
})
