# AGENTS.md - StackPrism 仓库执行约束

## 1. 沟通与事实边界

- 全程使用中文沟通，答案直接收束当次诉求，不附加无关建议。
- 结论必须基于代码、测试、构建、日志、浏览器验证或 git 证据，不凭印象判断。
- 本仓库是基于 Vite、Vue 3、TypeScript、`@crxjs/vite-plugin` 的 Chrome/Edge Manifest V3 扩展。不要套用 Rust、Python、后端服务或数据库项目流程。
- 阶段目标优先级：先保证检测、消息、构建和导出行为等价，再考虑性能优化、压缩体积和基准测试。
- 禁止为“先跑通”添加隐藏回退、静默容错、假成功 Mock 或吞异常继续的路径。失败必须显式暴露到错误、日志、状态或失败测试。

## 2. 任务来源与原子边界

- 当前仓库没有固定的 `issues.csv` 或 `tasks.md`。默认任务来源按优先级为：用户当前明确指令、已确认的 GitHub issue/PR、正在执行的 `docs/superpowers/plans/` 计划。
- `docs/reviews/` 是验证与审计记录目录，不是默认任务驱动源。若用户明确指定某份审计报告或阶段计划，则以该文件中的未完成项作为当前边界。
- 每次只处理一个原子任务。开始前先确认目标文件、验收标准和最小验证命令；发现范围扩大时先记录事实，再等待明确指令或单独开新任务。
- 不并行开发多个任务，不顺手修无关问题。可在回复或审计文档中记录遗漏，但不要混进当前 diff。
- 修改前先看 `git status --short --branch`。工作区可能已有用户改动，禁止回滚或覆盖非本次改动。
- 每个原子任务结束前必须自审：对照验收标准、对照审查要求、运行最小相关验证、用 `git diff --name-only` 确认无范围外残余。

## 3. 最新认知索引

- 架构总览优先查 `docs/dev/architecture.md`。
- 规则格式与贡献约束优先查 `docs/dev/rule-format.md` 和 `docs/dev/contribute-rules.md`。
- Agent Bridge 当前设计优先查 `docs/dev/agent-bridge.md`。
- Agent Bridge 阶段计划优先查 `docs/superpowers/plans/2026-05-21-stackprism-agent-bridge-plan.md`。
- Agent Bridge 当前验证状态优先查 `docs/reviews/CR-AGENT-BRIDGE-E2E-2026-05-22.md`。
- README 面向用户安装、规则维护、功能说明；当 README 和代码事实冲突时，以代码事实和最新验证记录为准，并同步回写文档。

## 4. 仓库结构速查

- `src/background/`：MV3 service worker、消息路由、检测调度、规则加载、tab 缓存、响应头采集、Agent Bridge 捕获编排。
- `src/content/`：content script，负责 DOM、资源、交互与 Agent Bridge 传输。
- `src/injected/`：注入到页面 MAIN world 的检测脚本，由 `build-scripts/build-injected.mjs` 单独构建为 IIFE。
- `src/ui/`：popup、settings、help 三个 Vue 页面及共享组件、样式 token。
- `src/types/`：跨脚本共享类型，尤其是 `messages.ts`、`rules.ts`、`settings.ts`、`popup.ts`。
- `src/utils/`：共享 helper。跨 background、content、ui 使用前确认不会引入不兼容的 Chrome 或 DOM 运行时依赖。
- `public/rules/`：技术识别规则 JSON。规则变更优先只改数据文件，除非现有 matcher 无法表达需求。
- `public/tech-links.json`：技术名到官网链接映射。
- `agent-skill/stackprism-site-experience/`：仓库内 Agent Bridge skill 包，不会自动安装到全局 skill registry。
- `docs/`：VitePress 文档。
- `dist/` 和 `docs/.vitepress/dist/` 是构建产物，除非任务明确要求，不纳入提交。

## 5. 开发命令

- 安装依赖：`pnpm install`
- 开发服务：`pnpm run dev`
- 注入脚本构建：`pnpm run build:injected`
- 生产构建：`pnpm run build`
- 单元测试：`pnpm run test:unit`
- 类型与构建检查：`pnpm run typecheck`
- Lint：`pnpm run lint`
- 文档开发：`pnpm run docs:dev`
- 文档构建：`pnpm run docs:build`
- 技术链接检查：`pnpm run check:links`

