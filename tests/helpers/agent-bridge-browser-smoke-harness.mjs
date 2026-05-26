import { spawn } from 'node:child_process'
import dns from 'node:dns/promises'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'expired'])
const bridgeSecretPattern = /spbt?_[A-Za-z0-9_-]{20,}|(?:apiToken|bridgeToken)=/i

export const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
export const redactText = value => String(value || '').replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]')

export const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const getJson = async url => (await fetch(url)).json()

const playwrightChromeCandidates = () => {
  const roots = [
    {
      path: join(homedir(), 'Library/Caches/ms-playwright'),
      executable: 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    },
    { path: join(homedir(), '.cache/ms-playwright'), executable: 'chrome-linux/chrome' }
  ]
  return roots.flatMap(root => {
    if (!existsSync(root.path)) return []
    return readdirSync(root.path)
      .filter(name => name.startsWith('chromium-'))
      .sort()
      .reverse()
      .map(name => join(root.path, name, root.executable))
  })
}

const findBrowser = () => {
  const browser = [process.env.STACKPRISM_BROWSER_SMOKE_CHROME, ...playwrightChromeCandidates()].filter(Boolean).find(existsSync)
  if (!browser) throw new Error('Chrome for Testing was not found. Set STACKPRISM_BROWSER_SMOKE_CHROME.')
  return browser
}

export const connectTarget = async target => {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', rejectOpen, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  let closed = false
  const rejectPending = reason => {
    if (closed) return
    closed = true
    const error = reason instanceof Error ? reason : new Error(String(reason || 'WebSocket closed'))
    for (const callbacks of pending.values()) callbacks.reject(error)
    pending.clear()
  }
  socket.addEventListener('message', event => {
    if (closed) return
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const callbacks = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) callbacks.reject(new Error(JSON.stringify(message.error)))
    else callbacks.resolve(message.result)
  })
  socket.addEventListener('close', () => rejectPending(new Error('WebSocket closed.')))
  socket.addEventListener('error', event => rejectPending(new Error(`WebSocket error: ${event?.message || 'unknown'}`)))
  return {
    send(method, params = {}) {
      if (closed) return Promise.reject(new Error('WebSocket closed.'))
      const id = ++nextId
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolveSend, rejectSend) => pending.set(id, { resolve: resolveSend, reject: rejectSend }))
    },
    close() {
      rejectPending(new Error('WebSocket closed by harness.'))
      socket.close()
    }
  }
}

