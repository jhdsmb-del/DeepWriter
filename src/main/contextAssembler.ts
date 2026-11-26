// ==================== R4.2 A5：ContextAssembler（R4.3 Gate 1 语义修复 v2） ====================
// - 硬预算：contextWindowTokens - outputReserveTokens；system/memory/附件/user/工具结果/历史/摘要全部计入；
// - 选择阶段：按优先级 + 预算决定保留哪些内容（预算分配顺序：static-system → memory → attachments →
//   当前 user → 必需工具结果 → 资产摘要 → 最近历史 → 旧摘要，摘要最可牺牲）；每段保留候选/实际统计；
// - 排序阶段：按对话语义序列化（R4.3 B-01 修复，选择与排序分离）：
//     system 区（staticSystem → memory → summary）
//     → 历史区（时间正序；tool call 与 tool result 作为不可拆原子组）
//     → 当前请求上下文（attachments → toolResults → assetSummaries）
//     → 当前用户（最后一个待回答 user turn）
// - 单条超限：截断（带标记）或 drop；绝不因 selectedHistory 为空而原样放入；按 msgId 去重；
// - 产出 immutable context_manifest：段名/source ids/estimated（候选）/actual（放入）/dropped reason/hash/cacheable。

import { createHash } from 'node:crypto'
import { estimateTokens, type DsMessage } from '../shared/types'

export type ManifestSegmentKind =
  | 'static-system' | 'memory' | 'attachments' | 'user' | 'tool-result' | 'asset-summary' | 'history' | 'summary' | 'output-reserve' | 'live'

export interface ManifestSegment {
  id: string
  kind: ManifestSegmentKind
  sourceIds: string[]
  estimatedTokens: number
  actualTokens: number | null
  droppedReason: string | null
  summaryVersion: number | null
  hash: string
  cacheable: boolean
}

export interface ContextManifest {
  schemaVersion: number
  runId: string
  round: number
  createdAt: number
  totalTokens: number
  budgetTokens: number
  contextWindowTokens: number
  outputReserveTokens: number
  promptHash: string
  cacheablePrefixHash: string
  overBudget: boolean
  segments: ManifestSegment[]
}

export interface HistoryItem {
  msgId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  /** R4.3 Gate 1：tool 消息所属的 tool_call id（原子组绑定） */
  toolCallId?: string
}

export interface AssembleInput {
  runId: string
  round: number
  contextWindowTokens: number
  outputReserveTokens: number
  staticSystem: DsMessage[]
  memory: DsMessage[]
  attachments: DsMessage[]
  user: { msgId: string; content: string } | null
  history: HistoryItem[]
  toolResults: Array<{ sourceId: string; content: string }>
  assetSummaries: Array<{ assetHash: string; summary: string }>
  summary?: { text: string; version: number }
}

/** 截断标记：计入 token 估算（不允许超限文本原样占满预算） */
const TRUNCATED_MARKER = '\n[…已截断：上下文预算不足]'

function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 在 content 上二分查找最大前缀，使 estimateTokens(前缀 + 截断标记) <= budget；
 * 连空前缀+标记都放不下时返回 null。
 */
function truncateToBudget(content: string, budget: number): string | null {
  if (budget <= 0) return null
  if (estimateTokens(TRUNCATED_MARKER) > budget) return null
  let lo = 0
  let hi = content.length
  let best = -1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (estimateTokens(content.slice(0, mid) + TRUNCATED_MARKER) <= budget) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (best < 0) return null
  return content.slice(0, best) + TRUNCATED_MARKER
}

/** 段组装内部累加器（estimated=候选总估算，actual=最终放入） */
interface SegmentAcc {
  kind: ManifestSegmentKind
  cacheable: boolean
  estimated: number
  actual: number
  contents: string[]
  sourceIds: string[]
  droppedReason: string | null
  summaryVersion: number | null
  droppedCount: number
}

function newSeg(kind: ManifestSegmentKind, cacheable: boolean): SegmentAcc {
  return {
    kind,
    cacheable,
    estimated: 0,
    actual: 0,
    contents: [],
    sourceIds: [],
    droppedReason: null,
    summaryVersion: null,
    droppedCount: 0
  }
}

