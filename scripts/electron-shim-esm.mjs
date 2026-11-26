// ESM electron shim for bundling main-process modules (novel.ts imports `electron`).
export const app = {
  getPath: () => '',
  getName: () => 'deepwriter-test',
  getVersion: () => '0.0.0'
}
export const dialog = {
  showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
  showSaveDialog: async () => ({ canceled: true, filePath: null })
}
export const webUtils = { getPathForFile: () => '' }
export const safeStorage = { isEncryptionAvailable: () => false }
export default { app, dialog, webUtils, safeStorage }
