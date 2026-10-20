import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('.', import.meta.url))
export default defineConfig({
  root,
  envDir: fileURLToPath(new URL('..', import.meta.url)),
  base: process.env.SITE_BASE || '/os3150-site/',
  plugins: [vue()],
  resolve: {
    alias: [
      { find: /^vitepress$/, replacement: root + 'src/reader-context.ts' },
    ],
  },
  build: {
    outDir: '../dist-reader',
    emptyOutDir: true,
    sourcemap: false,
  },
})
