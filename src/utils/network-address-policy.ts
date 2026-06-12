const IPV4_BITS = 32n
const IPV6_BITS = 128n

const ipv4Blocks: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32]
]

const ipv6Blocks: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
]

const publicIpv4Exceptions = new Set(['192.0.0.9', '192.0.0.10'])
const publicIpv6Exceptions: Array<[string, number]> = [
  ['2001:1::1', 128],
  ['2001:1::2', 128],
  ['2001:3::', 32],
  ['2001:4:112::', 48],
  ['2001:20::', 28],
  ['2001:30::', 28]
]

const proxyReservedIpv4Blocks: Array<[string, number]> = [['198.18.0.0', 15]]

const cleanAddress = (value: unknown): string =>
  String(value || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .toLowerCase()

const parseIpv4 = (value: string): number | null => {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const number = Number(part)
    if (!Number.isInteger(number) || number < 0 || number > 255) return null
    result = result * 256 + number
  }
  return result >>> 0
}

const ipv4ToText = (value: number): string => [24, 16, 8, 0].map(shift => String((value >>> shift) & 0xff)).join('.')

const normalizeEmbeddedIpv4 = (value: string): string => {
  const match = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
  if (!match) return value
  const ipv4 = parseIpv4(match[2])
  if (ipv4 === null) return value
  return `${match[1]}${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`
}

const mappedIpv4FromIpv6 = (value: string): string | null => {
  const normalized = normalizeEmbeddedIpv4(value)
  const parts = expandIpv6Parts(normalized)
  if (!parts) return null
  const mapped = parts.slice(0, 5).every(part => part === 0) && parts[5] === 0xffff
  if (!mapped) return null
  return ipv4ToText(parts[6] * 65536 + parts[7])
}

const expandIpv6Parts = (value: string): number[] | null => {
  if (!value.includes(':')) return null
  const normalized = normalizeEmbeddedIpv4(value)
  if ((normalized.match(/::/g) || []).length > 1) return null
  const [leftText, rightText = ''] = normalized.split('::')
  const left = leftText ? leftText.split(':') : []
  const right = rightText ? rightText.split(':') : []
  if (!normalized.includes('::') && left.length !== 8) return null
  const missing = 8 - left.length - right.length
  if (missing < 0 || (!normalized.includes('::') && missing !== 0)) return null
  const parts = [...left, ...Array(missing).fill('0'), ...right]
  if (parts.length !== 8) return null
  return parts.map(part => (/^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : NaN)).every(Number.isFinite)
    ? parts.map(part => Number.parseInt(part, 16))
    : null
}

const parseIpv6 = (value: string): bigint | null => {
  const parts = expandIpv6Parts(value)
  if (!parts) return null
  return parts.reduce((result, part) => (result << 16n) + BigInt(part), 0n)
}

const contains = (address: bigint, base: bigint, prefix: number, bits: bigint): boolean => {
  const shift = bits - BigInt(prefix)
  return shift === 0n ? address === base : address >> shift === base >> shift
}

const isBlockedIpv4 = (address: number): boolean => {
  const text = ipv4ToText(address)
  if (publicIpv4Exceptions.has(text)) return false
  return ipv4Blocks.some(([base, prefix]) => contains(BigInt(address), BigInt(parseIpv4(base) ?? 0), prefix, IPV4_BITS))
}

const isPublicIpv6Exception = (address: bigint): boolean =>
  publicIpv6Exceptions.some(([base, prefix]) => {
    const parsed = parseIpv6(base)
    return parsed !== null && contains(address, parsed, prefix, IPV6_BITS)
  })

const isBlockedIpv6 = (address: bigint): boolean =>
  !isPublicIpv6Exception(address) &&
  ipv6Blocks.some(([base, prefix]) => {
    const parsed = parseIpv6(base)
    return parsed !== null && contains(address, parsed, prefix, IPV6_BITS)
  })

export const isPrivateNetworkAddress = (value: unknown): boolean => {
  const address = cleanAddress(value)
  if (!address) return false
  const ipv4 = parseIpv4(address)
  if (ipv4 !== null) return isBlockedIpv4(ipv4)
  const mapped = mappedIpv4FromIpv6(address)
  if (mapped) return isPrivateNetworkAddress(mapped)
  const ipv6 = parseIpv6(address)
  return ipv6 !== null && isBlockedIpv6(ipv6)
}

export const isProxyReservedNetworkAddress = (value: unknown): boolean => {
  const address = cleanAddress(value)
  if (!address) return false
  const ipv4 = parseIpv4(address)
  if (ipv4 !== null) {
    return proxyReservedIpv4Blocks.some(([base, prefix]) => contains(BigInt(ipv4), BigInt(parseIpv4(base) ?? 0), prefix, IPV4_BITS))
  }
  const mapped = mappedIpv4FromIpv6(address)
  return mapped ? isProxyReservedNetworkAddress(mapped) : false
}
