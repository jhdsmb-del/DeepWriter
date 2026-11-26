'use strict'

// Explicit artifact inputs only. No build, API request or recursive dependency copy.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')
const { execFileSync } = require('node:child_process')
const { isBuiltin } = require('node:module')
const ROOT = path.resolve(__dirname, '..')
const NODE_VERSION = '24.19.0'
const NODE_SHA256 = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237'
const NODE_LICENSE_URL = `https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`
// Exact bytes retrieved from the same versioned Node tag, not npm's LICENSE.
const NODE_LICENSE_SHA256 = '148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5'
const HASH = /^[a-f0-9]{64}$/
const NOTICE = /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i
const PRIVATE = /^(?:userData|work|scratch|tmp|\.git|\.aws|\.codex|keys?(?:[._-].*)?|credentials?(?:[._-].*)?|settings(?:[._-].*)?|\.env(?:\..*)?)$/i
const SECRET = /sk-[A-Za-z0-9_-]{32,}|["']?apiKeyEnc["']?\s*:\s*["'][^"']{2,}["']/
// Reviewed exceptions are resources, not license guesses or package allowlists.
// Exact versions + locked tarball integrity prevent reuse after an upgrade.
const NOTICE_RESOURCES = Object.freeze({
  isarray: { version: '1.0.0', license: 'MIT', integrity: 'sha512-VLghIWNM6ELQzo7zwmcg0NmTVyWKYjvIeM83yjp0wRDTmUnrM678fQbcKBo6n2CJEF0szoG//ytg+TKla89ALQ==',
    file: 'README.md', sha256: 'ff138e683771b187f3629c383db72ee7d632009010a36d08e18e8d2a34222ec7', sourceUrl: 'https://raw.githubusercontent.com/juliangruber/isarray/2a23a281f369e9ae06394c0fb4d2381355a6ba33/README.md' },
  'dingbat-to-unicode': { version: '1.0.1', license: 'BSD-2-Clause', integrity: 'sha512-98l0sW87ZT58pU4i61wa2OHwxbiYSbuxsCBozaVnYX2iCnr3bLM3fIes1/ej7h1YdOKuKt/MLs706TVnALA65w==',
    upstream: 'a89b69198c2dd030b097cbf44b4eb7dd8b85722d', sha256: '1013cef4b629a3c7eaf737c110fb5bebbf3abbc16e154d769468d71c3653fa37', manifestSha256: '05885cd8d335f8ec91f371755f70368c7133789908c1b21f89ba75115f7f9344',
    sourceUrl: 'https://raw.githubusercontent.com/mwilliamson/dingbat-to-unicode/a89b69198c2dd030b097cbf44b4eb7dd8b85722d/js/LICENSE', manifestSourceUrl: 'https://raw.githubusercontent.com/mwilliamson/dingbat-to-unicode/a89b69198c2dd030b097cbf44b4eb7dd8b85722d/js/package.json' },
  saxes: { version: '5.0.1', license: 'ISC', integrity: 'sha512-5LBh1Tls8c9xgGjw3QrMwETmTMVk0oFgvrFSvWx62llR2hcEInrKNZ2GZCCuuy2lvWrdl5jhbpeqc5hRYKFOcw==',
    upstream: '6ef6a275b20f19cb67808daf0d8f64e06aaf5b0e', sha256: '0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e', manifestSha256: 'd6614eb3d8f62608adea8fbfde612210e6deeb45c073078d1661c92f575e763f',
    sourceUrl: 'https://raw.githubusercontent.com/lddubeau/saxes/6ef6a275b20f19cb67808daf0d8f64e06aaf5b0e/LICENSE', manifestSourceUrl: 'https://raw.githubusercontent.com/lddubeau/saxes/6ef6a275b20f19cb67808daf0d8f64e06aaf5b0e/package.json' },
  pako: { version: '1.0.11', license: '(MIT AND Zlib)', integrity: 'sha512-4hLB8Py4zZce5s4yd9XzopqwVv/yGNhV1Bl8NTmCq1763HeK2+EwVTv+leGeL13Dnh2wfbqowVPXCIO0z4taYw==',
    file: 'lib/zlib/deflate.js', sha256: '4b9b71ae7f42e506fe1fb134f1c21b944ef2b7ef79667ba1fe59eb963c353d22', noticeSha256: '170d7d544d380b38d5f76ab5eda29475b44ef537f4564163d6d9bece85c51c13', sourceUrl: 'https://raw.githubusercontent.com/nodeca/pako/1.0.11/lib/zlib/deflate.js' }
})
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
function resource(name, bytes) { return { name, size: bytes.length, sha256: sha(bytes) } }
function relativeName(root, file) {
  if (typeof file !== 'string') throw new Error('Invalid source input boundary')
  let name = file.startsWith('cli-source:') ? file.slice('cli-source:'.length) : file
  if (typeof name !== 'string' || name.includes('\0')) throw new Error('Invalid source input boundary')
  const absolute = path.resolve(root, name)
  const relative = path.relative(root, absolute).replaceAll('\\', '/')
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || PRIVATE.test(part) || /[ .]$/.test(part) || part.includes(':'))) throw new Error('Invalid source input boundary')
  return relative
}
function noLinks(file, stop) {
  let current = path.resolve(file)
  stop = path.resolve(stop || path.parse(current).root)
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked resource rejected')
    if (current.toLowerCase() === stop.toLowerCase()) break
    const parent = path.dirname(current)
    if (parent === current) throw new Error('Resource boundary mismatch')
    current = parent
  }
}
function read(file, limit = 8 * 1024 * 1024) {
  noLinks(file)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error('Resource must be a nonempty bounded regular file')
  const bytes = fs.readFileSync(file)
  if (bytes.length !== stat.size || SECRET.test(bytes.toString('latin1'))) throw new Error('Sensitive or changed input resource rejected; content is not logged')
  return bytes
}
function same(actual, expected) { return expected && actual.size === expected.size && actual.sha256 === expected.sha256 }
function sourceState(root) {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' })
  return { sourceCommit, sourceDirty: dirty.trim() !== '' }
}
function normalizedInputs(root, metafile) {
  if (!metafile.inputs || typeof metafile.inputs !== 'object' || Array.isArray(metafile.inputs) || Object.keys(metafile.inputs).length === 0 || Object.keys(metafile.inputs).length > 20000) throw new Error('Metafile source inputs are required')
  const names = new Set()
  return Object.entries(metafile.inputs).map(([rawName, entry]) => {
    const name = relativeName(root, rawName)
    if (names.has(name.toLowerCase())) throw new Error('Duplicate normalized source input')
    names.add(name.toLowerCase())
    const bytes = read(path.join(root, name))
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== bytes.length) throw new Error('Metafile source input bytes are stale')
    return { rawName, ...resource(name, bytes), bytes }
  })
}
function dynamicModuleAccess(bytes, name) {
  if (name.endsWith('.json')) { JSON.parse(bytes); return false }
  // Babel is already a locked build dependency. TS 7's native package no
  // longer exposes the old compiler AST API; do not invent a regex parser.
  const parser = require('@babel/parser')
  const source = parser.parse(bytes.toString('utf8'), { sourceType: 'unambiguous', plugins: name.endsWith('.tsx') || name.endsWith('.jsx') ? ['typescript', 'jsx'] : ['typescript'], createImportExpressions: true })
  let unsafe = false
  function visit(node, parent, key) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const call = node.callee
      const directRequire = call.type === 'Identifier' && (call.name === 'require' || call.name === '__require')
      const requireResolve = call.type === 'MemberExpression' && call.object.type === 'Identifier' && call.object.name === 'require' && call.property.name === 'resolve'
      const moduleRequire = call.type === 'MemberExpression' && call.object.type === 'Identifier' && call.object.name === 'module' && call.property.name === 'require'
      if ((directRequire || requireResolve || moduleRequire || call.type === 'Import') && (node.arguments.length < 1 || node.arguments[0].type !== 'StringLiteral')) unsafe = true
      if (call.name === 'createRequire' || call.type === 'MemberExpression' && call.property.name === 'createRequire') unsafe = true
    }
    if (node.type === 'ImportExpression' && node.source.type !== 'StringLiteral') unsafe = true
    if (node.type === 'Identifier' && node.name === 'require') {
      // Aliasing/passing the loader is not covered by the static module graph.
      const directCall = parent && (parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') && key === 'callee'
      const property = parent?.type === 'MemberExpression' && (key === 'property' || key === 'object' && parent.property.name === 'resolve')
      const declaration = parent && (key === 'params' || parent.type === 'VariableDeclarator' && key === 'id' || parent.type === 'ObjectProperty' && key === 'key')
      if (!directCall && !property && !declaration) unsafe = true
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'comments', 'tokens'].includes(childKey)) continue
      if (Array.isArray(child)) child.forEach(entry => visit(entry, node, childKey))
      else if (child && typeof child === 'object') visit(child, node, childKey)
    }
  }
  visit(source)
  return unsafe
}
function packageLocation(name) {
  const parts = name.split('/')
  const index = parts.lastIndexOf('node_modules')
  if (index < 0) return null
  const end = index + (parts[index + 1]?.startsWith('@') ? 3 : 2)
  if (end > parts.length || parts[end - 1] === 'node_modules') throw new Error('Invalid dependency input boundary')
  return parts.slice(0, end).join('/')
}
function licenseValue(value) {
  if (typeof value === 'string') return value.trim() || 'unknown'
  if (value && !Array.isArray(value) && typeof value.type === 'string') return value.type.trim() || 'unknown'
  // Legacy arrays do not supply a single unambiguous SPDX expression here.
  // Preserve the raw declaration below and retain the unknown-license gate.
  return 'unknown'
}
function knownLicense(value) { return !/^(unknown|unlicensed|none|NOASSERTION)$/i.test(value) }

