// ==================== IPC 共享 schema（Gate 1 / P0-02） ====================
// main/preload/renderer 共用：所有 IPC 入参用 zod 校验，拒绝 unknown 字段并限制长度/数量。
// 新增任何 IPC 必须在此登记 schema 并在 src/main/ipcGuard.ts 注册。
// 约定：通道入参统一为对象（除个别明确字符串），preload 负责包装，renderer 组件层签名尽量不变。

import { z } from 'zod'
import { COMPOSER_DRAFT_MAX_CHARS } from './composerDraft'
import { COMPATIBILITY_MAPPINGS } from './providerRegistry'
export const permissionAnswerSchema = z.object({ id: z.string().uuid(), answer: z.enum(['allow_once', 'allow_run', 'deny']) }).strict()
export const desktopUpdatePreferenceSchema = z.object({ autoCheck: z.boolean() }).strict()

const httpUrl = z.string().min(1).max(2048).refine((v) => {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}, '必须是合法 http(s) URL')

const nonEmptyString = z.string().min(1).max(4096)
const safeId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, '只允许字母数字下划线连字符')

export { settingsSetSchema, wp7FeatureFlagsSchema } from './settingsSchema'

// ---------------- sessions ----------------

export const saveProjectBriefSchema = z.object({
  prior: z.object({ path: z.string().min(1).max(32768), text: z.string().max(12002), exists: z.boolean() }),
  text: z.string().max(12002)
})
export const sessionIdSchema = z.object({ id: z.string().min(1).max(128) })
export const composerDraftWriteSchema = z.object({
  sessionId: safeId,
  text: z.string().max(COMPOSER_DRAFT_MAX_CHARS),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict()
export const composerDraftFlushSchema = z.object({ token: safeId, ok: z.boolean() }).strict()
export const sessionRenameSchema = z.object({ id: z.string().min(1).max(128), title: z.string().min(1).max(200) })
export const sessionExportSchema = z.object({ id: z.string().min(1).max(128), format: z.enum(['json', 'markdown']).optional() })

// ---------------- 附件/文件引用（R4-1 FileRef） ----------------

/** 选择器/拖拽注册的会话上下文（draftId 由 main 统一为 'current'） */
export const chooseDirSchema = z.object({ sessionId: z.string().min(1).max(128) })
export const registerDropSchema = z.object({
  sessionId: z.string().min(1).max(128),
  paths: z.array(nonEmptyString).max(64)
})
export const attachmentPreviewSchema = z.object({
  refId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128)
})

// ---------------- checkpoint ----------------

export const checkpointRestoreSchema = z.object({
  backupId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  // R4.5 Gate 5（S-03）：提供 runId 时恢复边界只取该 run 快照的 workDir/docDir + 固定内部目录
  // （不混入 currentSettings）；缺省为手动恢复（兼容旧调用）
  runId: z.string().min(1).max(128).optional()
})

// ---------------- 权限（R4-1：off 走特权 IPC，普通更新仅 safe/auto） ----------------

export const permissionsUpdateSchema = z.object({
  mode: z.enum(['safe', 'auto']), // SEC-02：renderer 不能直接提交 off
  rules: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        type: z.enum(['command', 'path']),
        pattern: z.string().min(1).max(4096),
        action: z.enum(['allow', 'deny', 'ask']),
        persistent: z.boolean(),
        literal: z.boolean().optional(),
        label: z.string().max(200).optional()
      })
    )
    .max(200)
})

/** 全开权限一次性授权（R4-2：token 绑定 sender，60s 内必须应用；R4.2 A2：lease 绑定 session） */
export const applyFullAccessSchema = z.object({ token: z.string().min(16).max(64), sessionId: z.string().min(1).max(128) })

// ---------------- R4.3 Gate 5：deepWrite 角色监护实验（实验版，无 UI） ----------------

export const deepWriteExperimentSchema = z.object({
  // R4.6 Gate 2：多人物集合（稳定 ID 主键）；单 card 保留兼容（旧调用）
  cards: z.array(z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    bible: z.string().max(20000),
    knownFacts: z.array(z.string().max(2000)).max(200).optional(),
    forbiddenKnowledge: z.array(z.string().max(2000)).max(200).optional()
  })).max(8).optional(),
  card: z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    bible: z.string().max(20000),
    knownFacts: z.array(z.string().max(2000)).max(200).optional(),
    forbiddenKnowledge: z.array(z.string().max(2000)).max(200).optional()
  }),
  brief: z.object({
    sceneId: z.string().min(1).max(128),
    beats: z.array(z.string().max(2000)).max(50),
    presentCharacterIds: z.array(z.string().max(128)).max(50),
    publicFacts: z.array(z.string().max(2000)).max(200).optional(),
    goal: z.string().max(4000)
  }),
  recentSpans: z.array(z.string().max(20000)).max(20).optional(),
  maxConcurrent: z.number().int().min(1).max(8).optional(),
  subagentTokenRatio: z.number().min(0.05).max(1).optional(),
  projectedSubagentTokens: z.number().int().min(0).max(10000000).optional(),
  writerInstructions: z.array(z.string().max(2000)).max(20).optional()
})

