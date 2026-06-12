<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>
          <a class="app-title-link" :href="REPOSITORY_URL" target="_blank" rel="noreferrer" @click="openRepository">栈棱镜</a>
          <span v-if="version" class="version-badge">v{{ version }}</span>
          <span
            v-if="agentBridgeEnabled"
            class="agent-bridge-badge"
            :class="{ warning: state.settings.agentBridgeAllowAllNetworkTargets }"
            :title="agentBridgeBadgeTitle"
            :aria-label="agentBridgeBadgeTitle"
          >
            <Bot :size="12" :stroke-width="2.2" />
            <span>{{ agentBridgeBadgeLabel }}</span>
          </span>
        </h1>
        <p class="url">{{ pageUrl }}</p>
      </div>
      <div class="actions">
        <RippleButton class="icon-btn" :title="`主题：${themeLabel(theme)}（点击切换）`" @click="toggleTheme">
          <Sun v-if="theme === 'light'" :size="16" :stroke-width="2" />
          <Moon v-else-if="theme === 'dark'" :size="16" :stroke-width="2" />
          <Monitor v-else :size="16" :stroke-width="2" />
        </RippleButton>
        <RippleButton class="icon-btn" title="打开设置页" @click="openSettings">
          <Settings2 :size="16" :stroke-width="2" />
        </RippleButton>
        <RippleButton class="icon-btn" title="复制当前页 URL" @click="copyResult">
          <Copy :size="16" :stroke-width="2" />
        </RippleButton>
        <RippleButton class="icon-btn refresh-btn" title="重新检测" @click="runDetection({ force: true })">
          <RefreshCw :size="16" :stroke-width="2" />
        </RippleButton>
      </div>
    </header>

    <div v-if="!state.pageSupported" class="unsupported">
      <Ban class="empty-icon" :size="36" :stroke-width="1.5" />
      <h2>当前页面不支持检测</h2>
      <p>{{ unsupportedReason }}</p>
      <p class="unsupported-hint">在普通网页（http:// 或 https://）上重新打开扩展即可。</p>
    </div>

    <template v-else>
      <Transition name="msg-fade">
        <div v-if="status.message" class="msg" :class="status.type" role="status" aria-live="polite">
          {{ status.message }}
        </div>
      </Transition>

      <div v-if="isLoading" class="loading">
        <Loader2 class="loading-spinner" :size="28" :stroke-width="1.8" />
        <p>正在读取后台缓存...</p>
      </div>

      <template v-else>
        <section class="summary" aria-label="检测概览">
          <RippleButton
            :class="['summary-tile', { active: state.activeCategory === FOCUS_CATEGORY && !footerPanel }]"
            title="返回重点列表"
            @click="focusTechnologyList"
          >
            <span>{{ animatedTotal }}</span>
            <label>技术</label>
          </RippleButton>
          <RippleButton
            :class="['summary-tile', { active: footerPanel === 'resources' }]"
            title="查看抓取到的资源列表"
            @click="openSummaryDetail('resources')"
          >
            <span>{{ animatedResource }}</span>
            <label>资源</label>
          </RippleButton>
          <RippleButton
            :class="['summary-tile', { active: footerPanel === 'headers' }]"
            title="查看主文档响应头"
            @click="openSummaryDetail('headers')"
          >
            <span>{{ animatedHeader }}</span>
            <label class="summary-label">
              响应头
              <Loader2 v-if="isDetecting" class="detection-spinner" :size="12" :stroke-width="2" />
            </label>
          </RippleButton>
        </section>

        <nav class="filter-bar" aria-label="技术分类过滤">
          <div class="segment" role="tablist">
            <RippleButton
              role="tab"
              :class="['segment-btn', { active: state.activeCategory === FOCUS_CATEGORY }]"
              :aria-selected="state.activeCategory === FOCUS_CATEGORY"
              @click="selectCategory(FOCUS_CATEGORY)"
            >
              <span>重点</span>
              <span class="segment-count">{{ focusCount }}</span>
            </RippleButton>
            <RippleButton
              role="tab"
              :class="['segment-btn', { active: state.activeCategory === '全部' }]"
              :aria-selected="state.activeCategory === '全部'"
              @click="selectCategory('全部')"
            >
              <span>全部</span>
              <span class="segment-count">{{ totalCount }}</span>
            </RippleButton>
          </div>
          <div class="filter-select">
            <Select v-model="categoryFilterValue" :options="categoryFilterOptions" placeholder="选择分类" />
          </div>
        </nav>

        <div ref="sectionsScroller" class="sections-scroller" @scroll="onSectionsScroll">
          <Transition name="sections-fade" mode="out-in">
            <section :key="`${state.activeCategory}|${filteredSections.length ? 'd' : 'e'}`" class="sections">
              <div v-if="!state.result?.technologies?.length" class="empty">
                <SearchX class="empty-icon" :size="32" :stroke-width="1.5" />
                <p>未检测到明确技术线索</p>
                <p class="empty-hint">刷新页面后重新打开插件，以便捕获主文档响应头。</p>
              </div>
              <div v-else-if="!filteredSections.length" class="empty">
                <Inbox class="empty-icon" :size="28" :stroke-width="1.5" />
                <p>当前分类没有检测结果</p>
              </div>
              <section v-for="group in filteredSections" :key="group.category" class="category">
                <h2>
                  <span>{{ group.category }}</span>
                  <span class="count">{{ group.items.length }} 项</span>
                </h2>
                <div class="tech-grid">
                  <button
                    v-for="tech in group.items"
                    :key="`${tech.name}|${tech.category}`"
                    type="button"
                    class="tech-row"
                    :title="`查看 ${tech.name} 详情`"
                    @click="openTechDetail(tech)"
                  >
                    <TechChip :name="tech.name" :url="tech.url" />
                    <span class="tech-row-name">
                      {{ tech.name }}
                      <span v-if="tech.version" class="tech-row-version">{{ tech.version }}</span>
                    </span>
                  </button>
                </div>
              </section>
            </section>
          </Transition>
        </div>

        <Transition name="scroll-top-fade">
          <RippleButton v-show="showScrollTop" class="scroll-top" title="返回顶部" @click="scrollSectionsTop">
            <ArrowUp :size="16" :stroke-width="2" />
          </RippleButton>
        </Transition>
      </template>
    </template>

    <Transition name="footer-mask">
      <div v-if="footerPanel" class="footer-mask" aria-hidden="true" @click="closeFooterPanel" />
    </Transition>

    <Transition name="footer-panel">
      <section v-if="footerPanel" class="footer-panel" :aria-label="footerPanelTitle">
        <header class="footer-panel-head">
          <span class="footer-panel-title">{{ footerPanelTitle }}</span>
          <div class="footer-panel-actions">
            <RippleButton v-if="footerPanel === 'raw'" class="footer-panel-copy" title="下载原始线索" @click="downloadRawOutput">
              <Download :size="12" :stroke-width="2" />
            </RippleButton>
            <RippleButton v-if="footerPanel === 'raw'" class="footer-panel-copy" title="复制原始线索" @click="copyRawOutput">
              <Copy :size="12" :stroke-width="2" />
            </RippleButton>
            <RippleButton class="footer-panel-close" title="关闭面板" @click="closeFooterPanel">
              <X :size="14" :stroke-width="2" />
            </RippleButton>
          </div>
        </header>
        <div v-if="footerPanel === 'search'" class="footer-panel-body">
          <div class="search-row">
            <Input v-model="search.query" type="search" placeholder="输入关键词或正则表达式" @keydown="onSearchKeydown" />
            <RippleButton @click="searchPageSourceFromPopup">搜索</RippleButton>
          </div>
          <div class="search-options">
            <label>
              <Checkbox v-model="search.caseSensitive" />
              区分大小写
            </label>
            <label>
              <Checkbox v-model="search.wholeWord" />
              全字匹配
            </label>
            <label>
              <Checkbox v-model="search.useRegex" />
              正则表达式
            </label>
          </div>
          <div class="search-meta">{{ search.meta }}</div>
          <pre v-if="search.output" class="search-output">{{ search.output }}</pre>
        </div>
        <div v-else-if="footerPanel === 'raw'" class="footer-panel-body">
          <pre>{{ rawOutputText }}</pre>
        </div>
        <div v-else-if="footerPanel === 'resources'" class="footer-panel-body detail-body">
          <div v-if="detailLoading" class="detail-empty">正在加载...</div>
          <div v-else-if="!detailResources.length" class="detail-empty">未抓取到资源。</div>
          <ul v-else class="resource-list">
            <li v-for="url in detailResources" :key="url">
              <button type="button" class="resource-link" :title="url" @click="openResourceLink(url)">
                <ExternalLink class="resource-link-icon" :size="11" :stroke-width="2" />
                <span>{{ url }}</span>
              </button>
            </li>
          </ul>
        </div>
        <div v-else-if="footerPanel === 'headers'" class="footer-panel-body detail-body">
          <div v-if="detailLoading" class="detail-empty">正在加载...</div>
          <div v-else-if="!Object.keys(detailHeaders).length" class="detail-empty">没有主文档响应头数据；可点击"刷新"重新抓取。</div>
          <dl v-else class="header-list">
            <template v-for="(value, key) in detailHeaders" :key="key">
              <dt>{{ key }}</dt>
              <dd>{{ value }}</dd>
            </template>
          </dl>
        </div>
        <div v-else-if="footerPanel === 'tech' && selectedTech" class="footer-panel-body tech-detail-body">
          <div class="tech-detail-head">
            <TechChip :name="selectedTech.name" :url="selectedTech.url" large />
            <div class="tech-detail-meta">
              <span class="tech-detail-category">{{ selectedTech.category }}</span>
              <span class="tech-detail-name">{{ selectedTech.name }}</span>
            </div>
            <span :class="['confidence', confidenceClass(selectedTech.confidence)]">{{ selectedTech.confidence }}置信度</span>
          </div>
          <button
            v-if="selectedTech.url"
            type="button"
            class="tech-detail-link"
            :title="`打开 ${selectedTech.name} 官网或仓库`"
            @click="openTechnologyLink(selectedTech)"
          >
            <ExternalLink :size="12" :stroke-width="2" />
            <span>{{ selectedTech.url }}</span>
          </button>
          <section v-if="selectedTech.evidence?.length" class="tech-detail-section">
            <h3>识别依据</h3>
            <ul class="tech-detail-evidence">
              <li v-for="(ev, i) in selectedTech.evidence" :key="i">{{ ev }}</li>
            </ul>
          </section>
          <section v-if="selectedTech.sources?.length" class="tech-detail-section">
            <h3>来源(点击查看原始数据)</h3>
            <div class="tech-detail-sources">
              <button
                v-for="src in selectedTech.sources"
                :key="src"
                type="button"
                class="tech-detail-source"
                :title="`查看 ${src} 来源的原始数据`"
                @click="openSourceRaw(selectedTech, src)"
              >
                {{ src }}
              </button>
            </div>
          </section>
          <button
            type="button"
            class="tech-detail-correction"
            title="打开 GitHub 议题并自动填写这条识别结果"
            @click="openCorrectionIssue(selectedTech)"
          >
            <Flag :size="12" :stroke-width="2" />
            <span>识别不准确，点击纠正</span>
          </button>
        </div>
      </section>
    </Transition>

    <footer class="app-footer">
      <div class="footer-tools">
        <RippleButton
          :class="['footer-tool-btn', { active: footerPanel === 'search' }]"
          title="网页源代码搜索"
          @click="toggleFooterPanel('search')"
        >
          <Search :size="13" :stroke-width="2" />
          <span>搜索</span>
        </RippleButton>
        <RippleButton
          :class="['footer-tool-btn', { active: footerPanel === 'raw' }]"
          title="查看原始线索"
          @click="toggleFooterPanel('raw')"
        >
          <FileCode :size="13" :stroke-width="2" />
          <span>原始线索</span>
        </RippleButton>
        <RippleButton class="footer-tool-btn" title="复制全部技术栈报告" @click="copyTechStackReport">
          <ClipboardList :size="13" :stroke-width="2" />
          <span>复制全部</span>
        </RippleButton>
      </div>
      <a class="footer-repo" :href="REPOSITORY_URL" target="_blank" rel="noreferrer" @click="openRepository">GitHub</a>
    </footer>
  </main>
