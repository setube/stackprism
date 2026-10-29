import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import {
  createDynamicSnapshot,
  loadDynamicSnapshotDetector,
  loadPageRules,
  loadTsModule,
  repoRoot,
  runPageDetector,
  runPageDetectorResult
} from './helpers/rule-harness.mjs'

const rules = loadPageRules([
  'page/frontend-frameworks.json',
  'page/frontend-cdn-libraries.json',
  'page/website-programs.json',
  'page/cdn-providers-page.json',
  'page/dynamic-asset-extractors.json',
  'page/languages.json',
  'page/saas-services-page.json',
  'page/analytics-providers.json',
  'page/dynamic-technologies.json',
  'page/build-runtime.json',
  'page/ui-frameworks.json',
  'page/frontend-local-libraries.json'
])
const names = technologies => new Set(technologies.map(technology => technology.name))
const BACKSLASH = String.fromCharCode(92)

// #35 的友链页：头像来自别人的 Next.js 和 WordPress 站点
const friendAvatars = [
  'https://www.tblase.cn/_next/image?url=%2Fimages%2Favatar.jpg&w=256&q=75',
  'https://blog.mmp.cc/wp-content/uploads/2024/11/df.png'
]
const friendPage = {
  href: 'https://www.yeqing.net/friends/',
  html: `<html><head></head><body>${friendAvatars
    .map(src => `<a href="${new URL(src).origin}/"><img loading="lazy" src="${src.replaceAll('&', '&amp;')}"></a>`)
    .join('')}<a href="https://blog.mmp.cc/wp-content/uploads/2024/11/notes.pdf">notes</a></body></html>`.toLowerCase(),
  resources: ['https://www.yeqing.net/js/friends/entry.BIhdKgrt.js'],
  images: friendAvatars
}

test('友链页里外站头像的路径不算本站技术栈', async () => {
  const found = names(await runPageDetector(rules, friendPage))
  for (const name of ['Next.js', 'WordPress', 'PHP']) assert.equal(found.has(name), false, name)
})

test('本站、同站子域和页面执行的资源照常识别', async () => {
  const ownImage = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/',
      images: ['https://www.example.com/_next/image?url=%2Fa.png&w=64&q=75']
    })
  )
  assert.ok(ownImage.has('Next.js'))
  const subdomain = names(
    await runPageDetector(rules, { href: 'https://www.example.com/', images: ['https://cdn.example.com/wp-content/uploads/2024/01/a.png'] })
  )
  assert.ok(subdomain.has('WordPress'))
  const foreignScript = names(
    await runPageDetector(rules, { resources: ['https://assets.example-cdn.net/_next/static/chunks/main-1a2b.js'] })
  )
  assert.ok(foreignScript.has('Next.js'))
  const scriptChunk = names(
    await runPageDetector(rules, { entries: [{ name: 'https://assets.example-cdn.net/_next/static/chunks/app', initiatorType: 'script' }] })
  )
  assert.ok(scriptChunk.has('Next.js'))
  // 给页面提供脚本或样式表的主机，其他资源也归本站
  const trustedHost = names(
    await runPageDetector(rules, {
      resources: ['https://static.example-cdn.net/app.js'],
      images: ['https://static.example-cdn.net/wp-content/uploads/a.png']
    })
  )
  assert.ok(trustedHost.has('WordPress'))
  const stylesheetHost = names(
    await runPageDetector(rules, {
      stylesheets: ['https://combo.example-cdn.net/??a.css,b.css'],
      images: ['https://combo.example-cdn.net/wp-content/uploads/a.png']
    })
  )
  assert.ok(stylesheetHost.has('WordPress'))
  // 公共包 CDN 上无后缀的入口脚本、按 fetch 加载的 wasm 都是页面执行的代码
  const packageScripts = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/',
      scripts: ['https://unpkg.com/alpinejs', 'https://cdn.jsdelivr.net/npm/@unocss/runtime'],
      entries: [{ name: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm', initiatorType: 'fetch' }]
    })
  )
  for (const name of ['Alpine.js', 'UnoCSS', 'WebAssembly']) assert.ok(packageScripts.has(name), name)
})

test('SSR 页面水合前只有 preload 的脚本也算页面执行的资源', async () => {
  const pageRules = loadPageRules(['page/website-programs-extra.json'])
  const fixture = {
    href: 'https://blog.greenroots.info/',
    preloads: ['https://ping.hashnode.com/gtag/js?id=G-72XG3F8LNJ'],
    images: ['https://cdn.hashnode.com/res/hashnode/image/upload/v1/abc.png']
  }
  assert.ok(names(await runPageDetector(pageRules, fixture)).has('Hashnode'))
  assert.equal(names(await runPageDetector(pageRules, { ...fixture, preloads: [] })).has('Hashnode'), false)
})

