import {
  bridgeProtocolVersion,
  SITE_EXPERIENCE_PROFILE_SCHEMA,
  type AgentBridgeCapabilities,
  type AgentCaptureRequest,
  type AgentCaptureScreenshot,
  type SiteExperienceProfile
} from '@/types/agent-bridge'
import type { PopupRawResult } from '@/types/popup'
import { buildAgentGuidance } from '@/utils/site-experience-guidance'
import { buildLimitations } from '@/utils/site-experience-limitations'
import { cleanInlineText, isRecord, redactText, redactUrl } from '@/utils/site-experience-redaction'
import {
  buildAssetProfile,
  buildComponentProfile,
  buildEvidence,
  buildInteractionProfile,
  buildLayoutProfile,
  buildTargetLanguage,
  buildTechProfile,
  buildUxProfile,
  buildVisualProfile,
  sanitizeTechnology
} from '@/utils/site-experience-profile-sections'

export interface BuildSiteExperienceProfileInput {
  captureId: string
  request: AgentCaptureRequest
  raw: PopupRawResult | null
  experience: any
  capabilities: AgentBridgeCapabilities
  finalUrl?: string
  userAgent?: string
  extensionVersion?: string
  screenshot?: AgentCaptureScreenshot | null
  limitations?: string[]
  capturedAt?: string
  loginState?: 'unknown' | 'likely_authenticated' | 'likely_public'
  pageSupported?: boolean
}

const isValidScreenshot = (value: unknown): value is AgentCaptureScreenshot =>
  isRecord(value) &&
  typeof value.dataUrl === 'string' &&
  /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/i.test(value.dataUrl) &&
  value.mimeType === 'image/jpeg' &&
  typeof value.byteLength === 'number' &&
  Number.isInteger(value.byteLength) &&
  value.byteLength > 0 &&
  value.source === 'chrome.tabs.captureVisibleTab' &&
  value.scope === 'visible_viewport' &&
  typeof value.capturedAt === 'string'

export const buildSiteExperienceProfile = (input: BuildSiteExperienceProfileInput): SiteExperienceProfile => {
  const include = new Set(input.request.include)
  const technologies = include.has('tech') ? (input.raw?.technologies || []).map(sanitizeTechnology) : []
  const assetProfile = include.has('assets') ? buildAssetProfile(input.raw, input.experience, input.request.options.maxResourceUrls) : {}
  const limitations = [...new Set([...buildLimitations(input.request, input.experience), ...(input.limitations || [])])]
  const techProfile = include.has('tech') ? buildTechProfile(technologies) : {}
  const visualProfile = include.has('visual') ? buildVisualProfile(input.experience, input.request.options.captureScreenshotMetadata) : {}
  if (include.has('visual') && input.request.options.captureScreenshot && isValidScreenshot(input.screenshot)) {
    visualProfile.screenshot = input.screenshot
  }
  const layoutProfile = include.has('layout') ? buildLayoutProfile(input.experience, input.request.options.captureScreenshotMetadata) : {}
  const componentProfile = include.has('components')
    ? buildComponentProfile(input.experience, input.request.options.captureScreenshotMetadata)
    : {}
  const interactionProfile = include.has('interaction') ? buildInteractionProfile(input.experience) : {}
  const uxProfile = include.has('ux') ? buildUxProfile(input.experience) : {}
  const evidence = buildEvidence(input.raw, technologies, assetProfile, input.experience)
  const browserContext = {
    userAgent: cleanInlineText(input.userAgent || ''),
    extensionVersion: cleanInlineText(input.extensionVersion || ''),
    capturedAt: cleanInlineText(input.capturedAt || input.raw?.generatedAt || new Date().toISOString()),
    waitMs: input.request.waitMs,
    viewports: input.request.viewports.map(viewport => ({
      name: cleanInlineText(viewport.name || ''),
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor
    })),
    pageSupported: input.pageSupported ?? Boolean(input.raw || input.experience),
    loginState: input.loginState || 'unknown',
    viewportMode: 'current_viewport',
    bridgeProtocolVersion,
    extensionCapabilities: input.capabilities
  }
  const targetUrl = redactUrl(input.request.url)
  const finalUrl = redactUrl(input.finalUrl || input.raw?.url || input.request.url)

  return {
    schema: SITE_EXPERIENCE_PROFILE_SCHEMA,
    captureId: input.captureId,
    generatedAt: cleanInlineText(input.capturedAt || input.raw?.generatedAt || new Date().toISOString()),
    target: {
      url: targetUrl,
      finalUrl,
      origin: (() => {
        try {
          return new URL(finalUrl || targetUrl).origin
        } catch {
          return ''
        }
      })(),
      title: redactText(input.raw?.title || ''),
      language: buildTargetLanguage(input.experience),
      viewportProfiles: input.request.viewports.map(viewport => ({
        name: cleanInlineText(viewport.name || ''),
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor
      })),
      captureScope: 'target_url'
    },
    browserContext,
    techProfile,
    visualProfile,
    layoutProfile,
    componentProfile,
    interactionProfile,
    uxProfile,
    assetProfile,
    evidence,
    limitations,
    agentGuidance: buildAgentGuidance(techProfile, limitations, {
      visualProfile,
      layoutProfile,
      componentProfile,
      interactionProfile,
      uxProfile,
      assetProfile,
      evidence,
      browserContext
    })
  }
}
