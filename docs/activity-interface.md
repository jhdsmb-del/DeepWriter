# DeepWriter AI 实时活动界面实现指南

> 目标：实现类似 Codex / Claude Code 的实时工作状态界面，让用户清楚看到 AI 当前在做什么、已经做了什么、耗时多久、是否需要确认，以及最终产出了哪些文件。  
> 适用项目：`DeepWriter`  
> 本文是实施规格，不要求照抄某一产品的视觉样式。

## 1. 目标效果

用户发送任务后，不应只看到一个旋转图标或不断增长的大段消息，而应看到一条可折叠的实时活动时间线：

```text
● 正在工作 · 01:42                         [停止]

  ✓ 理解任务                         2 秒
  ✓ 检查项目结构                     4 秒
  ✓ 读取 7 个相关文件                8 秒
  ✓ 制定写作计划                     6 秒
  › 正在撰写第三场景……              38 秒
      已生成 2,846 / 4,000 字
  ○ 连续性检查
  ○ 保存章节

  最近活动
  14:32:08 读取 story/bible.md
  14:32:10 搜索“林晚”在最近三章中的状态
  14:32:14 更新 characters/lin-wan.json
```

命令任务则可以显示：

```text
  › 正在运行 Ren'Py lint             12 秒
      命令：renpy.exe project lint
      工作目录：<项目目录>
      输出：检查到 2 个错误、1 个警告
      [展开完整输出]
```

关键要求：

1. 所有文字都来自真实事件，不根据动画或随机定时器伪造。
2. 主进程是任务状态的唯一事实来源，renderer 只负责展示。
3. 页面刷新、切换会话或应用重启后，可以恢复任务时间线。
4. 用户能区分“思考/计划”“读取”“执行命令”“修改文件”“生成正文”“验证”和“等待确认”。
5. 不展示系统隐藏思维链。只显示简短、可验证的状态摘要，以及服务端明确返回且产品允许展示的推理内容。

---

## 2. 不要直接解析聊天文字

错误做法是从模型正文中搜索“我正在读取文件”“接下来执行命令”，再把它显示为状态。模型可能说谎、重复、被提示注入或改变措辞。

正确做法是建立独立的结构化活动事件流：

```text
DeepSeek 流 / Agent 调度器 / 文件工具 / 命令工具 / 小说导出器
                              ↓
                    Activity Event Bus
                              ↓
             持久化 Journal + IPC 实时推送
                              ↓
                    Renderer Activity UI
```

模型正文和活动事件必须分开：

- `content.delta`：最终给用户的文章/回答。
- `reasoning.delta`：provider 明确返回的 reasoning 内容，可选展示。
- `activity.message`：应用生成的简短状态，如“正在读取人物设定”。
- `tool.*`：真实工具开始、输出、完成和失败事件。
- `artifact.*`：文章、章节、脚本等产物的进度。

---

## 3. 统一事件协议

在 `src/shared/types.ts` 增加版本化协议。不要为每种模式再建立互不兼容的事件类型。

```ts
type RunPhase =
  | 'queued'
  | 'understanding'
  | 'planning'
  | 'reading'
  | 'thinking'
  | 'executing_tool'
  | 'writing'
  | 'validating'
  | 'waiting_permission'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

type ActivityEvent = {
  schemaVersion: 1
  runId: string
  sessionId: string
  seq: number                 // 同一 run 严格递增
  timestamp: number
  elapsedMs: number           // 由主进程计算
  type:
    | 'run.started'
    | 'phase.changed'
    | 'activity.message'
    | 'reasoning.delta'
    | 'content.delta'
    | 'tool.requested'
    | 'tool.started'
    | 'tool.output'
    | 'tool.completed'
    | 'tool.failed'
    | 'permission.requested'
    | 'permission.resolved'
    | 'artifact.started'
    | 'artifact.progress'
    | 'artifact.completed'
    | 'usage.updated'
    | 'run.completed'
    | 'run.failed'
    | 'run.cancelled'
  phase: RunPhase
  title?: string
  detail?: string
  payload?: ActivityPayload
}
```

常用 payload：

