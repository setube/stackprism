const DEFAULT_TERMINAL_SETTLE_MS = 3000
const MAX_TERMINAL_SETTLE_MS = 5000
const CHILD_STOP_GRACE_MS = 2500
const DEFAULT_REQUEST_TIMEOUT_MS = 30000

const timeoutSignal = ms => {
  let timer
  const promise = new Promise(resolve => {
    timer = setTimeout(resolve, ms)
  })
  return {
    promise,
    clear: () => clearTimeout(timer)
  }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export const makeBridgeError = (code, message = code, extra = {}) => Object.assign(new Error(message), { code, ...extra })

export const requestJson = async (url, token, init = {}) => {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, headers: initHeaders, ...requestInit } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...requestInit,
      signal: controller.signal,
      headers: {
        ...(requestInit.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...(initHeaders || {})
      }
    })
    let body
    try {
      body = await response.json()
    } catch {
      body = { error: { code: 'INVALID_JSON', message: 'Bridge returned non-JSON response.' } }
    }
    if (!response.ok) {
      const code = typeof body?.error?.code === 'string' && body.error.code ? body.error.code : `HTTP_${response.status}`
      const error = makeBridgeError(code, body?.error?.message || code)
      error.response = { status: response.status, body }
      throw error
    }
    return body
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = makeBridgeError('BRIDGE_REQUEST_TIMEOUT', `Bridge request timed out after ${timeoutMs}ms.`)
      timeout.response = {
        status: 504,
        body: { error: { code: 'BRIDGE_REQUEST_TIMEOUT', message: `Bridge request timed out after ${timeoutMs}ms.` } }
      }
      throw timeout
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export const requestBinary = async (url, token = '', init = {}) => {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, headers: initHeaders, ...requestInit } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...requestInit,
      signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(initHeaders || {})
      }
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      let body = { error: { code: `HTTP_${response.status}`, message: `HTTP_${response.status}` } }
      try {
        body = JSON.parse(bytes.toString('utf8'))
      } catch {}
      const code = typeof body?.error?.code === 'string' && body.error.code ? body.error.code : `HTTP_${response.status}`
      const error = makeBridgeError(code, body?.error?.message || code)
      error.response = { status: response.status, body }
      throw error
    }
    return { bytes, contentType: response.headers.get('content-type') || '' }
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = makeBridgeError('BRIDGE_REQUEST_TIMEOUT', `Bridge request timed out after ${timeoutMs}ms.`)
      timeout.response = {
        status: 504,
        body: { error: { code: 'BRIDGE_REQUEST_TIMEOUT', message: `Bridge request timed out after ${timeoutMs}ms.` } }
      }
      throw timeout
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export const parseTerminalSettleMs = value => {
  if (value == null || value === '') return DEFAULT_TERMINAL_SETTLE_MS
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_TERMINAL_SETTLE_MS
    ? parsed
    : DEFAULT_TERMINAL_SETTLE_MS
}

export const stopChild = async child => {
  if (child.exitCode !== null || child.killed) return
  try {
    if (child.stdin?.writable && !child.stdin.destroyed) child.stdin.end()
  } catch {}
  const firstTimeout = timeoutSignal(CHILD_STOP_GRACE_MS)
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    firstTimeout.promise.then(() => {
      child.kill('SIGTERM')
      return 'killed'
    })
  ])
  firstTimeout.clear()
  if (exited === 'killed') {
    const secondTimeout = timeoutSignal(CHILD_STOP_GRACE_MS)
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), secondTimeout.promise]).catch(() => {})
    secondTimeout.clear()
  }
}
