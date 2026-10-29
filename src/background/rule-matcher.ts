import { createHintScanner, extractRuleHints, type HintLookup, type HintScanner } from '@/utils/rule-hints'

const compiledRulePatternCache = new WeakMap<object, { source: unknown; compiled: RegExp[] }>()
const compiledCombinedPatternCache = new WeakMap<object, { source: unknown; compiled: RegExp | null }>()
const autoHintCache = new WeakMap<object, string[]>()

export const escapeRegExp = (value: unknown): string => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const compileRulePattern = (pattern: string, rule: any): RegExp => {
  if (rule?.matchType === 'keyword') {
    return new RegExp(escapeRegExp(pattern), rule?.caseSensitive ? '' : 'i')
  }
  return new RegExp(pattern, rule?.caseSensitive ? '' : 'i')
}

export const getCompiledRulePatterns = (rule: any, patterns: unknown): RegExp[] => {
  const sourcePatterns: any[] = Array.isArray(patterns) ? patterns : []
  if (!rule || typeof rule !== 'object') {
    return sourcePatterns.flatMap(pattern => {
      try {
        return [compileRulePattern(pattern, rule)]
      } catch {
        return []
      }
    })
  }

  const cached = compiledRulePatternCache.get(rule)
  if (cached && cached.source === sourcePatterns) {
    return cached.compiled
  }

  const compiled = sourcePatterns.flatMap(pattern => {
    try {
      return [compileRulePattern(pattern, rule)]
    } catch {
      return []
    }
  })
  compiledRulePatternCache.set(rule, { source: sourcePatterns, compiled })
  return compiled
}

const buildCombinedKeywordPattern = (patterns: any[]): RegExp | null => {
  const segments = patterns
    .map(pattern => String(pattern || '').trim())
    .filter(Boolean)
    .map(escapeRegExp)
  if (!segments.length) return null
  try {
    return new RegExp(segments.join('|'), 'i')
  } catch {
    return null
  }
}

export const getCompiledCombinedPattern = (rule: any, patterns: unknown): RegExp | null => {
  const sourcePatterns: any[] = Array.isArray(patterns) ? patterns : []
  if (!rule || typeof rule !== 'object') {
    return rule?.matchType === 'keyword' ? buildCombinedKeywordPattern(sourcePatterns) : null
  }

  const cached = compiledCombinedPatternCache.get(rule)
  if (cached && cached.source === sourcePatterns) {
    return cached.compiled
  }

  let compiled: RegExp | null = null
  if (rule.matchType === 'keyword') {
    if (typeof rule.__keywordCombined === 'string' && rule.__keywordCombined) {
      try {
        compiled = new RegExp(rule.__keywordCombined, 'i')
      } catch {
        compiled = null
      }
    }
    if (!compiled) compiled = buildCombinedKeywordPattern(sourcePatterns)
  }
  compiledCombinedPatternCache.set(rule, { source: sourcePatterns, compiled })
  return compiled
}

// 没有构建期 __hints 的规则（主要是用户自定义规则）运行时现算一次必需字面量集合
export const getRuleAutoHints = (rule: any): string[] => {
  if (!rule || typeof rule !== 'object') return []
  if (Array.isArray(rule.__hints) && rule.__hints.length) return rule.__hints
  const cached = autoHintCache.get(rule)
  if (cached) return cached
  const hints = extractRuleHints(rule.patterns, rule.matchType === 'keyword')
  autoHintCache.set(rule, hints)
  return hints
}

const resourceHintCache = new WeakMap<object, string[]>()

export const getRuleResourceHints = (rule: any): string[] => {
  if (!rule || typeof rule !== 'object' || !Array.isArray(rule.resourceHints)) return []
  const cached = resourceHintCache.get(rule)
  if (cached) return cached
  const hints: string[] = rule.resourceHints.map((hint: unknown) => String(hint || '').toLowerCase()).filter(Boolean)
  resourceHintCache.set(rule, hints)
  return hints
}

