import { Children, createContext, isValidElement, memo, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import 'highlight.js/styles/github-dark.css'
import { chatFileCandidate, chatFileCandidates, type ChatFileView } from '../../../shared/chatFiles'
import FileActionLink from './FileActionLink'

type FileScope = { sessionId: string; messageId: string; revision: string }
const FileLinks = createContext<{ scope: FileScope; files: Map<string, ChatFileView> } | null>(null)
function LocalFile({ candidate, children, code = false }: { candidate: string; children: ReactNode; code?: boolean }): ReactNode {
  const context = useContext(FileLinks)
  const normalized = chatFileCandidate(candidate)
  const file = normalized ? context?.files.get(normalized) : undefined
  return file && context ? <FileActionLink anchor={{ kind: 'message', sessionId: context.scope.sessionId, messageId: context.scope.messageId, candidate: file.candidate }}
    className={code ? 'inline-code' : ''} title={file.path} canOpen={file.canOpen}>{children}</FileActionLink>
    : code ? <code className="inline-code">{children}</code> : <span>{children}</span>
}
const localUrl = (url: string): string => /^https?:\/\//i.test(url) || chatFileCandidate(url) ? url : ''

// 只注册创作 Agent 实际会展示的格式。全量 highlight.js 会把数百种语言打进 renderer，
// 既拖慢冷启动，也与 DeepWriter 的轻量化目标相悖。
for (const [name, language] of Object.entries({ bash, css, diff, ini, javascript, json, markdown, powershell, python, typescript, xml })) {
  hljs.registerLanguage(name, language)
}
hljs.registerAliases(['sh', 'shell'], { languageName: 'bash' })
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['py', 'rpy'], { languageName: 'python' })
hljs.registerAliases(['html'], { languageName: 'xml' })

function CodeBlock({ code, lang }: { code: string; lang: string }): React.ReactNode {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const highlighted = useMemo(() => {
    // Auto-detection tries every grammar on every streamed code change. Unknown
    // languages and large blocks remain escaped plain text instead.
    if (!lang || code.length > 50000 || !hljs.getLanguage(lang)) return null
    try { return hljs.highlight(code, { language: lang }).value } catch { return null }
  }, [code, lang])
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 1500)
    return () => window.clearTimeout(timer)
  }, [copyState])
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopyState('copied')
    } catch { setCopyState('failed') }
  }
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{lang || 'text'}</span>
        <button onClick={() => void copy()}>{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}</button>
      </div>
      <pre>
        <code className={lang ? `language-${lang}` : ''} {...(highlighted === null ? { children: code } : { dangerouslySetInnerHTML: { __html: highlighted } })} />
      </pre>
    </div>
  )
}

// Keep renderer identities stable across streamed updates, preserving code
// highlight memoization, copy feedback and focus in existing code blocks.
const markdownComponents: Components = {
  pre({ children }) {
    const child = Children.toArray(children).find((item) => isValidElement(item))
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      const language = /language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? ''
      return <CodeBlock code={String(child.props.children ?? '').replace(/\n$/, '')} lang={language} />
    }
    return <pre>{children}</pre>
  },
  code({ children }) {
    return <LocalFile candidate={String(children)} code>{children}</LocalFile>
  },
  a({ href, children }) {
    // Electron validates the protocol and delegates to the system browser.
    if (!href || !/^https?:\/\//i.test(href)) return <LocalFile candidate={href || ''}>{children}</LocalFile>
    return <a href={href} target="_blank" rel="noopener noreferrer" title={href}>{children}</a>
  }
}
const markdownPlugins = [remarkGfm]

// Parsing depends only on the text, not on receipt availability or run state.
// LocalFile still consumes FileLinks through this memo boundary, so a newly
// resolved/revoked link updates without rebuilding the entire Markdown tree.
const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }): React.ReactNode {
  return <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents} urlTransform={localUrl}>
    {content}
  </ReactMarkdown>
})

const Markdown = memo(function Markdown({ content, fileScope }: { content: string; fileScope?: FileScope }): React.ReactNode {
  const candidates = useMemo(() => chatFileCandidates(content), [content])
  const [resolved, setResolved] = useState<{ key: string; files: ChatFileView[] }>({ key: '', files: [] })
  const key = JSON.stringify([fileScope?.sessionId, fileScope?.messageId, fileScope?.revision, candidates])
  useEffect(() => {
    if (!fileScope || !candidates.length) return
    let current = true
    void window.ds.chatFilesResolve({ sessionId: fileScope.sessionId, messageId: fileScope.messageId, candidates })
      .then((files: ChatFileView[]) => { if (current) setResolved({ key, files }) }).catch(() => { if (current) setResolved({ key, files: [] }) })
    return () => { current = false }
  }, [key])
  const files = useMemo(() => new Map((resolved.key === key ? resolved.files : []).flatMap(file => {
    const normalized = chatFileCandidate(file.candidate)
    return normalized ? [[normalized, file] as const] : []
  })), [resolved, key])
  const context = useMemo(() => fileScope ? { scope: fileScope, files } : null, [fileScope, files])
  return (
    <FileLinks.Provider value={context}><div className="markdown-body">
      <MarkdownContent content={content} />
    </div></FileLinks.Provider>
  )
})

export default Markdown
