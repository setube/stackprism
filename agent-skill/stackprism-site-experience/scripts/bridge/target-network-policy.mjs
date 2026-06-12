import net from 'node:net'
import { isIpLiteral, isPrivateIpLiteral, isProxyReservedIpLiteral } from './url-policy.mjs'

const invalidNetworkAddress = () => ({
  ok: false,
  code: 'INVALID_REQUEST',
  message: 'Target network address is invalid.',
  details: { reason: 'invalid_network_address' }
})

const normalizeNetworkAddress = value => value.trim().replace(/^\[|\]$/g, '')

export const validateTargetNetworkAddress = (value, request, { finalUrl } = {}) => {
  if (request.options?.allowPrivateNetworkTarget === true) {
    return { ok: true }
  }
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'string') return invalidNetworkAddress()
  const address = normalizeNetworkAddress(value)
  if (!address) return { ok: true }
  if (net.isIP(address) === 0) return invalidNetworkAddress()
  if (!isPrivateIpLiteral(address)) return { ok: true }
  try {
    const targetUrl = new URL(finalUrl || request.url)
    if (!isIpLiteral(targetUrl.hostname) && !isPrivateIpLiteral(targetUrl.hostname) && isProxyReservedIpLiteral(address)) {
      return { ok: true }
    }
  } catch {
    return invalidNetworkAddress()
  }
  return {
    ok: false,
    code: 'FINAL_URL_BLOCKED',
    message: 'Final URL is blocked by target policy.',
    details: { reason: 'private_network_address' }
  }
}
