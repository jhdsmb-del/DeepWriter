const fs = require('node:fs/promises')
const path = require('node:path')

/** Deterministic story fixture, never a model-quality claim. Exercises the same
 * seed, namespace, patch applier and publication boundary as production. */
async function productionPatch(input, { branch = false, extra = [] } = {}) {
  const raw = await fs.readFile(path.join(input.projectDir, input.targetFile), 'utf8')
  const entry = /^label (\w+)_start:$/m.exec(raw)[1]
  const speaker = /^define (\w+) = Character/m.exec(raw)[1]
  const sections = /每个大纲节必须对应 label：([^\n]+)/.exec(input.sceneSpec)[1].split('、')
  const lines = [`    jump ${sections[0]}`]
  for (let i = 0; i < sections.length; i++) {
    lines.push('', `label ${sections[i]}:`, `    ${speaker} "${i ? (branch ? '检票员替我拉开门。她真的坐在末班车上，给我留了靠窗的位置。' : '邮戳被雨水泡开了。明早我去车站问问。') : '这字我认得。可她说过，不会再写信来了。'}"`)
    if (i === 0) lines.push(...extra)
    if (i === 0 && branch) {
      lines.push('    menu:', '        "拆开信封，去找她":', `            jump ${entry}_open`, '        "把信收好，留在这里":', `            jump ${entry}_wait`, '', `label ${entry}_open:`, `    ${speaker} "钥匙还在信封里。我锁上门，跑向末班车的站台。"`, i + 1 < sections.length ? `    jump ${sections[i + 1]}` : '    return', '', `label ${entry}_wait:`, `    ${speaker} "我把门灯留到天亮，门外始终没有脚步声。信封里的钥匙，我没有拿出来。"`, '    return')
    } else lines.push(i + 1 < sections.length ? `    jump ${sections[i + 1]}` : '    return')
  }
  return { file: input.targetFile, operations: [{ op: 'insert_after', anchor: '    # DeepWriter Agent insertion point', lines }] }
}
async function applyProductionFixture(api, input, options) {
  const patch = await productionPatch(input, options)
  const applied = await api.applyRenpyPatch({ projectDir: input.projectDir, patch })
  return { status: applied.ok ? 'agent_applied' : 'agent_failed', message: applied.error ?? 'local story fixture applied' }
}
module.exports = { productionPatch, applyProductionFixture }
