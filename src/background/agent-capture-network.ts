import { makeAgentCaptureError, nonTerminalStatuses } from './agent-capture-common'
import {
  getAgentCaptureState,
  listAgentCaptureIds,
  saveAgentCaptureState,
  type AgentCaptureNetworkEvidence,
  type AgentCaptureState
} from './agent-capture-state'
import { normalizeComparableUrl } from './agent-capture-request'
import type { AgentBridgeError, AgentCaptureRequest } from '@/types/agent-bridge'
import { isPrivateNetworkAddress, isProxyReservedNetworkAddress } from '@/utils/network-address-policy'

const TARGET_NETWORK_WAIT_MS = 1000
const TARGET_NETWORK_POLL_MS = 25
const NETWORK_EVIDENCE_CAPTURE_RACE_GRACE_MS = 5000
let networkObserverTarget: unknown = null
const tabNetworkEvidence = new Map<number, AgentCaptureNetworkEvidence>()

export interface AgentCaptureNetworkPolicy {
  allowAllNetworkTargets?: boolean
}

const isMainFrameResponse = (details: chrome.webRequest.WebResponseCacheDetails): boolean =>
  details.tabId >= 0 && details.type === 'main_frame' && Boolean(normalizeComparableUrl(details.url))

const findCaptureStatesForTab = async (tabId: number): Promise<AgentCaptureState[]> => {
  const states = await Promise.all((await listAgentCaptureIds()).map(getAgentCaptureState))
  return states.filter((state): state is AgentCaptureState =>
    Boolean(state && state.targetTabId === tabId && nonTerminalStatuses.has(state.status))
  )
}

const toNetworkEvidence = (details: chrome.webRequest.WebResponseCacheDetails): AgentCaptureNetworkEvidence => ({
  url: normalizeComparableUrl(details.url),
  ip: typeof details.ip === 'string' && details.ip.trim() ? details.ip.trim() : undefined,
  fromCache: details.fromCache === true,
  observedAt: Date.now()
})

const isFreshNetworkEvidence = (state: AgentCaptureState, evidence: AgentCaptureNetworkEvidence | undefined): boolean =>
  Boolean(
    evidence &&
      Number.isFinite(evidence.observedAt) &&
      evidence.observedAt >= (state.targetNetworkObservedAfter ?? state.startedAt)
  )

const saveFreshNetworkEvidence = async (state: AgentCaptureState, evidence: AgentCaptureNetworkEvidence): Promise<void> => {
  const latest = await getAgentCaptureState(state.captureId)
  if (!latest || latest.targetTabId !== state.targetTabId || !nonTerminalStatuses.has(latest.status)) return
  if (!isFreshNetworkEvidence(latest, evidence)) return
  const current = (await getAgentCaptureState(state.captureId)) || latest
  if (current.targetTabId !== state.targetTabId || !nonTerminalStatuses.has(current.status)) return
  if (!isFreshNetworkEvidence(current, evidence)) return
  current.targetNetwork = evidence
  current.updatedAt = Date.now()
  await saveAgentCaptureState(current)
}

export const recordAgentCaptureNetworkResponse = async (details: chrome.webRequest.WebResponseCacheDetails): Promise<void> => {
  if (!isMainFrameResponse(details)) return
  const evidence = toNetworkEvidence(details)
  tabNetworkEvidence.set(details.tabId, evidence)
  for (const state of await findCaptureStatesForTab(details.tabId)) {
    await saveFreshNetworkEvidence(state, evidence)
  }
}

export const clearAgentCaptureNetworkEvidence = (tabId: number): void => {
  tabNetworkEvidence.delete(tabId)
}

export const clearStaleAgentCaptureNetworkEvidence = async (tabId: number): Promise<void> => {
  const evidence = tabNetworkEvidence.get(tabId)
  if (!evidence) return
  const activeStates = await findCaptureStatesForTab(tabId)
  if (activeStates.some(state => isFreshNetworkEvidence(state, evidence))) return
  if (Date.now() - evidence.observedAt < NETWORK_EVIDENCE_CAPTURE_RACE_GRACE_MS) return
  tabNetworkEvidence.delete(tabId)
}

export const registerAgentCaptureNetworkObserver = (onError: (tabId: number, error: unknown) => void): void => {
  const responseStarted = chrome.webRequest?.onResponseStarted
  if (networkObserverTarget === responseStarted) return
  if (!responseStarted?.addListener) {
    networkObserverTarget = null
    return
  }
  networkObserverTarget = responseStarted
  responseStarted.addListener(
    details => {
      recordAgentCaptureNetworkResponse(details).catch(error => onError(details.tabId, error))
    },
    { urls: ['http://*/*', 'https://*/*'] }
  )
}

