<template>
  <header class="help-header">
    <div class="help-header-inner">
      <div>
        <h1>
          StackPrism 使用说明
          <span v-if="version" class="version-badge">v{{ version }}</span>
        </h1>
        <p>这页专门讲怎么添加自己的识别规则。你可以把规则理解成一句话：看到什么字，就认为网页用了什么东西。</p>
      </div>
      <div class="header-actions">
        <RippleButton class="icon-btn primary" variant="primary" title="打开设置页" @click="openSettings">
          <Settings2 :size="16" :stroke-width="2" />
        </RippleButton>
        <RippleButton class="icon-btn" title="GitHub 仓库" @click="openRepo">
          <ExternalLink :size="16" :stroke-width="2" />
        </RippleButton>
      </div>
    </div>
  </header>
  <main class="help-shell">
    <section class="panel">
      <h2>先知道它在做什么</h2>
      <p>
        插件会看网页里出现的线索。比如网页代码里有
        <code>wp-content</code>
        ，大概率就是 WordPress；网页加载了
        <code>hm.baidu.com</code>
        ，大概率用了百度统计。
      </p>
      <p>你添加规则，就是告诉插件："以后看到这个字、这个网址、这个标签，就显示我指定的技术名称"。</p>
    </section>

    <section class="panel">
      <h2>Agent Bridge 是什么</h2>
      <p>
        它让本机 AI Agent 通过
        <code>127.0.0.1</code>
        读取当前浏览器 profile 里可观测的技术栈、页面结构、截图和体验摘要，用来复刻相似的网站体验。
      </p>
      <ul class="plain-list">
        <li>默认关闭，只在当前浏览器 profile 手动开启。</li>
        <li>只读采集，不读取 Cookie、Authorization、localStorage/sessionStorage 明文。</li>
        <li>网络限制默认收紧；放开所有网络目标会要求二次确认。</li>
      </ul>
    </section>

    <section class="panel">
      <h2>最快上手：五步添加一条规则</h2>
      <ol class="steps">
        <li>打开设置页，找到"自定义规则"。</li>
        <li>
          在"技术名称"里写你想显示的名字，比如
          <code>MyCMS</code>
          。
        </li>
        <li>
          在"分类"里选一个大类，比如
          <code>网站程序</code>
          。
        </li>
        <li>
          在"匹配规则"里写网页里会出现的字，一行写一个，比如
          <code>mycms</code>
          。
        </li>
        <li>点"添加规则"，再点页面右上角"保存设置"。回到目标网页刷新一下，就能测试。</li>
      </ol>
    </section>

    <section class="panel">
      <h2>每个输入框怎么填</h2>
      <div class="field-grid">
        <div>
          <h3>技术名称</h3>
          <p>
            最终显示在插件里的名字。比如
            <code>ExampleCMS</code>
            、
            <code>某某统计</code>
            、
            <code>某某支付</code>
            。
          </p>
        </div>
        <div>
          <h3>分类</h3>
          <p>放到哪个分组里。不会影响匹配，只影响结果显示在哪个 Tab 下。</p>
        </div>
        <div>
          <h3>类型说明</h3>
          <p>
            给自己看的补充说明。比如
            <code>CMS</code>
            、
            <code>第三方支付</code>
            、
            <code>开源统计</code>
            。
          </p>
        </div>
        <div>
          <h3>置信度</h3>
          <p>你有多确定。只要看到就能确定，选"高"；只是猜测，选"低"；拿不准就选"中"。</p>
        </div>
        <div>
          <h3>匹配方式</h3>
          <p>新手建议先选"关键词"。如果你会写更灵活的规则，再选"正则表达式"。</p>
        </div>
        <div>
          <h3>官网 / 仓库 URL</h3>
          <p>填了以后，检测结果里的技术名称可以点开官网或项目地址。没有就留空。</p>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>匹配范围怎么选</h2>
      <p>不用纠结，刚开始可以全选。等规则误报太多，再回来减少范围。</p>
      <div class="field-grid compact">
        <div>
          <h3>页面 URL</h3>
          <p>
            看当前网页地址。比如地址里出现
            <code>/shop/</code>
            。
          </p>
        </div>
        <div>
          <h3>资源 URL</h3>
          <p>
            看网页加载的脚本、图片、样式地址。比如
            <code>cdn.example.com/sdk.js</code>
            。
          </p>
        </div>
        <div>
          <h3>DOM / 源码</h3>
          <p>
            看网页最终显示出来的代码。适合找
            <code>data-xxx</code>
            、隐藏标签、页面里的特殊字。
          </p>
        </div>
        <div>
          <h3>响应头</h3>
          <p>
            看服务器返回的信息。比如
            <code>X-Generator: WordPress</code>
            。
          </p>
        </div>
        <div>
          <h3>动态资源</h3>
          <p>看你操作网页后新加载出来的东西。适合弹窗、登录、支付、聊天组件。</p>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>示例 1：识别一个网站程序</h2>
      <p>
        假设你发现某个网站程序叫 MyCMS，它的网页里经常出现
        <code>mycms</code>
        或
        <code>X-Generator: MyCMS</code>
        。
      </p>
      <div class="example">
        <dl>
          <dt>技术名称</dt>
          <dd>MyCMS</dd>
          <dt>分类</dt>
          <dd>网站程序</dd>
          <dt>类型说明</dt>
          <dd>CMS</dd>
          <dt>匹配方式</dt>
          <dd>关键词</dd>
          <dt>匹配规则</dt>
          <dd>
            <pre>
