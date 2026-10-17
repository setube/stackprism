import { readFile } from 'node:fs/promises'
import { chromium, errors, type Browser, type Frame, type Page, type Response } from 'playwright-core'
import { buildHeaderRecord } from '../background/headers'
import { mergeTechnologyRecords } from '../background/merge'
import { probePageResources, selectPageDetectorRules } from '../background/page-rule-filter'
import type { PageDetectionResult, TechnologyRecord } from '../types/rules'
import { DetectionDeadline } from './deadline.js'
import { SubresourceHeaders, SUBRESOURCE_RESPONSE_LIMIT, type CapturedNetwork } from './subresource-headers.js'
import { StackPrismError, type DetectedTechnology, type DetectionOptions, type DetectionReport, type ScanOptions } from './types.js'

export { StackPrismError } from './types.js'
export type {
  DetectablePage,
  DetectedTechnology,
  DetectionErrorCode,
  DetectionOptions,
  DetectionReport,
  NetworkResponseDetection,
  ScanOptions
} from './types.js'

declare const __STACKPRISM_DETECTOR_SOURCE__: string
declare const __STACKPRISM_SDK_VERSION__: string

interface BundledRules {
  version: string
  sha256: string
  page: Record<string, unknown>
  headers: Record<string, unknown>
}

let bundledRules: Promise<BundledRules> | undefined
const loadRules = (): Promise<BundledRules> => {
  bundledRules ??= readFile(new URL('./rules.json', import.meta.url), 'utf8')
    .then(JSON.parse)
    .catch(error => {
      bundledRules = undefined
      throw error
    })
  return bundledRules
}

const validateUrl = (value: string): string => {
  let url: URL
  try {
    if (typeof value !== 'string') throw new Error('Expected a string')
    url = new URL(value)
  } catch {
    throw new StackPrismError('INVALID_ARGUMENT', 'Expected an absolute HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new StackPrismError('INVALID_ARGUMENT', 'Only HTTP(S) URLs without embedded credentials are supported')
  }
  return url.href
}

const validatePage = (page: Page): void => {
  if (!page || typeof page.evaluate !== 'function' || typeof page.mainFrame !== 'function') {
    throw new StackPrismError('INVALID_ARGUMENT', 'Expected a Playwright Page')
  }
  if (page.isClosed()) throw new StackPrismError('PAGE_CLOSED', 'Page is closed')
  validateUrl(page.url())
}

const wrapFailure = (error: unknown, page?: Page): StackPrismError => {
  if (error instanceof StackPrismError) return error
  if (
    error instanceof errors.TimeoutError ||
    (error instanceof Error && error.message.includes('StackPrism detection deadline exceeded'))
  ) {
    return new StackPrismError('TIMEOUT', 'Detection deadline exceeded', { cause: error })
  }
  if (page?.isClosed()) return new StackPrismError('PAGE_CLOSED', 'Page closed during detection', { cause: error })
  return new StackPrismError('DETECTION_FAILED', 'Page detection failed', { cause: error })
}

const collectSnapshot = async (page: Page, rules: BundledRules, deadline: DetectionDeadline): Promise<PageDetectionResult> => {
  const initialUrl = page.url()
  let navigated = false
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) navigated = true
  }
  page.on('framenavigated', onNavigation)
  try {
    const probe = await deadline.run(() => page.evaluate(probePageResources))
    const selectedRules = selectPageDetectorRules(rules.page, probe)
    // Playwright evaluates string expressions without invoking them. Serialize rule data as JSON,
    // then explicitly invoke the trusted browser bundle; never interpolate page text as source code.
    const snapshot = await deadline.run(() =>
      page.evaluate<PageDetectionResult>(
        `(${__STACKPRISM_DETECTOR_SOURCE__})(${JSON.stringify({ rules: selectedRules, budgetMs: deadline.remaining() })})`
      )
    )
    if (navigated || page.url() !== initialUrl || snapshot.url !== initialUrl) {
      throw new StackPrismError('PAGE_CHANGED', 'Main frame navigated during detection; retry after it settles')
    }
    return snapshot
  } catch (error) {
    if (
      !(error instanceof StackPrismError) &&
      (navigated || (error instanceof Error && /Execution context was destroyed|Cannot find context with specified id/.test(error.message)))
    ) {
      throw new StackPrismError('PAGE_CHANGED', 'Main frame navigated during detection', { cause: error })
    }
    throw error
  } finally {
    page.off('framenavigated', onNavigation)
  }
}

