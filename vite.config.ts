import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { crx } from '@crxjs/vite-plugin'
import tsconfigPaths from 'vite-tsconfig-paths'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import manifest from './src/manifest.config'

const HINT_MIN_LEN = 4
const HINT_MAX_COUNT = 3
const REGEX_LITERAL_SPLIT = /[\\^$.|?*+()[\]{}]/
const REGEX_CONTROL_ESCAPE = /\\[bBdDsSwW]/g
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g

const escapeForRegex = (value: string) => value.replace(REGEX_ESCAPE, '\\$&')

const normalizeHintCandidate = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim()

const extractRuleHints = (patterns: unknown, isKeyword: boolean): string[] => {
  if (!Array.isArray(patterns) || !patterns.length) return []
  const candidates: string[] = []
  for (const pattern of patterns) {
    const text = String(pattern || '')
    if (!text) continue
    if (isKeyword) {
      const lower = text.toLowerCase().trim()
      if (lower.length >= HINT_MIN_LEN) candidates.push(lower)
      continue
    }
    for (const segment of text.replace(REGEX_CONTROL_ESCAPE, ' ').split(REGEX_LITERAL_SPLIT)) {
      const lower = normalizeHintCandidate(segment)
      if (lower.length >= HINT_MIN_LEN) candidates.push(lower)
    }
  }
  return [...new Set(candidates)].sort((a, b) => b.length - a.length).slice(0, HINT_MAX_COUNT)
}

const buildKeywordCombinedSource = (patterns: unknown): string => {
  if (!Array.isArray(patterns) || !patterns.length) return ''
  const segments = patterns
    .map(pattern => String(pattern || '').trim())
    .filter(Boolean)
    .map(escapeForRegex)
  return segments.length ? segments.join('|') : ''
}

const isLeafRule = (node: any): boolean => Boolean(node) && typeof node === 'object' && !Array.isArray(node) && Array.isArray(node.patterns)

const precompileRuleTree = (node: any): void => {
  if (!node) return
  if (Array.isArray(node)) {
    for (const item of node) precompileRuleTree(item)
    return
  }
  if (typeof node !== 'object') return
  if (isLeafRule(node)) {
    const isKeyword = node.matchType === 'keyword'
    const hints = Array.isArray(node.__hints) && node.__hints.length ? node.__hints : extractRuleHints(node.patterns, isKeyword)
    if (hints.length) node.__hints = hints
    if (isKeyword) {
      const combined = buildKeywordCombinedSource(node.patterns)
      if (combined) node.__keywordCombined = combined
    }
    return
  }
  for (const key in node) precompileRuleTree(node[key])
}

const precompileRulesPlugin = (): Plugin => ({
  name: 'stackprism:precompile-rules',
  apply: 'build',
  closeBundle() {
    const rulesDir = path.resolve(__dirname, 'dist/rules')
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
  closeBundle() {
    const distDir = path.resolve(__dirname, 'dist')
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
  plugins: [vue(), crx({ manifest }), tsconfigPaths(), precompileRulesPlugin(), minifyJsonAssets()],
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler'
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      vue: 'vue/dist/vue.runtime.esm-bundler.js'
    }
  },
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        help: path.resolve(__dirname, 'src/ui/help/index.html')
      }
    }
  }
})
