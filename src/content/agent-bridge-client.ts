import {
  REQUIRED_AGENT_BRIDGE_CAPABILITIES,
  bridgeProtocolVersion,
  validateProtocolIdentifier,
  type AgentBridgeCapabilities,
  type AgentBridgeError,
  type AgentBridgeRuntimeMessage,
  type AgentCaptureRequest,
  type AgentCaptureStatus
} from '@/types/agent-bridge'
import { registerProfileTransferListener } from './agent-bridge-transfer'

const BRIDGE_META_SELECTOR = 'meta[name="stackprism-agent-bridge"][content="stackprism-agent-bridge"]'
const CONFIG_SELECTOR = '#stackprism-agent-bridge-config[type="application/json"]'
const STATUS_PHASES = new Set([
  'bridge_connected',
  'request_loaded',
  'target_opening',
  'target_loaded',
  'detecting_tech',
  'profiling_experience',
  'posting_profile',
  'cleanup'
])
const CONTROL_POLL_MS = 1000
const KNOWN_ERROR_CODES = new Set([
  'INVALID_REQUEST',
  'BRIDGE_REQUEST_MISMATCH',
  'BRIDGE_PROTOCOL_UNSUPPORTED',
  'AGENT_BRIDGE_DISABLED',
  'NOT_SUPPORTED',
  'PROFILE_TRANSPORT_FAILED'
])

interface BridgePageContext {
  bridgeOrigin: string
  sessionId: string
  captureId: string
  nonce: string
  bridgeToken: string
  protocolVersion: number
}

export const isBridgePageUrl = (value: unknown): boolean => {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/bridge'
  } catch {
    return false
  }
}

export const parseBridgePageContext = (href: string, configText: string): BridgePageContext => {
  const url = new URL(href)
  const sessionId = url.searchParams.get('session') || ''
  const captureId = url.searchParams.get('capture') || ''
  const nonce = url.searchParams.get('nonce') || ''
  const config = JSON.parse(configText || '{}')
  const bridgeToken = String(config.bridgeToken || '')
  const protocolVersion = Number(config.protocolVersion)

  if (
    !validateProtocolIdentifier('sessionId', sessionId) ||
    !validateProtocolIdentifier('captureId', captureId) ||
    !validateProtocolIdentifier('nonce', nonce) ||
    !validateProtocolIdentifier('bridgeToken', bridgeToken)
  ) {
    throw new Error('INVALID_REQUEST')
  }

  return { bridgeOrigin: url.origin, sessionId, captureId, nonce, bridgeToken, protocolVersion }
}

export const validateCaptureRequestEnvelope = (context: BridgePageContext, value: any): AgentCaptureRequest => {
  if (
    value?.captureId !== context.captureId ||
    value?.sessionId !== context.sessionId ||
    value?.nonce !== context.nonce ||
    value?.protocolVersion !== bridgeProtocolVersion
  ) {
    throw new Error('BRIDGE_REQUEST_MISMATCH')
  }
  return value.request as AgentCaptureRequest
}

const makeError = (code: AgentBridgeError['code'], message: string): AgentBridgeError => ({ code, message })

const errorFromUnknown = (error: unknown, fallback: AgentBridgeError['code']): AgentBridgeError => {
  const message = error instanceof Error ? error.message : String(error || fallback)
  const code = KNOWN_ERROR_CODES.has(message) ? (message as AgentBridgeError['code']) : fallback
  return makeError(code, message)
}

const requestJson = async (context: BridgePageContext, path: string, init: RequestInit = {}) => {
  const response = await fetch(`${context.bridgeOrigin}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${context.bridgeToken}`,
      ...(init.headers || {})
    },
    cache: 'no-store'
  })
  if (!response.ok) throw new Error(`BRIDGE_HTTP_${response.status}`)
  return response.json()
}

