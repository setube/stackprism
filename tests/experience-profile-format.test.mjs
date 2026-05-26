import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadTsModule } from './helpers/load-ts-module.mjs'

test('built experience profiler exposes executeScript result reference', async () => {
  const built = await readFile(new URL('../public/injected/experience-profiler.iife.js', import.meta.url), 'utf8')
  assert.match(built, /__StackPrismInjected_experience_profiler__;\s*$/)
})

test('experience profiler default export is structured-clone safe', async () => {
  const { default: result } = await loadTsModule('src/injected/experience-profiler.ts')
  const clone = structuredClone(result)

  assert.equal(typeof clone, 'object')
  assert.ok(clone.visual)
  assert.ok(clone.layout)
  assert.ok(clone.components)
  assert.ok(clone.interaction)
  assert.ok(clone.ux)
  assert.ok(clone.assets)
  assert.ok(clone.evidence.truncation)
  assert.ok(JSON.stringify(clone).length < 2 * 1024 * 1024)
})

test('experience profiler preserves matched selector metadata for bounding boxes', async () => {
  const source = await readFile(new URL('../src/injected/experience-profiler.ts', import.meta.url), 'utf8')

  assert.match(source, /map\(element => \(\{ selector, element \}\)\)/)
  assert.doesNotMatch(source, /selector:\s*element\.tagName/)
})

test('site experience fixture covers visual, layout, component and sensitive text cases', async () => {
  const fixture = await readFile(new URL('./fixtures/site-experience-fixture.html', import.meta.url), 'utf8')

  assert.match(fixture, /transition:/)
  assert.match(fixture, /<header/)
  assert.match(fixture, /<button/)
  assert.match(fixture, /user@example\.com/)
  assert.match(fixture, /token=secret/)
})
