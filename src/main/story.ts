import { GENRES, INTENSITY_LEVELS, STRUCTURE_NAMES, OUTPUT_FORMAT_NAMES } from '../shared/types'
import type { StoryConfig } from '../shared/types'

export { GENRES, INTENSITY_LEVELS, STRUCTURE_NAMES, OUTPUT_FORMAT_NAMES }

const RENPY_SYNTAX = `Ren'Py 脚本语法规范（Ren'Py 8.5.3，基于 Python 3）：
- 基础：Ren'Py 8 基于 Python 3 语法；.rpy 文件按 label 组织场景，脚本注释用 #
- define 声明：角色与常量用 define 声明，如 define sara = Character("莎拉")；好感度等运行期可变/需存档变量用 default sara_affection = 0（define 仅用于常量/初始化期，运行期变量用 default 才能正确存档与回滚）
- label scene1: —— 定义场景节点，用 scene_01、scene_02... 顺序编号
- transform 定义动画：transform float_up: linear 2.0 yoffset -30，然后在 show 中引用 show sara at float_up
- scene bg_beach_day with dissolve —— 背景切换（建议 JPG 背景，bg_场景_时段.jpg 命名，如 bg_beach_day.jpg）
- show sara happy at center with dissolve —— 立绘显示（建议 PNG 立绘，角色-表情命名，如 sara_happy.png；位置用 at left/center/right）
- sara "你好呀！" —— 角色台词；旁白用 narrator "..." 或 e "..."
- play music "bgm_sweet.ogg" loop / play sound "sfx_wave.ogg" —— 音乐（OGG 推荐，loop 参数循环播放）与音效
- menu: 选项（分支）：
  menu:
    "约她去看海":
        jump route_sara_01
    "留在教室":
        jump route_common_01
- $ sara_affection += 1 —— 好感度变量增减（menu 选项内；default 声明的运行期变量可改、可存档、可回滚）
- jump label / call label —— 跳转与调用场景（call 会返回）
- "旁白内容" —— 无引号前缀的叙述
- 每段场景标注感情起伏强度值，格式：#vibe=8（0-10），表示当前段落情绪强度
- 素材规范：立绘用 PNG（角色-表情-服装命名，如 sara_happy_夏装.png）、背景用 JPG（bg_场景_时段.jpg）、音乐音效用 OGG`

const GALGAME_WORKFLOW = `【Galgame 素材工作流】
创作剧本时同步规划素材需求，在剧本中标注并在结尾输出【素材需求】清单：
- 立绘：角色-表情-服装.png（如 sara_happy.png）
- 背景：bg_场景_时段.jpg（如 bg_beach_day.jpg）
- 音乐：bgm_氛围.ogg（如 bgm_sweet.ogg），play music 引用
- 音效：sfx_事件.ogg
用户已提供素材时（通过附件导入），直接引用其文件名；未提供的在【素材需求】中列出，供用户准备。`

const THREE_ACT = `三幕结构骨架（每幕内部再按"起-升-转-落"推进）：
- 第一幕 · 建立（约 25%）：引入主角与目标，埋设伏笔与悬念钩子，结尾出现"激励事件"打破平衡
- 第二幕 · 对抗（约 50%）：主角多次尝试-失败-升级，冲突螺旋上升，情绪高点出现在幕末
- 第三幕 · 收束（约 25%）：最高潮（情绪峰值 10）后快速收束，伏笔回收，留有余韵`

export function buildEmotionCurve(intensity: StoryConfig['intensity'], targetLengthChars: number): number[] {
  const segs = 12
  const base: Record<string, number[]> = {
    calm: [3, 3, 4, 4, 5, 4, 5, 5, 4, 4, 5, 4],
    standard: [2, 3, 5, 6, 4, 6, 7, 5, 8, 7, 5, 4],
    intense: [2, 4, 7, 8, 5, 7, 9, 6, 10, 8, 6, 5],
    turbulent: [1, 5, 3, 8, 2, 9, 4, 10, 3, 8, 5, 2]
  }
  return base[intensity] ?? base.standard
}

