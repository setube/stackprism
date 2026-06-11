// @ts-nocheck

import { detectPageTechnologies } from './page-detector-runtime'

const runDefaultPageDetection = () => {
  const __spRules = (window as any).__SP_RULES__ ?? {}
  ;(window as any).__SP_RULES__ = undefined
  const __spStart = performance.now()
  return detectPageTechnologies(__spRules).then(result => {
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
}

const __spResult =
  typeof window !== 'undefined' && typeof document !== 'undefined' ? runDefaultPageDetection() : Promise.resolve(null)

export default __spResult
