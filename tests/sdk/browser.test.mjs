import assert from 'node:assert/strict'
import { after, before, test, mock } from 'node:test'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { detectPage, scanUrl, StackPrismError } from '../../packages/stackprism/dist/index.js'

const exec = promisify(execFile)
const executablePath = process.env.STACKPRISM_TEST_BROWSER
const launchOptions = executablePath ? { executablePath } : { channel: 'chrome' }
const cli = fileURLToPath(new URL('../../packages/stackprism/dist/cli.js', import.meta.url))
let origin
let server
let peerServer
let peerOrigin
let browser
let requests = 0
const ownedBrowsers = []

before(
  async () => {
    peerServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript', server: 'nginx/1.26.2' })
      response.end('// A CDN dependency, not the main document server')
    })
    await new Promise(resolve => peerServer.listen(0, '127.0.0.1', resolve))
    peerOrigin = `http://127.0.0.1:${peerServer.address().port}`
    server = createServer((request, response) => {
      requests++
      const route = new URL(request.url, 'http://localhost').pathname
      if (route === '/network') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(
          `<script src="${peerOrigin}/third.js?token=network-secret"></script><iframe src="/frame"></iframe><script>addEventListener('load', () => setTimeout(() => fetch('/api?token=network-secret'), 40))</script>`
        )
        return
      }
      if (route === '/frame') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<script src="/iframe-only.js"></script>')
        return
      }
      if (route === '/iframe-only.js') {
        response.writeHead(200, { 'content-type': 'text/javascript', server: 'Apache/2.4.0' })
        response.end('// Frame-local response')
        return
      }
      if (route === '/api') {
        response.writeHead(200, { 'content-type': 'application/json', 'x-powered-by': 'PHP/8.3.4' })
        response.end('{}')
        return
      }
      if (route === '/burst') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(Array.from({ length: 70 }, (_, index) => `<script src="/empty.js?asset=${index}"></script>`).join(''))
        return
      }
      if (route === '/empty.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' })
        response.end('// empty resource')
        return
      }
      if (route === '/slow') return
      if (route === '/disconnect') {
        request.socket.destroy()
        return
      }
      if (route === '/redirect') {
        response.writeHead(302, { location: '/positive' })
        response.end()
        return
      }
      if (route === '/asset.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' })
        response.end('window.jQuery = { fn: { jquery: "3.7.1" } };')
        return
      }
      if (route === '/jquery-3.7.1.min.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' })
        response.end('// Resource signature without a runtime global')
        return
      }
      if (route === '/resource') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<script src="/jquery-3.7.1.min.js"></script>')
        return
      }
      response.writeHead(route === '/missing' ? 404 : 200, {
        'content-type': 'text/html',
        ...(route === '/positive'
          ? { server: 'nginx/1.26.2', 'x-powered-by': 'PHP/8.3.4', 'set-cookie': 'PHPSESSID=do-not-leak-this-secret; HttpOnly' }
          : {})
      })
      response.end(
        route === '/positive'
          ? '<!doctype html><title>Fixture</title><meta name="generator" content="WordPress 6.8"><script>window.React = {version:"19.1.0"}</script><script src="/asset.js"></script><body>Hello</body>'
          : '<!doctype html><title>Plain fixture</title><body>A tutorial mentioning React, Vue and WordPress. Not an application built with them.</body>'
      )
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
    browser = await chromium.launch({ headless: true, ...launchOptions })
    const launch = chromium.launch.bind(chromium)
    mock.method(chromium, 'launch', async options => {
      const instance = await launch(options)
      ownedBrowsers.push(instance)
      return instance
    })
  },
  { timeout: 30_000 }
)

after(async () => {
  mock.restoreAll()
  await Promise.all([browser, ...ownedBrowsers].filter(Boolean).map(instance => instance.close()))
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  peerServer.closeAllConnections()
  await new Promise(resolve => peerServer.close(resolve))
})

const names = report => report.technologies.map(technology => technology.name)
const scan = (path, options = {}) => scanUrl(`${origin}${path}`, { executablePath, ...options })

test('scanUrl uses the actual page and header matchers, versions and bundled rules', async () => {
  const report = await scan('/positive')
  for (const name of ['React', 'jQuery', 'WordPress', 'Nginx', 'PHP'])
    assert.ok(names(report).includes(name), `${name}: ${JSON.stringify(report)}`)
  assert.equal(report.technologies.find(technology => technology.name === 'jQuery').version, '3.7.1')
  assert.equal(report.coverage.responseHeaders, 'main_document')
  assert.equal(report.coverage.httpStatus, 200)
  assert.match(report.rules.sha256, /^[a-f0-9]{64}$/)
  assert.equal(report.schemaVersion, 1)
  assert.ok(report.technologies.every(technology => ['high', 'medium', 'low'].includes(technology.confidence)))
  assert.ok(!JSON.stringify(report).includes('do-not-leak-this-secret'))
  assert.equal(ownedBrowsers.at(-1).isConnected(), false)
})

