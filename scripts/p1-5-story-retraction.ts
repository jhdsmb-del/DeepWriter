import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createRepository, type Repository, type RunRow } from '../src/main/db/repository'
import { buildNarrativeStateDelta } from '../src/main/narrative/stateDelta'
import { storyLedgerRevisionHashV2 } from '../src/main/narrative/storyLedger'
import { buildNarrativeContextManifest } from '../src/main/narrative/narrativeContext'
import type { NarrativeLedgerScopeInput, NarrativeObjectStateChange, SceneContract } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const scope: NarrativeLedgerScopeInput = { schemaVersion: 1, storyId: 'retract-story', projectId: 'retract-project', branchId: 'main' }

const contextContract: SceneContract = {
  schemaVersion: 1,
  contractId: 'retract-contract',
  sceneId: 'future-scene',
  sectionId: 'section-1',
  revision: 1,
  order: 1,
  title: '撤回验证',
  objective: '验证未来上下文不包含已撤回事实',
  activeCharacterIds: [],
  characterIds: [],
  desire: '',
  obstacle: '',
  conflict: '',
  requiredBeatIds: [],
  requiredFactIds: [],
  forbiddenFactIds: [],
  mustHappen: [],
  mustNotHappen: [],
  handoff: '',
  threadActions: [],
  expectedStateChanges: [],
  targetChars: { min: 1, ideal: 10, max: 20 },
  acceptanceCriteria: [],
  sourceIds: [],
  outlineHash: 'c'.repeat(64),
  frozenHash: 'd'.repeat(64)
}

