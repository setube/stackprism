import { existsSync } from 'node:fs'
import dns from 'node:dns/promises'
import net from 'node:net'
import { resolve } from 'node:path'
import { createBridgeServer } from '../agent-skill/stackprism-site-experience/scripts/bridge/http-server.mjs'
import { protocolVersion } from '../agent-skill/stackprism-site-experience/scripts/bridge/protocol.mjs'
import { assert, createBrowserSmokeHarness, redactText } from './helpers/agent-bridge-browser-smoke-harness.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const dist = resolve(root, 'dist')
const cdpPort = Number(process.env.STACKPRISM_BROWSER_SMOKE_CDP_PORT || 9451)
const configuredTargetUrl = process.env.STACKPRISM_BROWSER_SMOKE_TARGET_URL || ''
const externalTargetUrl = configuredTargetUrl || 'https://www.wikipedia.org/'
const scenario = process.env.STACKPRISM_BROWSER_SMOKE_SCENARIO || 'default'
const cdpBaseUrl = `http://127.0.0.1:${cdpPort}`

const hasMetadataKey = value => {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasMetadataKey)
  return Object.entries(value).some(([key, item]) => /^(boundingBoxes|boundingBox|bounds|aboveFold|rect)$/i.test(key) || hasMetadataKey(item))
}

const hasScreenshotPayloadKey = value => {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasScreenshotPayloadKey)
  return Object.entries(value).some(
    ([key, item]) =>
      /^(screenshotData|imageData|pixelData|pixels|dataUrl|base64Image)$/i.test(key) ||
      (key === 'screenshot' && Boolean(item?.dataUrl)) ||
      hasScreenshotPayloadKey(item)
  )
}

const profileSummary = (profile, captureId) => {
  const body = profile?.body
  if (!body) return null
  const profileBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength
  const serialized = JSON.stringify(body).toLowerCase()
  return {
    httpStatus: profile.status,
    schema: body.schema,
    captureIdMatches: body.captureId === captureId,
    userAgentPresent: Boolean(body.browserContext?.userAgent),
    extensionVersion: body.browserContext?.extensionVersion || '',
    targetFinalUrl: body.target?.finalUrl || '',
    visualKeys: Object.keys(body.visualProfile || {}),
    layoutKeys: Object.keys(body.layoutProfile || {}),
    componentKeys: Object.keys(body.componentProfile || {}),
    limitationCount: Array.isArray(body.limitations) ? body.limitations.length : 0,
    profileBytes,
    estimatedTransferChunks: Math.max(1, Math.ceil(profileBytes / (384 * 1024))),
    screenshotMetadataPresent: hasMetadataKey(body),
    screenshotPayloadPresent: hasScreenshotPayloadKey(body),
    privacyLeakDetected: /cookie|authorization|set-cookie|token=secret|#frag/.test(serialized)
  }
}

const unrequestedSectionChecks = {
  visual: 'visualProfile',
  layout: 'layoutProfile',
  components: 'componentProfile',
  interaction: 'interactionProfile',
  ux: 'uxProfile',
  assets: 'assetProfile'
}

const assertSectionNotRequested = (profile, sections) => {
  const body = profile?.body
  assert(body && Array.isArray(body.limitations), `Profile body did not include limitations: ${JSON.stringify(profile)}`)
  for (const section of sections) {
    const key = unrequestedSectionChecks[section]
    assert(JSON.stringify(body[key] || {}) === '{}', `${key} was not empty for an unrequested section.`)
    assert(body.limitations.includes(`${section}_section_not_requested`), `${section} limitation was missing.`)
  }
}

const openBridgeWithCdpScript = `
const bridgeUrl = process.argv.at(-1)
const cdpBaseUrl = process.env.STACKPRISM_BROWSER_SMOKE_CDP_BASE_URL
if (!bridgeUrl || !cdpBaseUrl) process.exit(2)
const response = await fetch(cdpBaseUrl + '/json/new?' + encodeURIComponent(bridgeUrl), { method: 'PUT' })
if (!response.ok) process.exit(3)
`

const ensureDistBuilt = () => {
  if (!existsSync(resolve(dist, 'manifest.json'))) throw new Error('dist/manifest.json is missing. Run pnpm run build first.')
}

const withoutFragment = url => {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

const resolveTargetAddresses = async value => {
  const hostname = new URL(value).hostname
  try {
    return {
      hostname,
      addresses: (await dns.lookup(hostname, { all: true, verbatim: true })).map(item => item.address)
    }
  } catch (error) {
    return {
      hostname,
      addresses: [],
      dnsError: error?.code || (error instanceof Error ? error.message : String(error))
    }
  }
}

const assertRawHttpStatus = (raw, status, label) => {
  assert(raw.startsWith(`HTTP/1.1 ${status} `), `${label} returned unexpected raw response: ${redactText(raw)}`)
}

const assertRawHttpIncludes = (raw, pattern, label) => {
  assert(pattern.test(raw), `${label} did not include ${pattern}: ${redactText(raw)}`)
}

const rawStatusLine = raw => String(raw || '').split('\r\n')[0]

const probeKeepAliveIdleClose = (port, hostHeader, { idleMs = 2600, timeoutMs = 5000 } = {}) =>
  new Promise((resolveProbe, rejectProbe) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let data = ''
    let closed = false
    let settled = false
    let idleTimer
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(idleTimer)
      socket.destroy()
      resolveProbe(result)
    }
    const timeout = setTimeout(() => finish({ firstResponse: data, closed, reason: 'timeout' }), timeoutMs)
    socket.on('connect', () => socket.write(`GET /health HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: keep-alive\r\n\r\n`))
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
      if (data.includes('\r\n\r\n') && !idleTimer) {
        idleTimer = setTimeout(() => finish({ firstResponse: data, closed, reason: closed ? 'closed' : 'open_after_idle' }), idleMs)
      }
    })
    socket.on('end', () => {
      closed = true
    })
    socket.on('close', () => {
      closed = true
    })
    socket.on('error', rejectProbe)
  })

const openHoldingHttpSocket = (port, hostHeader) =>
  new Promise((resolveOpen, rejectOpen) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let opened = false
    socket.once('connect', () => {
      opened = true
      socket.write(`GET /health HTTP/1.1\r\nHost: ${hostHeader}\r\n`)
      socket.on('error', () => {})
      resolveOpen(socket)
    })
    socket.once('error', error => {
      if (!opened) rejectOpen(error)
    })
  })

const rawHttpWithTimeout = (port, lines, timeoutMs = 750) =>
  new Promise(resolveRaw => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let settled = false
    let data = ''
    const finish = reason => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      resolveRaw({ data, reason })
    }
    const timeout = setTimeout(() => finish('timeout'), timeoutMs)
    socket.on('connect', () => socket.write(lines.join('\r\n')))
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
    })
    socket.on('error', error => finish(error?.code || 'error'))
    socket.on('end', () => finish('end'))
    socket.on('close', () => finish('close'))
  })

const rawHttpPartialWithDeadline = (port, chunks, { deadlineMs = 12000, chunkDelayMs = 0 } = {}) =>
  new Promise((resolveRaw, rejectRaw) => {
    const startedAt = Date.now()
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let settled = false
    let data = ''
    const finish = reason => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      resolveRaw({ data, elapsedMs: Date.now() - startedAt, reason })
    }
    const writeChunks = async () => {
      try {
        for (const chunk of chunks) {
          if (settled) return
          socket.write(chunk)
          if (chunkDelayMs > 0) await new Promise(resolveWait => setTimeout(resolveWait, chunkDelayMs))
        }
      } catch (error) {
        if (!settled) rejectRaw(error)
      }
    }
    const timeout = setTimeout(() => finish('deadline'), deadlineMs)
    socket.on('connect', writeChunks)
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
    })
    socket.on('error', error => finish(error?.code || 'error'))
    socket.on('end', () => finish('end'))
    socket.on('close', () => finish('close'))
  })

const corsAllowHeaders = [
  'access-control-allow-origin',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-credentials'
]

const readJsonEnvelope = async response => ({ status: response.status, body: await response.json(), headers: response.headers })

const assertJsonSecurityHeaders = (response, label, { referrerPolicy = false } = {}) => {
  assert(
    /^application\/json; charset=utf-8\b/i.test(response.headers.get('content-type') || ''),
    `${label} did not return JSON content-type.`
  )
  assert(response.headers.get('cache-control') === 'no-store', `${label} did not return Cache-Control: no-store.`)
  assert(response.headers.get('x-content-type-options') === 'nosniff', `${label} did not return X-Content-Type-Options: nosniff.`)
  if (referrerPolicy) assert(response.headers.get('referrer-policy') === 'no-referrer', `${label} did not return no-referrer.`)
}

const assertNoCorsAllowHeaders = (headers, label) => {
  for (const header of corsAllowHeaders) {
    assert(!headers.has(header), `${label} returned ${header}.`)
  }
}

const parseBridgeConfig = html => {
  const match = html.match(/<script id="stackprism-agent-bridge-config" type="application\/json" nonce="[^"]+">([^<]+)<\/script>/)
  assert(match, `Bridge HTML did not include config JSON: ${redactText(html)}`)
  const config = JSON.parse(match[1])
  assert(/^spbt_[A-Za-z0-9_-]{43}$/.test(config.bridgeToken || ''), 'Bridge config did not include a valid bridge token.')
  return config
}

const runClearedStorageSessionScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const slowFixture = await harness.startSlowFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const cleared = await harness.driveCaptureWithClearedStorageSessionAndReload(bridge.ready, worker, capture, slowFixture.url)
    assert(cleared.finalStatus?.status === 'failed', `Expected failed terminal status: ${JSON.stringify(cleared.finalStatus)}`)
    assert(
      ['BRIDGE_TRANSPORT_DISCONNECTED', 'CAPTURE_TIMEOUT', 'EXTENSION_NOT_CONNECTED'].includes(cleared.finalStatus.error?.code),
      `Unexpected failure code: ${JSON.stringify(cleared.finalStatus)}`
    )
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Profile endpoint returned fake success: ${JSON.stringify(profile.body)}`)
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          clearedStorageSessionReloaded: {
            status: cleared.finalStatus.status,
            errorCode: cleared.finalStatus.error?.code,
            profileStatus: profile.status,
            targetTabId: cleared.targetTabId,
            targetStillVisible: cleared.targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    slowFixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runLocalOptInDisabledScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const slowFixture = await harness.startSlowFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const disabled = await harness.driveCaptureWithLocalOptInDisabled(bridge.ready, worker, capture, slowFixture.url)
    assert(disabled.finalStatus?.status === 'failed', `Expected failed terminal status: ${JSON.stringify(disabled.finalStatus)}`)
    assert(disabled.finalStatus.error?.code === 'AGENT_BRIDGE_DISABLED', `Unexpected failure code: ${JSON.stringify(disabled.finalStatus)}`)
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Profile endpoint returned fake success: ${JSON.stringify(profile.body)}`)
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          localOptInDisabled: {
            status: disabled.finalStatus.status,
            errorCode: disabled.finalStatus.error?.code,
            profileStatus: profile.status,
            targetTabId: disabled.targetTabId,
            targetStillVisible: disabled.targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    slowFixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runBrowserExtensionDisabledScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const slowFixture = await harness.startSlowFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  let opened
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    const extensionId = new URL(workerTarget.url).host
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    opened = await harness.openBridgePage(capture.body.bridgeUrl)
    const runningState = await harness.waitForExtensionCaptureState(worker, capture.body.id, value => Number.isInteger(value.targetTabId))
    const disabled = await harness.disableExtensionFromExtensionsPage(extensionId)
    assert(
      disabled.found && disabled.before === true && disabled.after === false,
      `Extension toggle did not disable: ${JSON.stringify(disabled)}`
    )
    const finalStatus = await harness.pollCapture(bridge.ready, capture.body.id, 80)
    assert(finalStatus?.status === 'failed', `Expected failed terminal status: ${JSON.stringify(finalStatus)}`)
    assert(
      ['BRIDGE_TRANSPORT_DISCONNECTED', 'SERVICE_WORKER_RESTARTED', 'CAPTURE_TIMEOUT', 'EXTENSION_NOT_CONNECTED'].includes(
        finalStatus.error?.code
      ),
      `Unexpected failure code: ${JSON.stringify(finalStatus)}`
    )
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Profile endpoint returned fake success: ${JSON.stringify(profile.body)}`)
    const targets = await harness.listTargets()
    const targetStillVisible = targets.some(target => target.type === 'page' && String(target.url || '').startsWith(slowFixture.url))
    assert(!targetStillVisible, `Browser-disabled target remained visible for tab ${runningState.targetTabId}.`)
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          browserExtensionDisabled: {
            extensionId,
            targetTabId: runningState.targetTabId,
            toggleBefore: disabled.before,
            toggleAfter: disabled.after,
            status: finalStatus.status,
            errorCode: finalStatus.error?.code,
            profileStatus: profile.status,
            targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    opened?.page.close()
    worker?.close()
    await harness.stopBridge(bridge)
    slowFixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runBrowserExtensionReloadedScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const slowFixture = await harness.startSlowFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  let opened
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    const extensionId = new URL(workerTarget.url).host
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    opened = await harness.openBridgePage(capture.body.bridgeUrl)
    const runningState = await harness.waitForExtensionCaptureState(worker, capture.body.id, value => Number.isInteger(value.targetTabId))
    const reloaded = await harness.reloadExtensionFromExtensionsPage(extensionId)
    assert(reloaded.found && reloaded.clicked, `Extension reload button did not click: ${JSON.stringify(reloaded)}`)
    const finalStatus = await harness.pollCapture(bridge.ready, capture.body.id, 80)
    assert(finalStatus?.status === 'failed', `Expected failed terminal status: ${JSON.stringify(finalStatus)}`)
    assert(
      ['BRIDGE_TRANSPORT_DISCONNECTED', 'SERVICE_WORKER_RESTARTED', 'CAPTURE_TIMEOUT', 'EXTENSION_NOT_CONNECTED'].includes(
        finalStatus.error?.code
      ),
      `Unexpected failure code: ${JSON.stringify(finalStatus)}`
    )
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Profile endpoint returned fake success: ${JSON.stringify(profile.body)}`)
    const targets = await harness.listTargets()
    const targetStillVisible = targets.some(target => target.type === 'page' && String(target.url || '').startsWith(slowFixture.url))
    assert(!targetStillVisible, `Browser-reloaded target remained visible for tab ${runningState.targetTabId}.`)
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          browserExtensionReloaded: {
            extensionId,
            targetTabId: runningState.targetTabId,
            reloadClicked: reloaded.clicked,
            status: finalStatus.status,
            errorCode: finalStatus.error?.code,
            profileStatus: profile.status,
            targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    opened?.page.close()
    worker?.close()
    await harness.stopBridge(bridge)
    slowFixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runIncognitoBridgeProbeScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const probe = await harness.startProbeServer()
  let chrome = await harness.startChrome()
  let bridge
  let initialWorker
  let opened
  try {
    await harness.waitForCdp()
    const initialWorkerTarget = await harness.waitForWorker()
    const extensionId = new URL(initialWorkerTarget.url).host
    initialWorker = await harness.connectTarget(initialWorkerTarget)
    await initialWorker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(initialWorker)
    await harness.setAgentBridgeEnabled(initialWorker, true)
    const incognitoEnabled = await harness.enableIncognitoFromExtensionsPage(extensionId)
    assert(
      incognitoEnabled.found && incognitoEnabled.after === true && incognitoEnabled.disabled !== true,
      `Incognito permission was not enabled: ${JSON.stringify(incognitoEnabled)}`
    )
    initialWorker.close()
    initialWorker = null
    await harness.stopChrome(chrome)
    chrome = await harness.startChrome({ profileDir: chrome.profileDir })

    const version = await harness.waitForCdp()
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: probe.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    opened = await harness.openIncognitoBridgePage(capture.body.bridgeUrl)
    const finalStatus = await harness.pollCapture(bridge.ready, capture.body.id, 40)
    const errorCode = finalStatus.error?.code
    assert(
      finalStatus?.status === 'failed' && ['INCOGNITO_NOT_SUPPORTED', 'EXTENSION_NOT_CONNECTED'].includes(errorCode),
      `Incognito bridge probe did not fail closed: ${JSON.stringify(finalStatus)}`
    )
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Incognito rejected capture returned fake profile: ${JSON.stringify(profile.body)}`)
    assert(probe.requestCount() === 0, `Incognito bridge rejection fetched target before failing: ${probe.requestCount()}`)
    const coverage = errorCode === 'INCOGNITO_NOT_SUPPORTED' ? 'live-rejected' : 'environment-skip-cdp-incognito-extension-not-connected'
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          incognitoBridgeProbe: {
            coverage,
            extensionId,
            permissionFound: incognitoEnabled.found,
            permissionEnabledAfter: incognitoEnabled.after,
            restartRequired: incognitoEnabled.restartRequired === true,
            status: finalStatus.status,
            errorCode,
            profileStatus: profile.status,
            targetRequestCount: probe.requestCount()
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await opened?.close?.()
    initialWorker?.close()
    await harness.stopBridge(bridge)
    probe.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runIncognitoWindowBridgeProbeScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const probe = await harness.startProbeServer()
  let chrome = await harness.startChrome()
  let bridge
  let initialWorker
  let opened
  try {
    await harness.waitForCdp()
    const initialWorkerTarget = await harness.waitForWorker()
    const extensionId = new URL(initialWorkerTarget.url).host
    initialWorker = await harness.connectTarget(initialWorkerTarget)
    await initialWorker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(initialWorker)
    await harness.setAgentBridgeEnabled(initialWorker, true)
    const incognitoEnabled = await harness.enableIncognitoFromExtensionsPage(extensionId)
    assert(
      incognitoEnabled.found && incognitoEnabled.after === true && incognitoEnabled.disabled !== true,
      `Incognito permission was not enabled: ${JSON.stringify(incognitoEnabled)}`
    )
    initialWorker.close()
    initialWorker = null
    await harness.stopChrome(chrome)
    chrome = await harness.startChrome({ profileDir: chrome.profileDir, extraArgs: ['--incognito'] })

    const version = await harness.waitForCdp()
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: probe.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    opened = await harness.openBridgePage(capture.body.bridgeUrl)
    const finalStatus = await harness.pollCapture(bridge.ready, capture.body.id, 40)
    const errorCode = finalStatus.error?.code
    assert(
      finalStatus?.status === 'failed' && ['INCOGNITO_NOT_SUPPORTED', 'EXTENSION_NOT_CONNECTED'].includes(errorCode),
      `Incognito window bridge probe did not fail closed: ${JSON.stringify(finalStatus)}`
    )
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Incognito window rejected capture returned fake profile: ${JSON.stringify(profile.body)}`)
    assert(probe.requestCount() === 0, `Incognito window rejection fetched target before failing: ${probe.requestCount()}`)
    const coverage = errorCode === 'INCOGNITO_NOT_SUPPORTED' ? 'live-rejected' : 'environment-skip-incognito-window-extension-not-connected'
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          incognitoWindowBridgeProbe: {
            coverage,
            extensionId,
            permissionFound: incognitoEnabled.found,
            permissionEnabledAfter: incognitoEnabled.after,
            restartRequired: incognitoEnabled.restartRequired === true,
            status: finalStatus.status,
            errorCode,
            profileStatus: profile.status,
            targetRequestCount: probe.requestCount()
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    opened?.page?.close()
    initialWorker?.close()
    await harness.stopBridge(bridge)
    probe.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runExpiredDeadlineReconciliationScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const fixture = await harness.startFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: fixture.url,
      waitMs: 30000,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const expired = await harness.driveCaptureWithExpiredDeadlineReconciliation(bridge.ready, worker, capture, fixture.url)
    assert(expired.finalStatus?.status === 'failed', `Expected failed terminal status: ${JSON.stringify(expired.finalStatus)}`)
    assert(expired.finalStatus.error?.code === 'CAPTURE_TIMEOUT', `Unexpected failure code: ${JSON.stringify(expired.finalStatus)}`)
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Profile endpoint returned fake success: ${JSON.stringify(profile.body)}`)
    assert(!expired.targetStillVisible, `Expired-deadline target remained visible for tab ${expired.targetTabId}.`)
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          expiredDeadlineReconciliation: {
            status: expired.finalStatus.status,
            errorCode: expired.finalStatus.error?.code,
            profileStatus: profile.status,
            targetTabId: expired.targetTabId,
            triggerTabId: expired.triggerTabId,
            targetStillVisible: expired.targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    fixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runFinalUrlBlockedScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const chrome = await harness.startChrome()
  let bridge
  let worker
  let redirectFixture
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    redirectFixture = await harness.startBridgeSelfRedirectServer(bridge.ready.baseUrl)
    const capture = await harness.createCapture(bridge.ready, {
      url: redirectFixture.url,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const redirected = await harness.driveCaptureWithFinalUrlBlocked(bridge.ready, capture, [
      redirectFixture.url,
      redirectFixture.finalUrlPrefix
    ])
    const finalStatus = redirected.finalStatus
    assert(finalStatus?.status === 'failed', `Expected failed terminal status: ${JSON.stringify(finalStatus)}`)
    assert(finalStatus.error?.code === 'FINAL_URL_BLOCKED', `Unexpected failure code: ${JSON.stringify(finalStatus)}`)
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Profile endpoint returned fake success: ${JSON.stringify(profile.body)}`)
    assert(!redirected.targetStillVisible, 'Final URL blocked target remained visible.')
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          finalUrlBlocked: {
            status: finalStatus.status,
            errorCode: finalStatus.error?.code,
            reason: finalStatus.error?.details?.reason || '',
            profileStatus: profile.status,
            requestCount: redirectFixture.requestCount(),
            targetStillVisible: redirected.targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    redirectFixture?.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runFinalPrivateUrlBlockedScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  let redirectFixture
  redirectFixture = await harness.startPrivateFinalProxyServer()
  const chrome = await harness.startChrome({
    extraArgs: [`--proxy-server=${redirectFixture.proxyUrl}`, '--proxy-bypass-list=127.0.0.1;localhost']
  })
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: redirectFixture.url,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: false, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const redirected = await harness.driveCaptureWithFinalUrlBlocked(bridge.ready, capture, [
      redirectFixture.url,
      redirectFixture.finalUrlPrefix
    ])
    const finalStatus = redirected.finalStatus
    assert(finalStatus?.status === 'failed', `Expected failed terminal status: ${JSON.stringify(finalStatus)}`)
    assert(finalStatus.error?.code === 'FINAL_URL_BLOCKED', `Unexpected failure code: ${JSON.stringify(finalStatus)}`)
    assert(
      finalStatus.error?.details?.reason === 'private_network_address',
      `Unexpected final URL block reason: ${JSON.stringify(finalStatus)}`
    )
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Profile endpoint returned fake success: ${JSON.stringify(profile.body)}`)
    assert(redirectFixture.proxyRequestCount() > 0, 'Public-IP proxy fixture was not reached before final URL validation.')
    assert(redirectFixture.privateRequestCount() > 0, 'Private final target was not reached before final URL validation.')
    assert(!redirected.targetStillVisible, 'Final private URL blocked target remained visible.')
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          finalPrivateUrlBlocked: {
            status: finalStatus.status,
            errorCode: finalStatus.error?.code,
            reason: finalStatus.error?.details?.reason || '',
            profileStatus: profile.status,
            proxyRequestCount: redirectFixture.proxyRequestCount(),
            privateRequestCount: redirectFixture.privateRequestCount(),
            targetStillVisible: redirected.targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    redirectFixture?.proxyServer.close()
    redirectFixture?.privateServer.close()
    await harness.cleanupChrome(chrome)
  }
}

const runFinalDnsPolicyBlockedScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  let redirectFixture
  redirectFixture = await harness.startDnsFinalProxyServer({ finalHostname: 'stackprism-browser-smoke.invalid' })
  const chrome = await harness.startChrome({
    extraArgs: [`--proxy-server=${redirectFixture.proxyUrl}`, '--proxy-bypass-list=127.0.0.1;localhost']
  })
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: redirectFixture.url,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: false, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const redirected = await harness.driveCaptureWithFinalUrlBlocked(bridge.ready, capture, [
      redirectFixture.url,
      redirectFixture.finalUrlPrefix
    ])
    const finalStatus = redirected.finalStatus
    assert(finalStatus?.status === 'failed', `Expected failed terminal status: ${JSON.stringify(finalStatus)}`)
    assert(finalStatus.error?.code === 'FINAL_URL_BLOCKED', `Unexpected failure code: ${JSON.stringify(finalStatus)}`)
    assert(
      ['private_network_address', 'dns_lookup_failed'].includes(finalStatus.error?.details?.reason),
      `Unexpected final URL block reason: ${JSON.stringify(finalStatus)}`
    )
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Profile endpoint returned fake success: ${JSON.stringify(profile.body)}`)
    assert(redirectFixture.proxyRequestCount() > 0, 'Public-IP proxy fixture was not reached before final URL validation.')
    assert(redirectFixture.finalRequestCount() > 0, 'DNS final target was not reached before final URL validation.')
    assert(!redirected.targetStillVisible, 'Final DNS policy blocked target remained visible.')
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          finalDnsPolicyBlocked: {
            status: finalStatus.status,
            errorCode: finalStatus.error?.code,
            hostname: redirectFixture.hostname,
            reason: finalStatus.error?.details?.reason || '',
            profileStatus: profile.status,
            proxyRequestCount: redirectFixture.proxyRequestCount(),
            finalRequestCount: redirectFixture.finalRequestCount(),
            targetStillVisible: redirected.targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    redirectFixture?.proxyServer.close()
    await harness.cleanupChrome(chrome)
  }
}

const runFinalDnsLookupFailedScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const lookupFailedHostname = `${'a'.repeat(64)}.com`
  let redirectFixture
  redirectFixture = await harness.startDnsFinalProxyServer({ finalHostname: lookupFailedHostname })
  const chrome = await harness.startChrome({
    extraArgs: [`--proxy-server=${redirectFixture.proxyUrl}`, '--proxy-bypass-list=127.0.0.1;localhost']
  })
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: redirectFixture.url,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: false, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const redirected = await harness.driveCaptureWithFinalUrlBlocked(bridge.ready, capture, [
      redirectFixture.url,
      redirectFixture.finalUrlPrefix
    ])
    const finalStatus = redirected.finalStatus
    assert(finalStatus?.status === 'failed', `Expected failed terminal status: ${JSON.stringify(finalStatus)}`)
    assert(finalStatus.error?.code === 'FINAL_URL_BLOCKED', `Unexpected failure code: ${JSON.stringify(finalStatus)}`)
    assert(finalStatus.error?.details?.reason === 'dns_lookup_failed', `Unexpected final URL block reason: ${JSON.stringify(finalStatus)}`)
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Profile endpoint returned fake success: ${JSON.stringify(profile.body)}`)
    assert(redirectFixture.proxyRequestCount() > 0, 'Public-IP proxy fixture was not reached before final URL validation.')
    assert(redirectFixture.finalRequestCount() > 0, 'DNS lookup-failed final target was not reached before final URL validation.')
    assert(!redirected.targetStillVisible, 'Final DNS lookup failed target remained visible.')
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          finalDnsLookupFailed: {
            status: finalStatus.status,
            errorCode: finalStatus.error?.code,
            hostname: redirectFixture.hostname,
            reason: finalStatus.error?.details?.reason || '',
            profileStatus: profile.status,
            proxyRequestCount: redirectFixture.proxyRequestCount(),
            finalRequestCount: redirectFixture.finalRequestCount(),
            targetStillVisible: redirected.targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    redirectFixture?.proxyServer.close()
    await harness.cleanupChrome(chrome)
  }
}

const runPrivateTargetBlockedScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const privateTarget = await harness.startProbeServer()
  const chrome = await harness.startChrome()
  let bridge
  try {
    const version = await harness.waitForCdp()
    await harness.waitForWorker()
    bridge = await harness.startBridge()
    const blocked = await harness.createPrivateTargetBlockedCapture(bridge.ready, privateTarget)
    const createResult = blocked.blocked
    assert(createResult.status === 400, `Private target was not rejected: ${JSON.stringify(createResult)}`)
    assert(
      createResult.body.error?.code === 'PRIVATE_NETWORK_TARGET_BLOCKED',
      `Unexpected private target error: ${JSON.stringify(createResult)}`
    )
    assert(blocked.requestCount === 0, 'Private target server was contacted before bridge rejection.')
    assert(!blocked.targetStillVisible, 'Blocked private target became visible in CDP targets.')
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          privateTargetBlocked: {
            createStatus: createResult.status,
            errorCode: createResult.body.error?.code,
            reason: createResult.body.error?.details?.reason || '',
            requestCount: blocked.requestCount,
            targetStillVisible: blocked.targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await harness.stopBridge(bridge)
    privateTarget.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runDnsNonGlobalBlockedScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const chrome = await harness.startChrome()
  let bridge
  try {
    const version = await harness.waitForCdp()
    await harness.waitForWorker()
    bridge = await harness.startBridge()
    const blocked = await harness.createDnsNonGlobalBlockedCapture(bridge.ready)
    const createResult = blocked.blocked
    assert(createResult.status === 400, `DNS policy target was not rejected: ${JSON.stringify(createResult)}`)
    assert(
      ['PRIVATE_NETWORK_TARGET_BLOCKED', 'TARGET_DNS_LOOKUP_FAILED'].includes(createResult.body.error?.code),
      `Unexpected DNS policy error: ${JSON.stringify(createResult)}`
    )
    assert(!blocked.targetStillVisible, 'Blocked DNS policy target became visible in CDP targets.')
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          dnsNonGlobalBlocked: {
            hostname: blocked.hostname,
            resolvedAddresses: blocked.resolvedAddresses,
            dnsError: blocked.dnsError,
            createStatus: createResult.status,
            errorCode: createResult.body.error?.code,
            reason: createResult.body.error?.details?.reason || '',
            targetStillVisible: blocked.targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await harness.stopBridge(bridge)
    await harness.cleanupChrome(chrome)
  }
}

const runDnsLookupFailedScenario = async () => {
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  let bridge
  try {
    bridge = await harness.startBridge()
    const hostname = `${'a'.repeat(64)}.com`
    const targetUrl = `https://${hostname}/dns-lookup-failed?token=secret#frag`
    let dnsError = ''
    try {
      await import('node:dns/promises').then(({ lookup }) => lookup(hostname, { all: true, verbatim: true }))
    } catch (error) {
      dnsError = error?.code || (error instanceof Error ? error.message : String(error))
    }
    assert(dnsError, 'DNS lookup failure fixture unexpectedly resolved.')
    const createResult = await harness.createCapture(bridge.ready, {
      url: targetUrl,
      options: { allowPrivateNetworkTarget: false, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(createResult.status === 400, `DNS lookup failure target was not rejected: ${JSON.stringify(createResult)}`)
    assert(
      createResult.body.error?.code === 'TARGET_DNS_LOOKUP_FAILED',
      `Unexpected DNS lookup failure error: ${JSON.stringify(createResult)}`
    )
    assert(
      createResult.body.error?.details?.reason === 'dns_lookup_failed',
      `Unexpected DNS lookup failure reason: ${JSON.stringify(createResult)}`
    )
    const health = await harness.fetchJson(bridge.ready.healthUrl)
    assert(health.status === 200 && health.body.activeCaptures === 0, `DNS lookup failure left active capture: ${JSON.stringify(health)}`)
    console.log(
      JSON.stringify(
        {
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          dnsLookupFailed: {
            hostname,
            dnsError,
            createStatus: createResult.status,
            errorCode: createResult.body.error?.code,
            reason: createResult.body.error?.details?.reason || '',
            activeCapturesAfterReject: health.body.activeCaptures
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await harness.stopBridge(bridge)
  }
}

const runBridgeSelfTargetBlockedScenario = async () => {
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  let bridge
  try {
    bridge = await harness.startBridge()
    const selfTargetUrl = `${bridge.ready.baseUrl}/bridge?session=s_test&capture=c_test&nonce=n_test#apiToken=secret`
    const localhostAliasUrl = selfTargetUrl.replace('127.0.0.1', 'localhost')
    const options = { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    const selfTarget = await harness.createCapture(bridge.ready, { url: selfTargetUrl, options })
    const localhostAlias = await harness.createCapture(bridge.ready, { url: localhostAliasUrl, options })
    assert(selfTarget.status === 400, `Bridge self-target was not rejected: ${JSON.stringify(selfTarget)}`)
    assert(
      selfTarget.body.error?.code === 'BRIDGE_SELF_TARGET_BLOCKED',
      `Unexpected bridge self-target error: ${JSON.stringify(selfTarget)}`
    )
    assert(localhostAlias.status === 400, `Bridge localhost alias self-target was not rejected: ${JSON.stringify(localhostAlias)}`)
    assert(
      localhostAlias.body.error?.code === 'BRIDGE_SELF_TARGET_BLOCKED',
      `Unexpected bridge localhost alias self-target error: ${JSON.stringify(localhostAlias)}`
    )
    const health = await harness.fetchJson(bridge.ready.healthUrl)
    assert(
      health.status === 200 && health.body.activeCaptures === 0,
      `Bridge self-target rejection left active capture: ${JSON.stringify(health)}`
    )
    console.log(
      JSON.stringify(
        {
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          bridgeSelfTargetBlocked: {
            createStatus: selfTarget.status,
            errorCode: selfTarget.body.error?.code,
            localhostAliasStatus: localhostAlias.status,
            localhostAliasErrorCode: localhostAlias.body.error?.code,
            activeCapturesAfterReject: health.body.activeCaptures
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await harness.stopBridge(bridge)
  }
}

const runActiveTabUnavailableScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const probe = await harness.startProbeServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()

    const capture = await harness.createCapture(bridge.ready, {
      url: probe.url,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'active_tab' }
    })
    assert(capture.status === 200, `Active-tab-unavailable capture creation failed: ${JSON.stringify(capture)}`)
    const opened = await harness.openBridgePage(capture.body.bridgeUrl)
    let finalStatus
    let profile
    let dom
    try {
      finalStatus = await harness.pollCapture(bridge.ready, capture.body.id, 30)
      profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
        headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
      })
      dom = await opened.page.send('Runtime.evaluate', {
        expression:
          '({ready:document.documentElement.dataset.stackprismAgentBridgeClient||"",error:document.documentElement.dataset.stackprismAgentBridgeError||"",title:document.title})',
        returnByValue: true
      })
    } finally {
      try {
        opened.page.close()
      } catch {}
      await harness.closeTarget(opened.target.id).catch(() => {})
    }
    assert(
      finalStatus?.status === 'failed' && finalStatus.error?.code === 'ACTIVE_TAB_UNAVAILABLE',
      `Active-tab unavailable did not fail as ACTIVE_TAB_UNAVAILABLE: ${JSON.stringify(finalStatus)}`
    )
    assert(profile.status !== 200, `Active-tab unavailable returned fake profile: ${JSON.stringify(profile.body)}`)
    assert(probe.requestCount() === 0, `Active-tab unavailable fetched target before resolving active tab: ${probe.requestCount()}`)
    const tabs = await harness.listExtensionTabs(worker)
    assert(!tabs.some(tab => String(tab.url).startsWith(probe.url)), `Active-tab unavailable opened target URL: ${JSON.stringify(tabs)}`)

    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          activeTabUnavailable: {
            status: finalStatus.status,
            errorCode: finalStatus.error?.code,
            profileStatus: profile.status,
            targetRequestCount: probe.requestCount(),
            targetTabOpened: false,
            bridgeDom: dom.result.value
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    probe.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runCaptureBusyScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const slowFixture = await harness.startSlowFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  let opened
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const first = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(first.status === 200, `First capture creation failed: ${JSON.stringify(first)}`)
    opened = await harness.openBridgePage(first.body.bridgeUrl)
    const runningState = await harness.waitForExtensionCaptureState(worker, first.body.id, value => Number.isInteger(value.targetTabId))
    const second = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(second.status === 429, `Second capture was not rejected as busy: ${JSON.stringify(second)}`)
    assert(second.body.error?.code === 'CAPTURE_BUSY', `Second capture error was not CAPTURE_BUSY: ${JSON.stringify(second)}`)
    const cancel = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${first.body.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(cancel.status === 200, `DELETE running capture returned ${cancel.status}.`)
    const finalStatus = await harness.pollCapture(bridge.ready, first.body.id, 20)
    assert(finalStatus.status === 'cancelled', `First capture did not cancel cleanly: ${JSON.stringify(finalStatus)}`)
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${first.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Cancelled capture returned fake profile: ${JSON.stringify(profile.body)}`)
    const targets = await harness.listTargets()
    const targetStillVisible = targets.some(target => target.type === 'page' && String(target.url || '').startsWith(slowFixture.url))
    assert(!targetStillVisible, `Cancelled busy-smoke target remained visible for tab ${runningState.targetTabId}.`)
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          captureBusy: {
            firstCaptureId: first.body.id,
            targetTabId: runningState.targetTabId,
            secondStatus: second.status,
            secondErrorCode: second.body.error?.code,
            cancelStatus: cancel.status,
            finalStatus: finalStatus.status,
            profileStatus: profile.status,
            targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    opened?.page.close()
    worker?.close()
    await harness.stopBridge(bridge)
    slowFixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runTechOnlyScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const fixture = await harness.startFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: fixture.url,
      include: ['tech'],
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, maxResourceUrls: 50, captureScreenshotMetadata: true, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Tech-only capture creation failed: ${JSON.stringify(capture)}`)
    const driven = await harness.driveCapture(bridge.ready, capture)
    assert(driven.finalStatus?.status === 'completed', `Tech-only capture did not complete: ${JSON.stringify(driven.finalStatus)}`)
    assert(driven.profile?.status === 200, `Tech-only profile read failed: ${JSON.stringify(driven.profile)}`)
    assertSectionNotRequested(driven.profile, ['visual', 'layout', 'components', 'interaction', 'ux', 'assets'])
    assert(!profileSummary(driven.profile, capture.body.id).screenshotMetadataPresent, 'Tech-only profile included profiler metadata.')
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          techOnly: {
            status: driven.finalStatus.status,
            profile: profileSummary(driven.profile, capture.body.id),
            limitations: driven.profile.body.limitations
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    fixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runPublicComplexTargetScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()

    const targetResolution = await resolveTargetAddresses(externalTargetUrl)
    const capture = await harness.createCapture(bridge.ready, {
      url: externalTargetUrl,
      include: ['tech', 'visual', 'layout', 'components', 'interaction', 'ux', 'assets'],
      waitMs: 1000,
      options: {
        allowPrivateNetworkTarget: true,
        captureScreenshotMetadata: false,
        keepTabOpen: false,
        maxResourceUrls: 100,
        targetMode: 'new_tab'
      }
    })
    assert(capture.status === 200, `Public complex target capture creation failed: ${JSON.stringify(capture)}`)
    const driven = await harness.driveCapture(bridge.ready, capture)
    assert(
      driven.finalStatus?.status === 'completed',
      `Public complex target capture did not complete: ${JSON.stringify(driven.finalStatus)}`
    )
    assert(driven.profile?.status === 200, `Public complex target profile read failed: ${JSON.stringify(driven.profile)}`)
    const profile = profileSummary(driven.profile, capture.body.id)
    assert(profile?.schema === 'stackprism.site_experience_profile.v1', 'Public complex target profile schema mismatch.')
    assert(profile.targetFinalUrl.startsWith('https://'), `Public complex target final URL was not HTTPS: ${profile.targetFinalUrl}`)
    assert(profile.userAgentPresent, 'Public complex target profile did not include browser user agent.')
    assert(profile.visualKeys.length > 0, 'Public complex target visual profile was empty.')
    assert(profile.layoutKeys.length > 0, 'Public complex target layout profile was empty.')
    assert(profile.componentKeys.length > 0, 'Public complex target component profile was empty.')
    assert(!targetResolution.dnsError, `Public complex target DNS lookup failed: ${targetResolution.dnsError}`)
    assert(!profile.screenshotMetadataPresent, 'Public complex target included screenshot metadata without request.')
    assert(!profile.screenshotPayloadPresent, 'Public complex target included screenshot image or pixel payload.')
    assert(!profile.privacyLeakDetected, 'Public complex target profile included privacy leak markers.')

    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          target: {
            requestedUrl: externalTargetUrl,
            resolvedHostname: targetResolution.hostname,
            resolvedAddresses: targetResolution.addresses,
            dnsError: targetResolution.dnsError || '',
            privateNetworkOverrideUsed: true
          },
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          publicComplexTarget: {
            status: driven.finalStatus.status,
            phase: driven.finalStatus.phase,
            profile
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    await harness.cleanupChrome(chrome)
  }
}

const runVisualScreenshotScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const fixture = await harness.startFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()

    const capture = await harness.createCapture(bridge.ready, {
      url: fixture.url,
      include: ['visual', 'layout', 'ux'],
      waitMs: 100,
      options: {
        allowPrivateNetworkTarget: true,
        captureScreenshot: true,
        captureScreenshotMetadata: false,
        keepTabOpen: false,
        maxResourceUrls: 50,
        targetMode: 'new_tab'
      }
    })
    assert(capture.status === 200, `Visual screenshot capture creation failed: ${JSON.stringify(capture)}`)
    const driven = await harness.driveCapture(bridge.ready, capture)
    assert(driven.finalStatus?.status === 'completed', `Visual screenshot capture did not complete: ${JSON.stringify(driven.finalStatus)}`)
    assert(driven.profile?.status === 200, `Visual screenshot profile read failed: ${JSON.stringify(driven.profile)}`)
    const profile = profileSummary(driven.profile, capture.body.id)
    const screenshot = driven.profile.body.visualProfile?.screenshot
    const visualReference = driven.profile.body.agentGuidance?.recreationPlan?.visualReference
    const screenshotFailureLimitations = [
      'screenshot_capture_unavailable',
      'screenshot_capture_invalid',
      'screenshot_image_too_large',
      'screenshot_capture_failed'
    ]
    if (profile?.screenshotPayloadPresent) {
      assert(typeof screenshot?.dataUrl === 'string' && screenshot.dataUrl.startsWith('data:image/jpeg;base64,'), 'Screenshot data URL is invalid.')
      assert(screenshot.mimeType === 'image/jpeg', `Unexpected screenshot mime type: ${screenshot.mimeType}`)
      assert(screenshot.scope === 'visible_viewport', `Unexpected screenshot scope: ${screenshot.scope}`)
      assert(Number.isInteger(screenshot.byteLength) && screenshot.byteLength > 1000, `Unexpected screenshot byte length: ${screenshot.byteLength}`)
      assert(visualReference?.screenshotIncluded === true, 'Agent guidance did not mark screenshot as included.')
    } else {
      assert(
        screenshotFailureLimitations.some(limitation => driven.profile.body.limitations.includes(limitation)),
        `Visual screenshot request omitted payload without a screenshot limitation: ${JSON.stringify(driven.profile.body.limitations)}`
      )
      assert(visualReference?.screenshotIncluded === false, 'Agent guidance marked missing screenshot as included.')
    }
    assert(!driven.profile.body.limitations.includes('screenshot_image_not_requested'), 'Profile still reported screenshot not requested.')

    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          visualScreenshot: {
            status: driven.finalStatus.status,
            phase: driven.finalStatus.phase,
            profile,
            screenshot: {
              included: Boolean(profile.screenshotPayloadPresent),
              mimeType: screenshot?.mimeType || '',
              byteLength: screenshot?.byteLength || 0,
              scope: screenshot?.scope || '',
              source: screenshot?.source || ''
            },
            visualReference
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    fixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runServiceWorkerIdleWakeScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const fixture = await harness.startFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    worker.close()
    worker = null

    const idle = await harness.waitForNoWorker()
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: fixture.url,
      include: ['tech'],
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Idle-wake capture creation failed: ${JSON.stringify(capture)}`)
    const driven = await harness.driveCapture(bridge.ready, capture)
    assert(driven.finalStatus?.status === 'completed', `Idle-wake capture did not complete: ${JSON.stringify(driven.finalStatus)}`)
    assert(driven.profile?.status === 200, `Idle-wake profile read failed: ${JSON.stringify(driven.profile)}`)
    const wokenWorkerTarget = await harness.waitForWorker()

    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          serviceWorkerIdleWake: {
            initialWorkerTargetId: workerTarget.id,
            idleElapsedMs: idle.elapsedMs,
            idleAttempts: idle.attempts,
            wokenWorkerTargetId: wokenWorkerTarget.id,
            status: driven.finalStatus.status,
            profile: profileSummary(driven.profile, capture.body.id)
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    fixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runSequentialCapturePressureScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const fixture = await harness.startFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()
    const targetPrefix = withoutFragment(fixture.url)
    const rounds = []

    for (let index = 0; index < 4; index += 1) {
      const capture = await harness.createCapture(bridge.ready, {
        url: fixture.url,
        waitMs: 100,
        options: {
          allowPrivateNetworkTarget: true,
          captureScreenshotMetadata: index % 2 === 0,
          keepTabOpen: false,
          maxResourceUrls: 50,
          targetMode: 'new_tab'
        }
      })
      assert(capture.status === 200, `Sequential capture ${index + 1} creation failed: ${JSON.stringify(capture)}`)
      const driven = await harness.driveCapture(bridge.ready, capture)
      assert(
        driven.finalStatus?.status === 'completed',
        `Sequential capture ${index + 1} did not complete: ${JSON.stringify(driven.finalStatus)}`
      )
      assert(driven.profile?.status === 200, `Sequential capture ${index + 1} profile read failed: ${JSON.stringify(driven.profile)}`)
      const health = await harness.fetchJson(bridge.ready.healthUrl)
      assert(health.body?.activeCaptures === 0, `Sequential capture ${index + 1} left active captures: ${JSON.stringify(health)}`)
      const targetCleanup = await harness.waitForNoPageTarget(targetPrefix)
      assert(
        !targetCleanup.targetStillVisible,
        `Sequential capture ${index + 1} left target tab visible: ${JSON.stringify(targetCleanup.visibleTargets)}`
      )
      rounds.push({
        round: index + 1,
        status: driven.finalStatus.status,
        phase: driven.finalStatus.phase,
        profileStatus: driven.profile.status,
        activeCaptures: health.body.activeCaptures,
        targetStillVisible: targetCleanup.targetStillVisible,
        screenshotMetadataPresent: profileSummary(driven.profile, capture.body.id).screenshotMetadataPresent
      })
    }

    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          sequentialCapturePressure: {
            rounds
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    fixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runTargetNavigatedAwayScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const fixture = await harness.startFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()

    const origin = new URL(fixture.url).origin
    const awayUrl = `${origin}/target-navigated-away?view=other`
    const capture = await harness.createCapture(bridge.ready, {
      url: fixture.url,
      include: ['visual'],
      waitMs: 5000,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Target navigation-away capture creation failed: ${JSON.stringify(capture)}`)
    const navigatedAway = await harness.driveCaptureWithTargetNavigationAway(bridge.ready, worker, capture, awayUrl, origin)
    assert(
      navigatedAway.finalStatus?.status === 'failed' &&
        navigatedAway.finalStatus.error?.code === 'TARGET_NAVIGATED_AWAY' &&
        navigatedAway.finalStatus.error?.details?.finalUrlChanged === true,
      `Target navigation-away capture did not fail as TARGET_NAVIGATED_AWAY: ${JSON.stringify(navigatedAway.finalStatus)}`
    )
    assert(navigatedAway.profileStatus !== 200, `Navigation-away capture returned fake profile: ${JSON.stringify(navigatedAway)}`)
    assert(!navigatedAway.targetStillVisible, `Navigation-away target remained visible: ${JSON.stringify(navigatedAway)}`)

    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          targetNavigatedAway: {
            status: navigatedAway.finalStatus.status,
            errorCode: navigatedAway.finalStatus.error?.code,
            finalUrlChanged: navigatedAway.finalStatus.error?.details?.finalUrlChanged === true,
            originalFinalUrl: navigatedAway.originalFinalUrl,
            requestedAwayUrl: navigatedAway.requestedAwayUrl,
            updateResultUrl: navigatedAway.updateResultUrl,
            profileStatus: navigatedAway.profileStatus,
            targetTabId: navigatedAway.targetTabId,
            targetStillVisible: navigatedAway.targetStillVisible
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    fixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runTargetLoadFailedScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const loadFailure = await harness.startLoadFailureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()

    const capture = await harness.createCapture(bridge.ready, {
      url: loadFailure.url,
      include: ['visual'],
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Target load-failed capture creation failed: ${JSON.stringify(capture)}`)
    const failedLoad = await harness.driveCaptureWithTargetLoadFailure(bridge.ready, worker, capture)
    assert(
      failedLoad.finalStatus?.status === 'failed' && failedLoad.finalStatus.error?.code === 'TARGET_LOAD_FAILED',
      `Target load failure did not fail as TARGET_LOAD_FAILED: ${JSON.stringify(failedLoad.finalStatus)}`
    )
    assert(failedLoad.profileStatus !== 200, `Load-failed capture returned fake profile: ${JSON.stringify(failedLoad)}`)
    assert(!failedLoad.targetStillExists, `Load-failed target tab remained open: ${JSON.stringify(failedLoad)}`)
    assert(loadFailure.requestCount() > 0, 'Load failure fixture was not reached by Chrome.')

    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          targetLoadFailed: {
            status: failedLoad.finalStatus.status,
            errorCode: failedLoad.finalStatus.error?.code,
            profileStatus: failedLoad.profileStatus,
            requestCount: loadFailure.requestCount(),
            targetTabId: failedLoad.targetTabId,
            targetStillExists: failedLoad.targetStillExists
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    loadFailure.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runTargetLoadTimeoutScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const slowFixture = await harness.startSlowFixtureServer(70000)
  const chrome = await harness.startChrome()
  let bridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()

    const capture = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      include: ['visual'],
      waitMs: 0,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Target load-timeout capture creation failed: ${JSON.stringify(capture)}`)
    const timedOut = await harness.driveCaptureWithTargetLoadTimeout(bridge.ready, worker, capture)
    assert(
      timedOut.finalStatus?.status === 'failed' && timedOut.finalStatus.error?.code === 'TARGET_LOAD_TIMEOUT',
      `Target load timeout did not fail as TARGET_LOAD_TIMEOUT: ${JSON.stringify(timedOut.finalStatus)}`
    )
    assert(timedOut.profileStatus !== 200, `Load-timeout capture returned fake profile: ${JSON.stringify(timedOut)}`)
    assert(!timedOut.targetStillExists, `Load-timeout target tab remained open: ${JSON.stringify(timedOut)}`)

    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          targetLoadTimeout: {
            status: timedOut.finalStatus.status,
            errorCode: timedOut.finalStatus.error?.code,
            profileStatus: timedOut.profileStatus,
            targetTabId: timedOut.targetTabId,
            targetStillExists: timedOut.targetStillExists
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    slowFixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runTargetModeQueryBoundariesScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const fixture = await harness.startFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let worker
  const createdTabIds = new Set()
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)
    bridge = await harness.startBridge()

    const origin = new URL(fixture.url).origin
    const reuseExistingUrl = `${origin}/target-mode-query?view=existing`
    const reuseCaptureUrl = `${origin}/target-mode-query?view=capture`
    const activeExistingUrl = `${origin}/target-mode-active?view=existing`
    const activeCaptureUrl = `${origin}/target-mode-active?view=capture`

    const reuseExistingTab = await harness.createExtensionTab(worker, reuseExistingUrl, { active: true })
    createdTabIds.add(reuseExistingTab.id)
    const reuseCapture = await harness.createCapture(bridge.ready, {
      url: reuseCaptureUrl,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: true, targetMode: 'reuse_or_new_tab' }
    })
    assert(reuseCapture.status === 200, `Reuse query capture creation failed: ${JSON.stringify(reuseCapture)}`)
    const reused = await harness.driveCapture(bridge.ready, reuseCapture)
    assert(reused.finalStatus?.status === 'completed', `Reuse query capture did not complete: ${JSON.stringify(reused.finalStatus)}`)
    const afterReuseTabs = await harness.listExtensionTabs(worker)
    const separateQueryTabs = afterReuseTabs.filter(tab => tab.id !== reuseExistingTab.id && String(tab.url).startsWith(reuseCaptureUrl))
    for (const tab of separateQueryTabs) createdTabIds.add(tab.id)
    assert(
      afterReuseTabs.some(tab => tab.id === reuseExistingTab.id && String(tab.url).startsWith(reuseExistingUrl)),
      `Existing query tab was not preserved: ${JSON.stringify(afterReuseTabs)}`
    )
    assert(separateQueryTabs.length > 0, `Query-different target did not open a separate tab: ${JSON.stringify(afterReuseTabs)}`)
    const keptNewTargetTabId = separateQueryTabs[0].id

    const activeExistingTab = await harness.createExtensionTab(worker, activeExistingUrl, { active: true })
    createdTabIds.add(activeExistingTab.id)
    const activeCapture = await harness.createCapture(bridge.ready, {
      url: activeCaptureUrl,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'active_tab' }
    })
    assert(activeCapture.status === 200, `Active-tab capture creation failed: ${JSON.stringify(activeCapture)}`)
    const activeMismatch = await harness.driveCapture(bridge.ready, activeCapture)
    assert(
      activeMismatch.finalStatus?.status === 'failed' && activeMismatch.finalStatus.error?.code === 'ACTIVE_TAB_MISMATCH',
      `Active-tab query mismatch did not fail as ACTIVE_TAB_MISMATCH: ${JSON.stringify(activeMismatch.finalStatus)}`
    )
    const afterActiveTabs = await harness.listExtensionTabs(worker)
    assert(
      !afterActiveTabs.some(tab => String(tab.url).startsWith(activeCaptureUrl)),
      `Active-tab mismatch unexpectedly opened the target URL: ${JSON.stringify(afterActiveTabs)}`
    )

    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          targetModeQueryBoundaries: {
            reuseStatus: reused.finalStatus.status,
            existingTabId: reuseExistingTab.id,
            separateQueryTabFound: true,
            keepTabOpenWasTrue: true,
            keptNewTargetTabId,
            activeStatus: activeMismatch.finalStatus.status,
            activeErrorCode: activeMismatch.finalStatus.error?.code,
            activeExistingTabId: activeExistingTab.id
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    if (worker) {
      await Promise.all([...createdTabIds].map(tabId => harness.removeTab(worker, tabId).catch(() => {})))
      worker.close()
    }
    await harness.stopBridge(bridge)
    fixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runBridgeIframeBlockedScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const chrome = await harness.startChrome()
  let bridge
  try {
    const version = await harness.waitForCdp()
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: externalTargetUrl,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const iframeProbe = await harness.probeBridgeIframeBlocking(capture.body.bridgeUrl)
    assert(iframeProbe.attackerRequestCount === 1, `Attacker iframe page was not requested once: ${JSON.stringify(iframeProbe)}`)
    assert(!iframeProbe.probe.outerHtmlIncludesBridgeToken, `Attacker DOM included bridge token: ${JSON.stringify(iframeProbe)}`)
    assert(!iframeProbe.probe.frameHtmlIncludesBridgeToken, `Iframe document included bridge token: ${JSON.stringify(iframeProbe)}`)
    assert(
      iframeProbe.firstRenderStatus === 200 && iframeProbe.firstRenderContainsBridgeToken,
      `Iframe attempt consumed or blocked the first top-level bridge token render: ${JSON.stringify(iframeProbe)}`
    )
    const cancel = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(cancel.status === 200 || cancel.status === 409, `Cleanup DELETE returned ${cancel.status}: ${JSON.stringify(cancel.body)}`)
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          bridgeIframeBlocked: {
            attackerRequestCount: iframeProbe.attackerRequestCount,
            frameAccess: iframeProbe.probe.frameAccess,
            frameBodyText: redactText(iframeProbe.probe.frameBodyText || ''),
            frameCount: iframeProbe.probe.frameCount,
            frameHtmlIncludedBridgeToken: iframeProbe.probe.frameHtmlIncludesBridgeToken,
            firstRenderStatus: iframeProbe.firstRenderStatus,
            firstRenderContainsBridgeToken: iframeProbe.firstRenderContainsBridgeToken,
            attackerDomIncludedBridgeToken: iframeProbe.probe.outerHtmlIncludesBridgeToken,
            cleanupDeleteStatus: cancel.status
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await harness.stopBridge(bridge)
    await harness.cleanupChrome(chrome)
  }
}

const runWrongProfileExtensionMissingScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const probe = await harness.startProbeServer()
  const chrome = await harness.startChromeWithoutExtension()
  let bridge
  try {
    const version = await harness.waitForCdp()
    bridge = await harness.startBridge({
      noOpen: false,
      env: {
        STACKPRISM_BROWSER_OPEN_COMMAND: process.execPath,
        STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['--input-type=module', '-e', openBridgeWithCdpScript]),
        STACKPRISM_BROWSER_SMOKE_CDP_BASE_URL: cdpBaseUrl
      }
    })
    const capture = await harness.createCapture(bridge.ready, {
      url: probe.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const finalStatus = await harness.pollCapture(bridge.ready, capture.body.id, 40)
    assert(
      finalStatus.status === 'failed' && finalStatus.error?.code === 'EXTENSION_NOT_CONNECTED',
      `Wrong-profile capture did not fail as EXTENSION_NOT_CONNECTED: ${JSON.stringify(finalStatus)}`
    )
    const profile = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(profile.status !== 200, `Wrong-profile capture returned fake profile: ${JSON.stringify(profile.body)}`)
    assert(probe.requestCount() === 0, `Wrong-profile capture fetched target before extension connected: ${probe.requestCount()}`)
    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          wrongProfileExtensionMissing: {
            status: finalStatus.status,
            errorCode: finalStatus.error?.code,
            profileStatus: profile.status,
            targetRequestCount: probe.requestCount()
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await harness.stopBridge(bridge)
    probe.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const runHostValidationScenario = async () => {
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const probe = await harness.startProbeServer()
  let bridge
  try {
    bridge = await harness.startBridge()
    const url = new URL(bridge.ready.baseUrl)
    const host = url.host
    const capture = await harness.createCapture(bridge.ready, {
      url: probe.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const bridgePath = new URL(capture.body.bridgeUrl).pathname + new URL(capture.body.bridgeUrl).search
    const statusPath = `/v1/captures/${capture.body.id}`

    const correctHealth = await harness.rawHttp(url.port, ['GET /health HTTP/1.1', `Host: ${host}`, 'Connection: close', '', ''])
    assertRawHttpStatus(correctHealth, 200, 'Correct /health host')
    assertRawHttpIncludes(correctHealth, /"service":"stackprism-agent-bridge"/, 'Correct /health host')

    const localhostHealth = await harness.rawHttp(url.port, [
      'GET /health HTTP/1.1',
      `Host: localhost:${url.port}`,
      'Connection: close',
      '',
      ''
    ])
    assertRawHttpStatus(localhostHealth, 400, 'localhost /health host')
    assertRawHttpIncludes(localhostHealth, /INVALID_REQUEST/, 'localhost /health host')

    const wrongPortHealth = await harness.rawHttp(url.port, [
      'GET /health HTTP/1.1',
      `Host: 127.0.0.1:${Number(url.port) + 1}`,
      'Connection: close',
      '',
      ''
    ])
    assertRawHttpStatus(wrongPortHealth, 400, 'wrong-port /health host')
    assertRawHttpIncludes(wrongPortHealth, /INVALID_REQUEST/, 'wrong-port /health host')

    const ipv6Health = await harness.rawHttp(url.port, ['GET /health HTTP/1.1', `Host: [::1]:${url.port}`, 'Connection: close', '', ''])
    assertRawHttpStatus(ipv6Health, 400, 'ipv6 /health host')
    assertRawHttpIncludes(ipv6Health, /INVALID_REQUEST/, 'ipv6 /health host')

    const wrongBridgeHost = await harness.rawHttp(url.port, [
      `GET ${bridgePath} HTTP/1.1`,
      `Host: localhost:${url.port}`,
      'Connection: close',
      '',
      ''
    ])
    assertRawHttpStatus(wrongBridgeHost, 400, 'wrong-host /bridge')
    assertRawHttpIncludes(wrongBridgeHost, /INVALID_REQUEST/, 'wrong-host /bridge')
    assert(!wrongBridgeHost.includes('spbt_'), `wrong-host /bridge leaked bridge token: ${redactText(wrongBridgeHost)}`)

    const correctBridgeHost = await harness.rawHttp(url.port, [`GET ${bridgePath} HTTP/1.1`, `Host: ${host}`, 'Connection: close', '', ''])
    assertRawHttpStatus(correctBridgeHost, 200, 'correct-host /bridge')
    assertRawHttpIncludes(correctBridgeHost, /spbt_/, 'correct-host /bridge')

    const wrongBearerHost = await harness.rawHttp(url.port, [
      `GET ${statusPath} HTTP/1.1`,
      `Host: localhost:${url.port}`,
      `Authorization: Bearer ${bridge.ready.apiToken}`,
      'Connection: close',
      '',
      ''
    ])
    assertRawHttpStatus(wrongBearerHost, 400, 'wrong-host bearer endpoint')
    assertRawHttpIncludes(wrongBearerHost, /INVALID_REQUEST/, 'wrong-host bearer endpoint')

    const correctBearerHost = await harness.rawHttp(url.port, [
      `GET ${statusPath} HTTP/1.1`,
      `Host: ${host}`,
      `Authorization: Bearer ${bridge.ready.apiToken}`,
      'Connection: close',
      '',
      ''
    ])
    assertRawHttpStatus(correctBearerHost, 200, 'correct-host bearer endpoint')
    assertRawHttpIncludes(correctBearerHost, /"id":/, 'correct-host bearer endpoint')
    assert(probe.requestCount() === 0, `Host validation scenario unexpectedly fetched target: ${probe.requestCount()}`)

    console.log(
      JSON.stringify(
        {
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          hostValidation: {
            correctHealth: 200,
            localhostHealth: 400,
            wrongPortHealth: 400,
            ipv6Health: 400,
            wrongBridgeHost: 400,
            correctBridgeHost: 200,
            wrongBearerHost: 400,
            correctBearerHost: 200,
            targetRequestCount: probe.requestCount()
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await harness.stopBridge(bridge)
    probe.server.close()
  }
}

const runResponseHeadersCorsScenario = async () => {
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const probe = await harness.startProbeServer()
  let bridge
  let captureId = null
  let cleanupStatus = null
  try {
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: probe.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    captureId = capture.body.id

    const bridgeRender = await fetch(capture.body.bridgeUrl)
    const bridgeHtml = await bridgeRender.text()
    assert(bridgeRender.status === 200, `Bridge render failed: ${bridgeRender.status}`)
    const bridgeConfig = parseBridgeConfig(bridgeHtml)
    assert(bridgeConfig.captureId === capture.body.id, 'Bridge config capture id did not match.')

    const apiAuth = { authorization: `Bearer ${bridge.ready.apiToken}` }
    const bridgeAuth = { authorization: `Bearer ${bridgeConfig.bridgeToken}` }
    const baseCaptureUrl = `${bridge.ready.baseUrl}/v1/captures/${capture.body.id}`

    const statusGetResponse = await fetch(baseCaptureUrl, { headers: apiAuth })
    assertJsonSecurityHeaders(statusGetResponse, 'GET capture status')
    const statusGet = await readJsonEnvelope(statusGetResponse)
    assert(statusGet.status === 200 && statusGet.body.id === capture.body.id, `GET status failed: ${JSON.stringify(statusGet.body)}`)

    const requestResponse = await fetch(`${baseCaptureUrl}/request`, { headers: bridgeAuth })
    assertJsonSecurityHeaders(requestResponse, 'GET capture request')
    const request = await readJsonEnvelope(requestResponse)
    assert(
      request.status === 200 && request.body.captureId === capture.body.id && request.body.sessionId === bridgeConfig.sessionId,
      `GET request failed: ${JSON.stringify(request.body)}`
    )

    const controlResponse = await fetch(`${baseCaptureUrl}/control`, { headers: bridgeAuth })
    assertJsonSecurityHeaders(controlResponse, 'GET capture control')
    const control = await readJsonEnvelope(controlResponse)
    assert(control.status === 200 && control.body.command === 'continue', `GET control failed: ${JSON.stringify(control.body)}`)

    const statusPostResponse = await fetch(`${baseCaptureUrl}/status`, {
      method: 'POST',
      headers: { ...bridgeAuth, 'content-type': 'application/json' },
      body: JSON.stringify({
        captureId: capture.body.id,
        sessionId: bridgeConfig.sessionId,
        nonce: bridgeConfig.nonce,
        protocolVersion: bridgeConfig.protocolVersion,
        status: 'waiting_extension',
        phase: 'bridge_connected',
        sequence: 1
      })
    })
    assertJsonSecurityHeaders(statusPostResponse, 'POST capture status')
    const statusPost = await readJsonEnvelope(statusPostResponse)
    assert(
      statusPost.status === 200 && statusPost.body.status === 'waiting_extension',
      `POST status failed: ${JSON.stringify(statusPost.body)}`
    )

    const profileResponse = await fetch(`${baseCaptureUrl}/profile`, { headers: apiAuth })
    assertJsonSecurityHeaders(profileResponse, 'GET capture profile', { referrerPolicy: true })
    const profile = await readJsonEnvelope(profileResponse)
    assert(profile.status === 409 && profile.body.error?.code === 'INVALID_REQUEST', `GET profile failed: ${JSON.stringify(profile.body)}`)

    const preflightResponse = await fetch(`${bridge.ready.baseUrl}/v1/captures`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type'
      }
    })
    assertJsonSecurityHeaders(preflightResponse, 'OPTIONS captures')
    assertNoCorsAllowHeaders(preflightResponse.headers, 'OPTIONS captures')
    const preflight = await readJsonEnvelope(preflightResponse)
    assert(preflight.status === 405 && preflight.body.error?.code === 'METHOD_NOT_ALLOWED', `OPTIONS failed: ${JSON.stringify(preflight)}`)

    const crossSiteCreateResponse = await fetch(`${bridge.ready.baseUrl}/v1/captures`, {
      method: 'POST',
      headers: { ...apiAuth, 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({
        url: probe.url,
        mode: 'experience',
        waitMs: 0,
        include: ['tech'],
        options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
      })
    })
    assertJsonSecurityHeaders(crossSiteCreateResponse, 'cross-site capture create')
    assertNoCorsAllowHeaders(crossSiteCreateResponse.headers, 'cross-site capture create')
    const crossSiteCreate = await readJsonEnvelope(crossSiteCreateResponse)
    assert(
      crossSiteCreate.status === 403 && crossSiteCreate.body.error?.code === 'ORIGIN_NOT_ALLOWED',
      `Cross-site create was not rejected: ${JSON.stringify(crossSiteCreate.body)}`
    )

    const crossSiteRefererResponse = await fetch(baseCaptureUrl, {
      headers: { ...apiAuth, referer: 'https://attacker.example/page' }
    })
    assertJsonSecurityHeaders(crossSiteRefererResponse, 'cross-site referer status')
    assertNoCorsAllowHeaders(crossSiteRefererResponse.headers, 'cross-site referer status')
    const crossSiteReferer = await readJsonEnvelope(crossSiteRefererResponse)
    assert(
      crossSiteReferer.status === 403 && crossSiteReferer.body.error?.code === 'ORIGIN_NOT_ALLOWED',
      `Cross-site Referer was not rejected: ${JSON.stringify(crossSiteReferer.body)}`
    )

    const crossSiteFetchResponse = await fetch(baseCaptureUrl, {
      headers: { ...apiAuth, 'sec-fetch-site': 'cross-site' }
    })
    assertJsonSecurityHeaders(crossSiteFetchResponse, 'cross-site sec-fetch status')
    assertNoCorsAllowHeaders(crossSiteFetchResponse.headers, 'cross-site sec-fetch status')
    const crossSiteFetch = await readJsonEnvelope(crossSiteFetchResponse)
    assert(
      crossSiteFetch.status === 403 && crossSiteFetch.body.error?.code === 'ORIGIN_NOT_ALLOWED',
      `Cross-site Sec-Fetch-Site was not rejected: ${JSON.stringify(crossSiteFetch.body)}`
    )

    assert(probe.requestCount() === 0, `Headers/CORS scenario unexpectedly fetched target: ${probe.requestCount()}`)
    const cleanup = await harness.fetchJson(baseCaptureUrl, { method: 'DELETE', headers: apiAuth })
    cleanupStatus = cleanup.status
    assert(cleanup.status === 200 || cleanup.status === 409, `Cleanup DELETE returned ${cleanup.status}: ${JSON.stringify(cleanup.body)}`)

    console.log(
      JSON.stringify(
        {
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          responseHeadersCors: {
            statusGet: statusGet.status,
            requestGet: request.status,
            controlGet: control.status,
            statusPost: statusPost.status,
            profileGet: profile.status,
            optionsCaptures: preflight.status,
            crossSiteCreate: crossSiteCreate.status,
            crossSiteReferer: crossSiteReferer.status,
            crossSiteFetchSite: crossSiteFetch.status,
            noCorsAllowHeaders: true,
            targetRequestCount: probe.requestCount(),
            cleanupDeleteStatus: cleanupStatus
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    if (bridge && captureId && cleanupStatus === null) {
      await harness
        .fetchJson(`${bridge.ready.baseUrl}/v1/captures/${captureId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
        })
        .catch(() => {})
    }
    await harness.stopBridge(bridge)
    probe.server.close()
  }
}

const runRequestShellRejectionsScenario = async () => {
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const probe = await harness.startProbeServer()
  let bridge
  try {
    bridge = await harness.startBridge()
    const url = new URL(bridge.ready.baseUrl)
    const host = url.host
    const capture = await harness.createCapture(bridge.ready, {
      url: probe.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Request-shell setup capture failed: ${JSON.stringify(capture)}`)
    const bridgeUrl = new URL(capture.body.bridgeUrl)
    const duplicateSessionBridgePath = `${bridgeUrl.pathname}${bridgeUrl.search}&session=${bridgeUrl.searchParams.get('session')}`

    const cases = [
      {
        name: 'missingHost',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: ['GET /health HTTP/1.1', 'Connection: close', '', '']
      },
      {
        name: 'duplicateHost',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: ['GET /health HTTP/1.1', `Host: ${host}`, `Host: ${host}`, 'Connection: close', '', '']
      },
      {
        name: 'absoluteForm',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: [`GET http://127.0.0.1:${url.port}/health HTTP/1.1`, `Host: ${host}`, 'Connection: close', '', '']
      },
      {
        name: 'authorityForm',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: [`CONNECT 127.0.0.1:${url.port} HTTP/1.1`, `Host: ${host}`, 'Connection: close', '', '']
      },
      {
        name: 'encodedSlashPath',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: ['GET /v1%2fcaptures HTTP/1.1', `Host: ${host}`, 'Connection: close', '', '']
      },
      {
        name: 'encodedBackslashPath',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: ['GET /v1%5ccaptures HTTP/1.1', `Host: ${host}`, 'Connection: close', '', '']
      },
      {
        name: 'dotSegmentPath',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: ['GET /v1/../health HTTP/1.1', `Host: ${host}`, 'Connection: close', '', '']
      },
      {
        name: 'emptySegmentPath',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: ['GET /v1//captures HTTP/1.1', `Host: ${host}`, 'Connection: close', '', '']
      },
      {
        name: 'unexpectedHealthQuery',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: ['GET /health?x=1 HTTP/1.1', `Host: ${host}`, 'Connection: close', '', '']
      },
      {
        name: 'duplicateBridgeQuery',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        mustNotInclude: /spbt_/,
        lines: [`GET ${duplicateSessionBridgePath} HTTP/1.1`, `Host: ${host}`, 'Connection: close', '', '']
      },
      {
        name: 'duplicateAuthorization',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: [
          'GET /health HTTP/1.1',
          `Host: ${host}`,
          'Authorization: Bearer one',
          'Authorization: Bearer two',
          'Connection: close',
          '',
          ''
        ]
      },
      {
        name: 'duplicateContentType',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: [
          'POST /v1/captures HTTP/1.1',
          `Host: ${host}`,
          `Authorization: Bearer ${bridge.ready.apiToken}`,
          'Content-Type: application/json',
          'Content-Type: application/json',
          'Content-Length: 2',
          'Connection: close',
          '',
          '{}'
        ]
      },
      {
        name: 'contentLengthAndTransferEncoding',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: [
          'POST /v1/captures HTTP/1.1',
          `Host: ${host}`,
          `Authorization: Bearer ${bridge.ready.apiToken}`,
          'Content-Type: application/json',
          'Content-Length: 2',
          'Transfer-Encoding: chunked',
          'Connection: close',
          '',
          '{}'
        ]
      },
      {
        name: 'duplicateContentLength',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: [
          'POST /v1/captures HTTP/1.1',
          `Host: ${host}`,
          `Authorization: Bearer ${bridge.ready.apiToken}`,
          'Content-Type: application/json',
          'Content-Length: 2',
          'Content-Length: 2',
          'Connection: close',
          '',
          '{}'
        ]
      },
      {
        name: 'invalidContentLength',
        expectedStatus: 400,
        expectedCode: /INVALID_REQUEST/,
        lines: [
          'POST /v1/captures HTTP/1.1',
          `Host: ${host}`,
          `Authorization: Bearer ${bridge.ready.apiToken}`,
          'Content-Type: application/json',
          'Content-Length: nope',
          'Connection: close',
          '',
          '{}'
        ]
      },
      {
        name: 'chunkedBody',
        expectedStatus: 400,
        expectedCode: /UNSUPPORTED_TRANSFER_ENCODING/,
        lines: [
          'POST /v1/captures HTTP/1.1',
          `Host: ${host}`,
          `Authorization: Bearer ${bridge.ready.apiToken}`,
          'Content-Type: application/json',
          'Transfer-Encoding: chunked',
          'Connection: close',
          '',
          '2',
          '{}',
          '0',
          '',
          ''
        ]
      },
      {
        name: 'unsupportedTransferEncoding',
        expectedStatus: 400,
        expectedCode: /UNSUPPORTED_TRANSFER_ENCODING/,
        lines: [
          'POST /v1/captures HTTP/1.1',
          `Host: ${host}`,
          `Authorization: Bearer ${bridge.ready.apiToken}`,
          'Content-Type: application/json',
          'Transfer-Encoding: gzip',
          'Connection: close',
          '',
          ''
        ]
      },
      {
        name: 'unsupportedContentEncoding',
        expectedStatus: 415,
        expectedCode: /UNSUPPORTED_MEDIA_TYPE/,
        lines: [
          'POST /v1/captures HTTP/1.1',
          `Host: ${host}`,
          `Authorization: Bearer ${bridge.ready.apiToken}`,
          'Content-Type: application/json',
          'Content-Encoding: gzip',
          'Content-Length: 2',
          'Connection: close',
          '',
          '{}'
        ]
      },
      {
        name: 'unsupportedCharset',
        expectedStatus: 415,
        expectedCode: /UNSUPPORTED_MEDIA_TYPE/,
        lines: [
          'POST /v1/captures HTTP/1.1',
          `Host: ${host}`,
          `Authorization: Bearer ${bridge.ready.apiToken}`,
          'Content-Type: application/json; charset=latin1',
          'Content-Length: 2',
          'Connection: close',
          '',
          '{}'
        ]
      }
    ]
    const results = {}
    for (const item of cases) {
      const raw = await harness.rawHttp(url.port, item.lines)
      assertRawHttpStatus(raw, item.expectedStatus, item.name)
      assertRawHttpIncludes(raw, item.expectedCode, item.name)
      if (item.mustNotInclude) assert(!item.mustNotInclude.test(raw), `${item.name} leaked forbidden content: ${redactText(raw)}`)
      results[item.name] = rawStatusLine(raw)
    }
    const health = await rawHttpWithTimeout(url.port, ['GET /health HTTP/1.1', `Host: ${host}`, 'Connection: close', '', ''], 1000)
    assertRawHttpStatus(health.data, 200, 'request-shell health recovery')
    assertRawHttpIncludes(health.data, /"activeCaptures":1/, 'request-shell health recovery')
    assert(probe.requestCount() === 0, `Request-shell rejection scenario unexpectedly fetched target: ${probe.requestCount()}`)
    const cleanup = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${capture.body.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(cleanup.status === 200 || cleanup.status === 409, `Cleanup DELETE returned ${cleanup.status}: ${JSON.stringify(cleanup.body)}`)

    console.log(
      JSON.stringify(
        {
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          requestShellRejections: {
            rejectedCases: Object.keys(results).length,
            results,
            targetRequestCount: probe.requestCount(),
            healthAfterRejections: rawStatusLine(health.data),
            cleanupDeleteStatus: cleanup.status
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await harness.stopBridge(bridge)
    probe.server.close()
  }
}

const runConnectionPressureScenario = async () => {
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const holders = []
  let bridge
  try {
    bridge = await harness.startBridge()
    const url = new URL(bridge.ready.baseUrl)
    for (let index = 0; index < 20; index += 1) {
      holders.push(await openHoldingHttpSocket(url.port, url.host))
    }

    const blocked = await rawHttpWithTimeout(url.port, ['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert(
      !blocked.data.startsWith('HTTP/1.1 200 '),
      `Connection pressure request unexpectedly reached /health: ${redactText(blocked.data)}`
    )

    const released = holders.shift()
    released?.destroy()
    await new Promise(resolveWait => setTimeout(resolveWait, 150))

    const recovered = await rawHttpWithTimeout(url.port, ['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''], 1000)
    assertRawHttpStatus(recovered.data, 200, 'Recovered /health after releasing one held connection')
    assertRawHttpIncludes(recovered.data, /"service":"stackprism-agent-bridge"/, 'Recovered /health after releasing one held connection')

    console.log(
      JSON.stringify(
        {
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          connectionPressure: {
            heldConnections: 20,
            blockedReason: blocked.reason,
            blockedDataLength: blocked.data.length,
            releasedBeforeRecovery: 1,
            recoveredStatusLine: recovered.data.split('\r\n')[0]
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    for (const socket of holders) socket.destroy()
    await harness.stopBridge(bridge)
  }
}

const runResourceTimeoutsScenario = async () => {
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  let bridge
  try {
    bridge = await harness.startBridge()
    const url = new URL(bridge.ready.baseUrl)
    const slowHeaders = await rawHttpPartialWithDeadline(url.port, ['GET /health HTTP/1.1\r\n', `Host: ${url.host}`], {
      deadlineMs: 7000,
      chunkDelayMs: 6000
    })
    assert(
      slowHeaders.reason !== 'deadline' && !slowHeaders.data.includes('"ok":true'),
      `Slow headers reached business routing or stayed open: ${JSON.stringify(slowHeaders)}`
    )
    assertRawHttpStatus(slowHeaders.data, 408, 'Slow headers timeout')

    const afterSlowHeaders = await rawHttpWithTimeout(
      url.port,
      ['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''],
      1000
    )
    assertRawHttpStatus(afterSlowHeaders.data, 200, 'Recovered /health after slow headers')

    const slowBody = await rawHttpPartialWithDeadline(
      url.port,
      [
        [
          'POST /v1/captures HTTP/1.1',
          `Host: ${url.host}`,
          `Authorization: Bearer ${bridge.ready.apiToken}`,
          'Content-Type: application/json',
          'Content-Length: 64',
          'Connection: close',
          '',
          '{"url"'
        ].join('\r\n')
      ],
      { deadlineMs: 12000 }
    )
    assert(
      slowBody.reason !== 'deadline' && !slowBody.data.includes('"id":"cap_'),
      `Slow body created a capture or stayed open: ${JSON.stringify(slowBody)}`
    )
    assert(/HTTP\/1\.1 (400|408)/.test(slowBody.data), `Slow body returned unexpected status: ${redactText(slowBody.data)}`)

    const afterSlowBody = await rawHttpWithTimeout(
      url.port,
      ['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''],
      1000
    )
    assertRawHttpStatus(afterSlowBody.data, 200, 'Recovered /health after slow body')
    assertRawHttpIncludes(afterSlowBody.data, /"activeCaptures":0/, 'Recovered /health after slow body')

    const keepAlive = await probeKeepAliveIdleClose(url.port, url.host)
    assertRawHttpStatus(keepAlive.firstResponse, 200, 'Keep-alive first /health response')
    assert(
      keepAlive.reason === 'closed',
      `Keep-alive socket stayed open beyond idle timeout: ${JSON.stringify({ reason: keepAlive.reason, closed: keepAlive.closed })}`
    )

    const afterKeepAliveIdle = await rawHttpWithTimeout(
      url.port,
      ['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''],
      1000
    )
    assertRawHttpStatus(afterKeepAliveIdle.data, 200, 'Recovered /health after keep-alive idle close')

    console.log(
      JSON.stringify(
        {
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          resourceTimeouts: {
            slowHeaders: {
              reason: slowHeaders.reason,
              elapsedMs: slowHeaders.elapsedMs,
              statusLine: slowHeaders.data.split('\r\n')[0]
            },
            afterSlowHeadersStatusLine: afterSlowHeaders.data.split('\r\n')[0],
            slowBody: {
              reason: slowBody.reason,
              elapsedMs: slowBody.elapsedMs,
              statusLine: slowBody.data.split('\r\n')[0]
            },
            afterSlowBodyStatusLine: afterSlowBody.data.split('\r\n')[0],
            keepAlive: {
              reason: keepAlive.reason,
              firstStatusLine: keepAlive.firstResponse.split('\r\n')[0]
            },
            afterKeepAliveIdleStatusLine: afterKeepAliveIdle.data.split('\r\n')[0],
            activeCapturesAfterSlowBody: 0
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await harness.stopBridge(bridge)
  }
}

const runRateLimitScenario = async () => {
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const probe = await harness.startProbeServer()
  let bridge
  let captureId = null
  let cleanupStatus = null
  try {
    bridge = await harness.startBridge()
    const request = {
      url: probe.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    }
    const first = await harness.createCapture(bridge.ready, request)
    assert(first.status === 200, `Initial capture creation failed: ${JSON.stringify(first)}`)
    captureId = first.body.id

    let createLimited = null
    let busyBeforeLimit = 0
    for (let attempt = 2; attempt <= 11; attempt += 1) {
      const response = await harness.createCapture(bridge.ready, request)
      if (attempt < 11) {
        assert(response.status === 429, `Create attempt ${attempt} did not fail closed: ${JSON.stringify(response)}`)
        assert(response.body.error?.code === 'CAPTURE_BUSY', `Create attempt ${attempt} was not CAPTURE_BUSY: ${JSON.stringify(response)}`)
        busyBeforeLimit += 1
      } else {
        createLimited = response
      }
    }
    assert(createLimited?.status === 429, `Create attempt 11 was not rate limited: ${JSON.stringify(createLimited)}`)
    assert(createLimited.body.error?.code === 'RATE_LIMITED', `Create attempt 11 returned wrong code: ${JSON.stringify(createLimited)}`)

    let successfulReads = 0
    let queryLimited = null
    const statusUrl = `${bridge.ready.baseUrl}/v1/captures/${captureId}`
    const apiAuth = { authorization: `Bearer ${bridge.ready.apiToken}` }
    for (let attempt = 1; attempt <= 121; attempt += 1) {
      const response = await harness.fetchJson(statusUrl, { headers: apiAuth })
      if (attempt <= 120) {
        assert(response.status === 200, `Status read ${attempt} failed before limit: ${JSON.stringify(response)}`)
        successfulReads += 1
      } else {
        queryLimited = response
      }
    }
    assert(queryLimited?.status === 429, `Status read 121 was not rate limited: ${JSON.stringify(queryLimited)}`)
    assert(queryLimited.body.error?.code === 'RATE_LIMITED', `Status read 121 returned wrong code: ${JSON.stringify(queryLimited)}`)
    assert(probe.requestCount() === 0, `Rate-limit scenario unexpectedly fetched target: ${probe.requestCount()}`)

    const cleanup = await harness.fetchJson(statusUrl, { method: 'DELETE', headers: apiAuth })
    cleanupStatus = cleanup.status
    assert(cleanup.status === 200 || cleanup.status === 409, `Cleanup DELETE returned ${cleanup.status}: ${JSON.stringify(cleanup.body)}`)

    console.log(
      JSON.stringify(
        {
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          rateLimit: {
            createRateLimit: {
              attemptsBeforeLimited: 10,
              busyBeforeLimit,
              limitedStatus: createLimited.status,
              limitedCode: createLimited.body.error.code
            },
            queryRateLimit: {
              successfulReads,
              limitedStatus: queryLimited.status,
              limitedCode: queryLimited.body.error.code
            },
            targetRequestCount: probe.requestCount(),
            cleanupDeleteStatus: cleanup.status
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    if (bridge && captureId && cleanupStatus === null) {
      await harness
        .fetchJson(`${bridge.ready.baseUrl}/v1/captures/${captureId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
        })
        .catch(() => {})
    }
    await harness.stopBridge(bridge)
    probe.server.close()
  }
}

const runProfileRateLimitScenario = async () => {
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const probe = await harness.startProbeServer()
  let bridge
  let captureId = null
  let cleanupStatus = null
  try {
    bridge = await harness.startBridge()
    const capture = await harness.createCapture(bridge.ready, {
      url: probe.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(capture.status === 200, `Profile rate-limit setup capture failed: ${JSON.stringify(capture)}`)
    captureId = capture.body.id

    let profileNotReadyReads = 0
    let profileLimited = null
    const profileUrl = `${bridge.ready.baseUrl}/v1/captures/${captureId}/profile`
    const apiAuth = { authorization: `Bearer ${bridge.ready.apiToken}` }
    for (let attempt = 1; attempt <= 121; attempt += 1) {
      const response = await harness.fetchJson(profileUrl, { headers: apiAuth })
      if (attempt <= 120) {
        assert(response.status === 409, `Profile read ${attempt} did not reach profile endpoint before limit: ${JSON.stringify(response)}`)
        assert(response.body.error?.code === 'INVALID_REQUEST', `Profile read ${attempt} returned wrong code: ${JSON.stringify(response)}`)
        profileNotReadyReads += 1
      } else {
        profileLimited = response
      }
    }
    assert(profileLimited?.status === 429, `Profile read 121 was not rate limited: ${JSON.stringify(profileLimited)}`)
    assert(profileLimited.body.error?.code === 'RATE_LIMITED', `Profile read 121 returned wrong code: ${JSON.stringify(profileLimited)}`)
    assert(probe.requestCount() === 0, `Profile rate-limit scenario unexpectedly fetched target: ${probe.requestCount()}`)

    const cleanup = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${captureId}`, { method: 'DELETE', headers: apiAuth })
    cleanupStatus = cleanup.status
    assert(cleanup.status === 200 || cleanup.status === 409, `Cleanup DELETE returned ${cleanup.status}: ${JSON.stringify(cleanup.body)}`)

    console.log(
      JSON.stringify(
        {
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          profileRateLimit: {
            profileNotReadyReads,
            limitedStatus: profileLimited.status,
            limitedCode: profileLimited.body.error.code,
            targetRequestCount: probe.requestCount(),
            cleanupDeleteStatus: cleanup.status
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    if (bridge && captureId && cleanupStatus === null) {
      await harness
        .fetchJson(`${bridge.ready.baseUrl}/v1/captures/${captureId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
        })
        .catch(() => {})
    }
    await harness.stopBridge(bridge)
    probe.server.close()
  }
}

const runTargetUrlValidationScenario = async () => {
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const probe = await harness.startProbeServer()
  let bridge
  try {
    bridge = await harness.startBridge()
    const cases = [
      {
        name: 'unsupportedProtocol',
        expectedCode: 'INVALID_REQUEST',
        request: {
          url: 'ftp://example.com/download',
          options: { allowPrivateNetworkTarget: false, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
        }
      },
      {
        name: 'credentialUrl',
        expectedCode: 'INVALID_REQUEST',
        mustNotInclude: /user:pass/,
        request: {
          url: 'https://user:pass@example.com/dashboard',
          options: { allowPrivateNetworkTarget: false, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
        }
      },
      {
        name: 'loopbackPrivateTarget',
        expectedCode: 'PRIVATE_NETWORK_TARGET_BLOCKED',
        request: {
          url: probe.url,
          options: { allowPrivateNetworkTarget: false, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
        }
      },
      {
        name: 'bridgeSelfTarget',
        expectedCode: 'BRIDGE_SELF_TARGET_BLOCKED',
        request: {
          url: bridge.ready.baseUrl,
          options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
        }
      }
    ]
    const results = {}
    for (const item of cases) {
      const response = await harness.createCapture(bridge.ready, item.request)
      assert(response.status === 400, `${item.name} returned ${response.status}: ${JSON.stringify(response.body)}`)
      assert(response.body.error?.code === item.expectedCode, `${item.name} returned wrong code: ${JSON.stringify(response.body)}`)
      const serialized = JSON.stringify(response.body)
      if (item.mustNotInclude) assert(!item.mustNotInclude.test(serialized), `${item.name} leaked rejected target: ${serialized}`)
      results[item.name] = response.body.error.code
    }

    const health = await harness.fetchJson(bridge.ready.healthUrl)
    assert(health.status === 200, `Health after target URL validation returned ${health.status}: ${JSON.stringify(health.body)}`)
    assert(health.body.activeCaptures === 0, `Target URL validation created captures: ${JSON.stringify(health.body)}`)
    assert(probe.requestCount() === 0, `Target URL validation unexpectedly fetched target: ${probe.requestCount()}`)

    console.log(
      JSON.stringify(
        {
          scenario,
          bridge: {
            baseUrl: bridge.ready.baseUrl,
            protocolVersion: bridge.ready.protocolVersion,
            apiTokenPresent: Boolean(bridge.ready.apiToken)
          },
          targetUrlValidation: {
            results,
            activeCapturesAfterRejections: health.body.activeCaptures,
            targetRequestCount: probe.requestCount()
          },
          bridgeStderrTail: redactText(bridge.stderr().slice(-500))
        },
        null,
        2
      )
    )
  } finally {
    await harness.stopBridge(bridge)
    probe.server.close()
  }
}

const runResultExpiryBridgePageScenario = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const fixture = await harness.startFixtureServer()
  const chrome = await harness.startChrome()
  let worker
  let bridge
  let now = Date.now()
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    await harness.setAgentBridgeEnabled(worker, true)

    bridge = createBridgeServer({
      env: { ...process.env, STACKPRISM_BRIDGE_NO_OPEN: '1' },
      now: () => now
    })
    const ready = await bridge.listen()
    const capture = await harness.createCapture(ready, {
      url: fixture.url,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, maxResourceUrls: 50, captureScreenshotMetadata: false }
    })
    assert(capture.status === 200, `Capture creation failed: ${JSON.stringify(capture)}`)
    const driven = await harness.driveCapture(ready, capture)
    assert(driven.finalStatus?.status === 'completed', `Capture did not complete: ${JSON.stringify(driven.finalStatus)}`)
    assert(driven.profile?.status === 200, `Profile endpoint did not return completed profile: ${JSON.stringify(driven.profile)}`)

    const stored = ready.store.get(capture.body.id)
    assert(stored?.resultExpiresAt, `Completed capture did not record result expiry: ${JSON.stringify(stored)}`)
    now = stored.resultExpiresAt + 1

    const expiredProfile = await harness.fetchJson(`${ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
      headers: { authorization: `Bearer ${ready.apiToken}` }
    })
    assert(expiredProfile.status === 410, `Expired profile returned ${expiredProfile.status}: ${JSON.stringify(expiredProfile.body)}`)
    assert(
      expiredProfile.body?.error?.code === 'CAPTURE_RESULT_EXPIRED',
      `Expired profile returned wrong code: ${JSON.stringify(expiredProfile.body)}`
    )

    const expiredBridgePage = await fetch(capture.body.bridgeUrl)
    const expiredBridgeHtml = await expiredBridgePage.text()
    assert(expiredBridgePage.status === 410, `Expired bridge page returned ${expiredBridgePage.status}.`)
    assert(expiredBridgeHtml.includes('CAPTURE_RESULT_EXPIRED'), 'Expired bridge page did not report CAPTURE_RESULT_EXPIRED.')
    assert(!expiredBridgeHtml.includes('spbt_'), 'Expired bridge page rendered bridge token material.')

    console.log(
      JSON.stringify(
        {
          browser: version.Browser,
          dist,
          scenario,
          bridge: {
            baseUrl: ready.baseUrl,
            protocolVersion,
            apiTokenPresent: Boolean(ready.apiToken)
          },
          resultExpiry: {
            completedStatus: driven.finalStatus.status,
            completedProfileStatus: driven.profile.status,
            expiredProfileStatus: expiredProfile.status,
            expiredProfileCode: expiredProfile.body?.error?.code,
            expiredBridgePageStatus: expiredBridgePage.status,
            expiredBridgePageHasToken: expiredBridgeHtml.includes('spbt_')
          }
        },
        null,
        2
      )
    )
  } finally {
    worker?.close()
    if (bridge) await bridge.close().catch(() => {})
    fixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const run = async () => {
  ensureDistBuilt()
  const harness = createBrowserSmokeHarness({ root, dist, cdpPort })
  const fixture = await harness.startFixtureServer()
  const disabledProbe = await harness.startProbeServer()
  const largeFixture = await harness.startLargeProfileFixtureServer()
  const slowFixture = await harness.startSlowFixtureServer()
  const chrome = await harness.startChrome()
  let bridge
  let openCommandBridge
  let renderGuardBridge
  let worker
  try {
    const version = await harness.waitForCdp()
    const workerTarget = await harness.waitForWorker()
    worker = await harness.connectTarget(workerTarget)
    await worker.send('Runtime.enable')
    await harness.waitForExtensionRuntime(worker)
    const manifestResult = await worker.send('Runtime.evaluate', {
      expression: 'JSON.stringify(chrome.runtime.getManifest())',
      returnByValue: true
    })
    const manifestJson = manifestResult.result?.value
    assert(typeof manifestJson === 'string', `Manifest evaluation did not return JSON: ${JSON.stringify(manifestResult)}`)
    const manifest = JSON.parse(manifestJson)
    bridge = await harness.startBridge()

    await worker.send('Runtime.evaluate', {
      expression:
        'Promise.all([chrome.storage.sync.set({stackPrismSettings:{agentBridgeEnabled:true}}), chrome.storage.local.set({stackPrismSettings:{agentBridgeEnabled:false}})])',
      awaitPromise: true
    })
    const disabled = await harness.createCapture(bridge.ready, {
      url: disabledProbe.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false }
    })
    assert(disabled.status === 200, 'Disabled capture creation failed.')
    const disabledDriven = await harness.driveCapture(bridge.ready, disabled)
    assert(disabledDriven.finalStatus?.error?.code === 'AGENT_BRIDGE_DISABLED', 'Disabled opt-in did not fail closed.')
    assert(disabledProbe.requestCount() === 0, 'Disabled opt-in opened or fetched the target URL.')

    await harness.setAgentBridgeEnabled(worker, true)
    const defaultTargetUrl = fixture.url
    const fixtureCapture = await harness.createCapture(bridge.ready, {
      url: defaultTargetUrl,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, maxResourceUrls: 50, captureScreenshotMetadata: false }
    })
    assert(fixtureCapture.status === 200, 'Fixture capture creation failed.')
    const fixtureDriven = await harness.driveCapture(bridge.ready, fixtureCapture)
    assert(
      fixtureDriven.finalStatus?.status === 'completed',
      `Fixture capture did not complete: ${JSON.stringify(fixtureDriven.finalStatus)}`
    )
    const deleteCompleted = await harness.fetchJson(`${bridge.ready.baseUrl}/v1/captures/${fixtureCapture.body.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bridge.ready.apiToken}` }
    })
    assert(deleteCompleted.status === 409, 'Deleting completed capture did not return 409.')

    const fixtureMetadataCapture = await harness.createCapture(bridge.ready, {
      url: fixture.url,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, maxResourceUrls: 50, captureScreenshotMetadata: true }
    })
    assert(fixtureMetadataCapture.status === 200, 'Fixture metadata capture creation failed.')
    const fixtureMetadataDriven = await harness.driveCapture(bridge.ready, fixtureMetadataCapture)
    assert(
      fixtureMetadataDriven.finalStatus?.status === 'completed',
      `Fixture metadata capture did not complete: ${JSON.stringify(fixtureMetadataDriven.finalStatus)}`
    )

    const largeProfileCapture = await harness.createCapture(bridge.ready, {
      url: largeFixture.url,
      include: ['assets'],
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, maxResourceUrls: 1000, captureScreenshotMetadata: false }
    })
    assert(largeProfileCapture.status === 200, 'Large profile capture creation failed.')
    const largeProfileDriven = await harness.driveCapture(bridge.ready, largeProfileCapture)
    assert(
      largeProfileDriven.finalStatus?.status === 'completed',
      `Large profile capture did not complete: ${JSON.stringify(largeProfileDriven.finalStatus)}`
    )

    openCommandBridge = await harness.startBridge({
      noOpen: false,
      env: {
        STACKPRISM_BROWSER_OPEN_COMMAND: process.execPath,
        STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['--input-type=module', '-e', openBridgeWithCdpScript]),
        STACKPRISM_BROWSER_SMOKE_CDP_BASE_URL: cdpBaseUrl
      }
    })
    const openCommandCapture = await harness.createCapture(openCommandBridge.ready, {
      url: fixture.url,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, maxResourceUrls: 50, captureScreenshotMetadata: false }
    })
    assert(openCommandCapture.status === 200, 'Custom open command capture creation failed.')
    const openCommandStatus = await harness.pollCapture(openCommandBridge.ready, openCommandCapture.body.id)
    const openCommandProfile =
      openCommandStatus.status === 'completed'
        ? await harness.fetchJson(`${openCommandBridge.ready.baseUrl}/v1/captures/${openCommandCapture.body.id}/profile`, {
            headers: { authorization: `Bearer ${openCommandBridge.ready.apiToken}` }
          })
        : null
    assert(openCommandStatus.status === 'completed', `Custom open command capture did not complete: ${JSON.stringify(openCommandStatus)}`)

    const targetCloseCapture = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(targetCloseCapture.status === 200, 'Target-close capture creation failed.')
    const targetClosed = await harness.driveCaptureWithClosedTarget(bridge.ready, worker, targetCloseCapture)
    assert(
      targetClosed.finalStatus?.status === 'failed' && targetClosed.finalStatus?.error?.code === 'TARGET_TAB_CLOSED',
      `Target-close capture did not fail as TARGET_TAB_CLOSED: ${JSON.stringify(targetClosed.finalStatus)}`
    )

    const bridgeCloseCapture = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(bridgeCloseCapture.status === 200, 'Bridge-close capture creation failed.')
    const bridgeClosed = await harness.driveCaptureWithClosedBridge(bridge.ready, worker, bridgeCloseCapture)
    assert(
      bridgeClosed.finalStatus?.status === 'failed' && bridgeClosed.finalStatus?.error?.code === 'BRIDGE_TAB_CLOSED',
      `Bridge-close capture did not fail as BRIDGE_TAB_CLOSED: ${JSON.stringify(bridgeClosed.finalStatus)}`
    )

    const cancelCapture = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(cancelCapture.status === 200, 'Cancel capture creation failed.')
    const cancelled = await harness.driveCaptureWithCancel(bridge.ready, worker, cancelCapture)
    assert(cancelled.cancelStatus === 200, `DELETE running capture returned ${cancelled.cancelStatus}.`)
    assert(
      cancelled.finalStatus?.status === 'cancelled' && !cancelled.targetStillExists,
      `Cancel capture did not close owned target tab: ${JSON.stringify(cancelled)}`
    )

    worker.close()
    worker = null

    const serviceWorkerStopCapture = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(serviceWorkerStopCapture.status === 200, 'Service worker stop capture creation failed.')
    const serviceWorkerStopped = await harness.driveCaptureWithServiceWorkerTargetClose(
      bridge.ready,
      serviceWorkerStopCapture,
      slowFixture.url
    )
    assert(
      serviceWorkerStopped.finalStatus?.status === 'failed' &&
        ['BRIDGE_TRANSPORT_DISCONNECTED', 'SERVICE_WORKER_RESTARTED'].includes(serviceWorkerStopped.finalStatus.error?.code) &&
        !serviceWorkerStopped.targetStillVisible,
      `Service worker target close did not fail closed and clean up target: ${JSON.stringify(serviceWorkerStopped)}`
    )

    const reloadCapture = await harness.createCapture(bridge.ready, {
      url: slowFixture.url,
      options: { allowPrivateNetworkTarget: true, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    assert(reloadCapture.status === 200, 'Extension reload capture creation failed.')
    const extensionReloaded = await harness.driveCaptureWithExtensionReload(bridge.ready, reloadCapture, slowFixture.url)
    assert(
      extensionReloaded.finalStatus?.status === 'failed' &&
        ['BRIDGE_TRANSPORT_DISCONNECTED', 'SERVICE_WORKER_RESTARTED'].includes(extensionReloaded.finalStatus.error?.code) &&
        !extensionReloaded.targetStillVisible,
      `Extension reload did not fail closed and clean up target: ${JSON.stringify(extensionReloaded)}`
    )

    renderGuardBridge = await harness.startBridge()
    const securityBridge = renderGuardBridge.ready
    const terminalRenderCapture = await harness.createCapture(securityBridge, {
      url: defaultTargetUrl,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, maxResourceUrls: 50, captureScreenshotMetadata: false }
    })
    assert(terminalRenderCapture.status === 200, 'Terminal render guard capture creation failed.')
    const terminalDelete = await harness.fetchJson(`${securityBridge.baseUrl}/v1/captures/${terminalRenderCapture.body.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${securityBridge.apiToken}` }
    })
    assert(terminalDelete.status === 200, `DELETE terminal render guard capture returned ${terminalDelete.status}.`)
    const terminalBeforeRender = await harness.pollCapture(securityBridge, terminalRenderCapture.body.id, 20)
    assert(
      terminalBeforeRender.status === 'cancelled',
      `Terminal render guard did not become cancelled: ${JSON.stringify(terminalBeforeRender)}`
    )
    const terminalRender = await fetch(terminalRenderCapture.body.bridgeUrl)
    const terminalRenderText = await terminalRender.text()
    assert(terminalRender.status === 409 && !terminalRenderText.includes('spbt_'), 'Terminal bridge render exposed a token.')

    const renderCapture = await harness.createCapture(securityBridge, {
      url: defaultTargetUrl,
      waitMs: 100,
      options: { allowPrivateNetworkTarget: true, maxResourceUrls: 50, captureScreenshotMetadata: false }
    })
    assert(renderCapture.status === 200, 'Render guard capture creation failed.')
    const crossSite = await fetch(renderCapture.body.bridgeUrl, { headers: { referer: 'https://attacker.example/page' } })
    const crossSiteText = await crossSite.text()
    assert(crossSite.status === 403 && !crossSiteText.includes('spbt_'), 'Cross-site bridge render was not rejected safely.')
    const firstRender = await fetch(renderCapture.body.bridgeUrl)
    const firstRenderText = await firstRender.text()
    const secondRender = await fetch(renderCapture.body.bridgeUrl)
    const secondRenderText = await secondRender.text()
    assert(firstRender.status === 200 && firstRenderText.includes('spbt_'), 'First bridge render did not include bridge token.')
    assert(secondRender.status === 409 && !secondRenderText.includes('spbt_'), 'Second bridge render did not reject without token.')

    const summary = {
      browser: version.Browser,
      extensionName: manifest.name,
      extensionVersion: manifest.version,
      dist,
      bridge: {
        baseUrl: bridge.ready.baseUrl,
        protocolVersion: bridge.ready.protocolVersion,
        apiTokenPresent: Boolean(bridge.ready.apiToken)
      },
      disabled: {
        status: disabledDriven.finalStatus.status,
        errorCode: disabledDriven.finalStatus.error?.code,
        targetFinalUrl: disabledDriven.finalStatus.finalUrl || '',
        targetRequestCount: disabledProbe.requestCount(),
        syncLegacyEnabledIgnored: true
      },
      defaultTarget: {
        url: defaultTargetUrl,
        status: fixtureDriven.finalStatus.status,
        phase: fixtureDriven.finalStatus.phase,
        deleteCompletedStatus: deleteCompleted.status,
        profile: profileSummary(fixtureDriven.profile, fixtureCapture.body.id)
      },
      fixture: {
        status: fixtureDriven.finalStatus.status,
        phase: fixtureDriven.finalStatus.phase,
        profile: profileSummary(fixtureDriven.profile, fixtureCapture.body.id)
      },
      fixtureMetadata: {
        status: fixtureMetadataDriven.finalStatus.status,
        phase: fixtureMetadataDriven.finalStatus.phase,
        profile: profileSummary(fixtureMetadataDriven.profile, fixtureMetadataCapture.body.id)
      },
      largeProfile: {
        status: largeProfileDriven.finalStatus.status,
        phase: largeProfileDriven.finalStatus.phase,
        profile: profileSummary(largeProfileDriven.profile, largeProfileCapture.body.id)
      },
      customOpenCommand: {
        status: openCommandStatus.status,
        phase: openCommandStatus.phase,
        bridge: {
          baseUrl: openCommandBridge.ready.baseUrl,
          protocolVersion: openCommandBridge.ready.protocolVersion,
          apiTokenPresent: Boolean(openCommandBridge.ready.apiToken)
        },
        profile: profileSummary(openCommandProfile, openCommandCapture.body.id)
      },
      bridgeSecurity: {
        crossSiteStatus: crossSite.status,
        firstRenderStatus: firstRender.status,
        secondRenderStatus: secondRender.status,
        terminalRenderStatus: terminalRender.status,
        terminalRenderFinalStatus: terminalBeforeRender.status
      },
      lifecycle: {
        targetTabClosed: {
          status: targetClosed.finalStatus.status,
          errorCode: targetClosed.finalStatus.error?.code,
          closedTabId: targetClosed.closedTabId
        },
        bridgeTabClosed: {
          status: bridgeClosed.finalStatus.status,
          errorCode: bridgeClosed.finalStatus.error?.code,
          closedTabId: bridgeClosed.closedTabId
        },
        cancelled: {
          deleteStatus: cancelled.cancelStatus,
          status: cancelled.finalStatus.status,
          closedTabId: cancelled.closedTabId,
          targetStillExists: cancelled.targetStillExists
        },
        extensionReloaded: {
          status: extensionReloaded.finalStatus.status,
          errorCode: extensionReloaded.finalStatus.error?.code,
          targetTabId: extensionReloaded.targetTabId,
          targetStillVisible: extensionReloaded.targetStillVisible
        },
        serviceWorkerStopped: {
          status: serviceWorkerStopped.finalStatus.status,
          errorCode: serviceWorkerStopped.finalStatus.error?.code,
          targetTabId: serviceWorkerStopped.targetTabId,
          workerTargetId: serviceWorkerStopped.workerTargetId,
          targetStillVisible: serviceWorkerStopped.targetStillVisible
        }
      },
      bridgeDom: fixtureDriven.dom,
      bridgeStderrTail: redactText(bridge.stderr().slice(-500))
    }
    assert(summary.defaultTarget.profile?.schema === 'stackprism.site_experience_profile.v1', 'Default target profile schema mismatch.')
    assert(summary.fixture.profile?.schema === 'stackprism.site_experience_profile.v1', 'Fixture profile schema mismatch.')
    assert(summary.fixtureMetadata.profile?.schema === 'stackprism.site_experience_profile.v1', 'Fixture metadata profile schema mismatch.')
    assert(summary.largeProfile.profile?.schema === 'stackprism.site_experience_profile.v1', 'Large profile schema mismatch.')
    assert(
      summary.customOpenCommand.profile?.schema === 'stackprism.site_experience_profile.v1',
      'Custom open command profile schema mismatch.'
    )
    assert(
      !summary.defaultTarget.profile.privacyLeakDetected &&
        !summary.fixture.profile.privacyLeakDetected &&
        !summary.fixtureMetadata.profile.privacyLeakDetected &&
        !summary.largeProfile.profile.privacyLeakDetected &&
        !summary.customOpenCommand.profile.privacyLeakDetected,
      'Profile privacy leak marker detected.'
    )
    assert(
      !summary.defaultTarget.profile.screenshotMetadataPresent && !summary.fixture.profile.screenshotMetadataPresent,
      'Screenshot metadata was present even though captureScreenshotMetadata=false.'
    )
    assert(summary.fixtureMetadata.profile.screenshotMetadataPresent, 'Screenshot metadata was missing when requested.')
    assert(
      !summary.defaultTarget.profile.screenshotPayloadPresent &&
        !summary.fixture.profile.screenshotPayloadPresent &&
        !summary.fixtureMetadata.profile.screenshotPayloadPresent &&
        !summary.largeProfile.profile.screenshotPayloadPresent &&
        !summary.customOpenCommand.profile.screenshotPayloadPresent,
      'Screenshot image or pixel payload was present.'
    )
    assert(summary.largeProfile.profile.estimatedTransferChunks > 1, 'Large profile did not exceed one transfer chunk.')
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    worker?.close()
    await harness.stopBridge(bridge)
    await harness.stopBridge(openCommandBridge)
    await harness.stopBridge(renderGuardBridge)
    fixture.server.close()
    disabledProbe.server.close()
    largeFixture.server.close()
    slowFixture.server.close()
    await harness.cleanupChrome(chrome)
  }
}

const scenarioRunner =
  scenario === 'cleared-storage-session'
    ? runClearedStorageSessionScenario
    : scenario === 'local-opt-in-disabled'
      ? runLocalOptInDisabledScenario
      : scenario === 'browser-extension-disabled'
        ? runBrowserExtensionDisabledScenario
        : scenario === 'browser-extension-reloaded'
          ? runBrowserExtensionReloadedScenario
          : scenario === 'incognito-bridge-probe'
            ? runIncognitoBridgeProbeScenario
            : scenario === 'incognito-window-bridge-probe'
              ? runIncognitoWindowBridgeProbeScenario
              : scenario === 'expired-deadline-reconciliation'
                ? runExpiredDeadlineReconciliationScenario
                : scenario === 'final-url-blocked'
                  ? runFinalUrlBlockedScenario
                  : scenario === 'final-private-url-blocked'
                    ? runFinalPrivateUrlBlockedScenario
                    : scenario === 'final-dns-policy-blocked'
                      ? runFinalDnsPolicyBlockedScenario
                      : scenario === 'final-dns-lookup-failed'
                        ? runFinalDnsLookupFailedScenario
                        : scenario === 'private-target-blocked'
                          ? runPrivateTargetBlockedScenario
                          : scenario === 'dns-non-global-blocked'
                            ? runDnsNonGlobalBlockedScenario
                            : scenario === 'dns-lookup-failed'
                              ? runDnsLookupFailedScenario
                              : scenario === 'bridge-self-target-blocked'
                                ? runBridgeSelfTargetBlockedScenario
                                : scenario === 'active-tab-unavailable'
                                  ? runActiveTabUnavailableScenario
                                  : scenario === 'capture-busy'
                                    ? runCaptureBusyScenario
                                    : scenario === 'tech-only'
                                      ? runTechOnlyScenario
                                      : scenario === 'public-complex-target'
                                        ? runPublicComplexTargetScenario
                                        : scenario === 'visual-screenshot'
                                          ? runVisualScreenshotScenario
                                          : scenario === 'service-worker-idle-wake'
                                            ? runServiceWorkerIdleWakeScenario
                                            : scenario === 'sequential-capture-pressure'
                                              ? runSequentialCapturePressureScenario
                                              : scenario === 'target-navigated-away'
                                                ? runTargetNavigatedAwayScenario
                                                : scenario === 'target-load-failed'
                                                  ? runTargetLoadFailedScenario
                                                  : scenario === 'target-load-timeout'
                                                    ? runTargetLoadTimeoutScenario
                                                    : scenario === 'target-mode-query-boundaries'
                                                      ? runTargetModeQueryBoundariesScenario
                                                      : scenario === 'bridge-iframe-blocked'
                                                        ? runBridgeIframeBlockedScenario
                                                        : scenario === 'wrong-profile-extension-missing'
                                                          ? runWrongProfileExtensionMissingScenario
                                                          : scenario === 'host-validation'
                                                            ? runHostValidationScenario
                                                            : scenario === 'response-headers-cors'
                                                              ? runResponseHeadersCorsScenario
                                                              : scenario === 'request-shell-rejections'
                                                                ? runRequestShellRejectionsScenario
                                                                : scenario === 'connection-pressure'
                                                                  ? runConnectionPressureScenario
                                                                  : scenario === 'resource-timeouts'
                                                                    ? runResourceTimeoutsScenario
                                                                    : scenario === 'rate-limit'
                                                                      ? runRateLimitScenario
                                                                      : scenario === 'profile-rate-limit'
                                                                        ? runProfileRateLimitScenario
                                                                        : scenario === 'target-url-validation'
                                                                          ? runTargetUrlValidationScenario
                                                                          : scenario === 'result-expiry-bridge-page'
                                                                            ? runResultExpiryBridgePageScenario
                                                                            : run

scenarioRunner().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
