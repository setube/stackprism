import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex')
const profileChunkBytes = 384 * 1024
const percentEncodeFirstPayloadChar = value =>
  `${value.slice(0, 2)}%${value.charCodeAt(2).toString(16).toUpperCase().padStart(2, '0')}${value.slice(3)}`
const waitForCondition = async (predicate, label) => {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Timed out waiting for ${label}`)
}
const makeCaptureRequest = (overrides = {}) => {
  const options = {
    forceRefresh: false,
    captureScreenshotMetadata: false,
    keepTabOpen: false,
    allowPrivateNetworkTarget: false,
    targetMode: 'reuse_or_new_tab',
    maxResourceUrls: 300,
    ...(overrides.options || {})
  }
  return {
    url: 'https://example.com',
    mode: 'experience',
    waitMs: 0,
    include: ['tech'],
    viewports: [],
    protocolVersion: 1,
    ...overrides,
    options
  }
}

const makeSessionChrome = ({ enabled = true } = {}) => {
  const sessionStorage = {}
  return {
    sessionStorage,
    chrome: {
      storage: {
        session: {
          get: async key => {
            if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, sessionStorage[item]]))
            return { [key]: sessionStorage[key] }
          },
          set: async value => Object.assign(sessionStorage, value),
          remove: async keys => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStorage[key]
          }
        },
        local: { get: async () => ({ stackPrismSettings: enabled ? { agentBridgeEnabled: true } : {} }) },
        sync: { get: async () => ({ stackPrismSettings: { agentBridgeEnabled: true } }) }
      },
      runtime: { getManifest: () => ({ version: '1.3.71' }) }
    }
  }
}

test('bridge page parser validates loopback URL and JSON config token', async () => {
  const { isBridgePageUrl, normalizeWritableStatusPhase, parseBridgePageContext, requestJson, validateCaptureRequestEnvelope } =
    await loadTsModule('src/content/agent-bridge-client.ts')

  assert.equal(isBridgePageUrl(bridgeUrl), true)
  assert.equal(isBridgePageUrl('https://example.com/bridge'), false)
  assert.equal(normalizeWritableStatusPhase('failed', 'bridge_connected'), 'cleanup')
  assert.equal(normalizeWritableStatusPhase('failed'), 'cleanup')
  assert.equal(normalizeWritableStatusPhase('cancelled', 'target_loaded'), 'cleanup')
  assert.equal(normalizeWritableStatusPhase('running', 'target_loaded'), 'target_loaded')

  const context = parseBridgePageContext(bridgeUrl, JSON.stringify({ captureId, sessionId, nonce, bridgeToken, protocolVersion: 1 }))
  assert.deepEqual(context, {
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce,
    bridgeToken,
    protocolVersion: 1
  })

  const request = makeCaptureRequest()
  assert.equal(validateCaptureRequestEnvelope(context, { captureId, sessionId, nonce, protocolVersion: 1, request }), request)
  assert.throws(() => parseBridgePageContext(bridgeUrl, '{'), /INVALID_REQUEST/)
  assert.throws(() => parseBridgePageContext(bridgeUrl, JSON.stringify({ protocolVersion: 1 })), /INVALID_REQUEST/)
  assert.throws(
    () => parseBridgePageContext(bridgeUrl, JSON.stringify({ captureId, sessionId, nonce, bridgeToken, protocolVersion: 'not-a-number' })),
    /INVALID_REQUEST/
  )
  assert.throws(
    () => parseBridgePageContext(bridgeUrl, JSON.stringify({ captureId, sessionId, nonce, bridgeToken, protocolVersion: '1' })),
    /INVALID_REQUEST/
  )
  assert.throws(
    () =>
      parseBridgePageContext(
        bridgeUrl,
        JSON.stringify({ captureId, sessionId: identifiers.sessionId.valid[1], nonce, bridgeToken, protocolVersion: 1 })
      ),
    /INVALID_REQUEST/
  )
  assert.throws(
    () =>
      parseBridgePageContext(
        `${bridgeUrl}&nonce=${identifiers.nonce.valid[1]}`,
        JSON.stringify({ captureId, sessionId, nonce, bridgeToken, protocolVersion: 1 })
      ),
    /INVALID_REQUEST/
  )
  assert.throws(
    () =>
      parseBridgePageContext(
        bridgeUrl.replace(`session=${sessionId}`, `session=${percentEncodeFirstPayloadChar(sessionId)}`),
        JSON.stringify({ captureId, sessionId, nonce, bridgeToken, protocolVersion: 1 })
      ),
    /INVALID_REQUEST/
  )
  assert.throws(
    () => validateCaptureRequestEnvelope(context, { captureId, sessionId, nonce: identifiers.nonce.valid[1], protocolVersion: 1, request }),
    /BRIDGE_REQUEST_MISMATCH/
  )
  assert.throws(
    () =>
      validateCaptureRequestEnvelope(context, {
        captureId,
        sessionId,
        nonce,
        protocolVersion: 1,
        request: { url: 'https://example.com', mode: 'experience', include: ['tech'], options: {} }
      }),
    /BRIDGE_REQUEST_MISMATCH/
  )
  assert.throws(
    () =>
      validateCaptureRequestEnvelope(context, {
        captureId,
        sessionId,
        nonce,
        protocolVersion: 1,
        request: { ...request, waitMs: -1 }
      }),
    /BRIDGE_REQUEST_MISMATCH/
  )
  assert.throws(
    () =>
      validateCaptureRequestEnvelope(context, {
        captureId,
        sessionId,
        nonce,
        protocolVersion: 1,
        request: { ...request, viewports: [{ name: 123, width: 1440, height: 900, deviceScaleFactor: 1 }] }
      }),
    /BRIDGE_REQUEST_MISMATCH/
  )
  assert.throws(
    () =>
      validateCaptureRequestEnvelope(context, {
        captureId,
        sessionId,
        nonce,
        protocolVersion: 1,
        bridgeToken,
        profileUrl: `${context.bridgeOrigin}/v1/captures/${captureId}/profile`,
        request
      }),
    /BRIDGE_REQUEST_MISMATCH/
  )

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON')
    },
    text: async () => '<html>token=secret&nonce=n_EEEEEEEEEEEEEEEEEEEEEE</html>'
  })
  await assert.rejects(
    () => requestJson(context, '/v1/captures/cap_CCCCCCCCCCCCCCCCCCCCCC/request'),
    error => {
      assert.equal(error.message, 'PROFILE_TRANSPORT_FAILED')
      assert.equal(error.bridgeError.code, 'PROFILE_TRANSPORT_FAILED')
      assert.equal(error.bridgeError.details.status, 502)
      assert.equal(JSON.stringify(error.bridgeError), JSON.stringify(error.bridgeError).replace(/secret|nonce=/g, ''))
      return true
    }
  )
  globalThis.fetch = originalFetch
})

test('bridge client posts request mismatch and never starts capture when request envelope is bound to another capture', async () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  const originalLocation = globalThis.location
  const originalFetch = globalThis.fetch
  const { resetLoadTsModuleCaches, loadTsModule: freshLoadTsModule } = await import('./helpers/load-ts-module.mjs')
  resetLoadTsModuleCaches()

  const statusPosts = []
  const bridgeRequests = []
  const runtimeMessages = []
  globalThis.location = new URL(bridgeUrl)
  globalThis.window = {
    addEventListener: () => {},
    setInterval: () => {
      throw new Error('control polling must not start after request mismatch')
    },
    clearInterval: () => {}
  }
  globalThis.document = {
    querySelector: selector => {
      if (selector === 'meta[name="stackprism-agent-bridge"][content="1"]') return {}
      if (selector === '#stackprism-agent-bridge-config[type="application/json"]') {
        return { textContent: JSON.stringify({ captureId, sessionId, nonce, bridgeToken, protocolVersion: 1 }) }
      }
      return null
    },
    documentElement: { dataset: {} }
  }
  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url)
    bridgeRequests.push({ url: requestUrl, init })
    if (requestUrl === `http://127.0.0.1:17370/v1/captures/${captureId}/request`) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          captureId: identifiers.captureId.valid[1],
          sessionId,
          nonce,
          protocolVersion: 1,
          request: makeCaptureRequest()
        })
      }
    }
    if (requestUrl === `http://127.0.0.1:17370/v1/captures/${captureId}/status`) {
      statusPosts.push(JSON.parse(String(init.body || '{}')))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      }
    }
    throw new Error(`Unexpected bridge HTTP request: ${requestUrl}`)
  }
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: (message, callback) => {
        runtimeMessages.push(message)
        callback?.({ ok: true, data: {} })
      },
      connect: () => {
        throw new Error('profile transfer port must not open after request mismatch')
      }
    }
  }

  try {
    await freshLoadTsModule('src/content/agent-bridge-client.ts')
    await waitForCondition(() => statusPosts.length === 1, 'failed request mismatch status')

    assert.deepEqual(runtimeMessages, [])
    assert.equal(statusPosts[0].status, 'failed')
    assert.equal(statusPosts[0].phase, 'cleanup')
    assert.equal(statusPosts[0].error.code, 'BRIDGE_REQUEST_MISMATCH')
    assert.deepEqual(
      bridgeRequests.map(request => ({
        url: request.url,
        headers: request.init.headers
      })),
      [
        {
          url: `http://127.0.0.1:17370/v1/captures/${captureId}/request`,
          headers: { Authorization: `Bearer ${bridgeToken}` }
        },
        {
          url: `http://127.0.0.1:17370/v1/captures/${captureId}/status`,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bridgeToken}` }
        }
      ]
    )
    assert.equal(globalThis.document.documentElement.dataset.stackprismAgentBridgeClient, 'ready')
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
    if (originalLocation === undefined) delete globalThis.location
    else globalThis.location = originalLocation
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
    resetLoadTsModuleCaches()
  }
})

test('bridge client rejects incognito extension context before loading request or sending runtime messages', async () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  const originalLocation = globalThis.location
  const originalFetch = globalThis.fetch
  const { resetLoadTsModuleCaches, loadTsModule: freshLoadTsModule } = await import('./helpers/load-ts-module.mjs')
  resetLoadTsModuleCaches()

  const statusPosts = []
  const bridgeRequests = []
  const runtimeMessages = []
  globalThis.location = new URL(bridgeUrl)
  globalThis.window = {
    addEventListener: () => {},
    setInterval: () => {
      throw new Error('control polling must not start in incognito extension context')
    },
    clearInterval: () => {}
  }
  globalThis.document = {
    querySelector: selector => {
      if (selector === 'meta[name="stackprism-agent-bridge"][content="1"]') return {}
      if (selector === '#stackprism-agent-bridge-config[type="application/json"]') {
        return { textContent: JSON.stringify({ captureId, sessionId, nonce, bridgeToken, protocolVersion: 1 }) }
      }
      return null
    },
    documentElement: { dataset: {} }
  }
  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url)
    bridgeRequests.push({ url: requestUrl, init })
    if (requestUrl === `http://127.0.0.1:17370/v1/captures/${captureId}/status`) {
      statusPosts.push(JSON.parse(String(init.body || '{}')))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      }
    }
    throw new Error(`Unexpected bridge HTTP request in incognito context: ${requestUrl}`)
  }
  globalThis.chrome = {
    extension: { inIncognitoContext: true },
    runtime: {
      onMessage: {
        addListener: () => {
          throw new Error('status listener must not be registered in incognito extension context')
        }
      },
      sendMessage: (message, callback) => {
        runtimeMessages.push(message)
        callback?.({ ok: true, data: {} })
      },
      connect: () => {
        throw new Error('profile transfer port must not open in incognito extension context')
      }
    }
  }

  try {
    await freshLoadTsModule('src/content/agent-bridge-client.ts')
    await waitForCondition(() => statusPosts.length === 1, 'incognito rejection status')

    assert.deepEqual(runtimeMessages, [])
    assert.equal(statusPosts[0].status, 'failed')
    assert.equal(statusPosts[0].phase, 'cleanup')
    assert.equal(statusPosts[0].error.code, 'INCOGNITO_NOT_SUPPORTED')
    assert.deepEqual(
      bridgeRequests.map(request => request.url),
      [`http://127.0.0.1:17370/v1/captures/${captureId}/status`]
    )
    assert.equal(globalThis.document.documentElement.dataset.stackprismAgentBridgeClient, 'ready')
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
    if (originalLocation === undefined) delete globalThis.location
    else globalThis.location = originalLocation
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
    resetLoadTsModuleCaches()
  }
})

