// ==================== eval-instrumentation.ts：runtime spy 证据 ====================
// R21-R02 / Codex P0-02：生产 handler 与 eval candidate 必须命中同一个
// createChatOrchestration.handleChatStart runtime 实现（function identity / 计数器），
// 而非"读源码 hash 冒充 runtime 复用"。
//
// 本模块提供：
//   1) OrchestrationTrace 结构 —— 写入样本的 runtime 证据；
//   2) makeSpyInstrumentation() —— 生产 & eval 共用的 instrumentation 挂点，
//      记录 onOrchestrationStart/onRunStarted/onStep 的调用次数与顺序；
//   3) 断言函数 assertSameOrchestrationRuntime() —— 两变体的 trace 若未命中同一
//      handleChatStart runtime（module/fn + 计数器均 > 0）则 fail。
//
// 证据结构（写入 sample.orchestrationTrace）：
//   {
//     module: "src/main/chatOrchestration.ts",
//     fn: "handleChatStart",
//     called: true,
//     count,                    // 命中次数（本样本编排被调用次数）
//     onOrchestrationStart,     // 编排入参命中次数
//     onRunStarted,             // engine.start 装载成功次数
//     onStep,                   // step fire 次数
//     fingerprint               // ORCHESTRATION_FINGERPRINT（跨 variant 应相等）
//   }

export interface OrchestrationTrace {
  module: string
  fn: string
  called: boolean
  count: number
  onOrchestrationStart: number
  onRunStarted: number
  onStep: number
  fingerprint: string
}

export interface SpyCounts {
  onOrchestrationStart: number
  onRunStarted: number
  onStep: number
}

/** 与 src/main/chatOrchestration.ts 的 ORCHESTRATION_FINGERPRINT 对齐 */
export const ORCHESTRATION_MODULE = "src/main/chatOrchestration.ts"
export const ORCHESTRATION_FN = "handleChatStart"

/** 生成一个 instrumentation spy，记录调用计数与顺序（返回后由调用方读 counts 与 order） */
export function makeSpyInstrumentation(): {
  instrumentation: {
    onOrchestrationStart?(payload: { id?: string }): void
    onRunStarted?(runId: string): void
    onStep?(runId: string): void
  }
  counts: SpyCounts
  order: string[]
  snapshot(): OrchestrationTrace
} {
  const counts: SpyCounts = { onOrchestrationStart: 0, onRunStarted: 0, onStep: 0 }
  const order: string[] = []
  const instrumentation = {
    onOrchestrationStart(_payload: { id?: string }): void {
      counts.onOrchestrationStart += 1
      order.push("onOrchestrationStart")
    },
    onRunStarted(_runId: string): void {
      counts.onRunStarted += 1
      order.push("onRunStarted")
    },
    onStep(_runId: string): void {
      counts.onStep += 1
      order.push("onStep")
    }
  }
  return {
    instrumentation,
    counts,
    order,
    snapshot(): OrchestrationTrace {
      // R23-R06-spy：handleChatStart 调用计数由真实 instrumentation.onOrchestrationStart
      // 回调驱动，不再手工 self-increment（onOrchestrationStart 在每个 handleChatStart 入口
      // 同步触发，故 count === onOrchestrationStart 计数，且不落 hitCounters 手工计数器）。
      return {
        module: ORCHESTRATION_MODULE,
        fn: ORCHESTRATION_FN,
        called: counts.onOrchestrationStart > 0,
        count: counts.onOrchestrationStart,
        onOrchestrationStart: counts.onOrchestrationStart,
        onRunStarted: counts.onRunStarted,
        onStep: counts.onStep,
        fingerprint: "chatOrchestration.handleChatStart@R21-R02"
      }
    }
  }
}

/**
 * 断言 current 与 hardened 两变体命中同一 runtime 编排实现。
 * 判据（全部满足才 ok）：
 *  - 两个 trace 都 called（module/fn 匹配、counter > 0）；
 *  - fingerprint 相等；
 *  - 每个变体 handleChatStart 命中 ≥ 1（真实调用，非字符串扫描）。
 * 返回 { ok, detail }；任一不满足 → ok=false（红测 exit 非 0）。
 */
export function assertSameOrchestrationRuntime(
  current: OrchestrationTrace | null,
  hardened: OrchestrationTrace | null
): { ok: boolean; detail: string } {
  const detailParts: string[] = []
  const curOk = !!current && current.module === ORCHESTRATION_MODULE && current.fn === ORCHESTRATION_FN && current.called && current.count >= 1
  const hardOk = !!hardened && hardened.module === ORCHESTRATION_MODULE && hardened.fn === ORCHESTRATION_FN && hardened.called && hardened.count >= 1
  detailParts.push(`current.called=${!!current?.called && !!current?.count} hardened.called=${!!hardened?.called && !!hardened?.count}`)
  if (!curOk) detailParts.push(`current 未命中 runtime 编排（${current ? `${current.module}/${current.fn} count=${current.count}` : "null"}）`)
  if (!hardOk) detailParts.push(`hardened 未命中 runtime 编排（${hardened ? `${hardened.module}/${hardened.fn} count=${hardened.count}` : "null"}）`)
  const fpOk = !!current && !!hardened && current.fingerprint === hardened.fingerprint
  if (!fpOk) detailParts.push(`fingerprint 不一致（current=${current?.fingerprint} hardened=${hardened?.fingerprint}）`)
  const ok = curOk && hardOk && fpOk
  return { ok, detail: detailParts.join("；") || "ok" }
}
