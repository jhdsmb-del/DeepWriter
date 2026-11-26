import { buildExecutionSnapshot } from '../src/main/executionSnapshot'
import { CompletionController } from '../src/main/completion/CompletionController'
import { decideContinuation } from '../src/main/completion/ContinuationPolicy'
import type { CompletionEvaluation, CompletionStore } from '../src/main/completion/types'
import type { Settings } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
}

const settings: Settings = {
  apiKey: 'test-key',
  userPresetPrompt: '',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com',
  thinkingEnabled: false,
  reasoningEffort: 'high',
  temperature: 1,
  topP: 1,
  maxTokens: 2048,
  toolsEnabled: true,
  docDir: 'C:/docs',
  historyBudgetTokens: 64000,
  workDir: 'C:/work',
  planMode: false,
  permissionMode: 'safe',
  novelMode: false,
  galgame: { enabled: false, projectDir: '', sdkPath: '' },
  completionTokenBudget: 200000,
  completionWallClockMs: 0,
  strongConstraintEnabled: false
}

function snapshot(targetChars: number, completionTokenBudget = settings.completionTokenBudget): ReturnType<typeof buildExecutionSnapshot> {
  return buildExecutionSnapshot({
    payload: { id: `r54-long-${targetChars}-${completionTokenBudget}`, mode: 'longwrite', longMode: true, targetChars, phase: 'execute', text: '写作任务' },
    settings: { ...settings, completionTokenBudget },
    sessionId: 'r54-long-session',
    memory: { projectPath: '', projectContent: '', userContent: '' },
    now: 1700000000000
  })
}

const large = snapshot(8000)
const largeBudget = large.completionContract?.tokenBudget
check('R54-LONG-01 默认/历史 200k 长文预算转为自动连续（无 token 硬停）', largeBudget === undefined, String(largeBudget))
check('R54-LONG-01 扩容不取消轮数安全上限', typeof large.maxTurns === 'number' && large.maxTurns > 0 && large.maxTurns <= 128, String(large.maxTurns))

const explicitSmall = snapshot(30000, 999)
check('R54-LONG-02 显式小 token 预算仍冻结为用户值', explicitSmall.completionContract?.tokenBudget === 999, String(explicitSmall.completionContract?.tokenBudget))
const unlimited = snapshot(30000, 0)
check('R54-LONG-02 显式 0 预算保持无限', unlimited.completionContract?.tokenBudget === undefined, String(unlimited.completionContract?.tokenBudget))

const evaluations: CompletionEvaluation[] = []
const store: CompletionStore = {
  saveEvaluation: (_runId, evaluation) => evaluations.push(evaluation),
  getLatestEvaluation: () => evaluations[evaluations.length - 1] ?? null
}
const controller = new CompletionController({ contract: { ...large.completionContract!, runId: 'r54-long-controller' }, store })
controller.setAccumulatedCost(200001)
const candidate = controller.submitCandidate({ measuredChars: 100, artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
const continuation = controller.requestContinuation({ repetitionRatio: 0 })
check('R54-LONG-03 8k 长文累计 usage 超旧 200k 仍自动 continuation', candidate.state === 'validating' && continuation.state === 'continuing', JSON.stringify(continuation))

const pauseBase = {
  measuredChars: 100,
  lastDeltaChars: 0,
  findingSetChanged: false,
  lowProgressRounds: 2,
  repetitionRatio: 0,
  effectiveDeltaChars: 0,
  usageTokens: 1,
  repairAttempts: 1,
  maxRepairAttempts: 10,
  pendingToolCount: 0,
  cancelled: false
} as const
check('R54-LONG-04 真实停滞仍 pause_user', decideContinuation(pauseBase).decision === 'pause_user', JSON.stringify(decideContinuation(pauseBase)))
check('R54-LONG-04 高重复仍 pause_user', decideContinuation({ ...pauseBase, lastDeltaChars: 300, effectiveDeltaChars: 300, repetitionRatio: 0.9, lowProgressRounds: 0 }).decision === 'pause_user', '')

console.log(`R54 longform continuation: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