test('本站代理里嵌着的外站地址按外站判断', async () => {
  const proxied = await runPageDetector(rules, {
    href: 'https://www.example.com/',
    html: '<html><body><img src="/proxy?url=https://friend.example.org/_next/image"></body></html>',
    images: ['https://www.example.com/proxy?url=https://friend.example.org/_next/image']
  })
  assert.equal(names(proxied).has('Next.js'), false)
  const protocolRelative = await runPageDetector(rules, {
    href: 'https://www.example.com/',
    html: '<html><body><img src="/proxy?url=//friend.example.org/_next/image"></body></html>',
    images: ['https://www.example.com/proxy?url=//friend.example.org/_next/image']
  })
  assert.equal(names(protocolRelative).has('Next.js'), false)
  // Cloudflare 图片缩放：外站地址嵌在本站路径里
  const resized = await runPageDetectorResult(rules, {
    href: 'https://www.yeqing.net/friends/',
    images: [
      'https://www.yeqing.net/cdn-cgi/image/width=64/https://blog.mmp.cc/wp-content/uploads/2024/11/df.png',
      'https://www.yeqing.net/cdn-cgi/image/width=64/https://friend.example.org/wp-content/themes/sakura/avatar.png',
      'https://www.yeqing.net/cdn-cgi/image/width=64/https://friend.vercel.app/avatar.png'
    ]
  })
  for (const name of ['WordPress', 'PHP', 'WordPress 主题: sakura', 'Vercel'])
    assert.equal(names(resized.technologies).has(name), false, name)
  assert.deepEqual([...resized.resources.themeAssetUrls], [])
  // 外层本站路径照常识别
  const ownOuter = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/',
      images: [`https://www.example.com/_next/image?url=${encodeURIComponent('https://friend.example.org/zb_users/upload/a.png')}&w=64`]
    })
  )
  assert.ok(ownOuter.has('Next.js'))
  assert.equal(ownOuter.has('Z-BlogPHP'), false)
})

test('源码里的外站链接不触发兜底匹配，本站相对地址照常命中', async () => {
  const foreignLinks = await runPageDetector(rules, {
    html: '<html><body><a href="https://friend.example.org/_next/static/x">a</a><img src="//friend.example.org/_next/image?url=a"></body></html>'
  })
  assert.equal(names(foreignLinks).has('Next.js'), false)
  const relative = await runPageDetector(rules, { html: '<html><body><img src="/_next/image?url=a"></body></html>' })
  assert.ok(names(relative).has('Next.js'))
  // 外站在前、本站在后：跳过外站地址后接着找
  const mixed = await runPageDetector(rules, {
    html: '<html><body><a href="https://friend.example.org/_next/static/x">a</a><img src="/_next/image?url=a"></body></html>'
  })
  assert.ok(names(mixed).has('Next.js'))
  const srcset = await runPageDetector(rules, {
    html: '<html><body><img srcset="/own.png 1x,//friend.example.org/_next/image?url=a 2x"></body></html>'
  })
  assert.equal(names(srcset).has('Next.js'), false)
  // 内联 JSON 里转义过的外站地址
  const avatar = 'https://friend.example.org/zb_users/upload/2024/01/a.png'
  for (const escaped of [avatar.replaceAll('/', `${BACKSLASH}/`), avatar.replaceAll('/', `${BACKSLASH}u002f`)]) {
    const inline = await runPageDetector(rules, {
      href: 'https://www.example.com/friends/',
      html: `<html><body><script>window.friends=[{"avatar":"${escaped}"}]</script></body></html>`
    })
    assert.equal(names(inline).has('Z-BlogPHP'), false, escaped)
  }
  // outerHTML 把属性里的引号写成 &quot;，外站地址后面的本站路径照常算
  const quoted = await runPageDetector(rules, {
    href: 'https://www.example.com/',
    html: '<html><body><div data-config="{&quot;home&quot;:&quot;https://friend.example.org&quot;,&quot;img&quot;:&quot;/_next/static/media/a.png&quot;}"></div></body></html>'
  })
  assert.ok(names(quoted).has('Next.js'))
})

test('托管平台上的别人站点不算本站托管，同一租户照常识别', async () => {
  const friends = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/',
      images: [
        'https://friend.github.io/img/avatar.png',
        'https://friend.vercel.app/avatar.png',
        'https://friend.netlify.app/img/avatar.png',
        'https://friend.pages.dev/avatar.png',
        'https://friend.example.org/_vercel/image?url=%2Favatar.png&w=128&q=75'
      ]
    })
  )
  for (const name of ['GitHub Pages', 'Vercel', 'Netlify', 'Cloudflare Pages']) assert.equal(friends.has(name), false, name)
  const own = names(await runPageDetector(rules, { href: 'https://alice.github.io/', images: ['https://alice.github.io/img/a.png'] }))
  assert.ok(own.has('GitHub Pages'))
  const neighbour = names(
    await runPageDetector(rules, { href: 'https://alice.github.io/', images: ['https://bob.github.io/_next/image?url=a'] })
  )
  assert.equal(neighbour.has('Next.js'), false)
  // 页面执行别人部署在 Vercel 上的统计脚本，不代表本站托管在 Vercel
  const umami = names(
    await runPageDetector(rules, { href: 'https://www.example.com/', resources: ['https://umami-abc.vercel.app/script.js'] })
  )
  assert.equal(umami.has('Vercel'), false)
})

