// 多级公共后缀（eTLD）表：用于把 a.example.co.uk 这类主机名归并到可注册域 example.co.uk。
// 只收录常见国家/地区的二级后缀，缺失条目会退化成「按末两段判定」——即沿用过滤前的行为，
// 不会造成误判加剧。命中表里的二级后缀时，可注册域取末三段。
const MULTI_LABEL_SUFFIXES = new Set(
  `co.uk org.uk me.uk ltd.uk plc.uk net.uk sch.uk ac.uk gov.uk mod.uk nhs.uk police.uk
   com.cn net.cn org.cn gov.cn edu.cn ac.cn mil.cn ah.cn bj.cn cq.cn fj.cn gd.cn gs.cn gx.cn
   gz.cn ha.cn hb.cn he.cn hi.cn hk.cn hl.cn hn.cn jl.cn js.cn jx.cn ln.cn nm.cn nx.cn qh.cn
   sc.cn sd.cn sh.cn sn.cn sx.cn tj.cn xj.cn xz.cn yn.cn zj.cn mo.cn
   co.jp or.jp ne.jp ac.jp ad.jp ed.jp go.jp gr.jp lg.jp
   co.kr or.kr ne.kr re.kr pe.kr go.kr ac.kr hs.kr ms.kr es.kr sc.kr kg.kr
   com.au net.au org.au edu.au gov.au asn.au id.au
   com.br net.br org.br gov.br edu.br art.br mil.br
   com.hk net.hk org.hk edu.hk gov.hk idv.hk
   com.tw net.tw org.tw edu.tw gov.tw idv.tw game.tw ebiz.tw club.tw
   co.in net.in org.in gen.in firm.in ind.in gov.in ac.in edu.in res.in
   co.za net.za org.za gov.za ac.za web.za
   com.sg net.sg org.sg edu.sg gov.sg per.sg
   com.ru net.ru org.ru msk.ru spb.ru edu.ru gov.ru int.ru ac.ru
   com.mx net.mx org.mx edu.mx gob.mx
   com.tr net.tr org.tr edu.tr gov.tr bel.tr mil.tr k12.tr biz.tr info.tr name.tr
   com.ua net.ua org.ua edu.ua gov.ua in.ua kiev.ua
   com.vn net.vn org.vn edu.vn gov.vn biz.vn info.vn name.vn pro.vn
   com.my net.my org.my edu.my gov.my mil.my name.my
   com.ph net.ph org.ph edu.ph gov.ph
   co.id net.id or.id web.id ac.id sch.id go.id my.id biz.id desa.id
   co.th net.th or.th ac.th go.th in.th mi.th
   co.il net.il org.il ac.il gov.il k12.il muni.il idf.il
   co.nz net.nz org.nz govt.nz ac.nz geek.nz school.nz kiwi.nz gen.nz
   com.pl net.pl org.pl edu.pl gov.pl biz.pl info.pl waw.pl
   com.ar net.ar org.ar edu.ar gob.ar gov.ar int.ar mil.ar tur.ar
   com.co net.co org.co edu.co gov.co mil.co
   com.pk net.pk org.pk edu.pk gov.pk gob.pk
   com.sa net.sa org.sa edu.sa gov.sa med.sa pub.sa sch.sa
   com.eg net.eg org.eg edu.eg gov.eg eun.eg sci.eg
   com.ng net.ng org.ng edu.ng gov.ng
   co.ke ne.ke or.ke ac.ke go.ke sc.ke me.ke info.ke
   com.bd net.bd org.bd edu.bd gov.bd ac.bd
   com.lk net.lk org.lk edu.lk gov.lk ac.lk sch.lk
   com.np net.np org.np edu.np gov.np
   co.ir net.ir org.ir ac.ir gov.ir id.ir sch.ir
   co.ae net.ae org.ae ac.ae gov.ae sch.ae mil.ae
   com.qa net.qa org.qa edu.qa gov.qa mil.qa sch.qa
   com.jo net.jo org.jo edu.jo gov.jo mil.jo
   com.pt edu.pt gov.pt org.pt nome.pt int.pt net.pt publ.pt
   com.gr edu.gr net.gr org.gr gov.gr
   com.es org.es gob.es edu.es nom.es
   asso.fr com.fr gouv.fr nom.fr prd.fr tm.fr
   gov.it edu.it gov.ie`
    .split(/\s+/)
    .filter(Boolean)
)

