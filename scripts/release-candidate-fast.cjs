'use strict'

// First-party, non-Electron release-candidate gate. Keep this list deliberately
// small and deterministic: focused P0/P1 checks run in order, and the first
// non-zero child status is returned unchanged. Electron multi-round suites
// belong to the full release matrix, not this fast feedback path.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
// Do not delegate to a shell (especially the Windows .cmd shim).  Besides
// avoiding DEP0190, an argument-array spawn keeps every script name and path a
// separate argument.  npm sets npm_execpath to the exact npm-cli.js in use;
// when this gate is invoked outside npm we fail closed instead of guessing a
// global npm installation.
const npmExecPath = typeof process.env.npm_execpath === 'string' ? process.env.npm_execpath.trim() : ''
if (!npmExecPath) {
  console.error('[release:candidate:fast] 缺少 npm_execpath，拒绝猜测 npm 入口；请通过 npm run release:candidate:fast 启动')
  process.exitCode = 2
  return
}
const checks = [
  ['typecheck', 'TypeScript 类型检查'],
  ['p0-1:provider-budget', 'P0-1 provider budget'],
  ['p1-token-budget', 'P1 durable token budget'],
  ['r61:cost-budget', 'R61 currency-safe cost budget'],
  ['p0-1:manuscript-boundary', 'P0-1 manuscript boundary'],
  ['p1-provider-tool-stream', 'P1 provider tool delta stream'],
  ['p1-3-scene-contract-semantics', 'P1-3 scene contract semantics'],
  ['r64:zh-semantic-corpus', 'R64 Chinese semantic contrast corpus'],
  ['r65:actuality-contract', 'R65 actuality/assertion contract'],
  ['r64:review-lifecycle', 'R64 narrative review lifecycle and concurrency'],
  ['p1-c-scope-scene-manifest', 'P1-C scoped scene manifest'],
  ['p1-4-story-ledger', 'P1-4 cross-run story ledger'],
  ['p1-5:story-retraction', 'P1-5 story revision retraction'],
  ['p2:story-ledger-integrity', 'P2 strict story ledger integrity and migration'],
  ['p2-completion-combo', 'P2 exact completion/beat/provider regression'],
  ['r61:provider-adapters', 'R61 provider protocol adapters'],
  ['p0-2:manuscript-backfill', 'P0-2 manuscript backfill'],
  ['p1-a:manuscript-acceptance', 'P1-A manuscript acceptance'],
  ['p1-b:manuscript-recovery', 'P1-B manuscript recovery'],
  ['r65:review-recovery', 'R65 review recovery and opaque acceptance'],
  ['p2:scene-state', 'P2 scene state'],
  ['p3-a:narrative-ledger', 'P3-A narrative ledger'],
  ['p3-b:narrative-context', 'P3-B narrative context'],
  ['p4:narrative-context', 'P4 narrative context'],
  ['p1-2:narrative-state', 'P1-2 production narrative state'],
  ['r62:scene-semantics', 'R62 production scene semantic review'],
  ['p1-6-7:fact-context', 'P1-6/P1-7 fact registry context'],
  ['r60', 'R60 longwrite collaboration'],
  ['r61:performance', 'R61 longwrite performance']
]

console.log(`[release:candidate:fast] ${checks.length} 项首方聚焦检查，严格顺序执行（不含 Electron 多轮）`)

for (let index = 0; index < checks.length; index += 1) {
  const [script, label] = checks[index]
  console.log(`\n[${index + 1}/${checks.length}] ${label} (${script})`)
  const result = spawnSync(process.execPath, [npmExecPath, 'run', script], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: false
  })
  if (result.error) {
    console.error(`[release:candidate:fast] ${script} 启动失败：${result.error.message}`)
    process.exit(result.status ?? 1)
  }
  if (result.status !== 0) {
    const code = result.status ?? 1
    console.error(`[release:candidate:fast] FAIL-FAST：${script} 退出码 ${code}，后续检查未执行`)
    process.exit(code)
  }
}

console.log(`\n[release:candidate:fast] ACCEPT：${checks.length}/${checks.length} 项通过`)
