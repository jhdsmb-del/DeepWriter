# DeepWriter v1.2.3 Beta · 构建与制品记录

- 发布状态：Beta，等待独立验收
- 源码提交：`660bb9f0d92ed1c74276915d8c25fce8c41d1d6a`
- 目标平台：Windows x64
- 记录时间：`2026-09-04T10:53:11.8790747Z`
- `package.json` SHA-256：`4317B630FBD684343F46FB8B199A27587F1ACBA7F2CA9751AA8B27F217A5A134`
- `package-lock.json` SHA-256：`7DA1CE7E610767768330C0A943C6A496D1295AA50BB04C2C35A0D5C69B86B6AF`

## 发布门

- `release:candidate:fast`：26/26
- `verify`：326/0
- `ui:contracts`：44/44
- `e2e`：66/0
- `e2e:r43`：15/0
- `e2e:r45`：21/0
- `e2e:r46:g5`：28/0
- ASAR 检查：6/6，敏感项 0

## 制品

| 文件 | 字节 | SHA-256 | PE 版本 | 签名 |
|---|---:|---|---|---|
| `DeepWriter-1.2.3-x64-setup.exe` | 132125192 | `9D951F35C263926CE9ED2A1BA9DDA716A1DE883780D1CBE82F9F5C3AFB1B6CC1` | 1.2.3 | NotSigned |
| `DeepWriter-1.2.3-x64-portable.exe` | 131832081 | `FFB1A85FEEEE00B4C9E6FEF8E50236187F082EDF51906BE954114DF4E7DCAA34` | 1.2.3 | NotSigned |
| `win-unpacked/resources/app.asar` | 135191522 | `BAA1821F761C428D5511A13A4C635363EA8A390FBA62497C81FFBFF3E851DC8C` | package 1.2.3 | 不适用 |

## 未完成项

本记录不能代替真实 Provider 长时间写作、两小时 soak、干净 Windows VM 安装/升级/卸载、NVDA、ARM64 或商业代码签名验证。它只把当前源码、锁文件和本地构建制品绑定到可复算的哈希。