// 建站托管平台（公共后缀表的私有段）：每个子域都是别人的独立站点，可注册域取后缀再加一段。
// 只收平台根域本身不承载站点资源的后缀，避免把平台自己的页面和资源子域拆开
const HOSTING_TENANT_SUFFIXES = new Set(
  `github.io gitlab.io gitee.io codeberg.page pages.dev workers.dev vercel.app now.sh netlify.app
   web.app firebaseapp.com appspot.com surge.sh onrender.com herokuapp.com fly.dev deno.dev glitch.me
   repl.co replit.app readthedocs.io gitbook.io azurewebsites.net azurestaticapps.net blogspot.com
   hashnode.dev 4everland.app zeabur.app up.railway.app ondigitalocean.app edgeone.app myshopify.com wixsite.com
   webflow.io framer.app framer.website framer.ai notion.site carrd.co`
    .split(/\s+/)
    .filter(Boolean)
)
// 按区域分段的托管后缀：名称.4.azurestaticapps.net、名称.eastus-01.azurewebsites.net
const REGIONAL_TENANT_SUFFIX =
  /^(?:(?:\d+|centralus|eastasia|eastus2|westeurope|westus2)\.azurestaticapps\.net|[a-z0-9]+-\d{2}\.azurewebsites\.net)$/

// 免费二级域名服务（同属公共后缀表的私有段）：每个子域都归不同的人
const FREE_SUBDOMAIN_SUFFIXES = new Set(
  `eu.org us.kg xx.kg dpdns.org qzz.io pp.ua js.org is-a.dev cloudns.asia cloudns.be cloudns.biz cloudns.cc
   cloudns.ch cloudns.cl cloudns.club cloudns.cx cloudns.eu cloudns.in cloudns.info cloudns.nz cloudns.org
   cloudns.ph cloudns.pro cloudns.pw cloudns.us`
    .split(/\s+/)
    .filter(Boolean)
)
// eu.org 的国家 / 机构子区（名称.cn.eu.org）
const EU_ORG_ZONES = new Set(
  `al asso at au be bg ca cd ch cn cy cz de dk edu ee es fi fr gr hr hu ie il in int is it jp kr lt lu lv
   me mk mt my net ng nl no nz pl pt ro ru se si sk tr uk us`
    .split(/\s+/)
    .filter(Boolean)
)

const isTenantSuffix = (suffix: string): boolean => HOSTING_TENANT_SUFFIXES.has(suffix) || REGIONAL_TENANT_SUFFIX.test(suffix)

const isKnownSuffix = (suffix: string): boolean =>
  MULTI_LABEL_SUFFIXES.has(suffix) ||
  FREE_SUBDOMAIN_SUFFIXES.has(suffix) ||
  isTenantSuffix(suffix) ||
  (suffix.endsWith('.eu.org') && EU_ORG_ZONES.has(suffix.slice(0, -'.eu.org'.length)))

// 已知多段后缀最长 3 段（us.eu.org、up.railway.app）：只看末尾几段，构造的超长主机也不会按段数平方增长
const MAX_SUFFIX_LABELS = 3

// 主机名里最长的已知多段后缀从第几段开始，没有时返回 -1
const findSuffixStart = (labels: string[], isSuffix: (suffix: string) => boolean): number => {
  for (let start = Math.max(1, labels.length - MAX_SUFFIX_LABELS); start < labels.length - 1; start += 1) {
    if (isSuffix(labels.slice(start).join('.'))) return start
  }
  return -1
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

const isIpHost = (host: string): boolean => IPV4_RE.test(host) || host.includes(':')

const normalizeHost = (hostname: unknown): string =>
  String(hostname ?? '')
    .toLowerCase()
    .replace(/\.$/, '')

// 把主机名归并到可注册域（eTLD+1）。IP / 单段主机名原样返回。
export const getRegistrableDomain = (hostname: unknown): string => {
  const host = normalizeHost(hostname)
  if (!host || isIpHost(host)) return host
  const labels = host.split('.')
  if (labels.length <= 2) return host
  const start = findSuffixStart(labels, isKnownSuffix)
  return labels.slice(start > 0 ? start - 1 : -2).join('.')
}

// 托管平台上的租户站点（friend.github.io 之类）：主机名本身就代表那个站点
export const isHostingTenantHost = (hostname: unknown): boolean => findSuffixStart(normalizeHost(hostname).split('.'), isTenantSuffix) > 0

const registrableDomainFromUrl = (rawUrl: unknown): string => {
  try {
    return getRegistrableDomain(new URL(String(rawUrl ?? '')).hostname)
  } catch {
    return ''
  }
}

// 判断某条请求记录的 URL 是否与页面属于同一可注册域。
// 页面 URL 不可解析时返回 true（无法比较则不过滤，保持原行为）；
// 记录 URL 不可解析时返回 false（按第三方处理，避免把外部信号算进本站）。
export const isSameSite = (recordUrl: unknown, pageUrl: unknown): boolean => {
  const pageDomain = registrableDomainFromUrl(pageUrl)
  if (!pageDomain) return true
  const recordDomain = registrableDomainFromUrl(recordUrl)
  if (!recordDomain) return false
  return recordDomain === pageDomain
}
