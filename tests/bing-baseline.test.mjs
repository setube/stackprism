import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { evaluateBaseline, formatBaselineMarkdown } from '../build-scripts/check-bing-baseline.mjs'
import { loadHeadersModule, loadHeaderRules, detectHeaders } from './helpers/rule-harness.mjs'

const baseline = JSON.parse(await readFile(new URL('../baselines/bing.json', import.meta.url), 'utf8'))
const fixture = JSON.parse(await readFile(new URL('./fixtures/bing-headers.json', import.meta.url), 'utf8'))
const report = {
  url: 'https://cn.bing.com/',
  engine: { version: 'test' },
  rules: { version: 'test', sha256: 'fixture' },
  technologies: baseline.requiredTechnologies.map(name => ({ name })),
  coverage: { httpStatus: 200, responseHeaders: 'main_document', subresourceHeaders: 'sampled' },
  network: {
    observationMs: 1000,
    responseLimit: 64,
    observedResponses: 1,
    skippedResponses: 0,
    failedResponses: 0,
    responses: [{ technologies: [] }]
  }
}

test('baseline permits variable optional signals but detects missing required facts and wrong hosts', () => {
  assert.equal(evaluateBaseline(baseline, report).status, 'pass')
  assert.equal(evaluateBaseline(baseline, { ...report, technologies: [{ name: 'HTTPS' }] }).status, 'drift')
  assert.equal(evaluateBaseline(baseline, { ...report, url: 'https://bing.com.attacker.example/' }).status, 'drift')
  assert.equal(evaluateBaseline(baseline, { ...report, coverage: { ...report.coverage, httpStatus: 302 } }).status, 'unobservable')
  assert.equal(evaluateBaseline(baseline, { ...report, coverage: { ...report.coverage, httpStatus: 429 } }).status, 'unobservable')
  assert.equal(
    evaluateBaseline(baseline, { ...report, network: { ...report.network, failedResponses: 1, observedResponses: 2 } }).status,
    'unobservable'
  )
  const markdown = formatBaselineMarkdown({
    report,
    ...evaluateBaseline(baseline, report),
    capturedAt: 'fixture',
    environment: {},
    target: baseline.url,
    observationMs: 1000
  })
  assert.match(markdown, /## 中文/)
  assert.match(markdown, /## English/)
  assert.match(markdown, /PASS/)
})

test('sanitized Bing response fixtures reproduce edge and endpoint signals without invented frameworks', async () => {
  const headers = await loadHeadersModule()
  const rules = loadHeaderRules()
  for (const response of fixture.responses) {
    const detected = detectHeaders(headers, rules, response.headers, response.url)
    assert.deepEqual(detected.map(technology => technology.name).sort(), [...response.expected].sort())
    if (response.expected.includes('ASP.NET')) assert.equal(detected.find(technology => technology.name === 'ASP.NET').confidence, '中')
  }
})
