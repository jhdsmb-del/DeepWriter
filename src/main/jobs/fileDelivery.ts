import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import type { RunConfig, ToolCallRecord, TurnRecord } from './types'
import { FILE_WRITE_TOOLS } from '../../shared/chatFiles'

export const FILE_DELIVERY_EVIDENCE = 'file_delivery_v1'
const WRITES = new Set<string>(FILE_WRITE_TOOLS)
// Native command/build artifacts keep their own completion contract. Never
// ask a text/document writer to manufacture an archive or executable instead.
const documentPath = /\.(?:md|txt|pdf|docx|xlsx|pptx|csv|tsv|rtf|odt|ods|json|ya?ml|xml|html|css|[cm]?js|[cm]?ts|tsx|jsx|py|c|h|cpp|rs|go|sh|bat|ps1|sql|toml|ini|log|ipynb|tex)$/iu
export interface FileDeliveryState {
  schemaVersion: 1
  targets: string[]
  required: boolean
  noProgress: number
  proofIds: string[]
  rejected: Array<{ turnId: string; content: string }>
  replaceRevision?: number
}
export const newFileDeliveryState = (): FileDeliveryState => ({ schemaVersion: 1, targets: [], required: false, noProgress: 0, proofIds: [], rejected: [] })
function plain(text: string): string {
  return text.replace(/```[\s\S]*?```/gu, '').split('\n').filter(line => !/^\s*>/u.test(line)).join('\n')
}
export function deliveryPaths(text: string): string[] {
  const quoted = [...text.matchAll(/[`"“「]([^`"”」\r\n]+\.[a-zA-Z0-9]{1,10})[`"”」]/gu)].map(match => match[1])
  const remaining = text.replace(/[`"“「][^`"”」\r\n]+[`"”」]/gu, ' ').replace(/(?:写入|保存(?:到|为)?|创建|生成|导出|存到|写到)\s*/gu, ' ')
  const bare = [...remaining.matchAll(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?(?:[\p{L}\p{N}_.-]+[\\/])*[\p{L}\p{N}_-]+\.[a-zA-Z0-9]{1,10}/gu)].map(match => match[0])
  return [...new Set([...quoted, ...bare])].filter(item => !/^https?:/iu.test(item) && !/^\d+\.\d+$/u.test(item))
}
/** Speech act + action/object + concrete target; mentioning an extension alone
 * never creates an obligation. Quoted examples and instructions stay text. */
