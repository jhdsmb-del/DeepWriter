import { useEffect, useMemo, useState } from 'react'
import { PROVIDER_PRESETS, type ImportPreview, type ModelRecord, type ProfileRecord, type ProviderProtocol, type ProviderRegistrySnapshot } from '../../../shared/providerRegistry'
import SelectControl from './SelectControl'
import ProviderManager from './ProviderManager'
import { useProviderRegistry } from '../hooks/useProviderRegistry'

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

const emptySnapshot: ProviderRegistrySnapshot = { providers: [], credentials: [], models: [], profiles: [], bindings: null }

export default function ProviderRegistryPanel({ onRegisterSave }: { onRegisterSave?: (save: (() => Promise<boolean>) | null) => void }): React.ReactNode {
  return <ProviderManager onRegisterSave={onRegisterSave} renderAdvanced={(providerId) => <ProviderAdvancedPanel key={providerId} initialProviderId={providerId} />} />
}

function ProviderAdvancedPanel({ initialProviderId }: { initialProviderId: string }): React.ReactNode {
  const ds = (window as any).ds
  const registry = useProviderRegistry()
  const snapshot = registry.snapshot ?? emptySnapshot
  const [providerId, setProviderId] = useState(initialProviderId)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [custom, setCustom] = useState<{ displayName: string; baseUrl: string; chatPath: string; modelsPath: string; scope: 'public_https' | 'loopback_http'; protocol: ProviderProtocol; authHeaderName: string; extraHeaders: string }>({ displayName: '', baseUrl: 'https://', chatPath: '/v1/chat/completions', modelsPath: '/v1/models', scope: 'public_https', protocol: 'openai-chat', authHeaderName: 'Authorization', extraHeaders: '' })
  const [credential, setCredential] = useState({ label: '默认凭据', secret: '' })
  const [manual, setManual] = useState({ remoteModelId: '', displayName: '', contextWindow: '', maxOutputTokens: '', reasoning: false, efforts: 'low,medium,high' })
  const [profile, setProfile] = useState({ name: '', modelId: '', credentialRefId: '', mode: 'default' as ProfileRecord['reasoning']['mode'], effort: '', budgetTokens: '', temperature: '1', topP: '1', maxOutputTokens: '' })
  const [bundleText, setBundleText] = useState('')
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [price, setPrice] = useState({ currency: 'CNY', input: '', output: '', cacheHit: '', cacheWrite: '', reasoning: '', rule: 'unknown', date: new Date().toISOString().slice(0, 10), sourceUrl: '', acknowledged: false })

  const applyPreset = (presetId: string): void => {
    const preset = PROVIDER_PRESETS.find((entry) => entry.id === presetId)
    if (!preset) return
    setCustom((current) => ({
      ...current,
      displayName: preset.displayName,
      baseUrl: preset.baseUrl,
      chatPath: preset.chatPath,
      modelsPath: preset.modelsPath ?? '',
      protocol: preset.protocol,
      authHeaderName: preset.authHeaderName ?? 'Authorization',
      extraHeaders: ''
    }))
  }

  const refresh = async (): Promise<void> => {
    await registry.refreshSnapshot()
  }

  useEffect(() => { setProviderId(current => snapshot.providers.some(provider => provider.id === current) ? current : snapshot.providers[0]?.id || '') }, [snapshot])

  const provider = snapshot.providers.find((entry) => entry.id === providerId) ?? null
  const credentials = snapshot.credentials.filter((entry) => entry.providerId === providerId)
  const models = snapshot.models.filter((entry) => entry.providerId === providerId)
  const profiles = snapshot.profiles.filter((entry) => entry.providerId === providerId)
  const selectedModel = models.find((entry) => entry.id === profile.modelId) ?? null
  useEffect(() => {
    const current = selectedModel?.pricing
    setPrice({ currency: current?.currency ?? 'CNY', input: current?.inputMissPerMillion?.toString() ?? '', output: current?.outputPerMillion?.toString() ?? '', cacheHit: current?.cacheHitPerMillion?.toString() ?? '', cacheWrite: current?.cacheWritePerMillion?.toString() ?? '', reasoning: current?.reasoningPerMillion?.toString() ?? '', rule: current?.reasoningBillingRule ?? 'unknown', date: (current?.effectiveAt ?? new Date().toISOString()).slice(0, 10), sourceUrl: current?.sourceUrl ?? '', acknowledged: false })
  }, [selectedModel?.id, selectedModel?.pricing?.id])
  const reasoning = selectedModel?.capabilities.reasoning
  const reasoningVerified = reasoning?.state === 'supported' && (reasoning.source === 'protocol_probe' || reasoning.source === 'builtin_manifest' || Boolean(reasoning.mappingId) && ['model_catalog', 'models_endpoint'].includes(reasoning.source ?? ''))
  const reasoningModes: ProfileRecord['reasoning']['mode'][] = reasoningVerified ? reasoning.modes : ['default']

  const run = async <T,>(operation: () => Promise<Result<T>>, success: string): Promise<T | null> => {
    setBusy(true); setMessage('')
    try {
      const result = await operation()
      if (!result.ok) { setMessage(result.error.message); return null }
      setMessage(success)
      window.dispatchEvent(new Event('deepwriter:provider-registry-changed'))
      await refresh()
      return result.data
    } catch {
      // IPC can reject as well as return a typed error. Do not expose arbitrary
      // transport details here: they can contain credential/header values.
      setMessage('操作未完成，请检查配置后重试。')
      return null
    } finally { setBusy(false) }
  }

  const createProvider = async (): Promise<void> => {
    let extraHeaders: unknown
    if (custom.extraHeaders.trim()) {
      try {
        extraHeaders = JSON.parse(custom.extraHeaders)
      } catch {
        setMessage('额外 Header 不是有效 JSON，请检查后重试。')
        return
      }
    }
    const result = await run(() => ds.providerCreateCustom({
      displayName: custom.displayName,
      baseUrl: custom.baseUrl,
      chatPath: custom.chatPath,
      modelsPath: custom.modelsPath.trim() || null,
      authStyle: 'bearer',
      transportPolicy: {
        scope: custom.scope,
        allowNonDefaultPort: custom.scope === 'loopback_http',
        protocol: custom.protocol,
        authHeaderName: custom.authHeaderName || undefined,
        extraHeaders
      }
    }), 'Provider 已创建；请继续添加凭据和模型。') as { id?: string } | null
    if (result?.id) setProviderId(result.id)
  }

  const addManualModel = async (): Promise<void> => {
    const efforts = manual.efforts.split(',').map((value) => value.trim()).filter(Boolean)
    await run(() => ds.modelAddManual({
      providerId,
      remoteModelId: manual.remoteModelId,
      displayName: manual.displayName || manual.remoteModelId,
      contextWindow: manual.contextWindow.trim() ? Number(manual.contextWindow) : null,
      maxOutputTokens: manual.maxOutputTokens.trim() ? Number(manual.maxOutputTokens) : null,
      declarations: manual.reasoning ? {
        reasoning: 'supported', reasoningModes: ['default', 'enabled'], reasoningEfforts: efforts
      } : undefined
    }), '模型已保存；手动声明会标记为“未验证”。')
  }

  const saveProfile = async (): Promise<void> => {
    if (!selectedModel) { setMessage('请先选择模型'); return }
    const id = `profile.user.${crypto.randomUUID()}`
    const saved = await run(() => ds.profileUpsert({
      id,
      name: profile.name || selectedModel.displayName,
      providerId,
      modelId: selectedModel.id,
      credentialRefId: profile.credentialRefId || null,
      generation: {
        temperature: profile.mode === 'enabled' && provider?.adapterId === 'builtin.deepseek' ? Number(profile.temperature) : Number(profile.temperature),
        topP: Number(profile.topP), maxOutputTokens: profile.maxOutputTokens.trim() ? Number(profile.maxOutputTokens) : null, stream: true
      },
      reasoning: { mode: profile.mode, effort: profile.effort || null, budgetTokens: profile.mode === 'enabled' && profile.budgetTokens.trim() ? Number(profile.budgetTokens) : null },
      compatibilityMappingId: provider?.adapterId === 'custom.openai-compatible-chat' && profile.mode !== 'default'
        ? reasoning?.mappingId ?? (provider.transportPolicy.protocol === 'openai-responses'
          ? 'openai_responses.reasoning_effort'
          : provider.transportPolicy.protocol === 'anthropic-messages'
            ? 'anthropic.thinking'
            : 'openai_chat.reasoning_effort_top_level')
        : null
    }), 'Profile 已保存。') as ProfileRecord | null
    if (saved) await run(() => ds.profileSetBindings({ defaultProfileId: saved.id }), '已设为新任务默认 Profile；运行中的任务保持原快照。')
  }

  const savePrice = async (): Promise<void> => {
    if (!selectedModel || !price.acknowledged) return
    const optionalRate = (value: string): number | null => value.trim() === '' ? null : Number(value)
    if (!price.input.trim() || !price.output.trim() || !Number.isFinite(Date.parse(`${price.date}T00:00:00Z`))) { setMessage('请填写输入、输出参考价和生效日期；未知的其他费率请留空。'); return }
    await run(() => ds.providerPricingUpsert({
      modelId: selectedModel.id, currency: price.currency.trim().toUpperCase(), unit: 'per_1m_tokens',
      inputPrice: Number(price.input), outputPrice: Number(price.output),
      cacheHitInputPrice: optionalRate(price.cacheHit), cacheWriteInputPrice: optionalRate(price.cacheWrite), reasoningPrice: optionalRate(price.reasoning),
      reasoningBillingRule: price.rule, validFrom: new Date(`${price.date}T00:00:00Z`).toISOString(),
      sourceUrl: price.sourceUrl.trim() || null, acknowledgeReferenceOnly: true
    }), '用户参考价已保存；仅供新任务预算估算，不是实际账单。运行中的任务保持原价格快照。')
  }

  const activeProfileId = snapshot.bindings?.defaultProfileId ?? ''
  const capabilityLabel = (model: ModelRecord): string => {
    const item = model.capabilities.reasoning
    if (item.state === 'supported') return item.source === 'model_catalog' ? '思考：模型规格' : item.source === 'protocol_probe' || item.source === 'builtin_manifest' ? '推理：已验证' : '思考：接口声明'
    if (item.state === 'unsupported') return '推理：不支持'
    return '推理：未知'
  }

  const selectedProfile = useMemo(() => snapshot.profiles.find((entry) => entry.id === activeProfileId), [snapshot, activeProfileId])

  return (
    <div className="dw-provider-registry" data-testid="provider-registry">
      <div className="dw-provider-current">
        <div><strong>新任务使用</strong><span>{selectedProfile?.name ?? '尚未选择 Profile'}</span></div>
        <SelectControl
          ariaLabel="新任务默认 Profile"
          value={activeProfileId}
          options={[
            { value: '', label: '选择 Profile', description: '新任务将使用所选配置', disabled: snapshot.profiles.length > 0 },
            ...snapshot.profiles.map((entry) => ({ value: entry.id, label: entry.name, description: `${entry.reasoning.mode === 'default' ? '默认推理' : `推理${entry.reasoning.mode}`}` }))
          ]}
          disabled={busy || snapshot.profiles.length === 0}
          onChange={(profileId) => { if (profileId) void run(() => ds.profileSetBindings({ defaultProfileId: profileId }), '默认 Profile 已更新。') }}
        />
      </div>

      <label className="field"><span>提供方</span><SelectControl
        ariaLabel="提供方"
        value={providerId}
        options={[
          { value: '', label: '选择提供方', description: '先选择一个 Provider', disabled: snapshot.providers.length > 0 },
          ...snapshot.providers.map((entry) => ({ value: entry.id, label: entry.displayName, description: entry.kind === 'builtin' ? '内置适配器' : 'OpenAI-compatible Chat' }))
        ]}
        disabled={busy || snapshot.providers.length === 0}
        onChange={(nextProviderId) => { setProviderId(nextProviderId); setProfile((value) => ({ ...value, modelId: '', credentialRefId: '' })) }}
      /></label>
      {provider && <div className="dw-provider-summary">
        <span>{provider.kind === 'builtin' ? '内置适配器' : ({ 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages', 'openai-chat': 'OpenAI-compatible Chat', 'deepseek-chat': 'DeepSeek Chat' }[provider.transportPolicy.protocol ?? 'openai-chat'])}</span>
        <code>{provider.baseUrl}</code>
        <small>{provider.builtinLocked ? '受保护，不可由导入覆盖' : `稳定 ID：${provider.id}`}</small>
      </div>}

      <details className="dw-provider-block">
        <summary>添加自定义 Provider</summary>
        <p className="muted small">官方预设只填入已核对的协议与地址；模型与价格仍以发现/手动声明为准。</p>
        <label className="field"><span>官方预设</span><SelectControl
          ariaLabel="官方 Provider 预设"
          value=""
          options={[{ value: '', label: '选择预设并填充', description: '自定义接口始终可用' }, ...PROVIDER_PRESETS.map((entry) => ({ value: entry.id, label: entry.displayName, description: entry.note }))]}
          disabled={busy}
          onChange={applyPreset}
        /></label>
        <label className="field"><span>名称</span><input value={custom.displayName} onChange={(event) => setCustom({ ...custom, displayName: event.target.value })} placeholder="例如：团队推理网关" /></label>
        <label className="field"><span>API Host（不含路径）</span><input value={custom.baseUrl} onChange={(event) => setCustom({ ...custom, baseUrl: event.target.value })} aria-describedby="provider-host-help" /></label>
        <p id="provider-host-help" className="muted small">公网仅 HTTPS；本地模式仅 localhost / 127.0.0.1 / ::1。私网、重定向和危险地址会被拒绝。</p>
        <div className="dw-provider-grid"><label className="field"><span>协议</span><SelectControl ariaLabel="Provider 协议" value={custom.protocol} options={[{ value: 'openai-chat', label: 'OpenAI Chat Completions' }, { value: 'openai-responses', label: 'OpenAI Responses' }, { value: 'anthropic-messages', label: 'Anthropic Messages' }]} disabled={busy} onChange={(protocol) => setCustom({ ...custom, protocol })} /></label><label className="field"><span>Chat 路径</span><input value={custom.chatPath} onChange={(event) => setCustom({ ...custom, chatPath: event.target.value })} /></label><label className="field"><span>Models 路径</span><input value={custom.modelsPath} onChange={(event) => setCustom({ ...custom, modelsPath: event.target.value })} /></label></div>
        <div className="dw-provider-grid"><label className="field"><span>认证 Header</span><input value={custom.authHeaderName} onChange={(event) => setCustom({ ...custom, authHeaderName: event.target.value })} placeholder="Authorization / x-api-key" /></label><label className="field"><span>额外 Header（JSON）</span><input value={custom.extraHeaders} onChange={(event) => setCustom({ ...custom, extraHeaders: event.target.value })} placeholder='{"X-Workspace":"team-a"}' /></label></div>
        <label className="field"><span>网络范围</span><SelectControl
          ariaLabel="网络范围"
          value={custom.scope}
          options={[
            { value: 'public_https', label: '公网 HTTPS', description: '仅允许受控的 HTTPS 地址' },
            { value: 'loopback_http', label: '本机开发', description: '仅 localhost / 127.0.0.1 / ::1' }
          ]}
          disabled={busy}
          onChange={(scope) => setCustom({ ...custom, scope })}
        /></label>
        <button className="btn primary" disabled={busy || !custom.displayName.trim()} onClick={() => void createProvider()}>创建 Provider</button>
      </details>

      {provider && <>
        <section className="dw-provider-block" aria-labelledby="provider-credentials-title"><h5 id="provider-credentials-title">凭据</h5>
          <div className="dw-provider-chips">{credentials.map((entry) => <button key={entry.id} className={provider.defaultCredentialRefId === entry.id ? 'active' : ''} onClick={() => void run(() => ds.credentialSetDefault(providerId, entry.id), '默认凭据已更新。')}>{entry.label} · {entry.status === 'ready' ? entry.maskedHint ?? '已加密' : entry.status}</button>)}</div>
          <div className="dw-provider-grid"><label className="field"><span>凭据名称</span><input value={credential.label} onChange={(event) => setCredential({ ...credential, label: event.target.value })} /></label><label className="field"><span>API Key</span><input type="password" autoComplete="new-password" value={credential.secret} onChange={(event) => setCredential({ ...credential, secret: event.target.value })} /></label></div>
          <button className="ghost-btn" disabled={busy || !credential.secret} onClick={() => void run(() => ds.credentialCreate(providerId, credential.label, credential.secret), '凭据已加密保存；明文不可读回。').then(() => setCredential({ ...credential, secret: '' }))}>保存新凭据</button>
        </section>

        <section className="dw-provider-block" aria-labelledby="provider-models-title"><div className="dw-provider-line"><h5 id="provider-models-title">模型</h5><button className="ghost-btn" disabled={busy || !provider.modelsPath} onClick={() => void run(() => ds.modelDiscoverPreview(providerId, provider.defaultCredentialRefId), '已获取模型预览。').then(async (preview: any) => { if (preview?.models?.length) await run(() => ds.modelAcceptDiscovered(preview.discoveryId, preview.models.map((entry: any) => entry.remoteModelId)), `已保存 ${preview.models.length} 个模型。`) })}>获取模型</button><button className="ghost-btn" disabled={busy} onClick={() => void run(() => ds.providerCheckConnection(providerId, provider.defaultCredentialRefId), '连接检查完成；未发送生成请求。')}>检查连接</button></div>
          <div className="dw-provider-models">{models.map((entry) => <button key={entry.id} className={profile.modelId === entry.id ? 'active' : ''} onClick={() => setProfile({ ...profile, modelId: entry.id, mode: 'default', effort: '' })}><strong>{entry.displayName}</strong><small>{capabilityLabel(entry)} · {entry.pricing ? `${entry.pricing.currency} ${entry.pricing.source === 'user_supplied' ? '用户参考价' : '官方参考价'}` : '费用未知'}</small></button>)}</div>
          {selectedModel && <details className="dw-provider-pricing"><summary>所选模型的计价参考</summary>
            <p className="muted small">参考价 ≠ 实际账单。你填写的价格标记为“用户提供”，仅用于新任务预算估算；留空费率保持未知，不代表免费。</p>
            <p className="muted small">绑定：{provider.displayName} · <code>{new URL(provider.baseUrl).origin}</code> · <code>{selectedModel.remoteModelId}</code></p>
            {selectedModel.pricing && <p className="muted small">当前来源：{selectedModel.pricing.source === 'user_supplied' ? '用户提供' : '官方参考'} · 核对于 {selectedModel.pricing.retrievedAt.slice(0, 10)}<br /><code title={selectedModel.pricing.priceProfileHash}>快照 {selectedModel.pricing.priceProfileHash.slice(0, 12)}</code></p>}
            <div className="dw-provider-grid"><label className="field"><span>币种（如 CNY / USD）</span><input aria-label="参考价币种" maxLength={3} disabled={busy} value={price.currency} onChange={(event) => setPrice({ ...price, currency: event.target.value.toUpperCase(), acknowledged: false })} /></label><label className="field"><span>生效日期</span><input aria-label="参考价生效日期" type="date" max={new Date().toISOString().slice(0, 10)} disabled={busy} value={price.date} onChange={(event) => setPrice({ ...price, date: event.target.value, acknowledged: false })} /></label></div>
            <p className="muted small">下列价格单位统一为：每 100 万 token。</p>
            <div className="dw-provider-grid">{([{ key: 'input', label: '输入参考价' }, { key: 'output', label: '输出参考价' }, { key: 'cacheHit', label: '缓存命中输入参考价' }, { key: 'cacheWrite', label: '缓存写入参考价' }, { key: 'reasoning', label: '单独推理参考价' }] as const).map(({ key, label }) => <label className="field" key={key}><span>{label}</span><input aria-label={label} type="number" min="0" max="1000000" step="any" placeholder={key === 'input' || key === 'output' ? '必填' : '未知（留空）'} disabled={busy} value={price[key]} onChange={(event) => setPrice({ ...price, [key]: event.target.value, acknowledged: false })} /></label>)}</div>
            <label className="field"><span>推理计费方式</span><SelectControl ariaLabel="参考价推理计费方式" value={price.rule} options={[{ value: 'unknown', label: '未知' }, { value: 'included_in_output', label: '已包含在输出价中' }, { value: 'separate', label: '单独计费' }]} disabled={busy} onChange={(rule) => setPrice({ ...price, rule, acknowledged: false })} /></label>
            <label className="field"><span>参考来源地址（可选）</span><input aria-label="参考价来源地址" placeholder="不含凭据或查询参数的 HTTP(S) 地址" disabled={busy} value={price.sourceUrl} onChange={(event) => setPrice({ ...price, sourceUrl: event.target.value, acknowledged: false })} /></label>
            <label className="dw-provider-check"><input type="checkbox" aria-label="确认参考价不是实际账单" checked={price.acknowledged} disabled={busy} onChange={(event) => setPrice({ ...price, acknowledged: event.target.checked })} />我确认这是用户参考价，不是实际账单；未知费用可能仍会阻止任务。</label>
            <button className="ghost-btn" disabled={busy || !price.acknowledged} onClick={() => void savePrice()}>保存用户参考价</button>
          </details>}
          {selectedModel && provider.adapterId === 'custom.openai-compatible-chat' && <button className="ghost-btn" disabled={busy} onClick={() => { if (window.confirm('能力探测会发送一次最小生成请求，可能产生费用。是否继续？')) void run(() => ds.modelProbe(selectedModel.id, profile.credentialRefId || provider.defaultCredentialRefId, true), '能力探测完成；结果和 usage 已持久化。') }}>探测所选模型推理能力</button>}
          <details><summary>手动添加模型</summary><div className="dw-provider-grid"><label className="field"><span>模型 ID</span><input aria-label="手动模型 ID" value={manual.remoteModelId} onChange={(event) => setManual({ ...manual, remoteModelId: event.target.value })} /></label><label className="field"><span>显示名称</span><input aria-label="手动模型名称" value={manual.displayName} onChange={(event) => setManual({ ...manual, displayName: event.target.value })} /></label></div>
            <details><summary>更多参数（用户声明）</summary><p className="muted small">以下 Token 上限由你声明，并非已验证规格。留空保持未知，不会按模型名称猜测；单次输出不能超过上下文上限。</p><div className="dw-provider-grid"><label className="field"><span>上下文上限（Token，可选）</span><input aria-label="手动模型上下文上限" type="number" min="1" max="100000000" step="1" value={manual.contextWindow} onChange={(event) => setManual({ ...manual, contextWindow: event.target.value })} /></label><label className="field"><span>单次输出上限（Token，可选）</span><input aria-label="手动模型单次输出上限" type="number" min="1" max="10000000" step="1" value={manual.maxOutputTokens} onChange={(event) => setManual({ ...manual, maxOutputTokens: event.target.value })} /></label></div></details>
            <label className="dw-provider-check"><input type="checkbox" checked={manual.reasoning} onChange={(event) => setManual({ ...manual, reasoning: event.target.checked })} />我确认该模型声明支持 reasoning（未验证）</label>{manual.reasoning && <label className="field"><span>允许的强度（逗号分隔）</span><input value={manual.efforts} onChange={(event) => setManual({ ...manual, efforts: event.target.value })} /></label>}<button className="ghost-btn" disabled={busy || !manual.remoteModelId} onClick={() => void addManualModel()}>保存模型</button></details>
        </section>

        <section className="dw-provider-block" aria-labelledby="provider-profiles-title"><h5 id="provider-profiles-title">写作 Profile</h5>
          <label className="field"><span>名称</span><input value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} placeholder="例如：长篇初稿" /></label>
          <div className="dw-provider-grid"><label className="field"><span>模型</span><SelectControl
            ariaLabel="Profile 模型"
            value={profile.modelId}
            options={[{ value: '', label: '选择模型', description: '先选择一个模型', disabled: models.length > 0 }, ...models.map((entry) => ({ value: entry.id, label: entry.displayName, description: capabilityLabel(entry) }))]}
            disabled={busy || models.length === 0}
            onChange={(modelId) => setProfile({ ...profile, modelId, mode: 'default', effort: '' })}
          /></label><label className="field"><span>凭据</span><SelectControl
            ariaLabel="Profile 凭据"
            value={profile.credentialRefId}
            options={[{ value: '', label: 'Provider 默认', description: '使用当前 Provider 的默认凭据' }, ...credentials.map((entry) => ({ value: entry.id, label: entry.label, description: entry.status === 'ready' ? entry.maskedHint ?? '已加密' : entry.status }))]}
            disabled={busy}
            onChange={(credentialRefId) => setProfile({ ...profile, credentialRefId })}
          /></label></div>
          {selectedModel && <><div className="dw-provider-grid"><label className="field"><span>推理模式</span><SelectControl
            ariaLabel="Profile 推理模式"
            value={profile.mode}
            options={reasoningModes.map((mode) => ({ value: mode, label: mode === 'default' ? '按模型默认' : mode === 'disabled' ? '关闭思考' : mode === 'adaptive' ? '模型自适应' : '开启思考', description: mode === 'enabled' ? '只发送模型支持的控制' : mode === 'disabled' ? '明确关闭推理' : mode === 'adaptive' ? '由模型自适应' : '不设置强度或推理预算' }))}
            disabled={busy}
            onChange={(mode) => setProfile({ ...profile, mode, effort: '' })}
          /></label>{profile.mode === 'enabled' && reasoningVerified && reasoning?.efforts.some(effort => effort !== 'enabled') && <label className="field"><span>推理强度</span><SelectControl
            ariaLabel="Profile 推理强度"
            value={profile.effort}
            options={[{ value: '', label: '按模型默认' }, ...(reasoning?.efforts ?? []).map((effort) => ({ value: effort, label: effort }))]}
            disabled={busy || reasoning?.efforts.length === 0}
            onChange={(effort) => setProfile({ ...profile, effort })}
          /></label>}{profile.mode === 'enabled' && reasoningVerified && reasoning?.budget && <label className="field"><span>推理 token 预算</span><input aria-label="推理 token 预算" type="number" min={reasoning.budget.min} max={reasoning.budget.max} step={reasoning.budget.step} value={profile.budgetTokens} placeholder="开启此模型思考时填写" onChange={event => setProfile({ ...profile, budgetTokens: event.target.value })} /></label>}</div>{!reasoningVerified && <p className="muted small">推理能力未验证：不会显示强度，也不会发送 reasoning 参数。</p>}
          <div className="dw-provider-grid dw-provider-grid-3"><label className="field"><span>Temperature</span><input type="number" min="0" max="2" step="0.1" disabled={provider.adapterId === 'builtin.deepseek' && profile.mode === 'enabled'} value={profile.temperature} onChange={(event) => setProfile({ ...profile, temperature: event.target.value })} /></label><label className="field"><span>Top P</span><input type="number" min="0" max="1" step="0.05" disabled={provider.adapterId === 'builtin.deepseek' && profile.mode === 'enabled'} value={profile.topP} onChange={(event) => setProfile({ ...profile, topP: event.target.value })} /></label><label className="field"><span>最大输出</span><input type="number" min="1" placeholder="按模型默认" value={profile.maxOutputTokens} onChange={(event) => setProfile({ ...profile, maxOutputTokens: event.target.value })} /></label></div>{provider.adapterId === 'builtin.deepseek' && profile.mode === 'enabled' && <p className="muted small">DeepSeek thinking 开启时，Temperature 与 Top P 保留但本模式不发送。</p>}</>}
          <button className="btn primary" disabled={busy || !profile.modelId} onClick={() => void saveProfile()}>保存并用于新任务</button>
          {profiles.length > 0 && <div className="dw-provider-profile-list">{profiles.map((entry) => <button key={entry.id} onClick={() => void run(() => ds.profileSetBindings({ defaultProfileId: entry.id }), '默认 Profile 已更新。')}><span>{entry.name}</span><small>{entry.id === activeProfileId ? '当前默认' : entry.reasoning.mode}</small></button>)}</div>}
        </section>
      </>}

      <details className="dw-provider-block"><summary>导入与导出（不含密钥）</summary>
        <div className="dw-provider-line"><button className="ghost-btn" onClick={() => void run(() => ds.registryExport(), '配置已生成；确认后再复制。').then((bundle) => { if (bundle) setBundleText(JSON.stringify(bundle, null, 2)) })}>生成导出内容</button><button className="ghost-btn" disabled={!bundleText.trim()} onClick={() => { try { const parsed = JSON.parse(bundleText); void run(() => ds.registryImportPreview(parsed), '导入预览完成；尚未写入，也未联网。').then((preview) => setImportPreview(preview as ImportPreview | null)) } catch { setMessage('导入内容不是有效 JSON') } }}>预览导入</button></div>
        <textarea aria-label="Provider 配置 JSON" rows={8} value={bundleText} onChange={(event) => { setBundleText(event.target.value); setImportPreview(null) }} />
        {importPreview && <div className="dw-import-preview"><strong>预览：{importPreview.bundle.providers.length} 个 Provider，{importPreview.bundle.models.length} 个模型</strong><span>{importPreview.collisions.length > 0 ? `有 ${importPreview.collisions.length} 个冲突，不能提交` : '未发现冲突；文件不含凭据'}</span><button className="btn primary" disabled={importPreview.collisions.length > 0 || busy} onClick={() => void run(() => ds.registryImportCommit(importPreview.previewId), '导入完成；请为 Provider 单独配置凭据。').then(() => setImportPreview(null))}>确认导入</button></div>}
      </details>
      {message && <p className="dw-provider-message" role="status">{message}</p>}
    </div>
  )
}
