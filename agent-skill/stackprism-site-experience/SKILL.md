---
name: stackprism-site-experience
description: Use when an AI agent must capture a StackPrism Agent Bridge profile from a specific http(s) URL for browser-observed evidence, website recreation, UX comparison, live fact verification, or Agent Bridge E2E verification. Do not use for generic UI edits, backend-only work, web search, or StackPrism internal code review unless a target URL profile capture is required.
---

# StackPrism Site Experience

StackPrism helps AI agents recreate websites from real browser evidence: tech stack, UI design, layout, components, interactions, UX, and assets.

Use this skill proactively when the task involves:

- Capturing a StackPrism profile or browser evidence from a specific `http:` or `https:` URL.
- Building or cloning a page, app, component set, landing page, dashboard, or marketing site similar to an existing URL.
- Reviewing or improving UI/UX by comparing against a live product, competitor, reference site, or production page.
- Choosing implementation details from evidence: detected technologies, visual tokens, layout density, component patterns, interaction behavior, asset dependencies, and first-order UX structure.
- Verifying that a target page's browser-observed facts match a design brief, audit claim, migration requirement, or Agent Bridge E2E claim.

Do not use this skill for backend-only tasks, generic web search, SEO content extraction, login-protected private data capture, generic UI work with no target URL, or StackPrism internal source review, refactor, or maintenance unless the task actually needs a target URL Profile capture through Agent Bridge.

## Preconditions

- The user has installed the StackPrism extension in the browser profile that will open the bridge page.
- StackPrism Agent Bridge is enabled in the extension settings for that local browser profile.
- The target URL is `http:` or `https:`.
- For local development targets, first confirm the dev server is running and the URL is reachable before starting the bridge helper.
- Local development targets require both extension settings consent for all network targets and helper/request option `"allowPrivateNetworkTarget": true`.
- Localhost support is only for public, demo, or explicitly desensitized development pages. Do not capture local, intranet, or internal pages that contain login state, account data, billing data, inbox content, customer data, or other private information.
- Public hostnames routed through common local proxy/TUN fake-IP ranges such as `198.18.0.0/15` are supported by default. Direct private IPs, `localhost`, RFC1918, link-local, and other special-use targets still require `"allowPrivateNetworkTarget": true`.
- If the user has enabled the extension's high-risk "allow all network targets" setting, still pass `--allow-private-network` for local development, direct private IP, or real intranet targets; the extension setting affects the browser-observed final target gate, while the helper's create-stage URL policy remains explicit per capture.

## Private Page Boundary

Do not run the helper or manual Bridge API against login-protected, account-specific, billing, admin, inbox, dashboard, internal, or private user pages, even when the user says they own the account. Screenshots are not pixel-redacted and profile summaries can still expose private text patterns.

Use this refusal template:

```text
I cannot automatically capture that private or logged-in page with StackPrism. Please provide a public demo URL, a desensitized test-environment URL, a design brief, or an anonymized page-structure summary. If you already have a redacted screenshot or recording with private content removed, you can provide it; do not create a new screenshot of the private page for this request. I can use StackPrism only after the target is public or explicitly desensitized.
```

If the user provides a safe public demo or desensitized target, continue with the normal capture flow. Do not request screenshots for private pages, do not ask the user to create screenshots for private pages, and do not add `--allow-private-network` as a workaround for privacy.

If the user says the target is "the current browser page" but does not provide a URL, do not use `active_tab` or infer a target. Ask for a public or explicitly desensitized `http:` or `https:` URL first. Accept a user-provided redacted screenshot or recording only if the user already has one and has removed private content; do not ask the user to create a screenshot of a private page for StackPrism capture.

## Preferred Capture Command

Use the capture helper first. It keeps the bridge child process alive, creates one fresh bridge per capture, polls the profile endpoint, and can decode the optional screenshot:

```bash
cd <repo-root>
node agent-skill/stackprism-site-experience/scripts/capture-site.mjs \
  --url https://target.example \
  --out /tmp/stackprism-profile.json \
  --result-out /tmp/stackprism-result.json \
  --screenshot-out /tmp/stackprism-screenshot.jpg \
  --include tech,visual,layout,components,interaction,ux,assets
```

