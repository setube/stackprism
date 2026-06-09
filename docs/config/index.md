# 配置指南

设置页可以通过弹窗顶部的「设置」按钮打开，或者在 `chrome://extensions/` 找到 StackPrism 卡片点「详情 → 扩展程序选项」。

设置页分六块：

- [识别开关](./categories.md) - 60 个分类的启停（关掉后该分类的技术不再显示在弹窗里）
- Agent Bridge - 启用后允许本机 Agent Bridge 读取当前浏览器可观测的技术与体验摘要；可人工确认放开所有网络目标
- [禁用指定技术](./disabled-technologies.md) - 用名字精确屏蔽某些技术（无视分类）
- [自定义弹窗样式](./custom-css.md) - 写一段 CSS 覆盖弹窗 / 设置页样式
- [自定义规则](./custom-rules.md) - 用表单或 JSON 添加自己的识别规则
- [规则 JSON 导入导出](./json-export.md) - 在多浏览器 / 多设备同步规则集合

## 配置存储位置

识别开关、禁用列表、自定义样式和自定义规则存在 `chrome.storage.sync`，会随你登录的 Google / Edge 账号跨设备同步。Key 是 `stackPrismSettings`。如果不想同步，可以关闭浏览器自己的同步功能。

Agent Bridge 启用状态和“允许所有网络目标”高风险开关是例外：它们只存在当前浏览器 profile 的 `chrome.storage.local`，不会随 Chrome sync 同步到其他设备、浏览器或 profile。换环境后需要重新显式开启。

`chrome.storage.sync` 的容量上限是 100KB，单个 key 不超 8KB。这意味着：

- 自定义规则数量有上限（约 100 条以内安全）
- 自定义 CSS 长度有上限（不超 10000 字符）
- 禁用列表不能太长

实际限制由 `src/types/settings.ts` 里的 `CUSTOM_RULE_LIMITS` 决定，超出后保存会失败并显示错误。

## 改完什么时候生效

| 改动                             | 何时生效                          |
| -------------------------------- | --------------------------------- |
| 识别开关 / 禁用技术 / 自定义 CSS | 重新打开弹窗后立即生效            |
| 自定义规则                       | 保存后下次刷新页面 + 重新打开弹窗 |
| JSON 导入                        | 同上                              |

点「保存设置」后会立即写入 storage，不需要刷新设置页。
