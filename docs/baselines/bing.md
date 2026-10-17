# Bing 最小实测基线 / Minimal live baseline

## 中文

这是通道回归基线，不是 Bing 完整技术栈的权威清单。定义位于 `baselines/bing.json`；默认单测使用脱敏夹具，不依赖公网。

在仓库根目录执行：

```sh
bun run baseline:bing
```

生成 `artifacts/bing/report.json` 和中英 `report.md`，目录已被 Git 忽略。退出码 0 表示通过，1 表示预期漂移，2 表示网络／HTTP／响应头读取导致无法观察。拒绝访问、限流、超时不能解释为“网站未使用技术”。需要自定义输出路径时，构建后运行 `node build-scripts/check-bing-baseline.mjs --output <directory>`。

| 内容 | 判定方式 |
| --- | --- |
| 最终主机 | `www.bing.com` 或 `cn.bing.com`；当前环境重定向到后者 |
| 必须命中 | HTTPS、JavaScript、Open Graph，依据协议、script 和 meta 标记 |
| 通道完整性 | 主文档和子资源通道已观察、响应数量有上限且计数守恒 |
| 可变观察 | Azure CDN / Front Door、HTTP/2、ASP.NET、资源数量、耗时；不作为固定真值 |
| 不做断言 | React／Vue／IIS 是否存在、Bing 后端全貌；没有直接证据就不推断 |

2026-10-17 实测：SDK `0.2.0`，Windows x64，Node `22.19.0`，本机 Chrome。最终 `https://cn.bing.com/`，HTTP 200，8/8 断言通过；观察并采集 38 个子资源响应，跳过 0，失败 0；观察窗口 1000 ms，检测耗时 2908 ms。耗时是单次观察，不是性能基准。

| 范围 | 观察结果 | 解释 |
| --- | --- | --- |
| 页面／主文档 | Azure CDN / Front Door、HTTP/2、HTTPS、JavaScript、Open Graph | 与扩展前的 5 项一致 |
| 子资源 | Azure CDN / Front Door、ASP.NET | 新通道提供资源级证据 |
| ASP.NET | `https://cn.bing.com/web/xlsc.aspx`，XHR，HTTP 204，medium | 由端点 `.aspx` 路径命中既有规则，不能证明整个 Bing 的后端实现 |

`scanUrl` 从导航前监听，`load` 后默认继续观察 1000 ms。`observationMs` / CLI `--observe` 可设 0–5000 ms；总预算依然由 `timeoutMs` 控制。最多保留当前主框架文档的 64 个子资源响应，同时挂起的头读取不超过 64。忽略 iframe 内部和旧文档请求，不读 body、不额外发检测请求。URL 移除凭据、查询和片段，路径仍需按不可信数据处理。

检查 `network.responses` 中的 `url`、`relation`、`resourceType`、`status`、`technologies`；`same_origin` / `cross_origin` 只比较 origin，不代表组织归属。顶层 `technologies` 仍只合并原页面与主文档响应头，不混入资源服务器。`detectPage` 无法追回历史响应头，继续返回 `not_observed`。

## English

This is a channel regression baseline, not an authoritative inventory of Bing's stack. The definition lives in `baselines/bing.json`; normal tests replay a sanitized fixture without public-network access.

From the repository root:

```sh
bun run baseline:bing
```

Writes JSON and bilingual Markdown to the Git-ignored `artifacts/bing` directory. Exit 0 means pass, 1 means expected-fact drift, and 2 means unobservable due to networking, HTTP or failed header reads. Blocking, rate limits and timeouts do not mean a technology is absent. After building, use `node build-scripts/check-bing-baseline.mjs --output <directory>` to choose an output location.

| Item | Evaluation |
| --- | --- |
| Final host | `www.bing.com` or `cn.bing.com`; this environment redirects to the latter |
| Required | HTTPS, JavaScript, Open Graph, supported by protocol/script/meta evidence |
| Channel integrity | Main-document and subresource coverage, bounded responses and consistent counts |
| Variable observations | Azure CDN / Front Door, HTTP/2, ASP.NET, counts and timings; not fixed ground truth |
| No claim | Presence/absence of React, Vue or IIS, or Bing's complete backend |

Live capture on 2026-10-17: SDK `0.2.0`, Windows x64, Node `22.19.0`, installed Chrome. Final URL `https://cn.bing.com/`, HTTP 200, 8/8 assertions passed. Captured all 38 observed subresource responses, zero skipped/failed, with a 1000 ms after-load window. Detection took 2908 ms; this is one observation, not a benchmark.

The five page/main-document detections remained Azure CDN / Front Door, HTTP/2, HTTPS, JavaScript and Open Graph. The new channel found Azure edge and a medium-confidence ASP.NET signal on the XHR endpoint `https://cn.bing.com/web/xlsc.aspx` (HTTP 204). Its `.aspx` path matches an existing rule; it does not establish Bing's overall backend implementation.

`scanUrl` attaches listeners before navigation and observes for 1000 ms after load by default. `observationMs` / CLI `--observe` accepts 0–5000 ms within the overall `timeoutMs` budget. At most 64 subresource responses from the current main-frame document are retained, with at most 64 outstanding header reads. Frame internals and stale-document requests are excluded. No bodies or additional detection requests. Credentials, query and fragment are removed from network URLs; paths remain untrusted.

Read `network.responses` for URL, exact origin relation, resource type, status and technologies. Cross-origin does not imply third-party ownership. Top-level technologies still combine only the existing page and main-document header detectors. `detectPage` cannot recover historical response headers and remains `not_observed`.
