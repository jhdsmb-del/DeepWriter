# DeepWriter SBOM 依赖清单（SBOM_DEPENDENCIES）

> 生成时间：2026-09-04T15:23:13.821Z　|　生成命令：`node scripts/gen-sbom.cjs`　|　项目版本：1.2.4（deepwriter）
> 数据来源：`package.json` 声明 + `node_modules/<pkg>/package.json` 的已安装 `version` / `license` 字段。
> 任何包读不到已安装元数据时，该行版本/许可证标 `unknown`，表示**需人工确认**（见文末风险说明）。

## 1. 运行 SBOM（production dependencies —— 随 asar 进入安装包的运行时依赖）

共 14 个包。

| 包名 | 已安装版本 | 声明范围 | 许可证 |
|---|---|---|---|
| @tanstack/react-virtual | 3.14.9 | `^3.14.9` | MIT |
| diff | 9.0.0 | `^9.0.0` | BSD-3-Clause |
| docx | 9.7.1 | `^9.7.1` | MIT |
| exceljs | 4.4.0 | `^4.4.0` | MIT |
| fflate | 0.8.3 | `^0.8.3` | MIT |
| highlight.js | 11.11.1 | `^11.11.1` | BSD-3-Clause |
| iconv-lite | 0.7.3 | `^0.7.3` | MIT |
| mammoth | 1.12.1 | `^1.12.1` | BSD-2-Clause |
| pdf-parse | 2.4.5 | `^2.4.5` | Apache-2.0 |
| pdfkit | 0.19.1 | `^0.19.1` | MIT |
| react | 19.2.8 | `^19.2.8` | MIT |
| react-dom | 19.2.8 | `^19.2.8` | MIT |
| zod | 4.4.3 | `^4.4.3` | MIT |
| zustand | 5.0.14 | `^5.0.14` | MIT |

## 2. 开发依赖（devDependencies —— 不进入安装包，单列备查）

共 13 个包。

| 包名 | 已安装版本 | 声明范围 | 许可证 |
|---|---|---|---|
| @playwright/test | 1.62.1 | `^1.62.1` | Apache-2.0 |
| @types/node | 26.2.0 | `^26.2.0` | MIT |
| @types/pdfkit | 0.17.6 | `^0.17.6` | MIT |
| @types/react | 19.2.18 | `^19.2.18` | MIT |
| @types/react-dom | 19.2.4 | `^19.2.4` | MIT |
| @vitejs/plugin-react | 5.2.0 | `^5.2.0` | MIT |
| electron | 43.3.0 | `^43.3.0` | MIT |
| electron-builder | 26.15.3 | `^26.15.3` | MIT |
| electron-vite | 5.0.0 | `^5.0.0` | MIT |
| react-markdown | 10.1.0 | `^10.1.0` | MIT |
| remark-gfm | 4.0.1 | `^4.0.1` | MIT |
| typescript | 7.0.2 | `^7.0.2` | Apache-2.0 |
| vite | 7.3.6 | `^7.3.6` | MIT |

## 3. 已知 Electron 供应链风险说明（如实标注，unknown = 未自动核验，需人工确认）

> 以下状态为**自动采集的已安装版本号**；维护活跃度、CVE 公告、上游仓库健康度**未自动核验**，
> 发布前需人工逐一确认（本文件不声称已审计）。

- **Electron**：已安装 43.3.0（声明 `^43.3.0`）。Chromium/Node 内核迭代快，历史 CVE 密集；**维护状态：unknown，需人工确认**当前版本是否处于支持窗口并核对已知漏洞。
- **electron-builder**：已安装 26.15.3（声明 `^26.15.3`）。构建链自身即供应链攻击面（打包脚本、下载二进制、NSIS/签名工具链）；**维护状态：unknown，需人工确认**。
- **解析/文档处理库**（处理用户上传附件与导出，最易受恶意文件触发的攻击面）：
  - `pdf-parse`：已安装 2.4.5 —— **维护状态：unknown，需人工确认**（历史上该包维护活跃度偏低、存在已知 CVE 记录）。
  - `mammoth`：已安装 1.12.1 —— **维护状态：unknown，需人工确认**。
  - `fflate`：已安装 0.8.3 —— **维护状态：unknown，需人工确认**（zip 解压需关注 zip bomb / 路径逃逸防护，见 docs/THREAT_MODEL.md）。
  - 相邻的 `docx` / `exceljs` / `pdfkit`（文档生成）：**维护状态：unknown，需人工确认**。
- **一般性说明**：所有包均按 package-lock.json 锁定安装；版本号来自 `node_modules` 实际安装（可能与 lockfile 一致）。许可证字段缺失或 `unknown` 的包在商用分发前需人工核验许可证合规性。

## 4. 复核记录（人工确认后填写）

| 日期 | 确认人 | 已核验项 | 结论 |
|---|---|---|---|
| （待填） | （待填） | Electron / electron-builder / 解析库维护状态 | pending |
