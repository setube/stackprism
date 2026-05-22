# StackPrism Agent Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个不依赖 MCP、不需要用户手动复制/下载的 StackPrism Agent Bridge：用户安装浏览器插件后，AI Agent 通过 Skill 内 JS/PY 脚本启动本地 HTTP bridge，自动驱动插件采集目标网站的技术、视觉、UI/UX、交互与资源信息，并读取 `stackprism.site_experience_profile.v1`。

**Architecture:** 插件仍是浏览器事实采集器，Skill 只是 Agent 的使用说明和脚本载体。本地 bridge 脚本绑定 `127.0.0.1`，提供 HTTP API 和本地 bridge 页面；插件在该页面注入 content script 完成握手，再由 background 打开/复用目标 tab、运行检测和体验采集脚本，最后通过 bridge content script 同源 POST profile 与状态。Agent 只访问本地 HTTP API，不直接调用扩展内部接口。

**Tech Stack:** Chrome/Edge Manifest V3, Vite 5, Vue 3, TypeScript, pnpm, Node.js `.mjs` bridge script, Python `http.server` fallback bridge script, Chrome content scripts, `chrome.runtime.sendMessage`, `chrome.tabs`, `chrome.scripting`, `chrome.storage.session`.

---

## 总目标

让 AI Agent 在用户已安装 StackPrism 插件的普通 Chrome 内核浏览器中，无需用户复制、下载或点击插件按钮，即可通过本地 HTTP 接口获得目标网站的 Site Experience Profile，用于实现相似视觉效果、UI/UX 体验、交互行为和必要的技术选型参考。

## 明确不做

- 不做 MCP server。
- 不做独立 CLI 程序、npm global bin、系统服务或守护进程。
- 不做 Native Messaging companion 第一版。
- 不要求用户手动点击插件、复制剪贴板或下载 JSON。
- 不承诺复刻后端私有实现，只输出浏览器侧可观测事实与可推断建议。
- 不采集 cookie、Authorization、完整敏感响应头、localStorage/sessionStorage 明文值。
- 不把 loopback bridge 宣称为本机恶意进程隔离机制。第一版信任用户启动的本地 bridge 进程；若同机恶意进程能在 `127.0.0.1` 上伪造兼容 bridge 页面和 API，扩展侧无法仅凭页面 meta 与协议字段证明其真实来源。安全文档和 E2E 报告必须明确该本机信任边界，不能把 `bridgeToken` 描述为抵御本机恶意进程的秘密。
- 不把 bridge 页面 DOM 中的 `bridgeToken` 宣称为抵御同浏览器恶意扩展的秘密。第一版不防已安装的其他扩展读取 `http://127.0.0.1/*` 页面 DOM、观察 bridge URL 或干扰同一浏览器 profile；若要覆盖该威胁模型，必须另起任务评估用户显式授权、Native Messaging、扩展间隔离策略或专用浏览器 profile。

## 用户与 Agent 使用流程

1. 用户安装 StackPrism 插件。
2. Agent 根据 Skill 运行本地脚本：
   - JS: `node agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs`
   - Python fallback: `python3 agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py`
3. 脚本向 stdout 输出一行机器可解析 JSON line；普通日志写 stderr，避免 Agent 解析失败。Agent 后续调用本地 API 时必须带 `Authorization: Bearer {apiToken}`。

   ```json
   {
     "event": "stackprism-bridge-ready",
     "service": "stackprism-agent-bridge",
     "version": "0.1.0",
     "protocolVersion": 1,
     "baseUrl": "http://127.0.0.1:17370",
     "healthUrl": "http://127.0.0.1:17370/health",
     "apiToken": "spb_xxx"
   }
   ```

   - ready JSON 只能在 HTTP server 已成功绑定、endpoint handler 已就绪且 `apiToken` 已生成后输出；启动失败不得输出 ready JSON。
   - stdout 在 ready 前出现非 JSON、缺字段或多余日志时，Agent 必须按 `BRIDGE_READY_PARSE_FAILED` 失败处理并停止子进程。
   - ready JSON 的 `protocolVersion` 必须等于 Agent 支持的版本；不匹配时 Agent 必须按 `BRIDGE_PROTOCOL_UNSUPPORTED` 失败处理并停止子进程。
   - Agent 读取 ready JSON 的默认超时为 10 秒；超时按 `BRIDGE_START_TIMEOUT` 失败处理，必须 kill 子进程并等待退出。
   - 启动前必须校验环境变量：`STACKPRISM_BRIDGE_PORT` 未设置时使用随机端口；一旦设置则必须是 `1..65535` 的十进制整数。非法端口或包含 NUL 字符的 browser open 配置必须以非零退出码结束，在 stderr 输出脱敏结构化错误 `BRIDGE_INVALID_ENV`，且不得输出 ready JSON 或生成 token。`STACKPRISM_BROWSER_OPEN_ARGS_JSON` 的非法 JSON/非数组/非字符串元素保留为 capture 创建后的 `BROWSER_OPEN_FAILED`，避免与启动失败混淆。
   - 指定 `STACKPRISM_BRIDGE_PORT` 且端口被占用时，bridge 必须以非零退出码结束，在 stderr 输出脱敏结构化错误 `PORT_IN_USE`，并且不得把 `apiToken`、`bridgeToken` 或完整 URL query 写入 stderr。

4. Agent 请求 `POST /v1/captures`，传入目标 URL、等待时间、视口配置和采集范围。
5. bridge 脚本自动打开浏览器访问本地 bridge 页面：`http://127.0.0.1:{port}/bridge?session={sessionId}&capture={captureId}&nonce={nonce}`；自动打开失败时返回 `BROWSER_OPEN_FAILED`，由 Agent 处理，不要求用户手动复制 URL。
   - 测试环境设置 `STACKPRISM_BRIDGE_NO_OPEN=1` 时不尝试打开浏览器，也不返回 `BROWSER_OPEN_FAILED`；capture 保持 `queued`，测试可直接请求 `bridgeUrl`。
6. StackPrism bridge content script 在 bridge 页面上握手，使用 `bridgeToken` 拉取 `GET /v1/captures/{id}/request`，再把经过校验的 capture request 传给 background 接管采集。
7. 插件打开/复用目标 tab，运行现有检测链路和新增体验采集链路。
8. background 把 profile 通过分片传输交给 bridge content script，由 bridge content script 在 bridge 页面同源上下文重组、校验并 POST 到 `POST /v1/captures/{id}/profile`；第一版不依赖 background 直接跨 origin `fetch` localhost，也不得把最大 8 MB profile 作为单条扩展消息发送。
9. Agent 读取 `GET /v1/captures/{id}/profile`，按 Skill 指南生成 UI/UX 实现方案。

## 用户可见门禁

- Agent Bridge 必须有用户可见的持久设置 `agentBridgeEnabled`，写入 `chrome.storage.local` 作为本机 profile 级 opt-in，并进入运行时 `DetectorSettings` 归一化流程；设置页必须明确该开关会允许本地 Agent Bridge 读取当前浏览器可观测的页面技术与体验摘要并交给用户本机 loopback bridge。
- 对 Chrome Web Store / Edge Add-ons 发布包，`agentBridgeEnabled` 默认必须为 `false`，除非发布前完成商店隐私披露、用户文档和发布说明更新，并由维护者显式记录改为默认开启的理由。开发/E2E 可以通过测试设置显式开启，但不得把测试设置写成生产默认。历史上如果 sync 里曾出现同名字段，也必须被视为旧数据并忽略，不得自动开启。
- bridge content script 在读取 DOM config 后、向 background 发起 `START_AGENT_CAPTURE` 前，必须先通过 `AGENT_BRIDGE_HELLO` 让 background 校验 `agentBridgeEnabled`。未开启时 capture 失败为 `AGENT_BRIDGE_DISABLED`，不得打开目标 tab、不得运行检测、不得读取或回传 profile。
- 该门禁不是每次 capture 的交互确认；它是一次性用户可见 opt-in。启用后仍保持“不要求用户点击插件按钮、复制或下载 JSON”的 Agent 使用体验。

## 本地 HTTP API

除 `GET /health` 与 `GET /bridge` 外，所有 API 必须带 Bearer token。token 分两类：

```http
Authorization: Bearer {token}
```

- `apiToken`：脚本启动时输出给 Agent，只能由 Agent 用来创建、查询、取消 capture 和读取最终 profile。
- `bridgeToken`：每次 capture 生成一次，只嵌入对应 bridge 页面，只能用于插件读取 capture request、回写 profile 和更新本次 bridge 页面状态。
- `bridgeToken` 可以读取同一 capture 的状态和 control，用于 bridge 页面渲染和插件取消轮询；不能创建新的 capture，不能读取 profile，不能读取其他 capture，不能列出历史任务。
- `apiToken` 的有效期绑定到当前 bridge 子进程。bridge server 退出、stdin EOF、SIGINT、SIGTERM 或测试清理后，必须关闭监听、清空内存 capture store 并丢弃 `apiToken`；第一版不支持跨进程恢复、token refresh 或持久 token。若 Agent 需要继续采集，必须重新启动 bridge 并读取新的 ready JSON。

Response contract:

