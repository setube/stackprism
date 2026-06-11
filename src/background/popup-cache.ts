import { compatStorage } from '@/utils/browser-compat'
import { attachTechnologyLinks } from './tech-links'
import { addStoredCustomHeaderRules } from './headers'
import { clearBadge, clearTabSession, getPopupCache, getTabData, getTabSnapshot, popupStorageKey, storageKey } from './tab-store'
import {
  canonicalizeFrontendAliasTechnologies,
  cleanMergedTechnologyEvidence,
  inferRuntimeTechnologiesFromDetectedTechnologies,
  mergeTechnologyRecords,
  strongerConfidence,
  suppressDuplicateWebsiteProgramCategories,
  suppressFrontendFallbackDuplicates,
  suppressWordPressThemeDirectoryFallbacks
} from './merge'
import { loadDetectorSettings, loadTechRules } from './detector-settings'
import { categoryIndex, confidenceRank } from '@/utils/category-order'
import { cleanTechnologyUrl } from '@/utils/url'
import { isSameSite } from '@/utils/domain'
import { cleanStringArray } from '@/utils/normalize-settings'
import { normalizeTechName } from '@/utils/tech-name'
import { checkPageSupport } from '@/utils/page-support'

export const POPUP_CACHE_STALE_MS = 2 * 60 * 1000
const POPUP_CACHE_SCHEMA_VERSION = 1

export const hasStoredDetection = (data: any) =>
  Boolean(
    data?.page ||
    data?.main ||
    data?.dynamic ||
    (data?.apis || []).length ||
    (data?.frames || []).length ||
    (data?.bundle?.technologies || []).length
  )

export const getStoredUpdatedAt = (data: any) =>
  Number(data?.updatedAt || data?.bundle?.updatedAt || data?.page?.time || data?.dynamic?.updatedAt || data?.main?.time || 0)

const unique = (items: any[]) => [...new Set(items.filter(Boolean))]

// 按 semver 数字段比较版本号("3.10.0" > "3.9.0",避免字典序坑)
const compareVersions = (a: string, b: string): number => {
  const parse = (s: string) =>
    String(s || '')
      .split('.')
      .map(x => parseInt(x, 10) || 0)
  const aa = parse(a)
  const bb = parse(b)
  const len = Math.max(aa.length, bb.length)
  for (let i = 0; i < len; i++) {
    const av = aa[i] || 0
    const bv = bb[i] || 0
    if (av !== bv) return av - bv
  }
  return 0
}

const buildSettingsCacheKey = (settings: any = {}) =>
  JSON.stringify({
    disabledCategories: cleanStringArray(settings.disabledCategories),
    disabledTechnologies: cleanStringArray(settings.disabledTechnologies),
    customRules: (settings.customRules || []).map((rule: any) => ({
      name: rule.name,
      category: rule.category,
      kind: rule.kind,
      confidence: rule.confidence,
      matchType: rule.matchType,
      patterns: rule.patterns || [],
      selectors: rule.selectors || [],
      globals: rule.globals || [],
      matchIn: rule.matchIn || [],
      url: rule.url || ''
    }))
  })

const getCachedPopupResult = (popup: any, settings: any) => {
  if (!popup || popup.cacheVersion !== POPUP_CACHE_SCHEMA_VERSION) return null
  if (popup.settingsKey !== buildSettingsCacheKey(settings)) return null
  return popup
}

const compareDisplayTechnologies = (a: any, b: any) => {
  const categoryDelta = categoryIndex(a.category) - categoryIndex(b.category)
  if (categoryDelta !== 0) return categoryDelta
  const confidenceDelta = confidenceRank(b.confidence) - confidenceRank(a.confidence)
  if (confidenceDelta !== 0) return confidenceDelta
  return a.name.localeCompare(b.name)
}

const cleanPopupTechnology = (tech: any) => {
  const out: any = {
    category: String(tech?.category || '其他库').slice(0, 80),
    name: String(tech?.name || '').slice(0, 160),
    confidence: ['高', '中', '低'].includes(tech?.confidence) ? tech.confidence : '中',
    evidence: cleanStringArray(tech?.evidence).slice(0, 8),
    sources: cleanStringArray(tech?.sources).slice(0, 8),
    url: cleanTechnologyUrl(tech?.url)
  }
  if (tech?.version && typeof tech.version === 'string') {
    out.version = String(tech.version).slice(0, 32)
  }
  return out
}

