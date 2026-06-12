import { augmentPageWithWordPressThemeStyles } from './wordpress'
import { buildPopupCacheRecord, cleanPageDetectionRecord, mergePageDetectionRecord } from './popup-cache'
import { fetchMainHeadersFallback, mergeHeaderRecords } from './headers'
import { clearBadge, clearTabSession, getTabData, getTabSnapshot, updateBadgeForTab, writeTabData } from './tab-store'
import { buildEffectivePageRules, loadDetectorSettings, loadTechRules } from './detector-settings'
import { scheduleBundleLicenseDetection } from './bundle-license'
import { injectContentObserver } from './content-injector'
import { isScriptFileLoadError } from './script-injection-errors'
import { withTabWriteLock } from './tab-write-lock'
import { isDetectablePageUrl } from '@/utils/page-support'
import { detectPageTechnologies } from '@/injected/page-detector-runtime'

const activeDetectionTimers = new Map<number, ReturnType<typeof setTimeout>>()
const lastDetectionRunAt = new Map<number, number>()
const DETECTION_THROTTLE_MS = 30000
type DetectionTabSnapshot = { url?: string }

const normalizePageUrl = (value: unknown): string => {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

const needsMainHeadersFallback = (record: any, currentUrl: string): boolean => {
  if (!record) return true
  const recordUrl = normalizePageUrl(record.url)
  const tabUrl = normalizePageUrl(currentUrl)
  if (recordUrl && tabUrl && recordUrl !== tabUrl) return true
  return Number(record.headerCount || 0) <= 1 && !Object.keys(record.headers || {}).length && !(record.technologies || []).length
}

const headerRecordMatchesUrl = (record: any, currentUrl: string): boolean => {
  const recordUrl = normalizePageUrl(record?.url)
  const tabUrl = normalizePageUrl(currentUrl)
  return Boolean(recordUrl && tabUrl && recordUrl === tabUrl)
}

const headerRecordSharesPagePath = (record: any, currentUrl: string): boolean => {
  try {
    const recordUrl = new URL(String(record?.url || ''))
    const tabUrl = new URL(String(currentUrl || ''))
    return recordUrl.origin === tabUrl.origin && recordUrl.pathname === tabUrl.pathname
  } catch {
    return false
  }
}

const hasUsefulHeaderRecord = (record: any): boolean =>
  Boolean(record && (Number(record.headerCount || 0) > 1 || Object.keys(record.headers || {}).length || (record.technologies || []).length))

const shouldPreserveMainHeaderRecord = (record: any, currentUrl: string): boolean =>
  headerRecordMatchesUrl(record, currentUrl) || (headerRecordSharesPagePath(record, currentUrl) && hasUsefulHeaderRecord(record))

export const saveTabDataAndBadge = async (tabId: number, data: any, settings: any) => {
  const tab = await getTabSnapshot(tabId)
  if (!isDetectablePageUrl(tab.url)) {
    await clearTabSession(tabId)
    clearBadge(tabId)
    return
  }
  const popup = await buildPopupCacheRecord(data, settings, tab)
  const { popup: _legacyPopup, ...tabData } = data || {}
  await writeTabData(tabId, tabData, popup)
  await updateBadgeForTab(tabId, popup)
}

export const refreshAllBadges = async () => {
  try {
    const [tabs, settings] = await Promise.all([chrome.tabs.query({}), loadDetectorSettings()])
    for (const tab of tabs) {
      if (typeof tab.id !== 'number' || tab.id < 0) continue
      if (!isDetectablePageUrl(tab.url)) {
        await clearTabSession(tab.id)
        clearBadge(tab.id)
        continue
      }
      const data = await getTabData(tab.id)
      if (data && Object.keys(data).length) {
        await saveTabDataAndBadge(tab.id, data, settings)
      } else {
        clearBadge(tab.id)
      }
    }
  } catch {
    return
  }
}

const withAgentDetectionDeadline = async <T>(operation: Promise<T>, deadlineAt?: number): Promise<T> => {
  if (deadlineAt === undefined) return operation
  if (!Number.isFinite(deadlineAt)) throw new Error('INVALID_DEADLINE')
  const timeoutMs = deadlineAt - Date.now()
  if (timeoutMs <= 0) throw new Error('TARGET_LOAD_TIMEOUT')
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('TARGET_LOAD_TIMEOUT')), timeoutMs)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const getFrameInjectionError = (results: chrome.scripting.InjectionResult[] | undefined): unknown =>
  (results as Array<{ error?: unknown }> | undefined)?.find(result => result.error !== undefined)?.error

