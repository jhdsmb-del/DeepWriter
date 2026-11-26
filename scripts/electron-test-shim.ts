/** Minimal Node-only shim for the production live-path harness.
 * The harness exercises context assembly and provider fencing; no UI tool is
 * invoked, but runKernelAdapter imports the shared tool registry which has an
 * Electron dependency in the desktop build.
 */
export const app = {
  getPath(_name: string): string {
    return process.cwd()
  }
}

export const dialog = {
  async showMessageBox(): Promise<{ response: number }> {
    return { response: 0 }
  },
  async showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> {
    return { canceled: true }
  }
}
