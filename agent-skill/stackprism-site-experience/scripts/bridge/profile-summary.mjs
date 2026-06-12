import { redactUrl } from './protocol.mjs'

const MAX_TEXT = 120
const MAX_ITEMS = 6
const TOKEN_TEXT = /\b(apiToken|bridgeToken|authorization|cookie|nonce|secret|token)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi
const ID_TEXT = /\b(?:spbt?_|cap_|s_|n_|xfer_|shot_)[A-Za-z0-9_-]{8,}\b/g
const EMAIL_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE_TEXT = /\b(?:\+?\d[\d -]{8,}\d)\b/g
const URL_TEXT = /https?:\/\/[^\s"')\]}]+/g

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const compact = value =>
  String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const safeText = (value, max = MAX_TEXT) =>
  compact(value)
    .replace(URL_TEXT, url => redactUrl(url) || '[redacted-url]')
    .replace(TOKEN_TEXT, '$1=[redacted]')
    .replace(ID_TEXT, '[redacted-id]')
    .replace(EMAIL_TEXT, '[redacted-email]')
    .replace(PHONE_TEXT, '[redacted-number]')
    .slice(0, max)

const values = (value, limit = MAX_ITEMS) => {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return [...new Set(source.map(item => safeText(item)).filter(Boolean))].slice(0, limit)
}

const objectValues = (items, keys = ['name', 'type', 'category', 'domain', 'label'], limit = MAX_ITEMS) => {
  if (!Array.isArray(items)) return []
  return items
    .map(item => {
      if (!isRecord(item)) return safeText(item)
      for (const key of keys) {
        const text = safeText(item[key])
        if (text) return text
      }
      return ''
    })
    .filter(Boolean)
    .slice(0, limit)
}

const count = value => (Array.isArray(value) ? value.length : isRecord(value) ? Object.keys(value).length : 0)
const add = (items, label, value) => {
  const text = safeText(value)
  if (text) items.push(`${label}: ${text}`)
}
const addList = (items, label, value, limit = MAX_ITEMS) => {
  const list = values(value, limit)
  if (list.length) items.push(`${label}: ${list.join(', ')}`)
}
const addObjectList = (items, label, value, limit = MAX_ITEMS) => {
  const list = objectValues(value, undefined, limit)
  if (list.length) items.push(`${label}: ${list.join(', ')}`)
}
const card = (id, title, items) => (items.length ? { id, title, items } : null)

const targetCard = (profile, capture, screenshot) => {
  const target = isRecord(profile.target) ? profile.target : {}
  const items = []
  add(items, '目标 URL', capture.finalUrl || capture.request?.url || target.finalUrl || target.url)
  add(items, '页面语言', target.language)
  add(items, '生成时间', profile.generatedAt)
  items.push(`截图: ${screenshot ? '已包含' : '未包含'}`)
  return card('target', '目标', items)
}

const techCard = profile => {
  const tech = isRecord(profile.techProfile) ? profile.techProfile : {}
  const technologies = Array.isArray(tech.technologies) ? tech.technologies : []
  const items = []
  if (technologies.length) items.push(`技术数量: ${technologies.length}`)
  addObjectList(items, '主要技术', technologies)
  add(items, '前端主栈', tech.primaryFrontend)
  add(items, 'UI 框架', tech.uiFramework)
  add(items, '构建运行时', tech.buildRuntime)
  addList(items, '第三方服务', tech.thirdPartyServices)
  return card('tech', '技术栈', items)
}

const visualCard = (profile, screenshot) => {
  const visual = isRecord(profile.visualProfile) ? profile.visualProfile : {}
  const plan = profile.agentGuidance?.recreationPlan || {}
  const tokens = isRecord(plan.designTokens) ? plan.designTokens : {}
  const ref = isRecord(plan.visualReference) ? plan.visualReference : {}
  const items = []
  items.push(`截图: ${screenshot ? '可用于视觉对照' : '未包含'}`)
  addList(items, '颜色', visual.colorTokens || tokens.colors)
  addList(items, '字体', visual.fonts || tokens.fontFamilies)
  addList(items, '字号', visual.fontSizes || tokens.fontSizes)
  add(items, '截图范围', ref.screenshotScope)
  return card('visual', '视觉', items)
}

const layoutCard = profile => {
  const layout = isRecord(profile.layoutProfile) ? profile.layoutProfile : {}
  const ux = isRecord(profile.uxProfile) ? profile.uxProfile : {}
  const blueprint = profile.agentGuidance?.recreationPlan?.layoutBlueprint || {}
  const items = []
  add(items, '页面目的', ux.pagePurpose)
  addList(items, '主要路径', ux.primaryUserPath)
  addList(items, '信息层级', ux.informationHierarchy || blueprint.informationHierarchy)
  addList(items, '内容分组', ux.contentGrouping || blueprint.contentGrouping)
  addList(items, 'Landmarks', layout.landmarks || blueprint.landmarks)
  add(items, '导航深度', ux.navigationDepth)
  return card('layout', '布局与信息结构', items)
}

const componentsCard = profile => {
  const components = isRecord(profile.componentProfile) ? profile.componentProfile : {}
  const inventory = profile.agentGuidance?.recreationPlan?.componentInventory || {}
  const counts = isRecord(components.counts) ? components.counts : inventory.counts
  const items = []
  if (count(counts)) items.push(`组件类型数: ${count(counts)}`)
  addList(items, '优先组件', inventory.priorityTypes)
  addObjectList(items, '组件样本', components.samples)
  add(items, '几何信息', inventory.geometryIncluded === true ? '已包含' : inventory.geometryIncluded === false ? '未包含' : '')
  return card('components', '组件', items)
}

const interactionCard = profile => {
  const interaction = isRecord(profile.interactionProfile) ? profile.interactionProfile : {}
  const ux = isRecord(profile.uxProfile) ? profile.uxProfile : {}
  const checklist = profile.agentGuidance?.recreationPlan?.interactionChecklist || {}
  const items = []
  addList(items, 'CTA', ux.ctaStrategy)
  addList(items, '信任信号', ux.trustSignals)
  addList(items, '转场', interaction.transitions || checklist.transitions)
  addList(items, '动画', interaction.animations || checklist.animations)
  addList(items, '固定元素', interaction.stickyOrFixed || checklist.stickyOrFixed)
  addList(items, '交互摩擦', ux.frictionPoints)
  return card('interaction', '交互与 UX', items)
}

const assetsCard = profile => {
  const assets = isRecord(profile.assetProfile) ? profile.assetProfile : {}
  const hints = profile.agentGuidance?.recreationPlan?.assetHints || {}
  const items = []
  if (count(assets.scripts) || hints.scriptCount) items.push(`脚本: ${count(assets.scripts) || hints.scriptCount}`)
  if (count(assets.stylesheets) || hints.stylesheetCount) items.push(`样式表: ${count(assets.stylesheets) || hints.stylesheetCount}`)
  addList(items, '资源域名', hints.resourceDomains || assets.resourceDomains)
  addList(items, 'CDN 线索', assets.cdnHints || hints.cdnHints)
  addList(items, '字体资源', assets.fontUrls || hints.fontUrls)
  return card('assets', '资产', items)
}

const guidanceCard = profile => {
  const guidance = isRecord(profile.agentGuidance) ? profile.agentGuidance : {}
  const plan = isRecord(guidance.recreationPlan) ? guidance.recreationPlan : {}
  const items = []
  add(items, '摘要', guidance.summary)
  addList(items, '实现顺序', plan.implementationOrder, 4)
  addList(items, '验证项', plan.verificationChecklist, 4)
  addList(items, '限制', profile.limitations, 4)
  return card('guidance', '复刻建议', items)
}

const copyTextFor = cards => {
  const lines = ['# StackPrism Site Experience', '', '用于 AI Agent 快速复刻目标网站体验的受限摘要。']
  for (const item of cards) {
    lines.push('', `## ${item.title}`)
    for (const entry of item.items) lines.push(`- ${entry}`)
  }
  lines.push('', '备注: 本摘要不包含 raw profile、token、nonce、截图 data URL 或完整敏感文本。')
  return lines.join('\n')
}

export const profilePreviewSummary = (capture, screenshot) => {
  const profile = capture.profile
  if (capture.status !== 'completed' || !isRecord(profile)) return null
  const cards = [
    guidanceCard(profile),
    visualCard(profile, screenshot),
    layoutCard(profile),
    componentsCard(profile),
    interactionCard(profile),
    techCard(profile),
    assetsCard(profile),
    targetCard(profile, capture, screenshot)
  ].filter(Boolean)
  return cards.length ? { contentSummary: { cards }, copyText: copyTextFor(cards) } : null
}
