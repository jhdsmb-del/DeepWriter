import type { ProjectBrief } from '../../../shared/projectBrief'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore, type DirSettingValue, wp7FeatureFlagsEnabled, wp7FeatureFlagsForToggle } from '../store'
import type { PermissionAction, PermissionMode, PermissionRule, PermissionTargetType, Settings } from '../../../shared/types'
import Icon from './Icon'
import SelectControl from './SelectControl'
import Switch from './Switch'
import { useDialogFocus } from '../hooks/useDialogFocus'
import ProviderRegistryPanel from './ProviderRegistryPanel'
import ExtensionsPanel from './ExtensionsPanel'
import { changedSettings } from '../settingsDraft'
import AgentRunLimits, { agentRunBudgetError } from './AgentRunLimits'
import DesktopUpdatesPanel from './DesktopUpdatesPanel'

/** 路径字段在 draft 中可能是 {value, dirRefId}（选择器签发）或纯字符串（未变更） */
type DraftSettings = Omit<Settings, 'workDir' | 'docDir' | 'galgame'> & {
  workDir: DirSettingValue
  docDir: DirSettingValue
  galgame: { enabled: boolean; projectDir: DirSettingValue; sdkPath: DirSettingValue }
}

const dirText = (v: DirSettingValue): string => (typeof v === 'string' ? v : v.value)

const MODE_CARDS: { id: PermissionMode; label: string; desc: string }[] = [
  { id: 'safe', label: '严格确认', desc: '文件访问与命令执行逐项确认；可只允许本任务内同类文件操作' },
  { id: 'auto', label: '工作区自动', desc: '所选工作区内读取、新建普通文档和保留原稿的局部编辑自动进行；覆盖、外部路径和敏感操作仍需确认' },
  { id: 'off', label: '本次全开', desc: '仅当前窗口，高风险' }
]

const TYPE_LABELS: Record<PermissionTargetType, string> = {
  command: '命令',
  path: '路径'
}

const ACTION_LABELS: Record<PermissionAction, string> = {
  allow: '允许',
  deny: '拒绝',
  ask: '询问'
}

