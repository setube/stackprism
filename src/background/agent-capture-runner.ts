import type { AgentBridgeCapabilities, AgentCaptureRequest } from '@/types/agent-bridge'
import { buildSiteExperienceProfile } from '@/utils/site-experience-profile'
import { isDetectablePageUrl } from '@/utils/page-support'
import { normalizeComparableUrl } from './agent-capture-request'
import { PROFILE_TRANSFER_DEADLINE_MS, mapCaughtErrorCode } from './agent-capture-common'
import type { AgentCaptureState } from './agent-capture-state'
import { getAgentCaptureState, saveAgentCaptureState } from './agent-capture-state'
import {
  captureVisibleViewportScreenshot,
  cleanForCapture,
  executeExperienceProfiler,
  getAgentCaptureUserAgent,
  getExtensionVersion,
  reloadTargetTabBypassingCache,
  waitForTargetTabLoaded
} from './agent-capture-target'
import { validateAgentCaptureNetwork, waitForAgentCaptureNetworkEvidence } from './agent-capture-network'
import { clearProfileTransferPort, sendProfileToBridge } from './agent-capture-transfer'
import { postCaptureStatusToBridge } from './agent-capture-status'
import {
  cleanupStoredCaptureAndSession,
  cleanupTargetAndReport,
  failAgentCapture,
  getCaptureFailureDetails,
  makeCaptureFailureError,
  shouldContinueCapture
} from './agent-capture-lifecycle'
import { runAgentPageDetection } from './detection'
import { loadDetectorSettings } from './detector-settings'
import { buildPopupRawResult } from './popup-cache'
import { getTabData, getTabSnapshot } from './tab-store'

const MAX_WAIT_MS = 30000

const waitForRequestDelay = async (waitMs: number): Promise<void> => {
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, MAX_WAIT_MS)))
}

const loadTargetTab = async (state: AgentCaptureState, request: AgentCaptureRequest): Promise<chrome.tabs.Tab> => {
  if (!state.targetTabId) throw new Error('TARGET_TAB_CLOSED')
  if (!request.options.forceRefresh) return waitForTargetTabLoaded(state.targetTabId, state.deadlineAt)
  if (state.createdByCapture) await waitForTargetTabLoaded(state.targetTabId, state.deadlineAt)
  state.targetNetwork = undefined
  state.targetNetworkObservedAfter = Date.now()
  state.updatedAt = state.targetNetworkObservedAfter
  await saveAgentCaptureState(state)
  return reloadTargetTabBypassingCache(state.targetTabId, state.deadlineAt)
}

const markTargetLoaded = async (state: AgentCaptureState, loadedTab: chrome.tabs.Tab): Promise<{ state: AgentCaptureState; finalUrl: string }> => {
  const finalUrl = normalizeComparableUrl(loadedTab.url || '')
  if (!finalUrl || !isDetectablePageUrl(finalUrl)) throw new Error('FINAL_URL_BLOCKED')
  state.finalUrl = finalUrl
  state.phase = 'target_loaded'
  state.updatedAt = Date.now()
  await saveAgentCaptureState(state)
  return { state: (await getAgentCaptureState(state.captureId)) || state, finalUrl }
}

type NetworkPolicyResult =
  | { ok: true; state: AgentCaptureState; settings: Awaited<ReturnType<typeof loadDetectorSettings>> }
  | { ok: false }

const verifyNetworkPolicy = async (state: AgentCaptureState, request: AgentCaptureRequest): Promise<NetworkPolicyResult> => {
  const latestState = await waitForAgentCaptureNetworkEvidence(state)
  if (latestState.finalUrl !== state.finalUrl || latestState.phase !== state.phase) {
    latestState.finalUrl = state.finalUrl || latestState.finalUrl
    latestState.phase = state.phase
    latestState.updatedAt = Date.now()
    await saveAgentCaptureState(latestState)
  }
  const settings = await loadDetectorSettings()
  const networkError = validateAgentCaptureNetwork(latestState, request, {
    allowAllNetworkTargets: settings.agentBridgeAllowAllNetworkTargets === true
  })
  if (!networkError) return { ok: true, state: latestState, settings }
  await failAgentCapture(latestState, networkError.code, networkError.message, networkError.details || {})
  return { ok: false }
}

const notifyTargetLoaded = async (state: AgentCaptureState, finalUrl: string): Promise<void> => {
  await postCaptureStatusToBridge(state, 'running', 'target_loaded', {
    finalUrl,
    targetNetworkAddress: state.targetNetwork?.ip,
    targetNetworkFromCache: state.targetNetwork?.fromCache
  })
}

const markAndNotifyPhase = async (state: AgentCaptureState, phase: AgentCaptureState['phase']): Promise<void> => {
  state.phase = phase
  state.updatedAt = Date.now()
  await saveAgentCaptureState(state)
  await postCaptureStatusToBridge(state, 'running', phase)
}