test('bridge client reports missing hello capabilities before starting capture', async () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  const originalLocation = globalThis.location
  const originalFetch = globalThis.fetch
  const { resetLoadTsModuleCaches, loadTsModule: freshLoadTsModule } = await import('./helpers/load-ts-module.mjs')
  resetLoadTsModuleCaches()

  const statusPosts = []
  const runtimeMessages = []
  globalThis.location = new URL(bridgeUrl)
  globalThis.window = {
    addEventListener: () => {},
    setInterval: () => {
      throw new Error('control polling must not start when required capabilities are missing')
    },
    clearInterval: () => {}
  }
  globalThis.document = {
    querySelector: selector => {
      if (selector === 'meta[name="stackprism-agent-bridge"][content="1"]') return {}
      if (selector === '#stackprism-agent-bridge-config[type="application/json"]') {
        return { textContent: JSON.stringify({ captureId, sessionId, nonce, bridgeToken, protocolVersion: 1 }) }
      }
      return null
    },
    documentElement: { dataset: {} }
  }
  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url)
    if (requestUrl === `http://127.0.0.1:17370/v1/captures/${captureId}/request`) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ captureId, sessionId, nonce, protocolVersion: 1, request: makeCaptureRequest() })
      }
    }
    if (requestUrl === `http://127.0.0.1:17370/v1/captures/${captureId}/status`) {
      statusPosts.push(JSON.parse(String(init.body || '{}')))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      }
    }
    throw new Error(`Unexpected bridge HTTP request: ${requestUrl}`)
  }
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: (message, callback) => {
        runtimeMessages.push(message)
        callback?.({
          ok: true,
          data: {
            extensionVersion: '1.3.71',
            protocolVersion: 1,
            capabilities: {
              agentBridge: true,
              siteExperienceProfileV1: true,
              profileChunkTransport: false,
              bridgeContentPost: true,
              storageSession: true,
              experienceProfiler: true,
              rawProfile: true,
              viewportMetadata: true
            }
          }
        })
      },
      connect: () => {
        throw new Error('profile transfer port must not open when required capabilities are missing')
      }
    }
  }

  try {
    await freshLoadTsModule('src/content/agent-bridge-client.ts')
    await waitForCondition(() => statusPosts.length === 2, 'missing capability failure status')

    assert.deepEqual(
      runtimeMessages.map(message => message.type),
      ['AGENT_BRIDGE_HELLO']
    )
    assert.equal(statusPosts[0].status, 'waiting_extension')
    assert.equal(statusPosts[1].status, 'failed')
    assert.equal(statusPosts[1].phase, 'cleanup')
    assert.equal(statusPosts[1].error.code, 'NOT_SUPPORTED')
    assert.equal(statusPosts[1].error.details.missingCapability, 'profileChunkTransport')
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
    if (originalLocation === undefined) delete globalThis.location
    else globalThis.location = originalLocation
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
    resetLoadTsModuleCaches()
  }
})

