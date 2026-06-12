import { getPreviousActiveTab } from './active-tab-tracker'
import { normalizeComparableUrl } from './agent-capture-request'
import { clearBundleLicenseTimer } from './bundle-license'
import { clearDetectionThrottle, scheduleActivePageDetection } from './detection'
import { clearDynamicSnapshotState } from './dynamic-snapshot'
import { clearBadge, clearTabSession } from './tab-store'
import type { AgentCaptureRequest } from '@/types/agent-bridge'
import type { AgentBridgeError, AgentCaptureScreenshot } from '@/types/agent-bridge'
import { makeAgentCaptureError } from './agent-capture-common'
import { logBackgroundError } from './logging'
import { isScriptFileLoadError } from './script-injection-errors'
import { isDetectablePageUrl } from '@/utils/page-support'

const TARGET_LOAD_TIMEOUT_REPORTING_GRACE_MS = 5000
const MAX_TARGET_LOAD_WAIT_MS = 60000
const RELOAD_COMPLETE_WITHOUT_LOADING_GRACE_MS = 500
const ORDINARY_DETECTION_RESTORE_DELAY_MS = 600
const SCREENSHOT_QUALITY = 72
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const SCREENSHOT_CAPTURE_RETRY_DELAYS_MS = [250, 750, 1500, 2500]
const TAB_ACTIVATION_RETRY_DELAYS_MS = [0, 150, 500, 1000]

export const cleanForCapture = async (tabId: number): Promise<void> => {
  clearBundleLicenseTimer(tabId)
  clearDynamicSnapshotState(tabId)
  await clearTabSession(tabId)
  clearBadge(tabId)
}

export const cleanupTarget = async (state: { targetTabId?: number; createdByCapture?: boolean; keepTabOpen?: boolean }): Promise<void> => {
  if (typeof state.targetTabId !== 'number') return
  if (state.createdByCapture) {
    await cleanForCapture(state.targetTabId)
  }
  if (state.createdByCapture && !state.keepTabOpen) {
    await chrome.tabs.remove(state.targetTabId)
  }
}

export const restoreOrdinaryDetectionForRetainedTarget = async (state: {
  targetTabId?: number
  createdByCapture?: boolean
  keepTabOpen?: boolean
  phase?: string
}): Promise<void> => {
  const tabId = state.targetTabId
  if (typeof tabId !== 'number' || !Number.isInteger(tabId)) return
  if (state.createdByCapture === true) {
    if (state.keepTabOpen !== true) return
  } else if (state.phase === 'target_opening') {
    return
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab || !isDetectablePageUrl(tab.url)) return
  clearDetectionThrottle(tabId)
  scheduleActivePageDetection(tabId, ORDINARY_DETECTION_RESTORE_DELAY_MS)
}

const findReusableTab = async (targetUrl: string): Promise<chrome.tabs.Tab | null> => {
  const tabs = await chrome.tabs.query({})
  return tabs.find(tab => !tab.incognito && normalizeComparableUrl(tab.url) === targetUrl) || null
}

type TargetResolution = { ok: true; tab: chrome.tabs.Tab; createdByCapture: boolean } | { ok: false; error: AgentBridgeError }

export const resolveTargetTab = async (request: AgentCaptureRequest, bridgeWindowId: number): Promise<TargetResolution> => {
  if (request.options.targetMode === 'active_tab') {
    return resolveActiveTargetTab(request, bridgeWindowId)
  }
  if (request.options.targetMode === 'reuse_or_new_tab') {
    const reusable = await findReusableTab(request.url)
    if (reusable) return { ok: true, tab: reusable, createdByCapture: false }
  }
  const tab = await chrome.tabs.create({ url: request.url, active: false, windowId: bridgeWindowId })
  if (tab.incognito) {
    if (typeof tab.id === 'number') {
      await chrome.tabs.remove(tab.id).catch(error => logBackgroundError('incognito target tab cleanup failed', { tabId: tab.id, error }))
    }
    return { ok: false, error: makeAgentCaptureError('INCOGNITO_NOT_SUPPORTED', 'Incognito tabs are not supported.') }
  }
  return { ok: true, tab, createdByCapture: true }
}

