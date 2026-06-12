# Agent Bridge

Agent Bridge 让本机 AI Agent 在用户已安装并显式启用 StackPrism 扩展后，通过 `127.0.0.1` 本地 HTTP bridge 获取 `stackprism.site_experience_profile.v1`。

## 数据流

1. Agent 启动 `agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs`，读取 stdout 中唯一 ready JSON。
2. Agent 用 `apiToken` 调用 `POST /v1/captures` 创建采集任务。
3. bridge 打开 `/bridge?session=...&capture=...&nonce=...`。
4. `src/content/agent-bridge-client.ts` 只在 `http://127.0.0.1/*` 的 bridge 页面运行，读取 DOM config，向 background 发送 `AGENT_BRIDGE_HELLO`。
5. background 校验 `chrome.storage.local` 中的 `agentBridgeEnabled` 后，打开或复用目标 tab，运行技术识别和 experience profiler。
6. background 将 profile 分片发送回 bridge content script，content script 再同源 POST 给本地 bridge。
7. Agent 轮询 status，并在 completed 后用 `apiToken` 读取 profile。

## 用户门禁

`agentBridgeEnabled` 是本机浏览器 profile 级 opt-in，只从 `chrome.storage.local` 生效。即使旧 `chrome.storage.sync` 中存在同名字段，也不得自动开启 Agent Bridge。

`agentBridgeAllowAllNetworkTargets` 是同样只存在当前浏览器 profile 的高风险开关，默认关闭。用户在设置页保存开启时必须人工确认；开启后，扩展侧会允许 Agent Bridge 继续采集本机、私网、保留地址以及 DNS/proxy 映射到私网的目标。该开关不放开 `http:` / `https:` 之外的协议、不允许采集当前 bridge server 自身，也不改变本地 bridge 进程的创建阶段策略；repo-local helper 仍需显式传入 `--allow-private-network` 或 request option 才会在创建阶段接受私网目标。

发布到 Chrome Web Store 或 Edge Add-ons 前，默认值必须保持 `false`，除非维护者完成隐私披露、用户文档和发布说明更新。

发布前 disclosure 必须覆盖：

- Agent Bridge 默认关闭，只能由用户在扩展设置中显式启用。
- 启用后，扩展会把浏览器侧可观测的技术栈与体验摘要发送到用户本机 `127.0.0.1` bridge，供本机 Agent 读取。
- StackPrism 不接收远程上传，不采集 Cookie、Authorization、localStorage/sessionStorage 明文或完整私密页面文本。
- 第一版信任用户启动的本机 bridge 进程，不声称抵御同机恶意进程或同一浏览器 profile 中其他恶意扩展。

## 信任边界

- 本版本信任用户或 Agent 启动的本机 bridge 进程。
- `127.0.0.1`、nonce、bridge 页面 meta 和 `bridgeToken` 只能绑定一次 capture，不能证明本机进程一定没有被同机恶意进程伪造。
- DOM 中的 `bridgeToken` 不是对同浏览器 profile 中其他扩展保密的秘密。
- 默认不采集 cookie、Authorization、localStorage/sessionStorage 明文、完整敏感 query 或页面全文。
- Agent Bridge 不是浏览器级 SSRF 防火墙。private-network 校验用于拒绝创建 capture、停止采集和阻止 profile 交付，不保证导航前零网络触达。
- “允许所有网络目标”只应在用户确认本机 Agent、bridge 进程和当前浏览器 profile 可信时短时开启；开启后 private-network fail-closed 保护不再作为扩展侧二次门禁生效。

## 本地脚本

以下 `agent-skill/...` 路径均以 StackPrism 仓库根目录为当前工作目录。Agent 若从其他目录启动，必须先切到 `<repo-root>`，或把脚本路径解析为绝对路径后再调用。bridge 脚本是 repo-local 工具，不是扩展发布产物，也不是全局命令。

JavaScript bridge：

```bash
cd <repo-root>
node agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs
```

Python fallback：

```bash
cd <repo-root>
python3 agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py
```

Python fallback 基于标准库 HTTP server，定位是 Node 不可用时的兼容路径。长时间批量采集、重复压力测试或需要更可靠连接上限控制时优先使用 JavaScript bridge；如果 Python fallback 在本机连接堆积下超时，应停止子进程、重新启动 bridge 并重试，不复用半完成 capture。