Set `STACKPRISM_BROWSER_OPEN_COMMAND` and `STACKPRISM_BROWSER_OPEN_ARGS_JSON` only when the default opener is not the browser/profile with StackPrism installed. On macOS, for example, use `STACKPRISM_BROWSER_OPEN_COMMAND=open` and `STACKPRISM_BROWSER_OPEN_ARGS_JSON='["-a","Google Chrome"]'` to force Chrome.

For localhost or direct private-network development targets, use a full explicit command and record that the override was controlled. Replace `<profile-directory-with-stackprism>` with the browser profile that actually has StackPrism installed; do not use `Default` unless the user confirms StackPrism is installed and enabled there.

```bash
cd <repo-root>
STACKPRISM_BROWSER_OPEN_COMMAND="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
STACKPRISM_BROWSER_OPEN_ARGS_JSON='["--profile-directory=<profile-directory-with-stackprism>"]' \
node agent-skill/stackprism-site-experience/scripts/capture-site.mjs \
  --url http://127.0.0.1:5173/ \
  --allow-private-network \
  --out /tmp/stackprism-local-profile.json \
  --result-out /tmp/stackprism-local-result.json \
  --screenshot-out /tmp/stackprism-local-screenshot.jpg \
  --include tech,visual,layout,components,interaction,ux,assets
```

The helper prints one JSON summary on stdout. On failure it writes one JSON error object to stderr with `error.code`, `error.message`, and sanitized `error.details`. `screenshotPresent` means the profile contains screenshot evidence; `screenshotWritten` means the screenshot image was written to `screenshotPath` and can be opened by image-capable coding tools. If `--screenshot-out` is omitted, the helper writes a sidecar image next to `--out` and rewrites the Profile screenshot reference to that local file URL before saving the JSON.

Reference files are available for deeper consumption details. Read `references/site-experience-profile-schema.md` when implementing or validating Profile schema handling, and read `references/agent-consumption-guide.md` when translating a captured Profile into a target UI or app implementation.

By default the helper opens a fresh target tab and does not force-refresh it. Use `--force-refresh` only when you need a controlled cache-bypass capture; this avoids treating browser-superseded initial navigations as target load failures on large public sites.

Each bridge API request has a bounded timeout. The default is 30000 ms; use `--request-timeout-ms <ms>` only when a slower local browser opener or debug bridge needs more time. If it exits with `BRIDGE_REQUEST_TIMEOUT`, stop that attempt and start one fresh helper process rather than reusing a partial capture.

The opened bridge page is also a local result workbench. After completion it shows the target URL, screenshot preview, click-to-enlarge preview, screenshot download/copy buttons, a Profile download button for the current capture, a one-click Markdown summary, and grouped profile content cards. That page uses the bridge-token status preview for rendering and a current-capture download endpoint for saving the completed Profile; direct raw `/profile` API reads still require the API token. For programmatic use, prefer the helper output or the API-token profile endpoint.

Profile JSON is standard JSON and cannot contain comments. Screenshot handling instructions are carried in `visualProfile.screenshot.note`, `visualProfile.screenshot.profileJsonNote`, and `agentGuidance.recreationPlan.visualReference.screenshotDownloadHint`.

If the helper exits with `PRIVATE_NETWORK_TARGET_BLOCKED` for a local development, direct private IP, or real intranet target, first confirm the StackPrism settings page has the high-risk "allow all network targets" option enabled for this browser profile, then run a second fresh helper process with `--allow-private-network` and record that this was a controlled override. Do not reuse the first bridge URL, capture id, session, or token. Do not add `--allow-private-network` just because a public hostname is routed through `198.18.0.0/15`; that proxy/TUN case is allowed by default.

If the helper exits with `CAPTURE_BUSY`, wait a few seconds, stop any bridge child process from that attempt, and run one fresh helper process. Do not keep polling an old capture after a terminal or stale status.

For large-page transfer failures, use a bounded retry ladder instead of inventing partial results. On `BRIDGE_TRANSPORT_DISCONNECTED`, `PROFILE_TRANSPORT_FAILED`, `PROFILE_CHUNK_MISSING`, `CAPTURE_TIMEOUT`, or `BRIDGE_REQUEST_TIMEOUT`, stop the old bridge child process and start a fresh helper.