</template>

<script setup lang="ts">
  import { onMounted, onBeforeUnmount, reactive, ref, computed, watch, type Ref } from 'vue'
  import {
    ArrowUp,
    Ban,
    Bot,
    ClipboardList,
    Copy,
    Download,
    ExternalLink,
    FileCode,
    Flag,
    Inbox,
    Loader2,
    Monitor,
    Moon,
    RefreshCw,
    Search,
    SearchX,
    Settings2,
    Sun,
    X
  } from 'lucide-vue-next'
  import Select from '@/ui/components/Select.vue'
  import Checkbox from '@/ui/components/Checkbox.vue'
  import Input from '@/ui/components/Input.vue'
  import RippleButton from '@/ui/components/RippleButton.vue'
  import TechChip from '@/ui/components/TechChip.vue'
  import { categoryIndex, confidenceClass, confidenceRank } from '@/utils/category-order'
  import { applyCustomCss } from '@/utils/apply-custom-css'
  import { normalizeSettings, normalizeSettingsWithLocalOptIn } from '@/utils/normalize-settings'
  import { buildCorrectionIssueUrl } from '@/utils/build-issue-url'
  import {
    CACHE_REFRESH_DELAYS,
    FOCUS_CATEGORY,
    REPOSITORY_URL,
    RAW_PLACEHOLDER,
    SETTINGS_STORAGE_KEY,
    STATUS_HIDE_DELAY
  } from '@/utils/constants'
  import { cycleTheme, getStoredTheme, setStoredTheme, themeLabel, type ThemeMode } from '@/utils/theme'
  import { checkPageSupport } from '@/utils/page-support'
  import { formatTechStackReport } from '@/utils/format-tech-stack'

  const RAW_LOADING_TEXT = '正在请求原始线索...'

  const state = reactive({
    result: null as any,
    rawResult: null as any,
    rawLoaded: false,
    activeCategory: FOCUS_CATEGORY as string,
    currentTabId: 0,
    settings: normalizeSettings(),
    cacheRefreshTimer: 0,
    pageSupported: true
  })

  const status = reactive({ message: '', type: '' as 'ok' | 'error' | '' })
  let statusTimer = 0
  const pageUrl = ref('正在检测当前标签页...')
  const unsupportedReason = ref('')
  const version = ref('')
  const isLoading = ref(true)
  const isDetecting = computed(() => isLoading.value || Boolean(state.cacheRefreshTimer))
  const search = reactive({
    query: '',
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
    meta: '搜索当前页面 DOM 源码快照。',
    output: ''
  })
  const rawOutputText = ref(RAW_PLACEHOLDER)
  const theme = ref<ThemeMode>('auto')
  const footerPanel = ref<'search' | 'raw' | 'resources' | 'headers' | 'tech' | null>(null)
  const rawSourceContext = ref<{ tech: any; source: string } | null>(null)
  const selectedTech = ref<any>(null)
  const sectionsScroller = ref<HTMLElement | null>(null)
  const showScrollTop = ref(false)
  const detailLoading = ref(false)
  const detailResources = ref<string[]>([])
  const detailHeaders = ref<Record<string, string>>({})

  const rawPanelTitle = computed(() => {
    if (footerPanel.value !== 'raw') return ''
    const ctx = rawSourceContext.value
    if (!ctx) return '原始线索'
    return `原始线索 - ${ctx.tech?.name || ''} - ${ctx.source}`
  })

  const footerPanelTitle = computed(() => {
    if (footerPanel.value === 'search') return '网页源代码搜索'
    if (footerPanel.value === 'raw') return rawPanelTitle.value
    if (footerPanel.value === 'resources') return `资源列表（${detailResources.value.length}）`
    if (footerPanel.value === 'headers') return `响应头（${Object.keys(detailHeaders.value).length}）`
    if (footerPanel.value === 'tech') return selectedTech.value?.name || '技术详情'
    return ''
  })

  const openTechDetail = (tech: any) => {
    selectedTech.value = tech
    rawSourceContext.value = null
    footerPanel.value = 'tech'
  }

  const toggleFooterPanel = (name: 'search' | 'raw') => {
    if (footerPanel.value === name && !rawSourceContext.value) {
      footerPanel.value = null
      return
    }
    rawSourceContext.value = null
    footerPanel.value = name
    if (name === 'raw') {
      renderRawOutput().catch(() => {})
    }
  }

  const closeFooterPanel = () => {
    footerPanel.value = null
    rawSourceContext.value = null
  }

  const openSourceRaw = (tech: any, source: string) => {
    rawSourceContext.value = { tech, source }
    footerPanel.value = 'raw'
    renderRawOutput().catch(() => {})
  }

  const loadDetailFromRaw = async () => {
    detailLoading.value = true
    try {
      const raw = state.rawResult || (state.currentTabId ? await requestPopupRawResult(state.currentTabId) : null)
      if (raw && !state.rawResult) {
        state.rawResult = raw
        state.rawLoaded = true
      }
      detailResources.value = Array.isArray(raw?.resources?.all) ? raw.resources.all : []
      detailHeaders.value = raw?.headers && typeof raw.headers === 'object' ? raw.headers : {}
    } catch {
      detailResources.value = []
      detailHeaders.value = {}
    } finally {
      detailLoading.value = false
    }
  }

  const openSummaryDetail = (kind: 'resources' | 'headers') => {
    if (footerPanel.value === kind) {
      footerPanel.value = null
      return
    }
    rawSourceContext.value = null
    footerPanel.value = kind
    loadDetailFromRaw().catch(() => {})
  }

  const openResourceLink = (url: string) => {
    if (!url) return
    chrome.tabs.create({ url })
  }

  const onSectionsScroll = (event: Event) => {
    const target = event.currentTarget as HTMLElement
    showScrollTop.value = target.scrollTop > 240
  }

  const scrollSectionsTop = () => {
    sectionsScroller.value?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const toggleTheme = async () => {
    const next = cycleTheme(theme.value)
    theme.value = next
    await setStoredTheme(next)
  }

  const setStatus = (message: string, type: '' | 'ok' | 'error' = '') => {
    status.message = message
    status.type = type
    if (statusTimer) {
      clearTimeout(statusTimer)
      statusTimer = 0
    }
    if (message) {
      statusTimer = window.setTimeout(() => {
        status.message = ''
        status.type = ''
        statusTimer = 0
      }, STATUS_HIDE_DELAY)
    }
  }

  const showError = (message: string) => {
    setStatus(message, 'error')
    state.result = null
  }

  const headerCount = computed(() => {
    if (!state.result) return 0
    if (typeof state.result.headerCount === 'number') return state.result.headerCount
    const headers = state.result.headers
    if (Array.isArray(headers)) return headers.length
    return Object.keys(headers || {}).length
  })

  const totalCount = computed(() => state.result?.technologies?.length ?? 0)
  const resourceCount = computed(() => state.result?.resources?.total ?? 0)

  const useAnimatedCounter = (target: Ref<number>, duration = 480) => {
    const display = ref(target.value || 0)
    let frame = 0
    watch(target, newVal => {
      const start = display.value
      const end = Number(newVal) || 0
      if (start === end) {
        display.value = end
        return
      }
      if (frame) cancelAnimationFrame(frame)
      const startTime = performance.now()
      const tick = (now: number) => {
        const progress = Math.min((now - startTime) / duration, 1)
        const eased = 1 - Math.pow(1 - progress, 3)
        display.value = Math.round(start + (end - start) * eased)
        if (progress < 1) {
          frame = requestAnimationFrame(tick)
        } else {
          display.value = end
          frame = 0
        }
      }
      frame = requestAnimationFrame(tick)
    })
    return display
  }

  const animatedTotal = useAnimatedCounter(totalCount)
  const animatedResource = useAnimatedCounter(resourceCount)
  const animatedHeader = useAnimatedCounter(headerCount)
  const agentBridgeEnabled = computed(() => state.settings.agentBridgeEnabled === true)
  const agentBridgeBadgeLabel = computed(() => (state.settings.agentBridgeAllowAllNetworkTargets ? '网络放开' : 'Bridge 开启'))
  const agentBridgeBadgeTitle = computed(() =>
    state.settings.agentBridgeAllowAllNetworkTargets ? 'Agent Bridge 已开启，所有网络目标已放开' : 'Agent Bridge 已开启'
  )

  const focusCount = computed(() => {
    if (!state.result?.technologies?.length) return 0
    return getFocusTechnologies(state.result.technologies).length
  })

  const groupedTechnologies = computed(() => {
    const result = state.result
    if (!result?.technologies) return {}
    return result.technologies.reduce((acc: any, item: any) => {
      if (!acc[item.category]) acc[item.category] = []
      acc[item.category].push(item)
      return acc
    }, {})
  })

  const tabItems = computed(() => {
    const result = state.result
    if (!result?.technologies) return []
    const grouped = groupedTechnologies.value
    const categories = Object.keys(grouped).sort((a, b) => categoryIndex(a) - categoryIndex(b))
    return categories.map(category => ({ category, count: grouped[category].length }))
  })

  const categoryFilterOptions = computed(() =>
    tabItems.value.map(item => ({ value: item.category, label: `${item.category} - ${item.count}` }))
  )

  const categoryFilterValue = computed({
    get: () => {
      const cat = state.activeCategory
      if (cat === FOCUS_CATEGORY || cat === '全部') return ''
      return cat
    },
    set: value => {
      if (!value) {
        state.activeCategory = FOCUS_CATEGORY
        return
      }
      if (value !== FOCUS_CATEGORY && value !== '全部') {
        state.activeCategory = value
      }
    }
  })

  const filteredSections = computed(() => {
    const result = state.result
    if (!result?.technologies?.length) return []
    const filtered = getFilteredTechnologies(result)
    const grouped = filtered.reduce((acc: any, item: any) => {
      if (!acc[item.category]) acc[item.category] = []
      acc[item.category].push(item)
      return acc
    }, {})
    return Object.keys(grouped)
      .sort((a, b) => categoryIndex(a) - categoryIndex(b))
      .map(category => ({ category, items: grouped[category] }))
  })

  const getFocusTechnologies = (technologies: any[]) => {
    const high = technologies.filter(tech => tech.confidence === '高')
    if (high.length) return high.slice(0, 60)
    return [...technologies].sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence)).slice(0, 30)
  }

  const getFilteredTechnologies = (result: any) => {
    if (state.activeCategory === FOCUS_CATEGORY) return getFocusTechnologies(result.technologies)
    if (state.activeCategory === '全部') return result.technologies
    return result.technologies.filter((tech: any) => tech.category === state.activeCategory)
  }

  const loadSettings = async () => {
    try {
      const [stored, local] = await Promise.all([
        chrome.storage.sync.get(SETTINGS_STORAGE_KEY).catch(() => ({}) as Record<string, unknown>),
        chrome.storage.local.get(SETTINGS_STORAGE_KEY).catch(() => ({}) as Record<string, unknown>)
      ])
      return normalizeSettingsWithLocalOptIn(stored[SETTINGS_STORAGE_KEY], local[SETTINGS_STORAGE_KEY])
    } catch {
      return normalizeSettings()
    }
  }

  const emptyPopupResult = (tab: any = {}) => {
    return {
      url: tab.url || '',
      title: tab.title || '',
      generatedAt: new Date().toISOString(),
      updatedAt: 0,
      technologies: [],
      counts: { total: 0, high: 0, medium: 0, low: 0 },
      categoryCounts: {},
      resources: { total: 0 },
      headerCount: 0
    }
  }

  const requestPopupResult = async (tabId: number) => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_POPUP_RESULT', tabId })
    if (!response?.ok) throw new Error(response?.error || '后台没有返回结果')
    return response
  }

  const requestPopupRawResult = async (tabId: number) => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_POPUP_RAW_RESULT', tabId })
    if (!response?.ok) throw new Error(response?.error || '后台没有返回原始线索')
    return response.data || {}
  }

  const requestBackgroundDetection = (tabId: number) => {
    chrome.runtime.sendMessage({ type: 'START_BACKGROUND_DETECTION', tabId }).catch(() => {})
  }

  const clearCacheRefreshTimer = () => {
    if (state.cacheRefreshTimer) {
      clearTimeout(state.cacheRefreshTimer)
      state.cacheRefreshTimer = 0
    }
  }

  const scheduleCachedResultRefresh = (tabId: number, previousUpdatedAt: number, attempt: number) => {
    clearCacheRefreshTimer()
    if (attempt >= CACHE_REFRESH_DELAYS.length) return
    state.cacheRefreshTimer = window.setTimeout(() => {
      state.cacheRefreshTimer = 0
      refreshCachedResultIfReady(tabId, previousUpdatedAt, attempt).catch(() => {})
    }, CACHE_REFRESH_DELAYS[attempt])
  }

  const refreshCachedResultIfReady = async (tabId: number, previousUpdatedAt: number, attempt: number) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || tab.id !== tabId) return

    const response = await requestPopupResult(tabId)
    const updatedAt = Number(response.updatedAt || response.data?.updatedAt || 0)
    if (response.hasCache && updatedAt && updatedAt !== previousUpdatedAt) {
      const result = response.data || emptyPopupResult(tab)
      state.result = result
      state.activeCategory = FOCUS_CATEGORY
      resetRawState()
      setStatus('')
      return
    }

    scheduleCachedResultRefresh(tabId, previousUpdatedAt, attempt + 1)
  }

  const markUnsupportedPage = (url: string, reason: string) => {
    state.pageSupported = false
    state.result = null
    unsupportedReason.value = reason
    pageUrl.value = url || '当前标签页'
    setStatus('')
    clearCacheRefreshTimer()
  }

  const loadCachedDetection = async () => {
    state.result = null
    isLoading.value = true
    clearCacheRefreshTimer()

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !tab.id) {
      isLoading.value = false
      showError('无法读取当前标签页。')
      return
    }

    const support = checkPageSupport(tab.url || '')
    if (!support.supported) {
      isLoading.value = false
      markUnsupportedPage(tab.url || '', support.reason)
      return
    }

    state.pageSupported = true
    pageUrl.value = tab.url || '当前标签页'
    state.currentTabId = tab.id
    setStatus('')

    try {
      state.settings = state.settings || (await loadSettings())
      applyCustomCss(state.settings.customCss)
      const response = await requestPopupResult(tab.id)
      const result = response.data || emptyPopupResult(tab)

      state.result = result
      state.activeCategory = FOCUS_CATEGORY
      isLoading.value = false

      if (!response.hasCache) {
        setStatus('还没有后台缓存，已请求后台检测；稍后会自动读取新结果，也可以点击"刷新"立即检测。')
        requestBackgroundDetection(tab.id)
        scheduleCachedResultRefresh(tab.id, response.updatedAt || 0, 0)
        return
      }

      if (response.stale) {
        setStatus('后台正在更新缓存，当前结果可先使用。')
        requestBackgroundDetection(tab.id)
        scheduleCachedResultRefresh(tab.id, response.updatedAt || 0, 0)
        return
      }

      setStatus('检测结果已加载。', 'ok')
    } catch (error: any) {
      isLoading.value = false
      showError(`读取后台缓存失败：${String(error?.message || error)}`)
    }
  }

  const runDetection = async ({ force = false } = {}) => {
    clearCacheRefreshTimer()

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !tab.id) {
      showError('无法读取当前标签页。')
      return
    }

    const support = checkPageSupport(tab.url || '')
    if (!support.supported) {
      markUnsupportedPage(tab.url || '', support.reason)
      return
    }

    state.pageSupported = true
    setStatus(force ? '已请求后台重新检测，当前结果可先使用。' : '已请求后台检测。', 'ok')
    pageUrl.value = tab.url || '当前标签页'
    state.currentTabId = tab.id

    const previousUpdatedAt = Number(state.result?.updatedAt || 0)
    requestBackgroundDetection(tab.id)
    scheduleCachedResultRefresh(tab.id, previousUpdatedAt, 0)
  }

  const selectCategory = (category: string) => {
    state.activeCategory = category
  }

  const focusTechnologyList = () => {
    closeFooterPanel()
    state.activeCategory = FOCUS_CATEGORY
    sectionsScroller.value?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const openTechnologyLink = (tech: any) => {
    if (!tech.url) return
    chrome.tabs.create({ url: tech.url })
  }

  const openCorrectionIssue = async (tech: any) => {
    let rawCopied = false
    try {
      let raw: any = state.rawResult
      if (!raw && state.currentTabId) {
        raw = await requestPopupRawResult(state.currentTabId)
        if (raw) {
          state.rawResult = raw
          state.rawLoaded = true
        }
      }
      if (raw) {
        await navigator.clipboard.writeText(JSON.stringify(raw, null, 2))
        rawCopied = true
      }
    } catch {
      rawCopied = false
    }
    const ctx = {
      url: state.result?.url || '',
      title: state.result?.title || '',
      generatedAt: state.result?.generatedAt || '',
      version: chrome.runtime.getManifest?.()?.version || '',
      rawCopied
    }
    if (rawCopied) {
      setStatus('完整原始线索已复制到剪贴板，跳转后可直接粘贴到议题中。', 'ok')
    }
    chrome.tabs.create({ url: buildCorrectionIssueUrl(tech, ctx) })
  }

  const openSettings = () => {
    const settingsPage = chrome.runtime.getManifest().options_ui?.page
    const url = chrome.runtime.getURL(settingsPage || 'src/ui/settings/index.html')
    chrome.tabs.create({ url })
  }

  const openRepository = (event: Event) => {
    event.preventDefault()
    chrome.tabs.create({ url: REPOSITORY_URL })
  }

  const copyResult = async () => {
    const url = (state.result as any)?.url || pageUrl.value
    if (!url || url === '正在检测当前标签页...') {
      setStatus('暂无可复制的当前页 URL。', 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(String(url))
      setStatus('已复制当前页 URL。', 'ok')
    } catch (error: any) {
      setStatus(`复制失败：${String(error?.message || error)}`, 'error')
    }
  }

  const copyRawOutput = async () => {
    const text = rawOutputText.value
    if (!text || text === RAW_PLACEHOLDER || text === RAW_LOADING_TEXT) {
      setStatus('暂无可复制的原始线索。', 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setStatus('已复制原始线索。', 'ok')
    } catch (error: any) {
      setStatus(`复制失败：${String(error?.message || error)}`, 'error')
    }
  }

  const copyTechStackReport = async () => {
    const result = state.result
    if (!result) {
      setStatus('暂无可复制的技术栈信息。', 'error')
      return
    }
    if (!navigator.clipboard?.writeText) {
      setStatus('当前浏览器不支持直接复制技术栈报告。', 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(formatTechStackReport(result))
      setStatus('已复制完整技术栈报告。', 'ok')
    } catch (error: any) {
      setStatus(`复制失败：${String(error?.message || error)}`, 'error')
    }
  }

  const sanitizeFilenameSegment = (input: string) => {
    const cleaned = String(input || '')
      .trim()
      .replace(/[\s/\\:*?"<>|]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return cleaned.slice(0, 64)
  }

  const buildRawDownloadFilename = () => {
    let host = 'page'
    try {
      const target = state.result?.url || state.rawResult?.url || ''
      if (target) host = new URL(target).hostname.replace(/^www\./, '')
    } catch {
      // ignore parse error, fall back to default host
    }
    const ctx = rawSourceContext.value
    const parts = ['stackprism', host || 'page']
    if (ctx) {
      const techPart = sanitizeFilenameSegment(ctx.tech?.name || '')
      const sourcePart = sanitizeFilenameSegment(ctx.source || '')
      if (techPart) parts.push(techPart)
      if (sourcePart) parts.push(sourcePart)
    }
    parts.push(new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, ''))
    return `${parts.filter(Boolean).join('_')}.json`
  }

  const downloadRawOutput = () => {
    const text = rawOutputText.value
    if (!text || text === RAW_PLACEHOLDER || text === RAW_LOADING_TEXT) {
      setStatus('暂无可下载的原始线索。', 'error')
      return
    }
    try {
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = buildRawDownloadFilename()
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      setStatus(rawSourceContext.value ? '已下载来源详情。' : '已下载完整原始线索。', 'ok')
    } catch (error: any) {
      setStatus(`下载失败：${String(error?.message || error)}`, 'error')
    }
  }

  const getRawResult = async () => {
    if (state.rawLoaded) return state.rawResult
    const tabId = state.currentTabId || (await getActiveTabId())
    const raw = await requestPopupRawResult(tabId)
    state.rawResult = raw
    state.rawLoaded = true
    return raw
  }

  const getActiveTabId = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !tab.id) throw new Error('无法读取当前标签页。')
    const support = checkPageSupport(tab.url || '')
    if (!support.supported) throw new Error(support.reason)
    state.currentTabId = tab.id
    return tab.id
  }

  const buildScopedRawJson = (raw: any, tech: any, source: string) => {
    const techName = String(tech?.name || '').toLowerCase()
    const matchTech = (item: any) => String(item?.name || '').toLowerCase() === techName
    const trimmed = String(source || '').trim()
    const isHeaderApi = /(?:-|\u00b7)\s*api/i.test(trimmed)
    const isHeaderFrame = /(?:-|\u00b7)\s*iframe/i.test(trimmed)
    const isDynamic = trimmed.startsWith('动态监控')
    const isBundle = trimmed.startsWith('JS 版权注释')
    const isHeader = !isHeaderApi && !isHeaderFrame && trimmed.startsWith('响应头')

    // 响应头无论 source 是哪个都带上：spoof 场景下排查时方便交叉对照
    const baseInfo = {
      url: raw?.url || '',
      title: raw?.title || '',
      technology: tech?.name || '',
      source: trimmed,
      headers: raw?.headers || {}
    }

    if (isHeader) {
      return {
        ...baseInfo,
        technologies: (raw?.technologies || []).filter(matchTech)
      }
    }

    if (isHeaderApi) {
      const records = (raw?.apiObservations || [])
        .map((rec: any) => ({ ...rec, technologies: (rec?.technologies || []).filter(matchTech) }))
        .filter((rec: any) => rec.technologies.length)
      return { ...baseInfo, apiObservations: records }
    }

    if (isHeaderFrame) {
      const records = (raw?.frameObservations || [])
        .map((rec: any) => ({ ...rec, technologies: (rec?.technologies || []).filter(matchTech) }))
        .filter((rec: any) => rec.technologies.length)
      return { ...baseInfo, frameObservations: records }
    }

    if (isDynamic) {
      const dyn = raw?.dynamicObservations || {}
      return {
        ...baseInfo,
        dynamicObservations: {
          ...dyn,
          technologies: (dyn?.technologies || []).filter(matchTech)
        }
      }
    }

    if (isBundle) {
      const bundle = raw?.bundleObservations || {}
      return {
        ...baseInfo,
        bundleObservations: {
          ...bundle,
          technologies: (bundle?.technologies || []).filter(matchTech)
        }
      }
    }

    return {
      ...baseInfo,
      technologies: (raw?.technologies || []).filter(matchTech)
    }
  }

  const resetRawState = () => {
    state.rawResult = null
    state.rawLoaded = false
    if (footerPanel.value === 'raw') {
      void renderRawOutput()
    } else {
      rawOutputText.value = RAW_PLACEHOLDER
    }
  }

  const renderRawOutput = async () => {
    if (!state.result) {
      rawOutputText.value = '暂无原始线索。'
      return
    }
    rawOutputText.value = RAW_LOADING_TEXT
    try {
      const raw = await getRawResult()
      const ctx = rawSourceContext.value
      if (ctx) {
        rawOutputText.value = JSON.stringify(buildScopedRawJson(raw, ctx.tech, ctx.source), null, 2)
      } else {
        rawOutputText.value = JSON.stringify(raw, null, 2)
      }
    } catch (error: any) {
      rawOutputText.value = `原始线索生成失败：${String(error?.message || error)}`
    }
  }

  const onSearchKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      searchPageSourceFromPopup()
    }
  }

  const searchPageSourceFromPopup = async () => {
    const query = search.query
    if (!query) {
      search.meta = '请输入要搜索的内容。'
      search.output = ''
      return
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !tab.id) {
      search.meta = '无法读取当前标签页。'
      search.output = ''
      return
    }
    const support = checkPageSupport(tab.url || '')
    if (!support.supported) {
      search.meta = support.reason
      search.output = ''
      return
    }

    const options = {
      query,
      caseSensitive: search.caseSensitive,
      wholeWord: search.wholeWord,
      useRegex: search.useRegex
    }

    search.meta = '正在搜索当前页面 DOM 源码快照...'
    search.output = ''

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (opts: any) => {
          ;(window as any).__SP_SEARCH__ = opts
        },
        args: [options]
      })
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        files: ['injected/page-source-search.iife.js']
      })
      const result = injection?.result as any

      if (!result?.ok) {
        search.meta = result?.error || '搜索失败。'
        search.output = ''
        return
      }

      search.meta = `找到 ${result.totalMatchesText} 处匹配，源码长度 ${result.sourceLength.toLocaleString()} 字符。`
      search.output = formatSearchResult(result)
    } catch (error: any) {
      search.meta = `搜索失败：${String(error?.message || error)}`
      search.output = ''
    }
  }

  const formatSearchResult = (result: any) => {
    const lines = [
      `查询: ${result.query}`,
      `模式: ${describeSearchOptions(result.options)}`,
      `来源: ${result.sourceKind}`,
      `源码长度: ${result.sourceLength.toLocaleString()} 字符`,
      `匹配数量: ${result.totalMatchesText}`
    ]

    if (!result.snippets.length) {
      lines.push('', '未找到匹配。')
      return lines.join('\n')
    }
    if (result.truncated) lines.push(`只展示前 ${result.snippets.length} 条匹配上下文。`)

    lines.push('', '----------------------------------------')
    for (const snippet of result.snippets) {
      lines.push(
        `#${snippet.index} 行 ${snippet.line} 列 ${snippet.column} 字符位置 ${snippet.offset}`,
        snippet.preview,
        '----------------------------------------'
      )
    }
    return lines.join('\n')
  }

  const describeSearchOptions = (options: any) => {
    const parts: string[] = []
    parts.push(options.useRegex ? '正则表达式' : '普通文本')
    parts.push(options.caseSensitive ? '区分大小写' : '忽略大小写')
    if (options.wholeWord) parts.push('全字匹配')
    return parts.join(' / ')
  }

  const popupCacheSignature = (popup: any): string => {
    if (!popup || typeof popup !== 'object') return ''
    const counts = popup.counts || {}
    const resources = popup.resources || {}
    return [
      Number(popup.sourceUpdatedAt || popup.updatedAt || 0),
      Number(counts.total || popup.technologies?.length || 0),
      Number(counts.high || 0),
      Number(resources.total || 0),
      Number(popup.headerCount || 0)
    ].join('|')
  }

  const onStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
    if ((area === 'sync' || area === 'local') && SETTINGS_STORAGE_KEY in changes) {
      loadSettings()
        .then(settings => {
          state.settings = settings
          applyCustomCss(settings.customCss)
        })
        .catch(() => {})
    }
    if (area !== 'session' || !state.currentTabId) return
    const popupKey = `popup:${state.currentTabId}`
    if (!(popupKey in changes)) return
    const newPopup = changes[popupKey].newValue
    if (!newPopup || typeof newPopup !== 'object') return
    if (popupCacheSignature(newPopup) === popupCacheSignature(state.result)) return
    state.result = newPopup
    resetRawState()
    setStatus('')
  }

  onMounted(async () => {
    version.value = chrome.runtime.getManifest?.()?.version || ''
    theme.value = await getStoredTheme()
    state.settings = await loadSettings()
    applyCustomCss(state.settings.customCss)
    chrome.storage.onChanged.addListener(onStorageChange)
    await loadCachedDetection()
  })

  onBeforeUnmount(() => {
    clearCacheRefreshTimer()
    chrome.storage.onChanged.removeListener(onStorageChange)
  })