验证优先级按风险选择：小工具函数改动至少跑相关 `node --test` 或 `pnpm run test:unit`；类型、消息协议、构建链路、manifest、规则预编译、注入脚本相关改动至少跑 `pnpm run typecheck` 或 `pnpm run build`；文档站改动跑 `pnpm run docs:build`。浏览器扩展可加载性以 `pnpm run build` 后的 `dist/manifest.json` 和加载 `/Volumes/Work/code/stackprism-1.3.70/dist` 为准。

## 6. MV3、消息协议与运行时约束

- Service worker 不是常驻进程。不要依赖内存中的长期状态；需要跨事件保留的数据优先使用 `chrome.storage.session` 或已有缓存模块。
- 所有跨脚本消息必须经过 `src/types/messages.ts` 的 discriminated union 和 `src/utils/messaging.ts`。新增消息要同步更新类型、发送端、接收端和测试。
- `src/injected/*` 不能依赖扩展上下文 API。注入脚本通过 IIFE 文件注入页面 MAIN world，输入输出边界必须显式、可序列化。
- 不要把 `public/rules/` 或 `public/tech-links.json` 直接 `import` 进 runtime bundle；运行时通过 `chrome.runtime.getURL` 与 `fetch` 加载，避免 service worker 冷启动膨胀。
- 主动检测、动态快照、tab 状态和 popup 缓存改动要考虑标签页切换、页面跳转、URL 最终态、Chrome 系统页不可注入、service worker 重启。
- 修改 Agent Bridge、active tab、capture 或 profile 传输逻辑时，必须显式覆盖目标 URL 校验、最终 URL 校验、tab 关闭、扩展重载、service worker 重启、超时、取消和重复提交边界。

## 7. 规则、数据格式与报告 schema

- 规则 JSON 的文件清单由 `public/rules/index.json` 管理。新增或移动规则文件必须同步清单。
- 规则字段、分组和置信度参考 `docs/dev/rule-format.md` 与 `docs/dev/contribute-rules.md`。
- 优先使用高特征信号：专属响应头、专属资源 URL、`meta generator`、明确全局变量、专属 selector、官方 SDK 包名。
- 避免短 keyword、宽泛 regex 和裸 `html` 命中。拿不准时降低置信度，并补充能复现误报边界的测试或说明。
- 处理 JSON、manifest、消息 payload、导出报告、Agent Bridge profile schema 时，必须明确字段顺序、类型和含义；相关测试要覆盖缺字段、空值、错位和兼容分支。
- 复制报告功能的边界是“当前弹窗结果”，不是未过滤的全部检测结果；不要把 raw JSON、完整原始线索和完整技术栈报告混成同一个交互面。

## 8. Agent Bridge 安全与隐私边界

- Agent Bridge 默认关闭，只能由用户在扩展设置中显式启用。
- 本机 bridge 只能绑定 `127.0.0.1`。API token 只允许保存在进程内或请求头中，禁止写入源码、文档示例的真实值、日志或测试 fixture。
- `bridgeToken`、nonce、capture id 只能绑定一次捕获流程。不得复用旧 token，不得把失败捕获伪装成成功 profile。
- 目标 URL 仅允许 `http:` 和 `https:`。私有网络目标必须显式设置 `allowPrivateNetworkTarget`，默认 fail closed。
- 禁止采集或输出 Cookie、Authorization、localStorage/sessionStorage 明文、完整敏感文本、签名 URL 和账号私密内容。
- 首版信任边界是“本机用户启动的 bridge 进程和当前浏览器 profile”。不要宣称它能防同机恶意进程或同 profile 其他恶意扩展。

## 9. UI 与前端约束

- UI 改动遵循现有 Vue 单文件组件、组合式 API 和 `src/ui/tokens.css` 设计 token，不引入新的状态管理库。
- popup、settings、help 是独立扩展页面。共享状态以 `chrome.storage.sync`、消息协议或明确的 utility 表达，不假设页面间共享内存。
- 控件优先复用 `src/ui/components/` 现有组件。按钮、输入、选择器、复选框和主题切换要保持现有视觉密度和键盘可用性。
- 不在界面上加入解释功能实现、快捷键或内部机制的说明性文字，除非产品本身需要。
- UI 文案必须区分当前弹窗结果、完整原始线索、完整技术栈报告和 Agent Bridge profile，不用同一词描述不同数据面。

