import { z } from 'zod'
import { MODELS } from './types'
import { USER_PRESET_PROMPT_MAX_CHARS } from './userPresetPrompt'

/**
 * Provider endpoint 白名单（R4-1 收紧，R4-2 扩展为 credential 绑定）：
 * 官方 DeepSeek HTTPS origin + OpenCode Go 的精确 OpenAI-compatible base URL
 * + 本地开发例外（localhost/127.0.0.1）。其他自定义兼容 endpoint 不得通过普通
 * settings 写入。
 */
const providerBaseUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
      if (u.username !== '' || u.password !== '') return false
      const host = u.hostname.toLowerCase()
      if (u.protocol === 'https:') {
        // 官方 DeepSeek origin
        if (host === 'api.deepseek.com') return true
        // OpenCode Go：仅允许官方文档列出的 chat/completions base，拒绝同源其他路径、query/hash。
        if (
          host === 'opencode.ai' &&
          u.port === '' &&
          u.pathname === '/zen/go/v1' &&
          u.search === '' &&
          u.hash === ''
        ) return true
      }
      // 本地开发例外（http 仅限 localhost）
      if (u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) return true
      return false
    } catch {
      return false
    }
  }, 'endpoint 必须是官方 DeepSeek、OpenCode Go 精确兼容地址或本地开发地址')

export const wp7FeatureFlagsSchema = z.object({
  sceneContractV2: z.boolean(), deterministicDirector: z.boolean(), dramaticCritic: z.boolean(),
  localizedRevision: z.boolean(), reorientation: z.boolean()
}).strict()

const textPath = z.string().max(4096)
const refPath = (text: typeof textPath) => z.union([text, z.object({ value: text, dirRefId: z.string().min(1).max(128) }).strict()])
const requiredDir = refPath(textPath.refine(value => !!value.trim(), '目录不能为空'))
const optionalDir = refPath(textPath)
const knownModels = new Set<string>(MODELS.map(model => model.id))
const writingField = z.string().max(4000)
const optionalWorkLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable()
const agentRunBudget = z.object({
  maxCalls: optionalWorkLimit, maxTurns: optionalWorkLimit, maxTokens: optionalWorkLimit, maxWallClockMs: optionalWorkLimit,
  maxCost: z.object({ amount: z.number().finite().min(0), currency: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,15}$/u).nullable(), unknownPolicy: z.literal('deny') }).strict().nullable()
}).strict()

// The legacy settings route edits built-in models. Custom endpoints/models use ProviderRegistry.
const fields = z.object({
  outputTokenLimit: z.number().int().min(1).max(1000000).nullable(),
  agentRunBudget,
  apiKey: z.string().max(4096), userPresetPrompt: z.string().refine(v => Array.from(v).length <= USER_PRESET_PROMPT_MAX_CHARS),
  model: z.string().max(128).refine(v => knownModels.has(v), '请选择内置模型，或在模型与接口中添加自定义模型'),
  baseUrl: providerBaseUrl, thinkingEnabled: z.boolean(), reasoningEffort: z.enum(['default', 'low', 'medium', 'high', 'max']),
  temperature: z.number().finite().min(0).max(2), topP: z.number().finite().min(0).max(1),
  maxTokens: z.number().int().min(256).max(131072), toolsEnabled: z.boolean(), webAccessEnabled: z.boolean(), docDir: requiredDir, workDir: requiredDir,
  historyBudgetTokens: z.number().int().min(0).max(2000000), planMode: z.boolean(), permissionMode: z.enum(['safe', 'auto']),
  novelMode: z.boolean(), wp7FeatureFlags: wp7FeatureFlagsSchema,
  providerCapabilityOverride: z.object({
    contextWindowTokens: z.number().int().min(8000).max(10000000), maxOutputTokens: z.number().int().min(256).max(1000000),
    supportsTools: z.boolean(), supportsThinking: z.boolean()
  }).partial().strict(),
  completionTokenBudget: z.number().int().min(0).max(1000000000), completionWallClockMs: z.number().int().min(0).max(86400000),
  strongConstraintEnabled: z.boolean(), strongConstraintLevel: z.enum(['balanced', 'strict']), themeLockMode: z.enum(['strong', 'guided', 'off']),
  expressionFreedom: z.enum(['high', 'balanced', 'controlled']), antiMoralizingEnabled: z.boolean(),
  strongConstraintPerspective: z.enum(['auto', 'first', 'third']), strongConstraintGenre: writingField,
  strongConstraintMustKeep: writingField, strongConstraintAvoid: writingField,
  galgame: z.object({ enabled: z.boolean(), projectDir: optionalDir, sdkPath: optionalDir }).partial().strict()
})

export const settingsSetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('patch'), key: fields.keyof(), value: z.unknown() }).superRefine((patch, ctx) => {
    const result = fields.shape[patch.key].safeParse(patch.value)
    if (!result.success) ctx.addIssue({ code: 'custom', path: ['value'], message: `${patch.key}：${result.error.issues[0].message}` })
  }),
  z.object({ kind: z.literal('whole'), settings: fields.partial().required({ model: true, baseUrl: true, apiKey: true }) })
])
