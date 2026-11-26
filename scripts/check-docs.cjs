const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const files = []
function collect(dir, recursive) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory() && recursive) collect(file, true)
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(file)
  }
}
collect(root, false)
collect(path.join(root, 'docs'), true)
collect(path.join(root, '.github'), true)
let failures = 0
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8')
  for (const match of content.matchAll(/!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const link = match[1].split('#')[0]
    if (!link || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) continue
    const target = path.resolve(path.dirname(file), decodeURIComponent(link))
    if (!fs.existsSync(target)) {
      console.error(`${path.relative(root, file)}: missing ${link}`)
      failures++
    }
  }
}
console.log(`Documentation: ${files.length} files, ${failures} broken local links`)
process.exitCode = failures ? 1 : 0
