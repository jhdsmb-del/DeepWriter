# DeepWriter 1.2.0

> **已暂停稳定版推荐。** 本版本存在长文目标字数已满但场景条件未满足时持续发起模型请求的风险，可能造成大量无效付费调用。请勿在真实付费 API 上运行 1.2.0 长文模式；等待 1.2.1 热修。

1.2.0 是面向 Windows x64 的桌面发布候选，重点补齐模型接入和长文上下文能力，同时保留已有的可确认写作流程。

## 主要变化

- 增加 OpenAI Responses 与 Anthropic Messages 原生协议适配；同时提供 Gemini、xAI、Qwen、GLM、Mistral、SiliconFlow 的官方兼容预设。
- 支持自定义 Provider：可选择协议、服务地址、模型和认证 Header；密钥仍通过凭据引用管理，不写入导出配置。
- 增加证据绑定的叙事状态账本与分层上下文物化，为长文续写提供可复算的角色、关系、知识、伏笔和时间线信息。
- 继续提供 Grill Me、大纲确认、分场景长文、上下文优化、账单明细和 Galgame / Ren'Py 工作流。
- Windows 安装版与 portable 版统一使用应用内图标；本版本不含商业代码签名。

## 下载与使用

- `DeepWriter-1.2.0-x64-setup.exe`：安装版。
- `DeepWriter-1.2.0-x64-portable.exe`：免安装版。

启动后进入“设置 → 模型与接口”，添加 Provider 和 API Key，再选择模型。真实模型的能力、价格和上下文上限由你配置的服务商决定。

## 本机候选制品

构建目录：`dist-1.2.0-final`；平台：Windows x64；Electron：43.3.0；electron-builder：26.15.3。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `DeepWriter-1.2.0-x64-setup.exe` | 132,162,591 | `b52be07ddc5d1c701b2ac74b727e14cf43422ae24b07bcdbc6bf646aebca6dcd` |
| `DeepWriter-1.2.0-x64-portable.exe` | 131,869,419 | `202be24688c31f62f631085bef5e7d7aa19937c53bcf32a357b1d8e5bb19de00` |
| `win-unpacked/DeepWriter.exe` | 225,459,712 | `815cd8d5e64f51897521696c313e401ceee2257266f0d48ea5bbca037da77dad` |
| `win-unpacked/resources/app.asar` | 134,887,192 | `51570624bd979135d0fe82064bb59a2f12fa5518d94d3250a3e07693f8987454` |

主程序 PE 版本为 `1.2.0`（ProductVersion `1.2.0.0`）。安装版和 portable 版均为未签名构建。

## 验证边界

本候选在本机完成 typecheck、build、provider 合约测试、叙事上下文测试和 Windows x64 制品检查。未签名、真实付费 API 基准、安装/卸载人工矩阵、NVDA 和 ARM64 仍未宣称通过。