```ts
type ActivityPayload =
  | {
      kind: 'tool'
      toolCallId: string
      toolName: string
      safeInputSummary: string
      cwdDisplay?: string
      outputPreview?: string
      exitCode?: number
      durationMs?: number
    }
  | {
      kind: 'artifact'
      artifactId: string
      artifactType: 'chapter' | 'scene' | 'renpy' | 'document' | 'file'
      displayName: string
      completedChars?: number
      targetChars?: number
      completedItems?: number
      totalItems?: number
      relativePath?: string
    }
  | {
      kind: 'usage'
      source: 'estimated' | 'actual'
      inputTokens?: number
      outputTokens?: number
      cacheHitTokens?: number
      cost?: number
    }
  | {
      kind: 'permission'
      permissionId: string
      risk: 'low' | 'medium' | 'high'
      actionSummary: string
    }
```

注意事项：

- `seq` 比时间戳更重要。多个事件可能在同一毫秒发生，renderer 必须按 seq 排序。
- `runId` 表示一次完整任务；不能只使用 sessionId，否则同会话重试和恢复会混在一起。
- `toolCallId` 用于把 requested、started、output、completed 合并成一个 UI 卡片。
- `estimated` 与 `actual` usage 必须分开，不能相加后假装都是实际值。
- payload 先经过 schema 校验，再通过 IPC。

---

## 4. 主进程 Activity Bus

新增建议文件：

```text
src/main/activityBus.ts
src/main/runJournal.ts
src/shared/activitySchemas.ts
```

最小接口：

```ts
interface ActivityBus {
  startRun(input: StartRunInput): RunHandle
  emit(runId: string, event: NewActivityEvent): Promise<ActivityEvent>
  snapshot(runId: string): Promise<RunSnapshot>
  subscribe(listener: (event: ActivityEvent) => void): () => void
}

interface RunHandle {
  runId: string
  signal: AbortSignal
  emit(event: NewActivityEvent): Promise<ActivityEvent>
  setPhase(phase: RunPhase, title: string, detail?: string): Promise<void>
  complete(summary?: string): Promise<void>
  fail(error: StructuredError): Promise<void>
  cancel(reason?: string): Promise<void>
}
```

`emit` 必须按以下顺序工作：

1. 获取该 run 的串行锁。
2. 分配下一个 seq。
3. 计算 `elapsedMs`。
4. 先追加到 journal。
5. 再通过 IPC 推给 renderer。

这样即使 renderer 崩溃，事件也不会丢。不要先发 IPC 再异步保存。

Journal 可以先用 JSONL：

```text
<appData>/runs/<runId>/events.jsonl
<appData>/runs/<runId>/snapshot.json
```

每隔一定事件数生成一次 snapshot，避免恢复时重放几十万条 `content.delta`。正文增量最好写到单独的 artifact 文件，journal 只记录偏移量和进度。

---

## 5. 在现有 DeepWriter 中接入事件

### 5.1 `src/main/index.ts`

聊天开始时：

```ts
const run = activityBus.startRun({ sessionId, requestId })
await run.setPhase('understanding', '正在理解任务')
```

构建上下文前后：

```ts
await run.emit({
  type: 'activity.message',
  phase: 'reading',
  title: '正在整理项目上下文',
  detail: `已选择 ${fileCount} 个相关文件`
})
```

所有完成、异常和取消路径都必须在 `finally` 前产生一个终态事件。一个 run 只能有一个终态。

### 5.2 `src/main/deepseek.ts`

把当前回调扩展为结构化流事件：

```ts
type ModelStreamEvent =
  | { type: 'reasoning.delta'; text: string }
  | { type: 'content.delta'; text: string }
  | { type: 'tool.delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'usage'; usage: ActualUsage }
  | { type: 'finish'; reason: string }
```

收到 reasoning 时：

- 如果产品配置允许展示 provider 返回的 reasoning，发送 `reasoning.delta`。
- 如果不允许或模型未返回，不要编造“模型正在逐步推理”的文字；只发送应用级状态“正在分析约束”。
- reasoning 默认折叠，完成后可以只保留摘要或前后有限长度，避免 UI 和日志膨胀。

开始正文后把 phase 切换为 `writing`，不要继续显示“正在思考”。模型进入工具调用时切换为 `executing_tool`。

### 5.3 `src/main/agentTools.ts`

每个工具使用统一 wrapper：

