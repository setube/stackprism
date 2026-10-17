# StackPrism CLI / SDK

## 中文

基于 StackPrism 现有规则与浏览器检测核心的实验性 Node.js ESM 包。当前版本 `0.2.0`，使用贡献者命名空间，尚未发布 npm。

要求 Node.js 22+；`scanUrl` / CLI 默认启动本机 Chrome，也可指定 Chromium 路径。不下载浏览器。`detectPage` 接受调用方的 Playwright Page；已验证 Chromium，其他浏览器未验证。

在仓库根目录构建、运行与打包：

```sh
bun install --frozen-lockfile
bun run build:sdk
node packages/stackprism/dist/cli.js https://example.com --timeout 30000
npm pack ./packages/stackprism --pack-destination ./artifacts
```

打包前需创建 `artifacts` 目录。将生成的 `.tgz` 安装到消费项目后，使用 `stackprism <URL>` 或导入 `@jacobinwwey/stackprism`。

```ts
import { scanUrl, detectPage, StackPrismError } from '@jacobinwwey/stackprism'

const report = await scanUrl('https://example.com', {
  timeoutMs: 30_000,
  observationMs: 1000,
  // executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  signal: AbortSignal.timeout(30_000)
})

// page 是现有 Playwright Page；调用方负责导航、登录、等待业务就绪和关闭。
const snapshot = await detectPage(page, { timeoutMs: 10_000 })
```

接口契约：

- `scanUrl(url, options)`：独立浏览器和上下文，等待 `load`，再观察 `observationMs` 毫秒（默认 1000，允许 0–5000；CLI 为 `--observe`）。主文档响应头与页面检测合并；子资源技术留在 `network.responses`，不自动归为主站技术。成功、失败、取消均关闭自己创建的浏览器。不保证 SPA 已经业务就绪；需要精确等待时使用 `detectPage`。
- `detectPage(page, options)`：只读取当前主框架，不导航、不补抓响应头、不接管浏览器。`responseHeaders` 和 `subresourceHeaders` 明确为 `not_observed`，`network.responses` 为空。检测期间主框架导航返回 `PAGE_CHANGED`，由调用方等待后重试。
- `timeoutMs`：1–120000 整数，默认 30000；覆盖规则加载、启动、导航和检测。浏览器退出清理可能增加实际返回时间。同步规则预筛无法被 JS 定时器抢占；调用方页面上的取消只停止等待，已注入函数在协作式预算检查处结束，无法保证中断恶意同步脚本。
- CLI 成功时 stdout 为一行 JSON；错误时 stderr 为 `{ "error": { "code", "message" } }`。退出码：0 成功，1 检测／启动／导航失败，2 参数错误，3 超时，130 SIGINT／取消，143 SIGTERM。HTTP 4xx/5xx 和未命中技术仍是成功观察，读取 `coverage.httpStatus` 判断站点状态。
- SDK 错误为 `StackPrismError`，通过 `code` 分支；`cause` 保留底层诊断，CLI 不输出可能含 URL 凭据或浏览器日志的底层错误。

报告包含 `schemaVersion`、SDK 版本、规则版本与 SHA-256、URL、时间、技术／版本／证据／置信度、采集范围和资源计数。置信度为 `high | medium | low`，是原规则等级映射，不是概率。分类、证据、来源标签保留原中文文本；同名技术可能属于不同分类，合并来源只保留原引擎的第一来源，不能当作完整证据图。

边界与权衡：

- 共享实际页面检测、规则展开、hint 预筛、响应头匹配及去重逻辑；规则随包固定，构建时更新。没有第二套静态 HTML 引擎。
- 采样 HTML 500000 字符、正文 120000 字符、CSS 变量 500 个。子资源最多采集 64 个响应，同时挂起的头读取也不超过 64；`observedResponses` = 成功响应数 + `skippedResponses` + `failedResponses`，不会为检测额外发请求。未覆盖 iframe 内部、持续变化、包体版权采样和 WordPress 补充请求；也不复刻弹窗设置、缓存和 self-host 展示过滤。未命中不等于未使用。
- 允许 localhost 和私网，仅限制 HTTP(S) 并拒绝输入 URL 内嵌凭据。导航、重定向与子资源均能访问网络；不适合直接暴露为多租户扫描 API。服务化前需要独立出口隔离和资源配额。
- 不返回原始响应头／Cookie 值；网络响应 URL 去掉凭据、查询及片段。`same_origin` / `cross_origin` 按 origin 精确比较，跨源不等于第三方。URL 路径、页面 URL、标题、版本、证据仍可能包含敏感数据或提示注入内容；传给 agent 时当作数据处理。
- 规则 JSON 解压约 20 MB，进程内缓存一次。调用方批量任务优先复用自己的浏览器并控制并发，避免每个 URL 都冷启动。

