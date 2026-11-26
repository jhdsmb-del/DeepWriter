import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MODELS } from '../../../shared/types'
import { DEEPSEEK_REASONING_EFFORTS, normalizeDeepSeekReasoningEffort } from '../../../shared/deepseekReasoning'
import type { ModelRecord, ProfileRecord, ProviderRegistrySnapshot, StageProfileBindings } from '../../../shared/providerRegistry'
import { useStore } from '../store'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { usePresence } from '../hooks/usePresence'
import Icon from './Icon'
import { ensureProviderRegistry } from '../providerRegistryResource'

const EFFORT_LABELS: Record<string, string> = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', enabled: '开' }
const DEFAULT_EFFORTS = [...DEEPSEEK_REASONING_EFFORTS]

type RegistryResult<T> = { ok: true; data: T } | { ok: false; error?: { message?: string } }

interface QuickModelOption {
  /** Registry model id (or a namespaced legacy key); never a remote id. */
  id: string
  remoteModelId: string
  label: string
  description: string
  record: ModelRecord | null
  profile: ProfileRecord | null
  efforts: string[]
  reasoningSupported: boolean
  source: ModelRecord['source'] | 'builtin'
}

function isVerifiedReasoning(model: ModelRecord | null): boolean {
  const evidence = model?.capabilities.reasoning
  return evidence?.state === 'supported' && (evidence.source === 'protocol_probe' || evidence.source === 'builtin_manifest' || Boolean(evidence.mappingId) && ['model_catalog', 'models_endpoint'].includes(evidence.source ?? ''))
}

function modelOptions(snapshot: ProviderRegistrySnapshot | null, currentModel: string): QuickModelOption[] {
  const registryModels = (snapshot?.models ?? []).filter((model) => model.enabled)
  const options: QuickModelOption[] = []
  const seen = new Set<string>()
  const add = (id: string, remoteModelId: string, label: string, description: string, record: ModelRecord | null, source: QuickModelOption['source']): void => {
    if (seen.has(id)) return
    seen.add(id)
    const matchingProfile = record && snapshot
      ? snapshot.profiles.find((profile) => profile.modelId === record.id) ?? null
      : null
    const verified = isVerifiedReasoning(record)
    const efforts = verified
      ? [...new Set(record?.capabilities.reasoning.efforts ?? [])]
      : source === 'builtin' && !snapshot ? [...DEFAULT_EFFORTS] : []
    const detail = source === 'builtin'
      ? `${description}${snapshot && !record ? ' · 未配置' : ''}`
      : record
        ? `${snapshot?.providers.find((provider) => provider.id === record.providerId)?.displayName ?? '自定义 Provider'} · ${record.remoteModelId}`
        : description
    options.push({
      id,
      remoteModelId,
      label,
      description: detail,
      record,
      profile: matchingProfile,
      efforts,
      reasoningSupported: source === 'builtin' && !snapshot ? true : verified && efforts.length > 0,
      source
    })
  }

  for (const model of MODELS) {
    const record = registryModels.find((candidate) => candidate.remoteModelId === model.id && snapshot?.providers.find((provider) => provider.id === candidate.providerId)?.adapterId === 'builtin.deepseek') ?? null
    const friendlyName = model.name.replace(/（旧[^）]*名称）$/u, '')
    const providerLabel = snapshot?.providers.find((provider) => provider.id === record?.providerId)?.displayName ?? 'DeepSeek'
    const aliasTag = model.name.match(/（(旧[^）]+)）$/u)?.[1]
    const identityDetail = [providerLabel, model.id, aliasTag].filter(Boolean).join(' · ')
    add(record?.id ?? `legacy:${model.id}`, model.id, friendlyName, identityDetail, record, 'builtin')
  }
  for (const record of registryModels) add(record.id, record.remoteModelId, record.displayName, record.source === 'manual' ? '手动录入 · 需在设置中管理' : 'Provider 模型', record, record.source)
  if (!options.some((option) => option.remoteModelId === currentModel) && currentModel) {
    const record = registryModels.find((candidate) => candidate.remoteModelId === currentModel) ?? null
    add(record?.id ?? `legacy:${currentModel}`, currentModel, record?.displayName ?? currentModel, '当前设置中的模型', record, record?.source ?? 'manual')
  }
  // The catalog contains legacy aliases for one friendly model name. Fold
  // only unavailable catalog placeholders; never merge real configured
  // records, Providers, Profiles, or change a selection's remote identity.
  const effectiveProfileId = snapshot?.bindings?.draftProfileId ?? snapshot?.bindings?.defaultProfileId
  const activeModelId = snapshot?.profiles.find((profile) => profile.id === effectiveProfileId)?.modelId
  const placeholderGroups = new Map<string, QuickModelOption[]>()
  for (const option of options) {
    if (option.source !== 'builtin' || option.record && option.profile) continue
    const group = placeholderGroups.get(option.label) ?? []
    group.push(option)
    placeholderGroups.set(option.label, group)
  }
  const foldedIds = new Set<string>()
  for (const [label, placeholders] of placeholderGroups) {
    const configured = options.some((option) => option.source === 'builtin' && option.label === label && option.record && option.profile)
    const active = placeholders.find((option) => activeModelId ? option.record?.id === activeModelId : option.remoteModelId === currentModel)
    const canonical = placeholders.find((option) => !MODELS.find((model) => model.id === option.remoteModelId)?.name.includes('（旧'))
    const retained = active ?? (configured ? null : canonical ?? placeholders[0])
    for (const option of placeholders) if (option !== retained) foldedIds.add(option.id)
  }
  return options.filter((option) => !foldedIds.has(option.id))
}

