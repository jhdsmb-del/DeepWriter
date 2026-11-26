import { useState } from 'react'
import { useStore } from '../store'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { deriveWritingRunMode } from '../writingMode'
import Icon from './Icon'

const COMPOSER_MODES: { id: string; name: string; desc: string }[] = [
  { id: 'agent', name: 'Agent', desc: '对话、读写文件、运行命令' },
  { id: 'longwrite', name: '长文', desc: '文章、章节、续写、改写' },
  { id: 'style', name: '风格参考', desc: '语料分析、画像、仿写' },
  { id: 'galgame', name: 'Galgame', desc: "Ren'Py 项目扫描、生成、修复" }
]

export default function ContextDialog({ onClose }: { onClose: () => void }): React.ReactNode {
  const contextDialogRef = useDialogFocus<HTMLDivElement>(true, onClose)
  const [factText, setFactText] = useState('')
  const settings2 = useStore((state) => state.settings)
  const mode = useStore((state) => state.mode)
  const contextPreview = useStore((state) => state.contextPreview)
  const contextPins = useStore((state) => state.contextPins)
  const pinFact = useStore((state) => state.pinFact)
  const unpinContext = useStore((state) => state.unpinContext)
  const messagesCount = useStore((state) => state.messages.length)
  const pendingAttachments = useStore((state) => state.pendingAttachments)
  const targetChars = useStore((state) => state.targetChars)
  const workspace = useStore((state) => state.workspace)
  const longMode = useStore((state) => state.longMode)
  const guidedLongwrite = deriveWritingRunMode({ workspace, mode, longMode }).longMode
  const permissionMode = useStore((state) => state.permissions?.mode ?? state.settings?.permissionMode ?? 'safe')
  const PERM_LABEL: Record<string, string> = { safe: '申请', auto: '自动', off: '全开' }
  return (
    <div className="modal-overlay dw-dialog-overlay">
      <div className="modal dw-dialog dw-context-dialog" ref={contextDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="dw-context-title">
        <div className="modal-head">
          <h3 id="dw-context-title">本次运行上下文</h3>
          <button className="dw-settings-close" aria-label="关闭上下文" title="关闭上下文" onClick={() => onClose()}><Icon name="close" /></button>
        </div>
        <div className="modal-body">
          <dl className="dw-context-grid">
            <div><dt>模型</dt><dd>{settings2?.model ?? '—'}</dd></div>
            <div><dt>运行模式</dt><dd>{COMPOSER_MODES.find((m) => m.id === mode)?.name ?? 'Agent'}</dd></div>
            <div><dt>权限</dt><dd>{PERM_LABEL[permissionMode]}</dd></div>
            <div><dt>上下文管理</dt><dd>按模型自动管理</dd></div>
            <div><dt>历史消息</dt><dd>{messagesCount} 条</dd></div>
            <div><dt>附件</dt><dd>{pendingAttachments.length} 个</dd></div>
            {guidedLongwrite && <div><dt>目标字数</dt><dd>{targetChars || '—'}</dd></div>}
            <div className="wide"><dt>工作目录</dt><dd className="mono">{settings2?.workDir || '—'}</dd></div>
            <div><dt>本次估算</dt><dd>{contextPreview?.savings.selectedInput.value ?? '未知'} tokens</dd></div>
            <div><dt>完整基线</dt><dd>{contextPreview?.savings.fullBaselineInput.value ?? '未知'} tokens</dd></div>
            <div><dt>预计节省</dt><dd>{contextPreview?.savings.savedTokens.value ?? '未知'}{contextPreview?.savings.savingsRatio != null ? `（${Math.round(contextPreview.savings.savingsRatio * 100)}%）` : ''}</dd></div>
            <div><dt>输入预算</dt><dd>{contextPreview?.budget.inputBudgetTokens ?? '未知'} tokens</dd></div>
            <div className="wide"><dt>接口地址</dt><dd className="mono">{settings2?.baseUrl ?? '—'}</dd></div>
          </dl>
          <p className="dw-context-note">此处为发送前估算；实际输入与缓存用量见任务账单。</p>
          {contextPreview?.warnings.map((warning) => <p className="dw-context-warning" key={warning.code}>{warning.message}</p>)}
          {pendingAttachments.length > 0 && <div className="dw-context-attachments"><span>随请求发送</span><p>{pendingAttachments.map((a) => a.name).join('、')}</p></div>}
          <section className="dw-context-sources" aria-label="上下文来源">
            <h4>来源决策</h4>
            {(contextPreview?.decisions ?? []).slice(0, 30).map((entry) => (
              <div className="dw-context-source" key={entry.itemId}>
                <span>{entry.included ? '纳入' : '忽略'} · {entry.source.displayLabel}</span>
                <small>{entry.selectionReason}{entry.rankScore != null ? ` · BM25 ${entry.rankScore.toFixed(2)}` : ''}</small>
              </div>
            ))}
            {!contextPreview && <p>正在计算真实候选来源…</p>}
          </section>
          <section className="dw-context-pins" aria-label="固定事实和消息">
            <h4>固定内容（永不静默裁剪）</h4>
            {contextPins.map((pin) => <div className="dw-context-pin" key={pin.pinId}><span>{pin.displayLabel}</span><button onClick={() => void unpinContext(pin.pinId, pin.revision)}>取消固定</button></div>)}
            <div className="dw-context-fact"><input value={factText} maxLength={4000} placeholder="添加必须保留的事实" onChange={(event) => setFactText(event.target.value)} /><button disabled={!factText.trim()} onClick={() => { void pinFact(factText); setFactText('') }}>固定事实</button></div>
          </section>
        </div>
        <div className="dw-dialog-actions"><button className="btn primary" onClick={() => onClose()}>完成</button></div>
      </div>
    </div>
  )
}
