import type { PermissionMode, PermissionTargetType } from './types'

export type PermissionOperation = 'read' | 'create' | 'edit' | 'overwrite' | 'command'
export interface PermissionContext {
  operation?: PermissionOperation
  workspaceRoot?: string
  permissionMode?: PermissionMode
  nonInteractive?: boolean
}
export interface PermissionRequestView {
  id: string
  runId?: string
  type: PermissionTargetType
  target: string
  operation: string
  reason: string
  workspaceRoot: string | null
  canAllowForRun: boolean
}
export type PermissionAnswer = 'allow_once' | 'allow_run' | 'deny'
