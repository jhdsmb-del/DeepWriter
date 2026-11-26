import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DiscoveryPreview, ModelRecord, ModelConnectionResult, ProbeResult, ProfileRecord, ProviderRecord, ProviderRegistrySnapshot } from '../../../shared/providerRegistry'
import type { ProviderSetupInput } from '../../../shared/providerSetup'
import SelectControl from './SelectControl'
import Icon from './Icon'
import { modelFailureNotice } from '../modelFailure'
import { useProviderRegistry } from '../hooks/useProviderRegistry'

type Result<T> = { ok: true; data: T } | { ok: false; error: { code?: string; message: string } }
type ProviderDraft = { key?: string; endpoint?: { baseUrl: string; protocol: ProviderSetupInput['protocol'] }; authStyle?: 'bearer' | 'none'; clearApiKey?: boolean; modelId?: string }
const empty: ProviderRegistrySnapshot = { providers: [], credentials: [], models: [], profiles: [], bindings: null }
const blankSetup = (): ProviderSetupInput => ({ displayName: '', baseUrl: '', apiKey: '', authStyle: 'bearer', protocol: 'openai-chat', modelIds: [''] })
const localEndpoint = (value: string): boolean => { try { const url = new URL(value); return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) } catch { return false } }
const displayBase = (provider: ProviderRecord): string => provider.baseUrl.replace(/\/$/, '') + provider.chatPath.replace(/\/(?:chat\/completions|responses|messages)$/, '')
const protocolFor = (provider: ProviderRecord): ProviderSetupInput['protocol'] => provider.transportPolicy.protocol === 'deepseek-chat' ? 'openai-chat' : provider.transportPolicy.protocol ?? 'openai-chat'
const profileForModel = (snapshot: ProviderRegistrySnapshot, modelId: string): ProfileRecord | undefined => snapshot.profiles.find(entry => entry.modelId === modelId && entry.id === (snapshot.bindings?.draftProfileId ?? snapshot.bindings?.defaultProfileId)) ?? snapshot.profiles.find(entry => entry.modelId === modelId)
const formats = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' }
] as const

