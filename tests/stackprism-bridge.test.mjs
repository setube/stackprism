import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'
import { bridgePageScript, bridgePageStyle } from '../agent-skill/stackprism-site-experience/scripts/bridge/bridge-page-assets.mjs'
import { renderBridgePageHtml } from '../agent-skill/stackprism-site-experience/scripts/bridge/bridge-page.mjs'
import { CaptureStore } from '../agent-skill/stackprism-site-experience/scripts/bridge/capture-store.mjs'
import { createBridgeServer } from '../agent-skill/stackprism-site-experience/scripts/bridge/http-server.mjs'
import {
  openBrowser,
  parseOpenTimeoutMs,
  resolveBrowserOpenCommand
} from '../agent-skill/stackprism-site-experience/scripts/bridge/open-browser.mjs'
import { htmlEscapeScriptJson, isValidId, safeEqual } from '../agent-skill/stackprism-site-experience/scripts/bridge/protocol.mjs'
import {
  readJson as readBridgeRequestJson,
  rejectBadRequestShell
} from '../agent-skill/stackprism-site-experience/scripts/bridge/security.mjs'
import { normalizeCaptureRequest } from '../agent-skill/stackprism-site-experience/scripts/bridge/url-policy.mjs'
import { parseTerminalSettleMs } from '../agent-skill/stackprism-site-experience/scripts/capture-runtime.mjs'
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
const readBytes = async response => ({
  status: response.status,
  body: Buffer.from(await response.arrayBuffer()),
  headers: response.headers
})

const waitForFileSync = filePath => {
  const deadline = Date.now() + 2000
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  while (!existsSync(filePath) && Date.now() < deadline) Atomics.wait(waitBuffer, 0, 0, 25)
  assert.equal(existsSync(filePath), true, `expected file to exist: ${filePath}`)
}

const createClassList = () => {
  const values = new Set()
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    contains: value => values.has(value),
    toggle: (value, force) => {
      const enabled = force ?? !values.has(value)
      if (enabled) values.add(value)
      else values.delete(value)
      return enabled
    },
    toString: () => [...values].join(' ')
  }
}

const createFakeBridgeElement = (document, id = '') => ({
  id,
  alt: '',
  children: [],
  classList: createClassList(),
  dataset: {},
  disabled: false,
  download: '',
  href: '',
  listeners: {},
  removed: false,
  src: '',
  style: {},
  textContent: '',
  append(...children) {
    this.children.push(...children)
  },
  addEventListener(type, listener) {
    this.listeners[type] = listener
  },
  contains(element) {
    return element === this || this.children.includes(element)
  },
  click() {
    return this.listeners.click?.({ target: this })
  },
  focus() {
    document.activeElement = this
  },
  querySelectorAll(selector) {
    if (selector.includes('button:not(:disabled)')) return this.children.filter(child => child.tagName === 'button' && !child.disabled)
    return []
  },
  remove() {
    this.removed = true
  },
  removeAttribute(name) {
    delete this[name]
  },
  replaceChildren(...children) {
    this.children = [...children]
  },
  setAttribute(name, value) {
    this[name] = value
  }
})

const createBridgeScriptHarness = async (options = {}) => {
  const ids = [
    'status',
    'stateLabel',
    'statusBadge',
    'progressBar',
    'bridgeCard',
    'targetUrl',
    'openTargetUrl',
    'targetHelper',
    'screenshotFrame',
    'targetScreenshot',
    'screenshotMeta',
    'screenshotDownload',
    'copyScreenshot',
    'copyAllInfo',
    'downloadProfile',
    'copyStatus',
    'modalCopyStatus',
    'stepSummary',
    'profileContentSection',
    'profileContentGrid',
    'screenshotModal',
    'modalScreenshot',
    'modalClose',
    'modalDownload',
    'modalCopyScreenshot',
    'screenshotTileValue',
    'screenshotEmpty',
    'screenshotStateBadge',
    'toggleSteps',
    'stackprism-agent-bridge-config'
  ]
  const document = {
    activeElement: null,
    body: {
      children: [],
      style: {},
      append(child) {
        this.children.push(child)
      }
    },
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener
    },
    createElement(tagName) {
      if (tagName === 'canvas') {
        return {
          height: 0,
          width: 0,
          getContext: () => ({ drawImage: () => {} }),
          toBlob: callback => callback(new Blob(['png'], { type: 'image/png' }))
        }
      }
      const element = createFakeBridgeElement(document)
      element.tagName = tagName
      return element
    },
    getElementById(id) {
      return elements[id]
    },
    querySelectorAll(selector) {
      return selector === '[data-phase]' ? steps : []
    }
  }
  const elements = Object.fromEntries(ids.map(id => [id, createFakeBridgeElement(document, id)]))
  const phases = [
    'bridge_connected',
    'request_loaded',
    'target_opening',
    'target_loaded',
    'detecting_tech',
    'profiling_experience',
    'posting_profile',
    'cleanup'
  ]
  const steps = phases.map(phase => {
    const step = createFakeBridgeElement(document)
    step.dataset.phase = phase
    return step
  })
  const modalButtons = [elements.modalCopyScreenshot, elements.modalDownload, elements.modalClose]
  for (const button of modalButtons) {
    button.tagName = 'button'
    elements.screenshotModal.children.push(button)
  }
  elements['stackprism-agent-bridge-config'].textContent = JSON.stringify({
    bridgeToken: 'spbt_test',
    captureId: 'cap_test',
    targetUrl: 'https://example.test'
  })
  const writtenItems = []
  const writtenText = []
  const objectUrls = []
  class TestUrl extends URL {
    static createObjectURL(blob) {
      objectUrls.push(blob)
      return `blob:stackprism-${objectUrls.length}`
    }

    static revokeObjectURL(value) {
      context.revokedObjectUrl = value
    }
  }
  const context = vm.createContext({
    Blob,
    ClipboardItem: class ClipboardItem {
      constructor(items) {
        this.items = items
      }
    },
    URL: TestUrl,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    console,
    createImageBitmap: async blob => {
      context.convertedBlobType = blob.type
      return { height: 1, width: 1, close: () => {} }
    },
    document,
    fetch:
      options.fetch ||
      (async url => {
        if (String(url).includes('/profile-download')) {
          return {
            ok: true,
            blob: async () => new Blob(['{"schema":"stackprism.site_experience_profile.v1"}\n'], { type: 'application/json' })
          }
        }
        if (String(url).includes('/screenshot-download/')) {
          return {
            ok: true,
            blob: async () => new Blob(['webp'], { type: 'image/webp' })
          }
        }
        return {
          ok: true,
          json: async () => ({
            status: 'completed',
            phase: 'cleanup',
            preview: {
              contentSummary: { cards: [{ title: '视觉', items: ['清晰的双列布局'] }] },
              copyText: 'StackPrism profile summary',
              screenshot: {
                byteLength: 12,
                downloadUrl: '/v1/captures/cap_test/screenshot-download/shot_test',
                mimeType: 'image/webp',
                scope: 'viewport'
              },
              targetUrl: 'https://example.test/page'
            }
          })
        }
      }),
    navigator: {
      clipboard: {
        write: async items => writtenItems.push(...items),
        writeText: async value => writtenText.push(value)
      }
    },
    setTimeout: options.setTimeout || (() => 0)
  })
  vm.runInContext(`${bridgePageScript}\nthis.__stackprismPollForTest=poll;`, context)
  const isReady = options.isReady || (status => status === 'completed')
  for (let attempt = 0; attempt < 5 && !isReady(elements.bridgeCard.dataset.status); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  return { context, document, elements, steps, writtenItems, writtenText, objectUrls }
}

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