const networkBlockedError = (details: Record<string, unknown>): AgentBridgeError =>
  makeAgentCaptureError('PRIVATE_NETWORK_TARGET_BLOCKED', 'Private network targets are disabled.', details)

const finalUrlBlockedError = (details: Record<string, unknown>): AgentBridgeError =>
  makeAgentCaptureError('FINAL_URL_BLOCKED', 'Final URL blocked.', details)

const isCurrentNetworkEvidence = (state: AgentCaptureState): boolean => {
  const finalUrl = normalizeComparableUrl(state.finalUrl)
  return Boolean(finalUrl && isFreshNetworkEvidence(state, state.targetNetwork) && normalizeComparableUrl(state.targetNetwork?.url) === finalUrl)
}

const isIpLiteral = (value: string): boolean => {
  const host = value.replace(/^\[|\]$/g, '')
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')
}

const canUseProxyReservedAddress = (state: AgentCaptureState, ip: string): boolean => {
  if (!isProxyReservedNetworkAddress(ip)) return false
  try {
    const finalUrl = new URL(state.finalUrl || '')
    return !isIpLiteral(finalUrl.hostname) && !isPrivateNetworkAddress(finalUrl.hostname)
  } catch {
    return false
  }
}

const isLocalhostTarget = (hostname: string): boolean => hostname.toLowerCase().replace(/\.$/, '') === 'localhost'

const isPrivateFinalUrl = (state: AgentCaptureState): boolean => {
  try {
    const finalUrl = new URL(state.finalUrl || '')
    return isLocalhostTarget(finalUrl.hostname) || isPrivateNetworkAddress(finalUrl.hostname)
  } catch {
    return false
  }
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const mergeWaitContext = (latest: AgentCaptureState, base: AgentCaptureState): AgentCaptureState => {
  if (!latest.finalUrl && base.finalUrl) latest.finalUrl = base.finalUrl
  if (typeof latest.targetNetworkObservedAfter !== 'number' && typeof base.targetNetworkObservedAfter === 'number') {
    latest.targetNetworkObservedAfter = base.targetNetworkObservedAfter
  }
  return latest
}

export const waitForAgentCaptureNetworkEvidence = async (state: AgentCaptureState): Promise<AgentCaptureState> => {
  if (!isNetworkObserverActive()) return state
  const deadline = Date.now() + TARGET_NETWORK_WAIT_MS
  while (Date.now() < deadline) {
    const stored = await getAgentCaptureState(state.captureId)
    const latest = stored ? mergeWaitContext(stored, state) : null
    if (!latest) return state
    if (isCurrentNetworkEvidence(latest)) return latest
    const observed = typeof latest.targetTabId === 'number' ? tabNetworkEvidence.get(latest.targetTabId) : undefined
    if (isFreshNetworkEvidence(latest, observed) && normalizeComparableUrl(observed?.url) === normalizeComparableUrl(latest.finalUrl)) {
      latest.targetNetwork = observed
      await saveAgentCaptureState(latest)
      return latest
    }
    await wait(TARGET_NETWORK_POLL_MS)
  }
  const latest = await getAgentCaptureState(state.captureId)
  return latest ? mergeWaitContext(latest, state) : state
}

export const validateAgentCaptureNetwork = (
  state: AgentCaptureState,
  request: AgentCaptureRequest,
  policy: AgentCaptureNetworkPolicy = {}
): AgentBridgeError | null => {
  if (request.options.allowPrivateNetworkTarget && policy.allowAllNetworkTargets) return null
  if (isPrivateFinalUrl(state)) {
    return finalUrlBlockedError({ reason: 'private_network_address', finalUrl: state.finalUrl })
  }
  if (!isNetworkObserverActive()) return null
  const targetNetwork = isCurrentNetworkEvidence(state) ? state.targetNetwork : undefined
  if (!targetNetwork?.ip) return null
  if (isPrivateNetworkAddress(targetNetwork.ip) && !canUseProxyReservedAddress(state, targetNetwork.ip)) {
    return networkBlockedError({ reason: 'private_network_address', address: targetNetwork.ip })
  }
  return null
}

const isNetworkObserverActive = (): boolean =>
  Boolean(networkObserverTarget) && networkObserverTarget === chrome.webRequest?.onResponseStarted
