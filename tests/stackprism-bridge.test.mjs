import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CaptureStore } from '../agent-skill/stackprism-site-experience/scripts/bridge/capture-store.mjs'
import { createBridgeServer } from '../agent-skill/stackprism-site-experience/scripts/bridge/http-server.mjs'
import { openBrowser } from '../agent-skill/stackprism-site-experience/scripts/bridge/open-browser.mjs'
import { htmlEscapeScriptJson, isValidId, safeEqual } from '../agent-skill/stackprism-site-experience/scripts/bridge/protocol.mjs'
import { readJson as readBridgeRequestJson } from '../agent-skill/stackprism-site-experience/scripts/bridge/security.mjs'
import { normalizeCaptureRequest } from '../agent-skill/stackprism-site-experience/scripts/bridge/url-policy.mjs'
import identifiers from './fixtures/bridge-protocol-identifiers.json' with { type: 'json' }
import urlPolicyCases from './fixtures/bridge-url-policy-cases.json' with { type: 'json' }

const baseCaptureRequest = {
  url: 'https://93.184.216.34/app?view=one#frag',
  mode: 'experience',
  waitMs: 0,
  include: ['tech', 'visual', 'layout', 'components', 'interaction', 'ux', 'assets'],
  viewports: [{ name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 }],
  options: {
    forceRefresh: true,
    captureScreenshotMetadata: false,
    keepTabOpen: false,
    allowPrivateNetworkTarget: false,
    targetMode: 'reuse_or_new_tab',
    maxResourceUrls: 300
  }
}

const auth = token => ({ Authorization: `Bearer ${token}` })

const readJson = async response => ({ status: response.status, body: await response.json(), headers: response.headers })

const sensitiveFailedError = (ready, created, config) => {
  const sensitiveUrl = `${created.body.bridgeUrl}&token=secret&apiToken=${ready.apiToken}&bridgeToken=${config.bridgeToken}#frag`
  return {
    code: 'TARGET_TAB_CLOSED',
    message: `Target closed while loading ${sensitiveUrl}`,
    details: {
      url: sensitiveUrl,
      token: config.bridgeToken,
      nonce: config.nonce,
      nested: {
        authorization: `Bearer ${ready.apiToken}`,
        values: [config.bridgeToken, config.nonce, sensitiveUrl]
      }
    }
  }
}

const assertErrorIsRedacted = (error, blockedValues) => {
  const serialized = JSON.stringify(error)
  for (const value of blockedValues) assert.equal(serialized.includes(value), false, value)
  assert.doesNotMatch(serialized, /spbt?_[A-Za-z0-9_-]{8,}/)
  assert.doesNotMatch(serialized, /\bn_[A-Za-z0-9_-]{8,}\b/)
  assert.doesNotMatch(serialized, /token=secret|apiToken=|bridgeToken=|#frag/)
  assert.match(serialized, /\[redacted/)
}

const assertJsonSecurityHeaders = (envelope, { referrerPolicy = false } = {}) => {
  assert.match(envelope.headers.get('content-type') || '', /^application\/json; charset=utf-8\b/)
  assert.equal(envelope.headers.get('cache-control'), 'no-store')
  assert.equal(envelope.headers.get('x-content-type-options'), 'nosniff')
  if (referrerPolicy) assert.equal(envelope.headers.get('referrer-policy'), 'no-referrer')
}

const withBridge = async (fn, options = {}) => {
  const bridge = createBridgeServer({ env: { STACKPRISM_BRIDGE_NO_OPEN: '1' }, ...options })
  const ready = await bridge.listen()
  try {
    await fn(ready)
  } finally {
    await bridge.close()
  }
}

const listenOnLoopback = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })

const createCapture = async ready => {
  const response = await fetch(`${ready.baseUrl}/v1/captures`, {
    method: 'POST',
    headers: { ...auth(ready.apiToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(baseCaptureRequest)
  })
  return readJson(response)
}

const loadBridgeConfig = async bridgeUrl => {
  const bridgePage = await fetch(bridgeUrl)
  const html = await bridgePage.text()
  return JSON.parse(html.match(/<script id="stackprism-agent-bridge-config" type="application\/json" nonce="[^"]+">([^<]+)/)[1])
}

const percentEncodeFirstPayloadChar = value =>
  `${value.slice(0, 2)}%${value.charCodeAt(2).toString(16).toUpperCase().padStart(2, '0')}${value.slice(3)}`

const percentEncodeBridgeParam = (bridgeUrl, name) => {
  const url = new URL(bridgeUrl)
  const value = url.searchParams.get(name)
  return bridgeUrl.replace(`${name}=${value}`, `${name}=${percentEncodeFirstPayloadChar(value)}`)
}

const statusBody = (captureId, config, body) => ({
  captureId,
  sessionId: config.sessionId,
  nonce: config.nonce,
  protocolVersion: 1,
  ...body
})

const acceptFinalUrl = async (ready, captureId, bridgeToken, finalUrl = baseCaptureRequest.url) => {
  const request = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${captureId}/request`, { headers: auth(bridgeToken) }))
  assert.equal(request.status, 200)
  assertJsonSecurityHeaders(request)
  const response = await fetch(`${ready.baseUrl}/v1/captures/${captureId}/status`, {
    method: 'POST',
    headers: { ...auth(bridgeToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(
      statusBody(captureId, request.body, {
        status: 'running',
        phase: 'target_loaded',
        sequence: 1,
        finalUrl,
        targetNetworkAddress: '93.184.216.34'
      })
    )
  })
  const envelope = await readJson(response)
  assert.equal(envelope.status, 200)
  assertJsonSecurityHeaders(envelope)
  assert.equal(envelope.body.phase, 'target_loaded')
}

const profileFor = captureId => ({
  schema: 'stackprism.site_experience_profile.v1',
  captureId,
  generatedAt: new Date(0).toISOString(),
  target: {},
  browserContext: { extensionCapabilities: {} },
  techProfile: {},
  visualProfile: {},
  layoutProfile: {},
  componentProfile: {},
  interactionProfile: {},
  uxProfile: {},
  assetProfile: {},
  evidence: {},
  limitations: [],
  agentGuidance: {}
})

test('js bridge protocol helpers use strict token comparison and script-safe JSON', () => {
  assert.equal(safeEqual('spb_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO', 'short'), false)
  assert.equal(safeEqual('same-token', 'same-token'), true)
  assert.equal(safeEqual('same-token', 'same-token-extra'), false)
  assert.equal(safeEqual(`${'a'.repeat(64)}x`, `${'a'.repeat(64)}y`), false)
  const escaped = htmlEscapeScriptJson({ value: '</script><script>alert(1)</script>&\u2028\u2029' })
  assert.equal(escaped.includes('</script>'), false)
  assert.equal(escaped.includes('<script>'), false)
  assert.equal(escaped.includes('&'), false)
  assert.match(escaped, /\\u2028/)
  assert.match(escaped, /\\u2029/)
})

test('js bridge protocol helper validates documented identifier fixtures', () => {
  for (const [kind, examples] of Object.entries(identifiers)) {
    for (const value of examples.valid) {
      assert.equal(isValidId(kind, value), true, `${kind} should accept ${value}`)
    }
    for (const value of examples.invalid) {
      assert.equal(isValidId(kind, value), false, `${kind} should reject ${value}`)
    }
  }
})

test('js bridge serves health and creates no-open captures with bearer auth', async () => {
  await withBridge(async ready => {
    assert.match(ready.apiToken, /^spb_[A-Za-z0-9_-]{43}$/)
    assert.equal(ready.server.maxConnections, 20)
    assert.equal(ready.server.headersTimeout, 5000)
    assert.equal(ready.server.requestTimeout, 10000)
    assert.equal(ready.server.keepAliveTimeout, 2000)

    const health = await readJson(await fetch(ready.healthUrl))
    assert.equal(health.status, 200)
    assert.equal(health.body.service, 'stackprism-agent-bridge')
    assert.equal(health.body.protocolVersion, 1)

    const unauthorized = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseCaptureRequest)
      })
    )
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.body.error.code, 'UNAUTHORIZED')

    const created = await createCapture(ready)
    assert.equal(created.status, 200)
    assert.match(created.body.id, /^cap_[A-Za-z0-9_-]{22}$/)
    assert.equal(created.body.status, 'queued')
    assert.deepEqual([...new URL(created.body.bridgeUrl).searchParams.keys()].sort(), ['capture', 'nonce', 'session'])
    assert.equal(created.body.bridgeUrl.includes(ready.apiToken), false)
    assert.equal(created.body.bridgeUrl.includes('apiToken'), false)
    assert.equal(created.body.bridgeUrl.includes('bridgeToken'), false)
    assert.doesNotMatch(created.body.bridgeUrl, /spbt?_[A-Za-z0-9_-]{20,}/)
  })
})

test('js bridge rate limits capture creation and api status reads', async () => {
  await withBridge(
    async ready => {
      const created = await createCapture(ready)
      assert.equal(created.status, 200)

      const busy = await createCapture(ready)
      assert.equal(busy.status, 429)
      assert.equal(busy.body.error.code, 'RATE_LIMITED')

      const firstStatus = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, { headers: auth(ready.apiToken) }))
      assert.equal(firstStatus.status, 200)
      const secondStatus = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, { headers: auth(ready.apiToken) }))
      assert.equal(secondStatus.status, 429)
      assert.equal(secondStatus.body.error.code, 'RATE_LIMITED')
    },
    { rateLimits: { createLimitPerMinute: 1, queryLimitPerMinute: 1 } }
  )
})

test('js bridge rate limits api profile reads', async () => {
  await withBridge(
    async ready => {
      const created = await createCapture(ready)
      assert.equal(created.status, 200)

      const firstProfile = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, { headers: auth(ready.apiToken) })
      )
      assert.equal(firstProfile.status, 409)
      assert.equal(firstProfile.body.error.code, 'INVALID_REQUEST')
      assertJsonSecurityHeaders(firstProfile, { referrerPolicy: true })

      const secondProfile = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, { headers: auth(ready.apiToken) })
      )
      assert.equal(secondProfile.status, 429)
      assert.equal(secondProfile.body.error.code, 'RATE_LIMITED')
    },
    { rateLimits: { queryLimitPerMinute: 1 } }
  )
})

test('bridge page renders bridge token once with hardened headers', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const first = await fetch(created.body.bridgeUrl)
    const html = await first.text()
    const csp = first.headers.get('content-security-policy')
    const cspNonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1]

    assert.equal(first.status, 200)
    assert.equal(first.headers.get('cache-control'), 'no-store')
    assert.equal(first.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(first.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(first.headers.get('cross-origin-opener-policy'), 'same-origin')
    assert.equal(first.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    assert.equal(csp.includes('unsafe-inline'), false)
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /connect-src 'self'/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /base-uri 'none'/)
    assert.match(csp, /form-action 'none'/)
    assert.ok(cspNonce)
    assert.match(csp, new RegExp(`style-src 'nonce-${cspNonce}'`))
    assert.equal(first.headers.get('x-frame-options'), 'DENY')
    assert.match(html, /meta name="stackprism-agent-bridge" content="1"/)
    assert.match(html, new RegExp(`id="stackprism-agent-bridge-config" type="application/json" nonce="${cspNonce}"`))
    assert.match(html, new RegExp(`<script nonce="${cspNonce}"`))
    assert.match(html, /fetch\('\/v1\/captures\/'\+config\.captureId/)
    assert.match(html, /textContent=value/)
    assert.match(html, /"bridgeToken":"spbt_[A-Za-z0-9_-]{43}"/)

    const second = await readJson(await fetch(created.body.bridgeUrl))
    assert.equal(second.status, 409)
    assert.equal(second.body.error.code, 'INVALID_REQUEST')
  })
})

test('bridge page rejects cross-site navigation before token render', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)

    const blockedReferer = await fetch(created.body.bridgeUrl, { headers: { Referer: 'https://attacker.example/page' } })
    const blockedRefererText = await blockedReferer.text()
    assert.equal(blockedReferer.status, 403)
    assert.match(blockedRefererText, /ORIGIN_NOT_ALLOWED/)
    assert.doesNotMatch(blockedRefererText, /spbt_[A-Za-z0-9_-]{43}/)

    const blockedFetchSite = await fetch(created.body.bridgeUrl, { headers: { 'Sec-Fetch-Site': 'cross-site' } })
    const blockedFetchSiteText = await blockedFetchSite.text()
    assert.equal(blockedFetchSite.status, 403)
    assert.match(blockedFetchSiteText, /ORIGIN_NOT_ALLOWED/)
    assert.doesNotMatch(blockedFetchSiteText, /spbt_[A-Za-z0-9_-]{43}/)

    const firstAllowed = await fetch(created.body.bridgeUrl)
    const firstAllowedText = await firstAllowed.text()
    assert.equal(firstAllowed.status, 200)
    assert.match(firstAllowedText, /"bridgeToken":"spbt_[A-Za-z0-9_-]{43}"/)

    const secondAllowed = await readJson(await fetch(created.body.bridgeUrl))
    assert.equal(secondAllowed.status, 409)
    assert.equal(secondAllowed.body.error.code, 'INVALID_REQUEST')
  })
})

test('bridge page does not reflect hostile query fragments or error messages', async () => {
  await withBridge(async ready => {
    const hostileMarker = '</script><script>alert(1)</script>#stackprism-fragment'
    const created = await createCapture(ready)
    const hostileUrl = `${created.body.bridgeUrl}&unexpected=${encodeURIComponent(hostileMarker)}#${encodeURIComponent(hostileMarker)}`
    const invalid = await fetch(hostileUrl)
    const invalidHtml = await invalid.text()

    assert.equal(invalid.status, 400)
    assert.match(invalidHtml, /INVALID_REQUEST/)
    assert.doesNotMatch(invalidHtml, /stackprism-fragment/)
    assert.doesNotMatch(invalidHtml, /<script>alert\(1\)<\/script>/)
    assert.doesNotMatch(invalidHtml, /spbt_[A-Za-z0-9_-]{43}/)

    const capture = ready.store.get(created.body.id)
    capture.status = 'failed'
    capture.phase = 'cleanup'
    capture.error = { code: 'TARGET_TAB_CLOSED', message: hostileMarker }

    const terminalPage = await fetch(created.body.bridgeUrl)
    const terminalHtml = await terminalPage.text()
    assert.equal(terminalPage.status, 409)
    assert.match(terminalHtml, /TARGET_TAB_CLOSED/)
    assert.doesNotMatch(terminalHtml, /stackprism-fragment/)
    assert.doesNotMatch(terminalHtml, /<script>alert\(1\)<\/script>/)
    assert.doesNotMatch(terminalHtml, /spbt_[A-Za-z0-9_-]{43}/)
  })
})

test('bridge page does not render tokens after extension connect timeout or terminal status', async () => {
  let now = 1000
  await withBridge(
    async ready => {
      const expired = await createCapture(ready)
      now += 30001

      const expiredPage = await fetch(expired.body.bridgeUrl)
      const expiredHtml = await expiredPage.text()
      assert.equal(expiredPage.status, 409)
      assert.match(expiredHtml, /EXTENSION_NOT_CONNECTED/)
      assert.doesNotMatch(expiredHtml, /spbt_[A-Za-z0-9_-]{43}/)

      const next = await createCapture(ready)
      const capture = ready.store.get(next.body.id)
      capture.status = 'failed'
      capture.phase = 'cleanup'
      capture.error = { code: 'TARGET_TAB_CLOSED', message: 'Target tab closed.' }

      const terminalPage = await fetch(next.body.bridgeUrl)
      const terminalHtml = await terminalPage.text()
      assert.equal(terminalPage.status, 409)
      assert.match(terminalHtml, /TARGET_TAB_CLOSED/)
      assert.doesNotMatch(terminalHtml, /spbt_[A-Za-z0-9_-]{43}/)
    },
    { now: () => now }
  )
})