test('detectPage preserves caller ownership, concurrent page isolation and performs no fetch', async () => {
  const positive = await browser.newPage()
  const negative = await browser.newPage()
  try {
    await Promise.all([positive.goto(`${origin}/positive`), negative.goto(`${origin}/plain`)])
    // Drain the browser's independent favicon request before measuring detector traffic.
    await Promise.all([positive.waitForLoadState('networkidle'), negative.waitForLoadState('networkidle')])
    const beforeRequests = requests
    const [report, plain] = await Promise.all([detectPage(positive), detectPage(negative)])
    assert.equal(requests, beforeRequests)
    assert.ok(names(report).includes('React'))
    assert.ok(!names(report).includes('Nginx'))
    for (const name of ['React', 'Vue', 'WordPress', 'jQuery']) assert.ok(!names(plain).includes(name), `${name} false positive`)
    assert.equal(report.coverage.responseHeaders, 'not_observed')
    assert.equal(report.coverage.subresourceHeaders, 'not_observed')
    assert.deepEqual(report.network.responses, [])
    assert.equal(report.coverage.httpStatus, null)
    assert.equal(positive.isClosed(), false)
    assert.equal(browser.isConnected(), true)
    assert.equal(await positive.title(), 'Fixture')
  } finally {
    await Promise.all([positive.close(), negative.close()])
  }
})

test('redirects retain the final document URL and HTTP errors remain observable', async () => {
  const redirected = await scan('/redirect')
  assert.equal(redirected.url, `${origin}/positive`)
  assert.ok(names(redirected).includes('Nginx'))
  const missing = await scan('/missing')
  assert.equal(missing.coverage.httpStatus, 404)
  assert.ok(ownedBrowsers.every(instance => !instance.isConnected()))
})

test('navigation failure and timeout close owned browsers', async () => {
  await assert.rejects(scan('/disconnect'), { code: 'NAVIGATION_FAILED' })
  const started = performance.now()
  await assert.rejects(scan('/slow', { timeoutMs: 1_500 }), { code: 'TIMEOUT' })
  assert.ok(performance.now() - started < 10_000)
  assert.ok(ownedBrowsers.every(instance => !instance.isConnected()))
})

test('subresource headers retain endpoint attribution, capture delayed fetch and exclude iframe internals', async () => {
  const report = await scan('/network', { observationMs: 200 })
  assert.equal(report.coverage.subresourceHeaders, 'sampled')
  assert.equal(report.network.observationMs, 200)
  const dependency = report.network.responses.find(response => response.technologies.some(technology => technology.name === 'Nginx'))
  assert.equal(dependency.relation, 'cross_origin')
  assert.equal(dependency.resourceType, 'script')
  assert.equal(dependency.url, `${peerOrigin}/third.js`)
  const api = report.network.responses.find(response => response.technologies.some(technology => technology.name === 'PHP'))
  assert.equal(api.relation, 'same_origin')
  assert.equal(api.resourceType, 'fetch')
  assert.equal(api.url, `${origin}/api`)
  assert.ok(!report.network.responses.some(response => response.url.includes('iframe-only')))
  assert.ok(!names(report).some(name => ['PHP', 'Nginx', 'Apache'].includes(name)))
  assert.ok(!JSON.stringify(report.network).includes('network-secret'))
  assert.equal(report.network.observedResponses, report.network.responses.length)
  assert.equal(report.network.failedResponses, 0)
})

test('subresource collection is bounded and reports dropped responses instead of silently claiming completeness', async () => {
  const report = await scan('/burst', { observationMs: 0 })
  assert.equal(report.network.responseLimit, 64)
  assert.equal(report.network.responses.length, 64)
  assert.ok(report.network.skippedResponses >= 6)
  assert.equal(
    report.network.observedResponses,
    report.network.responses.length + report.network.skippedResponses + report.network.failedResponses
  )
})

