import { createRunJournal, assertRunId } from './runJournal'
import type { RunJournal } from './runJournal'
import { ACTIVITY_SCHEMA_VERSION, createRunReducer, isTerminalPhase } from '../shared/activity'
import type { ActivityEvent, RunPhase, RunSnapshot, RunViewState } from '../shared/activity'

export type NewActivityEvent = Omit<ActivityEvent, 'schemaVersion' | 'runId' | 'sessionId' | 'seq' | 'timestamp' | 'elapsedMs'>

export interface RunHandle {
  runId: string
  sessionId: string
  signal: AbortSignal
  emit(ev: NewActivityEvent): Promise<ActivityEvent>
  setPhase(phase: RunPhase, title?: string, detail?: string): Promise<void>
  complete(title?: string, summary?: string): Promise<void>
  fail(detail: string): Promise<void>
  cancel(title?: string): Promise<void>
}

export interface CreateActivityBusOpts {
  baseDir: string
  /** Durable source of truth. This callback must finish before an event is journaled or pushed to UI. */
  persist?: (ev: ActivityEvent) => void | Promise<void>
  /** Durable replay source used to rebuild snapshots after a process restart. */
  readEvents?: (runId: string, afterSeq: number) => ActivityEvent[] | Promise<ActivityEvent[]>
  push: (ev: ActivityEvent) => void
}

export interface ActivityBus {
  startRun(input: { sessionId: string; runId: string; signal?: AbortSignal }): RunHandle
  getSnapshot(runId: string): Promise<RunSnapshot | null>
  listActive(): string[]
  cancelRun(runId: string, title?: string): Promise<boolean>
  forget(runId: string): Promise<void>
}

export type ActivityTerminalDisposition = 'complete' | 'cancel' | 'fail' | 'recovery'

/** Engine may emit a lifecycle "terminal" while the durable run remains recoverable. */
export function classifyActivityTerminalStatus(status: string | undefined): ActivityTerminalDisposition {
  if (status === 'completed') return 'complete'
  if (status === 'cancelled') return 'cancel'
  if (status === 'recovery_required' || status === 'waiting_user' || status === 'paused') return 'recovery'
  return 'fail'
}

interface RunState {
  runId: string
  sessionId: string
  signal: AbortSignal
  startedAt: number
  seq: number
  reducer: (state: RunViewState | null, ev: ActivityEvent) => RunViewState | null
  view: RunViewState | null
  lock: Promise<unknown>
  terminal: boolean
  warned: boolean
}

