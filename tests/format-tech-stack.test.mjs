import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const loadFormatter = async () => {
  const source = await readFile(new URL('../src/utils/format-tech-stack.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  })
  const encoded = Buffer.from(outputText, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${encoded}`)
}

const extractStructuredJson = report => {
  const match = report.match(/````json\n([\s\S]*?)\n````/)
  assert.ok(match, 'expected fenced structured JSON block')
  return JSON.parse(match[1])
}

test('formats detected technologies for humans and AI agents', async () => {
  const { formatTechStackReport } = await loadFormatter()
  const report = formatTechStackReport({
    url: 'https://example.com/app',
    title: 'Example App',
    generatedAt: '2026-05-14T08:00:00.000Z',
    technologies: [
      {
        category: '前端框架',
        name: 'React',
        version: '18.2.0',
        confidence: '高',
        sources: ['页面扫描'],
        evidence: ['window.React 命中'],
        url: 'https://react.dev'
      },
      {
        category: '前端框架',
        name: 'Next.js',
        confidence: '高',
        sources: ['页面扫描']
      },
      {
        category: 'CDN / 托管',
        name: 'Cloudflare',
        confidence: '中',
        sources: ['响应头']
      },
      {
        category: '检测来源示例',
        name: 'SomeTech',
        confidence: '高',
        source: '响应头'
      },
      {
        category: '应被过滤',
        confidence: '高',
        sources: ['页面扫描']
      }
    ],
    resources: { total: 42 },
    headerCount: 7
  })
  const humanSection = report.split('````json')[0]
  const structured = extractStructuredJson(report)
  const someTech = structured.technologies.find(item => item.name === 'SomeTech')

  assert.match(report, /^# StackPrism 技术栈报告/m)
  assert.match(report, /URL: https:\/\/example\.com\/app/)
  assert.match(report, /标题: Example App/)
  assert.match(report, /生成时间: 2026-05-14T08:00:00.000Z/)
  assert.match(report, /报告范围: 当前弹窗结果/)
  assert.match(report, /技术总数: 4/)
  assert.match(report, /资源数: 42/)
  assert.match(report, /主文档响应头数: 7/)
  assert.match(report, /## 人类阅读摘要/)
  assert.match(report, /### 前端框架 \(2\)/)
  assert.match(report, /- React 18.2.0 \[高\]/)
  assert.match(report, /  - 来源: 页面扫描/)
  assert.match(report, /  - 依据: window.React 命中/)
  assert.match(report, /### CDN \/ 托管 \(1\)/)
  assert.match(humanSection, /### 检测来源示例 \(1\)/)
  assert.match(humanSection, /- SomeTech \[高\]/)
  assert.match(humanSection, /  - 来源: 响应头/)
  assert.doesNotMatch(humanSection, /应被过滤/)
  assert.match(report, /## AI Agent 结构化数据/)
  assert.match(report, /````json/)
  assert.match(report, /"schema": "stackprism.tech_stack_report.v1"/)
  assert.match(report, /"name": "React"/)
  assert.match(report, /"category": "前端框架"/)
  assert.equal(structured.technologies.length, 4)
  assert.deepEqual(someTech.sources, ['响应头'])
  assert.equal(Object.hasOwn(someTech, 'source'), false)
  assert.equal(
    structured.technologies.some(item => item.category === '应被过滤'),
    false
  )
})

test('keeps empty detection reports readable and structured', async () => {
  const { formatTechStackReport } = await loadFormatter()
  const report = formatTechStackReport({
    url: 'https://example.com/empty',
    title: 'Empty Page',
    generatedAt: '2026-05-14T09:00:00.000Z',
    technologies: [],
    resources: { total: 0 },
    headers: []
  })

  assert.match(report, /未检测到明确技术栈。/)
  assert.match(report, /"technologyCount": 0/)
  assert.match(report, /"technologies": \[\]/)
})

test('normalizes multiline evidence and invalid counters', async () => {
  const { formatTechStackReport } = await loadFormatter()
  const report = formatTechStackReport({
    url: 'https://example.com/multiline',
    title: 'Multiline Evidence',
    generatedAt: '2026-05-14T10:00:00.000Z',
    technologies: [
      {
        category: '前端库',
        name: 'DOMPurify',
        confidence: '高',
        sources: ['JS 版权注释\nvendor-misc.js'],
        evidence: ['JS 版权注释匹配\nexample.com/assets/vendor-misc.js']
      }
    ],
    resources: { total: Number.NaN },
    headerCount: -1
  })

  assert.match(report, /资源数: 0/)
  assert.match(report, /主文档响应头数: 0/)
  assert.match(report, /来源: JS 版权注释 vendor-misc\.js/)
  assert.match(report, /依据: JS 版权注释匹配 example\.com\/assets\/vendor-misc\.js/)
  assert.doesNotMatch(report, /依据: JS 版权注释匹配\nexample/)
})

test('keeps markdown fence stable and filters non-text list items', async () => {
  const { formatTechStackReport } = await loadFormatter()
  const report = formatTechStackReport({
    url: 'https://example.com/markdown',
    title: 'Example ``` Code\nInjected title',
    generatedAt: '2026-05-14T11:00:00.000Z',
    technologies: [
      {
        category: '前端库',
        name: 'Marked',
        confidence: '中',
        sources: ['源码', { unexpected: true }, 123],
        evidence: ['title contains ``` fence', { unexpected: true }]
      }
    ],
    resources: { total: 1 },
    headerCount: 0
  })

  const structured = extractStructuredJson(report)

  assert.match(report, /标题: Example ``` Code Injected title/)
  assert.match(report, /````json/)
  assert.match(report, /来源: 源码, 123/)
  assert.match(report, /依据: title contains ``` fence/)
  assert.doesNotMatch(report, /\[object Object\]/)
  assert.equal(structured.title, 'Example ``` Code\nInjected title')
  assert.deepEqual(structured.technologies[0].sources, ['源码', '123'])
  assert.deepEqual(structured.technologies[0].evidence, ['title contains ``` fence'])
})
