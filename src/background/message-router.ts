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
import { handleAgentBridgeHello, validateAgentCaptureControlMessage } from './agent-bridge-session'
import { cancelAgentCapture, registerAgentProfileTransferPort, startAgentCapture } from './agent-capture'
import { isAgentBridgeRequestForTab, isAgentBridgeTab } from './agent-bridge-tabs'
import { withTabWriteLock } from './tab-write-lock'
import { logBackgroundError } from './logging'
import { checkPageSupport, isDetectablePageUrl } from '@/utils/page-support'
import type { AgentBridgeError } from '@/types/agent-bridge'

const clearUnsupportedTab = async (tabId: number) => {
  await clearTabSession(tabId)
  clearBadge(tabId)
}

const tabIdMessages = new Set([
  'GET_HEADER_DATA',
  'GET_POPUP_RESULT',
  'GET_POPUP_RAW_RESULT',
  'START_BACKGROUND_DETECTION',
  'PAGE_DETECTION_RESULT'
])

const ORDINARY_BRIDGE_CACHE_ERROR = 'Agent Bridge 页面不能访问普通检测缓存。'

class OrdinaryBridgeSenderError extends Error {
  constructor(message = ORDINARY_BRIDGE_CACHE_ERROR) {
    super(message)
    this.name = 'OrdinaryBridgeSenderError'
  }
}

const rejectOrdinaryBridgeSender = (message: any, sender: chrome.runtime.MessageSender): string => {
  if (isAgentBridgeTab(sender.tab)) return ORDINARY_BRIDGE_CACHE_ERROR
  if (sender.tab?.id !== undefined && tabIdMessages.has(message.type) && Number(message.tabId) !== sender.tab.id) {
    return 'content script 不能操作其他 tab。'
  }
  return ''
}

const rejectRegisteredBridgeSender = async (sender: chrome.runtime.MessageSender): Promise<string> => {
  const tabId = sender.tab?.id
  if (typeof tabId !== 'number' || tabId < 0) return ''
  const url = sender.url || sender.tab?.url || sender.tab?.pendingUrl || ''
  return (await isAgentBridgeRequestForTab(url, tabId, sender.tab)) ? ORDINARY_BRIDGE_CACHE_ERROR : ''
}

const ensureRegisteredBridgeSenderAllowed = async (sender: chrome.runtime.MessageSender): Promise<void> => {
  const rejected = await rejectRegisteredBridgeSender(sender)
  if (rejected) throw new OrdinaryBridgeSenderError(rejected)
}

const sendOrdinaryMessageError = (sendResponse: (response?: any) => void, error: unknown): void => {
  sendResponse({ ok: false, error: error instanceof OrdinaryBridgeSenderError ? error.message : String(error) })
}

const sendAgentBridgeInternalError = (sendResponse: (response?: any) => void, operation: string, error: unknown): void => {
  logBackgroundError(`${operation} failed`, { error })
  const bridgeError: AgentBridgeError = {
    code: 'INVALID_REQUEST',
    message: 'Agent Bridge request failed.'
  }
  sendResponse({ ok: false, error: bridgeError })
}

const rejectPopupTargetTab = async (tabId: number, sender: chrome.runtime.MessageSender): Promise<string> => {
  if (sender.tab) return ''
  const [tab, snapshot] = await Promise.all([chrome.tabs.get(tabId).catch(() => null), getTabSnapshot(tabId).catch(() => null)])
  const url = tab?.url || tab?.pendingUrl || snapshot?.url || ''
  if (!url) return '目标 tab 不可用。'
  if (tab?.incognito) return '不能读取隐身窗口 tab。'
  if (await isAgentBridgeRequestForTab(url, tabId, { url, pendingUrl: tab?.pendingUrl })) {
    return ORDINARY_BRIDGE_CACHE_ERROR
  }
  const support = checkPageSupport(url)
  return support.supported ? '' : support.reason
}

const runBackgroundDetectionAfterResponse = async (tabId: number): Promise<void> => {
  const tab = await getTabSnapshot(tabId)
  if (!isDetectablePageUrl(tab.url)) {
    await clearUnsupportedTab(tabId)
    return
  }
  await runActivePageDetection(tabId, { force: true })
}

