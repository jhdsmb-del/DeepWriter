import { promises as fs } from 'fs'
import * as path from 'path'
import type { Preset } from '../shared/types'

const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'preset_novel_chapter',
    name: '小说 · 写一章',
    desc: '以剧情引擎写一章小说（复用你的体裁/起伏/结构设置）',
    prompt: '请以剧情引擎设置写一章小说，目标 {n} 字。要求：开篇有钩子，中段冲突升级，结尾留悬念；人物行为符合设定。',
    builtin: true,
    longMode: true,
    category: '创作'
  },
  {
    id: 'preset_novel_short',
    name: '小说 · 短篇成稿',
    desc: '一次性生成完整短篇（3000-8000 字）',
    prompt: '请写一篇完整的短篇小说，目标 {n} 字：单线剧情、一个核心冲突、一个有回味的结尾。直接输出正文。',
    builtin: true,
    longMode: true,
    category: '创作'
  },
  {
    id: 'preset_scene_desc',
    name: '创作 · 场景描写',
    desc: '专注一段场景的环境/氛围描写',
    prompt: '请为当前故事写一段场景描写（环境、氛围、感官细节），约 500-1000 字，与剧情引擎设定保持一致。',
    builtin: true,
    category: '创作'
  },
  {
    id: 'preset_dialogue',
    name: '创作 · 对白戏',
    desc: '生成一段有张力的对白场景',
    prompt: '请写一段人物对白戏：台词要有潜台词，体现人物性格与关系张力，约 800-1500 字。',
    builtin: true,
    category: '创作'
  },
  {
    id: 'preset_plot_outline',
    name: '创作 · 情节大纲',
    desc: '为故事生成分章节大纲与伏笔安排',
    prompt: '为当前故事生成详细的分章节大纲：每章目标、关键事件、伏笔埋设与回收安排、情绪曲线分布。',
    builtin: true,
    category: '创作'
  },
  {
    id: 'preset_renpy_scene',
    name: 'RenPy · 场景剧本',
    desc: '生成一段 Ren' + "'" + 'Py 8.5.3 剧本（含素材需求清单）',
    prompt: '为当前 galgame 项目生成一段 Ren' + "'" + 'Py 剧本（label/scene/show/菜单选项/好感度变量），标注 #vibe 情绪值，结尾输出【素材需求】清单。',
    builtin: true,
    category: 'RenPy'
  },
  {
    id: 'preset_renpy_lint_fix',
    name: 'RenPy · 修复 lint 错误',
    desc: '让 Agent 扫描项目并修复语法问题',
    prompt: '请以 Agent 模式检查当前 Ren' + "'" + 'Py 项目：先扫描脚本，再运行语法检查，定位并修复发现的问题，修复后再次检查确认。',
    builtin: true,
    category: 'RenPy'
  },
  {
    id: 'preset_agent_explore',
    name: 'Agent · 探索项目',
    desc: '列出结构、阅读关键文件、总结架构',
    prompt: '请以 Agent 模式探索工作目录：列出结构 → 阅读关键文件 → 总结架构与改进建议。',
    builtin: true,
    category: 'Agent'
  },
  {
    id: 'preset_agent_review',
    name: 'Agent · 代码审查',
    desc: '审查代码，逐条给出问题与修改建议',
    prompt: '请审查工作目录中的代码：找出问题（bug/安全/性能/风格），逐条给出文件位置与修改建议。',
    builtin: true,
    category: 'Agent'
  },
  {
    id: 'preset_agent_build',
    name: 'Agent · 实现功能',
    desc: '让 Agent 自主完成一个功能开发任务',
    prompt: '请完成以下功能开发任务：先制定计划，再逐步实现（文件修改带 diff 展示），最后验证。任务描述：',
    builtin: true,
    category: 'Agent'
  },
  {
    id: 'preset_doc_report',
    name: '文档 · 生成报告',
    desc: '把讨论整理成正式文档（Word/PDF/Markdown）',
    prompt: '请把本次会话的要点整理成一份正式报告，并用文档工具生成（Markdown/Word/PDF 均可）。',
    builtin: true,
    category: '文档'
  },
  {
    id: 'preset_doc_summarize',
    name: '文档 · 会话总结',
    desc: '总结任务、结论、产出文件与待办',
    prompt: '请总结本会话：任务、结论、产出文件、待办事项。',
    builtin: true,
    category: '文档'
  }
]

export interface PresetModule {
  list(): Promise<Preset[]>
  save(preset: Preset): Promise<Preset[]>
  remove(id: string): Promise<Preset[]>
}

export function createPresetModule(baseDir: string): PresetModule {
  const userFile = path.join(baseDir, 'presets.json')

  async function readUser(): Promise<Preset[]> {
    try {
      const raw = JSON.parse(await fs.readFile(userFile, 'utf-8'))
      return Array.isArray(raw) ? raw.filter((p) => p && typeof p.prompt === 'string') : []
    } catch {
      return []
    }
  }
  async function writeUser(list: Preset[]): Promise<void> {
    await fs.mkdir(path.dirname(userFile), { recursive: true })
    const tmp = userFile + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf-8')
    await fs.rename(tmp, userFile)
  }

  return {
    async list() {
      return [...BUILTIN_PRESETS, ...(await readUser())]
    },
    async save(preset) {
      const user = await readUser()
      const idx = user.findIndex((p) => p.id === preset.id)
      if (idx >= 0) user[idx] = { ...preset, builtin: false }
      else user.unshift({ ...preset, id: preset.id || `preset_${Date.now().toString(36)}`, builtin: false })
      await writeUser(user)
      return [...BUILTIN_PRESETS, ...user]
    },
    async remove(id) {
      const user = await readUser()
      await writeUser(user.filter((p) => p.id !== id))
      return [...BUILTIN_PRESETS, ...(await readUser())]
    }
  }
}
