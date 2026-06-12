import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadTsModule } from './helpers/load-ts-module.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('built experience profiler exposes executeScript result reference', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'stackprism-injected-'))
  try {
    const result = spawnSync(process.execPath, ['build-scripts/build-injected.mjs'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, INJECTED_ENTRIES: 'experience-profiler', INJECTED_OUT_DIR: outDir }
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const built = await readFile(path.join(outDir, 'experience-profiler.iife.js'), 'utf8')
    assert.match(built, /__StackPrismInjected_experience_profiler__;\s*$/)
    await assert.rejects(readFile(path.join(outDir, 'page-detector.iife.js')))
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
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
  const source = await readFile(new URL('../src/injected/experience-profiler-visual-layout.ts', import.meta.url), 'utf8')

  assert.match(source, /map\(element => \(\{ selector, element \}\)\)/)
  assert.doesNotMatch(source, /selector:\s*element\.tagName/)
})

test('experience profiler collects language and first-order UX categories', async () => {
  const [entrySource, uxSource] = await Promise.all([
    readFile(new URL('../src/injected/experience-profiler.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/injected/experience-profiler-ux-assets.ts', import.meta.url), 'utf8')
  ])

  assert.match(entrySource, /documentElement\.lang/)
  assert.match(uxSource, /pagePurpose/)
  assert.match(uxSource, /primaryUserPath/)
  assert.match(uxSource, /informationHierarchy/)
  assert.match(uxSource, /ctaStrategy/)
  assert.match(uxSource, /trustSignals/)
  assert.match(uxSource, /navigationDepth/)
  assert.match(uxSource, /contentGrouping/)
  assert.match(uxSource, /frictionPoints/)
})

test('experience profiler redacts sensitive URL paths and preserves full component counts', async () => {
  const [commonSource, componentsSource, entrySource] = await Promise.all([
    readFile(new URL('../src/injected/experience-profiler-common.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/injected/experience-profiler-components.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/injected/experience-profiler.ts', import.meta.url), 'utf8')
  ])

  assert.match(commonSource, /isSensitivePathSegment/)
  assert.match(commonSource, /url\.pathname = redactPathname\(url\.pathname\)/)
  assert.match(componentsSource, /counts\[type\] = matches\.length/)
  assert.match(componentsSource, /matches\.slice\(0, 20\)/)
  assert.match(entrySource, /for \(const shrink of shrinkSteps\)/)
  assert.match(entrySource, /byteLengthOf\(profile\)/)
  assert.match(entrySource, /initialBytes - bytes/)
})

test('experience profiler keeps executeScriptResult as omitted bytes when final result remains oversized', async () => {
  const [commonSource, entrySource] = await Promise.all([
    readFile(new URL('../src/injected/experience-profiler-common.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/injected/experience-profiler.ts', import.meta.url), 'utf8')
  ])

  assert.match(commonSource, /executeScriptResultOverLimit:\s*number/)
  assert.match(commonSource, /executeScriptResultOverLimit:\s*0/)
  assert.match(entrySource, /const finalBytes = byteLengthOf\(profile\)/)
  assert.match(entrySource, /profile\.evidence\.truncation\.executeScriptResult = Math\.max\(0, initialBytes - finalBytes\)/)
  assert.match(
    entrySource,
    /profile\.evidence\.truncation\.executeScriptResultOverLimit = Math\.max\(0, finalBytes - LIMITS\.executeScriptResultBytes\)/
  )
  assert.doesNotMatch(
    entrySource,
    /profile\.evidence\.truncation\.executeScriptResult = Math\.max\(0, byteLengthOf\(profile\) - LIMITS\.executeScriptResultBytes\)/
  )
})

test('experience profiler safeUrl preserves ordinary key substrings and redacts sensitive path tokens', async () => {
  const { safeUrl } = await loadTsModule('src/injected/experience-profiler-common.ts')
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'https://example.com/base/' }
  })

  try {
    assert.equal(
      safeUrl('https://example.com/products/keyboard/turkey/monkey?token=secret#frag'),
      'https://example.com/products/keyboard/turkey/monkey?token=%5Bredacted%5D'
    )
    assert.equal(
      safeUrl('https://example.com/account/apiKey/privateKey/passcode/sessionId?next=/home'),
      'https://example.com/account/[redacted]/[redacted]/[redacted]/[redacted]?next=%5Bredacted%5D'
    )
    assert.equal(
      safeUrl('https://vercel.com/dashboard/projects/very-long-project-name-with-token-like-segment-and-many-words'),
      'https://vercel.com/dashboard/projects/very-long-project-name-with-token-like-segment-and-many-words'
    )
    assert.equal(
      safeUrl('https://example.com/download/Abcd1234EFGH5678ijkl9012?next=/home'),
      'https://example.com/download/[redacted]?next=%5Bredacted%5D'
    )
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation)
    else delete globalThis.location
  }
})

test('experience profiler cleanText redacts spaced bearer credentials', async () => {
  const { cleanText } = await loadTsModule('src/injected/experience-profiler-common.ts')

  const cleaned = cleanText('Authorization: Bearer sk_live_abc123; token=secret')

  assert.equal(cleaned, 'Authorization=[redacted]; token=[redacted]')
  assert.doesNotMatch(cleaned, /Bearer|sk_live_abc123|secret/)
})

test('site experience fixture covers visual, layout, component and sensitive text cases', async () => {
  const fixture = await readFile(new URL('./fixtures/site-experience-fixture.html', import.meta.url), 'utf8')

  assert.match(fixture, /transition:/)
  assert.match(fixture, /<header/)
  assert.match(fixture, /<button/)
  assert.match(fixture, /user@example\.com/)
  assert.match(fixture, /token=secret/)
})