const buildTechnologyCounts = (technologies: any[]) => ({
  total: technologies.length,
  high: technologies.filter(tech => tech.confidence === '高').length,
  medium: technologies.filter(tech => tech.confidence === '中').length,
  low: technologies.filter(tech => tech.confidence === '低').length
})

const buildEmptyPopupResult = (tab: any) => ({
  url: tab?.url || '',
  title: tab?.title || '',
  generatedAt: new Date().toISOString(),
  updatedAt: 0,
  technologies: [],
  counts: buildTechnologyCounts([]),
  categoryCounts: {},
  resources: { total: 0 },
  headerCount: 0
})

const buildCategoryCounts = (technologies: any[]) =>
  technologies.reduce((acc: Record<string, number>, tech) => {
    acc[tech.category] = (acc[tech.category] || 0) + 1
    return acc
  }, {})

const mergeResourceSummary = (pageResources: any, dynamic: any) => {
  const scripts = unique([...(pageResources.scripts || []), ...(dynamic.scripts || [])])
  const stylesheets = unique([...(pageResources.stylesheets || []), ...(dynamic.stylesheets || [])])
  const dynamicResources = unique([...(dynamic.resources || []), ...(dynamic.iframes || [])])
  const all = unique([...scripts, ...stylesheets, ...dynamicResources])
  return {
    ...pageResources,
    total: Math.max(pageResources.total || 0, all.length),
    scripts: scripts.slice(0, 180),
    stylesheets: stylesheets.slice(0, 180),
    dynamicResources: dynamicResources.slice(0, 220),
    dynamicFeedLinks: dynamic.feedLinks || [],
    dynamicDomMarkers: dynamic.domMarkers || [],
    dynamicMutationCount: dynamic.mutationCount || 0,
    dynamicUpdatedAt: dynamic.updatedAt || null
  }
}

const addAllTechnologies = (target: any[], items: any[]) => {
  if (Array.isArray(items)) {
    target.push(...items)
  }
}

const CROSS_SITE_INFRASTRUCTURE_CATEGORIES = new Set(['CDN / 托管', 'Web 服务器', '后端 / 服务器框架'])

const filterCrossSiteTechnologies = (items: any[], recordUrl: unknown, pageUrl: unknown): any[] => {
  if (isSameSite(recordUrl, pageUrl)) return Array.isArray(items) ? items : []
  return (items || []).filter(tech => !CROSS_SITE_INFRASTRUCTURE_CATEGORIES.has(String(tech?.category || '')))
}

const GENERIC_CDN_FALLBACK_NAMES = new Set(['自定义 / 私有 CDN', '未知 / 自定义 CDN'])

export const suppressGenericCdnFallbacks = (technologies: any[]) => {
  if (!Array.isArray(technologies) || !technologies.length) return technologies
  const hasSpecificCdn = technologies.some(
    tech => tech?.category === 'CDN / 托管' && tech?.name && !GENERIC_CDN_FALLBACK_NAMES.has(tech.name)
  )
  if (!hasSpecificCdn) return technologies
  return technologies.filter(tech => tech?.category !== 'CDN / 托管' || !GENERIC_CDN_FALLBACK_NAMES.has(tech?.name))
}

// 同名技术既被识别为 UI / CSS 框架（或前端框架），又被归到「前端库」类目时，去掉后者的重复条目
// 例：Bootstrap 同时进了「UI / CSS 框架」和「前端库」，只保留前者
const SPECIFIC_CATEGORIES_OVER_GENERIC_LIB = new Set(['UI / CSS 框架', '前端框架', '构建与运行时'])
export const suppressGenericFrontendLibDuplicates = (technologies: any[]) => {
  if (!Array.isArray(technologies) || !technologies.length) return technologies
  const specificNames = new Set<string>()
  for (const tech of technologies) {
    if (tech?.category && SPECIFIC_CATEGORIES_OVER_GENERIC_LIB.has(tech.category) && tech.name) {
      specificNames.add(normalizeTechName(tech.name))
    }
  }
  if (!specificNames.size) return technologies
  return technologies.filter(tech => tech?.category !== '前端库' || !specificNames.has(normalizeTechName(tech.name)))
}