// ---------------- Galgame / Ren'Py ----------------

export const projectDirSchema = z.object({ projectDir: z.string().min(1).max(4096) })
export const renpyLintSchema = projectDirSchema
export const renpyGeneratePatchSchema = z.object({ projectDir: z.string().min(1).max(4096), sceneSpec: z.string().min(1).max(20000) })
export const renpyApplyPatchSchema = z.object({ projectDir: z.string().min(1).max(4096), patch: z.unknown() })
export const renpyRepairLoopSchema = z.object({
  projectDir: z.string().min(1).max(4096),
  sdkPath: z.string().max(4096).optional(), // 兼容保留；实际以 settings.galgame.sdkPath 为准
  maxRepairs: z.number().int().min(1).max(3).optional()
})

// ---------------- Galgame Studio R55 ----------------

const studioIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const studioCharacterSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  setting: z.string().min(1).max(10000),
  personality: z.string().max(4000).optional(),
  notes: z.string().max(4000).optional()
}).strict()
const studioSpriteSchema = z.object({
  id: z.string().min(1).max(128),
  characterId: z.string().min(1).max(128),
  expression: z.string().min(1).max(128),
  fileRefId: z.string().min(1).max(128),
  displayName: z.string().max(260).optional()
}).strict()
const studioBackgroundSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  fileRefId: z.string().min(1).max(128),
  displayName: z.string().max(260).optional()
}).strict()
const studioAudioSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  kind: z.enum(['music', 'sound']),
  fileRefId: z.string().min(1).max(128),
  displayName: z.string().max(260).optional()
}).strict()
const studioManifestSchema = z.object({
  schemaVersion: z.literal(1),
  characters: z.array(studioCharacterSchema).max(100),
  sprites: z.array(studioSpriteSchema).max(200),
  backgrounds: z.array(studioBackgroundSchema).max(200),
  audio: z.array(studioAudioSchema).max(100)
}).strict()
export const galgameStudioCreateSchema = z.object({ sessionId: z.string().min(1).max(128), parentDir: z.string().min(1).max(4096), name: z.string().min(1).max(200) }).strict()
export const galgameStudioImportSchema = z.object({ sessionId: z.string().min(1).max(128), projectDir: z.string().min(1).max(4096) }).strict()
export const galgameStudioSessionSchema = z.object({ sessionId: z.string().min(1).max(128) }).strict()
export const galgameStudioIdSchema = z.object({ studioId: studioIdSchema }).strict()
export const galgameStudioPlaytestSchema = z.object({ studioId: studioIdSchema }).strict()
export const galgameStudioAssetsSchema = z.object({ studioId: studioIdSchema, manifest: studioManifestSchema }).strict()
export const galgameStudioPlanSchema = z.object({ studioId: studioIdSchema, branchHash: z.string().regex(/^[a-f0-9]{64}$/), outlineHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
export const galgameStudioCancelSchema = z.object({ studioId: studioIdSchema }).strict()
export const galgameStudioRepairSchema = z.object({ studioId: studioIdSchema, maxRepairs: z.number().int().min(1).max(3).optional() }).strict()

// ---------------- novelv2 ----------------

export const novelV2SceneInput = z.object({
  title: z.string().min(1).max(200),
  chars: z.array(z.string().max(100)).max(50).optional(),
  wordTarget: z.number().int().min(100).max(200000)
})
export const novelV2StartSchema = z.object({
  title: z.string().min(1).max(200),
  targetChars: z.number().int().min(100).max(2000000),
  notes: z.string().max(20000).optional(),
  scenes: z.array(novelV2SceneInput).max(100).optional()
})
export const novelV2GenerateSchema = z.object({
  projectId: safeId,
  sceneId: safeId,
  prompt: z.string().max(20000).optional()
})
export const novelV2ReviseSchema = z.object({
  projectId: safeId,
  sceneId: safeId,
  issues: z.array(z.unknown()).max(200).optional(),
  prompt: z.string().max(20000).optional()
})
export const novelV2StatusSchema = z.object({ projectId: safeId })

// ---------------- style v1 ----------------

export const styleAddSourcesSchema = z.object({ refIds: z.array(z.string().min(1).max(128)).max(64), sessionId: z.string().min(1).max(128) })
export const styleBuildSchema = z.object({ name: z.string().min(1).max(200), sourceIds: z.array(safeId).max(64) })
export const styleUpdateSchema = z.object({ id: safeId, patch: z.unknown() })
export const styleDeleteProfileSchema = z.object({ id: safeId })
export const styleCheckOverlapSchema = z.object({ profileId: safeId, text: z.string().min(1).max(200000) })
export const styleSetActiveSchema = z.object({ profileId: z.string().max(128).nullable() })

// ---------------- style v2 ----------------

export const styleV2SourceIdsSchema = z.object({ sourceIds: z.array(safeId).max(64) })
export const styleV2ProfileIdSchema = z.object({ profileId: z.string().min(1).max(128) })
export const styleV2JobStartSchema = z.object({
  profileId: z.string().min(1).max(128),
  task: z.object({
    mode: z.enum(['new', 'rewrite', 'continue']).optional(),
    userPrompt: z.string().min(1).max(20000),
    targetChars: z.number().int().min(100).max(200000),
    sceneType: z.string().max(100).optional(),
    narrativeFunctions: z.array(z.string().max(100)).max(50).optional(),
    pov: z.string().max(100).optional(),
    emotionalArc: z.array(z.string().max(200)).max(50).optional(),
    fidelity: z.enum(['light', 'balanced', 'high']).optional(),
    requiredFacts: z.array(z.string().max(500)).max(100).optional(),
    forbiddenFacts: z.array(z.string().max(500)).max(100).optional(),
    outputFormat: z.enum(['prose', 'renpy']).optional()
  })
})
export const styleV2JobIdSchema = z.object({ jobId: z.string().min(1).max(128) })
export const styleV2ChooseSchema = z.object({ jobId: z.string().min(1).max(128), candidateId: z.string().min(1).max(128) })
export const styleV2ReviseSchema = z.object({
  jobId: z.string().min(1).max(128),
  revision: z.object({
    candidateId: z.string().min(1).max(128),
    spanStart: z.number().int().min(0),
    spanEnd: z.number().int().min(0),
    spanText: z.string().max(50000),
    preserveFacts: z.array(z.string().max(500)).max(100).optional(),
    failedRules: z.array(z.string().max(500)).max(100).optional(),
    leftContext: z.string().max(5000).optional(),
    rightContext: z.string().max(5000).optional()
  })
})

// ---------------- chat / activity / novel v1 / presets / dialog ----------------

const grillMeOutlineSceneSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(1000),
  purpose: z.string().max(3000),
  targetChars: z.number().int().min(0).max(2000000),
  beats: z.array(z.string().max(2000)).max(30),
  sourceSlotIds: z.array(z.string().min(1).max(128)).max(32),
  povCharacterId: z.string().max(128).optional(),
  locationId: z.string().max(256).optional()
}).strict()
const grillMeOutlineSectionSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(1000),
  purpose: z.string().max(3000),
  targetChars: z.number().int().min(0).max(2000000),
  beats: z.array(z.string().max(2000)).max(30),
  sourceSlotIds: z.array(z.string().min(1).max(128)).max(32),
  scenes: z.array(grillMeOutlineSceneSchema).max(32).optional()
}).strict()

