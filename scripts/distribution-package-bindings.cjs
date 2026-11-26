'use strict'

// Manifest-origin evidence only: neither tarball verification nor license approval.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MANIFEST_LIMIT = 1024 * 1024
const PACKAGE_PATH = /^node_modules\/(?:@[^/]+\/[^/]+|[^@/][^/]*)(?:\/node_modules\/(?:@[^/]+\/[^/]+|[^@/][^/]*))*$/
const TRANSFORMER_PIN = Object.freeze({
  packageName: 'app-builder-lib', version: '26.15.3',
  implementation: 'node_modules/app-builder-lib/out/fileTransformer.js',
  implementationSha256: '0c4e855d5c9c6682a165c78dfc7206f35b17fd57321627cbb5259dce433c6ec9'
})
const IGNORED_METADATA = new Set(['dist', 'gitHead', 'build', 'jspm', 'ava', 'xo', 'nyc', 'eslintConfig', 'contributors', 'bundleDependencies', 'tags'])
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const known = value => typeof value === 'string' && value.trim() !== '' && !/^(?:unknown|none|NOASSERTION)$/i.test(value)

function validName(name) {
  return typeof name === 'string' && /^(?:@[^/@\\:\s]+\/)?[^/@\\:\s]+$/.test(name) && !name.split('/').some(part => part === '.' || part === '..')
}
function validLocation(location) {
  return typeof location === 'string' && PACKAGE_PATH.test(location) && !/[\\:\0]/.test(location) && !location.split('/').some(part => part === '.' || part === '..')
}
function placementName(location) { return location.slice(location.lastIndexOf('node_modules/') + 13) }
function readSource(root, relative, limit = MANIFEST_LIMIT) {
  const target = path.resolve(root, ...relative.split('/'))
  const rel = path.relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Source path escapes root')
  let current = root
  for (const component of rel.split(path.sep)) {
    current = path.join(current, component)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('Linked source path rejected')
  }
  const stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.size > limit) throw new Error('Source is not a bounded regular file')
  const bytes = fs.readFileSync(target)
  if (bytes.length !== stat.size || bytes.length > limit) throw new Error('Source length differs')
  return bytes
}
function optionsFor(config) {
  if (!object(config)) throw new Error('Inline builder configuration must be an object')
  for (const key of ['removePackageScripts', 'removePackageKeywords']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error('Unknown manifest stripping option')
  }
  if (config.extends !== undefined || config.electronCompile === true) throw new Error('External manifest transformation is not attested')
  if (config.extraMetadata !== undefined && (!object(config.extraMetadata) || ['dependencies', 'optionalDependencies', 'peerDependencies'].some(key => config.extraMetadata[key] !== undefined))) {
    throw new Error('Dependency-overriding extraMetadata is not attested')
  }
  return { removePackageScripts: config.removePackageScripts !== false, removePackageKeywords: config.removePackageKeywords !== false }
}

// Byte-equivalent to the pinned dependency branch of createTransformer/cleanupPackageJson.
// No generic JSON normalization: unchanged manifests retain their original bytes.
function transformDependencyManifest(bytes, config = {}) {
  const options = optionsFor(config)
  const data = JSON.parse(bytes.toString('utf8'))
  if (!object(data)) throw new Error('Manifest must be an object')
  const deps = data.dependencies
  const removeBabel = deps != null && typeof deps === 'object' && !Object.getOwnPropertyNames(deps).some(key => key.startsWith('babel'))
  let changed = false
  for (const prop of Object.getOwnPropertyNames(data)) {
    if (prop[0] === '_' || IGNORED_METADATA.has(prop) ||
      (options.removePackageScripts && prop === 'scripts') ||
      (options.removePackageKeywords && prop === 'keywords') || prop === 'bugs' || (removeBabel && prop === 'babel')) {
      delete data[prop]
      changed = true
    }
  }
  return changed ? Buffer.from(JSON.stringify(data, null, 2), 'utf8') : Buffer.from(bytes)
}

