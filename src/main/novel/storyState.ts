// ==================== Novel 场景级工作流：故事状态 ====================

export interface CharacterState {
  id: string
  name: string
  status: string
  goals: string[]
  relationships: Record<string, string>
  lastSceneId?: string
  facts: { text: string; sceneId: string }[]
}

export interface EventRecord {
  id: string
  text: string
  sceneId: string
}

export interface Foreshadow {
  id: string
  text: string
  plantedSceneId: string
  resolvedSceneId?: string
}

export interface WorldRule {
  id: string
  text: string
}

export interface SceneCard {
  id: string
  sceneNo: number
  title: string
  chars: string[]
  facts: string[]
  emotionArc: string[]
  wordTarget: number
  status: 'planned' | 'drafting' | 'committed'
  version: number
}

export interface StoryBible {
  projectId: string
  title: string
  characters: Record<string, CharacterState>
  events: EventRecord[]
  foreshadows: Foreshadow[]
  worldRules: WorldRule[]
  scenes: SceneCard[]
  updatedAt: number
}

export function createBible(projectId: string, title: string): StoryBible {
  return { projectId, title, characters: {}, events: [], foreshadows: [], worldRules: [], scenes: [], updatedAt: Date.now() }
}

export function addScene(bible: StoryBible, input: { title: string; chars?: string[]; facts?: string[]; emotionArc?: string[]; wordTarget: number }): SceneCard {
  const scene: SceneCard = {
    id: `scene_${bible.scenes.length + 1}`,
    sceneNo: bible.scenes.length + 1,
    title: input.title,
    chars: input.chars ?? [],
    facts: input.facts ?? [],
    emotionArc: input.emotionArc ?? [],
    wordTarget: input.wordTarget,
    status: 'planned',
    version: 0
  }
  bible.scenes.push(scene)
  for (const name of scene.chars) {
    if (!bible.characters[name]) {
      bible.characters[name] = { id: `char_${name}`, name, status: '出场', goals: [], relationships: {}, facts: [] }
    }
  }
  bible.updatedAt = Date.now()
  return scene
}

export function autoPlanScenes(projectId: string, title: string, targetChars: number, notes: string): StoryBible {
  const bible = createBible(projectId, title)
  const count = Math.max(3, Math.min(20, Math.round(targetChars / 2500)))
  const per = Math.round(targetChars / count)
  for (let i = 1; i <= count; i++) {
    addScene(bible, { title: `第${i}章`, wordTarget: per })
  }
  if (notes.trim()) {
    const m = notes.match(/[（(【\[]([^）)】\]]+)[）)】\]]/g)
    if (m) {
      bible.characters[notes.slice(0, 8)] = { id: 'char_notes', name: '设定', status: '参考', goals: [notes.slice(0, 100)], relationships: {}, facts: [] }
    }
  }
  return bible
}

const STATE_VERBS = ['变成', '成为', '离开', '回到', '决定', '答应', '拒绝', '醒来', '倒下', '死去', '重逢', '释怀']
const FORESHADOW_MARK = /【伏笔】|伏笔[:：]|预示|暗示/

export function applySceneCommit(bible: StoryBible, scene: SceneCard, text: string): void {
  scene.status = 'committed'
  scene.version += 1
  bible.updatedAt = Date.now()
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  for (const name of scene.chars) {
    const char = bible.characters[name]
    if (!char) continue
    char.lastSceneId = scene.id
    for (const line of lines) {
      if (line.includes(name) && STATE_VERBS.some((v) => line.includes(v))) {
        char.status = line.slice(0, 60)
      }
    }
    if (char.facts.length < 8 && lines.length > 0) {
      char.facts.push({ text: lines[0].slice(0, 80), sceneId: scene.id })
    }
  }
  for (const line of lines) {
    if (FORESHADOW_MARK.test(line)) {
      bible.foreshadows.push({ id: `fs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`, text: line.slice(0, 120), plantedSceneId: scene.id })
    }
  }
  bible.events.push({ id: `ev_${bible.events.length + 1}`, text: lines[0]?.slice(0, 100) ?? '', sceneId: scene.id })
}

export function getContinuityContext(bible: StoryBible, scene: SceneCard): string {
  const parts: string[] = []
  if (scene.chars.length > 0) {
    parts.push('## 当前人物状态')
    for (const name of scene.chars) {
      const c = bible.characters[name]
      if (c) parts.push(`- ${name}：${c.status}；近期事实：${c.facts.slice(-3).map((f) => f.text).join('；') || '无'}`)
    }
  }
  const recentEvents = bible.events.slice(-4)
  if (recentEvents.length > 0) {
    parts.push('## 最近事件')
    for (const e of recentEvents) parts.push(`- ${e.text}`)
  }
  const pending = bible.foreshadows.filter((f) => !f.resolvedSceneId).slice(0, 4)
  if (pending.length > 0) {
    parts.push('## 未回收伏笔')
    for (const f of pending) parts.push(`- ${f.text}`)
  }
  if (bible.worldRules.length > 0) {
    parts.push('## 世界规则')
    for (const r of bible.worldRules) parts.push(`- ${r.text}`)
  }
  if (scene.facts.length > 0) {
    parts.push(`## 本场景必须包含的事实\n${scene.facts.map((f) => `- ${f}`).join('\n')}`)
  }
  return parts.join('\n')
}
