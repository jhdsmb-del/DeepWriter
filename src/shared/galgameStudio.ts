/**
 * Galgame Studio contract.  The renderer only sends stable ids and user
 * decisions; the main process owns paths, SDK provenance and file writes.
 */

export const RENPY_SDK_VERSION = '8.5.3' as const
export const RENPY_SDK_DOWNLOAD_URL = 'https://www.renpy.org/dl/8.5.3/renpy-8.5.3-sdk.zip' as const
export const RENPY_SDK_DOWNLOAD_HOST = 'www.renpy.org' as const
export const RENPY_SDK_DOWNLOAD_PATH = '/dl/8.5.3/renpy-8.5.3-sdk.zip' as const
export const RENPY_SDK_SHA256 = 'ff57648f9c04f27e381c48af6d8e3ee3cdec296bed4d3831f47f09b0a71b505e' as const

export const RENPY_SDK_MANIFEST = Object.freeze({
  version: RENPY_SDK_VERSION,
  url: RENPY_SDK_DOWNLOAD_URL,
  host: RENPY_SDK_DOWNLOAD_HOST,
  pathname: RENPY_SDK_DOWNLOAD_PATH,
  sha256: RENPY_SDK_SHA256
})

export const GALGAME_STUDIO_STAGES = [
  'sdk_ready',
  'assets_ready',
  'grill',
  'outline/branch_confirmed',
  'generate',
  'lint/repair',
  'done'
] as const

export type GalgameStudioStage = (typeof GALGAME_STUDIO_STAGES)[number]
export type GalgameStudioProjectMode = 'create' | 'import'

/** Main-process-owned live process state; never restored from Studio JSON. */
export interface GalgameStudioPlaytestResult {
  status: 'running' | 'stopped' | 'failed'
  message?: string
}

export interface GalgameSdkEvidence {
  source: 'explicit' | 'managed' | 'discovered'
  root: string
  pythonPath: string
  renpyScriptPath: string
  version: string
  verifiedAt: number
  command: string
}

export interface GalgameCharacterAsset {
  id: string
  name: string
  setting: string
  personality?: string
  notes?: string
}

export interface GalgameSpriteAsset {
  id: string
  characterId: string
  expression: string
  fileRefId: string
  displayName?: string
}

export interface GalgameBackgroundAsset {
  id: string
  name: string
  fileRefId: string
  displayName?: string
}

export interface GalgameAudioAsset {
  id: string
  name: string
  kind: 'music' | 'sound'
  fileRefId: string
  displayName?: string
}

export interface GalgameAssetManifest {
  schemaVersion: 1
  characters: GalgameCharacterAsset[]
  sprites: GalgameSpriteAsset[]
  backgrounds: GalgameBackgroundAsset[]
  audio: GalgameAudioAsset[]
}

export type GalgameAssetKind = 'sprite' | 'background' | 'audio'

export interface GalgameAssetIssue {
  code:
  | 'manifest_invalid'
  | 'missing_characters'
  | 'missing_setting'
  | 'missing_sprites'
  | 'missing_backgrounds'
  | 'missing_file_ref'
  | 'duplicate_id'
  | 'duplicate_file_ref'
  | 'unknown_character'
  | 'unsupported_type'
  | 'ref_not_authorized'
  | 'file_missing'
  | 'file_changed'
  | 'too_many'
  message: string
  kind?: GalgameAssetKind | 'character'
  id?: string
}

export interface GalgameAssetCheck {
  ok: boolean
  issues: GalgameAssetIssue[]
  counts: { characters: number; sprites: number; backgrounds: number; audio: number }
}

