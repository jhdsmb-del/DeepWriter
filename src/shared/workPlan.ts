export const WORK_PLAN_TOOL = 'update_work_plan'
export type WorkStepStatus = 'pending' | 'in_progress' | 'done'
export interface WorkPlanSnapshot {
  version: 1
  blockedOn?: string
  steps: { text: string; status: WorkStepStatus }[]
}
