export type Confidence = '高' | '中' | '低'
export type MatchType = 'regex' | 'keyword'
export type MatchTarget = 'url' | 'resources' | 'html' | 'headers' | 'dynamic'

export interface CustomRule {
  name: string
  category: string
  kind: string
  confidence: Confidence
  matchType: MatchType
  patterns: string[]
  selectors: string[]
  globals: string[]
  matchIn: MatchTarget[]
  url: string
}

export interface DetectorSettings {
  disabledCategories: string[]
  disabledTechnologies: string[]
  customRules: CustomRule[]
  customCss: string
  agentBridgeEnabled: boolean
  agentBridgeAllowAllNetworkTargets: boolean
}

export const ALLOWED_CONFIDENCES: readonly Confidence[] = ['高', '中', '低']
export const ALLOWED_MATCH_TYPES: readonly MatchType[] = ['regex', 'keyword']
export const ALLOWED_MATCH_TARGETS: readonly MatchTarget[] = ['url', 'resources', 'html', 'headers', 'dynamic']

export const CUSTOM_RULE_LIMITS = {
  rules: 200,
  name: 120,
  category: 80,
  kind: 120,
  url: 500,
  patterns: 60,
  selectors: 30,
  globals: 30,
  matchIn: 10,
  item: 500,
  customCss: 40000
} as const

export const DEFAULT_SETTINGS: DetectorSettings = {
  disabledCategories: [],
  disabledTechnologies: [],
  customRules: [],
  customCss: '',
  agentBridgeEnabled: false,
  agentBridgeAllowAllNetworkTargets: false
}
