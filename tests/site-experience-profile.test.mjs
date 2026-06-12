import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadTsModule, resetLoadTsModuleCaches } from './helpers/load-ts-module.mjs'
import identifiers from './fixtures/bridge-protocol-identifiers.json' with { type: 'json' }

test('unit tests run with a 60 second timeout guard', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(pkg.scripts['test:unit'], /--test-timeout=60000/)
})

test('normalizes agent bridge opt-in as a local-only setting', async () => {
  const { defaultSettings, normalizeSettings, normalizeSettingsWithLocalOptIn } = await loadTsModule('src/utils/normalize-settings.ts')

  assert.equal(defaultSettings().agentBridgeEnabled, false)
  assert.equal(defaultSettings().agentBridgeAllowAllNetworkTargets, false)
  assert.equal(normalizeSettings({}).agentBridgeEnabled, false)
  assert.equal(normalizeSettings({ agentBridgeEnabled: 'true' }, { allowAgentBridge: true }).agentBridgeEnabled, false)
  assert.equal(normalizeSettings({ agentBridgeEnabled: true }).agentBridgeEnabled, false)
  assert.equal(normalizeSettings({ agentBridgeEnabled: true }, { allowAgentBridge: true }).agentBridgeEnabled, true)
  assert.equal(normalizeSettings({ agentBridgeAllowAllNetworkTargets: true }).agentBridgeAllowAllNetworkTargets, false)
  assert.equal(normalizeSettings({ agentBridgeAllowAllNetworkTargets: true }, { allowAgentBridge: true, allowAgentBridgeNetworkOverride: true }).agentBridgeAllowAllNetworkTargets, false)
  assert.equal(normalizeSettingsWithLocalOptIn({ agentBridgeEnabled: true }, {}).agentBridgeEnabled, false)
  assert.equal(normalizeSettingsWithLocalOptIn({}, { agentBridgeEnabled: true }).agentBridgeEnabled, true)
  assert.equal(
    normalizeSettingsWithLocalOptIn({ agentBridgeAllowAllNetworkTargets: true }, {}).agentBridgeAllowAllNetworkTargets,
    false
  )
  assert.equal(
    normalizeSettingsWithLocalOptIn({}, { agentBridgeAllowAllNetworkTargets: true }).agentBridgeAllowAllNetworkTargets,
    false
  )
  assert.equal(
    normalizeSettingsWithLocalOptIn({}, { agentBridgeEnabled: true, agentBridgeAllowAllNetworkTargets: true })
      .agentBridgeAllowAllNetworkTargets,
    true
  )
  assert.equal(
    normalizeSettingsWithLocalOptIn({ disabledTechnologies: ['React'] }, { agentBridgeEnabled: true }).disabledTechnologies[0],
    'React'
  )
})

test('detector settings cache keeps local agent bridge opt-in during sync updates', async () => {
  const storage = {
    sync: { stackPrismSettings: { disabledTechnologies: [] } },
    local: { stackPrismSettings: { agentBridgeEnabled: true, agentBridgeAllowAllNetworkTargets: true } }
  }
  globalThis.chrome = {
    storage: {
      sync: { get: async () => storage.sync },
      local: { get: async () => storage.local }
    }
  }
  const { applyDetectorSettingsUpdate, loadDetectorSettings } = await loadTsModule('src/background/detector-settings.ts')

  assert.equal((await loadDetectorSettings()).agentBridgeEnabled, true)
  assert.equal((await loadDetectorSettings()).agentBridgeAllowAllNetworkTargets, true)
  const updated = applyDetectorSettingsUpdate(
    { disabledTechnologies: ['React'] },
    { agentBridgeEnabled: true, agentBridgeAllowAllNetworkTargets: true }
  )

  assert.equal(updated.agentBridgeEnabled, true)
  assert.equal(updated.agentBridgeAllowAllNetworkTargets, true)
  assert.deepEqual(updated.disabledTechnologies, ['React'])
  delete globalThis.chrome
})

test('detector settings preserves sync settings when local opt-in storage is unavailable', async () => {
  resetLoadTsModuleCaches()
  globalThis.chrome = {
    storage: {
      sync: { get: async () => ({ stackPrismSettings: { disabledTechnologies: ['React'] } }) },
      local: {
        get: async () => {
          const error = new Error('local unavailable token=secret nonce=n_SECRETSECRETSECRETSECRET')
          error.name = 'LocalSettingsError spb_ABCDEFGHIJKLMNOPQRSTUVWxy123456789012345'
          throw error
        }
      }
    }
  }
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args)
  const { loadDetectorSettings } = await loadTsModule('src/background/detector-settings.ts')

  try {
    const settings = await loadDetectorSettings()
    assert.deepEqual(settings.disabledTechnologies, ['React'])
    assert.equal(settings.agentBridgeEnabled, false)
    assert.equal(settings.agentBridgeAllowAllNetworkTargets, false)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0][1], 'stackPrismSettings')
    assert.notEqual(warnings[0][2] instanceof Error, true)
    assert.equal(JSON.stringify(warnings).includes('token=secret'), false)
    assert.equal(JSON.stringify(warnings).includes('nonce='), false)
    assert.equal(JSON.stringify(warnings).includes('spb_'), false)
  } finally {
    console.warn = originalWarn
  }
  delete globalThis.chrome
})

test('firefox data consent helpers request only Agent Bridge optional categories', async () => {
  const requested = []
  let getAllCalled = false
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({
        browser_specific_settings: {
          gecko: {
            data_collection_permissions: {
              optional: ['browsingActivity', 'technicalAndInteraction', 'websiteContent']
            }
          }
        }
      })
    },
    permissions: {
      getAll: async () => {
        getAllCalled = true
        return { data_collection: ['browsingActivity'] }
      },
      request: async permissions => {
        assert.equal(getAllCalled, false)
        requested.push(permissions)
        return true
      }
    }
  }
  const { AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS, hasAgentBridgeDataConsent, requestAgentBridgeDataConsent } =
    await loadTsModule('src/utils/firefox-data-consent.ts')

  assert.deepEqual(AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS, ['browsingActivity', 'technicalAndInteraction', 'websiteContent'])
  assert.equal(await hasAgentBridgeDataConsent(), false)
  getAllCalled = false
  const requestedConsent = requestAgentBridgeDataConsent()
  assert.deepEqual(requested, [{ data_collection: ['browsingActivity', 'technicalAndInteraction', 'websiteContent'] }])
  assert.equal(getAllCalled, false)
  assert.equal(await requestedConsent, true)
  assert.deepEqual(requested, [{ data_collection: ['browsingActivity', 'technicalAndInteraction', 'websiteContent'] }])
  delete globalThis.chrome
})

test('firefox data consent helpers do not block browsers without the data consent API', async () => {
  globalThis.chrome = { permissions: {} }
  const { hasAgentBridgeDataConsent, requestAgentBridgeDataConsent } = await loadTsModule('src/utils/firefox-data-consent.ts')

  assert.equal(await hasAgentBridgeDataConsent(), true)
  assert.equal(await requestAgentBridgeDataConsent(), true)
  delete globalThis.chrome
})

