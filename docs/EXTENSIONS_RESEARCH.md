# 技能与工具插件：官方标准研究和可实现 MVP

研究日期：2026-10-03。标准研究先完成，随后按批准范围实现共享模块、CLI 纵切面及 Desktop backend 薄接线。未下载执行第三方代码或增加 MCP 库；下文设计目标与当前实现边界分开，backend 测试不冒称完整桌面 UI 验收。

## 当前实现与复用端口

当前新增 `src/main/extensions/{ExtensionRegistry,builtinCatalog,ExtensionActivation,StdioToolClient}.ts`：不可变 package/hash 版本库、本地静态 catalog、两项实际写作技能、第一方 Node stdio 稿件计数工具。CLI `skills/plugins` 可安装（默认disabled）、查询、显式启停和卸载；`--skill/--plugin` 选中才冻结到原 run，参考按需读取。schema 合并在原 adapter allowList 和 exact-body 预算之前，同名拒绝。

`scripts/cli-extensions.test.cjs` 本机实际 Node/SQLite/loopback HTTP/stdio 验证生命周期、未授权0模型请求、真实参考/工具/hash、范围外拒绝、升级/卸载恢复旧pin、篡改旧pin0新HTTP、重名schema及filter、未知执行组件拒绝；补实际 Electron-as-Node、并发单startup和有界await关闭/PID退出。它不是付费文学质量验收。用法见 [CLI.md](CLI.md)。

Desktop 薄入口可复用：

- `new ExtensionRegistry(explicitDirectory)` 的 `catalog/localCatalog/list/install/inspect/setEnabled`；不需 Provider/密钥/宿主，Renderer 只接收验证后的非秘密投影。
- `freezeExtensions(registry, skillIds, pluginIds)` + `skillMessages(snapshot)`；在原 run 创建前冻结，存入现有 config 的 `extensionsFrozen`，原 `frozenSystemMessages` 追加完整技能。安装状态变化不修改既有 run。
- `ExtensionActivation` 传入受控 runtime：普通 Node executable，或当前 Electron `process.execPath` 加显式 `electronAsNode:true`，后者仅额外设置 `ELECTRON_RUN_AS_NODE=1`。未明确 Node mode 的 Electron 路径安全拒绝，不默认 GUI 打开。
- 每次明确执行/恢复前 `beginRun(runId)`；`getToolSpecs(runId,pin,roots,signal)` 验证旧 inventory/schema、单startup Promise、分别授权启动，再真实握手；原 adapter 新可选 `getToolSpecs(runId)` 端口。
- executor 先检查原 frozen allowList，再 `execute`；scope 为原 snapshot 工作/文档目录。恢复前 `verify` 不查询当前版本。
- caller 暂停/取消、停用或撤销启动权限时先取消原运行，再 **await `closeRun/close`**；实际 child close + PID 不再存活才返回 exited，否则有界错误/remainingPids。关闭后原host拒绝继续调用；明确恢复重新授权。无OS沙箱；第一方只读源不创建后代。
- `ExtensionRegistry.assertPluginEnabled(pin)` 将当前可执行许可与旧内容pin分开；插件须 enabled/未removed/同packageHash。Activation开始、执行及待决grant返回后均复核，250ms监测跨进程启停，撤权后await真实退出并通知 `onRevoked(runId,message)`，CLI暂停原engine。旧skill内容仍可恢复，不自动保留旧插件执行权。

当前 Desktop backend 使用 `DesktopExtensionService` 及 main 的七个受 sender/schema 保护的 `extensions:*` IPC，结果保持原 preload 的 `IpcResult`。本地导入只取真实主进程目录选择框，不收 renderer 路径/执行许可；安装默认关闭。`selectedForNewRuns` 原子保存在同一注册表，停用/卸载/重装会取消新任务选择；CLI 的显式 `--skill/--plugin` 不会悄悄继承桌面选择。实际完整技能在 context preview 和 chat accept 之前以同一函数冻结进原前缀；新任务选择变化令旧 preview hash 失配，resume 不重新冻结。插件的目录 realpath、具体 schema 名和 allowList 原样冻结，原 adapter 的 exact-body 预算包含指令、参考和工具 schema。

