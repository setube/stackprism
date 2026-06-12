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
  viewportMetadata: true,
  visualScreenshot: true
}

test('script file load classifier ignores runtime not found errors', async () => {
  resetLoadTsModuleCaches()
  const { isScriptFileLoadError } = await loadTsModule('src/background/script-injection-errors.ts')

  assert.equal(isScriptFileLoadError('Unable to load script: injected/page-detector.iife.js'), true)
  assert.equal(isScriptFileLoadError('Error: file not found: injected/page-detector.iife.js'), true)
  assert.equal(isScriptFileLoadError("NotFoundError: Failed to execute 'removeChild' on 'Node': node was not found."), false)
  assert.equal(isScriptFileLoadError(new Error('ReferenceError: detector registry not found')), false)

  resetLoadTsModuleCaches()
})

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
  const permissionsEvents = {
    onRemoved: []
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
    permissionsEvents,
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
      permissions: {
        onRemoved: {
          addListener: listener => permissionsEvents.onRemoved.push(listener)
        }
      },
      tabs: {
        query: async () => tabs,
        get: async id => {
          const tab = tabs.find(item => item.id === id)
          if (!tab) throw new Error('TAB_NOT_FOUND')
          return tab
        },
        update: async (id, update) => {
          const tab = tabs.find(item => item.id === id)
          if (!tab) throw new Error('TAB_NOT_FOUND')
          if (update.active === true) {
            for (const item of tabs) {
              if (item.windowId === tab.windowId) item.active = item.id === id
            }
          } else if (update.active !== undefined) {
            tab.active = update.active
          }
          if (update.url !== undefined) tab.url = update.url
          return tab
        },
        create: async create => {
          const tab = { id: 3, windowId: 1, url: create.url, incognito: false, status: 'complete' }
          tabs.push(tab)
          return tab
        },
        reload: async tabId => {
          const tab = tabs.find(item => item.id === tabId)
          if (!tab) throw new Error('TAB_NOT_FOUND')
          queueMicrotask(() => {
            for (const listener of webRequestEvents.onResponseStarted) {
              listener({
                tabId,
                requestId: `reload-${tabId}`,
                url: tab.url,
                type: 'main_frame',
                method: 'GET',
                statusCode: 200,
                statusLine: 'HTTP/1.1 200 OK',
                fromCache: false,
                ip: '93.184.216.34'
              })
            }
            tab.status = 'loading'
            for (const listener of tabEvents.onUpdated) {
              listener(tabId, { status: 'loading', url: tab.url }, tab)
            }
            tab.status = 'complete'
            for (const listener of tabEvents.onUpdated) {
              listener(tabId, { status: 'complete', url: tab.url }, tab)
            }
          })
        },
        remove: async id => {
          const index = tabs.findIndex(tab => tab.id === id)
          if (index < 0) throw new Error('TAB_NOT_FOUND')
          removedTabs.push(id)
          tabs.splice(index, 1)
        },
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
      if (options.syncAck) {
        backgroundListeners.forEach(listener => listener(ack))
      } else {
        queueMicrotask(() => backgroundListeners.forEach(listener => listener(ack)))
      }
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

test('unit chrome tab mock removes tabs and rejects missing tab reads', async () => {
  const env = makeChrome()

  await env.chrome.tabs.remove(2)

  assert.equal(env.removedTabs.includes(2), true)
  assert.equal(env.tabs.some(tab => tab.id === 2), false)
  await assert.rejects(env.chrome.tabs.get(2), /TAB_NOT_FOUND/)
})

test('cleanupTarget preserves reused tabs and still cleans capture-owned tabs', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const [{ cleanupTarget }, { storageKey, popupStorageKey }] = await Promise.all([
    loadTsModule('src/background/agent-capture-target.ts'),
    loadTsModule('src/background/tab-store.ts')
  ])

  env.storage[storageKey(2)] = { cached: true }
  env.storage[popupStorageKey(2)] = { cached: true }
  await cleanupTarget({ targetTabId: 2, createdByCapture: false, keepTabOpen: false })
  assert.equal(env.removedTabs.includes(2), false)
  assert.deepEqual(env.storage[storageKey(2)], { cached: true })
  assert.deepEqual(env.storage[popupStorageKey(2)], { cached: true })

  env.tabs.push({ id: 3, windowId: 1, url: 'https://example.com/three', incognito: false, status: 'complete' })
  env.storage[storageKey(3)] = { cached: true }
  env.storage[popupStorageKey(3)] = { cached: true }
  await cleanupTarget({ targetTabId: 3, createdByCapture: true, keepTabOpen: true })
  assert.equal(env.removedTabs.includes(3), false)
  assert.equal(env.storage[storageKey(3)], undefined)
  assert.equal(env.storage[popupStorageKey(3)], undefined)
  delete globalThis.chrome
})

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

test('experience profiler falls back to inline function when firefox cannot load script files', async () => {
  const calls = []
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const originalMatchMedia = globalThis.matchMedia
  const button = {
    tagName: 'BUTTON',
    textContent: 'Authorization: Bearer sk_live_abc123 token=secret password=hunter2 user@example.com +1 415 555 1212',
    getAttribute: name => (name === 'role' ? 'button' : ''),
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 120, height: 32 })
  }
  const asset = {
    tagName: 'IMG',
    currentSrc: 'https://cdn.example.com/account/sessionId/secretToken/Abcd1234EFGH5678ijkl9012.png?token=secret#frag',
    src: '',
    href: '',
    getAttribute: () => '',
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 })
  }
  globalThis.document = {
    documentElement: { lang: 'en' },
    body: { textContent: button.textContent, getAttribute: () => '' },
    querySelectorAll: selector => {
      if (selector === 'body *') return [button, asset]
      if (selector === 'img[src], script[src], link[href]') return [asset]
      if (selector === 'button') return [button]
      return []
    }
  }
  globalThis.window = { innerWidth: 1440, innerHeight: 900 }
  globalThis.matchMedia = () => ({ matches: false })
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'https://example.com/base/' }
  })
  globalThis.chrome = {
    scripting: {
      executeScript: async options => {
        calls.push(options)
        if (options.files?.[0] === 'injected/experience-profiler.iife.js') {
          return [{ error: 'Unable to load script: <anonymous code>' }]
        }
        if (options.func?.name === 'collectInlineExperienceProfile') {
          return [{ result: options.func(options.args?.[0]) }]
        }
        if (typeof options.func === 'function' && options.world === 'MAIN') {
          return [{ result: null }]
        }
        return [{ result: null }]
      }
    }
  }

  try {
    const { executeExperienceProfiler } = await loadTsModule('src/background/agent-capture-target.ts')

    const result = await executeExperienceProfiler(42, { captureScreenshotMetadata: false })

    assert.ok(result.visual)
    assert.deepEqual(calls.map(call => call.files?.[0]).filter(Boolean), ['injected/experience-profiler.iife.js'])
    assert.equal(calls.filter(call => typeof call.func === 'function' && call.world === 'MAIN').length, 3)
    const serialized = JSON.stringify(result)
    assert.doesNotMatch(serialized, /Bearer|sk_live_abc123|token=secret|password=hunter2|user@example\.com|555 1212/)
    assert.doesNotMatch(result.assets.urls[0], /sessionId|secretToken|Abcd1234EFGH5678ijkl9012|#frag/)
    assert.equal('rect' in result.components.samples[0], false)
    assert.match(serialized, /\[redacted\]|%5Bredacted%5D/)
  } finally {
    delete globalThis.chrome
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalMatchMedia === undefined) delete globalThis.matchMedia
    else globalThis.matchMedia = originalMatchMedia
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation)
    else delete globalThis.location
  }
})

test('experience profiler inline fallback includes rects only when metadata is requested', async () => {
  const calls = []
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const originalMatchMedia = globalThis.matchMedia
  const nav = {
    tagName: 'NAV',
    textContent: 'Primary nav',
    getAttribute: () => '',
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 300, height: 40 })
  }
  globalThis.document = {
    documentElement: { lang: 'en' },
    body: { textContent: nav.textContent, getAttribute: () => '' },
    querySelectorAll: selector => {
      if (selector === 'body *') return [nav]
      if (selector === 'nav') return [nav]
      return []
    }
  }
  globalThis.window = { innerWidth: 1440, innerHeight: 900 }
  globalThis.matchMedia = () => ({ matches: false })
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'https://example.com/base/' }
  })
  globalThis.chrome = {
    scripting: {
      executeScript: async options => {
        calls.push(options)
        if (options.files?.[0] === 'injected/experience-profiler.iife.js') {
          return [{ error: 'Unable to load script: <anonymous code>' }]
        }
        if (options.func?.name === 'collectInlineExperienceProfile') {
          return [{ result: options.func(options.args?.[0]) }]
        }
        return [{ result: null }]
      }
    }
  }

  try {
    const { executeExperienceProfiler } = await loadTsModule('src/background/agent-capture-target.ts')

    const result = await executeExperienceProfiler(42, { captureScreenshotMetadata: true })

    assert.deepEqual(calls.find(call => call.func?.name === 'collectInlineExperienceProfile')?.args, [{ captureScreenshotMetadata: true }])
    assert.deepEqual(result.components.samples[0].rect, { x: 10, y: 20, width: 300, height: 40 })
    assert.deepEqual(result.layout.landmarks[0].rect, { x: 10, y: 20, width: 300, height: 40 })
  } finally {
    delete globalThis.chrome
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalMatchMedia === undefined) delete globalThis.matchMedia
    else globalThis.matchMedia = originalMatchMedia
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation)
    else delete globalThis.location
  }
})

