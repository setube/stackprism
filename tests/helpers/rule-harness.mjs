// 规则测试共用的装载与运行工具：按构建期方式预编译 hint，打包 headers.ts，在 vm 里跑 page-detector.ts
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { build, transformSync } from 'esbuild'

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const srcAliasPlugin = {
  name: 'src-alias',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\// }, args => ({ path: path.join(repoRoot, 'src', `${args.path.slice(2)}.ts`) }))
  }
}

const importTs = file =>
  import(
    `data:text/javascript;base64,${Buffer.from(
      transformSync(readFileSync(path.join(repoRoot, file), 'utf8'), { loader: 'ts', format: 'esm' }).code,
      'utf8'
    ).toString('base64')}`
  )

// 与 vite.config.ts 的 precompileRulesPlugin 共用 src/utils/rule-hints.ts：运行时预筛只用构建期写入的 __hints
export const ruleHints = await importTs('src/utils/rule-hints.ts')

export const extractBuildHints = (patterns, isKeyword) => ruleHints.extractRuleHints(patterns, isKeyword)

const isPlainObject = value => Object.prototype.toString.call(value) === '[object Object]'

export const expandRules = (value, inherited = {}) => {
  if (Array.isArray(value)) return value.flatMap(item => expandRules(item, inherited))
  if (isPlainObject(value) && Array.isArray(value.rules)) {
    return value.rules.flatMap(item => expandRules(item, { ...inherited, ...(value.defaults || {}) }))
  }
  if (!isPlainObject(value)) return [value]
  const { __hints: handwritten, ...rule } = { ...inherited, ...value }
  if (!Array.isArray(rule.patterns)) return [rule]
  const { hints, legacyHints } = ruleHints.buildRuleHintFields(
    rule.patterns,
    rule.matchType === 'keyword',
    value.matchType === 'keyword',
    handwritten
  )
  // 旧门槛只留给没有 resourceHints 的规则
  const keepLegacy = legacyHints.length && !rule.resourceHints?.length
  return [{ ...rule, ...(hints.length ? { __hints: hints } : {}), ...(keepLegacy ? { __legacyHints: legacyHints } : {}) }]
}

export const readRuleFile = file => JSON.parse(readFileSync(path.join(repoRoot, 'public/rules', file), 'utf8'))

// 把若干规则文件的 page 段合并成 page-detector 需要的规则表
export const loadPageRules = files => {
  const merged = {}
  for (const file of files) {
    for (const [key, value] of Object.entries(readRuleFile(file).page || {})) {
      merged[key] = [...(merged[key] || []), ...expandRules(value)]
    }
  }
  return merged
}

export const loadHeaderRules = () => {
  const merged = {}
  for (const file of readdirSync(path.join(repoRoot, 'public/rules/headers'))) {
    for (const [key, value] of Object.entries(readRuleFile(`headers/${file}`).headers || {})) {
      merged[key] = [...(merged[key] || []), ...(key === 'interestingHeaders' ? value : expandRules(value))]
    }
  }
  return merged
}

