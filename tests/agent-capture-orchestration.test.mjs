import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTsModule, resetLoadTsModuleCaches } from './helpers/load-ts-module.mjs'
import identifiers from './fixtures/bridge-protocol-identifiers.json' with { type: 'json' }

const captureId = identifiers.captureId.valid[0]
const secondCaptureId = identifiers.captureId.valid[1]
const sessionId = identifiers.sessionId.valid[0]
const nonce = identifiers.nonce.valid[0]
const originalFetch = globalThis.fetch

const baseRequest = {
  url: 'https://example.com/app?view=one#frag',
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
  },
  protocolVersion: 1
}

const fullCapabilities = {
  agentBridge: true,
  siteExperienceProfileV1: true,
  profileChunkTransport: true,
  bridgeContentPost: true,
  storageSession: true,
  experienceProfiler: true,
  rawProfile: true,
  viewportMetadata: true
}

const makeChrome = () => {
  const storage = {}
  const messages = []
  const removedTabs = []
  const ports = []
  const tabEvents = {
    onActivated: [],
    onUpdated: [],
    onRemoved: []
  }
  const storageEvents = {
    onChanged: []
  }
  const webRequestEvents = {
    onHeadersReceived: [],
    onResponseStarted: []
  }
  const webNavigationEvents = {
    onCommitted: [],
    onErrorOccurred: []
  }
  const runtimeEvents = {
    onInstalled: [],
    onStartup: []
  }
  const executedScripts = []
  const tabs = [
    { id: 1, windowId: 1, url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, incognito: false },
    { id: 2, windowId: 1, url: 'https://example.com/app?view=one', title: 'Target', incognito: false, status: 'complete' }
  ]
  return {
    storage,
    messages,
    removedTabs,
    ports,
    tabs,
    executedScripts,
    tabEvents,
    storageEvents,
    webRequestEvents,
    webNavigationEvents,
    runtimeEvents,
    chrome: {
      storage: {
        session: {
          get: async key => {
            if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, storage[item]]))
            return { [key]: storage[key] }
          },
          set: async value => Object.assign(storage, value),
          remove: async keys => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]
          }
        },
        local: { get: async () => ({ stackPrismSettings: { agentBridgeEnabled: true } }) },
        sync: { get: async () => ({}) },
        onChanged: {
          addListener: listener => storageEvents.onChanged.push(listener)
        }
      },
      tabs: {
        query: async () => tabs,
        get: async id => tabs.find(tab => tab.id === id) || { id, windowId: 1, url: '', incognito: false },
        create: async create => {
          const tab = { id: 3, windowId: 1, url: create.url, incognito: false, status: 'complete' }
          tabs.push(tab)
          return tab
        },
        remove: async id => removedTabs.push(id),
        sendMessage: async (_tabId, message) => {
          messages.push(message)
          return { ok: true }
        },
        onActivated: {
          addListener: listener => tabEvents.onActivated.push(listener)
        },
        onUpdated: {
          addListener: listener => tabEvents.onUpdated.push(listener),
          removeListener: listener => {
            const index = tabEvents.onUpdated.indexOf(listener)
            if (index >= 0) tabEvents.onUpdated.splice(index, 1)
          }
        },
        onRemoved: {
          addListener: listener => tabEvents.onRemoved.push(listener),
          removeListener: listener => {
            const index = tabEvents.onRemoved.indexOf(listener)
            if (index >= 0) tabEvents.onRemoved.splice(index, 1)
          }
        }
      },
      scripting: {
        executeScript: async details => {
          executedScripts.push(details)
          return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
        }
      },
      action: {
        setBadgeText: () => Promise.resolve(),
        setTitle: () => Promise.resolve(),
        setBadgeBackgroundColor: () => Promise.resolve()
      },
      runtime: {
        getManifest: () => ({
          version: '1.3.71',
          content_scripts: [
            { js: ['assets/content-observer.ts-unit.js'], matches: ['http://*/*', 'https://*/*'] },
            { js: ['assets/agent-bridge-client.ts-unit.js'], matches: ['http://127.0.0.1/*'] }
          ]
        }),
        getURL: path => `chrome-extension://stackprism/${path}`,
        onConnect: {
          addListener: listener => {
            ports.push({ listener })
          }
        },
        onMessage: {
          addListener: () => {}
        },
        onInstalled: {
          addListener: listener => runtimeEvents.onInstalled.push(listener)
        },
        onStartup: {
          addListener: listener => runtimeEvents.onStartup.push(listener)
        }
      },
      webNavigation: {
        onCommitted: {
          addListener: listener => webNavigationEvents.onCommitted.push(listener)
        },
        onErrorOccurred: {
          addListener: listener => webNavigationEvents.onErrorOccurred.push(listener)
        }
      },
      webRequest: {
        onHeadersReceived: {
          addListener: listener => webRequestEvents.onHeadersReceived.push(listener)
        },
        onResponseStarted: {
          addListener: listener => webRequestEvents.onResponseStarted.push(listener)
        }
      }
    }
  }
}

const makeProfileTransferPort = (env, options = {}) => {
  const backgroundListeners = []
  const disconnectListeners = []
  let disconnected = false
  const port = {
    name: 'stackprism-agent-profile-transfer',
    sender: {
      url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
      tab: { id: 1, windowId: 1 }
    },
    onMessage: {
      addListener: listener => backgroundListeners.push(listener)
    },
    onDisconnect: {
      addListener: listener => disconnectListeners.push(listener)
    },
    postMessage: message => {
      env.messages.push(message)
      if (options.disconnectOnMessageType === message.type && !disconnected) {
        disconnected = true
        queueMicrotask(() => disconnectListeners.forEach(listener => listener()))
        return
      }
      if (options.autoAck === false) return
      if (!message.type?.startsWith('AGENT_PROFILE_TRANSFER_') || message.type === 'AGENT_PROFILE_TRANSFER_ACK') return
      const ack = {
        type: 'AGENT_PROFILE_TRANSFER_ACK',
        captureId: message.captureId,
        sessionId: message.sessionId,
        nonce: message.nonce,
        profileTransferId: message.profileTransferId,
        chunkIndex: message.chunkIndex,
        ok: true
      }
      queueMicrotask(() => backgroundListeners.forEach(listener => listener(ack)))
    },
    disconnect: () => {
      if (disconnected) return
      disconnected = true
      disconnectListeners.forEach(listener => listener())
    }
  }
  return {
    port,
    emit: message => backgroundListeners.forEach(listener => listener(message)),
    disconnect: port.disconnect
  }
}

const connectProfileTransferPort = async (env, registerAgentProfileTransferPort, options = {}) => {
  const connection = makeProfileTransferPort(env, options)
  registerAgentProfileTransferPort(connection.port)
  connection.emit({
    type: 'AGENT_PROFILE_TRANSFER_PORT_HELLO',
    captureId,
    sessionId,
    nonce,
    protocolVersion: 1
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  return connection
}

test('experience profiler injection receives screenshot metadata option and clears page global', async () => {
  const calls = []
  globalThis.chrome = {
    scripting: {
      executeScript: async options => {
        calls.push(options)
        return options.files
          ? [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
          : []
      }
    }
  }
  const { executeExperienceProfiler } = await loadTsModule('src/background/agent-capture-target.ts')

  const result = await executeExperienceProfiler(42, { captureScreenshotMetadata: false })

  assert.ok(result.visual)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0].args, [{ captureScreenshotMetadata: false }])
  assert.deepEqual(calls[1].files, ['injected/experience-profiler.iife.js'])
  assert.equal(typeof calls[2].func, 'function')
  delete globalThis.chrome
})

const enableBridgeStatusAck = env => {
  env.chrome.tabs.sendMessage = async (_tabId, message) => {
    env.messages.push(message)
    if (message.type === 'AGENT_CAPTURE_STATUS') return { ok: true, data: { status: message.payload.status } }
    return { ok: true }
  }
}

const enableFastHeaderFallback = () => {
  globalThis.fetch = async url =>
    new Response('', {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'x-powered-by': 'unit-test'
      }
    })
}

const restoreFetch = () => {
  globalThis.fetch = originalFetch
}

