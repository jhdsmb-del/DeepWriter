// ==================== R4.3 Gate 5：Character Custodian 实验版（桶导出） ====================
// 架构固定：Director（拆解/仲裁）+ Character Custodian（只出结构化建议）+ DraftWriter（唯一正文作者）
// + ContinuityEditor（写后检查）+ CompletionController（Gate 4，决定完成）。
// 实验版（不默认开启）：监护者绝不直接写正文；token governor 控制开销；冲突按优先级合并。
// 模型通信以接口注入（主进程 streamChat 封装见 index.ts 的 deepwrite:experiment）。

export type { CharacterCard, SceneBrief, CharacterAdvice, ScenePacket, ContinuityFinding, CharacterModelCall, CharacterModelCallResult } from './types'
export { buildCustodianPrompt, parseCharacterAdvice, runCustodian } from './characterCustodian'
export { directScene, CONFLICT_PRIORITIES } from './director'
export { checkCharacterKnowledge, checkVoice } from './continuityArbiter'
export { decideGovernor } from './tokenGovernor'
export { runExperimentalScene, runCustodianPhase, type DeepWriteDeps, type DeepWriteResult, type CharacterCustodianRun, type CustodianPhaseResult, type SceneCommitResult } from './orchestrator'
export { scoreCharacterImportance, routeActiveCharacters } from './sceneRouter'
export { createCharacterStateStore, type CharacterStateStore, type SceneCharacterState, type SceneCommitRecord } from './stateStore'
