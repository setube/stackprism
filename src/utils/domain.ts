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

const HOSTING_TENANT_SUFFIXES = `github.io vercel.app netlify.app pages.dev workers.dev webflow.io firebaseapp.com web.app
  herokuapp.com fly.dev glitch.me repl.co replit.app surge.sh render.com onrender.com
  railway.app up.railway.app azurewebsites.net cloudfront.net`
  .split(/\s+/)
  .filter(Boolean)
  .sort((a, b) => b.split('.').length - a.split('.').length || b.length - a.length)

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

const isIpHost = (host: string): boolean => IPV4_RE.test(host) || host.includes(':')

// 把主机名归并到可注册域（eTLD+1）。IP / 单段主机名原样返回。
export const getRegistrableDomain = (hostname: unknown): string => {
  const host = String(hostname ?? '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (!host || isIpHost(host)) return host
  const labels = host.split('.')
  if (labels.length <= 2) return host
  for (const suffix of HOSTING_TENANT_SUFFIXES) {
    const suffixLabels = suffix.split('.').length
    if (host === suffix) return host
    if (host.endsWith(`.${suffix}`)) return labels.slice(-(suffixLabels + 1)).join('.')
  }
  const last2 = labels.slice(-2).join('.')
  if (MULTI_LABEL_SUFFIXES.has(last2)) return labels.slice(-3).join('.')
  return last2
}

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