- 所有 JSON endpoint 必须返回 `Content-Type: application/json; charset=utf-8`。
- 所有包含 capture 状态、request、control、profile 或 token 相关错误的 endpoint 必须返回 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`；profile endpoint 还必须返回 `Referrer-Policy: no-referrer`，避免本地浏览器或中间层缓存敏感采集结果。
- 成功响应使用各 endpoint 已定义的业务 body，不再额外包一层 `ok`，避免 Agent 读取 profile 时多一层不稳定结构。
- 失败响应必须统一为：
  ```json
  {
    "error": {
      "code": "INVALID_REQUEST",
      "message": "Human readable error.",
      "details": {}
    }
  }
  ```
- `details` 只能放可审计、已脱敏的字段名、限制值和当前状态，不得包含 token、完整请求头、完整 URL query 或 profile 片段。
- JS bridge 和 Python fallback 必须使用同一套 HTTP status code、`error.code` 和 `message` 语义；`tests/stackprism_bridge_py.test.mjs` 必须抽样校验错误响应与 JS bridge 一致。
- 未知路径返回 `404 NOT_FOUND`；不支持的方法返回 `405 METHOD_NOT_ALLOWED` 并带 `Allow` 头；缺少或格式错误的 Bearer token 返回 `401 UNAUTHORIZED`；token scope 不匹配返回 `403 FORBIDDEN`。
- 带 body 的 JSON endpoint 必须要求 `Content-Type: application/json`，可接受的唯一 charset 是缺省或 `utf-8`；缺失、非 JSON content type 或非 UTF-8 charset 返回 `415 UNSUPPORTED_MEDIA_TYPE`；JSON body 必须按 UTF-8 解码，非法 UTF-8 或 JSON 解析失败返回 `400 INVALID_JSON`。
- 第一版不支持浏览器跨站调用 bridge API。`OPTIONS` preflight 必须返回 `405 METHOD_NOT_ALLOWED` 或等效拒绝，且不得返回 `Access-Control-Allow-Origin`、`Access-Control-Allow-Headers` 或 `Access-Control-Allow-Credentials`；所有 API 响应默认不设置 CORS 允许头。恶意网页即使能发起 no-cors/simple request，也不能设置 Bearer token，且非 JSON content type 会被拒绝。
- 对会修改 capture 或读取敏感状态的 endpoint，若请求带 `Origin`，必须与当前 bridge origin 精确一致；若带 `Referer`，只允许同 origin；若带 `Sec-Fetch-Site` 且值不是 `same-origin` 或 `none`，必须返回 `403 ORIGIN_NOT_ALLOWED`。Agent/curl 等非浏览器客户端通常不带这些头，不能因此被拒绝。日志不得记录完整 `Referer` query。
- HTTP request target 只接受 origin-form path，例如 `/v1/captures/{id}`；拒绝 absolute-form、authority-form 或无法按当前 bridge origin 解析的 request target，避免代理式请求和路径解析差异。路由参数和 `/bridge` query 中的 `capture`、`session`、`nonce` 必须按固定 ASCII regex 和长度校验，拒绝 percent-encoded slash/backslash、空 segment、`..`、未知 query 字段和重复 query 字段。
- bridge server 的 stderr 日志必须脱敏，不能打印 `Authorization` header、`apiToken`、`bridgeToken`、完整 query string 或 profile body。

Protocol identifier contract:

- 所有协议标识符必须只使用 ASCII，不接受 Unicode、空白、percent-encoded 形式、URL-safe 字符集之外的字符或大小写宽松匹配。路由参数和 query 值在业务校验前不得做“解码后再尝试接受”的兼容处理。
- `apiToken`: `^spb_[A-Za-z0-9_-]{43}$`，总长度 47；由 32 bytes 安全随机数 base64url no-padding 编码得到。
- `bridgeToken`: `^spbt_[A-Za-z0-9_-]{43}$`，总长度 48；由 32 bytes 安全随机数 base64url no-padding 编码得到。
- `captureId`: `^cap_[A-Za-z0-9_-]{22}$`，总长度 26；由 16 bytes 安全随机数 base64url no-padding 编码得到。capture id 不是秘密，但仍不得由时间戳、递增计数器或 `Math.random()` / `random.random()` 派生。
- `sessionId`: `^s_[A-Za-z0-9_-]{22}$`，总长度 24；由 16 bytes 安全随机数 base64url no-padding 编码得到。
- `nonce`: `^n_[A-Za-z0-9_-]{22}$`，总长度 24；由 16 bytes 安全随机数 base64url no-padding 编码得到，仅用于本次 capture bridge URL 和 profile 一次性提交状态。
- `profileTransferId`: `^xfer_[A-Za-z0-9_-]{22}$`，总长度 27；由 16 bytes 安全随机数 base64url no-padding 编码得到。
- `cspNonce`: `^[A-Za-z0-9_-]{22}$`，总长度 22；由 16 bytes 安全随机数 base64url no-padding 编码得到，并且只用于本次 `/bridge` HTML 响应的 CSP header 与 HTML nonce attribute。
- 文档中的 `spb_xxx`、`spbt_xxx`、`cap_20260521_abcdef`、`s_xxx` 和 `n_xxx` 是脱敏占位，不是可被测试接受的合法协议样例。实现和测试必须使用 `tests/fixtures/bridge-protocol-identifiers.json` 中的合法/非法样例校验 JS bridge、Python fallback 和插件侧解析语义一致。

Capture request validation:

- `url` 必须是字符串，trim 后长度 `1..4096`；必须能按 WHATWG URL 解析，协议只允许 `http:` 或 `https:`，不得包含 username/password credential，fragment 在归一化时丢弃。
- `mode` 第一版只接受 `"experience"`。
- `waitMs` 必须是整数，范围 `0..30000`；缺省值 `3000`。
- `include` 必须是非空数组，元素只能来自 `tech`、`visual`、`layout`、`components`、`interaction`、`ux`、`assets`；重复项按固定顺序归一化。未包含的 profile section 必须返回空对象并在 `limitations` 记录 `section_not_requested`，不得运行对应重型采集后再静默丢弃。
- `viewports` 第一版最多接受 3 项；每项 `name` 可选，必须是 ASCII 字母、数字、`-`、`_`，长度 `1..32`；`width` 范围 `320..3840`，`height` 范围 `320..2160`，`deviceScaleFactor` 范围 `1..4`。由于第一版不新增 `chrome.windows` 权限，这些值只写入 profile 请求上下文和 limitations，不得宣称真实移动仿真。
- `options.forceRefresh`、`options.captureScreenshotMetadata`、`options.keepTabOpen`、`options.allowPrivateNetworkTarget` 必须是 boolean；缺省分别为 `false`、`false`、`false`、`false`。
- `options.targetMode` 只能是 `"reuse_or_new_tab"`、`"new_tab"` 或 `"active_tab"`；缺省为 `"reuse_or_new_tab"`。
- `options.maxResourceUrls` 范围 `0..1000`，缺省 `300`。
- 未定义的顶层字段或 `options` 字段必须返回 `400 INVALID_REQUEST`，不得忽略；未来协议扩展必须通过 `protocolVersion` 或显式 capability 协商。
- 违反请求 schema 或范围限制时返回 `400 INVALID_REQUEST`，不得创建 capture，不得打开浏览器。

### `GET /health`

返回 bridge 脚本状态。

```json
{
  "ok": true,
  "service": "stackprism-agent-bridge",
  "version": "0.1.0",
  "protocolVersion": 1,
  "bound": "127.0.0.1",
  "activeCaptures": 0
}
```

### `POST /v1/captures`

创建一次采集任务。

```json
{
  "url": "https://example.com",
  "mode": "experience",
  "waitMs": 3000,
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 900, "deviceScaleFactor": 1 },
    { "name": "mobile", "width": 390, "height": 844, "deviceScaleFactor": 2 }
  ],
  "include": ["tech", "visual", "layout", "components", "interaction", "ux", "assets"],
  "options": {
    "forceRefresh": true,
    "captureScreenshotMetadata": true,
    "maxResourceUrls": 300,
    "targetMode": "reuse_or_new_tab",
    "keepTabOpen": false,
    "allowPrivateNetworkTarget": false
  }
}
```

返回：

```json
{
  "id": "cap_20260521_abcdef",
  "status": "queued",
  "bridgeUrl": "http://127.0.0.1:17370/bridge?session=s_xxx&capture=cap_20260521_abcdef&nonce=n_xxx",
  "profileUrl": "http://127.0.0.1:17370/v1/captures/cap_20260521_abcdef/profile"
}
```

Concurrency policy:

- 第一版默认 `maxConcurrentCaptures = 1`。
- 有进行中的 capture 时，新的 `POST /v1/captures` 返回 `429`，错误码 `CAPTURE_BUSY`，避免多个浏览器 tab/window 并行采集互相覆盖状态。
- `queued` 仅表示任务已创建且等待 bridge 页面握手；第一版不实现 FIFO 队列。
- `queued` 或 `waiting_extension` 超过 30 秒仍未收到 bridge content script 握手时，bridge server 必须把 capture 标记为 `failed`，错误码 `EXTENSION_NOT_CONNECTED`；这覆盖默认浏览器未安装插件的场景。
- `EXTENSION_NOT_CONNECTED` 也覆盖浏览器打开到了错误 Chrome/Edge 用户 profile 的场景。bridge server 不得尝试枚举或判断用户本机浏览器 profile；Skill 文档和 E2E 报告必须提示：如果 StackPrism 安装在非默认浏览器或非默认用户 profile，Agent 必须用 `STACKPRISM_BROWSER_OPEN_COMMAND` 和 `STACKPRISM_BROWSER_OPEN_ARGS_JSON` 精确指定对应浏览器可执行文件和 profile 参数，否则只能从该错误、stderr 脱敏摘要和浏览器可见窗口判断。
- 非终态 capture 的全局运行上限为 60 秒；超过后 bridge server 必须标记为 `failed`，错误码 `CAPTURE_TIMEOUT`，并让 control endpoint 返回 `cancel`，避免 Agent 永久轮询。
- `cancel_requested` 超过 10 秒仍未收到插件确认时，bridge server 必须转为 `cancelled`，记录 `details.reason = "cancel_timeout"`，并让插件后续 late status 不得覆盖该终态。
- `completed` profile 默认只在内存保留 10 分钟；超过 TTL 后 bridge server 必须把 capture 状态转为 `expired`，清除 profile body，并让 `GET /v1/captures/{id}/profile` 返回 `410` 和错误码 `CAPTURE_RESULT_EXPIRED`，避免长期保留采集数据。

Target policy:

- `targetMode = "reuse_or_new_tab"`：只能复用归一化后与目标 URL 完全一致的现有 tab（忽略 fragment，保留 query 参与比较），否则新建后台 tab；不得因为 origin+path 相同但 query 不同就复用，避免采集到同一路径下不同筛选、会话、预览或业务状态的页面。
- `targetMode = "new_tab"`：始终新建 tab，必须使用 `chrome.tabs.create({ active: false })`，不得抢焦点。
- `targetMode = "active_tab"`：第一版只允许复用 bridge 页面打开前由插件记录的同窗口上一张非 bridge active tab；该 tab 的 URL 必须与目标 URL 归一化后一致（忽略 fragment，保留 query 参与比较），否则返回 `ACTIVE_TAB_MISMATCH`。如果插件无法确定 bridge 打开前的 active tab，返回 `ACTIVE_TAB_UNAVAILABLE`。不得为了满足 active_tab 模式主动切换焦点或把 bridge 页面当前 tab 当目标页。
- `keepTabOpen = false` 时，插件必须关闭自己创建的目标 tab；不得关闭用户原本打开的 tab。
- Agent Bridge 第一版只支持普通浏览器 profile，不支持 incognito/split-incognito 上下文。bridge tab 或目标 tab 的 `incognito` 为 true 时必须失败为 `INCOGNITO_NOT_SUPPORTED`，不得尝试跨普通窗口与隐身窗口传递 capture 状态。
- `allowPrivateNetworkTarget = false` 时拒绝目标 URL 指向 loopback、link-local、private IPv4/IPv6 网段，降低本地接口被误用风险；用户确需分析本地开发站点时必须显式开启。
- private network 判断不能只看 URL 字面量；bridge server 必须对 hostname 做 DNS 解析，拒绝解析到 loopback、link-local、private IPv4/IPv6 网段的目标，覆盖 `dev.local`、自定义 hosts 和 bridge resolver 可见的私网解析结果。
- Private-network 防护边界必须写清楚：bridge server 的 DNS 预检和 `target_loaded` final URL 校验只能阻止创建 capture、继续采集和交付 profile，不能保证浏览器在导航过程中绝不会向私网地址发出一次请求；DNS rebinding、浏览器解析器差异或服务端重定向可能在 final URL 校验前已经产生网络触达。第一版不得把该能力宣传为浏览器级 SSRF 防火墙；若验收要求是“零私网触达”，必须另起任务评估 CDP/proxy/Native Messaging 或扩展网络拦截方案。
- URL policy 必须拆成可测试纯函数，接收标准化 URL、当前 bridge origin、`allowPrivateNetworkTarget` 和可注入 resolver 返回值；单元测试只能使用 fixture 驱动的假 resolver，不得依赖本机 hosts、VPN、DNS 缓存或外网解析结果。
- DNS resolver 必须 fail closed：解析超时、NXDOMAIN、SERVFAIL、空结果或混合结果中任一地址落入 loopback/link-local/private 网段时，初始 URL 的 `POST /v1/captures` 返回 `400 TARGET_DNS_LOOKUP_FAILED` 或 `400 PRIVATE_NETWORK_TARGET_BLOCKED`；final URL 统一失败为 `409 FINAL_URL_BLOCKED`，并在脱敏 `details.reason` 中标记 `dns_lookup_failed` 或 `private_network_address`。
- 生产 DNS 解析必须有独立超时，例如 2 秒；超时不得阻塞 capture 创建、status 回写或 Agent 轮询。
- 即使 `allowPrivateNetworkTarget = true`，也必须拒绝目标 URL 指向当前 bridge server origin，错误码 `BRIDGE_SELF_TARGET_BLOCKED`，避免把 `/bridge` 页面和 `bridgeToken` 当作目标站点采集。
- 目标 URL 必须是 `http:` 或 `https:`，不得包含 username/password credential，默认丢弃 fragment，并归一化后写入 profile。
- URL 归一化规则必须在 JS bridge、Python fallback 和插件侧保持一致：protocol/hostname 小写、默认端口折叠、fragment 丢弃、pathname 保留尾斜杠语义、query 在内存匹配和 final URL 关系校验中保留，但在日志、profile 展示和报告中按资源 URL 脱敏规则处理。
- `targetMode = "reuse_or_new_tab"` 和 `active_tab` 的匹配规则必须使用归一化后的完整 URL（不含 hash，包含 query）。若目标 URL path 为空，按 `/` 处理。实现和测试必须覆盖默认端口、大小写 host、fragment 丢弃、query 完全相同可复用、query 不同必须新建 tab 或返回 `ACTIVE_TAB_MISMATCH` 的情况。若未来要支持 path-only 复用，必须新增显式 option、用户文档和测试，第一版不得静默引入。
- 如果目标站点重定向到不支持协议、credential URL、字面量私网地址，或 bridge server 对最终 URL hostname 的 DNS 校验失败，capture 必须失败为 `FINAL_URL_BLOCKED`，不得返回 profile。第一版无法阻止服务端重定向发生，但必须在运行主动检测和 experience profiler 前先上报 final URL 给 bridge 做策略确认；bridge 拒绝时不得继续采集。
- 即使目标 URL 是 `http:` 或 `https:`，`chrome.scripting.executeScript` 仍可能因浏览器限制页、Chrome Web Store、企业策略、host permission 缺失、tab detached 或扩展上下文失效而失败。agent capture 必须把注入失败显式映射为 `TARGET_INJECTION_FAILED`，记录脱敏 `details.reason`，停止采集并清理自己创建的目标 tab；不得把注入失败吞成空 profile、`TARGET_LOAD_TIMEOUT` 或普通检测缺失。
- profile 中所有资源 URL 默认丢弃 hash，并对 query string 做 allowlist 或整体脱敏；不得输出包含 `token`、`key`、`signature`、`session`、`auth` 等敏感参数的完整 URL。

Rate limit policy:

- bridge server 对 `apiToken` 维度执行基础限流，例如 `POST /v1/captures` 每分钟最多 10 次，状态/profile 查询每分钟最多 120 次。
- 插件回写 profile 每个 capture 只允许一次成功提交；重复 nonce 或重复完成提交返回 `NONCE_REUSED` 或 `CAPTURE_ALREADY_COMPLETED`。
- 限流错误返回 `429` 和结构化错误码 `RATE_LIMITED`，不得静默排队。

HTTP resource policy:

- bridge server 必须限制单进程打开连接数，例如 `maxOpenConnections = 20`；超出时直接关闭新连接或返回 `503 SERVER_BUSY`。
- 所有带 body 的 endpoint 必须在读取时逐块累计字节数，超过该 endpoint 的限制后立即关闭该请求连接，不得等完整 body 读完。普通 JSON body 超限返回 `413 REQUEST_TOO_LARGE`；profile body 使用独立上限并返回 `PROFILE_TOO_LARGE`。
- 请求头读取、body 读取和 keep-alive 必须有超时：建议 headers timeout 5 秒、body read timeout 10 秒、keep-alive timeout 2 秒；超时返回 `408 REQUEST_TIMEOUT` 或关闭连接并记录脱敏日志。
- 必须拒绝歧义或可被 request smuggling 利用的请求头组合：重复 `Host`、`Authorization`、`Content-Type` 或 `Content-Length`，非法 `Content-Length`，同时出现 `Content-Length` 与 `Transfer-Encoding`，不以 `chunked` 结尾的 `Transfer-Encoding`，以及任何非 `identity` 的 `Content-Encoding`。错误统一返回结构化 `400 INVALID_REQUEST` 或 `415 UNSUPPORTED_MEDIA_TYPE`，JS/Python 语义必须一致。
- `Transfer-Encoding: chunked` 必须被明确支持并按累计字节数限流；如果 Python fallback 无法用标准库可靠支持 chunked body，必须返回 `400 UNSUPPORTED_TRANSFER_ENCODING`，JS bridge 也用同样语义保持一致。
- bridge server 必须在 SIGINT、SIGTERM、测试进程退出和 stdin EOF 时关闭 HTTP server、清理 timer、清理 active capture 状态并退出，避免 Agent 运行后遗留本地服务。
- Skill 脚本示例必须用 `try/finally` 或等效流程停止 bridge 子进程；不能只启动 server 后让 Agent 自行遗留后台进程。

### `GET /v1/captures/{id}`

返回状态。Agent 使用 `apiToken` 读取任意当前内存中的 capture；bridge 页面和插件只能用对应 capture 的 `bridgeToken` 读取同一 capture 的状态。状态枚举：

- `queued`
- `waiting_extension`
- `running`
- `cancel_requested`
- `cancelled`
- `completed`
- `failed`
- `expired`

失败响应必须包含明确错误：

```json
{
  "id": "cap_20260521_abcdef",
  "status": "failed",
  "error": {
    "code": "EXTENSION_NOT_CONNECTED",
    "message": "StackPrism extension did not connect to the bridge page within 30 seconds."
  }
}
```

### `GET /v1/captures/{id}/profile`

采集完成后返回 `stackprism.site_experience_profile.v1`，只能使用 `apiToken` 读取。未完成时返回 `409` 和当前状态；使用 `bridgeToken` 访问必须返回 `403` 和错误码 `BRIDGE_TOKEN_CANNOT_READ_PROFILE`。

### `GET /v1/captures/{id}/request`

仅插件读取。返回本次 capture 的原始请求和当前 nonce。response body 必须包含 `captureId`、`sessionId`、`nonce`、`protocolVersion` 和 `request`，不得包含 `apiToken`、`bridgeToken`、profile body 或 callback URL。bridge 必须校验 Bearer `bridgeToken`；插件侧必须校验返回的 `captureId`、`sessionId`、`nonce` 和 `protocolVersion` 与 bridge 页面 config 完全一致，不一致时同源 POST `failed` 和 `BRIDGE_REQUEST_MISMATCH`，不得向 background 发送 `START_AGENT_CAPTURE`。

### `GET /v1/captures/{id}/control`

仅插件读取。bridge content script 在 capture 运行中定期轮询，用于发现 Agent 取消或任务过期。

```json
{
  "id": "cap_20260521_abcdef",
  "command": "continue",
  "status": "running"
}
```

当 Agent 调用 `DELETE /v1/captures/{id}` 后，返回 `command = "cancel"`；background 必须停止采集并清理自己创建的目标 tab。
当 capture 已进入 `cancel_requested`、`failed` 或 `expired`，control endpoint 也必须返回 `command = "cancel"`，确保插件及时停止并清理目标 tab；`completed` 后插件不应继续轮询 control，若收到请求只能返回当前终态，不得重新发起采集。

### `DELETE /v1/captures/{id}`

取消任务。只有 `queued`、`waiting_extension`、`running` 可以转为 `cancel_requested`，不能立即删除内存状态，因为 bridge content script 仍需要通过 `GET /v1/captures/{id}/control` 读取 `cancel` 命令。插件确认取消或超时后再转为 `cancelled` 并清理自己创建的目标 tab。`completed`、`failed`、`cancelled`、`expired` 等终态调用 `DELETE` 必须返回 `409` 和当前终态，不能重新进入 `cancel_requested`，避免误删审计结果或改写失败原因。

### `POST /v1/captures/{id}/status`

仅插件回调用。bridge content script 把 background 的阶段状态和结构化错误同源 POST 回 bridge，供 Agent 通过 `GET /v1/captures/{id}` 观察。

```json
{
  "id": "cap_20260521_abcdef",
  "status": "running",
  "phase": "target_loaded",
  "sequence": 3
}
```

允许的插件写入状态：`waiting_extension`、`running`、`cancelled`、`failed`。`completed` 只能由 profile 回写成功后产生。

Status phase contract:

- `phase` 只能是：`bridge_connected`、`request_loaded`、`target_opening`、`target_loaded`、`detecting_tech`、`profiling_experience`、`posting_profile`、`cleanup`。
- `sequence` 是 bridge content script 为同一 capture 的每次 status POST 生成的递增整数，从 1 开始。bridge server 只接受大于当前 `sequence` 的非终态 status。
- `running` phase 必须按上方列表顺序单调前进；重复、倒序 sequence 或倒退 phase 返回 `409 STALE_STATUS_UPDATE`，不得覆盖较新的 phase。
- 终态 `cancelled`、`completed`、`failed`、`expired` 一旦写入后不可被插件 status 覆盖；再次写入终态必须返回当前终态和结构化错误，不得把 late message 当成功。
- `failed` status body 必须包含 `error.code` 和 `error.message`；`details` 遵循统一脱敏规则。

当插件写入 `status = "running"` 且 `phase = "target_loaded"` 时，body 必须包含目标 tab 的 `finalUrl`。bridge server 必须对该 final URL 执行协议、credential、当前 bridge origin、自捕获和 DNS/private-network 校验；校验失败时该 status 请求返回 `409` 和 `FINAL_URL_BLOCKED` 或 `BRIDGE_SELF_TARGET_BLOCKED`，background 必须停止采集、清理自己创建的目标 tab，并不得注入主动检测或 experience profiler。

### `POST /v1/captures/{id}/profile`

仅插件回调用。必须校验：

- 请求来自 loopback。
- `Authorization: Bearer {bridgeToken}` 匹配当前 capture。
- body 是原始 `SiteExperienceProfile` JSON，必须包含 `schema = "stackprism.site_experience_profile.v1"`，且 body 内 `captureId` 与 path 一致；不得额外包 `{ "profile": ... }`，避免 `GET /profile` 与 `POST /profile` 使用两种形状。
- bridge server 使用 capture 内部关联的 nonce 状态做一次性提交校验；nonce 不写入 profile body，避免最终 profile 暴露 bridge URL 中的 nonce。
- nonce 未过期且未重复用于最终 profile 提交；多次 status 更新和 control 轮询不得消耗 nonce。

## Bridge 页面契约

`GET /bridge` 返回一个极小 HTML 页面，职责只有四项：

- 暴露 session/capture/nonce 给 StackPrism bridge content script。
- 展示连接状态，便于用户看到“等待插件 / 采集中 / 已完成 / 失败”，但不要求用户操作。
- 阻止被普通 StackPrism 检测管道当作目标站点处理。
- 通过同源 API 轮询 capture 状态并渲染状态；不得把状态存在 query string 或 localStorage/sessionStorage。

Token handling:

- `apiToken` 不放在 URL 或 bridge 页面，避免进入浏览器历史、页面源码、日志和 referrer。
- bridge 页面由本地脚本直接渲染，在 HTML 内嵌只供 bridge content script 读取的一次性 `bridgeToken`；它不是 Agent 使用的 `apiToken`。
- bridge 页面自身的内联脚本若需要渲染状态，只允许使用 `bridgeToken` 读取同一 capture 的 `GET /v1/captures/{id}`；不得读取 profile。
- `bridgeToken` 以 DOM 可读 JSON script 形式存在是为了适配 content script isolated world，不得被描述为对其他已安装扩展保密。安全说明必须明确：同浏览器 profile 中拥有 loopback 页面访问能力的恶意扩展、DevTools 用户或浏览器自动化工具属于本地受信边界之外，第一版只防普通网页跨站访问、错误 Host、错误 token、重复 token render 和 profile 越权读取。
- `/bridge` 响应必须使用 `Content-Type: text/html; charset=utf-8`。
- `/bridge` 渲染 `bridgeToken` 前必须先执行 Host、request target、query schema 和来源导航校验。若请求带跨站 `Referer` 或 `Sec-Fetch-Site: cross-site`，必须返回 `403 ORIGIN_NOT_ALLOWED` 且不渲染 token；由系统浏览器打开、地址栏打开或同源刷新产生的无来源头、`Sec-Fetch-Site: none` 或 `same-origin` 请求可以继续校验 session/capture/nonce。
- `/bridge` 必须先校验 query 中的 `session`、`capture`、`nonce` 与内存 capture 匹配，且 capture 仍未过期；校验失败时返回 404/410，不渲染 `bridgeToken`。
- `/bridge` 只能在 bridge token 尚未被 claim 前渲染 `bridgeToken`；一旦插件用该 `bridgeToken` 成功读取 request 或写入 `waiting_extension`，bridge server 必须把 token 标记为 claimed。之后浏览器历史里的同一 `/bridge?...nonce=...` 再次打开时只能渲染无 token 状态页或返回 409，不能再次泄露 `bridgeToken`。
- `/bridge` 的成功 HTML 首次渲染也必须记录 `bridgeTokenRenderedAt`；同一 `session/capture/nonce` 的第二次 `/bridge` 请求即使尚未被 content script claim，也只能返回无 token 状态页或 409，不能再次渲染 `bridgeToken`。第一版不支持刷新恢复，宁可显式失败，也不能允许复制/刷新 bridge URL 获得第二份 token。
- 第一版不支持 bridge 页面刷新后自动恢复同一 capture；刷新导致 content script 断连时按 `BRIDGE_TRANSPORT_DISCONNECTED` 或 `EXTENSION_NOT_CONNECTED` 暴露失败，不做静默重连。
- `bridgeToken` 必须放在 DOM 可读的 JSON script 中，不能只写入页面 JS 变量，因为 content script isolated world 不能可靠读取页面 JS 全局变量。
- 所有 `<script>` 元素都必须带本次响应的 `nonce`，包括 `type="application/json"` 的 bridge config script，避免 CSP 执行策略与 content script 读取路径在不同浏览器中漂移。
- bridge HTML 必须只使用服务端生成的安全 token/ID 组装 config，并通过 `JSON.stringify` 后按 `</script`、`<`、`>`、`&`、U+2028、U+2029 等序列做 HTML/script-safe 转义；状态文本渲染只能用 `textContent` 或等效安全 API，不能把 query、错误 message 或 URL 片段写入 `innerHTML`。测试必须覆盖恶意 query 值不会打断 JSON script、不会新增 `<script>`，也不会反射到页面可执行 HTML。
- bridge 页面响应头必须包含 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Cross-Origin-Opener-Policy: same-origin`、`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`。
- bridge 页面必须为每次成功 HTML 渲染生成独立 CSP nonce。可执行内联脚本必须带 `nonce`，CSP 使用 `script-src 'nonce-{cspNonce}'`；若需要内联 `<style>`，也必须带 nonce 并使用 `style-src 'nonce-{cspNonce}'`，否则 `style-src 'none'`。不得使用 `script-src 'unsafe-inline'` 或 `style-src 'unsafe-inline'`。
- bridge 页面必须设置最小 CSP header：`default-src 'none'; script-src 'nonce-{cspNonce}'; style-src 'nonce-{cspNonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`。只有在明确实现并测试跨 origin bridge 页面需求后，才能扩大 `connect-src`；不得用 `http://127.0.0.1:*` 或 `http://localhost:*` 允许本机任意端口。
- bridge 页面不得加载外部脚本、图片、字体或样式。
- bridge 页面不得被 iframe/embed/object 嵌入；测试必须确认 `frame-ancestors 'none'` 和 `X-Frame-Options: DENY` 同时存在，避免本地页面通过 framing 干扰用户判断或触发重复渲染。

Bridge 页面必须包含：

```html
<meta name="stackprism-agent-bridge" content="1" />
<script id="stackprism-agent-bridge-config" type="application/json" nonce="{cspNonce}">
  { "captureId": "cap_20260521_abcdef", "sessionId": "s_xxx", "nonce": "n_xxx", "bridgeToken": "spbt_xxx", "protocolVersion": 1 }
</script>
```

插件侧必须在 `src/utils/page-support.ts` 或等效位置把含该 path/origin/session 的 bridge 页面排除出普通 `content-observer` 检测、badge 更新和 popup 缓存，避免本地 bridge 自身污染技术栈结果。

Background listener isolation:

- `src/background/index.ts` 的 `chrome.tabs.onUpdated`、`chrome.webNavigation.onCommitted` 和 `chrome.webRequest.onHeadersReceived` 也必须识别 bridge tab/request，并立即 return 或清理 bridge tab session；不能只依赖 content script return。
- bridge 页面主请求、`/v1/captures/*` status/control/profile 请求、bridge tab 内的同源 fetch 都不得写入 `tab-store`、`popup-cache`、badge、dynamic snapshot 或 header records。
- `src/background/message-router.ts` 的普通 runtime message 入口也必须识别 bridge tab：来自 bridge tab 的 `PAGE_DETECTION_RESULT`、`DYNAMIC_PAGE_SNAPSHOT`、`START_BACKGROUND_DETECTION`、`GET_POPUP_RESULT`、`GET_POPUP_RAW_RESULT` 和 `GET_HEADER_DATA` 不能写入或读取普通站点缓存；对带 `tabId` 的普通消息必须区分 sender 类型：content script sender 必须满足 `sender.tab.id === tabId`，popup/options 等扩展页面 sender 没有 `sender.tab` 时只能读取当前用户选择的普通 tab 且不能读取 bridge tab，避免 bridge tab 或任意 content script 用 message body 里的 `tabId` 污染其他标签页。
- background、content script 和 bridge server 的日志都必须脱敏；不得打印 `apiToken`、`bridgeToken`、nonce、完整 bridge URL query、Authorization header、profile body、或目标 URL 中的敏感 query。现有 `console.log(... url ...)` 类路径触碰 bridge URL 时必须改为记录 origin/path 或 redacted URL。
- 判断 bridge request 不能依赖 token；必须使用持久化的 `bridgeTabId`、`bridgeOrigin`、`/bridge` path、`stackprism-agent-bridge` meta 对应的 session/capture 关系，或等效的 bridge-tab registry。
- `webRequest` 中如果 `details.tabId` 对应 bridge tab，必须跳过 `buildHeaderRecord` 和 `saveTabDataAndBadge`，避免把本地 bridge server 的响应头记录成目标站点技术证据。

Bridge content script guard:

- manifest 的 content script match 会覆盖所有 loopback path，因此 `src/content/agent-bridge-client.ts` 必须在读取 token 或访问 DOM 详情前先校验 path 为 `/bridge`、存在 `<meta name="stackprism-agent-bridge" content="1">`，且 query 参数包含 `session`、`capture`、`nonce`。
- 对非 bridge 的 localhost/127.0.0.1 页面必须立即 return，不发送消息、不读取页面文本、不发起网络请求。

Capability and protocol contract:

- bridge 页面 config 中的 `protocolVersion` 必须等于插件编译时的 `bridgeProtocolVersion`。不匹配时，bridge content script 必须同源 POST `failed` 和 `BRIDGE_PROTOCOL_UNSUPPORTED`，不得向 background 发送 `START_AGENT_CAPTURE`。
- background 对 `AGENT_BRIDGE_HELLO` 的响应必须包含 `extensionVersion`、`protocolVersion` 和稳定 capabilities 对象：`agentBridge`、`siteExperienceProfileV1`、`profileChunkTransport`、`bridgeContentPost`、`storageSession`、`experienceProfiler`、`rawProfile`、`viewportMetadata`。
- 第一版必需 capability 是 `agentBridge`、`siteExperienceProfileV1`、`profileChunkTransport`、`bridgeContentPost`、`storageSession` 和 `experienceProfiler`。任一缺失或为 false 时，capture 必须失败为 `NOT_SUPPORTED`，并在脱敏 `details.missingCapability` 中记录字段名。
- `chrome.storage.session` 不可用时不得退回普通内存状态；必须显式失败为 `NOT_SUPPORTED`，避免 service worker 重启后丢失 capture 所有权。
- `chrome.storage.session` 的 access level 必须保持默认 trusted-only，或显式设置为 `TRUSTED_CONTEXTS`；不得调用 `chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })`。content script 不得直接读取 `agent-capture-state`、active-tab tracker 或普通 tab cache，只能通过已校验的 runtime message/Port 与 background 交互。
- 最终 profile 的 `browserContext.extensionCapabilities` 必须直接来自握手时的 capabilities 快照，不能在 profile builder 中重新猜测。

Loopback host checks:

- bridge server 必须对所有 endpoint 校验 `Host` 头，包括 `/health` 和 `/bridge`。第一版只绑定 `127.0.0.1`，默认只生成 `http://127.0.0.1:{port}` bridge URL。允许的 Host 为 `127.0.0.1:{port}`；若实现明确支持 `localhost`，必须确认实际连接仍落在 loopback，并在测试中覆盖。不得声称支持 `[::1]`，除非同时实现 IPv6 loopback 绑定和 content script match。
- 插件发回 profile 时必须使用原始 bridge origin，不能跟随 profile body 里的 callback URL。
- bridge server 默认不返回宽松 CORS 头；第一版 profile 回传首选 bridge content script 的同源 `fetch`。如果后续保留 background 直连 fallback，必须只允许当前扩展 origin，不能使用 `Access-Control-Allow-Origin: *`。
- bridge server 必须拒绝 `OPTIONS` preflight 且不返回 `Access-Control-Allow-*`，避免本地网页跨站驱动 Agent Bridge API。
- 本机 loopback 不是强身份边界：`127.0.0.1:{port}`、`/bridge` path、meta 标记、`session/capture/nonce` 和 `bridgeToken` 只能把本次 capture 绑定到同一 bridge 页面和同一 bridge server 状态，不能证明该 server 一定由 StackPrism Skill 启动。第一版依赖“本机用户启动的 bridge 进程可信”作为部署前提；若未来要防本机恶意进程，必须另起任务设计扩展侧显式授权、Native Messaging、操作系统级 broker 或等效机制。

## Profile 回传传输路径

为避开 MV3 background 到 loopback 的 CORS、preflight 和浏览器差异，第一版固定使用以下传输路径：