export const createBrowserSmokeHarness = ({ root, dist, cdpPort }) => {
  const cdpBaseUrl = `http://127.0.0.1:${cdpPort}`

  const waitForProcessExit = child =>
    !child || child.exitCode !== null || child.signalCode ? Promise.resolve() : new Promise(resolveExit => child.once('exit', resolveExit))

  const stopProcess = async child => {
    if (!child) return
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
    await Promise.race([
      waitForProcessExit(child),
      sleep(1000).then(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      })
    ])
    await Promise.race([waitForProcessExit(child), sleep(1000)])
  }

  const waitForCdp = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        return await getJson(`${cdpBaseUrl}/json/version`)
      } catch {
        await sleep(200)
      }
    }
    throw new Error('Chrome DevTools endpoint did not start.')
  }

  const stackPrismTargets = async () => {
    const targets = await getJson(`${cdpBaseUrl}/json/list`)
    return {
      page: targets.find(target => target.type === 'page'),
      worker: targets.find(target => target.type === 'service_worker' && target.url.includes('service-worker-loader.js'))
    }
  }

  const listTargets = async () => getJson(`${cdpBaseUrl}/json/list`)

  const closeTarget = async targetId => {
    await fetch(`${cdpBaseUrl}/json/close/${targetId}`)
  }

  const closePageTarget = async (target, page) => {
    try {
      page?.close()
    } finally {
      if (target?.id) await closeTarget(target.id).catch(() => {})
    }
  }

  const rawHttp = (port, lines) =>
    new Promise((resolveRaw, rejectRaw) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
      let data = ''
      socket.on('connect', () => socket.write(lines.join('\r\n')))
      socket.on('data', chunk => {
        data += chunk.toString('utf8')
      })
      socket.on('error', rejectRaw)
      socket.on('end', () => resolveRaw(data))
    })

  const waitForWorker = async () => {
    let lastTargets = []
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const targets = await getJson(`${cdpBaseUrl}/json/list`)
      lastTargets = targets.map(target => ({ type: target.type, title: target.title, url: target.url }))
      const worker = targets.find(target => target.type === 'service_worker' && target.url.includes('service-worker-loader.js'))
      if (worker) return worker
      await sleep(250)
    }
    throw new Error(`StackPrism service worker target was not found. Last targets: ${redactText(JSON.stringify(lastTargets))}`)
  }

  const waitForNoWorker = async (attempts = 70) => {
    let lastTargets = []
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const targets = await getJson(`${cdpBaseUrl}/json/list`)
      lastTargets = targets.map(target => ({ type: target.type, title: target.title, url: target.url }))
      const worker = targets.find(target => target.type === 'service_worker' && target.url.includes('service-worker-loader.js'))
      if (!worker) return { attempts: attempt + 1, elapsedMs: attempt * 1000 }
      await sleep(1000)
    }
    throw new Error(`StackPrism service worker target remained active. Last targets: ${redactText(JSON.stringify(lastTargets))}`)
  }

  const startChrome = async ({ extraArgs = [], profileDir = null } = {}) => {
    const resolvedProfileDir = profileDir || (await mkdtemp(join(tmpdir(), 'stackprism-browser-smoke-')))
    const child = spawn(findBrowser(), [
      `--user-data-dir=${resolvedProfileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      `--load-extension=${dist}`,
      `--disable-extensions-except=${dist}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs,
      'about:blank'
    ])
    return { child, profileDir: resolvedProfileDir }
  }

  const startChromeWithoutExtension = async ({ extraArgs = [] } = {}) => {
    const profileDir = await mkdtemp(join(tmpdir(), 'stackprism-browser-smoke-no-extension-'))
    const child = spawn(findBrowser(), [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs,
      'about:blank'
    ])
    return { child, profileDir }
  }

  const startBridge = async (options = {}) => {
    const suppressBrowserOpen = options.noOpen !== false
    const child = spawn(process.execPath, ['agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs'], {
      cwd: root,
      env: { ...process.env, ...(suppressBrowserOpen ? { STACKPRISM_BRIDGE_NO_OPEN: '1' } : {}), ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    const stopChild = async () => {
      await stopProcess(child)
    }
    for (let attempt = 0; attempt < 100 && !stdout.includes('\n'); attempt += 1) await sleep(100)
    if (!stdout.includes('\n')) {
      await stopChild()
      throw new Error(`Bridge ready JSON was not printed. stderr=${redactText(stderr)}`)
    }
    try {
      const ready = JSON.parse(stdout.trim().split('\n')[0])
      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        await stopChild()
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            await fetch(ready.healthUrl, { signal: AbortSignal.timeout(250) })
          } catch {
            return
          }
          await sleep(100)
        }
        throw new Error(`Bridge health endpoint was still reachable after stop: ${ready.healthUrl}`)
      }
      return { child, ready, stderr: () => stderr, stop }
    } catch (error) {
      await stopChild()
      throw new Error(`Bridge ready JSON was invalid. stderr=${redactText(stderr)} error=${redactText(error)}`)
    }
  }

  const stopBridge = async bridge => {
    if (!bridge) return
    if (typeof bridge.stop === 'function') await bridge.stop()
    else await stopProcess(bridge.child)
  }

  const setAgentBridgeEnabled = async (worker, enabled) => {
    await waitForExtensionRuntime(worker)
    await worker.send('Runtime.evaluate', {
      expression: `chrome.storage.local.set({stackPrismSettings:{agentBridgeEnabled:${enabled ? 'true' : 'false'}}})`,
      awaitPromise: true
    })
  }

  const waitForExtensionRuntime = async worker => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await worker.send('Runtime.evaluate', {
        expression: 'typeof chrome !== "undefined" && Boolean(chrome.runtime) && Boolean(chrome.storage?.local)',
        returnByValue: true
      })
      if (result.result?.value === true) return
      await sleep(250)
    }
    throw new Error('StackPrism extension runtime APIs were not ready in the service worker target.')
  }

  const createCapture = async (ready, request) => {
    const body = JSON.stringify({
      url: request.url,
      mode: 'experience',
      waitMs: request.waitMs ?? 0,
      include: request.include || ['tech', 'visual', 'layout', 'components', 'interaction', 'ux', 'assets'],
      options: request.options || { allowPrivateNetworkTarget: false }
    })
    const response = await fetch(`${ready.baseUrl}/v1/captures`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ready.apiToken}`, 'content-type': 'application/json' },
      body
    })
    return { status: response.status, body: await response.json() }
  }

  const createPrivateTargetBlockedCapture = async (ready, target) => {
    const targetUrl = typeof target === 'string' ? target : target.url
    const blocked = await createCapture(ready, {
      url: targetUrl,
      options: { allowPrivateNetworkTarget: false, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    const targets = await listTargets()
    const targetStillVisible = targets.some(targetItem => targetItem.type === 'page' && String(targetItem.url || '').startsWith(targetUrl))
    return {
      blocked,
      requestCount: typeof target.requestCount === 'function' ? target.requestCount() : null,
      targetStillVisible
    }
  }

  const createDnsNonGlobalBlockedCapture = async ready => {
    const hostname = 'stackprism-browser-smoke.invalid'
    const targetUrl = `https://${hostname}/dns-policy?token=secret#frag`
    let resolvedAddresses = []
    let dnsError = ''
    try {
      resolvedAddresses = (await dns.lookup(hostname, { all: true, verbatim: true })).map(item => item.address)
    } catch (error) {
      dnsError = error?.code || (error instanceof Error ? error.message : String(error))
    }
    const blocked = await createCapture(ready, {
      url: targetUrl,
      options: { allowPrivateNetworkTarget: false, captureScreenshotMetadata: false, keepTabOpen: false, targetMode: 'new_tab' }
    })
    const targets = await listTargets()
    const targetStillVisible = targets.some(target => target.type === 'page' && String(target.url || '').startsWith(targetUrl))
    return { blocked, dnsError, hostname, resolvedAddresses, targetStillVisible }
  }

  const pollCapture = async (ready, captureId, attempts = 70) => {
    let lastStatus = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(1000)
      const response = await fetch(`${ready.baseUrl}/v1/captures/${captureId}`, {
        headers: { authorization: `Bearer ${ready.apiToken}` }
      })
      lastStatus = await response.json()
      if (terminalStatuses.has(lastStatus.status)) return lastStatus
    }
    throw new Error(`Capture ${captureId} did not reach a terminal status. Last status: ${JSON.stringify(lastStatus)}`)
  }

  const fetchJson = async (url, init) => {
    const response = await fetch(url, init)
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null, text }
  }

  const newPageTarget = async () => {
    const response = await fetch(`${cdpBaseUrl}/json/new?about:blank`, { method: 'PUT' })
    if (!response.ok) throw new Error(`Failed to create CDP page: ${response.status}`)
    return response.json()
  }

  const newIncognitoPageTarget = async (url = 'about:blank') => {
    const version = await waitForCdp()
    const browser = await connectTarget({ webSocketDebuggerUrl: version.webSocketDebuggerUrl })
    try {
      const { browserContextId } = await browser.send('Target.createBrowserContext')
      const { targetId } = await browser.send('Target.createTarget', { browserContextId, url })
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const target = (await listTargets()).find(item => item.id === targetId)
        if (target?.webSocketDebuggerUrl) return { browserContextId, target }
        await sleep(100)
      }
      throw new Error(`Incognito CDP target ${targetId} was not visible.`)
    } finally {
      browser.close()
    }
  }

  const disposeBrowserContext = async browserContextId => {
    if (!browserContextId) return
    const version = await waitForCdp()
    const browser = await connectTarget({ webSocketDebuggerUrl: version.webSocketDebuggerUrl })
    try {
      await browser.send('Target.disposeBrowserContext', { browserContextId })
    } finally {
      browser.close()
    }
  }

  const navigateBridgePage = async (target, bridgeUrl) => {
    const page = await connectTarget(target)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Page.navigate', { url: bridgeUrl })
    let serializedHistory = ''
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const currentUrl = await page.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
      const navigationHistory = await page.send('Page.getNavigationHistory')
      serializedHistory = JSON.stringify({
        currentUrl: currentUrl.result?.value,
        navigationHistory
      })
      if (serializedHistory.includes('/bridge?')) break
      await sleep(50)
    }
    assert(serializedHistory.includes('/bridge?'), `Bridge navigation history did not include bridge URL: ${redactText(serializedHistory)}`)
    assert(
      !bridgeSecretPattern.test(serializedHistory),
      `Bridge navigation history leaked token material: ${redactText(serializedHistory)}`
    )
    return page
  }

  const openBridgePage = async bridgeUrl => {
    const target = await newPageTarget()
    const page = await navigateBridgePage(target, bridgeUrl)
    return { target, page }
  }

  const openIncognitoBridgePage = async bridgeUrl => {
    const { browserContextId, target } = await newIncognitoPageTarget()
    const page = await navigateBridgePage(target, bridgeUrl)
    const close = async () => {
      try {
        await closePageTarget(target, page)
      } finally {
        await disposeBrowserContext(browserContextId).catch(() => {})
      }
    }
    return { browserContextId, close, page, target }
  }

  const probeBridgeIframeBlocking = async bridgeUrl => {
    let attackerRequestCount = 0
    const server = createServer((_req, res) => {
      attackerRequestCount += 1
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`<!doctype html><html><body><iframe id="bridge-frame" src="${bridgeUrl}"></iframe></body></html>`)
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const { port } = server.address()
    const attackerUrl = `http://127.0.0.1:${port}/attacker-frame`
    const target = await newPageTarget()
    const page = await connectTarget(target)
    let probe = null
    try {
      await page.send('Page.enable')
      await page.send('Runtime.enable')
      await page.send('Page.navigate', { url: attackerUrl })
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await page.send('Runtime.evaluate', {
          expression: `(() => {
            const frame = document.querySelector('#bridge-frame');
            let frameAccess = 'missing';
            let frameBodyText = '';
            let frameHtmlIncludesBridgeToken = false;
            try {
              if (frame?.contentDocument) {
                frameAccess = 'accessible';
                frameBodyText = frame.contentDocument.body?.innerText || '';
                frameHtmlIncludesBridgeToken = frame.contentDocument.documentElement?.outerHTML.includes('spbt_') === true;
              } else {
                frameAccess = 'not-accessible';
              }
            } catch {
              frameAccess = 'cross-origin-or-blocked';
            }
            return JSON.stringify({
              bodyText: document.body?.innerText || '',
              frameAccess,
              frameBodyText,
              frameCount: window.frames.length,
              frameSrc: frame?.getAttribute('src') || '',
              frameHtmlIncludesBridgeToken,
              outerHtmlIncludesBridgeToken: document.documentElement.outerHTML.includes('spbt_')
            });
          })()`,
          returnByValue: true
        })
        probe = JSON.parse(result.result?.value || '{}')
        if (probe.frameCount > 0) break
        await sleep(100)
      }
      const firstRender = await fetch(bridgeUrl)
      const firstRenderText = await firstRender.text()
      return {
        attackerRequestCount,
        attackerUrl,
        firstRenderContainsBridgeToken: firstRenderText.includes('spbt_'),
        firstRenderStatus: firstRender.status,
        probe
      }
    } finally {
      await closePageTarget(target, page)
      server.close()
    }
  }

  const disableExtensionFromExtensionsPage = async extensionId => {
    const safeExtensionId = String(extensionId || '')
    if (!/^[a-z]{32}$/.test(safeExtensionId)) throw new Error('Extension id was not a Chrome extension id.')
    const target = await newPageTarget()
    const page = await connectTarget(target)
    let lastResult = null
    const extensionSelector = `extensions-item#${safeExtensionId}`
    try {
      await page.send('Page.enable')
      await page.send('Runtime.enable')
      await page.send('Page.navigate', { url: `chrome://extensions/?id=${safeExtensionId}` })
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(250)
        const result = await page.send('Runtime.evaluate', {
          expression: `(() => {
            const manager = document.querySelector('extensions-manager');
            const itemList = manager?.shadowRoot?.querySelector('extensions-item-list');
            const item = itemList?.shadowRoot?.querySelector(${JSON.stringify(extensionSelector)});
            const toggle = item?.shadowRoot?.querySelector('#enableToggle');
            if (!toggle) return JSON.stringify({ found: false, before: null, after: null });
            const before = Boolean(toggle.checked);
            if (before) toggle.click();
            return JSON.stringify({ found: true, before, after: Boolean(toggle.checked) });
          })()`,
          returnByValue: true
        })
        lastResult = JSON.parse(result.result?.value || '{}')
        if (lastResult.found && lastResult.before === true && lastResult.after === false) return lastResult
        if (lastResult.found && lastResult.before === false) return lastResult
      }
      return lastResult || { found: false, before: null, after: null }
    } finally {
      await closePageTarget(target, page)
    }
  }

  const reloadExtensionFromExtensionsPage = async extensionId => {
    const safeExtensionId = String(extensionId || '')
    if (!/^[a-z]{32}$/.test(safeExtensionId)) throw new Error('Extension id was not a Chrome extension id.')
    const target = await newPageTarget()
    const page = await connectTarget(target)
    let lastResult = null
    const extensionSelector = `extensions-item#${safeExtensionId}`
    try {
      await page.send('Page.enable')
      await page.send('Runtime.enable')
      await page.send('Page.navigate', { url: `chrome://extensions/?id=${safeExtensionId}` })
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(250)
        const result = await page.send('Runtime.evaluate', {
          expression: `(() => {
            const manager = document.querySelector('extensions-manager');
            const itemList = manager?.shadowRoot?.querySelector('extensions-item-list');
            const item = itemList?.shadowRoot?.querySelector(${JSON.stringify(extensionSelector)});
            const reload = item?.shadowRoot?.querySelector('#dev-reload-button');
            if (!reload) return JSON.stringify({ found: false, clicked: false, disabled: null });
            const disabled = reload.disabled === true;
            if (!disabled) reload.click();
            return JSON.stringify({ found: true, clicked: !disabled, disabled });
          })()`,
          returnByValue: true
        })
        lastResult = JSON.parse(result.result?.value || '{}')
        if (lastResult.found && lastResult.clicked) return lastResult
        if (lastResult.found && lastResult.disabled) return lastResult
      }
      return lastResult || { found: false, clicked: false, disabled: null }
    } finally {
      await closePageTarget(target, page)
    }
  }

  const enableIncognitoFromExtensionsPage = async extensionId => {
    const safeExtensionId = String(extensionId || '')
    if (!/^[a-z]{32}$/.test(safeExtensionId)) throw new Error('Extension id was not a Chrome extension id.')
    const target = await newPageTarget()
    const page = await connectTarget(target)
    let lastResult = null
    const extensionSelector = `extensions-item#${safeExtensionId}`
    try {
      await page.send('Page.enable')
      await page.send('Runtime.enable')
      await page.send('Page.navigate', { url: `chrome://extensions/?id=${safeExtensionId}` })
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(250)
        const result = await page.send('Runtime.evaluate', {
          expression: `(() => {
            const manager = document.querySelector('extensions-manager');
            const managerRoot = manager?.shadowRoot;
            const detailView = managerRoot?.querySelector('extensions-detail-view');
            if (!detailView) {
              const itemList = managerRoot?.querySelector('extensions-item-list');
              const item = itemList?.shadowRoot?.querySelector(${JSON.stringify(extensionSelector)});
              const detailsButton = item?.shadowRoot?.querySelector('#detailsButton');
              if (detailsButton) detailsButton.click();
              return JSON.stringify({ found: false, detailView: false, clickedDetails: Boolean(detailsButton), before: null, after: null, disabled: null });
            }
            const row = detailView.shadowRoot?.querySelector('#allow-incognito');
            const toggle = row?.shadowRoot?.querySelector('cr-toggle') || row?.shadowRoot?.querySelector('#crToggle');
            if (!row && !toggle) {
              return JSON.stringify({ found: false, detailView: true, clickedDetails: false, before: null, after: null, disabled: null });
            }
            const before = Boolean(row?.checked ?? toggle?.checked);
            const disabled = Boolean(row?.disabled ?? toggle?.disabled);
            if (!before && !disabled) (toggle || row).click();
            const after = Boolean(row?.checked ?? toggle?.checked);
            const restartText = detailView.shadowRoot?.textContent || '';
            return JSON.stringify({ found: true, detailView: true, clickedDetails: false, before, after, disabled, restartRequired: /restart|重新启动|重启/i.test(restartText) });
          })()`,
          returnByValue: true
        })
        lastResult = JSON.parse(result.result?.value || '{}')
        if (lastResult.found && lastResult.after === true) return lastResult
        if (lastResult.found && lastResult.disabled) return lastResult
      }
      return lastResult || { found: false, before: null, after: null, disabled: null }
    } finally {
      await closePageTarget(target, page)
    }
  }

  const driveCapture = async (ready, capture) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    const { page } = opened
    const finalStatus = await pollCapture(ready, capture.body.id)
    const profile =
      finalStatus?.status === 'completed'
        ? await fetchJson(`${ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
            headers: { authorization: `Bearer ${ready.apiToken}` }
          })
        : null
    const dom = await page.send('Runtime.evaluate', {
      expression:
        '({ready:document.documentElement.dataset.stackprismAgentBridgeClient||"",error:document.documentElement.dataset.stackprismAgentBridgeError||"",title:document.title})',
      returnByValue: true
    })
    await closePageTarget(opened.target, page)
    return { finalStatus, profile, dom: dom.result.value }
  }

  const getExtensionCaptureState = async (worker, captureId) => {
    const result = await worker.send('Runtime.evaluate', {
      expression: `chrome.storage.session.get('agent-capture:${captureId}').then(value => JSON.stringify(value['agent-capture:${captureId}'] || null))`,
      awaitPromise: true,
      returnByValue: true
    })
    return JSON.parse(result.result?.value || 'null')
  }

  const debugExtensionCaptureState = async (worker, captureId) => {
    const result = await worker.send('Runtime.evaluate', {
      expression: `Promise.all([
        chrome.storage.session.get(null),
        chrome.tabs.query({})
      ]).then(([storage, tabs]) => JSON.stringify({
        captureId: ${JSON.stringify(captureId)},
        storageKeys: Object.keys(storage).filter(key => key.startsWith('agent-capture:') || key.startsWith('agent-bridge-session:')).sort(),
        tabUrls: tabs.map(tab => ({id: tab.id, windowId: tab.windowId, url: tab.url, status: tab.status, incognito: tab.incognito}))
      }))`,
      awaitPromise: true,
      returnByValue: true
    })
    try {
      return JSON.parse(result.result?.value || '{}')
    } catch {
      return { parseError: true, value: result.result?.value || '' }
    }
  }

  const waitForExtensionCaptureState = async (worker, captureId, predicate, attempts = 100) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = await getExtensionCaptureState(worker, captureId)
      if (state && predicate(state)) return state
      await sleep(100)
    }
    const debug = await debugExtensionCaptureState(worker, captureId).catch(error => ({
      error: error instanceof Error ? error.message : String(error)
    }))
    throw new Error(`Extension capture state was not observed for ${captureId}. Debug: ${redactText(JSON.stringify(debug))}`)
  }

  const removeTab = async (worker, tabId) => {
    await worker.send('Runtime.evaluate', {
      expression: `chrome.tabs.remove(${Number(tabId)})`,
      awaitPromise: true
    })
  }

  const updateTabUrl = async (worker, tabId, url) => {
    const result = await worker.send('Runtime.evaluate', {
      expression: `chrome.tabs.update(${Number(tabId)}, { url: ${JSON.stringify(url)} }).then(tab => JSON.stringify({ id: tab.id, url: tab.url || '', status: tab.status || '' }))`,
      awaitPromise: true,
      returnByValue: true
    })
    return JSON.parse(result.result?.value || '{}')
  }

  const createExtensionTab = async (worker, url, { active = true } = {}) => {
    const result = await worker.send('Runtime.evaluate', {
      expression: `chrome.tabs.create({ url: ${JSON.stringify(url)}, active: ${active ? 'true' : 'false'} }).then(tab => JSON.stringify({ id: tab.id, windowId: tab.windowId, url: tab.url || '', active: tab.active === true }))`,
      awaitPromise: true,
      returnByValue: true
    })
    return JSON.parse(result.result?.value || '{}')
  }

  const listExtensionTabs = async worker => {
    const result = await worker.send('Runtime.evaluate', {
      expression: `chrome.tabs.query({}).then(tabs => JSON.stringify(tabs.map(tab => ({ id: tab.id, windowId: tab.windowId, url: tab.url || '', active: tab.active === true, status: tab.status || '' }))))`,
      awaitPromise: true,
      returnByValue: true
    })
    return JSON.parse(result.result?.value || '[]')
  }

  const waitForNoPageTarget = async urlPrefix => {
    let visibleTargets = []
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const targets = await listTargets()
      visibleTargets = targets.filter(target => target.type === 'page' && String(target.url || '').startsWith(urlPrefix))
      if (visibleTargets.length === 0) return { targetStillVisible: false, visibleTargets: [] }
      await sleep(100)
    }
    return {
      targetStillVisible: true,
      visibleTargets: visibleTargets.map(target => ({ id: target.id, url: target.url }))
    }
  }

  const tabExists = async (worker, tabId) => {
    const result = await worker.send('Runtime.evaluate', {
      expression: `chrome.tabs.get(${Number(tabId)}).then(() => true).catch(() => false)`,
      awaitPromise: true,
      returnByValue: true
    })
    return result.result?.value === true
  }

  const driveCaptureWithClosedTarget = async (ready, worker, capture) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    const state = await waitForExtensionCaptureState(worker, capture.body.id, value => Number.isInteger(value.targetTabId))
    await removeTab(worker, state.targetTabId)
    const finalStatus = await pollCapture(ready, capture.body.id, 20)
    await closePageTarget(opened.target, opened.page)
    return { finalStatus, closedTabId: state.targetTabId }
  }

  const driveCaptureWithClosedBridge = async (ready, worker, capture) => {
    const target = await newPageTarget()
    const page = await connectTarget(target)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Page.navigate', { url: capture.body.bridgeUrl })
    const state = await waitForExtensionCaptureState(worker, capture.body.id, value => Number.isInteger(value.bridgeTabId))
    await removeTab(worker, state.bridgeTabId)
    const finalStatus = await pollCapture(ready, capture.body.id, 20)
    await closePageTarget(target, page)
    return { finalStatus, closedTabId: state.bridgeTabId }
  }

  const driveCaptureWithCancel = async (ready, worker, capture) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    const state = await waitForExtensionCaptureState(worker, capture.body.id, value => Number.isInteger(value.targetTabId))
    const cancel = await fetchJson(`${ready.baseUrl}/v1/captures/${capture.body.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ready.apiToken}` }
    })
    const finalStatus = await pollCapture(ready, capture.body.id, 20)
    const targetStillExists = await tabExists(worker, state.targetTabId)
    await closePageTarget(opened.target, opened.page)
    return { cancelStatus: cancel.status, finalStatus, closedTabId: state.targetTabId, targetStillExists }
  }

  const driveCaptureWithLocalOptInDisabled = async (ready, worker, capture, targetUrlPrefix) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    try {
      await waitForExtensionRuntime(worker)
      const state = await waitForExtensionCaptureState(worker, capture.body.id, value => Number.isInteger(value.targetTabId))
      await setAgentBridgeEnabled(worker, false)
      const finalStatus = await pollCapture(ready, capture.body.id, 20)
      const targets = await listTargets()
      const targetStillVisible = targets.some(target => target.type === 'page' && String(target.url || '').startsWith(targetUrlPrefix))
      return { finalStatus, targetTabId: state.targetTabId, targetStillVisible }
    } finally {
      await closePageTarget(opened.target, opened.page)
    }
  }

  const driveCaptureWithExpiredDeadlineReconciliation = async (ready, worker, capture, targetUrlPrefix) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    try {
      await waitForExtensionRuntime(worker)
      const state = await waitForExtensionCaptureState(
        worker,
        capture.body.id,
        value => Number.isInteger(value.targetTabId) && value.phase === 'target_loaded'
      )
      const stateKey = `agent-capture:${capture.body.id}`
      const mutation = await worker.send('Runtime.evaluate', {
        expression: `chrome.storage.session.get(${JSON.stringify(stateKey)}).then(stored => {
          const state = stored[${JSON.stringify(stateKey)}];
          if (!state) return JSON.stringify({ ok: false, reason: 'missing-state' });
          state.deadlineAt = Date.now() - 1000;
          state.updatedAt = Date.now() - 1000;
          return chrome.storage.session.set({ [${JSON.stringify(stateKey)}]: state })
            .then(() => chrome.tabs.create({ url: 'about:blank', active: false }))
            .then(tab => JSON.stringify({ ok: true, triggerTabId: tab.id, targetTabId: state.targetTabId, deadlineAt: state.deadlineAt }));
        })`,
        awaitPromise: true,
        returnByValue: true
      })
      const mutated = JSON.parse(mutation.result?.value || '{}')
      if (!mutated.ok) throw new Error(`Failed to force expired deadline: ${JSON.stringify(mutated)}`)
      const finalStatus = await pollCapture(ready, capture.body.id, 20)
      const targets = await listTargets()
      const targetStillVisible = targets.some(target => target.type === 'page' && String(target.url || '').startsWith(targetUrlPrefix))
      const triggerStillVisible = targets.some(target => target.type === 'page' && target.id === String(mutated.triggerTabId))
      return {
        finalStatus,
        targetTabId: state.targetTabId,
        triggerTabId: mutated.triggerTabId,
        targetStillVisible,
        triggerStillVisible
      }
    } finally {
      await closePageTarget(opened.target, opened.page)
    }
  }

  const driveCaptureWithFinalUrlBlocked = async (ready, capture, targetUrlPrefixes) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    try {
      const prefixes = Array.isArray(targetUrlPrefixes) ? targetUrlPrefixes : [targetUrlPrefixes]
      const finalStatus = await pollCapture(ready, capture.body.id, 20)
      const targets = await listTargets()
      const targetStillVisible = targets.some(
        target => target.type === 'page' && prefixes.some(prefix => String(target.url || '').startsWith(String(prefix || '')))
      )
      return { finalStatus, targetStillVisible }
    } finally {
      await closePageTarget(opened.target, opened.page)
    }
  }

  const driveCaptureWithTargetNavigationAway = async (ready, worker, capture, awayUrl, targetUrlPrefix) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    try {
      await waitForExtensionRuntime(worker)
      const state = await waitForExtensionCaptureState(
        worker,
        capture.body.id,
        value => Number.isInteger(value.targetTabId) && typeof value.finalUrl === 'string' && value.finalUrl.length > 0
      )
      const navigated = await updateTabUrl(worker, state.targetTabId, awayUrl)
      const finalStatus = await pollCapture(ready, capture.body.id, 20)
      const profile = await fetchJson(`${ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
        headers: { authorization: `Bearer ${ready.apiToken}` }
      })
      const targets = await listTargets()
      const targetStillVisible = targets.some(target => target.type === 'page' && String(target.url || '').startsWith(targetUrlPrefix))
      if (targetStillVisible) await removeTab(worker, state.targetTabId).catch(() => {})
      return {
        finalStatus,
        originalFinalUrl: state.finalUrl,
        profileStatus: profile.status,
        requestedAwayUrl: awayUrl,
        targetTabId: state.targetTabId,
        targetStillVisible,
        updateResultUrl: navigated.url || ''
      }
    } finally {
      await closePageTarget(opened.target, opened.page)
    }
  }

  const driveCaptureWithTargetTerminalFailure = async (ready, worker, capture, attempts = 20) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    try {
      await waitForExtensionRuntime(worker)
      const state = await waitForExtensionCaptureState(worker, capture.body.id, value => Number.isInteger(value.targetTabId))
      const finalStatus = await pollCapture(ready, capture.body.id, attempts)
      const profile = await fetchJson(`${ready.baseUrl}/v1/captures/${capture.body.id}/profile`, {
        headers: { authorization: `Bearer ${ready.apiToken}` }
      })
      const targetStillExists = await tabExists(worker, state.targetTabId)
      if (targetStillExists) await removeTab(worker, state.targetTabId).catch(() => {})
      return {
        finalStatus,
        profileStatus: profile.status,
        targetTabId: state.targetTabId,
        targetStillExists
      }
    } finally {
      await closePageTarget(opened.target, opened.page)
    }
  }

  const driveCaptureWithTargetLoadFailure = async (ready, worker, capture) =>
    driveCaptureWithTargetTerminalFailure(ready, worker, capture, 20)

  const driveCaptureWithTargetLoadTimeout = async (ready, worker, capture) =>
    driveCaptureWithTargetTerminalFailure(ready, worker, capture, 80)

  const driveCaptureWithExtensionReload = async (ready, capture, targetUrlPrefix) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    let worker
    try {
      const workerTarget = await waitForWorker()
      worker = await connectTarget(workerTarget)
      await worker.send('Runtime.enable')
      await waitForExtensionRuntime(worker)
      const state = await waitForExtensionCaptureState(worker, capture.body.id, value => Number.isInteger(value.targetTabId))
      let reloadError = null
      try {
        await worker.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()', awaitPromise: false })
      } catch (error) {
        reloadError = redactText(error?.message || error)
      }
      const finalStatus = await pollCapture(ready, capture.body.id, 80)
      const targets = await listTargets()
      const targetStillVisible = targets.some(target => target.type === 'page' && String(target.url || '').startsWith(targetUrlPrefix))
      return { finalStatus, reloadError, targetTabId: state.targetTabId, targetStillVisible }
    } finally {
      worker?.close()
      await closePageTarget(opened.target, opened.page)
    }
  }

  const driveCaptureWithClearedStorageSessionAndReload = async (ready, worker, capture, targetUrlPrefix) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    try {
      await waitForExtensionRuntime(worker)
      const state = await waitForExtensionCaptureState(worker, capture.body.id, value => Number.isInteger(value.targetTabId))
      await worker.send('Runtime.evaluate', {
        expression: 'chrome.storage.session.clear().then(() => chrome.runtime.reload())',
        awaitPromise: false
      })
      const finalStatus = await pollCapture(ready, capture.body.id, 80)
      const targets = await listTargets()
      const targetStillVisible = targets.some(target => target.type === 'page' && String(target.url || '').startsWith(targetUrlPrefix))
      return { finalStatus, targetTabId: state.targetTabId, targetStillVisible }
    } finally {
      await closePageTarget(opened.target, opened.page)
    }
  }

  const driveCaptureWithServiceWorkerTargetClose = async (ready, capture, targetUrlPrefix) => {
    const opened = await openBridgePage(capture.body.bridgeUrl)
    let worker
    try {
      const workerTarget = await waitForWorker()
      worker = await connectTarget(workerTarget)
      await worker.send('Runtime.enable')
      await waitForExtensionRuntime(worker)
      const state = await waitForExtensionCaptureState(worker, capture.body.id, value => Number.isInteger(value.targetTabId))
      await closeTarget(workerTarget.id)
      const finalStatus = await pollCapture(ready, capture.body.id, 80)
      const targets = await listTargets()
      const targetStillVisible = targets.some(target => target.type === 'page' && String(target.url || '').startsWith(targetUrlPrefix))
      return { finalStatus, targetTabId: state.targetTabId, workerTargetId: workerTarget.id, targetStillVisible }
    } finally {
      worker?.close()
      await closePageTarget(opened.target, opened.page)
    }
  }

  const startFixtureServer = async () => {
    const html = await readFile(resolve(root, 'tests/fixtures/site-experience-fixture.html'), 'utf8')
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const { port } = server.address()
    return { server, url: `http://127.0.0.1:${port}/fixture?token=secret#frag` }
  }

  const startProbeServer = async () => {
    let requestCount = 0
    const server = createServer((_req, res) => {
      requestCount += 1
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<!doctype html><title>StackPrism probe</title><main>probe</main>')
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const { port } = server.address()
    return { server, url: `http://127.0.0.1:${port}/probe?token=secret#frag`, requestCount: () => requestCount }
  }

  const startBridgeSelfRedirectServer = async bridgeBaseUrl => {
    let requestCount = 0
    const finalUrlPrefix = `${bridgeBaseUrl}/redirected-final-target`
    const server = createServer((_req, res) => {
      requestCount += 1
      res.writeHead(302, { location: `${finalUrlPrefix}?token=secret#frag`, 'cache-control': 'no-store' })
      res.end()
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const { port } = server.address()
    return {
      finalUrlPrefix,
      requestCount: () => requestCount,
      server,
      url: `http://127.0.0.1:${port}/redirect-to-bridge?token=secret#frag`
    }
  }

  const startPrivateFinalProxyServer = async () => {
    let proxyRequestCount = 0
    let privateRequestCount = 0
    const privateServer = createServer((_req, res) => {
      privateRequestCount += 1
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<!doctype html><title>Private final target</title><main>private final</main>')
    })
    await new Promise(resolveListen => privateServer.listen(0, '127.0.0.1', resolveListen))
    const privatePort = privateServer.address().port
    const finalUrlPrefix = `http://127.0.0.1:${privatePort}/private-final`

    const proxyServer = createServer((_req, res) => {
      proxyRequestCount += 1
      res.writeHead(302, { location: `${finalUrlPrefix}?token=secret#frag`, 'cache-control': 'no-store' })
      res.end()
    })
    await new Promise(resolveListen => proxyServer.listen(0, '127.0.0.1', resolveListen))
    const proxyPort = proxyServer.address().port
    return {
      finalUrlPrefix,
      privateRequestCount: () => privateRequestCount,
      privateServer,
      proxyRequestCount: () => proxyRequestCount,
      proxyServer,
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      url: 'http://93.184.216.34:18080/redirect-private-final?token=secret#frag'
    }
  }

  const startDnsFinalProxyServer = async ({ finalHostname }) => {
    let proxyRequestCount = 0
    let finalRequestCount = 0
    const finalUrlPrefix = `http://${finalHostname}/dns-final`
    const proxyServer = createServer((req, res) => {
      proxyRequestCount += 1
      if (String(req.url || '').includes('/dns-final')) {
        finalRequestCount += 1
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end('<!doctype html><title>DNS final target</title><main>dns final</main>')
        return
      }
      res.writeHead(302, { location: `${finalUrlPrefix}?token=secret#frag`, 'cache-control': 'no-store' })
      res.end()
    })
    await new Promise(resolveListen => proxyServer.listen(0, '127.0.0.1', resolveListen))
    const proxyPort = proxyServer.address().port
    return {
      finalRequestCount: () => finalRequestCount,
      finalUrlPrefix,
      hostname: finalHostname,
      proxyRequestCount: () => proxyRequestCount,
      proxyServer,
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      url: 'http://93.184.216.34:18081/redirect-dns-final?token=secret#frag'
    }
  }

  const startSlowFixtureServer = async (delayMs = 10000) => {
    const html = await readFile(resolve(root, 'tests/fixtures/site-experience-fixture.html'), 'utf8')
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
      }, delayMs)
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const { port } = server.address()
    return { server, url: `http://127.0.0.1:${port}/slow-fixture?token=secret#frag` }
  }

  const startLoadFailureServer = async (delayMs = 1000) => {
    let requestCount = 0
    const server = createServer((req, _res) => {
      requestCount += 1
      setTimeout(() => {
        req.socket.destroy()
      }, delayMs)
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const { port } = server.address()
    return {
      requestCount: () => requestCount,
      server,
      url: `http://127.0.0.1:${port}/target-load-failed?token=secret#frag`
    }
  }

  const startLargeProfileFixtureServer = async () => {
    const longPath = 'asset-'.repeat(1800)
    const images = Array.from(
      { length: 36 },
      (_item, index) =>
        `<img loading="lazy" style="display:none" alt="large asset ${index}" src="/large-assets/${index}-${longPath}.png?token=secret#frag" />`
    ).join('\n')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Large StackPrism Fixture</title></head><body><main><h1>Large profile fixture</h1>${images}</main></body></html>`
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/large-assets/')) {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const { port } = server.address()
    return { server, url: `http://127.0.0.1:${port}/large-fixture?token=secret#frag` }
  }

  const cleanupChrome = async chrome => {
    await stopProcess(chrome?.child)
    await rm(chrome.profileDir, { recursive: true, force: true })
  }

  const stopChrome = async chrome => {
    await stopProcess(chrome?.child)
  }

  return {
    cleanupChrome,
    closeTarget,
    connectTarget,
    createCapture,
    createDnsNonGlobalBlockedCapture,
    createExtensionTab,
    createPrivateTargetBlockedCapture,
    disableExtensionFromExtensionsPage,
    disposeBrowserContext,
    driveCapture,
    driveCaptureWithCancel,
    driveCaptureWithClosedBridge,
    driveCaptureWithClearedStorageSessionAndReload,
    driveCaptureWithExtensionReload,
    driveCaptureWithExpiredDeadlineReconciliation,
    driveCaptureWithFinalUrlBlocked,
    driveCaptureWithLocalOptInDisabled,
    driveCaptureWithTargetLoadFailure,
    driveCaptureWithTargetLoadTimeout,
    driveCaptureWithTargetNavigationAway,
    driveCaptureWithServiceWorkerTargetClose,
    driveCaptureWithClosedTarget,
    enableIncognitoFromExtensionsPage,
    fetchJson,
    getExtensionCaptureState,
    listExtensionTabs,
    listTargets,
    openBridgePage,
    openIncognitoBridgePage,
    pollCapture,
    probeBridgeIframeBlocking,
    rawHttp,
    reloadExtensionFromExtensionsPage,
    removeTab,
    setAgentBridgeEnabled,
    startBridge,
    startChrome,
    startDnsFinalProxyServer,
    startFixtureServer,
    startBridgeSelfRedirectServer,
    startPrivateFinalProxyServer,
    startChromeWithoutExtension,
    startLargeProfileFixtureServer,
    startLoadFailureServer,
    startProbeServer,
    startSlowFixtureServer,
    stopChrome,
    waitForCdp,
    waitForExtensionCaptureState,
    waitForExtensionRuntime,
    waitForNoWorker,
    waitForNoPageTarget,
    stopBridge,
    waitForWorker
  }
}
