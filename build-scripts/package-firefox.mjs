import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs'
import { basename, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import archiver from 'archiver'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function packageFirefox({ root = defaultRoot, logger = console } = {}) {
  const paths = firefoxPackagePaths(root)
  copyDist(paths)
  await bundleBackground(paths, logger)
  await bundleContentScripts(paths, logger)
  const manifest = writeFirefoxManifest(paths, logger)
  const xpiPath = await writeXpi({ root, firefoxDir: paths.firefoxDir, manifest, logger })
  return { firefoxDir: paths.firefoxDir, manifestPath: paths.manifestPath, xpiPath }
}

function firefoxPackagePaths(root) {
  const firefoxDir = resolve(root, 'dist-firefox')
  return {
    distDir: resolve(root, 'dist'),
    firefoxDir,
    manifestPath: resolve(firefoxDir, 'manifest.json')
  }
}

function copyDist({ distDir, firefoxDir }) {
  if (!existsSync(distDir)) {
    throw new Error('[package-firefox] dist/ not found, run `pnpm build` first')
  }

  rmSync(firefoxDir, { recursive: true, force: true })
  cpSync(distDir, firefoxDir, { recursive: true })
}

async function bundleBackground({ firefoxDir }, logger) {
  // CRXJS outputs background as ES modules with code-split shared chunks.
  // Firefox background scripts do not support ES modules, so rebundle one IIFE.
  const loaderPath = resolve(firefoxDir, 'service-worker-loader.js')
  const loaderCode = readFileSync(loaderPath, 'utf8')
  const entryMatch = loaderCode.match(/import\s+'\.\/(assets\/[^']+)'/)
  if (!entryMatch) {
    throw new Error('[package-firefox] could not resolve service-worker-loader entry')
  }

  const entryPath = resolve(firefoxDir, entryMatch[1])
  const backgroundPath = resolve(firefoxDir, 'background.js')

  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'iife',
    outfile: backgroundPath,
    target: 'es2022',
    platform: 'browser',
    logLevel: 'warning'
  })

  logger.log('[package-firefox] bundled background.js as IIFE')
}

async function bundleContentScripts({ firefoxDir, manifestPath }, logger) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []
  const rewritten = new Map()

  for (const script of contentScripts) {
    if (!Array.isArray(script.js)) continue
    script.js = await Promise.all(script.js.map(file => bundleContentScriptFile({ firefoxDir, file, rewritten })))
  }

  if (!rewritten.size) return
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  logger.log(`[package-firefox] bundled ${rewritten.size} content script loader(s) as Firefox IIFE files`)
}

async function bundleContentScriptFile({ firefoxDir, file, rewritten }) {
  if (rewritten.has(file)) return rewritten.get(file)
  const loaderPath = resolve(firefoxDir, file)
  if (!existsSync(loaderPath)) throw new Error(`[package-firefox] content script file not found: ${file}`)

  const loaderCode = readFileSync(loaderPath, 'utf8')
  const entry = resolveContentScriptLoaderEntry(loaderCode)
  if (!entry) return file

  const outputFile = firefoxContentScriptOutputFile(file)
  mkdirSync(resolve(firefoxDir, dirname(outputFile)), { recursive: true })
  await esbuild.build({
    entryPoints: [resolve(firefoxDir, entry)],
    bundle: true,
    format: 'iife',
    outfile: resolve(firefoxDir, outputFile),
    target: 'es2022',
    platform: 'browser',
    logLevel: 'warning'
  })
  rewritten.set(file, outputFile)
  return outputFile
}

function resolveContentScriptLoaderEntry(loaderCode) {
  const match = loaderCode.match(/chrome\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)/)
  return match?.[1]?.replace(/^\/+/, '') || null
}

function firefoxContentScriptOutputFile(file) {
  const name = basename(file)
    .replace(/(?:\.ts)?-loader(?:-[^.]+)?\.js$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
  return `firefox/${name || 'content-script'}.js`
}

function writeFirefoxManifest({ manifestPath }, logger) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  if (manifest.background?.service_worker) {
    manifest.background = { scripts: ['background.js'] }
  }

  manifest.browser_specific_settings = {
    gecko: {
      id: 'stackprism@setube.github.io',
      strict_min_version: '128.0'
    }
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  logger.log('[package-firefox] manifest.json transformed')
  return manifest
}

async function writeXpi({ root, firefoxDir, manifest, logger }) {
  const releaseDir = resolve(root, 'release')
  if (!existsSync(releaseDir)) mkdirSync(releaseDir)

  const xpiName = `stackprism-v${manifest.version}.xpi`
  const xpiPath = resolve(releaseDir, xpiName)

  await new Promise((ok, reject) => {
    const output = createWriteStream(xpiPath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', ok)
    archive.on('error', error => {
      output.destroy()
      reject(error)
    })
    archive.pipe(output)
    archive.glob('**', { cwd: firefoxDir, dot: true })
    archive.finalize()
  })

  logger.log(`[package-firefox] created release/${xpiName}`)
  return xpiPath
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await packageFirefox()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
