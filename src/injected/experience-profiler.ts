import { LIMITS, cleanText, emptyTruncation, selectNodes } from './experience-profiler-common'
import { collectComponents, collectCssSignals, collectInteraction } from './experience-profiler-components'
import { collectBoundaries, collectAssets, collectUxSignals } from './experience-profiler-ux-assets'
import { collectLayout, collectVisual } from './experience-profiler-visual-layout'

const byteLengthOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

const unavailableProfile = () => ({
  visual: {},
  layout: {},
  components: { samples: [] },
  interaction: { passive: true },
  ux: { textSamples: [] },
  document: { language: '' },
  assets: { urls: [] },
  evidence: { truncation: emptyTruncation() },
  limitations: ['document_unavailable']
})

const enforceResultLimit = (profile: any) => {
  const initialBytes = byteLengthOf(profile)
  if (initialBytes <= LIMITS.executeScriptResultBytes) return profile
  const markTruncated = () => {
    if (!profile.limitations.includes('execute_script_result_truncated')) profile.limitations.push('execute_script_result_truncated')
  }
  const shrinkSteps = [
    () => {
      profile.components.samples = profile.components.samples.slice(0, 10)
    },
    () => {
      profile.ux.textSamples = profile.ux.textSamples.slice(0, 10)
    },
    () => {
      profile.assets.urls = profile.assets.urls.slice(0, 50)
    },
    () => {
      profile.components.samples = profile.components.samples.slice(0, 3)
      profile.ux.textSamples = profile.ux.textSamples.slice(0, 3)
      profile.assets.urls = profile.assets.urls.slice(0, 10)
    },
    () => {
      profile.visual = {}
      profile.layout = {}
    },
    () => {
      profile.components.samples = []
      profile.ux.textSamples = []
      profile.assets.urls = []
    }
  ]
  for (const shrink of shrinkSteps) {
    shrink()
    markTruncated()
    const bytes = byteLengthOf(profile)
    if (bytes <= LIMITS.executeScriptResultBytes) {
      profile.evidence.truncation.executeScriptResult = Math.max(0, initialBytes - bytes)
      profile.evidence.truncation.executeScriptResultOverLimit = 0
      return profile
    }
  }
  const finalBytes = byteLengthOf(profile)
  profile.evidence.truncation.executeScriptResult = Math.max(0, initialBytes - finalBytes)
  profile.evidence.truncation.executeScriptResultOverLimit = Math.max(0, finalBytes - LIMITS.executeScriptResultBytes)
  return profile
}

const collectSiteExperienceProfile = () => {
  if (typeof document === 'undefined') return unavailableProfile()

  const truncation = emptyTruncation()
  const nodes = selectNodes()
  const cssSignals = collectCssSignals()
  const boundaries = collectBoundaries()
  const components = collectComponents()

  truncation.domNodes = Math.max(0, document.querySelectorAll('body *').length - nodes.length)
  truncation.componentSamples = components.omitted
  truncation.cssRules = cssSignals.omittedCssRules

  const profile = {
    visual: collectVisual(nodes),
    layout: collectLayout(nodes),
    components: { samples: components.samples, counts: components.counts },
    interaction: collectInteraction(nodes, cssSignals),
    ux: collectUxSignals(nodes, truncation),
    document: { language: cleanText(document.documentElement.lang || document.body?.getAttribute('lang') || '', 40) },
    assets: collectAssets(truncation),
    evidence: { inaccessibleStylesheets: cssSignals.inaccessibleStylesheets, ...boundaries, truncation },
    limitations: [
      'passive_interaction_only',
      boundaries.crossOriginIframes ? 'cross_origin_iframes_limited' : '',
      'closed_shadow_roots_unobservable'
    ].filter(Boolean)
  }

  return enforceResultLimit(profile)
}

export default collectSiteExperienceProfile()
