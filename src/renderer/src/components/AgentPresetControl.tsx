import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { usePresence } from '../hooks/usePresence'
import Icon from './Icon'
import SelectControl from './SelectControl'

const MAX_PRESET_CHARS = 20000

const PRESET_TEMPLATES = [
  { id: 'custom', name: '自定义', description: '当前内容为手动编辑', prompt: '' },
  { id: 'precise', name: '精准执行', description: '事实优先，输出可执行结果', prompt: '保持事实准确；先给出结论，再给出可执行步骤。' },
  { id: 'collaborative', name: '协作助手', description: '先确认目标，再推进任务', prompt: '先确认目标、边界和交付形式；信息不足时提出最少但关键的问题。' },
  { id: 'writing', name: '写作编辑', description: '结构清楚，保留人物声音', prompt: '优先保持人物声音和上下文一致；结构清楚，避免空泛的总结和说教。' }
] as const
type PresetTemplateId = typeof PRESET_TEMPLATES[number]['id']

function normalizePrompt(value: string): string {
  return Array.from(value).slice(0, MAX_PRESET_CHARS).join('')
}

function templateFor(prompt: string): PresetTemplateId {
  const match = PRESET_TEMPLATES.find((template) => template.prompt === prompt)
  return match?.id ?? 'custom'
}

export default function AgentPresetControl(): React.ReactNode {
  const settings = useStore((state) => state.settings)
  const updateSettings = useStore((state) => state.updateSettings)
  const showToast = useStore((state) => state.showToast)
  const [open, setOpen] = useState(false)
  const present = usePresence(open)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const prompt = settings?.userPresetPrompt ?? ''
  const panelRef = useDialogFocus<HTMLDivElement>(open, useCallback(() => setOpen(false), []))
  const selectedTemplate = useMemo(() => templateFor(draft), [draft])
  const close = useCallback((): void => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    setDraft(prompt)
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && !rootRef.current?.contains(target)) close()
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [close, open, prompt])

  const openPanel = (): void => {
    if (!settings) return
    setDraft(prompt)
    setOpen((value) => !value)
  }

  const save = async (): Promise<void> => {
    if (!settings || saving) return
    setSaving(true)
    const ok = await updateSettings({ userPresetPrompt: normalizePrompt(draft).trim() })
    setSaving(false)
    if (!ok) return
    close()
    showToast('Agent 预设已保存，下一次运行生效', 'success')
  }

  const clear = async (): Promise<void> => {
    if (!settings || saving) return
    setSaving(true)
    const ok = await updateSettings({ userPresetPrompt: '' })
    setSaving(false)
    if (!ok) return
    setDraft('')
    close()
    showToast('Agent 预设已清除', 'info')
  }

  const onDraftChange = (value: string): void => setDraft(normalizePrompt(value))

  return (
    <div ref={rootRef} className="dw-agent-preset-control">
      <button
        type="button"
        className={`dw-agent-preset-trigger${open ? ' open' : ''}${prompt.trim() ? ' active' : ''}`}
        aria-label="自定义指令"
        title={prompt.trim() ? '自定义指令（已设置）' : '自定义指令'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="dw-agent-preset-panel"
        data-testid="agent-preset-trigger"
        disabled={!settings}
        onClick={openPanel}
      >
        <Icon name="edit" size={16} /><span>自定义指令</span>
      </button>
      {present && (
        <div
          ref={panelRef}
          id="dw-agent-preset-panel"
          className="dw-agent-preset-panel"
          data-state={open ? 'open' : 'closing'}
          inert={!open}
          aria-hidden={!open}
          role="dialog"
          aria-modal="false"
          aria-labelledby="dw-agent-preset-title"
          aria-busy={saving}
          tabIndex={-1}
          data-testid="agent-preset-panel"
        >
          <div className="dw-agent-preset-head">
            <div>
              <h2 id="dw-agent-preset-title">自定义指令</h2>
            </div>
            <button type="button" className="dw-agent-preset-close" aria-label="关闭自定义指令" title="关闭自定义指令" onClick={close} disabled={saving}>
              <Icon name="close" size={15} />
            </button>
          </div>
          <label className="dw-agent-preset-field">
            <span>预设模板</span>
            <SelectControl
              ariaLabel="Agent 预设模板"
              value={selectedTemplate}
              options={PRESET_TEMPLATES.map((template) => ({ value: template.id, label: template.name, description: template.description }))}
              onChange={(templateId) => {
                const template = PRESET_TEMPLATES.find((item) => item.id === templateId)
                if (template) onDraftChange(template.prompt)
              }}
              disabled={saving}
            />
          </label>
          <label className="dw-agent-preset-field">
            <span>给当前 Agent 的指令</span>
            <textarea
              rows={7}
              value={draft}
              maxLength={MAX_PRESET_CHARS * 2}
              placeholder="例如：先说结论；不确定时明确标注，不要编造事实。"
              aria-label="给当前 Agent 的指令"
              data-testid="agent-preset-input"
              onChange={(event) => onDraftChange(event.currentTarget.value)}
              disabled={saving}
            />
          </label>
          <div className="dw-agent-preset-count" aria-live="polite">
            <span>{Array.from(draft).length.toLocaleString()} / {MAX_PRESET_CHARS.toLocaleString()} 字符</span>
          </div>
          <p className="dw-agent-preset-scope"><b>生效范围</b>：对话与长文的新任务。</p>
          <div className="dw-agent-preset-actions">
            <button type="button" className="ghost-btn danger" onClick={() => void clear()} disabled={saving || !prompt.trim()}>清除</button>
            <div>
              <button type="button" className="ghost-btn" onClick={close} disabled={saving}>取消</button>
              <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存并启用'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