test('bridge client exits on non-bridge loopback pages without side effects', async () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  const originalLocation = globalThis.location
  const originalFetch = globalThis.fetch
  const { resetLoadTsModuleCaches, loadTsModule: freshLoadTsModule } = await import('./helpers/load-ts-module.mjs')
  resetLoadTsModuleCaches()

  let queried = false
  let fetched = false
  let runtimeMessaged = false
  globalThis.location = new URL(`http://127.0.0.1:17370/not-bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`)
  globalThis.window = {
    addEventListener: () => {
      throw new Error('window listeners must not be registered on non-bridge pages')
    },
    setInterval: () => {
      throw new Error('polling must not start on non-bridge pages')
    },
    clearInterval: () => {}
  }
  globalThis.document = {
    querySelector: () => {
      queried = true
      throw new Error('bridge config DOM must not be read on non-bridge pages')
    },
    documentElement: { dataset: {} }
  }
  globalThis.fetch = async () => {
    fetched = true
    throw new Error('bridge HTTP must not be called on non-bridge pages')
  }
  globalThis.chrome = {
    runtime: {
      sendMessage: () => {
        runtimeMessaged = true
        throw new Error('runtime messages must not be sent on non-bridge pages')
      }
    }
  }

  try {
    await freshLoadTsModule('src/content/agent-bridge-client.ts')

    assert.equal(queried, false)
    assert.equal(fetched, false)
    assert.equal(runtimeMessaged, false)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
    if (originalLocation === undefined) delete globalThis.location
    else globalThis.location = originalLocation
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
    resetLoadTsModuleCaches()
  }
})

