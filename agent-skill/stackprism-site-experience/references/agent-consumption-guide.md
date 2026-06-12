# Agent Consumption Guide

Use the profile as evidence for recreating a similar website, not as a copyable page dump. For recreation briefs, structure the brief from `agentGuidance.recreationPlan` plus screenshot-backed visual evidence when available.

1. Read `limitations` first. Do not infer that a missing section means the site lacks that feature.
2. Start from `agentGuidance.recreationPlan`; it turns observed evidence into implementation order, design tokens, layout blueprint, component inventory, interaction checklist, UX checklist, asset hints, visual reference, and verification checks.
3. Open or download `visualProfile.screenshot.downloadUrl` only when present and needed for visual comparison. The Profile JSON intentionally omits screenshot base64; do not assume the JSON text alone shows the final visual appearance.
4. Cross-check `visualProfile`, `layoutProfile`, and `componentProfile` before choosing layout, density, and component patterns.
5. Use `techProfile` to select equivalent implementation tools only when the destination project has no stronger local convention.
6. Use `interactionProfile` conservatively. The first version is passive and does not click or submit controls.
7. Use `assetProfile` for dependency and CDN clues, but do not copy signed or sensitive URLs.
8. Implement against the destination project's conventions, then verify with `agentGuidance.recreationPlan.verificationChecklist`, screenshots, DOM geometry, and interaction smoke tests.

Recreation brief structure:

- Evidence and limitations: target URL, final URL, captured viewport names and dimensions, screenshot availability, unavailable sections, and explicit non-claims.
- Technical direction: observed stack, destination-project conventions that override the source, and dependencies worth matching or replacing.
- Visual direction: screenshot-backed colors, typography, spacing, density, hierarchy, and any visual unknowns.
- Layout and components: first-viewport structure, landmarks, repeated regions, component inventory, states, and responsive assumptions that still need verification.
- Interaction and UX: observed hover, focus, transitions, scroll, loading, navigation cues, friction points, and workflows not actively exercised.
- Assets and verification: key resource domains, asset handling notes, acceptance checks, smoke tests, and follow-up captures needed before claiming parity.

Hard evidence gates:

- If `visualProfile` or screenshot evidence is missing, do not claim visual parity. Limit the conclusion to the available sections, or recapture with `include` containing `visual` and screenshot capture enabled.
- A tech-only profile supports technology, dependency, and runtime observations only. It is not sufficient for UI implementation, visual comparison, or visual verification.
- A reduced non-visual retry supports structural, technology, and limited UX findings only. Do not claim pixel-level accuracy, exact colors, exact spacing, visual parity, or that missing visual elements do not exist.
- A reduced retry is valid only if it preserved the original capture context: same target URL, browser/profile opener env, and target policy flags such as `--allow-private-network`.
- Destination project conventions override the source page's stack for component library, routing, state, CSS architecture, test framework, accessibility baseline, and build tooling.
- Interaction smoke tests should cover viewport, key path, hover and focus states, empty and error states, overlays or navigation, scroll and sticky behavior, responsive breakpoint, screenshot or DOM geometry evidence, and explicit limitations.
- StackPrism experience capture is passive. It can report observed interaction cues, but it does not click, type, submit forms, or exercise workflows.

The bridge page status preview, `copyText`, and grouped `contentSummary` are convenience views derived from the completed profile. Raw `/profile` access still requires the API token.

Safe report fields are sanitized error code/message/details, redacted target and final URL, artifact paths outside the repository, hashes, file sizes, exit code, extension version, browser/profile label, `screenshotWritten`, `profileDownloadReady`, `techCount`, limitations, and whether `--allow-private-network` was used. Never copy `apiToken`, `bridgeToken`, nonce, token-bearing bridge URLs, `Authorization` headers, raw ready JSON, raw profile JSON containing private content, screenshot data URLs, cookies, credentials, signed URLs, account data, or unredacted `captureId` into downstream code, issue text, PR summaries, or prompts.

Never reproduce private text, account identifiers, credentials, tokens, or user-specific data from a target page. Screenshots are not pixel-redacted, so do not request or consume them for login-protected, account-specific, billing, admin, inbox, dashboard, internal, or private user pages, even when the user owns the account. Use this response and ask for safer inputs instead:

```text
I cannot automatically capture that private or logged-in page with StackPrism. Please provide a public demo URL, a desensitized test-environment URL, a design brief, or an anonymized page-structure summary. If you already have a redacted screenshot or recording with private content removed, you can provide it; do not create a new screenshot of the private page for this request. I can use StackPrism only after the target is public or explicitly desensitized.
```

Localhost or intranet targets are acceptable only when they are public, demo, or explicitly desensitized development pages. If the user refers to the "current browser page" without a URL, ask for a public or desensitized `http:` or `https:` URL first instead of using active-tab capture. Accept redacted screenshots or recordings only when the user already has them and has removed private content; do not ask the user to create new screenshots of private pages.