JavaScript bridge 与 Python fallback 的 bridge 页面 CSS 和客户端脚本必须保持字节级一致。修改 `agent-skill/stackprism-site-experience/scripts/bridge/bridge-page-assets.mjs` 时，必须同步更新 `agent-skill/stackprism-site-experience/scripts/stackprism_bridge_lib/bridge_page_assets.py`，并保留 `tests/stackprism_bridge_py.test.mjs` 中的资产一致性测试通过。

测试环境可设置 `STACKPRISM_BRIDGE_NO_OPEN=1`，此时不会自动打开浏览器，但仍会返回 `bridgeUrl`。

Agent 只读取 stdout 的第一条 ready JSON line，并应在 10 秒内完成解析。超时按 `BRIDGE_START_TIMEOUT`，非 JSON stdout 按 `BRIDGE_READY_PARSE_FAILED`，`protocolVersion` 不匹配按 `BRIDGE_PROTOCOL_UNSUPPORTED` 处理；这些失败都必须停止 bridge 子进程并等待退出。

大型页面 profile 通过分片传回 bridge 页面。若采集中出现 `BRIDGE_TRANSPORT_DISCONNECTED`、`PROFILE_TRANSPORT_FAILED`、`PROFILE_CHUNK_MISSING` 或 `CAPTURE_TIMEOUT`，Agent 应将本次 capture 视为失败，停止当前 bridge 子进程后重启，并用 helper 的 `--include` 传入更小的范围或用 `--max-resource-urls` 降低资源 URL 上限后重试一次；不得从部分分片拼出“降级成功”的 profile。

如果扩展安装在非默认浏览器或非默认用户 profile，设置 `STACKPRISM_BROWSER_OPEN_COMMAND` 指向平台 opener 或对应 Chrome 内核浏览器可执行文件，并把 opener/profile 参数放入 `STACKPRISM_BROWSER_OPEN_ARGS_JSON` 字符串数组。bridge URL 始终由脚本作为最后一个独立 argv 追加，不要写入环境变量或 shell 命令。

`STACKPRISM_BROWSER_OPEN_COMMAND` 只放可执行文件或平台 opener，不能把命令参数拼进同一个字符串。示例：使用 `STACKPRISM_BROWSER_OPEN_COMMAND=open` 和 `STACKPRISM_BROWSER_OPEN_ARGS_JSON='["-a","Google Chrome"]'`，不要写成 `STACKPRISM_BROWSER_OPEN_COMMAND='open -a Google Chrome'`。profile 参数同样放在 args JSON 中，bridge URL 不需要也不允许由调用方追加。

跨平台 browser open 口径：

- macOS 默认使用 `open`；若系统默认浏览器不是安装 StackPrism 的 Chrome，可设置 `STACKPRISM_BROWSER_OPEN_COMMAND=open` 和 `STACKPRISM_BROWSER_OPEN_ARGS_JSON='["-a","Google Chrome"]'`。若还需要指定 Chrome profile，应把 command 改成 Chrome 可执行文件路径，并把 `--profile-directory=...` 放进 args JSON。
- Windows 默认使用 command `rundll32.exe`，并由脚本内置 `url.dll,FileProtocolHandler` 参数；若需要指定 Chrome 或 Edge，使用完整 `.exe` 路径作为 `STACKPRISM_BROWSER_OPEN_COMMAND`，profile 参数放进 args JSON。
- Linux 默认使用 `xdg-open`；若需要指定 Chrome/Chromium，使用 `google-chrome`、`chromium` 或绝对路径作为 `STACKPRISM_BROWSER_OPEN_COMMAND`，profile 参数放进 args JSON。

## 发布产物 Hygiene

`dist/` 只应包含扩展运行所需文件。发布前必须确认：

- `dist/manifest.json` 不包含 `externally_connectable`。
- `dist/` 不包含 `agent-skill/`、`docs/superpowers/`、`tests/`、Python 源文件、Python 字节码或本地 bridge server 源脚本。
- `experience-profiler.iife.js` 默认不放入 `web_accessible_resources`。

## Profile Schema 口径