test('profile transfer failures clear transfer state and reject late completion', async () => {
  const { handleTransferMessage } = await loadTsModule('src/content/agent-bridge-transfer.ts')
  const transferSource = await readFile(new URL('../src/content/agent-bridge-transfer.ts', import.meta.url), 'utf8')
  const context = { bridgeOrigin: 'http://127.0.0.1:17370', sessionId, captureId, nonce }
  const transferId = identifiers.profileTransferId.valid[0]
  const statuses = []
  const postStatus = async (status, phase, error) => statuses.push({ status, phase, error })
  let postedProfile = false
  const requestJson = async () => {
    postedProfile = true
    return { ok: true }
  }
  const bytes = Buffer.alloc(profileChunkBytes + 1)

  assert.equal(
    (
      await handleTransferMessage(context, postStatus, requestJson, {
        type: 'AGENT_PROFILE_TRANSFER_BEGIN',
        captureId,
        sessionId,
        nonce,
        profileTransferId: transferId,
        chunkCount: 2,
        byteLength: bytes.byteLength,
        sha256: sha256Hex(bytes)
      })
    ).ok,
    true
  )
  const missing = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_COMPLETE',
    captureId,
    sessionId,
    nonce,
    profileTransferId: transferId,
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes)
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'PROFILE_CHUNK_MISSING')

  const lateChunk = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_CHUNK',
    captureId,
    sessionId,
    nonce,
    profileTransferId: transferId,
    chunkIndex: 0,
    chunkCount: 2,
    chunkByteLength: 4,
    payloadBase64: 'e30='
  })
  assert.equal(lateChunk.ok, false)
  assert.equal(lateChunk.error.code, 'PROFILE_CHUNK_MISSING')
  assert.equal(postedProfile, false)
  assert.equal(statuses.at(-1).error.code, 'PROFILE_CHUNK_MISSING')
  assert.doesNotMatch(transferSource, /String\(error\)/)
})

