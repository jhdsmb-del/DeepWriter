import { promises as fs } from 'fs'
import * as path from 'path'
import type { SessionEvent, SessionMessageSnapshot, SessionMeta } from '../shared/types'

/**
 * 会话消息落库类型。R21 Codex P1-04 回退：原 runChat（死代码）曾以 status='partial' 放宽
 * SessionMessageSnapshot.status 落半成品；runChat 删除后，生产链（chat:start → AgentRunEngine →
 * CompletionController 走 repository/SQLite）与 novel.ts 的 partial 草稿路径（partialContent/draftPath
 * 经 runNovelExport 落 deepwriter-partial 目录）均不使用 sessionStore 的 'partial' status，
 * 故此处不再放宽，恢复与 shared/types.ts 契约一致。
 */
export type StorableMessageSnapshot = SessionMessageSnapshot

export interface SessionStore {
  createSession(id: string, title: string, model: string): Promise<void>
  appendMessage(id: string, msg: StorableMessageSnapshot): Promise<void>
  loadSession(id: string): Promise<SessionMessageSnapshot[]>
  loadEvents(id: string): Promise<SessionEvent[]>
  listSessions(): Promise<SessionMeta[]>
  deleteSession(id: string): Promise<void>
  renameSession(id: string, title: string): Promise<void>
}

const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_')

export function createSessionStore(baseDir: string): SessionStore {
  const sessionsDir = path.join(baseDir, 'sessions')
  const indexFile = path.join(sessionsDir, 'index.json')

  let indexLock: Promise<unknown> = Promise.resolve()
  const withIndexLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = indexLock.then(fn, fn)
    indexLock = next.catch(() => undefined)
    return next
  }

  const readIndex = async (): Promise<SessionMeta[]> => {
    try {
      const raw = await fs.readFile(indexFile, 'utf-8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  const writeIndex = async (metas: SessionMeta[]): Promise<void> => {
    await fs.mkdir(sessionsDir, { recursive: true })
    const sorted = [...metas].sort((a, b) => b.updatedAt - a.updatedAt)
    const tmp = `${indexFile}.tmp`
    await fs.writeFile(tmp, JSON.stringify(sorted, null, 2), 'utf-8')
    await fs.rename(tmp, indexFile)
  }

  const updateIndex = (fn: (metas: SessionMeta[]) => SessionMeta[]): Promise<void> =>
    withIndexLock(async () => {
      const metas = await readIndex()
      await writeIndex(fn(metas))
    })

  return {
    async createSession(id, title, model) {
      const now = Date.now()
      await fs.mkdir(sessionsDir, { recursive: true })
      await fs.writeFile(path.join(sessionsDir, `${safeId(id)}.jsonl`), '', 'utf-8')
      await updateIndex((metas) => {
        const rest = metas.filter((m) => m.id !== id)
        rest.push({ id, title, createdAt: now, updatedAt: now, messageCount: 0, model })
        return rest
      })
    },

    async appendMessage(id, msg) {
      const file = path.join(sessionsDir, `${safeId(id)}.jsonl`)
      await fs.mkdir(sessionsDir, { recursive: true })
      const ev: SessionEvent = { ts: Date.now(), type: 'message', message: msg as SessionMessageSnapshot }
      await fs.appendFile(file, JSON.stringify(ev) + '\n', 'utf-8')
      await updateIndex((metas) => {
        const now = Date.now()
        let found = false
        const next = metas.map((m) => {
          if (m.id !== id) return m
          found = true
          let title = m.title
          if (m.messageCount === 0 && msg.role === 'user') title = msg.content.slice(0, 30)
          return { ...m, title, messageCount: m.messageCount + 1, updatedAt: now }
        })
        if (!found) {
          next.push({
            id,
            title: msg.role === 'user' ? msg.content.slice(0, 30) : '会话',
            createdAt: now,
            updatedAt: now,
            messageCount: 1,
            model: ''
          })
        }
        return next
      })
    },

    async loadSession(id) {
      try {
        const raw = await fs.readFile(path.join(sessionsDir, `${safeId(id)}.jsonl`), 'utf-8')
        const snapshots = new Map<string, SessionMessageSnapshot>()
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line) as SessionEvent
            if (ev.type === 'message' && ev.message) snapshots.set(ev.message.id, ev.message)
          } catch {
            /* 跳过损坏行 */
          }
        }
        return [...snapshots.values()]
      } catch {
        return []
      }
    },

    async loadEvents(id) {
      try {
        const raw = await fs.readFile(path.join(sessionsDir, `${safeId(id)}.jsonl`), 'utf-8')
        const events: SessionEvent[] = []
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            events.push(JSON.parse(line) as SessionEvent)
          } catch {
            /* 跳过损坏行 */
          }
        }
        return events
      } catch {
        return []
      }
    },

    async listSessions() {
      return readIndex()
    },

    async deleteSession(id) {
      try {
        await fs.unlink(path.join(sessionsDir, `${safeId(id)}.jsonl`))
      } catch {
        /* 文件不存在忽略 */
      }
      await updateIndex((metas) => metas.filter((m) => m.id !== id))
    },

    async renameSession(id, title) {
      const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) || '会话'
      await updateIndex((metas) => metas.map((m) => (m.id === id ? { ...m, title: clean } : m)))
    }
  }
}
