export const DEFAULT_CREATE_LIMIT_PER_MINUTE = 10
export const DEFAULT_QUERY_LIMIT_PER_MINUTE = 120
export const DEFAULT_RESOURCE_POLICY = {
  maxOpenConnections: 20,
  headersTimeoutMs: 5000,
  requestTimeoutMs: 35000,
  keepAliveTimeoutMs: 2000
}

export const makeRateLimiter = ({
  createLimitPerMinute = DEFAULT_CREATE_LIMIT_PER_MINUTE,
  queryLimitPerMinute = DEFAULT_QUERY_LIMIT_PER_MINUTE
} = {}) => {
  const buckets = new Map()
  return (token, bucketName, limit, now = Date.now()) => {
    const key = `${token}:${bucketName}`
    const windowStart = now - (now % 60000)
    const bucket = buckets.get(key)
    if (!bucket || bucket.windowStart !== windowStart) {
      buckets.set(key, { windowStart, count: 1 })
      return true
    }
    bucket.count += 1
    return bucket.count <= limit
  }
}

export const applyServerResourcePolicy = (server, policy) => {
  server.maxConnections = policy.maxOpenConnections
  server.headersTimeout = policy.headersTimeoutMs
  server.requestTimeout = policy.requestTimeoutMs
  server.keepAliveTimeout = policy.keepAliveTimeoutMs
}
