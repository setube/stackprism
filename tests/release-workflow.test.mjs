import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const workflowSource = await readFile(new URL('../.github/workflows/release-extension.yml', import.meta.url), 'utf8')
const normalizedWorkflowSource = workflowSource.replaceAll('\\/', '/')
const hygieneScript = extractReleaseHygieneScript(workflowSource)

function extractReleaseHygieneScript(source) {
  const match = source.match(/node --input-type=module <<'NODE'\n(?<script>[\s\S]*?)\n\s+NODE/)
  assert.ok(match?.groups?.script, 'release workflow must contain inline dist hygiene script')
  return match.groups.script.replace(/^ {10}/gm, '')
}

async function withDist(files, testFn) {
  const cwd = await mkdtemp(join(tmpdir(), 'stackprism-release-workflow-'))

  try {
    for (const [file, content] of Object.entries(files)) {
      const fullPath = join(cwd, file)
      await mkdir(join(fullPath, '..'), { recursive: true })
      await writeFile(fullPath, content)
    }

    return testFn(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function runHygieneScript(cwd) {
  return spawnSync(process.execPath, ['--input-type=module'], {
    cwd,
    input: hygieneScript,
    encoding: 'utf8'
  })
}

function manifest(overrides = {}) {
  return JSON.stringify(
    {
      manifest_version: 3,
      name: 'StackPrism',
      version: '1.3.71',
      web_accessible_resources: [],
      ...overrides
    },
    null,
    2
  )
}

test('release workflow rejects agent bridge helper source files from dist artifacts', () => {
  const requiredArtifacts = [
    'agent-skill',
    'docs/superpowers',
    'tests',
    '__pycache__',
    'stackprism-bridge\\.mjs',
    'stackprism_bridge\\.py',
    'capture-store\\.mjs',
    'http-handlers\\.mjs',
    'http-server\\.mjs',
    'open-browser\\.mjs',
    'protocol\\.mjs',
    'security\\.mjs',
    'url-policy\\.mjs'
  ]

  for (const artifact of requiredArtifacts) {
    assert.match(normalizedWorkflowSource, new RegExp(artifact), `missing dist hygiene check for ${artifact}`)
  }
})

test('release workflow runs required gates before packaging artifacts', () => {
  const requiredOrder = [
    /^ {8}run: pnpm run lint$/m,
    /^ {8}run: pnpm run build:injected$/m,
    /^ {8}run: pnpm run test:unit$/m,
    /^ {8}run: pnpm run typecheck$/m,
    /^ {8}run: pnpm run docs:build$/m,
    /^ {8}run: pnpm run build$/m,
    /^ {6}- name: 校验发布产物边界$/m,
    /^ {6}- name: 打包 zip$/m
  ]
  let previousIndex = -1

  for (const pattern of requiredOrder) {
    const match = normalizedWorkflowSource.match(pattern)
    assert.ok(match, `missing release gate: ${pattern}`)
    assert.ok(match.index > previousIndex, `release gate out of order: ${pattern}`)
    previousIndex = match.index
  }
})

test('release workflow dist hygiene script passes a clean dist artifact', async () => {
  await withDist(
    {
      'dist/manifest.json': manifest(),
      'dist/assets/agent-bridge-client.ts-DEPRr4GS.js': 'export {}',
      'dist/injected/page-detector.iife.js': 'void 0'
    },
    cwd => {
      const result = runHygieneScript(cwd)
      assert.equal(result.status, 0, result.stderr)
    }
  )
})

test('release workflow dist hygiene script rejects externally connectable manifests', async () => {
  await withDist(
    {
      'dist/manifest.json': manifest({
        externally_connectable: {
          matches: ['https://example.com/*']
        }
      })
    },
    cwd => {
      const result = runHygieneScript(cwd)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /dist\/manifest\.json must not expose externally_connectable/)
    }
  )
})

test('release workflow dist hygiene script rejects agent bridge helper source files', async () => {
  await withDist(
    {
      'dist/manifest.json': manifest(),
      'dist/assets/capture-store.mjs': 'export {}'
    },
    cwd => {
      const result = runHygieneScript(cwd)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /dist contains agent-only or test artifact: assets\/capture-store\.mjs/)
    }
  )
})

test('release workflow dist hygiene script rejects nested agent-only directories', async () => {
  await withDist(
    {
      'dist/manifest.json': manifest(),
      'dist/assets/agent-skill/README.md': '# should not ship'
    },
    cwd => {
      const result = runHygieneScript(cwd)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /dist contains agent-only or test artifact: assets\/agent-skill\/README\.md/)
    }
  )
})

test('release workflow dist hygiene script rejects web accessible agent-only resources', async () => {
  await withDist(
    {
      'dist/manifest.json': manifest({
        web_accessible_resources: [
          {
            resources: ['assets/http-server.mjs'],
            matches: ['http://127.0.0.1/*']
          }
        ]
      })
    },
    cwd => {
      const result = runHygieneScript(cwd)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /web_accessible_resources exposes agent-only path: assets\/http-server\.mjs/)
    }
  )
})