Retry attempts must preserve the original capture context exactly: the same `TARGET_URL`, same `STACKPRISM_BROWSER_OPEN_COMMAND`, same `STACKPRISM_BROWSER_OPEN_ARGS_JSON`, same browser/profile, and same target policy flags such as `--allow-private-network`. If the first command used command-prefix env assignments, repeat those same assignments on every reduced retry. If it used `--allow-private-network`, add that flag directly after `--url "$TARGET_URL"` on every reduced retry. The only intended retry changes are `--include`, `--max-resource-urls`, and the final `--no-screenshot` boundary.

First keep visual evidence but reduce high-volume sections:

```bash
cd <repo-root>
# Public target form. For an original local/private attempt, add
# --allow-private-network immediately after --url "$TARGET_URL".
# Repeat any original STACKPRISM_BROWSER_OPEN_COMMAND/ARGS_JSON env prefix here.
node agent-skill/stackprism-site-experience/scripts/capture-site.mjs \
  --url "$TARGET_URL" \
  --out /tmp/stackprism-profile-retry-1.json \
  --result-out /tmp/stackprism-result-retry-1.json \
  --screenshot-out /tmp/stackprism-screenshot-retry-1.jpg \
  --include tech,visual,layout,components,ux \
  --max-resource-urls 150
```

If that still fails and the user explicitly accepts losing screenshot evidence, run one final reduced non-visual attempt, then stop and report the remaining failure. Do not run the final `--no-screenshot` retry until the user confirms that losing screenshot and visual evidence is acceptable, unless that approval is already stated in the current request.

Before the final non-visual attempt, state this boundary explicitly: "I can retry without screenshot evidence, but the result can only support structural, technology, component, and limited UX findings; it cannot support visual parity or exact visual claims."

```bash
cd <repo-root>
# Preserve the same browser/profile env. If the original command used
# --allow-private-network, add it immediately after --url "$TARGET_URL".
node agent-skill/stackprism-site-experience/scripts/capture-site.mjs \
  --url "$TARGET_URL" \
  --out /tmp/stackprism-profile-retry-2.json \
  --result-out /tmp/stackprism-result-retry-2.json \
  --include tech,layout,components,ux \
  --max-resource-urls 50 \
  --no-screenshot
```

Without `visualProfile` or screenshot evidence, only claim structural, technology, and limited UX findings from the returned sections. Do not claim visual parity, pixel-level accuracy, exact colors, exact spacing, or that missing visual elements do not exist.

The current experience profile is passive. It can surface observed hover, focus, transition, animation, loading, scroll, and UX cues, but it does not click, type, submit forms, or exercise workflows. For interaction comparison, pair the profile with destination-app smoke tests and state which interactions were not actively exercised.

When wrapping retries in shell scripts, avoid reserved or readonly shell variable names such as `status` in zsh. Use names like `capture_status` instead so a successful helper run is not masked by wrapper errors.

## Advanced Bridge API

All script paths in this skill are repository-relative. Run commands from the StackPrism checkout root, or resolve `agent-skill/...` to an absolute script path before spawning the bridge from another working directory. These scripts are repo-local tools, not global executables. Use the manual bridge API only when you need protocol-level debugging or custom orchestration beyond the capture helper.

For advanced use, prefer the JavaScript bridge:

```bash
cd <repo-root>
node agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs
```

Use the Python fallback only when Node is unavailable:

```bash
cd <repo-root>
python3 agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py
```

The Python fallback is a compatibility path built on the standard library HTTP server. Prefer the JavaScript bridge for long-running or repeated captures; if the Python fallback stalls under local connection pressure, stop the child process, start a fresh bridge, and retry the capture instead of reusing partial state.

Read exactly one JSON line from stdout within 10 seconds. Treat timeout as `BRIDGE_START_TIMEOUT`, any non-JSON stdout before readiness as `BRIDGE_READY_PARSE_FAILED`, and a missing or mismatched `protocolVersion` as `BRIDGE_PROTOCOL_UNSUPPORTED`.

The ready line contains `baseUrl`, `healthUrl`, and `apiToken`. Send ordinary logs to stderr only. Never paste or store the token in source files.

