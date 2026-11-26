import { promises as fs } from 'fs'
import * as path from 'path'
import type { StoryBible } from './storyState'

export interface DraftManifest {
  projectId: string
  title: string
  scenes: {
    sceneId: string
    sceneNo: number
    title: string
    status: string
    version: number
    charCount: number
    draftPath: string | null
    issues: string[]
  }[]
  updatedAt: number
}

export interface DraftStore {
  saveBible(bible: StoryBible): Promise<void>
  loadBible(projectId: string): Promise<StoryBible | null>
  /** 保存当前草稿（覆盖写：draft 文件 = 最新一次 run 的完整草稿） */
  writeDraft(projectId: string, sceneId: string, text: string): Promise<void>
  /** 提交草稿到 final（原子写：临时文件 + rename 覆盖；失败抛错不吞） */
  commitVersion(projectId: string, sceneId: string): Promise<string>
  readDraft(projectId: string, sceneId: string): Promise<string>
  getManifest(projectId: string): Promise<DraftManifest | null>
  saveManifest(manifest: DraftManifest): Promise<void>
  resumeState(projectId: string): Promise<{ bible: StoryBible | null; manifest: DraftManifest | null }>
}

const safeId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id)

export function createDraftStore(baseDir: string): DraftStore {
  const root = (projectId: string): string => {
    if (!safeId(projectId)) throw new Error('非法 projectId')
    return path.join(baseDir, 'novels', projectId)
  }

  const manifestPath = (projectId: string): string => path.join(root(projectId), 'manifest.json')

  const buildManifest = (bible: StoryBible, withDrafts: { charCount: number; draftPath: string | null; issues: string[] }[]): DraftManifest => ({
    projectId: bible.projectId,
    title: bible.title,
    scenes: bible.scenes.map((s, i) => ({
      sceneId: s.id,
      sceneNo: s.sceneNo,
      title: s.title,
      status: s.status,
      version: s.version,
      charCount: withDrafts[i]?.charCount ?? 0,
      draftPath: withDrafts[i]?.draftPath ?? null,
      issues: withDrafts[i]?.issues ?? []
    })),
    updatedAt: Date.now()
  })

  return {
    async saveBible(bible) {
      const dir = root(bible.projectId)
      await fs.mkdir(dir, { recursive: true })
      // 原子写 bible.json（临时文件 + rename）
      const target = path.join(dir, 'bible.json')
      const tmp = `${target}.tmp-${Date.now().toString(36)}`
      await fs.writeFile(tmp, JSON.stringify(bible, null, 2), 'utf-8')
      await fs.rename(tmp, target)
    },
    async loadBible(projectId) {
      try {
        return JSON.parse(await fs.readFile(path.join(root(projectId), 'bible.json'), 'utf-8'))
      } catch {
        return null
      }
    },
    async writeDraft(projectId, sceneId, text) {
      const dir = path.join(root(projectId), 'drafts')
      await fs.mkdir(dir, { recursive: true })
      // 覆盖写（不再是 appendFile：修重复累积）；原子写防半截
      const target = path.join(dir, `${sceneId}.md`)
      const tmp = `${target}.tmp-${Date.now().toString(36)}`
      await fs.writeFile(tmp, text, 'utf-8')
      await fs.rename(tmp, target)
    },
    async commitVersion(projectId, sceneId) {
      const dir = root(projectId)
      const draftPath = path.join(dir, 'drafts', `${sceneId}.md`)
      const finalDir = path.join(dir, 'final')
      await fs.mkdir(finalDir, { recursive: true })
      const finalPath = path.join(finalDir, `${sceneId}.md`)
      try {
        const draft = await fs.readFile(draftPath, 'utf-8')
        // 原子写 final（临时文件 + rename 覆盖，Windows 安全）
        const tmp = `${finalPath}.tmp-${Date.now().toString(36)}`
        await fs.writeFile(tmp, draft, 'utf-8')
        await fs.rename(tmp, finalPath)
        // 提交后删除草稿（final 即最新版本）
        await fs.unlink(draftPath).catch(() => undefined)
      } catch (e) {
        throw new Error(`提交版本失败（${(e as Error).message}）`)
      }
      return finalPath
    },
    async readDraft(projectId, sceneId) {
      try {
        return await fs.readFile(path.join(root(projectId), 'drafts', `${sceneId}.md`), 'utf-8')
      } catch {
        try {
          return await fs.readFile(path.join(root(projectId), 'final', `${sceneId}.md`), 'utf-8')
        } catch {
          return ''
        }
      }
    },
    async getManifest(projectId) {
      try {
        return JSON.parse(await fs.readFile(manifestPath(projectId), 'utf-8'))
      } catch {
        return null
      }
    },
    async saveManifest(manifest) {
      const dir = root(manifest.projectId)
      await fs.mkdir(dir, { recursive: true })
      const target = manifestPath(manifest.projectId)
      const tmp = `${target}.tmp-${Date.now().toString(36)}`
      await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8')
      await fs.rename(tmp, target)
    },
    async resumeState(projectId) {
      const [bible, manifest] = await Promise.all([this.loadBible(projectId), this.getManifest(projectId)])
      return { bible, manifest }
    }
  }
}
