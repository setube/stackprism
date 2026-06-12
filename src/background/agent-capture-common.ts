import type { AgentBridgeError, AgentProfileTransferAckMessage } from '@/types/agent-bridge'
import { AGENT_BRIDGE_ERROR_CODES } from '@/types/agent-bridge'
import type { AgentCaptureState } from './agent-capture-state'

export const CAPTURE_DEADLINE_MS = 60000
export const PROFILE_TRANSFER_DEADLINE_MS = 30000
export const PROFILE_TRANSFER_PORT_READY_TIMEOUT_MS = 2000
export const PROFILE_CHUNK_BYTES = 384 * 1024

const knownErrorCodes = new Set<string>(AGENT_BRIDGE_ERROR_CODES)

export const nonTerminalStatuses = new Set<AgentCaptureState['status']>(['queued', 'waiting_extension', 'running', 'cancel_requested'])
export const runningStatuses = new Set<AgentCaptureState['status']>(['running'])

export type AgentCaptureResponse = { ok: true; data: null } | { ok: false; error: AgentBridgeError }

export type PendingProfileAck = {
  resolve: (ack: AgentProfileTransferAckMessage) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export const makeAgentCaptureError = (
  code: AgentBridgeError['code'],
  message: string,
  details: Record<string, unknown> = {}
): AgentBridgeError => ({
  code,
  message,
  details
})

export const captureKey = (captureId: string, sessionId: string, nonce: string): string => {
  if (captureId.includes(':') || sessionId.includes(':') || nonce.includes(':')) throw new Error('INVALID_REQUEST')
  return `${captureId}:${sessionId}:${nonce}`
}

export const profileAckKey = (message: {
  captureId: string
  sessionId: string
  nonce: string
  profileTransferId: string
  chunkIndex?: number
}): string => {
  if (message.profileTransferId.includes(':')) throw new Error('INVALID_REQUEST')
  return `${captureKey(message.captureId, message.sessionId, message.nonce)}:${message.profileTransferId}:${message.chunkIndex ?? 'meta'}`
}

export const mapCaughtErrorCode = (caught: unknown, fallback: AgentBridgeError['code']): AgentBridgeError['code'] => {
  const message = caught instanceof Error ? caught.message : String(caught || '')
  return knownErrorCodes.has(message) ? (message as AgentBridgeError['code']) : fallback
}
