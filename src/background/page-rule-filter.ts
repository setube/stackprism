// 页面检测只注入可能命中的规则：先在页面里取一次资源 URL，带 resourceHints 的规则按 resourceHints 裁剪，
// 只能靠资源 URL 命中的规则再按必需字面量裁剪，其余规则原样保留。
// 探测不到资源时不裁剪，与 page-detector 在资源为空时退回整页文本判断的逻辑保持一致。
import type { HintLookup } from '@/utils/rule-hints'
import { createRuleListsScannerCache, getRuleAutoHints, getRuleResourceHints, passesResourceHintLookup } from './rule-matcher'

type PageRules = Record<string, unknown>

export interface PageResourceProbe {
  // 资源 URL，小写、换行分隔
  text: string
  href: string
}

// 只在 Service Worker 里使用的规则分组，不需要注入页面
const SERVICE_WORKER_ONLY_KEYS = new Set(['bundleLicenseLibraries', 'dynamicTechnologies'])
const RESOURCE_TARGETS = new Set(['resources', 'url', 'dynamic'])

const hasItems = (value: unknown): boolean => Array.isArray(value) && value.length > 0

// page-detector 对这类规则只拿 pattern 匹配资源 URL（matchIn 含 url 时加上页面地址），
// 全局变量、选择器、类名、CSS 变量都不看，所以必需字面量不在资源里就不可能命中
const isResourceScopedRule = (rule: any): boolean => {
  if (rule?.resourceOnly === true) return true
  if (!hasItems(rule?.matchIn) || !rule.matchIn.every((item: string) => RESOURCE_TARGETS.has(item))) return false
  return !hasItems(rule.globals) && !hasItems(rule.classPrefixes) && !hasItems(rule.classNames) && !hasItems(rule.cssVariables)
}

const getPruneScanner = createRuleListsScannerCache(rule => [
  ...getRuleResourceHints(rule),
  ...(isResourceScopedRule(rule) ? getRuleAutoHints(rule) : [])
])

const canMatchResources = (rule: any, lookup: HintLookup, href: string): boolean => {
  if (!passesResourceHintLookup(rule, lookup)) return false
  if (!isResourceScopedRule(rule)) return true
  const hints = getRuleAutoHints(rule)
  return !hints.length || hints.some(hint => lookup(hint) || href.includes(hint))
}

export const selectPageDetectorRules = (pageRules: PageRules, probe: PageResourceProbe | null): PageRules => {
  const entries = Object.entries(pageRules || {}).filter(([key]) => !SERVICE_WORKER_ONLY_KEYS.has(key))
  if (!probe) return Object.fromEntries(entries)
  const prunable = entries.filter(([key, value]) => key !== 'customRules' && Array.isArray(value))
  const lookup = getPruneScanner(prunable.map(([, value]) => value)).scan(probe.text)
  const href = String(probe.href || '').toLowerCase()
  const selected: PageRules = {}
  for (const [key, value] of entries) {
    selected[key] = key !== 'customRules' && Array.isArray(value) ? value.filter(rule => canMatchResources(rule, lookup, href)) : value
  }
  return selected
}

// 注入页面执行（必须自包含）：资源收集方式与 page-detector 的 collectResources 一致；没有资源时返回 null
export const probePageResources = (): PageResourceProbe | null => {
  const inspectable = (value: unknown) => {
    const url = String(value || '').trim()
    return Boolean(url) && !/^(?:data|blob|javascript|about):/i.test(url)
  }
  const scripts = [...document.scripts].map(script => script.src).filter(inspectable)
  // 预加载的脚本和延迟执行的脚本（地址在 data-* 属性里，只收带 / 的值）也是页面的脚本
  const preloadedScripts = [...document.querySelectorAll<HTMLLinkElement>("link[rel~='modulepreload'], link[rel~='preload'][as='script']")]
    .map(link => link.href)
    .filter(inspectable)
  const delayedAttributes = ['data-rocket-src', 'data-src', 'data-lazy-src', 'data-wpmeteor-src', 'data-rocketlazyloadscript']
  const delayedScripts = [...document.querySelectorAll(delayedAttributes.map(name => `script[${name}]`).join(', '))]
    .map(script =>
      delayedAttributes.map(name => script.getAttribute(name)).find(value => inspectable(value) && String(value).includes('/'))
    )
    .filter(Boolean)
    .map(value => {
      try {
        return new URL(String(value).trim(), location.href).href
      } catch {
        return ''
      }
    })
    .filter(Boolean)
  const stylesheets = [...document.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet'], link[as='style']")]
    .map(link => link.href)
    .filter(inspectable)
  const resourceTiming = performance
    .getEntriesByType('resource')
    .map(entry => entry.name)
    .filter(inspectable)
  const images = [...document.images]
    .map(image => image.currentSrc || image.src)
    .filter(inspectable)
    .slice(0, 200)
  const text = [...new Set([...scripts, ...delayedScripts, ...stylesheets, ...resourceTiming, ...images, ...preloadedScripts])]
    .join('\n')
    .toLowerCase()
  return text ? { text, href: location.href } : null
}

export const probeTabResources = async (tabId: number): Promise<PageResourceProbe | null> => {
  try {
    const [probe] = await chrome.scripting.executeScript({ target: { tabId }, func: probePageResources })
    const result = probe?.result as PageResourceProbe | null | undefined
    return result && typeof result.text === 'string' ? result : null
  } catch {
    return null
  }
}
