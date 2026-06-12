import { defineConfig } from 'vite'
import path from 'node:path'

const ENTRIES = {
  'page-detector': 'src/injected/page-detector.ts',
  'page-source-search': 'src/injected/page-source-search.ts',
  'experience-profiler': 'src/injected/experience-profiler.ts'
} as const

type EntryName = keyof typeof ENTRIES

const entryName = (process.env.INJECTED_ENTRY ?? '') as EntryName
if (!ENTRIES[entryName]) {
  throw new Error(`INJECTED_ENTRY must be one of: ${Object.keys(ENTRIES).join(', ')} (got "${entryName}")`)
}

export default defineConfig({
  publicDir: false,
  build: {
    outDir: process.env.INJECTED_OUT_DIR || 'public/injected',
    emptyOutDir: false,
    minify: 'esbuild',
    target: 'chrome120',
    lib: {
      entry: path.resolve(__dirname, ENTRIES[entryName]),
      formats: ['iife'],
      name: `__StackPrismInjected_${entryName.replace(/-/g, '_')}__`,
      fileName: () => `${entryName}.iife.js`
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  }
})
