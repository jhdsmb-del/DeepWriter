'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const releaseMetadata = require('./release-metadata.cjs')
const sbom = require('./gen-sbom.cjs')

const REQUIRED_BUILD = {
  appId: 'com.deepwriter.app',
  productName: 'DeepWriter',
  asar: true,
  files: [...releaseMetadata.REQUIRED_BUILD_FILES],
  directories: { output: 'dist' },
  win: { target: ['nsis', 'portable'] },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    artifactName: 'DeepWriter-${version}-${arch}-setup.${ext}'
  },
  portable: { artifactName: 'DeepWriter-${version}-${arch}-portable.${ext}' }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function makeProject(parent, version, {
  lockVersion = version,
  rootLockVersion = version,
  lockName = 'deepwriter',
  buildFiles = REQUIRED_BUILD.files,
  dependencies = {},
  devDependencies = {},
  lockDependencies = dependencies,
  lockDevDependencies = devDependencies,
  writeIcon = true
} = {}) {
  const root = path.join(parent, `project-${version.replace(/[^A-Za-z0-9]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`)
  fs.mkdirSync(path.join(root, 'build'), { recursive: true })
  const packageData = {
    name: 'deepwriter',
    version,
    dependencies,
    devDependencies,
    build: { ...REQUIRED_BUILD, files: [...buildFiles] }
  }
  const lockData = {
    name: lockName,
    version: lockVersion,
    lockfileVersion: 3,
    packages: {
      '': { name: 'deepwriter', version: rootLockVersion, dependencies: lockDependencies, devDependencies: lockDevDependencies }
    }
  }
  writeJson(path.join(root, 'package.json'), packageData)
  writeJson(path.join(root, 'package-lock.json'), lockData)
  if (writeIcon) fs.writeFileSync(path.join(root, 'build', 'icon.ico'), 'icon fixture', 'utf8')
  return root
}

function expectFailure(result, text) {
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), new RegExp(text))
}

function makeSbomProject(parent) {
  const root = makeProject(parent, '1.2.4', {
    dependencies: { alpha: '^1.0.0' },
    devDependencies: { electron: '^1.0.0', 'electron-builder': '^1.0.0' }
  })
  const packages = [
    ['alpha', { name: 'alpha', version: '1.0.1', license: 'MIT' }, 'sha512-alpha'],
    ['electron', { name: 'electron', version: '1.0.2', license: 'MIT' }, 'sha512-electron'],
    ['electron-builder', { name: 'electron-builder', version: '1.0.3', license: 'MIT' }, 'sha512-builder']
  ]
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  for (const [name, manifest, integrity] of packages) {
    const packageDir = path.join(root, 'node_modules', ...name.split('/'))
    fs.mkdirSync(packageDir, { recursive: true })
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    fs.writeFileSync(path.join(packageDir, 'package.json'), bytes)
    lock.packages[`node_modules/${name}`] = { version: manifest.version, integrity }
  }
  writeJson(path.join(root, 'package-lock.json'), lock)
  return root
}

