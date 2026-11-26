import { useEffect, useRef, useState } from 'react'
import GrillMeWorkbench from './GrillMeWorkbench'
import SelectControl from './SelectControl'
import Icon from './Icon'
import StudioBranchExplorer from './StudioBranchExplorer'
import type { StudioBranchGraph } from './StudioBranchExplorer'
import type { GrillMeState } from '../../../shared/grillMe'
import { RENPY_SDK_VERSION } from '../../../shared/galgameStudio'
import type { GalgameAssetManifest, GalgameStudioSnapshot, GalgameStudioState, GalgameStudioPlaytestResult as PlaytestState } from '../../../shared/galgameStudio'
import './GalgameStudio.css'

interface Props {
  sessionId: string
  onClose?: () => void
}

interface FileRefView {
  fileRefId: string
  displayName: string
  size: number
}

interface RepairProposalView {
  patch: unknown
  diff: string
  file: string
  diagnostics: Array<{ message?: string }>
}

interface StudioApi {
  chooseDir: (sessionId: string) => Promise<{ view: { fileRefId: string }; path: string } | null>
  openFiles: (sessionId: string) => Promise<FileRefView[]>
  galgameStudioCreate: (input: { sessionId: string; parentDir: string; name: string }) => Promise<GalgameStudioState>
  galgameStudioImport: (input: { sessionId: string; projectDir: string }) => Promise<GalgameStudioState>
  galgameStudioLatest: (sessionId: string) => Promise<GalgameStudioSnapshot | null>
  galgameStudioGet: (studioId: string) => Promise<GalgameStudioSnapshot>
  galgameStudioPlaytestStart: (studioId: string) => Promise<PlaytestState>
  galgameStudioPlaytestStop: (studioId: string) => Promise<PlaytestState>
  galgameStudioPlaytestStatus: (studioId: string) => Promise<PlaytestState>
  grillCancel: (sessionId: string) => Promise<boolean>
  galgameStudioOpenProject: (studioId: string) => Promise<boolean>
  galgameStudioSdkCheck: (studioId: string) => Promise<{ status: string; message?: string; candidate?: { evidence?: { root?: string; version?: string } } | null }>
  galgameStudioSdkChoose: (studioId: string) => Promise<{ status: string; message?: string; candidate?: { evidence?: { root?: string; version?: string } } | null }>
  galgameStudioSdkDownload: (studioId: string) => Promise<unknown>
  galgameStudioSdkCancel: (studioId: string) => void
  galgameStudioSetAssets: (studioId: string, manifest: GalgameAssetManifest) => Promise<{ ok: boolean; issues?: Array<{ message: string }> }>
  grillStart: (input: { sessionId: string; originalTask: string; targetChars: number; genre?: string; kind?: string }) => Promise<GrillMeState>
  grillGet: (sessionId: string) => Promise<GrillMeState | null>
  renpyBranchGraph: (projectDir: string) => Promise<StudioBranchGraph>
  galgameStudioConfirmPlan: (input: { studioId: string; branchHash: string; outlineHash?: string }) => Promise<GalgameStudioState>
  galgameStudioGenerate: (studioId: string) => Promise<{ ok: boolean; generatedFile?: string; error?: string }>
  galgameStudioLint: (studioId: string) => Promise<{ ok: boolean; verified: boolean; output: string; errorCount: number; warningCount: number; command: string }>
  galgameStudioRepair: (input: { studioId: string; maxRepairs?: number }) => Promise<{ ok: boolean; repairRounds: number; proposals: unknown[]; lintAfterApply?: unknown }>
  renpyApplyPatch: (input: { projectDir: string; patch: unknown }) => Promise<{ ok: boolean; diff: string | null; file: string; error?: string }>
  onGalgameStudioProgress: (cb: (data: { studioId: string; progress: { phase: string; percent?: number | null; message: string } }) => void) => () => void
}

const api = (): StudioApi | null => (window as unknown as { ds?: StudioApi }).ds ?? null
type View = 'prepare' | 'story' | 'generate' | 'verify'
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'prepare', label: '项目与素材' }, { id: 'story', label: '剧情与分支' },
  { id: 'generate', label: '生成剧本' }, { id: 'verify', label: '检查与试玩' }
]
function stageView(stage: GalgameStudioState['stage']): View {
  if (stage === 'sdk_ready' || stage === 'assets_ready') return 'prepare'
  if (stage === 'grill' || stage === 'outline/branch_confirmed') return 'story'
  return stage === 'generate' ? 'generate' : 'verify'
}

const emptyManifest = (): GalgameAssetManifest => ({ schemaVersion: 1, characters: [{ id: 'protagonist', name: '', setting: '' }], sprites: [], backgrounds: [], audio: [] })

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function sdkName(version?: string): string {
  return version ? "Ren'Py " + version : "Ren'Py SDK"
}

// A session change remounts every draft, pending indicator and repair proposal.
export default function GalgameStudio(props: Props): React.ReactNode {
  return <StudioWorkbench key={props.sessionId} {...props} />
}