export function fileDeliveryObligation(text: string, speaker: 'user' | 'assistant', promises = true): { required: boolean; targets: string[] } {
  const sentences = plain(text).split(/(?<=[。！？!?\n，,；;])/u)
  const directed = speaker === 'user' && /请|帮我|替我|给我|务必|必须|需要|我要|\bplease\b/iu.test(plain(text))
  const targets: string[] = []; let required = false
  for (const sentence of sentences) {
    if (/(?:如何|怎么|怎样|示例|举例|解释|演示|只(?:需|要|给)|不要|无需|不必|不(?:要|用|必)写入|没有|尚未|未曾|未实际|尚不|并未|无法|不能|拒绝|未成功|未写入|未保存|未创建|not(?:\s+been)?\s+(?:written|saved|created)|how\s+to|example)/iu.test(sentence)) continue
    if (speaker === 'assistant' && /(?:你可以|您可以|可自行|建议你|you (?:can|could|should))/iu.test(sentence)) continue
    const verb = /写入|写成|保存(?:到|为|成)?|写到|存到|存为|落盘|创建|生成|制作|做成|导出|create|write|save|export|generate/iu.exec(sentence)
    if (!verb) continue
    // Bind targets to the write destination, not to every mentioned source.
    // A passive completion ("result.md 已生成") binds its preceding object.
    const after = sentence.slice(verb.index + verb[0].length).replace(/[（(](?:参考|来源|依据|源文件)[^）)]*[）)]/gu, '')
    let paths = deliveryPaths(after)
    if (!paths.length && speaker === 'assistant') paths = deliveryPaths(sentence.slice(0, verb.index)).slice(-1)
    if (paths.length > 0 && !paths.some(file => documentPath.test(file))) continue
    paths = paths.filter(file => documentPath.test(file))
    const stored = /(?:写入|保存|写到|存到|存为|落盘|导出|save|export)/iu.test(sentence)
    const fileObject = paths.length > 0 || /(?:文件|本地|工作目录|文档目录|Word|PDF|Excel|file)/iu.test(sentence) || (stored && /文档|稿件|报告|document/iu.test(sentence))
    const act = speaker === 'user'
      ? directed || /(?:^\s*(?:写入|保存|创建|生成|制作|导出)|^\s*(?:只)?(?:把|将).{0,80}(?:写入|保存|创建|生成|导出)|\b(?:please|create|write|save|export|generate)\b)/iu.test(sentence)
      : /(?:已(?:经)?|完成|成功|\b(?:I have|saved|written|created|exported|generated)\b)/iu.test(sentence) || (promises && /(?:我(?:会|将|来)|马上|现在|\bI will\b)/iu.test(sentence))
    if (fileObject && act) { required = true; targets.push(...paths) }
  }
  return { required, targets: [...new Set(targets)] }
}
function normalized(file: string, root: string): string {
  const value = path.resolve(root, file.replace(/^file:\/\//u, ''))
  return process.platform === 'win32' ? value.toLowerCase() : value
}
function resultOf(tool: ToolCallRecord): Record<string, unknown> {
  try {
    let value = JSON.parse(tool.resultJson ?? '{}') as Record<string, unknown>
    if (typeof value.content === 'string') value = JSON.parse(value.content) as Record<string, unknown>
    return value
  } catch { return {} }
}
export async function assessFileDelivery(input: { runId: string; config: RunConfig; turns: TurnRecord[]; tools: ToolCallRecord[]; state: FileDeliveryState }) {
  const state: FileDeliveryState = structuredClone(input.state)
  const root = typeof input.config.workDir === 'string' && input.config.workDir ? input.config.workDir : process.cwd()
  const readOnly = input.config.planMode === true || (input.config.agentPlan as { access?: unknown } | undefined)?.access === 'read_only'
  const commandArtifact = input.turns.some(turn => turn.role === 'user' && /打包|编译|构建|安装包|压缩包|executable|\bbuild\b|\bcompile\b|\bpackage\b/iu.test(turn.content))
  for (const turn of input.turns.filter(turn => turn.role === 'user' && !readOnly)) {
    const requested = fileDeliveryObligation(turn.content, 'user')
    state.required ||= requested.required
    state.targets.push(...requested.targets.map(file => normalized(file, root)))
  }
  const claims = input.turns.filter(turn => {
    if (turn.role !== 'assistant') return false
    const claimed = fileDeliveryObligation(turn.content, 'assistant', !readOnly)
    return claimed.required && (state.required || !commandArtifact || claimed.targets.length > 0 || /文档|Word|PDF|Excel|document/iu.test(turn.content))
  })
  const claimTargets: string[] = []
  for (const turn of claims) {
    state.required = true
    claimTargets.push(...fileDeliveryObligation(turn.content, 'assistant', !readOnly).targets.map(file => {
      const existing = !/[\\/]/u.test(file) ? state.targets.filter(target => path.basename(target).toLowerCase() === file.toLowerCase()) : []
      return existing.length === 1 ? existing[0] : normalized(file, root)
    }))
  }
  state.targets = [...new Set(state.targets)]
  if (!state.required) return { state, claims, ready: true, missing: [], missingClaims: [], files: [], proofIds: [], progress: false, refused: false, readOnly }
  const files: Array<{ path: string; toolCallId: string }> = []
  let refused = false
  for (const tool of input.tools) {
    if (tool.runId !== input.runId || !WRITES.has(tool.name)) continue
    const result = resultOf(tool)
    if (result.ok !== true || tool.status !== 'completed') {
      if (/拒绝|denied|permission|approval_required|未获.*授权|只读|read.only|cancel|取消|停止/iu.test(String(result.message ?? result.error ?? ''))) refused = true
      continue
    }
    // Only a host write receipt is proof. Reads, tool arguments, model text,
    // arbitrary process output and earlier sessions cannot manufacture it.
    if (typeof result.path !== 'string' || !path.isAbsolute(result.path) || typeof result.size !== 'number' || !Number.isSafeInteger(result.size) || result.size < 0) continue
    try {
      const stat = await fs.stat(result.path)
      if (!stat.isFile() || stat.size !== result.size) continue
      if (typeof result.canonicalPath === 'string' && normalized(await fs.realpath(result.path), root) !== normalized(result.canonicalPath, root)) continue
      files.push({ path: path.resolve(result.path), toolCallId: tool.toolCallId })
    } catch { /* A removed or replaced delivery is not complete. */ }
  }
  const missing = state.targets.filter(target => !files.some(file => normalized(file.path, root) === target))
  const missingClaims = [...new Set(claimTargets)].filter(target => !files.some(file => normalized(file.path, root) === target))
  const ready = files.length > 0 && missing.length === 0 && missingClaims.length === 0
  const proved = files.filter(file => state.targets.length === 0 || state.targets.includes(normalized(file.path, root)))
  const proofIds = proved.map(file => file.toolCallId)
  const progress = proofIds.some(id => !state.proofIds.includes(id))
  return { state, claims, ready, missing, missingClaims, files: proved, proofIds, progress, refused, readOnly }
}
