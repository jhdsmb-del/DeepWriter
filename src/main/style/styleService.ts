import { createHash } from 'crypto'
import {
  segmentText,
  splitChunksByParagraph,
  dedupeChunks,
  collectFrequentNames,
  maskContent,
  splitCorpusByChapter,
  textStats,
  buildStylometryProfile,
  retrieveExemplars,
  evaluateCandidate,
  rankCandidates,
  scoreStylometry
} from '../../shared/styleV2'
import type {
  CorpusChunk,
  MetricDistribution,
  StylometryProfile,
  ExemplarPair,
  ContentSkeleton,
  StyleGenTask,
  StyleJobState,
  StyleCandidate,
  RevisionRequest
} from '../../shared/styleV2'
import { createExemplarStore, createStyleJobStore } from './styleJobStore'
import type { ExemplarStore, StyleJobStore } from './styleJobStore'
import { extractSkeleton, generateCandidate, reviseSpan, evaluateWithModel } from './modelCalls'
import type { ApiCtx } from './modelCalls'
import { estimateTokens } from '../../shared/types'
import { isCreativeAuthError, type CreativeApi, type CreativeStage } from '../creativeModel'

export interface StyleServiceOpts {
  baseDir: string
  getApi: (stage?: CreativeStage) => CreativeApi | Promise<CreativeApi>
  onJobUpdate?: (job: StyleJobState) => void
}

export interface BuildProfileResult {
  profileId: string
  profile: StylometryProfile
  stats: { effectiveChars: number; chunks: number; splits: Record<string, number>; scenes: number; forbiddenCount: number }
}

export interface StyleService {
  buildProfile(sourceTexts: { name: string; text: string }[], opts?: { backgroundTexts?: { name: string; text: string }[] }): Promise<BuildProfileResult>
  buildExemplars(profileId: string, onProgress?: (done: number, total: number) => void): Promise<{ count: number; failedCount: number }>
  startJob(profileId: string, task: StyleGenTask): Promise<{ jobId: string }>
  getJob(jobId: string): Promise<StyleJobState | null>
  stopJob(jobId: string): void
  chooseCandidate(jobId: string, candidateId: string): Promise<StyleJobState | null>
  revise(jobId: string, revision: { candidateId: string; spanText: string } & RevisionRequest): Promise<StyleJobState | null>
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const PROFILE_DIST_FIELDS: (keyof StylometryProfile)[] = ['sentenceLen', 'paraLen', 'sentenceVar', 'dialogueRatio', 'exclamRatio', 'ellipsisDensity', 'punctDensity', 'actionDensity', 'psychDensity', 'sensoryDensity', 'colorDensity', 'idiomDensity', 'firstPersonRatio']

function meanOf(values: number[]): number {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function chunkSceneType(st: ReturnType<typeof textStats>): string {
  const dia = meanOf(st.diaRatios)
  const action = meanOf(st.actionDens)
  const psych = meanOf(st.psychDens)
  const sensory = meanOf(st.sensoryDens)
  if (dia > 0.45) return '对白密集'
  if (action > 6) return '动作战斗'
  if (psych > 5) return '内心独白'
  if (sensory > 4) return '环境描写'
  return '叙述'
}

function nameCharCoverage(text: string, phrases: Iterable<string>): number {
  const total = [...text].length
  if (total === 0) return 0
  let covered = 0
  for (const p of phrases) {
    if (p.length < 2) continue
    let i = 0
    while ((i = text.indexOf(p, i)) !== -1) {
      covered += [...p].length
      i += p.length
    }
  }
  return Math.min(1, covered / total)
}

function computeDistinctiveness(a: StylometryProfile, b: StylometryProfile): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of PROFILE_DIST_FIELDS) {
    const da = a[f] as MetricDistribution
    const db = b[f] as MetricDistribution
    const denom = Math.max(1e-9, db.std)
    out[f] = Math.round((Math.abs(da.mean - db.mean) / denom) * 100) / 100
  }
  for (const k of Object.keys(a.dialogueNext)) {
    const denom = Math.max(1e-9, Math.abs(b.dialogueNext[k] ?? 0) + 0.05)
    out[`dialogueNext.${k}`] = Math.round((Math.abs((a.dialogueNext[k] ?? 0) - (b.dialogueNext[k] ?? 0)) / denom) * 100) / 100
  }
  return out
}

