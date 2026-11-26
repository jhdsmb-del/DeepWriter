export interface ModelFailureNotice { title: string; detail: string; settings: boolean }

/** Present known transport/auth failures without repeating provider response bodies. */
export function modelFailureNotice(code?: string, message?: string): ModelFailureNotice | null {
  const text = `${code ?? ''} ${message ?? ''}`
  if (/\b402\b|insufficient[_ ](?:balance|quota)|余额不足|账户余额/iu.test(text))
    return { title: '服务商余额不足', detail: '请检查该服务商的余额或账户额度，处理后再重试。', settings: false }
  if (/\b40[13]\b|unauthori[sz]ed|invalid[_ -]?(?:api[_ -]?)?key|authentication|鉴权失败|密钥无效/iu.test(text))
    return { title: 'API Key 或模型权限未通过验证', detail: '请在“设置 → 模型与接口”检查当前服务商的 API Key 和模型权限。', settings: true }
  if (/credential_(?:missing|not_found|locked)|缺少.*(?:key|密钥|凭据)|没有可用凭据|凭据不可用|请填写 API Key/iu.test(text))
    return { title: '当前服务商未配置可用的 API Key', detail: '请在“设置 → 模型与接口”填写并保存该服务商的密钥。', settings: true }
  if (/ERR_INVALID_IP_ADDRESS|ENOTFOUND|EAI_AGAIN|ECONN(?:REFUSED|RESET)|ETIMEDOUT|fetch failed|network error|网络连接|连接超时/iu.test(text))
    return { title: '网络连接失败', detail: '请检查网络、代理和当前服务商的 Base URL，再重试。', settings: true }
  if (/\b429\b|rate[_ -]?limit|请求过于频繁/iu.test(text))
    return { title: '服务商暂时限制了请求', detail: '请稍后重试，或检查账户的请求额度。', settings: false }
  return null
}

export function messageRunId(id: string): string {
  return id.startsWith('m_') && id.endsWith('_assistant') ? id.slice(2, -10) : id
}
