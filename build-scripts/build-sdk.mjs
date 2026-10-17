import { build } from 'esbuild'
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const packageDir = path.join(root, 'packages/stackprism')
const outdir = path.join(packageDir, 'dist')
if (path.dirname(outdir) !== packageDir || path.basename(outdir) !== 'dist') throw new Error('Invalid SDK output directory')
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const sdkPackage = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
const tsconfig = path.join(root, 'tsconfig.json')

// Both products share inherited defaults, prefilters, and legacy-hint semantics.
const preparation = await build({
  stdin: {
    contents:
      "export { mergeRulePartial } from './src/core/rule-normalizer'; export { precompileRuleTree } from './src/core/rule-precompiler'",
    resolveDir: root,
    loader: 'ts'
  },
  tsconfig,
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const { mergeRulePartial, precompileRuleTree } = await import(
  `data:text/javascript;base64,${Buffer.from(preparation.outputFiles[0].text).toString('base64')}`
)
const ruleDir = path.join(root, 'public/rules')
const index = JSON.parse(await readFile(path.join(ruleDir, 'index.json'), 'utf8'))
const merged = {}
for (const file of index.files) {
  const partial = JSON.parse(await readFile(path.join(ruleDir, file), 'utf8'))
  precompileRuleTree(partial)
  mergeRulePartial(merged, partial)
}
// These groups need background observation or network sampling, unsupported by this package.
delete merged.page.bundleLicenseLibraries
delete merged.page.dynamicTechnologies
const payload = { page: merged.page, headers: merged.headers }
const sha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
await writeFile(path.join(outdir, 'rules.json'), JSON.stringify({ version: rootPackage.version, sha256, ...payload }))

const browser = await build({
  entryPoints: [path.join(root, 'src/core/page-detector.ts')],
  tsconfig,
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'StackPrismDetector',
  target: 'es2022',
  minify: true
})
// esbuild emits a strict directive; use a simple parameter list so the function remains valid JavaScript.
const detectorSource = `async (input) => { ${browser.outputFiles[0].text}\nreturn StackPrismDetector.detectPageTechnologies(input.rules, input.budgetMs); }`
await build({
  entryPoints: { index: path.join(root, 'src/sdk/index.ts'), cli: path.join(root, 'src/cli/index.ts') },
  tsconfig,
  bundle: true,
  outdir,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  splitting: true,
  chunkNames: 'shared-[hash]',
  define: {
    __STACKPRISM_DETECTOR_SOURCE__: JSON.stringify(detectorSource),
    __STACKPRISM_SDK_VERSION__: JSON.stringify(sdkPackage.version)
  }
})

const config = ts.readConfigFile(tsconfig, ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const program = ts.createProgram([path.join(root, 'src/sdk/index.ts')], {
  ...parsed.options,
  noEmit: false,
  declaration: true,
  emitDeclarationOnly: true,
  rootDir: path.join(root, 'src'),
  outDir: path.join(outdir, 'types')
})
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length)
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n'
    })
  )
await mkdir(path.join(outdir, 'types'), { recursive: true })
const declarations = []
const emitted = program.emit(undefined, (file, content) => {
  // Internal extension declarations must not leak into the public package.
  if (file.replaceAll('\\', '/').includes('/types/sdk/') && ['index.d.ts', 'types.d.ts'].includes(path.basename(file))) {
    declarations.push(writeFile(path.join(outdir, 'types', path.basename(file)), content))
  }
})
if (emitted.emitSkipped) throw new Error('SDK declaration emission failed')
await Promise.all(declarations)
await copyFile(path.join(root, 'LICENSE'), path.join(packageDir, 'LICENSE'))
console.log(`Built ${sdkPackage.name}@${sdkPackage.version}; rules ${rootPackage.version} sha256:${sha256}`)