每个插件 run 的实际 native 启动 dialog 单独授权，展示 hash、授权目录及“没有OS沙箱”，取消/暂缓/应用关闭通过 signal 关闭待决许可，迟到允许不会启动。Service 仅给原 Engine 实例补宿主生命周期边界，不另建写作编排：step 结束/暂停/取消均 await host close，shutdown 在原 childRegistry 终止前关闭监测；无扩展任务不新增退出 trace。`scripts/desktop-extensions.test.cjs` 用实际 Service、原 SQLite/Engine/Provider adapter、真实 loopback 请求及 Node/Electron-as-Node stdio 验证，含 IPC 结果封套、跨进程撤权/恢复拒绝和 PID 已退出。测试授权来自可控 policy port，不是用户在真实 UI 点击允许的证明；完整 UI 与应用自然退出仍需独立桌面验收。

本地大小/数量上限、符号链接/ADS/路径遍历、未知组件和源码hash验证已实现。当前不下载远程 artifact、不支持第三方进程、archive、完整 YAML/二进制技能资产、自动匹配、OS沙箱、旧包GC或2026原生MCP。来源目录必须用户明确选择；hash只证明完整性，不是发布者认证。未来第一方代码变化须提供审核过的旧入口hash兼容表，否则旧工具pin安全拒绝，绝不换最新版。

## 建议结论

先做一套 Desktop + CLI 共用的扩展注册表、不可变版本库和授权生命周期，再提供两类真的可运行的组件：Agent Skills 指令包，以及经审核、显式授权启动的第一方 Node MCP stdio 工具包。商店目录可浏览/安装，但浏览页、假“已启用”标签和固定工具回复不算验收。

第一版不运行任意第三方 hooks、安装命令、npm lifecycle、LSP、mod 或任意 JS 注入。第三方技能可导入为指令数据；第三方本地 MCP 进程默认拒绝，只有在单独完成执行信任/隔离审查后才扩大支持。不要为了“兼容 Claude 插件”静默忽略不支持的组件并报整个插件成功。

## 官方标准中三个不同概念

| 概念 | 官方含义 | DeepWriter 对应边界 |
| --- | --- | --- |
| Agent Skills | `SKILL.md` 元数据和指令，可附 references/assets/scripts | 指令数据，不等于新增可执行权限 |
| Plugin | 可以聚合技能和可执行组件的安装单元 | 固定版本的扩展包；每类组件独立验证 |
| Marketplace | 列出插件及其来源的目录 | 可搜索的来源索引，不是安全认证 |

