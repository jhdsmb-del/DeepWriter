import { createHash } from 'node:crypto'
import { grillMeOutlineHash } from '../../shared/grillMe'
import type { GrillMeOutline, GrillMeOutlineScene, GrillMeOutlineSection } from '../../shared/grillMe'
import type {
  SceneCompletionDecision,
  SceneContract,
  SceneContractPlan,
  SceneContractStateChange,
  SceneContractTargetChars,
  SceneBeatEvidenceStatus,
  SceneBeatActuality,
  SceneBeatAssertion,
  SceneBeatEventGroup,
  SceneBeatCueSpan,
  SceneBeatEventScope,
  SceneBeatModelEvidence,
  SceneBeatSemanticEventEvidence,
  SceneBeatModality,
  SceneBeatRequirement,
  SceneBeatSemanticRoles,
  StrongConstraintSnapshot
} from '../../shared/types'
import { codePointLength, takeCodePoints } from '../../shared/textMetrics'
import { makeExactTextSpan } from './textSpans'

const SCENE_CONTRACT_SCHEMA_VERSION = 1 as const
const MAX_CONTRACTS = 128
const MAX_TEXT = 2000

export interface SceneContractPlanInput {
  outline: GrillMeOutline
  outlineHash?: string
  outlineRevision?: number
  answers?: Array<{ slotId: string; value: string; source?: string }>
  characterNames?: string[]
  strongConstraints?: Pick<StrongConstraintSnapshot, 'forbiddenTerms' | 'mustKeep'> | null
}

export interface SceneContractEvaluationViolation {
  code: 'missing_required_beat' | 'beat_contradicted' | 'beat_uncertain' | 'beat_evidence_invalid' | 'forbidden_fact' | 'target_underflow' | 'target_overflow' | 'handoff_missing'
  severity: 'blocking' | 'advisory'
  message: string
  evidence: string[]
}

export interface SceneContractEvaluation {
  schemaVersion: 1
  contractId: string
  sceneId: string
  sectionId: string
  frozenHash: string
  candidateHash: string
  candidateChars: number
  sceneChars: number | null
  completed: boolean
  status: 'passed' | 'advisory' | 'deviated'
  violations: SceneContractEvaluationViolation[]
  /** Full prefix identity used for any model-supplied semantic evidence. */
  scenePrefixHash?: string
  beatEvidence?: SceneBeatEvaluationEvidence[]
  /** A real critic receipt can authorize a bounded rewrite, never acceptance. */
  semanticReview?: { version: 1 | 2; contractHash: string; candidateHash: string; scenePrefixHash: string; unresolvedBeatIds: string[] }
}

export interface SceneBeatEvaluationEvidence {
  beatId: string
  status: SceneBeatEvidenceStatus
  source: 'deterministic' | 'model' | 'deterministic+model'
  scenePrefixHash: string
  matched: {
    actor: string[]
    action: string[]
    object: string[]
    location: string[]
    result: string[]
    time: string[]
    agent: string[]
    patient: string[]
    sourceRole: string[]
    recipient: string[]
    beneficiary: string[]
  }
  modality: SceneBeatModality
  actuality: SceneBeatActuality
  assertion: SceneBeatAssertion
  negation: boolean
  inferred: string[]
  /** Candidate-side local event envelopes used for role matching. */
  eventGroups?: SceneBeatEventGroup[]
  /** Present only for accepted model evidence; binds it to the exact
   * candidate segment that was evaluated. */
  candidateHash?: string
  spans?: SceneBeatModelEvidence['spans']
  rationale?: string
  semanticVersion?: 1 | 2
  contractHash?: string
  requiredSource?: string
  semanticEvents?: SceneBeatSemanticEventEvidence[]
  partEvidence?: SceneBeatModelEvidence['partEvidence']
}

/** Runtime extension for model packets.  The shared legacy shape intentionally
 * remains readable, but a packet is not admissible for merging unless these
 * two candidate-side bindings are present and verified below. */
type BoundSceneBeatModelEvidence = SceneBeatModelEvidence & { candidateHash?: unknown }

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function cleanText(value: unknown, max = MAX_TEXT): string {
  return takeCodePoints(String(value ?? '').replace(/\s+/gu, ' ').trim(), max)
}

function unique(items: string[], max = 32): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const value = cleanText(item, 240)
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function splitItems(value: string): string[] {
  return unique(value.split(/[\n、，,；;|/]+/u).map((item) => item.replace(/^[：:：\s\-]+|[。！？!?\s]+$/gu, '')))
}

function normalizeParticipant(value: string): string {
  return cleanText(value, 80)
    .replace(/^(?:主要)?(?:角色|人物)\s*[:：]?\s*/u, '')
    .replace(/^(?:主角|主人公)\s*(?:是|为)?\s*/u, '')
    .replace(/[（(][^）)]{0,80}[）)]/gu, '')
    .trim()
}

function participantNames(value: string): string[] {
  const direct = splitItems(value).map(normalizeParticipant).filter((item) => codePointLength(item) >= 2 && codePointLength(item) <= 24)
  if (direct.length > 1) return unique(direct, 12)
  const runs = [...value.matchAll(/[A-Za-z\u3400-\u9fff][A-Za-z0-9·\u3400-\u9fff]{1,18}/gu)].map((match) => normalizeParticipant(match[0] ?? ''))
  return unique([...direct, ...runs], 12).filter((item) => !/^(?:角色|人物|主角|主人公|女主|男主)$/u.test(item))
}

function negativeClauses(value: string): string[] {
  const clauses = [...value.matchAll(/(?:不要|不得|禁止|避免|不应|不能|不可)\s*(?:出现|发生|涉及|写(?:到)?|描述|提及)?\s*([^。！？!?；;\n]{1,100})/gu)]
    .map((match) => cleanText(match[1] ?? match[0] ?? '', 180))
  return unique(clauses, 16)
}

function answerMap(answers: SceneContractPlanInput['answers']): Map<string, string> {
  const out = new Map<string, string>()
  for (const answer of answers ?? []) {
    if (typeof answer.slotId !== 'string' || typeof answer.value !== 'string' || answer.source === 'assumption') continue
    const value = cleanText(answer.value, 4000)
    if (value && !out.has(answer.slotId)) out.set(answer.slotId, value)
  }
  return out
}

function targetFor(value: number): SceneContractTargetChars {
  const ideal = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  if (ideal === 0) return { min: 0, ideal: 0, max: 0 }
  return {
    min: Math.max(1, Math.floor(ideal * 0.85)),
    ideal,
    max: Math.max(ideal, Math.ceil(ideal * 1.15))
  }
}

function contractHashInput(contract: Omit<SceneContract, 'frozenHash'>): Omit<SceneContract, 'frozenHash'> {
  return contract
}

function freezeContract(contract: Omit<SceneContract, 'frozenHash'>): SceneContract {
  return { ...contract, frozenHash: hashValue(contractHashInput(contract)) }
}

function sceneText(section: GrillMeOutlineSection): string {
  return [section.title, section.purpose, ...section.beats].join(' ')
}

/*
 * Beat semantics
 * --------------
 *
 * A beat is authored as ordinary prose, so the compiler has to be useful
 * without pretending that Chinese is a bag of exact substrings.  The small
 * lexicon below is intentionally conservative and deterministic.  It is not
 * a general NLP model: it extracts only event signals that can be checked
 * locally, while an optional model evidence record can cover the remaining
 * genuinely ambiguous relation (and is always bound to the full prefix hash).
 */
type BeatAction = { canonical: string; forms: string[] }
type ActionMatch = { canonical: string; surface: string; index: number; beam?: string }

const BEAT_ACTIONS: BeatAction[] = [
  { canonical: 'arrive', forms: ['抵达', '到达', '赶到', '来到', '来到了', '踏入', '步入', '进入', '走进', '抵近'] },
  { canonical: 'discover', forms: ['发现', '找到', '寻到', '寻得', '找到了', '看见', '看到', '瞧见', '撞见', '抽出', '取出', '翻出', '翻到', '拆出'] },
  // “把/将” are disposal markers, not transfer predicates.  They are still
  // used by the role parser to find an explicit patient before a real
  // predicate (例如“把钥匙交给沈遥”), but must never create a handover event
  // on their own (例如“把门关上”).
  // Prefer the complete directional compound when it contains a shorter
  // predicate (转交给/移交给).  actionMatches removes nested spans below so
  // one prose predicate cannot become two event groups with different local
  // actuality readings.
  { canonical: 'handover', forms: ['交出', '交给', '交到', '递给', '递出', '递过', '转交给', '移交给', '转交', '移交'] },
  { canonical: 'give', forms: ['给予', '给与'] },
  { canonical: 'receive', forms: ['收到', '接过', '接到', '拿到'] },
  { canonical: 'lend', forms: ['借给', '借出', '借走'] },
  { canonical: 'take', forms: ['拿走', '取走', '带走'] },
  { canonical: 'steal', forms: ['偷走', '盗走', '窃取'] },
  { canonical: 'place', forms: ['放置', '放下', '放回', '摆放', '搁置', '搁在'] },
  { canonical: 'lose', forms: ['遗失', '丢失', '丢掉', '弄丢'] },
  { canonical: 'exchange', forms: ['交换', '互换', '换取'] },
  { canonical: 'decide', forms: ['决定', '作出决定', '做出决定', '定下', '敲定', '答应', '选择', '选定'] },
  { canonical: 'light', forms: ['亮起', '亮了', '点亮', '点燃', '燃起', '启动'] },
  { canonical: 'activate', forms: ['推亮'] },
  { canonical: 'return', forms: ['回来', '返回', '归来', '归还', '回到', '带回', '失而复得'] },
  { canonical: 'confirm', forms: ['确认', '证实', '确定', '认定', '证明'] },
  { canonical: 'leave', forms: ['离开', '离去', '出发', '奔赴', '撤离'] },
  { canonical: 'reveal', forms: ['揭示', '揭开', '透露', '说出', '坦白', '告知', '告诉'] },
  { canonical: 'meet', forms: ['遇到', '遇见', '会面', '重逢', '见到'] },
  { canonical: 'open', forms: ['打开', '拧开', '推开', '开了'] },
  { canonical: 'press', forms: ['压住', '压在', '按下'] },
  { canonical: 'stow', forms: ['收回', '收进'] },
  { canonical: 'inspect', forms: ['检查'] },
  { canonical: 'pickup', forms: ['拿起', '拾起', '拿回'] },
  { canonical: 'reach', forms: ['去够'] },
  { canonical: 'raise', forms: ['举起来', '举起', '举高', '举到'] },
  { canonical: 'illuminate', forms: ['照向', '照到', '照住', '照上去', '照在', '照着', '照亮'] },
  { canonical: 'flip', forms: ['翻面', '翻了个面', '翻个面', '翻了一个面', '翻一个面', '翻过来', '翻回来'] },
  { canonical: 'look', forms: ['看向', '望向'] },
  { canonical: 'close', forms: ['合上', '关合', '关上', '闭合'] },
  { canonical: 'knock', forms: ['轻敲', '敲击', '敲了', '敲'] },
  { canonical: 'ask', forms: ['询问', '问起', '问道', '问'] },
  { canonical: 'mutual_gaze', forms: ['对望', '对视'] }
]

// These ordinary physical predicates require a single local subject/object
// binding. Merely mentioning both characters and objects elsewhere is not
// evidence that this event happened; legacy directional guards stay intact.
const LOCAL_PHYSICAL_ACTIONS = new Set(['open', 'press', 'stow', 'inspect', 'pickup', 'reach', 'raise', 'illuminate', 'flip', 'look', 'place', 'activate', 'close', 'knock', 'ask', 'mutual_gaze'])
function localActionBound(action: string, source: string): boolean {
  return LOCAL_PHYSICAL_ACTIONS.has(action) || action === 'confirm' &&
    /(?:确认|证实|确定|认定|证明)[^，,。！？!?；;\n]{0,60}(?:没有|不存在|不在|未曾|并未|不是|并非)/u.test(source)
}
const LOCAL_SUBJECT_BOUNDARY = /(?:在|于|用|把|将|向|从|走近|走向|走过去|走到|走进|转身|背对|伸手|站(?:在|着)?|坐(?:在|着)?)/u
const LOCAL_ADVERB_SUFFIX = /(?:短暂|缓缓|慢慢|轻轻|立刻|已经|先|又|再|并|正|去|还|却|没有|并没有|未曾|并未|未|不|没|计划|打算|试图|想要|正要)+$/u

function namedSubjectPrefix(value: string, name: string): boolean {
  if (!name || !value.startsWith(name)) return false
  const tail = value.slice(name.length)
  return !tail || tail.search(LOCAL_SUBJECT_BOUNDARY) === 0 || tail.search(new RegExp(LOCAL_ADVERB_SUFFIX.source.replace(/\$$/u, ''), 'u')) === 0 ||
    BEAT_ACTIONS.some(action => action.forms.some(form => tail.startsWith(form)))
}