test('第三方服务、监控 SDK、CDN 和自定义规则仍按外站资源识别', async () => {
  const found = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/',
      images: [
        'https://res.cloudinary.com/demo/image/upload/sample.jpg',
        'https://stats.example.org/matomo.php?idsite=1&rec=1',
        'https://cdn.jsdelivr.net/gh/someone/assets@main/a.png',
        'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg/1f600.svg',
        // npm 方式接入 ARMS 时只有信标请求
        'https://arms-retcode.aliyuncs.com/r.png?t=pv&times=1&page=www.example.com%2F&pid=abc%40123'
      ]
    })
  )
  for (const name of ['Cloudinary', 'Matomo / Piwik', 'jsDelivr', 'twemoji', 'Alibaba ARMS / 前端 APM']) assert.ok(found.has(name), name)
  // 网站程序列表里的统计类规则按规则自己的类别处理
  const matomo = names(
    await runPageDetector(loadPageRules(['page/php-ecosystem-assets.json']), {
      href: 'https://www.example.com/',
      images: ['https://stats.example.org/matomo.php?idsite=1&rec=1']
    })
  )
  assert.ok(
    [...matomo].some(name => /matomo/i.test(name)),
    [...matomo].join(', ')
  )
  // 自定义规则的分类只用于展示，不影响匹配
  const custom = names(
    await runPageDetector(
      {
        customRules: [{ name: 'Friend Widget', category: '前端框架', patterns: ['friend\\.example\\.org/widget/'] }]
      },
      { href: 'https://www.example.com/', images: ['https://friend.example.org/widget/a.png'] }
    )
  )
  assert.ok(custom.has('Friend Widget'))
})

// 每个身份类别各取一条规则：外站被动资源命中不算；同样的路径放到本站、或主机特征出现在页面执行的资源上，照常识别
const identityCases = [
  [
    '主题 / 模板',
    'page/wordpress-themes.json',
    'Twenty Twenty-Five',
    { images: ['https://blog.friend.example.org/wp-content/themes/twentytwentyfive/assets/avatar.png'] }
  ],
  [
    '网站源码线索',
    'page/wordpress-plugins.json',
    'Akismet Anti-spam: Spam Protection',
    { images: ['https://blog.friend.example.org/wp-content/plugins/akismet/_inc/img/logo-a-2x.png'] }
  ],
  [
    'CMS / 电商平台',
    'page/website-programs-page.json',
    'Wix',
    { images: ['https://static.wixstatic.com/media/a1b2c3_mv2.png'] },
    { resources: ['https://static.wixstatic.com/services/wix-thunderbolt/dist/main.js'] }
  ],
  [
    '网站程序',
    'page/website-programs-extra.json',
    'Blogger',
    { images: ['https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEi9x/s200/avatar.jpg'] },
    { resources: ['https://www.blogger.com/static/v1/widgets/2975350028-widgets.js'] }
  ],
  [
    '网站程序',
    'page/website-programs-extra.json',
    'Hashnode',
    { images: ['https://cdn.hashnode.com/res/hashnode/image/upload/v1/abc.png'] },
    { href: 'https://hashnode.com/', images: ['https://cdn.hashnode.com/res/hashnode/image/upload/v1/abc.png'] }
  ],
  [
    '开发语言 / 运行时',
    'page/languages.json',
    'Java / JVM',
    { html: '<a href="https://friend.example.org/blog/index.jsp;jsessionid=a1b2c3">a</a>' }
  ],
  ['开发语言 / 运行时', 'page/languages.json', 'Python', { images: ['https://friend.example.org/static/admin/img/avatar.png'] }],
  [
    'UI / CSS 框架',
    'page/ui-frameworks.json',
    'Element UI / Element Plus',
    { images: ['https://friend.example.org/static/element-ui/logo.png'] }
  ],
  ['前端库', 'page/frontend-extra.json', 'MathJax', { images: ['https://friend.example.org/images/mathjax-logo.png'] }],
  ['构建与运行时', 'page/build-runtime.json', 'SystemJS', { images: ['https://friend.example.org/uploads/systemjs-logo.png'] }],
  [
    '后端 / 服务器框架',
    'page/backend-hints-page.json',
    'Struts',
    { html: '<a href="https://friend.example.org/login.action?from=friends">a</a>' }
  ],
  ['探针 / 监控', 'page/admin-panels-page.json', 'OpenWrt LuCI', { images: ['https://friend.example.org/luci-static/bootstrap/logo.png'] }],
  ['RSS / 订阅', 'page/feeds.json', 'Atom Feed', { html: '<a href="https://friend.example.org/atom.xml">feed</a>' }]
]

test('每个身份类别都不拿外站被动资源当本站证据', async () => {
  const toOwn = value => value.replace(/https:\/\/[^/"]+/g, 'https://www.example.com')
  for (const [category, file, name, fixture, ownFixture] of identityCases) {
    const pageRules = loadPageRules([file])
    const foreign = await runPageDetector(pageRules, { href: 'https://www.example.com/friends/', ...fixture })
    assert.equal(names(foreign).has(name), false, `${category} ${name}`)
    const own = await runPageDetector(pageRules, {
      href: 'https://www.example.com/friends/',
      ...(ownFixture || {
        ...(fixture.images ? { images: fixture.images.map(toOwn) } : {}),
        ...(fixture.html ? { html: toOwn(fixture.html) } : {})
      })
    })
    assert.ok(names(own).has(name), `${category} ${name} 本站`)
  }
})

test('公共包 CDN 上执行过的包不让整个 CDN 归本站', async () => {
  const found = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/',
      resources: ['https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js'],
      images: ['https://cdn.jsdelivr.net/gh/friend/blog@main/wp-content/uploads/2024/01/avatar.png']
    })
  )
  assert.equal(found.has('WordPress'), false)
})

test('跨可注册域的 fetch / XHR 按外站请求处理，同站子域照常识别', async () => {
  const pageRules = loadPageRules(['page/backend-hints-page.json'])
  const crossSite = names(
    await runPageDetector(pageRules, {
      href: 'https://www.example-shop.com/',
      entries: [{ name: 'https://api.example-backend.com/shop/goodsList.action?page=1', initiatorType: 'xmlhttprequest' }]
    })
  )
  assert.equal(crossSite.has('Struts'), false)
  const sameSite = names(
    await runPageDetector(pageRules, {
      href: 'https://www.example-shop.com/',
      entries: [{ name: 'https://api.example-shop.com/shop/goodsList.action?page=1', initiatorType: 'xmlhttprequest' }]
    })
  )
  assert.ok(sameSite.has('Struts'))
})

