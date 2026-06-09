export const CATEGORY_ORDER: readonly string[] = [
  '前端框架',
  'UI / CSS 框架',
  '前端库',
  '构建与运行时',
  'CDN / 托管',
  'Web 服务器',
  '后端 / 服务器框架',
  '开发语言 / 运行时',
  '数据基础设施',
  '对象存储 / 文件存储',
  'DevOps / 研发效能',
  '开发者工具 / 代码托管',
  '低代码 / 自动化 / 内部工具',
  '网站程序',
  'CMS / 电商平台',
  'Headless CMS',
  '主题 / 模板',
  '网站源码线索',
  '探针 / 监控',
  '状态页 / 可用性监控',
  'RSS / 订阅',
  'SaaS / 第三方服务',
  'AI / 大模型',
  '第三方登录 / OAuth',
  '支付系统',
  '订阅计费 / 税务发票',
  '电子签名 / 合同',
  'KYC / 反欺诈风控',
  '会员积分 / 推荐返利',
  '招聘 / ATS',
  '预约排程',
  '活动 / 票务',
  '物流追踪 / 退货售后',
  '广告 / 营销',
  '统计 / 分析',
  '分析与标签',
  '站内搜索 / 个性化推荐',
  '评论 / 社区嵌入',
  '评价 / UGC',
  '产品引导 / 用户反馈',
  '表单 / 问卷',
  '隐私合规 / Cookie 同意',
  '无障碍辅助',
  'Web Push / 消息推送',
  '短信 / 通信 API',
  '电话 / 呼叫追踪',
  '邮箱验证 / 邮件校验 API',
  '地址验证 / 地理编码',
  'IP 地理位置 / IP 情报',
  '金融数据 / 汇率 API',
  '天气 / 气象数据',
  '翻译 / 本地化 API',
  'OCR / 文档智能 API',
  '文档生成 / 截图 API',
  '媒体托管 / 图片处理',
  '实时音视频 / 视频 SDK',
  'Web3 钱包 / 链上基础设施',
  '代码示例 / 在线 IDE 嵌入',
  '安全与协议',
  '其他库'
]

export const categoryIndex = (category: string): number => {
  const index = CATEGORY_ORDER.indexOf(category)
  return index === -1 ? CATEGORY_ORDER.length : index
}

export const confidenceRank = (value: string): number => {
  if (value === '高') return 0
  if (value === '中') return 1
  return 2
}

export const confidenceClass = (value: string): 'high' | 'medium' | 'low' => {
  if (value === '高') return 'high'
  if (value === '中') return 'medium'
  return 'low'
}