function localSubject(prefix: string, actorHints: string[] = []): string[] {
  const value = prefix.replace(/^[“”"「」『』]+/u, '').replace(/^(?:然后|随后|接着|随即|于是|最终|同时|如果|若是|假如)/u, '')
  if (/^(?:转动|拧动)(?:之后|以后|后)$/u.test(value) || /^(?:手电筒(?:的)?)?(?:光束|光柱|光)$/u.test(value)) return []
  const identified = actorHints.filter(name => namedSubjectPrefix(value, name)).sort((a, b) => b.length - a.length)[0]
  if (identified) return [identified]
  // Split only a grammatical coordination with a complete 2–4 character
  // name on each side; never split every 和 inside a character's name.
  const subjectHead = value.split(LOCAL_SUBJECT_BOUNDARY)[0]?.replace(LOCAL_ADVERB_SUFFIX, '').trim() ?? ''
  const coordinated = subjectHead.match(/^([\p{Script=Han}]{2,4})(?:与|和)([\p{Script=Han}]{2,4})$/u)
  if (coordinated) return unique([coordinated[1]!, coordinated[2]!].flatMap(part => localSubject(part, actorHints)), 4)
  // A longer visible name is not an omitted subject. In particular, a name
  // beginning with 向 must not fall through its first character's preposition
  // boundary and inherit a previously visible shorter actor.
  const extended = actorHints.filter(name => value.startsWith(name)).sort((a, b) => b.length - a.length)[0]
  if (extended) {
    const tail = value.slice(extended.length).split(LOCAL_SUBJECT_BOUNDARY)[0]?.replace(LOCAL_ADVERB_SUFFIX, '').trim() ?? ''
    if (tail && /^[\p{Script=Han}A-Za-z0-9_-]+$/u.test(tail)) return [`${extended}${tail}`]
  }
  const head = value
    .split(LOCAL_SUBJECT_BOUNDARY)[0]?.replace(LOCAL_ADVERB_SUFFIX, '').trim() ?? ''
  if (!head || head.includes('的') || !/^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]{0,3}$/u.test(head)) return []
  return [head === '两个人' ? '两人' : head]
}

function localPhysicalPatient(value: string): string {
  return roleEntity(value.replace(/^(?:那|这|一)(?:支|把|盏|只|份|张|枚)/u, '').replace(/(?:的)?一角$/u, '').replace(/((?:门|窗|抽屉))时$/u, '$1'))
}

function localPhysicalParts(source: string, match: ActionMatch, actorHints: string[] = [], previous?: SceneBeatEventGroup, visibleAgent: string[] = []): { roles: SceneBeatSemanticRoles; object: string[]; location: string[] } {
  const prefix = source.slice(0, match.index)
  const tail = source.slice(match.index + match.surface.length).split(/[，,。！？!?；;\n]/u)[0]?.replace(/^了/u, '').trim() ?? ''
  const roles: SceneBeatSemanticRoles = { agent: localSubject(prefix, actorHints), patient: [], source: [], recipient: [], beneficiary: [] }
  const object: string[] = []
  const spatial = prefix.match(/(?:在|于)([^，,。！？!?；;\n]{1,40})$/u)?.[1]?.replace(LOCAL_ADVERB_SUFFIX, '').trim()
  const location = spatial && inferTime(spatial).length === 0 ? [spatial] : []
  const passive = prefix.match(/^(.{1,40}?)被(.{1,24})$/u)
  const putPatient = prefix.match(/(?:把|将)(.{1,80})$/u)?.[1]
  if (passive) { roles.agent = localSubject(passive[2]!, actorHints); roles.patient = [localPhysicalPatient(passive[1]!)] }
  else if (match.canonical === 'open' && match.surface === '开了') {
    // A result clause (“抽屉开了”) has an object, not a new character.
    roles.agent = []; roles.patient = [localPhysicalPatient(prefix)]
  } else if (match.canonical === 'stow' || match.canonical === 'place') {
    if (putPatient) roles.patient = [localPhysicalPatient(putPatient)]
    else if (tail && match.surface !== '放回') roles.patient = [localPhysicalPatient(tail)]
    if (putPatient && tail) location.push(roleEntity(tail.replace(/^在/u, '')))
  } else if (['raise', 'flip', 'pickup', 'activate'].includes(match.canonical)) {
    if (putPatient) roles.patient = [localPhysicalPatient(putPatient)]
    else if (tail) roles.patient = [localPhysicalPatient(tail)]
  } else if (match.canonical !== 'mutual_gaze') {
    const patient = localPhysicalPatient(['open', 'close'].includes(match.canonical) && putPatient ? putPatient : tail)
    if (patient) roles.patient = [match.canonical === 'look' ? patient.replace(/(?:的)?方向$/u, '') : patient]
  }
  if (passive && match.canonical === 'stow' && tail) location.push(roleEntity(tail.replace(/^在/u, '')))
  if (match.canonical === 'press') {
    const instrument = putPatient ?? prefix.match(/用(.{1,40})$/u)?.[1]
    if (instrument) object.push(localPhysicalPatient(instrument.replace(/(?:的)?(?:尾部|底部|末端)$/u, '')))
  }
  if (match.canonical === 'illuminate') {
    roles.patient = roles.patient.flatMap(patient => {
      const breaks = [...patient.matchAll(/[与和]/gu)].filter(item => !actorHints.some(name => {
        const start = patient.indexOf(name)
        return start >= 0 && item.index! >= start && item.index! < start + name.length
      })).map(item => item.index!)
      const targets: string[] = []
      let start = 0
      for (const end of [...breaks, patient.length]) {
        const target = localPhysicalPatient(patient.slice(start, end))
        // Keep the spatial qualifier while normalizing a descriptive 的 or
        // demonstrative classifier: 墙上停摆的钟 / 墙上那只钟 share a
        // local target, but a clock elsewhere does not.
        const qualified = target.match(/^(.{1,12}(?:上|下|里|内|旁|边))(?:[^的]{1,12}的|(?:那|这|一)(?:只|盏|把|张|份|枚))(.+)$/u)
        if (target) targets.push(qualified ? `${qualified[1]}${qualified[2]}` : target)
        start = end + 1
      }
      return targets
    })
    const instrument = match.beam ?? prefix.match(/用(.{1,40})$/u)?.[1]
    if (instrument) object.push(localPhysicalPatient(instrument))
  }
  if (match.canonical === 'knock') {
    if (/^(?:[一二两三四五六七八九十\d]+下)?$/u.test(tail)) roles.patient = spatial ? [roleEntity(spatial)] : []
    let instrument = prefix.match(/用(.{1,40}?)(?=在|轻轻|缓缓|慢慢|$)/u)?.[1]
    const subject = roles.agent.length === 0 || /^(?:他|她)$/u.test(roles.agent[0] ?? '') ? visibleAgent : roles.agent
    if (instrument && /^(?:柄端|柄部|尾端)$/u.test(instrument) && previous?.action === 'pickup' && subject.length === 1 && previous.agent.length === 1 && previous.agent[0] === subject[0]) instrument = previous.patient[0]
    if (instrument) object.push(localPhysicalPatient(instrument))
  }
  if (match.canonical === 'reach') roles.patient = roles.patient.map(patient => patient.split(/(?:查看|看清|看)/u)[0]!).filter(Boolean)
  if (match.canonical === 'ask') {
    const addressee = actorHints.filter(name => tail.startsWith(name)).sort((a, b) => b.length - a.length)[0]
    if (addressee) roles.recipient = [addressee]
    roles.patient = roles.patient.map(patient => (addressee ? patient.slice(addressee.length) : patient).replace(/(?:的)?(?:下落|去向|位置|情况)$/u, '')).filter(Boolean)
  }
  if (match.canonical !== 'mutual_gaze') {
    roles.patient = roles.patient.map(patient => {
      const placed = patient.match(/^(.+?(?:室|房|屋|厅))(?:的)?(电话听筒|门锁|门|窗|抽屉|柜子)$/u)
      if (!placed) return patient
      location.push(placed[1]!); return placed[2]!
    })
  }
  return { roles, object: unique([...roles.patient, ...object].filter(Boolean), 8), location: unique(location.filter(Boolean), 8) }
}

/** Read-only realizations from the actual contract compiler, not a second
 * independently maintained synonym list in the state projection path. */
export function sceneBeatActionForms(canonical: string): readonly string[] {
  return Object.freeze([...(BEAT_ACTIONS.find((action) => action.canonical === canonical.trim().toLowerCase())?.forms ?? [])])
}

const SCENE_BEAT_ACTUALITIES: readonly SceneBeatActuality[] = [
  'asserted_actual', 'negated', 'planned', 'reported', 'remembered', 'dreamed',
  'conditional', 'imperative', 'requested', 'attempted', 'near_miss', 'pretended',
  'quoted', 'refused', 'proposed', 'questioned', 'threatened', 'unknown'
]

const SCENE_BEAT_ASSERTIONS: readonly SceneBeatAssertion[] = ['asserted', 'negated', 'non_asserted', 'unknown']

/**
 * Negation is intentionally expressed as grammar-shaped alternatives.  A
 * bare “不/没/无/未” is not a cue: those characters occur in ordinary
 * descriptions (“不远处”“无声”) and must never become a state-changing
 * predicate merely because they are nearby.
 */
const NEGATION_CUES = ['并没有', '没有', '未曾', '不曾', '并未', '未能', '没能', '不能', '无法', '无从', '不再', '从未', '不是', '并非', '未']
const GROUP_ACTORS = ['两人', '二人', '双方', '他们', '她们', '两者', '众人']
const ENTITY_FILLERS = /^(?:一|一把|一封|一枚|一件|一张|一盏|那|这|其|他的|她的|自己的|所谓|一份|几封|几把)/u
const DIRECTIONAL_ACTIONS = new Set(['handover', 'give', 'receive', 'lend', 'take', 'steal', 'place', 'lose', 'exchange', 'return'])

type ActualityCueKind = 'global' | 'local' | 'epistemic' | 'negation' | 'speech'

interface ActualityCue {
  actuality: SceneBeatActuality
  text: string
  start: number
  end: number
  kind: ActualityCueKind
}

interface ActualityAssessment {
  actuality: SceneBeatActuality
  cues: SceneBeatCueSpan[]
  scope: SceneBeatEventScope
}

/**
 * This is a small scope grammar, rather than a sentence-level word list.
 * Each rule identifies a cue span and a semantic class; whether it governs a
 * predicate is decided below from the intervening clause boundary.  Adding a
 * word without a span/scope rule is deliberately impossible here.
 */
const GLOBAL_CUE_PATTERNS: ReadonlyArray<{ actuality: SceneBeatActuality; pattern: RegExp }> = [
  { actuality: 'dreamed', pattern: /(?:梦里|梦中|梦见|做梦|幻觉|幻境|梦境)/gu },
  { actuality: 'remembered', pattern: /(?:回忆|想起|记起|记得|记忆中|回想|曾经|往日|那时|童年)/gu },
  { actuality: 'conditional', pattern: /(?:如果|若是|若(?!干)|假如|要是|倘若|一旦|除非|即使|哪怕|或许|也许|可能|本可以|仿佛)/gu },
  { actuality: 'reported', pattern: /(?:听说|据说|据传|传闻|传言|谣言|所谓|有人说|有人声称|据称|消息称|传来的消息|报道称)/gu }
]

const LOCAL_CUE_PATTERNS: ReadonlyArray<{ actuality: SceneBeatActuality; pattern: RegExp; kind?: ActualityCueKind }> = [
  { actuality: 'dreamed', pattern: /(?:想象|幻想|设想|假想)/gu, kind: 'epistemic' },
  { actuality: 'refused', pattern: /(?:拒绝|拒不|不肯|不愿|拒斥|没有答应|未答应|否认|不承认|阻止|制止|拦住|拦下|禁止|避免)/gu },
  { actuality: 'near_miss', pattern: /(?:差点|差一点|险些|几乎|眼看就要|来不及|没来得及|无暇)/gu },
  { actuality: 'pretended', pattern: /(?:假装|装作|佯装|假扮|冒充)/gu },
  { actuality: 'attempted', pattern: /(?:试图|尝试|企图|努力(?:去)?|设法|想办法)/gu },
  { actuality: 'threatened', pattern: /(?:威胁|威吓|扬言|恐吓|警告)/gu },
  { actuality: 'questioned', pattern: /(?:询问|问道|问起|问是否|是否|可否|要不要|该不该|应不应该)/gu, kind: 'speech' },
  { actuality: 'imperative', pattern: /(?:命令|下令|指使|吩咐|要求|指示)/gu, kind: 'speech' },
  { actuality: 'requested', pattern: /(?:请求|恳求|拜托|央求|劝|请(?!示|问|教|求))/gu, kind: 'speech' },
  { actuality: 'proposed', pattern: /(?:提议|建议|提倡|提到可以)/gu, kind: 'speech' },
  { actuality: 'planned', pattern: /(?:本来要|原本要|正要|刚要|本想|原想|计划|打算|准备|将要|即将|会去|想要|想把|想将|预备|拟定)/gu },
  // Belief and speech framing are not evidence that the embedded predicate
  // occurred in the story world.  Keep these cues scoped to the predicate
  // instead of treating the whole sentence as a single polarity bit.
  { actuality: 'reported', pattern: /(?:谎称|假称|谎报|自称|声称|以为|误以为|错以为|相信|认为|坚信|觉得|没想到|想不到|料想|猜测|怀疑|知道|不知道|承认|否认)/gu, kind: 'epistemic' },
  { actuality: 'reported', pattern: /(?:说(?:道|完|着)?|表示|宣布|告诉|告知|听见|听到|听说)/gu, kind: 'speech' },
  { actuality: 'unknown', pattern: /(?:证据不足以|不足以|没有足够证据|无法|难以|未必|不一定|难说|无法确定|未能确定)\s*(?:证明|证实|确认|确定|表明|说明)?/gu, kind: 'epistemic' },
  { actuality: 'negated', pattern: /(?:并没有|没有|未曾|不曾|并未|未能|没能|不能|无法|无从|不再|从未|不是|并非|没(?=(?:有|能|来得及|将|把|被|曾|发生|找到|交|递|给|到|过))|未(?=(?:将|把|被|能|有|曾|发生|找到|交|递|给|到|过)))/gu, kind: 'negation' },
  { actuality: 'negated', pattern: /(?:不要|不应|不该|不可)(?=(?:把|将|交|递|给|拿|取|带|放|借|还|接|接受|承认|允许|会|能|愿|肯|曾|再|去|发生|存在|找到|确认|证明|是|在|与|同))/gu, kind: 'negation' },
  // “不” is only a negative event cue when its complement visibly starts a
  // disposal/transfer or event predicate.  This avoids false matches in
  // ordinary modifiers such as “不远处”“不安地”“不由得”.
  { actuality: 'negated', pattern: /不(?=(?:把|将|交|递|给|拿|取|带|放|借|还|接|接受|承认|允许|会|能|愿|肯|曾|再|去|发生|存在|找到|确认|证明|是|在|与|同))/gu, kind: 'negation' },
  { actuality: 'negated', pattern: /(?:没有发生|未发生|从未发生|并非事实|不是事实|不曾发生|未果|落空|失败|不成|并不存在|不存在)/gu, kind: 'negation' }
]

/** Sentence-final interrogatives are epistemic questions, never assertions.
 * The marker itself is the cue span so a later independent event can still
 * be classified as actual in a multi-event sentence. */
function structuralQuestionCues(text: string): ActualityCue[] {
  const cues: ActualityCue[] = []
  for (const match of text.matchAll(/[吗么呢](?=\s*(?:[？?]|$|[。！？!?；;\n]))|[？?](?=$|[。！？!?；;\n])/gu)) {
    const start = match.index ?? -1
    if (start < 0 || !match[0]) continue
    cues.push({ actuality: 'questioned', text: match[0], start, end: start + match[0].length, kind: 'epistemic' })
  }
  return cues
}

/** “让/叫” are only speech-act cues when their complement visibly starts a
 * second participant plus a disposal marker.  This excludes homographs such
 * as “让开道路” and “叫喊” without another vocabulary exception list. */
function structuralSpeechCues(text: string, actorHints: string[] = []): ActualityCue[] {
  const cues: ActualityCue[] = []
  for (const match of text.matchAll(/(?:让|叫|命)/gu)) {
    const start = match.index ?? -1
    if (start < 0) continue
    const tail = text.slice(start + match[0].length)
    const complement = tail.match(/^(?<subject>[㐀-鿿A-Za-z·]{2,16}|他|她|对方|守门人)\s*(?:把|将)/u)
    const subject = complement?.groups?.subject ?? ''
    if (!subject || /(?:之后|以后|过后|随后|然后|接着|便|就|才|后)/u.test(subject)) continue
    // The complement itself is the participant binding.  `actorHints` is
    // intentionally limited to agent/actor roles in the caller so it cannot
    // be used as a whitelist here (the commanded participant is normally the
    // recipient, not the agent).  Requiring a visible subject + 把/将 is the
    // grammar boundary that keeps homographs such as “让开道路” out.
    cues.push({ actuality: 'imperative', text: match[0], start, end: start + match[0].length, kind: 'speech' })
  }
  return cues
}

function actualityCues(text: string, actorHints: string[] = []): ActualityCue[] {
  const cues: ActualityCue[] = []
  const collect = (patterns: ReadonlyArray<{ actuality: SceneBeatActuality; pattern: RegExp; kind?: ActualityCueKind }>, fallbackKind: ActualityCueKind): void => {
    for (const rule of patterns) {
      for (const match of text.matchAll(rule.pattern)) {
        const start = match.index ?? -1
        if (start < 0 || !match[0]) continue
        cues.push({ actuality: rule.actuality, text: match[0], start, end: start + match[0].length, kind: rule.kind ?? fallbackKind })
      }
    }
  }
  collect(GLOBAL_CUE_PATTERNS, 'global')
  collect(LOCAL_CUE_PATTERNS, 'local')
  // Bare negators are cues only immediately before a registered predicate;
  // new physical verbs must retain the same polarity boundary as transfers.
  for (const predicate of actionMatches(text)) {
    const before = text.slice(0, predicate.index)
    const negative = before.match(/[不没未](?:用[^，,。！？!?；;\n]{1,40})?$/u)
    const start = negative?.index ?? -1
    if (negative && !cues.some(cue => cue.kind === 'negation' && cue.start <= start && cue.end >= start + 1)) cues.push({
      actuality: 'negated', text: negative[0][0]!, start, end: start + 1, kind: 'negation'
    })
    const planned = before.match(/想(?:用[^，,。！？!?；;\n]{1,40})?$/u)
    if (planned) cues.push({ actuality: 'planned', text: '想', start: planned.index!, end: planned.index! + 1, kind: 'local' })
  }
  cues.push(...structuralSpeechCues(text, actorHints))
  cues.push(...structuralQuestionCues(text))
  return cues.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.actuality.localeCompare(b.actuality))
}

// Bare “后” is a temporal boundary only when it introduces a following
// predicate.  Matching it inside compounds such as “后门” detached a plan
// cue from its own predicate and incorrectly promoted the event to actual.
const STRONG_SCOPE_BREAK = /(?:之后|以后|过后|随后|然后|接着|便|就|才|却|但是|但|然而|不过|可是|于是|因此|同时|后(?=\s*(?:把|将|便|就|又|再|仍|才|开始|继续|随后|然后|接着)))/gu
const WEAK_SCOPE_BREAK = /(?:并且|并|而|又|再)/gu

function scopeBreak(text: string, start: number, end: number, includeWeak: boolean): { index: number; text: string } | null {
  if (end <= start) return null
  const value = text.slice(start, end)
  const pattern = includeWeak ? new RegExp(`${STRONG_SCOPE_BREAK.source}|${WEAK_SCOPE_BREAK.source}`, 'gu') : new RegExp(STRONG_SCOPE_BREAK.source, 'gu')
  const match = pattern.exec(value)
  return match && match[0] ? { index: start + match.index, text: match[0] } : null
}

function quoteScope(text: string, index: number): { inside: boolean; ambiguous: boolean; start: number; end: number } {
  const stack: Array<{ close: string; start: number }> = []
  let ambiguous = false
  const pairs: Record<string, string> = { '“': '”', '「': '」', '『': '』' }
  for (let cursor = 0; cursor < Math.min(index, text.length); cursor += 1) {
    const char = text[cursor]!
    if (char === '"') {
      if (stack.at(-1)?.close === '"') stack.pop()
      else stack.push({ close: '"', start: cursor })
      continue
    }
    if (pairs[char]) {
      stack.push({ close: pairs[char]!, start: cursor })
      continue
    }
    if (['”', '」', '』'].includes(char)) {
      if (stack.at(-1)?.close === char) stack.pop()
      else ambiguous = true
    }
  }
  const active = stack.at(-1)
  if (!active) return { inside: false, ambiguous, start: index, end: index }
  const closeIndex = text.indexOf(active.close, index)
  return { inside: true, ambiguous, start: active.start, end: closeIndex >= 0 ? closeIndex + 1 : text.length }
}

function quoteContains(text: string, index: number): boolean {
  return quoteScope(text, index).inside
}

function cueAppliesToPredicate(cue: ActualityCue, text: string, predicateStart: number, predicateEnd: number, clauseStart: number, clauseEnd: number): { relation: SceneBeatCueSpan['relation']; scopeStart: number; scopeEnd: number; rationale: string } {
  if (/^(?:想象|幻想|设想|假想)$/u.test(cue.text)) {
    const between = cue.start < predicateStart ? text.slice(cue.end, predicateStart) : text.slice(predicateEnd, cue.start)
    // Imagining is a local mental act, not a document-wide dream frame. An
    // independent full sentence or explicit new actual clause ends it.
    const independentActual = cue.start < clauseStart && /^[\p{Script=Han}]{2,4}(?:已经|已|实际|现在|此刻)/u.test(text.slice(clauseStart, predicateStart))
    const retrospective = cue.start >= predicateEnd && /(?:只是|不过是|只不过是|是[^，,。！？!?；;\n]{0,12})$/u.test(between)
    if (/[。！？!?；;\n]/u.test(between) || independentActual || cue.start >= predicateEnd && !retrospective) {
      return { relation: 'outside', scopeStart: cue.start, scopeEnd: cue.end, rationale: '局部想象不支配另一独立真实谓词' }
    }
  }
  if (cue.kind === 'global') {
    if (cue.start >= predicateEnd) {
      // A later clause's conjecture cannot govern an earlier action. Keep a
      // same-clause retrospective frame unresolved, with ordered offsets.
      if (cue.start >= clauseEnd) return { relation: 'outside', scopeStart: cue.start, scopeEnd: cue.end, rationale: '后置叙述线索属于后续从句，不支配先前谓词' }
      return { relation: 'ambiguous', scopeStart: predicateStart, scopeEnd: Math.max(clauseEnd, cue.end), rationale: '同从句后置叙述线索可能回指谓词，保持非确定' }
    }
    const breaker = scopeBreak(text, cue.end, predicateStart, false)
    if (!breaker) return { relation: 'governs', scopeStart: cue.start, scopeEnd: clauseEnd, rationale: '全局叙述框架覆盖同一从句内的谓词' }
    return { relation: 'outside', scopeStart: cue.start, scopeEnd: breaker.index, rationale: `线索作用域在“${breaker.text}”前结束` }
  }
  if (cue.start < predicateStart) {
    const between = text.slice(cue.end, predicateStart)
    // “说完/说着再……” describes the speech act surrounding a later
    // predicate; it does not make that later predicate reported.  A bare
    // speech verb followed by an explicit complement (角色 + 把/将/谓词)
    // remains scoped to the embedded event below.
    if (cue.kind === 'speech' && /(?:完|着|罢|了)$/u.test(cue.text)) {
      return { relation: 'outside', scopeStart: cue.start, scopeEnd: cue.end, rationale: '说话动作已结束或伴随发生，后续谓词是独立事件' }
    }
    const plannedTemporalComplement = cue.actuality === 'planned' &&
      /(?:本来要|原本要|正要|刚要|本想|原想|计划|打算|将要|即将|会去|想要|想把|想将|预备|拟定)/u.test(cue.text) &&
      /(?:^|[在于])[^。！？!?；;]{0,160}(?:之后|以后|过后)(?:把|将)?[^。！？!?；;]{0,80}$/u.test(between)
    if (plannedTemporalComplement) {
      return {
        relation: 'governs',
        scopeStart: cue.start,
        scopeEnd: predicateEnd,
        rationale: '计划线索包含时间补语，仍覆盖其后的目标谓词'
      }
    }
    const breaker = scopeBreak(text, cue.end, predicateStart, true)
    if (breaker) return { relation: 'outside', scopeStart: cue.start, scopeEnd: breaker.index, rationale: `线索短语在“${breaker.text}”处结束，后续谓词是独立事件` }
    if (cue.kind === 'speech') {
      const complement = text.slice(cue.end, predicateStart)
      if (!/(?:[㐀-鿿A-Za-z·]{2,16}|他|她|对方|守门人)?\s*(?:把|将)?[^。！？!?；;]{0,80}$/u.test(complement)) return { relation: 'ambiguous', scopeStart: cue.start, scopeEnd: predicateEnd, rationale: '言语行为线索缺少可见的嵌入补语边界' }
    }
    if (cue.kind === 'epistemic' && /(?:并非|不是|未必|不一定)[^。！？!?；;]{0,40}$/.test(between)) return { relation: 'ambiguous', scopeStart: cue.start, scopeEnd: predicateEnd, rationale: '证据/信念线索含嵌套否定，无法安全归属' }
    return { relation: 'governs', scopeStart: cue.start, scopeEnd: predicateEnd, rationale: '线索与目标谓词之间无切断作用域的连接词' }
  }
  if (cue.start >= predicateEnd) {
    const breaker = scopeBreak(text, predicateEnd, cue.start, true)
    if (breaker) return { relation: 'outside', scopeStart: predicateStart, scopeEnd: breaker.index, rationale: `谓词后的线索位于“${breaker.text}”另一侧` }
    if (cue.actuality === 'questioned') return { relation: 'governs', scopeStart: predicateStart, scopeEnd: cue.end, rationale: '谓词后出现句末疑问标记，不能视为事实断言' }
    if (cue.kind === 'negation' || cue.kind === 'epistemic') return { relation: 'governs', scopeStart: predicateStart, scopeEnd: cue.end, rationale: '谓词后出现明确否定/证据结论' }
    return { relation: 'ambiguous', scopeStart: predicateStart, scopeEnd: cue.end, rationale: '谓词后的线索无法确定是否回指该谓词' }
  }
  return { relation: 'ambiguous', scopeStart: clauseStart, scopeEnd: clauseEnd, rationale: '线索与谓词重叠，无法建立唯一作用域' }
}