test('主题目录、私有 CDN 和主题样式表只看本站资源', async () => {
  const result = await runPageDetectorResult(rules, {
    href: 'https://www.example.com/',
    images: ['https://cdn.friend.example.org/wp-content/themes/sakura/avatar.png', 'https://www.example.com/wp-content/themes/argon/a.png']
  })
  const found = names(result.technologies)
  assert.ok(found.has('WordPress 主题: argon'))
  assert.equal(found.has('WordPress 主题: sakura'), false)
  assert.deepEqual([...result.resources.themeAssetUrls], ['https://www.example.com/wp-content/themes/argon/a.png'])
  const privateCdn = await runPageDetector(rules, { href: 'https://www.example.com/', images: ['https://cdn.example.com/a.png'] })
  assert.ok(names(privateCdn).has('自定义 / 私有 CDN'))
  // 公共包 CDN 不是私有 CDN
  const packageCdn = await runPageDetector(rules, {
    href: 'https://www.example.com/',
    resources: ['https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/js/bootstrap.bundle.min.js']
  })
  assert.equal(names(packageCdn).has('自定义 / 私有 CDN'), false)
  // 跨可注册域的图片主机不报私有 CDN：友链头像主机不再误报，代价是站点自有的跨域图床（如 ruanyifeng.com 的 cdn.beekka.com）也不报
  const foreignCdn = await runPageDetector(rules, { href: 'https://www.example.com/', images: ['https://cdn.friend.example.org/a.png'] })
  assert.equal(names(foreignCdn).has('自定义 / 私有 CDN'), false)
})

test('动态快照里的外站被动资源不算本站技术栈', async () => {
  const detect = await loadDynamicSnapshotDetector()
  const friends = names(
    detect(
      createDynamicSnapshot({
        url: 'https://www.yeqing.net/friends/',
        resources: [
          ...friendAvatars,
          'https://friend.example.org/wp-content/themes/sakura/a.png',
          'https://waline-xyz.vercel.app/api/comment',
          'https://www.yeqing.net/api/proxy?url=https://friend.example.org/wp-content/themes/sakura/data.json'
        ]
      }),
      rules
    )
  )
  for (const name of ['Next.js', 'WordPress', 'PHP', 'WordPress 主题: sakura', 'Vercel']) assert.equal(friends.has(name), false, name)
  const own = names(
    detect(
      createDynamicSnapshot({
        url: 'https://www.example.com/',
        resources: [
          'https://friend.example.org/_next/data/abc/index.json',
          'https://www.example.com/_next/static/chunks/a.js',
          'https://www.example.com/wp-content/themes/argon/a.png'
        ]
      }),
      rules
    )
  )
  for (const name of ['Next.js', 'WordPress', 'WordPress 主题: argon']) assert.ok(own.has(name), name)
  const foreignChunk = names(
    detect(
      createDynamicSnapshot({ url: 'https://www.example.com/', resources: ['https://assets.example-cdn.net/_next/static/chunks/main.js'] }),
      rules
    )
  )
  assert.ok(foreignChunk.has('Next.js'))
})

test('动态快照里页面执行的脚本、样式表和 wasm 照常识别', async () => {
  const detect = await loadDynamicSnapshotDetector()
  const packageScripts = ['https://unpkg.com/alpinejs', 'https://cdn.jsdelivr.net/npm/@unocss/runtime']
  const executed = names(
    detect(
      createDynamicSnapshot({
        url: 'https://www.example.com/',
        scripts: [...packageScripts, 'https://assets.example-cdn.net/_next/static/chunks/app'],
        resources: [
          ...packageScripts,
          'https://assets.example-cdn.net/_next/static/chunks/app',
          'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm'
        ]
      }),
      rules
    )
  )
  for (const name of ['Alpine.js', 'UnoCSS', 'Next.js', 'WebAssembly']) assert.ok(executed.has(name), name)
  // 别人部署在 Vercel 上的脚本照样执行，但不是本站托管
  const umami = names(
    detect(
      createDynamicSnapshot({
        url: 'https://www.example.com/',
        scripts: ['https://umami-abc.vercel.app/script.js'],
        resources: ['https://umami-abc.vercel.app/script.js']
      }),
      rules
    )
  )
  assert.equal(umami.has('Vercel'), false)
  // 统计、监控这类第三方服务列表不限制外站请求
  const beacon = names(
    detect(
      createDynamicSnapshot({ url: 'https://www.example.com/', resources: ['https://arms-retcode.aliyuncs.com/r.png?t=pv&pid=abc'] }),
      rules
    )
  )
  assert.ok(beacon.has('Alibaba ARMS / 前端 APM'))
})

