'use strict'
// The last release before in-app updates shipped in the public distribution.
function upgradeBaseline(version) { return Number(version.split('.')[0]) >= 8 ? '6.0.0' : '1.2.6' }
module.exports = { upgradeBaseline }
if (require.main === module) console.log(upgradeBaseline(require('../package.json').version))
