import { promises as fs } from 'fs'
import * as path from 'path'
import { readProjectBrief } from './projectBrief'
import type { MemoryInfo } from '../shared/types'

const MAX_PROJECT_MEMORY_CHARS = 100 * 1024

export async function loadMemory(workDir: string, userDataDir: string): Promise<MemoryInfo> {
  let projectMemoryPath: string | null = null
  let projectMemoryContent = ''
  let dir = path.resolve(workDir)
  for (;;) {
    const candidate = path.join(dir, 'AGENTS.md')
    try {
      projectMemoryContent = (await fs.readFile(candidate, 'utf-8')).slice(0, MAX_PROJECT_MEMORY_CHARS)
      projectMemoryPath = candidate
      break
    } catch {
      /* 向上继续查找 */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const userMemoryPath = path.join(userDataDir, 'memory.md')
  let userMemoryContent = ''
  try {
    userMemoryContent = await fs.readFile(userMemoryPath, 'utf-8')
  } catch {
    userMemoryContent = ''
  }
  return { userMemoryPath, userMemoryContent, projectMemoryPath, projectMemoryContent, brief: await readProjectBrief(workDir) }
}
