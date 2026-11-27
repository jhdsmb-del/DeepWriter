import { dialog, app } from 'electron'
import { createWriteStream } from 'fs'
import { promises as fs, writeFileSync } from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { DsTool } from './deepseek'
import { agentTools, fileOperationPermission } from './agentTools'
import { conversationSearchTool } from './conversationSearch'
import type { ConversationSearchPage } from '../shared/conversationSearch'
import { workPlanTool } from './workPlan'
import type { WorkPlanSnapshot } from '../shared/workPlan'
import { publicWebTools, type ProviderWebToolExecutor } from './publicWebTools'
import { spawnTracked, activeChildProcesses } from './childRegistry'
import { execSync } from 'node:child_process'
import type { FileEditUndoMetadata } from '../shared/editUndo'
import type { FileSourceEvidence } from '../shared/fileEvidence'
import type { ManuscriptEditRecovery } from './manuscriptEdit'

export interface AgentEnv {
  searchConversation?: (args: Record<string, unknown>, readBudgetChars?: number) => ConversationSearchPage
  /** Host-only: a scheduled parallel read must fail closed rather than ask for authority. */
  nonInteractiveLocalRead?: boolean
  pagedFileReads?: boolean
  /** False for model tools: human receipts are projected separately from their persisted arguments. */
  includeFileDiff?: boolean
  workDir: string
  permissionMode?: import('../shared/types').PermissionMode
  permissionWorkspaceRoot?: string
  /** Host-only frozen task policy; authority additionally requires a matching live grant. */
  goalMode?: 'guided' | 'autonomous'
  docDir: string
  sessionId?: string
  /** R4-4：工具取消信号（协作取消；命令执行/长任务应监听并尽快终止） */
  signal?: AbortSignal
  /** R4.2 A2：执行身份（owner-scoped permission lease 判定用；缺省则无 lease 匹配） */
  webContentsId?: number
  runId?: string
  toolCallId?: string
  /** Bound only by the main/CLI frozen run executor, never tool arguments. */
  providerWeb?: ProviderWebToolExecutor
  /** Host-bound selected-attachment reader; never accepted from tool arguments. */
  readAttachment?: (args: Record<string, unknown>, readBudgetChars?: number) => Promise<string | (Pick<ToolResult, 'message' | 'sources'> & { ok?: boolean })>
  /** Current model-input allocation for escaped read body, not an authority or call limit. Zero displays metadata only. */
  readBudgetChars?: number
}

export interface ToolResult {
  conversation?: ConversationSearchPage
  workPlan?: WorkPlanSnapshot
  ok: boolean
  message: string
  path?: string
  size?: number
  name?: string
  exitCode?: number | null
  backupId?: string
  editUndo?: FileEditUndoMetadata
  sources?: FileSourceEvidence[]
  diffText?: string
  edit?: { count: number; lines: number[] }
  editRecovery?: ManuscriptEditRecovery
  diffAdded?: number
  diffRemoved?: number
  diffPath?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, defaultDir: string, env?: AgentEnv) => Promise<ToolResult>
}

export async function resolveRealPath(p: string): Promise<string> {
  let cur = p
  const suffix: string[] = []
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...suffix.reverse())
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
      const parent = path.dirname(cur)
      if (parent === cur) return p
      suffix.push(path.basename(cur))
      cur = parent
    }
  }
}

/**
 * 路径沙箱：模型通过参数指定的路径若落在允许根目录之外，
 * 必须经用户确认才允许写入（防止 prompt injection 诱导模型写系统路径）。
 * 比较基于 realpath：逐级解析已存在祖先的真实路径，防止 junction/symlink 逃逸。
 */
export async function assertPathAllowed(p: string, roots: string[]): Promise<boolean> {
  let norm: string
  let realRoots: string[]
  try {
    norm = await resolveRealPath(path.resolve(p))
    realRoots = []
    for (const r of roots) {
      realRoots.push(await resolveRealPath(path.resolve(r)))
    }
  } catch {
    return false
  }
  const a = norm.toLowerCase()
  for (const root of realRoots) {
    const r = root.toLowerCase()
    if (a === r || a.startsWith(r + path.sep)) return true
  }
  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['允许保存', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: '文件将写入允许目录之外',
    detail: `模型请求将文件写入：\n${norm}\n\n若这不是你期望的位置，请取消。`
  })
  return result.response === 0
}