test('settings and help pages document mobile and agent bridge UI boundaries', () => {
  const popup = readFileSync('src/ui/popup/Popup.vue', 'utf8')
  const settings = readFileSync('src/ui/settings/Settings.vue', 'utf8')
  const help = readFileSync('src/ui/help/Help.vue', 'utf8')

  assert.match(popup, /class="agent-bridge-badge"/)
  assert.match(popup, /normalizeSettingsWithLocalOptIn/)
  assert.match(popup, /chrome\.storage\.local\.get\(SETTINGS_STORAGE_KEY\)/)
  assert.match(popup, /Agent Bridge 已开启，所有网络目标已放开/)
  assert.match(popup, /\.agent-bridge-badge \{[\s\S]*border-radius: 999px/)
  assert.match(settings, /@media \(max-width: 760px\)[\s\S]*padding-top: 0/)
  assert.match(settings, /@media \(max-width: 760px\)[\s\S]*\.settings-header[\s\S]*position: static/)
  assert.match(settings, /<main ref="settingsShell" class="settings-shell" tabindex="-1">/)
  assert.match(settings, /const trapConfirmationFocus = \(event: KeyboardEvent\)/)
  assert.match(settings, /const onConfirmDialogKeydown = \(event: KeyboardEvent\)/)
  assert.match(settings, /document\.addEventListener\('keydown', onConfirmDialogKeydown\)/)
  assert.match(settings, /document\.removeEventListener\('keydown', onConfirmDialogKeydown\)/)
  assert.match(settings, /const cancelPendingConfirmation = \(\) =>/)
  assert.match(settings, /resolver\?\.\(false\)/)
  assert.match(settings, /onUnmounted\(cancelPendingConfirmation\)/)
  assert.match(settings, /let confirmReturnFocusTarget: HTMLElement \| null = null/)
  assert.match(settings, /const settingsShell = ref<HTMLElement \| null>\(null\)/)
  assert.match(settings, /confirmReturnFocusTarget = active instanceof HTMLElement && active !== document\.body \? active : null/)
  assert.match(settings, /if \(returnTarget\?\.isConnected\) returnTarget\.focus\(\)/)
  assert.match(settings, /else settingsShell\.value\?\.focus\(\)/)
  assert.match(settings, /\.agent-bridge-toggle \{[\s\S]*align-items: flex-start/)
  assert.match(settings, /:global\(:root\[data-theme='dark'\]\) \.agent-bridge-state\.pending/)
  assert.match(help, /Agent Bridge 是什么/)
  assert.match(help, /127\.0\.0\.1/)
  assert.match(help, /只读采集，不读取 Cookie、Authorization、localStorage\/sessionStorage 明文。/)
  assert.match(help, /网络限制默认收紧；放开所有网络目标会要求二次确认。/)
  assert.match(help, /@media \(max-width: 760px\)[\s\S]*padding-top: 0/)
  assert.match(help, /@media \(max-width: 760px\)[\s\S]*\.help-header[\s\S]*position: static/)
})

test('settings page requests browser data consent before enabling Agent Bridge', () => {
  const settings = readFileSync('src/ui/settings/Settings.vue', 'utf8')
  const consentCall = settings.indexOf('requestAgentBridgeDataConsent()')
  const confirmationCall = settings.indexOf('requestConfirmation({')
  const syncSave = settings.indexOf('chrome.storage.sync.set')
  const localSave = settings.indexOf('chrome.storage.local.set')

  assert.match(settings, /requestAgentBridgeDataConsent/)
  assert.match(settings, /rollbackPendingAgentBridgeDataConsent/)
  assert.match(settings, /await updateAgentBridgeDataConsentState\(await loadAgentBridgeDataConsentSnapshot\(\), consentSnapshot\)/)
  assert.match(
    settings,
    /try \{\s*agentBridgeDataConsentGranted = await requestAgentBridgeDataConsent\(\)\s*\} catch \(error: any\) \{\s*if \(await rollbackPendingAgentBridgeDataConsent\(consentSnapshot, true\)\) \{\s*showStatus\(`保存失败：/
  )
  assert.match(
    settings,
    /if \(!confirmed\) \{\s*if \(await rollbackPendingAgentBridgeDataConsent\(consentSnapshot, agentBridgeDataConsentGranted\)\) \{\s*showStatus\('已取消保存。', 'error'\)/
  )
  assert.match(
    settings,
    /catch \(error: any\) \{\s*if \(await rollbackPendingAgentBridgeDataConsent\(consentSnapshot, agentBridgeDataConsentGranted\)\) \{\s*showStatus\(`保存失败：/
  )
  assert.doesNotMatch(settings, /savedAgentBridgeEnabled\.value\s*&&\s*!\(await requestAgentBridgeDataConsent\(\)\)/)
  assert.doesNotMatch(settings, /Promise\.all\(\[\s*chrome\.storage\.sync\.set[\s\S]*chrome\.storage\.local\.set/)
  assert.ok(consentCall > 0, 'settings page must request Agent Bridge data consent')
  assert.ok(consentCall < confirmationCall, 'settings page must request data consent before awaited confirmations')
  assert.ok(syncSave > consentCall, 'settings page must request data consent before saving sync settings')
  assert.ok(syncSave < localSave, 'settings page must save sync settings before local Agent Bridge flags')
  assert.ok(localSave > consentCall, 'settings page must request data consent before saving local Agent Bridge opt-in')
})

test('settings reset revokes browser data consent before clearing Agent Bridge defaults', () => {
  const settings = readFileSync('src/ui/settings/Settings.vue', 'utf8')
  const resetStart = settings.indexOf('const resetSettings = async () => {')
  const resetSection = settings.slice(resetStart, settings.indexOf('\n\n  const openHelp =', resetStart))

  assert.match(settings, /const agentBridgeDataConsentBaseline = ref<AgentBridgeDataConsentSnapshot \| null>\(null\)/)
  assert.doesNotMatch(resetSection, /rollbackAgentBridgeDataConsent/)
  assert.doesNotMatch(resetSection, /agentBridgeDataConsentBaseline\.value/)
  assert.match(resetSection, /await revokeAgentBridgeDataConsent\(\)/)
  assert.match(settings, /const updateAgentBridgeDataConsentState = async \(/)
  assert.match(settings, /await updateAgentBridgeDataConsentState\(await loadAgentBridgeDataConsentSnapshot\(\), consentSnapshot\)/)
  assert.match(resetSection, /await updateAgentBridgeDataConsentState\(await loadAgentBridgeDataConsentSnapshot\(\)\)/)
  assert.ok(
    resetSection.indexOf('await revokeAgentBridgeDataConsent()') < resetSection.indexOf('chrome.storage.sync.set'),
    'settings reset must revoke current browser data consent before clearing stored settings'
  )
})

test('settings page revokes browser data consent before saving Agent Bridge disabled', () => {
  const settings = readFileSync('src/ui/settings/Settings.vue', 'utf8')
  const helperStart = settings.indexOf('const revokeDisabledAgentBridgeDataConsent = async')
  const saveStart = settings.indexOf('const saveSettings = async () => {')
  const saveSection = settings.slice(saveStart, settings.indexOf('\n\n  const resetSettings =', saveStart))

  assert.match(settings, /revokeAgentBridgeDataConsent/)
  assert.match(settings.slice(helperStart, saveStart), /if \(agentBridgeEnabled \|\| !savedAgentBridgeEnabled\.value\) return true/)
  assert.match(settings.slice(helperStart, saveStart), /await revokeAgentBridgeDataConsent\(\)/)
  assert.match(saveSection, /if \(!\(await revokeDisabledAgentBridgeDataConsent\(settings\.agentBridgeEnabled\)\)\) return/)
  assert.ok(
    saveSection.indexOf('await revokeDisabledAgentBridgeDataConsent(settings.agentBridgeEnabled)') <
      saveSection.indexOf('chrome.storage.sync.set'),
    'settings save must revoke browser data consent before writing disabled Agent Bridge state'
  )
})

test('settings page keeps sync-backed settings when local Agent Bridge flags fail to load', () => {
  const settings = readFileSync('src/ui/settings/Settings.vue', 'utf8')

  assert.match(settings, /const stored = await chrome\.storage\.sync\.get\(SETTINGS_STORAGE_KEY\)/)
  assert.match(settings, /let local: Record<string, any> = \{\}/)
  assert.match(settings, /try \{\s*local = await chrome\.storage\.local\.get\(SETTINGS_STORAGE_KEY\)\s*\} catch \{\s*local = \{\}\s*\}/)
  assert.doesNotMatch(settings, /const \[stored, local\] = await Promise\.all\(\[/)
})

test('bridge page script supports profile download, screenshot actions and modal focus loop', async () => {
  const { context, document, elements, steps, writtenItems, writtenText, objectUrls } = await createBridgeScriptHarness()

  assert.equal(elements.bridgeCard.dataset.status, 'completed')
  assert.equal(elements.targetUrl.textContent, 'https://example.test/page')
  assert.equal(elements.targetUrl.title, 'https://example.test/page')
  assert.equal(elements.targetUrl.href, 'https://example.test/page')
  assert.equal(elements.targetUrl['aria-disabled'], undefined)
  assert.equal(elements.openTargetUrl.href, 'https://example.test/page')
  assert.equal(elements.openTargetUrl['aria-disabled'], undefined)
  assert.equal(elements.openTargetUrl.tabindex, undefined)
  assert.equal(elements.targetHelper.textContent, '已生成 Agent 可读摘要，可复制给本机 Coding Agent 使用。')
  assert.equal(elements.screenshotDownload.disabled, false)
  assert.equal(elements.copyScreenshot.disabled, false)
  assert.equal(elements.copyAllInfo.disabled, false)
  assert.equal(elements.downloadProfile.disabled, false)
  assert.equal(elements.screenshotTileValue.textContent, '截图可用')
  assert.equal(elements.screenshotStateBadge.textContent, '截图可用')
  assert.equal(elements.screenshotStateBadge.dataset.state, 'ready')
  assert.equal(elements.bridgeCard.dataset.stepsOpen, 'false')
  assert.equal(elements.toggleSteps.textContent, '展开步骤')
  assert.equal(elements.toggleSteps['aria-expanded'], 'false')
  assert.equal(elements.targetScreenshot.alt, '目标页面截图预览')
  assert.equal(elements.modalScreenshot.alt, '目标页面截图放大预览')
  assert.equal(elements.profileContentSection.hidden, false)
  assert.equal(elements.profileContentGrid.children.length, 1)
  assert.equal(steps.at(-1).classList.contains('done'), true)
  assert.equal(steps.at(-1)['aria-current'], undefined)

  elements.toggleSteps.click()
  assert.equal(elements.bridgeCard.dataset.stepsOpen, 'true')
  assert.equal(elements.toggleSteps.textContent, '收起步骤')
  assert.equal(elements.toggleSteps['aria-expanded'], 'true')

  await elements.copyAllInfo.click()
  assert.deepEqual(writtenText, ['StackPrism profile summary'])
  assert.equal(elements.copyStatus.textContent, '已复制全部信息。')
  assert.equal(elements.copyAllInfo.textContent, '已复制')

  await elements.downloadProfile.click()
  const profileLink = document.body.children.at(-1)
  assert.equal(profileLink.tagName, 'a')
  assert.equal(profileLink.href, 'blob:stackprism-2')
  assert.equal(profileLink.download, 'stackprism-cap_test-profile.json')
  assert.equal(profileLink.removed, true)
  assert.equal(objectUrls.length, 2)
  assert.equal(elements.copyStatus.textContent, '已下载 Profile JSON。')

  await elements.screenshotDownload.click()
  const downloadLink = document.body.children.at(-1)
  assert.equal(downloadLink.tagName, 'a')
  assert.equal(downloadLink.href.startsWith('blob:stackprism-'), true)
  assert.notEqual(downloadLink.href, elements.targetScreenshot.src)
  assert.equal(objectUrls.at(-1).type, 'image/webp')
  assert.equal(downloadLink.download, 'stackprism-cap_test-screenshot.webp')
  assert.equal(downloadLink.removed, true)

  elements.screenshotFrame.click()
  assert.equal(elements.screenshotModal.dataset.open, 'true')
  assert.equal(document.activeElement, elements.modalClose)

  await elements.modalCopyScreenshot.click()
  assert.equal(context.convertedBlobType, 'image/webp')
  assert.equal(writtenItems.length, 1)
  assert.equal(Object.keys(writtenItems[0].items)[0], 'image/png')
  assert.equal(elements.modalCopyStatus.textContent, '已复制截图。')

  document.activeElement = elements.bridgeCard
  const tabFromOutside = {
    key: 'Tab',
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true
    }
  }
  document.listeners.keydown(tabFromOutside)
  assert.equal(tabFromOutside.preventDefaultCalled, true)
  assert.equal(document.activeElement, elements.modalCopyScreenshot)

  document.activeElement = elements.modalClose
  const tabForward = {
    key: 'Tab',
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true
    }
  }
  document.listeners.keydown(tabForward)
  assert.equal(tabForward.preventDefaultCalled, true)
  assert.equal(document.activeElement, elements.modalCopyScreenshot)

  const tabBackward = {
    key: 'Tab',
    shiftKey: true,
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true
    }
  }
  document.listeners.keydown(tabBackward)
  assert.equal(tabBackward.preventDefaultCalled, true)
  assert.equal(document.activeElement, elements.modalClose)

  document.listeners.keydown({ key: 'Escape' })
  assert.equal(elements.screenshotModal.dataset.open, 'false')
  assert.equal(document.activeElement, elements.screenshotFrame)

  elements.screenshotFrame.click()
  assert.equal(elements.screenshotModal.dataset.open, 'true')
  elements.targetScreenshot.listeners.error()
  assert.equal(elements.screenshotFrame.disabled, true)
  assert.equal(elements.targetScreenshot.alt, '')
  assert.equal(elements.modalScreenshot.alt, '')
  assert.equal(elements.screenshotTileValue.textContent, '截图失败')
  assert.equal(elements.screenshotStateBadge.textContent, '截图失败')
  assert.equal(elements.screenshotStateBadge.dataset.state, 'failed')
  assert.equal(elements.screenshotEmpty.textContent, '截图预览无法加载')
  document.listeners.keydown({ key: 'Escape' })
  assert.equal(elements.screenshotModal.dataset.open, 'false')
  assert.equal(document.activeElement, elements.bridgeCard)
})

test('bridge page script downloads cached profile after bridge closes', async () => {
  const profileBlob = new Blob(['{"schema":"stackprism.site_experience_profile.v1","cached":true}\n'], { type: 'application/json' })
  let statusReads = 0
  let profileReads = 0
  const { document, elements, objectUrls } = await createBridgeScriptHarness({
    fetch: async url => {
      if (String(url).includes('/profile-download')) {
        profileReads += 1
        return { ok: true, blob: async () => profileBlob }
      }
      statusReads += 1
      return {
        ok: true,
        json: async () => ({
          status: 'completed',
          phase: 'cleanup',
          preview: {
            contentSummary: { cards: [] },
            copyText: 'StackPrism profile summary',
            targetUrl: 'https://example.test/page'
          }
        })
      }
    }
  })

  for (let attempt = 0; attempt < 5 && profileReads === 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(statusReads, 1)
  assert.equal(profileReads, 1)
  assert.equal(elements.downloadProfile.disabled, false)

  await elements.downloadProfile.click()

  assert.equal(profileReads, 1)
  assert.equal(objectUrls[0], profileBlob)
  const profileLink = document.body.children.at(-1)
  assert.equal(profileLink.href, 'blob:stackprism-1')
  assert.equal(profileLink.download, 'stackprism-cap_test-profile.json')
  assert.equal(elements.copyStatus.textContent, '已下载 Profile JSON。')
})

test('bridge page script invalidates screenshot controls when image download fails', async () => {
  let screenshotReads = 0
  const { elements } = await createBridgeScriptHarness({
    fetch: async url => {
      if (String(url).includes('/profile-download')) {
        return {
          ok: true,
          blob: async () => new Blob(['{"schema":"stackprism.site_experience_profile.v1"}\n'], { type: 'application/json' })
        }
      }
      if (String(url).includes('/screenshot-download/')) {
        screenshotReads += 1
        return { ok: false, status: 500, blob: async () => new Blob(['server error'], { type: 'text/plain' }) }
      }
      return {
        ok: true,
        json: async () => ({
          status: 'completed',
          phase: 'cleanup',
          preview: {
            contentSummary: { cards: [] },
            copyText: 'StackPrism profile summary',
            screenshot: {
              byteLength: 12,
              downloadUrl: '/v1/captures/cap_test/screenshot-download/shot_test',
              mimeType: 'image/jpeg',
              scope: 'viewport'
            },
            targetUrl: 'https://example.test/page'
          }
        })
      }
    }
  })

  for (let attempt = 0; attempt < 5 && elements.screenshotStateBadge.dataset.state !== 'failed'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }

  assert.equal(screenshotReads, 1)
  assert.equal(elements.screenshotStateBadge.dataset.state, 'failed')
  assert.equal(elements.screenshotTileValue.textContent, '截图失败')
  assert.equal(elements.screenshotFrame.disabled, true)
  assert.equal(elements.screenshotDownload.disabled, true)
  assert.equal(elements.copyScreenshot.disabled, true)
  assert.equal(elements.modalDownload.disabled, true)
  assert.equal(elements.modalCopyScreenshot.disabled, true)
  assert.equal(elements.targetScreenshot.alt, '')
  assert.equal(elements.modalScreenshot.alt, '')
  assert.equal(elements.screenshotMeta.textContent, '截图预览无法加载')
  assert.equal(elements.screenshotEmpty.textContent, '截图预览无法加载')
  assert.equal(elements.copyStatus.dataset.state, 'error')
  assert.equal(elements.copyStatus.textContent, '截图预览无法加载，可重新采集或下载 Profile 查看图片链接。')
})

test('bridge page script keeps terminal failure visible after bridge disconnect', async () => {
  const responses = [
    {
      status: 'failed',
      phase: 'target_loaded',
      error: { code: 'PRIVATE_NETWORK_TARGET_BLOCKED' },
      preview: { targetUrl: 'https://linear.app/' }
    }
  ]
  let fetchCalls = 0
  const { elements, steps } = await createBridgeScriptHarness({
    fetch: async () => {
      fetchCalls += 1
      if (!responses.length) throw new Error('bridge closed')
      return { ok: true, json: async () => responses.shift() }
    },
    isReady: status => status === 'failed'
  })
  assert.equal(fetchCalls, 1)

  await elements.__stackprismPollForTest?.()

  assert.equal(elements.bridgeCard.dataset.status, 'failed')
  assert.equal(elements.bridgeCard.dataset.phase, 'target_loaded')
  assert.equal(elements.stateLabel.textContent, '采集失败')
  assert.equal(elements.status.textContent, 'PRIVATE_NETWORK_TARGET_BLOCKED')
  assert.equal(elements.targetUrl.href, 'https://linear.app/')
  assert.equal(elements.targetUrl['aria-disabled'], undefined)
  assert.equal(elements.openTargetUrl.href, 'https://linear.app/')
  assert.equal(elements.openTargetUrl['aria-disabled'], undefined)
  assert.equal(elements.stepSummary.textContent, '结果：采集失败 - 目标页面已加载')
  assert.equal(steps[3].classList.contains('failed'), true)
})

test('bridge page script links redacted query target URLs without query parameters', async () => {
  const { elements } = await createBridgeScriptHarness({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        status: 'failed',
        phase: 'target_loaded',
        preview: { targetUrl: 'https://example.test/app?[redacted]' }
      })
    }),
    isReady: status => status === 'failed'
  })

  assert.equal(elements.targetUrl.textContent, 'https://example.test/app?[redacted]')
  assert.equal(elements.targetUrl.title, 'https://example.test/app?[redacted]')
  assert.equal(elements.targetUrl.href, 'https://example.test/app')
  assert.equal(elements.targetUrl['aria-disabled'], undefined)
  assert.equal(elements.openTargetUrl.href, 'https://example.test/app')
  assert.equal(elements.openTargetUrl['aria-disabled'], undefined)
})

test('bridge page script links ordinary long project slug target URLs', async () => {
  const longProjectUrl = 'https://vercel.com/dashboard/projects/very-long-project-name-with-token-like-segment-and-many-words'
  const { elements } = await createBridgeScriptHarness({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        status: 'failed',
        phase: 'target_loaded',
        preview: { targetUrl: longProjectUrl }
      })
    }),
    isReady: status => status === 'failed'
  })

  assert.equal(elements.targetUrl.textContent, longProjectUrl)
  assert.equal(elements.targetUrl.title, longProjectUrl)
  assert.equal(elements.targetUrl.href, longProjectUrl)
  assert.equal(elements.targetUrl['aria-disabled'], undefined)
  assert.equal(elements.openTargetUrl.href, longProjectUrl)
  assert.equal(elements.openTargetUrl['aria-disabled'], undefined)
})

