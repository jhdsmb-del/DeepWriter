import type { Repository } from '../main/db/repository'
import { appliedFileChange, type AppliedFileChange } from '../main/toolResultView'
import { fileEditUndoRef, undoFileEdit } from '../main/editUndo'
import type { CheckpointStore } from '../main/checkpoint'
import type { FileEditUndoRef, UndoFileEditResult } from '../shared/editUndo'

type Change = AppliedFileChange & { runId: string; toolCallId: string; undo?: Pick<FileEditUndoRef, 'status'> & { command?: string[] } }

/** JSON quoting is also accepted by the REPL for provider IDs with spaces. */
export function undoEditArguments(text: string): [string, string] {
  const match = /^\s*("(?:[^"\\]|\\.)*"|\S+)\s+("(?:[^"\\]|\\.)*"|\S+)\s*$/.exec(text)
  if (!match) throw new Error('用法：/undo-edit RUN TOOL（含空格的编号使用 JSON 双引号）')
  const decode = (word: string): string => word.startsWith('"') ? JSON.parse(word) as string : word
  return [decode(match[1]), decode(match[2])]
}

/** Replay tool receipts, without reading manuscripts or contacting a model. */
export function changesFor(repo: Repository, ids: string[]): { changes: Change[] } {
  const changes: Change[] = []
  for (const runId of ids) for (const tool of repo.getToolCallsByRun(runId)) {
    const entry = appliedFileChange({ name: tool.name, status: tool.status, argsJson: tool.args_json, resultJson: tool.result_json })
    const undo = fileEditUndoRef(repo, tool)
    if (entry) changes.push({ runId, toolCallId: tool.tool_call_id, ...entry, ...(undo ? { undo: { status: undo.status,
      ...(undo.status === 'available' ? { command: ['undo-edit', runId, tool.tool_call_id] } : {}) } } : {}) })
  }
  return { changes }
}

/** Resolve the session from durable history, never from caller-supplied paths. */
export function undoEdit(repo: Repository, checkpoints: CheckpointStore, currentRoots: { workDir: string; docDir: string }, runId: string, toolCallId: string): Promise<UndoFileEditResult> {
  const run = repo.getRun(runId)
  if (!run) throw new Error('运行不存在；用 list 查看运行编号')
  return undoFileEdit({ repository: repo, checkpoints, currentRoots }, { sessionId: run.session_id, runId, toolCallId })
}