test('bridge page and profile endpoint do not render tokens after completed result TTL expiry', async () => {
  let now = 1000
  await withBridge(
    async ready => {
      const created = await createCapture(ready)
      const config = await loadBridgeConfig(created.body.bridgeUrl)
      await acceptFinalUrl(ready, created.body.id, config.bridgeToken)

      const posted = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
          method: 'POST',
          headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
          body: JSON.stringify(profileFor(created.body.id))
        })
      )
      assert.equal(posted.status, 200)
      assert.equal(posted.body.status, 'completed')

      const capture = ready.store.get(created.body.id)
      now = capture.resultExpiresAt + 1

      const expiredProfile = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
          headers: auth(ready.apiToken)
        })
      )
      assert.equal(expiredProfile.status, 410)
      assert.equal(expiredProfile.body.error.code, 'CAPTURE_RESULT_EXPIRED')
      assertJsonSecurityHeaders(expiredProfile, { referrerPolicy: true })

      const expiredPage = await fetch(created.body.bridgeUrl)
      const expiredHtml = await expiredPage.text()
      assert.equal(expiredPage.status, 410)
      assert.match(expiredHtml, /CAPTURE_RESULT_EXPIRED/)
      assert.doesNotMatch(expiredHtml, /spbt_[A-Za-z0-9_-]{43}/)
    },
    { now: () => now }
  )
})

