import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildSceneMemoryCard, sceneMemoryCardHash, stableSceneMemoryJson } from '../src/main/narrative/sceneMemoryCard'
import { createRepository, type Repository, type RunRow } from '../src/main/db/repository'
import { openDb, closeDb } from '../src/main/db/migrations'
import { narrativeFactProvenanceHash } from '../src/main/narrative/factRegistry'
import { storyLedgerRevisionHashV2 } from '../src/main/narrative/storyLedger'
import type { NarrativeFact, SceneCommitManifest, SceneMemoryCard, SceneMemorySourceSegment } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1
  else {
    failed += 1
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const storyId = 'r72-story'
const projectId = 'r72-project'
const contractHash = sha('r72-contract')

function runRow(runId: string, branchId: string, parentBranchId: string | null = null, parentRevision: number | null = null): RunRow {
  return {
    run_id: runId,
    session_id: `${runId}-session`,
    status: 'completed',
    phase: 'writing',
    started_at: 1,
    updated_at: 1,
    config_json: JSON.stringify({ storyScope: { schemaVersion: 1, storyId, projectId, branchId, parentBranchId, parentRevision } }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  }
}

interface CardFixture {
  card: SceneMemoryCard
  segment: SceneMemorySourceSegment
  manifest: SceneCommitManifest
  manifestHash: string
}

function makeCard(runId: string, branchId: string, sceneId: string, storyRevision: number, text: string, options: { povCharacterId?: string | null; factId?: string } = {}): CardFixture {
  const segmentId = `${runId}-segment`
  const contentHash = sha(text)
  const stateDeltaHash = sha(`${runId}-delta`)
  const manifest: SceneCommitManifest = {
    schemaVersion: 1,
    runId,
    sceneId,
    contractId: `${sceneId}-contract`,
    contractHash,
    acceptedSegments: [{ segmentId, contentHash, charCount: text.length, chunkIndex: 0, revision: 1 }],
    sceneContentHash: contentHash,
    sceneCharCount: text.length,
    completionDecisionHash: sha(`${runId}-decision`),
    stateDeltaHash
  }
  const manifestHash = sha(stableSceneMemoryJson(manifest))
  const segment: SceneMemorySourceSegment = {
    segmentId,
    content: text,
    contentHash,
    segmentRevision: 1,
    status: 'accepted',
    sceneId,
    commitId: `${runId}:${sceneId}`,
    commitManifestHash: manifestHash,
    chunkIndex: 0
  }
  const span = { spanId: `${runId}-span`, segmentId, segmentHash: contentHash, segmentRevision: 1, manifestHash, startUtf16: 0, endUtf16: text.length, text, spanHash: contentHash }
  const evidence = { kind: 'source_span' as const, id: span.spanId, spanId: span.spanId, hash: span.spanHash }
  const input = {
    schemaVersion: 1 as const,
    status: 'canonical' as const,
    cardId: `${runId}-card`,
    storyId,
    projectId,
    branchId,
    validityEpoch: 1,
    storyRevision,
    runId,
    sceneId,
    sceneOrder: storyRevision,
    contractId: manifest.contractId,
    contractHash,
    sceneContentHash: contentHash,
    commitManifestHash: manifestHash,
    stateDeltaHash,
    povCharacterId: options.povCharacterId ?? null,
    participants: [],
    locations: [],
    objects: [],
    dramaticQuestion: null,
    valueShift: null,
    decisiveAction: null,
    turn: null,
    cost: null,
    factsEstablished: options.factId ? [{ factId: options.factId, statement: text, evidence: [evidence] }] : [],
    beliefChanges: [],
    relationshipChanges: [],
    threads: [],
    motifs: [],
    distinctivePhrases: [],
    sourceSegments: [segment],
    sourceSpans: [span],
    fieldEvidence: options.povCharacterId ? { povCharacterId: [evidence] } : {},
    expectedScope: { storyId, projectId, branchId },
    expectedValidityEpoch: 1,
    expectedStoryRevision: storyRevision,
    expectedContract: { contractId: manifest.contractId, contractHash },
    expectedBindings: { sceneContentHash: contentHash, commitManifestHash: manifestHash, stateDeltaHash },
    ledgerClaims: [],
    createdAt: 100 + storyRevision
  }
  const card = buildSceneMemoryCard(input)
  if (sceneMemoryCardHash(card) !== card.cardHash) throw new Error('fixture card hash mismatch')
  return { card, segment, manifest, manifestHash }
}

function insertCommit(db: DatabaseSync, fixture: CardFixture, sessionId: string, parentBranchId: string | null, parentRevision: number): string {
  const { card, segment, manifest, manifestHash } = fixture
  // This synthetic fixture creates one scene commit at this explicit revision;
  // its scene state, commit and manifest must describe that same mutation.
  const sceneRevision = card.storyRevision
  const deltaJson = stableSceneMemoryJson({ schemaVersion: 1, runId: card.runId, sceneId: card.sceneId, acceptedSegmentId: segment.segmentId, acceptedContentHash: segment.contentHash, contractHash: card.contractHash, changes: [], deltaHash: card.stateDeltaHash })
  db.prepare(`INSERT INTO manuscript_segments (segment_id,run_id,session_id,source_turn_id,section_id,scene_id,chunk_index,revision,status,kind,content,content_hash,char_count,supersedes_segment_id,created_at,updated_at,accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(segment.segmentId, card.runId, sessionId, null, `${card.sceneId}-section`, card.sceneId, 0, 1, 'accepted', 'prose', segment.content, segment.contentHash, segment.content.length, null, 100, 100, 100)
  db.prepare(`INSERT INTO scene_states (run_id,scene_id,section_id,contract_id,contract_hash,scene_order,lifecycle,revision,candidate_segment_id,candidate_hash,accepted_segment_id,accepted_hash,completion_decision_json,completion_evidence_hash,created_at,updated_at,completed_at,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(card.runId, card.sceneId, `${card.sceneId}-section`, card.contractId, card.contractHash, card.sceneOrder, 'committed', sceneRevision, segment.segmentId, segment.contentHash, segment.segmentId, segment.contentHash, '{}', sha(`${card.runId}-evidence`), 100, 100, 100, 100)
  db.prepare(`INSERT INTO narrative_commits (run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,revision,committed_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(card.runId, card.sceneId, segment.segmentId, segment.contentHash, card.contractHash, card.stateDeltaHash, deltaJson, sceneRevision, 100)
  db.prepare(`INSERT INTO scene_commit_manifests (run_id,scene_id,revision,manifest_json,manifest_hash,created_at) VALUES (?,?,?,?,?,?)`).run(card.runId, card.sceneId, sceneRevision, stableSceneMemoryJson(manifest), manifestHash, 100)
  const parent = parentRevision > 0
    ? db.prepare('SELECT revision_hash FROM story_ledger_revisions WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?').get(storyId, projectId, parentBranchId ?? card.branchId, parentRevision) as { revision_hash?: string | null } | undefined
    : undefined
  const parentHash = parentRevision > 0 ? (parent?.revision_hash ?? null) : null
  const revisionHash = storyLedgerRevisionHashV2({ storyId, projectId, branchId: card.branchId, revision: card.storyRevision, parentRevision, parentHash, runId: card.runId, sceneId: card.sceneId, deltaHash: card.stateDeltaHash, manifestHash, nodeType: 'revision', hashSchemaVersion: 2 })
  db.prepare(`INSERT INTO story_ledger_revisions (story_id,project_id,branch_id,revision,parent_story_id,parent_project_id,parent_branch_id,parent_revision,run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,manifest_json,manifest_hash,parent_hash,node_type,hash_schema_version,revision_hash,validity_epoch,rebase_parent_revision,rebase_parent_hash,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(storyId, projectId, card.branchId, card.storyRevision, parentBranchId ? storyId : null, parentBranchId ? projectId : null, parentBranchId, parentRevision, card.runId, card.sceneId, segment.segmentId, segment.contentHash, card.contractHash, card.stateDeltaHash, deltaJson, stableSceneMemoryJson(manifest), manifestHash, parentHash, 'revision', 2, revisionHash, 1, null, null, 100)
  db.prepare('UPDATE story_ledger_heads SET high_watermark=?, head_hash=?, updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(card.storyRevision, revisionHash, 100, storyId, projectId, card.branchId)
  db.prepare('UPDATE story_ledger_runs SET current_revision=?, updated_at=? WHERE run_id=?').run(card.storyRevision, 100, card.runId)
  return revisionHash
}

function prepareFixture(): { root: string; dbPath: string; repo: Repository; root1: CardFixture; root2: CardFixture; target: CardFixture; sibling: CardFixture; targetHeadHash: string } {
  const root = mkdtempSync(join(tmpdir(), 'dw-r72-snapshot-'))
  const dbPath = join(root, 'r72.sqlite')
  const repo = createRepository(dbPath)
  repo.open()
  repo.createRun(runRow('r72-root-1', 'main'))
  repo.close()
  const root1 = makeCard('r72-root-1', 'main', 'scene-root-1', 1, 'root scene one.')
  const root2 = makeCard('r72-root-2', 'main', 'scene-root-2', 2, 'root scene two beyond the branch cutoff.')
  const target = makeCard('r72-target', 'target', 'scene-target', 2, 'r72-pov target branch scene.', { povCharacterId: 'r72-pov', factId: 'r72-fact' })
  const sibling = makeCard('r72-sibling', 'sibling', 'scene-sibling', 2, 'sibling branch scene.')
  const rootDb = openDb(dbPath)
  rootDb.exec('BEGIN')
  insertCommit(rootDb as unknown as DatabaseSync, root1, 'r72-root-1-session', null, 0)
  rootDb.exec('COMMIT')
  closeDb(rootDb)
  const repoForRuns = createRepository(dbPath)
  repoForRuns.open()
  repoForRuns.createRun(runRow('r72-root-2', 'main'))
  repoForRuns.createRun(runRow('r72-target', 'target', 'main', 1))
  repoForRuns.createRun(runRow('r72-sibling', 'sibling', 'main', 1))
  repoForRuns.close()
  const db2 = openDb(dbPath)
  db2.exec('BEGIN')
  insertCommit(db2 as unknown as DatabaseSync, root2, 'r72-root-2-session', null, 1)
  insertCommit(db2 as unknown as DatabaseSync, target, 'r72-target-session', 'main', 1)
  insertCommit(db2 as unknown as DatabaseSync, sibling, 'r72-sibling-session', 'main', 1)
  db2.exec('COMMIT')
  closeDb(db2)
  repo.open()
  for (const fixture of [root1, root2, target, sibling]) repo.upsertSceneMemoryCard({ card: fixture.card, context: { sourceSegments: [fixture.segment], expectedScope: { storyId, projectId, branchId: fixture.card.branchId }, expectedValidityEpoch: 1, expectedStoryRevision: fixture.card.storyRevision, expectedContract: { contractId: fixture.card.contractId, contractHash }, expectedBindings: { sceneContentHash: fixture.card.sceneContentHash, commitManifestHash: fixture.card.commitManifestHash, stateDeltaHash: fixture.card.stateDeltaHash }, ledgerClaims: [] } })
  const factBase: Omit<NarrativeFact, 'provenanceHash' | 'createdAt' | 'updatedAt'> = {
    schemaVersion: 1,
    factId: 'r72-fact',
    version: 1,
    sessionId: 'r72-target-session',
    runId: 'r72-target',
    canonicalStatement: target.segment.content,
    canonicalHash: sha(target.segment.content),
    aliases: [],
    entities: [],
    sourceSlotIds: [],
    sources: [{ sourceType: 'scene', sourceId: target.card.sceneId, sourceSlotId: null, sourceRevision: target.card.storyRevision, sourceHash: target.segment.contentHash }],
    validFrom: null,
    validUntil: null,
    confidence: 1,
    status: 'active',
    visibility: 'private',
    knowers: ['r72-pov']
  }
  repo.upsertNarrativeFact({ ...factBase, provenanceHash: narrativeFactProvenanceHash(factBase), createdAt: 100, updatedAt: 100 })
  const targetDb = new DatabaseSync(dbPath)
  const targetHeadHash = (targetDb.prepare('SELECT head_hash FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(storyId, projectId, 'target') as { head_hash: string }).head_hash
  targetDb.close()
  return { root, dbPath, repo, root1, root2, target, sibling, targetHeadHash }
}

function runChecks(): void {
  const fixture = prepareFixture()
  const fence = { storyId, projectId, branchId: 'target', branchLineage: ['main', 'target'], validityEpoch: 1, storyRevision: 2, headRevision: 2, headHash: fixture.targetHeadHash }
  const snapshot = fixture.repo.getSceneRecallCorpusSnapshot({ runId: 'r72-target', sceneId: 'scene-next', expectedFence: fence })
  check('snapshot includes canonical target and ancestor within cutoff', snapshot.corpus.map((item) => item.card.cardId).join(',') === `${fixture.root1.card.cardId},${fixture.target.card.cardId}`)
  check('snapshot binds the computed source card set', snapshot.sourceCardSetHash === snapshot.scope.expectedSourceCardSetHash && snapshot.sourceCardSetHash.length === 64)
  check('snapshot items carry source validation and authority hashes', snapshot.corpus.every((item) => item.sourceValidated === true && item.authority.authorityHash.length === 64 && item.authority.sourceSnapshotHash.length === 64))
  check('causal edges stay empty without a canonical causal-link source', snapshot.corpus.every((item) => item.causalEdges?.length === 0))
  const povSnapshot = fixture.repo.getSceneRecallCorpusSnapshot({ runId: 'r72-target', sceneId: 'scene-next', povCharacterId: 'r72-pov', expectedFence: fence })
  const povTarget = povSnapshot.corpus.find((item) => item.card.cardId === fixture.target.card.cardId)
  const povUnknown = povSnapshot.corpus.filter((item) => item.card.cardId !== fixture.target.card.cardId)
  check('same-POV card with validated active fact is known', povTarget?.povKnowledge?.status === 'known' && povTarget.povKnowledge.unknownHardSource === false)
  check('cross-POV/null-POV cards are fail-closed', povUnknown.length > 0 && povUnknown.every((item) => item.povKnowledge?.status === 'unknown' && item.povKnowledge.unknownHardSource === true && item.povKnowledge.unknownEntityIds?.length === 0))
  check('sibling and ancestor beyond cutoff are excluded', !snapshot.corpus.some((item) => item.card.cardId === fixture.sibling.card.cardId || item.card.cardId === fixture.root2.card.cardId))
  let mismatch = false
  try { fixture.repo.getSceneRecallCorpusSnapshot({ runId: 'r72-target', sceneId: 'scene-next', expectedFence: { ...fence, headHash: sha('wrong') } }) } catch (error) { mismatch = error instanceof Error && error.message === 'scene_recall_snapshot_fence_mismatch' }
  check('head fence mismatch fails closed', mismatch)
  let epochMismatch = false
  try { fixture.repo.getSceneRecallCorpusSnapshot({ runId: 'r72-target', sceneId: 'scene-next', expectedFence: { ...fence, validityEpoch: 2 } }) } catch (error) { epochMismatch = error instanceof Error && error.message === 'scene_recall_snapshot_fence_mismatch' }
  check('validity epoch mismatch fails closed', epochMismatch)
  const db = new DatabaseSync(fixture.dbPath)
  db.prepare("UPDATE scene_memory_card_outbox SET payload_json='{}' WHERE card_hash=?").run(fixture.target.card.cardHash)
  db.close()
  let tampered = false
  try { fixture.repo.getSceneRecallCorpusSnapshot({ runId: 'r72-target', sceneId: 'scene-next', expectedFence: fence }) } catch (error) { tampered = error instanceof Error && error.message === 'scene_recall_snapshot_card_not_visible' }
  check('outbox payload forgery is rejected', tampered)
  fixture.repo.close()
  rmSync(fixture.root, { recursive: true, force: true })

  const manifestFixture = prepareFixture()
  const manifestDb = new DatabaseSync(manifestFixture.dbPath)
  manifestDb.prepare('UPDATE scene_commit_manifests SET manifest_json=? WHERE run_id=? AND scene_id=?').run('{}', manifestFixture.target.card.runId, manifestFixture.target.card.sceneId)
  manifestDb.close()
  let manifestTampered = false
  try { manifestFixture.repo.getSceneRecallCorpusSnapshot({ runId: 'r72-target', sceneId: 'scene-next', expectedFence: { ...fence, headHash: manifestFixture.targetHeadHash } }) } catch (error) { manifestTampered = error instanceof Error && /scene_recall_snapshot_manifest/.test(error.message) }
  check('commit manifest tampering is rejected', manifestTampered)
  manifestFixture.repo.close()
  rmSync(manifestFixture.root, { recursive: true, force: true })

  const ledgerFixture = prepareFixture()
  const ledgerDb = new DatabaseSync(ledgerFixture.dbPath)
  ledgerDb.prepare('UPDATE story_ledger_revisions SET manifest_hash=? WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?').run(sha('forged-manifest'), storyId, projectId, 'target', 2)
  ledgerDb.close()
  let ledgerTampered = false
  try { ledgerFixture.repo.getSceneRecallCorpusSnapshot({ runId: 'r72-target', sceneId: 'scene-next', expectedFence: { ...fence, headHash: ledgerFixture.targetHeadHash } }) } catch (error) { ledgerTampered = error instanceof Error && error.message === 'scene_recall_snapshot_ledger_binding_mismatch' }
  check('ledger manifest binding tampering is rejected', ledgerTampered)
  ledgerFixture.repo.close()
  rmSync(ledgerFixture.root, { recursive: true, force: true })

  const ancestorFixture = prepareFixture()
  const ancestorDb = new DatabaseSync(ancestorFixture.dbPath)
  ancestorDb.prepare('UPDATE story_ledger_heads SET validity_epoch=? WHERE story_id=? AND project_id=? AND branch_id=?').run(2, storyId, projectId, 'main')
  ancestorDb.close()
  let ancestorTampered = false
  try { ancestorFixture.repo.getSceneRecallCorpusSnapshot({ runId: 'r72-target', sceneId: 'scene-next', expectedFence: { ...fence, headHash: ancestorFixture.targetHeadHash } }) } catch (error) { ancestorTampered = error instanceof Error && error.message === 'scene_recall_snapshot_scope_missing' }
  check('ancestor epoch tampering is rejected', ancestorTampered)
  ancestorFixture.repo.close()
  rmSync(ancestorFixture.root, { recursive: true, force: true })

  const sourceFixture = prepareFixture()
  const sourceDb = new DatabaseSync(sourceFixture.dbPath)
  sourceDb.prepare('UPDATE manuscript_segments SET content=? WHERE segment_id=?').run('tampered source.', sourceFixture.target.segment.segmentId)
  sourceDb.close()
  let sourceTampered = false
  try { sourceFixture.repo.getSceneRecallCorpusSnapshot({ runId: 'r72-target', sceneId: 'scene-next', expectedFence: { ...fence, headHash: sourceFixture.targetHeadHash } }) } catch (error) { sourceTampered = error instanceof Error && error.message === 'scene_recall_snapshot_source_manifest_mismatch' }
  check('accepted prose tampering is rejected', sourceTampered)
  sourceFixture.repo.close()
  rmSync(sourceFixture.root, { recursive: true, force: true })
}

try { runChecks() } catch (error) { failed += 1; console.error('R72 snapshot execution error:', error) }
console.log(`R72 recall corpus snapshot: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