function additionalNotices(root, location, manifest, planned, shipped, files, texts, issue) {
  const rule = Object.hasOwn(NOTICE_RESOURCES, manifest.name) ? NOTICE_RESOURCES[manifest.name] : null
  if (!rule) return []
  if (manifest.version !== rule.version || licenseValue(manifest.license ?? manifest.licenses) !== rule.license || planned?.integrity !== rule.integrity) {
    issue('BUNDLE_NOTICE_BINDING_MISMATCH', location)
    return []
  }
  try {
    const output = `third-party/${manifest.name}/${manifest.version}`
    let bytes, name, proof, sourceUrl
    if (rule.upstream) {
      const source = path.join(root, 'resources/cli-notices', manifest.name, manifest.version)
      bytes = read(path.join(source, 'LICENSE'))
      const evidenceBytes = read(path.join(source, 'SOURCE.json')), upstreamBytes = read(path.join(source, 'UPSTREAM.package.json'))
      proof = JSON.parse(evidenceBytes)
      const upstream = JSON.parse(upstreamBytes)
      sourceUrl = rule.sourceUrl
      if (sha(bytes) !== rule.sha256 || sha(upstreamBytes) !== rule.manifestSha256 || proof.schemaVersion !== 1 || proof.sourceCommit !== rule.upstream || proof.sourceUrl !== sourceUrl
        || proof.package?.name !== manifest.name || proof.package?.version !== manifest.version || proof.package?.license !== rule.license || proof.package?.integrity !== rule.integrity
        || upstream.name !== manifest.name || upstream.version !== manifest.version || licenseValue(upstream.license) !== rule.license
        || proof.upstreamManifest?.sourceUrl !== rule.manifestSourceUrl
        || !same(resource('LICENSE', bytes), proof.notice) || !same(resource('UPSTREAM.package.json', upstreamBytes), proof.upstreamManifest)) throw new Error('notice provenance mismatch')
      name = 'LICENSE'
      files.push({ name: `${output}/SOURCE.json`, bytes: evidenceBytes }, { name: `${output}/UPSTREAM.package.json`, bytes: upstreamBytes })
    } else {
      const sourceFile = `${location}/${rule.file}`, original = read(path.join(root, sourceFile))
      if (sha(original) !== rule.sha256) throw new Error('installed notice resource changed')
      bytes = original; name = rule.file; sourceUrl = rule.sourceUrl
      proof = { schemaVersion: 1, package: { name: manifest.name, version: manifest.version, license: rule.license, integrity: rule.integrity },
        sourceUrl, installedSource: resource(sourceFile, original) }
      if (manifest.name === 'pako') {
        // Its root LICENSE is MIT only. Preserve the additional Zlib notice
        // from the actual source instead of collapsing the AND declaration.
        const text = original.toString('utf8'), start = text.indexOf('// (C) 1995-2013 Jean-loup Gailly and Mark Adler')
        const marker = '// 3. This notice may not be removed or altered from any source distribution.'
        const end = text.indexOf(marker, start) + marker.length
        bytes = Buffer.from(text.slice(start, end) + '\n'); name = 'ZLIB-NOTICE.txt'
        if (start < 0 || end < marker.length || sha(bytes) !== rule.noticeSha256) throw new Error('Zlib notice range changed')
        const zlibInputs = shipped.filter(input => packageLocation(input.name) === location && input.name.startsWith(`${location}/lib/zlib/`))
        if (zlibInputs.some(input => !input.bytes.toString('utf8').includes(bytes.toString('utf8').trimEnd()))) throw new Error('additional Zlib notice differs')
        proof.sourceRange = { start, endExclusive: end + 1 }; proof.coveredInputs = zlibInputs.map(({ name, size, sha256 }) => ({ name, size, sha256 }))
        proof.transformation = 'The CLI copy is transformed by bundling; this is the unchanged original source notice.'
      }
      proof.notice = resource(name, bytes)
      files.push({ name: `${output}/SOURCE.json`, bytes: json(proof) })
    }
    files.push({ name: `${output}/${name}`, bytes })
    texts.push({ subject: `${manifest.name}@${manifest.version}; ${rule.license}; ${sourceUrl}${manifest.name === 'pako' ? '; CLI source transformed by bundling' : ''}`, name: `${output}/${name}`, text: bytes.toString('utf8') })
    return [{ ...resource(name, bytes), outputPath: `${output}/${name}`, provenance: `${output}/SOURCE.json`, sourceUrl }]
  } catch {
    issue('BUNDLE_NOTICE_RESOURCE_INVALID', location)
    return []
  }
}
function verifyPe(bytes) {
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0
  if (bytes.length < 1024 * 1024 || bytes.toString('ascii', 0, 2) !== 'MZ' || offset < 64 || offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Node runtime must be a Windows x64 PE executable')
}
function probeRuntime(file) {
  return JSON.parse(execFileSync(file, ['-p', 'JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch})'], { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 4096 }))
}
function outputPath(root, output) {
  if (!output) throw new Error('CLI output directory is required')
  const target = path.resolve(root, output)
  let relative
  try { relative = relativeName(root, target) } catch { throw new Error('CLI output boundary is unsafe') }
  if (!relative.startsWith('out/') || relative.split('/').some(part => /^(node_modules|release|pnpm(?:[-.].*)?)$/i.test(part))) throw new Error('CLI output must be a new scoped directory under out/')
  noLinks(target, root)
  return target
}

async function collectCliPackage(options, ports = {}) {
  const root = path.resolve(options.root || ROOT)
  const version = options.version
  const sourceCommit = options.sourceCommit
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new Error('Invalid CLI artifact identity')
  const required = ['bundle', 'metafile', 'nodeExe', 'nodeLicense']
  if (required.some(key => !options[key])) throw new Error('Explicit bundle, metafile, Node executable and original license are required')
  const pkgBytes = read(path.join(root, 'package.json'))
  const lockBytes = read(path.join(root, 'package-lock.json'))
  const pkg = JSON.parse(pkgBytes)
  const lock = JSON.parse(lockBytes)
  const bundleFile = path.resolve(root, options.bundle)
  const metadataFile = path.resolve(root, options.metafile)
  const receiptFile = path.resolve(root, options.buildReceipt || path.join(path.dirname(bundleFile), 'cli-build.json'))
  relativeName(root, bundleFile); relativeName(root, metadataFile); relativeName(root, receiptFile)
  const bundleBytes = read(bundleFile, 64 * 1024 * 1024)
  const metadataBytes = read(metadataFile)
  const metadata = JSON.parse(metadataBytes)
  const buildBytes = read(receiptFile)
  const build = JSON.parse(buildBytes)
  const state = (ports.sourceState || sourceState)(root)
  if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version || build.application?.name !== 'deepwriter-cli' || build.application?.version !== version || build.sourceCommit !== sourceCommit || state.sourceCommit !== sourceCommit || typeof build.sourceDirty !== 'boolean') throw new Error('CLI build identity differs from source/version')
  if (!same(resource('bundle', bundleBytes), build.bundle) || !same(resource('metafile', metadataBytes), build.metafile) || build.source?.packageSha256 !== sha(pkgBytes) || build.source?.lockSha256 !== sha(lockBytes)) throw new Error('CLI build receipt does not match actual bundle/metafile/source bytes')
  const inputs = normalizedInputs(root, metadata)
  if (!Array.isArray(build.inputs) || build.inputs.length !== inputs.length || inputs.some(input => build.inputs.filter(entry => entry.name === input.name && same(input, entry)).length !== 1)) throw new Error('CLI source input differs from build receipt')
  const outputs = Object.entries(metadata.outputs || {})
  if (outputs.length !== 1 || relativeName(root, outputs[0][0]) !== relativeName(root, bundleFile) || outputs[0][1].bytes !== bundleBytes.length || relativeName(root, outputs[0][1].entryPoint || '') !== 'src/cli/main.ts') throw new Error('Metafile must describe the exact single CLI entrypoint bundle')
  const output = outputs[0][1]
  if (!output.inputs || !Array.isArray(output.imports)) throw new Error('Metafile bundle dependency evidence is missing')
  const reviewNeeded = []
  const issue = (code, subject) => reviewNeeded.push({ code, subject })
  if (build.sourceDirty || state.sourceDirty) issue('SOURCE_DIRTY', 'Build or current worktree is not a clean commit')
  if (!Array.isArray(build.warnings) || build.warnings.length) issue('BUILD_WARNINGS_UNRESOLVED', 'CLI build warnings require review')
  for (const imported of output.imports) {
    if (imported.external !== true || !isBuiltin(imported.path)) issue('NPM_EXTERNAL_UNBUNDLED', 'Non-builtin import remains outside the bundle')
  }
  const byRaw = new Map(inputs.map(input => [input.rawName, input]))
  const shipped = []
  for (const [rawName, contribution] of Object.entries(output.inputs)) {
    const input = byRaw.get(rawName)
    if (!input || !Number.isSafeInteger(contribution.bytesInOutput) || contribution.bytesInOutput < 0) throw new Error('Metafile output refers to an invalid source input')
    if (contribution.bytesInOutput > 0) {
      shipped.push(input)
      if (dynamicModuleAccess(input.bytes, input.name)) issue('DYNAMIC_MODULE_ACCESS', input.name)
    }
  }
  if (!shipped.some(input => input.name === 'src/cli/main.ts')) throw new Error('CLI entrypoint has no bundled contribution')
  const nodeBytes = read(path.resolve(root, options.nodeExe), 160 * 1024 * 1024)
  verifyPe(nodeBytes)
  if (sha(nodeBytes) !== (ports.nodeSha256 || NODE_SHA256)) throw new Error('Node runtime differs from the verified local executable hash')
  const runtime = (ports.probeRuntime || probeRuntime)(path.resolve(root, options.nodeExe))
  if (runtime.node !== NODE_VERSION || runtime.platform !== 'win32' || runtime.arch !== 'x64') throw new Error('Node runtime identity must be 24.19.0 win32 x64')
  const licenseBytes = read(path.resolve(root, options.nodeLicense))
  const nodeLicenseSourceBytes = read(path.resolve(root, options.nodeLicenseSource || `${options.nodeLicense}.source.json`))
  const licenseSource = JSON.parse(nodeLicenseSourceBytes)
  if (licenseSource.version !== NODE_VERSION || licenseSource.sourceUrl !== NODE_LICENSE_URL || !licenseSource.retrievedAt || !same(resource('LICENSE', licenseBytes), licenseSource) || sha(licenseBytes) !== (ports.nodeLicenseSha256 || NODE_LICENSE_SHA256)) throw new Error('Node license must match the complete original versioned official resource')
  const files = [
    { name: 'deepwriter.cjs', bytes: bundleBytes },
    { name: 'runtime/node.exe', bytes: nodeBytes },
    { name: 'runtime/LICENSE', bytes: licenseBytes },
    { name: 'runtime/LICENSE.source.json', bytes: nodeLicenseSourceBytes },
    { name: 'build/cli-build.json', bytes: buildBytes },
    { name: 'deepwriter.cmd', bytes: Buffer.from('@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0deepwriter.cjs" %*\r\nexit /b %errorlevel%\r\n') }
  ]
  const texts = [{ subject: `Node.js ${NODE_VERSION}; ${NODE_LICENSE_URL}; sha256=${sha(licenseBytes)}`, name: 'runtime/LICENSE', text: licenseBytes.toString('utf8') }]
  const projectLicense = read(path.join(root, 'LICENSE'))
  if (!knownLicense(licenseValue(pkg.license))) issue('PROJECT_LICENSE_UNKNOWN', 'package.json')
  files.push({ name: 'LICENSE', bytes: projectLicense })
  texts.unshift({ subject: `${pkg.name}@${version}; ${licenseValue(pkg.license)}`, name: 'LICENSE', text: projectLicense.toString('utf8') })
  const locations = [...new Set(shipped.map(input => packageLocation(input.name)).filter(Boolean))].sort()
  const dependencies = locations.map(location => {
    const directory = path.join(root, location)
    const manifestBytes = read(path.join(directory, 'package.json'))
    const manifest = JSON.parse(manifestBytes)
    const license = licenseValue(manifest.license ?? manifest.licenses)
    const planned = lock.packages[location]
    if (!manifest.name || !manifest.version || !knownLicense(license)) issue('BUNDLE_LICENSE_UNKNOWN', location)
    if (!planned || planned.version !== manifest.version) issue('BUNDLE_LOCK_VERSION_DRIFT', location)
    const notices = fs.readdirSync(directory).filter(name => NOTICE.test(name)).sort().map(name => {
      if (PRIVATE.test(name) || /[\\/:]/.test(name)) throw new Error('Unsafe notice resource path')
      const bytes = read(path.join(directory, name))
      texts.push({ subject: `${manifest.name || location}@${manifest.version || 'unknown'}; ${license}`, name: `${location}/${name}`, text: bytes.toString('utf8') })
      return resource(name, bytes)
    })
    notices.push(...additionalNotices(root, location, manifest, planned, shipped, files, texts, issue))
    if (!notices.length) issue('BUNDLE_NOTICE_MISSING', location)
    return { location, name: manifest.name || location, version: manifest.version || 'unknown', license, licenseDeclaration: manifest.license ?? manifest.licenses ?? null, manifestSha256: sha(manifestBytes), lockVersion: planned?.version || null, bundledInputs: shipped.filter(input => packageLocation(input.name) === location).map(({ name, size, sha256 }) => ({ name, size, sha256 })), notices }
  })
  const noticeBytes = Buffer.from(texts.map(item => `===== ${item.subject} / ${item.name} =====\n\n${item.text}`).join('\n\n') + '\n')
  files.push({ name: 'THIRD_PARTY_NOTICES.txt', bytes: noticeBytes })
  const inventory = {
    schemaVersion: 1, application: { name: 'deepwriter-cli', version }, sourceCommit, sourceDirty: build.sourceDirty || state.sourceDirty,
    source: { packageSha256: sha(pkgBytes), lockSha256: sha(lockBytes), buildReceiptSha256: sha(buildBytes), metafileSha256: sha(metadataBytes), bundleSha256: sha(bundleBytes) },
    runtime: { name: 'node', version: NODE_VERSION, platform: 'win32', arch: 'x64', executableSha256: sha(nodeBytes), license: { ...resource('runtime/LICENSE', licenseBytes), sourceUrl: NODE_LICENSE_URL } },
    dependencies, inputs: inputs.map(({ name, size, sha256 }) => ({ name, size, sha256 })), files: files.map(({ name, bytes }) => resource(name, bytes)), reviewNeeded, inventoryComplete: reviewNeeded.length === 0,
    legalCompliance: 'not-assessed', runtimeBehavior: 'not-assessed', limitations: ['Only positive output contributions in the bound esbuild metafile identify bundled npm code; the lock plan is not shipped inventory.', 'Dynamic module loaders and non-builtin external imports are unresolved gates, never automatically licensed.', 'Resources and declarations are collected without a license compatibility conclusion or a model quality claim.']
  }
  files.push({ name: 'cli-inventory.json', bytes: json(inventory) })
  const manifest = { schemaVersion: 1, name: 'deepwriter-cli', version, sourceCommit, entrypoint: 'deepwriter.cjs', runtime: { name: 'node', version: NODE_VERSION, platform: 'win32', arch: 'x64', executable: 'runtime/node.exe', license: 'runtime/LICENSE', licenseSource: 'runtime/LICENSE.source.json' }, inventory: 'cli-inventory.json', notices: 'THIRD_PARTY_NOTICES.txt', files: files.map(({ name, bytes }) => resource(name, bytes)) }
  return { root, complete: inventory.inventoryComplete, inventory, manifest, files }
}