## 10. 代码质量红线

- 只改当前原子任务需要的文件。提交前用 `git diff --name-only` 确认没有范围外残余。
- 函数尽量保持短小，超过约 50 行应优先拆分。嵌套超过 3 层时用卫语句或提取函数降低复杂度。
- 不硬编码密钥、私有路径、用户环境或只为测试成立的假设。
- 外部输入包括页面 DOM、URL、响应头、storage、用户自定义规则、剪贴板内容、本机 bridge 请求和导入的 JSON，必须在边界处校验或规范化。
- 代码、注释、日志、Markdown 文档中禁止使用 Emoji 或装饰性 Unicode 符号。列表用 `-`、`*` 或数字，强调用 Markdown 加粗。
- 注释只解释非直观原因、协议约束或复杂边界；不要复述代码做了什么。

## 11. 测试与验证记录

- 测试放在 `tests/*.test.mjs` 或现有测试目录，不在 `src/` 内新增内联测试块。
- Node 测试使用仓库脚本 `pnpm run test:unit`，该脚本已设置 `--test-timeout=60000`。
- 对消息协议、Agent Bridge、manifest、报告格式、规则匹配、动态采集等行为改动，优先新增或更新自动化测试。
- 结构化数据、规则 JSON、manifest、profile schema、报告 schema 的变更必须有格式校验或契约测试，至少覆盖缺字段、错字段类型、空值和多版本兼容分支。
- 无法运行完整验证时，必须说明未运行的命令、原因和剩余风险。不得把局部测试通过表述成真实浏览器环境已通过。
- 主线回归或阶段验收应记录到 `docs/reviews/`，包含命令、退出码、通过或失败摘要、跳过原因和未覆盖风险。

## 12. Code Review 模式

- 当任务标题或用户请求包含 `Code Review`、`review`、`审计`、`检查未提交更改` 时，先进入只读审查：读取 `git status`、`git diff`、相关文件和可用测试结果。
- 审查输出优先列问题，按严重程度排序，绑定具体文件和行号。没有问题时明确说明，并列出未覆盖的验证缺口。
- 正式审计报告写入 `docs/reviews/CR-{ID}.md` 或用户指定路径。若发现严重问题，在报告中列出后续修复任务；只有用户明确要求时才修改业务代码。
- 若用户要求“review 并修复”，先给发现，再实施明确可验证的修复。

## 13. Skills 使用规则

- 开始任务前只需轻量确认仓库内可用技能文档。当前已知 repo-local skill 是 `agent-skill/stackprism-site-experience/SKILL.md`。
- 当任务需要通过用户已安装的 StackPrism 扩展采集目标网站体验 profile 时，必须阅读并遵循该 skill。
- JavaScript bridge 优先使用 `node agent-skill/stackprism-site-experience/scripts/stackprism-bridge.mjs`；仅当 Node 不可用时使用 Python fallback。
- bridge stdout 只能读取 ready JSON 行；普通日志和启动错误应在 stderr。解析失败要显式报错，不得继续伪造 ready 状态。
- 启用技能时在沟通中声明技能名称与用途。

## 14. 提交与文件卫生

- 每个原子任务单独提交。提交信息说明实际改动，不使用泛泛标题。
- 提交前至少检查：`git status --short`、`git diff --name-only`、相关测试或构建命令。
- 不提交临时文件、日志、缓存、个人配置、`dist/`、`docs/.vitepress/dist/`、`node_modules/`。
- PR-only 截图或演示资产不要留在主项目 diff 中；如需保留，使用单独资产分支或用户指定位置。
- 分支创建默认使用 `codex/` 前缀，除非用户指定其它命名。

## 15. 历史踩坑备忘

- 安装扩展时必须给出真实构建产物路径：`/Volumes/Work/code/stackprism-1.3.70/dist`，不要只说 `dist/`。
- `typecheck` 会触发生产构建；报告验证结果时要说明它覆盖了 `vue-tsc --noEmit` 和 `pnpm build`。
- Agent Bridge 不能只靠单元测试宣称完成真实 E2E；真实浏览器加载、目标捕获、profile 轮询和扩展重启边界必须单独验证或记录缺口。
- 文档、README、guide 和 UI 文案必须同步区分 raw JSON、完整原始线索、当前弹窗结果和完整技术栈报告。
