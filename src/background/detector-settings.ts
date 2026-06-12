import { loadStackPrismRules } from './rule-loader'
import { sanitizeLogDetails } from './logging'
import { normalizeSettings, normalizeSettingsWithLocalOptIn } from '@/utils/normalize-settings'

export const SETTINGS_STORAGE_KEY = 'stackPrismSettings'

let techRulesPromise: Promise<any> | null = null
let detectorSettingsPromise: Promise<any> | null = null
let detectorSettingsCache: any = null

export const loadTechRules = async () => {
  if (!techRulesPromise) {
    techRulesPromise = loadStackPrismRules().catch(() => {
      techRulesPromise = null
      return {}
    })
  }
  return techRulesPromise
}

export const loadDetectorSettings = async () => {
  if (detectorSettingsCache) {
    return detectorSettingsCache
  }

  if (!detectorSettingsPromise) {
    detectorSettingsPromise = chrome.storage.sync
      .get(SETTINGS_STORAGE_KEY)
      .then(async stored => {
        let local: Record<string, any> = {}
        try {
          local = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
        } catch (caught) {
          console.warn(
            '[StackPrism] Failed to read local settings; using local defaults.',
            SETTINGS_STORAGE_KEY,
            sanitizeLogDetails({ error: caught })
          )
          local = {}
        }
        detectorSettingsCache = normalizeSettingsWithLocalOptIn(stored[SETTINGS_STORAGE_KEY], local[SETTINGS_STORAGE_KEY])
        return detectorSettingsCache
      })
      .catch(() => {
        detectorSettingsCache = normalizeSettings()
        return detectorSettingsCache
      })
  }
  return detectorSettingsPromise
}

export const applyDetectorSettingsUpdate = (syncValue: unknown, localValue: unknown = {}) => {
  detectorSettingsCache = normalizeSettingsWithLocalOptIn(syncValue, localValue)
  detectorSettingsPromise = Promise.resolve(detectorSettingsCache)
  return detectorSettingsCache
}

export const buildEffectivePageRules = (pageRules: any, settings: any) => ({
  ...pageRules,
  customRules: settings?.customRules || []
})
