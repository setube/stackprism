import type {
  AgentBridgeCapabilities,
  AgentBridgeError,
  AgentBridgeRuntimeMessage,
  AgentCaptureRequest,
  AgentCaptureStatus,
  AgentProfileTransferAckMessage,
  AgentProfileTransferCompleteMessage,
  SiteExperienceProfile
} from '@/types/agent-bridge'

const errorFromUnknown = (error: unknown, fallback: AgentBridgeError['code']): AgentBridgeError => {
  const bridgeError = (error as { bridgeError?: AgentBridgeError } | null)?.bridgeError
  if (bridgeError?.code) return bridgeError
  return {
    code: fallback,
    message: error instanceof Error ? error.message : 'Agent Bridge request failed.'
  }
}

export const runAgentBridgeClient = async (): Promise<void> => {
  type BridgePageContext = {
    bridgeOrigin: string
    sessionId: string
    captureId: string
    nonce: string
    bridgeToken: string
    protocolVersion: number
  }
  type BridgeTransferContext = Omit<BridgePageContext, 'bridgeToken' | 'protocolVersion'>
  type StatusPoster = (status: AgentCaptureStatus, phase?: string, error?: AgentBridgeError) => Promise<void>
  type BridgeRequester = (path: string, init?: RequestInit) => Promise<any>
  type TransferResponse = { ok: true; data: null } | { ok: false; error: AgentBridgeError }
  type TransferState = {
    chunks: Array<Uint8Array | null>
    byteLength: number
    expiresAt: number
    chunkCount: number
    nextChunkIndex: number
    sha256: string
  }

  const bridgeProtocolVersion = 1 as const
  const AGENT_PROFILE_TRANSFER_PORT = 'stackprism-agent-profile-transfer'
  const REQUIRED_AGENT_BRIDGE_CAPABILITIES = [
    'agentBridge',
    'siteExperienceProfileV1',
    'profileChunkTransport',
    'bridgeContentPost',
    'storageSession',
    'experienceProfiler'
  ] as const
  const AGENT_BRIDGE_ERROR_CODES = [
    'NOT_FOUND',
    'METHOD_NOT_ALLOWED',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'ORIGIN_NOT_ALLOWED',
    'UNSUPPORTED_MEDIA_TYPE',
    'UNSUPPORTED_TRANSFER_ENCODING',
    'INVALID_JSON',
    'INVALID_REQUEST',
    'REQUEST_TOO_LARGE',
    'REQUEST_TIMEOUT',
    'SERVER_BUSY',
    'STALE_STATUS_UPDATE',
    'PORT_IN_USE',
    'BRIDGE_INVALID_ENV',
    'BRIDGE_START_FAILED',
    'BRIDGE_START_TIMEOUT',
    'BRIDGE_READY_PARSE_FAILED',
    'BRIDGE_PROTOCOL_UNSUPPORTED',
    'BRIDGE_PAGE_RENDER_FAILED',
    'BRIDGE_REQUEST_TIMEOUT',
    'BRIDGE_REQUEST_MISMATCH',
    'AGENT_BRIDGE_DISABLED',
    'CAPTURE_BUSY',
    'CAPTURE_TIMEOUT',
    'EXTENSION_NOT_CONNECTED',
    'BROWSER_OPEN_FAILED',
    'BRIDGE_TOKEN_CANNOT_READ_PROFILE',
    'PRIVATE_NETWORK_TARGET_BLOCKED',
    'TARGET_DNS_LOOKUP_FAILED',
    'BRIDGE_SELF_TARGET_BLOCKED',
    'FINAL_URL_BLOCKED',
    'ACTIVE_TAB_UNAVAILABLE',
    'ACTIVE_TAB_MISMATCH',
    'INCOGNITO_NOT_SUPPORTED',
    'TARGET_LOAD_TIMEOUT',
    'TARGET_LOAD_FAILED',
    'TARGET_INJECTION_FAILED',
    'TARGET_TAB_CLOSED',
    'BRIDGE_TAB_CLOSED',
    'TARGET_NAVIGATED_AWAY',
    'SERVICE_WORKER_RESTARTED',
    'BRIDGE_TRANSPORT_DISCONNECTED',
    'PROFILE_TRANSPORT_FAILED',
    'PROFILE_CHUNK_MISSING',
    'PROFILE_HASH_MISMATCH',
    'PROFILE_TOO_LARGE',
    'RATE_LIMITED',
    'NONCE_REUSED',
    'CAPTURE_ALREADY_COMPLETED',
    'CAPTURE_RESULT_EXPIRED',
    'NOT_SUPPORTED'
  ] as const
  const protocolIdentifierSpecs = {
    bridgeToken: /^spbt_[A-Za-z0-9_-]{43}$/,
    captureId: /^cap_[A-Za-z0-9_-]{22}$/,
    sessionId: /^s_[A-Za-z0-9_-]{22}$/,
    nonce: /^n_[A-Za-z0-9_-]{22}$/
  } as const
  const REQUEST_FIELDS = new Set(['url', 'mode', 'waitMs', 'include', 'viewports', 'options', 'protocolVersion'])
  const VIEWPORT_FIELDS = new Set(['name', 'width', 'height', 'deviceScaleFactor'])
  const OPTION_FIELDS = new Set([
    'forceRefresh',
    'captureScreenshotMetadata',
    'captureScreenshot',
    'keepTabOpen',
    'allowPrivateNetworkTarget',
    'targetMode',
    'maxResourceUrls'
  ])
  const REQUEST_ENVELOPE_FIELDS = new Set(['captureId', 'sessionId', 'nonce', 'protocolVersion', 'request'])
  const ALLOWED_INCLUDES = new Set(['tech', 'visual', 'layout', 'components', 'interaction', 'ux', 'assets'])
  const ALLOWED_TARGET_MODES = new Set(['reuse_or_new_tab', 'new_tab', 'active_tab'])
  const BRIDGE_QUERY_KINDS = { session: 'sessionId', capture: 'captureId', nonce: 'nonce' } as const
  const BRIDGE_META_SELECTOR = 'meta[name="stackprism-agent-bridge"][content="1"]'
  const CONFIG_SELECTOR = '#stackprism-agent-bridge-config[type="application/json"]'
  const STATUS_PHASES = new Set([
    'bridge_connected',
    'request_loaded',
    'target_opening',
    'target_loaded',
    'detecting_tech',
    'profiling_experience',
    'posting_profile',
    'cleanup'
  ])
  const CONTROL_POLL_MS = 1000
  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired'])
  const KNOWN_ERROR_CODES = new Set<string>(AGENT_BRIDGE_ERROR_CODES)
  const PHASE_ORDER = new Map([...STATUS_PHASES].map((phase, index) => [phase, index]))
  const transferState = new Map<string, TransferState>()
  const TRANSFER_TTL_MS = 30000
  const PROFILE_CHUNK_BYTES = 384 * 1024
  const PROFILE_BODY_BYTES = 8 * 1024 * 1024
  const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/
  const PROFILE_TRANSFER_ID_PATTERN = /^xfer_[A-Za-z0-9_-]{22}$/

  const makeError = (code: AgentBridgeError['code'], message: string, details: Record<string, unknown> = {}): AgentBridgeError => ({
    code,
    message,
    details
  })
  const runtimeErrorFromUnknown = (error: unknown, fallback: AgentBridgeError['code']): AgentBridgeError => {
    const bridgeError = (error as { bridgeError?: AgentBridgeError } | null)?.bridgeError
    if (bridgeError?.code) return bridgeError
    const message = error instanceof Error ? error.message : String(error || fallback)
    const code = KNOWN_ERROR_CODES.has(message) ? (message as AgentBridgeError['code']) : fallback
    return makeError(code, KNOWN_ERROR_CODES.has(message) ? message : 'Agent Bridge request failed.')
  }
  const validateProtocolIdentifier = (kind: keyof typeof protocolIdentifierSpecs | string, value: unknown): boolean => {
    const spec = protocolIdentifierSpecs[kind as keyof typeof protocolIdentifierSpecs]
    return typeof value === 'string' && Boolean(spec?.test(value))
  }
  const isBridgePageUrl = (value: unknown): boolean => {
    try {
      const url = new URL(String(value || ''))
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/bridge'
    } catch {
      return false
    }
  }
  const parseRawBridgeQuery = (url: URL): { session: string; capture: string; nonce: string } | null => {
    const raw = url.search.replace(/^\?/, '')
    const parts = raw ? raw.split('&') : []
    if (parts.length !== 3) return null
    const values: Record<string, string> = {}
    for (const part of parts) {
      const separatorIndex = part.indexOf('=')
      if (!part || separatorIndex <= 0 || part.indexOf('=', separatorIndex + 1) !== -1) return null
      const name = part.slice(0, separatorIndex)
      const value = part.slice(separatorIndex + 1)
      const kind = BRIDGE_QUERY_KINDS[name as keyof typeof BRIDGE_QUERY_KINDS]
      if (!kind || values[name] !== undefined || !validateProtocolIdentifier(kind, value)) return null
      values[name] = value
    }
    return values.session && values.capture && values.nonce ? { session: values.session, capture: values.capture, nonce: values.nonce } : null
  }
  const parseBridgePageContext = (href: string, configText: string): BridgePageContext => {
    const url = new URL(href)
    const query = parseRawBridgeQuery(url)
    const sessionId = query?.session || ''
    const captureId = query?.capture || ''
    const nonce = query?.nonce || ''
    let config: Record<string, unknown>
    try {
      config = JSON.parse(configText || '{}')
    } catch {
      throw new Error('INVALID_REQUEST')
    }
    const bridgeToken = String(config.bridgeToken || '')
    const protocolVersion = config.protocolVersion
    if (
      !query ||
      String(config.sessionId || '') !== sessionId ||
      String(config.captureId || '') !== captureId ||
      String(config.nonce || '') !== nonce ||
      !validateProtocolIdentifier('bridgeToken', bridgeToken) ||
      typeof protocolVersion !== 'number' ||
      !Number.isInteger(protocolVersion)
    ) {
      throw new Error('INVALID_REQUEST')
    }
    return { bridgeOrigin: url.origin, sessionId, captureId, nonce, bridgeToken, protocolVersion }
  }
  const isCaptureViewport = (viewport: any): boolean =>
    viewport &&
    typeof viewport === 'object' &&
    Object.keys(viewport).every(key => VIEWPORT_FIELDS.has(key)) &&
    (viewport.name === undefined || (typeof viewport.name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(viewport.name))) &&
    Number.isInteger(viewport.width) &&
    viewport.width >= 320 &&
    viewport.width <= 3840 &&
    Number.isInteger(viewport.height) &&
    viewport.height >= 320 &&
    viewport.height <= 2160 &&
    typeof viewport.deviceScaleFactor === 'number' &&
    Number.isFinite(viewport.deviceScaleFactor) &&
    viewport.deviceScaleFactor >= 1 &&
    viewport.deviceScaleFactor <= 4
  const isCaptureRequest = (value: any): value is AgentCaptureRequest =>
    value &&
    typeof value === 'object' &&
    Object.keys(value).every(key => REQUEST_FIELDS.has(key)) &&
    typeof value.url === 'string' &&
    value.mode === 'experience' &&
    Number.isInteger(value.waitMs) &&
    value.waitMs >= 0 &&
    value.waitMs <= 30000 &&
    Array.isArray(value.include) &&
    value.include.length > 0 &&
    value.include.every((section: unknown) => typeof section === 'string' && ALLOWED_INCLUDES.has(section)) &&
    Array.isArray(value.viewports) &&
    value.viewports.length <= 3 &&
    value.viewports.every(isCaptureViewport) &&
    value.options &&
    typeof value.options === 'object' &&
    Object.keys(value.options).every(key => OPTION_FIELDS.has(key)) &&
    ['forceRefresh', 'captureScreenshotMetadata', 'keepTabOpen', 'allowPrivateNetworkTarget'].every(
      key => typeof value.options[key] === 'boolean'
    ) &&
    (value.options.captureScreenshot === undefined || typeof value.options.captureScreenshot === 'boolean') &&
    ALLOWED_TARGET_MODES.has(value.options.targetMode) &&
    Number.isInteger(value.options.maxResourceUrls) &&
    value.options.maxResourceUrls >= 0 &&
    value.options.maxResourceUrls <= 1000 &&
    value.protocolVersion === bridgeProtocolVersion
  const validateCaptureRequestEnvelope = (context: BridgePageContext, value: any): AgentCaptureRequest => {
    if (
      !value ||
      typeof value !== 'object' ||
      !Object.keys(value).every(key => REQUEST_ENVELOPE_FIELDS.has(key)) ||
      value?.captureId !== context.captureId ||
      value?.sessionId !== context.sessionId ||
      value?.nonce !== context.nonce ||
      value?.protocolVersion !== bridgeProtocolVersion ||
      !isCaptureRequest(value.request)
    ) {
      throw new Error('BRIDGE_REQUEST_MISMATCH')
    }
    return value.request
  }
  const readBridgeJson = async (response: Response): Promise<any> => {
    try {
      return await response.json()
    } catch {
      return {
        error: {
          code: 'PROFILE_TRANSPORT_FAILED',
          message: 'Agent Bridge returned a non-JSON response.',
          details: { status: response.status }
        }
      }
    }
  }
  const requestJson = async (context: BridgePageContext, path: string, init: RequestInit = {}) => {
    const response = await fetch(`${context.bridgeOrigin}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${context.bridgeToken}`,
        ...(init.headers || {})
      },
      cache: 'no-store'
    })
    const body = await readBridgeJson(response)
    if (!response.ok) {
      const error = new Error(body?.error?.code || `BRIDGE_HTTP_${response.status}`) as Error & { bridgeError?: AgentBridgeError }
      error.bridgeError = body?.error || {
        code: 'PROFILE_TRANSPORT_FAILED',
        message: 'Agent Bridge request failed.',
        details: { status: response.status }
      }
      throw error
    }
    return body
  }
  const createStatusPoster = (context: BridgePageContext) => {
    let sequence = 0
    return async (
      status: AgentCaptureStatus,
      phase?: string,
      error?: AgentBridgeError,
      extra: Record<string, unknown> = {},
      requestInit: RequestInit = {}
    ) => {
      sequence += 1
      await requestJson(context, `/v1/captures/${context.captureId}/status`, {
        method: 'POST',
        ...requestInit,
        body: JSON.stringify({
          captureId: context.captureId,
          sessionId: context.sessionId,
          nonce: context.nonce,
          protocolVersion: bridgeProtocolVersion,
          status,
          phase: normalizeWritableStatusPhase(status, phase && STATUS_PHASES.has(phase) ? phase : undefined),
          sequence,
          error,
          ...extra
        })
      })
    }
  }
  const hasRequiredCapabilities = (capabilities: AgentBridgeCapabilities): boolean =>
    REQUIRED_AGENT_BRIDGE_CAPABILITIES.every(capability => capabilities?.[capability] === true)
  const missingRequiredCapability = (capabilities: AgentBridgeCapabilities): string | undefined =>
    REQUIRED_AGENT_BRIDGE_CAPABILITIES.find(capability => capabilities?.[capability] !== true)
  const normalizeWritableStatusPhase = (status: AgentCaptureStatus, phase?: string): string | undefined =>
    status === 'cancelled' ? 'cleanup' : status === 'failed' ? phase || 'cleanup' : phase
  const laterPhase = (left: string, right: string): string => {
    const leftOrder = PHASE_ORDER.get(left) ?? -1
    const rightOrder = PHASE_ORDER.get(right) ?? -1
    return rightOrder > leftOrder ? right : left
  }
  const runtimeTransportError = (code: AgentBridgeError['code']): Error & { bridgeError: AgentBridgeError } => {
    const error = new Error(code) as Error & { bridgeError: AgentBridgeError }
    error.bridgeError = makeError(code, 'Agent Bridge extension transport is unavailable.', { transport: 'chrome.runtime.sendMessage' })
    return error
  }
  const sendRuntimeMessage = (message: AgentBridgeRuntimeMessage, failureCode: AgentBridgeError['code']): Promise<any> =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          reject(runtimeTransportError(failureCode))
          return
        }
        resolve(response)
      })
    })
  const isStatusMessageForContext = (context: BridgePageContext, message: AgentBridgeRuntimeMessage): boolean =>
    message.type === 'AGENT_CAPTURE_STATUS' &&
    message.payload?.captureId === context.captureId &&
    message.payload.sessionId === context.sessionId &&
    message.payload.nonce === context.nonce &&
    message.payload.protocolVersion === bridgeProtocolVersion
  const isIncognitoExtensionContext = (): boolean =>
    (chrome as { extension?: { inIncognitoContext?: boolean } }).extension?.inIncognitoContext === true
  const startControlPolling = (context: BridgePageContext) => {
    const intervalId = window.setInterval(() => {
      requestJson(context, `/v1/captures/${context.captureId}/control`)
        .then(control => {
          const status = String(control?.status || '')
          if (TERMINAL_STATUSES.has(status)) {
            window.clearInterval(intervalId)
            return
          }
          if (status === 'cancel_requested' && control?.command === 'cancel') {
            window.clearInterval(intervalId)
            return sendRuntimeMessage(
              {
                type: 'AGENT_CAPTURE_CONTROL',
                captureId: context.captureId,
                sessionId: context.sessionId,
                nonce: context.nonce,
                command: 'cancel'
              },
              'BRIDGE_TRANSPORT_DISCONNECTED'
            )
          }
        })
        .catch(() => {})
    }, CONTROL_POLL_MS)
    return () => window.clearInterval(intervalId)
  }
  const registerCaptureStatusListener = (
    context: BridgePageContext,
    postStatus: (status: AgentCaptureStatus, phase?: string, error?: AgentBridgeError, extra?: Record<string, unknown>) => Promise<void>,
    stopControlPolling: () => void
  ) => {
    chrome.runtime.onMessage.addListener((message: AgentBridgeRuntimeMessage, _sender, sendResponse) => {
      if (message?.type !== 'AGENT_CAPTURE_STATUS') return false
      if (!isStatusMessageForContext(context, message)) {
        sendResponse({ ok: false, error: makeError('BRIDGE_REQUEST_MISMATCH', 'Agent capture status context mismatch.') })
        return false
      }
      if (TERMINAL_STATUSES.has(message.payload.status)) stopControlPolling()
      postStatus(message.payload.status, message.payload.phase, message.payload.error, {
        finalUrl: message.payload.finalUrl,
        targetNetworkAddress: message.payload.targetNetworkAddress,
        targetNetworkFromCache: message.payload.targetNetworkFromCache
      })
        .then(() => sendResponse({ ok: true, data: null }))
        .catch(error => sendResponse({ ok: false, error: error.bridgeError || runtimeErrorFromUnknown(error, 'BRIDGE_TRANSPORT_DISCONNECTED') }))
      return true
    })
  }
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
    'captureId' in message && message.captureId === context.captureId && message.sessionId === context.sessionId && message.nonce === context.nonce
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
  const completeProfileTransfer = async (
    context: BridgeTransferContext,
    postStatus: StatusPoster,
    requestJsonForTransfer: BridgeRequester,
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
      await requestJsonForTransfer(`/v1/captures/${context.captureId}/profile`, { method: 'POST', body: JSON.stringify(profile) })
      return { ok: true, data: null }
    } catch {
      await postStatus('failed', 'posting_profile', makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer payload is invalid.'))
      return { ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', 'Profile transfer payload is invalid.') }
    } finally {
      transferState.delete(message.profileTransferId)
    }
  }
  const handleTransferMessage = async (
    context: BridgeTransferContext,
    postStatus: StatusPoster,
    requestJsonForTransfer: BridgeRequester,
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
    if (message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE') return completeProfileTransfer(context, postStatus, requestJsonForTransfer, message)
    return { ok: false, error: makeError('PROFILE_TRANSPORT_FAILED', 'Unsupported profile transfer message.') }
  }
  const registerProfileTransferListener = (context: BridgeTransferContext, postStatus: StatusPoster, requestJsonForTransfer: BridgeRequester) => {
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
      handleTransferMessage(context, postStatus, requestJsonForTransfer, message)
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

  if (!isBridgePageUrl(location.href)) return
  const meta = document.querySelector(BRIDGE_META_SELECTOR)
  if (!meta) return
  if (document.documentElement.dataset.stackprismAgentBridgeClient === 'ready') return
  const configElement = document.querySelector(CONFIG_SELECTOR)
  let context: BridgePageContext
  try {
    context = parseBridgePageContext(location.href, configElement?.textContent || '')
  } catch (error) {
    document.documentElement.dataset.stackprismAgentBridgeError = runtimeErrorFromUnknown(error, 'INVALID_REQUEST').code
    return
  }
  const postStatus = createStatusPoster(context)
  let terminalStatusPosted = false
  let stopControlPolling = () => {}
  let currentPhase = 'bridge_connected'
  const postTrackedStatus = async (
    status: AgentCaptureStatus,
    phase?: string,
    error?: AgentBridgeError,
    extra: Record<string, unknown> = {},
    requestInit: RequestInit = {}
  ) => {
    if (phase && STATUS_PHASES.has(phase)) currentPhase = laterPhase(currentPhase, phase)
    const writablePhase = status === 'failed' ? currentPhase : phase
    if (TERMINAL_STATUSES.has(status)) {
      terminalStatusPosted = true
      stopControlPolling()
    }
    await postStatus(status, writablePhase, error, extra, requestInit)
  }
  const postBridgeClosed = () => {
    if (terminalStatusPosted) return
    if (context.bridgeOrigin !== location.origin || !isBridgePageUrl(location.href)) return
    terminalStatusPosted = true
    postStatus('failed', 'cleanup', makeError('BRIDGE_TAB_CLOSED', 'Agent bridge page was closed.'), {}, { keepalive: true }).catch(
      () => {}
    )
  }
  window.addEventListener('pagehide', postBridgeClosed, { once: true })
  window.addEventListener('beforeunload', postBridgeClosed, { once: true })
  document.documentElement.dataset.stackprismAgentBridgeClient = 'ready'

  try {
    if (isIncognitoExtensionContext()) {
      await postTrackedStatus(
        'failed',
        'bridge_connected',
        makeError('INCOGNITO_NOT_SUPPORTED', 'Incognito bridge pages are not supported.')
      )
      return
    }
    if (context.protocolVersion !== bridgeProtocolVersion) {
      await postTrackedStatus(
        'failed',
        'bridge_connected',
        makeError('BRIDGE_PROTOCOL_UNSUPPORTED', 'Bridge protocol version is unsupported.')
      )
      return
    }
    registerCaptureStatusListener(context, postTrackedStatus, () => stopControlPolling())
    const requestEnvelope = await requestJson(context, `/v1/captures/${context.captureId}/request`)
    const request = validateCaptureRequestEnvelope(context, requestEnvelope)
    await postTrackedStatus('waiting_extension', 'request_loaded')
    const hello = await sendRuntimeMessage(
      {
        type: 'AGENT_BRIDGE_HELLO',
        captureId: context.captureId,
        sessionId: context.sessionId,
        nonce: context.nonce,
        protocolVersion: bridgeProtocolVersion
      },
      'EXTENSION_NOT_CONNECTED'
    )
    if (!hello?.ok) {
      await postTrackedStatus('failed', 'request_loaded', hello?.error || makeError('INVALID_REQUEST', 'Agent bridge hello failed.'))
      return
    }
    if (!hasRequiredCapabilities(hello.data.capabilities)) {
      const missingCapability = missingRequiredCapability(hello.data.capabilities)
      await postTrackedStatus(
        'failed',
        'request_loaded',
        makeError('NOT_SUPPORTED', 'Required extension capabilities are missing.', { missingCapability })
      )
      return
    }
    registerProfileTransferListener(context, postTrackedStatus, (path, init) => requestJson(context, path, init))
    await postTrackedStatus('running', 'target_opening')
    const startResponse = await sendRuntimeMessage(
      {
        type: 'START_AGENT_CAPTURE',
        captureId: context.captureId,
        sessionId: context.sessionId,
        nonce: context.nonce,
        bridgeOrigin: context.bridgeOrigin,
        request,
        capabilities: hello.data.capabilities
      },
      'BRIDGE_TRANSPORT_DISCONNECTED'
    )
    if (!startResponse?.ok) {
      await postTrackedStatus(
        'failed',
        'target_opening',
        startResponse?.error || makeError('INVALID_REQUEST', 'Agent capture start failed.')
      )
      return
    }
    stopControlPolling = startControlPolling(context)
  } catch (error) {
    await postTrackedStatus('failed', currentPhase, runtimeErrorFromUnknown(error, 'PROFILE_TRANSPORT_FAILED')).catch(() => {})
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  runAgentBridgeClient().catch(error => {
    console.error('[StackPrism Agent Bridge] runAgentBridgeClient failed', {
      errorCode: errorFromUnknown(error, 'PROFILE_TRANSPORT_FAILED').code
    })
    document.documentElement.dataset.stackprismAgentBridgeError = 'PROFILE_TRANSPORT_FAILED'
  })
}