test('动态监控采集计时条目：跳过图片、字体等被动条目，按脚本加载的条目记成脚本', async () => {
  const entries = [
    { name: 'https://www.tblase.cn/_next/image?url=%2Fimages%2Favatar.jpg&w=256&q=75', initiatorType: 'img' },
    { name: 'https://friend.example.org/_next/image?url=%2Favatar.jpg&w=64&q=75', initiatorType: 'image' },
    { name: 'https://friend.example.org/wp-content/uploads/2024/11/a.png', initiatorType: 'fetch' },
    { name: 'https://fonts.gstatic.com/s/inter/v1/a.woff2', initiatorType: 'css' },
    { name: 'https://www.example.com/_next/static/chunks/app.js', initiatorType: 'script' },
    { name: 'https://esm.sh/react-dom@18', initiatorType: 'script' },
    { name: 'https://api.example.com/v1/posts', initiatorType: 'fetch' }
  ]
  const messages = []
  const later = (callback, ms) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  }
  class StubPerformanceObserver {
    constructor(callback) {
      this.callback = callback
    }
    observe() {
      this.callback({ getEntries: () => entries })
    }
    disconnect() {}
  }
  const preload = { href: 'https://www.example.com/_next/static/chunks/preloaded.js' }
  const window = {
    addEventListener() {},
    removeEventListener() {},
    setTimeout: later,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    PerformanceObserver: StubPerformanceObserver
  }
  const context = {
    window,
    document: {
      scripts: [],
      title: '',
      querySelectorAll: selector => (selector.includes('modulepreload') ? [preload] : [])
    },
    location: { href: 'https://www.example.com/' },
    history: { pushState() {}, replaceState() {} },
    localStorage: { getItem: () => null },
    performance: { getEntriesByType: () => entries },
    PerformanceObserver: StubPerformanceObserver,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Node: { ELEMENT_NODE: 1 },
    chrome: {
      runtime: {
        id: 'stackprism-test',
        sendMessage(message, callback) {
          messages.push(message)
          callback?.()
        }
      }
    },
    setTimeout: later,
    clearTimeout,
    console
  }
  vm.createContext(context)
  vm.runInContext(
    transformSync(readFileSync(path.join(repoRoot, 'src/content/content-observer.ts'), 'utf8'), { loader: 'ts' }).code,
    context
  )
  await new Promise(resolve => setTimeout(resolve, 500))
  const { snapshot } = messages.at(-1)
  assert.deepEqual(
    [...snapshot.resources],
    [
      'https://www.example.com/_next/static/chunks/preloaded.js',
      'https://www.example.com/_next/static/chunks/app.js',
      'https://esm.sh/react-dom@18',
      'https://api.example.com/v1/posts'
    ]
  )
  assert.deepEqual(
    [...snapshot.scripts],
    [
      'https://www.example.com/_next/static/chunks/preloaded.js',
      'https://www.example.com/_next/static/chunks/app.js',
      'https://esm.sh/react-dom@18'
    ]
  )
})

test('WordPress 主题样式表只从本站资源推出，不请求外站', async () => {
  const { detectWordPressThemeStylesFromPage } = await loadTsModule('src/background/wordpress.ts')
  const requested = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async url => {
    requested.push(String(url))
    return new Response('/*\nTheme Name: Argon\nVersion: 1.3.5\n*/', { headers: { 'content-type': 'text/css' } })
  }
  try {
    const technologies = await detectWordPressThemeStylesFromPage({
      url: 'https://www.example.com/',
      resources: {
        images: ['https://friend.example.org/wp-content/themes/sakura/avatar.png'],
        all: [
          'https://friend.example.org/wp-content/themes/sakura/avatar.png',
          'https://www.example.com/cdn-cgi/image/width=64/https://friend.example.org/wp-content/themes/hexo/avatar.png'
        ],
        stylesheets: ['https://www.example.com/wp-content/themes/argon/dist/main.css']
      }
    })
    assert.deepEqual(requested, ['https://www.example.com/wp-content/themes/argon/style.css'])
    assert.deepEqual(
      technologies.map(technology => technology.name),
      ['WordPress 主题: Argon']
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('外站链接的路径带 .js、括号或不带 scheme 时照样按外站判断', async () => {
  const frontend = loadPageRules(['page/frontend-extra.json'])
  const links = names(
    await runPageDetector(frontend, {
      href: 'https://www.example.com/posts/charts/',
      html: '<html><body><a href="https://www.npmjs.com/package/chart.js">npm</a><a href="https://github.com/chartjs/Chart.js">GitHub</a></body></html>'
    })
  )
  assert.equal(links.has('Chart.js'), false)
  const parens = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/friends/',
      images: [
        'https://friend.example.org/(2024)/wp-content/uploads/avatar.png',
        "https://friend.example.org/joe's/wp-content/uploads/a.png"
      ]
    })
  )
  for (const name of ['WordPress', 'PHP']) assert.equal(parens.has(name), false, name)
  // Mastodon 评论组件插入的状态：前缀放进隐藏的 span，正文只显示主机和路径
  const mastodon = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/posts/hello/',
      html: '<html><body><div class="comment"><a href="https://www.tblase.cn/_next/image?url=%2Fi"><span class="invisible">https://www.</span><span class="ellipsis">tblase.cn/_next/image?url=%2Fi</span></a></div></body></html>'
    })
  )
  assert.equal(mastodon.has('Next.js'), false)
})

test('规则命中从属性名起步时也按属性值里的地址判断：llms.txt、Symphony', async () => {
  const pageRules = loadPageRules(['page/website-programs-page.json'])
  const foreign = names(
    await runPageDetector(pageRules, {
      href: 'https://www.example.com/posts/llms-txt-intro/',
      html: '<html><body><a href="https://docs.vendor-example.com/llms.txt">llms.txt</a></body></html>'
    })
  )
  assert.equal(foreign.has('llms.txt'), false)
  const own = names(
    await runPageDetector(pageRules, { href: 'https://www.example.com/', html: '<html><body><a href="/llms.txt">llms</a></body></html>' })
  )
  assert.ok(own.has('llms.txt'))
  const symphony = names(
    await runPageDetector(loadPageRules(['page/website-programs-extra.json']), {
      href: 'https://www.example.com/posts/forums/',
      html: '<html><body><a href="https://github.com/88250/symphony" target="_blank">Symphony</a></body></html>'
    })
  )
  assert.equal(symphony.has('Symphony'), false)
})

