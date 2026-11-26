import { DsMessage, estimateTokens } from './deepseek'

export interface ContextBuildResult {
  messages: DsMessage[]
  dropped: number
  estimatedPromptTokens: number
  estimatedCacheHitTokens: number
  summary: string | null
}

export interface ContextConfig {
  historyBudgetTokens: number
  summarizeOld: boolean
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  historyBudgetTokens: 32000,
  summarizeOld: true
}

export function calcMessageTokens(msg: DsMessage): number {
  let t = estimateTokens(msg.content)
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      t += estimateTokens(tc.name + tc.arguments)
    }
  }
  return t
}

export function groupBundles(messages: DsMessage[]): DsMessage[][] {
  const bundles: DsMessage[][] = []
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'system') {
      bundles.push([m])
    } else {
      if (bundles.length === 0) bundles.push([])
      bundles[bundles.length - 1].push(m)
    }
  }
  return bundles
}

function bundleTokens(bundle: DsMessage[]): number {
  let t = 0
  for (const m of bundle) t += calcMessageTokens(m)
  return t
}

/**
 * Token 优化核心：
 * - fixedPrefix（system/剧情引擎/设定/摘要）置于最前，永不裁剪 → 命中 DeepSeek 上下文硬盘缓存（0.02元 vs 1元）
 * - 历史消息按预算裁剪，超出的旧消息可压缩为摘要置入前缀
 * - 估算并返回 prompt 与缓存命中 token 数
 */
export function buildContext(
  fixedPrefix: DsMessage[],
  history: DsMessage[],
  config: ContextConfig,
  summarize: (msgs: DsMessage[]) => Promise<string | null>
): Promise<ContextBuildResult> {
  return (async () => {
    let budget = config.historyBudgetTokens
    let summary: string | null = null

    if (config.summarizeOld && history.length > 20) {
      let total = 0
      for (const m of history) total += calcMessageTokens(m)
      if (total > budget * 1.5) {
        const dropThreshold = Math.floor(total * 0.5)
        const sourceBundles = groupBundles(history)
        let acc = 0
        const dropBundles: DsMessage[][] = []
        const keptBundles: DsMessage[][] = []
        for (const b of sourceBundles) {
          if (acc < dropThreshold) {
            dropBundles.push(b)
            acc += bundleTokens(b)
          } else {
            keptBundles.push(b)
          }
        }
        if (keptBundles.length === 0) {
          const newest = dropBundles.pop()
          if (newest) keptBundles.unshift(newest)
        }
        const dropMsgs = dropBundles.flat()
        if (dropMsgs.length >= 2) {
          try {
            summary = await summarize(dropMsgs)
          } catch {
            summary = null
          }
          // C3：摘要失败（抛错/空串/null）不得丢弃历史——回退为不裁剪，保留全部历史继续。
          if (summary && summary.trim()) {
            history = keptBundles.flat()
            budget -= estimateTokens(summary)
          }
        }
      }
    }

    const historyBundles = groupBundles(history)
    let used = 0
    const keptHistory: DsMessage[] = []
    for (let i = historyBundles.length - 1; i >= 0; i--) {
      const t = bundleTokens(historyBundles[i])
      if (used + t > budget && keptHistory.length > 0) break
      keptHistory.unshift(...historyBundles[i])
      used += t
    }
    const dropped = history.length - keptHistory.length

    const messages: DsMessage[] = [...fixedPrefix]
    if (summary) {
      messages.push({ role: 'system', content: `## 之前对话的摘要（作为压缩记忆，直接引用，不要向用户提及此摘要）\n${summary}` })
    }
    messages.push(...keptHistory)

    const estimatedPromptTokens = messages.reduce((acc, m) => acc + calcMessageTokens(m), 0)
    const fixedTokens = fixedPrefix.reduce((acc, m) => acc + calcMessageTokens(m), 0)
    const summaryTokens = summary ? estimateTokens(summary) + 30 : 0

    return {
      messages,
      dropped,
      estimatedPromptTokens,
      estimatedCacheHitTokens: fixedTokens + summaryTokens,
      summary
    }
  })()
}