test('firefox data consent helpers skip request outside Firefox data collection manifests', async () => {
  globalThis.chrome = {
    runtime: { getManifest: () => ({}) },
    permissions: {
      request: async () => {
        throw new Error('request should not be called')
      }
    }
  }
  const { requestAgentBridgeDataConsent } = await loadTsModule('src/utils/firefox-data-consent.ts')

  assert.equal(await requestAgentBridgeDataConsent(), true)
  delete globalThis.chrome
})

test('firefox data consent rollback removes only categories granted by the pending request', async () => {
  const removed = []
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({
        browser_specific_settings: {
          gecko: {
            data_collection_permissions: {
              optional: ['browsingActivity', 'technicalAndInteraction', 'websiteContent']
            }
          }
        }
      })
    },
    permissions: {
      remove: async permissions => {
        removed.push(permissions)
        return true
      }
    }
  }
  const { rollbackAgentBridgeDataConsent } = await loadTsModule('src/utils/firefox-data-consent.ts')

  assert.equal(
    await rollbackAgentBridgeDataConsent({
      supported: true,
      granted: ['browsingActivity'],
      missing: ['technicalAndInteraction', 'websiteContent']
    }),
    true
  )
  assert.deepEqual(removed, [{ data_collection: ['technicalAndInteraction', 'websiteContent'] }])

  removed.length = 0
  assert.equal(
    await rollbackAgentBridgeDataConsent({
      supported: true,
      granted: ['browsingActivity', 'technicalAndInteraction', 'websiteContent'],
      missing: []
    }),
    false
  )
  assert.deepEqual(removed, [])
  delete globalThis.chrome
})

test('firefox data consent revoke removes currently granted Agent Bridge categories', async () => {
  const removed = []
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({
        browser_specific_settings: {
          gecko: {
            data_collection_permissions: {
              optional: ['browsingActivity', 'technicalAndInteraction', 'websiteContent']
            }
          }
        }
      })
    },
    permissions: {
      getAll: async () => ({ data_collection: ['browsingActivity', 'websiteContent'] }),
      remove: async permissions => {
        removed.push(permissions)
        return true
      }
    }
  }
  const { revokeAgentBridgeDataConsent } = await loadTsModule('src/utils/firefox-data-consent.ts')

  assert.equal(await revokeAgentBridgeDataConsent(), true)
  assert.deepEqual(removed, [{ data_collection: ['browsingActivity', 'websiteContent'] }])
  delete globalThis.chrome
})

test('firefox data consent removal detection is limited to Agent Bridge categories', async () => {
  const { includesAgentBridgeDataConsentRemoval } = await loadTsModule('src/utils/firefox-data-consent.ts')

  assert.equal(includesAgentBridgeDataConsentRemoval({ data_collection: ['websiteContent'] }), true)
  assert.equal(includesAgentBridgeDataConsentRemoval({ data_collection: ['browsingActivity'] }), true)
  assert.equal(includesAgentBridgeDataConsentRemoval({ data_collection: ['technicalAndInteraction'] }), true)
  assert.equal(includesAgentBridgeDataConsentRemoval({ data_collection: ['locationInfo'] }), false)
  assert.equal(includesAgentBridgeDataConsentRemoval({ permissions: ['tabs'] }), false)
  assert.equal(includesAgentBridgeDataConsentRemoval(null), false)
})

test('defines the site experience schema and required capabilities', async () => {
  const contract = await loadTsModule('src/types/agent-bridge.ts')

  assert.equal(contract.bridgeProtocolVersion, 1)
  assert.equal(contract.SITE_EXPERIENCE_PROFILE_SCHEMA, 'stackprism.site_experience_profile.v1')
  assert.deepEqual(contract.REQUIRED_AGENT_BRIDGE_CAPABILITIES, [
    'agentBridge',
    'siteExperienceProfileV1',
    'profileChunkTransport',
    'bridgeContentPost',
    'storageSession',
    'experienceProfiler'
  ])
  assert.equal(contract.AGENT_BRIDGE_CAPABILITIES.includes('visualScreenshot'), true)
})

test('validates all protocol identifiers with fixed ascii contracts', async () => {
  const { validateProtocolIdentifier } = await loadTsModule('src/types/agent-bridge.ts')

  for (const [kind, cases] of Object.entries(identifiers)) {
    for (const value of cases.valid) {
      assert.equal(validateProtocolIdentifier(kind, value), true, `${kind} should accept ${value}`)
    }
    for (const value of cases.invalid) {
      assert.equal(validateProtocolIdentifier(kind, value), false, `${kind} should reject ${value}`)
    }
  }
})

test('exports the first-version bridge error code contract', async () => {
  const { AGENT_BRIDGE_ERROR_CODES } = await loadTsModule('src/types/agent-bridge.ts')
  const required = [
    'NOT_FOUND',
    'METHOD_NOT_ALLOWED',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'ORIGIN_NOT_ALLOWED',
    'UNSUPPORTED_MEDIA_TYPE',
    'UNSUPPORTED_TRANSFER_ENCODING',
    'INVALID_JSON',
    'INVALID_REQUEST',
    'REQUEST_TOO_LARGE',
    'REQUEST_TIMEOUT',
    'SERVER_BUSY',
    'STALE_STATUS_UPDATE',
    'PORT_IN_USE',
    'BRIDGE_INVALID_ENV',
    'BRIDGE_START_FAILED',
    'BRIDGE_START_TIMEOUT',
    'BRIDGE_READY_PARSE_FAILED',
    'BRIDGE_PROTOCOL_UNSUPPORTED',
    'BRIDGE_PAGE_RENDER_FAILED',
    'BRIDGE_REQUEST_TIMEOUT',
    'BRIDGE_REQUEST_MISMATCH',
    'AGENT_BRIDGE_DISABLED',
    'CAPTURE_BUSY',
    'CAPTURE_TIMEOUT',
    'EXTENSION_NOT_CONNECTED',
    'BROWSER_OPEN_FAILED',
    'BRIDGE_TOKEN_CANNOT_READ_PROFILE',
    'PRIVATE_NETWORK_TARGET_BLOCKED',
    'TARGET_DNS_LOOKUP_FAILED',
    'BRIDGE_SELF_TARGET_BLOCKED',
    'FINAL_URL_BLOCKED',
    'ACTIVE_TAB_UNAVAILABLE',
    'ACTIVE_TAB_MISMATCH',
    'INCOGNITO_NOT_SUPPORTED',
    'TARGET_LOAD_TIMEOUT',
    'TARGET_LOAD_FAILED',
    'TARGET_INJECTION_FAILED',
    'TARGET_TAB_CLOSED',
    'BRIDGE_TAB_CLOSED',
    'TARGET_NAVIGATED_AWAY',
    'SERVICE_WORKER_RESTARTED',
    'BRIDGE_TRANSPORT_DISCONNECTED',
    'PROFILE_TRANSPORT_FAILED',
    'PROFILE_CHUNK_MISSING',
    'PROFILE_HASH_MISMATCH',
    'PROFILE_TOO_LARGE',
    'RATE_LIMITED',
    'NONCE_REUSED',
    'CAPTURE_ALREADY_COMPLETED',
    'CAPTURE_RESULT_EXPIRED',
    'NOT_SUPPORTED'
  ]

  for (const code of required) assert.equal(AGENT_BRIDGE_ERROR_CODES.includes(code), true, `${code} missing`)
  assert.equal(new Set(AGENT_BRIDGE_ERROR_CODES).size, AGENT_BRIDGE_ERROR_CODES.length)
})