1. `src/content/agent-bridge-client.ts` 在 bridge 页面保存 `bridgeToken`、`bridgeOrigin`、`captureId` 和 `nonce`。
2. bridge content script 用同源 `POST /v1/captures/{id}/status` 写入 `waiting_extension`，再把 capture request 发给 background。
3. background 运行期间通过 `chrome.tabs.sendMessage` 或 `runtime.Port` 把阶段状态、结构化错误和最终 profile 分片发回对应 bridge 页面 content script。
4. bridge content script 使用同源 `POST /v1/captures/{id}/status` 更新阶段状态，使用同源 `fetch('/v1/captures/{id}/profile')` POST profile，并带 `Authorization: Bearer {bridgeToken}`。
5. bridge content script 轮询 `GET /v1/captures/{id}/control`；收到 `cancel` 后通知 background 停止采集并清理目标 tab。
6. content script 把 status/profile POST 结果回报 background，background 再更新内部 capture 状态。

background 必须在 `AGENT_BRIDGE_HELLO` 时记录 `sender.tab.id`、`sender.tab.windowId`、bridge origin、captureId、session 和 nonce；后续所有 agent bridge 消息必须同时匹配该 bridge tab id 与 bridge URL。background 不应直接读取或持久化 `bridgeToken`。如果 service worker 重启导致 bridge content script 断连，capture 必须失败为 `BRIDGE_TRANSPORT_DISCONNECTED`，不得伪造完成。

Profile chunk transport contract:

- background 不得用单条 `chrome.tabs.sendMessage` 或 `runtime.Port.postMessage` 发送完整 profile。最终 profile 必须先序列化为 UTF-8 JSON bytes，再按固定上限分片。
- 单片 raw payload 上限为 `384 * 1024` bytes；base64 编码和消息 envelope 后的单条扩展消息目标上限为 512 KiB，避免在 MV3 扩展消息序列化链路上失败。
- 每次 profile 传输必须包含 `profileTransferId`、`captureId`、`sessionId`、`nonce`、`chunkIndex`、`chunkCount`、`byteLength`、`chunkByteLength`、`sha256` 和 `payloadBase64`。`sha256` 计算对象是完整 UTF-8 JSON bytes，不是 base64 字符串。
- 消息顺序为 `AGENT_PROFILE_TRANSFER_BEGIN`、一个或多个 `AGENT_PROFILE_TRANSFER_CHUNK`、`AGENT_PROFILE_TRANSFER_COMPLETE`；bridge content script 必须逐片 ack，background 只有收到上一片 ack 后才发送下一片。
- bridge content script 必须先校验 transfer message 的 `captureId`、`sessionId` 和 `nonce` 与本页 bridge config 完全一致，再按 `profileTransferId` 建立内存缓冲。校验失败必须拒绝该 transfer 并写入 `PROFILE_TRANSPORT_FAILED`。
- bridge content script 必须校验 `payloadBase64` 可解码为 bytes、chunk 数量、chunkIndex 连续性、累计 byteLength 和完整 sha256；校验通过后把 UTF-8 bytes 解析为原始 `SiteExperienceProfile` JSON，再 POST profile endpoint。缺片或超时写入 `PROFILE_CHUNK_MISSING`，hash 不匹配写入 `PROFILE_HASH_MISMATCH`，ack 超时、reassembly 失败、base64/UTF-8/JSON decode 失败或 POST 前传输异常写入 `PROFILE_TRANSPORT_FAILED`。
- profile transfer 超时时间建议 10 秒；终态后必须清理内存缓冲。profile chunks、完整 profile JSON、`bridgeToken` 和 `apiToken` 都不得写入 `chrome.storage.session`。
- content script POST profile 成功或失败后必须把结果 ack 给 background；background 不得在只完成扩展内部分片传输时把 capture 视为 completed。

Port disconnect reporting:

- bridge content script 使用 `runtime.Port` 时必须监听 `port.onDisconnect`。
- 如果断开时 capture 仍未进入 `completed`、`failed` 或 `cancelled`，bridge content script 必须用自身持有的 `bridgeToken` 同源 `POST /v1/captures/{id}/status`，写入 `failed` 和 `BRIDGE_TRANSPORT_DISCONNECTED`；POST 失败时在 bridge 页面显示失败状态，不能静默等待。
- service worker 启动恢复未完成 capture 时，background 必须根据持久化的 `bridgeTabId` 用 `chrome.tabs.sendMessage` 通知 bridge content script 上报 `SERVICE_WORKER_RESTARTED` 或 `BRIDGE_TRANSPORT_DISCONNECTED`；如果 bridge tab 已不存在，必须清理自己创建的 target tab，Agent 侧最终通过 bridge server 的 timeout/expired 状态观察失败。
- 浏览器完全退出、扩展 reload/update、用户禁用扩展或 `chrome.storage.session` 被清空后，第一版不尝试恢复未完成 capture；恢复入口只能 fail closed：清理 `createdByCapture` 目标 tab、清理残留 session state，并让 Agent 侧通过 bridge timeout/expired 或下一次状态查询看到结构化失败。文档不得把 `chrome.storage.session` 描述成跨浏览器重启持久化机制。
- MV3 service worker 可能在 capture 中途挂起或重启，不能把 background 内存 `setTimeout` 当作唯一超时、取消或清理门禁。background 必须把 `startedAt`、`deadlineAt`、`cancelDeadlineAt`、`profileTransferDeadlineAt` 或等效绝对时间写入 `chrome.storage.session`，在每次事件、Port 重连、message、tab 更新和 service worker 模块初始化时比较当前时间并 fail closed。bridge server 的 capture timeout/control 是 Agent 可观察的权威超时源；扩展侧 timer 只作为活跃 worker 期间的快速清理。第一版不新增 `chrome.alarms` 权限；若实现选择用 alarms，必须同步更新 manifest、权限测试、隐私文档和验收报告。

Persisted extension state:

`src/background/agent-capture-state.ts` 写入 `chrome.storage.session` 的最小字段必须包括：

```json
{
  "captureId": "cap_20260521_abcdef",
  "sessionId": "s_xxx",
  "nonce": "n_xxx",
  "bridgeOrigin": "http://127.0.0.1:17370",
  "bridgeUrl": "http://127.0.0.1:17370/bridge?session=s_xxx&capture=cap_20260521_abcdef&nonce=n_xxx",
  "bridgeTabId": 101,
  "bridgeWindowId": 7,
  "targetTabId": 102,
  "targetWindowId": 7,
  "targetUrl": "https://example.com/",
  "finalUrl": "https://example.com/",
  "targetMode": "reuse_or_new_tab",
  "createdByCapture": true,
  "keepTabOpen": false,
  "phase": "target_loaded",
  "status": "running",
  "startedAt": "2026-05-22T12:00:00.000Z",
  "updatedAt": "2026-05-22T12:00:03.000Z",
  "error": null
}
```

这些字段用于 service worker 重启后判断该通知哪个 bridge tab、该清理哪个 target tab、哪些 tab 是插件自己创建的，以及最终应向 Agent 暴露哪个结构化失败状态；不得把 `bridgeToken` 或 `apiToken` 写入 `chrome.storage.session`。
`agent-capture-state`、active-tab tracker 和普通 tab cache 的 key 必须使用不同前缀，并通过集中 helper 列出/清理；capture 终态、bridge tab 关闭、扩展启动恢复失败和 E2E 清理阶段都必须删除对应 capture state，避免后续 capture 误读旧 tab ownership。

## Profile Schema

顶层结构：

```json
{
  "schema": "stackprism.site_experience_profile.v1",
  "captureId": "cap_20260521_abcdef",
  "generatedAt": "2026-05-22T12:00:00.000Z",
  "target": {},
  "browserContext": {},
  "techProfile": {},
  "visualProfile": {},
  "layoutProfile": {},
  "componentProfile": {},
  "interactionProfile": {},
  "uxProfile": {},
  "assetProfile": {},
  "evidence": {},
  "limitations": [],
  "agentGuidance": {}
}
```

### `target`

- `url`
- `finalUrl`
- `loadError`: only when the browser reports a main-frame load failure; contains sanitized extension error code/category, not the full failing URL query.
- `origin`
- `title`
- `language`
- `viewportProfiles`
- `captureScope`: `current_page`, `target_url`, or `same_origin_flow`

### `browserContext`

- `userAgent`
- `extensionVersion`
- `capturedAt`
- `waitMs`
- `viewports`
- `pageSupported`
- `loginState`: only `unknown`, `likely_authenticated`, `likely_public`; do not expose account data.
- `viewportMode`: `current_viewport`, `window_size_approximation`, or `unsupported`.
- `bridgeProtocolVersion`
- `extensionCapabilities`: copied from `AGENT_BRIDGE_HELLO` response, including `agentBridge`, `siteExperienceProfileV1`, `profileChunkTransport`, `bridgeContentPost`, `storageSession`, `experienceProfiler`, `rawProfile`, `viewportMetadata`.

Viewport rule:

- 普通 Chrome 扩展不能像 CDP 那样真实模拟移动设备、DPR、触控和 user agent。
- 第一版 `viewports` 只表示“希望采集的窗口尺寸或当前视口摘要”，不是移动设备仿真。
- 如果无法安全调整窗口尺寸，插件必须返回 `viewportMode = "current_viewport"` 并在 `limitations` 说明未做移动视口采集。
- 不输出截图图像；`captureScreenshotMetadata` 仅表示采集视口尺寸、关键元素 bounding box 和 above-fold 摘要。`captureScreenshotMetadata = false` 时不得采集或输出 bounding box / above-fold 细节，只保留基础 viewport 上下文和 limitation。真实 screenshot/pixel diff 另做显式能力，不放第一版。
- 如果需要调整窗口尺寸，必须记录原窗口尺寸并在采集后恢复；没有 `chrome.windows` 权限时不能假装已调整。
- 第一版不新增 `chrome.windows` 权限；除非后续任务明确更新 manifest 和隐私文档，否则统一返回 `viewportMode = "current_viewport"`，不尝试调整窗口尺寸。

### `techProfile`

基于现有 StackPrism 检测结果：

- `technologies`: category, name, version, confidence, sources, evidence, url
- `primaryFrontend`
- `uiFramework`
- `buildRuntime`
- `cmsOrSiteProgram`
- `serverHints`
- `thirdPartyServices`
- `confidenceSummary`
- `implementationNotes`: 说明技术是“复刻参考”，不是必须照搬。

### `visualProfile`

新增体验采集脚本输出：

- `colorTokens`: dominant backgrounds, text colors, accent colors, border colors, CSS variables
- `typography`: font families, body size, heading scale, line heights, font weights
- `spacing`: common gaps, section padding, card padding
- `shape`: border radius scale, button radius, card radius, input radius
- `elevation`: box shadows, backdrop filters, border styles
- `density`: compact, balanced, spacious
- `themeMode`: light, dark, mixed, system-dependent

### `layoutProfile`

- `landmarks`: header, nav, main, footer, aside
- `hero`: presence, height, content alignment, media usage
- `gridSystems`: card grid, column count, max content width
- `responsiveBehavior`: desktop/mobile differences
- `stickyElements`: sticky header, fixed CTA, floating controls
- `aboveFold`: main visual hierarchy and first viewport summary

### `componentProfile`

采集常见 UI 单元：

- buttons: count, variants, size, radius, hover/focus evidence
- links: inline/nav/button-like
- forms: inputs, selects, search bars, validation hints
- cards: count, media placement, action areas
- navigation: top nav, side nav, breadcrumbs, tabs
- overlays: modal, drawer, popover, tooltip candidates
- dataDisplay: table, list, stats, badges

### `interactionProfile`

- `hoverPatterns`
- `focusPatterns`
- `transitions`: duration, easing, properties
- `animations`: names, durations, iteration count
- `scrollBehavior`
- `loadingIndicators`
- `interactiveControls`

Interaction rule:

- 第一版默认 passive capture，不点击、不提交表单、不触发可能改变业务状态的控件。
- hover/focus 只能来自可读 CSS selector、transition token、ARIA/state 属性和当前 DOM 状态；不得伪造“已验证 hover 效果”。
- modal/drawer/dropdown 只记录当前可见或 DOM 中可观察的结构；不主动打开隐藏菜单。

### `uxProfile`

基于 DOM 结构和可见文本摘要，不做隐私内容搬运：

- `pagePurpose`: inferred category, such as marketing, SaaS dashboard, docs, ecommerce, form flow
- `primaryUserPath`
- `informationHierarchy`
- `ctaStrategy`
- `trustSignals`
- `navigationDepth`
- `contentGrouping`
- `frictionPoints`: only observable UX risks, not speculative private intent

Text privacy rule:

- 默认不输出完整可见文本。
- CTA、导航、表单标签最多输出短标签摘要，并先脱敏 email、手机号、长数字 ID、货币金额、疑似姓名字段。
- 对登录态页面，优先输出 role/category/count/length，而不是具体内容。

Frame and shadow DOM rule:

- 同源 iframe 可以采集摘要，但必须标记 frame URL。
- 跨源 iframe、closed shadow root 和不可访问 CSSStyleSheet 只能记录存在性与边界框，不得声明内部 UI 已完整采集。

### `assetProfile`

- `scripts`
- `stylesheets`
- `resourceDomains`
- `imageDomains`
- `fontUrls`
- `manifest`
- `themeAssetUrls`
- `favicon`
- `cdnHints`
- `redactionPolicy`: 说明资源 URL 已丢弃 hash、敏感 query 参数已脱敏。

### `evidence`

证据要可追溯但脱敏：

- `highConfidence`
- `mediumConfidence`
- `lowConfidence`
- `rawCounts`
- `sourceCoverage`: headers, page, dynamic, bundle, visual, interaction
- `truncation`: per-field truncation flags and omitted counts, such as `resourceUrls`, `textSamples`, `componentSamples`, `cssRules`.

### `limitations`

必须明确：

- 后端隐藏响应头时不可推断真实服务端技术。
- 低置信兜底脚本名不应作为硬依赖。
- 未交互到的流程不会出现在 profile 中。
- 跨域样式表可能无法读取完整 CSS rules，只能读取 computed style。
- 登录态页面只输出结构和体验摘要，不输出敏感用户数据。

### `agentGuidance`

直接给 Agent 的执行建议：

- 优先复刻视觉层级、交互反馈、布局密度和信息结构。
- 技术栈用于选择等效实现，不要求与原站完全相同。
- 高置信证据可作为实现约束；低置信证据只能作为候选。
- 如果目标项目已有技术栈，优先用目标项目技术栈实现相同体验。
- 完成后用桌面/移动截图、DOM 几何、交互 smoke test 验证。
- 如果采集结果因上限被截断，必须在 `evidence.truncation` 和 `limitations` 同时说明，Agent 不得把缺失字段理解为目标站点不存在该结构。

## 文件结构规划

### Skill 包

- Create: `agent-skill/stackprism-site-experience/SKILL.md`
  - Agent 触发条件、运行 bridge 脚本、读取 profile、转成实现计划的工作流。
- Create: `agent-skill/stackprism-site-experience/README.md`
  - 说明 repo-local Skill 不会自动进入 Codex 全局 skill registry；提供复制/软链接到 `$CODEX_HOME/skills` 或直接按路径运行脚本的方式。
- Create: `agent-skill/stackprism-site-experience/agents/openai.yaml`
  - 可选 metadata 与发布辅助文件；必须声明不会让 Codex 自动发现 repo-local Skill。
- Create: `agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs`
  - 无全局安装、无 npm bin；作为薄 CLI 入口启动 loopback HTTP server，不承载完整业务实现。
- Create: `agent-skill/stackprism-site-experience/scripts/bridge/*.mjs`
- JS bridge helper 模块，至少拆分 protocol/error response、capture store/timers、URL policy/DNS、HTTP routing/body limits、browser open/redaction；每个文件遵守 300 行上限，函数遵守 50 行上限。
- Create: `agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py`
  - Python fallback 薄 CLI 入口，使用标准库 `http.server`，提供与 JS bridge 一致的 HTTP API；若某能力确实无法等价实现，必须返回结构化 `NOT_SUPPORTED` 并在 Skill 中标记 Python 为受限 fallback。
- Create: `agent-skill/stackprism-site-experience/scripts/stackprism_bridge_lib/*.py`
- Python fallback helper 模块，按与 JS bridge 对齐的职责拆分 protocol/error response、capture store/timers、URL policy/DNS、HTTP routing/body limits、browser open/redaction；每个文件遵守 300 行上限，函数遵守 50 行上限。
- Modify: `.gitignore`
  - 当前根规则 `scripts/` 会吞掉 `agent-skill/.../scripts/`；必须在 Task 6 创建首个 Skill 脚本前加入 `!agent-skill/`、`!agent-skill/**/`、`!agent-skill/**/scripts/` 和 `!agent-skill/**/scripts/**` 例外。还必须忽略 `__pycache__/` 和 `*.py[cod]`，并确保这些忽略规则在脚本 unignore 之后仍生效，避免 `py_compile` / `compileall` 留下未跟踪字节码。
- Create: `tests/fixtures/bridge-url-policy-cases.json`
  - JS/Python bridge 共用的 URL、DNS 解析结果、私网网段、credential、fragment、URL 归一化、tab 匹配和 final URL 校验用例；测试必须把这些 DNS 结果注入 URL policy helper，避免两套脚本语义漂移或依赖真实 DNS。
- Create: `agent-skill/stackprism-site-experience/references/site-experience-profile-schema.md`
  - profile schema 字段说明与消费规则。
- Create: `agent-skill/stackprism-site-experience/references/agent-consumption-guide.md`
  - Agent 如何从 profile 生成 UI/UX 实现策略。
- Modify: `.prettierignore`
  - 明确不忽略 `agent-skill/**/scripts/**`，避免后续新增宽泛 `scripts/` 规则时让 Skill 脚本脱离格式化和审查。

### 插件类型与协议

- Create: `src/types/agent-bridge.ts`
  - Capture request/status/profile/error 类型。
- Modify: `package.json`
  - 给 `test:unit` 增加 Node test runner 超时，例如 `node --test --test-timeout=60000 tests/*.test.mjs`，避免 bridge 子进程或 HTTP 测试卡死阻塞 CI。
- Create: `src/utils/site-experience-profile.ts`
  - profile builder、脱敏、字段归一化、schema version 常量。
- Modify: `src/background/headers.ts`
  - 扩展现有响应头脱敏边界，除了 `set-cookie` 外也防御 `cookie`、`authorization`、`proxy-authorization` 和 token-like header 值进入 `allHeaders`、profile 或 evidence。
- Modify: `src/types/settings.ts`
  - 增加 `agentBridgeEnabled: boolean`，默认 `false`，并把该字段纳入 `DetectorSettings`。
- Modify: `src/utils/constants.ts`
  - 增加 `AGENT_BRIDGE_ENABLED_STORAGE_KEY`，用于 local-only bridge opt-in。
- Modify: `src/background/detector-settings.ts`
  - 从 `chrome.storage.local` 读取并合并 `agentBridgeEnabled`，忽略 sync payload 中的同名旧字段；local opt-in 作为唯一生效来源。
- Modify: `src/utils/normalize-settings.ts`
  - 归一化同步过来的 detector settings，缺省为 `false`；不得因为旧设置对象缺字段而默认开启 Agent Bridge，也不得因为旧 sync payload 中携带同名字段而自动开启。
- Modify: `src/ui/settings/Settings.vue`
  - 增加 Agent Bridge 启用开关和本机信任边界说明；保存后写入 `chrome.storage.local`，并在重置时清除 local opt-in。
- Create: `tests/helpers/load-ts-module.mjs`
  - 测试侧统一转译 TypeScript，并处理 `@/` alias 到 `src/`。若被测 TS 有运行时 import，helper 必须编译到系统临时目录或仓库已忽略的 `tmp/compiled-tests/` 后再用 file URL import，不能用 data URL 直接加载带相对 import 的输出。
- Create: `tests/fixtures/bridge-protocol-identifiers.json`
  - JS bridge、Python fallback 和插件侧共用的协议标识符 fixture，覆盖 `apiToken`、`bridgeToken`、`captureId`、`sessionId`、`nonce`、`profileTransferId` 和 `cspNonce` 的合法/非法样例、regex、长度和前缀。
- Test: `tests/site-experience-profile.test.mjs`
  - 校验 schema、脱敏、低置信标记、字段稳定性。

### 插件 bridge 接入

- Create: `src/content/agent-bridge-client.ts`
  - 仅在 loopback bridge 页面运行；解析 token/session，向 background 发握手消息，并承担 bridge 页面同源 POST profile 的 transport。
- Modify: `src/manifest.config.ts`
  - 增加仅匹配 `http://127.0.0.1/*` 的 bridge content script；只有在 bridge server 同步支持并测试 `localhost` Host 后才加入 `http://localhost/*`。
- Modify: `src/background/content-injector.ts`
  - 不能继续假设 `chrome.runtime.getManifest().content_scripts?.[0]` 一定是 `content-observer.ts`；必须按文件名查找或显式常量指定 observer 文件。
- Modify: `src/utils/page-support.ts`
  - 排除 StackPrism bridge 页面，避免普通检测和 badge 被本地 bridge 污染。
- Modify: `src/content/content-observer.ts`
  - 在脚本入口识别 bridge 页面并立即 return，避免动态快照发送到 background。
- Modify: `src/types/messages.ts`
  - 增加 `AGENT_BRIDGE_HELLO`、`START_AGENT_CAPTURE`、`AGENT_CAPTURE_STATUS`、`AGENT_CAPTURE_CONTROL`、`AGENT_PROFILE_TRANSFER_BEGIN`、`AGENT_PROFILE_TRANSFER_CHUNK`、`AGENT_PROFILE_TRANSFER_COMPLETE`、`AGENT_PROFILE_TRANSFER_ACK`。
  - `START_AGENT_CAPTURE` payload 只包含 `captureId`、`sessionId`、`nonce`、`bridgeOrigin`、`request` 和 `capabilities`，不得包含 `bridgeToken`；`AGENT_PROFILE_TRANSFER_*` payload 只包含 transfer metadata 和 `payloadBase64`，不得包含 `bridgeToken` 或 profile wrapper。
- Modify: `src/background/message-router.ts`
  - 接收 bridge hello、capture start、status/control/profile transport 消息。

### 插件采集编排

- Create: `src/background/agent-capture.ts`
  - 管理 capture lifecycle、目标 tab 打开/复用、超时、回调 bridge。
- Create: `src/background/agent-capture-state.ts`
  - 将 capture 状态写入 `chrome.storage.session`，避免 MV3 service worker 重启后只剩内存状态。
