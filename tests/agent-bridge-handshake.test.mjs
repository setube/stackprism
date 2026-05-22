import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadTsModule } from './helpers/load-ts-module.mjs'
import identifiers from './fixtures/bridge-protocol-identifiers.json' with { type: 'json' }

const sessionId = identifiers.sessionId.valid[0]
const captureId = identifiers.captureId.valid[0]
const nonce = identifiers.nonce.valid[0]
const bridgeToken = identifiers.bridgeToken.valid[0]
const bridgeUrl = `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`

const sender = (url = bridgeUrl, tabId = 7, windowId = 3) => ({ url, tab: { id: tabId, windowId } })
const senderWithoutTabId = () => ({ url: bridgeUrl, tab: { windowId: 3 } })

test('bridge page parser validates loopback URL and JSON config token', async () => {
  const { isBridgePageUrl, parseBridgePageContext, validateCaptureRequestEnvelope } = await loadTsModule(
    'src/content/agent-bridge-client.ts'
  )

  assert.equal(isBridgePageUrl(bridgeUrl), true)
  assert.equal(isBridgePageUrl('https://example.com/bridge'), false)

  const context = parseBridgePageContext(bridgeUrl, JSON.stringify({ bridgeToken, protocolVersion: 1 }))
  assert.deepEqual(context, {
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce,
    bridgeToken,
    protocolVersion: 1
  })

  const request = {
    url: 'https://example.com',
    mode: 'experience',
    waitMs: 0,
    include: ['tech'],
    viewports: [],
    options: {},
    protocolVersion: 1
  }
  assert.equal(validateCaptureRequestEnvelope(context, { captureId, sessionId, nonce, protocolVersion: 1, request }), request)
  assert.throws(() => parseBridgePageContext(bridgeUrl, JSON.stringify({ protocolVersion: 1 })), /INVALID_REQUEST/)
  assert.throws(
    () => validateCaptureRequestEnvelope(context, { captureId, sessionId, nonce: identifiers.nonce.valid[1], protocolVersion: 1, request }),
    /BRIDGE_REQUEST_MISMATCH/
  )
})

test('background hello rejects forged or mismatched bridge senders', async () => {
  const { extractBridgeSenderSession, clearBridgeSession, registerBridgeSession } = await loadTsModule(
    'src/background/agent-bridge-session.ts'
  )
  const message = { captureId, sessionId, nonce }

  assert.equal(extractBridgeSenderSession(message, sender()).ok, true)
  assert.equal(extractBridgeSenderSession(message, sender('https://example.com/bridge')).error.code, 'INVALID_REQUEST')
  assert.equal(extractBridgeSenderSession(message, senderWithoutTabId()).error.code, 'INVALID_REQUEST')
  assert.equal(
    extractBridgeSenderSession({ captureId, sessionId, nonce: identifiers.nonce.valid[1] }, sender()).error.code,
    'INVALID_REQUEST'
  )

  clearBridgeSession(7)
  assert.equal(registerBridgeSession(extractBridgeSenderSession(message, sender()).session).ok, true)
  assert.equal(registerBridgeSession(extractBridgeSenderSession(message, sender()).session).ok, true)
  const mismatch = extractBridgeSenderSession(message, sender(bridgeUrl.replace('17370', '17371')))
  assert.equal(registerBridgeSession(mismatch.session).error.code, 'INVALID_REQUEST')
  clearBridgeSession(7)
})

test('registered bridge messages must keep matching sender tab and URL', async () => {
  const { clearBridgeSession, extractBridgeSenderSession, registerBridgeSession, validateAgentCaptureControlMessage } = await loadTsModule(
    'src/background/agent-bridge-session.ts'
  )
  const message = { type: 'AGENT_CAPTURE_CONTROL', captureId, sessionId, nonce, command: 'cancel' }

  clearBridgeSession(7)
  assert.equal(validateAgentCaptureControlMessage(message, sender()).error.code, 'INVALID_REQUEST')
  assert.equal(registerBridgeSession(extractBridgeSenderSession(message, sender()).session).ok, true)
  assert.equal(validateAgentCaptureControlMessage(message, sender()).ok, true)
  assert.equal(validateAgentCaptureControlMessage(message, sender(bridgeUrl.replace('17370', '17371'))).error.code, 'INVALID_REQUEST')
  clearBridgeSession(7)
})

test('background hello reads only local agent bridge opt-in', async () => {
  const mod = await loadTsModule('src/background/agent-bridge-session.ts')
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ stackPrismSettings: {} }) },
      sync: { get: async () => ({ stackPrismSettings: { agentBridgeEnabled: true } }) }
    },
    runtime: { getManifest: () => ({ version: '1.3.71' }) }
  }

  assert.equal(await mod.loadAgentBridgeEnabled(), false)
  const disabled = await mod.handleAgentBridgeHello(
    { type: 'AGENT_BRIDGE_HELLO', captureId, sessionId, nonce, protocolVersion: 1 },
    sender()
  )
  assert.equal(disabled.error.code, 'AGENT_BRIDGE_DISABLED')

  globalThis.chrome.storage.local.get = async () => ({ stackPrismSettings: { agentBridgeEnabled: true } })
  const enabled = await mod.handleAgentBridgeHello(
    { type: 'AGENT_BRIDGE_HELLO', captureId, sessionId, nonce, protocolVersion: 1 },
    sender()
  )
  assert.equal(enabled.ok, true)
  assert.equal(enabled.data.protocolVersion, 1)
  assert.equal(enabled.data.capabilities.profileChunkTransport, true)
  mod.clearBridgeSession(7)
  delete globalThis.chrome
})

test('agent bridge pages are excluded from ordinary detection paths', async () => {
  const { isAgentBridgePageUrl, isDetectablePageUrl, checkPageSupport } = await loadTsModule('src/utils/page-support.ts')
  const observerSource = await readFile(new URL('../src/content/content-observer.ts', import.meta.url), 'utf8')

  assert.equal(isAgentBridgePageUrl(bridgeUrl), true)
  assert.equal(isDetectablePageUrl(bridgeUrl), false)
  assert.equal(checkPageSupport(bridgeUrl).supported, false)
  assert.match(observerSource, /location\.hostname === '127\.0\.0\.1'/)
  assert.match(observerSource, /location\.pathname === '\/bridge'/)
})
