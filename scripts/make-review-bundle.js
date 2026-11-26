// 重新生成 docs/code-bundle.txt（Gate 0：恢复事实可信度）
// - 顶部写入当前 git commit/hash、生成时间、包含/排除项
// - 动态扫描当前 src/ 全部源码，避免手写文件列表过期
// 用法：node scripts/make-review-bundle.js
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'code-bundle.txt')

// ---- 收集文件：src/** + 根配置 + 关键脚本（排除 out/dist/node_modules/自身） ----
function collectFiles(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'out' || ent.name === 'dist' || ent.name === '.git') continue
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) collectFiles(abs, acc)
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(ent.name)) acc.push(abs)
  }
  return acc
}

const srcFiles = collectFiles(path.join(ROOT, 'src')).sort()
const extra = [
  'package.json',
  'electron.vite.config.ts',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'AGENTS.md',
  '.gitignore',
  '.gitattributes',
  ...collectFiles(path.join(ROOT, 'scripts')).sort()
]
// 排除自身与生成产物
const files = [...new Set([...srcFiles, ...extra])]
  .map((p) => path.relative(ROOT, p))
  .filter((p) => p !== path.relative(ROOT, OUT) && !p.startsWith('out'))
  .sort()

// ---- 头部信息 ----
let gitHead = '（无 git 信息）'
let gitStatus = ''
try {
  gitHead = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim()
  gitStatus = execSync('git status --short', { cwd: ROOT, encoding: 'utf-8' }).trim()
} catch {
  /* 非 git 环境 */
}
const excluded = ['node_modules/', 'out/', 'dist/', '.git/', '用户数据（userData/数据库/日志/密钥）', 'docs/code-bundle.txt 自身']

let out = []
out.push('='.repeat(100))
out.push('DeepWriter 全源码合并包 — 供 AI 审核')
out.push(`base git commit: ${gitHead}`)
out.push(`working tree: ${gitStatus ? `DIRTY（${gitStatus.split(/\r?\n/).length} 项；本包包含当前未提交源码）` : 'clean'}`)
if (gitStatus) {
  out.push('working tree entries:')
  for (const line of gitStatus.split(/\r?\n/)) out.push(`  ${line}`)
}
out.push(`生成时间：${new Date().toISOString()}`)
out.push(`包含：${files.length} 个文件（src/** + 根配置 + scripts/**，动态扫描）`)
out.push(`排除：${excluded.join('、')}`)
out.push('事实优先级：当前 src/ 与可复现行为 > 本包 > 历史整改文档。')
out.push('='.repeat(100))
out.push('')

let total = 0
for (const rel of files) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    out.push(`\n[!] 缺失文件: ${rel}\n`)
    continue
  }
  const content = fs.readFileSync(abs, 'utf-8')
  const lines = content.split('\n').length
  const chars = content.length
  total += chars
  out.push('')
  out.push('='.repeat(100))
  out.push(`文件: ${rel}  (${lines} 行 / ${chars.toLocaleString()} 字符)`)
  out.push('='.repeat(100))
  out.push(content.replace(/\r\n/g, '\n'))
}

fs.writeFileSync(OUT, out.join('\n'), 'utf-8')
console.log(`written docs/code-bundle.txt — ${files.length} 个文件 / ${(total / 1024).toFixed(1)} KB 源码 / base ${gitHead.slice(0, 12)} / ${gitStatus ? 'dirty' : 'clean'}`)
