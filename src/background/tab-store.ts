import { compatStorage } from '@/utils/browser-compat'

const TAB_DATA_PREFIX = 'tab:'
const POPUP_DATA_PREFIX = 'popup:'

export const storageKey = (tabId: number): string => `${TAB_DATA_PREFIX}${tabId}`

export const popupStorageKey = (tabId: number): string => `${POPUP_DATA_PREFIX}${tabId}`

export const getTabData = async (tabId: number): Promise<any> => {
  const key = storageKey(tabId)
  try {
    const stored = await compatStorage.session.get(key)
    return stored[key] || {}
  } catch {
    return {}
  }
}

export const getPopupCache = async (tabId: number): Promise<any> => {
  const key = popupStorageKey(tabId)
  try {
    const stored = await compatStorage.session.get(key)
    return stored[key] || null
  } catch {
    return null
  }
}

export const writeTabData = async (tabId: number, tabData: Record<string, unknown>, popupRecord: any): Promise<void> => {
  await compatStorage.session.set({
    [storageKey(tabId)]: tabData,
    [popupStorageKey(tabId)]: popupRecord
  })
}

export const clearTabSession = async (tabId: number): Promise<void> => {
  await compatStorage.session.remove([storageKey(tabId), popupStorageKey(tabId)]).catch(() => {})
}

export const getTabSnapshot = async (tabId: number): Promise<{ id: number; url: string; title: string }> => {
  try {
    const tab = await chrome.tabs.get(tabId)
    return {
      id: tab.id ?? tabId,
      url: tab.url || '',
      title: tab.title || ''
    }
  } catch {
    return { id: tabId, url: '', title: '' }
  }
}

export const formatBadgeCount = (count: number): string => {
  if (!count) return ''
  return count > 99 ? '99+' : String(count)
}

export const updateBadgeForTab = async (tabId: number, popup: any): Promise<void> => {
  const count = Number(popup?.counts?.total || 0)
  const text = formatBadgeCount(count)
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0f766e' })
    await chrome.action.setBadgeText({ tabId, text })
    await chrome.action.setTitle({
      tabId,
      title: count > 0 ? `StackPrism 栈棱镜 · 已识别 ${count} 项技术` : 'StackPrism 栈棱镜'
    })
  } catch {
    return
  }
}

export const clearBadge = (tabId: number): void => {
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
  chrome.action.setTitle({ tabId, title: 'StackPrism 栈棱镜' }).catch(() => {})
}
