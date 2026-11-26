// ==================== R4.2 Task A5 上下文组装器（contextAssembler）独立模块测试 ====================
// 覆盖：CTX-TOTAL-BUDGET-01 硬预算（裁剪/抛错）/ CTX-SINGLE-OVERSIZE-01 单条超限（截断/drop）
//       / CTX-NODUP-02 按 msgId 去重 / CTX-MANIFEST-01 manifest 结构完整性
// 运行：npx esbuild scripts/r42-context.ts --bundle --format=esm --platform=node --outfile=out/r42-context.mjs && node out/r42-context.mjs

import { createHash } from 'node:crypto'
import { assembleContext, type AssembleInput, type ContextManifest } from '../src/main/contextAssembler'
import { estimateTokens } from '../src/shared/types'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sha256hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const REP = (ch: string, n: number): string => ch.repeat(n)
const TRUNCATED_MARKER = '\n[…已截断：上下文预算不足]'

function mkInput(over: Partial<AssembleInput>): AssembleInput {
  return {
    runId: 'r42-test',
    round: 1,
    contextWindowTokens: 10000,
    outputReserveTokens: 1000,
    staticSystem: [],
    memory: [],
    attachments: [],
    user: null,
    history: [],
    toolResults: [],
    assetSummaries: [],
    ...over
  }
}