test('profile transfer rejects invalid begin metadata before buffering chunks', async () => {
  const { handleTransferMessage } = await loadTsModule('src/content/agent-bridge-transfer.ts')
  const context = { bridgeOrigin: 'http://127.0.0.1:17370', sessionId, captureId, nonce }
  const statuses = []
  const postStatus = async (status, phase, error) => statuses.push({ status, phase, error })
  let postedProfile = false
  const requestJson = async () => {
    postedProfile = true
    return { ok: true }
  }

  const invalidHash = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_BEGIN',
    captureId,
    sessionId,
    nonce,
    profileTransferId: 'xfer_GGGGGGGGGGGGGGGGGGGGGG',
    chunkCount: 1,
    byteLength: 2,
    sha256: 'not-a-sha256'
  })
  assert.equal(invalidHash.ok, false)
  assert.equal(invalidHash.error.code, 'PROFILE_TRANSPORT_FAILED')

  const mismatchedChunkCount = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_BEGIN',
    captureId,
    sessionId,
    nonce,
    profileTransferId: 'xfer_HHHHHHHHHHHHHHHHHHHHHH',
    chunkCount: 2,
    byteLength: 2,
    sha256: sha256Hex(Buffer.from('{}'))
  })
  assert.equal(mismatchedChunkCount.ok, false)
  assert.equal(mismatchedChunkCount.error.code, 'PROFILE_TRANSPORT_FAILED')

  const oversized = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_BEGIN',
    captureId,
    sessionId,
    nonce,
    profileTransferId: 'xfer_IIIIIIIIIIIIIIIIIIIIII',
    chunkCount: 22,
    byteLength: 8 * 1024 * 1024 + 1,
    sha256: 'a'.repeat(64)
  })
  assert.equal(oversized.ok, false)
  assert.equal(oversized.error.code, 'PROFILE_TRANSPORT_FAILED')
  assert.equal(postedProfile, false)
  assert.equal(
    statuses.every(item => item.error.code === 'PROFILE_TRANSPORT_FAILED'),
    true
  )
})

test('profile transfer rejects duplicate chunks and invalid utf8 payloads', async () => {
  const { handleTransferMessage } = await loadTsModule('src/content/agent-bridge-transfer.ts')
  const context = { bridgeOrigin: 'http://127.0.0.1:17370', sessionId, captureId, nonce }
  const statuses = []
  const postStatus = async (status, phase, error) => statuses.push({ status, phase, error })
  let postedProfile = false
  const requestJson = async () => {
    postedProfile = true
    return { ok: true }
  }

  const duplicateTransferId = identifiers.profileTransferId.valid[0]
  assert.equal(
    (
      await handleTransferMessage(context, postStatus, requestJson, {
        type: 'AGENT_PROFILE_TRANSFER_BEGIN',
        captureId,
        sessionId,
        nonce,
        profileTransferId: duplicateTransferId,
        chunkCount: 1,
        byteLength: 2,
        sha256: sha256Hex(Buffer.from('{}'))
      })
    ).ok,
    true
  )
  assert.equal(
    (
      await handleTransferMessage(context, postStatus, requestJson, {
        type: 'AGENT_PROFILE_TRANSFER_CHUNK',
        captureId,
        sessionId,
        nonce,
        profileTransferId: duplicateTransferId,
        chunkIndex: 0,
        chunkCount: 1,
        chunkByteLength: 2,
        payloadBase64: Buffer.from('{}').toString('base64')
      })
    ).ok,
    true
  )
  const duplicate = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_CHUNK',
    captureId,
    sessionId,
    nonce,
    profileTransferId: duplicateTransferId,
    chunkIndex: 0,
    chunkCount: 1,
    chunkByteLength: 2,
    payloadBase64: Buffer.from('{}').toString('base64')
  })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error.code, 'PROFILE_CHUNK_MISSING')

  const emptyChunkTransferId = 'xfer_AAAAAAAAAAAAAAAAAAAAAA'
  assert.equal(
    (
      await handleTransferMessage(context, postStatus, requestJson, {
        type: 'AGENT_PROFILE_TRANSFER_BEGIN',
        captureId,
        sessionId,
        nonce,
        profileTransferId: emptyChunkTransferId,
        chunkCount: 1,
        byteLength: 1,
        sha256: sha256Hex(Buffer.from([0]))
      })
    ).ok,
    true
  )
  const emptyChunk = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_CHUNK',
    captureId,
    sessionId,
    nonce,
    profileTransferId: emptyChunkTransferId,
    chunkIndex: 0,
    chunkCount: 1,
    chunkByteLength: 0,
    payloadBase64: ''
  })
  assert.equal(emptyChunk.ok, false)
  assert.equal(emptyChunk.error.code, 'PROFILE_TRANSPORT_FAILED')

  const shortChunkTransferId = 'xfer_BBBBBBBBBBBBBBBBBBBBBB'
  assert.equal(
    (
      await handleTransferMessage(context, postStatus, requestJson, {
        type: 'AGENT_PROFILE_TRANSFER_BEGIN',
        captureId,
        sessionId,
        nonce,
        profileTransferId: shortChunkTransferId,
        chunkCount: 1,
        byteLength: 2,
        sha256: sha256Hex(Buffer.from('{}'))
      })
    ).ok,
    true
  )
  const shortChunk = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_CHUNK',
    captureId,
    sessionId,
    nonce,
    profileTransferId: shortChunkTransferId,
    chunkIndex: 0,
    chunkCount: 1,
    chunkByteLength: 3,
    payloadBase64: Buffer.from('{}').toString('base64')
  })
  assert.equal(shortChunk.ok, false)
  assert.equal(shortChunk.error.code, 'PROFILE_TRANSPORT_FAILED')

  const invalidUtf8TransferId = identifiers.profileTransferId.valid[1]
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])
  assert.equal(
    (
      await handleTransferMessage(context, postStatus, requestJson, {
        type: 'AGENT_PROFILE_TRANSFER_BEGIN',
        captureId,
        sessionId,
        nonce,
        profileTransferId: invalidUtf8TransferId,
        chunkCount: 1,
        byteLength: invalidUtf8.byteLength,
        sha256: sha256Hex(invalidUtf8)
      })
    ).ok,
    true
  )
  assert.equal(
    (
      await handleTransferMessage(context, postStatus, requestJson, {
        type: 'AGENT_PROFILE_TRANSFER_CHUNK',
        captureId,
        sessionId,
        nonce,
        profileTransferId: invalidUtf8TransferId,
        chunkIndex: 0,
        chunkCount: 1,
        chunkByteLength: invalidUtf8.byteLength,
        payloadBase64: invalidUtf8.toString('base64')
      })
    ).ok,
    true
  )
  const invalid = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_COMPLETE',
    captureId,
    sessionId,
    nonce,
    profileTransferId: invalidUtf8TransferId,
    byteLength: invalidUtf8.byteLength,
    sha256: sha256Hex(invalidUtf8)
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'PROFILE_TRANSPORT_FAILED')
  assert.equal(postedProfile, false)
  assert.equal(statuses.at(-1).error.code, 'PROFILE_TRANSPORT_FAILED')
})