Always stop the bridge child process in a `finally` block after the capture finishes or fails. On startup failure, protocol mismatch, or parse failure, terminate the child process and wait for it to exit before reporting the error. If a fixed `STACKPRISM_BRIDGE_PORT` is already occupied, the script exits non-zero with `PORT_IN_USE` on stderr and no ready JSON.

If StackPrism is installed in a non-default browser or browser profile, set `STACKPRISM_BROWSER_OPEN_COMMAND` to the platform opener or browser executable, and put only opener/profile arguments in `STACKPRISM_BROWSER_OPEN_ARGS_JSON` as a JSON string array. The bridge script appends the bridge URL as the final argv item. Do not include the bridge URL in the environment variable.

Keep the executable and arguments separate. For example, use `STACKPRISM_BROWSER_OPEN_COMMAND=open` with `STACKPRISM_BROWSER_OPEN_ARGS_JSON='["-a","Google Chrome"]'`, not `STACKPRISM_BROWSER_OPEN_COMMAND='open -a Google Chrome'`.

Platform notes:

- macOS default opener: `open`. To force Chrome, use `STACKPRISM_BROWSER_OPEN_COMMAND=open` and `STACKPRISM_BROWSER_OPEN_ARGS_JSON='["-a","Google Chrome"]'`. To select a Chrome profile, use the Chrome executable as the command and pass profile args, for example `["--profile-directory=Default"]`.
- Firefox profiles: set `STACKPRISM_BROWSER_OPEN_COMMAND` to the Firefox executable and put profile arguments in `STACKPRISM_BROWSER_OPEN_ARGS_JSON`, for example `["-P","default-release"]` or `["--profile","/absolute/path/to/profile"]`. Do not pass the bridge URL in those args.
- Windows default opener: command `rundll32.exe` with the built-in argument `url.dll,FileProtocolHandler`. To force Chrome or Edge, set `STACKPRISM_BROWSER_OPEN_COMMAND` to the full browser `.exe` path and put profile args such as `["--profile-directory=Default"]` in `STACKPRISM_BROWSER_OPEN_ARGS_JSON`.
- Linux default opener: `xdg-open`. To force Chrome or Chromium, set `STACKPRISM_BROWSER_OPEN_COMMAND` to `google-chrome`, `chromium`, or the absolute executable path, and put profile args such as `["--profile-directory=Default"]` in `STACKPRISM_BROWSER_OPEN_ARGS_JSON`.

Cross-platform explicit profile examples:

Set environment variables with the syntax of the current shell; the examples below describe the values, not portable copy-paste shell assignments.

- Windows Chrome: set `STACKPRISM_BROWSER_OPEN_COMMAND` to `C:\Program Files\Google\Chrome\Application\chrome.exe` with `STACKPRISM_BROWSER_OPEN_ARGS_JSON=["--profile-directory=<profile-directory-with-stackprism>"]`.
- Windows Edge: use the full `msedge.exe` path and the same `--profile-directory=<profile-directory-with-stackprism>` args JSON.
- Linux Chrome/Chromium: `STACKPRISM_BROWSER_OPEN_COMMAND=google-chrome` or `chromium` with `STACKPRISM_BROWSER_OPEN_ARGS_JSON=["--profile-directory=<profile-directory-with-stackprism>"]`.
- Linux Firefox: `STACKPRISM_BROWSER_OPEN_COMMAND=firefox` with `STACKPRISM_BROWSER_OPEN_ARGS_JSON=["-P","<firefox-profile-with-stackprism>"]`.

## Firefox E2E Validation

For Firefox Agent Bridge E2E verification, require an exact safe public `http:` or `https:` smoke URL. If no exact safe public smoke URL is provided, ask for one; do not choose an arbitrary public page and do not use `https://example.com` as a default target.

Use an explicit Firefox executable and profile so the bridge opens in the profile where StackPrism is installed:

