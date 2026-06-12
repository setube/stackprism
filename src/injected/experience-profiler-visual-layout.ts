import { LIMITS, cleanText, includeScreenshotMetadata, safeRect, uniquePush } from './experience-profiler-common'

export const collectVisual = (nodes: Element[]) => {
  const colors: string[] = []
  const fonts: string[] = []
  const fontSizes: string[] = []
  const lineHeights: string[] = []
  const spacing: string[] = []
  const radii: string[] = []
  const shadows: string[] = []

  for (const node of nodes.slice(0, LIMITS.styleNodes)) {
    try {
      const style = getComputedStyle(node)
      for (const prop of ['color', 'backgroundColor', 'borderColor']) {
        const value = style[prop as any]
        if (value && !/transparent|rgba\(0,\s*0,\s*0,\s*0\)/i.test(value)) uniquePush(colors, value, 60)
      }
      uniquePush(fonts, style.fontFamily, 30)
      uniquePush(fontSizes, style.fontSize, 30)
      uniquePush(lineHeights, style.lineHeight, 30)
      uniquePush(spacing, [style.margin, style.padding].filter(Boolean).join(' | '), 60)
      uniquePush(radii, style.borderRadius, 40)
      if (style.boxShadow && style.boxShadow !== 'none') uniquePush(shadows, style.boxShadow, 40)
    } catch {}
  }

  return { colors, fonts, fontSizes, lineHeights, spacing, radii, shadows }
}

export const collectLayout = (nodes: Element[]) => {
  const includeMetadata = includeScreenshotMetadata()
  const landmarks = [
    'header',
    'nav',
    'main',
    'footer',
    'aside',
    '[role="banner"]',
    '[role="navigation"]',
    '[role="main"]',
    '[role="contentinfo"]'
  ]
    .filter(selector => document.querySelector(selector))
    .map(selector => selector.replace(/\[role="(.+)"\]/, 'role:$1'))
  const keySelectors = ['header', 'nav', 'main', 'footer', 'aside', 'section', 'article', '[class*="hero" i]', '[id*="hero" i]']
  const boundingBoxes = includeMetadata
    ? keySelectors
        .flatMap(selector => [...document.querySelectorAll(selector)].slice(0, 8).map(element => ({ selector, element })))
        .map(({ selector, element }) => ({ selector, text: cleanText(element.textContent, 80), rect: safeRect(element) }))
        .filter(item => item.rect)
        .slice(0, 40)
    : []
  const aboveFoldCount = includeMetadata
    ? nodes.filter(node => {
        const rect = safeRect(node)
        return rect && rect.y >= 0 && rect.y < window.innerHeight
      }).length
    : 0
  return {
    landmarks,
    ...(includeMetadata ? { boundingBoxes, aboveFold: { elementCount: aboveFoldCount, viewportHeight: window.innerHeight } } : {})
  }
}
