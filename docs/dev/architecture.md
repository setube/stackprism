# 架构概览

## 目录结构

```text
stackprism/
├─ src/
│  ├─ manifest.config.ts        # @crxjs/vite-plugin 用的 MV3 manifest 定义
│  ├─ background/                # service worker（ESM module worker）
│  │  ├─ index.ts                # 注册各 chrome 事件监听
│  │  ├─ message-router.ts       # onMessage 路由（8 种消息）
│  │  ├─ tab-store.ts            # tab/popup 缓存读写
│  │  ├─ headers.ts              # webRequest 响应头收集
│  │  ├─ detection.ts            # 主动检测 / scheduleActivePageDetection
│  │  ├─ popup-cache.ts          # 弹窗 raw / display 数据构建
│  │  ├─ wordpress.ts            # WordPress 主题 style.css 抓取
│  │  ├─ dynamic-snapshot.ts     # 动态快照防抖处理
│  │  ├─ tech-links.ts           # tech-links.json 懒加载
│  │  ├─ rule-loader.ts          # 规则 JSON 的加载与合并
│  │  ├─ rule-matcher.ts         # 编译缓存 + auto hint 预过滤
│  │  ├─ detector-settings.ts    # 设置 / 规则缓存
│  │  ├─ content-injector.ts     # 启动时给已开标签页注入 content script
│  │  └─ merge.ts                # 技术列表合并 / 去重 / suppress 规则
│  ├─ content/
│  │  └─ content-observer.ts     # MutationObserver 持续动态采集
│  ├─ injected/                   # 编译为独立 IIFE，注入到页面 MAIN world
│  │  ├─ page-detector.ts         # 990 行的检测主函数
│  │  └─ page-source-search.ts    # 弹窗的源代码搜索
│  ├─ ui/
│  │  ├─ popup/                   # 弹窗 SPA
│  │  ├─ settings/                # 设置页 SPA
│  │  ├─ help/                    # 使用说明页 SPA
│  │  ├─ components/Select.vue    # 自定义 Select / Combobox 组件
│  │  └─ tokens.css               # 全局 CSS 变量 + 浅暗主题 + scrollbar/checkbox 样式
│  ├─ types/                      # 跨脚本共享类型
│  │  ├─ messages.ts              # 8 种消息 discriminated union
│  │  ├─ rules.ts                 # RuleConfig / TechnologyRecord / PageDetectionResult
│  │  ├─ settings.ts              # DetectorSettings + CUSTOM_RULE_LIMITS
│  │  └─ popup.ts                 # PopupResult / PopupRawResult
│  └─ utils/                      # 三处共享 helper
│     ├─ normalize-settings.ts
│     ├─ category-order.ts
│     ├─ apply-custom-css.ts
│     ├─ build-issue-url.ts
│     ├─ tech-name.ts
│     ├─ url.ts
│     ├─ messaging.ts
│     ├─ theme.ts
│     └─ constants.ts
├─ public/
│  ├─ icons/                      # 16/32/48/128 PNG
│  ├─ rules/                      # 规则 JSON 文件
│  ├─ tech-links.json             # 524 KB 的技术名 → 官网链接映射
│  └─ injected/                   # build:injected 输出的两个 IIFE
├─ build-scripts/
│  └─ build-injected.mjs          # 用 esbuild 单独编译注入脚本
├─ vite.config.ts                 # 主构建（CRXJS + Vue + TS）+ 自定义 plugin
├─ vite.injected.config.ts        # 注入脚本独立 IIFE 构建
├─ docs/                          # 本文档站（VitePress）
└─ dist/                          # build 产物，加载到 chrome
```

## 进程模型

Chrome 扩展有四种执行环境，StackPrism 全部用上：

```text
┌─────────────────────────────────────────────────────────────┐
│ 1. Service Worker (ESM module)                              │
│    src/background/*.ts                                       │
│    - chrome.webRequest 监听响应头                            │
│    - chrome.runtime.onMessage 路由                           │
│    - chrome.storage.session 缓存检测结果                     │
│    - 加载 rules/* 与 tech-links.json                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 2. Content Script (页面 isolated world)                      │
│    src/content/content-observer.ts                           │
│    - MutationObserver 持续采集 DOM 变化                      │
│    - PerformanceObserver 采集资源加载                        │
│    - 累积 800ms 节流后通过 sendMessage 发回 background       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 3. Injected Script (页面 MAIN world)                         │
│    dist/injected/page-detector.iife.js                       │
│    dist/injected/page-source-search.iife.js                  │
│    - 通过 chrome.scripting.executeScript({files}) 按需注入   │
│    - 能读 window.* / 真实 DOM / globalKeys                   │
│    - 跑完返回结果，不长驻                                    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 4. Extension UI (popup / settings / help)                    │
│    src/ui/{popup,settings,help}/*.vue                        │
│    - Vue 3 + TS SPA                                          │
│    - 通过 chrome.runtime.sendMessage 与 background 通信      │
│    - 通过 chrome.storage.sync 存读用户配置                   │
└─────────────────────────────────────────────────────────────┘
```