```bash
cd <repo-root>
STACKPRISM_BROWSER_OPEN_COMMAND="/Applications/Firefox.app/Contents/MacOS/firefox" \
STACKPRISM_BROWSER_OPEN_ARGS_JSON='["-P","<firefox-profile-with-stackprism>"]' \
node agent-skill/stackprism-site-experience/scripts/capture-site.mjs \
  --url "$TARGET_URL" \
  --out /tmp/stackprism-firefox-profile.json \
  --result-out /tmp/stackprism-firefox-result.json \
  --screenshot-out /tmp/stackprism-firefox-screenshot.jpg \
  --include tech,visual,layout,components,interaction,ux,assets
```

If the profile is identified by path instead of name, use `STACKPRISM_BROWSER_OPEN_ARGS_JSON='["--profile","/absolute/path/to/firefox-profile"]'`. In the E2E manifest, set `browserName` to `Firefox` and set `profileIdentifier` to the exact `-P` profile name or `--profile` path label used for the run.

## Capture A Target

Call `POST /v1/captures` with `Authorization: Bearer {apiToken}`:

```json
{
  "url": "https://target.example",
  "mode": "experience",
  "waitMs": 3000,
  "include": ["tech", "visual", "layout", "components", "interaction", "ux", "assets"],
  "viewports": [{ "name": "desktop", "width": 1440, "height": 900, "deviceScaleFactor": 1 }],
  "options": {
    "forceRefresh": false,
    "captureScreenshotMetadata": false,
    "captureScreenshot": true,
    "keepTabOpen": false,
    "allowPrivateNetworkTarget": false,
    "targetMode": "reuse_or_new_tab",
    "maxResourceUrls": 300
  }
}
```

Use the real target URL for the task. Do not treat `https://example.com` as the default smoke target. Public hostnames routed through `198.18.*` by local proxy/TUN software are accepted by default, but direct private IPs, `localhost`, RFC1918, link-local, and real intranet targets remain fail-closed unless private-network targets are explicitly allowed for a controlled test.

Then poll `GET /v1/captures/{id}` and read `GET /v1/captures/{id}/profile` when status is `completed`.

If the consuming model can read images, set `"captureScreenshot": true` with `include` containing `"visual"`. Chrome may capture the visible target viewport and the saved Profile will expose it as `visualProfile.screenshot.downloadUrl`, not as embedded base64. To inspect actual visual appearance, download or open that image. When using `capture-site.mjs`, the helper downloads the image while the bridge is still alive and rewrites `downloadUrl` to a local `file://` URL plus `localPath`; this remains available after the bridge exits as long as the file is not moved or deleted. When reading directly from the live bridge API or manually downloading from the bridge page, the screenshot URL is a temporary `127.0.0.1` endpoint and must be used before the local bridge exits or the capture result expires. The screenshot is not text-redacted pixel by pixel, so do not request it for login-protected or private user pages.

Large pages can produce multi-chunk profile transfers. If the browser extension reports `BRIDGE_TRANSPORT_DISCONNECTED`, `PROFILE_TRANSPORT_FAILED`, `PROFILE_CHUNK_MISSING`, or `CAPTURE_TIMEOUT`, treat the capture as failed and follow the bounded retry ladder above. Do not synthesize a profile from partial chunks.

Handle user-actionable failures explicitly:

- `AGENT_BRIDGE_DISABLED`: ask the user to enable Agent Bridge in the StackPrism settings for this local browser profile. Do not retry or fall back to a mock profile.
- `EXTENSION_NOT_CONNECTED`: the opened browser/profile probably does not have StackPrism installed or enabled. Set `STACKPRISM_BROWSER_OPEN_COMMAND` and `STACKPRISM_BROWSER_OPEN_ARGS_JSON` for the correct Chrome, Edge, or Firefox profile.
- `BROWSER_OPEN_FAILED`: surface the sanitized stderr/details and keep the capture failed. Do not ask the user to paste a token-bearing bridge URL.

## E2E Evidence Manifest

For Agent Bridge E2E validation, write evidence outside the repository or to an explicitly ignored artifact directory. Record this manifest shape in the report:

- `browserName`, `browserVersion`, `profileIdentifier`, `extensionVersion`, and `agentBridgeEnabled`.
- `targetUrl`, `finalUrl`, `privateNetworkOverrideUsed`, command template, exit code, and parsed stdout/stderr JSON status.
- `errorCode`, `errorMessage`, and sanitized `error.details` when failed.
- `profilePath`, `resultPath`, `screenshotPath`, file sizes, SHA-256 hashes, `screenshotWritten`, `profileDownloadReady`, `techCount`, `limitations`, and uncovered risks.

