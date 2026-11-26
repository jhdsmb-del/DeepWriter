# DeepWriter 威胁模型（THREAT_MODEL）

> 维护约定：本文件与 `docs/status.json` 的 P0-01/02/07/08（已实施）及 P1-03/P1-09（部分/未开始）对应。新增缓解措施必须先在 gate1 安全矩阵（`scripts/gate1-security.ts`，61 项 fail-closed 测试）中固化断言，再更新本文。
> 日期：2026-08-11 · 基线 commit：`bef19f58` · 安全基线：gate1 61 PASS / 0 FAIL。

总体立场：**fail closed**。所有校验不通过时拒绝执行且磁盘保持原状态；安全矩阵任一断言不得被放宽。

---

## T1. Renderer 被攻陷（XSS / 恶意内容渲染）

- **攻击面**：renderer 渲染模型输出（Markdown/HTML）、附件文本、语料、命令输出；任何注入到渲染上下文中的脚本一旦执行，可尝试访问 `window.ds.*` 桥。
- **现有缓解**（P0-02 已实施）：
  - 全量 IPC 通道经 `ipcGuard.registerIpc/registerIpcOn`：sender 鉴权（仅主 frame + dev origin/精确打包 URL）+ zod schema + 载荷上限；
  - preload 仅暴露白名单桥 `window.ds.*`；`will-navigate` 收紧（仅 dev origin/精确 index.html）；
  - `attachments:read` / `galgame:*` / `style:addSources` / `dialog:openPath` 路径授权注册制（拖拽/对话框注册的 realpath 才可读）。
- **残余风险**：
  - renderer 完全攻陷时，仍可能滥用已获授权的路径与合法 IPC（纵深防御不足）；
  - 未验证 CSP 配置状态；Markdown 渲染（react-markdown + highlight.js）的注入面未做专项测试。
- **建议**：补 CSP 并在 gate1 增加 renderer 侧注入用例；对 highlight.js 等渲染路径做依赖审计；考虑敏感 IPC 增加一次性授权 token。

## T2. 恶意附件 / zip bomb / 超限解析

- **攻击面**：用户导入 epub/docx/pdf/txt 等附件；EPUB 本质是 zip，解压可造成磁盘与内存放大（zip bomb）；docx/pdf 解析运行位置决定影响面。
- **现有缓解**（P0-08 已实施部分）：
  - `preflightZip` 中央目录预检：条目 ≤500、单条 ≤64MB、总 ≤200MB、压缩比 ≤200x；损坏 zip fail closed；gate1 S-5 固化。
- **残余风险**：
  - **PDF/docx 解析仍在 Electron 主进程**，utilityProcess 隔离未做（P0-08 partial，明确残余风险）；
  - 附件文本长度上限、非 zip 类格式（pdf/docx）的解析器自身漏洞面未收敛。
- **建议**：将 PDF/docx 解析迁入 utilityProcess 并加超时/内存上限；升级解析库时跑 gate1 回归。

## T3. Prompt injection（指令注入）

- **攻击面**：附件内容、语料文件、记忆文件（AGENTS.md / memory.md）、仓库内 README 等文本进入上下文后诱导模型执行工具。
- **现有缓解**：
  - 系统提示词边界 + 权限系统三档（safe/auto/off）默认询问；
  - 命令执行走白名单 + argv 精确匹配 + realpath containment（P0-01）；
  - checkpoint 快照可回滚文件改动。
- **残余风险**：模型层无法根除注入；文件内容直接进入上下文，无法可靠区分「数据」与「指令」；语料/记忆内容无来源标注。
- **建议**：对不可信来源内容在上下文中加边界标记；默认对未信任目录使用 safe 权限模式；不承诺「注入免疫」，在 README/安全文档中如实说明。

## T4. 恶意仓库（workDir 投毒）

- **攻击面**：用户把 DeepWriter 指向不信任目录（如克隆的恶意仓库），其中 AGENTS.md/memory.md 含恶意指令、脚本文件含恶意命令。
- **现有缓解**（P0-01）：
  - `run_command` 白名单（list/read/write/edit/search）+ 记忆规则 argv 精确匹配防前缀放大；git 危险选项禁用；
  - `parseCommandLine` 拒绝未引用元字符；Windows 内置命令（type/dir/findstr/echo/cd/pwd/ls）Node 原生实现 + realpath containment；where/tasklist 禁用。
- **残余风险**：auto 模式下低风险命令自动放行，指令注入可间接利用合法命令（如 read_file 读取敏感文件后回传）；记忆文件本身不可信。
- **建议**：首次打开新目录提示「未信任工作区」并强制 safe/ask；审计 auto 模式放行清单。

## T5. 路径逃逸（path traversal / symlink）

- **攻击面**：任何接受路径的 IPC（attachments:read、style:addSources、galgame 修复、导入）与文件工具。
- **现有缓解**：
  - `assertPathAllowed` 路径沙箱；`realpath` containment（P0-01/P0-07）；
  - 授权注册制：未注册 realpath 一律拒绝（P0-02，gate1 S-4/S-6）；
  - `applyRenpyPatch` 强制 `game/` 前缀 + 防穿越 + anchor 唯一 + baseSha256 + 原子写（P0-07，gate1 S-7/S-8）。
