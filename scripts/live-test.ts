import { streamChat, longGenerate, classifyApiError } from '../src/main/deepseek'
import { buildToolSpecs, executeTool } from '../src/main/tools'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

const API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const BASE = 'https://opencode.ai/zen/go/v1'
const MODEL = 'deepseek-v4-flash'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function liveSimple(): Promise<void> {
  console.log('\n[L1] 真实 API：基础对话（流式）')
  let text = ''
  let usage: any = null
  const r = await streamChat(
    { apiKey: API_KEY, baseUrl: BASE, model: MODEL, messages: [{ role: 'user', content: '用一句话介绍你自己，说明你的模型名' }], thinking: { enabled: true, effort: 'low' }, maxTokens: 256 },
    (ev) => {
      if (ev.type === 'text') text += ev.delta ?? ''
      if (ev.type === 'done') usage = ev.usage
    }
  )
  check('收到非空回复', text.trim().length > 0, text.slice(0, 120))
  check('finish_reason=stop', r.finishReason === 'stop', String(r.finishReason))
  check('usage 完整（含缓存字段）', usage !== null && typeof usage.prompt_cache_hit_tokens === 'number', JSON.stringify(usage)?.slice(0, 200))
}

async function liveThinking(): Promise<void> {
  console.log('\n[L2] 真实 API：思考模式 reasoning_content')
  let reasoning = ''
  await streamChat(
    { apiKey: API_KEY, baseUrl: BASE, model: MODEL, messages: [{ role: 'user', content: '证明 7 是质数（简短回答）' }], thinking: { enabled: true, effort: 'low' }, maxTokens: 256 },
    (ev) => {
      if (ev.type === 'reasoning') reasoning += ev.delta ?? ''
    }
  )
  check('收到 reasoning_content', reasoning.trim().length > 0, reasoning.slice(0, 100))
}

async function liveLong(): Promise<void> {
  console.log('\n[L3] 真实 API：超长输出自动续写（maxTokens=96 强制截断）+ 无进展保护')
  let text = ''
  let reasoningSum = 0
  let rounds = 0
  const r = await longGenerate({
    params: { apiKey: API_KEY, baseUrl: BASE, model: MODEL, thinking: { enabled: true, effort: 'low' }, maxTokens: 96, temperature: 1 },
    messages: [{ role: 'user', content: '请写一个 500 字左右的微小说开头（尽量写长）' }],
    maxRounds: 6,
    onEvent: (ev) => {
      if (ev.type === 'text') text += ev.delta ?? ''
      if (ev.type === 'done' && ev.usage) reasoningSum += ev.usage.reasoning_tokens
    },
    onRound: (n) => {
      rounds = n
    }
  })
  check('发生了续写（rounds>=2）', rounds >= 2, `rounds=${rounds} len=${text.length}`)
  check('正文有产出或合理中断（no_progress）', text.length > 100 || r.finalFinishReason === 'no_progress', `final=${r.finalFinishReason} len=${text.length}`)
  check('无进展保护生效（不会死循环超轮数）', rounds <= 6, `rounds=${rounds}`)
  check('跨轮 usage 累计', reasoningSum >= 0 && r.totalUsage.total_tokens > 0, JSON.stringify(r.totalUsage).slice(0, 150))
}

async function liveTools(): Promise<void> {
  console.log('\n[L4] 真实 API：工具调用循环（list_files + read_file，沙箱内无弹窗）')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-live-'))
  fs.writeFileSync(path.join(tmp, 'hello.txt'), 'hello deepwriter', 'utf-8')
  const executed: { name: string; args: unknown }[] = []
  let finalText = ''
  const r = await longGenerate({
    params: {
      apiKey: API_KEY,
      baseUrl: BASE,
      model: MODEL,
      thinking: { enabled: true, effort: 'low' },
      maxTokens: 512,
      tools: buildToolSpecs(true),
      toolChoice: 'auto'
    },
    messages: [
      {
        role: 'user',
        content: `请先用 list_files 查看目录 ${tmp} 的结构，再用 read_file 读取 hello.txt 的内容，然后总结里面写了什么。`
      }
    ],
    maxRounds: 8,
    onEvent: (ev) => {
      if (ev.type === 'text') finalText += ev.delta ?? ''
    },
    onRound: () => undefined,
    executor: async (name, args) => {
      executed.push({ name, args })
      const res = await executeTool(name, args, tmp, { workDir: tmp, docDir: tmp, sessionId: 'live' })
      return `${res.message}${res.path ? `\n文件路径: ${res.path}` : ''}`
    }
  })
  check('工具被真实调用（list_files/read_file）', executed.some((e) => e.name === 'list_files') && executed.some((e) => e.name === 'read_file'), JSON.stringify(executed.map((e) => e.name)))
  check('工具结果回传后模型生成总结', finalText.includes('hello') || finalText.includes('deepwriter'), finalText.slice(0, 150))
  check('循环正常终止', r.finalFinishReason === 'stop', String(r.finalFinishReason))
}

