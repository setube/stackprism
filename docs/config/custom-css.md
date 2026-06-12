# 自定义弹窗样式

设置页里有一个自定义 CSS 输入框。这里写的 CSS 保存后会注入到弹窗、设置页和帮助页的 `<head>`，用于覆盖默认样式。

## 例子：让置信度药丸更显眼

```css
.confidence.high {
  background: #14532d;
  color: #fff;
  font-weight: 700;
}

.confidence.medium {
  background: #ca8a04;
  color: #fff;
}
```

## 例子：换主题色

```css
:root {
  --accent: #d946ef;
  --accent-dark: #a21caf;
  --accent-soft: rgba(217, 70, 239, 0.1);
}
```

弹窗里的 segment、技术链接 hover、刷新按钮等都引用这些 token，改完会一起变色。

## 例子：放大字号

```css
body {
  font-size: 15px;
}

.tech-name {
  font-size: 14px;
}
```

## 注入位置

所有自定义 CSS 会放进固定 ID 的 `<style id="stackPrismCustomCss">` 标签，并插入到 `<head>` 末尾。重新保存会替换旧内容，不会重复追加。

## 适用范围

- 弹窗（popup）
- 设置页（options page）
- 使用说明页（help page）

不会影响普通网页 - 这段 CSS 只在扩展自己的 UI 范围内生效。

## 调试技巧

打开弹窗或设置页，右键 → 检查。Elements 面板里能看到注入的 style 标签，方便确认选择器是否命中。

## 限制

- 长度上限 `CUSTOM_RULE_LIMITS.css`（默认 10000 字符），超了保存会失败
- 不能引入外部 CSS 文件（不能 `@import`），因为扩展 CSP 不允许
- 不能用 `url(...)` 引用 base64 之外的远端图片
