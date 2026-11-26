export interface BuiltinExtension { id: string; name: string; kind: 'skill' | 'tool'; version: string; description: string; files: Record<string, string>; entry?: string }

// Source is bundled as auditable data; installation only writes its exact
// bytes. Nothing here runs during catalog discovery or install.
export const MANUSCRIPT_INSPECTOR = String.raw`'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const readline = require('node:readline')
const roots = JSON.parse(process.env.DEEPWRITER_PLUGIN_ROOTS_JSON || '[]')
const spec = {name:'count_manuscript',description:'读取授权目录中的UTF-8稿件，返回Unicode字数与SHA256；只读，不写文件。',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}
const reply = (id,result,error) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})})+'\n')
const lines = readline.createInterface({input:process.stdin,crlfDelay:Infinity})
lines.on('line', async line => {
  let q
  try {
    if(Buffer.byteLength(line)>65536) throw new Error('message_too_large')
    q=JSON.parse(line); if(q.id===undefined) return
    if(q.jsonrpc!=='2.0') throw new Error('invalid_jsonrpc')
    if(q.method==='initialize') {
      if(q.params?.protocolVersion!=='2025-11-25') throw new Error('unsupported_protocol')
      reply(q.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'deepwriter-manuscript-inspector',version:'1.0.0'}}); return
    }
    if(q.method==='tools/list'){reply(q.id,{tools:[spec]});return}
    if(q.method!=='tools/call'||q.params?.name!==spec.name) throw new Error('unsupported_method_or_tool')
    const args=q.params.arguments
    if(!args||typeof args.path!=='string'||Object.keys(args).some(k=>k!=='path')) throw new Error('invalid_arguments')
    const target=await fs.realpath(path.resolve(args.path))
    const normalize=p=>process.platform==='win32'?p.toLowerCase():p
    let allowed=false
    for(const root of roots){const real=await fs.realpath(root).catch(()=>null);if(real&&(normalize(target)===normalize(real)||normalize(target).startsWith(normalize(real)+path.sep)))allowed=true}
    if(!allowed) throw new Error('path_outside_authorized_roots')
    const stat=await fs.stat(target);if(!stat.isFile()||stat.size>64*1024*1024)throw new Error('unsupported_file_size_or_type')
    const bytes=await fs.readFile(target);if(bytes.length>64*1024*1024)throw new Error('file_size_changed')
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
    reply(q.id,{content:[{type:'text',text:JSON.stringify({path:target,chars:Array.from(text).length,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')})}],isError:false})
  }catch(error){if(q?.id!==undefined)reply(q.id,{content:[{type:'text',text:JSON.stringify({ok:false,message:error.message})}],isError:true})}
})
`

export const BUILTIN_EXTENSIONS: BuiltinExtension[] = [
  { id: 'deepwriter/structure-review', name: 'structure-review', kind: 'skill', version: '1.0.0', description: '检查稿件结构、主题推进和收束；不捏造事实。', files: {
    'SKILL.md': `---\nname: structure-review\ndescription: 用户要求结构审阅、检查大纲或稿件推进时使用。\nlicense: MIT\n---\n# 稿件结构审阅\n先重述用户原目标、篇幅及已确认大纲。逐段核对目标、推进、证据和结尾；不要替换已确认主题。引用具体原句说明缺口。完整检查标准在 references/checklist.md，只有任务需要时读取。若只是审阅，输出问题位置、原因及最小改法，不改文件；若请求写作，把结构检查用于实际正文。事实不充分时标注未知，不补造。\n`,
    'references/checklist.md': '核对四项：开篇提出明确任务；每段增加具体信息或行动；转折有可追踪依据；结尾回应开篇而非空泛升华。目标字数用Unicode code points检查，不凭视觉估计。\n'
  } },
  { id: 'deepwriter/prose-polish', name: 'prose-polish', kind: 'skill', version: '1.0.0', description: '克制的正文润色：保持事实、人物声音与原始意图。', files: {
    'SKILL.md': `---\nname: prose-polish\ndescription: 用户要求润色正文、减少空泛表达或保持人物声音时使用。\nlicense: MIT\n---\n# 克制正文润色\n先辨认原文事实、叙述视角、人物说话习惯及必须保留项。仅对重复、空泛、语序不清和无依据的拔高提出最小改动。不得新增人物、事件、证据或改变事件实际性。用户要正文时输出修订正文；用户只要建议时给具体引文和修改理由。需要示例时读取 references/examples.md；不能把参考例句当作用户事实。文件修改必须沿用宿主授权与写前检查点。\n`,
    'references/examples.md': '例：把“他内心充满复杂难言的情绪”改为任务已提供的具体动作；任务没提供动作时标注可补充，不自行编造。保留独特词汇和节奏，避免一律改成同一种模板。\n'
  } },
  { id: 'deepwriter/manuscript-inspector', name: 'manuscript-inspector', kind: 'tool', version: '1.0.0', description: '第一方只读Node stdio工具，实际计算稿件字数与SHA256。', entry: 'server.cjs', files: { 'server.cjs': MANUSCRIPT_INSPECTOR } }
]
