import type { Page } from 'playwright-core'

export interface DetectionOptions {
  /** Total operation budget, including launch/navigation for scanUrl. Default: 30,000 ms. */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ScanOptions extends DetectionOptions {
  /** Installed Chromium executable. Defaults to the installed Chrome channel; no download. */
  executablePath?: string
  /** Observe existing subresource responses for 0–5000 ms after load. Default: 1000. */
  observationMs?: number
}

export interface NetworkResponseDetection {
  /** Credentials, query and fragment are omitted. Paths can still contain sensitive data. */
  url: string
  relation: 'same_origin' | 'cross_origin'
  resourceType: string
  status: number
  technologies: DetectedTechnology[]
}

export interface DetectedTechnology {
  name: string
  category: string
  kind?: string
  confidence: 'high' | 'medium' | 'low'
  evidence: string[]
  /** Existing detector source label; merged records may retain only the first source. */
  source?: string
  version?: string
  url?: string
}

export interface DetectionReport {
  schemaVersion: 1
  engine: { name: 'stackprism'; version: string }
  rules: { version: string; sha256: string }
  url: string
  title: string
  generatedAt: string
  durationMs: number
  technologies: DetectedTechnology[]
  coverage: {
    page: 'sampled_main_frame'
    responseHeaders: 'main_document' | 'not_observed'
    subresourceHeaders: 'sampled' | 'not_observed'
    httpStatus: number | null
    unobserved: string[]
    limits: { htmlCharacters: number; bodyCharacters: number; cssVariables: number }
  }
  resources: {
    total: number
    sampledScripts: number
    sampledStylesheets: number
    cssVariableCount: number
  }
  network: {
    observationMs: number
    responseLimit: number
    observedResponses: number
    skippedResponses: number
    failedResponses: number
    responses: NetworkResponseDetection[]
  }
}

export type DetectionErrorCode =
  | 'INVALID_ARGUMENT'
  | 'BROWSER_LAUNCH_FAILED'
  | 'NAVIGATION_FAILED'
  | 'PAGE_CHANGED'
  | 'PAGE_CLOSED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'DETECTION_FAILED'

export class StackPrismError extends Error {
  constructor(
    public readonly code: DetectionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'StackPrismError'
  }
}

/** Playwright Page is a type-only dependency; the caller retains its lifecycle. */
export type DetectablePage = Page
