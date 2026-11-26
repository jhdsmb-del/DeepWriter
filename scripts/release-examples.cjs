'use strict'

// The complete distribution includes only authored example sources, never a
// player's compiled scripts, save files, caches or local Ren'Py preferences.
const ferryMembers = Object.freeze(['README.md', 'FONT-LICENSE.txt', 'art/harbor.svg', 'game/script.rpy', 'game/screens.rpy', 'game/FerryText.ttf', 'game/harbor.png'].map(file => 'examples/last-ferry/' + file).concat('docs/images/galgame-import-playtest-v6.png'))
function exampleMembers(version) {
  const [major, minor] = version.split('.').map(Number)
  const members = major >= 8 ? [...ferryMembers, 'docs/images/manuscript-reader-v8.png'] : major >= 6 ? [...ferryMembers] : []
  if (major > 8 || (major === 8 && minor >= 1)) members.push('examples/east-bank/night-timetable.docx', 'examples/east-bank/duty-note.md')
  return members
}
module.exports = { exampleMembers }