- Create: `src/background/active-tab-tracker.ts`
  - 用 `chrome.tabs.onActivated` 和 `chrome.tabs.onUpdated` 记录每个 window 最近的非 bridge active tab，供 `targetMode = "active_tab"` 使用；不得新增 `chrome.windows` 权限。
- Modify: `src/background/index.ts`
  - 注册 active tab tracker、agent capture lifecycle、tab close/navigation cleanup、bridge tab/request 隔离和 service worker 重启恢复逻辑。
- Modify: `src/background/detection.ts`
  - 暴露可复用的“确保目标 tab 已检测完成”内部函数，避免复制检测逻辑；agent path 必须返回结构化结果或抛出错误，不能沿用现有吞异常 wrapper。
- Modify: `src/background/tab-store.ts`
  - 增加按 captureId 读取目标 tab 数据的辅助函数。
- Create: `src/background/agent-bridge-tabs.ts`
  - 维护 bridge tab registry，提供 `isAgentBridgeTab(tabId)`、`isAgentBridgeUrl(url)` 和 `isAgentBridgeRequest(details)`，供 `index.ts`、`page-support.ts`、`content-injector.ts` 和 agent capture cleanup 共用。
- Modify: `src/background/dynamic-snapshot.ts`
  - 暴露清理 pending dynamic snapshot 与 timer 的函数，支持 agent capture 的 `forceRefresh`。
- Modify: `src/background/bundle-license.ts`
  - 复用或暴露现有 `clearBundleLicenseTimer`，支持 agent capture 的 `forceRefresh` 和 cleanup。
- Modify: `src/background/popup-cache.ts`
  - 复用 `buildPopupRawResult` 与现有合并逻辑。
- Test: `tests/agent-capture-orchestration.test.mjs`
  - 使用 fake chrome APIs 覆盖 background capture 编排、active tab 选择、清理策略、service worker restart 和 token 不持久化边界。

### 体验采集脚本

- Create: `src/injected/experience-profiler.ts`
  - 注入目标页 MAIN world 或 isolated context，采集 computed style、布局、组件和交互线索；模块 default export 必须是可被 Vite IIFE 包装后作为 `chrome.scripting.executeScript({ files })` result 返回的 JSON-serializable value 或 Promise。
- Modify: `build-scripts/build-injected.mjs`
  - 构建 `public/injected/experience-profiler.iife.js`，并沿用现有追加 `__StackPrismInjected_<entry>;` 的机制，让 executeScript 能拿到 IIFE 返回值。
- Modify: `vite.injected.config.ts`
  - 将 `experience-profiler` 加入 `ENTRIES`，否则 `build-injected.mjs` 即使新增 entry 数组也无法构建。
- Modify: `src/manifest.config.ts`
  - 不默认把 `injected/experience-profiler.iife.js` 加入 `web_accessible_resources`；`chrome.scripting.executeScript({ files })` 只需要扩展包内路径。只有实现证明需要网页或 content script 通过 `chrome.runtime.getURL()` / `fetch()` 读取该文件时，才允许加入最小 match 的独立 `web_accessible_resources` 条目，并在 `docs/dev/agent-bridge.md` 记录原因和风险。
- Test: `tests/experience-profile-format.test.mjs`
  - 对纯函数部分做静态输入输出测试。
- Test: `tests/agent-bridge-manifest.test.mjs`
  - 验证 manifest 权限、bridge content script match、content script 顺序、agent-only profiler 默认不进入 `web_accessible_resources`、以及未新增 `chrome.windows` 权限。
- Create: `tests/fixtures/site-experience-fixture.html`
  - 固定视觉/UI/UX fixture，包含颜色、字体、layout、按钮、表单、卡片、transition、跨源 iframe 占位和脱敏文本样本。

### 文档

- Modify: `docs/dev/architecture.md`
  - 增加 Agent Bridge 架构与数据流。
- Modify: `docs/dev/detection-flow.md`
  - 增加 agent capture 流程。
- Modify: `docs/dev/release.md`
  - 增加手动验证项：bridge 脚本、插件握手、profile 输出。
- Modify: `.github/workflows/release-extension.yml`
  - 在打包 zip/crx 前运行 Agent Bridge 相关质量门禁，并检查 `dist/` 不包含 repo-local Skill、本地 bridge server 脚本、测试 fixture、`docs/superpowers/` 或 Python 字节码缓存。
- Create: `docs/dev/agent-bridge.md`
  - 面向开发者的协议与安全说明。
- Modify: `docs/dev/index.md`
  - 增加 Agent Bridge 开发文档入口，避免只进 sidebar 但开发索引不可发现。
- Modify: `docs/.vitepress/config.ts`
  - 把 `docs/dev/agent-bridge.md` 加入开发手册 sidebar，避免新增文档不可发现。
- Modify: `PRIVACY.md`
  - 明确 Agent Bridge 会采集浏览器侧可观测的技术和体验摘要，但不采集 cookie、Authorization、localStorage/sessionStorage 明文和完整敏感文本。
- Modify: `README.md`
  - 增加 Agent Bridge 能力入口和安装后使用边界。
- Modify: `docs/guide/basic-usage.md`
  - 增加面向普通用户的 Agent Bridge 使用说明和隐私边界。
- Create: `docs/reviews/CR-AGENT-BRIDGE-E2E-2026-05-22.md`
  - 收口阶段记录所有验证命令、退出码、浏览器 smoke 结果、跳过项和剩余风险，满足 AGENTS 的主线回归验证沉淀要求。

## 执行门禁

- 当前仓库未发现 `tasks.md`、`issues.csv` 或等效任务跟踪文件；本计划位于 `docs/superpowers/plans/`，只能作为实现计划，不能冒充唯一任务源。
- 真正开始实现前，执行者必须先与用户确认本计划可作为当前锁定任务，或按用户指定创建/更新正式任务跟踪文件并把状态置为“进行中”。
- 每个 Task commit 前必须运行 `git diff --check`、`git diff --cached --check`、`git status --short`、`git diff --name-only` 和 `git diff --cached --name-only`。`git diff --check` 与 `git diff --cached --check` 都必须无输出。新文件在未 stage 前不会被 `git diff --check` 覆盖；因此必须先用 `git add -N <new files>` 或在 staging 后用 `git diff --cached --check` 检查新增文件的 whitespace/conflict-marker 问题。
- `git diff --name-only` 不显示未跟踪新文件，所以还必须用 `git status --short` 确认已跟踪改动、未跟踪文件和待提交文件都只包含该 Task 的 Files 列表和必要验证报告。如出现范围外文件，必须先拆分或回退该 Task 自己引入的无关改动。
- 每个 Task 完成时必须在提交说明或 Task notes 中记录执行依据、验证命令和结果；不得并行推进多个 Task。
- 本仓库现有 `src/content/content-observer.ts`、`src/background/dynamic-snapshot.ts`、`src/background/bundle-license.ts` 和 `src/background/popup-cache.ts` 已超过 300 行。任何 Task 触碰这些超限文件时，只允许做最小接线或先把相关职责抽到新文件，不能继续把新业务逻辑堆进去；新增 bridge 脚本和 helper 模块也必须按 300 行文件上限、50 行函数上限拆分。

## 开发任务

### Task 1: 锁定协议与类型

**Files:**

- Modify: `package.json`
- Create: `src/types/agent-bridge.ts`
- Modify: `src/types/settings.ts`
- Modify: `src/utils/normalize-settings.ts`
- Create: `tests/helpers/load-ts-module.mjs`
- Create: `tests/fixtures/bridge-protocol-identifiers.json`
- Create: `tests/site-experience-profile.test.mjs`

- [ ] 修改 `package.json` 的 `test:unit` 为 `node --test --test-timeout=60000 tests/*.test.mjs` 或等效超时命令，满足后端/脚本测试 60 秒超时基线，防止 bridge 子进程测试卡死。
- [ ] 定义 `AgentCaptureRequest`、`AgentCaptureStatus`、`SiteExperienceProfile`、`AgentBridgeError`。
- [ ] 定义 `AgentBridgeCapabilities`，字段固定为 `agentBridge`、`siteExperienceProfileV1`、`profileChunkTransport`、`bridgeContentPost`、`storageSession`、`experienceProfiler`、`rawProfile`、`viewportMetadata`。
- [ ] 定义 agent bridge message union：`AgentBridgeHelloMessage`、`StartAgentCaptureMessage`、`AgentCaptureStatusMessage`、`AgentCaptureControlMessage`、`AgentProfileTransferBeginMessage`、`AgentProfileTransferChunkMessage`、`AgentProfileTransferCompleteMessage`、`AgentProfileTransferAckMessage`。
- [ ] 在 `DetectorSettings` 中增加 `agentBridgeEnabled` 运行时字段，`DEFAULT_SETTINGS` 和 `normalizeSettings` 的缺省值必须为 `false`；测试覆盖旧 sync 设置对象、非法类型和显式 `true` 三种输入，并确认 sync payload 中如果误带 `agentBridgeEnabled: true` 也不会自动开启，因为真实生效来源是 local opt-in。
- [ ] 写测试确认 `StartAgentCaptureMessage` 不允许 `bridgeToken` 字段，profile transfer messages 不允许 profile wrapper 字段。
- [ ] `tests/helpers/load-ts-module.mjs` 提供 `loadTsModule(path)`，用 `typescript.transpileModule` 编译 TS，并把 `@/foo` alias 改写为测试可 import 的 `src/foo` 相对路径；对有运行时 import 的模块编译到系统临时目录或仓库已忽略的 `tmp/compiled-tests/` 再用 file URL import，避免 data URL 相对 import 失败且不产生未跟踪测试产物。
- [ ] 定义 `bridgeProtocolVersion = 1`，并写入 request/status/profile 类型。
- [ ] 定义协议标识符常量和 validator：`apiToken`、`bridgeToken`、`captureId`、`sessionId`、`nonce`、`profileTransferId`、`cspNonce` 的 regex、长度、前缀必须与 Protocol identifier contract 一致，并导出给 bridge 脚本、插件 handshake 和测试复用。
- [ ] 新增 `tests/fixtures/bridge-protocol-identifiers.json`，覆盖每类标识符至少 2 个合法样例和非法样例：错误前缀、长度不足/过长、`+`、`/`、`=`、空白、Unicode、percent-encoded slash、点段、大小写错误、query 分隔符、空值。测试必须证明文档中的脱敏占位 `spb_xxx`、`spbt_xxx`、`cap_20260521_abcdef`、`s_xxx`、`n_xxx` 不会被 validator 接受。
- [ ] 写测试确认 schema 常量为 `stackprism.site_experience_profile.v1`。
- [ ] 写测试确认 `AgentBridgeCapabilities` 包含所有第一版必需 capability，且 `SiteExperienceProfile.browserContext.extensionCapabilities` 使用同一类型。
- [ ] 写测试确认 request 类型包含 `allowPrivateNetworkTarget`，默认值由 bridge 脚本处理；Task 1 不测试 DNS/private-network 行为，避免在 bridge 实现前写不可运行的测试。
- [ ] 写测试确认 error code 枚举至少包含：`NOT_FOUND`、`METHOD_NOT_ALLOWED`、`UNAUTHORIZED`、`FORBIDDEN`、`ORIGIN_NOT_ALLOWED`、`UNSUPPORTED_MEDIA_TYPE`、`UNSUPPORTED_TRANSFER_ENCODING`、`INVALID_JSON`、`INVALID_REQUEST`、`REQUEST_TOO_LARGE`、`REQUEST_TIMEOUT`、`SERVER_BUSY`、`STALE_STATUS_UPDATE`、`PORT_IN_USE`、`BRIDGE_INVALID_ENV`、`BRIDGE_START_TIMEOUT`、`BRIDGE_READY_PARSE_FAILED`、`BRIDGE_PROTOCOL_UNSUPPORTED`、`BRIDGE_REQUEST_MISMATCH`、`AGENT_BRIDGE_DISABLED`、`CAPTURE_BUSY`、`CAPTURE_TIMEOUT`、`EXTENSION_NOT_CONNECTED`、`BROWSER_OPEN_FAILED`、`BRIDGE_TOKEN_CANNOT_READ_PROFILE`、`PRIVATE_NETWORK_TARGET_BLOCKED`、`TARGET_DNS_LOOKUP_FAILED`、`BRIDGE_SELF_TARGET_BLOCKED`、`FINAL_URL_BLOCKED`、`ACTIVE_TAB_UNAVAILABLE`、`ACTIVE_TAB_MISMATCH`、`INCOGNITO_NOT_SUPPORTED`、`TARGET_LOAD_TIMEOUT`、`TARGET_LOAD_FAILED`、`TARGET_INJECTION_FAILED`、`TARGET_TAB_CLOSED`、`BRIDGE_TAB_CLOSED`、`TARGET_NAVIGATED_AWAY`、`SERVICE_WORKER_RESTARTED`、`BRIDGE_TRANSPORT_DISCONNECTED`、`PROFILE_TRANSPORT_FAILED`、`PROFILE_CHUNK_MISSING`、`PROFILE_HASH_MISMATCH`、`PROFILE_TOO_LARGE`、`RATE_LIMITED`、`NONCE_REUSED`、`CAPTURE_ALREADY_COMPLETED`、`CAPTURE_RESULT_EXPIRED`、`NOT_SUPPORTED`。重复 header、歧义 `Content-Length`/`Transfer-Encoding`、非法 request target 和非法 path/query 都复用 `INVALID_REQUEST`，不得新增一套不一致错误码。
- [ ] 验证：`pnpm run test:unit` 通过。
- [ ] 验证：`pnpm run typecheck` 通过，确认新增协议类型、测试 helper 和 schema 常量可编译并可打包。
- [ ] Commit: `feat: define agent bridge profile contract`

### Task 2: 实现 profile builder

**Files:**

- Create: `src/utils/site-experience-profile.ts`
- Modify: `src/background/headers.ts`
- Modify: `tests/site-experience-profile.test.mjs`

- [ ] 从现有 popup/raw 数据构造 `techProfile` 和 `assetProfile`。
- [ ] 增加 `limitations` 与 `agentGuidance` 默认规则。
- [ ] 对 cookie、authorization、set-cookie、token-like 字段做脱敏。
- [ ] 扩展 `src/background/headers.ts` 的响应头脱敏：`set-cookie` 保留 cookie name 摘要，`cookie`、`authorization`、`proxy-authorization`、`x-api-key`、token-like header 值统一脱敏；测试覆盖 `headers`、`allHeaders`、profile evidence 不泄露原值。
- [ ] 对资源 URL 的 hash 和敏感 query 参数做脱敏；profile 不输出完整签名 URL、带 token 的图片/字体/脚本 URL。
- [ ] 对 UX 文本摘要执行 email、手机号、长数字 ID、金额和疑似姓名脱敏。
- [ ] 对 viewport 输出增加 `viewportMode`，无法多视口采集时显式写入 limitation。
- [ ] 对 `captureScreenshotMetadata` 输出增加明确分支：`true` 时只允许输出视口尺寸、关键元素 bounding box 和 above-fold 摘要；`false` 时不输出 bounding box / above-fold 细节，并写测试确认不会误产出截图或像素数据。
- [ ] 对 passive interaction、cross-origin iframe、closed shadow root 和不可访问 stylesheet 写入 limitations。
- [ ] 对截断结果写入 `evidence.truncation` 和对应 limitation，至少包含资源 URL、文本摘要、组件样本和 CSS rule 样本的 omitted count。
- [ ] profile builder 必须从 agent capture context 接收 `AgentBridgeCapabilities`，并原样写入 `browserContext.extensionCapabilities`；不得在 builder 内重新推断 capability。
- [ ] 验证空检测、低置信检测、完整 raw 检测三种输入。
- [ ] 验证：`pnpm run test:unit` 通过。
- [ ] 验证：`pnpm run typecheck` 通过，确认 profile builder 的 TypeScript 类型和扩展打包链路没有被破坏。
- [ ] Commit: `feat: build site experience profile payload`

### Task 3: 实现体验采集脚本

**Files:**

- Create: `src/injected/experience-profiler.ts`
- Create: `tests/experience-profile-format.test.mjs`
- Create: `tests/agent-bridge-manifest.test.mjs`
- Create: `tests/fixtures/site-experience-fixture.html`
- Modify: `build-scripts/build-injected.mjs`
- Modify: `vite.injected.config.ts`
- Modify: `src/manifest.config.ts`

- [ ] 采集 computed style token：颜色、字体、字号、行高、间距、圆角、阴影。
- [ ] 采集 layout landmarks：header/nav/main/footer/aside/hero/above-fold。
- [ ] 采集 component inventory：button/input/card/nav/tab/modal/table/list/badge。
- [ ] 采集 interaction tokens：transition、animation、sticky/fixed、focus/hover 可观察线索。
- [ ] 标记同源 iframe、跨源 iframe、open shadow root、closed shadow root 的可采集边界。
- [ ] 输出稳定、限长、脱敏的 JSON，不包含可见文本全文。
- [ ] `src/injected/experience-profiler.ts` 必须 `export default` 一个 JSON-serializable result 或 Promise；构建后的 `public/injected/experience-profiler.iife.js` 末尾必须追加 `__StackPrismInjected_experience_profiler__;`，确保 `chrome.scripting.executeScript({ files })` 的 `injection[0].result` 非空。
- [ ] 设置明确采集上限，例如最大 DOM 节点数、最大组件样本数、最大文本样本数、最大 CSS rule 数和最大资源 URL 数；超过上限时只返回截断摘要和 omitted count，不让 profile 超过 bridge 的 8 MB 上限。
- [ ] 设置 `experience-profiler` 注入脚本返回值上限，例如返回给 `chrome.scripting.executeScript` 的 JSON 字符串不超过 2 MB；超过上限时在注入脚本内部先截断样本、写入 `evidence.truncation.executeScriptResult` 和对应 limitation，不允许等到 background 收到超大 executeScript result 或扩展消息传输时才失败。
- [ ] 在 `vite.injected.config.ts` 的 `ENTRIES` 加入 `experience-profiler`，并在 `build-scripts/build-injected.mjs` 的 `entries` 数组加入同名项。
- [ ] `src/manifest.config.ts` 的 `web_accessible_resources` 使用最小暴露面；默认不暴露 `injected/experience-profiler.iife.js`。如果实现确实需要暴露，必须把它拆成独立条目、使用最小 `matches`，并在 `docs/dev/agent-bridge.md` 说明为什么不能只用 `chrome.scripting.executeScript({ files })`。
- [ ] `tests/agent-bridge-manifest.test.mjs` 验证 bridge content script 只匹配 `http://127.0.0.1/*`，普通 observer 仍是第一个 content script，未新增 `chrome.windows` 或其他无关权限，未配置 `externally_connectable`，且 `experience-profiler.iife.js` 默认不在 `web_accessible_resources` 中；若实现选择暴露，则测试必须验证独立条目和最小 match。
- [ ] `tests/experience-profile-format.test.mjs` 验证构建后的 profiler IIFE 文本包含 `__StackPrismInjected_experience_profiler__;`，并验证 profiler 默认导出形状可被结构化克隆为 executeScript result。
- [ ] 新增 `tests/fixtures/site-experience-fixture.html`，用固定 DOM/CSS 覆盖颜色、字体、布局、组件、transition 和敏感文本脱敏样本。
- [ ] 运行 `pnpm exec prettier --check build-scripts/build-injected.mjs vite.injected.config.ts tests/experience-profile-format.test.mjs tests/agent-bridge-manifest.test.mjs tests/fixtures/site-experience-fixture.html`，因为 `pnpm run lint` 只覆盖 `src`，不会检查 build script、Vite injected config 和测试 fixture。
- [ ] 验证：`pnpm run build:injected` 产出 `public/injected/experience-profiler.iife.js`。
- [ ] 验证：`pnpm run test:unit` 通过；该步骤必须在 `pnpm run build:injected` 之后执行，因为 `tests/experience-profile-format.test.mjs` 会读取 ignored 构建产物 `public/injected/experience-profiler.iife.js`。
- [ ] 验证：`pnpm run typecheck` 通过，确认 injected entry、manifest config 和扩展构建链路一致。
- [ ] Commit: `feat: collect visual and ux experience signals`

### Task 4: 实现 bridge content script 握手

**Files:**

- Create: `src/content/agent-bridge-client.ts`
- Modify: `src/manifest.config.ts`
- Modify: `src/background/content-injector.ts`
- Modify: `src/utils/page-support.ts`
- Modify: `src/content/content-observer.ts`
- Modify: `src/types/messages.ts`
- Modify: `src/background/message-router.ts`