</script>

<style lang="scss">
  body {
    width: var(--popup-width);
    height: 600px;
    font-size: 13px;
    line-height: 1.45;
    overflow: hidden;
  }
</style>

<style lang="scss" scoped>
  // layout shell：flex column，整体高度 100vh，sections-scroller 独占滚动区
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 0;
    position: relative;
  }

  // topbar：flex 项，不再 fixed，自然占据顶部
  .topbar {
    align-items: flex-start;
    backdrop-filter: saturate(180%) blur(8px);
    background: var(--panel-translucent);
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    height: var(--popup-header-height);
    justify-content: space-between;
    margin: 0;
    padding: 12px 16px 8px;
    z-index: 20;

    > div:first-child {
      flex: 1 1 auto;
      min-width: 0;
    }
  }

  h1 {
    align-items: center;
    display: flex;
    flex-wrap: nowrap;
    font-size: 16px;
    font-weight: 600;
    gap: 8px;
    letter-spacing: 0;
    line-height: 1.2;
    margin: 0 0 4px;
  }

  .app-title-link {
    color: var(--text);
    min-width: 0;
    overflow: hidden;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;

    &:hover {
      color: var(--accent);
    }
  }

  .version-badge {
    color: var(--muted);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0;
  }

  .agent-bridge-badge {
    align-items: center;
    background: rgba(15, 118, 110, 0.1);
    border: 1px solid rgba(15, 118, 110, 0.28);
    border-radius: 999px;
    color: var(--accent);
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 700;
    gap: 4px;
    height: 22px;
    line-height: 1;
    padding: 0 8px;

    &.warning {
      background: #fff7ed;
      border-color: rgba(180, 83, 9, 0.28);
      color: #9a3412;
    }
  }

  :global(:root[data-theme='dark']) .agent-bridge-badge.warning {
    color: #fbbf24;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light'])) .agent-bridge-badge.warning {
      color: #fbbf24;
    }
  }

  .url {
    color: var(--muted);
    font-size: 12px;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    gap: 4px;
    white-space: nowrap;

    button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px;
      color: var(--muted);
      font-size: 12px;
      padding: 4px 7px;
      transition:
        background 0.15s ease,
        border-color 0.15s ease,
        color 0.15s ease;
      white-space: nowrap;

      &:hover {
        background: var(--accent-soft);
        color: var(--accent);
      }

      &.refresh-btn {
        background: rgba(15, 118, 110, 0.08);
        border-color: rgba(15, 118, 110, 0.2);
        color: var(--accent);
        font-weight: 600;

        &:hover {
          background: var(--accent-soft);
          border-color: rgba(15, 118, 110, 0.34);
          color: var(--accent);
        }
      }

      &.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #ffffff;
        font-weight: 500;

        &:hover {
          background: var(--accent-dark);
          color: #ffffff;
        }
      }
    }
  }

  .icon-btn {
    align-items: center;
    display: inline-flex;
    height: 28px;
    justify-content: center;
    padding: 0 !important;
    width: 28px;
  }

  // msg 浮动通知：与 settings 一致的悬浮提示
  .msg {
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    box-shadow: var(--shadow);
    color: var(--text);
    font-size: 12px;
    left: 50%;
    line-height: 1.5;
    max-height: min(48vh, 280px);
    max-width: calc(100% - 32px);
    overflow: auto;
    padding: 8px 12px;
    position: fixed;
    top: 16px;
    transform: translateX(-50%);
    white-space: pre-wrap;
    z-index: 50;

    &.ok {
      border-left-color: var(--ok);
    }

    &.error {
      border-left-color: var(--danger);
      color: var(--danger);
    }
  }

  .msg-fade-enter-from,
  .msg-fade-leave-to {
    opacity: 0;
    transform: translate(-50%, -8px);
  }

  .msg-fade-enter-active,
  .msg-fade-leave-active {
    transition:
      opacity 0.2s ease,
      transform 0.2s ease;
  }

  // summary：三个入口保持同一组控件感，active 只做轻量强调
  .summary {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-shrink: 0;
    gap: 6px;
    margin: 0;
    padding: 12px 16px;

    > div,
    .summary-tile {
      align-items: center;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--muted);
      cursor: pointer;
      display: flex;
      font: inherit;
      gap: 6px;
      margin: 0;
      min-height: 34px;
      padding: 5px 9px;
      text-align: left;
      transition:
        background 0.15s ease,
        border-color 0.15s ease,
        color 0.15s ease;
    }

    span {
      color: var(--text);
      font-size: 17px;
      font-variant-numeric: tabular-nums;
      font-weight: 600;
      line-height: 1;
    }

    > div:first-child span,
    .summary-tile:first-child span {
      color: var(--accent);
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0;
    }

    label {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.1;
    }
  }

  .summary-tile {
    &:hover {
      background: var(--accent-soft);
      border-color: rgba(15, 118, 110, 0.2);
    }

    &.active {
      background: var(--accent-soft);
      border-color: rgba(15, 118, 110, 0.28);
      box-shadow: inset 0 0 0 1px rgba(15, 118, 110, 0.08);
      color: var(--accent);

      span {
        color: var(--accent);
      }
    }
  }

  .summary-label {
    align-items: center;
    display: inline-flex;
    gap: 4px;
  }

  // filter-bar: left segment + right category select
  .filter-bar {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    margin: 0;
    padding: 12px 16px;
  }

  .segment {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    align-items: center;
    display: inline-flex;
    flex: 0 0 auto;
    min-height: 34px;
    padding: 2px;
  }

  .segment-btn {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 4px;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    font-size: 12px;
    gap: 6px;
    min-height: 28px;
    padding: 5px 10px;
    transition:
      background 0.15s ease,
      color 0.15s ease;

    &:hover:not(.active) {
      color: var(--text);
    }

    &.active {
      background: var(--panel);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
      color: var(--accent);
      font-weight: 600;

      .segment-count {
        color: var(--accent);
      }
    }
  }

  .segment-count {
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .filter-select {
    flex: 1 1 auto;
    min-width: 0;
  }

  // loading：spinner + 文字，等后台缓存返回时占位
  .loading {
    align-items: center;
    color: var(--muted);
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    font-size: 13px;
    gap: 12px;
    justify-content: center;
    padding: 32px 24px;

    p {
      margin: 0;
    }
  }

  .detection-spinner,
  .loading-spinner {
    animation: spin 0.9s linear infinite;
    color: var(--accent);
    flex-shrink: 0;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  // scroll-top：sections 滚动 > 240px 出现，固定在 sections 区域右下角
  .scroll-top {
    align-items: center;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 50%;
    bottom: calc(var(--popup-footer-height) + 12px);
    box-shadow: 0 4px 12px rgba(20, 35, 50, 0.1);
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    height: 32px;
    justify-content: center;
    padding: 0;
    position: absolute;
    right: 12px;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
    width: 32px;
    z-index: 18;

    &:hover {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
  }

  .scroll-top-fade-enter-active,
  .scroll-top-fade-leave-active {
    transition:
      opacity 0.18s ease,
      transform 0.18s ease;
  }

  .scroll-top-fade-enter-from,
  .scroll-top-fade-leave-to {
    opacity: 0;
    transform: scale(0.8) translateY(8px);
  }

  // sections transition for first data load and category switches
  .sections-fade-enter-active,
  .sections-fade-leave-active {
    transition:
      opacity 0.18s ease,
      transform 0.18s ease;
  }

  .sections-fade-enter-from {
    opacity: 0;
    transform: translateY(4px);
  }

  .sections-fade-leave-to {
    opacity: 0;
    transform: translateY(-2px);
  }

  // sections-scroller：唯一滚动容器，flex 1 占据剩余空间
  .sections-scroller {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px;
  }

  // sections：去 panel 化，标题 + 列表条目
  .sections {
    display: grid;
    gap: 16px;
  }

  .category h2 {
    align-items: baseline;
    color: var(--muted);
    display: flex;
    font-size: 11px;
    font-weight: 600;
    gap: 8px;
    justify-content: space-between;
    letter-spacing: 0.06em;
    margin: 0 0 4px;
    padding: 0 4px;
    text-transform: uppercase;
  }

  .count {
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
  }

  // 同类目里多个技术用 flex-wrap 排开:按内容宽度自然换行,密度更高
  .tech-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
  }

  // 单个技术 chip:色块图标 + 名字
  .tech-row {
    align-items: center;
    background: var(--panel);
    border: 1px solid transparent;
    border-radius: 5px;
    color: var(--text);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    gap: 6px;
    min-height: 28px;
    padding: 4px 8px;
    text-align: left;
    transition:
      background 0.15s ease,
      border-color 0.15s ease;

    &:hover {
      background: var(--accent-soft);
      border-color: rgba(15, 118, 110, 0.18);
    }

    &:focus-visible {
      background: var(--accent-soft);
      border-color: var(--accent);
      outline: none;
    }
  }

  .tech-row-name {
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tech-row-version {
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    font-weight: 400;
    margin-left: 4px;
  }

  // 详情面板里仍保留的彩色置信度徽章(详情视图里信息密度低,徽章撑得开)
  .confidence {
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
    padding: 1px 6px;
    white-space: nowrap;

    &.high {
      background: var(--confidence-high-bg);
      color: var(--confidence-high-text);
    }
    &.medium {
      background: var(--confidence-medium-bg);
      color: var(--confidence-medium-text);
    }
    &.low {
      background: var(--confidence-low-bg);
      color: var(--confidence-low-text);
    }
  }

  // tech-detail 面板:点击 .tech-row 后从底部滑上来,展示完整 evidence / sources / 纠错入口
  .tech-detail-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 16px 16px;
  }

  .tech-detail-head {
    align-items: center;
    display: flex;
    gap: 12px;
  }

  .tech-detail-meta {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .tech-detail-category {
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.02em;
  }

  .tech-detail-name {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tech-detail-link {
    align-items: center;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 5px;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: 11px;
    gap: 6px;
    overflow: hidden;
    padding: 6px 10px;
    text-overflow: ellipsis;
    transition:
      border-color 0.15s ease,
      color 0.15s ease;
    white-space: nowrap;

    span {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    &:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
  }

  .tech-detail-section {
    display: flex;
    flex-direction: column;
    gap: 6px;

    h3 {
      color: var(--muted);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.04em;
      margin: 0;
      text-transform: uppercase;
    }
  }

  .tech-detail-evidence {
    color: var(--text);
    font-size: 12px;
    line-height: 1.55;
    margin: 0;
    padding-left: 16px;

    li {
      margin: 2px 0;
      overflow-wrap: anywhere;
    }
  }

  .tech-detail-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .tech-detail-source {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    padding: 3px 8px;
    transition:
      border-color 0.15s ease,
      color 0.15s ease;

    &:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
  }

  .tech-detail-correction {
    align-items: center;
    align-self: flex-start;
    background: transparent;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    font-size: 11px;
    gap: 4px;
    margin-top: 2px;
    padding: 0;
    transition: color 0.15s ease;

    &:hover {
      color: var(--accent);
    }
  }

  .empty {
    align-items: center;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    font-size: 13px;
    gap: 4px;
    padding: 32px 12px 24px;
    text-align: center;

    p {
      margin: 0;
    }
  }

  .empty-hint {
    font-size: 12px;
    opacity: 0.75;
  }

  // 通用空状态图标：所有空 / 不支持页面共用
  .empty-icon {
    color: var(--muted);
    margin-bottom: 8px;
    opacity: 0.55;
  }

  // unsupported：当前页面（chrome:// / 扩展页 / about:）无法注入检测脚本
  .unsupported {
    align-items: center;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    justify-content: center;
    padding: 24px;
    text-align: center;

    h2 {
      color: var(--text);
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0;
      margin: 0 0 6px;
      text-transform: none;
    }

    p {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
      margin: 0;
      max-width: 28ch;
    }
  }

  .unsupported-hint {
    color: var(--muted);
    font-size: 12px;
    margin-top: 8px !important;
    opacity: 0.75;
  }

  // footer: toolbar layout, action buttons on the left and GitHub on the right
  .app-footer {
    align-items: center;
    backdrop-filter: saturate(180%) blur(8px);
    background: var(--panel-translucent);
    border-top: 1px solid var(--line);
    color: var(--muted);
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    justify-content: space-between;
    margin: 0;
    min-height: var(--popup-footer-height);
    padding: 6px 12px;
    z-index: 20;
  }

  .footer-tools {
    display: flex;
    gap: 4px;
  }

  .footer-tool-btn {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 5px;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    font-size: 12px;
    gap: 5px;
    padding: 5px 10px;
    transition:
      background 0.15s ease,
      color 0.15s ease;

    &:hover,
    &.active {
      background: var(--accent-soft);
      color: var(--accent);
    }

    &.active {
      font-weight: 500;
    }
  }

  .footer-repo {
    color: var(--muted);
    font-size: 11px;
    text-decoration: none;
    transition: color 0.15s ease;

    &:hover {
      color: var(--accent);
    }
  }

  // footer-mask：覆盖 topbar 与 app-footer 之间的主体内容，点击关闭面板
  .footer-mask {
    background: rgba(15, 23, 42, 0.32);
    bottom: var(--popup-footer-height);
    cursor: pointer;
    left: 0;
    position: absolute;
    right: 0;
    top: var(--popup-header-height);
    z-index: 18;
  }

  [data-theme='dark'] .footer-mask {
    background: rgba(0, 0, 0, 0.45);
  }

  .footer-mask-enter-from,
  .footer-mask-leave-to {
    opacity: 0;
  }

  .footer-mask-enter-active,
  .footer-mask-leave-active {
    transition: opacity 0.2s ease;
  }

  // footer-panel：从底部抽屉式滑出，相对 .shell 绝对定位在 footer 上方
  .footer-panel {
    background: var(--panel);
    border-top: 1px solid var(--line);
    bottom: var(--popup-footer-height);
    box-shadow: 0 -8px 24px rgba(20, 35, 50, 0.06);
    display: flex;
    flex-direction: column;
    left: 0;
    max-height: 60%;
    position: absolute;
    right: 0;
    z-index: 19;
  }

  .footer-panel-head {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-shrink: 0;
    justify-content: space-between;
    padding: 8px 12px;
  }

  .footer-panel-title {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .footer-panel-actions {
    display: inline-flex;
    flex-shrink: 0;
    gap: 4px;
  }

  .footer-panel-close,
  .footer-panel-copy {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 4px;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    height: 22px;
    justify-content: center;
    padding: 0;
    transition:
      background 0.15s ease,
      color 0.15s ease;
    width: 22px;

    &:hover {
      background: var(--accent-soft);
      color: var(--accent);
    }
  }

  .footer-panel-body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 12px;
  }

  .detail-body {
    font-size: 12px;
    padding: 8px 0;
  }

  .detail-empty {
    color: var(--muted);
    padding: 12px 16px;
  }

  .resource-list {
    list-style: none;
    margin: 0;
    padding: 0;

    li {
      border-bottom: 1px solid var(--line);

      &:last-child {
        border-bottom: 0;
      }
    }
  }

  .resource-link {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--text);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: 12px;
    gap: 6px;
    overflow: hidden;
    padding: 8px 16px;
    text-align: left;
    transition:
      background 0.15s ease,
      color 0.15s ease;
    width: 100%;

    &:hover {
      background: var(--accent-soft);
      color: var(--accent);

      .resource-link-icon {
        color: var(--accent);
      }
    }

    span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .resource-link-icon {
    color: var(--muted);
    flex-shrink: 0;
  }

  .header-list {
    display: grid;
    gap: 4px 12px;
    grid-template-columns: auto 1fr;
    margin: 0;
    padding: 4px 16px 12px;

    dt,
    dd {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
      padding-top: 4px;
      word-break: break-all;
    }

    dt {
      color: var(--muted);
      font-weight: 500;
    }

    dd {
      color: var(--text);
      margin: 0;
    }
  }

  .footer-panel-enter-active,
  .footer-panel-leave-active {
    transition:
      opacity 0.18s ease,
      transform 0.2s ease;
  }

  .footer-panel-enter-from,
  .footer-panel-leave-to {
    opacity: 0;
    transform: translateY(8px);
  }

  // 搜索 UI（footer-panel 内）
  .search-row {
    display: grid;
    gap: 6px;
    grid-template-columns: 1fr auto;

    input {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--text);
      min-width: 0;
      padding: 7px 10px;
      transition: border-color 0.15s ease;

      &:focus {
        border-color: var(--accent);
        outline: none;
      }
    }

    button {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      padding: 7px 14px;
      transition:
        border-color 0.15s ease,
        color 0.15s ease;

      &:hover {
        border-color: var(--accent);
        color: var(--accent);
      }
    }
  }

  .search-options {
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    font-size: 12px;
    gap: 12px;
    margin-top: 8px;

    label {
      align-items: center;
      cursor: pointer;
      display: inline-flex;
      gap: 5px;
    }
  }

  .search-meta {
    color: var(--muted);
    font-size: 11px;
    margin-top: 8px;
  }

  .search-output {
    margin-top: 8px;
  }

  pre {
    background: var(--code-bg);
    border-radius: 6px;
    color: var(--code-text);
    font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
    font-size: 11px;
    line-height: 1.5;
    margin: 8px 0 0;
    max-height: 260px;
    overflow: auto;
    padding: 10px 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