Safe to report: sanitized error code/message/details, target/final URL after redaction, artifact paths outside the repo, hashes, file sizes, exit code, extension version, browser/profile label, and whether `--allow-private-network` was used.

Never paste or commit: `apiToken`, `bridgeToken`, nonce, token-bearing bridge URLs, `Authorization` headers, raw ready JSON, raw profile JSON containing private content, screenshot data URLs, cookies, credentials, signed URLs, or account data. `captureId` may appear in local result artifacts, but redact it from public issue text and PR summaries unless it is needed for a local-only debug handoff.

Collect file metadata with ordinary shell tools after the helper exits:

```bash
shasum -a 256 /tmp/stackprism-profile.json /tmp/stackprism-result.json /tmp/stackprism-screenshot.jpg
stat -f '%N %z bytes' /tmp/stackprism-profile.json /tmp/stackprism-result.json /tmp/stackprism-screenshot.jpg
```

Use this public report template instead of pasting raw stdout:

```json
{
  "browserName": "<Chrome|Edge|Firefox>",
  "browserVersion": "recorded separately",
  "profileIdentifier": "<profile-label-used-for-this-run>",
  "extensionVersion": "1.3.74",
  "agentBridgeEnabled": true,
  "targetUrl": "https://target.example/",
  "finalUrl": "https://target.example/",
  "privateNetworkOverrideUsed": false,
  "exitCode": 0,
  "stdout": {
    "ok": true,
    "captureId": "[redacted]",
    "screenshotWritten": true,
    "profileDownloadReady": true,
    "techCount": 0
  },
  "artifacts": {
    "profilePath": "/tmp/stackprism-profile.json",
    "resultPath": "/tmp/stackprism-result.json",
    "screenshotPath": "/tmp/stackprism-screenshot.jpg",
    "sha256": ["recorded separately"],
    "fileSizes": ["recorded separately"]
  },
  "limitations": []
}
```

If browser/profile identity matters for the E2E claim, record one non-sensitive proof such as the browser name/version from the browser UI or CLI, the profile label used in `STACKPRISM_BROWSER_OPEN_ARGS_JSON`, the StackPrism extension version shown on the extension details page, and the Agent Bridge enabled state shown in StackPrism settings. Do not include extension internal UUIDs, bridge URLs, or tokens.

## Use The Profile

- Read `limitations` first. Do not infer that a missing section means the site lacks that feature.
- When the user asks for a recreation brief, read `references/agent-consumption-guide.md` and structure the brief from `agentGuidance.recreationPlan` plus screenshot-backed visual evidence when available.
- Record the captured viewport names and dimensions in briefs and E2E notes. Do not infer mobile or responsive breakpoint behavior unless that viewport was captured or verified separately.
- Start from `agentGuidance.recreationPlan`. Follow its `implementationOrder`, then map `designTokens`, `layoutBlueprint`, `componentInventory`, `interactionChecklist`, `uxChecklist`, `assetHints`, `visualReference`, and `verificationChecklist` into the target project.
- Use `visualProfile.screenshot.downloadUrl` as an optional visual reference only when it is present and your model supports image input. The Profile JSON intentionally omits screenshot base64; download or open the image to see the actual visual effect, and do not use screenshots from login-protected or private pages because pixels are not redacted.
- Treat `techProfile` as implementation guidance, not a mandate to copy the source site's private stack.
- Prioritize layout density, visual hierarchy, interaction feedback, and information architecture.
- Respect `limitations`; missing fields may mean a section was not requested or was truncated.
- Verify the result with `agentGuidance.recreationPlan.verificationChecklist` plus destination-app screenshots, DOM geometry, and interaction smoke tests.
- Do not reproduce sensitive text, account data, tokens, signed URLs, or private user content.

## Trust Boundary

The first version trusts the local bridge process started by the user or agent. Loopback, nonce, and `bridgeToken` bind one capture to one local browser page, but they do not prove the process was not spoofed by another local process. The DOM-readable `bridgeToken` is also not secret from other installed extensions in the same browser profile.
