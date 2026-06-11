# CR-AGENT-BRIDGE-FIREFOX-E2E-2026-06-09

## Scope

This report records the Firefox Agent Bridge compatibility fix and the live Firefox E2E verification performed on 2026-06-09.

The verified change set covers Firefox fallback paths for:

- Agent Bridge client injection.
- Content observer injection.
- Page detector injection in the MAIN world.
- Experience profiler injection.

## Verdict

Firefox Agent Bridge E2E passed against Firefox 151.0.3.

The live run covered extension settings, Firefox data collection permission UI, Agent Bridge opt-in, allow-all-network-targets opt-in for the controlled local target, real extension popup opening, bridge capture orchestration, profile generation, and technology detection.

Firefox `chrome.scripting.executeScript({ files })` is not reliable for the affected extension assets in this environment. The implementation keeps file injection as the primary path and uses explicit inline `func` fallbacks when file injection fails. The experience profiler fallback marks the profile with `firefox_inline_experience_profile` in `limitations`.

## Live Firefox Evidence

| Item                | Result                                                          |
| ------------------- | --------------------------------------------------------------- |
| Firefox version     | `Mozilla Firefox 151.0.3`                                       |
| E2E command         | `python3 /tmp/stackprism_firefox_full_e2e.py`                   |
| Capture status      | `completed`                                                     |
| Capture phase       | `cleanup`                                                       |
| Result file         | `/tmp/stackprism-firefox-e2e/bridge-result.json`                |
| Profile file        | `/tmp/stackprism-firefox-e2e/bridge-profile.json`               |
| Profile schema      | `stackprism.site_experience_profile.v1`                         |
| Profile size        | `10255` bytes                                                   |
| Settings screenshot | `/tmp/stackprism-firefox-e2e/settings-agent-bridge-enabled.png` |
| Popup screenshot    | `/tmp/stackprism-firefox-e2e/action-popup.png`                  |

Detected technologies in the generated profile:

- React
- Vue
- Python http.server
- Express
- Node.js
- PHP
- JavaScript
- Discourse
- WordPress

Profile limitations included:

- `passive_interaction_only`
- `firefox_inline_experience_profile`
- `viewport_emulation_unsupported`
- `screenshot_metadata_not_requested`
- `screenshot_image_not_requested`
- `interaction_section_not_requested`
- `ux_section_not_requested`
- `assets_section_not_requested`

## Verification Commands

| Command                                                                                                                                                | Exit | Result                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---: | ----------------------------------------------------------------- |
| `node --test --test-timeout=60000 tests/agent-capture-orchestration.test.mjs`                                                                          |    0 | 98 tests passed                                                   |
| `node --test --test-timeout=60000 tests/agent-bridge-handshake.test.mjs tests/agent-bridge-manifest.test.mjs tests/experience-profile-format.test.mjs` |    0 | 32 tests passed                                                   |
| `node --test --test-timeout=60000 tests/agent-capture-orchestration.test.mjs tests/experience-profile-format.test.mjs`                                 |    0 | 107 tests passed                                                  |
| `pnpm run test:unit`                                                                                                                                   |    0 | 332 tests passed                                                  |
| `pnpm run lint`                                                                                                                                        |    0 | Passed                                                            |
| `pnpm run typecheck`                                                                                                                                   |    0 | Passed; includes `vue-tsc --noEmit` and `pnpm build`              |
| `pnpm run docs:build`                                                                                                                                  |    0 | Passed                                                            |
| `python3 -m py_compile agent-skill/stackprism-site-experience/scripts/stackprism_bridge_lib/*.py`                                                      |    0 | Passed                                                            |
| `pnpm run build:firefox`                                                                                                                               |    0 | Passed; generated `release/stackprism-v1.3.74.xpi` before cleanup |
| `git diff --check`                                                                                                                                     |    0 | Passed                                                            |
| `git diff --cached --check`                                                                                                                            |    0 | Passed                                                            |

Build artifacts generated by the verification were removed after validation:

- `dist`
- `dist-firefox`
- `public/injected`
- `docs/.vitepress/dist`
- `release/stackprism-v1.3.74.xpi`

Existing release artifacts were left untouched.

## Residual Risk

This run proves the local Firefox E2E path for an unpacked/test extension environment. It does not prove Firefox Add-ons store review, signed package rollout, or behavior in unrelated user profiles.
