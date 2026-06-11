// @ts-nocheck
/* eslint-disable */

export const detectPageTechnologies = async (ruleConfig: Record<string, unknown> = {}) => {
  const yieldToMainThread = () => new Promise(resolve => setTimeout(resolve, 0))
  const technologies = []
  const ruleRegexCache = new WeakMap()
  const ruleCombinedCache = new WeakMap()
  const ruleHintCache = new WeakMap()
  const resources = collectResources()
  const classTokens = collectClassTokens()
  const cssVariables = collectCssVariables()
  const documentHtmlSample = getHtmlSample()
  const globalKeys = safeGlobalKeys()
  const add = createCollector(technologies)
  const phpRuntimeTechnologyNames = new Set(
    [
      'WordPress',
      'ThinkPHP',
      'Discuz!',
      'phpBB',
      'Drupal',
      'Joomla',
      'Typecho',
      'Z-BlogPHP',
      'Emlog',
      'Magento / Adobe Commerce',
      'OpenCart',
      'PrestaShop',
      'DedeCMS',
      'EmpireCMS',
      'PHPCMS',
      'PHPWind',
      'BBSXP',
      'HDWiki',
      'MediaWiki',
      'Laravel',
      'Laravel Livewire',
      'Symfony',
      'Yii',
      'CodeIgniter',
      'CakePHP',
      'Laminas / Zend Framework',
      'Zend Framework',
      'Swoole',
      'OpenSwoole',
      'FrankenPHP'
    ].map(normalizeRuleName)
  )

  await yieldToMainThread()
  detectFrontendFrameworks(add, resources, classTokens, documentHtmlSample, globalKeys, ruleConfig.frontendFrameworks || [])
  detectUiFrameworks(add, resources, classTokens, cssVariables, documentHtmlSample, ruleConfig.uiFrameworks || [])
  detectAdditionalFrontendTechnologies(add, resources, classTokens, documentHtmlSample, ruleConfig.frontendExtra || [])
  detectMinifiedScriptFallback(add, resources, technologies)

  await yieldToMainThread()
  detectBuildAndRuntime(add, resources, documentHtmlSample, globalKeys, ruleConfig.buildRuntime || [])
  detectCdnAndHosting(add, resources, ruleConfig.cdnProviders || [])
  detectBackendFrameworkHints(add, resources, documentHtmlSample, ruleConfig.backendHints || [])
  detectCmsAndCommerce(add, resources, documentHtmlSample, ruleConfig.websitePrograms || [])

  await yieldToMainThread()
  detectWebsitePrograms(add, resources, documentHtmlSample, globalKeys, ruleConfig.websitePrograms || [])
  detectCmsThemesAndSource(
    add,
    resources,
    classTokens,
    documentHtmlSample,
    globalKeys,
    ruleConfig.cmsThemes || [],
    ruleConfig.dynamicAssetExtractors || []
  )
  detectProbeTools(add, resources, documentHtmlSample, globalKeys, ruleConfig.probes || [])
  detectProgrammingLanguages(add, resources, documentHtmlSample, globalKeys, ruleConfig.languages || [])

  await yieldToMainThread()
  inferLanguagesFromDetectedTechnologies(add, technologies)
  detectFeeds(add, resources, documentHtmlSample, ruleConfig.feeds || [])
  detectSaasServices(add, resources, documentHtmlSample, globalKeys, ruleConfig.saasServices || [])
  detectThirdPartyLogins(add, resources, documentHtmlSample, globalKeys, ruleConfig.thirdPartyLogins || [])

  await yieldToMainThread()
  detectPaymentSystems(add, resources, documentHtmlSample, globalKeys, ruleConfig.paymentSystems || [])
  detectAnalytics(add, resources, documentHtmlSample, globalKeys, ruleConfig.analyticsProviders || [])
  detectCustomRules(add, resources, documentHtmlSample, globalKeys, ruleConfig.customRules || [])
  detectSecurityAndProtocol(add)

  return {
    url: location.href,
    title: document.title,
    generatedAt: new Date().toISOString(),
    technologies: suppressDuplicateWebsiteProgramCategories(
      suppressFrontendAliasTechnologies(suppressFrontendFallbackDuplicates(technologies))
    ),
    resources: {
      total: resources.all.length,
      scripts: resources.scripts.slice(0, 120),
      stylesheets: resources.stylesheets.slice(0, 120),
      resourceTiming: resources.resourceTiming.slice(0, 220),
      all: resources.all.slice(0, 300),
      themeAssetUrls: resources.all.filter(url => /\/wp-content\/themes\//i.test(url)).slice(0, 80),
      resourceDomains: summarizeDomains(resources.all),
      cssVariableCount: cssVariables.names.length,
      metaGenerator: getMetaContent('generator'),
      manifest: document.querySelector("link[rel='manifest']")?.href || null
    }
  }

  function collectResources() {
    const scripts = [...document.scripts].map(script => script.src).filter(isInspectableResourceUrl)
    const stylesheets = [...document.querySelectorAll("link[rel~='stylesheet'], link[as='style']")]
      .map(link => link.href)
      .filter(isInspectableResourceUrl)
    const resourceTiming = performance
      .getEntriesByType('resource')
      .map(entry => entry.name)
      .filter(isInspectableResourceUrl)
    const images = [...document.images]
      .map(image => image.currentSrc || image.src)
      .filter(isInspectableResourceUrl)
      .slice(0, 200)
    const all = unique([...scripts, ...stylesheets, ...resourceTiming, ...images])
    return { scripts, stylesheets, resourceTiming, images, all, text: all.join('\n').toLowerCase() }
  }

  function collectClassTokens() {
    const counts = {}
    const nodes = document.querySelectorAll('[class]')
    const limit = Math.min(nodes.length, 1000)
    for (let i = 0; i < limit; i++) {
      const list = nodes[i].classList
      if (list && list.length) {
        for (let j = 0; j < list.length; j++) {
          const token = list[j]
          if (!token) continue
          counts[token] = (counts[token] || 0) + 1
        }
        continue
      }
      const raw = typeof nodes[i].className === 'string' ? nodes[i].className : nodes[i].getAttribute('class') || ''
      if (!raw) continue
      for (const token of raw.split(/\s+/)) {
        if (!token) continue
        counts[token] = (counts[token] || 0) + 1
      }
    }
    return counts
  }

  function collectCssVariables() {
    const names = new Set()
    const values = {}
    const targets = [document.documentElement, document.body].filter(Boolean)

    for (const target of targets) {
      try {
        const style = getComputedStyle(target)
        for (let index = 0; index < style.length; index += 1) {
          const name = style.item(index)
          if (!name || !name.startsWith('--')) {
            continue
          }
          names.add(name)
          if (!values[name]) {
            values[name] = style.getPropertyValue(name).trim().slice(0, 160)
          }
        }
      } catch {
        continue
      }
    }

    const orderedNames = [...names].slice(0, 500)
    return {
      names: orderedNames,
      values,
      text: orderedNames
        .map(name => `${name}: ${values[name] || ''}`)
        .join('\n')
        .toLowerCase()
    }
  }

  function getHtmlSample() {
    const html = document.documentElement?.outerHTML || ''
    return stripInlineDataUrls(html).slice(0, 500000).toLowerCase()
  }

  function isInspectableResourceUrl(value) {
    const url = String(value || '').trim()
    return Boolean(url) && !/^(?:data|blob|javascript|about):/i.test(url)
  }

  function stripInlineDataUrls(value) {
    return String(value || '').replace(/data:[^"'()<>\s]+/gi, '[inline-data-url]')
  }

  function safeGlobalKeys() {
    try {
      return Object.keys(window).slice(0, 5000)
    } catch {
      return []
    }
  }

  function detectFrontendFrameworks(add, resources, classes, html, globalKeys, externalRules) {
    if (hasReactDomMarker()) {
      add('前端框架', 'React', '高', 'DOM 节点存在 React Fiber 标记')
    }

    detectJsonRuleList(add, externalRules, {
      defaultCategory: '前端框架',
      resources,
      classes,
      html,
      text: `${resources.text}\n${html}\n${globalKeys.join('\n')}`,
      resourceConfidence: '中',
      sourceLabel: 'JSON 前端框架规则'
    })
  }

  function detectUiFrameworks(add, resources, classes, cssVariables, html, externalRules) {
    const atomicCssOrigin = detectAtomicCssOrigin(cssVariables)
    if (atomicCssOrigin === 'unocss') {
      add('UI / CSS 框架', 'UnoCSS', '高', '存在 --un-* CSS 变量(UnoCSS 默认前缀)')
    } else if (atomicCssOrigin === 'tailwind') {
      add('UI / CSS 框架', 'Tailwind CSS', '高', '存在 --tw-* CSS 变量(Tailwind 默认前缀)')
    } else if (scoreTailwind(classes) >= 10) {
      add('UI / CSS 框架', 'Tailwind CSS', '中', '存在大量 Tailwind 风格原子类名')
    }

    detectJsonRuleList(add, externalRules, {
      defaultCategory: 'UI / CSS 框架',
      resources,
      classes,
      cssVariables,
      html,
      text: `${resources.text}\n${html}\n${cssVariables.text}`,
      resourceConfidence: '中',
      sourceLabel: 'JSON UI 框架规则'
    })
  }

  function detectAtomicCssOrigin(cssVariables) {
    const names = cssVariables?.names || []
    let hasUn = false
    let hasTw = false
    for (const name of names) {
      if (!hasUn && name.startsWith('--un-')) hasUn = true
      if (!hasTw && name.startsWith('--tw-')) hasTw = true
      if (hasUn && hasTw) break
    }
    if (hasUn) return 'unocss'
    if (hasTw) return 'tailwind'

    try {
      for (const sheet of document.styleSheets) {
        let rules
        try {
          rules = sheet.cssRules
        } catch {
          continue
        }
        if (!rules) continue
        const limit = rules.length < 400 ? rules.length : 400
        for (let i = 0; i < limit; i++) {
          const text = rules[i]?.cssText || ''
          if (!hasUn && text.includes('--un-')) hasUn = true
          if (!hasTw && text.includes('--tw-')) hasTw = true
          if (hasUn || hasTw) break
        }
        if (hasUn || hasTw) break
      }
    } catch {
      // ignore
    }

    if (hasUn) return 'unocss'
    if (hasTw) return 'tailwind'
    return ''
  }

  function detectAdditionalFrontendTechnologies(add, resources, classes, html, externalRules) {
    const text = `${resources.text}\n${html}`
    detectJsonRuleList(add, externalRules, {
      defaultCategory: '前端库',
      resources,
      classes,
      html,
      text,
      resourceConfidence: '中',
      sourceLabel: 'JSON 前端补充规则'
    })
  }

  function detectMinifiedScriptFallback(add, resources, currentTechnologies) {
    const knownNames = new Set(currentTechnologies.map(tech => normalizeFallbackTechName(tech.name)))
    const seen = new Set()
    const scriptUrls = unique([...(resources.scripts || []), ...(resources.resourceTiming || [])])
    for (const rawUrl of scriptUrls) {
      const info = extractMinifiedScriptLibrary(rawUrl)
      if (!info) {
        continue
      }
      const normalized = normalizeFallbackTechName(info.name)
      if (!normalized || seen.has(normalized) || knownNames.has(normalized)) {
        continue
      }
      seen.add(normalized)
      add('前端库', `疑似前端库: ${info.name}`, '低', `兜底识别：根据脚本文件名 ${info.fileName} 判断，未匹配到内置规则或官网链接`)
      if (seen.size >= 20) {
        break
      }
    }
  }

  function extractMinifiedScriptLibrary(rawUrl) {
    let pathname = ''
    try {
      pathname = new URL(rawUrl, location.href).pathname
    } catch {
      pathname = String(rawUrl || '').split(/[?#]/)[0]
    }
    if (/\/wp-includes\/js\/dist\//i.test(pathname)) {
      return null
    }
    const fileName = safeDecodeURIComponent(pathname.split('/').filter(Boolean).pop() || '')
    if (!/\.js$/i.test(fileName) || !/(?:^|[.-])min\.js$/i.test(fileName)) {
      return null
    }

    let name = fileName
      .replace(/\.js$/i, '')
      .replace(
        /(?:[._-](?:min|prod|production|development|dev|bundle|bundled|umd|esm|cjs|iife|global|runtime|legacy|modern|browser|web|all|full))+$/gi,
        ''
      )
      .replace(/(?:[._-]pkgd)$/i, '')
      .replace(/(?:[._-]v?\d+(?:\.\d+){1,4})$/i, '')
      .replace(/(?:[._-][a-f0-9]{7,})$/i, '')
      .replace(/^npm\./i, '')
      .replace(/^@/, '')
      .trim()

    if (!isLikelyLibraryFileName(name)) {
      return null
    }
    return { name, fileName }
  }

  function isLikelyLibraryFileName(name) {
    if (!name || name.length < 2 || name.length > 60) {
      return false
    }
    if (!/[a-z]/i.test(name)) {
      return false
    }
    if (/^[a-f0-9]{8,}$/i.test(name) || /^[a-z0-9_-]{18,}$/i.test(name)) {
      return false
    }
    const genericNames = new Set([
      'app',
      'application',
      'message',
      'main',
      'index',
      'home',
      'base',
      'core',
      'common',
      'commons',
      'global',
      'runtime',
      'manifest',
      'vendor',
      'vendors',
      'chunk',
      'chunks',
      'bundle',
      'bundles',
      'min',
      'prod',
      'production',
      'development',
      'dev',
      'dist',
      'all',
      'full',
      'browser',
      'web',
      'modern',
      'legacy',
      'umd',
      'esm',
      'cjs',
      'iife',
      'module',
      'modules',
      'plugin',
      'plugins',
      'lib',
      'libs',
      'cdn',
      'scripts',
      'script',
      'custom',
      'theme',
      'frontend',
      'backend',
      'admin',
      'site',
      'page',
      'public',
      'static',
      'lazyload',
      'polyfill',
      'polyfills',
      'webpack',
      'vite',
      'parcel',
      'rollup',
      'esbuild',
      'swc',
      'turbopack',
      'rspack',
      'require',
      'requirejs',
      'system',
      'systemjs',
      // 文档站 / 内容站常见的搜索 worker 文件名（mkdocs / docusaurus / vitepress 等都叫这名），
      // 真实的搜索库（Lunr / FlexSearch / Pagefind / Algolia）会通过专用规则或官方版权注释命中
      'search',
      // 通用名，几乎所有站点都有但不属于公共库
      'sdk',
      'analytics',
      'tracker',
      'tracking',
      'beacon',
      'pixel',
      // 站点自身的内部脚本，不是公共库
      'tgwallpaper',
      'jsbin'
    ])
    if (genericNames.has(name.toLowerCase())) {
      return false
    }
    // vscode.dev / 微软系站点的内部脚本：ms.core / ms.post / ms.deploy 等
    if (/^ms\.[a-z0-9_-]+$/i.test(name)) {
      return false
    }
    // Microsoft AB-test 客户端、Read the Docs 广告脚本、通用 svg loader 等不是公共库
    if (/^(?:tas-client|ethicalads|svg-loader)$/i.test(name)) {
      return false
    }
    return true
  }

  function normalizeFallbackTechName(name) {
    const normalized = String(name || '')
      .toLowerCase()
      .replace(/^疑似前端库:\s*/, '')
      .replace(/(?:\.js|js)$/i, '')
      .replace(/(?:[._-]pkgd)$/i, '')
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
    const aliases = {
      clipboardjs: 'clipboard',
      jquerycompat: 'jquery',
      imagesloadedjs: 'imagesloaded',
      layerjs: 'layer',
      slickcarousel: 'slick',
      twitterbootstrap: 'bootstrap',
      vuejs: 'vue'
    }
    return aliases[normalized] || normalized
  }

  function suppressFrontendAliasTechnologies(items) {
    if (!Array.isArray(items) || !items.length) {
      return []
    }
    const aliases = {
      angular: { category: '前端框架', name: 'Angular' },
      jquery: { category: '前端框架', name: 'jQuery' },
      jquerycompat: { category: '前端框架', name: 'jQuery' },
      layer: { category: '前端库', name: 'Layer.js' },
      preact: { category: '前端框架', name: 'Preact' },
      react: { category: '前端框架', name: 'React' },
      svelte: { category: '前端框架', name: 'Svelte' },
      twitterbootstrap: { category: 'UI / CSS 框架', name: 'Bootstrap' },
      vue: { category: '前端框架', name: 'Vue' }
    }
    const frontendCategories = new Set(['前端库', '前端框架', 'UI / CSS 框架'])
    return items.map(item => {
      if (!frontendCategories.has(item?.category)) {
        return item
      }
      const key = String(item?.name || '')
        .toLowerCase()
        .replace(/^疑似前端库:\s*/, '')
        .replace(/(?:\.js|js)$/i, '')
        .replace(/(?:[._-]pkgd)$/i, '')
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
      const canonical = aliases[key]
      return canonical ? { ...item, category: canonical.category, name: canonical.name } : item
    })
  }

  function suppressFrontendFallbackDuplicates(items) {
    if (!Array.isArray(items) || !items.length) {
      return []
    }

    // 任何已识别的技术都用来消重，避免 SaaS / 统计 / 第三方登录 / 支付 类目里已经命中的库
    // 同名脚本（如 filestack.min.js 已识别为 Filestack SaaS）还被兜底再加一条「疑似前端库」
    const knownNames = new Set(
      items
        .filter(item => !isFrontendFallback(item))
        .map(item => normalizeFallbackTechName(item.name))
        .filter(Boolean)
    )
    if (!knownNames.size) {
      return items
    }

    return items.filter(item => !isFrontendFallback(item) || !knownNames.has(normalizeFallbackTechName(item.name)))
  }

  function isFrontendFallback(item) {
    return item?.category === '前端库' && /^疑似前端库:/i.test(String(item?.name || '').trim())
  }

  function detectBuildAndRuntime(add, resources, html, globalKeys, externalRules) {
    if (navigator.serviceWorker?.controller) {
      add('构建与运行时', 'Service Worker', '中', '当前页面受 Service Worker 控制')
    }

    detectJsonRuleList(add, externalRules, {
      defaultCategory: '构建与运行时',
      resources,
      html,
      text: `${resources.text}\n${html}\n${globalKeys.join('\n')}`,
      sourceLabel: 'JSON 构建运行时规则'
    })
  }

  function detectCdnAndHosting(add, resources, externalRules) {
    detectJsonRuleList(add, externalRules, {
      defaultCategory: 'CDN / 托管',
      resources,
      text: resources.text,
      resourceOnly: true,
      sourceLabel: 'JSON CDN 规则'
    })

    const privateCdnMatches = collectPrivateCdnMatches(resources.all)
    if (privateCdnMatches.length) {
      add(
        'CDN / 托管',
        '自定义 / 私有 CDN',
        '低',
        privateCdnMatches.length + ' 个资源域名疑似私有 CDN，如 ' + privateCdnMatches.slice(0, 3).join('、')
      )
    }
  }

  function collectPrivateCdnMatches(urls) {
    const pageHost = location.hostname.replace(/^www\./, '')
    const hosts = new Set()
    for (const raw of urls) {
      try {
        const host = new URL(raw, location.href).hostname.toLowerCase()
        const normalizedHost = host.replace(/^www\./, '')
        if (normalizedHost === pageHost) {
          continue
        }
        if (isKnownThirdPartyServiceHost(normalizedHost)) {
          continue
        }
        if (
          /(^cdn\d*\.|\.cdn\d*\.|-cdn\d*\.|^static\d*\.|\.static\d*\.|^assets\d*\.|\.assets\d*\.|^edge\d*\.|\.edge\d*\.|^media\d*\.)/.test(
            host
          )
        ) {
          hosts.add(host)
        }
      } catch {
        continue
      }
    }
    return [...hosts].slice(0, 20)
  }

  function isKnownThirdPartyServiceHost(host) {
    return /^(?:static\.cloudflareinsights\.com|challenges\.cloudflare\.com)$/i.test(host)
  }

  function detectBackendFrameworkHints(add, resources, html, externalRules) {
    const text = [location.href, resources.text, html].join('\n')
    detectJsonRuleList(add, externalRules, {
      defaultCategory: '后端 / 服务器框架',
      resources,
      html,
      text,
      sourceLabel: 'JSON 后端规则'
    })
  }

  function detectCmsAndCommerce(add, resources, html, externalRules) {
    const generator = (getMetaContent('generator') || '').toLowerCase()
    const text = [resources.text, html, 'generator: ' + generator].join('\n')
    detectJsonRuleList(add, filterCmsAndCommerceRules(externalRules), {
      defaultCategory: 'CMS / 电商平台',
      resources,
      html,
      text,
      sourceLabel: 'JSON CMS / 电商平台规则'
    })
  }

  function filterCmsAndCommerceRules(rules) {
    if (!Array.isArray(rules)) {
      return []
    }
    return rules.filter(rule => normalizeRuleName(rule.name) !== 'wordpress')
  }

  function normalizeRuleName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
  }

  function hasTechnology(items, category, name) {
    const normalizedName = normalizeRuleName(name)
    return items.some(item => item?.category === category && normalizeRuleName(item.name) === normalizedName)
  }

  function isPhpRuntimeSourceTechnology(item) {
    return phpRuntimeTechnologyNames.has(normalizeRuleName(item?.name))
  }

  function phpRuntimeInferenceEvidence(item) {
    const name = String(item?.name || '').trim() || 'PHP 系技术'
    if (item?.category === '后端 / 服务器框架') {
      return `由 ${name} 后端框架推断 PHP 后端运行时`
    }
    if (item?.category === '网站程序' || item?.category === 'CMS / 电商平台') {
      return `由 ${name} 站点程序推断 PHP 后端运行时`
    }
    return `由 ${name} 技术线索推断 PHP 后端运行时`
  }

  function inferLanguagesFromDetectedTechnologies(add, items) {
    if (hasTechnology(items, '开发语言 / 运行时', 'PHP')) {
      return
    }
    const source = items.find(isPhpRuntimeSourceTechnology)
    if (source) {
      add('开发语言 / 运行时', 'PHP', '中', phpRuntimeInferenceEvidence(source))
    }
  }

  function suppressDuplicateWebsiteProgramCategories(items) {
    if (!Array.isArray(items) || !items.length) {
      return []
    }

    const websiteProgramNames = new Set(
      items
        .filter(item => item?.category === '网站程序')
        .map(item => normalizeRuleName(item.name))
        .filter(Boolean)
    )
    if (!websiteProgramNames.size) {
      return items
    }

    return items.filter(item => item?.category !== 'CMS / 电商平台' || !websiteProgramNames.has(normalizeRuleName(item.name)))
  }

  function detectCmsThemesAndSource(add, resources, classes, html, globalKeys, externalRules, assetExtractors = []) {
    const assetText = `${location.href}
${resources.all.join('\n')}`
    const text = `${assetText}
${html}`
    const normalizedText = text.toLowerCase()
    const normalizedAssetText = assetText.toLowerCase()

    for (const extractor of assetExtractors) {
      collectAssetDirectoryMatches(add, assetText, normalizedAssetText, extractor)
    }

    try {
      const shopifyTheme = window.Shopify?.theme
      if (shopifyTheme?.name) {
        add(
          '主题 / 模板',
          `Shopify 主题: ${String(shopifyTheme.name).slice(0, 80)}`,
          '高',
          `存在 window.Shopify.theme${shopifyTheme.id ? `，theme id: ${shopifyTheme.id}` : ''}`
        )
      } else if (shopifyTheme?.id) {
        add('主题 / 模板', `Shopify 主题 ID: ${shopifyTheme.id}`, '中', '存在 window.Shopify.theme.id')
      }
    } catch {
      // 忽略跨站脚本或代理对象异常。
    }

    detectJsonRuleList(add, externalRules, {
      defaultCategory: '主题 / 模板',
      resources,
      classes,
      html,
      text,
      sourceLabel: 'JSON 主题模板规则',
      evidencePrefix: rule => (rule.kind ? `${rule.kind}：` : '')
    })
  }

  function collectAssetDirectoryMatches(add, text, normalizedText, extractor) {
    const requires = compileAssetPattern(extractor.requires)
    if (requires && !requires.test(normalizedText)) {
      return
    }

    let count = 0
    const limit = extractor.limit || 12
    const seen = new Set()
    const pattern = compileAssetPattern(extractor.pattern, 'gi')
    if (!pattern) {
      return
    }
    let match
    while ((match = pattern.exec(text)) && count < limit) {
      const groups = match.slice(1).map(cleanAssetSlug)
      if (groups.some(value => !value)) {
        continue
      }
      const value = extractor.format === 'joinSlash' ? groups.join('/') : groups[0]
      const key = `${extractor.category}::${extractor.label}::${value}`.toLowerCase()
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      count += 1
      add(extractor.category, `${extractor.label}: ${value}`, '高', `资源或源码路径包含 ${shortPathEvidence(match[0])}`)
    }
  }

  function compileAssetPattern(pattern, defaultFlags = 'i') {
    if (!pattern) {
      return null
    }
    try {
      const source = pattern instanceof RegExp ? pattern.source : String(pattern)
      return new RegExp(source, defaultFlags)
    } catch {
      return null
    }
  }

  function cleanAssetSlug(value) {
    const decoded = safeDecodeURIComponent(String(value || ''))
      .replace(/\\/g, '/')
      .replace(/['")<>]/g, '')
      .trim()
    if (!decoded || decoded.length > 90 || decoded.includes('/') || /[*{}[\]]/.test(decoded)) {
      return ''
    }
    if (!/[a-z0-9\u4e00-\u9fa5]/i.test(decoded)) {
      return ''
    }
    if (/^(?:assets?|static|public|dist|build|cache|css|js|img|images?|fonts?|vendor)$/i.test(decoded)) {
      return ''
    }
    return decoded
  }

  function safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  function shortPathEvidence(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .slice(0, 160)
  }

  function detectSaasServices(add, resources, html, globalKeys, externalRules) {
    const text = [resources.text, html].join('\n')
    detectJsonRuleList(add, externalRules, {
      defaultCategory: 'SaaS / 第三方服务',
      resources,
      html,
      text,
      sourceLabel: 'JSON SaaS 规则',
      evidencePrefix: rule => (rule.kind ? rule.kind + '：' : '')
    })
  }

  function detectWebsitePrograms(add, resources, html, globalKeys, externalRules) {
    detectJsonRuleList(add, externalRules, {
      defaultCategory: '网站程序',
      resources,
      html,
      text: `${resources.text}\n${html}`,
      sourceLabel: 'JSON 网站程序规则',
      evidencePrefix: rule => (rule.kind ? `${rule.kind}：` : '')
    })
  }

  function detectProbeTools(add, resources, html, globalKeys, externalRules) {
    const titleText = document.title ? `\n${document.title}` : ''
    const appMetadataText = [getMetaContent('apple-mobile-web-app-title'), getMetaContent('application-name')].filter(Boolean).join('\n')
    const appMetadata = appMetadataText ? `\n${appMetadataText}` : ''
    detectJsonRuleList(add, externalRules, {
      defaultCategory: '探针 / 监控',
      resources,
      html: '',
      text: `${location.href}\n${resources.text}${titleText}${appMetadata}`,
      sourceLabel: 'JSON 探针规则',
      evidencePrefix: rule => (rule.kind ? `${rule.kind}：` : '')
    })
  }

  function detectThirdPartyLogins(add, resources, html, globalKeys, externalRules) {
    const titleText = document.title ? `\n${document.title}` : ''
    const bodyText = document.body?.innerText ? `\n${document.body.innerText.slice(0, 100000)}` : ''
    detectJsonRuleList(add, externalRules, {
      defaultCategory: '第三方登录 / OAuth',
      resources,
      html,
      text: `${resources.text}\n${html}${titleText}${bodyText}`,
      sourceLabel: 'JSON 第三方登录规则',
      evidencePrefix: rule => (rule.kind ? `${rule.kind}：` : '')
    })
  }

  function detectPaymentSystems(add, resources, html, globalKeys, externalRules) {
    const bodyText = document.body?.innerText ? `\n${document.body.innerText.slice(0, 80000)}` : ''
    detectJsonRuleList(add, externalRules, {
      defaultCategory: '支付系统',
      resources,
      html,
      text: `${location.href}\n${resources.text}\n${html}${bodyText}`,
      sourceLabel: 'JSON 支付规则',
      evidencePrefix: rule => (rule.kind ? `${rule.kind}：` : '')
    })
  }

  function detectCustomRules(add, resources, html, globalKeys, externalRules) {
    const bodyText = document.body?.innerText ? `\n${document.body.innerText.slice(0, 120000)}` : ''
    const text = [location.href, document.title, resources.text, html, bodyText, globalKeys.join('\n')].join('\n')
    detectJsonRuleList(add, externalRules, {
      defaultCategory: '其他库',
      resources,
      html,
      text,
      sourceLabel: '自定义页面规则',
      evidencePrefix: rule => (rule.kind ? `${rule.kind}：` : '')
    })
  }

  function detectProgrammingLanguages(add, resources, html, globalKeys, externalRules) {
    detectJsonRuleList(add, externalRules, {
      defaultCategory: '开发语言 / 运行时',
      resources,
      html,
      text: `${resources.text}\n${html}`,
      sourceLabel: 'JSON 语言规则',
      evidencePrefix: rule => (rule.kind ? `${rule.kind}：` : '')
    })
  }

  function detectFeeds(add, resources, html, externalRules) {
    const feedLinks = [...document.querySelectorAll("link[rel~='alternate']")]
      .map(link => ({
        href: link.href || link.getAttribute('href') || '',
        type: (link.type || '').toLowerCase(),
        title: link.title || ''
      }))
      // 只接受真正的 feed 类型，避免 application/json+oembed 这种非 feed 的备用链接被误算成 JSON Feed
      .filter(
        link =>
          link.href &&
          !/oembed/.test(`${link.type} ${link.href}`.toLowerCase()) &&
          /(?:rss|atom|jsonfeed|feed\+json|json\+feed|application\/feed|\.rss\b|\.atom\b|\/feed(?:\/|\.json|$|\?)|\/rss(?:\/|$|\?)|\/atom(?:\/|$|\?))/.test(
            `${link.type} ${link.href}`.toLowerCase()
          )
      )

    for (const link of feedLinks.slice(0, 20)) {
      const name = feedNameFromType(link.type, link.href)
      add('RSS / 订阅', name, '高', `发现 feed 链接：${shortUrl(link.href)}${link.title ? ` (${link.title})` : ''}`)
    }

    detectJsonRuleList(add, externalRules, {
      defaultCategory: 'RSS / 订阅',
      resources,
      html,
      text: `${resources.text}\n${html}`,
      sourceLabel: 'JSON Feed 规则',
      confidence: '中'
    })
  }

  function feedNameFromType(type, href) {
    const value = `${type} ${href}`.toLowerCase()
    if (value.includes('atom')) {
      return 'Atom Feed'
    }
    if (value.includes('json')) {
      return 'JSON Feed'
    }
    return 'RSS Feed'
  }

  function detectJsonRuleList(add, rules, context) {
    if (!Array.isArray(rules) || !rules.length) {
      return
    }

    for (const rule of rules) {
      const match = matchJsonRule(rule, context)
      if (!match) {
        continue
      }
      const confidence = match.confidence || context.confidence || rule.confidence || '中'
      const prefix = typeof context.evidencePrefix === 'function' ? context.evidencePrefix(rule) : context.evidencePrefix || ''
      const extras: { version?: string; url?: string } = {}
      if (match.version) extras.version = match.version
      if (rule.url) extras.url = rule.url
      add(
        rule.category || context.defaultCategory || '其他库',
        rule.name,
        confidence,
        `${prefix}${match.evidence}`,
        Object.keys(extras).length ? extras : undefined
      )
    }
  }

  // 从命中的资源 URL 里抽版本号:覆盖 cdn / npm / 自托管几种常见 URL 形态
  // 例:cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js → 3.6.0
  //     unpkg.com/react@18.3.1/umd/react.production.min.js → 18.3.1
  //     /assets/swiper-bundle-9.4.1.min.js → 9.4.1
  function extractVersionFromUrl(rule, url) {
    if (!url || typeof url !== 'string') return ''
    const name = String(rule?.name || '').trim()
    if (!name) return ''
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const npmToken = name
      .toLowerCase()
      .replace(/\.js$/i, '')
      .replace(/\s*\/\s*.*$/, '')
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9@_-]/gi, '')
    const tokens = [npmToken, name.toLowerCase()].filter(Boolean)
    for (const token of tokens) {
      const esc = escape(token)
      // 形式 1:`<token>@X.Y.Z`(unpkg / jsdelivr)
      const m1 = new RegExp('[/@]' + esc + '@(\\d+\\.\\d+(?:\\.\\d+)?)', 'i').exec(url)
      if (m1) return m1[1]
      // 形式 2:`/<token>/X.Y.Z/`(cdnjs 风格)
      const m2 = new RegExp('/' + esc + '/(\\d+\\.\\d+(?:\\.\\d+)?)/', 'i').exec(url)
      if (m2) return m2[1]
      // 形式 3:`/<token>-X.Y.Z.(?:min\\.)?js`(自托管直接命名)
      const m3 = new RegExp('/' + esc + '[-._](\\d+\\.\\d+(?:\\.\\d+)?)\\.(?:min\\.)?(?:m?js|css)', 'i').exec(url)
      if (m3) return m3[1]
    }
    return ''
  }

  // 比较两个 semver 字符串("3.10.0" > "3.9.0",字典序则相反):用作 sort comparator
  function compareSemver(a, b) {
    const parse = (s: string) =>
      String(s || '')
        .split('.')
        .map(x => parseInt(x, 10) || 0)
    const aa = parse(a)
    const bb = parse(b)
    const len = Math.max(aa.length, bb.length)
    for (let i = 0; i < len; i++) {
      const av = aa[i] || 0
      const bv = bb[i] || 0
      if (av !== bv) return av - bv
    }
    return 0
  }

  // 命中 globals 时,从 window.<path> 智能抽版本号:
  // 1) value 本身是版本号字符串
  // 2) 对象上有 .version / .VERSION 字符串字段
  // 3) lit-html: window.litHtmlVersions 是数组 ["1.1.2", "2.8.0"],push 进去的版本字符串
  // 4) 数组里的元素是版本号字符串
  // 5) 兜底:扫一层自身属性找符合严格 semver(\d+\.\d+\.\d+)的字符串
  function extractGlobalVersion(globalPath) {
    try {
      let value: any = window
      for (const key of globalPath.split('.')) {
        if (value == null) return ''
        value = value[key]
      }
      if (value == null) return ''
      if (typeof value === 'string' && /^\d+\.\d+/.test(value)) return value
      if (typeof value !== 'object' && typeof value !== 'function') return ''
      if (Array.isArray(value)) {
        // 数组元素可能是版本号字符串(lit-html: ["2.8.0"]),也可能是带 .version 字段的对象
        // (core-js: __core-js_shared__.versions = [{version: "3.46.0", mode: "global"}, ...])
        const versions = value
          .map(item => {
            if (typeof item === 'string') return item
            if (item && typeof item === 'object' && typeof item.version === 'string') return item.version
            return ''
          })
          .filter(v => typeof v === 'string' && /^\d+\.\d+/.test(v))
        if (!versions.length) return ''
        // 按 semver 数字比较,避免 "3.10.0" 字典序 < "3.9.0" 的坑
        return versions.slice().sort(compareSemver).pop() || ''
      }
      if (typeof value.version === 'string' && /^\d+\.\d+/.test(value.version)) return value.version
      if (typeof value.VERSION === 'string' && /^\d+\.\d+/.test(value.VERSION)) return value.VERSION
      // 兜底:遍历自身属性找 semver 字符串(\d+\.\d+\.\d+)
      try {
        for (const key of Object.keys(value)) {
          const v = value[key]
          if (typeof v === 'string' && v.length < 20 && /^\d+\.\d+\.\d+$/.test(v)) return v
        }
      } catch {
        // 跨 origin / Proxy 阻止访问属性时静默忽略
      }
      return ''
    } catch {
      return ''
    }
  }

  function matchJsonRule(rule, context) {
    const ruleResourceOnly = rule?.resourceOnly === true
    const globalName = !ruleResourceOnly && shouldMatchTarget(rule, 'globals') ? (rule.globals || []).find(name => hasGlobal(name)) : null
    if (globalName) {
      // 优先看规则上的 versionFrom 显式路径(jQuery.fn.jquery 这种非标准位置),
      // 否则用通用启发(.version / .VERSION / 数组元素)
      const version = (rule.versionFrom && extractGlobalVersion(rule.versionFrom)) || extractGlobalVersion(globalName)
      return { confidence: '高', evidence: `存在 window.${globalName}`, version }
    }

    const selector =
      !ruleResourceOnly && shouldMatchTarget(rule, 'selectors')
        ? (rule.selectors || []).find(selectorText => hasSelector(selectorText))
        : null
    if (selector) {
      // 规则可声明 versionFromAttribute(例如 styled-components 把版本写在 <style data-styled-version="5.2.3">),
      // 命中后从首个匹配元素抽属性值作为版本号
      let version = ''
      if (rule.versionFromAttribute) {
        try {
          const el = document.querySelector(selector)
          const raw = el ? el.getAttribute(rule.versionFromAttribute) : ''
          if (raw && /^\d+\.\d+/.test(raw)) version = raw
        } catch {
          // 选择器异常静默忽略
        }
      }
      return { confidence: '高', evidence: `DOM 匹配 ${selector}`, version }
    }

    const classPrefix = !ruleResourceOnly
      ? (rule.classPrefixes || []).find(prefix => context.classes && hasClassPrefix(context.classes, prefix))
      : null
    if (classPrefix) {
      return { confidence: '高', evidence: `存在 ${classPrefix}* 类名` }
    }

    const className = !ruleResourceOnly ? (rule.classNames || []).find(name => context.classes && context.classes[name] > 0) : null
    if (className) {
      return { confidence: '高', evidence: `存在 ${className} 类名` }
    }

    const cssVariableMatch = ruleResourceOnly ? null : matchCssVariables(rule, context.cssVariables)
    if (cssVariableMatch) {
      return cssVariableMatch
    }

    if (!matchesResourceHints(rule, context.resources?.text || context.text || '')) {
      return null
    }

    const lowerResources = context.resources?.text || ''
    const getLowerHtml = () => {
      if (context._lowerHtml === undefined) {
        context._lowerHtml = (context.text || '').toLowerCase()
      }
      return context._lowerHtml
    }
    if (!passesRulePrefilter(rule, lowerResources, getLowerHtml)) {
      return null
    }

    const matchResource = shouldMatchTarget(rule, 'resources')
    const matchHtml = !ruleResourceOnly && !context.resourceOnly && shouldMatchTarget(rule, 'html')
    const allResources =
      Array.isArray(rule.matchIn) && rule.matchIn.includes('url')
        ? unique([location.href, ...(context.resources?.all || [])])
        : context.resources?.all || []
    const htmlText = context.text || ''
    const formatUrlEvidence = resource =>
      resource === location.href ? `页面 URL 匹配 ${shortUrl(resource)}` : `资源 URL 匹配 ${shortUrl(resource)}`

    // minPatternMatches=N:要求 N 条 patterns 都至少命中一个资源(组合 heuristic,e.g. shadcn-vue 需要至少 5 个标志性组件 chunk 同时出现才算)
    // 这种 AND 检测必须绕过 combined optimization(combined 把 patterns OR 在一起,无法计数)
    const minPatternMatches = Number(rule.minPatternMatches) || 0
    if (minPatternMatches > 0) {
      if (!matchResource) return null
      const patterns = getCompiledRulePatterns(rule)
      const hits: string[] = []
      for (const pattern of patterns) {
        for (const url of allResources) {
          pattern.lastIndex = 0
          if (pattern.test(url)) {
            hits.push(url)
            break
          }
        }
      }
      if (hits.length < minPatternMatches) return null
      return {
        confidence: rule.confidence || context.resourceConfidence || '中',
        evidence: `资源 URL 匹配 ${shortUrl(hits[0])} 等 ${hits.length} 个`,
        version: extractVersionFromUrl(rule, hits[0])
      }
    }

    const combined = getCompiledCombinedPattern(rule)
    if (combined) {
      if (matchResource) {
        const resource = allResources.find(url => {
          combined.lastIndex = 0
          return combined.test(url)
        })
        if (resource) {
          return {
            confidence: rule.confidence || context.resourceConfidence || '高',
            evidence: formatUrlEvidence(resource),
            version: extractVersionFromUrl(rule, resource)
          }
        }
      }
      if (matchHtml) {
        combined.lastIndex = 0
        if (combined.test(htmlText)) {
          return { confidence: rule.confidence || '中', evidence: '页面源码或资源索引包含规则特征' }
        }
      }
      return null
    }

    const patterns = getCompiledRulePatterns(rule)
    for (const pattern of patterns) {
      if (matchResource) {
        const resource = allResources.find(url => {
          pattern.lastIndex = 0
          return pattern.test(url)
        })
        if (resource) {
          return {
            confidence: rule.confidence || context.resourceConfidence || '高',
            evidence: formatUrlEvidence(resource),
            version: extractVersionFromUrl(rule, resource)
          }
        }
      }
      if (matchHtml) {
        pattern.lastIndex = 0
        if (pattern.test(htmlText)) {
          return { confidence: rule.confidence || '中', evidence: '页面源码或资源索引包含规则特征' }
        }
      }
    }

    return null
  }

  function matchCssVariables(rule, cssVariables) {
    if (!Array.isArray(rule.cssVariables) || !rule.cssVariables.length || !cssVariables?.names?.length) {
      return null
    }

    const normalizedNames = new Set(cssVariables.names.map(name => name.toLowerCase()))
    const matched = rule.cssVariables.filter(name => normalizedNames.has(String(name).toLowerCase()))
    const minMatches = Math.max(1, Number(rule.minCssVariableMatches || 1))
    if (matched.length < minMatches) {
      return null
    }

    const preview = matched.slice(0, 6).join(', ')
    const suffix = matched.length > 6 ? ` 等 ${matched.length} 个` : ''
    return {
      confidence: rule.confidence || '高',
      evidence: `CSS 变量匹配 ${preview}${suffix}`
    }
  }

  function matchesResourceHints(rule, text) {
    if (!Array.isArray(rule.resourceHints) || !rule.resourceHints.length) {
      return true
    }
    const value = String(text || '').toLowerCase()
    return rule.resourceHints.some(hint => value.includes(String(hint || '').toLowerCase()))
  }

  function compileRulePattern(pattern, rule) {
    try {
      if (rule?.matchType === 'keyword') {
        return new RegExp(escapeRegExp(pattern), rule?.caseSensitive ? '' : 'i')
      }
      return new RegExp(pattern, rule?.caseSensitive ? '' : 'i')
    } catch {
      return null
    }
  }

  function getCompiledRulePatterns(rule) {
    if (!rule || typeof rule !== 'object') return []
    const patterns = rule.patterns || []
    const cached = ruleRegexCache.get(rule)
    if (cached && cached.source === patterns) return cached.compiled
    const compiled = patterns.map(pattern => compileRulePattern(pattern, rule)).filter(Boolean)
    ruleRegexCache.set(rule, { source: patterns, compiled })
    return compiled
  }

  function getCompiledCombinedPattern(rule) {
    if (!rule || rule.matchType !== 'keyword') return null
    const patterns = rule.patterns || []
    if (!patterns.length) return null
    const cached = ruleCombinedCache.get(rule)
    if (cached && cached.source === patterns) return cached.compiled
    let compiled = null
    if (typeof rule.__keywordCombined === 'string' && rule.__keywordCombined) {
      try {
        compiled = new RegExp(rule.__keywordCombined, 'i')
      } catch {
        compiled = null
      }
    }
    if (!compiled) {
      try {
        const segments = patterns
          .map(pattern => String(pattern || '').trim())
          .filter(Boolean)
          .map(escapeRegExp)
        if (segments.length) compiled = new RegExp(segments.join('|'), 'i')
      } catch {
        compiled = null
      }
    }
    ruleCombinedCache.set(rule, { source: patterns, compiled })
    return compiled
  }

  function getRuleAutoHints(rule) {
    if (!rule || typeof rule !== 'object') return []
    if (Array.isArray(rule.__hints) && rule.__hints.length) {
      ruleHintCache.set(rule, rule.__hints)
      return rule.__hints
    }
    const cached = ruleHintCache.get(rule)
    if (cached) return cached
    const patterns = rule.patterns || []
    const isKeyword = rule.matchType === 'keyword'
    const candidates = []
    const genericHintParts = new Set([
      'api',
      'asset',
      'assets',
      'cache',
      'cdn',
      'common',
      'content',
      'css',
      'data',
      'file',
      'files',
      'image',
      'images',
      'img',
      'js',
      'plugin',
      'plugins',
      'script',
      'scripts',
      'source',
      'static',
      'style',
      'styles',
      'template',
      'theme',
      'themes',
      'url',
      'version'
    ])
    const normalizeHintCandidate = value =>
      String(value || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/^[^a-z0-9\u4e00-\u9fa5]+|[^a-z0-9\u4e00-\u9fa5]+$/g, '')
        .trim()
    const getRuleNameTokens = () => {
      const text = `${rule.name || ''} ${rule.kind || ''}`.toLowerCase()
      const tokens = text
        .split(/[^a-z0-9\u4e00-\u9fa5]+/)
        .map(token => token.trim())
        .filter(token => token.length >= 3 && !genericHintParts.has(token))
      if (/discuz/i.test(text)) tokens.push('discuz')
      if (/phpbb/i.test(text)) tokens.push('phpbb')
      if (/vbulletin/i.test(text)) tokens.push('vbulletin')
      if (/xenforo/i.test(text)) tokens.push('xenforo')
      if (/mediawiki/i.test(text)) tokens.push('mediawiki')
      if (/typecho/i.test(text)) tokens.push('typecho')
      return [...new Set(tokens)]
    }
    const scoreHintCandidate = (candidate, ruleTokens) => {
      const parts = candidate.split(/[\/._\-\s:=%]+/).filter(Boolean)
      const hasRuleToken = ruleTokens.some(token => candidate.includes(token))
      const genericPartCount = parts.filter(part => genericHintParts.has(part)).length
      let score = Math.min(candidate.length, 32)
      if (hasRuleToken) score += 90
      if (/[_-]/.test(candidate)) score += 14
      if (/[.]/.test(candidate)) score += 8
      if (/\d/.test(candidate) && /[a-z]/.test(candidate)) score += 6
      if (candidate.includes('/')) score += hasRuleToken ? 4 : -8
      if (parts.length && genericPartCount === parts.length) score -= 80
      else score -= genericPartCount * 12
      if (/^(?:content|static|assets|data|source|template|common)(?:[\/:=]|$)/.test(candidate) && !hasRuleToken) score -= 24
      return score
    }
    for (const pattern of patterns) {
      const text = String(pattern || '')
      if (!text) continue
      if (isKeyword) {
        const lower = normalizeHintCandidate(text)
        if (lower.length >= 4) candidates.push(lower)
        continue
      }
      for (const segment of text.replace(/\\[bBdDsSwW]/g, ' ').split(/[\\^$.|?*+()[\]{}]/)) {
        const lowerSeg = normalizeHintCandidate(segment)
        if (lowerSeg.length >= 4) candidates.push(lowerSeg)
      }
    }
    const ruleTokens = getRuleNameTokens()
    const unique = [...new Set(candidates)]
      .sort((a, b) => scoreHintCandidate(b, ruleTokens) - scoreHintCandidate(a, ruleTokens) || b.length - a.length)
      .slice(0, 5)
    ruleHintCache.set(rule, unique)
    return unique
  }

  function passesRulePrefilter(rule, lowerResources, getLowerHtml) {
    if (!rule) return true
    if (Array.isArray(rule.resourceHints) && rule.resourceHints.length) return true
    const hints = getRuleAutoHints(rule)
    if (!hints.length) return true
    for (const hint of hints) {
      if (lowerResources && lowerResources.includes(hint)) return true
    }
    const lowerHtml = typeof getLowerHtml === 'function' ? getLowerHtml() : getLowerHtml || ''
    if (!lowerHtml) return false
    for (const hint of hints) {
      if (lowerHtml.includes(hint)) return true
    }
    return false
  }

  function shouldMatchTarget(rule, target) {
    if (!Array.isArray(rule.matchIn) || !rule.matchIn.length) {
      return true
    }
    if (target === 'resources') {
      return rule.matchIn.some(item => ['resources', 'url', 'dynamic'].includes(item))
    }
    if (target === 'html') {
      return rule.matchIn.some(item => ['html', 'body', 'title'].includes(item))
    }
    if (target === 'globals') {
      return rule.matchIn.some(item => ['html', 'body', 'resources', 'dynamic'].includes(item))
    }
    if (target === 'selectors') {
      return rule.matchIn.some(item => ['html', 'body'].includes(item))
    }
    return rule.matchIn.includes(target)
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function detectAnalytics(add, resources, html, globalKeys, externalRules) {
    const text = [location.href, resources.text, html].join('\n')
    detectJsonRuleList(add, externalRules, {
      defaultCategory: '统计 / 分析',
      resources,
      html: '',
      text,
      sourceLabel: 'JSON 统计规则',
      evidencePrefix: rule => (rule.kind ? rule.kind + '：' : '')
    })
  }

  function detectSecurityAndProtocol(add) {
    if (location.protocol === 'https:') {
      add('安全与协议', 'HTTPS', '高', '当前页面使用 HTTPS')
    }
    const csp = document.querySelector("meta[http-equiv='Content-Security-Policy' i]")
    if (csp) {
      add('安全与协议', 'Content Security Policy', '中', '页面包含 CSP meta 标签')
    }
    detectHttpProtocolVersion(add)
  }

  function detectHttpProtocolVersion(add) {
    let entries
    try {
      entries = performance.getEntriesByType('resource')
    } catch {
      return
    }
    if (!entries || !entries.length) return
    const protocols = new Set()
    for (const entry of entries) {
      const protocol = String(entry?.nextHopProtocol || '').toLowerCase()
      if (protocol) protocols.add(protocol)
    }
    // 取一个最具代表性的样本 URL（便于 evidence 显示）
    const sampleFor = wanted => {
      for (const entry of entries) {
        if (String(entry?.nextHopProtocol || '').toLowerCase() === wanted) return entry.name
      }
      return ''
    }
    if (protocols.has('h3') || protocols.has('h3-29') || protocols.has('h3-Q050')) {
      add('安全与协议', 'HTTP/3', '高', `资源使用 HTTP/3 协议（如 ${shortUrl(sampleFor('h3'))}）`)
    }
    if (protocols.has('h2') || protocols.has('h2c')) {
      add('安全与协议', 'HTTP/2', '高', `资源使用 HTTP/2 协议（如 ${shortUrl(sampleFor('h2'))}）`)
    }
    // 注意：浏览器对 HTTP/1.x 不再单独标，避免噪音
  }

  function createCollector(target) {
    return function add(category, name, confidence, evidence, extras) {
      const tech: any = {
        category,
        name,
        confidence,
        evidence: evidence ? [String(evidence)] : [],
        source: '页面扫描'
      }
      if (extras && typeof extras.version === 'string' && extras.version) {
        tech.version = extras.version
      }
      if (extras && typeof extras.url === 'string' && extras.url) {
        tech.url = extras.url
      }
      target.push(tech)
    }
  }

  function hasGlobal(path) {
    try {
      let value = window
      for (const key of path.split('.')) {
        if (value == null || !(key in value)) {
          return false
        }
        value = value[key]
      }
      return !isDomNamedGlobal(value)
    } catch {
      return false
    }
  }

  function isDomNamedGlobal(value) {
    try {
      return (
        (typeof Element !== 'undefined' && value instanceof Element) ||
        (typeof HTMLCollection !== 'undefined' && value instanceof HTMLCollection) ||
        (typeof NodeList !== 'undefined' && value instanceof NodeList)
      )
    } catch {
      return false
    }
  }

  function hasSelector(selector) {
    try {
      return Boolean(document.querySelector(selector))
    } catch {
      return false
    }
  }

  function hasReactDomMarker() {
    const nodes = [
      document.getElementById('root'),
      document.getElementById('__next'),
      document.body,
      ...document.querySelectorAll('[id], [class]')
    ]
      .filter(Boolean)
      .slice(0, 800)
    for (const node of nodes) {
      try {
        if (
          Object.keys(node).some(
            key => key.startsWith('__reactFiber$') || key.startsWith('__reactProps$') || key.startsWith('_reactRootContainer')
          )
        ) {
          return true
        }
      } catch {
        continue
      }
    }
    return false
  }

  function hasClassPrefix(classes, prefix) {
    return Object.keys(classes).some(name => name.startsWith(prefix))
  }

  function scoreTailwind(classes) {
    const tokens = Object.keys(classes)
    let utilityScore = 0
    let specificScore = 0
    let bootstrapScore = 0
    let distinctUtilityCount = 0
    let count = 0
    const TAILWIND_PATTERN =
      /^(?:sm|md|lg|xl|2xl):|^-?(?:m|p|mt|mr|mb|ml|mx|my|pt|pr|pb|pl|px|py)-|^(?:text|bg|border|ring|shadow|rounded|grid|flex|items|justify|gap|space|w|h|min-w|max-w|min-h|max-h)-|^(?:hover|focus|active|disabled|dark):|\[[^\]]+\]/
    const TAILWIND_SPECIFIC_PATTERN =
      /^(?:sm|md|lg|xl|2xl|hover|focus|active|disabled|dark):|^\[[^\]]+\]$|^(?:text|bg|border|ring|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)$|^(?:grid-cols|grid-rows|gap|space-x|space-y)-\d+$|^(?:w|h|min-w|max-w|min-h|max-h)-(?:screen|full|fit|min|max|\d+\/\d+)$/
    const BOOTSTRAP_PATTERN =
      /^(?:container(?:-(?:fluid|sm|md|lg|xl|xxl))?|row|col(?:-\d+|-(?:sm|md|lg|xl|xxl)(?:-\d+)?)?|btn(?:-.+)?|navbar(?:-.+)?|card(?:-.+)?|dropdown(?:-.+)?|modal(?:-.+)?|form(?:-.+)?|input-group(?:-.+)?|table(?:-.+)?|alert(?:-.+)?|badge(?:-.+)?|d-(?:none|inline|inline-block|block|grid|table|flex|inline-flex)|justify-content-.+|align-items-.+|text-(?:center|start|end|left|right|muted|primary|secondary|success|danger|warning|info|light|dark|white|body|black-50|white-50)|(?:m|p)[tblrxy]?-(?:[0-5]|auto)|mdi(?:-.+)?)$/
    for (const token of tokens) {
      if (count++ >= 5000) break
      if (BOOTSTRAP_PATTERN.test(token)) {
        const c = classes[token]
        bootstrapScore += c < 3 ? c : 3
      }
      if (TAILWIND_PATTERN.test(token)) {
        const c = classes[token]
        utilityScore += c < 3 ? c : 3
        distinctUtilityCount += 1
        if (TAILWIND_SPECIFIC_PATTERN.test(token)) {
          specificScore += c < 3 ? c : 3
        }
      }
    }
    if (specificScore < 3 && bootstrapScore >= 8) {
      return 0
    }
    if (specificScore < 2 && (distinctUtilityCount < 14 || utilityScore < 24)) {
      return 0
    }
    return utilityScore + specificScore * 4
  }

  function getMetaContent(name) {
    return document.querySelector(`meta[name='${cssEscape(name)}' i]`)?.content || ''
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return CSS.escape(value)
    }
    return String(value).replace(/'/g, "\\'")
  }

  function summarizeDomains(urls) {
    const counts = {}
    for (const raw of urls) {
      try {
        const host = new URL(raw, location.href).hostname
        counts[host] = (counts[host] || 0) + 1
      } catch {
        continue
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([domain, count]) => ({ domain, count }))
  }

  function unique(items) {
    return [...new Set(items)]
  }

  function shortUrl(raw) {
    try {
      const url = new URL(raw, location.href)
      return `${url.hostname}${url.pathname}`.slice(0, 96)
    } catch {
      return String(raw).slice(0, 96)
    }
  }
}
