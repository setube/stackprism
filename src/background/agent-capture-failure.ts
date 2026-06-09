import { removeAgentCaptureState, saveAgentCaptureState, type AgentCaptureState } from './agent-capture-state'
import { clearProfileTransferPort } from './agent-capture-transfer'
import { cleanupTarget, restoreOrdinaryDetectionForRetainedTarget } from './agent-capture-target'
import { makeAgentCaptureError, nonTerminalStatuses } from './agent-capture-common'
import { clearBridgeSession } from './agent-bridge-session'
import { sanitizeLogDetails } from './logging'
import type { AgentBridgeError } from '@/types/agent-bridge'

export const reportCleanupFailure = (operation: string, caught: unknown): void => {
  console.warn(
    'StackPrism agent capture cleanup failed.',
    sanitizeLogDetails({
      operation,
      errorName: caught instanceof Error ? caught.name : typeof caught
    })
  )
}

export type BridgeStatusPoster = (
  state: AgentCaptureState,
  status: AgentCaptureState['status'],
  phase: AgentCaptureState['phase'],
  extra?: Record<string, unknown>
) => Promise<void>

export const failAgentCaptureWithPoster = async (
  state: AgentCaptureState,
  code: AgentBridgeError['code'],
  postCaptureStatusToBridge: BridgeStatusPoster,
  message: string = code,
  details: Record<string, unknown> = {},
  notifyBridge = true
): Promise<void> => {
  if (!nonTerminalStatuses.has(state.status)) return
  const failure = makeAgentCaptureError(code, message, details)
  const failurePhase = state.phase
  state.status = 'failed'
  state.error = failure
  state.updatedAt = Date.now()
  try {
    await saveAgentCaptureState(state).catch(caught => reportCleanupFailure('saveAgentCaptureState', caught))
    try {
      clearProfileTransferPort(state)
    } catch (caught) {
      reportCleanupFailure('clearProfileTransferPort', caught)
    }
    if (notifyBridge) {
      await postCaptureStatusToBridge(state, 'failed', failurePhase, { error: failure }).catch(caught =>
        reportCleanupFailure('postCaptureStatusToBridge', caught)
      )
    }
    await cleanupTarget(state).catch(caught => reportCleanupFailure('cleanupTarget', caught))
  } finally {
    await removeAgentCaptureState(state.captureId).catch(caught => reportCleanupFailure('removeAgentCaptureState', caught))
    await clearBridgeSession(state.bridgeTabId).catch(caught => reportCleanupFailure('clearBridgeSession', caught))
    await restoreOrdinaryDetectionForRetainedTarget(state).catch(caught =>
      reportCleanupFailure('restoreOrdinaryDetectionForRetainedTarget', caught)
    )
  }
}
