import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useStore } from '../store'
import MessageBubble from './MessageBubble'
import Icon, { type IconName } from './Icon'

/** Streaming changes stay in the transcript, leaving navigation and input idle. */
export default function ChatMessages({ onOpenSettings }: { onOpenSettings?: () => void }): React.ReactNode {
  const messages = useStore((state) => state.messages)
  const sessionId = useStore((state) => state.currentSessionId)
  const parentRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const manualScroll = useRef(false)
  const scrollDirection = useRef<'up' | 'down' | null>(null)
  const frame = useRef<number | null>(null)
  const [showLatest, setShowLatest] = useState(false)
  const virtualizer = useVirtualizer({
    count: messages.length, getScrollElement: () => parentRef.current,
    estimateSize: () => 120, overscan: 10, getItemKey: (index) => messages[index]!.id
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const message = messages[item.index]
    // A long streaming row starts above the viewport even when its new text
    // is below it. Its growth must not move the reader's current position.
    return !following.current && message?.status !== 'streaming' && message?.status !== 'thinking' && item.index < messages.length - 1 && item.start < (instance.scrollOffset ?? 0)
  }
  const follow = useCallback((value: boolean): void => {
    following.current = value
    setShowLatest(!value)
  }, [])
  const scrollToLatest = useCallback((): void => {
    if (!following.current || frame.current !== null) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null
      if (!following.current || !parentRef.current) return
      manualScroll.current = false
      parentRef.current.scrollTop = parentRef.current.scrollHeight
    })
  }, [])
  useLayoutEffect(() => { follow(true); manualScroll.current = false }, [sessionId, follow])
  useLayoutEffect(scrollToLatest, [messages, scrollToLatest])
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    // Markdown, code blocks and tool details can grow after React commits.
    const observer = new ResizeObserver(scrollToLatest)
    observer.observe(content)
    scrollToLatest()
    return () => observer.disconnect()
  }, [messages.length, scrollToLatest])
  useEffect(() => () => { if (frame.current !== null) window.cancelAnimationFrame(frame.current) }, [])

  if (messages.length === 0) return (
    <div className="message-list dw-empty-wrap">
      <div className="empty-state dw-empty-state">
        <div className="dw-writing-mark" aria-hidden="true"><Icon name="edit" size={28} /></div>
        <h1>今天想写什么？</h1>
        <div className="dw-starter-prompts" aria-label="开始任务">
          {([
            { icon: 'edit', label: '起草文字', prompt: '帮我起草一段文字：' },
            { icon: 'search', label: '查资料', prompt: '帮我联网查找资料，并附上来源链接。主题是：' },
            { icon: 'folder', label: '处理文件', prompt: '帮我处理当前工作目录中的文件：' }
          ] satisfies Array<{ icon: IconName; label: string; prompt: string }>).map(({ icon, label, prompt }) => <button key={label} onClick={() => {
            useStore.getState().setComposerText(prompt)
            document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
          }}><Icon name={icon} size={18} />{label}</button>)}
        </div>
      </div>
    </div>
  )
  return (
    <div className="dw-chat-transcript">
      <div className="message-list virtualized" ref={parentRef} style={{ overflowAnchor: 'none' }}
        onWheel={(event) => {
          manualScroll.current = true
          scrollDirection.current = event.deltaY < 0 ? 'up' : 'down'
          if (event.deltaY < 0) follow(false)
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget || event.nativeEvent.offsetX >= event.currentTarget.clientWidth) { manualScroll.current = true; scrollDirection.current = null }
        }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
            manualScroll.current = true
            scrollDirection.current = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ? 'up' : 'down'
            if (scrollDirection.current === 'up') follow(false)
          }
        }}
        onScroll={(event) => {
          const el = event.currentTarget
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96
          if (nearBottom && (following.current || (manualScroll.current && scrollDirection.current !== 'up'))) follow(true)
          else if (manualScroll.current) follow(false)
        }}>
        <div className="message-list-inner" ref={contentRef} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div key={item.key} className="msg-row" data-index={item.index} ref={virtualizer.measureElement} style={{ transform: `translateY(${item.start}px)` }}>
              <MessageBubble msg={messages[item.index]!} onOpenSettings={onOpenSettings} />
            </div>
          ))}
        </div>
      </div>
      {showLatest && <button className="scroll-to-bottom-btn" onClick={() => { follow(true); scrollToLatest() }}>↓ 回到最新</button>}
    </div>
  )
}
