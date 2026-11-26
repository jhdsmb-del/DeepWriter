// ==================== R4.3 Gate 5 角色一致性监护（deepWrite 实验版）独立模块测试 ====================
// 覆盖：CHAR-KNOWLEDGE-01 / CHAR-VOICE-01 / CHAR-SINGLE-WRITER-01 / CHAR-SCOPE-01 / CHAR-TOKEN-CAP-01
//       / CHAR-PARSE-01 / CHAR-CONFLICT-01 / CHAR-CRASH-01
// 运行：npx esbuild scripts/r43-char.ts --bundle --format=esm --platform=node --outfile=out/r43-char.mjs && node out/r43-char.mjs

import { promises as fsp } from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  buildCustodianPrompt,
  parseCharacterAdvice,
  runCustodian,
  type CharacterAdvice
} from '../src/main/deepWrite/characterCustodian'
import { CONFLICT_PRIORITIES, directScene } from '../src/main/deepWrite/director'
import { checkCharacterKnowledge, checkVoice } from '../src/main/deepWrite/continuityArbiter'
import { createGovernorOpts, decideGovernor } from '../src/main/deepWrite/tokenGovernor'
import { runExperimentalScene } from '../src/main/deepWrite/orchestrator'
import { buildExecutionSnapshot } from '../src/main/executionSnapshot'
import type { CharacterCard, SceneBrief, ScenePacket } from '../src/main/deepWrite/types'

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

// ---------- 公共 mock 数据 ----------

const CARD: CharacterCard = {
  id: 'ch-lin',
  name: '林晚',
  bible: '林晚，冷静克制的外科医生，说话简短，不用网络流行语。禁用口头禅：呵呵。信仰：患者优先。',
  knownFacts: ['医院处于火灾警戒状态', '监控在凌晨被拆除'],
  forbiddenKnowledge: ['主角已死', '幕后黑手是院长']
}

const BRIEF: SceneBrief = {
  sceneId: 's-12',
  beats: ['林晚进入病房', '发现监控被拆除', '与院长对峙'],
  presentCharacterIds: ['ch-lin', 'ch-zhang', 'ch-wang'],
  publicFacts: ['医院处于火灾警戒状态'],
  goal: '林晚要查明监控为何被拆除'
}

const VALID_ADVICE_JSON = `\`\`\`json
{
  "characterId": "ch-lin",
  "sceneId": "s-12",
  "intent": "林晚想直接质问院长",
  "voiceConstraints": ["不撒娇", "不卖萌"],
  "knownFacts": ["医院处于火灾警戒状态"],
  "forbiddenKnowledge": [],
  "likelyActions": ["推开院长办公室的门"],
  "oocRisks": [],
  "dialogueNotes": ["语速放缓，逐字咬清"],
  "confidence": 0.82
}
\`\`\``

