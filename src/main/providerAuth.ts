import { validateProviderEndpointSyntax, type TransportPolicy } from './providerSecurity'

/** Secrets are resolved by the existing encrypted credential service, never stored in this policy. */
export interface ProviderHeaderPolicy {
  baseUrl: string
  authStyle: 'bearer' | 'none'
  authHeaderName?: string
  protocol?: string
  transportPolicy: TransportPolicy
  fixedHeaders?: Record<string, string>
  extraHeaders?: Record<string, string>
}
export class ProviderAuthError extends Error {
  readonly code = 'provider_auth_rejected'
  constructor(message: string) { super(message); this.name = 'ProviderAuthError' }
}

/** Provider response text is untrusted and may echo credentials. */
export function providerHttpErrorMessage(status: number): string {
  const reason = status === 401 ? '此供应商的凭据无效或已过期，请检查该供应商的 API Key'
    : status === 403 ? '当前账号没有该模型的访问权限，请检查模型授权'
      : status === 402 ? '账户余额或配额不足，请检查该供应商账户'
        : status === 429 ? '请求触发限流，请稍后重试'
          : status >= 500 && status < 600 ? '供应商服务暂时不可用，请稍后重试'
            : '请求未完成，请检查接口地址与 API 格式'
  return `Provider HTTP ${status}：${reason}`
}
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const SECURITY_HEADER = /^(authorization|proxy-authorization|cookie|host|content-length|content-type|accept|connection|transfer-encoding|x-api-key|api-key|x-goog-api-key|anthropic-version)$/i
const SECRET_HEADER = /(api[-_]?key|token|secret|password|credential|authorization|cookie)/i
const BAD_VALUE = /[\r\n\u0000]/

/** Authentication is applied once, last, and only to the exact provider origin. */
export function buildProviderAuthHeaders(policy: ProviderHeaderPolicy, secret: string | null, input: {
  targetUrl: string
  accept?: 'application/json' | 'text/event-stream'
  jsonBody?: boolean
  providerId?: string
  credentialProviderId?: string
}): Record<string, string> {
  const origin = validateProviderEndpointSyntax(policy.baseUrl, policy.transportPolicy).url.origin
  let target: URL
  try { target = new URL(input.targetUrl) } catch { throw new ProviderAuthError('Provider 请求 URL 无效') }
  if (target.origin !== origin || target.username || target.password || target.hash) throw new ProviderAuthError('认证不能跨 Provider origin 或 URL 身份发送')
  if ((input.providerId || input.credentialProviderId) && (!input.providerId || input.providerId !== input.credentialProviderId)) throw new ProviderAuthError('凭据引用不属于该 Provider')
  const headers: Record<string, string> = { accept: input.accept ?? 'application/json' }
  if (input.jsonBody) headers['content-type'] = 'application/json'
  const inserted = new Set(Object.keys(headers))
  const add = (name: string, value: string): void => {
    const lower = name.toLowerCase()
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || value.length > 4096 || BAD_VALUE.test(value) || inserted.has(lower)) throw new ProviderAuthError('Provider Header 含重复或不安全字段')
    inserted.add(lower); headers[lower] = value
  }
  for (const [name, value] of Object.entries(policy.extraHeaders ?? {})) {
    if (SECRET_HEADER.test(name) || SECURITY_HEADER.test(name)) throw new ProviderAuthError('额外 Header 不能承载秘密或覆盖安全关键头')
    add(name, value)
  }
  for (const [name, value] of Object.entries(policy.fixedHeaders ?? {})) {
    if (policy.protocol !== 'anthropic-messages' || name.toLowerCase() !== 'anthropic-version' || value !== '2023-06-01') throw new ProviderAuthError('仅允许受控协议 Header')
    add(name, value)
  }
  if (policy.authStyle === 'none') {
    if (policy.transportPolicy.scope !== 'loopback_http') throw new ProviderAuthError('免 Key 仅允许明确的本机接口')
    return headers
  }
  if (policy.authStyle !== 'bearer' || typeof secret !== 'string' || !secret.trim() || secret.length > 16384 || BAD_VALUE.test(secret)) throw new ProviderAuthError('Provider 认证凭据不可用')
  const authName = policy.authHeaderName ?? 'Authorization'
  if (!HEADER_NAME.test(authName) || /^(proxy-authorization|cookie|host|content-length|content-type|accept|connection|transfer-encoding|anthropic-version)$/i.test(authName)) throw new ProviderAuthError('认证 Header 名称无效')
  const value = authName.toLowerCase() === 'authorization'
    ? /^Bearer /i.test(secret) ? secret : `Bearer ${secret}`
    : secret
  // Credential values have their own bounded length; they must never appear in errors.
  const lower = authName.toLowerCase()
  if (inserted.has(lower)) throw new ProviderAuthError('认证 Header 重复')
  headers[lower] = value
  return headers
}
