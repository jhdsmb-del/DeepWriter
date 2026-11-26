# DeepWriter v1.2.4 · 制品元数据

> Beta · Windows x64 · 仅记录制品事实，不代表稳定版或正式发布声明

## 核验基线

- 核验目录：`dist-1.2.4-final`
- 当前 Git HEAD：`9fc59fe95490436b6cf902592db45434eef2bc8d`
- 应用包版本：`1.2.4`（从 `app.asar/package.json` 读取）
- Electron：`43.3.0`（项目依赖与本次构建包配置）
- 目标架构：Windows x64

## 制品清单

| 制品 | 相对位置 | 绝对位置 | 字节数 | SHA-256 | PE 文件版本 | Authenticode |
| --- | --- | --- | ---: | --- | --- | --- |
| 安装版 EXE | `dist-1.2.4-final\DeepWriter-1.2.4-x64-setup.exe` | `dist-1.2.4-final\DeepWriter-1.2.4-x64-setup.exe` | 132130401 | `9033494F9A1140D10F285B6CEE3A5C1DD9D9072FCF1C772B71022A926F851D9E` | `1.2.4` | `NotSigned` |
| 便携版 EXE | `dist-1.2.4-final\DeepWriter-1.2.4-x64-portable.exe` | `dist-1.2.4-final\DeepWriter-1.2.4-x64-portable.exe` | 131837232 | `C50C9C4C9C8663834288B9468A7981732DCD426DE5B4FC7213F5B4F61F26E1CA` | `1.2.4` | `NotSigned` |
| 解包运行时 ASAR | `dist-1.2.4-final\win-unpacked\resources\app.asar` | `dist-1.2.4-final\win-unpacked\resources\app.asar` | 135230022 | `9C3F234587F60A2D768C6BF31552AC016255A19A8B3AF0035A2CF962F9128A2F` | 不适用 | 不适用 |

`app.asar` 内的 `package.json` 已核对为 `deepwriter@1.2.4`，入口为 `out/main/index.js`。ASAR 不是 PE 文件，不适用 PE 文件版本和 Authenticode 字段。

## 签名与使用风险

两个 EXE 当前均为 `NotSigned`，没有可供 Windows 验证的 Authenticode 签名；首次运行时可能出现 SmartScreen 或其他安全提示。请只从可信来源获取文件，核对上表 SHA-256，并先在可恢复的测试目录中试用和备份稿件。

## 本记录的测试边界

本次只读核验了文件存在性、字节数、SHA-256、EXE PE 文件版本、Authenticode 状态、ASAR 内应用版本和构建目标信息；没有在本次核验中运行全量回归或启动桌面应用。因此以下事项不能由本记录推出：

- 真实 Provider 请求、真实写作质量、费用或长时间 soak；
- 干净多机环境的安装、升级、卸载和恢复；
- UAC、SmartScreen、NVDA、ARM64 或其他平台验证；
- 商业代码签名与签名后制品复核。

该版本保持 Beta 状态，未宣告 RC、released 或 1.0。