Agent Skills 格式要求 YAML frontmatter 中的 `name`、`description`，约束命名/长度；`allowed-tools` 是实验字段。推荐分层加载目录元数据、激活后的完整指令、按需引用资源。[Agent Skills specification](https://agentskills.io/specification)

官方集成指南支持显式用户调用和模型激活，提醒项目目录可能不可信、同名技能需确定性处理，禁用技能不应继续暴露给模型。本文选更严格的安装验证与明确项目信任，而不是把指南的宽松解析建议当成必选项。[Agent Skills integration](https://agentskills.io/client-implementation/adding-skills-support)

Claude 插件可聚合 skills、agents、hooks、MCP 等组件；官方区分设置、磁盘和会话加载状态，桌面与终端可共享安装范围。DeepWriter 应复用这一清晰状态区分，不声称组件全兼容。[Claude plugins overview](https://code.claude.com/docs/en/plugins)

Claude marketplace 用 `.claude-plugin/marketplace.json` 的目录条目定位包，支持多种来源；其中有些来源会运行本地命令。这里仅借鉴静态目录及来源标识，不支持 command/npm 来源。[Claude marketplace](https://code.claude.com/docs/en/plugin-marketplaces)

Claude manifest 的技能路径与 MCP 声明是不同组件；组件路径必须受包根约束。导入其有限子集时应显示逐组件支持清单和拒绝原因，不宣称加载未知 hooks。[Claude manifest reference](https://code.claude.com/docs/en/plugins-reference)

官方明确提醒：本地插件进程可以用当前用户权限运行任意代码；普通工具权限不能约束插件自身启动时的代码。hash 校验也不能证明发布者安全。因此“允许调用工具”与“允许启动宿主进程”必须分开。[Claude plugin security](https://code.claude.com/docs/en/plugins/security)

## MCP 版本是实际兼容问题

当前官方 `latest` 指向 **2026-07-28**，采用无状态、请求级能力元数据；工具说明/annotations 仍不能当作可信授权依据。不能把旧 `initialize` 会话握手示例称为最新版协议。[MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)

当前标准传输为 stdio 与 Streamable HTTP，版本之间的请求元数据及取消行为存在差异。[MCP current transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)

**建议第一版明确标注 `2025-11-25 stdio/tools` 互操作基线**，使用经过验证的固定依赖版本和真实协议 fixture，先实现有界初始化、tools/list、tools/call、取消和关闭。2026 原生请求级协议另做兼容层及双版本测试；不以“装了某个 SDK”代替协议验收。[MCP 2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)

远程 HTTP/OAuth、server-initiated sampling/elicitation、异步 tasks、MCP Apps 和 Skills over MCP 暂不实现或不声明能力。远程版本以后必须独立处理 SSRF、授权受众、token passthrough 等边界；不能直接套 Provider API key。[MCP security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)

## 当前仓库可复用的接缝

本轮定向查阅未发现既有 Extension/Skills/MCP registry；不能把现有 `toolPolicy` 说成已支持插件商店。

| 现有代码 | 可复用的职责 | 必须补的边界 |
| --- | --- | --- |
| `src/main/chatStart.ts` | 原子接受用户任务、创建 run | 在接受前验证选中扩展版本与信任状态 |
| `src/main/executionSnapshot.ts` | 冻结 prompt、目录、allowList、预算 | 新 run 冻结扩展版本、许可、指令/资源 hash、工具 schema |
| `src/main/contextService.ts` | 实际 Provider 上下文组装与持久化 | 只加入已激活技能；压缩后保留激活事实，不重读当前最新版 |
| `src/main/runKernelAdapter.ts` | 真实工具 schema、模型/工具接线 | 单一动态 ToolRegistry 端口，不能为插件复制 run 编排 |
| `src/main/agentTools.ts` / `tools.ts` | 路径检查、执行身份、真实工具结果 | 扩展工具的宿主许可与工具许可交集，名称映射不可碰撞 |
| `src/main/permissions.ts` | 权限决策、审计、owner-scoped lease | 插件身份 + package hash + 操作 scope，不借用 Provider 密钥 |
| `src/main/commandProcess.ts` / `childRegistry.ts` | 参数数组、隐藏窗口、子进程取消/退出 | stdio 客户端需交互 stdin；复用树注册/关闭逻辑，不直接误用 stdin=ignore 的 runProcess |
| `src/main/jobs/AgentRunEngine.ts` / `db/` | tool 调用、副作用未知、恢复事实 | 外部工具结果纳入既有 durable toolcall/recovery 契约 |
| `src/cli/runtime.ts` / `host.ts` | 真 Node runtime、非 TTY 拒绝、独立配置 | 共用扩展服务；不模拟 Electron 授权、不读桌面加密 store |

这些是研究定位的接缝；当前只加入上述可选schema端口和CLI接线，没有另造编排。外部进程不是现有 `assertPathAllowed` 的OS沙箱，不能声称第三方进程只能读工作目录。

## 一套生命周期，两套薄入口

建议新增纯 Node 的 `src/main/extensions/` 模块，由 Electron IPC 和 CLI 共用；Renderer 只得到校验后的非秘密投影。注册表位于显式、两端一致的扩展目录（设置或 `DEEPWRITER_EXTENSIONS_DIR`），与两端各自的会话数据库/密钥 store 分离。第一版使用一个有互斥锁、原子替换和 revision 的注册表，不同时维护桌面设置和 CLI 独立启停事实。

目录建议：`registry.json`、`packages/<publisher>/<name>/<contentHash>/`、`staging/`、`audit/`。包版本不可变；manifest 哈希与文件清单哈希不能代替人工发布者信任。安装记录至少含 id、显示版本、来源 origin/ref/commit、package hash、文件 inventory、支持/拒绝组件、安装范围、启用状态、信任 revision 和申请权限。

| 用户动作 | 真实状态与行为 |
| --- | --- |
| 浏览/查看详情 | 仅获取/验证静态目录和 manifest；显示来源、hash、许可证、组件及危险执行面；不 spawn |
| 安装 | 下载到独有 staging，校验并原子发布完整包；初始 `installed_disabled`，不执行脚本 |
| 启用技能 | 明确信任指令数据，下一次 run catalog 可见；并不执行 scripts |
| 启用工具插件 | 独立同意宿主启动许可及具体版本；MVP 只接受审核过的第一方包 |
| 停用 | 对新任务立即不暴露；活动工具调用安全取消，未知副作用进入原有恢复边界 |
| 更新 | 新版本独立安装及权限差异审查；旧 run 保持旧版本，不自动扩大授权 |
| 卸载 | 先停用、撤销后续调用；被活动/暂停 run 引用的旧版本保留并显示原因，不偷偷删除恢复依赖 |
| 清理缓存 | 只清理已确认无 run 引用的受控 package 版本；不删源项目或插件生成的用户文档 |

Desktop 入口建议“发现 / 已安装 / 详情与权限 / 错误”四个可达页，详情显示真实状态而非仅 Toggle。当前 CLI 为 `skills/plugins catalog|list|install|inspect|enable|disable|remove`，支持 `--json`；非TTY不猜测执行同意。

注册表锁要处理桌面/CLI 同时安装、异常退出和修订冲突。scope 先支持 user + 显式 project；项目目录需信任门。不同发布者同名技能使用命名空间，不能靠扫描顺序悄悄覆盖。两端运行事实仍只存在各自既有 run store，不另造扩展任务队列。

## 真正按需使用的技能

1. 已启用且兼容的技能只向模型暴露 namespace、name、description；有数量/总 token 上限。默认不扫描整个 home，明确设置目录和项目根，跳过 `.git`/node_modules。
2. 用户显式选技能，或模型调用受限 `activate_skill`，查当前 run 冻结 catalog 中的 id；完整读取并验证 `SKILL.md`，保存激活 evidence 和实际内容/hash，再交给同一上下文管线。旧 run 不能因磁盘最新版改变指令。
3. 指令按扩展数据标识，不提升成可覆盖系统安全策略的权限。`allowed-tools` 只用于申请/说明：实际能力是包声明、宿主许可、run allowList、用户路径/操作授权的交集。
4. `read_skill_resource` 只读该包 inventory 中受控引用；拒绝绝对路径、`..`、URL 自动执行和 realpath 逃逸。资源也校验 hash/大小。scripts 可以查看，但第一版不由技能激活自动执行。
5. template/assets 的写入必须走现有文件工具和检查点。首个自带可用技能可做“稿件结构检查”：按需读取规则、输出具体结构建议，而不是占位欢迎语。

压缩/恢复测试须证明完整指令第一次激活后仍有效，禁用/卸载使新 run 看不到它；跨版本恢复仍使用原冻结内容。无能力加载完整指令时，应报“不可激活”，不能只放 metadata 就说技能已执行。

## 工具插件纵切面

第一方 `manuscript-inspector` 示例：自包含 Node CJS stdio server，提供 `count_manuscript`，对显式授权的稿件路径返回 code-point 字数与 hash。它必须真的读文件；模型请求中真的出现对应 schema，调用经真实 MCP 进程，结果经既有 toolcall 持久化。安装/浏览都不运行它。

启动时使用批准的 Node runtime + 校验过的入口 + 参数数组，`shell:false`/Windows 隐藏窗口；cwd 为受控版本目录。环境变量仅最小 allowlist，不继承 DeepSeek/OpenAI API key 或桌面凭据。虽然第一方 server 可实现根目录约束，这仍是它的代码契约，不是对恶意 Node 进程的 OS 隔离承诺。

同一共享 ToolRegistry 将 namespaced plugin/tool id 映射为 Provider 合法且唯一的 function 名；冻结原名、映射、schema hash、宿主版本。工具声明经过有界 JSON schema 验证，不允许 schema 外部引用/无限递归、任意 UI 注入。stdio stdout 只解析有界协议消息，stderr 日志也有大小与秘密过滤，不能直接混入 CLI 正文。

首版默认不提供服务端 sampling、任意 client requests、第三方命令启动器或网络工具。工具 `readOnlyHint` 等自报属性不触发自动授权。真正写文件的插件无法从远端自动获得本地检查点；未能证明事务/幂等的调用断线后必须进入 `recovery_required`，不能凭 server“成功”或本地“已取消”假定副作用不存在。

停用/取消须关闭或取消当前请求，必要时终止跟踪的子进程树并等待确认；不能把 `process.kill()` 返回当作已退出证据。重新启用、版本更新或授权撤回后恢复旧 run，重新核验授权与原包；失效时等待用户，不自动安装/重放未知副作用。

## 安装安全最低边界

- 所有内容大小、文件数量、展开体积、目录深度和解析时间有硬上限；archive 拒绝路径穿越、绝对路径、Windows ADS/设备名、case-fold 重名、符号链接/junction、zip bomb。校验 realpath 后仍只发布到验证过的 staging 根。
- 远程来源只接受明确 HTTPS origin 和固定 artifact hash；DNS/IP/重定向每跳验证，拒绝私网/localhost、凭据 URL、未经许可跨域。不能把“Provider origin 通过检查”误作任意下载 URL 安全。
- 第一版不自动 `npm install`、`npx`、git hooks、submodule、shell 命令 source 或 install/postinstall。依赖必须预构建入包、有 inventory 和许可证；不借用户全局 Node/PATH 运行未知二进制。
- 源 commit 与完整内容 hash 都记录；本地导入也复制/校验为不可变版本。任何内容变化需要新版本记录和授权差异检查。官方同名 marketplace 不等于真官方 origin。
- hash 是完整性，不是信任；未签名包要明确显示未经签名/审核状态。本文不推导出 Windows 发行签名要求，亦不声称有已建成的发布者认证。
- 可配置数据必须 schema 验证；密钥只存独立明确 credential source，返回/UI/日志只给引用，不写 manifest、run snapshot、inventory 或命令行。坏 JSON 同样不能把密钥片段带进错误。

## 交付次序与最少验收

**A：registry + skills 真实纵切面。** 本地包和固定 HTTPS artifact 来源、安装/启停/卸载、metadata→完整指令→引用资源，Desktop/CLI 都可达。第一方结构检查技能作用于实际用户任务；未知组件完整拒绝。不能将此阶段称为 MCP 工具插件已交付。

**B：第一方 MCP 工具插件真实纵切面。** 有界 stdio 基线、宿主授权、真正 schema/调用/结果、count/hash 读回、停用进程确认与恢复拒绝。只有 A+B 都通过才可以称“技能和工具插件商店 MVP”。

**C：扩大兼容范围。** 2026 原生协议、远程 OAuth、第三方进程隔离和 hooks 等各自有审查及兼容验收；不作为 A/B 假“兼容全部”的隐藏承诺。

定向验收应包含：

- 包校验红例：hash 不符、`../`/ADS/symlink、同名冲突、未知 executable component；全程 0 启动脚本、无范围外写入。
- Desktop 安装→CLI 同目录能查询/启停→Desktop 真状态更新，反向亦然；并发冲突不丢 registry revision。
- 技能未激活不注入正文指令；显式激活完整读取；引用资源按需且 hash 可核；禁用后的新 run 不可见。
- 实际进程 MCP fixtures：schema 真发给模型、授权路径读回真实文件 count/hash；宿主拒绝时 0 spawn，工具拒绝时 0 正常工具调用。
- 不假设恶意已启动进程“零副作用”；该场景应被执行信任门挡住，不能用应用工具权限测试代替 OS 隔离证明。
- 进程异常、坏 JSON/协议行、timeout、取消与未知 side effect：不假完成、不自动重放；退出数和剩余 PID 可复核。
- 旧 run 恢复时包缺失/改变、撤销信任、新版本增权限：都拒绝偷换。卸载保留必要旧版本，显示保留原因。

完整目标矩阵尚未全部验收，特别是完整Desktop UI/退出流程、跨端界面即时刷新、远程下载及宽协议兼容。只对开头明确的共享模块/CLI/Desktop backend 定向切面给出PASS，不外推到全部设计目标，不重构长文编排。
