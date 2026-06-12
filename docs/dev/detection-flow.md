# 检测流程

## 三条数据源管道

StackPrism 同时跑三条管道并把结果合并：

```text
┌──────────────────────────────────────────────────────────┐
│ 管道 A：响应头 (chrome.webRequest)                        │
│   - background webRequest.onHeadersReceived              │
│   - 主文档 / API / iframe 的 server / x-powered-by 等    │
│   - 写入 chrome.storage.session 的 tab:{id}.main /       │
│     tab:{id}.apis[] / tab:{id}.frames[]                  │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ 管道 B：页面主动检测 (chrome.scripting + injected)        │
│   - 用户点弹窗刷新按钮触发 START_BACKGROUND_DETECTION    │
│   - bg 调 scripting.executeScript 注入 page-detector     │
│   - page-detector 在页面 MAIN world 跑完返回结果         │
│   - 结果写入 tab:{id}.page                              │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ 管道 C：动态采集 (content script + MutationObserver)      │
│   - bg 在页面 load 时注入 content-observer.ts            │
│   - MutationObserver / PerformanceObserver 持续累积      │
│   - 800ms 节流后 sendMessage DYNAMIC_PAGE_SNAPSHOT       │
│   - bg 防抖 800ms 后跑 detectFromDynamicSnapshot         │
│   - 结果写入 tab:{id}.dynamic                           │
└──────────────────────────────────────────────────────────┘
```

三个 tab key 都存在 `chrome.storage.session`，service worker 重启后从 storage 恢复状态，不依赖 SW 内存。

## 数据流：从触发到弹窗显示

```text
用户点击扩展图标
  ↓
弹窗 mount
  ↓
loadCachedDetection()
  ↓
chrome.runtime.sendMessage({ type: 'GET_POPUP_RESULT', tabId })
  ↓
bg.message-router 路由到 getPopupResultResponse(tabId)
  ↓
检查 chrome.storage.session 里是否有 popup:{tabId} 缓存
  ├─ 命中且 settingsKey 一致 → 直接返还
  └─ 未命中 → 现场跑 buildPopupCacheRecord:
       1. 从 tab:{id} 读 page / main / apis / frames / dynamic
       2. addStoredCustomHeaderRules（应用用户自定义响应头规则）
       3. buildDisplayTechnologies：
          - 把 5 路结果合并到一个数组
          - mergeDisplayTechnologyRecords 去重 + sources Set 收集
          - filterTechnologiesBySettings（按设置页过滤）
       4. mergeResourceSummary（合并资源统计）
       5. cleanPopupTechnology + 排序输出
       6. 写入 popup:{tabId} 缓存
  ↓
bg 返回 PopupResult
  ↓
弹窗 setState.result，展示

注意：后续 background 还会持续接收 webRequest 响应头、动态快照等增量更新，
每次更新都重新写 popup:{tabId} 缓存
  ↓
chrome.storage.onChanged 触发 popup 端 onStorageChange
  ↓
比对 popupCacheSignature 多字段签名，确认有真实变化才替换 state.result
```

## 主动检测时机

弹窗里点「刷新」会触发 `START_BACKGROUND_DETECTION` 消息：

```ts
// background/detection.ts
const runActivePageDetection = async tabId => {
  const pageRules = await buildEffectivePageRules()

  // 1. 把规则写到页面临时全局
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: rules => {
      window.__SP_RULES__ = rules
    },
    args: [pageRules]
  })

  // 2. 注入 IIFE，IIFE 内部 return 结果
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['injected/page-detector.iife.js']
  })

  // 3. 存到 tab:{id}.page，触发 saveTabDataAndBadge 重建 popup 缓存
  data.page = cleanPageDetectionRecord(result)
  await saveTabDataAndBadge(tabId, data)
}
```

## Agent Bridge 采集流程

Agent Bridge 不复用弹窗按钮作为触发入口。它由本机 bridge 页面上的专用 content script 发起，background 在校验本机 opt-in、bridge 页面身份和 capture request 后，临时接管目标 tab 完成一次 site experience profile 采集。

