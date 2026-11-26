import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { createServer } from 'node:http'
import { zipSync, strToU8 } from 'fflate'
import {
  extractZipSafely,
  findRenpySdkLayout,
  inspectRenpySdk,
  managedSdkInstallsDir,
  runRenpyLint
} from '../src/main/renpySdk'
import {
  GALGAME_STUDIO_STAGES,
  RENPY_SDK_DOWNLOAD_URL,
  RENPY_SDK_MANIFEST,
  createGalgameStudioState,
  nextGalgameStudioStage,
  sdkManifestIsOfficial,
  studioGate,
  type GalgameAssetManifest
} from '../src/shared/galgameStudio'
import { downloadAndInstallManagedSdk } from '../src/main/renpySdk'
import { GalgameStudioService, createRenpyProject } from '../src/main/galgameStudio'
import { createGrillMeState, grillMeOutlineHash, type GrillMeOutline, type GrillMeState } from '../src/shared/grillMe'
import { galgameApiFromEffectiveProfile } from '../src/main/galgame'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function expectThrow(work: () => Promise<unknown>, code: string): Promise<void> {
  return work().then(() => check(`抛出 ${code}`, false, '没有抛出异常')).catch((error: unknown) => check(`抛出 ${code}`, (error as { code?: string }).code === code, String((error as Error).message)))
}

function fixtureZip(options: { topLevel?: boolean; zipSlip?: boolean } = {}): Uint8Array {
  const prefix = options.topLevel === false ? '' : 'renpy-8.5.3-sdk/'
  return zipSync(options.zipSlip
    ? { '../escape.txt': strToU8('escape') }
    : {
        [`${prefix}renpy.py`]: strToU8('print("RenPy 8.5.3")'),
        [`${prefix}lib/py3-windows-x86_64/python.exe`]: strToU8('fixture-python'),
        [`${prefix}launcher/game/project.rpy`]: strToU8('# SDK launcher fixture'),
        [`${prefix}renpy/vc_version.py`]: strToU8('version = "8.5.3.1"'),
        [`${prefix}renpy/lint.py`]: strToU8('# --error-code'),
        [`${prefix}README.txt`]: strToU8('fixture')
      })
}

