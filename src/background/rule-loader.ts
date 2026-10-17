import type { RuleConfig } from '@/types/rules'
import { mergeRulePartial } from '@/core/rule-normalizer'

const RULE_INDEX_PATH = 'rules/index.json'
const fetchRuleJson = async (relativePath: string): Promise<any> => {
  const response = await fetch(chrome.runtime.getURL(relativePath))
  if (!response.ok) {
    throw new Error(`规则文件加载失败：${relativePath} ${response.status}`)
  }
  return response.json()
}

const normalizeRulePath = (file: string) => {
  const value = String(file || '').replace(/^\/+/, '')
  if (!value || value.includes('..')) {
    throw new Error('规则目录清单包含无效路径')
  }
  return value.startsWith('rules/') ? value : `rules/${value}`
}

export const loadStackPrismRules = async (): Promise<RuleConfig> => {
  const index = await fetchRuleJson(RULE_INDEX_PATH)
  const files = Array.isArray(index.files) ? index.files : []
  const rules: RuleConfig = { schemaVersion: index.schemaVersion || 1 }
  const partials = await Promise.all(files.map((file: unknown) => fetchRuleJson(normalizeRulePath(String(file ?? '')))))

  for (const partial of partials) {
    mergeRulePartial(rules, partial)
  }

  return rules
}