// Node's ancestor node_modules search, independent of lock/ASAR physical layout.
function resolveDependency(from, name, has) {
  if (!validName(name)) throw new Error('Invalid dependency name')
  let current = from
  for (;;) {
    if (path.posix.basename(current) !== 'node_modules') {
      const candidate = `${current ? `${current}/` : ''}node_modules/${name}`
      if (has(candidate)) return candidate
    }
    if (!current) return null
    current = path.posix.dirname(current)
    if (current === '.') current = ''
  }
}
function declarations(manifest) {
  const result = new Map()
  for (const [field, kind, optional] of [['peerDependencies', 'peer', false], ['dependencies', 'dependency', false], ['optionalDependencies', 'optional', true]]) {
    const values = manifest[field] ?? {}
    if (!object(values)) throw new Error('Dependency declarations must be objects')
    for (const [name, spec] of Object.entries(values)) {
      if (!validName(name) || !known(spec)) throw new Error('Dependency declaration is unknown')
      result.set(name, { name, spec, kind, optional: optional || (kind === 'peer' && manifest.peerDependenciesMeta?.[name]?.optional === true) })
    }
  }
  return [...result.values()]
}
function declarationIdentity(manifest) {
  return declarations(manifest).map(edge => [edge.name, edge.spec, edge.kind, edge.optional]).sort((a, b) => a[0].localeCompare(b[0]))
}
function sourceIdentity(source) {
  return { name: source.name, version: source.version, resolved: source.entry.resolved, integrity: source.entry.integrity }
}
function identityKey(source) {
  return JSON.stringify([source.name, source.version, source.entry.resolved, source.entry.integrity, source.sourceManifest.sha256, source.expectedPackagedManifest.sha256])
}

