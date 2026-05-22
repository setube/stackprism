import type {
  AgentBridgeError,
  AgentBridgeRuntimeMessage,
  AgentCaptureStatus,
  AgentProfileTransferCompleteMessage,
  SiteExperienceProfile
} from '@/types/agent-bridge'

interface BridgeTransferContext {
  bridgeOrigin: string
  sessionId: string
  captureId: string
  nonce: string
}

interface TransferState {
  chunks: string[]
}

type StatusPoster = (status: AgentCaptureStatus, phase?: string, error?: AgentBridgeError) => Promise<void>
type BridgeRequester = (path: string, init?: RequestInit) => Promise<any>

const transferState = new Map<string, TransferState>()

const makeError = (code: AgentBridgeError['code'], message: string): AgentBridgeError => ({ code, message })

const decodeBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), char => char.charCodeAt(0))

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const validateTransferMessage = (context: BridgeTransferContext, message: AgentBridgeRuntimeMessage): boolean =>
  'captureId' in message &&
  message.captureId === context.captureId &&
  message.sessionId === context.sessionId &&
  message.nonce === context.nonce

export const registerProfileTransferListener = (context: BridgeTransferContext, postStatus: StatusPoster, requestJson: BridgeRequester) => {
  chrome.runtime.onMessage.addListener((message: AgentBridgeRuntimeMessage, _sender, sendResponse) => {
    if (!message?.type || !message.type.startsWith('AGENT_PROFILE_TRANSFER_')) return false
    handleTransferMessage(context, postStatus, requestJson, message)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', String(error)) }))
    return true
  })
}

const handleTransferMessage = async (
  context: BridgeTransferContext,
  postStatus: StatusPoster,
  requestJson: BridgeRequester,
  message: AgentBridgeRuntimeMessage
) => {
  if (!validateTransferMessage(context, message)) {
    await postStatus('failed', 'posting_profile', makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer context mismatch.'))
    return { ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer context mismatch.') }
  }

  if (message.type === 'AGENT_PROFILE_TRANSFER_BEGIN') {
    transferState.set(message.profileTransferId, { chunks: Array(message.chunkCount).fill('') })
    return { ok: true, data: null }
  }

  if (message.type === 'AGENT_PROFILE_TRANSFER_CHUNK') {
    const state = transferState.get(message.profileTransferId)
    if (!state || message.chunkIndex < 0 || message.chunkIndex >= state.chunks.length) {
      await postStatus('failed', 'posting_profile', makeError('PROFILE_CHUNK_MISSING', 'Profile transfer chunk is missing.'))
      return { ok: false, error: makeError('PROFILE_CHUNK_MISSING', 'Profile transfer chunk is missing.') }
    }
    state.chunks[message.chunkIndex] = message.payloadBase64
    return { ok: true, data: null }
  }

  if (message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE') {
    return completeProfileTransfer(context, postStatus, requestJson, message)
  }

  return { ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', 'Unsupported profile transfer message.') }
}

const completeProfileTransfer = async (
  context: BridgeTransferContext,
  postStatus: StatusPoster,
  requestJson: BridgeRequester,
  message: AgentProfileTransferCompleteMessage
) => {
  const state = transferState.get(message.profileTransferId)
  if (!state || state.chunks.some(chunk => !chunk)) {
    await postStatus('failed', 'posting_profile', makeError('PROFILE_CHUNK_MISSING', 'Profile transfer chunk is missing.'))
    return { ok: false, error: makeError('PROFILE_CHUNK_MISSING', 'Profile transfer chunk is missing.') }
  }

  const bytes = decodeBase64(state.chunks.join(''))
  if (bytes.byteLength !== message.byteLength || (await sha256Hex(bytes)) !== message.sha256) {
    await postStatus('failed', 'posting_profile', makeError('PROFILE_HASH_MISMATCH', 'Profile transfer hash mismatch.'))
    return { ok: false, error: makeError('PROFILE_HASH_MISMATCH', 'Profile transfer hash mismatch.') }
  }

  const profile = JSON.parse(new TextDecoder().decode(bytes)) as SiteExperienceProfile
  await requestJson(`/v1/captures/${context.captureId}/profile`, { method: 'POST', body: JSON.stringify(profile) })
  transferState.delete(message.profileTransferId)
  return { ok: true, data: null }
}
