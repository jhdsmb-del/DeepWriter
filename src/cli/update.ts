import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { getStableRelease, isNewerVersion } from '../shared/publicRelease'
import type { CliOptions } from './config'

type RequestOptions = { signal?: AbortSignal; request?: typeof fetch }
const MAX_ASSET_SIZE = 512 * 1024 * 1024
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

async function realDirectory(directory: string): Promise<{ path: string; dev: number; ino: number }> {
  const absolute = path.resolve(directory)
  // Reject junctions as well as symlinks, including ancestors. The directory
  // chosen by the author, not an alias into an installed CLI, is the boundary.
  let current = absolute
  while (true) {
    const stat = await fs.lstat(current).catch(() => { throw new Error('下载目录不存在或不可访问；请先创建一个新目录') })
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('下载目录及其父目录必须是真实目录，不能使用链接或文件')
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  const real = await fs.realpath(absolute)
  if (!samePath(real, absolute)) throw new Error('下载目录的实际位置不一致；请选择真实目录')
  const stat = await fs.stat(real)
  return { path: real, dev: stat.dev, ino: stat.ino }
}

async function assertDirectory(original: Awaited<ReturnType<typeof realDirectory>>): Promise<void> {
  const current = await realDirectory(original.path)
  if (current.dev !== original.dev || current.ino !== original.ino) throw new Error('下载目录已被替换；未发布下载文件')
}

export async function checkCliUpdate(currentVersion: string, options: RequestOptions = {}) {
  const release = await getStableRelease(options)
  return { currentVersion, ...release, updateAvailable: isNewerVersion(release.version, currentVersion) }
}

export async function downloadCliUpdate(directory: string, currentVersion: string, options: RequestOptions = {}) {
  const destination = await realDirectory(directory)
  const release = await checkCliUpdate(currentVersion, options)
  const asset = release.cliAsset
  if (!asset) return { ...release, status: 'unavailable' as const, path: null }
  const expectedName = `DeepWriter-${release.version}-cli-win-x64.zip`
  const expectedUrl = `https://github.com/jhdsmb-del/DeepWriter/releases/download/${release.tag}/${expectedName}`
  if (asset.name !== expectedName || asset.url !== expectedUrl || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_SIZE) throw new Error('官方 CLI 资产名称、地址或大小无效；请在官方发布页核对')
  if (!asset.sha256 || !/^[a-f0-9]{64}$/i.test(asset.sha256)) throw new Error(`官方发布 API 未提供此 CLI 包的 SHA-256，未下载。请在官方发布页核对：${release.pageUrl}`)
  const target = path.join(destination.path, expectedName)
  try { await fs.lstat(target); throw new Error('同名下载文件已存在，拒绝覆盖；请选择另一个目录') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await assertDirectory(destination)
  const temporary = await fs.mkdtemp(path.join(destination.path, '.deepwriter-download-'))
  const temporaryIdentity = await realDirectory(temporary)
  const partial = path.join(temporary, 'asset.partial')
  let response: Response | undefined
  try {
    response = await (options.request ?? fetch)(asset.url, {
      signal: options.signal, redirect: 'follow', headers: { Accept: 'application/octet-stream', 'User-Agent': `DeepWriter-CLI/${currentVersion}` }
    })
    if (!response.ok || !response.body) throw new Error(`官方 CLI 下载失败（HTTP ${response.status}）；请稍后重试或打开官方发布页`)
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== asset.size)) throw new Error('下载响应长度与官方发布 API 不符，已拒绝')
    const handle = await fs.open(partial, 'wx', 0o600)
    const digest = createHash('sha256')
    let received = 0
    try {
      for await (const chunk of response.body) {
        options.signal?.throwIfAborted()
        received += chunk.byteLength
        if (received > asset.size) throw new Error('下载内容超过官方发布 API 声明的大小，已拒绝')
        digest.update(chunk)
        let offset = 0
        while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten
      }
      if (received !== asset.size) throw new Error('下载不完整：实际长度与官方发布 API 不符，已拒绝')
      if (digest.digest('hex') !== asset.sha256.toLowerCase()) throw new Error('下载内容 SHA-256 与官方发布 API 不符，已拒绝')
      await handle.sync()
    } finally { await handle.close() }
    options.signal?.throwIfAborted()
    await assertDirectory(destination)
    await assertDirectory(temporaryIdentity)
    // Hard-link publication is atomic and exclusive. Do not use rename (which
    // can replace user files) or copyFile (which exposes an incomplete target).
    try { await fs.link(partial, target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('同名下载文件已存在，拒绝覆盖；请选择另一个目录')
      throw new Error('此目录不支持安全发布下载文件；请选择本机 NTFS 目录，或从官方发布页手动下载')
    }
    return { ...release, status: 'downloaded' as const, path: target, bytes: received, sha256: asset.sha256.toLowerCase() }
  } finally {
    // Cancel an unread/error body; never leave a partially downloaded archive.
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined)
    await assertDirectory(destination)
    await assertDirectory(temporaryIdentity)
    await fs.unlink(partial).catch(error => { if (error.code !== 'ENOENT') throw error })
    await fs.rmdir(temporary)
  }
}

