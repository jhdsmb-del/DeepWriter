// ==================== 原生文件右键菜单（任务三） ====================
// 纯逻辑与 Electron 薄包装分离：buildFileContextActions 可独立测试。
// renderer 只提交 fileRefId（capability）；主进程解析真实路径并执行 clipboard/shell。
// 相对路径仅对当前 workspace root 内对象启用。

import * as path from 'path'
import { pathToFileURL } from 'url'
import type { ChatFileAction, ChatFileActionResult } from '../shared/chatFiles'

/** 动作所需的最小文件信息（FileRefInternal 兼容） */
export interface FileContextTarget {
  realpath: string
  kind: 'file' | 'dir'
}

export type FileContextAnchorKind = 'attachment' | 'file' | 'artifact' | 'style-source' | 'novel-chapter' | 'galgame-script'

export interface FileContextAction {
  id: 'open' | 'reveal' | 'copy-relative' | 'copy-absolute' | 'attach'
  label: string
  enabled: boolean
}

/** 按对象能力构建动作集（纯函数）；attach 仅文件可用 */
export function buildFileContextActions(cap: FileContextTarget, workDir: string): FileContextAction[] {
  const realRoot = path.resolve(workDir)
  const realPath = path.resolve(cap.realpath)
  const within = realPath === realRoot || realPath.toLowerCase().startsWith(realRoot.toLowerCase() + path.sep)
  const rel = within ? path.relative(realRoot, realPath) : null
  return [
    { id: 'open', label: '打开', enabled: true },
    { id: 'reveal', label: '在文件夹中显示', enabled: true },
    { id: 'copy-relative', label: rel ? `复制相对路径（${rel}）` : '复制相对路径', enabled: within && rel !== null && !rel.startsWith('..') },
    { id: 'copy-absolute', label: '复制绝对路径', enabled: true },
    { id: 'attach', label: '附加到下一次请求', enabled: cap.kind === 'file' }
  ]
}

export interface FileContextDeps {
  /** 剪贴板写入（主进程注入） */
  writeClipboard(text: string): void
  /** 系统打开/显示（主进程注入） */
  openPath(p: string): Promise<boolean>
  showItemInFolder(p: string): void
  /** 附加动作：主进程内部将 fileRefId 加入当前草稿（事件回来源窗口） */
  emitAttach(fileRefId: string): void
}

/** Reply files separate shell-open from the non-launching locate/copy actions. */
export function buildChatFileContextActions(canOpen: boolean): Array<{ id: ChatFileAction; label: string }> {
  return [
    ...(canOpen ? [{ id: 'open' as const, label: '打开文件' }] : []),
    { id: 'reveal', label: '在文件资源管理器中显示' },
    { id: 'copy-absolute', label: '复制路径' }
  ]
}

export async function executeChatFileContextAction(action: ChatFileAction, target: FileContextTarget & { canOpen: boolean }, deps: FileContextDeps): Promise<ChatFileActionResult> {
  if (action === 'open' && !target.canOpen) return { ok: false, message: '此类文件仅支持定位或复制路径，不能直接启动' }
  return executeFileContextAction(action, target, path.dirname(target.realpath), deps)
}

/** 执行动作（主进程调用） */
export async function executeFileContextAction(actionId: string, cap: FileContextTarget, workDir: string, deps: FileContextDeps): Promise<{ ok: boolean; message?: string }> {
  switch (actionId) {
    case 'open': {
      const ok = await deps.openPath(cap.realpath)
      return { ok, message: ok ? undefined : '打开失败' }
    }
    case 'reveal': {
      deps.showItemInFolder(cap.realpath)
      return { ok: true }
    }
    case 'copy-absolute': {
      deps.writeClipboard(cap.realpath)
      return { ok: true }
    }
    case 'copy-relative': {
      const realRoot = path.resolve(workDir)
      const realPath = path.resolve(cap.realpath)
      const within = realPath === realRoot || realPath.toLowerCase().startsWith(realRoot.toLowerCase() + path.sep)
      if (!within) return { ok: false, message: '对象不在工作区内，无相对路径' }
      const rel = path.relative(realRoot, realPath)
      if (rel.startsWith('..')) return { ok: false, message: '对象不在工作区内，无相对路径' }
      deps.writeClipboard(rel)
      return { ok: true }
    }
    default:
      return { ok: false, message: `未知动作：${actionId}` }
  }
}

/** 当前文件 URL 是否可显示（供 renderer 判断右键可用性，可选） */
export function toFileUrl(p: string): string {
  return pathToFileURL(p).href
}
