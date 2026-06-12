import { injectAgentBridgeClient, injectContentObserverIntoOpenTabs } from './content-injector'
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
import { registerActiveTabTracker } from './active-tab-tracker'
import { isAgentBridgeRequestForTab, isAgentBridgeRequestUrl, shouldIgnoreBridgeTabEvent } from './agent-bridge-tabs'
import { clearBridgeSession } from './agent-bridge-session'
import { logBackgroundError, redactLogUrl } from './logging'
import {
  handleAgentBridgeDataConsentRemoved,
  handleAgentBridgeOptInDisabled,
  handleAgentCaptureNavigationError,
  handleAgentCaptureTabNavigation,
  handleAgentCaptureTabRemoved,
  isActiveAgentCaptureTargetTab,
  recoverInterruptedAgentCaptures,
  setAgentCaptureStartupRecoveryGate
} from './agent-capture'
import { clearAgentCaptureNetworkEvidence, clearStaleAgentCaptureNetworkEvidence, registerAgentCaptureNetworkObserver } from './agent-capture-network'
import { clearAgentCaptureTargetTabGuard, isRecentlyAgentCaptureTargetTab } from './agent-capture-target-guard'
import { isDetectablePageUrl, isObservableRequestUrl } from '@/utils/page-support'
import { clearLegacySessionKeys } from '@/utils/browser-compat'
import { includesAgentBridgeDataConsentRemoval } from '@/utils/firefox-data-consent'

registerMessageRouter()
registerActiveTabTracker()

const recoverInterruptedAgentCapturesAndLog = (): void => {
  const recovery = recoverInterruptedAgentCaptures().catch(error => logBackgroundError('recoverInterruptedAgentCaptures failed', { error }))
  setAgentCaptureStartupRecoveryGate(recovery)
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

const applySyncDetectorSettingsChange = async (syncValue: unknown): Promise<void> => {
  let localValue: unknown = {}
  try {
    const local = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
    localValue = local[SETTINGS_STORAGE_KEY]
  } catch (error) {
    logBackgroundError('sync settings local read failed', { areaName: 'sync', key: SETTINGS_STORAGE_KEY, error })
  }
  applyDetectorSettingsUpdate(syncValue, localValue)
  await refreshAllBadges()
}

recoverInterruptedAgentCapturesAndLog()
refreshAllBadges().catch(error => logBackgroundError('refreshAllBadges failed', { error }))

const handleExtensionLifecycleWake = (): void => {
  clearLegacySessionKeys().catch(error => logBackgroundError('clearLegacySessionKeys failed', { error }))
  injectContentObserverIntoOpenTabs()
  recoverInterruptedAgentCapturesAndLog()
}

chrome.runtime.onInstalled.addListener(handleExtensionLifecycleWake)

chrome.runtime.onStartup.addListener(handleExtensionLifecycleWake)

chrome.permissions?.onRemoved?.addListener(permissions => {
  if (!includesAgentBridgeDataConsentRemoval(permissions)) return
  handleAgentBridgeDataConsentRemoved().catch(error => logBackgroundError('handleAgentBridgeDataConsentRemoved failed', { error }))
})

chrome.tabs.onRemoved.addListener(tabId => {
  handleAgentCaptureTabRemoved(tabId).catch(error => logBackgroundError('handleAgentCaptureTabRemoved failed', { tabId, error }))
  clearActiveDetectionTimer(tabId)
  clearDetectionThrottle(tabId)
  clearBundleLicenseTimer(tabId)
  clearDynamicSnapshotTimer(tabId)
  clearPendingDynamicSnapshot(tabId)
  clearAgentCaptureNetworkEvidence(tabId)
  clearAgentCaptureTargetTabGuard(tabId)
  clearTabSession(tabId).catch(error => logBackgroundError('clearTabSession failed', { tabId, error }))
  clearBridgeSession(tabId).catch(error => logBackgroundError('clearBridgeSession failed', { tabId, error }))
})

const clearTabDetectionState = (tabId: number) => {
  clearActiveDetectionTimer(tabId)
  clearDetectionThrottle(tabId)
  clearBundleLicenseTimer(tabId)
  clearDynamicSnapshotTimer(tabId)
  clearPendingDynamicSnapshot(tabId)
  clearTabWriteLock(tabId)
  clearAgentCaptureNetworkEvidence(tabId)
  clearBadge(tabId)
  clearTabSession(tabId).catch(error => logBackgroundError('clearTabSession failed', { tabId, error }))
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || ''
  if (changeInfo.url) {
    handleAgentCaptureTabNavigation(tabId, changeInfo.url).catch(error =>
      logBackgroundError('handleAgentCaptureTabNavigation failed', { tabId, error })
    )
  }
  if (shouldIgnoreBridgeTabEvent(tab)) {
    if (changeInfo.status === 'complete') {
      injectAgentBridgeClient(tabId).catch(error => logBackgroundError('injectAgentBridgeClient failed', { tabId, error }))
    }
    return
  }
  if (url && !isDetectablePageUrl(url)) {
    clearTabDetectionState(tabId)
    return
  }

  if (changeInfo.status === 'loading') {
    console.log('[SP detection] onUpdated loading', tabId, 'url', redactLogUrl(url))
    clearActiveDetectionTimer(tabId)
    clearDynamicSnapshotTimer(tabId)
    clearPendingDynamicSnapshot(tabId)
    clearStaleAgentCaptureNetworkEvidence(tabId).catch(error =>
      logBackgroundError('clearStaleAgentCaptureNetworkEvidence failed', { tabId, error })
    )
    clearBadge(tabId)
    return
  }

  if (changeInfo.status === 'complete') {
    console.log('[SP detection] onUpdated complete', tabId, 'url', redactLogUrl(url))
    if (isDetectablePageUrl(url)) {
      const wasCaptureTarget = isRecentlyAgentCaptureTargetTab(tabId)
      isActiveAgentCaptureTargetTab(tabId)
        .then(isCaptureTarget => {
          if (!isCaptureTarget && !wasCaptureTarget) scheduleActivePageDetection(tabId, 600)
        })
        .catch(error => {
          logBackgroundError('active capture target check failed', { tabId, error })
          if (!wasCaptureTarget) scheduleActivePageDetection(tabId, 600)
        })
    } else {
      clearTabDetectionState(tabId)
    }
  }
})

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return
  if (isAgentBridgeRequestUrl(details.url)) return
  getTabSnapshot(details.tabId)
    .then(async tab => {
      if (await isAgentBridgeRequestForTab(details.url, details.tabId, tab)) return
      console.log('[SP detection] webNav committed', details.tabId, 'transition:', details.transitionType, redactLogUrl(details.url))
      clearDetectionThrottle(details.tabId)
    })
    .catch(error => logBackgroundError('webNav committed handling failed', { tabId: details.tabId, error }))
})

