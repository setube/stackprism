import {
  ALLOWED_CONFIDENCES,
  CUSTOM_RULE_LIMITS,
  DEFAULT_SETTINGS,
  type Confidence,
  type CustomRule,
  type DetectorSettings,
  type MatchTarget,
  type MatchType
} from '@/types/settings'

export interface NormalizeSettingsOptions {
  allowAgentBridge?: boolean
  allowAgentBridgeNetworkOverride?: boolean
}

export const cleanStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const trimmed = value.map(item => String(item ?? '').trim()).filter(Boolean)
  return [...new Set(trimmed)]
}

const cleanRuleUrl = (value: unknown): string => {
  const text = String(value ?? '').trim()
  if (!/^https?:\/\//i.test(text)) return ''
  return text.slice(0, CUSTOM_RULE_LIMITS.url)
}

const pickConfidence = (value: unknown): Confidence => (ALLOWED_CONFIDENCES.includes(value as Confidence) ? (value as Confidence) : '中')

const pickMatchType = (value: unknown): MatchType => (value === 'keyword' ? 'keyword' : 'regex')

const pickMatchTargets = (value: unknown): MatchTarget[] => cleanStringArray(value).slice(0, CUSTOM_RULE_LIMITS.matchIn) as MatchTarget[]

export const cleanCustomRules = (value: unknown): CustomRule[] => {
  if (!Array.isArray(value)) return []
  return value
    .map((rule: Record<string, unknown> = {}): CustomRule => {
      const r = rule ?? {}
      return {
        name: String(r.name ?? '')
          .trim()
          .slice(0, CUSTOM_RULE_LIMITS.name),
        category: String(r.category ?? '其他库')
          .trim()
          .slice(0, CUSTOM_RULE_LIMITS.category),
        kind: String(r.kind ?? '自定义规则')
          .trim()
          .slice(0, CUSTOM_RULE_LIMITS.kind),
        confidence: pickConfidence(r.confidence),
        matchType: pickMatchType(r.matchType),
        patterns: cleanStringArray(r.patterns).slice(0, CUSTOM_RULE_LIMITS.patterns),
        selectors: cleanStringArray(r.selectors).slice(0, CUSTOM_RULE_LIMITS.selectors),
        globals: cleanStringArray(r.globals).slice(0, CUSTOM_RULE_LIMITS.globals),
        matchIn: pickMatchTargets(r.matchIn),
        url: cleanRuleUrl(r.url)
      }
    })
    .filter(rule => rule.name && (rule.patterns.length || rule.selectors.length || rule.globals.length))
    .slice(0, CUSTOM_RULE_LIMITS.rules)
}

export const normalizeSettings = (value: unknown = {}, options: NormalizeSettingsOptions = {}): DetectorSettings => {
  const v = (value ?? {}) as Partial<DetectorSettings>
  const customCss = typeof v.customCss === 'string' ? v.customCss.slice(0, CUSTOM_RULE_LIMITS.customCss) : ''
  const agentBridgeEnabled = options.allowAgentBridge === true && v.agentBridgeEnabled === true
  return {
    disabledCategories: cleanStringArray(v.disabledCategories),
    disabledTechnologies: cleanStringArray(v.disabledTechnologies),
    customRules: cleanCustomRules(v.customRules),
    customCss,
    agentBridgeEnabled,
    agentBridgeAllowAllNetworkTargets: agentBridgeEnabled && options.allowAgentBridgeNetworkOverride === true && v.agentBridgeAllowAllNetworkTargets === true
  }
}

export const normalizeSettingsWithLocalOptIn = (syncValue: unknown = {}, localValue: unknown = {}): DetectorSettings => {
  const local = (localValue ?? {}) as Partial<DetectorSettings>
  const localAgentBridgeEnabled = local.agentBridgeEnabled === true
  return normalizeSettings(
    {
      ...(syncValue as Record<string, unknown>),
      agentBridgeEnabled: localAgentBridgeEnabled,
      agentBridgeAllowAllNetworkTargets: localAgentBridgeEnabled ? local.agentBridgeAllowAllNetworkTargets : false
    },
    { allowAgentBridge: true, allowAgentBridgeNetworkOverride: true }
  )
}

export const defaultSettings = (): DetectorSettings => ({ ...DEFAULT_SETTINGS, customRules: [] })
