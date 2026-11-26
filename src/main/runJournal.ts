import { promises as fs } from 'fs'
import * as path from 'path'
import type { ActivityEvent, RunSnapshot } from '../shared/activity'

export interface RunMeta {
  runId: string
  updatedAt: number
}

export interface RunJournal {
  append(runId: string, ev: ActivityEvent): Promise<void>
  writeSnapshot(runId: string, snapshot: RunSnapshot): Promise<void>
  readSnapshot(runId: string): Promise<RunSnapshot | null>
  readEvents(runId: string, afterSeq?: number): Promise<ActivityEvent[]>
  listRuns(): Promise<RunMeta[]>
  prune(keep?: number): Promise<void>
  remove(runId: string): Promise<void>
}

const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/

export function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) throw new Error(`非法 runId: ${runId}`)
}

export function createRunJournal(baseDir: string): RunJournal {
  const runsRoot = path.join(baseDir, 'runs')
  const runDir = (runId: string): string => path.join(runsRoot, runId)

  const append = async (runId: string, ev: ActivityEvent): Promise<void> => {
    assertRunId(runId)
    const dir = runDir(runId)
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify(ev) + '\n', 'utf-8')
  }

  const writeSnapshot = async (runId: string, snapshot: RunSnapshot): Promise<void> => {
    assertRunId(runId)
    const dir = runDir(runId)
    await fs.mkdir(dir, { recursive: true })
    const target = path.join(dir, 'snapshot.json')
    const tmp = path.join(dir, `snapshot.${process.pid}.${Date.now()}.tmp`)
    await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf-8')
    await fs.rename(tmp, target)
  }

  const readSnapshot = async (runId: string): Promise<RunSnapshot | null> => {
    assertRunId(runId)
    try {
      const raw = await fs.readFile(path.join(runDir(runId), 'snapshot.json'), 'utf-8')
      const snap = JSON.parse(raw) as RunSnapshot
      if (!snap || typeof snap.runId !== 'string' || snap.runId !== runId) return null
      return snap
    } catch {
      return null
    }
  }

  const readEvents = async (runId: string, afterSeq = -1): Promise<ActivityEvent[]> => {
    assertRunId(runId)
    try {
      const raw = await fs.readFile(path.join(runDir(runId), 'events.jsonl'), 'utf-8')
      return raw.split(/\r?\n/u).flatMap((line) => {
        if (!line.trim()) return []
        try {
          const event = JSON.parse(line) as ActivityEvent
          return event.runId === runId && Number.isInteger(event.seq) && event.seq > afterSeq ? [event] : []
        } catch {
          return []
        }
      }).sort((a, b) => a.seq - b.seq)
    } catch {
      return []
    }
  }

  const listRuns = async (): Promise<RunMeta[]> => {
    let entries: import('fs').Dirent[] = []
    try {
      entries = await fs.readdir(runsRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const metas: RunMeta[] = []
    for (const e of entries) {
      if (!e.isDirectory() || !RUN_ID_RE.test(e.name)) continue
      let updatedAt = 0
      try {
        const st = await fs.stat(path.join(runsRoot, e.name, 'events.jsonl'))
        updatedAt = st.mtimeMs
      } catch {
        try {
          const st = await fs.stat(path.join(runsRoot, e.name))
          updatedAt = st.mtimeMs
        } catch {
          continue
        }
      }
      metas.push({ runId: e.name, updatedAt })
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  const prune = async (keep = 50): Promise<void> => {
    const metas = await listRuns()
    for (const m of metas.slice(keep)) {
      try {
        await fs.rm(path.join(runsRoot, m.runId), { recursive: true, force: true })
      } catch {
        void 0
      }
    }
  }

  const remove = async (runId: string): Promise<void> => {
    assertRunId(runId)
    await fs.rm(runDir(runId), { recursive: true, force: true })
  }

  return { append, writeSnapshot, readSnapshot, readEvents, listRuns, prune, remove }
}