export async function runCliUpdate(args: string[], options: CliOptions, currentVersion: string): Promise<void> {
  if (Object.keys(options).some(key => key !== 'json') || !((args[1] === 'check' && args.length === 2) || (args[1] === 'download' && args.length === 3 && args[2].trim()))) throw new Error('用法：deepwriter update check [--json] 或 deepwriter update download <已存在的目录> [--json]；不读取 Provider 配置')
  const controller = new AbortController()
  const abort = (): void => controller.abort(new Error('更新操作已取消，未运行下载内容'))
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  // The bundled Node supports standard HTTPS_PROXY/HTTP_PROXY/NO_PROXY. No
  // DeepWriter-specific URL/proxy overrides or credentials are consulted.
  let restoreProxy: (() => void) | undefined
  try {
    restoreProxy = typeof http.setGlobalProxyFromEnv === 'function' ? http.setGlobalProxyFromEnv() : undefined
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(args[1] === 'check' ? 30_000 : 300_000)])
    const data = args[1] === 'check' ? await checkCliUpdate(currentVersion, { signal }) : await downloadCliUpdate(args[2], currentVersion, { signal })
    const instruction = !data.cliAsset
      ? `此版本尚未发布独立 CLI 包。请打开 ${data.pageUrl} 查看完整包及 docs/CLI.md；不会用桌面安装包代替 CLI。`
      : !data.cliAsset.sha256
      ? `官方发布 API 尚未提供此 CLI 包的 SHA-256，安全下载不可用。请打开 ${data.pageUrl} 核对发行信息。`
      : '将 CLI ZIP 解压到新目录，先运行其中的 .\\cli\\deepwriter.cmd --version。保留旧 CLI 和原数据目录，沿用原 --data-dir；确认可用后再手动切换入口。下载不会安装或运行代码。'
    if (options.json) process.stdout.write(JSON.stringify({ type: 'update', data: { ...data, instruction } }) + '\n')
    else {
      process.stdout.write(`当前 CLI ${currentVersion} · 官方稳定版 ${data.version}${data.updateAvailable ? '（有新版本）' : '（当前无需升级）'}\n`)
      if ('path' in data && 'sha256' in data) process.stdout.write(`已校验并保存：${data.path}\nSHA-256 ${data.sha256}\n`)
      else if (data.cliAsset) process.stdout.write(`CLI 包：${data.cliAsset.name}\n下载：deepwriter update download <已存在的目录>\n`)
      process.stdout.write(instruction + '\n')
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('更新请求超时或已取消；未运行下载内容，请稍后重试')
    // Network errors may contain proxy URLs with credentials. Keep their raw
    // messages out of the public CLI error envelope.
    if (error instanceof TypeError) throw new Error('无法连接官方发布服务；请检查网络和 HTTPS_PROXY / NO_PROXY，或稍后重试')
    throw error
  } finally { restoreProxy?.(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
}