function finishSeg(acc: SegmentAcc, id: string): ManifestSegment {
  return {
    id,
    kind: acc.kind,
    sourceIds: acc.sourceIds,
    estimatedTokens: acc.estimated,
    actualTokens: acc.contents.length > 0 ? acc.actual : null,
    droppedReason: acc.droppedReason,
    summaryVersion: acc.summaryVersion,
    hash: sha256hex(acc.contents.join('')),
    cacheable: acc.cacheable
  }
}

/** 选择阶段产出的内容项（尚未决定最终顺序） */
interface SelectedItem {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  sourceId?: string
}

/** R4.3 Gate 1：history 原子组——assistant 消息与其 tool 结果们不可拆（要么全选要么整组 drop） */
interface HistoryGroup {
  index: number
  items: HistoryItem[]
  tokens: number
  isToolGroup: boolean
  /** assistant 起始组（可能被后续 tool 消息升级为原子组） */
  isAssistant: boolean
}

export function assembleContext(input: AssembleInput): { messages: DsMessage[]; manifest: ContextManifest } {
  const budget = input.contextWindowTokens - input.outputReserveTokens
  if (budget <= 0) {
    throw new Error(
      `上下文预算不足：contextWindowTokens=${input.contextWindowTokens} 减去 outputReserveTokens=${input.outputReserveTokens} 后预算为 ${budget}，无法组装上下文（fail-closed）`
    )
  }

  // ============ 阶段一：选择（预算分配 + 内容挑选，每段独立统计） ============
  const chosen: {
    staticSystem: SelectedItem[]
    memory: SelectedItem[]
    summary: SelectedItem[]
    history: SelectedItem[]
    attachments: SelectedItem[]
    toolResults: SelectedItem[]
    assetSummaries: SelectedItem[]
    user: SelectedItem[]
  } = { staticSystem: [], memory: [], summary: [], history: [], attachments: [], toolResults: [], assetSummaries: [], user: [] }
  let remaining = budget
  /** 段统计按选择顺序收集，排序阶段按消息顺序重排 */
  const segAccs: SegmentAcc[] = []

  const take = (key: keyof typeof chosen, role: SelectedItem['role'], content: string, sourceId: string | undefined): number => {
    chosen[key].push({ role, content, sourceId })
    return estimateTokens(content)
  }

  // 1) static-system（必放，可缓存；单独超预算 fail-closed）
  if (input.staticSystem.length > 0) {
    const seg = newSeg('static-system', true)
    for (const m of input.staticSystem) seg.estimated += estimateTokens(m.content)
    if (seg.estimated > budget) {
      throw new Error(`静态系统段超出上下文预算：需 ${seg.estimated} token，预算仅 ${budget} token（fail-closed，系统提示不可裁剪）`)
    }
    for (const m of input.staticSystem) {
      const t = take('staticSystem', 'system', m.content, undefined)
      seg.actual += t
      seg.contents.push(m.content)
      remaining -= t
    }
    segAccs.push(seg)
  }

  // 2) memory（可缓存，全量放入）
  if (input.memory.length > 0) {
    const seg = newSeg('memory', true)
    for (const m of input.memory) {
      seg.estimated += estimateTokens(m.content)
      const t = take('memory', 'system', m.content, undefined)
      seg.actual += t
      seg.contents.push(m.content)
      remaining -= t
    }
    segAccs.push(seg)
  }

  // 3) attachments（round 1 才有；不可缓存；全量放入——排序阶段置于 user 之前）
  if (input.attachments.length > 0) {
    const seg = newSeg('attachments', false)
    for (const m of input.attachments) {
      seg.estimated += estimateTokens(m.content)
      const t = take('attachments', 'user', m.content, undefined)
      seg.actual += t
      seg.contents.push(m.content)
      remaining -= t
    }
    segAccs.push(seg)
  }

  // 4) user（必放；单独超剩余预算 fail-closed）
  if (input.user) {
    const seg = newSeg('user', false)
    seg.estimated = estimateTokens(input.user.content)
    if (seg.estimated > remaining) {
      throw new Error(
        `当前用户消息超出剩余上下文预算：需 ${seg.estimated} token，剩余预算仅 ${remaining} token（fail-closed，用户消息不可丢弃）`
      )
    }
    const t = take('user', 'user', input.user.content, input.user.msgId)
    seg.actual = t
    seg.contents.push(input.user.content)
    seg.sourceIds.push(input.user.msgId)
    remaining -= t
    segAccs.push(seg)
  }

  // 5) toolResults（逐条贪心，单条超剩余预算整条 drop）
  if (input.toolResults.length > 0) {
    const seg = newSeg('tool-result', false)
    for (const tr of input.toolResults) {
      const content = `[工具结果 ${tr.sourceId}]\n${tr.content}`
      const est = estimateTokens(content)
      seg.estimated += est
      if (est <= remaining) {
        const t = take('toolResults', 'user', content, tr.sourceId)
        seg.actual += t
        seg.contents.push(content)
        seg.sourceIds.push(tr.sourceId)
        remaining -= t
      } else {
        seg.droppedCount++
        seg.droppedReason = 'budget'
      }
    }
    if (seg.droppedCount > 0 && seg.contents.length === 0 && seg.droppedReason === null) seg.droppedReason = 'budget'
    segAccs.push(seg)
  }

  // 6) assetSummaries（top-k：放得下就放）
  if (input.assetSummaries.length > 0) {
    const seg = newSeg('asset-summary', false)
    for (const as of input.assetSummaries) {
      const content = `[资产摘要 ${as.assetHash}]\n${as.summary}`
      const est = estimateTokens(content)
      seg.estimated += est
      if (est <= remaining) {
        const t = take('assetSummaries', 'user', content, as.assetHash)
        seg.actual += t
        seg.contents.push(content)
        seg.sourceIds.push(as.assetHash)
        remaining -= t
      } else {
        seg.droppedCount++
        seg.droppedReason = 'budget'
      }
    }
    if (seg.droppedCount > 0 && seg.contents.length === 0 && seg.droppedReason === null) seg.droppedReason = 'budget'
    segAccs.push(seg)
  }

  // 7) history（可缓存；msgId 去重；原子组；挑选 newest-first、序列化按原始时间正序）
  if (input.history.length > 0) {
    const seg = newSeg('history', true)
    // 7a) 分组：assistant 与其 tool 结果们成原子组（tool 消息加入前一 assistant 组并升级为不可拆）；
    //     user 独立成组；普通 assistant（无 tool 结果）不是原子组（可截断）
    const groups: HistoryGroup[] = []
    let cur: HistoryGroup | null = null
    input.history.forEach((item, idx) => {
      if (item.role === 'tool') {
        if (cur && (cur.isToolGroup || cur.isAssistant)) {
          cur.items.push(item)
          cur.tokens += estimateTokens(item.content)
          cur.isToolGroup = true
        } else {
          cur = { index: idx, items: [item], tokens: estimateTokens(item.content), isToolGroup: true, isAssistant: false }
          groups.push(cur)
        }
        return
      }
      if (item.role === 'assistant') {
        cur = { index: idx, items: [item], tokens: estimateTokens(item.content), isToolGroup: false, isAssistant: true }
        groups.push(cur)
        return
      }
      cur = { index: idx, items: [item], tokens: estimateTokens(item.content), isToolGroup: false, isAssistant: false }
      groups.push(cur)
    })
    // 7b) 选择：newest-first；组级去重（组内任一 msgId 已见 → 整组跳过）；
    //     单消息组超预算可截断；tool 原子组超预算整组 drop
    const selectedGroups = new Map<number, string[]>() // groupIndex → 最终内容（可能截断）
    const seenMsg = new Set<string>()
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i]
      if (g.items.some((it) => seenMsg.has(it.msgId))) continue
      for (const it of g.items) seenMsg.add(it.msgId)
      seg.estimated += g.tokens
      if (g.tokens <= remaining) {
        selectedGroups.set(i, g.items.map((it) => it.content))
        seg.actual += g.tokens
        remaining -= g.tokens
      } else if (g.isToolGroup) {
        // 原子组超预算：整组 drop（绝不拆散 tool transcript）
        seg.droppedCount++
        seg.droppedReason = 'budget'
      } else if (remaining > 0) {
        // 单条 user/assistant 超预算 → 截断到预算内（保持时间位置）
        const item = g.items[0]
        const truncated = truncateToBudget(item.content, remaining)
        if (truncated !== null) {
          selectedGroups.set(i, [truncated])
          const t = estimateTokens(truncated)
          seg.actual += t
          seg.contents.push(truncated)
          remaining -= t
          seg.droppedReason = 'truncated-budget'
        } else {
          seg.droppedCount++
        }
      } else {
        seg.droppedCount++
      }
    }
    if (seg.contents.length === 0) {
      seg.droppedReason = 'budget'
    } else if (seg.droppedCount > 0 && seg.droppedReason === null) {
      seg.droppedReason = 'budget'
    }
    // 7c) 序列化：按原始 index 升序（时间正序），组内保持消息顺序（tool 结果紧跟其 tool_call）
    const orderedIdx = [...selectedGroups.keys()].sort((a, b) => groups[a].index - groups[b].index)
    for (const gi of orderedIdx) {
      const finals = selectedGroups.get(gi) ?? []
      const items = groups[gi].items
      for (let k = 0; k < items.length; k++) {
        const content = finals[k] ?? items[k].content
        const it = items[k]
        chosen.history.push({ role: it.role, content, sourceId: it.msgId })
        seg.contents.push(content)
        seg.sourceIds.push(it.msgId)
      }
    }
    segAccs.push(seg)
  }

  // 8) summary（可缓存；归 system 区；最低优先级——剩余预算放得下才放）
  if (input.summary) {
    const seg = newSeg('summary', true)
    const content = `## 会话摘要（v${input.summary.version}）\n${input.summary.text}`
    seg.estimated = estimateTokens(content)
    seg.summaryVersion = input.summary.version
    if (seg.estimated <= remaining) {
      const t = take('summary', 'system', content, undefined)
      seg.actual = t
      seg.contents.push(content)
      remaining -= t
    } else {
      seg.droppedReason = 'budget'
    }
    segAccs.push(seg)
  }

  // ============ 阶段二：排序（对话语义序列化，R4.3 B-01） ============
  // system 区（含摘要）→ 历史区（时间正序）→ 当前请求上下文（附件/工具结果/资产摘要）→ 当前用户（最后）
  const ordered: SelectedItem[] = [
    ...chosen.staticSystem,
    ...chosen.memory,
    ...chosen.summary,
    ...chosen.history,
    ...chosen.attachments,
    ...chosen.toolResults,
    ...chosen.assetSummaries,
    ...chosen.user
  ]
  const messages: DsMessage[] = ordered.map((it) => ({ role: it.role, content: it.content }))

  // ============ manifest（段按消息顺序重排；统计来自选择阶段） ============
  const totalTokens = messages.reduce((a, m) => a + estimateTokens(m.content), 0)
  const promptHash = sha256hex(messages.map((m) => m.content).join(''))

  // cacheablePrefixHash：最终消息序列中可缓存段的连续前缀
  // （新顺序下 system 区 + 历史区连续可缓存，attachments 处断开）
  const prefixParts: string[] = []
  for (const it of ordered) {
    const isCacheable =
      chosen.staticSystem.includes(it) || chosen.memory.includes(it) || chosen.summary.includes(it) || chosen.history.includes(it)
    if (!isCacheable) break
    prefixParts.push(it.content)
  }
  const cacheablePrefixHash = sha256hex(prefixParts.join(''))

  // 段顺序映射（消息顺序）：static-system → memory → summary → history → attachments → tool-result → asset-summary → user
  const orderByKind: ManifestSegmentKind[] = ['static-system', 'memory', 'summary', 'history', 'attachments', 'tool-result', 'asset-summary', 'user']
  const segments: ManifestSegment[] = orderByKind
    .map((kind) => segAccs.find((s) => s.kind === kind))
    .filter((s): s is SegmentAcc => s !== undefined)
    .map((s) => finishSeg(s, s.kind))
  // output-reserve 占位段：只记账不占消息，置于段序列末尾
  segments.push({
    id: 'output-reserve',
    kind: 'output-reserve',
    sourceIds: [],
    estimatedTokens: input.outputReserveTokens,
    actualTokens: null,
    droppedReason: null,
    summaryVersion: null,
    hash: sha256hex('reserve'),
    cacheable: false
  })

  return {
    messages,
    manifest: {
      schemaVersion: 1,
      runId: input.runId,
      round: input.round,
      createdAt: Date.now(),
      totalTokens,
      budgetTokens: budget,
      contextWindowTokens: input.contextWindowTokens,
      outputReserveTokens: input.outputReserveTokens,
      promptHash,
      cacheablePrefixHash,
      overBudget: totalTokens > budget,
      segments
    }
  }
}
