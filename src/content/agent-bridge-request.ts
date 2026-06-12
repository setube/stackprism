import type { AgentCaptureRequest } from '@/types/agent-bridge'

const bridgeProtocolVersion = 1 as const
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
const BRIDGE_QUERY_KINDS = {
  session: 'sessionId',
  capture: 'captureId',
  nonce: 'nonce'
} as const

const validateProtocolIdentifier = (kind: keyof typeof protocolIdentifierSpecs | string, value: unknown): boolean => {
  const spec = protocolIdentifierSpecs[kind as keyof typeof protocolIdentifierSpecs]
  return typeof value === 'string' && Boolean(spec?.test(value))
}

export interface BridgePageContext {
  bridgeOrigin: string
  sessionId: string
  captureId: string
  nonce: string
  bridgeToken: string
  protocolVersion: number
}

export const isBridgePageUrl = (value: unknown): boolean => {
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

export const parseBridgePageContext = (href: string, configText: string): BridgePageContext => {
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
  const configSessionId = String(config.sessionId || '')
  const configCaptureId = String(config.captureId || '')
  const configNonce = String(config.nonce || '')
  const bridgeToken = String(config.bridgeToken || '')
  const protocolVersion = config.protocolVersion

  if (
    !query ||
    !validateProtocolIdentifier('sessionId', sessionId) ||
    !validateProtocolIdentifier('captureId', captureId) ||
    !validateProtocolIdentifier('nonce', nonce) ||
    configSessionId !== sessionId ||
    configCaptureId !== captureId ||
    configNonce !== nonce ||
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

export const validateCaptureRequestEnvelope = (context: BridgePageContext, value: any): AgentCaptureRequest => {
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
