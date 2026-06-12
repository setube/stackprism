// @ts-nocheck
import { safeDecodeURIComponent } from '@/utils/url'
import { isDetectablePageUrl } from '@/utils/page-support'
import { mergeTechnologyRecords, normalizeDynamicFallbackTechName, shortHeaderUrl } from './merge'
import {
  createCollector,
  filterCustomRulesForTarget,
  matchesCompiledRulePatterns,
  matchesRuleTextHints,
  passesRulePrefilter
} from './rule-matcher'
import { clearBadge, clearTabSession, getTabData, getTabSnapshot } from './tab-store'
import { saveTabDataAndBadge } from './detection'
import { buildEffectivePageRules, loadDetectorSettings, loadTechRules } from './detector-settings'
import { scheduleBundleLicenseDetection } from './bundle-license'
import { withTabWriteLock } from './tab-write-lock'

const DYNAMIC_FAST_LOOKUP_RULE_MIN = 1000
const DYNAMIC_SNAPSHOT_PROCESS_DELAY = 400

const dynamicFrontendRuleKeyCache = new WeakMap()
const dynamicFrontendHintsFlagCache = new WeakMap()
const pendingDynamicSnapshots = new Map()
const dynamicSnapshotTimers = new Map()
const DYNAMIC_FRONTEND_CDN_PATTERN =
  /cdnjs|jsdelivr|unpkg|esm\.|skypack|jspm|staticfile|bootcdn|baomitu|googleapis|aspnetcdn|githack|rawgit|gitcdn|bundle\.run|pika/

// ----- 底层纯函数 -----

const cleanStringList = (value, max) => {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.map(item => String(item || '').slice(0, 1000)).filter(Boolean))].slice(-max)
}

const cleanFeedLinks = value => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map(link => ({
      href: String(link?.href || '').slice(0, 1000),
      type: String(link?.type || '').slice(0, 120),
      title: String(link?.title || '').slice(0, 180)
    }))
    .filter(link => link.href)
    .slice(-80)
}

const buildDynamicSnapshotSignature = snapshot =>
  [
    snapshot.url,
    ...snapshot.resources,
    ...snapshot.scripts,
    ...snapshot.stylesheets,
    ...snapshot.iframes,
    ...snapshot.feedLinks.map(link => `${link.href}|${link.type}|${link.title}`),
    ...snapshot.domMarkers
  ].join('\n')

const getUrlOrigin = value => {
  try {
    return new URL(String(value || '')).origin
  } catch {
    return ''
  }
}

const snapshotMatchesTabOrigin = (snapshot, tabUrl) => {
  const snapshotOrigin = getUrlOrigin(snapshot?.url)
  const tabOrigin = getUrlOrigin(tabUrl)
  return !snapshotOrigin || !tabOrigin || snapshotOrigin === tabOrigin
}