async function resolvePath(argsPath: unknown, defaultDir: string, suggestedName: string, filter: { name: string; extensions: string[] }, env?: AgentEnv): Promise<string | null> {
  if (typeof argsPath === 'string' && argsPath.trim()) {
    const p = path.isAbsolute(argsPath) ? argsPath : path.join(defaultDir, argsPath)
    const permission = await fileOperationPermission(p, defaultDir, env, 'write')
    if (permission.action !== 'allow') throw new Error(permission.reason)
    const dir = path.dirname(p)
    await fs.mkdir(dir, { recursive: true })
    return p
  }
  if (env?.goalMode === 'autonomous') {
    const target = path.join(env.workDir, suggestedName)
    const permission = await fileOperationPermission(target, defaultDir, env, 'write')
    if (permission.action !== 'allow') throw new Error(permission.reason)
    return target
  }
  const result = await dialog.showSaveDialog({
    title: '保存文档',
    defaultPath: path.join(defaultDir, suggestedName),
    filters: [filter, { name: '所有文件', extensions: ['*'] }]
  })
  if (result.canceled || !result.filePath) return null
  return result.filePath
}

export const defaultDocDir = (): string => path.join(app.getPath('documents'), 'DeepWriter')

const markdownTool: ToolDef = {
  name: 'generate_markdown_doc',
  description: '把内容生成为 Markdown 文档文件（.md）。适合报告、设定集、剧本、教程。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '保存路径，留空则弹出保存对话框（推荐）' },
      filename: { type: 'string', description: '建议文件名（含 .md 后缀）' },
      title: { type: 'string', description: '文档标题' },
      content: { type: 'string', description: '文档正文（Markdown 格式）' }
    },
    required: ['content']
  },
  async execute(args, defaultDir, env) {
    const content = String(args.content ?? '')
    const title = String(args.title ?? '')
    const body = title ? `# ${title}\n\n${content}` : content
    const file = await resolvePath(args.path, defaultDir, String(args.filename ?? 'document.md'), { name: 'Markdown', extensions: ['md'] }, env)
    if (!file) return { ok: false, message: '用户取消了保存对话框' }
    await fs.writeFile(file, body, 'utf-8')
    const st = await fs.stat(file)
    return { ok: true, message: `已生成 Markdown 文档`, path: file, size: st.size, name: path.basename(file) }
  }
}

const docxTool: ToolDef = {
  name: 'generate_docx_doc',
  description: '生成为 Word 文档（.docx）。适合正式报告、合同、方案书、设定集。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '保存路径，留空则弹出保存对话框（推荐）' },
      filename: { type: 'string', description: '建议文件名（含 .docx 后缀）' },
      title: { type: 'string', description: '文档标题' },
      sections: {
        type: 'array',
        description: '章节列表',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            paragraphs: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    },
    required: ['title']
  },
  async execute(args, defaultDir, env) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await import('docx')
    const sections = Array.isArray(args.sections) ? args.sections : []
    const children: any[] = []
    const titleText = String(args.title ?? '未命名文档')
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: titleText, bold: true, size: 36, font: { name: '微软雅黑', eastAsia: '微软雅黑' } })]
      }),
      new Paragraph({ children: [new TextRun({ text: '', font: { name: '微软雅黑', eastAsia: '微软雅黑' } })] })
    )
    for (const sec of sections) {
      const heading = String(sec.heading ?? '')
      const paras = Array.isArray(sec.paragraphs) ? sec.paragraphs.map((p: any) => String(p)) : []
      if (heading) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: heading, bold: true, size: 28, font: { name: '微软雅黑', eastAsia: '微软雅黑' } })] }))
      }
      for (const p of paras) {
        children.push(new Paragraph({ children: [new TextRun({ text: p, size: 24, font: { name: '微软雅黑', eastAsia: '微软雅黑' } })] }))
      }
    }
    const doc = new Document({ sections: [{ children }] })
    const buffer = await Packer.toBuffer(doc)
    const file = await resolvePath(args.path, defaultDir, String(args.filename ?? `${titleText}.docx`), { name: 'Word 文档', extensions: ['docx'] }, env)
    if (!file) return { ok: false, message: '用户取消了保存对话框' }
    await fs.writeFile(file, buffer)
    const st = await fs.stat(file)
    return { ok: true, message: `已生成 Word 文档（${sections.length} 个章节）`, path: file, size: st.size, name: path.basename(file) }
  }
}

