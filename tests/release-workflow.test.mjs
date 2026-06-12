import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { packageFirefox } from '../build-scripts/package-firefox.mjs'

const workflowSource = await readFile(new URL('../.github/workflows/release-extension.yml', import.meta.url), 'utf8')
const normalizedWorkflowSource = workflowSource.replaceAll('\\/', '/')
const hygieneScript = extractReleaseHygieneScript(workflowSource)
const disclosureGateScript = extractNamedNodeScript(workflowSource, '校验 Agent Bridge 发布披露确认')

function extractReleaseHygieneScript(source) {
  const match = source.match(/node --input-type=module <<'NODE'\n(?<script>[\s\S]*?)\n\s+NODE/)
  assert.ok(match?.groups?.script, 'release workflow must contain inline dist hygiene script')
  return match.groups.script.replace(/^ {10}/gm, '')
}

function extractNamedNodeScript(source, stepName) {
  const escapedStepName = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(
    new RegExp(`- name: ${escapedStepName}[\\s\\S]*?node --input-type=module <<'NODE'\\n(?<script>[\\s\\S]*?)\\n\\s+NODE`)
  )
  assert.ok(match?.groups?.script, `release workflow must contain ${stepName} inline script`)
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

    return await testFn(cwd)
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

function runDisclosureGateScript(cwd, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module'], {
    cwd,
    env: { ...process.env, ...env },
    input: disclosureGateScript,
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

function agentBridgeManifest(overrides = {}) {
  return manifest({
    content_scripts: [
      {
        js: ['assets/agent-bridge-client.ts-loader.js'],
        matches: ['http://127.0.0.1/*'],
        run_at: 'document_idle'
      }
    ],
    web_accessible_resources: [
      {
        resources: ['assets/agent-bridge.js'],
        matches: ['http://127.0.0.1/*']
      }
    ],
    ...overrides
  })
}

async function withFirefoxDist(files, testFn) {
  const cwd = await mkdtemp(join(tmpdir(), 'stackprism-firefox-package-'))

  try {
    await withFiles(cwd, files)
    return await testFn(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function withFiles(cwd, files) {
  for (const [file, content] of Object.entries(files)) {
    const fullPath = join(cwd, file)
    await mkdir(join(fullPath, '..'), { recursive: true })
    await writeFile(fullPath, content)
  }
}

test('release workflow rejects agent bridge helper source files from dist artifacts', () => {
  const requiredArtifacts = [
    'agent-skill',
    'docs/superpowers',
    'tests',
    '__pycache__',
    'stackprism-bridge\\.mjs',
    'stackprism_bridge\\.py',
    'capture-site\\.mjs',
    'capture-site-args\\.mjs',
    'capture-runtime\\.mjs',
    'capture-screenshot-artifact\\.mjs',
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
    /^ {6}- name: 校验 Agent Bridge 发布披露确认$/m,
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

test('firefox package manifest omits reserved data collection permissions', async () => {
  await withFirefoxDist(
    {
      'dist/manifest.json': manifest({
        background: { service_worker: 'service-worker-loader.js' },
        web_accessible_resources: [
          {
            resources: ['rules/*', 'tech-links.json'],
            matches: ['http://*/*', 'https://*/*'],
            use_dynamic_url: false
          }
        ]
      }),
      'dist/service-worker-loader.js': "import './assets/background-entry.js'",
      'dist/assets/background-entry.js': 'chrome.runtime.onInstalled.addListener(() => {})',
      'dist/assets/my-security.mjs': 'export {}',
      'dist/injected/experience-profiler.iife.js': 'void 0'
    },
    async cwd => {
      const result = await packageFirefox({ root: cwd, logger: { log() {} } })
      const manifestJson = JSON.parse(await readFile(result.manifestPath, 'utf8'))

      assert.deepEqual(manifestJson.background, { scripts: ['background.js'] })
      assert.deepEqual(manifestJson.web_accessible_resources, [
        {
          resources: ['rules/*', 'tech-links.json'],
          matches: ['http://*/*', 'https://*/*']
        }
      ])
      assert.deepEqual(manifestJson.browser_specific_settings, {
        gecko: {
          id: 'stackprism@setube.github.io',
          strict_min_version: '128.0'
        }
      })
      assert.equal('data_collection_permissions' in manifestJson.browser_specific_settings.gecko, false)
      assert.equal('use_dynamic_url' in manifestJson.web_accessible_resources[0], false)
      assert.doesNotMatch(JSON.stringify(manifestJson), /data_collection_permissions/)
      assert.doesNotMatch(JSON.stringify(manifestJson), /use_dynamic_url/)
      assert.doesNotMatch(JSON.stringify(manifestJson.web_accessible_resources), /experience-profiler/)
      assert.ok((await stat(join(cwd, 'dist-firefox/background.js'))).isFile())
      assert.ok((await stat(join(cwd, 'dist-firefox/assets/my-security.mjs'))).isFile())
      assert.ok((await stat(join(cwd, 'dist-firefox/injected/experience-profiler.iife.js'))).isFile())
      assert.ok((await stat(join(cwd, 'release/stackprism-v1.3.71.xpi'))).isFile())
    }
  )
})

test('firefox package bundles content script loaders into plain scripts', async () => {
  await withFirefoxDist(
    {
      'dist/manifest.json': manifest({
        background: { service_worker: 'service-worker-loader.js' },
        content_scripts: [
          {
            js: ['assets/content-observer.ts-loader-unit.js'],
            matches: ['http://*/*', 'https://*/*'],
            run_at: 'document_idle'
          },
          {
            js: ['assets/agent-bridge-client.ts-loader-unit.js'],
            matches: ['http://127.0.0.1/*'],
            run_at: 'document_idle'
          }
        ]
      }),
      'dist/service-worker-loader.js': "import './assets/background-entry.js'",
      'dist/assets/background-entry.js': 'chrome.runtime.onInstalled.addListener(() => {})',
      'dist/assets/content-observer.ts-loader-unit.js':
        'const injectTime = performance.now(); (async () => { const { onExecute } = await import(chrome.runtime.getURL("assets/content-observer.ts-unit.js")); onExecute?.({ perf: { injectTime } }); })();',
      'dist/assets/agent-bridge-client.ts-loader-unit.js':
        'const injectTime = performance.now(); (async () => { const { onExecute } = await import(chrome.runtime.getURL("assets/agent-bridge-client.ts-unit.js")); onExecute?.({ perf: { injectTime } }); })();',
      'dist/assets/content-observer.ts-unit.js': 'window.__stackprismObserverLoaded = true; export const onExecute = () => {}',
      'dist/assets/agent-bridge-client.ts-unit.js': 'window.__stackprismBridgeClientLoaded = true; export const onExecute = () => {}'
    },
    async cwd => {
      const result = await packageFirefox({ root: cwd, logger: { log() {} } })
      const manifestJson = JSON.parse(await readFile(result.manifestPath, 'utf8'))
      const scripts = manifestJson.content_scripts.flatMap(script => script.js)

      assert.deepEqual(scripts, ['firefox/content-observer.js', 'firefox/agent-bridge-client.js'])
      assert.equal(
        scripts.some(file => /loader/i.test(file)),
        false
      )

      for (const file of scripts) {
        const bundled = await readFile(join(cwd, 'dist-firefox', file), 'utf8')
        assert.doesNotMatch(bundled, /chrome\.runtime\.getURL/)
        assert.doesNotMatch(bundled, /await\s+import/)
      }
    }
  )
})

test('firefox package rejects agent-only files before writing xpi', async () => {
  await withFirefoxDist(
    {
      'dist/manifest.json': manifest({
        background: { service_worker: 'service-worker-loader.js' }
      }),
      'dist/service-worker-loader.js': "import './assets/background-entry.js'",
      'dist/assets/background-entry.js': 'chrome.runtime.onInstalled.addListener(() => {})',
      'dist/assets/http-server.mjs': 'export {}'
    },
    async cwd => {
      await assert.rejects(
        () => packageFirefox({ root: cwd, logger: { log() {} } }),
        /Firefox artifact hygiene failed:[\s\S]*dist-firefox contains agent-only or test artifact: assets\/http-server\.mjs/
      )
      await assert.rejects(stat(join(cwd, 'release/stackprism-v1.3.71.xpi')))
    }
  )
})

test('firefox package rejects web accessible agent-only resources', async () => {
  await withFirefoxDist(
    {
      'dist/manifest.json': manifest({
        background: { service_worker: 'service-worker-loader.js' },
        web_accessible_resources: [
          {
            resources: ['injected/experience-profiler.iife.js', 'assets/security.mjs'],
            matches: ['http://127.0.0.1/*']
          }
        ]
      }),
      'dist/service-worker-loader.js': "import './assets/background-entry.js'",
      'dist/assets/background-entry.js': 'chrome.runtime.onInstalled.addListener(() => {})'
    },
    async cwd => {
      await assert.rejects(
        () => packageFirefox({ root: cwd, logger: { log() {} } }),
        /Firefox artifact hygiene failed:[\s\S]*web_accessible_resources exposes agent-only path: injected\/experience-profiler\.iife\.js[\s\S]*web_accessible_resources exposes agent-only path: assets\/security\.mjs/
      )
      await assert.rejects(stat(join(cwd, 'release/stackprism-v1.3.71.xpi')))
    }
  )
})

test('release workflow requires Agent Bridge disclosure confirmation before packaging', () => {
  assert.match(normalizedWorkflowSource, /agent_bridge_disclosure_confirmed/)
  assert.match(normalizedWorkflowSource, /Agent Bridge disclosure confirmed/)
  assert.match(normalizedWorkflowSource, /Chrome Web Store \/ Edge Add-ons \/ Firefox Add-ons privacy disclosure/)
})

test('release workflow dist hygiene script passes a clean dist artifact', async () => {
  await withDist(
    {
      'dist/manifest.json': manifest(),
      'dist/assets/agent-bridge-client.ts-DEPRr4GS.js': 'export {}',
      'dist/assets/my-security.mjs': 'export {}',
      'dist/injected/page-detector.iife.js': 'void 0'
    },
    cwd => {
      const result = runHygieneScript(cwd)
      assert.equal(result.status, 0, result.stderr)
    }
  )
})

test('release workflow disclosure gate fails when Agent Bridge ships without confirmation', async () => {
  await withDist(
    {
      'dist/manifest.json': agentBridgeManifest()
    },
    cwd => {
      const result = runDisclosureGateScript(cwd, {
        AGENT_BRIDGE_DISCLOSURE_CONFIRMED: 'false'
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /Agent Bridge is present in dist/)
    }
  )
})

test('release workflow disclosure gate accepts workflow dispatch confirmation', async () => {
  await withDist(
    {
      'dist/manifest.json': agentBridgeManifest()
    },
    cwd => {
      const result = runDisclosureGateScript(cwd, {
        AGENT_BRIDGE_DISCLOSURE_CONFIRMED: 'true'
      })
      assert.equal(result.status, 0, result.stderr)
    }
  )
})

test('release workflow disclosure gate accepts checked release-note confirmation', async () => {
  await withDist(
    {
      'dist/manifest.json': agentBridgeManifest(),
      'event.json': JSON.stringify({
        release: {
          body: '- [x] Agent Bridge disclosure confirmed'
        }
      })
    },
    cwd => {
      const result = runDisclosureGateScript(cwd, {
        GITHUB_EVENT_PATH: join(cwd, 'event.json')
      })
      assert.equal(result.status, 0, result.stderr)
    }
  )
})

test('release workflow disclosure gate ignores artifacts without Agent Bridge', async () => {
  await withDist(
    {
      'dist/manifest.json': manifest()
    },
    cwd => {
      const result = runDisclosureGateScript(cwd, {
        AGENT_BRIDGE_DISCLOSURE_CONFIRMED: 'false'
      })
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