const waitForMessage = async (messages, predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (messages.some(predicate)) return messages.find(predicate)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('expected message was not observed before timeout')
}

const waitForCondition = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('expected condition was not observed before timeout')
}

const decodeTransferredProfile = messages => {
  const begin = messages.find(message => message.type === 'AGENT_PROFILE_TRANSFER_BEGIN')
  const chunks = messages
    .filter(message => message.type === 'AGENT_PROFILE_TRANSFER_CHUNK' && message.profileTransferId === begin.profileTransferId)
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
  const json = chunks.map(chunk => Buffer.from(chunk.payloadBase64, 'base64').toString('utf8')).join('')
  return JSON.parse(json)
}

test('agent capture request validation is strict and normalizes URLs', async () => {
  const { validateAgentCaptureRequest, normalizeComparableUrl } = await loadTsModule('src/background/agent-capture-request.ts')

  const valid = validateAgentCaptureRequest(baseRequest)
  assert.equal(valid.ok, true)
  assert.equal(valid.request.url, 'https://example.com/app?view=one')
  const reordered = validateAgentCaptureRequest({ ...baseRequest, include: ['ux', 'tech', 'ux', 'assets'] })
  assert.deepEqual(reordered.request.include, ['tech', 'ux', 'assets'])
  assert.equal(normalizeComparableUrl('HTTPS://Example.com:443/app?x=1#hash'), 'https://example.com/app?x=1')
  assert.equal(normalizeComparableUrl('https://example.com/app'), 'https://example.com/app')
  assert.equal(normalizeComparableUrl('https://example.com/app/'), 'https://example.com/app/')
  assert.notEqual(normalizeComparableUrl('https://example.com/app'), normalizeComparableUrl('https://example.com/app/'))
  assert.equal(
    normalizeComparableUrl('https://example.com/a%20b/c%2Fd?tab=one&sort=a%2Bb#section'),
    'https://example.com/a%20b/c%2Fd?tab=one&sort=a%2Bb'
  )

  assert.equal(validateAgentCaptureRequest({ ...baseRequest, include: [] }).error.code, 'INVALID_REQUEST')
  assert.equal(validateAgentCaptureRequest({ ...baseRequest, url: 'https://user:pass@example.com/app' }).error.code, 'INVALID_REQUEST')
  assert.equal(
    validateAgentCaptureRequest({ ...baseRequest, options: { ...baseRequest.options, bridgeToken: true } }).error.code,
    'INVALID_REQUEST'
  )
  assert.equal(
    validateAgentCaptureRequest({ ...baseRequest, viewports: [{ width: 100, height: 900, deviceScaleFactor: 1 }] }).error.code,
    'INVALID_REQUEST'
  )
  assert.equal(validateAgentCaptureRequest({ ...baseRequest, unexpected: true }).error.code, 'INVALID_REQUEST')
  assert.equal(validateAgentCaptureRequest({ ...baseRequest, protocolVersion: 2 }).error.code, 'BRIDGE_PROTOCOL_UNSUPPORTED')
  assert.equal(
    validateAgentCaptureRequest({
      ...baseRequest,
      viewports: [{ name: 'bad space', width: 1440, height: 900, deviceScaleFactor: 1 }]
    }).error.code,
    'INVALID_REQUEST'
  )
  assert.equal(
    validateAgentCaptureRequest({
      ...baseRequest,
      viewports: [{ name: 123, width: 1440, height: 900, deviceScaleFactor: 1 }]
    }).error.code,
    'INVALID_REQUEST'
  )
  assert.equal(
    validateAgentCaptureRequest({
      ...baseRequest,
      viewports: [{ name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, extra: true }]
    }).error.code,
    'INVALID_REQUEST'
  )
  assert.equal(
    validateAgentCaptureRequest({
      ...baseRequest,
      viewports: [{ name: 'desktop', width: 1440, height: 900, deviceScaleFactor: '1' }]
    }).error.code,
    'INVALID_REQUEST'
  )
  assert.equal(
    validateAgentCaptureRequest({
      ...baseRequest,
      viewports: [{ name: 'desktop', width: 1440, height: 900, deviceScaleFactor: true }]
    }).error.code,
    'INVALID_REQUEST'
  )
})

test('agent capture network observer stays inactive when response-started API is unavailable', async () => {
  resetLoadTsModuleCaches()
  globalThis.chrome = { webRequest: {} }
  const { registerAgentCaptureNetworkObserver, validateAgentCaptureNetwork, waitForAgentCaptureNetworkEvidence } = await loadTsModule(
    'src/background/agent-capture-network.ts'
  )
  const state = {
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: '',
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: baseRequest.url,
    finalUrl: baseRequest.url,
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_loaded',
    status: 'running',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    deadlineAt: Date.now() + 1000
  }

  registerAgentCaptureNetworkObserver(() => assert.fail('network observer callback should not run'))

  assert.equal(await waitForAgentCaptureNetworkEvidence(state), state)
  assert.equal(validateAgentCaptureNetwork(state, baseRequest), null)
  delete globalThis.chrome
})

test('agent capture stores no tokens and sends profile chunks through bridge tab', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await connectProfileTransferPort(env, registerAgentProfileTransferPort)

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  await waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE')
  const transferBegin = env.messages.find(message => message.type === 'AGENT_PROFILE_TRANSFER_BEGIN')
  const transferComplete = env.messages.find(message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE')
  const profile = decodeTransferredProfile(env.messages)
  assert.equal(JSON.stringify(env.storage).includes('spbt_'), false)
  assert.equal(JSON.stringify(env.storage).includes('spb_'), false)
  assert.match(transferBegin.profileTransferId, /^xfer_[A-Za-z0-9_-]{22}$/)
  assert.equal(transferComplete.profileTransferId, transferBegin.profileTransferId)
  assert.equal(profile.browserContext.extensionVersion, '1.3.71')
  assert.match(profile.browserContext.userAgent, /Node|Mozilla|Chrome/)
  assert.match(profile.browserContext.capturedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(env.removedTabs.includes(2), false)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
  restoreFetch()
})

test('agent bridge storage session access level is not widened to untrusted contexts', async () => {
  const env = makeChrome()
  const accessLevelCalls = []
  env.chrome.storage.session.setAccessLevel = async options => {
    accessLevelCalls.push(options)
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { saveAgentCaptureState }, { recordActiveTab }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture-state.ts'),
    loadTsModule('src/background/active-tab-tracker.ts')
  ])

  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: 'http://127.0.0.1:17370/bridge',
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_opening',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: 100,
    bridgeToken: 'spbt_should_not_store',
    apiToken: 'spb_should_not_store'
  })
  await recordActiveTab({ id: 2, windowId: 1, url: 'https://example.com/app?view=one', incognito: false })

  assert.deepEqual(accessLevelCalls, [])
  assert.equal(JSON.stringify(env.storage).includes('TRUSTED_AND_UNTRUSTED_CONTEXTS'), false)
  assert.equal(JSON.stringify(env.storage).includes('spbt_should_not_store'), false)
  assert.equal(JSON.stringify(env.storage).includes('spb_should_not_store'), false)
  delete globalThis.chrome
})

test('agent bridge router does not expose raw internal exception messages', async () => {
  const env = makeChrome()
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args)
  env.chrome.storage.session.get = async () => {
    throw new Error(
      'storage failed http://127.0.0.1:17370/bridge?token=secret&nonce=n_SECRETSECRETSECRETSECRET spb_ABCDEFGHIJKLMNOPQRSTUVWxy123456789012345'
    )
  }
  let messageListener = null
  env.chrome.runtime.onMessage.addListener = listener => {
    messageListener = listener
  }
  try {
    globalThis.chrome = env.chrome
    const { registerMessageRouter } = await loadTsModule('src/background/message-router.ts')

    registerMessageRouter()
    assert.equal(typeof messageListener, 'function')

    const response = await new Promise(resolve => {
      messageListener(
        { type: 'AGENT_BRIDGE_HELLO', captureId, sessionId, nonce, protocolVersion: 1 },
        { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } },
        resolve
      )
    })

    const serialized = JSON.stringify(response)
    const serializedLogs = JSON.stringify(errors)
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'INVALID_REQUEST')
    assert.equal(serialized.includes('token=secret'), false)
    assert.equal(serialized.includes('spb_'), false)
    assert.equal(serialized.includes('nonce='), false)
    assert.equal(serialized.includes('/bridge?'), false)
    assert.equal(serializedLogs.includes('token=secret'), false)
    assert.equal(serializedLogs.includes('spb_'), false)
    assert.equal(serializedLogs.includes('nonce='), false)
    assert.equal(serializedLogs.includes('/bridge?'), false)
  } finally {
    console.error = originalError
    delete globalThis.chrome
  }
})

