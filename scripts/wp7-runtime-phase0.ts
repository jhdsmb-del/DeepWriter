import { createHash } from 'node:crypto'
import {
  createWp7Runtime,
  freezeWp7FeatureFlags,
  hashWp7FeatureFlags,
  parseWp7FeatureFlags,
  readWp7FeatureFlagsFromSnapshot,
  runWp7Critic,
  runWp7Director,
  runWp7LocalRevision,
  runWp7Reorientation
} from '../src/main/narrative/wp7Runtime'
import { buildExecutionSnapshot } from '../src/main/executionSnapshot'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function span(text: string, startUtf16: number, endUtf16: number) {
  return {
    startUtf16,
    endUtf16,
    startCodePoint: Array.from(text.slice(0, startUtf16)).length,
    endCodePoint: Array.from(text.slice(0, endUtf16)).length,
    text: text.slice(startUtf16, endUtf16),
    textHash: sha256(text.slice(startUtf16, endUtf16))
  }
}

const directorInput = {
  contractId: 'phase0-contract',
  sceneId: 'phase0-scene',
  sceneFunction: 'decision' as const,
  entrySituation: '林舟站在门前。',
  dramaticQuestion: '林舟是否开门？',
  desires: { pov: '保护同伴', opposition: '拖延' },
  escalation: { pressure: '暴雨逼近' },
  choice: { actor: '林舟', action: '开门', irreversible: true },
  cost: { payer: '林舟', immediate: '暴露位置' },
  turn: { from: '犹豫', to: '行动' },
  valueShift: { from: '恐惧', to: '决心' },
  revelationAndInterpretation: '门后没有退路。',
  hardConstraints: [],
  softIntent: []
}

const enabledFlags = {
  sceneContractV2: true,
  deterministicDirector: true,
  dramaticCritic: true,
  localizedRevision: true,
  reorientation: true
}

function baseSnapshotSettings(): Record<string, unknown> {
  return {
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    maxTokens: 8192,
    temperature: 1,
    topP: 1,
    thinkingEnabled: true,
    reasoningEffort: 'high',
    workDir: 'C:/deepwriter/work',
    docDir: 'C:/deepwriter/docs',
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 12000,
    wp7FeatureFlags: enabledFlags
  }
}

function baseSnapshotPayload() {
  return {
    id: 'phase0-run',
    sessionId: 'phase0-session',
    phase: 'execute' as const,
    text: '写一幕场景',
    mode: 'agent' as const,
    longMode: false,
    targetChars: 0,
    story: null
  }
}

function mutationThrows(value: Record<string, unknown>, key: string, next: unknown): boolean {
  try {
    value[key] = next
    return false
  } catch {
    return true
  }
}

