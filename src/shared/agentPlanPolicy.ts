import { toolAllowed } from './agentToolPolicy'
import { WORK_FILE_TOOL_NAMES } from './workFileTools'

export interface AgentReadOnlyPlan { schemaVersion: 1; access: 'read_only' }
export interface AgentPlanApproval { runId: string; hash: string }
const READ_ONLY_TOOLS = ['read_file', 'list_files', 'search_files', ...WORK_FILE_TOOL_NAMES, 'web_search', 'read_web_page'] as const

export function isReadOnlyAgentPlan(config: Record<string, unknown>): boolean {
  const plan = config.agentPlan as Partial<AgentReadOnlyPlan> | undefined
  return config.planMode === true && config.runMode === 'agent' && config.longMode !== true && plan?.schemaVersion === 1 && plan.access === 'read_only'
}

/** undefined is normal execution; old or malformed plan snapshots stay tool-free. */
export function planToolAllowList(config: Record<string, unknown>): string[] | undefined {
  if (config.planMode !== true) return undefined
  if (!isReadOnlyAgentPlan(config)) return []
  const policy = config.toolPolicy as { allowList?: string[] } | undefined
  return READ_ONLY_TOOLS.filter(name => toolAllowed(name, policy?.allowList))
}