const resolveActiveTargetTab = async (request: AgentCaptureRequest, bridgeWindowId: number): Promise<TargetResolution> => {
  const active = await getPreviousActiveTab(bridgeWindowId)
  if (!active) {
    return { ok: false, error: makeAgentCaptureError('ACTIVE_TAB_UNAVAILABLE', 'Previous active tab is unavailable.') }
  }
  try {
    const tab = await chrome.tabs.get(active.tabId)
    if (tab.incognito) {
      return { ok: false, error: makeAgentCaptureError('INCOGNITO_NOT_SUPPORTED', 'Incognito tabs are not supported.') }
    }
    if (normalizeComparableUrl(tab.url) !== request.url) {
      return { ok: false, error: makeAgentCaptureError('ACTIVE_TAB_MISMATCH', 'Previous active tab URL does not match target URL.') }
    }
    return { ok: true, tab, createdByCapture: false }
  } catch {
    return { ok: false, error: makeAgentCaptureError('ACTIVE_TAB_UNAVAILABLE', 'Previous active tab was closed.') }
  }
}

export const waitForTargetTabLoaded = async (tabId: number, deadlineAt: number): Promise<chrome.tabs.Tab> => {
  const current = await chrome.tabs.get(tabId)
  if (current.status === 'complete') return current
  const timeoutMs = Math.max(0, Math.min(deadlineAt - Date.now() - TARGET_LOAD_TIMEOUT_REPORTING_GRACE_MS, MAX_TARGET_LOAD_WAIT_MS))
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      chrome.tabs.onUpdated?.removeListener?.(listener)
      chrome.tabs.onRemoved?.removeListener?.(removedListener)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (updatedTabId !== tabId) return
      if (changeInfo.status === 'complete' || tab.status === 'complete') {
        finish(() => resolve(tab))
      }
    }
    const removedListener = (removedTabId: number) => {
      if (removedTabId === tabId) finish(() => reject(new Error('TARGET_TAB_CLOSED')))
    }
    chrome.tabs.onUpdated?.addListener?.(listener)
    chrome.tabs.onRemoved?.addListener?.(removedListener)
    timeout = setTimeout(() => finish(() => reject(new Error('TARGET_LOAD_TIMEOUT'))), timeoutMs)
    chrome.tabs
      .get(tabId)
      .then(tab => {
        if (tab.status === 'complete') finish(() => resolve(tab))
      })
      .catch(error => finish(() => reject(error)))
  })
}

