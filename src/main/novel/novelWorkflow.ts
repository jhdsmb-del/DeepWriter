import { longGenerate } from '../deepseek'
import { createDraftStore } from './draftStore'
import type { DraftStore, DraftManifest } from './draftStore'
import { createBible, autoPlanScenes, applySceneCommit, addScene, getContinuityContext } from './storyState'
import type { StoryBible, SceneCard } from './storyState'
import { checkContinuity, buildScenePrompt } from './continuity'
import type { ContinuityIssue } from './continuity'
import { estimateTokens } from '../../shared/types'
import type { CreativeApi, CreativeStage } from '../creativeModel'

export type NovelApi = CreativeApi

export interface SceneProgress {
  projectId: string
  sceneId: string
  stage: 'drafting' | 'checking' | 'revising' | 'committed' | 'failed'
  chars: number
  issues: ContinuityIssue[]
  rounds: number
  usageTokens: number
  error?: string
}

export interface NovelWorkflow {
  startProject(input: { title: string; targetChars: number; notes?: string; scenes?: { title: string; chars?: string[]; wordTarget: number }[] }): Promise<{ projectId: string; sceneCount: number }>
  generateScene(projectId: string, sceneId: string, userPrompt: string, onProgress?: (p: SceneProgress) => void): Promise<SceneProgress>
  reviseScene(projectId: string, sceneId: string, issues: ContinuityIssue[], userPrompt: string): Promise<SceneProgress>
  projectStatus(projectId: string): Promise<{ title: string; scenes: { sceneId: string; sceneNo: number; title: string; status: string; version: number; charCount: number; issues: string[] }[]; totalChars: number } | null>
  stopAll(): void
}

/** 每个场景独立 AbortController（修复 aborts 按 projectId 覆盖问题） */
const aborts = new Map<string, AbortController>()

const abortKey = (projectId: string, sceneId: string): string => `${projectId}:${sceneId}`