const isLikelyDynamicLibraryFileName = name => {
  if (!name || name.length < 2 || name.length > 60) {
    return false
  }
  if (!/[a-z]/i.test(name)) {
    return false
  }
  if (/^[a-f0-9]{8,}$/i.test(name) || /^[a-z0-9_-]{18,}$/i.test(name)) {
    return false
  }
  const genericNames = new Set([
    'app',
    'application',
    'message',
    'main',
    'index',
    'home',
    'base',
    'core',
    'common',
    'commons',
    'global',
    'runtime',
    'manifest',
    'vendor',
    'vendors',
    'chunk',
    'chunks',
    'bundle',
    'bundles',
    'min',
    'prod',
    'production',
    'development',
    'dev',
    'dist',
    'all',
    'full',
    'browser',
    'web',
    'modern',
    'legacy',
    'umd',
    'esm',
    'cjs',
    'iife',
    'module',
    'modules',
    'plugin',
    'plugins',
    'lib',
    'libs',
    'cdn',
    'scripts',
    'script',
    'custom',
    'theme',
    'frontend',
    'backend',
    'admin',
    'site',
    'page',
    'public',
    'static',
    'lazyload',
    'polyfill',
    'polyfills',
    'webpack',
    'vite',
    'parcel',
    'rollup',
    'esbuild',
    'swc',
    'turbopack',
    'rspack',
    'require',
    'requirejs',
    'system',
    'systemjs',
    // 文档站 / 内容站常见的搜索 worker 文件名（mkdocs / docusaurus / vitepress 等都叫这名），
    // 真实的搜索库（Lunr / FlexSearch / Pagefind / Algolia）会通过专用规则或官方版权注释命中
    'search',
    // 通用名，几乎所有站点都有但不属于公共库
    'sdk',
    'analytics',
    'tracker',
    'tracking',
    'beacon',
    'pixel',
    // 站点自身的内部脚本，不是公共库
    'tgwallpaper',
    'jsbin'
  ])
  if (genericNames.has(name.toLowerCase())) {
    return false
  }
  if (/^ms\.[a-z0-9_-]+$/i.test(name)) {
    return false
  }
  if (/^(?:tas-client|ethicalads|svg-loader)$/i.test(name)) {
    return false
  }
  return true
}

