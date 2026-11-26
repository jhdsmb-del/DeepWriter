# DeepWriter v1.2.5 Beta

> Windows x64 · prerelease / Beta · 不是稳定版，也不是 RC、released 或 1.0

v1.2.5 是面向 Windows x64 的 Beta 文档冻结版本。稳定版仍为 [v1.1.2](https://github.com/qlys123/DeepWriter/releases/tag/v1.1.2)。本说明只描述当前工作区已经落地的入口和边界，不把 synthetic 检查或代码路径写成真实 Provider 质量结论。

## 主要变化

- 长文工作流：Grill Me 逐轮补齐需求，确认大纲和篇幅后按场景写作；短轮可自动续写，任务保留检查点和恢复入口。
- 工作流可视化：查看当前阶段、模型输出、工具/文件产物、账单、Token 与耗时；后台可打开悬浮进度窗。
- 模型配置：选择模型和思考强度，支持上下文完整/优化/精简档位；支持自定义 Provider、地址、认证 Header 和模型。
- 上下文与提示词：上下文优化保留来源清单、摘要和最近窗口；可为固定写作习惯配置预设提示词。
- Galgame / Ren'Py：导入或创建工程、整理素材清单、用 Grill Me 确认故事和分支、生成剧情节点、查看修复提案并运行 Ren'Py lint。
- 实验开关：叙事增强（仅 WP7 Phase0–3）实验能力保留且默认关闭，开启后只写入新任务的配置快照；WP7 Phase4A/Phase4B 自动剧情重定向已标记 `EXCLUDED_CLEAN`，不包含在 v1.2.5 Beta。角色监护也默认关闭，且只影响新建任务。

这些能力改善的是流程可见性、可恢复性和配置边界；本版本不宣称生成质量胜过任何主流模型或 Provider。

## 升级与数据保留

- 从旧版本升级前请备份重要稿件、Ren'Py 工程和自定义素材。
- 安装版和便携版默认使用 `%APPDATA%\DeepWriter` 保存会话、设置和运行记录；升级不会主动删除这些数据。
- 已有任务不会被实验开关改写；叙事增强/角色监护的设置只对新建任务生效。
- 如果需要隔离测试 Beta，可先导出/复制项目文件，再使用独立的测试目录或便携版。

## 已知边界与验证状态

- 发布目标只有 Windows x64；没有 macOS、Linux 或 ARM64 安装包。
- Beta 不是稳定版；真实 Provider、费用、速率、上下文上限和生成质量取决于你的账号与配置。
- Windows x64 安装版与便携版已于 2026-10-01 从提交 `4162ff5` 构建；文件大小和 SHA-256 见 [`RELEASE_METADATA_1.2.5.md`](RELEASE_METADATA_1.2.5.md)。
- 安装包当前为 unsigned / 未提供商业代码签名，Windows 可能显示 SmartScreen 或其他安全提示；请从可信来源获取并核对制品信息。
- 独立桌面 E2E 为 68/0；完整组合门禁最后一次运行停在附件预览等待的时序抖动，因此没有宣告整套门禁全绿。

| 检查项 | 状态 |
| --- | --- |
| 真实 Provider 请求 | `not_run` |
| 真实质量 benchmark | `not_run` |
| blind review | `not_run` |
| 2h soak | `not_run` |
| clean install / upgrade / uninstall 矩阵 | `not_run` |
| NVDA 人工验收 | `not_run` |
| 商业代码签名 / Authenticode | `not_run` |

在上述检查完成前，请把本版本当作测试版本使用；不要仅凭本地 mock、单元测试或文档状态推导真实模型质量、安装兼容性或签名可信度。
