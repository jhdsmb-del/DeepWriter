'use strict'

// The complete distribution includes only authored example sources, never a
// player's compiled scripts, save files, caches or local Ren'Py preferences.
const ferryMembers = Object.freeze(['README.md', 'FONT-LICENSE.txt', 'art/harbor.svg', 'game/script.rpy', 'game/screens.rpy', 'game/FerryText.ttf', 'game/harbor.png'].map(file => 'examples/last-ferry/' + file).concat('docs/images/galgame-import-playtest-v6.png'))
function exampleMembers(version) {
  return Number(version.split('.')[0]) >= 6 ? ferryMembers : []
}
module.exports = { exampleMembers }
