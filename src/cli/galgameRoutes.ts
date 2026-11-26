import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { buildBranchGraph } from '../main/renpyRoutes'

/** Inspect scripts without starting Ren'Py, opening a user profile or contacting a model. */
export async function printGalgameRoutes(project: string, json: boolean): Promise<number> {
  const root = path.resolve(project)
  const directory = await fs.stat(root).catch(() => null)
  if (!directory?.isDirectory()) throw new Error('找不到项目目录：' + project)
  const graph = await buildBranchGraph(root)
  if (!graph.labels.length) throw new Error('项目中没有可读取的剧情节点（label）；请选择 Ren’Py 项目或 game 目录。')
  const rel = (file: string) => path.relative(root, file).split(path.sep).join('/')
  const labels = graph.labels.map(({ name, file, line }) => ({ name, file: rel(file), line }))
  const edges = graph.edges.map(edge => ({ ...edge, file: rel(edge.file) }))
  const diagnostics = graph.diagnostics.map(d => ({ ...d, file: d.file ? rel(d.file) : null }))
  if (json) {
    process.stdout.write(JSON.stringify({ type: 'galgame_routes', data: { labels, edges, diagnostics } }) + '\n')
  } else {
    const byLabel = new Map<string, typeof edges>()
    for (const edge of edges) {
      const list = byLabel.get(edge.from)
      if (list) list.push(edge); else byLabel.set(edge.from, [edge])
    }
    const lines = [path.basename(root) + ' · 剧情路线', '']
    for (const label of labels) {
      lines.push(label.name + '  ' + label.file + ':' + label.line)
      for (const edge of byLabel.get(label.name) ?? []) lines.push('  ' + (edge.choice ? '「' + edge.choice + '」' : edge.type === 'call' ? '调用' : edge.type === 'return' ? '返回' : '跳转') + ' → ' + edge.to)
    }
    if (diagnostics.length) lines.push('', '脚本提示', ...diagnostics.map(d => (d.file ? d.file + ':' + d.line + '  ' : '') + d.message))
    process.stdout.write(lines.join('\n') + '\n')
  }
  return diagnostics.some(d => d.severity === 'error') ? 1 : 0
}
