/** A deliberately small production dialect. Generic scene/repair patches retain
 * their existing contract; Studio accepts only inspectable story control flow. */
export interface StudioStoryContract {
  header: string
  entryLabel: string
  sceneLabels: string[]
  characters: string[]
  images: string[]
  audio: string[]
}

function stripComment(line: string): string {
  let quote = '', escaped = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") quote = char
    else if (char === '#') return line.slice(0, i).trimEnd()
  }
  return line.trimEnd()
}

export function validateStudioStory(raw: string, contract: StudioStoryContract): string | null {
  if (!raw.startsWith(contract.header)) return '角色与素材声明被修改，候选稿未发布'
  const blocks = new Map<string, string[]>()
  let current: string | null = null
  const quoted = '"(?:[^"\\\\]|\\\\.)*"'
  const say = new RegExp(`^(?:([A-Za-z_]\\w*)\\s+)?(${quoted})$`)
  const option = new RegExp(`^(${quoted}):$`)
  let dialogue = 0
  for (const original of raw.slice(contract.header.length).split(/\r?\n/)) {
    const line = stripComment(original)
    if (!line.trim()) continue
    if (line.includes('\t')) return '候选稿包含 Tab 缩进，请使用四空格缩进'
    const label = /^label ([A-Za-z_]\w*):$/.exec(line)
    if (label) {
      if (!label[1].startsWith(contract.entryLabel.replace(/start$/, ''))) return `候选稿 label 不在本次命名空间：${label[1]}`
      if (blocks.has(label[1])) return `候选稿重复 label：${label[1]}`
      current = label[1]; blocks.set(current, []); continue
    }
    if (!current || !/^ {4}/.test(line)) return `候选稿有未归属场景的语句：${line.trim().slice(0, 60)}`
    blocks.get(current)!.push(line)
  }
  for (const label of [contract.entryLabel, ...contract.sceneLabels]) if (!blocks.has(label)) return `候选稿缺少大纲场景：${label}`
  const edges = new Map<string, string[]>()
  const prose = new Map<string, string[]>()
  const menus: Array<Array<{ text: string; lines: string[] }>> = []
  const endings = new Set<string>()
  for (const [label, lines] of blocks) {
    const jumps: string[] = [], words: string[] = []
    let cursor = 0
    const sequence = (indent: number): { terminal: boolean; error?: string } => {
      let terminal = false
      while (cursor < lines.length) {
        const line = lines[cursor], width = line.length - line.trimStart().length, text = line.trim()
        if (width < indent) break
        if (width !== indent) return { terminal, error: `缩进错误：${text}` }
        if (terminal) return { terminal, error: `跳转或结束后的不可达语句：${text}` }
        cursor++
        if (text === 'menu:') {
          const choices: Array<{ text: string; lines: string[] }> = []
          let allTerminal = true
          while (cursor < lines.length) {
            const next = lines[cursor], nextWidth = next.length - next.trimStart().length
            if (nextWidth <= indent) break
            const match = option.exec(next.trim())
            if (nextWidth !== indent + 4 || !match) return { terminal, error: 'menu 内必须是具名选项' }
            if (!match[1].slice(1, -1).trim()) return { terminal, error: '菜单选项文本不能为空' }
            cursor++; const begin = cursor
            const body = sequence(indent + 8)
            if (body.error) return body
            if (begin === cursor) return { terminal, error: '菜单选项没有后果' }
            choices.push({ text: match[1], lines: lines.slice(begin, cursor).map(x => x.trim()) })
            allTerminal &&= body.terminal
          }
          if (choices.length < 2) return { terminal, error: '菜单至少需要两个有意义的选项；单线剧情请直接 jump，不要使用“继续”菜单' }
          if (new Set(choices.map(x => x.text)).size !== choices.length) return { terminal, error: '菜单选项文本重复' }
          menus.push(choices); terminal = allTerminal; continue
        }
        const jump = /^jump ([A-Za-z_]\w*)$/.exec(text)
        if (jump) { jumps.push(jump[1]); terminal = true; continue }
        if (text === 'return') { endings.add(label); terminal = true; continue }
        const spoken = say.exec(text)
        if (spoken) {
          if (spoken[1] && !contract.characters.includes(spoken[1])) return { terminal, error: `未知对白角色：${spoken[1]}` }
          if (!spoken[2].slice(1, -1).trim()) return { terminal, error: '候选稿包含空白对白或旁白' }
          if (spoken[1]) dialogue++
          words.push(spoken[2]); continue
        }
        const visual = /^(?:scene|show|hide) ([A-Za-z_]\w*)(?: at (?:left|center|right))?(?: with (?:dissolve|fade))?$/.exec(text)
        if (visual) {
          if (!contract.images.includes(visual[1])) return { terminal, error: `未知图片：${visual[1]}` }
          continue
        }
        const play = /^play (?:music|sound) "([^"\\]+)"(?: loop| noloop)?$/.exec(text)
        if (play) {
          if (!contract.audio.includes(play[1])) return { terminal, error: `未知音频路径：${play[1]}` }
          continue
        }
        if (/^(?:with (?:dissolve|fade)|stop (?:music|sound)(?: fadeout \d+(?:\.\d+)?)?)$/.test(text)) continue
        return { terminal, error: `Studio 候选稿含不支持的语句：${text.slice(0, 80)}` }
      }
      return { terminal }
    }
    const result = sequence(4)
    if (result.error) return result.error
    if (!result.terminal) return `场景 ${label} 没有明确的跳转或结束`
    edges.set(label, jumps); prose.set(label, words)
  }
  for (const [label, targets] of edges) for (const target of targets) if (!blocks.has(target)) return `场景 ${label} 跳向不存在的 label：${target}`
  const reachable = new Set<string>()
  const visit = (label: string): void => { if (reachable.has(label)) return; reachable.add(label); for (const next of edges.get(label) ?? []) visit(next) }
  visit(contract.entryLabel)
  for (const label of blocks.keys()) if (!reachable.has(label)) return `场景从入口不可达：${label}`
  for (const label of contract.sceneLabels) if (!prose.get(label)?.length) return `大纲场景尚无实际剧情：${label}`
  if (!dialogue) return '候选稿没有已确认角色的实际对白'
  const canEnd = new Set(endings)
  for (let changed = true; changed;) {
    changed = false
    for (const [label, targets] of edges) if (!canEnd.has(label) && targets.some(x => canEnd.has(x))) { canEnd.add(label); changed = true }
  }
  for (const label of reachable) if (!canEnd.has(label)) return `场景没有可达结局：${label}`
  // Compare visible route content, not destination label spelling. Otherwise
  // two empty bridge labels could disguise the same eventual consequence.
  const consequence = (line: string, seen = new Set<string>()): string => {
    const jump = /^jump (\w+)$/.exec(line)
    if (!jump) return line
    if (seen.has(jump[1])) return '<cycle>'
    const next = new Set(seen); next.add(jump[1])
    return (blocks.get(jump[1]) ?? []).map(item => consequence(item.trim(), next)).join('\n')
  }
  for (const choices of menus) {
    const signatures = choices.map(choice => choice.lines.map(line => consequence(line)).join('\n'))
    if (new Set(signatures).size !== signatures.length) return '菜单存在后果完全相同的选项，请写出不同后果或改为单线'
  }
  return null
}
