import { mergeTechnologyRecords, cleanWordPressThemeSlug, shortHeaderUrl } from './merge'
import { cleanTechnologyUrl, normalizeHttpUrl } from '@/utils/url'
import { createResourceAttribution } from '@/utils/resource-attribution'

const themeStyleFetchCache = new Map<string, { expiresAt: number; value: string }>()

const cleanWordPressThemeHeaderValue = (value: unknown) =>
  String(value || '')
    .replace(/[ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)

const isLikelyWordPressThemeStyleContentType = (contentType: string) => {
  if (!contentType) return true
  return /(?:text\/css|text\/plain|application\/octet-stream|charset=)/i.test(contentType)
}

const rememberThemeStyleFetch = (styleUrl: string, value: string) => {
  themeStyleFetchCache.set(styleUrl, {
    expiresAt: Date.now() + 10 * 60 * 1000,
    value
  })
  if (themeStyleFetchCache.size > 120) {
    const firstKey = themeStyleFetchCache.keys().next().value
    if (firstKey !== undefined) themeStyleFetchCache.delete(firstKey)
  }
}

const readResponseTextWithLimit = async (response: Response, maxBytes: number) => {
  if (!response.body?.getReader) {
    return (await response.text()).slice(0, maxBytes)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''

  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.cancel().catch(() => {})
  }

  return text.slice(0, maxBytes)
}

const fetchWordPressThemeStyle = async (styleUrl: string) => {
  const cached = themeStyleFetchCache.get(styleUrl)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  let value = ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3500)
  try {
    const response = await fetch(styleUrl, {
      cache: 'force-cache',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal
    })
    const contentType = response.headers.get('content-type') || ''
    if (response.ok && isLikelyWordPressThemeStyleContentType(contentType)) {
      value = await readResponseTextWithLimit(response, 65536)
    }
  } catch {
    value = ''
  } finally {
    clearTimeout(timer)
  }

  rememberThemeStyleFetch(styleUrl, value)
  return value
}

const parseWordPressThemeHeader = (cssText: string) => {
  const sample = String(cssText || '').slice(0, 32768)
  if (!sample) return null

  const comment = sample.match(/\/\*[\s\S]*?\*\//)?.[0] || sample.slice(0, 8192)
  const fields: Record<string, string> = {
    'theme name': 'themeName',
    'theme uri': 'themeUri',
    author: 'author',
    'author uri': 'authorUri',
    description: 'description',
    version: 'version',
    template: 'template',
    'text domain': 'textDomain',
    tags: 'tags',
    license: 'license',
    'license uri': 'licenseUri',
    'requires at least': 'requiresAtLeast',
    'requires php': 'requiresPhp'
  }
  const info: Record<string, string> = {}

  for (const rawLine of comment.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^\s*\/\*+/, '')
      .replace(/\*\/\s*$/, '')
      .replace(/^\s*\*\s?/, '')
      .trim()
    const match = line.match(/^([A-Za-z][A-Za-z ]{1,40})\s*:\s*(.+)$/)
    if (!match) continue
    const key = fields[match[1].trim().toLowerCase()]
    if (!key || info[key]) continue
    const value = cleanWordPressThemeHeaderValue(match[2])
    if (value) info[key] = value
  }

  return info.themeName ? info : null
}

const buildWordPressThemeTechnology = (info: any, request: any) => {
  const evidence = [
    `WordPress style.css 主题头：Theme Name: ${info.themeName}${info.version ? `，Version: ${info.version}` : ''}，目录: ${request.slug}`,
    `样式表：${shortHeaderUrl(request.styleUrl)}`
  ]
  if (info.themeUri) evidence.push(`Theme URI: ${info.themeUri}`)
  if (info.author) evidence.push(`Author: ${info.author}`)
  if (info.template) evidence.push(`Template: ${info.template}`)
  if (info.textDomain) evidence.push(`Text Domain: ${info.textDomain}`)

  return {
    category: '主题 / 模板',
    name: `WordPress 主题: ${info.themeName}`.slice(0, 160),
    confidence: '高',
    evidence,
    source: '主题样式表',
    url: cleanTechnologyUrl(info.themeUri) || cleanTechnologyUrl(info.authorUri),
    themeSlug: request.slug
  }
}