function classifyActuality(
  text: string,
  action: { index: number; surface?: string; canonical?: string } | undefined,
  clauseStart = 0,
  clauseEnd = text.length,
  quoteContext = text,
  quoteIndex = action?.index ?? text.length,
  actorHints: string[] = [],
  predicateLocal = false
): ActualityAssessment {
  const predicateStart = Math.max(0, Math.min(text.length, action?.index ?? text.length))
  const predicateEnd = Math.min(text.length, predicateStart + (action?.surface?.length ?? 0))
  const quoted = action ? quoteScope(quoteContext, quoteIndex) : { inside: false, ambiguous: false, start: predicateStart, end: predicateEnd }
  // Local negation/speech in another complete sentence does not describe
  // this physical predicate. Keep global dream/conditional frames and the
  // full-text quote scope; neither may be promoted to a real-world event.
  const sentenceStart = predicateLocal ? (text.slice(0, predicateStart).match(/[^。！？!?；;\n]*$/u)?.index ?? 0) : 0
  const sentenceTail = predicateLocal ? text.slice(predicateEnd).search(/[。！？!?；;\n]/u) : -1
  const sentenceEnd = sentenceTail < 0 ? text.length : predicateEnd + sentenceTail
  const cues = actualityCues(text, actorHints).filter(cue =>
    !(action?.canonical === 'ask' && cue.actuality === 'questioned' && cue.start === predicateStart && cue.end <= predicateEnd) &&
    // Saying/asking is itself a narrated act. Its lexical speech cue governs
    // an embedded proposition, not the identical anchored speech predicate.
    // External denial, plans and reported/global frames still apply normally.
    !(predicateLocal && cue.kind === 'speech' && ['reported', 'questioned'].includes(cue.actuality) && cue.start === predicateStart && cue.end <= predicateEnd) &&
    (!predicateLocal || cue.kind === 'global' || cue.start >= sentenceStart && cue.start <= sentenceEnd && cue.start < clauseEnd))
  if (action && quoted.inside) {
    const cueSpans: SceneBeatCueSpan[] = cues.map((cue) => ({
      actuality: cue.actuality,
      text: cue.text,
      start: cue.start,
      end: cue.end,
      scopeStart: quoted.start,
      scopeEnd: quoted.end,
      relation: 'outside' as const,
      rationale: '谓词位于引号作用域内；引号外线索不改变引语事实性'
    }))
    cueSpans.push({ actuality: 'quoted', text: quoteContext.slice(Math.max(0, quoted.start), Math.min(quoteContext.length, quoted.start + 1)), start: quoted.start, end: quoted.start + 1, scopeStart: quoted.start, scopeEnd: quoted.end, relation: 'governs', rationale: '谓词位于显式引号作用域内' })
    return {
      actuality: 'quoted',
      cues: cueSpans,
      scope: { start: quoted.start, end: quoted.end, confidence: quoted.ambiguous ? 'uncertain' : 'high', rationale: quoted.ambiguous ? '引号嵌套/闭合不完整，保持 quoted 以阻断状态写入' : '显式引号作用域' }
    }
  }
  const scoped = cues.map((cue) => {
    // Confirming an absence is an actual confirming act. The negative
    // proposition remains its exact patient; it is not a denial that the
    // confirmation happened. A pre-verbal denial or retrospective denial
    // of the whole assertion still governs, as do quotes/plans/dreams.
    const negativeComplement = action?.canonical === 'confirm' && cue.kind === 'negation' && cue.start >= predicateEnd &&
      !/(?:并非事实|不是事实|没有发生|未发生|从未发生|未果|落空|失败|不成)/u.test(text.slice(cue.start, clauseEnd))
    return { cue, ...(negativeComplement
      ? { relation: 'outside' as const, scopeStart: predicateEnd, scopeEnd: clauseEnd, rationale: '否定属于确认动作的命题宾语，而非确认动作本身' }
      : cueAppliesToPredicate(cue, text, predicateStart, predicateEnd, clauseStart, clauseEnd)) }
  })
  const cueSpans = scoped.map(({ cue, relation, scopeStart, scopeEnd, rationale }) => ({ actuality: cue.actuality, text: cue.text, start: cue.start, end: cue.end, scopeStart, scopeEnd, relation, rationale }))
  const governing = scoped.filter((item) => item.relation === 'governs')
  const ambiguous = scoped.filter((item) => item.relation === 'ambiguous')
  const direct = governing
    .filter((item) => predicateLocal && item.cue.kind === 'global' && item.cue.start < predicateStart ||
      item.cue.start >= clauseStart && (item.cue.start < clauseEnd || (item.cue.actuality === 'questioned' && item.cue.start === clauseEnd)))
    .sort((a, b) => {
      const priority = (actuality: SceneBeatActuality): number => {
        if (actuality === 'unknown') return 100
        if (actuality === 'negated') return 95
        if (actuality === 'refused' || actuality === 'near_miss') return 90
        if (actuality === 'pretended' || actuality === 'attempted') return 85
        if (actuality === 'conditional' || actuality === 'dreamed' || actuality === 'remembered') return 80
        if (actuality === 'imperative' || actuality === 'requested' || actuality === 'questioned' || actuality === 'proposed' || actuality === 'threatened') return 75
        if (actuality === 'planned' || actuality === 'reported') return 70
        return 10
      }
      return priority(b.cue.actuality) - priority(a.cue.actuality) || b.cue.start - a.cue.start
    })
  if (direct.length > 0) {
    const selected = direct[0]!
    const distinct = new Set(direct.map((item) => item.cue.actuality))
    const nestedNegation = direct.filter((item) => item.cue.kind === 'negation').length > 1
    const conflicting = nestedNegation || distinct.has('unknown') || (distinct.has('negated') && distinct.size > 1 && [...distinct].some((item) => item === 'asserted_actual'))
    if (conflicting || ambiguous.length > 0 && direct.some((item) => item.cue.kind === 'epistemic')) {
      return { actuality: 'unknown', cues: cueSpans, scope: { start: clauseStart, end: clauseEnd, confidence: 'uncertain', rationale: '多个线索或嵌套证据线索无法唯一归属目标谓词' } }
    }
    return { actuality: selected.cue.actuality, cues: cueSpans, scope: { start: selected.scopeStart, end: selected.scopeEnd, confidence: 'high', rationale: selected.rationale } }
  }
  if (ambiguous.length > 0) {
    return { actuality: 'unknown', cues: cueSpans, scope: { start: clauseStart, end: clauseEnd, confidence: 'uncertain', rationale: '存在未能可靠分配给谓词的现实性线索' } }
  }
  return { actuality: 'asserted_actual', cues: cueSpans, scope: { start: predicateStart, end: predicateEnd, confidence: 'high', rationale: '谓词具有显式局部范围且未命中非断言线索' } }
}

function detectActuality(text: string, action?: { index: number; surface?: string }, quoteContext = text, quoteIndex = action?.index ?? text.length): SceneBeatActuality {
  return classifyActuality(text, action, 0, text.length, quoteContext, quoteIndex).actuality
}

