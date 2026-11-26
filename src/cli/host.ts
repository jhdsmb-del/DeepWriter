import * as path from 'node:path'

/** Real Node host boundary. The CLI bundle resolves the three legacy
 * Electron host imports here; it never loads or launches Electron. */
let paths: { dataDir: string; docDir: string } | null = null
let ask: ((message: string) => Promise<boolean>) | null = null

export function configureTerminalHost(input: { dataDir: string; docDir: string; ask?: (message: string) => Promise<boolean> }): void {
  paths = input
  ask = input.ask ?? null
}

export const app = {
  getPath(name: string): string {
    if (!paths) throw new Error('CLI host 路径尚未配置')
    if (name === 'userData') return paths.dataDir
    if (name === 'documents') return paths.docDir
    if (name === 'temp') return path.join(paths.dataDir, 'temp')
    throw new Error(`CLI 不支持桌面路径类型：${name}`)
  }
}

export const dialog = {
  async showMessageBox(options: { message?: string; detail?: string }): Promise<{ response: number }> {
    const allowed = ask ? await ask(`${options.message ?? '工具请求授权'}\n${options.detail ?? ''}`) : false
    return { response: allowed ? 0 : 1 }
  },
  async showSaveDialog(): Promise<{ canceled: true }> {
    // A GUI file picker is not an implicit path authorization in the CLI.
    return { canceled: true }
  }
}
