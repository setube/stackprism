import type { PopupRawResult } from '@/types/popup'
import type { TechnologyRecord } from '@/types/rules'
import { cleanStringArray } from '@/utils/normalize-settings'
import {
  cleanInlineText,
  isRecord,
  redactText,
  redactUrl,
  sanitizeList,
  sanitizeRecord,
  sanitizeUrlList,
  sanitizeValue
} from '@/utils/site-experience-redaction'

export const sanitizeTechnology = (technology: TechnologyRecord): TechnologyRecord => ({
  category: cleanInlineText(technology.category) || '其他库',
  name: cleanInlineText(technology.name),
  kind: cleanInlineText(technology.kind) || undefined,
  confidence:
    technology.confidence === '高' || technology.confidence === '中' || technology.confidence === '低' ? technology.confidence : '中',
  evidence: sanitizeList(technology.evidence).slice(0, 8),
  sources: sanitizeList(technology.sources || (technology.source ? [technology.source] : [])).slice(0, 8),
  url: redactUrl(technology.url) || undefined,
  version: cleanInlineText(technology.version) || undefined
})

const buildConfidenceSummary = (technologies: TechnologyRecord[]) => ({
  high: technologies.filter(item => item.confidence === '高').length,
  medium: technologies.filter(item => item.confidence === '中').length,
  low: technologies.filter(item => item.confidence === '低').length
})

const pickPrimaryFrontend = (technologies: TechnologyRecord[]) =>
  technologies.find(
    tech => /前端框架|ui \/ css 框架|前端库/i.test(tech.category) || /^(react|vue|svelte|angular|next\.js|nuxt|solid)/i.test(tech.name)
  )

const pickNamedTechnology = (technologies: TechnologyRecord[], pattern: RegExp) =>
  technologies.find(tech => pattern.test(`${tech.category} ${tech.name}`))

export const buildTechProfile = (technologies: TechnologyRecord[]) => {
  const primaryFrontend = pickPrimaryFrontend(technologies)
  const uiFramework = pickNamedTechnology(technologies, /UI \/ CSS 框架|Tailwind|Bootstrap|Ant Design|Element Plus/i)
  const buildRuntime = pickNamedTechnology(technologies, /构建与运行时|Vite|Webpack|Rollup|esbuild|Node/i)
  const cmsOrSiteProgram = pickNamedTechnology(technologies, /网站程序|CMS|电商平台|WordPress|Shopify|Drupal/i)
  const thirdPartyServices = technologies.filter(tech => /第三方服务|CDN \/ 托管|统计|广告|支付/i.test(tech.category))
  return {
    technologies,
    primaryFrontend: primaryFrontend?.name || '',
    uiFramework: uiFramework?.name || '',
    buildRuntime: buildRuntime?.name || '',
    cmsOrSiteProgram: cmsOrSiteProgram?.name || '',
    serverHints: [],
    thirdPartyServices: thirdPartyServices.map(tech => tech.name),
    confidenceSummary: buildConfidenceSummary(technologies),
    implementationNotes: '技术栈用于复刻参考，不是必须照搬。'
  }
}

export const buildAssetProfile = (raw: PopupRawResult | null, experience: any, maxResourceUrls: number) => {
  const resources = raw?.resources
  const scripts = sanitizeUrlList(resources?.scripts)
  const stylesheets = sanitizeUrlList(resources?.stylesheets)
  const themeAssetUrls = sanitizeUrlList(resources?.themeAssetUrls)
  const manifest = redactUrl(resources?.manifest)
  const experienceAssetUrls = sanitizeUrlList(experience?.assets?.urls)
  const resourceUrls = [
    ...new Set([...scripts, ...stylesheets, ...themeAssetUrls, ...experienceAssetUrls, ...(manifest ? [manifest] : [])])
  ].slice(0, maxResourceUrls)
  return {
    scripts,
    stylesheets,
    resourceDomains: sanitizeValue(resources?.resourceDomains) || [],
    imageDomains: [],
    fontUrls: [],
    manifest,
    themeAssetUrls,
    favicon: '',
    cdnHints: [
      ...new Set(
        resourceUrls
          .map(url => {
            try {
              return new URL(url).hostname
            } catch {
              return ''
            }
          })
          .filter(Boolean)
      )
    ],
    resourceUrls,
    redactionPolicy: {
      hashDropped: true,
      sensitiveQueryValuesRedacted: true
    }
  }
}

const hasHeaderCoverage = (headers: unknown): boolean =>
  Array.isArray(headers) ? headers.length > 0 : isRecord(headers) ? Object.keys(headers).length > 0 : false