function cleanEntity(value: string): string {
  return value
    .replace(/[“”"「」『』（）()]/gu, '')
    .replace(/^(?:将|把|给|向|对|从|在|于|到|至|和|与|并|又|随后|然后|最终|便|就|已|已经|曾|正|正在|会|要|能|能够|可以|不得|不要|没有|并没有|未曾|未|没|不|了|着|过)/u, '')
    .replace(ENTITY_FILLERS, '')
    .replace(/[的了着过之手里上中下内外旁前后]+$/u, '')
    .trim()
}

function entityVariants(value: string): string[] {
  const cleaned = cleanEntity(value)
  const out = [value.trim(), cleaned]
  // Mandarin compounds commonly add a descriptive modifier to an entity in
  // the prose (密信 → 一封落满盐霜的信; 灯塔 → 塔窗).  Keep these aliases
  // narrow so a generic one-character match cannot satisfy an unrelated beat.
  if (cleaned.includes('密信')) out.push('信')
  if (cleaned.includes('灯塔')) out.push('塔')
  if (cleaned.includes('钥匙')) out.push('钥匙')
  if (cleaned.includes('信件')) out.push('信')
  if (cleaned.includes('电话听筒')) out.push(cleaned.replace('电话听筒', '听筒'))
  return unique(out.filter(Boolean), 8)
}

function entityCovered(text: string, required: string): boolean {
  // Possessive 的 may separate the same two noun components, but dropping
  // an entire modifier would equate unrelated switches/manuals/keys.
  const compound = (value: string): string => value.replace(/的(?=(?:开关|封面|锁孔|柄端|光束|光柱))/gu, '')
  const haystack = compound(text).toLocaleLowerCase()
  return entityVariants(required).some((variant) => {
    const needle = compound(variant).toLocaleLowerCase()
    return needle.length > 0 && haystack.includes(needle)
  })
}

function actionMatches(text: string): ActionMatch[] {
  const matches: ActionMatch[] = []
  for (const match of text.matchAll(/(?:停在|落在|移到|移向|扫过|转向)/gu)) {
    const index = match.index!
    const prefix = text.slice(Math.max(0, index - 120), index).split(/[。！？!?；;\n]/u).at(-1) ?? ''
    const beam = [...prefix.matchAll(/(?:手电筒(?:的)?)?(?:光束|光柱)/gu)].at(-1)?.[0]
    if (beam) matches.push({ canonical: 'illuminate', surface: match[0], index, beam })
  }
  // A bare 看 is otherwise too ambiguous; a visible directional complement
  // gives it an object anchor without equating 看 with discovery or dialogue.
  for (const match of text.matchAll(/看(?=[^，,。！？!?；;\n]{1,40}方向)/gu)) matches.push({ canonical: 'look', surface: '看', index: match.index! })
  for (const action of BEAT_ACTIONS) {
    for (const form of action.forms) {
      let from = 0
      while (from < text.length) {
        const index = text.indexOf(form, from)
        if (index < 0) break
        if (form === '轻敲' && text[index - 1] === '轻') {
          from = index + form.length
          continue
        }
        if (form === '问' && /[询疑学]/u.test(text[index - 1] ?? '')) {
          from = index + form.length
          continue
        }
        if (form === '压在' && !/(?:把|将|用)/u.test(text.slice(0, index).split(/[，,。！？!?；;\n]/u).at(-1) ?? '')) {
          from = index + form.length
          continue
        }
        if (form === '开了' && !/(?:门|窗|抽屉|柜|盖)$/u.test(text.slice(Math.max(0, index - 16), index))) {
          from = index + form.length
          continue
        }
        const prefix = text.slice(Math.max(0, index - 120), index).split(/[。！？!?；;\n]/u).at(-1) ?? ''
        const beam = action.canonical === 'illuminate' ? [...prefix.matchAll(/(?:手电筒(?:的)?)?(?:光束|光柱)/gu)].at(-1)?.[0] : undefined
        matches.push({ canonical: action.canonical, surface: form, index, ...(beam ? { beam } : {}) })
        from = index + Math.max(1, form.length)
      }
    }
  }
  const ordered = matches.sort((a, b) => a.index - b.index || b.surface.length - a.surface.length)
  // Several Chinese compounds contain another registered action surface:
  // “转交给” contains both “转交” and “交给”.  Keeping both creates a
  // phantom second event whose prefix starts inside the predicate, which can
  // make a single non-actual clause appear to have an asserted_actual group.
  // Keep the longest overlapping span and preserve separate adjacent actions.
  const kept: ActionMatch[] = []
  for (const candidate of ordered) {
    const candidateEnd = candidate.index + candidate.surface.length
    const overlapIndex = kept.findIndex((existing) => {
      const existingEnd = existing.index + existing.surface.length
      return candidate.index < existingEnd && existing.index < candidateEnd
    })
    if (overlapIndex < 0) {
      kept.push(candidate)
      continue
    }
    const existing = kept[overlapIndex]!
    if (candidate.surface.length > existing.surface.length) kept[overlapIndex] = candidate
  }
  return kept.sort((a, b) => a.index - b.index || b.surface.length - a.surface.length)
}

/**
 * Classify the event around one predicate.  The returned value is deliberately
 * stronger than the legacy coarse modality: only `asserted_actual` may mutate
 * current world state.  Negation is checked here as a fallback as well as in
 * `detectNegation`, because Chinese often places an object between the cue
 * and predicate (没有把钥匙交给…).
 */
function actualityModality(actuality: SceneBeatActuality): SceneBeatModality {
  switch (actuality) {
    case 'dreamed': return 'dream'
    case 'remembered': return 'memory'
    case 'reported': return 'reported'
    case 'planned':
    case 'proposed': return 'planned'
    case 'conditional': return 'hypothetical'
    case 'asserted_actual':
    case 'negated': return 'actual'
    default: return 'unknown'
  }
}

function actualityAssertion(actuality: SceneBeatActuality): SceneBeatAssertion {
  if (actuality === 'asserted_actual') return 'asserted'
  if (actuality === 'negated') return 'negated'
  if (actuality === 'unknown') return 'unknown'
  return 'non_asserted'
}

function actualityFromModality(modality: SceneBeatModality | undefined): SceneBeatActuality {
  switch (modality) {
    case 'dream': return 'dreamed'
    case 'memory': return 'remembered'
    case 'reported': return 'reported'
    case 'planned': return 'planned'
    case 'hypothetical': return 'conditional'
    case 'actual': return 'asserted_actual'
    default: return 'unknown'
  }
}

function detectNegation(text: string, action?: { index: number }): boolean {
  if (action) {
    const before = text.slice(Math.max(0, action.index - 20), action.index)
    // Do not search for a bare “不/无/未” in the whole paragraph: ordinary
    // prose contains these characters constantly (“不远处”, “无声”).  Only
    // accept a cue immediately before the event, or an explicit predicate
    // after it.
    if (NEGATION_CUES.some((cue) => before.endsWith(cue))) return true
    const after = text.slice(action.index, Math.min(text.length, action.index + 48))
    if (/(?:并非|不是|没有发生|未发生|从未发生|只是传闻|只是谣言|不过是传闻|不过是谣言|不存在|不在|并不存在|并未找到|没有找到|没找到|未找到|未果|落空|失败|不成)/u.test(after)) return true
  }
  // A clause-level cue covers forms such as “所谓发现密信并非事实” without
  // treating every occurrence of “不” as a negation of this beat.
  return /(?:没有发生|未发生|从未发生|并非事实|不是事实|不曾发生|未能发生)/u.test(text)
}

function splitEvidenceClauses(text: string): string[] {
  return text.split(/[。！？!?；;\n]+/u).flatMap((sentence) => {
    const value = sentence.trim()
    if (!value) return []
    // Keep comma-separated event chains together for actor/location context,
    // but expose each side as a local clause for modality/negation checks.
    return [value, ...value.split(/[，,、]+/u).map((part) => part.trim()).filter(Boolean)]
  })
}

function roleEntity(value: string): string {
  return cleanEntity(value
    .replace(/(?:手里|手中|手上|那里|此处|之处|附近|一侧|身边)$/u, '')
    // Clause connectors are not character identities.  Keeping them in an
    // agent field makes an omitted-subject continuation look like a new
    // person and can later poison directional state projections.
    .replace(/^(?:后来|此前|此后|随后|然后|接着|随即|同时|最终|终于|于是|因此|并且|并|而|又|再|便|就|才)/u, '')
    .replace(/(?:随后|然后|接着|随即|同时|最终|终于|于是|因此|并且|并|而|又|再|便|就|才|却|但是|但|然而|不过|可是)$/u, '')
    .replace(/^(?:从|由|在|向|对|给|为|替|于|于此)\s*/u, ''))
}

function eventAction(matches: Array<{ canonical: string; surface: string; index: number }>): { canonical: string; surface: string; index: number } | undefined {
  return matches.find((item) => !(item.canonical === 'handover' && item.surface === '把')) ?? matches[0]
}

/** Extract only syntactically visible roles. In particular, a name appearing
 * later as a recipient is never reused as the agent merely because it was the
 * first known character in the outline. */
function inferSemanticRoles(source: string, actorHints: string[], matches: Array<{ canonical: string; surface: string; index: number }>): SceneBeatSemanticRoles {
  const roles: SceneBeatSemanticRoles = { agent: [], patient: [], source: [], recipient: [], beneficiary: [] }
  const primary = eventAction(matches)
  // Without a predicate, a trailing descriptive clause is not a subject.
  if (!primary) return roles
  if (localActionBound(primary.canonical, source)) return localPhysicalParts(source, primary, actorHints).roles
  const actionIndex = primary?.index ?? source.length
  const before = source.slice(0, actionIndex)
  const group = GROUP_ACTORS.find((item) => before.includes(item))
  const leadingActorHint = actorHints
    .filter((name) => namedSubjectPrefix(source, name))
    .sort((a, b) => b.length - a.length)[0]

  // “不由得” is an adverbial modifier, not the passive marker “由”.  The
  // latter must not steal the agent span and turn a valid transfer into an
  // unresolved role binding.
  const passive = source.match(/(?:被|(?<!不)由(?!得))\s*([^，,。！？!?；;\n]{1,24}?)(?=(?:拿走|取走|带走|偷走|盗走|放置|放下|遗失|丢失|交换|互换|归还|交给|递给|借给|移交|转交))/u)
  const putSubject = source.match(/^\s*([^，,。！？!?；;\n]{1,24}?)\s*(?:把|将)\s*/u)
  const hintBefore = actorHints
    .filter((name) => name && before.includes(name))
    .filter((name) => {
      const index = before.lastIndexOf(name)
      return index < 0 || !/(?:从|在|向|对|给|为|替)\s*[^，,、和与并]{0,20}$/u.test(before.slice(0, index))
    })
    .sort((a, b) => b.length - a.length)
  if (passive?.[1]) roles.agent.push(roleEntity(passive[1]))
  else if (leadingActorHint) roles.agent.push(leadingActorHint)
  else if (localSubject(before, actorHints).length > 0) roles.agent.push(...localSubject(before, actorHints))
  else if (putSubject?.[1]) roles.agent.push(roleEntity(putSubject[1]))
  else if (hintBefore.length > 0) roles.agent.push(...hintBefore.slice(0, 4))
  else if (group) roles.agent.push(group)
  else if (before && !/^(?:转动|拧动)(?:之后|以后|后)$/u.test(before) && !/^(?:从|在|向|对|给|为|替|由)\b/u.test(before) && !/(?:手里|手中|处|那里|上|里|中|旁|边|下)$/u.test(before)) {
    const direct = roleEntity(before.split(/[，,、和与并]/u).at(-1) ?? '')
    if (direct && direct.length <= 24 && !/^(?:然后|随后|最终|于是|并且|还)$/u.test(direct)) roles.agent.push(direct)
  }

  const handoverPatient = source.match(/(?:把|将)\s*([^，,。！？!?；;\n]{1,80}?)\s*(?:交出|交给|交到|递给|递出|递过|转交|移交|借给|给)/u)
  if (handoverPatient?.[1]) roles.patient.push(roleEntity(handoverPatient[1]))
  const passivePatient = source.match(/^\s*([^，,。！？!?；;\n]{1,24}?)\s*被\s*/u)
  if (passivePatient?.[1]) roles.patient.push(roleEntity(passivePatient[1]))
  if (primary) {
    const tail = source.slice(primary.index + primary.surface.length).split(/[。！？!?；;\n，,、]+/u)[0] ?? ''
    const tailEntity = roleEntity(tail.replace(/^(?:地|了|并|然后|随后|终于|便|就)/u, ''))
    if (tailEntity && !['arrive', 'decide', 'confirm', 'meet', 'leave', 'reveal', 'light', 'handover', 'give', 'lend'].includes(primary.canonical)) roles.patient.push(tailEntity)
  }

  const sourceMatch = source.match(/从\s*([^，,。！？!?；;\n]{1,24}?)(?:手里|手中|手上|那里|处|中)?(?=(?:拿走|取走|带走|偷走|盗走|借出|取出|带回|归还|交给|递给|移交|转交))/u)
  if (sourceMatch?.[1]) roles.source.push(roleEntity(sourceMatch[1]))

  const recipientMatch = source.match(/(?:交给|交到|递给|递出|转交给|移交给|借给|还给|给予|给与|给)\s*([^，,。！？!?；;\n]{1,24})/u)
  const recipientTail = recipientMatch && typeof recipientMatch.index === 'number'
    ? source.slice(recipientMatch.index + recipientMatch[0].length - (recipientMatch[1]?.length ?? 0))
    : ''
  const recipientLocal = recipientTail.split(/[。！？!?；;\n，,、]/u)[0] ?? ''
  const recipientHints = actorHints.filter((name) => name && recipientLocal.includes(name)).sort((a, b) => b.length - a.length)
  if (recipientHints.length > 0) roles.recipient.push(recipientHints[0]!)
  else if (recipientMatch?.[1]) {
    const candidate = roleEntity(recipientMatch[1])
      .split(/(?:的|手里|手中|却|但是|但|然而|不过|可是|随后|然后|接着|随即|同时|最终|终于|于是|因此|并且|并|而|又|再|便|就|才|把|将|交给|递给|给)/u)[0] ?? ''
    if (candidate && candidate.length <= 24) roles.recipient.push(candidate)
  }

  const beneficiaryMatch = source.match(/(?:为|替)\s*([^，,。！？!?；;\n]{1,24})/u)
  if (beneficiaryMatch?.[1]) roles.beneficiary.push(roleEntity(beneficiaryMatch[1]))
  return {
    agent: unique(roles.agent.filter(Boolean), 8),
    patient: unique(roles.patient.filter(Boolean), 8),
    source: unique(roles.source.filter(Boolean), 8),
    recipient: unique(roles.recipient.filter(Boolean), 8),
    beneficiary: unique(roles.beneficiary.filter(Boolean), 8)
  }
}

function inferObjectAndLocation(source: string, matches: ActionMatch[], actorHints: string[] = []): { object: string[]; location: string[]; result: string[] } {
  const object: string[] = []
  const location: string[] = []
  const result: string[] = []
  for (const match of matches) {
    const tail = source.slice(match.index + match.surface.length).split(/[。！？!?；;\n，,、]+/u)[0] ?? ''
    const cleanedTail = cleanEntity(tail.replace(/^(?:地|了|并|然后|随后|终于|便|就)/u, ''))
    if (match.canonical === 'arrive' && cleanedTail) {
      const locationValue = cleanEntity(cleanedTail.split(/(?:并|且|后|时|发现|找到|看见|确认)/u)[0] ?? '')
      if (locationValue) location.push(locationValue)
    } else if (match.canonical === 'handover') {
      const handover = source.match(/(?:把|将)\s*([^，,。！？!?；;\n]{1,80}?)(?:交出|交给|交到|递给|递出|转交|移交|借给|给)/u)
      // For transfer-to forms the text after the verb is normally the
      // recipient, not the object.  Only use an explicit 把/将 patient, or
      // a patient before the verb (钥匙交给沈遥).  Never turn the recipient
      // into a patient merely because it is the first visible entity.
      const transferTo = /(?:交给|交到|递给|转交|移交|借给|给予|给与)$/u.test(match.surface)
      const beforeVerb = source.slice(0, match.index).split(/[，,、]/u).at(-1)?.trim() ?? ''
      const beforePatient = cleanEntity(beforeVerb)
      const value = handover?.[1] ?? (transferTo
        ? (beforePatient && !actorHints.includes(beforePatient) ? beforeVerb : '')
        : cleanedTail)
      if (value) object.push(cleanEntity(value))
    } else if (['lend', 'take', 'steal', 'place', 'lose', 'exchange'].includes(match.canonical) && cleanedTail) {
      // 借给/借出 are transfer verbs: the immediate tail can be a recipient.
      // Reuse the same conservative patient rule as handover, while ordinary
      // directional verbs keep their direct object after the action.
      const transferTo = match.canonical === 'lend' && match.surface === '借给'
      const beforeVerb = source.slice(0, match.index).split(/[，,、]/u).at(-1)?.trim() ?? ''
      const beforePatient = cleanEntity(beforeVerb)
      const explicitPatient = source.match(/(?:把|将)\s*([^，,。！？!?；;\n]{1,80}?)\s*(?:借给|借出|借走)/u)?.[1]
      const value = explicitPatient ?? (transferTo
        ? (beforePatient && !actorHints.includes(beforePatient) ? beforeVerb : '')
        : cleanedTail)
      if (value) object.push(value)
    } else if (['discover', 'return', 'confirm', 'reveal'].includes(match.canonical) && cleanedTail) {
      const value = cleanEntity(cleanedTail)
      if (value) object.push(value)
    } else if (match.canonical === 'light' && cleanedTail) {
      const value = cleanEntity(cleanedTail)
      if (value) object.push(value)
    }
  }
  const resultMatch = source.match(/(?:结果是|结果|于是|最终|从而|导致|使得|成功(?:地)?|失败(?:地)?)[：:]?\s*([^。！？!?；;\n]{1,120})/u)
  if (resultMatch?.[1]) result.push(cleanEntity(resultMatch[1]))
  return { object: unique(object, 8), location: unique(location, 8), result: unique(result, 8) }
}

interface EventClauseRange {
  start: number
  end: number
  source: string
}

function eventClauseRanges(source: string): EventClauseRange[] {
  const ranges: EventClauseRange[] = []
  let start = 0
  const boundary = /[，,。！？!?；;\n]/gu
  for (const match of source.matchAll(boundary)) {
    const end = match.index ?? start
    const raw = source.slice(start, end)
    const leading = raw.search(/\S/u)
    const trimmedStart = leading < 0 ? end : start + leading
    const value = source.slice(trimmedStart, end).trim()
    if (value) ranges.push({ start: trimmedStart, end: trimmedStart + value.length, source: value })
    start = end + (match[0]?.length ?? 1)
  }
  const raw = source.slice(start)
  const leading = raw.search(/\S/u)
  const trimmedStart = leading < 0 ? source.length : start + leading
  const value = source.slice(trimmedStart).trim()
  if (value) ranges.push({ start: trimmedStart, end: trimmedStart + value.length, source: value })
  return ranges
}

function mergeSemanticRoles(...values: SceneBeatSemanticRoles[]): SceneBeatSemanticRoles {
  return {
    agent: unique(values.flatMap((item) => item.agent), 8),
    patient: unique(values.flatMap((item) => item.patient), 8),
    source: unique(values.flatMap((item) => item.source), 8),
    recipient: unique(values.flatMap((item) => item.recipient), 8),
    beneficiary: unique(values.flatMap((item) => item.beneficiary), 8)
  }
}

function eventGroupRoles(groups: SceneBeatEventGroup[]): SceneBeatSemanticRoles {
  return mergeSemanticRoles(...groups.map((group) => ({
    agent: group.agent,
    patient: group.patient,
    source: group.sourceRole,
    recipient: group.recipient,
    beneficiary: group.beneficiary
  })))
}

function explicitActorBeforeRange(source: string, rangeStart: number, actorHints: string[]): string[] {
  if (rangeStart <= 0 || actorHints.length === 0) return []
  const clauses = source.slice(0, rangeStart).split(/[，,。！？!?；;\n]+/u)
  for (let index = clauses.length - 1; index >= 0; index -= 1) {
    const clause = clauses[index] ?? ''
    const candidates = actorHints
      .filter((name) => name && clause.includes(name))
      .map((name) => ({ name, index: clause.indexOf(name) }))
      .sort((left, right) => left.index - right.index || right.name.length - left.name.length)
    if (candidates.length > 0) return [candidates[0]!.name]
  }
  return []
}

/**
 * Compile each predicate into a local event envelope.  A beat may be a
 * comma-linked chain, but an event's roles belong to the clause around its
 * predicate.  The previous group's subject/object is carried only for an
 * omitted-subject transfer (“取出钥匙，递给沈遥”), never guessed from the
 * first global character.
 */
function buildEventGroups(source: string, matches: ActionMatch[], actorHints: string[], idPrefix: string, initialLocation: string[] = [], initialAgents: string[] = []): SceneBeatEventGroup[] {
  if (matches.length === 0) return []
  const ranges = eventClauseRanges(source)
  const groups: SceneBeatEventGroup[] = []
  let visibleAgent: string[] = []
  const visibleLocations = new Map<string, string[]>(initialAgents.map(name => [name, initialLocation] as const))
  let visibleTime: string[] = []
  for (const range of ranges) {
    const rangeMatches = matches.filter((item) => item.index >= range.start && item.index < range.end)
    const subjectPrefix = rangeMatches[0] ? source.slice(range.start, rangeMatches[0].index) : range.source
    const subjectBoundary = subjectPrefix.search(/(?:走近|走向|走过去|走到|走进|转身|背对|伸手|站(?:在|着)?|坐(?:在|着)?)/u)
    const leadingHint = actorHints.filter(name => namedSubjectPrefix(range.source, name)).sort((a, b) => b.length - a.length)[0]
    const speechSubject = range.source.match(/^[”"」』]*([\p{Script=Han}]{2,4}|他|她)(?:说(?:道)?|问(?:道)?|答(?:道)?)$/u)?.[1]
    const visibleSubject = rangeMatches.length > 0 ? localSubject(subjectPrefix, actorHints) : leadingHint ? [leadingHint] : subjectBoundary >= 0 ? localSubject(subjectPrefix.slice(0, subjectBoundary), actorHints) : speechSubject ? [speechSubject] : []
    const pronoun = (subject: string[]) => subject.length === 1 && /^(?:他|她|他们|她们)$/u.test(subject[0]!)
    // Carry only a syntactically visible subject, never a later object/name
    // mention. An explicit different subject replaces the previous binding.
    const quotedSubject = quoteContains(source, rangeMatches[0]?.index ?? range.start)
    if (!quotedSubject && visibleSubject.length > 0 && !pronoun(visibleSubject) && !/^(?:门|窗|抽屉|柜门|柜|盖)$/u.test(visibleSubject[0]!)) visibleAgent = visibleSubject
    if (/(?:离开|抵达|到达|进入|走进|前往)/u.test(range.source) && !quoteContains(source, range.start)) for (const name of visibleAgent) visibleLocations.delete(name)
    const leadingTime = inferTime(range.source)
    if (/^(?:在|于|当|直到)?(?:\d{1,2}[:：]\d{2}|[零〇一二两三四五六七八九十]{1,3}(?:点|时)|清晨|黎明|夜里|第二天|翌日|当天)/u.test(range.source)) visibleTime = leadingTime
    for (let index = 0; index < rangeMatches.length; index += 1) {
      const match = rangeMatches[index]!
      // Split a punctuation-free chain at predicate boundaries as well.  This
      // keeps “取出钥匙递给沈遥” from making the first verb consume the
      // recipient tail, while comma/period clauses still retain their local
      // source text and carry omitted subjects forward.
      const rawStart = index === 0 ? range.start : rangeMatches[index - 1]!.index + rangeMatches[index - 1]!.surface.length
      const rawEnd = index + 1 < rangeMatches.length ? rangeMatches[index + 1]!.index : range.end
      const rawSource = source.slice(rawStart, rawEnd)
      const leading = rawSource.search(/\S/u)
      const localStart = leading < 0 ? rawStart : rawStart + leading
      const localSource = source.slice(localStart, rawEnd).trim()
      if (!localSource) continue
      const localMatches = [{ ...match, index: Math.max(0, match.index - localStart) }]
      const previous = groups.at(-1)
      const physical = localActionBound(match.canonical, localSource) ? localPhysicalParts(localSource, localMatches[0]!, actorHints, previous, visibleAgent) : null
      const roles = physical?.roles ?? inferSemanticRoles(localSource, actorHints, localMatches)
      const parts = physical ? { object: physical.object, location: physical.location, result: [] } : inferObjectAndLocation(localSource, localMatches, actorHints)
      const localIndex = Math.max(0, match.index - localStart)
      const localMatch = { canonical: match.canonical, surface: match.surface, index: localIndex }
      const localPatient = unique([...roles.patient, ...parts.object], 8)
      const transfer = DIRECTIONAL_ACTIONS.has(match.canonical)
      const omittedSubjectPrefix = /^(?:然后|随后|接着|再|并|又|便|就|于是|同时|随即|最终|终于)/u.test(localSource) ||
        BEAT_ACTIONS.some((action) => action.forms.some((form) => localSource.startsWith(form))) ||
        (transfer && previous?.patient.some((item) => localSource.startsWith(item)) === true)
      const predicatePrefix = source.slice(range.start, match.index)
      const subjectCarryingConnector = /(?:之后|以后|过后|随后|然后|接着|便|就|才|却|但是|但|然而|不过|可是|于是|因此|同时|后(?=\s*(?:把|将|便|就|又|再|仍|才|开始|继续|随后|然后|接着))|并且|并|而|又|再)/u.test(predicatePrefix)
      const patientLeadingTransfer = transfer && previous?.patient.some((item) => localSource.startsWith(item)) === true
      const continuationLead = /^(?:随后|然后|接着|随即|并且|并|而|又|再|便|就|才|却|但是|但|然而|不过|可是|于是|因此|同时)/u.test(localSource)
      const localPrefix = localSource.slice(0, localIndex)
      // An adjacent chain can lead with the last patient, not a new actor:
      // “取出记录簿翻到某页后合上”. Only that exact local patient and an
      // optional sequence marker may carry the prior subject across here.
      const patientLeadingContinuation = previous?.object.some(item => localPrefix === item || localPrefix === `${item}后`) === true &&
        previous.agent.length === 1 && !actorHints.some(name => namedSubjectPrefix(localPrefix, name))
      const rolePrefix = localPrefix.replace(/(?:把|将)\s*$/u, '').trim()
      const hasKnownLocalActor = actorHints.some((name) => name && rolePrefix.includes(name))
      // The local prefix includes the object between “把/将” and the
      // predicate, so a connector is not necessarily its final token
      // (例如“没有追兵后把钥匙交给”).  Look for a connector in the subject
      // slot while still requiring an omitted/previously known subject.
      const temporalContinuation = /(?:之后|以后|过后|随后|然后|接着|便|就|才|后(?=\s*(?:把|将|便|就|又|再|仍|才|开始|继续|随后|然后|接着)))\s*(?:把|将)?/u.test(rolePrefix)
      const coordinatedContinuation = /(?:却|但是|但|然而|不过|可是)\s*(?:把|将)?/u.test(rolePrefix) &&
        (roles.agent.length === 0 || roles.agent.some((agent) => previous?.recipient.includes(agent) || previous?.patient.includes(agent)))
      const carriedAgent = previous?.agent.length
        ? previous.agent
        : /^(?:转动|拧动)(?:之后|以后|后)$/u.test(localPrefix)
          ? visibleAgent
        : continuationLead
          ? explicitActorBeforeRange(source, range.start, actorHints)
          : []
      // An explicit subject in this local clause wins over a carried subject
      // from the previous event.  Only an omitted-subject continuation such
      // as “取出钥匙，递给沈遥” may inherit the previous agent.  This keeps
      // “卫川却把……” from being attributed to the preceding 林舟 event.
      const legacyAgent = patientLeadingContinuation ? previous!.agent : /^(?:转动|拧动)(?:之后|以后|后)$/u.test(localPrefix)
        ? visibleAgent.length === 1 ? visibleAgent : []
        : patientLeadingTransfer || ((temporalContinuation || coordinatedContinuation) && !hasKnownLocalActor)
        ? carriedAgent
        : roles.agent.length > 0
          ? roles.agent
          : subjectCarryingConnector || omittedSubjectPrefix
            ? carriedAgent
            : []
      const resolvedVisibleAgent = visibleAgent.length === 1 ? visibleAgent : []
      const agent = patientLeadingContinuation ? previous!.agent : physical ? roles.agent.length === 0 || pronoun(roles.agent) ? resolvedVisibleAgent : roles.agent : pronoun(legacyAgent) ? resolvedVisibleAgent : legacyAgent
      const recipient = roles.recipient
      const omittedPhysicalPatient = physical && localPatient.length === 0 && ['place', 'flip', 'close'].includes(match.canonical) &&
        previous?.agent.length === agent.length && agent.length > 0 && agent.every(name => previous?.agent.includes(name) === true) &&
        (index > 0 || omittedSubjectPrefix)
      const pageTurn = match.surface === '翻到' && previous?.patient.length &&
        previous.agent.length === agent.length && agent.length > 0 && agent.every(name => previous.agent.includes(name)) &&
        (patientLeadingContinuation || omittedSubjectPrefix)
      const patient = pageTurn ? previous!.patient : localPatient.length > 0
        ? localPatient
        : omittedPhysicalPatient || transfer && recipient.length > 0
          ? (previous?.patient ?? [])
        : []
      const object = unique([...patient, ...parts.object], 8)
      const actualityAssessment = classifyActuality(source, match, range.start, range.end, source, match.index, actorHints, physical !== null || ['discover', 'confirm'].includes(match.canonical))
      const actuality = actualityAssessment.actuality
      if (physical && agent.length > 0 && !pronoun(agent) && actuality === 'asserted_actual' && actualityAssessment.scope.confidence === 'high') visibleAgent = agent
      if (actuality === 'asserted_actual' && actualityAssessment.scope.confidence === 'high' && parts.location.length > 0 &&
          (physical && !['stow', 'place'].includes(match.canonical) || match.canonical === 'arrive')) for (const name of agent) visibleLocations.set(name, parts.location)
      const visibleLocation = agent.length === 1 ? visibleLocations.get(agent[0]!) ?? [] : []
      groups.push({
        eventId: `${idPrefix}:event:${groups.length + 1}`,
        source: localSource,
        action: match.canonical,
        surface: match.surface,
        start: localStart,
        end: rawEnd,
        actor: unique(agent, 8),
        agent: unique(agent, 8),
        patient,
        sourceRole: roles.source,
        recipient,
        beneficiary: roles.beneficiary,
        object,
        location: physical ? match.canonical === 'place' ? unique([...visibleLocation, ...parts.location], 8) : parts.location.length > 0 ? parts.location : visibleLocation : parts.location,
        result: parts.result,
        time: physical ? unique([...visibleTime, ...inferTime(localSource)], 8) : inferTime(localSource),
        negation: actuality === 'negated' || (match.canonical !== 'confirm' && detectNegation(localSource, localMatch)),
        modality: actualityModality(actuality),
        actuality,
        assertion: actualityAssertion(actuality),
        predicateSpan: { start: match.index, end: match.index + match.surface.length, text: match.surface },
        cueSpans: actualityAssessment.cues,
        scope: actualityAssessment.scope
      })
    }
  }
  return groups
}

function inferTime(source: string): string[] {
  const values: string[] = []
  const patterns = [
    /(?:此前|此时|当天|第二天|翌日|夜里|清晨|黎明|风暴前|下个月|那天)/gu,
    /(?:之后|以前|之前|过后|此后)/gu
  ]
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[0]) values.push(cleanText(match[0], 80))
  for (const match of source.matchAll(/(?<!\d)([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)/gu)) values.push(`${Number(match[1])}:${match[2]}`)
  const digit = (part: string): number => {
    if (part === '两') return 2
    const digits = '零一二三四五六七八九'
    if (!part.includes('十')) return digits.indexOf(part === '〇' ? '零' : part)
    const [tens, ones] = part.split('十')
    return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0)
  }
  for (const match of source.matchAll(/([零〇一二两三四五六七八九十]{1,3})(?:点|时)(?:整|([零〇一二两三四五六七八九十]{1,3})分)?/gu)) {
    const hour = digit(match[1]!), minute = match[2] ? digit(match[2]) : 0
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) values.push(`${hour}:${String(minute).padStart(2, '0')}`)
  }
  return unique(values, 8)
}

function buildBeatRequirement(source: string, beatId: string, actorHints: string[]): SceneBeatRequirement {
  const text = cleanText(source, 500)
  const matches = actionMatches(text)
  const eventGroups = buildEventGroups(text, matches, actorHints, beatId)
  // Once an event group exists, its local parse is the source of truth.  The
  // whole-sentence fallback is retained only for legacy/actionless beats; it
  // would otherwise re-attach a later recipient tail to an earlier predicate
  // in a punctuation-free chain.
  const roles = eventGroups.length > 0
    ? eventGroupRoles(eventGroups)
    : inferSemanticRoles(text, actorHints, matches)
  const parts = eventGroups.length > 0
    ? {
      object: unique(eventGroups.flatMap((group) => group.object), 8),
      location: unique(eventGroups.flatMap((group) => group.location), 8),
      result: unique(eventGroups.flatMap((group) => group.result), 8)
    }
    : inferObjectAndLocation(text, matches, actorHints)
  const eventActualities = [...new Set(eventGroups.map((group) => group.actuality))]
  const actuality = eventActualities.length === 1
    ? eventActualities[0]!
    : eventActualities.length > 1
      ? 'unknown'
      : classifyActuality(text, matches[0], 0, text.length, text, matches[0]?.index, actorHints).actuality
  const assertion = actualityAssertion(actuality)
  const modality = actualityModality(actuality)
  const negation = eventGroups.length > 0 ? eventGroups.some(group => group.negation) : actuality === 'negated' || detectNegation(text, matches[0])
  return {
    beatId,
    source: text,
    actor: roles.agent,
    action: unique(matches.map((item) => item.canonical), 8),
    object: unique([...roles.patient, ...parts.object], 8),
    location: parts.location,
    result: parts.result,
    time: inferTime(text),
    negation,
    modality,
    actuality,
    assertion,
    agent: roles.agent,
    patient: unique([...roles.patient, ...parts.object], 8),
    sourceRole: roles.source,
    recipient: roles.recipient,
    beneficiary: roles.beneficiary,
    eventGroups
  }
}

function requirementFor(contract: SceneContract, index: number, beat: string): SceneBeatRequirement {
  return contract.requiredBeatEvidence?.[index] ?? buildBeatRequirement(beat, contract.requiredBeatIds[index] ?? `${contract.sceneId}:beat:${index + 1}`, contract.activeCharacterIds)
}

function eventGroupValid(value: unknown): value is SceneBeatEventGroup {
  if (!value || typeof value !== 'object') return false
  const item = value as SceneBeatEventGroup
  if (typeof item.eventId !== 'string' || !item.eventId || typeof item.source !== 'string' || typeof item.action !== 'string' || typeof item.surface !== 'string' || !Number.isInteger(item.start) || !Number.isInteger(item.end) || item.start < 0 || item.end < item.start) return false
  if (!['actual', 'reported', 'hypothetical', 'dream', 'memory', 'planned', 'unknown'].includes(item.modality) || typeof item.negation !== 'boolean') return false
  // Legacy pre-v1.2.4 groups did not carry predicate-local actuality.  They
  // remain readable, but every newly compiled group must carry both fields;
  // callers treat an absent legacy value as unknown rather than trusting it
  // for a current-state mutation.
  if (item.actuality !== undefined && !SCENE_BEAT_ACTUALITIES.includes(item.actuality)) return false
  if (item.assertion !== undefined && !SCENE_BEAT_ASSERTIONS.includes(item.assertion)) return false
  if (item.predicateSpan !== undefined && (!item.predicateSpan || !Number.isInteger(item.predicateSpan.start) || !Number.isInteger(item.predicateSpan.end) || item.predicateSpan.start < 0 || item.predicateSpan.end < item.predicateSpan.start || typeof item.predicateSpan.text !== 'string')) return false
  if (item.cueSpans !== undefined && (!Array.isArray(item.cueSpans) || item.cueSpans.some((cue) =>
    !cue || typeof cue !== 'object' || typeof cue.text !== 'string' ||
    !Number.isInteger(cue.start) || !Number.isInteger(cue.end) || !Number.isInteger(cue.scopeStart) || !Number.isInteger(cue.scopeEnd) ||
    cue.start < 0 || cue.end < cue.start || cue.scopeStart < 0 || cue.scopeEnd < cue.scopeStart ||
    !['governs', 'outside', 'ambiguous'].includes(cue.relation) || typeof cue.rationale !== 'string' ||
    !SCENE_BEAT_ACTUALITIES.includes(cue.actuality)))) return false
  if (item.scope !== undefined && (!item.scope || !Number.isInteger(item.scope.start) || !Number.isInteger(item.scope.end) || item.scope.start < 0 || item.scope.end < item.scope.start || !['high', 'uncertain'].includes(item.scope.confidence) || typeof item.scope.rationale !== 'string')) return false
  const arrays = [item.actor, item.agent, item.patient, item.sourceRole, item.recipient, item.beneficiary, item.object, item.location, item.result, item.time]
  return arrays.every((items) => Array.isArray(items) && items.every((part) => typeof part === 'string'))
}

function actionCovered(candidate: string, required: string): boolean {
  const matches = actionMatches(candidate)
  return matches.some((item) => item.canonical === required)
}

function actorCovered(candidate: string, required: string): boolean {
  if (GROUP_ACTORS.includes(required)) return GROUP_ACTORS.some((item) => candidate.includes(item)) || /他们|她们|二人|两人|两个人|双方/u.test(candidate)
  return entityCovered(candidate, required)
}

function eventGroupFieldCovered(candidate: string[], required: string[]): boolean {
  return required.every((value) => candidate.some((item) => entityCovered(item, value)))
}

function eventGroupActuality(group: SceneBeatEventGroup): SceneBeatActuality {
  // A missing value is only possible in a legacy snapshot.  It is not
  // evidence of a completed real-world event, so use unknown for safety.
  return group.actuality ?? 'unknown'
}

function eventGroupSemanticFieldsCovered(required: SceneBeatEventGroup, candidate: SceneBeatEventGroup): boolean {
  return eventGroupFieldCovered(candidate.agent, required.agent) &&
    eventGroupFieldCovered(candidate.patient, required.patient) &&
    eventGroupFieldCovered(candidate.sourceRole, required.sourceRole) &&
    eventGroupFieldCovered(candidate.recipient, required.recipient) &&
    eventGroupFieldCovered(candidate.beneficiary, required.beneficiary)
}

function eventGroupBindingCovered(required: SceneBeatEventGroup, candidates: SceneBeatEventGroup[]): boolean {
  const bound = candidates
    .filter((candidate) => candidate.action === required.action)
    .filter((candidate) =>
      eventGroupActuality(candidate) === eventGroupActuality(required) &&
      (candidate.scope?.confidence ?? (eventGroupActuality(candidate) === 'unknown' ? 'uncertain' : 'high')) === 'high' &&
      (candidate.assertion ?? actualityAssertion(eventGroupActuality(candidate))) === (required.assertion ?? actualityAssertion(eventGroupActuality(required))))
  if (bound.some(candidate => eventGroupSemanticFieldsCovered(required, candidate))) return true
  // An optical sweep can reach coordinated targets in adjacent clauses.
  // Each target must still be an actual event of the same named subject,
  // same proven local frame, and same instrument; no global noun pooling.
  if (required.action !== 'illuminate' || required.patient.length < 2 || !required.agent.length) return false
  const prefix = required.source.slice(0, required.source.indexOf(required.surface))
  const instrument = prefix.match(/用(.{1,40})$/u)?.[1] ?? prefix.match(/(?:手电筒(?:的)?)?(?:光束|光柱)/u)?.[0]
  const fixed = required.patient.filter(patient => instrument && entityCovered(patient, instrument))
  return bound.some(frame => frame.location.length > 0 && required.patient.every(patient => bound.some(candidate =>
    eventGroupSemanticFieldsCovered({ ...required, patient: unique([patient, ...fixed], 8) }, candidate) &&
    eventGroupFieldCovered(candidate.location, required.location) && eventGroupFieldCovered(candidate.time, required.time) &&
    eventGroupFieldCovered(candidate.location, frame.location) && eventGroupFieldCovered(frame.location, candidate.location) &&
    eventGroupFieldCovered(candidate.time, frame.time) && eventGroupFieldCovered(frame.time, candidate.time))))
}

function roleEvidenceText(requirement: SceneBeatRequirement, candidate: string): string {
  if (isOpaqueSceneBeatRequirement(requirement)) return ''
  const sentences = candidate.split(/[。！？!?；;\n]+/u).map((item) => item.trim()).filter(Boolean)
  for (const sentence of sentences) {
    const parts = sentence.split(/[，,、]/u).map((item) => item.trim()).filter(Boolean)
    const index = parts.findIndex((part) => requirement.action.some((action) => actionMatches(part).some((match) => match.canonical === action)))
    if (index >= 0) return parts.slice(Math.max(0, index - 1), index + 1).join('')
  }
  return candidate
}

/** Incidental actor/time tokens do not make an unrecognised beat an event. */
export function isOpaqueSceneBeatRequirement(requirement: Pick<SceneBeatRequirement, 'action' | 'eventGroups'>): boolean {
  return requirement.action.length === 0 && (requirement.eventGroups ?? []).length === 0
}

function modalityConflict(
  requirement: SceneBeatRequirement,
  candidate: string,
  action: { index: number } | undefined,
  candidateGroups: SceneBeatEventGroup[] = []
): { modality: SceneBeatModality; actuality: SceneBeatActuality; assertion: SceneBeatAssertion; negation: boolean; conflict: boolean } {
  const requiredGroups = requirement.eventGroups ?? []
  // An opaque/static/compound beat has no predicate to which a prose cue can
  // be bound. Whole-document negation or uncertainty is not proof that this
  // beat was contradicted. It stays missing (and needs semantic review), not
  // satisfied; bound event, polarity and forbidden-fact gates remain intact.
  if (isOpaqueSceneBeatRequirement(requirement)) {
    return { modality: 'unknown', actuality: 'unknown', assertion: 'unknown', negation: false, conflict: false }
  }
  // Prefer the candidate event group bound to the requirement's own semantic
  // roles.  Falling back to the first relevant group is only for a legacy or
  // otherwise under-specified requirement; never let an unrelated event in a
  // multi-event sentence decide this beat's actuality.
  const localGroup = candidateGroups.find((candidateGroup) => requiredGroups.some((requiredGroup) =>
    eventGroupBindingCovered(requiredGroup, [candidateGroup]))) ??
    candidateGroups.find((candidateGroup) => requiredGroups.some((requiredGroup) =>
      requiredGroup.action === candidateGroup.action && eventGroupSemanticFieldsCovered(requiredGroup, candidateGroup))) ??
    candidateGroups[0]
  const actuality = localGroup ? eventGroupActuality(localGroup) : detectActuality(candidate, action)
  const modality = actualityModality(actuality)
  const negation = localGroup?.negation ?? detectNegation(candidate, action)
  const requiredActuality = requirement.actuality ?? (requirement.modality === 'actual' ? 'asserted_actual' : 'unknown')
  // Requirements authored as actual events must not be satisfied by a
  // statement about a dream, rumour, hypothetical, recollection, plan, or
  // speech/attempt act.  Compare the predicate-local value, not just a
  // sentence-level modality cue.
  const conflict = requiredGroups.length > 0
    ? requiredGroups.some((requiredGroup) => {
      const semanticallyBound = candidateGroups
        .filter((candidateGroup) => candidateGroup.action === requiredGroup.action)
        .filter((candidateGroup) => eventGroupSemanticFieldsCovered(requiredGroup, candidateGroup))
      // Missing/ambiguous role binding is handled by the dedicated uncertain
      // path.  If a local group is bound, however, its actuality must match
      // exactly; an actual contract cannot borrow a positive event elsewhere
      // in the sentence.
      return semanticallyBound.length > 0 && !semanticallyBound.some((candidateGroup) => eventGroupBindingCovered(requiredGroup, [candidateGroup]))
    })
    : requiredActuality === 'asserted_actual'
      ? actuality !== 'asserted_actual' || negation !== requirement.negation
      : actuality !== requiredActuality || negation !== requirement.negation
  return { modality, actuality, assertion: actualityAssertion(actuality), negation, conflict }
}

function deterministicBeatEvidence(requirement: SceneBeatRequirement, candidate: string, scenePrefixHash: string, context: { actorHints?: string[]; initialLocation?: string[]; initialAgents?: string[] } = {}): SceneBeatEvaluationEvidence {
  const actionMatchesInCandidate = actionMatches(candidate)
  const roleText = roleEvidenceText(requirement, candidate)
  const roleMatches = actionMatches(roleText)
  // Only agent/actor hints are used to resolve an omitted subject.  Recipient
  // names are still extracted from the transfer complement, but treating them
  // as actor hints makes “沈遥却把……” look like an explicit 林舟 action.
  const roleHints = unique([...(requirement.agent ?? requirement.actor), ...(context.actorHints ?? [])], 16)
  // Evaluate every local event group that corresponds to this beat instead of
  // keeping only the first comma-separated clause.  This is what preserves
  // recipient/object evidence in “取出钥匙，递给沈遥”.
  const candidateGroups = buildEventGroups(candidate, actionMatchesInCandidate, roleHints, 'candidate', context.initialLocation, context.initialAgents)
  const relevantCandidateGroups = candidateGroups.filter((group) => requirement.action.includes(group.action))
  const requiredGroups = requirement.eventGroups ?? []
  const eventGroupBindingConflict = requiredGroups.some((group) =>
    DIRECTIONAL_ACTIONS.has(group.action) &&
    (group.agent.length > 0 || group.patient.length > 0 || group.sourceRole.length > 0 || group.recipient.length > 0 || group.beneficiary.length > 0) &&
    !eventGroupBindingCovered(group, relevantCandidateGroups)
  )
  // A candidate may contain every lexical role and still describe a request,
  // refusal, quote, attempt, or other non-actual event.  Such a candidate is
  // a contradiction for an asserted-actual requirement, not an uncertain
  // role binding.  Keep the check event-group local so a real event elsewhere
  // in the same sentence can satisfy its own group.
  const eventGroupActualityConflict = requiredGroups.some((group) => {
    const sameAction = relevantCandidateGroups
      .filter((candidateGroup) => candidateGroup.action === group.action)
      .filter((candidateGroup) => eventGroupSemanticFieldsCovered(group, candidateGroup))
    if (sameAction.length === 0) return false
    return !sameAction.some((candidateGroup) => eventGroupBindingCovered(group, [candidateGroup]))
  })
  const eventGroupScopeUncertain = requiredGroups.some((group) => relevantCandidateGroups
    .filter((candidateGroup) => candidateGroup.action === group.action)
    .filter((candidateGroup) => eventGroupSemanticFieldsCovered(group, candidateGroup))
    .some((candidateGroup) => eventGroupActuality(candidateGroup) === 'unknown' || candidateGroup.scope?.confidence === 'uncertain'))
  const candidateRoles = mergeSemanticRoles(
    eventGroupRoles(relevantCandidateGroups),
    inferSemanticRoles(roleText, roleHints, roleMatches)
  )
  const requiredAgent = requirement.agent ?? requirement.actor
  const requiredPatient = requirement.patient ?? requirement.object
  const requiredSource = requirement.sourceRole ?? []
  const requiredRecipient = requirement.recipient ?? []
  const requiredBeneficiary = requirement.beneficiary ?? []
  const directional = requirement.action.some((action) => DIRECTIONAL_ACTIONS.has(action))
  const matchedAction = requirement.action.filter((action) => actionCovered(candidate, action))
  const matchedActor = requirement.actor.filter((actor) => actorCovered(candidate, actor))
  const matchedObject = requirement.object.filter((object) => entityCovered(candidate, object) || relevantCandidateGroups.some(group => group.object.some(item => entityCovered(item, object))))
  const matchedLocation = requirement.location.filter((location) => entityCovered(candidate, location))
  const matchedResult = requirement.result.filter((result) => entityCovered(candidate, result))
  const candidateTimes = inferTime(candidate)
  const matchedTime = requirement.time.filter((time) => candidateTimes.includes(time) || entityCovered(candidate, time))
  const matchedAgent = requiredAgent.length > 0
    ? requiredAgent.filter((agent) => candidateRoles.agent.some((item) => entityCovered(item, agent)))
    : candidateRoles.agent
  const matchedPatient = requiredPatient.length > 0
    ? requiredPatient.filter((patient) => directional
      ? candidateRoles.patient.some((item) => entityCovered(item, patient))
      : candidateRoles.patient.some((item) => entityCovered(item, patient)) || entityCovered(candidate, patient))
    : candidateRoles.patient
  const matchedSource = requiredSource.length > 0
    ? requiredSource.filter((source) => candidateRoles.source.some((item) => entityCovered(item, source)))
    : candidateRoles.source
  const matchedRecipient = requiredRecipient.length > 0
    ? requiredRecipient.filter((recipient) => candidateRoles.recipient.some((item) => entityCovered(item, recipient)))
    : candidateRoles.recipient
  const matchedBeneficiary = requiredBeneficiary.length > 0
    ? requiredBeneficiary.filter((beneficiary) => candidateRoles.beneficiary.some((item) => entityCovered(item, beneficiary)))
    : candidateRoles.beneficiary
  const firstRelevantAction = actionMatchesInCandidate.find((item) => requirement.action.includes(item.canonical))
  const modality = modalityConflict(requirement, candidate, firstRelevantAction, relevantCandidateGroups)
  const relevantActions = actionMatchesInCandidate.filter((item) => requirement.action.includes(item.canonical))
  const relevantNegated = relevantActions.filter((item) => detectNegation(candidate, item))
  // A multi-action beat is only actual when every required action has at least
  // one occurrence with the requested polarity.  This prevents
  // “抵达灯塔，但没有发现密信” from satisfying the whole beat merely because
  // the first verb was positive.
  const actionPolarityConflict = requirement.action.some((requiredAction) => {
    const groups = relevantCandidateGroups.filter((item) => item.action === requiredAction)
    if (groups.length > 0) {
      return requirement.negation
        ? !groups.some((item) => item.negation)
        : !groups.some((item) => !item.negation)
    }
    const occurrences = relevantActions.filter((item) => item.canonical === requiredAction)
    if (occurrences.length === 0) return false
    return requirement.negation
      ? !occurrences.some((item) => detectNegation(candidate, item))
      : !occurrences.some((item) => !detectNegation(candidate, item))
  })
  const inferred: string[] = []

  // Presence in a requested location plus an explicit discovery/handover is
  // observable evidence that the actor arrived, even when prose does not
  // repeat the outline's “抵达” verb.  This is the narrow semantic bridge
  // needed for natural Chinese rewrites such as “从塔窗里抽出那封信”.
  if (requirement.action.includes('arrive') && !matchedAction.includes('arrive') && matchedLocation.length > 0 && matchedActor.length > 0 && matchedAction.some((item) => item !== 'arrive')) {
    matchedAction.push('arrive')
    inferred.push('arrive_from_presence')
  }

  const requiredFields = [
    matchedActor.length >= requirement.actor.length,
    matchedAction.length >= requirement.action.length,
    matchedObject.length >= requirement.object.length,
    matchedLocation.length >= requirement.location.length,
    matchedResult.length >= requirement.result.length,
    matchedTime.length >= requirement.time.length
  ]
  const roleRequirementsSatisfied = (!directional || matchedAgent.length > 0) &&
    (requiredPatient.length === 0 || matchedPatient.length >= requiredPatient.length) &&
    (requiredSource.length === 0 || matchedSource.length >= requiredSource.length) &&
    (requiredRecipient.length === 0 || matchedRecipient.length >= requiredRecipient.length) &&
    (requiredBeneficiary.length === 0 || matchedBeneficiary.length >= requiredBeneficiary.length)
  // An unrecognised authored beat has no deterministic event anchor.  Treat it
  // as unresolved so a structured model evidence record (or a user decision)
  // is required; an empty set must never become vacuously “satisfied”.
  const physicalGroupsBound = requiredGroups.filter(group => localActionBound(group.action, group.source) || group.action === 'discover').every(group =>
    group.agent.length > 0 && (group.patient.length > 0 || group.action === 'mutual_gaze' && (group.agent.length > 1 || group.agent.some(agent => GROUP_ACTORS.includes(agent)))) &&
    eventGroupBindingCovered(group, relevantCandidateGroups.filter(candidateGroup =>
      group.agent.every(agent => candidateGroup.agent.includes(agent)) &&
      eventGroupFieldCovered(candidateGroup.location, group.location) && eventGroupFieldCovered(candidateGroup.time, group.time))))
  const fieldsSatisfied = requirement.action.length > 0 && requiredFields.every(Boolean) && roleRequirementsSatisfied && physicalGroupsBound
  let status: SceneBeatEvidenceStatus = fieldsSatisfied ? 'satisfied' : 'missing'
  // A bare directional predicate can match its equally under-specified
  // outline group vacuously. The event is present, but its agent is still
  // unknown; keep that distinction from an event that has not been narrated.
  const directionalAgentUncertain = requiredGroups.some(group => DIRECTIONAL_ACTIONS.has(group.action) && group.agent.length === 0 &&
    group.actuality === 'asserted_actual' && group.assertion === 'asserted' && !group.negation &&
    (group.patient.length > 0 || group.sourceRole.length > 0 || group.recipient.length > 0 || group.beneficiary.length > 0) &&
    relevantCandidateGroups.some(candidateGroup => candidateGroup.action === group.action && candidateGroup.agent.length === 0 && eventGroupSemanticFieldsCovered(group, candidateGroup)))
  // In a compound beat, a missing non-directional patient's evidence (例如
  // 看档案柜) is not an unresolved transfer of the already-bound 听筒. Once
  // event groups exist, directional uncertainty belongs to their local roles.
  if ((directional && requiredGroups.length === 0 && !roleRequirementsSatisfied || directionalAgentUncertain || eventGroupBindingConflict) && (matchedAction.length > 0 || matchedObject.length > 0 || matchedAgent.length > 0 || matchedPatient.length > 0 || matchedRecipient.length > 0)) status = 'uncertain'
  if ((modality.conflict || actionPolarityConflict || eventGroupActualityConflict) && (matchedAction.length > 0 || matchedActor.length > 0 || matchedObject.length > 0 || matchedLocation.length > 0)) {
    status = eventGroupScopeUncertain ? 'uncertain' : 'contradicted'
  }
  return {
    beatId: requirement.beatId,
    status,
    source: 'deterministic',
    scenePrefixHash,
    matched: {
      actor: matchedActor,
      action: matchedAction,
      object: matchedObject,
      location: matchedLocation,
      result: matchedResult,
      time: matchedTime,
      agent: matchedAgent,
      patient: matchedPatient,
      sourceRole: matchedSource,
      recipient: matchedRecipient,
      beneficiary: matchedBeneficiary
    },
    modality: modality.modality,
    actuality: modality.actuality,
    assertion: modality.assertion,
    negation: modality.negation || relevantNegated.length > 0,
    inferred,
    eventGroups: relevantCandidateGroups
  }
}

interface SceneContractBuildEntry {
  section: GrillMeOutlineSection
  scene?: GrillMeOutlineScene
}

function makeContract(input: {
  section: GrillMeOutlineSection
  scene?: GrillMeOutlineScene
  previous?: SceneContractBuildEntry
  next?: SceneContractBuildEntry
  index: number
  outline: GrillMeOutline
  outlineHash: string
  outlineRevision: number
  answers: Map<string, string>
  characterNames: string[]
  forbiddenTerms: string[]
  mustKeep: string[]
}): SceneContract {
  const { section, scene, index, outlineHash, outlineRevision, answers, characterNames, forbiddenTerms, mustKeep } = input
  const semantic = scene ?? section
  const sectionId = section.id
  const sceneId = scene ? `scene:${section.id}:${scene.id}` : `scene:${section.id}`
  const allCharacters = unique([...characterNames, ...participantNames(answers.get('characters') ?? '')], 12)
  const mentionedCharacters = allCharacters.filter((name) => sceneText(semantic).includes(name))
  // Do not invent scene participants or POV from the global character list.
  // An empty list is meaningful: the confirmed outline did not identify them.
  const activeCharacterIds = mentionedCharacters
  const mustHappen = unique(semantic.beats.length > 0 ? semantic.beats : [semantic.purpose], 20)
  const mustNotHappen = unique([...negativeClauses(answers.get('scope') ?? ''), ...forbiddenTerms], 20)
  const requiredBeatIds = mustHappen.map((_beat, beatIndex) => `${sceneId}:beat:${beatIndex + 1}`)
  const localActors = unique([...activeCharacterIds, ...mustHappen.flatMap(beat => eventClauseRanges(beat).flatMap(range => {
    const match = actionMatches(range.source)[0]
    // A short static clause is not a character declaration (“光仍亮着”).
    // Learn local names only from a visible predicate or subject boundary.
    if (!match && !LOCAL_SUBJECT_BOUNDARY.test(range.source)) return []
    const actors = localSubject(match ? range.source.slice(0, match.index) : range.source)
    return actors.filter(actor => !/^(?:他|她|两人|二人|光柱|光束)$/u.test(actor) && range.source.startsWith(actor))
  }))], 16)
  const requiredBeatEvidence = mustHappen.map((beat, beatIndex) => buildBeatRequirement(beat, requiredBeatIds[beatIndex]!, localActors))
  const requiredFactIds = unique(semantic.sourceSlotIds ?? [], 32)
  const forbiddenFactIds = mustNotHappen.map((_fact, factIndex) => `${sceneId}:forbidden:${factIndex + 1}`)
  const previous = input.previous
  const next = input.next
  const conflict = cleanText(answers.get('conflict') || semantic.purpose || '当前场景中的阻碍')
  const desire = cleanText(answers.get('goal') || semantic.purpose || '推动当前场景目标')
  // A location/POV is only included when the scene itself explicitly names it;
  // a global setting or first character is not evidence for this scene.
  const location = scene?.locationId?.trim() || ''
  const handoff = next
    ? `承接下一场“${cleanText(next.scene?.title ?? next.section.title, 160)}”：${cleanText(next.scene?.purpose ?? next.section.purpose, 500)}`
    : cleanText(answers.get('ending') || '为全文收束留下可追踪的结果')
  const sourceIds = unique(requiredFactIds, 32)
  const expectedStateChanges: SceneContractStateChange[] = [
    { key: `${sceneId}:objective`, description: `完成本场目标：${cleanText(semantic.purpose)}` },
    { key: `${sceneId}:handoff`, description: handoff }
  ]
  const acceptanceCriteria = [
    ...mustHappen.map((beat) => `正文提供可观察证据：${cleanText(beat, 500)}`),
    `正文结束后能承接：${handoff}`
  ]
  const base: Omit<SceneContract, 'frozenHash'> = {
    schemaVersion: SCENE_CONTRACT_SCHEMA_VERSION,
    contractId: `${outlineHash.slice(0, 16)}:${sceneId}:r${outlineRevision}`,
    sceneId,
    sectionId,
    revision: outlineRevision,
    order: index + 1,
    title: cleanText(semantic.title, 240),
    objective: cleanText(semantic.purpose),
    activeCharacterIds,
    characterIds: [...activeCharacterIds],
    ...(scene?.povCharacterId ? { povCharacterId: cleanText(scene.povCharacterId, 120) } : {}),
    ...(location ? { locationId: cleanText(location, 240) } : {}),
    desire,
    obstacle: conflict,
    conflict,
    expectedTurn: cleanText(mustHappen.at(-1) || semantic.purpose, 500),
    reveal: cleanText(mustHappen.at(-1) || '', 500) || undefined,
    requiredBeatIds,
    requiredFactIds,
    forbiddenFactIds,
    mustHappen,
    mustNotHappen,
    handoff,
    // A section owns its thread.  A scene from a different section must not
    // make this thread look as if it had already advanced; only adjacent
    // entries in the same section share lifecycle state.  A one-scene thread
    // emits both open and close so the lifecycle is complete instead of
    // leaving a durable thread dangling forever.
    threadActions: (() => {
      const threadId = `thread:${section.id}`
      const samePreviousThread = previous?.section.id === section.id
      const sameNextThread = next?.section.id === section.id
      if (!samePreviousThread && !sameNextThread) return [{ threadId, action: 'open' as const }, { threadId, action: 'close' as const }]
      if (!samePreviousThread) return [{ threadId, action: 'open' as const }]
      if (!sameNextThread) return [{ threadId, action: 'close' as const }]
      return [{ threadId, action: 'advance' as const }]
    })(),
    requiredBeatEvidence,
    expectedStateChanges,
    targetChars: targetFor(semantic.targetChars),
    acceptanceCriteria,
    sourceIds,
    outlineHash
  }
  // Global confirmed facts remain visible in the scene contract as advisory
  // acceptance evidence; the strong-constraint gate remains authoritative for
  // hard whole-manuscript preservation checks.
  if (mustKeep.length > 0) {
    base.acceptanceCriteria.push(...mustKeep.map((fact) => `全文保留已确认事实：${cleanText(fact, 500)}`))
  }
  return freezeContract(base)
}

export function buildSceneContractPlan(input: SceneContractPlanInput): SceneContractPlan {
  if (!input.outline || !Array.isArray(input.outline.sections) || input.outline.sections.length === 0) throw new Error('scene_contract_outline_missing')
  if (input.outline.sections.length > MAX_CONTRACTS) throw new Error('scene_contract_outline_too_large')
  // Grill Me's durable outline identity is intentionally reused here.  Do not
  // substitute the contract's SHA-256 helper: the canonical payload carries
  // the legacy stable outline hash and snapshot creation must accept it.
  const computedOutlineHash = grillMeOutlineHash(input.outline)
  const outlineHash = input.outlineHash?.trim() || computedOutlineHash
  if (outlineHash !== computedOutlineHash) throw new Error('scene_contract_outline_hash_mismatch')
  const outlineRevision = Number.isFinite(input.outlineRevision)
    ? Math.max(1, Math.floor(input.outlineRevision as number))
    : 1
  const answers = answerMap(input.answers)
  const forbiddenTerms = unique(input.strongConstraints?.forbiddenTerms ?? [], 20)
  const mustKeep = unique(input.strongConstraints?.mustKeep ?? [], 20)
  const characterNames = unique([...(input.characterNames ?? []), ...participantNames(answers.get('characters') ?? '')], 12)
  const entries: SceneContractBuildEntry[] = input.outline.sections.flatMap((section) =>
    Array.isArray(section.scenes) && section.scenes.length > 0
      ? section.scenes.map((scene) => ({ section, scene }))
      : [{ section }]
  )
  if (entries.length > MAX_CONTRACTS) throw new Error('scene_contract_outline_too_large')
  const contracts = entries.map((entry, index) => makeContract({
    section: entry.section,
    scene: entry.scene,
    previous: entries[index - 1],
    next: entries[index + 1],
    index,
    outline: input.outline,
    outlineHash,
    outlineRevision,
    answers,
    characterNames,
    forbiddenTerms,
    mustKeep
  }))
  const base: Omit<SceneContractPlan, 'planHash'> = {
    schemaVersion: SCENE_CONTRACT_SCHEMA_VERSION,
    source: 'grill_me',
    outlineHash,
    outlineRevision,
    targetChars: Math.max(0, Math.floor(input.outline.targetChars)),
    contracts
  }
  return { ...base, planHash: hashValue(base) }
}

export function sceneContractValid(value: unknown): value is SceneContract {
  if (!value || typeof value !== 'object') return false
  const contract = value as SceneContract
  if (contract.schemaVersion !== 1 || typeof contract.contractId !== 'string' || typeof contract.sceneId !== 'string' || typeof contract.sectionId !== 'string') return false
  if (!Number.isInteger(contract.revision) || !Number.isInteger(contract.order) || !Array.isArray(contract.mustHappen) || !Array.isArray(contract.mustNotHappen)) return false
  if (contract.requiredBeatEvidence !== undefined) {
    if (!Array.isArray(contract.requiredBeatEvidence) || contract.requiredBeatEvidence.length !== contract.mustHappen.length) return false
    const ids = new Set(contract.requiredBeatIds)
    for (const item of contract.requiredBeatEvidence) {
      if (!item || typeof item !== 'object' || !ids.has(item.beatId) || typeof item.source !== 'string' || !Array.isArray(item.actor) || !Array.isArray(item.action) || !Array.isArray(item.object) || !Array.isArray(item.location) || !Array.isArray(item.result) || !Array.isArray(item.time) || typeof item.negation !== 'boolean' || !['actual', 'reported', 'hypothetical', 'dream', 'memory', 'planned', 'unknown'].includes(item.modality)) return false
      if (item.actuality !== undefined && !SCENE_BEAT_ACTUALITIES.includes(item.actuality)) return false
      if (item.assertion !== undefined && !SCENE_BEAT_ASSERTIONS.includes(item.assertion)) return false
      const roleArrays = [item.agent, item.patient, item.sourceRole, item.recipient, item.beneficiary].filter((items) => items !== undefined)
      if ([item.actor, item.action, item.object, item.location, item.result, item.time, ...roleArrays].some((items) => !Array.isArray(items) || items.some((part) => typeof part !== 'string'))) return false
      if (item.eventGroups !== undefined && (!Array.isArray(item.eventGroups) || !item.eventGroups.every(eventGroupValid))) return false
    }
  }
  if (!contract.targetChars || !Number.isInteger(contract.targetChars.min) || !Number.isInteger(contract.targetChars.ideal) || !Number.isInteger(contract.targetChars.max)) return false
  if (contract.targetChars.min < 0 || contract.targetChars.min > contract.targetChars.ideal || contract.targetChars.ideal > contract.targetChars.max) return false
  if (typeof contract.frozenHash !== 'string') return false
  const { frozenHash, ...withoutHash } = contract
  return frozenHash === hashValue(withoutHash)
}

export function sceneContractPlanValid(value: unknown): value is SceneContractPlan {
  if (!value || typeof value !== 'object') return false
  const plan = value as SceneContractPlan
  if (plan.schemaVersion !== 1 || plan.source !== 'grill_me' || typeof plan.outlineHash !== 'string' || !Array.isArray(plan.contracts) || plan.contracts.length === 0) return false
  if (!plan.contracts.every(sceneContractValid)) return false
  const { planHash, ...withoutHash } = plan
  return typeof planHash === 'string' && planHash === hashValue(withoutHash)
}

export function sceneContractStartChars(plan: SceneContractPlan, contract: SceneContract): number {
  return plan.contracts.filter((item) => item.order < contract.order).reduce((sum, item) => sum + item.targetChars.ideal, 0)
}

export function selectSceneContract(plan: SceneContractPlan | null | undefined, acceptedChars: number): SceneContract | null {
  if (!sceneContractPlanValid(plan)) return null
  const measured = Math.max(0, Math.floor(acceptedChars))
  let cursor = 0
  for (const contract of plan.contracts) {
    cursor += contract.targetChars.ideal
    if (measured < cursor) return contract
  }
  return plan.contracts.at(-1) ?? null
}

function includesText(haystack: string, needle: string): boolean {
  if (!needle) return false
  return /[A-Za-z]/u.test(needle)
    ? haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
    : haystack.includes(needle)
}

function beatCovered(candidate: string, beat: string): boolean {
  if (includesText(candidate, beat)) return true
  const terms = beat.split(/[\s，,。；;：:、/]+/u).map((term) => term.trim()).filter((term) => codePointLength(term) >= 2)
  if (terms.length === 0) return true
  const hits = terms.filter((term) => includesText(candidate, term)).length
  return hits >= Math.min(2, terms.length)
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function structuredBeats(contract: SceneContract): SceneBeatRequirement[] {
  return contract.mustHappen.map((beat, index) => requirementFor(contract, index, beat))
}

/** Stable source identities, not a lexical verdict about what happened. */
export function deriveSceneBeatRequiredParts(contract: SceneContract): Array<{ beatId: string; requiredSource: string; parts: Array<{ partId: string; source: string; sourceHash: string }> }> {
  return structuredBeats(contract).map(beat => {
    const sources: string[] = []
    let start = 0
    for (let index = 0; index < beat.source.length; index += 1) {
      if (!/[，,；;。]/u.test(beat.source[index]!) || quoteContains(beat.source, index)) continue
      const source = beat.source.slice(start, index).trim()
      if (source) sources.push(source)
      start = index + 1
    }
    const tail = beat.source.slice(start).trim()
    if (tail) sources.push(tail)
    return { beatId: beat.beatId, requiredSource: beat.source, parts: sources.map((source, index) => {
      const sourceHash = hashText(source)
      return { partId: `${beat.beatId}:part:${index + 1}:${sourceHash.slice(0, 12)}`, source, sourceHash }
    }) }
  })
}

type SemanticSpan = NonNullable<SceneBeatModelEvidence['spans']>[number]
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }
function semanticSpan(value: unknown, candidate: string, prefix: string): SemanticSpan | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.source !== undefined && raw.source !== 'candidate' && raw.source !== 'scene_prefix') return null
  const text = raw.source === 'scene_prefix' ? prefix : candidate
  let start = raw.start
  let end = raw.end
  if (start === undefined && end === undefined && Number.isInteger(raw.startCp) && Number.isInteger(raw.endCp)) {
    const points = Array.from(text)
    if (Number(raw.startCp) < 0 || Number(raw.endCp) <= Number(raw.startCp) || Number(raw.endCp) > points.length) return null
    start = points.slice(0, Number(raw.startCp)).join('').length
    end = points.slice(0, Number(raw.endCp)).join('').length
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || Number(end) <= Number(start) || typeof raw.text !== 'string') return null
  try {
    const exact = makeExactTextSpan(text, Number(start), Number(end))
    if (exact.text !== raw.text || !exact.text || codePointLength(exact.text) > 1200 ||
      raw.startCp !== undefined && raw.startCp !== exact.startCp || raw.endCp !== undefined && raw.endCp !== exact.endCp) return null
    return { start: exact.startUtf16, end: exact.endUtf16, startCp: exact.startCodePoint, endCp: exact.endCodePoint, text: exact.text, source: raw.source === 'scene_prefix' ? 'scene_prefix' : 'candidate' }
  } catch { return null }
}