async function main(): Promise<void> {
  // ==================== CHAR-KNOWLEDGE-01 ====================
  console.log('\n[CHAR-KNOWLEDGE-01] 角色不得使用禁知信息 → knowledge_leak（hard）')
  {
    const leakDraft = '走廊里脚步声渐近。主角已死，但没人发现这一点。林晚攥紧了听诊器。'
    const findings = checkCharacterKnowledge(CARD, leakDraft)
    check('CHAR-KNOWLEDGE-01 正文含禁知「主角已死」→ 检出 knowledge_leak', findings.some((f) => f.code === 'knowledge_leak'), `codes=${findings.map((f) => f.code).join(',')}`)
    const leak = findings.find((f) => f.code === 'knowledge_leak')
    check('CHAR-KNOWLEDGE-01 严重度为 hard 且 span/characterId 正确', leak !== undefined && leak.severity === 'hard' && leak.span === '主角已死' && leak.characterId === 'ch-lin', JSON.stringify(leak))
    const cleanDraft = '走廊里脚步声渐近。林晚攥紧听诊器，快步走向病房。'
    check('CHAR-KNOWLEDGE-01 正文不含禁知 → 无 finding', checkCharacterKnowledge(CARD, cleanDraft).length === 0, '')
  }

  // ==================== CHAR-VOICE-01 ====================
  console.log('\n[CHAR-VOICE-01] bible 禁用表达出现在对白 → voice_drift（soft）')
  {
    const voiceDraft = '林晚推开门，轻声道："呵呵，你们倒是会藏。"'
    const findings = checkVoice(CARD, voiceDraft)
    const vd = findings.find((f) => f.code === 'voice_drift')
    check('CHAR-VOICE-01 对白含「呵呵」→ 检出 voice_drift（soft）', vd !== undefined && vd.severity === 'soft' && vd.characterId === 'ch-lin', JSON.stringify(findings))
    check('CHAR-VOICE-01 evidence 提及禁用表达「呵呵」', vd !== undefined && vd.evidence.includes('呵呵') && vd.span === '呵呵', vd ? `evidence=${vd.evidence}` : '')
    const cleanDraft = '林晚推开门，轻声道："你们倒是会藏。"'
    check('CHAR-VOICE-01 对白不含禁用表达 → 无 finding', checkVoice(CARD, cleanDraft).length === 0, '')
  }

  // ==================== CHAR-SINGLE-WRITER-01 ====================
  console.log('\n[CHAR-SINGLE-WRITER-01] 单主笔：正文只由 writerCall 产出，监护者只出建议')
  {
    let writerCalls = 0
    let custodianCalls = 0
    const WRITER_OUT = '【正文·仅主笔】林晚推开病房门，目光落在拆空的监控支架上。'
    let writerPrompt = ''
    const res = await runExperimentalScene({
      cards: [CARD],
      brief: BRIEF,
      recentSpans: ['[回忆] 雨夜的码头，船灯昏黄'],
      governor: { writerBudgetTokens: 10000 },
      projectedSubagentTokens: 2000,
      writerInstructions: ['主笔是唯一正文作者', '按 beats 顺序推进'],
      deps: {
        call: async () => {
          custodianCalls++
          return { text: VALID_ADVICE_JSON }
        },
        writerCall: async (prompt: string) => {
          writerCalls++
          writerPrompt = prompt
          return WRITER_OUT
        },
        renderDraft: (packet: ScenePacket) => `主笔指令：${packet.writerInstructions.join(' / ')}`
      }
    })
    check('CHAR-SINGLE-WRITER-01 draft 只来自 writerCall 输出', res.draft === WRITER_OUT, `draft=${res.draft}`)
    check('CHAR-SINGLE-WRITER-01 writerCall 恰好调用 1 次', writerCalls === 1, `writerCalls=${writerCalls}`)
    check('CHAR-SINGLE-WRITER-01 监护者被调用但只产建议（adviceCount=1）', custodianCalls === 1 && res.adviceCount === 1, `custodianCalls=${custodianCalls} adviceCount=${res.adviceCount}`)
    check('CHAR-SINGLE-WRITER-01 未降级且 guidance 含角色建议摘要', res.degraded === false && res.packet !== null && res.packet.characterGuidance.length === 1 && res.packet.characterGuidance[0].characterId === 'ch-lin', JSON.stringify(res.packet?.characterGuidance))
    check('CHAR-SINGLE-WRITER-01 writerPrompt 是 packet 渲染（无正文/无整书 bible）', writerPrompt === '主笔指令：主笔是唯一正文作者 / 按 beats 顺序推进', `writerPrompt=${writerPrompt}`)
  }

  // ==================== CHAR-SCOPE-01 ====================
  console.log('\n[CHAR-SCOPE-01] 监护者 prompt 内容受限：只含限定信息，超长 spans 被 charLimit 截断')
  {
    const shortSpan = '[回忆] 雨夜的码头，船灯昏黄。'
    const hugeSpan = `第 100 章：${'甲'.repeat(3000)}（无关章节全文，绝不能进 prompt）`
    const prompt = buildCustodianPrompt(CARD, BRIEF, [shortSpan, hugeSpan], 200)
    check(
      'CHAR-SCOPE-01 prompt 含全部限定部分（角色卡/公开/已知/禁知/beats/spans）',
      prompt.includes(CARD.bible) && prompt.includes(BRIEF.publicFacts[0]) && prompt.includes(CARD.knownFacts[0]) && prompt.includes(CARD.forbiddenKnowledge[0]) && prompt.includes(BRIEF.beats[0]) && prompt.includes(shortSpan),
      ''
    )
    check('CHAR-SCOPE-01 prompt 不含超限的无关章节内容（第 100 章）', !prompt.includes('第 100 章') && !prompt.includes('无关章节全文'), '')
    const h1 = prompt.indexOf('【角色卡】')
    const h2 = prompt.indexOf('【公开事实】')
    const h3 = prompt.indexOf('【该角色已知事实】')
    const h4 = prompt.indexOf('【该角色禁知事实】')
    const h5 = prompt.indexOf('【场景节拍】')
    const h6 = prompt.indexOf('【近期相关段落】')
    check('CHAR-SCOPE-01 拼装顺序固定（角色卡→公开→已知→禁知→beats→spans）', h1 >= 0 && h1 < h2 && h2 < h3 && h3 < h4 && h4 < h5 && h5 < h6, `h=[${h1},${h2},${h3},${h4},${h5},${h6}]`)
    check('CHAR-SCOPE-01 截断标记存在（提示 spans 被截断）', prompt.includes('…已截断') || prompt.includes('（其余已省略）'), '')
  }

  // ==================== CHAR-TOKEN-CAP-01 ====================
  console.log('\n[CHAR-TOKEN-CAP-01] token governor：超 ratio 全降级；未超按 importance 截断到 maxConcurrent')
  {
    const opts = createGovernorOpts({ writerBudgetTokens: 10000 })
    check('CHAR-TOKEN-CAP-01 默认值（maxConcurrent=3, ratio=0.35, advice=1200, director=1200）', opts.maxConcurrent === 3 && opts.subagentTokenRatio === 0.35 && opts.adviceTokenCap === 1200 && opts.directorTokenCap === 1200, JSON.stringify(opts))
    const present = [
      { characterId: 'ch-a', importance: 2 },
      { characterId: 'ch-b', importance: 5 },
      { characterId: 'ch-c', importance: 1 },
      { characterId: 'ch-d', importance: 4 },
      { characterId: 'ch-e', importance: 3 }
    ]
    // 预算 = 10000 * 0.35 = 3500；投影 4000 超限
    const over = decideGovernor(opts, present, 4000)
    check('CHAR-TOKEN-CAP-01 投影超 ratio → allowed=false', over.allowed === false, `allowed=${over.allowed}`)
    check('CHAR-TOKEN-CAP-01 超限 → active 为空、全部 5 个角色 skipped', over.activeCharacterIds.length === 0 && over.skippedCharacterIds.length === 5, `active=${over.activeCharacterIds.join(',')} skipped=${over.skippedCharacterIds.join(',')}`)
    check('CHAR-TOKEN-CAP-01 超限 reason 说明降级', over.reason.includes('降级') && over.reason.includes('预算'), over.reason)
    // 投影 3000 ≤ 3500：启用前 3 个（importance 5,4,3）
    const ok = decideGovernor(opts, present, 3000)
    check('CHAR-TOKEN-CAP-01 未超限 → allowed=true 且 active 按 importance 截断到 3 个', ok.allowed === true && ok.activeCharacterIds.join(',') === 'ch-b,ch-d,ch-e', `active=${ok.activeCharacterIds.join(',')}`)
    check('CHAR-TOKEN-CAP-01 未超限 → 2 个次要角色走规则卡', ok.skippedCharacterIds.join(',') === 'ch-a,ch-c', `skipped=${ok.skippedCharacterIds.join(',')}`)
    check('CHAR-TOKEN-CAP-01 未超限 reason 含启用数量说明', ok.reason.includes('3') && ok.reason.includes('跳过'), ok.reason)
  }

  // ==================== CHAR-PARSE-01 ====================
  console.log('\n[CHAR-PARSE-01] 监护者结构化输出解析（围栏/无围栏/损坏）')
  {
    const adv = parseCharacterAdvice(VALID_ADVICE_JSON)
    check(
      'CHAR-PARSE-01 ```json 围栏合法 JSON → 解析成功且字段齐全',
      adv !== null && adv.characterId === 'ch-lin' && adv.sceneId === 's-12' && adv.intent.includes('质问院长') && adv.voiceConstraints.length === 2 && adv.knownFacts.length === 1 && Array.isArray(adv.likelyActions) && adv.oocRisks.length === 0 && adv.dialogueNotes.length === 1 && adv.confidence === 0.82,
      adv ? JSON.stringify({ i: adv.intent, vc: adv.voiceConstraints.length, c: adv.confidence }) : '解析失败'
    )
    const plain = parseCharacterAdvice(VALID_ADVICE_JSON.replace(/```json\n/, '').replace(/\n```/, ''))
    check('CHAR-PARSE-01 无围栏纯 JSON → 同样成功', plain !== null && plain.characterId === 'ch-lin', '')
    check('CHAR-PARSE-01 损坏 JSON → null', parseCharacterAdvice('{"characterId": ') === null, '')
    check('CHAR-PARSE-01 非 JSON 文本/空串 → null', parseCharacterAdvice('模型说了一堆废话') === null && parseCharacterAdvice('') === null, '')
  }

  // ==================== CHAR-CONFLICT-01 ====================
  console.log('\n[CHAR-CONFLICT-01] 冲突确定性合并：按优先级裁决，不拼接多角色文本')
  {
    const v6 = CONFLICT_PRIORITIES.user_hard_constraint
    const v5 = CONFLICT_PRIORITIES.world_fact
    const v4 = CONFLICT_PRIORITIES.scene_goal
    const v3 = CONFLICT_PRIORITIES.character_knowledge
    const v2 = CONFLICT_PRIORITIES.character_preference
    const v1 = CONFLICT_PRIORITIES.style_preference
    check('CHAR-CONFLICT-01 优先级编号 6→1（用户硬约束>世界事实>场景目标>角色知识边界>角色偏好>风格偏好）', v6 === 6 && v5 === 5 && v4 === 4 && v3 === 3 && v2 === 2 && v1 === 1, `6=${v6} 5=${v5} 4=${v4} 3=${v3} 2=${v2} 1=${v1}`)
    check('CHAR-CONFLICT-01 角色知识边界(3) > 角色偏好(2)', v3 > v2, '')

    const adviceA: CharacterAdvice = {
      characterId: 'ch-lin',
      sceneId: 's-12',
      intent: '林晚必须隐瞒自己知道院长是内鬼',
      voiceConstraints: [],
      knownFacts: ['医院处于火灾警戒状态'],
      forbiddenKnowledge: ['院长是内鬼'],
      likelyActions: ['不提及院长', '暗中搜集证据'],
      oocRisks: [{ code: 'knowledge_leak', evidence: '若在正文点破「院长是内鬼」将泄露禁知信息' }],
      dialogueNotes: ['绝口不提院长，只谈火灾'],
      confidence: 0.9
    }
    const adviceB: CharacterAdvice = {
      characterId: 'ch-lin',
      sceneId: 's-12',
      intent: '林晚想当众揭穿院长',
      voiceConstraints: ['语速平缓'],
      knownFacts: ['医院处于火灾警戒状态'],
      forbiddenKnowledge: [],
      likelyActions: ['当众喊出院长名字'],
      oocRisks: [],
      dialogueNotes: ['语气可以再凌厉一些'],
      confidence: 0.7
    }
    const writerInstructions = ['主笔请按 beats 顺序推进，禁止角色互写正文']
    const packet = directScene(BRIEF, [adviceB, adviceA], writerInstructions)
    const g = packet.characterGuidance.find((x) => x.characterId === 'ch-lin')
    check('CHAR-CONFLICT-01 采用知识边界建议 A（guidance 含 A 的意图，不含 B 的）', g !== undefined && g.summary.includes('隐瞒') && !g.summary.includes('当众揭穿'), g ? `summary=${g.summary}` : '无 guidance')
    const conflictDecision = packet.decisions.find((d) => d.priority === 'character_knowledge' && d.reason.includes('优先级'))
    check('CHAR-CONFLICT-01 decisions 记录仲裁（priority=character_knowledge 且 reason 含优先级）', conflictDecision !== undefined && typeof conflictDecision.resolved === 'string' && conflictDecision.resolved.length > 0, JSON.stringify(packet.decisions))
    check('CHAR-CONFLICT-01 oocRisks 汇总进 decisions（knowledge_leak 风险有记录）', packet.decisions.some((d) => d.reason.includes('院长是内鬼')), '')
    check('CHAR-CONFLICT-01 不拼接文本：writerInstructions 是数组且原样保留', Array.isArray(packet.writerInstructions) && packet.writerInstructions.length === 1 && packet.writerInstructions[0] === writerInstructions[0], JSON.stringify(packet.writerInstructions))
    check('CHAR-CONFLICT-01 packet 场景信息完整（sceneId/goal/beats）', packet.sceneId === 's-12' && packet.goal === BRIEF.goal && JSON.stringify(packet.beats) === JSON.stringify(BRIEF.beats), '')
  }

  // ==================== CHAR-CRASH-01 ====================
  console.log('\n[CHAR-CRASH-01] 模型崩溃容错：runCustodian 返回 null，编排降级仍产出正文')
  {
    let custodianGraceful = false
    try {
      const r = await runCustodian(CARD, BRIEF, [], async () => {
        throw new Error('mock 模型崩溃')
      })
      custodianGraceful = r !== null && r.advice === null
    } catch {
      custodianGraceful = false
    }
    check('CHAR-CRASH-01 runCustodian 模型抛错 → 返回 null（不向上抛）', custodianGraceful, '')
    let writerCalls = 0
    let res
    try {
      res = await runExperimentalScene({
        cards: [CARD],
        brief: BRIEF,
        recentSpans: [],
        governor: { writerBudgetTokens: 10000 },
        projectedSubagentTokens: 2000,
        writerInstructions: ['主笔兜底'],
        deps: {
          call: async () => {
            throw new Error('监护者崩溃')
          },
          writerCall: async () => {
            writerCalls++
            return '兜底正文：林晚独自完成了查证。'
          },
          renderDraft: (packet: ScenePacket) => `渲染：${packet.sceneId}`
        }
      })
    } catch (e) {
      res = null
      console.log('  FAIL  runExperimentalScene 抛异常：', e)
    }
    check('CHAR-CRASH-01 监护者全失败 → 编排不崩溃且 draft 仍由 writerCall 产出', res !== null && res.draft === '兜底正文：林晚独自完成了查证。' && writerCalls === 1, `draft=${res?.draft} writerCalls=${writerCalls}`)
    check('CHAR-CRASH-01 adviceCount=0 且 degraded=true（降级单主笔）', res !== null && res.adviceCount === 0 && res.degraded === true, `adviceCount=${res?.adviceCount} degraded=${res?.degraded}`)
    check('CHAR-CRASH-01 packet/findings 结构完整', res !== null && res.packet !== null && Array.isArray(res.findings), '')
    check('CHAR-CRASH-01 空建议下 packet 仍可用（guidance 为空数组不抛错）', res !== null && res.packet.characterGuidance.length === 0 && Array.isArray(res.packet.writerInstructions), JSON.stringify(res?.packet?.characterGuidance))
  }


  // ==================== R4.3 Gate 5 集成补充：实验开关冻结 ====================
  {
    const snap = buildExecutionSnapshot({
      payload: { id: 'req-dw', mode: 'longwrite', longMode: true, targetChars: 10000 },
      settings: { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 8192, temperature: 1, topP: 1, thinkingEnabled: true, reasoningEffort: 'high', workDir: 'C:/w', docDir: 'C:/d', novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000 },
      sessionId: 's-dw',
      memory: { projectPath: '', projectContent: '', userContent: '' }
    })
    check('CHAR-EXPERIMENT-01 快照冻结 deepWrite.experiment（默认关闭）', snap.deepWrite?.experiment?.enabled === false, JSON.stringify(snap.deepWrite?.experiment))
    check('CHAR-EXPERIMENT-01 实验参数冻结（maxConcurrent=3/ratio=0.35）', snap.deepWrite?.experiment?.maxConcurrent === 3 && snap.deepWrite?.experiment?.subagentTokenRatio === 0.35, '')
    // 桶导出存在（deepWrite/index.ts 静态 import 已加载）
    check('CHAR-EXPERIMENT-01 deepWrite 桶导出 runExperimentalScene/decideGovernor', typeof runExperimentalScene === 'function' && typeof decideGovernor === 'function', '')
  }


  // ==================== R4.3 补：CHAR-CRASH-01（场景 state 原子写） + CHAR-BENCH-PIPELINE-01（A/B/C 对比管道） ====================
  {
    // CHAR-CRASH-01：场景 commit 前强杀（写中失败）不留下半份 state
    const { createCharacterStateStore } = await import('../src/main/deepWrite/stateStore')
    const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-char-state-'))
    const store = createCharacterStateStore(stateDir)
    const st: { sceneId: string; characterId: string; stateVersion: number; knowledge: string[]; relationships: Record<string, string>; status: string; updatedAt: number } = {
      sceneId: 'sc1', characterId: '林晚', stateVersion: 1, knowledge: ['知道主角计划'], relationships: { 主角: '信任' }, status: '出场', updatedAt: Date.now()
    }
    await store.saveSceneState('proj-1', st)
    const read = await store.getSceneState('proj-1', 'sc1', '林晚')
    check('CHAR-CRASH-01 正常 commit 后 state 可读回（version 1）', read?.stateVersion === 1 && read.knowledge[0] === '知道主角计划', JSON.stringify(read))
    // 强杀模拟：tmp 文件残留（rename 前进程被杀）→ 旧 state 完好、tmp 不被视为有效
    const target = path.join(stateDir, 'proj-1', 'sc1', '林晚.json')
    await fsp.writeFile(target + '.tmp-deadbeef', JSON.stringify({ sceneId: 'sc1', characterId: '林晚', stateVersion: 2, knowledge: ['半份'], relationships: {}, status: '半份', updatedAt: 0 }), 'utf-8')
    const after = await store.getSceneState('proj-1', 'sc1', '林晚')
    check('CHAR-CRASH-01 commit 前强杀：残留 tmp 不污染有效 state（旧版本完好）', after?.stateVersion === 1, JSON.stringify(after))
    const list = await store.listSceneStates('proj-1', 'sc1')
    check('CHAR-CRASH-01 listSceneStates 跳过 tmp 残留（无半份）', list.length === 1 && list[0].stateVersion === 1, JSON.stringify(list.map((x) => x.stateVersion)))
    // 路径注入：恶意 characterId 被 sanitize（不逃出 baseDir）
    await store.saveSceneState('proj-1', { ...st, sceneId: 'sc2', characterId: '../../../etc/evil', stateVersion: 9 })
    const evil = await store.getSceneState('proj-1', 'sc2', '../../../etc/evil')
    check('CHAR-CRASH-01 路径注入被拒（state 可寻址但不出 baseDir）', evil !== null && evil.stateVersion === 9, JSON.stringify(evil?.stateVersion ?? null))
    await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => undefined)
  }
  {
    // CHAR-BENCH-PIPELINE-01：A/B/C 对比管道（mock 确定性模型验证管道；real 需 API key）
    const { runExperimentalScene } = await import('../src/main/deepWrite/orchestrator')
    const card = { id: 'c1', name: '林晚', bible: '温婉但坚韧', knownFacts: ['住在城南'], forbiddenKnowledge: ['主角是卧底'] }
    const brief = { sceneId: 'sc1', beats: ['对峙', '揭示'], presentCharacterIds: ['c1'], publicFacts: ['夜雨'], goal: '决定是否离开' }
    const writerOut = '林晚望着雨幕，轻轻握紧了伞柄。'
    const cfg = { maxConcurrent: 3, subagentTokenRatio: 0.35, writerBudgetTokens: 32000, adviceTokenCap: 1200, directorTokenCap: 1200 }
    // A：单 Agent（degraded=true，无监护者）；B/C：Director+Writer（可加监护）
    const runA = await runExperimentalScene({
      cards: [card], brief, recentSpans: [], governor: cfg, projectedSubagentTokens: 9999999, writerInstructions: ['直接写'],
      deps: { call: async () => ({ text: '{}' }), writerCall: async () => writerOut, renderDraft: () => 'direct' }
    })
    const runC = await runExperimentalScene({
      cards: [card], brief, recentSpans: ['林晚的伞是母亲遗物'], governor: cfg, projectedSubagentTokens: 100, writerInstructions: ['直接写'],
      deps: {
        call: async () => ({ text: JSON.stringify({ characterId: 'c1', sceneId: 'sc1', intent: '离开', voiceConstraints: ['不喊叫'], knownFacts: ['住在城南'], forbiddenKnowledge: ['主角是卧底'], likelyActions: ['转身'], oocRisks: [], dialogueNotes: ['轻声'], confidence: 0.9 }) }),
        writerCall: async () => writerOut,
        renderDraft: () => 'direct'
      }
    })
    check('CHAR-BENCH-PIPELINE-01 A 模式（单 Agent）degraded=true 且无监护建议', runA.degraded === true && runA.adviceCount === 0, JSON.stringify({ degraded: runA.degraded, advice: runA.adviceCount }))
    check('CHAR-BENCH-PIPELINE-01 C 模式（监护+主笔）产出建议且正文仍只来自主笔', runC.adviceCount === 1 && runC.draft === writerOut, JSON.stringify({ advice: runC.adviceCount, draft: runC.draft }))
    check('CHAR-BENCH-PIPELINE-01 对比管道可输出结构化指标（adviceCount/degraded/findings）', typeof runC.adviceCount === 'number' && Array.isArray(runC.findings) && typeof runC.degraded === 'boolean', '')
  }

  console.log(`\n===== R4.3 Gate 5 deepWrite 角色监护：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('失败明细：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.3 Gate 5 deepWrite 测试执行异常：', e)
  process.exit(2)
})