export interface GalgameStudioState {
  schemaVersion: 1
  studioId: string
  sessionId: string
  projectId: string
  projectDir: string
  projectMode: GalgameStudioProjectMode
  projectName: string
  stage: GalgameStudioStage
  sdkReady: boolean
  sdk: GalgameSdkEvidence | null
  assetsReady: boolean
  assets: GalgameAssetManifest | null
  grillStateId: string | null
  grillConfirmed: boolean
  outlineHash: string | null
  branchHash: string | null
  outlineBranchConfirmed: boolean
  generatedFile: string | null
  generatedAt: number | null
  /** Exact launcher text owned by Studio, never a license to replace edits. */
  entrypointContent?: string
  /**
   * Candidate scaffolds stay outside the active project. Production evidence
   * records actual story publication; lint and mainline integration are
   * separate acceptance conditions.
   */
  production: GalgameProductionHandoff | null
  lint: GalgameStudioLintState | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export type GalgameProductionStatus = 'agent_applied' | 'skeleton_handoff' | 'agent_failed'

export interface GalgameProductionHandoff {
  status: GalgameProductionStatus
  message: string
  requestedAt: number
  completedAt: number | null
  entryLabel?: string
  entryFile?: string
  integration?: 'connected' | 'required'
  /** Frozen creation inputs used only to make repeat Generate idempotent. */
  outlineHash?: string
  assetsKey?: string
}

export interface GalgameStudioLintState {
  ok: boolean
  verified: boolean
  output: string
  errorCount: number
  warningCount: number
  command: string
  checkedAt: number
}

export interface GalgameStudioSnapshot {
  state: GalgameStudioState
  sdk: { status: 'missing' | 'invalid' | 'ready'; source?: 'explicit' | 'managed' | 'discovered'; version?: string; message?: string }
  assetCheck: GalgameAssetCheck | null
  branchHash: string | null
  branchGraph?: {
    labels: Array<{ name: string; file: string; line: number; incoming: string[]; outgoing: string[] }>
    edges: Array<{ from: string; to: string; type: 'jump' | 'call' | 'menu' | 'return'; file: string; line: number; choice?: string }>
    diagnostics: Array<{ severity: 'error' | 'warning'; code: string; message: string; file: string | null; line: number | null }>
  } | null
}

export interface GalgameStudioGateResult {
  ok: boolean
  stage: GalgameStudioStage
  error?: string
}

const stageIndex = (stage: GalgameStudioStage): number => GALGAME_STUDIO_STAGES.indexOf(stage)

export function createGalgameStudioState(input: {
  studioId: string
  sessionId: string
  projectId: string
  projectDir: string
  projectMode: GalgameStudioProjectMode
  projectName: string
  now?: number
}): GalgameStudioState {
  const now = input.now ?? Date.now()
  return {
    schemaVersion: 1,
    studioId: input.studioId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    projectDir: input.projectDir,
    projectMode: input.projectMode,
    projectName: input.projectName,
    stage: 'sdk_ready',
    sdkReady: false,
    sdk: null,
    assetsReady: false,
    assets: null,
    grillStateId: null,
    grillConfirmed: false,
    outlineHash: null,
    branchHash: null,
    outlineBranchConfirmed: false,
    generatedFile: null,
    generatedAt: null,
    production: null,
    lint: null,
    error: null,
    createdAt: now,
    updatedAt: now
  }
}

export function nextGalgameStudioStage(state: GalgameStudioState): GalgameStudioStage {
  if (!state.sdkReady) return 'sdk_ready'
  if (!state.assetsReady) return 'assets_ready'
  if (!state.grillConfirmed) return 'grill'
  if (!state.outlineBranchConfirmed) return 'outline/branch_confirmed'
  if (!state.generatedFile || state.production?.status !== 'agent_applied') return 'generate'
  if (!state.lint?.ok || !state.lint.verified || state.production.integration === 'required') return 'lint/repair'
  return 'done'
}

export function studioGate(state: GalgameStudioState, action: GalgameStudioStage | 'generate' | 'lint' | 'done'): GalgameStudioGateResult {
  const required: Record<string, (s: GalgameStudioState) => boolean> = {
    sdk_ready: (s) => s.sdkReady && s.sdk !== null,
    assets_ready: (s) => s.sdkReady && s.assetsReady && s.assets !== null,
    grill: (s) => s.sdkReady && s.assetsReady && s.grillConfirmed,
    'outline/branch_confirmed': (s) => s.sdkReady && s.assetsReady && s.grillConfirmed && s.outlineBranchConfirmed && Boolean(s.outlineHash) && Boolean(s.branchHash),
    generate: (s) => s.sdkReady && s.assetsReady && s.grillConfirmed && s.outlineBranchConfirmed && Boolean(s.outlineHash) && Boolean(s.branchHash),
    lint: (s) => Boolean(s.generatedFile) && s.production?.status === 'agent_applied' && s.stage === 'lint/repair',
    'lint/repair': (s) => Boolean(s.generatedFile) && s.production?.status === 'agent_applied',
    done: (s) => s.production?.integration !== 'required' && Boolean(s.generatedFile) && s.production?.status === 'agent_applied' && Boolean(s.lint?.ok) && s.lint?.verified === true
  }
  const check = required[action]
  if (!check) return { ok: false, stage: nextGalgameStudioStage(state), error: '未知工作台阶段' }
  if (check(state)) return { ok: true, stage: nextGalgameStudioStage(state) }
  const stage = nextGalgameStudioStage(state)
  return { ok: false, stage, error: `工作台尚未完成前置阶段：${stage}` }
}

export function assertStudioGenerationAllowed(state: GalgameStudioState): void {
  const result = studioGate(state, 'generate')
  if (!result.ok) throw new Error(result.error ?? '工作台尚未确认，禁止生成')
}

export function advanceGalgameStudio(state: GalgameStudioState, patch: Partial<GalgameStudioState>, now = Date.now()): GalgameStudioState {
  const next: GalgameStudioState = { ...state, ...patch, updatedAt: now }
  next.stage = nextGalgameStudioStage(next)
  return next
}

export function validateAssetManifest(manifest: unknown): GalgameAssetCheck {
  const issues: GalgameAssetIssue[] = []
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, issues: [{ code: 'manifest_invalid', message: '素材清单不是对象' }], counts: { characters: 0, sprites: 0, backgrounds: 0, audio: 0 } }
  }
  const raw = manifest as Partial<GalgameAssetManifest>
  const characters = Array.isArray(raw.characters) ? raw.characters : []
  const sprites = Array.isArray(raw.sprites) ? raw.sprites : []
  const backgrounds = Array.isArray(raw.backgrounds) ? raw.backgrounds : []
  const audio = Array.isArray(raw.audio) ? raw.audio : []
  if (raw.schemaVersion !== 1) issues.push({ code: 'manifest_invalid', message: '素材清单版本不受支持' })
  if (characters.length === 0) issues.push({ code: 'missing_characters', message: '至少需要一名角色及人物设定', kind: 'character' })
  if (sprites.length === 0) issues.push({ code: 'missing_sprites', message: '至少需要一张立绘或表情图', kind: 'sprite' })
  if (backgrounds.length === 0) issues.push({ code: 'missing_backgrounds', message: '至少需要一张背景图', kind: 'background' })
  const ids = new Set<string>()
  const refs = new Set<string>()
  const addId = (value: unknown, kind: GalgameAssetIssue['kind']): string => {
    const id = typeof value === 'string' ? value.trim() : ''
    if (!id) {
      issues.push({ code: 'manifest_invalid', message: `${String(kind)} 素材缺少 id`, kind })
      return ''
    }
    if (ids.has(id)) issues.push({ code: 'duplicate_id', message: `素材 id 重复：${id}`, kind, id })
    ids.add(id)
    return id
  }
  for (const item of characters) {
    if (!item || typeof item !== 'object') {
      issues.push({ code: 'manifest_invalid', message: '角色条目格式错误', kind: 'character' })
      continue
    }
    const c = item as GalgameCharacterAsset
    const id = addId(c.id, 'character')
    if (!String(c.name ?? '').trim()) issues.push({ code: 'manifest_invalid', message: `角色 ${id || '未命名'} 缺少名称`, kind: 'character', id })
    if (!String(c.setting ?? '').trim()) issues.push({ code: 'missing_setting', message: `角色 ${id || '未命名'} 缺少人物设定`, kind: 'character', id })
  }
  const characterIds = new Set(characters.filter((x): x is GalgameCharacterAsset => Boolean(x && typeof x === 'object')).map((x) => String(x.id ?? '').trim()))
  const checkFileItem = (item: unknown, kind: GalgameAssetKind): void => {
    if (!item || typeof item !== 'object') {
      issues.push({ code: 'manifest_invalid', message: `${kind} 条目格式错误`, kind })
      return
    }
    const v = item as Partial<GalgameSpriteAsset & GalgameBackgroundAsset & GalgameAudioAsset>
    const id = addId(v.id, kind)
    const ref = typeof v.fileRefId === 'string' ? v.fileRefId.trim() : ''
    if (!ref) issues.push({ code: 'missing_file_ref', message: `${kind} ${id || '未命名'} 未选择文件`, kind, id })
    else if (refs.has(ref)) issues.push({ code: 'duplicate_file_ref', message: `同一文件被重复用于素材：${ref}`, kind, id })
    else refs.add(ref)
    if (kind === 'sprite') {
      const characterId = String((v as GalgameSpriteAsset).characterId ?? '').trim()
      if (!characterIds.has(characterId)) issues.push({ code: 'unknown_character', message: `立绘 ${id || '未命名'} 关联了不存在的角色：${characterId}`, kind, id })
      if (!String((v as GalgameSpriteAsset).expression ?? '').trim()) issues.push({ code: 'manifest_invalid', message: `立绘 ${id || '未命名'} 缺少表情名`, kind, id })
    }
    if (kind !== 'sprite' && !String((v as GalgameBackgroundAsset).name ?? '').trim()) issues.push({ code: 'manifest_invalid', message: `${kind} ${id || '未命名'} 缺少名称`, kind, id })
  }
  sprites.forEach((x) => checkFileItem(x, 'sprite'))
  backgrounds.forEach((x) => checkFileItem(x, 'background'))
  audio.forEach((x) => checkFileItem(x, 'audio'))
  if (sprites.length > 200 || backgrounds.length > 200 || audio.length > 100 || characters.length > 100) issues.push({ code: 'too_many', message: '素材数量超过工作台上限' })
  return { ok: issues.length === 0, issues, counts: { characters: characters.length, sprites: sprites.length, backgrounds: backgrounds.length, audio: audio.length } }
}

export function sdkManifestIsOfficial(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object') return false
  const value = manifest as Record<string, unknown>
  return value.version === RENPY_SDK_MANIFEST.version && value.url === RENPY_SDK_MANIFEST.url && value.host === RENPY_SDK_MANIFEST.host && value.pathname === RENPY_SDK_MANIFEST.pathname && value.sha256 === RENPY_SDK_MANIFEST.sha256
}
