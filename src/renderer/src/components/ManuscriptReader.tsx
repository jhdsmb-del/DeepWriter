import { useEffect, useRef, useState } from 'react'
import type { ManuscriptReaderInput, ManuscriptReaderView } from '../../../shared/manuscriptReader'
import { useStore } from '../store'
import Icon from './Icon'
import './manuscript-reader.css'

function read(input: ManuscriptReaderInput): Promise<ManuscriptReaderView | null> {
  return window.ds.runsReadManuscript(input)
}

export function useManuscriptIndex(runId: string | null): { view: ManuscriptReaderView | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ runId: string | null; view: ManuscriptReaderView | null; loading: boolean; error: string | null }>({ runId: null, view: null, loading: true, error: null })
  useEffect(() => {
    if (!runId) return undefined
    let live = true
    setState({ runId, view: null, loading: true, error: null })
    void read({ runId }).then(view => { if (live) setState({ runId, view, loading: false, error: null }) })
      .catch(() => { if (live) setState({ runId, view: null, loading: false, error: '目录暂时无法读取，请重新打开任务详情。' }) })
    return () => { live = false }
  }, [runId])
  return state.runId === runId ? state : { view: null, loading: true, error: null }
}

/** A quiet, always reachable entry beside the longform workflow, including cold runs. */
export function LongformManuscriptEntry({ sessionId }: { sessionId: string | null }): React.ReactNode {
  const [loading, setLoading] = useState(false)
  const open = useStore(state => state.openRunInspector)
  const showToast = useStore(state => state.showToast)
  const request = useRef(0)
  useEffect(() => { request.current++; setLoading(false); return () => { request.current++ } }, [sessionId])
  return <button type="button" className="dw-text-btn dw-manuscript-entry" disabled={!sessionId || loading} onClick={() => {
    if (!sessionId) return
    const id = ++request.current
    setLoading(true)
    void read({ sessionId }).then(view => {
      if (id !== request.current) return
      if (view) open(view.runId, 'manuscript')
      else showToast('正文尚未开始。确认大纲并写作后，可在这里阅读已收稿。', 'info')
    }).catch(() => { if (id === request.current) showToast('稿件暂时无法读取，请稍后重试。', 'error') })
      .finally(() => { if (id === request.current) setLoading(false) })
  }}><Icon name="document" />{loading ? '读取目录…' : '阅读已收稿'}</button>
}

