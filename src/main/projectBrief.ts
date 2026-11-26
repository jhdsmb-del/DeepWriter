import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PROJECT_BRIEF_FILE, PROJECT_BRIEF_LIMIT, type ProjectBrief } from '../shared/projectBrief'
import { publishUtf8Exclusive } from './exclusiveFile'
import { writeTextAtomically } from './agentFiles'

export class ProjectBriefError extends Error {}

export async function readProjectBrief(workDir: string): Promise<ProjectBrief> {
  const file = path.resolve(workDir, PROJECT_BRIEF_FILE)
  const blocked = (notice: string): ProjectBrief => ({ path: file, state: 'unavailable', text: '', notice })
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return blocked('约定文件须是工作目录内的普通文本文件')
    const f = await fs.open(file, 'r')
    try {
      const st = await f.stat()
      if (!st.isFile() || stat.dev !== st.dev || stat.ino !== st.ino) return blocked('文件位置已变动，请重新打开')
      const buffer = Buffer.alloc(Math.min(PROJECT_BRIEF_LIMIT * 4 + 4, st.size))
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await f.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      const partial = st.size > buffer.length
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset), { stream: partial })
      if (raw.includes('\0')) return blocked('请将约定另存为 UTF-8 文本')
      const chars = Array.from(raw)
      if (partial || chars.length > PROJECT_BRIEF_LIMIT) return { path: file, state: 'limited', text: chars.slice(0, PROJECT_BRIEF_LIMIT).join(''), notice: '新任务只使用约定的前 6000 字。请在原文件中精简后再编辑。' }
      return { path: file, state: 'ready', text: raw }
    } finally { await f.close() }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, text: '', state: 'missing' }
    return blocked('无法读取项目约定，请检查文件权限和 UTF-8 编码')
  }
}

export async function saveProjectBrief(workDir: string, prior: { path: string; text: string; exists: boolean }, text: string): Promise<ProjectBrief> {
  if (Array.from(text).length > PROJECT_BRIEF_LIMIT || /[\uD800-\uDFFF\0]/u.test(text)) throw new ProjectBriefError('请使用不超过 6000 字的有效文本')
  const target = path.resolve(workDir, PROJECT_BRIEF_FILE)
  if (prior.path !== target) throw new ProjectBriefError('工作目录已切换，请重新打开项目约定')
  const assertCurrent = async (): Promise<void> => {
    const actual = await readProjectBrief(workDir)
    if (actual.state !== (prior.exists ? 'ready' : 'missing') || actual.text !== prior.text) throw new ProjectBriefError('项目约定已在别处修改。请重新载入，再合并你的修改。')
  }
  await assertCurrent()
  if (!prior.exists) await publishUtf8Exclusive(target, text)
  else if (text !== prior.text) await writeTextAtomically(target, text, undefined, assertCurrent)
  return { path: target, state: 'ready', text }
}