export const filterTechnologiesBySettings = (technologies: any[], settings: any) => {
  const disabledCategories = new Set(cleanStringArray(settings?.disabledCategories))
  const disabledTechnologies = new Set(cleanStringArray(settings?.disabledTechnologies).map(name => normalizeTechName(name)))
  return technologies.filter(tech => {
    if (disabledCategories.has(tech.category)) return false
    return !disabledTechnologies.has(normalizeTechName(tech.name))
  })
}

const mergeDisplayTechnologyRecords = (items: any[]) => {
  const map = new Map()
  const normalizedItems = suppressDuplicateWebsiteProgramCategories(
    suppressWordPressThemeDirectoryFallbacks(canonicalizeFrontendAliasTechnologies(suppressFrontendFallbackDuplicates(items)))
  )
  for (const item of inferRuntimeTechnologiesFromDetectedTechnologies(normalizedItems)) {
    if (!item?.name) continue
    const category = item.category || '其他库'
    const key = `${category}::${item.name}`.toLowerCase()
    const current = map.get(key) || {
      category,
      name: item.name,
      confidence: item.confidence || '低',
      evidence: [] as string[],
      evidenceSet: new Set<string>(),
      sources: new Set<string>(),
      url: item.url || '',
      version: item.version || ''
    }
    if (!current.url && item.url) {
      current.url = item.url
    }
    // 同一 tech 多次命中:取数值更大的版本号(按 semver 比较)
    if (item.version && (!current.version || compareVersions(item.version, current.version) > 0)) {
      current.version = item.version
    }
    current.confidence = strongerConfidence(current.confidence, item.confidence || '低')
    for (const evidence of item.evidence || []) {
      if (evidence && !current.evidenceSet.has(evidence)) {
        current.evidenceSet.add(evidence)
        current.evidence.push(evidence)
      }
    }
    if (item.source) {
      current.sources.add(item.source)
    }
    map.set(key, current)
  }

  return [...map.values()]
    .map(item => {
      const out: any = {
        category: item.category,
        name: item.name,
        confidence: item.confidence,
        url: item.url,
        evidence: cleanMergedTechnologyEvidence(item.evidence).slice(0, 8),
        sources: [...item.sources]
      }
      if (item.version) out.version = item.version
      return out
    })
    .sort(compareDisplayTechnologies)
}

const getCurrentPageUrl = (data: any, tab: any): string => tab?.url || data.dynamic?.url || data.main?.url || data.page?.url || ''

const collectRawReferenceTechnologies = (data: any, pageUrl: string = data.page?.url || data.dynamic?.url || data.main?.url || '') => {
  const items: any[] = []
  addAllTechnologies(items, data.page?.technologies)
  addAllTechnologies(items, data.main?.technologies)
  for (const api of data.apis || []) {
    addAllTechnologies(items, filterCrossSiteTechnologies(api.technologies, api.url, pageUrl))
  }
  for (const frame of data.frames || []) {
    addAllTechnologies(items, filterCrossSiteTechnologies(frame.technologies, frame.url, pageUrl))
  }
  addAllTechnologies(items, data.bundle?.technologies)
  return items
}

const cleanRawObservationTechnologies = (items: any[], referenceItems: any[] = []) =>
  mergeTechnologyRecords(suppressFrontendFallbackDuplicates(items || [], referenceItems))

const cleanRawDynamicObservation = (dynamic: any, data: any, pageUrl?: string) => {
  if (!dynamic) return null
  return {
    ...dynamic,
    technologies: cleanRawObservationTechnologies(dynamic.technologies, collectRawReferenceTechnologies(data, pageUrl))
  }
}

// 站点自身的「品牌识别」抑制：当用户就在 github.com 时不再把 GitHub.com 当作一项「使用了的技术」
// 展示出来——那是 URL 栏已经告诉他的事情。映射表本身放在 public/rules/self-host-suppress.json
// 里，方便添加新条目而不动代码
const extractRegistrableHost = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

const collectSuppressMap = (rules: any): Record<string, string[]> => {
  const raw = rules?.selfHostSuppress
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string[]> = {}
  for (const host of Object.keys(raw)) {
    const list = raw[host]
    if (!Array.isArray(list)) continue
    const names = list.filter((name: unknown): name is string => typeof name === 'string' && Boolean(name))
    if (names.length) out[host.toLowerCase()] = names
  }
  return out
}

