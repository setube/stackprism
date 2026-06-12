import http from 'node:http'
import { CaptureStore } from './capture-store.mjs'
import {
  allowForCaptureEndpoint,
  auth,
  commitProfile,
  finalStates,
  publicStatus,
  renderBridge,
  scopeForEndpoint,
  terminalProfileErrorCode,
  validateStatusUpdate,
  writeProfile
} from './http-handlers.mjs'
import { openBrowser, parseOpenConfig } from './open-browser.mjs'
import { parseBridgeQuery, readJson, rejectBadRequestShell, rejectCrossOriginSensitiveRequest, validateBridgeQuery } from './security.mjs'
import { validateTargetNetworkAddress } from './target-network-policy.mjs'
import { normalizeCaptureRequest, validateFinalUrl } from './url-policy.mjs'
import {
  errorBody,
  fail,
  isValidId,
  json,
  newApiToken,
  profileSchema,
  protocolVersion,
  safeEqual,
  sanitizeBridgeError,
  service,
  version
} from './protocol.mjs'
import { readProfile, readProfileDownload, readScreenshotDownload } from './profile-response.mjs'
import {
  applyServerResourcePolicy,
  DEFAULT_CREATE_LIMIT_PER_MINUTE,
  DEFAULT_QUERY_LIMIT_PER_MINUTE,
  DEFAULT_RESOURCE_POLICY,
  makeRateLimiter
} from './resource-policy.mjs'

const isQueryEndpoint = (method, endpoint) => method === 'GET' && (endpoint === '' || endpoint === 'profile')
const profileHeaders = { 'Referrer-Policy': 'no-referrer' }
const methodNotAllowed = (res, allow) => fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method is not supported.', {}, { Allow: allow })
const failParsedRequest = (res, parsed, code = parsed.code) =>
  fail(res, parsed.status, code, parsed.message, {}, parsed.close ? { Connection: 'close' } : {})
const socketJsonError = (socket, statusLine, message) => {
  if (!socket.writable) return
  const body = JSON.stringify(errorBody('INVALID_REQUEST', message))
  socket.end(
    [
      statusLine,
      'Content-Type: application/json; charset=utf-8',
      'Cache-Control: no-store',
      'X-Content-Type-Options: nosniff',
      'Connection: close',
      `Content-Length: ${Buffer.byteLength(body)}`,
      `\r\n${body}`
    ].join('\r\n')
  )
}

const captureFromPath = (store, pathname) => {
  const match =
    /^\/v1\/captures\/([^/]+)(?:\/(request|control|status|profile|profile-download)|\/(screenshot-download)\/([^/]+))?$/.exec(pathname)
  if (!match || !isValidId('captureId', match[1])) return null
  const capture = store.get(match[1])
  return capture ? { capture, endpoint: match[2] || match[3] || '', screenshotDownloadId: match[4] || '' } : { missing: true }
}

