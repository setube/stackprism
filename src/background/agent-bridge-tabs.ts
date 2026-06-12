import { isAgentBridgePageUrl } from '@/utils/page-support'
import { getBridgeSession } from './agent-bridge-session'

export const isAgentBridgeTab = (tab: Pick<chrome.tabs.Tab, 'url' | 'pendingUrl'> | null | undefined): boolean =>
  Boolean(tab && (isAgentBridgePageUrl(tab.url) || isAgentBridgePageUrl(tab.pendingUrl)))

const parseLoopbackBridgeRequestUrl = (value: unknown): URL | null => {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null
    return url
  } catch {
    return null
  }
}

export const isAgentBridgeRequestUrl = (value: unknown, tab?: Pick<chrome.tabs.Tab, 'url' | 'pendingUrl'> | null): boolean => {
  const url = parseLoopbackBridgeRequestUrl(value)
  if (!url) return false
  if (isAgentBridgePageUrl(value)) return true
  return url.pathname.startsWith('/v1/captures/') && isAgentBridgeTab(tab)
}

export const isAgentBridgeRequestForTab = async (
  value: unknown,
  tabId: number,
  tab?: Pick<chrome.tabs.Tab, 'url' | 'pendingUrl'> | null
): Promise<boolean> => {
  const url = parseLoopbackBridgeRequestUrl(value)
  if (!url) return false
  if (isAgentBridgePageUrl(value)) return true
  if (!url.pathname.startsWith('/v1/captures/')) return false
  if (isAgentBridgeTab(tab)) return true
  const session = await getBridgeSession(tabId).catch(() => null)
  return Boolean(session && session.bridgeOrigin === url.origin)
}

export const shouldIgnoreBridgeTabEvent = (tab: Pick<chrome.tabs.Tab, 'url' | 'pendingUrl'> | null | undefined): boolean =>
  isAgentBridgeTab(tab)
