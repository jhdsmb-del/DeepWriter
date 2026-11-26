module.exports = {
  app: {
    getPath: () => '',
    getName: () => 'deepwriter-test',
    getVersion: () => '0.0.0'
  },
  dialog: {
    showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
    showSaveDialog: async () => ({ canceled: true, filePath: null })
  },
  webUtils: {
    getPathForFile: () => ''
  }
}