async function packageCli(options, ports = {}) {
  const root = path.resolve(options.root || ROOT)
  const output = outputPath(root, options.output)
  if (fs.existsSync(output)) throw new Error('Refusing to overwrite existing CLI package')
  const result = await collectCliPackage(options, ports)
  if (result.complete) result.files.push({ name: 'cli-release.json', bytes: json(result.manifest) })
  fs.mkdirSync(path.dirname(output), { recursive: true })
  noLinks(output, root)
  fs.mkdirSync(output) // Exclusive reservation; no replace/merge into history.
  const created = []
  const directories = new Set()
  try {
    for (const file of result.files) {
      const target = path.join(output, file.name)
      const parent = path.dirname(target)
      const missing = []
      for (let directory = parent; directory !== output && !fs.existsSync(directory); directory = path.dirname(directory)) {
        const relative = path.relative(output, directory)
        if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('CLI package output escaped its reservation')
        missing.push(directory)
      }
      for (const directory of missing.reverse()) { fs.mkdirSync(directory); directories.add(directory) }
      fs.writeFileSync(target, file.bytes, { flag: 'wx', mode: 0o600 }); created.push(target)
      if (sha(read(target, 160 * 1024 * 1024)) !== sha(file.bytes)) throw new Error('CLI package copy differs from verified input bytes')
    }
  } catch (error) {
    for (const target of created.reverse()) fs.unlinkSync(target)
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) fs.rmdirSync(directory)
    fs.rmdirSync(output)
    throw error
  }
  return { complete: result.complete, inventory: result.inventory, output }
}

