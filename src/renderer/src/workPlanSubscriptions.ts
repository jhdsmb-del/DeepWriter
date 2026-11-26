import type { WorkPlanSnapshot, WorkPlanUpdate } from '../../shared/workPlan'

interface Subscription {
  runId: string
  plan: WorkPlanSnapshot | null
  loaded: boolean
  reading: boolean
  revision: number
  listeners: Set<() => void>
}

// Inline messages and task details share a single narrow read per run. Entries
// live only while visible; reopening always reconciles with durable receipts.
const runs = new Map<string, Subscription>()
let unsubscribeUpdates: (() => void) | undefined
const active = (entry: Subscription): boolean => runs.get(entry.runId) === entry && entry.listeners.size > 0

async function refresh(entry: Subscription): Promise<void> {
  if (entry.reading || !active(entry)) return
  entry.reading = true
  try {
    while (active(entry)) {
      const revision = entry.revision
      try {
        const plan = await window.ds.runsGetWorkPlan(entry.runId)
        if (!active(entry)) return
        // An update during this read makes its response obsolete. Coalesce
        // any burst into one follow-up, without flashing an older checklist.
        if (revision !== entry.revision) continue
        entry.loaded = true
        if (JSON.stringify(plan) !== JSON.stringify(entry.plan)) {
          entry.plan = plan
          for (const listener of entry.listeners) listener()
        }
      } catch { /* Retain the last receipt; the next update/mount can retry. */ }
      if (revision === entry.revision) break
    }
  } finally { entry.reading = false }
}

export const getWorkPlan = (runId: string): WorkPlanSnapshot | null => runs.get(runId)?.plan ?? null

export function subscribeWorkPlan(runId: string, listener: () => void): () => void {
  let entry = runs.get(runId)
  if (!entry) {
    entry = { runId, plan: null, loaded: false, reading: false, revision: 0, listeners: new Set() }
    runs.set(runId, entry)
  }
  const subscription = entry
  subscription.listeners.add(listener)
  if (!unsubscribeUpdates) unsubscribeUpdates = window.ds.onRunWorkPlanUpdated(({ runId: updated }: WorkPlanUpdate) => {
    const current = runs.get(updated)
    if (current) { current.revision++; void refresh(current) }
  })
  if (!subscription.loaded) void refresh(subscription)
  return () => {
    subscription.listeners.delete(listener)
    if (!subscription.listeners.size) runs.delete(runId)
    if (!runs.size) { unsubscribeUpdates?.(); unsubscribeUpdates = undefined }
  }
}
