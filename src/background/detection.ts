import { augmentPageWithWordPressThemeStyles } from './wordpress'
import { buildPopupCacheRecord, cleanPageDetectionRecord, mergePageDetectionRecord } from './popup-cache'
import { fetchMainHeadersFallback, mergeHeaderRecords } from './headers'
import { clearBadge, clearTabSession, getTabData, getTabSnapshot, updateBadgeForTab, writeTabData } from './tab-store'
import { buildEffectivePageRules, loadDetectorSettings, loadTechRules } from './detector-settings'
import { scheduleBundleLicenseDetection } from './bundle-license'
import { injectContentObserver } from './content-injector'
import { withTabWriteLock } from './tab-write-lock'
import { isDetectablePageUrl } from '@/utils/page-support'

const activeDetectionTimers = new Map<number, ReturnType<typeof setTimeout>>()
const lastDetectionRunAt = new Map<number, number>()
const DETECTION_THROTTLE_MS = 30000

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
    await injectContentObserver(tabId)
    // 这里不再预读 data —— page-detector 注入要 500ms+,期间其他 writer 会写过 storage;
    // 等 detector 跑完再统一 re-read 最新 data 再做合并写回
    const [rules, settings] = await Promise.all([loadTechRules(), loadDetectorSettings()])
    const pageRules = buildEffectivePageRules(rules.page || {}, settings)
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: r => {
        ;(window as any).__SP_RULES__ = r
      },
      args: [pageRules]
    })
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['injected/page-detector.iife.js']
    })
    const page = await injection?.[0]?.result
    if (!page) return

    const augmentedPage = await augmentPageWithWordPressThemeStyles(page)
    const freshClean = cleanPageDetectionRecord(augmentedPage)

    // 进 per-tab 锁:read-modify-write 段必须跟其他 writer 串行,避免 dynamic/bundle/headers 并发读到同一份旧快照,
    // 互相把对方刚写好的字段覆盖掉(popup 上数字回落)
    let fallbackForMain: any = null
    const needsFallback = await withTabWriteLock(tabId, async () => {
      const peek = (await getTabData(tabId)) || {}
      return needsMainHeadersFallback(peek.main, (page as any).url || tab.url)
    })
    if (needsFallback) {
      fallbackForMain = await fetchMainHeadersFallback((page as any).url || '', rules.headers || {}, settings)
    }

    await withTabWriteLock(tabId, async () => {
      const latest = (await getTabData(tabId)) || {}
      latest.page = mergePageDetectionRecord(latest.page, freshClean)

      if (needsMainHeadersFallback(latest.main, (page as any).url || tab.url)) {
        if (fallbackForMain) {
          latest.main = shouldPreserveMainHeaderRecord(latest.main, (page as any).url || tab.url)
            ? mergeHeaderRecords(latest.main, fallbackForMain)
            : fallbackForMain
        } else if (latest.main && !shouldPreserveMainHeaderRecord(latest.main, (page as any).url || tab.url)) {
          delete latest.main
        }
      }

      latest.updatedAt = Date.now()
      await saveTabDataAndBadge(tabId, latest, settings)
    })
    scheduleBundleLicenseDetection(tabId)
  } catch {
    return
  }
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
