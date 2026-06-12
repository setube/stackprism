import type {
  AgentBridgeError,
  AgentCaptureInclude,
  AgentCaptureOptions,
  AgentCaptureRequest,
  AgentCaptureTargetMode,
  AgentCaptureViewport
} from '@/types/agent-bridge'
import { bridgeProtocolVersion } from '@/types/agent-bridge'

const includeOrder: AgentCaptureInclude[] = ['tech', 'visual', 'layout', 'components', 'interaction', 'ux', 'assets']
const allowedIncludes = new Set<AgentCaptureInclude>(includeOrder)
const allowedTargetModes = new Set<AgentCaptureTargetMode>(['reuse_or_new_tab', 'new_tab', 'active_tab'])
const requestKeys = ['url', 'mode', 'waitMs', 'include', 'viewports', 'options', 'protocolVersion']
const viewportKeys = ['name', 'width', 'height', 'deviceScaleFactor']
const optionKeys = [
  'forceRefresh',
  'captureScreenshotMetadata',
  'captureScreenshot',
  'keepTabOpen',
  'allowPrivateNetworkTarget',
  'targetMode',
  'maxResourceUrls'
]
const booleanOptionKeys = ['forceRefresh', 'captureScreenshotMetadata', 'keepTabOpen', 'allowPrivateNetworkTarget']

const error = (code: AgentBridgeError['code'], message: string, details: Record<string, unknown> = {}): AgentBridgeError => ({
  code,
  message,
  details
})

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key))
const isViewportName = (value: unknown): boolean =>
  value === undefined || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value))

export const normalizeComparableUrl = (value: unknown): string => {
  try {
    const url = new URL(String(value || '').trim())
    if (!/^https?:$/.test(url.protocol)) return ''
    if (url.username || url.password) return ''
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    url.hash = ''
    if (!url.pathname) url.pathname = '/'
    return url.toString()
  } catch {
    return ''
  }
}

const validateViewports = (viewports: unknown): viewports is AgentCaptureViewport[] =>
  Array.isArray(viewports) &&
  viewports.length <= 3 &&
  viewports.every(
    viewport =>
      viewport &&
      typeof viewport === 'object' &&
      hasOnlyKeys(viewport as Record<string, unknown>, viewportKeys) &&
      isViewportName((viewport as Record<string, unknown>).name) &&
      Number.isInteger((viewport as AgentCaptureViewport).width) &&
      Number.isInteger((viewport as AgentCaptureViewport).height) &&
      Number((viewport as AgentCaptureViewport).width) >= 320 &&
      Number((viewport as AgentCaptureViewport).width) <= 3840 &&
      Number((viewport as AgentCaptureViewport).height) >= 320 &&
      Number((viewport as AgentCaptureViewport).height) <= 2160 &&
      typeof (viewport as AgentCaptureViewport).deviceScaleFactor === 'number' &&
      Number.isFinite((viewport as AgentCaptureViewport).deviceScaleFactor) &&
      (viewport as AgentCaptureViewport).deviceScaleFactor >= 1 &&
      (viewport as AgentCaptureViewport).deviceScaleFactor <= 4
  )

const validateOptions = (options: AgentCaptureOptions & Record<string, unknown>): boolean =>
  Boolean(options) &&
  hasOnlyKeys(options, optionKeys) &&
  booleanOptionKeys.every(key => typeof options[key] === 'boolean') &&
  (options.captureScreenshot === undefined || typeof options.captureScreenshot === 'boolean') &&
  allowedTargetModes.has(options.targetMode) &&
  Number.isInteger(options.maxResourceUrls) &&
  options.maxResourceUrls >= 0 &&
  options.maxResourceUrls <= 1000

export const validateAgentCaptureRequest = (
  request: AgentCaptureRequest
): { ok: true; request: AgentCaptureRequest } | { ok: false; error: AgentBridgeError } => {
  if (!request || typeof request !== 'object' || !hasOnlyKeys(request as unknown as Record<string, unknown>, requestKeys)) {
    return { ok: false, error: error('INVALID_REQUEST', 'Capture request contains unknown fields.') }
  }
  if (request.protocolVersion !== bridgeProtocolVersion) {
    return { ok: false, error: error('BRIDGE_PROTOCOL_UNSUPPORTED', 'Capture request protocol version is unsupported.') }
  }
  if (request.mode !== 'experience') return { ok: false, error: error('INVALID_REQUEST', 'Unsupported capture mode.') }

  const url = normalizeComparableUrl(request.url)
  if (!url || url.length > 4096) return { ok: false, error: error('INVALID_REQUEST', 'Target URL is invalid.') }
  if (!Array.isArray(request.include) || !request.include.length || request.include.some(item => !allowedIncludes.has(item))) {
    return { ok: false, error: error('INVALID_REQUEST', 'Capture include sections are invalid.') }
  }
  if (!Number.isInteger(request.waitMs) || request.waitMs < 0 || request.waitMs > 30000) {
    return { ok: false, error: error('INVALID_REQUEST', 'Capture waitMs is invalid.') }
  }
  if (!validateViewports(request.viewports)) return { ok: false, error: error('INVALID_REQUEST', 'Capture viewports are invalid.') }
  if (!validateOptions(request.options as AgentCaptureOptions & Record<string, unknown>)) {
    return { ok: false, error: error('INVALID_REQUEST', 'Capture options are invalid.') }
  }
  return {
    ok: true,
    request: {
      ...request,
      url,
      include: includeOrder.filter(item => request.include.includes(item)),
      options: { ...request.options, captureScreenshot: request.options.captureScreenshot === true }
    }
  }
}
