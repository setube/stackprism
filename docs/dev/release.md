# 构建与发布

## 本地构建

```bash
pnpm install
pnpm run build
```

链路：

1. `pnpm run build:injected`（`build-scripts/build-injected.mjs`）：esbuild 把 `src/injected/page-detector.ts` 与 `page-source-search.ts` 各编译成一个独立 IIFE 文件，输出到 `public/injected/`
2. `vite build`（`@crxjs/vite-plugin`）：打包 background / popup / settings / help 四个入口，输出到 `dist/`
3. `precompileRulesPlugin`（vite plugin closeBundle hook）：扫 `dist/rules/*.json`，给每条 leaf rule 注入 `__hints` / `__keywordCombined`
4. `minifyJsonAssets`（vite plugin closeBundle hook）：所有 JSON 用 `JSON.stringify(parsed)` 重写，去缩进与换行

最终 `dist/` 可直接在 `chrome://extensions/` 开发者模式加载。

## 开发热更

```bash
pnpm run dev
```

vite dev server + crxjs HMR：改 `src/ui/**` 弹窗 / 设置页 / 使用说明会自动热替换。改 `src/background/**` 后台代码或 `src/content/**` content script 需要在 `chrome://extensions/` 找到扩展卡片点刷新按钮重新加载。

## 类型与 lint

```bash
pnpm run typecheck    # vue-tsc --noEmit，全工程严格类型检查
pnpm run lint         # eslint src
```

提交前统一跑一遍格式化：

```bash
npx prettier --write .
```

## 版本号管理

`package.json` 的 `version` 字段是真源。`@crxjs/vite-plugin` 会自动把它同步到 `dist/manifest.json`。

常规功能、规则和修复改动递增 patch。patch 走到 `99` 后进入下一个 minor，不使用 `1.1.100` 这种版本号：

```bash
# 1.1.98 -> 1.1.99
# 1.1.99 -> 1.2.0
```

只有需要发安装包的版本才创建 GitHub Release：`x.y.0`、`x.y.10`、`x.y.20`、...、`x.y.90`。例如 `1.2.0`、`1.2.10` 要发，`1.2.5`、`1.2.15` 不发。

```bash
# 修改 package.json 版本后
git add package.json
git commit -m "chore: bump 1.2.10"
git push origin main
```

## GitHub Release 工作流

`.github/workflows/release-extension.yml` 在两种情况触发：

1. 在 GitHub UI 发布一个 release（`release: published` 事件）
2. 在 Actions 页面手动跑 workflow_dispatch（可选传 release_tag input）
   - 如果本版本包含 Agent Bridge，必须同时勾选 `agent_bridge_disclosure_confirmed`

工作流做的事：

1. checkout + 安装 pnpm + Node 20
2. `pnpm install --frozen-lockfile`
3. `pnpm run lint`
4. `pnpm run build:injected`
5. `pnpm run test:unit`
6. `pnpm run typecheck`，该脚本会执行 `vue-tsc --noEmit` 并刷新 `dist/`
7. `pnpm run docs:build`
8. `pnpm run build`，发布前再次刷新扩展产物
9. 校验 `dist/` 发布边界：`manifest.json` 不含 `externally_connectable`，`web_accessible_resources` 不暴露 agent-only 入口或 profiler，`dist/` 不包含 `agent-skill/`、`docs/superpowers/`、`tests/`、Python 源文件/字节码、repo-local JS bridge helper 源文件或本地 bridge server 入口
10. 如果 `dist/manifest.json` 包含 Agent Bridge 的 `http://127.0.0.1/*` content script 或 web accessible resource，校验商店隐私披露确认：workflow_dispatch 必须勾选 `agent_bridge_disclosure_confirmed`，release 事件的 release note 必须包含 `- [x] Agent Bridge disclosure confirmed`
11. 从 `dist/manifest.json` 读 version，校验与 release tag 一致
12. 把 `dist/` 整个 zip 成 `stackprism-v{ver}.zip` + sha256
13. **如果配置了 secret `EXTENSION_PRIVATE_KEY`**，再用 `npx crx3` 签名出 `stackprism-v{ver}.crx` + sha256；否则跳过 crx 仅传 zip
14. `gh release upload --clobber` 把所有产物上传到 release tag
15. `actions/upload-artifact` 同时备一份 artifact