export function createActivityBus(opts: CreateActivityBusOpts): ActivityBus {
  const journal: RunJournal = createRunJournal(opts.baseDir)
  const states = new Map<string, RunState>()

  const readReplayEvents = async (runId: string): Promise<ActivityEvent[]> => {
    const durable = opts.readEvents ? await opts.readEvents(runId, -1) : []
    const legacy = await journal.readEvents(runId, -1)
    const bySeq = new Map(durable.map((event) => [event.seq, event]))
    for (const event of legacy) {
      if (bySeq.has(event.seq)) continue
      // One-time compatibility migration for pre-R43 JSONL journals. Durable persistence
      // remains fail-closed; a failed migration must not be hidden by an in-memory replay.
      await opts.persist?.(event)
      bySeq.set(event.seq, event)
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  }

  const warnLate = (state: RunState, type: string): void => {
    if (state.warned) return
    state.warned = true
    console.warn(`[activity] run ${state.runId} 已终态，忽略迟到事件: ${type}`)
  }

  const buildEvent = async (state: RunState, ev: NewActivityEvent): Promise<ActivityEvent> => {
    const seq = state.seq + 1
    state.seq = seq
    const full: ActivityEvent = {
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      runId: state.runId,
      sessionId: state.sessionId,
      seq,
      timestamp: Date.now(),
      elapsedMs: Date.now() - state.startedAt,
      type: ev.type,
      phase: ev.phase,
      title: ev.title,
      detail: ev.detail,
      payload: ev.payload
    }
    await opts.persist?.(full)
    await journal.append(state.runId, full)
    state.view = state.reducer(state.view, full)
    opts.push(full)
    return full
  }

  const hydrate = async (state: RunState): Promise<void> => {
    const snapshot = await journal.readSnapshot(state.runId)
    state.view = snapshot
    state.seq = snapshot?.lastSeq ?? -1
    state.startedAt = snapshot?.startedAt ?? state.startedAt
    const durableEvents = await readReplayEvents(state.runId)
    for (const event of durableEvents) {
      if (event.seq <= state.seq) continue
      state.view = state.reducer(state.view, event)
      state.seq = event.seq
      state.startedAt = state.view?.startedAt ?? state.startedAt
    }
    state.terminal = state.terminal || Boolean(state.view && isTerminalPhase(state.view.status))
    if (!state.view) {
      await buildEvent(state, {
        type: 'run.started',
        phase: 'queued',
        title: '任务已开始'
      })
    }
  }

  const enqueue = (state: RunState, ev: NewActivityEvent): Promise<ActivityEvent> => {
    const next = state.lock.then(() => buildEvent(state, ev))
    state.lock = next.catch(() => undefined)
    return next
  }

  const emitRun = (state: RunState, ev: NewActivityEvent): Promise<ActivityEvent> => {
    if (state.terminal) {
      warnLate(state, ev.type)
      const stub: ActivityEvent = {
        schemaVersion: ACTIVITY_SCHEMA_VERSION,
        runId: state.runId,
        sessionId: state.sessionId,
        seq: state.seq,
        timestamp: Date.now(),
        elapsedMs: Date.now() - state.startedAt,
        type: ev.type,
        phase: ev.phase,
        title: ev.title,
        detail: ev.detail,
        payload: ev.payload
      }
      return Promise.resolve(stub)
    }
    return enqueue(state, ev)
  }

  const flush = async (state: RunState): Promise<void> => {
    await state.lock
    try {
      if (state.view) await journal.writeSnapshot(state.runId, state.view)
      await journal.prune(50)
    } catch (e) {
      console.warn(`[activity] run ${state.runId} snapshot 写入失败`, e)
    }
  }

  const finalize = async (state: RunState, ev: NewActivityEvent): Promise<void> => {
    if (state.terminal) {
      warnLate(state, ev.type)
      return
    }
    state.terminal = true
    try {
      await enqueue(state, ev)
      await flush(state)
    } catch (e) {
      console.warn(`[activity] run ${state.runId} 终态处理失败`, e)
    }
  }

  const startRun = (input: { sessionId: string; runId: string; signal?: AbortSignal }): RunHandle => {
    assertRunId(input.runId)
    const existing = states.get(input.runId)
    if (existing) {
      if (!existing.terminal) throw new Error(`run 已存在: ${input.runId}`)
      states.delete(input.runId)
    }
    const controller = input.signal ? null : new AbortController()
    const state: RunState = {
      runId: input.runId,
      sessionId: input.sessionId,
      signal: input.signal ?? controller!.signal,
      startedAt: Date.now(),
      seq: -1,
      reducer: createRunReducer(),
      view: null,
      lock: Promise.resolve(),
      terminal: false,
      warned: false
    }
    state.lock = hydrate(state)
    states.set(input.runId, state)
    void state.lock.catch((error) => console.warn(`[activity] run ${state.runId} 恢复失败`, error))
    const handle: RunHandle = {
      runId: state.runId,
      sessionId: state.sessionId,
      signal: state.signal,
      emit: (ev) => emitRun(state, ev),
      setPhase: (phase, title, detail) => emitRun(state, { type: 'phase.changed', phase, title, detail }).then(() => undefined),
      complete: (title, summary) => finalize(state, { type: 'run.completed', phase: 'completed', title: summary ?? title }),
      fail: (detail) => finalize(state, { type: 'run.failed', phase: 'failed', title: '执行失败', detail }),
      cancel: (title) => finalize(state, { type: 'run.cancelled', phase: 'cancelled', title: title ?? '已取消' })
    }
    return handle
  }

  const getSnapshot = async (runId: string): Promise<RunSnapshot | null> => {
    const st = states.get(runId)
    if (st) {
      await st.lock
      return st.view
    }
    const snapshot = await journal.readSnapshot(runId)
    let view: RunViewState | null = snapshot
    const reducer = createRunReducer()
    const events = await readReplayEvents(runId)
    for (const event of events) {
      if (event.seq > (snapshot?.lastSeq ?? -1)) view = reducer(view, event)
    }
    return view
  }

  const listActive = (): string[] => {
    const out: string[] = []
    for (const [runId, st] of states) {
      if (!st.terminal && st.view && !isTerminalPhase(st.view.status)) out.push(runId)
    }
    return out
  }

  const forget = async (runId: string): Promise<void> => {
    assertRunId(runId)
    states.delete(runId)
    await journal.remove(runId)
  }

  const cancelRun = async (runId: string, title = '已停止'): Promise<boolean> => {
    assertRunId(runId)
    const state = states.get(runId)
    if (!state) return false
    await finalize(state, { type: 'run.cancelled', phase: 'cancelled', title })
    return true
  }

  return { startRun, getSnapshot, listActive, cancelRun, forget }
}
