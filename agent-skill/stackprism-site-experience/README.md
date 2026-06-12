# StackPrism Site Experience Skill

This is a repo-local skill package for StackPrism Agent Bridge.

It is not automatically installed into Codex or any global skill registry. Run the scripts by path from this repository, or copy/symlink this directory into your agent's skill directory if you want global discovery.

Paths in this package are relative to the StackPrism repository root. If an agent starts from another working directory, it should either `cd <repo-root>` before launching the bridge or resolve `agent-skill/...` to an absolute script path. The bridge scripts are repo-local tools, not global commands.

## Scripts

- `scripts/capture-site.mjs`: preferred one-shot capture client. It starts the JavaScript bridge, keeps stdin open, creates the capture, polls for the completed profile, writes the profile JSON, downloads the screenshot image when present, and rewrites the Profile screenshot reference to the local image file before exiting.
- `scripts/stackprism-bridge.mjs`: JavaScript loopback bridge, preferred.
- `scripts/stackprism_bridge.py`: Python standard-library fallback.

The direct bridge scripts print a single ready JSON line to stdout after the HTTP server is bound. Logs and startup errors go to stderr.

Use `capture-site.mjs` for ordinary agent work. Use `stackprism-bridge.mjs` or the Python fallback directly only for protocol debugging or custom orchestration.

`capture-site.mjs` prints one JSON summary to stdout on success and one JSON error object to stderr on failure. It bounds each bridge API request with `--request-timeout-ms`, defaulting to 30000 ms, so a stalled local bridge fails explicitly instead of hanging the calling agent. It also accepts `--include tech,visual,layout,components,interaction,ux,assets` and `--max-resource-urls <n>` so retry attempts can reduce profile size without editing scripts.

The bridge page opened in the browser becomes a result workbench after completion: target URL, screenshot preview, enlarged screenshot preview, screenshot download/copy, one-click Markdown summary, and grouped profile content cards. The page reads only the status preview with its one-capture `bridgeToken`; raw `/profile` still requires the API token.

The JavaScript bridge and Python fallback intentionally share the same bridge page CSS and client script text. If `scripts/bridge/bridge-page-assets.mjs` changes, update `scripts/stackprism_bridge_lib/bridge_page_assets.py` in the same patch and keep `tests/stackprism_bridge_py.test.mjs` passing.

Profile JSON is standard JSON and cannot contain comments. Screenshot guidance is stored in `note`, `profileJsonNote`, and `agentGuidance.recreationPlan.visualReference.screenshotDownloadHint`. Screenshot base64 is intentionally omitted; open `visualProfile.screenshot.downloadUrl` to inspect the actual visual appearance.

Lifecycle: direct bridge screenshot links are valid only while the local bridge process is running and before the completed result TTL expires. The capture helper avoids that race by downloading the image during the live bridge window and saving a stable local `file://` URL plus `localPath` in the written Profile.

When selecting a non-default browser or profile, keep the opener executable and its arguments separate: `STACKPRISM_BROWSER_OPEN_COMMAND` is only the executable or platform opener, while `STACKPRISM_BROWSER_OPEN_ARGS_JSON` is a JSON string array of opener/profile arguments. The bridge URL is appended by the script as the final argv item.

Local development targets such as `localhost`, `127.0.0.1`, RFC1918 addresses, and real intranet hosts require both the extension's high-risk all-network-targets setting and the helper/request `--allow-private-network` override. Treat a `PRIVATE_NETWORK_TARGET_BLOCKED` response as a safety gate, not as a reason to reuse the old bridge URL. Localhost support is only for public, demo, or explicitly desensitized development pages; do not capture local or internal pages that contain private data.

For local development captures, open the browser profile where StackPrism is installed. Replace the profile placeholder below; use `Default` only if StackPrism is really enabled there.

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

Do not capture private or logged-in pages. Use a public demo URL, a desensitized test URL, a design brief, or an already-redacted screenshot/recording instead. Do not ask users to create new screenshots of private pages. If they say "current browser page" without a URL, ask for a public or desensitized `http:` or `https:` URL.

Large-page transfer failures should retry with less data, not partial results. Keep the same URL, browser/profile env, and private-network flag on every retry. First use `--include tech,visual,layout,components,ux --max-resource-urls 150`; only if the user accepts losing screenshot evidence, use `--include tech,layout,components,ux --max-resource-urls 50 --no-screenshot`.

For Firefox E2E, use an exact safe public URL and an explicit Firefox profile; if the URL is missing, ask for one and do not choose an arbitrary public page or `example.com`. For example, use `STACKPRISM_BROWSER_OPEN_COMMAND="/Applications/Firefox.app/Contents/MacOS/firefox"` with `STACKPRISM_BROWSER_OPEN_ARGS_JSON='["-P","<firefox-profile-with-stackprism>"]'`. Record `browserName: "Firefox"` and the profile identifier in the evidence.

For Agent Bridge E2E reports, record an evidence manifest outside the repository: browser/profile label, browser version, extension version, Agent Bridge status, target and final URL, command template, exit code, parsed stdout/stderr JSON, failure code, profile/result/screenshot paths, file sizes, SHA-256 hashes, `screenshotWritten`, `profileDownloadReady`, `techCount`, limitations, whether `--allow-private-network` was used, and uncovered risks. Never paste or commit `apiToken`, `bridgeToken`, nonce, token-bearing bridge URLs, `Authorization` headers, raw ready JSON, screenshot data URLs, cookies, credentials, signed URLs, account data, or unredacted `captureId`. Use `shasum -a 256` and `stat -f '%N %z bytes'` for artifact hashes and sizes, and redact `captureId` from any copied stdout summary.

## Security Notes

- API tokens are process-local and must not be written into files.
- The bridge binds to `127.0.0.1`.
- The browser extension must be explicitly enabled for Agent Bridge in the current browser profile.
- This first version does not defend against malicious local processes or malicious extensions in the same browser profile.