const grillMePayloadSchema = z.object({
  stateId: z.string().min(1).max(128),
  originalTask: z.string().min(1).max(200000),
  targetChars: z.number().int().min(100).max(2000000),
  answers: z.array(z.object({ slotId: z.string().min(1).max(128), value: z.string().max(8000), source: z.string().max(32) }).strict()).max(32),
  assumptions: z.array(z.string().max(2000)).max(32),
  approvedOutline: z.object({ title: z.string().max(2000), premise: z.string().max(10000), targetChars: z.number().int().min(100).max(2000000), sections: z.array(grillMeOutlineSectionSchema).min(1).max(64) }).strict(),
  outlineRevision: z.number().int().min(1).max(10000),
  outlineHash: z.string().min(1).max(128),
  quickBypass: z.boolean().optional()
}).strict()

const storyLedgerScopeSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  storyId: safeId,
  projectId: safeId,
  branchId: safeId,
  parentRevision: z.number().int().min(0).optional(),
  parentBranchId: safeId.nullable().optional()
}).strict()

export interface DesktopCostChallenge {
  nonce: string
  runId: string
  expiresAt: number
  maxCalls: number | null
  maxTokens: number
}
export type DesktopCostDecision = { nonce: string; decision: 'accept_unknown_cost' }
export type DesktopChatStartResult =
  | { runId: string; acceptedAt: number; status: string; idempotent?: boolean }
  | { status: 'cost_confirmation_required'; challenge: DesktopCostChallenge }

