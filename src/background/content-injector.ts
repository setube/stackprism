import { isDetectablePageUrl } from '@/utils/page-support'
import { runContentObserver } from '@/content/content-observer'
import { runAgentBridgeClient } from '@/content/agent-bridge-client'
import { sanitizeLogDetails } from './logging'
import { isScriptFileLoadError } from './script-injection-errors'

const CONTENT_OBSERVER_FILE_PATTERN = /(^|\/)content-observer(?:\.ts)?(?:[-.]|$)/
const AGENT_BRIDGE_CLIENT_FILE_PATTERN = /(^|\/)agent-bridge-client(?:\.ts)?(?:[-.]|$)/

const canInjectContentObserver = (tab: chrome.tabs.Tab): boolean => typeof tab?.id === 'number' && isDetectablePageUrl(tab.url)

const normalizeExtensionScriptPath = (file: string): string => {
  try {
    const url = new URL(file)
    if (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') return url.pathname.replace(/^\/+/, '')
  } catch {}
  return file.replace(/^\/+/, '')
}

const getContentScriptFile = (pattern: RegExp): string | undefined => {
  const contentScripts = chrome.runtime.getManifest().content_scripts || []
  for (const script of contentScripts) {
    const file = script.js?.find(item => pattern.test(item))
    if (file) return normalizeExtensionScriptPath(file)
  }
  return undefined
}

const executeScriptFile = async (tabId: number, file: string): Promise<void> => {
  const candidates = [normalizeExtensionScriptPath(file)]
  candidates.push(`/${candidates[0]}`)
  let lastError: unknown = null
  for (const candidate of candidates) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        files: [candidate]
      })
      const frameError = (results as Array<{ error?: unknown }>).find(result => result.error !== undefined)?.error
      if (frameError) throw new Error(String(frameError))
      return
    } catch (error) {
      if (!isScriptFileLoadError(error)) throw error
      lastError = error
    }
  }
  throw lastError || new Error('SCRIPT_INJECTION_FAILED')
}

const executeAgentBridgeClientFunction = async (tabId: number): Promise<void> => {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: runAgentBridgeClient
  })
  const frameError = (results as Array<{ error?: unknown }>).find(result => result.error !== undefined)?.error
  if (frameError) throw new Error(String(frameError))
}

const executeContentObserverFunction = async (tabId: number): Promise<void> => {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: runContentObserver
  })
  const frameError = (results as Array<{ error?: unknown }>).find(result => result.error !== undefined)?.error
  if (frameError) throw new Error(String(frameError))
}

export const getContentObserverFile = (): string | undefined => getContentScriptFile(CONTENT_OBSERVER_FILE_PATTERN)

export const getAgentBridgeClientFile = (): string | undefined => getContentScriptFile(AGENT_BRIDGE_CLIENT_FILE_PATTERN)

export const injectContentObserver = async (tabId: number, options: { failOnError?: boolean } = {}): Promise<void> => {
  const observerFile = getContentObserverFile()
  if (!observerFile) {
    if (options.failOnError) throw new Error('CONTENT_OBSERVER_NOT_FOUND')
    console.warn('[SP background] Content observer injection skipped.', sanitizeLogDetails({ reason: 'CONTENT_OBSERVER_NOT_FOUND', tabId }))
    return
  }
  try {
    await executeScriptFile(tabId, observerFile)
  } catch (error) {
    if (!isScriptFileLoadError(error)) {
      if (options.failOnError) throw error
      console.warn('[SP background] Content observer injection failed.', sanitizeLogDetails({ tabId, observerFile, error }))
      return
    }
    try {
      await executeContentObserverFunction(tabId)
    } catch (fallbackError) {
      if (options.failOnError) throw fallbackError
      console.warn('[SP background] Content observer injection failed.', sanitizeLogDetails({ tabId, observerFile, error, fallbackError }))
      return
    }
  }
}

export const injectAgentBridgeClient = async (tabId: number, options: { failOnError?: boolean } = {}): Promise<void> => {
  const bridgeFile = getAgentBridgeClientFile()
  if (!bridgeFile) {
    if (options.failOnError) throw new Error('AGENT_BRIDGE_CLIENT_NOT_FOUND')
    console.warn('[SP background] Agent Bridge client injection skipped.', sanitizeLogDetails({ reason: 'AGENT_BRIDGE_CLIENT_NOT_FOUND', tabId }))
    return
  }
  try {
    await executeScriptFile(tabId, bridgeFile)
  } catch (error) {
    if (!isScriptFileLoadError(error)) {
      if (options.failOnError) throw error
      console.warn('[SP background] Agent Bridge client injection failed.', sanitizeLogDetails({ tabId, bridgeFile, error }))
      return
    }
    try {
      await executeAgentBridgeClientFunction(tabId)
    } catch (fallbackError) {
      if (options.failOnError) throw fallbackError
      console.warn(
        '[SP background] Agent Bridge client injection failed.',
        sanitizeLogDetails({ tabId, bridgeFile, error, fallbackError })
      )
    }
  }
}

export const injectContentObserverIntoOpenTabs = async (): Promise<void> => {
  try {
    const tabs = await chrome.tabs.query({})
    await Promise.allSettled(tabs.filter(canInjectContentObserver).map(tab => injectContentObserver(tab.id!)))
  } catch {
    return
  }
}