/**
 * 生成剧情引擎系统提示词：放入固定前缀最前，天然命中 KV 缓存
 */
export function buildStorySystemPrompt(cfg: StoryConfig, targetChars: number, galgame?: { enabled: boolean }): string {
  if (!cfg.enabled) return ''
  const curve = buildEmotionCurve(cfg.intensity, targetChars)
  const lines: string[] = []
  lines.push('# 剧情引擎（Story Engine）')
  lines.push(`体裁：${cfg.genre} | 情绪基调：${cfg.tone || '未指定（自行把握）'}`)
  lines.push(`结构：${STRUCTURE_NAMES[cfg.structure]} | 起伏强度：${INTENSITY_LEVELS[cfg.intensity].label}（${INTENSITY_LEVELS[cfg.intensity].desc}）`)
  lines.push(`目标篇幅：严格 ${targetChars} 字（按 Unicode code point 计数；必须自然写到目标，不要回复“字数不足”）`)
  if (cfg.structure === 'three-act') lines.push(THREE_ACT)
  if (cfg.structure === 'kishotenketsu') {
    lines.push('起承转合四段骨架：起（让场景与人物自然显影）、承（展开细节与关系）、转（按题材选择变化、发现或冲突）、合（收住当前叙事，让余味来自人物和场景；用户未要求时不拔高主题）')
  }
  lines.push(`情绪曲线参考（按篇幅等分为 ${curve.length} 段，每段 0-10 的情绪目标强度）：${curve.join(' → ')}`)
  lines.push('创作策略（按本次题材取舍，不要机械套模板）：')
  lines.push('1. 先写可感知的场景、人物动作与具体选择；需要悬念时再使用信息差，不按固定字数塞钩子')
  lines.push('2. 让节奏跟随事件和人物状态变化；高潮可以放慢，安静段落也允许停顿、留白与不解释')
  lines.push('3. 对话保留各自的声音、停顿和言外之意；日常对白只要真实推动关系，也不必句句制造冲突')
  lines.push('4. 只回收确实重要的伏笔，揭示方式服从人物当下感受，不强求反转或统一的惊叹效果')
  lines.push('5. 结尾应从场景、动作或声音中自然收束；除非用户明确要求，不替故事总结道理或扩大价值判断')
  if (cfg.characters.length > 0) {
    lines.push('')
    lines.push('## 角色设定卡')
    for (const c of cfg.characters) {
      lines.push(`- ${c.name}（${c.role}）：性格 ${c.traits}；动机 ${c.motivation}；说话风格 ${c.voice}`)
    }
    lines.push('角色塑造纪律：每个角色必须有独立的声音与语癖，行为符合动机，好感度与关系变化要有渐变过程')
  }
  if (cfg.worldSetting.trim()) {
    lines.push('')
    lines.push(`## 世界观设定\n${cfg.worldSetting.trim()}`)
    lines.push('设定纪律：设定服务于故事，不堆砌设定说明，通过事件与对话自然呈现')
  }
  lines.push('')
  if (cfg.outputFormat === 'renpy') {
    lines.push(`## 输出格式：Ren'Py 剧本\n${RENPY_SYNTAX}`)
  } else if (cfg.outputFormat === 'scene') {
    lines.push('## 输出格式：分镜脚本\n每段包含：场景编号、地点/时间、人物状态、剧情梗概、情绪强度 #vibe=0-10、具体对白与动作描写')
  } else {
    lines.push('## 输出格式：小说正文\n直接输出正文，不输出标题与说明文字。')
  }
  if (galgame?.enabled) {
    lines.push('')
    lines.push(GALGAME_WORKFLOW)
  }
  return lines.join('\n')
}

export function estimateCharsPerToken(): number {
  return 2.2
}