function ruleLines(profile: StylometryProfile): string[] {
  const d = profile.sentenceLen
  const rules: string[] = []
  rules.push(`句子长度：目标句均 ${d.mean} 字（P25 ${d.p25} / P50 ${d.p50} / P75 ${d.p75}），长句与短句按作者习惯交替（变异系数约 ${profile.sentenceVar.mean}）`)
  rules.push(`段落长度：目标段均 ${profile.paraLen.mean} 字（P25 ${profile.paraLen.p25} / P75 ${profile.paraLen.p75}），单句段比例按作者习惯`)
  rules.push(`对白占比：目标约 ${(profile.dialogueRatio.mean * 100).toFixed(0)}%（对白后接动作 ${(profile.dialogueNext.action * 100).toFixed(0)}% / 心理 ${(profile.dialogueNext.psych * 100).toFixed(0)}% / 环境 ${(profile.dialogueNext.sensory * 100).toFixed(0)}% / 叙述 ${(profile.dialogueNext.narrative * 100).toFixed(0)}% / 留白 ${(profile.dialogueNext.none * 100).toFixed(0)}%）`)
  rules.push(`标点密度：每千字约 ${profile.punctDensity.mean} 个；感叹句占比约 ${(profile.exclamRatio.mean * 100).toFixed(0)}%；省略号每千字 ${profile.ellipsisDensity.mean}`)
  rules.push(`描写配比（每千字）：动作 ${profile.actionDensity.mean} / 心理 ${profile.psychDensity.mean} / 感官 ${profile.sensoryDensity.mean} / 色彩 ${profile.colorDensity.mean}`)
  rules.push(`人称：第一人称占比 ${(profile.firstPersonRatio.mean * 100).toFixed(0)}%`)
  return rules
}

