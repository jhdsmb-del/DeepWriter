// ==================== R23-R01 / Codex：canonical terminal assistant 投影 ====================
// 生产侧 terminal 事件把「run 全部 assistant 正文」同步投影进 canonical session 消息，
// 使 UI 显示完成时即便立即退出也不丢回复。本模块是唯一权威实现（零复制），
// 生产 index.ts 与 eval 侧（electron-shim 动态编译 src/main）共用同一函数。
//
// R24 P0-02：投影正文从「最后一轮 assistant」升级为「按 turn 顺序累计全部 assistant 正文」，
// 与 CompletionController/AgentRunEngine.tryCompletionGate 的 measuredChars 累计口径对齐——
// 多轮成功样本（A+B+C）完成契约按累计正文计字，投影正文也必须等于 A+B+C 的完整拼接，
// 否则 runner 完成时节字评分/持久化/hash 三者只取最后一轮，与完成契约的累计口径不一致。
//
// 约束：
//  - 严禁 import electron（本模块须可被 electron-shim bundle 直接加载）。
//  - 只依赖传入的 deps 接口，不直接触达 repository/窗口/引擎。
//  - seq 取「现有同 msg_id 消息的 seq」否则「现有消息 max(seq)+1」；严禁 existing.length+1
//    （seq 存在空洞时 length 计数会撞 seq，Codex 明确要求走 max+1）。
//  - appendSessionMessage 抛错必须 catch 并返回 { ok:false, reason }，绝不 console 后继续。

import { createHash } from "node:crypto"
import { codePointLength } from "../shared/textMetrics"

export interface TerminalTurn {
  role: string
  content: string
  reasoning_content?: string | null
  turn_seq?: number
}

/**
 * 组合一次 run 的全部 assistant turn 正文（共享、确定性、零 Electron 依赖）。
 *
 * content 拼接规则：按 turn_seq 升序（缺 turn_seq 时退化为数组顺序）取全部
 * role==='assistant' 且 content 非空的 turn，content 无分隔符直接相连——
 * 与 AgentRunEngine.tryCompletionGate 的 measuredChars 严格同口径：
 *   measuredChars = assistantTurns.reduce((a, t) => a + codePointLength(t.content), 0)
 * 无分隔符拼接后的 code point 数恰等于该累计值；不使用 UTF-16 string.length。
 *
 * reasoning 组合规则（R24 P0-02 明确要求说明，不得伪造对应关系）：多轮 reasoning_content
 * 非空的按 "\n" 换行拼接，顺序同 turn 顺序（即 content 拼接采用的同一 turn 顺序）。
 * 注意：本组合只是「顺序级联」，**不**对 reasoning 与 content 建立逐轮对应关系——reasoning 仅
 * 在同一 turn 内与 content 语义关联，跨轮级联不引入任何额外映射/对齐语义。
 *
 * turnChars: 每轮 content 的 Unicode code point 数；turnHashes: 每轮 content 的 sha256 hex。
 */
export function composeRunAssistantContent(
  turns: Array<{ role: string; content: string; reasoning_content?: string | null; turn_seq?: number }>
): { content: string; reasoning: string; turnCount: number; turnChars: number[]; turnHashes: string[] } {
  // 带 idx 复制后稳定排序：有 turn_seq 按 turn_seq 升序；缺 turn_seq 保持原数组相对顺序。
  const indexed = turns.map((t, idx) => ({ t, idx }))
  const ordered = indexed
    .filter(({ t }) => t.role === 'assistant' && t.content)
    .sort((a, b) => {
      const sa = a.t.turn_seq
      const sb = b.t.turn_seq
      if (sa !== undefined && sb !== undefined) return sa - sb
      return a.idx - b.idx
    })

  let content = ''
  const reasoningParts: string[] = []
  const turnChars: number[] = []
  const turnHashes: string[] = []
  for (const { t } of ordered) {
    content += t.content
    if (t.reasoning_content) reasoningParts.push(t.reasoning_content)
    turnChars.push(codePointLength(t.content))
    turnHashes.push(createHash("sha256").update(t.content).digest("hex"))
  }
  const reasoning = reasoningParts.join("\n")
  return { content, reasoning, turnCount: ordered.length, turnChars, turnHashes }
}

export interface SessionMessageRef {
  msg_id: string
  seq: number
}

export interface TerminalProjectionDeps {
  getTurnsByRun(runId: string): Array<TerminalTurn>
  getSessionMessages(sessionId: string): Array<SessionMessageRef>
  appendSessionMessage(msg: Record<string, unknown>): void
  touchSession?(sessionId: string): void
  /** Completed delivery's existing content-addressed object, not an arbitrary
   * document path. Read once at terminal; session loads use the saved message. */
  getDeliveredManuscript?(runId: string): { content: string; hash: string; charCount: number } | null
}

export interface TerminalProjectionResult {
  ok: boolean
  projected: boolean
  msgId?: string
  reason?: string
}

/**
 * 从 run turns 中累计全部 assistant 正文（composeRunAssistantContent）投影进 session。
 * - 无 assistant turn（或 content 全空）：{ ok:true, projected:false }（无内容不算失败）。
 * - 有内容：msg_id = `m_${runId}_assistant`；seq 幂等复用同 msg_id 的 seq，否则 max(seq)+1。
 * - status = runStatus === 'completed' ? 'done' : 'stopped'。
 * - reasoning = composed reasoning（多轮 reasoning_content 换行级联）。
 * - completed 若有已交付稿件对象，校验其身份后使用实际交付内容；turn 字数和证据不改。
 * - appendSessionMessage 抛错 → { ok:false, reason: String(err) }。
 */
export function projectTerminalAssistant(
  deps: TerminalProjectionDeps,
  runId: string,
  sessionId: string,
  runStatus: string
): TerminalProjectionResult {
  try {
    const turns = deps.getTurnsByRun(runId)
    const composed = composeRunAssistantContent(turns)
    if (composed.turnCount === 0) {
      return { ok: true, projected: false }
    }
    const delivered = runStatus === 'completed' ? deps.getDeliveredManuscript?.(runId) : null
    if (delivered) {
      if (!/^[0-9a-f]{64}$/u.test(delivered.hash) || createHash('sha256').update(delivered.content).digest('hex') !== delivered.hash || codePointLength(delivered.content) !== delivered.charCount) {
        throw new Error('terminal_manuscript_artifact_content_mismatch')
      }
      composed.content = delivered.content
    }

    const msgId = `m_${runId}_assistant`
    const existing = deps.getSessionMessages(sessionId)
    const mine = existing.find((m) => m.msg_id === msgId)

    let seq: number
    if (mine) {
      seq = mine.seq
    } else {
      let maxSeq = 0
      for (const m of existing) {
        if (m.seq > maxSeq) maxSeq = m.seq
      }
      seq = maxSeq + 1
    }

    const status = runStatus === 'completed' ? 'done' : 'stopped'

    try {
      deps.appendSessionMessage({
        msg_id: msgId,
        session_id: sessionId,
        seq,
        role: 'assistant',
        content: composed.content,
        reasoning: composed.reasoning,
        status,
        created_at: Date.now()
      })
      deps.touchSession?.(sessionId)
      return { ok: true, projected: true, msgId }
    } catch (err) {
      return { ok: false, projected: false, reason: String(err) }
    }
  } catch (err) {
    return { ok: false, projected: false, reason: String(err) }
  }
}