test('大友链页上 Flask 规则只在 URL 记号内匹配', async () => {
  const pageRules = loadPageRules(['page/backend-hints-page.json'])
  const avatars = Array.from({ length: 200 }, (_, index) => `<img src="https://friend${index}.example.org/static/avatar.png">`).join('')
  const friends = names(
    await runPageDetector(pageRules, {
      href: 'https://www.example.com/friends/',
      html: `<html><body>${avatars}<p>标签：flask</p></body></html>`
    })
  )
  assert.equal(friends.has('Flask'), false)
  const own = names(
    await runPageDetector(pageRules, {
      href: 'https://www.example.com/',
      html: '<html><head><script src="/static/vendor/flask-moment.js"></script></head><body></body></html>'
    })
  )
  assert.ok(own.has('Flask'))
})

test('只有先行断言的组合规则不随资源顺序变', async () => {
  const pageRules = loadPageRules(['page/website-programs-extra.json'])
  const html = '<html><head><title>聚合登录 - 接口测试</title></head><body><input name="alipayment"></body></html>'
  for (const images of [
    ['https://api.qrserver.com/v1/create-qr-code/?data=abc'],
    ['https://api.qrserver.com/v1/create-qr-code/?data=abc', 'https://login.example.com/logo.png'],
    ['https://login.example.com/logo.png', 'https://api.qrserver.com/v1/create-qr-code/?data=abc']
  ]) {
    const found = names(await runPageDetector(pageRules, { href: 'https://login.example.com/user/test.php', html, images }))
    assert.ok(found.has('彩虹聚合登录'), images.join(' '))
  }
})

test('无头站点：页面预加载的图片在平台主机上时，平台识别照常；分享图、图标和单张预加载图不算本站声明', async () => {
  const shopify = loadPageRules(['page/website-programs.json'])
  const products = [
    'https://cdn.shopify.com/s/files/1/0098/8822/products/a.jpg',
    'https://cdn.shopify.com/s/files/1/0098/8822/products/b.jpg'
  ]
  // gymshark 这类无头店铺：首屏几张图的 preload 只写 imagesrcset，地址是协议相对的
  const srcset = name =>
    `//cdn.shopify.com/s/files/1/0098/8822/files/${name}.jpg?width=375 375w, //cdn.shopify.com/s/files/1/0098/8822/files/${name}.jpg?width=750 750w`
  const headless = names(
    await runPageDetector(shopify, {
      href: 'https://www.shop.example.com/',
      resources: ['https://www.shop.example.com/_next/static/chunks/main.js'],
      preloadImages: [
        { href: '', imagesrcset: srcset('hero') },
        { href: '', imagesrcset: srcset('tile') }
      ],
      images: products
    })
  )
  assert.ok(headless.has('Shopify'))
  const friendShop = names(await runPageDetector(shopify, { href: 'https://www.example.com/friends/', images: products }))
  assert.equal(friendShop.has('Shopify'), false)
  // 转载页把原文配图写进 og:image 和图标
  const repost = names(
    await runPageDetector(shopify, {
      href: 'https://www.example.com/news/repost-123.html',
      html: `<html><head><meta property="og:image" content="${products[0]}"><link rel="icon" href="${products[1]}"></head><body><img src="${products[0]}"></body></html>`,
      images: products
    })
  )
  assert.equal(repost.has('Shopify'), false)
  // WP Rocket 自动给首屏大图加的 preload：转载页那张是外站图
  const lcp = names(
    await runPageDetector(shopify, {
      href: 'https://www.example.com/2024/05/repost/',
      resources: ['https://www.example.com/wp-content/themes/own/style.css'],
      preloadImages: [products[0]],
      images: products
    })
  )
  assert.equal(lcp.has('Shopify'), false)
  // Hexo NexT 把正文里每张图都写成 og:image：友链头像在 Blogger 图床上
  const avatar = 'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEh/s320/avatar.png'
  const programs = loadPageRules(['page/website-programs-extra.json'])
  const hexo = names(
    await runPageDetector(programs, {
      href: 'https://blog.example.com/friends/',
      html: `<html><head><meta property="og:image" content="https://blog.example.com/images/a.png"><meta property="og:image" content="${avatar}"></head><body><img src="${avatar}"></body></html>`,
      images: [avatar]
    })
  )
  assert.equal(hexo.has('Blogger'), false)
  // Next.js 友链页给首屏头像加 priority：只预加载了这一张
  const priority = names(
    await runPageDetector(programs, {
      href: 'https://blog.example.com/friends/',
      resources: ['https://blog.example.com/_next/static/chunks/main.js'],
      preloadImages: [avatar],
      images: [avatar]
    })
  )
  assert.equal(priority.has('Blogger'), false)
  // 同一张头像的多条 preload 只算一张：React 19 下 Pages Router 会再自动输出一条，自定义 loader 两处 priority 只差宽度参数
  const loader = width => `https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEh/s320/avatar.png?w=${width}`
  for (const preloadImages of [
    [avatar, avatar],
    [
      { href: '', imagesrcset: `${loader(32)} 1x, ${loader(64)} 2x` },
      { href: '', imagesrcset: `${loader(640)} 640w, ${loader(750)} 750w` }
    ]
  ]) {
    const duplicated = names(
      await runPageDetector(programs, {
        href: 'https://blog.example.com/friends/',
        resources: ['https://blog.example.com/_next/static/chunks/main.js'],
        preloadImages,
        images: [avatar]
      })
    )
    assert.equal(duplicated.has('Blogger'), false, JSON.stringify(preloadImages))
  }
  // freeCodeCamp News：Eleventy 前端，只有封面图在 Hashnode；页脚署名照常识别
  const footer = names(
    await runPageDetector(loadPageRules(['page/website-programs-extra.json', 'page/powered-by-fallback.json']), {
      href: 'https://www.freecodecamp.org/news/',
      images: ['https://cdn.hashnode.com/uploads/covers/5e1e335a7a1d3fcc59028c64/a.png'],
      html: '<html><body><a href="https://hashnode.com/" data-test-label="powered-by"> Publication powered by Hashnode </a></body></html>'
    })
  )
  assert.ok(footer.has('Hashnode'))
})

