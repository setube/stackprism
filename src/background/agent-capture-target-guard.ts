const CAPTURE_TARGET_GUARD_MS = 5000
const guardedTargetTabs = new Map<number, number>()

const isValidTabId = (tabId: unknown): tabId is number => Number.isInteger(tabId) && Number(tabId) >= 0

const pruneExpiredGuards = (now = Date.now()): void => {
  for (const [tabId, expiresAt] of guardedTargetTabs) {
    if (expiresAt <= now) guardedTargetTabs.delete(tabId)
  }
}

export const markAgentCaptureTargetTab = (tabId: unknown): void => {
  if (!isValidTabId(tabId)) return
  pruneExpiredGuards()
  guardedTargetTabs.set(tabId, Date.now() + CAPTURE_TARGET_GUARD_MS)
}

export const clearAgentCaptureTargetTabGuard = (tabId: unknown): void => {
  if (!isValidTabId(tabId)) return
  guardedTargetTabs.delete(tabId)
}

export const isRecentlyAgentCaptureTargetTab = (tabId: unknown): boolean => {
  if (!isValidTabId(tabId)) return false
  pruneExpiredGuards()
  return guardedTargetTabs.has(tabId)
}