mycms
X-Generator: MyCMS</pre
            >
          </dd>
        </dl>
      </div>
      <p>
        解释：以后网页里只要出现
        <code>mycms</code>
        这个字，插件就会显示 MyCMS。
      </p>
    </section>

    <section class="panel">
      <h2>示例 2：识别 WordPress 主题</h2>
      <p>
        很多 WordPress 主题的地址长这样：
        <code>/wp-content/themes/主题名/</code>
        。如果你只想识别某个主题，可以这样写。
      </p>
      <div class="example">
        <dl>
          <dt>技术名称</dt>
          <dd>WordPress 主题: oceanwp</dd>
          <dt>分类</dt>
          <dd>主题 / 模板</dd>
          <dt>匹配方式</dt>
          <dd>关键词</dd>
          <dt>匹配规则</dt>
          <dd><pre>/wp-content/themes/oceanwp/</pre></dd>
        </dl>
      </div>
      <p>
        解释：看到这个主题目录，就显示
        <code>WordPress 主题: oceanwp</code>
        。
      </p>
    </section>

    <section class="panel">
      <h2>示例 3：识别统计脚本</h2>
      <p>
        如果某个统计服务会加载
        <code>stats.example.com/tracker.js</code>
        ，可以用加载地址来识别。
      </p>
      <div class="example">
        <dl>
          <dt>技术名称</dt>
          <dd>Example Stats</dd>
          <dt>分类</dt>
          <dd>统计 / 分析</dd>
          <dt>类型说明</dt>
          <dd>统计平台</dd>
          <dt>匹配方式</dt>
          <dd>关键词</dd>
          <dt>匹配规则</dt>
          <dd>
            <pre>
stats.example.com
tracker.js</pre
            >
          </dd>
        </dl>
      </div>
      <p>
        提醒：
        <code>tracker.js</code>
        这个名字比较常见，可能误报。更稳的写法是只写
        <code>stats.example.com</code>
        。
      </p>
    </section>

    <section class="panel">
      <h2>示例 4：识别第三方登录或支付</h2>
      <p>登录和支付通常是点按钮后才加载，所以记得勾选"动态资源"。</p>
      <div class="example">
        <dl>
          <dt>技术名称</dt>
          <dd>ExamplePay</dd>
          <dt>分类</dt>
          <dd>支付系统</dd>
          <dt>类型说明</dt>
          <dd>第三方支付</dd>
          <dt>匹配方式</dt>
          <dd>关键词</dd>
          <dt>匹配规则</dt>
          <dd>
            <pre>
