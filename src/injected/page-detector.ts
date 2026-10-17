import { detectPageTechnologies } from '@/core/page-detector'

const __spRules = (window as any).__SP_RULES__ ?? {}
;(window as any).__SP_RULES__ = undefined
const __spStart = performance.now()
const __spResult = detectPageTechnologies(__spRules).then(result => {
  try {
    if (localStorage.getItem('__sp_observer_debug__') === '1') {
      const __spDuration = performance.now() - __spStart
      console.log(
        '[StackPrism page-detector] 耗时',
        __spDuration.toFixed(1) + 'ms',
        '| 识别',
        result?.technologies?.length || 0,
        '项 |',
        'resources',
        result?.resources?.total || 0
      )
    }
  } catch {
    // ignore
  }
  return result
})
export default __spResult
