import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { requestBinary } from './capture-runtime.mjs'

const stableScreenshotNote =
  'Screenshot image base64 is intentionally omitted from this Profile JSON. To inspect actual visual appearance, open or download the image from downloadUrl.'

const screenshotExtensionForMimeType = value => {
  const mimeType = String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  return 'jpg'
}

const defaultScreenshotPathFor = (profilePath, screenshot) => {
  const outputPath = resolve(profilePath)
  const outputExtension = extname(outputPath)
  const stem = outputExtension ? outputPath.slice(0, -outputExtension.length) : outputPath
  return `${stem}-screenshot.${screenshotExtensionForMimeType(screenshot?.mimeType)}`
}

const screenshotPathFor = (args, screenshot) => resolve(args.screenshotOut || defaultScreenshotPathFor(args.out, screenshot))

const applyStableScreenshotReference = (profile, artifact) => {
  const screenshot = profile.visualProfile?.screenshot
  if (!screenshot || typeof screenshot !== 'object' || !artifact) return profile
  screenshot.downloadUrl = artifact.downloadUrl
  screenshot.downloadMethod = 'file'
  screenshot.localPath = artifact.path
  screenshot.byteLength = artifact.byteLength
  screenshot.lifecycle = {
    ...(screenshot.lifecycle || {}),
    requiresLocalBridge: false,
    availableUntil: '',
    note: 'The capture helper downloaded this screenshot to localPath. The image remains available until the local file is moved or deleted.'
  }
  screenshot.note = stableScreenshotNote
  const visualReference = profile.agentGuidance?.recreationPlan?.visualReference
  if (visualReference && typeof visualReference === 'object') {
    visualReference.screenshotDownloadUrl = artifact.downloadUrl
    visualReference.screenshotLocalPath = artifact.path
    visualReference.screenshotDownloadHint =
      'To inspect actual visual appearance, open or download the screenshot image from visualProfile.screenshot.downloadUrl. The Profile JSON intentionally does not include screenshot base64.'
    visualReference.screenshotAvailableUntil = ''
    visualReference.screenshotByteLength = artifact.byteLength
  }
  return profile
}

export const writeScreenshotArtifact = async ({ args, profile, token, timeoutMs }) => {
  const screenshot = profile.visualProfile?.screenshot
  if (!screenshot?.downloadUrl) return false
  const result = await requestBinary(screenshot.downloadUrl, token, { timeoutMs })
  const path = screenshotPathFor(args, screenshot)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, result.bytes)
  const artifact = {
    path,
    downloadUrl: pathToFileURL(path).href,
    byteLength: result.bytes.byteLength,
    contentType: result.contentType || screenshot.mimeType || ''
  }
  applyStableScreenshotReference(profile, artifact)
  return artifact
}
