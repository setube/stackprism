import { fail, json } from './protocol.mjs'

const screenshotDataUrlPattern = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/i
const strictBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const screenshotBase64OmittedNote =
  'Screenshot image base64 is intentionally omitted from this Profile JSON. To inspect actual visual appearance, download the image from downloadUrl while the local bridge is running and before availableUntil.'
const screenshotProfileJsonNote =
  'Profile JSON is standard JSON and cannot contain comments. This note field is the durable instruction: screenshot base64 is omitted; use downloadUrl to inspect actual visual appearance.'

const screenshotExtensionFor = mimeType => (mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg')
const decodeStrictBase64 = value => {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !strictBase64Pattern.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  return bytes.toString('base64') === value ? bytes : null
}
const availableUntilFor = capture => {
  if (!capture.resultExpiresAt) return ''
  try {
    return new Date(capture.resultExpiresAt).toISOString()
  } catch {
    return ''
  }
}

const screenshotAssetFrom = screenshot => {
  const match = typeof screenshot?.dataUrl === 'string' ? screenshot.dataUrl.match(screenshotDataUrlPattern) : null
  if (!match) return null
  const mimeType = `image/${match[1].toLowerCase()}`
  const bytes = decodeStrictBase64(match[2])
  if (!bytes?.byteLength) return null
  const { dataUrl: _dataUrl, ...rest } = screenshot
  return {
    bytes,
    mimeType,
    extension: screenshotExtensionFor(mimeType),
    metadata: rest
  }
}

const screenshotMetadataFor = (capture, asset) => ({
  ...asset.metadata,
  mimeType: asset.mimeType,
  byteLength: asset.bytes.byteLength,
  downloadUrl: capture.screenshotUrl,
  downloadMethod: 'GET',
  lifecycle: {
    requiresLocalBridge: true,
    availableUntil: availableUntilFor(capture),
    note: 'Download the screenshot before the local bridge process exits or the capture result expires.'
  },
  profileJsonNote: screenshotProfileJsonNote,
  note: screenshotBase64OmittedNote
})

export const screenshotPayloadForCapture = capture => {
  const asset = capture.screenshotAsset || screenshotAssetFrom(capture.profile?.visualProfile?.screenshot)
  if (!asset?.bytes?.byteLength) return null
  return {
    ...asset,
    metadata: screenshotMetadataFor(capture, asset)
  }
}

export const screenshotPreviewForCapture = capture => {
  const payload = screenshotPayloadForCapture(capture)
  if (!payload) return null
  return {
    downloadUrl: capture.screenshotUrl,
    mimeType: payload.mimeType,
    byteLength: payload.bytes.byteLength,
    scope: payload.metadata.scope
  }
}

const cloneJson = value => JSON.parse(JSON.stringify(value))

const ensureVisualReference = profile => {
  if (!profile.agentGuidance || typeof profile.agentGuidance !== 'object') profile.agentGuidance = {}
  if (!profile.agentGuidance.recreationPlan || typeof profile.agentGuidance.recreationPlan !== 'object') {
    profile.agentGuidance.recreationPlan = {}
  }
  if (
    !profile.agentGuidance.recreationPlan.visualReference ||
    typeof profile.agentGuidance.recreationPlan.visualReference !== 'object'
  ) {
    profile.agentGuidance.recreationPlan.visualReference = {}
  }
  return profile.agentGuidance.recreationPlan.visualReference
}

const updateVisualReference = (profile, capture, payload) => {
  const visualReference = payload ? ensureVisualReference(profile) : profile.agentGuidance?.recreationPlan?.visualReference
  if (!visualReference || typeof visualReference !== 'object') return
  visualReference.screenshotIncluded = Boolean(payload)
  visualReference.screenshotBase64Included = false
  visualReference.screenshotDownloadUrl = payload ? capture.screenshotUrl : ''
  visualReference.screenshotDownloadHint = payload
    ? screenshotBase64OmittedNote
    : 'No screenshot image is available in this capture. Review limitations before treating visual evidence as absent.'
  visualReference.screenshotProfileJsonNote = screenshotProfileJsonNote
  if (payload) {
    visualReference.screenshotMimeType = payload.mimeType
    visualReference.screenshotByteLength = payload.bytes.byteLength
    visualReference.screenshotAvailableUntil = availableUntilFor(capture)
  } else {
    delete visualReference.screenshotMimeType
    delete visualReference.screenshotByteLength
    delete visualReference.screenshotAvailableUntil
  }
}

export const prepareProfileForStorage = (profile, capture) => {
  const storedProfile = cloneJson(profile)
  const asset = screenshotAssetFrom(storedProfile.visualProfile?.screenshot)
  const screenshot = storedProfile.visualProfile?.screenshot
  if (screenshot && typeof screenshot === 'object') {
    if (asset) storedProfile.visualProfile.screenshot = screenshotMetadataFor(capture, asset)
    else delete screenshot.dataUrl
  }
  updateVisualReference(storedProfile, capture, asset)
  return { profile: storedProfile, screenshotAsset: asset }
}

export const profileForAgent = capture => {
  const profile = cloneJson(capture.profile)
  const payload = screenshotPayloadForCapture(capture)
  const screenshot = profile.visualProfile?.screenshot
  if (screenshot && typeof screenshot === 'object') {
    if (payload) profile.visualProfile.screenshot = payload.metadata
    else delete screenshot.dataUrl
  }
  updateVisualReference(profile, capture, payload)
  return profile
}

export const readProfile = (res, capture, tokenType, headers, { store } = {}) => {
  if (tokenType === 'bridge') return fail(res, 403, 'BRIDGE_TOKEN_CANNOT_READ_PROFILE', 'Bridge token cannot read the profile endpoint.', {}, headers)
  if (capture.status === 'expired') return fail(res, 410, 'CAPTURE_RESULT_EXPIRED', 'Capture result expired.', {}, headers)
  if (capture.status !== 'completed')
    return fail(res, 409, 'INVALID_REQUEST', 'Capture profile is not ready.', { status: capture.status }, headers)
  store?.touchResult?.(capture)
  return json(res, 200, profileForAgent(capture), headers)
}

export const readProfileDownload = (res, capture, headers, { store } = {}) => {
  const downloadHeaders = {
    ...headers,
    'Content-Disposition': `attachment; filename="stackprism-${capture.id}-profile.json"`
  }
  if (capture.status === 'expired') return fail(res, 410, 'CAPTURE_RESULT_EXPIRED', 'Capture result expired.', {}, downloadHeaders)
  if (capture.status !== 'completed')
    return fail(res, 409, 'INVALID_REQUEST', 'Capture profile is not ready.', { status: capture.status }, downloadHeaders)
  capture.profileDownloadReadyAt = capture.profileDownloadReadyAt || Date.now()
  store?.touchResult?.(capture)
  return json(res, 200, profileForAgent(capture), downloadHeaders)
}

export const readScreenshotDownload = (res, capture, headers, { store } = {}) => {
  const payload = capture.status === 'completed' ? screenshotPayloadForCapture(capture) : null
  const downloadHeaders = {
    ...headers,
    ...(payload
      ? {
          'Content-Type': payload.mimeType,
          'Content-Disposition': `attachment; filename="stackprism-${capture.id}-screenshot.${payload.extension}"`,
          'Content-Length': payload.bytes.byteLength
        }
      : {})
  }
  if (capture.status === 'expired') return fail(res, 410, 'CAPTURE_RESULT_EXPIRED', 'Capture result expired.', {}, downloadHeaders)
  if (capture.status !== 'completed')
    return fail(res, 409, 'INVALID_REQUEST', 'Capture screenshot is not ready.', { status: capture.status }, downloadHeaders)
  if (!payload) return fail(res, 404, 'NOT_FOUND', 'Capture screenshot is not available.', {}, downloadHeaders)
  store?.touchResult?.(capture)
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...downloadHeaders
  })
  res.end(payload.bytes)
}
