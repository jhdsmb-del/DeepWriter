# DeepWriter 安全策略（SECURITY）

## 支持范围

- 安全修复覆盖：当前主分支与 5.0.x 发行线。具体制品状态见 [Releases](https://github.com/jhdsmb-del/DeepWriter/releases)。
- 安全基线：`scripts/gate1-security.ts` 权限与边界回归；任何修复不得放宽 fail-closed 语义。
- 完整威胁模型见 [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)。

## 报告安全漏洞（私密渠道）

**请勿**通过公开 issue、讨论区或 PR 描述安全漏洞。

1. 优先使用 GitHub 私密安全披露（**Private vulnerability reporting**，需仓库所有者启用）或直接私信仓库维护者；
2. 如上述渠道不可用，通过仓库主页标注的维护者联系方式（待项目所有者补充）私密提交。

报告内容建议包含：

- 漏洞类型与影响（参考威胁模型中的条目，如路径逃逸/命令注入/Key 泄露）；
- 复现步骤与最小样本（不要附带真实 API Key 或真实创作数据）；
- 受影响版本与平台（Windows/macOS/Linux）；
- 若可行，附候选修复思路（不要求先修后报）。

## 响应承诺

- 确认收到：**7 个自然日内**。
- 复现与评估：确认后 **14 个自然日**内给出处置计划（修复排期或「设计如此，非漏洞」说明）。
- 修复与披露：修复合入后公开 CHANGELOG 条目并注明致谢（除非报告者要求匿名）。

## 支持范围之外

- 模型层面的 prompt injection 无法根除（见威胁模型 T3）：不可信的附件/语料/记忆内容可能诱导模型执行已授权命令，需要持续减少风险；如能复现授权边界被绕过，请按漏洞报告。
- 由使用者保管不当导致的信息泄露（如在 prompt 中明文放置密钥/证件号）。

## 已知残余风险（透明声明）

- PDF/docx 解析仍在主进程，未隔离（P0-08 partial）；
- Windows 制品当前无代码签名，SmartScreen 可能提示未知发布者；SBOM 可由发布脚本生成，但每次正式分发仍需复核制品对应的清单；fuses 未配置。请仅从可信渠道获取安装包；
- 日志脱敏正则覆盖有限（见 [隐私说明](docs/PRIVACY.md)）。

## 安全相关贡献

安全修复的 PR 必须：附 gate1 回归断言（先红后绿）、通过 `npm run gate1`、不绕过任何 fail-closed 检查；详见 `CONTRIBUTING.md`。
