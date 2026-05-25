import { injectContentObserverIntoOpenTabs } from './content-injector'
import { clearBadge, clearTabSession } from './tab-store'
import { clearDynamicSnapshotTimer, clearPendingDynamicSnapshot } from './dynamic-snapshot'
import { buildHeaderRecord, dedupeApiRecords, mergeHeaderRecords, shouldMergeHeaderRecords } from './headers'
import {
  clearActiveDetectionTimer,
  clearDetectionThrottle,
  refreshAllBadges,
  saveTabDataAndBadge,
  scheduleActivePageDetection
} from './detection'
import { getTabData, getTabSnapshot } from './tab-store'
import { SETTINGS_STORAGE_KEY, applyDetectorSettingsUpdate, loadDetectorSettings, loadTechRules } from './detector-settings'
import { registerMessageRouter } from './message-router'
import { clearBundleLicenseTimer } from './bundle-license'
import { clearTabWriteLock, withTabWriteLock } from './tab-write-lock'
import { isDetectablePageUrl, isObservableRequestUrl } from '@/utils/page-support'
import { clearLegacySessionKeys } from '@/utils/browser-compat'

registerMessageRouter()
refreshAllBadges().catch(() => {})

chrome.runtime.onInstalled.addListener(() => {
  injectContentObserverIntoOpenTabs()
})

chrome.runtime.onStartup.addListener(() => {
  clearLegacySessionKeys().catch(() => {})
  injectContentObserverIntoOpenTabs()
})

chrome.tabs.onRemoved.addListener(tabId => {
  clearActiveDetectionTimer(tabId)
  clearDetectionThrottle(tabId)
  clearBundleLicenseTimer(tabId)
  clearDynamicSnapshotTimer(tabId)
  clearPendingDynamicSnapshot(tabId)
  clearTabSession(tabId)
})

const clearTabDetectionState = (tabId: number) => {
  clearActiveDetectionTimer(tabId)
  clearDetectionThrottle(tabId)
  clearBundleLicenseTimer(tabId)
  clearDynamicSnapshotTimer(tabId)
  clearPendingDynamicSnapshot(tabId)
  clearTabWriteLock(tabId)
  clearBadge(tabId)
  clearTabSession(tabId).catch(() => {})
}

const getUrlOrigin = (value: unknown): string => {
  try {
    return new URL(String(value || '')).origin
  } catch {
    return ''
  }
}

const clearCrossOriginDynamicSnapshot = (data: any, nextUrl: string) => {
  const dynamicOrigin = getUrlOrigin(data?.dynamic?.url)
  const nextOrigin = getUrlOrigin(nextUrl)
  if (dynamicOrigin && nextOrigin && dynamicOrigin !== nextOrigin) {
    delete data.dynamic
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || ''
  if (url && !isDetectablePageUrl(url)) {
    clearTabDetectionState(tabId)
    return
  }

  if (changeInfo.status === 'loading') {
    console.log('[SP detection] onUpdated loading', tabId, 'url', url)
    clearActiveDetectionTimer(tabId)
    clearDynamicSnapshotTimer(tabId)
    clearPendingDynamicSnapshot(tabId)
    clearBadge(tabId)
    return
  }

  if (changeInfo.status === 'complete') {
    console.log('[SP detection] onUpdated complete', tabId, 'url', url)
    if (isDetectablePageUrl(url)) {
      scheduleActivePageDetection(tabId, 600)
    } else {
      clearTabDetectionState(tabId)
    }
  }
})

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return
  console.log('[SP detection] webNav committed', details.tabId, 'transition:', details.transitionType, details.url)
  clearDetectionThrottle(details.tabId)
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes[SETTINGS_STORAGE_KEY]) {
    applyDetectorSettingsUpdate(changes[SETTINGS_STORAGE_KEY].newValue)
    refreshAllBadges()
  }
})

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0 || !details.responseHeaders) return
    if (!isObservableRequestUrl(details.url)) return

    Promise.all([loadTechRules(), loadDetectorSettings(), getTabSnapshot(details.tabId)])
      .then(async ([rules, settings, tab]) => {
        if (details.type === 'main_frame' && !isDetectablePageUrl(details.url)) {
          clearTabDetectionState(details.tabId)
          return
        }
        if (details.type !== 'main_frame' && !isDetectablePageUrl(tab.url)) {
          clearTabDetectionState(details.tabId)
          return
        }
        const record = buildHeaderRecord(details, rules.headers || {}, settings)
        // 进 per-tab 锁:concurrent webRequest 事件不能并发 read-modify-write,否则会互相覆盖彼此的 apis / frames / main
        await withTabWriteLock(details.tabId, async () => {
          const latest = (await getTabData(details.tabId)) || {}
          if (details.type === 'main_frame') {
            clearCrossOriginDynamicSnapshot(latest, details.url)
            latest.main = shouldMergeHeaderRecords(latest.main, record) ? mergeHeaderRecords(latest.main, record) : record
            latest.apis = []
            latest.frames = []
          } else if (details.type === 'xmlhttprequest' || (details.type as string) === 'fetch' || details.type === 'websocket') {
            latest.apis = dedupeApiRecords([record, ...(latest.apis || [])])
          } else if (details.type === 'sub_frame') {
            latest.frames = dedupeApiRecords([record, ...(latest.frames || [])]).slice(0, 10)
          }
          latest.updatedAt = Date.now()
          await saveTabDataAndBadge(details.tabId, latest, settings)
        })
      })
      .catch(() => {})
  },
  { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
  ['responseHeaders', 'extraHeaders']
)
