# 参与开发

先阅读 [README](README.md) 与 [架构说明](docs/TECHNICAL_OVERVIEW.md)。项目当前以 Windows 桌面发行作为支持目标，macOS 与 Linux 参与源码回归。

## 环境

- Node.js 22.13+，npm，Git。
- `npm ci` 安装锁定依赖，`npm run dev` 启动桌面应用。
- Linux 桌面测试需要 Electron 系统库、显示服务（可用 Xvfb）和可用的 Secret Service 凭据存储。
- 受限容器确实需要关闭 Chromium 沙箱时，可对测试进程设置 `DW_E2E_NO_SANDBOX=1`；这是测试启动选项，不用于发行应用。Linux 可通过 `DW_E2E_PASSWORD_STORE=gnome-libsecret` 明确选择已启动的凭据服务。

## 验证

```bash
npm test
npm run check
npm run e2e
```

`npm test` 是日常基础回归；`check` 还运行权限、数据库、其他常规门禁与生产构建。两者使用本地模拟模型，不需要真实 Key。

按变更范围运行针对性检查，例如：

| 变更 | 检查 |
| --- | --- |
| 文件与命令 | `test:agent`、`gate1`、`r42p`、`r41c` |
| 恢复与长文 | `r52:reliability`、`wp6:workflow-authority`、`r74:longform-workflow-recovery` |
| UI、草稿与设置 | `test:composer`、`test:drafts`、`test:stream`、`ui:contracts`、`r54:ui`、`r55:ui`、`e2e` |
| 发行 | `dist`、发行制品检查、Windows 安装/升级/退出与数据保留 |

保留针对历史修复的 `rXX` 和 `wpX` 命令，方便定位问题；新增常规检查优先接入统一入口。报告实际执行的平台、结果与跳过项。真实 API 评测会收费，需单独配置，不属于默认检查。

## 发布 Beta

同步 `package.json` 与 `package-lock.json` 的版本，编写对应的 `docs/RELEASE_NOTES_<版本>.md`，完成常规与 `release:candidate:fast` 检查。正式签名资源与 Windows 预检通过后再推送版本标签；标签必须与应用版本一致，例如 `v1.3.0`。

先推送 `release/<标签>` 分支，例如 `release/v1.3.0`，在 Windows 上完整预检。预检分支允许标明未签名的测试制品，只有通过正式签名和安装验收的版本标签会触发公开发布。

`Windows Release` 工作流检查源码、构建安装版与免安装版、扫描 ASAR，并对实际打包程序执行完整桌面回归、安装、升级和卸载检查。正式版本还验证受信任发布者和时间戳，生成 SBOM、签名与安装报告及 SHA-256，先上传到草稿 Release，再公开发布；失败不会公开不完整制品，也不会覆盖已发布版本。资源配置见 [Windows 签名](docs/WINDOWS_SIGNING.md)。

构建证据在 Actions 中，最终结果同时写入 `release-status/<标签>` 分支的 `release-status.json`。这份记录区分构建、签名、安装与发布结果，不把推送标签等同于发布成功。真实 Provider 与人工系统验收仍独立记录。

## 修改原则

- 聚焦可复现的问题，说明触发条件与改进后的行为。
- 保留 IPC、路径、授权、凭据和恢复边界。
- 修复行为应有有意义的回归验证；文案等低影响修改无需制造镜像测试。
- 旧 UI 被移除时，把断言迁移到当前工作流，不用删掉断言换取通过。
- 不提交用户数据、Key、安装包、临时日志、源码拼接或生成的测试报告。

PR 说明应包含具体问题、最终行为和验证结果；有未通过或未执行的关键检查时如实注明。项目自有代码采用 [MIT](LICENSE)；新增第三方代码或素材时保留原有许可与来源，提交前请阅读[许可决定](docs/LICENSE_DECISION.md)。
