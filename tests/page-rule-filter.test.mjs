import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { build } from 'esbuild'
import { repoRoot } from './helpers/rule-harness.mjs'

const loadModule = async () => {
  const result = await build({
    entryPoints: [path.join(repoRoot, 'src/background/page-rule-filter.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [
      {
        name: 'src-alias',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^@\// }, args => ({ path: path.join(repoRoot, 'src', `${args.path.slice(2)}.ts`) }))
        }
      }
    ]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')}`)
}

const cdnRule = { name: 'Vue', resourceHints: ['CDN.jsdelivr.net/npm/', 'unpkg.com/'] }
const wordpressRule = { name: 'WordPress', resourceHints: ['/wp-content/'] }
const htmlRule = { name: 'Hugo', patterns: ['hugo'] }
const lodashRule = {
  name: 'lodash',
  resourceOnly: true,
  resourceHints: ['cdn.jsdelivr.net/npm/'],
  patterns: ['cdn\\.jsdelivr\\.net/npm/lodash(?:@|/)'],
  __hints: ['cdn.jsdelivr.net/npm/lodash@', 'cdn.jsdelivr.net/npm/lodash/']
}
const dayjsRule = {
  name: 'dayjs',
  resourceOnly: true,
  resourceHints: ['cdn.jsdelivr.net/npm/'],
  patterns: ['cdn\\.jsdelivr\\.net/npm/dayjs(?:@|/)'],
  __hints: ['cdn.jsdelivr.net/npm/dayjs@', 'cdn.jsdelivr.net/npm/dayjs/']
}
// 页面地址也算资源（matchIn 含 url）
const hashnodeRule = { name: 'Hashnode', matchIn: ['url'], patterns: ['\\.hashnode\\.dev/'], __hints: ['.hashnode.dev/'] }
// matchIn 只有资源但带全局变量，全局变量命中就算，不能按资源裁剪
const globalRule = { name: 'Foo', matchIn: ['resources'], globals: ['Foo'], patterns: ['foo-lib\\.js'], __hints: ['foo-lib.js'] }
const pageRules = {
  frontendExtra: [cdnRule, htmlRule, lodashRule, dayjsRule, globalRule],
  websitePrograms: [wordpressRule, hashnodeRule],
  bundleLicenseLibraries: [{ name: 'React' }],
  dynamicTechnologies: [{ name: 'Turbo' }],
  customRules: [{ name: '自定义', resourceHints: ['never-present'] }]
}

test('按资源里出现的 resourceHints 和必需字面量裁剪注入页面的规则', async () => {
  const { selectPageDetectorRules } = await loadModule()
  const selected = selectPageDetectorRules(pageRules, {
    text: 'https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js\nhttps://a.com/app.js',
    href: 'https://blog.hashnode.dev/post'
  })
  assert.deepEqual(
    selected.frontendExtra.map(rule => rule.name),
    ['Vue', 'Hugo', 'lodash', 'Foo']
  )
  assert.deepEqual(
    selected.websitePrograms.map(rule => rule.name),
    ['Hashnode']
  )
  assert.deepEqual(selected.customRules, pageRules.customRules)
  assert.equal('bundleLicenseLibraries' in selected, false)
  assert.equal('dynamicTechnologies' in selected, false)
})

test('探测不到资源时不裁剪规则', async () => {
  const { selectPageDetectorRules } = await loadModule()
  const selected = selectPageDetectorRules(pageRules, null)
  assert.deepEqual(selected.frontendExtra, pageRules.frontendExtra)
  assert.deepEqual(selected.websitePrograms, pageRules.websitePrograms)
  assert.equal('bundleLicenseLibraries' in selected, false)
})

test('页面探针按 page-detector 的资源收集方式返回资源 URL', async () => {
  const { probePageResources } = await loadModule()
  const previousDocument = globalThis.document
  const previousLocation = globalThis.location
  globalThis.document = {
    scripts: [{ src: 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js' }, { src: '' }],
    images: [{ currentSrc: 'data:image/png;base64,AAAA' }],
    querySelectorAll: selector => {
      if (selector.includes('stylesheet')) return [{ href: 'https://example.com/wp-content/themes/a/Style.css' }]
      if (selector.includes('modulepreload')) return [{ href: 'https://example.com/_next/static/chunks/main.js' }]
      // LiteSpeed 延迟执行的脚本：地址在 data-src 里；Perfmatters 的内联脚本只有 data-rocketlazyloadscript="1"
      if (selector.includes('data-src')) {
        return [
          { getAttribute: name => (name === 'data-src' ? '/wp-content/plugins/b/front.js' : null) },
          { getAttribute: name => (name === 'data-rocketlazyloadscript' ? '1' : null) }
        ]
      }
      return []
    }
  }
  globalThis.location = { href: 'https://example.com/' }
  try {
    assert.deepEqual(probePageResources(), {
      text: [
        'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js',
        'https://example.com/wp-content/plugins/b/front.js',
        'https://example.com/wp-content/themes/a/style.css',
        'https://example.com/_next/static/chunks/main.js'
      ].join('\n'),
      href: 'https://example.com/'
    })
    globalThis.document = { scripts: [], images: [], querySelectorAll: () => [] }
    assert.equal(probePageResources(), null)
  } finally {
    globalThis.document = previousDocument
    globalThis.location = previousLocation
  }
})