export const registerMessageRouter = () => {
  chrome.runtime.onConnect.addListener(registerAgentProfileTransferPort)

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false

    if (message.type === 'AGENT_BRIDGE_HELLO') {
      handleAgentBridgeHello(message, sender)
        .then(response => sendResponse(response))
        .catch(error => sendAgentBridgeInternalError(sendResponse, 'AGENT_BRIDGE_HELLO', error))
      return true
    }

    if (message.type === 'START_AGENT_CAPTURE') {
      startAgentCapture(message, sender)
        .then(response => sendResponse(response))
        .catch(caught => sendAgentBridgeInternalError(sendResponse, 'START_AGENT_CAPTURE', caught))
      return true
    }

    if (message.type === 'AGENT_CAPTURE_CONTROL') {
      validateAgentCaptureControlMessage(message, sender)
        .then(validated => {
          if (!validated.ok) {
            sendResponse({ ok: false, error: validated.error })
            return
          }
          return cancelAgentCapture(message, sender).then(sendResponse)
        })
        .catch(error => sendAgentBridgeInternalError(sendResponse, 'AGENT_CAPTURE_CONTROL', error))
      return true
    }

    const ordinaryBridgeError = rejectOrdinaryBridgeSender(message, sender)
    if (ordinaryBridgeError) {
      sendResponse({ ok: false, error: ordinaryBridgeError })
      return false
    }

    if (message.type === 'GET_HEADER_DATA') {
      const tabId = Number(message.tabId)
      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ ok: false, error: '缺少有效 tabId' })
        return false
      }
      ensureRegisteredBridgeSenderAllowed(sender)
        .then(() => {
          return rejectPopupTargetTab(tabId, sender)
        })
        .then(rejected => {
          if (rejected) throw new Error(rejected)
          return Promise.all([getTabData(tabId), loadDetectorSettings()])
        })
        .then(([tabData, settings]) => {
          sendResponse({ ok: true, data: addStoredCustomHeaderRules(tabData, settings) })
        })
        .catch(error => sendOrdinaryMessageError(sendResponse, error))
      return true
    }

    if (message.type === 'GET_POPUP_RESULT') {
      const tabId = Number(message.tabId)
      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ ok: false, error: '缺少有效 tabId' })
        return false
      }
      ensureRegisteredBridgeSenderAllowed(sender)
        .then(() => {
          return rejectPopupTargetTab(tabId, sender)
        })
        .then(rejected => {
          if (rejected) throw new Error(rejected)
          return getPopupResultResponse(tabId)
        })
        .then(response => sendResponse(response))
        .catch(error => sendOrdinaryMessageError(sendResponse, error))
      return true
    }

    if (message.type === 'GET_POPUP_RAW_RESULT') {
      const tabId = Number(message.tabId)
      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ ok: false, error: '缺少有效 tabId' })
        return false
      }
      ensureRegisteredBridgeSenderAllowed(sender)
        .then(() => {
          return rejectPopupTargetTab(tabId, sender)
        })
        .then(rejected => {
          if (rejected) throw new Error(rejected)
          return getTabSnapshot(tabId)
        })
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
        .catch(error => sendOrdinaryMessageError(sendResponse, error))
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
      ensureRegisteredBridgeSenderAllowed(sender)
        .then(() => {
          return rejectPopupTargetTab(tabId, sender)
        })
        .then(rejected => {
          if (rejected) throw new Error(rejected)
          sendResponse({ ok: true })
          runBackgroundDetectionAfterResponse(tabId).catch(error =>
            logBackgroundError('runBackgroundDetectionAfterResponse failed', { tabId, error })
          )
        })
        .catch(error => sendOrdinaryMessageError(sendResponse, error))
      return true
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
      ensureRegisteredBridgeSenderAllowed(sender)
        .then(() => {
          return getTabSnapshot(tabId)
        })
        .then(tab => {
          if (!isDetectablePageUrl(tab.url)) {
            return clearUnsupportedTab(tabId).then(() => false)
          }
          queueDynamicSnapshot(tabId, message.snapshot)
          return true
        })
        .then(queued => sendResponse({ ok: true, queued }))
        .catch(error => sendOrdinaryMessageError(sendResponse, error))
      return true
    }

    if (message.type === 'PAGE_DETECTION_RESULT') {
      const tabId = Number(message.tabId)
      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ ok: false, error: '缺少有效 tabId' })
        return false
      }
      ensureRegisteredBridgeSenderAllowed(sender)
        .then(() => {
          return Promise.all([loadDetectorSettings(), getTabSnapshot(tabId)])
        })
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
        .catch(error => sendOrdinaryMessageError(sendResponse, error))
      return true
    }

    return false
  })
}
