'use strict'
// Real public installers selected for each release line; keep historical
// evidence readable with the baseline that actually produced it.
function upgradeBaseline(version) {
  const [major, minor] = version.split('.').map(Number)
  if (major > 8 || (major === 8 && minor >= 2)) return '8.1.0'
  if (major === 8 && minor === 1) return '8.0.0'
  return major === 8 ? '6.0.0' : '1.2.6'
}
module.exports = { upgradeBaseline }
if (require.main === module) console.log(upgradeBaseline(require('../package.json').version))
