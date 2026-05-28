import net from 'node:net'
import dns from 'node:dns/promises'

const includeOrder = ['tech', 'visual', 'layout', 'components', 'interaction', 'ux', 'assets']
const targetModes = new Set(['reuse_or_new_tab', 'new_tab', 'active_tab'])
const requestKeys = new Set(['url', 'mode', 'waitMs', 'include', 'viewports', 'options'])
const optionKeys = new Set(
  'forceRefresh captureScreenshotMetadata captureScreenshot keepTabOpen allowPrivateNetworkTarget targetMode maxResourceUrls'.split(' ')
)
const booleanOptionKeys = ['forceRefresh', 'captureScreenshotMetadata', 'captureScreenshot', 'keepTabOpen', 'allowPrivateNetworkTarget']
const DNS_LOOKUP_TIMEOUT_MS = 2000

const isPlainRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const hasOnlyKnownKeys = (value, keys) => Object.keys(value).every(key => keys.has(key))
const hasValidBooleanOptions = options => booleanOptionKeys.every(key => options[key] === undefined || typeof options[key] === 'boolean')

const createBlockList = ({ subnets = [], addresses = [] }) => {
  const blockList = new net.BlockList()
  for (const [address, prefix, type] of subnets) blockList.addSubnet(address, prefix, type)
  for (const [address, type] of addresses) blockList.addAddress(address, type)
  return blockList
}

const privateIpBlockList = createBlockList({
  subnets: [
    ['0.0.0.0', 8, 'ipv4'],
    ['10.0.0.0', 8, 'ipv4'],
    ['100.64.0.0', 10, 'ipv4'],
    ['127.0.0.0', 8, 'ipv4'],
    ['169.254.0.0', 16, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.0.0.0', 24, 'ipv4'],
    ['192.0.2.0', 24, 'ipv4'],
    ['192.88.99.0', 24, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['198.18.0.0', 15, 'ipv4'],
    ['198.51.100.0', 24, 'ipv4'],
    ['203.0.113.0', 24, 'ipv4'],
    ['224.0.0.0', 4, 'ipv4'],
    ['240.0.0.0', 4, 'ipv4'],
    ['255.255.255.255', 32, 'ipv4'],
    ['::', 128, 'ipv6'],
    ['::1', 128, 'ipv6'],
    ['64:ff9b:1::', 48, 'ipv6'],
    ['100::', 64, 'ipv6'],
    ['2001::', 23, 'ipv6'],
    ['2001:db8::', 32, 'ipv6'],
    ['2002::', 16, 'ipv6'],
    ['3fff::', 20, 'ipv6'],
    ['fc00::', 7, 'ipv6'],
    ['fe80::', 10, 'ipv6'],
    ['ff00::', 8, 'ipv6']
  ]
})

const publicIpExceptionBlockList = createBlockList({
  subnets: [
    ['2001:3::', 32, 'ipv6'],
    ['2001:4:112::', 48, 'ipv6'],
    ['2001:20::', 28, 'ipv6'],
    ['2001:30::', 28, 'ipv6']
  ],
  addresses: [
    ['192.0.0.9', 'ipv4'],
    ['192.0.0.10', 'ipv4'],
    ['2001:1::1', 'ipv6'],
    ['2001:1::2', 'ipv6']
  ]
})

export const isPrivateIpLiteral = hostname => {
  const host = hostname.replace(/^\[|\]$/g, '')
  const lowerHost = host.toLowerCase()
  if (lowerHost === 'localhost') return true
  if (lowerHost.startsWith('::ffff:')) {
    return isPrivateIpLiteral(mappedIpv4Address(lowerHost.slice('::ffff:'.length)))
  }
  if (lowerHost.startsWith('0:0:0:0:0:ffff:')) {
    return isPrivateIpLiteral(mappedIpv4Address(lowerHost.slice('0:0:0:0:0:ffff:'.length)))
  }
  if (net.isIP(host) === 4) return isPrivateIpv4Literal(host)
  if (net.isIP(host) === 6) return isPrivateIpv6Literal(lowerHost)
  return false
}

const isPrivateIpv4Literal = value => {
  return privateIpBlockList.check(value, 'ipv4') && !publicIpExceptionBlockList.check(value, 'ipv4')
}

const isPrivateIpv6Literal = value => {
  return privateIpBlockList.check(value, 'ipv6') && !publicIpExceptionBlockList.check(value, 'ipv6')
}

const mappedIpv4Address = value => {
  if (net.isIP(value) === 4) return value
  const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value)
  if (!match) return value
  const high = Number.parseInt(match[1], 16)
  const low = Number.parseInt(match[2], 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

const isIpLiteral = hostname => net.isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
const effectivePort = parsed => parsed.port || (parsed.protocol === 'http:' ? '80' : parsed.protocol === 'https:' ? '443' : '')

const isBridgeLoopbackAlias = (hostname, bridgeHostname) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const bridgeHost = bridgeHostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === bridgeHost) return true
  if (bridgeHost !== '127.0.0.1') return false
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1'
}

const isBridgeSelfTarget = (parsed, bridgeOrigin) => {
  const bridge = new URL(bridgeOrigin)
  return (
    parsed.protocol === bridge.protocol &&
    effectivePort(parsed) === effectivePort(bridge) &&
    isBridgeLoopbackAlias(parsed.hostname, bridge.hostname)
  )
}

const normalizeDnsAddress = item => {
  if (typeof item === 'string') return item
  if (item && typeof item.address === 'string') return item.address
  return ''
}

const isPrivateResolvedAddress = item => {
  const address = normalizeDnsAddress(item)
  return Boolean(address && isPrivateIpLiteral(address))
}

const defaultResolveHostname = async hostname => {
  let timeoutId
  const lookup = dns.lookup(hostname, { all: true, verbatim: true })
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('DNS_LOOKUP_TIMEOUT')), DNS_LOOKUP_TIMEOUT_MS)
  })
  try {
    return await Promise.race([lookup, timeout])
  } finally {
    clearTimeout(timeoutId)
  }
}

