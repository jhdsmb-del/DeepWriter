import type { UndoFileEditInput, UndoFileEditResult } from '../shared/editUndo'
import type { PermissionRequestView, PermissionAnswer } from '../shared/permissionRequest'
import type { ChatFileAnchor, ChatFileView, ChatFileAction, ChatFileActionResult } from '../shared/chatFiles'
import type { AttachmentPreviewResult } from '../shared/attachmentPreview'
import type { AgentPlanApproval } from '../shared/agentPlanPolicy'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ComposerDraftWrite, ComposerDraftWriteResult, PersistedComposerDraft } from '../shared/composerDraft'
import type { ActivityEvent, RunSnapshot } from '../shared/activity'
import type { RunBillingView } from '../shared/billing'
import type { AttachmentRef, ChunkEvent, DsMessage, Settings, StoryConfig, StrongConstraintInput, SessionMeta, SessionMessageSnapshot, PermissionSettings, MemoryInfo, RenpyProjectInfo, RenpyLintResult, NarrativeSemanticReviewDecisionInput, NarrativeSemanticReviewPacket, NarrativeSemanticReviewDecisionResult, NarrativeLedgerScopeInput } from '../shared/types'
import type { BranchGraph, GeneratePatchResult, ApplyPatchResult, RepairLoopResult } from '../main/galgame'
import type { FileRefView } from '../main/fileRef'
import type { DeepWriterProviderBundleV1, IpcResult, ImportPreview, ModelRecord, ModelConnectionResult, ProbeResult, ProfileRecord, ProviderRecord, ProviderRegistrySnapshot, StageProfileBindings, CredentialRefView, DiscoveryPreview, EffectiveProfile, PricingRecord, UserPricingInput } from '../shared/providerRegistry'
import type { ContextManifestV2, ContextMode, ContextPinView, ContextPreferenceView, ContextPreviewV1, ContextSourceSnippetView, RollingSummaryV1 } from '../shared/contextV2'
import type { GrillMeState, GrillMeOutline, GrillMeAttachmentStatus } from '../shared/grillMe'
import type { GalgameAssetManifest, GalgameSdkEvidence, GalgameStudioSnapshot, GalgameStudioState } from '../shared/galgameStudio'
import type { LongformWorkflowCreateInput, LongformWorkflowDraft, LongformWorkflowPublicMutationInput, LongformWorkflowSnapshot } from '../shared/longformWorkflow'
import type { ExtensionSelection, ExtensionsSnapshot, ExtensionView } from '../shared/extensions'
import type { DesktopChatStartResult, DesktopCostDecision } from '../shared/ipcSchemas'
import type { ProviderSetupInput, ProviderSetupUpdateInput } from '../shared/providerSetup'

export interface ChatPayload {
  id: string
  sessionId?: string
  phase?: 'plan' | 'execute'
  planText?: string
  planAccess?: 'read_only'
  planApproval?: AgentPlanApproval
  fixedPrefix: DsMessage[]
  history: DsMessage[]
  story: StoryConfig | null
  longMode: boolean
  targetChars: number
  mode?: 'agent' | 'longwrite' | 'style' | 'galgame'
  workspace?: string
  strongConstraints?: StrongConstraintInput
  attachments?: AttachmentRef[]
  contextSelection?: { mode: ContextMode; preferenceRevision: number; previewId: string }
  storyScope?: NarrativeLedgerScopeInput
  grillMe?: { stateId: string; originalTask: string; targetChars: number; answers: Array<{ slotId: string; value: string; source: string }>; assumptions: string[]; approvedOutline: GrillMeOutline; outlineRevision: number; outlineHash: string; quickBypass?: boolean }
  quickBypass?: boolean
  unknownCostConsent?: DesktopCostDecision
}

