import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const manifestSource = await readFile(new URL('../src/manifest.config.ts', import.meta.url), 'utf8')

const EXTENSION_PERMISSIONS = ['activeTab', 'scripting', 'tabs', 'storage', 'webRequest', 'webNavigation']
const HOST_PERMISSIONS = ['<all_urls>']
const OBSERVER_MATCHES = ['http://*/*', 'https://*/*']
const OBSERVER_SCRIPT = ['src/content/content-observer.ts']
const BRIDGE_MATCHES = ['http://127.0.0.1/*']
const BRIDGE_SCRIPT = ['src/content/agent-bridge-client.ts']
const WEB_ACCESSIBLE_RESOURCES = ['rules/*', 'tech-links.json', 'injected/page-detector.iife.js', 'injected/page-source-search.iife.js']

const findMatchingPair = (source, openIndex, openChar, closeChar) => {
  let depth = 0
  let quote = ''
  let escaped = false

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = ''
      }
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === openChar) {
      depth += 1
    } else if (char === closeChar) {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  assert.fail(`expected matching ${closeChar}`)
}

const extractPropertyBlock = (source, name, openChar, closeChar) => {
  const propertyIndex = source.indexOf(`${name}:`)
  assert.ok(propertyIndex >= 0, `expected ${name} property in manifest config`)

  const openIndex = source.indexOf(openChar, propertyIndex)
  assert.ok(openIndex >= 0, `expected ${name} ${openChar} block in manifest config`)

  const closeIndex = findMatchingPair(source, openIndex, openChar, closeChar)
  return source.slice(openIndex, closeIndex + 1)
}

const extractStringArray = (source, name) => {
  const arrayBlock = extractPropertyBlock(source, name, '[', ']')
  return [...arrayBlock.matchAll(/'([^']+)'/g)].map(item => item[1])
}

const extractStringProperty = (source, name) => {
  const match = source.match(new RegExp(`${name}:\\s*'([^']+)'`))
  assert.ok(match, `expected ${name} string in manifest config`)
  return match[1]
}

const extractObjectContaining = needle => {
  const needleIndex = manifestSource.indexOf(needle)
  assert.ok(needleIndex >= 0, `expected manifest config to contain ${needle}`)

  const openIndex = manifestSource.lastIndexOf('{', needleIndex)
  assert.ok(openIndex >= 0, `expected object containing ${needle}`)

  const closeIndex = findMatchingPair(manifestSource, openIndex, '{', '}')
  return {
    block: manifestSource.slice(openIndex, closeIndex + 1),
    index: openIndex
  }
}

const extractObjectBlocks = arrayBlock => {
  const blocks = []

  for (let index = 0; index < arrayBlock.length; index += 1) {
    if (arrayBlock[index] !== '{') {
      continue
    }

    const closeIndex = findMatchingPair(arrayBlock, index, '{', '}')
    blocks.push(arrayBlock.slice(index, closeIndex + 1))
    index = closeIndex
  }

  return blocks
}

test('manifest pins extension permissions and content script boundaries', () => {
  const observer = extractObjectContaining("js: ['src/content/content-observer.ts']")
  const bridge = extractObjectContaining("js: ['src/content/agent-bridge-client.ts']")
  const permissions = extractStringArray(manifestSource, 'permissions')
  const hostPermissions = extractStringArray(manifestSource, 'host_permissions')

  assert.deepEqual(permissions, EXTENSION_PERMISSIONS)
  assert.deepEqual(hostPermissions, HOST_PERMISSIONS)
  assert.ok(bridge.index > observer.index)

  assert.deepEqual(extractStringArray(observer.block, 'matches'), OBSERVER_MATCHES)
  assert.deepEqual(extractStringArray(observer.block, 'js'), OBSERVER_SCRIPT)
  assert.equal(extractStringProperty(observer.block, 'run_at'), 'document_idle')

  assert.deepEqual(extractStringArray(bridge.block, 'matches'), BRIDGE_MATCHES)
  assert.deepEqual(extractStringArray(bridge.block, 'js'), BRIDGE_SCRIPT)
  assert.equal(extractStringProperty(bridge.block, 'run_at'), 'document_idle')
  assert.equal(extractStringArray(bridge.block, 'matches').includes('http://localhost/*'), false)

  assert.doesNotMatch(manifestSource, /externally_connectable/)
})

test('manifest keeps web accessible resources free of agent-only files', () => {
  const webAccessibleArray = extractPropertyBlock(manifestSource, 'web_accessible_resources', '[', ']')
  const webAccessibleBlocks = extractObjectBlocks(webAccessibleArray)

  assert.equal(webAccessibleBlocks.length, 1)
  assert.deepEqual(extractStringArray(webAccessibleBlocks[0], 'resources'), WEB_ACCESSIBLE_RESOURCES)
  assert.deepEqual(extractStringArray(webAccessibleBlocks[0], 'matches'), OBSERVER_MATCHES)

  const resources = extractStringArray(webAccessibleBlocks[0], 'resources').join('\n')
  assert.doesNotMatch(manifestSource, /injected\/experience-profiler\.iife\.js/)
  assert.doesNotMatch(resources, /agent-bridge-client/)
  assert.doesNotMatch(resources, /experience-profiler/)
  assert.doesNotMatch(resources, /agent-skill/)
  assert.doesNotMatch(resources, /stackprism-bridge/)
  assert.doesNotMatch(resources, /stackprism_bridge/)
  assert.doesNotMatch(resources, /\.py$/)
  assert.doesNotMatch(resources, /tests?\//)
})