export default function ManuscriptReader({ index, onReturn }: { index: ManuscriptReaderView; onReturn: () => void }): React.ReactNode {
  const [view, setView] = useState(index)
  const [selected, setSelected] = useState(index.chapters[0]?.id ?? '')
  const [pageNumber, setPageNumber] = useState(0)
  const [pageDraft, setPageDraft] = useState('1')
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const article = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const request = useRef(0)
  const chapter = view.chapters.find(item => item.id === selected)
  const currentPage = view.page?.chapterId === selected && view.page.number === pageNumber ? view.page : null
  const filtered = view.chapters.filter(item => item.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  useEffect(() => setPageDraft(String(pageNumber + 1)), [pageNumber, selected])

  useEffect(() => {
    let live = true
    const id = ++request.current
    setLoading(true)
    setError(null)
    void read({ runId: index.runId, ...(selected ? { chapterId: selected, page: pageNumber } : {}) }).then(next => {
      if (!live || request.current !== id) return
      if (!next) throw new Error('任务已不可用，请返回任务中心查看。')
      setView(next)
      if (!selected && next.chapters[0]) setSelected(next.chapters[0].id)
      if (next.page && next.page.number !== pageNumber) setPageNumber(next.page.number)
      if (article.current) article.current.scrollTop = 0
      title.current?.focus({ preventScroll: true })
    }).catch(() => { if (live && request.current === id) setError('正文暂时无法读取，请刷新目录重试。') })
      .finally(() => { if (live && request.current === id) setLoading(false) })
    return () => { live = false }
  }, [index.runId, selected, pageNumber, revision])

  const selectChapter = (id: string): void => { setSelected(id); setPageNumber(0) }
  const chapterIndex = view.chapters.findIndex(item => item.id === selected)
  return <section className="dw-manuscript-reader" aria-label="已收稿阅读" data-testid="manuscript-reader">
    <header className="dw-manuscript-toolbar">
      <div><b>{view.title}</b><span>已收稿 {view.acceptedChars.toLocaleString('zh-CN')} 字 · {view.chapters.length} 节</span></div>
      <button type="button" className="dw-text-btn" disabled={loading} onClick={() => { if (error) { setSelected(''); setPageNumber(0) }; setRevision(value => value + 1) }}><Icon name="refresh" />刷新</button>
      <button type="button" className="dw-text-btn" onClick={onReturn}><Icon name="arrowLeft" />返回写作</button>
    </header>
    {view.unacceptedSegments > 0 && <p className="dw-manuscript-draft-note">另有 {view.unacceptedSegments} 段草稿或候选尚未接纳，未计入本稿。</p>}
    {view.chapters.length > 0 ? <div className="dw-manuscript-layout">
      <nav className="dw-manuscript-contents" aria-label="已收稿目录">
        <label><Icon name="search" /><input type="search" aria-label="查找章节" placeholder="查找章节" value={filter} onChange={event => setFilter(event.currentTarget.value)} /></label>
        <ol>{filtered.map(item => <li key={item.id}><button type="button" aria-current={item.id === selected ? 'true' : undefined} onClick={() => selectChapter(item.id)}><span>{item.title}</span><small>{item.acceptedChars.toLocaleString('zh-CN')} 字</small></button></li>)}</ol>
        {filtered.length === 0 && <p className="dw-manuscript-empty">未找到章节，试试更短的标题。</p>}
      </nav>
      <div className="dw-manuscript-reading">
        <article ref={article} tabIndex={0} aria-label="章节正文" aria-busy={loading}>
          <h2 ref={title} tabIndex={-1}>{chapter?.title}</h2>
          {error ? <p className="dw-manuscript-error" role="alert">{error}</p> : loading ? <p role="status" className="dw-manuscript-empty">正在读取正文…</p> : <div className="dw-manuscript-prose" data-testid="manuscript-prose">{currentPage?.content}</div>}
        </article>
        <footer className="dw-manuscript-pagination" aria-label="正文翻页">
          <button type="button" className="dw-text-btn" disabled={loading || chapterIndex < 0 || chapterIndex === 0 && pageNumber === 0} onClick={() => { if (pageNumber > 0) setPageNumber(value => value - 1); else { const previous = view.chapters[chapterIndex - 1]; setSelected(previous.id); setPageNumber(previous.pages - 1) } }}>上一页</button>
          <form onSubmit={event => { event.preventDefault(); const value = Number(pageDraft); if (Number.isInteger(value) && value >= 1 && value <= (chapter?.pages ?? 1)) setPageNumber(value - 1); else setPageDraft(String(pageNumber + 1)) }}>
            <label>第 <input type="number" aria-label="页码" min={1} max={chapter?.pages ?? 1} value={pageDraft} onChange={event => setPageDraft(event.currentTarget.value)} disabled={loading} /> / {chapter?.pages ?? 1} 页</label>
            <button type="submit" className="dw-text-btn" disabled={loading}>前往</button>
          </form>
          <button type="button" className="dw-text-btn" disabled={loading || chapterIndex < 0 || chapterIndex === view.chapters.length - 1 && pageNumber >= (chapter?.pages ?? 1) - 1} onClick={() => { if (pageNumber < (chapter?.pages ?? 1) - 1) setPageNumber(value => value + 1); else selectChapter(view.chapters[chapterIndex + 1].id) }}>下一页</button>
        </footer>
      </div>
    </div> : <div className="dw-manuscript-empty"><h3>还没有已收稿正文</h3><p>草稿仍保留在任务中。场景被接纳后，会按章显示在这里。</p>{error && <p role="alert">{error}</p>}</div>}
  </section>
}
