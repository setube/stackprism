import { isDetectablePageUrl } from '@/utils/page-support'
import { isAgentBridgeTab } from './agent-bridge-tabs'

const ACTIVE_TAB_PREFIX = 'agent-active-tab:'

export interface ActiveTabRecord {
  tabId: number
  windowId: number
  url: string
  updatedAt: number
}

const keyForWindow = (windowId: number): string => `${ACTIVE_TAB_PREFIX}${windowId}`
const clearRecordedActiveTab = async (windowId: number): Promise<void> => {
  await chrome.storage.session.remove(keyForWindow(windowId))
}

const reportTrackerFailure = (): void => {
  console.warn('StackPrism active tab tracker failed.')
}

export const recordActiveTab = async (tab: chrome.tabs.Tab): Promise<void> => {
  if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') return
  if (tab.incognito || !isDetectablePageUrl(tab.url)) {
    if (isAgentBridgeTab(tab) || !tab.url) return
    await clearRecordedActiveTab(tab.windowId)
    return
  }
  await chrome.storage.session.set({
    [keyForWindow(tab.windowId)]: {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url || '',
      updatedAt: Date.now()
    } satisfies ActiveTabRecord
  })
}

export const getPreviousActiveTab = async (windowId: number): Promise<ActiveTabRecord | null> => {
  const stored = await chrome.storage.session.get(keyForWindow(windowId))
  return stored[keyForWindow(windowId)] || null
}

export const registerActiveTabTracker = (): void => {
  chrome.tabs.onActivated.addListener(async activeInfo => {
    try {
      await recordActiveTab(await chrome.tabs.get(activeInfo.tabId))
    } catch {
      reportTrackerFailure()
    }
  })
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' && !changeInfo.url) return
    if (typeof tab.windowId !== 'number') return
    try {
      const previous = await getPreviousActiveTab(tab.windowId)
      if (previous?.tabId === tabId || tab.active) await recordActiveTab(tab)
    } catch {
      reportTrackerFailure()
    }
  })
}
