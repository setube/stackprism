import {
  AGENT_BRIDGE_CAPABILITIES,
  REQUIRED_AGENT_BRIDGE_CAPABILITIES,
  START_AGENT_CAPTURE_MESSAGE_FIELDS,
  bridgeProtocolVersion,
  validateProtocolIdentifier,
  type AgentBridgeCapabilities,
  type AgentBridgeError,
  type AgentBridgeErrorCode,
  type AgentBridgeHelloMessage,
  type AgentCaptureControlMessage,
  type StartAgentCaptureMessage
} from '@/types/agent-bridge'
import { assertStorageSessionAvailable } from './agent-capture-state'

export const AGENT_BRIDGE_ENABLED_STORAGE_KEY = 'agentBridgeEnabled'
export const SETTINGS_STORAGE_KEY = 'stackPrismSettings'
const BRIDGE_SESSION_STORAGE_PREFIX = 'agent-bridge-session:'

export interface BridgeSession {
  tabId: number
  windowId: number
  bridgeOrigin: string
  sessionId: string
  captureId: string
  nonce: string
}

const sessionsByTab = new Map<number, BridgeSession>()
const sessionLocksByTab = new Map<number, Promise<void>>()
const BRIDGE_QUERY_KINDS = {
  session: 'sessionId',
  capture: 'captureId',
  nonce: 'nonce'
} as const

export const agentBridgeCapabilities: AgentBridgeCapabilities = Object.fromEntries(
  AGENT_BRIDGE_CAPABILITIES.map(capability => [capability, true])
) as AgentBridgeCapabilities

export const getAgentBridgeCapabilities = (): AgentBridgeCapabilities => ({
  ...agentBridgeCapabilities,
  storageSession: assertStorageSessionAvailable().ok
})

export const makeAgentBridgeError = (
  code: AgentBridgeErrorCode,
  message: string,
  details: Record<string, unknown> = {}
): AgentBridgeError => ({ code, message, details })

const findMissingRequiredCapability = (capabilities: Partial<AgentBridgeCapabilities> | null | undefined): string | null =>
  REQUIRED_AGENT_BRIDGE_CAPABILITIES.find(capability => capabilities?.[capability] !== true) || null

export const isRequiredCapabilitySetSupported = (capabilities: Partial<AgentBridgeCapabilities> | null | undefined): boolean =>
  !findMissingRequiredCapability(capabilities)

const parseRawBridgeQuery = (url: URL): { session: string; capture: string; nonce: string } | null => {
  const raw = url.search.replace(/^\?/, '')
  const parts = raw ? raw.split('&') : []
  if (parts.length !== 3) return null
  const values: Record<string, string> = {}
  for (const part of parts) {
    const separatorIndex = part.indexOf('=')
    if (!part || separatorIndex <= 0 || part.indexOf('=', separatorIndex + 1) !== -1) return null
    const name = part.slice(0, separatorIndex)
    const value = part.slice(separatorIndex + 1)
    const kind = BRIDGE_QUERY_KINDS[name as keyof typeof BRIDGE_QUERY_KINDS]
    if (!kind || values[name] !== undefined || !validateProtocolIdentifier(kind, value)) return null
    values[name] = value
  }
  return values.session && values.capture && values.nonce ? { session: values.session, capture: values.capture, nonce: values.nonce } : null
}

const parseBridgeSenderUrl = (value: unknown) => {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/bridge') return null
    const query = parseRawBridgeQuery(url)
    return query ? { url, query } : null
  } catch {
    return null
  }
}

export const extractBridgeSenderSession = (
  message: Pick<AgentBridgeHelloMessage, 'captureId' | 'sessionId' | 'nonce'>,
  sender: chrome.runtime.MessageSender
): { ok: true; session: BridgeSession } | { ok: false; error: AgentBridgeError } => {
  const tabId = sender.tab?.id
  const windowId = sender.tab?.windowId
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) {
    return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent bridge sender tab is missing.') }
  }

  const parsedUrl = parseBridgeSenderUrl(sender.url)
  if (!parsedUrl) {
    return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent bridge sender URL is not a loopback bridge page.') }
  }

  const { url, query } = parsedUrl
  const sessionId = query.session
  const captureId = query.capture
  const nonce = query.nonce
  if (
    !validateProtocolIdentifier('sessionId', sessionId) ||
    !validateProtocolIdentifier('captureId', captureId) ||
    !validateProtocolIdentifier('nonce', nonce) ||
    sessionId !== message.sessionId ||
    captureId !== message.captureId ||
    nonce !== message.nonce
  ) {
    return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent bridge sender URL does not match the message.') }
  }

  return { ok: true, session: { tabId: tabId!, windowId: windowId!, bridgeOrigin: url.origin, sessionId, captureId, nonce } }
}

const bridgeSessionStorageKey = (tabId: number): string => `${BRIDGE_SESSION_STORAGE_PREFIX}${tabId}`

const sameBridgeSession = (a: BridgeSession, b: BridgeSession): boolean =>
  a.tabId === b.tabId &&
  a.windowId === b.windowId &&
  a.bridgeOrigin === b.bridgeOrigin &&
  a.sessionId === b.sessionId &&
  a.captureId === b.captureId &&
  a.nonce === b.nonce

