export const LIMITS = {
  nodes: 2000,
  styleNodes: 80,
  componentSamples: 80,
  textSamples: 80,
  cssRules: 400,
  resourceUrls: 300,
  executeScriptResultBytes: 2 * 1024 * 1024
} as const

export type Truncation = {
  domNodes: number
  componentSamples: number
  textSamples: number
  cssRules: number
  resourceUrls: number
  executeScriptResult: number
  executeScriptResultOverLimit: number
}

export const emptyTruncation = (): Truncation => ({
  domNodes: 0,
  componentSamples: 0,
  textSamples: 0,
  cssRules: 0,
  resourceUrls: 0,
  executeScriptResult: 0,
  executeScriptResultOverLimit: 0
})

export const cleanText = (value: unknown, limit = 140): string =>
  String(value ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/\b(?:\+?\d[\d\s-]{8,}\d|\d{11,})\b/g, '[redacted]')
    .replace(/(?:[￥$€£]\s*\d+(?:\.\d+)?)/g, '[redacted]')
    .replace(
      /\b([A-Za-z0-9_-]*(?:token|secret|session|auth|authorization|key|signature|password|pass|cookie)[A-Za-z0-9_-]*)\s*[:=]\s*(?:Bearer\s+)?[^,\s;&]+/gi,
      '$1=[redacted]'
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)

export const includeScreenshotMetadata = (): boolean => Boolean((globalThis as any).__STACKPRISM_EXPERIENCE_OPTIONS__?.captureScreenshotMetadata)

export const uniquePush = (target: string[], value: unknown, limit = 80): void => {
  const clean = cleanText(value, 180)
  if (clean && !target.includes(clean) && target.length < limit) target.push(clean)
}

const SENSITIVE_PATH_WORD_PATTERN = /^(?:token|secret|session|auth|authorization|signature|password|cookie|passcode)$/i
const SENSITIVE_PATH_SHORT_TOKEN_PATTERN = /(?:^|[-_.])(?:key|pass)(?:$|[-_.])/i
const SENSITIVE_PATH_COMPOUND_PATTERN =
  /^(?:(?:api|access|private|public|secret|session|auth|token)[-_.]?(?:key|pass|token|secret|signature|code|id)|(?:key|pass|token)[-_.]?(?:token|secret|signature|code|id)|(?:reset|verify|access|auth|session|csrf|xsrf)[-_.]?(?:token|code|secret|key|signature))$/i
const SENSITIVE_PATH_CAMEL_PATTERN = /^(?:apiKey|privateKey|publicKey|accessToken|refreshToken|sessionId|secretToken|authToken|csrfToken|xsrfToken)$/i
const HIGH_ENTROPY_PATH_SEGMENT_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9_-]{24,}$/
const pathSegmentStem = (segment: string): string => segment.replace(/\.[A-Za-z0-9]{1,8}$/i, '')

const isSensitivePathSegment = (segment: string): boolean => {
  const stem = pathSegmentStem(segment)
  return (
    SENSITIVE_PATH_WORD_PATTERN.test(segment) ||
    SENSITIVE_PATH_WORD_PATTERN.test(stem) ||
    SENSITIVE_PATH_SHORT_TOKEN_PATTERN.test(segment) ||
    SENSITIVE_PATH_SHORT_TOKEN_PATTERN.test(stem) ||
    SENSITIVE_PATH_COMPOUND_PATTERN.test(segment) ||
    SENSITIVE_PATH_COMPOUND_PATTERN.test(stem) ||
    SENSITIVE_PATH_CAMEL_PATTERN.test(segment) ||
    SENSITIVE_PATH_CAMEL_PATTERN.test(stem) ||
    /^[0-9a-f]{16,}$/i.test(stem) ||
    HIGH_ENTROPY_PATH_SEGMENT_PATTERN.test(stem) ||
    segment.includes('=')
  )
}

const redactPathname = (pathname: string): string =>
  pathname
    .split('/')
    .map(segment => (segment && isSensitivePathSegment(segment) ? '[redacted]' : segment))
    .join('/')

export const safeUrl = (value: unknown): string => {
  try {
    const url = new URL(String(value || ''), location.href)
    if (!/^https?:$/i.test(url.protocol)) return ''
    url.username = ''
    url.password = ''
    url.hash = ''
    url.pathname = redactPathname(url.pathname)
    for (const name of [...url.searchParams.keys()]) {
      url.searchParams.set(name, '[redacted]')
    }
    return url.toString()
  } catch {
    return ''
  }
}

export const safeRect = (element: Element) => {
  try {
    const rect = element.getBoundingClientRect()
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
  } catch {
    return null
  }
}

export const selectNodes = (): Element[] => {
  if (typeof document === 'undefined') return []
  return [...document.querySelectorAll('body *')].slice(0, LIMITS.nodes)
}