pay.example.com
examplepay-sdk</pre
            >
          </dd>
        </dl>
      </div>
      <p>测试方法：保存规则后，刷新网页，再点一次网页里的支付按钮，然后重新打开插件看结果。</p>
    </section>

    <section class="panel">
      <h2>示例 5：用正则写更灵活的规则</h2>
      <p>
        正则可以理解成"带通配的关键词"。比如有些文件名会带版本号：
        <code>examplecms-1.2.3.js</code>
        、
        <code>examplecms-2.0.0.js</code>
        。
      </p>
      <div class="example">
        <dl>
          <dt>匹配方式</dt>
          <dd>正则表达式</dd>
          <dt>匹配规则</dt>
          <dd><pre>examplecms-[0-9.]+\.js</pre></dd>
        </dl>
      </div>
      <p>
        大白话解释：
        <code>[0-9.]</code>
        表示数字和点，
        <code>+</code>
        表示前面的东西可以出现很多次。
      </p>
    </section>

    <section class="panel">
      <h2>怎么减少误报</h2>
      <ul class="plain-list">
        <li>
          不要只写太普通的词，比如
          <code>app</code>
          、
          <code>main</code>
          、
          <code>login</code>
          ，这些很多网站都有。
        </li>
        <li>
          优先写完整域名，比如
          <code>pay.example.com</code>
          比
          <code>pay</code>
          稳很多。
        </li>
        <li>
          优先写特殊目录，比如
          <code>/wp-content/themes/oceanwp/</code>
          比
          <code>oceanwp</code>
          稳。
        </li>
        <li>不确定就把置信度设为"低"，这样看结果时会知道它只是猜测。</li>
        <li>规则保存后一定要刷新目标网页，再打开插件看结果。</li>
      </ul>
    </section>

    <section class="panel">
      <h2>想把规则贡献给项目</h2>
      <p>如果你的规则比较通用，可以回到设置页点击"提交规则贡献"。它会打开 GitHub 表单，你把技术名称、分类、匹配规则和证据填进去就行。</p>
      <p>
        如果你会改仓库文件，内置规则放在
        <code>rules/</code>
        目录。页面里能看到的字、脚本地址、主题目录这些，通常放到
        <code>rules/page/</code>
        ；响应头、Cookie、Server 这些，通常放到
        <code>rules/headers/</code>
        。
      </p>
      <p>证据可以是官网说明、测试网页、脚本地址、响应头截图或源码片段。敏感网址可以打码。</p>
    </section>
  </main>
</template>

<script setup lang="ts">
  import { onMounted, ref } from 'vue'
  import { ExternalLink, Settings2 } from 'lucide-vue-next'
  import RippleButton from '@/ui/components/RippleButton.vue'
  import { REPOSITORY_URL } from '@/utils/constants'

  const version = ref('')

  const openSettings = () => {
    const settingsPage = chrome.runtime.getManifest().options_ui?.page
    chrome.tabs.create({ url: chrome.runtime.getURL(settingsPage || 'src/ui/settings/index.html') })
  }

  const openRepo = () => {
    chrome.tabs.create({ url: REPOSITORY_URL })
  }

  onMounted(() => {
    version.value = chrome.runtime.getManifest?.()?.version || ''
  })
</script>

<style lang="scss">
  body {
    font-size: 15px;
    line-height: 1.65;
    padding-top: 132px;
  }

  @media (max-width: 760px) {
    body {
      padding-top: 0;
    }
  }
</style>