const api = {
  extensionsSnapshot: (): Promise<IpcResult<ExtensionsSnapshot>> => ipcRenderer.invoke('extensions:snapshot', {}),
  extensionsInstallCatalog: (id: string): Promise<IpcResult<ExtensionView>> => ipcRenderer.invoke('extensions:installCatalog', { id }),
  extensionsImportSkill: (): Promise<IpcResult<ExtensionView | null>> => ipcRenderer.invoke('extensions:importSkill', {}),
  extensionsSetEnabled: (id: string, enabled: boolean): Promise<IpcResult<ExtensionView>> => ipcRenderer.invoke('extensions:setEnabled', { id, enabled }),
  extensionsRemove: (id: string): Promise<IpcResult<void>> => ipcRenderer.invoke('extensions:remove', { id }),
  extensionsInspect: (id: string): Promise<IpcResult<ExtensionView>> => ipcRenderer.invoke('extensions:inspect', { id }),
  extensionsSetSelection: (selection: ExtensionSelection): Promise<IpcResult<ExtensionSelection>> => ipcRenderer.invoke('extensions:setSelection', selection),
  getSettings: (): Promise<Settings & { apiKeyStorage: 'safeStorage' | 'memory' | 'plain' | 'none' }> => ipcRenderer.invoke('settings:get'),
  /** 整份保存（仅 SettingsModal 提交时使用；kind='whole'）。目录字段允许 {value, dirRefId}。 */
  setSettings: (s: Settings & { workDir?: string | { value: string; dirRefId: string }; docDir?: string | { value: string; dirRefId: string }; galgame?: { projectDir?: string | { value: string; dirRefId: string }; sdkPath?: string | { value: string; dirRefId: string } } }): Promise<boolean> =>
    ipcRenderer.invoke('settings:set', { kind: 'whole', settings: s }),
  /** 单字段保存（kind='patch'） */
  setSettingField: (key: string, value: unknown): Promise<boolean> => ipcRenderer.invoke('settings:set', { kind: 'patch', key, value }),
  listModels: (): Promise<{ id: string; name: string; desc: string; cacheHit: number; cacheMiss: number; out: number }[]> =>
    ipcRenderer.invoke('models:list'),
  providerSnapshot: (): Promise<IpcResult<ProviderRegistrySnapshot>> => ipcRenderer.invoke('provider:snapshot'),
  providerCreateSetup: (input: ProviderSetupInput): Promise<IpcResult<ProviderRecord>> => ipcRenderer.invoke('provider:createSetup', input),
  providerPricingUpsert: (input: UserPricingInput): Promise<IpcResult<PricingRecord>> => ipcRenderer.invoke('provider:pricing:upsert', input),
  providerPricingList: (modelId: string): Promise<IpcResult<PricingRecord[]>> => ipcRenderer.invoke('provider:pricing:list', { modelId }),
  providerCreateCustom: (input: { displayName: string; baseUrl: string; chatPath: string; modelsPath: string | null; authStyle: 'bearer' | 'none'; transportPolicy: { scope: 'public_https' | 'loopback_http'; allowNonDefaultPort: boolean; protocol?: 'deepseek-chat' | 'openai-chat' | 'openai-responses' | 'anthropic-messages'; authHeaderName?: string; extraHeaders?: Record<string, string> } }): Promise<IpcResult<ProviderRecord>> => ipcRenderer.invoke('provider:createCustom', input),
  providerCheckConnection: (providerId: string, credentialRefId?: string | null): Promise<IpcResult<{ status: string; modelCount: number | null }>> => ipcRenderer.invoke('provider:checkConnection', { providerId, credentialRefId }),
  credentialCreate: (providerId: string, label: string, secret: string): Promise<IpcResult<CredentialRefView>> => ipcRenderer.invoke('credential:create', { providerId, label, secret }),
  credentialReplace: (credentialRefId: string, secret: string): Promise<IpcResult<CredentialRefView>> => ipcRenderer.invoke('credential:replace', { credentialRefId, secret }),
  credentialDelete: (credentialRefId: string): Promise<IpcResult<void>> => ipcRenderer.invoke('credential:delete', { credentialRefId }),
  credentialSetDefault: (providerId: string, credentialRefId: string): Promise<IpcResult<void>> => ipcRenderer.invoke('credential:setDefault', { providerId, credentialRefId }),
  modelAddManual: (input: { providerId: string; remoteModelId: string; displayName: string; contextWindow?: number | null; maxOutputTokens?: number | null; declarations?: { streaming?: 'supported' | 'unsupported' | 'unknown'; toolUse?: 'supported' | 'unsupported' | 'unknown'; reasoning?: 'supported' | 'unsupported' | 'unknown'; reasoningModes?: Array<'default' | 'disabled' | 'enabled' | 'adaptive'>; reasoningEfforts?: string[] } }): Promise<IpcResult<ModelRecord>> => ipcRenderer.invoke('model:addManual', input),
  modelDiscoverPreview: (providerId: string, credentialRefId?: string | null): Promise<IpcResult<DiscoveryPreview>> => ipcRenderer.invoke('model:discoverPreview', { providerId, credentialRefId }),
  modelAcceptDiscovered: (discoveryId: string, remoteModelIds: string[]): Promise<IpcResult<ModelRecord[]>> => ipcRenderer.invoke('model:acceptDiscovered', { discoveryId, remoteModelIds }),
  modelProbe: (modelId: string, credentialRefId: string | null, acknowledgeMayBill: true): Promise<IpcResult<{ probeId: string; modelId: string; outcome: string }>> => ipcRenderer.invoke('model:probe', { modelId, credentialRefId, acknowledgeMayBill }),
  modelTestConnection: (modelId: string, credentialRefId: string | null, acknowledgeMayBill: true): Promise<IpcResult<ModelConnectionResult>> => ipcRenderer.invoke('model:testConnection', { modelId, credentialRefId, acknowledgeMayBill }),
  modelProbeTools: (modelId: string, credentialRefId: string | null, acknowledgeMayBill: true): Promise<IpcResult<ProbeResult>> => ipcRenderer.invoke('model:probeTools', { modelId, credentialRefId, acknowledgeMayBill }),
  modelRefreshCatalog: (): Promise<IpcResult<{ fetchedAt: string; modelCount: number }>> => ipcRenderer.invoke('model:refreshCatalog', {}),
  providerUpdateSetup: (input: ProviderSetupUpdateInput): Promise<IpcResult<ProviderRecord>> => ipcRenderer.invoke('provider:updateSetup', input),
  profileUpsert: (profile: Omit<ProfileRecord, 'createdAt' | 'updatedAt'>): Promise<IpcResult<ProfileRecord>> => ipcRenderer.invoke('profile:upsert', profile),
  profileSetBindings: (bindings: StageProfileBindings): Promise<IpcResult<void>> => ipcRenderer.invoke('profile:setBindings', bindings),
  profileResolveEffective: (profileId: string): Promise<IpcResult<EffectiveProfile>> => ipcRenderer.invoke('profile:resolveEffective', { profileId }),
  registryExport: (providerIds?: string[]): Promise<IpcResult<DeepWriterProviderBundleV1>> => ipcRenderer.invoke('registry:export', { providerIds }),
  registryImportPreview: (bundle: unknown): Promise<IpcResult<ImportPreview>> => ipcRenderer.invoke('registry:importPreview', { bundle }),
  registryImportCommit: (previewId: string): Promise<IpcResult<{ providerIds: string[]; modelIds: string[]; profileIds: string[] }>> => ipcRenderer.invoke('registry:importCommit', { previewId }),
  chooseDir: (sessionId: string): Promise<{ view: FileRefView; path: string } | null> => ipcRenderer.invoke('dialog:chooseDir', { sessionId }),
  chooseSdkExecutable: (): Promise<{ view: FileRefView; path: string } | null> => ipcRenderer.invoke('dialog:chooseSdkExecutable', { sessionId: 'settings' }),
  chooseSdkDirectory: (): Promise<{ view: FileRefView; path: string } | null> => ipcRenderer.invoke('dialog:chooseSdkDirectory', { sessionId: 'settings' }),
  openPath: (fileRefId: string, sessionId: string): Promise<boolean> => ipcRenderer.invoke('dialog:openPath', { fileRefId, sessionId }),
  artifactOpen: (runId: string, artifactId: string): Promise<boolean> => ipcRenderer.invoke('artifacts:open', { runId, artifactId }),
  chatFilesResolve: (input: { sessionId: string; messageId: string; candidates: string[] }): Promise<ChatFileView[]> => ipcRenderer.invoke('chatFiles:resolve', input),
  chatFileMenu: (anchor: ChatFileAnchor): Promise<ChatFileActionResult> => ipcRenderer.invoke('chatFiles:menu', { anchor }),
  chatFileAction: (anchor: ChatFileAnchor, action: ChatFileAction): Promise<ChatFileActionResult> => ipcRenderer.invoke('chatFiles:action', { anchor, action }),
  openFiles: (sessionId: string): Promise<FileRefView[]> => ipcRenderer.invoke('dialog:openFiles', { sessionId }),
  /** 拖拽文件注册：内部用 webUtils 取 OS 路径，renderer 业务代码不接触路径字符串（R4-1，FILE-06） */
  registerDroppedFiles: (files: File[], sessionId: string): Promise<FileRefView[]> => {
    const paths: string[] = []
    for (const f of files) {
      try {
        const p = webUtils.getPathForFile(f)
        if (p) paths.push(p)
      } catch {
        /* 取不到路径的 File 忽略（退回选择器） */
      }
    }
    return ipcRenderer.invoke('attachments:registerDrop', { sessionId, paths })
  },
  attachmentPreview: (refId: string, sessionId: string): Promise<AttachmentPreviewResult> =>
    ipcRenderer.invoke('attachments:preview', { refId, sessionId }),
  attachmentRemove: (refId: string, sessionId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('attachments:remove', { refId, sessionId }),
  galgameScan: (projectDir: string): Promise<RenpyProjectInfo> => ipcRenderer.invoke('galgame:scan', { projectDir }),
  galgameLint: (payload: { projectDir: string }): Promise<RenpyLintResult> => ipcRenderer.invoke('galgame:lint', payload),
  /** R4.5 Gate 1：对业务 run 执行 SDK lint 并写 run_evidence（runId 必须存在且非终态；路径取 run 快照） */
  galgameLintRun: (runId: string): Promise<{ ok: boolean; manifestHash: string; errorCount: number; warningCount: number }> =>
    ipcRenderer.invoke('galgame:lintRun', { runId }),
  renpyBranchGraph: (projectDir: string): Promise<BranchGraph> => ipcRenderer.invoke('renpy:branchGraph', { projectDir }),
  renpyResources: (projectDir: string): Promise<{ missing: string[] }> => ipcRenderer.invoke('renpy:resources', { projectDir }),
  renpyVariables: (projectDir: string): Promise<{ undeclared: string[] }> => ipcRenderer.invoke('renpy:variables', { projectDir }),
  renpyGeneratePatch: (input: { projectDir: string; sceneSpec: string }): Promise<GeneratePatchResult> => ipcRenderer.invoke('renpy:generatePatch', input),
  renpyApplyPatch: (input: { projectDir: string; patch: unknown }): Promise<ApplyPatchResult> => ipcRenderer.invoke('renpy:applyPatch', input),
  renpyRepairLoop: (input: { projectDir: string; maxRepairs?: number }): Promise<RepairLoopResult> => ipcRenderer.invoke('renpy:repairLoop', input),
  galgameStudioCreate: (input: { sessionId: string; parentDir: string; name: string }): Promise<GalgameStudioState> => ipcRenderer.invoke('galgameStudio:create', input),
  galgameStudioImport: (input: { sessionId: string; projectDir: string }): Promise<GalgameStudioState> => ipcRenderer.invoke('galgameStudio:import', input),
  galgameStudioLatest: (sessionId: string): Promise<GalgameStudioSnapshot | null> => ipcRenderer.invoke('galgameStudio:latest', { sessionId }),
  galgameStudioGet: (studioId: string): Promise<GalgameStudioSnapshot> => ipcRenderer.invoke('galgameStudio:get', { studioId }),
  galgameStudioOpenProject: (studioId: string): Promise<boolean> => ipcRenderer.invoke('galgameStudio:openProject', { studioId }),
  galgameStudioSdkCheck: (studioId: string): Promise<unknown> => ipcRenderer.invoke('galgameStudio:sdkCheck', { studioId }),
  galgameStudioSdkChoose: (studioId: string): Promise<unknown> => ipcRenderer.invoke('galgameStudio:sdkChoose', { studioId }),
  galgameStudioSdkDownload: (studioId: string): Promise<GalgameSdkEvidence> => ipcRenderer.invoke('galgameStudio:sdkDownload', { studioId }),
  galgameStudioSdkCancel: (studioId: string): void => { ipcRenderer.send('galgameStudio:sdkCancel', { studioId }) },
  galgameStudioSetAssets: (studioId: string, manifest: GalgameAssetManifest): Promise<unknown> => ipcRenderer.invoke('galgameStudio:assets', { studioId, manifest }),
  galgameStudioConfirmPlan: (input: { studioId: string; branchHash: string; outlineHash?: string }): Promise<GalgameStudioState> => ipcRenderer.invoke('galgameStudio:confirmPlan', input),
  galgameStudioGenerate: (studioId: string): Promise<unknown> => ipcRenderer.invoke('galgameStudio:generate', { studioId }),
  galgameStudioLint: (studioId: string): Promise<unknown> => ipcRenderer.invoke('galgameStudio:lint', { studioId }),
  galgameStudioRepair: (input: { studioId: string; maxRepairs?: number }): Promise<unknown> => ipcRenderer.invoke('galgameStudio:repair', input),
  onGalgameStudioProgress: (cb: (data: { studioId: string; progress: unknown }) => void): (() => void) => {
    const listener = (_e: unknown, data: { studioId: string; progress: unknown }): void => cb(data)
    ipcRenderer.on('galgameStudio:progress', listener)
    return () => ipcRenderer.removeListener('galgameStudio:progress', listener)
  },
  sessionsList: (): Promise<SessionMeta[]> => ipcRenderer.invoke('sessions:list'),
  composerDraftsList: (): Promise<PersistedComposerDraft[]> => ipcRenderer.invoke('composer:draftsList'),
  composerDraftSave: (input: ComposerDraftWrite): Promise<ComposerDraftWriteResult> => ipcRenderer.invoke('composer:draftSave', input),
  onDraftFlushRequested: (flush: () => Promise<void>, cancelled: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, input: { token: string }): void => {
      void Promise.resolve().then(flush).then(() => true, () => false)
        .then((ok) => ipcRenderer.invoke('composer:draftsFlushed', { token: input.token, ok })).catch(() => undefined)
    }
    ipcRenderer.on('composer:flushRequested', listener)
    ipcRenderer.on('composer:flushCancelled', cancelled)
    return () => {
      ipcRenderer.removeListener('composer:flushRequested', listener)
      ipcRenderer.removeListener('composer:flushCancelled', cancelled)
    }
  },
  undoFileEdit: (input: UndoFileEditInput): Promise<UndoFileEditResult> => ipcRenderer.invoke('edits:undo', input),
  sessionsEditHistory: (id: string, messageId: string, offset = 0): Promise<import('../shared/types').SessionEditHistoryPage> => ipcRenderer.invoke('sessions:editHistory', { id, messageId, offset }),
  sessionsFileEvidence: (id: string, messageId: string, offset = 0): Promise<import('../shared/fileEvidenceView').FileEvidencePage> => ipcRenderer.invoke('sessions:fileEvidence', { id, messageId, offset }),
  sessionsLoad: (id: string): Promise<SessionMessageSnapshot[]> => ipcRenderer.invoke('sessions:load', { id }),
  sessionsDelete: (id: string): Promise<boolean> => ipcRenderer.invoke('sessions:delete', { id }),
  sessionsRename: (id: string, title: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('sessions:rename', { id, title }),
  sessionsExport: (id: string, format?: 'json' | 'markdown'): Promise<{ ok: boolean; path: string; cancelled?: boolean }> => ipcRenderer.invoke('sessions:export', { id, format }),
  planReject: (input: AgentPlanApproval): Promise<boolean> => ipcRenderer.invoke('plan:reject', input),
  contextGetPreference: (sessionId: string): Promise<ContextPreferenceView> => ipcRenderer.invoke('context:getPreference', { sessionId }),
  contextSetMode: (sessionId: string, mode: ContextMode, expectedRevision: number): Promise<ContextPreferenceView> => ipcRenderer.invoke('context:setMode', { sessionId, mode, expectedRevision }),
  contextPreview: (input: { sessionId: string; mode: ContextMode; preferenceRevision: number; draftText: string; attachments: AttachmentRef[]; runMode?: 'agent' | 'longwrite' | 'style' | 'galgame'; longMode?: boolean; phase?: 'plan' | 'execute'; planText?: string; planAccess?: 'read_only'; planApproval?: AgentPlanApproval; story?: StoryConfig | null; targetChars?: number; strongConstraints?: StrongConstraintInput; grillMe?: ChatPayload['grillMe']; storyScope?: NarrativeLedgerScopeInput }): Promise<ContextPreviewV1> => ipcRenderer.invoke('context:preview', input),
  contextListPins: (sessionId: string): Promise<ContextPinView[]> => ipcRenderer.invoke('context:listPins', { sessionId }),
  contextPinMessage: (input: { sessionId: string; messageId: string; expectedContentHash: string; displayLabel?: string }): Promise<ContextPinView> => ipcRenderer.invoke('context:pinMessage', input),
  contextPinFact: (input: { sessionId: string; factText: string; displayLabel?: string }): Promise<ContextPinView> => ipcRenderer.invoke('context:pinFact', input),
  contextUnpin: (input: { sessionId: string; pinId: string; expectedRevision: number }): Promise<boolean> => ipcRenderer.invoke('context:unpin', input),
  contextGetSummary: (sessionId: string): Promise<RollingSummaryV1 | null> => ipcRenderer.invoke('context:getSummary', { sessionId }),
  contextRebuildSummary: (sessionId: string, expectedHighWatermark?: number): Promise<RollingSummaryV1 | null> => ipcRenderer.invoke('context:rebuildSummary', { sessionId, expectedHighWatermark }),
  contextGetRequestManifest: (requestId: string): Promise<ContextManifestV2 | null> => ipcRenderer.invoke('context:getRequestManifest', { requestId }),
  contextResolveSourceSnippet: (input: { manifestId: string; itemId: string }): Promise<ContextSourceSnippetView> => ipcRenderer.invoke('context:resolveSourceSnippet', input),
  /** R4.5 Gate 5：带 runId 时恢复边界只取该 run 快照 + 固定内部目录（不混入当前设置） */
  checkpointRestore: (payload: { backupId: string; sessionId: string; runId?: string }): Promise<{ ok: boolean; path: string; message: string }> =>
    ipcRenderer.invoke('checkpoint:restore', payload),
  getFilePath: (file: unknown): string => {
    if (!file || typeof file !== 'object') return ''
    try {
      return webUtils.getPathForFile(file as never)
    } catch {
      return ''
    }
  },
  permissionsGet: (): Promise<PermissionSettings> => ipcRenderer.invoke('permissions:get'),
  permissionRequests: (): Promise<PermissionRequestView[]> => ipcRenderer.invoke('permissions:requests'),
  permissionAnswer: (id: string, answer: PermissionAnswer): Promise<{ ok: boolean }> => ipcRenderer.invoke('permissions:answer', { id, answer }),
  onPermissionRequests: (cb: (views: PermissionRequestView[]) => void): (() => void) => {
    const listener = (_event: unknown, views: PermissionRequestView[]): void => cb(views)
    ipcRenderer.on('permissions:requestsChanged', listener)
    return () => ipcRenderer.removeListener('permissions:requestsChanged', listener)
  },
  permissionsUpdate: (s: PermissionSettings): Promise<boolean> => ipcRenderer.invoke('permissions:update', s),
  /** 全开权限特权流程（R4-2）：原生确认 → token → apply */
  requestFullAccess: (): Promise<{ ok: boolean; token?: string; reason?: string }> => ipcRenderer.invoke('permissions:requestFullAccess'),
  applyFullAccess: (token: string): Promise<{ ok: boolean; expiresAt?: number }> => ipcRenderer.invoke('permissions:applyFullAccess', { token }),
  /** 打开或隐藏只读的极简悬浮进度窗 */
  floatToggle: (): Promise<boolean> => ipcRenderer.invoke('float:toggle'),
  saveProjectBrief: (prior: { path: string; text: string; exists: boolean }, text: string): Promise<{ ok: true } | { ok: false; message: string }> => ipcRenderer.invoke('memory:saveProjectBrief', { prior, text }),
  memoryGet: (): Promise<MemoryInfo> => ipcRenderer.invoke('memory:get'),
  chatStart: (payload: ChatPayload): Promise<DesktopChatStartResult> =>
    ipcRenderer.invoke('chat:start', payload),
  grillStart: (input: { sessionId: string; originalTask: string; targetChars: number; genre?: string; kind?: string; attachments?: AttachmentRef[] }): Promise<GrillMeState> => ipcRenderer.invoke('grill:start', input),
  grillAttachmentsStatus: (sessionId: string): Promise<GrillMeAttachmentStatus[]> => ipcRenderer.invoke('grill:attachmentsStatus', { sessionId }),
  grillAttachmentReselect: (sessionId: string, fileRefId: string): Promise<GrillMeState | null> => ipcRenderer.invoke('grill:attachmentReselect', { sessionId, fileRefId }),
  grillGet: (sessionId: string): Promise<GrillMeState | null> => ipcRenderer.invoke('grill:get', { sessionId }),
  grillLatestUnconsumed: (sessionId?: string): Promise<GrillMeState | null> => ipcRenderer.invoke('grill:latestUnconsumed', sessionId ? { sessionId } : {}),
  grillAnswer: (input: { sessionId: string; questionId: string; value: string; decision?: 'answer' | 'decide' | 'not_applicable' }): Promise<GrillMeState> => ipcRenderer.invoke('grill:answer', input),
  grillAssumptionDecision: (sessionId: string, accept: boolean): Promise<GrillMeState> => ipcRenderer.invoke('grill:assumptionDecision', { sessionId, accept }),
  grillOutlineGenerate: (sessionId: string): Promise<GrillMeState> => ipcRenderer.invoke('grill:outlineGenerate', { sessionId }),
  grillOutlineUpdate: (sessionId: string, outline: GrillMeOutline): Promise<GrillMeState> => ipcRenderer.invoke('grill:outlineUpdate', { sessionId, outline }),
  grillOutlineApplicability: (sessionId: string, outline: GrillMeOutline): Promise<{ outlineHash: string; scenes: Array<{ sceneId: string; title: string; beats: string[] }> }> => ipcRenderer.invoke('grill:outlineApplicability', { sessionId, outline }),
  grillOutlineConfirm: (sessionId: string, expectedHash: string): Promise<GrillMeState> => ipcRenderer.invoke('grill:outlineConfirm', { sessionId, expectedHash }),
  grillCancel: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('grill:cancel', { sessionId }),
  chatStop: (id: string): void => {
    ipcRenderer.send('chat:stop', { id })
  },
  onChatEvent: (cb: (data: { id: string; ev: ChunkEvent }) => void): (() => void) => {
    const listener = (_e: unknown, data: { id: string; ev: ChunkEvent }): void => cb(data)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  },
  onChatError: (cb: (data: { id: string; code: string; message: string }) => void): (() => void) => {
    const listener = (_e: unknown, data: { id: string; code: string; message: string }): void => cb(data)
    ipcRenderer.on('chat:error', listener)
    return () => ipcRenderer.removeListener('chat:error', listener)
  },
  activityGetSnapshot: (runId: string): Promise<RunSnapshot | null> => ipcRenderer.invoke('activity:getSnapshot', { runId }),
  activityCancel: (runId: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('activity:cancel', { runId }),
  activityPause: (runId: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('activity:pause', { runId }),
  activityResume: (runId: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('activity:resume', { runId }),
  onActivityEvent: (cb: (ev: ActivityEvent) => void): (() => void) => {
    const listener = (_e: unknown, ev: ActivityEvent): void => cb(ev)
    ipcRenderer.on('activity:event', listener)
    return () => ipcRenderer.removeListener('activity:event', listener)
  },
  styleList: (): Promise<{ profiles: unknown[]; sources: unknown[]; activeProfileId: string }> => ipcRenderer.invoke('style:list'),
  styleAddSources: (refIds: string[], sessionId: string): Promise<unknown[]> => ipcRenderer.invoke('style:addSources', { refIds, sessionId }),
  styleBuild: (input: { name: string; sourceIds: string[] }): Promise<unknown> => ipcRenderer.invoke('style:build', input),
  styleUpdate: (input: { id: string; patch: unknown }): Promise<unknown> => ipcRenderer.invoke('style:update', input),
  styleDeleteProfile: (id: string): Promise<boolean> => ipcRenderer.invoke('style:deleteProfile', { id }),
  styleCheckOverlap: (input: { profileId: string; text: string }): Promise<unknown> => ipcRenderer.invoke('style:checkOverlap', input),
  styleSetActive: (profileId: string | null): Promise<boolean> => ipcRenderer.invoke('style:setActive', { profileId }),
  presetsList: (): Promise<unknown[]> => ipcRenderer.invoke('presets:list'),
  presetsSave: (preset: unknown): Promise<unknown[]> => ipcRenderer.invoke('presets:save', preset),
  presetsRemove: (id: string): Promise<unknown[]> => ipcRenderer.invoke('presets:remove', { id }),
  styleV2BuildProfile: (sourceIds: string[]): Promise<unknown> => ipcRenderer.invoke('stylev2:buildProfile', { sourceIds }),
  styleV2BuildExemplars: (profileId: string): Promise<unknown> => ipcRenderer.invoke('stylev2:buildExemplars', { profileId }),
  styleV2CorpusStatus: (profileId: string): Promise<unknown> => ipcRenderer.invoke('stylev2:corpusStatus', { profileId }),
  styleV2JobStart: (input: { profileId: string; task: unknown }): Promise<{ jobId: string }> => ipcRenderer.invoke('stylev2:jobStart', input),
  styleV2JobGet: (jobId: string): Promise<unknown> => ipcRenderer.invoke('stylev2:jobGet', { jobId }),
  styleV2JobStop: (jobId: string): Promise<boolean> => ipcRenderer.invoke('stylev2:jobStop', { jobId }),
  styleV2ChooseCandidate: (input: { jobId: string; candidateId: string }): Promise<unknown> => ipcRenderer.invoke('stylev2:chooseCandidate', input),
  styleV2Revise: (input: { jobId: string; revision: unknown }): Promise<unknown> => ipcRenderer.invoke('stylev2:revise', input),
  novelV2StartProject: (input: { title: string; targetChars: number; notes?: string; scenes?: unknown }): Promise<{ projectId: string; sceneCount: number }> =>
    ipcRenderer.invoke('novelv2:startProject', input),
  novelV2GenerateScene: (input: { projectId: string; sceneId: string; prompt?: string }): Promise<unknown> => ipcRenderer.invoke('novelv2:generateScene', input),
  novelV2ReviseScene: (input: { projectId: string; sceneId: string; issues: unknown; prompt?: string }): Promise<unknown> => ipcRenderer.invoke('novelv2:reviseScene', input),
  novelV2Status: (projectId: string): Promise<unknown> => ipcRenderer.invoke('novelv2:status', { projectId }),
  novelV2Stop: (): Promise<boolean> => ipcRenderer.invoke('novelv2:stop'),
  // ---- 运行记录与恢复（R4-4） ----
  runsList: (sessionId: string): Promise<unknown[]> => ipcRenderer.invoke('runs:list', { sessionId }),
  runsGet: (runId: string): Promise<unknown> => ipcRenderer.invoke('runs:get', { runId }),
  runsSteer: (input: import('../shared/workSteering').WorkSteeringInput): Promise<import('../shared/workSteering').WorkSteeringMessage> => ipcRenderer.invoke('runs:steer', input),
  runsSteering: (runId: string, sessionId: string): Promise<import('../shared/workSteering').WorkSteeringView> => ipcRenderer.invoke('runs:steering', { runId, sessionId }),
  runsSaveDraft: (runId: string): Promise<import('../shared/manuscriptDraft').ManuscriptDraftSaveResult> => ipcRenderer.invoke('runs:saveDraft', { runId }),
  runsListRecent: (limit = 20): Promise<Array<{ runId: string; sessionId: string; sessionTitle: string; status: string; phase: string; startedAt: number; updatedAt: number; model: string; durableCompleted: boolean }>> =>
    ipcRenderer.invoke('runs:listRecent', { limit }),
  runsGetBilling: (runId: string): Promise<RunBillingView | null> => ipcRenderer.invoke('runs:getBilling', { runId }),
  runsDelete: (runId: string, storyAction: 'preserve' | 'retract' = 'preserve'): Promise<{ ok: boolean; error?: string; storyAction?: 'preserve' | 'retract'; retractedRevisions?: number }> => ipcRenderer.invoke('runs:delete', { runId, storyAction }),
  workflowGetEvents: (runId: string, afterSeq = -1, limit = 500): Promise<{ events: ActivityEvent[]; lastSeq: number; hasMore: boolean }> =>
    ipcRenderer.invoke('workflow:getEvents', { runId, afterSeq, limit }),
  longformWorkflowCreate: (input: LongformWorkflowCreateInput): Promise<LongformWorkflowSnapshot> => ipcRenderer.invoke('longformWorkflow:create', input),
  longformWorkflowGet: (workflowId: string): Promise<LongformWorkflowSnapshot | null> => ipcRenderer.invoke('longformWorkflow:get', { workflowId }),
  // The main process derives the target phase and computes the canonical hash;
  // renderer code has no type-level path to submit authority internals.
  longformWorkflowMutate: (input: LongformWorkflowPublicMutationInput): Promise<LongformWorkflowSnapshot> =>
    ipcRenderer.invoke('longformWorkflow:mutate', input),
  longformWorkflowStop: (input: { workflowId: string; operationId: string; expectedRevision: number; payload?: unknown; draft?: LongformWorkflowDraft | null; note?: string | null }): Promise<LongformWorkflowSnapshot> => ipcRenderer.invoke('longformWorkflow:stop', input),
  longformWorkflowResume: (input: { workflowId: string; operationId: string; expectedRevision: number; payload?: unknown; note?: string | null }): Promise<LongformWorkflowSnapshot> => ipcRenderer.invoke('longformWorkflow:resume', input),
  longformWorkflowSubscribe: (workflowId: string): Promise<LongformWorkflowSnapshot | null> => ipcRenderer.invoke('longformWorkflow:subscribe', { workflowId }),
  longformWorkflowUnsubscribe: (workflowId: string): void => { ipcRenderer.send('longformWorkflow:unsubscribe', { workflowId }) },
  onLongformWorkflow: (cb: (snapshot: LongformWorkflowSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, snapshot: LongformWorkflowSnapshot): void => cb(snapshot)
    ipcRenderer.on('longformWorkflow:event', listener)
    return () => ipcRenderer.removeListener('longformWorkflow:event', listener)
  },
  onBillingUpdated: (cb: (data: { runId: string; revision: number }) => void): (() => void) => {
    const listener = (_e: unknown, data: { runId: string; revision: number }): void => cb(data)
    ipcRenderer.on('billing:updated', listener)
    return () => ipcRenderer.removeListener('billing:updated', listener)
  },
  runsRecoverable: (): Promise<unknown[]> => ipcRenderer.invoke('runs:recoverable'),
  runsResume: (runId: string, tokenBudget?: number, removeCallLimit?: true): Promise<{ ok: boolean; recoveryRequired?: boolean; storyEpochInvalidated?: boolean; waitingUser?: boolean; semanticReview?: NarrativeSemanticReviewPacket | null; pendingToolCalls?: unknown[]; message?: string; reason?: string }> => ipcRenderer.invoke('runs:resume', { runId, ...(tokenBudget !== undefined ? { tokenBudget } : {}), ...(removeCallLimit ? { removeCallLimit } : {}) }),
  runsStoryRebase: (runId: string, branchId?: string): Promise<{ ok: boolean; storyScope: NarrativeLedgerScopeInput; sessionId: string; sourceRevision: number; sourceEpoch: number }> => ipcRenderer.invoke('runs:storyRebase', { runId, ...(branchId ? { branchId } : {}) }),
  runsRecoverInfo: (runId: string): Promise<unknown> => ipcRenderer.invoke('runs:recoverInfo', { runId }),
  runsRecoverDecide: (input: { runId: string; decision: 'confirm_applied' | 'retry_not_applied' | 'rollback_then_retry' | 'abandon'; note?: string }): Promise<{ ok: boolean }> => ipcRenderer.invoke('runs:recoverDecide', input),
  runsNarrativeReview: (runId: string): Promise<{ ok: boolean; review: NarrativeSemanticReviewPacket | null }> => ipcRenderer.invoke('runs:narrativeReview', { runId }),
  runsNarrativeReviewDecide: (input: NarrativeSemanticReviewDecisionInput): Promise<NarrativeSemanticReviewDecisionResult | { ok: false; error?: string }> => {
    if (!input?.decisionId) return Promise.resolve({ ok: false, error: 'narrative_review_operation_missing' })
    return ipcRenderer.invoke('runs:narrativeReviewDecide', input)
  },
  // R4.4 Gate 4：角色监护实验 typed bridge（长文工作台实验开关用；默认关闭）
  ...(process.env.NODE_ENV === 'test'
    ? { testShutdown: (): Promise<boolean> => ipcRenderer.invoke('app:testShutdown') }
    : {}),
  deepWriteExperiment: (input: Record<string, unknown>): Promise<{ packet: unknown; draft: string | null; findings: unknown[]; adviceCount: number; degraded: boolean } | { error: string }> => ipcRenderer.invoke('deepwrite:experiment', input),
  runsAbandon: (runId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('runs:abandon', { runId }),
  // ---- 原生文件右键菜单（R4-1） ----
  fileContextMenuOpen: (input: { fileRefId: string; anchorKind: string; sessionId: string }): Promise<{ ok: boolean }> => ipcRenderer.invoke('fileContext:open', input),
  onAttachmentAttached: (cb: (data: { fileRefId: string; name: string; size: number; sessionId: string; draftId?: string }) => void): (() => void) => {
    const listener = (_e: unknown, data: { fileRefId: string; name: string; size: number; sessionId: string; draftId?: string }): void => cb(data)
    ipcRenderer.on('attachments:attached', listener)
    return () => ipcRenderer.removeListener('attachments:attached', listener)
  }
}

contextBridge.exposeInMainWorld('ds', api)

export type DsApi = typeof api