- [ ] content script 只在 loopback bridge 页面激活。
- [ ] 在 `src/manifest.config.ts` 中保持普通 `content-observer.ts` 为第一个 content script，或同步修改 `content-injector.ts` 通过文件名查找 observer；验证主动注入不会误注入 `agent-bridge-client.ts`。
- [ ] 对非 `/bridge` path 或缺少 `stackprism-agent-bridge` meta 的 loopback 页面立即 return，不读取 DOM 详情、不发消息、不发请求。
- [ ] 解析 `session`、`capture`、`nonce` 和 HTML 内嵌 `bridgeToken`，校验 URL path 为 `/bridge`。
- [ ] 从 `#stackprism-agent-bridge-config[type="application/json"]` 解析 `bridgeToken`，不得依赖页面 JS 全局变量。
- [ ] 解析 `capture` 和 `nonce`，从 bridge 拉取 `GET /v1/captures/{id}/request`。
- [ ] 校验 `GET /v1/captures/{id}/request` 返回的 `captureId`、`sessionId`、`nonce` 和 `protocolVersion` 与当前 bridge 页面 config 完全一致；不一致时同源 POST `failed` 和 `BRIDGE_REQUEST_MISMATCH`，不得向 background 发送 `START_AGENT_CAPTURE`。
- [ ] 握手后同源 POST `waiting_extension` / `running` / `failed` 状态到 `POST /v1/captures/{id}/status`。
- [ ] bridge content script 为每个 status POST 维护单调递增 `sequence`，并只发送定义过的 phase；background 发来的 late phase 不得倒退覆盖 bridge server 中较新的 phase。
- [ ] 运行期间轮询 `GET /v1/captures/{id}/control`；收到 `cancel` 后通知 background 取消。
- [ ] bridge content script 校验 bridge 页面 config 的 `protocolVersion`；不等于插件 `bridgeProtocolVersion` 时同源 POST `failed` / `BRIDGE_PROTOCOL_UNSUPPORTED`，不得向 background 发送 `START_AGENT_CAPTURE`。
- [ ] background 必须在 `AGENT_BRIDGE_HELLO` 时绑定 `sender.tab.id`、`sender.tab.windowId`、bridge origin、session、capture 和 nonce；后续 `AGENT_CAPTURE_*` 消息必须同时匹配 sender tab id 与 bridge URL，不能只信任 message body 或只校验 URL。
- [ ] 向 background 发送 `AGENT_BRIDGE_HELLO`。
- [ ] background 必须拒绝来自非 loopback `/bridge` URL、缺少 tab/window id、或 message body 中 session/capture/nonce 与 `sender.url` query 不一致的 `AGENT_BRIDGE_HELLO`，返回结构化 `INVALID_REQUEST`；若同一 tab 已登记 bridge session，则还必须拒绝与既有登记不一致的重复 hello。单元测试覆盖伪造 sender URL、伪造 tab id 和重复 hello mismatch。
- [ ] background 返回插件版本、`protocolVersion`、`AgentBridgeCapabilities` 和握手状态；缺少第一版必需 capability 时返回 `NOT_SUPPORTED`，并让 bridge content script 同源 POST failed status。
- [ ] background 必须在 `AGENT_BRIDGE_HELLO` 时只从 `chrome.storage.local` 读取 `AGENT_BRIDGE_ENABLED_STORAGE_KEY` / `agentBridgeEnabled`；未开启时返回 `AGENT_BRIDGE_DISABLED`，bridge content script 同源 POST failed status，且 background 不登记 capture、不打开目标 tab、不发送 `START_AGENT_CAPTURE`。单元测试必须证明 `chrome.storage.sync` 里的旧 `agentBridgeEnabled: true` 不会让握手通过。
- [ ] capability 校验通过后，bridge content script 发送 `START_AGENT_CAPTURE`，payload 只包含 `captureId`、`sessionId`、`nonce`、`bridgeOrigin`、规范化 capture request 和 capabilities；不得把 `bridgeToken` 传给 background。
- [ ] bridge content script 保持与 background 的 `runtime.Port` 或等效消息通道，用于接收 profile payload 并执行同源 POST。
- [ ] 如果使用 `runtime.Port`，必须在 `src/background/message-router.ts` 或 agent capture 模块注册 `chrome.runtime.onConnect`，校验 `port.name`、`sender.tab.id`、`sender.tab.windowId`、`sender.url`、session、capture 和 nonce；未知 port name、非 bridge sender、重复 port、跨 capture port 或 sender 与登记 bridge tab 不一致时必须断开并返回结构化失败，不能退回普通 onMessage 路径。
- [ ] bridge content script 实现 `AGENT_PROFILE_TRANSFER_BEGIN`、`AGENT_PROFILE_TRANSFER_CHUNK`、`AGENT_PROFILE_TRANSFER_COMPLETE` 和 `AGENT_PROFILE_TRANSFER_ACK`：逐片 ack、校验 transfer message 的 `captureId`、`sessionId`、`nonce` 与本页 bridge config 一致，按 `profileTransferId` 重组，校验 `payloadBase64`、`byteLength`、UTF-8/JSON decode 和 `sha256`，再同源 POST 原始 `SiteExperienceProfile` JSON。
- [ ] bridge content script 同源 POST status/profile 时必须设置 `Content-Type: application/json` 和 `Authorization: Bearer {bridgeToken}`；缺任一 header 都应在单元测试中触发 bridge server 的 `UNSUPPORTED_MEDIA_TYPE` 或 `UNAUTHORIZED`。
- [ ] 分片传输失败必须同源 POST 结构化失败状态：缺片或超时为 `PROFILE_CHUNK_MISSING`，hash 不匹配为 `PROFILE_HASH_MISMATCH`，其他传输失败为 `PROFILE_TRANSPORT_FAILED`；不能让 Agent 只等到 capture timeout。
- [ ] profile POST 成功或失败都必须回传给 background；断连时 background 标记 `BRIDGE_TRANSPORT_DISCONNECTED`。
- [ ] `runtime.Port` 的 `onDisconnect` 发生在 capture 未结束时，bridge content script 必须用同源 `POST /v1/captures/{id}/status` 上报 `BRIDGE_TRANSPORT_DISCONNECTED`；background 重启恢复后也必须通过 `bridgeTabId` 通知 bridge content script 上报 `SERVICE_WORKER_RESTARTED` 或 `BRIDGE_TRANSPORT_DISCONNECTED`。
- [ ] bridge 页面没有 token 时返回显式错误，不静默成功。
- [ ] bridge 页面不触发普通 `content-observer` 和 badge 更新。
- [ ] 验证：`pnpm run build:injected` 通过；Task 3 已新增读取 `public/injected/*.iife.js` 的单元测试，后续全量 `test:unit` 在干净 checkout 中必须先生成 ignored injected 产物。
- [ ] 验证：`pnpm run test:unit` 通过。
- [ ] 验证：`pnpm run typecheck` 通过，确认 content script、manifest 和 message union 可编译并可打包。
- [ ] Task 4 阶段不得要求真实 bridge server 浏览器握手 smoke；JS bridge server 在 Task 6 才实现，真实握手与 DevTools 观察统一放到 Task 10。
- [ ] Commit: `feat: add local bridge handshake`

### Task 5: 实现 background capture 编排

**Files:**

- Create: `src/background/agent-capture.ts`
- Create: `src/background/agent-capture-state.ts`
- Create: `src/background/agent-bridge-tabs.ts`
- Create: `src/background/active-tab-tracker.ts`
- Create: `tests/agent-capture-orchestration.test.mjs`
- Modify: `src/background/index.ts`
- Modify: `src/background/message-router.ts`
- Modify: `src/background/detection.ts`
- Modify: `src/background/tab-store.ts`
- Modify: `src/background/dynamic-snapshot.ts`
- Modify: `src/background/bundle-license.ts`
- Modify: `src/background/popup-cache.ts`

- [ ] `START_AGENT_CAPTURE` 校验 URL、session/capture/nonce 绑定、include、viewports；background 不接收、不读取、不持久化 `bridgeToken`。
- [ ] `START_AGENT_CAPTURE` 二次校验 `agentBridgeEnabled`，避免设置页关闭后已有 bridge tab 继续发起采集；关闭后返回 `AGENT_BRIDGE_DISABLED`，并清理 bridge session。
- [ ] `START_AGENT_CAPTURE` payload 必须来自已登记 bridge tab 的 content script；background 必须拒绝含 `bridgeToken`、callback URL 或 profile wrapper 的 payload，返回 `INVALID_REQUEST`。
- [ ] `START_AGENT_CAPTURE` 校验 `options.forceRefresh`、`options.captureScreenshotMetadata`、`options.targetMode`、`options.keepTabOpen`、`options.allowPrivateNetworkTarget` 和 `options.maxResourceUrls`；未知字段必须返回 `INVALID_REQUEST`，不能静默忽略。
- [ ] capture 开始前检查 `chrome.storage.session` 可用；不可用时返回 `NOT_SUPPORTED` 和 `details.missingCapability = "storageSession"`，不得退回普通内存状态。
- [ ] 不得把 `chrome.storage.session` access level 放宽给 content script；若实现显式设置 access level，必须设置为 `TRUSTED_CONTEXTS`。单元测试必须断言没有调用 `setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })`，并断言 content script 只能通过 runtime message/Port 访问 agent capture 状态。
- [ ] `src/background/active-tab-tracker.ts` 记录每个 window 最近的非 bridge active tab；bridge tab 激活时不能覆盖该记录；记录写入 `chrome.storage.session`，service worker 重启后仍可读取。
- [ ] `src/background/agent-bridge-tabs.ts` 提供 bridge tab/request registry；bridge tab、bridge 页面请求和 bridge API fetch 不得进入普通 `webRequest` header merge、`webNavigation` throttle reset、tab-store、popup-cache、badge 或 dynamic snapshot 流程。
- [ ] agent capture 的 deadline 必须使用持久化绝对时间，而不是只依赖 background 内存 timer。`agent-capture-state` 必须记录全局 capture deadline、cancel deadline 和 profile transfer deadline；所有事件入口和 service worker 模块初始化都必须调用同一个 deadline reconciliation helper，把过期 capture 标记为结构化失败或取消并清理自己创建的目标 tab。
- [ ] `src/background/message-router.ts` 对所有会读写 tab 数据的普通消息增加 sender/tab 校验和 bridge tab guard；bridge tab 发来的普通检测、动态快照、popup/raw/header 查询或后台检测消息必须拒绝或返回 unsupported，不能读写目标站点缓存，也不能用 message body 中的 `tabId` 操作其他 tab。
- [ ] 普通 runtime message 的 sender 校验必须保留 popup/options 正常能力：`sender.tab` 存在时按 content script 处理并要求 `sender.tab.id === tabId`；`sender.tab` 缺失但 `sender.url` 是本扩展 popup/options 页面时，只允许读取当前用户选择的普通 tab，且必须拒绝 bridge tab、incognito tab 和无权限 tab。单元测试覆盖 popup 正常读取、content script 伪造其他 tabId 被拒绝、bridge tab 查询被拒绝。
- [ ] background、content script 和 agent capture 模块的 console/debug 日志统一走 redaction helper；禁止打印完整 bridge URL query、nonce、token、Authorization header、profile body 和目标 URL 敏感 query。现有 `console.log(... url ...)` 触碰 bridge URL 或 target final URL 时必须改为 redacted URL。
- [ ] `targetMode = "active_tab"` 从 active-tab-tracker 读取 bridge tab 同窗口的上一张非 bridge active tab；缺失时返回 `ACTIVE_TAB_UNAVAILABLE`，URL 不匹配时返回 `ACTIVE_TAB_MISMATCH`。
- [ ] bridge tab 或目标 tab 的 `incognito` 为 true 时返回 `INCOGNITO_NOT_SUPPORTED`，并清理当前 capture；第一版不得跨普通窗口和隐身窗口传递状态。
- [ ] `reuse_or_new_tab` 和 `active_tab` 的 URL 匹配使用统一 helper：protocol/hostname 小写、默认端口折叠、fragment 丢弃、path 空值归一到 `/`，比较完整 URL（不含 hash，包含 query）。同 path 但 query 不同不得复用已有 tab；`active_tab` 场景必须返回 `ACTIVE_TAB_MISMATCH`。
- [ ] 监听 `chrome.webNavigation.onErrorOccurred` 的目标 tab main frame；加载失败时上报 `TARGET_LOAD_FAILED`，停止采集并清理自己创建的目标 tab，不得把浏览器错误页当目标站点 profile。
- [ ] 等待目标 tab `status === "complete"` 后，先通过 bridge content script 写入 `running/target_loaded` 和 `finalUrl`；bridge 接受 final URL 后才运行主动检测和 experience profiler。bridge 返回 `FINAL_URL_BLOCKED` 或 `BRIDGE_SELF_TARGET_BLOCKED` 时必须停止采集并清理自己创建的目标 tab。
- [ ] final URL 通过后再运行主动检测；agent capture 必须使用 `force: true` 或专用内部函数绕过 `DETECTION_THROTTLE_MS`，并在检测后等待 `waitMs` 收集动态资源；超时返回 `TARGET_LOAD_TIMEOUT`。
- [ ] 捕获 `chrome.scripting.executeScript` promise rejection 和 `chrome.runtime.lastError`；注入 content observer、page detector 或 experience profiler 任一步失败时返回 `TARGET_INJECTION_FAILED`，`details` 只记录脱敏原因类别，不包含完整 URL、token 或浏览器原始错误全文。
- [ ] 执行 `maxConcurrentCaptures = 1`，忙时返回 `CAPTURE_BUSY`。
- [ ] 打开或复用目标 tab；新建目标 tab 必须 `active: false`，记录 `createdByCapture`，触发现有技术检测。
- [ ] 在 `src/background/tab-store.ts` 中增加明确的 agent capture 清理入口，采集前清理目标 tab 的 tab data 与 popup cache。
- [ ] 在 `src/background/dynamic-snapshot.ts` 中导出 `clearDynamicSnapshotState(tabId)` 或等效函数，清理 `pendingDynamicSnapshots` 与 `dynamicSnapshotTimers`。
- [ ] 在 `src/background/bundle-license.ts` 复用现有 `clearBundleLicenseTimer(tabId)`；如当前函数未导出，则导出并由 agent capture cleanup 调用。
- [ ] 实现 `forceRefresh`：采集前统一调用 tab-store、popup cache、dynamic snapshot、bundle timer、detection throttle 的清理入口，避免复用旧页面缓存污染 profile。
- [ ] 从 `detection.ts` 拆出 agent capture 专用的检测函数；该函数必须返回检测完成信号和错误，不得使用现有 catch 后静默 return 的 `runActivePageDetection` 作为唯一结果来源。
- [ ] 注入 `experience-profiler.iife.js` 采集视觉/UI/UX 数据。
- [ ] 按 `include` 决定是否运行技术检测、experience profiler 和资源采样；未请求 section 返回空对象并在 `limitations` 写入 `section_not_requested`。
- [ ] 第一版不新增 `chrome.windows` 权限，不调整窗口尺寸；所有多视口请求都写入 `viewportMode = "current_viewport"` 和 limitation。
- [ ] 合并 popup/raw 数据与体验数据，调用 profile builder。
- [ ] 从 `popup-cache.ts` 导出 agent capture 需要的 raw/display 构建辅助函数，避免绕过现有去重、过滤和链接补全逻辑。
- [ ] 将 profile payload 通过 profile chunk transport 发给 bridge content script，由其重组、校验 sha256 后同源 POST 回 bridge callback endpoint；background 直连 localhost 只允许作为后续显式 CORS fallback，不在第一版默认路径。
- [ ] background 发送 profile 分片时必须把原始 `SiteExperienceProfile` 序列化为 UTF-8 JSON bytes，计算 sha256，再把每片 bytes 编码为 `payloadBase64`；单片 raw payload 不超过 `384 * 1024` bytes，并等待每片 ack；ack 超时、content script 返回失败或 transfer complete 未确认时，必须上报 `PROFILE_TRANSPORT_FAILED`，不得把 capture 标记为 completed。
- [ ] capture 完成、失败、取消或过期时，关闭插件自己创建且 `keepTabOpen = false` 的目标 tab。
- [ ] 监听目标 tab 或 bridge tab 关闭/导航；分别返回 `TARGET_TAB_CLOSED`、`BRIDGE_TAB_CLOSED` 或 `TARGET_NAVIGATED_AWAY`，并清理 capture 状态。
- [ ] capture 状态写入 `chrome.storage.session`，最小字段包含 `captureId`、`sessionId`、`nonce`、`bridgeOrigin`、`bridgeUrl`、`bridgeTabId`、`bridgeWindowId`、`targetTabId`、`targetWindowId`、`targetUrl`、`finalUrl`、`targetMode`、`createdByCapture`、`keepTabOpen`、`phase`、`status`、`startedAt`、`updatedAt`、`error`；不得持久化 `bridgeToken` 或 `apiToken`。
- [ ] `agent-capture-state`、active-tab tracker 和普通 tab cache 使用不同 storage key 前缀；提供集中 helper 列出和清理 agent capture state。capture 终态、bridge tab 关闭、扩展启动恢复失败和 E2E 清理阶段都必须删除对应 capture state，避免后续 capture 误读旧 tab ownership。
- [ ] service worker 重启后读取 `agent-capture-state`：未完成 capture 标记为 `SERVICE_WORKER_RESTARTED`，通过 `bridgeTabId` 通知 bridge content script 同源 POST 失败状态，并按 `createdByCapture`/`keepTabOpen` 清理目标 tab。
- [ ] 浏览器完全退出、扩展 reload/update、用户禁用扩展或 `chrome.storage.session` 被清空后，不尝试恢复未完成 capture；恢复入口必须 fail closed，清理残留 state 和自己创建的 target tab，让 Agent 侧通过 bridge timeout/expired 或状态查询看到结构化失败。
- [ ] 错误路径必须回传结构化错误，不能吞异常。
- [ ] `tests/agent-capture-orchestration.test.mjs` 使用 fake chrome APIs 覆盖 target URL 不支持、检测超时、注入失败、目标 tab 导航走偏、bridge 不可达、active_tab 缺失/不匹配、incognito 拒绝、service worker restart cleanup、browser/extension reload fail-closed cleanup、deadline reconciliation、`keepTabOpen = false` 只关闭插件创建的目标 tab、`chrome.storage.session` 中不持久化 `bridgeToken`/`apiToken`，以及 `chrome.storage.session` access level 不暴露给 untrusted content scripts。
- [ ] `tests/agent-capture-orchestration.test.mjs` 必须覆盖 bridge tab/request/message 隔离：`tabs.onUpdated`、`webNavigation.onCommitted`、`webRequest.onHeadersReceived` 和 `runtime.onMessage` 收到 bridge tab 或 `/v1/captures/*` 请求时，不写入 tab-store、popup-cache、badge、dynamic snapshot 或 header records；bridge tab 伪造 `PAGE_DETECTION_RESULT`、`DYNAMIC_PAGE_SNAPSHOT` 或带其他 tabId 的 popup/header 查询必须被拒绝；popup/options 正常读取普通 tab 仍通过。
- [ ] `tests/agent-capture-orchestration.test.mjs` 必须覆盖扩展侧日志脱敏：bridge URL query、nonce、token、Authorization header、profile body 和目标 URL 敏感 query 不出现在 console/debug 输出中。
- [ ] 如果实现使用 `runtime.Port`，测试必须覆盖未知 port name、非 bridge sender、重复 port、跨 capture port、错误 `sender.url` 和错误 tab id 都会断开且不会启动 capture 或写入 profile。
- [ ] 验证：`pnpm run build:injected` 通过；Task 3 已新增读取 `public/injected/*.iife.js` 的单元测试，后续全量 `test:unit` 在干净 checkout 中必须先生成 ignored injected 产物。
- [ ] 验证：`pnpm run test:unit` 通过。
- [ ] 验证：`pnpm run typecheck` 通过。
- [ ] Commit: `feat: orchestrate agent site capture`

### Task 6: 实现 JS bridge 脚本

**Files:**

- Create: `agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs`
- Create: `agent-skill/stackprism-site-experience/scripts/bridge/*.mjs`
- Create: `tests/stackprism-bridge.test.mjs`
- Create: `tests/fixtures/bridge-url-policy-cases.json`
- Reuse: `tests/fixtures/bridge-protocol-identifiers.json`
- Modify: `.gitignore`

