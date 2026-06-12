import { makeBridgeError } from './capture-runtime.mjs'

const DEFAULT_INCLUDE = ['tech', 'visual', 'layout', 'components', 'interaction', 'ux', 'assets']
const INCLUDE_VALUES = new Set(DEFAULT_INCLUDE)
const DEFAULT_REQUEST_TIMEOUT_MS = 30000

const usageText = () =>
  [
    'Usage: node agent-skill/stackprism-site-experience/scripts/capture-site.mjs --url <url> --out <profile.json> [--screenshot-out <image.jpg>] [--allow-private-network]',
    '',
    'Options:',
    '  --url <url>                 Target http/https URL.',
    '  --out <path>                Write completed profile JSON to this path.',
    '  --result-out <path>         Optional capture result summary JSON path.',
    '  --screenshot-out <path>     Optional decoded screenshot output path; defaults to a sidecar image.',
    '  --allow-private-network     Allow controlled private-network targets for this attempt.',
    '  --wait-ms <ms>              Target settle wait, default 3000.',
    `  --include <list>            Comma-separated sections, default ${DEFAULT_INCLUDE.join(',')}.`,
    '  --request-timeout-ms <ms>   Per bridge API request timeout, default 30000.',
    '  --max-resource-urls <n>     Resource URL cap, default 300.',
    '  --force-refresh             Reload the target after opening it to bypass cache.',
    '  --no-screenshot             Do not request visible viewport screenshot.'
  ].join('\n')

export const makeArgumentError = message => makeBridgeError('INVALID_REQUEST', message, { details: { usage: usageText() } })

export const parseArgs = argv => {
  const args = {
    waitMs: 3000,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maxResourceUrls: 300,
    include: DEFAULT_INCLUDE,
    captureScreenshot: true,
    forceRefresh: false,
    allowPrivateNetworkTarget: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--url') args.url = argv[++index]
    else if (arg === '--out') args.out = argv[++index]
    else if (arg === '--result-out') args.resultOut = argv[++index]
    else if (arg === '--screenshot-out') args.screenshotOut = argv[++index]
    else if (arg === '--allow-private-network') args.allowPrivateNetworkTarget = true
    else if (arg === '--force-refresh') args.forceRefresh = true
    else if (arg === '--no-screenshot') args.captureScreenshot = false
    else if (arg === '--wait-ms') args.waitMs = Number(argv[++index])
    else if (arg === '--include') args.include = String(argv[++index] || '').split(',')
    else if (arg === '--request-timeout-ms') args.requestTimeoutMs = Number(argv[++index])
    else if (arg === '--max-resource-urls') args.maxResourceUrls = Number(argv[++index])
    else return { ok: false, message: `Unknown argument: ${arg}` }
  }
  if (!args.url || !args.out) return { ok: false, message: '--url and --out are required.' }
  if (!Number.isInteger(args.waitMs) || args.waitMs < 0 || args.waitMs > 30000) {
    return { ok: false, message: '--wait-ms must be an integer from 0 to 30000.' }
  }
  args.include = [...new Set(args.include.map(value => value.trim()).filter(Boolean))]
  if (!args.include.length || args.include.some(value => !INCLUDE_VALUES.has(value))) {
    return { ok: false, message: `--include must contain one or more of: ${DEFAULT_INCLUDE.join(', ')}.` }
  }
  if (!Number.isInteger(args.requestTimeoutMs) || args.requestTimeoutMs < 100 || args.requestTimeoutMs > 60000) {
    return { ok: false, message: '--request-timeout-ms must be an integer from 100 to 60000.' }
  }
  if (!Number.isInteger(args.maxResourceUrls) || args.maxResourceUrls < 0 || args.maxResourceUrls > 1000) {
    return { ok: false, message: '--max-resource-urls must be an integer from 0 to 1000.' }
  }
  return { ok: true, args }
}
