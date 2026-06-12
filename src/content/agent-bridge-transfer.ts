import type {
  AgentBridgeRuntimeMessage,
  AgentBridgeError,
  AgentCaptureStatus,
  AgentProfileTransferAckMessage,
  AgentProfileTransferCompleteMessage,
  SiteExperienceProfile
} from '@/types/agent-bridge'

const AGENT_PROFILE_TRANSFER_PORT = 'stackprism-agent-profile-transfer'
const bridgeProtocolVersion = 1 as const
interface BridgeTransferContext {
  bridgeOrigin: string
  sessionId: string
  captureId: string
  nonce: string
}

interface TransferState {
  chunks: Array<Uint8Array | null>
  byteLength: number
  expiresAt: number
  chunkCount: number
  nextChunkIndex: number
  sha256: string
}

type StatusPoster = (status: AgentCaptureStatus, phase?: string, error?: AgentBridgeError) => Promise<void>
type BridgeRequester = (path: string, init?: RequestInit) => Promise<any>
type TransferResponse = { ok: true; data: null } | { ok: false; error: AgentBridgeError }

const transferState = new Map<string, TransferState>()
const TRANSFER_TTL_MS = 30000
const PROFILE_CHUNK_BYTES = 384 * 1024
const PROFILE_BODY_BYTES = 8 * 1024 * 1024
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/
const PROFILE_TRANSFER_ID_PATTERN = /^xfer_[A-Za-z0-9_-]{22}$/

const makeError = (code: AgentBridgeError['code'], message: string): AgentBridgeError => ({ code, message })