const compileOptionalDynamicPattern = pattern => {
  if (!pattern) {
    return null
  }
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

const compileDynamicGlobalPattern = pattern => {
  if (!pattern) {
    return null
  }
  try {
    return new RegExp(pattern, 'gi')
  } catch {
    return null
  }
}

const cleanDynamicAssetSlug = value => {
  const decoded = safeDecodeURIComponent(String(value || ''))
    .replace(/\\/g, '/')
    .replace(/['")<>]/g, '')
    .trim()
  if (!decoded || decoded.length > 90 || decoded.includes('/') || /[*{}[\]]/.test(decoded)) {
    return ''
  }
  if (!/[a-z0-9一-龥]/i.test(decoded)) {
    return ''
  }
  if (/^(?:assets?|static|public|dist|build|cache|css|js|img|images?|fonts?|vendor)$/i.test(decoded)) {
    return ''
  }
  return decoded
}

const stripPackageVersion = value => {
  const text = String(value || '')
  if (text.startsWith('@')) {
    return text
  }
  return text.replace(/@[^/]*$/, '')
}

const normalizeDynamicFrontendResourceName = name => {
  const value = safeDecodeURIComponent(String(name || ''))
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
  if (value.startsWith('@')) {
    const parts = value.split('/')
    return parts.length > 1 ? `${parts[0]}/${stripPackageVersion(parts[1])}` : value
  }
  return stripPackageVersion(value)
}

const extractPackageNameFromPath = pathname => {
  const parts = pathname.split('/').filter(Boolean)
  if (/^v\d+$/i.test(parts[0])) {
    parts.shift()
  }
  if (!parts.length) {
    return ''
  }

  if (parts[0].startsWith('@')) {
    return parts.length > 1 ? `${parts[0]}/${stripPackageVersion(parts[1])}` : ''
  }
  return stripPackageVersion(parts[0])
}

const extractDynamicMinifiedScriptLibrary = rawUrl => {
  let pathname = ''
  try {
    pathname = new URL(rawUrl).pathname
  } catch {
    pathname = String(rawUrl || '').split(/[?#]/)[0]
  }
  if (/\/wp-includes\/js\/dist\//i.test(pathname)) {
    return null
  }
  const fileName = safeDecodeURIComponent(pathname.split('/').filter(Boolean).pop() || '')
  if (!/\.js$/i.test(fileName) || !/(?:^|[.-])min\.js$/i.test(fileName)) {
    return null
  }

  const name = fileName
    .replace(/\.js$/i, '')
    .replace(
      /(?:[._-](?:min|prod|production|development|dev|bundle|bundled|umd|esm|cjs|iife|global|runtime|legacy|modern|browser|web|all|full))+$/gi,
      ''
    )
    .replace(/(?:[._-]pkgd)$/i, '')
    .replace(/(?:[._-]v?\d+(?:\.\d+){1,4})$/i, '')
    .replace(/(?:[._-][a-f0-9]{7,})$/i, '')
    .replace(/^npm\./i, '')
    .replace(/^@/, '')
    .trim()

  if (!isLikelyDynamicLibraryFileName(name)) {
    return null
  }
  return { name, fileName }
}

// ----- 资源名收集 -----

const addDynamicFrontendResourceName = (target, name, rawUrl) => {
  const key = normalizeDynamicFrontendResourceName(name)
  if (!key || target.has(key)) {
    return
  }
  target.set(key, rawUrl)
}

const collectJsDelivrPackageNames = (pathname, add) => {
  const npmPattern = /(?:^|[,/])npm\/((?:@[^/@?#,]+\/)?[^/@?#,]+)/gi
  let match
  while ((match = npmPattern.exec(pathname))) {
    add(match[1])
  }

  const githubPattern = /(?:^|[,/])gh\/[^/@?#,]+\/([^/@?#,]+)/gi
  while ((match = githubPattern.exec(pathname))) {
    add(match[1])
  }
}

const addDynamicFrontendResourceNames = (target, rawUrl) => {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return
  }

  const host = url.hostname.toLowerCase()
  const pathname = safeDecodeURIComponent(url.pathname || '')
  const lowerPath = pathname.toLowerCase()
  const add = name => addDynamicFrontendResourceName(target, name, rawUrl)

  if (lowerPath.includes('/ajax/libs/')) {
    add(pathname.split('/ajax/libs/')[1]?.split('/')[0])
  }

  if (/^(?:cdn|fastly|gcore)\.jsdelivr\.net$/.test(host)) {
    collectJsDelivrPackageNames(pathname, add)
  }

  if (host === 'unpkg.com' || host === 'esm.sh' || host === 'esm.run' || host === 'cdn.skypack.dev') {
    add(extractPackageNameFromPath(pathname))
  }

  if (host === 'jspm.dev') {
    add(extractPackageNameFromPath(pathname.replace(/^\/npm:/, '/')))
  }

  if (host === 'ga.jspm.io') {
    const match = pathname.match(/\/npm:((?:@[^/@?#,]+\/)?[^/@?#,]+)/i)
    add(match?.[1])
  }

  if (host === 'bundle.run' || host === 'cdn.pika.dev') {
    add(extractPackageNameFromPath(pathname))
  }

  if (host === 'cdn.staticfile.net' || host === 'cdn.staticfile.org' || host === 'lib.baomitu.com' || host === 'cdn.baomitu.com') {
    add(pathname.split('/').filter(Boolean)[0])
  }

  if (host === 'ajax.googleapis.com' || host === 'ajax.aspnetcdn.com') {
    add(pathname.split('/ajax/libs/')[1]?.split('/')[0] || pathname.split('/').filter(Boolean)[1])
  }

  if (host === 'rawcdn.githack.com' || host === 'rawgit.com' || host === 'cdn.rawgit.com') {
    const parts = pathname.split('/').filter(Boolean)
    add(parts[1])
  }

  if (host === 'gitcdn.xyz' || host === 'gitcdn.link') {
    const parts = pathname.split('/').filter(Boolean)
    const repoIndex = parts.indexOf('repo')
    add(repoIndex >= 0 ? parts[repoIndex + 2] : '')
  }
}

const collectDynamicFrontendResourceNames = urls => {
  const names = new Map()
  for (const rawUrl of urls) {
    addDynamicFrontendResourceNames(names, rawUrl)
  }
  return names
}

// ----- 规则匹配上下文与查找 -----

const extractDynamicFrontendNamesFromPattern = pattern => {
  const text = String(pattern || '')
    .replace(/\\\./g, '.')
    .replace(/\\\//g, '/')
    .replace(/\\-/g, '-')
  const names = []
  const extractors = [
    /ajax\/libs\/([^/\\([?:|]+)/i,
    /npm\/((?:@[^/\\([?:|]+\/)?[^/@/\\([?:|]+)/i,
    /npm:((?:@[^/\\([?:|]+\/)?[^/@/\\([?:|]+)/i,
    /(?:unpkg|esm\.sh|esm\.run|bundle\.run|cdn\.pika\.dev|cdn\.skypack\.dev)\/((?:@[^/\\([?:|]+\/)?[^/@/\\([?:|]+)/i,
    /gh\/[^/\\([?:|]+\/([^/@/\\([?:|]+)/i,
    /(?:staticfile\.(?:net|org)|baomitu\.com|googleapis\.com|aspnetcdn\.com)\/(?:ajax\/libs\/)?([^/\\([?:|]+)/i
  ]

  for (const extractor of extractors) {
    const match = text.match(extractor)
    if (match?.[1]) {
      names.push(match[1])
    }
  }
  return names
}

const getDynamicFrontendRuleLookupKeys = rule => {
  if (!rule || typeof rule !== 'object') {
    return []
  }

  const cached = dynamicFrontendRuleKeyCache.get(rule)
  if (cached) {
    return cached
  }

  const keys = new Set([normalizeDynamicFrontendResourceName(rule.name)])
  for (const pattern of rule.patterns || []) {
    for (const name of extractDynamicFrontendNamesFromPattern(pattern)) {
      keys.add(normalizeDynamicFrontendResourceName(name))
    }
  }
  const values = [...keys].filter(Boolean)
  dynamicFrontendRuleKeyCache.set(rule, values)
  return values
}

const matchesDynamicFrontendCdnHints = rule => {
  if (!rule || typeof rule !== 'object') return false
  const cached = dynamicFrontendHintsFlagCache.get(rule)
  if (cached !== undefined) return cached
  const hints = Array.isArray(rule.resourceHints) ? rule.resourceHints.join('\n').toLowerCase() : ''
  const result = DYNAMIC_FRONTEND_CDN_PATTERN.test(hints)
  dynamicFrontendHintsFlagCache.set(rule, result)
  return result
}

const isDynamicFrontendResourceOnlyRule = (rule, defaultCategory) => {
  const category = rule?.category || defaultCategory || ''
  if (category !== '前端库' || rule?.resourceOnly !== true) {
    return false
  }
  return matchesDynamicFrontendCdnHints(rule)
}

const shouldUseDynamicFrontendLookup = (rules, defaultCategory) => {
  if (!Array.isArray(rules) || rules.length < DYNAMIC_FAST_LOOKUP_RULE_MIN) {
    return false
  }
  return rules.some(rule => isDynamicFrontendResourceOnlyRule(rule, defaultCategory))
}

const matchDynamicFrontendLookup = (rule, context, defaultCategory) => {
  if (!isDynamicFrontendResourceOnlyRule(rule, defaultCategory)) {
    return ''
  }
  for (const key of getDynamicFrontendRuleLookupKeys(rule)) {
    const url = context.frontendResourceNames?.get(key)
    if (url) {
      return url
    }
  }
  return ''
}

const buildDynamicMatchContext = (snapshot, text) => {
  const resourceUrls = [
    snapshot.url,
    ...(snapshot.resources || []),
    ...(snapshot.scripts || []),
    ...(snapshot.stylesheets || []),
    ...(snapshot.iframes || [])
  ]
  const uniqueResourceUrls = [...new Set(resourceUrls.map(url => String(url || '')).filter(Boolean))]
  return {
    text,
    lowerText: text,
    resourceText: uniqueResourceUrls.join('\n').toLowerCase(),
    frontendResourceNames: collectDynamicFrontendResourceNames(uniqueResourceUrls)
  }
}

// ----- 兜底脚本与 CMS 主题资源 -----

const detectDynamicMinifiedScriptFallback = (add, snapshot, currentTechnologies) => {
  const knownNames = new Set(currentTechnologies.map(tech => normalizeDynamicFallbackTechName(tech.name)))
  const seen = new Set()
  const urls = [...new Set([...(snapshot.scripts || []), ...(snapshot.resources || [])])]
  for (const rawUrl of urls) {
    const info = extractDynamicMinifiedScriptLibrary(rawUrl)
    if (!info) {
      continue
    }
    const normalized = normalizeDynamicFallbackTechName(info.name)
    if (!normalized || seen.has(normalized) || knownNames.has(normalized)) {
      continue
    }
    seen.add(normalized)
    add('前端库', `疑似前端库: ${info.name}`, '低', `兜底识别：根据动态脚本文件名 ${info.fileName} 判断，未匹配到内置规则或官网链接`)
    if (seen.size >= 20) {
      break
    }
  }
}

const collectDynamicAssetDirectoryMatches = (add, text, extractor) => {
  const requires = compileOptionalDynamicPattern(extractor.requires)
  if (requires && !requires.test(text)) {
    return
  }

  let count = 0
  const limit = extractor.limit || 12
  const seen = new Set()
  const pattern = compileDynamicGlobalPattern(extractor.pattern)
  if (!pattern) {
    return
  }
  let match
  while ((match = pattern.exec(text)) && count < limit) {
    const groups = match.slice(1).map(cleanDynamicAssetSlug)
    if (groups.some(value => !value)) {
      continue
    }
    const value = extractor.format === 'joinSlash' ? groups.join('/') : groups[0]
    const key = `${extractor.category}::${extractor.label}::${value}`.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    count += 1
    add(extractor.category, `${extractor.label}: ${value}`, '高', `动态资源路径包含 ${shortHeaderUrl(match[0])}`)
  }
}

const detectDynamicCmsThemesAndSource = (add, text, extractors) => {
  for (const extractor of extractors) {
    collectDynamicAssetDirectoryMatches(add, text, extractor)
  }
}

// ----- 规则应用 -----

const applyDynamicRuleList = (add, rules, contextOrText, sourceLabel, defaultCategory, evidencePrefix = () => '') => {
  if (!Array.isArray(rules) || !rules.length) {
    return
  }

  const context =
    typeof contextOrText === 'string'
      ? { text: contextOrText, lowerText: contextOrText.toLowerCase(), resourceText: contextOrText.toLowerCase() }
      : contextOrText || {}
  const useFrontendLookup = shouldUseDynamicFrontendLookup(rules, defaultCategory)

  for (const rule of rules) {
    const frontendLookupUrl = useFrontendLookup ? matchDynamicFrontendLookup(rule, context, defaultCategory) : ''
    if (frontendLookupUrl) {
      add(
        rule.category || defaultCategory || '其他库',
        rule.name,
        rule.confidence || '中',
        `${evidencePrefix(rule)}资源 URL 匹配 ${shortHeaderUrl(frontendLookupUrl)}`
      )
      continue
    }

    if (useFrontendLookup && isDynamicFrontendResourceOnlyRule(rule, defaultCategory)) {
      continue
    }

    if (!matchesRuleTextHints(rule, context)) {
      continue
    }
    const resourceScoped =
      rule?.resourceOnly === true ||
      (Array.isArray(rule?.matchIn) &&
        rule.matchIn.length > 0 &&
        rule.matchIn.every((item: string) => ['resources', 'url', 'dynamic'].includes(item)))
    const matchText = resourceScoped ? context.resourceText || context.lowerText || '' : context.lowerText || context.text || ''
    if (!passesRulePrefilter(rule, matchText)) {
      continue
    }
    const matched = matchesCompiledRulePatterns(rule, matchText)
    if (!matched) {
      continue
    }
    add(rule.category || defaultCategory || '其他库', rule.name, rule.confidence || '中', `${evidencePrefix(rule)}${sourceLabel} 匹配`)
  }
}

// ----- 顶层流程 -----

const detectFromDynamicSnapshot = (snapshot, pageRules) => {
  const technologies = []
  const add = createCollector(technologies, '动态监控')
  const text = [
    snapshot.url,
    snapshot.title,
    ...snapshot.resources,
    ...snapshot.scripts,
    ...snapshot.stylesheets,
    ...snapshot.iframes,
    ...snapshot.feedLinks.map(link => `${link.href} ${link.type} ${link.title}`),
    ...snapshot.domMarkers
  ]
    .join('\n')
    .toLowerCase()
  const context = buildDynamicMatchContext(snapshot, text)

  applyDynamicRuleList(add, pageRules.dynamicTechnologies, context, 'JSON 动态技术规则')
  applyDynamicRuleList(add, pageRules.frontendFrameworks, context, 'JSON 前端框架动态规则', '前端框架')
  applyDynamicRuleList(add, pageRules.uiFrameworks, context, 'JSON UI 框架动态规则', 'UI / CSS 框架')
  applyDynamicRuleList(add, pageRules.frontendExtra, context, 'JSON 前端库动态规则', '前端库')
  applyDynamicRuleList(add, pageRules.buildRuntime, context, 'JSON 构建运行时动态规则', '构建与运行时')
  detectDynamicMinifiedScriptFallback(add, snapshot, technologies)
  applyDynamicRuleList(add, pageRules.cdnProviders, context, 'JSON CDN 动态规则', 'CDN / 托管')
  applyDynamicRuleList(add, pageRules.websitePrograms, context, 'JSON 网站程序动态规则', '网站程序', rule =>
    rule.kind ? `${rule.kind}：` : ''
  )
  detectDynamicCmsThemesAndSource(add, text, pageRules.dynamicAssetExtractors || [])
  applyDynamicRuleList(add, pageRules.cmsThemes, context, 'JSON 主题模板动态规则', '主题 / 模板', rule =>
    rule.kind ? `${rule.kind}：` : ''
  )
  applyDynamicRuleList(add, pageRules.probes, context, 'JSON 探针动态规则', '探针 / 监控', rule => (rule.kind ? `${rule.kind}：` : ''))
  applyDynamicRuleList(add, pageRules.languages, context, 'JSON 语言动态规则', '开发语言 / 运行时', rule =>
    rule.kind ? `${rule.kind}：` : ''
  )
  applyDynamicRuleList(add, pageRules.backendHints, context, 'JSON 后端动态规则', '后端 / 服务器框架')
  applyDynamicRuleList(add, pageRules.saasServices, context, 'JSON SaaS 动态规则', 'SaaS / 第三方服务', rule =>
    rule.kind ? `${rule.kind}：` : ''
  )
  applyDynamicRuleList(add, pageRules.thirdPartyLogins, context, 'JSON 第三方登录动态规则', '第三方登录 / OAuth', rule =>
    rule.kind ? `${rule.kind}：` : ''
  )
  applyDynamicRuleList(add, pageRules.paymentSystems, context, 'JSON 支付动态规则', '支付系统', rule => (rule.kind ? `${rule.kind}：` : ''))
  applyDynamicRuleList(add, pageRules.analyticsProviders, context, 'JSON 统计动态规则', '统计 / 分析', rule =>
    rule.kind ? `${rule.kind}：` : ''
  )
  applyDynamicRuleList(add, pageRules.feeds, context, 'JSON Feed 动态规则', 'RSS / 订阅')
  applyDynamicRuleList(add, filterCustomRulesForTarget(pageRules.customRules, 'dynamic'), context, '自定义动态规则', '其他库', rule =>
    rule.kind ? `${rule.kind}：` : ''
  )

  for (const link of snapshot.feedLinks) {
    const value = `${link.href} ${link.type}`.toLowerCase()
    const name = value.includes('atom') ? 'Atom Feed' : value.includes('json') ? 'JSON Feed' : 'RSS Feed'
    add('RSS / 订阅', name, '高', `动态发现 feed 链接：${shortHeaderUrl(link.href)}`)
  }

  return mergeTechnologyRecords(technologies)
}

const normalizeDynamicSnapshot = (snapshot, pageRules, previousDynamic) => {
  const clean = {
    url: String(snapshot?.url || ''),
    title: String(snapshot?.title || ''),
    startedAt: Number(snapshot?.startedAt || Date.now()),
    updatedAt: Number(snapshot?.updatedAt || Date.now()),
    mutationCount: Number(snapshot?.mutationCount || 0),
    resourceCount: Number(snapshot?.resourceCount || 0),
    resources: cleanStringList(snapshot?.resources, 300),
    scripts: cleanStringList(snapshot?.scripts, 300),
    stylesheets: cleanStringList(snapshot?.stylesheets, 300),
    iframes: cleanStringList(snapshot?.iframes, 120),
    feedLinks: cleanFeedLinks(snapshot?.feedLinks),
    domMarkers: cleanStringList(snapshot?.domMarkers, 120)
  }
  clean.signature = buildDynamicSnapshotSignature(clean)
  if (previousDynamic?.signature === clean.signature && Array.isArray(previousDynamic.technologies)) {
    clean.technologies = previousDynamic.technologies
    return clean
  }
  clean.technologies = detectFromDynamicSnapshot(clean, pageRules)
  return clean
}

const processQueuedDynamicSnapshot = async tabId => {
  const snapshot = pendingDynamicSnapshots.get(tabId)
  pendingDynamicSnapshots.delete(tabId)
  if (!snapshot) {
    return
  }

  const tab = await getTabSnapshot(tabId)
  if (!isDetectablePageUrl(tab.url)) {
    await clearTabSession(tabId)
    clearBadge(tabId)
    return
  }
  if (!snapshotMatchesTabOrigin(snapshot, tab.url)) {
    return
  }

  const [rules, settings] = await Promise.all([loadTechRules(), loadDetectorSettings()])
  const pageRulesForDynamic = buildEffectivePageRules(rules.page || {}, settings)
  // 进 per-tab 锁:跟 detection / bundle / webRequest 串行做 read-modify-write,避免并发覆盖
  await withTabWriteLock(tabId, async () => {
    const latest = (await getTabData(tabId)) || {}
    latest.dynamic = normalizeDynamicSnapshot(snapshot, pageRulesForDynamic, latest.dynamic)
    latest.updatedAt = Date.now()
    await saveTabDataAndBadge(tabId, latest, settings)
  })
  scheduleBundleLicenseDetection(tabId)
}

export const clearDynamicSnapshotTimer = tabId => {
  const timer = dynamicSnapshotTimers.get(tabId)
  if (timer) {
    clearTimeout(timer)
    dynamicSnapshotTimers.delete(tabId)
  }
}

export const queueDynamicSnapshot = (tabId, snapshot) => {
  if (typeof tabId !== 'number' || tabId < 0) {
    return
  }
  pendingDynamicSnapshots.set(tabId, snapshot)
  clearDynamicSnapshotTimer(tabId)
  const timer = setTimeout(() => {
    dynamicSnapshotTimers.delete(tabId)
    processQueuedDynamicSnapshot(tabId).catch(() => {})
  }, DYNAMIC_SNAPSHOT_PROCESS_DELAY)
  dynamicSnapshotTimers.set(tabId, timer)
}

export const clearPendingDynamicSnapshot = tabId => {
  pendingDynamicSnapshots.delete(tabId)
}

export const clearDynamicSnapshotState = tabId => {
  clearDynamicSnapshotTimer(tabId)
  clearPendingDynamicSnapshot(tabId)
}
