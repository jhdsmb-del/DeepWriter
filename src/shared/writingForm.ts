/** A form is a writing assignment, not its subject. An ambiguous request
 * keeps the format question; a direct interview answer overrides the guess. */
export type WritingForm = 'narrative' | 'expository' | 'open'

const fiction = /小说|短篇故事|故事|剧本|童话|寓言|叙事创作|\b(?:novel|fiction|screenplay|short story)\b/i
const article = /说明文|说明书|说明文章|论说文|议论文|论述|非虚构|指南|手册|教程|科普|论文|报告|分析文章|评论文章|书评|影评|社论|通讯稿|调查报道|操作说明|\b(?:nonfiction|guide|essay|report|tutorial|manual)\b/i
function declared(text: string): WritingForm {
  const a = article.test(text), n = fiction.test(text)
  if (a && n) {
    if (/(?:小说|故事|剧本)[^，。；;]{0,28}(?:指南|手册|教程|报告|论文|书评|评论文章|分析文章)\s*$/u.test(text)) return 'expository'
    if (/(?:改写|改编|写|创作)(?:成|为)(?:一[篇部个出])?(?:短篇)?(?:小说|故事|剧本)/u.test(text)) return 'narrative'
    return 'open'
  }
  return a ? 'expository' : n ? 'narrative' : 'open'
}
export function inferWritingForm(input: { task: string; kind?: string; genre?: string }): WritingForm {
  const explicit = declared(input.kind ?? '')
  if (explicit !== 'open') return explicit
  const head = input.task.split(/(?:参考资料|参考素材|原文|以下素材|原稿)[：:]|\x60{3}/u)[0].slice(0, 700)
    .replace(/《[^》]*》|“[^”]*”|「[^」]*」/gu, ' ')
  const clauses = head.split(/[，,。！？!?；;：:\n]/u).map(s => s.trim()).filter(s => s && !/^(?:不(?:要|是|写|必|需)|不能|别|避免|并非)/u.test(s))
  const requests = clauses.filter(s => /写|撰|编|创作|整理|交付|分析|比较|解读|解释|拟定|制作|生成|\b(?:write|draft|create)\b/i.test(s))
  for (const s of requests.length ? requests : clauses.filter(s => s.length <= 12)) {
    // Analytical verbs can name fiction as source material, not as the deliverable.
    if (/^(?:请|请你|帮我|为我)?(?:分析|比较|解读|点评|解释|介绍)/u.test(s) && !/(?:写成|改编成|改写成)/u.test(s)) return 'expository'
    const form = declared(s.replace(/(?:不要|不需要|而非|而不是|不是要|别写).*$/u, ''))
    if (form !== 'open') return form
  }
  const genre = input.genre ?? ''
  if (/(?:分析|复盘|评论|述评|调研)$/u.test(genre.trim())) return 'expository'
  const selected = declared(genre)
  return selected !== 'open' ? selected : /^(?:Galgame|悬疑|奇幻|科幻|言情|武侠|恋爱)(?:$|[ ·])/i.test(genre) ? 'narrative' : 'open'
}
