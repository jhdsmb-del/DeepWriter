# DeepWriter 开发约定

DeepWriter 是 Electron 桌面 Agent。主流程是 Agent、长文与任务中心，风格和 Galgame 是按需加载的创作工具。先保持可靠性、明确状态和简单入口，再增加能力。

## 环境与检查

使用 Node.js 22.13+ 与 npm；执行 `npm ci` 安装锁定依赖。

- `npm run dev`：桌面开发。
- `npm test`：日常基础回归。
- `npm run check`：类型、常规回归、文档检查与生产构建。
- `npm run e2e`：真实 Electron 界面，使用本地模拟模型，需要图形环境和系统凭据存储。
- `npm run dist`：Windows 发行构建，安装与签名需单独验证。

按修改范围补充恢复、权限、长文或 Provider 的针对性测试。测试失败要诊断行为；不删除断言来掩盖错误。旧界面断言应迁移到实际可达的工作流。

## 核心路径

| 路径 | 职责 |
| --- | --- |
| `src/main/jobs/AgentRunEngine.ts` | 运行编排与恢复 |
| `src/main/agentTools.ts` | 文件/搜索/命令工具与授权 |
| `src/main/commandProcess.ts` | 子进程、取消、超时和输出边界 |
| `src/main/agentFiles.ts` | 有界读取与原子写入 |
| `src/main/permissions.ts` | 权限决策与审计 |
| `src/main/db/` | SQLite 存储与迁移 |
| `src/main/providerRegistry.ts` | Provider 与加密凭据 |
| `src/main/index.ts` | 窗口生命周期与 IPC 接线 |
| `src/preload/index.ts` | `window.ds` 白名单桥 |
| `src/renderer/src/store.ts` | UI 状态与事件投影 |
| `src/shared/` | 跨进程类型、事件和纯函数 |

## 实现约束

- TypeScript strict；UI 文案使用中文。跨进程契约变化同步 main、preload 和 renderer。
- Renderer 通过 `window.ds` 调用主进程；不得直接获得 Node 或任意 IPC 能力。
- 主进程验证 IPC sender、输入 schema 与路径授权，向 UI 返回可解释的失败状态。
- 文件操作保留真实路径边界、授权和写前快照；写入避免留下半个文件。
- 命令以参数数组执行，保留权限策略；取消应终止子进程树，取消与超时分别记录。
- 运行恢复使用持久化事件与冻结配置，不以 Renderer 临时状态判断成功。未知副作用不得自动重放。
- Key 不进入日志、截图、测试制品或 Renderer 返回值；凭据存储失败时保留拒绝行为。
- 测试覆盖可观察行为与故障边界，报告 PASS、FAIL 和平台跳过；不把模拟模型视为真实质量验收。
- 当前文档放在 `docs/`；临时交接稿、源码拼接与测试原始输出保存在忽略目录或 CI artifacts，历史材料通过 Git 查阅。

新增功能需有可达的入口、真实数据与可解释的状态。优先合并重复流程，避免再次出现两个配置面板、两套进度或独立的恢复事实源。

日常界面优先显示用户输入与回复，工具细节按需展开。动画短且可中断，不随流式更新重新启动，尊重系统减少动态效果。未发送草稿属于会话，异步附件结果不得跨会话串入；设置仅提交修改字段并保留主进程的规范化结果。
