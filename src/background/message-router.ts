import { getTechnologyUrl } from './tech-links'
import { augmentPageWithWordPressThemeStyles, detectWordPressThemeStylesFromPage } from './wordpress'
import { clearBadge, clearTabSession, getTabData, getTabSnapshot } from './tab-store'
import { queueDynamicSnapshot } from './dynamic-snapshot'
import { addStoredCustomHeaderRules } from './headers'
import {
  buildPopupRawResult,
  cleanPageDetectionRecord,
  cleanTechnologyRecords,
  getPopupResultResponse,
  mergePageDetectionRecord
} from './popup-cache'
import { runActivePageDetection, saveTabDataAndBadge } from './detection'
import { loadDetectorSettings } from './detector-settings'
import { handleAgentBridgeHello, validateAgentCaptureControlMessage, validateStartAgentCaptureMessage } from './agent-bridge-session'
import { withTabWriteLock } from './tab-write-lock'
import { checkPageSupport, isDetectablePageUrl } from '@/utils/page-support'

const clearUnsupportedTab = async (tabId: number) => {
  await clearTabSession(tabId)
  clearBadge(tabId)
}

export const registerMessageRouter = () => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false

    if (message.type === 'AGENT_BRIDGE_HELLO') {
      handleAgentBridgeHello(message, sender)
        .then(response => sendResponse(response))
        .catch(error => sendResponse({ ok: false, error: { code: 'INVALID_REQUEST', message: String(error) } }))
      return true
    }

    if (message.type === 'START_AGENT_CAPTURE') {
      const validated = validateStartAgentCaptureMessage(message, sender)
      if (!validated.ok) {
        sendResponse({ ok: false, error: validated.error })
        return false
      }
      sendResponse({ ok: true, data: null })
      return false
    }

    if (message.type === 'AGENT_CAPTURE_CONTROL') {
      const validated = validateAgentCaptureControlMessage(message, sender)
      if (!validated.ok) {
        sendResponse({ ok: false, error: validated.error })
        return false
      }
      sendResponse({ ok: true, data: null })
      return false
    }

    if (message.type === 'GET_HEADER_DATA') {
      Promise.all([getTabData(message.tabId), loadDetectorSettings()])
        .then(([data, settings]) => sendResponse({ ok: true, data: addStoredCustomHeaderRules(data, settings) }))
        .catch(error => sendResponse({ ok: false, error: String(error) }))
      return true
    }

    if (message.type === 'GET_POPUP_RESULT') {
      const tabId = Number(message.tabId)
      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ ok: false, error: '缺少有效 tabId' })
        return false
      }
      getPopupResultResponse(tabId)
        .then(response => sendResponse(response))
        .catch(error => sendResponse({ ok: false, error: String(error) }))
      return true
    }

    if (message.type === 'GET_POPUP_RAW_RESULT') {
      const tabId = Number(message.tabId)
      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ ok: false, error: '缺少有效 tabId' })
        return false
      }
      getTabSnapshot(tabId)
        .then(async tab => {
          const support = checkPageSupport(tab.url)
          if (!support.supported) {
            await clearUnsupportedTab(tabId)
            throw new Error(support.reason)
          }
          const [data, settings] = await Promise.all([getTabData(tabId), loadDetectorSettings()])
          return buildPopupRawResult(addStoredCustomHeaderRules(data, settings), settings, tab)
        })
        .then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: String(error) }))
      return true
    }

    if (message.type === 'GET_TECH_LINK') {
      loadDetectorSettings()
        .then(settings => getTechnologyUrl(message.name, settings))
        .then(url => sendResponse({ ok: true, url }))
        .catch(error => sendResponse({ ok: false, error: String(error), url: '' }))
      return true
    }

    if (message.type === 'START_BACKGROUND_DETECTION') {
      const tabId = Number(message.tabId)
      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ ok: false, error: '缺少有效 tabId' })
        return false
      }
      sendResponse({ ok: true })
      getTabSnapshot(tabId)
        .then(tab => {
          if (!isDetectablePageUrl(tab.url)) {
            return clearUnsupportedTab(tabId)
          }
          return runActivePageDetection(tabId, { force: true })
        })
        .catch(() => {})
      return false
    }

    if (message.type === 'GET_WORDPRESS_THEME_DETAILS') {
      detectWordPressThemeStylesFromPage(message.page)
        .then(technologies => sendResponse({ ok: true, technologies: cleanTechnologyRecords(technologies) }))
        .catch(error => sendResponse({ ok: false, error: String(error), technologies: [] }))
      return true
    }

    if (message.type === 'DYNAMIC_PAGE_SNAPSHOT') {
      const tabId = sender.tab?.id
      if (typeof tabId !== 'number' || tabId < 0) {
        sendResponse({ ok: false, error: '缺少有效 tabId' })
        return false
      }
      getTabSnapshot(tabId)
        .then(tab => {
          if (!isDetectablePageUrl(tab.url)) {
            return clearUnsupportedTab(tabId).then(() => false)
          }
          queueDynamicSnapshot(tabId, message.snapshot)
          return true
        })
        .then(queued => sendResponse({ ok: true, queued }))
        .catch(error => sendResponse({ ok: false, error: String(error) }))
      return true
    }

    if (message.type === 'PAGE_DETECTION_RESULT') {
      const tabId = Number(message.tabId)
      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ ok: false, error: '缺少有效 tabId' })
        return false
      }
      Promise.all([loadDetectorSettings(), getTabSnapshot(tabId)])
        .then(async ([settings, tab]) => {
          if (!isDetectablePageUrl(tab.url)) {
            await clearUnsupportedTab(tabId)
            return
          }
          const page = await augmentPageWithWordPressThemeStyles(message.page)
          const freshClean = cleanPageDetectionRecord(page)
          // 进 per-tab 锁:跟 detection / dynamic / bundle / webRequest 串行,避免互相覆盖字段
          await withTabWriteLock(tabId, async () => {
            const latest = (await getTabData(tabId)) || {}
            latest.page = mergePageDetectionRecord(latest.page, freshClean)
            latest.updatedAt = Date.now()
            await saveTabDataAndBadge(tabId, latest, settings)
          })
        })
        .then(() => sendResponse({ ok: true }))
        .catch(error => sendResponse({ ok: false, error: String(error) }))
      return true
    }

    return false
  })
}
