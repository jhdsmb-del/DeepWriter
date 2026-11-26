/** New runs opt in by name; a legacy local-tools wildcard stays frozen. */
export const WORK_FILE_TOOL_NAMES = ['find_files', 'read_files'] as const
export const isWorkFileTool = (name: string): boolean => WORK_FILE_TOOL_NAMES.some(value => value === name)
