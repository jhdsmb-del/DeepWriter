'use strict'
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const read = file => readFileSync(path.join(__dirname, '..', 'src/renderer/src', file), 'utf8')

test('navigation keeps decisive labels beside the shared line icons', () => {
  const app = read('App.tsx')
  for (const [icon, label] of [['chat', 'Agent'], ['document', '长文'], ['tasks', '任务中心']]) {
    assert.ok(app.includes(`<Icon name="${icon}" />${label}</button>`))
  }
  assert.match(app, /<summary><Icon name="tools" \/>创作工具/)
  assert.match(read('components/TaskCenter.tsx'), /<Icon name="trash" \/>删除/)
  assert.match(read('components/TaskCenter.tsx'), /<Icon name="receipt" \/>账单/)
})

test('desktop text has a readable floor, including font shorthands and lazy creative tools', () => {
  for (const file of ['styles.css', 'ui-takeover.css', 'components/GalgameStudio.css', 'components/manuscript-reader.css', 'desktopUpdates.css']) {
    const css = read(file)
    for (const match of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px|font:\s*(?:(?:normal|italic|[1-9]00)\s+)?(\d+(?:\.\d+)?)px/g)) {
      assert.ok(Number(match[1] ?? match[2]) >= 13, `${file}: ${match[0]}`)
    }
  }
  const css = read('ui-takeover.css')
  assert.match(css, /\.dw-shell small \{ font-size: 13px;/)
  assert.match(css, /\.dw-shell \.dw-field-note \{[^}]*font-size: 14px;/)
  assert.match(css, /\.dw-task-run-main b, \.dw-task-run-main small \{[^}]*white-space: normal;/)
})

test('writing surfaces remove routine explanations rather than hide them', () => {
  assert.doesNotMatch(read('components/Composer.tsx'), /长文流程<\/summary>/)
  assert.doesNotMatch(read('components/NovelPanel.tsx'), /起稿说明|素材说明|确认大纲后才会生成正文/)
  assert.doesNotMatch(read('components/GrillMeWorkbench.tsx'), /回答提示|写作依据<\/summary>/)
  const longform = read('components/LongformWorkflowShell.tsx')
  assert.doesNotMatch(longform, /dw-longform-kicker|这是流程中的单一工作面|只展示当前接口返回的来源/)
  assert.match(longform, /!snapshot && <span[^>]*role="status"/)
  assert.match(longform, /运行中修改只影响下一次写作/)
})

test('billing and recovery keep actual usage, price uncertainty and explicit decisions', () => {
  const inspector = read('components/RunInspector/RunInspector.tsx')
  for (const field of ['tokens.input', 'tokens.output', 'tokens.reasoning', 'tokens.cacheHit', 'tokens.cacheMiss', 'callCounts.tool', 'attempts']) {
    assert.ok(inspector.includes(`billing.${field}`), field)
  }
  assert.match(inspector, /billing\.cost\.amount === null \? '费用未知'/)
  const app = read('App.tsx')
  for (const label of ['已经执行', '没有执行', '回滚并重试', '放弃任务']) assert.ok(app.includes(label))
  assert.match(read('components/GrillMeWorkbench.tsx'), /确认大纲，开始写作/)
})
