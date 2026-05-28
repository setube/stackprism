import { fail, htmlEscapeScriptJson, isKnownBridgeErrorCode, json, newCspNonce, protocolVersion, redactUrl, safeEqual } from './protocol.mjs'
import { renderBridgePageHtml } from './bridge-page.mjs'

export const finalStates = new Set(['completed', 'failed', 'cancelled', 'expired'])

const pluginWritableStatuses = new Set(['waiting_extension', 'running', 'cancelled', 'failed'])
const statusPhases = [
  'bridge_connected',
  'request_loaded',
  'target_opening',
  'target_loaded',
  'detecting_tech',
  'profiling_experience',
  'posting_profile',
  'cleanup'
]
const phaseOrder = new Map(statusPhases.map((phase, index) => [phase, index]))
const endpointMethods = { '': 'GET, DELETE', request: 'GET', control: 'GET', status: 'POST', profile: 'GET, POST' }

const tokenFrom = req => /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || ''

export const allowForCaptureEndpoint = endpoint => endpointMethods[endpoint] || 'GET, POST, DELETE'

export const auth = (req, capture, apiToken, scope) => {
  const token = tokenFrom(req)
  if (!token) return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Bearer token is required.' }
  if (scope === 'api' && safeEqual(token, apiToken)) return { ok: true, tokenType: 'api' }
  if (scope === 'bridge' && capture && safeEqual(token, capture.bridgeToken)) return { ok: true, tokenType: 'bridge' }
  if (scope === 'status' && (safeEqual(token, apiToken) || (capture && safeEqual(token, capture.bridgeToken)))) {
    return { ok: true, tokenType: safeEqual(token, apiToken) ? 'api' : 'bridge' }
  }
  return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Token is not allowed for this endpoint.' }
}

export const scopeForEndpoint = (method, endpoint) => {
  if (endpoint === '' && method === 'GET') return 'status'
  if (endpoint === 'request' || endpoint === 'control' || (method === 'POST' && ['status', 'profile'].includes(endpoint))) return 'bridge'
  return method === 'GET' && endpoint === 'profile' ? 'status' : 'api'
}

const screenshotDataUrlPattern = /^data:image\/(jpeg|png|webp);base64,/

const screenshotPreview = capture => {
  const screenshot = capture.profile?.visualProfile?.screenshot
  const match = typeof screenshot?.dataUrl === 'string' ? screenshot.dataUrl.match(screenshotDataUrlPattern) : null
  if (!match) {
    return null
  }
  return {
    dataUrl: screenshot.dataUrl,
    mimeType: `image/${match[1]}`,
    byteLength: screenshot.byteLength,
    scope: screenshot.scope
  }
}

const previewForCapture = capture => {
  const targetUrl = redactUrl(capture.finalUrl || capture.request?.url)
  const preview = {}
  if (targetUrl) preview.targetUrl = targetUrl
  const screenshot = capture.status === 'completed' ? screenshotPreview(capture) : null
  if (screenshot) preview.screenshot = screenshot
  return Object.keys(preview).length ? preview : undefined
}

export const publicStatus = capture => {
  const status = { id: capture.id, status: capture.status }
  if (capture.phase) status.phase = capture.phase
  if (capture.error) status.error = capture.error
  const preview = previewForCapture(capture)
  if (preview) status.preview = preview
  return status
}

export const terminalProfileErrorCode = status => (status === 'completed' ? 'CAPTURE_ALREADY_COMPLETED' : 'STALE_STATUS_UPDATE')

export const commitProfile = (store, capture, profile, { profileSchema }) => {
  if (finalStates.has(capture.status)) {
    return { ok: false, status: 409, code: terminalProfileErrorCode(capture.status), details: { status: capture.status } }
  }
  if (!capture.finalUrl) return { ok: false, status: 409, code: 'INVALID_REQUEST', message: 'Capture final URL has not been accepted.' }
  if (profile?.schema !== profileSchema || profile?.captureId !== capture.id) {
    return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Profile schema or capture id is invalid.' }
  }
  store.markProfile(capture, profile)
  return { ok: true, status: 200, body: publicStatus(capture) }
}

