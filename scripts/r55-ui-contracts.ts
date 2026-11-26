import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string => readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8')

const app = readSource('src/renderer/src/App.tsx')
const composer = readSource('src/renderer/src/components/Composer.tsx')
const model = readSource('src/renderer/src/components/ModelReasoningControl.tsx')
const context = readSource('src/renderer/src/components/ContextDialog.tsx')
const store = readSource('src/renderer/src/store.ts')
const registry = readSource('src/renderer/src/hooks/useComposerRegistry.ts')
const sharedRegistry = readSource('src/renderer/src/hooks/useProviderRegistry.ts')
const registryResource = readSource('src/renderer/src/providerRegistryResource.ts')
const providerManager = readSource('src/renderer/src/components/ProviderManager.tsx')
const agentPreset = readSource('src/renderer/src/components/AgentPresetControl.tsx')
const sidePanel = readSource('src/renderer/src/components/SidePanel.tsx')
const longform = readSource('src/renderer/src/components/LongformWorkflowShell.tsx')
const target = readSource('src/renderer/src/writingMode.ts')
const settings = readSource('src/renderer/src/components/SettingsModal.tsx')
const provider = readSource('src/renderer/src/components/ProviderRegistryPanel.tsx')
const selectControl = readSource('src/renderer/src/components/SelectControl.tsx')
const galgameStudio = readSource('src/renderer/src/components/GalgameStudio.tsx')
const css = readSource('src/renderer/src/ui-takeover.css')
const screenshots = readSource('scripts/r54-ui-screenshots.ts')