async function acquireNodeLicense(destination) {
  const target = outputPath(ROOT, destination)
  if (fs.existsSync(target) || fs.existsSync(`${target}.source.json`)) throw new Error('Refusing to overwrite Node license evidence')
  const bytes = await new Promise((resolve, reject) => {
    const request = https.get(NODE_LICENSE_URL, { headers: { 'user-agent': 'DeepWriter-license-evidence' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Official Node license retrieval failed')); return }
      const chunks = []; let length = 0
      response.on('data', chunk => { length += chunk.length; if (length > 1024 * 1024) request.destroy(new Error('Official Node license exceeds limit')); else chunks.push(chunk) })
      response.on('error', reject); response.on('end', () => resolve(Buffer.concat(chunks)))
    })
    request.setTimeout(15000, () => request.destroy(new Error('Official Node license retrieval timed out'))); request.on('error', reject)
  })
  if (bytes.length < 50000 || !bytes.toString('utf8').startsWith('Node.js is licensed for use as follows:')) throw new Error('Official Node license response is incomplete')
  if (NODE_LICENSE_SHA256 && sha(bytes) !== NODE_LICENSE_SHA256) throw new Error('Official Node license source bytes have changed')
  fs.mkdirSync(path.dirname(target), { recursive: true }); noLinks(target, ROOT)
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
  const evidence = { version: NODE_VERSION, sourceUrl: NODE_LICENSE_URL, ...resource('LICENSE', bytes), retrievedAt: new Date().toISOString() }
  try { fs.writeFileSync(`${target}.source.json`, json(evidence), { flag: 'wx', mode: 0o600 }) } catch (error) { fs.unlinkSync(target); throw error }
  return evidence
}
function parseArgs(argv) {
  const options = { root: ROOT }
  const keys = new Map([['--root', 'root'], ['--bundle', 'bundle'], ['--metafile', 'metafile'], ['--build-receipt', 'buildReceipt'], ['--node-exe', 'nodeExe'], ['--node-license', 'nodeLicense'], ['--node-license-source', 'nodeLicenseSource'], ['--source-commit', 'sourceCommit'], ['--version', 'version'], ['--output', 'output']])
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const equal = argv[i].indexOf('=')
    const flag = equal < 0 ? argv[i] : argv[i].slice(0, equal)
    const key = keys.get(flag)
    if (!key) throw new Error('Unknown CLI packaging option')
    if (seen.has(key)) throw new Error('Duplicate CLI packaging option')
    seen.add(key)
    const value = equal < 0 ? argv[++i] : argv[i].slice(equal + 1)
    if (!value || value.startsWith('--')) throw new Error('CLI packaging option requires a value')
    options[key] = value
  }
  return options
}
async function main(argv = process.argv.slice(2)) {
  try {
    const result = await packageCli(parseArgs(argv))
    console.log(`CLI package ${result.inventory.application.version}: complete=${result.complete}; bundled npm packages=${result.inventory.dependencies.length}; evidence gaps=${result.inventory.reviewNeeded.length}`)
    for (const gap of result.inventory.reviewNeeded) console.log(`REVIEW ${gap.code}: ${gap.subject}`)
    return result.complete ? 0 : 1
  } catch { console.error('CLI package failed; input/resource/identity checks did not pass (no credential content logged).'); return 2 }
}
if (require.main === module) main().then(code => { process.exitCode = code })
module.exports = { packageCli, collectCliPackage, parseArgs, main, acquireNodeLicense, normalizedInputs, sourceState, resource, sha, read, outputPath, json, NODE_VERSION, NODE_SHA256, NODE_LICENSE_URL }