const decodeBase64 = (value: string): Uint8Array => {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid base64.')
  }
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const assembleChunks = (chunks: Uint8Array[], byteLength: number): Uint8Array => {
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const validateTransferMessage = (context: BridgeTransferContext, message: AgentBridgeRuntimeMessage): boolean =>
  'captureId' in message &&
  message.captureId === context.captureId &&
  message.sessionId === context.sessionId &&
  message.nonce === context.nonce

const validateTransferId = (message: AgentBridgeRuntimeMessage): boolean =>
  'profileTransferId' in message && PROFILE_TRANSFER_ID_PATTERN.test(message.profileTransferId)

const clearTransfer = (message: AgentBridgeRuntimeMessage): void => {
  if ('profileTransferId' in message) transferState.delete(message.profileTransferId)
}

const pruneExpiredTransfers = (): void => {
  const now = Date.now()
  for (const [transferId, state] of transferState) {
    if (state.expiresAt <= now) transferState.delete(transferId)
  }
}

const expectedChunkCount = (byteLength: number): number => Math.max(1, Math.ceil(byteLength / PROFILE_CHUNK_BYTES))

const isValidBeginMetadata = (message: AgentBridgeRuntimeMessage): boolean =>
  message.type === 'AGENT_PROFILE_TRANSFER_BEGIN' &&
  Number.isInteger(message.chunkCount) &&
  Number.isInteger(message.byteLength) &&
  message.byteLength > 0 &&
  message.byteLength <= PROFILE_BODY_BYTES &&
  message.chunkCount === expectedChunkCount(message.byteLength) &&
  SHA256_HEX_PATTERN.test(message.sha256) &&
  !transferState.has(message.profileTransferId)

export const registerProfileTransferListener = (context: BridgeTransferContext, postStatus: StatusPoster, requestJson: BridgeRequester) => {
  const port = chrome.runtime.connect({ name: AGENT_PROFILE_TRANSFER_PORT })
  let terminal = false
  port.postMessage({
    type: 'AGENT_PROFILE_TRANSFER_PORT_HELLO',
    captureId: context.captureId,
    sessionId: context.sessionId,
    nonce: context.nonce,
    protocolVersion: bridgeProtocolVersion
  })
  port.onMessage.addListener((message: AgentBridgeRuntimeMessage) => {
    if (!message?.type || !message.type.startsWith('AGENT_PROFILE_TRANSFER_') || message.type === 'AGENT_PROFILE_TRANSFER_ACK') return
    handleTransferMessage(context, postStatus, requestJson, message)
      .then(response => {
        if (message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE' && response.ok) terminal = true
        port.postMessage(toAckMessage(context, message, response))
      })
      .catch(error =>
        port.postMessage(
          toAckMessage(context, message, {
            ok: false,
            error: makeError(
              'PROFILE_TRANSPORT_FAILED',
              error instanceof Error && error.message === 'PROFILE_TRANSPORT_FAILED'
                ? 'PROFILE_TRANSPORT_FAILED'
                : 'Profile transfer handling failed.'
            )
          })
        )
      )
  })
  port.onDisconnect.addListener(() => {
    if (terminal) return
    postStatus('failed', 'posting_profile', makeError('BRIDGE_TRANSPORT_DISCONNECTED', 'Profile transfer port disconnected.')).catch(
      () => {}
    )
  })
}

const toAckMessage = (
  context: BridgeTransferContext,
  message: AgentBridgeRuntimeMessage,
  response: TransferResponse
): AgentProfileTransferAckMessage => {
  const profileTransferId = 'profileTransferId' in message ? message.profileTransferId : ''
  const chunkIndex = 'chunkIndex' in message ? message.chunkIndex : undefined
  return {
    type: 'AGENT_PROFILE_TRANSFER_ACK',
    captureId: context.captureId,
    sessionId: context.sessionId,
    nonce: context.nonce,
    profileTransferId,
    chunkIndex,
    ok: response.ok,
    error: response.ok ? undefined : response.error
  }
}

export const handleTransferMessage = async (
  context: BridgeTransferContext,
  postStatus: StatusPoster,
  requestJson: BridgeRequester,
  message: AgentBridgeRuntimeMessage
): Promise<TransferResponse> => {
  pruneExpiredTransfers()
  if (!validateTransferMessage(context, message)) {
    clearTransfer(message)
    await postStatus('failed', 'posting_profile', makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer context mismatch.'))
    return { ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer context mismatch.') }
  }
  if (!validateTransferId(message)) {
    await postStatus('failed', 'posting_profile', makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer id is invalid.'))
    return { ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer id is invalid.') }
  }

  if (message.type === 'AGENT_PROFILE_TRANSFER_BEGIN') {
    if (!isValidBeginMetadata(message)) {
      await postStatus('failed', 'posting_profile', makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer metadata is invalid.'))
      return { ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer metadata is invalid.') }
    }
    transferState.set(message.profileTransferId, {
      chunks: Array(message.chunkCount).fill(null),
      byteLength: message.byteLength,
      expiresAt: Date.now() + TRANSFER_TTL_MS,
      chunkCount: message.chunkCount,
      nextChunkIndex: 0,
      sha256: message.sha256
    })
    return { ok: true, data: null }
  }

  if (message.type === 'AGENT_PROFILE_TRANSFER_CHUNK') {
    const state = transferState.get(message.profileTransferId)
    if (
      !state ||
      message.chunkCount !== state.chunkCount ||
      message.chunkIndex < 0 ||
      message.chunkIndex >= state.chunks.length ||
      message.chunkIndex !== state.nextChunkIndex ||
      state.chunks[message.chunkIndex]
    ) {
      transferState.delete(message.profileTransferId)
      await postStatus('failed', 'posting_profile', makeError('PROFILE_CHUNK_MISSING', 'Profile transfer chunk is missing.'))
      return { ok: false, error: makeError('PROFILE_CHUNK_MISSING', 'Profile transfer chunk is missing.') }
    }
    let chunk: Uint8Array
    try {
      chunk = decodeBase64(message.payloadBase64)
    } catch {
      transferState.delete(message.profileTransferId)
      await postStatus('failed', 'posting_profile', makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer chunk is invalid.'))
      return { ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer chunk is invalid.') }
    }
    if (chunk.byteLength !== message.chunkByteLength) {
      transferState.delete(message.profileTransferId)
      await postStatus('failed', 'posting_profile', makeError('PROFILE_TRANSPORT_FAILED', 'Profile chunk length mismatch.'))
      return { ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', 'Profile chunk length mismatch.') }
    }
    state.chunks[message.chunkIndex] = chunk
    state.nextChunkIndex += 1
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
): Promise<TransferResponse> => {
  const state = transferState.get(message.profileTransferId)
  if (!state || state.chunks.some(chunk => !chunk)) {
    transferState.delete(message.profileTransferId)
    await postStatus('failed', 'posting_profile', makeError('PROFILE_CHUNK_MISSING', 'Profile transfer chunk is missing.'))
    return { ok: false, error: makeError('PROFILE_CHUNK_MISSING', 'Profile transfer chunk is missing.') }
  }

  const chunks = state.chunks.filter((chunk): chunk is Uint8Array => Boolean(chunk))
  const actualByteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  if (actualByteLength !== state.byteLength) {
    transferState.delete(message.profileTransferId)
    await postStatus('failed', 'posting_profile', makeError('PROFILE_HASH_MISMATCH', 'Profile transfer hash mismatch.'))
    return { ok: false, error: makeError('PROFILE_HASH_MISMATCH', 'Profile transfer hash mismatch.') }
  }
  const bytes = assembleChunks(chunks, state.byteLength)
  if (bytes.byteLength !== message.byteLength || message.sha256 !== state.sha256 || (await sha256Hex(bytes)) !== state.sha256) {
    transferState.delete(message.profileTransferId)
    await postStatus('failed', 'posting_profile', makeError('PROFILE_HASH_MISMATCH', 'Profile transfer hash mismatch.'))
    return { ok: false, error: makeError('PROFILE_HASH_MISMATCH', 'Profile transfer hash mismatch.') }
  }

  try {
    const profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as SiteExperienceProfile
    await requestJson(`/v1/captures/${context.captureId}/profile`, { method: 'POST', body: JSON.stringify(profile) })
    return { ok: true, data: null }
  } catch {
    await postStatus('failed', 'posting_profile', makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer payload is invalid.'))
    return { ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer payload is invalid.') }
  } finally {
    transferState.delete(message.profileTransferId)
  }
}