test('bridge token can fetch request and post profile but cannot read profile', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)

    const status = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, { headers: auth(ready.apiToken) }))
    assert.equal(status.status, 200)
    assertJsonSecurityHeaders(status)

    const request = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/request`, { headers: auth(config.bridgeToken) })
    )
    assert.equal(request.status, 200)
    assertJsonSecurityHeaders(request)
    assert.equal(request.body.captureId, created.body.id)
    assert.equal(request.body.request.url, 'https://93.184.216.34/app?view=one')
    assert.equal(JSON.stringify(request.body).includes('apiToken'), false)
    assert.deepEqual(Object.keys(request.body).sort(), ['captureId', 'nonce', 'protocolVersion', 'request', 'sessionId'])

    const control = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/control`, { headers: auth(config.bridgeToken) })
    )
    assert.equal(control.status, 200)
    assertJsonSecurityHeaders(control)

    await acceptFinalUrl(ready, created.body.id, config.bridgeToken)

    const profile = profileFor(created.body.id)
    const posted = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      })
    )
    assert.equal(posted.status, 200)
    assertJsonSecurityHeaders(posted)
    assert.equal(posted.body.status, 'completed')

    const completedControl = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/control`, { headers: auth(config.bridgeToken) })
    )
    assert.equal(completedControl.status, 200)
    assert.equal(completedControl.body.command, 'cancel')
    assert.equal(completedControl.body.status, 'completed')

    const forbidden = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, { headers: auth(config.bridgeToken) })
    )
    assert.equal(forbidden.status, 403)
    assertJsonSecurityHeaders(forbidden, { referrerPolicy: true })
    assert.equal(forbidden.body.error.code, 'BRIDGE_TOKEN_CANNOT_READ_PROFILE')

    const fetched = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, { headers: auth(ready.apiToken) })
    )
    assert.equal(fetched.status, 200)
    assertJsonSecurityHeaders(fetched, { referrerPolicy: true })
    assert.equal(fetched.body.schema, 'stackprism.site_experience_profile.v1')
  })
})

test('js bridge rejects repeated and oversized profile submissions', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const profile = profileFor(created.body.id)
    await acceptFinalUrl(ready, created.body.id, config.bridgeToken)

    const posted = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      })
    )
    assert.equal(posted.status, 200)

    const repeated = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      })
    )
    assert.equal(repeated.status, 409)
    assert.equal(repeated.body.error.code, 'CAPTURE_ALREADY_COMPLETED')

    const url = new URL(ready.baseUrl)
    const repeatedOversized = await rawHttp(url.port, [
      `POST /v1/captures/${created.body.id}/profile HTTP/1.1`,
      `Host: ${url.host}`,
      `Authorization: Bearer ${config.bridgeToken}`,
      'Content-Type: application/json',
      `Content-Length: ${8 * 1024 * 1024 + 1}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(repeatedOversized, /409/)
    assert.match(repeatedOversized, /CAPTURE_ALREADY_COMPLETED/)

    const oversized = await createCapture(ready)
    assert.equal(oversized.status, 200)
    const oversizedConfig = await loadBridgeConfig(oversized.body.bridgeUrl)
    await acceptFinalUrl(ready, oversized.body.id, oversizedConfig.bridgeToken)
    const tooLargeProfile = { ...profileFor(oversized.body.id), evidence: { blob: 'x'.repeat(8 * 1024 * 1024) } }
    const rejected = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${oversized.body.id}/profile`, {
        method: 'POST',
        headers: { ...auth(oversizedConfig.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(tooLargeProfile)
      })
    )
    assert.equal(rejected.status, 413)
    assert.equal(rejected.body.error.code, 'PROFILE_TOO_LARGE')
  })
})

test('js bridge serializes concurrent profile submissions for one capture', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const profile = profileFor(created.body.id)
    const profileUrl = `${ready.baseUrl}/v1/captures/${created.body.id}/profile`
    const profileText = JSON.stringify(profile)
    const url = new URL(ready.baseUrl)
    await acceptFinalUrl(ready, created.body.id, config.bridgeToken)

    const slowPost = rawHttpSplitBody(
      url.port,
      [
        `POST /v1/captures/${created.body.id}/profile HTTP/1.1`,
        `Host: ${url.host}`,
        `Authorization: Bearer ${config.bridgeToken}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(profileText)}`,
        'Connection: close',
        '',
        ''
      ],
      profileText,
      64,
      150
    ).then(parseRawJsonResponse)

    await new Promise(resolve => setTimeout(resolve, 30))

    const fastPost = fetch(profileUrl, {
      method: 'POST',
      headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(profile)
    })

    const results = await Promise.all([slowPost, fastPost.then(response => readJson(response))])
    const statuses = results.map(result => result.status).sort()
    assert.deepEqual(statuses, [200, 409])
    assert.equal(results.find(result => result.status === 409).body.error.code, 'CAPTURE_ALREADY_COMPLETED')
  })
})

test('js bridge body reader stops consuming after request body exceeds limit', async () => {
  let yieldedChunks = 0
  const request = {
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yieldedChunks += 1
      yield Buffer.alloc(8)
      yieldedChunks += 1
      yield Buffer.alloc(8)
      yieldedChunks += 1
      yield Buffer.alloc(8)
    }
  }

  const result = await readBridgeRequestJson(request, 10)
  assert.equal(result.ok, false)
  assert.equal(result.status, 413)
  assert.equal(result.code, 'REQUEST_TOO_LARGE')
  assert.equal(result.close, true)
  assert.equal(yieldedChunks, 2)
})

test('js bridge closes slow request bodies within configured resource timeout', async () => {
  await withBridge(
    async ready => {
      const url = new URL(ready.baseUrl)
      const response = await rawHttpPartial(url.port, [
        'POST /v1/captures HTTP/1.1',
        `Host: ${url.host}`,
        `Authorization: Bearer ${ready.apiToken}`,
        'Content-Type: application/json',
        'Content-Length: 64',
        'Connection: close',
        '',
        '{"url"'
      ])

      assert.equal(response.closed, true)
      assert.ok(response.elapsedMs < 1000, `slow body stayed open for ${response.elapsedMs}ms`)
      assert.match(response.data, /408|400|INVALID_JSON/)
    },
    { resourcePolicy: { requestTimeoutMs: 50 } }
  )
})

test('js bridge closes slow request headers within configured resource timeout', async () => {
  await withBridge(
    async ready => {
      const url = new URL(ready.baseUrl)
      const response = await rawHttpPartial(url.port, [`GET /health HTTP/1.1`, `Host: ${url.host}`])

      assert.equal(response.closed, true)
      assert.ok(response.elapsedMs < 1000, `slow headers stayed open for ${response.elapsedMs}ms`)
      assert.doesNotMatch(response.data, /"ok":true/)
    },
    { resourcePolicy: { headersTimeoutMs: 50, requestTimeoutMs: 1000 } }
  )
})

test('js bridge rejects connections beyond the configured active connection limit', async () => {
  await withBridge(
    async ready => {
      const url = new URL(ready.baseUrl)
      const first = await openHoldingSocket(url.port)
      const second = await openHoldingSocket(url.port)
      try {
        const excess = await rawHttpPartialAllowReset(url.port, [`GET /health HTTP/1.1`, `Host: ${url.host}`, '', ''], 1000)

        assert.equal(excess.closed, true)
        assert.doesNotMatch(excess.data, /"ok":true/)
        assert.ok(excess.reset || excess.data.length === 0 || /^HTTP\/1\.1 (4|5)/.test(excess.data))
      } finally {
        first.destroy()
        second.destroy()
      }
    },
    { resourcePolicy: { maxOpenConnections: 2, headersTimeoutMs: 1000 } }
  )
})

test('capture store can actively prune expired completed profiles', () => {
  let now = 1000
  const store = new CaptureStore({
    baseUrl: 'http://127.0.0.1:17370',
    openBrowser: () => ({ ok: true }),
    now: () => now
  })
  const created = store.create(baseCaptureRequest)
  assert.equal(created.ok, true)
  store.markProfile(created.capture, profileFor(created.capture.id))
  assert.equal(created.capture.status, 'completed')
  assert.ok(created.capture.profile)

  now = created.capture.resultExpiresAt + 1
  store.pruneExpiredResults()
  assert.equal(created.capture.status, 'expired')
  assert.equal(created.capture.profile, null)
  assert.equal(created.capture.error.code, 'CAPTURE_RESULT_EXPIRED')
})

test('capture store distinguishes extension, target load, and running timeouts', () => {
  let now = 1000
  const store = new CaptureStore({
    baseUrl: 'http://127.0.0.1:17370',
    openBrowser: () => ({ ok: true }),
    now: () => now
  })
  const queued = store.create(baseCaptureRequest).capture
  now = queued.extensionDeadlineAt + 1
  store.pruneExpiredResults()
  assert.equal(queued.status, 'failed')
  assert.equal(queued.error.code, 'EXTENSION_NOT_CONNECTED')

  now = 2000
  const targetOpening = store.create(baseCaptureRequest).capture
  targetOpening.status = 'running'
  targetOpening.phase = 'target_opening'
  now = targetOpening.deadlineAt + 1
  store.pruneExpiredResults()
  assert.equal(targetOpening.status, 'failed')
  assert.equal(targetOpening.error.code, 'TARGET_LOAD_TIMEOUT')

  now = 3000
  const running = store.create(baseCaptureRequest).capture
  running.status = 'running'
  running.phase = 'profiling_experience'
  now = running.deadlineAt + 1
  store.pruneExpiredResults()
  assert.equal(running.status, 'failed')
  assert.equal(running.error.code, 'CAPTURE_TIMEOUT')
})

test('js bridge reports browser open failure during capture creation', async () => {
  await withBridge(
    async ready => {
      const response = await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { ...auth(ready.apiToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(baseCaptureRequest)
      })
      const rejected = await readJson(response)
      assert.equal(rejected.status, 500)
      assert.equal(rejected.body.error.code, 'BROWSER_OPEN_FAILED')
    },
    { env: { STACKPRISM_BROWSER_OPEN_COMMAND: '/definitely/missing/stackprism-browser' } }
  )
})

test('js bridge reports invalid browser open args during capture creation', async t => {
  const cases = [
    ['invalid_json', '{'],
    ['non_array', JSON.stringify({ profile: 'Default' })],
    ['non_string_arg', JSON.stringify(['--profile-directory=Default', 42])]
  ]

  for (const [name, argsJson] of cases) {
    await t.test(name, async () => {
      await withBridge(
        async ready => {
          const response = await fetch(`${ready.baseUrl}/v1/captures`, {
            method: 'POST',
            headers: { ...auth(ready.apiToken), 'Content-Type': 'application/json' },
            body: JSON.stringify(baseCaptureRequest)
          })
          const rejected = await readJson(response)
          assert.equal(rejected.status, 500)
          assert.equal(rejected.body.error.code, 'BROWSER_OPEN_FAILED')
          assert.deepEqual(rejected.body.error.details, { reason: 'invalid_open_args' })
        },
        {
          env: {
            STACKPRISM_BRIDGE_NO_OPEN: '0',
            STACKPRISM_BROWSER_OPEN_COMMAND: process.execPath,
            STACKPRISM_BROWSER_OPEN_ARGS_JSON: argsJson
          }
        }
      )
    })
  }
})

test('js bridge factory validates browser open environment before server bind', () => {
  assert.throws(
    () => createBridgeServer({ env: { STACKPRISM_BROWSER_OPEN_COMMAND: 'bad\0cmd' } }),
    error => error?.code === 'BRIDGE_INVALID_ENV'
  )
  assert.throws(
    () =>
      createBridgeServer({
        env: { STACKPRISM_BROWSER_OPEN_COMMAND: process.execPath, STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['bad\0arg']) }
      }),
    error => error?.code === 'BRIDGE_INVALID_ENV'
  )
})

test('js bridge open-browser helper validates parsed env before spawning', () => {
  const result = openBrowser('http://127.0.0.1:1/bridge', {
    STACKPRISM_BROWSER_OPEN_COMMAND: process.execPath,
    STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['bad\0arg'])
  })

  assert.deepEqual(result, { ok: false, details: { reason: 'BRIDGE_INVALID_ENV', message: 'Browser open environment contains NUL.' } })
})

test('js bridge open-browser helper appends bridge URL as one argv', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-open-'))
  const argvPath = join(tempDir, 'argv.json')
  const bridgeUrl = 'http://127.0.0.1:17370/bridge?session=s&capture=c&nonce=n value"quote;&cmd=$(echo bad)'
  const script = "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))"

  try {
    const result = openBrowser(bridgeUrl, {
      STACKPRISM_BROWSER_OPEN_COMMAND: process.execPath,
      STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['--input-type=module', '-e', script, argvPath])
    })

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(JSON.parse(readFileSync(argvPath, 'utf8')), [bridgeUrl])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('bridge cli rejects invalid configured port before ready output', async () => {
  const child = spawn(process.execPath, ['agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, STACKPRISM_BRIDGE_NO_OPEN: '1', STACKPRISM_BRIDGE_PORT: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdin.end()

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  const [code] = await once(child, 'exit')
  const parsed = JSON.parse(stderr.trim())

  assert.notEqual(code, 0)
  assert.equal(parsed.error.code, 'BRIDGE_INVALID_ENV')
  assert.equal(stdout, '')
  assert.equal(stderr.includes('spb_'), false)
})

test('bridge cli rejects occupied configured port before ready output', async () => {
  const occupiedServer = await listenOnLoopback()
  const address = occupiedServer.address()
  assert.ok(address && typeof address === 'object')

  const child = spawn(process.execPath, ['agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, STACKPRISM_BRIDGE_NO_OPEN: '1', STACKPRISM_BRIDGE_PORT: String(address.port) },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdin.end()

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })

  try {
    const [code] = await once(child, 'exit')
    const parsed = JSON.parse(stderr.trim())

    assert.notEqual(code, 0)
    assert.equal(parsed.error.code, 'PORT_IN_USE')
    assert.equal(stdout, '')
    assert.equal(stderr.includes('spb_'), false)
  } finally {
    await new Promise(resolve => occupiedServer.close(resolve))
  }
})

test('bridge cli prints exactly one ready json line after server bind', async () => {
  const child = spawn(process.execPath, ['agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, STACKPRISM_BRIDGE_NO_OPEN: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const [chunk] = await once(child.stdout, 'data')
  const ready = JSON.parse(String(chunk).trim())
  assert.equal(ready.event, 'stackprism-bridge-ready')
  assert.match(ready.apiToken, /^spb_[A-Za-z0-9_-]{43}$/)
  const health = await readJson(await fetch(ready.healthUrl))
  assert.equal(health.status, 200)
  child.kill('SIGTERM')
  await once(child, 'exit')
})

test('bridge cli exits and clears server when stdin closes', async () => {
  const child = spawn(process.execPath, ['agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, STACKPRISM_BRIDGE_NO_OPEN: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const [chunk] = await once(child.stdout, 'data')
  const ready = JSON.parse(String(chunk).trim())
  const health = await readJson(await fetch(ready.healthUrl))
  assert.equal(health.status, 200)

  child.stdin.end()
  const exited = await Promise.race([
    once(child, 'exit').then(([code]) => ({ exited: true, code })),
    new Promise(resolve => setTimeout(() => resolve({ exited: false }), 2500))
  ])
  if (!exited.exited) child.kill('SIGTERM')
  assert.equal(exited.exited, true)
  assert.equal(exited.code, 0)
})

test('bridge cli exits and closes listener on SIGTERM', async () => {
  const child = spawn(process.execPath, ['agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, STACKPRISM_BRIDGE_NO_OPEN: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const [chunk] = await once(child.stdout, 'data')
  const ready = JSON.parse(String(chunk).trim())
  const health = await readJson(await fetch(ready.healthUrl))
  assert.equal(health.status, 200)

  child.kill('SIGTERM')
  const [code] = await once(child, 'exit')

  assert.equal(code, 0)
  await assert.rejects(() => fetch(ready.healthUrl), /fetch failed/)
})

test('js bridge rejects cross-origin, private target, and self-target requests', async () => {
  await withBridge(async ready => {
    const privateTarget = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { ...auth(ready.apiToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseCaptureRequest, url: 'http://127.0.0.1:3000/' })
      })
    )
    assert.equal(privateTarget.status, 400)
    assert.equal(privateTarget.body.error.code, 'PRIVATE_NETWORK_TARGET_BLOCKED')

    const selfTarget = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { ...auth(ready.apiToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseCaptureRequest,
          url: ready.baseUrl,
          options: { ...baseCaptureRequest.options, allowPrivateNetworkTarget: true }
        })
      })
    )
    assert.equal(selfTarget.status, 400)
    assert.equal(selfTarget.body.error.code, 'BRIDGE_SELF_TARGET_BLOCKED')

    const localhostSelfTarget = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { ...auth(ready.apiToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseCaptureRequest,
          url: ready.baseUrl.replace('127.0.0.1', 'localhost'),
          options: { ...baseCaptureRequest.options, allowPrivateNetworkTarget: true }
        })
      })
    )
    assert.equal(localhostSelfTarget.status, 400)
    assert.equal(localhostSelfTarget.body.error.code, 'BRIDGE_SELF_TARGET_BLOCKED')

    const crossOrigin = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { ...auth(ready.apiToken), 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: JSON.stringify(baseCaptureRequest)
      })
    )
    assert.equal(crossOrigin.status, 403)
    assert.equal(crossOrigin.body.error.code, 'ORIGIN_NOT_ALLOWED')
  })
})

test('url policy rejects fixture-resolved private hostnames without real DNS', async () => {
  const publicResult = await normalizeCaptureRequest(
    { ...baseCaptureRequest, url: urlPolicyCases.publicHostname.url },
    'http://127.0.0.1:17370',
    { resolveHostname: async () => urlPolicyCases.publicHostname.resolvedAddresses.map(address => ({ address, family: 4 })) }
  )
  assert.equal(publicResult.ok, true)
  assert.equal(publicResult.request.url, urlPolicyCases.publicHostname.normalizedUrl)

  const credentialTarget = await normalizeCaptureRequest(
    { ...baseCaptureRequest, url: urlPolicyCases.credentialUrl.url },
    'http://127.0.0.1:17370'
  )
  assert.equal(credentialTarget.ok, false)
  assert.equal(credentialTarget.code, urlPolicyCases.credentialUrl.errorCode)

  const invalidBooleanOption = await normalizeCaptureRequest(
    { ...baseCaptureRequest, options: { ...baseCaptureRequest.options, forceRefresh: 'true' } },
    'http://127.0.0.1:17370'
  )
  assert.equal(invalidBooleanOption.ok, false)
  assert.equal(invalidBooleanOption.code, 'INVALID_REQUEST')

  for (const item of [
    { request: { ...baseCaptureRequest, waitMs: null }, field: 'waitMs null' },
    { request: { ...baseCaptureRequest, viewports: null }, field: 'viewports null' },
    {
      request: { ...baseCaptureRequest, viewports: [{ name: 123, width: 1440, height: 900, deviceScaleFactor: 1 }] },
      field: 'viewport name'
    },
    { request: { ...baseCaptureRequest, options: null }, field: 'options null' },
    { request: { ...baseCaptureRequest, options: true }, field: 'options boolean' },
    { request: { ...baseCaptureRequest, options: { ...baseCaptureRequest.options, targetMode: '' } }, field: 'targetMode empty' }
  ]) {
    const rejected = await normalizeCaptureRequest(item.request, 'http://127.0.0.1:17370')
    assert.equal(rejected.ok, false, item.field)
    assert.equal(rejected.code, 'INVALID_REQUEST', item.field)
  }

  const resolvedPrivate = await normalizeCaptureRequest(
    { ...baseCaptureRequest, url: urlPolicyCases.privateHostname.url },
    'http://127.0.0.1:17370',
    {
      resolveHostname: async hostname => {
        assert.equal(hostname, 'dev.internal.example')
        return urlPolicyCases.privateHostname.resolvedAddresses.map(address => ({ address, family: 4 }))
      }
    }
  )
  assert.equal(resolvedPrivate.ok, false)
  assert.equal(resolvedPrivate.code, urlPolicyCases.privateHostname.errorCode)
  assert.equal(resolvedPrivate.details.reason, 'private_network_address')

  const mixedResult = await normalizeCaptureRequest(
    { ...baseCaptureRequest, url: urlPolicyCases.mixedHostname.url },
    'http://127.0.0.1:17370',
    {
      resolveHostname: async () => urlPolicyCases.mixedHostname.resolvedAddresses.map(address => ({ address, family: 4 }))
    }
  )
  assert.equal(mixedResult.ok, false)
  assert.equal(mixedResult.code, urlPolicyCases.mixedHostname.errorCode)

  const nonGlobalResult = await normalizeCaptureRequest(
    { ...baseCaptureRequest, url: urlPolicyCases.nonGlobalHostname.url },
    'http://127.0.0.1:17370',
    {
      resolveHostname: async () => urlPolicyCases.nonGlobalHostname.resolvedAddresses.map(address => ({ address, family: 4 }))
    }
  )
  assert.equal(nonGlobalResult.ok, false)
  assert.equal(nonGlobalResult.code, urlPolicyCases.nonGlobalHostname.errorCode)
  assert.equal(nonGlobalResult.details.reason, 'private_network_address')

  for (const policyCase of [urlPolicyCases.specialUseHostname, urlPolicyCases.specialUseIpv6Hostname]) {
    for (const address of policyCase.resolvedAddresses) {
      const specialUseResult = await normalizeCaptureRequest({ ...baseCaptureRequest, url: policyCase.url }, 'http://127.0.0.1:17370', {
        resolveHostname: async () => [{ address, family: address.includes(':') ? 6 : 4 }]
      })
      assert.equal(specialUseResult.ok, false, address)
      assert.equal(specialUseResult.code, policyCase.errorCode, address)
      assert.equal(specialUseResult.details.reason, 'private_network_address', address)
    }
  }

  for (const address of urlPolicyCases.publicSpecialUseExceptionHostname.resolvedAddresses) {
    const exceptionResult = await normalizeCaptureRequest(
      { ...baseCaptureRequest, url: urlPolicyCases.publicSpecialUseExceptionHostname.url },
      'http://127.0.0.1:17370',
      {
        resolveHostname: async () => [{ address, family: address.includes(':') ? 6 : 4 }]
      }
    )
    assert.equal(exceptionResult.ok, true, address)
    assert.equal(exceptionResult.request.url, urlPolicyCases.publicSpecialUseExceptionHostname.normalizedUrl, address)
  }
})

test('url policy fails closed when DNS fixture cannot prove a public target', async () => {
  const failedLookup = await normalizeCaptureRequest(
    { ...baseCaptureRequest, url: 'https://missing.internal.example/dashboard' },
    'http://127.0.0.1:17370',
    {
      resolveHostname: async () => {
        const error = new Error('fixture NXDOMAIN')
        error.code = 'ENOTFOUND'
        throw error
      }
    }
  )
  assert.equal(failedLookup.ok, false)
  assert.equal(failedLookup.code, 'TARGET_DNS_LOOKUP_FAILED')
  assert.equal(failedLookup.details.reason, 'dns_lookup_failed')

  const emptyLookup = await normalizeCaptureRequest(
    { ...baseCaptureRequest, url: 'https://empty.internal.example/dashboard' },
    'http://127.0.0.1:17370',
    { resolveHostname: async () => [] }
  )
  assert.equal(emptyLookup.ok, false)
  assert.equal(emptyLookup.code, 'TARGET_DNS_LOOKUP_FAILED')
})

test('js bridge capture creation uses injected DNS policy fixture', async () => {
  await withBridge(
    async ready => {
      const resolvedPrivate = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures`, {
          method: 'POST',
          headers: { ...auth(ready.apiToken), 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...baseCaptureRequest, url: 'https://dev.internal.example/dashboard' })
        })
      )
      assert.equal(resolvedPrivate.status, 400)
      assert.equal(resolvedPrivate.body.error.code, 'PRIVATE_NETWORK_TARGET_BLOCKED')
      assert.equal(resolvedPrivate.body.error.details.reason, 'private_network_address')
    },
    {
      resolveHostname: async () => [{ address: '172.20.1.2', family: 4 }]
    }
  )
})