test('experience profiler does not use inline fallback for runtime profiler errors', async () => {
  const calls = []
  globalThis.chrome = {
    scripting: {
      executeScript: async options => {
        calls.push(options)
        if (options.files?.[0] === 'injected/experience-profiler.iife.js') {
          return [{ error: 'ReferenceError: profiler regression' }]
        }
        return [{ result: null }]
      }
    }
  }

  try {
    const { executeExperienceProfiler } = await loadTsModule('src/background/agent-capture-target.ts')

    await assert.rejects(() => executeExperienceProfiler(42, { captureScreenshotMetadata: false }), /profiler regression/)
    assert.equal(calls.some(call => call.func?.name === 'collectInlineExperienceProfile'), false)
  } finally {
    delete globalThis.chrome
  }
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

const waitForProfileTransferComplete = env =>
  waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE')

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

test('agent capture network validation explains unverified browser evidence', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const { registerAgentCaptureNetworkObserver, validateAgentCaptureNetwork } = await loadTsModule('src/background/agent-capture-network.ts')
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

  const missing = validateAgentCaptureNetwork(state, baseRequest)
  assert.equal(missing, null)

  const stale = validateAgentCaptureNetwork(
    { ...state, targetNetwork: { url: baseRequest.url, ip: '93.184.216.34', fromCache: false, observedAt: state.startedAt - 1 } },
    baseRequest
  )
  assert.equal(stale, null)

  const mismatched = validateAgentCaptureNetwork(
    { ...state, targetNetwork: { url: 'https://example.com/other', ip: '93.184.216.34', fromCache: false, observedAt: Date.now() } },
    baseRequest
  )
  assert.equal(mismatched, null)

  const cached = validateAgentCaptureNetwork(
    { ...state, targetNetwork: { url: baseRequest.url, ip: '93.184.216.34', fromCache: true, observedAt: Date.now() } },
    baseRequest
  )
  assert.equal(cached, null)

  const missingAddress = validateAgentCaptureNetwork(
    { ...state, targetNetwork: { url: baseRequest.url, fromCache: false, observedAt: Date.now() } },
    baseRequest
  )
  assert.equal(missingAddress, null)

  const privateNetworkState = {
    ...state,
    targetNetwork: { url: baseRequest.url, ip: '127.0.0.1', fromCache: false, observedAt: Date.now() }
  }
  const privateRequest = {
    ...baseRequest,
    options: { ...baseRequest.options, allowPrivateNetworkTarget: true }
  }
  assert.equal(validateAgentCaptureNetwork(privateNetworkState, privateRequest).code, 'PRIVATE_NETWORK_TARGET_BLOCKED')
  assert.equal(
    validateAgentCaptureNetwork(privateNetworkState, baseRequest, { allowAllNetworkTargets: true }).code,
    'PRIVATE_NETWORK_TARGET_BLOCKED'
  )
  assert.equal(validateAgentCaptureNetwork(privateNetworkState, privateRequest, { allowAllNetworkTargets: true }), null)
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

test('agent capture can attach optional visible viewport screenshot evidence', async () => {
  const env = makeChrome()
  const screenshotDataUrl = `data:image/jpeg;base64,${Buffer.from('visible viewport').toString('base64')}`
  env.tabs[0].active = true
  env.tabs[1].active = false
  env.chrome.tabs.captureVisibleTab = async (windowId, options) => {
    assert.equal(windowId, 1)
    assert.deepEqual(options, { format: 'jpeg', quality: 72 })
    assert.equal(env.tabs.find(tab => tab.id === 3).active, true)
    return screenshotDataUrl
  }
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
        options: { ...baseRequest.options, targetMode: 'new_tab', captureScreenshot: true }
      },
      capabilities: fullCapabilities
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  await waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE')
  const profile = decodeTransferredProfile(env.messages)
  assert.equal(profile.visualProfile.screenshot.dataUrl, screenshotDataUrl)
  assert.equal(profile.visualProfile.screenshot.mimeType, 'image/jpeg')
  assert.equal(profile.visualProfile.screenshot.scope, 'visible_viewport')
  assert.equal(profile.browserContext.extensionCapabilities.visualScreenshot, true)
  assert.equal(env.tabs.find(tab => tab.id === 1).active, true)
  delete globalThis.chrome
  restoreFetch()
})

test('screenshot size cap uses decoded image bytes instead of data URL text length', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const maxDecodedBytes = 2 * 1024 * 1024
  const screenshotDataUrl = `data:image/jpeg;base64,${Buffer.alloc(maxDecodedBytes).toString('base64')}`
  env.tabs[1].active = true
  env.chrome.tabs.captureVisibleTab = async () => screenshotDataUrl
  globalThis.chrome = env.chrome

  const { captureVisibleViewportScreenshot } = await loadTsModule('src/background/agent-capture-target.ts')
  const result = await captureVisibleViewportScreenshot(2, 1)

  assert.equal(result.limitations.includes('screenshot_image_too_large'), false)
  assert.equal(result.screenshot?.dataUrl, screenshotDataUrl)
  assert.equal(result.screenshot?.byteLength, maxDecodedBytes)
  delete globalThis.chrome
})

test('agent capture stops if capture is cancelled while optional screenshot is pending', async () => {
  const env = makeChrome()
  const screenshotDataUrl = `data:image/jpeg;base64,${Buffer.from('late viewport').toString('base64')}`
  let resolveScreenshot
  let screenshotStarted = false
  env.tabs[0].active = true
  env.tabs[1].active = false
  env.chrome.tabs.captureVisibleTab = async () => {
    screenshotStarted = true
    return new Promise(resolve => {
      resolveScreenshot = resolve
    })
  }
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, cancelAgentCapture, registerAgentProfileTransferPort }, { listAgentCaptureIds }] =
    await Promise.all([
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
        options: { ...baseRequest.options, targetMode: 'new_tab', captureScreenshot: true }
      },
      capabilities: fullCapabilities
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  await waitForCondition(() => screenshotStarted)
  const cancel = await cancelAgentCapture(
    { type: 'AGENT_CAPTURE_CONTROL', captureId, sessionId, nonce, command: 'cancel' },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(cancel.ok, true)
  assert.equal((await listAgentCaptureIds()).includes(captureId), false)
  resolveScreenshot(screenshotDataUrl)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(env.messages.some(message => message.type?.startsWith('AGENT_PROFILE_TRANSFER_')), false)
  assert.equal((await listAgentCaptureIds()).includes(captureId), false)
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

test('agent capture rechecks browser data consent before resolving target tabs', async () => {
  const env = makeChrome()
  let targetResolutionAttempted = false
  const getManifest = env.chrome.runtime.getManifest
  env.chrome.runtime.getManifest = () => ({
    ...getManifest(),
    browser_specific_settings: {
      gecko: {
        data_collection_permissions: {
          optional: ['browsingActivity', 'technicalAndInteraction', 'websiteContent']
        }
      }
    }
  })
  env.chrome.permissions = {
    getAll: async () => ({ data_collection: ['browsingActivity', 'websiteContent'] }),
    request: async () => false
  }
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
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'AGENT_BRIDGE_DISABLED')
  assert.equal(targetResolutionAttempted, false)
  assert.equal(await getBridgeSession(1), null)
  delete globalThis.chrome
})

test('agent capture blocks unsafe target URLs before resolving target tabs', async () => {
  const env = makeChrome()
  let targetResolutionAttempted = false
  env.chrome.tabs.query = async () => {
    targetResolutionAttempted = true
    return env.tabs
  }
  env.chrome.tabs.create = async create => {
    targetResolutionAttempted = true
    return { id: 3, windowId: 1, url: create.url, incognito: true, status: 'complete' }
  }
  globalThis.chrome = env.chrome
  const [{ getBridgeSession, registerBridgeSession }, { startAgentCapture }, { listAgentCaptureIds }, { applyDetectorSettingsUpdate }] =
    await Promise.all([
      loadTsModule('src/background/agent-bridge-session.ts'),
      loadTsModule('src/background/agent-capture.ts'),
      loadTsModule('src/background/agent-capture-state.ts'),
      loadTsModule('src/background/detector-settings.ts')
    ])
  const blockedTargets = [
    { url: 'http://127.0.0.1:18080/admin', code: 'PRIVATE_NETWORK_TARGET_BLOCKED' },
    { url: 'http://localhost:18080/admin', code: 'PRIVATE_NETWORK_TARGET_BLOCKED' },
    { url: 'http://192.168.1.2/admin', code: 'PRIVATE_NETWORK_TARGET_BLOCKED' },
    {
      url: 'http://127.0.0.1:18080/admin',
      code: 'PRIVATE_NETWORK_TARGET_BLOCKED',
      options: { allowPrivateNetworkTarget: true }
    },
    {
      url: 'http://internal.example.test/admin',
      code: 'PRIVATE_NETWORK_TARGET_BLOCKED',
      options: { allowPrivateNetworkTarget: true }
    },
    {
      url: 'http://127.0.0.1:17370/v1/captures',
      code: 'BRIDGE_SELF_TARGET_BLOCKED',
      options: { allowPrivateNetworkTarget: true }
    }
  ]

  for (const target of blockedTargets) {
    targetResolutionAttempted = false
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
        request: {
          ...baseRequest,
          url: target.url,
          options: { ...baseRequest.options, targetMode: 'new_tab', ...target.options }
        },
        capabilities: { ...fullCapabilities }
      },
      { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
    )

    assert.equal(response.ok, false)
    assert.equal(response.error.code, target.code)
    assert.equal(targetResolutionAttempted, false)
    assert.equal(await getBridgeSession(1), null)
  }

  targetResolutionAttempted = false
  env.chrome.storage.local.get = async () => ({
    stackPrismSettings: { agentBridgeEnabled: true, agentBridgeAllowAllNetworkTargets: true }
  })
  applyDetectorSettingsUpdate({}, { agentBridgeEnabled: true, agentBridgeAllowAllNetworkTargets: true })
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  const allowed = await startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: {
        ...baseRequest,
        url: 'http://127.0.0.1:18080/admin',
        options: { ...baseRequest.options, allowPrivateNetworkTarget: true, targetMode: 'new_tab' }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(targetResolutionAttempted, true)
  assert.equal(allowed.ok, false)
  assert.equal(allowed.error.code, 'INCOGNITO_NOT_SUPPORTED')
  assert.equal(await getBridgeSession(1), null)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture cleans a newly created target tab when state persistence fails', async () => {
  const env = makeChrome()
  env.chrome.tabs.create = async create => {
    const tab = { id: 4, windowId: 1, url: create.url, incognito: false, status: 'complete' }
    env.tabs.push(tab)
    return tab
  }
  globalThis.chrome = env.chrome
  const [{ getBridgeSession, registerBridgeSession }, { startAgentCapture }, { listAgentCaptureIds }] = await Promise.all([
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
  const originalSet = env.chrome.storage.session.set
  env.chrome.storage.session.set = async value => {
    if (Object.keys(value).includes(`agent-capture:${captureId}`)) {
      throw new Error('state save failed')
    }
    await originalSet(value)
  }

  let response = null
  let thrown = null
  try {
    response = await startAgentCapture(
      {
        type: 'START_AGENT_CAPTURE',
        captureId,
        sessionId,
        nonce,
        bridgeOrigin: 'http://127.0.0.1:17370',
        request: {
          ...baseRequest,
          url: 'https://example.com/save-fails',
          options: { ...baseRequest.options, targetMode: 'new_tab' }
        },
        capabilities: { ...fullCapabilities }
      },
      { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
    )
  } catch (error) {
    thrown = error
  }

  assert.equal(thrown, null)
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'NOT_SUPPORTED')
  assert.equal(env.removedTabs.includes(4), true)
  assert.equal(await getBridgeSession(1), null)
  assert.deepEqual(await listAgentCaptureIds(), [])
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

test('agent capture fails running captures when browser data consent is removed', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ handleAgentBridgeDataConsentRemoved }, { saveAgentCaptureState, listAgentCaptureIds }] = await Promise.all([
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

  await handleAgentBridgeDataConsentRemoved()

  assert.equal(
    env.messages.some(
      message =>
        message.type === 'AGENT_CAPTURE_STATUS' &&
        message.payload.error?.code === 'AGENT_BRIDGE_DISABLED' &&
        message.payload.error.message.includes('data transfer permission')
    ),
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

test('background sync settings change preserves sync updates when local storage is unavailable', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  env.chrome.storage.local.get = async () => {
    throw new Error('local settings unavailable token=secret')
  }
  globalThis.chrome = env.chrome

  await loadTsModule('src/background/index.ts')
  await new Promise(resolve => setTimeout(resolve, 0))
  const { loadDetectorSettings } = await loadTsModule('src/background/detector-settings.ts')

  assert.equal(env.storageEvents.onChanged.length, 1)
  env.storageEvents.onChanged[0](
    {
      stackPrismSettings: {
        newValue: {
          disabledTechnologies: ['React'],
          disabledCategories: ['Analytics']
        },
        oldValue: {}
      }
    },
    'sync'
  )

  const settings = await waitForCondition(async () => {
    const current = await loadDetectorSettings()
    return current.disabledTechnologies.includes('React') ? current : null
  })

  assert.deepEqual(settings.disabledTechnologies, ['React'])
  assert.deepEqual(settings.disabledCategories, ['Analytics'])
  assert.equal(settings.agentBridgeEnabled, false)
  delete globalThis.chrome
})

test('background data consent removal disables running agent captures', async () => {
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

  assert.equal(env.permissionsEvents.onRemoved.length, 1)
  env.permissionsEvents.onRemoved[0]({ data_collection: ['technicalAndInteraction'] })

  await waitForMessage(
    env.messages,
    message =>
      message.type === 'AGENT_CAPTURE_STATUS' &&
      message.payload.error?.code === 'AGENT_BRIDGE_DISABLED' &&
      message.payload.error.message.includes('data transfer permission')
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
  const [{ getBridgeSession, registerBridgeSession }, { startAgentCapture }, { saveAgentCaptureState }] = await Promise.all([
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
  assert.equal((await getBridgeSession(1))?.captureId, captureId)
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
  const scheduledDelays = []
  const baseRemove = env.chrome.tabs.remove
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (Number(delay) === 600) {
      scheduledDelays.push(600)
      return { fakeTimer: true }
    }
    return originalSetTimeout(callback, 0, ...args)
  }
  globalThis.clearTimeout = timer => {
    if (timer && typeof timer === 'object' && 'fakeTimer' in timer) return
    return originalClearTimeout(timer)
  }
  env.chrome.tabs.remove = async id => {
    await baseRemove(id)
    env.tabs.splice(
      env.tabs.findIndex(tab => tab.id === id),
      1
    )
  }
  env.chrome.scripting.executeScript = async () => [{ result: {} }]
  globalThis.chrome = env.chrome
  try {
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

    const ordinaryDetectionBaseline = scheduledDelays.length
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
    assert.deepEqual(scheduledDelays.slice(ordinaryDetectionBaseline), [])
    assert.equal(env.removedTabs.includes(2), false)
    assert.deepEqual(await listAgentCaptureIds(), [])
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    delete globalThis.chrome
    restoreFetch()
  }
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

test('agent capture reports detection and experience phases before long-running collection', async () => {
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
        waitMs: 1,
        include: ['tech', 'visual'],
        options: { ...baseRequest.options, forceRefresh: false }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  await waitForProfileTransferComplete(env)
  assert.deepEqual(
    env.messages.filter(message => message.type === 'AGENT_CAPTURE_STATUS').map(message => message.payload.phase),
    ['target_loaded', 'detecting_tech', 'profiling_experience']
  )
  delete globalThis.chrome
  restoreFetch()
})

test('agent profile transfer accepts immediate ack after waiter is notified', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const [
    { registerBridgeSession },
    { clearProfileTransferPort, registerAgentProfileTransferPort, sendProfileToBridge, waitForProfileTransferPort }
  ] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture-transfer.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  const connected = waitForProfileTransferPort({ captureId, sessionId, nonce }).then(async value => {
    assert.equal(value, true)
    await sendProfileToBridge(
      {
        captureId,
        sessionId,
        nonce,
        bridgeOrigin: 'http://127.0.0.1:17370',
        bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
        bridgeTabId: 1,
        bridgeWindowId: 1,
        targetUrl: baseRequest.url,
        targetMode: 'new_tab',
        createdByCapture: true,
        keepTabOpen: false,
        phase: 'posting_profile',
        status: 'running',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        deadlineAt: Date.now() + 60000
      },
      {
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
      }
    )
  })

  try {
    await connectProfileTransferPort(env, registerAgentProfileTransferPort, { syncAck: true })
    await connected

    assert.equal(env.messages.some(message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE'), true)
  } finally {
    clearProfileTransferPort({ captureId, sessionId, nonce })
    delete globalThis.chrome
  }
})

test('agent profile transfer ignores malformed ack keys without breaking pending transfer', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const [
    { registerBridgeSession },
    { clearProfileTransferPort, registerAgentProfileTransferPort, sendProfileToBridge, waitForProfileTransferPort }
  ] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture-transfer.ts')
  ])
  await registerBridgeSession({
    tabId: 1,
    windowId: 1,
    bridgeOrigin: 'http://127.0.0.1:17370',
    sessionId,
    captureId,
    nonce
  })
  const connected = waitForProfileTransferPort({ captureId, sessionId, nonce })

  try {
    const connection = await connectProfileTransferPort(env, registerAgentProfileTransferPort, { autoAck: false })
    await connected
    connection.emit({
      type: 'AGENT_PROFILE_TRANSFER_ACK',
      captureId,
      sessionId,
      nonce,
      profileTransferId: 'xfer_bad:key',
      ok: true
    })
    const acknowledgeLastTransferMessage = () => {
      const message = env.messages.at(-1)
      connection.emit({
        type: 'AGENT_PROFILE_TRANSFER_ACK',
        captureId: message.captureId,
        sessionId: message.sessionId,
        nonce: message.nonce,
        profileTransferId: message.profileTransferId,
        chunkIndex: message.chunkIndex,
        ok: true
      })
    }

    const profilePromise = sendProfileToBridge(
      {
        captureId,
        sessionId,
        nonce,
        bridgeOrigin: 'http://127.0.0.1:17370',
        bridgeUrl: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`,
        bridgeTabId: 1,
        bridgeWindowId: 1,
        targetUrl: baseRequest.url,
        targetMode: 'new_tab',
        createdByCapture: true,
        keepTabOpen: false,
        phase: 'posting_profile',
        status: 'running',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        deadlineAt: Date.now() + 60000
      },
      {
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
      }
    )
    await waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_BEGIN')
    acknowledgeLastTransferMessage()
    await waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_CHUNK')
    acknowledgeLastTransferMessage()
    await waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE')
    acknowledgeLastTransferMessage()
    await profilePromise

    assert.equal(env.messages.some(message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE'), true)
  } finally {
    clearProfileTransferPort({ captureId, sessionId, nonce })
    delete globalThis.chrome
  }
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
      request: { ...baseRequest, options: { ...baseRequest.options, targetMode: 'new_tab' } },
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
  const scheduledDelays = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (Number(delay) === 600) {
      scheduledDelays.push(600)
      return { fakeTimer: true }
    }
    return originalSetTimeout(callback, delay, ...args)
  }
  globalThis.clearTimeout = timer => {
    if (timer && typeof timer === 'object' && 'fakeTimer' in timer) return
    return originalClearTimeout(timer)
  }
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
  env.chrome.scripting.executeScript = async () => [{ result: {} }]
  globalThis.chrome = env.chrome
  try {
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

    const ordinaryDetectionBaseline = scheduledDelays.length
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
    assert.equal(failed.payload.phase, 'target_loaded')
    assert.equal(failed.payload.error.details.reason, 'private_network_address')
    assert.equal(failed.payload.error.details.address, '127.0.0.1')
    assert.deepEqual(scheduledDelays.slice(ordinaryDetectionBaseline), [])
    assert.deepEqual(await listAgentCaptureIds(), [])
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    delete globalThis.chrome
  }
})

test('agent capture allows public target when Chrome omits target network address', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
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
          fromCache: false
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
    return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
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
  const loaded = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.phase === 'target_loaded'
  )
  assert.equal(loaded.payload.targetNetworkAddress, undefined)
  assert.equal(loaded.payload.error, undefined)
  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'PRIVATE_NETWORK_TARGET_BLOCKED'),
    false
  )
  assert.equal(detectionAttempted, true)
  await waitForProfileTransferComplete(env)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
  restoreFetch()
})

test('agent capture blocks private final URL even when browser network metadata omits the target ip', async () => {
  const env = makeChrome()
  let detectionAttempted = false
  env.chrome.tabs.create = async create => {
    const tab = {
      id: 3,
      windowId: 1,
      url: 'http://localhost:18080/admin',
      title: 'Private final',
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
        url: 'https://public.example/start',
        options: { ...baseRequest.options, targetMode: 'new_tab' }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(detectionAttempted, false)
  const captureIds = await listAgentCaptureIds()
  assert.deepEqual(captureIds, [])
  const failed = env.messages.find(
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.status === 'failed' && message.payload.error?.code === 'FINAL_URL_BLOCKED'
  )
  assert.equal(Boolean(failed), true)
  assert.equal(failed.payload.error.details.reason, 'private_network_address')
  assert.equal(failed.payload.error.details.finalUrl, 'http://localhost:18080/admin')
  delete globalThis.chrome
  restoreFetch()
})

test('agent capture keeps target network evidence across tab loading updates', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  let detectionAttempted = false
  env.chrome.tabs.create = async create => {
    const tab = { id: 3, windowId: 1, url: create.url, title: 'Target', incognito: false, status: 'loading' }
    env.tabs.push(tab)
    queueMicrotask(() => {
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
          ip: '93.184.216.34'
        })
      }
      for (const listener of env.tabEvents.onUpdated) {
        listener(3, { status: 'loading', url: tab.url }, tab)
      }
      tab.status = 'complete'
      for (const listener of env.tabEvents.onUpdated) {
        listener(3, { status: 'complete', url: tab.url }, tab)
      }
    })
    return tab
  }
  env.chrome.scripting.executeScript = async () => {
    detectionAttempted = true
    return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }] = await Promise.all([
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
  const loaded = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.phase === 'target_loaded'
  )
  assert.equal(loaded.payload.targetNetworkAddress, '93.184.216.34')
  assert.equal(loaded.payload.error, undefined)
  assert.equal(detectionAttempted, true)
  await waitForProfileTransferComplete(env)
  delete globalThis.chrome
})

test('agent capture force refresh reloads target with bypassCache before network validation', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  let detectionAttempted = false
  const reloads = []
  env.chrome.tabs.create = async create => {
    const tab = { id: 3, windowId: 1, url: create.url, title: 'Target', incognito: false, status: 'complete' }
    env.tabs.push(tab)
    queueMicrotask(() => {
      for (const listener of env.webRequestEvents.onResponseStarted) {
        listener({
          tabId: 3,
          requestId: 'target-main-frame-cached',
          url: create.url,
          type: 'main_frame',
          method: 'GET',
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          fromCache: true,
          ip: '93.184.216.33'
        })
      }
    })
    return tab
  }
  env.chrome.tabs.reload = async (tabId, options) => {
    reloads.push({ tabId, options })
    const tab = env.tabs.find(item => item.id === tabId)
    for (const listener of env.tabEvents.onUpdated) {
      listener(tabId, { title: 'Still old page' }, tab)
    }
    setTimeout(() => {
      tab.status = 'loading'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'loading', url: tab.url }, tab)
      }
      for (const listener of env.webRequestEvents.onResponseStarted) {
        listener({
          tabId,
          requestId: 'target-main-frame-reloaded',
          url: tab.url,
          type: 'main_frame',
          method: 'GET',
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          fromCache: false,
          ip: '93.184.216.34'
        })
      }
      tab.status = 'complete'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'complete', url: tab.url }, tab)
      }
    }, 0)
  }
  env.chrome.scripting.executeScript = async () => {
    detectionAttempted = true
    return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }] = await Promise.all([
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
        options: { ...baseRequest.options, targetMode: 'new_tab', forceRefresh: true }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const loaded = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.phase === 'target_loaded'
  )
  assert.deepEqual(reloads, [{ tabId: 3, options: { bypassCache: true } }])
  assert.equal(loaded.payload.targetNetworkAddress, '93.184.216.34')
  assert.equal(loaded.payload.targetNetworkFromCache, false)
  assert.equal(loaded.payload.error, undefined)
  assert.equal(detectionAttempted, true)
  await waitForProfileTransferComplete(env)
  delete globalThis.chrome
})

test('agent capture force refresh ignores stale complete before reload loading starts', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  const reloads = []
  const detectionUrls = []
  env.chrome.tabs.create = async create => {
    const tab = { id: 3, windowId: 1, url: create.url, title: 'Target', incognito: false, status: 'complete' }
    env.tabs.push(tab)
    return tab
  }
  env.chrome.tabs.reload = async (tabId, options) => {
    reloads.push({ tabId, options })
    const tab = env.tabs.find(item => item.id === tabId)
    for (const listener of env.tabEvents.onUpdated) {
      listener(tabId, { status: 'complete', url: tab.url }, tab)
    }
    setTimeout(() => {
      tab.url = 'https://example.com/app?view=one&fresh=1'
      tab.status = 'loading'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'loading', url: tab.url }, tab)
      }
      for (const listener of env.webRequestEvents.onResponseStarted) {
        listener({
          tabId,
          requestId: 'target-main-frame-reloaded',
          url: tab.url,
          type: 'main_frame',
          method: 'GET',
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          fromCache: false,
          ip: '93.184.216.34'
        })
      }
      tab.status = 'complete'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'complete', url: tab.url }, tab)
      }
    }, 0)
  }
  env.chrome.scripting.executeScript = async () => {
    detectionUrls.push(env.tabs.find(tab => tab.id === 3)?.url)
    return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }] = await Promise.all([
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
        options: { ...baseRequest.options, targetMode: 'new_tab', forceRefresh: true }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const loaded = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.phase === 'target_loaded'
  )
  assert.deepEqual(reloads, [{ tabId: 3, options: { bypassCache: true } }])
  assert.equal(loaded.payload.finalUrl, 'https://example.com/app?view=one&fresh=1')
  assert.equal(detectionUrls[0], 'https://example.com/app?view=one&fresh=1')
  await waitForProfileTransferComplete(env)
  delete globalThis.chrome
})

test('agent capture force refresh waits for delayed reload start before using complete state', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  const detectionUrls = []
  env.chrome.tabs.create = async create => {
    const tab = { id: 3, windowId: 1, url: create.url, title: 'Target', incognito: false, status: 'complete' }
    env.tabs.push(tab)
    return tab
  }
  env.chrome.tabs.reload = async tabId => {
    const tab = env.tabs.find(item => item.id === tabId)
    setTimeout(() => {
      tab.url = 'https://example.com/app?view=one&fresh=delayed'
      tab.status = 'loading'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'loading', url: tab.url }, tab)
      }
      for (const listener of env.webRequestEvents.onResponseStarted) {
        listener({
          tabId,
          requestId: 'target-main-frame-delayed-reload',
          url: tab.url,
          type: 'main_frame',
          method: 'GET',
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          fromCache: false,
          ip: '93.184.216.34'
        })
      }
      tab.status = 'complete'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'complete', url: tab.url }, tab)
      }
    }, 20)
  }
  env.chrome.scripting.executeScript = async () => {
    detectionUrls.push(env.tabs.find(tab => tab.id === 3)?.url)
    return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }] = await Promise.all([
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
        options: { ...baseRequest.options, targetMode: 'new_tab', forceRefresh: true }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const loaded = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.phase === 'target_loaded'
  )
  assert.equal(loaded.payload.finalUrl, 'https://example.com/app?view=one&fresh=delayed')
  assert.equal(loaded.payload.targetNetworkAddress, '93.184.216.34')
  assert.equal(detectionUrls[0], 'https://example.com/app?view=one&fresh=delayed')
  await waitForProfileTransferComplete(env)
  delete globalThis.chrome
})

test('agent capture force refresh waits for created tab initial load before reload', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  const reloads = []
  env.chrome.tabs.create = async create => {
    const tab = { id: 3, windowId: 1, url: create.url, title: 'Target', incognito: false, status: 'loading' }
    env.tabs.push(tab)
    setTimeout(() => {
      for (const listener of env.webRequestEvents.onResponseStarted) {
        listener({
          tabId: 3,
          requestId: 'target-main-frame-initial',
          url: create.url,
          type: 'main_frame',
          method: 'GET',
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          fromCache: false,
          ip: '93.184.216.33'
        })
      }
      tab.status = 'complete'
      for (const listener of env.tabEvents.onUpdated) {
        listener(3, { status: 'complete', url: tab.url }, tab)
      }
    }, 0)
    return tab
  }
  env.chrome.tabs.reload = async (tabId, options) => {
    const tab = env.tabs.find(item => item.id === tabId)
    assert.equal(tab?.status, 'complete')
    reloads.push({ tabId, options })
    setTimeout(() => {
      for (const listener of env.webNavigationEvents.onErrorOccurred) {
        listener({ tabId, frameId: 0, error: 'net::ERR_ABORTED' })
      }
      for (const listener of env.webRequestEvents.onResponseStarted) {
        listener({
          tabId,
          requestId: 'target-main-frame-reloaded',
          url: tab.url,
          type: 'main_frame',
          method: 'GET',
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          fromCache: false,
          ip: '93.184.216.34'
        })
      }
      tab.status = 'loading'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'loading', url: tab.url }, tab)
      }
      tab.status = 'complete'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'complete', url: tab.url }, tab)
      }
    }, 0)
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }] = await Promise.all([
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
        options: { ...baseRequest.options, targetMode: 'new_tab', forceRefresh: true }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const loaded = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.phase === 'target_loaded'
  )
  assert.deepEqual(reloads, [{ tabId: 3, options: { bypassCache: true } }])
  assert.equal(loaded.payload.targetNetworkAddress, '93.184.216.34')
  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_LOAD_FAILED'),
    false
  )
  await waitForProfileTransferComplete(env)
  delete globalThis.chrome
})

test('agent capture force refresh ignores same-url network evidence from before reload', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  const detectionUrls = []
  env.chrome.tabs.create = async create => {
    const tab = { id: 3, windowId: 1, url: create.url, title: 'Target', incognito: false, status: 'complete' }
    env.tabs.push(tab)
    queueMicrotask(() => {
      for (const listener of env.webRequestEvents.onResponseStarted) {
        listener({
          tabId: 3,
          requestId: 'target-main-frame-before-reload',
          url: create.url,
          type: 'main_frame',
          method: 'GET',
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          fromCache: true,
          ip: '93.184.216.33'
        })
      }
    })
    return tab
  }
  env.chrome.tabs.reload = async tabId => {
    const tab = env.tabs.find(item => item.id === tabId)
    setTimeout(() => {
      tab.status = 'loading'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'loading', url: tab.url }, tab)
      }
      for (const listener of env.webRequestEvents.onResponseStarted) {
        listener({
          tabId,
          requestId: 'target-main-frame-after-reload',
          url: tab.url,
          type: 'main_frame',
          method: 'GET',
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          fromCache: false,
          ip: '93.184.216.34'
        })
      }
      tab.status = 'complete'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'complete', url: tab.url }, tab)
      }
    }, 20)
  }
  env.chrome.scripting.executeScript = async () => {
    detectionUrls.push(env.tabs.find(tab => tab.id === 3)?.url)
    return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }] = await Promise.all([
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
        options: { ...baseRequest.options, targetMode: 'new_tab', forceRefresh: true }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const loaded = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.phase === 'target_loaded'
  )
  assert.equal(loaded.payload.targetNetworkAddress, '93.184.216.34')
  assert.equal(loaded.payload.targetNetworkFromCache, false)
  assert.equal(detectionUrls[0], 'https://example.com/app?view=one')
  await waitForProfileTransferComplete(env)
  delete globalThis.chrome
})

test('agent capture force refresh accepts rapid complete reload without loading event', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  const detectionUrls = []
  env.chrome.tabs.create = async create => {
    const tab = { id: 3, windowId: 1, url: create.url, title: 'Target', incognito: false, status: 'complete' }
    env.tabs.push(tab)
    return tab
  }
  env.chrome.tabs.reload = async tabId => {
    const tab = env.tabs.find(item => item.id === tabId)
    setTimeout(() => {
      tab.url = 'https://example.com/app?view=one&fresh=2'
      for (const listener of env.webRequestEvents.onResponseStarted) {
        listener({
          tabId,
          requestId: 'target-main-frame-rapid-reload',
          url: tab.url,
          type: 'main_frame',
          method: 'GET',
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          fromCache: false,
          ip: '93.184.216.34'
        })
      }
      tab.status = 'complete'
      for (const listener of env.tabEvents.onUpdated) {
        listener(tabId, { status: 'complete', url: tab.url }, tab)
      }
    }, 0)
  }
  env.chrome.scripting.executeScript = async () => {
    detectionUrls.push(env.tabs.find(tab => tab.id === 3)?.url)
    return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }] = await Promise.all([
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
        options: { ...baseRequest.options, targetMode: 'new_tab', forceRefresh: true }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const loaded = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.phase === 'target_loaded'
  )
  assert.equal(loaded.payload.finalUrl, 'https://example.com/app?view=one&fresh=2')
  assert.equal(loaded.payload.targetNetworkAddress, '93.184.216.34')
  assert.equal(detectionUrls[0], 'https://example.com/app?view=one&fresh=2')
  await waitForProfileTransferComplete(env)
  delete globalThis.chrome
})

test('agent capture allows proxy-reserved target address for public hostname by default', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
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
          ip: '198.18.0.12'
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
    return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
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
  await waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE')
  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'PRIVATE_NETWORK_TARGET_BLOCKED'),
    false
  )
  assert.equal(detectionAttempted, true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
  restoreFetch()
})

test('agent capture can be explicitly allowed to use all network targets from local settings', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  let detectionAttempted = false
  env.chrome.storage.local.get = async () => ({
    stackPrismSettings: { agentBridgeEnabled: true, agentBridgeAllowAllNetworkTargets: true }
  })
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
    return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
  }
  globalThis.chrome = env.chrome
  const [
    { registerBridgeSession },
    { startAgentCapture, registerAgentProfileTransferPort },
    { listAgentCaptureIds },
    { loadDetectorSettings }
  ] = await Promise.all([
    loadTsModule('src/background/agent-bridge-session.ts'),
    loadTsModule('src/background/agent-capture.ts'),
    loadTsModule('src/background/agent-capture-state.ts'),
    loadTsModule('src/background/detector-settings.ts'),
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

  const settings = await loadDetectorSettings()
  assert.equal(settings.agentBridgeAllowAllNetworkTargets, true)

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
        options: { ...baseRequest.options, allowPrivateNetworkTarget: true, forceRefresh: false, targetMode: 'new_tab' }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  await waitForMessage(env.messages, message => message.type === 'AGENT_PROFILE_TRANSFER_COMPLETE')
  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'PRIVATE_NETWORK_TARGET_BLOCKED'),
    false
  )
  assert.equal(detectionAttempted, true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
  restoreFetch()
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

test('agent page detection falls back to inline page detector when firefox cannot load script files', async () => {
  const env = makeChrome()
  enableFastHeaderFallback()
  const calls = []
  env.chrome.scripting.executeScript = async options => {
    calls.push(options)
    if (options.files?.[0]?.includes('content-observer')) return [{ result: null }]
    if (options.files?.[0] === 'injected/page-detector.iife.js') return [{ error: 'Unable to load script: <anonymous code>' }]
    if (typeof options.func === 'function' && options.world === 'MAIN') {
      return [{ result: { url: 'https://example.com/app?view=one', technologies: [{ name: 'React', categories: ['frontend'] }] } }]
    }
    return [{ result: {} }]
  }
  globalThis.chrome = env.chrome
  const { runAgentPageDetection } = await loadTsModule('src/background/detection.ts')

  const result = await runAgentPageDetection(2, Date.now() + 5000)

  assert.equal(result.url, 'https://example.com/app?view=one')
  assert.deepEqual(calls.map(call => call.files?.[0]).filter(Boolean), ['assets/content-observer.ts-unit.js', 'injected/page-detector.iife.js'])
  assert.ok(calls.some(call => typeof call.func === 'function' && call.world === 'MAIN'))
  delete globalThis.chrome
  restoreFetch()
})

test('agent page detection does not use inline fallback for runtime detector errors', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  const calls = []
  env.chrome.scripting.executeScript = async options => {
    calls.push(options)
    if (options.files?.[0]?.includes('content-observer')) return [{ result: null }]
    if (options.files?.[0] === 'injected/page-detector.iife.js') return [{ error: 'ReferenceError: detector regression' }]
    if (options.files?.[0] === 'injected/experience-profiler.iife.js') {
      return [{ result: { visual: {}, layout: {}, components: {}, interaction: {}, ux: {}, assets: {}, evidence: {} } }]
    }
    return [{ result: null }]
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
        options: { ...baseRequest.options, targetMode: 'new_tab', forceRefresh: false }
      },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )

  assert.equal(response.ok, true)
  const failed = await waitForMessage(
    env.messages,
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_INJECTION_FAILED'
  )
  assert.match(failed.payload.error.details.reason, /detector regression/)
  assert.equal(calls.some(call => call.func?.name === 'detectPageTechnologies'), false)
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
    if (typeof options.func === 'function') {
      throw new Error('Cannot inject observer function for https://example.com/app?token=secret#frag')
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
  assert.equal(reused.createdByCapture, false)
  assert.equal(reused.tab.id, 2)
  assert.equal(reused.tab.url, 'https://example.com/app?view=one')

  env.tabs.find(tab => tab.id === 2).url = 'https://example.com/app?view=two'
  const newTab = await resolveTargetTab(request, 1)
  assert.equal(newTab.ok, true)
  assert.equal(newTab.createdByCapture, true)
  assert.equal(newTab.tab.url, 'https://example.com/app?view=one')

  env.storage['agent-active-tab:1'] = {
    tabId: 2,
    windowId: 1,
    url: request.url,
    updatedAt: 1
  }
  const active = await resolveTargetTab({ ...request, options: { ...request.options, targetMode: 'active_tab' } }, 1)
  assert.equal(active.ok, false)
  assert.equal(active.error.code, 'ACTIVE_TAB_MISMATCH')
  delete globalThis.chrome
})

test('active tab mode validates the live tab url even when the tracker snapshot is stale', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const [{ validateAgentCaptureRequest }, { resolveTargetTab }] = await Promise.all([
    loadTsModule('src/background/agent-capture-request.ts'),
    loadTsModule('src/background/agent-capture-target.ts')
  ])
  const validated = validateAgentCaptureRequest(baseRequest)
  assert.equal(validated.ok, true)
  const request = validated.request

  env.storage['agent-active-tab:1'] = {
    tabId: 2,
    windowId: 1,
    url: 'https://example.com/app?view=stale',
    updatedAt: 1
  }
  env.tabs.find(tab => tab.id === 2).url = request.url

  const active = await resolveTargetTab({ ...request, options: { ...request.options, targetMode: 'active_tab' } }, 1)
  assert.equal(active.ok, true)
  assert.equal(active.createdByCapture, false)
  assert.equal(active.tab.id, 2)
  assert.equal(active.tab.url, request.url)
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
    const tab = { id: 4, windowId: args.windowId, url: args.url, incognito: true, status: 'complete' }
    env.tabs.push(tab)
    return tab
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

test('active tab tracker updates the recorded URL on URL-only tab updates', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const { registerActiveTabTracker, getPreviousActiveTab } = await loadTsModule('src/background/active-tab-tracker.ts')

  registerActiveTabTracker()
  await env.tabEvents.onActivated[0]({ tabId: 2, windowId: 1 })
  assert.equal((await getPreviousActiveTab(1)).url, 'https://example.com/app?view=one')

  env.tabs.find(tab => tab.id === 2).url = 'https://example.com/app?view=spa'
  for (const listener of env.tabEvents.onUpdated) {
    await listener(2, { url: 'https://example.com/app?view=spa' }, env.tabs.find(tab => tab.id === 2))
  }

  assert.equal((await getPreviousActiveTab(1)).url, 'https://example.com/app?view=spa')
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

test('active tab tracker clears stale recorded tab when activation switches to a non-detectable page', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const { registerActiveTabTracker, getPreviousActiveTab } = await loadTsModule('src/background/active-tab-tracker.ts')

  registerActiveTabTracker()
  await env.tabEvents.onActivated[0]({ tabId: 2, windowId: 1 })
  assert.equal((await getPreviousActiveTab(1)).url, 'https://example.com/app?view=one')

  env.tabs.find(tab => tab.id === 2).url = 'chrome://newtab/'
  await env.tabEvents.onActivated[0]({ tabId: 2, windowId: 1 })

  assert.equal(await getPreviousActiveTab(1), null)
  delete globalThis.chrome
})

test('active tab tracker preserves previous active tab when the bridge page becomes active', async () => {
  const env = makeChrome()
  globalThis.chrome = env.chrome
  const { registerActiveTabTracker, getPreviousActiveTab } = await loadTsModule('src/background/active-tab-tracker.ts')

  registerActiveTabTracker()
  await env.tabEvents.onActivated[0]({ tabId: 2, windowId: 1 })
  assert.equal((await getPreviousActiveTab(1)).url, 'https://example.com/app?view=one')

  await env.tabEvents.onActivated[0]({ tabId: 1, windowId: 1 })

  const previous = await getPreviousActiveTab(1)
  assert.equal(previous.tabId, 2)
  assert.equal(previous.url, 'https://example.com/app?view=one')
  delete globalThis.chrome
})

test('active tab tracker preserves previous active tab while bridge tab is still loading', async () => {
  const env = makeChrome()
  env.tabs.find(tab => tab.id === 1).url = ''
  env.tabs.find(tab => tab.id === 1).pendingUrl = `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`
  globalThis.chrome = env.chrome
  const { registerActiveTabTracker, getPreviousActiveTab } = await loadTsModule('src/background/active-tab-tracker.ts')

  registerActiveTabTracker()
  await env.tabEvents.onActivated[0]({ tabId: 2, windowId: 1 })
  assert.equal((await getPreviousActiveTab(1)).url, 'https://example.com/app?view=one')

  await env.tabEvents.onActivated[0]({ tabId: 1, windowId: 1 })

  const previous = await getPreviousActiveTab(1)
  assert.equal(previous.tabId, 2)
  assert.equal(previous.url, 'https://example.com/app?view=one')
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
  env.chrome.scripting.executeScript = async options => {
    const profilerCall =
      options.files?.[0] === 'injected/experience-profiler.iife.js' ||
      String(options.func || '').includes('__STACKPRISM_EXPERIENCE_OPTIONS__')
    if (profilerCall && env.tabs.find(tab => tab.id === options.target.tabId)?.status !== 'complete') {
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

test('content injector normalizes firefox manifest script URLs and retries root paths', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const calls = []
  env.chrome.runtime.getManifest = () => ({
    version: '1.3.71',
    content_scripts: [
      { js: ['moz-extension://unit-id/assets/content-observer.ts-unit.js'], matches: ['http://*/*', 'https://*/*'] },
      { js: ['moz-extension://unit-id/assets/agent-bridge-client.ts-unit.js'], matches: ['http://127.0.0.1/*'] }
    ]
  })
  env.chrome.scripting.executeScript = async options => {
    calls.push(options)
    return options.files?.[0]?.startsWith('/') ? [{ result: null }] : [{ error: 'Unable to load script: relative path failed' }]
  }
  globalThis.chrome = env.chrome

  try {
    const { getAgentBridgeClientFile, injectAgentBridgeClient } = await loadTsModule('src/background/content-injector.ts')
    assert.equal(getAgentBridgeClientFile(), 'assets/agent-bridge-client.ts-unit.js')

    await injectAgentBridgeClient(1, { failOnError: true })

    assert.deepEqual(
      calls.map(call => call.files?.[0]),
      ['assets/agent-bridge-client.ts-unit.js', '/assets/agent-bridge-client.ts-unit.js']
    )
  } finally {
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('content injector falls back to inline bridge client when firefox cannot load script files', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const calls = []
  env.chrome.runtime.getManifest = () => ({
    version: '1.3.71',
    content_scripts: [
      { js: ['moz-extension://unit-id/assets/content-observer.ts-unit.js'], matches: ['http://*/*', 'https://*/*'] },
      { js: ['moz-extension://unit-id/assets/agent-bridge-client.ts-unit.js'], matches: ['http://127.0.0.1/*'] }
    ]
  })
  env.chrome.scripting.executeScript = async options => {
    calls.push(options)
    return options.files ? [{ error: `Unable to load script: ${options.files[0]}` }] : [{ result: null }]
  }
  globalThis.chrome = env.chrome

  try {
    const { injectAgentBridgeClient } = await loadTsModule('src/background/content-injector.ts')

    await injectAgentBridgeClient(1, { failOnError: true })

    assert.deepEqual(
      calls.filter(call => call.files?.[0]?.includes('agent-bridge-client.ts-unit.js')).map(call => call.files?.[0]),
      ['assets/agent-bridge-client.ts-unit.js', '/assets/agent-bridge-client.ts-unit.js']
    )
    assert.equal(calls.filter(call => call.func?.name === 'runAgentBridgeClient').length, 1)
  } finally {
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('content injector does not retry or fall back after bridge client runtime error', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const calls = []
  env.chrome.runtime.getManifest = () => ({
    version: '1.3.71',
    content_scripts: [
      { js: ['moz-extension://unit-id/assets/content-observer.ts-unit.js'], matches: ['http://*/*', 'https://*/*'] },
      { js: ['moz-extension://unit-id/assets/agent-bridge-client.ts-unit.js'], matches: ['http://127.0.0.1/*'] }
    ]
  })
  env.chrome.scripting.executeScript = async options => {
    calls.push(options)
    if (options.files?.[0] === 'assets/agent-bridge-client.ts-unit.js') {
      return [{ error: 'ReferenceError: bridge client regression' }]
    }
    if (options.files?.[0] === '/assets/agent-bridge-client.ts-unit.js') {
      return [{ error: 'Unable to load script: slash path failed' }]
    }
    return [{ result: null }]
  }
  globalThis.chrome = env.chrome

  try {
    const { injectAgentBridgeClient } = await loadTsModule('src/background/content-injector.ts')

    await assert.rejects(() => injectAgentBridgeClient(1, { failOnError: true }), /bridge client regression/)
    assert.deepEqual(
      calls.filter(call => call.files?.[0]?.includes('agent-bridge-client.ts-unit.js')).map(call => call.files?.[0]),
      ['assets/agent-bridge-client.ts-unit.js']
    )
    assert.equal(calls.some(call => call.func?.name === 'runAgentBridgeClient'), false)
  } finally {
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('content injector treats bridge client NotFoundError as a runtime error', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const calls = []
  env.chrome.runtime.getManifest = () => ({
    version: '1.3.71',
    content_scripts: [
      { js: ['moz-extension://unit-id/assets/content-observer.ts-unit.js'], matches: ['http://*/*', 'https://*/*'] },
      { js: ['moz-extension://unit-id/assets/agent-bridge-client.ts-unit.js'], matches: ['http://127.0.0.1/*'] }
    ]
  })
  env.chrome.scripting.executeScript = async options => {
    calls.push(options)
    if (options.files?.[0] === 'assets/agent-bridge-client.ts-unit.js') {
      return [{ error: "NotFoundError: Failed to execute 'removeChild' on 'Node': node was not found." }]
    }
    if (options.files?.[0] === '/assets/agent-bridge-client.ts-unit.js') {
      return [{ error: 'Unable to load script: slash path failed' }]
    }
    return [{ result: null }]
  }
  globalThis.chrome = env.chrome

  try {
    const { injectAgentBridgeClient } = await loadTsModule('src/background/content-injector.ts')

    await assert.rejects(() => injectAgentBridgeClient(1, { failOnError: true }), /NotFoundError/)
    assert.deepEqual(
      calls.filter(call => call.files?.[0]?.includes('agent-bridge-client.ts-unit.js')).map(call => call.files?.[0]),
      ['assets/agent-bridge-client.ts-unit.js']
    )
    assert.equal(calls.some(call => call.func?.name === 'runAgentBridgeClient'), false)
  } finally {
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('content injector does not fall back for bridge client runtime errors', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const calls = []
  env.chrome.runtime.getManifest = () => ({
    version: '1.3.71',
    content_scripts: [
      { js: ['moz-extension://unit-id/assets/content-observer.ts-unit.js'], matches: ['http://*/*', 'https://*/*'] },
      { js: ['moz-extension://unit-id/assets/agent-bridge-client.ts-unit.js'], matches: ['http://127.0.0.1/*'] }
    ]
  })
  env.chrome.scripting.executeScript = async options => {
    calls.push(options)
    if (options.files) return [{ error: 'ReferenceError: bridge client regression' }]
    return [{ result: null }]
  }
  globalThis.chrome = env.chrome

  try {
    const { injectAgentBridgeClient } = await loadTsModule('src/background/content-injector.ts')

    await assert.rejects(() => injectAgentBridgeClient(1, { failOnError: true }), /bridge client regression/)
    assert.equal(calls.some(call => call.func?.name === 'runAgentBridgeClient'), false)
  } finally {
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('content injector falls back to inline observer when firefox cannot load script files', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const calls = []
  env.chrome.runtime.getManifest = () => ({
    version: '1.3.71',
    content_scripts: [
      { js: ['moz-extension://unit-id/assets/content-observer.ts-unit.js'], matches: ['http://*/*', 'https://*/*'] },
      { js: ['moz-extension://unit-id/assets/agent-bridge-client.ts-unit.js'], matches: ['http://127.0.0.1/*'] }
    ]
  })
  env.chrome.scripting.executeScript = async options => {
    calls.push(options)
    return options.files ? [{ error: `Unable to load script: ${options.files[0]}` }] : [{ result: null }]
  }
  globalThis.chrome = env.chrome

  try {
    const { injectContentObserver } = await loadTsModule('src/background/content-injector.ts')

    await injectContentObserver(91, { failOnError: true })

    assert.deepEqual(
      calls
        .filter(call => call.target?.tabId === 91 && call.files?.[0]?.includes('content-observer.ts-unit.js'))
        .map(call => call.files?.[0]),
      ['assets/content-observer.ts-unit.js', '/assets/content-observer.ts-unit.js']
    )
    assert.equal(calls.filter(call => call.target?.tabId === 91 && call.func?.name === 'runContentObserver').length, 1)
  } finally {
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('content injector does not fall back for observer runtime errors', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const calls = []
  env.chrome.runtime.getManifest = () => ({
    version: '1.3.71',
    content_scripts: [
      { js: ['moz-extension://unit-id/assets/content-observer.ts-unit.js'], matches: ['http://*/*', 'https://*/*'] },
      { js: ['moz-extension://unit-id/assets/agent-bridge-client.ts-unit.js'], matches: ['http://127.0.0.1/*'] }
    ]
  })
  env.chrome.scripting.executeScript = async options => {
    calls.push(options)
    if (options.files) return [{ error: 'ReferenceError: observer regression' }]
    return [{ result: null }]
  }
  globalThis.chrome = env.chrome

  try {
    const { injectContentObserver } = await loadTsModule('src/background/content-injector.ts')

    await assert.rejects(() => injectContentObserver(2, { failOnError: true }), /observer regression/)
    assert.equal(calls.some(call => call.func?.name === 'runContentObserver'), false)
  } finally {
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('background update handling injects agent bridge client for completed bridge tabs', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  globalThis.chrome = env.chrome

  try {
    await loadTsModule('src/background/index.ts')
    const baseline = env.executedScripts.length
    for (const listener of env.tabEvents.onUpdated) {
      await listener(1, { status: 'complete', url: env.tabs[0].url }, env.tabs[0])
    }
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.deepEqual(env.executedScripts.slice(baseline).map(call => call.files?.[0]), ['assets/agent-bridge-client.ts-unit.js'])
  } finally {
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('background update handling suppresses ordinary detection for active capture target tabs', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const scheduledDelays = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (_callback, delay) => {
    scheduledDelays.push(Number(delay))
    return { fakeTimer: true }
  }
  globalThis.clearTimeout = () => {}
  globalThis.chrome = env.chrome

  try {
    const [{ saveAgentCaptureState }] = await Promise.all([
      loadTsModule('src/background/agent-capture-state.ts'),
      loadTsModule('src/background/index.ts')
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
      targetMode: 'reuse_or_new_tab',
      createdByCapture: false,
      keepTabOpen: false,
      phase: 'target_opening',
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      deadlineAt: Date.now() + 60000
    })

    const targetTab = env.tabs.find(tab => tab.id === 2)
    const captureScheduleBaseline = scheduledDelays.length
    for (const listener of env.tabEvents.onUpdated) {
      await listener(2, { status: 'complete', url: targetTab.url }, targetTab)
    }
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    assert.deepEqual(scheduledDelays.slice(captureScheduleBaseline), [])

    const ordinaryScheduleBaseline = scheduledDelays.length
    for (const listener of env.tabEvents.onUpdated) {
      await listener(4, { status: 'complete', url: 'https://ordinary.example/app' }, { id: 4, windowId: 1, url: 'https://ordinary.example/app' })
    }
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    assert.deepEqual(scheduledDelays.slice(ordinaryScheduleBaseline), [600])
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('background update handling suppresses ordinary detection for recently managed capture target tabs', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const scheduledDelays = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (_callback, delay) => {
    scheduledDelays.push(Number(delay))
    return { fakeTimer: true }
  }
  globalThis.clearTimeout = () => {}
  globalThis.chrome = env.chrome

  try {
    const [{ markAgentCaptureTargetTab }] = await Promise.all([
      loadTsModule('src/background/agent-capture-target-guard.ts'),
      loadTsModule('src/background/index.ts')
    ])
    markAgentCaptureTargetTab(4)

    for (const listener of env.tabEvents.onUpdated) {
      await listener(
        4,
        { status: 'complete', url: 'https://blocked.example/app' },
        { id: 4, windowId: 1, url: 'https://blocked.example/app' }
      )
    }
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    assert.deepEqual(scheduledDelays, [])

    for (const listener of env.tabEvents.onUpdated) {
      await listener(
        5,
        { status: 'complete', url: 'https://ordinary.example/app' },
        { id: 5, windowId: 1, url: 'https://ordinary.example/app' }
      )
    }
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    assert.deepEqual(scheduledDelays, [600])
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('background update handling falls back to ordinary detection when capture-state lookup fails', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  const scheduledDelays = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (_callback, delay) => {
    scheduledDelays.push(Number(delay))
    return { fakeTimer: true }
  }
  globalThis.clearTimeout = () => {}
  globalThis.chrome = env.chrome

  try {
    await loadTsModule('src/background/index.ts')
    const baseGet = env.chrome.storage.session.get
    env.chrome.storage.session.get = async key => {
      if (key === 'agent-capture:index') throw new Error('session unavailable')
      return baseGet(key)
    }

    const fallbackScheduleBaseline = scheduledDelays.length
    for (const listener of env.tabEvents.onUpdated) {
      await listener(4, { status: 'complete', url: 'https://ordinary.example/app' }, { id: 4, windowId: 1, url: 'https://ordinary.example/app' })
    }
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    assert.deepEqual(scheduledDelays.slice(fallbackScheduleBaseline), [600])
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
})

test('capture cleanup restores ordinary detection for retained target tabs', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  env.tabs.push({ id: 3, windowId: 1, url: 'https://example.com/kept', title: 'Kept', incognito: false, status: 'complete' })
  env.tabs.push({ id: 4, windowId: 1, url: 'https://example.com/closed', title: 'Closed', incognito: false, status: 'complete' })
  const scheduledDelays = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (_callback, delay) => {
    scheduledDelays.push(Number(delay))
    return { fakeTimer: true }
  }
  globalThis.clearTimeout = () => {}
  globalThis.chrome = env.chrome

  try {
    const { cleanupStoredCaptureAndSession } = await loadTsModule('src/background/agent-capture-lifecycle.ts')
    const restoreScheduleBaseline = scheduledDelays.length
    await cleanupStoredCaptureAndSession({
      captureId,
      bridgeTabId: 1,
      targetTabId: 2,
      createdByCapture: false,
      keepTabOpen: false,
      phase: 'cleanup'
    })
    await cleanupStoredCaptureAndSession({
      captureId: secondCaptureId,
      bridgeTabId: 1,
      targetTabId: 3,
      createdByCapture: true,
      keepTabOpen: true,
      phase: 'target_opening'
    })
    await cleanupStoredCaptureAndSession({
      captureId: 'cap_cleanup_closed_target',
      bridgeTabId: 1,
      targetTabId: 4,
      createdByCapture: true,
      keepTabOpen: false,
      phase: 'cleanup'
    })

    await new Promise(resolve => originalSetTimeout(resolve, 0))
    assert.deepEqual(scheduledDelays.slice(restoreScheduleBaseline), [600, 600])
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    delete globalThis.chrome
    resetLoadTsModuleCaches()
  }
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

test('agent capture state removal logs index rollback failures and preserves the original error', async () => {
  const env = makeChrome()
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args)
  globalThis.chrome = env.chrome
  const { saveAgentCaptureState, removeAgentCaptureState } = await loadTsModule('src/background/agent-capture-state.ts')
  try {
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

    const baseRemove = env.chrome.storage.session.remove
    const baseSet = env.chrome.storage.session.set
    env.chrome.storage.session.remove = async keys => {
      const keyList = Array.isArray(keys) ? keys : [keys]
      if (keyList.includes(`agent-capture:${captureId}`)) throw new Error('state remove failed for rollback logging')
      return baseRemove(keys)
    }
    env.chrome.storage.session.set = async value => {
      if (Array.isArray(value['agent-capture:index']) && value['agent-capture:index'].includes(captureId)) {
        throw new Error('rollback set failed')
      }
      return baseSet(value)
    }

    await assert.rejects(() => removeAgentCaptureState(captureId), /state remove failed for rollback logging/)
    assert.equal(
      errors.some(
        args =>
          args[0] === '[SP background]' &&
          args[1] === 'Agent capture state index rollback failed' &&
          args[2]?.captureId === '[redacted-id]' &&
          args[2]?.error?.errorName === 'Error'
      ),
      true
    )
  } finally {
    console.error = originalError
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

  await handleAgentCaptureNavigationError(2, 0, 'net::ERR_CONNECTION_RESET?token=secret')

  const failureStatus = env.messages.find(
    message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_LOAD_FAILED'
  )
  assert.ok(failureStatus)
  assert.equal(failureStatus.payload.error.details.reason, 'navigation_error')
  assert.equal(JSON.stringify(failureStatus.payload.error).includes('token=secret'), false)
  assert.equal(env.removedTabs.includes(2), true)
  assert.deepEqual(await listAgentCaptureIds(), [])
  delete globalThis.chrome
})

test('agent capture ignores superseded main-frame aborts and keeps waiting', async () => {
  const env = makeChrome()
  enableBridgeStatusAck(env)
  globalThis.chrome = env.chrome
  const [{ handleAgentCaptureNavigationError }, { saveAgentCaptureState, listAgentCaptureIds, getAgentCaptureState }] = await Promise.all([
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

  await handleAgentCaptureNavigationError(2, 0, 'net::ERR_ABORTED')

  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'TARGET_LOAD_FAILED'),
    false
  )
  assert.equal(env.removedTabs.includes(2), false)
  assert.deepEqual(await listAgentCaptureIds(), [captureId])
  assert.equal((await getAgentCaptureState(captureId))?.status, 'running')
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

test('target tab load wait rechecks state after subscribing to tab events', async () => {
  const env = makeChrome()
  const targetTab = env.tabs.find(tab => tab.id === 2)
  targetTab.status = 'loading'
  let getCalls = 0
  env.chrome.tabs.get = async id => {
    assert.equal(id, 2)
    getCalls += 1
    if (getCalls === 1) {
      return { ...targetTab, status: 'loading' }
    }
    targetTab.status = 'complete'
    return { ...targetTab, status: 'complete' }
  }
  globalThis.chrome = env.chrome
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let timeoutCallback = null
  globalThis.setTimeout = callback => {
    timeoutCallback = callback
    return { fakeTimer: true }
  }
  globalThis.clearTimeout = () => {
    timeoutCallback = null
  }
  resetLoadTsModuleCaches()
  try {
    const { waitForTargetTabLoaded } = await loadTsModule('src/background/agent-capture-target.ts')
    const waiting = waitForTargetTabLoaded(2, Date.now() + 60000)
    await Promise.resolve()
    await Promise.resolve()
    timeoutCallback?.()

    const loaded = await waiting
    assert.equal(loaded.status, 'complete')
    assert.ok(getCalls >= 2)
    assert.equal(env.tabEvents.onUpdated.length, 0)
    assert.equal(env.tabEvents.onRemoved.length, 0)
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

test('startup recovery ignores captures created after recovery starts', async () => {
  resetLoadTsModuleCaches()
  const env = makeChrome()
  enableBridgeStatusAck(env)
  enableFastHeaderFallback()
  const originalGet = env.chrome.storage.session.get
  const originalSet = env.chrome.storage.session.set
  let recoveryReadStarted = false
  let releaseRecoveryRead
  let resolveCaptureStateSaved
  const captureStateSaved = new Promise(resolve => {
    resolveCaptureStateSaved = resolve
  })
  env.chrome.storage.session.get = async key => {
    if (key === 'agent-capture:index' && !recoveryReadStarted) {
      recoveryReadStarted = true
      return new Promise(resolve => {
        releaseRecoveryRead = () => resolve(originalGet(key))
      })
    }
    return originalGet(key)
  }
  env.chrome.storage.session.set = async value => {
    await originalSet(value)
    if (Object.keys(value).includes(`agent-capture:${captureId}`)) resolveCaptureStateSaved()
  }
  globalThis.chrome = env.chrome
  const [{ registerBridgeSession }, { startAgentCapture, registerAgentProfileTransferPort }, { getAgentCaptureState }] =
    await Promise.all([
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
  const recovery = loadTsModule('src/background/index.ts')
  await waitForCondition(() => recoveryReadStarted)

  const start = startAgentCapture(
    {
      type: 'START_AGENT_CAPTURE',
      captureId,
      sessionId,
      nonce,
      bridgeOrigin: 'http://127.0.0.1:17370',
      request: { ...baseRequest, options: { ...baseRequest.options, targetMode: 'new_tab' } },
      capabilities: { ...fullCapabilities }
    },
    { url: `http://127.0.0.1:17370/bridge?session=${sessionId}&capture=${captureId}&nonce=${nonce}`, tab: { id: 1, windowId: 1 } }
  )
  await Promise.race([captureStateSaved, new Promise(resolve => setTimeout(resolve, 50))])
  releaseRecoveryRead()
  const response = await start
  assert.equal(response.ok, true)
  await recovery
  await new Promise(resolve => setTimeout(resolve, 20))
  await waitForProfileTransferComplete(env)

  assert.equal(
    env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error?.code === 'SERVICE_WORKER_RESTARTED'),
    false
  )
  assert.equal(env.messages.some(message => message.type === 'AGENT_CAPTURE_STATUS' && message.payload.error), false)
  assert.equal((await getAgentCaptureState(captureId))?.error, undefined)
  delete globalThis.chrome
  restoreFetch()
  resetLoadTsModuleCaches()
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
