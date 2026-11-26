import { useEffect, useRef } from 'react'
import type { StudioUiMessage } from '../store'
import { useStore } from '../store'
import Icon from './Icon'

export default function FileSources({ message }: { message: StudioUiMessage }): React.ReactNode {
  const load = useStore(state => state.loadMessageSources)
  const details = useRef<HTMLDetailsElement>(null)
  const sources = message.fileEvidence
  useEffect(() => {
    if (details.current?.open && sources?.status === 'idle') void load(message.id)
  }, [message.id, sources?.revision, sources?.status, load])
  if (!sources) return null
  const close = (): void => {
    if (!details.current) return
    details.current.open = false
    details.current.querySelector('summary')?.focus()
  }
  return <details className="file-sources" ref={details} onToggle={event => {
    if (event.currentTarget.open && sources.status === 'idle') void load(message.id)
  }} onKeyDown={event => {
    if (event.key === 'Escape' && details.current?.open) { event.preventDefault(); event.stopPropagation(); close() }
  }}>
    <summary><Icon name="document" size={14} />文件来源{sources.status === 'loaded' && sources.nextOffset === null && sources.entries.length > 0 && <span>{sources.entries.length} 处</span>}<Icon name="chevronDown" size={13} /></summary>
    <section className="file-sources-body" aria-label="Agent 的文件来源">
      <header><span>实际查阅的文件与片段</span><button type="button" className="ghost-btn" aria-label="收起文件来源" onClick={close}><Icon name="close" size={15} /></button></header>
      {sources.entries.map(source => <article className="file-source" key={`${source.runId}:${source.toolCallId}:${source.sourceIndex}`}>
        <h4>{source.displayName}<span>{source.locator || (source.kind === 'found' ? '仅找到文件' : '读取片段')}{source.truncated ? ' · 片段' : ''}</span></h4>
        <div className="file-source-path">{source.path}{source.archiveEntry && <span> › {source.archiveEntry}</span>}</div>
        {source.excerpt && <pre>{source.excerpt}</pre>}
      </article>)}
      {sources.status === 'loading' && <p role="status">正在读取来源记录…</p>}
      {sources.status === 'error' && <button type="button" className="ghost-btn" onClick={() => void load(message.id)}>来源记录读取失败，重试</button>}
      {sources.status === 'loaded' && sources.nextOffset !== null && <button type="button" className="ghost-btn" onClick={() => void load(message.id)}>继续查看来源</button>}
      {sources.status === 'loaded' && !sources.entries.length && <p>没有可复核的文件片段。</p>}
    </section>
  </details>
}
