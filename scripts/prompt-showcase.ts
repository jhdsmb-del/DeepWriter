import { buildStorySystemPrompt } from '../src/main/story'
import { buildNovelRequest } from '../src/main/novel'
import { CONTINUE_SYSTEM_FOR_SHOW } from './prompt-shared'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

const out: string[] = []

out.push('=====================================================================')
out.push('模式 1：剧情引擎 — Galgame 恋爱日常 / 剧烈起伏 / 三幕结构 / 小说正文')
out.push('=====================================================================')
out.push(
  buildStorySystemPrompt(
    {
      enabled: true,
      genre: 'Galgame 恋爱日常',
      intensity: 'intense',
      structure: 'three-act',
      outputFormat: 'novel',
      tone: '温暖中带着苦涩',
      characters: [
        { name: '林默', role: '男主', traits: '内敛、倔强、行动派', motivation: '兑现童年约定', voice: '话少但句句有分量' },
        { name: '苏晚', role: '女主', traits: '温柔、藏着心事、勇敢', motivation: '弥补当年的不辞而别', voice: '轻声细语，关键时刻很坚定' }
      ],
      worldSetting: '北方滨海小城，主角在海边打工，经营一家旧书店。'
    },
    8000,
    { enabled: false }
  )
)

out.push('')
out.push('=====================================================================')
out.push('模式 2：剧情引擎 — RenPy 8.5.3 剧本输出 + Galgame 素材工作流（galgame.enabled）')
out.push('=====================================================================')
out.push(
  buildStorySystemPrompt(
    {
      enabled: true,
      genre: 'Galgame 恋爱日常',
      intensity: 'standard',
      structure: 'three-act',
      outputFormat: 'renpy',
      tone: '夏日青春',
      characters: [{ name: '千夏', role: '女主', traits: '元气少女', motivation: '完成海边约定', voice: '活泼、爱用感叹号' }],
      worldSetting: '海之约：海边小镇的夏日祭。'
    },
    6000,
    { enabled: true }
  )
)

out.push('')
out.push('=====================================================================')
out.push('模式 3：小说模式（一键成书）— 实际发给模型的完整请求')
out.push('=====================================================================')
const novelMsgs = buildNovelRequest(
  '【用户】写一个青梅竹马的短篇，主角叫林默，女主叫苏晚。\n【AI】好的。设定：两人小时候约定长大后一起去海边。\n【用户】加个转折：高三那年苏晚家搬走了。'
)
for (const m of novelMsgs) {
  out.push(`[${m.role}]\n${m.content}`)
}

out.push('')
out.push('=====================================================================')
out.push('模式 4：超长输出续写 — 截断后自动续写的 system 指令')
out.push('=====================================================================')
out.push(CONTINUE_SYSTEM_FOR_SHOW)

out.push('')
out.push('=====================================================================')
out.push('模式 5：记忆层 — 项目 AGENTS.md 注入的 system 消息格式（buildContext 前缀规则）')
out.push('=====================================================================')
out.push('## 项目记忆（{AGENTS.md 路径}）\n{AGENTS.md 内容，截断 100KB}\n')
out.push('## 之前对话的摘要（作为压缩记忆）\n{自动摘要，旧消息超出预算时生成}')

fs.writeFileSync(path.join(__dirname, '..', 'out', 'prompt-showcase.txt'), out.join('\n'), 'utf-8')
console.log('written out/prompt-showcase.txt,', out.join('\n').length, 'chars')
