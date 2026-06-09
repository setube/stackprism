# 识别开关

设置页第一块是分类开关。每个 checkbox 对应一个分类，关掉后弹窗里不再显示该分类下的技术，包括内置规则和自定义规则。

## 全部分类

| 分类 | 包含示例 |
| --- | --- |
| 前端框架 | React、Vue、Angular、Next.js、Nuxt、Gatsby、Remix、SvelteKit、Astro |
| UI / CSS 框架 | Tailwind CSS、Bootstrap、Material UI、Ant Design、Element Plus、Chakra UI |
| 前端库 | jQuery、Axios、D3、Three.js、Chart.js |
| 构建与运行时 | Webpack、Vite、Rollup、Parcel、esbuild、SWC、Turbopack、Bun |
| CDN / 托管 | Cloudflare、Akamai、Fastly、AWS CloudFront、Vercel、Netlify、jsDelivr |
| Web 服务器 | Nginx、Apache、Caddy、IIS、lighttpd |
| 后端 / 服务器框架 | Django、Flask、Rails、Laravel、Express、Koa、Spring、ASP.NET |
| 开发语言 / 运行时 | PHP、Node.js、Python、Ruby、Java、Go、Rust |
| 数据基础设施 | Kibana、Elasticsearch、Redis、MongoDB、PostgreSQL 管理面板 |
| 对象存储 / 文件存储 | AWS S3、MinIO、Cloudflare R2、七牛云、阿里云 OSS |
| DevOps / 研发效能 | Jenkins、GitLab CI/CD、SonarQube、Sentry、LaunchDarkly |
| 开发者工具 / 代码托管 | GitHub、GitLab、Bitbucket、CodeSandbox、StackBlitz |
| 低代码 / 自动化 / 内部工具 | Retool、Appsmith、n8n、Zapier、Make |
| 网站程序 | WordPress、Drupal、Discuz!、Typecho、ZBlog、phpBB、MediaWiki |
| CMS / 电商平台 | Shopify、Magento、PrestaShop、Liferay Portal |
| Headless CMS | Contentful、Sanity、Strapi、Storyblok |
| 主题 / 模板 | WordPress 主题、Drupal 主题、CMS 模板路径反推 |
| 网站源码线索 | WordPress 插件、Drupal 模块、源码路径和资源命名线索 |
| 探针 / 监控 | New Relic、Datadog、Pingdom、Hotjar、Grafana |
| 状态页 / 可用性监控 | Statuspage、Better Stack、UptimeRobot |
| RSS / 订阅 | RSS、Atom、JSON Feed |
| SaaS / 第三方服务 | Intercom、Crisp、HubSpot、Zendesk、Airtable |
| AI / 大模型 | Open WebUI、Dify、Flowise、Gradio、ComfyUI |
| 第三方登录 / OAuth | Google 登录、GitHub OAuth、微信登录、Auth0、Clerk |
| 支付系统 | Stripe、PayPal、支付宝、微信支付、银联 |
| 订阅计费 / 税务发票 | Chargebee、Paddle、Recurly、TaxJar |
| 电子签名 / 合同 | DocuSign、Dropbox Sign、PandaDoc |
| KYC / 反欺诈风控 | Stripe Identity、Persona、Sift、Riskified |
| 会员积分 / 推荐返利 | ReferralCandy、Smile.io、Yotpo Loyalty |
| 招聘 / ATS | Greenhouse、Lever、Workable |
| 预约排程 | Calendly、Acuity Scheduling、Cal.com |
| 活动 / 票务 | Eventbrite、Ticket Tailor、Luma |
| 物流追踪 / 退货售后 | AfterShip、Shippo、Narvar |
| 广告 / 营销 | Google Ads、Facebook Pixel、TikTok Pixel |
| 统计 / 分析 | Google Analytics、百度统计、友盟、Plausible、Umami |
| 分析与标签 | Google Tag Manager、Segment、Tealium |
| 站内搜索 / 个性化推荐 | Algolia、Elastic Site Search、Constructor.io |
| 评论 / 社区嵌入 | Disqus、Giscus、Discourse |
| 评价 / UGC | Trustpilot、Yotpo Reviews、Bazaarvoice |
| 产品引导 / 用户反馈 | Pendo、Userpilot、Canny、UserVoice |
| 表单 / 问卷 | Typeform、Jotform、Formspree |
| 隐私合规 / Cookie 同意 | OneTrust、Cookiebot、Iubenda |
| 无障碍辅助 | UserWay、accessiBe、EqualWeb |
| Web Push / 消息推送 | OneSignal、Firebase Cloud Messaging、PushEngage |
| 短信 / 通信 API | Twilio、Vonage、MessageBird |
| 电话 / 呼叫追踪 | CallRail、Aircall、Twilio Voice |
| 邮箱验证 / 邮件校验 API | ZeroBounce、NeverBounce、Mailboxlayer |
| 地址验证 / 地理编码 | Google Maps Platform、Mapbox、Loqate |
| IP 地理位置 / IP 情报 | ipinfo、ipstack、MaxMind、ipdata |
| 金融数据 / 汇率 API | Open Exchange Rates、Currencylayer、Plaid |
| 天气 / 气象数据 | OpenWeather、WeatherAPI、Tomorrow.io |
| 翻译 / 本地化 API | Lokalise、Phrase、Crowdin |
| OCR / 文档智能 API | Veryfi OCR、Mindee、Google Document AI |
| 文档生成 / 截图 API | ApiFlash、Urlbox、Bannerbear |
| 媒体托管 / 图片处理 | Cloudinary、imgix、Mux |
| 实时音视频 / 视频 SDK | Agora、Twilio Video、Daily |
| Web3 钱包 / 链上基础设施 | WalletConnect、Alchemy、thirdweb |
| 代码示例 / 在线 IDE 嵌入 | CodePen、StackBlitz、CodeSandbox |
| 安全与协议 | HTTPS、CSP、Service Worker |
| 其他库 | 自定义规则默认归类、未明确分类的兜底 |
| ... 等共 60 类 | 完整列表见 `src/utils/category-order.ts` |

完整列表：`src/utils/category-order.ts` 的 `CATEGORY_ORDER` 数组。该列表覆盖内置规则已使用的分类，并保留运行时内置检测和自定义规则的兜底分类。

## 全开 / 全关

右上角有「全开」「全关」两个按钮，用来批量勾选或取消所有分类。

## 关闭分类的常见用途

- **只看技术栈，不看插件**：关「WordPress 插件」「Drupal 模块」，避免插件名把列表撑得太长
- **只看后端不看前端**：关掉「前端框架」「UI / CSS 框架」「构建与运行时」
- **过滤通用 SaaS**：关「广告 / 营销」「SaaS / 第三方服务」「统计 / 分析」聚焦核心技术栈

## 实现细节

被关闭的分类不会从 raw JSON 里删除。`原始线索` 面板仍能看到完整识别结果。识别开关只影响弹窗主列表的显示。
