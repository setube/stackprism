const SENSITIVE_DETAIL_KEY = /authorization|cookie|token|nonce|secret/i
const ID_PATTERN = /\b(?:spbt?_|cap_|s_|n_|xfer_|shot_)[A-Za-z0-9_-]{8,}\b/g
const URL_PATTERN = /https?:\/\/[^\s"')]+/g
const MAX_LOG_DETAIL_DEPTH = 4

export const redactLogUrl = (value: unknown): string => {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    if (url.search) url.search = '?[redacted]'
    return url.toString()
  } catch {
    return ''
  }
}

const redactLogText = (value: string): string =>
  value.replace(URL_PATTERN, url => redactLogUrl(url) || '[redacted-url]').replace(ID_PATTERN, '[redacted-id]')

const sanitizeErrorName = (value: unknown): string => {
  const name = typeof value === 'string' && value ? value : 'Error'
  return redactLogText(name)
}

const sanitizeLogValue = (key: string, value: unknown, depth: number): unknown => {
  if (SENSITIVE_DETAIL_KEY.test(key)) return '[redacted]'
  if (value instanceof Error) return { errorName: sanitizeErrorName(value.name) }
  if (typeof value === 'string') return redactLogText(value)
  if (!value || typeof value !== 'object') return value
  if (depth >= MAX_LOG_DETAIL_DEPTH) return '[redacted-object]'
  if (Array.isArray(value)) return value.map(item => sanitizeLogValue('', item, depth + 1))

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, sanitizeLogValue(childKey, child, depth + 1)])
  )
}

export const sanitizeLogDetails = (details: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(details).map(([key, value]) => [key, sanitizeLogValue(key, value, 0)]))

export const logBackgroundError = (message: string, details: Record<string, unknown>) => {
  console.error('[SP background]', message, sanitizeLogDetails(details))
}