const checks: Array<() => void> = [
  () => assert.equal((composer.match(/<AgentPresetControl\s*\/>/g) ?? []).length, 1, 'Agent 预设入口保持单实例'),
  () => assert.match(app, /<Composer onOpenSettings=/, 'Composer 可从模型浮层打开设置'),
  () => assert.doesNotMatch(app, /className="dw-model"/, '顶部不重复显示模型名称'),
  () => assert.match(composer, /ModelReasoningControl/, 'Composer 左下挂载模型入口'),
  () => {
    assert.match(registryResource, /window\.ds\?\.providerSnapshot\?\.\(\)/, '共享只读资源通过正式桥获取 snapshot')
    assert.match(registryResource, /if \(pending\) return pending/, '共享资源复用同一个在途 IPC')
    assert.match(registryResource, /ticket !== revision\) return pending \?\? snapshot[\s\S]*if \(result\?\.ok\) \{\s*snapshot = result\.data/, '失效前的旧响应不能覆盖新状态，只有成功且当前的读取发布 snapshot')
    assert.equal((`${registry}\n${sharedRegistry}\n${registryResource}\n${providerManager}\n${provider}`.match(/window\.ds\?\.providerSnapshot\?\.\(\)/g) ?? []).length, 1, 'Composer、设置及高级页只保留一个正式读取入口')
    assert.match(sharedRegistry, /useSyncExternalStore\(subscribeProviderRegistry, getProviderRegistrySnapshot\)/, 'hook 订阅同一份共享状态而非各自重载')
    assert.match(registry, /const registry = useProviderRegistry\(\)/, 'Composer hook 消费共享资源')
    assert.match(providerManager, /const registry = useProviderRegistry\(\)/, '设置面板消费同一资源')
    assert.match(provider, /const registry = useProviderRegistry\(\)/, '高级面板消费同一资源')
    assert.match(composer, /const \{ snapshot, refreshSnapshot \} = useComposerRegistry\(settings\)/, 'Composer 读取共享的 registry 选择')
    assert.match(composer, /<ModelReasoningControl snapshot=\{snapshot\} refreshSnapshot=\{refreshSnapshot\}/, '同一 registry snapshot 和刷新能力传给模型控件')
    assert.match(model, /modelOptions\(snapshot, currentModel\)/, '模型候选由传入的真实 registry 产生')
  },
  () => assert.match(model, /profileUpsert/, '模型/强度切换更新 Profile'),
  () => assert.match(model, /profileSetBindings/, '模型/强度切换更新新任务 Profile binding'),
  () => assert.match(model, /profileInput/, 'Profile 更新只提交持久化字段'),
  () => assert.match(model, /role="listbox"/, '模型选择具备 listbox ARIA'),
  () => {
    assert.match(model, /type="range"[\s\S]*step=\{1\}/, '推理强度使用原生离散 slider 键盘语义')
    assert.match(model, /aria-label="思考强度"[\s\S]*aria-valuetext=/, '强度 slider 有可访问名称及真实档位描述')
    assert.match(model, /onKeyUp=[\s\S]*ArrowLeft[\s\S]*ArrowRight[\s\S]*Home[\s\S]*End[\s\S]*commitStop/, '箭头、Home、End 提交真实离散档位')
  },
  () => {
    assert.match(model, /const stops = \['默认', \.\.\.\(hasExplicitOff \? \['关'\] : \[\]\)/, '受支持 builtin 的思考关闭是 slider 明确的离散档位，未知模型默认不冒充关闭')
    assert.match(model, /min=\{0\}[\s\S]*value=\{previewStop \?\? currentStop\}[\s\S]*aria-valuetext=/, '当前关闭或开启档位通过 slider 值和可访问描述表达')
    assert.match(model, /const strengthOffset = hasExplicitOff \? 2 : 1/, 'Provider 默认和显式关闭可各占一个独立档位')
    assert.match(model, /const enabled = index >= strengthOffset/, '关闭档位不提交开启推理')
    assert.match(model, /applySelection\(selected, enabled, effort, index === 0\)/, '默认、关闭与开启均提交真实配置')
    assert.match(model, /mode: 'disabled', effort: null/, '受支持 builtin 的关闭档位保存真实 disabled 配置')
  },
  () => assert.match(model, /useDialogFocus/, '模型浮层支持 Esc 与焦点回归'),
  () => {
    assert.doesNotMatch(`${model}\n${context}\n${store}`, /setContextMode|CONTEXT_MODES|dw-model-context-option/, '上下文由模型自动管理，不再提供三档选择')
    assert.doesNotMatch(`${model}\n${settings}\n${provider}`, /providerCapabilityOverride|contextWindowTokens/, '管理界面不提供全局窗口覆盖')
    assert.match(model, /查看本次上下文明细/, '原高级入口仍可打开上下文明细')
    assert.match(context, /按模型自动管理/, '明细显示自动管理状态')
    assert.match(context, /添加必须保留的事实[\s\S]*pinFact/, '固定事实仍可编辑')
    assert.match(context, /contextPins\.map[\s\S]*unpinContext/, '已有固定内容仍可查看及取消')
    assert.match(provider, /aria-label="手动模型上下文上限"/, '保留模型规格录入，而非全局覆盖')
  },
  () => assert.match(model, /onOpenContext/, '上下文明细从模型浮层打开'),
  () => assert.match(model, /mode: 'enabled'/, 'builtin 推理开启写入 Profile'),
  () => assert.match(model, /mode: 'disabled'/, 'builtin 推理关闭写入 Profile'),
  () => assert.match(model, /模型设置/, '自定义模型保留设置管理入口'),
  () => assert.match(model, /未配置/, '未配置模型在弹层中明确标记'),
  () => assert.doesNotMatch(model, /dw-model-reasoning-dot/, '模型入口不重复使用蓝色状态点'),
  () => assert.match(agentPreset, /SelectControl/, 'Agent 预设模板使用统一选择器'),
  () => assert.match(agentPreset, /当前内容为手动编辑/, '自定义预设保持可见且自然中文说明'),
  () => assert.doesNotMatch(agentPreset, /<select\b/),
  () => assert.doesNotMatch(provider, /<select\b/),
  () => assert.doesNotMatch(selectControl, /<select\b/, '统一选择器本身不回退原生 select'),
  () => assert.doesNotMatch(`${app}\n${composer}\n${model}\n${agentPreset}\n${sidePanel}\n${settings}\n${provider}`, /<select\b/, 'renderer 管理界面不再输出原生 select'),
  () => assert.match(sidePanel, /<GalgameStudio key=\{currentSessionId\}/, 'Galgame Studio 已接入主导航而非孤立组件'),
  () => assert.match(galgameStudio, /galgameStudioLatest\(sessionId\)/, 'Galgame 工作台离开页面后可恢复'),
  () => assert.match(galgameStudio, /chooseAssetFiles\('sprite'\)[\s\S]*chooseAssetFiles\('background'\)/, '立绘与背景使用独立选择入口'),
  () => assert.match(galgameStudio, /添加角色/, 'Galgame 素材阶段支持多人物设定'),
  () => assert.doesNotMatch(galgameStudio, /R55 WORKBENCH|STEP 0|ENVIRONMENT|ASSET MANIFEST|APPROVE PLAN|GENERATE|VERIFY/, 'Galgame 用户界面不暴露迭代号与开发标签'),
  () => assert.match(selectControl, /disabled\?: boolean/, '统一选择器支持禁用选项'),
  () => assert.doesNotMatch(composer, /className="dw-context-mode"/, '底栏不常驻上下文三档'),
  () => assert.doesNotMatch(composer, /className="modebar-btn dw-context-detail"/, '底栏不常驻上下文明细'),
  () => assert.doesNotMatch(composer, /className={`modebar-btn perm-/, '底栏不常驻权限模式'),
  () => assert.doesNotMatch(composer, /DeepSeek V4 ·/, '底栏不硬编码模型名'),
  () => assert.doesNotMatch(composer, /快速直写/, '底栏不常驻快速直写'),
  () => assert.match(composer, /className="modebar-btn modebar-attachment" aria-label="添加附件"/, '附件入口保持图标化且可访问'),
  () => assert.doesNotMatch(sidePanel, /SelectControl value=\{settings\.model\}/, '侧栏不重复模型快选'),
  () => assert.doesNotMatch(sidePanel, /SelectControl value=\{settings\.reasoningEffort\}/, '侧栏不重复推理强度快选'),
  () => assert.match(target, /LONG_TARGET_PRESETS = \[8000, 20000, 50000, 100000\]/, '长文提供常用篇幅预设'),
  () => assert.match(target, /LONG_TARGET_MAX = 2000000/, '长文篇幅上限为共享 2,000,000'),
  () => assert.match(target, /Math\.trunc\(value\)/, '长文手动目标保留精确整数'),
  () => assert.match(longform, /data-testid="long-target-input"/, '长文篇幅支持可测试数字输入'),
  () => assert.match(longform, /step=\{1\}/, '长文篇幅输入支持单字精度键盘微调'),
  () => assert.match(longform, /onKeyDown=\{\(event\) => \{ if \(event\.key === 'Enter'/, '长文篇幅输入支持 Enter 提交'),
  () => assert.doesNotMatch(sidePanel, /completionBudget|TokenMeter/, '工作台不保留重复预算与硬编码用量面板'),
  () => assert.doesNotMatch(sidePanel, /LongWriteStatus/, '侧栏不重复渲染长文状态条'),
  () => assert.match(settings, /value: 200000, label: '自动（推荐）', hint: '长文无固定上限'/, '设置明确 200K 为自动推荐'),
  () => assert.match(provider, /profileSetBindings/, '设置页继续管理 Profile binding'),
  () => assert.match(css, /appearance: none;[\s\S]*color-scheme: dark/, '原生 select 使用深色统一基线'),
  () => assert.match(css, /select option,[\s\S]*optgroup/, '原生 option/optgroup 具备深色字体基线'),
  () => assert.match(css, /\.dw-model-reasoning-panel \{[^}]*width: min\(300px, calc\(100vw - 32px\)\)/, '紧凑模型浮层保持 300px 上限及窄屏 32px 留白边界'),
  () => assert.doesNotMatch(app, /ActivityRail/, '对话不自动展开工作流侧栏'),
  () => {
    assert.match(model, /useState<'strength' \| 'models' \| 'advanced'>\('strength'\)/, '高级选项不是默认第一层')
    assert.match(model, /<button[^>]*aria-label="高级"[^>]*onClick=\{\(\) => setView\('advanced'\)\}><Icon name="settings"[^>]*\/><\/button>/, '高级图标按钮保留可访问名称及真实二级入口')
    assert.match(model, /view === 'advanced' && <div className="dw-model-reasoning-secondary" aria-label="高级运行设置"/, '高级选项仅在二级 view 中显示且有可访问名称')
    assert.match(model, /dw-model-reasoning-back[^>]*onClick=\{\(\) => setView\('strength'\)\}/, '高级和模型二级视图可返回强度第一层')
    assert.match(model, /aria-label="关闭模型与思考"[^>]*onClick=\{\(\) => setOpen\(false\)\}/, '每一层均可明确关闭')
    assert.match(model, /useDialogFocus/, '二级视图沿用 Esc 和焦点恢复语义')
  },
  () => assert.match(screenshots, /mainScrollWidth[\s\S]*mainClientWidth/, '截图脚本断言主区无横向溢出'),
  () => assert.match(screenshots, /railOverlap/, '截图脚本断言任务操作区不与右栏重叠'),
  () => assert.match(screenshots, /modelInViewport/, '截图脚本断言模型入口在视口内'),
  () => assert.match(screenshots, /assertCompactModebar/, '截图脚本断言底栏不重复显示上下文/权限/直写'),
  () => assert.match(screenshots, /r55-settings-provider-open\.png/, '截图脚本覆盖 Provider 设置展开态'),
  () => assert.match(screenshots, /r55-galgame-entry\.png/, '截图脚本覆盖 Galgame 主导航可达态'),
  () => assert.match(screenshots, /2000000/, '截图脚本覆盖篇幅上界'),
  () => assert.match(screenshots, /12345/, '截图脚本覆盖精确手动篇幅'),
  () => assert.match(screenshots, /1999/, '截图脚本覆盖篇幅下界归一化')
]

for (const check of checks) check()
console.log(`R55 UI-CONTRACT PASS ${checks.length}/${checks.length}`)
