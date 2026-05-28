<div align="center">

<img src="public/icons/icon256.png" alt="StackPrism / 栈棱镜" width="160" height="160" />

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/cagpdifljieeiajlhlcboelglkalofak?label=Chrome%20Web%20Store&color=FBBC04)](https://chromewebstore.google.com/detail/stackprism/cagpdifljieeiajlhlcboelglkalofak)
[![Edge Add-ons](https://img.shields.io/badge/dynamic/json?label=Edge%20Add-ons&query=%24.version&url=https%3A%2F%2Fmicrosoftedge.microsoft.com%2Faddons%2Fgetproductdetailsbycrxid%2Fojgmhlogaoiegdonnlnibeoikbleccno&prefix=v&color=00A4EF)](https://microsoftedge.microsoft.com/addons/detail/stackprism/ojgmhlogaoiegdonnlnibeoikbleccno)
[![Firefox Add-ons](https://img.shields.io/amo/v/stackprism?label=Firefox%20Add-ons&color=FF7139)](https://addons.mozilla.org/firefox/addon/stackprism/)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-blue)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4CAF50)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Firefox-26A69A)](#安装)
[![PRs welcome!](https://img.shields.io/badge/PRs-Welcome-FF6F61)](https://github.com/setube/stackprism/issues)

# StackPrism / 栈棱镜 —— 网页技术栈识别浏览器扩展

> 从页面运行时、DOM、资源 URL、响应头、动态加载和源码版权注释 6 个维度收集线索,把站点用的前后端栈分门别类列清楚。

[简介](#简介) • [功能特性](#功能特性) • [规则维护](#规则维护) • [注意事项](#注意事项) • [参与共建](#参与共建) • [赞助者](SPONSORS.md) • [星标趋势](#星标趋势) • [开源协议](#开源协议)

</div>

## 简介

StackPrism(以下简称 **栈棱镜**)是一款基于 **Manifest V3** 的网页技术栈识别扩展,支持 **Chrome / Edge / Firefox**。

不同于市面上多数只看 HTML 资源 URL 的同类工具,栈棱镜把检测拆成 4 个独立通道并行收集线索:

- **静态扫描**:页面加载时由注入脚本扫 DOM、全局变量、CSS 类名、CSS 变量、`<meta>`
- **响应头观察**:Service Worker 监听 `webRequest.onHeadersReceived`,捕获主文档/XHR/iframe 的响应头与 HTTP 版本
- **动态资源监听**:content script 用 `PerformanceObserver` + `MutationObserver` 累积页面交互后新加载的脚本/样式/iframe/feed
- **JS 版权注释扫描**:后台异步抓主 bundle 的开头版权注释,识别打包进 `index/main/vendor` chunk 的第三方依赖

4 路结果合并去重后,按 50+ 个类目分组展示,并对**伪造响应头、自指检测、模糊误报**等场景做了主动收敛。

### 技术特性

- **MV3 service worker 架构**:无后台常驻进程,事件驱动,内存占用低
- **规则即数据**:50+ 个 JSON 规则文件(`public/rules/`)集中维护,构建期预编译 hint prefilter 与 keyword 合并正则,运行时只跑命中候选

### 识别覆盖

| 维度   | 类目示例                                        |
| ------ | ----------------------------------------------- |
| 前端   | 前端框架 / UI 框架 / 前端库 / 构建与运行时      |
| 服务端 | Web 服务器 / 后端框架 / CDN 与托管 / 开发语言   |
| 内容   | 网站程序 / 主题模板 / CMS / 电商平台 / RSS      |
| 第三方 | SaaS / 探针监控 / AI 大模型 / 第三方登录 / 支付 |
| 营销   | 广告 / 营销 / 统计 / 分析 / 标签管理            |
| 安全   | HTTPS / HTTP/2 / HTTP/3 / CSP / Cookie 同意     |

### 安装

**从源码加载**(开发模式):

```bash
git clone https://github.com/setube/stackprism.git
cd stackprism
pnpm install
pnpm run build            # Chrome / Edge
pnpm run build:firefox    # Firefox
```

**Chrome / Edge:**

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」,选 `dist/` 目录
4. 访问任意网页,扩展图标显示识别数量

**Firefox:**

1. 打开 `about:debugging#/runtime/this-firefox`
2. 点「临时载入附加组件」,选 `dist-firefox/manifest.json`
3. 或者运行 `pnpm run build:firefox` 后在 `release/` 目录获取 `.xpi` 文件双击安装

### 开发

```bash
pnpm run dev          # 开发模式 + HMR
pnpm run typecheck    # vue-tsc 类型检查
pnpm run lint         # ESLint
pnpm run build        # 生产构建(含规则预编译)
pnpm run build:firefox # Firefox 构建 + .xpi 打包
pnpm run docs:dev     # VitePress 文档站本地预览
```

## 规则维护

栈棱镜的规则系统是数据驱动的——绝大多数检测改规则 JSON 即可,无需碰代码。

- **加载清单**:[public/rules/index.json](public/rules/index.json) 列出所有要加载的规则文件
- **页面规则**:`public/rules/page/*.json` 处理页面源码、DOM、资源 URL、动态资源
- **响应头规则**:`public/rules/headers/*.json` 处理服务端响应头与 Cookie
- **自指抑制**:[public/rules/self-host-suppress.json](public/rules/self-host-suppress.json) 当用户在某主流站点上时跳过同名识别
- **技术链接**:[public/tech-links.json](public/tech-links.json) 集中维护技术名 → 官网/仓库 URL 的映射,识别结果可点击跳转
- **构建期 prefilter**:[vite.config.ts](vite.config.ts) 的 `precompileRulesPlugin` 在 `closeBundle` 阶段为每条 leaf rule 注入 `__hints`(最长 literal 段去重排序取前 3)和 `__keywordCombined`(keyword 合并正则),运行时 `rule-matcher.ts` 优先用它们做候选过滤

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

### 规则质量约束

- 优先用**高特征信号**:响应头、专属资源 URL、`<meta name="generator">`、`window.<global>`、独家 CSS 选择器、JS 版权注释、官方 SDK 包名
- 避免短或过宽的 keyword(`spring` / `phoenix` / `column` / `container` 这些会命中竞品讨论、Bootstrap 与 Tailwind 通用类)
- 优先限定 `matchIn`,**优先** `resources` / `url` / `headers` 而不是裸 `html`,减少正文误报

## 注意事项

- **后端识别不保证完整**:很多站点隐藏 `Server` / `X-Powered-By` 等响应头,后端结果会以"线索 + 置信度"形式展示
- **伪造响应头**:扩展会主动识别 ≥4 种主体身份字段同时存在的伪造场景,将相关类目降级为低置信度并附警示。但单个伪造头无法识别,建议结合其他线索判断
- **首次安装请刷新目标页**:让 service worker 捕获主文档响应头
- **源代码搜索是 DOM 快照**:基于当前页面的 `outerHTML`,不等同于服务器最初返回的原始 HTML
- **Chrome 系统页 / 商店页 / 内置页**通常不允许注入检测脚本
- **动态监控异步累积**:content script 在后台累计交互后新加载的资源,重新打开 popup 可看到合并结果

## 参与共建

栈棱镜目前内置 50+ 类目下 2000+ 条识别规则,但前端生态变化快,**新框架、新 SaaS、新规则误报**都欢迎参与:

- **Bug / 误识 / 漏识反馈**:[Issues](https://github.com/setube/stackprism/issues) — popup 上直接点「识别不准确」按钮会自动填好议题模板
- **规则贡献**:扩展设置页点「提交规则贡献」,或直接 PR 到 [`public/rules/`](public/rules/)
- **讨论与提案**:[Discussions](https://github.com/setube/stackprism/discussions)

提交代码前请跑 `pnpm run typecheck && pnpm run lint && pnpm run build` 三个检查全过。

## 星标趋势

如果觉得有帮助,欢迎点 Star 让更多人看到这个项目。

<img src="https://api.star-history.com/svg?repos=setube/stackprism&type=Date" style="width: 60%; height: auto;" alt="Star History">

## 开源协议

本项目基于 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 协议授权 —— **允许非商业自由使用与二次修改,必须署名且衍生作品采用同一协议**。完整法律文本见 [LICENSE](LICENSE)。