/** Compact critic transport. Only immutable source/offset bindings are filled
 * by the host; no status, predicate, role or supplied hash is repaired here. */
export function bindSceneBeatCriticEvidence(contract: SceneContract, candidate: string, scenePrefix: string, raw: unknown): SceneBeatModelEvidence[] {
  if (Array.isArray(raw)) return raw as SceneBeatModelEvidence[]
  if (!raw || typeof raw !== 'object') return []
  const envelope = raw as Record<string, unknown>
  if (!Array.isArray(envelope.beats)) return [raw as SceneBeatModelEvidence]
  return envelope.beats.map(value => {
    const beat = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const required = structuredBeats(contract).find(item => item.beatId === beat.beatId)
    let spans = beat.spans
    if (Array.isArray(spans)) spans = spans.map(value => {
      if (!value || typeof value !== 'object') return value
      const span = value as Record<string, unknown>
      // Explicit coordinates are never guessed, corrected or overwritten.
      if (['start', 'end', 'startCp', 'endCp', 'startUtf16', 'endUtf16', 'startCodePoint', 'endCodePoint'].some(key => Object.hasOwn(span, key))) return value
      const source = span.source ?? 'candidate'
      if (source !== 'candidate' && source !== 'scene_prefix' || typeof span.text !== 'string' || !span.text) return value
      const text = source === 'scene_prefix' ? scenePrefix : candidate
      const start = text.indexOf(span.text)
      return start >= 0 && text.indexOf(span.text, start + 1) < 0
        ? { ...span, source, start, end: start + span.text.length }
        : value
    })
    if (spans === undefined && typeof beat.quote === 'string' && beat.quote.length > 0) {
      const source = beat.quoteSource ?? 'candidate'
      const text = source === 'scene_prefix' ? scenePrefix : candidate
      const start = text.indexOf(beat.quote)
      spans = start >= 0 && text.indexOf(beat.quote, start + 1) < 0
        ? [{ start, end: start + beat.quote.length, text: beat.quote, source }]
        : []
    }
    return { ...beat, semanticVersion: envelope.semanticVersion, contractHash: envelope.contractHash,
      candidateHash: envelope.candidateHash, scenePrefixHash: envelope.scenePrefixHash,
      requiredSource: required?.source, spans } as unknown as SceneBeatModelEvidence
  })
}