chrome.webNavigation.onErrorOccurred.addListener(details => {
  handleAgentCaptureNavigationError(details.tabId, details.frameId, details.error).catch(error =>
    logBackgroundError('handleAgentCaptureNavigationError failed', {
      tabId: details.tabId,
      frameId: details.frameId,
      error
    })
  )
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes[SETTINGS_STORAGE_KEY]) {
    applySyncDetectorSettingsChange(changes[SETTINGS_STORAGE_KEY].newValue)
      .catch(error => logBackgroundError('sync settings change handling failed', { areaName, key: SETTINGS_STORAGE_KEY, error }))
  }
  if (areaName === 'local' && changes[SETTINGS_STORAGE_KEY]) {
    chrome.storage.sync
      .get(SETTINGS_STORAGE_KEY)
      .then(async sync => {
        const settings = applyDetectorSettingsUpdate(sync[SETTINGS_STORAGE_KEY], changes[SETTINGS_STORAGE_KEY].newValue)
        if (!settings.agentBridgeEnabled) await handleAgentBridgeOptInDisabled()
        await refreshAllBadges()
      })
      .catch(error => logBackgroundError('local settings change handling failed', { areaName, key: SETTINGS_STORAGE_KEY, error }))
  }
})

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0 || !details.responseHeaders) return
    if (isAgentBridgeRequestUrl(details.url)) return
    if (!isObservableRequestUrl(details.url)) return

    getTabSnapshot(details.tabId)
      .then(async tab => {
        if (await isAgentBridgeRequestForTab(details.url, details.tabId, tab)) return
        const [rules, settings] = await Promise.all([loadTechRules(), loadDetectorSettings()])
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
      .catch(error => logBackgroundError('webRequest header handling failed', { tabId: details.tabId, error }))
  },
  { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
  ['responseHeaders', 'extraHeaders']
)

registerAgentCaptureNetworkObserver((tabId, error) =>
  logBackgroundError('agent capture network response handling failed', { tabId, error })
)
