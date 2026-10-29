import { getRegistrableDomain, isHostingTenantHost } from '@/utils/domain'

// 外站被动资源（跨站的图片、请求、iframe，以及页面源码里指向外站的链接）不在页面里执行，
// 只能说明页面用了哪个外部服务，说明不了本站自己的技术栈。规则按类别分三种处理：
// identity：本站技术栈，外站被动资源一律不算，公共包 CDN 和页面预加载图片的主机上锚定主机的命中除外；
// hosting：CDN / 托管，只认锚定主机的命中，托管平台上的别人站点除外；
// service：第三方服务本来就靠外站主机和路径识别，不限制
export type AttributionPolicy = 'identity' | 'hosting' | 'service'

const IDENTITY_CATEGORIES = new Set([
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
])

export const attributionPolicyOf = (category: unknown): AttributionPolicy => {
  const value = String(category || '')
  if (IDENTITY_CATEGORIES.has(value)) return 'identity'
  if (value === 'CDN / 托管') return 'hosting'
  return 'service'
}

// 公共包 CDN 及其镜像：路径属于各个包，主机不代表某个站点
const PACKAGE_CDN_HOSTS = new Set(
  `cdn.jsdelivr.net fastly.jsdelivr.net gcore.jsdelivr.net testingcf.jsdelivr.net quantil.jsdelivr.net
   unpkg.com esm.sh esm.run cdn.skypack.dev jspm.dev ga.jspm.io cdnjs.cloudflare.com ajax.googleapis.com
   ajax.aspnetcdn.com code.jquery.com stackpath.bootstrapcdn.com maxcdn.bootstrapcdn.com cdn.bootcdn.net
   cdn.bootcss.com cdn.staticfile.net cdn.staticfile.org lib.baomitu.com cdn.baomitu.com cdn.npmmirror.com
   registry.npmmirror.com npm.elemecdn.com unpkg.zhimg.com rawcdn.githack.com raw.githack.com rawgit.com
   cdn.rawgit.com gitcdn.xyz gitcdn.link bundle.run cdn.pika.dev cdn.statically.io cdn.staticaly.com
   cdn.jsdmirror.com cdn.jsdmirror.cn jsd.cdn.zzko.cn jsd.onmicrosoft.cn npm.onmicrosoft.cn cdn.cbd.int
   mirrors.sustech.edu.cn`
    .split(/\s+/)
    .filter(Boolean)
)
// 带编号的镜像主机：字节跳动静态资源库 lf3-cdn-tos.bytecdntp.com、Zstatic s4.zstatic.net
const PACKAGE_CDN_HOST_PATTERN = /^(?:lf\d+-cdn-tos\.bytecdntp\.com|s\d+\.zstatic\.net)$/

export const isPackageCdnHost = (host: string): boolean => PACKAGE_CDN_HOSTS.has(host) || PACKAGE_CDN_HOST_PATTERN.test(host)

// 按路径分租户的公共存储：每个桶 / 仓库归不同的人，页面执行过其中一个文件不代表整个主机归本站
const PATH_TENANT_HOSTS = new Set(
  `storage.googleapis.com firebasestorage.googleapis.com raw.githubusercontent.com gist.githubusercontent.com
   objects.githubusercontent.com media.githubusercontent.com user-images.githubusercontent.com res.cloudinary.com`
    .split(/\s+/)
    .filter(Boolean)
)
// S3 路径式地址：s3.amazonaws.com/桶、s3.区域.amazonaws.com/桶、s3-区域.amazonaws.com/桶
const S3_PATH_HOST = /^s3[.-](?:[a-z0-9-]+\.)*amazonaws\.com(?:\.cn)?$/

const isSharedPathHost = (host: string): boolean => isPackageCdnHost(host) || PATH_TENANT_HOSTS.has(host) || S3_PATH_HOST.test(host)

// 资源 URL 以脚本、样式表和 WebAssembly 结尾：页面执行了它，来源不影响归属。
// 只用于资源 URL；页面源码里的链接（npm 包页 chart.js、GitHub 仓库 three.js）要整条对上执行过的资源才算
const EXECUTED_PATH = /\.(?:m?js|cjs|css|wasm)$/i
const EXECUTED_SUFFIX_LENGTH = 6