Agent Bridge 输出 schema 为 `stackprism.site_experience_profile.v1`。当前 profile 至少按以下口径消费：

- `target`: 规范化目标、最终 URL、标题、`language`、viewport 摘要和 capture scope。`language` 来自页面 `documentElement.lang` 或 body `lang`，为空时保持空字符串，不推断用户身份或地区。
- `browserContext`: user agent、扩展版本、采集时间、bridge protocol version、请求的 viewport 和扩展 capabilities。
- `techProfile`: 现有 StackPrism 技术识别结果和实现参考说明。
- `visualProfile`: 颜色、字体、间距、形状、阴影、密度、主题和响应式视觉摘要。`options.captureScreenshot = true` 且 `include` 包含 `visual` 时，扩展会用截图 data URL 把当前可见视口交给本机 bridge；bridge 保存 profile 时必须剥离 `dataUrl`，只保留临时内存截图资产和 `screenshot.downloadUrl`、`note`、生命周期字段。`capture-site.mjs` 会在 bridge 仍存活时下载截图，并把 `downloadUrl` 重写为本地 `file://` URL 与 `localPath`。
- `layoutProfile`: landmarks、hero、grid、sticky、above-fold 和截图 metadata。`captureScreenshotMetadata = false` 时不得输出 bounding box、above-fold 细节或几何截图 metadata。
- `componentProfile`: button、link、form、card、navigation、overlay 和 data display 模式。
- `interactionProfile`: 仅记录 passive 可观察的 hover/focus/transition/animation/loading/scroll 线索，不点击、不提交表单、不主动打开隐藏菜单。
- `uxProfile`: 一阶 UX 字段包含 `pagePurpose`、`primaryUserPath`、`informationHierarchy`、`ctaStrategy`、`trustSignals`、`navigationDepth`、`contentGrouping`、`frictionPoints` 和有限 `textSamples`。这些字段只来自 DOM 结构和短标签摘要，必须先脱敏 token-like 值、email、手机号、长数字和敏感 query。
- `assetProfile`: script、style、resource domain、image/font hint、manifest、favicon 和资源 URL 脱敏摘要。
- `evidence`、`limitations`: 记录来源覆盖、截断、未请求 section、不可访问 frame 或 shadow root 等边界。
- `agentGuidance`: 给下游 Agent 的实现建议。当前包含摘要、优先级、注意事项和 `recreationPlan`。`recreationPlan` 把 profile 转成复刻执行层：`implementationOrder`、`designTokens`、`layoutBlueprint`、`componentInventory`、`interactionChecklist`、`uxChecklist`、`assetHints` 和 `verificationChecklist`。这些字段只引用已脱敏的 profile 内容，不能把缺失字段理解为目标站点不存在对应结构。

下游 Agent 不得把 profile 当作页面完整拷贝。它是浏览器可观察事实和实现参考，不是后端私有实现或用户账号内容。截图像素只在 `captureScreenshot = true` 时显式采集，属于未做逐像素脱敏的可选视觉证据，不应用于登录态或私密页面。下载的 Profile JSON 是纯 JSON，不包含注释或截图 base64；如需查看实际视觉效果，Agent 应按 `visualProfile.screenshot.downloadUrl` 下载或打开图片。直接 bridge URL 只在本机 bridge 进程存活且 completed result TTL 未过期时有效；TTL 过期时 bridge 必须同时清理 profile 和临时内存截图资产。helper 写出的本地 `file://` 图片在文件被移动或删除前有效。用户在 bridge 页面手动下载的截图文件由浏览器下载目录管理，插件不会自动删除该文件。

完成采集后，本地 bridge 页面会展示受限结果工作台：目标网址、截图预览、截图放大预览、下载截图、复制截图、复制 Markdown 摘要和分组 profile 内容卡片。该页面只能用 `bridgeToken` 读取 `GET /v1/captures/{id}` 的 status preview；preview 中的 `copyText` 和 `contentSummary` 由 bridge server 从已完成 profile 生成，并会脱敏 URL query、token-like id、email、手机号和 token 字段。页面不得使用 `bridgeToken` 读取 raw `/profile`，不得把 raw profile、截图 data URL、`apiToken`、`bridgeToken`、nonce 或完整敏感文本放进“一键复制全部信息”。复制截图依赖浏览器 Clipboard API，失败时必须显示错误，不得伪装成功。复制到剪切板或用户下载后的截图由浏览器/操作系统管理，不属于 StackPrism 自动清理范围。

