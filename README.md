<div align="center">

<img src="public/icons/icon256.png" alt="StackPrism / 栈棱镜" width="160" height="160" />

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/cagpdifljieeiajlhlcboelglkalofak?label=Chrome%20Web%20Store&color=FBBC04)](https://chromewebstore.google.com/detail/stackprism/cagpdifljieeiajlhlcboelglkalofak)
[![Edge Add-ons](https://img.shields.io/badge/dynamic/json?label=Edge%20Add-ons&query=%24.version&url=https%3A%2F%2Fmicrosoftedge.microsoft.com%2Faddons%2Fgetproductdetailsbycrxid%2Fojgmhlogaoiegdonnlnibeoikbleccno&prefix=v&color=00A4EF)](https://microsoftedge.microsoft.com/addons/detail/stackprism/ojgmhlogaoiegdonnlnibeoikbleccno)
[![Firefox Add-ons](https://img.shields.io/amo/v/stackprism?label=Firefox%20Add-ons&color=FF7139)](https://addons.mozilla.org/firefox/addon/stackprism/)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-blue)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4CAF50)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Firefox-26A69A)](#安装)
[![PRs welcome!](https://img.shields.io/badge/PRs-Welcome-FF6F61)](https://github.com/setube/stackprism/issues)

# StackPrism / 栈棱镜

> 浏览器里的网页技术栈识别与体验采集工具。

[简介](#简介) • [安装](#安装) • [Agent Bridge](#agent-bridge) • [规则维护](#规则维护) • [参与共建](#参与共建) • [开源协议](#开源协议)

</div>

## 简介

StackPrism 是一款基于 **Manifest V3** 的网页技术栈识别扩展，支持 **Chrome / Edge / Firefox**。它从页面运行时、DOM、资源 URL、响应头、动态资源和 JS 版权注释中收集证据，把前端、后端、CDN、SaaS、统计、支付、登录、CMS 等线索按类目展示。

检测链路分成 4 个互补通道：

- **静态扫描**：DOM、全局变量、CSS 类名、CSS 变量、`<meta>`
- **响应头观察**：主文档、XHR、iframe 的响应头与 HTTP 版本
- **动态资源监听**：交互后新增脚本、样式、iframe、feed
- **源码版权注释扫描**：主 bundle 开头注释中的第三方依赖

结果会合并去重并按 50+ 个类目分组，同时对伪造响应头、自指检测、宽泛关键词误报做主动收敛。

### 识别覆盖

| 维度   | 类目示例                                        |
| ------ | ----------------------------------------------- |
| 前端   | 前端框架 / UI 框架 / 前端库 / 构建与运行时      |
| 服务端 | Web 服务器 / 后端框架 / CDN 与托管 / 开发语言   |
| 内容   | 网站程序 / 主题模板 / CMS / 电商平台 / RSS      |
| 第三方 | SaaS / 探针监控 / AI 大模型 / 第三方登录 / 支付 |
| 营销   | 广告 / 营销 / 统计 / 分析 / 标签管理            |
| 安全   | HTTPS / HTTP/2 / HTTP/3 / CSP / Cookie 同意     |

## 安装

从源码加载：

```bash
git clone https://github.com/setube/stackprism.git
cd stackprism
pnpm install
pnpm run build            # Chrome / Edge
pnpm run build:firefox    # Firefox
```

**Chrome / Edge:**

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 开启「开发者模式」
3. 选择「加载已解压的扩展程序」，加载构建出的 `dist/`
4. 刷新目标网页并打开扩展 popup 查看结果

**Firefox:**

1. 打开 `about:debugging#/runtime/this-firefox`
2. 选择「临时载入附加组件」，加载 `dist-firefox/manifest.json`
3. 或运行 `pnpm run build:firefox`，在 `release/` 目录获取 `.xpi`

## 开发

```bash
pnpm run dev
pnpm run test:unit
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run build:firefox
pnpm run docs:dev
```

`pnpm run typecheck` 会执行 `vue-tsc --noEmit` 并触发生产构建。

## Agent Bridge

Agent Bridge 是默认关闭的本机能力。用户在扩展设置中显式启用后，本机 AI Agent 可以通过 `127.0.0.1` bridge 获取 `stackprism.site_experience_profile.v1`，用于参考目标站点的技术、视觉、布局、组件、交互、UX 和资源摘要。

- 只读采集：不会点击页面、提交表单或登录账号。
- 本机边界：启用状态保存在当前浏览器 profile 的 `chrome.storage.local`，不随 Chrome sync 同步。
- 隐私约束：不采集 Cookie、Authorization、localStorage/sessionStorage 明文或完整敏感文本。
- Profile 下载：下载的是纯 JSON；截图不内嵌 base64，而是提供按需下载链接。要核对实际视觉效果，请打开或下载 `visualProfile.screenshot.downloadUrl`。

常用采集命令：

```bash
TARGET_URL="https://public-or-desensitized.example"
node agent-skill/stackprism-site-experience/scripts/capture-site.mjs \
  --url "$TARGET_URL" \
  --out /tmp/stackprism-profile.json \
  --include tech,visual,layout,components,interaction,ux,assets
```

本机开发目标、`localhost`、`127.0.0.1`、私网地址和真实内网目标需要同时在扩展设置中开启高风险网络目标选项，并在 helper 请求中使用 `--allow-private-network`。不要复用被 `PRIVATE_NETWORK_TARGET_BLOCKED` 拒绝的旧 bridge URL。

更完整的协议、生命周期和安全说明见 [docs/dev/agent-bridge.md](docs/dev/agent-bridge.md) 与 [agent-skill/stackprism-site-experience/SKILL.md](agent-skill/stackprism-site-experience/SKILL.md)。

## 规则维护

StackPrism 的规则系统是数据驱动的。绝大多数检测只需要修改规则 JSON，不需要改运行时代码。

- [public/rules/index.json](public/rules/index.json)：规则加载清单
- `public/rules/page/*.json`：页面源码、DOM、资源 URL、动态资源
- `public/rules/headers/*.json`：响应头与 Cookie 线索
- [public/rules/self-host-suppress.json](public/rules/self-host-suppress.json)：自指抑制
- [public/tech-links.json](public/tech-links.json)：技术名到官网/仓库 URL 映射

新规则的字段:

```jsonc
{
  "name": "技术名称",
  "category": "前端框架", // 50+ 类目之一
  "patterns": ["正则或关键词"],
  "matchType": "regex", // 或 "keyword"
  "matchIn": ["html", "resources", "url", "headers", "dynamic"],
  "confidence": "高", // 高 / 中 / 低
  "kind": "类型说明",
  "selectors": ["CSS 选择器"],
  "globals": ["window 全局变量名"],
  "classPrefixes": ["类名前缀"]
}
```

### 规则质量

- 优先使用响应头、专属资源 URL、`<meta name="generator">`、`window.<global>`、独家 CSS 选择器、JS 版权注释、官方 SDK 包名。
- 避免短 keyword 和宽泛 regex，例如 `spring`、`phoenix`、`column`、`container`。
- 优先限定 `matchIn`，尽量用 `resources`、`url`、`headers`，少用裸 `html`。

## 注意事项

- **后端识别不保证完整**:很多站点隐藏 `Server` / `X-Powered-By` 等响应头,后端结果会以"线索 + 置信度"形式展示
- **伪造响应头**:扩展会主动识别 ≥4 种主体身份字段同时存在的伪造场景,将相关类目降级为低置信度并附警示。但单个伪造头无法识别,建议结合其他线索判断
- **首次安装请刷新目标页**:让 service worker 捕获主文档响应头
- **源代码搜索是 DOM 快照**:基于当前页面的 `outerHTML`,不等同于服务器最初返回的原始 HTML
- **Chrome 系统页 / 商店页 / 内置页**通常不允许注入检测脚本
- **动态监控异步累积**:content script 在后台累计交互后新加载的资源,重新打开 popup 可看到合并结果

## 参与共建

StackPrism 目前内置 50+ 类目下 2000+ 条识别规则。新框架、新 SaaS、漏识别和误报都欢迎反馈：

- **Bug / 误识 / 漏识反馈**:[Issues](https://github.com/setube/stackprism/issues) — popup 上直接点「识别不准确」按钮会自动填好议题模板
- **规则贡献**:扩展设置页点「提交规则贡献」,或直接 PR 到 [`public/rules/`](public/rules/)
- **讨论与提案**:[Discussions](https://github.com/setube/stackprism/discussions)

提交代码前请至少运行 `pnpm run test:unit && pnpm run lint && pnpm run typecheck`。

## 开源协议

本项目基于 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 协议授权 —— **允许非商业自由使用与二次修改,必须署名且衍生作品采用同一协议**。完整法律文本见 [LICENSE](LICENSE)。
