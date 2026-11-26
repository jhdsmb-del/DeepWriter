export type IconName =
  | 'globe'
  | 'search'
  | 'chat'
  | 'document'
  | 'tasks'
  | 'tools'
  | 'receipt'
  | 'refresh'
  | 'arrowUp'
  | 'arrowLeft'
  | 'shield'
  | 'model'
  | 'memory'
  | 'flask'
  | 'game'
  | 'sidebar'
  | 'plus'
  | 'settings'
  | 'float'
  | 'send'
  | 'stop'
  | 'paperclip'
  | 'chevronDown'
  | 'more'
  | 'edit'
  | 'export'
  | 'trash'
  | 'close'
  | 'check'
  | 'open'
  | 'folder'
  | 'copy'
  | 'pin'

const PATHS: Record<IconName, React.ReactNode> = {
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9Z"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  chat: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/>,
  document: <><path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/></>,
  tasks: <><rect x="4" y="4" width="16" height="17" rx="2"/><path d="M9 4V2h6v2M8 10l1 1 2-2M13 10h3M8 16l1 1 2-2M13 16h3"/></>,
  tools: <><path d="m14 6 4 4 3-3a6 6 0 0 1-8 7L6 21l-3-3 7-7a6 6 0 0 1 7-8l-3 3Z"/></>,
  receipt: <><path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Z"/><path d="M9 7h6M9 11h6M9 15h3"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2"/></>,
  arrowUp: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  arrowLeft: <path d="M19 12H5m6 6-6-6 6-6"/>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
  model: <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4M10 10h4v4h-4Z"/></>,
  memory: <><path d="M4 4h7v16H4zM13 4h7v16h-7zM7 8h1M7 12h1M16 8h1M16 12h1"/></>,
  flask: <><path d="M9 3h6M10 3v7L4 20h16l-6-10V3M8 14h8"/></>,
  game: <><path d="M7 7h10a4 4 0 0 1 4 4v7a2 2 0 0 1-3 2l-4-3h-4l-4 3a2 2 0 0 1-3-2v-7a4 4 0 0 1 4-4Z"/><path d="M6 11v4M4 13h4M16 11h.01M19 14h.01"/></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/></>,
  pin: <><path d="m15 3 6 6-3 1-4 4v4l-8-8h4l4-4 1-3Z"/><path d="m9 15-6 6"/></>,
  folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>,
  sidebar: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 3v18"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1v.1H9.5V21a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1-.4h-.1V9.5h.1A1.7 1.7 0 0 0 4 8.4a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.46 3.6l.06.06A1.7 1.7 0 0 0 8.4 4a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1v-.1h4.1v.1A1.7 1.7 0 0 0 15 4a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8c.14.36.36.7.66.96.28.25.63.4 1 .44h.1v4.1h-.1A1.7 1.7 0 0 0 19.4 15Z"/></>,
  float: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M14 9h4v4M18 9l-5 5"/></>,
  send: <path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  paperclip: <path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 1 1-2.8-2.8l8.9-8.9"/>,
  chevronDown: <path d="m7 10 5 5 5-5"/>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
  edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></>,
  export: <><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 14v6h14v-6"/></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/><path d="M10 11v6M14 11v6"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  open: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></>
}

export default function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }): React.ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