export const reloadTargetTabBypassingCache = async (tabId: number, deadlineAt: number): Promise<chrome.tabs.Tab> => {
  if (!chrome.tabs.reload) return waitForTargetTabLoaded(tabId, deadlineAt)
  const initialTab = await chrome.tabs.get(tabId)
  const initialUrl = normalizeComparableUrl(initialTab.url)
  const timeoutMs = Math.max(0, Math.min(deadlineAt - Date.now() - TARGET_LOAD_TIMEOUT_REPORTING_GRACE_MS, MAX_TARGET_LOAD_WAIT_MS))
  return new Promise((resolve, reject) => {
    let settled = false
    let reloadStarted = false
    let reloadCommandSettled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let completeWithoutLoadingTimer: ReturnType<typeof setTimeout> | null = null
    const clearCompleteWithoutLoadingTimer = () => {
      if (!completeWithoutLoadingTimer) return
      clearTimeout(completeWithoutLoadingTimer)
      completeWithoutLoadingTimer = null
    }
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      clearCompleteWithoutLoadingTimer()
      chrome.tabs.onUpdated?.removeListener?.(listener)
      chrome.tabs.onRemoved?.removeListener?.(removedListener)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (updatedTabId !== tabId) return
      if (changeInfo.status === 'loading') {
        clearCompleteWithoutLoadingTimer()
        reloadStarted = true
        return
      }
      if (changeInfo.status !== 'complete') return
      if (!reloadCommandSettled && !reloadStarted) return
      if (reloadStarted) {
        finish(() => resolve(tab))
        return
      }
      const completedUrl = normalizeComparableUrl(tab.url)
      if (completedUrl && initialUrl && completedUrl !== initialUrl) {
        finish(() => resolve(tab))
        return
      }
      if (completeWithoutLoadingTimer) return
      completeWithoutLoadingTimer = setTimeout(
        () => finish(() => resolve(tab)),
        RELOAD_COMPLETE_WITHOUT_LOADING_GRACE_MS
      )
    }
    const removedListener = (removedTabId: number) => {
      if (removedTabId === tabId) finish(() => reject(new Error('TARGET_TAB_CLOSED')))
    }
    chrome.tabs.onUpdated?.addListener?.(listener)
    chrome.tabs.onRemoved?.addListener?.(removedListener)
    timeout = setTimeout(() => finish(() => reject(new Error('TARGET_LOAD_TIMEOUT'))), timeoutMs)
    chrome.tabs
      .reload(tabId, { bypassCache: true })
      .then(() => {
        reloadCommandSettled = true
      })
      .catch(error => finish(() => reject(error)))
  })
}

const getFrameInjectionError = (results: chrome.scripting.InjectionResult[] | undefined): unknown =>
  (results as Array<{ error?: unknown }> | undefined)?.find(result => result.error !== undefined)?.error