// resourceHints 是规则自己声明的门槛：一个都不在文本里就不跑
export const passesResourceHintLookup = (rule: any, lookup: HintLookup): boolean => {
  const hints = getRuleResourceHints(rule)
  return !hints.length || hints.some(lookup)
}

// 必需字面量预筛：正则能命中时文本里一定有其中一个，只影响速度不影响结果
export const passesHintLookup = (rule: any, lookup: HintLookup): boolean => {
  const hints = getRuleAutoHints(rule)
  return !hints.length || hints.some(lookup)
}

// 旧版预筛门槛（见 utils/rule-hints）：构建期只给旧门槛比健全 hint 更严、且没有 resourceHints 的规则写 __legacyHints
export const passesLegacyHintLookup = (rule: any, lookup: HintLookup): boolean => {
  const legacy = rule?.__legacyHints
  return !Array.isArray(legacy) || !legacy.length || legacy.some(lookup)
}

const allRuleHints = (rule: any): string[] => [
  ...getRuleResourceHints(rule),
  ...getRuleAutoHints(rule),
  ...(Array.isArray(rule?.__legacyHints) ? rule.__legacyHints : [])
]

// 同一批规则列表共用一个 hint 扫描器：列表引用不变（规则只在 SW 启动时加载一次）就复用上次建好的
export const createRuleListsScannerCache = (hintsOf: (rule: any) => string[] = allRuleHints) => {
  let lastLists: unknown[] = []
  let lastScanner: HintScanner | null = null
  return (lists: unknown[]): HintScanner => {
    if (lastScanner && lastLists.length === lists.length && lastLists.every((list, index) => list === lists[index])) {
      return lastScanner
    }
    const hints: string[] = []
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const rule of list) hints.push(...hintsOf(rule))
    }
    lastLists = lists
    lastScanner = createHintScanner(hints)
    return lastScanner
  }
}

// 自定义规则等没进扫描器的 hint 也能查：直接在文本里找
export const createTextHintLookup = (lowerText: string): HintLookup => createHintScanner([]).scan(lowerText)

// accept：正则命中后再确认这处命中能否作为证据（见 utils/resource-attribution）；不传只看是否命中
export const matchesCompiledRulePatterns = (rule: any, text: string, accept?: (pattern: RegExp, text: string) => boolean): boolean => {
  if (!rule || !Array.isArray(rule.patterns) || !rule.patterns.length) {
    return false
  }
  if (rule.matchType === 'keyword') {
    const combined = getCompiledCombinedPattern(rule, rule.patterns)
    if (combined) {
      combined.lastIndex = 0
      return combined.test(text) && (!accept || accept(combined, text))
    }
    const value = String(text || '').toLowerCase()
    return rule.patterns.some(
      (pattern: string) =>
        value.includes(String(pattern || '').toLowerCase()) && (!accept || accept(compileRulePattern(pattern, rule), text))
    )
  }
  return getCompiledRulePatterns(rule, rule.patterns).some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(text) && (!accept || accept(pattern, text))
  })
}

// bundle-license 扫到命中的 tech 后,从同一段文本里抽版本号
// 优先用规则上声明的 versionPattern 抽 capture group[1];没声明就走通用启发(从 rule.name 推 token)
const versionPatternCache = new WeakMap<any, RegExp | null>()
const genericVersionPatternCache = new WeakMap<any, RegExp[] | null>()
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g