```ts
async function runInstrumentedTool(call: ValidatedToolCall, ctx: ToolContext) {
  await ctx.run.emit({
    type: 'tool.started',
    phase: 'executing_tool',
    title: toolTitle(call.name),
    payload: safeToolPayload(call)
  })

  const started = performance.now()
  try {
    const result = await executeValidatedTool(call, {
      signal: ctx.run.signal,
      onOutput: chunk => ctx.outputBatcher.push(call.id, chunk)
    })
    await ctx.run.emit({
      type: 'tool.completed',
      phase: 'executing_tool',
      title: `${toolTitle(call.name)}完成`,
      payload: safeResultPayload(result, performance.now() - started)
    })
    return result
  } catch (error) {
    await ctx.run.emit({ type: 'tool.failed', /* structured error */ })
    throw error
  }
}
```

命令工具当前若一次性收集 stdout，需要改成边读边回调，但 UI 不应每个字节刷新。主进程以 50–100ms 为窗口批量发送，或者累计到一行再发送。

### 5.4 `src/main/novel.ts`

小说/文章任务不能只显示“生成中”。应发布 artifact 事件：

```text
artifact.started：开始撰写《第三章》；目标 8,000 字
artifact.progress：完成第 1/4 场景；2,140 / 8,000 字
activity.message：正在检查人物状态和伏笔
artifact.progress：完成第 2/4 场景；4,263 / 8,000 字
artifact.completed：已保存 chapters/003.md
```

字数进度从实际已提交正文计算，不要从 Token 或动画估算。目标未知时显示“已生成 2,140 字”，不要显示虚假百分比。

### 5.5 `src/main/galgame.ts`

建议阶段：

```text
扫描脚本 → 建立分支图 → 生成/修改脚本 → Ren'Py lint → 修复 → 再次 lint → 完成
```

lint 命令输出按诊断数量汇总，默认只展示最近 10–20 行；完整输出按需展开。执行命令前先显示等待权限状态，用户批准后再切换为正在执行。

---

## 6. IPC 与 preload

只暴露最小订阅接口：

```ts
interface ActivityApi {
  subscribe(listener: (event: ActivityEvent) => void): () => void
  getSnapshot(runId: string): Promise<RunSnapshot>
  cancel(runId: string): Promise<Result>
  pause(runId: string): Promise<Result>
  resume(runId: string): Promise<Result>
}
```

安全要求：

- 主进程验证 IPC sender、run 所属 session 和 schema。
- renderer 不能自行发送 `tool.completed` 或改变主进程 phase。
- IPC 中不传 API key、完整环境变量、未脱敏命令输出或任意绝对路径。
- renderer 收到 seq 缺口时调用 `getSnapshot`，不能猜测遗漏状态。
- 取消请求必须幂等；重复点击停止不能产生多个终态。

---

## 7. Renderer 状态管理

在 store 中按 run 保存归一化状态，不要把每个增量都塞进聊天消息并复制整个数组：

```ts
interface RunViewState {
  runId: string
  status: RunPhase
  startedAt: number
  lastSeq: number
  currentTitle: string
  steps: ActivityStep[]
  toolsById: Record<string, ToolActivity>
  artifactsById: Record<string, ArtifactActivity>
  reasoningTail: string
  outputRef?: ArtifactReference
  usage?: UsageView
  terminal?: RunTerminalState
}
```

事件 reducer 必须幂等：

```ts
function reduceActivity(state: RunViewState, event: ActivityEvent) {
  if (event.seq <= state.lastSeq) return state
  if (event.seq !== state.lastSeq + 1) return { ...state, needsResync: true }
  // 按 event.type 更新对应实体
}
```

耗时显示不需要主进程每 100ms 发事件。renderer 根据 `startedAt` 用本地 interval 更新视觉计时器；主进程只在真实事件中提供最终 duration。页面不可见时暂停 UI ticker，任务本身不暂停。

正文增量也要批量更新。建议每 50–100ms 或 200–500 字刷新一次视图，最终内容写在文件/块存储中；否则长文章会重复复制大字符串。

---

## 8. 推荐组件结构

```text
ActivityCard
├─ RunHeader
│  ├─ StatusIndicator
│  ├─ ElapsedTime
│  └─ StopPauseControls
├─ CurrentActivity
├─ ProgressBar（只有存在真实总量时显示）
├─ ActivityTimeline
│  ├─ PhaseStep
│  ├─ ToolStep
│  ├─ PermissionStep
│  └─ ArtifactStep
├─ ReasoningDisclosure（可选、默认折叠）
├─ ToolOutputDisclosure
└─ UsageFooter
```