test('js bridge rejects private final URLs before profile creation', async () => {
  await withBridge(
    async ready => {
      const created = await createCapture(ready)
      const config = await loadBridgeConfig(created.body.bridgeUrl)

      const finalUrlStatus = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
          method: 'POST',
          headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            captureId: created.body.id,
            sessionId: config.sessionId,
            nonce: config.nonce,
            protocolVersion: 1,
            status: 'running',
            phase: 'target_loaded',
            sequence: 1,
            finalUrl: 'https://redirect.internal.example/dashboard'
          })
        })
      )
      assert.equal(finalUrlStatus.status, 409)
      assert.equal(finalUrlStatus.body.error.code, 'FINAL_URL_BLOCKED')
      assert.equal(finalUrlStatus.body.error.details.reason, 'private_network_address')

      const status = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, { headers: auth(ready.apiToken) }))
      assert.equal(status.body.status, 'failed')
      assert.equal(status.body.phase, 'cleanup')
      assert.equal(status.body.error.code, 'FINAL_URL_BLOCKED')

      const lateProfile = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
          method: 'POST',
          headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
          body: JSON.stringify(profileFor(created.body.id))
        })
      )
      assert.equal(lateProfile.status, 409)
      assert.equal(lateProfile.body.error.code, 'STALE_STATUS_UPDATE')
    },
    {
      resolveHostname: async hostname => {
        if (hostname === 'redirect.internal.example') return [{ address: '10.20.30.40', family: 4 }]
        return [{ address: '93.184.216.34', family: 4 }]
      }
    }
  )
})

