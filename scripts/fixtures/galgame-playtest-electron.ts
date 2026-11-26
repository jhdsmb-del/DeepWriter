export const apiCapture: { value?: Record<string, (...args: unknown[]) => unknown> } = {}
export const invocations: Array<{ channel: string; input: unknown }> = []
export const contextBridge = { exposeInMainWorld(_name: string, value: typeof apiCapture.value): void { apiCapture.value = value } }
export const ipcRenderer = {
  invoke(channel: string, input: unknown): Promise<unknown> { invocations.push({ channel, input }); return Promise.resolve({ status: 'stopped' }) },
  on(): void {}, removeListener(): void {}, send(): void {}
}
export const webUtils = { getPathForFile(): string { return '' } }
