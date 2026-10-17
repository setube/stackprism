const EMPTY_DEFAULTS = Object.freeze({})

// 规则 JSON 都是 JSON.parse 出来的普通对象，按原型判断比 Object.prototype.toString 快得多
const isPlainObject = (value: unknown): value is Record<string, any> => {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const isRuleGroup = (value: any): boolean => isPlainObject(value) && Array.isArray(value.rules)

// patterns / resourceHints / globals 这类纯字符串数组占了规则的大头，原样复用，不再逐项复制
const hasNestedObject = (items: any[]): boolean => {
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (item !== null && typeof item === 'object') return true
  }
  return false
}

const normalizeRuleObject = (object: any) => {
  const result: any = {}
  for (const key in object) {
    result[key] = normalizeRuleValue(object[key])
  }
  return result
}

const expandRuleGroupInto = (out: any[], group: any, inheritedDefaults: any) => {
  const defaults = {
    ...inheritedDefaults,
    ...(isPlainObject(group.defaults) ? group.defaults : {}),
    ...(isPlainObject(group.$defaults) ? group.$defaults : {})
  }
  for (const rule of group.rules) {
    pushRuleArrayItem(out, rule, defaults)
  }
}

const pushRuleArrayItem = (out: any[], item: any, defaults: any) => {
  if (isRuleGroup(item)) {
    expandRuleGroupInto(out, item, defaults)
    return
  }
  if (!isPlainObject(item)) {
    out.push(item)
    return
  }
  out.push({ ...defaults, ...normalizeRuleObject(item) })
}

const normalizeRuleValue = (value: any): any => {
  if (Array.isArray(value)) {
    if (!hasNestedObject(value)) return value
    const out: any[] = []
    for (const item of value) {
      pushRuleArrayItem(out, item, EMPTY_DEFAULTS)
    }
    return out
  }
  if (isRuleGroup(value)) {
    const out: any[] = []
    expandRuleGroupInto(out, value, EMPTY_DEFAULTS)
    return out
  }
  if (isPlainObject(value)) {
    const result: any = {}
    for (const key in value) {
      result[key] = normalizeRuleValue(value[key])
    }
    return result
  }
  return value
}

export const mergeRulePartial = (target: any, source: any) => {
  const normalized = normalizeRuleValue(source) || {}
  for (const key in normalized) {
    const value = normalized[key]
    if (Array.isArray(value)) {
      const dst = Array.isArray(target[key]) ? target[key] : (target[key] = [])
      for (let i = 0; i < value.length; i++) dst.push(value[i])
      continue
    }
    if (value && typeof value === 'object') {
      const base = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {}
      target[key] = mergeRulePartial(base, value)
      continue
    }
    target[key] = value
  }
  return target
}