export function createStyleService(opts: StyleServiceOpts): StyleService {
  const exemplars = createExemplarStore(opts.baseDir)
  const jobs = createStyleJobStore(opts.baseDir)
  const aborts = new Map<string, AbortController>()

  /** 从 run 开始时的 api 快照构造上下文（运行中修改设置不影响进行中的 job） */
  const ctxFrom = (api: CreativeApi, extra?: { signal?: AbortSignal }): ApiCtx => ({ ...api, signal: extra?.signal })

  const saveJob = async (job: StyleJobState): Promise<void> => {
    await jobs.saveJob(job)
    opts.onJobUpdate?.(job)
  }

  return {
    async buildProfile(sourceTexts, opts) {
      const sections: { work?: string; workTitle: string; chapterOrdinal: number; text: string }[] = []
      let chapterSeq = 0
      for (const s of sourceTexts) {
        for (const sec of segmentText(s.text)) {
          chapterSeq++
          // 修复：不再把 workTitle 覆盖为作品名（保留章节标题用于 group-aware 切分），
          // 作品维度放在 work 字段；单文件整本书 → 每章一组 → 能切出 example/holdout
          sections.push({ work: s.name, workTitle: sec.workTitle, chapterOrdinal: chapterSeq, text: sec.text })
        }
      }
      const withHash = splitChunksByParagraph(sections).map((p) => ({ ...p, sha256: sha(p.text) }))
      const metaOf = new Map<string, { work?: string; workTitle: string; chapterOrdinal: number }>()
      for (const p of withHash) {
        if (!metaOf.has(p.sha256)) metaOf.set(p.sha256, { work: p.work, workTitle: p.workTitle, chapterOrdinal: p.chapterOrdinal })
      }
      const deduped = dedupeChunks(withHash)
      const names = collectFrequentNames(deduped)
      const meta = (c: { sha256: string }): { work?: string; workTitle: string; chapterOrdinal: number } => metaOf.get(c.sha256) ?? { work: '未命名', workTitle: '未命名', chapterOrdinal: 1 }
      const sourceIdx = new Map<string, number>()
      for (const c of deduped) {
        const w = meta(c).work ?? meta(c).workTitle
        if (!sourceIdx.has(w)) sourceIdx.set(w, sourceIdx.size)
      }
      const splitTags = splitCorpusByChapter(deduped.map((c) => ({ work: meta(c).work, workTitle: meta(c).workTitle, chapterOrdinal: meta(c).chapterOrdinal })))
      const chunks: CorpusChunk[] = deduped.map((c, i) => {
        const m = meta(c)
        const st = textStats(c.text)
        const si = sourceIdx.get(m.work ?? m.workTitle) ?? 0
        return {
          id: `c_${si}_${m.chapterOrdinal}_${i}`,
          sourceId: `src_${si}`,
          sourceName: m.work ?? m.workTitle,
          workTitle: m.workTitle,
          chapterOrdinal: m.chapterOrdinal,
          sectionIndex: i,
          text: c.text,
          maskedText: maskContent(c.text, names),
          charCount: [...c.text].length,
          split: splitTags[i].split,
          sceneType: chunkSceneType(st),
          narrativeFunctions: [],
          dialogueRatio: Math.round(meanOf(st.diaRatios) * 1000) / 1000,
          sha256: c.sha256
        }
      })
      const profileChunks = chunks.filter((c) => c.split === 'profile')
      const base = buildStylometryProfile(profileChunks.map((c) => textStats(c.text)))
      const sceneCoverage: Record<string, number> = {}
      const effectiveChars = chunks.reduce((a, c) => a + c.charCount, 0)
      for (const c of chunks) sceneCoverage[c.sceneType] = (sceneCoverage[c.sceneType] ?? 0) + 1
      let coveredTotal = 0
      for (const c of chunks) coveredTotal += Math.min(c.charCount, Math.round(nameCharCoverage(c.text, names) * c.charCount))
      const topicLeakageRisk = effectiveChars > 0 ? Math.round(Math.min(1, coveredTotal / effectiveChars) * 1000) / 1000 : 0
      const sentMeans = profileChunks.map((c) => meanOf(textStats(c.text).sentLens))
      const sm = meanOf(sentMeans)
      const sd = sentMeans.length > 1 ? Math.sqrt(sentMeans.reduce((a, b) => a + (b - sm) * (b - sm), 0) / (sentMeans.length - 1)) : 0
      const crossChapterStability = Math.round((1 / (1 + (sm > 0 ? sd / sm : 0))) * 1000) / 1000
      const quality = {
        effectiveChars,
        sceneCoverage,
        crossChapterStability,
        topicLeakageRisk,
        confidence: Math.round(Math.min(1, effectiveChars / 50000) * 1000) / 1000
      }
      let backgroundBaselineId: string | undefined
      let distinctiveness: Record<string, number> | undefined
      if (opts?.backgroundTexts && opts.backgroundTexts.length > 0) {
        backgroundBaselineId = `bg_${sha(opts.backgroundTexts.map((b) => b.text).join('\n')).slice(0, 12)}`
        const bg = buildStylometryProfile(opts.backgroundTexts.map((b) => textStats(b.text)))
        distinctiveness = computeDistinctiveness(base, bg)
      }
      const profile: StylometryProfile = { ...base, quality: { ...quality, backgroundBaselineId, distinctiveness } }
      const profileId = `spv2_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      await exemplars.saveCorpus(profileId, chunks)
      await exemplars.saveProfile(profileId, profile)
      await exemplars.saveForbidden(profileId, [...names].slice(0, 40))
      const splitCounts: Record<string, number> = { profile: 0, example: 0, holdout: 0 }
      for (const c of chunks) splitCounts[c.split]++
      return {
        profileId,
        profile,
        stats: {
          effectiveChars,
          chunks: chunks.length,
          splits: splitCounts,
          scenes: chunks.length,
          forbiddenCount: names.size
        }
      }
    },

    async buildExemplars(profileId, onProgress) {
      const corpus = await exemplars.getCorpus(profileId)
      const exampleChunks = corpus.filter((c) => c.split === 'example').slice(0, 20)
      const profile = await exemplars.getProfile(profileId)
      const forbidden = await exemplars.getForbidden(profileId)
      const api = exampleChunks.length ? await opts.getApi('planning') : null
      const pairs: ExemplarPair[] = []
      let done = 0
      let failed = 0
      for (const chunk of exampleChunks) {
        try {
          const { skeleton, usageTokens } = await extractSkeleton(ctxFrom(api!), chunk.text)
          void usageTokens
          const st = textStats(chunk.text)
          const repr = profile ? scoreStylometry(chunk.text, profile).score : 0.5
          pairs.push({
            id: `ex_${chunk.id}`,
            chunkId: chunk.id,
            skeleton,
            sceneType: chunk.sceneType || '叙述',
            narrativeFunctions: chunk.narrativeFunctions,
            dialogueRatio: chunk.dialogueRatio,
            representativeness: Math.round(repr * 100) / 100,
            leakageRisk: Math.round(nameCharCoverage(chunk.text, forbidden) * 1000) / 1000
          })
        } catch (error) {
          if (isCreativeAuthError(error)) throw error
          failed++ // 不再静默吞错：失败数随结果返回，调用方可感知降级
        }
        done++
        onProgress?.(done, exampleChunks.length)
      }
      await exemplars.saveExemplars(profileId, pairs)
      return { count: pairs.length, failedCount: failed }
    },

    async startJob(profileId, task) {
      const profile = await exemplars.getProfile(profileId)
      if (!profile) throw new Error('画像不存在，请先构建')
      const jobId = `sj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const abort = new AbortController()
      // 配置快照：job 固化 model/prompt/profile/source hashes；运行中改设置不影响本 job
      const api = await opts.getApi('draft')
      const reviewApi = task.fidelity === 'light' ? null : await opts.getApi('review')
      aborts.set(jobId, abort)
      const corpus = await exemplars.getCorpus(profileId)
      const job: StyleJobState = {
        jobId,
        profileId,
        task,
        stage: 'skeleton',
        skeleton: null,
        exemplarIds: [],
        candidates: [],
        evaluations: [],
        usageTokens: { skeleton: 0, candidates: 0, revise: 0, total: 0 },
        configSnapshot: {
          model: api.model,
          baseUrl: api.baseUrl,
          providerVersion: api.provider?.protocol ?? api.provider?.adapterId ?? 'legacy.deepseek',
          profileHash: sha(JSON.stringify(profile)),
          sourceHashes: corpus.map((c) => c.sha256),
          createdAt: Date.now()
        }
      }
      await saveJob(job)
      void runJob(job, abort.signal, api, reviewApi)
      return { jobId }
    },

    async getJob(jobId) {
      return jobs.getJob(jobId)
    },

    stopJob(jobId) {
      aborts.get(jobId)?.abort()
    },

    async chooseCandidate(jobId, candidateId) {
      const job = await jobs.getJob(jobId)
      if (!job) return null
      // Gate 4：candidate 必须属于当前 job（防 UI/调用方传任意 id）
      if (!job.candidates.some((c) => c.id === candidateId)) {
        throw new Error(`candidate ${candidateId} 不属于当前 job ${jobId}，拒绝选择`)
      }
      job.chosenCandidateId = candidateId
      await saveJob(job)
      return job
    },

    async revise(jobId, revision) {
      const job = await jobs.getJob(jobId)
      if (!job) return null
      const cand = job.candidates.find((c) => c.id === revision.candidateId)
      if (!cand) throw new Error(`候选 ${revision.candidateId} 不存在或不属于当前 job`)
      // Gate 4：base span 校验——候选内容已漂移（修订范围与当前文本不一致）则拒绝
      const normSpan = cand.text.slice(revision.spanStart, revision.spanEnd).replace(/\s+/g, '')
      const normReq = (revision.spanText ?? '').replace(/\s+/g, '')
      if (!normSpan || normSpan !== normReq) {
        throw new Error('spanText 与候选当前内容不一致（文本已漂移），拒绝修订')
      }
      if (revision.spanStart < 0 || revision.spanEnd > cand.text.length || revision.spanEnd < revision.spanStart) {
        throw new Error('修订范围越界，拒绝修订')
      }
      const forbidden = await exemplars.getForbidden(job.profileId)
      // revise 是用户主动发起的新模型调用，使用当前设置（与 runJob 的运行中快照语义不同）
      const r = await reviseSpan(ctxFrom(await opts.getApi('polish')), { spanStart: revision.spanStart, spanEnd: revision.spanEnd, preserveFacts: revision.preserveFacts, failedRules: revision.failedRules, leftContext: revision.leftContext, rightContext: revision.rightContext }, revision.spanText, forbidden)
      job.usageTokens.revise += r.usageTokens
      job.usageTokens.total += r.usageTokens
      const before = cand.text
      cand.text = before.slice(0, revision.spanStart) + r.text + before.slice(revision.spanEnd)
      cand.charCount = [...cand.text].length
      await saveJob(job)
      return job
    }
  }

  /** sceneType → 默认叙事功能（narrativeFunctions 未提供时使用，不再恒为空） */
  function defaultNarrativeFunctions(sceneType: string): string[] {
    const t = sceneType || '叙述'
    if (t.includes('对白') || t.includes('对话')) return ['对白互动', '话轮推进', '潜台词暗示']
    if (t.includes('动作') || t.includes('战斗')) return ['动作推进', '环境切换', '冲突升级']
    if (t.includes('内心') || t.includes('独白')) return ['内心独白', '情感转折', '回忆闪回']
    if (t.includes('环境') || t.includes('描写')) return ['环境渲染', '感官细节', '氛围铺垫']
    return ['叙述推进', '事件展开', '段落过渡']
  }

  async function runJob(job: StyleJobState, signal: AbortSignal, api: CreativeApi, reviewApi: CreativeApi | null): Promise<void> {
    try {
      const profile = await exemplars.getProfile(job.profileId)
      if (!profile) throw new Error('画像不存在')

      job.stage = 'skeleton'
      // skeleton 至少携带任务提取的意图与默认叙事功能（不再只是复制 task 字段后恒为空数组）
      job.skeleton = {
        facts: job.task.requiredFacts,
        eventOrder: [],
        pov: job.task.pov,
        emotionalArc: job.task.emotionalArc,
        paragraphFunctions: job.task.narrativeFunctions.length > 0 ? job.task.narrativeFunctions : defaultNarrativeFunctions(job.task.sceneType),
        dialogueIntents: []
      }
      await saveJob(job)

      job.stage = 'retrieving'
      const allPairs = await exemplars.getExemplars(job.profileId)
      const picked = retrieveExemplars(allPairs, job.task, 3)
      job.exemplarIds = picked.map((p) => p.id)
      await saveJob(job)

      job.stage = 'generating'
      const corpus = await exemplars.getCorpus(job.profileId)
      const rules = ruleLines(profile)
      const forbidden = await exemplars.getForbidden(job.profileId)
      const variants: ('A' | 'B' | 'C')[] = job.task.fidelity === 'light' ? ['A'] : job.task.fidelity === 'balanced' ? ['A', 'B'] : ['A', 'B', 'C']
      const candidates: StyleCandidate[] = []
      for (const v of variants) {
        if (signal.aborted) {
          const ce = new Error('已取消')
          ce.name = 'CancelledError'
          throw ce
        }
        try {
          const r = await generateCandidate({
            ctx: ctxFrom(api, { signal }),
            variant: v,
            task: {
              sceneType: job.task.sceneType,
              narrativeFunctions: job.task.narrativeFunctions,
              pov: job.task.pov,
              emotionalArc: job.task.emotionalArc,
              targetChars: job.task.targetChars,
              userPrompt: job.task.userPrompt,
              outputFormat: job.task.outputFormat
            },
            skeleton: job.skeleton,
            rules,
            exemplarPairs: picked.map((p) => ({
              skeleton: p.skeleton,
              surfaceText: corpus.find((c) => c.id === p.chunkId)?.text ?? ''
            })),
            forbiddenPhrases: forbidden
          })
          job.usageTokens.candidates += r.usageTokens
          job.usageTokens.total += r.usageTokens
          candidates.push({ id: `cand_${v}`, variant: v, text: r.text, charCount: [...r.text].length })
        } catch (e) {
          if ((e as Error).name === 'AbortError' || isCreativeAuthError(e)) throw e
          /* 单候选失败继续 */
        }
      }
      if (candidates.length === 0) throw new Error('所有候选生成失败')
      job.candidates = candidates
      await saveJob(job)

      job.stage = 'scoring'
      // Gate 4：防复制对照为 profile/example/holdout 全语料（不再只查前 5 个 holdout）；
      // 总量上限 800KB 防性能退化，按 profile→example→holdout 顺序截断
      let budget = 800 * 1024
      const antiCopySources: { text: string; sourceName: string }[] = []
      for (const split of ['profile', 'example', 'holdout'] as const) {
        for (const c of corpus.filter((x) => x.split === split)) {
          if (budget <= 0) break
          const t = c.text.slice(0, budget)
          antiCopySources.push({ text: t, sourceName: c.sourceName })
          budget -= t.length
        }
      }
      const evaluations = candidates.map((c) => {
        const ev = evaluateCandidate(c.text, {
          profile,
          requiredFacts: job.task.requiredFacts,
          forbiddenFacts: job.task.forbiddenFacts,
          sources: antiCopySources,
          forbiddenPhrases: forbidden
        })
        return { ...ev, candidateId: c.id }
      })
      job.evaluations = rankCandidates(evaluations)
      if (job.task.fidelity !== 'light') {
        for (let i = 0; i < candidates.length; i++) {
          const m = await evaluateWithModel(ctxFrom(reviewApi!, { signal }), candidates[i].text, corpus.filter((c) => c.split === 'holdout').slice(0, 2).map((h) => h.text))
          if (m) {
            const ev = job.evaluations.find((e) => e.candidateId === candidates[i].id)
            if (ev) ev.naturalnessScore = Math.round(((ev.naturalnessScore + m.naturalness) / 2) * 1000) / 1000
          }
        }
        job.evaluations = rankCandidates(job.evaluations)
      }
      await saveJob(job)

      job.stage = 'done'
      await saveJob(job)
    } catch (e) {
      const err = e as Error
      const cancelled = err.name === 'AbortError' || err.name === 'CancelledError'
      job.stage = cancelled ? 'cancelled' : 'failed'
      job.error = cancelled ? '已取消' : err.message
      await saveJob(job)
    } finally {
      aborts.delete(job.jobId)
    }
  }
}

export function estimateJobTokens(text: string): number {
  return estimateTokens(text)
}