async function main(): Promise<void> {
  // ==================== CTX-TOTAL-BUDGET-01 ====================
  console.log('\n[CTX-TOTAL-BUDGET-01] 硬预算：超预算输入必须裁剪/丢弃，user/staticSystem 超限必须抛错（fail-closed）')
  {
    // 候选共 1000+300+50+20000 token，远超 budget=9000，且全部原样放入必超
    const res = assembleContext(
      mkInput({
        runId: 'ctx-total-budget-01a',
        contextWindowTokens: 10000,
        outputReserveTokens: 1000,
        staticSystem: [{ role: 'system', content: REP('甲', 1000) }],
        memory: [{ role: 'system', content: REP('乙', 300) }],
        user: { msgId: 'u1', content: REP('丙', 50) },
        history: Array.from({ length: 10 }, (_, i) => ({
          msgId: `h${i}`,
          role: i % 2 === 0 ? ('assistant' as const) : ('user' as const),
          content: REP('丁', 2000)
        }))
      })
    )
    const m = res.manifest
    const historySeg = m.segments.find((s) => s.kind === 'history')
    check('CTX-TOTAL-BUDGET-01 不加裁剪必然超预算（候选估算 > budget）', historySeg !== undefined && historySeg.estimatedTokens > m.budgetTokens, `候选=${historySeg?.estimatedTokens} budget=${m.budgetTokens}`)
    check('CTX-TOTAL-BUDGET-01 裁剪后 totalTokens <= budgetTokens', m.totalTokens <= m.budgetTokens, `total=${m.totalTokens} budget=${m.budgetTokens}`)
    check(
      'CTX-TOTAL-BUDGET-01 history 段出现丢弃原因（budget 或 truncated-budget）',
      historySeg !== undefined && (historySeg.droppedReason === 'budget' || historySeg.droppedReason === 'truncated-budget'),
      historySeg ? `reason=${historySeg.droppedReason}` : '无 history 段'
    )
    check('CTX-TOTAL-BUDGET-01 截断标记出现在最终消息中', res.messages.some((msg) => msg.content.includes(TRUNCATED_MARKER)), '')
    check('CTX-TOTAL-BUDGET-01 history 段 actualTokens < estimatedTokens', historySeg !== undefined && historySeg.actualTokens !== null && historySeg.actualTokens < historySeg.estimatedTokens, `actual=${historySeg?.actualTokens} est=${historySeg?.estimatedTokens}`)
    check('CTX-TOTAL-BUDGET-01 overBudget=false（组装结果始终不超预算）', m.overBudget === false, `over=${m.overBudget}`)

    // 单条超大 user → 抛错（fail-closed，不能静默放入）
    let userThrew = false
    let userErr = ''
    try {
      assembleContext(
        mkInput({
          contextWindowTokens: 2000,
          outputReserveTokens: 500,
          staticSystem: [{ role: 'system', content: REP('甲', 100) }],
          user: { msgId: 'u-big', content: REP('乙', 2000) }
        })
      )
    } catch (e) {
      userThrew = true
      userErr = e instanceof Error ? e.message : String(e)
    }
    check('CTX-TOTAL-BUDGET-01 单条超大 user 抛错（fail-closed）', userThrew, userErr)

    // budget <= 0 → 抛错
    let budgetThrew = false
    try {
      assembleContext(mkInput({ contextWindowTokens: 500, outputReserveTokens: 600 }))
    } catch {
      budgetThrew = true
    }
    check('CTX-TOTAL-BUDGET-01 budget<=0 抛错（fail-closed）', budgetThrew, '')

    // staticSystem 单独超 budget → 抛错
    let staticThrew = false
    try {
      assembleContext(
        mkInput({
          contextWindowTokens: 2000,
          outputReserveTokens: 500,
          staticSystem: [{ role: 'system', content: REP('甲', 2000) }]
        })
      )
    } catch {
      staticThrew = true
    }
    check('CTX-TOTAL-BUDGET-01 staticSystem 单独超 budget 抛错（fail-closed）', staticThrew, '')
  }

  // ==================== CTX-SINGLE-OVERSIZE-01 ====================
  console.log('\n[CTX-SINGLE-OVERSIZE-01] 单条超限：history 截断（含标记）；toolResult/assetSummary 整条丢弃')
  {
    // 单条 history 超剩余预算 → 截断到剩余预算内，尾部追加标记
    const res = assembleContext(
      mkInput({
        runId: 'ctx-single-oversize-01a',
        contextWindowTokens: 5000,
        outputReserveTokens: 500,
        staticSystem: [{ role: 'system', content: REP('甲', 1000) }],
        memory: [{ role: 'system', content: REP('乙', 100) }],
        user: { msgId: 'u1', content: REP('丙', 50) },
        history: [{ msgId: 'h-big', role: 'assistant', content: REP('丁', 5000) }]
      })
    )
    const hMsg = res.messages.find((msg) => msg.content.includes('丁'))
    const hSeg = res.manifest.segments.find((s) => s.kind === 'history')
    // 剩余预算 = 4500 - 1000 - 100 - 50 = 3350
    check('CTX-SINGLE-OVERSIZE-01 单条 history 被截断（长度受控，小于原 5000）', hMsg !== undefined && hMsg.content.length < 5000 && hMsg.content.length > 0, `len=${hMsg?.content.length}`)
    check('CTX-SINGLE-OVERSIZE-01 截断内容含截断标记', hMsg !== undefined && hMsg.content.endsWith(TRUNCATED_MARKER), '')
    check('CTX-SINGLE-OVERSIZE-01 截断后 token 估算不超剩余预算 3350', hMsg !== undefined && estimateTokens(hMsg.content) <= 3350, `tokens=${hMsg ? estimateTokens(hMsg.content) : -1}`)
    check('CTX-SINGLE-OVERSIZE-01 manifest history 段 droppedReason=truncated-budget', hSeg !== undefined && hSeg.droppedReason === 'truncated-budget', hSeg ? `reason=${hSeg.droppedReason}` : '无 history 段')
    check('CTX-SINGLE-OVERSIZE-01 总预算不超（totalTokens <= budgetTokens）', res.manifest.totalTokens <= res.manifest.budgetTokens, `total=${res.manifest.totalTokens} budget=${res.manifest.budgetTokens}`)

    // 单条 toolResult 超剩余预算 → 整条 drop（droppedReason=budget）
    const resB = assembleContext(
      mkInput({
        runId: 'ctx-single-oversize-01b',
        contextWindowTokens: 4000,
        outputReserveTokens: 500,
        staticSystem: [{ role: 'system', content: REP('甲', 2000) }],
        memory: [{ role: 'system', content: REP('乙', 200) }],
        user: { msgId: 'u1', content: REP('丙', 100) },
        toolResults: [{ sourceId: 't1', content: REP('丁', 3000) }]
      })
    )
    const trSeg = resB.manifest.segments.find((s) => s.kind === 'tool-result')
    check('CTX-SINGLE-OVERSIZE-01 单条 toolResult 超预算被 drop（不进 messages）', !resB.messages.some((msg) => msg.content.includes('[工具结果 t1]')), '')
    check('CTX-SINGLE-OVERSIZE-01 tool-result 段 droppedReason=budget', trSeg !== undefined && trSeg.droppedReason === 'budget', trSeg ? `reason=${trSeg.droppedReason}` : '无 tool-result 段')
    check('CTX-SINGLE-OVERSIZE-01 tool-result 段未放入内容（actualTokens=null）', trSeg !== undefined && trSeg.actualTokens === null, '')

    // 单条 assetSummary 超剩余预算 → 整条 drop（droppedReason=budget）
    const resC = assembleContext(
      mkInput({
        runId: 'ctx-single-oversize-01c',
        contextWindowTokens: 4000,
        outputReserveTokens: 500,
        staticSystem: [{ role: 'system', content: REP('甲', 2000) }],
        memory: [{ role: 'system', content: REP('乙', 200) }],
        user: { msgId: 'u1', content: REP('丙', 100) },
        assetSummaries: [{ assetHash: 'a1', summary: REP('戊', 3000) }]
      })
    )
    const asSeg = resC.manifest.segments.find((s) => s.kind === 'asset-summary')
    check('CTX-SINGLE-OVERSIZE-01 单条 assetSummary 超预算被 drop（不进 messages）', !resC.messages.some((msg) => msg.content.includes('[资产摘要 a1]')), '')
    check('CTX-SINGLE-OVERSIZE-01 asset-summary 段 droppedReason=budget', asSeg !== undefined && asSeg.droppedReason === 'budget', asSeg ? `reason=${asSeg.droppedReason}` : '无 asset-summary 段')
    check('CTX-SINGLE-OVERSIZE-01 asset-summary 段未放入内容（actualTokens=null）', asSeg !== undefined && asSeg.actualTokens === null, '')
  }

  // ==================== CTX-NODUP-02 ====================
  console.log('\n[CTX-NODUP-02] 同一 msgId 在 history 中只出现一次（实现按 msgId 去重，最新一条生效）')
  {
    const res = assembleContext(
      mkInput({
        runId: 'ctx-nodup-02',
        contextWindowTokens: 20000,
        outputReserveTokens: 2000,
        staticSystem: [{ role: 'system', content: REP('甲', 100) }],
        user: { msgId: 'u1', content: REP('乙', 20) },
        history: [
          { msgId: 'h1', role: 'user', content: 'AAA-唯一' },
          { msgId: 'h-dup', role: 'assistant', content: '旧重复内容' },
          { msgId: 'h-dup', role: 'assistant', content: '新重复内容' },
          { msgId: 'h2', role: 'user', content: 'BBB-唯一' }
        ]
      })
    )
    const historyMsgs = res.messages.filter((msg) => msg.content.includes('重复') || msg.content === 'AAA-唯一' || msg.content === 'BBB-唯一')
    check('CTX-NODUP-02 重复 msgId 的最新 content 只出现一次', historyMsgs.filter((m) => m.content === '新重复内容').length === 1, '')
    check('CTX-NODUP-02 被去重的旧 content 不再出现', historyMsgs.filter((m) => m.content === '旧重复内容').length === 0, '')
    check('CTX-NODUP-02 去重后 history 共放入 3 条', historyMsgs.length === 3, `实际=${historyMsgs.length}`)
    const hSeg = res.manifest.segments.find((s) => s.kind === 'history')
    check('CTX-NODUP-02 history 段 sourceIds 无重复 msgId', hSeg !== undefined && new Set(hSeg.sourceIds).size === hSeg.sourceIds.length, hSeg ? JSON.stringify(hSeg.sourceIds) : '无 history 段')
  }

  // ==================== CTX-MANIFEST-01 ====================
  console.log('\n[CTX-MANIFEST-01] manifest 结构完整性：段序列/每段字段/hash/缓存标记/version 透传/overBudget')
  {
    const res = assembleContext(
      mkInput({
        runId: 'ctx-manifest-01',
        round: 7,
        contextWindowTokens: 20000,
        outputReserveTokens: 2000,
        staticSystem: [{ role: 'system', content: REP('甲', 500) }],
        memory: [{ role: 'system', content: REP('乙', 200) }],
        attachments: [{ role: 'user', content: REP('丙', 100) }],
        user: { msgId: 'u1', content: REP('丁', 50) },
        toolResults: [{ sourceId: 't1', content: REP('戊', 80) }],
        assetSummaries: [{ assetHash: 'a1', summary: REP('己', 60) }],
        history: [
          { msgId: 'h1', role: 'user', content: REP('庚', 40) },
          { msgId: 'h2', role: 'assistant', content: REP('庚', 40) }
        ],
        summary: { text: REP('辛', 30), version: 3 }
      })
    )
    const m: ContextManifest = res.manifest
    check('CTX-MANIFEST-01 schemaVersion=1', m.schemaVersion === 1, String(m.schemaVersion))
    check('CTX-MANIFEST-01 runId/round/createdAt 透传', m.runId === 'ctx-manifest-01' && m.round === 7 && typeof m.createdAt === 'number', '')
    check(
      'CTX-MANIFEST-01 budgetTokens = contextWindowTokens - outputReserveTokens',
      m.budgetTokens === 18000 && m.contextWindowTokens === 20000 && m.outputReserveTokens === 2000,
      JSON.stringify({ budget: m.budgetTokens, ctx: m.contextWindowTokens, reserve: m.outputReserveTokens })
    )
    const kinds = m.segments.map((s) => s.kind)
    const expectedKinds = ['static-system', 'memory', 'summary', 'history', 'attachments', 'tool-result', 'asset-summary', 'user', 'output-reserve']
    check('CTX-MANIFEST-01 segments 按优先级顺序包含全部 9 段', JSON.stringify(kinds) === JSON.stringify(expectedKinds), JSON.stringify(kinds))
    const segFieldsOk = m.segments.every(
      (s) =>
        typeof s.id === 'string' &&
        s.id.length > 0 &&
        typeof s.estimatedTokens === 'number' &&
        s.estimatedTokens >= 0 &&
        (s.actualTokens === null || typeof s.actualTokens === 'number') &&
        (s.droppedReason === null || typeof s.droppedReason === 'string') &&
        (s.summaryVersion === null || typeof s.summaryVersion === 'number') &&
        /^[0-9a-f]{64}$/.test(s.hash) &&
        typeof s.cacheable === 'boolean'
    )
    check('CTX-MANIFEST-01 每段 estimatedTokens/actualTokens/droppedReason/hash/cacheable 字段完整', segFieldsOk, '')
    const cacheableOf = (kind: string): boolean | undefined => m.segments.find((s) => s.kind === kind)?.cacheable
    check(
      'CTX-MANIFEST-01 cacheable：static-system/memory/history/summary=true',
      cacheableOf('static-system') === true && cacheableOf('memory') === true && cacheableOf('history') === true && cacheableOf('summary') === true,
      ''
    )
    check(
      'CTX-MANIFEST-01 cacheable：attachments/user/tool-result/output-reserve=false',
      cacheableOf('attachments') === false && cacheableOf('user') === false && cacheableOf('tool-result') === false && cacheableOf('output-reserve') === false,
      ''
    )
    const reserveSeg = m.segments.find((s) => s.kind === 'output-reserve')
    check(
      'CTX-MANIFEST-01 output-reserve 占位段（estimated=2000/hash=sha256("reserve")/sourceIds=[]/cacheable=false）',
      reserveSeg !== undefined && reserveSeg.estimatedTokens === 2000 && reserveSeg.hash === sha256hex('reserve') && reserveSeg.sourceIds.length === 0 && reserveSeg.cacheable === false && reserveSeg.actualTokens === null,
      JSON.stringify(reserveSeg)
    )
    const sumSeg = m.segments.find((s) => s.kind === 'summary')
    check('CTX-MANIFEST-01 summary 段 summaryVersion=3 透传', sumSeg !== undefined && sumSeg.summaryVersion === 3, `version=${sumSeg?.summaryVersion}`)
    const uSeg = m.segments.find((s) => s.kind === 'user')
    const trSeg = m.segments.find((s) => s.kind === 'tool-result')
    const asSeg = m.segments.find((s) => s.kind === 'asset-summary')
    const hSeg = m.segments.find((s) => s.kind === 'history')
    check(
      'CTX-MANIFEST-01 user/tool-result/asset-summary/history sourceIds 透传',
      JSON.stringify(uSeg?.sourceIds) === JSON.stringify(['u1']) &&
        JSON.stringify(trSeg?.sourceIds) === JSON.stringify(['t1']) &&
        JSON.stringify(asSeg?.sourceIds) === JSON.stringify(['a1']) &&
        JSON.stringify(hSeg?.sourceIds) === JSON.stringify(['h1', 'h2']),
      JSON.stringify({ u: uSeg?.sourceIds, t: trSeg?.sourceIds, a: asSeg?.sourceIds, h: hSeg?.sourceIds })
    )
    const promptConcat = res.messages.map((msg) => msg.content).join('')
    check('CTX-MANIFEST-01 promptHash = sha256(全部最终消息 content 拼接)', m.promptHash === sha256hex(promptConcat), '')
    check(
      'CTX-MANIFEST-01 cacheablePrefixHash = sha256(system 区+history 连续可缓存前缀，R4.3 新顺序)',
      m.cacheablePrefixHash === sha256hex(res.messages.slice(0, 5).map((mm) => mm.content).join('')),
      `actual=${m.cacheablePrefixHash}`
    )
    const recomputedTotal = res.messages.reduce((a, msg) => a + estimateTokens(msg.content), 0)
    check('CTX-MANIFEST-01 totalTokens = 最终消息 estimateTokens 之和', m.totalTokens === recomputedTotal, `manifest=${m.totalTokens} recomputed=${recomputedTotal}`)
    check('CTX-MANIFEST-01 overBudget=false（totalTokens <= budgetTokens）', m.overBudget === false && m.totalTokens <= m.budgetTokens, `over=${m.overBudget} total=${m.totalTokens} budget=${m.budgetTokens}`)
    const orderContents = res.messages.map((msg) => msg.content)
    const expectedOrder = [
      REP('甲', 500),
      REP('乙', 200),
      `## 会话摘要（v3）
${REP('辛', 30)}`,
      REP('庚', 40),
      REP('庚', 40),
      REP('丙', 100),
      `[工具结果 t1]
${REP('戊', 80)}`,
      `[资产摘要 a1]
${REP('己', 60)}`,
      REP('丁', 50)
    ]
    check(
      'CTX-MANIFEST-01 messages 组装顺序（R4.3：system区→summary→history正序→attachments→toolResult→assetSummary→user最后）',
      JSON.stringify(orderContents) === JSON.stringify(expectedOrder),
      ''
    )
    check('CTX-MANIFEST-01 user 段 hash = sha256(最终 content)', uSeg !== undefined && uSeg.hash === sha256hex(REP('丁', 50)), '')
  }


  // ==================== R4.3 Gate 1：provider 消息语义（B-01 修复后新增） ====================
  console.log('\n[R4.3-G1] CTX-ORDER-01 / CTX-TOOL-PAIR-01 / CTX-CURRENT-LAST-01')
  {
    // CTX-ORDER-01：多轮历史保持时间正序（oldest→newest），当前 user 最后，summary 在 system 区
    const res = assembleContext(
      mkInput({
        runId: 'ctx-order-01',
        contextWindowTokens: 20000,
        outputReserveTokens: 2000,
        staticSystem: [{ role: 'system', content: 'SYS' }],
        memory: [{ role: 'system', content: 'MEM' }],
        user: { msgId: 'u-now', content: '当前消息' },
        history: [
          { msgId: 'h1', role: 'user', content: '第1轮用户' },
          { msgId: 'h2', role: 'assistant', content: '第1轮助手' },
          { msgId: 'h3', role: 'user', content: '第2轮用户' },
          { msgId: 'h4', role: 'assistant', content: '第2轮助手' }
        ],
        summary: { text: '摘要内容', version: 1 }
      })
    )
    const contents = res.messages.map((m) => m.content)
    check('CTX-ORDER-01 summary 位于 system 区（memory 之后、历史之前）', contents[0] === 'SYS' && contents[1] === 'MEM' && contents[2].startsWith('## 会话摘要'), JSON.stringify(contents))
    const hIdx = contents.findIndex((c) => c === '第1轮用户')
    check('CTX-ORDER-01 历史时间正序（h1→h2→h3→h4 连续且顺序正确）',
      contents.slice(hIdx, hIdx + 4).join('|') === ['第1轮用户', '第1轮助手', '第2轮用户', '第2轮助手'].join('|'), JSON.stringify(contents.slice(hIdx, hIdx + 4)))
    check('CTX-ORDER-01 当前 user 是最后一个待回答 user turn', contents[contents.length - 1] === '当前消息', JSON.stringify(contents))
    check('CTX-ORDER-01 消息顺序无倒序历史', contents.indexOf('第1轮用户') < contents.indexOf('第2轮用户'), '')
  }
  {
    // CTX-TOOL-PAIR-01：tool_call 与其 tool result 原子组（相邻、不拆散）
    const res = assembleContext(
      mkInput({
        runId: 'ctx-tool-pair-01',
        contextWindowTokens: 20000,
        outputReserveTokens: 2000,
        staticSystem: [{ role: 'system', content: 'SYS' }],
        user: { msgId: 'u-now', content: '当前消息' },
        history: [
          { msgId: 'h1', role: 'user', content: '给我查一下' },
          { msgId: 'h2', role: 'assistant', content: '' },
          { msgId: 'h3', role: 'tool', content: '工具结果内容', toolCallId: 'tc-1' }
        ]
      })
    )
    const contents = res.messages.map((m) => m.content)
    const toolCallIdx = contents.indexOf('')
    check('CTX-TOOL-PAIR-01 tool_call 与 tool result 相邻（原子组不拆散）', toolCallIdx >= 0 && contents[toolCallIdx + 1] === '工具结果内容', JSON.stringify(contents))
    check('CTX-TOOL-PAIR-01 原子组顺序：assistant(tool_calls) → tool result', contents[toolCallIdx] === '' && contents[toolCallIdx + 1] === '工具结果内容', '')
  }
  {
    // CTX-TOOL-PAIR-01b：原子组超预算 → 整组 drop（绝不拆散）
    const res = assembleContext(
      mkInput({
        runId: 'ctx-tool-pair-01b',
        contextWindowTokens: 3000,
        outputReserveTokens: 500,
        staticSystem: [{ role: 'system', content: REP('甲', 2000) }],
        user: { msgId: 'u-now', content: REP('乙', 200) },
        history: [
          { msgId: 'h1', role: 'assistant', content: 'call' },
          { msgId: 'h2', role: 'tool', content: REP('丙', 2000), toolCallId: 'tc-x' }
        ]
      })
    )
    const contents = res.messages.map((m) => m.content)
    check('CTX-TOOL-PAIR-01b 原子组超预算整组 drop（不拆散 tool transcript）', !contents.includes('call') && !contents.some((c) => c.includes('丙')), JSON.stringify(contents))
    const hSeg = res.manifest.segments.find((s) => s.kind === 'history')
    check('CTX-TOOL-PAIR-01b 整组 drop 后 history 段 droppedReason=budget', hSeg !== undefined && hSeg.droppedReason === 'budget', `reason=${hSeg?.droppedReason}`)
  }
  {
    // CTX-CURRENT-LAST-01：当前用户必须在最后（budget 紧张时历史可裁、user 不可丢）
    const res = assembleContext(
      mkInput({
        runId: 'ctx-current-last-01',
        contextWindowTokens: 5000,
        outputReserveTokens: 500,
        staticSystem: [{ role: 'system', content: REP('甲', 2000) }],
        user: { msgId: 'u-now', content: REP('乙', 800) },
        history: [{ msgId: 'h1', role: 'user', content: REP('丙', 20000) }]
      })
    )
    const contents = res.messages.map((m) => m.content)
    check('CTX-CURRENT-LAST-01 当前 user 仍在最后（即使历史被裁）', contents[contents.length - 1] === REP('乙', 800), JSON.stringify(contents.map((c) => c.slice(0, 6))))
    const historyMsg = contents.find((c) => c.includes('丙'))
    check('CTX-CURRENT-LAST-01 历史被截断（旧历史让位给当前 user，长度受控）', historyMsg !== undefined && historyMsg.length < 20000 && historyMsg.includes('[…已截断'), `len=${historyMsg?.length ?? 0}`)
    check('CTX-CURRENT-LAST-01 总预算不超', res.manifest.totalTokens <= res.manifest.budgetTokens, `total=${res.manifest.totalTokens}`)
  }

  console.log(`\n===== R4.2 Task A5 contextAssembler：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('失败明细：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.2 Task A5 测试执行异常：', e)
  process.exit(2)
})