- [ ] 使用 Node 标准库 `node:http`，不引入运行时依赖。
- [ ] `stackprism-bridge.mjs` 只保留 CLI guard、启动参数读取和 server lifecycle；HTTP routing、capture store、URL policy、DNS、body limit、browser open、redaction 和 error response 拆入 `scripts/bridge/*.mjs` helper，至少包含 `http-server.mjs`、`capture-store.mjs`、`url-policy.mjs`、`security.mjs` 和 `open-browser.mjs`，避免单文件超 300 行。
- [ ] 绑定 `127.0.0.1`，端口默认随机，支持环境变量 `STACKPRISM_BRIDGE_PORT`。
- [ ] 启动前校验环境变量：`STACKPRISM_BRIDGE_PORT` 未设置时才使用随机端口；设置后必须是 `1..65535` 的十进制整数；browser open 相关环境变量不得包含 NUL 字符。非法端口或 NUL 字符返回 `BRIDGE_INVALID_ENV`，非零退出，stdout 不输出 ready JSON，stderr 不泄露 token 或 bridge URL query；`STACKPRISM_BROWSER_OPEN_ARGS_JSON` 的非法 JSON/非数组/非字符串元素仍由打开浏览器步骤返回 `BROWSER_OPEN_FAILED`。
- [ ] 指定 `STACKPRISM_BRIDGE_PORT` 且端口被占用时，进程必须非零退出，stderr 输出脱敏 `PORT_IN_USE`，stdout 不输出 ready JSON。
- [ ] 启动成功后 stdout 只输出一行 JSON line，包含 `event`、`baseUrl`、`healthUrl`、`apiToken`、`protocolVersion`、`version`；其他日志写 stderr。ready JSON 必须在 server 已绑定且 endpoint 可接受请求后输出。
- [ ] 自动打开 bridge 页面：macOS 使用 `open`，Windows 使用 `rundll32.exe url.dll,FileProtocolHandler` 或等效非 shell API，Linux 使用 `xdg-open`；支持 `STACKPRISM_BROWSER_OPEN_COMMAND` 覆盖目标浏览器。不得默认使用 `cmd /c start`，除非测试证明 `?`、`&`、空格和引号不会被 shell 解释。
- [ ] 自动打开浏览器时不得把 bridge URL 拼进 shell 字符串；JS 使用 `spawn`/`execFile` 的参数数组，Python 使用 `subprocess` 参数数组或 `webbrowser` 安全 API。`STACKPRISM_BROWSER_OPEN_COMMAND` 第一版只表示可执行文件路径；如需额外参数，使用 JSON 数组环境变量 `STACKPRISM_BROWSER_OPEN_ARGS_JSON`，并把 bridge URL 作为最后一个独立参数。
- [ ] `STACKPRISM_BROWSER_OPEN_ARGS_JSON` 必须严格解析为字符串数组；非法 JSON、非数组或非字符串元素都返回 `BROWSER_OPEN_FAILED`，并在脱敏 `details.reason` 中标记 `invalid_open_args`。浏览器打开测试必须覆盖包含 `?`、`&`、空格和引号的 bridge URL 始终作为单个 argv 传入假命令，不能被 shell 拆分或解释。
- [ ] 支持测试环境变量 `STACKPRISM_BRIDGE_NO_OPEN=1` 禁止自动打开浏览器，避免单元测试弹出浏览器或依赖用户桌面环境；该模式下创建 capture 不得返回 `BROWSER_OPEN_FAILED`，而是返回 `queued` 和 `bridgeUrl`。
- [ ] `.gitignore` 加入 `agent-skill/**/scripts/**` 例外，并加入或确认 `__pycache__/`、`*.py[cod]` 仍被忽略；确认以下命令退出码为 1 且无输出：`git check-ignore -v --no-index agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs agent-skill/stackprism-site-experience/scripts/bridge/http-server.mjs agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py agent-skill/stackprism-site-experience/scripts/stackprism_bridge_lib/http_server.py`。该步骤必须在创建 JS/Python bridge 脚本前完成，否则 Task 6/7 的脚本会被根规则 `scripts/` 忽略并漏提交；使用 `--no-index`，避免已跟踪文件让 ignore 规则检查产生假阴性。
- [ ] 确认 `git check-ignore -v --no-index agent-skill/stackprism-site-experience/scripts/stackprism_bridge_lib/__pycache__/http_server.pyc` 有命中，避免 Python 编译验证留下未跟踪字节码。
- [ ] 实现统一 JSON 错误响应；所有失败返回 `{ "error": { "code", "message", "details" } }`，且 `details` 不含 token、完整 header、完整 URL query 或 profile 片段。
- [ ] 实现未知路径、错误方法、缺失 Bearer、token scope 不匹配、非 JSON content type、非 UTF-8 charset、非法 UTF-8 body 和 JSON parse failure 的固定错误响应：`NOT_FOUND`、`METHOD_NOT_ALLOWED`、`UNAUTHORIZED`、`FORBIDDEN`、`UNSUPPORTED_MEDIA_TYPE`、`INVALID_JSON`。
- [ ] 实现 `OPTIONS` preflight 拒绝：返回 `405 METHOD_NOT_ALLOWED` 或等效结构化错误，带正确 `Allow` 头，但不返回任何 `Access-Control-Allow-*` 头；测试覆盖跨站网页无法通过 preflight 获得授权。
- [ ] 实现 request target 和 path/query 规范化：只接受 origin-form path；拒绝 absolute-form、authority-form、percent-encoded slash/backslash、空 path segment、`..`、重复 query 字段和未知 query 字段；`captureId`、`sessionId`、`nonce` 只接受 Protocol identifier contract 定义的固定 ASCII regex 和长度。
- [ ] 拒绝重复或歧义请求头：重复 `Host`、`Authorization`、`Content-Type`、`Content-Length`，非法 `Content-Length`，`Content-Length` 与 `Transfer-Encoding` 同时出现，不以 `chunked` 结尾的 `Transfer-Encoding`，以及非 `identity` 的 `Content-Encoding`。
- [ ] 对状态、request、control、profile 和错误响应设置 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`；profile endpoint 额外设置 `Referrer-Policy: no-referrer`。
- [ ] 校验 capture request：`url`、`mode`、`waitMs`、`include`、`viewports`、`options.forceRefresh`、`options.captureScreenshotMetadata`、`options.targetMode`、`options.keepTabOpen`、`options.allowPrivateNetworkTarget`、`options.maxResourceUrls` 和未知字段；超出协议范围时返回 `400 INVALID_REQUEST`，不得创建 capture 或打开浏览器。
- [ ] 使用安全随机源生成 `apiToken`、`bridgeToken`、`sessionId`、capture `nonce`、`profileTransferId` 和 bridge 页面 CSP nonce；不得使用 `Math.random()`、时间戳或递增计数器生成安全边界值。
- [ ] token 校验必须走共享 helper：先做格式和长度检查，再使用固定时间比较或等效安全比较；失败路径只返回统一 `UNAUTHORIZED`/`FORBIDDEN`，不得在错误或日志中区分“前缀正确但后缀错误”等可被枚举的信息。
- [ ] `/bridge` URL 不包含 API token；HTML 内嵌一次性 `bridgeToken`，并设置 no-store、no-referrer、nosniff、`X-Frame-Options: DENY`、`Cross-Origin-Opener-Policy: same-origin`、`Permissions-Policy` 和不含 `unsafe-inline`、包含 `script-src 'nonce-{cspNonce}'`、`style-src 'nonce-{cspNonce}'`、`connect-src 'self'`、`frame-ancestors 'none'` 的 CSP。
- [ ] bridge config JSON script 也必须带本次响应的 `nonce`，测试覆盖 `<script id="stackprism-agent-bridge-config" type="application/json" nonce="...">` 存在，且所有 script/style nonce 与 CSP header 中的 nonce 一致。
- [ ] `/bridge` 响应使用 `Content-Type: text/html; charset=utf-8`，并在渲染 token 前执行 Host、request target、query schema 和来源导航校验；跨站 `Referer` 或 `Sec-Fetch-Site: cross-site` 必须返回 `ORIGIN_NOT_ALLOWED` 且不渲染 token。
- [ ] `/bridge` 渲染前校验 `session`、`capture`、`nonce`，校验失败不输出 `bridgeToken`。
- [ ] `/bridge` 首次成功渲染 token 时记录 `bridgeTokenRenderedAt`；同一 `/bridge?...nonce=...` 再次打开不得重新渲染 `bridgeToken`，即使 content script 尚未 claim，也只能返回无 token 状态页或 409。
- [ ] `bridgeToken` 首次成功读取 request 或写入 `waiting_extension` 后标记为 claimed；claimed 后同一 `/bridge?...nonce=...` 再次打开也不得重新渲染 `bridgeToken`。
- [ ] bridge HTML config 必须使用 script-safe JSON 转义，不反射 query 或错误文本到可执行 HTML；页面状态更新只能用 `textContent` 或等效安全 API，不能用 `innerHTML` 写入服务端返回的 message/details。
- [ ] `POST /v1/captures` 创建 capture 后立即尝试自动打开该 capture 的 bridge 页面；打开失败时返回 `BROWSER_OPEN_FAILED` 并把 capture 标记为 `failed`。
- [ ] 实现 `/health`、`/bridge`、`POST /v1/captures`、`GET /v1/captures/{id}`、`GET /v1/captures/{id}/request`、`GET /v1/captures/{id}/control`、`GET /v1/captures/{id}/profile`、`POST /v1/captures/{id}/status`、`POST /v1/captures/{id}/profile`、`DELETE /v1/captures/{id}`。
- [ ] 除 `/health` 和 `/bridge` 外，所有 endpoint 都校验 Bearer token；Agent endpoint 只接受 `apiToken`，插件 endpoint 只接受对应 capture 的 `bridgeToken`。
- [ ] `GET /v1/captures/{id}` 同时支持 `apiToken` 和同 capture 的 `bridgeToken`；`GET /v1/captures/{id}/profile` 只支持 `apiToken`，`bridgeToken` 必须返回 `BRIDGE_TOKEN_CANNOT_READ_PROFILE`。
- [ ] `GET /v1/captures/{id}/request` 只支持同 capture 的 `bridgeToken`，返回 `captureId`、`sessionId`、`nonce`、`protocolVersion` 和规范化 `request`，不得返回 `apiToken`、`bridgeToken`、profile body 或 callback URL；测试覆盖跨 capture token、response shape 和敏感字段缺失。
- [ ] 校验 Host 头，只接受当前 loopback host:port。
- [ ] 对非 profile JSON 请求 body 大小设限，例如 5 MB；超限返回 `413 REQUEST_TOO_LARGE`。
- [ ] 对 `POST /v1/captures/{id}/profile` 使用独立 8 MB 上限；超限返回 `PROFILE_TOO_LARGE`，并要求插件先做 truncation。共享 body reader 必须按 endpoint 传入 limit，避免先被 5 MB 通用限制截断而拿不到 profile 专用错误码。
- [ ] 实现 HTTP resource policy：限制打开连接数、设置 headers/body/keep-alive timeout、逐块累计 body 字节并在超限时停止读取、按协议处理或拒绝 chunked body、SIGINT/SIGTERM/stdin EOF 时关闭 server 和 timer。
- [ ] 实现基础 rate limit：capture 创建每分钟最多 10 次，状态/profile 查询每分钟最多 120 次，超限返回 `RATE_LIMITED`。
- [ ] 将 URL 归一化、bridge origin 自捕获判断、credential/protocol 校验和 private-network 判断拆成可导出的纯 helper；helper 接收 resolver 参数，生产 resolver 使用 `node:dns`，单元测试使用 `tests/fixtures/bridge-url-policy-cases.json` 注入的假 resolver。
- [ ] 生产 DNS resolver 设置 2 秒超时，并把解析超时、NXDOMAIN、SERVFAIL、空结果和任一私网答案按 Target policy 的 fail-closed 语义映射为结构化错误。
- [ ] 使用生产 resolver 解析目标 hostname，并把解析到 private/loopback/link-local 地址的目标按 `PRIVATE_NETWORK_TARGET_BLOCKED` 拒绝，除非显式开启 `allowPrivateNetworkTarget`。
- [ ] 即使 `allowPrivateNetworkTarget = true`，目标 URL 指向当前 bridge server origin 时也返回 `BRIDGE_SELF_TARGET_BLOCKED`。
- [ ] 对插件上报的 final URL 执行同一套 URL 和 DNS 校验；失败时把 capture 标记为 `FINAL_URL_BLOCKED`。
- [ ] `POST /v1/captures/{id}/status` 收到 `phase = "target_loaded"` 时必须校验 `finalUrl`；失败时直接返回 `409`，让插件在主动检测和 profiler 前中止。
- [ ] 实现 status phase 和 sequence 规则：只接受定义过的 phase，只接受递增 sequence，终态不可被 late status 覆盖，倒序或重复 status 返回 `409 STALE_STATUS_UPDATE`。
- [ ] `tests/stackprism-bridge.test.mjs` 必须读取 `tests/fixtures/bridge-protocol-identifiers.json`，确认 JS bridge 的 token/id 生成器只生成合法值，路由/query/Bearer validator 拒绝所有非法样例，且错误响应不暴露 token 正确前缀、错误位置或相似度。
- [ ] 新增 `tests/fixtures/bridge-url-policy-cases.json`，覆盖 `127.0.0.1`、`localhost`、`192.168.0.1`、`10.0.0.1`、`172.16.0.1`、`169.254.0.1`、`::1`、`fc00::/7`、`fe80::/10`、公网页面、credential URL、fragment 丢弃、hostname 解析到私网地址、默认端口折叠、host 大小写归一、query 完全相同时可匹配、query 不同时不可复用 tab、以及目标指向 bridge server origin 的场景。
- [ ] capture 默认 60 秒过期。
- [ ] capture store/timer 模块必须支持测试注入 clock/timer 或测试专用短时配置；生产默认仍使用 30 秒握手超时、60 秒全局超时、10 秒取消超时和 10 分钟 completed TTL。单元测试不得真实等待 30 秒、60 秒或 10 分钟。
- [ ] `queued` 或 `waiting_extension` 30 秒无握手时标记 `EXTENSION_NOT_CONNECTED`；completed profile 保留 10 分钟后转为 `expired`、清除 profile body，并让 profile endpoint 返回 `CAPTURE_RESULT_EXPIRED`。
- [ ] running capture 超过 60 秒时标记 `CAPTURE_TIMEOUT`，control endpoint 返回 `cancel`，late status/profile 不得覆盖该失败终态。
- [ ] `DELETE /v1/captures/{id}` 只允许 `queued`、`waiting_extension`、`running` 转为 `cancel_requested`，control endpoint 返回 `cancel`，插件确认后进入 `cancelled`；不能在 DELETE 时立刻删除 capture。`cancel_requested` 超过 10 秒无确认时转为 `cancelled` 并拒绝 late status 覆盖；对 `completed`、`failed`、`cancelled`、`expired` 调用 DELETE 必须返回 `409` 和当前终态。
- [ ] 默认不返回 `Access-Control-Allow-Origin: *`；profile 回传测试覆盖 bridge content script 同源 POST 路径。
- [ ] 对敏感 endpoint 校验 `Origin`、`Referer` 和 `Sec-Fetch-Site`：无这些浏览器头的 Agent/curl 请求允许继续走 Bearer 校验；同 origin bridge 页面请求允许；跨站 `Origin`、跨站 `Referer` 或 `Sec-Fetch-Site: cross-site` 返回 `403 ORIGIN_NOT_ALLOWED` 且不返回 CORS 允许头。
- [ ] 测试恶意网页式 preflight 和 no-cors/simple request：`OPTIONS` 不能拿到 CORS 允许头；无 Bearer 或非 JSON content type 的请求被拒绝；带跨站 `Origin`/Fetch Metadata 的请求被 `ORIGIN_NOT_ALLOWED` 拒绝；bridge API 不因浏览器跨站请求创建 capture。
- [ ] 测试 API 状态流、统一错误响应、所有 JSON endpoint 的 `Content-Type: application/json; charset=utf-8`、`/bridge` 的 `Content-Type: text/html; charset=utf-8`、不支持 method 的 `Allow` 头、request validation、未知字段拒绝、method/auth/content-type/Host/Origin 错误、非法 request target、非法 path/query、重复或歧义 header、非 UTF-8 charset、非法 UTF-8 JSON body、`OPTIONS` preflight 拒绝且无 `Access-Control-Allow-*` 头、token-bearing response 的 no-store/nosniff/referrer-policy、请求超时/超大 body/连接数限制/chunked body 策略、status phase/sequence 拒绝、token 校验、安全随机 helper 不使用 `Math.random()`、bridge CSP 不含 `unsafe-inline` 且含 nonce、JSON config script 带 nonce、bridgeToken 同 capture 状态读取、bridgeToken 不能读 profile、bridgeToken 首次 render 后 `/bridge` 不再泄露 token、bridgeToken claimed 后 `/bridge` 不再泄露 token、bridge HTML script-safe 转义、`target_loaded` final URL 拒绝、status 回写、control 取消、cancel 超时、terminal DELETE 返回 409、running capture 全局超时、profile 回写、profile wrapper/schema/captureId mismatch 拒绝、重复 profile 回写返回 `NONCE_REUSED` 或 `CAPTURE_ALREADY_COMPLETED`、超大 profile body 返回 `PROFILE_TOO_LARGE`、过期清理、浏览器打开失败错误、非法环境变量 `BRIDGE_INVALID_ENV`、指定端口占用 `PORT_IN_USE`、stdout ready JSON 结构、stderr 日志不含 Authorization/token/query/profile body、DNS lookup failure、以及 DNS private target 拒绝；URL policy 测试必须读取 `tests/fixtures/bridge-url-policy-cases.json` 并注入假 resolver。
- [ ] 浏览器打开失败测试必须覆盖 `STACKPRISM_BROWSER_OPEN_ARGS_JSON` 非法值返回 `BROWSER_OPEN_FAILED`，以及包含 shell 元字符的 bridge URL 仍作为单个 argv 传给假命令。
- [ ] 所有 JS bridge 子进程测试默认设置 `STACKPRISM_BRIDGE_NO_OPEN=1`，并用 `t.after()`、`try/finally` 或等效逻辑关闭子进程、HTTP server 和 timer；只有专门测试浏览器打开失败时才允许禁用 no-open，并且必须使用不会真实打开浏览器的假命令。
- [ ] Host 校验测试必须覆盖 `/health`、`/bridge` 和至少一个 Bearer endpoint：`Host: 127.0.0.1:{port}` 允许，缺失 Host、错误端口、`localhost:{port}`、`[::1]:{port}` 和任意外部 host 均拒绝，除非实现显式扩展 localhost/IPv6 并同步 manifest/CSP/文档。
- [ ] bridge 脚本应支持被测试导入而不自动启动 server；CLI 入口必须用 `import.meta.url` 与 `process.argv[1]` guard。
- [ ] 运行 `pnpm exec prettier --check agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs agent-skill/stackprism-site-experience/scripts/bridge/*.mjs tests/stackprism-bridge.test.mjs tests/fixtures/bridge-url-policy-cases.json tests/fixtures/bridge-protocol-identifiers.json`，确认 JS bridge 脚本、helper 和测试 fixture 未被格式化工具漏掉。
- [ ] 验证：`node --check agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs` 通过。
- [ ] 验证：`for f in agent-skill/stackprism-site-experience/scripts/bridge/*.mjs; do node --check "$f"; done` 通过，避免 `node --check` 只检查第一个展开文件。
- [ ] 验证：`node --test --test-timeout=60000 tests/stackprism-bridge.test.mjs` 通过。
- [ ] Commit: `feat: add node bridge script for agents`

### Task 7: 实现 Python fallback 脚本

**Files:**

- Create: `agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py`
- Create: `agent-skill/stackprism-site-experience/scripts/stackprism_bridge_lib/*.py`
- Create: `tests/stackprism_bridge_py.test.mjs`
- Reuse: `tests/fixtures/bridge-url-policy-cases.json`
- Reuse: `tests/fixtures/bridge-protocol-identifiers.json`

- [ ] 使用 Python 标准库 `http.server`。
- [ ] `stackprism_bridge.py` 只保留 CLI guard、启动参数读取和 server lifecycle；HTTP routing、capture store、URL policy、DNS、body limit、browser open、redaction 和 error response 拆入 `scripts/stackprism_bridge_lib/*.py` helper，至少包含 `http_server.py`、`capture_store.py`、`url_policy.py`、`security.py` 和 `open_browser.py`，避免单文件超 300 行。
- [ ] 提供与 JS bridge 一致的 `/health`、`/bridge`、`POST /v1/captures`、`GET /v1/captures/{id}`、`GET /v1/captures/{id}/request`、`GET /v1/captures/{id}/control`、`GET /v1/captures/{id}/profile`、`POST /v1/captures/{id}/status`、`POST /v1/captures/{id}/profile`、`DELETE /v1/captures/{id}`。
- [ ] 保持与 JS bridge 相同的成功 response body 和错误 envelope，不为成功响应额外包 `ok`。
- [ ] 与 JS bridge 使用相同的统一 JSON 错误响应和 capture request validation；错误码、HTTP status 和脱敏 `details` 语义必须一致。
- [ ] 与 JS bridge 使用相同的 method/auth/content-type 错误响应和 status phase/sequence 规则。
- [ ] 与 JS bridge 使用相同的 `OPTIONS` preflight 拒绝、无 CORS 允许头、`Origin`/`Referer`/`Sec-Fetch-Site` 校验、no-store/nosniff/referrer-policy 响应头策略。
- [ ] 与 JS bridge 使用相同的 request target、path/query schema、重复 header、歧义 `Content-Length`/`Transfer-Encoding` 和 `Content-Encoding` 拒绝语义；如果 Python 标准库已在 handler 前吞掉某些非法请求，测试必须记录可观测响应并确认不会进入业务 routing。
- [ ] 与 JS bridge 使用相同的 Host 头校验语义；`tests/stackprism_bridge_py.test.mjs` 必须抽样覆盖 `/health`、`/bridge` 和 Bearer endpoint 的 Host 允许/拒绝行为。
- [ ] 模块必须可被测试 import 而不自动启动 server；CLI 入口使用 `if __name__ == "__main__"` guard。
- [ ] 指定 `STACKPRISM_BRIDGE_PORT` 且端口被占用时，进程必须非零退出，stderr 输出脱敏 `PORT_IN_USE`，stdout 不输出 ready JSON。
- [ ] 与 JS bridge 一样在启动前校验环境变量：`STACKPRISM_BRIDGE_PORT` 未设置时才使用随机端口；设置后必须是 `1..65535` 的十进制整数；browser open 相关环境变量不得包含 NUL 字符。非法端口或 NUL 字符返回 `BRIDGE_INVALID_ENV`，非零退出，stdout 不输出 ready JSON，stderr 不泄露 token 或 bridge URL query；`STACKPRISM_BROWSER_OPEN_ARGS_JSON` 的非法 JSON/非数组/非字符串元素仍由打开浏览器步骤返回 `BROWSER_OPEN_FAILED`。
- [ ] 启动成功后 stdout 只输出一行 JSON line，字段与 JS bridge 一致；其他日志写 stderr。ready JSON 必须在 server 已绑定且 endpoint 可接受请求后输出。
- [ ] 除 `/health` 和 `/bridge` 外，所有 endpoint 都校验 Bearer token；Agent endpoint 只接受 `apiToken`，插件 endpoint 只接受对应 capture 的 `bridgeToken`，与 JS bridge 一致。
- [ ] `GET /v1/captures/{id}` 同时支持 `apiToken` 和同 capture 的 `bridgeToken`；`GET /v1/captures/{id}/profile` 只支持 `apiToken`，与 JS bridge 一致。
- [ ] 使用 Python 标准库 `webbrowser.open` 自动打开 bridge 页面，并支持环境变量覆盖浏览器命令；失败时返回 `BROWSER_OPEN_FAILED`。
- [ ] Python fallback 与 JS bridge 一样，浏览器打开命令不得通过 shell 字符串拼接 bridge URL；覆盖命令只接受可执行文件路径，额外参数来自 `STACKPRISM_BROWSER_OPEN_ARGS_JSON` JSON 数组。
- [ ] Python fallback 与 JS bridge 一样严格校验 `STACKPRISM_BROWSER_OPEN_ARGS_JSON` 为字符串数组；非法值返回 `BROWSER_OPEN_FAILED` 和脱敏 `details.reason = "invalid_open_args"`，测试使用假命令确认 bridge URL 作为单个 argv 传入。
- [ ] 支持测试环境变量 `STACKPRISM_BRIDGE_NO_OPEN=1` 禁止自动打开浏览器，避免单元测试弹出浏览器或依赖用户桌面环境；该模式下创建 capture 不得返回 `BROWSER_OPEN_FAILED`，而是返回 `queued` 和 `bridgeUrl`。
- [ ] 使用安全随机源生成 `apiToken`、`bridgeToken`、`sessionId`、capture `nonce`、`profileTransferId` 和 bridge 页面 CSP nonce；不得使用时间戳、计数器或 `random.random()` 生成安全边界值；token 校验使用共享 helper 和固定时间比较或等效安全比较。
- [ ] `/bridge` URL 不包含 API token；HTML 内嵌一次性 `bridgeToken`，并设置 no-store、no-referrer、nosniff、`X-Frame-Options: DENY`、`Cross-Origin-Opener-Policy: same-origin`、`Permissions-Policy` 和不含 `unsafe-inline`、包含 `script-src 'nonce-{cspNonce}'`、`style-src 'nonce-{cspNonce}'`、`connect-src 'self'`、`frame-ancestors 'none'` 的 CSP。
- [ ] bridge config JSON script 也必须带本次响应的 `nonce`，测试覆盖 `<script id="stackprism-agent-bridge-config" type="application/json" nonce="...">` 存在，且所有 script/style nonce 与 CSP header 中的 nonce 一致。
- [ ] `/bridge` 响应使用 `Content-Type: text/html; charset=utf-8`，并在渲染 token 前执行 Host、request target、query schema 和来源导航校验；跨站 `Referer` 或 `Sec-Fetch-Site: cross-site` 必须返回 `ORIGIN_NOT_ALLOWED` 且不渲染 token。
- [ ] `/bridge` 渲染前校验 `session`、`capture`、`nonce`，校验失败不输出 `bridgeToken`。
- [ ] 与 JS bridge 一致，`bridgeToken` 首次 render 后和 claimed 后，同一 `/bridge?...nonce=...` 不得再次渲染 token。
- [ ] 与 JS bridge 一致，bridge HTML 必须做 script-safe JSON 转义，并测试恶意 query 不会打断 JSON script 或反射为可执行 HTML。
- [ ] 实现与 JS bridge 一致的基础 rate limit、body 大小限制和 HTTP resource policy；若标准库无法可靠支持 chunked body，必须按协议返回 `UNSUPPORTED_TRANSFER_ENCODING`，不能阻塞读取。
- [ ] 将 URL policy 拆成可被测试调用的纯函数，接收 resolver 参数；生产 resolver 使用 `socket.getaddrinfo`，测试 resolver 使用 `tests/fixtures/bridge-url-policy-cases.json` 的固定结果，避免依赖真实 DNS。
- [ ] 生产 DNS resolver 设置 2 秒超时，并与 JS bridge 一样 fail closed。
- [ ] 使用生产 resolver 解析目标 hostname，并与 JS bridge 使用同一 private network 判断语义。
- [ ] 即使 `allowPrivateNetworkTarget = true`，目标 URL 指向当前 bridge server origin 时也返回 `BRIDGE_SELF_TARGET_BLOCKED`。
- [ ] 对插件上报的 final URL 执行同一套 URL 和 DNS 校验；失败时把 capture 标记为 `FINAL_URL_BLOCKED`。
- [ ] `POST /v1/captures/{id}/status` 收到 `phase = "target_loaded"` 时必须校验 `finalUrl`；失败时直接返回 `409`，与 JS bridge 一致。
- [ ] `tests/stackprism_bridge_py.test.mjs` 必须复用 `tests/fixtures/bridge-url-policy-cases.json` 并注入假 resolver，确认 Python fallback 与 JS bridge 在 URL policy 上一致。
- [ ] `tests/stackprism_bridge_py.test.mjs` 必须复用 `tests/fixtures/bridge-protocol-identifiers.json`，确认 Python fallback 的 token/id 生成、path/query validator 和 Bearer validator 与 JS bridge 接受/拒绝结果一致。
- [ ] 实现与 JS bridge 一致的 status 回写、control 取消和 profile 回写 endpoint；`POST /profile` 接收原始 `SiteExperienceProfile` JSON，不接收额外 wrapper，也不要求 nonce 出现在 profile body。
- [ ] 实现与 JS bridge 一致的握手超时和 completed profile TTL；TTL 到期后状态转为 `expired` 并清除 profile body。
- [ ] Python capture store/timer 也必须支持测试注入 clock/timer 或测试专用短时配置；专项测试不得真实等待 30 秒、60 秒或 10 分钟。
- [ ] 实现与 JS bridge 一致的 `CAPTURE_TIMEOUT`、`cancel_requested` -> `cancelled` 状态流、10 秒 cancel 超时、terminal DELETE 返回 409；不能在 DELETE 时立刻删除 capture，也不能用 DELETE 改写已失败、已取消、已过期或已完成 capture 的终态。
- [ ] `tests/stackprism_bridge_py.test.mjs` 抽样覆盖 JSON response content-type、`Allow` 头、stderr 脱敏、profile wrapper/schema/captureId mismatch、重复 profile 回写和超大 profile body，确认错误码与 JS bridge 一致。
- [ ] `tests/stackprism_bridge_py.test.mjs` 抽样覆盖 request endpoint response shape：只返回 `captureId`、`sessionId`、`nonce`、`protocolVersion` 和规范化 `request`，不返回 `apiToken`、`bridgeToken`、profile body 或 callback URL。
- [ ] 所有 Python fallback 子进程测试默认设置 `STACKPRISM_BRIDGE_NO_OPEN=1`，并用 `t.after()`、`try/finally` 或等效逻辑关闭子进程、HTTP server 和 timer；浏览器打开失败测试必须使用不会真实打开浏览器的假命令。
- [ ] 运行 `pnpm exec prettier --check tests/stackprism_bridge_py.test.mjs`，确认 Python fallback 的 JS 测试未被格式化工具漏掉。Python fallback 只用 `py_compile` 和专项测试校验，不交给 Prettier。
- [ ] 验证：`python3 -m py_compile agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py` 通过。
- [ ] 验证：`python3 -m compileall -q agent-skill/stackprism-site-experience/scripts/stackprism_bridge_lib` 通过，避免 shell 通配符在无匹配时传给 `py_compile`。
- [ ] 验证：`node --test --test-timeout=60000 tests/stackprism_bridge_py.test.mjs` 启动 Python 子进程并确认 `/health` 返回一致字段。
- [ ] Commit: `feat: add python bridge fallback script`

### Task 8: 编写 Skill

**Files:**

- Create: `agent-skill/stackprism-site-experience/SKILL.md`
- Create: `agent-skill/stackprism-site-experience/README.md`
- Create: `agent-skill/stackprism-site-experience/agents/openai.yaml`
- Create: `agent-skill/stackprism-site-experience/references/site-experience-profile-schema.md`
- Create: `agent-skill/stackprism-site-experience/references/agent-consumption-guide.md`
- Modify: `.prettierignore`

- [ ] `SKILL.md` 说明触发场景：复刻网站视觉、参考 UI/UX、采集技术与体验 profile。
- [ ] `README.md` 说明 repo-local skill 的安装/发现边界：默认不自动进入 Codex 全局 Skills 列表，用户或发布流程需要复制/软链接到 `$CODEX_HOME/skills`；Agent 也可以直接按 repo path 运行脚本。
- [ ] 明确首选 JS 脚本，Python 为 fallback。
- [ ] 说明默认打开系统浏览器；如果插件安装在非默认浏览器，Agent 必须设置 `STACKPRISM_BROWSER_OPEN_COMMAND` 指向对应 Chrome 内核浏览器和用户 profile。
- [ ] Skill 使用示例必须展示 bridge 子进程生命周期：启动后最多等待 10 秒读取 ready JSON，遇到超时、非 JSON、缺字段或 `protocolVersion` 不匹配时分别按 `BRIDGE_START_TIMEOUT`、`BRIDGE_READY_PARSE_FAILED`、`BRIDGE_PROTOCOL_UNSUPPORTED` 失败处理；完成 capture 或失败后在 `finally` 中发送 SIGTERM/关闭子进程，并等待退出；不得鼓励 Agent 留下常驻本地 bridge。
- [ ] Skill 示例和 README 日志片段必须对 ready JSON 中的 `apiToken` 做脱敏；不得把原始 ready JSON 直接打印到报告、stdout 示例或错误日志。
- [ ] 浏览器选择文档必须同时说明 `STACKPRISM_BROWSER_OPEN_COMMAND` 只接受可执行文件路径，额外用户 profile 参数必须通过 `STACKPRISM_BROWSER_OPEN_ARGS_JSON` JSON 数组传入，bridge URL 永远由脚本作为最后一个独立参数追加。
- [ ] 文档必须说明 `STACKPRISM_BROWSER_OPEN_ARGS_JSON` 只能是 JSON 字符串数组；示例中不得把 bridge URL 写入该数组，URL 永远由脚本追加，避免用户把 token-bearing URL 放进 shell 命令或日志。
- [ ] 说明第一版为 passive capture，不会点击、提交、登录或执行破坏性操作。
- [ ] 说明 `viewports` 不是 CDP 移动仿真，Agent 不能把它当作真实手机截图。
- [ ] 明确 Agent 读取 profile 后优先复刻体验，不盲目照搬技术。
- [ ] `agents/openai.yaml` 仅作为可选 metadata 与发布辅助文件；不得在文档中声称 repo 内 `agents/openai.yaml` 会让 Codex 自动发现 Skill。Codex 自动发现仍以复制/软链接到 `$CODEX_HOME/skills` 后的 `SKILL.md` 为准。
- [ ] schema reference 与 TypeScript schema 字段一致。
- [ ] consumption guide 给出从 profile 到实现任务的步骤。
- [ ] 复查 Task 6 已加入的 `.gitignore` 例外仍生效，确认以下命令退出码为 1 且无输出：`git check-ignore -v --no-index agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs agent-skill/stackprism-site-experience/scripts/bridge/http-server.mjs agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py agent-skill/stackprism-site-experience/scripts/stackprism_bridge_lib/http_server.py`。使用 `--no-index`，避免已跟踪文件让 ignore 规则检查产生假阴性。
- [ ] `.prettierignore` 保持 Skill 脚本不被忽略；分别运行 `pnpm exec prettier --file-info agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs` 和 `pnpm exec prettier --file-info agent-skill/stackprism-site-experience/scripts/bridge/http-server.mjs`，确认返回 JSON 中 `"ignored": false`，因为 `prettier --check` 对被 ignore 的显式路径可能不足以证明格式化覆盖真实生效。
- [ ] 运行 `pnpm exec prettier --check agent-skill/stackprism-site-experience/SKILL.md agent-skill/stackprism-site-experience/README.md agent-skill/stackprism-site-experience/agents/openai.yaml agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs agent-skill/stackprism-site-experience/scripts/bridge/*.mjs agent-skill/stackprism-site-experience/references/site-experience-profile-schema.md agent-skill/stackprism-site-experience/references/agent-consumption-guide.md`，确认 repo-local Skill 文档、YAML 和 JS bridge 脚本未被格式化工具漏掉。Python fallback 只用 `py_compile` 和专项测试校验，不交给 Prettier。
- [ ] Commit: `docs: add stackprism site experience skill`

### Task 9: 文档与开发手册

**Files:**

- Create: `docs/dev/agent-bridge.md`
- Modify: `docs/dev/index.md`
- Modify: `docs/dev/architecture.md`
- Modify: `docs/dev/detection-flow.md`
- Modify: `docs/dev/release.md`
- Modify: `docs/.vitepress/config.ts`
- Modify: `.github/workflows/release-extension.yml`
- Modify: `PRIVACY.md`
- Modify: `README.md`
- Modify: `docs/guide/basic-usage.md`

- [ ] 记录 Agent Bridge 数据流、API、profile schema、安全约束。
- [ ] `PRIVACY.md` 写清楚新增采集边界、不会采集的敏感数据类型、loopback bridge 和 token 生命周期。
- [ ] `docs/dev/agent-bridge.md`、`PRIVACY.md`、`README.md` 与 `docs/guide/basic-usage.md` 明确本机信任边界：Agent Bridge 只防跨站网页和误用路径，不防同机恶意进程伪造兼容 loopback bridge；需要该级别隔离时应转向 Native Messaging 或等效本机 broker。
- [ ] `README.md` 与 `docs/guide/basic-usage.md` 说明 Agent Bridge 需要已安装扩展、默认 passive capture、失败路径和浏览器选择方式。
- [ ] `README.md`、`docs/guide/basic-usage.md` 和 Skill 使用说明必须说明首次使用前需要在设置页启用 Agent Bridge；若未启用，Skill 示例必须把 `AGENT_BRIDGE_DISABLED` 显示为用户可操作错误，而不是重试或降级。
- [ ] 用户文档和设置页文案必须说明 Agent Bridge 启用状态是当前浏览器 profile 的本机设置，不随 Chrome sync 同步到其他设备；换设备、换浏览器 profile 或重装扩展后需要重新显式启用。
- [ ] `docs/dev/agent-bridge.md`、`PRIVACY.md`、`README.md` 与 `docs/guide/basic-usage.md` 必须明确同浏览器其他扩展不在第一版防护范围内；建议用户在干净浏览器 profile 或只安装可信扩展的 profile 中使用 Agent Bridge。
- [ ] `docs/dev/release.md` 增加 Chrome Web Store / Edge Add-ons 发布前人工检查项：如果发布 Agent Bridge，需要同步商店隐私披露、数据用途说明和用户可见说明，明确数据会被发送到用户本机 loopback bridge 供本地 Agent 读取，但不会发送到 StackPrism 远程服务器。
- [ ] `docs/dev/release.md` 明确 `agent-skill/` 是 repo-local Agent 工具，不属于浏览器扩展运行时；Chrome Web Store / Edge Add-ons 上传包只能来自 `dist/`，不得把 `agent-skill/`、本地 HTTP bridge 脚本、测试 fixture、`docs/superpowers/` 或 Python 字节码缓存打入 zip/crx。
- [ ] `.github/workflows/release-extension.yml` 在打包 zip/crx 前运行 `pnpm run lint`、`pnpm run build:injected`、`pnpm run test:unit` 和 `pnpm run typecheck`；若 `typecheck` 仍包含最终 `pnpm build`，不得再用旧 `dist/` 打包。
- [ ] `.github/workflows/release-extension.yml` 在 zip 前增加 dist hygiene 检查：确认 `dist/manifest.json` 不含 `externally_connectable`，`web_accessible_resources` 不暴露 `agent-skill/`、`stackprism-bridge.mjs`、`stackprism_bridge.py` 或 `experience-profiler.iife.js`（除非已有独立文档理由和最小 match），并确认 `dist/` 内不存在 `agent-skill/`、`docs/superpowers/`、`tests/`、`*.py`、`__pycache__/` 或本地 bridge server helper 源文件。
- [ ] `docs/.vitepress/config.ts` 的开发手册 sidebar 加入 `/dev/agent-bridge`。
- [ ] release checklist 增加 bridge smoke test。
- [ ] detection-flow 增加 agent capture 管道。
- [ ] 运行 `pnpm exec prettier --check docs/dev/agent-bridge.md docs/dev/index.md docs/dev/architecture.md docs/dev/detection-flow.md docs/dev/release.md docs/.vitepress/config.ts README.md PRIVACY.md docs/guide/basic-usage.md`，确认 Task 9 修改的 Markdown/VitePress 配置未被格式化工具漏掉。
- [ ] 验证：`pnpm run docs:build` 通过。
- [ ] Commit: `docs: document agent bridge workflow`

### Task 10: 端到端验证与收口

**Files:**

- Create: `docs/reviews/CR-AGENT-BRIDGE-E2E-2026-05-22.md`
- No other new files unless fixing defects.

- [ ] 确认 `docs/reviews/` 存在；若不存在先创建该目录，再写入 E2E 报告。
- [ ] 运行 `pnpm run build:injected`，先生成 `public/injected/*.iife.js`；干净 checkout 中该目录被 `.gitignore` 忽略，必须在依赖构建产物的单元测试前生成。
- [ ] 运行 `pnpm run test:unit`。
- [ ] 运行 `pnpm run lint`。
- [ ] 分别运行 `pnpm exec prettier --file-info agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs`、`pnpm exec prettier --file-info agent-skill/stackprism-site-experience/scripts/bridge/http-server.mjs` 和 `pnpm exec prettier --file-info docs/reviews/CR-AGENT-BRIDGE-E2E-2026-05-22.md`，确认三次返回 JSON 中 `"ignored": false`；`prettier --file-info` 不能接多个文件。
- [ ] 运行 `pnpm exec prettier --check build-scripts/build-injected.mjs vite.injected.config.ts tests/*.test.mjs tests/helpers/load-ts-module.mjs tests/fixtures/*.json tests/fixtures/*.html agent-skill/stackprism-site-experience/SKILL.md agent-skill/stackprism-site-experience/README.md agent-skill/stackprism-site-experience/agents/openai.yaml agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs agent-skill/stackprism-site-experience/scripts/bridge/*.mjs agent-skill/stackprism-site-experience/references/site-experience-profile-schema.md agent-skill/stackprism-site-experience/references/agent-consumption-guide.md docs/dev/agent-bridge.md docs/dev/index.md docs/dev/architecture.md docs/dev/detection-flow.md docs/dev/release.md docs/.vitepress/config.ts README.md PRIVACY.md docs/guide/basic-usage.md docs/reviews/CR-AGENT-BRIDGE-E2E-2026-05-22.md`。不要把 Python fallback 交给 Prettier。
- [ ] 运行 `pnpm run typecheck`。
- [ ] 运行 `pnpm run build`。
- [ ] 运行 `pnpm run docs:build`。
- [ ] 运行 `node --check agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs`。
- [ ] 运行 `for f in agent-skill/stackprism-site-experience/scripts/bridge/*.mjs; do node --check "$f"; done`。
- [ ] 运行 `python3 -m py_compile agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py`。
- [ ] 运行 `python3 -m compileall -q agent-skill/stackprism-site-experience/scripts/stackprism_bridge_lib`。
- [ ] 运行 `node --test --test-timeout=60000 tests/stackprism-bridge.test.mjs`。
- [ ] 运行 `node --test --test-timeout=60000 tests/stackprism_bridge_py.test.mjs`。
- [ ] 加载 `dist/` 到 Chrome/Edge。
- [ ] 启动 JS bridge 脚本。
- [ ] 从启动 JSON line 提取 `baseUrl` 和 `apiToken`，设置 `STACKPRISM_BRIDGE_BASE_URL` 与 `STACKPRISM_BRIDGE_TOKEN`。
- [ ] 使用被占用端口启动一次 JS bridge，确认进程非零退出、stdout 没有 ready JSON、stderr 只包含脱敏 `PORT_IN_USE` 摘要。
- [ ] 使用非法 `STACKPRISM_BRIDGE_PORT`、包含 NUL 字符的 browser open 配置分别启动一次 JS/Python bridge，确认进程非零退出、stdout 没有 ready JSON、stderr 只包含脱敏 `BRIDGE_INVALID_ENV` 摘要，且未生成 token；另用非法 `STACKPRISM_BROWSER_OPEN_ARGS_JSON` 创建 capture，确认按既有约定返回 `BROWSER_OPEN_FAILED`。
- [ ] 用 `curl` 创建 capture：
  ```bash
  curl --max-time 60 -sS -X POST "${STACKPRISM_BRIDGE_BASE_URL}/v1/captures" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${STACKPRISM_BRIDGE_TOKEN}" \
    -d '{"url":"https://example.com","mode":"experience","waitMs":1000,"include":["tech","visual","layout","components","interaction","ux","assets"]}'
  ```
- [ ] 带相同 Bearer token 轮询 profile endpoint，轮询总时长不得超过 70 秒，单次 `curl` 使用 `--max-time 10`；确认返回 `stackprism.site_experience_profile.v1`，超时则记录最后一次状态响应和 bridge stderr 脱敏摘要。
- [ ] 对已经 `completed`、`failed`、`cancelled`、`expired` 的 capture 分别调用 `DELETE /v1/captures/{id}`，确认都返回 `409` 和当前终态，避免把完成结果、失败原因或过期状态误改写。
- [ ] 另建一个尚未 completed 的长运行 capture，再调用 `DELETE /v1/captures/{id}` 验证插件收到 cancel control，自己创建的目标 tab 被关闭，用户原有 tab 不被关闭。
- [ ] 对同一个未完成 capture 模拟插件不确认取消，确认 `cancel_requested` 10 秒后转为 `cancelled`，且 late status 不能覆盖终态。
- [ ] 模拟关闭 bridge tab 和目标 tab，确认分别返回 `BRIDGE_TAB_CLOSED` 与 `TARGET_TAB_CLOSED`。
- [ ] 模拟或手动触发 extension service worker 重启，确认未完成 capture 会通过 bridge content script 上报 `SERVICE_WORKER_RESTARTED` 或 `BRIDGE_TRANSPORT_DISCONNECTED`，且插件自己创建的目标 tab 被清理。
- [ ] 模拟扩展 reload/update、用户禁用扩展或 `chrome.storage.session` 被清空后的恢复入口，确认未完成 capture 不会被伪恢复，残留 agent capture state 被清理，插件自己创建的目标 tab 被关闭，Agent 最终看到结构化失败或 bridge timeout/expired。
- [ ] 模拟 service worker 在 deadline 前后重启或恢复，确认扩展侧不依赖丢失的内存 timer：过期 capture 在下一次事件或模块初始化时被 reconciliation helper fail closed，未过期 capture 也不会被误标完成。
- [ ] 测试目标站点重定向到被拒绝 final URL 时，bridge 在 `target_loaded` 阶段返回 `FINAL_URL_BLOCKED`，插件不会继续注入主动检测或 experience profiler。
- [ ] 检查 profile 不含 cookie、authorization、set-cookie 明文。
- [ ] 检查 profile 资源 URL 不含敏感 query 参数、签名 URL、hash 和 token-like 参数值。
- [ ] 检查大页面或 fixture 扩展样本触发截断时，profile 包含 `evidence.truncation` 和 limitation，而不是返回超限失败或静默丢字段。
- [ ] 用大 fixture 触发多片 profile transfer，确认 background 按 `384 * 1024` bytes raw payload 分片、bridge content script 逐片 ack、重组后 sha256 匹配，并且最终 profile endpoint 返回 `stackprism.site_experience_profile.v1`。
- [ ] 模拟 profile transfer 缺片、ack 超时、sha256 mismatch、错误 `sessionId`/`nonce` 和非法 `payloadBase64`，确认分别返回 `PROFILE_CHUNK_MISSING`、`PROFILE_TRANSPORT_FAILED` 或 `PROFILE_HASH_MISMATCH`，且不会让 Agent 只轮询到 `CAPTURE_TIMEOUT`。
- [ ] 模拟 request endpoint 返回错误 `captureId`、`sessionId`、`nonce` 或 `protocolVersion`，确认 bridge content script 上报 `BRIDGE_REQUEST_MISMATCH`，且 background 未收到 `START_AGENT_CAPTURE`。
- [ ] 模拟 extension capabilities 缺失 `profileChunkTransport` 或 `storageSession`，确认 capture 失败为 `NOT_SUPPORTED` 且不会打开目标 tab。
- [ ] 对同一 capture 重复 POST profile 和提交超过 8 MB 的 profile body，确认分别返回 `NONCE_REUSED` 或 `CAPTURE_ALREADY_COMPLETED`、`PROFILE_TOO_LARGE`。
- [ ] 用只包含 `["tech"]` 的 capture 验证 experience profiler 不运行，visual/layout/components/interaction/ux/assets 返回空对象并带 `section_not_requested` limitation。
- [ ] 模拟目标页主 frame 加载失败，确认返回 `TARGET_LOAD_FAILED`，不会把浏览器错误页写入 profile。
- [ ] 模拟目标页加载超过 capture 上限和目标 tab 在采集中导航到其他 URL，分别确认返回 `TARGET_LOAD_TIMEOUT` 与 `TARGET_NAVIGATED_AWAY`，且不会交付旧页面或混合页面 profile。
- [ ] 模拟或选择受限制目标页触发 `chrome.scripting.executeScript` 失败，确认返回 `TARGET_INJECTION_FAILED`，错误摘要已脱敏，插件自己创建的目标 tab 被清理。
- [ ] 分别用 `captureScreenshotMetadata = true` 和 `false` 创建 capture，确认 `true` 只输出视口尺寸、关键元素 bounding box 和 above-fold 摘要，`false` 不输出 bounding box / above-fold 细节，二者都不输出截图图像或像素数据。
- [ ] 检查 bridge 页面没有被普通检测写入 popup 缓存或 badge。
- [ ] 检查 bridge tab 的 `/bridge`、`/v1/captures/*/status`、`/v1/captures/*/control`、`/v1/captures/*/profile` 请求不会写入 `tab-store` header records、popup cache、badge 或 dynamic snapshot。
- [ ] 检查 bridge tab 发出的普通 runtime message 不会读写普通站点缓存；至少验证伪造 `PAGE_DETECTION_RESULT`、`DYNAMIC_PAGE_SNAPSHOT` 和带其他 tabId 的 popup/header 查询被拒绝或返回 unsupported。
- [ ] 检查 popup/options 对普通 tab 的读取仍可用，但 popup/options 或 content script 都不能读取 bridge tab 缓存或通过伪造 tabId 读取其他 tab。
- [ ] 检查 `chrome.storage.session` access level 未被放宽给 content scripts；若测试环境可观察 `setAccessLevel` 调用，必须确认未调用 `TRUSTED_AND_UNTRUSTED_CONTEXTS`，且 content script 不能直接读取 `agent-capture-state` 或 active-tab tracker key。
- [ ] 检查扩展侧 console/debug 输出不含 bridge URL query、nonce、token、Authorization header、profile body 或目标 URL 敏感 query；E2E 报告只记录脱敏摘要。
- [ ] 检查 bridge URL 和浏览器历史中不含 API token。
- [ ] 检查 `agentBridgeEnabled = false` 时，真实 bridge 页面握手失败为 `AGENT_BRIDGE_DISABLED`，目标 tab 没有被打开，profile endpoint 不会产生结果；再显式开启设置后，同一 smoke test 才能进入正常 capture。
- [ ] 检查 `chrome.storage.sync` 中存在旧 `agentBridgeEnabled: true` 但 `chrome.storage.local` 未启用时，真实 bridge 页面仍失败为 `AGENT_BRIDGE_DISABLED`；只有写入 local opt-in 后才允许 capture。
- [ ] 检查 `targetMode = "reuse_or_new_tab"` 对同 origin/path 但 query 不同的已打开 tab 不会复用，会新建目标 tab；检查 `active_tab` 对同 origin/path 但 query 不同的 active tab 返回 `ACTIVE_TAB_MISMATCH`。
- [ ] 检查同一 `/bridge?...nonce=...` 刷新或复制打开时不会第二次渲染 `bridgeToken`；若 capture 还未 claim，也必须返回无 token 状态页或 409，并在报告中记录响应。
- [ ] 用已生成的真实 `bridgeUrl` 模拟跨站顶层导航：带跨站 `Referer` 或 `Sec-Fetch-Site: cross-site` 请求 `/bridge` 必须返回 `403 ORIGIN_NOT_ALLOWED` 且响应体不包含 `bridgeToken`；无来源头、`Sec-Fetch-Site: none` 或 `same-origin` 的正常打开路径仍按一次性 render/claim 规则执行。
- [ ] 检查 bridge 页面对恶意 query、错误 message 和 URL 片段不使用 `innerHTML` 反射；HTML 中 JSON script 不会被 `</script>`、`<script>`、`&` 或 U+2028/U+2029 打断。
- [ ] 检查 `/bridge` 响应头包含 no-store、no-referrer、nosniff、`X-Frame-Options: DENY`、`Cross-Origin-Opener-Policy: same-origin`、`Permissions-Policy`、`frame-ancestors 'none'`；CSP 不包含 `unsafe-inline`，可执行脚本和内联样式只通过本次响应 nonce 放行；尝试 iframe 嵌入 bridge 页面应失败或被浏览器阻止。
- [ ] 检查 bridge config JSON script 自身带 nonce，且所有 script/style nonce 与 CSP header 中的 `script-src 'nonce-...'`、`style-src 'nonce-...'` 一致。
- [ ] 检查 capture status/request/control/profile 响应头包含 no-store/nosniff，profile 还包含 no-referrer；检查 `OPTIONS` preflight 不返回 `Access-Control-Allow-*`，跨站网页不能创建 capture；带跨站 `Origin`、跨站 `Referer` 或 `Sec-Fetch-Site: cross-site` 的敏感 endpoint 请求返回 `403 ORIGIN_NOT_ALLOWED`。
- [ ] 检查 `/health`、`/bridge` 和至少一个 Bearer endpoint 的 Host 校验：正确 `127.0.0.1:{port}` 可用，错误 host、错误端口、`localhost:{port}` 和 `[::1]:{port}` 均按协议拒绝，除非本轮实现显式扩展并同步 manifest/CSP/文档。
- [ ] 检查非法 request target、encoded slash/backslash、重复 query 字段、未知 `/bridge` query 字段、重复 `Authorization`、重复 `Content-Length`、`Content-Length` + `Transfer-Encoding`、非法 `Transfer-Encoding` 和非 identity `Content-Encoding` 均不会进入业务 routing，且 JS/Python 可观测错误语义一致。
- [ ] 测试插件安装在非默认浏览器时，未设置 `STACKPRISM_BROWSER_OPEN_COMMAND` 会返回 `EXTENSION_NOT_CONNECTED`，设置后能成功握手。
- [ ] 测试私有网段目标默认被拒绝，开启 `allowPrivateNetworkTarget` 后才允许。
- [ ] 单元测试中的私网/DNS 判断必须使用 fixture 假 resolver；真实 DNS/hosts 只作为 E2E smoke 证据记录，不作为离线契约测试的通过条件。
- [ ] 测试 DNS 解析失败、解析超时和混合公网/私网答案均 fail closed，初始 URL 和 final URL 的错误语义符合 Target policy。
- [ ] E2E 报告必须明确记录 private-network 防护边界：当前实现可拒绝创建 capture、停止采集和阻止 profile 交付，但不是浏览器级网络防火墙；若测试不能证明导航前零私网触达，不得把该项写成已保证。
- [ ] E2E 报告必须明确记录本机信任边界：loopback host、nonce 和 bridgeToken 不能证明 bridge server 没有被同机恶意进程伪造；本轮只验证跨站网页、错误 Host、错误 token、重复 token render 和 profile 越权读取被拒绝。
- [ ] E2E 报告必须明确记录浏览器扩展信任边界：测试默认应使用只安装 StackPrism 的干净浏览器 profile；如果使用真实日常 profile，必须记录已安装其他扩展会让 DOM 内 `bridgeToken` 面临额外暴露面，且本轮不宣称可抵御恶意扩展。
- [ ] 测试 `targetMode = "active_tab"` 只复用 bridge 页面打开前由 active-tab-tracker 记录的 active tab；缺失时返回 `ACTIVE_TAB_UNAVAILABLE`，不匹配时返回 `ACTIVE_TAB_MISMATCH`，且不会主动切换用户焦点。
- [ ] 测试 bridge tab 或目标 tab 位于 incognito 时返回 `INCOGNITO_NOT_SUPPORTED`；若测试环境无法启用隐身扩展权限，必须在 E2E 报告中记录跳过原因，并保留单元测试覆盖 tab metadata 判断。
- [ ] 启动本地静态 HTTP server 服务 `tests/fixtures/site-experience-fixture.html`，用它做一次 smoke test，确认颜色、字体、布局、组件、脱敏和 interaction limitations 输出稳定。
- [ ] 本地 fixture smoke test 的 capture request 必须显式设置 `"allowPrivateNetworkTarget": true`，且目标端口不能等于当前 bridge server 端口；同时确认当前 bridge origin 仍会被 `BRIDGE_SELF_TARGET_BLOCKED` 拒绝。
- [ ] 用一个真实复杂站点做第二次 smoke test，确认视觉/UI/UX 字段非空。
- [ ] 写入 `docs/reviews/CR-AGENT-BRIDGE-E2E-2026-05-22.md`，记录每条验证命令、退出码、通过/失败摘要、浏览器版本、扩展加载目录、bridge ready JSON 脱敏摘要、跳过原因和剩余风险。
- [ ] E2E 结束后确认 bridge 子进程已退出，端口不再监听；删除 Python 编译产生的 `__pycache__/`，必要时删除临时 fixture server 产物；记录清理命令和结果，避免遗留本地服务或字节码缓存。
- [ ] 检查发布产物 hygiene：`pnpm run build` 后扫描 `dist/`，确认不存在 `agent-skill/`、本地 bridge server 源脚本、`docs/superpowers/`、`tests/`、`__pycache__/` 或 Python 字节码；同时确认 `dist/manifest.json` 不暴露 `externally_connectable`，且 `web_accessible_resources` 没有 agent-only bridge/Skill 路径。
- [ ] 运行 `git diff --check`、`git diff --cached --check`、`git status --short`、`git diff --name-only` 和 `git diff --cached --name-only`，确认无 whitespace/conflict-marker 问题，且收口阶段的已跟踪改动、已 stage 改动与未跟踪文件只包含验证报告或必要缺陷修复。
- [ ] Commit: `test: verify agent bridge capture flow`

## 安全门禁

- bridge server 只能绑定 `127.0.0.1`，不能绑定 `0.0.0.0`。
- token、session、nonce、profile transfer id 和 CSP nonce 使用 `crypto.randomUUID()`、`crypto.getRandomValues()`、`crypto.randomBytes()` 或等效安全随机源；不得使用时间戳、计数器、`Math.random()` 或 `random.random()` 生成安全边界值。
- token 校验必须使用共享 helper 和固定时间比较或等效安全比较；日志和错误响应不得暴露 token 长度、正确前缀、错误位置或相似度。
- 启动环境变量必须先校验再绑定端口或生成 token；非法 `STACKPRISM_BRIDGE_PORT` 或包含 NUL 字符的 browser open 配置必须失败为 `BRIDGE_INVALID_ENV`，不得静默使用默认值继续启动。`STACKPRISM_BROWSER_OPEN_ARGS_JSON` 的非法 JSON/非数组/非字符串元素属于浏览器打开配置错误，按 `BROWSER_OPEN_FAILED` 处理。
- `apiToken` 不得出现在 URL、bridge 页面、浏览器历史、运行时 debug 日志和 profile 中；脚本启动时给 Agent 的机器可读输出除外。
- 扩展与 bridge 的所有日志必须脱敏，不得记录 nonce、完整 bridge URL query、token、Authorization header、profile body 或目标 URL 敏感 query。
- Skill、README 和 E2E 报告不得原样记录包含 `apiToken` 的 ready JSON；只能记录脱敏摘要。
- `bridgeToken` 只允许出现在对应 bridge 页面内嵌数据和插件请求头中，不得进入 profile。
- `bridgeToken` 被首次渲染或 claim 后不得再次通过历史 `/bridge` URL 渲染。
- bridge 页面必须 no-store、no-referrer、nosniff、`X-Frame-Options: DENY`、`Cross-Origin-Opener-Policy: same-origin`、最小 `Permissions-Policy`，并禁止外部资源。
- bridge 页面 CSP 必须使用 per-response nonce，禁止 `unsafe-inline`，并保留 `connect-src 'self'` 和 `frame-ancestors 'none'`；不得允许本机任意端口。
- bridge server 必须拒绝跨站 `Origin`、跨站 `Referer` 或 `Sec-Fetch-Site: cross-site` 的敏感 endpoint 请求，作为 CORS 拒绝之外的防线。
- `/bridge` 渲染 token 前也必须拒绝跨站 `Referer` 或 `Sec-Fetch-Site: cross-site`，防止外部网页顶层导航到泄露的 bridge URL 时触发 token render。
- bridge server 必须拒绝非法 request target、非法 path/query schema、重复认证/长度/content-type/host 头、歧义 body framing 和非 identity content encoding，避免 Node/Python HTTP parser 差异进入业务层。
- 浏览器自动打开命令不得通过 shell 字符串拼接 bridge URL，避免本地命令注入或 URL 参数被 shell 解释。
- bridge server 必须校验 Host 头，避免非预期 host 访问。
- bridge server 必须有基础 rate limit，防止本地误调用刷爆浏览器 tab 或状态查询。
- bridge server 必须限制连接数、请求读取时间、body 大小和 keep-alive 时间；不得被本地慢请求长期占住。
- bridge server 必须能在 SIGINT/SIGTERM/stdin EOF 后关闭监听、timer 和 active capture 状态；Skill 必须负责停止子进程。
- MV3 background 不得只依赖内存 timer 做 capture 超时、取消超时或 profile transfer 超时；必须持久化绝对 deadline 并在 service worker 模块初始化和所有相关事件入口做 reconciliation。第一版不新增 `chrome.alarms` 权限；若新增必须同步更新 manifest、测试和隐私文档。
- 本机 loopback trust boundary 必须写入开发文档、隐私文档和 E2E 报告：第一版不防同机恶意进程伪造兼容 bridge server，不得把 `bridgeToken`、meta 标记或随机端口宣传成本机进程身份认证。
- 同浏览器扩展 trust boundary 必须写入开发文档、隐私文档、用户文档和 E2E 报告：第一版不防已安装恶意扩展读取 bridge 页面 DOM、观察 bridge URL 或干扰同一 profile；不得把 DOM 内嵌 `bridgeToken` 宣传成对其他扩展保密。
- bridge server 必须通过 DNS 解析阻止 hostname 指向私网地址，除非 `allowPrivateNetworkTarget = true`。
- private-network 防护不能被描述为浏览器级网络防火墙；第一版只能保证不创建或不继续不合规 capture、不给 Agent 交付不合规 profile，不能承诺浏览器导航前零私网触达。
- DNS/private-network 离线契约测试必须使用可注入 resolver 和固定 fixture；不得依赖本机 hosts、VPN、DNS 缓存或真实外网解析结果。
- DNS 解析失败、解析超时、空结果和任一私网答案必须 fail closed；不得因为 resolver 异常而放行目标。
- bridge server 必须对初始 URL 和最终 URL 都执行私网/DNS 校验；最终 URL 不合规时不得交付 profile。
- bridge server 必须拒绝目标 URL 或 final URL 指向当前 bridge server origin，即使 `allowPrivateNetworkTarget = true`。
- 插件必须在 `target_loaded` final URL 被 bridge 接受后才注入主动检测和 experience profiler。
- tab 复用必须保留 query 参与匹配；不得把同 origin/path 但 query 不同的页面当作同一目标复用或声明为 active tab 匹配成功。
- agent-only `experience-profiler.iife.js` 默认不得列入 `web_accessible_resources`；若后续必须暴露，必须有独立文档理由、最小 match 和测试覆盖。
- profile 回写 endpoint 必须校验 Bearer token。
- 插件 status/profile 回写与 control 轮询必须校验 Bearer `bridgeToken`。
- `bridgeToken` 只能读取同一 capture 的状态/control/request，不能创建 capture、不能读取 profile、不能跨 capture 访问。
- `/v1/captures` 创建任务也必须校验 Bearer token，避免任意本地网页创建采集任务。
- capture nonce 一次性使用。
- 第一版只接受 `http://127.0.0.1` bridge 页面；若加入 `localhost`，必须同步更新 bridge Host 校验、CSP、manifest match 和测试。
- background 必须校验 `sender.tab.id`、`sender.tab.windowId`、`sender.url` 与 bridge session/capture/nonce 一致。
- `chrome.storage.session` 必须保持 trusted-only；不得把 agent capture state、active-tab tracker 或普通 tab cache 暴露给 untrusted content scripts。
- `chrome.storage.session` 只用于 service worker 重启恢复，不得被描述或测试成浏览器完全重启、扩展 reload/update 或用户禁用扩展后的持久恢复机制；这些场景必须 fail closed 并清理自己创建的 target tab。
- background 到 bridge 的 profile 回传必须走 bridge content script 同源 POST；若新增 CORS fallback，只能显式允许当前扩展 origin，禁止 wildcard。
- background 到 bridge content script 的 profile 回传必须分片传输并逐片 ack；不得把完整 profile 作为单条扩展消息发送。
- bridge content script 必须校验 profile transfer 的 `profileTransferId`、`captureId`、`sessionId`、`nonce`、chunk 连续性、累计 byteLength、base64/UTF-8/JSON decode 和 sha256，缺片、hash mismatch 或身份字段不一致必须结构化失败。
- 第一版不支持 incognito capture；bridge tab 或目标 tab 的 `incognito` 为 true 时必须失败为 `INCOGNITO_NOT_SUPPORTED`。
- 插件新建目标 tab 必须 `active: false`，不得抢焦点；只允许关闭 `createdByCapture` 的 tab。
- `targetMode = "active_tab"` 必须依赖 active-tab-tracker 记录的 bridge 打开前 active tab，不得读取 bridge 页当前 active tab 充当目标。
- 插件不暴露 externally_connectable。
- 不读取和回传 localStorage/sessionStorage 明文。
- 资源 URL、文本摘要和 evidence 中的 query 参数、hash、token-like 片段必须脱敏。
- UX 文本摘要必须脱敏，不输出完整可见文本。
- 第一版不得主动点击、提交或触发业务状态变化。
- 响应头输出沿用现有 set-cookie 脱敏逻辑，并新增 Authorization/Cookie 防线。
- profile 必须包含 limitations，避免 Agent 把低置信或不可见信息当作事实。

