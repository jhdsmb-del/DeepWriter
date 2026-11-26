import type { CommandTemplate } from '../../shared/types'

export const COMMAND_TEMPLATES: CommandTemplate[] = [
  {
    id: 'novel',
    name: '/novel 写一章小说',
    desc: '剧情引擎写一章小说（{n} 为目标字数）',
    prompt: '请用剧情引擎写一章小说，目标 {n} 字。要求：开篇有钩子，中段有冲突升级，结尾留悬念。'
  },
  {
    id: 'renpy',
    name: '/renpy 生成 RenPy 剧本',
    desc: '为 galgame 生成 RenPy 剧本（label/场景/选项/好感度）',
    prompt: '为 galgame 生成一段 RenPy 剧本（label/场景/选项/好感度变量），配剧情起伏标注 #vibe=0-10'
  },
  {
    id: 'agent',
    name: '/agent 探索代码库',
    desc: 'Agent 模式探索工作目录并总结架构',
    prompt: '请以 Agent 模式探索工作目录：列出结构→阅读关键文件→总结架构与改进建议'
  },
  {
    id: 'review',
    name: '/review 代码审查',
    desc: '审查工作目录中的代码并给出修改建议',
    prompt: '审查工作目录中的代码：发现问题（bug/安全/性能/风格），逐条给出修改建议与文件位置'
  },
  {
    id: 'doc',
    name: '/doc 生成正式文档',
    desc: '把讨论整理成 Word/PDF/Markdown 文档',
    prompt: '把本次讨论整理成一份正式文档（Word/PDF/Markdown 均可，用文档工具生成）'
  },
  {
    id: 'summarize',
    name: '/summarize 总结会话',
    desc: '总结当前会话的任务/结论/产出/待办',
    prompt: '总结本会话的要点：任务、结论、产出文件、待办'
  }
]
