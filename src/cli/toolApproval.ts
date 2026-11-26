import * as path from 'node:path'
import { resolveRealPath } from '../main/tools'

/** Extra consent belongs to the new Agent entry point, not old --tools runs. */
export async function approveAgentMutation(input: {
  name: string; argsJson: string; config: Record<string, unknown>
  ask?: (message: string) => Promise<boolean>; redact: (text: string) => string
  record: (decision: boolean) => void
  managedByPermissionController?: boolean
}): Promise<void> {
  if ((input.config.cliToolPolicy as { requireWriteApproval?: boolean } | undefined)?.requireWriteApproval !== true) return
  const args = JSON.parse(input.argsJson) as Record<string, unknown>
  let description: string
  if (input.name === 'write_file' || input.name === 'edit_file') {
    if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('写入路径无效')
    const target = await resolveRealPath(path.resolve(String(input.config.workDir), args.path))
    const roots = await Promise.all([input.config.workDir, input.config.docDir].map(root => resolveRealPath(String(root))))
    if (!roots.some(root => { const relative = path.relative(root, target); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) })) throw new Error('Agent 写入越出工作/文档目录；请使用明确的 --work-dir，不自动扩大权限')
    description = (input.name === 'edit_file' ? (args.replace_all === true ? '全文替换' : '局部修改') : '创建/覆盖') + '：' + target
    if (input.name === 'edit_file' && typeof args.old_text === 'string' && typeof args.new_text === 'string') {
      const excerpt = (s: string): string => s.length <= 100 ? s : s.slice(0, 100) + '…'
      description += '｜' + (typeof args.at_line === 'number' ? '原稿第 ' + args.at_line + ' 行：' : '') + excerpt(args.old_text) + ' → ' + (excerpt(args.new_text) || '（删除）')
    }
  } else return
  if (input.managedByPermissionController) return
  const safe = input.redact(description).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000)
  const allowed = Boolean(input.ask && await input.ask(`${safe}\n输入 allow 才允许本次操作；不会记住或扩大权限`))
  input.record(allowed)
  if (!allowed) throw new Error('agent_write_approval_required：本次修改未获明确授权；交互终端需输入 allow，管道不自动允许')
}