建议新增文件：

```text
src/renderer/src/components/activity/ActivityCard.tsx
src/renderer/src/components/activity/ActivityTimeline.tsx
src/renderer/src/components/activity/ToolActivityRow.tsx
src/renderer/src/components/activity/ArtifactProgress.tsx
src/renderer/src/components/activity/ReasoningDisclosure.tsx
src/renderer/src/components/activity/ElapsedTime.tsx
```

### 展示规则

- 当前步骤使用轻微动态指示，已完成用勾，等待用空心圆，失败用明确错误图标。
- 不要让每个文件读取都占一条永久大卡片。连续同类事件聚合为“读取 7 个文件”，展开后再看明细。
- 当前步骤只保留一项主状态，例如“正在撰写第三场景”；下面可以附最近工具活动。
- 权限等待必须抢占主状态并明确需要用户操作。
- 完成后折叠为一行摘要：“完成 · 2 分 18 秒 · 修改 3 个文件 · 生成 8,214 字”。
- 失败要显示发生阶段、已保留成果、能否重试，而不是只写“Error”。
- 动画尊重 `prefers-reduced-motion`；状态不能只靠颜色表达。

---

## 9. “思考中”应该显示什么

这里最容易实现错误。

### 可以显示

- 应用能够验证的阶段：“正在分析用户要求”“正在整理人物状态”“正在比较分支条件”。
- 模型主动调用工具的意图摘要：“需要读取最近两章以检查连续性”。
- provider 明确返回并允许展示的 `reasoning_content`，放在可折叠区域，并做好长度限制、脱敏和持久化策略。
- 完成后的简短工作摘要：“检查了 7 个文件，发现 2 处人物年龄冲突”。

### 不应显示

- 系统内部隐藏 chain-of-thought。
- 为了让界面看起来忙而定时生成的虚假步骤。
- 没有实际发生的“正在搜索”“正在执行”。
- 密钥、完整系统 prompt、环境变量、个人绝对路径或未过滤命令输出。
- 把模型的自然语言自述当作已经执行的事实。

如果 DeepSeek thinking 未返回可展示 reasoning，可只显示状态摘要和耗时。透明不等于暴露每一个内部推理 Token。

---

## 10. 状态机约束

建议使用显式转换表，不允许组件随意赋值：

```text
queued → understanding
understanding → planning | reading | thinking | writing
planning/reading/thinking → executing_tool | writing | waiting_permission
waiting_permission → executing_tool | cancelled | failed
executing_tool → thinking | writing | validating | failed
writing → thinking | executing_tool | validating | completed
validating → writing | executing_tool | completed | failed
任何活动状态 → paused | cancelled | failed
paused → 原先状态 | cancelled
completed/cancelled/failed → 不允许继续转换
```

额外不变量：

1. 每个 run 只能有一个 current phase 和一个终态。
2. 工具 `completed/failed` 必须对应已有 `tool.started`。
3. artifact 进度不能倒退，除非事件明确表示重新生成并创建新 artifact version。
4. `completedChars` 不得超过实际文件字符数。
5. run 已取消后，迟到的模型 chunk 和工具输出只能记入诊断日志，不能重新改变 UI 为运行中。

---

## 11. 性能和日志控制

- reasoning/content/tool output 均批量发送，目标 UI 更新频率不超过约 10–20 次/秒。
- tool output 设内存上限，例如只保留首部、尾部和总字节数；完整日志写文件。
- timeline 默认最多渲染最近若干项，历史部分虚拟化。
- 同类 `read_file`/`search` 事件在 500ms 窗口内聚合。
- 敏感信息过滤在主进程完成，不能依赖 CSS 隐藏。
- 日志持久化设项目级上限、过期清理和导出诊断包功能。
- 生成中的 Markdown 暂按纯文本显示，完成后再异步渲染。

---

## 12. 错误与权限 UX

权限状态示例：

```text
需要你的确认
AI 希望运行 Ren'Py lint
程序：<已验证的 Ren'Py SDK>/renpy.exe
目录：当前 Galgame 项目
影响：读取脚本并生成 lint 日志，不应修改项目文件
[允许一次] [拒绝]
```