const collectInlineExperienceProfile = (profilerOptions: { captureScreenshotMetadata?: boolean } = {}) => {
  const includeGeometry = profilerOptions.captureScreenshotMetadata === true
  const cleanText = (value: unknown, limit = 140): string =>
    String(value ?? '')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
      .replace(/\b(?:\+?\d[\d\s-]{8,}\d|\d{11,})\b/g, '[redacted]')
      .replace(/(?:[￥$€£]\s*\d+(?:\.\d+)?)/g, '[redacted]')
      .replace(
        /\b([A-Za-z0-9_-]*(?:token|secret|session|auth|authorization|key|signature|password|pass|cookie)[A-Za-z0-9_-]*)\s*[:=]\s*(?:Bearer\s+)?[^,\s;&]+/gi,
        '$1=[redacted]'
      )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit)
  const sensitivePathWordPattern = /^(?:token|secret|session|auth|authorization|signature|password|cookie|passcode)$/i
  const sensitivePathShortTokenPattern = /(?:^|[-_.])(?:key|pass)(?:$|[-_.])/i
  const sensitivePathCompoundPattern =
    /^(?:(?:api|access|private|public|secret|session|auth|token)[-_.]?(?:key|pass|token|secret|signature|code|id)|(?:key|pass|token)[-_.]?(?:token|secret|signature|code|id)|(?:reset|verify|access|auth|session|csrf|xsrf)[-_.]?(?:token|code|secret|key|signature))$/i
  const sensitivePathCamelPattern =
    /^(?:apiKey|privateKey|publicKey|accessToken|refreshToken|sessionId|secretToken|authToken|csrfToken|xsrfToken)$/i
  const highEntropyPathSegmentPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9_-]{24,}$/
  const pathSegmentStem = (segment: string): string => segment.replace(/\.[A-Za-z0-9]{1,8}$/i, '')
  const isSensitivePathSegment = (segment: string): boolean => {
    const stem = pathSegmentStem(segment)
    return (
      sensitivePathWordPattern.test(segment) ||
      sensitivePathWordPattern.test(stem) ||
      sensitivePathShortTokenPattern.test(segment) ||
      sensitivePathShortTokenPattern.test(stem) ||
      sensitivePathCompoundPattern.test(segment) ||
      sensitivePathCompoundPattern.test(stem) ||
      sensitivePathCamelPattern.test(segment) ||
      sensitivePathCamelPattern.test(stem) ||
      /^[0-9a-f]{16,}$/i.test(stem) ||
      highEntropyPathSegmentPattern.test(stem) ||
      segment.includes('=')
    )
  }
  const redactPathname = (pathname: string): string =>
    pathname
      .split('/')
      .map(segment => (segment && isSensitivePathSegment(segment) ? '[redacted]' : segment))
      .join('/')
  const safeRect = (element: Element) => {
    try {
      const rect = element.getBoundingClientRect()
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    } catch {
      return null
    }
  }
  const safeUrl = (value: unknown): string => {
    try {
      const url = new URL(String(value || ''), location.href)
      if (!/^https?:$/i.test(url.protocol)) return ''
      url.username = ''
      url.password = ''
      url.hash = ''
      url.pathname = redactPathname(url.pathname)
      for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, '[redacted]')
      return url.toString()
    } catch {
      return ''
    }
  }
  const nodes = [...document.querySelectorAll('body *')].slice(0, 240)
  const textSamples: string[] = []
  const assets: string[] = []
  const samples = nodes
    .filter(element => ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM', 'NAV', 'HEADER', 'MAIN', 'FOOTER', 'SECTION'].includes(element.tagName))
    .slice(0, 40)
    .map(element => {
      const text = cleanText(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '', 100)
      if (text && textSamples.length < 40 && !textSamples.includes(text)) textSamples.push(text)
      return {
        tag: element.tagName.toLowerCase(),
        text,
        role: cleanText(element.getAttribute('role') || '', 40),
        ...(includeGeometry ? { rect: safeRect(element) } : {})
      }
    })
  for (const element of [...document.querySelectorAll('img[src], script[src], link[href]')].slice(0, 120)) {
    const value = (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || (element as HTMLLinkElement).href
    const clean = safeUrl(value)
    if (clean && !assets.includes(clean)) assets.push(clean)
  }
  if (!textSamples.length) {
    const bodyText = cleanText(document.body?.textContent || '', 600)
    if (bodyText) textSamples.push(bodyText)
  }
  return {
    visual: {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    },
    layout: { landmarks: samples.filter(sample => ['nav', 'header', 'main', 'footer', 'section'].includes(sample.tag)) },
    components: { samples, counts: { sampled: samples.length } },
    interaction: { passive: true, links: document.querySelectorAll('a[href]').length, buttons: document.querySelectorAll('button').length },
    ux: { textSamples, pagePurpose: [], primaryUserPath: [], informationHierarchy: [] },
    document: { language: cleanText(document.documentElement.lang || document.body?.getAttribute('lang') || '', 40) },
    assets: { urls: assets },
    evidence: { truncation: { domNodes: Math.max(0, document.querySelectorAll('body *').length - nodes.length), resourceUrls: 0 } },
    limitations: ['passive_interaction_only', 'firefox_inline_experience_profile']
  }
}

export const executeExperienceProfiler = async (
  tabId: number,
  options: { captureScreenshotMetadata: boolean } = { captureScreenshotMetadata: false }
): Promise<any> => {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: profilerOptions => {
      ;(globalThis as any).__STACKPRISM_EXPERIENCE_OPTIONS__ = profilerOptions
    },
    args: [{ captureScreenshotMetadata: options.captureScreenshotMetadata === true }]
  })
  try {
    try {
      const injection = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['injected/experience-profiler.iife.js']
      })
      const frameError = getFrameInjectionError(injection)
      if (frameError) throw new Error(String(frameError))
      return injection?.[0]?.result || null
    } catch (error) {
      if (!isScriptFileLoadError(error)) throw error
      const fallback = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: collectInlineExperienceProfile,
        args: [{ captureScreenshotMetadata: options.captureScreenshotMetadata === true }]
      })
      const frameError = getFrameInjectionError(fallback)
      if (frameError) throw new Error(String(frameError))
      return fallback?.[0]?.result || null
    }
  } finally {
    await chrome.scripting
      .executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          delete (globalThis as any).__STACKPRISM_EXPERIENCE_OPTIONS__
        }
      })
      .catch(() => {})
  }
}