## Browser Smoke 场景

默认 smoke 命令：

```bash
STACKPRISM_BROWSER_SMOKE_CDP_PORT=9661 node tests/agent-bridge-browser-smoke.mjs
```

当前默认成功路径使用本地 `tests/fixtures/site-experience-fixture.html`，并在 capture request 中显式设置 `allowPrivateNetworkTarget = true`。默认路径不再依赖 `https://example.com`，因为外部公网目标会受到当前网络、代理、DNS 和站点可用性影响。公网域名经本机代理或 TUN fake-IP 解析/连接到 `198.18.0.0/15` 时，默认策略允许采集；直接私网 IP、`localhost`、RFC1918、link-local、真实内网和其他 special-use 地址仍 fail closed，除非显式设置 `allowPrivateNetworkTarget = true`。

smoke 结果按三类理解：

- 默认 fixture 成功路径：证明扩展加载、opt-in、bridge handshake、target capture、profile transfer、profile endpoint、隐私脱敏和 cleanup 主链路。
- 显式 public complex target：例如 `STACKPRISM_BROWSER_SMOKE_SCENARIO=public-complex-target STACKPRISM_BROWSER_SMOKE_TARGET_URL=https://www.wikipedia.org/ ...`。如果 resolver 或 Chrome network evidence 返回 `198.18.*`，默认策略会按本机代理/TUN fake-IP 场景允许该公网 hostname；这不等价于允许直接私网或真实内网目标。
- private-network policy 场景：`private-target-blocked`、DNS/private final URL、bridge self-target 等场景证明 fail-closed 策略，不是浏览器级 SSRF 防火墙，也不保证导航前零网络触达。

## Live Gate 边界

以下 gate 不能仅凭本机单测或 fixture smoke 标记完成：

- Chrome Web Store / Edge Add-ons 真实发布、升级链路和审核后台 disclosure 接受状态。
- 运行中 capture 的 Chrome service worker 自然 idle eviction 精确触发。本机已有 fail-closed cleanup 证据，但当前 Chrome 行为未稳定触发该 live 分支。
- incognito bridge 或 target tab 的精确 `INCOGNITO_NOT_SUPPORTED` live metadata 分支。当前单元测试覆盖该分支，CDP/`--incognito` probes 在本机表现为 `EXTENSION_NOT_CONNECTED` fail-closed skip。
- 多网络、多 DNS、多目标站点的长时资源压力矩阵。

发布 workflow 会在打包前检查 Agent Bridge 是否出现在 `dist/manifest.json` 的 loopback content script 或 loopback web accessible resource 中。若出现，则必须通过 workflow_dispatch 输入 `agent_bridge_disclosure_confirmed=true`，或在 GitHub Release 正文中包含已勾选的 `- [x] Agent Bridge disclosure confirmed`；否则工作流失败。该门禁只能防止未确认披露就上传 release 资产，不能替代 Chrome Web Store / Edge Add-ons 后台的真实审核和发布状态。

## 验证命令

```bash
pnpm run build:injected
pnpm run test:unit
pnpm run lint
pnpm run typecheck
pnpm run docs:build
pnpm run check:links
node build-scripts/package-firefox.mjs
node --check agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs
python3 -m py_compile agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py agent-skill/stackprism-site-experience/scripts/stackprism_bridge_lib/*.py
git diff --check
```

`pnpm run typecheck` 已包含 `vue-tsc --noEmit` 和 `pnpm run build`，因此会同时刷新 Chrome `dist/` 构建产物。`node build-scripts/package-firefox.mjs` 依赖已有 `dist/`，用于验证 Firefox manifest 转换、background rebundle、content script bundling、agent-only 产物卫生检查和 XPI 产物边界。验证后应清理或忽略 `dist/`、`dist-firefox/`、`release/`、`public/injected/`、`docs/.vitepress/dist/`、`docs/public/icon.svg` 与 Python `__pycache__`，不要把这些本地产物纳入提交。
