import { LIMITS, cleanText, safeUrl, uniquePush, type Truncation } from './experience-profiler-common'

export const collectBoundaries = () => {
  const iframes = [...document.querySelectorAll('iframe')]
  let sameOriginIframes = 0
  let crossOriginIframes = 0
  for (const iframe of iframes) {
    const url = safeUrl(iframe.getAttribute('src') || '')
    if (!url) continue
    if (new URL(url).origin === location.origin) sameOriginIframes += 1
    else crossOriginIframes += 1
  }
  return { sameOriginIframes, crossOriginIframes }
}

const collectTextSamples = (nodes: Element[], truncation: Truncation): string[] => {
  const samples: string[] = []
  for (const node of nodes) {
    const text = cleanText(node.textContent, 120)
    if (!text || text.length < 3) continue
    if (samples.length >= LIMITS.textSamples) {
      truncation.textSamples += 1
      continue
    }
    uniquePush(samples, text, LIMITS.textSamples)
  }
  return samples
}

const collectElementLabels = (selector: string, limit: number): string[] => {
  const labels: string[] = []
  for (const element of [...document.querySelectorAll(selector)]) {
    uniquePush(labels, element.getAttribute('aria-label') || element.textContent, limit)
    if (labels.length >= limit) break
  }
  return labels
}

const inferPagePurpose = (): string => {
  if (document.querySelector('main form, form[action], input, textarea, select')) return 'form_flow'
  if (document.querySelector('table, [role="table"], [class*="dashboard" i], [class*="chart" i]')) return 'data_display'
  if (document.querySelector('article, [class*="docs" i], [class*="blog" i]')) return 'content_or_docs'
  if (document.querySelector('[class*="pricing" i], [class*="hero" i], [id*="hero" i]')) return 'marketing'
  return 'unknown'
}

const inferFrictionPoints = (): string[] => {
  const points: string[] = []
  if (!document.querySelector('h1')) uniquePush(points, 'missing_h1', 8)
  if (document.querySelectorAll('form input[required], form textarea[required], form select[required]').length > 5)
    uniquePush(points, 'many_required_fields', 8)
  if (document.querySelectorAll('button, a, [role="button"]').length === 0) uniquePush(points, 'no_visible_actions', 8)
  return points
}

export const collectUxSignals = (nodes: Element[], truncation: Truncation) => {
  const navLinks = document.querySelectorAll('nav a, [role="navigation"] a').length
  const formControls = document.querySelectorAll('input, textarea, select').length
  return {
    pagePurpose: inferPagePurpose(),
    primaryUserPath: collectElementLabels('main button, main a, [role="main"] button, [role="main"] a', 12),
    informationHierarchy: collectElementLabels('h1, h2, h3, [role="heading"]', 20),
    ctaStrategy: collectElementLabels('button, a, [role="button"], input[type="submit"]', 20),
    trustSignals: collectElementLabels(
      '[class*="trust" i], [class*="testimonial" i], [class*="review" i], [class*="security" i], [class*="privacy" i], footer',
      20
    ),
    navigationDepth: `nav_links:${navLinks}; form_controls:${formControls}`,
    contentGrouping: collectElementLabels('section, article, aside, [class*="card" i], [class*="panel" i]', 24),
    frictionPoints: inferFrictionPoints(),
    textSamples: collectTextSamples(nodes, truncation)
  }
}

export const collectAssets = (truncation: Truncation) => {
  const urls = [
    ...[...document.scripts].map(item => item.src),
    ...[...document.querySelectorAll('link[href]')].map(item => (item as HTMLLinkElement).href),
    ...[...document.images].map(item => item.currentSrc || item.src),
    ...performance.getEntriesByType('resource').map(item => item.name)
  ]
    .map(safeUrl)
    .filter(Boolean)
  const unique = [...new Set(urls)]
  truncation.resourceUrls = Math.max(0, unique.length - LIMITS.resourceUrls)
  return { urls: unique.slice(0, LIMITS.resourceUrls) }
}
