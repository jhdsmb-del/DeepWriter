import { useEffect, useState } from 'react'
import SelectControl from './SelectControl'

export interface StudioBranchGraph {
  labels: Array<{ name: string }>
  edges: Array<{ from: string; to: string; type: string; choice?: string }>
  diagnostics: Array<{ severity: string; message: string }>
}

/** Inspect one real scene at a time; choices retain the player's original text. */
export default function StudioBranchExplorer({ graph, loading, error, onRefresh }: {
  graph: StudioBranchGraph | null
  loading: boolean
  error: string
  onRefresh: () => void
}): React.ReactNode {
  const [selected, setSelected] = useState('start')
  const [history, setHistory] = useState<string[]>([])
  const labels = graph?.labels ?? []
  useEffect(() => {
    if (!labels.some(label => label.name === selected)) {
      setSelected(labels.find(label => label.name === 'start')?.name ?? labels[0]?.name ?? '')
      setHistory([])
    }
  }, [graph, selected])
  const edges = graph?.edges.filter(edge => edge.from === selected) ?? []
  const visit = (name: string): void => {
    setHistory(current => [...current, selected])
    setSelected(name)
  }
  return <div className="studio-branches" aria-label="剧情分支浏览">
    <div className="studio-section-head"><div><h3>剧情路线</h3><p>{graph ? `${labels.length} 个节点，${graph.edges.length} 条连接` : '读取项目中的实际剧情与选项'}</p></div><button type="button" className="text-btn" disabled={loading} onClick={onRefresh}>{loading ? '正在读取…' : '刷新分支'}</button></div>
    {error ? <p role="alert" className="studio-issues">{error}。可刷新重试。</p> : null}
    {labels.length > 0 ? <>
      <div className="studio-branch-location"><label>查看节点<SelectControl ariaLabel="查看剧情节点" value={selected} options={labels.map(label => ({ value: label.name, label: label.name }))} onChange={name => { setSelected(name); setHistory([]) }} /></label>{history.length > 0 && <button className="text-btn" type="button" onClick={() => { setSelected(history[history.length - 1]); setHistory(current => current.slice(0, -1)) }}>返回上一节点</button>}</div>
      <div className="studio-scene" aria-live="polite"><span className="studio-scene-label">当前节点</span><h4>{selected}</h4>
        {edges.length ? <div className="studio-choice-list">{edges.map((edge, index) => <button type="button" className="studio-story-choice" key={`${edge.to}:${index}`} disabled={!labels.some(label => label.name === edge.to)} onClick={() => visit(edge.to)}><span>{edge.choice || (edge.type === 'menu' ? '选项' : edge.type === 'call' ? '进入场景' : '继续剧情')}</span><small>{edge.to}<span aria-hidden="true"> ↗</span></small></button>)}</div> : <p className="studio-scene-end">这里没有跳转；剧情在此结束或等待后续内容。</p>}
      </div>
      {graph?.diagnostics.length ? <details className="studio-diagnostics"><summary>结构诊断（{graph.diagnostics.length}）</summary><ul>{graph.diagnostics.map((item, index) => <li key={index}>{item.severity === 'error' ? '错误：' : '提示：'}{item.message}</li>)}</ul></details> : null}
    </> : !loading && !error ? <p className="branch-note">还没有剧情节点。确认大纲并生成后，可在这里逐个查看玩家选项和去向。</p> : null}
  </div>
}
