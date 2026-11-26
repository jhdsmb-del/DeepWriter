import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { isWorkSteeringConfig, type WorkSteeringView } from '../../../shared/workSteering'

export function useWorkSteering() {
  const sessionId = useStore(state => state.currentSessionId)
  const runningId = useStore(state => state.runningId)
  const activeRunId = useStore(state => state.activeRunId)
  const running = useStore(state => state.running)
  const [view, setView] = useState<WorkSteeringView | null>(null)
  const [sending, setSending] = useState(false)
  const retry = useRef<{ runId: string; text: string; requestId: string } | null>(null)
  const refresh = useRef<() => Promise<void>>(async () => undefined)
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
    const ds = (window as any).ds
    setView(null)
    if (!sessionId || !ds?.runsSteering) return
    let target = runningId ?? activeRunId
    const update = async () => {
      try {
        let run = (runningId ?? target) ? await ds.runsGet(runningId ?? target) : null
        if (runningId && (!run || run.sessionId !== sessionId)) return
        if (!run || run.sessionId !== sessionId) {
          const recent = (await ds.runsListRecent(100)).find((row: { sessionId: string }) => row.sessionId === sessionId)
          run = recent ? await ds.runsGet(recent.runId) : null
        }
        if (!run || !isWorkSteeringConfig(run.config)) return
        target = run.runId
        const next = await ds.runsSteering(target, sessionId)
        if (!disposed) setView(next)
      } catch { /* A failed refresh never removes the last saved receipt. */ }
    }
    refresh.current = update
    const poll = async () => { await update(); if (!disposed) timer = setTimeout(() => void poll(), 1000) }
    void poll()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [sessionId, runningId, activeRunId])
  const current = view?.sessionId === sessionId ? view : null
  const canSteer = running && current?.runId === runningId && ['running', 'queued'].includes(current.runStatus)
  const send = useCallback(async (text: string): Promise<void> => {
    if (!current || !sessionId || !canSteer) throw new Error('当前运行不能接收补充；草稿已保留')
    const previous = retry.current
    const requestId = previous?.runId === current.runId && previous.text === text ? previous.requestId : crypto.randomUUID()
    retry.current = { runId: current.runId, text, requestId }
    setSending(true)
    try {
      await (window as any).ds.runsSteer({ runId: current.runId, sessionId, requestId, text })
      retry.current = null
      await refresh.current()
    } finally { setSending(false) }
  }, [current, sessionId, canSteer])
  return { view: current, canSteer, sending, send }
}
