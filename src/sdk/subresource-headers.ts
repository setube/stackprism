import type { Frame, Page, Request, Response } from 'playwright-core'
import { buildHeaderRecord } from '../background/headers'
import type { TechnologyRecord } from '../types/rules'

export const SUBRESOURCE_RESPONSE_LIMIT = 64

export interface CapturedResponse {
  url: string
  resourceType: string
  status: number
  technologies: TechnologyRecord[]
}

export interface CapturedNetwork {
  observedResponses: number
  skippedResponses: number
  failedResponses: number
  responses: CapturedResponse[]
}

/** Owns listeners and bounded header reads for the currently committed main-frame document. */
export class SubresourceHeaders {
  private generation = 0
  private readonly requestGenerations = new WeakMap<Request, number>()
  private pending: Promise<CapturedResponse | null>[] = []
  private observedResponses = 0
  private activeReads = 0
  private stopped = false

  constructor(
    private readonly page: Page,
    private readonly rules: Record<string, unknown>
  ) {
    page.on('framenavigated', this.onNavigation)
    page.on('request', this.onRequest)
    page.on('response', this.onResponse)
  }

  private readonly onNavigation = (frame: Frame): void => {
    if (frame !== this.page.mainFrame()) return
    // A response can arrive after a new document commits, including reloads of the same URL.
    this.generation++
    this.pending = []
    this.observedResponses = 0
  }

  private readonly onRequest = (request: Request): void => {
    if (request.isNavigationRequest() || request.serviceWorker() || request.frame() !== this.page.mainFrame()) return
    if (!/^https?:/i.test(request.url())) return
    this.requestGenerations.set(request, this.generation)
  }

  private readonly onResponse = (response: Response): void => {
    const request = response.request()
    if (this.requestGenerations.get(request) !== this.generation) return
    this.observedResponses++
    if (this.pending.length >= SUBRESOURCE_RESPONSE_LIMIT || this.activeReads >= SUBRESOURCE_RESPONSE_LIMIT) return
    this.activeReads++
    this.pending.push(
      this.readResponse(response)
        .catch(() => null)
        .finally(() => {
          this.activeReads--
        })
    )
  }

  private async readResponse(response: Response): Promise<CapturedResponse | null> {
    const generation = this.generation
    const responseHeaders = await response.headersArray()
    if (generation !== this.generation) return null
    const request = response.request()
    const record = buildHeaderRecord(
      {
        url: response.url(),
        type: request.resourceType(),
        method: request.method(),
        statusCode: response.status(),
        responseHeaders
      },
      this.rules,
      {}
    )
    const url = new URL(response.url())
    // Retain the path for endpoint evidence; queries, fragments and credentials are not report fields.
    return {
      url: `${url.origin}${url.pathname}`,
      resourceType: request.resourceType(),
      status: response.status(),
      technologies: record.technologies
    }
  }

  async finish(): Promise<CapturedNetwork> {
    this.detach()
    const captured = await Promise.all(this.pending)
    return {
      observedResponses: this.observedResponses,
      skippedResponses: this.observedResponses - captured.length,
      failedResponses: captured.filter(response => response === null).length,
      responses: captured.filter((response): response is CapturedResponse => response !== null)
    }
  }

  private detach(): void {
    if (this.stopped) return
    this.stopped = true
    this.page.off('framenavigated', this.onNavigation)
    this.page.off('request', this.onRequest)
    this.page.off('response', this.onResponse)
  }

  dispose(): void {
    this.detach()
    this.generation++
    this.pending = []
  }
}
