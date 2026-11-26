import { useEffect, useRef, useState } from 'react'
import { useStore, type StyleSpanRevision, type StyleV2JobState } from '../store'
import { Section, StageNav } from './WorkspaceLayout'
import SelectControl from './SelectControl'
import type { CandidateEvaluation, OverlapFinding, StyleGenTask, StyleJobStage } from '../../../shared/styleV2'

interface DimItem {
  id: string
  label: string
  value: number | string
  unit?: string
  lockedByUser: boolean
}

const SCENE_TYPES = ['日常对白', '冲突对白', '内心独白', '环境描写', '人物出场', '动作战斗', '悬疑调查', '情感高潮', '信息说明', '转场', '章节开头', '章节结尾']

const NARRATIVE_FUNCTIONS = ['对白', '动作', '心理', '环境', '信息释放']

const FIDELITY_LEVELS: { key: StyleGenTask['fidelity']; label: string; candidates: number }[] = [
  { key: 'light', label: '快速', candidates: 1 },
  { key: 'balanced', label: '平衡', candidates: 2 },
  { key: 'high', label: '高保真', candidates: 3 }
]

const STAGE_LABELS: Record<StyleJobStage, string> = {
  skeleton: '骨架',
  retrieving: '检索',
  generating: '生成',
  scoring: '评分',
  revising: '修订',
  done: '完成',
  failed: '失败',
  cancelled: '已取消'
}

const STAGE_ORDER: StyleJobStage[] = ['skeleton', 'retrieving', 'generating', 'scoring', 'revising', 'done']

const SCORE_COLORS = { style: '#4c8dff', content: '#3fb950', novelty: '#d8b4fe', naturalness: '#d29922' }

function fmtChars(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return n.toLocaleString()
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }): React.ReactNode {
  const v = Math.max(0, Math.min(1, value))
  return (
    <div className="score-row">
      <span className="score-label">{label}</span>
      <div className="score-bar">
        <div className="score-fill" style={{ width: `${Math.round(v * 100)}%`, background: color }} />
      </div>
      <span className="score-value">{Math.round(value * 100)}</span>
    </div>
  )
}

function GateBadge({ label, ok }: { label: string; ok: boolean }): React.ReactNode {
  return (
    <span className={`gate-badge${ok ? ' ok' : ' no'}`}>
      {label}{ok ? '✓' : '✗'}
    </span>
  )
}

function longestOverlap(ev: CandidateEvaluation | null): OverlapFinding | null {
  if (!ev || ev.overlaps.length === 0) return null
  return ev.overlaps.reduce((a, b) => (b.length > a.length ? b : a))
}

function buildSpanRevision(job: StyleV2JobState): StyleSpanRevision | null {
  if (!job.chosenCandidateId) return null
  const ev = job.evaluations.find((e) => e.candidateId === job.chosenCandidateId)
  const cand = job.candidates.find((c) => c.id === job.chosenCandidateId)
  if (!ev || !cand || ev.failedSpans.length === 0) return null
  const span = ev.failedSpans[0]
  let start = span.start
  let end = span.end
  if (start <= 0 || end <= 0) {
    const o = ev.overlaps.find((x) => x.length >= 24)
    if (o) {
      const idx = cand.text.indexOf(o.text.slice(0, 12))
      if (idx >= 0) {
        start = idx
        end = Math.min(cand.text.length, idx + o.length)
      } else {
        start = 0
        end = Math.min(24, cand.text.length)
      }
    } else {
      start = 0
      end = Math.min(24, cand.text.length)
    }
  }
  if (start < 0 || end <= start || end > cand.text.length) {
    start = 0
    end = Math.min(24, cand.text.length)
  }
  return {
    candidateId: job.chosenCandidateId,
    spanStart: start,
    spanEnd: end,
    spanText: cand.text.slice(start, end),
    preserveFacts: job.task?.requiredFacts ?? [],
    failedRules: [span.rule],
    leftContext: cand.text.slice(Math.max(0, start - 80), start),
    rightContext: cand.text.slice(end, Math.min(cand.text.length, end + 80))
  }
}