test('js bridge rejects private browser-observed target addresses', async () => {
  await withBridge(
    async ready => {
      const created = await createCapture(ready)
      const config = await loadBridgeConfig(created.body.bridgeUrl)
      const status = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
          method: 'POST',
          headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
          body: JSON.stringify(
            statusBody(created.body.id, config, {
              status: 'running',
              phase: 'target_loaded',
              sequence: 1,
              finalUrl: baseCaptureRequest.url,
              targetNetworkAddress: '127.0.0.1'
            })
          )
        })
      )
      assert.equal(status.status, 409)
      assert.equal(status.body.error.code, 'FINAL_URL_BLOCKED')
      assert.equal(status.body.error.details.reason, 'private_network_address')
    },
    {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }]
    }
  )
})

test('js bridge rejects non-ip browser-observed target addresses', async () => {
  await withBridge(
    async ready => {
      const created = await createCapture(ready)
      const config = await loadBridgeConfig(created.body.bridgeUrl)
      const status = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
          method: 'POST',
          headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
          body: JSON.stringify(
            statusBody(created.body.id, config, {
              status: 'running',
              phase: 'target_loaded',
              sequence: 1,
              finalUrl: baseCaptureRequest.url,
              targetNetworkAddress: 'example.com'
            })
          )
        })
      )
      assert.equal(status.status, 400)
      assert.equal(status.body.error.code, 'INVALID_REQUEST')
      assert.equal(status.body.error.details.reason, 'invalid_network_address')
    },
    {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }]
    }
  )
})

test('js bridge requires accepted final URL before profile submission', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const missingFinalUrl = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'running', phase: 'target_loaded', sequence: 1 }))
      })
    )
    assert.equal(missingFinalUrl.status, 400)
    assert.equal(missingFinalUrl.body.error.code, 'INVALID_REQUEST')

    const earlyProfile = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(profileFor(created.body.id))
      })
    )
    assert.equal(earlyProfile.status, 409)
    assert.equal(earlyProfile.body.error.code, 'INVALID_REQUEST')
  })
})

test('js bridge rejects stale status sequences and phase regressions', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const statusUrl = `${ready.baseUrl}/v1/captures/${created.body.id}/status`

    const wrongIdentity = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(
            created.body.id,
            { ...config, nonce: identifiers.nonce.valid[1] },
            {
              status: 'waiting_extension',
              phase: 'bridge_connected',
              sequence: 1
            }
          )
        )
      })
    )
    assert.equal(wrongIdentity.status, 400)
    assert.equal(wrongIdentity.body.error.code, 'INVALID_REQUEST')

    const connected = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'waiting_extension', phase: 'bridge_connected', sequence: 1 }))
      })
    )
    assert.equal(connected.status, 200)
    assert.equal(connected.body.status, 'waiting_extension')
    assert.equal(connected.body.phase, 'bridge_connected')

    const running = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'running', phase: 'request_loaded', sequence: 2 }))
      })
    )
    assert.equal(running.status, 200)
    assert.equal(running.body.status, 'running')
    assert.equal(running.body.phase, 'request_loaded')

    const staleSequence = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'running', phase: 'target_opening', sequence: 2 }))
      })
    )
    assert.equal(staleSequence.status, 409)
    assert.equal(staleSequence.body.error.code, 'STALE_STATUS_UPDATE')

    const phaseRegression = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'running', phase: 'bridge_connected', sequence: 3 }))
      })
    )
    assert.equal(phaseRegression.status, 409)
    assert.equal(phaseRegression.body.error.code, 'STALE_STATUS_UPDATE')

    const nonRunningPhaseRegression = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'waiting_extension', phase: 'bridge_connected', sequence: 3 }))
      })
    )
    assert.equal(nonRunningPhaseRegression.status, 409)
    assert.equal(nonRunningPhaseRegression.body.error.code, 'STALE_STATUS_UPDATE')

    const status = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, { headers: auth(ready.apiToken) }))
    assert.equal(status.body.status, 'running')
    assert.equal(status.body.phase, 'request_loaded')
  })
})

test('js bridge serializes concurrent status updates for one capture', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const statusUrl = `${ready.baseUrl}/v1/captures/${created.body.id}/status`
    const body = JSON.stringify(
      statusBody(created.body.id, config, {
        status: 'running',
        phase: 'target_loaded',
        sequence: 1,
        finalUrl: 'https://93.184.216.34/app?view=one',
        targetNetworkAddress: '93.184.216.34'
      })
    )

    const results = await Promise.all(
      [0, 1].map(() =>
        fetch(statusUrl, {
          method: 'POST',
          headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
          body
        }).then(readJson)
      )
    )

    assert.equal(results.filter(result => result.status === 200).length, 1)
    assert.equal(results.filter(result => result.status === 409 && result.body.error.code === 'STALE_STATUS_UPDATE').length, 1)
  })
})