function semanticLocalFrame(text: string, span: SemanticSpan, range: EventClauseRange, predicateStart: number, agents: string[], hints: string[]): EventClauseRange | null {
  // Inheritance belongs to this exact citation, not the whole manuscript.
  // A paragraph, a competing subject or a non-actual frame ends the binding.
  const paragraphStart = text.lastIndexOf('\n', predicateStart - 1) + 1
  const start = Math.max(span.start, paragraphStart)
  let frameStart = range.start
  let actor: string | undefined
  const clauses = eventClauseRanges(text.slice(start, range.start))
  for (const clause of clauses) {
    const at = start + clause.start
    const value = clause.source.replace(/^(?:然后|随后|接着|随即|于是|同时)/u, '')
    const named = hints.filter(name => value.startsWith(name)).sort((a, b) => b.length - a.length)
    const coordinated = named.length > 0 && new RegExp(`^${escapeRegExp(named[0]!)}(?:与|和)`, 'u').test(value)
    const otherSubject = /^(?:他|她|它)(?!们)/u.test(value) ? undefined : value.match(/^([\p{Script=Han}A-Za-z·]{2,16}?)(?:把|将|用)/u)?.[1]
    const firstAction = actionMatches(value)[0]
    const inferredSubject = firstAction ? localSubject(value.slice(0, firstAction.index), hints) : []
    const competingSubject = inferredSubject.length > 0 && !named.length && !inferredSubject.every(subject => /^(?:他|她|它)$/u.test(subject))
    const nonActual = actualityCues(clause.source, hints).some(cue => cue.kind === 'negation' || cue.kind === 'global' ||
      ['planned', 'reported', 'dreamed', 'refused', 'near_miss', 'pretended', 'attempted', 'unknown'].includes(cue.actuality)) ||
      /^(?:他|她)?(?:想|打算|计划)/u.test(value)
    if (quoteContains(text, at) || /[“”"「」『』]/u.test(clause.source) || coordinated || nonActual || competingSubject ||
      otherSubject && !named.length && !/^(?:他|她|它)$/u.test(otherSubject)) {
      actor = undefined
      frameStart = start + clause.end
      continue
    }
    if (named.length && named[0] !== actor) {
      actor = named[0]
      frameStart = at
    }
  }
  const before = text.slice(range.start, predicateStart).trim().replace(/^(?:然后|随后|接着|随即|于是|同时)/u, '')
  const visible = hints.filter(name => before.startsWith(name)).sort((a, b) => b.length - a.length)
  if (visible.length) {
    if (agents.length !== 1 || agents[0] !== visible[0] || new RegExp(`^${escapeRegExp(visible[0]!)}(?:与|和)`, 'u').test(before)) return null
    if (actor !== visible[0]) frameStart = range.start
    actor = visible[0]
  }
  // A passive has an explicit local agent after 被; it is not the patient.
  const passive = agents.length === 1 && new RegExp(`被\\s*${escapeRegExp(agents[0]!)}(?:\\s|把|将|用|已|正|又|再|轻|缓|慢|$)`, 'u').test(before)
  const direct = agents.length === 1 && before.startsWith(agents[0]!)
  const continuation = /^(?:他|她)(?!们)/u.test(before) || !before || /^(?:把|将|用|在|向|从|又|再|便|就)/u.test(before)
  const previous = clauses.at(-1)
  // “X伸手，手掌…” visibly names the owner in the immediately adjacent
  // citation clause. This is a body-part relation, not a cast/entity pool;
  // a new person, an intervening clause or a paragraph cannot supply it.
  const ownedHand = agents.length === 1 && /^手(?:掌|背|指|腕)(?:轻轻|缓缓|慢慢)?$/u.test(before) && previous !== undefined &&
    new RegExp(`^${escapeRegExp(agents[0]!)}伸(?:出)?(?:了)?(?:一只|双)?手$`, 'u').test(previous.source) &&
    !quoteContains(text, start + previous.start)
  if (!passive && !direct && !ownedHand && !(agents.length === 1 && continuation && actor === agents[0])) return null
  if (ownedHand) frameStart = start + previous!.start
  if (passive || direct && !visible.length) frameStart = range.start
  const end = Math.min(range.end, span.end)
  if (frameStart < start || predicateStart < start || end < predicateStart) return null
  return { start: frameStart, end, source: text.slice(frameStart, end) }
}

function semanticPatientBound(text: string, frame: EventClauseRange, range: EventClauseRange, predicateStart: number, predicateEnd: number, patient: string): boolean {
  const literal = range.source.indexOf(patient)
  if (literal >= 0 && !quoteContains(text, range.start + literal)) return true
  const before = text.slice(range.start, predicateStart).replace(/^(?:然后|随后|接着|随即|于是|同时)/u, '').replace(/^(?:他|她)(?!们)/u, '').trim()
  const tail = text.slice(predicateEnd, range.end).trim()
  // A different explicit object is not an omitted/pronominal patient.
  if (!/^(?:(?:又|再|便|就|才|轻轻|缓缓|慢慢)*(?:(?:把|将)(?:它|它们|其))?)$/u.test(before) ||
    !/^(?:[了着过]|它|它们|其|[半一二两三四五六七八九十百\d]+(?:下|次|圈|遍|步|秒|分))*$/u.test(tail)) return false
  const previous = eventClauseRanges(text.slice(frame.start, range.start))
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const clause = previous[index]!
    const literalAt = clause.source.indexOf(patient)
    if (literalAt >= 0) return !quoteContains(text, frame.start + clause.start + literalAt)
    // Only a transparent, object-free numeric continuation can bridge the
    // last explicit patient. A fresh noun/object terminates the search.
    const value = clause.source.replace(/^(?:然后|随后|接着|随即|又|再|他|她)/u, '')
    if (!/^[\p{Script=Han}]{1,8}?(?:了|着|过)?[半一二两三四五六七八九十百\d]+(?:下|次|圈|遍|步|秒|分)$/u.test(value)) return false
  }
  return false
}

