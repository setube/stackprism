import type { AgentBridgeError, AgentCapturePhase, AgentCaptureStatus } from '@/types/agent-bridge'
import { logBackgroundError } from './logging'

export const AGENT_CAPTURE_STATE_PREFIX = 'agent-capture:'
export const AGENT_CAPTURE_INDEX_KEY = 'agent-capture:index'

let stateIndexMutation: Promise<void> = Promise.resolve()

const captureStatuses = new Set<AgentCaptureStatus>([
  'queued',
  'waiting_extension',
  'running',
  'cancel_requested',
  'cancelled',
  'completed',
  'failed',
  'expired'
])
const capturePhases = new Set<AgentCapturePhase>([
  'bridge_connected',
  'request_loaded',
  'target_opening',
  'target_loaded',
  'detecting_tech',
  'profiling_experience',
  'posting_profile',
  'cleanup'
])

export interface AgentCaptureState {
  captureId: string
  sessionId: string
  nonce: string
  bridgeOrigin: string
  bridgeUrl: string
  bridgeTabId: number
  bridgeWindowId: number
  targetTabId?: number
  targetWindowId?: number
  targetUrl: string
  finalUrl?: string
  targetMode: string
  createdByCapture: boolean
  keepTabOpen: boolean
  phase: string
  status: AgentCaptureStatus
  startedAt: number
  targetNetworkObservedAfter?: number
  updatedAt: number
  deadlineAt: number
  cancelDeadlineAt?: number
  profileTransferDeadlineAt?: number
  error?: AgentBridgeError
  targetNetwork?: AgentCaptureNetworkEvidence
}

export interface AgentCaptureNetworkEvidence {
  url: string
  ip?: string
  fromCache: boolean
  observedAt: number
}

export const agentCaptureStateKey = (captureId: string): string => `${AGENT_CAPTURE_STATE_PREFIX}${captureId}`

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isOptionalFiniteNumber = (value: unknown): value is number | undefined => value === undefined || isFiniteNumber(value)

const isStoredNetworkEvidence = (value: unknown): value is AgentCaptureNetworkEvidence => {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return (
    typeof value.url === 'string' &&
    (value.ip === undefined || typeof value.ip === 'string') &&
    typeof value.fromCache === 'boolean' &&
    isFiniteNumber(value.observedAt)
  )
}

const isStoredAgentCaptureState = (value: unknown, captureId: string): value is AgentCaptureState => {
  if (!isRecord(value)) return false
  return (
    value.captureId === captureId &&
    typeof value.sessionId === 'string' &&
    typeof value.nonce === 'string' &&
    typeof value.bridgeOrigin === 'string' &&
    typeof value.bridgeUrl === 'string' &&
    isFiniteNumber(value.bridgeTabId) &&
    isFiniteNumber(value.bridgeWindowId) &&
    isOptionalFiniteNumber(value.targetTabId) &&
    isOptionalFiniteNumber(value.targetWindowId) &&
    typeof value.targetUrl === 'string' &&
    typeof value.targetMode === 'string' &&
    typeof value.createdByCapture === 'boolean' &&
    typeof value.keepTabOpen === 'boolean' &&
    typeof value.phase === 'string' &&
    capturePhases.has(value.phase as AgentCapturePhase) &&
    typeof value.status === 'string' &&
    captureStatuses.has(value.status as AgentCaptureStatus) &&
    isFiniteNumber(value.startedAt) &&
    isOptionalFiniteNumber(value.targetNetworkObservedAfter) &&
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.deadlineAt) &&
    isOptionalFiniteNumber(value.cancelDeadlineAt) &&
    isOptionalFiniteNumber(value.profileTransferDeadlineAt) &&
    isStoredNetworkEvidence(value.targetNetwork)
  )
}

const withStateIndexMutation = async (task: () => Promise<void>): Promise<void> => {
  const run = stateIndexMutation.then(task, task)
  const next = run.catch(() => {})
  stateIndexMutation = next
  next.finally(() => {
    if (stateIndexMutation === next) stateIndexMutation = Promise.resolve()
  })
  return run
}

export const listAgentCaptureIds = async (): Promise<string[]> => {
  const stored = await chrome.storage.session.get(AGENT_CAPTURE_INDEX_KEY)
  return Array.isArray(stored[AGENT_CAPTURE_INDEX_KEY]) ? stored[AGENT_CAPTURE_INDEX_KEY] : []
}