const suppressSelfHostTechs = (technologies: any[], pageUrl: string, suppressMap: Record<string, string[]>): any[] => {
  const host = extractRegistrableHost(pageUrl)
  if (!host) return technologies
  // 主域匹配：github.com 时直接命中；gist.github.com 时按末两段 github.com 回退
  const parts = host.split('.')
  const candidates = [host, parts.slice(-2).join('.')]
  const suppressNames = new Set<string>()
  for (const candidate of candidates) {
    const list = suppressMap[candidate]
    if (list) for (const name of list) suppressNames.add(name)
  }
  if (!suppressNames.size) return technologies
  return technologies.filter(tech => !suppressNames.has(String(tech?.name || '')))
}

// 从所有 webRequest 记录里收集 HTTP 协议版本，比注入脚本里读 PerformanceResourceTiming.nextHopProtocol
// 可靠得多——跨域资源没有 Timing-Allow-Origin 时浏览器把 nextHopProtocol 置空，而 statusLine 是请求发起时浏览器自己写的
const collectHttpProtocolTechs = (data: any, pageUrl: string): any[] => {
  const protocols = new Set<string>()
  const sampleByProto = new Map<string, string>()
  const consume = (record: any) => {
    const proto = String(record?.httpProtocol || '').toLowerCase()
    if (!proto) return
    protocols.add(proto)
    if (!sampleByProto.has(proto)) sampleByProto.set(proto, String(record?.url || ''))
  }
  consume(data?.main)
  for (const api of data?.apis || []) {
    if (isSameSite(api.url, pageUrl)) consume(api)
  }
  for (const frame of data?.frames || []) {
    if (isSameSite(frame.url, pageUrl)) consume(frame)
  }
  const out: any[] = []
  const has3 = ['3', '3.0', 'h3'].some(v => protocols.has(v))
  const has2 = ['2', '2.0', 'h2', 'h2c'].some(v => protocols.has(v))
  if (has3) {
    out.push({
      category: '安全与协议',
      name: 'HTTP/3',
      confidence: '高',
      evidence: [`资源使用 HTTP/3 协议（如 ${shortHostFromUrl(sampleByProto.get('3') || sampleByProto.get('h3') || '')}）`],
      source: '响应头'
    })
  }
  if (has2) {
    out.push({
      category: '安全与协议',
      name: 'HTTP/2',
      confidence: '高',
      evidence: [
        `资源使用 HTTP/2 协议（如 ${shortHostFromUrl(sampleByProto.get('2') || sampleByProto.get('2.0') || sampleByProto.get('h2') || '')}）`
      ],
      source: '响应头'
    })
  }
  return out
}