const buildGenericVersionPatterns = (rule: any): RegExp[] => {
  const name = String(rule?.name || '').trim()
  if (!name) return []
  const patterns: RegExp[] = []
  const escapedName = name.replace(REGEX_ESCAPE, '\\$&')
  // 形式 1:`<Name> v?X.Y.Z`(license 注释最常见):React v18.3.0 / Day.js 1.11.0
  try {
    patterns.push(new RegExp(escapedName + '[\\s@:v]+v?(\\d+\\.\\d+(?:\\.\\d+)?)', 'i'))
  } catch {
    // ignore
  }
  // 形式 2:`<npm-token>@X.Y.Z`(npm 风格):react-router@7.12.0 / @vue/runtime-core@3.4.0
  const npmToken = name
    .toLowerCase()
    .replace(/\.js$/i, '')
    .replace(/\s*\/\s*.*$/, '') // 取 / 前主名:"飞书 / Lark 登录" → "飞书"
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9@/_-]/gi, '')
  if (npmToken && npmToken !== name.toLowerCase()) {
    try {
      patterns.push(new RegExp('\\b' + npmToken.replace(REGEX_ESCAPE, '\\$&') + '@(\\d+\\.\\d+(?:\\.\\d+)?)', 'i'))
    } catch {
      // ignore
    }
  } else if (npmToken) {
    try {
      patterns.push(new RegExp('\\b' + npmToken.replace(REGEX_ESCAPE, '\\$&') + '@(\\d+\\.\\d+(?:\\.\\d+)?)', 'i'))
    } catch {
      // ignore
    }
  }
  return patterns
}

export const extractVersionFromBundleText = (rule: any, text: string): string => {
  if (!rule || !text) return ''
  // 优先:规则上显式 versionPattern(精确)
  if (typeof rule.versionPattern === 'string' && rule.versionPattern) {
    let compiled = versionPatternCache.get(rule)
    if (compiled === undefined) {
      try {
        compiled = new RegExp(rule.versionPattern, 'i')
      } catch {
        compiled = null
      }
      versionPatternCache.set(rule, compiled)
    }
    if (compiled) {
      compiled.lastIndex = 0
      const m = compiled.exec(text)
      if (m) {
        for (let i = 1; i < m.length; i++) {
          const g = m[i]
          if (typeof g === 'string' && /^\d+\.\d+/.test(g)) return g
        }
      }
    }
  }
  // 回退:从 rule.name 自动推 token 跑通用版本号正则
  let generic = genericVersionPatternCache.get(rule)
  if (generic === undefined) {
    generic = buildGenericVersionPatterns(rule)
    genericVersionPatternCache.set(rule, generic.length ? generic : null)
  }
  if (!generic || !generic.length) return ''
  for (const pattern of generic) {
    pattern.lastIndex = 0
    const m = pattern.exec(text)
    if (m && typeof m[1] === 'string' && /^\d+\.\d+/.test(m[1])) return m[1]
  }
  return ''
}

export const matchesHeaderPatterns = (patterns: unknown, text: string, rule: any = {}): boolean => {
  if (!Array.isArray(patterns) || !patterns.length) {
    return false
  }
  return getCompiledRulePatterns(rule, patterns).some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

export const createCollector =
  (target: any[], defaultSource?: string) =>
  (category: string, name: string, confidence: string, evidence?: string, extras?: { version?: string; url?: string }) => {
    const tech: any = {
      category,
      name,
      confidence,
      evidence: evidence ? [String(evidence)] : [],
      source: defaultSource
    }
    if (extras && typeof extras.version === 'string' && extras.version) {
      tech.version = extras.version
    }
    if (extras && typeof extras.url === 'string' && extras.url) {
      tech.url = extras.url
    }
    target.push(tech)
  }

export const lower = (value: unknown): string => String(value || '').toLowerCase()

export const filterCustomRulesForTarget = (rules: any[], target: string): any[] => {
  if (!Array.isArray(rules)) {
    return []
  }
  return rules.filter(rule => {
    if (!Array.isArray(rule.matchIn) || !rule.matchIn.length) {
      return true
    }
    if (target === 'dynamic') {
      return rule.matchIn.some((item: string) => ['dynamic', 'resources', 'url'].includes(item))
    }
    if (target === 'headers') {
      return rule.matchIn.includes('headers')
    }
    return rule.matchIn.includes(target)
  })
}