## 验收标准

- Agent 可通过 Skill 内 JS 脚本启动本地 bridge，并通过 HTTP API 创建 capture。
- bridge 脚本 stdout 首行是一条可解析 JSON line，包含 `baseUrl`、`apiToken`、`protocolVersion` 和 `healthUrl`。
- Agent 示例对 ready JSON 有 10 秒超时、parse failure、protocol mismatch 和子进程清理逻辑；端口占用时返回 `PORT_IN_USE` 且不泄露 token。
- Skill 和 E2E 报告中的 ready JSON 示例已脱敏，不包含原始 `apiToken`。
- 用户不需要手动点击插件、复制或下载。
- 插件能自动采集目标 URL 的现有技术栈信息。
- 插件能新增采集视觉、布局、组件、交互、UX 和资产摘要。
- Agent 能读取 `stackprism.site_experience_profile.v1`。
- profile 对“实现同样视觉效果、UI/UX 体验”有直接指导字段。
- `experience-profiler` 同时登记在 `build-scripts/build-injected.mjs` 和 `vite.injected.config.ts`，构建产物存在，且默认不作为 web-accessible resource 暴露给网页。
- 所有失败路径返回结构化错误。
- Agent 可观察到插件阶段状态、取消结果、bridge tab 关闭和目标 tab 关闭错误，而不是只等待超时。
- service worker 重启可以 fail closed 并清理目标 tab；浏览器/扩展完整重启或 storage session 丢失不会被宣称可恢复。
- MV3 service worker 中途挂起或恢复后，capture deadline reconciliation 可复现，不依赖已丢失的内存 timer。
- running capture 全局超时、cancel 超时、DNS lookup failure、目标导航走偏和注入失败都有明确结构化错误或终态。
- target main-frame load failure 返回 `TARGET_LOAD_FAILED`，不会把浏览器错误页当目标页面采集。
- `include` 子集请求不会运行未请求采集，未请求 section 以空对象和 `section_not_requested` limitation 表达。
- `captureScreenshotMetadata` 的 true/false 行为可验证：第一版只允许截图元数据，不输出截图图像或像素数据。
- 单元测试、lint、build、docs build 通过。
- 浏览器端 smoke test 证明插件、bridge、Agent API 三段联通。
- bridge 页面不会污染普通检测缓存或 badge。
- 默认浏览器未安装插件时能明确失败；指定正确浏览器后能成功。
- 多视口能力边界清晰：第一版不宣称真实移动设备/CDP 仿真。
- bridge URL、浏览器历史和 profile 不包含 API token。
- `/bridge` 在 session/capture/nonce 无效时不会渲染 bridgeToken；同一 session/capture/nonce 的重复打开不会第二次渲染 bridgeToken；bridgeToken 只出现在 JSON config DOM 中。
- `/bridge` 跨站导航不会触发 bridgeToken 渲染；非法 path/query 和歧义 HTTP header 不会进入业务 routing。
- 文档和 E2E 报告明确说明 loopback bridge 不防同机恶意进程伪造，`bridgeToken` 只约束同一 capture 的 API scope，不是本机进程身份凭证。
- bridge 页面 CSP 不含 `unsafe-inline`，所有可执行 inline script 和 inline style 均由每次响应 nonce 放行。
- bridge config JSON script 也带 CSP nonce；非法启动环境不会输出 ready JSON 或 token。
- `PRIVACY.md`、`README.md` 和用户文档同步说明 Agent Bridge 的隐私边界。
- Agent Bridge 有用户可见 `agentBridgeEnabled` 设置；发布包默认关闭，未启用时返回 `AGENT_BRIDGE_DISABLED`，不会打开目标 tab 或采集 profile。
- `agentBridgeEnabled` 是当前浏览器 profile 的 local-only opt-in，不随 `chrome.storage.sync` 跨设备同步；旧 sync 字段或缺字段都不能自动开启 Agent Bridge。
- `docs/.vitepress/config.ts` 已把 Agent Bridge 文档加入开发手册导航。
- `agent-skill/**/scripts/**` 不被 `.gitignore` 或 `.prettierignore` 吞掉。
- 固定 fixture smoke test 稳定返回视觉、布局、组件和脱敏字段。
- 大 profile smoke test 证明 profile chunk transport 成功，并且缺片、ack 超时、hash mismatch 都返回结构化错误。
- profile transfer 身份字段和编码校验已覆盖：错误 `sessionId`/`nonce`、非法 base64、非法 UTF-8 或非 profile JSON 都不能被 POST 为完成结果。
- passive capture 边界清晰：未主动打开的弹窗、下拉和交互流程不会被宣称已完整采集。
- JS/Python bridge 的 URL policy 离线测试通过同一 fixture 和假 resolver，避免 DNS/private-network 契约随本机网络环境漂移。
- DNS fail-closed 语义覆盖解析失败、解析超时、空结果和混合公网/私网答案。
- 发布 zip/crx 的 `dist/` 产物不包含 repo-local `agent-skill/`、本地 bridge server 源脚本、测试 fixture、`docs/superpowers/`、Python 字节码或仅供 Agent 使用的 helper；CI 在打包前有自动扫描门禁。

## 执行顺序

关键路径：协议类型 -> profile builder -> 体验采集 -> bridge handshake -> background 编排 -> JS bridge -> Python fallback -> Skill 文档 -> E2E 验证。

Task 7 是本计划验收范围的一部分。只有在用户显式缩小第一版范围时，才能把 Python fallback 拆成后续原子任务；拆分时必须同步更新验收标准、Skill 文档和正式任务跟踪文件，明确 JS bridge 为第一版唯一可交付脚本，且保留 JS/Python 协议兼容要求作为后续任务门禁。