- **残余风险**：授权注册依赖 UI 流程正确（拖拽/对话框先注册后使用）；symlink 到注册目录外的场景依赖 realpath 展开时机。
- **建议**：对全部授权注册点做 gate1 覆盖审计；定期检查新增 IPC 是否绕过注册制。

## T6. 命令注入（shell metacharacters / .cmd/.bat）

- **攻击面**：模型或用户提供的命令字符串在 Windows 上经 shell 执行。
- **现有缓解**（P0-01）：
  - `runCommand` 弃 `shell:true`，改 `spawn(argv, shell:false)`；
  - `parseCommandLine` 引号感知 tokenizer，未引用元字符（`&|;<>`\`$(){}*?~"'!`）拒绝；
  - .cmd/.bat 走 `cmd.exe /d /s /c` + `^` 转义；PATH 扩展名探测收敛。
- **残余风险**：.cmd/.bat 最终仍经 cmd.exe，转义语义复杂存在绕过可能（Windows 特定）；无跨平台 shell 语义测试覆盖（当前 gate1 在单平台运行）。
- **建议**：CI 三平台跑 gate1（见 `.github/workflows/ci.yml`）；进一步收紧 .cmd/.bat 白名单或提示风险。

## T7. API key 窃取

- **攻击面**：settings.json 中的 API key；renderer 设置对话框；日志；内存转储。
- **现有缓解**（P1-03 主体已实施）：
  - safeStorage 加密落盘（`apiKeyEnc` base64），不可用时 **fail closed 仅内存不落盘**（`apiKeyStorage: 'memory'`），UI 感知存储状态；
  - 旧明文 key 启动时原子迁移（加密成功后删除明文字段，失败不动原文件）。
- **残余风险**：
  - 渲染进程能读到 key（UI 展示需要），renderer 攻陷即泄露；
  - `src/main/index.ts:80` 的 `warnEncryptionFallback` 日志文案写「降级为明文存储」，**与实际 fail-closed 行为不符（误导性日志，待修）**；
  - SettingsModal 权限类字段即时落盘/Cancel 无效（P1-03 剩余项）。
- **建议**：修正误导日志文案；设置页对 key 做二次确认（显示/编辑需确认）；评估主进程内存中 key 的生命周期收敛。

## T8. 更新供应链（supply chain）

- **攻击面**：npm 依赖、electron 二进制、发布产物（安装包）被投毒或篡改。
- **现有缓解**：无（P1-09 unstarted）。`private: true`、无 LICENSE/签名/fuses/SBOM、无 CI。
- **残余风险**：**高**。安装包无签名校验、electron 无 fuses 加固、依赖无 SBOM、无更新通道。
- **建议**：启用 electron fuses（ELECTRON_RUN_AS_NODE 等加固）、代码签名（Windows/macOS）、生成 SBOM、CI 构建产物 hash 记录、审慎引入自动更新。

## T9. 日志泄密（activity journal / 控制台输出）

- **攻击面**：activity journal 与工具输出预览中可能含密钥、邮箱、绝对路径、敏感文本；日志文件/UI 可见。
- **现有缓解**：
  - `redactText`（`src/shared/activity.ts:319`）：`sk-` 前缀 16+ 字符密钥、邮箱、Windows/POSIX 路径截 basename、shell 元字符替换为 `·`；`safeToolInputSummary`/`safeOutputPreview` 截断。
- **残余风险**：
  - 正则覆盖有限：非 `sk-` 前缀的长密钥、过短/过长密钥、未匹配格式的路径、中文或其他语言的敏感内容**不脱敏**；
  - `redactText` 替换元字符会**破坏命令展示可读性**（P1-07，`shared/activity.ts:307-326`）；
  - 控制台 `console.warn`（如误导性加密降级日志）不走 activity 脱敏。
- **建议**：日志改结构化（敏感字段不落盘、值引用不展开）；修复 P1-07 的展示破坏；补充脱敏用例并如实声明局限。

---

## 分级汇总

| ID | 威胁 | 现状 | 残余等级 |
|---|---|---|---|
| T1 | Renderer 攻陷 | P0-02 已实施 | 中（纵深不足） |
| T2 | 恶意附件/zip bomb | P0-08 partial | 中（PDF/docx 未隔离） |
| T3 | Prompt injection | 权限系统 + 白名单 | 中（不可根除） |
| T4 | 恶意仓库 | P0-01 已实施 | 中（auto 模式） |
| T5 | 路径逃逸 | P0-02/P0-07 已实施 | 低-中 |
| T6 | 命令注入 | P0-01 已实施 | 低-中（Windows shell 语义） |
| T7 | API key 窃取 | P1-03 主体已实施 | 中（渲染进程可见） |
| T8 | 更新供应链 | P1-09 unstarted | **高** |
| T9 | 日志泄密 | 脱敏有已知局限 | 中 |

安全披露与支持范围见 `SECURITY.md`。