const xlsxTool: ToolDef = {
  name: 'generate_xlsx_doc',
  description: '生成为 Excel 表格（.xlsx）。适合数据表、计划表、清单。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '保存路径，留空则弹出保存对话框（推荐）' },
      filename: { type: 'string', description: '建议文件名（含 .xlsx 后缀）' },
      sheetName: { type: 'string', description: '工作表名称' },
      rows: { type: 'array', description: '数据行（第一行可作为表头）', items: { type: 'array', items: { type: 'string' } } }
    },
    required: ['rows']
  },
  async execute(args, defaultDir, env) {
    const excelMod: any = await import('exceljs')
    const ExcelJS = excelMod.default ?? excelMod
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet(String(args.sheetName ?? 'Sheet1'))
    const rows = Array.isArray(args.rows) ? args.rows : []
    for (const row of rows) {
      if (Array.isArray(row)) ws.addRow(row.map((c) => String(c)))
    }
    ws.getRow(1).font = { bold: true }
    ws.getRow(1).alignment = { vertical: 'middle' }
    ws.columns.forEach((c: any) => {
      if (c) c.width = 18
    })
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())
    const file = await resolvePath(args.path, defaultDir, String(args.filename ?? 'spreadsheet.xlsx'), { name: 'Excel 表格', extensions: ['xlsx'] }, env)
    if (!file) return { ok: false, message: '用户取消了保存对话框' }
    await fs.writeFile(file, buffer)
    const st = await fs.stat(file)
    return { ok: true, message: `已生成 Excel 表格（${rows.length} 行）`, path: file, size: st.size, name: path.basename(file) }
  }
}

const CN_FONTS = [
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/msyh.ttf',
  'C:/Windows/Fonts/simsun.ttc',
  'C:/Windows/Fonts/msyh.ttc'
]

async function findCnFont(): Promise<string | null> {
  for (const f of CN_FONTS) {
    try {
      await fs.access(f)
      return f
    } catch {
      /* try next */
    }
  }
  return null
}

const pdfTool: ToolDef = {
  name: 'generate_pdf_doc',
  description: '生成为 PDF 文档。适合正式交付、打印版文档。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '保存路径，留空则弹出保存对话框（推荐）' },
      filename: { type: 'string', description: '建议文件名（含 .pdf 后缀）' },
      title: { type: 'string', description: '文档标题' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            paragraphs: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    },
    required: ['title']
  },
  async execute(args, defaultDir, env) {
    const pdfMod: any = await import('pdfkit')
    const PDFDocument = pdfMod.default ?? pdfMod
    const font = await findCnFont()
    if (!font) return { ok: false, message: '未找到支持中文的系统字体，无法生成 PDF' }
    const file = await resolvePath(args.path, defaultDir, String(args.filename ?? `${String(args.title ?? 'document')}.pdf`), { name: 'PDF', extensions: ['pdf'] }, env)
    if (!file) return { ok: false, message: '用户取消了保存对话框' }
    const doc = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 60, left: 60, right: 60 } })
    doc.font(font)
    doc.fontSize(22).text(String(args.title ?? ''), { align: 'center' })
    doc.moveDown(2)
    const sections = Array.isArray(args.sections) ? args.sections : []
    for (const sec of sections) {
      const heading = String(sec.heading ?? '')
      const paras = Array.isArray(sec.paragraphs) ? sec.paragraphs.map((p: any) => String(p)) : []
      if (heading) {
        doc.moveDown(0.6).fontSize(16).text(heading)
        doc.moveDown(0.4)
      }
      doc.fontSize(12)
      for (const p of paras) {
        doc.text(p, { lineGap: 4 })
        doc.moveDown(0.3)
      }
    }
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(file)
      doc.on('end', () => resolve())
      doc.on('error', reject)
      stream.on('error', reject)
      doc.pipe(stream)
      doc.end()
      stream.on('finish', () => resolve())
    })
    const st = await fs.stat(file)
    return { ok: true, message: '已生成 PDF 文档', path: file, size: st.size, name: path.basename(file) }
  }
}

export const TOOLS: ToolDef[] = [markdownTool, docxTool, xlsxTool, pdfTool]

