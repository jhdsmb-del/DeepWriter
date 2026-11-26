import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

export type TransportPolicy = { scope: 'public_https' | 'loopback_http'; allowNonDefaultPort: boolean }
export type AddressResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>

export class ProviderSecurityError extends Error {
  readonly code = 'provider_security_rejected'
  constructor(message: string) {
    super(message)
    this.name = 'ProviderSecurityError'
  }
}

const defaultResolver: AddressResolver = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

function ipv4Parts(address: string): number[] | null {
  if (isIP(address) !== 4) return null
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? parts : null
}

export function classifyAddress(address: string): 'public' | 'loopback' | 'blocked' {
  const normalized = address.toLowerCase().split('%')[0]
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return 'blocked'
  const v4 = ipv4Parts(normalized)
  if (v4) {
    const [a, b] = v4
    if (a === 127) return 'loopback'
    if (
      a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) return 'blocked'
    return 'public'
  }
  if (isIP(normalized) !== 6) return 'blocked'
  if (normalized === '::1') return 'loopback'
  if (normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff')) return 'blocked'
  return 'public'
}

function validatePath(path: string, label: string): string {
  if (!path.startsWith('/')) throw new ProviderSecurityError(`${label} 必须以 / 开头`)
  if (path.length > 512 || /[\\\u0000]/.test(path)) throw new ProviderSecurityError(`${label} 含不安全字符`)
  let decoded = path
  for (let index = 0; index < 3; index++) {
    try { decoded = decodeURIComponent(decoded) } catch { throw new ProviderSecurityError(`${label} 编码无效`) }
    if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\u0000')) throw new ProviderSecurityError(`${label} 含路径穿越`)
  }
  return path
}

export function canonicalJoin(baseUrl: string, path: string): string {
  const base = new URL(baseUrl)
  const safePath = validatePath(path, 'API 路径')
  base.pathname = safePath
  base.search = ''
  base.hash = ''
  return base.toString()
}

export interface ValidatedEndpoint {
  baseUrl: string
  origin: string
  hostname: string
  addresses: Array<{ address: string; family: number }>
}

export function validateProviderEndpointSyntax(raw: string, policy: TransportPolicy): { url: URL; hostname: string } {
  let url: URL
  try { url = new URL(raw) } catch { throw new ProviderSecurityError('API Host 不是有效 URL') }
  if (url.username || url.password || url.search || url.hash) throw new ProviderSecurityError('API Host 不允许账号、查询参数或片段')
  if (url.pathname !== '/' && url.pathname !== '') throw new ProviderSecurityError('API Host 只填写 origin，接口路径请单独设置')
  const hostname = url.hostname.toLowerCase()
  const literalHost = hostname.replace(/^\[|\]$/g, '')
  const loopbackHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  if (policy.scope === 'loopback_http') {
    if (url.protocol !== 'http:' || !loopbackHost) throw new ProviderSecurityError('本地模式只允许 http://localhost、127.0.0.1 或 [::1]')
  } else {
    if (url.protocol !== 'https:' || loopbackHost) throw new ProviderSecurityError('公网 Provider 必须使用 HTTPS')
    if (url.port && url.port !== '443' && !policy.allowNonDefaultPort) throw new ProviderSecurityError('公网非 443 端口需显式允许')
    if (isIP(literalHost) && classifyAddress(literalHost) !== 'public') throw new ProviderSecurityError('Provider 是私网、loopback、link-local 或保留地址')
  }
  return { url, hostname }
}

export async function validateProviderEndpoint(
  raw: string,
  policy: TransportPolicy,
  resolver: AddressResolver = defaultResolver
): Promise<ValidatedEndpoint> {
  const { url, hostname } = validateProviderEndpointSyntax(raw, policy)
  let addresses: Array<{ address: string; family: number }>
  try { addresses = await resolver(hostname.replace(/^\[|\]$/g, '')) } catch { throw new ProviderSecurityError('无法安全解析 Provider 地址') }
  if (addresses.length === 0) throw new ProviderSecurityError('Provider 地址没有可用解析结果')
  const classes = addresses.map((entry) => classifyAddress(entry.address))
  if (policy.scope === 'loopback_http') {
    if (classes.some((value) => value !== 'loopback')) throw new ProviderSecurityError('本地 Provider 解析结果不是 loopback')
  } else if (classes.some((value) => value !== 'public')) {
    throw new ProviderSecurityError('Provider 解析到私网、loopback、link-local 或保留地址')
  }
  url.pathname = '/'
  return { baseUrl: url.toString().replace(/\/$/, ''), origin: url.origin, hostname, addresses }
}

export async function secureProviderFetch(
  urlText: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  policy: TransportPolicy,
  resolver: AddressResolver = defaultResolver,
  limits: { timeoutMs?: number; maxBodyBytes?: number } = {}
): Promise<Response> {
  const target = new URL(urlText)
  const base = `${target.protocol}//${target.host}`
  const validated = await validateProviderEndpoint(base, policy, resolver)
  const address = validated.addresses[0]
  const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest
  const maxBodyBytes = limits.maxBodyBytes ?? 2 * 1024 * 1024
  return await new Promise<Response>((resolve, reject) => {
    const request = requestFn({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: init.method ?? 'GET',
      headers: init.headers,
      // Node requests an address list when picking a network family. Both
      // callback forms must use only the addresses validated for this request.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, validated.addresses)
        else callback(null, address.address, address.family as 4 | 6)
      }
    }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400) {
        response.destroy()
        reject(new ProviderSecurityError('Provider 重定向已被安全策略拒绝'))
        return
      }
      let observed = 0
      response.on('data', (chunk: Buffer) => {
        observed += chunk.byteLength
        if (observed > maxBodyBytes) response.destroy(new ProviderSecurityError('Provider 响应超过安全上限'))
      })
      const headers = new Headers()
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(key, item))
        else if (value !== undefined) headers.set(key, String(value))
      }
      const body = Readable.toWeb(response) as ReadableStream<Uint8Array>
      resolve(new Response(body, { status, statusText: response.statusMessage, headers }))
    })
    const timer = setTimeout(() => request.destroy(new Error('Provider 请求超时')), limits.timeoutMs ?? 30_000)
    request.on('close', () => clearTimeout(timer))
    request.on('error', reject)
    if (init.signal) {
      if (init.signal.aborted) request.destroy(new DOMException('Aborted', 'AbortError'))
      else init.signal.addEventListener('abort', () => request.destroy(new DOMException('Aborted', 'AbortError')), { once: true })
    }
    if (init.body) request.write(init.body)
    request.end()
  })
}

export function validateProviderPath(path: string | null, label: string): string | null {
  return path === null ? null : validatePath(path, label)
}