test('bridge page script does not link redacted target URL paths', async () => {
  const { elements } = await createBridgeScriptHarness({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        status: 'failed',
        phase: 'target_loaded',
        preview: { targetUrl: 'https://example.test/[redacted]/app' }
      })
    }),
    isReady: status => status === 'failed'
  })

  assert.equal(elements.targetUrl.textContent, 'https://example.test/[redacted]/app')
  assert.equal(elements.targetUrl.title, 'https://example.test/[redacted]/app')
  assert.equal(elements.targetUrl.href, undefined)
  assert.equal(elements.targetUrl['aria-disabled'], 'true')
  assert.equal(elements.openTargetUrl.href, undefined)
  assert.equal(elements.openTargetUrl['aria-disabled'], 'true')
  assert.equal(elements.openTargetUrl.tabindex, '-1')
})

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

const profileFor = (captureId, overrides = {}) => ({
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
  agentGuidance: {},
  ...overrides
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

test('js bridge page renderer validates nonce and script-escapes object config', () => {
  assert.throws(() => renderBridgePageHtml('bad" nonce', { value: 'https://example.com/' }), /INVALID_CSP_NONCE/)

  const html = renderBridgePageHtml('abcdefghijklmnopqrstuv', {
    value: '</script><script>alert(1)</script>&\u2028\u2029'
  })
  const configText = html.match(/<script id="stackprism-agent-bridge-config" type="application\/json" nonce="[^"]+">([^<]+)/)[1]

  assert.equal(configText.includes('</script>'), false)
  assert.equal(configText.includes('<script>'), false)
  assert.equal(configText.includes('&'), false)
  assert.equal(JSON.parse(configText).value, '</script><script>alert(1)</script>&\u2028\u2029')
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
    assert.equal(ready.server.requestTimeout, 35000)
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
    assert.match(csp, /img-src data: blob:/)
    assert.doesNotMatch(csp, /img-src[^;]*'self'/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /base-uri 'none'/)
    assert.match(csp, /form-action 'none'/)
    assert.ok(cspNonce)
    assert.match(csp, new RegExp(`style-src 'nonce-${cspNonce}'`))
    assert.equal(first.headers.get('x-frame-options'), 'DENY')
    assert.match(html, /meta name="stackprism-agent-bridge" content="1"/)
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,%3Csvg/)
    assert.match(html, /id="bridgeCard" class="bridge-card" data-status="waiting_extension" aria-labelledby="bridge-title" tabindex="-1"/)
    assert.match(html, /id="progressBar"/)
    assert.match(html, /id="targetUrl" class="target-url" title="" target="_blank" rel="noopener noreferrer" aria-disabled="true"/)
    assert.match(
      html,
      /id="openTargetUrl" class="preview-button target-open-link" target="_blank" rel="noopener noreferrer" aria-disabled="true" tabindex="-1"/
    )
    assert.match(html, /id="targetScreenshot"/)
    assert.match(html, /id="targetScreenshot" alt=""/)
    assert.match(html, /id="screenshotMeta"/)
    assert.match(html, /id="screenshotDownload"/)
    assert.match(html, /id="copyScreenshot"/)
    assert.match(html, /id="downloadProfile"/)
    assert.match(html, /class="preview-button profile-download-button"/)
    assert.match(html, /id="copyAllInfo"/)
    assert.match(html, /id="copyStatus"/)
    assert.match(html, /id="modalCopyStatus"/)
    assert.match(html, /id="screenshotTileValue"/)
    assert.match(html, /id="screenshotStateBadge" class="state-chip" data-state="pending"/)
    assert.match(html, /id="screenshotEmpty"/)
    assert.match(html, /id="stepSummary" class="step-summary" role="status" aria-live="polite"/)
    assert.match(html, /id="toggleSteps" class="flow-toggle" type="button" aria-controls="captureSteps" aria-expanded="false"/)
    assert.match(html, /<ol id="captureSteps" class="steps" aria-label="采集步骤" role="list">/)
    assert.match(html, /data-phase="bridge_connected" aria-current="step"/)
    assert.match(html, /id="profileContentSection"/)
    assert.match(html, /id="profileContentGrid"/)
    assert.match(html, /id="screenshotModal"/)
    assert.match(html, /id="modalDownload"/)
    assert.match(html, /id="modalCopyScreenshot"/)
    assert.match(html, /id="modalClose"/)
    assert.match(html, /id="modalScreenshot" class="modal-image" alt=""/)
    assert.match(html, /addEventListener\('click',openScreenshot\)/)
    assert.match(html, /navigator\.clipboard\.writeText/)
    assert.match(html, /new ClipboardItem/)
    assert.match(html, /showCopyStatus\('已复制全部信息。'\)/)
    assert.match(html, /flashCopyButton\('已复制'\)/)
    assert.match(html, /const clipboardScreenshotBlob=async/)
    assert.match(html, /createImageBitmap\(blob\)/)
    assert.match(html, /'image\/png':blob/)
    assert.match(html, /复制截图失败：浏览器未允许写入剪切板，或截图格式无法转换。/)
    assert.match(html, /截图预览无法加载/)
    assert.match(html, /downloadBlob\(await fetchScreenshotBlob\(\),screenshotFilename\(\)\)/)
    assert.match(html, /currentProfileBlob=null,currentProfileFetchPromise=null/)
    assert.match(html, /const ensureProfileCached=\(\)=>/)
    assert.match(html, /downloadBlob\(await ensureProfileCached\(\),profileFilename\(\)\)/)
    assert.match(html, /if\(status==='completed'\)ensureProfileCached\(\)\.catch\(\(\)=>\{\}\)/)
    assert.match(html, /\/profile-download/)
    assert.doesNotMatch(html, /config\.captureId\+'\/profile'/)
    assert.match(html, /currentScreenshot\?\.mimeType==='image\/png'\?'png'/)
    assert.match(html, /currentScreenshot\?\.mimeType==='image\/webp'\?'webp'/)
    assert.match(html, /currentScreenshotObjectUrl=URL\.createObjectURL\(blob\)/)
    assert.match(html, /el\.targetScreenshot\.alt='目标页面截图预览'/)
    assert.match(html, /el\.targetScreenshot\.alt=''/)
    assert.match(html, /color-scheme:light dark/)
    assert.match(html, /@media \(prefers-color-scheme:dark\)/)
    assert.match(html, /class="result-grid"/)
    assert.match(html, /class="summary-grid"/)
    assert.match(html, /class="screenshot-panel"/)
    assert.match(html, /border-radius:16px/)
    assert.match(html, /\.summary-grid\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/)
    assert.match(html, /grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,300px\),1fr\)\)/)
    assert.match(html, /\.target-copy\{min-width:0\}/)
    assert.match(html, /\.target-url\{margin:0;display:-webkit-box;overflow:hidden;overflow-wrap:anywhere;word-break:break-word/)
    assert.match(html, /\.content-card \*\{min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word\}/)
    assert.match(html, /\.content-card\{min-width:0;min-height:88px;padding:10px;overflow:hidden/)
    assert.match(html, /\.content-card ul\{display:grid;min-width:0;gap:3px/)
    assert.match(html, /\.content-card li\{min-width:0;line-height:1\.38;white-space:normal\}/)
    assert.doesNotMatch(bridgePageStyle, /@media \(max-width:980px\)\{[^}]*\.content-grid/)
    assert.doesNotMatch(bridgePageStyle, /@media \(max-width:760px\)\{[^}]*\.content-grid/)
    assert.match(html, /--sp-neutral-line:#e5e9ee/)
    assert.match(html, /grid-template-columns:minmax\(0,1\.22fr\) minmax\(320px,\.82fr\)/)
    assert.match(html, /class="summary-handoff" aria-label="摘要包含"/)
    assert.match(html, /摘要包含/)
    assert.match(html, /技术栈/)
    assert.match(html, /首屏结构/)
    assert.match(html, /height:clamp\(190px,14vw,230px\)/)
    assert.match(html, /object-fit:cover/)
    assert.match(html, /object-position:top center/)
    assert.match(html, /-webkit-line-clamp:2/)
    assert.match(html, /\.target-url\[href\]\{cursor:pointer\}/)
    assert.match(html, /\.target-url\[href\]:hover\{text-decoration:underline/)
    assert.match(html, /\.target-actions\{display:flex;min-width:0;flex-wrap:wrap;gap:10px;justify-content:flex-end\}/)
    assert.match(
      html,
      /\.target-open-link\{min-width:132px;display:inline-flex;align-items:center;justify-content:center;text-decoration:none\}/
    )
    assert.match(html, /\.preview-button:disabled,.modal-close:disabled,.preview-button\[aria-disabled="true"\]\{cursor:not-allowed/)
    assert.match(html, /targetHrefFor=value=>/)
    assert.match(html, /url\.pathname\.includes\('\[redacted\]'\)/)
    assert.match(html, /url\.search\.includes\('\[redacted\]'\)/)
    assert.match(html, /setTargetUrl\(targetText\)/)
    assert.match(html, /setTargetLink\(el\.openTargetUrl,targetHref\)/)
    assert.match(html, /node\.removeAttribute\('aria-disabled'\)/)
    assert.match(html, /\.bridge-header\{position:relative;display:block/)
    assert.match(html, /\.summary-handoff\{display:none\}/)
    assert.match(html, /class="target-actions"/)
    assert.match(html, /class="preview-button primary target-copy-button"/)
    assert.match(html, /class="flow-panel"/)
    assert.match(html, /grid-template-columns:repeat\(8,minmax\(0,1fr\)\)/)
    assert.match(html, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
    assert.match(html, /\.bridge-card\[data-status="completed"\] \.status-panel\{display:none\}/)
    assert.match(html, /\.bridge-card\[data-status="completed"\]:not\(\[data-steps-open="true"\]\) \.steps\{display:none\}/)
    assert.match(html, /\.state-chip\[data-state="ready"\]/)
    assert.match(html, /setScreenshotState\('截图可用','ready'\)/)
    assert.match(html, /setStepsOpen\(false\)/)
    assert.match(html, /addEventListener\('click',\(\)=>setStepsOpen\(!stepsOpen,true\)\)/)
    assert.match(
      html,
      /\.preview-button:disabled,.modal-close:disabled,.preview-button\[aria-disabled="true"\]\{cursor:not-allowed;opacity:1;background:#f7fbfa/
    )
    assert.match(html, /setCopyStatus\(modalOpen\(\)\?el\.modalCopyStatus:el\.copyStatus,value,type\)/)
    assert.match(html, /const restore=el\.screenshotFrame\.disabled\?el\.bridgeCard:el\.screenshotFrame/)
    assert.match(html, /if\(current\|\|failedCurrent\)step\.setAttribute\('aria-current','step'\)/)
    assert.match(html, /else step\.removeAttribute\('aria-current'\)/)
    assert.match(html, /step\.classList\.toggle\('failed',failedCurrent\)/)
    assert.match(html, /\.step\.failed/)
    assert.match(html, /\.bridge-card\[data-status="failed"\] \.progress span/)
    assert.match(html, /\.copy-status\[data-state="error"\]\{background:#2a1211;border-color:#7f1d1d;color:#fca5a5\}/)
    assert.match(html, /color:#fca5a5/)
    assert.match(html, /color:#fbbf24/)
    assert.match(html, /disconnected:'连接已关闭'/)
    assert.match(html, /const targetText=preview\.targetUrl\|\|config\.targetUrl\|\|'等待读取目标网址'/)
    assert.match(html, /el\.targetUrl\.title=targetText/)
    assert.match(html, /本机 bridge 服务已关闭，当前页面无法继续读取状态。/)
    assert.doesNotMatch(html, /Bridge status unavailable/)
    assert.match(html, /data-phase="profiling_experience"/)
    assert.match(html, /本机通道/)
    assert.match(html, /连接本机 Agent 与当前浏览器 profile，展示本次采集结果。/)
    assert.match(html, /采集目标/)
    assert.match(html, /id="targetHelper" class="target-helper"/)
    assert.match(html, /采集完成后可复制给本机 Coding Agent 使用。/)
    assert.match(html, /已生成 Agent 可读摘要，可复制给本机 Coding Agent 使用。/)
    assert.match(html, /面向复刻任务整理技术栈、视觉结构、交互路径与资产线索。/)
    assert.match(html, /复刻重点/)
    assert.match(html, /先看 Agent 可读内容/)
    assert.match(html, /本页只服务当前一次采集/)
    assert.match(html, /摘要不含 token、nonce、raw JSON 或截图 data URL/)
    assert.match(html, /Agent 可读内容/)
    assert.match(html, /完整 Profile 可在本页完成后下载/)
    assert.match(html, new RegExp(`id="stackprism-agent-bridge-config" type="application/json" nonce="${cspNonce}"`))
    assert.match(html, new RegExp(`<style nonce="${cspNonce}"`))
    assert.match(html, new RegExp(`<script nonce="${cspNonce}"`))
    assert.match(html, /fetch\('\/v1\/captures\/'\+config\.captureId/)
    assert.match(html, /textContent=value/)
    assert.match(html, /"bridgeToken":"spbt_[A-Za-z0-9_-]{43}"/)
    assert.match(html, /"targetUrl":"https:\/\/93\.184\.216\.34\/app\?\[redacted\]"/)
    assert.doesNotMatch(html, /"targetHref":/)

    const second = await readJson(await fetch(created.body.bridgeUrl))
    assert.equal(second.status, 409)
    assert.equal(second.body.error.code, 'INVALID_REQUEST')
    assert.equal(second.body.error.message, 'Bridge token has already been rendered or claimed.')
  })
})

test('bridge page concurrent requests render only one bridge token', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const responses = await Promise.all([fetch(created.body.bridgeUrl), fetch(created.body.bridgeUrl)])
    const statuses = responses.map(response => response.status).sort((left, right) => left - right)
    const bodies = await Promise.all(
      responses.map(async response => ({
        status: response.status,
        text: await response.text()
      }))
    )
    assert.deepEqual(statuses, [200, 409])
    const rejected = bodies.find(body => body.status === 409)
    assert.match(rejected.text, /Bridge token has already been rendered or claimed/)
    assert.equal(bodies.filter(body => /spbt_[A-Za-z0-9_-]{43}/.test(body.text)).length, 1)
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

      const expiredDownload = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile-download`, {
          headers: auth(config.bridgeToken)
        })
      )
      assert.equal(expiredDownload.status, 410)
      assert.equal(expiredDownload.body.error.code, 'CAPTURE_RESULT_EXPIRED')
      assertJsonSecurityHeaders(expiredDownload, { referrerPolicy: true })
      assert.equal(expiredDownload.headers.get('content-disposition'), `attachment; filename="stackprism-${created.body.id}-profile.json"`)

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

    const profile = profileFor(created.body.id, {
      target: { language: 'zh-CN', pagePurpose: 'Landing page token=secret' },
      techProfile: {
        technologies: [
          { name: 'Vue', category: '前端框架' },
          { name: 'Tailwind CSS', category: 'UI / CSS 框架' }
        ],
        primaryFrontend: 'Vue',
        uiFramework: 'Tailwind CSS',
        buildRuntime: 'Vite',
        thirdPartyServices: ['Stripe token=secret', 'Authorization: Bearer secret-token-123']
      },
      visualProfile: {
        colorTokens: ['#0f766e'],
        fonts: ['Inter'],
        screenshot: {
          dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn',
          mimeType: 'image/jpeg',
          byteLength: 9,
          scope: 'visible_viewport'
        }
      },
      layoutProfile: { landmarks: ['header', 'main'] },
      componentProfile: { counts: { button: 3, card: 2 }, samples: [{ name: 'Hero card' }] },
      interactionProfile: { transitions: ['opacity 0.2s'], stickyOrFixed: ['header'] },
      uxProfile: {
        pagePurpose: 'Product signup',
        primaryUserPath: ['Open pricing'],
        informationHierarchy: ['Hero', 'Features'],
        contentGrouping: ['summary', 'pricing'],
        navigationDepth: 'nav_links:4',
        ctaStrategy: ['Start free'],
        trustSignals: ['Customer logos'],
        frictionPoints: ['Long form user@example.com']
      },
      assetProfile: {
        scripts: ['https://cdn.example.com/app.js?token=secret'],
        stylesheets: ['https://cdn.example.com/app.css?token=secret'],
        cdnHints: ['cdn.example.com']
      },
      evidence: {
        privateText: 'not for bridge status',
        token: config.bridgeToken
      },
      limitations: ['screenshot_metadata_not_requested'],
      agentGuidance: {
        summary: '优先复刻视觉层级和交互反馈。',
        recreationPlan: {
          implementationOrder: ['Define tokens', 'Build layout'],
          designTokens: { colors: ['#0f766e'], fontFamilies: ['Inter'] },
          layoutBlueprint: { informationHierarchy: ['Hero', 'Features'], contentGrouping: ['summary', 'pricing'] },
          componentInventory: { counts: { button: 3 }, priorityTypes: ['button', 'card'], geometryIncluded: false },
          interactionChecklist: { transitions: ['opacity 0.2s'] },
          assetHints: { scriptCount: 1, stylesheetCount: 1, resourceDomains: ['cdn.example.com:2'] },
          verificationChecklist: ['Compare screenshot', 'Smoke test interactions']
        }
      }
    })
    const posted = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      })
    )
    assert.equal(posted.status, 200)
    const captureRecord = ready.store.get(created.body.id)
    assert.equal(captureRecord.profile.visualProfile.screenshot.dataUrl, undefined)
    assert.equal(captureRecord.screenshotAsset.bytes.toString('utf8'), 'fake-jpeg')
    assert.equal(captureRecord.screenshotAsset.metadata.scope, 'visible_viewport')
    assertJsonSecurityHeaders(posted)
    assert.equal(posted.body.status, 'completed')
    assert.equal(posted.body.preview.targetUrl, 'https://93.184.216.34/app?[redacted]')
    assert.equal(posted.body.preview.screenshot.dataUrl, undefined)
    assert.match(
      posted.body.preview.screenshot.downloadUrl,
      new RegExp(`^${ready.baseUrl}/v1/captures/${created.body.id}/screenshot-download/shot_[A-Za-z0-9_-]{43}$`)
    )
    assert.equal(posted.body.preview.screenshot.scope, 'visible_viewport')
    assert.equal(posted.body.preview.contentSummary.cards[0].title, '复刻建议')
    assert.equal(
      posted.body.preview.contentSummary.cards.some(card => card.title === '技术栈'),
      true
    )
    assert.equal(
      posted.body.preview.contentSummary.cards.some(card => card.title === '复刻建议'),
      true
    )
    assert.match(posted.body.preview.copyText, /# StackPrism Site Experience/)
    assert.ok(posted.body.preview.copyText.indexOf('## 复刻建议') < posted.body.preview.copyText.indexOf('## 技术栈'))
    assert.match(posted.body.preview.copyText, /## 技术栈/)
    assert.match(posted.body.preview.copyText, /Vue/)
    assert.match(posted.body.preview.copyText, /主要路径: Open pricing/)
    assert.match(posted.body.preview.copyText, /信任信号: Customer logos/)
    assert.match(posted.body.preview.copyText, /token=\[redacted\]/)
    assert.match(posted.body.preview.copyText, /Authorization=\[redacted\]/)
    assert.doesNotMatch(posted.body.preview.copyText, /data:image\/jpeg;base64/)
    assert.doesNotMatch(posted.body.preview.copyText, /spbt_[A-Za-z0-9_-]{43}/)
    assert.doesNotMatch(posted.body.preview.copyText, /not for bridge status|user@example\.com|token=secret|secret-token-123/)
    assert.equal(JSON.stringify(posted.body).includes('not for bridge status'), false)

    const completedControl = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/control`, { headers: auth(config.bridgeToken) })
    )
    assert.equal(completedControl.status, 200)
    assert.equal(completedControl.body.command, 'cancel')
    assert.equal(completedControl.body.status, 'completed')

    const completedStatus = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, { headers: auth(config.bridgeToken) })
    )
    assert.equal(completedStatus.status, 200)
    assert.equal(completedStatus.body.preview.targetUrl, 'https://93.184.216.34/app?[redacted]')
    assert.equal(completedStatus.body.preview.screenshot.mimeType, 'image/jpeg')
    assert.equal(completedStatus.body.preview.screenshot.downloadUrl, posted.body.preview.screenshot.downloadUrl)
    assert.equal(completedStatus.body.preview.copyText, posted.body.preview.copyText)
    assert.equal(JSON.stringify(completedStatus.body).includes('not for bridge status'), false)

    const downloaded = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile-download`, { headers: auth(config.bridgeToken) })
    )
    assert.equal(downloaded.status, 200)
    assertJsonSecurityHeaders(downloaded, { referrerPolicy: true })
    assert.equal(downloaded.headers.get('content-disposition'), `attachment; filename="stackprism-${created.body.id}-profile.json"`)
    assert.equal(downloaded.body.schema, 'stackprism.site_experience_profile.v1')
    assert.equal(downloaded.body.captureId, created.body.id)
    assert.equal(downloaded.body.visualProfile.screenshot.dataUrl, undefined)
    assert.equal(downloaded.body.visualProfile.screenshot.downloadUrl, posted.body.preview.screenshot.downloadUrl)
    assert.equal(downloaded.body.visualProfile.screenshot.downloadMethod, 'GET')
    assert.equal(downloaded.body.visualProfile.screenshot.lifecycle.requiresLocalBridge, true)
    assert.match(downloaded.body.visualProfile.screenshot.lifecycle.availableUntil, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(downloaded.body.visualProfile.screenshot.lifecycle.note, /before the local bridge process exits/)
    assert.match(downloaded.body.visualProfile.screenshot.note, /base64 is intentionally omitted/)
    assert.match(downloaded.body.visualProfile.screenshot.profileJsonNote, /standard JSON and cannot contain comments/)
    assert.equal(downloaded.body.agentGuidance.recreationPlan.visualReference.screenshotBase64Included, false)
    assert.equal(downloaded.body.agentGuidance.recreationPlan.visualReference.screenshotIncluded, true)
    assert.match(
      downloaded.body.agentGuidance.recreationPlan.visualReference.screenshotProfileJsonNote,
      /standard JSON and cannot contain comments/
    )
    assert.equal(
      downloaded.body.agentGuidance.recreationPlan.visualReference.screenshotDownloadUrl,
      posted.body.preview.screenshot.downloadUrl
    )

    const unauthenticatedScreenshotDownload = await readBytes(await fetch(downloaded.body.visualProfile.screenshot.downloadUrl))
    assert.equal(unauthenticatedScreenshotDownload.status, 200)
    assert.equal(unauthenticatedScreenshotDownload.headers.get('content-type'), 'image/jpeg')
    assert.equal(unauthenticatedScreenshotDownload.body.toString('utf8'), 'fake-jpeg')

    const screenshotDownload = await readBytes(
      await fetch(downloaded.body.visualProfile.screenshot.downloadUrl, { headers: auth(config.bridgeToken) })
    )
    assert.equal(screenshotDownload.status, 200)
    assert.equal(screenshotDownload.headers.get('content-type'), 'image/jpeg')
    assert.equal(
      screenshotDownload.headers.get('content-disposition'),
      `attachment; filename="stackprism-${created.body.id}-screenshot.jpg"`
    )
    assert.equal(screenshotDownload.body.toString('utf8'), 'fake-jpeg')

    const apiScreenshotDownload = await readBytes(
      await fetch(downloaded.body.visualProfile.screenshot.downloadUrl, { headers: auth(ready.apiToken) })
    )
    assert.equal(apiScreenshotDownload.status, 200)
    assert.equal(apiScreenshotDownload.headers.get('content-type'), 'image/jpeg')
    assert.equal(apiScreenshotDownload.body.toString('utf8'), 'fake-jpeg')

    const badScreenshotUrl = `${ready.baseUrl}/v1/captures/${created.body.id}/screenshot-download/shot_${'x'.repeat(43)}`
    const missingScreenshotAuth = await readJson(await fetch(badScreenshotUrl))
    assert.equal(missingScreenshotAuth.status, 403)
    assert.equal(missingScreenshotAuth.body.error.code, 'FORBIDDEN')
    const badScreenshotDownload = await readJson(await fetch(badScreenshotUrl, { headers: auth(config.bridgeToken) }))
    assert.equal(badScreenshotDownload.status, 403)
    assert.equal(badScreenshotDownload.body.error.code, 'FORBIDDEN')

    const downloadReadyStatus = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, { headers: auth(ready.apiToken) })
    )
    assert.equal(downloadReadyStatus.status, 200)
    assert.equal(downloadReadyStatus.body.profileDownloadReady, true)

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
    assert.equal(fetched.body.visualProfile.screenshot.dataUrl, undefined)
  })
})

test('bridge status preview derives screenshot mime type from the data URL', async () => {
  await withBridge(async ready => {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    await acceptFinalUrl(ready, created.body.id, config.bridgeToken)

    const profile = profileFor(created.body.id, {
      visualProfile: {
        screenshot: {
          dataUrl: 'data:image/png;base64,ZmFrZS1wbmc=',
          mimeType: 'image/jpeg',
          byteLength: 8,
          scope: 'visible_viewport'
        }
      }
    })
    const posted = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      })
    )

    assert.equal(posted.status, 200)
    assert.equal(posted.body.preview.screenshot.mimeType, 'image/png')
  })
})

test('profile reads and authenticated screenshot downloads refresh result TTL', async () => {
  let now = 1000
  await withBridge(
    async ready => {
      const created = await createCapture(ready)
      const config = await loadBridgeConfig(created.body.bridgeUrl)
      await acceptFinalUrl(ready, created.body.id, config.bridgeToken)
      const profile = profileFor(created.body.id, {
        visualProfile: {
          screenshot: {
            dataUrl: 'data:image/png;base64,ZmFrZS1wbmc=',
            mimeType: 'image/png',
            byteLength: 8,
            scope: 'visible_viewport'
          }
        },
        agentGuidance: { recreationPlan: { visualReference: {} } }
      })
      const posted = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
          method: 'POST',
          headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
          body: JSON.stringify(profile)
        })
      )
      assert.equal(posted.status, 200)
      const capture = ready.store.get(created.body.id)
      const firstExpiry = capture.resultExpiresAt

      now = firstExpiry - 1
      const profileRead = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, { headers: auth(ready.apiToken) })
      )
      assert.equal(profileRead.status, 200)
      assert.equal(profileRead.body.visualProfile.screenshot.dataUrl, undefined)
      assert.equal(capture.resultExpiresAt, now + 100)
      assert.ok(capture.resultExpiresAt > firstExpiry)

      now = firstExpiry + 1
      const screenshot = await readBytes(
        await fetch(profileRead.body.visualProfile.screenshot.downloadUrl, { headers: auth(config.bridgeToken) })
      )
      assert.equal(screenshot.status, 200)
      assert.equal(screenshot.headers.get('content-type'), 'image/png')
      assert.equal(screenshot.body.toString('utf8'), 'fake-png')
      assert.equal(capture.profile.visualProfile.screenshot.dataUrl, undefined)
      assert.equal(capture.screenshotAsset.bytes.toString('utf8'), 'fake-png')
      assert.equal(capture.resultExpiresAt, now + 100)
      assert.ok(capture.resultExpiresAt > firstExpiry + 99)

      now = capture.resultExpiresAt + 1
      const expiredScreenshot = await readJson(
        await fetch(profileRead.body.visualProfile.screenshot.downloadUrl, { headers: auth(config.bridgeToken) })
      )
      assert.equal(expiredScreenshot.status, 410)
      assert.equal(expiredScreenshot.body.error.code, 'CAPTURE_RESULT_EXPIRED')
      assert.equal(capture.profile, null)
      assert.equal(capture.screenshotAsset, null)
    },
    { now: () => now, resultTtlMs: 100 }
  )
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

test('js bridge request shell validation rejects invalid content length before routing', () => {
  let response
  const rejected = rejectBadRequestShell(
    {
      headers: {
        host: '127.0.0.1:17370',
        'content-length': 'nope'
      },
      rawHeaders: ['Host', '127.0.0.1:17370', 'Content-Length', 'nope'],
      url: '/v1/captures'
    },
    {
      writeHead(status, headers) {
        response = { status, headers }
      },
      end(body) {
        response.body = body
      }
    },
    'http://127.0.0.1:17370'
  )

  assert.equal(rejected, true)
  assert.equal(response.status, 400)
  assert.match(response.body, /Content-Length is invalid\./)
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

test('capture store can actively prune expired completed profiles', async () => {
  let now = 1000
  const store = new CaptureStore({
    baseUrl: 'http://127.0.0.1:17370',
    openBrowser: () => ({ ok: true }),
    now: () => now
  })
  const created = await store.create(baseCaptureRequest)
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

test('capture store actively expires completed profiles without a later request', async () => {
  let now = 1000
  const scheduled = []
  const store = new CaptureStore({
    baseUrl: 'http://127.0.0.1:17370',
    openBrowser: () => ({ ok: true }),
    now: () => now,
    resultTtlMs: 25,
    setTimeoutFn: (callback, delay) => {
      scheduled.push({ callback, delay, cleared: false })
      return scheduled.at(-1)
    },
    clearTimeoutFn: timer => {
      timer.cleared = true
    }
  })
  const created = await store.create(baseCaptureRequest)
  assert.equal(created.ok, true)
  store.markProfile(created.capture, profileFor(created.capture.id))
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].delay, 25)
  assert.ok(created.capture.profile)

  now = created.capture.resultExpiresAt + 1
  scheduled[0].callback()
  assert.equal(created.capture.status, 'expired')
  assert.equal(created.capture.profile, null)
  assert.equal(created.capture.error.code, 'CAPTURE_RESULT_EXPIRED')
})

test('capture store distinguishes extension, target load, and running timeouts', async () => {
  let now = 1000
  const store = new CaptureStore({
    baseUrl: 'http://127.0.0.1:17370',
    openBrowser: () => ({ ok: true }),
    now: () => now
  })
  const queued = (await store.create(baseCaptureRequest)).capture
  now = queued.extensionDeadlineAt + 1
  store.pruneExpiredResults()
  assert.equal(queued.status, 'failed')
  assert.equal(queued.error.code, 'EXTENSION_NOT_CONNECTED')

  now = 2000
  const targetOpening = (await store.create(baseCaptureRequest)).capture
  targetOpening.status = 'running'
  targetOpening.phase = 'target_opening'
  assert.equal(targetOpening.deadlineAt - targetOpening.createdAt, 95000)
  now = targetOpening.deadlineAt + 1
  store.pruneExpiredResults()
  assert.equal(targetOpening.status, 'failed')
  assert.equal(targetOpening.error.code, 'TARGET_LOAD_TIMEOUT')

  now = 3000
  const running = (await store.create(baseCaptureRequest)).capture
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

test('js bridge open-browser helper validates parsed env before spawning', async () => {
  assert.deepEqual(parseOpenTimeoutMs({}), { ok: true, timeoutMs: 5000 })
  assert.deepEqual(parseOpenTimeoutMs({ STACKPRISM_BROWSER_OPEN_TIMEOUT_MS: '250' }), { ok: true, timeoutMs: 250 })
  assert.deepEqual(parseOpenTimeoutMs({ STACKPRISM_BROWSER_OPEN_TIMEOUT_MS: '99' }), {
    ok: false,
    details: { reason: 'invalid_open_timeout' }
  })

  const result = await openBrowser('http://127.0.0.1:1/bridge', {
    STACKPRISM_BROWSER_OPEN_COMMAND: process.execPath,
    STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['bad\0arg'])
  })

  assert.deepEqual(result, { ok: false, details: { reason: 'BRIDGE_INVALID_ENV', message: 'Browser open environment contains NUL.' } })

  const invalidTimeout = await openBrowser('http://127.0.0.1:1/bridge', {
    STACKPRISM_BROWSER_OPEN_COMMAND: process.execPath,
    STACKPRISM_BROWSER_OPEN_TIMEOUT_MS: '30001'
  })
  assert.deepEqual(invalidTimeout, { ok: false, details: { reason: 'invalid_open_timeout' } })

  const invalidUrl = await openBrowser('http://127.0.0.1:1/bridge\nnext', { STACKPRISM_BRIDGE_NO_OPEN: '1' })
  assert.deepEqual(invalidUrl, { ok: false, details: { reason: 'invalid_url' } })

  const credentialUrl = await openBrowser('http://user:pass@127.0.0.1:1/bridge', { STACKPRISM_BRIDGE_NO_OPEN: '1' })
  assert.deepEqual(credentialUrl, { ok: false, details: { reason: 'invalid_url' } })

  const invalidScheme = await openBrowser('file:///tmp/stackprism.html', { STACKPRISM_BRIDGE_NO_OPEN: '1' })
  assert.deepEqual(invalidScheme, { ok: false, details: { reason: 'invalid_scheme', allowed: ['http', 'https'] } })

  const missingCommand = await openBrowser('http://127.0.0.1:1/bridge', {
    STACKPRISM_BROWSER_OPEN_COMMAND: '/definitely/missing/stackprism-browser'
  })
  assert.deepEqual(missingCommand, { ok: false, details: { reason: 'command_not_found' } })

  const openFailed = await openBrowser('http://127.0.0.1:1/bridge', {
    STACKPRISM_BROWSER_OPEN_COMMAND: process.execPath,
    STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['--input-type=module', '-e', 'process.exit(7)']),
    STACKPRISM_BROWSER_OPEN_TIMEOUT_MS: '1000'
  })
  assert.deepEqual(openFailed, { ok: false, details: { reason: 'open_failed', exitCode: 7 } })
})

test('js bridge open-browser helper appends bridge URL as one argv', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-open-'))
  const argvPath = join(tempDir, 'argv.json')
  const bridgeUrl = 'http://127.0.0.1:17370/bridge?session=s&capture=c&nonce=n value"quote;&cmd=$(echo bad)'
  const script = "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))"

  try {
    const result = await openBrowser(bridgeUrl, {
      STACKPRISM_BROWSER_OPEN_COMMAND: process.execPath,
      STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['--input-type=module', '-e', script, argvPath])
    })

    assert.deepEqual(result, { ok: true })
    waitForFileSync(argvPath)
    assert.deepEqual(JSON.parse(readFileSync(argvPath, 'utf8')), [bridgeUrl])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('js bridge open-browser helper selects platform default opener without shell parsing', () => {
  assert.deepEqual(resolveBrowserOpenCommand({}, 'darwin'), { ok: true, command: 'open', args: [] })
  assert.deepEqual(resolveBrowserOpenCommand({}, 'win32'), {
    ok: true,
    command: 'rundll32.exe',
    args: ['url.dll,FileProtocolHandler']
  })
  assert.deepEqual(resolveBrowserOpenCommand({}, 'linux'), { ok: true, command: 'xdg-open', args: [] })
  assert.deepEqual(
    resolveBrowserOpenCommand(
      {
        STACKPRISM_BROWSER_OPEN_COMMAND: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['--profile-directory=Default'])
      },
      'darwin'
    ),
    {
      ok: true,
      command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--profile-directory=Default']
    }
  )
  assert.deepEqual(
    resolveBrowserOpenCommand(
      {
        STACKPRISM_BROWSER_OPEN_COMMAND: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['--profile-directory=Profile 2'])
      },
      'win32'
    ),
    {
      ok: true,
      command: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: ['--profile-directory=Profile 2']
    }
  )
  assert.deepEqual(
    resolveBrowserOpenCommand(
      {
        STACKPRISM_BROWSER_OPEN_COMMAND: 'firefox',
        STACKPRISM_BROWSER_OPEN_ARGS_JSON: JSON.stringify(['-P', 'stackprism-dev'])
      },
      'linux'
    ),
    {
      ok: true,
      command: 'firefox',
      args: ['-P', 'stackprism-dev']
    }
  )
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

test('bridge cli startup failure code is part of the bridge error contract', async () => {
  const { isKnownBridgeErrorCode, sanitizeBridgeError } =
    await import('../agent-skill/stackprism-site-experience/scripts/bridge/protocol.mjs')

  assert.equal(isKnownBridgeErrorCode('BRIDGE_START_FAILED'), true)
  assert.equal(isKnownBridgeErrorCode('BRIDGE_PAGE_RENDER_FAILED'), true)
  assert.equal(sanitizeBridgeError({ code: 'BRIDGE_START_FAILED', message: 'Bridge server startup failed.' }).code, 'BRIDGE_START_FAILED')
  assert.equal(
    sanitizeBridgeError({ code: 'BRIDGE_PAGE_RENDER_FAILED', message: 'Bridge page render failed.' }).code,
    'BRIDGE_PAGE_RENDER_FAILED'
  )
  const sanitized = sanitizeBridgeError({
    code: 'INVALID_REQUEST',
    message: `screenshot shot_${'a'.repeat(43)} failed`,
    details: {
      url: `http://127.0.0.1:17370/v1/captures/cap_1234567890123456789012/screenshot-download/shot_${'b'.repeat(43)}`
    }
  })
  assert.equal(sanitized.message, 'screenshot [redacted-id] failed')
  assert.equal(JSON.stringify(sanitized).includes('shot_'), false)
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

test('capture-site helper terminal settle parser defaults invalid nullable values', () => {
  assert.equal(parseTerminalSettleMs(undefined), 3000)
  assert.equal(parseTerminalSettleMs(null), 3000)
  assert.equal(parseTerminalSettleMs(''), 3000)
  assert.equal(parseTerminalSettleMs('0'), 0)
  assert.equal(parseTerminalSettleMs('5000'), 5000)
  assert.equal(parseTerminalSettleMs('5001'), 3000)
  assert.equal(parseTerminalSettleMs('invalid'), 3000)
})

test('capture-site helper emits one machine-readable argument error', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-capture-site-args-'))
  const profilePath = join(tempDir, 'profile.json')

  try {
    const child = spawn(
      process.execPath,
      [
        'agent-skill/stackprism-site-experience/scripts/capture-site.mjs',
        '--url',
        'https://example.test/',
        '--out',
        profilePath,
        '--include',
        'tech,unknown'
      ],
      {
        cwd: new URL('..', import.meta.url),
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const [code] = await once(child, 'exit')
    const lines = stderr.trim().split('\n')
    const parsed = JSON.parse(stderr.trim())

    assert.notEqual(code, 0)
    assert.equal(stdout.trim(), '')
    assert.equal(lines.length, 1)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.error.code, 'INVALID_REQUEST')
    assert.match(parsed.error.message, /--include/)
    assert.match(parsed.error.details.usage, /Usage: node agent-skill\/stackprism-site-experience\/scripts\/capture-site\.mjs/)
    assert.match(parsed.error.details.usage, /--no-screenshot/)
    assert.doesNotMatch(stderr, /^Usage:/)
    assert.equal(existsSync(profilePath), false)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('capture-site helper preserves PORT_IN_USE startup errors', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-capture-site-port-'))
  const profilePath = join(tempDir, 'profile.json')
  const occupied = net.createServer()
  occupied.listen(0, '127.0.0.1')
  await once(occupied, 'listening')
  const { port } = occupied.address()

  try {
    const child = spawn(
      process.execPath,
      ['agent-skill/stackprism-site-experience/scripts/capture-site.mjs', '--url', 'https://example.test/', '--out', profilePath],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, STACKPRISM_BRIDGE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
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
    assert.equal(stdout.trim(), '')
    assert.equal(parsed.error.code, 'PORT_IN_USE')
    assert.match(parsed.error.message, /port is already in use/i)
    assert.equal(existsSync(profilePath), false)
  } finally {
    await new Promise(resolve => occupied.close(resolve))
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('capture-site helper keeps bridge stdin open and writes profile artifacts', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-capture-site-'))
  const fakeBridgePath = join(tempDir, 'fake-bridge.mjs')
  const profilePath = join(tempDir, 'profile.json')
  const resultPath = join(tempDir, 'result.json')
  const screenshotPath = join(tempDir, 'screenshot.jpg')
  const logPath = join(tempDir, 'fake-bridge-log.json')
  const fakeProfile = profileFor('pending', {
    target: { url: 'https://example.test/', finalUrl: 'https://example.test/final', language: 'en' },
    techProfile: { technologies: [{ name: 'Vue' }, { name: 'Vite' }] },
    visualProfile: {
      screenshot: {
        downloadUrl: 'pending',
        mimeType: 'image/jpeg',
        byteLength: 9,
        scope: 'visible_viewport',
        note: 'Screenshot image base64 is intentionally omitted from this Profile JSON.'
      }
    },
    agentGuidance: { recreationPlan: { implementationOrder: ['layout'], visualReference: {} } }
  })

  writeFileSync(
    fakeBridgePath,
    `
import http from 'node:http'
import { writeFileSync } from 'node:fs'
const logPath = ${JSON.stringify(logPath)}
let captureId = 'cap_1234567890123456789012'
let requestBody = null
let profile = ${JSON.stringify(fakeProfile)}
let statusReads = 0
const downloadableProfile = () => ({
  ...profile,
  captureId,
  visualProfile: {
    screenshot: {
      ...profile.visualProfile.screenshot,
      downloadUrl: 'http://127.0.0.1:' + server.address().port + '/v1/captures/' + captureId + '/screenshot-download'
    }
  }
})
let stdinEnded = false
let completedAt = 0
let profileDownloadedAt = 0
let screenshotDownloadedAt = 0
let stdinEndedAt = 0
const token = 'spb_${'a'.repeat(43)}'
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/health') return send(200, { ok: true })
    if (req.method === 'POST' && req.url === '/v1/captures') {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return send(200, { id: captureId, status: 'queued', bridgeUrl: 'http://127.0.0.1/bridge', profileUrl: '/profile' })
    }
    if (req.url === '/v1/captures/' + captureId) {
      statusReads += 1
      if (statusReads >= 2 && !completedAt) completedAt = Date.now()
      return send(200, {
        id: captureId,
        status: statusReads < 2 ? 'running' : 'completed',
        phase: statusReads < 2 ? 'target_loaded' : 'cleanup',
        profileDownloadReady: profileDownloadedAt > 0
      })
    }
    if (req.url === '/v1/captures/' + captureId + '/profile') {
      return send(200, downloadableProfile())
    }
    if (req.url === '/v1/captures/' + captureId + '/profile-download') {
      profileDownloadedAt = Date.now()
      return send(200, downloadableProfile())
    }
    if (req.url === '/v1/captures/' + captureId + '/screenshot-download') {
      screenshotDownloadedAt = Date.now()
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': '9' })
      res.end('fake jpeg')
      return
    }
    return send(404, { error: { code: 'NOT_FOUND' } })
  })
})
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write(JSON.stringify({
    event: 'stackprism-bridge-ready',
    service: 'stackprism-agent-bridge',
    version: '0.1.0',
    protocolVersion: 1,
    baseUrl: 'http://127.0.0.1:' + port,
    healthUrl: 'http://127.0.0.1:' + port + '/health',
    apiToken: token
  }) + '\\n')
})
process.stdin.on('end', () => {
  stdinEnded = true
  stdinEndedAt = Date.now()
  writeFileSync(logPath, JSON.stringify({ stdinEnded, requestBody, statusReads, completedAt, profileDownloadedAt, screenshotDownloadedAt, stdinEndedAt }))
  server.close(() => process.exit(0))
})
process.stdin.resume()
`,
    'utf8'
  )

  try {
    const child = spawn(
      process.execPath,
      [
        'agent-skill/stackprism-site-experience/scripts/capture-site.mjs',
        '--url',
        'https://example.test/',
        '--out',
        profilePath,
        '--result-out',
        resultPath,
        '--screenshot-out',
        screenshotPath
      ],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, STACKPRISM_CAPTURE_BRIDGE_SCRIPT: fakeBridgePath, STACKPRISM_CAPTURE_TERMINAL_SETTLE_MS: '50' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const exited = await Promise.race([
      once(child, 'exit').then(([code]) => ({ exited: true, code })),
      new Promise(resolve => setTimeout(() => resolve({ exited: false, code: null }), 2500))
    ])
    if (!exited.exited) child.kill('SIGTERM')
    assert.equal(exited.exited, true)
    const { code } = exited
    assert.equal(code, 0, stderr)
    const summary = JSON.parse(stdout.trim())
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    const writtenProfile = JSON.parse(readFileSync(profilePath, 'utf8'))
    const fakeBridgeLog = JSON.parse(readFileSync(logPath, 'utf8'))

    assert.equal(summary.ok, true)
    assert.equal(summary.finalUrl, 'https://example.test/final')
    assert.equal(summary.screenshotPresent, true)
    assert.equal(summary.screenshotWritten, true)
    assert.equal(summary.profileDownloadReady, true)
    assert.equal(summary.captureScreenshot, true)
    assert.equal(result.techCount, 2)
    assert.equal(result.screenshotWritten, true)
    assert.equal(result.captureScreenshot, true)
    assert.equal(result.screenshotPath, screenshotPath)
    assert.equal(result.screenshotDownloadUrl, pathToFileURL(screenshotPath).href)
    assert.equal(result.profileDownloadReady, true)
    assert.equal(writtenProfile.captureId, 'cap_1234567890123456789012')
    assert.equal(writtenProfile.visualProfile.screenshot.downloadUrl, pathToFileURL(screenshotPath).href)
    assert.equal(writtenProfile.visualProfile.screenshot.downloadMethod, 'file')
    assert.equal(writtenProfile.visualProfile.screenshot.localPath, screenshotPath)
    assert.equal(writtenProfile.visualProfile.screenshot.lifecycle.requiresLocalBridge, false)
    assert.equal(writtenProfile.visualProfile.screenshot.lifecycle.availableUntil, '')
    assert.match(writtenProfile.visualProfile.screenshot.lifecycle.note, /localPath/)
    assert.doesNotMatch(JSON.stringify(writtenProfile), /127\.0\.0\.1/)
    assert.doesNotMatch(JSON.stringify(writtenProfile), /data:image\/[a-z]+;base64/)
    assert.equal(writtenProfile.agentGuidance.recreationPlan.visualReference.screenshotDownloadUrl, pathToFileURL(screenshotPath).href)
    assert.equal(writtenProfile.agentGuidance.recreationPlan.visualReference.screenshotLocalPath, screenshotPath)
    assert.equal(readFileSync(screenshotPath, 'utf8'), 'fake jpeg')
    assert.equal(fakeBridgeLog.stdinEnded, true)
    assert.equal(fakeBridgeLog.requestBody.options.targetMode, 'new_tab')
    assert.equal(fakeBridgeLog.requestBody.options.forceRefresh, false)
    assert.equal(fakeBridgeLog.requestBody.options.captureScreenshot, true)
    assert.equal(fakeBridgeLog.requestBody.options.allowPrivateNetworkTarget, false)
    assert.deepEqual(fakeBridgeLog.requestBody.include, ['tech', 'visual', 'layout', 'components', 'interaction', 'ux', 'assets'])
    assert.equal(fakeBridgeLog.statusReads >= 2, true)
    assert.equal(fakeBridgeLog.profileDownloadedAt > 0, true)
    assert.equal(fakeBridgeLog.screenshotDownloadedAt > 0, true)
    assert.equal(fakeBridgeLog.screenshotDownloadedAt >= fakeBridgeLog.profileDownloadedAt, true)
    assert.equal(fakeBridgeLog.stdinEndedAt >= fakeBridgeLog.screenshotDownloadedAt, true)
    assert.equal(fakeBridgeLog.stdinEndedAt - fakeBridgeLog.completedAt >= 40, true)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('capture-site helper accepts a reduced include set for retry captures', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-capture-site-include-'))
  const fakeBridgePath = join(tempDir, 'fake-bridge-include.mjs')
  const profilePath = join(tempDir, 'profile.json')
  const logPath = join(tempDir, 'fake-bridge-log.json')
  const fakeProfile = profileFor('pending', {
    target: { url: 'https://example.test/', finalUrl: 'https://example.test/final', language: 'en' },
    techProfile: { technologies: [] },
    agentGuidance: { recreationPlan: { implementationOrder: ['layout'] } }
  })

  writeFileSync(
    fakeBridgePath,
    `
import http from 'node:http'
import { writeFileSync } from 'node:fs'
const logPath = ${JSON.stringify(logPath)}
const captureId = 'cap_1234567890123456789012'
const profile = ${JSON.stringify(fakeProfile)}
let requestBody = null
const token = 'spb_${'f'.repeat(43)}'
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && req.url === '/v1/captures') {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return send(200, { id: captureId, status: 'queued' })
    }
    if (req.url === '/v1/captures/' + captureId) return send(200, { id: captureId, status: 'completed', phase: 'cleanup' })
    if (req.url === '/v1/captures/' + captureId + '/profile-download') return send(200, { ...profile, captureId })
    return send(404, { error: { code: 'NOT_FOUND' } })
  })
})
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write(JSON.stringify({
    event: 'stackprism-bridge-ready',
    protocolVersion: 1,
    baseUrl: 'http://127.0.0.1:' + port,
    healthUrl: 'http://127.0.0.1:' + port + '/health',
    apiToken: token
  }) + '\\n')
})
process.stdin.on('end', () => {
  writeFileSync(logPath, JSON.stringify({ requestBody }))
  server.close(() => process.exit(0))
})
process.stdin.resume()
`,
    'utf8'
  )

  try {
    const child = spawn(
      process.execPath,
      [
        'agent-skill/stackprism-site-experience/scripts/capture-site.mjs',
        '--url',
        'https://example.test/',
        '--out',
        profilePath,
        '--include',
        'tech,visual,ux',
        '--no-screenshot'
      ],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, STACKPRISM_CAPTURE_BRIDGE_SCRIPT: fakeBridgePath, STACKPRISM_CAPTURE_TERMINAL_SETTLE_MS: '50' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, stderr)
    const summary = JSON.parse(stdout.trim())
    const fakeBridgeLog = JSON.parse(readFileSync(logPath, 'utf8'))
    assert.deepEqual(fakeBridgeLog.requestBody.include, ['tech', 'visual', 'ux'])
    assert.equal(fakeBridgeLog.requestBody.options.captureScreenshot, false)
    assert.equal(summary.include.includes('components'), false)
    assert.deepEqual(summary.include, ['tech', 'visual', 'ux'])
    assert.equal(summary.captureScreenshot, false)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('capture-site helper can explicitly force-refresh the fresh target tab', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-capture-site-force-refresh-'))
  const fakeBridgePath = join(tempDir, 'fake-bridge-force-refresh.mjs')
  const profilePath = join(tempDir, 'profile.json')
  const logPath = join(tempDir, 'fake-bridge-log.json')
  const fakeProfile = profileFor('pending', {
    target: { url: 'https://example.test/', finalUrl: 'https://example.test/final', language: 'en' },
    techProfile: { technologies: [] },
    agentGuidance: { recreationPlan: { implementationOrder: ['layout'] } }
  })

  writeFileSync(
    fakeBridgePath,
    `
import http from 'node:http'
import { writeFileSync } from 'node:fs'
const logPath = ${JSON.stringify(logPath)}
const captureId = 'cap_1234567890123456789012'
const profile = ${JSON.stringify(fakeProfile)}
let requestBody = null
const token = 'spb_${'d'.repeat(43)}'
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && req.url === '/v1/captures') {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return send(200, { id: captureId, status: 'queued' })
    }
    if (req.url === '/v1/captures/' + captureId) return send(200, { id: captureId, status: 'completed', phase: 'cleanup' })
    if (req.url === '/v1/captures/' + captureId + '/profile') return send(200, { ...profile, captureId })
    if (req.url === '/v1/captures/' + captureId + '/profile-download') return send(200, { ...profile, captureId })
    return send(404, { error: { code: 'NOT_FOUND' } })
  })
})
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write(JSON.stringify({
    event: 'stackprism-bridge-ready',
    protocolVersion: 1,
    baseUrl: 'http://127.0.0.1:' + port,
    healthUrl: 'http://127.0.0.1:' + port + '/health',
    apiToken: token
  }) + '\\n')
})
process.stdin.on('end', () => {
  writeFileSync(logPath, JSON.stringify({ requestBody }))
  server.close(() => process.exit(0))
})
process.stdin.resume()
`,
    'utf8'
  )

  try {
    const child = spawn(
      process.execPath,
      [
        'agent-skill/stackprism-site-experience/scripts/capture-site.mjs',
        '--url',
        'https://example.test/',
        '--out',
        profilePath,
        '--force-refresh'
      ],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, STACKPRISM_CAPTURE_BRIDGE_SCRIPT: fakeBridgePath, STACKPRISM_CAPTURE_TERMINAL_SETTLE_MS: '50' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, stderr)
    const fakeBridgeLog = JSON.parse(readFileSync(logPath, 'utf8'))
    assert.equal(fakeBridgeLog.requestBody.options.targetMode, 'new_tab')
    assert.equal(fakeBridgeLog.requestBody.options.forceRefresh, true)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('capture-site helper exits nonzero without writing profile on capture failure', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-capture-site-fail-'))
  const fakeBridgePath = join(tempDir, 'fake-bridge-fail.mjs')
  const profilePath = join(tempDir, 'profile.json')
  writeFileSync(
    fakeBridgePath,
    `
import http from 'node:http'
const token = 'spb_${'b'.repeat(43)}'
const captureId = 'cap_abcdefghijklmnopqrstuv'
const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'POST' && req.url === '/v1/captures') return send(200, { id: captureId, status: 'queued' })
  if (req.url === '/v1/captures/' + captureId) return send(200, {
    id: captureId,
    status: 'failed',
    phase: 'cleanup',
    error: {
      code: 'TARGET_LOAD_FAILED',
      message: 'Target failed while loading https://example.test/app?token=secret&apiToken=spb_${'d'.repeat(43)}#frag.',
      details: {
        url: 'https://example.test/app?token=secret&apiToken=spb_${'d'.repeat(43)}#frag',
        authorization: 'Bearer spb_${'d'.repeat(43)}'
      }
    }
  })
  return send(404, { error: { code: 'NOT_FOUND' } })
})
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write(JSON.stringify({ event: 'stackprism-bridge-ready', protocolVersion: 1, baseUrl: 'http://127.0.0.1:' + port, healthUrl: 'http://127.0.0.1:' + port + '/health', apiToken: token }) + '\\n')
})
process.stdin.on('end', () => server.close(() => process.exit(0)))
process.stdin.resume()
`,
    'utf8'
  )

  try {
    const child = spawn(
      process.execPath,
      ['agent-skill/stackprism-site-experience/scripts/capture-site.mjs', '--url', 'https://example.test/', '--out', profilePath],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, STACKPRISM_CAPTURE_BRIDGE_SCRIPT: fakeBridgePath },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const [code] = await once(child, 'exit')
    const error = JSON.parse(stderr.trim())
    assert.notEqual(code, 0)
    assert.equal(error.error.code, 'TARGET_LOAD_FAILED')
    assert.doesNotMatch(stderr, /token=secret|apiToken=|Bearer spb_|#frag/)
    assert.match(stderr, /\[redacted/)
    assert.equal(existsSync(profilePath), false)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('capture-site helper exits with CAPTURE_BUSY without writing profile', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-capture-site-busy-'))
  const fakeBridgePath = join(tempDir, 'fake-bridge-busy.mjs')
  const profilePath = join(tempDir, 'profile.json')
  writeFileSync(
    fakeBridgePath,
    `
import http from 'node:http'
const token = 'spb_${'g'.repeat(43)}'
const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'POST' && req.url === '/v1/captures') {
    return send(409, {
      error: {
        code: 'CAPTURE_BUSY',
        message: 'Capture already active.',
        details: { captureId: 'cap_abcdefghijklmnopqrstuv' }
      }
    })
  }
  return send(404, { error: { code: 'NOT_FOUND' } })
})
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write(JSON.stringify({ event: 'stackprism-bridge-ready', protocolVersion: 1, baseUrl: 'http://127.0.0.1:' + port, healthUrl: 'http://127.0.0.1:' + port + '/health', apiToken: token }) + '\\n')
})
process.stdin.on('end', () => server.close(() => process.exit(0)))
process.stdin.resume()
`,
    'utf8'
  )

  try {
    const child = spawn(
      process.execPath,
      ['agent-skill/stackprism-site-experience/scripts/capture-site.mjs', '--url', 'https://example.test/', '--out', profilePath],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, STACKPRISM_CAPTURE_BRIDGE_SCRIPT: fakeBridgePath },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const [code] = await once(child, 'exit')
    const error = JSON.parse(stderr.trim())

    assert.notEqual(code, 0)
    assert.equal(stdout.trim(), '')
    assert.equal(error.error.code, 'CAPTURE_BUSY')
    assert.match(error.error.message, /Capture already active/)
    assert.equal(existsSync(profilePath), false)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('capture-site helper does not use nonstandard error bodies as stderr codes', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-capture-site-nonstandard-error-'))
  const fakeBridgePath = join(tempDir, 'fake-bridge-nonstandard-error.mjs')
  const profilePath = join(tempDir, 'profile.json')
  writeFileSync(
    fakeBridgePath,
    `
import http from 'node:http'
const token = 'spb_${'e'.repeat(43)}'
const server = http.createServer((req, res) => {
  res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({
    error: {
      message: 'Proxy failed https://example.test/app?token=secret&apiToken=spb_${'e'.repeat(43)}#frag',
      details: {
        url: 'https://example.test/app?token=secret&apiToken=spb_${'e'.repeat(43)}#frag',
        authorization: 'Bearer spb_${'e'.repeat(43)}'
      }
    }
  }))
})
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write(JSON.stringify({ event: 'stackprism-bridge-ready', protocolVersion: 1, baseUrl: 'http://127.0.0.1:' + port, healthUrl: 'http://127.0.0.1:' + port + '/health', apiToken: token }) + '\\n')
})
process.stdin.on('end', () => server.close(() => process.exit(0)))
process.stdin.resume()
`,
    'utf8'
  )

  try {
    const child = spawn(
      process.execPath,
      ['agent-skill/stackprism-site-experience/scripts/capture-site.mjs', '--url', 'https://example.test/', '--out', profilePath],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, STACKPRISM_CAPTURE_BRIDGE_SCRIPT: fakeBridgePath },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const [code] = await once(child, 'exit')
    const error = JSON.parse(stderr.trim())

    assert.notEqual(code, 0)
    assert.equal(error.error.code, 'CAPTURE_FAILED')
    assert.doesNotMatch(stderr, /token=secret|apiToken=|Bearer spb_|#frag/)
    assert.match(stderr, /\[redacted/)
    assert.equal(existsSync(profilePath), false)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('capture-site helper aborts stalled bridge API requests', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-capture-site-stall-'))
  const fakeBridgePath = join(tempDir, 'fake-bridge-stall.mjs')
  const profilePath = join(tempDir, 'profile.json')
  writeFileSync(
    fakeBridgePath,
    `
import http from 'node:http'
const token = 'spb_${'c'.repeat(43)}'
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/captures') return
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
})
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write(JSON.stringify({ event: 'stackprism-bridge-ready', protocolVersion: 1, baseUrl: 'http://127.0.0.1:' + port, healthUrl: 'http://127.0.0.1:' + port + '/health', apiToken: token }) + '\\n')
})
process.stdin.on('end', () => server.close(() => process.exit(0)))
process.stdin.resume()
`,
    'utf8'
  )

  try {
    const child = spawn(
      process.execPath,
      [
        'agent-skill/stackprism-site-experience/scripts/capture-site.mjs',
        '--url',
        'https://example.test/',
        '--out',
        profilePath,
        '--request-timeout-ms',
        '200'
      ],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, STACKPRISM_CAPTURE_BRIDGE_SCRIPT: fakeBridgePath },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const exited = await Promise.race([
      once(child, 'exit').then(([code]) => ({ exited: true, code })),
      new Promise(resolve => setTimeout(() => resolve({ exited: false, code: null }), 3000))
    ])
    if (!exited.exited) child.kill('SIGTERM')
    assert.equal(exited.exited, true)
    const error = JSON.parse(stderr.trim())
    assert.notEqual(exited.code, 0)
    assert.equal(error.error.code, 'BRIDGE_REQUEST_TIMEOUT')
    assert.equal(existsSync(profilePath), false)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
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

    const compatibleIpv6PrivateTarget = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { ...auth(ready.apiToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseCaptureRequest, url: 'http://[::7f00:1]:3000/' })
      })
    )
    assert.equal(compatibleIpv6PrivateTarget.status, 400)
    assert.equal(compatibleIpv6PrivateTarget.body.error.code, 'PRIVATE_NETWORK_TARGET_BLOCKED')

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

    for (const alias of ['2130706433', '127.1', '0x7f000001', '[::ffff:127.0.0.1]', '[::7f00:1]']) {
      const aliasSelfTarget = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures`, {
          method: 'POST',
          headers: { ...auth(ready.apiToken), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...baseCaptureRequest,
            url: ready.baseUrl.replace('127.0.0.1', alias),
            options: { ...baseCaptureRequest.options, allowPrivateNetworkTarget: true }
          })
        })
      )
      assert.equal(aliasSelfTarget.status, 400, alias)
      assert.equal(aliasSelfTarget.body.error.code, 'BRIDGE_SELF_TARGET_BLOCKED', alias)
    }

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

  const screenshotOption = await normalizeCaptureRequest(
    { ...baseCaptureRequest, options: { ...baseCaptureRequest.options, captureScreenshot: true } },
    'http://127.0.0.1:17370',
    { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] }
  )
  assert.equal(screenshotOption.ok, true)
  assert.equal(screenshotOption.request.options.captureScreenshot, true)

  const invalidScreenshotOption = await normalizeCaptureRequest(
    { ...baseCaptureRequest, options: { ...baseCaptureRequest.options, captureScreenshot: 'true' } },
    'http://127.0.0.1:17370'
  )
  assert.equal(invalidScreenshotOption.ok, false)
  assert.equal(invalidScreenshotOption.code, 'INVALID_REQUEST')

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

  const proxyReservedResult = await normalizeCaptureRequest(
    { ...baseCaptureRequest, url: urlPolicyCases.proxyReservedHostname.url },
    'http://127.0.0.1:17370',
    {
      resolveHostname: async () => urlPolicyCases.proxyReservedHostname.resolvedAddresses.map(address => ({ address, family: 4 }))
    }
  )
  assert.equal(proxyReservedResult.ok, true)
  assert.equal(proxyReservedResult.request.url, urlPolicyCases.proxyReservedHostname.normalizedUrl)

  const proxyReservedIpLiteralResult = await normalizeCaptureRequest(
    { ...baseCaptureRequest, url: urlPolicyCases.proxyReservedIpLiteral.url },
    'http://127.0.0.1:17370'
  )
  assert.equal(proxyReservedIpLiteralResult.ok, false)
  assert.equal(proxyReservedIpLiteralResult.code, urlPolicyCases.proxyReservedIpLiteral.errorCode)
  assert.equal(proxyReservedIpLiteralResult.details.reason, 'private_network_address')

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
      assert.equal(status.body.phase, 'target_loaded')
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
      for (const [label, extra] of [
        ['direct private address', {}],
        ['cached private address', { targetNetworkFromCache: true }]
      ]) {
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
                targetNetworkAddress: '127.0.0.1',
                ...extra
              })
            )
          })
        )
        assert.equal(status.status, 409, label)
        assert.equal(status.body.error.code, 'FINAL_URL_BLOCKED', label)
        assert.equal(status.body.error.details.reason, 'private_network_address', label)
      }
    },
    {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }]
    }
  )
})

test('js bridge accepts proxy-reserved browser-observed addresses for public hostnames', async () => {
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
              finalUrl: 'https://proxy-reserved.example/dashboard',
              targetNetworkAddress: '198.18.0.12'
            })
          )
        })
      )
      assert.equal(status.status, 200)
      assert.equal(status.body.phase, 'target_loaded')
    },
    {
      resolveHostname: async hostname => {
        assert.equal(hostname, 'proxy-reserved.example')
        return [{ address: '198.18.0.12', family: 4 }]
      }
    }
  )
})

test('js bridge accepts public final URLs when browser network address is unavailable', async () => {
  for (const [label, extra] of [
    ['missing address', {}],
    ['cached response', { targetNetworkFromCache: true }]
  ]) {
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
                ...extra
              })
            )
          })
        )
        assert.equal(status.status, 200, label)
        assert.equal(status.body.phase, 'target_loaded', label)
      },
      {
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }]
      }
    )
  }
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

    const failedWithNullError = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'failed', phase: 'cleanup', sequence: 1, error: null }))
      })
    )
    assert.equal(failedWithNullError.status, 400)
    assert.equal(failedWithNullError.body.error.code, 'INVALID_REQUEST')

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
    const failedAtTargetOpening = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { ...auth(config.bridgeToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(created.body.id, config, {
            status: 'failed',
            phase: 'target_opening',
            sequence: 1,
            error: failedError
          })
        )
      })
    )
    assert.equal(failedAtTargetOpening.status, 200)
    assert.equal(failedAtTargetOpening.body.status, 'failed')
    assert.equal(failedAtTargetOpening.body.phase, 'target_opening')
    assert.equal(failedAtTargetOpening.body.error.code, 'TARGET_TAB_CLOSED')
    assertErrorIsRedacted(failedAtTargetOpening.body.error, [ready.apiToken, config.bridgeToken, config.nonce])
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

    const rawBackslashPath = await rawHttp(url.port, ['GET /v1\\captures HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(rawBackslashPath, /400/)
    assert.match(rawBackslashPath, /INVALID_REQUEST/)

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

    const identityContentEncoding = await rawHttp(url.port, [
      'GET /health HTTP/1.1',
      `Host: ${url.host}`,
      'Content-Encoding: Identity',
      'Connection: close',
      '',
      ''
    ])
    assert.match(identityContentEncoding, /200 OK/)

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
