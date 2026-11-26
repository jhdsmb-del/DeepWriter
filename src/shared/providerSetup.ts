import type { ProviderProtocol } from './providerRegistry'

export interface ProviderSetupInput {
  displayName: string
  baseUrl: string
  apiKey: string
  authStyle?: 'bearer' | 'none'
  protocol: Exclude<ProviderProtocol, 'deepseek-chat'>
  modelIds: string[]
}

export interface ProviderSetupUpdateInput {
  providerId: string
  baseUrl: string
  apiKey?: string
  clearApiKey?: boolean
  authStyle?: 'bearer' | 'none'
  protocol: ProviderSetupInput['protocol']
}

/** A conventional Base URL is split into the existing origin + path contract.
 * This does not relax the main process's DNS, redirect or credential policy. */
export function providerSetupEndpoint(raw: string, protocol: ProviderSetupInput['protocol']): {
  baseUrl: string; chatPath: string; modelsPath: string; local: boolean
} {
  const url = new URL(raw.trim())
  if (url.username || url.password || url.search || url.hash) throw new Error('Base URL 不能包含账号、查询参数或片段')
  const path = url.pathname.replace(/\/+$/, '')
  // URL parsing normalizes dot segments: reject them before that normalization.
  let decoded = raw.trim()
  for (let pass = 0; pass < 3; pass++) decoded = decodeURIComponent(decoded)
  if (/[\\\u0000-\u001f]/.test(decoded) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded)) throw new Error('Base URL 含不安全路径')
  const suffix = protocol === 'anthropic-messages' ? '/messages' : protocol === 'openai-responses' ? '/responses' : '/chat/completions'
  const fullEndpoint = /\/(?:chat\/completions|responses|messages)$/.test(path)
  if (fullEndpoint && !path.endsWith(suffix)) throw new Error('Base URL 中的接口与所选 API 格式不一致')
  const prefix = fullEndpoint ? path.slice(0, -suffix.length) : path || '/v1'
  return {
    baseUrl: url.origin,
    chatPath: prefix + suffix,
    modelsPath: prefix + '/models',
    local: url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  }
}