test('WP Rocket、LiteSpeed、WP Meteor 延迟执行的脚本算页面的脚本', async () => {
  const extra = loadPageRules(['page/frontend-extra.json'])
  const gsap = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js'
  const chart = '//cdn.example-cdn.net/libs/chart.umd.min.js?ver=4.4.1'
  const html = `<html><head><script type="rocketlazyloadscript" data-rocket-src="${gsap}"></script><script type="litespeed/javascript" data-src="${chart.replace('?', '?a=1&amp;')}"></script></head><body></body></html>`
  const delayed = names(
    await runPageDetector(extra, {
      href: 'https://www.example.com/',
      html,
      delayedScripts: [{ 'data-rocket-src': gsap }, { 'data-src': chart.replace('?', '?a=1&') }]
    })
  )
  assert.ok(delayed.has('GSAP'))
  assert.ok(delayed.has('Chart.js'))
  // 同样的地址只出现在链接里：不是本站执行的脚本
  const linked = names(
    await runPageDetector(extra, {
      href: 'https://www.example.com/',
      html: `<html><body><a href="${gsap}">gsap</a><a href="https:${chart}">chart</a></body></html>`
    })
  )
  assert.equal(linked.has('GSAP'), false)
  assert.equal(linked.has('Chart.js'), false)
  // 只按资源识别的 jQuery、只在脚本里出现的插件目录也从延迟脚本里认
  const wordpress = await runPageDetectorResult(rules, {
    href: 'https://www.example.com/',
    delayedScripts: [
      { 'data-wpmeteor-src': '/wp-includes/js/jquery/jquery.min.js?ver=3.7.1' },
      { 'data-rocketlazyloadscript': '/wp-content/plugins/acme-gallery-pro/assets/js/front.min.js' },
      // Perfmatters 的内联脚本：值只是标记
      { 'data-rocketlazyloadscript': '1' }
    ]
  })
  const found = names(wordpress.technologies)
  assert.ok(found.has('jQuery'))
  assert.ok([...found].some(name => /acme-gallery-pro/.test(name)))
  assert.ok(wordpress.resources.scripts.includes('https://www.example.com/wp-includes/js/jquery/jquery.min.js?ver=3.7.1'))
  assert.equal(wordpress.resources.scripts.length, 2)
})

test('页面地址里嵌着的外站地址不进主题目录提取，外站图片代理里嵌着的本站地址照常提取', async () => {
  const found = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/go/?url=https://friend.example.org/wp-content/themes/sakura/screenshot.png'
    })
  )
  assert.equal(
    [...found].some(name => /sakura/i.test(name)),
    false
  )
  const own = names(await runPageDetector(rules, { href: 'https://www.example.com/wp-content/themes/sakura/page.php' }))
  assert.ok([...own].some(name => /sakura/i.test(name)))
  // Optimole 这类外站图片代理：路径里是完整的本站地址
  const proxied = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/blog/',
      images: ['https://mlx.i.optimole.com/cb:x/w:auto/h:auto/q:mauto/https://www.example.com/blog/wp-content/themes/argon/logo.png']
    })
  )
  assert.ok(proxied.has('WordPress 主题: argon'))
})

test('友链页把友站图标按主机名缓存到本站：路径里别人的托管站点不算本站托管', async () => {
  const hostingRules = loadPageRules(['page/cdn-providers-page.json', 'page/website-programs.json'])
  const cached = names(
    await runPageDetector(hostingRules, {
      href: 'https://www.example.com/links/',
      html: '<html><body><img src="/upload/friend.github.io_.png"><p>友链：friend.vercel.app</p></body></html>',
      images: [
        'https://links.example.com/api/file?key=favicons%2Ffriend.github.io.png',
        'https://www.example.com/upload/friend.vercel.app_.png?width=800',
        'https://www.example.com/upload/friend.netlify.app_.png?width=800',
        'https://www.example.com/upload/friend.myshopify.com_.png?width=800'
      ]
    })
  )
  for (const name of ['GitHub Pages', 'Vercel', 'Netlify', 'Shopify']) assert.equal(cached.has(name), false, name)
  // 本站自己在托管平台上照常识别
  const pages = names(
    await runPageDetector(hostingRules, {
      href: 'https://alice.github.io/links/',
      images: ['https://alice.github.io/upload/bob.github.io_.png']
    })
  )
  assert.ok(pages.has('GitHub Pages'))
})