async function fixtureResponse(bytes: Uint8Array): Promise<Response> {
  return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r55-galgame-'))
  try {
    console.log('\n[R55-1] 官方 SDK manifest 与固定来源')
    check('manifest 使用官方版本/URL/hash', RENPY_SDK_MANIFEST.version === '8.5.3' && RENPY_SDK_MANIFEST.url === RENPY_SDK_DOWNLOAD_URL && RENPY_SDK_MANIFEST.sha256.length === 64)
    check('自定义 URL/hash 不能冒充官方 manifest', sdkManifestIsOfficial(RENPY_SDK_MANIFEST) && !sdkManifestIsOfficial({ ...RENPY_SDK_MANIFEST, url: 'http://127.0.0.1/fixture.zip' }))

    console.log('\n[R55-2] streaming ZIP：官方顶层目录与 zip-slip')
    const shapedZip = path.join(tmp, 'shaped.zip')
    await fsp.writeFile(shapedZip, fixtureZip())
    const shapedStage = path.join(tmp, 'shaped-stage')
    await fsp.mkdir(shapedStage)
    await extractZipSafely(shapedZip, shapedStage)
    const shapedLayout = await findRenpySdkLayout(shapedStage)
    check('唯一顶层 renpy-8.5.3-sdk 被发现', Boolean(shapedLayout?.root.endsWith(path.join('shaped-stage', 'renpy-8.5.3-sdk'))))
    check('官方结构 python.exe + renpy.py 均存在', Boolean(shapedLayout?.pythonPath.endsWith(path.join('lib', 'py3-windows-x86_64', 'python.exe')) && shapedLayout?.renpyScriptPath.endsWith('renpy.py')))
    const slipZip = path.join(tmp, 'slip.zip')
    await fsp.writeFile(slipZip, fixtureZip({ zipSlip: true }))
    const slipStage = path.join(tmp, 'slip-stage')
    await fsp.mkdir(slipStage)
    await expectThrow(() => extractZipSafely(slipZip, slipStage), 'zip_slip')
    check('zip-slip 失败不产生 stage 外文件', !(await fsp.stat(path.join(tmp, 'escape.txt')).catch(() => null)))

    console.log('\n[R55-3] 本地 HTTP fixture：请求固定官方 URL、hash 错误与原子性')
    const fixtureBytes = fixtureZip()
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(fixtureBytes.byteLength), 'content-type': 'application/zip' })
      res.end(Buffer.from(fixtureBytes))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const localUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/fixture.zip` : ''
    let requested = ''
    const fetchFixture = async (url: string, init?: { signal?: AbortSignal; redirect?: 'error' | 'follow' | 'manual' }): Promise<Response> => {
      requested = url
      const response = await fetch(localUrl, init)
      return fixtureResponse(new Uint8Array(await response.arrayBuffer()))
    }
    const atomicOld = path.join(managedSdkInstallsDir(tmp), 'old-install', 'marker.txt')
    await fsp.mkdir(path.dirname(atomicOld), { recursive: true })
    await fsp.writeFile(atomicOld, 'old-install')
    await expectThrow(() => downloadAndInstallManagedSdk({ userDataDir: tmp, fetchImpl: fetchFixture }), 'hash_mismatch')
    check('下载器只请求固定官方 URL', requested === RENPY_SDK_DOWNLOAD_URL)
    check('hash 错误保持旧安装与目录不变', (await fsp.readFile(atomicOld, 'utf8')) === 'old-install' && (await fsp.readdir(managedSdkInstallsDir(tmp))).length === 1)
    await new Promise<void>((resolve) => server.close(() => resolve()))

    console.log('\n[R55-4] 下载取消')
    const controller = new AbortController()
    let pulls = 0
    let streamClosed = false
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (streamClosed) return
        if (controller.signal.aborted) { streamClosed = true; streamController.close(); return }
        pulls++
        setTimeout(() => {
          if (streamClosed) return
          if (controller.signal.aborted) { streamClosed = true; streamController.close() }
          else streamController.enqueue(new Uint8Array(1024))
        }, 8)
      },
      cancel() { streamClosed = true }
    })
    const slowFetch = async (_url: string, _init?: { signal?: AbortSignal; redirect?: 'error' | 'follow' | 'manual' }): Promise<Response> => new Response(stream, { status: 200 })
    const cancelRun = downloadAndInstallManagedSdk({ userDataDir: path.join(tmp, 'cancel'), fetchImpl: slowFetch, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expectThrow(() => cancelRun, 'cancelled')
    check('取消期间确实读取过流式 chunk', pulls > 0)
    const cancelledRoot = path.join(tmp, 'cancel', 'renpy-sdk')
    const cancelledListing = await fsp.readdir(cancelledRoot, { recursive: true }).catch(() => [] as string[])
    check('取消后没有半成品安装目录', !(await fsp.stat(cancelledRoot).catch(() => null)), cancelledListing.join(','))

    console.log('\n[R55-5] SDK --version 与官方 lint CLI 参数')
    const fakeSdk = path.join(tmp, 'fake-sdk')
    const sdkMarkers = async (root: string): Promise<void> => {
      await fsp.mkdir(path.join(root, 'launcher', 'game'), { recursive: true })
      await fsp.mkdir(path.join(root, 'renpy'), { recursive: true })
      await fsp.writeFile(path.join(root, 'launcher', 'game', 'project.rpy'), '# SDK launcher fixture')
      await fsp.writeFile(path.join(root, 'renpy', 'vc_version.py'), 'version = "8.5.3.1"')
      await fsp.writeFile(path.join(root, 'renpy', 'lint.py'), '# --error-code')
    }
    await fsp.mkdir(path.join(fakeSdk, 'lib', 'py3-windows-x86_64'), { recursive: true })
    await fsp.writeFile(path.join(fakeSdk, 'renpy.py'), '')
    await fsp.writeFile(path.join(fakeSdk, 'lib', 'py3-windows-x86_64', 'python.exe'), '')
    await sdkMarkers(fakeSdk)
    let versionArgs: string[] = []
    const fakeRunner = async (_command: string, args: string[], _cwd: string): Promise<{ code: number; output: string }> => { versionArgs = args; return { code: 0, output: "Ren'Py 8.5.3" } }
    const inspection = await inspectRenpySdk({ userDataDir: tmp, explicitPath: fakeSdk, runCommand: fakeRunner })
    check('显式 SDK 结构 + --version 验证', inspection.status === 'ready' && versionArgs.join(' ') === 'renpy.py --version')
    const discoveryRoot = path.join(tmp, 'discovery-documents')
    const discoveredSdk = path.join(discoveryRoot, 'workspace', 'renpy-8.5.3-sdk')
    await fsp.mkdir(path.join(discoveredSdk, 'lib', 'py3-windows-x86_64'), { recursive: true })
    await fsp.writeFile(path.join(discoveredSdk, 'renpy.py'), '')
    await fsp.writeFile(path.join(discoveredSdk, 'lib', 'py3-windows-x86_64', 'python.exe'), '')
    await sdkMarkers(discoveredSdk)
    const discovered = await inspectRenpySdk({ userDataDir: path.join(tmp, 'empty-userdata'), discoveryRoots: [discoveryRoot], runCommand: fakeRunner })
    check('常用目录两层扫描可发现已有 SDK', discovered.status === 'ready' && discovered.candidate?.source === 'discovered' && discovered.candidate.layout.root === discoveredSdk)
    let lintArgs: string[] = []
    const lint = await runRenpyLint(inspection.candidate!.layout, path.join(tmp, 'project'), { runCommand: async (_command, args) => { lintArgs = args; return { code: 0, output: '' } } })
    check('lint CLI 参数为 python renpy.py <project> lint --error-code', lint.ok && lintArgs[0] === 'renpy.py' && lintArgs[2] === 'lint' && lintArgs[3] === '--error-code')

    console.log('\n[R55-6] 阶段门反证')
    const empty = createGalgameStudioState({ studioId: 'studio-test', sessionId: 'session-test', projectId: 'project-test', projectDir: tmp, projectMode: 'create', projectName: 'test' })
    check('未准备 SDK 时禁止 generate', studioGate(empty, 'generate').ok === false)
    const withSetup = { ...empty, sdkReady: true, sdk: { source: 'managed' as const, root: tmp, pythonPath: 'python.exe', renpyScriptPath: 'renpy.py', version: '8.5.3', verifiedAt: Date.now(), command: 'python.exe renpy.py --version' }, assetsReady: true, assets: { schemaVersion: 1 as const, characters: [{ id: 'c', name: 'C', setting: '设定' }], sprites: [{ id: 's', characterId: 'c', expression: 'default', fileRefId: 'ref-s' }], backgrounds: [{ id: 'b', name: '背景', fileRefId: 'ref-b' }], audio: [] } satisfies GalgameAssetManifest, grillConfirmed: true }
    check('未确认大纲/分支图仍禁止 generate', studioGate(withSetup, 'generate').ok === false)
    const skeletonOnly = {
      ...withSetup,
      outlineHash: 'outline', branchHash: 'branch', outlineBranchConfirmed: true,
      generatedFile: path.join(tmp, 'game', 'deepwriter_generated.rpy'),
      production: { status: 'skeleton_handoff' as const, message: '等待模型', requestedAt: Date.now(), completedAt: null },
      lint: { ok: true, verified: true, output: '', errorCount: 0, warningCount: 0, command: 'fixture', checkedAt: Date.now() }
    }
    check('只有骨架即使 lint 通过也不能完成', nextGalgameStudioStage(skeletonOnly) === 'generate' && studioGate(skeletonOnly, 'done').ok === false)
    check('阶段名顺序冻结', GALGAME_STUDIO_STAGES.join('→') === 'sdk_ready→assets_ready→grill→outline/branch_confirmed→generate→lint/repair→done')

    console.log('\n[R55-7] 完整工作台：素材 → Grill Me → 生成 → lint → 恢复')
    const workflowRoot = path.join(tmp, 'workflow')
    await fsp.mkdir(workflowRoot, { recursive: true })
    const project = await createRenpyProject({ parentDir: workflowRoot, name: 'studio-fixture', sessionId: 'session-workflow' })
    const spriteFile = path.join(tmp, 'hero.png')
    const backgroundFile = path.join(tmp, 'room.jpg')
    await fsp.writeFile(spriteFile, 'sprite')
    await fsp.writeFile(backgroundFile, 'background')
    const outline: GrillMeOutline = {
      title: '雨夜来信', premise: '主角在雨夜收到一封改变选择的信。', targetChars: 8000,
      sections: [{ id: 'opening', title: '雨夜', purpose: '建立冲突', targetChars: 8000, beats: ['收到信件', '决定追查'], sourceSlotIds: ['goal'] }]
    }
    let grillState: GrillMeState = createGrillMeState({ stateId: 'grill-workflow', sessionId: 'session-workflow', originalTask: '制作雨夜来信 Galgame', targetChars: 8000, genre: 'Galgame', kind: 'Galgame 剧本' })
    const outlineHash = grillMeOutlineHash(outline)
    grillState = { ...grillState, status: 'confirmed', outline, approvedOutline: outline, outlineHash, outlineRevision: 1 }
    let productionCalls = 0
    const studioService = new GalgameStudioService({
      baseDir: path.join(tmp, 'workflow-state'),
      resolveAssetRef: async (fileRefId) => fileRefId === 'sprite-ref'
        ? { realpath: spriteFile, displayName: 'hero.png', size: (await fsp.stat(spriteFile)).size }
        : fileRefId === 'background-ref'
          ? { realpath: backgroundFile, displayName: 'room.jpg', size: (await fsp.stat(backgroundFile)).size }
          : null,
      getGrillState: async () => grillState,
      inspectSdk: async () => inspection,
      lint: async (_layout, projectDir) => ({ ok: true, verified: true, output: '', exitCode: 0, command: `fixture renpy.py ${projectDir} lint --error-code` }),
      runProductionAgent: async () => { productionCalls++; return { status: 'agent_applied', message: 'fixture Agent applied' } }
    })
    let workflow = await studioService.create({ sessionId: 'session-workflow', project })
    await studioService.inspectSdk(workflow.studioId)
    const assetResult = await studioService.setAssets(workflow.studioId, { manifest: {
      schemaVersion: 1,
      characters: [{ id: 'hero', name: '夏澄', setting: '克制但执着，必须查明来信来源。' }],
      sprites: [{ id: 'hero_default', characterId: 'hero', expression: 'default', fileRefId: 'sprite-ref', displayName: 'hero.png' }],
      backgrounds: [{ id: 'rain_room', name: '雨夜房间', fileRefId: 'background-ref', displayName: 'room.jpg' }],
      audio: []
    } })
    const readySnapshot = await studioService.snapshot(workflow.studioId)
    workflow = await studioService.confirmOutlineBranch(workflow.studioId, { branchHash: readySnapshot.branchHash!, outlineHash })
    const generated = await studioService.generate(workflow.studioId)
    const linted = await studioService.lintStudio(workflow.studioId)
    const restored = await studioService.latestForSession('session-workflow')
    check('素材分类与 FileRef 验证通过', assetResult.ok && assetResult.counts.sprites === 1 && assetResult.counts.backgrounds === 1)
    check('只有确认大纲/分支后才进入生成', workflow.outlineBranchConfirmed && generated.ok && productionCalls === 1)
    check('生成文件与素材真实落盘', Boolean(generated.generatedFile && fs.existsSync(generated.generatedFile) && generated.copiedAssets.length === 2))
    check('官方 lint 结果必须带 verified', linted.ok && linted.verified)
    check('离开页面后可按 session 恢复工作台', restored?.state.studioId === workflow.studioId && restored.state.stage === 'done')
    const selectedApi = galgameApiFromEffectiveProfile({
      secret: 'fixture-secret',
      provider: { baseUrl: 'https://example.com/v1', adapterId: 'custom.openai-compatible-chat', chatPath: '/chat/completions', authStyle: 'bearer', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false } },
      model: { remoteModelId: 'writer-model', maxOutputTokens: 7777 },
      profile: { generation: { maxOutputTokens: 6000, temperature: 0.4, topP: 0.8 }, reasoning: { mode: 'enabled', effort: 'medium' }, compatibilityMappingId: 'openai_chat.reasoning_effort_top_level' }
    } as Parameters<typeof galgameApiFromEffectiveProfile>[0], '保持角色克制')
    check('Galgame Agent 使用当前 Profile 模型/推理/预设', selectedApi.model === 'writer-model' && selectedApi.maxTokens === 6000 && selectedApi.thinking?.enabled === true && selectedApi.thinking.effort === 'medium' && selectedApi.userPresetPrompt === '保持角色克制')

    const realSdkCandidates = [process.env.DW_RENPY_SDK, path.resolve(process.cwd(), '..', 'renpy-8.5.3-sdk')].filter((value): value is string => Boolean(value))
    const realSdk = realSdkCandidates.find((value) => fs.existsSync(path.join(value, 'renpy.py')) && fs.existsSync(path.join(value, 'lib', 'py3-windows-x86_64', 'python.exe')))
    if (!realSdk || process.platform !== 'win32') {
      console.log('  INFO  real SDK lint: not_run（本机未找到可执行 Windows SDK）')
    } else {
      const realProject = path.join(tmp, 'real-project')
      await fsp.mkdir(path.join(realProject, 'game'), { recursive: true })
      await fsp.writeFile(path.join(realProject, 'game', 'config.rpy'), 'define config.name = "R55 Fixture"\n')
      await fsp.writeFile(path.join(realProject, 'game', 'script.rpy'), 'label start:\n    "hello"\n    return\n')
      const realInspection = await inspectRenpySdk({ userDataDir: tmp, explicitPath: realSdk })
      const realDiscovery = await inspectRenpySdk({ userDataDir: path.join(tmp, 'real-discovery-userdata'), discoveryRoots: [realSdk] })
      const realLint = realInspection.candidate ? await runRenpyLint(realInspection.candidate.layout, realProject) : null
      check('真实 SDK --version 检查通过', realInspection.status === 'ready' && realInspection.candidate?.version === '8.5.3')
      check('真实 SDK 自动发现并通过版本检查', realDiscovery.status === 'ready' && realDiscovery.candidate?.source === 'discovered' && realDiscovery.candidate.version === '8.5.3')
      check('真实 SDK lint --error-code 通过', Boolean(realLint?.ok && realLint.verified), realLint?.output.slice(-500))
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
  console.log(`\n===== R55 Galgame Studio 结果：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('R55 Galgame Studio 测试异常：', error)
  process.exit(2)
})