test('observation window participates in cancellation and the total deadline', async () => {
  await assert.rejects(scan('/plain', { observationMs: 5000, timeoutMs: 2500 }), { code: 'TIMEOUT' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1800)
  const startedAt = performance.now()
  try {
    await assert.rejects(scan('/plain', { observationMs: 5000, signal: controller.signal }), { code: 'ABORTED' })
  } finally {
    clearTimeout(timer)
  }
  assert.ok(performance.now() - startedAt < 5000)
  assert.ok(ownedBrowsers.every(instance => !instance.isConnected()))
})

test('resource signatures retain versions without runtime globals', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}/resource`)
    assert.equal(await page.evaluate(() => typeof window.jQuery), 'undefined')
    const technology = (await detectPage(page)).technologies.find(technology => technology.name === 'jQuery')
    assert.equal(technology.version, '3.7.1')
    assert.ok(technology.evidence.some(evidence => evidence.includes('jquery-3.7.1.min.js')))
  } finally {
    await page.close()
  }
})

test('cancellation during navigation reaps the owned browser', async () => {
  const controller = new AbortController()
  const pending = scan('/slow', { signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 1_000)
  try {
    await assert.rejects(pending, { code: 'ABORTED' })
  } finally {
    clearTimeout(timer)
  }
  assert.ok(ownedBrowsers.every(instance => !instance.isConnected()))
})

test('rejects invalid inputs before launch and exposes structured launch failures', async () => {
  const count = ownedBrowsers.length
  for (const url of ['file:///tmp/a', 'ftp://example.com', 'http://user:secret@example.com', 'not-a-url']) {
    await assert.rejects(scanUrl(url), error => error instanceof StackPrismError && error.code === 'INVALID_ARGUMENT')
  }
  for (const timeoutMs of [0, -1, NaN, 1.5, 120001]) await assert.rejects(scan('/plain', { timeoutMs }), { code: 'INVALID_ARGUMENT' })
  for (const observationMs of [-1, NaN, 1.5, 5001]) await assert.rejects(scan('/plain', { observationMs }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(scan('/plain', { signal: AbortSignal.abort() }), { code: 'ABORTED' })
  assert.equal(ownedBrowsers.length, count)
  await assert.rejects(scan('/plain', { executablePath: '/nonexistent/stackprism-browser' }), { code: 'BROWSER_LAUNCH_FAILED' })
  const closed = await browser.newPage()
  await closed.close()
  await assert.rejects(detectPage(closed), { code: 'PAGE_CLOSED' })
})

test('caller-owned pages remain usable after timeout or cancellation', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}/plain`)
    await page.evaluate(() => {
      scheduler.yield = () => new Promise(resolve => setTimeout(resolve, 200))
    })
    await assert.rejects(detectPage(page, { timeoutMs: 30 }), { code: 'TIMEOUT' })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30)
    try {
      await assert.rejects(detectPage(page, { signal: controller.signal }), { code: 'ABORTED' })
    } finally {
      clearTimeout(timer)
    }
    assert.equal(page.isClosed(), false)
    assert.equal(await page.title(), 'Plain fixture')
    await page.reload()
    assert.equal((await detectPage(page)).coverage.page, 'sampled_main_frame')
  } finally {
    await page.close()
  }
})

test('same-URL reload during a scan rejects mixed-document results', { timeout: 15_000 }, async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}/plain`)
    let entered
    const reachedYield = new Promise(resolve => {
      entered = resolve
    })
    await page.exposeFunction('__stackprismTestYield', () => entered())
    await page.evaluate(() => {
      scheduler.yield = () => {
        window.__stackprismTestYield()
        return new Promise(resolve => setTimeout(resolve, 500))
      }
    })
    const pending = detectPage(page).then(
      () => null,
      error => error
    )
    await reachedYield
    await page.reload()
    assert.equal((await pending)?.code, 'PAGE_CHANGED')
    assert.equal(page.listenerCount('framenavigated'), 0)
  } finally {
    await page.close()
  }
})

test('CLI has clean JSON streams, stable exit codes, help and version', { timeout: 30_000 }, async () => {
  const { stdout: help } = await exec(process.execPath, [cli, '--help'])
  assert.match(help, /Usage: stackprism/)
  const { stdout: version } = await exec(process.execPath, [cli, '--version'])
  assert.equal(version.trim(), '0.2.0')
  for (const args of [
    [],
    ['file:///tmp/test'],
    [origin, '--unknown'],
    [origin, '--timeout', 'NaN'],
    [origin, '--observe', '-1'],
    [origin, '--observe', '5001']
  ]) {
    await assert.rejects(exec(process.execPath, [cli, ...args]), error => {
      assert.equal(error.code, 2)
      assert.equal(error.stdout, '')
      assert.equal(JSON.parse(error.stderr).error.code, 'INVALID_ARGUMENT')
      return true
    })
  }
  const args = [cli, `${origin}/positive`, ...(executablePath ? ['--executable-path', executablePath] : [])]
  const { stdout, stderr } = await exec(process.execPath, args)
  assert.equal(stderr, '')
  assert.ok(names(JSON.parse(stdout)).includes('WordPress'))
  await assert.rejects(
    exec(process.execPath, [cli, `${origin}/slow`, '--timeout', '1000', ...(executablePath ? ['--executable-path', executablePath] : [])]),
    error => {
      assert.equal(error.code, 3)
      assert.equal(error.stdout, '')
      assert.equal(JSON.parse(error.stderr).error.code, 'TIMEOUT')
      return true
    }
  )
})