function collectPackageBindings({ root, lock, projectManifest, packageLocations, readPacked } = {}) {
  root = path.resolve(root)
  const rootStat = fs.lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Source root must be a real directory')
  if (!Array.isArray(packageLocations) || typeof readPacked !== 'function') throw new Error('Actual package locations and bounded reader are required')
  const packageBytes = readSource(root, 'package.json')
  const lockBytes = readSource(root, 'package-lock.json', 8 * 1024 * 1024)
  const pkg = JSON.parse(packageBytes)
  const sourceLock = JSON.parse(lockBytes)
  if ((lock !== undefined && !same(lock, sourceLock)) || (projectManifest !== undefined && !same(projectManifest, pkg))) throw new Error('Provided source metadata differs from real source')
  lock = sourceLock
  if (!object(lock.packages) || !object(lock.packages[''])) throw new Error('Locked package graph is required')
  const reviewNeeded = []
  const issueKeys = new Set()
  const issue = (code, subject) => {
    const key = `${code}:${subject}`
    if (!issueKeys.has(key)) { issueKeys.add(key); reviewNeeded.push({ code, subject }) }
  }
  const bindings = packageLocations.slice().sort().map(location => {
    if (!validLocation(location)) throw new Error('Invalid actual package location')
    const row = { location, name: 'unknown', version: 'unknown', status: 'unresolved', sourceCandidates: [], lockLocations: [], consumptionEdges: [], consumedBy: [], issues: [] }
    try {
      const bytes = readPacked(`${location}/package.json`, MANIFEST_LIMIT)
      if (!Buffer.isBuffer(bytes) || bytes.length > MANIFEST_LIMIT) throw new Error('Actual manifest reader must return bounded bytes')
      row.manifestSha256 = digest(bytes)
      row.manifestSize = bytes.length
      const manifest = JSON.parse(bytes)
      if (object(manifest)) { row.name = manifest.name ?? 'unknown'; row.version = manifest.version ?? 'unknown' }
      if (!object(manifest) || !validName(manifest.name) || !known(manifest.version)) throw new Error('Actual manifest identity is unknown')
      Object.defineProperty(row, '_manifest', { value: manifest })
    } catch { issue('PACKAGED_BINDING_METADATA_UNREADABLE', location) }
    return row
  })
  if (new Set(bindings.map(row => row.location)).size !== bindings.length) throw new Error('Duplicate actual package location')
  const actualByPath = new Map(bindings.map(row => [row.location, row]))
  let transformer = null
  const config = pkg.build ?? {}
  try {
    const options = optionsFor(config)
    const builderEntry = lock.packages['node_modules/app-builder-lib']
    const builderBytes = readSource(root, 'node_modules/app-builder-lib/package.json')
    const builderManifest = JSON.parse(builderBytes)
    const implementationBytes = readSource(root, TRANSFORMER_PIN.implementation, 2 * 1024 * 1024)
    if (builderManifest.name !== TRANSFORMER_PIN.packageName || builderManifest.version !== TRANSFORMER_PIN.version ||
      builderEntry?.version !== TRANSFORMER_PIN.version || !known(builderEntry.resolved) || !known(builderEntry.integrity) ||
      digest(implementationBytes) !== TRANSFORMER_PIN.implementationSha256) throw new Error('Builder transformation implementation is not pinned')
    transformer = { ...TRANSFORMER_PIN, configurationSource: 'package.json#build; external overrides not attested',
      configurationSha256: digest(Buffer.from(JSON.stringify(config), 'utf8')), options,
      lockedResolved: builderEntry.resolved, lockedIntegrity: builderEntry.integrity, sourceManifestSha256: digest(builderBytes) }
  } catch { issue('PACKAGED_BINDING_TRANSFORM_UNATTESTED', 'app-builder-lib/configuration') }

  const entries = new Map()
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue
    if (!validLocation(location) || !object(entry)) throw new Error('Invalid locked package location/metadata')
    entries.set(location, entry)
  }
  const sources = new Map()
  const errors = new Map()
  function loadSource(location) {
    if (sources.has(location)) return sources.get(location)
    if (errors.has(location)) return null
    try {
      const entry = entries.get(location)
      if (!entry || entry.link || !known(entry.version) || !known(entry.resolved) || !known(entry.integrity) ||
        !entry.integrity.trim().split(/\s+/).every(part => /^(?:sha1|sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/.test(part))) throw new Error('Locked source identity is incomplete')
      const bytes = readSource(root, `${location}/package.json`)
      const manifest = JSON.parse(bytes)
      const expectedName = entry.name ?? placementName(location)
      if (!object(manifest) || !validName(expectedName) || manifest.name !== expectedName || manifest.version !== entry.version) throw new Error('Installed source identity differs from lock')
      if (!same(declarationIdentity(manifest), declarationIdentity(entry))) throw new Error('Installed dependency declarations differ from lock')
      const transformed = transformer ? transformDependencyManifest(bytes, config) : null
      const source = { location, entry, name: manifest.name, version: manifest.version, manifest,
        sourceManifest: { name: `${location}/package.json`, size: bytes.length, sha256: digest(bytes) },
        expectedPackagedManifest: transformed ? { name: `${location}/package.json`, size: transformed.length, sha256: digest(transformed) } : null }
      sources.set(location, source)
      return source
    } catch { errors.set(location, 'PACKAGED_BINDING_SOURCE_INVALID'); return null }
  }
  const reachable = new Set()
  const sourceEdges = new Map()
  const queue = ['']
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version || !same(declarationIdentity(pkg), declarationIdentity(lock.packages['']))) issue('PACKAGED_BINDING_ROOT_SOURCE_DRIFT', 'package.json/package-lock.json')
  while (queue.length) {
    const location = queue.shift()
    if (sourceEdges.has(location)) continue
    const source = location ? loadSource(location) : null
    if (location && !source) continue
    const manifest = source ? source.manifest : pkg
    const edges = declarations(manifest).map(edge => {
      const target = resolveDependency(location, edge.name, candidate => entries.has(candidate))
      const targetSource = target ? loadSource(target) : null
      const available = targetSource && targetSource.entry.dev !== true
      if (available) { reachable.add(target); queue.push(target) }
      else if (!edge.optional) issue('PACKAGED_BINDING_REQUIRED_SOURCE_MISSING', `${location || 'package.json'} -> ${edge.name}`)
      return { ...edge, sourceDependencyLocation: available ? target : null, lockedDependencyLocation: target }
    })
    sourceEdges.set(location, edges)
  }
  const byNameVersion = new Map()
  for (const location of [...reachable].sort()) {
    const source = sources.get(location)
    if (!source?.expectedPackagedManifest) continue
    const key = JSON.stringify([placementName(location), source.name, source.version])
    if (!byNameVersion.has(key)) byNameVersion.set(key, [])
    byNameVersion.get(key).push(source)
  }
  for (const row of bindings) {
    if (!row._manifest) continue
    if (!transformer) { issue('PACKAGED_BINDING_TRANSFORM_UNATTESTED', row.location); continue }
    const candidates = byNameVersion.get(JSON.stringify([placementName(row.location), row.name, row.version])) ?? []
    if (!candidates.length) { issue('PACKAGED_BINDING_SOURCE_NOT_PRODUCTION', row.location); continue }
    row.sourceCandidates = candidates.map(source => ({ location: source.location, name: source.name, version: source.version,
      lockedResolved: source.entry.resolved, lockedIntegrity: source.entry.integrity, lockedMetadata: source.entry,
      scope: 'production-reachable', sourceManifest: source.sourceManifest, expectedPackagedManifest: source.expectedPackagedManifest,
      exactExpectedManifestMatch: source.expectedPackagedManifest.sha256 === row.manifestSha256 }))
    const matching = candidates.filter(source => source.expectedPackagedManifest.sha256 === row.manifestSha256)
    if (!matching.length) { issue('PACKAGED_BINDING_MANIFEST_DRIFT', row.location); continue }
    const groups = new Set(matching.map(identityKey))
    if (groups.size !== 1) { issue('PACKAGED_BINDING_SOURCE_AMBIGUOUS', row.location); continue }
    row.sourceIdentity = sourceIdentity(matching[0])
    row.lockLocations = matching.map(source => source.location)
    row.status = 'bound'
  }

  let actualRoot = null
  try {
    const bytes = readPacked('package.json', MANIFEST_LIMIT)
    if (!Buffer.isBuffer(bytes) || bytes.length > MANIFEST_LIMIT) throw new Error('Root reader must return bounded bytes')
    actualRoot = JSON.parse(bytes)
    if (actualRoot.name !== pkg.name || actualRoot.version !== pkg.version || !same(declarationIdentity(actualRoot), declarationIdentity(pkg))) throw new Error('Actual root declarations differ')
  } catch { issue('PACKAGED_BINDING_ROOT_MANIFEST_DRIFT', 'package.json'); actualRoot = null }
  const verifiedPairs = new Set()
  const consumed = new Set()
  function verifyPair(actualLocation, sourceLocation) {
    const pair = `${actualLocation}\0${sourceLocation}`
    if (verifiedPairs.has(pair)) return
    verifiedPairs.add(pair)
    if (verifiedPairs.size > 100000) throw new Error('Consumption graph limit exceeded')
    const consumer = actualByPath.get(actualLocation)
    for (const edge of sourceEdges.get(sourceLocation) ?? []) {
      const actualTarget = resolveDependency(actualLocation, edge.name, candidate => actualByPath.has(candidate))
      if (!actualTarget && edge.optional) continue
      const child = actualByPath.get(actualTarget)
      const verified = !!child && child.status === 'bound' && edge.sourceDependencyLocation !== null && child.lockLocations.includes(edge.sourceDependencyLocation)
      const evidence = { consumerLocation: actualLocation || 'package.json', sourceConsumerLocation: sourceLocation || 'package.json',
        dependencyName: edge.name, declaredSpec: edge.spec, kind: edge.kind, optional: edge.optional,
        packagedDependencyLocation: actualTarget, sourceDependencyLocation: edge.sourceDependencyLocation,
        lockedDependencyLocation: edge.lockedDependencyLocation, verified }
      if (consumer) consumer.consumptionEdges.push(evidence)
      if (child) { child.consumedBy.push(evidence); consumed.add(child.location) }
      if (!verified) {
        issue('PACKAGED_BINDING_CONSUMPTION_DRIFT', `${actualLocation || 'package.json'} -> ${edge.name}`)
        if (consumer) issue('PACKAGED_BINDING_CONSUMPTION_DRIFT', consumer.location)
        if (child) issue('PACKAGED_BINDING_CONSUMPTION_DRIFT', child.location)
      } else verifyPair(actualTarget, edge.sourceDependencyLocation)
    }
  }
  if (actualRoot) verifyPair('', '')
  for (const row of bindings) {
    if (row.status === 'bound' && !consumed.has(row.location)) issue('PACKAGED_BINDING_UNCONSUMED', row.location)
    row.issues = reviewNeeded.filter(item => item.subject === row.location)
    if (row.issues.length || !actualRoot) row.status = 'unresolved'
  }
  return { schemaVersion: 1, source: { packageSha256: digest(packageBytes), lockSha256: digest(lockBytes) }, transformer, bindings, reviewNeeded,
    limits: ['Source SRI identifies a locked tarball; it is not a manifest hash or a verification of all package files.',
      'Only actual ASAR manifests are bound. Installed notices are never treated as shipped notices.',
      'No license interpretation, native-graph completion or release authorization is performed.'] }
}

module.exports = { collectPackageBindings, transformDependencyManifest, resolveDependency, TRANSFORMER_PIN }