test('js bridge restricts bridge-token terminal status updates', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const statusUrl = `${ready.baseUrl}/v1/captures/${created.body.id}/status`

    const cancelledWithoutDelete = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'cancelled', phase: 'cleanup', sequence: 1 }))
      })
    )
    assert.equal(cancelledWithoutDelete.status, 409)
    assert.equal(cancelledWithoutDelete.body.error.code, 'STALE_STATUS_UPDATE')

    const failedWithoutError = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'failed', phase: 'cleanup', sequence: 1 }))
      })
    )
    assert.equal(failedWithoutError.status, 400)
    assert.equal(failedWithoutError.body.error.code, 'INVALID_REQUEST')

    const failedWrongPhase = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(created.body.id, config, {
            status: 'failed',
            phase: 'target_opening',
            sequence: 1,
            error: { code: 'TARGET_TAB_CLOSED', message: 'Target closed.' }
          })
        )
      })
    )
    assert.equal(failedWrongPhase.status, 400)
    assert.equal(failedWrongPhase.body.error.code, 'INVALID_REQUEST')

    const failedUnknownCode = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(created.body.id, config, {
            status: 'failed',
            phase: 'cleanup',
            sequence: 1,
            error: { code: 'MADE_UP_ERROR', message: 'Unknown bridge error.' }
          })
        )
      })
    )
    assert.equal(failedUnknownCode.status, 400)
    assert.equal(failedUnknownCode.body.error.code, 'INVALID_REQUEST')

    const failedError = sensitiveFailedError(ready, created, config)
    const failed = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(created.body.id, config, {
            status: 'failed',
            phase: 'cleanup',
            sequence: 1,
            error: failedError
          })
        )
      })
    )
    assert.equal(failed.status, 200)
    assert.equal(failed.body.status, 'failed')
    assert.equal(failed.body.error.code, 'TARGET_TAB_CLOSED')
    assertErrorIsRedacted(failed.body.error, [ready.apiToken, config.bridgeToken, config.nonce])
  })
})

test('js bridge requires api token to cancel captures', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)

    const forbidden = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
        method: 'DELETE',
        headers: auth(config.bridgeToken)
      })
    )
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.body.error.code, 'FORBIDDEN')

    const status = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, { headers: auth(ready.apiToken) }))
    assert.equal(status.status, 200)
    assert.equal(status.body.status, 'queued')
    assert.equal(status.body.phase, undefined)
  })
})

test('js bridge rejects DELETE for every terminal capture state', async () => {
  let now = 1000
  await withBridge(
    async ready => {
      const makeCompleted = async () => {
        const created = await createCapture(ready)
        const config = await loadBridgeConfig(created.body.bridgeUrl)
        await acceptFinalUrl(ready, created.body.id, config.bridgeToken)
        const posted = await readJson(
          await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
            method: 'POST',
            headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
            body: JSON.stringify(profileFor(created.body.id))
          })
        )
        assert.equal(posted.status, 200)
        assert.equal(posted.body.status, 'completed')
        return created.body.id
      }

      const makeFailed = async () => {
        const created = await createCapture(ready)
        const config = await loadBridgeConfig(created.body.bridgeUrl)
        const failed = await readJson(
          await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
            method: 'POST',
            headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
            body: JSON.stringify(
              statusBody(created.body.id, config, {
                status: 'failed',
                phase: 'cleanup',
                sequence: 1,
                error: { code: 'TARGET_TAB_CLOSED', message: 'Target closed.' }
              })
            )
          })
        )
        assert.equal(failed.status, 200)
        assert.equal(failed.body.status, 'failed')
        return created.body.id
      }

      const makeCancelled = async () => {
        const created = await createCapture(ready)
        const cancelled = await readJson(
          await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
            method: 'DELETE',
            headers: auth(ready.apiToken)
          })
        )
        assert.equal(cancelled.status, 200)
        now += 10001
        const status = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, { headers: auth(ready.apiToken) }))
        assert.equal(status.body.status, 'cancelled')
        return created.body.id
      }

      const makeExpired = async () => {
        const captureId = await makeCompleted()
        now += 10 * 60 * 1000 + 1
        const status = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${captureId}`, { headers: auth(ready.apiToken) }))
        assert.equal(status.body.status, 'expired')
        return captureId
      }

      const assertTerminalDelete = async (captureId, expectedStatus) => {
        const deleted = await readJson(
          await fetch(`${ready.baseUrl}/v1/captures/${captureId}`, {
            method: 'DELETE',
            headers: auth(ready.apiToken)
          })
        )
        assert.equal(deleted.status, 409)
        assert.equal(deleted.body.error.code, 'INVALID_REQUEST')
        assert.equal(deleted.body.error.details.status, expectedStatus)

        const after = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${captureId}`, { headers: auth(ready.apiToken) }))
        assert.equal(after.status, 200)
        assert.equal(after.body.status, expectedStatus)
      }

      await assertTerminalDelete(await makeCompleted(), 'completed')
      await assertTerminalDelete(await makeFailed(), 'failed')
      await assertTerminalDelete(await makeCancelled(), 'cancelled')
      await assertTerminalDelete(await makeExpired(), 'expired')
    },
    { now: () => now }
  )
})