export const getAgentCaptureState = async (captureId: string): Promise<AgentCaptureState | null> => {
  const key = agentCaptureStateKey(captureId)
  const stored = await chrome.storage.session.get(key)
  const value = stored[key]
  if (!value) return null
  if (isStoredAgentCaptureState(value, captureId)) return value
  await removeAgentCaptureState(captureId)
  return null
}

export const saveAgentCaptureState = async (state: AgentCaptureState): Promise<void> => {
  await withStateIndexMutation(async () => {
    const ids = new Set(await listAgentCaptureIds())
    ids.add(state.captureId)
    const {
      bridgeToken: _bridgeToken,
      apiToken: _apiToken,
      ...safeState
    } = state as AgentCaptureState & {
      bridgeToken?: string
      apiToken?: string
    }
    await chrome.storage.session.set({
      [AGENT_CAPTURE_INDEX_KEY]: [...ids],
      [agentCaptureStateKey(state.captureId)]: safeState
    })
  })
}

const restoreAgentCaptureIndexAfterRemoveFailure = async (ids: string[], captureId: string): Promise<void> => {
  try {
    await chrome.storage.session.set({ [AGENT_CAPTURE_INDEX_KEY]: [...new Set([...ids, captureId])] })
  } catch (error) {
    logBackgroundError('Agent capture state index rollback failed', { captureId, error })
  }
}

export const removeAgentCaptureState = async (captureId: string): Promise<void> => {
  await withStateIndexMutation(async () => {
    const ids = (await listAgentCaptureIds()).filter(id => id !== captureId)
    const key = agentCaptureStateKey(captureId)
    await chrome.storage.session.set({ [AGENT_CAPTURE_INDEX_KEY]: ids })
    try {
      await chrome.storage.session.remove(key)
    } catch (error) {
      await restoreAgentCaptureIndexAfterRemoveFailure(ids, captureId)
      throw error
    }
  })
}

export const clearAllAgentCaptureState = async (): Promise<void> => {
  await withStateIndexMutation(async () => {
    const ids = await listAgentCaptureIds()
    await chrome.storage.session.remove([AGENT_CAPTURE_INDEX_KEY, ...ids.map(agentCaptureStateKey)])
  })
}

export const assertStorageSessionAvailable = (): { ok: true } | { ok: false; error: AgentBridgeError } => {
  if (!chrome.storage?.session?.get || !chrome.storage.session.set || !chrome.storage.session.remove) {
    return {
      ok: false,
      error: { code: 'NOT_SUPPORTED', message: 'chrome.storage.session is required.', details: { missingCapability: 'storageSession' } }
    }
  }
  return { ok: true }
}

const makeCaptureDeadlineError = (state: AgentCaptureState): AgentBridgeError =>
  state.phase === 'target_opening'
    ? { code: 'TARGET_LOAD_TIMEOUT', message: 'Agent target tab load timed out.' }
    : { code: 'CAPTURE_TIMEOUT', message: 'Agent capture timed out.' }

export const reconcileAgentCaptureDeadlines = async (now = Date.now()): Promise<AgentCaptureState[]> => {
  const expired: AgentCaptureState[] = []
  for (const captureId of await listAgentCaptureIds()) {
    const state = await getAgentCaptureState(captureId)
    if (!state) continue
    if (!['queued', 'waiting_extension', 'running', 'cancel_requested'].includes(state.status)) continue
    const cancelTimedOut = Boolean(state.cancelDeadlineAt && state.cancelDeadlineAt <= now)
    const profileTransferTimedOut = Boolean(state.profileTransferDeadlineAt && state.profileTransferDeadlineAt <= now)
    if (state.deadlineAt <= now || cancelTimedOut || profileTransferTimedOut) {
      const deadlineError = makeCaptureDeadlineError(state)
      state.status = cancelTimedOut ? 'cancelled' : 'failed'
      state.phase = 'cleanup'
      state.updatedAt = now
      state.error = cancelTimedOut
        ? { code: 'CAPTURE_TIMEOUT', message: 'Capture cancellation timed out.', details: { reason: 'cancel_timeout' } }
        : profileTransferTimedOut
          ? {
              code: 'PROFILE_TRANSPORT_FAILED',
              message: 'Profile transfer timed out.',
              details: { reason: 'profile_transfer_timeout' }
            }
          : deadlineError
      await saveAgentCaptureState(state)
      expired.push(state)
    }
  }
  return expired
}