export const loadHeadersModule = async () => {
  const result = await build({
    entryPoints: [path.join(repoRoot, 'src/background/headers.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [srcAliasPlugin]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')}`)
}

export const detectHeaders = (headersModule, headerRules, headers, url = 'https://example.com/') =>
  headersModule.buildHeaderRecord(
    {
      url,
      type: 'main_frame',
      method: 'GET',
      statusCode: 200,
      responseHeaders: Object.entries(headers).flatMap(([name, value]) => [value].flat().map(item => ({ name, value: item })))
    },
    headerRules,
    {}
  ).technologies

// 规则命中需同时满足：构建期 hint 和旧版门槛都有一个出现在文本里，且某条正则匹配
export const pageRuleMatches = (rule, text) => {
  const lower = text.toLowerCase()
  const passes = hints => !hints?.length || hints.some(hint => lower.includes(hint))
  return (
    passes(rule.__hints) &&
    passes(rule.__legacyHints) &&
    (rule.patterns || []).some(pattern => new RegExp(pattern, rule.caseSensitive ? '' : 'i').test(text))
  )
}

let detectorSource = null
const loadDetectorSource = async () => {
  if (detectorSource) return detectorSource
  const source = readFileSync(path.join(repoRoot, 'src/injected/page-detector.ts'), 'utf8').replace(
    'export default __spResult',
    'globalThis.__spDone = __spResult'
  )
  const result = await build({
    stdin: { contents: source, loader: 'ts', resolveDir: path.join(repoRoot, 'src/injected'), sourcefile: 'page-detector.ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [srcAliasPlugin]
  })
  detectorSource = result.outputFiles[0].text
  return detectorSource
}

// 在 vm 里跑真实的 page-detector：fixture 提供页面地址、HTML、资源 URL、全局变量名、类名和能命中的选择器
export const runPageDetector = async (pageRules, fixture) => {
  const {
    href = 'https://example.com/',
    html = '<html><head></head><body></body></html>',
    resources = [],
    globals = [],
    classes = []
  } = fixture
  const selectors = new Set(fixture.selectors || [])
  const classNodes = classes.map(token => ({ classList: [token], className: token }))
  const document = {
    scripts: resources.filter(url => /\.js(?:[?#]|$)/i.test(url)).map(src => ({ src })),
    images: [],
    title: fixture.title || '',
    documentElement: { outerHTML: html },
    body: { innerText: html.replace(/<[^>]+>/g, ' ') },
    styleSheets: [],
    querySelectorAll: selector => {
      if (selector.includes('stylesheet')) return resources.filter(url => /\.css(?:[?#]|$)/i.test(url)).map(url => ({ href: url }))
      if (selector === '[class]') return classNodes
      return []
    },
    querySelector: selector => (selectors.has(selector) ? {} : null),
    getElementById: () => null
  }
  const windowObject = { document, CSS: { escape: value => value }, __SP_RULES__: pageRules }
  for (const name of globals) windowObject[name] = {}
  const context = {
    window: windowObject,
    document,
    location: new URL(href),
    navigator: {},
    performance: {
      now: () => performance.now(),
      getEntriesByType: () => resources.map(name => ({ name, nextHopProtocol: '' })),
      mark() {},
      measure() {}
    },
    getComputedStyle: () => ({ length: 0, item: () => '', getPropertyValue: () => '' }),
    localStorage: { getItem: () => null },
    CSS: { escape: value => value },
    Element: class {},
    HTMLCollection: class {},
    NodeList: class {},
    setTimeout,
    console,
    URL
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(await loadDetectorSource(), context)
  const result = await context.__spDone
  return result.technologies
}

// 编译 dynamic-snapshot.ts 里的纯匹配函数；标签页存储、计时器等扩展 IO 依赖不打包
let dynamicDetector = null
export const loadDynamicSnapshotDetector = async () => {
  if (dynamicDetector) return dynamicDetector
  const source = readFileSync(path.join(repoRoot, 'src/background/dynamic-snapshot.ts'), 'utf8')
  const compiled = await build({
    stdin: {
      contents: `${source.replaceAll('export const ', 'const ')}\nexport { detectFromDynamicSnapshot };`,
      loader: 'ts',
      resolveDir: path.join(repoRoot, 'src/background')
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      srcAliasPlugin,
      {
        name: 'exclude-extension-io',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^\.\/(tab-store|detection|detector-settings|bundle-license|tab-write-lock)$/ }, args => ({
            path: args.path,
            external: true,
            sideEffects: false
          }))
        }
      }
    ]
  })
  const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
  dynamicDetector = module.detectFromDynamicSnapshot
  return dynamicDetector
}

export const createDynamicSnapshot = (overrides = {}) => ({
  url: 'https://example.com/',
  title: '',
  resources: [],
  scripts: [],
  stylesheets: [],
  iframes: [],
  feedLinks: [],
  domMarkers: [],
  ...overrides
})