const reportTechnologies = (items: TechnologyRecord[]): DetectedTechnology[] => {
  const confidence = { 高: 'high', 中: 'medium', 低: 'low' } as const
  const technologies: TechnologyRecord[] = mergeTechnologyRecords(items)
  return technologies
    .map(technology => ({
      name: technology.name,
      category: technology.category,
      confidence: confidence[technology.confidence],
      evidence: technology.evidence ?? [],
      ...(technology.kind ? { kind: technology.kind } : {}),
      ...(technology.source ? { source: technology.source } : {}),
      ...(technology.version ? { version: technology.version } : {}),
      ...(technology.url ? { url: technology.url } : {})
    }))
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

const buildReport = (
  snapshot: PageDetectionResult,
  headerTechnologies: TechnologyRecord[],
  httpStatus: number | null,
  rules: BundledRules,
  deadline: DetectionDeadline,
  network: (CapturedNetwork & { observationMs: number }) | null
): DetectionReport => {
  return {
    schemaVersion: 1,
    engine: { name: 'stackprism', version: __STACKPRISM_SDK_VERSION__ },
    rules: { version: rules.version, sha256: rules.sha256 },
    url: snapshot.url,
    title: snapshot.title,
    generatedAt: snapshot.generatedAt,
    durationMs: Math.round(performance.now() - deadline.startedAt),
    technologies: reportTechnologies([...snapshot.technologies, ...headerTechnologies]),
    coverage: {
      page: 'sampled_main_frame',
      responseHeaders: httpStatus === null ? 'not_observed' : 'main_document',
      subresourceHeaders: network === null ? 'not_observed' : 'sampled',
      httpStatus,
      unobserved: [
        'iframe_internals',
        ...(network === null ? ['subresource_headers'] : []),
        'continuous_mutations',
        'bundle_license_sampling',
        'wordpress_supplementary_fetches'
      ],
      limits: { htmlCharacters: 500_000, bodyCharacters: 120_000, cssVariables: 500 }
    },
    network: {
      observationMs: network?.observationMs ?? 0,
      responseLimit: SUBRESOURCE_RESPONSE_LIMIT,
      observedResponses: network?.observedResponses ?? 0,
      skippedResponses: network?.skippedResponses ?? 0,
      failedResponses: network?.failedResponses ?? 0,
      responses: (network?.responses ?? []).map(response => ({
        url: response.url,
        relation: new URL(response.url).origin === new URL(snapshot.url).origin ? 'same_origin' : 'cross_origin',
        resourceType: response.resourceType,
        status: response.status,
        technologies: reportTechnologies(response.technologies)
      }))
    },
    resources: {
      total: snapshot.resources.total,
      sampledScripts: snapshot.resources.scripts.length,
      sampledStylesheets: snapshot.resources.stylesheets.length,
      cssVariableCount: snapshot.resources.cssVariableCount
    }
  }
}

/** Inspect a settled caller-owned page. Never navigates, refetches headers, or closes the page/browser. */
export async function detectPage(page: Page, options: DetectionOptions = {}): Promise<DetectionReport> {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new StackPrismError('INVALID_ARGUMENT', 'Expected an options object')
  validatePage(page)
  const deadline = new DetectionDeadline(options.timeoutMs, options.signal)
  try {
    const rules = await deadline.run(loadRules)
    const snapshot = await collectSnapshot(page, rules, deadline)
    deadline.remaining()
    return buildReport(snapshot, [], null, rules, deadline, null)
  } catch (error) {
    throw wrapFailure(error, page)
  } finally {
    deadline.dispose()
  }
}

/** Launch installed Chrome, navigate once, inspect the main document, then close the owned browser. */
export async function scanUrl(url: string, options: ScanOptions = {}): Promise<DetectionReport> {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new StackPrismError('INVALID_ARGUMENT', 'Expected an options object')
  const target = validateUrl(url)
  if (options.executablePath !== undefined && (typeof options.executablePath !== 'string' || !options.executablePath.trim())) {
    throw new StackPrismError('INVALID_ARGUMENT', 'executablePath must be a nonempty string')
  }
  const observationMs = options.observationMs ?? 1000
  if (!Number.isSafeInteger(observationMs) || observationMs < 0 || observationMs > 5000) {
    throw new StackPrismError('INVALID_ARGUMENT', 'observationMs must be an integer between 0 and 5000')
  }
  const deadline = new DetectionDeadline(options.timeoutMs, options.signal)
  let browser: Browser | undefined
  let launching: Promise<Browser> | undefined
  let page: Page | undefined
  let subresourceHeaders: SubresourceHeaders | undefined
  let latestNavigationResponse: Response | undefined
  const recordNavigationResponse = (response: Response) => {
    if (response.request().isNavigationRequest() && response.frame() === page!.mainFrame()) latestNavigationResponse = response
  }
  try {
    const rules = await deadline.run(loadRules)
    launching = chromium.launch({
      headless: true,
      ...(options.executablePath ? { executablePath: options.executablePath } : { channel: 'chrome' }),
      timeout: deadline.remaining()
    })
    try {
      browser = await deadline.run(() => launching!)
    } catch (error) {
      if (error instanceof StackPrismError || error instanceof errors.TimeoutError) throw error
      throw new StackPrismError('BROWSER_LAUNCH_FAILED', 'Could not launch Chrome; install Chrome or set executablePath', { cause: error })
    }
    page = await deadline.run(() => browser!.newPage())
    subresourceHeaders = new SubresourceHeaders(page, rules.headers)
    page.on('response', recordNavigationResponse)
    let response: Response | null
    try {
      response = await deadline.run(() => page!.goto(target, { waitUntil: 'load', timeout: deadline.remaining() }))
    } catch (error) {
      if (error instanceof StackPrismError || error instanceof errors.TimeoutError) throw error
      throw new StackPrismError('NAVIGATION_FAILED', 'Main document navigation failed', { cause: error })
    }
    validateUrl(page.url())
    if (!response) throw new StackPrismError('NAVIGATION_FAILED', 'Navigation produced no main document response')
    // Track document identity as well as URL: a same-URL reload must not reuse old headers.
    let navigated = false
    const onNavigation = (frame: Frame) => {
      if (frame === page!.mainFrame()) navigated = true
    }
    page.on('framenavigated', onNavigation)
    try {
      await deadline.wait(observationMs)
      const network = await deadline.run(() => subresourceHeaders!.finish())
      const responseHeaders = await deadline.run(() => response.headersArray())
      const snapshot = await collectSnapshot(page, rules, deadline)
      if (
        navigated ||
        latestNavigationResponse !== response ||
        new URL(snapshot.url).href.split('#')[0] !== new URL(response.url()).href.split('#')[0]
      ) {
        throw new StackPrismError('PAGE_CHANGED', 'Main document changed after navigation')
      }
      const headerRecord = buildHeaderRecord(
        {
          url: response.url(),
          type: 'main_frame',
          method: response.request().method(),
          statusCode: response.status(),
          responseHeaders
        },
        rules.headers,
        {}
      )
      deadline.remaining()
      return buildReport(snapshot, headerRecord.technologies, response.status(), rules, deadline, { ...network, observationMs })
    } finally {
      page.off('framenavigated', onNavigation)
    }
  } catch (error) {
    throw wrapFailure(error, page)
  } finally {
    deadline.dispose()
    subresourceHeaders?.dispose()
    page?.off('response', recordNavigationResponse)
    // A cancelled launch can resolve after the caller's deadline; still reap its browser.
    browser ??= await launching?.catch(() => undefined)
    await browser?.close()
  }
}