export const chatStartSchema = z
  .object({
    id: z.string().min(1).max(128),
    sessionId: z.string().max(128).optional(),
    phase: z.enum(['plan', 'execute']).optional(),
    goalMode: z.enum(['guided', 'autonomous']).optional(),
    planText: z.string().max(20000).optional(),
    planAccess: z.literal('read_only').optional(),
    planApproval: z.object({ runId: z.string().min(1).max(128), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
    fixedPrefix: z.array(z.unknown()).max(64).optional(),
    history: z.array(z.unknown()).max(200).optional(), // R4.1 B-05：兼容旧调用；主进程以 canonical session 为准
    text: z.string().max(200000).optional(), // R4.1 B-05：新 user 消息（推荐，不再上传全量历史）
    story: z.unknown().optional(),
    longMode: z.boolean().optional(),
    targetChars: z.number().int().min(0).max(2000000).optional(),
    contextSelection: z.object({
      mode: z.enum(['full', 'optimized', 'minimal']),
      preferenceRevision: z.number().int().min(0),
      previewId: z.string().min(1).max(128)
    }).strict().optional(),
    grillMe: grillMePayloadSchema.optional(),
    quickBypass: z.boolean().optional(),
    unknownCostConsent: z.object({ nonce: z.string().regex(/^[a-f0-9]{64}$/), decision: z.literal('accept_unknown_cost') }).strict().optional(),
    storyScope: storyLedgerScopeSchema.optional(),
    mode: z.enum(['agent', 'longwrite', 'style', 'galgame']).optional(),
    workspace: z.string().max(64).optional(),
    strongConstraints: z
      .object({
        task: z.string().max(200_000).optional(),
        enabled: z.boolean(),
        level: z.enum(['balanced', 'strict']),
        themeLockMode: z.enum(['strong', 'guided', 'off']).optional(),
        expressionFreedom: z.enum(['high', 'balanced', 'controlled']).optional(),
        antiMoralizingEnabled: z.boolean().optional(),
        perspective: z.enum(['auto', 'first', 'third']),
        genre: z.string().max(4000),
        mustKeep: z.string().max(4000),
        avoid: z.string().max(4000)
      })
      .strict()
      .optional(),
    attachments: z.array(z.object({ name: z.string().max(200), fileRefId: z.string().min(1).max(128), size: z.number().int().min(0) }).strict()).max(64).optional(),
    // R4.6 Gate 3：用户目标的可验证产物条件（文件存在/可解析/内容下限；防自欺式完成）
    requiredFiles: z.array(z.object({ path: z.string().min(1).max(512), kind: z.enum(['text', 'markdown', 'renpy']), minChars: z.number().int().min(0).max(2000000).optional() }).strict()).max(8).optional(),
    // R4.5 Gate 2（B-02）：角色监护实验的结构化输入——仅长文模式允许 enabled；参数有安全上限
    deepWriteExperiment: z
      .object({
        enabled: z.boolean(),
        maxConcurrent: z.number().int().min(1).max(3).optional(),
        subagentTokenRatio: z.number().min(0).max(0.5).optional(),
        characters: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              name: z.string().min(1).max(100),
              bible: z.string().min(1).max(2000),
              knownFacts: z.array(z.string().min(1).max(200)).max(20).optional(),
              forbiddenKnowledge: z.array(z.string().min(1).max(200)).max(20).optional()
            }).strict()
          )
          .max(8)
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.goalMode && ((v.mode ?? 'agent') !== 'agent' || v.longMode || v.phase === 'plan')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['goalMode'], message: '目标模式仅用于普通 Agent 执行任务' })
    }
    // 仅长文模式允许实验（禁止死开关/滥用）
    if (v.deepWriteExperiment?.enabled === true && v.mode !== 'longwrite') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deepWriteExperiment'], message: '角色监护实验仅长文模式（longwrite）允许开启' })
    }
    if (v.strongConstraints?.enabled === true && v.mode !== 'longwrite') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['strongConstraints'], message: '强约束仅用于长文模式' })
    }
  })
