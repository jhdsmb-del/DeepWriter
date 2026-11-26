import { useState } from 'react'
import { useStore } from '../store'
import { Section } from './WorkspaceLayout'
import Switch from './Switch'
import Icon from './Icon'
import AttachmentList from './AttachmentList'
import { ATTACHMENT_PICKER_HINT } from '../../../shared/attachmentPreview'
import { useComposerAttachments } from '../hooks/useComposerAttachments'

export default function NovelPanel(): React.ReactNode {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const messages = useStore((s) => s.messages)
  const running = useStore((s) => s.running)
  const startGuidedLongwrite = useStore((s) => s.startGuidedLongwrite)
  const directPrompt = useStore((state) => state.composerText)
  const setDirectPrompt = useStore((state) => state.setComposerText)
  const pendingAttachments = useStore((state) => state.pendingAttachments)
  const { addViaDialog, retryAtt, reselectAtt, removeAtt } = useComposerAttachments()
  const [sourceMode, setSourceMode] = useState<'direct' | 'conversation'>('direct')

  const novelMode = settings?.novelMode ?? false
  const directDisabled = directPrompt.trim().length < 10 || running
  const conversationSeed = messages
    .map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.content}`)
    .join('\n')
    .slice(-16000)

  return (
    <Section>
      <div className="dw-choice-tabs" role="tablist" aria-label="起稿方式">
        <button type="button" role="tab" aria-selected={sourceMode === 'direct'} className={sourceMode === 'direct' ? 'active' : ''} onClick={() => setSourceMode('direct')}>
          <Icon name="edit" /><b>先梳理再写</b>
        </button>
        <button type="button" role="tab" aria-selected={sourceMode === 'conversation'} className={sourceMode === 'conversation' ? 'active' : ''} onClick={() => setSourceMode('conversation')}>
          <Icon name="chat" /><b>整理对话</b>
        </button>
      </div>

      {sourceMode === 'direct' ? (
        <div className="novel-sub dw-form-stack" role="tabpanel">
          <label className="field">
            <span>创作构想</span>
            <textarea
              className="novel-direct-input"
              rows={7}
              aria-label="创作构想"
              placeholder="人物、冲突、一个场景，或者文章的主题。把必须保留的要求也告诉我（至少 10 字）。"
              value={directPrompt}
              onChange={(e) => setDirectPrompt(e.target.value)}
            />
          </label>
          <div className="dw-longform-material-picker">
            <button className="btn" type="button" title={ATTACHMENT_PICKER_HINT} onClick={() => void addViaDialog()}><Icon name="paperclip" />添加素材</button>
            <AttachmentList attachments={pendingAttachments} onRetry={retryAtt} onReselect={reselectAtt} onRemove={removeAtt} />
          </div>
          <div className="dw-primary-row">
            <button className="btn primary" disabled={directDisabled} onClick={() => { const sessionId = useStore.getState().ensureSessionId(); if (startGuidedLongwrite(directPrompt, pendingAttachments)) useStore.getState().clearSubmittedText(sessionId, directPrompt) }}>
              <Icon name="arrowUp" />开始梳理
            </button>
          </div>
        </div>
      ) : (
        <div className="novel-sub dw-form-stack" role="tabpanel">
          <Switch checked={novelMode} onChange={(checked) => updateSettings({ novelMode: checked })} label="记录后续对话" description="新对话会作为成书素材积累" />
          <div className="dw-material-summary">
            <span>当前素材</span><b>{messages.length} 条对话</b>
          </div>
          <div className="dw-primary-row">
            <button className="btn primary" disabled={!novelMode || messages.length === 0 || running} onClick={() => startGuidedLongwrite(`请基于以下已有创作对话继续梳理并写成长文：\n${conversationSeed}`)}>
              基于对话梳理
            </button>
          </div>
        </div>
      )}
    </Section>
  )
}