```text
Agent 启动本机 bridge 脚本
  ↓
POST /v1/captures 创建 capture，得到一次性 bridgeUrl
  ↓
浏览器打开 http://127.0.0.1:{port}/bridge?... 页面
  ↓
agent-bridge-client.ts 校验 /bridge path、meta、session、capture、nonce、protocolVersion
  ↓
AGENT_BRIDGE_HELLO 发给 background
  ↓
background 校验 chrome.storage.local 中 agentBridgeEnabled 为 true
  ↓
bridge content script 读取 /v1/captures/{id}/request
  ↓
START_AGENT_CAPTURE 交给 background/agent-capture.ts
  ↓
打开或复用目标 tab，等待主 frame load 完成
  ↓
先把 finalUrl 写回 bridge，由 bridge server 执行最终 URL 策略校验
  ↓
finalUrl 通过后才运行技术检测和 experience-profiler
  ↓
profile 分片发回 bridge content script
  ↓
bridge content script 校验 chunk、sha256、session/capture/nonce 后同源 POST profile
  ↓
Agent 用 apiToken 读取 /v1/captures/{id}/profile
```

这个流程的关键边界：

- `agentBridgeEnabled` 只从 `chrome.storage.local` 读取，sync 旧字段不能自动开启。
- bridge tab、`/bridge` 页面和 `/v1/captures/*` 请求不写入普通 `tab-store`、popup 缓存、badge 或 dynamic snapshot。
- bridge content script 不持有 `apiToken`；background 不持久化 `bridgeToken`。
- `target_loaded` 的 final URL 被 bridge 接受前，不注入主动检测脚本或 experience profiler。
- profile 回传走 bridge content script 同源 POST，不由 background 直接跨 origin fetch localhost。
- 未完成 capture 的 deadline、tab ownership 和 cleanup 锚点写入 `chrome.storage.session`；service worker 重启后只能 fail closed，不伪造完成。

## 动态采集节流

content-observer 端：

- 每次 MutationObserver / PerformanceObserver 触发，把变化累加到 state
- `scheduleSend()` 设置 900ms 定时，定时到了发 `DYNAMIC_PAGE_SNAPSHOT`
- 中途如果还有变化继续累积，定时器重置——总之每 ~900ms 最多发一次

background 端 `dynamic-snapshot.ts`：

- 收到消息后 800ms 防抖
- 防抖到点跑 `detectFromDynamicSnapshot(snapshot, pageRules)`
- 写入 `tab:{id}.dynamic`，再走 `saveTabDataAndBadge`

## 规则匹配层（rule-matcher.ts）

每条 rule 在三个层面被使用：

```text
detectFromXxx(snapshot, rules)
  for (const rule of rules):
    1. matchesRuleTextHints(rule, context)      ─ 业务侧 resourceHints 预过滤
    2. passesRulePrefilter(rule, lowerTexts)    ─ 自动 hint 预过滤（命中即可继续）
    3. matchesCompiledRulePatterns(rule, text)  ─ 跑实际正则 / keyword 合并正则
       ├─ keyword 走 getCompiledCombinedPattern：缓存的合并正则一次匹配
       └─ regex 走 getCompiledRulePatterns.some：缓存的 RegExp[] 逐个 test
    4. 命中：add(category, name, confidence, evidence)
```

WeakMap 缓存使每条 rule 的正则 + hints 编译只跑一次，整个 rules 数组重复使用。

## badge 数字

每次 `saveTabDataAndBadge` 写完 popup 缓存后会取 `popupResult.counts.high`（高置信度技术数），调用 `chrome.action.setBadgeText` 显示在扩展图标上。打开弹窗看到的数字 ≈ badge 数字。

## 设置变更如何让缓存失效

`buildSettingsCacheKey(settings)` 把 settings 关键字段（disabledCategories / disabledTechnologies / customRules）序列化成一个 string。`getCachedPopupResult(popup, settings)` 命中条件之一就是 `popup.settingsKey === buildSettingsCacheKey(settings)`。

设置一变，settingsKey 变，老缓存自动失效，下次 `GET_POPUP_RESULT` 会现场重新构建。
