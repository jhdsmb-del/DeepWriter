import assert from 'node:assert/strict'
import { changedSettings } from '../src/renderer/src/settingsDraft'

;(globalThis as any).window = { ds: {} }
const { useStore } = await import('../src/renderer/src/store')
const initial = useStore.getState()
const attachment = (id: string) => ({ fileRefId: id, name: `${id}.txt`, size: 12, state: 'ready' as const })
const ready = { previewId: 'local-preview', mode: 'optimized', policyRevision: 0, budget: { status: 'ready' } } as any
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function reset(): void {
  useStore.setState({ ...initial, settings: { planMode: false } as any, previewContext: async () => ready })
  ;(window as any).ds = { sessionsLoad: async () => [], sessionsList: async () => [], sessionsDelete: async () => true }
}
let passed = 0
let failed = 0
async function test(name: string, action: () => void | Promise<void>): Promise<void> {
  reset()
  try { await action(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${(error as Error).message}`) }
}

await test('未发送会话刷新列表保持 id 与附件作用域', async () => {
  useStore.getState().setComposerText('尚未提交的草稿')
  const id = useStore.getState().currentSessionId
  useStore.getState().setPendingAttachments([attachment('a')])
  await useStore.getState().loadSessions()
  assert.equal(useStore.getState().currentSessionId, id)
  assert.equal(useStore.getState().pendingAttachments[0].fileRefId, 'a')
})

await test('新会话为空，回到两个不同会话分别还原文本和附件', async () => {
  useStore.getState().setComposerText('会话 A 草稿')
  useStore.getState().setPendingAttachments([attachment('a')])
  const a = useStore.getState().currentSessionId!
  useStore.getState().newSession()
  assert.equal(useStore.getState().composerText, '')
  assert.deepEqual(useStore.getState().pendingAttachments, [])
  useStore.getState().setComposerText('会话 B 草稿')
  useStore.getState().setPendingAttachments([attachment('b')])
  const b = useStore.getState().currentSessionId!
  await useStore.getState().switchSession(a)
  assert.equal(useStore.getState().composerText, '会话 A 草稿')
  assert.equal(useStore.getState().pendingAttachments[0].fileRefId, 'a')
  await useStore.getState().switchSession(b)
  assert.equal(useStore.getState().composerText, '会话 B 草稿')
  assert.equal(useStore.getState().pendingAttachments[0].fileRefId, 'b')
})

await test('迟到的附件预览只更新原会话，不复活已移除附件', async () => {
  useStore.getState().setPendingAttachments([attachment('a')])
  const a = useStore.getState().currentSessionId!
  useStore.getState().newSession()
  useStore.getState().setPendingAttachments([attachment('b')])
  useStore.getState().setPendingAttachments((items) => items.map((item) => ({ ...item, name: '预览更新' })), a)
  assert.equal(useStore.getState().pendingAttachments[0].name, 'b.txt')
  await useStore.getState().switchSession(a)
  assert.equal(useStore.getState().pendingAttachments[0].name, '预览更新')
  useStore.getState().setPendingAttachments((items) => items.filter((item) => item.fileRefId !== 'a'), a)
  useStore.getState().setPendingAttachments((items) => items.map((item) => ({ ...item, state: 'ready' })), a)
  assert.deepEqual(useStore.getState().pendingAttachments, [])
})

await test('删除草稿会话后迟到回调不能重新创建它', async () => {
  useStore.getState().setComposerText('删除的草稿')
  const a = useStore.getState().currentSessionId!
  useStore.getState().newSession()
  assert.equal(await useStore.getState().deleteSession(a), true)
  useStore.getState().setPendingAttachments((items) => [...items, attachment('late')], a)
  assert.equal(useStore.getState().composerDrafts[a], undefined)
  assert.deepEqual(useStore.getState().pendingAttachments, [])
})

await test('预览期间双重提交被拒，禁止切换会话，ACK 保留新输入与新附件', async () => {
  const preview = deferred<any>()
  const ack = deferred<any>()
  let previewCalls = 0
  let startCalls = 0
  useStore.setState({ previewContext: async () => { previewCalls++; return preview.promise } })
  ;(window as any).ds.chatStart = async () => { startCalls++; return ack.promise }
  useStore.getState().setComposerText('  原始提交文本  ')
  useStore.getState().setPendingAttachments([attachment('sent')])
  const id = useStore.getState().currentSessionId!
  const send = useStore.getState().send('原始提交文本', useStore.getState().pendingAttachments)
  assert.equal(useStore.getState().submitting, true)
  const duplicate = await useStore.getState().send('重复提交')
  assert.equal(duplicate.ok, false)
  // Durable draft acknowledgement now precedes the asynchronous preview.
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(previewCalls, 1)
  useStore.getState().newSession()
  await useStore.getState().switchSession('other-session')
  assert.equal(useStore.getState().currentSessionId, id)
  preview.resolve(ready)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(startCalls, 1)
  useStore.getState().setComposerText('等待确认时写下的新任务')
  useStore.getState().setPendingAttachments((items) => [...items, attachment('next')])
  ack.resolve({ runId: 'accepted-run', status: 'queued' })
  assert.equal((await send).ok, true)
  useStore.getState().clearSubmittedText(id, '  原始提交文本  ')
  assert.equal(useStore.getState().composerText, '等待确认时写下的新任务')
  assert.deepEqual(useStore.getState().pendingAttachments.map((item) => item.fileRefId), ['next'])
  assert.equal(useStore.getState().submitting, false)
})

await test('确认后导航到别的会话，只清除原会话已提交文本', async () => {
  useStore.getState().setComposerText('已提交草稿')
  const a = useStore.getState().currentSessionId!
  useStore.getState().newSession()
  useStore.getState().setComposerText('另一会话草稿')
  useStore.getState().clearSubmittedText(a, '已提交草稿')
  assert.equal(useStore.getState().composerText, '另一会话草稿')
  await useStore.getState().switchSession(a)
  assert.equal(useStore.getState().composerText, '')
})

await test('提交拒绝保留草稿和附件，回滚消息并允许重试', async () => {
  ;(window as any).ds.chatStart = async () => { throw new Error('故障注入：主进程拒绝') }
  useStore.getState().setComposerText('需要保留的失败草稿')
  useStore.getState().setPendingAttachments([attachment('kept')])
  const result = await useStore.getState().send('需要保留的失败草稿', useStore.getState().pendingAttachments)
  assert.equal(result.ok, false)
  assert.equal(useStore.getState().submitting, false)
  assert.equal(useStore.getState().running, false)
  assert.deepEqual(useStore.getState().messages, [])
  assert.equal(useStore.getState().composerText, '需要保留的失败草稿')
  assert.equal(useStore.getState().pendingAttachments[0].fileRefId, 'kept')
  ;(window as any).ds.chatStart = async () => ({ runId: 'retry-run', status: 'queued' })
  assert.equal((await useStore.getState().send('需要保留的失败草稿', useStore.getState().pendingAttachments)).ok, true)
})

for (const kind of ['overflow', 'unknown', 'exception'] as const) {
  await test(`上下文 ${kind} 不清草稿，不遗留提交锁`, async () => {
    useStore.getState().setComposerText('上下文失败仍可编辑')
    useStore.setState({ previewContext: async () => {
      if (kind === 'exception') throw new Error('预览异常')
      return { ...ready, budget: { status: kind } }
    } })
    assert.equal((await useStore.getState().send('上下文失败仍可编辑')).ok, false)
    assert.equal(useStore.getState().submitting, false)
    assert.equal(useStore.getState().composerText, '上下文失败仍可编辑')
    assert.deepEqual(useStore.getState().messages, [])
  })
}

await test('快速切换会话时，迟到历史加载不能覆盖新会话', async () => {
  const b = deferred<any[]>()
  const c = deferred<any[]>()
  ;(window as any).ds.sessionsLoad = (id: string) => id === 'b' ? b.promise : c.promise
  const loadB = useStore.getState().switchSession('b')
  useStore.getState().setComposerText('B 草稿')
  const loadC = useStore.getState().switchSession('c')
  useStore.getState().setComposerText('C 草稿')
  c.resolve([])
  await loadC
  b.resolve([{ id: 'wrong', role: 'user', content: '旧会话的消息' }])
  await loadB
  assert.equal(useStore.getState().currentSessionId, 'c')
  assert.equal(useStore.getState().composerText, 'C 草稿')
  assert.deepEqual(useStore.getState().messages, [])
  assert.equal(useStore.getState().composerDrafts.b.text, 'B 草稿')
})

await test('长文入口拒绝过短需求时保留草稿', () => {
  useStore.getState().setComposerText('太短')
  assert.equal(useStore.getState().startGuidedLongwrite('太短'), false)
  assert.equal(useStore.getState().composerText, '太短')
  assert.equal(useStore.getState().grillLaunchRequest, null)
})

await test('普通长文不继承已关闭的剧情题材；显式剧情仍保留', () => {
  const story = { ...useStore.getState().story, genre: 'Galgame 恋爱日常', enabled: false }
  useStore.setState({ story })
  const task = '给刚入职的编辑写一份术语手册'
  assert.equal(useStore.getState().startGuidedLongwrite(task), true)
  assert.equal(useStore.getState().grillLaunchRequest?.genre, '未定')
  useStore.setState({ story: { ...story, enabled: true } })
  assert.equal(useStore.getState().startGuidedLongwrite('继续这部长篇小说，写潮汐监测站的夜班'), true)
  assert.equal(useStore.getState().grillLaunchRequest?.genre, story.genre)
})

await test('目录保存不会覆盖主进程的新凭据，不向 UI 发布 FileRef 请求对象', async () => {
  const saved = deferred<void>()
  let canonical = { apiKey: '__CONFIGURED__', model: 'current-model', workDir: '/old-dir', docDir: '/docs', galgame: { enabled: false, projectDir: '/game', sdkPath: '/sdk' } } as any
  useStore.setState({ settings: { ...canonical, apiKey: '' } })
  ;(window as any).ds.getSettings = async () => canonical
  ;(window as any).ds.setSettings = async () => { throw new Error('单字段不应整份写回') }
  ;(window as any).ds.setSettingField = async (key: string, value: unknown) => {
    assert.equal(key, 'workDir')
    assert.deepEqual(value, { value: '/selected-dir', dirRefId: 'authorized-dir' })
    await saved.promise
    canonical = { ...canonical, workDir: '/resolved-dir' }
  }
  const update = useStore.getState().updateSettings({ workDir: { value: '/selected-dir', dirRefId: 'authorized-dir' } })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(useStore.getState().settings?.workDir, '/old-dir')
  saved.resolve()
  assert.equal(await update, true)
  assert.equal(canonical.apiKey, '__CONFIGURED__')
  assert.equal(useStore.getState().settings?.workDir, '/resolved-dir')
})

await test('多字段保存合并主进程最新配置和 Galgame 子字段', async () => {
  let canonical = { apiKey: '__CONFIGURED__', model: 'current-model', temperature: 0.4, galgame: { enabled: true, projectDir: '/game', sdkPath: '/sdk' } } as any
  useStore.setState({ settings: { ...canonical, model: 'stale-model', apiKey: '' } })
  ;(window as any).ds.getSettings = async () => canonical
  ;(window as any).ds.setSettings = async (settings: any) => { canonical = settings }
  assert.equal(await useStore.getState().updateSettings({ temperature: 0.6, galgame: { enabled: false } }), true)
  assert.equal(canonical.model, 'current-model')
  assert.equal(canonical.apiKey, '__CONFIGURED__')
  assert.equal(canonical.galgame.projectDir, '/game')
  assert.equal(canonical.temperature, 0.6)
})

await test('设置保存拒绝时保持规范设置并释放写队列', async () => {
  let canonical = { ...initial.settings, workDir: '/old-dir', temperature: 0.4 } as any
  useStore.setState({ settings: canonical })
  ;(window as any).ds.getSettings = async () => canonical
  ;(window as any).ds.setSettings = async () => { throw new Error('保存拒绝') }
  assert.equal(await useStore.getState().updateSettings({ workDir: { value: '/new-dir', dirRefId: 'invalid-ref' } }), false)
  assert.equal(useStore.getState().settings?.workDir, '/old-dir')
  ;(window as any).ds.setSettings = async (settings: any) => { canonical = settings }
  assert.equal(await useStore.getState().updateSettings({ temperature: 0.8 }), true)
  assert.equal(useStore.getState().settings?.temperature, 0.8)
})

await test('刷新会话列表失败时保持上次有效记录', async () => {
  const sessions = [{ id: 'kept', title: '已有会话', createdAt: 1, updatedAt: 1, messageCount: 2, model: '' }]
  useStore.setState({ sessions })
  ;(window as any).ds.sessionsList = async () => { throw new Error('暂时无法读取') }
  await useStore.getState().loadSessions()
  assert.deepEqual(useStore.getState().sessions, sessions)
})

await test('上下文加载还原固定事实，迟到结果不能覆盖别的会话', async () => {
  const preference = deferred<any>()
  ;(window as any).ds.contextGetPreference = async () => preference.promise
  ;(window as any).ds.contextListPins = async () => [{ pinId: 'fact-a', displayLabel: '必须保留的事实' }]
  useStore.getState().setComposerText('原会话')
  const id = useStore.getState().currentSessionId!
  const load = useStore.getState().loadContext(id)
  preference.resolve({ mode: 'optimized', revision: 2 })
  await load
  assert.equal(useStore.getState().contextPins[0].pinId, 'fact-a')
  const late = deferred<any>()
  ;(window as any).ds.contextGetPreference = async () => late.promise
  const old = useStore.getState().loadContext(id)
  useStore.getState().newSession()
  late.resolve({ mode: 'full', revision: 9 })
  await old
  assert.equal(useStore.getState().contextMode, 'optimized')
  assert.deepEqual(useStore.getState().contextPins, [])
})

await test('设置弹窗只提交修改字段，保留同时更新的模型和凭据', async () => {
  const baseline = { apiKey: '', model: 'old-model', temperature: 0.4, workDir: '/old-dir', galgame: { enabled: true, projectDir: '/game', sdkPath: '/sdk' } } as any
  const draft = { ...baseline, temperature: 0.7, galgame: { ...baseline.galgame, enabled: false } }
  const patch = changedSettings(baseline, draft)
  assert.deepEqual(patch, { temperature: 0.7, galgame: { enabled: false } })
  let canonical = { ...baseline, model: 'new-model', apiKey: '__CONFIGURED__' }
  useStore.setState({ settings: baseline })
  ;(window as any).ds.getSettings = async () => canonical
  ;(window as any).ds.setSettings = async (settings: any) => { canonical = settings }
  assert.equal(await useStore.getState().updateSettings(patch), true)
  assert.equal(canonical.apiKey, '__CONFIGURED__')
  assert.equal(canonical.model, 'new-model')
  assert.equal(canonical.galgame.sdkPath, '/sdk')
})

function initBridge(extra: Record<string, unknown> = {}): Promise<void> {
  Object.assign((window as any).ds, {
    getSettings: async () => ({ planMode: false }),
    onChatEvent: () => () => undefined,
    onChatError: () => () => undefined,
    composerDraftsList: async () => [],
    ...extra
  })
  return useStore.getState().init()
}

await test('原生附件迟到事件保持原会话作用域，不串入当前会话', async () => {
  let attached!: (event: any) => void
  await initBridge({ onAttachmentAttached: (callback: typeof attached) => { attached = callback; return () => undefined } })
  useStore.getState().setComposerText('A 草稿')
  useStore.getState().setPendingAttachments([attachment('existing-a')])
  const a = useStore.getState().currentSessionId!
  useStore.getState().newSession()
  useStore.getState().setPendingAttachments([attachment('existing-b')])
  attached({ ...attachment('native-a'), sessionId: a, draftId: 'current' })
  assert.deepEqual(useStore.getState().pendingAttachments.map((item) => item.fileRefId), ['existing-b'])
  assert.deepEqual(useStore.getState().composerDrafts[a].attachments.map((item) => item.fileRefId), ['existing-a', 'native-a'])
  attached({ ...attachment('native-a'), sessionId: a, draftId: 'current' })
  assert.equal(useStore.getState().composerDrafts[a].attachments.length, 2)
  attached({ ...attachment('missing-owner'), draftId: 'current' })
  assert.deepEqual(useStore.getState().pendingAttachments.map((item) => item.fileRefId), ['existing-b'])
})

await test('删除期间与删除后的原生附件事件不能复活草稿', async () => {
  let attached!: (event: any) => void
  const deletion = deferred<boolean>()
  await initBridge({ onAttachmentAttached: (callback: typeof attached) => { attached = callback; return () => undefined }, sessionsDelete: () => deletion.promise })
  useStore.getState().setComposerText('将删除 A')
  const a = useStore.getState().currentSessionId!
  useStore.getState().newSession()
  const deleting = useStore.getState().deleteSession(a)
  await new Promise<void>((resolve) => setImmediate(resolve))
  attached({ ...attachment('late'), sessionId: a, draftId: 'current' })
  assert.deepEqual(useStore.getState().composerDrafts[a].attachments, [])
  assert.deepEqual(useStore.getState().pendingAttachments, [])
  deletion.resolve(true)
  assert.equal(await deleting, true)
  attached({ ...attachment('later'), sessionId: a, draftId: 'current' })
  assert.equal(useStore.getState().composerDrafts[a], undefined)
  assert.deepEqual(useStore.getState().pendingAttachments, [])
})

await test('空白原会话切走后，显式原生附件创建原会话草稿', async () => {
  let attached!: (event: any) => void
  await initBridge({ onAttachmentAttached: (callback: typeof attached) => { attached = callback; return () => undefined } })
  const a = useStore.getState().ensureSessionId()
  useStore.getState().newSession()
  assert.equal(useStore.getState().composerDrafts[a], undefined)
  attached({ ...attachment('empty-origin'), sessionId: a, draftId: 'current' })
  assert.deepEqual(useStore.getState().pendingAttachments, [])
  assert.equal(useStore.getState().composerDrafts[a].text, '')
  assert.equal(useStore.getState().composerDrafts[a].attachments[0].fileRefId, 'empty-origin')
  await useStore.getState().switchSession(a)
  assert.equal(useStore.getState().pendingAttachments[0].fileRefId, 'empty-origin')
})

await test('启动时先选择已有会话，迟到持久草稿恢复当前文字并保留附件', async () => {
  const drafts = deferred<any[]>()
  const initializing = initBridge({ composerDraftsList: () => drafts.promise })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await useStore.getState().switchSession('startup-selected')
  useStore.getState().setPendingAttachments([attachment('startup-attachment')])
  drafts.resolve([{ sessionId: 'startup-selected', text: '上次退出的文字', revision: 3, updatedAt: 1 }])
  await initializing
  assert.equal(useStore.getState().composerText, '上次退出的文字')
  assert.equal(useStore.getState().composerDrafts['startup-selected'], undefined)
  assert.equal(useStore.getState().pendingAttachments[0].fileRefId, 'startup-attachment')
})

await test('启动时选择附件后切走，迟到文字恢复不会丢失原附件', async () => {
  const drafts = deferred<any[]>()
  const initializing = initBridge({ composerDraftsList: () => drafts.promise })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await useStore.getState().switchSession('startup-inactive-attachment')
  useStore.getState().setPendingAttachments([attachment('kept-inactive')])
  useStore.getState().newSession()
  drafts.resolve([{ sessionId: 'startup-inactive-attachment', text: '保留的文字', revision: 3, updatedAt: 1 }])
  await initializing
  await useStore.getState().switchSession('startup-inactive-attachment')
  assert.equal(useStore.getState().composerText, '保留的文字')
  assert.equal(useStore.getState().pendingAttachments[0].fileRefId, 'kept-inactive')
})

for (const editedText of ['加载期间的新文字', '']) {
  for (const switchAway of [false, true]) {
    await test(`启动草稿加载不覆盖主动编辑${editedText ? '' : '或清空'}${switchAway ? '，切走后仍保留' : ''}`, async () => {
      const drafts = deferred<any[]>()
      const initializing = initBridge({ composerDraftsList: () => drafts.promise })
      await new Promise<void>((resolve) => setImmediate(resolve))
      const id = `${editedText ? 'startup-edited' : 'startup-cleared'}-${switchAway}`
      await useStore.getState().switchSession(id)
      useStore.getState().setComposerText(editedText)
      if (switchAway) useStore.getState().newSession()
      drafts.resolve([{ sessionId: id, text: '不能覆盖的新旧边界', revision: 3, updatedAt: 1 }])
      await initializing
      await useStore.getState().switchSession(id)
      assert.equal(useStore.getState().composerText, editedText)
    })
  }
}

await test('启动迟到草稿快照不能复活已删除会话', async () => {
  const drafts = deferred<any[]>()
  const initializing = initBridge({ composerDraftsList: () => drafts.promise })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await useStore.getState().switchSession('startup-deleted')
  assert.equal(await useStore.getState().deleteSession('startup-deleted'), true)
  drafts.resolve([{ sessionId: 'startup-deleted', text: '已删除文字', revision: 3, updatedAt: 1 }])
  await initializing
  assert.equal(useStore.getState().composerDrafts['startup-deleted'], undefined)
  assert.notEqual(useStore.getState().currentSessionId, 'startup-deleted')
  assert.equal(useStore.getState().composerText, '')
})

for (const editedText of [null, '删除期间的新编辑', ''] as const) {
  await test(`启动草稿在删除等待期间返回，删除异常后${editedText === null ? '恢复保存文字' : editedText ? '保留新编辑' : '尊重主动清空和切走'}`, async () => {
    const drafts = deferred<any[]>()
    const deletion = deferred<boolean>()
    const id = `startup-failed-delete-${editedText === null ? 'restore' : editedText ? 'edit' : 'clear'}`
    let durable = { sessionId: id, text: '启动前的持久文字', revision: 3, updatedAt: 1 }
    const initializing = initBridge({
      composerDraftsList: () => drafts.promise,
      sessionsDelete: () => deletion.promise,
      composerDraftSave: async (input: { sessionId: string; text: string; expectedRevision: number }) => {
        assert.equal(input.sessionId, id)
        assert.equal(input.expectedRevision, durable.revision)
        durable = { ...durable, text: input.text, revision: durable.revision + 1 }
        return { ok: true, draft: durable }
      }
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await useStore.getState().switchSession(id)
    const deleting = useStore.getState().deleteSession(id)
    assert.equal(await useStore.getState().deleteSession(id), false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    drafts.resolve([{ ...durable }])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(useStore.getState().composerText, '')
    assert.equal(useStore.getState().composerDrafts[id], undefined)
    if (editedText !== null) useStore.getState().setComposerText(editedText)
    if (editedText === '') useStore.getState().newSession()
    deletion.reject(new Error('故障注入：删除事务回滚'))
    const [deleted] = await Promise.all([deleting, initializing])
    assert.equal(deleted, false)
    await useStore.getState().flushComposerDrafts()
    await useStore.getState().switchSession(id)
    const expected = editedText ?? '启动前的持久文字'
    assert.equal(useStore.getState().composerText, expected)
    assert.equal(durable.text, expected)
  })
}

for (const clearText of [false, true]) {
  for (const switchAway of clearText ? [false, true] : [false]) {
    await test(`启动草稿加载异常后删除被拒${clearText ? `，主动清空${switchAway ? '并切走' : ''}仍可保存` : '不能以未编辑空串覆盖持久文字'}`, async () => {
      const drafts = deferred<any[]>()
      const deletion = deferred<boolean>()
      const id = `startup-load-rejected-${clearText}-${switchAway}`
      let durable = { sessionId: id, text: '加载失败但仍在磁盘的文字', revision: 3, updatedAt: 1 }
      const attempts: string[] = []
      const initializing = initBridge({
        composerDraftsList: () => drafts.promise,
        sessionsDelete: () => deletion.promise,
        composerDraftSave: async (input: { sessionId: string; text: string; expectedRevision: number }) => {
          assert.equal(input.sessionId, id)
          attempts.push(input.text)
          if (input.expectedRevision !== durable.revision) return { ok: false, reason: 'conflict', draft: { ...durable } }
          durable = { ...durable, text: input.text, revision: durable.revision + 1 }
          return { ok: true, draft: durable }
        }
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      await useStore.getState().switchSession(id)
      const deleting = useStore.getState().deleteSession(id)
      await new Promise<void>((resolve) => setImmediate(resolve))
      drafts.reject(new Error('故障注入：读取草稿失败'))
      await initializing
      if (clearText) useStore.getState().setComposerText('')
      if (switchAway) useStore.getState().newSession()
      deletion.resolve(false)
      assert.equal(await deleting, false)
      await useStore.getState().flushComposerDrafts()
      if (clearText) {
        assert.ok(attempts.length > 0)
        assert.ok(attempts.every((text) => text === ''))
        assert.equal(durable.text, '')
      } else {
        assert.deepEqual(attempts, [])
        assert.equal(durable.text, '加载失败但仍在磁盘的文字')
      }
    })
  }
}

for (const switchAway of [false, true]) {
  await test(`删除${switchAway ? '异常' : '拒绝'}保留最新文字${switchAway ? '，切走后仍能保存' : '与附件'}并恢复原生附件接收`, async () => {
    let attached!: (event: any) => void
    const deletion = deferred<boolean>()
    const saved = new Map<string, { text: string; revision: number }>()
    await initBridge({
      onAttachmentAttached: (callback: typeof attached) => { attached = callback; return () => undefined },
      sessionsDelete: () => deletion.promise,
      composerDraftSave: async (input: { sessionId: string; text: string; expectedRevision: number }) => {
        const draft = { sessionId: input.sessionId, text: input.text, revision: input.expectedRevision + 1, updatedAt: 1 }
        saved.set(input.sessionId, draft)
        return { ok: true, draft }
      }
    })
    useStore.getState().setComposerText('删除前文字')
    useStore.getState().setPendingAttachments([attachment('before-delete')])
    const id = useStore.getState().currentSessionId!
    await useStore.getState().flushComposerDrafts()
    const deleting = useStore.getState().deleteSession(id)
    await new Promise<void>((resolve) => setImmediate(resolve))
    useStore.getState().setComposerText('删除等待期间最新文字')
    if (switchAway) useStore.getState().newSession()
    if (switchAway) deletion.reject(new Error('故障注入：删除事务失败'))
    else deletion.resolve(false)
    assert.equal(await deleting, false)
    await useStore.getState().flushComposerDrafts()
    assert.equal(saved.get(id)?.text, '删除等待期间最新文字')
    attached({ ...attachment('after-delete-failure'), sessionId: id, draftId: 'current' })
    await useStore.getState().switchSession(id)
    assert.equal(useStore.getState().composerText, '删除等待期间最新文字')
    assert.deepEqual(useStore.getState().pendingAttachments.map((item) => item.fileRefId), ['before-delete', 'after-delete-failure'])
  })
}

console.log(`Composer reliability: ${passed} PASS / ${failed} FAIL`)
process.exit(failed ? 1 : 0)
