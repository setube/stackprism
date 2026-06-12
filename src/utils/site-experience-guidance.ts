import { redactText, sanitizeRecord } from '@/utils/site-experience-redaction'

interface GuidanceSections {
  visualProfile?: Record<string, unknown>
  layoutProfile?: Record<string, unknown>
  componentProfile?: Record<string, unknown>
  interactionProfile?: Record<string, unknown>
  uxProfile?: Record<string, unknown>
  assetProfile?: Record<string, unknown>
  evidence?: Record<string, unknown>
  browserContext?: Record<string, unknown>
}

const cleanGuidanceText = (value: unknown): string => {
  const text = redactText(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 100)
}

const toTextList = (value: unknown, limit: number): string[] => {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return [...new Set(values.map(cleanGuidanceText).filter(Boolean))].slice(0, limit)
}

const toRecord = (value: unknown): Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? sanitizeRecord(value) : {}
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const toCountRecord = (value: unknown): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const [key, item] of Object.entries(toRecord(value))) {
    const count = Number(item)
    if (Number.isFinite(count) && count > 0) counts[cleanGuidanceText(key)] = count
  }
  return counts
}

const toTopKeys = (counts: Record<string, number>, limit: number): string[] =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key)
    .slice(0, limit)

const valueCount = (value: unknown): number => (Array.isArray(value) ? value.length : 0)
const GEOMETRY_METADATA_KEYS = new Set(['rect', 'boundingbox', 'bounds'])
const screenshotSummary = (value: unknown) => {
  const screenshot = isPlainRecord(value) ? value : {}
  const hasDataUrl = typeof screenshot.dataUrl === 'string' && /^data:image\/jpeg;base64,/i.test(screenshot.dataUrl)
  const hasDownloadUrl = typeof screenshot.downloadUrl === 'string'
  return {
    screenshotIncluded: hasDataUrl || hasDownloadUrl,
    screenshotBase64Included: hasDataUrl,
    screenshotDownloadUrl: cleanGuidanceText(screenshot.downloadUrl),
    screenshotLocalPath: cleanGuidanceText(screenshot.localPath),
    screenshotDownloadHint:
      hasDataUrl || hasDownloadUrl
        ? 'To inspect actual visual appearance, download or open the screenshot image from visualProfile.screenshot.downloadUrl. The Profile JSON intentionally omits screenshot base64.'
        : 'No screenshot image is available in this capture. Review limitations before treating visual evidence as absent.',
    screenshotProfileJsonNote:
      'Profile JSON is standard JSON and cannot contain comments. Read this field as the instruction note for screenshot handling.',
    screenshotScope: cleanGuidanceText(screenshot.scope),
    screenshotMimeType: cleanGuidanceText(screenshot.mimeType),
    screenshotByteLength: Number.isFinite(Number(screenshot.byteLength)) ? Number(screenshot.byteLength) : 0
  }
}

const hasGeometryMetadata = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasGeometryMetadata)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, item]) => GEOMETRY_METADATA_KEYS.has(key.toLowerCase()) || hasGeometryMetadata(item))
}

const toDomainHints = (value: unknown, limit: number): string[] => {
  const values = Array.isArray(value) ? value : []
  return values
    .map(item => {
      const record = toRecord(item)
      if (Object.keys(record).length) {
        const domain = cleanGuidanceText(record.domain)
        const count = Number(record.count || 0)
        return domain && count > 0 ? `${domain}:${count}` : domain
      }
      return cleanGuidanceText(item)
    })
    .filter(Boolean)
    .slice(0, limit)
}

