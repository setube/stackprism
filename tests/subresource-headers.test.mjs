import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { build } from 'esbuild'
import path from 'node:path'
import { repoRoot } from './helpers/rule-harness.mjs'

const compiled = await build({
  entryPoints: [path.join(repoRoot, 'src/sdk/subresource-headers.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node'
})
const { SubresourceHeaders } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

const createPage = () => {
  const page = new EventEmitter()
  const frame = {}
  page.mainFrame = () => frame
  return page
}
const createRequest = (page, url) => ({
  isNavigationRequest: () => false,
  serviceWorker: () => null,
  frame: () => page.mainFrame(),
  url: () => url,
  resourceType: () => 'fetch',
  method: () => 'GET'
})
const createResponse = (request, headersArray = async () => []) => ({
  request: () => request,
  url: () => request.url(),
  status: () => 200,
  headersArray
})

test('late responses and pending header reads cannot cross a document navigation', async () => {
  const page = createPage()
  const capture = new SubresourceHeaders(page, {})
  const late = createRequest(page, 'https://example.com/old-late')
  const pending = createRequest(page, 'https://example.com/old-pending')
  page.emit('request', late)
  page.emit('request', pending)
  let resolveHeaders
  page.emit(
    'response',
    createResponse(
      pending,
      () =>
        new Promise(resolve => {
          resolveHeaders = resolve
        })
    )
  )
  page.emit('framenavigated', page.mainFrame())
  page.emit(
    'response',
    createResponse(late, () => {
      throw new Error('Stale response must not be read')
    })
  )
  resolveHeaders([])
  const current = createRequest(page, 'https://example.com/current?token=secret')
  page.emit('request', current)
  page.emit('response', createResponse(current))
  const report = await capture.finish()
  assert.equal(report.observedResponses, 1)
  assert.deepEqual(
    report.responses.map(response => response.url),
    ['https://example.com/current']
  )
  assert.equal(report.failedResponses, 0)
  assert.equal(page.listenerCount('request') + page.listenerCount('response') + page.listenerCount('framenavigated'), 0)
  capture.dispose()
})

test('failed header reads are counted, and disposal detaches listeners without unhandled rejections', async () => {
  const page = createPage()
  const capture = new SubresourceHeaders(page, {})
  const request = createRequest(page, 'https://example.com/error')
  page.emit('request', request)
  page.emit(
    'response',
    createResponse(request, async () => {
      throw new Error('Header unavailable')
    })
  )
  const report = await capture.finish()
  assert.equal(report.observedResponses, 1)
  assert.equal(report.failedResponses, 1)
  assert.equal(report.skippedResponses, 0)
  assert.deepEqual(report.responses, [])
  capture.dispose()
  assert.equal(page.eventNames().length, 0)
})

test('navigation does not bypass the global bound on outstanding header reads', async () => {
  const page = createPage()
  const capture = new SubresourceHeaders(page, {})
  const release = []
  for (let index = 0; index < 64; index++) {
    const request = createRequest(page, `https://example.com/old/${index}`)
    page.emit('request', request)
    page.emit(
      'response',
      createResponse(request, () => new Promise(resolve => release.push(resolve)))
    )
  }
  page.emit('framenavigated', page.mainFrame())
  const current = createRequest(page, 'https://example.com/current')
  page.emit('request', current)
  page.emit(
    'response',
    createResponse(current, () => {
      throw new Error('Read limit must hold across documents')
    })
  )
  const report = await capture.finish()
  assert.equal(report.observedResponses, 1)
  assert.equal(report.skippedResponses, 1)
  assert.equal(report.responses.length, 0)
  capture.dispose()
  for (const resolve of release) resolve([])
})
