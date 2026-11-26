import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildDeepWriteExperimentInput } from '../src/shared/deepWriteUi'
import { applyCompletionChunk } from '../src/shared/completionProgress'
import type { StoryConfig } from '../src/shared/types'

const readSource = (relativePath: string): string => readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8')

const story: StoryConfig = {
  enabled: true,
  genre: '悬疑',
  intensity: 'standard',
  structure: 'three-act',
  outputFormat: 'novel',
  tone: '',
  worldSetting: '',
  characters: Array.from({ length: 10 }, (_, i) => ({
    name: i === 9 ? ' '.repeat(3) : ` 角色 ${i + 1} `,
    role: `身份 ${i + 1}`,
    traits: '克制',
    motivation: '查明真相',
    voice: '短句'
  }))
}

assert.equal(buildDeepWriteExperimentInput({ mode: 'agent', longMode: true, experimentEnabled: true, characterConsent: true, story }), undefined)
assert.equal(buildDeepWriteExperimentInput({ mode: 'longwrite', longMode: false, experimentEnabled: true, characterConsent: true, story }), undefined)

const withoutConsent = buildDeepWriteExperimentInput({ mode: 'longwrite', longMode: true, experimentEnabled: true, characterConsent: false, story })
assert.deepEqual(withoutConsent?.characters, [], '未授权时不得发送本地角色卡')

const disabledStory = buildDeepWriteExperimentInput({ mode: 'longwrite', longMode: true, experimentEnabled: true, characterConsent: true, story: { ...story, enabled: false } })
assert.deepEqual(disabledStory?.characters, [], '未启用的故事设定不得被角色子任务旁路发送')

const withConsent = buildDeepWriteExperimentInput({ mode: 'longwrite', longMode: true, experimentEnabled: true, characterConsent: true, story })
assert.equal(withConsent?.characters.length, 8, '角色并发输入必须限量')
assert.equal(withConsent?.characters[0]?.name, '角色 1')
assert.match(withConsent?.characters[0]?.bible ?? '', /身份：身份 1/)
assert.ok((withConsent?.characters[0]?.bible.length ?? 0) <= 2000)

const paused = applyCompletionChunk('run-ui-contract', {
  subtype: 'continuation_paused',
  state: 'waiting_user',
  revision: 7,
  remainingWork: [{ code: 'length', message: '仍缺正文' }],
  blockedReason: 'budget_exhausted',
  pausedMessage: '预算已耗尽'
}, undefined)
assert.equal(paused?.pausedMessage, '预算已耗尽')
assert.equal(paused?.blockedReason, 'budget_exhausted')
assert.equal(applyCompletionChunk('run-ui-contract', { subtype: 'validator_result', state: 'validating', revision: 6 }, paused ?? undefined), null, '迟到 revision 不得覆盖暂停态')

const settingsSource = readSource('src/renderer/src/components/SettingsModal.tsx')
const inspectorSource = readSource('src/renderer/src/components/RunInspector/RunInspector.tsx')
const timelineSource = readSource('src/renderer/src/components/activity/ActivityTimeline.tsx')
const floatSource = readSource('src/renderer/src/FloatWindow.tsx')
const appSource = readSource('src/renderer/src/App.tsx')
const composerSource = readSource('src/renderer/src/components/Composer.tsx')
const longformWorkflowSource = readSource('src/renderer/src/components/LongformWorkflowShell.tsx')
const modelReasoningSource = readSource('src/renderer/src/components/ModelReasoningControl.tsx')
const contextSource = readSource('src/renderer/src/components/ContextDialog.tsx')
const providerSource = readSource('src/renderer/src/components/ProviderRegistryPanel.tsx')
const grillWorkbenchSource = readSource('src/renderer/src/components/GrillMeWorkbench.tsx')
const storeSource = readSource('src/renderer/src/store.ts')
const repositorySource = readSource('src/main/db/repository.ts')
const mainSource = readSource('src/main/index.ts')
const preloadSource = readSource('src/preload/index.ts')
const sidePanelSource = readSource('src/renderer/src/components/SidePanel.tsx')
const uiCss = readSource('src/renderer/src/ui-takeover.css')
const floatCss = readSource('src/renderer/src/floating.css')

