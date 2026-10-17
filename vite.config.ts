import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { crx } from '@crxjs/vite-plugin'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import manifest from './src/manifest.config.ts'
import { precompileRuleTree } from './src/core/rule-precompiler.ts'

const precompileRulesPlugin = (): Plugin => ({
  name: 'stackprism:precompile-rules',
  apply: 'build',
  enforce: 'post',
  closeBundle() {
    const rulesDir = path.resolve(import.meta.dirname, 'dist/rules')
    let dirStat
    try {
      dirStat = statSync(rulesDir)
    } catch {
      return
    }
    if (!dirStat.isDirectory()) return

    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        const stat = statSync(full)
        if (stat.isDirectory()) out.push(...walk(full))
        else if (name.endsWith('.json') && name !== 'index.json') out.push(full)
      }
      return out
    }

    for (const file of walk(rulesDir)) {
      const original = readFileSync(file, 'utf8')
      let parsed
      try {
        parsed = JSON.parse(original)
      } catch {
        continue
      }
      precompileRuleTree(parsed)
      writeFileSync(file, JSON.stringify(parsed), 'utf8')
    }
  }
})

const minifyJsonAssets = (): Plugin => ({
  name: 'stackprism:minify-json-assets',
  apply: 'build',
  enforce: 'post',
  closeBundle() {
    const distDir = path.resolve(import.meta.dirname, 'dist')
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        const stat = statSync(full)
        if (stat.isDirectory()) out.push(...walk(full))
        else if (name.endsWith('.json')) out.push(full)
      }
      return out
    }

    for (const file of walk(distDir)) {
      const original = readFileSync(file, 'utf8')
      let parsed
      try {
        parsed = JSON.parse(original)
      } catch {
        continue
      }
      const minified = JSON.stringify(parsed)
      if (minified.length < original.length) {
        writeFileSync(file, minified, 'utf8')
      }
    }
  }
})

export default defineConfig({
  plugins: [vue(), crx({ manifest }), precompileRulesPlugin(), minifyJsonAssets()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      vue: 'vue/dist/vue.runtime.esm-bundler.js'
    }
  },
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        help: path.resolve(import.meta.dirname, 'src/ui/help/index.html')
      }
    }
  }
})