export default function ProviderManager({ renderAdvanced, onRegisterSave }: { renderAdvanced: (providerId: string) => ReactNode; onRegisterSave?: (save: (() => Promise<boolean>) | null) => void }): ReactNode {
  const ds = window.ds
  const registry = useProviderRegistry()
  const snapshot = registry.snapshot ?? empty
  const [providerId, setProviderId] = useState(() => {
    const profile = snapshot.profiles.find(entry => entry.id === (snapshot.bindings?.draftProfileId ?? snapshot.bindings?.defaultProfileId))
    return profile?.providerId ?? snapshot.providers.find(entry => entry.kind === 'builtin')?.id ?? snapshot.providers[0]?.id ?? ''
  })
  const [adding, setAdding] = useState(false)
  const [setup, setSetup] = useState(blankSetup)
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({})
  const [discovery, setDiscovery] = useState<DiscoveryPreview | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [message, setMessage] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [connections, setConnections] = useState<Record<string, ModelConnectionResult>>({})
  const [toolTests, setToolTests] = useState<Record<string, ProbeResult['outcome']>>({})
  const savePendingRef = useRef<() => Promise<boolean>>(async () => true)
  const provider = snapshot.providers.find(entry => entry.id === providerId)
  const draft = drafts[providerId] ?? {}
  const key = draft.key ?? '', endpointDraft = draft.endpoint, modelId = draft.modelId ?? ''
  const updateDraft = (patch: Partial<ProviderDraft>): void => setDrafts(current => ({ ...current, [providerId]: { ...current[providerId], ...patch } }))
  const setKey = (value: string): void => updateDraft({ key: value, clearApiKey: false })
  const setEndpointDraft = (value: NonNullable<ProviderDraft['endpoint']>): void => updateDraft({ endpoint: value, ...(!localEndpoint(value.baseUrl) && (draft.authStyle ?? provider?.authStyle) === 'none' ? { authStyle: 'bearer' as const } : {}) })
  const setModelId = (value: string): void => updateDraft({ modelId: value })
  const hasChanges = Boolean(key.trim() || endpointDraft || draft.authStyle || draft.clearApiKey)
  const authStyle = draft.authStyle ?? provider?.authStyle ?? 'bearer'
  const models = snapshot.models.filter(entry => entry.providerId === providerId && entry.enabled)
  const activeProfileId = snapshot.bindings?.draftProfileId ?? snapshot.bindings?.defaultProfileId
  const activeProfile = snapshot.profiles.find(entry => entry.id === activeProfileId)
  const activeModelId = activeProfile?.modelId
  const independentCredential = authStyle === 'bearer' && activeProfile?.providerId === providerId && activeProfile.credentialRefId && activeProfile.credentialRefId !== provider?.defaultCredentialRefId
  const keySaved = snapshot.credentials.some(entry => entry.id === provider?.defaultCredentialRefId && entry.status === 'ready')
  const configured = snapshot.providers.filter(entry => entry.kind === 'builtin' || entry.defaultCredentialRefId || snapshot.models.some(model => model.providerId === entry.id))
  const unconfigured = snapshot.providers.filter(entry => !configured.some(item => item.id === entry.id))
  const providerName = (entry: ProviderRecord): string => entry.kind === 'builtin' || entry.id.startsWith('provider.preset.') ? entry.displayName.replace(/\s*[（(].*$/, '') : entry.displayName

  const refresh = async (): Promise<ProviderRegistrySnapshot | null> => {
    return registry.refreshSnapshot()
  }
  useEffect(() => {
    const defaultProfile = snapshot.profiles.find(profile => profile.id === (snapshot.bindings?.draftProfileId ?? snapshot.bindings?.defaultProfileId))
    setProviderId(current => snapshot.providers.some(provider => provider.id === current) ? current : defaultProfile?.providerId || snapshot.providers.find(entry => entry.kind === 'builtin')?.id || snapshot.providers[0]?.id || '')
  }, [snapshot])
  useEffect(() => {
    onRegisterSave?.(() => savePendingRef.current())
    return () => onRegisterSave?.(null)
  }, [onRegisterSave])

  const run = async <T,>(operation: () => Promise<Result<T>>, success: string): Promise<T | null> => {
    if (lock.current) return null
    lock.current = true; setBusy(true); setMessage('')
    try {
      const result = await operation()
      if (!result.ok) { const notice = modelFailureNotice(result.error.code, result.error.message); setMessage(notice ? `${notice.title}。${notice.detail}` : result.error.message); return null }
      window.dispatchEvent(new Event('deepwriter:provider-registry-changed'))
      await refresh()
      setMessage(success)
      return result.data
    } catch {
      setMessage('保存未完成，请检查配置后重试。')
      return null
    } finally { lock.current = false; setBusy(false) }
  }

  const selectProvider = (id: string): void => {
    if (lock.current) return
    setProviderId(id); setAdding(false); setDiscovery(null); setChosen([]); setMessage(''); setAdvancedOpen(false)
  }
  const saveSetup = async (): Promise<boolean> => {
    const saved = await run<ProviderRecord>(() => ds.providerCreateSetup({ ...setup, modelIds: setup.modelIds.map(id => id.trim()).filter(Boolean) }), '供应商已添加，模型可直接在对话中选择。')
    if (saved) { setProviderId(saved.id); setAdding(false); setSetup(blankSetup()); setDiscovery(null); setChosen([]) }
    return Boolean(saved)
  }
  const saveProvider = async (target: ProviderRecord, editing: ProviderDraft): Promise<ProviderRecord | null> => {
    if (!editing.key?.trim() && !editing.endpoint && !editing.authStyle && !editing.clearApiKey) return target
    const saved = await run<ProviderRecord>(() => ds.providerUpdateSetup({ providerId: target.id, baseUrl: editing.endpoint?.baseUrl ?? displayBase(target),
      protocol: editing.endpoint?.protocol ?? protocolFor(target),
      ...(editing.authStyle ? { authStyle: editing.authStyle } : {}),
      ...(editing.clearApiKey ? { clearApiKey: true } : {}),
      ...(editing.key?.trim() && editing.authStyle !== 'none' && !editing.clearApiKey ? { apiKey: editing.key.trim() } : {}) }), '模型配置已保存。')
    if (saved) {
      if (providerId === target.id && saved.id !== target.id) setProviderId(saved.id)
      setDrafts(current => ({ ...current, [target.id]: { ...current[target.id], key: '', endpoint: undefined, authStyle: undefined, clearApiKey: false } }))
      const ids = new Set(snapshot.models.filter(model => model.providerId === target.id).map(model => model.id))
      setConnections(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.has(id))))
      setToolTests(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.has(id))))
      setDiscovery(null); setChosen([])
    }
    return saved
  }
  const saveExisting = async (): Promise<ProviderRecord | null> => provider ? saveProvider(provider, draft) : null
  const fetchModels = async (): Promise<void> => {
    if (!provider) return
    setDiscovery(null); setChosen([])
    const saved = await saveExisting()
    if (!saved) return
    const result = await run<DiscoveryPreview>(() => ds.modelDiscoverPreview(saved.id, saved.defaultCredentialRefId), '请选择要添加的模型。')
    if (result) setDiscovery(result)
  }
  const acceptModels = async (): Promise<void> => {
    if (!discovery) return
    const saved = await run(() => ds.modelAcceptDiscovered(discovery.discoveryId, chosen), '所选模型已添加，可直接使用。')
    if (saved) { setDiscovery(null); setChosen([]) }
  }
  const useModel = async (model: ModelRecord): Promise<void> => {
    const saved = await saveExisting()
    if (!saved) return
    await run(async () => {
      const fresh = await refresh()
      if (!fresh) return { ok: false, error: { message: '无法读取当前模型配置，请重试' } }
      const target = fresh.models.find(entry => entry.providerId === saved.id && entry.remoteModelId === model.remoteModelId)
      if (!target) return { ok: false, error: { message: '保存后的供应商没有这个模型，请重新选择模型' } }
      let profile = profileForModel(fresh, target.id)
      if (!profile) {
        const result = await ds.profileUpsert({
          id: `profile.model.${target.id}`, name: target.displayName, providerId: target.providerId, modelId: target.id,
          credentialRefId: null, generation: { temperature: null, topP: null, maxOutputTokens: null, stream: true },
          reasoning: { mode: 'default', effort: null, budgetTokens: null }, compatibilityMappingId: null
        }) as Result<ProfileRecord>
        if (!result.ok) return result
        profile = result.data
      }
      return ds.profileSetBindings({ ...(fresh.bindings ?? {}), defaultProfileId: profile.id, draftProfileId: profile.id })
    }, `已选择 ${model.displayName}。`)
  }
  const testConnection = async (model: ModelRecord): Promise<void> => {
    if (!provider || !window.confirm('测试将发送一条短请求，可能产生少量 API 费用。继续吗？')) return
    const saved = await saveExisting()
    if (!saved) return
    const fresh = await refresh()
    const target = fresh?.models.find(entry => entry.providerId === saved.id && entry.remoteModelId === model.remoteModelId)
    if (!target) { setMessage('保存后的供应商没有这个模型，请重新选择模型'); return }
    const profile = fresh ? profileForModel(fresh, target.id) : undefined
    setConnections(current => { const next = { ...current }; delete next[model.id]; return next })
    const result = await run<ModelConnectionResult>(() => ds.modelTestConnection(target.id, profile?.credentialRefId ?? saved.defaultCredentialRefId, true), `${target.displayName} 已成功返回回复。`)
    if (result) setConnections(current => ({ ...current, [target.id]: result }))
  }
  const testTools = async (model: ModelRecord): Promise<void> => {
    if (!provider || !window.confirm('测试将向当前已保存的模型地址发送一条请求，可能产生少量 API 费用。测试函数不会执行，不会读取文件或运行命令。继续吗？')) return
    const fresh = await refresh()
    if (!fresh) return
    const profile = profileForModel(fresh, model.id)
    const result = await run<ProbeResult>(() => ds.modelProbeTools(model.id, profile?.credentialRefId ?? provider.defaultCredentialRefId, true), '')
    if (result) {
      setToolTests(current => ({ ...current, [model.id]: result.outcome }))
      setMessage(result.outcome === 'supported' ? `${model.displayName} 已通过工具调用测试，新任务可使用工具。` : '本次未验证工具调用成功，未新增工具能力；普通对话不受影响。')
    }
  }
  const toolLabel = (model: ModelRecord): string => model.capabilities.toolUse.source === 'protocol_probe' && model.capabilities.toolUse.state === 'supported'
    ? '已通过调用测试' : model.capabilities.toolUse.state === 'supported' && ['builtin_manifest', 'models_endpoint', 'model_catalog'].includes(model.capabilities.toolUse.source ?? '')
      ? '规格支持' : model.capabilities.toolUse.state === 'unsupported' ? '规格标为不支持' : '尚未验证'
  const tokenLabel = (value: number | null): string => value === null ? '由接口决定' : `${value.toLocaleString()} tokens`
  const baseUrl = provider ? displayBase(provider) : ''
  const currentProtocol = provider ? protocolFor(provider) : 'openai-chat'
  savePendingRef.current = async () => {
    if (setup.displayName.trim() || setup.baseUrl.trim() || setup.apiKey.trim() || setup.modelIds.some(id => id.trim())) {
      if (!await saveSetup()) { setAdding(true); return false }
    }
    for (const [id, editing] of Object.entries(drafts)) {
      const target = snapshot.providers.find(entry => entry.id === id)
      if (target && !await saveProvider(target, editing)) { selectProvider(id); return false }
    }
    return true
  }

  return <div className="dw-provider-manager" data-testid="provider-registry">
    <nav className="dw-provider-nav" aria-label="模型供应商">
      <span className="dw-provider-nav-heading">模型供应商</span>
      {configured.map(entry => <button type="button" key={entry.id} disabled={busy} aria-current={!adding && providerId === entry.id ? 'true' : undefined} onClick={() => selectProvider(entry.id)}>
        <span>{providerName(entry)}</span>
      </button>)}
      <button type="button" className="dw-provider-add" aria-label="＋ 添加供应商" disabled={busy} aria-current={adding ? 'true' : undefined} onClick={() => { setAdding(true); setDiscovery(null); setMessage(''); setAdvancedOpen(false) }}><Icon name="plus" />添加供应商</button>
      {unconfigured.length > 0 && <details className="dw-provider-more"><summary>常用供应商</summary>{unconfigured.map(entry => <button type="button" key={entry.id} disabled={busy} aria-current={!adding && providerId === entry.id ? 'true' : undefined} onClick={() => selectProvider(entry.id)}>{providerName(entry)}</button>)}</details>}
    </nav>
    <div className="dw-provider-content">
      {adding || !provider ? <form className="dw-provider-form" onSubmit={event => { event.preventDefault(); void saveSetup() }}>
        <h3>添加模型供应商</h3>
        <label className="field"><span>名称</span><input aria-label="供应商名称" autoComplete="off" required maxLength={100} disabled={busy} value={setup.displayName} placeholder="如：OpenCode Go" onChange={event => setSetup({ ...setup, displayName: event.target.value })} /></label>
        <label className="field"><span>Base URL</span><input aria-label="供应商 Base URL" autoComplete="off" required disabled={busy} value={setup.baseUrl} placeholder="https://api.example.com/v1" onChange={event => setSetup({ ...setup, baseUrl: event.target.value, ...(!localEndpoint(event.target.value) && setup.authStyle === 'none' ? { authStyle: 'bearer' as const } : {}) })} /></label>
        <label className="field"><span>API Key</span><input aria-label="供应商 API Key" type="password" autoComplete="new-password" maxLength={4096} disabled={busy || setup.authStyle === 'none'} value={setup.authStyle === 'none' ? '' : setup.apiKey} placeholder={setup.authStyle === 'none' ? '本机服务不发送密钥' : '输入 API Key'} onChange={event => setSetup({ ...setup, apiKey: event.target.value })} /></label>
        {localEndpoint(setup.baseUrl) && <label className="dw-provider-no-auth"><input type="checkbox" checked={setup.authStyle === 'none'} disabled={busy} onChange={event => setSetup({ ...setup, authStyle: event.target.checked ? 'none' : 'bearer', apiKey: event.target.checked ? '' : setup.apiKey })} />本机服务无需 API Key</label>}
        <label className="field"><span>API 格式</span><SelectControl ariaLabel="供应商 API 格式" value={setup.protocol} options={[...formats]} disabled={busy} onChange={protocol => setSetup({ ...setup, protocol })} /></label>
        <fieldset className="dw-provider-model-inputs"><legend>模型列表</legend>
          {setup.modelIds.map((id, index) => <div className="dw-provider-model-input" key={index}>
            <input aria-label={`模型 ID ${index + 1}`} autoComplete="off" maxLength={200} required disabled={busy} value={id} placeholder="模型 ID，如 deepseek-chat" onChange={event => setSetup({ ...setup, modelIds: setup.modelIds.map((value, i) => i === index ? event.target.value : value) })} />
            <button type="button" className="ghost-btn" aria-label={`移除模型 ${index + 1}`} title={`移除模型 ${index + 1}`} disabled={busy || setup.modelIds.length === 1} onClick={() => setSetup({ ...setup, modelIds: setup.modelIds.filter((_, i) => i !== index) })}><Icon name="close" /></button>
          </div>)}
          <button type="button" className="ghost-btn" disabled={busy || setup.modelIds.length >= 100} onClick={() => setSetup({ ...setup, modelIds: [...setup.modelIds, ''] })}><Icon name="plus" />添加模型</button>
        </fieldset>
        <button type="submit" className="btn primary dw-provider-save" disabled={busy}>{busy ? '正在保存…' : '添加供应商'}</button>
      </form> : <>
        <header className="dw-provider-header"><h3>{provider.displayName}</h3></header>
        <form className="dw-provider-form" onSubmit={event => { event.preventDefault(); void saveExisting() }}>
          <label className="field"><span>Base URL</span><input aria-label="当前供应商 Base URL" autoComplete="off" required disabled={busy} value={endpointDraft?.baseUrl ?? baseUrl} onChange={event => setEndpointDraft({ baseUrl: event.target.value, protocol: endpointDraft?.protocol ?? currentProtocol })} /></label>
          <label className="field"><span>API Key</span><input aria-label="当前供应商 API Key" type="password" autoComplete="new-password" maxLength={4096} disabled={busy || authStyle === 'none'} value={authStyle === 'none' ? '' : key} placeholder={authStyle === 'none' ? '本机服务不发送密钥' : draft.clearApiKey ? '保存后清除密钥' : keySaved ? '已保存，留空保持不变' : '输入 API Key'} onChange={event => setKey(event.target.value)} /></label>
          {keySaved && <button type="button" className="dw-text-btn danger" disabled={busy} onClick={() => updateDraft({ key: '', clearApiKey: !draft.clearApiKey })}>{draft.clearApiKey ? '取消清除密钥' : '清除已保存密钥'}</button>}
          {independentCredential && activeProfile && <div className="dw-provider-line"><span>当前模型使用独立密钥</span><button type="button" className="dw-text-btn" disabled={busy || hasChanges} title={hasChanges ? '请先保存当前配置' : undefined} onClick={() => void run(() => ds.profileUpsert({ id: activeProfile.id, name: activeProfile.name, providerId: activeProfile.providerId, modelId: activeProfile.modelId, credentialRefId: null, generation: activeProfile.generation, reasoning: activeProfile.reasoning, compatibilityMappingId: activeProfile.compatibilityMappingId }), '当前模型已改用供应商默认密钥。')}>改用供应商默认密钥</button></div>}
          {localEndpoint(endpointDraft?.baseUrl ?? baseUrl) && <label className="dw-provider-no-auth"><input type="checkbox" checked={authStyle === 'none'} disabled={busy} onChange={event => updateDraft({ authStyle: event.target.checked ? 'none' : 'bearer' })} />本机服务无需 API Key</label>}
          <label className="field"><span>API 格式</span><SelectControl ariaLabel="当前供应商 API 格式" value={endpointDraft?.protocol ?? currentProtocol} options={[...formats]} disabled={busy} onChange={protocol => setEndpointDraft({ baseUrl: endpointDraft?.baseUrl ?? baseUrl, protocol })} /></label>
          <button type="submit" className="ghost-btn" disabled={busy || !hasChanges}>{busy ? '正在保存…' : '保存配置'}</button>
        </form>
        <section className="dw-provider-catalog" aria-label="模型列表">
          <div className="dw-provider-catalog-heading"><h4>模型列表</h4><button type="button" className="ghost-btn" disabled={busy || !provider.modelsPath} onClick={() => void fetchModels()}><Icon name="refresh" />获取模型</button></div>
          {discovery && <div className="dw-provider-discovery">
            <div className="dw-provider-discovery-list">{discovery.models.map(entry => <label key={entry.remoteModelId}><input type="checkbox" disabled={busy} checked={chosen.includes(entry.remoteModelId)} onChange={event => setChosen(current => event.target.checked ? [...current, entry.remoteModelId] : current.filter(id => id !== entry.remoteModelId))} /><span>{entry.displayName || entry.remoteModelId}</span></label>)}</div>
            {!discovery.models.length && <p>这个接口没有返回模型，可在下面手动添加。</p>}
            <div className="dw-provider-line"><button type="button" className="btn primary" disabled={busy || !chosen.length} onClick={() => void acceptModels()}>添加所选模型{chosen.length > 0 ? `（${chosen.length}）` : ''}</button><button type="button" className="ghost-btn" disabled={busy} onClick={() => { setDiscovery(null); setChosen([]) }}>取消</button></div>
          </div>}
          <div className="dw-provider-simple-models">{models.map(model => <div className="dw-provider-model-row" key={model.id}>
            <button type="button" disabled={busy} aria-pressed={model.id === activeModelId} aria-label={`${model.displayName} ${model.id === activeModelId ? '当前使用' : '选择'}`} onClick={() => void useModel(model)}><span>{model.displayName}</span>{model.id === activeModelId && <Icon name="check" />}</button>
            <details className="dw-provider-model-details"><summary aria-label={`${model.displayName} 规格与连接`}>规格与连接</summary><dl>
              <div><dt>上下文</dt><dd>{tokenLabel(model.contextWindow)}</dd></div>
              <div><dt>最大输出</dt><dd>{tokenLabel(model.maxOutputTokens)}</dd></div>
              <div><dt>思考</dt><dd>{model.capabilities.reasoning.state === 'unsupported' ? '不支持' : model.capabilities.reasoning.efforts.length ? model.capabilities.reasoning.efforts.join(' / ') : model.capabilities.reasoning.state === 'supported' ? '模型自动控制' : '由接口决定'}</dd></div>
              <div><dt>工具调用</dt><dd>{toolLabel(model)}</dd></div>
              {model.catalog && <div><dt>规格来源</dt><dd>models.dev · {model.catalog.fetchedAt.slice(0, 10)}</dd></div>}
              {!hasChanges && connections[model.id] && <div><dt>调用测试</dt><dd>已连接 · {(connections[model.id].durationMs / 1000).toFixed(1)} 秒</dd></div>}
              {toolTests[model.id] === 'inconclusive' && <div><dt>本次工具测试</dt><dd>未验证成功</dd></div>}
            </dl><div className="dw-provider-line"><button type="button" className="ghost-btn" disabled={busy} onClick={() => void testConnection(model)} aria-label={`测试 ${model.displayName} 连接`}>{busy ? '请稍候…' : hasChanges ? '保存并测试连接' : '测试连接'}</button>
              <button type="button" className="ghost-btn" disabled={busy || hasChanges} title={hasChanges ? '请先保存配置，再测试当前模型' : undefined} onClick={() => void testTools(model)} aria-label={`测试 ${model.displayName} 工具调用`}>{busy ? '请稍候…' : '测试工具调用'}</button></div></details>
          </div>)}</div>
          <form className="dw-provider-model-input" onSubmit={event => { event.preventDefault(); void run(() => ds.modelAddManual({ providerId: provider.id, remoteModelId: modelId.trim(), displayName: modelId.trim() }), '模型已添加，可直接使用。').then(saved => { if (saved) setModelId('') }) }}>
            <input aria-label="添加模型 ID" autoComplete="off" maxLength={200} required disabled={busy} value={modelId} placeholder="输入模型 ID" onChange={event => setModelId(event.target.value)} /><button type="submit" className="ghost-btn" disabled={busy || !modelId.trim()}>添加模型</button>
          </form>
        </section>
        <details className="dw-provider-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}><summary>高级设置</summary>{advancedOpen && <><button type="button" className="ghost-btn" disabled={busy} onClick={() => void run(() => ds.modelRefreshCatalog(), '模型规格已更新。')}>更新模型规格</button>{renderAdvanced(providerId)}</>}</details>
      </>}
      {message && <p className="dw-provider-message" role="status">{message}</p>}
    </div>
  </div>
}