export const chatStopSchema = z.object({ id: z.string().min(1).max(128) })
// R4.6 Grill Me：长文采访与大纲确认。正文 chat:start 不接受未确认的状态。
export const grillMeStartSchema = z.object({ sessionId: z.string().min(1).max(128), originalTask: z.string().min(1).max(200000), targetChars: z.number().int().min(100).max(2000000), genre: z.string().max(4000).optional(), kind: z.string().max(200).optional(), attachments: z.array(z.object({ fileRefId: safeId, name: z.string().max(200), size: z.number().int().min(0) }).strict()).max(64).optional() }).strict()
export const grillMeGetSchema = z.object({ sessionId: z.string().min(1).max(128) }).strict()
export const grillMeAttachmentReselectSchema = grillMeGetSchema.extend({ fileRefId: safeId }).strict()
export const grillMeLatestUnconsumedSchema = z.object({ sessionId: z.string().min(1).max(128).optional() }).strict()
export const grillMeAnswerSchema = z.object({ sessionId: z.string().min(1).max(128), questionId: z.string().min(1).max(128), value: z.string().max(8000), decision: z.enum(['answer', 'decide', 'not_applicable']).default('answer') }).strict()
export const grillMeAssumptionSchema = z.object({ sessionId: z.string().min(1).max(128), accept: z.boolean() }).strict()
export const grillMeOutlineUpdateSchema = z.object({ sessionId: z.string().min(1).max(128), outline: z.object({ title: z.string().max(2000), premise: z.string().max(10000), targetChars: z.number().int().min(100).max(2000000), sections: z.array(grillMeOutlineSectionSchema).min(1).max(64) }).strict() }).strict()
export const grillMeOutlineConfirmSchema = z.object({ sessionId: z.string().min(1).max(128), expectedHash: z.string().min(1).max(128) }).strict()
export const contextSessionSchema = z.object({ sessionId: z.string().min(1).max(128) }).strict()
export const contextSetModeSchema = contextSessionSchema.extend({ mode: z.enum(['full', 'optimized', 'minimal']), expectedRevision: z.number().int().min(0) }).strict()
export const contextPreviewSchema = contextSessionSchema.extend({
  mode: z.enum(['full', 'optimized', 'minimal']),
  preferenceRevision: z.number().int().min(0),
  draftText: z.string().max(200000),
  attachments: z.array(z.object({ fileRefId: z.string().min(1).max(128), name: z.string().max(200), size: z.number().int().min(0) }).strict()).max(64),
  // Only structured run inputs are accepted.  The main process rebuilds the
  // frozen prefix; renderer-supplied assembled prompts/source bytes are not.
  runMode: z.enum(['agent', 'longwrite', 'style', 'galgame']).optional(),
  longMode: z.boolean().optional(),
  phase: z.enum(['plan', 'execute']).optional(),
  planText: z.string().max(20000).optional(),
    planAccess: z.literal('read_only').optional(),
    planApproval: z.object({ runId: z.string().min(1).max(128), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  story: z.unknown().optional(),
  targetChars: z.number().int().min(0).max(2000000).optional(),
  strongConstraints: z.object({
    task: z.string().max(200000).optional(),
    enabled: z.boolean(),
    level: z.enum(['balanced', 'strict']),
    themeLockMode: z.enum(['strong', 'guided', 'off']).optional(),
    expressionFreedom: z.enum(['high', 'balanced', 'controlled']).optional(),
    antiMoralizingEnabled: z.boolean().optional(),
    perspective: z.enum(['auto', 'first', 'third']),
    genre: z.string().max(4000),
    mustKeep: z.string().max(4000),
    avoid: z.string().max(4000)
  }).strict().optional(),
  grillMe: grillMePayloadSchema.optional(),
  storyScope: storyLedgerScopeSchema.optional()
}).strict()
export const contextPinMessageSchema = contextSessionSchema.extend({ messageId: z.string().min(1).max(128), expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/), displayLabel: z.string().max(120).optional() }).strict()
export const contextPinFactSchema = contextSessionSchema.extend({ factText: z.string().min(1).max(4000), displayLabel: z.string().max(120).optional() }).strict()
export const contextUnpinSchema = contextSessionSchema.extend({ pinId: z.string().min(1).max(128), expectedRevision: z.number().int().min(0) }).strict()
export const contextRebuildSummarySchema = contextSessionSchema.extend({ expectedHighWatermark: z.number().int().min(0).optional() }).strict()
export const contextRequestSchema = z.object({ requestId: z.string().min(1).max(128) }).strict()
export const contextSourceSnippetSchema = z.object({ manifestId: z.string().min(1).max(128), itemId: z.string().min(1).max(128) }).strict()
export const activityRunIdSchema = z.object({ runId: z.string().min(1).max(128) })
export const novelV1StartSchema = z.object({
  sessionId: z.string().min(1).max(128),
  format: z.enum(['md', 'txt', 'docx'])
})
export const novelV1DirectSchema = z.object({
  sessionId: z.string().min(1).max(128),
  format: z.enum(['md', 'txt', 'docx']),
  story: z.unknown(),
  prompt: z.string().max(20000),
  targetChars: z.number().int().min(100).max(2000000)
})
export const novelV1StopSchema = z.object({ sessionId: z.string().min(1).max(128) })

export const presetSaveSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  desc: z.string().max(500).optional(),
  prompt: z.string().min(1).max(20000),
  builtin: z.boolean().optional(),
  story: z.unknown().optional(),
  longMode: z.boolean().optional(),
  targetChars: z.number().int().min(0).max(2000000).optional(),
  category: z.enum(['创作', 'Agent', '文档', 'RenPy', '自定义']).optional()
})
export const presetIdSchema = z.object({ id: z.string().min(1).max(128) })

export const openPathSchema = z.object({ fileRefId: z.string().min(1).max(128), sessionId: z.string().min(1).max(128) })
/** Artifact files are opened by durable IDs; renderer-provided raw paths are never trusted. */
export const artifactOpenSchema = z.object({
  runId: z.string().min(1).max(128),
  artifactId: z.string().min(1).max(260)
}).strict()

// ---------------- 运行记录与恢复（R4-4） ----------------

