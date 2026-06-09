import { spawnSync } from 'node:child_process'
import { rmSync, mkdirSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(__dirname, '..')

const allEntries = ['page-detector', 'page-source-search', 'experience-profiler']
const requestedEntries = String(process.env.INJECTED_ENTRIES || '')
  .split(',')
  .map(entry => entry.trim())
  .filter(Boolean)
const entries = requestedEntries.length ? requestedEntries : allEntries
const invalidEntries = entries.filter(entry => !allEntries.includes(entry))
if (invalidEntries.length) {
  console.error(`[build-injected] invalid INJECTED_ENTRIES: ${invalidEntries.join(', ')}`)
  process.exit(1)
}

const outDir = resolve(root, process.env.INJECTED_OUT_DIR || 'public/injected')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const entry of entries) {
  console.log(`\n[build-injected] building ${entry}.iife.js`)
  const result = spawnSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.injected.config.ts'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, INJECTED_ENTRY: entry, INJECTED_OUT_DIR: outDir }
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  // Vite IIFE lib mode emits `var X=function(){...}()` as the last statement.
  // chrome.scripting.executeScript({files}) needs the script's last *expression*
  // value to surface as `result`, so append a bare reference to the IIFE name.
  const globalName = `__StackPrismInjected_${entry.replace(/-/g, '_')}__`
  const filePath = resolve(outDir, `${entry}.iife.js`)
  appendFileSync(filePath, `\n${globalName};\n`)
}

console.log('\n[build-injected] done')
