// ==================== IPC 安全守卫（Gate 1 / P0-02） ====================
// 统一 sender 鉴权 + zod schema 校验 + 载荷上限 + 错误码。
// 所有 ipcMain.handle/on 必须经 registerIpc / registerIpcOn 注册，禁止裸 ipcMain 调用。

import { ipcMain, type IpcMainInvokeEvent, type IpcMainEvent, type WebFrameMain } from 'electron'
import * as path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type { ZodType } from 'zod'

/** 打包后 __dirname = out/main；ESM bundle 下用 import.meta.url 兜底 */
const MODULE_DIR: string =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url))

export class IpcError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
    this.name = 'IpcError'
  }
}

/**
 * 校验 IPC 调用方是本应用主窗口的主 frame。
 * 非主 frame（iframe/subframe）、非本应用 origin、被导航到任意 file:/http 页面时一律拒绝。
 * 任务二：dev 模式用 URL origin 精确比较（protocol+host+port），不再使用 startsWith 前缀信任。
 */
export function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const frame: WebFrameMain | null | undefined = event.senderFrame
  if (!frame) throw new IpcError('sender_missing', 'IPC 调用缺少 sender frame')
  const sender = event.sender
  if (!sender) throw new IpcError('sender_missing', 'IPC 调用缺少 sender')
  // 只接受主 frame（event.senderFrame 是主 frame 时才与 sender.mainFrame 相等）
  if (frame !== sender.mainFrame) throw new IpcError('sender_rejected', 'IPC 只允许主 frame 调用')
  const url = frame.url
  if (!url) throw new IpcError('sender_rejected', 'IPC 调用来源不可识别')
  if (!isTrustedSenderUrl(url)) throw new IpcError('sender_rejected', 'IPC 调用来源不被信任')
}

/** 精确来源判定：dev 比 origin（protocol+host+port，且禁 userinfo）；生产精确匹配打包 index.html */
export function isTrustedSenderUrl(url: string): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    try {
      const u = new URL(url)
      const d = new URL(devUrl)
      // origin 相等 + userinfo 必须为空（URL 规范的 origin 忽略 userinfo，需显式排除）
      if (u.origin === d.origin && u.username === '' && u.password === '') return true
    } catch {
      /* 非法 URL 继续走生产判定 */
    }
  }
  const prodUrl = new URL(pathToFileURL(path.join(MODULE_DIR, '..', 'renderer', 'index.html')).href)
  try {
    const candidate = new URL(url)
    if (candidate.protocol !== 'file:' || candidate.pathname !== prodUrl.pathname || candidate.hash !== '') return false
    // 主窗口无 query；悬浮窗只允许固定的 ?window=float，不扩大到任意本地 file URL。
    return candidate.search === '' || candidate.search === '?window=float'
  } catch {
    return false
  }
}

export interface IpcHandleOpts<S> {
  /** zod schema：入参校验（parse 失败 → IpcError bad_input，不进入 handler） */
  schema?: ZodType<S>
  /** 序列化后的载荷大小上限（字节），默认 1MB */
  maxPayloadBytes?: number
  /** 是否在错误传播时脱敏（默认脱敏消息，避免把内部路径/参数回传） */
  safeError?: boolean
  publicError?: (error: unknown) => IpcError | undefined
}

const MAX_DEFAULT = 1024 * 1024

function validatePayload(value: unknown, opts: IpcHandleOpts<unknown>): void {
  const raw = JSON.stringify(value)
  if (raw !== undefined && raw.length > (opts.maxPayloadBytes ?? MAX_DEFAULT)) {
    throw new IpcError('payload_too_large', 'IPC 载荷超过大小上限')
  }
}

function parseInput<S>(value: unknown, opts: IpcHandleOpts<S>): S {
  validatePayload(value, opts as IpcHandleOpts<unknown>)
  if (!opts.schema) return value as S
  const r = opts.schema.safeParse(value)
  if (!r.success) {
    const first = r.error.issues[0]
    const msg = first ? `${first.path.join('.') || '(root)'}: ${first.message}` : '输入不符合 schema'
    throw new IpcError('bad_input', `IPC 入参校验失败 — ${msg}`)
  }
  return r.data
}

/** 注册 ipcMain.handle：sender guard + schema + 统一错误码 */
export function registerIpc<S, R>(
  channel: string,
  opts: IpcHandleOpts<S>,
  handler: (event: IpcMainInvokeEvent, input: S) => R | Promise<R>
): void {
  ipcMain.handle(channel, async (event, input) => {
    assertTrustedSender(event)
    const safeInput = parseInput(input, opts)
    try {
      return await handler(event, safeInput)
    } catch (e) {
      if (e instanceof IpcError) throw e
      const publicError = opts.publicError?.(e)
      if (publicError) throw publicError
      // 其他异常：统一转为 IpcError（避免内部细节泄漏），仍保留原始错误码供审计
      const msg = opts.safeError === false ? (e as Error).message : '内部错误，已记录'
      const code = (e as Error & { code?: string }).code ?? 'internal_error'
      console.warn(`[ipc] ${channel} 失败：`, (e as Error).message)
      throw new IpcError(code, msg)
    }
  })
}

/** 注册 ipcMain.on（fire-and-forget 通道）：同样强制 sender guard + schema */
export function registerIpcOn<S>(
  channel: string,
  opts: IpcHandleOpts<S>,
  handler: (event: IpcMainEvent, input: S) => void
): void {
  ipcMain.on(channel, (event, input) => {
    try {
      assertTrustedSender(event)
      const safeInput = parseInput(input, opts)
      handler(event, safeInput)
    } catch (e) {
      console.warn(`[ipc] ${channel} 拒绝：`, (e as Error).message)
    }
  })
}

/** 重置缓存（测试用） */
export function __resetSenderCacheForTests(): void {
  /* 无缓存状态（精确比较无缓存），保留空实现兼容旧测试引用 */
}
