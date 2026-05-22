import {
  AGENT_BRIDGE_CAPABILITIES,
  REQUIRED_AGENT_BRIDGE_CAPABILITIES,
  bridgeProtocolVersion,
  validateProtocolIdentifier,
  type AgentBridgeCapabilities,
  type AgentBridgeError,
  type AgentBridgeErrorCode,
  type AgentBridgeHelloMessage,
  type AgentCaptureControlMessage,
  type StartAgentCaptureMessage
} from '@/types/agent-bridge'

export const AGENT_BRIDGE_ENABLED_STORAGE_KEY = 'agentBridgeEnabled'
export const SETTINGS_STORAGE_KEY = 'stackPrismSettings'

export interface BridgeSession {
  tabId: number
  windowId: number
  bridgeOrigin: string
  sessionId: string
  captureId: string
  nonce: string
}

const sessionsByTab = new Map<number, BridgeSession>()

export const agentBridgeCapabilities: AgentBridgeCapabilities = Object.fromEntries(
  AGENT_BRIDGE_CAPABILITIES.map(capability => [capability, true])
) as AgentBridgeCapabilities

export const makeAgentBridgeError = (
  code: AgentBridgeErrorCode,
  message: string,
  details: Record<string, unknown> = {}
): AgentBridgeError => ({ code, message, details })

export const isRequiredCapabilitySetSupported = (capabilities: AgentBridgeCapabilities): boolean =>
  REQUIRED_AGENT_BRIDGE_CAPABILITIES.every(capability => capabilities[capability] === true)

const parseBridgeSenderUrl = (value: unknown) => {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/bridge') return null
    return url
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

  const url = parseBridgeSenderUrl(sender.url)
  if (!url) {
    return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent bridge sender URL is not a loopback bridge page.') }
  }

  const sessionId = url.searchParams.get('session') || ''
  const captureId = url.searchParams.get('capture') || ''
  const nonce = url.searchParams.get('nonce') || ''
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

export const getBridgeSession = (tabId: number): BridgeSession | null => sessionsByTab.get(tabId) || null

export const clearBridgeSession = (tabId: number): void => {
  sessionsByTab.delete(tabId)
}

export const registerBridgeSession = (session: BridgeSession): { ok: true } | { ok: false; error: AgentBridgeError } => {
  const existing = sessionsByTab.get(session.tabId)
  if (
    existing &&
    (existing.windowId !== session.windowId ||
      existing.bridgeOrigin !== session.bridgeOrigin ||
      existing.sessionId !== session.sessionId ||
      existing.captureId !== session.captureId ||
      existing.nonce !== session.nonce)
  ) {
    return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent bridge tab already has a different session.') }
  }
  sessionsByTab.set(session.tabId, session)
  return { ok: true }
}

export const loadAgentBridgeEnabled = async (): Promise<boolean> => {
  const local = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  const settings = local?.[SETTINGS_STORAGE_KEY] || {}
  return settings?.[AGENT_BRIDGE_ENABLED_STORAGE_KEY] === true
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

  if (!isRequiredCapabilitySetSupported(agentBridgeCapabilities)) {
    return { ok: false, error: makeAgentBridgeError('NOT_SUPPORTED', 'Agent bridge required capabilities are unavailable.') }
  }

  const registered = registerBridgeSession(parsed.session)
  if (!registered.ok) return { ok: false, error: registered.error }

  return {
    ok: true,
    data: {
      extensionVersion: chrome.runtime.getManifest().version,
      protocolVersion: bridgeProtocolVersion,
      capabilities: agentBridgeCapabilities
    }
  }
}

export const validateRegisteredBridgeMessage = (
  message: Pick<AgentBridgeHelloMessage, 'captureId' | 'sessionId' | 'nonce'>,
  sender: chrome.runtime.MessageSender
): { ok: true; session: BridgeSession } | { ok: false; error: AgentBridgeError } => {
  const parsed = extractBridgeSenderSession(message, sender)
  if (!parsed.ok) return parsed
  const registered = getBridgeSession(parsed.session.tabId)
  if (
    !registered ||
    registered.windowId !== parsed.session.windowId ||
    registered.bridgeOrigin !== parsed.session.bridgeOrigin ||
    registered.sessionId !== parsed.session.sessionId ||
    registered.captureId !== parsed.session.captureId ||
    registered.nonce !== parsed.session.nonce
  ) {
    return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent bridge session is not registered.') }
  }
  return { ok: true, session: registered }
}

export const validateStartAgentCaptureMessage = (
  message: StartAgentCaptureMessage & Record<string, unknown>,
  sender: chrome.runtime.MessageSender
): { ok: true; session: BridgeSession } | { ok: false; error: AgentBridgeError } => {
  const validated = validateRegisteredBridgeMessage(message, sender)
  if (!validated.ok) return validated
  if ('bridgeToken' in message || 'callbackUrl' in message || 'profile' in message) {
    return { ok: false, error: makeAgentBridgeError('INVALID_REQUEST', 'Agent capture payload contains forbidden fields.') }
  }
  return validated
}

export const validateAgentCaptureControlMessage = validateRegisteredBridgeMessage as (
  message: AgentCaptureControlMessage,
  sender: chrome.runtime.MessageSender
) => { ok: true; session: BridgeSession } | { ok: false; error: AgentBridgeError }
