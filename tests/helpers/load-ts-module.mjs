import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const projectRoot = path.resolve(new URL('../..', import.meta.url).pathname)
let rootPromise = mkdtemp(path.join(tmpdir(), 'stackprism-ts-test-'))
let compiled = new Map()
let imported = new Map()

const ensureTsPath = specifierPath => {
  if (specifierPath.endsWith('.ts')) return specifierPath
  return `${specifierPath}.ts`
}

const toRelativeImport = (fromFile, toFile) => {
  const relative = path.relative(path.dirname(fromFile), toFile).replaceAll(path.sep, '/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

export const resetLoadTsModuleCaches = () => {
  rootPromise = mkdtemp(path.join(tmpdir(), 'stackprism-ts-test-'))
  compiled = new Map()
  imported = new Map()
}

export const loadTsModule = async modulePath => {
  const root = await rootPromise

  const resolveProjectSpecifier = (specifier, fromSourceFile) => {
    if (specifier.startsWith('@/')) {
      return ensureTsPath(path.join(projectRoot, 'src', specifier.slice(2)))
    }
    if (specifier.startsWith('.')) {
      return ensureTsPath(path.resolve(path.dirname(fromSourceFile), specifier))
    }
    return null
  }

  const compileFile = async sourceFile => {
    const absoluteSource = path.resolve(projectRoot, sourceFile)
    if (compiled.has(absoluteSource)) return compiled.get(absoluteSource)

    const compilePromise = (async () => {
      const relativeSource = path.relative(projectRoot, absoluteSource)
      const outputFile = path.join(root, relativeSource).replace(/\.ts$/, '.mjs')

      const source = await readFile(absoluteSource, 'utf8')
      const rewriteSpecifier = async specifier => {
        const dependency = resolveProjectSpecifier(specifier, absoluteSource)
        if (!dependency) return specifier
        return toRelativeImport(outputFile, await compileFile(dependency))
      }

      let rewritten = source
      const replacements = []
      const collect = regex => {
        for (const match of source.matchAll(regex)) {
          replacements.push({
            start: match.index + match[1].length,
            end: match.index + match[0].length - match[3].length,
            specifier: match[2]
          })
        }
      }
      collect(/(\bfrom\s+['"])([^'"]+)(['"])/g)
      collect(/(\bimport\s+['"])([^'"]+)(['"])/g)

      for (const replacement of replacements.reverse()) {
        const nextSpecifier = await rewriteSpecifier(replacement.specifier)
        rewritten = `${rewritten.slice(0, replacement.start)}${nextSpecifier}${rewritten.slice(replacement.end)}`
      }

      const { outputText } = ts.transpileModule(rewritten, {
        compilerOptions: {
          module: ts.ModuleKind.ES2022,
          target: ts.ScriptTarget.ES2022
        },
        fileName: absoluteSource
      })

      await import('node:fs/promises').then(fs => fs.mkdir(path.dirname(outputFile), { recursive: true }))
      await import('node:fs/promises').then(fs => fs.writeFile(outputFile, outputText, 'utf8'))
      return outputFile
    })()

    compiled.set(absoluteSource, compilePromise)
    return compilePromise
  }

  const outputFile = await compileFile(modulePath)
  if (!imported.has(outputFile)) {
    imported.set(outputFile, import(pathToFileURL(outputFile).href))
  }
  return imported.get(outputFile)
}
