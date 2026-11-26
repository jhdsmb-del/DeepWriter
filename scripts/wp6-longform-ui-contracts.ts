import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
const shell = read('src/renderer/src/components/LongformWorkflowShell.tsx')
const app = read('src/renderer/src/App.tsx')
const css = read('src/renderer/src/ui-takeover.css')

assert.match(shell, /LongformWorkflowSnapshot/, '长文工作台引用权威快照类型')
assert.match(shell, /longformWorkflowGet/, '长文工作台预留快照 IPC 入口')
assert.match(shell, /focusFromAuthority\(workflowSnapshot\)/, '工作阶段来自权威快照')
assert.doesNotMatch(shell, /function stageFromState/, '不保留从 UI 状态猜阶段的函数')
assert.doesNotMatch(shell, /run\.status === ['"]writing['"]/, '不从低级运行状态推断业务阶段')
assert.match(shell, /本场带入/, '回顾主区显示单行带入摘要')
assert.doesNotMatch(shell, /<ul className="dw-longform-summary-list">/, '回顾主区不展开工程摘要列表')
assert.match(app, /workspace !== 'novel'[\s\S]*dw-composer-dock/, '小说工作区隐藏重复输入面')
assert.doesNotMatch(`${shell}\n${app}`, /Revision Diff|Semantic Review|JSON delta|narrative delta|缺失\/冲突 beat/, '工作台用户文案保持自然中文')
assert.match(css, /\.dw-longform-stepper button \{[\s\S]*min-height: 48px/, '阶段导航触控高度达标')
assert.match(css, /\.dw-longform-link \{[\s\S]*min-height: 44px/, '抽屉入口触控高度达标')
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, '工作台支持 reduced-motion')
assert.match(css, /@media \(forced-colors: active\)/, '工作台支持强制配色')
console.log('WP6 LONGFORM UI CONTRACT PASS 14/14')