const shortHostFromUrl = (url: string): string => {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

const buildDisplayTechnologies = (data: any, settings: any, suppressMap: Record<string, string[]>, pageUrl: string) => {
  const all: any[] = []
  addAllTechnologies(all, data.page?.technologies)
  addAllTechnologies(all, data.main?.technologies)
  addAllTechnologies(all, collectHttpProtocolTechs(data, pageUrl))
  // 跨可注册域的 API / iframe 响应头只保留明确第三方服务；CDN、服务器、
  // 后端框架等基础设施类响应头不算本站技术栈。
  for (const api of data.apis || []) {
    addAllTechnologies(
      all,
      filterCrossSiteTechnologies(api.technologies, api.url, pageUrl).map((tech: any) => ({
        ...tech,
        source: `${tech.source || '响应头'} · API`
      }))
    )
  }
  for (const frame of data.frames || []) {
    addAllTechnologies(
      all,
      filterCrossSiteTechnologies(frame.technologies, frame.url, pageUrl).map((tech: any) => ({
        ...tech,
        source: `${tech.source || '响应头'} · iframe`
      }))
    )
  }
  addAllTechnologies(
    all,
    (data.dynamic?.technologies || []).map((tech: any) => ({
      ...tech,
      source: `${tech.source || '动态监控'} · 页面交互后`
    }))
  )
  addAllTechnologies(
    all,
    (data.bundle?.technologies || []).map((tech: any) => ({
      ...tech,
      source: tech.source || 'JS 版权注释'
    }))
  )
  return filterTechnologiesBySettings(
    suppressSelfHostTechs(
      suppressGenericFrontendLibDuplicates(suppressGenericCdnFallbacks(mergeDisplayTechnologyRecords(all))),
      pageUrl,
      suppressMap
    ),
    settings
  )
}

const buildPopupResult = async (data: any, settings: any, tab: any) => {
  const suppressMap = collectSuppressMap(await loadTechRules())
  const pageUrl = getCurrentPageUrl(data, tab)
  const technologies = await attachTechnologyLinks(buildDisplayTechnologies(data, settings, suppressMap, pageUrl), settings)
  const resources = mergeResourceSummary(data.page?.resources || {}, data.dynamic || {})
  const main = data.main || {}
  const headerCount =
    typeof main.headerCount === 'number' && main.headerCount >= 0 ? main.headerCount : Object.keys(main.headers || {}).length
  return {
    url: pageUrl,
    title: data.page?.title || data.dynamic?.title || tab?.title || '',
    generatedAt: new Date().toISOString(),
    updatedAt: getStoredUpdatedAt(data),
    technologies: technologies.map(cleanPopupTechnology),
    counts: buildTechnologyCounts(technologies),
    categoryCounts: buildCategoryCounts(technologies),
    resources: { total: resources.total || 0 },
    headerCount
  }
}

export const buildPopupRawResult = async (data: any, settings: any, tab: any) => {
  const suppressMap = collectSuppressMap(await loadTechRules())
  const pageUrl = getCurrentPageUrl(data, tab)
  const technologies = await attachTechnologyLinks(buildDisplayTechnologies(data, settings, suppressMap, pageUrl), settings)
  const resources = mergeResourceSummary(data.page?.resources || {}, data.dynamic || {})
  const headers = data.main?.allHeaders || data.main?.headers || {}
  return {
    url: pageUrl,
    title: data.page?.title || data.dynamic?.title || tab?.title || '',
    generatedAt: new Date().toISOString(),
    technologies,
    resources,
    headers,
    apiObservations: data.apis || [],
    frameObservations: data.frames || [],
    bundleObservations: data.bundle || null,
    dynamicObservations: cleanRawDynamicObservation(data.dynamic, data, pageUrl),
    notes: [
      '前端框架和 UI 框架主要通过页面运行时、DOM、资源 URL 和样式类名判断。',
      'Web 服务器、CDN 和后端框架主要依赖响应头与 Cookie 命名线索；如果站点隐藏响应头，结果会保守显示。',
      '后台会异步扫描少量主 JS 文件的保留版权注释，用于补充打包进 index/main/vendor chunk 的第三方依赖线索。',
      '动态监控会累计页面交互后新增的脚本、样式、iframe、feed 链接和资源加载，再与当前扫描结果合并。'
    ]
  }
}

export const buildPopupCacheRecord = async (data: any, settings: any, tab: any) => {
  const hydrated = addStoredCustomHeaderRules(data || {}, settings)
  const sourceUpdatedAt = getStoredUpdatedAt(hydrated)
  return {
    ...(await buildPopupResult(hydrated, settings, tab)),
    cacheVersion: POPUP_CACHE_SCHEMA_VERSION,
    settingsKey: buildSettingsCacheKey(settings),
    hasCache: hasStoredDetection(hydrated),
    sourceUpdatedAt,
    builtAt: Date.now()
  }
}

export const getPopupResultResponse = async (tabId: number) => {
  const tab = await getTabSnapshot(tabId)
  const support = checkPageSupport(tab.url)
  if (!support.supported) {
    await clearTabSession(tabId)
    clearBadge(tabId)
    return {
      ok: true,
      data: buildEmptyPopupResult(tab),
      hasCache: false,
      stale: false,
      updatedAt: 0,
      unsupported: true,
      reason: support.reason
    }
  }

  const [storedPopup, settings] = await Promise.all([getPopupCache(tabId), loadDetectorSettings()])
  const cachedPopup = getCachedPopupResult(storedPopup, settings)
  if (cachedPopup) {
    return {
      ok: true,
      data: cachedPopup,
      hasCache: Boolean(cachedPopup.hasCache),
      stale: !cachedPopup.sourceUpdatedAt || Date.now() - cachedPopup.sourceUpdatedAt > POPUP_CACHE_STALE_MS,
      updatedAt: cachedPopup.sourceUpdatedAt || 0
    }
  }

  const data = await getTabData(tabId)
  const popup = await buildPopupCacheRecord(data, settings, tab)
  if (hasStoredDetection(data)) {
    const { popup: legacyPopup, ...tabData } = data || {}
    const nextStorage: Record<string, unknown> = { [popupStorageKey(tabId)]: popup }
    if (legacyPopup) {
      nextStorage[storageKey(tabId)] = tabData
    }
    compatStorage.session.set(nextStorage).catch(() => {})
  }

  const updatedAt = getStoredUpdatedAt(data)
  return {
    ok: true,
    data: popup,
    hasCache: hasStoredDetection(data),
    stale: !updatedAt || Date.now() - updatedAt > POPUP_CACHE_STALE_MS,
    updatedAt
  }
}

const cleanResourceDomains = (value: any): any[] => {
  if (!Array.isArray(value)) return []
  return value
    .map(item => ({
      domain: String(item?.domain || '').slice(0, 200),
      count: Number(item?.count || 0)
    }))
    .filter(item => item.domain)
    .slice(0, 40)
}

const cleanStringList = (value: any, max: number): string[] => {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => String(item || '').slice(0, 1000)).filter(Boolean))].slice(-max)
}