## 发布说明

发布说明从上一个 release tag 到当前提交的 `git log --oneline vPREV..HEAD` 整理，不直接粘 commit 列表。写法按用户能看懂的方向归类，比如：

- 规则增强
- 弹窗与设置页
- 文档站
- 构建与发布流程

发布说明只写用户或维护者关心的变化，不写本地跑了哪些格式化、类型检查、lint 或构建命令。

如果本版本包含 Agent Bridge，release note 必须显式包含下面这行；工作流会在打包前读取 release body，没有勾选就失败：

```markdown
- [x] Agent Bridge disclosure confirmed
```

这行只能在维护者已经更新 Chrome Web Store / Edge Add-ons 后台隐私披露、数据用途说明、用户可见说明和 release note 后勾选。它不是代码测试结果，也不能代替商店后台的实际审核状态。

## CRX 签名密钥

第一次发布前需要生成一个 RSA 私钥，并把它配置到 GitHub repository secrets。

### 生成私钥

```bash
openssl genrsa -out extension.pem 2048
```

::: warning
`extension.pem` **绝对不能丢**——丢了重新生成会换扩展 ID（=Chrome 把它当成另一个扩展）。本地存档备份。
:::

### 配置到 GitHub

1. 仓库 Settings → Secrets and variables → Actions → New repository secret
2. Name: `EXTENSION_PRIVATE_KEY`
3. Secret: 把 `extension.pem` 文件**整体内容**（包括 `-----BEGIN PRIVATE KEY-----` 和 `-----END PRIVATE KEY-----`）粘贴进去
4. 保存

之后工作流会自动用这个 key 签 crx。

### 不配置会怎样

工作流仍能跑，仅产物里没有 `.crx` 文件。用户只能用 zip 解压加载。

## 发布检查清单

- [ ] `npx prettier --write .` 已执行
- [ ] `pnpm run typecheck` 通过
- [ ] `pnpm run lint` 通过
- [ ] `pnpm run build` 通过
- [ ] 在 chrome 里加载 `dist/` 手动测试关键路径（弹窗打开、识别一个站点、刷新、复制完整技术栈报告、设置页加规则）
- [ ] 如果本轮涉及 Agent Bridge，运行 bridge smoke test，并确认 `dist/` 不包含 `agent-skill/`、`docs/superpowers/`、`tests/`、Python 源文件/字节码、repo-local JS bridge helper 源文件或本地 bridge server 入口
- [ ] 如果发布 Agent Bridge，Chrome Web Store / Edge Add-ons 的隐私披露、数据用途说明、用户可见说明和 release note 已同步更新，明确 profile 会发送到用户本机 loopback bridge 供本地 Agent 读取，但不会发送到 StackPrism 远程服务器；随后 workflow_dispatch 勾选 `agent_bridge_disclosure_confirmed`，或在 release note 中加入 `- [x] Agent Bridge disclosure confirmed`
- [ ] 把 `package.json` 的 version bump
- [ ] git commit + push
- [ ] 如果版本符合 release 节点，在 GitHub UI 发布 release（tag 为 `v{version}`，与 package.json 对齐）
- [ ] 等发布工作流跑完，确认 release 资产里有 zip / crx 与 sha256

## 发布到 Chrome Web Store

工作流不自动上架到 Chrome Web Store——CWS 的 publish API 需要 OAuth2 流程，目前手动操作：

1. 把 `dist/` 文件夹打成 zip（同工作流的 zip 产物）
2. [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) → 上传新版本
3. 填变更说明，等审核（通常 1-3 工作日）

若本版本包含 Agent Bridge，还必须在 Chrome Web Store 和 Edge Add-ons 后台同步隐私披露与数据用途说明：该能力默认关闭，用户显式启用后会把浏览器侧可观测的技术栈与体验摘要发送到用户本机 `127.0.0.1` bridge，供本机 Agent 读取；StackPrism 不接收远程上传。

工作流只能检查维护者是否做了发布确认，不能自动验证 Chrome Web Store 或 Edge Add-ons 后台是否已经接受披露。商店后台状态仍以人工登录 dashboard 后看到的实际审核和发布状态为准。
