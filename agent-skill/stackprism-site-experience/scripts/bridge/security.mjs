import { fail, isValidId } from './protocol.mjs'

const duplicateSensitiveHeaders = new Set(['host', 'authorization', 'content-type', 'content-length'])

const hasDuplicateSensitiveHeaders = rawHeaders => {
  const seen = new Set()
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index] || '').toLowerCase()
    if (!duplicateSensitiveHeaders.has(name)) continue
    if (seen.has(name)) return true
    seen.add(name)
  }
  return false
}

export const rejectBadRequestShell = (req, res, baseUrl) => {
  if (hasDuplicateSensitiveHeaders(req.rawHeaders || [])) {
    fail(res, 400, 'INVALID_REQUEST', 'Ambiguous request headers are not allowed.')
    return true
  }
  if (req.headers.host !== new URL(baseUrl).host) {
    fail(res, 400, 'INVALID_REQUEST', 'Host is not allowed.')
    return true
  }
  const target = String(req.url || '')
  if (!target.startsWith('/') || target.startsWith('//')) {
    fail(res, 400, 'INVALID_REQUEST', 'Only origin-form request targets are allowed.')
    return true
  }
  const [rawPath, rawQuery = ''] = target.split('?', 2)
  if (/%2e|%2f|%5c|\\/i.test(target)) {
    fail(res, 400, 'INVALID_REQUEST', 'Encoded path separators or dot segments are not allowed.')
    return true
  }
  if (
    rawPath !== '/' &&
    rawPath
      .split('/')
      .slice(1)
      .some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    fail(res, 400, 'INVALID_REQUEST', 'Ambiguous path segments are not allowed.')
    return true
  }
  if (rawQuery && rawPath !== '/bridge') {
    fail(res, 400, 'INVALID_REQUEST', 'Query string is not allowed for this endpoint.')
    return true
  }
  const contentLength = req.headers['content-length']
  if (contentLength && !/^\d+$/.test(String(contentLength))) {
    fail(res, 400, 'INVALID_REQUEST', 'Content-Length is invalid.')
    return true
  }
  const contentEncoding = req.headers['content-encoding']
  if (contentEncoding && String(contentEncoding).toLowerCase() !== 'identity') {
    fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Encoding is not supported.')
    return true
  }
  if (req.headers['transfer-encoding'] && req.headers['content-length']) {
    fail(res, 400, 'INVALID_REQUEST', 'Content-Length and Transfer-Encoding cannot be combined.')
    return true
  }
  if (req.headers['transfer-encoding']) {
    fail(res, 400, 'UNSUPPORTED_TRANSFER_ENCODING', 'Transfer-Encoding is not supported.')
    return true
  }
  return false
}

export const rejectCrossOriginSensitiveRequest = (req, res, baseUrl) => {
  let allowedOrigin = baseUrl
  try {
    allowedOrigin = new URL(baseUrl).origin
  } catch {}

  const { origin } = req.headers
  if (origin && origin !== allowedOrigin) {
    fail(res, 403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed.')
    return true
  }

  const { referer } = req.headers
  if (referer) {
    try {
      if (new URL(referer).origin !== allowedOrigin) {
        fail(res, 403, 'ORIGIN_NOT_ALLOWED', 'Referer is not allowed.')
        return true
      }
    } catch {
      fail(res, 403, 'ORIGIN_NOT_ALLOWED', 'Referer is not allowed.')
      return true
    }
  }

  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    fail(res, 403, 'ORIGIN_NOT_ALLOWED', 'Sec-Fetch-Site is not allowed.')
    return true
  }
  return false
}

const bodyTimeout = Symbol('bodyTimeout')

export const readJson = async (req, limit = 5 * 1024 * 1024, timeoutMs = 0) => {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
    return { ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Expected application/json.' }
  }
  const chunks = []
  let size = 0
  const readBody = (async () => {
    for await (const chunk of req) {
      size += chunk.byteLength
      if (size > limit) return { ok: false, status: 413, code: 'REQUEST_TOO_LARGE', message: 'Request body is too large.', close: true }
      chunks.push(chunk)
    }
    return { ok: true }
  })()
  readBody.catch(() => {})
  let bodyResult
  let timeoutId
  try {
    const timeout =
      timeoutMs > 0
        ? new Promise(resolve => {
            timeoutId = setTimeout(() => resolve(bodyTimeout), timeoutMs)
          })
        : null
    bodyResult = timeout ? await Promise.race([readBody, timeout]) : await readBody
  } catch {
    return { ok: false, status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON.' }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
  if (bodyResult === bodyTimeout) {
    return { ok: false, status: 408, code: 'REQUEST_TIMEOUT', message: 'Request body timed out.', close: true }
  }
  if (!bodyResult.ok) return bodyResult
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    return { ok: true, body: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON.' }
  }
}

const bridgeQueryKinds = {
  session: 'sessionId',
  capture: 'captureId',
  nonce: 'nonce'
}

export const parseBridgeQuery = rawSearch => {
  const raw = String(rawSearch || '').replace(/^\?/, '')
  const parts = raw ? raw.split('&') : []
  if (parts.length !== 3) return null
  const values = {}
  for (const part of parts) {
    const separatorIndex = part.indexOf('=')
    if (!part || separatorIndex <= 0 || part.indexOf('=', separatorIndex + 1) !== -1) return null
    const name = part.slice(0, separatorIndex)
    const value = part.slice(separatorIndex + 1)
    const kind = bridgeQueryKinds[name]
    if (!kind || Object.prototype.hasOwnProperty.call(values, name) || !isValidId(kind, value)) return null
    values[name] = value
  }
  return Object.keys(values).length === 3 ? values : null
}

export const validateBridgeQuery = url => Boolean(parseBridgeQuery(url.search))
