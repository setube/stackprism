#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { scanUrl, StackPrismError } from '../sdk/index'

declare const __STACKPRISM_SDK_VERSION__: string

const help = `Usage: stackprism <http(s)://url> [--timeout <ms>] [--observe <ms>] [--executable-path <path>]

Inspect one URL using installed Chrome. JSON report on stdout; JSON errors on stderr.
  --timeout <ms>             Total operation budget, 1..120000 (default: 30000)
  --observe <ms>             Observe subresource headers after load, 0..5000 (default: 1000)
  --executable-path <path>   Use a specific Chromium executable
  --help                    Show this help
  --version                 Show SDK version

Exit codes: 0 success, 1 detection/launch/navigation failure, 2 invalid arguments,
            3 timeout, 130 cancelled (SIGINT), 143 terminated (SIGTERM).
An empty technology list or HTTP error status is still a successful observation.
`

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      options: {
        timeout: { type: 'string' },
        observe: { type: 'string' },
        'executable-path': { type: 'string' },
        help: { type: 'boolean' },
        version: { type: 'boolean' }
      },
      allowPositionals: true,
      strict: true
    })
  } catch {
    throw new StackPrismError('INVALID_ARGUMENT', 'Unknown or malformed argument; use --help')
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(help)
    return
  }
  if (values.version) {
    process.stdout.write(`${__STACKPRISM_SDK_VERSION__}\n`)
    return
  }
  if (positionals.length !== 1) throw new StackPrismError('INVALID_ARGUMENT', 'Expected exactly one URL; use --help')
  const timeout = values.timeout as string | undefined
  if (timeout !== undefined && !/^\d+$/.test(timeout))
    throw new StackPrismError('INVALID_ARGUMENT', '--timeout must be an integer in milliseconds')
  const observation = values.observe as string | undefined
  if (observation !== undefined && !/^\d+$/.test(observation))
    throw new StackPrismError('INVALID_ARGUMENT', '--observe must be an integer in milliseconds')
  const controller = new AbortController()
  const interrupt = () => {
    process.exitCode = 130
    controller.abort()
  }
  const terminate = () => {
    process.exitCode = 143
    controller.abort()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    const report = await scanUrl(positionals[0], {
      timeoutMs: timeout === undefined ? undefined : Number(timeout),
      observationMs: observation === undefined ? undefined : Number(observation),
      executablePath: values['executable-path'] as string | undefined,
      signal: controller.signal
    })
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

void main().catch(error => {
  const failure = error instanceof StackPrismError ? error : new StackPrismError('DETECTION_FAILED', 'Unexpected CLI failure')
  process.stderr.write(`${JSON.stringify({ error: { code: failure.code, message: failure.message } })}\n`)
  process.exitCode ||= failure.code === 'INVALID_ARGUMENT' ? 2 : failure.code === 'TIMEOUT' ? 3 : failure.code === 'ABORTED' ? 130 : 1
})
