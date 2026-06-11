import { defineManifest } from '@crxjs/vite-plugin'
import pkg from '../package.json' with { type: 'json' }

export default defineManifest({
  manifest_version: 3,
  name: 'StackPrism',
  description: 'StackPrism 用于检测网页前端、后端、CDN、SaaS、广告营销、统计、登录、支付、网站程序和主题模板线索。',
  version: pkg.version,
  permissions: ['activeTab', 'scripting', 'tabs', 'storage', 'webRequest', 'webNavigation'],
  host_permissions: ['<all_urls>', 'http://*/*', 'https://*/*', 'http://127.0.0.1/*'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module'
  },
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/content-observer.ts'],
      run_at: 'document_idle'
    },
    {
      matches: ['http://127.0.0.1/*'],
      js: ['src/content/agent-bridge-client.ts'],
      run_at: 'document_idle'
    }
  ],
  action: {
    default_title: 'StackPrism',
    default_popup: 'src/ui/popup/index.html',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png'
    }
  },
  options_ui: {
    page: 'src/ui/settings/index.html',
    open_in_tab: true
  },
  web_accessible_resources: [
    {
      resources: ['rules/*', 'tech-links.json', 'injected/page-detector.iife.js', 'injected/page-source-search.iife.js'],
      matches: ['http://*/*', 'https://*/*']
    }
  ]
})
