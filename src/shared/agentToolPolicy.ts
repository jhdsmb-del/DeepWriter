/** Network and newly introduced file capabilities require explicit names.
 * A legacy local-tools wildcard cannot silently acquire new capabilities. */
import { CONVERSATION_SEARCH_TOOL } from './conversationSearch'
import { WORK_PLAN_TOOL } from './workPlan'
import { WORK_FILE_TOOL_NAMES, isWorkFileTool } from './workFileTools'
export const WEB_TOOL_NAMES = ['web_search', 'read_web_page'] as const
export function isWebTool(name: string): boolean {
  return WEB_TOOL_NAMES.some(value => value === name)
}
export function toolAllowed(name: string, allowList: readonly string[] | undefined): boolean {
  return Array.isArray(allowList) && (allowList.includes(name) || (!isWebTool(name) && !isWorkFileTool(name) && name !== WORK_PLAN_TOOL && name !== CONVERSATION_SEARCH_TOOL && allowList.includes('*')))
}
export function freezeAgentTools(localTools: boolean, webAccess: boolean, operations: ReadonlyArray<'search' | 'fetch'> = []): string[] {
  return [...(localTools ? ['*', ...WORK_FILE_TOOL_NAMES, WORK_PLAN_TOOL, CONVERSATION_SEARCH_TOOL] : []), ...(webAccess && operations.includes('search') ? ['web_search'] : []), ...(webAccess && operations.includes('fetch') ? ['read_web_page'] : [])]
}