assert.match(settingsSource, />完成判定</)
assert.doesNotMatch(settingsSource, /不会自动[“"]假完成/)
assert.match(uiCss, /\.dw-policy-note\s*\{[^}]*background:\s*transparent/s)
assert.match(uiCss, /\.step-title\s*\{[^}]*font-size:\s*13\.5px/s)
assert.match(uiCss, /\.tool-output-chunk\s*\{[^}]*font-size:\s*13px/s)
assert.match(readSource('src/renderer/src/toolLabels.ts'), /mock_tool:\s*'测试工具'/)
assert.match(inspectorSource, /import \{ TOOL_NAMES \} from '\.\.\/\.\.\/toolLabels'/)
assert.doesNotMatch(timelineSource, /`\$\{ms\}ms`/)
assert.match(floatSource, /aria-hidden=\{!hovered\}/)
assert.doesNotMatch(floatSource, /state\.title|completionSummary|generatedChars|targetChars|stepCurrent/)
assert.doesNotMatch(`${modelReasoningSource}\n${contextSource}\n${storeSource}`, /CONTEXT_MODES|setContextMode|dw-model-context-option/, '不再由作者选择上下文三档')
assert.doesNotMatch(`${settingsSource}\n${modelReasoningSource}\n${providerSource}`, /providerCapabilityOverride|contextWindowTokens/, '不提供全局窗口覆盖')
assert.match(modelReasoningSource, /查看本次上下文明细/, '高级入口仍提供按需明细')
assert.match(contextSource, /按模型自动管理/, '明细显示自动管理')
assert.match(contextSource, /contextPins\.map[\s\S]*unpinContext[\s\S]*添加必须保留的事实[\s\S]*pinFact/, '固定内容和事实编辑保留')
assert.match(providerSource, /aria-label="手动模型上下文上限"/, '仍能录入模型规格')
assert.doesNotMatch(composerSource, /上下文 \{ctxText\}/)
assert.match(floatCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
assert.doesNotMatch(floatCss, /backdrop-filter|linear-gradient/)
assert.doesNotMatch(appSource, /dw-empty-mark|>DW</)
// Only the user-approved strength track/thumb may have same-color shading.
// Anchor exact single-line selectors and brace-bounded declarations so this
// exception cannot swallow a neighboring/global rule or selector list.
const strengthShading = new Map<string, string>()
const uiCssWithoutStrengthShading = uiCss.replace(/^(\.dw-model-strength-view input\[type="range"\]::-(?:webkit-slider-runnable-track|webkit-slider-thumb))[ \t]*\{([^{}\r\n]*)\}\r?$/gm, (_rule, selector: string, declarations: string) => {
  assert.equal(strengthShading.has(selector), false, '胶囊着色例外只允许各一个精确 selector')
  strengthShading.set(selector, declarations)
  return `${selector} { }`
})
assert.equal(strengthShading.size, 2, '着色范围仅限强度滑杆 track/thumb')
const strengthTrack = strengthShading.get('.dw-model-strength-view input[type="range"]::-webkit-slider-runnable-track') ?? ''
const strengthThumb = strengthShading.get('.dw-model-strength-view input[type="range"]::-webkit-slider-thumb') ?? ''
assert.match(strengthTrack, /height:\s*14px;[\s\S]*border-radius:\s*999px/, '强度轨道为有界圆胶囊')
assert.match(strengthTrack, /var\(--dw-accent\)/, '填充沿用现有同蓝色 accent')
assert.match(strengthTrack, /var\(--dw-strength-progress\)/, '胶囊填充绑定真实离散值')
assert.match(strengthThumb, /width:\s*26px;\s*height:\s*26px/, '圆润 thumb 保持有界尺寸')
assert.match(modelReasoningSource, /'--dw-strength-progress':\s*`\$\{stops\.length > 1 \? displayStop \/ \(stops\.length - 1\) \* 100 : 0\}%`/, '进度来自当前真实档位，不是固定装饰')
assert.match(modelReasoningSource, /style=\{sliderStyle\}/, '真实进度变量传入原生 slider')
assert.doesNotMatch(uiCss, /backdrop-filter/, '全界面仍禁止模糊滤镜，滑杆也没有例外')
assert.doesNotMatch(uiCssWithoutStrengthShading, /backdrop-filter|linear-gradient/, '其余 shell/global CSS 继续禁止渐层与模糊')
assert.doesNotMatch(uiCss, /font-size:\s*(?:9|10|11(?:\.5)?)px/)
assert.match(settingsSource, />主题锁定</)
assert.match(settingsSource, />表达自由</)
assert.match(settingsSource, /自动检查说教式收尾/)
assert.doesNotMatch(sidePanelSource, /WorkspaceTabs|TokenMeter|StoryPanel/, '工作台不保留旧导航与旧参数面板')
assert.match(inspectorSource, /局部修订中/)
assert.match(inspectorSource, /step\.detail/)
// Grill Me launch now lives in the longform shell. Keep the request alive until
// the async IPC response; clearing it before await/effect cleanup drops the workbench.
const grillLaunchEffect = longformWorkflowSource.slice(longformWorkflowSource.indexOf('const request = grillLaunchRequest'))
assert.match(grillLaunchEffect, /grillStart\?\.\(\{ sessionId: request\.sessionId, originalTask: request\.task, targetChars: request\.targetChars, genre: request\.genre, kind: request\.kind, attachments: request\.attachments \}\)/, 'Grill 启动沿用 durable sessionId 与待启动请求')
assert.match(grillLaunchEffect, /if \(!alive \|\| !next \|\| useStore\.getState\(\)\.currentSessionId !== request\.sessionId\) return; setGrill\(next\); setGrillError\(null\); clearGrillLaunchRequest\(request\.requestId\)/s)
assert.doesNotMatch(grillLaunchEffect.slice(0, grillLaunchEffect.indexOf('let alive = true')), /clearGrillLaunchRequest\(request\.requestId\)/)
const grillCancelHandler = longformWorkflowSource.slice(longformWorkflowSource.indexOf('const onCancel = (): void =>'))
assert.match(grillCancelHandler, /if \(grill\) void \(window as any\)\.ds\?\.grillCancel\?\.\(grill\.sessionId\)\s*setGrillError\(null\)\s*setGrill\(null\)/s, '工作流侧栏停止通过 durable sessionId 取消并清理本地工作面')
assert.match(readSource('src/renderer/src/components/GrillMeWorkbench.tsx'), /state\.status === 'confirmed' \|\| state\.status === 'cancelled'/, 'Grill Me 工作台观察 durable 取消状态')
// R48：正文 handoff 的 durable Grill session 必须优先于 renderer 当前会话；
// 失败时保留大纲并把 IPC/context 的真实原因带到 UI，而不是统一吞成一句话。
assert.match(storeSource, /const sessionId = grillState\?\.sessionId \?\? s\.currentSessionId/, 'Grill handoff 使用 durable sessionId')
assert.match(storeSource, /const id = grillState\?\.sessionId \?\? get\(\)\.ensureSessionId\(\)/, 'Grill context preview 使用 durable sessionId')
assert.match(storeSource, /contextPreviewError: errorMessage\(error\)/, '上下文预览失败保留真实错误原因')
assert.match(storeSource, /reason: 'main_error', error: detail \|\|/, 'chat:start 失败返回真实错误原因')
assert.match(longformWorkflowSource, /const onConfirmed = async \(state: GrillMeState\): Promise<void> => \{\s*const result = await send\(state\.originalTask, state\.attachments \?\? \[\], state\)/s, '确认大纲后 handoff 等待 send ack 并只携带该采访的素材')
assert.match(longformWorkflowSource, /const text = result\.error\?\.trim\(\) \|\| result\.reason \|\| '未返回具体原因'; setGrillError\(text\); showToast\(`正文启动失败：\$\{text\}`, 'error'\)/, '正文启动失败显示真实原因并保留大纲')
assert.match(grillWorkbenchSource, /await after\?\.\(result\)/, '大纲确认后的正文启动被等待，避免重复点击/吞错')
assert.match(grillWorkbenchSource, /update\(next as GrillMeState\); return onConfirmed\(next as GrillMeState\)/, '确认大纲后先落 confirmed 状态再启动正文')
// R49：跨重启时，confirmed/采访中的 Grill 状态必须能从 durable store
// 回到长文页；已经绑定 run 的 confirmed 状态不可重复恢复。
assert.match(repositorySource, /getLatestUnconsumedGrillMeState/, 'repository 提供只读未消费 Grill 恢复查询')
assert.match(mainSource, /registerIpc\('grill:latestUnconsumed'/, 'main 注册 Grill 恢复 IPC')
assert.match(preloadSource, /grillLatestUnconsumed/, 'preload 暴露 Grill 恢复桥')
const grillRecoveryEffect = longformWorkflowSource.slice(longformWorkflowSource.indexOf('if (grill || !currentSessionId)'))
assert.match(grillRecoveryEffect, /grillLatestUnconsumed\?\.\(currentSessionId\)\.then\(async \(next: GrillMeState \| null\) => \{ if \(!alive \|\| !next \|\| next\.sessionId !== currentSessionId \|\| next\.status === 'cancelled'\) return; await restoreGrillSession\(next\); if \(alive\) setGrill\(next\) \}/s, '长文页恢复 Grill 时忽略取消态并等待 durable session 绑定')
assert.match(grillRecoveryEffect, /return \(\) => \{ alive = false \}/, '长文页恢复 Grill 的异步查询具备卸载 alive guard')
assert.match(storeSource, /restoreGrillSession:/, 'store 承载跨重启 Grill session 恢复')
assert.match(storeSource, /restoreGrillSession:\s*async \(state\) => \{\s*if \(get\(\)\.currentSessionId !== state\.sessionId\) await get\(\)\.switchSession\(state\.sessionId\)/s, '恢复 Grill 先切换到 durable sessionId')

console.log('UI-CONTRACT PASS')
