import { createHash } from 'node:crypto'
import {
  buildDramaticCritic,
  buildReorientationPlan,
  buildSceneContractV2,
  applyLocalizedRevision
} from './wp7Experimental'
import type {
  DramaticCriticReport,
  ExactTextSpan,
  LocalRevisionResult,
  ReorientationInputV2,
  ReorientationPlanV2,
  SceneContractV2,
  SceneContractV2Validation,
  SceneDirectorInputV2,
  Wp7FeatureFlags
} from '../../shared/narrativeV2'
import {
  DRAMATIC_CRITIC_SCHEMA_VERSION,
  REORIENTATION_SCHEMA_VERSION,
  resolveWp7FeatureFlags as resolveCoreWp7FeatureFlags
} from '../../shared/narrativeV2'
import type { DramaticCriticInput } from './dramaticCritic'
import type { LocalizedRevisionInput } from './localizedRevision'
import { validateSceneContractV2 as validateCoreSceneContractV2 } from './sceneContractV2'
import { contentHash, makeExactTextSpan, validateExactTextSpan } from './textSpans'

export type Wp7RuntimeFlags = Wp7FeatureFlags

export interface FrozenWp7FeatureFlags {
  wp7FeatureFlags: Wp7FeatureFlags
  wp7FeatureFlagsHash: string
}

export interface Wp7RuntimeCore {
  director: (input: SceneDirectorInputV2) => SceneContractV2
  critic: (input: DramaticCriticInput) => DramaticCriticReport
  localRevision: (input: LocalizedRevisionInput) => LocalRevisionResult
  reorientation: (input: ReorientationInputV2) => ReorientationPlanV2
}

export interface Wp7RuntimeOptions {
  core?: Partial<Wp7RuntimeCore>
}