export function createNovelWorkflow(opts: { baseDir: string; getApi: (stage?: CreativeStage) => NovelApi | Promise<NovelApi> }): NovelWorkflow {
  const drafts: DraftStore = createDraftStore(opts.baseDir)

  const saveManifest = async (bible: StoryBible): Promise<void> => {
    const manifest: DraftManifest = {
      projectId: bible.projectId,
      title: bible.title,
      scenes: bible.scenes.map((s) => ({
        sceneId: s.id,
        sceneNo: s.sceneNo,
        title: s.title,
        status: s.status,
        version: s.version,
        charCount: 0,
        draftPath: null,
        issues: []
      })),
      updatedAt: Date.now()
    }
    await drafts.saveManifest(manifest)
  }

  const runScene = async (projectId: string, sceneId: string, userPrompt: string, reviseIssues: ContinuityIssue[] | null, onProgress?: (p: SceneProgress) => void): Promise<SceneProgress> => {
    const bible = await drafts.loadBible(projectId)
    if (!bible) throw new Error('项目不存在')
    const scene = bible.scenes.find((s) => s.id === sceneId)
    if (!scene) throw new Error('场景不存在')
    const key = abortKey(projectId, sceneId)
    const abort = new AbortController()
    aborts.set(key, abort)
    let text = ''
    let rounds = 0
    let usageTokens = 0
    try {
      const api = await opts.getApi(reviseIssues ? 'polish' : 'draft')
      const context = getContinuityContext(bible, scene)
      const prompt = buildScenePrompt(bible, scene, context, userPrompt)
      const system = reviseIssues && reviseIssues.length > 0 ? `${prompt.system}\n\n上一稿存在以下问题，请针对性修正（只重写相关部分，保持其余内容）：\n${reviseIssues.map((i) => `- [${i.type}] ${i.message}`).join('\n')}` : prompt.system
      const result = await longGenerate({
        params: { apiKey: api.apiKey, baseUrl: api.baseUrl, model: api.model, thinking: api.thinking ?? { enabled: false, effort: 'high' }, maxTokens: api.maxTokens, temperature: api.temperature ?? 0.9, topP: api.topP, provider: api.provider },
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt.user }],
        maxRounds: Math.max(2, Math.ceil(scene.wordTarget / 4000)),
        signal: abort.signal,
        onEvent: (ev) => {
          if (ev.type === 'text') text += ev.delta ?? ''
        },
        onContentReplace: (content) => { text = content },
        onRound: (n) => {
          rounds = n
          // 不再在每轮追加写盘（修复 T1/T1T2/T1T2 重复累积）；只更新进度
          onProgress?.({ projectId, sceneId, stage: 'drafting', chars: [...text].length, issues: [], rounds: n, usageTokens })
        }
      })
      usageTokens = result.totalUsage.total_tokens
      // 结束只写一次当前草稿（覆盖写）
      await drafts.writeDraft(projectId, sceneId, text)
      const check = checkContinuity({ bible, scene, sceneText: text, requiredFacts: scene.facts, forbiddenFacts: [] })
      onProgress?.({ projectId, sceneId, stage: 'checking', chars: [...text].length, issues: check.issues, rounds, usageTokens })
      if (check.ok) {
        scene.status = 'committed'
        applySceneCommit(bible, scene, text) // 内部 version += 1（修复版本双增：外部不再自增）
        await drafts.saveBible(bible)
        await drafts.commitVersion(projectId, sceneId)
        await saveManifest(bible)
        onProgress?.({ projectId, sceneId, stage: 'committed', chars: [...text].length, issues: [], rounds, usageTokens })
        return { projectId, sceneId, stage: 'committed', chars: [...text].length, issues: [], rounds, usageTokens }
      }
      onProgress?.({ projectId, sceneId, stage: 'revising', chars: [...text].length, issues: check.issues, rounds, usageTokens })
      return { projectId, sceneId, stage: 'revising', chars: [...text].length, issues: check.issues, rounds, usageTokens }
    } catch (e) {
      const err = e as Error
      const failed: SceneProgress = { projectId, sceneId, stage: 'failed', chars: [...text].length, issues: [], rounds, usageTokens, error: err.name === 'AbortError' ? '已停止' : err.message }
      onProgress?.(failed)
      return failed
    } finally {
      aborts.delete(key)
    }
  }

  return {
    async startProject(input) {
      const projectId = `nov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      let bible: StoryBible
      if (input.scenes && input.scenes.length > 0) {
        // 修复：自定义场景用 addScene 推入 bible.scenes（不再对未入册的 SceneCard 调 applySceneCommit）
        bible = createBible(projectId, input.title)
        for (const s of input.scenes) {
          addScene(bible, { title: s.title, chars: s.chars, wordTarget: s.wordTarget })
        }
      } else {
        bible = autoPlanScenes(projectId, input.title, input.targetChars, input.notes ?? '')
      }
      await drafts.saveBible(bible)
      await saveManifest(bible)
      return { projectId, sceneCount: bible.scenes.length }
    },
    async generateScene(projectId, sceneId, userPrompt, onProgress) {
      return runScene(projectId, sceneId, userPrompt, null, onProgress)
    },
    async reviseScene(projectId, sceneId, issues, userPrompt) {
      return runScene(projectId, sceneId, userPrompt, issues, undefined)
    },
    async projectStatus(projectId) {
      const bible = await drafts.loadBible(projectId)
      if (!bible) return null
      let totalChars = 0
      const scenes = []
      for (const s of bible.scenes) {
        const t = s.status === 'committed' ? await drafts.readDraft(projectId, s.id) : ''
        const charCount = [...t].length
        totalChars += charCount
        scenes.push({ sceneId: s.id, sceneNo: s.sceneNo, title: s.title, status: s.status, version: s.version, charCount, issues: [] as string[] })
      }
      return { title: bible.title, scenes, totalChars }
    },
    stopAll() {
      for (const a of aborts.values()) a.abort()
      aborts.clear()
    }
  }
}

export function estimateSceneTokens(text: string): number {
  return estimateTokens(text)
}
