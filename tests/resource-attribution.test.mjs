import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import path from 'node:path'
import { loadTsModule, repoRoot } from './helpers/rule-harness.mjs'

const { attributionPolicyOf, createResourceAttribution, hasAttributedMatch } = await loadTsModule('src/utils/resource-attribution.ts')
const { getRegistrableDomain, isHostingTenantHost, isSameSite } = await loadTsModule('src/utils/domain.ts')

const BACKSLASH = String.fromCharCode(92)
const jsonEscaped = url => url.replaceAll('/', `${BACKSLASH}/`)
const unicodeEscaped = url => url.replaceAll('/', `${BACKSLASH}u002f`)

const IDENTITY_CATEGORIES = [
  '前端框架',
  'UI / CSS 框架',
  '前端库',
  '构建与运行时',
  'Web 服务器',
  '后端 / 服务器框架',
  '开发语言 / 运行时',
  '网站程序',
  '主题 / 模板',
  '网站源码线索',
  '探针 / 监控',
  'CMS / 电商平台',
  'RSS / 订阅',
  '智能体浏览'
]

const page = 'https://www.example.com/friends/'
const attribution = createResourceAttribution(page, [
  'https://unpkg.com/alpinejs',
  'https://static.example-cdn.net/app.js',
  'https://cdn.jsdelivr.net/combine/npm/a,npm/b?x=1&y=2',
  'https://umami-abc.vercel.app/script.js'
])
// accepts：页面源码里的命中；acceptsResource：单条资源 URL 上的命中
const accepts = (pattern, text, policy = 'identity') => hasAttributedMatch(pattern, text, attribution, policy)
const acceptsResource = (pattern, url, policy = 'identity', target = attribution) =>
  hasAttributedMatch(pattern, url, target, policy, url.length)
const elapsed = run => {
  const started = performance.now()
  const value = run()
  return { value, ms: performance.now() - started }
}

test('类别决定外站资源能否作为证据：身份类、托管类和服务类', () => {
  for (const category of IDENTITY_CATEGORIES) assert.equal(attributionPolicyOf(category), 'identity', category)
  assert.equal(attributionPolicyOf('CDN / 托管'), 'hosting')
  for (const category of [
    '统计 / 分析',
    'SaaS / 第三方服务',
    '第三方登录 / OAuth',
    '支付系统',
    '广告 / 营销',
    'AI / 大模型',
    '其他库',
    ''
  ]) {
    assert.equal(attributionPolicyOf(category), 'service', category)
  }
  // 类别名写错就会悄悄退回服务类，这里和界面的分类翻译表对一遍
  const locale = readFileSync(path.join(repoRoot, 'src/i18n/locales/en.ts'), 'utf8')
  const categoryMap = locale.slice(locale.indexOf('categoryMap: {'), locale.indexOf('sourceMap: {'))
  for (const category of [...IDENTITY_CATEGORIES, 'CDN / 托管']) {
    assert.ok(categoryMap.includes(`'${category}':`) || categoryMap.includes(`\n    ${category}:`), category)
  }
})

test('命中按所在的 URL 判断：外站被动地址拒绝，本站、相对地址和正文接受', () => {
  assert.equal(accepts(/_next\/image/, '<img src="https://friend.example.org/_next/image?url=a">'), false)
  assert.equal(accepts(/_next\/image/, '<img src="HTTPS://FRIEND.EXAMPLE.ORG/_next/image?url=a">'), false)
  assert.equal(accepts(/_next\/image/, '<img src="https://user:pass@friend.example.org:8443/_next/image">'), false)
  assert.equal(accepts(/_next\/image/, '<img src="/_next/image?url=a">'), true)
  assert.equal(accepts(/_next\/image/, '<p>_next/image</p>'), true)
  assert.equal(accepts(/_next\/image/, '<img src="https://cdn.example.com/_next/image">'), true)
  assert.equal(accepts(/_next\/image/, '<img src="https://www.example.com:8443/_next/image">'), true)
})

test('协议相对、srcset 逗号和查询参数里的地址都能找到主机', () => {
  assert.equal(accepts(/_next\/image/, '<img src="//friend.example.org/_next/image">'), false)
  assert.equal(accepts(/_next\/image/, '<img srcset="/own.png 1x,//friend.example.org/_next/image?url=a 2x">'), false)
  assert.equal(accepts(/_next\/image/, '<img src="/proxy?url=//friend.example.org/_next/image">'), false)
  assert.equal(accepts(/_next\/image/, '<img src="/proxy?url=https://friend.example.org/_next/image">'), false)
  assert.equal(accepts(/_next\/image/, '<img src="https://friend.example.org/proxy?url=/_next/image">'), false)
})

