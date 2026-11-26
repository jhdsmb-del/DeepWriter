import { createHash } from 'node:crypto'
import type { NarrativeQualityEvaluation, NarrativeQualityFinding, SceneContract, StrongConstraintPerspective } from '../../shared/types'
import { codePointLength, takeCodePoints } from '../../shared/textMetrics'

const MAX_FINDINGS = 12
const MIN_ECHO_CODE_POINTS = 32

export interface NarrativeQualityGateInput {
  candidate: string
  acceptedPrefix: string
  sceneContract?: SceneContract | null
  perspective?: StrongConstraintPerspective
  knownCharacterIds?: string[]
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sliceCp(value: string, startCp: number, endCp: number): string {
  return Array.from(value).slice(Math.max(0, startCp), Math.max(0, endCp)).join('')
}

function cpIndex(value: string, utf16Index: number): number {
  return codePointLength(value.slice(0, Math.max(0, utf16Index)))
}

function span(value: string, needle: string, from = 0): { startCp: number; endCp: number } {
  const at = value.indexOf(needle, Math.max(0, from))
  if (at < 0) return { startCp: 0, endCp: Math.min(1, codePointLength(value)) }
  const startCp = cpIndex(value, at)
  return { startCp, endCp: startCp + codePointLength(needle) }
}

function clean(value: string, max = 240): string {
  return takeCodePoints(value.replace(/\s+/gu, ' ').trim(), max)
}

function uniqueStrings(values: string[], max = 8): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = clean(raw, 160)
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function noQuoteText(value: string): string {
  return value.replace(/[“”「」『』"'「」]/gu, ' ')
}

function sentenceParts(value: string): Array<{ text: string; startCp: number; endCp: number }> {
  const out: Array<{ text: string; startCp: number; endCp: number }> = []
  let startUtf16 = 0
  const re = /[^。！？!?\n]+[。！？!?]?/gu
  for (const match of value.matchAll(re)) {
    const raw = match[0] ?? ''
    const text = clean(raw)
    if (!text) continue
    const utf16Start = match.index ?? startUtf16
    const startCp = cpIndex(value, utf16Start)
    out.push({ text, startCp, endCp: startCp + codePointLength(raw) })
    startUtf16 = utf16Start + raw.length
  }
  return out
}

function finding(input: Omit<NarrativeQualityFinding, 'startCp' | 'endCp'> & Partial<Pick<NarrativeQualityFinding, 'startCp' | 'endCp'>>, candidate: string, needle = ''): NarrativeQualityFinding {
  const resolved = needle ? span(candidate, needle) : { startCp: input.startCp ?? 0, endCp: input.endCp ?? Math.min(1, codePointLength(candidate)) }
  return {
    ...input,
    startCp: Math.max(0, resolved.startCp),
    endCp: Math.max(resolved.startCp + 1, resolved.endCp)
  }
}

function repeatedSentences(candidate: string): NarrativeQualityFinding[] {
  const parts = sentenceParts(candidate)
  const seen = new Map<string, { text: string; startCp: number; endCp: number }>()
  const findings: NarrativeQualityFinding[] = []
  for (const part of parts) {
    const key = part.text.replace(/[“”「」『』\s]/gu, '').toLocaleLowerCase()
    if (codePointLength(key) < 12) continue
    const previous = seen.get(key)
    if (previous) {
      findings.push(finding({
        code: 'repetition',
        severity: 'advisory',
        message: '候选段重复了相同句子或回声式表达',
        evidence: [previous.text, part.text],
        startCp: part.startCp,
        endCp: part.endCp
      }, candidate))
      if (findings.length >= 2) break
    } else seen.set(key, part)
  }
  return findings
}

function prefixEcho(candidate: string, acceptedPrefix: string): NarrativeQualityFinding | null {
  const prefix = Array.from(acceptedPrefix)
  const current = Array.from(candidate)
  if (prefix.length < MIN_ECHO_CODE_POINTS || current.length < MIN_ECHO_CODE_POINTS) return null
  const max = Math.min(160, prefix.length, current.length)
  for (let length = max; length >= MIN_ECHO_CODE_POINTS; length--) {
    const suffix = prefix.slice(prefix.length - length).join('')
    const head = current.slice(0, length).join('')
    if (suffix === head) {
      return finding({
        code: 'repetition',
        severity: 'advisory',
        message: `候选开头复述了已接受正文末尾 ${length} 字，可能形成回声`,
        evidence: [takeCodePoints(suffix, 160)]
      }, candidate, head)
    }
  }
  return null
}

function characterFindings(candidate: string, contract: SceneContract | null | undefined, knownCharacterIds: string[]): NarrativeQualityFinding[] {
  if (!contract) return []
  const known = uniqueStrings([...knownCharacterIds, ...contract.characterIds, ...contract.activeCharacterIds], 32)
  const active = new Set(uniqueStrings([...contract.characterIds, ...contract.activeCharacterIds], 32))
  const inactive = known.filter((name) => !active.has(name) && candidate.includes(name))
  if (inactive.length === 0) return []
  const name = inactive[0] ?? ''
  return [finding({
    code: 'character_conflict',
    severity: 'advisory',
    message: '候选段提及了当前 SceneContract 未激活的角色，需人工确认是否为有意出场',
    evidence: inactive.slice(0, 4)
  }, candidate, name)]
}

function perspectiveFindings(candidate: string, perspective: StrongConstraintPerspective | undefined, contract: SceneContract | null | undefined): NarrativeQualityFinding[] {
  const narration = noQuoteText(candidate)
  // Chinese narration normally attaches a pronoun directly to its verb
  // ("我走进"/"他抬头"), so a trailing-boundary assertion would miss the
  // very signal this gate is meant to catch.  A leading punctuation boundary
  // keeps the check local without attempting full syntactic parsing.
  const first = /(?:^|[\s，。！？!?；：:])(?:我|我们|咱们)/u.test(narration)
  const third = /(?:^|[\s，。！？!?；：:])(?:他|她|它|他们|她们)/u.test(narration)
  const conflict = perspective === 'first' ? third : perspective === 'third' ? first : first && third
  if (!conflict) return []
  // Pronoun co-occurrence is deliberately advisory.  First-person prose can
  // describe other people, and third-person dialogue can naturally contain
  // "我"; without a structural narration-boundary signal, withdrawing the
  // candidate would create brittle, repetitive prose.  The existing strong
  // constraint/critic path remains authoritative for an explicit POV rule.
  const cue = perspective === 'first' ? '他' : perspective === 'third' ? '我' : first ? '我' : '他'
  return [finding({
    code: 'pov_conflict',
    severity: 'advisory',
    message: perspective
      ? `候选段出现${perspective === 'first' ? '第一' : '第三'}人称视角线索与另一代词；仅作 advisory，不据此撤回`
      : '候选旁白同时出现第一、第三人称线索，可能发生视角漂移；仅作 advisory',
    evidence: [contract?.povCharacterId ? `视角角色：${contract.povCharacterId}` : '视角未绑定', cue]
  }, candidate, cue)]
}

function continuityFindings(candidate: string, contract: SceneContract | null | undefined): NarrativeQualityFinding[] {
  if (!contract) return []
  const out: NarrativeQualityFinding[] = []
  for (const forbidden of contract.mustNotHappen) {
    if (!forbidden || !candidate.includes(forbidden)) continue
    out.push(finding({
      code: 'continuity_conflict',
      severity: 'blocking',
      message: '候选段直接触发了 SceneContract 的显式禁止项',
      evidence: [forbidden]
    }, candidate, forbidden))
    if (out.length >= 4) break
  }
  return out
}

function metaFinding(candidate: string): NarrativeQualityFinding[] {
  const match = candidate.match(/(?:以下(?:是|为)?(?:正文|小说|内容)|我将(?:为你)?(?:撰写|创作|继续)|接下来我(?:会|将)|本段(?:将|会)|字数\s*[：:])/iu)
  if (!match?.[0]) return []
  return [finding({
    code: 'meta_language',
    severity: 'advisory',
    message: '候选段残留说明腔或生成过程元话语，交由现有文字审校定向处理',
    evidence: [match[0]]
  }, candidate, match[0])]
}

export function evaluateNarrativeQualityGate(input: NarrativeQualityGateInput): NarrativeQualityEvaluation {
  const candidate = String(input.candidate ?? '')
  const acceptedPrefix = String(input.acceptedPrefix ?? '')
  const contract = input.sceneContract ?? null
  const echo = prefixEcho(candidate, acceptedPrefix)
  const findings = [
    ...continuityFindings(candidate, contract),
    ...perspectiveFindings(candidate, input.perspective, contract),
    ...repeatedSentences(candidate),
    ...(echo ? [echo] : []),
    ...characterFindings(candidate, contract, input.knownCharacterIds ?? []),
    ...metaFinding(candidate)
  ].slice(0, MAX_FINDINGS)
  const status = findings.some((item) => item.severity === 'blocking') ? 'blocked' : findings.length > 0 ? 'advisory' : 'passed'
  return {
    schemaVersion: 1,
    candidateHash: hashText(candidate),
    acceptedPrefixHash: hashText(acceptedPrefix),
    sceneContractHash: contract?.frozenHash ?? '',
    candidateChars: codePointLength(candidate),
    acceptedPrefixChars: codePointLength(acceptedPrefix),
    status,
    findings
  }
}

export function narrativeQualityEvidenceMatches(input: {
  evaluation: NarrativeQualityEvaluation | null | undefined
  candidate: string
  acceptedPrefix: string
  sceneContract?: SceneContract | null
  perspective?: StrongConstraintPerspective
  knownCharacterIds?: string[]
}): boolean {
  const { evaluation } = input
  if (!evaluation || evaluation.schemaVersion !== 1) return false
  const recomputed = evaluateNarrativeQualityGate({
    candidate: input.candidate,
    acceptedPrefix: input.acceptedPrefix,
    sceneContract: input.sceneContract,
    perspective: input.perspective,
    knownCharacterIds: input.knownCharacterIds
  })
  return evaluation.candidateHash === hashText(input.candidate) &&
    evaluation.acceptedPrefixHash === hashText(input.acceptedPrefix) &&
    evaluation.sceneContractHash === (input.sceneContract?.frozenHash ?? '') &&
    evaluation.candidateChars === codePointLength(input.candidate) &&
    evaluation.acceptedPrefixChars === codePointLength(input.acceptedPrefix) &&
    evaluation.status === recomputed.status &&
    JSON.stringify(evaluation.findings) === JSON.stringify(recomputed.findings) &&
    evaluation.status !== 'blocked'
}

export function buildNarrativeQualityPrompt(evaluation: NarrativeQualityEvaluation): string {
  const findings = evaluation.findings.map((item) => `- [${item.severity}] ${item.code}: ${item.message}（${item.evidence.join('；')}）`).join('\n') || '- 无确定性局部问题'
  return [
    '## NarrativeQualityGate 局部诊断（只供当前候选的文字审校）',
    `candidate hash：${evaluation.candidateHash}`,
    `accepted prefix hash：${evaluation.acceptedPrefixHash}`,
    `SceneContract hash：${evaluation.sceneContractHash || '无'}`,
    `诊断状态：${evaluation.status}`,
    findings,
    '重复、角色异常和说明腔只是 advisory；如需修订，只能沿用现有 critic/editor 的定点区间，不得重写已接受正文。'
  ].join('\n')
}

export function buildNarrativeQualityRepairInstruction(evaluation: NarrativeQualityEvaluation): string {
  const blocking = evaluation.findings.filter((item) => item.severity === 'blocking')
  return [
    '[NarrativeQualityGate 定向修复]',
    `当前候选已撤回（candidate hash：${evaluation.candidateHash}），不属于 accepted 正文。`,
    `accepted prefix hash：${evaluation.acceptedPrefixHash}；SceneContract hash：${evaluation.sceneContractHash || '无'}。`,
    ...blocking.map((item) => `- ${item.message}：${item.evidence.join('；')}`),
    '保持 accepted prefix 原样不变，只重写刚才的候选段；只输出自然小说正文，不解释修复过程，不输出 JSON。'
  ].join('\n')
}