test('profile transfer binds complete metadata to the begin hash', async () => {
  const { handleTransferMessage } = await loadTsModule('src/content/agent-bridge-transfer.ts')
  const context = { bridgeOrigin: 'http://127.0.0.1:17370', sessionId, captureId, nonce }
  const statuses = []
  const postStatus = async (status, phase, error) => statuses.push({ status, phase, error })
  let postedProfile = false
  const requestJson = async () => {
    postedProfile = true
    return { ok: true }
  }
  const transferId = identifiers.profileTransferId.valid[1]
  const bytes = Buffer.from('{}')

  assert.equal(
    (
      await handleTransferMessage(context, postStatus, requestJson, {
        type: 'AGENT_PROFILE_TRANSFER_BEGIN',
        captureId,
        sessionId,
        nonce,
        profileTransferId: transferId,
        chunkCount: 1,
        byteLength: bytes.byteLength,
        sha256: sha256Hex(Buffer.from('[]'))
      })
    ).ok,
    true
  )
  assert.equal(
    (
      await handleTransferMessage(context, postStatus, requestJson, {
        type: 'AGENT_PROFILE_TRANSFER_CHUNK',
        captureId,
        sessionId,
        nonce,
        profileTransferId: transferId,
        chunkIndex: 0,
        chunkCount: 1,
        chunkByteLength: bytes.byteLength,
        payloadBase64: bytes.toString('base64')
      })
    ).ok,
    true
  )

  const complete = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_COMPLETE',
    captureId,
    sessionId,
    nonce,
    profileTransferId: transferId,
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes)
  })
  assert.equal(complete.ok, false)
  assert.equal(complete.error.code, 'PROFILE_HASH_MISMATCH')
  assert.equal(statuses.at(-1).error.code, 'PROFILE_HASH_MISMATCH')
  assert.equal(postedProfile, false)
})

test('profile transfer rejects invalid transfer ids and non-contiguous chunks', async () => {
  const { handleTransferMessage } = await loadTsModule('src/content/agent-bridge-transfer.ts')
  const context = { bridgeOrigin: 'http://127.0.0.1:17370', sessionId, captureId, nonce }
  const statuses = []
  const postStatus = async (status, phase, error) => statuses.push({ status, phase, error })
  const requestJson = async () => ({ ok: true })

  const invalidTransfer = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_BEGIN',
    captureId,
    sessionId,
    nonce,
    profileTransferId: 'xfer_bad',
    chunkCount: 1,
    byteLength: 2,
    sha256: sha256Hex(Buffer.from('{}'))
  })
  assert.equal(invalidTransfer.ok, false)
  assert.equal(invalidTransfer.error.code, 'PROFILE_TRANSPORT_FAILED')

  const transferId = identifiers.profileTransferId.valid[0]
  const multiChunkBytes = Buffer.alloc(profileChunkBytes + 2)
  assert.equal(
    (
      await handleTransferMessage(context, postStatus, requestJson, {
        type: 'AGENT_PROFILE_TRANSFER_BEGIN',
        captureId,
        sessionId,
        nonce,
        profileTransferId: transferId,
        chunkCount: 2,
        byteLength: multiChunkBytes.byteLength,
        sha256: sha256Hex(multiChunkBytes)
      })
    ).ok,
    true
  )
  const outOfOrder = await handleTransferMessage(context, postStatus, requestJson, {
    type: 'AGENT_PROFILE_TRANSFER_CHUNK',
    captureId,
    sessionId,
    nonce,
    profileTransferId: transferId,
    chunkIndex: 1,
    chunkCount: 2,
    chunkByteLength: 2,
    payloadBase64: Buffer.from('{}').toString('base64')
  })
  assert.equal(outOfOrder.ok, false)
  assert.equal(outOfOrder.error.code, 'PROFILE_CHUNK_MISSING')
  assert.equal(statuses.at(-1).error.code, 'PROFILE_CHUNK_MISSING')
})

