import { mergeTechnologyRecords } from './merge'
import { redactHeaderValue } from '@/utils/site-experience-redaction'
import {
  createCollector,
  filterCustomRulesForTarget,
  getCompiledRulePatterns,
  lower,
  matchesHeaderPatterns,
  passesRulePrefilter
} from './rule-matcher'

const MAX_API_RECORDS = 30

const normalizeHeaders = (responseHeaders: any[]) => {
  const map: Record<string, string> = {}
  for (const header of responseHeaders || []) {
    const name = (header.name || '').toLowerCase()
    if (!name) continue
    const value = header.value || ''
    if (map[name]) {
      map[name] += `, ${value}`
    } else {
      map[name] = value
    }
  }
  return map
}

const collectFetchResponseHeaders = (response: Response) => {
  const responseHeaders: Array<{ name: string; value: string }> = []
  response.headers.forEach((value, name) => responseHeaders.push({ name, value }))
  return responseHeaders
}

const pickHeaders = (headers: Record<string, string>, interestingNames: string[]) => {
  const picked: Record<string, string> = {}
  for (const name of interestingNames) {
    if (headers[name]) {
      picked[name] = redactHeaderValue(name, headers[name])
    }
  }
  return picked
}

const applyHeaderRuleList = (
  add: any,
  rules: any[],
  defaultCategory: string,
  headerBlob: string,
  sourceLabel: string,
  evidencePrefix: (rule: any) => string = () => '',
  prefilterBlob: string = lower(headerBlob)
) => {
  if (!Array.isArray(rules) || !rules.length) return

  for (const rule of rules) {
    if (!passesRulePrefilter(rule, prefilterBlob)) continue
    const matched = getCompiledRulePatterns(rule, rule.patterns).some(pattern => {
      pattern.lastIndex = 0
      return pattern.test(headerBlob)
    })
    if (matched) {
      const evidence = rule.evidence || `${sourceLabel} 匹配`
      const extras = rule.url ? { url: rule.url } : undefined
      add(rule.category || defaultCategory, rule.name, rule.confidence || '中', `${evidencePrefix(rule)}${evidence}`, extras)
    }
  }
}

const applyHeaderValueRuleList = (add: any, rules: any[], value: string, rawValue: string, headerName: string) => {
  if (!value || !Array.isArray(rules) || !rules.length) return

  // Server / X-Powered-By 字段正常只对应一个产品；带逗号往往是反代叠加或伪造
  // 只匹配第一段，避免被「openresty, Microsoft-IIS/10.0」这种伪造糊弄
  const isSplitField = headerName === 'server' || headerName === 'x-powered-by'
  const primaryValue = isSplitField ? value.split(',')[0].trim() : value
  if (!primaryValue) return
  // evidence 也只显示首段，避免用户看到「server: openresty, Microsoft-IIS/10.0」误以为 IIS 也被采信
  const displayValue = isSplitField ? (rawValue?.split(',')[0]?.trim() ?? rawValue) : rawValue

  for (const rule of rules) {
    if (!matchesHeaderPatterns(rule.patterns, primaryValue, rule)) continue
    const evidence = rule.evidence || `${headerName}: ${displayValue}`
    const extras = rule.url ? { url: rule.url } : undefined
    add(rule.category || '其他库', rule.name, rule.confidence || '高', evidence, extras)
    if (isSplitField) break // 这两个字段正常只标识一种产品
  }
}

// 主体身份响应头：每一项理论上只对应一种栈，集齐很多个不同身份就是被伪造的强信号
const SPOOF_INDICATOR_HEADERS = [
  'server',
  'x-powered-by',
  'x-aspnet-version',
  'x-aspnetmvc-version',
  'x-drupal-cache',
  'x-drupal-dynamic-cache',
  'x-generator',
  'x-powered-cms',
  'x-varnish',
  'x-rails-version',
  'x-runtime',
  'x-php-version',
  'x-jenkins',
  'x-cocoon-version'
]

// Web 服务器 通过 server 首段判断（已隔离逗号后伪造段），不参与降级
// 开发语言 / 运行时 大量来自 server 首段（如 Lua / OpenResty 命中 server:openresty），同样不降级
const SPOOF_PRONE_CATEGORIES = new Set(['网站程序', '后端 / 服务器框架', 'CMS / 电商平台'])

const countSpoofIndicators = (headers: Record<string, string>): number => {
  let count = 0
  for (const name of SPOOF_INDICATOR_HEADERS) {
    const value = headers[name]
    if (typeof value === 'string' && value.trim()) count += 1
  }
  return count
}

const SPOOF_NOTICE = '响应头里同时出现多种不同主体身份字段，识别结果可能被伪造'