export const runsListSchema = z.object({ sessionId: z.string().min(1).max(128) })
export const runsGetSchema = z.object({ runId: z.string().min(1).max(128) })
export const workSteeringGetSchema = z.object({ runId: safeId, sessionId: safeId }).strict()
export const workSteeringSchema = workSteeringGetSchema.extend({ requestId: safeId, text: z.string().min(1).max(8000) }).strict()
/** Native save dialog owns the destination; renderer supplies only run identity. */
export const runsSaveDraftSchema = runsGetSchema.strict()
/** Read-only, bounded manuscript pages; exactly one durable identity. */
export const runsReadManuscriptSchema = z.object({
  runId: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  chapterId: z.string().min(1).max(1024).optional(),
  page: z.number().int().min(0).max(2000000).optional()
}).strict().refine(input => Boolean(input.runId) !== Boolean(input.sessionId), '请指定任务或会话')
/** Prepare a child story branch from the current authoritative head. */
export const runsStoryRebaseSchema = runsGetSchema.extend({ branchId: safeId.optional() }).strict()
/** 用户明确授权后扩展 waiting_user 长文预算；不读取当前设置静默改写旧快照。 */
export const runsResumeSchema = z.object({
  runId: z.string().min(1).max(128),
  removeCallLimit: z.literal(true).optional(),
  reauthorizeGoal: z.literal(true).optional(),
  tokenBudget: z.number().int().min(1).max(2_000_000).optional()
})
export const runsRecentSchema = z.object({ limit: z.number().int().min(1).max(100).optional() })
/** 运行记录删除与故事线修订撤回是两个显式动作；默认只删执行记录。 */
export const runsDeleteSchema = z.object({
  runId: z.string().min(1).max(128),
  storyAction: z.enum(['preserve', 'retract']).default('preserve')
}).strict()
export const workflowEventsSchema = z.object({
  runId: z.string().min(1).max(128),
  afterSeq: z.number().int().min(-1).optional(),
  limit: z.number().int().min(1).max(10000).optional()
})

// ---------------- WP6：权威 long-form workflow projection ----------------
// The renderer submits only structured operation data.  Canonicalization and
// the final hash are re-checked in the shared/main reducer.
const longformWorkflowStage = z.enum(['requirements', 'outline', 'scene_direction', 'recall', 'draft', 'critique', 'revision', 'semantic_review', 'commit', 'reorientation', 'export', 'director', 'writing', 'check', 'review'])
const longformWorkflowStatus = z.enum(['locked', 'ready', 'running', 'waiting_user', 'blocked', 'completed', 'needs_recovery', 'cancelled', 'draft', 'provider_failed', 'export_failed', 'candidate', 'review'])
// Generic renderer mutations are limited to explicit user/recovery actions.
// Stage projection, run binding, recall audit and semantic-review decisions
// stay on their dedicated main-process paths.
const longformWorkflowPublicAction = z.enum(['accept_candidate', 'retry_provider', 'retry_export', 'recover', 'resume_draft', 'export', 'reorient'])
const longformRecoveryAction = z.enum(['resume_draft', 'retry_provider', 'retry_export', 'review_pending_operation', 'rebase_story', 'reopen_workflow', 'abandon'])
const longformDraft = z.object({
  text: z.string().max(2_000_000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  segmentId: safeId.nullish(),
  sceneId: safeId.nullish(),
  savedAt: z.number().finite().optional()
}).strict()

export const longformWorkflowCreateSchema = z.object({
  workflowId: safeId,
  storyId: safeId.optional(),
  projectId: safeId.optional(),
  branchId: safeId.optional(),
  sessionId: safeId.nullish(),
  chapterIndex: z.number().int().min(0).nullable().optional(),
  sceneIndex: z.number().int().min(0).nullable().optional(),
  sceneId: safeId.nullish(),
  validityEpoch: z.number().int().min(1).optional(),
  outlineRevision: z.number().int().min(0).optional(),
  outlineHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  contractRevision: z.number().int().min(0).optional(),
  contractHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  now: z.number().finite().optional()
}).strict()
export const longformWorkflowGetSchema = z.object({ workflowId: safeId }).strict()
export const longformWorkflowSubscribeSchema = longformWorkflowGetSchema
export const longformWorkflowUnsubscribeSchema = longformWorkflowGetSchema
export const longformWorkflowMutationSchema = z.object({
  workflowId: safeId,
  operationId: safeId,
  decisionId: safeId.nullish(),
  action: longformWorkflowPublicAction,
  expectedRevision: z.number().int().min(0),
  delta: z.unknown().optional(),
  note: z.string().max(4000).nullable().optional(),
  payload: z.unknown().optional()
}).strict()
export const longformWorkflowStopSchema = z.object({
  workflowId: safeId,
  operationId: safeId,
  expectedRevision: z.number().int().min(0),
  payload: z.unknown().optional(),
  draft: longformDraft.nullable().optional(),
  note: z.string().max(4000).nullable().optional()
}).strict()
export const longformWorkflowResumeSchema = z.object({
  workflowId: safeId,
  operationId: safeId,
  expectedRevision: z.number().int().min(0),
  payload: z.unknown().optional(),
  note: z.string().max(4000).nullable().optional()
}).strict()

// ---------------- R4.2 A4：恢复决策门（S-03：没有显式决策不得 step） ----------------

export const recoverDecideSchema = z.object({
  runId: z.string().min(1).max(128),
  decision: z.enum(['confirm_applied', 'retry_not_applied', 'rollback_then_retry', 'abandon']),
  note: z.string().max(2000).optional()
})

/** Scene/narrative semantic review is a revisioned, hash-bound user gate. */
export const narrativeReviewDecisionSchema = z.object({
  runId: z.string().min(1).max(128),
  decision: z.enum(['accept_delta', 'accept_unknown', 'accept_prose_no_state', 'reject_rewrite', 'abandon']),
  expectedRevision: z.number().int().min(1),
  // The main process assigns this deterministic/recoverable operation id and
  // the renderer must send it back verbatim; it must never invent an id.
  decisionId: z.string().min(1).max(128),
  delta: z.unknown().optional(),
  note: z.string().max(2000).optional()
}).strict()

// ---------------- 原生文件右键菜单（R4-1） ----------------

export const fileContextOpenSchema = z.object({
  fileRefId: z.string().min(1).max(128),
  anchorKind: z.enum(['attachment', 'file', 'artifact', 'style-source', 'novel-chapter', 'galgame-script']),
  sessionId: z.string().min(1).max(128)
})

// ---------------- R44 Provider Registry ----------------

const registryId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/)
const providerPath = z.string().min(1).max(512).startsWith('/')
const providerProtocol = z.enum(['deepseek-chat', 'openai-chat', 'openai-responses', 'anthropic-messages'])
const headerName = z.string().trim().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
const providerExtraHeaders = z.record(z.string().trim().min(1).max(128), z.string().max(4096)).refine((headers) => Object.keys(headers).every((key) => !/^(authorization|proxy-authorization|cookie|host|content-length|content-type|x-api-key|anthropic-version)$/i.test(key)), { message: '额外 Header 不能覆盖安全关键头；协议所需版本头由预设自动注入' })
const transportPolicySchema = z.object({
  scope: z.enum(['public_https', 'loopback_http']),
  allowNonDefaultPort: z.boolean(),
  protocol: providerProtocol.optional(),
  authHeaderName: headerName.optional(),
  extraHeaders: providerExtraHeaders.optional()
}).strict()

