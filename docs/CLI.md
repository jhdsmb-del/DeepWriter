# DeepWriter CLI

DeepWriter CLI 支持联网问答、工作目录内的文件/命令任务，以及持续对话、逐问采访、连续长文和任务恢复。它与桌面共用引擎、SQLite、文件/命令权限及检查点，独立运行，不启动 Electron；会话、配置和密钥与桌面分开保存。

## 读 Ren’Py 剧情路线

在完整包解压目录运行：

```powershell
.\cli\deepwriter.cmd galgame routes .\examples\last-ferry
.\cli\deepwriter.cmd galgame routes .\examples\last-ferry --json
```

输出包括节点所在的脚本与行号，例如 `「敲铃应他」 → bells`。把示例目录换成自己的项目即可。读取路线不运行游戏，也不用连接模型。脚本含缺失的静态跳转目标时，命令输出诊断并以非零状态退出。

## 三步开始

Windows 独立 CLI 包 `DeepWriter-8.0.0-cli-win-x64.zip` 包含 `cli/deepwriter.cmd`、`cli/runtime/node.exe` 和依赖许可证，无需安装桌面版、Node 或 npm。完整包也包含相同的 CLI 目录和同版桌面。完整解压后在解压目录打开 PowerShell，并保留整个 `cli` 目录。已发布的包见 [Releases](https://github.com/jhdsmb-del/DeepWriter/releases)。上面的 `examples/last-ferry` 示例随完整包和源码提供，不在独立 CLI 包内。

1. 核对版本和实际命令：

   ```powershell
   .\cli\deepwriter.cmd --version
   .\cli\deepwriter.cmd --help
   ```

2. 隐藏输入 Key，再保存非密钥配置：

   ```powershell
   $dwKey = Read-Host "DeepWriter API Key" -AsSecureString
   $env:DEEPWRITER_API_KEY = [System.Net.NetworkCredential]::new("", $dwKey).Password
   .\cli\deepwriter.cmd config set --base-url https://api.deepseek.com --model deepseek-flash
   ```

3. 对话或开始逐问长文：

   ```powershell
   .\cli\deepwriter.cmd chat "写一段灯塔夜景"
   .\cli\deepwriter.cmd write "写一篇克制的灯塔夜景故事，不新增人物" --target 8000
   ```

`--target 8000` 设置目标字数。Key 不进入命令历史或普通配置，但存在当前终端进程的环境中；用完可运行 `Remove-Item Env:DEEPWRITER_API_KEY`。

后续命令中的 `deepwriter` 是入口简称，在独立 CLI 或完整包中替换为 `.\cli\deepwriter.cmd`，源码环境替换为 `node out/cli/deepwriter.cjs`，并非要求另装全局命令。默认数据目录是当前目录下 `.deepwriter-cli`，含独立数据库、非密钥配置、检查点及产物缓存；默认稿件目录为其中的 `documents`。可用 `--data-dir`、`--work-dir`、`--doc-dir` 明确指定，不会自动导入桌面会话。固定数据目录后，查询与恢复也要使用同一 `--data-dir`。

## 检查与下载 CLI 更新

CLI 不后台检查或自动替换自身。以下两个命令只有在明确运行时才连接官方 GitHub 发布服务；不需要 Provider 配置或 API Key，不创建运行数据库，也不读取桌面密钥：

```powershell
.\cli\deepwriter.cmd update check
.\cli\deepwriter.cmd update check --json
New-Item -ItemType Directory -Path .\cli-downloads
.\cli\deepwriter.cmd update download .\cli-downloads
```

`check` 返回当前版本、官方稳定版、发布页和独立 CLI 资产。`download` 接受已存在的真实目录，支持 Windows 短文件名、大小写别名及经重定向 Documents 等父目录到达的目录；所选末级目录自身不能是链接，下载期间原路径必须始终指向同一物理目录。它只下载该正式版本的 `DeepWriter-版本-cli-win-x64.zip`；先流式写入私有临时文件，核对官方发布 API 提供的字节数与 SHA-256 后，才发布为完整文件。它不覆盖同名文件或链接，不更新已安装 CLI，不解压、安装或运行下载的代码。下载失败会清理本次临时文件；目录需支持硬链接安全发布，Windows 可选择本机 NTFS 目录。没有独立 CLI 资产或 API 未提供 SHA-256 时，按输出中的官方发布页提示处理，不会改下桌面安装包。

解压到一个新目录，先运行新目录中的 `cli/deepwriter.cmd --version`，保留旧 CLI，确认新入口可用后再手动切换。更新不会迁移数据：继续使用原工作目录，或显式指定原来的 `--data-dir`，否则新目录下会显示一个新的空会话库。已是当前版本时，`check` 仍给出操作提示；明确运行 `download` 仍可下载同版本的全新副本。

加 `--json` 时输出单行 `{"type":"update","data":{...}}`，包含 `currentVersion`、`version`、`updateAvailable`、`cliAsset` 和人工操作 `instruction`；下载另含 `status`（`downloaded` / `unavailable`）、`path`，成功时附 `bytes`、`sha256`。查询成功或未发布 CLI 资产退出 `0`；网络、校验、参数或文件冲突退出 `1`，沿用 `type: "error"` 信封。此入口只接受 `--json`，不接受自定义发布地址或 Provider 选项。

随包 Node 运行时支持标准 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` 环境变量；没有 DeepWriter 专属代理或发布地址覆盖项。源码环境的较旧 Node 可用其支持的 `NODE_USE_ENV_PROXY=1` / `--use-env-proxy` 启动，或升级到随包版本；代理认证信息不会作为命令输出。

## 配置、自定义服务与思考强度

默认环境变量 `DEEPWRITER_API_KEY` 只自动用于官方 `https://api.deepseek.com`。兼容服务使用它自己的变量，通过 `--key-env NAME` 明确选择；`config set` 会保存变量名和 `keyEnvOrigin` 绑定，不保存值。更换 origin 不继承旧绑定，再次明确选取密钥才会发送。旧配置中已明确命名的自定义变量仍用于原配置的 origin；旧配置若只是沿用了默认变量名，切换到非官方服务后需用 `--key-env` 确认一次。

只有明确传入 `--config` 的文件可提供字符串 `apiKey`，优先于环境变量（即使同时传了 `--key-env`）。文件已声明 `baseUrl` 时，其 `apiKey` 不随命令行覆盖发送到另一 origin；仅含密钥的显式文件仍可与本次目标选项明确组合。默认配置中出现 `apiKey` 会拒绝运行，`config set` 永不保存密钥值。不要提交含密钥的配置文件，也不要将密钥复制进发行包。

服务明确不支持工具时，使用 `config set --no-tool-support` 保存 `supportsTools: false`；恢复支持工具后用 `config set --tool-support` 改回。未知模型沿共享能力策略尝试工具，不在请求失败后自动换成无工具重发。

其他配置字段包括 `baseUrl`（仅 origin）、`chatPath`、`model`、`protocol`、`maxTokens`、`contextWindow`、`maxCalls`、`tokenBudget`、`workDir`、`docDir`、`keyEnv`、`keyEnvOrigin`。上下文由所选模型决定；若自定义模型未提供窗口规格，可在该模型配置中补充 `contextWindow`。

默认模型是 `deepseek-flash`，不会覆盖用户已保存的模型。协议可选 `deepseek-chat`、`openai-chat`、`openai-responses`、`anthropic-messages`；请根据提供商接口选择协议、路径和精确模型 ID。公共服务使用 HTTPS；`--loopback` 用于本机 HTTP 服务，没有明确选取密钥时不发认证头，即使终端里已有官方 Key。需要认证的本机服务同样用 `--key-env NAME` 或显式配置选择；从保存的本机模式切回公网时加 `--no-loopback`。

自定义服务可直接粘贴带 `/v1`、代理前缀或完整请求地址的 Base URL。程序按 API 格式补齐路径和默认认证头；显式 `--chat-path`、`--auth-header` 可覆盖。使用该服务自己的 Key 和实际模型 ID，例如：

```powershell
$dwBaseUrl = Read-Host "服务商 Base URL（例如 https://api.example.com/v1）"
$dwModel = Read-Host "精确模型 ID"
$dwProviderKey = Read-Host "该服务自己的 API Key" -AsSecureString
$env:DW_PROVIDER_KEY = [System.Net.NetworkCredential]::new("", $dwProviderKey).Password
.\cli\deepwriter.cmd config set --protocol openai-chat --base-url $dwBaseUrl --model $dwModel --key-env DW_PROVIDER_KEY --no-loopback
```

后续命令沿用该变量名，但每个新终端仍需设置它的值；用完可运行 `Remove-Item Env:DW_PROVIDER_KEY`。遇到 401/403，先用 `config show` 核对实际 origin、路径、模型和认证头，再核对该服务自己的 Key；不要把官方 Key 试发给其他服务。桌面提供配置预设、模型发现与能力探测，CLI 不会自动读取这些配置；详见 [Provider 说明](https://github.com/jhdsmb-del/DeepWriter/blob/main/docs/PROVIDER_EXPANSION_RESEARCH.md)。

`--auth-header api-key` 或配置 `authHeaderName` 可指定专用认证头名（例如 Azure 的 OpenAI-compatible 路径）；值仍由原独立密钥来源读取，不写快照。Authorization 使用 Bearer，其他允许的认证头发送原始 key；默认 Anthropic 是 x-api-key，其他协议默认 Authorization。复用共享认证策略拒绝危险头名、CRLF、用户 extraHeaders/fixedHeaders 和秘密额外头；Anthropic 版本头仅由受控协议设置。`deepseek-chat` 的旧原生路径只支持 Authorization，专用头须明确选 `openai-chat/responses`；不声称 native Gemini/OAuth。改变认证头后旧 run 恢复拒绝，不静默发送到新头。

`--thinking` / `--no-thinking` 控制新运行的思考模式，`--effort low|high|max` 设置强度。DeepSeek 原生模式用于 `deepseek-flash/pro`，与桌面共用规范化函数；Responses 和 Anthropic Messages 沿各自原生协议发送，模型支持情况由服务端响应。通用 Chat 兼容接口未提供模型专用映射时，不套用其他模型的思考字段。旧强度别名兼容 `minimal→low`、`medium/xhigh→high`、`ultra→max`；恢复不会重写原运行配置。

```powershell
deepwriter config set --protocol deepseek-chat --base-url https://api.deepseek.com --chat-path /chat/completions --auth-header Authorization --model deepseek-flash --thinking --effort high
deepwriter config show
```

关闭用 `--no-thinking`。思考强度不是通用质量档位，不将某个模型的原生参数直接套给另一协议。

正常发送无需额外的费用确认选项，旧的 `--accept-unknown-cost` 仍可兼容使用。主动设置的调用次数上限和任务 token 预算继续生效，金额未知或 JSON `null` 时不会记作零；实际费用以服务商账单为准。

## 交互和脚本

无参数且 stdin/stderr 为终端时进入持续聊天，同一会话保留历史；非终端无参数只显示帮助。

| 命令 | 用途 |
| --- | --- |
| `/new [标题]` | 新建会话 |
| `/sessions`、`/session [ID]` | 查看、切换或显示当前会话 |
| `/model [模型 ID]` | 查看或更换后续新运行的模型 |
| `/agent 任务` | 在当前会话启用联网与本地文件/命令工具，保留目录和授权边界 |
| `/paste` | 多行输入；独立一行 `/send` 发送，`/back` 丢弃输入 |
| `/write 8000 任务`、`/interview SESSION` | 开始或继续逐问写作 |
| `/resume RUN` | 继续已保存的运行 |
| `/usage`、`/list`、`/help`、`/exit` | 用量、运行列表、帮助和退出 |

运行时按 Ctrl+C 保存暂停，然后可继续输入；提示处按 Ctrl+C 清空当前输入。多段粘贴请先输入 `/paste`，空行和段内缩进会保留；一次粘贴多行不会丢掉后续行。退出使用 `/exit`。恢复旧运行仍采用原模型与剩余额度，不受 `/model` 切换影响。

```powershell
deepwriter write "写一篇灯塔夜景故事" --target 8000
deepwriter chat "继续上一段" --session SESSION
```

采访每次显示当前问题、编号选项，支持完整文本或 `1 补充要求`，空答案/无效编号不推进。`/back` 保存后返回。假设只有明确 `accept` 才采用；`reject` 继续澄清。模型规划产生候选大纲后，必须输入完整 `confirm HASH` 确认当前版本；任何其他输入保留未确认状态，不调用正文。

确认后默认连续推进分场正文、审校与收尾，不要求每一段手动“继续”。需要人工审阅、等待授权或额度不足时暂停；尚未完成的正文保留为半成品，不假报完成。大纲中的事件过于抽象或不能绑定当前人物/事实时，也可能需要人工复核。完成检查以真实文件与内容 hash 为准。

非 TTY 不自动回答、采纳假设或确认大纲，可逐命令操作（`--json` 返回 JSON Lines）：

```powershell
deepwriter write "灯塔夜景" --target 8000 --json
deepwriter answer SESSION --question QUESTION --text "只描述景物，不新增人物" --json
deepwriter assumptions SESSION --accept --json
deepwriter outline SESSION --json
deepwriter confirm SESSION --hash HASH --json
```

`answer` 的问题 ID 必须匹配当前问题；`confirm` 的 hash 必须匹配持久化大纲。默认 stdout 显示 writer 候选正文，stderr 显示单行阶段、模型、用时、请求与 token 数；critic/规划 JSON 不混入正文。候选流可能被裁切或撤回，重定向 stdout 不能代替最终稿件。`--json` 保留事件、`content_replace`、结果和审查事实；以 `completed`、真实稿件路径及 SHA256 判定客观交付，不等于文学质量保证。

## 用模型账户查资料，用 Agent 处理本地文件

官方 DeepSeek 账户可搜索和读取公开网页；支持原生搜索的 OpenAI Responses 与 Anthropic Messages 模型可搜索并返回来源。CLI 使用本次运行选定的供应商和 Key，不借用其他搜索服务。普通聊天不默认开放本地文件或命令。需要查资料时直接提出任务，关闭联网用 `--no-web`：

```powershell
deepwriter chat "查找《乡土中国》的出版信息，附可核对的来源链接"
```

润色等文件任务直接从文件读取，要求一并写在文件内：

```powershell
deepwriter chat --input .\draft.md --no-web
```

需要读文件、整理工作目录或执行命令时，明确选择 `agent`。真实终端中运行 `deepwriter agent` 不带任务会进入持续交互，并在后续普通消息中保留本地工具；原有 `chat --tools` 仍可使用：

```powershell
deepwriter agent "在稿件里找出铜钥匙第一次出现的位置，引用前后原文" --work-dir .
deepwriter agent --input .\task.md --work-dir . --no-web
```

`agent` 在冻结的工作/文档目录内开放文件读取、搜索、写入、编辑和命令工具。每次创建、覆盖或编辑文件都须终端中明确输入 `allow`；越界写入直接拒绝。命令沿共享权限策略处理，只读命令可自动执行，删除分支等修改操作必须明确授权。提前粘贴的 `allow` 不作为之后出现的授权。非交互终端没有人工授权时拒绝敏感操作，不自动删除、提权或全部允许。

查资料时可以直接给文件名和原话，例如「在交接记录.md 找到字面原话“柜[A]+”，引用下一句，附上行号」。Agent 可在单个文件里按原文搜索，从命中位置继续读；资料只查了一部分时，搜索结果会标出来。

Word 不必先另存为 TXT。问「读 值班手册.docx，把交接步骤和对应原句列出来」，Agent 会分段读取文档文字。引用的位置是提取文本中的行，不是 Word 排版后的页码。

需要对照多份稿件时，可以说「找出 chapters 里的 Markdown 稿件，一次读前三章，核对时间线」。`find_files` 按名称或路径模式查找文件，`read_files` 在一次工具调用里分批读多份资料。返回内容带文件名；尚未读完的部分可继续读取。

处理工程包时可直接点名：「列出 素材.zip 的目录，然后读其中 notes/交接.md 的第三段」。不指定条目时列目录，指定条目后可以分段续读。也可问「预算.xlsx 的五月工作表 D17 写了什么」或「列出提案.pptx 各页标题」。表格引用保留行列地址，公式显示已有缓存值，不重新计算。EPUB 可按阅读顺序提取章节；PDF 文字层请用桌面版直接打开，扫描件需先做 OCR。

要局部改稿，可以说「只改第 5 行的称呼，其他地方别动」。要全文改名，就说「把这份稿子里的小曲全部改为小禾」。终端授权时会显示目标文件、修改范围和文字摘录。

完成后，在当前交互会话输入 `/changes`，或用 `deepwriter changes RUN` 看单次任务的记录（`list` 列出编号）。两者都读取已保存的文件工具回执，不重跑模型，也不依赖 Git。命令行工具或外部编辑器所做的改动不计入。

要用回原文，复制该条记录给出的 `undo-edit RUN TOOL` 命令，并沿用原数据目录和工作目录。查看和撤销都不需要 API Key。同一文件连改了几次，从最新一笔开始；如果当前稿件与当时的修改结果不同，命令会保留现稿。

`--no-web` 在发给模型的 schema 与真实执行两层排除网页工具，`agent --no-web` 仍保留本地工具。它关闭的是网页检索/读取工具，不阻断必需的 Provider 请求，也不是操作系统网络沙箱；你明确授权的宿主命令仍受其自身网络能力约束。

若 Provider 配置为 `supportsTools: false`，`chat` 与 `agent` 明确显示“仅文本回复”，不发送任何工具 schema，伪造工具调用也不能执行。`--tool-support` 表示明确声明服务支持工具，不会自动验证或购买服务能力。

以上默认只用于新运行。`resume` 永远沿用原冻结工具清单，旧运行不会因为升级得到联网权限，恢复时的 `--no-web`、`--tools` 或能力选项也不改写它。长文采访、规划及正文流程不自动新增联网工具；长文原有的 `--tools` 仍按原规则显式开启本地能力。

## 查看刚才引用的原文

在交互中用 `/sources` 查看本会话最近一次任务，或用 `/sources RUN` 指定任务。退出后，用同一个数据目录查询：

```powershell
deepwriter sources RUN
deepwriter sources RUN --json
```

每条摘录来自任务当时保存的工具结果，带文件路径和行段。不会重新打开文件或调用模型。JSON 中的 `range` 给出从 1 开始的行、列，结束位置不包含在摘录中，列按 Unicode 码点计。如果一页未列完，用返回的 `nextOffset` 继续：`deepwriter sources RUN --offset N`。

## 先审后改

先在稿件目录打开 PowerShell。可以把已有的写作要求导入一次，日后直接编辑本目录的 `DEEPWRITER.md`。终端和桌面共用这个普通文本文件，各自的会话仍然独立。

```powershell
deepwriter brief init --input .\写作要求.txt --work-dir .
deepwriter plan "找出第三章中视角跳到另一个人物的句子，给出修改方案" --work-dir . --no-web
```

第一条不会覆盖已有约定。第二条只读稿，结束后会打印完整的批准和拒绝命令。要改再运行它给出的 `approve RUN --hash HASH`（使用相同工作目录与数据目录），拒绝则运行 `reject-plan RUN --hash HASH`。稍后可用 `plan-info RUN` 重看方案；执行过的文件修改可用 `changes 执行运行编号` 查看。

## 从文件或管道写作，拿到最终正文

长任务和待润色稿件直接放进 UTF-8 文本文件，避免命令引号和终端编码问题：

```powershell
deepwriter chat --input .\brief.md --output .\final.md
deepwriter write --input .\brief.md --target 8000 --json
deepwriter answer SESSION --question QUESTION --input .\answer.txt --json
```

`chat`、`agent`、`write`、`interview` 均接受 `--input 文件`、任务位置的 `-` 或省略任务后从管道读取；`answer` 用 `--text -` 或 `--input 文件`。文件与任务文字不能混用。保留内部换行，输入上限 100 万 UTF-16 字符；空输入、非法 UTF-8、NUL/UTF-16 文本会在模型调用前拒绝。`-` 不从交互终端等待到 EOF，请使用管道或文件。无参数入口仍只在真实终端进入交互，不把意外管道变成付费任务。

Bash 等 UTF-8 shell 中可以串接命令；Windows PowerShell 建议使用上面的 `--input`，不依赖管道的旧版代码页：

```bash
cat brief.md | deepwriter chat - --output - > final.md
cat brief.md | deepwriter write - --target 8000 --json
```

`--output 文件|-` 适用于 `chat`、`agent`、`confirm`、`start`、`resume`。普通输出模式下不再向 stdout 打印流式候选：只有运行 `completed` 后才一次输出最终正文，`-` 写 stdout，文件路径写文件。暂停、取消或失败时不生成最终文件。输出目录须已存在，文件必须是新路径；程序在调用前检查，并以原子、独占方式发布，不覆盖已有文件或链接。

长文默认仍交付到 `--doc-dir` 的稿件文件。对话和长文完成后，都可以只导出持久化的最终正文；不需要 Key，也不再调用模型：

```powershell
deepwriter export RUN --output .\final.md
deepwriter export RUN --json
deepwriter resume RUN --output .\recovered.md
```

`export` 默认写 stdout，只接受已完成的运行；长文取已接受的正文，排除未接受候选与工具详情。保存失败后可换路径再 `export`，不必重新生成。导出副本不改变原稿件交付记录或恢复契约。

写作途中连接断开，可把已经收下的章节另存为草稿，再续写同一个任务：

```powershell
deepwriter export RUN --draft --output 半稿.md
deepwriter resume RUN
deepwriter export RUN --output 终稿.md
```

草稿不会把尚未接受的流式片段拼进正文，也不会把任务标为已完成。若正文已写完，只是文件交付失败，处理好提示的文件冲突后恢复即可，不会为同一份文字再次调用模型。

### JSON Lines 是稳定的脚本接口

`--json` 保留现有事件流，包括临时候选 `delta`、校正 `content_replace` 和运行 `result`；不会将候选误当作最终稿。配合 `--output 文件` 时，成功保存后增加一个 `export` 收据；`export RUN --json` 或 `--output - --json` 将最终正文放在 `data.content`，stdout 始终保持 JSON Lines。每行使用 CLI 信封，不是 Provider 原样响应：

```json
{"type":"export","data":{"runId":"RUN","path":null,"bytes":6,"content":"正文"}}
```

`bytes` 是实际 UTF-8 字节数；写文件时 `path` 为绝对路径且不返回 `content`。配置查询用 `type: "config"`，采访用 `type: "state"`，运行结论用 `type: "result"`；原有 `data` 字段保持不变。参数、配置或导出错误使用下列信封并退出 `1`，stderr 仍给出简短诊断：

```json
{"type":"error","data":{"code":"cli_error","message":"输出文件已存在，拒绝覆盖；请选择新路径"}}
```

## 暂停、恢复与预算

运行中 Ctrl+C 保存并暂停；另一个终端可运行 `pause RUN` 或 `cancel RUN`。控制命令记录意图，由执行进程在执行检查点处理，不直接杀 PID。暂停可恢复，取消是终态。没有执行进程时，控制意图需由下一次 `resume` 处理。

```powershell
deepwriter list
deepwriter status RUN --json
deepwriter usage RUN --json
deepwriter resume RUN
```

恢复沿用原任务的模型、端点、工作目录与完成条件。如果旧任务是因调用次数用完而暂停，用 `deepwriter resume RUN --max-calls unlimited` 解除这一个上限并继续；此前的调用、费用与其他预算仍然保留。不带该选项的普通恢复不会解除次数限制。原环境变量密钥必须仍匹配凭据指纹；显式配置源还须提供原路径。完成/失败/取消终态拒绝重放。`start SESSION` 是已确认采访契约的明确新 run 重试入口，会产生新授权预算；不是对旧运行静默续费。

升级前若旧运行指向非官方 origin、使用默认 `DEEPWRITER_API_KEY` 且未记录来源绑定，恢复前须核对原服务，再明确运行 `resume RUN --base-url 原origin --key-env DEEPWRITER_API_KEY`。只有原 origin 和原密钥指纹均匹配才发送；这次确认不更改冻结目标。旧官方运行、已明确命名的自定义变量及已有来源绑定的运行无需这道额外确认。

普通 Agent 跑着时，可以在另一个终端补充要求，不必重开。若使用了自定义 `--data-dir`，两个终端须指向同一目录。

```powershell
deepwriter steer RUN "先处理乙组；甲组的文件暂时不要改"
deepwriter steering RUN
```

新配置不设任务总预算。可选参数为 `--max-turns`、`--max-calls`、`--token-budget`、`--time-budget-ms`，以及成对使用的 `--cost-budget` 与 `--cost-currency`。比如只给本次任务设置十分钟，用 `--time-budget-ms 600000`。

新任务默认不限制 Provider 调用次数，包括模型回复、搜索及读网页。需要控制一次任务的次数时，指定 `--max-calls N`；已有配置中的有限值仍会生效。要让以后的新任务都不限制次数，运行 `deepwriter config set --max-calls unlimited`。`--token-budget N` 限制整个任务的 token 用量，`--max-tokens N` 限制单次输出，两者都不是次数上限。长文仍按大纲、字数目标与完成条件收尾。`--no-review` 明确关闭强约束审校链，不能绕过场景、客观完成和实际文件校验。

规划请求在正文 run 前发生，最多两次逻辑规划（仅 provenance 修复重试；底层还有有界网络重试）。`usage` 的正文总量来自持久化调用记录；规划只显示最近一次规划结果，不是所有规划重试的完整费用总账，不能据此计算整个采访/长文流程的费用上限。

副作用不明确时先 `recover-info RUN`，然后人工 `recover RUN --decision confirm_applied|retry_not_applied|abandon`；CLI 不自动回滚或重放未知副作用。语义不明确时 `review RUN` 查看绑定当前候选的审查包，再用 `--decision` 和 `--revision` 明确决策；不提供自动批准或任意状态 delta 编辑。

独立 `review --decision` 命令先恢复共享引擎，再提交人工决定；恢复和审批不会自动新增 Provider 请求。新审批持久化原 Provider 捕获的故事账本栅栏，并绑定候选、契约和审批 hash/revision；当前账本或候选漂移、旧审批缺少原证据时明确拒绝恢复，不用当前 head 猜测原栅栏。“接受未知”仅适用角色绑定歧义，文学性缺失 beat 可在明确允许时选择 `accept_prose_no_state`，不能降级事实或状态硬冲突。

## 文件与权限

正文文件只在共享完成契约通过后发布，发布前后核对实际内容/hash。缺失同内容稿件可补回；用户修改的同名文件、符号链接或路径不一致会拒绝，不覆盖、不伪成功。单个数据目录只允许一个执行进程；状态/用量/控制命令可从另一终端使用。

普通 `chat` 默认仅提供当前模型和账户支持的网页工具；`agent` 或 `chat --tools` 明确启用共享本地工具。`agent` 每次写入/编辑须单独授权；旧 `chat --tools` 保留原目录授权契约，范围内写入可直接执行，越界或敏感命令才询问。两条路径均保留真实路径校验、写前快照与命令检查；非 TTY 不能交互授权时拒绝需确认的操作。选择技能/插件只加入其冻结的工具声明，不隐含启用 `--tools`。CLI 不模拟 Electron 文件选择器，不提供自动“全部允许”。

CLI 使用文本终端与正文文件，不提供 GUI、附件导入、DOCX/PDF/表格导出、桌面密钥迁移、任意第三方 MCP 或后台服务。完整 Windows 包自带运行时与依赖许可证，无需安装 npm 依赖。源码 `node:sqlite` 可能显示实验性警告。

退出码：`0` 成功命令/客观完成，`1` 失败或取消，`2` 暂停、待恢复或待人工决策。`config/list/status/usage` 成功只表示查询成功，不表示其中运行已完成。

## 写作技能与第一方工具插件

`skills` / `plugins` 共用纯 Node 注册表：`catalog`、`list`、`install SOURCE`、`inspect ID`、`enable ID`、`disable ID`、`remove ID`。管理命令不需要 Provider、密钥或运行数据库，也不启动进程。安装默认 disabled，升级同样回到 disabled。默认目录是数据目录下 `extensions`；`--extensions-dir` 或 `DEEPWRITER_EXTENSIONS_DIR` 可明确与桌面共用同一个版本库，原 run 永远记录原目录和 hash。

```powershell
deepwriter skills catalog
deepwriter skills install builtin:deepwriter/structure-review
deepwriter skills enable deepwriter/structure-review
deepwriter chat "检查这段稿件的主题推进和结尾" --skill deepwriter/structure-review
deepwriter skills install builtin:deepwriter/prose-polish
deepwriter skills inspect deepwriter/prose-polish --json
deepwriter skills install .\writing-skills\my-skill
deepwriter skills catalog .\local-skill-marketplace
```

自带结构审阅和克制润色两项实际写作指令包。必须已启用且在新任务中明确 `--skill ID[,ID]` 选择；不会凭关键词自动授权。完整 `SKILL.md`、版本和资源 inventory 冻结进入 run，参考通过 `read_skill_resource` 按需读取、校验原 hash。技能 `allowed-tools` 不授权写文件或运行命令。本地 AgentSkills 子集接受 SKILL.md、references/assets 文本及许可证；脚本、二进制、符号链接、越界路径和超限包拒绝。

Claude 本地静态 marketplace 只支持有界 `name/owner/plugins` 目录，条目必须是包内相对路径；`catalog PATH` 验证并返回可明确安装的 source。插件 manifest 只接受 `name/version/description/skills` 且一个技能目录。未知组件、hooks、安装脚本、MCP 声明、command/npm/git/远程来源均拒绝，不声称全兼容。

```powershell
deepwriter plugins install builtin:deepwriter/manuscript-inspector
deepwriter plugins enable deepwriter/manuscript-inspector
$dwManuscript = (Resolve-Path -LiteralPath ".\README.md").Path
deepwriter chat "用稿件检查工具读取绝对路径 $dwManuscript，返回字符数和 SHA256" --plugin deepwriter/manuscript-inspector --allow-plugin-start deepwriter/manuscript-inspector
deepwriter plugins disable deepwriter/manuscript-inspector
deepwriter skills remove deepwriter/structure-review
```

示例用当前目录中真实存在的 README；检查自己的稿件时替换为实际文件，并保证它位于该任务的授权工作/文档目录内。插件进程的工作目录是自身入口目录，不能假定自然语言中的相对路径指向 CLI 的当前目录。

第一方 `manuscript-inspector` 是实际 Node CJS stdio 进程，采用 [MCP 2025-11-25 stdio/tools 基线](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)，不宣称全部版本兼容。启动需另行 TTY 输入 `allow` 或明确 `--allow-plugin-start ID`；安装、启用、技能指令都不能代替启动授权，非 TTY 无显式授权则拒绝。grant、实际 pid/scope 及关闭结果持久化为 run evidence；不继承 API key、PATH 或桌面凭据。

工具只读冻结工作/文档目录内 UTF-8 文件，实际返回 Unicode code-point 数及 SHA256；schema 真进入 Provider 请求，结果走原 durable toolcall 链。路径限制是已审核第一方代码约定，**没有 OS 沙箱**；任意第三方进程仍 blocked。暂停、取消和 run 结束等待实际进程退出，关闭不确定会报错及剩余 PID，不假称已关闭。每次跨进程恢复重新授权启动，不靠旧 grant 自动启动。工具拒绝可被模型处理为回答，不代表工具操作成功。

停用/卸载阻止新任务选择；旧技能内容仍可按原 pin 明确恢复。但保留字节不保留可执行许可：工具插件必须当前仍启用、未卸载且 packageHash 相同；升级、停用或卸载使旧工具 pin 拒绝执行/恢复。活动宿主每 250ms 核验持久状态，另一终端的 disable/remove 也会撤销并等待进程关闭，原 CLI run 暂停；迟到的启动确认不能越过撤权。升级/卸载不删除旧包、不替换旧 run；包缺失、变更或 schema 不一致则拒绝恢复。第一版保留历史包，不提供垃圾回收、远程下载、第三方进程或自动更新。

## 源码构建

只有开发源码时需要安装 Node.js 22.13+ 和依赖，不将以下命令当成完整包的启动步骤：

```powershell
npm ci
npm run cli:build
node out/cli/deepwriter.cjs --help
node out/cli/deepwriter.cjs --version
```

## 交互参考

交互和会话组织参考 [Pi 的交互模式](https://github.com/earendil-works/pi/blob/4954d760504c11df9b2cbdc040346107b6a8153d/packages/coding-agent/src/modes/interactive/interactive-mode.ts)与 [ZCode 的提交控制](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/tui/src/app-submit-controller.ts)。DeepWriter 保留写作专用的采访、大纲、连续正文与稿件交付流程，桌面和终端共用同一运行引擎。