const markSpoofedHeaderDetections = (technologies: any[], headers: Record<string, string>): void => {
  const indicatorCount = countSpoofIndicators(headers)
  // server 自身就带多个产品 / 出现 4+ 个不同身份字段：视为伪造
  const serverHasMultiple = typeof headers.server === 'string' && headers.server.includes(',')
  if (indicatorCount < 4 && !serverHasMultiple) return
  for (const tech of technologies) {
    if (!SPOOF_PRONE_CATEGORIES.has(tech.category)) continue
    tech.confidence = '低'
    const evidence: string[] = Array.isArray(tech.evidence) ? tech.evidence : tech.evidence ? [tech.evidence] : []
    if (!evidence.some((line: string) => typeof line === 'string' && line.includes(SPOOF_NOTICE))) {
      tech.evidence = [SPOOF_NOTICE, ...evidence]
    }
  }
}

// 这些 header 是「允许列表」性质（CSP 列出可加载的源、Report-To 列出错误上报通道等），
// 内容是一长串第三方域名 / 类型字面量，不代表站点实际在用这些技术；扫描时跳过它们能避免误报
const ALLOWLIST_STYLE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'report-to',
  'reporting-endpoints',
  'permissions-policy',
  'feature-policy',
  'expect-ct',
  'nel'
])

// 从 server: nginx/1.29.8 / x-powered-by: PHP/8.2.10 这种带斜杠 + 版本号的字段抽版本号
const extractServerVersion = (value: string): string => {
  const match = /\/(\d+(?:\.\d+){1,3})/.exec(String(value || ''))
  return match ? match[1] : ''
}

// 把版本号附到 Source 命中本响应头的那条 tech 上(让 popup 显示 "Nginx 1.29.8")
// 只从首段(逗号前)抽,避免「Server: nginx, Microsoft-IIS/10.0」把 IIS 的 10.0 错挂给 nginx
const attachServerVersion = (techs: any[], rawHeaderValue: string, headerName: 'server' | 'x-powered-by') => {
  if (!rawHeaderValue) return
  const primarySegment = String(rawHeaderValue).split(',')[0]?.trim() || ''
  if (!primarySegment) return
  const version = extractServerVersion(primarySegment)
  if (!version) return
  const prefix = headerName + ':'
  for (const tech of techs) {
    if (tech.version) continue
    const evidence = Array.isArray(tech.evidence) ? tech.evidence : []
    if (
      evidence.some((e: string) =>
        String(e || '')
          .toLowerCase()
          .startsWith(prefix)
      )
    ) {
      tech.version = version
    }
  }
}

const detectFromHeaders = (headers: Record<string, string>, url: string, headerRules: any = {}, settings: any = {}) => {
  const technologies: any[] = []
  const add = createCollector(technologies, '响应头')
  const server = lower(headers.server)
  const poweredBy = lower(headers['x-powered-by'])
  const headerBlob =
    Object.entries(headers)
      .filter(([name]) => !ALLOWLIST_STYLE_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n') + `\nurl: ${url || ''}`
  const lowerHeaderBlob = lower(headerBlob)

  applyHeaderValueRuleList(add, headerRules.serverProducts, server, headers.server, 'server')
  applyHeaderValueRuleList(add, headerRules.poweredByProducts, poweredBy, headers['x-powered-by'], 'x-powered-by')
  // server: nginx/1.29.8 / x-powered-by: PHP/8.2.10 这种带版本号的,把版本附到对应 tech 上
  attachServerVersion(technologies, headers.server, 'server')
  attachServerVersion(technologies, headers['x-powered-by'], 'x-powered-by')
  applyHeaderRuleList(add, headerRules.headerPatterns, '其他库', headerBlob, 'JSON 响应头规则', () => '', lowerHeaderBlob)

  if (
    matchesHeaderPatterns(headerRules.unknownCdnPatterns, lowerHeaderBlob) &&
    !technologies.some(tech => tech.category === 'CDN / 托管')
  ) {
    add('CDN / 托管', '未知 / 自定义 CDN', '低', '响应头包含 CDN 或 Edge 缓存线索')
  }

  applyHeaderRuleList(add, headerRules.cdnProviders, 'CDN / 托管', headerBlob, 'JSON CDN 响应头规则', () => '', lowerHeaderBlob)
  applyHeaderRuleList(add, headerRules.languages, '开发语言 / 运行时', headerBlob, 'JSON 语言响应头规则', () => '', lowerHeaderBlob)
  applyHeaderRuleList(
    add,
    headerRules.websitePrograms,
    '网站程序',
    headerBlob,
    'JSON 网站程序响应头规则',
    rule => (rule.kind ? `${rule.kind}：` : ''),
    lowerHeaderBlob
  )
  applyHeaderRuleList(
    add,
    filterCustomRulesForTarget(settings.customRules, 'headers'),
    '其他库',
    headerBlob,
    '自定义响应头规则',
    rule => (rule.kind ? `${rule.kind}：` : ''),
    lowerHeaderBlob
  )

  markSpoofedHeaderDetections(technologies, headers)

  return technologies
}

export const fetchMainHeadersFallback = async (url: string, headerRules: any, settings: any) => {
  if (!url || !/^https?:/i.test(url)) return null
  try {
    let method = 'HEAD'
    let response = await fetch(url, { method, credentials: 'include', cache: 'no-store', redirect: 'follow' })
    let responseHeaders = collectFetchResponseHeaders(response)
    if ((!response.ok && response.status !== 0) || responseHeaders.length <= 1) {
      method = 'GET'
      response = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'follow' })
      responseHeaders = collectFetchResponseHeaders(response)
    }
    if (!responseHeaders.length) return null
    return buildHeaderRecord(
      {
        url: response.url || url,
        type: 'main_frame',
        method,
        statusCode: response.status,
        responseHeaders
      },
      headerRules,
      settings
    )
  } catch {
    return null
  }
}