function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-release-selftest-'))
  const checks = []
  const check = (name, fn) => {
    try {
      fn()
      checks.push({ name, ok: true })
    } catch (error) {
      checks.push({ name, ok: false, error })
    }
  }

  try {
    for (const version of ['1.0.0', '1.2.4', '1.2.5']) {
      check(`release metadata accepts ${version}`, () => {
        const root = makeProject(temp, version)
        assert.equal(releaseMetadata.validateReleaseMetadata({ root }).ok, true)
      })
    }

    check('explicit expected version accepts matching package', () => {
      const root = makeProject(temp, '1.2.5')
      assert.equal(releaseMetadata.validateReleaseMetadata({ root, expectedVersion: '1.2.5' }).ok, true)
    })

    check('wrong expected version fails closed', () => {
      const root = makeProject(temp, '1.2.5')
      expectFailure(releaseMetadata.validateReleaseMetadata({ root, expectedVersion: '1.2.4' }), 'expected=1\.2\.4')
    })

    check('lock and root lock mismatches fail', () => {
      const root = makeProject(temp, '1.2.5', { lockVersion: '1.2.4' })
      expectFailure(releaseMetadata.validateReleaseMetadata({ root }), 'package-lock\.version')
    })

    check('missing icon fails', () => {
      const root = makeProject(temp, '1.2.5', { writeIcon: false })
      expectFailure(releaseMetadata.validateReleaseMetadata({ root }), 'build/icon\.ico must be a regular file')
    })

    check('missing icon build entry fails', () => {
      const root = makeProject(temp, '1.2.5', { buildFiles: REQUIRED_BUILD.files.filter((file) => file !== 'build/icon.ico') })
      expectFailure(releaseMetadata.validateReleaseMetadata({ root }), 'build\.files missing build/icon\.ico')
    })

    check('multiple unknown build files fail without a length shortcut', () => {
      const root = makeProject(temp, '1.2.5', { buildFiles: [...REQUIRED_BUILD.files, 'unknown-a/**', 'unknown-b/**'] })
      expectFailure(releaseMetadata.validateReleaseMetadata({ root }), 'unexpected entries')
    })

    check('duplicate build files fail', () => {
      const root = makeProject(temp, '1.2.5', { buildFiles: [...REQUIRED_BUILD.files, 'build/icon.ico'] })
      expectFailure(releaseMetadata.validateReleaseMetadata({ root }), 'contains duplicates')
    })

    check('lock dependency range drift fails', () => {
      const root = makeProject(temp, '1.2.5', {
        dependencies: { alpha: '^1.0.0' },
        lockDependencies: { alpha: '^2.0.0' }
      })
      expectFailure(releaseMetadata.validateReleaseMetadata({ root }), 'dependencies range drift for alpha')
    })

    check('artifact report preserves unrelated files', () => {
      const root = makeProject(temp, '1.2.5')
      const artifactDir = path.join(root, 'dist-1.2.5-final')
      fs.mkdirSync(artifactDir, { recursive: true })
      fs.writeFileSync(path.join(artifactDir, 'DeepWriter-1.2.5-x64-setup.exe'), 'fixture artifact')
      const unrelated = path.join(artifactDir, 'keep-me.txt')
      fs.writeFileSync(unrelated, 'must remain')
      const outputDoc = path.join(root, 'docs', 'RELEASE_METADATA_1.2.5.md')
      const result = releaseMetadata.validateReleaseMetadata({ root, artifactDir, outputDoc })
      assert.equal(result.ok, true)
      releaseMetadata.writeOutputDoc(result)
      assert.equal(fs.readFileSync(unrelated, 'utf8'), 'must remain')
      assert.match(fs.readFileSync(outputDoc, 'utf8'), /DeepWriter-1\.2\.5-x64-setup\.exe/)
    })

    check('output path escape is rejected and sentinel stays unchanged', () => {
      const root = makeProject(temp, '1.2.5')
      const outside = path.join(temp, 'outside-report.md')
      fs.writeFileSync(outside, 'sentinel', 'utf8')
      const result = releaseMetadata.validateReleaseMetadata({ root, outputDoc: path.relative(root, outside) })
      expectFailure(result, 'escapes allowed output root')
      expectFailure(releaseMetadata.validateReleaseMetadata({ root, outputDoc: outside }), 'escapes allowed output root')
      assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel')
      const allowedRoot = path.join(temp, 'allowed-release-output')
      fs.mkdirSync(allowedRoot, { recursive: true })
      const allowedDoc = path.join(allowedRoot, 'report.md')
      const allowed = releaseMetadata.validateReleaseMetadata({ root, outputDoc: allowedDoc, allowOutputRoot: allowedRoot })
      assert.equal(allowed.ok, true)
      releaseMetadata.writeOutputDoc(allowed)
      assert.match(fs.readFileSync(allowedDoc, 'utf8'), /deepwriter 1\.2\.5/)
      const sentinelResult = releaseMetadata.validateReleaseMetadata({ root, outputDoc: allowedDoc, allowOutputRoot: allowedRoot })
      expectFailure(sentinelResult, 'already exists')
      assert.match(fs.readFileSync(allowedDoc, 'utf8'), /deepwriter 1\.2\.5/)
    })

    check('SBOM explicit version and hash are reproducible', () => {
      const root = makeSbomProject(temp)
      const allowedRoot = path.join(temp, 'allowed-sbom-output')
      fs.mkdirSync(allowedRoot, { recursive: true })
      const output = path.join(allowedRoot, 'SBOM_DEPENDENCIES_1.2.5.md')
      const result = sbom.generateSbom({ root, version: '1.2.5', output, allowOutputRoot: allowedRoot })
      const alphaManifest = fs.readFileSync(path.join(root, 'node_modules', 'alpha', 'package.json'))
      const expectedHash = `sha256-${crypto.createHash('sha256').update(alphaManifest).digest('hex')}`
      const text = fs.readFileSync(result.outputPath, 'utf8')
      assert.match(text, /项目版本：1\.2\.5/)
      assert.match(text, new RegExp(expectedHash))
      assert.match(text, /sha512-alpha/)
    })

    check('SBOM default preserves old versioned and legacy evidence', () => {
      const root = makeSbomProject(temp)
      const docs = path.join(root, 'docs')
      fs.mkdirSync(docs, { recursive: true })
      const oldVersioned = path.join(docs, 'SBOM_DEPENDENCIES_1.2.4.md')
      const oldLegacy = path.join(docs, 'SBOM_DEPENDENCIES.md')
      fs.writeFileSync(oldVersioned, 'old 1.2.4 evidence', 'utf8')
      fs.writeFileSync(oldLegacy, 'legacy evidence', 'utf8')
      assert.throws(() => sbom.generateSbom({ root }), /refusing to overwrite/)
      assert.equal(fs.readFileSync(oldVersioned, 'utf8'), 'old 1.2.4 evidence')
      assert.equal(fs.readFileSync(oldLegacy, 'utf8'), 'legacy evidence')
    })

    check('SBOM explicit existing output refuses overwrite', () => {
      const root = makeSbomProject(temp)
      const output = path.join(root, 'docs', 'existing.md')
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, 'keep', 'utf8')
      assert.throws(() => sbom.generateSbom({ root, output }), /refusing to overwrite/)
      assert.equal(fs.readFileSync(output, 'utf8'), 'keep')
    })

    check('SBOM output path escape is rejected and allow root is bounded', () => {
      const root = makeSbomProject(temp)
      const outside = path.join(temp, 'outside-sbom.md')
      fs.writeFileSync(outside, 'sentinel', 'utf8')
      assert.throws(() => sbom.generateSbom({ root, version: '1.2.5', output: outside }), /escapes allowed output root/)
      assert.throws(() => sbom.generateSbom({ root, version: '1.2.5', output: path.relative(root, outside) }), /escapes allowed output root/)
      assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel')
      const allowedRoot = path.join(temp, 'bounded-sbom-output')
      fs.mkdirSync(allowedRoot, { recursive: true })
      const output = path.join(allowedRoot, 'SBOM_DEPENDENCIES_1.2.5.md')
      sbom.generateSbom({ root, version: '1.2.5', output, allowOutputRoot: allowedRoot })
      assert.ok(fs.existsSync(output))
      assert.throws(() => sbom.generateSbom({ root, version: '1.2.5', output, allowOutputRoot: allowedRoot }), /refusing to overwrite/)
    })
  } finally {
    fs.rmSync(temp, { recursive: true })
  }

  const failed = checks.filter((check) => !check.ok)
  for (const check of checks) {
    if (check.ok) console.log(`PASS ${check.name}`)
    else console.error(`FAIL ${check.name}: ${check.error.stack || check.error.message}`)
  }
  console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed.length}/${checks.length})`)
  return failed.length === 0 ? 0 : 1
}

if (require.main === module) process.exitCode = run()

module.exports = { run }
