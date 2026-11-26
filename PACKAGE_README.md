# DeepWriter 完整包

在桌面或终端中对话、处理文件，从逐问澄清和大纲确认推进到连续写作与稿件交付。这个包包含同一版本的 Windows x64 桌面端、独立 CLI、Node 运行时与离线指南，不需要另外安装 Node 或 npm。

先完整解压，不要从压缩包预览窗口运行。版本以 `complete-manifest.json` 和实际文件名为准；两端共用引擎，但默认独立保存会话、配置和凭据，不会自动互相导入数据。

[本版更新](docs/RELEASE_NOTES_8.0.0.md) · [桌面指南](docs/QUICKSTART.md) · [终端指南](docs/CLI.md)

## 先玩一个故事

打开 Galgame 工作室，导入 `examples/last-ferry`。点「剧情与分支」可以先看两个选择；选好 SDK 后，点「试玩原项目」亲自走到结局。你也可以在终端运行 `.\cli\deepwriter.cmd galgame routes .\examples\last-ferry`。

## Desktop：三步开始

1. 打开 `desktop` 文件夹：双击 `DeepWriter-<版本>-x64-setup.exe` 安装，或直接运行 `DeepWriter-<版本>-x64-portable.exe`。`<版本>` 替换为包内实际版本。
2. 在设置中配置服务商、精确模型 ID 和 API Key。在输入框旁选择工作目录、核对权限，先让 Agent 读取并解释文件。选定工作区后，日常读写不必逐次确认；涉及覆盖原件或运行命令时，再决定是否允许。
3. 进入“长文”，输入任务与目标字数，按 Grill Me 逐问澄清，回顾事实和待采用假设，确认当前大纲。默认连续写正文、审校和收尾，需要人工判断或触及预算边界时才暂停；完成后核对真实稿件路径与内容。

想先看方案，用输入框的「更多工具 → 只读审阅」；满意再点「批准执行」。人物设定和文风可以放在「设置 → 项目约定」，桌面和 CLI 选同一个稿件目录即可共用。

在回复下展开「文件来源」，可核对 Agent 读到的路径、行号和当时原文；终端用 `deepwriter sources RUN`。长文中断时可先另存已收稿的部分，恢复原任务后接着写。

拖入 ZIP 即可查看工程目录并选读文件。需要查网页时，用地球图标开启当前供应商的联网服务；不支持的模型显示「未联网」。模型和思考强度在输入框底部的同一入口；上下文自动跟随所选模型。生成时，输入框底部显示输出速度和本次请求的缓存命中率。未用到的辅助模型无需先配置，缺参考价也不再逐条确认。详细操作见 [桌面快速开始](docs/QUICKSTART.md)。

## CLI：三步开始

1. 在解压目录打开 PowerShell，检查实际版本和命令：

   ```powershell
   .\cli\deepwriter.cmd --version
   .\cli\deepwriter.cmd --help
   ```

2. 通过当前终端的 `DEEPWRITER_API_KEY` 提供 Key，不写入命令历史或普通配置：

   ```powershell
   $dwKey = Read-Host "DeepWriter API Key" -AsSecureString
   $env:DEEPWRITER_API_KEY = [System.Net.NetworkCredential]::new("", $dwKey).Password
   .\cli\deepwriter.cmd config set --base-url https://api.deepseek.com --model deepseek-flash
   ```

3. 从一个 Agent 任务开始，再试试长文：

   ```powershell
   .\cli\deepwriter.cmd agent "读取 README.md，概括这个完整包的用途" --work-dir .
   .\cli\deepwriter.cmd write "写一篇克制的灯塔夜景故事，不新增人物" --target 8000
   ```

保留整个 `cli` 目录，启动器需要旁边的 `runtime`；不要只复制 `deepwriter.cmd` 或 `deepwriter.cjs`。CLI 不会读取桌面 API Key，Key 保留在当前终端进程环境中，用完可运行 `Remove-Item Env:DEEPWRITER_API_KEY`。默认数据目录是当前目录下 `.deepwriter-cli`，稿件位于其中的 `documents`；可用 `--data-dir`、`--work-dir`、`--doc-dir` 指定。

无参数启动器进入持续聊天；`/new` 新建会话，`/sessions` 查看会话，`/session ID` 切回历史，`/model ID` 更换后续运行的模型，`/help` 查看命令。Ctrl+C 保存暂停后返回输入，`/exit` 退出。长文经逐问澄清和大纲确认后连续推进，`/back` 可保存采访并返回。

`--tools` 开启工具，文件与命令仍按工作目录和权限处理。`list`、`status RUN`、`usage RUN`、`resume RUN` 可查看和恢复任务；恢复保留原模型与剩余额度。自定义 Base URL 可直接带 `/v1`，详细操作见 [CLI 指南](docs/CLI.md)。

## 扩展与用量

“设置 → 扩展”提供结构审阅、克制润色技能和第一方稿件检查工具；CLI 用 `skills catalog` / `plugins catalog` 查看。安装与升级默认禁用，启用后还须在新任务中选择；工具进程另需启动授权。可导入受限本地技能指令与文本资源，不支持任意第三方进程、远程下载、hooks 或安装脚本。停用或卸载撤销执行许可，插件没有 OS 沙箱。

模型请求由所选服务商处理并计费。参考价用于展示，缺失用量或金额保留未知，不记作零；请求数和 token 上限仍会限制每次运行。

流式正文是候选，可能替换或撤回；仅完成状态和真实稿件路径/hash 表示客观交付，不等于文学质量保证。恢复不会静默换模型、扩大预算或覆盖用户修改过的同名稿件。升级或备份前处理任务和草稿，正常退出，再保存完整数据目录与外部稿件。

## 指南和校验

- [桌面快速开始](docs/QUICKSTART.md)
- [CLI 指南](docs/CLI.md)
- [备份、恢复和故障处理](docs/OPERATIONS.md)
- [隐私说明](docs/PRIVACY.md)与[安全边界](SECURITY.md)
- [技能与插件的格式和安全边界](docs/EXTENSIONS_RESEARCH.md)
- [服务商支持与协议边界](docs/PROVIDER_EXPANSION_RESEARCH.md)

下载时核对压缩包旁的 SHA-256 清单；解压后，`complete-manifest.json` 记录版本、源码提交和文件哈希，`SHA256SUMS.txt` 记录包内文件哈希。GitHub 发行包还附有对应制品的安装记录。仓库保持私有，重新下载需要有访问权限的 GitHub 账户。

项目自有代码采用 [MIT 许可证](LICENSE)；桌面与 CLI 的第三方通知、运行时许可和分发库存一并保留。凭据保护不等于整个数据目录加密；不要上传真实 Key、私人资料或完整用户目录。