const validateDnsPolicy = async (parsed, allowPrivateNetworkTarget, resolveHostname) => {
  if (allowPrivateNetworkTarget || isIpLiteral(parsed.hostname)) return { ok: true }
  let addresses
  try {
    addresses = await resolveHostname(parsed.hostname)
  } catch {
    return {
      ok: false,
      code: 'TARGET_DNS_LOOKUP_FAILED',
      message: 'Target hostname could not be resolved.',
      details: { reason: 'dns_lookup_failed' }
    }
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    return {
      ok: false,
      code: 'TARGET_DNS_LOOKUP_FAILED',
      message: 'Target hostname could not be resolved.',
      details: { reason: 'dns_lookup_failed' }
    }
  }
  if (addresses.some(isPrivateResolvedAddress)) {
    return {
      ok: false,
      code: 'PRIVATE_NETWORK_TARGET_BLOCKED',
      message: 'Private network targets are disabled.',
      details: { reason: 'private_network_address' }
    }
  }
  return { ok: true }
}

const validateViewports = viewports =>
  Array.isArray(viewports) &&
  viewports.length <= 3 &&
  viewports.every(
    viewport =>
      viewport &&
      typeof viewport === 'object' &&
      Object.keys(viewport).every(key => ['name', 'width', 'height', 'deviceScaleFactor'].includes(key)) &&
      (viewport.name === undefined || (typeof viewport.name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(viewport.name))) &&
      Number.isInteger(viewport.width) &&
      viewport.width >= 320 &&
      viewport.width <= 3840 &&
      Number.isInteger(viewport.height) &&
      viewport.height >= 320 &&
      viewport.height <= 2160 &&
      typeof viewport.deviceScaleFactor === 'number' &&
      Number.isFinite(viewport.deviceScaleFactor) &&
      viewport.deviceScaleFactor >= 1 &&
      viewport.deviceScaleFactor <= 4
  )