test('agent capture rejects unknown top-level start payload fields', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const [{ clearBridgeSession, getBridgeSession, registerBridgeSession }, { startAgentCapture }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts')
  ])
  await clearBridgeSession(1)
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: { ...fullCapabilities },
      unexpectedField: true
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.error.code, 'INVALID_REQUEST')
  assert.equal(await getBridgeSession(1), null)
  delete globalThis.chrome
})

test('agent capture rejects forbidden sensitive start payload fields before resolving target tabs', async () => {
  const env = makeChrome()
  let targetResolutionAttempted = false
  env.chrome.tabs.query = async () => {
    targetResolutionAttempted = true
    return env.tabs
  }
  env.chrome.tabs.create = async () => {
    targetResolutionAttempted = true
    return { id: 3, windowId: 1, url: baseRequest.url, incognito: false, status: 'complete' }
  }
  globalThis.chrome = env.chrome
  const [{ clearBridgeSession, getBridgeSession, registerBridgeSession }, { startAgentCapture }, { listAgentCaptureIds }] =
    await Promise.all([
      loadTsModule('src/background/agent-bridge-session.ts'),
      loadTsModule('src/background/agent-capture.ts'),
      loadTsModule('src/background/agent-capture-state.ts')
    ])
  await clearBridgeSession(1)
  for (const forbidden of [
    { bridgeToken: 'spbt_should_not_reach_background' },
    { callbackUrl: 'https://example.com/callback' },
    { profile: { schema: 'stackprism.site_experience_profile.v1' } }
  ]) {
    await registerBridgeSession({
      tabId: 1,
      windowId: 1,
      bridgeOrigin: 'http://127.0.0.1:17370',
      sessionId,
      captureId,
      nonce
    })
    const response = await startAgentCapture(
      {
        type: 'START_AGENT_CAPTURE',
        captureId,
        sessionId,
        nonce,
        bridgeOrigin: 'http://127.0.0.1:17370',
        request: baseRequest,
        capabilities: { ...fullCapabilities },
        ...forbidden
      },
      { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
    )

    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'INVALID_REQUEST')
    assert.equal(response.error.message, 'Agent capture payload contains forbidden fields.')
    assert.equal(await getBridgeSession(1), null)
  }
  assert.equal(targetResolutionAttempted, false)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture rejects missing required capabilities before resolving target tabs', async () => {
  const env = makeChrome()
  let targetResolutionAttempted = false
  env.chrome.tabs.query = async () => {
    targetResolutionAttempted = true
    return env.tabs
  }
  env.chrome.tabs.create = async () => {
    targetResolutionAttempted = true
    return { id: 3, windowId: 1, url: baseRequest.url, incognito: false, status: 'complete' }
  }
  globalThis.chrome = env.chrome
  const [{ clearBridgeSession, registerBridgeSession }, { startAgentCapture }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await clearBridgeSession(1)
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
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
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'NOT_SUPPORTED')
  assert.equal(response.error.details.missingCapability, 'profileChunkTransport')
  assert.equal(targetResolutionAttempted, false)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture rechecks local opt-in before resolving target tabs', async () => {
  const env = makeChrome()
  let targetResolutionAttempted = false
  env.chrome.storage.local.get = async () => ({ stackPrismSettings: { agentBridgeEnabled: false } })
  env.chrome.tabs.query = async () => {
    targetResolutionAttempted = true
    return env.tabs
  }
  env.chrome.tabs.create = async () => {
    targetResolutionAttempted = true
    return { id: 3, windowId: 1, url: baseRequest.url, incognito: false, status: 'complete' }
  }
  globalThis.chrome = env.chrome
  const [{ getBridgeSession, registerBridgeSession }, { startAgentCapture }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'AGENT_BRIDGE_DISABLED')
  assert.equal(targetResolutionAttempted, false)
  assert.equal(await getBridgeSession(1), null)
  delete globalThis.chrome
})

test('agent capture fails running captures when local opt-in is disabled', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ handleAgentBridgeOptInDisabled }, { saveAgentCaptureState, listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_loaded',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60000
  })

  await handleAgentBridgeOptInDisabled()

  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'AGENT_BRIDGE_DISABLED'),
    true
  )
  assert.equal(env.removedTabs.includes(2), true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture reports owned target cleanup failures without leaving capture state', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args)
  env.chrome.tabs.remove = async () => {
    throw new Error('remove failed for bridge target')
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession, getBridgeSession }, { handleAgentBridgeOptInDisabled }, { saveAgentCaptureState, listAgentCaptureIds }] =
    await Promise.all([
      loadTsModule('src/background/agent-bridge-session.ts'),
      loadTsModule('src/background/agent-capture.ts'),
      loadTsModule('src/background/agent-capture-state.ts')
    ])
  try {
    await registerBridgeSession({
      tabId: 1,
      windowId: 1,
      bridgeOrigin: 'http://127.0.0.1:17370',
      sessionId,
      captureId,
      nonce
    })
    await saveAgentCaptureState({
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
      bridgeTabId: 1,
      bridgeWindowId: 1,
      targetTabId: 2,
      targetWindowId: 1,
      targetUrl: 'https://example.com/app?view=one',
      targetMode: 'new_tab',
      createdByCapture: true,
      keepTabOpen: false,
      phase: 'target_loaded',
      status: 'running',
      startedAt: 1,
      updatedAt: 1,
      deadlineAt: Date.now() + 60000
    })

    await handleAgentBridgeOptInDisabled()

    assert.equal(
      env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'AGENT_BRIDGE_DISABLED'),
      true
    )
    assert.deepEqual(await listAgentCaptureIds(), [])
    assert.equal(await getBridgeSession(1), null)
    assert.equal(
      warnings.some(args => args[0] === 'StackPrism agent capture cleanup failed.' && args[1]?.operation === 'cleanupTarget'),
      true
    )
  } finally {
    console.warn = originalWarn
    delete globalThis.chrome
  }
})

test('background local settings change disables running agent captures', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome

  await loadTsModule('src/background/index.ts')
  await new Promise(resolve => setTimeout(resolve, 0))
  const { saveAgentCaptureState, listAgentCaptureIds } = await loadTsModule('src/background/agent-capture-state.ts')
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_loaded',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60000
  })

  assert.equal(env.storageEvents.onChanged.length, 1)
  env.storageEvents.onChanged[0](
    { stackPrismSettings: { newValue: { agentBridgeEnabled: false }, oldValue: { agentBridgeEnabled: true } } },
    'local'
  )

  await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'AGENT_BRIDGE_DISABLED'
  )
  assert.equal(env.removedTabs.includes(2), true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('background local opt-in disable is not delayed by badge refresh', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome

  await loadTsModule('src/background/index.ts')
  await new Promise(resolve => setTimeout(resolve, 0))
  const { saveAgentCaptureState, listAgentCaptureIds } = await loadTsModule('src/background/agent-capture-state.ts')
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_loaded',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60000
  })

  let releaseRefresh
  env.chrome.tabs.query = async () =>
    new Promise(resolve => {
      releaseRefresh = () => resolve(env.tabs)
    })
  env.storageEvents.onChanged[0](
    { stackPrismSettings: { newValue: { agentBridgeEnabled: false }, oldValue: { agentBridgeEnabled: true } } },
    'local'
  )

  try {
    await waitForMessage(
      env.messages,
      message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'AGENT_BRIDGE_DISABLED',
      150
    )
  } finally {
    releaseRefresh?.()
  }
  assert.equal(env.removedTabs.includes(2), true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('background extension lifecycle wake fails active agent captures closed', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome

  await loadTsModule('src/background/index.ts')
  await new Promise(resolve => setTimeout(resolve, 0))
  const { saveAgentCaptureState, listAgentCaptureIds } = await loadTsModule('src/background/agent-capture-state.ts')
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_loaded',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60000
  })

  assert.equal(env.runtimeEvents.onInstalled.length, 1)
  env.runtimeEvents.onInstalled[0]({ reason: 'update' })

  await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'SERVICE_WORKER_RESTARTED'
  )
  await waitForCondition(() =>
    env.executedScripts.some(
      details => details.target?.tabId === 2 && details.files?.some(file => String(file).includes('content-observer'))
    )
  )
  assert.equal(env.removedTabs.includes(2), true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture rejects duplicate start for the same active capture id', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture }, { saveAgentCaptureState }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetUrl: baseRequest.url,
    targetMode: baseRequest.options.targetMode,
    createdByCapture: false,
    keepTabOpen: false,
    phase: 'target_opening',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60_000
  })

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.error.code, 'CAPTURE_BUSY')
  delete globalThis.chrome
})