test('background hello rejects forged or mismatched bridge senders', async () => {
  const { extractBridgeSenderSession, clearBridgeSession, registerBridgeSession } = await loadTsModule(
    'src/background/agent-bridge-session.ts'
  )
  const env = makeSessionChrome()
  globalThis.chrome = env.chrome
  const message = { captureId, sessionId, nonce }

  assert.equal(extractBridgeSenderSession(message, sender()).ok, true)
  assert.equal(extractBridgeSenderSession(message, sender('https://example.com/bridge')).error.code, 'INVALID_REQUEST')
  assert.equal(extractBridgeSenderSession(message, senderWithoutTabId()).error.code, 'INVALID_REQUEST')
  assert.equal(
    extractBridgeSenderSession({ captureId, sessionId, nonce: identifiers.nonce.valid[1] }, sender()).error.code,
    'INVALID_REQUEST'
  )

  await clearBridgeSession(7)
  assert.equal((await registerBridgeSession(extractBridgeSenderSession(message, sender()).session)).ok, true)
  assert.equal((await registerBridgeSession(extractBridgeSenderSession(message, sender()).session)).ok, true)
  const mismatch = extractBridgeSenderSession(message, sender(bridgeUrl.replace('17370', '17371')))
  assert.equal((await registerBridgeSession(mismatch.session)).error.code, 'INVALID_REQUEST')
  await clearBridgeSession(7)
  delete globalThis.chrome
})

test('registered bridge messages must keep matching sender tab and URL', async () => {
  const { clearBridgeSession, extractBridgeSenderSession, registerBridgeSession, validateAgentCaptureControlMessage } = await loadTsModule(
    'src/background/agent-bridge-session.ts'
  )
  const env = makeSessionChrome()
  globalThis.chrome = env.chrome
  const message = { type: 'AGENT_CAPTURE_CONTROL', captureId, sessionId, nonce, command: 'cancel' }

  await clearBridgeSession(7)
  assert.equal((await validateAgentCaptureControlMessage(message, sender())).error.code, 'INVALID_REQUEST')
  assert.equal((await registerBridgeSession(extractBridgeSenderSession(message, sender()).session)).ok, true)
  assert.equal((await validateAgentCaptureControlMessage(message, sender())).ok, true)
  assert.equal(
    (await validateAgentCaptureControlMessage(message, sender(bridgeUrl.replace('17370', '17371')))).error.code,
    'INVALID_REQUEST'
  )
  await clearBridgeSession(7)
  delete globalThis.chrome
})

test('registered bridge session survives module reload through chrome storage session', async () => {
  const env = makeSessionChrome()
  globalThis.chrome = env.chrome
  const first = await loadTsModule('src/background/agent-bridge-session.ts')
  await first.clearBridgeSession(7)
  assert.equal(
    (await first.registerBridgeSession(first.extractBridgeSenderSession({ captureId, sessionId, nonce }, sender()).session)).ok,
    true
  )

  const { resetLoadTsModuleCaches, loadTsModule: freshLoadTsModule } = await import('./helpers/load-ts-module.mjs')
  resetLoadTsModuleCaches()
  const second = await freshLoadTsModule('src/background/agent-bridge-session.ts')
  const message = { type: 'AGENT_CAPTURE_CONTROL', captureId, sessionId, nonce, command: 'cancel' }
  assert.equal((await second.validateAgentCaptureControlMessage(message, sender())).ok, true)
  await second.clearBridgeSession(7)
  assert.equal(env.sessionStorage['agent-bridge-session:7'], undefined)
  delete globalThis.chrome
})

test('bridge session registration rejects concurrent mismatched sessions for the same tab', async () => {
  const env = makeSessionChrome()
  let releaseGet
  const firstGet = new Promise(resolve => {
    releaseGet = resolve
  })
  let getCount = 0
  env.chrome.storage.session.get = async key => {
    getCount += 1
    if (getCount <= 2) await firstGet
    if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, env.sessionStorage[item]]))
    return { [key]: env.sessionStorage[key] }
  }
  globalThis.chrome = env.chrome
  const { clearBridgeSession, registerBridgeSession } = await loadTsModule('src/background/agent-bridge-session.ts')
  await clearBridgeSession(7)

  const first = {
    tabId: 7,
    windowId: 3,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  }
  const second = { ...first, nonce: identifiers.nonce.valid[1] }
  const registrations = Promise.all([registerBridgeSession(first), registerBridgeSession(second)])
  releaseGet()
  const results = await registrations

  assert.equal(results.filter(result => result.ok).length, 1)
  assert.equal(results.filter(result => !result.ok && result.error.code === 'INVALID_REQUEST').length, 1)
  assert.equal(env.sessionStorage['agent-bridge-session:7'].nonce, nonce)
  await clearBridgeSession(7)
  delete globalThis.chrome
})

