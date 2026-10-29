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

// 打包 src 下的 TS 模块（解析 @/ 别名）后导入
export const loadTsModule = async file => {
  const result = await build({
    entryPoints: [path.join(repoRoot, file)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [srcAliasPlugin]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')}`)
}

export const loadHeadersModule = () => loadTsModule('src/background/headers.ts')

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

// 只带属性的元素：preload 图片、延迟执行的脚本
const attributeNode = attributes => ({ getAttribute: name => attributes[name] ?? null })

// 在 vm 里跑真实的 page-detector：fixture 提供页面地址、HTML、资源 URL、全局变量名、类名和能命中的选择器；
// scripts 是没有 .js 后缀的脚本地址，stylesheets 是没有 .css 后缀的样式表，preloads 是 preload / modulepreload 的脚本，
// images 是已加载的图片（同时进 document.images 和 initiatorType=img 的计时条目），entries 是带 initiatorType 的其他计时条目，
// preloadImages 是 preload 的图片（地址字符串，或 { href, imagesrcset }），delayedScripts 是延迟执行的脚本（{ 'data-rocket-src': 地址 } 这样的属性表）
export const runPageDetectorResult = async (pageRules, fixture) => {
  const {
    href = 'https://example.com/',
    html = '<html><head></head><body></body></html>',
    resources = [],
    scripts = [],
    stylesheets = [],
    preloads = [],
    preloadImages = [],
    delayedScripts = [],
    images = [],
    entries = [],
    globals = [],
    classes = []
  } = fixture
  const selectors = new Set(fixture.selectors || [])
  const classNodes = classes.map(token => ({ classList: [token], className: token }))
  const timingEntries = [
    ...resources.map(name => ({ name })),
    ...scripts.map(name => ({ name, initiatorType: 'script' })),
    ...[...stylesheets, ...preloads].map(name => ({ name, initiatorType: 'link' })),
    ...images.map(name => ({ name, initiatorType: 'img' })),
    ...entries
  ].map(entry => ({ nextHopProtocol: '', ...entry }))
  const document = {
    scripts: [...resources.filter(url => /\.js(?:[?#]|$)/i.test(url)), ...scripts].map(src => ({ src })),
    images: images.map(src => ({ src, currentSrc: src })),
    title: fixture.title || '',
    documentElement: { outerHTML: html },
    body: { innerText: html.replace(/<[^>]+>/g, ' ') },
    styleSheets: [],
    querySelectorAll: selector => {
      if (selector.includes('stylesheet')) {
        return [...resources.filter(url => /\.css(?:[?#]|$)/i.test(url)), ...stylesheets].map(url => ({ href: url }))
      }
      if (selector.includes('modulepreload')) return preloads.map(url => ({ href: url }))
      if (selector.includes("[as='image']"))
        return preloadImages.map(item => attributeNode(typeof item === 'string' ? { href: item } : item))
      if (selector.includes('data-rocket-src')) return delayedScripts.map(attributeNode)
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
      getEntriesByType: () => timingEntries,
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
  return context.__spDone
}

export const runPageDetector = async (pageRules, fixture) => (await runPageDetectorResult(pageRules, fixture)).technologies

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