const createStatusPoster = (context: BridgePageContext) => {
  let sequence = 0
  return async (status: AgentCaptureStatus, phase?: string, error?: AgentBridgeError) => {
    sequence += 1
    await requestJson(context, `/v1/captures/${context.captureId}/status`, {
      method: 'POST',
      body: JSON.stringify({
        captureId: context.captureId,
        sessionId: context.sessionId,
        nonce: context.nonce,
        protocolVersion: bridgeProtocolVersion,
        status,
        phase: phase && STATUS_PHASES.has(phase) ? phase : undefined,
        sequence,
        error
      })
    })
  }
}

const hasRequiredCapabilities = (capabilities: AgentBridgeCapabilities): boolean =>
  REQUIRED_AGENT_BRIDGE_CAPABILITIES.every(capability => capabilities?.[capability] === true)

const sendRuntimeMessage = (message: AgentBridgeRuntimeMessage): Promise<any> =>
  new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => resolve(response))
  })

const startControlPolling = (context: BridgePageContext) => {
  window.setInterval(() => {
    requestJson(context, `/v1/captures/${context.captureId}/control`)
      .then(control => {
        if (control?.command === 'cancel') {
          return sendRuntimeMessage({
            type: 'AGENT_CAPTURE_CONTROL',
            captureId: context.captureId,
            sessionId: context.sessionId,
            nonce: context.nonce,
            command: 'cancel'
          })
        }
      })
      .catch(() => {})
  }, CONTROL_POLL_MS)
}

const runAgentBridgeClient = async () => {
  if (!isBridgePageUrl(location.href)) return
  const meta = document.querySelector(BRIDGE_META_SELECTOR)
  if (!meta) return
  const configElement = document.querySelector(CONFIG_SELECTOR)
  let context: BridgePageContext
  try {
    context = parseBridgePageContext(location.href, configElement?.textContent || '')
  } catch (error) {
    document.documentElement.dataset.stackprismAgentBridgeError = errorFromUnknown(error, 'INVALID_REQUEST').code
    return
  }
  const postStatus = createStatusPoster(context)
  document.documentElement.dataset.stackprismAgentBridgeClient = 'ready'

  try {
    if (context.protocolVersion !== bridgeProtocolVersion) {
      await postStatus('failed', 'bridge_connected', makeError('BRIDGE_PROTOCOL_UNSUPPORTED', 'Bridge protocol version is unsupported.'))
      return
    }

    registerProfileTransferListener(context, postStatus, (path, init) => requestJson(context, path, init))
    const requestEnvelope = await requestJson(context, `/v1/captures/${context.captureId}/request`)
    const request = validateCaptureRequestEnvelope(context, requestEnvelope)
    await postStatus('waiting_extension', 'request_loaded')
    const hello = await sendRuntimeMessage({
      type: 'AGENT_BRIDGE_HELLO',
      captureId: context.captureId,
      sessionId: context.sessionId,
      nonce: context.nonce,
      protocolVersion: bridgeProtocolVersion
    })
    if (!hello?.ok) {
      await postStatus('failed', 'bridge_connected', hello?.error || makeError('INVALID_REQUEST', 'Agent bridge hello failed.'))
      return
    }
    if (!hasRequiredCapabilities(hello.data.capabilities)) {
      await postStatus('failed', 'bridge_connected', makeError('NOT_SUPPORTED', 'Required extension capabilities are missing.'))
      return
    }
    const startResponse = await sendRuntimeMessage({
      type: 'START_AGENT_CAPTURE',
      captureId: context.captureId,
      sessionId: context.sessionId,
      nonce: context.nonce,
      bridgeOrigin: context.bridgeOrigin,
      request,
      capabilities: hello.data.capabilities
    })
    if (!startResponse?.ok) {
      await postStatus('failed', 'target_opening', startResponse?.error || makeError('INVALID_REQUEST', 'Agent capture start failed.'))
      return
    }
    await postStatus('running', 'target_opening')
    startControlPolling(context)
  } catch (error) {
    await postStatus('failed', 'bridge_connected', errorFromUnknown(error, 'PROFILE_TRANSPORT_FAILED')).catch(() => {})
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  runAgentBridgeClient().catch(() => {})
}