test('background hello reads only local agent bridge opt-in', async () => {
  const mod = await loadTsModule('src/background/agent-bridge-session.ts')
  const env = makeSessionChrome({ enabled: false })
  globalThis.chrome = env.chrome

  assert.equal(await mod.loadAgentBridgeEnabled(), false)
  const disabled = await mod.handleAgentBridgeHello(
    { type: 'AGENT_BRIDGE_HELLO', captureId, sessionId, nonce, protocolVersion: 1 },
    sender()
  )
  assert.equal(disabled.error.code, 'AGENT_BRIDGE_DISABLED')

  globalThis.chrome.storage.local.get = async () => {
    throw new Error('local storage unavailable')
  }
  assert.equal(await mod.loadAgentBridgeEnabled(), false)
  const storageFailure = await mod.handleAgentBridgeHello(
    { type: 'AGENT_BRIDGE_HELLO', captureId, sessionId, nonce, protocolVersion: 1 },
    sender()
  )
  assert.equal(storageFailure.error.code, 'AGENT_BRIDGE_DISABLED')

  globalThis.chrome.storage.local.get = async () => ({ stackPrismSettings: { agentBridgeEnabled: true } })
  const enabled = await mod.handleAgentBridgeHello(
    { type: 'AGENT_BRIDGE_HELLO', captureId, sessionId, nonce, protocolVersion: 1 },
    sender()
  )
  assert.equal(enabled.ok, true)
  assert.equal(enabled.data.protocolVersion, 1)
  assert.equal(enabled.data.capabilities.profileChunkTransport, true)
  await mod.clearBridgeSession(7)
  delete globalThis.chrome
})

test('background hello fails closed when chrome storage session is unavailable', async () => {
  const mod = await loadTsModule('src/background/agent-bridge-session.ts')
  const env = makeSessionChrome()
  delete env.chrome.storage.session
  globalThis.chrome = env.chrome

  const response = await mod.handleAgentBridgeHello(
    { type: 'AGENT_BRIDGE_HELLO', captureId, sessionId, nonce, protocolVersion: 1 },
    sender()
  )

  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'NOT_SUPPORTED')
  assert.equal(response.error.details.missingCapability, 'storageSession')
  delete globalThis.chrome
})

test('agent bridge pages are excluded from ordinary detection paths', async () => {
  const { isAgentBridgePageUrl, isDetectablePageUrl, checkPageSupport } = await loadTsModule('src/utils/page-support.ts')
  const observerSource = await readFile(new URL('../src/content/content-observer.ts', import.meta.url), 'utf8')
  const routerSource = await readFile(new URL('../src/background/message-router.ts', import.meta.url), 'utf8')

  assert.equal(isAgentBridgePageUrl(bridgeUrl), true)
  assert.equal(isDetectablePageUrl(bridgeUrl), false)
  assert.equal(checkPageSupport(bridgeUrl).supported, false)
  assert.equal(isAgentBridgePageUrl('http://127.0.0.1:17370/bridge'), false)
  assert.equal(isDetectablePageUrl('http://127.0.0.1:17370/bridge'), true)
  assert.equal(checkPageSupport('http://127.0.0.1:17370/bridge').supported, true)
  assert.match(observerSource, /location\.hostname !== '127\.0\.0\.1'/)
  assert.match(observerSource, /location\.pathname !== '\/bridge'/)
  assert.match(observerSource, /session: \/\^s_\[A-Za-z0-9_-\]\{22\}\$\//)
  assert.match(routerSource, /const rejectPopupTargetTab = async/)
  assert.match(routerSource, /isAgentBridgeTab\(sender\.tab\)/)
  assert.match(routerSource, /tab\?\.incognito/)
  assert.match(routerSource, /checkPageSupport\(tab\.url\)/)
})

test('bridge client registers profile transfer port only after hello succeeds', async () => {
  const source = await readFile(new URL('../src/content/agent-bridge-client.ts', import.meta.url), 'utf8')
  const helloIndex = source.indexOf("type: 'AGENT_BRIDGE_HELLO'")
  const capabilityIndex = source.indexOf('if (!hasRequiredCapabilities')
  const transferIndex = source.indexOf('registerProfileTransferListener(context')
  const startIndex = source.indexOf("type: 'START_AGENT_CAPTURE'")

  assert.ok(helloIndex >= 0)
  assert.ok(capabilityIndex > helloIndex)
  assert.ok(transferIndex > capabilityIndex)
  assert.ok(startIndex > transferIndex)
  assert.doesNotMatch(source, /console\.error\([^)]*,\s*error\)/)
  assert.match(source, /errorCode: errorFromUnknown/)
})
