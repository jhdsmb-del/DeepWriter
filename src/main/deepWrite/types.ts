// ==================== R4.3 Gate 5 角色一致性监护（deepWrite 实验版）共享类型 ====================
// 纯 Node 类型模块（不 import electron）：角色卡 / 场景 brief / 监护者建议 / 场景包 /
// 连续性发现 / 模型调用接口。实验版定位：监护者只输出结构化建议，主笔是唯一正文作者
// （CHAR-SINGLE-WRITER），模型通信以接口注入（测试用 mock）。

/** 角色卡：静态设定 + 知识边界（该角色知道/绝不该知道的事实） */
export interface CharacterCard {
  id: string
  name: string
  /** 静态设定（voice fingerprint、禁忌、背景） */
  bible: string
  knownFacts: string[]      // 该角色当前知道的事实
  forbiddenKnowledge: string[] // 该角色绝不该知道的事实
}

/** 场景 brief：一次写作任务的场景级输入 */
export interface SceneBrief {
  sceneId: string
  beats: string[]
  presentCharacterIds: string[]
  publicFacts: string[]     // 场景内公开事实
  goal: string
}

/** 监护者结构化建议（实验版：只建议，不产出正文） */
export interface CharacterAdvice {
  characterId: string
  sceneId: string
  intent: string
  voiceConstraints: string[]
  knownFacts: string[]
  forbiddenKnowledge: string[]
  likelyActions: string[]
  oocRisks: Array<{ code: 'ooc' | 'knowledge_leak' | 'voice_drift' | 'motivation_gap'; evidence: string }>
  dialogueNotes: string[]
  confidence: number        // 0-1
}

/** 导演仲裁后的场景包：给主笔的完整写作输入 */
export interface ScenePacket {
  sceneId: string
  goal: string
  conflict: string
  beats: string[]
  /** 合并后的角色建议（导演仲裁结果） */
  characterGuidance: Array<{ characterId: string; summary: string }>
  writerInstructions: string[]
  decisions: Array<{ id: string; priority: string; resolved: string; reason: string }>  // 冲突决策记录
}

/** 连续性仲裁发现（确定性规则，无模型调用） */
export interface ContinuityFinding {
  code: 'ooc' | 'knowledge_leak' | 'voice_drift' | 'motivation_gap' | 'timeline'
  characterId: string | null
  span: string | null
  evidence: string
  severity: 'hard' | 'soft'
}

/** 模型调用接口（注入；生产实现走 deepseek.ts，测试用 mock）。
 *  R4.6 Gate 2：返回结构化结果（text + 真实 usage；无 usage 时缺省由调用方近似），
 *  支持 AbortSignal（取消时收敛在途调用）。 */
export interface CharacterModelCallResult {
  text: string
  usage?: { inputTokens: number; outputTokens: number }
}

export interface CharacterModelCall {
  (prompt: string, signal?: AbortSignal): Promise<CharacterModelCallResult>
}