export const createBridgeServer = ({ port = 0, env = process.env, resolveHostname, now, rateLimits, resourcePolicy, resultTtlMs } = {}) => {
  const openConfig = parseOpenConfig(env)
  if (!openConfig.ok) throw Object.assign(new Error(openConfig.message), { code: openConfig.code })
  const apiToken = newApiToken()
  let baseUrl = ''
  let store
  const allowRate = makeRateLimiter(rateLimits)
  const policy = { ...DEFAULT_RESOURCE_POLICY, ...(resourcePolicy || {}) }
  const server = http.createServer({ requireHostHeader: false }, async (req, res) => {
    const rejected = rejectBadRequestShell(req, res, baseUrl)
    if (rejected) return rejected
    const url = new URL(req.url || '/', baseUrl)

    if (req.method === 'OPTIONS') return methodNotAllowed(res, 'GET, POST, DELETE')
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service, version, protocolVersion, bound: '127.0.0.1', activeCaptures: store.activeCount() })
    }
    if (url.pathname === '/health') return methodNotAllowed(res, 'GET')
    if (req.method === 'GET' && url.pathname === '/bridge') {
      const rejectedOrigin = rejectCrossOriginSensitiveRequest(req, res, baseUrl)
      if (rejectedOrigin) return rejectedOrigin
      if (!validateBridgeQuery(url)) return fail(res, 400, 'INVALID_REQUEST', 'Bridge query is invalid.')
      const query = parseBridgeQuery(url.search)
      const capture = query?.capture && store.get(query.capture)
      if (!capture || capture.sessionId !== query.session || capture.nonce !== query.nonce) {
        return fail(res, 404, 'NOT_FOUND', 'Capture bridge page was not found.')
      }
      return renderBridge(res, capture, { store })
    }
    if (url.pathname === '/bridge') return methodNotAllowed(res, 'GET')
    if (req.method === 'POST' && url.pathname === '/v1/captures') {
      const rejectedOrigin = rejectCrossOriginSensitiveRequest(req, res, baseUrl)
      if (rejectedOrigin) return rejectedOrigin
      const allowed = auth(req, null, apiToken, 'api')
      if (!allowed.ok) return fail(res, allowed.status, allowed.code, allowed.message)
      if (!allowRate(apiToken, 'create', rateLimits?.createLimitPerMinute ?? DEFAULT_CREATE_LIMIT_PER_MINUTE, now?.() ?? Date.now())) {
        return fail(res, 429, 'RATE_LIMITED', 'Agent bridge rate limit exceeded.')
      }
      const parsed = await readJson(req, 5 * 1024 * 1024, policy.requestTimeoutMs)
      if (!parsed.ok) return failParsedRequest(res, parsed)
      const normalized = await normalizeCaptureRequest(parsed.body, baseUrl, { resolveHostname })
      if (!normalized.ok) return fail(res, 400, normalized.code, normalized.message, normalized.details)
      const created = await store.create(normalized.request)
      if (!created.ok) return fail(res, created.status, created.code, created.message, created.details)
      return json(res, 200, {
        id: created.capture.id,
        status: created.capture.status,
        bridgeUrl: created.capture.bridgeUrl,
        profileUrl: created.capture.profileUrl
      })
    }
    if (url.pathname === '/v1/captures') return methodNotAllowed(res, 'POST')

    const routed = captureFromPath(store, url.pathname)
    if (!routed) return fail(res, 404, 'NOT_FOUND', 'Endpoint was not found.')
    if (routed.missing) return fail(res, 404, 'NOT_FOUND', 'Capture was not found.')
    const { capture, endpoint, screenshotDownloadId } = routed
    const rejectedOrigin = rejectCrossOriginSensitiveRequest(req, res, baseUrl)
    if (rejectedOrigin) return rejectedOrigin
    if (req.method === 'GET' && endpoint === 'screenshot-download') {
      if (!isValidId('screenshotDownloadId', screenshotDownloadId) || !safeEqual(screenshotDownloadId, capture.screenshotDownloadId)) {
        return fail(res, 403, 'FORBIDDEN', 'Screenshot download URL is not valid for this capture.', {}, profileHeaders)
      }
      return readScreenshotDownload(res, capture, profileHeaders, { store })
    }
    const allowed = auth(req, capture, apiToken, scopeForEndpoint(req.method, endpoint))
    if (!allowed.ok) return fail(res, allowed.status, allowed.code, allowed.message)
    if (
      allowed.tokenType === 'api' &&
      isQueryEndpoint(req.method, endpoint) &&
      !allowRate(apiToken, 'query', rateLimits?.queryLimitPerMinute ?? DEFAULT_QUERY_LIMIT_PER_MINUTE, now?.() ?? Date.now())
    ) {
      return fail(res, 429, 'RATE_LIMITED', 'Agent bridge rate limit exceeded.')
    }

    if (req.method === 'GET' && endpoint === '') return json(res, 200, publicStatus(capture))
    if (req.method === 'GET' && endpoint === 'request') {
      capture.bridgeTokenClaimedAt = capture.bridgeTokenClaimedAt || (now?.() ?? Date.now())
      return json(res, 200, {
        captureId: capture.id,
        sessionId: capture.sessionId,
        nonce: capture.nonce,
        protocolVersion,
        request: capture.request
      })
    }
    if (req.method === 'GET' && endpoint === 'control') {
      return json(res, 200, {
        id: capture.id,
        command: ['cancel_requested', 'completed', 'cancelled', 'failed', 'expired'].includes(capture.status) ? 'cancel' : 'continue',
        status: capture.status
      })
    }
    if (req.method === 'GET' && endpoint === 'profile') {
      return readProfile(res, capture, allowed.tokenType, profileHeaders, { store })
    }
    if (req.method === 'GET' && endpoint === 'profile-download') {
      return readProfileDownload(res, capture, profileHeaders, { store })
    }
    if (req.method === 'POST' && endpoint === 'status') {
      const parsed = await readJson(req, 5 * 1024 * 1024, policy.requestTimeoutMs)
      if (!parsed.ok) return failParsedRequest(res, parsed)
      return store.withCaptureLock(capture.id, async () => {
        const lockedCapture = store.get(capture.id)
        if (!lockedCapture) return fail(res, 404, 'NOT_FOUND', 'Capture not found.')
        const statusUpdate = validateStatusUpdate(lockedCapture, parsed.body)
        if (!statusUpdate.ok) return fail(res, statusUpdate.code === 'INVALID_REQUEST' ? 400 : 409, statusUpdate.code, statusUpdate.message)
        if (parsed.body?.status === 'running' && parsed.body?.phase === 'target_loaded' && !parsed.body?.finalUrl) {
          return fail(res, 400, 'INVALID_REQUEST', 'target_loaded status requires finalUrl.')
        }
        if (parsed.body?.finalUrl) {
          const finalUrl = await validateFinalUrl(parsed.body.finalUrl, baseUrl, lockedCapture.request, { resolveHostname })
          if (!finalUrl.ok) {
            lockedCapture.status = 'failed'
            lockedCapture.phase = parsed.body.phase
            lockedCapture.error = { code: finalUrl.code, message: finalUrl.message, details: finalUrl.details || {} }
            return fail(res, 409, finalUrl.code, finalUrl.message, finalUrl.details)
          }
          const network = validateTargetNetworkAddress(parsed.body.targetNetworkAddress, lockedCapture.request, {
            finalUrl: finalUrl.finalUrl,
            fromCache: parsed.body.targetNetworkFromCache === true
          })
          if (!network.ok) {
            if (network.code === 'INVALID_REQUEST') return fail(res, 400, network.code, network.message, network.details)
            lockedCapture.status = 'failed'
            lockedCapture.phase = parsed.body.phase
            lockedCapture.error = { code: network.code, message: network.message, details: network.details || {} }
            return fail(res, 409, network.code, network.message, network.details)
          }
          lockedCapture.finalUrl = finalUrl.finalUrl
        }
        lockedCapture.sequence = parsed.body.sequence
        lockedCapture.status = parsed.body.status
        lockedCapture.phase = parsed.body.phase
        lockedCapture.error = parsed.body.error ? sanitizeBridgeError(parsed.body.error) : lockedCapture.error
        return json(res, 200, publicStatus(lockedCapture))
      })
    }
    if (req.method === 'POST' && endpoint === 'profile') {
      if (finalStates.has(capture.status)) {
        return fail(res, 409, terminalProfileErrorCode(capture.status), 'Capture is already terminal.', { status: capture.status })
      }
      if (!capture.finalUrl) return fail(res, 409, 'INVALID_REQUEST', 'Capture final URL has not been accepted.')
      const parsed = await readJson(req, 8 * 1024 * 1024, policy.requestTimeoutMs)
      if (!parsed.ok) return failParsedRequest(res, parsed, parsed.status === 413 ? 'PROFILE_TOO_LARGE' : parsed.code)
      return store.withCaptureLock(capture.id, async () => {
        const lockedCapture = store.get(capture.id)
        if (!lockedCapture) return fail(res, 404, 'NOT_FOUND', 'Capture not found.')
        return writeProfile(res, commitProfile(store, lockedCapture, parsed.body, { profileSchema }))
      })
    }
    if (req.method === 'DELETE' && endpoint === '') {
      if (finalStates.has(capture.status))
        return fail(res, 409, 'INVALID_REQUEST', 'Capture is already terminal.', { status: capture.status })
      if (capture.status === 'cancel_requested')
        return fail(res, 409, 'STALE_STATUS_UPDATE', 'Capture cancellation is already requested.', { status: capture.status })
      store.requestCancel(capture)
      return json(res, 200, publicStatus(capture))
    }
    return methodNotAllowed(res, allowForCaptureEndpoint(endpoint))
  })

  server.on('clientError', (_error, socket) => socketJsonError(socket, 'HTTP/1.1 400 Bad Request', 'Invalid HTTP request.'))
  server.on('connect', (_req, socket) =>
    socketJsonError(socket, 'HTTP/1.1 400 Bad Request', 'Only origin-form request targets are allowed.')
  )
  const headerTimers = new Map()
  server.on('connection', socket => {
    const timer = setTimeout(() => {
      if (!socket.writable) return
      socket.end(['HTTP/1.1 408 Request Timeout', 'Connection: close', 'Content-Length: 0', '', ''].join('\r\n'))
    }, policy.headersTimeoutMs)
    headerTimers.set(socket, timer)
    socket.once('close', () => {
      clearTimeout(timer)
      headerTimers.delete(socket)
    })
  })
  server.on('request', (req, res) => {
    const socket = req.socket
    const timer = headerTimers.get(socket)
    if (timer) {
      clearTimeout(timer)
      headerTimers.delete(socket)
    }
    res.once('finish', () => {
      if (!socket.destroyed) socket.setTimeout(policy.keepAliveTimeoutMs)
    })
  })
  applyServerResourcePolicy(server, policy)

  store = new CaptureStore({ baseUrl: '', openBrowser: url => openBrowser(url, env), now, resultTtlMs })

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        baseUrl = `http://127.0.0.1:${address.port}`
        store.baseUrl = baseUrl
        resolve({ server, store, apiToken, baseUrl, healthUrl: `${baseUrl}/health` })
      })
    })

  const close = () => new Promise(resolve => server.close(resolve))
  return { listen, close, server }
}
