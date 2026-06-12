import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'StackPrism',
  description: '网页技术栈检测扩展 · 使用文档',
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' }],
    ['meta', { name: 'theme-color', content: '#0f766e' }]
  ],
  themeConfig: {
    logo: '/icon.svg',
    nav: [
      { text: '使用指南', link: '/guide/' },
      { text: '配置指南', link: '/config/' },
      { text: '开发手册', link: '/dev/' },
      { text: 'GitHub', link: 'https://github.com/setube/stackprism' }
    ],
    sidebar: {
      '/guide/': [
        {
          text: '使用指南',
          items: [
            { text: '概述', link: '/guide/' },
            { text: '安装与启用', link: '/guide/install' },
            { text: '基本使用', link: '/guide/basic-usage' },
            { text: '结果解读', link: '/guide/results' },
            { text: '辅助工具', link: '/guide/tools' }
          ]
        }
      ],
      '/config/': [
        {
          text: '配置指南',
          items: [
            { text: '概述', link: '/config/' },
            { text: '识别开关', link: '/config/categories' },
            { text: '禁用指定技术', link: '/config/disabled-technologies' },
            { text: '自定义弹窗样式', link: '/config/custom-css' },
            { text: '自定义规则', link: '/config/custom-rules' },
            { text: '规则 JSON 导入导出', link: '/config/json-export' }
          ]
        }
      ],
      '/dev/': [
        {
          text: '开发手册',
          items: [
            { text: '概述', link: '/dev/' },
            { text: '架构概览', link: '/dev/architecture' },
            { text: 'Agent Bridge', link: '/dev/agent-bridge' },
            { text: '规则文件格式', link: '/dev/rule-format' },
            { text: '检测流程', link: '/dev/detection-flow' },
            { text: '贡献规则', link: '/dev/contribute-rules' },
            { text: '构建与发布', link: '/dev/release' }
          ]
        }
      ]
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/setube/stackprism' }],
    footer: {
      message: '基于 CC BY-NC-SA 4.0 协议发布',
      copyright: 'Copyright © 2026 StackPrism'
    },
    docFooter: {
      prev: '上一页',
      next: '下一页'
    },
    outline: {
      label: '本页目录',
      level: [2, 3]
    },
    lastUpdatedText: '最后更新',
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '回到顶部',
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            displayDetails: '显示详情',
            resetButtonTitle: '清除',
            backButtonTitle: '关闭',
            noResultsText: '没有结果',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
          }
        }
      }
    }
  }
})