function main(): void {
  const off = parseWp7FeatureFlags(undefined)
  check('default-off flags 全 false', Object.values(off).every((value) => value === false))
  check('malformed flags 严格解析为 false', Object.values(parseWp7FeatureFlags({ sceneContractV2: 'true', dramaticCritic: 1 } as never)).every((value) => value === false))
  const canonicalInputs: unknown[] = [undefined, null, false, 0, 'flags', { sceneContractV2: true }]
  const canonicalResults = canonicalInputs.map((value) => parseWp7FeatureFlags(value))
  check('所有 flags 输入路径返回 canonical frozen 对象', canonicalResults.every((value) => Object.isFrozen(value) && Object.values(value).every((item) => typeof item === 'boolean')))
  check('每次 flags 解析返回新对象', canonicalResults.every((value, index) => canonicalResults.slice(index + 1).every((other) => value !== other)))
  check('严格模式 mutation 不能改写 flags', canonicalResults.every((value) => mutationThrows(value as unknown as Record<string, unknown>, 'sceneContractV2', true)))
  const frozenFlags = freezeWp7FeatureFlags(enabledFlags)
  check('freeze/read 结果及内部 flags 都不可改写', Object.isFrozen(frozenFlags) && Object.isFrozen(frozenFlags.wp7FeatureFlags) && mutationThrows(frozenFlags as unknown as Record<string, unknown>, 'wp7FeatureFlagsHash', 'tampered') && mutationThrows(frozenFlags.wp7FeatureFlags as unknown as Record<string, unknown>, 'dramaticCritic', false))

  const candidate = '😀林舟重复站在门前。'
  const disabledDirector = runWp7Director(directorInput)
  check('default-off director 不参与且不产出契约', disabledDirector === null)
  const enabledDirector = runWp7Director(directorInput, enabledFlags)
  check('显式 director flags 才产出契约', enabledDirector !== null && enabledDirector.frozenHash.length === 64)
  const disabledCritic = runWp7Critic({ candidate, contract: enabledDirector! })
  check('default-off critic 不产出诊断', disabledCritic.issues.length === 0 && disabledCritic.revisionTargets.length === 0)

  const original = 'abcdef'
  const revisionSpan = span(original, 1, 3)
  const revision = { revisionId: 'phase0-rev', span: revisionSpan, replacement: 'XY', sourceHash: sha256(original) }
  const disabledRevision = runWp7LocalRevision({ originalText: original, revisions: [revision], allowedRevisionSpans: [span(original, 0, original.length)], expectedSourceHash: sha256(original) })
  check('default-off local revision 字节不变', disabledRevision.ok && disabledRevision.text === original && !disabledRevision.changed)
  const disabledReorientation = runWp7Reorientation({ completedSceneCount: 3, chapterObjective: '继续前进' })
  check('default-off reorientation 不产出未来意图', !disabledReorientation.due && disabledReorientation.futureIntent === null)

  const reorderedFlags = {
    reorientation: true,
    localizedRevision: true,
    dramaticCritic: true,
    deterministicDirector: true,
    sceneContractV2: true
  }
  check('flags hash 与输入键顺序无关', hashWp7FeatureFlags(enabledFlags) === hashWp7FeatureFlags(reorderedFlags))
  check('flags hash 对语义值稳定', hashWp7FeatureFlags(enabledFlags) === hashWp7FeatureFlags(parseWp7FeatureFlags(enabledFlags)))
  check('不同 flags 产生不同 hash', hashWp7FeatureFlags(enabledFlags) !== hashWp7FeatureFlags(off))

  const oldSnapshot = readWp7FeatureFlagsFromSnapshot({ snapshotVersion: 4, model: 'legacy' })
  check('旧 snapshot 缺字段严格全 false', Object.values(oldSnapshot).every((value) => value === false))
  const mutableSettings = baseSnapshotSettings()
  const snapshot = buildExecutionSnapshot({
    payload: baseSnapshotPayload(),
    settings: mutableSettings as never,
    sessionId: 'phase0-session',
    memory: { projectPath: '', projectContent: '', userContent: '' },
    now: 1700000000000
  })
  const frozenHash = snapshot.wp7FeatureFlagsHash
  mutableSettings.wp7FeatureFlags = off
  check('execution snapshot 冻结 flags，不随当前 settings 漂移', JSON.stringify(snapshot.wp7FeatureFlags) === JSON.stringify(enabledFlags) && snapshot.wp7FeatureFlagsHash === frozenHash)
  check('恢复只读快照 flags，不用当前 settings 补值', JSON.stringify(readWp7FeatureFlagsFromSnapshot(snapshot)) === JSON.stringify(enabledFlags))
  check('snapshot 保存 flags hash', typeof snapshot.wp7FeatureFlagsHash === 'string' && snapshot.wp7FeatureFlagsHash === hashWp7FeatureFlags(snapshot.wp7FeatureFlags))

  const coreCalls = { director: 0, critic: 0, localRevision: 0, reorientation: 0, forbidden: [] as string[] }
  const injectedCore = new Proxy({
    director: () => { coreCalls.director += 1; return enabledDirector! },
    critic: () => { coreCalls.critic += 1; return disabledCritic },
    localRevision: () => { coreCalls.localRevision += 1; return disabledRevision },
    reorientation: () => { coreCalls.reorientation += 1; return disabledReorientation }
  }, {
    get(target, property, receiver) {
      if (!(property in target)) {
        coreCalls.forbidden.push(String(property))
        throw new Error(`forbidden capability: ${String(property)}`)
      }
      return Reflect.get(target, property, receiver)
    }
  })
  const injectedRuntime = createWp7Runtime({ core: injectedCore })
  check('runtime capability boundary 只暴露纯能力', Object.keys(injectedRuntime).every((key) => !/provider|db|commit/iu.test(key)))
  injectedRuntime.runDirector(directorInput)
  injectedRuntime.runCritic({ candidate, contract: enabledDirector! })
  injectedRuntime.runLocalRevision({ originalText: original, revisions: [revision], allowedRevisionSpans: [span(original, 0, original.length)], expectedSourceHash: sha256(original) })
  injectedRuntime.runReorientation({ completedSceneCount: 3, chapterObjective: '继续前进' })
  check('default-off 不调用注入 core/forbidden capabilities', coreCalls.director === 0 && coreCalls.critic === 0 && coreCalls.localRevision === 0 && coreCalls.reorientation === 0 && coreCalls.forbidden.length === 0)
  injectedRuntime.runDirector(directorInput, enabledFlags)
  injectedRuntime.runCritic({ candidate, contract: enabledDirector! }, enabledFlags)
  injectedRuntime.runLocalRevision({ originalText: original, revisions: [revision], allowedRevisionSpans: [span(original, 0, original.length)], expectedSourceHash: sha256(original) }, enabledFlags)
  injectedRuntime.runReorientation({ completedSceneCount: 3, chapterObjective: '继续前进' }, enabledFlags)
  check('显式开启只调用对应纯 core 能力', coreCalls.director === 1 && coreCalls.critic === 1 && coreCalls.localRevision === 1 && coreCalls.reorientation === 1 && coreCalls.forbidden.length === 0)
  check('运行时 capability proxy 未观察到 provider/DB/commit 调用', coreCalls.forbidden.length === 0)

  console.log(`\nWP7 runtime phase0: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

try {
  main()
} catch (error) {
  console.error('WP7 runtime phase0 执行异常：', error)
  process.exitCode = 2
}
