const DETECTABLE_PROTOCOLS = new Set(['http:', 'https:'])
const OBSERVABLE_REQUEST_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])
const BRIDGE_QUERY_SPECS = {
  session: /^s_[A-Za-z0-9_-]{22}$/,
  capture: /^cap_[A-Za-z0-9_-]{22}$/,
  nonce: /^n_[A-Za-z0-9_-]{22}$/
} as const

export type PageSupport = {
  supported: boolean
  reason: string
}

const getProtocol = (url: unknown): string => {
  const text = String(url || '').trim()
  if (!text) return ''
  try {
    return new URL(text).protocol.toLowerCase()
  } catch {
    const match = text.match(/^([a-z][a-z0-9+.-]*):/i)
    return match ? `${match[1].toLowerCase()}:` : ''
  }
}

export const isAgentBridgePageUrl = (url: unknown): boolean => {
  try {
    const parsed = new URL(String(url || ''))
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/bridge') return false
    const values: Record<string, string> = {}
    const parts = parsed.search.replace(/^\?/, '').split('&').filter(Boolean)
    if (parts.length !== 3) return false
    for (const part of parts) {
      const separatorIndex = part.indexOf('=')
      if (separatorIndex <= 0 || part.indexOf('=', separatorIndex + 1) !== -1) return false
      const name = part.slice(0, separatorIndex)
      const value = part.slice(separatorIndex + 1)
      const spec = BRIDGE_QUERY_SPECS[name as keyof typeof BRIDGE_QUERY_SPECS]
      if (!spec || values[name] !== undefined || !spec.test(value)) return false
      values[name] = value
    }
    return Boolean(values.session && values.capture && values.nonce)
  } catch {
    return false
  }
}

export const isDetectablePageUrl = (url: unknown): boolean => DETECTABLE_PROTOCOLS.has(getProtocol(url)) && !isAgentBridgePageUrl(url)

export const isObservableRequestUrl = (url: unknown): boolean => OBSERVABLE_REQUEST_PROTOCOLS.has(getProtocol(url))

export const checkPageSupport = (url: unknown): PageSupport => {
  const protocol = getProtocol(url)
  if (isAgentBridgePageUrl(url)) return { supported: false, reason: 'Agent Bridge 页面不进入普通检测流程。' }
  if (!protocol) return { supported: false, reason: '当前标签页还没有加载网页。' }
  if (protocol === 'chrome:') return { supported: false, reason: 'Chrome 浏览器内置页面无法注入检测脚本。' }
  if (protocol === 'edge:') return { supported: false, reason: 'Edge 浏览器内置页面无法注入检测脚本。' }
  if (protocol === 'brave:' || protocol === 'opera:' || protocol === 'vivaldi:') {
    return { supported: false, reason: '浏览器内置页面无法注入检测脚本。' }
  }
  if (protocol === 'chrome-extension:' || protocol === 'moz-extension:' || protocol === 'safari-web-extension:') {
    return { supported: false, reason: '扩展程序内部页面无法识别。' }
  }
  if (protocol === 'about:') return { supported: false, reason: '浏览器内部页面无法注入检测脚本。' }
  if (protocol === 'view-source:') return { supported: false, reason: '查看源码页面不支持检测。' }
  if (protocol === 'devtools:' || protocol === 'chrome-search:' || protocol === 'chrome-untrusted:') {
    return { supported: false, reason: '当前页面不支持检测。' }
  }
  if (protocol === 'file:') return { supported: false, reason: '本地文件页面暂不检测。' }
  if (protocol === 'data:' || protocol === 'blob:') return { supported: false, reason: '当前页面类型不支持检测。' }
  if (!DETECTABLE_PROTOCOLS.has(protocol)) return { supported: false, reason: '当前页面类型不支持检测。' }
  return { supported: true, reason: '' }
}