export default function StylePanel(): React.ReactNode {
  const styleState = useStore((s) => s.styleState)
  const styleSetActive = useStore((s) => s.styleSetActive)
  const styleUpdate = useStore((s) => s.styleUpdate)
  const styleDeleteProfile = useStore((s) => s.styleDeleteProfile)
  const styleCheckOverlap = useStore((s) => s.styleCheckOverlap)
  const showToast = useStore((s) => s.showToast)
  const messages = useStore((s) => s.messages)
  const styleV2 = useStore((s) => s.styleV2)
  const targetChars = useStore((s) => s.targetChars)
  const setTargetChars = useStore((s) => s.setTargetChars)
  const buildProfileV2 = useStore((s) => s.buildProfileV2)
  const restoreV2Profile = useStore((s) => s.restoreV2Profile)
  const buildExemplarsV2 = useStore((s) => s.buildExemplarsV2)
  const jobStartV2 = useStore((s) => s.jobStartV2)
  const jobGetV2 = useStore((s) => s.jobGetV2)
  const jobStopV2 = useStore((s) => s.jobStopV2)
  const chooseCandidateV2 = useStore((s) => s.chooseCandidateV2)
  const reviseStyleSpan = useStore((s) => s.reviseStyleSpan)

  const [selected, setSelected] = useState<string[]>([])
  const [view, setView] = useState<'corpus' | 'generate' | 'review'>('corpus')
  const [overlapText, setOverlapText] = useState('')
  const [overlapReport, setOverlapReport] = useState<any>(null)
  const [checking, setChecking] = useState(false)
  const [sceneType, setSceneType] = useState(SCENE_TYPES[0])
  const [narrativeFns, setNarrativeFns] = useState<string[]>([])
  const [pov, setPov] = useState('第三')
  const [emotionArc, setEmotionArc] = useState('')
  const [requiredFacts, setRequiredFacts] = useState('')
  const [forbiddenFacts, setForbiddenFacts] = useState('')
  const [fidelity, setFidelity] = useState<StyleGenTask['fidelity']>('balanced')
  const [outputFormat, setOutputFormat] = useState<StyleGenTask['outputFormat']>('prose')
  const [userPrompt, setUserPrompt] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [copying, setCopying] = useState(false)
  const [revising, setRevising] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [choosingId, setChoosingId] = useState<string | null>(null)
  const [showV1Migrate, setShowV1Migrate] = useState(false)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const profiles = styleState?.profiles ?? []
  const sources = styleState?.sources ?? []
  const activeId = styleState?.activeProfileId ?? ''
  const buildState = styleV2.build
  const exemplarState = styleV2.exemplar
  const job = styleV2.job

  const stopPolling = (): void => {
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => {
    let raw: string | null = null
    try {
      raw = localStorage.getItem('dw.stylev2.profile')
    } catch {
      raw = null
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { profileId?: string }
        if (parsed.profileId && useStore.getState().styleV2.build.status === 'idle') {
          void restoreV2Profile(parsed.profileId)
        }
      } catch {
        /* 忽略损坏的恢复数据 */
      }
    }
    return () => stopPolling()
  }, [restoreV2Profile])

  const startPolling = (jobId: string): void => {
    stopPolling()
    const tick = async (): Promise<void> => {
      const current = await jobGetV2(jobId)
      if (!current) {
        stopPolling()
        return
      }
      if (current.stage === 'done') {
        stopPolling()
        const prev = useStore.getState().styleV2.job
        if (prev.stage !== 'done') showToast('生成完成，可对比候选', 'success')
        return
      }
      if (current.stage === 'cancelled' || current.stage === 'failed') {
        stopPolling()
        if (current.stage === 'failed' && current.error) showToast(current.error, 'error')
        return
      }
      pollRef.current = setTimeout(() => void tick(), 1000)
    }
    void tick()
  }

  const addSources = async (): Promise<void> => {
    const ds = (window as any).ds
    if (!ds?.openFiles || !ds?.styleAddSources) {
      showToast('文件选择或风格模块未就绪', 'error')
      return
    }
    const refs: Array<{ fileRefId: string }> = (await ds.openFiles(useStore.getState().currentSessionId ?? 'draft')) ?? []
    if (refs.length === 0) return
    // R4-1：只提交 FileRef id；main 解析真实路径
    const added = await ds.styleAddSources(refs.map((r) => r.fileRefId), useStore.getState().currentSessionId ?? 'draft')
    showToast(`已添加 ${added.length} 个风格样本（重复文件自动跳过）`, added.length > 0 ? 'success' : 'info')
    useStore.getState().loadStyle()
  }

  const build = async (): Promise<void> => {
    if (selected.length === 0) {
      showToast('请先选择至少一个风格来源', 'info')
      return
    }
    await buildProfileV2(selected)
    const b = useStore.getState().styleV2.build
    if (b.status === 'done') {
      showToast('风格画像构建完成，语料统计已就绪', 'success')
      setSelected([])
    } else {
      showToast(b.error ?? '风格画像构建失败', 'error')
    }
  }

  const buildExemplars = async (): Promise<void> => {
    const profileId = buildState.profileId || activeId
    if (!profileId) {
      showToast('请先构建高保真风格画像', 'info')
      return
    }
    await buildExemplarsV2(profileId)
  }

  const check = async (): Promise<void> => {
    if (!activeId) {
      showToast('请先启用一个风格画像', 'info')
      return
    }
    const text = overlapText.trim() || (messages.filter((m) => m.role === 'assistant').at(-1)?.content ?? '')
    if (text.length < 20) {
      showToast('待检测文本太短', 'info')
      return
    }
    setChecking(true)
    try {
      const report = await styleCheckOverlap(activeId, text)
      setOverlapReport(report)
    } finally {
      setChecking(false)
    }
  }

  const startGen = async (): Promise<void> => {
    const profileId = buildState.profileId || activeId
    if (!profileId) {
      showToast('请先构建并启用风格画像', 'info')
      return
    }
    const task: StyleGenTask = {
      mode: 'new',
      targetChars,
      sceneType,
      narrativeFunctions: narrativeFns,
      pov,
      requiredFacts: requiredFacts.split('\n').map((t) => t.trim()).filter(Boolean),
      forbiddenFacts: forbiddenFacts.split('\n').map((t) => t.trim()).filter(Boolean),
      emotionalArc: emotionArc.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      outputFormat,
      fidelity,
      userPrompt: userPrompt.trim()
    }
    const jobId = await jobStartV2(profileId, task)
    if (!jobId) return
    showToast('生成任务已启动（骨架→检索→生成→评分）', 'info')
    startPolling(jobId)
  }

  const stopGen = async (): Promise<void> => {
    stopPolling()
    await jobStopV2(job.jobId)
    showToast('生成已取消', 'info')
  }

  const removeProfile = async (id: string): Promise<void> => {
    setDeletingId(id)
    try {
      await styleDeleteProfile(id)
    } finally {
      setDeletingId(null)
    }
  }

  const chooseCandidate = async (candId: string): Promise<void> => {
    setChoosingId(candId)
    try {
      await chooseCandidateV2(job.jobId, candId)
    } finally {
      setChoosingId(null)
    }
  }

  const copyText = async (): Promise<void> => {
    if (!job.chosenText) return
    setCopying(true)
    try {
      await navigator.clipboard.writeText(job.chosenText)
      showToast('已复制全文', 'success')
    } catch {
      showToast('复制失败', 'error')
    } finally {
      setCopying(false)
    }
  }

  const insertToScene = async (): Promise<void> => {
    if (!job.chosenText) return
    try {
      await navigator.clipboard.writeText(job.chosenText)
      showToast('候选文本已复制，可在输入框粘贴插入当前场景', 'success')
    } catch {
      showToast('复制失败', 'error')
    }
  }

  const doRevise = async (): Promise<void> => {
    const revision = buildSpanRevision(job)
    if (!revision) {
      showToast('没有需要修订的重叠片段', 'info')
      return
    }
    setRevising(true)
    await reviseStyleSpan({ jobId: job.jobId, revision })
    setRevising(false)
    if (useStore.getState().styleV2.job.status !== 'failed') {
      startPolling(job.jobId)
    }
  }

  const active = profiles.find((p: any) => p.id === activeId)
  const chosenEv = job.evaluations.find((e) => e.candidateId === job.chosenCandidateId) ?? null
  const stageIdx = job.stage ? STAGE_ORDER.indexOf(job.stage) : -1
  const progressPct = job.status === 'failed' || job.status === 'cancelled' ? 100 : stageIdx >= 0 ? Math.round(((stageIdx + 1) / STAGE_ORDER.length) * 100) : 0

  useEffect(() => {
    if (job.status === 'running') setView('generate')
    if (job.candidates.length > 0) setView('review')
  }, [job.status, job.candidates.length])

  return (
    <Section>
      <StageNav
        value={view}
        onChange={setView}
        label="风格实验阶段"
        items={[
          { id: 'corpus', label: '样本与画像', hint: '本地分析，零 Token', badge: sources.length },
          { id: 'generate', label: '生成任务', hint: '控制内容与保真度' },
          { id: 'review', label: '候选审阅', hint: '评分、防复制、定稿', badge: job.candidates.length }
        ]}
      />

      {view === 'corpus' && <div className="dw-stage-content">
      {active ? (
        <div className="style-active">
          <span className="style-active-tag">已启用：{active.name}</span>
          <button className="ghost-btn" onClick={() => void styleSetActive(null)}>
            停用
          </button>
        </div>
      ) : (
        <button className="btn ghost block" onClick={() => void addSources()}>
          ＋ 导入风格样本（txt/docx/pdf/epub）
        </button>
      )}

      {sources.length > 0 && (
        <div className="style-sources">
          <div className="char-editor-head">
            <span>样本（{sources.length}）</span>
          </div>
          {sources.map((s: any) => (
            <label key={s.id} className="style-source">
              <input
                type="checkbox"
                checked={selected.includes(s.id)}
                onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))}
              />
              <span className="style-source-name" title={s.path}>
                {s.displayName}
              </span>
              <span className="style-source-meta">
                {(s.charCount / 1000).toFixed(1)}k字 · 句均{s.stats?.sentenceLenMean ?? '-'}字
              </span>
            </label>
          ))}
        </div>
      )}

      {sources.length > 0 && (
        <div className="style-build">
          <button
            className="btn primary block"
            disabled={selected.length === 0 || buildState.status === 'building'}
            onClick={() => void build()}
          >
            {buildState.status === 'building' ? '构建中…' : `构建风格画像（${selected.length} 个来源）`}
          </button>
        </div>
      )}

      {profiles.length > 0 && (
        <div className="sv2-block">
          <div className="sv2-block-title">
            V1 画像（迁移源 · {profiles.length}）
            <button className="ghost-btn" onClick={() => setShowV1Migrate((v) => !v)}>
              {showV1Migrate ? '收起' : '迁移 V1 画像'}
            </button>
          </div>
          {showV1Migrate && (
            <p className="muted small">V1 画像仅作迁移参考，不再直接参与 V2 生成。请在下方样本中勾选对应来源，点击「构建风格画像」用 V2 重建。</p>
          )}
          {profiles.map((p: any) => (
            <div key={p.id} className={`style-profile${p.id === activeId ? ' active' : ''}`}>
              <div className="style-profile-head">
                <span className="style-profile-name">{p.name}</span>
                <span className="style-profile-meta">v{p.version}</span>
                <div className="style-profile-actions">
                  <button className="ghost-btn" onClick={() => void styleSetActive(p.id === activeId ? null : p.id)}>
                    {p.id === activeId ? '停用' : '启用'}
                  </button>
                  <button className="ghost-btn danger" disabled={deletingId === p.id} onClick={() => void removeProfile(p.id)}>
                    {deletingId === p.id ? '删除中…' : '删除'}
                  </button>
                </div>
              </div>
              {p.id === activeId && (
                <div className="style-dims">
                  {p.dimensions.map((d: DimItem) => (
                    <label key={d.id} className="style-dim">
                      <span className="style-dim-label">{d.label}</span>
                      <span className="style-dim-value">
                        {typeof d.value === 'number' ? d.value.toFixed(2) : d.value}
                        {d.unit ?? ''}
                      </span>
                      <input
                        type="checkbox"
                        title="锁定该维度（用户偏好优先）"
                        checked={d.lockedByUser}
                        onChange={(e) =>
                          void styleUpdate(p.id, {
                            dimensions: p.dimensions.map((x: DimItem) => (x.id === d.id ? { ...x, lockedByUser: e.target.checked } : x))
                          })
                        }
                      />
                    </label>
                  ))}
                  <div className="style-rules">
                    {p.positiveRules.map((r: string, i: number) => (
                      <div key={i} className="style-rule">
                        ✓ {r}
                      </div>
                    ))}
                    {p.negativeRules.map((r: string, i: number) => (
                      <div key={`n${i}`} className="style-rule neg">
                        ✗ {r}
                      </div>
                    ))}
                  </div>
                  <div className="style-forbidden">
                    <span className="muted small">防复制词表（{p.forbiddenPhrases.length}）：</span>
                    <span className="muted small">{p.forbiddenPhrases.slice(0, 10).join('、') || '（自动提取）'}</span>
                  </div>
                  <div className="style-check">
                    <input
                      className="style-check-input"
                      placeholder="输入文本检测与样本重叠（留空=检测最新回复）"
                      value={overlapText}
                      onChange={(e) => setOverlapText(e.target.value)}
                    />
                    <button className="ghost-btn" disabled={checking} onClick={() => void check()}>
                      {checking ? '检测中…' : '防复制检测'}
                    </button>
                  </div>
                  {overlapReport && (
                    <div className="style-report">
                      <div className={`style-report-line${overlapReport.longestMatch >= 12 ? ' warn' : ''}`}>
                        最长重叠 {overlapReport.longestMatch} 字 · 相似度 {(overlapReport.similarity * 100).toFixed(1)}% · 来源：{overlapReport.sourceName || '—'}
                      </div>
                      {overlapReport.matches.slice(0, 3).map((m: any, i: number) => (
                        <div key={i} className="style-match" title={m.text}>
                          [{m.length}字] {m.text.slice(0, 60)}…
                        </div>
                      ))}
                      {overlapReport.matches.length === 0 && <div className="style-report-line ok">未发现连续重叠（≥12 字）</div>}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(buildState.status === 'done' || buildState.status === 'building') && (
        <div className="sv2-block">
          <div className="sv2-block-title">语料质量</div>
          {buildState.status === 'building' ? (
            <p className="muted small">正在构建高保真画像与语料统计…</p>
          ) : (
            <>
              <div className="corpus-stats">
                <div className="corpus-stat">
                  <b>{fmtChars(buildState.stats?.effectiveChars ?? 0)}</b>
                  <span>有效字数</span>
                </div>
                <div className="corpus-stat">
                  <b>{(buildState.stats?.chunks ?? 0).toLocaleString()}</b>
                  <span>语料块</span>
                </div>
                <div className="corpus-stat">
                  <b>{(buildState.stats?.exemplarCount ?? 0).toLocaleString()}</b>
                  <span>示例对</span>
                </div>
              </div>
              <div className="split-row">
                <span>画像 {buildState.stats?.splits.profile ?? 0}</span>
                <span>示例 {buildState.stats?.splits.example ?? 0}</span>
                <span>保留 {buildState.stats?.splits.holdout ?? 0}</span>
              </div>
              {buildState.stats?.backgroundBaselineId && (
                <div className="overlap-risk ok">已与背景基线对照：区别于背景基线</div>
              )}
              {buildState.stats && Object.keys(buildState.stats.sceneTypes).length > 0 && (
                <div className="scene-cov">
                  <span className="muted small">场景覆盖（chunk 数）</span>
                  <div className="scene-chips">
                    {Object.entries(buildState.stats.sceneTypes).map(([k, v]) => (
                      <span key={k} className="scene-chip">{k} · {v}</span>
                    ))}
                  </div>
                </div>
              )}
              <button className="btn block" disabled={exemplarState.status === 'building'} onClick={() => void buildExemplars()}>
                {exemplarState.status === 'building' ? '示例库构建中…' : exemplarState.status === 'done' ? `重建示例库（${exemplarState.count} 条）` : '构建示例库'}
              </button>
              {exemplarState.status === 'failed' && exemplarState.error && <p className="muted small sv2-error">{exemplarState.error}</p>}
            </>
          )}
        </div>
      )}
      </div>}

      {view === 'generate' && <div className="dw-stage-content">
      <div className="sv2-block">
        <div className="sv2-block-title">生成任务</div>
        <div className="field">
          <span>场景类型</span>
          <SelectControl value={sceneType} onChange={setSceneType} ariaLabel="场景类型" options={SCENE_TYPES.map((type) => ({ value: type, label: type }))} />
        </div>
        <div className="field">
          <span>叙述功能</span>
          <div className="fn-chips">
            {NARRATIVE_FUNCTIONS.map((f) => (
              <label key={f} className={`fn-chip${narrativeFns.includes(f) ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={narrativeFns.includes(f)}
                  onChange={(e) => setNarrativeFns((prev) => (e.target.checked ? [...prev, f] : prev.filter((x) => x !== f)))}
                />
                {f}
              </label>
            ))}
          </div>
        </div>
        <div className="field row">
          <span>视角</span>
          <SelectControl compact value={pov} onChange={setPov} ariaLabel="视角" options={[{ value: '第一', label: '第一人称' }, { value: '第三', label: '第三人称' }]} />
        </div>
        <label className="field">
          <span>情绪弧（逗号分隔）</span>
          <input type="text" value={emotionArc} onChange={(e) => setEmotionArc(e.target.value)} placeholder="平静→忐忑→爆发" />
        </label>
        <label className="field">
          <span>必含事实（每行一条）</span>
          <textarea value={requiredFacts} onChange={(e) => setRequiredFacts(e.target.value)} placeholder="每行一条，生成时必须出现" />
        </label>
        <label className="field">
          <span>禁含事实（每行一条）</span>
          <textarea value={forbiddenFacts} onChange={(e) => setForbiddenFacts(e.target.value)} placeholder="每行一条，生成时不得出现" />
        </label>
        <div className="field">
          <span>目标字数：{targetChars}</span>
          <input type="range" min={500} max={20000} step={100} value={targetChars} onChange={(e) => setTargetChars(Number(e.target.value))} />
        </div>
        <div className="field">
          <span>保真档</span>
          <div className="fid-grid">
            {FIDELITY_LEVELS.map((f) => (
              <label key={f.key} className={`fid-card${fidelity === f.key ? ' on' : ''}`}>
                <input type="radio" name="fidelity" checked={fidelity === f.key} onChange={() => setFidelity(f.key)} />
                <b>{f.label}</b>
                <span>{f.candidates} 候选</span>
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <span>输出格式</span>
          <SelectControl value={outputFormat} onChange={setOutputFormat} ariaLabel="输出格式" options={[{ value: 'prose', label: '散文' }, { value: 'renpy', label: "Ren'Py 剧本" }]} />
        </div>
        <label className="field">
          <span>内容要求</span>
          <textarea value={userPrompt} onChange={(e) => setUserPrompt(e.target.value)} placeholder="对内容/氛围的补充要求（可选）" />
        </label>
        {job.status === 'running' ? (
          <button className="btn stop block" onClick={() => void stopGen()}>停止生成</button>
        ) : (
          <button className="btn primary block" onClick={() => void startGen()}>开始生成</button>
        )}
      </div>

      {job.stage && job.status !== 'idle' && (
        <div className="job-progress">
          <div className="job-progress-head">
            <span>{job.status === 'cancelled' ? '已取消' : (STAGE_LABELS[job.stage] ?? job.stage)}</span>
            <span>{progressPct}%</span>
          </div>
          <div className="cache-bar">
            <div
              className={`job-fill${job.status === 'failed' ? ' fail' : ''}${job.status === 'cancelled' ? ' cancelled' : ''}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="job-stages">
            {STAGE_ORDER.map((s) => (
              <span key={s} className={`job-stage${stageIdx >= STAGE_ORDER.indexOf(s) ? ' on' : ''}`}>{STAGE_LABELS[s]}</span>
            ))}
          </div>
          {job.status === 'failed' && job.error && <p className="muted small sv2-error">{job.error}</p>}
          {job.status === 'cancelled' && <p className="muted small">任务已取消，可重新开始生成</p>}
        </div>
      )}
      </div>}

      {view === 'review' && job.candidates.length === 0 && (
        <div className="dw-empty-panel">
          <b>还没有可审阅的候选</b>
          <span>先在“生成任务”中启动一次生成。候选不会在这里伪造展示。</span>
          <button className="ghost-btn" onClick={() => setView('generate')}>前往生成任务</button>
        </div>
      )}
      {view === 'review' && job.candidates.length > 0 && (
        <div className="sv2-block">
          <div className="sv2-block-title">候选对比</div>
          <div className="cand-grid">
            {job.candidates.map((cand) => {
              const ev = job.evaluations.find((e) => e.candidateId === cand.id) ?? null
              const lo = longestOverlap(ev)
              const chosen = job.chosenCandidateId === cand.id
              const isExpanded = expanded === cand.id
              return (
                <div key={cand.id} className={`cand-card${chosen ? ' chosen' : ''}${ev?.finalRank === 1 ? ' top' : ''}`}>
                  <div className="cand-head">
                    <b>候选 {cand.variant}</b>
                    {ev?.finalRank === 1 && <span className="cand-rank">首选</span>}
                    <span className="cand-chars">{cand.charCount} 字</span>
                  </div>
                  <pre className="cand-text">
                    {isExpanded ? cand.text : cand.text.slice(0, 800)}
                    {!isExpanded && cand.text.length > 800 ? '…' : ''}
                  </pre>
                  {cand.text.length > 800 && (
                    <button className="ghost-btn" onClick={() => setExpanded(isExpanded ? null : cand.id)}>
                      {isExpanded ? '收起' : `展开全文（${cand.text.length} 字）`}
                    </button>
                  )}
                  {ev && (
                    <div className="cand-scores">
                      <ScoreBar label="风格" value={ev.stylometryScore} color={SCORE_COLORS.style} />
                      <ScoreBar label="内容" value={ev.contentScore} color={SCORE_COLORS.content} />
                      <ScoreBar label="新颖" value={ev.noveltyScore} color={SCORE_COLORS.novelty} />
                      <ScoreBar label="自然" value={ev.naturalnessScore} color={SCORE_COLORS.naturalness} />
                    </div>
                  )}
                  {ev && (
                    <div className="gate-row">
                      <GateBadge label="内容" ok={ev.hardGates.content} />
                      <GateBadge label="防复制" ok={ev.hardGates.novelty} />
                      <GateBadge label="流畅" ok={ev.hardGates.fluency} />
                    </div>
                  )}
                  {lo ? (
                    <div className="overlap-risk">最长重叠 {lo.length} 字 · {lo.sourceName}</div>
                  ) : (
                    <div className="overlap-risk ok">无重叠风险</div>
                  )}
                  {chosen ? (
                    <span className="chosen-tag">✓ 已选</span>
                  ) : (
                    <button className="btn primary block" disabled={choosingId === cand.id} onClick={() => void chooseCandidate(cand.id)}>
                      {choosingId === cand.id ? '选择中…' : '选择此候选'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="token-ledger">
            <div className="ledger-title">Token 账本</div>
            <div className="ledger-row"><span>骨架</span><b>{job.usageTokens.skeleton.toLocaleString()}</b></div>
            <div className="ledger-row"><span>候选</span><b>{job.usageTokens.candidates.toLocaleString()}</b></div>
            <div className="ledger-row"><span>修订</span><b>{job.usageTokens.revise.toLocaleString()}</b></div>
            <div className="ledger-row total"><span>总计</span><b>{job.usageTokens.total.toLocaleString()}</b></div>
          </div>
          {job.chosenCandidateId && chosenEv && (
            <div className="chosen-box">
              <div className="chosen-head">
                <span>已选：候选 {job.candidates.find((c) => c.id === job.chosenCandidateId)?.variant ?? '—'}</span>
                <button className="ghost-btn" disabled={copying} onClick={() => void copyText()}>
                  {copying ? '复制中…' : '复制全文'}
                </button>
                <button className="ghost-btn" disabled={copying} onClick={() => void insertToScene()}>
                  插入当前场景
                </button>
              </div>
              {chosenEv.failedSpans.length > 0 && (
                <button className="btn block" disabled={revising || job.status === 'running'} onClick={() => void doRevise()}>
                  {revising ? '修订提交中…' : `局部修订（${chosenEv.failedSpans.length} 处重叠）`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  )
}
