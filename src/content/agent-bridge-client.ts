import {
  REQUIRED_AGENT_BRIDGE_CAPABILITIES,
  AGENT_BRIDGE_ERROR_CODES,
  bridgeProtocolVersion,
  type AgentBridgeCapabilities,
  type AgentBridgeError,
  type AgentBridgeRuntimeMessage,
  type AgentCaptureStatus
} from '@/types/agent-bridge'
import { registerProfileTransferListener } from './agent-bridge-transfer'
import { isBridgePageUrl, parseBridgePageContext, validateCaptureRequestEnvelope, type BridgePageContext } from './agent-bridge-request'

export { isBridgePageUrl, parseBridgePageContext, validateCaptureRequestEnvelope } from './agent-bridge-request'

const BRIDGE_META_SELECTOR = 'meta[name="stackprism-agent-bridge"][content="1"]'
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
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired'])
const KNOWN_ERROR_CODES = new Set<string>(AGENT_BRIDGE_ERROR_CODES)
const PHASE_ORDER = new Map([...STATUS_PHASES].map((phase, index) => [phase, index]))

const makeError = (code: AgentBridgeError['code'], message: string, details: Record<string, unknown> = {}): AgentBridgeError => ({
  code,
  message,
  details
})

const errorFromUnknown = (error: unknown, fallback: AgentBridgeError['code']): AgentBridgeError => {
  const bridgeError = (error as { bridgeError?: AgentBridgeError } | null)?.bridgeError
  if (bridgeError?.code) return bridgeError
  const message = error instanceof Error ? error.message : String(error || fallback)
  const code = KNOWN_ERROR_CODES.has(message) ? (message as AgentBridgeError['code']) : fallback
  return makeError(code, KNOWN_ERROR_CODES.has(message) ? message : 'Agent Bridge request failed.')
}

const readBridgeJson = async (response: Response): Promise<any> => {
  try {
    return await response.json()
  } catch {
    return {
      error: {
        code: 'PROFILE_TRANSPORT_FAILED',
        message: 'Agent Bridge returned a non-JSON response.',
        details: { status: response.status }
      }
    }
  }
}

export const requestJson = async (context: BridgePageContext, path: string, init: RequestInit = {}) => {
  const response = await fetch(`${context.bridgeOrigin}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${context.bridgeToken}`,
      ...(init.headers || {})
    },
    cache: 'no-store'
  })
  const body = await readBridgeJson(response)
  if (!response.ok) {
    const error = new Error(body?.error?.code || `BRIDGE_HTTP_${response.status}`) as Error & { bridgeError?: AgentBridgeError }
    error.bridgeError = body?.error || {
      code: 'PROFILE_TRANSPORT_FAILED',
      message: 'Agent Bridge request failed.',
      details: { status: response.status }
    }
    throw error
  }
  return body
}

const createStatusPoster = (context: BridgePageContext) => {
  let sequence = 0
  return async (
    status: AgentCaptureStatus,
    phase?: string,
    error?: AgentBridgeError,
    extra: Record<string, unknown> = {},
    requestInit: RequestInit = {}
  ) => {
    sequence += 1
    await requestJson(context, `/v1/captures/${context.captureId}/status`, {
      method: 'POST',
      ...requestInit,
      body: JSON.stringify({
        captureId: context.captureId,
        sessionId: context.sessionId,
        nonce: context.nonce,
        protocolVersion: bridgeProtocolVersion,
        status,
        phase: normalizeWritableStatusPhase(status, phase && STATUS_PHASES.has(phase) ? phase : undefined),
        sequence,
        error,
        ...extra
      })
    })
  }
}

const hasRequiredCapabilities = (capabilities: AgentBridgeCapabilities): boolean =>
  REQUIRED_AGENT_BRIDGE_CAPABILITIES.every(capability => capabilities?.[capability] === true)

const missingRequiredCapability = (capabilities: AgentBridgeCapabilities): string | undefined =>
  REQUIRED_AGENT_BRIDGE_CAPABILITIES.find(capability => capabilities?.[capability] !== true)

