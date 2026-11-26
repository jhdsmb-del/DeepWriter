const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const { before, after, test } = require('node:test')
const esbuild = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const projectRoot = path.resolve(__dirname, '..')
const previousWindow = globalThis.window
let CurrentWorkPanel
let authorityFocus

before(async () => {
  const sourcePath = path.join(projectRoot, 'src/renderer/src/components/LongformWorkflowShell.tsx')
  const source = `${readFileSync(sourcePath, 'utf8')}\nexport { CurrentWorkPanel, AUTHORITY_FOCUS };`
  const result = await esbuild.build({
    absWorkingDir: projectRoot,
    stdin: { contents: source, loader: 'tsx', resolveDir: path.dirname(sourcePath) },
    tsconfigRaw: {},
    jsx: 'automatic',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['react'],
    plugins: [{
      name: 'longform-render-boundaries',
      setup(build) {
        build.onResolve({ filter: /\/store$/ }, () => ({ path: 'store', namespace: 'test-boundary' }))
        build.onResolve({ filter: /\/(NovelPanel|ActivityCard)$/ }, (args) => ({ path: args.path, namespace: 'test-boundary' }))
        build.onLoad({ filter: /.*/, namespace: 'test-boundary' }, (args) => ({
          contents: args.path === 'store'
            ? 'export function useStore(select) { return select(globalThis.__longformRecoveryState); }'
            : 'export default function Component() { return null; }',
          loader: 'js'
        }))
        build.onResolve({ filter: /^\.\.?\// }, (args) => {
          const target = path.resolve(args.resolveDir, args.path)
          const resolved = ['', '.ts', '.tsx', '.js'].map((extension) => target + extension).find(existsSync)
          if (!resolved || !resolved.startsWith(projectRoot + path.sep)) throw new Error(`Unexpected test import: ${args.path}`)
          return { path: resolved, namespace: 'test-source' }
        })
        build.onLoad({ filter: /.*/, namespace: 'test-source' }, (args) => ({
          // CSS is a browser side effect, not TypeScript. Keep the actual
          // component graph; visual styles are exercised by desktop tests.
          contents: args.path.endsWith('.css') ? '' : readFileSync(args.path, 'utf8'),
          loader: args.path.endsWith('.css') ? 'empty' : args.path.endsWith('.tsx') ? 'tsx' : 'ts',
          resolveDir: path.dirname(args.path)
        }))
      }
    }]
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, loaded, loaded.exports)
  CurrentWorkPanel = loaded.exports.CurrentWorkPanel
  authorityFocus = loaded.exports.AUTHORITY_FOCUS
  globalThis.window = { ds: {} }
  globalThis.__longformRecoveryState = {
    currentSessionId: 'recovered-session',
    send: async () => ({ ok: false }),
    pendingAttachments: [],
    showToast: () => {}
  }
})

after(() => {
  delete globalThis.__longformRecoveryState
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
})

function recoveredGrill() {
  const outline = {
    title: '重启后保留的大纲',
    premise: '沿用已确认的原始任务',
    targetChars: 2000,
    sections: [{ id: 'one', title: '第一节', purpose: '推进故事', targetChars: 2000, beats: ['发生转折'], sourceSlotIds: [] }]
  }
  return JSON.parse(JSON.stringify({
    sessionId: 'recovered-session',
    stateId: 'confirmed-grill',
    status: 'confirmed',
    originalTask: '一个已经确认需求和大纲的写作任务',
    targetChars: 2000,
    slots: [],
    assumptions: [],
    currentQuestion: null,
    interview: { status: 'success' },
    planning: { status: 'success' },
    outline,
    approvedOutline: outline
  }))
}

function renderWorkPanel(patch = {}) {
  return renderToStaticMarkup(React.createElement(CurrentWorkPanel, {
    stage: authorityFocus.scene_direction,
    currentStage: authorityFocus.scene_direction,
    grill: recoveredGrill(),
    setGrill: () => {},
    grillError: null,
    setGrillError: () => {},
    run: null,
    review: null,
    pendingReview: null,
    onOpenActivity: () => {},
    onOpenReview: () => {},
    onDeferReview: () => {},
    onRefresh: () => {},
    ...patch
  }))
}

test('恢复已确认大纲后，当前场景设计工作面保留正文启动入口', () => {
  const markup = renderWorkPanel()
  assert.match(markup, /data-phase="confirmed"/)
  assert.match(markup, />开始写作<\/button>/)
  assert.equal(recoveredGrill().approvedOutline.title, '重启后保留的大纲')
})

test('正文启动被拒绝后，保留失败原因和同一已确认大纲的重试入口', () => {
  const grill = recoveredGrill()
  const originalOutline = JSON.stringify(grill.approvedOutline)
  const markup = renderWorkPanel({ grill, grillError: '模型上下文能力未知，已安全停止' })
  assert.match(markup, /正文启动失败：模型上下文能力未知，已安全停止/)
  assert.match(markup, />开始写作<\/button>/)
  assert.equal(JSON.stringify(grill.approvedOutline), originalOutline)
})

test('已有进行中的正文任务时，不提供重复启动按钮，并保留大纲摘要', () => {
  const markup = renderWorkPanel({ run: { runId: 'active-run', status: 'writing' } })
  assert.doesNotMatch(markup, />开始写作<\/button>/)
  assert.doesNotMatch(markup, /data-phase="confirmed"/)
  assert.match(markup, /重启后保留的大纲/)
})

test('尚未确认的大纲继续显示原有编辑与确认入口', () => {
  const grill = recoveredGrill()
  grill.status = 'awaiting_outline_confirmation'
  const markup = renderWorkPanel({ grill })
  assert.match(markup, /确认大纲，开始写作/)
  assert.match(markup, /value="重启后保留的大纲"/)
})