const buildRecreationPlan = (sections: GuidanceSections, limitations: string[]) => {
  const rawVisual = isPlainRecord(sections.visualProfile) ? sections.visualProfile : {}
  const { screenshot: rawScreenshot, ...visualWithoutScreenshot } = rawVisual
  const visual = toRecord(visualWithoutScreenshot)
  const layout = toRecord(sections.layoutProfile)
  const components = toRecord(sections.componentProfile)
  const interaction = toRecord(sections.interactionProfile)
  const ux = toRecord(sections.uxProfile)
  const assets = toRecord(sections.assetProfile)
  const evidence = toRecord(sections.evidence)
  const counts = toCountRecord(components.counts)
  const rawCounts = toRecord(evidence.rawCounts)

  return {
    objective: 'Recreate a similar website experience from browser-observed StackPrism evidence.',
    implementationOrder: [
      'Map high-confidence tech evidence to the destination project stack.',
      'Define design tokens from observed colors, typography, spacing, radii, and shadows.',
      'Build the page layout from landmarks, above-fold structure, and content grouping.',
      'Implement component variants in count-priority order.',
      'Add passive interaction states from transitions, animations, sticky elements, and focus or hover hints.',
      'Verify screenshots, DOM geometry, responsive fit, and interaction smoke tests against the profile limitations.'
    ],
    designTokens: {
      colors: toTextList(visual.colorTokens, 16),
      fontFamilies: toTextList(visual.fonts, 12),
      fontSizes: toTextList(visual.fontSizes, 12),
      lineHeights: toTextList(visual.lineHeights, 12),
      spacing: toTextList(visual.spacing, 16),
      radii: toTextList(visual.radii, 12),
      shadows: toTextList(visual.shadows, 12)
    },
    visualReference: screenshotSummary(rawScreenshot),
    layoutBlueprint: {
      landmarks: toTextList(layout.landmarks, 20),
      firstViewportSummary: toRecord(layout.aboveFold),
      contentGrouping: toTextList(ux.contentGrouping, 20),
      informationHierarchy: toTextList(ux.informationHierarchy, 20),
      viewportMode: cleanGuidanceText(sections.browserContext?.viewportMode) || 'unknown',
      responsiveNote: 'Requested viewports are capture context only unless viewportMode proves real resizing.'
    },
    componentInventory: {
      counts,
      priorityTypes: toTopKeys(counts, 8),
      sampleCount: valueCount(components.samples),
      geometryIncluded: hasGeometryMetadata(components)
    },
    interactionChecklist: {
      passiveOnly: interaction.passive !== false,
      transitions: toTextList(interaction.transitions, 12),
      animations: toTextList(interaction.animations, 12),
      stickyOrFixed: toTextList(interaction.stickyOrFixed, 12),
      focusHoverHints: toTextList(interaction.focusHoverHints, 12)
    },
    uxChecklist: {
      pagePurpose: cleanGuidanceText(ux.pagePurpose),
      primaryUserPath: toTextList(ux.primaryUserPath, 12),
      ctaStrategy: toTextList(ux.ctaStrategy, 12),
      trustSignals: toTextList(ux.trustSignals, 12),
      frictionPoints: toTextList(ux.frictionPoints, 12)
    },
    assetHints: {
      resourceDomains: toDomainHints(assets.resourceDomains, 16),
      cdnHints: toTextList(assets.cdnHints, 16),
      scriptCount: valueCount(assets.scripts),
      stylesheetCount: valueCount(assets.stylesheets),
      imageDomains: toTextList(assets.imageDomains, 16),
      fontUrls: toTextList(assets.fontUrls, 16),
      resourceUrlCount: Number(rawCounts.resourceUrls || 0)
    },
    verificationChecklist: [
      'Compare desktop screenshot composition and first-viewport hierarchy.',
      'Check key component geometry, density, and typography in the destination app.',
      'Smoke test hover, focus, sticky, loading, and scroll behavior without copying private data.',
      'Review limitations and truncation before treating any missing section as absent from the source site.'
    ],
    limitations: limitations.map(cleanGuidanceText).filter(Boolean)
  }
}

export const buildAgentGuidance = (techProfile: Record<string, unknown>, limitations: string[], sections: GuidanceSections = {}) => {
  const summaryParts = []
  const primaryFrontend = cleanGuidanceText(techProfile.primaryFrontend)
  if (primaryFrontend) {
    summaryParts.push(`优先复刻 ${primaryFrontend} 的前端体验。`)
  }
  summaryParts.push('优先复刻视觉层级、交互反馈、布局密度和信息结构。')
  const allSafeLimitations = limitations.map(cleanGuidanceText).filter(Boolean).slice(0, 20)
  const safeLimitations = allSafeLimitations.slice(0, 3)
  if (safeLimitations.length) summaryParts.push(`注意 limitations: ${safeLimitations.join('、')}`)
  return {
    summary: summaryParts.join(' '),
    priorities: ['布局密度', '视觉层级', '交互反馈', '信息结构'],
    cautions: ['高置信证据优先', '低置信候选仅作参考', '隐私字段已脱敏'],
    recreationPlan: buildRecreationPlan(sections, allSafeLimitations)
  }
}
