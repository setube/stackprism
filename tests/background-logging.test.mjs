import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTsModule } from './helpers/load-ts-module.mjs'

const pollutedErrorName =
  'BridgeCleanup http://127.0.0.1:17370/bridge?token=secret&nonce=n_SECRETSECRETSECRETSECRET spb_ABCDEFGHIJKLMNOPQRSTUVWxy123456789012345'

test('background error log details redact bridge URLs, tokens, ids, and Error contents', async () => {
  const { redactLogUrl, sanitizeLogDetails } = await loadTsModule('src/background/logging.ts')

  assert.equal(
    redactLogUrl('http://127.0.0.1:17370/bridge?session=s_SECRETSECRETSECRETSECRET&nonce=n_SECRETSECRETSECRETSECRET#frag'),
    'http://127.0.0.1:17370/bridge?[redacted]'
  )

  const error = new Error('leaked http://127.0.0.1:17370/bridge?token=spb_ABCDEFGHIJKLMNOPQRSTUVWxy123456789012345')
  const sanitized = sanitizeLogDetails({
    error,
    message: 'failed cap_ABCDEFGHIJKLMNOPQRSTUV at http://127.0.0.1:17370/v1/captures/cap_ABCDEFGHIJKLMNOPQRSTUV/profile?token=secret#frag',
    nested: {
      authorization: 'Bearer spb_ABCDEFGHIJKLMNOPQRSTUVWxy123456789012345',
      ids: ['spbt_ABCDEFGHIJKLMNOPQRSTUVWxy123456789012345', 'n_ABCDEFGHIJKLMNOPQRSTUV']
    }
  })

  const serialized = JSON.stringify(sanitized)
  assert.deepEqual(sanitized.error, { errorName: 'Error' })
  assert.equal(sanitized.nested.authorization, '[redacted]')
  assert.equal(serialized.includes('token=secret'), false)
  assert.equal(serialized.includes('#frag'), false)
  assert.equal(serialized.includes('spb_'), false)
  assert.equal(serialized.includes('spbt_'), false)
  assert.equal(serialized.includes('cap_ABCDEFGHIJKLMNOPQRSTUV'), false)
  assert.equal(serialized.includes('n_ABCDEFGHIJKLMNOPQRSTUV'), false)

  const pollutedName = new Error('not logged')
  pollutedName.name = pollutedErrorName
  const pollutedSerialized = JSON.stringify(sanitizeLogDetails({ pollutedName }))
  assert.equal(pollutedSerialized.includes('token=secret'), false)
  assert.equal(pollutedSerialized.includes('nonce='), false)
  assert.equal(pollutedSerialized.includes('spb_'), false)
  assert.equal(pollutedSerialized.includes('http://127.0.0.1:17370/bridge?token=secret'), false)
})

test('agent capture cleanup warnings redact polluted Error names', async () => {
  const { reportCleanupFailure } = await loadTsModule('src/background/agent-capture-failure.ts')
  const caught = new Error('not logged')
  caught.name = pollutedErrorName
  const warnings = []
  const originalWarn = console.warn

  try {
    console.warn = (...args) => warnings.push(args)
    reportCleanupFailure('cleanupTarget', caught)
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warnings.length, 1)
  const serialized = JSON.stringify(warnings)
  assert.equal(serialized.includes('token=secret'), false)
  assert.equal(serialized.includes('nonce='), false)
  assert.equal(serialized.includes('spb_'), false)
  assert.equal(serialized.includes('http://127.0.0.1:17370/bridge?token=secret'), false)
})
