// @ts-nocheck
export const runContentObserver = () => {
  const isStackPrismAgentBridgeUrl = () => {
    if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1' || location.pathname !== '/bridge') return false
    const specs = {
      session: /^s_[A-Za-z0-9_-]{22}$/,
      capture: /^cap_[A-Za-z0-9_-]{22}$/,
      nonce: /^n_[A-Za-z0-9_-]{22}$/
    }
    const values = {}
    const parts = location.search.replace(/^\?/, '').split('&').filter(Boolean)
    if (parts.length !== 3) return false
    for (const part of parts) {
      const separatorIndex = part.indexOf('=')
      if (separatorIndex <= 0 || part.indexOf('=', separatorIndex + 1) !== -1) return false
      const name = part.slice(0, separatorIndex)
      const value = part.slice(separatorIndex + 1)
      const spec = specs[name]
      if (!spec || values[name] !== undefined || !spec.test(value)) return false
      values[name] = value
    }
    return Boolean(values.session && values.capture && values.nonce)
  }

  if (isStackPrismAgentBridgeUrl()) {
    return
  }

  const MAX_ITEMS = 300
  const MAX_DOM_MARKERS = 120
  const MAX_MUTATION_COUNT = 5000
  const MAX_RESOURCE_COUNT = 1500
  const MAX_PENDING_MUTATION_NODES = 200
  const SEND_DELAY = 400
  const MUTATION_BURST_WINDOW_MS = 1000
  const MUTATION_BURST_THRESHOLD = 150
  const MUTATION_COOLDOWN_MS = 5000
  const MUTATION_FLUSH_DELAY = 200
  const MUTATION_OBSERVER_LIFETIME_MS = 30000
  const CONTEXT_INVALIDATED_PATTERN = /extension context invalidated|context invalidated/i
  const OBSERVER_INSTANCE_KEY = '__stackPrismContentObserver__'
  const SKIP_TAGS = new Set(['VIDEO', 'AUDIO', 'CANVAS', 'PICTURE', 'SOURCE', 'TRACK', 'SVG', 'IMG'])
  const SKIP_INITIATOR_TYPES = new Set(['img', 'video', 'audio', 'beacon', 'track', 'object', 'embed', 'css'])
  const SKIP_RESOURCE_EXT = /\.(ts|m4s|mp4|webm|mov|m3u8|mpd|jpg|jpeg|png|gif|webp|avif|ico|woff2?|ttf|otf|eot)(\?.*)?$/i
  const SKIP_CONTAINER_PATTERN =
    /danmaku|bullet[\s_-]*(?:comment|screen|chat)|barrage|(?:^|[\s._#-])chat(?:[\s._#-]|$)|chat-?(?:panel|area|list|box|room|stream|window)|live-?chat|comment-?(?:stream|live|list)|(?:^|[\s._-])feed(?:[\s._-]|$)|webcast/i
  const state = {
    startedAt: Date.now(),
    updatedAt: Date.now(),
    url: location.href,
    title: document.title,
    resources: [],
    scripts: [],
    stylesheets: [],
    iframes: [],
    feedLinks: [],
    domMarkers: [],
    mutationCount: 0,
    resourceCount: 0
  }
  const seenUrls = {
    resources: new Set(),
    scripts: new Set(),
    stylesheets: new Set(),
    iframes: new Set()
  }
  let sendTimer = 0
  let stopped = false
  let performanceObserver = null
  let mutationObserver = null
  let navigationInterval = 0
  let originalPushState = null
  let originalReplaceState = null
  let wrappedPushState = null
  let wrappedReplaceState = null
  let pendingMutationNodes = []
  let pendingMutationFrame = 0
  let mutationBurstWindowStart = Date.now()
  let mutationBurstCount = 0
  let mutationCooldownUntil = 0
  let mutationCooldownReconnect = 0
  let mutationLifetimeTimer = 0

  // ----- 调试埋点（默认关闭，开启：localStorage.setItem('__sp_observer_debug__','1') + 刷新） -----

  const PERF_DEBUG = (() => {
    try {
      return localStorage.getItem('__sp_observer_debug__') === '1'
    } catch {
      return false
    }
  })()
  const noop = () => {}
  const perfMark = PERF_DEBUG
    ? name => {
        try {
          performance.mark(name)
        } catch {
          // ignore
        }
      }
    : noop
  const perfMeasure = PERF_DEBUG
    ? (name, startMark, detail) => {
        try {
          performance.measure(name, { start: startMark, detail })
        } catch {
          // ignore
        }
        try {
          performance.clearMarks(startMark)
        } catch {
          // ignore
        }
      }
    : noop

  const PERF_DUMP_INTERVAL_MS = 3000
  const PERF_MEASURE_NAMES = ['sp:mutation-callback', 'sp:mutation-flush', 'sp:perf-observer', 'sp:send-snapshot']
  let perfDumpTimer = 0

  const dumpPerfSnapshot = () => {
    const summary = {}
    let hasAny = false
    for (const name of PERF_MEASURE_NAMES) {
      const entries = performance.getEntriesByName(name)
      if (!entries.length) continue
      hasAny = true
      let total = 0
      let max = 0
      let lastDetail = null
      for (const entry of entries) {
        total += entry.duration
        if (entry.duration > max) max = entry.duration
        if (entry.detail !== undefined) lastDetail = entry.detail
      }
      summary[name] = {
        count: entries.length,
        totalMs: Number(total.toFixed(1)),
        avgMs: Number((total / entries.length).toFixed(2)),
        maxMs: Number(max.toFixed(1)),
        lastDetail
      }
      try {
        performance.clearMeasures(name)
      } catch {
        // ignore
      }
    }
    if (hasAny) {
      console.log('[StackPrism observer]', new Date().toISOString().slice(11, 19), summary)
    }
  }

  // ----- 底层 helper -----

  const trimList = (list, max) => {
    if (list.length > max) {
      list.splice(0, list.length - max)
    }
  }

  const isExtensionContextInvalidated = error => CONTEXT_INVALIDATED_PATTERN.test(String(error?.message || error))

  const getRuntimeLastError = () => {
    try {
      return chrome?.runtime?.lastError || null
    } catch (error) {
      return error
    }
  }

  const addUrl = (key, value) => {
    if (!value) return false
    const normalized = String(value)
    if (!normalized) return false
    const seen = seenUrls[key]
    if (seen.has(normalized)) return false
    seen.add(normalized)
    state[key].push(normalized)
    if (state[key].length > MAX_ITEMS) {
      const overflow = state[key].length - MAX_ITEMS
      const removed = state[key].splice(0, overflow)
      for (let i = 0; i < removed.length; i++) seen.delete(removed[i])
    }
    return true
  }

  const addFeedLink = (href, type, title) => {
    if (!href || state.feedLinks.some(link => link.href === href)) return false
    state.feedLinks.push({ href, type, title })
    trimList(state.feedLinks, 60)
    return true
  }

  const addDomMarker = marker => {
    if (!marker || state.domMarkers.includes(marker)) return false
    state.domMarkers.push(marker)
    trimList(state.domMarkers, MAX_DOM_MARKERS)
    return true
  }

  // ----- 静态快照采集 -----

  const collectScripts = root => {
    for (const script of root.scripts || []) {
      addUrl('scripts', script.src)
      addUrl('resources', script.src)
    }
  }

  const collectStylesheets = root => {
    for (const link of root.querySelectorAll?.("link[rel~='stylesheet'], link[as='style']") || []) {
      addUrl('stylesheets', link.href)
      addUrl('resources', link.href)
    }
  }

  const collectIframes = root => {
    for (const frame of root.querySelectorAll?.('iframe[src]') || []) {
      addUrl('iframes', frame.src)
      addUrl('resources', frame.src)
    }
  }

  // 与 page-detector 保持一致：排除 oembed 等非 feed 协议，必须命中真正的 feed 类型 / 路径
  const FEED_HREF_TYPE_PATTERN =
    /(?:rss|atom|jsonfeed|feed\+json|json\+feed|application\/feed|\.rss\b|\.atom\b|\/feed(?:\/|\.json|$|\?)|\/rss(?:\/|$|\?)|\/atom(?:\/|$|\?))/
  const isFeedHrefAndType = (href, type) => {
    const value = `${type} ${href}`.toLowerCase()
    if (/oembed/.test(value)) return false
    return FEED_HREF_TYPE_PATTERN.test(value)
  }

  const collectFeedLinks = root => {
    for (const link of root.querySelectorAll?.("link[rel~='alternate']") || []) {
      const href = link.href || link.getAttribute('href')
      const type = String(link.type || '').toLowerCase()
      if (href && isFeedHrefAndType(href, type)) {
        addFeedLink(href, type, link.title || '')
      }
    }
  }

  const collectPerformanceResources = () => {
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        addUrl('resources', entry.name)
      }
    } catch {
      return
    }
  }

  const collectStaticSnapshot = () => {
    collectScripts(document)
    collectStylesheets(document)
    collectIframes(document)
    collectFeedLinks(document)
    collectPerformanceResources()
  }

  // ----- 元素动态采集 -----

  const collectDomMarker = element => {
    const markers = []
    const id = element.id ? `#${element.id}` : ''
    const className = typeof element.className === 'string' ? element.className : element.getAttribute?.('class') || ''
    const attrs = ['data-v-app', 'ng-version', 'data-reactroot', 'data-turbo', 'data-controller']
      .filter(name => element.hasAttribute?.(name))
      .map(name => `[${name}${element.getAttribute(name) ? `=${element.getAttribute(name)}` : ''}]`)

    if (id) {
      markers.push(id)
    }
    if (className) {
      const selectedClasses = className
        .split(/\s+/)
        .filter(token => /^(ant-|Mui|chakra-|el-|v-|svelte-|astro-|q-|van-|layui-|weui-|uk-|bp\d-|cds--|dx-|p-|tdesign-|arco-)/.test(token))
        .slice(0, 8)
      markers.push(...selectedClasses.map(token => `.${token}`))
    }
    markers.push(...attrs)

    let changed = false
    for (const marker of markers) {
      changed = addDomMarker(marker) || changed
    }
    return changed
  }

  const collectElementIfRelevant = element => {
    const tagName = element.tagName?.toLowerCase()
    let changed = false
    if (tagName === 'script') {
      changed = addUrl('scripts', element.src) || changed
      changed = addUrl('resources', element.src) || changed
    } else if (tagName === 'link') {
      const href = element.href || element.getAttribute('href')
      const rel = String(element.rel || element.getAttribute('rel') || '').toLowerCase()
      const type = String(element.type || '').toLowerCase()
      if (rel.includes('stylesheet') || element.as === 'style') {
        changed = addUrl('stylesheets', href) || changed
        changed = addUrl('resources', href) || changed
      }
      if (rel.includes('alternate') && /rss|atom|feed|json/.test(`${type} ${href}`.toLowerCase())) {
        changed = addFeedLink(href, type, element.title || '') || changed
      }
    } else if (tagName === 'iframe') {
      changed = addUrl('iframes', element.src) || changed
      changed = addUrl('resources', element.src) || changed
    }

    changed = collectDomMarker(element) || changed
    return changed
  }

  const SUBTREE_SCAN_LIMIT = 200
  const SUBTREE_SELECTOR =
    'script[src], link[href], iframe[src], [data-v-app], [ng-version], [data-reactroot], [data-turbo], [data-controller], astro-island, astro-slot'

  const matchesSkipContainer = element => {
    const id = element.id
    if (id && SKIP_CONTAINER_PATTERN.test(id)) return true
    const className = typeof element.className === 'string' ? element.className : element.getAttribute?.('class') || ''
    return Boolean(className && SKIP_CONTAINER_PATTERN.test(className))
  }

  const collectFromElement = element => {
    let changed = false
    if (SKIP_TAGS.has(element.tagName)) return changed
    if (matchesSkipContainer(element)) return changed
    changed = collectElementIfRelevant(element) || changed
    if (!element.querySelectorAll || !element.childElementCount) return changed
    const matches = element.querySelectorAll(SUBTREE_SELECTOR)
    const limit = matches.length < SUBTREE_SCAN_LIMIT ? matches.length : SUBTREE_SCAN_LIMIT
    for (let i = 0; i < limit; i++) {
      const target = matches[i]
      if (SKIP_TAGS.has(target.tagName)) continue
      changed = collectElementIfRelevant(target) || changed
    }
    return changed
  }

  // ----- 生命周期与发送（互相递归调用，运行时已就绪） -----

  const getRuntime = () => {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id || typeof chrome.runtime.sendMessage !== 'function') {
        return null
      }
      return chrome.runtime
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        stopObserver({ keepErrorGuards: true })
      }
      return null
    }
  }

  const handleSendFailure = error => {
    if (isExtensionContextInvalidated(error)) {
      stopObserver({ keepErrorGuards: true })
    }
  }

  const sendSnapshot = () => {
    perfMark('sp:send-start')
    const runtime = getRuntime()
    if (stopped || !runtime) {
      stopObserver()
      return
    }
    state.updatedAt = Date.now()
    state.title = document.title
    const snapshot = {
      ...state,
      resources: [...state.resources],
      scripts: [...state.scripts],
      stylesheets: [...state.stylesheets],
      iframes: [...state.iframes],
      feedLinks: state.feedLinks.map(link => ({ ...link })),
      domMarkers: [...state.domMarkers]
    }
    try {
      runtime.sendMessage({ type: 'DYNAMIC_PAGE_SNAPSHOT', snapshot }, () => {
        const error = getRuntimeLastError()
        if (error) {
          handleSendFailure(error)
        }
      })
    } catch (error) {
      handleSendFailure(error)
    }
    perfMeasure('sp:send-snapshot', 'sp:send-start', {
      resources: state.resources.length,
      scripts: state.scripts.length,
      stylesheets: state.stylesheets.length,
      iframes: state.iframes.length,
      domMarkers: state.domMarkers.length
    })
  }

  const scheduleSend = () => {
    if (stopped || !getRuntime()) {
      stopObserver()
      return
    }
    clearTimeout(sendTimer)
    sendTimer = setTimeout(sendSnapshot, SEND_DELAY)
  }

  const handleUrlChange = () => {
    if (stopped) return
    setTimeout(() => {
      if (stopped) return
      if (state.url !== location.href) {
        state.url = location.href
        state.title = document.title
        collectStaticSnapshot()
        try {
          if (document.body) collectFromElement(document.body)
        } catch {
          // ignore
        }
        addDomMarker(`route:${location.pathname}${location.search}`)
        scheduleSend()
      }
    }, 60)
  }

  const handleGlobalError = event => {
    if (!isExtensionContextInvalidated(event.error || event.message)) return
    event.preventDefault()
    if (!getRuntime()) {
      stopObserver({ keepErrorGuards: true })
    }
  }

  const handleUnhandledRejection = event => {
    if (!isExtensionContextInvalidated(event.reason)) return
    event.preventDefault()
    if (!getRuntime()) {
      stopObserver({ keepErrorGuards: true })
    }
  }

  const stopObserver = (options = {}) => {
    const keepErrorGuards = Boolean(options?.keepErrorGuards)
    stopped = true
    clearTimeout(sendTimer)
    if (pendingMutationFrame) {
      clearTimeout(pendingMutationFrame)
      pendingMutationFrame = 0
    }
    pendingMutationNodes = []
    if (mutationCooldownReconnect) {
      window.clearTimeout(mutationCooldownReconnect)
      mutationCooldownReconnect = 0
    }
    if (mutationLifetimeTimer) {
      window.clearTimeout(mutationLifetimeTimer)
      mutationLifetimeTimer = 0
    }
    if (perfDumpTimer) {
      window.clearInterval(perfDumpTimer)
      perfDumpTimer = 0
    }
    if (navigationInterval) {
      window.clearInterval(navigationInterval)
      navigationInterval = 0
    }
    window.removeEventListener('popstate', handleUrlChange)
    if (history.pushState === wrappedPushState && originalPushState) {
      history.pushState = originalPushState
    }
    if (history.replaceState === wrappedReplaceState && originalReplaceState) {
      history.replaceState = originalReplaceState
    }
    if (!keepErrorGuards) {
      window.removeEventListener('error', handleGlobalError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
    performanceObserver?.disconnect?.()
    mutationObserver?.disconnect?.()
    try {
      if (window[OBSERVER_INSTANCE_KEY]?.stop === stopObserver) {
        delete window[OBSERVER_INSTANCE_KEY]
      }
    } catch {
      return
    }
  }

  // ----- 安装观察器 -----

  const replacePreviousObserver = () => {
    try {
      const previous = window[OBSERVER_INSTANCE_KEY]
      if (previous && typeof previous.stop === 'function') {
        previous.stop()
      }
    } catch {
      return
    }
  }

  const registerCurrentObserver = () => {
    try {
      window[OBSERVER_INSTANCE_KEY] = {
        stop: stopObserver
      }
    } catch {
      return
    }
  }

  const installPerformanceObserver = () => {
    if (!('PerformanceObserver' in window)) return
    try {
      const observer = new PerformanceObserver(list => {
        if (stopped) return
        perfMark('sp:po-start')
        let added = 0
        const entries = list.getEntries()
        for (const entry of entries) {
          if (SKIP_INITIATOR_TYPES.has(entry.initiatorType)) continue
          if (SKIP_RESOURCE_EXT.test(entry.name)) continue
          if (addUrl('resources', entry.name)) added += 1
          state.resourceCount += 1
        }
        if (state.resourceCount >= MAX_RESOURCE_COUNT) {
          observer.disconnect()
          performanceObserver = null
        }
        if (added) scheduleSend()
        perfMeasure('sp:perf-observer', 'sp:po-start', { entries: entries.length, added })
      })
      performanceObserver = observer
      observer.observe({ type: 'resource', buffered: true })
    } catch {
      collectPerformanceResources()
    }
  }

  const processPendingMutationNodes = () => {
    pendingMutationFrame = 0
    if (stopped) return
    const nodes = pendingMutationNodes
    pendingMutationNodes = []
    if (!nodes.length) return
    perfMark('sp:flush-start')
    let changed = false
    let processed = 0
    for (const node of nodes) {
      if (!node.isConnected) continue
      processed += 1
      changed = collectFromElement(node) || changed
    }
    if (changed) {
      state.updatedAt = Date.now()
      scheduleSend()
    }
    perfMeasure('sp:mutation-flush', 'sp:flush-start', { queued: nodes.length, processed, changed })
  }

  const scheduleMutationFlush = () => {
    if (pendingMutationFrame || stopped) return
    pendingMutationFrame = setTimeout(processPendingMutationNodes, MUTATION_FLUSH_DELAY)
  }

  const observeMutationTarget = () => {
    if (!mutationObserver) return
    const target = document.body || document.documentElement || document
    try {
      mutationObserver.observe(target, { childList: true, subtree: true })
    } catch {
      // ignore
    }
  }

  const triggerMutationCooldown = now => {
    mutationCooldownUntil = now + MUTATION_COOLDOWN_MS
    pendingMutationNodes = []
    if (pendingMutationFrame) {
      clearTimeout(pendingMutationFrame)
      pendingMutationFrame = 0
    }
    if (mutationObserver) {
      mutationObserver.disconnect()
      if (mutationCooldownReconnect) {
        window.clearTimeout(mutationCooldownReconnect)
      }
      mutationCooldownReconnect = window.setTimeout(() => {
        mutationCooldownReconnect = 0
        if (stopped) return
        observeMutationTarget()
      }, MUTATION_COOLDOWN_MS)
    }
  }

  const installMutationObserver = () => {
    const observer = new MutationObserver(mutations => {
      if (stopped) return
      const now = Date.now()
      if (now < mutationCooldownUntil) return
      perfMark('sp:mo-start')
      if (now - mutationBurstWindowStart > MUTATION_BURST_WINDOW_MS) {
        mutationBurstWindowStart = now
        mutationBurstCount = 0
      }
      const pendingBefore = pendingMutationNodes.length
      let pendingFull = false
      outer: for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue
          if (SKIP_TAGS.has(node.tagName)) continue
          if (matchesSkipContainer(node)) continue
          state.mutationCount += 1
          mutationBurstCount += 1
          pendingMutationNodes.push(node)
          if (pendingMutationNodes.length >= MAX_PENDING_MUTATION_NODES) {
            pendingFull = true
            break outer
          }
        }
      }
      const accepted = pendingMutationNodes.length - pendingBefore
      if (pendingFull || mutationBurstCount >= MUTATION_BURST_THRESHOLD) {
        triggerMutationCooldown(now)
        perfMeasure('sp:mutation-callback', 'sp:mo-start', {
          mutations: mutations.length,
          accepted,
          cooldown: true,
          pendingFull
        })
        return
      }
      if (state.mutationCount >= MAX_MUTATION_COUNT) {
        observer.disconnect()
        mutationObserver = null
      }
      if (pendingMutationNodes.length) scheduleMutationFlush()
      perfMeasure('sp:mutation-callback', 'sp:mo-start', { mutations: mutations.length, accepted, cooldown: false })
    })
    mutationObserver = observer
    observeMutationTarget()
  }

  const installNavigationObserver = () => {
    originalPushState = history.pushState
    originalReplaceState = history.replaceState

    wrappedPushState = function pushState(...args) {
      const result = originalPushState.apply(this, args)
      handleUrlChange()
      return result
    }
    wrappedReplaceState = function replaceState(...args) {
      const result = originalReplaceState.apply(this, args)
      handleUrlChange()
      return result
    }
    history.pushState = wrappedPushState
    history.replaceState = wrappedReplaceState
    window.addEventListener('popstate', handleUrlChange)
    navigationInterval = window.setInterval(handleUrlChange, 5000)
  }

  const installContextInvalidationGuards = () => {
    window.addEventListener('error', handleGlobalError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
  }

  // ----- 主程序 -----

  installContextInvalidationGuards()
  if (!getRuntime()) {
    stopObserver()
    return
  }

  try {
    replacePreviousObserver()
    registerCurrentObserver()
    window.addEventListener('pagehide', stopObserver, { once: true })
    collectStaticSnapshot()
    installPerformanceObserver()
    installMutationObserver()
    installNavigationObserver()
    scheduleSend()
    mutationLifetimeTimer = window.setTimeout(() => {
      mutationLifetimeTimer = 0
      if (stopped) return
      if (mutationCooldownReconnect) {
        window.clearTimeout(mutationCooldownReconnect)
        mutationCooldownReconnect = 0
      }
      if (mutationObserver) {
        mutationObserver.disconnect()
        mutationObserver = null
      }
    }, MUTATION_OBSERVER_LIFETIME_MS)
    if (PERF_DEBUG) {
      console.log('[StackPrism observer] 性能埋点已启用，每 ' + PERF_DUMP_INTERVAL_MS + 'ms 输出一次摘要')
      perfDumpTimer = window.setInterval(dumpPerfSnapshot, PERF_DUMP_INTERVAL_MS)
    }
  } catch (error) {
    if (!isExtensionContextInvalidated(error)) {
      throw error
    }
    stopObserver({ keepErrorGuards: true })
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  runContentObserver()
}