const collectTechProfileInput = async (targetTabId: number, settings: Awaited<ReturnType<typeof loadDetectorSettings>>) => {
  const [data, tab] = await Promise.all([getTabData(targetTabId), getTabSnapshot(targetTabId)])
  return buildPopupRawResult(data, settings, tab)
}

const collectExperienceProfileInput = async (targetTabId: number, request: AgentCaptureRequest): Promise<unknown> =>
  executeExperienceProfiler(targetTabId, {
    captureScreenshotMetadata: request.options.captureScreenshotMetadata
  })

const collectProfileInputs = async (
  state: AgentCaptureState,
  request: AgentCaptureRequest,
  targetTabId: number,
  settings: Awaited<ReturnType<typeof loadDetectorSettings>>
) => {
  const shouldRunTech = request.include.includes('tech')
  const shouldRunExperience = request.include.some(section => section !== 'tech')
  if (request.options.forceRefresh) await cleanForCapture(targetTabId)
  if (!(await shouldContinueCapture(state))) return null
  if (shouldRunTech) {
    await markAndNotifyPhase(state, 'detecting_tech')
    try {
      await runAgentPageDetection(targetTabId, state.deadlineAt)
    } catch (caught) {
      throw makeCaptureFailureError(mapCaughtErrorCode(caught, 'TARGET_INJECTION_FAILED'), caught)
    }
  }
  await waitForRequestDelay(request.waitMs)
  if (!(await shouldContinueCapture(state))) return null
  let experience = null
  if (shouldRunExperience) {
    await markAndNotifyPhase(state, 'profiling_experience')
    try {
      experience = await collectExperienceProfileInput(targetTabId, request)
    } catch (caught) {
      throw makeCaptureFailureError('TARGET_INJECTION_FAILED', caught)
    }
  }
  const raw = shouldRunTech ? await collectTechProfileInput(targetTabId, settings) : null
  return { raw, experience }
}

const captureOptionalScreenshot = async (state: AgentCaptureState, request: AgentCaptureRequest) => {
  if (!request.options.captureScreenshot || !request.include.includes('visual')) return { screenshot: null, limitations: [] }
  return captureVisibleViewportScreenshot(state.targetTabId!, state.targetWindowId || state.bridgeWindowId, state.bridgeTabId)
}

const buildProfile = async (
  state: AgentCaptureState,
  request: AgentCaptureRequest,
  capabilities: AgentBridgeCapabilities,
  finalUrl: string,
  inputs: { raw: Awaited<ReturnType<typeof collectTechProfileInput>> | null; experience: unknown }
) => {
  const screenshotResult = await captureOptionalScreenshot(state, request)
  if (!(await shouldContinueCapture(state))) return null
  return buildSiteExperienceProfile({
    captureId: state.captureId,
    request,
    raw: inputs.raw,
    experience: inputs.experience,
    capabilities,
    screenshot: screenshotResult.screenshot,
    limitations: screenshotResult.limitations,
    finalUrl,
    userAgent: getAgentCaptureUserAgent(),
    extensionVersion: getExtensionVersion(),
    capturedAt: new Date().toISOString(),
    pageSupported: true
  })
}

const postProfile = async (state: AgentCaptureState, profile: ReturnType<typeof buildSiteExperienceProfile>): Promise<void> => {
  state.phase = 'posting_profile'
  state.profileTransferDeadlineAt = Date.now() + PROFILE_TRANSFER_DEADLINE_MS
  await saveAgentCaptureState(state)
  if (!(await shouldContinueCapture(state))) return
  await sendProfileToBridge(state, profile)
  state.status = 'completed'
  state.phase = 'cleanup'
  state.updatedAt = Date.now()
  await saveAgentCaptureState(state)
  clearProfileTransferPort(state)
}

export const runCapture = async (
  state: AgentCaptureState,
  request: AgentCaptureRequest,
  capabilities: AgentBridgeCapabilities
): Promise<void> => {
  try {
    const loadedTab = await loadTargetTab(state, request)
    if (!(await shouldContinueCapture(state))) return
    const targetTabId = loadedTab.id ?? state.targetTabId
    if (!targetTabId) throw new Error('TARGET_TAB_CLOSED')
    const loadedTarget = await markTargetLoaded(state, loadedTab)
    state = loadedTarget.state
    const finalUrl = loadedTarget.finalUrl
    const networkPolicy = await verifyNetworkPolicy(state, request)
    if (!networkPolicy.ok) return
    state = networkPolicy.state
    await notifyTargetLoaded(state, finalUrl)

    const inputs = await collectProfileInputs(state, request, targetTabId, networkPolicy.settings)
    if (!inputs) return
    const profile = await buildProfile(state, request, capabilities, finalUrl, inputs)
    if (!profile) return
    await postProfile(state, profile)
  } catch (caught) {
    const code = mapCaughtErrorCode(caught, 'PROFILE_TRANSPORT_FAILED')
    await failAgentCapture(state, code, code, getCaptureFailureDetails(caught))
    return
  }
  await cleanupTargetAndReport(state)
  await cleanupStoredCaptureAndSession(state)
}