type ScreenshotCaptureResult = { screenshot: AgentCaptureScreenshot | null; limitations: string[] }

const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,'

const base64DecodedByteLength = (value: string): number | null => {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.floor((value.length * 3) / 4) - padding
}

const jpegDataUrlByteLength = (value: string): number | null => {
  if (!value.startsWith(JPEG_DATA_URL_PREFIX)) return null
  return base64DecodedByteLength(value.slice(JPEG_DATA_URL_PREFIX.length))
}

const waitForDelay = (delayMs: number): Promise<void> => new Promise(resolve => setTimeout(resolve, delayMs))

const waitForTabActive = async (tabId: number): Promise<boolean> => {
  for (const delayMs of TAB_ACTIVATION_RETRY_DELAYS_MS) {
    if (delayMs > 0) await waitForDelay(delayMs)
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (tab?.active === true) return true
  }
  return false
}

const focusCaptureWindow = async (windowId: number): Promise<void> => {
  await chrome.windows?.update?.(windowId, { focused: true }).catch(() => {})
}

const captureVisibleTabDataUrl = async (windowId: number): Promise<string> => {
  let lastError: unknown = null
  for (const delayMs of SCREENSHOT_CAPTURE_RETRY_DELAYS_MS) {
    if (delayMs > 0) await waitForDelay(delayMs)
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: SCREENSHOT_QUALITY })
    } catch (caught) {
      lastError = caught
    }
  }
  throw lastError
}

export const captureVisibleViewportScreenshot = async (
  tabId: number,
  windowId: number,
  restoreTabId?: number
): Promise<ScreenshotCaptureResult> => {
  if (!chrome.tabs.captureVisibleTab) return { screenshot: null, limitations: ['screenshot_capture_unavailable'] }
  const activeTabs = await chrome.tabs.query({ active: true, windowId }).catch(() => [])
  const previousActiveTabId = activeTabs.find(tab => tab.active)?.id ?? activeTabs[0]?.id
  const tabToRestore = restoreTabId ?? previousActiveTabId
  try {
    await focusCaptureWindow(windowId)
    if (previousActiveTabId !== tabId) await chrome.tabs.update(tabId, { active: true })
    if (!(await waitForTabActive(tabId))) throw new Error('SCREENSHOT_TARGET_NOT_ACTIVE')
    const dataUrl = await captureVisibleTabDataUrl(windowId)
    if (typeof dataUrl !== 'string') {
      return { screenshot: null, limitations: ['screenshot_capture_invalid'] }
    }
    const byteLength = jpegDataUrlByteLength(dataUrl)
    if (byteLength === null) {
      return { screenshot: null, limitations: ['screenshot_capture_invalid'] }
    }
    if (byteLength > MAX_SCREENSHOT_BYTES) {
      return { screenshot: null, limitations: ['screenshot_image_too_large'] }
    }
    return {
      screenshot: {
        dataUrl,
        mimeType: 'image/jpeg',
        byteLength,
        source: 'chrome.tabs.captureVisibleTab',
        scope: 'visible_viewport',
        capturedAt: new Date().toISOString()
      },
      limitations: []
    }
  } catch (caught) {
    logBackgroundError('Agent screenshot capture failed', { tabId, error: caught })
    return { screenshot: null, limitations: ['screenshot_capture_failed'] }
  } finally {
    if (typeof tabToRestore === 'number' && tabToRestore !== tabId) {
      await chrome.tabs.update(tabToRestore, { active: true }).catch(caught =>
        logBackgroundError('Agent screenshot tab restore failed', { tabId: tabToRestore, error: caught })
      )
    }
  }
}

export const getAgentCaptureUserAgent = (): string =>
  typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' ? navigator.userAgent : ''

export const getExtensionVersion = (): string => {
  try {
    return chrome.runtime.getManifest().version || ''
  } catch {
    return ''
  }
}
