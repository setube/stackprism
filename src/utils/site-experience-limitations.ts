import type { AgentCaptureRequest } from '@/types/agent-bridge'
import { cleanStringArray } from '@/utils/normalize-settings'
import { cleanInlineText, redactText } from '@/utils/site-experience-redaction'

export const buildLimitations = (request: AgentCaptureRequest, experience: any): string[] => {
  const limitations = new Set<string>()
  const truncation = experience?.evidence?.truncation || experience?.evidence?.omitted || {}
  for (const item of cleanStringArray(experience?.limitations).map(redactText).map(cleanInlineText).filter(Boolean)) limitations.add(item)
  if (request.viewports.length) limitations.add('viewport_emulation_unsupported')
  if (request.options.captureScreenshotMetadata === false) limitations.add('screenshot_metadata_not_requested')
  if (request.options.captureScreenshot !== true) limitations.add('screenshot_image_not_requested')
  if (request.options.captureScreenshot === true && request.include && !request.include.includes('visual')) {
    limitations.add('screenshot_image_requires_visual_section')
  }
  if (request.include && !request.include.includes('tech')) limitations.add('tech_section_not_requested')
  if (request.include && !request.include.includes('visual')) limitations.add('visual_section_not_requested')
  if (request.include && !request.include.includes('layout')) limitations.add('layout_section_not_requested')
  if (request.include && !request.include.includes('components')) limitations.add('components_section_not_requested')
  if (request.include && !request.include.includes('interaction')) limitations.add('interaction_section_not_requested')
  if (request.include && !request.include.includes('ux')) limitations.add('ux_section_not_requested')
  if (request.include && !request.include.includes('assets')) limitations.add('assets_section_not_requested')
  if (Number(experience?.evidence?.crossOriginIframes || 0) > 0) limitations.add('cross_origin_iframes_limited')
  if (Number(experience?.interaction?.closedShadowRoots || 0) > 0) limitations.add('closed_shadow_roots_limited')
  if (Number(experience?.evidence?.inaccessibleStylesheets || 0) > 0) limitations.add('stylesheet_access_limited')
  if (experience?.interaction?.passive) limitations.add('passive_interaction_only')
  if (Number(truncation.resourceUrls || 0) > 0) limitations.add('resource_urls_truncated')
  if (Number(truncation.textSamples || 0) > 0) limitations.add('text_samples_truncated')
  if (Number(truncation.componentSamples || 0) > 0) limitations.add('component_samples_truncated')
  if (Number(truncation.cssRules || 0) > 0) limitations.add('css_rules_truncated')
  if (Number(truncation.executeScriptResult || 0) > 0 || Number(truncation.executeScriptResultOverLimit || 0) > 0) {
    limitations.add('execute_script_result_truncated')
  }
  return [...limitations]
}
