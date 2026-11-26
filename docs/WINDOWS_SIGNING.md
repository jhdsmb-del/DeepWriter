# Windows 发行与可选签名

`release/v<版本>` 分支用于发行预检，`v<版本>` 标签用于正式发行；两者必须与应用版本一致。正式版默认允许未签名，不会因此跳过安全扫描、实际安装升级与卸载保留、源码身份和制品哈希验证。已有公开发行版不会被覆盖。

`release.json` 如实记录 `unsigned` 与发布者；未签名版本不声明已验证发布者。只有显式设置 `DW_REQUIRE_SIGNING=1` 才强制要求签名。选择签名模式或提供签名报告时，发布者、信任校验、时间戳与对应制品哈希仍须真实通过，不能用“可选”忽略失败的签名证据。

签名需要发布者身份已验证的服务或证书。自签名证书、Git 提交签名和 SHA-256 校验值不等于 Windows 代码签名。当前仓库提供以下两种构建配置；硬件令牌需要可访问该令牌的 Windows Runner，不能通过云端托管 Runner 自动替代。

## Azure Artifact Signing

仓库 Actions Variables：

| 名称 | 内容 |
| --- | --- |
| `DW_SIGNING_MODE` | `azure` |
| `DW_SIGNING_PUBLISHER` | 受信任证书的发布者名称（Subject CN，大小写须一致） |
| `DW_SIGNING_ENDPOINT` | 区域端点，例如 `https://weu.codesigning.azure.net/` |
| `DW_SIGNING_ACCOUNT` | 已完成身份验证的代码签名账户 |
| `DW_SIGNING_PROFILE` | Public Trust 证书配置文件 |

仓库 Actions Secrets：`AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET`。对应服务主体需具备该证书配置文件的签名权限。服务账户和身份验证应由真实发布者完成。

## 受信任证书

仓库 Actions Variables：`DW_SIGNING_MODE=certificate`、`DW_SIGNING_PUBLISHER`（证书 Subject CN）。

仓库 Actions Secrets：`WIN_CSC_LINK`（electron-builder 支持的 PFX/P12 Base64 内容或证书来源）、`WIN_CSC_KEY_PASSWORD`（证书密码）。适用范围是签发机构允许以这种方式使用的受信任证书。私钥与密码只进入构建进程环境，不进入源码、生成配置、报告或制品。

## 发行门槛

1. 执行类型、回归、真实 Electron 桌面与打包程序检查。
2. 校验已发布 1.2.6 安装包的 SHA-256，实际安装后创建会话、指令、工作目录与加密凭据。
3. 实际升级到本次发行版本，核验默认用户数据目录、历史和设置，再调用模拟模型证明升级后可解密凭据。
4. 实际卸载并检查默认用户数据保留；在该测试创建的独立 Runner 数据上验证全新安装、退出保存与再次卸载。
5. 将安装验收报告绑定到本次版本、源码提交和实际安装包哈希；正式 Release 必须提供安装报告、SBOM 与 SHA-256。发布前重新校验下载后的文件集合、身份与全部哈希，拒绝缺失或过期的安装证据。
6. 如启用签名，使用 Windows `Get-AuthenticodeSignature` 核验安装包、便携版、主程序和实际安装生成的卸载程序：信任链有效、发布者符合预期、证书含 Code Signing 用途、有受信任时间戳；同时提供对应签名报告。

安装验收脚本只允许在临时 Windows GitHub Runner 中运行，并拒绝已有默认用户数据目录。它不会通过替换 `userData` 路径来模拟卸载保留，也不会把强制结束进程视为正常退出。

发行工作流始终设置 `DW_REQUIRE_INSTALLATION=1`。`prepareRelease` 默认对正式标签要求安装证据，也支持显式 `requireInstallation`；已有安装报告或签名报告时仍会校验安装证据。签名资源不是默认门槛，未签名正式版仍执行上述全部非签名验收。

## 未签名候选发布

`v1.3.0-rc.1` 已通过独立的 [候选发布流程](../.github/workflows/candidate-release.yml)发布为明确标注未签名的预发行版。它复用完整 Windows 验收的原始制品，核对源提交、安装报告、文件集合与哈希；发布后从 Release 重新下载并逐文件比较，不重新构建。

RC1 的应用内部版本为 `1.3.0`，标签指向当时实际验收的源码提交。该记录和原始制品保持不变，不能替代新版本、新源码或新安装包的验收。
