import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDynamicSnapshot, loadDynamicSnapshotDetector, loadPageRules, runPageDetector } from './helpers/rule-harness.mjs'

const rules = loadPageRules(['page/frontend-extra.json', 'page/dynamic-technologies.json'])
const findFormily = technologies => technologies.find(technology => technology.name === 'Formily')

test('Formily is detected from the class names of every UI adapter', async () => {
  for (const className of [
    'ant-formily-item',
    'next-formily-item',
    'formily-element-form-item',
    'formily-element-plus-form-item',
    'formily-vant-form-item',
    'formily-semi-formily-item',
    'formily-tdesign-formily-item'
  ]) {
    const formily = findFormily(await runPageDetector(rules, { classes: [className] }))
    assert.ok(formily, className)
    assert.equal(formily.category, '前端库')
  }
})

test('Formily is detected from the UMD global and from package resources', async () => {
  assert.ok(findFormily(await runPageDetector(rules, { globals: ['Formily'] })))
  for (const url of [
    'https://unpkg.com/@formily/core@2.3.7/dist/formily.core.umd.production.js',
    'https://cdn.jsdelivr.net/npm/@formily/antd/dist/antd.css',
    'https://example.com/static/js/formily.react.umd.development.js'
  ]) {
    assert.ok(findFormily(await runPageDetector(rules, { resources: [url] })), url)
  }
})

test('Formily is not reported for pages that only mention the package', async () => {
  const html =
    '<html><body><p>npm install @formily/core</p><a href="https://unpkg.com/browse/@formily/core@2.3.7/dist/">formily.core.umd.production.js</a></body></html>'
  assert.equal(findFormily(await runPageDetector(rules, { html })), undefined)
  assert.equal(findFormily(await runPageDetector(rules, { classes: ['formily-docs'] })), undefined)
})

test('dynamic snapshots detect Formily forms rendered after the first scan', async () => {
  const detect = await loadDynamicSnapshotDetector()
  for (const marker of ['.ant-formily-item', '.next-formily-item', '.formily-element-form-item', '.formily-vant-form-item']) {
    assert.ok(findFormily(detect(createDynamicSnapshot({ domMarkers: [marker] }), rules)), marker)
  }
  const script = 'https://cdn.jsdelivr.net/npm/@formily/antd@2.3.7/dist/formily.antd.umd.production.js'
  assert.ok(findFormily(detect(createDynamicSnapshot({ scripts: [script] }), rules)))
  assert.equal(findFormily(detect(createDynamicSnapshot({ title: 'Formily 表单教程 @formily/core .ant-formily' }), rules)), undefined)
})