function profileInput(profile: ProfileRecord, reasoning: ProfileRecord['reasoning'], compatibilityMappingId = profile.compatibilityMappingId): Omit<ProfileRecord, 'createdAt' | 'updatedAt'> {
  return {
    id: profile.id,
    name: profile.name,
    providerId: profile.providerId,
    modelId: profile.modelId,
    credentialRefId: profile.credentialRefId,
    generation: profile.generation,
    reasoning,
    compatibilityMappingId
  }
}

function formatEffort(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort
}

function legacyEffort(effort: string): 'low' | 'medium' | 'high' | 'max' {
  return effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max' ? effort : 'high'
}

export default function ModelReasoningControl({
  onOpenSettings,
  onOpenContext,
  snapshot,
  refreshSnapshot
}: {
  snapshot: ProviderRegistrySnapshot | null
  refreshSnapshot: () => Promise<ProviderRegistrySnapshot | null>
  onOpenSettings?: () => void
  onOpenContext?: () => void
}): React.ReactNode {
  const settings = useStore((state) => state.settings)
  const updateSettings = useStore((state) => state.updateSettings)
  const showToast = useStore((state) => state.showToast)
  const [open, setOpen] = useState(false)
  const present = usePresence(open)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'strength' | 'models' | 'advanced'>('strength')
  const [previewStop, setPreviewStop] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const modelListRef = useRef<HTMLDivElement>(null)
  const strengthRef = useRef<HTMLInputElement>(null)
  const restoreStrengthFocusRef = useRef(false)
  const close = useCallback(() => setOpen(false), [])
  const panelRef = useDialogFocus<HTMLDivElement>(open, close)
  const currentModel = settings?.model ?? MODELS[0].id
  const options = useMemo(() => modelOptions(snapshot, currentModel), [currentModel, snapshot])
  const effectiveProfileId = snapshot?.bindings?.draftProfileId ?? snapshot?.bindings?.defaultProfileId
  const boundProfile = effectiveProfileId
    ? snapshot?.profiles.find((profile) => profile.id === effectiveProfileId) ?? null
    : null
  const boundModel = boundProfile ? snapshot?.models.find((model) => model.id === boundProfile.modelId) ?? null : null
  const authoritativeModel = boundModel?.id ?? options.find((option) => option.remoteModelId === currentModel)?.id ?? options[0]?.id ?? ''
  const selected = options.find((option) => option.id === authoritativeModel) ?? options[0]
  const selectedProfile = boundProfile
  const selectedProvider = snapshot?.providers.find((provider) => provider.id === selected?.record?.providerId)
  const selectedCredential = selectedProfile?.credentialRefId ?? selectedProvider?.defaultCredentialRefId
  const missingCredential = selectedProvider?.authStyle === 'bearer' && !snapshot?.credentials.some(entry => entry.id === selectedCredential && entry.status === 'ready')
  const registryIsAuthoritative = Boolean(snapshot && boundProfile && boundModel)
  const automaticReasoning = registryIsAuthoritative ? selectedProfile?.reasoning.mode === 'default' : settings?.reasoningEffort === 'default' && settings.thinkingEnabled
  const configuredThinkingEnabled = registryIsAuthoritative
    ? selectedProfile?.reasoning.mode === 'enabled' || selectedProfile?.reasoning.mode === 'adaptive'
    : settings?.thinkingEnabled ?? false
  const configuredEffort = registryIsAuthoritative ? selectedProfile?.reasoning.effort ?? '' : settings?.reasoningEffort ?? 'default'
  const builtinReasoning = selectedProvider?.adapterId === 'builtin.deepseek' || !snapshot && selected?.source === 'builtin'
  const defaultStrength = configuredEffort === '' || configuredEffort === 'default'
  const normalizedEffort = builtinReasoning && !defaultStrength ? normalizeDeepSeekReasoningEffort(configuredEffort) : configuredEffort
  const thinkingEnabled = configuredThinkingEnabled && normalizedEffort !== 'none'
  const currentEffort = normalizedEffort === 'none' ? '' : normalizedEffort ?? configuredEffort
  const selectedEffort = currentEffort
  const hasExplicitOff = builtinReasoning || Boolean(selected?.record?.capabilities.reasoning.modes.includes('disabled'))
  const strengthOffset = hasExplicitOff ? 2 : 1
  const stops = ['默认', ...(hasExplicitOff ? ['关'] : []), ...(selected?.efforts ?? []).map(formatEffort)]
  const currentStop = automaticReasoning || thinkingEnabled && defaultStrength ? 0 : thinkingEnabled ? (selected?.efforts.indexOf(currentEffort) ?? -1) + strengthOffset : hasExplicitOff ? 1 : 0

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', closeOutside)
    return () => window.removeEventListener('pointerdown', closeOutside)
  }, [open])

  useEffect(() => {
    if (busy || !restoreStrengthFocusRef.current) return
    restoreStrengthFocusRef.current = false
    // A temporarily disabled range can drop focus to body while its Profile
    // is saved. Keep successive keyboard steps usable without stealing focus
    // from a user who deliberately clicked another control.
    if (open && document.activeElement === document.body) strengthRef.current?.focus()
  }, [busy, open])

  const applySelection = async (option: QuickModelOption, thinking: boolean, effort: string, resetToDefault = false): Promise<boolean> => {
    if (!settings || busy) return false
    setBusy(true)
    try {
      const ds = (window as any).ds
      const nextSnapshot = await refreshSnapshot()
      const nextOption = option
      if (!nextSnapshot) {
        const ok = await updateSettings({ model: option.remoteModelId, thinkingEnabled: resetToDefault || thinking, reasoningEffort: resetToDefault ? 'default' : legacyEffort(effort) })
        if (ok) showToast('模型与思考强度已更新；下一次运行生效', 'success')
        return ok
      }
      if (!nextOption.record) {
        showToast('请先在设置中完成这个模型的 Provider 与 Profile 配置', 'info')
        return false
      }
      const profiles = nextSnapshot?.profiles.filter((profile) => profile.modelId === nextOption.record?.id) ?? []
      const effectiveId = nextSnapshot.bindings?.draftProfileId ?? nextSnapshot.bindings?.defaultProfileId
      let profile = profiles.find((entry) => entry.id === effectiveId) ?? profiles[0] ?? null
      if (!profile) {
        const created = await ds.profileUpsert({
          id: `profile.model.${nextOption.record.id}`,
          name: nextOption.record.displayName,
          providerId: nextOption.record.providerId,
          modelId: nextOption.record.id,
          credentialRefId: null,
          generation: { temperature: null, topP: null, maxOutputTokens: null, stream: true },
          reasoning: { mode: 'default', effort: null, budgetTokens: null },
          compatibilityMappingId: null
        }) as RegistryResult<ProfileRecord>
        if (!created.ok) { showToast(created.error?.message ?? '模型配置未保存，请重试', 'error'); return false }
        profile = created.data
      }
      const provider = nextSnapshot.providers.find((entry) => entry.id === nextOption.record?.providerId)
      const isBuiltin = provider?.adapterId === 'builtin.deepseek'
      const nextReasoning: ProfileRecord['reasoning'] = resetToDefault ? { mode: 'default', effort: null, budgetTokens: null } : isBuiltin
        ? thinking
          ? { mode: 'enabled', effort, budgetTokens: null }
          : { mode: 'disabled', effort: null, budgetTokens: null }
        : thinking && nextOption.reasoningSupported
          ? { mode: 'enabled', effort, budgetTokens: null }
          : { mode: !resetToDefault && nextOption.record.capabilities.reasoning.modes.includes('disabled') ? 'disabled' : 'default', effort: null, budgetTokens: null }
      const compatibilityMappingId = !isBuiltin && nextReasoning.mode !== 'default'
        ? nextOption.record.capabilities.reasoning.mappingId ?? (provider?.transportPolicy.protocol === 'openai-responses' ? 'openai_responses.reasoning_effort'
          : provider?.transportPolicy.protocol === 'anthropic-messages' ? 'anthropic.thinking'
            : 'openai_chat.reasoning_effort_top_level')
        : null
      const upsert = await ds?.profileUpsert?.(profileInput(profile, nextReasoning, compatibilityMappingId)) as RegistryResult<ProfileRecord> | undefined
      if (!upsert?.ok) {
        showToast(upsert?.error?.message ?? 'Profile 更新失败，请打开设置查看', 'error')
        return false
      }
      profile = upsert.data
      const bindings: StageProfileBindings = { ...(nextSnapshot.bindings ?? {}), defaultProfileId: profile.id, draftProfileId: profile.id }
      const bindingResult = await ds?.profileSetBindings?.(bindings) as RegistryResult<void> | undefined
      if (!bindingResult?.ok) {
        showToast(bindingResult?.error?.message ?? '新任务 Profile 更新失败', 'error')
        return false
      }
      await refreshSnapshot()
      showToast(`${nextOption.label} · ${nextReasoning.mode === 'enabled' ? `思考${formatEffort(effort)}` : nextReasoning.mode === 'default' ? '默认' : '思考关'}已用于新任务`, 'success')
      return true
    } catch {
      await refreshSnapshot()
      showToast('模型配置更新失败，请检查后重试', 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const chooseModel = (option: QuickModelOption): void => {
    const nextThinking = option.reasoningSupported && thinkingEnabled && !automaticReasoning && option.efforts.includes(currentEffort)
    void applySelection(option, nextThinking, option.efforts.includes(currentEffort) ? currentEffort : option.efforts[0] ?? currentEffort, !nextThinking).then(ok => { if (ok) setView('strength') })
  }

  const commitStop = (index: number): void => {
    setPreviewStop(null)
    if (!selected || !selected.reasoningSupported) return
    if (index === currentStop) return
    const enabled = index >= strengthOffset
    const effort = enabled ? selected.efforts[index - strengthOffset] : selectedEffort
    if (enabled && !effort) return
    restoreStrengthFocusRef.current = document.activeElement === strengthRef.current
    void applySelection(selected, enabled, effort, index === 0)
  }

  const moveFocus = (root: HTMLDivElement | null, delta: number): void => {
    if (!root) return
    const items = [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(index + delta + items.length) % items.length]?.focus()
  }

  const openPanel = (): void => {
    if (!settings) return
    if (!open) void ensureProviderRegistry()
    setView('strength')
    setPreviewStop(null)
    setOpen((value) => !value)
  }

  const unavailableReason = !selected?.reasoningSupported
    ? selected?.record?.capabilities.reasoning.state === 'unsupported'
      ? '此模型不支持思考强度，暂不可切换。'
      : isVerifiedReasoning(selected?.record ?? null)
        ? '此模型由自身决定思考方式，不提供可调档位。'
        : selected?.record?.capabilities.reasoning.state === 'supported' ? '此模型由自身决定思考方式，不提供可调档位。' : '未找到该模型的思考规格，可在设置中更新规格。'
    : !automaticReasoning && !defaultStrength && thinkingEnabled && currentStop === 0
      ? '当前强度不在此模型已验证的选项中，请到模型设置检查。'
      : null
  const effortText = unavailableReason || automaticReasoning || thinkingEnabled && defaultStrength ? '默认' : thinkingEnabled ? formatEffort(selectedEffort) : '思考关'
  const displayStop = previewStop ?? currentStop
  const sliderStyle = { '--dw-strength-progress': `${stops.length > 1 ? displayStop / (stops.length - 1) * 100 : 0}%` } as CSSProperties
  return (
    <div ref={rootRef} className="dw-model-reasoning-control">
      <button
        type="button"
        className={`dw-model-reasoning-trigger${open ? ' open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="dw-model-reasoning-panel"
        aria-label={`当前模型 ${selected?.label ?? '模型'}${selectedProvider ? ` · ${selectedProvider.displayName}` : ''}，${effortText}；打开模型与思考选择`}
        data-testid="model-reasoning-trigger"
        disabled={!settings}
        onClick={openPanel}
      >
        <span className="dw-model-reasoning-model">{selected?.label ?? '模型'}</span>
        <Icon name="chevronDown" size={13} />
      </button>
      {present && (
        <div
          ref={panelRef}
          id="dw-model-reasoning-panel"
          className="dw-model-reasoning-panel"
          data-state={open ? 'open' : 'closing'}
          inert={!open}
          aria-hidden={!open}
          role="dialog"
          aria-modal="false"
          aria-label="模型与思考"
          tabIndex={-1}
          data-testid="model-reasoning-panel"
          aria-busy={busy}
        >
          <div className="dw-model-reasoning-head">
            {view === 'strength'
              ? <button type="button" className="dw-model-reasoning-close dw-model-advanced-entry" aria-label="高级" title="高级设置" onClick={() => setView('advanced')}><Icon name="settings" size={15} /></button>
              : <button type="button" className="dw-model-reasoning-back" onClick={() => setView('strength')}><Icon name="arrowLeft" size={16} />{view === 'models' ? '选择模型' : '高级设置'}</button>}
            <button type="button" className="dw-model-reasoning-close" aria-label="关闭模型与思考" title="关闭模型与思考" onClick={() => setOpen(false)}><Icon name="close" size={14} /></button>
          </div>
          {view === 'strength' && <div className="dw-model-strength-view">
            <strong className="dw-model-strength-value" aria-live="polite">{previewStop === null ? effortText : stops[previewStop]}</strong>
            <button type="button" className="dw-model-current" onClick={() => setView('models')} aria-label="选择模型"><span>{selected?.label ?? '模型'}</span><Icon name="chevronDown" size={13} /></button>
            {missingCredential && onOpenSettings && <button type="button" className="ghost-btn" onClick={() => { setOpen(false); onOpenSettings() }}>配置 {selectedProvider?.displayName.replace(/\s*[（(].*$/, '')} 的 API Key</button>}
            <input
              ref={strengthRef}
              type="range"
              min={0}
              max={Math.max(0, stops.length - 1)}
              step={1}
              value={previewStop ?? currentStop}
              aria-label="思考强度"
              aria-valuetext={previewStop === null ? effortText : stops[previewStop]}
              aria-describedby={unavailableReason ? 'dw-model-strength-unavailable' : undefined}
              style={sliderStyle}
              disabled={busy || Boolean(unavailableReason)}
              onChange={event => setPreviewStop(Number(event.target.value))}
              onPointerUp={event => commitStop(Number(event.currentTarget.value))}
              onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) commitStop(Number(event.currentTarget.value)) }}
              onBlur={event => { if (previewStop !== null) commitStop(Number(event.currentTarget.value)) }}
            />
            {unavailableReason && <details className="dw-model-strength-unavailable"><summary tabIndex={0}>为何不可调</summary><p id="dw-model-strength-unavailable" className="dw-model-reasoning-help">{unavailableReason}</p></details>}
          </div>}
          {view === 'models' && <div className="dw-model-reasoning-group">
            <div ref={modelListRef} className="dw-model-reasoning-models" role="listbox" aria-label="模型">
              {options.map((option) => {
                const unavailable = Boolean(snapshot && (!option.record || !snapshot.providers.some(provider => provider.id === option.record?.providerId && provider.enabled)))
                const providerName = snapshot?.providers.find(provider => provider.id === option.record?.providerId)?.displayName
                return (
                  <button
                    type="button"
                    role="option"
                    aria-label={providerName ? `${option.label} · ${providerName}` : option.label}
                    title={[providerName, option.remoteModelId].filter(Boolean).join(' · ')}
                    aria-selected={selected?.id === option.id}
                    aria-disabled={unavailable}
                    disabled={busy || unavailable}
                    className={`dw-model-reasoning-option${selected?.id === option.id ? ' selected' : ''}`}
                    key={option.id}
                    onClick={() => chooseModel(option)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); moveFocus(modelListRef.current, 1) }
                      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); moveFocus(modelListRef.current, -1) }
                    }}
                  >
                    <span><b>{option.label}</b></span>
                    {selected?.id === option.id && <Icon name="check" className="dw-model-reasoning-check" />}
                  </button>
                )
              })}
            </div>
          </div>}
          {view === 'advanced' && <div className="dw-model-reasoning-secondary" aria-label="高级运行设置">
            <details className="dw-model-identity"><summary tabIndex={0}>模型详情</summary><dl>
              <div><dt>提供方</dt><dd>{selectedProvider?.displayName ?? '未配置'}</dd></div>
              <div><dt>模型 ID</dt><dd>{selected?.remoteModelId ?? '—'}</dd></div>
              {selected?.record?.contextWindow && <div><dt>上下文</dt><dd>{selected.record.contextWindow.toLocaleString()} tokens</dd></div>}
              {selected?.record?.maxOutputTokens && <div><dt>最大输出</dt><dd>{selected.record.maxOutputTokens.toLocaleString()} tokens</dd></div>}
              <div><dt>Profile</dt><dd>{selectedProfile?.name ?? '未配置'}</dd></div>
              {unavailableReason && <div><dt>思考强度</dt><dd>{unavailableReason}</dd></div>}
            </dl></details>
            {onOpenContext && <button type="button" className="dw-model-reasoning-secondary-action" onClick={() => { setOpen(false); onOpenContext() }}>查看本次上下文明细</button>}
          {onOpenSettings && <button type="button" className="dw-model-reasoning-manage" onClick={() => { setOpen(false); onOpenSettings() }}>接口、价格与模型详情 <Icon name="open" size={13} /></button>}
          <p className="dw-model-reasoning-scope">仅对新任务生效。</p>
          </div>}
        </div>
      )}
    </div>
  )
}