export const normalizeWritableStatusPhase = (status: AgentCaptureStatus, phase?: string): string | undefined =>
  status === 'cancelled' ? 'cleanup' : status === 'failed' ? phase || 'cleanup' : phase

const laterPhase = (left: string, right: string): string => {
  const leftOrder = PHASE_ORDER.get(left) ?? -1
  const rightOrder = PHASE_ORDER.get(right) ?? -1
  return rightOrder > leftOrder ? right : left
}

const runtimeTransportError = (code: AgentBridgeError['code']): Error & { bridgeError: AgentBridgeError } => {
  const error = new Error(code) as Error & { bridgeError: AgentBridgeError }
  error.bridgeError = makeError(code, 'Agent Bridge extension transport is unavailable.', { transport: 'chrome.runtime.sendMessage' })
  return error
}

const sendRuntimeMessage = (message: AgentBridgeRuntimeMessage, failureCode: AgentBridgeError['code']): Promise<any> =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(runtimeTransportError(failureCode))
        return
      }
      resolve(response)
    })
  })

const isStatusMessageForContext = (context: BridgePageContext, message: AgentBridgeRuntimeMessage): boolean =>
  message.type === 'AGENT_CAPTURE_STATUS' &&
  message.payload?.captureId === context.captureId &&
  message.payload.sessionId === context.sessionId &&
  message.payload.nonce === context.nonce &&
  message.payload.protocolVersion === bridgeProtocolVersion

const isIncognitoExtensionContext = (): boolean =>
  (chrome as { extension?: { inIncognitoContext?: boolean } }).extension?.inIncognitoContext === true

const startControlPolling = (context: BridgePageContext) => {
  const intervalId = window.setInterval(() => {
    requestJson(context, `/v1/captures/${context.captureId}/control`)
      .then(control => {
        if (TERMINAL_STATUSES.has(String(control?.status || ''))) window.clearInterval(intervalId)
        if (control?.command === 'cancel') {
          window.clearInterval(intervalId)
          return sendRuntimeMessage(
            {
              type: 'AGENT_CAPTURE_CONTROL',
              captureId: context.captureId,
              sessionId: context.sessionId,
              nonce: context.nonce,
              command: 'cancel'
            },
            'BRIDGE_TRANSPORT_DISCONNECTED'
          )
        }
      })
      .catch(() => {})
  }, CONTROL_POLL_MS)
  return () => window.clearInterval(intervalId)
}