const extractWordPressThemeStyleRequest = (rawUrl: string, baseUrl: string) => {
  const absoluteUrl = normalizeHttpUrl(rawUrl, baseUrl)
  if (!absoluteUrl) return null

  let parsed: URL
  try {
    parsed = new URL(absoluteUrl)
  } catch {
    return null
  }

  const match = parsed.pathname.match(/\/wp-content\/themes\/([^/?#"' <>]+)(?:\/|$)/i)
  if (!match) return null

  const slug = cleanWordPressThemeSlug(match[1])
  if (!slug) return null

  const prefix = parsed.pathname.slice(0, match.index)
  const styleUrl = new URL(`${prefix}/wp-content/themes/${match[1]}/style.css`, parsed.origin)
  return { slug, styleUrl: styleUrl.toString() }
}

const collectWordPressThemeStyleRequests = (page: any) => {
  const baseUrl = String(page?.url || '')
  const resources = page?.resources || {}
  const executedUrls = [resources.scripts, resources.stylesheets, page?.scripts, page?.stylesheets]
    .flatMap(values => (Array.isArray(values) ? values : []))
    .filter((value): value is string => typeof value === 'string')
  // 外站被动资源（友链头像之类）路径里的主题目录属于那个外站，不去拉它的 style.css
  const attribution = createResourceAttribution(baseUrl, executedUrls)
  const rawUrls: string[] = []
  const addUrl = (value: unknown) => {
    const own = typeof value === 'string' && value.trim() ? attribution.ownPart(value) : ''
    if (own) {
      rawUrls.push(own)
    }
  }
  const addList = (values: unknown) => {
    if (Array.isArray(values)) values.forEach(addUrl)
  }
  const addTrustedList = (values: unknown) => {
    if (!Array.isArray(values)) return
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) rawUrls.push(value)
    }
  }

  addUrl(baseUrl)
  for (const key of [
    'scripts',
    'stylesheets',
    'themeAssetUrls',
    'dynamicResources',
    'resourceTiming',
    'images',
    'all',
    'resources',
    'iframes'
  ]) {
    // themeAssetUrls 是页面检测已按归属筛过的本站资源（含按预加载、脚本 chunk 认定的可信主机），不再筛一遍
    if (key === 'themeAssetUrls') addTrustedList(resources[key])
    else addList(resources[key])
  }
  for (const key of ['scripts', 'stylesheets', 'resources', 'iframes']) {
    addList(page?.[key])
  }

  const byStyleUrl = new Map()
  for (const rawUrl of rawUrls) {
    const request = extractWordPressThemeStyleRequest(rawUrl, baseUrl)
    if (request && !byStyleUrl.has(request.styleUrl)) {
      byStyleUrl.set(request.styleUrl, request)
    }
  }
  return [...byStyleUrl.values()]
}

export const detectWordPressThemeStylesFromPage = async (page: any) => {
  const requests = collectWordPressThemeStyleRequests(page).slice(0, 5)
  if (!requests.length) return []

  const results = await Promise.allSettled(
    requests.map(async request => {
      const cssText = await fetchWordPressThemeStyle(request.styleUrl)
      const info = parseWordPressThemeHeader(cssText)
      return info ? buildWordPressThemeTechnology(info, request) : null
    })
  )

  return results.filter((result: any) => result.status === 'fulfilled' && result.value).map((result: any) => result.value)
}

export const augmentPageWithWordPressThemeStyles = async (page: any) => {
  const technologies = await detectWordPressThemeStylesFromPage(page)
  if (!technologies.length) {
    return page
  }
  return {
    ...page,
    technologies: mergeTechnologyRecords([...(page?.technologies || []), ...technologies])
  }
}
