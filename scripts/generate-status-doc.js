// 从 docs/status.json 生成 docs/STATUS.md（Gate 0：唯一状态表）
// 用法：node scripts/generate-status-doc.js
// Markdown 状态表禁止手写；任何状态变更只允许修改 status.json 后重新生成。
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'docs', 'status.json')
const OUT = path.join(ROOT, 'docs', 'STATUS.md')

const data = JSON.parse(fs.readFileSync(SRC, 'utf-8'))
const items = data.items

const lines = []
lines.push('# DeepWriter 历史整改状态表')
lines.push('')
lines.push('> 这是历史评审基线，保留原始状态与证据；当前分支的检查见 [VALIDATION](VALIDATION.md) 和 GitHub Actions。')
lines.push('> 本文件由 `scripts/generate-status-doc.js` 从 `docs/status.json` 自动生成，禁止手写。')
lines.push('> 状态枚举：`unstarted / partial / implemented / verified / released`。verified 必须引用通过的行为测试 ID；released 必须引用安装包 hash 与平台矩阵。')
lines.push('')
lines.push('## 基线')
lines.push('')
lines.push('| 检查项 | 结果 |')
lines.push('|---|---|')
lines.push(`| Node/Web typecheck | ${data.baseline.typecheck} |`)
lines.push(`| scripts/verify.ts | ${data.baseline.verify} |`)
lines.push(`| electron-vite build | ${data.baseline.build} |`)
lines.push(`| Gate 0 回归（G0-1/2/3） | ${data.baseline.gate0Regressions ?? '历史记录未填写'} |`)
lines.push('')
lines.push('## 状态清单')
lines.push('')
lines.push('| ID | 状态 | implementationLevel | evidenceClass | 项 | 测试证据 | commit | 备注 |')
lines.push('|---|---|---|---|---|---|')
for (const it of items) {
  const testIds = it.testIds.length > 0 ? it.testIds.join(', ') : '—'
  const lvl = it.implementationLevel ?? '—'
  const evc = it.evidenceClass ?? '—'
  lines.push(`| ${it.id} | ${it.state} | ${lvl} | ${evc} | ${it.title} | ${testIds} | ${it.commit} | ${it.notes.replace(/\|/g, '\\|')} |`)
}
lines.push('')
lines.push('## 完成定义提醒')
lines.push('')
lines.push('- “完成”不是 TypeScript 通过或函数存在：单元、IPC contract、Electron E2E、攻击回归、崩溃恢复和 golden project 全部通过才能标 `verified`。')
lines.push('- 只有安装 artifact 通过发布矩阵才能标 `released`。')
lines.push('- 不得删除/放宽测试、吞异常、把失败改 warning、或通过改文档数字伪造完成。')

fs.writeFileSync(OUT, lines.join('\n'), 'utf-8')
console.log(`written docs/STATUS.md — ${items.length} items`)