错误状态示例：

```text
生成在“保存第三场景”阶段失败
原因：磁盘空间不足
已保留：前两个场景，共 4,263 字
[更换保存位置] [释放空间后重试] [导出已完成内容]
```

不要把“模型接口超时”“用户取消”“权限拒绝”“命令退出码非 0”“文件写入失败”都归为一个通用 error。

---

## 13. 测试要求

### Reducer/协议测试

- 重复事件不会重复增加步骤。
- 乱序/缺 seq 会触发 snapshot 同步。
- 工具 output 在 completed 之后迟到不会恢复运行状态。
- 同一个 run 只有一个终态。
- estimated usage 不会与 actual 重复累计。

### IPC 集成测试

- 主进程事件能经 preload 到达 renderer。
- sender 不合法、schema 错误、其他 session 的 runId 被拒绝。
- renderer 重载后通过 snapshot 恢复相同状态。
- 切换会话不会把事件显示在错误任务中。

### 真实流程测试

1. 普通聊天：thinking→writing→completed。
2. 文件任务：reading→permission→tool→writing。
3. 命令任务：批准/拒绝、stdout、非零退出、超时、取消。
4. 长文章：字数进度、暂停、恢复、重启恢复和保存失败。
5. Ren'Py：扫描、lint、修复、再次 lint。
6. 网络在 reasoning、正文、工具调用参数和 usage 尾帧阶段分别断开。
7. 10 万字输出下 UI 仍能及时响应 Stop，不能因每 chunk 重渲染卡死。

### 验收指标

- 真实事件到 UI 的中位延迟低于 150ms。
- Stop 点击后 500ms 内界面进入“正在停止/已取消”，后台操作收到 abort。
- 任务重启恢复后步骤、耗时和产物进度一致，不重复执行工具。
- 无任何虚假百分比；没有总量时只显示已完成量。
- 命令、文件和权限事件可追溯，但日志中不存在 API key 和敏感环境变量。
- 长任务的 UI 更新频率受控，内存不会随每个流 chunk 产生完整正文副本。

---

## 14. 推荐实施顺序

### 第一步：事件协议和只读活动卡片

- 添加 `ActivityEvent`、`runId`、`seq` 和主进程 bus。
- 将聊天 phase、模型 content/reasoning、工具开始/完成映射为事件。
- UI 先实现当前状态、耗时、步骤列表和停止按钮。

### 第二步：持久化、重连和命令输出

- JSONL journal、snapshot 和 seq 缺口恢复。
- 工具 stdout/stderr 批量流式显示。
- 权限 requested/resolved 与工具卡片关联。

### 第三步：文章和 Ren'Py 领域进度

- artifact 事件、实际字数、场景/章节进度。
- Ren'Py 扫描/lint/修复阶段和诊断统计。
- 完成摘要和产物链接。

### 第四步：性能与故障测试

- 聚合、虚拟化、纯文本流和日志上限。
- 重载、重启、断网、取消、超时、磁盘失败和 10 万字压力测试。

---

## 15. 给后续开发 AI 的执行清单

1. 先修复主审计报告中的 IPC、安全和长输出问题；活动界面不能成为不安全工具的漂亮包装。
2. 在 `shared` 定义并验证事件 schema，主进程产生事实事件，renderer 不推断任务事实。
3. 为每个 run 实现 seq、journal、snapshot、AbortController 和唯一终态。
4. 改造 `deepseek.ts` 和 `agentTools.ts`，让 reasoning、正文、工具生命周期和输出进入统一 bus。
5. 新建 ActivityCard/Timeline/ToolRow/ArtifactProgress，使用批量更新和虚拟化。
6. 对命令参数、路径、环境变量和输出做脱敏；权限请求必须显示真实影响。
7. 小说和 Ren'Py 使用 artifact/phase 事件展示实际场景、字数、lint 和保存进度。
8. 加入乱序、重连、取消、迟到事件、10 万字和错误恢复测试。

最终产品应给用户一种可靠的感觉：不是“AI 在神秘地想”，而是“系统正在执行一组可以验证、可以停止、可以恢复、结果可追踪的工作”。这才是 Codex/Claude Code 类活动界面的核心价值。