test('agent capture serializes concurrent starts before target resolution', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  const otherSessionId = identifiers.sessionId.valid[1]
  const otherNonce = identifiers.nonce.valid[1]
  env.tabs.push({
    id: 4,
    windowId: 1,
    url: `http://127.0.0.1:17370/bridge?session=${otherSessionId}&capture=${secondCaptureId}&nonce=${otherNonce}`,
    incognito: false
  })
  await registerBridgeSession({
    tabId: 4,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId: otherSessionId,
    captureId: secondCaptureId,
    nonce: otherNonce
  })
  await connectProfileTransferPort(env, registerAgentProfileTransferPort)

  const startMessage = (id, activeSessionId, activeNonce) => ({
    type: 'START_AGENT_CAPTURE',
    captureId: id,
    sessionId: activeSessionId,
    nonce: activeNonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    request: baseRequest,
    capabilities: { ...fullCapabilities }
  })
  const results = await Promise.all([
    startAgentCapture(startMessage(captureId, sessionId, nonce), {
      url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
      tab: { id: 1, windowId: 1 }
    }),
    startAgentCapture(startMessage(secondCaptureId, otherSessionId, otherNonce), {
      url: `http://127.0.0.1:17370/bridge?session=${otherSessionId}&capture=${secondCaptureId}&nonce=${otherNonce}`,
      tab: { id: 4, windowId: 1 }
    })
  ])

  assert.equal(results.filter(result => result.ok).length, 1)
  assert.equal(results.filter(result => !result.ok && result.error.code === 'CAPTURE_BUSY').length, 1)
  await waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE')
  delete globalThis.chrome
})

test('agent capture waits for profile transfer port before target capture', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  let detectionAttempted = false
  const baseRemove = env.chrome.tabs.remove
  env.chrome.tabs.remove = async id => {
    await baseRemove(id)
    env.tabs.splice(
      env.tabs.findIndex(tab => tab.id === id),
      1
    )
  }
  env.chrome.scripting.executeScript = async () => {
    detectionAttempted = true
    return [{ result: {} }]
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'BRIDGE_TRANSPORT_DISCONNECTED')
  assert.equal(detectionAttempted, false)
  assert.equal(env.removedTabs.includes(2), false)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
  restoreFetch()
})

test('agent capture starts when profile transfer port connects during wait window', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })

  const start = startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  await new Promise(resolve => setTimeout(resolve, 0))
  await connectProfileTransferPort(env, registerAgentProfileTransferPort)
  const response = await start

  assert.equal(response.ok, true)
  await waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE')
  delete globalThis.chrome
  restoreFetch()
})

test('agent capture fails closed when the profile transfer port disconnects', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await connectProfileTransferPort(env, registerAgentProfileTransferPort, {
    disconnectOnMessageType: 'AGENT_PROFILE_TRANSFER_BEGIN'
  })

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'BRIDGE_TRANSPORT_DISCONNECTED'
  )
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
  restoreFetch()
})

test('agent capture stops before detection when bridge blocks final URL', async () => {
  const env = makeChrome()
  let detectionAttempted = false
  env.chrome.tabs.create = async create => {
    const tab = {
      id: 3,
      windowId: 1,
      url: 'https://redirect.internal.example/dashboard',
      title: 'Redirected',
      incognito: false,
      status: 'complete'
    }
    env.tabs.push(tab)
    return tab
  }
  env.chrome.scripting.executeScript = async () => {
    detectionAttempted = true
    return [{ result: {} }]
  }
  env.chrome.tabs.sendMessage = async (_tabId, message) => {
    env.messages.push(message)
    if (message.type === 'AGENT_CAPTURE_STATUS' && message.payload.phase === 'target_loaded') {
      assert.equal(message.payload.targetNetworkAddress, undefined)
      return {
        ok: false,
        error: { code: 'FINAL_URL_BLOCKED', message: 'Final URL blocked.', details: { reason: 'private_network_address' } }
      }
    }
    return { ok: true }
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await connectProfileTransferPort(env, registerAgentProfileTransferPort)

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(
    env.messages.some(
      message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.finalUrl === 'https://redirect.internal.example/dashboard'
    ),
    true
  )
  assert.equal(detectionAttempted, false)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture fails closed when Chrome reports private target network address', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  let detectionAttempted = false
  env.chrome.tabs.create = async create => {
    const tab = { id: 3, windowId: 1, url: create.url, title: 'Target', incognito: false, status: 'loading' }
    env.tabs.push(tab)
    setTimeout(() => {
      for (const listener of env.webRequestEvents.onResponseStarted) {
        listener({
          tabId: 3,
          requestId: 'target-main-frame',
          url: create.url,
          type: 'main_frame',
          method: 'GET',
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          fromCache: false,
          ip: '127.0.0.1'
        })
      }
      tab.status = 'complete'
      for (const listener of env.tabEvents.onUpdated) {
        listener(3, { status: 'complete', url: tab.url }, tab)
      }
    }, 0)
    return tab
  }
  env.chrome.scripting.executeScript = async () => {
    detectionAttempted = true
    return [{ result: {} }]
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts'),
    loadTsModule('src/background/index.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await connectProfileTransferPort(env, registerAgentProfileTransferPort)

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: {
        ...baseRequest,
        include: ['tech'],
        options: { ...baseRequest.options, targetMode: 'new_tab', forceRefresh: false }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const failed = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'PRIVATE_NETWORK_TARGET_BLOCKED'
  )
  assert.equal(failed.payload.error.details.reason, 'private_network_address')
  assert.equal(failed.payload.error.details.address, '127.0.0.1')
  assert.equal(detectionAttempted, false)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture reports sanitized target injection failure details', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  env.chrome.scripting.executeScript = async () => {
    throw new Error(
      'Cannot access https://example.com/app?token=secret&nonce=n_SECRETSECRETSECRETSECRET#frag spb_ABCDEFGHIJKLMNOPQRSTUVWxy123456789012345'
    )
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await connectProfileTransferPort(env, registerAgentProfileTransferPort)

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: {
        ...baseRequest,
        include: ['assets'],
        options: { ...baseRequest.options, forceRefresh: false }
      },
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const failed = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_INJECTION_FAILED'
  )
  assert.equal(failed.payload.error.details.reason.includes('[redacted'), true)
  const serialized = JSON.stringify(failed.payload.error.details)
  assert.equal(serialized.includes('token=secret'), false)
  assert.equal(serialized.includes('nonce='), false)
  assert.equal(serialized.includes('#frag'), false)
  assert.equal(serialized.includes('spb_'), false)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
  restoreFetch()
})

test('agent capture fails when content observer injection fails', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  env.chrome.scripting.executeScript = async options => {
    if (options.files?.[0]?.includes('content-observer')) {
      throw new Error('Cannot inject observer for https://example.com/app?token=secret#frag')
    }
    if (options.files?.[0] === 'injected/page-detector.iife.js') {
      return [{ result: { url: 'https://example.com/app?view=one', technologies: [] } }]
    }
    if (options.files?.[0] === 'injected/experience-profiler.iife.js') {
      return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
    }
    return [{ result: {} }]
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await connectProfileTransferPort(env, registerAgentProfileTransferPort)

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const failed = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_INJECTION_FAILED',
    200
  )
  assert.equal(JSON.stringify(failed.payload.error.details).includes('token=secret'), false)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
  restoreFetch()
})

test('agent capture fails when the observer content script is missing from manifest', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  env.chrome.runtime.getManifest = () => ({
    version: '1.3.71',
    content_scripts: [{ js: ['assets/agent-bridge-client.ts-unit.js'], matches: ['http://127.0.0.1/*'] }]
  })
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await connectProfileTransferPort(env, registerAgentProfileTransferPort)

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const failed = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_INJECTION_FAILED',
    200
  )
  assert.match(failed.payload.error.details.reason, /CONTENT_OBSERVER_NOT_FOUND/)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
  restoreFetch()
})