async function liveCache(): Promise<void> {
  console.log('\n[L5] 真实 API：KV 缓存命中（相同前缀第二次请求）')
  const prefix = [
    { role: 'system', content: '你是 DeepWriter 创作助手。' + '固定设定：'.repeat(30) + '世界背景设定若干行以凑足前缀。'.repeat(20) },
    { role: 'system', content: '剧情引擎：三幕结构、情绪曲线、钩子纪律。'.repeat(30) }
  ] as any[]
  const req = {
    apiKey: API_KEY,
    baseUrl: BASE,
    model: MODEL,
    thinking: { enabled: false, effort: 'low' as const },
    maxTokens: 32,
    messages: [...prefix, { role: 'user', content: '你好' }]
  }
  let u1: any = null
  let u2: any = null
  await streamChat(req, (ev) => {
    if (ev.type === 'done') u1 = ev.usage
  })
  await streamChat(req, (ev) => {
    if (ev.type === 'done') u2 = ev.usage
  })
  const hit1 = u1?.prompt_cache_hit_tokens ?? 0
  const hit2 = u2?.prompt_cache_hit_tokens ?? 0
  check('第二次请求命中缓存', hit2 > 0, `第一次 hit=${hit1} 第二次 hit=${hit2}`)
  check('缓存命中占比合理', hit2 / (u2?.prompt_tokens ?? 1) > 0.5, `rate=${((hit2 / (u2?.prompt_tokens ?? 1)) * 100).toFixed(1)}%`)
}

async function liveError(): Promise<void> {
  console.log('\n[L6] 真实 API：错误分类（错误 key）')
  try {
    await streamChat(
      { apiKey: 'sk-invalid-key', baseUrl: BASE, model: MODEL, messages: [{ role: 'user', content: 'hi' }], thinking: { enabled: false, effort: 'low' } },
      () => undefined
    )
    check('无效 key 应抛错', false, '未抛错')
  } catch (e) {
    const info = classifyApiError(e)
    check('错误分类为 unauthorized', info.kind === 'unauthorized', JSON.stringify(info))
    check('中文文案可读', info.message.length > 5, info.message)
  }
}

async function liveNovel(): Promise<void> {
  console.log('\n[L7] 真实 API：一键成书（素材组装 → 整理请求 → 真实生成小说）')
  const { buildNovelMaterial, buildNovelRequest } = await import('../src/main/novel')
  const material = buildNovelMaterial([
    { role: 'user', content: '写一个青梅竹马的短篇，主角叫林默，女主叫苏晚。' },
    { role: 'assistant', content: '好的。林默是北方小城的高中生，苏晚是他邻居家女孩。设定：两人小时候约定长大后一起去海边。' },
    { role: 'user', content: '加个转折：高三那年苏晚家搬走了，约定没有兑现。' },
    { role: 'assistant', content: '收到。多年后林默在海边城市工作，偶遇了苏晚，她身边站着一个孩子……（待续）' }
  ])
  const msgs = buildNovelRequest(material.material)
  let text = ''
  const r = await longGenerate({
    params: { apiKey: API_KEY, baseUrl: BASE, model: MODEL, thinking: { enabled: false, effort: 'high' }, maxTokens: 2048, temperature: 0.9 },
    messages: msgs,
    maxRounds: 6,
    onEvent: (ev) => {
      if (ev.type === 'text') text += ev.delta ?? ''
    },
    onRound: () => undefined
  })
  check('素材包含全部对话片段', material.material.includes('林默') && material.material.includes('苏晚'))
  check('生成了小说正文', text.length > 100, `len=${text.length}`)
  check('正文含书名/章节结构标记', /^#\s|##\s/.test(text), text.slice(0, 120))
  check('叙事连贯（含人物名）', text.includes('林默') || text.includes('苏晚'), text.slice(0, 100))
  check('正常终止（stop，或 length=续写机制生效）', r.finalFinishReason === 'stop' || r.finalFinishReason === 'length', String(r.finalFinishReason))
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('请设置环境变量 DEEPSEEK_API_KEY')
    process.exit(2)
  }
  await liveSimple()
  await liveThinking()
  await liveLong()
  await liveTools()
  await liveCache()
  await liveError()
  await liveNovel()
  console.log(`\n===== 真实 API 验证：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('LIVE CRASH:', e)
  process.exit(1)
})
