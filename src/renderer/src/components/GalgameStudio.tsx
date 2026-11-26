import { useEffect, useState } from 'react'
import GrillMeWorkbench from './GrillMeWorkbench'
import SelectControl from './SelectControl'
import Icon from './Icon'
import type { GrillMeState } from '../../../shared/grillMe'
import { RENPY_SDK_VERSION } from '../../../shared/galgameStudio'
import type { GalgameAssetManifest, GalgameStudioSnapshot, GalgameStudioState } from '../../../shared/galgameStudio'
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

interface BranchGraphView {
  labels: Array<{ name: string }>
  edges: Array<{ from: string; to: string; type: string }>
  diagnostics: Array<{ severity: string; message: string }>
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
  galgameStudioOpenProject: (studioId: string) => Promise<boolean>
  galgameStudioSdkCheck: (studioId: string) => Promise<{ status: string; message?: string; candidate?: { evidence?: { root?: string; version?: string } } | null }>
  galgameStudioSdkChoose: (studioId: string) => Promise<{ status: string; message?: string; candidate?: { evidence?: { root?: string; version?: string } } | null }>
  galgameStudioSdkDownload: (studioId: string) => Promise<unknown>
  galgameStudioSdkCancel: (studioId: string) => void
  galgameStudioSetAssets: (studioId: string, manifest: GalgameAssetManifest) => Promise<{ ok: boolean; issues?: Array<{ message: string }> }>
  grillStart: (input: { sessionId: string; originalTask: string; targetChars: number; genre?: string; kind?: string }) => Promise<GrillMeState>
  grillGet: (sessionId: string) => Promise<GrillMeState | null>
  renpyBranchGraph: (projectDir: string) => Promise<{ labels: Array<{ name: string }>; edges: Array<{ from: string; to: string; type: string }>; diagnostics: Array<{ severity: string; message: string }> }>
  galgameStudioConfirmPlan: (input: { studioId: string; branchHash: string; outlineHash?: string }) => Promise<GalgameStudioState>
  galgameStudioGenerate: (studioId: string) => Promise<{ ok: boolean; generatedFile?: string; error?: string }>
  galgameStudioLint: (studioId: string) => Promise<{ ok: boolean; verified: boolean; output: string; errorCount: number; warningCount: number; command: string }>
  galgameStudioRepair: (input: { studioId: string; maxRepairs?: number }) => Promise<{ ok: boolean; repairRounds: number; proposals: unknown[]; lintAfterApply?: unknown }>
  renpyApplyPatch: (input: { projectDir: string; patch: unknown }) => Promise<{ ok: boolean; diff: string | null; file: string; error?: string }>
  onGalgameStudioProgress: (cb: (data: { studioId: string; progress: { phase: string; percent?: number | null; message: string } }) => void) => () => void
}

const api = (): StudioApi | null => (window as unknown as { ds?: StudioApi }).ds ?? null
const STAGES = ['sdk_ready', 'assets_ready', 'grill', 'outline/branch_confirmed', 'generate', 'lint/repair', 'done'] as const
const stageLabels: Record<GalgameStudioState['stage'], string> = {
  sdk_ready: 'SDK',
  assets_ready: '素材',
  grill: '梳理剧情',
  'outline/branch_confirmed': '大纲与分支',
  generate: '制作',
  'lint/repair': '检查剧本',
  done: '完成'
}
const VISIBLE_STEPS = [
  { id: 'project', label: '项目' },
  ...STAGES.map((id) => ({ id, label: stageLabels[id] }))
] as const

const emptyManifest = (): GalgameAssetManifest => ({ schemaVersion: 1, characters: [{ id: 'protagonist', name: '', setting: '' }], sprites: [], backgrounds: [], audio: [] })

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function sdkName(version?: string): string {
  return version ? "Ren'Py " + version : "Ren'Py SDK"
}