test('active tab mode and bridge guards fail closed', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const [{ clearBridgeSession, registerBridgeSession }, { startAgentCapture }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts')
  ])
  await clearBridgeSession(1)
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: { ...baseRequest, options: { ...baseRequest.options, targetMode: 'active_tab' } },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )
  assert.equal(response.error.code, 'ACTIVE_TAB_UNAVAILABLE')
  delete globalThis.chrome
})

test('target tab resolution keeps query strings in reuse and active-tab matching', async () => {
  const env = makeChrome()
  env.tabs.find(tab => tab.id === 2).url = 'https://example.com/app?view=two'
  globalThis.chrome = env.chrome
  const [{ validateAgentCaptureRequest }, { resolveTargetTab }] = await Promise.all([
    loadTsModule('src/background/agent-capture-request.ts'),
    loadTsModule('src/background/agent-capture-target.ts')
  ])
  const validated = validateAgentCaptureRequest(baseRequest)
  assert.equal(validated.ok, true)
  const request = validated.request

  const reused = await resolveTargetTab(request, 1)
  assert.equal(reused.ok, true)
  assert.equal(reused.createdByCapture, true)
  assert.equal(reused.tab.url, 'https://example.com/app?view=one')

  env.storage['agent-active-tab:1'] = {
    tabId: 2,
    windowId: 1,
    url: 'https://example.com/app?view=two',
    updatedAt: 1
  }
  const active = await resolveTargetTab({ ...request, options: { ...request.options, targetMode: 'active_tab' } }, 1)
  assert.equal(active.ok, false)
  assert.equal(active.error.code, 'ACTIVE_TAB_MISMATCH')
  delete globalThis.chrome
})

test('active tab mode returns unavailable when the recorded tab was closed', async () => {
  const env = makeChrome()
  env.storage['agent-active-tab:1'] = {
    tabId: 99,
    windowId: 1,
    url: 'https://example.com/app?view=one',
    updatedAt: 1
  }
  env.chrome.tabs.get = async id => {
    if (id === 99) throw new Error('No tab with id: 99.')
    return { id, windowId: 1, url: '', incognito: false }
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: { ...baseRequest, options: { ...baseRequest.options, targetMode: 'active_tab' } },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )
  assert.equal(response.error.code, 'ACTIVE_TAB_UNAVAILABLE')
  delete globalThis.chrome
})

test('new tab mode creates the target in the bridge window and rejects incognito results', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const [{ clearBridgeSession, registerBridgeSession }, { startAgentCapture }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts')
  ])
  await clearBridgeSession(1)
  await registerBridgeSession({
    tabId: 1,
    windowId: 5,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  let createArgs
  env.chrome.tabs.create = async args => {
    createArgs = args
    return { id: 4, windowId: args.windowId, url: args.url, incognito: true, status: 'complete' }
  }

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: {
        ...baseRequest,
        url: 'https://example.com/new-tab',
        options: { ...baseRequest.options, targetMode: 'new_tab' }
      },
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    {
      url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
      tab: { id: 1, windowId: 5, incognito: false }
    }
  )

  assert.equal(createArgs.windowId, 5)
  assert.equal(createArgs.active, false)
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'INCOGNITO_NOT_SUPPORTED')
  assert.deepEqual(env.removedTabs, [4])
  await clearBridgeSession(1)
  delete globalThis.chrome
})

test('agent capture rejects incognito bridge tabs before resolving a target tab', async () => {
  const env = makeChrome()
  let targetResolutionAttempted = false
  env.chrome.tabs.query = async () => {
    targetResolutionAttempted = true
    return env.tabs
  }
  env.chrome.tabs.create = async () => {
    targetResolutionAttempted = true
    return { id: 4, windowId: 9, url: baseRequest.url, incognito: false, status: 'complete' }
  }
  globalThis.chrome = env.chrome
  const [{ clearBridgeSession, registerBridgeSession }, { startAgentCapture }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts')
  ])
  await clearBridgeSession(1)
  await registerBridgeSession({
    tabId: 1,
    windowId: 9,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    {
      url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
      tab: { id: 1, windowId: 9, incognito: true }
    }
  )

  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'INCOGNITO_NOT_SUPPORTED')
  assert.equal(targetResolutionAttempted, false)
  await clearBridgeSession(1)
  delete globalThis.chrome
})

test('active tab tracker updates the recorded URL after active tab navigation completes', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const { registerActiveTabTracker, getPreviousActiveTab } = await loadTsModule('src/background/active-tab-tracker.ts')

  registerActiveTabTracker()
  await env.tabEvents.onActivated[0]({ tabId: 2, windowId: 1 })
  assert.equal((await getPreviousActiveTab(1)).url, 'https://example.com/app?view=one')

  env.tabs.find(tab => tab.id === 2).url = 'https://example.com/app?view=two'
  for (const listener of env.tabEvents.onUpdated) {
    await listener(
      2,
      { status: 'complete', url: 'https://example.com/app?view=two' },
      env.tabs.find(tab => tab.id === 2)
    )
  }

  assert.equal((await getPreviousActiveTab(1)).url, 'https://example.com/app?view=two')
  delete globalThis.chrome
})

test('active tab tracker records an active tab that first becomes detectable after navigation', async () => {
  const env = makeChrome()
  env.tabs.find(tab => tab.id === 2).url = 'chrome://newtab/'
  env.tabs.find(tab => tab.id === 2).active = true
  globalThis.chrome = env.chrome
  const { registerActiveTabTracker, getPreviousActiveTab } = await loadTsModule('src/background/active-tab-tracker.ts')

  registerActiveTabTracker()
  await env.tabEvents.onActivated[0]({ tabId: 2, windowId: 1 })
  assert.equal(await getPreviousActiveTab(1), null)

  env.tabs.find(tab => tab.id === 2).url = 'https://example.com/app?view=later'
  for (const listener of env.tabEvents.onUpdated) {
    await listener(
      2,
      { status: 'complete', url: 'https://example.com/app?view=later' },
      env.tabs.find(tab => tab.id === 2)
    )
  }

  assert.equal((await getPreviousActiveTab(1)).url, 'https://example.com/app?view=later')
  delete globalThis.chrome
})

test('new tab capture waits for target tab load completion before profiling', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  let profiledWhileLoading = false
  env.chrome.tabs.create = async create => {
    const tab = { id: 3, windowId: 1, url: create.url, title: 'Loading target', incognito: false, status: 'loading' }
    env.tabs.push(tab)
    setTimeout(() => {
      tab.status = 'complete'
      tab.title = 'Loaded target'
      for (const listener of env.tabEvents.onUpdated) {
        listener(3, { status: 'complete', url: tab.url }, tab)
      }
    }, 20)
    return tab
  }
  env.chrome.scripting.executeScript = async ({ target }) => {
    if (env.tabs.find(tab => tab.id === target.tabId)?.status !== 'complete') {
      profiledWhileLoading = true
    }
    return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await connectProfileTransferPort(env, registerAgentProfileTransferPort)

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: {
        ...baseRequest,
        include: ['assets'],
        options: { ...baseRequest.options, targetMode: 'new_tab', forceRefresh: false }
      },
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  await waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE')
  assert.equal(profiledWhileLoading, false)
  delete globalThis.chrome
})