const executePageDetection = async (
  tabId: number,
  tab: DetectionTabSnapshot,
  deadlineAt?: number,
  options: { failOnContentObserverError?: boolean } = {}
): Promise<any> => {
  await withAgentDetectionDeadline(injectContentObserver(tabId, { failOnError: options.failOnContentObserverError }), deadlineAt)
  // 这里不再预读 data —— page-detector 注入要 500ms+,期间其他 writer 会写过 storage;
  // 等 detector 跑完再统一 re-read 最新 data 再做合并写回
  const [rules, settings] = await withAgentDetectionDeadline(Promise.all([loadTechRules(), loadDetectorSettings()]), deadlineAt)
  const pageRules = buildEffectivePageRules(rules.page || {}, settings)
  await withAgentDetectionDeadline(
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: r => {
        ;(window as any).__SP_RULES__ = r
      },
      args: [pageRules]
    }),
    deadlineAt
  )
  let page: any = null
  try {
    try {
      const injection = await withAgentDetectionDeadline(
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: ['injected/page-detector.iife.js']
        }),
        deadlineAt
      )
      const frameError = getFrameInjectionError(injection)
      if (frameError) throw new Error(String(frameError))
      page = await injection?.[0]?.result
    } catch (error) {
      if (!isScriptFileLoadError(error)) throw error
      const fallback = await withAgentDetectionDeadline(
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: detectPageTechnologies,
          args: [pageRules]
        }),
        deadlineAt
      )
      const frameError = getFrameInjectionError(fallback)
      if (frameError) throw new Error(String(frameError))
      page = await fallback?.[0]?.result
    }
  } finally {
    await withAgentDetectionDeadline(
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          try {
            delete (window as any).__SP_RULES__
          } catch {
            ;(window as any).__SP_RULES__ = undefined
          }
        }
      }),
      deadlineAt
    ).catch(() => {})
  }
  if (!page) throw new Error('TARGET_INJECTION_FAILED')

  const augmentedPage = await augmentPageWithWordPressThemeStyles(page)
  const freshClean = cleanPageDetectionRecord(augmentedPage)
  let fallbackForMain: any = null
  const pageUrl = (augmentedPage as any).url || tab.url || ''
  const needsFallback = await withTabWriteLock(tabId, async () => {
    const peek = (await getTabData(tabId)) || {}
    return needsMainHeadersFallback(peek.main, pageUrl)
  })
  if (needsFallback) {
    fallbackForMain = await withAgentDetectionDeadline(fetchMainHeadersFallback(pageUrl, rules.headers || {}, settings), deadlineAt)
  }

  await withTabWriteLock(tabId, async () => {
    const latest = (await getTabData(tabId)) || {}
    latest.page = mergePageDetectionRecord(latest.page, freshClean)
    if (needsMainHeadersFallback(latest.main, pageUrl)) {
      if (fallbackForMain) {
        latest.main = shouldPreserveMainHeaderRecord(latest.main, pageUrl)
          ? mergeHeaderRecords(latest.main, fallbackForMain)
          : fallbackForMain
      } else if (latest.main && !shouldPreserveMainHeaderRecord(latest.main, pageUrl)) {
        delete latest.main
      }
    }
    latest.updatedAt = Date.now()
    await saveTabDataAndBadge(tabId, latest, settings)
  })
  scheduleBundleLicenseDetection(tabId)
  return freshClean
}

export const runActivePageDetection = async (tabId: number, options: { force?: boolean } = {}) => {
  if (typeof tabId !== 'number' || tabId < 0) return

  try {
    const tab = await getTabSnapshot(tabId)
    if (!isDetectablePageUrl(tab.url)) {
      await clearTabSession(tabId)
      clearBadge(tabId)
      return
    }
    if (!options.force) {
      const last = lastDetectionRunAt.get(tabId) || 0
      if (last && Date.now() - last < DETECTION_THROTTLE_MS) {
        console.log('[SP detection] run skipped (throttle)', tabId, 'sinceLast', Date.now() - last + 'ms')
        return
      }
    }
    lastDetectionRunAt.set(tabId, Date.now())
    console.log('[SP detection] run start', tabId, 'force:', Boolean(options.force))
    await executePageDetection(tabId, tab)
  } catch {
    return
  }
}

export const runAgentPageDetection = async (tabId: number, deadlineAt?: number): Promise<any> => {
  if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) throw new Error('INVALID_DEADLINE')
  const tab = await getTabSnapshot(tabId)
  if (!isDetectablePageUrl(tab.url)) {
    throw new Error('TARGET_LOAD_FAILED')
  }
  return executePageDetection(tabId, tab, deadlineAt, { failOnContentObserverError: true })
}

export const clearActiveDetectionTimer = (tabId: number) => {
  const timer = activeDetectionTimers.get(tabId)
  if (timer) {
    clearTimeout(timer)
    activeDetectionTimers.delete(tabId)
  }
}

export const clearDetectionThrottle = (tabId: number) => {
  lastDetectionRunAt.delete(tabId)
}

export const scheduleActivePageDetection = (tabId: number, delay = 600) => {
  if (typeof tabId !== 'number' || tabId < 0) return
  if (activeDetectionTimers.has(tabId)) return
  const last = lastDetectionRunAt.get(tabId) || 0
  if (last && Date.now() - last < DETECTION_THROTTLE_MS) {
    console.log('[SP detection] schedule skipped (throttle)', tabId, 'sinceLast', Date.now() - last + 'ms')
    return
  }
  console.log('[SP detection] schedule', tabId, 'delay', delay + 'ms')
  clearActiveDetectionTimer(tabId)
  const timer = setTimeout(() => {
    activeDetectionTimers.delete(tabId)
    runActivePageDetection(tabId)
  }, delay)
  activeDetectionTimers.set(tabId, timer)
}
