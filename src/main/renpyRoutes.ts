import { promises as fs } from 'node:fs'
import * as path from 'node:path'

async function listRpy(dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory() && e.name !== 'save' && e.name !== 'saves') await listRpy(full, out)
    else if (e.isFile() && e.name.toLowerCase().endsWith('.rpy')) out.push(full)
  }
}

export async function collectScriptFiles(projectDir: string): Promise<string[]> {
  const game = path.join(projectDir, 'game')
  const subdir = await fs.lstat(game).catch(() => null)
  if (subdir?.isSymbolicLink()) return []
  const files: string[] = []
  if (subdir?.isDirectory()) await listRpy(game, files)
  else {
    // Some callers pass the script directory itself rather than the project.
    const entries = await fs.readdir(projectDir, { withFileTypes: true }).catch(() => [])
    if (entries.some(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.rpy')) || path.basename(projectDir).toLowerCase() === 'game') await listRpy(projectDir, files)
  }
  return files.sort()
}

export interface BranchLabel {
  name: string
  file: string
  line: number
  incoming: string[]
  outgoing: string[]
}

export interface BranchEdge {
  from: string
  to: string
  choice?: string
  type: 'jump' | 'call' | 'menu' | 'return'
  file: string
  line: number
}

export interface BranchDiagnostic {
  severity: 'error' | 'warning'
  code: string
  message: string
  file: string | null
  line: number | null
}

export interface BranchGraph {
  labels: BranchLabel[]
  edges: BranchEdge[]
  diagnostics: BranchDiagnostic[]
}

interface MenuOption {
  indent: number
  line: number
  text: string
  hasBody: boolean
  hasBranch: boolean
}

interface MenuBlock {
  indent: number
  line: number
  options: MenuOption[]
}

const LABEL_RE = /^\s*label\s+([a-zA-Z_]\w*)/
const JUMP_RE = /^\s*jump\s+(?!expression\b)([a-zA-Z_]\w*)/
const CALL_RE = /^\s*call\s+(?!(?:screen|expression)\b)([a-zA-Z_]\w*)/
const RETURN_RE = /^\s*return\b/
const MENU_RE = /^\s*menu\s*:\s*$/
const OPTION_RE = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')(?:\s+if\s+.+?)?\s*:\s*(?:#.*)?$/

export async function buildBranchGraph(projectDir: string): Promise<BranchGraph> {
  const files = await collectScriptFiles(projectDir)
  const nodes = new Map<string, { name: string; file: string; line: number }>()
  const edges: BranchEdge[] = []
  const diags: BranchDiagnostic[] = []
  const labelHasReturn = new Set<string>()
  const seenDiag = new Set<string>()

  const addDiag = (d: BranchDiagnostic): void => {
    const key = `${d.code}|${d.message}|${d.file}|${d.line}`
    if (seenDiag.has(key)) return
    seenDiag.add(key)
    diags.push(d)
  }

  const closeMenu = (m: MenuBlock, file: string): void => {
    if (m.options.length === 0) {
      addDiag({ severity: 'warning', code: 'menu-empty', message: 'menu: 块没有任何选项分支', file, line: m.line })
      return
    }
    for (const opt of m.options) {
      if (!opt.hasBranch) {
        addDiag({
          severity: 'warning',
          code: 'menu-option-empty',
          message: `菜单选项"${opt.text}"没有跳转/调用分支`,
          file,
          line: opt.line
        })
      }
    }
  }

  for (const file of files) {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch {
      continue
    }
    const lines = raw.split(/\r?\n/)
    let currentLabel: string | null = null
    let menuStack: MenuBlock[] = []
    let curOption: MenuOption | null = null

    const closeMenusDownTo = (indent: number): void => {
      while (menuStack.length > 0 && menuStack[menuStack.length - 1].indent >= indent) {
        const m = menuStack.pop()
        if (m) closeMenu(m, file)
      }
      if (menuStack.length === 0) {
        curOption = null
        return
      }
      const top = menuStack[menuStack.length - 1]
      const last = top.options[top.options.length - 1]
      curOption = last && indent > last.indent ? last : null
    }

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]
      const indent = /^\s*/.exec(text)?.[0].length ?? 0
      const trimmed = text.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue

      closeMenusDownTo(indent)

      const lm = LABEL_RE.exec(trimmed)
      if (lm) {
        currentLabel = lm[1]
        if (!nodes.has(currentLabel)) nodes.set(currentLabel, { name: currentLabel, file, line: i + 1 })
        continue
      }

      const mm = MENU_RE.exec(trimmed)
      if (mm) {
        menuStack.push({ indent, line: i + 1, options: [] })
        curOption = null
        continue
      }

      const om = OPTION_RE.exec(trimmed)
      if (om && menuStack.length > 0 && indent > menuStack[menuStack.length - 1].indent && (!menuStack[menuStack.length - 1].options.length || indent === menuStack[menuStack.length - 1].options[0].indent)) {
        const opt: MenuOption = { indent, line: i + 1, text: (om[1] ?? om[2]).replace(/\\(["'\\])/g, '$1'), hasBody: false, hasBranch: false }
        menuStack[menuStack.length - 1].options.push(opt)
        curOption = opt
        continue
      }

      const jm = JUMP_RE.exec(trimmed)
      const cm = CALL_RE.exec(trimmed)
      if (jm || cm) {
        const target = (jm ?? cm)![1]
        const type: BranchEdge['type'] = cm ? 'call' : curOption ? 'menu' : 'jump'
        if (curOption) curOption.hasBranch = true
        if (currentLabel) {
          edges.push({ from: currentLabel, to: target, type, ...(curOption ? { choice: curOption.text } : {}), file, line: i + 1 })
        }
        continue
      }

      if (RETURN_RE.test(trimmed)) {
        if (currentLabel) labelHasReturn.add(currentLabel)
        continue
      }

      if (curOption && indent > curOption.indent) {
        curOption.hasBody = true
      }
    }
    while (menuStack.length > 0) {
      const m = menuStack.pop()
      if (m) closeMenu(m, file)
    }
  }

  const labelNames = new Set(nodes.keys())
  const graphLabels: BranchLabel[] = []
  const byName = new Map<string, BranchLabel>()
  for (const n of nodes.values()) {
    const gl: BranchLabel = { name: n.name, file: n.file, line: n.line, incoming: [], outgoing: [] }
    byName.set(n.name, gl)
    graphLabels.push(gl)
  }

  for (const e of edges) {
    if (!labelNames.has(e.to)) {
      addDiag({
        severity: 'error',
        code: 'missing-label',
        message: `跳转目标 label "${e.to}" 不存在`,
        file: e.file,
        line: e.line
      })
      continue
    }
    byName.get(e.from)?.outgoing.push(e.to)
    byName.get(e.to)?.incoming.push(e.from)
    if (e.type === 'call' && !labelHasReturn.has(e.to)) {
      addDiag({
        severity: 'warning',
        code: 'call-no-return',
        message: `call 目标 "${e.to}" 内未找到 return，调用后无法返回 ${e.from}`,
        file: e.file,
        line: e.line
      })
    }
    if (e.type === 'call' && labelHasReturn.has(e.to)) {
      edges.push({ from: e.to, to: e.from, type: 'return', file: e.file, line: e.line })
    }
  }

  if (labelNames.has('start')) {
    // These engine entry points are entered by Ren'Py, not by a story jump.
    const queue = ['start', 'main_menu', 'before_main_menu', 'splashscreen', 'after_load'].filter(label => labelNames.has(label))
    const visited = new Set(queue)
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]
      const node = byName.get(cur)
      if (!node) continue
      for (const next of node.outgoing) {
        if (!visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }
    for (const gl of graphLabels) {
      if (!visited.has(gl.name)) {
        addDiag({
          severity: 'warning',
          code: 'unreachable-label',
          message: `label "${gl.name}" 未在从 start 出发的显式跳转中找到`,
          file: gl.file,
          line: gl.line
        })
      }
    }
  }

  for (const gl of graphLabels) {
    gl.incoming = [...new Set(gl.incoming)].sort()
    gl.outgoing = [...new Set(gl.outgoing)].sort()
  }

  graphLabels.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { labels: graphLabels, edges, diagnostics: diags }
}