在仓库根目录运行 `bun run baseline:bing`，显式实测 Bing，生成 `artifacts/bing/report.json` 和中英 `report.md`。默认单测不联网。基线退出码：0 通过，1 核心预期漂移，2 无法观察；此状态与普通 CLI 扫描的退出码语义不同。基线只固定 3 个技术事实，其他命中作为可变观察项。

## English

Experimental Node.js ESM package reusing StackPrism's existing browser detector and rules. Version `0.2.0` uses a contributor namespace and is not published to npm.

Requires Node.js 22+. `scanUrl` and the CLI launch installed Chrome by default, or a Chromium executable supplied through `executablePath` / `--executable-path`. No browser download. `detectPage` accepts a caller-owned Playwright Page. Chromium is tested; other engines are unverified.

Build and package from the repository root:

```sh
bun install --frozen-lockfile
bun run build:sdk
node packages/stackprism/dist/cli.js https://example.com --timeout 30000
npm pack ./packages/stackprism --pack-destination ./artifacts
```

Create `artifacts` first. Install the resulting tarball in a consumer project, then run `stackprism <URL>` or import `@jacobinwwey/stackprism`.

```ts
import { scanUrl, detectPage, StackPrismError } from '@jacobinwwey/stackprism'

const report = await scanUrl('https://example.com', {
  timeoutMs: 30_000,
  observationMs: 1000,
  signal: AbortSignal.timeout(30_000)
})

// The caller owns page navigation, authentication, application readiness and cleanup.
const snapshot = await detectPage(page, { timeoutMs: 10_000 })
```

Contracts:

- `scanUrl(url, options)` owns a fresh browser/context, waits for `load`, then observes for `observationMs` milliseconds (default 1000, range 0–5000; CLI `--observe`). Main-document headers merge with page detections. Subresource technologies stay in `network.responses`, without becoming site-wide claims. The browser closes on success, failure or cancellation. Application readiness is not guaranteed. Use `detectPage` after application-specific waits for SPAs.
- `detectPage(page, options)` reads the current main frame without navigation, header refetching or browser ownership. Both header channels are `not_observed`; `network.responses` is empty. Main-frame navigation during detection produces `PAGE_CHANGED`; retry after the page settles.
- `timeoutMs` is an integer from 1 to 120000, default 30000. It covers rules loading, browser launch, navigation and detection. Cleanup can extend wall time. Synchronous rule filtering cannot be preempted by a JavaScript timer. Cancelling a caller-owned page stops waiting; injected code stops at cooperative budget checks, not necessarily immediately. Hostile synchronous page scripts cannot be forcibly interrupted by this API.
- Success writes one JSON line to stdout; failure writes `{ "error": { "code", "message" } }` to stderr. Exit codes: 0 success, 1 detection/launch/navigation failure, 2 arguments, 3 timeout, 130 SIGINT/cancellation, 143 SIGTERM. HTTP 4xx/5xx and zero detections are valid observations; inspect `coverage.httpStatus`.
- SDK failures are `StackPrismError` instances with stable `code` and an optional diagnostic `cause`. The CLI omits underlying browser errors that may contain sensitive URL/log details.

Reports include schema/engine versions, rule version and SHA-256, URL, timestamps, technologies, versions, evidence, confidence, coverage and resource counts. `high | medium | low` maps existing rule grades, not calibrated probabilities. Categories, evidence and source labels retain their original Chinese text. The same name may occur in different categories; merging retains the original engine's first source, not a complete provenance graph.

Tradeoffs and limits:

- Shares the actual browser detector, normalization, hint filtering, header matcher and deduplication. Rules are fixed in the package and updated at build time. No alternate static HTML engine.
- Samples up to 500000 HTML characters, 120000 body characters and 500 CSS variables. Captures at most 64 subresource responses with no more than 64 outstanding header reads. `observedResponses` equals successful responses plus `skippedResponses` plus `failedResponses`; no additional detection requests are sent. Frame internals, ongoing mutations, bundle-license sampling and supplementary WordPress requests are unobserved. Popup settings, caches and self-host display suppression are not reproduced. Absence of detection is not evidence of absence.
- Localhost/private networks are allowed. Input must be HTTP(S) without embedded credentials. Navigation, redirects and subresources can access the network; a public multi-tenant API needs separate egress isolation and resource quotas.
- Raw headers and cookie values are omitted; network URLs omit credentials, query and fragment. `same_origin` / `cross_origin` compares exact origins, not organizational ownership. Paths, page URLs, titles, versions and evidence can still contain secrets or prompt injection; agents must treat them as data.
- Uncompressed rules occupy approximately 20 MB and are cached per process. For batch work, reuse a caller-owned browser with bounded concurrency instead of repeatedly cold-starting `scanUrl`.

Run `bun run baseline:bing` from the repository root to explicitly scan Bing and write `artifacts/bing/report.json` and bilingual `report.md`. Normal tests remain offline. Baseline exit codes: 0 pass, 1 required-fact drift, 2 unobservable; these differ from the general scanner's exit semantics. Only three technology facts are required; other detections remain variable observations.