function runRow(runId: string, storyScope: NarrativeLedgerScopeInput): RunRow {
  const now = Date.now()
  return {
    run_id: runId,
    session_id: 'retract-session',
    status: 'completed',
    phase: 'completed',
    started_at: now,
    updated_at: now,
    config_json: JSON.stringify({ storyScope }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  }
}

function appendRevision(dbPath: string, runId: string, revision: number, holderId: string, storyScope: NarrativeLedgerScopeInput): string {
  const content = `正文 ${runId}：${holderId}持有钥匙。`
  const acceptedContentHash = createHash('sha256').update(content, 'utf8').digest('hex')
  const contractHash = createHash('sha256').update(`contract:${runId}`, 'utf8').digest('hex')
  const change: NarrativeObjectStateChange = {
    changeId: `change-${runId}`,
    revision: 1,
    kind: 'object_state',
    entityId: 'key',
    runId,
    sceneId: `scene-${runId}`,
    acceptedSegmentId: `segment-${runId}`,
    acceptedContentHash,
    contractHash,
    objectId: 'key',
    ownerId: null,
    holderId,
    holderStatus: 'known',
    locationId: 'tower',
    condition: 'held'
  }
  const delta = buildNarrativeStateDelta({
    schemaVersion: 1,
    runId,
    sceneId: `scene-${runId}`,
    acceptedSegmentId: `segment-${runId}`,
    acceptedContentHash,
    contractHash,
    changes: [change]
  })
  const db = new DatabaseSync(dbPath)
  const head = db.prepare('SELECT head_hash FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(storyScope.storyId, storyScope.projectId, storyScope.branchId) as { head_hash?: string | null } | undefined
  const parentHash = head?.head_hash ?? null
  const revisionHash = storyLedgerRevisionHashV2({
    storyId: storyScope.storyId,
    projectId: storyScope.projectId,
    branchId: storyScope.branchId,
    revision,
    parentRevision: revision - 1,
    parentHash,
    runId,
    sceneId: `scene-${runId}`,
    deltaHash: delta.deltaHash,
    manifestHash: null,
    nodeType: 'revision',
    hashSchemaVersion: 2
  })
  try {
    db.prepare(`INSERT INTO story_ledger_revisions (
      story_id, project_id, branch_id, revision, parent_story_id, parent_project_id,
      parent_branch_id, parent_revision, run_id, scene_id, accepted_segment_id,
      accepted_content_hash, contract_hash, delta_hash, delta_json, manifest_json,
      manifest_hash, parent_hash, node_type, hash_schema_version, revision_hash, committed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      storyScope.storyId, storyScope.projectId, storyScope.branchId, revision,
      null, null, null, revision - 1, runId, `scene-${runId}`, `segment-${runId}`,
      acceptedContentHash, contractHash, delta.deltaHash, JSON.stringify(delta), null,
      null, parentHash, 'revision', 2, revisionHash, Date.now()
    )
    db.prepare('UPDATE story_ledger_heads SET high_watermark=?, head_hash=?, updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(
      revision, revisionHash, Date.now(), storyScope.storyId, storyScope.projectId, storyScope.branchId
    )
    db.prepare('UPDATE story_ledger_runs SET current_revision=?, updated_at=? WHERE run_id=?').run(revision, Date.now(), runId)
  } finally {
    db.close()
  }
  return revisionHash
}

async function main(): Promise<void> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p1-5-story-retraction-'))
  const dbPath = path.join(tempRoot, 'story.db')
  let repository: Repository | null = null
  try {
    repository = createRepository(dbPath)
    repository.open()
    repository.createRun(runRow('preserved-run', scope))
    const firstHash = appendRevision(dbPath, 'preserved-run', 1, '林舟', scope)
    repository.createRun(runRow('retracted-run', { ...scope, parentRevision: 1 }))
    const secondHash = appendRevision(dbPath, 'retracted-run', 2, '沈遥', scope)
    repository.createRun(runRow('future-run', { ...scope, parentRevision: 2 }))
    check('撤回前 future run 可见两条 active revision', repository.getNarrativeLedger('future-run').length === 2)

    const preserved = repository.deleteRun('preserved-run', 'preserve')
    const afterPreserve = repository.getNarrativeLedger('future-run')
    check('仅删除执行记录不伪称撤回，story memory 明确保留', preserved.retractedRevisions === 0 && afterPreserve.length === 2 && afterPreserve.some((entry) => entry.runId === 'preserved-run'))

    const retracted = repository.deleteRun('retracted-run', 'retract')
    const afterRetract = repository.getNarrativeLedger('future-run')
    check('删除并撤回后 future context 排除目标 revision', retracted.retractedRevisions === 1 && afterRetract.length === 1 && afterRetract[0]?.runId === 'preserved-run')
    const futureScope = repository.getNarrativeLedgerScope('future-run')
    const futureManifest = futureScope ? buildNarrativeContextManifest({ runId: 'future-run', sessionId: 'retract-session', contract: contextContract, ledger: afterRetract, storyScope: futureScope, storyRevision: futureScope.currentRevision, storyHighWatermark: futureScope.highWatermark, budget: { maxChars: 20_000, maxTokens: 8_000 } }) : null
    check('未来 context manifest 不包含已撤回事实', Boolean(futureManifest && !JSON.stringify(futureManifest).includes('retracted-run') && !JSON.stringify(futureManifest).includes('沈遥')))

    const db = new DatabaseSync(dbPath)
    try {
      const oldRevision = db.prepare('SELECT revision_hash FROM story_ledger_revisions WHERE story_id=? AND project_id=? AND branch_id=? AND revision=2').get(scope.storyId, scope.projectId, scope.branchId) as { revision_hash?: string } | undefined
      const tombstone = db.prepare('SELECT revision, parent_revision, target_revision, target_revision_hash, tombstone_hash FROM story_ledger_tombstones WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as { revision: number; parent_revision: number; target_revision: number; target_revision_hash: string; tombstone_hash: string } | undefined
      const head = db.prepare('SELECT high_watermark, head_hash FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as { high_watermark: number; head_hash: string } | undefined
      check('append-only 保留旧 revision/hash，并新增可校验 tombstone', oldRevision?.revision_hash === secondHash && tombstone?.target_revision === 2 && tombstone.target_revision_hash === secondHash && tombstone.revision === 3 && head?.high_watermark === 3 && head.head_hash === tombstone.tombstone_hash)
    } finally {
      db.close()
    }

    const idempotent = repository.deleteRun('retracted-run', 'retract')
    check('重复删除/撤回幂等且不追加第二个 tombstone', idempotent.retractedRevisions === 0)

    repository.createRun(runRow('pre-retract-branch', { ...scope, branchId: 'edit-before', parentBranchId: 'main', parentRevision: 2 }))
    const branchBefore = repository.getNarrativeLedger('pre-retract-branch')
    check('已存在分支停在 parent revision 时不被主线后续撤回篡改', branchBefore.length === 2 && branchBefore.some((entry) => entry.runId === 'retracted-run'))

    repository.createRun(runRow('post-retract-branch', { ...scope, branchId: 'edit-after', parentBranchId: 'main', parentRevision: 3 }))
    const branchAfter = repository.getNarrativeLedger('post-retract-branch')
    check('撤回后新分支继承 active view，不再带入幽灵 revision', branchAfter.length === 1 && branchAfter[0]?.runId === 'preserved-run')

    repository.close()
    repository = createRepository(dbPath)
    repository.open()
    const afterRestart = repository.getNarrativeLedger('future-run')
    const afterRestartBranch = repository.getNarrativeLedger('post-retract-branch')
    check('重启后撤回结果与分支隔离保持一致', afterRestart.length === 1 && afterRestart[0]?.runId === 'preserved-run' && afterRestartBranch.length === 1 && afterRestartBranch[0]?.runId === 'preserved-run')
    check('旧 revision hash 仍可追溯', firstHash !== secondHash && repository.getNarrativeLedger('future-run').every((entry) => entry.runId !== 'retracted-run'))

    const [schemaSource, mainSource, preloadSource, storeSource, taskCenterSource, inspectorSource, dialogSource] = await Promise.all([
      fsp.readFile(path.resolve('src/shared/ipcSchemas.ts'), 'utf8'),
      fsp.readFile(path.resolve('src/main/index.ts'), 'utf8'),
      fsp.readFile(path.resolve('src/preload/index.ts'), 'utf8'),
      fsp.readFile(path.resolve('src/renderer/src/store.ts'), 'utf8'),
      fsp.readFile(path.resolve('src/renderer/src/components/TaskCenter.tsx'), 'utf8'),
      fsp.readFile(path.resolve('src/renderer/src/components/RunInspector/RunInspector.tsx'), 'utf8'),
      fsp.readFile(path.resolve('src/renderer/src/components/ConfirmDialog.tsx'), 'utf8')
    ])
    check('IPC 默认 preserve 且显式支持 retract', /export const runsDeleteSchema[\s\S]*storyAction: z\.enum\(\['preserve', 'retract'\]\)\.default\('preserve'\)/u.test(schemaSource) && mainSource.includes("registerIpc('runs:delete', { schema: schemas.runsDeleteSchema }") && mainSource.includes('repository.deleteRun(input.runId, storyAction)'))
    check('preload/store 传递显式 storyAction', preloadSource.includes("runsDelete: (runId: string, storyAction: 'preserve' | 'retract' = 'preserve')") && storeSource.includes("deleteRun: async (runId, storyAction = 'preserve')") && storeSource.includes('ds.runsDelete(runId, storyAction)'))
    check('删除对话框区分保留与撤回，并有独立危险按钮', dialogSource.includes('secondaryLabel') && taskCenterSource.includes('secondaryLabel="删除并撤回故事修订"') && inspectorSource.includes('secondaryLabel="删除并撤回故事修订"') && taskCenterSource.includes('当前故事线修订默认保留'))
  } finally {
    repository?.close()
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP1-5 story retraction: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P1-5 story retraction 执行异常：', error)
  process.exitCode = 2
})
