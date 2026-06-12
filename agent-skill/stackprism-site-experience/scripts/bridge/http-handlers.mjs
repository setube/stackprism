import { fail, isKnownBridgeErrorCode, json, newCspNonce, protocolVersion, redactUrl, safeEqual } from './protocol.mjs'
import { renderBridgePageHtml } from './bridge-page.mjs'
import { profilePreviewSummary } from './profile-summary.mjs'
import { screenshotPreviewForCapture } from './profile-response.mjs'

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
const endpointMethods = {
  '': 'GET, DELETE',
  request: 'GET',
  control: 'GET',
  status: 'POST',
  profile: 'GET, POST',
  'profile-download': 'GET',
  'screenshot-download': 'GET'
}

const tokenFrom = req => /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || ''

export const allowForCaptureEndpoint = endpoint => endpointMethods[endpoint] || 'GET, POST, DELETE'

export const auth = (req, capture, apiToken, scope) => {
  const token = tokenFrom(req)
  if (!token) return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Bearer token is required.' }
  if (['api', 'download'].includes(scope) && safeEqual(token, apiToken)) return { ok: true, tokenType: 'api' }
  if (['bridge', 'download'].includes(scope) && capture && safeEqual(token, capture.bridgeToken)) return { ok: true, tokenType: 'bridge' }
  if (scope === 'status' && (safeEqual(token, apiToken) || (capture && safeEqual(token, capture.bridgeToken)))) {
    return { ok: true, tokenType: safeEqual(token, apiToken) ? 'api' : 'bridge' }
  }
  return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Token is not allowed for this endpoint.' }
}

export const scopeForEndpoint = (method, endpoint) => {
  if (endpoint === '' && method === 'GET') return 'status'
  if (endpoint === 'request' || endpoint === 'control' || (method === 'POST' && ['status', 'profile'].includes(endpoint))) return 'bridge'
  if (method === 'GET' && ['profile-download', 'screenshot-download'].includes(endpoint)) return 'download'
  return method === 'GET' && endpoint === 'profile' ? 'status' : 'api'
}

const previewForCapture = capture => {
  const targetUrl = redactUrl(capture.finalUrl || capture.request?.url)
  const preview = {}
  if (targetUrl) preview.targetUrl = targetUrl
  const screenshot = capture.status === 'completed' ? screenshotPreviewForCapture(capture) : null
  if (screenshot) preview.screenshot = screenshot
  const summary = profilePreviewSummary(capture, screenshot)
  if (summary) Object.assign(preview, summary)
  return Object.keys(preview).length ? preview : undefined
}

export const publicStatus = capture => {
  const status = { id: capture.id, status: capture.status }
  if (capture.phase) status.phase = capture.phase
  if (capture.error) status.error = capture.error
  if (capture.profileDownloadReadyAt) status.profileDownloadReady = true
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
  if (body.status === 'cancelled' && body.phase !== 'cleanup') {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Cancelled status must use cleanup phase.' }
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

const bridgePageState = capture => {
  if (capture.status === 'expired') return { kind: 'fail', args: [410, 'CAPTURE_RESULT_EXPIRED', 'Capture result expired.'] }
  if (finalStates.has(capture.status)) {
    return {
      kind: 'fail',
      args: [409, capture.error?.code || 'INVALID_REQUEST', 'Capture is already terminal.', { status: capture.status }]
    }
  }
  if (capture.bridgeTokenRenderedAt || capture.bridgeTokenClaimedAt) {
    return {
      kind: 'fail',
      args: [409, 'INVALID_REQUEST', 'Bridge token has already been rendered or claimed.']
    }
  }
  return {
    kind: 'config',
    config: {
      captureId: capture.id,
      sessionId: capture.sessionId,
      nonce: capture.nonce,
      bridgeToken: capture.bridgeToken,
      targetUrl: redactUrl(capture.request?.url),
      protocolVersion
    }
  }
}

const buildBridgePage = (capture, now = Date.now) => {
  const state = bridgePageState(capture)
  if (state.kind === 'fail') return state
  const cspNonce = newCspNonce()
  try {
    const html = renderBridgePageHtml(cspNonce, state.config)
    capture.bridgeTokenRenderedAt = now()
    return { kind: 'html', cspNonce, html }
  } catch {
    return { kind: 'fail', args: [500, 'BRIDGE_PAGE_RENDER_FAILED', 'Bridge page render failed.'] }
  }
}

export const renderBridge = async (res, capture, { store } = {}) => {
  const page = store?.withCaptureLock
    ? await store.withCaptureLock(capture.id, async () => {
        const lockedCapture = store.get(capture.id)
        return lockedCapture ? buildBridgePage(lockedCapture, store.now) : { kind: 'fail', args: [404, 'NOT_FOUND', 'Capture not found.'] }
      })
    : buildBridgePage(capture)
  if (page.kind === 'fail') return fail(res, ...page.args)
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${page.cspNonce}'; style-src 'nonce-${page.cspNonce}'; img-src data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  })
  res.end(page.html)
}