test('new tab capture fails immediately when target tab is removed while loading', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  env.chrome.tabs.create = async create => {
    const tab = { id: 3, windowId: 1, url: create.url, incognito: false, status: 'loading' }
    env.tabs.push(tab)
    return tab
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await connectProfileTransferPort(env, registerAgentProfileTransferPort)

  const response = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: {
        ...baseRequest,
        include: ['assets'],
        options: { ...baseRequest.options, targetMode: 'new_tab', forceRefresh: false }
      },
      capabilities: {
        agentBridge: true,
        siteExperienceProfileV1: true,
        profileChunkTransport: true,
        bridgeContentPost: true,
        storageSession: true,
        experienceProfiler: true,
        rawProfile: true,
        viewportMetadata: true
      }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )
  assert.equal(response.ok, true)
  for (const listener of env.tabEvents.onRemoved) listener(3)

  const failed = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_TAB_CLOSED'
  )
  assert.equal(failed.payload.status, 'failed')
  assert.equal(env.tabEvents.onUpdated.length, 0)
  assert.equal(env.tabEvents.onRemoved.length, 0)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
  restoreFetch()
})

test('bridge tab helpers isolate bridge pages and API requests', async () => {
  const { isAgentBridgeRequestUrl, shouldIgnoreBridgeTabEvent } = await loadTsModule('src/background/agent-bridge-tabs.ts')
  const bridgeUrl = `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`
  const bridgeTab = { url: bridgeUrl, incognito: false }
  const ordinaryLocalTab = { url: 'http://127.0.0.1:5173/app', incognito: false }

  assert.equal(isAgentBridgeRequestUrl(bridgeUrl), true)
  assert.equal(isAgentBridgeRequestUrl('http://127.0.0.1:17370/bridge'), false)
  assert.equal(isAgentBridgeRequestUrl('http://127.0.0.1:17370/v1/captures/cap_x/status?token=secret', bridgeTab), true)
  assert.equal(isAgentBridgeRequestUrl('http://127.0.0.1:17370/v1/captures/cap_x/status?token=secret'), false)
  assert.equal(isAgentBridgeRequestUrl('http://127.0.0.1:5173/v1/captures/cap_x/status?token=secret', ordinaryLocalTab), false)
  assert.equal(shouldIgnoreBridgeTabEvent({ url: bridgeUrl, incognito: false }), true)
  assert.equal(shouldIgnoreBridgeTabEvent({ url: bridgeUrl, incognito: true }), true)
  assert.equal(shouldIgnoreBridgeTabEvent({ url: 'http://127.0.0.1:17370/bridge', incognito: false }), false)
  assert.equal(shouldIgnoreBridgeTabEvent({ url: 'https://example.com/', incognito: false }), false)
})