const sanitizeAllHeaders = (headers: Record<string, string>) => {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = redactHeaderValue(name, value)
  }
  return out
}

// 从 webRequest 的 statusLine 拿协议版本 — "HTTP/2 200" / "HTTP/3 200" 这种
// 比 PerformanceResourceTiming.nextHopProtocol 可靠：不需要 Timing-Allow-Origin，请求时刻就拿到
const extractHttpProtocol = (statusLine: unknown): string => {
  const match = /^HTTP\/([0-9.]+)/i.exec(String(statusLine || ''))
  return match ? match[1].toLowerCase() : ''
}

export const buildHeaderRecord = (details: any, headerRules: any, settings: any) => {
  const normalizedHeaders = normalizeHeaders(details.responseHeaders)
  const headers = pickHeaders(normalizedHeaders, headerRules.interestingHeaders || [])
  return {
    requestId: details.requestId || '',
    url: details.url,
    type: details.type,
    method: details.method,
    statusCode: details.statusCode,
    httpProtocol: extractHttpProtocol(details.statusLine),
    time: Date.now(),
    headers,
    allHeaders: sanitizeAllHeaders(normalizedHeaders),
    headerCount: Object.keys(normalizedHeaders).length,
    technologies: detectFromHeaders(normalizedHeaders, details.url, headerRules, settings)
  }
}

const normalizeRecordUrl = (value: unknown): string => {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

export const shouldMergeHeaderRecords = (previous: any, next: any): boolean => {
  if (!previous || !next) return false
  if (previous.requestId && next.requestId && previous.requestId === next.requestId) return true
  const previousUrl = normalizeRecordUrl(previous.url)
  const nextUrl = normalizeRecordUrl(next.url)
  return Boolean(previousUrl && nextUrl && previousUrl === nextUrl)
}

export const mergeHeaderRecords = (previous: any, next: any) => {
  if (!previous) return next
  if (!next) return previous
  return {
    ...previous,
    ...next,
    headers: {
      ...(previous.headers || {}),
      ...(next.headers || {})
    },
    allHeaders: {
      ...(previous.allHeaders || {}),
      ...(next.allHeaders || {})
    },
    headerCount: Math.max(Number(previous.headerCount || 0), Number(next.headerCount || 0)),
    technologies: mergeTechnologyRecords([...(previous.technologies || []), ...(next.technologies || [])])
  }
}

const detectCustomHeaderRules = (record: any, customRules: any[]) => {
  const technologies: any[] = []
  const add = createCollector(technologies, '响应头')
  const headerBlob = lower(
    Object.entries(record.headers || {})
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n') + `\nurl: ${record.url || ''}`
  )
  applyHeaderRuleList(add, customRules, '其他库', headerBlob, '自定义响应头规则', rule => (rule.kind ? `${rule.kind}：` : ''))
  return technologies
}

const addCustomRulesToHeaderRecord = (record: any, customRules: any[]) => {
  if (!record?.headers) return record
  const technologies = detectCustomHeaderRules(record, customRules)
  if (!technologies.length) return record
  return {
    ...record,
    technologies: mergeTechnologyRecords([...(record.technologies || []), ...technologies])
  }
}

export const addStoredCustomHeaderRules = (data: any, settings: any) => {
  const customRules = filterCustomRulesForTarget(settings?.customRules, 'headers')
  if (!customRules.length) return data

  return {
    ...data,
    main: addCustomRulesToHeaderRecord(data.main, customRules),
    apis: (data.apis || []).map((record: any) => addCustomRulesToHeaderRecord(record, customRules)),
    frames: (data.frames || []).map((record: any) => addCustomRulesToHeaderRecord(record, customRules))
  }
}

export const dedupeApiRecords = (records: any[]) => {
  const seen = new Set<string>()
  const kept: any[] = []
  for (const record of records) {
    let key: string
    try {
      const url = new URL(record.url)
      key = `${url.origin}${url.pathname}`
    } catch {
      key = record.url
    }
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(record)
    if (kept.length >= MAX_API_RECORDS) break
  }
  return kept
}