function typedSemanticFrame(event: SceneBeatSemanticEventEvidence, spans: SemanticSpan[], span: SemanticSpan, range: EventClauseRange, predicateStart: number, text: string, hints: string[]): EventClauseRange | null {
  const bindings = event.agentBindings
  if (!Array.isArray(bindings) || bindings.length !== event.agent.length || new Set(bindings.map(binding => binding?.name)).size !== bindings.length) return null
  const locate = (ref: { spanIndex: number; text: string } | undefined): { start: number; end: number; text: string } | null => {
    if (!ref || !Number.isInteger(ref.spanIndex) || typeof ref.text !== 'string' || !ref.text) return null
    const cited = spans[ref.spanIndex]
    if (!cited || cited.source !== span.source) return null
    const at = cited.text.indexOf(ref.text)
    if (at < 0 || cited.text.indexOf(ref.text, at + 1) >= 0) return null
    const start = cited.start + at
    return quoteContains(text, start) ? null : { start, end: start + ref.text.length, text: ref.text }
  }
  const subjectHead = (at: number): string => text.slice(Math.max(0, text.slice(0, at).search(/[^，,。！？!?；;\n]*$/u)), at).trim()
  // Clause-leading connectives and a closing dialogue delimiter do not change
  // the explicit subject. Do not accept arbitrary prepositional/object text:
  // “等林舟…” / “替林舟…” and hypothetical frames remain unbound.
  const transparentSubjectHead = (at: number): boolean => /^(?:[”」』"]\s*)?(?:(?:然后|随后|接着|随即|于是|同时|这时|此时|此刻|忽然|突然|然而|可是|但是|终于|原来)\s*)*$/u.test(subjectHead(at))
  let start = range.start
  for (const binding of bindings) {
    if (!binding || !event.agent.includes(binding.name) || !['explicit', 'pronoun', 'body_owner', 'instrument_owner'].includes(binding.relation)) return null
    const mention = locate(binding.mention)
    const antecedent = binding.antecedent === undefined ? null : locate(binding.antecedent)
    if (!mention || mention.end > predicateStart || predicateStart - mention.start > 240 || /\n/u.test(text.slice(mention.start, predicateStart))) return null
    let anchor = mention
    if (binding.relation === 'explicit') {
      if (!mention.text.includes(binding.name) || !transparentSubjectHead(mention.start) && !/的$/u.test(subjectHead(mention.start))) return null
      if (binding.antecedent !== undefined && !antecedent) return null
    } else {
      if (!antecedent || antecedent.end > mention.start || predicateStart - antecedent.start > 240 || /\n/u.test(text.slice(antecedent.start, predicateStart)) || !antecedent.text.includes(binding.name) || !transparentSubjectHead(antecedent.start)) return null
      anchor = antecedent
      if (binding.relation === 'pronoun') {
        if (!/^(?:他|她|它)(?:们)?$/u.test(mention.text) || !transparentSubjectHead(mention.start)) return null
      } else if (binding.relation === 'body_owner') {
        const body = mention.text.match(/^(手|脚|臂|眼|头)(?:掌|背|指|腕|趾|肘|睛|部)?$/u)?.[1]
        if (!body || !antecedent.text.startsWith(binding.name) || !antecedent.text.includes(body) || /(?:别人的|他人的|另一人的)/u.test(antecedent.text)) return null
      } else {
        const instrument = mention.text.match(/^(.+?)的.+$/u)?.[1]
        if (!instrument || !antecedent.text.startsWith(binding.name) || !antecedent.text.includes(instrument) ||
          !new RegExp(`^${escapeRegExp(binding.name)}(?:的|[^，,。！？!?；;\\n]*?(?:把|将|用))${escapeRegExp(instrument)}`, 'u').test(antecedent.text)) return null
      }
    }
    // Identity persists through a different denied action. Reality of this
    // predicate is checked separately below; only a new local subject breaks it.
    const chain = text.slice(anchor.start, predicateStart)
    if (hints.some(name => name !== binding.name && new RegExp(`(?:^|[，,。；;])\\s*${escapeRegExp(name)}(?:的|把|将|用|在|向|从|[^，,。！？!?；;]*$)`, 'u').test(chain))) return null
    if (binding.relation !== 'explicit' && hints.some(name => name !== binding.name && antecedent!.text.includes(`${name}的`))) return null
    start = Math.min(start, anchor.start)
  }
  return { start, end: range.end, source: text.slice(start, range.end) }
}

function semanticClockTimes(text: string): string[] {
  const times = inferTime(text).filter(time => /^\d{1,2}:\d{2}$/u.test(time))
  for (const match of text.matchAll(/(?<!\d)([01]?\d|2[0-3])(?:点|时)(?:整|([0-5]?\d)分)?/gu)) times.push(`${Number(match[1])}:${String(Number(match[2] ?? 0)).padStart(2, '0')}`)
  if (/(?:晚上|夜里|夜间)/u.test(text)) for (const time of [...times]) {
    const [hour, minute] = time.split(':')
    if (Number(hour) > 0 && Number(hour) < 12) times.push(`${Number(hour) + 12}:${minute}`)
  }
  return unique(times, 24)
}

function semanticEventGroup(event: SceneBeatSemanticEventEvidence, span: SemanticSpan, index: number, candidate: string, prefix: string, hints: string[], onReject: (reason: string, role?: string) => void, typedSpans?: SemanticSpan[]): SceneBeatEventGroup | null {
  const reject = (reason: string, role?: string): null => { onReject(reason, role); return null }
  const domain = span.source === 'scene_prefix' ? prefix : candidate
  const offset = span.source === 'scene_prefix' ? 0 : prefix.length
  const localIndex = span.text.indexOf(event.predicate)
  if (localIndex < 0) return reject('predicate_missing')
  if (span.text.indexOf(event.predicate, localIndex + 1) >= 0) return reject('predicate_ambiguous')
  const predicateStart = span.start + localIndex
  const predicateEnd = predicateStart + event.predicate.length
  const clause = eventClauseRanges(domain).find(part => part.start <= predicateStart && part.end >= predicateEnd)
  if (!clause) return reject('predicate_missing')
  const rangeStart = Math.max(clause.start, span.start)
  const rangeEnd = Math.min(clause.end, span.end)
  const range = { start: rangeStart, end: rangeEnd, source: domain.slice(rangeStart, rangeEnd) }
  const frame = typedSpans ? typedSemanticFrame(event, typedSpans, span, range, predicateStart, domain, hints) : semanticLocalFrame(domain, span, range, predicateStart, event.agent, hints)
  if (!frame) return reject('agent_unbound')
  if (event.patient.some(token => !semanticPatientBound(domain, frame, range, predicateStart, predicateEnd, token))) return reject('role_unanchored', 'patient')
  for (const key of ['sourceRole', 'recipient', 'beneficiary'] as const) {
    if ((event[key] ?? []).some(token => !range.source.includes(token) || quoteContains(domain, range.start + range.source.indexOf(token)))) return reject('role_unanchored', key)
  }
  const before = domain.slice(range.start, predicateStart)
  const putPatient = before.match(/(?:把|将)([^，,。！？!?；;\n]+)$/u)?.[1]
  if (putPatient && !/^(?:它|它们|其)$/u.test(putPatient) && event.patient.some(patient => !entityCovered(putPatient, patient))) return reject('role_mismatch', 'patient')
  if ((event.sourceRole ?? []).some(source => !new RegExp(`从\\s*${escapeRegExp(source)}`, 'u').test(range.source))) return reject('role_mismatch', 'sourceRole')
  if ((event.recipient ?? []).some(recipient => !new RegExp(`(?:给|向|到|交予|送至)\\s*${escapeRegExp(recipient)}`, 'u').test(range.source))) return reject('role_mismatch', 'recipient')
  const known = actionMatches(event.predicate).find(match => match.index === 0 && match.surface === event.predicate)
  const action = known?.canonical ?? event.predicate
  // Reality cues preceding this predicate govern it; a cue inside its noun
  // complement (e.g. a switch's “预备位”) does not turn a narrated turn into
  // a plan. Explicit retrospective denial remains a hard negative.
  const tail = domain.slice(predicateEnd, range.end)
  if (/(?:并非事实|不是事实|没有发生|未发生|从未发生|未果|落空|只是(?:传闻|谣言|计划|设想|梦)|不过是(?:传闻|计划|梦))/u.test(tail)) return reject('actuality_invalid')
  const beforePredicate = domain.slice(range.start, predicateStart)
  const immediateCue = beforePredicate.match(/(?:并没有|没有|并未|未曾|不曾|从未|没|未|不|想要|想|计划|打算|准备|预备)(?:立刻|马上|轻轻|缓缓|慢慢|牢牢|直接|真的|再|就|去|先|要)*$/u)?.[0]
  if (immediateCue && event.actuality === 'asserted_actual') return reject('actuality_invalid')
  const assessment = classifyActuality(domain, { index: predicateStart, surface: event.predicate, canonical: action }, range.start, predicateEnd, prefix + candidate, offset + predicateStart, hints, true)
  if (/[？?吗么呢]\s*$/u.test(tail) && action !== 'ask') return reject('actuality_invalid')
  if (assessment.scope.confidence !== 'high' || assessment.actuality !== event.actuality || actualityAssertion(assessment.actuality) !== event.assertion || event.negation !== (assessment.actuality === 'negated')) return reject('actuality_invalid')
  const shift = (value: number): number => value + offset
  return {
    eventId: `semantic:${index + 1}`, source: frame.source, action, surface: event.predicate,
    start: shift(frame.start), end: shift(frame.end), actor: event.agent, agent: event.agent, patient: event.patient,
    sourceRole: event.sourceRole ?? [], recipient: event.recipient ?? [], beneficiary: event.beneficiary ?? [],
    object: event.patient, location: [], result: [], time: [], negation: event.negation,
    modality: actualityModality(event.actuality), actuality: event.actuality, assertion: event.assertion,
    predicateSpan: { start: shift(predicateStart), end: shift(predicateEnd), text: event.predicate },
    cueSpans: assessment.cues.map(cue => ({ ...cue, start: shift(cue.start), end: shift(cue.end), scopeStart: shift(cue.scopeStart), scopeEnd: shift(cue.scopeEnd) })),
    scope: { ...assessment.scope, start: shift(assessment.scope.start), end: shift(assessment.scope.end) }
  }
}

/** Accepts only this critic reading of this frozen beat in this exact scene.
 * Semantic truth is supplied by the critic; quotation, actuality and visible
 * local role bindings are independently checked, without a closed verb list. */
export function validateSceneBeatSemanticEvidence(contract: SceneContract, candidate: string, scenePrefix: string, raw: unknown): { evidence: SceneBeatModelEvidence[]; invalidBeatIds: string[]; issues: Array<{ beatId: string; reason: string; predicate?: string; role?: string }> } {
  const records = bindSceneBeatCriticEvidence(contract, candidate, scenePrefix, raw)
  const requirements = structuredBeats(contract)
  const hints = unique([...contract.activeCharacterIds, ...requirements.flatMap(beat => beat.agent ?? beat.actor)], 32)
  const requiredParts = deriveSceneBeatRequiredParts(contract)
  const valid = new Map<string, SceneBeatModelEvidence>()
  const invalid = new Set<string>()
  const issues: Array<{ beatId: string; reason: string; predicate?: string; role?: string }> = []
  for (const value of records) {
    const item = value as SceneBeatModelEvidence
    const id = typeof item?.beatId === 'string' ? item.beatId : 'unknown'
    const requirement = requirements.find(beat => beat.beatId === id)
    const reject = (reason: string, predicate?: string, role?: string): void => { invalid.add(id); valid.delete(id); issues.push({ beatId: id, reason, ...(predicate ? { predicate } : {}), ...(role ? { role } : {}) }) }
    if (!item || ![1, 2].includes(item.semanticVersion ?? 0) || item.contractHash !== contract.frozenHash || item.candidateHash !== hashText(candidate) || item.scenePrefixHash !== hashText(scenePrefix) || !requirement || item.requiredSource !== requirement.source) { reject('binding_invalid'); continue }
    if (!['satisfied', 'missing', 'uncertain', 'contradicted'].includes(item.status)) { reject('shape_invalid'); continue }
    if (invalid.has(id) || valid.has(id)) { reject('duplicate_beat'); continue }
    if (item.spans !== undefined && !Array.isArray(item.spans) || item.semanticEvents !== undefined && !Array.isArray(item.semanticEvents)) { reject('shape_invalid'); continue }
    const spans = (item.spans ?? []).map(span => semanticSpan(span, candidate, scenePrefix))
    if (spans.some(span => span === null)) { reject('span_invalid'); continue }
    const anchored = spans as SemanticSpan[]
    const events = item.semanticEvents ?? []
    const typed = item.semanticVersion === 2
    const parts = requiredParts.find(beat => beat.beatId === id)!.parts
    let partEvidence = item.partEvidence
    if (typed && (!Array.isArray(partEvidence) || partEvidence.length !== parts.length || new Set(partEvidence.map(part => part?.partId)).size !== parts.length ||
      partEvidence.some(part => !part || !parts.some(required => required.partId === part.partId) || !['satisfied', 'missing', 'uncertain', 'contradicted'].includes(part.status) ||
        !Array.isArray(part.spanIndexes) || part.spanIndexes.some(index => !Number.isInteger(index) || !anchored[index]) || part.status === 'satisfied' && !part.spanIndexes.length))) { reject('required_part_invalid'); continue }
    if (typed) partEvidence = partEvidence!.map(part => {
      const required = parts.find(source => source.partId === part.partId)!
      const clocks = semanticClockTimes(required.source)
      const cited = part.spanIndexes.map(index => anchored[index]!.text).join(' ')
      return part.status === 'satisfied' && clocks.some(clock => !semanticClockTimes(cited).includes(clock)) ? { ...part, status: 'missing' as const } : part
    })
    const supported = item.status === 'satisfied' || item.status === 'contradicted'
    if (supported && (!anchored.length || !events.length)) { reject('shape_invalid'); continue }
    const groups: SceneBeatEventGroup[] = []
    for (const event of events) {
      if (!event || !Number.isInteger(event.spanIndex) || !anchored[event.spanIndex] || typeof event.predicate !== 'string' || !event.predicate.trim() ||
        !Array.isArray(event.agent) || !event.agent.length || !Array.isArray(event.patient) ||
        [event.agent, event.patient, event.sourceRole ?? [], event.recipient ?? [], event.beneficiary ?? []].some(list => !Array.isArray(list) || list.some(token => typeof token !== 'string' || !token.trim())) ||
        !SCENE_BEAT_ACTUALITIES.includes(event.actuality) || !SCENE_BEAT_ASSERTIONS.includes(event.assertion) || typeof event.negation !== 'boolean' ||
        item.status === 'satisfied' && (event.actuality !== 'asserted_actual' || event.assertion !== 'asserted' || event.negation)) { reject('shape_invalid'); break }
      if (typed && (!Array.isArray(event.partIds) || !event.partIds.length || event.partIds.some(partId => !parts.some(part => part.partId === partId)) ||
        event.patient.includes(event.predicate)) || !typed && event.agentBindings !== undefined) { reject('shape_invalid', event.predicate); break }
      const group = semanticEventGroup(event, anchored[event.spanIndex]!, groups.length, candidate, scenePrefix, hints, (reason, role) => reject(reason, event.predicate, role), typed ? anchored : undefined)
      const expectedActors = contract.activeCharacterIds.filter(actor => requirement.source.includes(actor))
      if (!group) break
      if (!typed && expectedActors.length > 0 && group.agent.some(actor => !expectedActors.includes(actor))) { reject('required_role_mismatch', event.predicate, 'agent'); break }
      const requiredGroups = (requirement.eventGroups ?? []).filter(required => required.action === group.action && required.actuality === 'asserted_actual' && required.assertion === 'asserted' && !required.negation && required.scope?.confidence === 'high')
      if (item.status === 'satisfied' && requiredGroups.length && (!typed || DIRECTIONAL_ACTIONS.has(group.action)) && !requiredGroups.some(required => eventGroupSemanticFieldsCovered(required, group))) { reject('required_role_mismatch', event.predicate); break }
      groups.push(group)
    }
    if (invalid.has(id)) continue
    let status = item.status
    if (typed) {
      for (const part of partEvidence!) {
        const required = parts.find(source => source.partId === part.partId)!
        const property = semanticClockTimes(required.source).length > 0 && !/[\p{Script=Han}]{2}/u.test(required.source.replace(/[零〇一二两三四五六七八九十点时整分]/gu, '')) || /^(?:没有|并未|未曾|不曾|并没有)/u.test(required.source)
        if (part.status === 'satisfied' && !property && !events.some(event => event.partIds?.includes(part.partId) && part.spanIndexes.includes(event.spanIndex))) { reject('required_part_invalid'); break }
      }
      if (invalid.has(id)) continue
      const principalNames = hints.filter(name => requiredParts.some(beat => beat.parts.find(part => !/^\d{1,2}[:：]\d{2}$/u.test(part.source))?.source.startsWith(name)))
      const expected = principalNames.filter(name => parts.some(part => part.source.startsWith(name)))
      if (item.status === 'satisfied' && expected.some(name => !groups.some(group => group.agent.includes(name)))) { reject('required_role_mismatch', undefined, 'agent'); continue }
      if (partEvidence!.some(part => part.status === 'contradicted')) status = 'contradicted'
      else if (partEvidence!.some(part => part.status === 'uncertain')) status = 'uncertain'
      else if (partEvidence!.some(part => part.status === 'missing')) status = 'missing'
    }
    const merge = (key: 'agent' | 'patient' | 'sourceRole' | 'recipient' | 'beneficiary'): string[] => unique(groups.flatMap(group => group[key]), 24)
    valid.set(id, { beatId: id, semanticVersion: item.semanticVersion, contractHash: item.contractHash, candidateHash: item.candidateHash, scenePrefixHash: item.scenePrefixHash,
      requiredSource: requirement.source, status, spans: anchored, semanticEvents: events, eventGroups: groups, ...(typed ? { partEvidence } : {}),
      actor: merge('agent'), agent: merge('agent'), patient: merge('patient'), object: merge('patient'), sourceRole: merge('sourceRole'), recipient: merge('recipient'), beneficiary: merge('beneficiary'),
      action: unique(groups.map(group => group.surface), 24), location: [], result: [], time: [],
      modality: groups.length ? 'actual' : 'unknown', actuality: groups.length && groups.every(group => group.actuality === 'asserted_actual') ? 'asserted_actual' : 'unknown',
      assertion: groups.length && groups.every(group => group.assertion === 'asserted') ? 'asserted' : 'unknown', negation: groups.some(group => group.negation), rationale: typeof item.rationale === 'string' ? cleanText(item.rationale) : undefined })
  }
  return { evidence: [...valid.values()], invalidBeatIds: [...invalid], issues }
}

function modelEvidenceShapeValid(value: unknown, candidate: string, candidateHash: string): value is BoundSceneBeatModelEvidence {
  if (!value || typeof value !== 'object') return false
  const item = value as BoundSceneBeatModelEvidence
  if (typeof item.beatId !== 'string' || !item.beatId || typeof item.scenePrefixHash !== 'string' || !/^[0-9a-f]{64}$/u.test(item.scenePrefixHash)) return false
  // Prefix identity alone is insufficient: it is identical for every
  // candidate in a run. Require the exact candidate segment hash as well.
  if (typeof item.candidateHash !== 'string' || item.candidateHash !== candidateHash || !/^[0-9a-f]{64}$/u.test(item.candidateHash)) return false
  if (!['satisfied', 'missing', 'uncertain', 'contradicted'].includes(item.status)) return false
  for (const key of ['actor', 'action', 'object', 'location', 'result', 'time', 'agent', 'patient', 'sourceRole', 'recipient', 'beneficiary'] as const) {
    if (item[key] !== undefined && (!Array.isArray(item[key]) || item[key].some((part) => typeof part !== 'string'))) return false
  }
  // Every model packet must cite at least one exact span in the candidate
  // text. A packet that only repeats semantic fields is opaque and cannot be
  // used to promote a missing beat.
  if (!Array.isArray(item.spans) || item.spans.length === 0 || item.spans.some((span) => {
    if (!span || typeof span !== 'object') return true
    const start = (span as { start?: unknown }).start
    const end = (span as { end?: unknown }).end
    const text = (span as { text?: unknown }).text
    return !Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 0 || Number(end) <= Number(start) || Number(end) > candidate.length || typeof text !== 'string' || text.length === 0 || candidate.slice(Number(start), Number(end)) !== text
  })) return false
  if (item.modality !== undefined && !['actual', 'reported', 'hypothetical', 'dream', 'memory', 'planned', 'unknown'].includes(item.modality)) return false
  if (item.actuality !== undefined && !SCENE_BEAT_ACTUALITIES.includes(item.actuality)) return false
  if (item.assertion !== undefined && !SCENE_BEAT_ASSERTIONS.includes(item.assertion)) return false
  if (item.eventGroups !== undefined && (!Array.isArray(item.eventGroups) || !item.eventGroups.every(eventGroupValid))) return false
  if (item.negation !== undefined && typeof item.negation !== 'boolean') return false
  const structured = ['actor', 'action', 'object', 'location', 'result', 'time', 'agent', 'patient', 'sourceRole', 'recipient', 'beneficiary'].some((key) => Array.isArray(item[key as keyof SceneBeatModelEvidence]) && (item[key as keyof SceneBeatModelEvidence] as unknown[]).length > 0) || (Array.isArray(item.spans) && item.spans.length > 0)
  if ((item.status === 'satisfied' || item.status === 'contradicted') && !structured) return false
  // A cited span must actually contain every claimed semantic token. Action
  // labels are canonical keys (e.g. handover), so validate them through the
  // same realization grammar used by deterministic evidence.
  if (item.status === 'satisfied' || item.status === 'contradicted') {
    const cited = item.spans.map((span) => span.text).join(' ')
    const fields: Array<[string, string[]]> = [
      ['actor', item.actor ?? []], ['action', item.action ?? []], ['object', item.object ?? []],
      ['location', item.location ?? []], ['result', item.result ?? []], ['time', item.time ?? []],
      ['agent', item.agent ?? []], ['patient', item.patient ?? []], ['sourceRole', item.sourceRole ?? []],
      ['recipient', item.recipient ?? []], ['beneficiary', item.beneficiary ?? []]
    ]
    if (fields.some(([field, values]) => values.some((value) => field === 'action' ? !actionCovered(cited, value) : !includesText(cited, value)))) return false
  }
  return true
}

function mergeBoundModelEvidence(
  contract: SceneContract,
  requirements: SceneBeatRequirement[],
  deterministic: SceneBeatEvaluationEvidence[],
  modelEvidence: readonly unknown[] | undefined,
  scenePrefixHash: string,
  candidate: string,
  candidateHash: string,
  scenePrefix: string
): { evidence: SceneBeatEvaluationEvidence[]; invalid: string[] } {
  if (!modelEvidence || modelEvidence.length === 0) return { evidence: deterministic, invalid: [] }
  const required = new Set(requirements.map((item) => item.beatId))
  const byBeat = new Map<string, BoundSceneBeatModelEvidence>()
  const semantic = validateSceneBeatSemanticEvidence(contract, candidate, scenePrefix, modelEvidence.filter(raw => raw && typeof raw === 'object' && (raw as SceneBeatModelEvidence).semanticVersion !== undefined))
  const invalid: string[] = [...semantic.invalidBeatIds]
  for (const item of semantic.evidence) byBeat.set(item.beatId, item)
  for (const raw of modelEvidence) {
    if (raw && typeof raw === 'object' && (raw as SceneBeatModelEvidence).semanticVersion !== undefined) continue
    if (!modelEvidenceShapeValid(raw, candidate, candidateHash) || !required.has(raw.beatId) || raw.scenePrefixHash !== scenePrefixHash) {
      invalid.push(typeof raw === 'object' && raw && typeof (raw as { beatId?: unknown }).beatId === 'string' ? String((raw as { beatId: string }).beatId) : 'unknown')
      continue
    }
    const prior = byBeat.get(raw.beatId)
    if (prior && JSON.stringify(prior) !== JSON.stringify(raw)) {
      invalid.push(raw.beatId)
      continue
    }
    byBeat.set(raw.beatId, raw)
  }
  const evidence = deterministic.map((local) => {
    const model = byBeat.get(local.beatId)
    if (!model) return local
    if (model.semanticVersion === 1 || model.semanticVersion === 2) {
      const requirement = requirements.find(item => item.beatId === local.beatId)!
      // Only role-bound predicate-local non-actual events are authoritative;
      // an opaque/mixed beat's aggregate lexical flags are not a proof. A
      // valid “missing” report must not erase a narrated plan/dream/denial
      // and let finish=length accept it as ordinary incomplete progress.
      const hardConflict = (requirement.eventGroups ?? []).some(required =>
        required.actuality === 'asserted_actual' && required.assertion === 'asserted' && !required.negation && required.scope?.confidence === 'high' &&
        (local.eventGroups ?? []).some(group => group.action === required.action && eventGroupSemanticFieldsCovered(required, group) &&
          group.actuality !== 'asserted_actual' && group.actuality !== 'unknown' && group.scope?.confidence === 'high') &&
        !(local.eventGroups ?? []).some(group => eventGroupBindingCovered(required, [group])))
      return { ...local, status: hardConflict ? 'contradicted' : model.status, source: 'deterministic+model' as const,
        matched: { actor: model.actor ?? [], action: model.action ?? [], object: model.object ?? [], location: model.location ?? [], result: model.result ?? [], time: model.time ?? [],
          agent: model.agent ?? [], patient: model.patient ?? [], sourceRole: model.sourceRole ?? [], recipient: model.recipient ?? [], beneficiary: model.beneficiary ?? [] },
        modality: model.modality ?? 'unknown', actuality: model.actuality ?? 'unknown', assertion: model.assertion ?? 'unknown', negation: model.negation ?? false,
        eventGroups: model.eventGroups, candidateHash: model.candidateHash, spans: model.spans, rationale: model.rationale,
        semanticVersion: model.semanticVersion, contractHash: model.contractHash, requiredSource: model.requiredSource, semanticEvents: model.semanticEvents, partEvidence: model.partEvidence }
    }
    // A local contradiction (for example “只是传闻” or “没有交出”) is a
    // hard negative.  Model evidence cannot override it with an unbound or
    // optimistic label; it may only resolve a locally missing relation.
    // Older model evidence only supplied status/rationale.  It must not erase
    // the deterministic local actuality with an artificial unknown; use the
    // model value only when it explicitly carries actuality or coarse
    // modality, otherwise preserve the local event reading.
    const modelActuality = model.actuality ?? (model.modality !== undefined ? actualityFromModality(model.modality) : local.actuality)
    const requirement = requirements.find((item) => item.beatId === local.beatId)
    const localGroups = local.eventGroups ?? []
    const localHasAssertedActual = localGroups.some((group) =>
      eventGroupActuality(group) === 'asserted_actual' &&
      (group.assertion ?? 'asserted') === 'asserted' &&
      group.negation !== true &&
      (group.scope?.confidence ?? 'high') === 'high')
    const requiredGroups = requirement?.eventGroups ?? []
    const localHasRequiredBoundActual = requiredGroups.length === 0
      ? localHasAssertedActual
      : requiredGroups.every((requiredGroup) => localGroups.some((candidateGroup) => eventGroupBindingCovered(requiredGroup, [candidateGroup])))
    // Model evidence may fill a missing role or explain a local event, but it
    // cannot promote a deterministic non-actual/uncertain predicate to an
    // asserted world event.  Otherwise a malformed model packet could turn a
    // quote or plan into a holder mutation downstream.
    const modelActualityConflict = (requirement?.actuality === 'asserted_actual' && modelActuality !== 'asserted_actual') ||
      (modelActuality === 'asserted_actual' && localGroups.length > 0 && !localHasRequiredBoundActual)
    const modelAssertion = model.assertion ?? actualityAssertion(modelActuality)
    const modelAssertionConflict = model.assertion !== undefined && model.assertion !== actualityAssertion(modelActuality)
    const status: SceneBeatEvidenceStatus = local.status === 'contradicted' || modelActualityConflict || modelAssertionConflict
      ? 'contradicted'
      : model.status
    const mergedMatched = {
      actor: Array.isArray(model.actor) ? unique(model.actor, 12) : local.matched.actor,
      action: Array.isArray(model.action) ? unique(model.action, 12) : local.matched.action,
      object: Array.isArray(model.object) ? unique(model.object, 12) : local.matched.object,
      location: Array.isArray(model.location) ? unique(model.location, 12) : local.matched.location,
      result: Array.isArray(model.result) ? unique(model.result, 12) : local.matched.result,
      time: Array.isArray(model.time) ? unique(model.time, 12) : local.matched.time,
      agent: Array.isArray(model.agent) ? unique(model.agent, 12) : local.matched.agent,
      patient: Array.isArray(model.patient) ? unique(model.patient, 12) : local.matched.patient,
      sourceRole: Array.isArray(model.sourceRole) ? unique(model.sourceRole, 12) : local.matched.sourceRole,
      recipient: Array.isArray(model.recipient) ? unique(model.recipient, 12) : local.matched.recipient,
      beneficiary: Array.isArray(model.beneficiary) ? unique(model.beneficiary, 12) : local.matched.beneficiary
    }
    return {
      ...local,
      status,
      source: 'deterministic+model' as const,
      matched: mergedMatched,
      modality: model.modality ?? local.modality,
      actuality: modelActuality,
      assertion: modelAssertion,
      negation: model.negation ?? local.negation,
      candidateHash: model.candidateHash as string,
      spans: model.spans?.map((span) => ({ start: span.start, end: span.end, text: span.text })),
      rationale: model.rationale
    }
  })
  return { evidence, invalid: unique(invalid, 32) }
}

export function evaluateSceneContract(
  contract: SceneContract,
  candidate: string,
  opts: {
    sceneChars?: number
    completed?: boolean
    /** Accepted prose before this candidate; used for full-prefix binding. */
    scenePrefix?: string
    /** Optional structured evidence from a model/critic, never free text. */
    modelEvidence?: readonly unknown[]
    /** Set only after the current bound candidate's real critic was asked
     * for semantic evidence. This grants rewriting, not completion. */
    semanticReview?: boolean
  } = {}
): SceneContractEvaluation {
  const candidateText = String(candidate ?? '')
  const scenePrefix = typeof opts.scenePrefix === 'string' ? opts.scenePrefix : ''
  const text = `${scenePrefix}${candidateText}`
  const completed = opts.completed === true
  const sceneChars = typeof opts.sceneChars === 'number' && Number.isFinite(opts.sceneChars) ? Math.max(0, Math.floor(opts.sceneChars)) : null
  const violations: SceneContractEvaluationViolation[] = []
  const requirements = structuredBeats(contract)
  const candidateHash = hashText(candidateText)
  const scenePrefixHash = hashText(scenePrefix)
  const actorHints = unique([...contract.activeCharacterIds, ...requirements.flatMap(beat => beat.agent ?? beat.actor)], 16)
  // Only a matching initial clock and the immediately following asserted
  // optical spatial frame may anchor an otherwise locationless first event.
  // Later mentions, quotes, moves, or time jumps never seed a scene location.
  const first = requirements[0]
  const header = text.split(/[。！？!?；;\n]/u).map(part => part.trim()).filter(Boolean).slice(0, 2)
  const initialLocation = (first?.location ?? []).filter(location => {
    if (!(first?.time ?? []).some(time => inferTime(header[0] ?? '').includes(time))) return false
    if (/(?:离开|进入|走进|来到|抵达|到达|过了|之后|第二天|小时)/u.test(header.join('。'))) return false
    if ((header[0] ?? '').includes('在') && !(header[0] ?? '').includes(location)) return false
    const frame = header[1] ?? ''
    if (/(?:远处|另一处|另一间|另一侧|隔着|远照|对面|别处)/u.test(frame)) return false
    const index = text.indexOf(frame) + frame.indexOf(location)
    return frame.includes(location) && /(?:光柱|光束)[^。！？!?；;\n]{0,120}(?:落在|照向)/u.test(frame) &&
      !/(?:没有|并未|未曾|不曾|不|没|未)/u.test(frame.slice(0, frame.indexOf(location))) && !quoteContains(text, index)
  })
  const deterministic = requirements.map((requirement) => deterministicBeatEvidence(requirement, text, scenePrefixHash, { actorHints, initialLocation, initialAgents: first?.agent ?? first?.actor ?? [] }))
  const merged = mergeBoundModelEvidence(contract, requirements, deterministic, opts.modelEvidence, scenePrefixHash, candidateText, candidateHash, scenePrefix)
  if (merged.invalid.length > 0) violations.push({ code: 'beat_evidence_invalid', severity: 'blocking', message: `场景语义证据未绑定到完整正文前缀或结构非法：${merged.invalid.join('、')}`, evidence: merged.invalid.slice(0, 8) })
  const missing = merged.evidence.filter((item) => item.status === 'missing')
  const uncertain = merged.evidence.filter((item) => item.status === 'uncertain')
  const contradicted = merged.evidence.filter((item) => item.status === 'contradicted')
  if (missing.length > 0) violations.push({ code: 'missing_required_beat', severity: 'advisory', message: `候选正文尚未提供这些推进点的结构化证据：${missing.map((item) => requirements.find((requirement) => requirement.beatId === item.beatId)?.source ?? item.beatId).join('；')}`, evidence: missing.map((item) => item.beatId).slice(0, 8) })
  if (uncertain.length > 0) violations.push({ code: 'beat_uncertain', severity: 'advisory', message: `这些推进点需要模型或用户确认，不能自动收尾：${uncertain.map((item) => item.beatId).join('、')}`, evidence: uncertain.map((item) => item.beatId).slice(0, 8) })
  if (contradicted.length > 0) violations.push({ code: 'beat_contradicted', severity: 'blocking', message: `候选正文明确否定、传闻化或改变了这些必需事件：${contradicted.map((item) => requirements.find((requirement) => requirement.beatId === item.beatId)?.source ?? item.beatId).join('；')}`, evidence: contradicted.map((item) => item.beatId).slice(0, 8) })
  const forbidden = contract.mustNotHappen.filter((fact) => includesText(text, fact))
  if (forbidden.length > 0) violations.push({ code: 'forbidden_fact', severity: 'blocking', message: `候选正文命中本场禁止发生项：${forbidden.join('；')}`, evidence: forbidden.slice(0, 4) })
  if (completed && sceneChars !== null) {
    if (sceneChars < contract.targetChars.min) violations.push({ code: 'target_underflow', severity: 'advisory', message: `场景正文 ${sceneChars} 字低于建议下限 ${contract.targetChars.min} 字`, evidence: [String(sceneChars)] })
    if (sceneChars > contract.targetChars.max) violations.push({ code: 'target_overflow', severity: 'advisory', message: `场景正文 ${sceneChars} 字超过建议上限 ${contract.targetChars.max} 字`, evidence: [String(sceneChars)] })
  }
  const status = violations.some((item) => item.severity === 'blocking') ? 'deviated' : violations.length > 0 ? 'advisory' : 'passed'
  return {
    schemaVersion: 1,
    contractId: contract.contractId,
    sceneId: contract.sceneId,
    sectionId: contract.sectionId,
    frozenHash: contract.frozenHash,
    // Candidate hashes use the same content-addressed bytes as manuscript
    // segments/artifacts so the evidence can be checked without knowing this
    // module's object-hash helper.
    candidateHash: hashText(text),
    candidateChars: codePointLength(text),
    sceneChars,
    completed,
    status,
    violations,
    scenePrefixHash,
    beatEvidence: merged.evidence,
    ...(opts.semanticReview === true ? { semanticReview: { version: opts.modelEvidence?.some(item => item && typeof item === 'object' && (item as SceneBeatModelEvidence).semanticVersion === 2) ? 2 as const : 1 as const, contractHash: contract.frozenHash, candidateHash, scenePrefixHash,
      unresolvedBeatIds: unique([...merged.evidence.filter(item => item.status !== 'satisfied').map(item => item.beatId), ...merged.invalid.filter(id => contract.requiredBeatIds.includes(id))], MAX_CONTRACTS) } } : {})
  }
}

/** Decide whether this complete candidate may commit its scene.  The ideal
 * character count is deliberately not a gate: required beats and hard
 * forbidden-item checks are the semantic boundary. */
export function buildSceneCompletionDecision(
  contract: SceneContract,
  candidate: string,
  input: { candidateSegmentId: string; evaluation?: SceneContractEvaluation; scenePrefix?: string; at?: number }
): SceneCompletionDecision {
  const candidateText = String(candidate ?? '')
  const scenePrefix = String(input.scenePrefix ?? '')
  const text = `${scenePrefix}${candidateText}`
  // An evaluation produced for only the candidate is stale once a scene
  // prefix is supplied.  Re-evaluate against the exact full prefix so a
  // deferred first chunk cannot be accidentally promoted by a later call.
  const expectedHash = hashText(text)
  const expectedPrefixHash = hashText(scenePrefix)
  const evaluation = input.evaluation && input.evaluation.candidateHash === expectedHash && input.evaluation.scenePrefixHash === expectedPrefixHash
    ? input.evaluation
    : evaluateSceneContract(contract, candidateText, { sceneChars: codePointLength(text), completed: true, scenePrefix })
  const requirements = structuredBeats(contract)
  const beatEvidence = evaluation.beatEvidence ?? requirements.map((requirement) => deterministicBeatEvidence(requirement, text, expectedPrefixHash))
  const satisfiedBeatIds = beatEvidence.filter((item) => item.status === 'satisfied').map((item) => item.beatId)
  const requiredBeatIds = contract.mustHappen.map((_beat, index) => contract.requiredBeatIds[index] ?? `${contract.sceneId}:beat:${index + 1}`)
  const missingBeatIds = requiredBeatIds.filter((id) => !satisfiedBeatIds.includes(id))
  const status: SceneCompletionDecision['status'] = missingBeatIds.length === 0 && !evaluation.violations.some((item) => item.severity === 'blocking') ? 'complete' : 'defer'
  const decisionBase = {
    schemaVersion: 1 as const,
    decisionId: `${contract.sceneId}:${input.candidateSegmentId}:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`,
    sceneId: contract.sceneId,
    contractId: contract.contractId,
    contractHash: contract.frozenHash,
    candidateSegmentId: input.candidateSegmentId,
    candidateHash: createHash('sha256').update(candidateText, 'utf8').digest('hex'),
    candidateCharCount: codePointLength(candidateText),
    status,
    requiredBeatIds,
    satisfiedBeatIds,
    missingBeatIds,
    decidedAt: input.at ?? Date.now(),
    scenePrefixHash: expectedPrefixHash,
    beatEvidence: beatEvidence.map((item) => ({
      beatId: item.beatId,
      scenePrefixHash: item.scenePrefixHash,
      status: item.status,
      actor: item.matched.actor,
      action: item.matched.action,
      object: item.matched.object,
      location: item.matched.location,
      result: item.matched.result,
      time: item.matched.time,
      agent: item.matched.agent,
      patient: item.matched.patient,
      sourceRole: item.matched.sourceRole,
      recipient: item.matched.recipient,
      beneficiary: item.matched.beneficiary,
      negation: item.negation,
      modality: item.modality,
      actuality: item.actuality,
      assertion: item.assertion,
      ...(item.eventGroups ? { eventGroups: item.eventGroups } : {}),
      ...(item.candidateHash ? { candidateHash: item.candidateHash } : {}),
      ...(item.spans ? { spans: item.spans.map(span => ({ ...span })) } : {}),
      ...(item.semanticVersion === 1 || item.semanticVersion === 2 ? { semanticVersion: item.semanticVersion, contractHash: item.contractHash, requiredSource: item.requiredSource, semanticEvents: item.semanticEvents, partEvidence: item.partEvidence } : {})
    }))
  }
  return { ...decisionBase, evidenceHash: createHash('sha256').update(JSON.stringify(decisionBase), 'utf8').digest('hex') }
}

export function buildSceneContractPrompt(contract: SceneContract, sceneChars?: number): string {
  const progress = typeof sceneChars === 'number' ? `\n本场已接受正文约 ${Math.max(0, Math.floor(sceneChars))} 字。` : ''
  const characters = contract.activeCharacterIds.length > 0 ? contract.activeCharacterIds.join('、') : '按已确认大纲选择必要角色'
  const must = contract.mustHappen.map((item, index) => `- ${index + 1}. ${cleanText(item, 500)}`).join('\n') || '- 无额外推进点，但必须完成场景目标'
  const structured = structuredBeats(contract).map((item, index) => [
    `${index + 1}. ${cleanText(item.source, 500)}`,
    `actor=${item.actor.join('|') || '未指定'}`,
    `agent=${item.agent?.join('|') || '未绑定（不得猜测）'}`,
    `patient=${item.patient?.join('|') || '未绑定'}`,
    `source=${item.sourceRole?.join('|') || '未绑定'}`,
    `recipient=${item.recipient?.join('|') || '未绑定'}`,
    `beneficiary=${item.beneficiary?.join('|') || '未绑定'}`,
    `action=${item.action.join('|') || '需从正文判断'}`,
    `events=${item.eventGroups?.map((group) => `${group.action}@${group.source}`).join(' || ') || '未识别'}`,
    `object=${item.object.join('|') || '未指定'}`,
    `location=${item.location.join('|') || '未指定'}`,
    `result=${item.result.join('|') || '未指定'}`,
    `time=${item.time.join('|') || '未指定'}`,
    `negation=${item.negation ? 'true' : 'false'}`,
    `modality=${item.modality}`,
    `actuality=${item.actuality}`,
    `assertion=${item.assertion}`
  ].join('; ')).join('\n') || '- 无'
  const forbidden = contract.mustNotHappen.map((item, index) => `- ${index + 1}. ${cleanText(item, 500)}`).join('\n') || '- 无明确禁止项'
  return [
    '## 当前 SceneContract（已冻结，只约束本场）',
    `契约版本：${contract.schemaVersion}；契约 id：${contract.contractId}；冻结哈希：${contract.frozenHash}`,
    `场景：${contract.sceneId} · ${contract.title}（第 ${contract.order} 场；大纲 revision ${contract.revision}）`,
    `场景目标：${contract.objective}`,
    `角色：${characters}${contract.povCharacterId ? `；视角角色：${contract.povCharacterId}` : ''}`,
    contract.locationId ? `地点：${contract.locationId}` : '',
    `欲望：${contract.desire}`,
    `冲突/阻碍：${contract.conflict}`,
    `必须发生或推进：\n${must}`,
    `结构化事件证据（确定性字段）：\n${structured}`,
    `禁止发生：\n${forbidden}`,
    `承接点：${contract.handoff}`,
    `目标字数范围：${contract.targetChars.min}–${contract.targetChars.max} 字（理想 ${contract.targetChars.ideal}）${progress}`,
    '只输出当前场景紧接正文的自然小说内容；不要解释契约、汇报进度、输出 JSON 或写下一场。必需事件必须写成实际发生；传闻、假设、梦境、回忆、计划或否定句不算完成。'
  ].filter(Boolean).join('\n')
}

export function buildSceneContractRepairInstruction(contract: SceneContract, evaluation: SceneContractEvaluation): string {
  const blocking = evaluation.violations.filter((item) => item.severity === 'blocking')
  const facts = blocking.map((item) => `- ${item.message}`).join('\n') || '- 当前候选未满足本场契约的硬边界'
  return [
    '[SceneContract 定向修复]',
    `契约 ${contract.contractId}（冻结哈希 ${contract.frozenHash}）的候选段已撤回，不属于 accepted 正文。`,
    facts,
    `只重写刚才的候选段，保持已接受正文不变；继续完成“${contract.objective}”，并承接：${contract.handoff}。`,
    `本场禁止发生：${contract.mustNotHappen.join('；') || '无'}`,
    '只输出修复后的正文，不解释修复过程，不输出 JSON 或字数说明。'
  ].join('\n')
}