export interface Wp7Runtime {
  parseWp7FeatureFlags(value: unknown): Wp7FeatureFlags
  hashWp7FeatureFlags(value: unknown): string
  freezeWp7FeatureFlags(value: unknown): FrozenWp7FeatureFlags
  readWp7FeatureFlagsFromSnapshot(snapshot: unknown): Wp7FeatureFlags
  runDirector(input: SceneDirectorInputV2, flags?: unknown): SceneContractV2 | null
  validateSceneContractV2(contract: unknown): SceneContractV2Validation
  makeExactTextSpanFromCodePoints(value: string, startCodePoint: number, endCodePoint: number): ExactTextSpan | null
  runCritic(input: DramaticCriticInput, flags?: unknown): DramaticCriticReport
  validateCriticReport(candidate: string, report: unknown, contractHash: string): report is DramaticCriticReport
  runLocalRevision(input: LocalizedRevisionInput, flags?: unknown): LocalRevisionResult
  runReorientation(input: ReorientationInputV2, flags?: unknown): ReorientationPlanV2
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function canonicalFlags(value: unknown): Wp7FeatureFlags {
  let parsed: Wp7FeatureFlags
  try {
    parsed = isRecord(value)
      ? resolveCoreWp7FeatureFlags(value as Partial<Wp7FeatureFlags>)
      : resolveCoreWp7FeatureFlags()
  } catch {
    parsed = resolveCoreWp7FeatureFlags()
  }
  return Object.freeze({
    sceneContractV2: parsed.sceneContractV2 === true,
    deterministicDirector: parsed.deterministicDirector === true,
    dramaticCritic: parsed.dramaticCritic === true,
    localizedRevision: parsed.localizedRevision === true,
    reorientation: parsed.reorientation === true
  })
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.keys(record).sort().reduce<Record<string, unknown>>((out, key) => {
      const current = record[key]
      if (current !== undefined) out[key] = stableValue(current)
      return out
    }, {})
  }
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function boundedCount(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function stringList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = clean(raw)
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function disabledCritic(input: DramaticCriticInput): DramaticCriticReport {
  return {
    schemaVersion: DRAMATIC_CRITIC_SCHEMA_VERSION,
    candidateHash: hashText(input.candidate),
    contractHash: input.contract.frozenHash,
    issues: [],
    mustPreserveSpans: [],
    revisionTargets: []
  }
}

function disabledReorientation(input: ReorientationInputV2): ReorientationPlanV2 {
  const completed = boundedCount(input.completedSceneCount)
  const last = boundedCount(input.lastReorientationScene)
  const sourceSceneIds = Array.isArray(input.sceneIds) ? input.sceneIds.slice(0, completed).map(clean).filter(Boolean) : []
  const sourceSceneHashes = Array.isArray(input.acceptedSceneHashes) ? input.acceptedSceneHashes.slice(0, completed).map(clean).filter(Boolean) : []
  const base = {
    schemaVersion: REORIENTATION_SCHEMA_VERSION,
    due: false,
    overdue: false,
    afterScene: completed,
    sourceSceneIds,
    sourceSceneHashes,
    futureWindow: { minScenes: 3, maxScenes: 5 },
    futureIntent: null,
    inputHash: hashText(stableJson({
      storyId: clean(input.storyId),
      chapterId: clean(input.chapterId),
      completedSceneCount: completed,
      lastReorientationScene: last,
      sceneIds: sourceSceneIds,
      acceptedSceneHashes: sourceSceneHashes,
      priorIntent: input.priorIntent ?? null,
      chapterObjective: clean(input.chapterObjective),
      agencyFocus: clean(input.agencyFocus),
      pressureToEscalate: clean(input.pressureToEscalate),
      payoffToAdvance: input.payoffToAdvance === undefined ? null : clean(input.payoffToAdvance),
      nextIrreversibleChoice: clean(input.nextIrreversibleChoice),
      avoidRepeating: stringList(input.avoidRepeating)
    }))
  }
  return { ...base, planHash: hashText(stableJson(base)) }
}

const DRAMATIC_IMPACTS = new Set(['blocking', 'major', 'minor', 'advisory'])

function exactCriticSpan(candidate: string, value: unknown): boolean {
  if (!validateExactTextSpan(candidate, value)) return false
  const span = value as { startUtf16: number; endUtf16: number }
  return span.endUtf16 > span.startUtf16
}

function validCriticReport(candidate: string, value: unknown, contractHash: string): value is DramaticCriticReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const report = value as Partial<DramaticCriticReport>
  if (report.schemaVersion !== DRAMATIC_CRITIC_SCHEMA_VERSION || report.candidateHash !== contentHash(candidate) || report.contractHash !== contractHash) return false
  if (!Array.isArray(report.issues) || !Array.isArray(report.mustPreserveSpans) || !Array.isArray(report.revisionTargets)) return false
  if (!report.mustPreserveSpans.every((span) => exactCriticSpan(candidate, span))) return false
  if (!report.revisionTargets.every((target) => {
    if (!target || typeof target !== 'object' || typeof target.targetId !== 'string' || typeof target.objective !== 'string' || !Array.isArray(target.issueCodes)) return false
    return target.issueCodes.every((code) => typeof code === 'string') && exactCriticSpan(candidate, target.allowedSpan)
  })) return false
  return report.issues.every((issue) => {
    if (!issue || typeof issue !== 'object' || typeof issue.issueId !== 'string' || typeof issue.code !== 'string' || !DRAMATIC_IMPACTS.has(issue.impact)) return false
    if (!exactCriticSpan(candidate, issue.span) || !Array.isArray(issue.mustPreserveSpans) || !issue.mustPreserveSpans.every((span) => exactCriticSpan(candidate, span))) return false
    if (!Array.isArray(issue.revisionTargets)) return false
    return issue.revisionTargets.every((target) => {
      if (!target || typeof target !== 'object' || typeof target.targetId !== 'string' || typeof target.objective !== 'string' || !Array.isArray(target.issueCodes)) return false
      return target.issueCodes.every((code) => typeof code === 'string') && exactCriticSpan(candidate, target.allowedSpan)
    })
  })
}

function exactSpanFromCodePoints(value: string, startCodePoint: number, endCodePoint: number): ExactTextSpan | null {
  if (!Number.isInteger(startCodePoint) || !Number.isInteger(endCodePoint) || startCodePoint < 0 || endCodePoint <= startCodePoint) return null
  const points = Array.from(value)
  if (endCodePoint > points.length) return null
  try {
    return makeExactTextSpan(value, points.slice(0, startCodePoint).join('').length, points.slice(0, endCodePoint).join('').length)
  } catch {
    return null
  }
}

const defaultCore: Wp7RuntimeCore = Object.freeze({
  director: buildSceneContractV2,
  critic: buildDramaticCritic,
  localRevision: applyLocalizedRevision,
  reorientation: buildReorientationPlan
})

export function createWp7Runtime(options: Wp7RuntimeOptions = {}): Wp7Runtime {
  const core: Wp7RuntimeCore = { ...defaultCore, ...(options.core ?? {}) }
  const parseFlags = (value: unknown): Wp7FeatureFlags => canonicalFlags(value)
  const hashFlags = (value: unknown): string => hashText(JSON.stringify(parseFlags(value)))
  const freezeFlags = (value: unknown): FrozenWp7FeatureFlags => {
    const wp7FeatureFlags = parseFlags(value)
    return Object.freeze({ wp7FeatureFlags, wp7FeatureFlagsHash: hashFlags(wp7FeatureFlags) })
  }
  const readFlags = (snapshot: unknown): Wp7FeatureFlags => parseFlags(isRecord(snapshot) ? snapshot.wp7FeatureFlags : undefined)
  const runtime: Wp7Runtime = {
    parseWp7FeatureFlags: parseFlags,
    hashWp7FeatureFlags: hashFlags,
    freezeWp7FeatureFlags: freezeFlags,
    readWp7FeatureFlagsFromSnapshot: readFlags,
    runDirector: (input, flags) => {
      const resolved = parseFlags(flags)
      if (!resolved.sceneContractV2 || !resolved.deterministicDirector) return null
      return core.director(input)
    },
    validateSceneContractV2: (contract) => validateCoreSceneContractV2(contract),
    makeExactTextSpanFromCodePoints: exactSpanFromCodePoints,
    runCritic: (input, flags) => {
      const resolved = parseFlags(flags)
      return resolved.dramaticCritic ? core.critic(input) : disabledCritic(input)
    },
    validateCriticReport: (candidate, report, contractHash) => validCriticReport(candidate, report, contractHash),
    runLocalRevision: (input, flags) => {
      const resolved = parseFlags(flags)
      if (!resolved.localizedRevision) return { ok: true, text: input.originalText, contentHash: hashText(input.originalText), changed: false, appliedRevisionIds: [] }
      return core.localRevision(input)
    },
    runReorientation: (input, flags) => {
      const resolved = parseFlags(flags)
      return resolved.reorientation ? core.reorientation(input) : disabledReorientation(input)
    }
  }
  return Object.freeze(runtime)
}

export const wp7Runtime = createWp7Runtime()

export const parseWp7FeatureFlags = wp7Runtime.parseWp7FeatureFlags
export const resolveWp7FeatureFlags = parseWp7FeatureFlags
export const hashWp7FeatureFlags = wp7Runtime.hashWp7FeatureFlags
export const wp7FeatureFlagsHash = hashWp7FeatureFlags
export const freezeWp7FeatureFlags = wp7Runtime.freezeWp7FeatureFlags
export const readWp7FeatureFlagsFromSnapshot = wp7Runtime.readWp7FeatureFlagsFromSnapshot
export const runWp7Director = wp7Runtime.runDirector
export const runDirector = runWp7Director
export const runDeterministicDirector = runWp7Director
export const validateWp7SceneContractV2 = wp7Runtime.validateSceneContractV2
export const validateSceneContractV2 = validateWp7SceneContractV2
export const makeWp7ExactTextSpanFromCodePoints = wp7Runtime.makeExactTextSpanFromCodePoints
export const runWp7Critic = wp7Runtime.runCritic
export const runCritic = runWp7Critic
export const runDramaticCritic = runWp7Critic
export const validateWp7CriticReport = wp7Runtime.validateCriticReport
export const runWp7LocalRevision = wp7Runtime.runLocalRevision
export const runLocalRevision = runWp7LocalRevision
export const runLocalizedRevision = runWp7LocalRevision
export const runWp7Reorientation = wp7Runtime.runReorientation
export const runReorientation = runWp7Reorientation
