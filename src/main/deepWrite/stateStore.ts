// ==================== R4.3 Gate 5 补：角色状态 durable 原子存储（CHAR-CRASH-01） ====================
// 任务书：场景 commit 后原子更新 character_states——commit 前强杀不得留下半份 state。
// 实现：每场景一个 JSON 文件（<baseDir>/<projectId>/<sceneId>.json），原子写（同目录 tmp + rename）；
// rename 是 POSIX 原子操作，Windows 上 fs.rename 覆盖已存在文件也保证要么旧要么新（无半份）。

import { promises as fsp } from 'fs'
import * as path from 'path'

export interface SceneCharacterState {
  sceneId: string
  characterId: string
  stateVersion: number
  /** 该角色在本场景结束时的知识/关系/目标增量（事件式） */
  knowledge: string[]
  relationships: Record<string, string>
  status: string
  updatedAt: number
  /** R4.6 Gate 2：来源场景提交 ID（幂等提交/审计） */
  commitId?: string
}

/** 场景级提交记录（一整场的角色状态集，原子写；恢复幂等依据） */
export interface SceneCommitRecord {
  commitId: string
  sceneId: string
  states: SceneCharacterState[]
  committedAt: number
}

export interface CharacterStateStore {
  /** 原子保存场景角色状态（tmp + rename；写中失败旧文件完好） */
  saveSceneState(projectId: string, state: SceneCharacterState): Promise<void>
  getSceneState(projectId: string, sceneId: string, characterId: string): Promise<SceneCharacterState | null>
  listSceneStates(projectId: string, sceneId: string): Promise<SceneCharacterState[]>
  /** R4.6 Gate 2：场景级原子提交（幂等）——同一 commitId 已存在返回 false（恢复不重复提交） */
  saveSceneCommit(projectId: string, sceneId: string, commitId: string, states: SceneCharacterState[]): Promise<boolean>
  hasSceneCommit(projectId: string, sceneId: string, commitId: string): Promise<boolean>
}

export function createCharacterStateStore(baseDir: string): CharacterStateStore {
  const filePath = (projectId: string, sceneId: string, characterId: string): string =>
    path.join(baseDir, sanitize(projectId), sanitize(sceneId), `${sanitize(characterId)}.json`)
  const commitPath = (projectId: string, sceneId: string, commitId: string): string =>
    path.join(baseDir, sanitize(projectId), sanitize(sceneId), `.scene-commit-${sanitize(commitId)}.json`)
  return {
    async saveSceneState(projectId, state) {
      const target = filePath(projectId, state.sceneId, state.characterId)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      const tmp = `${target}.tmp-${Date.now().toString(36)}`
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
      // 原子替换：旧文件要么保持完整，要么被完整新文件替换——绝无半份
      await fsp.rename(tmp, target)
    },
    async saveSceneCommit(projectId, sceneId, commitId, states) {
      const target = commitPath(projectId, sceneId, commitId)
      try {
        await fsp.access(target)
        return false // 已提交（幂等：恢复不重复提交同一场景状态）
      } catch {
        /* 不存在 → 执行提交 */
      }
      await fsp.mkdir(path.dirname(target), { recursive: true })
      const record: SceneCommitRecord = { commitId, sceneId, states, committedAt: Date.now() }
      const tmp = `${target}.tmp-${Date.now().toString(36)}`
      await fsp.writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8')
      await fsp.rename(tmp, target)
      return true
    },
    async hasSceneCommit(projectId, sceneId, commitId) {
      try {
        await fsp.access(commitPath(projectId, sceneId, commitId))
        return true
      } catch {
        return false
      }
    },
    async getSceneState(projectId, sceneId, characterId) {
      try {
        const raw = await fsp.readFile(filePath(projectId, sceneId, characterId), 'utf-8')
        return JSON.parse(raw) as SceneCharacterState
      } catch {
        return null
      }
    },
    async listSceneStates(projectId, sceneId) {
      const dir = path.join(baseDir, sanitize(projectId), sanitize(sceneId))
      const out: SceneCharacterState[] = []
      try {
        const entries = await fsp.readdir(dir)
        for (const e of entries) {
          if (!e.endsWith('.json') || e.includes('.tmp-')) continue
          try {
            out.push(JSON.parse(await fsp.readFile(path.join(dir, e), 'utf-8')) as SceneCharacterState)
          } catch {
            /* 损坏文件跳过（不把半份当有效状态） */
          }
        }
      } catch {
        /* 无目录 */
      }
      return out
    }
  }
}

/** 路径安全化（state 字段可能来自模型输出，杜绝路径注入） */
function sanitize(s: string): string {
  const out = s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return out || '_'
}
