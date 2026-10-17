<div align="center">

<img src="./public/repository.png" alt="StackPrism" />

# StackPrism — Web Tech Stack Detector

> Identify the web technology stack behind any page with a Manifest V3 browser extension for Chrome, Edge, and Firefox.

<a href="https://trendshift.io/repositories/27604?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-27604" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/27604/daily?language=TypeScript" alt="setube%2Fstackprism | Trendshift" width="250" height="55"/></a>

**English** · [简体中文](i18n/README.cn.md) · [繁體中文](i18n/README.zh-Hant.md) · [日本語](i18n/README.ja.md) · [Français](i18n/README.fr.md) · [Deutsch](i18n/README.de.md) · [Português](i18n/README.pt.md) · [Italiano](i18n/README.it.md) · [Čeština](i18n/README.cs.md) · [Polski](i18n/README.pl.md)

[Introduction](#introduction) • [Features](#features) • [Rule System](#rule-system) • [Caveats](#caveats) • [Contributing](#contributing) • [Sponsors](SPONSORS.md) • [Star History](#star-history) • [License](#license)

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/cagpdifljieeiajlhlcboelglkalofak?label=Chrome%20Web%20Store&color=FBBC04)](https://chromewebstore.google.com/detail/stackprism/cagpdifljieeiajlhlcboelglkalofak)
[![Edge Add-ons](https://img.shields.io/badge/dynamic/json?label=Edge%20Add-ons&query=%24.version&url=https%3A%2F%2Fmicrosoftedge.microsoft.com%2Faddons%2Fgetproductdetailsbycrxid%2Fojgmhlogaoiegdonnlnibeoikbleccno&prefix=v&color=00A4EF)](https://microsoftedge.microsoft.com/addons/detail/stackprism/ojgmhlogaoiegdonnlnibeoikbleccno)
[![Firefox Add-ons](https://img.shields.io/amo/v/stackprism?label=Firefox%20Add-ons&color=FF7139)](https://addons.mozilla.org/firefox/addon/stackprism/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4CAF50)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Firefox-26A69A)](#installation)
[![PRs welcome!](https://img.shields.io/badge/PRs-Welcome-FF6F61)](https://github.com/setube/stackprism/issues)

</div>

## Introduction

An experimental [Node.js CLI and SDK](packages/stackprism/README.md) reuses the shared detector. Build with `bun run build:sdk`; the package is not yet published to npm.

StackPrism is a **Manifest V3** browser extension for Chrome, Edge, and Firefox that identifies the tech stack used by any webpage.

Unlike most similar tools that only scan HTML resource URLs, StackPrism runs 4 independent detection channels in parallel:

- **Static scan** — on page load, an injected script scans the DOM, globals, CSS class names, CSS variables, and `<meta>` tags
- **Response header observation** — a Service Worker listens to `webRequest.onHeadersReceived` and captures response headers and HTTP version for the main document, XHR requests, and iframes
- **Dynamic resource monitoring** — a content script uses `PerformanceObserver` + `MutationObserver` to accumulate scripts, styles, iframes, and feeds loaded after user interaction
- **JS copyright comment scanning** — the background asynchronously fetches the first few hundred bytes of main bundles to identify third-party dependencies packed into `index/main/vendor` chunks via their copyright headers

Results from all 4 channels are merged and deduplicated, grouped into 50+ categories, with active suppression of **spoofed headers, self-referential detections, and fuzzy false positives**.

### Technical Highlights

- **MV3 service worker architecture** — no persistent background process; event-driven, low memory footprint
- **Rules as data** — 50+ JSON rule files (`public/rules/`) maintained centrally; at build time a precompiler injects `__hints` (top-3 longest literal segments) and `__keywordCombined` (merged regex) into each leaf rule, so the runtime only evaluates candidate matches

### Detection Coverage

| Dimension   | Category examples                                                          |
| ----------- | -------------------------------------------------------------------------- |
| Frontend    | Frontend frameworks / UI frameworks / Frontend libraries / Build & runtime |
| Backend     | Web servers / Backend frameworks / CDN & hosting / Languages               |
| Content     | CMS / Themes & templates / E-commerce / RSS                                |
| Third-party | SaaS / APM / AI models / Social login / Payments                           |
| Marketing   | Ads / Marketing / Analytics / Tag managers                                 |
| Security    | WAF / HTTPS / HTTP/2 / HTTP/3 / CSP / Cookie consent                       |

### UI Languages

The popup and settings page are available in 9 languages, auto-detected from your browser locale:

🇨🇳 简体中文 · 🇹🇼 繁體中文 · 🇯🇵 日本語 · 🇫🇷 Français · 🇩🇪 Deutsch · 🇧🇷 Português · 🇮🇹 Italiano · 🇨🇿 Čeština · 🇵🇱 Polski

You can also switch the language manually with the 🌐 button in the popup header.

## Installation

**Load from source** (developer mode):

```bash
git clone https://github.com/setube/stackprism.git
cd stackprism
bun install
bun run build            # Chrome / Edge
bun run build:firefox    # Firefox
```

**Chrome / Edge:**

1. Open `chrome://extensions` or `edge://extensions`
2. Enable "Developer mode" in the top-right corner
3. Click "Load unpacked" and select the `dist/` directory
4. Visit any webpage — the extension icon shows the detection count

**Firefox:**

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on" and select `dist-firefox/manifest.json`
3. Or run `bun run build:firefox` and double-click the `.xpi` in `release/`

### Development

```bash
bun run dev           # Dev mode + HMR
bun run typecheck     # vue-tsc type checking
bun run lint          # ESLint
bun run build         # Production build (includes rule precompilation)
bun run build:firefox # Firefox build + .xpi packaging
bun run docs:dev      # VitePress docs preview
```

## Rule System

StackPrism's detection is data-driven — almost all changes require only editing the JSON rule files, not touching any code.

- **Index** — [public/rules/index.json](public/rules/index.json) lists all rule files to load
- **Page rules** — `public/rules/page/*.json` handle page source, DOM, resource URLs, and dynamic resources
- **Header rules** — `public/rules/headers/*.json` handle server response headers and cookies
- **Self-suppression** — [public/rules/self-host-suppress.json](public/rules/self-host-suppress.json) skips same-name detection when viewing a major tech site
- **Tech links** — [public/tech-links.json](public/tech-links.json) maps tech names to their official URL so results are clickable
- **Build-time prefilter** — `precompileRulesPlugin` in [vite.config.ts](vite.config.ts) injects `__hints` and `__keywordCombined` into each leaf rule at build time; the runtime `rule-matcher.ts` uses them as candidate filters

Rule schema:

```jsonc
{
  "name": "My Technology",
  "category": "Frontend Framework", // one of 50+ categories
  "patterns": ["regex-or-keyword"],
  "matchType": "regex", // or "keyword"
  "matchIn": ["html", "resources", "url", "headers", "dynamic"],
  "confidence": "高", // 高 / 中 / 低  (high / medium / low)
  "kind": "description",
  "selectors": ["CSS selector"],
  "globals": ["window global name"],
  "classPrefixes": ["class-prefix"]
}
```

### Rule Quality Guidelines

- Prefer **high-signal evidence**: response headers, unique resource URLs, `<meta name="generator">`, `window.<global>`, unique CSS selectors, copyright comments, official SDK package names
- Avoid short or broad keywords (`spring`, `phoenix`, `column`, `container` — these match competitor mentions, Bootstrap/Tailwind utility classes, and generic prose)
- Prefer narrower `matchIn` scopes — use `resources` / `url` / `headers` rather than bare `html` to reduce false positives from page text

## Caveats

- **Backend detection is not exhaustive** — many sites hide `Server` / `X-Powered-By` headers; backend results are shown as "clues + confidence"
- **Spoofed headers** — the extension actively detects scenes where ≥4 distinct identity headers coexist (suggesting a honeypot or spoofed response) and downgrades those categories to low confidence with a warning. Single spoofed headers cannot be detected, so use the clues alongside other signals
- **Reload required on first install** — the service worker needs to observe the main document response headers, which only works on a fresh page load
- **Source search is a DOM snapshot** — based on the current page's `outerHTML`, not the original server-returned HTML
- **Chrome system pages / store pages / internal pages** generally block content script injection
- **Dynamic monitoring accumulates asynchronously** — the content script accumulates resources loaded after user interaction; reopening the popup shows the merged result

## Contributing

StackPrism ships 2000+ detection rules across 50+ categories, but the frontend ecosystem moves fast. **New frameworks, new SaaS tools, false positives, and missed detections** are all welcome:

- **Bug / false positive / missed detection** — [Issues](https://github.com/setube/stackprism/issues) — the popup's "Report inaccurate detection" button auto-fills the issue template
- **Rule contributions** — click "Submit rule contribution" in Settings, or send a PR directly to [`public/rules/`](public/rules/)
- **Discussion and proposals** — [Discussions](https://github.com/setube/stackprism/discussions)

Before submitting code, run `bun run typecheck && bun run lint && bun run build` and make sure all three pass.

## Star History

If this is useful, a ⭐ helps others find the project.

<a href="https://www.star-history.com/?repos=setube%2Fstackprism&type=timeline&logscale=&releases=&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=setube/stackprism&type=timeline&theme=dark&logscale&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=setube/stackprism&type=timeline&logscale&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=setube/stackprism&type=timeline&logscale&legend=bottom-right" />
 </picture>
</a>

## License

[MIT](https://opensource.org/licenses/MIT).

## LINUX DO Community

Thanks to the [Linux.do](https://linux.do/) community for its support and contributions.