test('js bridge converts unconfirmed cancellation to terminal cancelled state', async () => {
  let now = 1000
  await withBridge(
    async ready => {
      const created = await createCapture(ready)
      const config = await loadBridgeConfig(created.body.bridgeUrl)

      const cancel = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
          method: 'DELETE',
          headers: auth(ready.apiToken)
        })
      )
      assert.equal(cancel.status, 200)
      assert.equal(cancel.body.status, 'cancel_requested')

      const repeatedCancel = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
          method: 'DELETE',
          headers: auth(ready.apiToken)
        })
      )
      assert.equal(repeatedCancel.status, 409)
      assert.equal(repeatedCancel.body.error.code, 'STALE_STATUS_UPDATE')
      assert.equal(repeatedCancel.body.error.details.status, 'cancel_requested')

      const runningAfterCancel = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
          method: 'POST',
          headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
          body: JSON.stringify(statusBody(created.body.id, config, { status: 'running', phase: 'target_opening', sequence: 1 }))
        })
      )
      assert.equal(runningAfterCancel.status, 409)
      assert.equal(runningAfterCancel.body.error.code, 'STALE_STATUS_UPDATE')

      now += 10001

      const status = await readJson(await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, { headers: auth(ready.apiToken) }))
      assert.equal(status.status, 200)
      assert.equal(status.body.status, 'cancelled')
      assert.equal(status.body.error.code, 'CAPTURE_TIMEOUT')
      assert.equal(status.body.error.details.reason, 'cancel_timeout')

      const control = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/control`, {
          headers: auth(config.bridgeToken)
        })
      )
      assert.equal(control.status, 200)
      assert.equal(control.body.command, 'cancel')
      assert.equal(control.body.status, 'cancelled')

      const lateStatus = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
          method: 'POST',
          headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
          body: JSON.stringify(
            statusBody(created.body.id, config, {
              status: 'running',
              phase: 'target_loaded',
              sequence: 1,
              finalUrl: baseCaptureRequest.url
            })
          )
        })
      )
      assert.equal(lateStatus.status, 409)
      assert.equal(lateStatus.body.error.code, 'STALE_STATUS_UPDATE')
    },
    { now: () => now }
  )
})

test('js bridge rejects preflight and ambiguous raw request shell', async () => {
  await withBridge(async ready => {
    const options = await readJson(await fetch(`${ready.baseUrl}/v1/captures`, { method: 'OPTIONS' }))
    assert.equal(options.status, 405)
    assert.equal(options.headers.get('allow'), 'GET, POST, DELETE')
    assert.equal(options.headers.has('access-control-allow-origin'), false)

    const getCollection = await readJson(await fetch(`${ready.baseUrl}/v1/captures`, { headers: auth(ready.apiToken) }))
    assert.equal(getCollection.status, 405)
    assert.equal(getCollection.headers.get('allow'), 'POST')

    const postHealth = await readJson(await fetch(`${ready.baseUrl}/health`, { method: 'POST' }))
    assert.equal(postHealth.status, 405)
    assert.equal(postHealth.headers.get('allow'), 'GET')

    const url = new URL(ready.baseUrl)
    const optionsWrongHost = await rawHttp(url.port, [
      'OPTIONS /v1/captures HTTP/1.1',
      `Host: localhost:${url.port}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(optionsWrongHost, /400/)
    assert.match(optionsWrongHost, /INVALID_REQUEST/)

    const wrongPortHost = await rawHttp(url.port, [
      'GET /health HTTP/1.1',
      `Host: 127.0.0.1:${Number(url.port) + 1}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(wrongPortHost, /400/)
    assert.match(wrongPortHost, /INVALID_REQUEST/)

    const missingHost = await rawHttp(url.port, ['GET /health HTTP/1.1', 'Connection: close', '', ''])
    assert.match(missingHost, /400/)
    assert.match(missingHost, /INVALID_REQUEST/)

    const ipv6Host = await rawHttp(url.port, ['GET /health HTTP/1.1', `Host: [::1]:${url.port}`, 'Connection: close', '', ''])
    assert.match(ipv6Host, /400/)
    assert.match(ipv6Host, /INVALID_REQUEST/)

    const duplicateHost = await rawHttp(url.port, [
      'GET /health HTTP/1.1',
      `Host: ${url.host}`,
      `Host: ${url.host}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(duplicateHost, /400/)
    assert.match(duplicateHost, /INVALID_REQUEST/)

    const absoluteForm = await rawHttp(url.port, [
      `GET http://127.0.0.1:${url.port}/health HTTP/1.1`,
      `Host: ${url.host}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(absoluteForm, /400/)
    assert.match(absoluteForm, /INVALID_REQUEST/)

    const authorityForm = await rawHttp(url.port, [
      `CONNECT 127.0.0.1:${url.port} HTTP/1.1`,
      `Host: ${url.host}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(authorityForm, /400/)
    assert.match(authorityForm, /INVALID_REQUEST/)

    const encodedSlashPath = await rawHttp(url.port, ['GET /v1%2fcaptures HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(encodedSlashPath, /400/)
    assert.match(encodedSlashPath, /INVALID_REQUEST/)

    const encodedBackslashPath = await rawHttp(url.port, ['GET /v1%5ccaptures HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(encodedBackslashPath, /400/)
    assert.match(encodedBackslashPath, /INVALID_REQUEST/)

    const dotSegmentPath = await rawHttp(url.port, ['GET /v1/../health HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(dotSegmentPath, /400/)
    assert.match(dotSegmentPath, /INVALID_REQUEST/)

    const emptySegmentPath = await rawHttp(url.port, ['GET /v1//captures HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(emptySegmentPath, /400/)
    assert.match(emptySegmentPath, /INVALID_REQUEST/)

    const unexpectedQuery = await rawHttp(url.port, ['GET /health?x=1 HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(unexpectedQuery, /400/)
    assert.match(unexpectedQuery, /INVALID_REQUEST/)

    const created = await createCapture(ready)
    const percentEncodedSession = await readJson(await fetch(percentEncodeBridgeParam(created.body.bridgeUrl, 'session')))
    assert.equal(percentEncodedSession.status, 400)
    assert.equal(percentEncodedSession.body.error.code, 'INVALID_REQUEST')

    const duplicateBridgeQuery = await readJson(
      await fetch(`${created.body.bridgeUrl}&session=${new URL(created.body.bridgeUrl).searchParams.get('session')}`)
    )
    assert.equal(duplicateBridgeQuery.status, 400)
    assert.equal(duplicateBridgeQuery.body.error.code, 'INVALID_REQUEST')
    assert.equal(JSON.stringify(duplicateBridgeQuery.body).includes('spbt_'), false)

    const duplicateAuthorization = await rawHttp(url.port, [
      'GET /health HTTP/1.1',
      `Host: ${url.host}`,
      'Authorization: Bearer one',
      'Authorization: Bearer two',
      'Connection: close',
      '',
      ''
    ])
    assert.match(duplicateAuthorization, /400/)
    assert.match(duplicateAuthorization, /INVALID_REQUEST/)

    const duplicateContentType = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Type: application/json',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(duplicateContentType, /400/)
    assert.match(duplicateContentType, /INVALID_REQUEST/)

    const contentLengthAndTransferEncoding = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Length: 2',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(contentLengthAndTransferEncoding, /400/)
    assert.match(contentLengthAndTransferEncoding, /INVALID_REQUEST/)

    const duplicateContentLength = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Length: 2',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(duplicateContentLength, /400/)
    assert.match(duplicateContentLength, /INVALID_REQUEST/)

    const invalidContentLength = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Length: nope',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(invalidContentLength, /400/)
    assert.match(invalidContentLength, /INVALID_REQUEST/)

    const chunkedBody = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '2',
      '{}',
      '0',
      '',
      ''
    ])
    assert.match(chunkedBody, /400/)
    assert.match(chunkedBody, /UNSUPPORTED_TRANSFER_ENCODING/)

    const unsupportedTransferEncoding = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Transfer-Encoding: gzip',
      'Connection: close',
      '',
      ''
    ])
    assert.match(unsupportedTransferEncoding, /400/)
    assert.match(unsupportedTransferEncoding, /UNSUPPORTED_TRANSFER_ENCODING/)

    const unsupportedContentEncoding = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Encoding: gzip',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(unsupportedContentEncoding, /415/)
    assert.match(unsupportedContentEncoding, /UNSUPPORTED_MEDIA_TYPE/)

    const unsupportedCharset = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json; charset=latin1',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(unsupportedCharset, /415/)
    assert.match(unsupportedCharset, /UNSUPPORTED_MEDIA_TYPE/)
  })
})

const rawHttp = (port, lines) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let data = ''
    socket.on('connect', () => socket.write(lines.join('\r\n')))
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
    })
    socket.on('error', reject)
    socket.on('end', () => resolve(data))
  })

const rawHttpSplitBody = (port, lines, body, splitAt, delayMs) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let data = ''
    const finish = () => resolve(data)
    socket.on('connect', () => {
      socket.write(lines.join('\r\n'))
      socket.write(body.slice(0, splitAt))
      setTimeout(() => socket.write(body.slice(splitAt)), delayMs)
    })
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
    })
    socket.on('error', reject)
    socket.on('end', finish)
  })

const parseRawJsonResponse = raw => {
  const [head, body = '{}'] = raw.split('\r\n\r\n')
  const status = Number(/^HTTP\/1\.1\s+(\d+)/.exec(head)?.[1])
  const isChunked = /\r\ntransfer-encoding:\s*chunked\r\n/i.test(`\r\n${head}\r\n`)
  return { status, body: JSON.parse(isChunked ? decodeChunkedBody(body) : body) }
}

const decodeChunkedBody = body => {
  let offset = 0
  let decoded = ''
  while (offset < body.length) {
    const sizeEnd = body.indexOf('\r\n', offset)
    if (sizeEnd < 0) break
    const size = Number.parseInt(body.slice(offset, sizeEnd), 16)
    if (!Number.isFinite(size) || size < 0) break
    offset = sizeEnd + 2
    if (size === 0) break
    decoded += body.slice(offset, offset + size)
    offset += size + 2
  }
  return decoded
}

const rawHttpPartial = (port, lines, deadlineMs = 1500) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let settled = false
    let data = ''
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ closed: true, data, elapsedMs: Date.now() - started })
    }
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`slow request was not closed within ${deadlineMs}ms; partial data: ${data}`))
    }, deadlineMs)
    socket.on('connect', () => socket.write(lines.join('\r\n')))
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
    })
    socket.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    socket.on('end', finish)
    socket.on('close', finish)
  })

const rawHttpPartialAllowReset = (port, lines, deadlineMs = 1500) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let settled = false
    let data = ''
    const resolveClosed = reset => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ closed: true, data, elapsedMs: Date.now() - started, reset })
    }
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`slow request was not closed within ${deadlineMs}ms; partial data: ${data}`))
    }, deadlineMs)
    socket.on('connect', () => socket.write(lines.join('\r\n')))
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
    })
    socket.on('error', error => {
      if (error?.code === 'ECONNRESET') return resolveClosed(true)
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    socket.on('end', () => resolveClosed(false))
    socket.on('close', () => resolveClosed(false))
  })

const openHoldingSocket = port =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
