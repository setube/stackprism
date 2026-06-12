import { newBridgeToken, newCaptureId, newNonce, newScreenshotDownloadId, newSessionId } from './protocol.mjs'
import { prepareProfileForStorage } from './profile-response.mjs'

const CAPTURE_TIMEOUT_MS = 95000
const EXTENSION_CONNECT_TIMEOUT_MS = 30000
const CANCEL_TIMEOUT_MS = 10000
const RESULT_TTL_MS = 10 * 60 * 1000
const MAX_CAPTURE_RECORDS = 100

const captureDeadlineError = capture =>
  capture.phase === 'target_opening'
    ? { code: 'TARGET_LOAD_TIMEOUT', message: 'Target tab load timed out.' }
    : { code: 'CAPTURE_TIMEOUT', message: 'Capture timed out.' }

export class CaptureStore {
  constructor({ baseUrl, openBrowser, now = () => Date.now(), resultTtlMs = RESULT_TTL_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    this.baseUrl = baseUrl
    this.openBrowser = openBrowser
    this.now = now
    this.resultTtlMs = resultTtlMs
    this.setTimeout = setTimeoutFn
    this.clearTimeout = clearTimeoutFn
    this.captures = new Map()
    this.captureLocks = new Map()
    this.resultExpiryTimers = new Map()
  }

  async withCaptureLock(id, task) {
    const previous = this.captureLocks.get(id) || Promise.resolve()
    let release
    const gate = new Promise(resolve => {
      release = resolve
    })
    const next = previous.catch(() => {}).then(() => gate)
    this.captureLocks.set(id, next)
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
      if (this.captureLocks.get(id) === next) this.captureLocks.delete(id)
    }
  }

  activeCount() {
    this.pruneExpiredResults()
    return [...this.captures.values()].filter(capture =>
      ['queued', 'waiting_extension', 'running', 'cancel_requested'].includes(capture.status)
    ).length
  }

  get(id) {
    const capture = this.captures.get(id)
    if (!capture) return null
    this.expireIfNeeded(capture)
    return capture
  }

  async create(request) {
    if (this.activeCount() > 0) {
      return { ok: false, status: 429, code: 'CAPTURE_BUSY', message: 'Another capture is already active.' }
    }
    const capture = {
      id: newCaptureId(),
      sessionId: newSessionId(),
      nonce: newNonce(),
      bridgeToken: newBridgeToken(),
      status: 'queued',
      phase: undefined,
      sequence: 0,
      request,
      profile: null,
      screenshotAsset: null,
      error: null,
      createdAt: this.now(),
      extensionDeadlineAt: this.now() + EXTENSION_CONNECT_TIMEOUT_MS,
      deadlineAt: this.now() + CAPTURE_TIMEOUT_MS,
      cancelDeadlineAt: null,
      resultExpiresAt: null,
      bridgeTokenRenderedAt: null,
      bridgeTokenClaimedAt: null,
      profileDownloadReadyAt: null,
      screenshotDownloadId: newScreenshotDownloadId(),
      screenshotUrl: null
    }
    capture.bridgeUrl = `${this.baseUrl}/bridge?session=${capture.sessionId}&capture=${capture.id}&nonce=${capture.nonce}`
    capture.profileUrl = `${this.baseUrl}/v1/captures/${capture.id}/profile`
    capture.screenshotUrl = `${this.baseUrl}/v1/captures/${capture.id}/screenshot-download/${capture.screenshotDownloadId}`
    this.captures.set(capture.id, capture)
    this.pruneTerminalRecords()
    const opened = await this.openBrowser(capture.bridgeUrl)
    if (!opened.ok) {
      capture.status = 'failed'
      capture.error = { code: 'BROWSER_OPEN_FAILED', message: 'Failed to open the bridge page.', details: opened.details || {} }
      return { ok: false, status: 500, code: 'BROWSER_OPEN_FAILED', message: capture.error.message, details: capture.error.details }
    }
    return { ok: true, capture }
  }

  clearResultExpiryTimer(captureId) {
    const timer = this.resultExpiryTimers.get(captureId)
    if (!timer) return
    this.clearTimeout(timer)
    this.resultExpiryTimers.delete(captureId)
  }

  scheduleResultExpiry(capture) {
    this.clearResultExpiryTimer(capture.id)
    if (!capture.resultExpiresAt) return
    const delayMs = Math.max(0, capture.resultExpiresAt - this.now())
    const timer = this.setTimeout(() => {
      this.resultExpiryTimers.delete(capture.id)
      this.expireIfNeeded(capture)
    }, delayMs)
    timer?.unref?.()
    this.resultExpiryTimers.set(capture.id, timer)
  }

  expireIfNeeded(capture) {
    const now = this.now()
    if (capture.status === 'completed' && capture.resultExpiresAt && capture.resultExpiresAt <= now) {
      capture.status = 'expired'
      capture.profile = null
      capture.screenshotAsset = null
      capture.error = { code: 'CAPTURE_RESULT_EXPIRED', message: 'Capture result expired.' }
      this.clearResultExpiryTimer(capture.id)
    }
    if (['queued', 'waiting_extension'].includes(capture.status) && capture.extensionDeadlineAt <= now) {
      capture.status = 'failed'
      capture.error = { code: 'EXTENSION_NOT_CONNECTED', message: 'StackPrism extension did not connect before the deadline.' }
    }
    if (capture.status === 'running' && capture.deadlineAt <= now) {
      capture.status = 'failed'
      capture.error = captureDeadlineError(capture)
    }
    if (capture.status === 'cancel_requested' && capture.cancelDeadlineAt && capture.cancelDeadlineAt <= now) {
      capture.status = 'cancelled'
      capture.error = {
        code: 'CAPTURE_TIMEOUT',
        message: 'Capture cancellation timed out.',
        details: { reason: 'cancel_timeout' }
      }
    }
  }

  pruneExpiredResults() {
    for (const capture of this.captures.values()) {
      this.expireIfNeeded(capture)
    }
  }

  pruneTerminalRecords() {
    const overflow = this.captures.size - MAX_CAPTURE_RECORDS
    if (overflow <= 0) return
    const terminal = [...this.captures.values()]
      .filter(capture => !['queued', 'waiting_extension', 'running', 'cancel_requested'].includes(capture.status))
      .sort((left, right) => left.createdAt - right.createdAt)
    for (const capture of terminal.slice(0, overflow)) {
      this.clearResultExpiryTimer(capture.id)
      this.captures.delete(capture.id)
    }
  }

  markProfile(capture, profile) {
    capture.resultExpiresAt = this.now() + this.resultTtlMs
    const prepared = prepareProfileForStorage(profile, capture)
    capture.status = 'completed'
    capture.phase = 'cleanup'
    capture.profile = prepared.profile
    capture.screenshotAsset = prepared.screenshotAsset
    this.scheduleResultExpiry(capture)
  }

  touchResult(capture) {
    if (capture.status !== 'completed') return
    capture.resultExpiresAt = this.now() + this.resultTtlMs
    this.scheduleResultExpiry(capture)
  }

  requestCancel(capture) {
    capture.status = 'cancel_requested'
    capture.cancelDeadlineAt = this.now() + CANCEL_TIMEOUT_MS
  }

  clear() {
    for (const captureId of this.resultExpiryTimers.keys()) this.clearResultExpiryTimer(captureId)
    this.captures.clear()
  }
}