export default function GalgameStudio({ sessionId, onClose }: Props): React.ReactNode {
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
  const [branchGraph, setBranchGraph] = useState<BranchGraphView | null>(null)
  const [repairProposals, setRepairProposals] = useState<RepairProposalView[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const ds = api()

  const refresh = async (studioId = state?.studioId): Promise<void> => {
    if (!studioId || !ds) return
    try {
      const next = await ds.galgameStudioGet(studioId)
      setSnapshot(next)
      setState(next.state)
      if (next.state.sdkReady) setSdkMessage(sdkName(next.state.sdk?.version))
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取工作台状态失败')
    }
  }

  useEffect(() => {
    if (!ds) return undefined
    return ds.onGalgameStudioProgress((event) => {
      if (event.studioId === state?.studioId) setSdkProgress(event.progress)
    })
  }, [ds, state?.studioId])

  useEffect(() => {
    if (!ds) return
    let live = true
    setState(null)
    setSnapshot(null)
    setSdkMessage('尚未选择 SDK')
    setSdkProgress(null)
    setGrill(null)
    void ds.galgameStudioLatest(sessionId).then((latest) => {
      if (!live || !latest) return
      setState(latest.state)
      setSnapshot(latest)
      if (latest.state.assets) setManifest(latest.state.assets)
      if (latest.state.sdkReady) setSdkMessage(sdkName(latest.state.sdk?.version))
    }).catch(() => undefined)
    return () => { live = false }
  }, [ds, sessionId])

  useEffect(() => {
    if (!state?.studioId || !ds) return
    void refresh(state.studioId)
    void ds.grillGet(sessionId).then((next) => { if (next) setGrill(next) }).catch(() => undefined)
  }, [state?.studioId, sessionId])

  useEffect(() => {
    if (!state?.projectDir || !ds) { setBranchGraph(null); return }
    let live = true
    void ds.renpyBranchGraph(state.projectDir)
      .then((next) => { if (live) setBranchGraph(next) })
      .catch(() => { if (live) setBranchGraph(null) })
    return () => { live = false }
  }, [ds, state?.projectDir, state?.updatedAt])

  const stage = state?.stage ?? 'sdk_ready'
  const isProjectReady = Boolean(state)
  const assetIssues = snapshot?.assetCheck?.issues ?? []
  const canSetAssets = stage === 'assets_ready' || stage === 'sdk_ready'
  const hasConfirmedGrill = Boolean(state?.grillConfirmed || grill?.status === 'confirmed')
  const selectedFileCount = manifest.sprites.length + manifest.backgrounds.length + manifest.audio.length
  const activeState = state as GalgameStudioState


  const chooseParent = async (): Promise<void> => {
    if (!ds) return
    const picked = await ds.chooseDir(sessionId)
    if (picked) setParentDir(picked.path)
  }

  const chooseImport = async (): Promise<void> => {
    if (!ds) return
    const picked = await ds.chooseDir(sessionId)
    if (picked) setImportDir(picked.path)
  }

  const createProject = async (): Promise<void> => {
    if (!ds || !parentDir || !projectName.trim()) return
    setBusy(true); setError(''); setNotice('')
    try {
      const created = await ds.galgameStudioCreate({ sessionId, parentDir, name: projectName })
      setState(created); setNotice(`已创建项目：${created.projectDir}`); await refresh(created.studioId)
    } catch (e) { setError(e instanceof Error ? e.message : '创建项目失败') } finally { setBusy(false) }
  }

  const importProject = async (): Promise<void> => {
    if (!ds || !importDir) return
    setBusy(true); setError(''); setNotice('')
    try {
      const imported = await ds.galgameStudioImport({ sessionId, projectDir: importDir })
      setState(imported); setNotice(`已导入项目：${imported.projectDir}`); await refresh(imported.studioId)
    } catch (e) { setError(e instanceof Error ? e.message : '导入项目失败') } finally { setBusy(false) }
  }

  const checkSdk = async (): Promise<void> => {
    if (!ds || !state) return
    setBusy(true); setError('')
    try {
      const result = await ds.galgameStudioSdkCheck(state.studioId)
      setSdkMessage(result.message ?? (result.status === 'ready' ? sdkName(result.candidate?.evidence?.version) : '未找到可用 SDK'))
      await refresh(state.studioId)
    } catch (e) { setError(e instanceof Error ? e.message : 'SDK 检查失败') } finally { setBusy(false) }
  }

  const chooseSdk = async (): Promise<void> => {
    if (!ds || !state) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await ds.galgameStudioSdkChoose(state.studioId)
      if (result.status === 'cancelled') return
      setSdkMessage(result.message ?? (result.status === 'ready' ? sdkName(result.candidate?.evidence?.version) : '选择的 SDK 不可用'))
      if (result.status !== 'ready') setError(result.message ?? "请选择解压后的 Ren'Py SDK 目录。")
      await refresh(state.studioId)
    } catch (e) { setError(e instanceof Error ? e.message : '导入 SDK 失败') } finally { setBusy(false) }
  }

  const downloadSdk = async (): Promise<void> => {
    if (!ds || !state) return
    setSdkDownloading(true); setError(''); setSdkProgress({ percent: 0, message: '准备下载官方 SDK…' })
    try { await ds.galgameStudioSdkDownload(state.studioId); setSdkMessage('官方 SDK 已安装并验证'); await refresh(state.studioId) }
    catch (e) { setError(e instanceof Error ? e.message : 'SDK 下载失败') }
    finally { setSdkDownloading(false) }
  }

  const chooseAssetFiles = async (kind: 'sprite' | 'background' | 'audio'): Promise<void> => {
    if (!ds || !state) return
    try {
      const files = await ds.openFiles(sessionId)
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
    } catch (e) { setError(e instanceof Error ? e.message : '选择素材失败') }
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
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await ds.galgameStudioSetAssets(state.studioId, manifest)
      if (!result.ok) setError(result.issues?.map((issue) => issue.message).join('；') || '素材清单未通过校验')
      else { setNotice(`素材清单已锁定（${selectedFileCount} 个文件）；现在进入 Grill Me。`); await refresh(state.studioId) }
    } catch (e) { setError(e instanceof Error ? e.message : '素材校验失败') } finally { setBusy(false) }
  }

  const startGrill = async (): Promise<void> => {
    if (!ds || !state || !task.trim()) return
    setBusy(true); setError('')
    try { const next = await ds.grillStart({ sessionId, originalTask: task, targetChars, genre: 'Galgame', kind: 'Galgame 剧本' }); setGrill(next) }
    catch (e) { setError(e instanceof Error ? e.message : '启动 Grill Me 失败') } finally { setBusy(false) }
  }

  const openPlanConfirmation = async (confirmed: GrillMeState): Promise<void> => {
    setGrill(confirmed)
    await refresh(state?.studioId)
  }

  const confirmPlan = async (): Promise<void> => {
    if (!ds || !state || !snapshot?.branchHash || !grill?.outlineHash) return
    setBusy(true); setError('')
    try { await ds.galgameStudioConfirmPlan({ studioId: state.studioId, branchHash: snapshot.branchHash, outlineHash: grill.outlineHash }); setNotice('大纲与分支图已确认；可以开始制作。'); await refresh(state.studioId) }
    catch (e) { setError(e instanceof Error ? e.message : '确认大纲与分支图失败') } finally { setBusy(false) }
  }

  const generate = async (): Promise<void> => {
    if (!ds || !state) return
    setBusy(true); setError('')
    try { const result = await ds.galgameStudioGenerate(state.studioId); if (!result.ok) setError(result.error ?? '生成失败'); else { setNotice(`已生成真实剧本：${result.generatedFile ?? 'game/deepwriter_generated.rpy'}`); await refresh(state.studioId) } }
    catch (e) { setError(e instanceof Error ? e.message : '生成失败；前置确认可能已变化') } finally { setBusy(false) }
  }

  const lint = async (): Promise<void> => {
    if (!ds || !state) return
    setBusy(true); setError('')
    try { const result = await ds.galgameStudioLint(state.studioId); if (result.ok && result.verified) setNotice(`脚本检查通过（警告 ${result.warningCount} 个）`); else setError(`lint 未通过：${result.errorCount} 个错误`); await refresh(state.studioId) }
    catch (e) { setError(e instanceof Error ? e.message : 'lint 执行失败') } finally { setBusy(false) }
  }

  const repair = async (): Promise<void> => {
    if (!ds || !state) return
    setBusy(true); setError('')
    try {
      const result = await ds.galgameStudioRepair({ studioId: state.studioId, maxRepairs: 2 })
      const proposals = result.proposals.filter((item): item is RepairProposalView => Boolean(item && typeof item === 'object' && 'patch' in item && 'diff' in item))
      setRepairProposals(proposals)
      setNotice(proposals.length > 0 ? `已生成 ${proposals.length} 份修复提案；确认差异后再写入。` : result.ok ? '当前项目不需要修复。' : `没有生成可用修复提案（已尝试 ${result.repairRounds} 轮）`)
      await refresh(state.studioId)
    }
    catch (e) { setError(e instanceof Error ? e.message : '修复循环失败') } finally { setBusy(false) }
  }

  const applyRepair = async (proposal: RepairProposalView): Promise<void> => {
    if (!ds || !state) return
    setBusy(true); setError(''); setNotice('')
    try {
      const applied = await ds.renpyApplyPatch({ projectDir: state.projectDir, patch: proposal.patch })
      if (!applied.ok) throw new Error(applied.error ?? '修复补丁未能安全写入')
      setRepairProposals((current) => current.filter((item) => item !== proposal))
      const checked = await ds.galgameStudioLint(state.studioId)
      setNotice(checked.ok && checked.verified ? '修复已应用，脚本检查通过。' : `修复已应用，仍有 ${checked.errorCount} 个错误。`)
      await refresh(state.studioId)
    } catch (e) { setError(e instanceof Error ? e.message : '应用修复失败') } finally { setBusy(false) }
  }

  const openProject = async (): Promise<void> => {
    if (!ds || !state) return
    try {
      const opened = await ds.galgameStudioOpenProject(state.studioId)
      if (!opened) setError('无法打开项目目录')
    } catch (e) { setError(e instanceof Error ? e.message : '无法打开项目目录') }
  }

  return (
    <section className="galgame-studio" aria-label="Galgame Studio" data-stage={stage}>
      <header className="galgame-studio-head">
        <h1>Galgame 制作</h1>
        {onClose ? <button className="studio-close" type="button" onClick={onClose}>关闭</button> : null}
      </header>
      <div className="studio-progress" role="status" aria-label="制作进度">
        {VISIBLE_STEPS.map((item, index) => {
          const activeIndex = state ? STAGES.indexOf(stage) + 1 : 0
          return <span key={item.id} className={index < activeIndex ? 'done' : index === activeIndex ? 'current' : ''}><i>{index < activeIndex ? '✓' : index + 1}</i><b>{item.label}</b></span>
        })}
      </div>
      {error ? <p className="studio-alert error" role="alert">{error}</p> : null}
      {notice ? <p className="studio-alert" role="status">{notice}</p> : null}

      {!isProjectReady ? (
        <div className="studio-card studio-project-entry">
          <div><span className="card-kicker">第一步</span><h2>创建或导入项目</h2><p>先选择项目位置；后续步骤会逐项出现。</p></div>
          <div className="entry-grid">
            <div className="entry-box"><h3>创建新项目</h3><label>父目录<input readOnly value={parentDir} placeholder="请选择目录" /></label><button className="btn" type="button" onClick={() => void chooseParent()}>选择父目录</button><label>项目名<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><button className="btn primary" type="button" disabled={busy || !parentDir} onClick={() => void createProject()}>创建 Ren'Py 项目</button></div>
            <div className="entry-box"><h3>导入现有项目</h3><label>项目目录<input readOnly value={importDir} placeholder="请选择含 game/ 的目录" /></label><button className="btn" type="button" onClick={() => void chooseImport()}>选择项目目录</button><button className="btn primary" type="button" disabled={busy || !importDir} onClick={() => void importProject()}>导入项目</button></div>
          </div>
        </div>
      ) : (
        <>
          <div className="studio-project-strip"><span><b title={activeState.projectDir}>{activeState.projectName}</b></span><div>{activeState.sdkReady && activeState.sdk && <button type="button" className="text-btn studio-sdk-choice" disabled={busy || sdkDownloading} onClick={() => void chooseSdk()} title={'更换 SDK：' + activeState.sdk.root} aria-label={'更换 SDK，当前为 ' + sdkName(activeState.sdk.version)}>{sdkName(activeState.sdk.version)} <Icon name="chevronDown" size={14} /></button>}<button className="text-btn" type="button" title={activeState.projectDir} onClick={() => void openProject()}>打开目录</button></div></div>
          {(stage === 'sdk_ready' || !activeState.sdkReady) && <div className="studio-card">
            <h2>选择 Ren'Py SDK</h2>
            {(sdkMessage !== '尚未选择 SDK' || sdkDownloading) && <div className="sdk-status" role="status">
              <strong>{sdkMessage}</strong>
              {sdkProgress && sdkDownloading && <span>{sdkProgress.message}{sdkProgress.percent != null ? ' · ' + sdkProgress.percent + '%' : ''}</span>}
            </div>}
            <div className="studio-actions">
              <button className="btn primary" type="button" disabled={busy || sdkDownloading} onClick={() => void chooseSdk()}>选择 SDK 目录</button>
              <button className="btn" type="button" disabled={busy || sdkDownloading} onClick={() => void checkSdk()}>自动扫描</button>
              <button className="btn" type="button" disabled={busy || sdkDownloading} onClick={() => void downloadSdk()}>{sdkDownloading ? '下载中…' : '下载官方 SDK ' + RENPY_SDK_VERSION}</button>
              {sdkDownloading && <button className="btn" type="button" onClick={() => ds?.galgameStudioSdkCancel(activeState.studioId)}>取消下载</button>}
            </div>
          </div>}
          {activeState.sdkReady && canSetAssets && (
            <div className="studio-card">
              <h2>人物与素材</h2>
              <div className="character-editor">
                {manifest.characters.map((character, index) => (
                  <div className="character-row" key={character.id}>
                    <div className="character-row-head"><strong>角色 {index + 1}</strong>{manifest.characters.length > 1 ? <button type="button" className="text-btn" onClick={() => removeCharacter(character.id)}>移除</button> : null}</div>
                    <label>角色名<input required value={character.name} onChange={(event) => setManifest((current) => ({ ...current, characters: current.characters.map((item, i) => i === index ? { ...item, name: event.target.value } : item) }))} placeholder="例如：夏澄" /></label>
                    <label>人物设定<textarea required value={character.setting} onChange={(event) => setManifest((current) => ({ ...current, characters: current.characters.map((item, i) => i === index ? { ...item, setting: event.target.value } : item) }))} placeholder="性格、目标、关系与不可违背的边界" rows={3} /></label>
                  </div>
                ))}
                <button className="btn" type="button" onClick={addCharacter}>添加角色</button>
              </div>
              <div className="asset-picker-grid">
                <button className="asset-picker" type="button" onClick={() => void chooseAssetFiles('sprite')}><b>立绘 / 表情</b><span>{manifest.sprites.length > 0 ? `已选 ${manifest.sprites.length} 个` : '选择图片'}</span></button>
                <button className="asset-picker" type="button" onClick={() => void chooseAssetFiles('background')}><b>背景图片</b><span>{manifest.backgrounds.length > 0 ? `已选 ${manifest.backgrounds.length} 个` : '选择图片'}</span></button>
                <button className="asset-picker" type="button" onClick={() => void chooseAssetFiles('audio')}><b>音乐 / 音效</b><span>{manifest.audio.length > 0 ? `已选 ${manifest.audio.length} 个` : '可选'}</span></button>
              </div>
              {manifest.sprites.length > 0 ? <div className="sprite-bindings">{manifest.sprites.map((sprite, index) => <div className="sprite-binding" key={sprite.id}><span title={sprite.displayName}>{sprite.displayName}</span><SelectControl compact ariaLabel={`为 ${sprite.displayName ?? `立绘 ${index + 1}`} 选择角色`} value={sprite.characterId} options={manifest.characters.map((character) => ({ value: character.id, label: character.name || `角色 ${manifest.characters.indexOf(character) + 1}` }))} onChange={(characterId) => setManifest((current) => ({ ...current, sprites: current.sprites.map((item) => item.id === sprite.id ? { ...item, characterId } : item) }))} /><input aria-label="表情名" value={sprite.expression} onChange={(event) => setManifest((current) => ({ ...current, sprites: current.sprites.map((item) => item.id === sprite.id ? { ...item, expression: event.target.value } : item) }))} /></div>)}</div> : null}
              <button className="btn primary" type="button" disabled={busy} onClick={() => void submitAssets()}>确认资料，进入 Grill Me</button>
              {assetIssues.length > 0 ? <ul className="studio-issues">{assetIssues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul> : null}
            </div>
          )}
          {activeState.assetsReady && (stage === 'grill' || grill) && !hasConfirmedGrill && <div className="studio-card"><div className="card-kicker">需求澄清</div><h2>Grill Me</h2>{!grill ? <><p>先说你想做什么；系统会逐个追问，确认大纲前不会开始制作。</p><textarea className="studio-task" value={task} onChange={(event) => setTask(event.target.value)} placeholder="描述故事、核心冲突和希望玩家获得的体验…" rows={4} /><div className="studio-actions"><label className="target-input">目标字数<input type="number" min={100} value={targetChars} onChange={(event) => setTargetChars(Math.max(100, Number(event.target.value) || 100))} /></label><button className="btn primary" type="button" disabled={busy || !task.trim()} onClick={() => void startGrill()}>开始提问</button></div></> : <GrillMeWorkbench state={grill} onChange={setGrill} onConfirmed={(next) => void openPlanConfirmation(next)} onCancel={() => setGrill(null)} />}</div>}
          {(hasConfirmedGrill && (stage === 'outline/branch_confirmed' || stage === 'grill')) ? <div className="studio-card"><div className="card-kicker">开工确认</div><h2>确认大纲与分支</h2><p>只展示已经确认的创作信息；项目文件变化后必须重新确认。</p>{grill?.approvedOutline ? <div className="studio-outline"><strong>{grill.approvedOutline.title}</strong><p>{grill.approvedOutline.premise}</p><ol>{grill.approvedOutline.sections.map((section) => <li key={section.id}><span>{section.title}</span><small>{section.targetChars.toLocaleString()} 字 · {section.purpose}</small></li>)}</ol></div> : null}<div className="studio-branch-summary"><span><b>{branchGraph?.labels.length ?? 0}</b><small>现有剧情节点</small></span><span><b>{branchGraph?.edges.length ?? 0}</b><small>分支连接</small></span><span><b>{branchGraph?.diagnostics.filter((item) => item.severity === 'error').length ?? 0}</b><small>结构错误</small></span></div>{branchGraph && branchGraph.edges.length > 0 ? <div className="studio-branch-flow" aria-label="现有分支图">{branchGraph.edges.slice(0, 12).map((edge, index) => <span key={`${edge.from}:${edge.to}:${index}`}><b>{edge.from}</b><i>→</i><b>{edge.to}</b></span>)}</div> : <p className="branch-note">新项目还没有现成分支；将按确认大纲创建第一套剧情节点。</p>}<button className="btn primary" type="button" disabled={busy || !snapshot?.branchHash || !grill?.outlineHash || (branchGraph?.diagnostics.some((item) => item.severity === 'error') ?? false)} onClick={() => void confirmPlan()}>确认并进入制作</button></div> : null}
          {activeState.outlineBranchConfirmed && stage === 'generate' && <div className="studio-card"><div className="card-kicker">剧本制作</div><h2>生成 Ren'Py 项目内容</h2><p>将已确认的素材复制到项目，并由左下角当前写作模型生成安全补丁。只有剧情真实写入后才能进入 lint。</p>{activeState.production && activeState.production.status !== 'agent_applied' ? <p className={`production-status ${activeState.production.status}`}>{activeState.production.message}</p> : null}<button className="btn primary" type="button" disabled={busy} onClick={() => void generate()}>{activeState.production?.status === 'skeleton_handoff' ? '使用当前模型继续制作' : '开始制作'}</button></div>}
          {activeState.generatedFile && (stage === 'lint/repair' || stage === 'done') && <div className="studio-card"><h2>{stage === 'done' ? '剧本检查通过' : '检查剧本'}</h2>{activeState.production ? <p className={`production-status ${activeState.production.status}`}>{activeState.production.message}</p> : null}{activeState.lint ? <div className={`lint-proof ${activeState.lint.ok && activeState.lint.verified ? 'ok' : 'bad'}`}><strong>{activeState.lint.ok && activeState.lint.verified ? '脚本检查通过' : '脚本检查未通过'}</strong><span>{activeState.lint.errorCount} 个错误 · {activeState.lint.warningCount} 个警告</span></div> : null}<div className="studio-actions"><button className="btn primary" type="button" disabled={busy} onClick={() => void lint()}>{stage === 'done' ? '重新检查' : '运行检查'}</button>{stage === 'lint/repair' ? <button className="btn" type="button" disabled={busy} onClick={() => void repair()}>生成修复提案</button> : null}<button className="btn" type="button" onClick={() => void openProject()}>打开项目目录</button></div>{repairProposals.length > 0 ? <div className="repair-proposals">{repairProposals.map((proposal, index) => <details key={`${proposal.file}:${index}`} open><summary>修复提案 {index + 1} · {proposal.file}</summary><pre>{proposal.diff}</pre><button className="btn primary" type="button" disabled={busy} onClick={() => void applyRepair(proposal)}>应用并重新检查</button></details>)}</div> : null}{activeState.lint && !activeState.lint.ok ? <pre className="lint-output">{activeState.lint.output || 'SDK 未返回诊断文本'}</pre> : null}</div>}
        </>
      )}
    </section>
  )
}
