import { memo, useState } from 'react'
import type { ToolActivity } from '../../../../shared/activity'

const HEAD_CHARS = 1200
const TAIL_CHARS = 1200
const MAX_PATHS = 8
const SUMMARY_LIMIT = 200

const PATH_RE = /[A-Za-z]:\\[^\s,;<>]+|\/(?:[\w\-.]+\/)+[\w\-.]+|(?:\.{1,2}\/)?[\w\-]+(?:\/[^\s,;<>]+)*\.\w+/g

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function extractPaths(s: string): string[] {
  const out: string[] = []
  for (const m of s.match(PATH_RE) ?? []) {
    if (!out.includes(m)) out.push(m)
    if (out.length >= MAX_PATHS) break
  }
  return out
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

interface ToolOutputViewProps {
  tool: ToolActivity
}

function ToolOutputViewInner({ tool }: ToolOutputViewProps): React.ReactNode {
  const [openInput, setOpenInput] = useState(false)
  const [openOutput, setOpenOutput] = useState(false)
  const summary = tool.safeInputSummary
  const summaryShort = summary.length > SUMMARY_LIMIT ? summary.slice(0, SUMMARY_LIMIT) + '…' : summary
  const paths = extractPaths(summary)
  const preview = tool.outputPreview ?? ''
  const bytes = new TextEncoder().encode(preview).length
  const head = preview.slice(0, HEAD_CHARS)
  const tail = preview.length > HEAD_CHARS + TAIL_CHARS ? preview.slice(-TAIL_CHARS) : ''
  const gap = preview.length - head.length - tail.length
  const isCommand = tool.toolName === 'run_command'
  const failed = tool.status === 'failed'
  return (
    <div className="tool-output-view">
      {summary && (
        <div className="tool-field">
          <span className="tool-field-label">{isCommand ? '命令' : '入参'}</span>
          <span className="tool-field-value">{openInput ? summary : summaryShort}</span>
          {summary.length > SUMMARY_LIMIT && (
            <button className="tool-field-expand" onClick={() => setOpenInput(!openInput)}>
              {openInput ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
      {tool.cwdDisplay && (
        <div className="tool-field">
          <span className="tool-field-label">工作目录</span>
          <span className="tool-field-value" title={tool.cwdDisplay}>
            {basename(tool.cwdDisplay)}
          </span>
        </div>
      )}
      {paths.length > 0 && (
        <div className="tool-field">
          <span className="tool-field-label">文件</span>
          <span className="tool-field-chips">
            {paths.map((p) => (
              <span className="tool-path-chip" key={p} title={p}>
                {basename(p)}
              </span>
            ))}
          </span>
        </div>
      )}
      {preview && (
        <div className="tool-output">
          <button className="tool-output-toggle" onClick={() => setOpenOutput(!openOutput)}>
            <span className={`step-icon ${failed ? 'err' : 'ok'}`}>{failed ? '✗' : '✓'}</span>
            <span>{openOutput ? '收起输出' : '查看输出'}</span>
            <span className="tool-output-size">
              共 {preview.length.toLocaleString()} 字符 / {fmtBytes(bytes)}
            </span>
            <span className="tool-card-arrow">{openOutput ? '▾' : '▸'}</span>
          </button>
          {openOutput && (
            <div className="tool-output-body">
              <pre className="tool-output-chunk">{head}</pre>
              {tail && (
                <>
                  <div className="tool-output-gap">中间省略 {Math.max(0, gap).toLocaleString()} 字符</div>
                  <pre className="tool-output-chunk">{tail}</pre>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default memo(ToolOutputViewInner)