const registerCaptureStatusListener = (
  context: BridgePageContext,
  postStatus: (status: AgentCaptureStatus, phase?: string, error?: AgentBridgeError, extra?: Record<string, unknown>) => Promise<void>,
  stopControlPolling: () => void
) => {
  chrome.runtime.onMessage.addListener((message: AgentBridgeRuntimeMessage, _sender, sendResponse) => {
    if (message?.type !== 'AGENT_CAPTURE_STATUS') return false
    if (!isStatusMessageForContext(context, message)) {
      sendResponse({ ok: false, error: makeError('BRIDGE_REQUEST_MISMATCH', 'Agent capture status context mismatch.') })
      return false
    }
    if (TERMINAL_STATUSES.has(message.payload.status)) stopControlPolling()
    postStatus(message.payload.status, message.payload.phase, message.payload.error, {
      finalUrl: message.payload.finalUrl,
      targetNetworkAddress: message.payload.targetNetworkAddress,
      targetNetworkFromCache: message.payload.targetNetworkFromCache
    })
      .then(() => sendResponse({ ok: true, data: null }))
      .catch(error => sendResponse({ ok: false, error: error.bridgeError || errorFromUnknown(error, 'BRIDGE_TRANSPORT_DISCONNECTED') }))
    return true
  })
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
  let terminalStatusPosted = false
  let stopControlPolling = () => {}
  let currentPhase = 'bridge_connected'
  const postTrackedStatus = async (
    status: AgentCaptureStatus,
    phase?: string,
    error?: AgentBridgeError,
    extra: Record<string, unknown> = {},
    requestInit: RequestInit = {}
  ) => {
    if (phase && STATUS_PHASES.has(phase)) currentPhase = laterPhase(currentPhase, phase)
    const writablePhase = status === 'failed' ? currentPhase : phase
    if (TERMINAL_STATUSES.has(status)) {
      terminalStatusPosted = true
      stopControlPolling()
    }
    await postStatus(status, writablePhase, error, extra, requestInit)
  }
  const postBridgeClosed = () => {
    if (terminalStatusPosted) return
    if (context.bridgeOrigin !== location.origin || !isBridgePageUrl(location.href)) return
    terminalStatusPosted = true
    postStatus('failed', 'cleanup', makeError('BRIDGE_TAB_CLOSED', 'Agent bridge page was closed.'), {}, { keepalive: true }).catch(
      () => {}
    )
  }
  window.addEventListener('pagehide', postBridgeClosed, { once: true })
  window.addEventListener('beforeunload', postBridgeClosed, { once: true })
  document.documentElement.dataset.stackprismAgentBridgeClient = 'ready'

  try {
    if (isIncognitoExtensionContext()) {
      await postTrackedStatus(
        'failed',
        'bridge_connected',
        makeError('INCOGNITO_NOT_SUPPORTED', 'Incognito bridge pages are not supported.')
      )
      return
    }

    if (context.protocolVersion !== bridgeProtocolVersion) {
      await postTrackedStatus(
        'failed',
        'bridge_connected',
        makeError('BRIDGE_PROTOCOL_UNSUPPORTED', 'Bridge protocol version is unsupported.')
      )
      return
    }

    registerCaptureStatusListener(context, postTrackedStatus, () => stopControlPolling())
    const requestEnvelope = await requestJson(context, `/v1/captures/${context.captureId}/request`)
    const request = validateCaptureRequestEnvelope(context, requestEnvelope)
    await postTrackedStatus('waiting_extension', 'request_loaded')
    const hello = await sendRuntimeMessage({
      type: 'AGENT_BRIDGE_HELLO',
      captureId: context.captureId,
      sessionId: context.sessionId,
      nonce: context.nonce,
      protocolVersion: bridgeProtocolVersion
    }, 'EXTENSION_NOT_CONNECTED')
    if (!hello?.ok) {
      await postTrackedStatus('failed', 'request_loaded', hello?.error || makeError('INVALID_REQUEST', 'Agent bridge hello failed.'))
      return
    }
    if (!hasRequiredCapabilities(hello.data.capabilities)) {
      const missingCapability = missingRequiredCapability(hello.data.capabilities)
      await postTrackedStatus(
        'failed',
        'request_loaded',
        makeError('NOT_SUPPORTED', 'Required extension capabilities are missing.', { missingCapability })
      )
      return
    }
    registerProfileTransferListener(context, postTrackedStatus, (path, init) => requestJson(context, path, init))
    await postTrackedStatus('running', 'target_opening')
    const startResponse = await sendRuntimeMessage({
      type: 'START_AGENT_CAPTURE',
      captureId: context.captureId,
      sessionId: context.sessionId,
      nonce: context.nonce,
      bridgeOrigin: context.bridgeOrigin,
      request,
      capabilities: hello.data.capabilities
    }, 'BRIDGE_TRANSPORT_DISCONNECTED')
    if (!startResponse?.ok) {
      await postTrackedStatus(
        'failed',
        'target_opening',
        startResponse?.error || makeError('INVALID_REQUEST', 'Agent capture start failed.')
      )
      return
    }
    stopControlPolling = startControlPolling(context)
  } catch (error) {
    await postTrackedStatus('failed', currentPhase, errorFromUnknown(error, 'PROFILE_TRANSPORT_FAILED')).catch(() => {})
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  runAgentBridgeClient().catch(error => {
    console.error('[StackPrism Agent Bridge] runAgentBridgeClient failed', {
      errorCode: errorFromUnknown(error, 'PROFILE_TRANSPORT_FAILED').code
    })
    document.documentElement.dataset.stackprismAgentBridgeError = 'PROFILE_TRANSPORT_FAILED'
  })
}
