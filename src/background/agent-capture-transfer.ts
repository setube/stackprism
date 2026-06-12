import { validateRegisteredBridgeMessage } from './agent-bridge-session'
import { getAgentCaptureState, type AgentCaptureState } from './agent-capture-state'
import {
  captureKey,
  mapCaughtErrorCode,
  PendingProfileAck,
  profileAckKey,
  PROFILE_CHUNK_BYTES,
  PROFILE_TRANSFER_DEADLINE_MS,
  PROFILE_TRANSFER_PORT_READY_TIMEOUT_MS
} from './agent-capture-common'
import type { AgentBridgeRuntimeMessage, AgentProfileTransferAckMessage, SiteExperienceProfile } from '@/types/agent-bridge'
import { AGENT_PROFILE_TRANSFER_PORT, bridgeProtocolVersion } from '@/types/agent-bridge'
import { logBackgroundError } from './logging'

type ProfileTransferPortRecord = {
  port: chrome.runtime.Port
  captureId: string
  sessionId: string
  nonce: string
  bridgeTabId: number
}

const profileTransferPorts = new Map<string, ProfileTransferPortRecord>()
const pendingProfileAcks = new Map<string, PendingProfileAck>()
const pendingProfileTransferPortWaiters = new Map<string, Set<(connected: boolean) => void>>()

export type AgentCaptureFailureHandler = (
  state: AgentCaptureState,
  code: ReturnType<typeof mapCaughtErrorCode>,
  message?: string,
  details?: Record<string, unknown>,
  notifyBridge?: boolean
) => Promise<void>

let failCapture: AgentCaptureFailureHandler | null = null

export const setAgentCaptureFailureHandler = (handler: AgentCaptureFailureHandler): void => {
  failCapture = handler
}

export const clearProfileTransferPort = (state: Pick<AgentCaptureState, 'captureId' | 'sessionId' | 'nonce'>): void => {
  const keyPrefix = captureKey(state.captureId, state.sessionId, state.nonce)
  profileTransferPorts.delete(keyPrefix)
  const waiters = pendingProfileTransferPortWaiters.get(keyPrefix)
  if (waiters) {
    pendingProfileTransferPortWaiters.delete(keyPrefix)
    for (const resolve of waiters) resolve(false)
  }
  for (const [key, pending] of pendingProfileAcks) {
    if (!key.startsWith(`${keyPrefix}:`)) continue
    pendingProfileAcks.delete(key)
    clearTimeout(pending.timeout)
    pending.reject(new Error('BRIDGE_TRANSPORT_DISCONNECTED'))
  }
}

export const waitForProfileTransferPort = async (state: Pick<AgentCaptureState, 'captureId' | 'sessionId' | 'nonce'>): Promise<boolean> => {
  const key = captureKey(state.captureId, state.sessionId, state.nonce)
  if (profileTransferPorts.has(key)) return true
  return new Promise(resolve => {
    const waiter = (connected: boolean) => {
      clearTimeout(timeout)
      resolve(connected)
    }
    const timeout = setTimeout(() => {
      const waiters = pendingProfileTransferPortWaiters.get(key)
      waiters?.delete(waiter)
      if (!waiters?.size) pendingProfileTransferPortWaiters.delete(key)
      resolve(profileTransferPorts.has(key))
    }, PROFILE_TRANSFER_PORT_READY_TIMEOUT_MS)
    const waiters = pendingProfileTransferPortWaiters.get(key) || new Set<(connected: boolean) => void>()
    waiters.add(waiter)
    pendingProfileTransferPortWaiters.set(key, waiters)
  })
}

export const registerAgentProfileTransferPort = (port: chrome.runtime.Port): void => {
  if (port.name !== AGENT_PROFILE_TRANSFER_PORT || !port.sender) {
    port.disconnect()
    return
  }
  let registeredKey = ''
  port.onMessage.addListener((message: AgentBridgeRuntimeMessage) => {
    if (message?.type === 'AGENT_PROFILE_TRANSFER_PORT_HELLO') {
      registerPortHello(port, message, key => {
        registeredKey = key
      })
        .catch(() => port.disconnect())
      return
    }
    if (message?.type !== 'AGENT_PROFILE_TRANSFER_ACK' || !registeredKey) return
    resolvePendingAck(registeredKey, message)
  })
  port.onDisconnect.addListener(() => {
    const captureId = profileTransferPorts.get(registeredKey)?.captureId
    handlePortDisconnect(registeredKey, port).catch(error =>
      logBackgroundError('Profile transfer port disconnect cleanup failed', { registeredKey, captureId, error })
    )
  })
}

const registerPortHello = async (
  port: chrome.runtime.Port,
  message: AgentBridgeRuntimeMessage,
  registerKey: (key: string) => void
): Promise<void> => {
  if (message.type !== 'AGENT_PROFILE_TRANSFER_PORT_HELLO' || message.protocolVersion !== bridgeProtocolVersion) {
    port.disconnect()
    return
  }
  const validated = await validateRegisteredBridgeMessage(message, port.sender!)
  if (!validated.ok) {
    port.disconnect()
    return
  }
  const key = captureKey(message.captureId, message.sessionId, message.nonce)
  const existing = profileTransferPorts.get(key)
  if (existing && existing.port !== port) {
    port.disconnect()
    return
  }
  registerKey(key)
  profileTransferPorts.set(key, {
    port,
    captureId: message.captureId,
    sessionId: message.sessionId,
    nonce: message.nonce,
    bridgeTabId: validated.session.tabId
  })
  notifyProfileTransferWaiters(key)
}

