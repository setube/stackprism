#!/usr/bin/env node
import { createBridgeServer } from './bridge/http-server.mjs'
import { parseOpenConfig } from './bridge/open-browser.mjs'
import { protocolVersion, service, version } from './bridge/protocol.mjs'

const failStart = (code, message) => {
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`)
  process.exit(1)
}

const parsePort = value => {
  if (value === undefined) return 0
  if (!/^[0-9]+$/.test(value)) return null
  const port = Number(value)
  return port >= 1 && port <= 65535 ? port : null
}

const openConfig = parseOpenConfig(process.env)
const port = parsePort(process.env.STACKPRISM_BRIDGE_PORT)
if (!openConfig.ok) {
  failStart(openConfig.code, openConfig.message)
} else if (port === null) {
  failStart('BRIDGE_INVALID_ENV', 'STACKPRISM_BRIDGE_PORT must be an integer from 1 to 65535.')
} else {
  const bridge = createBridgeServer({ port })
  try {
    const ready = await bridge.listen()
    const shutdown = async () => {
      ready.store.clear()
      await bridge.close().catch(() => {
        process.stderr.write(`${JSON.stringify({ error: { code: 'BRIDGE_CLOSE_FAILED', message: 'Bridge server close failed.' } })}\n`)
      })
      process.exit(0)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    process.stdin.once('end', shutdown)
    process.stdin.resume()
    process.stdout.write(
      `${JSON.stringify({
        event: 'stackprism-bridge-ready',
        service,
        version,
        protocolVersion,
        baseUrl: ready.baseUrl,
        healthUrl: ready.healthUrl,
        apiToken: ready.apiToken
      })}\n`
    )
  } catch (caught) {
    const code = caught?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'BRIDGE_START_FAILED'
    const message = code === 'PORT_IN_USE' ? 'Configured bridge port is already in use.' : 'Failed to start bridge server.'
    process.stderr.write(
      `${JSON.stringify({
        error: {
          code,
          message,
          details: { reason: caught?.code || caught?.name || 'unknown' }
        }
      })}\n`
    )
    process.exit(1)
  }
}