// 页面源码里 URL 记号的边界：空白、引号、尖括号、圆括号、花括号，以及 outerHTML 里转义成实体的引号和尖括号。
// 资源 URL 逐行列出，只按空白切分：路径里未编码的括号和引号属于 URL
const SOURCE_DELIMITER = /[\s"'`<>(){}]/
const RESOURCE_DELIMITER = /\s/
const DELIMITER_ENTITY = '&(?:quot|apos|lt|gt|#0*(?:34|39|60|62)|#x0*(?:22|27|3c|3e));'
const ENTITY_AHEAD = new RegExp(`^${DELIMITER_ENTITY}`, 'i')
const ENTITY_BEHIND = new RegExp(`${DELIMITER_ENTITY}$`, 'i')
const MAX_ENTITY_LENGTH = 10

// 向后找主机、路径和记号的终点：主机到路径、查询、片段、JSON 转义的斜杠、百分号编码或参数分隔为止；
// 路径到查询、片段或参数分隔为止（嵌在查询参数里的地址没有自己的 ?）。全局正则一次定位，不逐字符判断
interface Scanners {
  host: RegExp
  path: RegExp
  token: RegExp
}
const RESOURCE_SCAN: Scanners = { host: /[/?#\\%&,;\s]/g, path: /[?#&\s]/g, token: /\s/g }
const SOURCE_SCAN: Scanners = {
  host: /[/?#\\%&,;\s"'`<>(){}]/g,
  path: /[?#&\s"'`<>(){}]/g,
  token: new RegExp(`[\\s"'\`<>(){}]|${DELIMITER_ENTITY}`, 'gi')
}

const scanTo = (text: string, from: number, pattern: RegExp): number => {
  pattern.lastIndex = from
  return pattern.exec(text)?.index ?? text.length
}

// 主机前的标记：//，JSON 转义和双重转义的斜杠，Unicode、十六进制转义的斜杠，HTML 实体斜杠，百分号编码的 %2F%2F
const MARKER = /^(?:\/\/|\\\/\\\/|\\\\\\\/\\\\\\\/|\\u002[f]\\u002[f]|\\x2[f]\\x2[f]|&#x0*2f;&#x0*2f;|&#0*47;&#0*47;|&sol;&sol;|%2f%2f)/i
const MAX_MARKER_LENGTH = 24
// 命中从 scheme 或冒号开始（https://…、https%3A//…、%3A%2F%2F…）时，主机标记在命中之后
const SCHEME_AHEAD = new RegExp(`^[a-z0-9+.-]*(?::|%3a)(?=${MARKER.source.slice(1)})`, 'i')
// 页面文字里不带 scheme 的地址（链接卡片、Mastodon 截断显示的 tblase.cn/_next/image…）：从「域名/」开始的按该主机判断。
// 顶级域任意，排除常见文件后缀，index.php/、app.min.js/、index.cfm/ 这类相对路径不当成主机
const BARE_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?!(?:php|[jpsx]?html?|aspx?|as[hm]x|axd|svc|jspx?|jsf|do|action|cgi|cfml?|nsf|[cm]?js|jsx|tsx?|s?css|less|json|xml|txt|png|jpe?g|gif|webp|avif|svg|ico|map|vue|wasm|woff|ttf|otf|eot|pdf|webm|zip|gz)(?::\d+)?\/)(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})(?::\d+)?(?=\/)/i
const BARE_HOST_WINDOW = 300
// 不带 scheme 的地址只到干净的主机和路径为止（字母数字和 . _ ~ % / @ : -）：
// 内联脚本里 e.length/2+window.jQuery 这类记号不当成地址，命中在干净部分之外就不按主机判断
const BARE_URL_END = /[^\w.~%/@:-]/g
const NBSP_BEHIND = /&(?:nbsp|#0*160|#x0*a0);$/i
const NON_ASCII = /[^\x00-\x7f]/
// Mastodon 截断显示的链接：可见文字只剩主机后半段和路径（om/_next/image…），按外层 <a> 的 href 判断
const ANCHOR_WINDOW = 4096
const HREF_ATTRIBUTE = /\shref=(?:"([^"]*)"|'([^']*)')/i

interface UrlSpan {
  host: string
  hostEnd: number
  pathEnd: number
  tokenStart: number
  tokenEnd: number
}

const isTokenEndAt = (text: string, index: number, resource: boolean): boolean => {
  const char = text[index]
  if (resource) return RESOURCE_DELIMITER.test(char)
  return SOURCE_DELIMITER.test(char) || (char === '&' && ENTITY_AHEAD.test(text.slice(index, index + MAX_ENTITY_LENGTH)))
}

const isTokenStartAt = (text: string, index: number, resource: boolean): boolean => {
  const before = text[index - 1]
  if (resource) return RESOURCE_DELIMITER.test(before)
  if (SOURCE_DELIMITER.test(before)) return true
  return before === ';' && ENTITY_BEHIND.test(text.slice(Math.max(0, index - MAX_ENTITY_LENGTH), index))
}

// 标记前面要紧跟 scheme 的冒号（含 %3A）、查询参数的等号、srcset 的逗号，或者位于记号开头（协议相对地址）；
// %2F%2F 不认记号开头
const markerLengthAt = (text: string, pos: number, tokenStart: number): number => {
  const char = text[pos]
  if (char !== '/' && char !== '\\' && char !== '&' && char !== '%') return 0
  const marker = MARKER.exec(text.slice(pos, pos + MAX_MARKER_LENGTH))
  if (!marker) return 0
  const before = pos > tokenStart ? text[pos - 1] : ''
  const afterScheme = before === ':' || /%3a$/i.test(text.slice(Math.max(tokenStart, pos - 3), pos))
  if (afterScheme || before === '=') return marker[0].length
  if (char === '%') return 0
  return !before || (char === '/' && before === ',') ? marker[0].length : 0
}

// 命中所在的 URL：命中起点往前最近的主机标记，命中从 scheme 开始时取它后面的标记
const findMarker = (text: string, index: number, tokenStart: number): number => {
  const ahead = SCHEME_AHEAD.exec(text.slice(index, index + 40))
  if (ahead && markerLengthAt(text, index + ahead[0].length, tokenStart)) return index + ahead[0].length
  for (let pos = index; pos >= tokenStart; pos -= 1) {
    if (markerLengthAt(text, pos, tokenStart)) return pos
  }
  return -1
}

// 去掉用户信息和端口；源码里按 Unicode 写的国际化域名转成 punycode，和 location 的写法一致。
// 超过 DNS 长度上限的不是真实主机，不做转换
const MAX_HOST_LENGTH = 253
const normalizeHost = (authority: string): string => {
  let host = authority
    .slice(authority.lastIndexOf('@') + 1)
    .replace(/:\d*$/, '')
    .toLowerCase()
  if (NON_ASCII.test(host) && host.includes('.') && host.length <= MAX_HOST_LENGTH) {
    try {
      host = new URL(`http://${host}`).hostname
    } catch {
      // 转不了就按原样比较
    }
  }
  return /[a-z0-9]/.test(host) ? host : ''
}

const toSpan = (text: string, hostStart: number, tokenStart: number, resource: boolean): UrlSpan | null => {
  const scan = resource ? RESOURCE_SCAN : SOURCE_SCAN
  const hostEnd = scanTo(text, hostStart, scan.host)
  const host = normalizeHost(text.slice(hostStart, hostEnd))
  if (!host) return null
  const pathEnd = scanTo(text, hostEnd, scan.path)
  return { host, hostEnd, pathEnd, tokenStart, tokenEnd: scanTo(text, pathEnd, scan.token) }
}

// 不带 scheme 的地址从记号开头、非 ASCII 字符（中文、全角冒号）或 &nbsp; 之后开始，取命中前最近的一处
const isBareHostBoundary = (text: string, pos: number): boolean =>
  text.charCodeAt(pos - 1) > 0x7f || (text[pos - 1] === ';' && NBSP_BEHIND.test(text.slice(Math.max(0, pos - 8), pos)))

const bareUrlSpanAt = (text: string, start: number, index: number): UrlSpan | null =>
  BARE_HOST.test(text.slice(start, start + BARE_HOST_WINDOW)) && index < scanTo(text, start, BARE_URL_END)
    ? toSpan(text, start, start, false)
    : null

const findBareHostSpan = (text: string, index: number, tokenStart: number): UrlSpan | null => {
  const from = Math.max(tokenStart + 1, index - BARE_HOST_WINDOW)
  for (let pos = index; pos >= from; pos -= 1) {
    const span = isBareHostBoundary(text, pos) ? bareUrlSpanAt(text, pos, index) : null
    if (span) return span
  }
  const isRealStart = tokenStart === 0 || isTokenStartAt(text, tokenStart, false)
  return isRealStart ? bareUrlSpanAt(text, tokenStart, index) : null
}

// 记号带路径、又是外层 <a> 的 href 的一段（Mastodon 把地址拆进几个 span）：按 href 的主机判断，相对地址算本站。
// 同一个 <a> 里的多个记号复用上一次找到的锚点，href 只解析一次
interface Anchor {
  text: string
  tagEnd: number
  close: number
  href: string
  host: string
}
let lastAnchor: Anchor | null = null
const CLOSE_ANCHOR = /<\/a[\s>]/

const anchorAt = (text: string, tokenStart: number): Anchor | null => {
  if (lastAnchor && lastAnchor.text === text && lastAnchor.tagEnd < tokenStart && tokenStart < lastAnchor.close) return lastAnchor
  const windowStart = Math.max(0, tokenStart - ANCHOR_WINDOW)
  const offset = text.slice(windowStart, tokenStart).lastIndexOf('<a ')
  if (offset < 0) return null
  const open = windowStart + offset
  const tagEnd = text.indexOf('>', open)
  if (tagEnd < 0 || tagEnd >= tokenStart) return null
  // 闭合标签也只在窗口内找：脚本字符串里写成 <\/a> 的链接不会每次都扫到全文末尾
  const limit = Math.min(text.length, tokenStart + ANCHOR_WINDOW)
  const found = text.slice(tagEnd, limit).search(CLOSE_ANCHOR)
  const closeTag = found < 0 ? limit : tagEnd + found
  if (closeTag < tokenStart) return null
  // 没闭合的 <a> 到下一个 <a 为止
  const nested = text.slice(tagEnd, closeTag).indexOf('<a ')
  const close = nested < 0 ? closeTag : tagEnd + nested
  if (close < tokenStart) return null
  const href = HREF_ATTRIBUTE.exec(text.slice(open, tagEnd))
  const value = href?.[1] ?? href?.[2] ?? ''
  lastAnchor = { text, tagEnd, close, href: value, host: value ? hostOfUrl(value) : '' }
  return lastAnchor
}

const findAnchorSpan = (text: string, index: number, tokenStart: number): UrlSpan | null => {
  const tokenEnd = scanTo(text, index, SOURCE_SCAN.token)
  const token = text.slice(tokenStart, tokenEnd)
  if (!token.includes('/')) return null
  const anchor = anchorAt(text, tokenStart)
  if (!anchor?.host || !anchor.href.includes(token)) return null
  return { host: anchor.host, hostEnd: tokenStart, pathEnd: tokenEnd, tokenStart, tokenEnd }
}

// index 处所在 URL 的主机和路径位置；不在带主机的 URL 里（正文、相对地址）返回 null。
// floor 之前已经扫过、不会和 index 同属一个记号，向前找记号起点到此为止
const findUrlSpan = (text: string, index: number, floor: number, resource: boolean): UrlSpan | null => {
  if (index >= text.length || isTokenEndAt(text, index, resource)) return null
  let tokenStart = index
  while (tokenStart > floor && !isTokenStartAt(text, tokenStart, resource)) tokenStart -= 1
  const marker = findMarker(text, index, tokenStart)
  if (marker >= 0) return toSpan(text, marker + markerLengthAt(text, marker, tokenStart), tokenStart, resource)
  if (resource) return null
  return findBareHostSpan(text, index, tokenStart) || findAnchorSpan(text, index, tokenStart)
}

// 嵌套地址的起点：带 scheme 时从 scheme 开始截，scheme 前紧挨的 %XX（双层代理里的 %3D）不算
const nestedUrlStart = (text: string, marker: number): number => {
  let start = marker
  if (text[marker - 1] === ':') start = marker - 1
  else if (/%3a$/i.test(text.slice(Math.max(0, marker - 3), marker))) start = marker - 3
  else return marker
  while (start > 0 && text[start - 3] !== '%' && /[a-z0-9+.-]/i.test(text[start - 1])) start -= 1
  return start
}

// 比较已执行资源时忽略 scheme、大小写和 HTML / JSON 转义：源码里的 //host/a、&amp; 也能对上
const executedKey = (url: string): string =>
  url
    .toLowerCase()
    .replace(/\\\/|\\u002f/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/^[a-z][a-z0-9+.-]*:(?=\/\/)/, '')

const hostOfUrl = (url: string): string => findUrlSpan(url, 0, 0, true)?.host || ''

// 公共包 CDN 的路径形态（/npm/包@版本、/gh/用户/仓库@版本、/ajax/libs/库/版本、/包@版本/）：
// 未收录的镜像上执行过脚本，也不让整个主机归本站
const PACKAGE_PATH = /^\/(?:npm\/|gh\/|combine\/|ajax\/libs\/|cdnjs\/|(?:@[\w.-]+\/)?[\w.-]+@[\w.^~-]+\/)/i

const isHostCode = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45 || code === 46
const IMAGE_SUFFIX = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$/

interface EmbeddedHost {
  host: string
  end: number
}

// 命中所在的主机名形态片段（字母数字、点、连字符）是托管平台上的租户站点时返回它：
// 友链页把友站图标按主机名缓存到本站（/upload/friend.github.io_.png、?key=favicons%2Ffriend.github.io.png），正文里写的 friend.vercel.app
const embeddedTenantHostAt = (text: string, index: number, from: number, to: number): EmbeddedHost | null => {
  let start = index
  while (start > from && index - start < MAX_HOST_LENGTH && isHostCode(text.charCodeAt(start - 1))) start -= 1
  let end = index
  while (end < to && end - start < MAX_HOST_LENGTH && isHostCode(text.charCodeAt(end))) end += 1
  // 跳过 %2F 这类百分号编码的两位十六进制
  if (text[start - 1] === '%') start += 2
  const host = text.slice(start, end).toLowerCase().replace(IMAGE_SUFFIX, '')
  return host.includes('.') && isHostingTenantHost(host) ? { host, end } : null
}

export interface ResourceAttribution {
  // 资源 URL 里能算作本站证据的部分：本站或页面执行的资源返回整条，外站被动资源返回空串，
  // 本站地址里嵌着外站地址（图片代理、跳转参数）时只保留外站地址之前的部分，外站图片代理里嵌着本站地址时取本站那段
  ownPart(url: string): string
  // 文本 index 处开始的命中能否算作本站证据：能则返回 -1，不能则返回接着找的位置（该 URL 记号或主机名之后）。
  // resourceEnd 之前是逐行列出的资源 URL，之后是页面源码
  rejectMatchAt(text: string, index: number, policy: AttributionPolicy, floor?: number, resourceEnd?: number): number
}

// executedUrls：页面执行的脚本、样式表、预加载脚本和延迟执行的脚本。declaredUrls：页面预加载的首屏图片，
// 主机是页面自己选的图床或平台 CDN（无头电商的商品图在平台主机上）。
// 页面地址解析不出主机时不做区分，保持原来的行为
export const createResourceAttribution = (
  pageUrl: unknown,
  executedUrls: Iterable<string> = [],
  declaredUrls: Iterable<string> = []
): ResourceAttribution => {
  const pageHost = hostOfUrl(String(pageUrl || ''))
  const pageSite = pageHost ? getRegistrableDomain(pageHost) : ''
  const executed = new Set<string>()
  const trustedHosts = new Set<string>()
  for (const url of executedUrls) {
    const value = String(url || '')
    if (!value) continue
    executed.add(executedKey(value))
    const span = findUrlSpan(value, 0, 0, true)
    // 公共包 CDN、按路径分租户的存储上执行过某个文件，不代表同一主机上的其他文件也归本站
    if (span && !isSharedPathHost(span.host) && !PACKAGE_PATH.test(value.slice(span.hostEnd))) trustedHosts.add(span.host)
  }
  const declaredHosts = new Set<string>()
  for (const url of declaredUrls) {
    const host = hostOfUrl(String(url || ''))
    if (host) declaredHosts.add(host)
  }
  const hasExecutedPath = (text: string, span: UrlSpan): boolean =>
    EXECUTED_PATH.test(text.slice(Math.max(span.hostEnd, span.pathEnd - EXECUTED_SUFFIX_LENGTH), span.pathEnd))
  const isOwnSpan = (text: string, span: UrlSpan, resource: boolean): boolean =>
    getRegistrableDomain(span.host) === pageSite || trustedHosts.has(span.host) || (resource && hasExecutedPath(text, span))
  const isExecutedToken = (text: string, span: UrlSpan): boolean => executed.has(executedKey(text.slice(span.tokenStart, span.tokenEnd)))
  // 托管平台上别人的站点：脚本也好、图片也好，都不是本站的托管
  const isForeignTenant = (host: string): boolean => isHostingTenantHost(host) && getRegistrableDomain(host) !== pageSite
  // 命中落在别人托管站点的主机名上时返回该主机名之后的位置，否则返回 -1
  const foreignEmbeddedEnd = (text: string, index: number, from: number, to: number): number => {
    const embedded = embeddedTenantHostAt(text, index, from, to)
    return embedded && getRegistrableDomain(embedded.host) !== pageSite ? Math.max(embedded.end, index + 1) : -1
  }

  // 嵌套地址和外层同属一个记号：就地解析主机，路径终点只会后移，整条只扫一遍。
  // 外站图片代理（Optimole、Cloudinary fetch）里嵌着的本站地址从嵌套处算起，再嵌外站地址时截掉
  const computeOwnPart = (value: string): string => {
    if (executed.has(executedKey(value))) return value
    const span = findUrlSpan(value, 0, 0, true)
    if (!span) return value
    let ownStart = isOwnSpan(value, span, true) ? 0 : -1
    let pathEnd = span.hostEnd
    for (let pos = span.hostEnd; pos < span.tokenEnd; pos += 1) {
      const length = markerLengthAt(value, pos, span.tokenStart)
      if (!length) continue
      const hostEnd = scanTo(value, pos + length, RESOURCE_SCAN.host)
      const host = normalizeHost(value.slice(pos + length, hostEnd))
      if (pathEnd < hostEnd) pathEnd = scanTo(value, hostEnd, RESOURCE_SCAN.path)
      if (host) {
        const own = isOwnSpan(value, { host, hostEnd, pathEnd, tokenStart: span.tokenStart, tokenEnd: span.tokenEnd }, true)
        if (own && ownStart < 0) ownStart = nestedUrlStart(value, pos)
        else if (!own && ownStart >= 0) return value.slice(ownStart, nestedUrlStart(value, pos))
      }
      pos += length - 1
    }
    return ownStart < 0 ? '' : value.slice(ownStart)
  }
  const ownPartCache = new Map<string, string>()

  return {
    ownPart(url) {
      const value = String(url || '')
      if (!pageSite) return value
      let part = ownPartCache.get(value)
      if (part === undefined) {
        part = computeOwnPart(value)
        ownPartCache.set(value, part)
      }
      return part
    },
    rejectMatchAt(text, index, policy, floor = 0, resourceEnd = 0) {
      if (!pageSite || policy === 'service') return -1
      const resource = index < resourceEnd
      const span = findUrlSpan(text, index, floor, resource)
      // 正文、相对地址和本站地址的路径里，命中落在别人托管站点的主机名上也不算
      if (!span) return foreignEmbeddedEnd(text, index, floor, text.length)
      const rejected = Math.max(span.tokenEnd, index + 1)
      if (policy === 'hosting' && isForeignTenant(span.host)) return rejected
      const executedToken = isExecutedToken(text, span)
      if (executedToken || isOwnSpan(text, span, resource)) {
        if (index < span.hostEnd) return -1
        // 页面执行的资源里带的租户主机（应用脚本的 ?shop=店铺.myshopify.com）算本站的；
        // 托管类不放行：jsDelivr /gh/用户/用户.github.io 这类路径常是引用别人的仓库
        if (policy === 'identity' && (executedToken || (resource && hasExecutedPath(text, span)))) return -1
        return foreignEmbeddedEnd(text, index, span.hostEnd, span.tokenEnd) < 0 ? -1 : rejected
      }
      const onHost = index < span.hostEnd
      const accepted = policy === 'hosting' ? onHost : onHost && (isPackageCdnHost(span.host) || declaredHosts.has(span.host))
      return accepted ? -1 : rejected
    }
  }
}

const globalPatternCache = new WeakMap<RegExp, RegExp>()

const toGlobalPattern = (pattern: RegExp): RegExp => {
  let global = globalPatternCache.get(pattern)
  if (!global) {
    global = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'g')
    globalPatternCache.set(pattern, global)
  }
  return global
}

// pattern 在 text 里是否有一处命中能算作本站证据；落在外站被动 URL 上的命中跳过整个 URL 继续找。
// 每次从上一个 URL 记号的结尾接着找，向前找记号起点也不越过它，整段文本只扫一遍。
// resourceEnd：text 开头这么长的部分是逐行列出的资源 URL，单条资源传 text.length，页面源码不传
export const hasAttributedMatch = (
  pattern: RegExp,
  text: string,
  attribution: ResourceAttribution,
  policy: AttributionPolicy,
  resourceEnd = 0
): boolean => {
  if (policy === 'service') {
    pattern.lastIndex = 0
    return pattern.test(text)
  }
  const global = toGlobalPattern(pattern)
  global.lastIndex = 0
  let floor = 0
  for (;;) {
    const match = global.exec(text)
    if (!match) return false
    // 零宽命中（只有先行断言的组合正则）没有落点，不按 URL 判断
    if (!match[0]) return true
    const resumeAt = attribution.rejectMatchAt(text, match.index, policy, floor, resourceEnd)
    if (resumeAt < 0) return true
    global.lastIndex = resumeAt
    floor = resumeAt
  }
}
