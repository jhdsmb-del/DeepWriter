import type { ComposerDraftWrite, ComposerDraftWriteResult, PersistedComposerDraft } from '../../shared/composerDraft'

interface DraftEntry {
  desired?: string
  revision: number
  writing: Promise<void> | null
  error: Error | null
  blocked: boolean
}

/** Coalesce pending edits, serialize each session and acknowledge durable writes. */
export function createDraftPersistence(
  save: (input: ComposerDraftWrite) => Promise<ComposerDraftWriteResult>,
  report: (error: Error | null) => void
) {
  const entries = new Map<string, DraftEntry>()
  const get = (id: string): DraftEntry => {
    let entry = entries.get(id)
    if (!entry) { entry = { revision: 0, writing: null, error: null, blocked: false }; entries.set(id, entry) }
    return entry
  }
  const reportState = (): void => report([...entries.values()].find((entry) => entry.error)?.error ?? null)
  const start = (id: string, entry: DraftEntry): void => {
    if (entry.writing || entry.blocked || entry.desired === undefined) return
    entry.error = null
    entry.writing = Promise.resolve().then(async () => {
      let conflicts = 0
      while (entry.desired !== undefined && !entry.blocked) {
        const text = entry.desired
        entry.desired = undefined
        try {
          const result = await save({ sessionId: id, text, expectedRevision: entry.revision })
          if (result.draft.sessionId !== id || !Number.isSafeInteger(result.draft.revision) || result.draft.revision < entry.revision) throw new Error('草稿保存返回了无效版本')
          entry.revision = result.draft.revision
          if (!result.ok) {
            if (entry.desired === undefined) entry.desired = text
            if (++conflicts > 3) throw new Error('草稿正在被其他窗口修改，请稍后重试')
          } else conflicts = 0
        } catch (error) {
          if (entry.desired === undefined) entry.desired = text
          entry.error = error instanceof Error ? error : new Error('草稿保存失败')
          break
        }
      }
    }).finally(() => { entry.writing = null; reportState() })
  }
  return {
    seed(drafts: PersistedComposerDraft[]): void {
      for (const draft of drafts) get(draft.sessionId).revision = Math.max(get(draft.sessionId).revision, draft.revision)
    },
    queue(id: string, text: string): void {
      const entry = get(id)
      if (entry.blocked) return
      entry.desired = text
      start(id, entry)
    },
    async flush(): Promise<void> {
      for (const entry of entries.values()) entry.error = null
      do {
        for (const [id, entry] of entries) if (!entry.error) start(id, entry)
        await Promise.all([...entries.values()].map((entry) => entry.writing))
        const error = [...entries.values()].find((entry) => entry.error)?.error
        if (error) throw error
      } while ([...entries.values()].some((entry) => !entry.blocked && (entry.writing || entry.desired !== undefined)))
    },
    async beforeDelete(id: string): Promise<void> {
      const entry = get(id)
      // Finish older writes before the delete IPC, and reject late callbacks.
      await entry.writing
      entry.blocked = true
      entry.desired = undefined
      entry.error = null
      reportState()
    },
    afterDelete(id: string, deleted: boolean): void {
      const entry = get(id)
      if (!deleted) entry.blocked = false
    }
  }
}
