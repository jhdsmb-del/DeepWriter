import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildDefaultDocumentPath } from '../src/main/novelSession'
import { migrateLegacyDefaultDocDir } from '../src/main/settingsMigration'
import { createDiagnosticLogger, createFatalDiagnosticHandler, describeDiagnosticError, formatDiagnosticLine, sanitizeDiagnosticValue } from '../src/main/diagnostics'

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
  const documentsDir = path.join('C:\\Users\\tester', 'Documents')
  const legacy = path.join(documentsDir, 'DeepSeek Studio')
  const migrated = migrateLegacyDefaultDocDir(legacy, documentsDir)
  check('R27-01', '只迁移精确的旧默认文档目录', migrated.migrated && migrated.value === path.join(documentsDir, 'DeepWriter'), `result=${JSON.stringify(migrated)}`)

  const custom = path.join(documentsDir, 'Books')
  const untouched = migrateLegacyDefaultDocDir(custom, documentsDir)
  check('R27-02', '用户自定义文档目录保持不变', !untouched.migrated && untouched.value === custom, `result=${JSON.stringify(untouched)}`)

  const nestedLegacy = path.join(legacy, 'my-project')
  const nestedUntouched = migrateLegacyDefaultDocDir(nestedLegacy, documentsDir)
  check('R27-03', '旧目录下的用户子目录不被误迁移', !nestedUntouched.migrated && nestedUntouched.value === nestedLegacy, `result=${JSON.stringify(nestedUntouched)}`)

  const directPath = buildDefaultDocumentPath('D:\\Books', '第一章/草稿', 'md', '20260820_120000')
  check('R27-04', '导出默认文件直接落在用户选择的目录', directPath === path.join('D:\\Books', '第一章_草稿_20260820_120000.md'), `path=${directPath}`)

  const sensitive = sanitizeDiagnosticValue({
    apiKey: 'sk-live-secret-123456789',
    authorization: 'Bearer token-value',
    requestBody: { messages: [{ role: 'user', content: '完整请求正文不应落盘' }] },
    detail: 'Bearer another-token and sk-live-secret-987654321'
  })
  const serialized = JSON.stringify(sensitive)
  check('R27-05', '诊断序列化脱敏密钥与完整请求正文', !serialized.includes('live-secret') && !serialized.includes('完整请求正文') && serialized.includes('[REDACTED]'), `safe=${serialized}`)

  const ordinaryError = describeDiagnosticError(Object.assign(new Error('ENOENT: cannot open file'), { stack: 'Error: ENOENT: cannot open file\n    at safeRead (app.js:1:1)' }))
  const errorLine = formatDiagnosticLine({ type: 'uncaughtException', error: ordinaryError }, 1)
  check('R27-06', '普通错误消息保留且 stack 首行移除', errorLine.includes('ENOENT: cannot open file') && !errorLine.includes('Error: ENOENT') && errorLine.includes('safeRead'), `line=${errorLine.trim()}`)

  const requestText = sanitizeDiagnosticValue({ detail: 'request body: {"messages":[{"role":"user","content":"完整 prompt 不应落盘"}]}' })
  const requestLine = JSON.stringify(requestText)
  check('R27-07', '任意字符串中的 body/prompt/messages 内容均 fail-closed', !requestLine.includes('完整 prompt') && !requestLine.includes('messages') && requestLine.includes('request body: [REDACTED]'), `safe=${requestLine}`)

  let fatalRecords = 0
  let quitCalls = 0
  const fatal = createFatalDiagnosticHandler(() => { fatalRecords += 1 }, () => { quitCalls += 1 })
  fatal({ type: 'uncaughtException', error: { name: 'Error', message: 'first' } })
  fatal({ type: 'unhandledRejection', error: { name: 'Error', message: 'second' } })
  check('R27-08', 'fatal 诊断退出只触发一次', fatalRecords === 1 && quitCalls === 1, `records=${fatalRecords} quits=${quitCalls}`)

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-r27-'))
  try {
    const logger = createDiagnosticLogger({ dir: tempDir, maxBytes: 1024, maxFiles: 3 })
    for (let i = 0; i < 40; i += 1) logger.record({ type: 'render-process-gone', sequence: i, detail: 'bounded diagnostic event' })
    logger.record({ type: 'unhandledRejection', error: { message: 'sk-live-secret-123456789', requestBody: 'do not store' } })
    const files = fs.readdirSync(tempDir).filter((file) => file.startsWith('app.log')).sort()
    const contents = files.map((file) => fs.readFileSync(path.join(tempDir, file), 'utf8')).join('')
    check('R27-09', '诊断日志有上限并按编号轮转', files.length >= 2 && files.length <= 3 && !files.some((file) => /\.3$/u.test(file)) && contents.length > 0, `files=${files.join(',')}`)
    check('R27-10', '轮转日志仍不包含敏感内容', !contents.includes('live-secret') && !contents.includes('do not store'), `bytes=${Buffer.byteLength(contents, 'utf8')}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  const failed = results.filter((result) => !result.pass)
  console.log(`===== maturity-wave2-tests: ${results.length - failed.length} PASS / ${failed.length} FAIL =====`)
  if (failed.length > 0) process.exit(1)
}

main()
