import type { CliOptions } from './config'

declare const __DEEPWRITER_VERSION__: string
export const HELP = `DeepWriter CLI ${__DEEPWRITER_VERSION__} · Node 22.13+
用法：deepwriter <命令> [参数] [选项]
无参数交互终端：持续聊天（默认联网）；/write 字数 任务 可进入逐问长文。

galgame routes <项目目录> [--json]    查看 Ren’Py 剧情节点、玩家选项和跳转位置
brief show | brief init [--input 文件]  查看或创建当前工作目录的写作约定（DEEPWRITER.md）
config [show|set]                    查看/保存非密钥 Provider 配置
chat [任务或 -] [--session ID]      流式对话（默认联网）；--input 文件 或管道读取任务
agent [任务或 -] [--work-dir 路径]   联网+本地文件/命令；终端无任务时持续交互
plan [任务或 -]                    只读查稿，保存方案；不写盘、不执行命令或扩展
plan-info <RUN>                    查看已保存方案和批准身份
approve <RUN> --hash HASH          明确批准保存的方案，新 Agent 按正常授权执行
reject-plan <RUN> --hash HASH      拒绝保存的方案，不能随后直接批准
write [任务或 -] --target 字数           采访→大纲→显式确认→连续正文；非TTY先返回采访
interview <任务> --target 字数       新建采访（与 write 的非TTY入口相同）
answer <SESSION> --question ID --text 答案 [--decision answer|decide|not_applicable]
assumptions <SESSION> --accept|--reject   明确处理待采用假设
outline <SESSION>                  用配置的模型生成候选大纲，不自动确认
confirm <SESSION> --hash HASH       确认当前大纲并执行正文
start <SESSION>                    已确认契约的明确重试入口（新run）
resume <RUN> [--max-calls unlimited] 恢复原配置；明确解除本任务调用次数限制
pause|cancel <RUN>                 暂停可恢复 / 取消终态（运行中可从另一终端发送）
steer <RUN> "补充指令"             普通工作 Agent 下次安全调用时按序处理；可从另一终端发送
steering <RUN>                     查看补充指令及待处理状态；steer --request-id ID 可幂等重试
list | status [RUN|SESSION] | usage [RUN]
sources <RUN> [--offset N]          查看任务读过的原文、出处和摘录；交互中 /sources [RUN]
changes <RUN>                      查看实际文件改动、工具编号与可撤销状态；交互中 /changes [RUN]
undo-edit <RUN> <TOOL>              本地撤销这一笔改稿（无需密钥）；有后续改动时拒绝覆盖
export <RUN> [--draft] [--output 文件|-] 导出成稿；--draft 只取已收稿部分，不新增模型调用
skills|plugins catalog|list|install SOURCE|enable ID|disable ID|remove ID|inspect ID
recover-info <RUN> | recover <RUN> --decision confirm_applied|retry_not_applied|abandon
review <RUN> [--decision accept_unknown|accept_prose_no_state|reject_rewrite|abandon --revision N]

选项：--data-dir 路径 --config 显式JSON文件 --base-url origin或API地址 --chat-path 路径
      --model 名称 --protocol deepseek-chat|openai-chat|openai-responses|anthropic-messages
      --auth-header 名称（只配置头名，密钥仍取独立环境变量或显式配置）
      --key-env 环境变量名 --max-tokens N --context N --max-calls N|unlimited（默认不限） --token-budget N|unlimited（默认不限）
      --max-turns N|unlimited --time-budget-ms N|unlimited（默认均不限）
      --cost-budget 金额|unlimited --cost-currency 币种（默认不设金额上限；设限时未知报价拒绝）
      --input UTF-8文件 --output 文件|-（仅最终正文，不覆盖文件）
      --web|--no-web（新chat/agent开启/关闭联网，可随config保存） --tool-support|--no-tool-support（服务能力）
      --work-dir 路径 --doc-dir 路径 --tools --no-review --json --loopback|--no-loopback
      --thinking|--no-thinking --effort default|low|high|max（默认由模型决定）
      --thinking-budget N（仅 Anthropic 显式预算，须低于 --max-tokens）
      --accept-unknown-cost（兼容选项；费用未知，不保证金额上限）
      --extensions-dir 路径 --skill ID[,ID] --plugin ID[,ID]
      --allow-plugin-start ID[,ID]（另行启动授权；没有OS沙箱；第三方进程blocked）
默认DEEPWRITER_API_KEY仅用于官方origin；其他服务显式 --key-env NAME，或用对应的 --config apiKey。
本地免密不自动携带官方Key；不读取桌面密钥，config set不保存密钥值。
Ctrl+C 暂停当前运行。流式候选可能撤回；仅 completed + 文件产物表示长文交付完成。
`
const FLAGS = new Set(['draft', 'json', 'loopback', 'no-loopback', 'tools', 'no-review', 'thinking', 'no-thinking', 'accept-unknown-cost', 'web', 'no-web', 'tool-support', 'no-tool-support', 'accept', 'reject', 'help', 'version'])
const VALUES = new Set(['offset', 'data-dir', 'config', 'base-url', 'chat-path', 'model', 'protocol', 'key-env', 'max-tokens', 'context', 'max-calls', 'max-turns', 'token-budget', 'time-budget-ms', 'cost-budget', 'cost-currency', 'work-dir', 'doc-dir', 'session', 'target', 'question', 'text', 'decision', 'hash', 'revision', 'effort', 'extensions-dir', 'skill', 'plugin', 'allow-plugin-start', 'auth-header', 'input', 'output'])
export function parse(args: string[]): { args: string[]; options: CliOptions } {
  VALUES.add('request-id'); VALUES.add('thinking-budget')
  const values: string[] = []; const options: CliOptions = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') { values.push(...args.slice(index + 1)); break }
    if (!arg.startsWith('--')) { values.push(arg); continue }
    const [name, ...parts] = arg.slice(2).split('=')
    if (FLAGS.has(name)) {
      if (parts.length) throw new Error(`--${name} 不接受值`)
      options[name] = true
    } else if (VALUES.has(name)) {
      const value = parts.length ? parts.join('=') : args[++index]
      if (!value || value.startsWith('--')) throw new Error(`--${name} 缺少值`)
      options[name] = value
    } else throw new Error(`未知选项：--${name}`)
  }
  return { args: values, options }
}
export function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少${label}`)
  return value.trim()
}
export function integer(value: unknown, label: string, min = 1, max = 20_000_000): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label}必须为${min}–${max}的整数`)
  return parsed
}