const cleanPageResources = (resources: any) => ({
  total: Number(resources?.total || 0),
  scripts: cleanStringList(resources?.scripts, 160),
  stylesheets: cleanStringList(resources?.stylesheets, 160),
  resourceTiming: cleanStringList(resources?.resourceTiming, 220),
  all: cleanStringList(resources?.all, 300),
  themeAssetUrls: cleanStringList(resources?.themeAssetUrls, 100),
  resourceDomains: cleanResourceDomains(resources?.resourceDomains),
  cssVariableCount: Number(resources?.cssVariableCount || 0),
  metaGenerator: String(resources?.metaGenerator || '').slice(0, 200),
  manifest: String(resources?.manifest || '').slice(0, 1000) || null
})

export const cleanTechnologyRecords = (items: any) => {
  if (!Array.isArray(items)) return []
  return items
    .map(item => {
      const out: any = {
        category: String(item?.category || '其他库').slice(0, 80),
        name: String(item?.name || '').slice(0, 160),
        confidence: ['高', '中', '低'].includes(item?.confidence) ? item.confidence : '中',
        evidence: cleanStringArray(item?.evidence).slice(0, 12),
        source: String(item?.source || '页面扫描').slice(0, 80),
        url: cleanTechnologyUrl(item?.url)
      }
      if (item?.version && typeof item.version === 'string') {
        out.version = String(item.version).slice(0, 32)
      }
      return out
    })
    .filter(item => item.name)
    .slice(0, 400)
}

export const cleanPageDetectionRecord = (page: any) => ({
  url: String(page?.url || '').slice(0, 1000),
  title: String(page?.title || '').slice(0, 300),
  time: Date.now(),
  technologies: cleanTechnologyRecords(page?.technologies),
  resources: cleanPageResources(page?.resources)
})

// 同一 URL 下 page detection 多次重跑（SPA 异步渲染、tab 复用、用户在页面停留期间触发再扫描）时
// 合并技术列表 + 资源 URL,而不是直接整段替换；可以避免新一轮抓得少导致 popup 上检测项闪烁式回落
export const mergePageDetectionRecord = (previous: any, fresh: any) => {
  if (!fresh) return previous || null
  if (!previous || !previous.url || previous.url !== fresh.url) return fresh
  const previousTechs = Array.isArray(previous.technologies) ? previous.technologies : []
  const freshTechs = Array.isArray(fresh.technologies) ? fresh.technologies : []
  const previousResources = previous.resources || {}
  const freshResources = fresh.resources || {}
  const mergeUrlList = (a: any, b: any, limit: number) => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const value of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
      const url = typeof value === 'string' ? value : ''
      if (!url || seen.has(url)) continue
      seen.add(url)
      out.push(url)
      if (out.length >= limit) break
    }
    return out
  }
  return {
    ...fresh,
    technologies: mergeTechnologyRecords([...previousTechs, ...freshTechs]),
    resources: {
      ...previousResources,
      ...freshResources,
      scripts: mergeUrlList(previousResources.scripts, freshResources.scripts, 200),
      stylesheets: mergeUrlList(previousResources.stylesheets, freshResources.stylesheets, 200),
      resourceTiming: mergeUrlList(previousResources.resourceTiming, freshResources.resourceTiming, 400),
      all: mergeUrlList(previousResources.all, freshResources.all, 400),
      themeAssetUrls: mergeUrlList(previousResources.themeAssetUrls, freshResources.themeAssetUrls, 120)
    }
  }
}
