import * as path from 'node:path'
import { canonicalMessagesForNovel, sessionTitleFromFirstMessage, buildDefaultDocumentPath } from '../src/main/novelSession'

interface Result {
  id: string
  name: string
  pass: boolean
  detail: string
}

const results: Result[] = []
function check(id: string, name: string, pass: boolean, detail: string): void {
  results.push({ id, name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${id} ${name} — ${detail}`)
}

function main(): void {
  const canonicalRows = [
    { role: 'user', content: '请写一个开场。' },
    { role: 'assistant', content: '夜雨落在旧车站。' },
    { role: 'tool', content: '不应进入小说素材' }
  ]
  const selected = canonicalMessagesForNovel(canonicalRows)
  check('R26-01', 'canonical SQLite 消息可供小说素材读取', selected.length === 2 && selected[0].content === '请写一个开场。' && selected[1].content === '夜雨落在旧车站。', `selected=${JSON.stringify(selected)}`)

  check('R26-02', '空白首条消息回退为新会话', sessionTitleFromFirstMessage('  \n\t ') === '新会话', `title=${sessionTitleFromFirstMessage('  \n\t ')}`)
  check('R26-03', '首条消息生成可读会话标题并限制长度', sessionTitleFromFirstMessage('  这是一个\n很长的创作目标，需要保留前面的语义  ').length <= 30 && sessionTitleFromFirstMessage('  这是一个\n很长的创作目标，需要保留前面的语义  ').includes('这是一个 很长的创作目标'), `title=${sessionTitleFromFirstMessage('  这是一个\n很长的创作目标，需要保留前面的语义  ')}`)

  const defaultPath = buildDefaultDocumentPath('C:\\Users\\tester\\Documents', '整理成书:第一章', 'md', '20260820_120000')
  check('R26-04', '导出默认路径直接使用用户目录且清理文件名', defaultPath === path.join('C:\\Users\\tester\\Documents', '整理成书_第一章_20260820_120000.md'), `path=${defaultPath}`)

  const failed = results.filter((r) => !r.pass)
  console.log(`===== maturity-wave1-tests: ${results.length - failed.length} PASS / ${failed.length} FAIL =====`)
  if (failed.length > 0) process.exit(1)
}

main()