test('message runtime field contracts do not carry bridge tokens or profile wrappers', async () => {
  const contract = await loadTsModule('src/types/agent-bridge.ts')

  assert.equal(contract.START_AGENT_CAPTURE_MESSAGE_FIELDS.includes('bridgeToken'), false)
  assert.equal(contract.START_AGENT_CAPTURE_MESSAGE_FIELDS.includes('callbackUrl'), false)
  assert.equal(contract.PROFILE_TRANSFER_BEGIN_FIELDS.includes('profile'), false)
  assert.equal(contract.PROFILE_TRANSFER_CHUNK_FIELDS.includes('profile'), false)
  assert.equal(contract.PROFILE_TRANSFER_COMPLETE_FIELDS.includes('profile'), false)
})

test('redacts sensitive headers in header records', async () => {
  const { buildHeaderRecord } = await loadTsModule('src/background/headers.ts')
  const record = buildHeaderRecord(
    {
      requestId: 'req-1',
      url: 'https://example.com/app?token=secret#hash',
      type: 'main_frame',
      method: 'GET',
      statusCode: 200,
      statusLine: 'HTTP/2 200',
      responseHeaders: [
        { name: 'server', value: 'nginx/1.25.0' },
        { name: 'set-cookie', value: 'sid=abc; Path=/, theme=dark; Path=/' },
        { name: 'cookie', value: 'sid=abc' },
        { name: 'authorization', value: 'Bearer secret' },
        { name: 'proxy-authorization', value: 'Basic secret' },
        { name: 'x-api-key', value: 'key-secret' },
        { name: 'x-session-token', value: 'session-secret' }
      ]
    },
    {
      interestingHeaders: ['server', 'set-cookie', 'cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-session-token']
    },
    {}
  )

  assert.equal(record.headers['set-cookie'], 'sid, theme')
  assert.equal(record.allHeaders['set-cookie'], 'sid, theme')
  for (const name of ['cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-session-token']) {
    assert.equal(record.headers[name], '[redacted]')
    assert.equal(record.allHeaders[name], '[redacted]')
  }
})

