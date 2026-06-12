import { LIMITS, cleanText, includeScreenshotMetadata, safeRect, uniquePush } from './experience-profiler-common'

export const collectComponents = () => {
  const includeMetadata = includeScreenshotMetadata()
  const definitions = [
    ['button', 'button, [role="button"]'],
    ['input', 'input, textarea, select'],
    ['card', '[class*="card" i], article'],
    ['nav', 'nav, [role="navigation"]'],
    ['tab', '[role="tab"], [class*="tab" i]'],
    ['modal', '[role="dialog"], [class*="modal" i]'],
    ['table', 'table, [role="table"]'],
    ['list', 'ul, ol, [role="list"]'],
    ['badge', '[class*="badge" i], [class*="tag" i], [class*="pill" i]']
  ] as const
  const samples: Array<Record<string, unknown>> = []
  const counts: Record<string, number> = {}
  for (const [type, selector] of definitions) {
    const matches = [...document.querySelectorAll(selector)]
    counts[type] = matches.length
    for (const element of matches.slice(0, 20)) {
      if (samples.length >= LIMITS.componentSamples) break
      samples.push({
        type,
        tag: element.tagName.toLowerCase(),
        text: cleanText(element.textContent, 80),
        ...(includeMetadata ? { rect: safeRect(element) } : {})
      })
    }
  }
  return { samples, counts, omitted: Math.max(0, Object.values(counts).reduce((sum, count) => sum + count, 0) - samples.length) }
}

export const collectCssSignals = () => {
  let inaccessibleStylesheets = 0
  let scannedRules = 0
  let totalRules = 0
  const hoverOrFocusRules: string[] = []
  for (const sheet of [...document.styleSheets]) {
    try {
      const rules = [...(sheet.cssRules || [])]
      totalRules += rules.length
      for (const rule of rules) {
        if (scannedRules >= LIMITS.cssRules) break
        scannedRules += 1
        const text = 'cssText' in rule ? String(rule.cssText) : ''
        if (/:hover|:focus|:focus-visible/i.test(text)) uniquePush(hoverOrFocusRules, text, 40)
      }
    } catch {
      inaccessibleStylesheets += 1
    }
  }
  return { inaccessibleStylesheets, scannedRules, hoverOrFocusRules, omittedCssRules: Math.max(0, totalRules - scannedRules) }
}

export const collectInteraction = (nodes: Element[], cssSignals: ReturnType<typeof collectCssSignals>) => {
  const transitions: string[] = []
  const animations: string[] = []
  const stickyOrFixed: string[] = []
  for (const node of nodes.slice(0, LIMITS.styleNodes)) {
    try {
      const style = getComputedStyle(node)
      if (style.transitionDuration && style.transitionDuration !== '0s')
        uniquePush(transitions, `${style.transitionProperty} ${style.transitionDuration}`, 50)
      if (style.animationName && style.animationName !== 'none')
        uniquePush(animations, `${style.animationName} ${style.animationDuration}`, 50)
      if (style.position === 'sticky' || style.position === 'fixed')
        uniquePush(stickyOrFixed, `${node.tagName.toLowerCase()}:${style.position}`, 40)
    } catch {}
  }
  return {
    passive: true,
    transitions,
    animations,
    stickyOrFixed,
    focusHoverHints: cssSignals.hoverOrFocusRules,
    openShadowRoots: nodes.filter(node => Boolean((node as HTMLElement).shadowRoot)).length,
    closedShadowRoots: 0
  }
}