function StudioWorkbench({ sessionId, onClose }: Props): React.ReactNode {
  const [state, setState] = useState<GalgameStudioState | null>(null)
  const [snapshot, setSnapshot] = useState<GalgameStudioSnapshot | null>(null)
  const [parentDir, setParentDir] = useState('')
  const [projectName, setProjectName] = useState('我的 Galgame')
  const [importDir, setImportDir] = useState('')
  const [task, setTask] = useState('')
  const [targetChars, setTargetChars] = useState(8000)
  const [manifest, setManifest] = useState<GalgameAssetManifest>(emptyManifest)
  const [grill, setGrill] = useState<GrillMeState | null>(null)
  const [sdkMessage, setSdkMessage] = useState('尚未选择 SDK')
  const [sdkDownloading, setSdkDownloading] = useState(false)
  const [sdkProgress, setSdkProgress] = useState<{ percent?: number | null; message: string } | null>(null)
  const [branchGraph, setBranchGraph] = useState<StudioBranchGraph | null>(null)
  const [repairProposals, setRepairProposals] = useState<RepairProposalView[]>([])
  const [busy, setBusy] = useState(false)
  const [operation, setOperation] = useState('')
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('prepare')
  const [graphLoading, setGraphLoading] = useState(false)
  const [graphError, setGraphError] = useState('')
  const [playtest, setPlaytest] = useState<PlaytestState | null>(null)
  const alive = useRef(true)
  const graphRequest = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const ds = api()
  const canPlayOriginal = Boolean(state?.projectMode === 'import' && state.sdkReady && !state.generatedFile && state.production?.integration !== 'required')

  const acceptSnapshot = (next: GalgameStudioSnapshot): void => {
    if (!alive.current) return
    setSnapshot(next); setState(next.state)
    const embedded = (next as GalgameStudioSnapshot & { branchGraph?: StudioBranchGraph }).branchGraph
    if (embedded) setBranchGraph(embedded)
    if (next.state.sdkReady) setSdkMessage(sdkName(next.state.sdk?.version))
  }
  const refresh = async (studioId = state?.studioId): Promise<void> => {
    if (!studioId || !ds || !alive.current) return
    acceptSnapshot(await ds.galgameStudioGet(studioId))
  }
  const invalidateGraph = (): void => { graphRequest.current += 1; setBranchGraph(null); setGraphLoading(false); setGraphError('') }
  const loadGraph = async (): Promise<void> => {
    if (!ds || !state) return
    const ticket = ++graphRequest.current
    setGraphLoading(true); setGraphError('')
    try {
      // Confirmation needs a graph and its matching hash from one snapshot.
      const needsConfirmation = !state.outlineBranchConfirmed && (state.grillConfirmed || grill?.status === 'confirmed')
      const fresh = needsConfirmation ? await ds.galgameStudioGet(state.studioId) : null
      if (!alive.current || ticket !== graphRequest.current) return
      if (fresh) acceptSnapshot(fresh)
      const next = fresh?.branchGraph ?? await ds.renpyBranchGraph(state.projectDir)
      if (alive.current && ticket === graphRequest.current) setBranchGraph(next)
    } catch (e) { if (alive.current && ticket === graphRequest.current) setGraphError(e instanceof Error ? e.message : '分支读取失败') }
    finally { if (alive.current && ticket === graphRequest.current) setGraphLoading(false) }
  }
  useEffect(() => {
    if (!ds) return undefined
    return ds.onGalgameStudioProgress(event => {
      if (event.studioId === state?.studioId) setSdkProgress(event.progress)
    })
  }, [ds, state?.studioId])

  const restore = async (): Promise<void> => {
    if (!ds) { setLoading(false); setError('桌面连接不可用，请重新打开工作室。'); return }
    setLoading(true); setError('')
    try {
      const latest = await ds.galgameStudioLatest(sessionId)
      if (!alive.current || !latest) return
      acceptSnapshot(latest)
      if (latest.state.assets) setManifest(latest.state.assets)
      const next = await ds.grillGet(sessionId)
      if (alive.current) setGrill(next?.status === 'cancelled' ? null : next)
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '读取工作室失败，请重试。') }
    finally { if (alive.current) setLoading(false) }
  }
  useEffect(() => { void restore() }, [ds, sessionId])
  useEffect(() => { if (state) setView(stageView(state.stage)) }, [state?.stage])
  // No updatedAt-triggered full-project scans. Reuse the snapshot graph;
  // inspect on demand and invalidate only after writes to the script.
  useEffect(() => {
    if (state && view === 'story' && !branchGraph && !graphLoading && !graphError) void loadGraph()
  }, [state?.studioId, view, branchGraph])
  useEffect(() => {
    if (!ds || !state || (!state.generatedFile && !canPlayOriginal)) return
    let live = true
    void ds.galgameStudioPlaytestStatus(state.studioId).then(next => { if (live) setPlaytest(next) }).catch(() => undefined)
    return () => { live = false }
  }, [ds, state?.studioId, state?.generatedFile, canPlayOriginal])
  useEffect(() => {
    if (!ds || !state || playtest?.status !== 'running') return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const next = await ds.galgameStudioPlaytestStatus(state.studioId)
        if (!live) return
        setPlaytest(next)
        if (next.status === 'running') timer = setTimeout(() => void poll(), 1500)
      } catch { if (live) setError('无法读取试玩状态。可重试停止试玩，或重新打开工作室。') }
    }
    timer = setTimeout(() => void poll(), 1500)
    return () => { live = false; clearTimeout(timer) }
  }, [ds, state?.studioId, playtest?.status])

  const stage = state?.stage ?? 'sdk_ready'
  const isProjectReady = Boolean(state)
  const assetIssues = snapshot?.assetCheck?.issues ?? []
  const canSetAssets = stage === 'assets_ready' || stage === 'sdk_ready'
  const hasConfirmedGrill = Boolean(state?.grillConfirmed || grill?.status === 'confirmed')
  const selectedFileCount = manifest.sprites.length + manifest.backgrounds.length + manifest.audio.length
  const activeState = state as GalgameStudioState
  const blocked = busy || sdkDownloading || loading
  const currentView = state ? stageView(stage) : 'prepare'
  const production = state?.production
  const canPlay = stage === 'done' && production?.integration !== 'required'
  const begin = (message: string): void => { setBusy(true); setOperation(message); setError(''); setNotice('') }
  const finish = (): void => { if (alive.current) { setBusy(false); setOperation('') } }
  const play = async (stop = false): Promise<void> => {
    if (!ds || !state) return
    begin(stop ? '正在停止试玩…' : '正在启动试玩…')
    try {
      const next = await (stop ? ds.galgameStudioPlaytestStop(state.studioId) : ds.galgameStudioPlaytestStart(state.studioId))
      if (alive.current) { setPlaytest(next); if (next.status === 'failed') setError(next.message || '试玩未能启动，可重试。') }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '试玩操作失败，可重试。') }
    finally { finish() }
  }

  const chooseParent = async (): Promise<void> => {
    if (!ds) return
    try { const picked = await ds.chooseDir(sessionId); if (alive.current && picked) setParentDir(picked.path) } catch (e) { setError(e instanceof Error ? e.message : '无法选择目录') }
  }

  const chooseImport = async (): Promise<void> => {
    if (!ds) return
    try { const picked = await ds.chooseDir(sessionId); if (alive.current && picked) setImportDir(picked.path) } catch (e) { setError(e instanceof Error ? e.message : '无法选择目录') }
  }

  const createProject = async (): Promise<void> => {
    if (!ds || !projectName.trim()) return
    begin('正在创建项目…')
    try {
      const destination = parentDir || (await ds.chooseDir(sessionId))?.path
      if (!destination || !alive.current) return
      setParentDir(destination)
      const created = await ds.galgameStudioCreate({ sessionId, parentDir: destination, name: projectName })
      if (!alive.current) return
      setState(created); setNotice('项目已创建。接下来准备 SDK。'); await refresh(created.studioId)
    } catch (e) { setError(e instanceof Error ? e.message : '创建项目失败') } finally { finish() }
  }

  const importProject = async (): Promise<void> => {
    if (!ds) return
    begin('正在导入项目…')
    try {
      const destination = importDir || (await ds.chooseDir(sessionId))?.path
      if (!destination || !alive.current) return
      setImportDir(destination)
      const imported = await ds.galgameStudioImport({ sessionId, projectDir: destination })
      if (!alive.current) return
      setState(imported); setNotice('项目已导入。接下来检查 SDK。'); await refresh(imported.studioId)
    } catch (e) { setError(e instanceof Error ? e.message : '导入项目失败') } finally { finish() }
  }

  const checkSdk = async (): Promise<void> => {
    if (!ds || !state) return
    begin('正在检查本机 SDK…')
    try {
      const result = await ds.galgameStudioSdkCheck(state.studioId)
      setSdkMessage(result.message ?? (result.status === 'ready' ? sdkName(result.candidate?.evidence?.version) : '未找到可用 SDK'))
      await refresh(state.studioId)
    } catch (e) { setError(e instanceof Error ? e.message : 'SDK 检查失败') } finally { finish() }
  }

  const chooseSdk = async (): Promise<void> => {
    if (!ds || !state) return
    begin('正在验证所选 SDK…')
    try {
      const result = await ds.galgameStudioSdkChoose(state.studioId)
      if (result.status === 'cancelled') return
      setSdkMessage(result.message ?? (result.status === 'ready' ? sdkName(result.candidate?.evidence?.version) : '选择的 SDK 不可用'))
      if (result.status !== 'ready') setError(result.message ?? "请选择解压后的 Ren'Py SDK 目录。")
      await refresh(state.studioId)
    } catch (e) { setError(e instanceof Error ? e.message : '导入 SDK 失败') } finally { finish() }
  }

  const downloadSdk = async (): Promise<void> => {
    if (!ds || !state) return
    setSdkDownloading(true); setError(''); setNotice(''); setSdkProgress({ percent: 0, message: '准备下载官方 SDK…' })
    try { await ds.galgameStudioSdkDownload(state.studioId); setSdkMessage('官方 SDK 已安装并验证'); await refresh(state.studioId) }
    catch (e) { setError(e instanceof Error ? e.message : 'SDK 下载失败') }
    finally { setSdkDownloading(false) }
  }

  const chooseAssetFiles = async (kind: 'sprite' | 'background' | 'audio'): Promise<void> => {
    if (!ds || !state) return
    begin('正在选择素材…')
    try {
      const files = await ds.openFiles(sessionId)
      if (!alive.current || files.length === 0) return
      const imageFiles = files.filter((file) => ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension(file.displayName)))
      const audioFiles = files.filter((file) => ['.ogg', '.mp3', '.wav', '.webm'].includes(extension(file.displayName)))
      if (kind !== 'audio' && imageFiles.length === 0) throw new Error('请选择 PNG、JPG、WEBP 或 GIF 图片')
      if (kind === 'audio' && audioFiles.length === 0) throw new Error('请选择 OGG、MP3、WAV 或 WEBM 音频')
      setManifest((current) => {
        if (kind === 'sprite') return {
          ...current,
          sprites: imageFiles.map((file, index) => ({ id: `sprite_${Date.now()}_${index + 1}`, characterId: current.characters[0]?.id || 'protagonist', expression: index === 0 ? 'default' : `expression_${index + 1}`, fileRefId: file.fileRefId, displayName: file.displayName }))
        }
        if (kind === 'background') return {
          ...current,
          backgrounds: imageFiles.map((file, index) => ({ id: `background_${Date.now()}_${index + 1}`, name: file.displayName.replace(/\.[^.]+$/, ''), fileRefId: file.fileRefId, displayName: file.displayName }))
        }
        return {
          ...current,
          audio: audioFiles.map((file, index) => ({ id: `audio_${Date.now()}_${index + 1}`, name: file.displayName.replace(/\.[^.]+$/, ''), kind: 'music' as const, fileRefId: file.fileRefId, displayName: file.displayName }))
        }
      })
      setNotice(`已选择 ${kind === 'sprite' ? imageFiles.length : kind === 'background' ? imageFiles.length : audioFiles.length} 个${kind === 'sprite' ? '立绘/表情' : kind === 'background' ? '背景' : '音频'}文件。`)
    } catch (e) { setError(e instanceof Error ? e.message : '选择素材失败') } finally { finish() }
  }

  const addCharacter = (): void => setManifest((current) => ({
    ...current,
    characters: [...current.characters, { id: `character_${Date.now()}`, name: '', setting: '' }]
  }))

  const removeCharacter = (characterId: string): void => setManifest((current) => ({
    ...current,
    characters: current.characters.filter((character) => character.id !== characterId),
    sprites: current.sprites.filter((sprite) => sprite.characterId !== characterId)
  }))

  const submitAssets = async (): Promise<void> => {
    if (!ds || !state) return
    begin('正在校验人物与素材…')
    try {
      const result = await ds.galgameStudioSetAssets(state.studioId, manifest)
      if (!result.ok) setError(result.issues?.map((issue) => issue.message).join('；') || '素材清单未通过校验')
      else { setNotice(`素材清单已锁定（${selectedFileCount} 个文件）；现在逐问梳理剧情。`); await refresh(state.studioId) }
    } catch (e) { setError(e instanceof Error ? e.message : '素材校验失败') } finally { finish() }
  }

  const startGrill = async (): Promise<void> => {
    if (!ds || !state || !task.trim()) return
    begin('正在准备剧情提问…')
    try { const next = await ds.grillStart({ sessionId, originalTask: task, targetChars, genre: 'Galgame', kind: 'Galgame 剧本' }); setGrill(next) }
    catch (e) { setError(e instanceof Error ? e.message : '启动 Grill Me 失败') } finally { finish() }
  }

  const openPlanConfirmation = async (confirmed: GrillMeState): Promise<void> => {
    setGrill(confirmed)
    await refresh(state?.studioId)
  }

  const confirmPlan = async (): Promise<void> => {
    if (!ds || !state || !snapshot?.branchHash || !grill?.outlineHash) return
    begin('正在确认大纲与分支…')
    try { await ds.galgameStudioConfirmPlan({ studioId: state.studioId, branchHash: snapshot.branchHash, outlineHash: grill.outlineHash }); setNotice('大纲与分支图已确认；可以开始制作。'); await refresh(state.studioId) }
    catch (e) { setError(e instanceof Error ? e.message : '确认大纲与分支图失败'); try { await refresh(state.studioId) } catch { /* The confirmation action remains available. */ } } finally { finish() }
  }

  const generate = async (): Promise<void> => {
    if (!ds || !state) return
    begin('正在生成并写入剧本…')
    try { const result = await ds.galgameStudioGenerate(state.studioId); if (!result.ok) setError(result.error ?? '生成失败'); else { invalidateGraph(); setNotice('剧本已写入项目，可以运行检查。') }; await refresh(state.studioId) }
    catch (e) { setError(e instanceof Error ? e.message : '生成失败；前置确认可能已变化'); try { await refresh(state.studioId) } catch { /* Retain the actionable generation error. */ } } finally { finish() }
  }

  const lint = async (): Promise<void> => {
    if (!ds || !state) return
    begin("正在运行 Ren'Py Lint…")
    try { const result = await ds.galgameStudioLint(state.studioId); invalidateGraph(); if (result.ok && result.verified) setNotice(`脚本检查通过（警告 ${result.warningCount} 个）`); else setError(`lint 未通过：${result.errorCount} 个错误`); await refresh(state.studioId) }
    catch (e) { setError(e instanceof Error ? e.message : 'Lint 执行失败'); try { await refresh(state.studioId) } catch { /* Keep the failed check visible. */ } } finally { finish() }
  }

  const repair = async (): Promise<void> => {
    if (!ds || !state) return
    begin('正在生成修复提案…')
    try {
      const result = await ds.galgameStudioRepair({ studioId: state.studioId, maxRepairs: 2 })
      const proposals = result.proposals.filter((item): item is RepairProposalView => Boolean(item && typeof item === 'object' && 'patch' in item && 'diff' in item))
      setRepairProposals(proposals)
      setNotice(proposals.length > 0 ? `已生成 ${proposals.length} 份修复提案；确认差异后再写入。` : result.ok ? '当前项目不需要修复。' : `没有生成可用修复提案（已尝试 ${result.repairRounds} 轮）`)
      await refresh(state.studioId)
    }
    catch (e) { setError(e instanceof Error ? e.message : '修复循环失败') } finally { finish() }
  }

  const applyRepair = async (proposal: RepairProposalView): Promise<void> => {
    if (!ds || !state) return
    begin('正在应用修复并重新检查…')
    try {
      const applied = await ds.renpyApplyPatch({ projectDir: state.projectDir, patch: proposal.patch })
      if (!applied.ok) throw new Error(applied.error ?? '修复补丁未能安全写入')
      setRepairProposals((current) => current.filter((item) => item !== proposal))
      invalidateGraph()
      const checked = await ds.galgameStudioLint(state.studioId)
      setNotice(checked.ok && checked.verified ? '修复已应用，脚本检查通过。' : `修复已应用，仍有 ${checked.errorCount} 个错误。`)
      await refresh(state.studioId)
    } catch (e) { setError(e instanceof Error ? e.message : '应用修复失败') } finally { finish() }
  }

  const openProject = async (): Promise<void> => {
    if (!ds || !state) return
    try {
      const opened = await ds.galgameStudioOpenProject(state.studioId)
      if (!opened) setError('无法打开项目目录')
      else setNotice('已打开项目目录。')
    } catch (e) { setError(e instanceof Error ? e.message : '无法打开项目目录') }
  }

  return (
    <section className="galgame-studio" aria-label="Galgame Studio" data-stage={stage} aria-busy={blocked}>
      <header className="galgame-studio-head">
        <div><h1>Galgame 制作</h1><p>{state ? state.projectName : '把一个故事，做成可以选择的世界。'}</p></div>
        {onClose ? <button className="studio-close" type="button" onClick={onClose}>关闭</button> : <Icon name="game" size={30} />}
      </header>
      {isProjectReady && <nav className="studio-navigation" aria-label="制作阶段">
        {VIEWS.map((item, index) => <button type="button" key={item.id} aria-current={view === item.id ? 'step' : undefined} className={view === item.id ? 'selected' : ''} onClick={() => setView(item.id)}><span>{index + 1}</span>{item.label}{currentView === item.id && view !== item.id ? <i aria-label="当前进度" /> : null}</button>)}
      </nav>}
      {loading ? <p className="studio-loading" role="status">正在恢复工作室…</p> : null}
      {error ? <div className="studio-alert error" role="alert"><span>{error}</span><button className="text-btn" type="button" onClick={() => setError('')}>收起</button></div> : null}
      {notice ? <p className="studio-alert" role="status">{notice}</p> : null}
      {busy ? <p className="studio-operation" role="status"><span className="studio-spinner" aria-hidden="true" />{operation}</p> : null}
      {!loading && !isProjectReady ? (
        <div className="studio-project-entry">
          <div className="studio-entry-intro"><h2>从新项目开始</h2><p>先取一个名字，选择保存位置。<br />SDK、人物素材与剧情，我们一步步来。</p></div>
          <div className="studio-create-form">
            <label>项目名称<input value={projectName} disabled={blocked} onChange={event => setProjectName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !blocked && projectName.trim()) void createProject() }} placeholder="我的 Galgame" /></label>
            {parentDir ? <button className="studio-location text-btn" type="button" disabled={blocked} title={parentDir} onClick={() => void chooseParent()}><Icon name="folder" size={16} />{parentDir}</button> : null}
            <button className="btn primary studio-entry-primary" type="button" disabled={blocked || !projectName.trim() || !ds} onClick={() => void createProject()}><Icon name="plus" size={17} />{parentDir ? '创建项目' : '选择位置并创建'}</button>
          </div>
          <div className="studio-import-entry"><div><h3>已经有 Ren'Py 项目？</h3><p>选择含 game 文件夹的目录，继续制作或查看分支。</p></div><button className="btn" type="button" disabled={blocked || !ds} onClick={() => void importProject()}><Icon name="folder" size={16} />导入现有项目</button></div>
          {importDir ? <button type="button" className="text-btn studio-location" disabled={blocked} onClick={() => void chooseImport()} title={importDir}>{importDir}</button> : null}
          {error && ds ? <button className="text-btn" type="button" disabled={blocked} onClick={() => void restore()}>重新读取已保存的项目</button> : null}
        </div>
      ) : !loading && state ? (
        <>
          <div className="studio-project-strip"><span><Icon name="folder" size={16} />{activeState.projectMode === 'import' ? '已导入项目' : '本地项目'}</span><div>{activeState.sdkReady && activeState.sdk ? <button type="button" className="text-btn studio-sdk-choice" disabled={blocked} onClick={() => void chooseSdk()} aria-label={'更换 SDK，当前为 ' + sdkName(activeState.sdk.version)}>{sdkName(activeState.sdk.version)} <Icon name="chevronDown" size={14} /></button> : null}<button className="text-btn" type="button" disabled={blocked} title={activeState.projectDir} onClick={() => void openProject()}>打开目录</button></div></div>
          {canPlayOriginal && <div className="studio-original-playtest">
            <div><h3>先体验已有的故事</h3><p>直接试玩原项目，无需提交素材或重新生成。启动前会运行真实 SDK 检查。</p>{playtest?.status === 'running' || playtest?.message ? <p className="studio-original-status" role="status">{playtest.status === 'running' ? '原项目正在运行。' : ''}{playtest.message}</p> : null}</div>
            {playtest?.status === 'running' ? <button className="btn primary" type="button" disabled={busy} onClick={() => void play(true)}><Icon name="stop" size={17} />停止试玩</button> : <button className="btn primary" type="button" disabled={blocked} onClick={() => void play()}><Icon name="game" size={18} />试玩原项目</button>}
          </div>}
          {view === 'prepare' && <>
            {!activeState.sdkReady ? <div className="studio-card">
              <h2>先准备 Ren'Py SDK</h2><p>用来检查剧本、启动游戏。已有 SDK 可直接选择，没有则下载官方版本。</p>
              {sdkMessage !== '尚未选择 SDK' || sdkDownloading ? <div className="sdk-status" role="status"><strong>{sdkMessage}</strong>{sdkProgress && sdkDownloading ? <span>{sdkProgress.message}{sdkProgress.percent != null ? ` ${sdkProgress.percent}%` : ''}</span> : null}{sdkDownloading ? <progress aria-label="SDK 下载进度" max={100} value={sdkProgress?.percent ?? undefined} /> : null}</div> : null}
              <div className="studio-actions"><button className="btn primary" type="button" disabled={blocked} onClick={() => void checkSdk()}>检查本机 SDK</button><button className="btn" type="button" disabled={blocked} onClick={() => void chooseSdk()}>选择 SDK 目录</button><button className="btn" type="button" disabled={blocked} onClick={() => void downloadSdk()}>{sdkDownloading ? '下载中…' : '下载官方 SDK ' + RENPY_SDK_VERSION}</button>{sdkDownloading ? <button className="btn" type="button" onClick={() => { ds?.galgameStudioSdkCancel(activeState.studioId); setSdkProgress(current => ({ ...current, message: '正在取消下载…' })) }}>取消下载</button> : null}</div>
            </div> : canSetAssets ? <div className="studio-card">
              <div className="studio-section-head"><div><h2>人物与素材</h2><p>写下人物设定，再为故事选择立绘和背景。音频可稍后添加。</p></div><button className="btn" type="button" disabled={blocked} onClick={addCharacter}>添加角色</button></div>
              <fieldset className="studio-edit-fields" disabled={blocked}><div className="character-editor">{manifest.characters.map((character, index) => <div className="character-row" key={character.id}>
                <div className="character-row-head"><strong>角色 {index + 1}</strong>{manifest.characters.length > 1 ? <button type="button" className="text-btn" onClick={() => removeCharacter(character.id)}>移除</button> : null}</div>
                <label>角色名<input required value={character.name} onChange={event => setManifest(current => ({ ...current, characters: current.characters.map(item => item.id === character.id ? { ...item, name: event.target.value } : item) }))} placeholder="例如：夏澄" /></label>
                <label>人物设定<textarea required value={character.setting} onChange={event => setManifest(current => ({ ...current, characters: current.characters.map(item => item.id === character.id ? { ...item, setting: event.target.value } : item) }))} placeholder="性格、目标、关系与不可违背的边界" rows={3} /></label>
              </div>)}</div>
              <div className="asset-picker-grid"><button className="asset-picker" type="button" onClick={() => void chooseAssetFiles('sprite')}><Icon name="document" size={20} /><b>立绘 / 表情</b><span>{manifest.sprites.length ? `已选 ${manifest.sprites.length} 张 · 重新选择` : '选择人物图片'}</span></button><button className="asset-picker" type="button" onClick={() => void chooseAssetFiles('background')}><Icon name="folder" size={20} /><b>背景图片</b><span>{manifest.backgrounds.length ? `已选 ${manifest.backgrounds.length} 张 · 重新选择` : '选择场景图片'}</span></button><button className="asset-picker" type="button" onClick={() => void chooseAssetFiles('audio')}><Icon name="paperclip" size={20} /><b>音乐 / 音效</b><span>{manifest.audio.length ? `已选 ${manifest.audio.length} 个 · 重新选择` : '可选'}</span></button></div>
              {manifest.sprites.length ? <div className="sprite-bindings">{manifest.sprites.map((sprite, index) => <div className="sprite-binding" key={sprite.id}><span title={sprite.displayName}>{sprite.displayName}</span><SelectControl compact disabled={blocked} ariaLabel={`为 ${sprite.displayName ?? `立绘 ${index + 1}`} 选择角色`} value={sprite.characterId} options={manifest.characters.map((character, i) => ({ value: character.id, label: character.name || `角色 ${i + 1}` }))} onChange={characterId => setManifest(current => ({ ...current, sprites: current.sprites.map(item => item.id === sprite.id ? { ...item, characterId } : item) }))} /><input aria-label={`立绘 ${index + 1} 表情名`} value={sprite.expression} onChange={event => setManifest(current => ({ ...current, sprites: current.sprites.map(item => item.id === sprite.id ? { ...item, expression: event.target.value } : item) }))} /></div>)}</div> : null}
              {manifest.backgrounds.length || manifest.audio.length ? <p className="studio-file-names">{[...manifest.backgrounds, ...manifest.audio].map(file => file.displayName).join('、')}</p> : null}
              </fieldset>
              {assetIssues.length ? <ul className="studio-issues">{assetIssues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul> : null}
              <button className="btn primary" type="button" disabled={blocked} onClick={() => void submitAssets()}>确认素材，梳理剧情</button>
            </div> : <div className="studio-card"><h2>制作资料已准备好</h2><div className="studio-asset-review">{manifest.characters.map(character => <div key={character.id}><h3>{character.name}</h3><p>{character.setting}</p></div>)}</div><p>{manifest.sprites.length} 张立绘，{manifest.backgrounds.length} 张背景，{manifest.audio.length} 个音频</p><button className="btn primary" type="button" onClick={() => setView(currentView)}>继续当前阶段</button></div>}
          </>}
          {view === 'story' && <div className={`studio-story-stack${activeState.outlineBranchConfirmed ? ' confirmed' : ''}`}>
            {!hasConfirmedGrill ? <div className="studio-card"><h2>逐问梳理剧情</h2>{activeState.assetsReady ? !grill ? <><p>从一句故事开始。逐个回答问题，再一起确认大纲。</p><label className="studio-story-input">故事想法<textarea className="studio-task" value={task} disabled={blocked} onChange={event => setTask(event.target.value)} placeholder="故事发生在哪里？谁想做什么，又遇到了什么阻碍？" rows={4} /></label><div className="studio-actions"><label className="target-input">目标字数<input type="number" min={100} disabled={blocked} value={targetChars} onChange={event => setTargetChars(Math.max(100, Math.trunc(Number(event.target.value) || 100)))} /></label><button className="btn primary" type="button" disabled={blocked || !task.trim()} onClick={() => void startGrill()}>开始提问</button></div></> : <GrillMeWorkbench key={grill.stateId} state={grill} onChange={setGrill} onConfirmed={openPlanConfirmation} onCancel={() => { begin('正在停止梳理…'); void ds?.grillCancel(sessionId).then(cancelled => { if (!cancelled) throw new Error('梳理未能停止，请重试。'); if (alive.current) setGrill(null) }).catch(e => setError(e instanceof Error ? e.message : '停止梳理失败')).finally(finish) }} /> : <><p>先完成 SDK 和人物素材，便可开始创作。已有剧情的分支仍可在下方查看。</p><button className="btn" type="button" onClick={() => setView('prepare')}>准备项目与素材</button></>}</div> : <div className="studio-card"><div className="studio-section-head"><div><h2>{activeState.outlineBranchConfirmed ? '已确认的大纲' : '确认大纲与分支'}</h2><p>{activeState.outlineBranchConfirmed ? '生成将遵循这份大纲和已经确认的素材。' : '查看故事走向和项目中的现有连接，再进入生成。'}</p></div></div>{grill?.approvedOutline ? <div className="studio-outline"><h3>{grill.approvedOutline.title}</h3><p>{grill.approvedOutline.premise}</p><ol>{grill.approvedOutline.sections.map(section => <li key={section.id}><span>{section.title}</span><small>{section.targetChars.toLocaleString()} 字 · {section.purpose}</small></li>)}</ol></div> : <p>大纲确认记录已保存。</p>}{!activeState.outlineBranchConfirmed ? <button className="btn primary" type="button" disabled={blocked || !snapshot?.branchHash || !grill?.outlineHash || Boolean(branchGraph?.diagnostics.some(item => item.severity === 'error'))} onClick={() => void confirmPlan()}>确认并进入生成</button> : <button className="btn" type="button" onClick={() => setView(currentView)}>继续当前阶段</button>}</div>}
            <div className="studio-card studio-branch-card"><StudioBranchExplorer graph={branchGraph} loading={graphLoading} error={graphError} onRefresh={() => void loadGraph()} /></div>
          </div>}
          {view === 'generate' && <div className="studio-card"><h2>{activeState.generatedFile && production?.status === 'agent_applied' ? '剧本已写入项目' : '让故事成为剧本'}</h2><p>{activeState.outlineBranchConfirmed ? '使用当前写作模型，按已确认的大纲和素材生成 Ren\'Py 剧本。写入完成后，进入检查与试玩。' : '先确认人物素材、大纲和分支，生成时才有可靠的创作依据。'}</p>{production ? <p className={`production-status ${production.status}`}>{production.message}</p> : null}{activeState.generatedFile && production?.status === 'agent_applied' ? <button className="btn primary" type="button" onClick={() => setView('verify')}>检查与试玩</button> : activeState.outlineBranchConfirmed ? <button className="btn primary" type="button" disabled={blocked} onClick={() => void generate()}>{production?.status === 'skeleton_handoff' || production?.status === 'agent_failed' ? '使用当前模型继续生成' : '开始生成剧本'}</button> : <button className="btn" type="button" onClick={() => setView(activeState.assetsReady ? 'story' : 'prepare')}>继续准备</button>}</div>}
          {view === 'verify' && <div className="studio-card studio-verification">
            <div className="studio-verification-heading"><span className={`studio-verification-icon ${stage === 'done' ? 'ok' : ''}`}><Icon name={stage === 'done' ? 'check' : 'game'} size={28} /></span><div><h2>{stage === 'done' ? canPlay ? '故事准备好了，亲自走一遍。' : '剧本检查通过，等待接入主线' : activeState.generatedFile ? '检查剧本，再进入故事' : '生成后，就能在这里试玩'}</h2><p>{canPlay ? '启动真正的 Ren\'Py 游戏，看看每一次选择如何发生。' : activeState.generatedFile ? '使用 Ren\'Py Lint 检查语法和素材引用，修复后再启动。' : '先完成剧情与生成。这里会保留检查结果和修复记录。'}</p></div></div>
            {activeState.lint ? <div className={`lint-proof ${activeState.lint.ok && activeState.lint.verified ? 'ok' : 'bad'}`}><strong>{activeState.lint.ok && activeState.lint.verified ? 'Ren\'Py Lint 已通过' : 'Ren\'Py Lint 未通过'}</strong><span>{activeState.lint.errorCount} 个错误 · {activeState.lint.warningCount} 个警告</span></div> : null}
            {production?.integration === 'required' ? <div className="studio-integration"><h3>把生成剧情接到你的入口</h3><p>已写入 <code>{production.entryFile || activeState.generatedFile}</code>。在项目自己的 <code>start</code> 或其他主线位置调用：</p><code>call {production.entryLabel}</code><p>接好后重新检查，再开始试玩。</p></div> : null}
            {playtest?.message || playtest?.status === 'running' ? <p className="studio-playtest-status" role="status">{playtest.status === 'running' ? '游戏正在运行。' : ''}{playtest.message}</p> : null}
            <div className="studio-actions">{playtest?.status === 'running' && !canPlayOriginal ? <button className="btn primary" type="button" disabled={busy} onClick={() => void play(true)}><Icon name="stop" size={17} />停止试玩</button> : canPlay ? <button className="btn primary studio-playtest-primary" type="button" disabled={blocked} onClick={() => void play()}><Icon name="game" size={18} />开始试玩</button> : null}{activeState.generatedFile ? <><button className={`btn ${canPlay ? '' : 'primary'}`} type="button" disabled={blocked || playtest?.status === 'running'} onClick={() => void lint()}>{activeState.lint ? '重新检查' : '运行 Ren\'Py 检查'}</button>{stage === 'lint/repair' ? <button className="btn" type="button" disabled={blocked} onClick={() => void repair()}>生成修复提案</button> : null}<button className="btn" type="button" onClick={() => setView('story')}>查看剧情分支</button></> : <button className="btn" type="button" onClick={() => setView(currentView)}>继续当前阶段</button>}</div>
            {repairProposals.length ? <div className="repair-proposals">{repairProposals.map((proposal, index) => <details key={`${proposal.file}:${index}`} open><summary>修复提案 {index + 1} · {proposal.file}</summary><pre>{proposal.diff}</pre><button className="btn primary" type="button" disabled={blocked} onClick={() => void applyRepair(proposal)}>应用并重新检查</button></details>)}</div> : null}
            {activeState.lint ? <details className="studio-diagnostics" open={!activeState.lint.ok || !activeState.lint.verified}><summary>查看 Lint 诊断</summary><pre className="lint-output">{activeState.lint.output || 'SDK 未返回诊断文本'}</pre></details> : null}
          </div>}
        </>
      ) : null}
    </section>
  )
}
