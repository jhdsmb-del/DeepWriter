// Public release discovery is separate from model providers and user credentials.
// Only metadata is read here. The installer and CLI each verify their own downloads.
const repo = 'jhdsmb-del/DeepWriter'
const web = 'https://github.com/' + repo
const api = 'https://api.github.com/repos/' + repo + '/releases/latest'
const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

export interface PublicReleaseAsset { name: string; url: string; size: number; sha256: string | null }
export interface PublicRelease {
  version: string
  tag: string
  pageUrl: string
  portableUrl: string | null
  completeUrl: string | null
  cliAsset: PublicReleaseAsset | null
}
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!stable.test(candidate) || !stable.test(current)) return false
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}
type Asset = { name?: unknown; state?: unknown; size?: unknown; browser_download_url?: unknown; digest?: unknown }
export function parsePublicRelease(data: unknown): PublicRelease {
  const v = data as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }
  if (!v || typeof v.tag_name !== 'string' || !v.tag_name.startsWith('v') || !stable.test(v.tag_name.slice(1)) ||
    v.draft !== false || v.prerelease !== false || v.html_url !== web + '/releases/tag/' + v.tag_name || !Array.isArray(v.assets)) {
    throw new Error('没有读到 DeepWriter 的正式版本信息。')
  }
  const version = v.tag_name.slice(1), tag = v.tag_name, assets = v.assets
  function file(name: string): PublicReleaseAsset | null {
    const url = web + '/releases/download/' + tag + '/' + name
    const matches = assets.filter((a: Asset | null) => a?.name === name)
    if (matches.length !== 1) return null
    const a = matches[0] as Asset
    if (a.state !== 'uploaded' || a.browser_download_url !== url || typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size < 1) return null
    return { name, url, size: a.size, sha256: typeof a.digest === 'string' && /^sha256:[a-f\d]{64}$/.test(a.digest) ? a.digest.slice(7) : null }
  }
  return { version, tag, pageUrl: web + '/releases/tag/' + tag, portableUrl: file('DeepWriter-' + version + '-x64-portable.exe')?.url ?? null,
    completeUrl: file('DeepWriter-' + version + '-complete.zip')?.url ?? null, cliAsset: file('DeepWriter-' + version + '-cli-win-x64.zip') }
}
export async function getStableRelease(options: { signal?: AbortSignal; request?: typeof fetch } = {}): Promise<PublicRelease> {
  const timer = AbortSignal.timeout(15_000)
  const signal = options.signal ? AbortSignal.any([timer, options.signal]) : timer
  try {
    const reply = await (options.request ?? fetch)(api, { method: 'GET', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DeepWriter-Updates' },
      credentials: 'omit', redirect: 'error', signal })
    if (reply.status === 403 || reply.status === 429) throw new Error('GitHub 暂时限制了更新查询，请稍后再试。')
    if (!reply.ok) throw new Error('GitHub 更新服务暂不可用（HTTP ' + reply.status + '）。')
    return parsePublicRelease(await reply.json())
  } catch (error) {
    if (signal.aborted) throw new Error(options.signal?.aborted ? '已取消更新检查。' : '检查更新超时，请稍后再试。')
    if (error instanceof TypeError) throw new Error('无法连接 GitHub，请检查网络或代理后再试。')
    throw error
  }
}