test('Railway、EdgeOne 等托管平台上的别人站点不算本站托管', async () => {
  const hosting = names(
    await runPageDetector(rules, {
      href: 'https://www.example.com/',
      resources: ['https://umami-production-1a2b.up.railway.app/script.js'],
      images: ['https://friend-blog.edgeone.app/avatar.png', 'https://friend40-abc12.ondigitalocean.app/avatar.png']
    })
  )
  for (const name of ['Railway', 'Tencent EdgeOne', 'DigitalOcean App Platform']) assert.equal(hosting.has(name), false, name)
  const own = names(await runPageDetector(rules, { href: 'https://me.up.railway.app/', images: ['https://me.up.railway.app/a.png'] }))
  assert.ok(own.has('Railway'))
  const neighbour = names(
    await runPageDetector(rules, {
      href: 'https://me.up.railway.app/friends/',
      images: ['https://friend.up.railway.app/_next/image?url=a']
    })
  )
  assert.equal(neighbour.has('Next.js'), false)
})

test('主题资源在按预加载认定的可信主机上时，照常请求主题样式表', async () => {
  const result = await runPageDetectorResult(rules, {
    href: 'https://www.example.com/',
    preloads: ['https://static.example-cdn.net/build/entry'],
    images: ['https://static.example-cdn.net/wp-content/themes/argon/images/logo.png']
  })
  assert.deepEqual([...result.resources.themeAssetUrls], ['https://static.example-cdn.net/wp-content/themes/argon/images/logo.png'])
  const { detectWordPressThemeStylesFromPage } = await loadTsModule('src/background/wordpress.ts')
  const requested = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async url => {
    requested.push(String(url))
    return new Response('/*\nTheme Name: Argon\n*/', { headers: { 'content-type': 'text/css' } })
  }
  try {
    await detectWordPressThemeStylesFromPage({ url: 'https://www.example.com/', resources: result.resources })
    assert.deepEqual(requested, ['https://static.example-cdn.net/wp-content/themes/argon/style.css'])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('动态快照：无后缀样式表的主机可信，自定义规则不受类别限制', async () => {
  const detect = await loadDynamicSnapshotDetector()
  const combo = 'https://combo.example-cdn.net/??a.css,b.css'
  const image = 'https://combo.example-cdn.net/wp-content/uploads/a.png'
  const trusted = names(detect(createDynamicSnapshot({ url: 'https://www.example.com/', stylesheets: [combo], resources: [image] }), rules))
  assert.ok(trusted.has('WordPress'))
  const untrusted = names(detect(createDynamicSnapshot({ url: 'https://www.example.com/', resources: [image] }), rules))
  assert.equal(untrusted.has('WordPress'), false)
  const custom = names(
    detect(createDynamicSnapshot({ url: 'https://www.example.com/', resources: ['https://friend.example.org/widget/a.png'] }), {
      customRules: [{ name: 'Friend Widget', category: '前端框架', patterns: ['friend\\.example\\.org/widget/'] }]
    })
  )
  assert.ok(custom.has('Friend Widget'))
  // 资源行里路径带括号的外站地址整条按外站判断
  const parens = names(
    detect(
      createDynamicSnapshot({ url: 'https://www.example.com/', resources: ['https://friend.example.org/(2024)/wp-content/uploads/a.png'] }),
      rules
    )
  )
  assert.equal(parens.has('WordPress'), false)
})

test('动态监控：后插入的 modulepreload 记成页面脚本', async () => {
  const messages = []
  const later = (callback, ms) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  }
  const preloadLink = {
    nodeType: 1,
    tagName: 'LINK',
    isConnected: true,
    id: '',
    className: '',
    href: 'https://www.example.com/_next/static/chunks/late.js',
    rel: 'modulepreload',
    as: '',
    type: '',
    title: '',
    childElementCount: 0,
    matches: selector => selector.includes('modulepreload'),
    getAttribute: () => null,
    hasAttribute: () => false
  }
  class StubMutationObserver {
    constructor(callback) {
      this.callback = callback
    }
    observe() {
      later(() => this.callback([{ addedNodes: [preloadLink] }]), 20)
    }
    disconnect() {}
  }
  const window = {
    addEventListener() {},
    removeEventListener() {},
    setTimeout: later,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {}
  }
  const context = {
    window,
    document: { scripts: [], title: '', querySelectorAll: () => [] },
    location: { href: 'https://www.example.com/' },
    history: { pushState() {}, replaceState() {} },
    localStorage: { getItem: () => null },
    performance: { getEntriesByType: () => [] },
    MutationObserver: StubMutationObserver,
    Node: { ELEMENT_NODE: 1 },
    chrome: {
      runtime: {
        id: 'stackprism-test',
        sendMessage(message, callback) {
          messages.push(message)
          callback?.()
        }
      }
    },
    setTimeout: later,
    clearTimeout,
    console
  }
  vm.createContext(context)
  vm.runInContext(
    transformSync(readFileSync(path.join(repoRoot, 'src/content/content-observer.ts'), 'utf8'), { loader: 'ts' }).code,
    context
  )
  const hasLate = () => messages.some(message => message.snapshot?.scripts?.includes(preloadLink.href))
  for (let waited = 0; waited < 3000 && !hasLate(); waited += 50) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(hasLate(), JSON.stringify(messages.at(-1)?.snapshot?.scripts || []))
})