export const providerCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().min(1).max(2048),
  chatPath: providerPath,
  modelsPath: providerPath.nullable(),
  authStyle: z.enum(['bearer', 'none']),
  transportPolicy: transportPolicySchema
}).strict()
export const providerIdSchema = z.object({ providerId: registryId }).strict()
export const providerSetupSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().min(1).max(2048),
  apiKey: z.string().max(4096),
  authStyle: z.enum(['bearer', 'none']).optional(),
  protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic-messages']),
  modelIds: z.array(z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/)).min(1).max(100)
}).strict()
export const providerCredentialSchema = z.object({ providerId: registryId, credentialRefId: registryId.nullish() }).strict()
export const credentialCreateSchema = z.object({ providerId: registryId, label: z.string().trim().min(1).max(100), secret: z.string().min(1).max(4096) }).strict()
export const credentialReplaceSchema = z.object({ credentialRefId: registryId, secret: z.string().min(1).max(4096) }).strict()
export const credentialIdSchema = z.object({ credentialRefId: registryId }).strict()
export const credentialDefaultSchema = z.object({ providerId: registryId, credentialRefId: registryId }).strict()
export const modelManualSchema = z.object({
  providerId: registryId,
  remoteModelId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().min(1).max(100_000_000).nullable().optional(),
  maxOutputTokens: z.number().int().min(1).max(10_000_000).nullable().optional(),
  declarations: z.object({
    streaming: z.enum(['supported', 'unsupported', 'unknown']).optional(),
    toolUse: z.enum(['supported', 'unsupported', 'unknown']).optional(),
    reasoning: z.enum(['supported', 'unsupported', 'unknown']).optional(),
    reasoningModes: z.array(z.enum(['default', 'disabled', 'enabled', 'adaptive'])).max(4).optional(),
    reasoningEfforts: z.array(z.string().trim().min(1).max(40)).max(16).optional()
  }).strict().optional()
}).strict().refine((input) => input.contextWindow == null || input.maxOutputTokens == null || input.maxOutputTokens <= input.contextWindow, { message: '单次输出上限不能超过上下文上限', path: ['maxOutputTokens'] })
export const modelAcceptSchema = z.object({ discoveryId: registryId, remoteModelIds: z.array(z.string().min(1).max(200)).max(500) }).strict()
export const modelProbeSchema = z.object({ modelId: registryId, credentialRefId: registryId.nullish(), acknowledgeMayBill: z.literal(true) }).strict()
export const modelToolProbeSchema = modelProbeSchema
export const providerSetupUpdateSchema = z.object({ providerId: registryId, baseUrl: httpUrl, apiKey: z.string().max(4096).optional(), clearApiKey: z.boolean().optional(), authStyle: z.enum(['bearer', 'none']).optional(), protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic-messages']) }).strict()
const referencePrice = z.number().finite().min(0).max(1_000_000)
export const providerPricingListSchema = z.object({ modelId: registryId }).strict()
export const providerPricingUpsertSchema = z.object({
  modelId: registryId,
  currency: z.string().regex(/^[A-Z]{3}$/),
  unit: z.literal('per_1m_tokens'),
  inputPrice: referencePrice,
  outputPrice: referencePrice,
  cacheHitInputPrice: referencePrice.nullable().optional(),
  cacheWriteInputPrice: referencePrice.nullable().optional(),
  reasoningPrice: referencePrice.nullable().optional(),
  reasoningBillingRule: z.enum(['included_in_output', 'separate', 'unknown']),
  validFrom: z.string().datetime(),
  sourceUrl: z.string().trim().max(2048).url().nullable().optional(),
  acknowledgeReferenceOnly: z.literal(true)
}).strict()
const generationSchema = z.object({
  temperature: z.number().finite().min(0).max(2).nullable(),
  topP: z.number().finite().min(0).max(1).nullable(),
  maxOutputTokens: z.number().int().min(1).max(10_000_000).nullable(),
  stream: z.boolean()
}).strict()
const reasoningSchema = z.object({
  mode: z.enum(['default', 'disabled', 'enabled', 'adaptive']),
  effort: z.string().trim().min(1).max(40).nullable(),
  budgetTokens: z.number().int().min(1).max(10_000_000).nullable()
}).strict()
export const profileUpsertSchema = z.object({
  id: registryId,
  name: z.string().trim().min(1).max(100),
  providerId: registryId,
  modelId: registryId,
  credentialRefId: registryId.nullable(),
  generation: generationSchema,
  reasoning: reasoningSchema,
  compatibilityMappingId: z.enum(COMPATIBILITY_MAPPINGS).nullable()
}).strict()
export const profileIdSchema = z.object({ profileId: registryId }).strict()
export const profileBindingsSchema = z.object({
  defaultProfileId: registryId,
  planningProfileId: registryId.optional(),
  draftProfileId: registryId.optional(),
  reviewProfileId: registryId.optional(),
  polishProfileId: registryId.optional()
}).strict()
export const registryExportSchema = z.object({ providerIds: z.array(registryId).max(100).optional() }).strict()
export const registryImportPreviewSchema = z.object({ bundle: z.unknown() }).strict()
export const registryImportCommitSchema = z.object({ previewId: registryId }).strict()

const extensionId = z.string().max(129).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/)
export const extensionsEmptySchema = z.object({}).strict()
export const extensionIdSchema = z.object({ id: extensionId }).strict()
export const extensionEnabledSchema = z.object({ id: extensionId, enabled: z.boolean() }).strict()
const extensionIds = z.array(extensionId).max(8).refine(ids => new Set(ids).size === ids.length, '扩展选择不能重复')
export const extensionSelectionSchema = z.object({ skills: extensionIds, plugins: extensionIds }).strict()
  .refine(input => !input.skills.some(id => input.plugins.includes(id)), '技能与插件不能选择同一标识')

/** A reply's recorded edits; message ownership is checked by the repository query. */
export const sessionEditHistorySchema = z.object({ id: z.string().min(1).max(240), messageId: z.string().min(1).max(300), offset: z.number().int().min(0).max(1000000).default(0) }).strict()

export const sessionFileEvidenceSchema = sessionEditHistorySchema

const chatFileAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), sessionId: safeId, messageId: z.string().min(1).max(300), candidate: z.string().min(1).max(2048) }).strict(),
  z.object({ kind: z.literal('artifact'), runId: safeId, artifactId: safeId }).strict()
])
export const chatFilesResolveSchema = z.object({ sessionId: safeId, messageId: z.string().min(1).max(300), candidates: z.array(z.string().min(1).max(2048)).max(128) }).strict()
export const chatFileMenuSchema = z.object({ anchor: chatFileAnchorSchema }).strict()
export const chatFileActionSchema = z.object({ anchor: chatFileAnchorSchema, action: z.enum(['open', 'reveal', 'copy-absolute']) }).strict()

export const agentPlanDecisionSchema = z.object({ runId: z.string().min(1).max(128), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

/** Durable edit identity only: paths/checkpoints are resolved by the main process. */
export const undoFileEditSchema = z.object({ sessionId: safeId, runId: safeId, toolCallId: z.string().min(1).max(512) }).strict()
