const { spawnSync } = require('node:child_process')

const groups = {
  test: ['verify', 'test:agent', 'test:composer', 'test:longform-recovery', 'test:runtime-boundary', 'test:cli', 'test:extensions', 'test:providers', 'test:context-projection', 'test:drafts', 'test:stream', 'test:release', 'test:v150', 'test:v300', 'test:v400', 'test:agent-continuity', 'test:v500', 'test:v600', 'test:workspace-permissions', 'test:ui-simplicity', 'r61:integrity', 'ui:contracts', 'r54:ui', 'r55:ui', 'r52:reliability'],
  check: ['typecheck', 'test', 'gate0', 'gate1', 'gate2', 'gate4', 'gate5', 'docs:check', 'build']
}
const steps = groups[process.argv[2]]
if (!steps || !process.env.npm_execpath) {
  console.error('Use npm test or npm run check.')
  process.exit(1)
}
for (const step of steps) {
  console.log(`\n[check] ${step}`)
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', step], { stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status || 1)
}
