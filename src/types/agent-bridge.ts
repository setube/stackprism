export const bridgeProtocolVersion = 1 as const
export const SITE_EXPERIENCE_PROFILE_SCHEMA = 'stackprism.site_experience_profile.v1' as const
export const AGENT_PROFILE_TRANSFER_PORT = 'stackprism-agent-profile-transfer' as const

export const REQUIRED_AGENT_BRIDGE_CAPABILITIES = [
  'agentBridge',
  'siteExperienceProfileV1',
  'profileChunkTransport',
  'bridgeContentPost',
  'storageSession',
  'experienceProfiler'
] as const

export const AGENT_BRIDGE_CAPABILITIES = [...REQUIRED_AGENT_BRIDGE_CAPABILITIES, 'rawProfile', 'viewportMetadata', 'visualScreenshot'] as const

export type AgentBridgeCapability = (typeof AGENT_BRIDGE_CAPABILITIES)[number]

export type AgentBridgeCapabilities = Record<AgentBridgeCapability, boolean>

export const AGENT_BRIDGE_ERROR_CODES = [
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

export type AgentBridgeErrorCode = (typeof AGENT_BRIDGE_ERROR_CODES)[number]

export interface AgentBridgeError {
  code: AgentBridgeErrorCode
  message: string
  details?: Record<string, unknown>
}

export const protocolIdentifierSpecs = {
  apiToken: /^spb_[A-Za-z0-9_-]{43}$/,
  bridgeToken: /^spbt_[A-Za-z0-9_-]{43}$/,
  captureId: /^cap_[A-Za-z0-9_-]{22}$/,
  sessionId: /^s_[A-Za-z0-9_-]{22}$/,
  nonce: /^n_[A-Za-z0-9_-]{22}$/,
  profileTransferId: /^xfer_[A-Za-z0-9_-]{22}$/,
  cspNonce: /^[A-Za-z0-9_-]{22}$/
} as const

export type ProtocolIdentifierKind = keyof typeof protocolIdentifierSpecs

export const validateProtocolIdentifier = (kind: ProtocolIdentifierKind | string, value: unknown): boolean => {
  const spec = protocolIdentifierSpecs[kind as ProtocolIdentifierKind]
  return typeof value === 'string' && Boolean(spec?.test(value))
}

export type AgentCaptureStatus =
  | 'queued'
  | 'waiting_extension'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'expired'

export type AgentCapturePhase =
  | 'bridge_connected'
  | 'request_loaded'
  | 'target_opening'
  | 'target_loaded'
  | 'detecting_tech'
  | 'profiling_experience'
  | 'posting_profile'
  | 'cleanup'

export type AgentCaptureInclude = 'tech' | 'visual' | 'layout' | 'components' | 'interaction' | 'ux' | 'assets'
export type AgentCaptureMode = 'experience'
export type AgentCaptureTargetMode = 'reuse_or_new_tab' | 'new_tab' | 'active_tab'

export interface AgentCaptureViewport {
  name?: string
  width: number
  height: number
  deviceScaleFactor: number
}

export interface AgentCaptureOptions {
  forceRefresh: boolean
  captureScreenshotMetadata: boolean
  captureScreenshot?: boolean
  keepTabOpen: boolean
  allowPrivateNetworkTarget: boolean
  targetMode: AgentCaptureTargetMode
  maxResourceUrls: number
}

export interface AgentCaptureScreenshot {
  dataUrl: string
  mimeType: 'image/jpeg'
  byteLength: number
  source: 'chrome.tabs.captureVisibleTab'
  scope: 'visible_viewport'
  capturedAt: string
}

export interface AgentProfileScreenshotReference {
  downloadUrl: string
  downloadMethod: 'GET' | 'file'
  localPath?: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  byteLength: number
  source: 'chrome.tabs.captureVisibleTab'
  scope: 'visible_viewport'
  capturedAt: string
  lifecycle: {
    requiresLocalBridge: boolean
    availableUntil: string
    note: string
  }
  profileJsonNote: string
  note: string
}

export interface AgentCaptureRequest {
  url: string
  mode: AgentCaptureMode
  waitMs: number
  include: AgentCaptureInclude[]
  viewports: AgentCaptureViewport[]
  options: AgentCaptureOptions
  protocolVersion: typeof bridgeProtocolVersion
}

export interface AgentCaptureStatusPayload {
  captureId: string
  sessionId: string
  nonce: string
  protocolVersion: typeof bridgeProtocolVersion
  status: AgentCaptureStatus
  phase?: AgentCapturePhase
  sequence?: number
  finalUrl?: string
  targetNetworkAddress?: string
  targetNetworkFromCache?: boolean
  error?: AgentBridgeError
}

export interface SiteExperienceProfile {
  schema: typeof SITE_EXPERIENCE_PROFILE_SCHEMA
  captureId: string
  generatedAt: string
  target: Record<string, unknown>
  browserContext: {
    extensionCapabilities: AgentBridgeCapabilities
    [key: string]: unknown
  }
  techProfile: Record<string, unknown>
  visualProfile: Record<string, unknown>
  layoutProfile: Record<string, unknown>
  componentProfile: Record<string, unknown>
  interactionProfile: Record<string, unknown>
  uxProfile: Record<string, unknown>
  assetProfile: Record<string, unknown>
  evidence: Record<string, unknown>
  limitations: string[]
  agentGuidance: Record<string, unknown>
}

export const START_AGENT_CAPTURE_MESSAGE_FIELDS = [
  'type',
  'captureId',
  'sessionId',
  'nonce',
  'bridgeOrigin',
  'request',
  'capabilities'
] as const
export const PROFILE_TRANSFER_BEGIN_FIELDS = [
  'type',
  'captureId',
  'sessionId',
  'nonce',
  'profileTransferId',
  'chunkCount',
  'byteLength',
  'sha256'
] as const
export const PROFILE_TRANSFER_CHUNK_FIELDS = [
  'type',
  'captureId',
  'sessionId',
  'nonce',
  'profileTransferId',
  'chunkIndex',
  'chunkCount',
  'chunkByteLength',
  'payloadBase64'
] as const
export const PROFILE_TRANSFER_COMPLETE_FIELDS = [
  'type',
  'captureId',
  'sessionId',
  'nonce',
  'profileTransferId',
  'byteLength',
  'sha256'
] as const

export interface AgentBridgeHelloMessage {
  type: 'AGENT_BRIDGE_HELLO'
  captureId: string
  sessionId: string
  nonce: string
  protocolVersion: typeof bridgeProtocolVersion
}

export interface StartAgentCaptureMessage {
  type: 'START_AGENT_CAPTURE'
  captureId: string
  sessionId: string
  nonce: string
  bridgeOrigin: string
  request: AgentCaptureRequest
  capabilities: AgentBridgeCapabilities
}

export interface AgentCaptureStatusMessage {
  type: 'AGENT_CAPTURE_STATUS'
  payload: AgentCaptureStatusPayload
}

export interface AgentCaptureControlMessage {
  type: 'AGENT_CAPTURE_CONTROL'
  captureId: string
  sessionId: string
  nonce: string
  command: 'continue' | 'cancel'
}

export interface AgentProfileTransferBeginMessage {
  type: 'AGENT_PROFILE_TRANSFER_BEGIN'
  captureId: string
  sessionId: string
  nonce: string
  profileTransferId: string
  chunkCount: number
  byteLength: number
  sha256: string
}

export interface AgentProfileTransferChunkMessage {
  type: 'AGENT_PROFILE_TRANSFER_CHUNK'
  captureId: string
  sessionId: string
  nonce: string
  profileTransferId: string
  chunkIndex: number
  chunkCount: number
  chunkByteLength: number
  payloadBase64: string
}

export interface AgentProfileTransferCompleteMessage {
  type: 'AGENT_PROFILE_TRANSFER_COMPLETE'
  captureId: string
  sessionId: string
  nonce: string
  profileTransferId: string
  byteLength: number
  sha256: string
}

export interface AgentProfileTransferAckMessage {
  type: 'AGENT_PROFILE_TRANSFER_ACK'
  captureId: string
  sessionId: string
  nonce: string
  profileTransferId: string
  chunkIndex?: number
  ok: boolean
  error?: AgentBridgeError
}

export interface AgentProfileTransferPortHelloMessage {
  type: 'AGENT_PROFILE_TRANSFER_PORT_HELLO'
  captureId: string
  sessionId: string
  nonce: string
  protocolVersion: typeof bridgeProtocolVersion
}

export type AgentBridgeRuntimeMessage =
  | AgentBridgeHelloMessage
  | StartAgentCaptureMessage
  | AgentCaptureStatusMessage
  | AgentCaptureControlMessage
  | AgentProfileTransferBeginMessage
  | AgentProfileTransferChunkMessage
  | AgentProfileTransferCompleteMessage
  | AgentProfileTransferAckMessage
  | AgentProfileTransferPortHelloMessage
