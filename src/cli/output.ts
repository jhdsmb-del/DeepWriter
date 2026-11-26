import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { publishUtf8Exclusive } from '../main/exclusiveFile'

/** Resolve the user's explicit output before a paid request. Publishing still
 * uses an exclusive link, so a file created in the meantime cannot be replaced. */
export async function prepareOutput(file: string): Promise<string> {
  if (file === '-') return file
  const absolute = path.resolve(file)
  const parent = await fs.realpath(path.dirname(absolute)).catch(() => { throw new Error('输出目录不存在或不可访问；请先创建目录') })
  const target = path.join(parent, path.basename(absolute))
  try { await fs.lstat(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target
    throw error
  }
  throw new Error('输出文件已存在，拒绝覆盖；请选择新路径')
}

export async function saveOutput(target: string, text: string): Promise<void> {
  try { await publishUtf8Exclusive(target, text) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('输出文件已存在，拒绝覆盖；可使用 export RUN --output 新路径 重试，无需模型调用')
    throw error
  }
}