const notifyProfileTransferWaiters = (key: string): void => {
  const waiters = pendingProfileTransferPortWaiters.get(key)
  if (!waiters) return
  pendingProfileTransferPortWaiters.delete(key)
  for (const resolve of waiters) resolve(true)
}

const resolvePendingAck = (registeredKey: string, message: AgentProfileTransferAckMessage): void => {
  if (captureKey(message.captureId, message.sessionId, message.nonce) !== registeredKey) return
  let key = ''
  try {
    key = profileAckKey(message)
  } catch {
    return
  }
  const pending = pendingProfileAcks.get(key)
  if (!pending) return
  pendingProfileAcks.delete(key)
  clearTimeout(pending.timeout)
  pending.resolve(message)
}

const handlePortDisconnect = async (registeredKey: string, port: chrome.runtime.Port): Promise<void> => {
  if (!registeredKey) return
  const record = profileTransferPorts.get(registeredKey)
  if (record?.port === port) profileTransferPorts.delete(registeredKey)
  rejectPendingAcks(registeredKey)
  const state = await getAgentCaptureState(record?.captureId || '')
  if (!state || !failCapture) return
  await failCapture(state, 'BRIDGE_TRANSPORT_DISCONNECTED', 'Agent bridge profile transfer port disconnected.')
}

const rejectPendingAcks = (registeredKey: string): void => {
  for (const [key, pending] of pendingProfileAcks) {
    if (!key.startsWith(`${registeredKey}:`)) continue
    pendingProfileAcks.delete(key)
    clearTimeout(pending.timeout)
    pending.reject(new Error('BRIDGE_TRANSPORT_DISCONNECTED'))
  }
}

const postProfileTransferMessage = async (
  record: ProfileTransferPortRecord,
  message: AgentBridgeRuntimeMessage & {
    captureId: string
    sessionId: string
    nonce: string
    profileTransferId: string
    chunkIndex?: number
  }
): Promise<void> => {
  const key = profileAckKey(message)
  const ack = await new Promise<AgentProfileTransferAckMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingProfileAcks.delete(key)
      reject(new Error('PROFILE_TRANSPORT_FAILED'))
    }, PROFILE_TRANSFER_DEADLINE_MS)
    pendingProfileAcks.set(key, { resolve, reject, timeout })
    try {
      record.port.postMessage(message)
    } catch (caught) {
      pendingProfileAcks.delete(key)
      clearTimeout(timeout)
      reject(caught instanceof Error ? caught : new Error('BRIDGE_TRANSPORT_DISCONNECTED'))
    }
  })
  if (!ack.ok) throw new Error(ack.error?.code || 'PROFILE_TRANSPORT_FAILED')
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const bytesToBase64 = (bytes: Uint8Array): string => btoa(bytesToBinaryString(bytes))

const bytesToBinaryString = (bytes: Uint8Array): string => {
  const chunkSize = 0x8000
  const parts: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    parts.push(String.fromCharCode(...bytes.slice(offset, offset + chunkSize)))
  }
  return parts.join('')
}

const randomBase64Url = (byteLength: number): string =>
  bytesToBase64(crypto.getRandomValues(new Uint8Array(byteLength)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

const createProfileTransferId = (): string => `xfer_${randomBase64Url(16)}`

export const sendProfileToBridge = async (state: AgentCaptureState, profile: SiteExperienceProfile): Promise<void> => {
  const record = profileTransferPorts.get(captureKey(state.captureId, state.sessionId, state.nonce))
  if (!record || record.bridgeTabId !== state.bridgeTabId) throw new Error('BRIDGE_TRANSPORT_DISCONNECTED')
  const bytes = new TextEncoder().encode(JSON.stringify(profile))
  const transferId = createProfileTransferId()
  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / PROFILE_CHUNK_BYTES))
  const sha256 = await sha256Hex(bytes)
  await postProfileTransferMessage(record, {
    type: 'AGENT_PROFILE_TRANSFER_BEGIN',
    captureId: state.captureId,
    sessionId: state.sessionId,
    nonce: state.nonce,
    profileTransferId: transferId,
    chunkCount,
    byteLength: bytes.byteLength,
    sha256
  })
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = bytes.slice(index * PROFILE_CHUNK_BYTES, (index + 1) * PROFILE_CHUNK_BYTES)
    await postProfileTransferMessage(record, {
      type: 'AGENT_PROFILE_TRANSFER_CHUNK',
      captureId: state.captureId,
      sessionId: state.sessionId,
      nonce: state.nonce,
      profileTransferId: transferId,
      chunkIndex: index,
      chunkCount,
      chunkByteLength: chunk.byteLength,
      payloadBase64: bytesToBase64(chunk)
    })
  }
  await postProfileTransferMessage(record, {
    type: 'AGENT_PROFILE_TRANSFER_COMPLETE',
    captureId: state.captureId,
    sessionId: state.sessionId,
    nonce: state.nonce,
    profileTransferId: transferId,
    byteLength: bytes.byteLength,
    sha256
  })
}
