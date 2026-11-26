// ==================== R4.5 Gate 1：Galgame lint 绑定业务 run 的 evidence 服务 ====================
// 复审 B-01：普通 galgame:lint 创建独立 activity run，不绑定业务 runId、不写 run_evidence——
// 业务完成门读不到这份 evidence，系统可能"说完成但没验证"。
// 本模块：
// - canLintRunForBusiness：owner/capability 约束（run 必须存在且非终态；终态不许补 evidence）；
// - runGalgameLintForRun：项目路径来自调用方（生产：run snapshot 冻结路径，不信 renderer）；
//   扫描目标文件集合 → 稳定 manifest hash（路径+内容 hash+排序）→ 调用快照冻结的 SDK lint →
//   把 {manifestHash, sdkVersion, ok, errorCount, warningCount, outputDigest} 原子写入 run_evidence。
// 依赖注入（lint/scan/saveEvidence）：纯 Node 可测；生产由 index.ts 接线 lintRenpyProject/scanRenpyProject。

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { computeManifestHash } from './completion/validators/renpyLint'

export interface BusinessRunRow {
  run_id: string
  status: string
  phase?: string | null
  mode?: string | null
}

export interface LintEvidenceRepo {
  getRun(runId: string): BusinessRunRow | null
}

export interface RenpyLintOutcome {
  ok: boolean
  output: string
  exitCode: number | null
}

export interface RenpyScanOutcome {
  scriptFiles: string[]
}

export interface LintForRunInput {
  runId: string
  projectDir: string
  sdkPath: string
  /** 快照冻结的 SDK 版本标识（与 evidence 一起落库；不当作模型能力证据） */
  sdkVersion?: string
  saveEvidence(runId: string, kind: string, json: string): void
  lint?: (sdkPath: string, projectDir: string) => Promise<RenpyLintOutcome>
  scan?: (projectDir: string) => Promise<RenpyScanOutcome>
}

export interface LintForRunResult {
  ok: boolean
  manifestHash: string
  errorCount: number
  warningCount: number
  fileCount: number
  written: boolean
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/**
 * owner/capability 约束：业务 run 的 lint 只能绑定存在且非终态的 run；
 * 不存在的 runId / 已终态的 run 一律拒绝（终态后补 evidence 无意义且可被伪造）。
 */
export async function canLintRunForBusiness(
  repo: LintEvidenceRepo,
  runId: string
): Promise<{ ok: true; run: BusinessRunRow } | { ok: false; reason: 'run_not_found' | 'run_terminal' }> {
  const run = repo.getRun(runId)
  if (!run) return { ok: false, reason: 'run_not_found' }
  if (TERMINAL_STATUSES.has(run.status)) return { ok: false, reason: 'run_terminal' }
  return { ok: true, run }
}

/** 单文件内容 hash（与 artifact 登记语义一致：sha256(content)） */
async function fileContentHash(absPath: string): Promise<string> {
  const content = await fsp.readFile(absPath, 'utf8')
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 解析 lint 输出的错误/警告数：优先取 "N errors"/"N warnings" 的数字；无数字格式时按词频回退
 * （修复 "0 errors" 被词频正则误计为 1 的缺陷；Ren'Py lint 标准输出形如 "0 errors, 2 warnings"） */
export function countLintIssues(output: string): { errorCount: number; warningCount: number } {
  const errNum = /(\d+)\s+errors?/i.exec(output)
  const warnNum = /(\d+)\s+warnings?/i.exec(output)
  const errorCount = errNum ? parseInt(errNum[1], 10) : (output.match(/\berrors?\b/gi) ?? []).length
  const warningCount = warnNum ? parseInt(warnNum[1], 10) : (output.match(/\bwarnings?\b/gi) ?? []).length
  return { errorCount, warningCount }
}

/**
 * 对业务 run 执行 lint 并写入 run_evidence：
 * 1) 扫描项目目标文件集合（默认复用 scanRenpyProject 语义：脚本文件列表）；
 * 2) 对每个文件计算内容 hash，得到稳定 manifest hash；
 * 3) 调用 SDK lint（默认 lintRenpyProject；测试可注入）；
 * 4) 写入 run_evidence（kind='renpy_lint'）：manifestHash/sdkVersion/ok/errorCount/warningCount/outputDigest。
 * 注意：lint 失败也会写入 evidence（ok=false）——完成门据此 blocked/等待修复，
 * 不允许"lint 失败但无记录"的静默状态。
 */
export async function runGalgameLintForRun(input: LintForRunInput): Promise<LintForRunResult> {
  const { runId, projectDir, sdkPath, saveEvidence } = input
  const sdkVersion = input.sdkVersion ?? 'unknown'
  // 1) 扫描目标文件集合（生产：scanRenpyProject 的 scriptFiles；不含 save 目录）
  const scan = input.scan ?? (async (dir: string): Promise<RenpyScanOutcome> => ({ scriptFiles: [] }))
  const { scriptFiles } = await scan(projectDir)
  // 2) 稳定 manifest hash：路径（相对 projectDir）+ 内容 hash + 排序
  const root = path.resolve(projectDir)
  const fileHashes: Array<{ path: string; hash: string }> = []
  for (const abs of scriptFiles) {
    try {
      const rel = path.relative(root, abs).split(path.sep).join('/')
      const hash = await fileContentHash(abs)
      fileHashes.push({ path: rel, hash })
    } catch {
      // 文件读取失败（已删除/权限）：不参与 manifest（跳过）；lint 仍会跑
    }
  }
  const manifestHash = computeManifestHash(fileHashes)
  // 3) SDK lint（默认 lintRenpyProject；测试注入 mock）
  const lint = input.lint ?? (async (): Promise<RenpyLintOutcome> => ({ ok: false, output: 'lint unavailable', exitCode: null }))
  let outcome: RenpyLintOutcome
  try {
    outcome = await lint(sdkPath, projectDir)
  } catch (e) {
    outcome = { ok: false, output: e instanceof Error ? e.message : String(e), exitCode: null }
  }
  // sdkVersion 未显式提供时从 lint 输出解析（"Ren'Py X.Y.Z" 首行）；解析不到如实 'unknown'
  const resolvedSdkVersion = input.sdkVersion ?? parseSdkVersion(outcome.output)
  const { errorCount, warningCount } = countLintIssues(outcome.output)
  // 4) evidence 落库（输出摘要引用 digest；原始超长 output 不进 evidence）
  const json = JSON.stringify({
    manifest_hash: manifestHash,
    sdk_version: resolvedSdkVersion,
    ok: outcome.ok && errorCount === 0,
    error_count: errorCount,
    warning_count: warningCount,
    output_digest: createHash('sha256').update(outcome.output, 'utf8').digest('hex'),
    linted_at: Date.now()
  })
  saveEvidence(runId, 'renpy_lint', json)
  return { ok: outcome.ok && errorCount === 0, manifestHash, errorCount, warningCount, fileCount: fileHashes.length, written: true }
}

/** 从 lint 输出解析 SDK 版本（如 "Ren'Py 8.3.0 ..."）；解析不到返回 undefined（调用方落 'unknown'） */
export function parseSdkVersion(output: string): string | undefined {
  const m = /Ren'Py\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i.exec(output)
  return m ? m[1] : undefined
}
