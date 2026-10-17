import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { repoRoot } from './helpers/rule-harness.mjs'

const compiled = await build({
  stdin: {
    contents:
      "export { mergeRulePartial } from './src/core/rule-normalizer'; export { precompileRuleTree } from './src/core/rule-precompiler'",
    resolveDir: repoRoot,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node'
})
const { mergeRulePartial, precompileRuleTree } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
)

test('shared rule pipeline retains nested defaults, resource scope and matching hints', () => {
  const source = {
    page: {
      frontendExtra: {
        defaults: { category: 'Library', matchType: 'keyword' },
        $defaults: { confidence: '高' },
        rules: [
          {
            defaults: { resourceOnly: true, resourceHints: ['cdn.example/'] },
            rules: [{ name: 'Example', patterns: ['cdn.example/example.js'] }]
          }
        ]
      }
    }
  }
  precompileRuleTree(source)
  const merged = mergeRulePartial({}, source)
  const [rule] = merged.page.frontendExtra
  assert.equal(rule.category, 'Library')
  assert.equal(rule.matchType, 'keyword')
  assert.equal(rule.confidence, '高')
  assert.equal(rule.resourceOnly, true)
  assert.deepEqual(rule.resourceHints, ['cdn.example/'])
  assert.deepEqual(rule.__hints, ['cdn.example/example.js'])
  assert.equal(rule.__legacyHints, undefined)
  mergeRulePartial(merged, { page: { frontendExtra: [{ name: 'Second', patterns: ['second'] }] } })
  assert.equal(merged.page.frontendExtra.length, 2)
})