test('popup results ignore cross-site HTTP protocol observations', async () => {
  resetLoadTsModuleCaches()
  const originalChrome = globalThis.chrome
  const originalFetch = globalThis.fetch
  globalThis.chrome = {
    runtime: {
      getURL: path => `chrome-extension://stackprism/${path}`
    }
  }
  globalThis.fetch = async url => {
    const text = String(url)
    if (text.endsWith('/rules/index.json')) return new Response(JSON.stringify({ schemaVersion: 1, files: [] }), { status: 200 })
    if (text.endsWith('/tech-links.json')) return new Response(JSON.stringify({ links: {} }), { status: 200 })
    return new Response('{}', { status: 200 })
  }

  try {
    const { buildPopupCacheRecord, buildPopupRawResult } = await loadTsModule('src/background/popup-cache.ts')
    const data = {
      updatedAt: 1,
      page: { url: 'https://app.example.com/dashboard', title: 'Dashboard', technologies: [] },
      main: { url: 'https://app.example.com/dashboard', technologies: [], headers: {}, headerCount: 0 },
      apis: [
        { url: 'https://api.example.com/graphql', httpProtocol: '2', technologies: [] },
        { url: 'https://payments.example-cdn.test/session', httpProtocol: '3', technologies: [] }
      ],
      frames: [{ url: 'https://checkout.example-cdn.test/embed', httpProtocol: 'h3', technologies: [] }]
    }
    const settings = {}
    const tab = { url: 'https://app.example.com/dashboard', title: 'Dashboard' }

    const raw = await buildPopupRawResult(data, settings, tab)
    const popup = await buildPopupCacheRecord(data, settings, tab)
    const rawNames = raw.technologies.map(tech => tech.name).sort()
    const popupNames = popup.technologies.map(tech => tech.name).sort()

    assert.deepEqual(rawNames, ['HTTP/2'])
    assert.deepEqual(popupNames, ['HTTP/2'])
    assert.match(raw.technologies[0].evidence.join('\n'), /api\.example\.com/)
    assert.doesNotMatch(JSON.stringify([...raw.technologies, ...popup.technologies]), /example-cdn\.test|HTTP\/3/)
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('popup same-site filtering uses current tab URL when page detection is stale', async () => {
  resetLoadTsModuleCaches()
  const originalChrome = globalThis.chrome
  const originalFetch = globalThis.fetch
  globalThis.chrome = {
    runtime: {
      getURL: path => `chrome-extension://stackprism/${path}`
    }
  }
  globalThis.fetch = async url => {
    const text = String(url)
    if (text.endsWith('/rules/index.json')) return new Response(JSON.stringify({ schemaVersion: 1, files: [] }), { status: 200 })
    if (text.endsWith('/tech-links.json')) return new Response(JSON.stringify({ links: {} }), { status: 200 })
    return new Response('{}', { status: 200 })
  }

  try {
    const { buildPopupCacheRecord, buildPopupRawResult } = await loadTsModule('src/background/popup-cache.ts')
    const data = {
      updatedAt: 1,
      page: { url: 'https://old.example.test/app', title: 'Old page', technologies: [] },
      main: {
        url: 'https://app.example.com/dashboard',
        technologies: [],
        headers: {},
        headerCount: 0,
        httpProtocol: '2'
      },
      apis: [
        {
          url: 'https://api.example.com/graphql',
          httpProtocol: '2',
          technologies: [
            { category: 'Web 服务器', name: 'nginx', confidence: '中', evidence: ['server: nginx'], source: '响应头' },
            { category: 'CDN / 托管', name: 'Cloudflare', confidence: '高', evidence: ['cf-ray'], source: '响应头' },
            { category: '后端 / 服务器框架', name: 'Express', confidence: '中', evidence: ['x-powered-by'], source: '响应头' }
          ]
        },
        {
          url: 'https://tracker.third-party.test/pixel',
          httpProtocol: '3',
          technologies: [{ category: 'Web 服务器', name: 'third-party-nginx', confidence: '中', evidence: ['server'], source: '响应头' }]
        }
      ]
    }
    const settings = {}
    const tab = { url: 'https://app.example.com/dashboard', title: 'Dashboard' }

    const raw = await buildPopupRawResult(data, settings, tab)
    const popup = await buildPopupCacheRecord(data, settings, tab)
    const rawNames = raw.technologies.map(tech => tech.name).sort()
    const popupNames = popup.technologies.map(tech => tech.name).sort()

    assert.deepEqual(rawNames, ['Cloudflare', 'Express', 'HTTP/2', 'nginx'])
    assert.deepEqual(popupNames, ['Cloudflare', 'Express', 'HTTP/2', 'nginx'])
    assert.equal(raw.url, 'https://app.example.com/dashboard')
    assert.equal(popup.url, 'https://app.example.com/dashboard')
    assert.doesNotMatch(JSON.stringify([...raw.technologies, ...popup.technologies]), /third-party-nginx|HTTP\/3/)
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('popup results keep intentional cross-site service detections and drop infrastructure detections', async () => {
  resetLoadTsModuleCaches()
  const originalChrome = globalThis.chrome
  const originalFetch = globalThis.fetch
  globalThis.chrome = {
    runtime: {
      getURL: path => `chrome-extension://stackprism/${path}`
    }
  }
  globalThis.fetch = async url => {
    const text = String(url)
    if (text.endsWith('/rules/index.json')) return new Response(JSON.stringify({ schemaVersion: 1, files: [] }), { status: 200 })
    if (text.endsWith('/tech-links.json')) return new Response(JSON.stringify({ links: {} }), { status: 200 })
    return new Response('{}', { status: 200 })
  }

  try {
    const { buildPopupCacheRecord, buildPopupRawResult } = await loadTsModule('src/background/popup-cache.ts')
    const data = {
      updatedAt: 1,
      page: { url: 'https://shop.example.com/checkout', title: 'Checkout', technologies: [] },
      main: { url: 'https://shop.example.com/checkout', technologies: [], headers: {}, headerCount: 0 },
      apis: [
        {
          url: 'https://api.stripe.com/v1/payment_intents',
          technologies: [
            { category: '支付系统', name: 'Stripe', confidence: '高', evidence: ['Stripe API response'], source: '响应头' },
            { category: 'Headless CMS', name: 'Contentful', confidence: '高', evidence: ['cdn.contentful.com'], source: '响应头' },
            { category: 'IP 地理位置 / IP 情报', name: 'IPinfo', confidence: '高', evidence: ['ipinfo.io'], source: '响应头' },
            { category: 'CDN / 托管', name: 'Cloudflare', confidence: '高', evidence: ['cf-ray'], source: '响应头' },
            { category: 'Web 服务器', name: 'nginx', confidence: '中', evidence: ['server: nginx'], source: '响应头' }
          ]
        }
      ],
      frames: [
        {
          url: 'https://accounts.google.com/o/oauth2/v2/auth',
          technologies: [
            { category: '第三方登录 / OAuth', name: 'Google Sign-In', confidence: '高', evidence: ['accounts.google.com'], source: '响应头' }
          ]
        }
      ]
    }
    const settings = {}
    const tab = { url: 'https://shop.example.com/checkout', title: 'Checkout' }

    const raw = await buildPopupRawResult(data, settings, tab)
    const popup = await buildPopupCacheRecord(data, settings, tab)
    const rawNames = raw.technologies.map(tech => tech.name).sort()
    const popupNames = popup.technologies.map(tech => tech.name).sort()

    assert.deepEqual(rawNames, ['Contentful', 'Google Sign-In', 'IPinfo', 'Stripe'])
    assert.deepEqual(popupNames, ['Contentful', 'Google Sign-In', 'IPinfo', 'Stripe'])
    assert.match(raw.technologies.find(tech => tech.name === 'Stripe').sources.join('\n'), /API/)
    assert.match(raw.technologies.find(tech => tech.name === 'Contentful').sources.join('\n'), /API/)
    assert.match(raw.technologies.find(tech => tech.name === 'IPinfo').sources.join('\n'), /API/)
    assert.doesNotMatch(JSON.stringify([...raw.technologies, ...popup.technologies]), /Cloudflare|nginx/)
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('same-site comparison treats common public hosting tenants as separate sites', async () => {
  const { getRegistrableDomain, isSameSite } = await loadTsModule('src/utils/domain.ts')

  assert.equal(getRegistrableDomain('foo.github.io'), 'foo.github.io')
  assert.equal(getRegistrableDomain('bar.github.io'), 'bar.github.io')
  assert.equal(isSameSite('https://bar.github.io/api', 'https://foo.github.io/app'), false)
  assert.equal(isSameSite('https://assets.foo.github.io/app.js', 'https://foo.github.io/app'), true)
  assert.equal(isSameSite('https://bar.vercel.app/api', 'https://foo.vercel.app/app'), false)
  assert.equal(isSameSite('https://bar.netlify.app/api', 'https://foo.netlify.app/app'), false)
  assert.equal(isSameSite('https://bar.pages.dev/api', 'https://foo.pages.dev/app'), false)
  assert.equal(getRegistrableDomain('foo.up.railway.app'), 'foo.up.railway.app')
  assert.equal(getRegistrableDomain('bar.up.railway.app'), 'bar.up.railway.app')
  assert.equal(isSameSite('https://bar.up.railway.app/api', 'https://foo.up.railway.app/app'), false)
  assert.equal(isSameSite('https://assets.foo.up.railway.app/app.js', 'https://foo.up.railway.app/app'), true)
})

test('builds a redacted site experience profile from raw popup data and experience signals', async () => {
  const { buildSiteExperienceProfile } = await loadTsModule('src/utils/site-experience-profile.ts')
  const capabilities = {
    agentBridge: true,
    siteExperienceProfileV1: true,
    profileChunkTransport: true,
    bridgeContentPost: true,
    storageSession: true,
    experienceProfiler: true,
    rawProfile: true,
    viewportMetadata: true
  }

  const profile = buildSiteExperienceProfile({
    captureId: 'cap_CCCCCCCCCCCCCCCCCCCCCC',
    request: {
      url: 'https://example.com/account/sessionId/reset-token?token=secret#frag',
      mode: 'experience',
      waitMs: 1000,
      include: ['tech', 'visual', 'layout', 'components', 'interaction', 'ux', 'assets'],
      viewports: [{ name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 }],
      options: {
        forceRefresh: false,
        captureScreenshotMetadata: false,
        captureScreenshot: false,
        keepTabOpen: false,
        allowPrivateNetworkTarget: false,
        targetMode: 'reuse_or_new_tab',
        maxResourceUrls: 2
      },
      protocolVersion: 1
    },
    raw: {
      url: 'https://example.com/account/sessionId/reset-token?token=secret#frag',
      title: 'Dashboard',
      generatedAt: '2026-05-22T06:00:00.000Z',
      technologies: [
        {
          category: '前端框架',
          name: 'Vue',
          version: '3.4.0',
          confidence: '高',
          sources: ['页面扫描'],
          evidence: ['window.__VUE__ token=secret'],
          url: 'https://vuejs.org/apiKey/privateKey?session=abc#docs'
        },
        {
          category: '实验',
          name: 'GuessLib',
          confidence: '低',
          sources: ['启发式']
        }
      ],
      resources: {
        total: 4,
        scripts: ['https://cdn.example.com/assets/sessionId/app.js?signature=abc#bundle'],
        stylesheets: ['https://cdn.example.com/privateKey/app.css?theme=dark'],
        themeAssetUrls: ['https://cdn.example.com/logo/token-secret.png?auth=secret'],
        resourceDomains: [{ domain: 'cdn.example.com', count: 3 }],
        cssVariableCount: 12,
        metaGenerator: 'AcmeCMS',
        manifest: 'https://example.com/apiKey/manifest.json?key=secret'
      },
      headers: [
        { name: 'authorization', value: 'Bearer secret' },
        { name: 'set-cookie', value: 'sid, theme' }
      ]
    },
    experience: {
      visual: { colors: ['#123456'], aboveFold: { heroText: 'Hi user@example.com' } },
      layout: { landmarks: ['header', 'main'], boundingBoxes: [{ text: 'secret@example.com', x: 1, y: 2 }] },
      components: { counts: { button: 2, card: 1 }, samples: [{ type: 'button', text: '支付 ￥199 给 张三 13800138000' }] },
      interaction: {
        passive: true,
        transitions: ['opacity 0.2s'],
        animations: ['fade'],
        focusHoverHints: ['.cta:hover{background:url("https://cdn.example.com/hover.png?preview=abc&token=secret#frag")}'],
        closedShadowRoots: 1
      },
      document: { language: 'zh-CN' },
      ux: {
        pagePurpose: 'SaaS dashboard token=secret',
        primaryUserPath: 'Open reports and export data',
        informationHierarchy: ['Header', 'KPI cards', 'Report table'],
        ctaStrategy: ['Export report', 'Create task'],
        trustSignals: ['SOC2 badge'],
        navigationDepth: 'top-nav + side-nav',
        contentGrouping: ['summary', 'details'],
        frictionPoints: ['Long table without visible filters'],
        textSamples: ['联系 user@example.com 或 13800138000，订单 1234567890123，金额 ￥199，联系人 张三']
      },
      assets: { urls: ['https://cdn.example.com/secretToken/private.woff2?token=abc#font'] },
      evidence: {
        inaccessibleStylesheets: 2,
        crossOriginIframes: 1,
        omitted: { resourceUrls: 3, textSamples: 2, componentSamples: 1, cssRules: 4, executeScriptResultOverLimit: 2 }
      }
    },
    capabilities,
    finalUrl: 'https://example.com/account/sessionId/reset-token?session=abc#final'
  })

  const serialized = JSON.stringify(profile)
  assert.equal(profile.schema, 'stackprism.site_experience_profile.v1')
  assert.equal(profile.captureId, 'cap_CCCCCCCCCCCCCCCCCCCCCC')
  assert.deepEqual(profile.browserContext.extensionCapabilities, capabilities)
  assert.equal(profile.browserContext.viewportMode, 'current_viewport')
  assert.equal(profile.target.language, 'zh-CN')
  assert.equal(profile.techProfile.technologies.length, 2)
  assert.equal(profile.assetProfile.resourceUrls.length, 2)
  assert.equal(profile.uxProfile.pagePurpose, 'SaaS dashboard token=[redacted]')
  assert.deepEqual(profile.uxProfile.informationHierarchy, ['Header', 'KPI cards', 'Report table'])
  assert.deepEqual(profile.uxProfile.ctaStrategy, ['Export report', 'Create task'])
  assert.deepEqual(profile.uxProfile.trustSignals, ['SOC2 badge'])
  assert.equal(profile.uxProfile.navigationDepth, 'top-nav + side-nav')
  assert.deepEqual(profile.uxProfile.contentGrouping, ['summary', 'details'])
  assert.deepEqual(profile.uxProfile.frictionPoints, ['Long table without visible filters'])
  assert.equal(profile.evidence.truncation.resourceUrls, 3)
  assert.equal(profile.evidence.truncation.executeScriptResultOverLimit, 2)
  assert.equal(profile.visualProfile.aboveFold, undefined)
  assert.equal(profile.layoutProfile.boundingBoxes, undefined)
  assert.ok(profile.limitations.includes('viewport_emulation_unsupported'))
  assert.ok(profile.limitations.includes('screenshot_metadata_not_requested'))
  assert.ok(profile.limitations.includes('screenshot_image_not_requested'))
  assert.ok(profile.limitations.includes('cross_origin_iframes_limited'))
  assert.ok(profile.limitations.includes('closed_shadow_roots_limited'))
  assert.ok(profile.limitations.includes('stylesheet_access_limited'))
  assert.ok(profile.limitations.includes('resource_urls_truncated'))
  assert.ok(profile.limitations.includes('text_samples_truncated'))
  assert.ok(profile.limitations.includes('component_samples_truncated'))
  assert.ok(profile.limitations.includes('css_rules_truncated'))
  assert.ok(profile.limitations.includes('execute_script_result_truncated'))
  assert.match(profile.agentGuidance.summary, /Vue/)
  assert.doesNotMatch(profile.agentGuidance.summary, /secret|user@example\.com|13800138000|\u0000/)
  assert.match(profile.agentGuidance.recreationPlan.objective, /Recreate/)
  assert.deepEqual(profile.agentGuidance.recreationPlan.designTokens.colors, ['#123456'])
  assert.deepEqual(profile.agentGuidance.recreationPlan.layoutBlueprint.landmarks, ['header', 'main'])
  assert.deepEqual(profile.agentGuidance.recreationPlan.layoutBlueprint.contentGrouping, ['summary', 'details'])
  assert.equal(profile.agentGuidance.recreationPlan.layoutBlueprint.viewportMode, 'current_viewport')
  assert.deepEqual(profile.agentGuidance.recreationPlan.componentInventory.priorityTypes, ['button', 'card'])
  assert.equal(profile.agentGuidance.recreationPlan.componentInventory.sampleCount, 1)
  assert.equal(profile.agentGuidance.recreationPlan.componentInventory.geometryIncluded, false)
  assert.deepEqual(profile.agentGuidance.recreationPlan.interactionChecklist.transitions, ['opacity 0.2s'])
  assert.deepEqual(profile.agentGuidance.recreationPlan.uxChecklist.ctaStrategy, ['Export report', 'Create task'])
  assert.equal(profile.agentGuidance.recreationPlan.assetHints.scriptCount, 1)
  assert.equal(profile.agentGuidance.recreationPlan.assetHints.stylesheetCount, 1)
  assert.deepEqual(profile.agentGuidance.recreationPlan.assetHints.resourceDomains, ['cdn.example.com:3'])
  assert.equal(profile.agentGuidance.recreationPlan.assetHints.resourceUrlCount, 2)
  assert.equal(profile.agentGuidance.recreationPlan.verificationChecklist.length > 0, true)
  assert.deepEqual(profile.visualProfile.colorTokens, ['#123456'])
  assert.equal(profile.visualProfile.screenshot, undefined)
  assert.doesNotMatch(serialized, /secret|Bearer|user@example\.com|13800138000|1234567890123|￥199|张三|preview=abc|sessionId|apiKey|privateKey|reset-token|secretToken|#frag/)
  for (const url of [
    profile.target.url,
    profile.target.finalUrl,
    profile.techProfile.technologies[0].url,
    profile.assetProfile.manifest,
    ...profile.assetProfile.scripts,
    ...profile.assetProfile.stylesheets,
    ...profile.assetProfile.themeAssetUrls,
    ...profile.assetProfile.resourceUrls
  ]) {
    assert.equal(new URL(url).hash, '')
  }
  assert.match(
    serialized,
    /token=\[redacted\]|signature=\[redacted\]|auth=\[redacted\]|session=\[redacted\]|key=\[redacted\]|preview=\[redacted\]/
  )
})

test('builds a site experience profile that preserves requested and final urls separately', async () => {
  const { buildSiteExperienceProfile } = await loadTsModule('src/utils/site-experience-profile.ts')

  const profile = buildSiteExperienceProfile({
    captureId: 'cap_CCCCCCCCCCCCCCCCCCCCCC',
    request: {
      url: 'https://example.com/start',
      mode: 'experience',
      waitMs: 0,
      include: ['tech'],
      viewports: [],
      options: {
        forceRefresh: false,
        captureScreenshotMetadata: false,
        captureScreenshot: false,
        keepTabOpen: false,
        allowPrivateNetworkTarget: false,
        targetMode: 'reuse_or_new_tab',
        maxResourceUrls: 300
      },
      protocolVersion: 1
    },
    raw: {
      url: 'https://example.com/final?token=secret#frag',
      title: 'Redirected',
      generatedAt: '2026-05-22T06:00:00.000Z',
      technologies: [],
      resources: null,
      headers: []
    },
    experience: {},
    capabilities: {
      agentBridge: true,
      siteExperienceProfileV1: true,
      profileChunkTransport: true,
      bridgeContentPost: true,
      storageSession: true,
      experienceProfiler: true,
      rawProfile: true,
      viewportMetadata: true
    },
    finalUrl: 'https://example.com/final?token=secret#frag'
  })

  assert.equal(profile.target.url, 'https://example.com/start')
  assert.equal(profile.target.finalUrl, 'https://example.com/final?token=[redacted]')
  assert.equal(profile.target.origin, 'https://example.com')
})

test('build evidence records header coverage for raw header maps', async () => {
  const { buildEvidence } = await loadTsModule('src/utils/site-experience-profile-sections.ts')
  const technologies = [{ category: '前端框架', name: 'Vue', confidence: '高', evidence: [], sources: [] }]
  const experience = {}

  const fromArray = buildEvidence(
    { headers: [{ name: 'x-powered-by', value: 'StackPrism' }], technologies: [], resources: null },
    technologies,
    { resourceUrls: [] },
    experience
  )
  const fromMap = buildEvidence(
    { headers: { 'x-powered-by': 'StackPrism' }, technologies: [], resources: null },
    technologies,
    { resourceUrls: [] },
    experience
  )

  assert.equal(fromArray.sourceCoverage.includes('headers'), true)
  assert.equal(fromMap.sourceCoverage.includes('headers'), true)
})

test('builds optional screenshot payload only when explicitly requested', async () => {
  const { buildSiteExperienceProfile } = await loadTsModule('src/utils/site-experience-profile.ts')
  const profile = buildSiteExperienceProfile({
    captureId: 'cap_CCCCCCCCCCCCCCCCCCCCCC',
    request: {
      url: 'https://example.com/',
      mode: 'experience',
      waitMs: 0,
      include: ['visual'],
      viewports: [],
      options: {
        forceRefresh: false,
        captureScreenshotMetadata: true,
        captureScreenshot: true,
        keepTabOpen: false,
        allowPrivateNetworkTarget: false,
        targetMode: 'new_tab',
        maxResourceUrls: 300
      },
      protocolVersion: 1
    },
    raw: null,
    experience: { visual: { colors: ['#101820'] } },
    screenshot: {
      dataUrl: `data:image/jpeg;base64,${Buffer.from('shot').toString('base64')}`,
      mimeType: 'image/jpeg',
      byteLength: 31,
      source: 'chrome.tabs.captureVisibleTab',
      scope: 'visible_viewport',
      capturedAt: '2026-05-27T00:00:00.000Z'
    },
    capabilities: {
      agentBridge: true,
      siteExperienceProfileV1: true,
      profileChunkTransport: true,
      bridgeContentPost: true,
      storageSession: true,
      experienceProfiler: true,
      rawProfile: false,
      viewportMetadata: true,
      visualScreenshot: true
    },
    finalUrl: 'https://example.com/'
  })

  assert.equal(profile.visualProfile.screenshot.mimeType, 'image/jpeg')
  assert.match(profile.visualProfile.screenshot.dataUrl, /^data:image\/jpeg;base64,/)
  assert.equal(profile.visualProfile.screenshot.scope, 'visible_viewport')
  assert.equal(profile.limitations.includes('screenshot_image_not_requested'), false)
  assert.equal(profile.agentGuidance.recreationPlan.visualReference.screenshotIncluded, true)
})

test('agent guidance sanitizes external profile labels before composing summary', async () => {
  const { buildAgentGuidance } = await loadTsModule('src/utils/site-experience-guidance.ts')
  const guidance = buildAgentGuidance({ primaryFrontend: 'Vue token=secret user@example.com\u0000'.repeat(8) }, [
    'session=abc',
    '联系人 张三',
    'ok\u0000line',
    'ignored'
  ])

  assert.equal(guidance.summary.includes('secret'), false)
  assert.equal(guidance.summary.includes('user@example.com'), false)
  assert.equal(guidance.summary.includes('张三'), false)
  assert.equal(guidance.summary.includes('\u0000'), false)
  assert.match(guidance.summary, /token=\[redacted\]/)
  assert.match(guidance.summary, /session=\[redacted\]/)
  assert.match(guidance.summary, /联系人 \[redacted\]/)
  assert.doesNotMatch(JSON.stringify(guidance.recreationPlan), /secret|user@example\.com|张三|\u0000/)

  const unsafeGuidance = buildAgentGuidance({}, [], {
    visualProfile: { colorTokens: ['token=secret'] },
    uxProfile: { ctaStrategy: ['联系 user@example.com'] },
    assetProfile: { resourceDomains: [{ domain: 'cdn.example.com?token=secret', count: 2 }] }
  })
  assert.match(JSON.stringify(unsafeGuidance.recreationPlan), /token=\[redacted\]/)
  assert.doesNotMatch(JSON.stringify(unsafeGuidance.recreationPlan), /secret|user@example\.com/)
})

test('returns empty sections and section limitations when include excludes experience data', async () => {
  const { buildSiteExperienceProfile } = await loadTsModule('src/utils/site-experience-profile.ts')
  const profile = buildSiteExperienceProfile({
    captureId: 'cap_CCCCCCCCCCCCCCCCCCCCCC',
    request: {
      url: 'https://example.com/',
      mode: 'experience',
      waitMs: 0,
      include: ['tech'],
      viewports: [],
      options: {
        forceRefresh: false,
        captureScreenshotMetadata: true,
        keepTabOpen: false,
        allowPrivateNetworkTarget: false,
        targetMode: 'new_tab',
        maxResourceUrls: 300
      },
      protocolVersion: 1
    },
    raw: null,
    experience: null,
    capabilities: {
      agentBridge: true,
      siteExperienceProfileV1: true,
      profileChunkTransport: true,
      bridgeContentPost: true,
      storageSession: true,
      experienceProfiler: true,
      rawProfile: false,
      viewportMetadata: false
    },
    finalUrl: 'https://example.com/'
  })

  assert.deepEqual(profile.visualProfile, {})
  assert.deepEqual(profile.layoutProfile, {})
  assert.deepEqual(profile.componentProfile, {})
  assert.deepEqual(profile.interactionProfile, {})
  assert.deepEqual(profile.uxProfile, {})
  assert.deepEqual(profile.assetProfile, {})
  assert.deepEqual(profile.agentGuidance.recreationPlan.designTokens.colors, [])
  assert.deepEqual(profile.agentGuidance.recreationPlan.componentInventory.priorityTypes, [])
  for (const section of ['visual', 'layout', 'components', 'interaction', 'ux', 'assets']) {
    assert.ok(profile.limitations.includes(`${section}_section_not_requested`))
  }
})

test('does not emit unrequested experience sections from collected profiler data', async () => {
  const { buildSiteExperienceProfile } = await loadTsModule('src/utils/site-experience-profile.ts')
  const profile = buildSiteExperienceProfile({
    captureId: 'cap_CCCCCCCCCCCCCCCCCCCCCC',
    request: {
      url: 'https://example.com/',
      mode: 'experience',
      waitMs: 0,
      include: ['assets'],
      viewports: [],
      options: {
        forceRefresh: false,
        captureScreenshotMetadata: true,
        keepTabOpen: false,
        allowPrivateNetworkTarget: false,
        targetMode: 'new_tab',
        maxResourceUrls: 300
      },
      protocolVersion: 1
    },
    raw: null,
    experience: {
      visual: { colors: ['#123456'] },
      layout: { landmarks: ['main'] },
      components: { samples: [{ type: 'button', rect: { x: 1, y: 2, width: 3, height: 4 } }] },
      interaction: { animations: ['fade'] },
      ux: { textSamples: ['Sensitive person 13800138000'] },
      assets: { urls: ['https://cdn.example.com/app.js?token=secret#hash'] },
      evidence: { truncation: { resourceUrls: 0, textSamples: 0, componentSamples: 0, cssRules: 0 } }
    },
    capabilities: {
      agentBridge: true,
      siteExperienceProfileV1: true,
      profileChunkTransport: true,
      bridgeContentPost: true,
      storageSession: true,
      experienceProfiler: true,
      rawProfile: false,
      viewportMetadata: false
    },
    finalUrl: 'https://example.com/'
  })

  assert.deepEqual(profile.visualProfile, {})
  assert.deepEqual(profile.layoutProfile, {})
  assert.deepEqual(profile.componentProfile, {})
  assert.deepEqual(profile.interactionProfile, {})
  assert.deepEqual(profile.uxProfile, {})
  assert.equal(profile.assetProfile.resourceUrls.length, 1)
  assert.ok(profile.limitations.includes('visual_section_not_requested'))
  assert.ok(profile.limitations.includes('components_section_not_requested'))
  assert.ok(profile.limitations.includes('tech_section_not_requested'))
  assert.deepEqual(profile.techProfile, {})
})

test('retains screenshot metadata fields only when explicitly requested', async () => {
  const { buildSiteExperienceProfile } = await loadTsModule('src/utils/site-experience-profile.ts')
  const profile = buildSiteExperienceProfile({
    captureId: 'cap_CCCCCCCCCCCCCCCCCCCCCC',
    request: {
      url: 'https://example.com/',
      mode: 'experience',
      waitMs: 0,
      include: ['visual', 'layout', 'components'],
      viewports: [],
      options: {
        forceRefresh: false,
        captureScreenshotMetadata: true,
        keepTabOpen: false,
        allowPrivateNetworkTarget: false,
        targetMode: 'new_tab',
        maxResourceUrls: 300
      },
      protocolVersion: 1
    },
    raw: null,
    experience: {
      visual: { colors: ['#123456'], aboveFold: { heroText: 'Lead' } },
      layout: { landmarks: ['main'], boundingBoxes: [{ selector: 'main', rect: { x: 1, y: 2, width: 3, height: 4 } }] },
      components: { samples: [{ type: 'button', text: 'Buy', rect: { x: 5, y: 6, width: 7, height: 8 } }] },
      evidence: { truncation: {} }
    },
    capabilities: {
      agentBridge: true,
      siteExperienceProfileV1: true,
      profileChunkTransport: true,
      bridgeContentPost: true,
      storageSession: true,
      experienceProfiler: true,
      rawProfile: false,
      viewportMetadata: true
    },
    finalUrl: 'https://example.com/'
  })

  assert.deepEqual(profile.visualProfile.aboveFold, { heroText: 'Lead' })
  assert.equal(profile.layoutProfile.boundingBoxes[0].selector, 'main')
  assert.deepEqual(profile.componentProfile.samples[0].rect, { x: 5, y: 6, width: 7, height: 8 })
  assert.equal(profile.agentGuidance.recreationPlan.componentInventory.geometryIncluded, true)
  assert.equal(profile.limitations.includes('screenshot_metadata_not_requested'), false)
  assert.equal(JSON.stringify(profile).includes('imageData'), false)
})

test('marks component geometry metadata for boundingBox and bounds aliases', async () => {
  const { buildSiteExperienceProfile } = await loadTsModule('src/utils/site-experience-profile.ts')
  const baseInput = {
    captureId: 'cap_CCCCCCCCCCCCCCCCCCCCCC',
    request: {
      url: 'https://example.com/',
      mode: 'experience',
      waitMs: 0,
      include: ['components'],
      viewports: [],
      options: {
        forceRefresh: false,
        captureScreenshotMetadata: true,
        keepTabOpen: false,
        allowPrivateNetworkTarget: false,
        targetMode: 'new_tab',
        maxResourceUrls: 300
      },
      protocolVersion: 1
    },
    raw: null,
    capabilities: {
      agentBridge: true,
      siteExperienceProfileV1: true,
      profileChunkTransport: true,
      bridgeContentPost: true,
      storageSession: true,
      experienceProfiler: true,
      rawProfile: false,
      viewportMetadata: true
    },
    finalUrl: 'https://example.com/'
  }

  for (const geometryKey of ['boundingBox', 'bounds']) {
    const profile = buildSiteExperienceProfile({
      ...baseInput,
      experience: {
        components: { samples: [{ type: 'button', text: 'Buy', [geometryKey]: { x: 1, y: 2, width: 3, height: 4 } }] },
        evidence: { truncation: {} }
      }
    })

    assert.equal(profile.agentGuidance.recreationPlan.componentInventory.geometryIncluded, true)
  }
})

test('uses profiler truncation evidence and strips screenshot metadata aliases when screenshots are disabled', async () => {
  const { buildSiteExperienceProfile } = await loadTsModule('src/utils/site-experience-profile.ts')
  const profile = buildSiteExperienceProfile({
    captureId: 'cap_CCCCCCCCCCCCCCCCCCCCCC',
    request: {
      url: 'https://example.com/',
      mode: 'experience',
      waitMs: 0,
      include: ['components', 'ux', 'assets'],
      viewports: [],
      options: {
        forceRefresh: false,
        captureScreenshotMetadata: false,
        keepTabOpen: false,
        allowPrivateNetworkTarget: false,
        targetMode: 'new_tab',
        maxResourceUrls: 300
      },
      protocolVersion: 1
    },
    raw: null,
    experience: {
      visual: { colors: ['#123456'], bounds: { x: 1, y: 2, width: 3, height: 4 } },
      layout: {
        landmarks: ['main'],
        rect: { x: 4, y: 5, width: 6, height: 7 },
        bounds: { x: 8, y: 9, width: 10, height: 11 },
        boundingBox: { x: 12, y: 13, width: 14, height: 15 }
      },
      components: {
        samples: [
          {
            type: 'button',
            text: 'Buy',
            rect: { x: 1, y: 2, width: 3, height: 4 },
            boundingBox: { x: 5, y: 6, width: 7, height: 8 },
            bounds: { x: 9, y: 10, width: 11, height: 12 }
          }
        ]
      },
      ux: { textSamples: ['Buy now'] },
      assets: { urls: [] },
      evidence: {
        truncation: {
          resourceUrls: 7,
          textSamples: 6,
          componentSamples: 5,
          cssRules: 4,
          executeScriptResult: 3,
          executeScriptResultOverLimit: 2
        }
      },
      limitations: ['passive_interaction_only']
    },
    capabilities: {
      agentBridge: true,
      siteExperienceProfileV1: true,
      profileChunkTransport: true,
      bridgeContentPost: true,
      storageSession: true,
      experienceProfiler: true,
      rawProfile: false,
      viewportMetadata: false
    },
    finalUrl: 'https://example.com/'
  })

  assert.deepEqual(profile.evidence.truncation, {
    resourceUrls: 7,
    textSamples: 6,
    componentSamples: 5,
    cssRules: 4,
    executeScriptResult: 3,
    executeScriptResultOverLimit: 2
  })
  assert.equal(profile.evidence.rawCounts.cssRules, 4)
  const serialized = JSON.stringify({
    visualProfile: profile.visualProfile,
    layoutProfile: profile.layoutProfile,
    componentProfile: profile.componentProfile
  })
  assert.doesNotMatch(serialized, /"rect"|"bounds"|"boundingBox"/)
  assert.ok(profile.limitations.includes('resource_urls_truncated'))
  assert.ok(profile.limitations.includes('text_samples_truncated'))
  assert.ok(profile.limitations.includes('component_samples_truncated'))
  assert.ok(profile.limitations.includes('css_rules_truncated'))
  assert.ok(profile.limitations.includes('execute_script_result_truncated'))
  assert.ok(profile.limitations.includes('passive_interaction_only'))
})

test('marks executeScript result truncation when final profiler output remains oversized', async () => {
  const { buildLimitations } = await loadTsModule('src/utils/site-experience-limitations.ts')
  const limitations = buildLimitations(
    {
      viewports: [],
      include: ['tech', 'visual', 'layout', 'components', 'interaction', 'ux', 'assets'],
      options: { captureScreenshot: true, captureScreenshotMetadata: true }
    },
    {
      evidence: { truncation: { executeScriptResult: 0, executeScriptResultOverLimit: 2 } },
      limitations: []
    }
  )

  assert.ok(limitations.includes('execute_script_result_truncated'))
})

test('redacts sensitive profile object keys and externally supplied limitations', async () => {
  const { buildSiteExperienceProfile } = await loadTsModule('src/utils/site-experience-profile.ts')
  const capabilities = {
    agentBridge: true,
    siteExperienceProfileV1: true,
    profileChunkTransport: true,
    bridgeContentPost: true,
    storageSession: true,
    experienceProfiler: true,
    rawProfile: false,
    viewportMetadata: false
  }

  const profile = buildSiteExperienceProfile({
    captureId: 'cap_CCCCCCCCCCCCCCCCCCCCCC',
    request: {
      url: 'https://example.com/',
      mode: 'experience',
      waitMs: 0,
      include: ['layout', 'interaction'],
      viewports: [],
      options: {
        forceRefresh: false,
        captureScreenshotMetadata: true,
        keepTabOpen: false,
        allowPrivateNetworkTarget: false,
        targetMode: 'new_tab',
        maxResourceUrls: 300
      },
      protocolVersion: 1
    },
    raw: null,
    experience: {
      layout: {
        'token=secret': 'visible',
        safe: { 'authorization=Bearer sk_live_abc123': 'https://cdn.example.com/app.js?signature=abc#frag' },
        'apiToken=spb_secret': 'sessionId=s_secret'
      },
      interaction: {
        'session=abc': 'hover token=secret Authorization: Bearer sk_live_xyz789',
        'secretKey=abc': 'bridgeToken=spbt_secret'
      },
      evidence: { truncation: {} },
      limitations: ['token=secret', 'apiToken=spb_secret', 'bridgeToken=spbt_secret', '联系人 张三', 'safe']
    },
    capabilities,
    finalUrl: 'https://example.com/'
  })

  const serialized = JSON.stringify(profile)
  assert.equal(serialized.includes('token=secret'), false)
  assert.equal(serialized.includes('authorization=Bearer sk_live_abc123'), false)
  assert.equal(serialized.includes('sk_live_abc123'), false)
  assert.equal(serialized.includes('sk_live_xyz789'), false)
  assert.equal(serialized.includes('apiToken=spb_secret'), false)
  assert.equal(serialized.includes('sessionId=s_secret'), false)
  assert.equal(serialized.includes('secretKey=abc'), false)
  assert.equal(serialized.includes('bridgeToken=spbt_secret'), false)
  assert.equal(serialized.includes('signature=abc'), false)
  assert.equal(serialized.includes('#frag'), false)
  assert.equal(serialized.includes('张三'), false)
  assert.equal(serialized.includes('token=[redacted]'), true)
  assert.equal(serialized.includes('apiToken=[redacted]'), true)
  assert.equal(serialized.includes('sessionId=[redacted]'), true)
  assert.equal(serialized.includes('secretKey=[redacted]'), true)
  assert.equal(serialized.includes('bridgeToken=[redacted]'), true)
  assert.equal(serialized.includes('authorization=[redacted]'), true)
  assert.ok(profile.limitations.includes('token=[redacted]'))
  assert.ok(profile.limitations.includes('apiToken=[redacted]'))
  assert.ok(profile.limitations.includes('bridgeToken=[redacted]'))
  assert.ok(profile.limitations.includes('联系人 [redacted]'))
})