export const normalizeCaptureRequest = async (body, bridgeOrigin, { resolveHostname = defaultResolveHostname } = {}) => {
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!hasOnlyKnownKeys(request, requestKeys)) return { ok: false, code: 'INVALID_REQUEST', message: 'Unknown capture request field.' }
  if (request.mode !== 'experience') return { ok: false, code: 'INVALID_REQUEST', message: 'Capture mode is invalid.' }

  const url = typeof request.url === 'string' ? request.url.trim() : ''
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Capture url is invalid.' }
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 4096) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Capture url is invalid.' }
  }
  parsed.hash = ''
  parsed.hostname = parsed.hostname.toLowerCase()
  if (isBridgeSelfTarget(parsed, bridgeOrigin))
    return { ok: false, code: 'BRIDGE_SELF_TARGET_BLOCKED', message: 'Bridge origin cannot be captured.' }

  const options = request.options === undefined ? {} : request.options
  if (!isPlainRecord(options) || !hasOnlyKnownKeys(options, optionKeys)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Unknown capture option field.' }
  }
  if (!hasValidBooleanOptions(options)) return { ok: false, code: 'INVALID_REQUEST', message: 'Capture options are invalid.' }
  if (isPrivateIpLiteral(parsed.hostname) && options.allowPrivateNetworkTarget !== true) {
    return {
      ok: false,
      code: 'PRIVATE_NETWORK_TARGET_BLOCKED',
      message: 'Private network targets are disabled.',
      details: { reason: 'private_network_address' }
    }
  }
  const dnsPolicy = await validateDnsPolicy(parsed, options.allowPrivateNetworkTarget === true, resolveHostname)
  if (!dnsPolicy.ok) return dnsPolicy

  const include = Array.isArray(request.include) ? [...new Set(includeOrder.filter(item => request.include.includes(item)))] : []
  if (!include.length || request.include.some?.(item => !includeOrder.includes(item))) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Capture include is invalid.' }
  }
  const waitMs = request.waitMs === undefined ? 3000 : request.waitMs
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000)
    return { ok: false, code: 'INVALID_REQUEST', message: 'Capture waitMs is invalid.' }
  const viewports = request.viewports === undefined ? [] : request.viewports
  if (!validateViewports(viewports)) return { ok: false, code: 'INVALID_REQUEST', message: 'Capture viewports are invalid.' }
  const targetMode = options.targetMode === undefined ? 'reuse_or_new_tab' : options.targetMode
  if (!targetModes.has(targetMode)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Capture targetMode is invalid.' }
  }
  if (
    options.maxResourceUrls !== undefined &&
    (!Number.isInteger(options.maxResourceUrls) || options.maxResourceUrls < 0 || options.maxResourceUrls > 1000)
  ) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Capture maxResourceUrls is invalid.' }
  }

  return {
    ok: true,
    request: {
      url: parsed.toString(),
      mode: 'experience',
      waitMs,
      include,
      viewports,
      options: {
        forceRefresh: options.forceRefresh === true,
        captureScreenshotMetadata: options.captureScreenshotMetadata === true,
        captureScreenshot: options.captureScreenshot === true,
        keepTabOpen: options.keepTabOpen === true,
        allowPrivateNetworkTarget: options.allowPrivateNetworkTarget === true,
        targetMode,
        maxResourceUrls: options.maxResourceUrls ?? 300
      },
      protocolVersion: 1
    }
  }
}

export const validateFinalUrl = async (value, bridgeOrigin, request, { resolveHostname = defaultResolveHostname } = {}) => {
  const finalRequest = {
    url: value,
    mode: request.mode,
    waitMs: request.waitMs,
    include: request.include,
    viewports: request.viewports,
    options: {
      ...(request.options || {}),
      allowPrivateNetworkTarget: request.options?.allowPrivateNetworkTarget === true
    }
  }
  const normalized = await normalizeCaptureRequest(finalRequest, bridgeOrigin, { resolveHostname })
  if (normalized.ok) return { ok: true, finalUrl: normalized.request.url }
  return {
    ok: false,
    code: 'FINAL_URL_BLOCKED',
    message: 'Final URL is blocked by target policy.',
    details: normalized.details || { reason: normalized.code === 'TARGET_DNS_LOOKUP_FAILED' ? 'dns_lookup_failed' : 'invalid_final_url' }
  }
}