export const writeProfile = (res, result) =>
  result.ok
    ? json(res, result.status, result.body)
    : fail(res, result.status, result.code, result.message || 'Capture is already terminal.', result.details)

export const readProfile = (res, capture, tokenType, headers) => {
  if (tokenType === 'bridge') return fail(res, 403, 'BRIDGE_TOKEN_CANNOT_READ_PROFILE', 'Bridge token cannot read profile.', {}, headers)
  if (capture.status === 'expired') return fail(res, 410, 'CAPTURE_RESULT_EXPIRED', 'Capture result expired.', {}, headers)
  if (capture.status !== 'completed')
    return fail(res, 409, 'INVALID_REQUEST', 'Capture profile is not ready.', { status: capture.status }, headers)
  return json(res, 200, capture.profile, headers)
}

export const validateStatusUpdate = (capture, body) => {
  if (finalStates.has(capture.status)) {
    return { ok: false, code: 'STALE_STATUS_UPDATE', message: 'Capture is already terminal.' }
  }
  if (
    body?.captureId !== capture.id ||
    body?.sessionId !== capture.sessionId ||
    body?.nonce !== capture.nonce ||
    body?.protocolVersion !== protocolVersion
  ) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Capture status identity is invalid.' }
  }
  if (!pluginWritableStatuses.has(body?.status)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Capture status is invalid.' }
  }
  if (!phaseOrder.has(body?.phase)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Capture phase is invalid.' }
  }
  if (body.status === 'cancelled' && capture.status !== 'cancel_requested') {
    return { ok: false, code: 'STALE_STATUS_UPDATE', message: 'Capture cancellation was not requested.' }
  }
  if (capture.status === 'cancel_requested' && body.status !== 'cancelled') {
    return { ok: false, code: 'STALE_STATUS_UPDATE', message: 'Capture cancellation is already requested.' }
  }
  if (body.status === 'failed' && (!body.error?.code || !body.error?.message)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Failed status requires a structured error.' }
  }
  if (body.status === 'failed' && !isKnownBridgeErrorCode(body.error.code)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Failed status error code is invalid.' }
  }
  if ((body.status === 'cancelled' || body.status === 'failed') && body.phase !== 'cleanup') {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Terminal status must use cleanup phase.' }
  }
  if (!Number.isInteger(body.sequence) || body.sequence <= capture.sequence) {
    return { ok: false, code: 'STALE_STATUS_UPDATE', message: 'Capture status sequence is stale.' }
  }
  const currentPhaseOrder = phaseOrder.has(capture.phase) ? phaseOrder.get(capture.phase) : -1
  const nextPhaseOrder = phaseOrder.get(body.phase)
  if (nextPhaseOrder < currentPhaseOrder) {
    return { ok: false, code: 'STALE_STATUS_UPDATE', message: 'Capture phase cannot move backwards.' }
  }
  return { ok: true }
}

export const renderBridge = (res, capture) => {
  if (capture.status === 'expired') {
    return fail(res, 410, 'CAPTURE_RESULT_EXPIRED', 'Capture result expired.')
  }
  if (finalStates.has(capture.status)) {
    return fail(res, 409, capture.error?.code || 'INVALID_REQUEST', 'Capture is already terminal.', {
      status: capture.status
    })
  }
  if (capture.bridgeTokenRenderedAt || capture.bridgeTokenClaimedAt)
    return fail(res, 409, 'INVALID_REQUEST', 'Bridge token has already been used.')
  capture.bridgeTokenRenderedAt = Date.now()
  const cspNonce = newCspNonce()
  const config = htmlEscapeScriptJson({
    captureId: capture.id,
    sessionId: capture.sessionId,
    nonce: capture.nonce,
    bridgeToken: capture.bridgeToken,
    protocolVersion
  })
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${cspNonce}'; style-src 'nonce-${cspNonce}'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  })
  res.end(renderBridgePageHtml(cspNonce, config))
}