<style lang="scss" scoped>
  .help-shell {
    margin: 0 auto;
    max-width: 720px;
    padding: 24px 24px 80px;
  }

  // header：fixed 顶部，背景毛玻璃，内容靠 inner 居中
  .help-header {
    backdrop-filter: saturate(180%) blur(8px);
    background: var(--panel-translucent);
    border-bottom: 1px solid var(--line);
    left: 0;
    margin: 0;
    padding: 0;
    position: fixed;
    right: 0;
    top: 0;
    z-index: 30;

    > div:first-child > p {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
      max-width: 60ch;
    }
  }

  .help-header-inner {
    align-items: flex-start;
    display: flex;
    gap: 24px;
    justify-content: space-between;
    margin: 0 auto;
    max-width: 720px;
    padding: 16px 24px;
  }

  .header-actions {
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: 6px;

    .icon-btn {
      height: 32px;
      justify-content: center;
      padding: 0;
      width: 32px;
    }

    button {
      align-items: center;
      background: transparent;
      border: 0;
      border-radius: 6px;
      color: var(--muted);
      cursor: pointer;
      display: inline-flex;
      font-size: 13px;
      gap: 6px;
      padding: 6px 12px;
      transition:
        background 0.15s ease,
        color 0.15s ease;

      &:hover {
        background: var(--accent-soft);
        color: var(--accent);
      }

      &.primary {
        background: var(--accent);
        color: #ffffff;
        font-weight: 500;

        &:hover {
          background: var(--accent-dark);
          color: #ffffff;
        }
      }
    }
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    font-size: 24px;
    font-weight: 600;
    gap: 10px;
    letter-spacing: 0;
    line-height: 1.2;
    margin-bottom: 8px;
  }

  h2 {
    color: var(--text);
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0;
    margin-bottom: 12px;
  }

  h3 {
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  p + p {
    margin-top: 8px;
  }

  .version-badge {
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .plain-list,
  .steps {
    color: var(--muted);
    padding-left: 20px;

    li {
      margin: 6px 0;
    }
  }

  // panel：去 box-shadow + border + 圆角，仅靠间距 + 标题层级划分（长篇阅读）
  .panel {
    margin-bottom: 36px;

    p {
      color: var(--muted);
      line-height: 1.65;
    }
  }

  // field-grid：去单 box 边框，hairline 列分隔
  .field-grid {
    display: grid;
    gap: 4px 32px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-top: 12px;

    &.compact {
      grid-template-columns: repeat(3, minmax(0, 1fr));

      > div:nth-child(-n + 3) {
        border-top: 0;
      }
    }

    > div {
      padding: 12px 0;

      + div {
        border-top: 1px solid var(--line);
      }

      &:nth-child(1),
      &:nth-child(2) {
        border-top: 0;
      }

      p {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
        margin-top: 4px;
      }
    }
  }

  // 行内 code
  code {
    background: var(--code-inline-bg);
    border-radius: 4px;
    color: var(--code-inline-text);
    font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
    font-size: 0.88em;
    padding: 1px 5px;
  }

  // example：保留卡片视觉（教学示例需要明显的"代码块"感）
  .example {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    margin: 12px 0;
    overflow: hidden;
  }

  dl {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    margin: 0;
  }

  dt,
  dd {
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    margin: 0;
    padding: 8px 12px;
  }

  dt {
    color: var(--muted);
    font-weight: 500;
    letter-spacing: 0.01em;
  }

  dd:last-child,
  dt:nth-last-child(2) {
    border-bottom: 0;
  }

  // 代码块 pre
  pre {
    background: var(--code-bg);
    border-radius: 6px;
    color: var(--code-text);
    font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
    font-size: 12px;
    line-height: 1.55;
    margin: 0;
    overflow: auto;
    padding: 10px 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  @media (max-width: 760px) {
    .help-header {
      position: static;
    }

    .help-shell {
      padding: 16px 16px 48px;
    }

    .help-header-inner {
      flex-direction: column;
      padding: 12px 16px;
    }

    .field-grid,
    .field-grid.compact,
    dl {
      grid-template-columns: 1fr;
    }

    .field-grid > div {
      border-top: 1px solid var(--line);

      &:first-child {
        border-top: 0;
      }
    }

    dt {
      border-bottom: 0;
      padding-bottom: 4px;
    }
  }
</style>
