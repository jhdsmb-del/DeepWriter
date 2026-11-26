// Match Desktop's externalizeDepsPlugin for the real, installed XLSX exporter.
// This is not an external for unzipper's undeclared, unused optional S3 SDK.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const PINS = Object.freeze({
  exceljs: Object.freeze({ version: '4.4.0', resolved: 'https://registry.npmjs.org/exceljs/-/exceljs-4.4.0.tgz', integrity: 'sha512-XctvKaEMaj1Ii9oDOqbW/6e1gXknSY4g/aLCDicOXqBE4M0nRWkUu0PTp++UPNzoFY12BNHMfs/VadKIS6llvg==' }),
  unzipper: Object.freeze({ version: '0.12.5', resolved: 'https://registry.npmjs.org/unzipper/-/unzipper-0.12.5.tgz', integrity: 'sha512-tXYOi9R57Uj/2Z25SOs5RRSzq886MBQj2gY8dPL+xl/kv6s6SvByoKfAtvfVeEuhntWDgjd2o9p2lb4TVPAz0A==' })
})
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function fail(message) { throw new Error(`Desktop ExcelJS boundary: ${message}`) }

function readRegular(file, root) {
  const absolute = path.resolve(file)
  const relative = path.relative(root, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('dependency escaped project')
  let current = root
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) fail('symlink dependency is not a locked project payload')
  }
  const stat = fs.statSync(absolute)
  if (!stat.isFile() || stat.size > 1024 * 1024) fail('invalid bounded dependency file')
  return fs.readFileSync(absolute)
}
function projectRoot(entry) {
  if (typeof entry !== 'string' || !path.isAbsolute(entry)) fail('absolute source entry required')
  let directory = fs.statSync(entry).isDirectory() ? entry : path.dirname(entry)
  for (;;) {
    const manifestPath = path.join(directory, 'package.json')
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(readRegular(manifestPath, directory))
      if (manifest.name === 'deepwriter') return fs.realpathSync(directory)
    }
    const parent = path.dirname(directory)
    if (parent === directory) fail('DeepWriter source project not found')
    directory = parent
  }
}

/** Check the real Node resolution and source lock before retaining the npm boundary. */
export function verifyDesktopExcelJsBoundary(entry) {
  const root = projectRoot(entry)
  const packageBytes = readRegular(path.join(root, 'package.json'), root)
  const lockBytes = readRegular(path.join(root, 'package-lock.json'), root)
  const manifest = JSON.parse(packageBytes)
  const lock = JSON.parse(lockBytes)
  if (manifest.dependencies?.exceljs !== '^4.4.0' || lock.packages?.['']?.dependencies?.exceljs !== manifest.dependencies.exceljs) fail('ExcelJS must be the matching direct production dependency')
  if (manifest.overrides?.exceljs?.unzipper !== PINS.unzipper.version) fail('scoped unzipper override is missing or changed')
  const sourceRequire = createRequire(path.join(root, 'package.json'))
  function boundPackage(name, ownerRequire) {
    const manifestPath = ownerRequire.resolve(`${name}/package.json`)
    const manifestBytes = readRegular(manifestPath, root)
    const installed = JSON.parse(manifestBytes)
    const location = path.relative(root, path.dirname(manifestPath)).split(path.sep).join('/')
    const locked = lock.packages?.[location]
    const pin = PINS[name]
    if (installed.name !== name || installed.version !== pin.version || !locked || locked.dev === true || locked.version !== pin.version || locked.resolved !== pin.resolved || locked.integrity !== pin.integrity) fail(`${name} installed version/location/lock/SRI mismatch`)
    const entryPath = ownerRequire.resolve(name)
    const entryBytes = readRegular(entryPath, root)
    if (!path.relative(path.dirname(manifestPath), entryPath).startsWith('..')) return { name, version: installed.version, location, manifestSha256: hash(manifestBytes), entrySha256: hash(entryBytes), entryPath, integrity: pin.integrity }
    fail(`${name} entry escaped its package`)
  }
  const exceljs = boundPackage('exceljs', sourceRequire)
  const unzipper = boundPackage('unzipper', createRequire(exceljs.entryPath))
  return { root, source: { packageSha256: hash(packageBytes), lockSha256: hash(lockBytes) }, exceljs, unzipper }
}

export function desktopSourceExternals(entry, existing = []) {
  if (!Array.isArray(existing) || existing.some(value => typeof value !== 'string' || value.startsWith('@aws-sdk/'))) fail('invalid external dependency boundary')
  verifyDesktopExcelJsBoundary(entry)
  return [...new Set([...existing, 'exceljs'])]
}
