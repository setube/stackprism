import { clearBridgeSession } from './agent-bridge-session'
import { getAgentCaptureState, removeAgentCaptureState, type AgentCaptureState } from './agent-capture-state'
import { nonTerminalStatuses, runningStatuses } from './agent-capture-common'
import { failAgentCaptureWithPoster, reportCleanupFailure } from './agent-capture-failure'
import { postCaptureStatusToBridge } from './agent-capture-status'
import { cleanupTarget, restoreOrdinaryDetectionForRetainedTarget } from './agent-capture-target'
import { sanitizeLogDetails } from './logging'
import type { AgentBridgeError } from '@/types/agent-bridge'

const MAX_FAILURE_REASON_CHARS = 240

export type CaptureFailureError = Error & { details?: Record<string, unknown> }

export const sanitizeFailureReason = (caught: unknown): string => {
  const rawReason = caught instanceof Error ? caught.message || caught.name : String(caught || '')
  const sanitized = sanitizeLogDetails({ reason: rawReason }).reason
  return String(sanitized || 'unknown').slice(0, MAX_FAILURE_REASON_CHARS)
}

export const makeCaptureFailureError = (code: AgentBridgeError['code'], caught?: unknown): CaptureFailureError => {
  const error = new Error(code) as CaptureFailureError
  if (caught !== undefined) error.details = { reason: sanitizeFailureReason(caught) }
  return error
}

export const getCaptureFailureDetails = (caught: unknown): Record<string, unknown> => {
  if (!(caught instanceof Error) || !('details' in caught)) return {}
  const details = caught.details
  return details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : {}
}

export const shouldContinueCapture = async (state: AgentCaptureState): Promise<boolean> => {
  const latest = await getAgentCaptureState(state.captureId)
  return Boolean(latest && runningStatuses.has(latest.status))
}

export const cleanupTargetAndReport = async (state: AgentCaptureState): Promise<void> => {
  await cleanupTarget(state).catch(caught => reportCleanupFailure('cleanupTarget', caught))
}

export const cleanupStoredCaptureAndSession = async (state: AgentCaptureState): Promise<void> => {
  await removeAgentCaptureState(state.captureId).catch(caught => reportCleanupFailure('removeAgentCaptureState', caught))
  await clearBridgeSession(state.bridgeTabId).catch(caught => reportCleanupFailure('clearBridgeSession', caught))
  await restoreOrdinaryDetectionForRetainedTarget(state).catch(caught =>
    reportCleanupFailure('restoreOrdinaryDetectionForRetainedTarget', caught)
  )
}

export const failAgentCapture = async (
  state: AgentCaptureState,
  code: AgentBridgeError['code'],
  message: string = code,
  details: Record<string, unknown> = {},
  notifyBridge = true
): Promise<void> => {
  const latest = await getAgentCaptureState(state.captureId)
  if (!latest || !nonTerminalStatuses.has(latest.status)) return
  await failAgentCaptureWithPoster(latest, code, postCaptureStatusToBridge, message, details, notifyBridge)
}