## 跨脚本消息

8 种消息全部在 `src/types/messages.ts` 用 discriminated union 定义类型，所有调用走 `src/utils/messaging.ts` 的 `sendMessage<M>()` wrapper。

| 消息                          | 方向          | 用途                                |
| ----------------------------- | ------------- | ----------------------------------- |
| `GET_HEADER_DATA`             | popup → bg    | 拉取响应头记录                      |
| `GET_POPUP_RESULT`            | popup → bg    | 拉取轻量缓存（弹窗主显示）          |
| `GET_POPUP_RAW_RESULT`        | popup → bg    | 拉取完整 raw（原始线索 / 纠错反馈） |
| `GET_TECH_LINK`               | popup → bg    | 兜底查询某技术的官网链接            |
| `START_BACKGROUND_DETECTION`  | popup → bg    | 「刷新」按钮触发主动检测            |
| `GET_WORDPRESS_THEME_DETAILS` | bg internal   | 抓取主题 style.css header           |
| `DYNAMIC_PAGE_SNAPSHOT`       | content → bg  | content script 持续上报动态快照     |
| `PAGE_DETECTION_RESULT`       | injected → bg | page-detector 注入完返回结果        |

## 注入脚本的双轨问题

`page-detector.ts` 在原生实现里既被 background `importScripts` 引入，又被 `executeScript({world:'MAIN', func})` 序列化注入。切到 ESM 后，`Function.prototype.toString` 不能处理 import，所以这条路走不通。

解决方案：用 `executeScript({files})` 替代 `{func}`。`page-detector.ts` 独立编译为 IIFE 单文件（`vite.injected.config.ts`），通过两次 RPC 注入：

```ts
// 1. 写入临时全局变量
chrome.scripting.executeScript({
  target: { tabId },
  world: 'MAIN',
  func: rules => {
    window.__SP_RULES__ = rules
  },
  args: [pageRules]
})

// 2. 注入 IIFE，IIFE 内部读 __SP_RULES__ 后清空，return 结果
chrome.scripting.executeScript({
  target: { tabId },
  world: 'MAIN',
  files: ['injected/page-detector.iife.js']
})
```

这样处理后，background 不再直接依赖 page-detector，service worker 也可以使用 ESM module worker。

## 静态资源

`public/rules/` 和 `public/tech-links.json` 由 Vite 1:1 复制到 `dist/`，运行时通过 `chrome.runtime.getURL` + `fetch` 加载。不要用 `import rules from '...'` 直接导入这些大 JSON；那会让 Rollup 把规则内联进 bundle，service worker 冷启动会明显变慢。

build 期还有两个 vite plugin 处理这些 JSON：

1. `precompileRulesPlugin`：递归走每个规则 JSON，给每条 leaf rule 注入 `__hints`（自动从 patterns 提取的关键词）+ `__keywordCombined`（keyword 类型规则的合并正则源码）
2. `minifyJsonAssets`：把所有 JSON 用 `JSON.stringify(parsed)` 重写一遍消除缩进 / 空白

## 状态管理

不引 Pinia。原因：

- popup state 6 个字段
- settings state 2 个字段
- popup / settings 是两个独立扩展页面（独立 chrome.runtime context），Pinia 反而要二次实例化
- 共享的 `DetectorSettings` 用 `chrome.storage.sync` 作真源 + `reactive()` 本地副本即可

## 主题（明暗）

`src/utils/theme.ts` 管理 `getStoredTheme / setStoredTheme / cycleTheme / themeLabel`，存在 `chrome.storage.sync.stackPrismTheme`，三态：`auto` / `light` / `dark`。

`src/ui/tokens.css` 用 `:root[data-theme='dark']` 强制暗色、`@media (prefers-color-scheme: dark) :root:not([data-theme='light'])` 跟随系统、`color-scheme` 同步浏览器默认 UI。

主题切换在 popup 与 settings 顶部都有按钮，通过 `chrome.storage.onChanged` 跨页同步。
