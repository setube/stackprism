import { buildRuleHintFields } from '../utils/rule-hints.ts'

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g

const escapeForRegex = (value: string) => value.replace(REGEX_ESCAPE, '\\$&')

const buildKeywordCombinedSource = (patterns: unknown): string => {
  if (!Array.isArray(patterns) || !patterns.length) return ''
  const segments = patterns
    .map(pattern => String(pattern || '').trim())
    .filter(Boolean)
    .map(escapeForRegex)
  return segments.length ? segments.join('|') : ''
}

const isPlainNode = (node: any): boolean => Boolean(node) && typeof node === 'object' && !Array.isArray(node)
const isLeafRule = (node: any): boolean => isPlainNode(node) && Array.isArray(node.patterns)
const isRuleGroup = (node: any): boolean => isPlainNode(node) && Array.isArray(node.rules)

// 规则组的 defaults 会被展开到每条规则上（matchType、resourceHints 常写在 defaults 里），预编译时按展开后的字段判断
export const precompileRuleTree = (node: any, inherited: Record<string, unknown> = {}): void => {
  if (!node) return
  if (Array.isArray(node)) {
    for (const item of node) precompileRuleTree(item, inherited)
    return
  }
  if (!isPlainNode(node)) return
  if (isRuleGroup(node)) {
    const defaults = {
      ...inherited,
      ...(isPlainNode(node.defaults) ? node.defaults : {}),
      ...(isPlainNode(node.$defaults) ? node.$defaults : {})
    }
    for (const item of node.rules) precompileRuleTree(item, defaults)
    return
  }
  if (isLeafRule(node)) {
    const rule = { ...inherited, ...node }
    const isKeyword = rule.matchType === 'keyword'
    const { hints, legacyHints } = buildRuleHintFields(node.patterns, isKeyword, node.matchType === 'keyword', node.__hints)
    if (hints.length) node.__hints = hints
    else delete node.__hints
    // 旧版带 resourceHints 的规则不看自动 hint，旧门槛只留给没有 resourceHints 的规则
    if (legacyHints.length && !(Array.isArray(rule.resourceHints) && rule.resourceHints.length)) node.__legacyHints = legacyHints
    if (node.matchType === 'keyword') {
      const combined = buildKeywordCombinedSource(node.patterns)
      if (combined) node.__keywordCombined = combined
    }
    return
  }
  for (const key in node) precompileRuleTree(node[key])
}
