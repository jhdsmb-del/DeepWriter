import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          float: resolve('src/preload/float.ts')
        }
      }
    }
  },
  renderer: {
    // Keep Vite's HTML root on the same physical drive as resolved modules
    // when Documents/the checkout is reached through a Windows junction.
    root: resolve(realpathSync(process.cwd()), 'src/renderer'),
    plugins: [react()]
  }
})