export const getBridgeSession = async (tabId: number): Promise<BridgeSession | null> => {
  const cached = sessionsByTab.get(tabId)
  if (cached) return cached
  const stored = await chrome.storage.session.get(bridgeSessionStorageKey(tabId))
  const session = stored[bridgeSessionStorageKey(tabId)] as BridgeSession | undefined
  if (!session || session.tabId !== tabId) return null
  sessionsByTab.set(tabId, session)
  return session
}

const withBridgeSessionLock = async <T>(tabId: number, work: () => Promise<T>): Promise<T> => {
  const previous = sessionLocksByTab.get(tabId) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  const chained = previous.then(
    () => current,
    () => current
  )
  sessionLocksByTab.set(tabId, chained)
  await previous.catch(() => {})
  try {
    return await work()
  } finally {
    release()
    if (sessionLocksByTab.get(tabId) === chained) sessionLocksByTab.delete(tabId)
  }
}

export const clearBridgeSession = async (tabId: number): Promise<void> => {
  await withBridgeSessionLock(tabId, async () => {
    sessionsByTab.delete(tabId)
    await chrome.storage.session.remove(bridgeSessionStorageKey(tabId))
  })
}

export const registerBridgeSession = async (session: BridgeSession): Promise<{ ok: true } | { ok: false; error: AgentBridgeError }> => {
  return withBridgeSessionLock(session.tabId, async () => {
    const existing = await getBridgeSession(session.tabId)
    if (existing && !sameBridgeSession(existing, session)) {
      return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent bridge tab already has a different session.') }
    }
    sessionsByTab.set(session.tabId, session)
    await chrome.storage.session.set({ [bridgeSessionStorageKey(session.tabId)]: session })
    const stored = (await chrome.storage.session.get(bridgeSessionStorageKey(session.tabId)))[bridgeSessionStorageKey(session.tabId)]
    if (!stored || !sameBridgeSession(stored as BridgeSession, session)) {
      sessionsByTab.delete(session.tabId)
      await chrome.storage.session.remove(bridgeSessionStorageKey(session.tabId))
      return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent bridge session could not be persisted.') }
    }
    return { ok: true }
  })
}

export const loadAgentBridgeEnabled = async (): Promise<boolean> => {
  try {
    const local = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
    const settings = local?.[SETTINGS_STORAGE_KEY] || {}
    return settings?.[AGENT_BRIDGE_ENABLED_STORAGE_KEY] === true
  } catch {
    return false
  }
}

export const handleAgentBridgeHello = async (message: AgentBridgeHelloMessage, sender: chrome.runtime.MessageSender) => {
  if (message.protocolVersion !== bridgeProtocolVersion) {
    return { ok: false, error: makeAgentBridgeError('BRIDGE_PROTOCOL_UNSUPPORTED', 'Agent bridge protocol version is unsupported.') }
  }

  const parsed = extractBridgeSenderSession(message, sender)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  if (!(await loadAgentBridgeEnabled())) {
    return { ok: false, error: makeAgentBridgeError('AGENT_BRIDGE_DISABLED', 'Agent Bridge is disabled in this browser profile.') }
  }

  const capabilities = getAgentBridgeCapabilities()
  const missingCapability = findMissingRequiredCapability(capabilities)
  if (missingCapability) {
    return {
      ok: false,
      error: makeAgentBridgeError('NOT_SUPPORTED', 'Agent bridge required capabilities are unavailable.', { missingCapability })
    }
  }

  const registered = await registerBridgeSession(parsed.session)
  if (!registered.ok) return { ok: false, error: registered.error }

  return {
    ok: true,
    data: {
      extensionVersion: chrome.runtime.getManifest().version,
      protocolVersion: bridgeProtocolVersion,
      capabilities
    }
  }
}

export const validateRegisteredBridgeMessage = async (
  message: Pick<AgentBridgeHelloMessage, 'captureId' | 'sessionId' | 'nonce'>,
  sender: chrome.runtime.MessageSender
): Promise<{ ok: true; session: BridgeSession } | { ok: false; error: AgentBridgeError }> => {
  const parsed = extractBridgeSenderSession(message, sender)
  if (!parsed.ok) return parsed
  const registered = await getBridgeSession(parsed.session.tabId)
  if (!registered || !sameBridgeSession(registered, parsed.session)) {
    return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent bridge session is not registered.') }
  }
  return { ok: true, session: registered }
}

export const validateStartAgentCaptureMessage = async (
  message: StartAgentCaptureMessage & Record<string, unknown>,
  sender: chrome.runtime.MessageSender
): Promise<{ ok: true; session: BridgeSession } | { ok: false; error: AgentBridgeError }> => {
  const validated = await validateRegisteredBridgeMessage(message, sender)
  if (!validated.ok) return validated
  if ('bridgeToken' in message || 'callbackUrl' in message || 'profile' in message) {
    return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent capture payload contains forbidden fields.') }
  }
  if (!Object.keys(message).every(key => (START_AGENT_CAPTURE_MESSAGE_FIELDS as readonly string[]).includes(key))) {
    return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent capture payload contains unknown fields.') }
  }
  const missingCapability = findMissingRequiredCapability(message.capabilities)
  if (missingCapability) {
    return {
      ok: false,
      error: makeAgentBridgeError('NOT_SUPPORTED', 'Agent bridge required capabilities are unavailable.', { missingCapability })
    }
  }
  return validated
}

export const validateAgentCaptureControlMessage = validateRegisteredBridgeMessage as (
  message: AgentCaptureControlMessage,
  sender: chrome.runtime.MessageSender
) => Promise<{ ok: true; session: BridgeSession } | { ok: false; error: AgentBridgeError }>
