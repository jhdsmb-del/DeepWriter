# DeepWriter 1.0.0 发行说明

## 状态

源码、发布元数据和 Windows x64 最终制品均已切换到 `1.0.0`；本文件已记录最终制品 hash、ASAR、SBOM 和当前安装矩阵状态。旧的 0.2.0 包不作为 1.0.0 分发。

## 面向用户的变化

- Windows 桌面长文写作：需求梳理、分阶段生成、停止/继续和失败恢复。
- Grill Me：逐项确认写作目标、人物、结构、素材和边界；大纲经用户确认后才启动正文。
- 工作流与悬浮状态窗：显示当前项目、阶段、动作、耗时和 Token 用量。
- 上下文模式：完整、优化、精简；优化模式减少长对话重复发送，同时保留固定事实和必要来源。
- Provider/模型配置：内置 DeepSeek，并支持受控的兼容 OpenAI Chat Provider、模型导入与阶段配置。
- 项目能力：人物/情节管理、风格参考、Ren'Py 工作流、文档导出和本地项目文件。

## 发布形态与数据兼容

- 目标平台：Windows x64。
- NSIS：`DeepWriter-1.0.0-x64-setup.exe`。
- portable：`DeepWriter-1.0.0-x64-portable.exe`。
- 两种版本均使用 ASAR；安装/升级不把用户数据放入制品，Electron userData 默认位于 `%APPDATA%\DeepWriter`。
- `appId=com.deepwriter.app` 保持不变，覆盖安装沿用同一 userData 位置。
- NSIS `deleteAppDataOnUninstall=false`；卸载默认保留 userData。SQLite 启动迁移为版本化、事务式，兼容旧的 0.2.x 数据库结构；旧 `deepseek-studio` 目录仅在新目录没有设置文件时尝试迁移。

## 发布门禁状态

| 门禁 | 1.0.0 状态 | 说明 |
|---|---|---|
| `npm run release:metadata` | `pass` | 源码版本、appId、ASAR、文件白名单、NSIS/portable 名称和 userData 保留策略已核对 |
| `typecheck` / `build` | `pass` | 在最终产品/UI 冻结 HEAD 上复跑，均 exit 0 |
| `release:asar` | `pass (6/6)` | 最终 `dist/win-unpacked/resources/app.asar` 精确扫描通过，敏感项 0 |
| `release:sbom` | `pass` | 最终 package-lock 对应生成；生产依赖 14、开发依赖 13，unknown 0 |
| NSIS 安装/覆盖/卸载矩阵 | `not_run_requires_owner` | 需要真实 Windows UAC/安装器到场验证；不以静默脚本代替 |
| portable 启动/退出矩阵 | `pass (manual smoke)` | 最终 portable 已启动并自然退出，精确捕获的新 DeepWriter PID 退出后为 0 |
| 真实 API 基准 / 2h soak | `not_run_requires_owner` | 不在无人值守阶段读取真实 Key 或发请求 |
| NVDA / ARM64 | `not_run_requires_owner` | 当前发布目标仅 Windows x64 |
| 代码签名 / SmartScreen | `not_configured` | 不伪造签名；未签名制品可能显示未知发布者 |

## 最终 Windows x64 制品与复核记录

本轮构建源 HEAD：`8a03c5930bf8e79df4b7e1fcd5af84dce26c6e4e`；产品/UI 冻结基线为同一提交（包含附件 IPC 字段修复）。构建时间以 `dist/latest.yml` 的 `releaseDate` 为准：`2026-08-27T09:09:54.487Z`。以下路径均相对于项目根目录，实际制品未提交 Git：

| 文件 | 类型 | 字节数 | SHA-256 | 版本/签名 |
|---|---|---:|---|---|
| `dist/DeepWriter-1.0.0-x64-setup.exe` | NSIS 安装包 | 131,818,051 | `6d646faf9756380ae8f0f214beaf9dc73b760601a1609e0537e3b83e01d511fa` | 1.0.0 / `NotSigned` |
| `dist/DeepWriter-1.0.0-x64-setup.exe.blockmap` | NSIS 更新 blockmap | 138,532 | `7b595ec7cc1a52f1db1675853f72c2e9b430dbe3e75ff8f33282a6352531ef2f` | — |
| `dist/DeepWriter-1.0.0-x64-portable.exe` | portable 单文件 | 131,588,055 | `4b241ffaeb13e166bdf95d998c9c791a94b3abc4b6fa69b334e35c3d8b868a06` | 1.0.0 / `NotSigned` |
| `dist/win-unpacked/DeepWriter.exe` | unpacked x64 主程序 | 225,441,792 | `925ce6bf81686938b6bef86b0002eff1b41999121fb4bf6800d10f99cede71d8` | 1.0.0 / `NotSigned` |
| `dist/win-unpacked/resources/app.asar` | 最终 ASAR | 134,362,182 | `42d4e6b303b629f747c597405c8c0fc7df41d932cdba45e63fc70b03dbe0cbfa` | — |
| `dist/latest.yml` | 更新元数据 | 357 | `e3f673133229cc4eb2d7ffa6aeb96ef07c0f99d84e92c7e4202033c5bdcbb6b6` | version 1.0.0 |

最终复核结果：`release:asar` exit 0（6/6）；R52 reliability 18/0；R51 context capability 10/0；UI contracts 44/44；unpacked 启动/标题/ASAR renderer/自然退出通过（PID 44148 退出后无残留）；portable 启动并显示窗口、自然关闭后新捕获 DeepWriter PID 为 0；最终包 R51 Grill H 为 29/0（本地 synthetic SSE，11 个请求，0 次真实 API）；附件 packaged-like 主路径 `callCount=1`、附件正文到达且无拒绝占位、自然退出 exit 0。`Get-AuthenticodeSignature` 对 setup、portable、unpacked 均为 `NotSigned`，因此 SmartScreen/UAC 与安装、覆盖、卸载仍不宣称通过。

## 构建与复核顺序

最终 HEAD 固定后，在 Windows 上依次执行：

```bash
npm ci
npm run release:metadata
npm run typecheck
npm run build
npm run dist
npm run release:asar -- --dir=dist
npm run release:sbom
```

随后对 `dist/` 中的 NSIS 和 portable 制品做干净安装、覆盖 0.2.x、启动、退出、卸载后 userData 保留检查，并将实际文件大小、SHA-256、Electron/electron-builder 版本和结果写入本文件或独立证据。任何签名、SmartScreen、真实 API 或人工可访问性结论都必须按实际执行结果记录。

## 已知限制

- 当前只承诺 Windows x64；ARM64、macOS、Linux 未纳入本版制品承诺。
- 制品无代码签名；SmartScreen 提示是预期行为，不能通过配置假装消失。
- 真实模型质量、费用和长时间稳定性取决于用户配置的 Provider；未运行真实 Key 的结果只算 synthetic，不能写成真实基准。
- 项目许可仍需由所有者确认，未经授权不要重新分发。