const buildSourceCoverage = (raw: PopupRawResult | null, experience: any) =>
  [
    hasHeaderCoverage(raw?.headers) ? 'headers' : '',
    raw?.technologies?.length ? 'page' : '',
    raw?.resources ? 'bundle' : '',
    experience ? 'visual' : '',
    experience?.interaction ? 'interaction' : ''
  ].filter(Boolean)

export const buildEvidence = (
  raw: PopupRawResult | null,
  technologies: TechnologyRecord[],
  assetProfile: { resourceUrls?: string[] },
  experience: any
) => {
  const truncation = experience?.evidence?.truncation || experience?.evidence?.omitted || {}
  const resourceUrls = assetProfile.resourceUrls || []
  return {
    highConfidence: technologies.filter(item => item.confidence === '高').map(item => item.name),
    mediumConfidence: technologies.filter(item => item.confidence === '中').map(item => item.name),
    lowConfidence: technologies.filter(item => item.confidence === '低').map(item => item.name),
    rawCounts: {
      technologies: technologies.length,
      resourceUrls: resourceUrls.length,
      textSamples: cleanStringArray(experience?.ux?.textSamples).length,
      componentSamples: Array.isArray(experience?.components?.samples) ? experience.components.samples.length : 0,
      cssRules: Number(truncation.cssRules || 0)
    },
    sourceCoverage: buildSourceCoverage(raw, experience),
    truncation: {
      resourceUrls: Number(truncation.resourceUrls || 0),
      textSamples: Number(truncation.textSamples || 0),
      componentSamples: Number(truncation.componentSamples || 0),
      cssRules: Number(truncation.cssRules || 0),
      executeScriptResult: Number(truncation.executeScriptResult || 0),
      executeScriptResultOverLimit: Number(truncation.executeScriptResultOverLimit || 0)
    }
  }
}

const stripScreenshotMetadata = (value: Record<string, unknown>, includeMetadata: boolean): Record<string, unknown> => {
  if (includeMetadata) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/abovefold|bounding|^(bounds|rect)$/i.test(key)) continue
    out[key] = item
  }
  return out
}

export const buildVisualProfile = (experience: any, includeMetadata: boolean): Record<string, unknown> => {
  const visual = experience?.visual || {}
  if (!isRecord(visual) || !Object.keys(visual).length) return {}
  const { colors, ...rest } = visual
  return {
    colorTokens: sanitizeList(colors),
    ...stripScreenshotMetadata(sanitizeRecord(rest), includeMetadata)
  }
}

export const buildLayoutProfile = (experience: any, includeMetadata: boolean): Record<string, unknown> => {
  const layout = experience?.layout || {}
  if (!isRecord(layout) || !Object.keys(layout).length) return {}
  return stripScreenshotMetadata(sanitizeRecord(layout), includeMetadata)
}

const stripComponentRects = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripComponentRects)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/^(rect|boundingBox|bounds)$/i.test(key)) continue
    out[key] = stripComponentRects(item)
  }
  return out
}

export const buildComponentProfile = (experience: any, includeMetadata: boolean): Record<string, unknown> => {
  const components = experience?.components || {}
  if (!isRecord(components) || !Object.keys(components).length) return {}
  const sanitized = sanitizeRecord(components)
  return includeMetadata ? sanitized : (stripComponentRects(sanitized) as Record<string, unknown>)
}

export const buildInteractionProfile = (experience: any): Record<string, unknown> => {
  const interaction = experience?.interaction || {}
  if (!isRecord(interaction) || !Object.keys(interaction).length) return {}
  return sanitizeRecord(interaction)
}

const redactTextList = (values: unknown, limit = Infinity): string[] =>
  cleanStringArray(values).map(redactText).filter(Boolean).slice(0, limit)

export const buildUxProfile = (experience: any): Record<string, unknown> => {
  const ux = experience?.ux || {}
  if (!isRecord(ux) || !Object.keys(ux).length) return {}
  return sanitizeRecord({
    pagePurpose: redactText(ux.pagePurpose),
    primaryUserPath: redactTextList(ux.primaryUserPath, 12),
    informationHierarchy: redactTextList(ux.informationHierarchy, 20),
    ctaStrategy: redactTextList(ux.ctaStrategy, 20),
    trustSignals: redactTextList(ux.trustSignals, 20),
    navigationDepth: redactText(ux.navigationDepth),
    contentGrouping: redactTextList(ux.contentGrouping, 24),
    frictionPoints: redactTextList(ux.frictionPoints, 12),
    textSamples: redactTextList(ux.textSamples, 80)
  })
}

export const buildTargetLanguage = (experience: any): string => {
  const documentLanguage = isRecord(experience?.document) ? experience.document.language : ''
  return cleanInlineText(documentLanguage || experience?.language || '')
}
