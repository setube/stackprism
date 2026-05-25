const SESSION_PREFIX = '__sp_session__:'

let sessionSupported: boolean | null = null

const checkSessionSupport = async (): Promise<boolean> => {
  if (sessionSupported !== null) return sessionSupported
  try {
    await chrome.storage.session.get('__probe__')
    sessionSupported = true
  } catch {
    sessionSupported = false
  }
  return sessionSupported
}

export const compatStorage = {
  session: {
    get: async (key: string): Promise<Record<string, unknown>> => {
      if (await checkSessionSupport()) {
        return chrome.storage.session.get(key)
      }
      const result = await chrome.storage.local.get(SESSION_PREFIX + key)
      const raw = result[SESSION_PREFIX + key]
      return raw ? { [key]: raw } : {}
    },
    set: async (items: Record<string, unknown>): Promise<void> => {
      if (await checkSessionSupport()) {
        return chrome.storage.session.set(items)
      }
      const prefixed: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(items)) {
        prefixed[SESSION_PREFIX + key] = value
      }
      return chrome.storage.local.set(prefixed)
    },
    remove: async (keys: string[]): Promise<void> => {
      if (await checkSessionSupport()) {
        return chrome.storage.session.remove(keys)
      }
      return chrome.storage.local.remove(keys.map(k => SESSION_PREFIX + k))
    }
  }
}

export const clearLegacySessionKeys = async (): Promise<void> => {
  if (await checkSessionSupport()) return
  const all = await chrome.storage.local.get(null)
  const sessionKeys = Object.keys(all).filter(k => k.startsWith(SESSION_PREFIX))
  if (sessionKeys.length) {
    await chrome.storage.local.remove(sessionKeys)
  }
}
