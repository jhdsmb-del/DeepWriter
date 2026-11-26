// ==================== R4.6 Gate 2：多人物深度写作主链行为测试（红灯先行） ====================
// 验收（任务书 §5）：
//  CHAR-MULTI-01       三名在场角色触发三个独立 custodian（correlationId 各异），唯一 DraftWriter 只调用一次
//  CHAR-LIMIT-01       五名角色、并发上限 2，实际同时在途调用永不超过 2
//  CHAR-CANCEL-01      监护进行时取消：所有请求收敛、取消后不入账、无状态提交
//  CHAR-CRASH-02       正文生成后、状态提交前强杀 → 恢复后同 commitId 只提交一次（幂等）
//  CHAR-KNOWLEDGE-02   角色 A 不得使用只属于角色 B 的私有事实（arbiter 校验）
//  CHAR-DEGRADE-01     一个监护失败 → 主笔可降级继续，结果标记 degraded + perCharacterResults 含错误
//  CHAR-BUDGET-01      预算不足时只选高相关角色；usage ledger 与 governor 决策一致

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `r46g2-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite'],
      logLevel: 'silent',
      plugins: [
        {
          name: 'electron-shim',
          setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
            build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
            build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
              contents: [
                'export const app = { getPath: (n) => String(n), isPackaged: false };',
                'export const dialog = { showMessageBox: async () => ({ response: 1 }) };',
                'export const ipcMain = { handle: () => undefined, on: () => undefined };',
                'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => null, decryptString: () => "" };',
                'export const shell = { openExternal: () => undefined, openPath: async () => "" };',
                'export const clipboard = { writeText: () => undefined };',
                'export const Menu = { buildFromTemplate: (t) => ({ popup: () => undefined, template: t }) };'
              ].join('\n'),
              loader: 'js'
            }))
          }
        }
      ]
    })
    const mod = await import(url.pathToFileURL(outfile).href)
    return mod as Record<string, unknown>
  } finally {
    try {
      await fs.promises.unlink(outfile)
    } catch {
      /* 清理失败忽略 */
    }
  }
}

const mkCard = (id: string, name: string, forbidden: string[] = []): Record<string, unknown> => ({
  id, name, bible: `${name}的设定`, knownFacts: [`${name}知道的事`], forbiddenKnowledge: forbidden
})

const mkAdvice = (characterId: string): string =>
  JSON.stringify({ characterId, sceneId: 'sc1', intent: '推进', voiceConstraints: [], knownFacts: [], forbiddenKnowledge: [], likelyActions: [], oocRisks: [], dialogueNotes: [], confidence: 0.8 })

interface SceneRun {
  runExperimentalScene(input: Record<string, unknown>): Promise<Record<string, unknown>>
  runCustodianPhase(input: Record<string, unknown>): Promise<Record<string, unknown>>
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r46-g2-'))
  console.log('\n[R4.6-G2] 多人物深度写作主链（Scene Router + 并发上限 + 取消 + 幂等提交）')

  const dwMod = await loadTsModule('src/main/deepWrite/orchestrator.ts')
  const dw = dwMod as unknown as SceneRun
  const stateMod = await loadTsModule('src/main/deepWrite/stateStore.ts')
  const createStateStore = stateMod.createCharacterStateStore as (dir: string) => {
    saveSceneCommit(projectId: string, sceneId: string, commitId: string, states: unknown[]): Promise<boolean>
    hasSceneCommit(projectId: string, sceneId: string, commitId: string): Promise<boolean>
    saveSceneState(projectId: string, state: Record<string, unknown>): Promise<void>
    getSceneState(projectId: string, sceneId: string, characterId: string): Promise<Record<string, unknown> | null>
  }
  const routerMod = await loadTsModule('src/main/deepWrite/sceneRouter.ts')
  const routeActiveCharacters = routerMod.routeActiveCharacters as (input: Record<string, unknown>) => { active: unknown[]; skipped: unknown[]; scores: Array<{ characterId: string; importance: number }> }

  const BRIEF = {
    sceneId: 'sc1',
    beats: ['对峙', '揭示', '和解'],
    presentCharacterIds: ['c1', 'c2', 'c3'],
    publicFacts: ['夜雨'],
    goal: '决定是否离开'
  }
  const CARDS = [mkCard('c1', '林晚', ['主角是卧底']), mkCard('c2', '顾川', ['林晚的真实身份']), mkCard('c3', '苏晴')]
  const CFG = { maxConcurrent: 3, subagentTokenRatio: 0.35, writerBudgetTokens: 32000, adviceTokenCap: 1200, directorTokenCap: 1200 }

  // ---- CHAR-MULTI-01：三角色 → 三个独立 custodian + 唯一 DraftWriter 一次 ----
  {
    const correlationIds = new Set<string>()
    let writerCalls = 0
    const res = await dw.runExperimentalScene({
      cards: CARDS,
      brief: BRIEF,
      recentSpans: [],
      governor: CFG,
      projectedSubagentTokens: 100,
      writerInstructions: ['唯一主笔'],
      deps: {
        call: async (prompt: string) => {
          // prompt 里含角色名——用名字反推是哪个角色（mock 简单识别）
          const ch = CARDS.find((c) => String(prompt).includes(String(c.name))) ?? CARDS[0]
          return { text: mkAdvice(String(ch.id)) }
        },
        writerCall: async () => {
          writerCalls++
          return '正文：林晚转身。'
        },
        renderDraft: (p: { characterGuidance: unknown[]; sceneId: string }) => `渲染：${p.sceneId}`
      }
    })
    const runs = (res.perCharacterResults as Array<{ characterId: string; correlationId: string; ok: boolean }>) ?? []
    for (const r of runs) correlationIds.add(r.correlationId)
    check('CHAR-MULTI-01 三个在场角色触发三个独立 custodian（correlationId 各异）', runs.length === 3 && correlationIds.size === 3, JSON.stringify(runs.map((r) => r.characterId)))
    check('CHAR-MULTI-01 唯一 DraftWriter 只调用一次（监护者绝不产正文）', writerCalls === 1, `writerCalls=${writerCalls}`)
    check('CHAR-MULTI-01 adviceCount=3 且未降级', (res.adviceCount as number) === 3 && res.degraded === false, JSON.stringify({ advice: res.adviceCount, degraded: res.degraded }))
  }

  // ---- CHAR-LIMIT-01：5 角色、并发上限 2 → 在途调用永不超过 2 ----
  {
    const cards5 = [mkCard('a1', '甲'), mkCard('a2', '乙'), mkCard('a3', '丙'), mkCard('a4', '丁'), mkCard('a5', '戊')]
    let inFlight = 0
    let maxInFlight = 0
    let callCount = 0
    await dw.runCustodianPhase({
      cards: cards5,
      brief: { sceneId: 'sc2', beats: ['x'], presentCharacterIds: ['a1', 'a2', 'a3', 'a4', 'a5'], publicFacts: [], goal: 'g' },
      recentSpans: [],
      governor: CFG,
      projectedSubagentTokens: 100,
      writerInstructions: [],
      maxConcurrent: 2,
      activeCharacterLimit: 5,
      deps: {
        call: async (prompt: string) => {
          callCount++
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((r) => setTimeout(r, 40))
          inFlight--
          const ch = cards5.find((c) => String(prompt).includes(String(c.name)))
          return { text: mkAdvice(String(ch?.id ?? 'x')) }
        },
        writerCall: async () => '',
        renderDraft: () => 'd'
      }
    })
    check('CHAR-LIMIT-01 5 角色全部被监护（callCount=5）', callCount === 5, `calls=${callCount}`)
    check('CHAR-LIMIT-01 并发上限 2 真实作用于在途 Promise（maxInFlight ≤ 2）', maxInFlight <= 2, `maxInFlight=${maxInFlight}`)
    check('CHAR-LIMIT-01 并发利用率达到上限（maxInFlight=2，非串行）', maxInFlight === 2, `maxInFlight=${maxInFlight}`)
  }

  // ---- CHAR-CANCEL-01：监护进行中取消 → 收敛、不入账、无提交 ----
  {
    const controller = new AbortController()
    let started = 0
    let settled = 0
    let usageSeen = 0
    const commitDir = await fsp.mkdtemp(path.join(tmp, 'cancel-'))
    const store = createStateStore(commitDir)
    const resP = dw.runExperimentalScene({
      cards: [mkCard('b1', '甲'), mkCard('b2', '乙'), mkCard('b3', '丙')],
      brief: { sceneId: 'sc3', beats: ['x'], presentCharacterIds: ['b1', 'b2', 'b3'], publicFacts: [], goal: 'g' },
      recentSpans: [],
      governor: CFG,
      projectedSubagentTokens: 100,
      writerInstructions: [],
      maxConcurrent: 3,
      signal: controller.signal,
      deps: {
        call: async (_p: string, sig?: AbortSignal) => {
          started++
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              settled++
              resolve()
            }, 500)
            sig?.addEventListener('abort', () => {
              settled++
              clearTimeout(t)
              resolve()
            })
          })
          if (sig?.aborted) throw new Error('aborted')
          usageSeen++
          return { text: mkAdvice('b1'), usage: { inputTokens: 10, outputTokens: 5 } }
        },
        writerCall: async () => 'draft',
        renderDraft: () => 'd'
      },
      commit: { projectId: 'p', sceneId: 'sc3', commitId: 'commit-cancel', store: store as never }
    })
    await new Promise((r) => setTimeout(r, 120)) // 等前两个在途
    controller.abort()
    const res = await resP
    await new Promise((r) => setTimeout(r, 600)) // 等在途全部 settle
    check('CHAR-CANCEL-01 取消后所有监护请求收敛（started=settled，无悬挂）', started === settled && started > 0, `started=${started} settled=${settled}`)
    check('CHAR-CANCEL-01 取消后 usage 不入账（usageSeen=0）', usageSeen === 0, `usageSeen=${usageSeen}`)
    check('CHAR-CANCEL-01 取消后无状态提交（hasSceneCommit=false）', (await store.hasSceneCommit('p', 'sc3', 'commit-cancel')) === false, '')
    check('CHAR-CANCEL-01 取消后无正文产出（draft=null）', res.draft === null, JSON.stringify(res.draft))
    await fsp.rm(commitDir, { recursive: true, force: true }).catch(() => undefined)
  }

  // ---- CHAR-CRASH-02：正文生成后、状态提交前强杀 → 恢复后同 commitId 只提交一次 ----
  {
    const commitDir = await fsp.mkdtemp(path.join(tmp, 'crash2-'))
    const store = createStateStore(commitDir)
    const commitId = 'commit-scene-42'
    // 第一次运行：正文产出（writerCall 成功）→ 提交（模拟：提交在 runExperimentalScene 内）
    const res1 = await dw.runExperimentalScene({
      cards: [mkCard('d1', '甲')],
      brief: { sceneId: 'sc4', beats: ['x'], presentCharacterIds: ['d1'], publicFacts: [], goal: 'g' },
      recentSpans: [],
      governor: CFG,
      projectedSubagentTokens: 100,
      writerInstructions: [],
      deps: {
        call: async () => ({ text: mkAdvice('d1') }),
        writerCall: async () => '正文产出',
        renderDraft: () => 'd'
      },
      commit: { projectId: 'p', sceneId: 'sc4', commitId, store: store as never }
    })
    check('CHAR-CRASH-02 首次提交成功（alreadyCommitted=false）', res1.sceneCommit !== null && res1.sceneCommit.alreadyCommitted === false && res1.sceneCommit.stateCount === 1, JSON.stringify(res1.sceneCommit))
    check('CHAR-CRASH-02 提交含正文后角色状态（可读回 commitId）', await store.hasSceneCommit('p', 'sc4', commitId), '')
    // "强杀后恢复"：同一 commitId 再次提交（模拟恢复路径重放）→ 幂等不重复
    const res2 = await dw.runExperimentalScene({
      cards: [mkCard('d1', '甲')],
      brief: { sceneId: 'sc4', beats: ['x'], presentCharacterIds: ['d1'], publicFacts: [], goal: 'g' },
      recentSpans: [],
      governor: CFG,
      projectedSubagentTokens: 100,
      writerInstructions: [],
      deps: {
        call: async () => ({ text: mkAdvice('d1') }),
        writerCall: async () => '正文产出（重放）',
        renderDraft: () => 'd'
      },
      commit: { projectId: 'p', sceneId: 'sc4', commitId, store: store as never }
    })
    check('CHAR-CRASH-02 恢复重放同 commitId → 幂等（alreadyCommitted=true，不重复提交）', res2.sceneCommit !== null && res2.sceneCommit.alreadyCommitted === true, JSON.stringify(res2.sceneCommit))
    await fsp.rm(commitDir, { recursive: true, force: true }).catch(() => undefined)
  }

  // ---- CHAR-KNOWLEDGE-02：角色 A 不得使用只属于角色 B 的私有事实（arbiter 校验） ----
  {
    const arbMod = await loadTsModule('src/main/deepWrite/continuityArbiter.ts')
    const checkCharacterKnowledge = arbMod.checkCharacterKnowledge as (card: Record<string, unknown>, draft: string) => Array<{ code: string; severity: string; characterId: string | null; evidence: string }>
    const cardA = mkCard('e1', '林晚', ['主角是卧底'])
    const leak = checkCharacterKnowledge(cardA, '林晚低声说：其实我知道，主角是卧底。')
    check('CHAR-KNOWLEDGE-02 角色 A 使用禁知事实 → knowledge_leak hard 检出', leak.some((f) => f.code === 'knowledge_leak' && f.severity === 'hard'), JSON.stringify(leak))
    const clean = checkCharacterKnowledge(cardA, '林晚望着雨幕。')
    check('CHAR-KNOWLEDGE-02 未使用禁知 → 无 finding', clean.length === 0, '')
    // 角色 B 的私有事实（A 的禁知）来自不同卡：B 自己可以用
    const cardB = mkCard('e2', '主角', ['林晚的身份'])
    const bOwn = checkCharacterKnowledge(cardB, '主角握紧了那份卧底名单。')
    check('CHAR-KNOWLEDGE-02 角色 B 使用自己的事实 → 无 knowledge_leak', bOwn.length === 0, JSON.stringify(bOwn))
  }

  // ---- CHAR-DEGRADE-01：一个监护失败 → 降级继续 + degraded + perCharacterResults 含错误 ----
  {
    const res = await dw.runExperimentalScene({
      cards: [mkCard('f1', '甲'), mkCard('f2', '乙'), mkCard('f3', '丙')],
      brief: { sceneId: 'sc5', beats: ['x'], presentCharacterIds: ['f1', 'f2', 'f3'], publicFacts: [], goal: 'g' },
      recentSpans: [],
      governor: CFG,
      projectedSubagentTokens: 100,
      writerInstructions: [],
      deps: {
        call: async (prompt: string) => {
          if (String(prompt).includes('乙')) throw new Error('custodian 超时')
          const ch = CARDS.find((c) => String(prompt).includes(String(c.name)))
          return { text: mkAdvice(String(ch?.id ?? 'f1')) }
        },
        writerCall: async () => '主笔兜底正文',
        renderDraft: () => 'd'
      }
    })
    const runs = (res.perCharacterResults as Array<{ characterId: string; ok: boolean; error: string | null }>) ?? []
    check('CHAR-DEGRADE-01 监护失败被记录（perCharacterResults 含 error）', runs.some((r) => r.characterId === 'f2' && !r.ok && r.error !== null), JSON.stringify(runs))
    check('CHAR-DEGRADE-01 降级后主笔仍产出正文', res.draft === '主笔兜底正文', JSON.stringify(res.draft))
    check('CHAR-DEGRADE-01 结果标记 degraded=true（UI/证据不得显示完全成功）', res.degraded === true, `degraded=${res.degraded}`)
  }

  // ---- CHAR-BUDGET-01：预算不足 → 只选高相关角色；governor 决策一致 ----
  {
    // 高 importance 角色（在场 + beats 提及）与低 importance 角色
    const high = mkCard('h1', '核心人物')
    const low1 = mkCard('l1', '路人甲')
    const low2 = mkCard('l2', '路人乙')
    const routed = routeActiveCharacters({
      cards: [low1, high, low2],
      brief: { sceneId: 'sc6', beats: ['核心人物出场'], presentCharacterIds: ['h1', 'l1', 'l2'], publicFacts: [], goal: 'g' },
      maxActive: 1
    })
    check('CHAR-BUDGET-01 预算上限 1 → 只选高相关角色（核心人物）', (routed.active as Array<{ id: string }>).length === 1 && (routed.active[0] as { id: string }).id === 'h1' && (routed.skipped as Array<{ id: string }>).length === 2, JSON.stringify(routed.active.map((c) => (c as { id: string }).id)))
    check('CHAR-BUDGET-01 importance 评分确定性（在场 > beats 提及 > 路人）', routed.scores.find((s) => s.characterId === 'h1')!.importance > routed.scores.find((s) => s.characterId === 'l1')!.importance, JSON.stringify(routed.scores))
    // usage ledger 一致性：governor 截断后实际监护调用数 = active 数（CHAR-LIMIT-01 已证并发；这里证调用集合）
    let called: string[] = []
    await dw.runCustodianPhase({
      cards: [low1, high, low2],
      brief: { sceneId: 'sc6', beats: ['核心人物出场'], presentCharacterIds: ['h1', 'l1', 'l2'], publicFacts: [], goal: 'g' },
      recentSpans: [],
      governor: CFG,
      projectedSubagentTokens: 100,
      writerInstructions: [],
      maxConcurrent: 1,
      activeCharacterLimit: 1,
      deps: {
        call: async (prompt: string) => {
          const ch = [low1, high, low2].find((c) => String(prompt).includes(String(c.name)))
          if (ch) called.push(String(ch.id))
          return { text: mkAdvice(String(ch?.id ?? 'x')) }
        },
        writerCall: async () => '',
        renderDraft: () => 'd'
      }
    })
    check('CHAR-BUDGET-01 实际监护调用集合与 governor 决策一致（只调核心人物）', called.length === 1 && called[0] === 'h1', JSON.stringify(called))
  }

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n===== R4.6-G2 行为测试：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('R4.6-G2 运行异常（红灯阶段预期：目标接口尚未实现）:', e instanceof Error ? e.message : String(e))
  process.exitCode = 2
})
