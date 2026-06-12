import type { AgentCaptureState } from './agent-capture-state'
import { AGENT_BRIDGE_ERROR_CODES, bridgeProtocolVersion } from '@/types/agent-bridge'
import { sanitizeLogDetails } from './logging'

type BridgeStatusPostError = Error & { details?: Record<string, unknown> }

const knownErrorCodes = new Set<string>(AGENT_BRIDGE_ERROR_CODES)

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const makeBridgeStatusPostError = (response: any): BridgeStatusPostError => {
  const bridgeError = isRecord(response?.error) ? response.error : {}
  const code =
    typeof bridgeError.code === 'string' && knownErrorCodes.has(bridgeError.code) ? bridgeError.code : 'BRIDGE_TRANSPORT_DISCONNECTED'
  const error = new Error(code) as BridgeStatusPostError
  const rawDetails = isRecord(bridgeError.details) ? bridgeError.details : {}
  const details = sanitizeLogDetails({
    ...rawDetails,
    ...(typeof bridgeError.message === 'string' ? { message: bridgeError.message } : {})
  })
  if (Object.keys(details).length) error.details = details
  return error
}

export const postCaptureStatusToBridge = async (
  state: AgentCaptureState,
  status: AgentCaptureState['status'],
  phase: AgentCaptureState['phase'],
  extra: Record<string, unknown> = {}
): Promise<void> => {
  const response = await chrome.tabs.sendMessage(state.bridgeTabId, {
    type: 'AGENT_CAPTURE_STATUS',
    payload: {
      captureId: state.captureId,
      sessionId: state.sessionId,
      nonce: state.nonce,
      protocolVersion: bridgeProtocolVersion,
      status,
      phase,
      ...extra
    }
  })
  if (response?.ok === false) {
    throw makeBridgeStatusPostError(response)
  }
}