export function buildToolSpecs(includeAgent = false): DsTool[] {
  let defs = [...TOOLS]
  if (includeAgent) {
    defs = [...defs, ...agentTools, workPlanTool, conversationSearchTool, ...publicWebTools]
  }
  return defs.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

export function getTool(name: string): ToolDef | undefined {
  if (name === conversationSearchTool.name) return conversationSearchTool
  if (name === workPlanTool.name) return workPlanTool
  const publicWebTool = publicWebTools.find(t => t.name === name)
  if (publicWebTool) return publicWebTool
  // R4.3 Gate 3 测试 seam：mock_slow_tool（R4.3 原语义——执行 7s > 取消兜底 5s，
  // 兜底先触发 finalizeCancel，工具仍 running → side_effect_unknown → recovery_required；
  // abort 不 resolve（取消兜底期内不 settle）；非幂等——不在 IDEMPOTENT_TOOLS）
  if (name === 'mock_slow_tool' && process.env.NODE_ENV === 'test') {
    return {
      name: 'mock_slow_tool',
      description: 'test-only slow tool',
      parameters: { type: 'object', properties: {} },
      async execute() {
        // R12（R11-R02 拆分）：恢复 R4.3 原语义——固定 7s 阻塞，abort 不提前 resolve
        //（取消兜底 5s 先触发 finalizeCancel → 工具仍 running → recovery_required）
        await new Promise<void>((r) => setTimeout(r, 7000))
        return { ok: true, message: '慢工具执行完成' }
      }
    }
  }
  // R12（R11-R02 拆分）：Gate 5 专用 tracked-child 工具——真实 cmd/ping 子进程（无限存活，
  // 受控可取消）；由 childRegistry 跟踪，shutdown coordinator 统一终止；abort 时 resolve
  //（工具返回）但不杀 child（避免与 coordinator 的 terminated 计数冲突）。
  // 前置证据文件：<tmp>/dw-r46-g5-child-<sessionId>.json（rootPid/treePids/activePids/
  // registered/alive/startedAt/spawnError——registered 与 activePids 来自真实 registry 查询）
  if (name === 'mock_tracked_child_tool' && process.env.NODE_ENV === 'test') {
    return {
      name: 'mock_tracked_child_tool',
      description: 'test-only tracked child tool (Gate 5)',
      parameters: { type: 'object', properties: {} },
      async execute(_args, _defaultDir, env) {
        const startedAt = Date.now()
        const sessionId = env?.sessionId ?? 'unknown'
        const evidence: Record<string, unknown> = {
          toolName: 'mock_tracked_child_tool',
          rootPid: null,
          treePids: [] as number[],
          activePids: [] as number[],
          registered: false,
          alive: false,
          startedAt,
          spawnError: null
        }
        const writeEvidence = (): void => {
          try {
            writeFileSync(path.join(os.tmpdir(), `dw-r46-g5-child-${sessionId}.json`), JSON.stringify(evidence, null, 2), 'utf-8')
          } catch {
            /* 证据写盘失败不阻断工具 */
          }
        }
        const cp = spawnTracked(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'ping -t 127.0.0.1'], { windowsHide: true })
        if (cp.pid !== undefined) {
          evidence.rootPid = cp.pid
          evidence.alive = cp.exitCode === null
          // R12（R11-R01）：registered/activePids 来自真实 registry 查询（非硬编码）
          evidence.activePids = activeChildProcesses().map((c) => c.pid).filter((p): p is number => p !== undefined)
          evidence.registered = (evidence.activePids as number[]).includes(cp.pid)
          // 后代 PID（cmd 的子进程 ping.exe）——wmic 按 parent 查询
          try {
            const out = execSync(`wmic process where "ParentProcessId=${cp.pid}" get ProcessId /value`, { encoding: 'utf-8' })
            const kids = [...out.matchAll(/ProcessId=(\d+)/g)].map((m) => Number(m[1])).filter((p) => p > 0)
            ;(evidence.treePids as number[]) = [cp.pid, ...kids]
          } catch {
            ;(evidence.treePids as number[]) = [cp.pid]
          }
        }
        writeEvidence()
        cp.once('exit', () => {
          evidence.alive = false
          writeEvidence()
        })
        cp.once('error', (e) => {
          evidence.spawnError = e.message
          evidence.alive = false
          writeEvidence()
        })
        await new Promise<void>((resolve) => {
          cp.once('exit', () => resolve())
          cp.once('error', () => resolve())
          const onAbort = (): void => {
            // abort 不杀 child——由 shutdown coordinator 统一 terminate
            resolve()
          }
          env?.signal?.addEventListener('abort', onAbort)
        })
        return { ok: true, message: 'tracked child 工具执行完成（真实子进程）' }
      }
    }
  }
  const agentTool = agentTools.find(t => t.name === name)
  if (agentTool) return agentTool
  return TOOLS.find((t) => t.name === name)
}

export async function executeTool(name: string, args: unknown, defaultDir: string, env?: AgentEnv): Promise<ToolResult> {
  const tool = getTool(name)
  if (!tool) return { ok: false, message: `未知工具: ${name}` }
  try {
    return await tool.execute((args ?? {}) as Record<string, unknown>, defaultDir, env)
  } catch (e) {
    if ((name === 'web_search' || name === 'read_web_page') && (e as Error)?.name === 'RunBudgetExceededError') throw e
    return { ok: false, message: `工具执行异常: ${(e as Error).message}` }
  }
}