test('background webRequest only skips capture API requests from bridge tabs', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  globalThis.chrome = env.chrome
  globalThis.fetch = async url => {
    if (String(url).endsWith('/rules/index.json')) return new Response(JSON.stringify({ schemaVersion: 1, files: [] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }
  env.tabs[1].url = 'http://127.0.0.1:5173/app'

  const [{ registerBridgeSession }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/index.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  assert.equal(env.webRequestEvents.onHeadersReceived.length, 1)
  const listener = env.webRequestEvents.onHeadersReceived[0]
  listener({
    tabId: 2,
    requestId: 'ordinary-local-api',
    url: 'http://127.0.0.1:5173/v1/captures/cap_x/status?token=secret',
    type: 'fetch',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [{ name: 'x-powered-by', value: 'ordinary-local-api' }]
  })

  const data = await waitForCondition(() => env.storage['tab:2']?.apis?.[0])
  assert.equal(data.url, 'http://127.0.0.1:5173/v1/captures/cap_x/status?token=secret')
  assert.equal(data.allHeaders['x-powered-by'], 'ordinary-local-api')

  listener({
    tabId: 1,
    requestId: 'bridge-api',
    url: 'http://127.0.0.1:17370/v1/captures/cap_x/status?token=secret',
    type: 'fetch',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [{ name: 'x-powered-by', value: 'bridge-api' }]
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(env.storage['tab:1'], undefined)

  delete globalThis.chrome
  restoreFetch()
})

test('background navigation only skips capture API commits from bridge tabs', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const logs = []
  const originalConsoleLog = console.log
  console.log = (...args) => logs.push(args)
  globalThis.chrome = env.chrome
  globalThis.fetch = async url => {
    if (String(url).endsWith('/rules/index.json')) return new Response(JSON.stringify({ schemaVersion: 1, files: [] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }
  env.tabs[1].url = 'http://127.0.0.1:5173/app'

  try {
    const [{ registerBridgeSession }] = await Promise.all([
      loadTsModule('src/background/agent-bridge-session.ts'),
      loadTsModule('src/background/index.ts')
    ])
    await registerBridgeSession({
      tabId: 1,
      windowId: 1,
      bridgeOrigin: 'http://127.0.0.1:17370',
      sessionId,
      captureId,
      nonce
    })
    assert.equal(env.webNavigationEvents.onCommitted.length, 1)
    const listener = env.webNavigationEvents.onCommitted[0]

    env.tabs[0].url = 'http://127.0.0.1:17370/v1/captures/cap_x/status?token=secret'
    listener({
      tabId: 1,
      frameId: 0,
      url: 'http://127.0.0.1:17370/v1/captures/cap_x/status?token=secret',
      transitionType: 'typed'
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(
      logs.some(entry => entry[0] === '[SP detection] webNav committed'),
      false
    )

    listener({
      tabId: 2,
      frameId: 0,
      url: 'http://127.0.0.1:5173/v1/captures/cap_x/status?token=secret',
      transitionType: 'typed'
    })
    await waitForCondition(() => logs.some(entry => entry[0] === '[SP detection] webNav committed'))
  } finally {
    console.log = originalConsoleLog
    delete globalThis.chrome
    restoreFetch()
  }
})

test('ordinary runtime messages from incognito bridge tabs cannot read detection caches', async () => {
  const env = makeChrome()
  const responses = []
  env.tabs[0].incognito = true
  env.chrome.tabs.get = async id => env.tabs.find(tab => tab.id === id) || null
  env.chrome.runtime.onMessage.addListener = listener => {
    listener(
      { type: 'GET_POPUP_RESULT', tabId: 1 },
      {
        tab: {
          id: 1,
          windowId: 1,
          incognito: true,
          url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`
        }
      },
      response => responses.push(response)
    )
  }
  globalThis.chrome = env.chrome
  const { registerMessageRouter } = await loadTsModule('src/background/message-router.ts')

  registerMessageRouter()

  assert.deepEqual(responses, [{ ok: false, error: 'Agent Bridge 页面不能访问普通检测缓存。' }])
  delete globalThis.chrome
})

test('ordinary runtime messages from registered bridge API tabs cannot read detection caches', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const responses = []
  const bridgeApiUrl = 'http://127.0.0.1:17370/v1/captures/cap_x/status?token=secret'
  env.tabs[0].url = bridgeApiUrl
  env.storage['tab:1'] = { page: { url: bridgeApiUrl, title: 'Bridge API' }, updatedAt: Date.now() }
  env.chrome.tabs.get = async id => env.tabs.find(tab => tab.id === id) || null
  env.chrome.runtime.onMessage.addListener = listener => {
    listener({ type: 'GET_POPUP_RESULT', tabId: 1 }, { tab: { id: 1, windowId: 1, incognito: false, url: bridgeApiUrl } }, response =>
      responses.push(response)
    )
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { registerMessageRouter }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/message-router.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })

  registerMessageRouter()
  await waitForCondition(() => responses.length > 0)

  assert.deepEqual(responses, [{ ok: false, error: 'Agent Bridge 页面不能访问普通检测缓存。' }])
  assert.equal(env.storage['tab:1'].page.title, 'Bridge API')
  delete globalThis.chrome
  restoreFetch()
})

test('popup runtime messages cannot read registered bridge API tabs', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const responses = []
  const bridgeApiUrl = 'http://127.0.0.1:17370/v1/captures/cap_x/profile?token=secret'
  env.tabs[0].url = bridgeApiUrl
  env.storage['tab:1'] = { page: { url: bridgeApiUrl, title: 'Bridge API' }, updatedAt: Date.now() }
  env.chrome.tabs.get = async id => env.tabs.find(tab => tab.id === id) || null
  env.chrome.runtime.onMessage.addListener = listener => {
    listener({ type: 'GET_HEADER_DATA', tabId: 1 }, { url: 'chrome-extension://stackprism/src/ui/popup/index.html' }, response =>
      responses.push(response)
    )
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { registerMessageRouter }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/message-router.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })

  registerMessageRouter()
  await waitForCondition(() => responses.length > 0)

  assert.deepEqual(responses, [{ ok: false, error: 'Error: Agent Bridge 页面不能访问普通检测缓存。' }])
  assert.equal(env.storage['tab:1'].page.title, 'Bridge API')
  delete globalThis.chrome
  restoreFetch()
})

test('registered bridge API tabs cannot trigger ordinary background detection', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const responses = []
  const bridgeApiUrl = 'http://127.0.0.1:17370/v1/captures/cap_x/status?token=secret'
  env.tabs[0].url = bridgeApiUrl
  env.storage['tab:1'] = { page: { url: bridgeApiUrl, title: 'Bridge API' }, updatedAt: Date.now() }
  env.chrome.tabs.get = async id => env.tabs.find(tab => tab.id === id) || null
  env.chrome.runtime.onMessage.addListener = listener => {
    listener(
      { type: 'START_BACKGROUND_DETECTION', tabId: 1 },
      { tab: { id: 1, windowId: 1, incognito: false, url: bridgeApiUrl } },
      response => responses.push(response)
    )
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { registerMessageRouter }] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/message-router.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })

  registerMessageRouter()
  await waitForCondition(() => responses.length > 0)

  assert.deepEqual(responses, [{ ok: false, error: 'Agent Bridge 页面不能访问普通检测缓存。' }])
  assert.equal(env.storage['tab:1'].page.title, 'Bridge API')
  delete globalThis.chrome
  restoreFetch()
})

test('storage session availability and deadline reconciliation are fail closed', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const { assertStorageSessionAvailable, reconcileAgentCaptureDeadlines, saveAgentCaptureState, getAgentCaptureState } = await loadTsModule(
    'src/background/agent-capture-state.ts'
  )

  assert.equal(assertStorageSessionAvailable().ok, true)
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: 'http://127.0.0.1:17370/bridge',
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetUrl: 'https://example.com/',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_opening',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: 2
  })
  await reconcileAgentCaptureDeadlines(3)
  const targetOpeningExpired = await getAgentCaptureState(captureId)
  assert.equal(targetOpeningExpired.status, 'failed')
  assert.equal(targetOpeningExpired.error.code, 'TARGET_LOAD_TIMEOUT')
  await saveAgentCaptureState({
    captureId: secondCaptureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: 'http://127.0.0.1:17370/bridge',
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetUrl: 'https://example.com/',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'cleanup',
    status: 'cancel_requested',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: 100,
    cancelDeadlineAt: 4
  })
  await reconcileAgentCaptureDeadlines(5)
  const cancelled = await getAgentCaptureState(secondCaptureId)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.error.details.reason, 'cancel_timeout')
  await saveAgentCaptureState({
    captureId: 'cap_profileTimeoutState001',
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: 'http://127.0.0.1:17370/bridge',
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetUrl: 'https://example.com/',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'posting_profile',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: 100,
    profileTransferDeadlineAt: 6
  })
  await reconcileAgentCaptureDeadlines(7)
  const profileTransferExpired = await getAgentCaptureState('cap_profileTimeoutState001')
  assert.equal(profileTransferExpired.status, 'failed')
  assert.equal(profileTransferExpired.error.code, 'PROFILE_TRANSPORT_FAILED')
  assert.equal(profileTransferExpired.error.details.reason, 'profile_transfer_timeout')
  env.storage['agent-capture:index'] = [captureId]
  env.storage[`agent-capture:${captureId}`] = {
    captureId,
    sessionId,
    nonce,
    status: 'running',
    phase: 'target_opening',
    deadlineAt: 'not-a-number'
  }
  assert.equal(await getAgentCaptureState(captureId), null)
  assert.deepEqual(env.storage['agent-capture:index'], [])
  assert.equal(env.storage[`agent-capture:${captureId}`], undefined)
  assert.equal(JSON.stringify(env.storage).includes('bridgeToken'), false)
  delete globalThis.chrome
})

test('agent capture control paths check storage session capability before reconciliation', async () => {
  const env = makeChrome()
  delete env.chrome.storage.session
  globalThis.chrome = env.chrome
  const { startAgentCapture, cancelAgentCapture } = await loadTsModule('src/background/agent-capture.ts')

  const start = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: baseRequest,
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )
  const cancel = await cancelAgentCapture(
    { type: 'AGENT_CAPTURE_CONTROL', captureId, sessionId, nonce, command: 'cancel' },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(start.error.code, 'NOT_SUPPORTED')
  assert.equal(start.error.details.missingCapability, 'storageSession')
  assert.equal(cancel.error.code, 'NOT_SUPPORTED')
  assert.equal(cancel.error.details.missingCapability, 'storageSession')
  delete globalThis.chrome
})

test('agent capture reconciles expired captures with bridge notification and owned target cleanup', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ recoverInterruptedAgentCaptures }, { saveAgentCaptureState, listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_loaded',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: 2
  })

  await recoverInterruptedAgentCaptures()

  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'CAPTURE_TIMEOUT'),
    true
  )
  assert.equal(env.removedTabs.includes(2), true)
  assert.equal((await listAgentCaptureIds()).includes(captureId), false)
  delete globalThis.chrome
})

test('agent capture cancel control closes owned target tab and removes state', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ cancelAgentCapture }, { registerBridgeSession }, { saveAgentCaptureState, listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_opening',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60000
  })

  const response = await cancelAgentCapture(
    { type: 'AGENT_CAPTURE_CONTROL', captureId, sessionId, nonce, command: 'cancel' },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  assert.deepEqual(env.removedTabs, [2])
  assert.equal((await listAgentCaptureIds()).includes(captureId), false)
  const cancelled = env.messages.find(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.status === 'cancelled')
  assert.ok(cancelled)
  assert.equal(cancelled.payload.error, undefined)
  delete globalThis.chrome
})

test('agent capture cancel reports owned target cleanup failures without leaving capture state', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args)
  env.chrome.tabs.remove = async () => {
    throw new Error('remove failed for cancel cleanup')
  }
  globalThis.chrome = env.chrome
  const [{ cancelAgentCapture }, { registerBridgeSession, getBridgeSession }, { saveAgentCaptureState, listAgentCaptureIds }] =
    await Promise.all([
      loadTsModule('src/background/agent-capture.ts'),
      loadTsModule('src/background/agent-bridge-session.ts'),
      loadTsModule('src/background/agent-capture-state.ts')
    ])
  try {
    await registerBridgeSession({
      tabId: 1,
      windowId: 1,
      bridgeOrigin: 'http://127.0.0.1:17370',
      sessionId,
      captureId,
      nonce
    })
    await saveAgentCaptureState({
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
      bridgeTabId: 1,
      bridgeWindowId: 1,
      targetTabId: 2,
      targetWindowId: 1,
      targetUrl: 'https://example.com/app?view=one',
      targetMode: 'new_tab',
      createdByCapture: true,
      keepTabOpen: false,
      phase: 'target_opening',
      status: 'running',
      startedAt: 1,
      updatedAt: 1,
      deadlineAt: Date.now() + 60000
    })

    const response = await cancelAgentCapture(
      { type: 'AGENT_CAPTURE_CONTROL', captureId, sessionId, nonce, command: 'cancel' },
      { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
    )

    assert.equal(response.ok, true)
    assert.equal((await listAgentCaptureIds()).includes(captureId), false)
    assert.equal(await getBridgeSession(1), null)
    assert.equal(
      warnings.some(args => args[0] === 'StackPrism agent capture cleanup failed.' && args[1]?.operation === 'cleanupTarget'),
      true
    )
  } finally {
    console.warn = originalWarn
    delete globalThis.chrome
  }
})

test('agent capture cancel reports state removal failures and still clears bridge session', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args)
  const baseRemove = env.chrome.storage.session.remove
  env.chrome.storage.session.remove = async keys => {
    const keyList = Array.isArray(keys) ? keys : [keys]
    if (keyList.includes(`agent-capture:${captureId}`)) throw new Error('state remove failed for cancel cleanup')
    return baseRemove(keys)
  }
  globalThis.chrome = env.chrome
  const [{ cancelAgentCapture }, { registerBridgeSession, getBridgeSession }, { saveAgentCaptureState, getAgentCaptureState }] =
    await Promise.all([
      loadTsModule('src/background/agent-capture.ts'),
      loadTsModule('src/background/agent-bridge-session.ts'),
      loadTsModule('src/background/agent-capture-state.ts')
    ])
  try {
    await registerBridgeSession({
      tabId: 1,
      windowId: 1,
      bridgeOrigin: 'http://127.0.0.1:17370',
      sessionId,
      captureId,
      nonce
    })
    await saveAgentCaptureState({
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
      bridgeTabId: 1,
      bridgeWindowId: 1,
      targetTabId: 2,
      targetWindowId: 1,
      targetUrl: 'https://example.com/app?view=one',
      targetMode: 'new_tab',
      createdByCapture: true,
      keepTabOpen: false,
      phase: 'target_opening',
      status: 'running',
      startedAt: 1,
      updatedAt: 1,
      deadlineAt: Date.now() + 60000
    })

    const response = await cancelAgentCapture(
      { type: 'AGENT_CAPTURE_CONTROL', captureId, sessionId, nonce, command: 'cancel' },
      { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
    )

    assert.equal(response.ok, true)
    assert.equal((await getAgentCaptureState(captureId)).status, 'cancelled')
    assert.equal(await getBridgeSession(1), null)
    assert.equal(
      warnings.some(args => args[0] === 'StackPrism agent capture cleanup failed.' && args[1]?.operation === 'removeAgentCaptureState'),
      true
    )
  } finally {
    console.warn = originalWarn
    delete globalThis.chrome
  }
})

test('agent capture cancel reports bridge status post failures without leaking cleanup state', async () => {
  const env = makeChrome()
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args)
  env.chrome.tabs.sendMessage = async (_tabId, message) => {
    env.messages.push(message)
    if (message.type === 'AGENT_CAPTURE_STATUS') {
      return {
        ok: false,
        error: {
          code: 'BRIDGE_TRANSPORT_DISCONNECTED',
          message: 'transport failed token=secret',
          details: { url: 'http://127.0.0.1:17370/bridge?token=secret#frag' }
        }
      }
    }
    return { ok: true }
  }
  globalThis.chrome = env.chrome
  const [{ cancelAgentCapture }, { registerBridgeSession, getBridgeSession }, { saveAgentCaptureState, listAgentCaptureIds }] =
    await Promise.all([
      loadTsModule('src/background/agent-capture.ts'),
      loadTsModule('src/background/agent-bridge-session.ts'),
      loadTsModule('src/background/agent-capture-state.ts')
    ])
  try {
    await registerBridgeSession({
      tabId: 1,
      windowId: 1,
      bridgeOrigin: 'http://127.0.0.1:17370',
      sessionId,
      captureId,
      nonce
    })
    await saveAgentCaptureState({
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
      bridgeTabId: 1,
      bridgeWindowId: 1,
      targetTabId: 2,
      targetWindowId: 1,
      targetUrl: 'https://example.com/app?view=one',
      targetMode: 'new_tab',
      createdByCapture: true,
      keepTabOpen: false,
      phase: 'target_opening',
      status: 'running',
      startedAt: 1,
      updatedAt: 1,
      deadlineAt: Date.now() + 60000
    })

    const response = await cancelAgentCapture(
      { type: 'AGENT_CAPTURE_CONTROL', captureId, sessionId, nonce, command: 'cancel' },
      { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
    )

    assert.equal(response.ok, true)
    assert.equal(env.removedTabs.includes(2), true)
    assert.equal((await listAgentCaptureIds()).includes(captureId), false)
    assert.equal(await getBridgeSession(1), null)
    assert.equal(
      warnings.some(args => args[0] === 'StackPrism agent capture cleanup failed.' && args[1]?.operation === 'postCaptureStatusToBridge'),
      true
    )
    assert.equal(JSON.stringify(warnings).includes('token=secret'), false)
    assert.equal(JSON.stringify(warnings).includes('#frag'), false)
  } finally {
    console.warn = originalWarn
    delete globalThis.chrome
  }
})

test('agent capture reports target tab closure and clears capture state', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ handleAgentCaptureTabRemoved }, { saveAgentCaptureState, listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_loaded',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60000
  })

  await handleAgentCaptureTabRemoved(2)

  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_TAB_CLOSED'),
    true
  )
  assert.equal(env.removedTabs.includes(2), true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture reports target navigation away before profile delivery', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ handleAgentCaptureTabNavigation }, { saveAgentCaptureState, listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    finalUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_loaded',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60000
  })

  await handleAgentCaptureTabNavigation(2, 'https://example.com/app?view=two')

  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_NAVIGATED_AWAY'),
    true
  )
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture reports target main-frame load failure', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ handleAgentCaptureNavigationError }, { saveAgentCaptureState, listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_opening',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60000
  })

  await handleAgentCaptureNavigationError(2, 0)

  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_LOAD_FAILED'),
    true
  )
  assert.equal(env.removedTabs.includes(2), true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('target tab load timeout fires before the global capture deadline', async () => {
  const env = makeChrome()
  const targetTab = env.tabs.find(tab => tab.id === 2)
  targetTab.status = 'loading'
  globalThis.chrome = env.chrome
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let recordedDelay = -1
  globalThis.setTimeout = (_callback, delay) => {
    recordedDelay = Number(delay)
    return { fakeTimer: true }
  }
  globalThis.clearTimeout = () => {}
  resetLoadTsModuleCaches()
  try {
    const { waitForTargetTabLoaded } = await loadTsModule('src/background/agent-capture-target.ts')
    const waiting = waitForTargetTabLoaded(2, Date.now() + 60000)
    await Promise.resolve()

    assert(recordedDelay >= 54000, `Target load timeout fired too early: ${recordedDelay}`)
    assert(recordedDelay <= 55000, `Target load timeout did not leave bridge reporting grace: ${recordedDelay}`)

    env.tabEvents.onRemoved[0](2)
    await assert.rejects(waiting, /TARGET_TAB_CLOSED/)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('agent capture restart recovery fails closed and notifies bridge tab when possible', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ recoverInterruptedAgentCaptures }, { saveAgentCaptureState, listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_loaded',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60000
  })

  await recoverInterruptedAgentCaptures()

  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'SERVICE_WORKER_RESTARTED'),
    true
  )
  assert.equal(env.removedTabs.includes(2), true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture recovery does not fake restore when storage session was cleared', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ recoverInterruptedAgentCaptures }, { listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])

  env.storage['agent-capture:index'] = []

  await recoverInterruptedAgentCaptures()

  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS'),
    false
  )
  assert.deepEqual(env.removedTabs, [])
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('bridge tab closure fails closed and clears owned target tab without fake success', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ handleAgentCaptureTabRemoved }, { saveAgentCaptureState, listAgentCaptureIds }] = await Promise.all([
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts')
  ])
  await saveAgentCaptureState({
    captureId,
    sessionId,
    nonce,
    bridgeOrigin: 'http://127.0.0.1:17370',
    bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
    bridgeTabId: 1,
    bridgeWindowId: 1,
    targetTabId: 2,
    targetWindowId: 1,
    targetUrl: 'https://example.com/app?view=one',
    targetMode: 'new_tab',
    createdByCapture: true,
    keepTabOpen: false,
    phase: 'target_loaded',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60000
  })

  await handleAgentCaptureTabRemoved(1)

  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS'),
    false
  )
  assert.equal(env.removedTabs.includes(2), true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})