test('命中从 scheme、冒号或双斜杠开始时归到后面的主机', () => {
  const foreign = '<img src="https://friend.example.org/_next/image?url=a">'
  assert.equal(accepts(/:\/\/[^/]+\/_next\//, foreign), false)
  assert.equal(accepts(/https:\/\/[^/]+\/_next\//, foreign), false)
  assert.equal(accepts(/ttps:\/\/[^/]+\/_next\//, foreign), false)
  assert.equal(accepts(/\/\/[^/]+\/_next\//, foreign), false)
  assert.equal(accepts(/:\/\/[a-z0-9-]+\.vercel\.app/, '<img src="https://friend.vercel.app/a.png">', 'hosting'), false)
  assert.equal(accepts(/:\/\/[^/]+\/_next\//, '<img src="https://cdn.example.com/_next/image">'), true)
})

test('JSON 转义、\\u002F 转义和百分号编码的外站地址照样按外站判断', () => {
  const avatar = 'https://friend.example.org/zb_users/upload/2024/01/a.png'
  assert.equal(accepts(/zb_users/, `<script>window.friends=[{"avatar":"${jsonEscaped(avatar)}"}]</script>`), false)
  assert.equal(accepts(/zb_users/, `<script>window.friends=[{"avatar":"${unicodeEscaped(avatar)}"}]</script>`), false)
  assert.equal(accepts(/zb_users/, `<script>window.skin="${jsonEscaped('/zb_users/theme/own/style.css')}"</script>`), true)
  const proxied = `https://www.example.com/_next/image?url=${encodeURIComponent(avatar)}&w=64&q=75`
  assert.equal(acceptsResource(/zb_users/, proxied), false)
  assert.equal(acceptsResource(/_next\/image/, proxied), true)
})

test('outerHTML 转义成 &quot; 的引号是记号边界', () => {
  const quoted = value => `<div data-config="${value.replaceAll('"', '&quot;')}">`
  assert.equal(accepts(/zb_users/, quoted('{"avatar":"https://friend.example.org/a.png","skin":"/zb_users/theme/own/style.css"}')), true)
  assert.equal(accepts(/_next\//, quoted('{"home":"https://friend.example.org","img":"/_next/static/media/a.png"}')), true)
  assert.equal(accepts(/_next\//, quoted('{"img":"https://friend.example.org/_next/static/media/a.png"}')), false)
})

test('超长 URL 和大量外站命中：整段只扫一遍，后面的本站命中照样找到', () => {
  assert.equal(accepts(/\/wp-content\//, `<img src="https://friend.example.org/${'a'.repeat(5000)}/wp-content/a.png">`), false)
  const foreign = '<img src="https://friend.example.org/_next/image?u=1">'.repeat(3000)
  assert.equal(accepts(/_next\/image/, `${foreign}<img src="/_next/image?u=2">`), true)
  assert.equal(accepts(/_next\/image/, foreign), false)
})

test('分号密集、没有 & 的长记号向前找起点不退化', () => {
  const { value, ms } = elapsed(() => accepts(/_next\/image/, `<p>${'a;'.repeat(50000)}https://friend.example.org/_next/image</p>`))
  assert.equal(value, false)
  assert.ok(ms < 500, `${ms.toFixed(1)}ms`)
  const semicolons = elapsed(() => accepts(/_next/, `<p>${'a;'.repeat(50000)}_next</p>`))
  assert.equal(semicolons.value, true)
  assert.ok(semicolons.ms < 500, `${semicolons.ms.toFixed(1)}ms`)
})

test('ownPart 扫嵌套地址是线性的：带上千个 =// 的地址不卡', () => {
  const crafted = `https://www.example.com/x.css?${'a=//;'.repeat(4000)}`
  const { value, ms } = elapsed(() => attribution.ownPart(crafted))
  assert.equal(value, crafted)
  assert.ok(ms < 300, `${ms.toFixed(1)}ms`)
  const nestedMany = `https://www.example.com/r?${'u=//www.example.com/a&'.repeat(3000)}u=//friend.example.org/wp-content/a.png`
  const nested = elapsed(() => attribution.ownPart(nestedMany))
  assert.ok(nested.value.endsWith('u='), nested.value.slice(-40))
  assert.ok(nested.ms < 300, `${nested.ms.toFixed(1)}ms`)
})

test('零宽命中（只有先行断言的组合正则）不按 URL 判断，结果不随资源顺序变', () => {
  const pattern = /^(?=[\s\S]*聚合登录)(?=[\s\S]*alipayment)/
  const text = 'https://api.qrserver.com/v1/create-qr-code/?data=abc\nhttps://www.example.com/logo.png\n<p>聚合登录 alipayment</p>'
  assert.equal(hasAttributedMatch(pattern, text, attribution, 'identity', text.indexOf('\n<p>')), true)
  assert.equal(accepts(/(?=_next)/, '<img src="https://friend.example.org/_next/image?u=1">'), true)
})

test('页面执行的资源整条算本站，执行它的主机也算；公共包 CDN 主机除外', () => {
  assert.equal(acceptsResource(/alpinejs/, 'https://unpkg.com/alpinejs'), true)
  assert.equal(accepts(/alpinejs/, '<script src="//unpkg.com/alpinejs"></script>'), true)
  assert.equal(accepts(/npm\/b/, '<script src="https://cdn.jsdelivr.net/combine/npm/a,npm/b?x=1&amp;y=2"></script>'), true)
  assert.equal(acceptsResource(/alpinejs/, 'https://unpkg.com/alpinejs@3/dist/logo.png'), false)
  assert.equal(acceptsResource(/\/wp-content\//, 'https://static.example-cdn.net/wp-content/uploads/a.png'), true)
  assert.equal(acceptsResource(/\/wp-content\//, 'https://unpkg.com/friend-theme/wp-content/a.png'), false)
  // 公共包 CDN 上锚定主机的命中接受：路径就是包名
  assert.equal(
    acceptsResource(/cdnjs\.cloudflare\.com\/ajax\/libs\/twemoji\//, 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg/1f600.svg'),
    true
  )
  assert.equal(acceptsResource(/blogger\.googleusercontent\.com/, 'https://blogger.googleusercontent.com/img/a/avatar.png'), false)
  // 资源 URL 以脚本、样式表、wasm 结尾就算执行
  assert.equal(acceptsResource(/\.wasm/, 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm'), true)
  assert.equal(acceptsResource(/_next\/static/, 'https://assets.friend-cdn.net/_next/static/chunks/main.js'), true)
})

test('源码里路径以 .js / .css 结尾的外站链接不算执行过的资源', () => {
  assert.equal(accepts(/chart\.js/i, '<a href="https://www.npmjs.com/package/chart.js">链接</a>'), false)
  assert.equal(accepts(/three\.js/i, '<a href="https://github.com/mrdoob/three.js">three</a>'), false)
  assert.equal(accepts(/pixi\.js/i, '<a href="https://www.npmjs.com/package/pixi.js">pixi</a>'), false)
  // 页面执行过的那一条在源码里照样算
  const executedChart = createResourceAttribution(page, ['https://cdn.example-cdn.org/libs/chart.js'])
  assert.equal(
    hasAttributedMatch(/chart\.js/i, '<script src="https://cdn.example-cdn.org/libs/chart.js"></script>', executedChart, 'identity'),
    true
  )
})

test('资源 URL 整条是一个记号：路径里未编码的括号和引号不切开外站地址', () => {
  for (const url of [
    'https://friend.example.org/(2024)/wp-content/uploads/avatar.png',
    "https://friend.example.org/joe's/wp-content/uploads/avatar.png",
    'https://friend.example.org/gallery(1)/_next/image?url=%2Fa.png&w=64'
  ]) {
    assert.equal(acceptsResource(/wp-content|_next\/image/, url), false, url)
    assert.equal(attribution.ownPart(url), '', url)
  }
  // 拼接文本里资源段按资源判断，后面的页面源码照常按括号切分
  const resourcesText = 'https://friend.example.org/(2024)/wp-content/uploads/avatar.png'
  const text = `${resourcesText}\n<div style="background:url(/wp-content/themes/own/bg.png)"></div>`
  assert.equal(hasAttributedMatch(/wp-content/, text, attribution, 'identity', resourcesText.length), true)
  assert.equal(hasAttributedMatch(/wp-content/, `${resourcesText}\n<p>a</p>`, attribution, 'identity', resourcesText.length), false)
})

test('页面文字里不带 scheme 的外站地址按外站判断', () => {
  // Mastodon 评论把 https://www. 放进隐藏的 span，正文只显示主机和路径
  const mastodon =
    '<a href="https://www.tblase.cn/_next/image?url=%2Fi"><span class="invisible">https://www.</span><span class="ellipsis">tblase.cn/_next/image?url=%2Fi</span></a>'
  assert.equal(accepts(/_next\/image/, mastodon), false)
  assert.equal(accepts(/usr\/themes/, '<p>friend.example.org/usr/themes/handsome/</p>'), false)
  assert.equal(accepts(/_next\/image/, '<p>www.tblase.cn/_next/image</p>'), false)
  assert.equal(accepts(/_next\/image/, '<p>www.example.com/_next/image</p>'), true)
  // 相对路径不当成主机
  assert.equal(accepts(/index\.php\/home/, '<a href="index.php/home/index">a</a>'), true)
  assert.equal(accepts(/_next\//, '<script src="app.min.js/_next/x"></script>'), true)
})

test('源码里按 Unicode 写的国际化域名和 punycode 的页面地址对得上', () => {
  const idn = createResourceAttribution('https://www.xn--fsqu00a.xn--fiqs8s/', [])
  assert.equal(hasAttributedMatch(/\.action/, '<form action="https://www.例子.中国/login.action">', idn, 'identity'), true)
  assert.equal(hasAttributedMatch(/\.action/, '<form action="https://www.xn--fsqu00a.xn--fiqs8s/login.action">', idn, 'identity'), true)
  assert.equal(hasAttributedMatch(/\.action/, '<form action="https://bücher.de/login.action">', idn, 'identity'), false)
  const umlaut = createResourceAttribution('https://www.xn--bcher-kva.de/', [])
  assert.equal(hasAttributedMatch(/\.jsp/, '<a href="https://www.bücher.de/news/list.jsp">a</a>', umlaut, 'identity'), true)
})

test('按路径分租户的存储主机执行过脚本，不让同主机别人的文件归本站', () => {
  const storage = createResourceAttribution(page, [
    'https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-window.prod.umd.js',
    'https://s3.amazonaws.com/downloads.mailchimp.com/js/mc-validate.js',
    'https://own-bucket.s3.amazonaws.com/app.js'
  ])
  for (const url of [
    'https://storage.googleapis.com/friend-blog-media/wp-content/uploads/2024/11/df.png',
    'https://s3.amazonaws.com/friend-bucket/wp-content/uploads/a.png',
    'https://s3.us-east-1.amazonaws.com/friend-bucket/wp-content/uploads/a.png'
  ]) {
    assert.equal(acceptsResource(/wp-content/, url, 'identity', storage), false, url)
  }
  // 按子域分租户的桶（主机就是那个桶）照常信任
  assert.equal(acceptsResource(/wp-content/, 'https://own-bucket.s3.amazonaws.com/wp-content/a.png', 'identity', storage), true)
})

test('页面预加载图片的主机：锚定主机的命中算本站，路径命中不算', () => {
  const declared = createResourceAttribution(
    'https://www.shop.example.com/',
    [],
    ['https://cdn.shopify.com/s/files/1/0098/8822/files/og.jpg']
  )
  const image = 'https://cdn.shopify.com/s/files/1/0098/8822/products/a.jpg'
  assert.equal(acceptsResource(/cdn\.shopify\.com/, image, 'identity', declared), true)
  assert.equal(acceptsResource(/cdn\.shopify\.com/, image), false)
  assert.equal(acceptsResource(/wp-content/, 'https://cdn.shopify.com/friend/wp-content/a.png', 'identity', declared), false)
})

test('ownPart：外站被动资源返回空串，本站地址里嵌着的外站地址截掉', () => {
  assert.equal(attribution.ownPart('https://friend.example.org/a.png'), '')
  assert.equal(attribution.ownPart('https://www.example.com/a.png'), 'https://www.example.com/a.png')
  assert.equal(attribution.ownPart('/relative/a.png'), '/relative/a.png')
  assert.equal(
    attribution.ownPart('https://www.example.com/cdn-cgi/image/width=64/https://friend.example.org/wp-content/themes/sakura/a.png'),
    'https://www.example.com/cdn-cgi/image/width=64/'
  )
  assert.equal(attribution.ownPart('https://www.example.com/proxy?url=//friend.example.org/a.png'), 'https://www.example.com/proxy?url=')
  assert.equal(
    attribution.ownPart('https://www.example.com/_next/image?url=https%3A%2F%2Ffriend.example.org%2Fa.png&w=64'),
    'https://www.example.com/_next/image?url='
  )
  assert.equal(
    attribution.ownPart('https://www.example.com/r?to=https://cdn.example.com/a.png'),
    'https://www.example.com/r?to=https://cdn.example.com/a.png'
  )
  assert.equal(attribution.ownPart('https://unpkg.com/alpinejs'), 'https://unpkg.com/alpinejs')
  assert.equal(createResourceAttribution('about:blank').ownPart('https://friend.example.org/a.png'), 'https://friend.example.org/a.png')
})

test('CDN / 托管只认锚定主机的命中，别人的租户站点一律不算', () => {
  assert.equal(acceptsResource(/_vercel/, 'https://friend.example.org/_vercel/image?url=%2Favatar.png&w=128', 'hosting'), false)
  assert.equal(acceptsResource(/cloudfront\.net/, 'https://d111.cloudfront.net/a.png', 'hosting'), true)
  assert.equal(acceptsResource(/vercel\.app/, 'https://friend.vercel.app/a.png', 'hosting'), false)
  // 页面执行了别人租户上的脚本（自建 Umami 之类）：算本站代码，但不是本站托管
  assert.equal(acceptsResource(/vercel\.app/, 'https://umami-abc.vercel.app/script.js', 'hosting'), false)
  assert.equal(acceptsResource(/umami/, 'https://umami-abc.vercel.app/script.js'), true)
  assert.equal(acceptsResource(/railway\.app/, 'https://umami-production-1a2b.up.railway.app/script.js', 'hosting'), false)
  assert.equal(acceptsResource(/edgeone\.app/, 'https://friend-blog.edgeone.app/avatar.png', 'hosting'), false)
  assert.equal(acceptsResource(/ondigitalocean\.app/, 'https://friend40-abc12.ondigitalocean.app/avatar.png', 'hosting'), false)
  const tenant = createResourceAttribution('https://alice.vercel.app/', [])
  assert.equal(acceptsResource(/vercel\.app/, 'https://alice.vercel.app/a.png', 'hosting', tenant), true)
  assert.equal(acceptsResource(/vercel\.app/, 'https://bob.vercel.app/a.png', 'hosting', tenant), false)
})

test('服务类和没有主机的页面不做限制', () => {
  assert.equal(acceptsResource(/matomo\.php/, 'https://stats.example.org/matomo.php?idsite=1', 'service'), true)
  const none = createResourceAttribution('about:blank')
  assert.equal(hasAttributedMatch(/_next/, '<img src="https://friend.example.org/_next/image">', none, 'identity'), true)
})

test('托管平台租户和免费二级域名按独立站点判断同站', () => {
  assert.equal(getRegistrableDomain('alice.github.io'), 'alice.github.io')
  assert.equal(getRegistrableDomain('static.example.co.uk'), 'example.co.uk')
  assert.equal(getRegistrableDomain('alice.eu.org'), 'alice.eu.org')
  assert.equal(getRegistrableDomain('cdn.alice.us.kg'), 'alice.us.kg')
  assert.equal(isSameSite('https://bob.github.io/a.png', 'https://alice.github.io/'), false)
  assert.equal(isSameSite('https://cdn.alice.github.io/a.png', 'https://alice.github.io/'), true)
  assert.equal(isSameSite('https://bob.eu.org/a.png', 'https://alice.eu.org/'), false)
  assert.equal(isHostingTenantHost('friend.vercel.app'), true)
  assert.equal(isHostingTenantHost('vercel.app'), false)
  assert.equal(isHostingTenantHost('alice.eu.org'), false)
})

test('多段私有后缀按最长后缀取可注册域：eu.org 子区、Railway、Azure 区域段和更多免费二级域名', () => {
  assert.equal(getRegistrableDomain('bob.us.eu.org'), 'bob.us.eu.org')
  assert.equal(isSameSite('https://bob.us.eu.org/a.png', 'https://alice.us.eu.org/'), false)
  assert.equal(isSameSite('https://bob.fr.eu.org/a.png', 'https://alice.fr.eu.org/'), false)
  assert.equal(isSameSite('https://bob.cloudns.ch/a.png', 'https://alice.cloudns.ch/'), false)
  assert.equal(isSameSite('https://bob.xx.kg/a.png', 'https://alice.xx.kg/'), false)
  assert.equal(getRegistrableDomain('friend.up.railway.app'), 'friend.up.railway.app')
  assert.equal(isSameSite('https://friend.up.railway.app/a.png', 'https://me.up.railway.app/'), false)
  assert.equal(isHostingTenantHost('friend.up.railway.app'), true)
  assert.equal(isHostingTenantHost('friend-blog.edgeone.app'), true)
  assert.equal(isHostingTenantHost('friend40-abc12.ondigitalocean.app'), true)
  assert.equal(
    isSameSite('https://black-pond-0a1b2c3d4.4.azurestaticapps.net/a.png', 'https://white-sand-5e6f7a8b9.4.azurestaticapps.net/'),
    false
  )
  assert.equal(isSameSite('https://a-1b2c.eastus-01.azurewebsites.net/a.png', 'https://b-3d4e.eastus-01.azurewebsites.net/'), false)
  assert.equal(isHostingTenantHost('a-1b2c.eastus-01.azurewebsites.net'), true)
  assert.equal(getRegistrableDomain('www.example.com.cn'), 'example.com.cn')
  assert.equal(getRegistrableDomain('eu.org'), 'eu.org')
})

test('只编码冒号、双重 JSON 转义、十六进制转义和 HTML 实体斜杠的外站地址照样按外站判断', () => {
  const avatar = 'https://friend.example.org/zb_users/upload/2024/01/a.png'
  const slashes = replacement => avatar.replaceAll('/', replacement)
  for (const text of [
    `<a href="/go?url=${avatar.replace('https:', 'https%3A')}">a</a>`,
    `<a href="/go?url=${avatar.replace('https:', 'https%3a')}">a</a>`,
    `<script>var a="${slashes(`${BACKSLASH}${BACKSLASH}${BACKSLASH}/`)}"</script>`,
    `<script>var a="${slashes(`${BACKSLASH}x2f`)}"</script>`,
    `<noscript><img src="${slashes('&#x2f;')}"></noscript>`,
    `<noscript><img src="${slashes('&#47;')}"></noscript>`,
    `<noscript><img src="${slashes('&sol;')}"></noscript>`
  ]) {
    assert.equal(accepts(/zb_users/, text), false, text)
  }
  assert.equal(accepts(/zb_users/, '<a href="/go?url=https%3A//www.example.com/zb_users/theme/a.css">a</a>'), true)
  assert.equal(
    accepts(/zb_users/, `<noscript><img src="${'https://www.example.com/zb_users/a.png'.replaceAll('/', '&#x2f;')}"></noscript>`),
    true
  )
  // 命中从 scheme 起步时也认这些写法
  assert.equal(accepts(/https%3a\/\/[^/]+\/zb_users/i, `<a href="/go?url=${avatar.replace('https:', 'https%3A')}">a</a>`), false)
})

test('不带 scheme 的外站地址：任意顶级域，紧跟中文、全角冒号或 &nbsp; 也认得出主机', () => {
  for (const text of [
    '<p>网站图标：friend.example.org/zb_users/upload/2024/01/avatar.png</p>',
    '<p>头像&nbsp;friend.example.org/usr/themes/handsome/a.png</p>',
    '<p>头像&#160;friend.example.org/usr/themes/handsome/a.png</p>',
    '<p>friend.im/usr/themes/handsome/a.png</p>',
    '<p>friend.ren/zb_users/upload/a.png</p>',
    '<p>blog.friend.social/_next/image?url=%2Fa.png</p>',
    '<p>www.xn--fsqu00a.xn--55qx5d/usr/themes/a.png</p>'
  ]) {
    assert.equal(accepts(/zb_users|usr\/themes|_next\/image/, text), false, text)
  }
  assert.equal(accepts(/zb_users/, '<p>本站：www.example.com/zb_users/theme/a.css</p>'), true)
  assert.equal(accepts(/zb_users/, '<p>主题目录zb_users/theme/a.css</p>'), true)
  // 文件后缀不当顶级域
  assert.equal(accepts(/home\/index/, '<p>说明：index.php/home/index</p>'), true)
  assert.equal(accepts(/_next\//, '<p>见app.min.js/_next/x</p>'), true)
  // 内联脚本里形如「对象.属性/」的记号不是地址：命中在干净的主机和路径之外
  assert.equal(accepts(/window\.jQuery/, '<script>function f(e){return e.length/2+window.jQuery}</script>'), true)
  assert.equal(accepts(/webpackChunk/, '<script>x(Math.PI/180+self.webpackChunk_N_E)</script>'), true)
  assert.equal(accepts(/webpackChunk/, '<p>中文e.length/2+self.webpackChunk_N_E</p>'), true)
})

test('Mastodon 把长主机拆进几个 span：按外层链接的 href 判断', () => {
  const host = 'blog.averylongfriendsitename.com'
  const path = '/_next/image?url=%2Fa.png&amp;w=64'
  const mastodon = `<p><a href="https://${host}${path}" rel="nofollow noopener" translate="no" target="_blank"><span class="invisible">https://</span><span class="ellipsis">${host.slice(0, 30)}</span><span class="invisible">${host.slice(30)}${path}</span></a></p>`
  assert.equal(accepts(/_next\/image/, mastodon), false)
  // 本站相对链接、href 里没有的文字照常算
  assert.equal(accepts(/_next\/image/, '<a href="/_next/image?url=a">/_next/image?url=a</a>'), true)
  assert.equal(accepts(/_next\/image/, '<a href="https://friend.example.org/">见 /_next/image</a>'), true)
  assert.equal(accepts(/_next\/image/, '<a href="https://friend.example.org/_next/image"></a><p>/_next/image</p>'), true)
})

test('jsDelivr、cdnjs 镜像执行过脚本，不让镜像上别人的文件归本站', () => {
  const mirror = createResourceAttribution(page, [
    'https://cdn.jsdmirror.com/npm/jquery@3.7.1/dist/jquery.min.js',
    'https://lf3-cdn-tos.bytecdntp.com/cdn/expire-1-M/vue/3.2.31/vue.global.prod.min.js',
    'https://s4.zstatic.net/ajax/libs/twikoo/1.6.39/twikoo.all.min.js'
  ])
  for (const url of [
    'https://cdn.jsdmirror.com/gh/friend/site-backup@main/usr/themes/handsome/a.png',
    'https://lf3-cdn-tos.bytecdntp.com/cdn/expire-1-M/friend/usr/themes/a.png',
    'https://s4.zstatic.net/friend/usr/themes/a.png'
  ]) {
    assert.equal(acceptsResource(/usr\/themes/, url, 'identity', mirror), false, url)
  }
  assert.equal(acceptsResource(/jquery/, 'https://cdn.jsdmirror.com/npm/jquery@3.7.1/dist/jquery.min.js', 'identity', mirror), true)
})

test('构造的超长点分主机：后缀查找只看末尾几段，不按段数平方增长', () => {
  const labels = 'a.'.repeat(20000)
  const registrable = elapsed(() => getRegistrableDomain(`${labels}example.co.uk`))
  assert.equal(registrable.value, 'example.co.uk')
  assert.ok(registrable.ms < 100, `${registrable.ms.toFixed(1)}ms`)
  assert.equal(isHostingTenantHost(`${labels}friend.vercel.app`), true)
  const text = `<a href="//${labels}friend.org/wp-content/plugins/woocommerce/cart.js">a</a>`.repeat(3)
  const rejected = elapsed(() => accepts(/wp-content\/plugins\/woocommerce/, text))
  assert.equal(rejected.value, false)
  assert.ok(rejected.ms < 300, `${rejected.ms.toFixed(1)}ms`)
})

test('本站地址路径里、正文里别人托管站点的主机名不算本站证据', () => {
  for (const url of [
    'https://www.example.com/upload/friend.github.io_.png',
    'https://links.example.com/api/file?key=favicons%2Ffriend.github.io.png',
    'https://www.example.com/upload/friend.vercel.app_.png?width=800'
  ]) {
    assert.equal(acceptsResource(/github\.io|vercel\.app/, url, 'hosting'), false, url)
  }
  assert.equal(acceptsResource(/myshopify\.com/, 'https://www.example.com/upload/friend.myshopify.com_.png'), false)
  assert.equal(accepts(/github\.io/, '<img src="/upload/friend.github.io_.png">', 'hosting'), false)
  assert.equal(accepts(/vercel\.app/, '<p>友链：friend.vercel.app</p>', 'hosting'), false)
  // 本站路径里的平台信号、本站自己的托管主机照常算
  assert.equal(acceptsResource(/_vercel\/insights/, 'https://www.example.com/_vercel/insights/script.js', 'hosting'), true)
  assert.equal(acceptsResource(/\.netlify\//, 'https://www.example.com/.netlify/functions/a', 'hosting'), true)
  const tenant = createResourceAttribution('https://alice.github.io/', [])
  assert.equal(acceptsResource(/github\.io/, 'https://alice.github.io/upload/alice.github.io_.png', 'hosting', tenant), true)
  assert.equal(hasAttributedMatch(/alice\.github\.io/, '<p>alice.github.io</p>', tenant, 'hosting'), true)
  assert.equal(getRegistrableDomain('shop.myshopify.com'), 'shop.myshopify.com')
})

test('外站图片代理里嵌着的本站地址：ownPart 取本站那段，再嵌外站地址时截掉', () => {
  assert.equal(
    attribution.ownPart('https://mlx.i.optimole.com/cb:x/w:auto/q:mauto/https://www.example.com/wp-content/themes/argon/a.png'),
    'https://www.example.com/wp-content/themes/argon/a.png'
  )
  assert.equal(
    attribution.ownPart('https://res.cloudinary.com/demo/image/fetch/https://www.example.com/a.png?next=https://friend.example.org/b.png'),
    'https://www.example.com/a.png?next='
  )
  assert.equal(attribution.ownPart('https://res.cloudinary.com/demo/image/fetch/https://friend.example.org/a.png'), '')
  // 嵌套地址前紧挨 %3D（双层代理、跳转参数）：从 scheme 开始截，截断处不留半个转义
  assert.equal(
    attribution.ownPart(
      'https://wsrv.nl/?url=https%3A%2F%2Fproxy.example.net%2F%3Fu%3Dhttps%3A%2F%2Fwww.example.com%2Fwp-content%2Fuploads%2Fa.png'
    ),
    'https%3A%2F%2Fwww.example.com%2Fwp-content%2Fuploads%2Fa.png'
  )
  assert.equal(
    attribution.ownPart(
      'https://www.example.com/go?url=https%3A%2F%2Fwww.example.com%2Fa.png%3Fnext%3Dhttps%3A%2F%2Ffriend.example.org%2F'
    ),
    'https://www.example.com/go?url=https%3A%2F%2Fwww.example.com%2Fa.png%3Fnext%3D'
  )
})

test('页面执行的脚本参数里的店铺主机算本站证据；正文、JSON 和托管类照旧不算', () => {
  const script = 'https://cdn.judge.me/widget_preloader.js?shop=acme-store.myshopify.com'
  const store = createResourceAttribution('https://www.acme.com/', [script])
  assert.equal(acceptsResource(/myshopify\.com/, script, 'identity', store), true)
  assert.equal(hasAttributedMatch(/myshopify\.com/, `<script src="${script}"></script>`, store, 'identity'), true)
  assert.equal(
    hasAttributedMatch(/myshopify\.com/, '<script>{"permanentDomain":"acme-store.myshopify.com"}</script>', store, 'identity'),
    false
  )
  assert.equal(acceptsResource(/myshopify\.com/, 'https://www.acme.com/upload/friend.myshopify.com_.png', 'identity', store), false)
  // jsDelivr 上执行过的 /gh/用户/用户.github.io：常是引用别人的仓库，不算本站托管
  const repo = 'https://cdn.jsdelivr.net/gh/acme/acme.github.io@main/js/utils.js'
  assert.equal(acceptsResource(/github\.io/, repo, 'hosting', createResourceAttribution('https://blog.acme.com/', [repo])), false)
})

test('未收录的公共包镜像：按 /npm/、/gh/、/ajax/libs/、包@版本 的路径形态认，不让整个主机归本站', () => {
  const mirrors = createResourceAttribution(page, [
    'https://cdn1.tianli0.top/npm/jquery@3.7.1/dist/jquery.min.js',
    'https://jsd.012700.xyz/gh/user/repo@main/js/main.js',
    'https://cdnjs.loli.net/ajax/libs/vue/3.4.0/vue.global.prod.min.js',
    'https://npm.example-mirror.net/vue@3.4.0/dist/vue.global.js',
    'https://static.example-cdn.net/js/app.js'
  ])
  for (const url of [
    'https://cdn1.tianli0.top/gh/friend/site@main/usr/themes/handsome/a.png',
    'https://jsd.012700.xyz/gh/friend/blog@main/wp-content/uploads/a.png',
    'https://cdnjs.loli.net/friend/usr/themes/a.png',
    'https://npm.example-mirror.net/friend-theme@1.0.0/usr/themes/a.png'
  ]) {
    assert.equal(acceptsResource(/usr\/themes|wp-content/, url, 'identity', mirrors), false, url)
  }
  assert.equal(acceptsResource(/wp-content/, 'https://static.example-cdn.net/wp-content/uploads/a.png', 'identity', mirrors), true)
})

test('ColdFusion、ASP.NET 服务这类相对路径首段不当成主机', () => {
  assert.equal(accepts(/coldfusion/, '<a href="index.cfm/tag/coldfusion">a</a>'), true)
  assert.equal(accepts(/\/default/, '<a href="webservice.asmx/default">a</a>'), true)
  assert.equal(accepts(/\/news/, '<a href="index.shtml/news">a</a>'), true)
})

test('同一个 <a> 里大量带路径的记号：锚点和 href 主机只解析一次', () => {
  const host = `${Array.from({ length: 1000 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('')}.com`
  const anchor = `<a href="https://${host}/x/_next/y">${'<b>/_next/</b>'.repeat(40)}</a>`
  const { value, ms } = elapsed(() => accepts(/_next/, anchor.repeat(75)))
  assert.equal(value, false)
  assert.ok(ms < 500, `${ms.toFixed(1)}ms`)
})

test('脚本字符串里大量没闭合的 <a>：闭合标签只在窗口内找；</abbr> 不当成 </a>', () => {
  const cards = Array.from({ length: 8000 }, (_, i) => `'<a href="https://f${i}.example.org/_next/x">/_next/x<${BACKSLASH}/a>'`).join(',')
  const text = `<script>var cards=[${cards}];</script>${'<p>正文</p>'.repeat(40000)}<a href="/">首页</a>`
  const { value, ms } = elapsed(() => accepts(/_next\//, text))
  assert.equal(value, false)
  assert.ok(ms < 400, `${ms.toFixed(1)}ms`)
  const abbr =
    '<a href="https://friend.example.org/usr/themes/handsome/a.png"><abbr title="x">FE</abbr><span>usr/themes/handsome/a.png</span></a>'
  assert.equal(accepts(/usr\/themes/, abbr), false)
})
