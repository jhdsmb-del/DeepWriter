import type { GoalSnapshot } from '../../shared/goalMode'
import { useCallback, useSyncExternalStore } from 'react'

interface GoalSubscription {
  runId: string
  goal: GoalSnapshot | null
  loaded: boolean
  reading: boolean
  revision: number
  listeners: Set<() => void>
}
const goals = new Map<string, GoalSubscription>()
let unsubscribe: (() => void) | undefined
const active = (entry: GoalSubscription): boolean => goals.get(entry.runId) === entry && entry.listeners.size > 0

async function refresh(entry: GoalSubscription): Promise<void> {
  if (entry.reading || !active(entry) || !window.ds?.runsGetGoal) return
  entry.reading = true
  try {
    while (active(entry)) {
      const revision = entry.revision
      try {
        const next = await window.ds.runsGetGoal(entry.runId) as GoalSnapshot | null
        if (!active(entry)) return
        if (entry.revision !== revision) continue
        entry.loaded = true
        if (JSON.stringify(next) !== JSON.stringify(entry.goal)) {
          entry.goal = next
          for (const listener of entry.listeners) listener()
        }
      } catch { /* Keep the committed snapshot available during transient IPC failures. */ }
      if (entry.revision === revision) break
    }
  } finally { entry.reading = false }
}
export const getGoal = (runId: string): GoalSnapshot | null => goals.get(runId)?.goal ?? null
export function subscribeGoal(runId: string, listener: () => void): () => void {
  let entry = goals.get(runId)
  if (!entry) {
    entry = { runId, goal: null, loaded: false, reading: false, revision: 0, listeners: new Set() }
    goals.set(runId, entry)
  }
  const subscription = entry
  subscription.listeners.add(listener)
  if (!unsubscribe && window.ds?.onRunGoalUpdated) unsubscribe = window.ds.onRunGoalUpdated(({ runId: id }: { runId: string }) => {
    const current = goals.get(id)
    if (current) { current.revision++; void refresh(current) }
  })
  if (!entry.loaded) void refresh(entry)
  return () => {
    subscription.listeners.delete(listener)
    if (!subscription.listeners.size) goals.delete(runId)
    if (!goals.size) { unsubscribe?.(); unsubscribe = undefined }
  }
}
export function useGoal(runId: string | null): GoalSnapshot | null {
  const subscribe = useCallback((listener: () => void) => runId ? subscribeGoal(runId, listener) : () => undefined, [runId])
  const snapshot = useCallback(() => runId ? getGoal(runId) : null, [runId])
  return useSyncExternalStore(subscribe, snapshot, () => null)
}