export default function SettingsModal({ onClose, initialSection }: { onClose: () => void; initialSection?: 'updates' }): React.ReactNode {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const permissions = useStore((s) => s.permissions)
  const updatePermissions = useStore((s) => s.updatePermissions)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const loadPermissions = useStore((s) => s.loadPermissions)
  const memory = useStore((s) => s.memory)
  const loadMemory = useStore((s) => s.loadMemory)
  const showToast = useStore((s) => s.showToast)
  const [draft, setDraft] = useState<DraftSettings | null>(() => settings ? { ...settings } : null)
  const baselineRef = useRef<Settings | null>(settings)
  const [saving, setSaving] = useState(false)
  const [briefEdit, setBriefEdit] = useState<{ prior: ProjectBrief; text: string } | null>(null)
  const [briefConflict, setBriefConflict] = useState('')
  const providerSaveRef = useRef<(() => Promise<boolean>) | null>(null)
  const registerProviderSave = useCallback((save: (() => Promise<boolean>) | null) => { providerSaveRef.current = save }, [])
  const [showKey, setShowKey] = useState(false)
  const [ruleType, setRuleType] = useState<PermissionTargetType>('command')
  const [rulePattern, setRulePattern] = useState('')
  const [ruleAction, setRuleAction] = useState<PermissionAction>('allow')
  const [ruleOnce, setRuleOnce] = useState(false)
  const [section, setSection] = useState<'provider' | 'completion' | 'workspace' | 'permissions' | 'extensions' | 'galgame' | 'memory' | 'experimental' | 'updates'>(initialSection ?? 'provider')
  useEffect(() => { if (initialSection) setSection(initialSection) }, [initialSection])
  const dismiss = useCallback(() => {
    const current = useStore.getState().settings
    baselineRef.current = current
    setDraft(current ? { ...current } : null)
    setBriefEdit(null); setBriefConflict('')
    onClose()
  }, [onClose])
  const dialogRef = useDialogFocus<HTMLDivElement>(Boolean(settings && draft), dismiss, !saving)

  useEffect(() => {
    void loadPermissions()
    void loadMemory()
  }, [loadPermissions, loadMemory])

  useEffect(() => {
    if (settings && !draft) {
      baselineRef.current = settings
      setDraft({ ...settings })
    }
  }, [settings, draft])

  if (!settings || !draft) return null

  const perms = permissions ?? { mode: 'safe' as PermissionMode, rules: [] as PermissionRule[] }

  const chooseDir = async (target: 'docDir' | 'workDir'): Promise<void> => {
    const r = await (window as any).ds?.chooseDir('settings')
    if (r) setDraft({ ...draft, [target]: { value: r.path, dirRefId: r.view.fileRefId } })
  }

  const chooseSdk = async (): Promise<void> => {
    const ds = (window as any).ds
    if (!ds?.chooseSdkDirectory) return
    const r = await ds.chooseSdkDirectory()
    if (r) setDraft({ ...draft, galgame: { ...draft.galgame, sdkPath: { value: r.path, dirRefId: r.view.fileRefId } } })
  }

  const addRule = (): void => {
    const pattern = rulePattern.trim()
    if (!pattern) return
    const rule: PermissionRule = {
      id: crypto.randomUUID(),
      type: ruleType,
      pattern,
      action: ruleAction,
      persistent: !ruleOnce
    }
    updatePermissions({ rules: [...perms.rules, rule] })
    setRulePattern('')
  }

  const removeRule = (id: string): void => {
    updatePermissions({ rules: perms.rules.filter((r) => r.id !== id) })
  }

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const budgetError = agentRunBudgetError(draft.agentRunBudget)
      if (budgetError) { setSection('completion'); showToast(budgetError, 'error'); return }
      if (providerSaveRef.current && !await providerSaveRef.current()) { setSection('provider'); return }
      const baseUrl = draft.baseUrl.trim()
      if (baseUrl) {
        let valid = false
        try {
          const u = new URL(baseUrl)
          valid = u.protocol === 'http:' || u.protocol === 'https:'
        } catch {
          valid = false
        }
        if (!valid) {
          showToast('API Base URL 必须是 http(s) 地址', 'error')
          return
        }
      }
      const baseline = baselineRef.current ?? settings
      const next = changedSettings(baseline, { ...draft, baseUrl, apiKey: draft.apiKey.trim() || baseline.apiKey })
      if (briefEdit && briefEdit.text !== briefEdit.prior.text) {
        if (next.workDir) { showToast('请单独保存工作目录，再编辑新项目的约定', 'error'); return }
        try {
          const saved = await window.ds.saveProjectBrief({ path: briefEdit.prior.path, text: briefEdit.prior.text, exists: briefEdit.prior.state === 'ready' }, briefEdit.text)
          if (!saved.ok) { setSection('memory'); setBriefConflict(saved.message); return }
          setBriefEdit(null); setBriefConflict(''); await loadMemory()
        } catch (err) { setSection('memory'); setBriefConflict((err as Error).message); return }
      }
      if (Object.keys(next).length === 0) { onClose(); return }
      const ok = await update(next)
      if (!ok) return
      onClose()
      showToast('设置已保存', 'success')
    } finally { setSaving(false) }
  }

  const clearKey = async (): Promise<void> => {
    const next = { ...draft, apiKey: '' }
    setDraft(next)
    setSaving(true)
    const ok = await update({ apiKey: '' })
    setSaving(false)
    if (ok) showToast('API Key 已清除', 'success')
  }

  return (
    <div className="modal-overlay dw-dialog-overlay">
      <div ref={dialogRef} tabIndex={-1} className="modal dw-dialog dw-settings-modal" role="dialog" aria-modal="true" aria-labelledby="dw-settings-title">
        <div className="modal-head">
          <h3 id="dw-settings-title">设置</h3>
          <button className="dw-settings-close" aria-label="关闭设置" title="关闭" onClick={dismiss}><Icon name="close" /></button>
        </div>
        <div className="dw-settings-layout">
          <nav className="dw-settings-nav" aria-label="设置分类">
            {([
              ['provider', '模型与接口', 'model'],
              ['completion', '完成与预算', 'check'],
              ['workspace', '工作区', 'folder'],
              ['permissions', '权限', 'shield'],
              ['extensions', '扩展', 'tools'],
              ['galgame', 'Galgame', 'game'],
              ['memory', '项目约定', 'memory'],
              ['experimental', '实验', 'flask'],
              ['updates', '应用更新', 'check']
            ] as const).map(([id, label, icon]) => (
              <button key={id} aria-current={section === id ? 'page' : undefined} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>
                <Icon name={icon} /><span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="modal-body">
          {section === 'updates' && <DesktopUpdatesPanel />}
          {section === 'extensions' && <section className="dw-settings-page"><div className="dw-settings-page-head"><h4>扩展</h4></div><ExtensionsPanel /></section>}
          <section className="dw-settings-page" hidden={section !== 'provider'}>
          <ProviderRegistryPanel onRegisterSave={registerProviderSave} />
          <details className="dw-provider-legacy"><summary>旧版 DeepSeek 兼容设置</summary>
          <label className="field">
            <span>API Key（platform.deepseek.com 获取）</span>
            <div className="key-row">
              <input
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey === '__CONFIGURED__' ? '' : draft.apiKey}
                placeholder={draft.apiKey === '__CONFIGURED__' ? '已配置，输入新值覆盖' : 'sk-...'}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
              <button className="ghost-btn" onClick={() => setShowKey(!showKey)}>
                {showKey ? '隐藏' : '显示'}
              </button>
              <button className="ghost-btn danger" onClick={() => void clearKey()} disabled={saving}>
                清除密钥
              </button>
            </div>
          </label>
          <label className="field">
            <span>API Base URL</span>
            <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
          </label>
          </details>
          </section>
          {section === 'completion' && <section className="dw-settings-page">
            <div className="dw-settings-page-head"><h4>完成与预算</h4></div>
            <AgentRunLimits value={draft.agentRunBudget} onChange={agentRunBudget => setDraft({ ...draft, agentRunBudget })} />
            <details className="dw-writing-settings">
            <summary>长文与写作检查</summary>
            <div className="dw-constraint-settings" data-testid="strong-constraint-settings">
              <label className="field">
                <span>主题锁定</span>
                <SelectControl
                  value={draft.themeLockMode ?? ((draft.strongConstraintEnabled ?? true) ? 'strong' : 'off')}
                  options={[
                    { value: 'strong', label: '锁定', description: '核心命题明显跑偏时不交付' },
                    { value: 'guided', label: '引导', description: '保留主题方向，也允许自然延展' },
                    { value: 'off', label: '关闭', description: '不使用自动主题锚点' }
                  ]}
                  onChange={(value) => setDraft({ ...draft, themeLockMode: value, strongConstraintEnabled: value !== 'off' })}
                  ariaLabel="主题锁定方式"
                />
              </label>
              <label className="field">
                <span>表达自由</span>
                <SelectControl
                  value={draft.expressionFreedom ?? ((draft.strongConstraintLevel ?? 'balanced') === 'strict' ? 'controlled' : 'high')}
                  options={[
                    { value: 'high', label: '高', description: '尽量保留声音、节奏、意象与留白' },
                    { value: 'balanced', label: '平衡', description: '对明显模板化表达做温和审校' },
                    { value: 'controlled', label: '受控', description: '更积极地校正格式和表达边界' }
                  ]}
                  onChange={(value) => setDraft({ ...draft, expressionFreedom: value, strongConstraintLevel: value === 'controlled' ? 'strict' : 'balanced' })}
                  ariaLabel="表达自由程度"
                />
              </label>
              <Switch
                checked={draft.antiMoralizingEnabled ?? true}
                onChange={(value) => setDraft({ ...draft, antiMoralizingEnabled: value })}
                label="自动检查说教式收尾"

              />
              <label className="field">
                <span>叙事视角</span>
                <SelectControl
                  value={draft.strongConstraintPerspective ?? 'auto'}
                  options={[
                    { value: 'auto', label: '按任务判断' },
                    { value: 'first', label: '第一人称' },
                    { value: 'third', label: '第三人称' }
                  ]}
                  onChange={(value) => setDraft({ ...draft, strongConstraintPerspective: value })}
                  ariaLabel="强约束叙事视角"
                />
              </label>
              <label className="field"><span>体裁</span><input value={draft.strongConstraintGenre ?? ''} placeholder="留空则采用当前剧情配置" onChange={(event) => setDraft({ ...draft, strongConstraintGenre: event.target.value })} /></label>
              <label className="field"><span>必须原文保留（逐项）</span><textarea rows={2} value={draft.strongConstraintMustKeep ?? ''} placeholder="每行一项，例如：灯塔、守夜人" onChange={(event) => setDraft({ ...draft, strongConstraintMustKeep: event.target.value })} /><p className="dw-field-note">逐项核对原文；隐含事实仅作审校参考。</p></label>
              <label className="field"><span>不要出现</span><textarea rows={2} value={draft.strongConstraintAvoid ?? ''} placeholder="例如：成功学、人生意义、脱离场景的议论" onChange={(event) => setDraft({ ...draft, strongConstraintAvoid: event.target.value })} /></label>
            </div>
            <div className="dw-budget-presets" role="radiogroup" aria-label="完成校验 token 预算">
              {([
                { value: 80000, label: '轻量', hint: '约 80K tokens' },
                { value: 200000, label: '自动（推荐）', hint: '长文无固定上限' },
                { value: 500000, label: '大型', hint: '约 500K tokens' }
              ] as const).map((item) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={(draft.completionTokenBudget ?? 0) === item.value}
                  key={item.value}
                  className={(draft.completionTokenBudget ?? 0) === item.value ? 'active' : ''}
                  onClick={() => setDraft({ ...draft, completionTokenBudget: item.value })}
                >
                  <b>{item.label}</b><span>{item.hint.replace('约 ', '')}</span>
                </button>
              ))}
            </div>
            <label className="field">
              <span>自定义 token 预算</span>
              <div className="dw-number-field">
                <input
                  type="number"
                  min={1000}
                  max={1000000000}
                  step={1000}
                  value={draft.completionTokenBudget ?? 0}
                  onChange={(event) => setDraft({ ...draft, completionTokenBudget: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
                />
                <span>tokens</span>
              </div>
            </label>
            <label className="field">
              <span>最长运行时间（0 表示不限）</span>
              <div className="dw-number-field">
                <input
                  type="number"
                  min={0}
                  max={1440}
                  step={5}
                  value={Math.round((draft.completionWallClockMs ?? 0) / 60000)}
                  onChange={(event) => setDraft({ ...draft, completionWallClockMs: Math.max(0, Math.floor(Number(event.target.value) || 0)) * 60000 })}
                />
                <span>分钟</span>
              </div>
            </label>
            <div className="dw-policy-note">
              <b>完成判定</b>
              <span>按任务检查字数、产物与工具结果；未通过时显示剩余工作或等待你的决定。</span>
            </div>
            </details>
          </section>}
          {section === 'workspace' && <section className="dw-settings-page">
          <div className="dw-settings-page-head"><h4>工作区</h4></div>
          <label className="field">
            <span>文档默认保存目录</span>
            <div className="key-row">
              <input value={dirText(draft.docDir)} readOnly />
              <button className="ghost-btn" onClick={() => void chooseDir('docDir')}>
                选择
              </button>
            </div>
          </label>
          <label className="field">
            <span>文件与命令的默认工作目录</span>
            <div className="key-row">
              <input value={dirText(draft.workDir)} readOnly />
              <button className="ghost-btn" onClick={() => void chooseDir('workDir')}>
                选择
              </button>
            </div>
          </label>
          <Switch
            checked={draft.planMode}
            onChange={(checked) => setDraft({ ...draft, planMode: checked })}
            label="计划模式"
            description="复杂任务先给出计划，批准后再执行"
          />
          </section>}
          {section === 'permissions' && <section className="dw-settings-page">
            <div className="dw-settings-page-head"><h4>权限</h4><p>新任务使用当前档位；已有任务不会因此放宽确认要求。</p></div>
            <div className="dw-permission-segment" role="radiogroup" aria-label="权限模式">
              {MODE_CARDS.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  role="radio"
                  aria-checked={perms.mode === c.id}
                  className={`dw-permission-option${perms.mode === c.id ? ' active' : ''}${c.id === 'off' ? ' risky' : ''}`}
                  onClick={() => {
                    setPermissionMode(c.id)
                    setDraft({ ...draft, permissionMode: c.id })
                  }}
                >
                  <span className="dw-permission-radio"><span /></span>
                  <b>{c.label}</b>
                </button>
              ))}
            </div>
            <p className="dw-permission-help">{MODE_CARDS.find((card) => card.id === perms.mode)?.desc}</p>
            <div className="perm-rules">
              <div className="perm-rules-head">
                <span>规则列表</span>

              </div>
              {perms.rules.length === 0 ? (
                <p className="muted small">暂无规则</p>
              ) : (
                perms.rules.map((r) => (
                  <div key={r.id} className="perm-rule">
                    <span className={`perm-badge ${r.type}`}>{TYPE_LABELS[r.type]}</span>
                    <code className="perm-pattern">{r.pattern}</code>
                    <span className={`perm-action ${r.action}`}>{ACTION_LABELS[r.action]}</span>
                    <span className="muted small">{r.persistent ? '持久' : '仅一次'}</span>
                    <button className="ghost-btn danger" onClick={() => removeRule(r.id)}>
                      删除
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="perm-add">
              <span className="perm-add-title">添加规则</span>
              <div className="perm-add-row">
                <SelectControl
                  compact
                  ariaLabel="规则类型"
                  value={ruleType}
                  onChange={setRuleType}
                  options={[{ value: 'command', label: '命令' }, { value: 'path', label: '路径' }]}
                />
                <input
                  aria-label={ruleType === 'command' ? '命令匹配正则' : '路径匹配前缀'}
                  placeholder={ruleType === 'command' ? '匹配正则，如 ^npm ' : '匹配前缀，如 C:\\work'}
                  value={rulePattern}
                  onChange={(e) => setRulePattern(e.target.value)}
                />
                <SelectControl
                  compact
                  ariaLabel="规则动作"
                  value={ruleAction}
                  onChange={setRuleAction}
                  options={[
                    { value: 'allow', label: '允许' },
                    { value: 'ask', label: '询问' },
                    { value: 'deny', label: '拒绝' }
                  ]}
                />
              </div>
              <div className="perm-add-row">
                <Switch checked={ruleOnce} onChange={setRuleOnce} label="仅一次" description="使用后自动移除" />
                <button className="ghost-btn" onClick={addRule} disabled={!rulePattern.trim()}>
                  添加
                </button>
              </div>
            </div>
          </section>}
          {section === 'galgame' && <section className="dw-settings-page">
            <div className="dw-settings-page-head"><h4>Galgame</h4></div>
            <label className="field">
              <span>Ren'Py SDK 目录</span>
              <div className="key-row">
                <input
                  value={dirText(draft.galgame.sdkPath)}
                  readOnly
                  aria-describedby="dw-sdk-path-help"
                  placeholder="如 C:\renpy-8.5.3-sdk"
                />
                <button className="ghost-btn" onClick={() => void chooseSdk()}>
                  选择
                </button>
              </div>
            </label>
            <p id="dw-sdk-path-help" className="muted small">选择包含 renpy.py 与 lib/ 的 SDK 根目录。</p>
          </section>}
          {section === 'experimental' && <section className="dw-settings-page" data-testid="wp7-experiment-settings">
            <div className="dw-settings-page-head"><h4>实验功能</h4><p>仅影响新任务。</p></div>
            <div className="dw-experimental-setting">
              <Switch
                checked={wp7FeatureFlagsEnabled(draft.wp7FeatureFlags)}
                onChange={(enabled) => setDraft({ ...draft, wp7FeatureFlags: wp7FeatureFlagsForToggle(enabled) })}
                label="叙事增强"
                description="场景规划与局部审校。"
              />

            </div>
          </section>}
          {section === 'memory' && <section className="dw-settings-page">
            <div className="dw-settings-page-head brief-heading"><h4>项目约定</h4>
              {memory?.brief && <span title={memory.brief.path}>{memory.brief.path.split(/[\\/]/).slice(-2).join(' / ')}</span>}
            </div>
            {!memory?.brief ? <div role="status">正在读取工作目录…</div> : <>
              <textarea aria-label="写给这个项目的要求" id="dw-project-brief" className="dw-brief-editor" rows={7} spellCheck={false}
                placeholder="例如：只从小禾的视角写；她不知道信是谁寄的。"
                disabled={saving || !['ready', 'missing'].includes(memory.brief.state)}
                value={briefEdit?.text ?? memory.brief.text} onChange={event => {
                  setBriefEdit({ prior: briefEdit?.prior ?? memory.brief!, text: event.target.value }); setBriefConflict('')
                }} />
              {memory.brief.notice && <p role="status">{memory.brief.notice}</p>}
              {briefConflict && <div role="alert">{briefConflict} <button type="button" className="ghost-btn" onClick={async () => {
                await loadMemory(); setBriefEdit(null); setBriefConflict('')
              }}>重新载入</button></div>}
              {(memory.userMemoryContent || memory.projectMemoryPath) && <details className="brief-other-memory"><summary>其他已载入的记忆</summary>
                {memory.projectMemoryPath && <><p>{memory.projectMemoryPath}</p><pre>{memory.projectMemoryContent.slice(0, 200)}</pre></>}
                {memory.userMemoryContent && <><p>{memory.userMemoryPath}</p><pre>{memory.userMemoryContent.slice(0, 200)}</pre></>}
              </details>}
            </>}
          </section>}
          </div>
        </div>
          <div className="settings-actions dw-settings-actions">
            <button className="ghost-btn" onClick={dismiss}>
              取消
            </button>
            <button className="btn primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存并关闭'}
            </button>
          </div>
      </div>
    </div>
  )
}
