import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import identifiers from './fixtures/bridge-protocol-identifiers.json' with { type: 'json' }
import urlPolicyCases from './fixtures/bridge-url-policy-cases.json' with { type: 'json' }

const request = {
  url: 'https://93.184.216.34/app?view=one#frag',
  mode: 'experience',
  waitMs: 0,
  include: ['tech'],
  viewports: [],
  options: { targetMode: 'reuse_or_new_tab' }
}

const readJson = async response => ({ status: response.status, body: await response.json(), headers: response.headers })

const sensitiveFailedError = (ready, created, config) => {
  const sensitiveUrl = `${created.body.bridgeUrl}&token=secret&apiToken=${ready.apiToken}&bridgeToken=${config.bridgeToken}#frag`
  return {
    code: 'TARGET_TAB_CLOSED',
    message: `Target closed while loading ${sensitiveUrl}`,
    details: {
      url: sensitiveUrl,
      token: config.bridgeToken,
      nonce: config.nonce,
      nested: {
        authorization: `Bearer ${ready.apiToken}`,
        values: [config.bridgeToken, config.nonce, sensitiveUrl]
      }
    }
  }
}

const assertErrorIsRedacted = (error, blockedValues) => {
  const serialized = JSON.stringify(error)
  for (const value of blockedValues) assert.equal(serialized.includes(value), false, value)
  assert.doesNotMatch(serialized, /spbt?_[A-Za-z0-9_-]{8,}/)
  assert.doesNotMatch(serialized, /\bn_[A-Za-z0-9_-]{8,}\b/)
  assert.doesNotMatch(serialized, /token=secret|apiToken=|bridgeToken=|#frag/)
  assert.match(serialized, /\[redacted/)
}

const assertJsonSecurityHeaders = (envelope, { referrerPolicy = false } = {}) => {
  assert.match(envelope.headers.get('content-type') || '', /^application\/json; charset=utf-8\b/)
  assert.equal(envelope.headers.get('cache-control'), 'no-store')
  assert.equal(envelope.headers.get('x-content-type-options'), 'nosniff')
  if (referrerPolicy) assert.equal(envelope.headers.get('referrer-policy'), 'no-referrer')
}

const createCapture = async ready =>
  readJson(
    await fetch(`${ready.baseUrl}/v1/captures`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ready.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    })
  )

const loadBridgeConfig = async bridgeUrl => {
  const bridgePage = await fetch(bridgeUrl)
  const html = await bridgePage.text()
  return JSON.parse(html.match(/<script id="stackprism-agent-bridge-config" type="application\/json" nonce="[^"]+">([^<]+)/)[1])
}

const loadBridgePage = async bridgeUrl => {
  const response = await fetch(bridgeUrl)
  return { response, html: await response.text() }
}

const statusBody = (captureId, config, body) => ({
  captureId,
  sessionId: config.sessionId,
  nonce: config.nonce,
  protocolVersion: 1,
  ...body
})

const percentEncodeFirstPayloadChar = value =>
  `${value.slice(0, 2)}%${value.charCodeAt(2).toString(16).toUpperCase().padStart(2, '0')}${value.slice(3)}`

const percentEncodeBridgeParam = (bridgeUrl, name) => {
  const url = new URL(bridgeUrl)
  const value = url.searchParams.get(name)
  return bridgeUrl.replace(`${name}=${value}`, `${name}=${percentEncodeFirstPayloadChar(value)}`)
}

const acceptFinalUrl = async (ready, captureId, bridgeToken, finalUrl = request.url) => {
  const requestEnvelope = await readJson(
    await fetch(`${ready.baseUrl}/v1/captures/${captureId}/request`, { headers: { Authorization: `Bearer ${bridgeToken}` } })
  )
  assert.equal(requestEnvelope.status, 200)
  assertJsonSecurityHeaders(requestEnvelope)
  const response = await fetch(`${ready.baseUrl}/v1/captures/${captureId}/status`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bridgeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(
      statusBody(captureId, requestEnvelope.body, {
        status: 'running',
        phase: 'target_loaded',
        sequence: 1,
        finalUrl,
        targetNetworkAddress: '93.184.216.34'
      })
    )
  })
  const envelope = await readJson(response)
  assert.equal(envelope.status, 200)
  assertJsonSecurityHeaders(envelope)
  assert.equal(envelope.body.phase, 'target_loaded')
}

const profileFor = captureId => ({
  schema: 'stackprism.site_experience_profile.v1',
  captureId,
  generatedAt: new Date(0).toISOString(),
  target: {},
  browserContext: { extensionCapabilities: {} },
  techProfile: {},
  visualProfile: {},
  layoutProfile: {},
  componentProfile: {},
  interactionProfile: {},
  uxProfile: {},
  assetProfile: {},
  evidence: {},
  limitations: [],
  agentGuidance: {}
})

const startPythonBridge = async () => {
  const child = spawn('python3', ['agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, STACKPRISM_BRIDGE_NO_OPEN: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const [chunk] = await once(child.stdout, 'data')
  return { child, ready: JSON.parse(String(chunk).trim()) }
}

const startPythonBridgeWithEnv = env =>
  spawn('python3', ['agent-skill/stackprism-site-experience/scripts/stackprism_bridge.py'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, STACKPRISM_BRIDGE_NO_OPEN: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })

const readFirstStdoutJson = async child => {
  const [chunk] = await once(child.stdout, 'data')
  return JSON.parse(String(chunk).trim())
}

const listenOnLoopback = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })

const pythonOneShot = script => {
  const result = spawnSync('python3', ['-c', `import json\n${script}`], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      STACKPRISM_BRIDGE_NO_OPEN: '1',
      PYTHONPATH: 'agent-skill/stackprism-site-experience/scripts',
      PYTHONWARNINGS: 'ignore'
    },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('python fallback prints ready json and serves health', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    assert.equal(ready.event, 'stackprism-bridge-ready')
    assert.match(ready.apiToken, /^spb_[A-Za-z0-9_-]{43}$/)
    const health = await readJson(await fetch(ready.healthUrl))
    assert.equal(health.status, 200)
    assert.equal(health.body.service, 'stackprism-agent-bridge')
    assert.equal(health.body.protocolVersion, 1)
    const resourcePolicy = await pythonOneShot(`
from stackprism_bridge_lib.server_factory import create_server
server, _ready = create_server(0)
print(json.dumps({
    "request_queue_size": server.request_queue_size,
    "timeout": server.timeout,
    "create_limit": server.rate_limits["create"],
    "query_limit": server.rate_limits["query"],
}, sort_keys=True))
server.server_close()
`)
    assert.equal(resourcePolicy.request_queue_size, 20)
    assert.equal(resourcePolicy.timeout, 10)
    assert.equal(resourcePolicy.create_limit, 10)
    assert.equal(resourcePolicy.query_limit, 120)
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback exits when stdin closes', async () => {
  const { child } = await startPythonBridge()
  child.stdin.end()
  const [code] = await once(child, 'exit')
  assert.equal(code, 0)
})

test('python fallback exits and closes listener on SIGTERM', async () => {
  const { child, ready } = await startPythonBridge()
  const health = await readJson(await fetch(ready.healthUrl))
  assert.equal(health.status, 200)

  child.kill('SIGTERM')
  const [code] = await once(child, 'exit')

  assert.equal(code, 0)
  await assert.rejects(() => fetch(ready.healthUrl), /fetch failed/)
})

test('python fallback rate limits capture creation and api status reads', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.server_factory import create_server
import json
import threading
import urllib.error
import urllib.request

server, ready = create_server(0, rate_limits={"createLimitPerMinute": 1, "queryLimitPerMinute": 1})
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

request_body = json.dumps(${JSON.stringify(request)}).encode("utf-8")

def call(method, path, token, body=None):
    req = urllib.request.Request(
        ready["baseUrl"] + path,
        data=body,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))

try:
    first_status, first = call("POST", "/v1/captures", ready["apiToken"], request_body)
    second_status, second = call("POST", "/v1/captures", ready["apiToken"])
    query1_status, query1 = call("GET", "/v1/captures/" + first["id"], ready["apiToken"])
    query2_status, query2 = call("GET", "/v1/captures/" + first["id"], ready["apiToken"])
    print(json.dumps({
        "first_status": first_status,
        "second_status": second_status,
        "second_code": second["error"]["code"],
        "query1_status": query1_status,
        "query2_status": query2_status,
        "query2_code": query2["error"]["code"],
    }, sort_keys=True))
finally:
    server.shutdown()
    server.server_close()
`)
  assert.equal(parsed.first_status, 200)
  assert.equal(parsed.second_status, 429)
  assert.equal(parsed.second_code, 'RATE_LIMITED')
  assert.equal(parsed.query1_status, 200)
  assert.equal(parsed.query2_status, 429)
  assert.equal(parsed.query2_code, 'RATE_LIMITED')
})

test('python fallback rate limits api profile reads', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.server_factory import create_server
import json
import threading
import urllib.error
import urllib.request

server, ready = create_server(0, rate_limits={"queryLimitPerMinute": 1})
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

request_body = json.dumps(${JSON.stringify(request)}).encode("utf-8")

def call(method, path, token, body=None):
    req = urllib.request.Request(
        ready["baseUrl"] + path,
        data=body,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read().decode("utf-8")), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8")), dict(exc.headers)

try:
    create_status, created, _create_headers = call("POST", "/v1/captures", ready["apiToken"], request_body)
    profile1_status, profile1, profile1_headers = call("GET", "/v1/captures/" + created["id"] + "/profile", ready["apiToken"])
    profile2_status, profile2, _profile2_headers = call("GET", "/v1/captures/" + created["id"] + "/profile", ready["apiToken"])
    print(json.dumps({
        "create_status": create_status,
        "profile1_status": profile1_status,
        "profile1_code": profile1["error"]["code"],
        "profile1_referrer_policy": profile1_headers.get("Referrer-Policy"),
        "profile2_status": profile2_status,
        "profile2_code": profile2["error"]["code"],
    }, sort_keys=True))
finally:
    server.shutdown()
    server.server_close()
`)
  assert.equal(parsed.create_status, 200)
  assert.equal(parsed.profile1_status, 409)
  assert.equal(parsed.profile1_code, 'INVALID_REQUEST')
  assert.equal(parsed.profile1_referrer_policy, 'no-referrer')
  assert.equal(parsed.profile2_status, 429)
  assert.equal(parsed.profile2_code, 'RATE_LIMITED')
})

test('python fallback uses random port only when unset and reports occupied port portably', async () => {
  const child = startPythonBridgeWithEnv({})
  try {
    const ready = await readFirstStdoutJson(child)
    assert.equal(ready.event, 'stackprism-bridge-ready')
    assert.match(ready.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }

  const invalid = startPythonBridgeWithEnv({ STACKPRISM_BRIDGE_PORT: '' })
  let invalidStdout = ''
  invalid.stdout.on('data', chunk => {
    invalidStdout += String(chunk)
  })
  const [invalidStderr] = await once(invalid.stderr, 'data')
  const invalidParsed = JSON.parse(String(invalidStderr).trim())
  assert.equal(invalidParsed.error.code, 'BRIDGE_INVALID_ENV')
  assert.equal(invalidStdout, '')
  assert.equal(String(invalidStderr).includes('spb_'), false)
  const [invalidCode] = await once(invalid, 'exit')
  assert.notEqual(invalidCode, 0)

  const occupied = await listenOnLoopback()
  const { port } = occupied.address()
  const blocked = startPythonBridgeWithEnv({ STACKPRISM_BRIDGE_PORT: String(port) })
  let blockedStdout = ''
  blocked.stdout.on('data', chunk => {
    blockedStdout += String(chunk)
  })
  try {
    const [stderr] = await once(blocked.stderr, 'data')
    const parsed = JSON.parse(String(stderr).trim())
    assert.equal(parsed.error.code, 'PORT_IN_USE')
    assert.equal(blockedStdout, '')
    assert.equal(String(stderr).includes('spb_'), false)
    const [code] = await once(blocked, 'exit')
    assert.notEqual(code, 0)
  } finally {
    await new Promise(resolve => occupied.close(resolve))
  }
})

test('python fallback server factory validates browser open environment before binding', () => {
  const parsed = pythonOneShot(`
import json as json_module
from stackprism_bridge_lib.server_factory import create_server
results = []
for env in (
    {"STACKPRISM_BROWSER_OPEN_COMMAND": "bad\\0cmd"},
    {"STACKPRISM_BROWSER_OPEN_COMMAND": "python3", "STACKPRISM_BROWSER_OPEN_ARGS_JSON": json_module.dumps(["bad\\0arg"])},
):
    try:
        server, _ready = create_server(0, env=env)
    except ValueError as exc:
        results.append({"code": getattr(exc, "code", None), "message": str(exc)})
    else:
        server.server_close()
        raise AssertionError("create_server accepted invalid browser open environment")
print(json.dumps(results))
`)
  assert.deepEqual(
    parsed.map(item => item.code),
    ['BRIDGE_INVALID_ENV', 'BRIDGE_INVALID_ENV']
  )
  assert.equal(
    parsed.every(item => /Browser open environment contains NUL/.test(item.message)),
    true
  )
})

test('python fallback creates captures with same basic error envelope', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const unauthorized = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      })
    )
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.body.error.code, 'UNAUTHORIZED')

    const created = await createCapture(ready)
    assert.equal(created.status, 200)
    assert.match(created.body.id, /^cap_[A-Za-z0-9_-]{22}$/)
    assert.equal(created.body.status, 'queued')
    assert.deepEqual([...new URL(created.body.bridgeUrl).searchParams.keys()].sort(), ['capture', 'nonce', 'session'])
    assert.equal(created.body.bridgeUrl.includes(ready.apiToken), false)
    assert.equal(created.body.bridgeUrl.includes('apiToken'), false)
    assert.equal(created.body.bridgeUrl.includes('bridgeToken'), false)
    assert.doesNotMatch(created.body.bridgeUrl, /spbt?_[A-Za-z0-9_-]{20,}/)
    const status = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
        headers: { Authorization: `Bearer ${ready.apiToken}` }
      })
    )
    assert.equal(status.status, 200)
    assert.equal('error' in status.body, false)
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback protocol helpers cover all bridge identifier kinds', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.protocol import html_escape_script_json, new_csp_nonce, random_id, redact_url, safe_equal, valid_id
from stackprism_bridge_lib.status import validate_status_update
values = {
    "apiToken": random_id("spb_", 32),
    "bridgeToken": random_id("spbt_", 32),
    "captureId": random_id("cap_", 16),
    "sessionId": random_id("s_", 16),
    "nonce": random_id("n_", 16),
    "profileTransferId": random_id("xfer_", 16),
    "cspNonce": new_csp_nonce(),
}
print(json.dumps({
    "valid": {kind: valid_id(kind, value) for kind, value in values.items()},
    "unknown": valid_id("unknown", values["apiToken"]),
    "redacted": redact_url("https://example.com/app?token=secret#frag"),
    "safe_equal_same": safe_equal("same-token", "same-token"),
    "safe_equal_short": safe_equal("same-token", "same"),
    "safe_equal_long_tail": safe_equal("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaax", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaay"),
    "missing_phase_validation": validate_status_update(
        {"id": values["captureId"], "sessionId": values["sessionId"], "nonce": values["nonce"], "status": "running", "sequence": 1},
        {
            "captureId": values["captureId"],
            "sessionId": values["sessionId"],
            "nonce": values["nonce"],
            "protocolVersion": 1,
            "status": "running",
            "phase": "request_loaded",
            "sequence": 2,
        },
    )[0],
    "escaped": html_escape_script_json({"value": "</script><script>alert(1)</script>&\\u2028\\u2029"}),
}, sort_keys=True))
`)
  assert.deepEqual(parsed.valid, {
    apiToken: true,
    bridgeToken: true,
    captureId: true,
    sessionId: true,
    nonce: true,
    profileTransferId: true,
    cspNonce: true
  })
  assert.equal(parsed.unknown, false)
  assert.equal(parsed.redacted, 'https://example.com/app?[redacted]')
  assert.equal(parsed.safe_equal_same, true)
  assert.equal(parsed.safe_equal_short, false)
  assert.equal(parsed.safe_equal_long_tail, false)
  assert.equal(parsed.missing_phase_validation, true)
  assert.equal(parsed.escaped.includes('</script>'), false)
  assert.equal(parsed.escaped.includes('<script>'), false)
  assert.equal(parsed.escaped.includes('&'), false)
  assert.match(parsed.escaped, /\\u2028/)
  assert.match(parsed.escaped, /\\u2029/)
})

test('python fallback validates documented identifier fixtures', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.protocol import valid_id
identifiers = ${JSON.stringify(identifiers)}
results = {}
for kind, examples in identifiers.items():
    results[kind] = {
        "valid": [valid_id(kind, value) for value in examples["valid"]],
        "invalid": [valid_id(kind, value) for value in examples["invalid"]],
    }
print(json.dumps(results, sort_keys=True))
`)

  for (const [kind, results] of Object.entries(parsed)) {
    assert.deepEqual(
      results.valid,
      identifiers[kind].valid.map(() => true),
      `${kind} valid fixtures should pass`
    )
    assert.deepEqual(
      results.invalid,
      identifiers[kind].invalid.map(() => false),
      `${kind} invalid fixtures should fail`
    )
  }
})

test('python fallback open-browser helper validates env and URL before spawning', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.open_browser import open_browser

checks = {
    "nul_env": open_browser("http://127.0.0.1:1/bridge", {"STACKPRISM_BROWSER_OPEN_COMMAND": "bad\\0cmd"}),
    "nul_json_args": open_browser(
        "http://127.0.0.1:1/bridge",
        {"STACKPRISM_BROWSER_OPEN_COMMAND": "python3", "STACKPRISM_BROWSER_OPEN_ARGS_JSON": json.dumps(["bad\\0arg"])},
    ),
    "invalid_url": open_browser("http://127.0.0.1:1/bridge\\nnext", {"STACKPRISM_BRIDGE_NO_OPEN": "1"}),
    "missing_command": open_browser("http://127.0.0.1:1/bridge", {"STACKPRISM_BROWSER_OPEN_COMMAND": "/definitely/missing/stackprism-browser"}),
}
print(json.dumps({name: result for name, result in checks.items()}, sort_keys=True))
`)
  assert.deepEqual(parsed.nul_env, [false, { reason: 'BRIDGE_INVALID_ENV', message: 'Browser open environment contains NUL.' }])
  assert.deepEqual(parsed.nul_json_args, [false, { reason: 'BRIDGE_INVALID_ENV', message: 'Browser open environment contains NUL.' }])
  assert.deepEqual(parsed.invalid_url, [false, { reason: 'invalid_url' }])
  assert.deepEqual(parsed.missing_command, [false, { reason: 'command_not_found' }])
})

test('python fallback open-browser helper appends bridge URL as one argv', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stackprism-open-'))
  const argvPath = join(tempDir, 'argv.json')
  const bridgeUrl = 'http://127.0.0.1:17370/bridge?session=s&capture=c&nonce=n value"quote;&cmd=$(echo bad)'
  const script = 'import json, sys; open(sys.argv[1], "w").write(json.dumps(sys.argv[2:]))'

  try {
    const parsed = pythonOneShot(`
from stackprism_bridge_lib.open_browser import open_browser
print(json.dumps(open_browser(${JSON.stringify(bridgeUrl)}, {
    "STACKPRISM_BROWSER_OPEN_COMMAND": "python3",
    "STACKPRISM_BROWSER_OPEN_ARGS_JSON": json.dumps(["-c", ${JSON.stringify(script)}, ${JSON.stringify(argvPath)}]),
})))
`)

    assert.deepEqual(parsed, [true, {}])
    assert.deepEqual(JSON.parse(readFileSync(argvPath, 'utf8')), [bridgeUrl])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('python fallback bridge page has CSP nonce and script-safe config', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const { response, html } = await loadBridgePage(created.body.bridgeUrl)
    const csp = response.headers.get('content-security-policy')
    const cspNonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1]

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin')
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    assert.equal(csp.includes('unsafe-inline'), false)
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /connect-src 'self'/)
    assert.match(csp, /base-uri 'none'/)
    assert.match(csp, /form-action 'none'/)
    assert.ok(cspNonce)
    assert.match(csp, new RegExp(`style-src 'nonce-${cspNonce}'`))
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.match(html, new RegExp(`id="stackprism-agent-bridge-config" type="application/json" nonce="${cspNonce}"`))
    assert.match(html, new RegExp(`<script nonce="${cspNonce}"`))
    assert.match(html, /fetch\('\/v1\/captures\/'\+config\.captureId/)
    assert.match(html, /textContent=value/)
    assert.match(html, /"bridgeToken":"spbt_[A-Za-z0-9_-]{43}"/)

    const second = await readJson(await fetch(created.body.bridgeUrl))
    assert.equal(second.status, 409)
    assert.equal(second.body.error.code, 'INVALID_REQUEST')
    assert.doesNotMatch(JSON.stringify(second.body), /spbt_[A-Za-z0-9_-]{43}/)
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback bridge page rejects cross-site navigation before token render', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)

    const blockedReferer = await fetch(created.body.bridgeUrl, { headers: { Referer: 'https://attacker.example/page' } })
    const blockedRefererText = await blockedReferer.text()
    assert.equal(blockedReferer.status, 403)
    assert.match(blockedRefererText, /ORIGIN_NOT_ALLOWED/)
    assert.doesNotMatch(blockedRefererText, /spbt_[A-Za-z0-9_-]{43}/)

    const blockedFetchSite = await fetch(created.body.bridgeUrl, { headers: { 'Sec-Fetch-Site': 'cross-site' } })
    const blockedFetchSiteText = await blockedFetchSite.text()
    assert.equal(blockedFetchSite.status, 403)
    assert.match(blockedFetchSiteText, /ORIGIN_NOT_ALLOWED/)
    assert.doesNotMatch(blockedFetchSiteText, /spbt_[A-Za-z0-9_-]{43}/)

    const firstAllowed = await fetch(created.body.bridgeUrl)
    const firstAllowedText = await firstAllowed.text()
    assert.equal(firstAllowed.status, 200)
    assert.match(firstAllowedText, /"bridgeToken":"spbt_[A-Za-z0-9_-]{43}"/)

    const secondAllowed = await readJson(await fetch(created.body.bridgeUrl))
    assert.equal(secondAllowed.status, 409)
    assert.equal(secondAllowed.body.error.code, 'INVALID_REQUEST')
    assert.doesNotMatch(JSON.stringify(secondAllowed.body), /spbt_[A-Za-z0-9_-]{43}/)
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback bridge page does not reflect hostile query fragments or error messages', () => {
  const parsed = pythonOneShot(`
import re
import threading
import urllib.error
import urllib.parse
import urllib.request

from stackprism_bridge_lib.server_factory import create_server

hostile = "</script><script>alert(1)</script>#stackprism-fragment"

def request_text(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")

def request_json(method, url, token=None, body=None):
    headers = {}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))

def make_capture(ready):
    capture_request = {
        "url": "https://93.184.216.34/app?view=one#frag",
        "mode": "experience",
        "waitMs": 0,
        "include": ["tech"],
        "viewports": [],
        "options": {"targetMode": "reuse_or_new_tab"},
    }
    _, created = request_json("POST", f"{ready['baseUrl']}/v1/captures", ready["apiToken"], capture_request)
    return created

server, ready = create_server(0)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    created = make_capture(ready)
    hostile_url = created["bridgeUrl"] + "&unexpected=" + urllib.parse.quote(hostile) + "#" + urllib.parse.quote(hostile)
    invalid_status, invalid_html = request_text(hostile_url)

    capture = server.store.get(created["id"])
    capture["status"] = "failed"
    capture["phase"] = "cleanup"
    capture["error"] = {"code": "TARGET_TAB_CLOSED", "message": hostile}
    terminal_status, terminal_html = request_text(created["bridgeUrl"])

    print(json.dumps({
        "invalidStatus": invalid_status,
        "invalidHasCode": "INVALID_REQUEST" in invalid_html,
        "invalidHasFragment": "stackprism-fragment" in invalid_html,
        "invalidHasScript": "<script>alert(1)</script>" in invalid_html,
        "invalidHasToken": bool(re.search(r"spbt_[A-Za-z0-9_-]{43}", invalid_html)),
        "terminalStatus": terminal_status,
        "terminalHasCode": "TARGET_TAB_CLOSED" in terminal_html,
        "terminalHasFragment": "stackprism-fragment" in terminal_html,
        "terminalHasScript": "<script>alert(1)</script>" in terminal_html,
        "terminalHasToken": bool(re.search(r"spbt_[A-Za-z0-9_-]{43}", terminal_html)),
    }, sort_keys=True))
finally:
    server.shutdown()
    server.server_close()
`)
  assert.equal(parsed.invalidStatus, 400)
  assert.equal(parsed.invalidHasCode, true)
  assert.equal(parsed.invalidHasFragment, false)
  assert.equal(parsed.invalidHasScript, false)
  assert.equal(parsed.invalidHasToken, false)
  assert.equal(parsed.terminalStatus, 409)
  assert.equal(parsed.terminalHasCode, true)
  assert.equal(parsed.terminalHasFragment, false)
  assert.equal(parsed.terminalHasScript, false)
  assert.equal(parsed.terminalHasToken, false)
})

test('python fallback reports browser open failure during capture creation', async () => {
  const child = startPythonBridgeWithEnv({
    STACKPRISM_BRIDGE_NO_OPEN: '0',
    STACKPRISM_BROWSER_OPEN_COMMAND: '/definitely/missing/stackprism-browser'
  })
  try {
    const ready = await readFirstStdoutJson(child)
    const rejected = await createCapture(ready)
    assert.equal(rejected.status, 500)
    assert.equal(rejected.body.error.code, 'BROWSER_OPEN_FAILED')
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback reports invalid browser open args during capture creation', async t => {
  const cases = [
    ['invalid_json', '{'],
    ['non_array', JSON.stringify({ profile: 'Default' })],
    ['non_string_arg', JSON.stringify(['--profile-directory=Default', 42])]
  ]

  for (const [name, argsJson] of cases) {
    await t.test(name, async () => {
      const child = startPythonBridgeWithEnv({
        STACKPRISM_BRIDGE_NO_OPEN: '0',
        STACKPRISM_BROWSER_OPEN_COMMAND: 'python3',
        STACKPRISM_BROWSER_OPEN_ARGS_JSON: argsJson
      })
      try {
        const ready = await readFirstStdoutJson(child)
        const rejected = await createCapture(ready)
        assert.equal(rejected.status, 500)
        assert.equal(rejected.body.error.code, 'BROWSER_OPEN_FAILED')
        assert.deepEqual(rejected.body.error.details, { reason: 'invalid_open_args' })
      } finally {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
    })
  }
})

test('python fallback bridge token can fetch request and post profile', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)

    const status = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
        headers: { Authorization: `Bearer ${ready.apiToken}` }
      })
    )
    assert.equal(status.status, 200)
    assertJsonSecurityHeaders(status)

    const requestEnvelope = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/request`, {
        headers: { Authorization: `Bearer ${config.bridgeToken}` }
      })
    )
    assert.equal(requestEnvelope.status, 200)
    assertJsonSecurityHeaders(requestEnvelope)
    assert.equal(requestEnvelope.body.captureId, created.body.id)
    assert.equal(requestEnvelope.body.request.url, 'https://93.184.216.34/app?view=one')
    assert.deepEqual(Object.keys(requestEnvelope.body).sort(), ['captureId', 'nonce', 'protocolVersion', 'request', 'sessionId'])

    const control = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/control`, {
        headers: { Authorization: `Bearer ${config.bridgeToken}` }
      })
    )
    assert.equal(control.status, 200)
    assertJsonSecurityHeaders(control)

    await acceptFinalUrl(ready, created.body.id, config.bridgeToken)

    const profile = profileFor(created.body.id)
    const posted = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      })
    )
    assert.equal(posted.status, 200)
    assertJsonSecurityHeaders(posted)
    assert.equal(posted.body.status, 'completed')

    const completedControl = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/control`, {
        headers: { Authorization: `Bearer ${config.bridgeToken}` }
      })
    )
    assert.equal(completedControl.status, 200)
    assert.equal(completedControl.body.command, 'cancel')
    assert.equal(completedControl.body.status, 'completed')

    const forbidden = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        headers: { Authorization: `Bearer ${config.bridgeToken}` }
      })
    )
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.body.error.code, 'BRIDGE_TOKEN_CANNOT_READ_PROFILE')
    assertJsonSecurityHeaders(forbidden, { referrerPolicy: true })

    const fetched = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        headers: { Authorization: `Bearer ${ready.apiToken}` }
      })
    )
    assert.equal(fetched.status, 200)
    assertJsonSecurityHeaders(fetched, { referrerPolicy: true })
    assert.equal(fetched.body.schema, 'stackprism.site_experience_profile.v1')
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback rejects repeated and oversized profile submissions', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const profile = profileFor(created.body.id)
    await acceptFinalUrl(ready, created.body.id, config.bridgeToken)

    const posted = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      })
    )
    assert.equal(posted.status, 200)

    const repeated = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      })
    )
    assert.equal(repeated.status, 409)
    assert.equal(repeated.body.error.code, 'CAPTURE_ALREADY_COMPLETED')

    const url = new URL(ready.baseUrl)
    const repeatedOversized = await rawHttp(url.port, [
      `POST /v1/captures/${created.body.id}/profile HTTP/1.1`,
      `Host: ${url.host}`,
      `Authorization: Bearer ${config.bridgeToken}`,
      'Content-Type: application/json',
      `Content-Length: ${8 * 1024 * 1024 + 1}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(repeatedOversized, /409/)
    assert.match(repeatedOversized, /CAPTURE_ALREADY_COMPLETED/)

    const oversized = await createCapture(ready)
    assert.equal(oversized.status, 200)
    const oversizedConfig = await loadBridgeConfig(oversized.body.bridgeUrl)
    await acceptFinalUrl(ready, oversized.body.id, oversizedConfig.bridgeToken)
    const rejected = await rawHttp(url.port, [
      `POST /v1/captures/${oversized.body.id}/profile HTTP/1.1`,
      `Host: ${url.host}`,
      `Authorization: Bearer ${oversizedConfig.bridgeToken}`,
      'Content-Type: application/json',
      `Content-Length: ${8 * 1024 * 1024 + 1}`,
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(rejected, /413/)
    assert.match(rejected, /PROFILE_TOO_LARGE/)
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback serializes concurrent profile submissions for one capture', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const profile = profileFor(created.body.id)
    const profileText = JSON.stringify(profile)
    const url = new URL(ready.baseUrl)
    await acceptFinalUrl(ready, created.body.id, config.bridgeToken)

    const slowPost = rawHttpSplitBody(
      url.port,
      [
        `POST /v1/captures/${created.body.id}/profile HTTP/1.1`,
        `Host: ${url.host}`,
        `Authorization: Bearer ${config.bridgeToken}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(profileText)}`,
        'Connection: close',
        '',
        ''
      ],
      profileText,
      64,
      150
    ).then(parseRawJsonResponse)

    await new Promise(resolve => setTimeout(resolve, 30))

    const fastPost = fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(profile)
    })

    const results = await Promise.all([slowPost, fastPost.then(response => readJson(response))])
    const statuses = results.map(result => result.status).sort()
    assert.deepEqual(statuses, [200, 409])
    assert.equal(results.find(result => result.status === 409).body.error.code, 'CAPTURE_ALREADY_COMPLETED')
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback bridge token can read capture control', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)

    const control = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/control`, {
        headers: { Authorization: `Bearer ${config.bridgeToken}` }
      })
    )
    assert.equal(control.status, 200)
    assert.equal(control.body.id, created.body.id)
    assert.equal(control.body.command, 'continue')
    assert.equal(control.body.status, 'queued')

    const cancel = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ready.apiToken}` }
      })
    )
    assert.equal(cancel.status, 200)
    assert.equal(cancel.body.status, 'cancel_requested')

    const missingCancel = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/cap_AAAAAAAAAAAAAAAAAAAAAA`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ready.apiToken}` }
      })
    )
    assert.equal(missingCancel.status, 404)
    assert.equal(missingCancel.body.error.code, 'NOT_FOUND')

    const cancelControl = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/control`, {
        headers: { Authorization: `Bearer ${config.bridgeToken}` }
      })
    )
    assert.equal(cancelControl.status, 200)
    assert.equal(cancelControl.body.command, 'cancel')
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback bridge page does not render tokens after extension connect timeout', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.server_factory import create_server
import json
import re
import threading
import urllib.error
import urllib.request

clock = {"now": 1000.0}

def now():
    return clock["now"]

def request_json(method, url, token=None, body=None):
    headers = {}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")

server, ready = create_server(0, now=now)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    _, created_body = request_json("POST", f"{ready['baseUrl']}/v1/captures", ready["apiToken"], ${JSON.stringify(request)})
    created = json.loads(created_body)
    clock["now"] = 1000.0 + 31
    expired_status, expired_html = request_json("GET", created["bridgeUrl"])
    print(json.dumps({
        "status": expired_status,
        "has_token": bool(re.search(r"spbt_[A-Za-z0-9_-]{43}", expired_html)),
        "body": expired_html,
    }, sort_keys=True))
finally:
    server.shutdown()
    server.server_close()
`)
  assert.equal(parsed.status, 409)
  assert.equal(parsed.has_token, false)
  assert.match(parsed.body, /EXTENSION_NOT_CONNECTED/)
})

test('python fallback bridge page and profile endpoint do not render tokens after completed result TTL expiry', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.server_factory import create_server
import json
import re
import threading
import urllib.error
import urllib.request
from html import unescape

clock = {"now": 1000.0}

def now():
    return clock["now"]

def request_json(method, url, token=None, body=None):
    headers = {}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            text = response.read().decode("utf-8")
            parsed = json.loads(text) if text and response.headers.get("content-type", "").startswith("application/json") else None
            return response.status, parsed, text
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        return error.code, parsed, text

def bridge_config(html):
    match = re.search(r'<script id="stackprism-agent-bridge-config" type="application/json" nonce="[^"]+">([^<]+)</script>', html)
    if not match:
        raise AssertionError("missing bridge config")
    return json.loads(unescape(match.group(1)))

def status_body(created, config, body):
    return {
        "captureId": created["id"],
        "sessionId": config["sessionId"],
        "nonce": config["nonce"],
        "protocolVersion": 1,
        **body,
    }

server, ready = create_server(0, now=now)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    _status, created, _text = request_json("POST", f"{ready['baseUrl']}/v1/captures", ready["apiToken"], ${JSON.stringify(request)})
    _bridge_status, _bridge_body, bridge_text = request_json("GET", created["bridgeUrl"])
    config = bridge_config(bridge_text)
    request_status, _request_envelope, _request_text = request_json("GET", f"{ready['baseUrl']}/v1/captures/{created['id']}/request", config["bridgeToken"])
    final_status, _final_body, _final_text = request_json(
        "POST",
        f"{ready['baseUrl']}/v1/captures/{created['id']}/status",
        config["bridgeToken"],
        status_body(created, config, {"status": "running", "phase": "target_loaded", "sequence": 1, "finalUrl": ${JSON.stringify(request.url)}, "targetNetworkAddress": "93.184.216.34"}),
    )
    profile = ${JSON.stringify(profileFor('__CAPTURE_ID__'))}
    profile["captureId"] = created["id"]
    posted_status, posted_body, _posted_text = request_json(
        "POST",
        f"{ready['baseUrl']}/v1/captures/{created['id']}/profile",
        config["bridgeToken"],
        profile,
    )
    capture = server.store.get(created["id"])
    clock["now"] = capture["resultExpiresAt"] + 1
    expired_profile_status, expired_profile_body, _expired_profile_text = request_json(
        "GET",
        f"{ready['baseUrl']}/v1/captures/{created['id']}/profile",
        ready["apiToken"],
    )
    expired_page_status, _expired_page_body, expired_page_text = request_json("GET", created["bridgeUrl"])
    print(json.dumps({
        "request_status": request_status,
        "final_status": final_status,
        "posted_status": posted_status,
        "posted_capture_status": posted_body.get("status"),
        "expired_profile_status": expired_profile_status,
        "expired_profile_code": expired_profile_body["error"]["code"],
        "expired_page_status": expired_page_status,
        "expired_page_has_code": "CAPTURE_RESULT_EXPIRED" in expired_page_text,
        "expired_page_has_token": bool(re.search(r"spbt_[A-Za-z0-9_-]{43}", expired_page_text)),
    }, sort_keys=True))
finally:
    server.shutdown()
    server.server_close()
`)
  assert.equal(parsed.request_status, 200)
  assert.equal(parsed.final_status, 200)
  assert.equal(parsed.posted_status, 200)
  assert.equal(parsed.posted_capture_status, 'completed')
  assert.equal(parsed.expired_profile_status, 410)
  assert.equal(parsed.expired_profile_code, 'CAPTURE_RESULT_EXPIRED')
  assert.equal(parsed.expired_page_status, 410)
  assert.equal(parsed.expired_page_has_code, true)
  assert.equal(parsed.expired_page_has_token, false)
})

test('python fallback requires api token to cancel captures', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)

    const forbidden = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${config.bridgeToken}` }
      })
    )
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.body.error.code, 'FORBIDDEN')

    const status = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
        headers: { Authorization: `Bearer ${ready.apiToken}` }
      })
    )
    assert.equal(status.status, 200)
    assert.equal(status.body.status, 'queued')
    assert.equal(status.body.phase, undefined)
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback rejects stale status sequences and phase regressions', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const statusUrl = `${ready.baseUrl}/v1/captures/${created.body.id}/status`

    const wrongIdentity = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(
            created.body.id,
            { ...config, nonce: `n_${'A'.repeat(22)}` },
            {
              status: 'waiting_extension',
              phase: 'bridge_connected',
              sequence: 1
            }
          )
        )
      })
    )
    assert.equal(wrongIdentity.status, 400)
    assert.equal(wrongIdentity.body.error.code, 'INVALID_REQUEST')

    const connected = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'waiting_extension', phase: 'bridge_connected', sequence: 1 }))
      })
    )
    assert.equal(connected.status, 200)
    assert.equal(connected.body.status, 'waiting_extension')
    assert.equal(connected.body.phase, 'bridge_connected')

    const running = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'running', phase: 'request_loaded', sequence: 2 }))
      })
    )
    assert.equal(running.status, 200)
    assert.equal(running.body.status, 'running')
    assert.equal(running.body.phase, 'request_loaded')

    const staleSequence = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'running', phase: 'target_opening', sequence: 2 }))
      })
    )
    assert.equal(staleSequence.status, 409)
    assert.equal(staleSequence.body.error.code, 'STALE_STATUS_UPDATE')

    const phaseRegression = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'running', phase: 'bridge_connected', sequence: 3 }))
      })
    )
    assert.equal(phaseRegression.status, 409)
    assert.equal(phaseRegression.body.error.code, 'STALE_STATUS_UPDATE')

    const nonRunningPhaseRegression = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'waiting_extension', phase: 'bridge_connected', sequence: 3 }))
      })
    )
    assert.equal(nonRunningPhaseRegression.status, 409)
    assert.equal(nonRunningPhaseRegression.body.error.code, 'STALE_STATUS_UPDATE')
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback restricts bridge-token terminal status updates', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const statusUrl = `${ready.baseUrl}/v1/captures/${created.body.id}/status`

    const cancelledWithoutDelete = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'cancelled', phase: 'cleanup', sequence: 1 }))
      })
    )
    assert.equal(cancelledWithoutDelete.status, 409)
    assert.equal(cancelledWithoutDelete.body.error.code, 'STALE_STATUS_UPDATE')

    const failedWithoutError = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'failed', phase: 'cleanup', sequence: 1 }))
      })
    )
    assert.equal(failedWithoutError.status, 400)
    assert.equal(failedWithoutError.body.error.code, 'INVALID_REQUEST')

    const failedWrongPhase = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(created.body.id, config, {
            status: 'failed',
            phase: 'target_opening',
            sequence: 1,
            error: { code: 'TARGET_TAB_CLOSED', message: 'Target closed.' }
          })
        )
      })
    )
    assert.equal(failedWrongPhase.status, 400)
    assert.equal(failedWrongPhase.body.error.code, 'INVALID_REQUEST')

    const failedUnknownCode = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(created.body.id, config, {
            status: 'failed',
            phase: 'cleanup',
            sequence: 1,
            error: { code: 'MADE_UP_ERROR', message: 'Unknown bridge error.' }
          })
        )
      })
    )
    assert.equal(failedUnknownCode.status, 400)
    assert.equal(failedUnknownCode.body.error.code, 'INVALID_REQUEST')

    const failedError = sensitiveFailedError(ready, created, config)
    const failed = await readJson(
      await fetch(statusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(created.body.id, config, {
            status: 'failed',
            phase: 'cleanup',
            sequence: 1,
            error: failedError
          })
        )
      })
    )
    assert.equal(failed.status, 200)
    assert.equal(failed.body.status, 'failed')
    assert.equal(failed.body.error.code, 'TARGET_TAB_CLOSED')
    assertErrorIsRedacted(failed.body.error, [ready.apiToken, config.bridgeToken, config.nonce])
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback rejects DELETE for every terminal capture state', () => {
  const parsed = pythonOneShot(`
import re
import threading
import urllib.error
import urllib.request

from stackprism_bridge_lib.server_factory import create_server

clock = {"now": 1000.0}

def now():
    return clock["now"]

def request_json(method, url, token=None, body=None):
    headers = {}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))

def bridge_config(bridge_url):
    with urllib.request.urlopen(bridge_url, timeout=3) as response:
        html = response.read().decode("utf-8")
    match = re.search(r'<script id="stackprism-agent-bridge-config" type="application/json" nonce="[^"]+">([^<]+)', html)
    return json.loads(match.group(1))

def status_body(capture_id, config, **values):
    body = {
        "captureId": capture_id,
        "sessionId": config["sessionId"],
        "nonce": config["nonce"],
        "protocolVersion": 1,
    }
    body.update(values)
    return body

def make_capture(ready):
    capture_request = {
        "url": "https://93.184.216.34/app?view=one#frag",
        "mode": "experience",
        "waitMs": 0,
        "include": ["tech"],
        "viewports": [],
        "options": {"targetMode": "reuse_or_new_tab"},
    }
    _, created = request_json("POST", f"{ready['baseUrl']}/v1/captures", ready["apiToken"], capture_request)
    return created

def accept_final_url(ready, capture_id, config):
    request_json("GET", f"{ready['baseUrl']}/v1/captures/{capture_id}/request", config["bridgeToken"])
    request_json(
        "POST",
        f"{ready['baseUrl']}/v1/captures/{capture_id}/status",
        config["bridgeToken"],
        status_body(capture_id, config, status="running", phase="target_loaded", sequence=1, finalUrl="https://93.184.216.34/app?view=one#frag", targetNetworkAddress="93.184.216.34"),
    )

def profile_for(capture_id):
    return {
        "schema": "stackprism.site_experience_profile.v1",
        "captureId": capture_id,
        "generatedAt": "1970-01-01T00:00:00.000Z",
        "target": {},
        "browserContext": {"extensionCapabilities": {}},
        "techProfile": {},
        "visualProfile": {},
        "layoutProfile": {},
        "componentProfile": {},
        "interactionProfile": {},
        "uxProfile": {},
        "assetProfile": {},
        "evidence": {},
        "limitations": [],
        "agentGuidance": {},
    }

def make_completed(ready):
    created = make_capture(ready)
    config = bridge_config(created["bridgeUrl"])
    accept_final_url(ready, created["id"], config)
    _, posted = request_json("POST", f"{ready['baseUrl']}/v1/captures/{created['id']}/profile", config["bridgeToken"], profile_for(created["id"]))
    assert posted["status"] == "completed"
    return created["id"]

def make_failed(ready):
    created = make_capture(ready)
    config = bridge_config(created["bridgeUrl"])
    _, failed = request_json(
        "POST",
        f"{ready['baseUrl']}/v1/captures/{created['id']}/status",
        config["bridgeToken"],
        status_body(
            created["id"],
            config,
            status="failed",
            phase="cleanup",
            sequence=1,
            error={"code": "TARGET_TAB_CLOSED", "message": "Target closed."},
        ),
    )
    assert failed["status"] == "failed"
    return created["id"]

def make_cancelled(ready):
    created = make_capture(ready)
    request_json("DELETE", f"{ready['baseUrl']}/v1/captures/{created['id']}", ready["apiToken"])
    clock["now"] += 11
    _, status = request_json("GET", f"{ready['baseUrl']}/v1/captures/{created['id']}", ready["apiToken"])
    assert status["status"] == "cancelled"
    return created["id"]

def make_expired(ready):
    capture_id = make_completed(ready)
    clock["now"] += 10 * 60 + 1
    _, status = request_json("GET", f"{ready['baseUrl']}/v1/captures/{capture_id}", ready["apiToken"])
    assert status["status"] == "expired"
    return capture_id

def assert_terminal_delete(ready, capture_id, expected_status):
    delete_status, deleted = request_json("DELETE", f"{ready['baseUrl']}/v1/captures/{capture_id}", ready["apiToken"])
    _, after = request_json("GET", f"{ready['baseUrl']}/v1/captures/{capture_id}", ready["apiToken"])
    return {
        "deleteStatus": delete_status,
        "errorCode": deleted["error"]["code"],
        "errorStatus": deleted["error"]["details"]["status"],
        "afterStatus": after["status"],
        "expectedStatus": expected_status,
    }

server, ready = create_server(0, now=now)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    results = [
        assert_terminal_delete(ready, make_completed(ready), "completed"),
        assert_terminal_delete(ready, make_failed(ready), "failed"),
        assert_terminal_delete(ready, make_cancelled(ready), "cancelled"),
        assert_terminal_delete(ready, make_expired(ready), "expired"),
    ]
    print(json.dumps(results, sort_keys=True))
finally:
    server.shutdown()
    server.server_close()
`)
  for (const result of parsed) {
    assert.equal(result.deleteStatus, 409)
    assert.equal(result.errorCode, 'INVALID_REQUEST')
    assert.equal(result.errorStatus, result.expectedStatus)
    assert.equal(result.afterStatus, result.expectedStatus)
  }
})

test('python fallback converts unconfirmed cancellation to terminal cancelled state', async () => {
  const script = `
import json
import re
import threading
import urllib.error
import urllib.request

from stackprism_bridge_lib.server_factory import create_server

clock = {"now": 1000.0}

def now():
    return clock["now"]

def request_json(method, url, token=None, body=None):
    headers = {}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))

server, ready = create_server(0, now=now)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    capture_request = {
        "url": "https://93.184.216.34/app?view=one#frag",
        "mode": "experience",
        "waitMs": 0,
        "include": ["tech"],
        "viewports": [],
        "options": {"targetMode": "reuse_or_new_tab"},
    }
    _, created = request_json("POST", f"{ready['baseUrl']}/v1/captures", ready["apiToken"], capture_request)
    with urllib.request.urlopen(created["bridgeUrl"], timeout=3) as response:
        html = response.read().decode("utf-8")
    config = json.loads(re.search(r'<script id="stackprism-agent-bridge-config" type="application/json" nonce="[^"]+">([^<]+)', html).group(1))
    _, cancel = request_json("DELETE", f"{ready['baseUrl']}/v1/captures/{created['id']}", ready["apiToken"])
    repeated_cancel_status, repeated_cancel = request_json("DELETE", f"{ready['baseUrl']}/v1/captures/{created['id']}", ready["apiToken"])
    running_after_cancel_status, running_after_cancel = request_json(
        "POST",
        f"{ready['baseUrl']}/v1/captures/{created['id']}/status",
        config["bridgeToken"],
        {
            "captureId": created["id"],
            "sessionId": config["sessionId"],
            "nonce": config["nonce"],
            "protocolVersion": 1,
            "status": "running",
            "phase": "target_opening",
            "sequence": 1,
        },
    )
    clock["now"] += 11
    _, status = request_json("GET", f"{ready['baseUrl']}/v1/captures/{created['id']}", ready["apiToken"])
    _, control = request_json("GET", f"{ready['baseUrl']}/v1/captures/{created['id']}/control", config["bridgeToken"])
    print(json.dumps({
        "cancel": cancel,
        "repeatedCancelStatus": repeated_cancel_status,
        "repeatedCancel": repeated_cancel,
        "runningAfterCancelStatus": running_after_cancel_status,
        "runningAfterCancel": running_after_cancel,
        "status": status,
        "control": control,
    }, sort_keys=True))
finally:
    server.shutdown()
    server.server_close()
`
  const result = spawnSync('python3', ['-c', script], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      STACKPRISM_BRIDGE_NO_OPEN: '1',
      PYTHONPATH: 'agent-skill/stackprism-site-experience/scripts',
      PYTHONWARNINGS: 'ignore'
    },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.cancel.status, 'cancel_requested')
  assert.equal(parsed.repeatedCancelStatus, 409)
  assert.equal(parsed.repeatedCancel.error.code, 'STALE_STATUS_UPDATE')
  assert.equal(parsed.repeatedCancel.error.details.status, 'cancel_requested')
  assert.equal(parsed.runningAfterCancelStatus, 409)
  assert.equal(parsed.runningAfterCancel.error.code, 'STALE_STATUS_UPDATE')
  assert.equal(parsed.status.status, 'cancelled')
  assert.equal(parsed.status.error.code, 'CAPTURE_TIMEOUT')
  assert.equal(parsed.status.error.details.reason, 'cancel_timeout')
  assert.equal(parsed.control.command, 'cancel')
  assert.equal(parsed.control.status, 'cancelled')
})

test('python fallback distinguishes extension, target load, and running timeouts', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.capture_store import CaptureStore
request = ${JSON.stringify(request)}
clock = {"now": 1000}
store = CaptureStore("http://127.0.0.1:17370", now=lambda: clock["now"], open_browser_fn=lambda _url: (True, {}))
queued, _status, _err = store.create(request)
clock["now"] = queued["extensionDeadlineAt"] + 1
store.active_count()
clock["now"] = 2000
target_opening, _status, _err = store.create(request)
target_opening["status"] = "running"
target_opening["phase"] = "target_opening"
clock["now"] = target_opening["deadlineAt"] + 1
store.active_count()
clock["now"] = 3000
running, _status, _err = store.create(request)
running["status"] = "running"
running["phase"] = "profiling_experience"
clock["now"] = running["deadlineAt"] + 1
store.active_count()
print(json.dumps({"queued": queued["error"]["code"], "target_opening": target_opening["error"]["code"], "running": running["error"]["code"]}, sort_keys=True))
`)
  assert.equal(parsed.queued, 'EXTENSION_NOT_CONNECTED')
  assert.equal(parsed.target_opening, 'TARGET_LOAD_TIMEOUT')
  assert.equal(parsed.running, 'CAPTURE_TIMEOUT')
})

test('python fallback does not timeout captures with missing optional deadlines', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.capture_store import CaptureStore
clock = {"now": 1000}
store = CaptureStore("http://127.0.0.1:17370", now=lambda: clock["now"], open_browser_fn=lambda _url: (True, {}))
queued = {"id": "cap_missing_deadlines", "status": "queued"}
running = {"id": "cap_missing_deadlines_2", "status": "running"}
store.expire_if_needed(queued)
store.expire_if_needed(running)
print(json.dumps({"queued": queued["status"], "running": running["status"]}, sort_keys=True))
`)
  assert.equal(parsed.queued, 'queued')
  assert.equal(parsed.running, 'running')
})

test('python fallback closes slow request bodies within the configured request timeout', () => {
  const parsed = pythonOneShot(`
import json
import socket
import threading
import time
import stackprism_bridge_lib.http_server as http_server
from stackprism_bridge_lib.server_factory import create_server

http_server.DEFAULT_REQUEST_TIMEOUT_SECONDS = 0.05
server, ready = create_server(0)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

started = time.monotonic()
received = b""
sock = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=1)
sock.settimeout(1)
try:
    request = "\\r\\n".join([
        "POST /v1/captures HTTP/1.1",
        f"Host: 127.0.0.1:{server.server_address[1]}",
        f"Authorization: Bearer {ready['apiToken']}",
        "Content-Type: application/json",
        "Content-Length: 64",
        "Connection: close",
        "",
        "{\\"url\\"",
    ]).encode("utf-8")
    sock.sendall(request)
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        received += chunk
finally:
    elapsed = time.monotonic() - started
    sock.close()
    server.shutdown()
    server.server_close()

print(json.dumps({"elapsed": elapsed, "response": received.decode("utf-8", "replace")}, sort_keys=True))
`)
  assert.ok(parsed.elapsed < 1, `slow body stayed open for ${parsed.elapsed}s`)
  assert.match(parsed.response, /400/)
  assert.match(parsed.response, /INVALID_JSON/)
})

test('python fallback returns invalid json for non-utf8 request bodies', () => {
  const parsed = pythonOneShot(`
import json
import socket
import threading
from stackprism_bridge_lib.server_factory import create_server

server, ready = create_server(0)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

body = b'{\"url\":\"\\xff\"}'
received = b""
sock = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=1)
sock.settimeout(1)
try:
    header = "\\r\\n".join([
        "POST /v1/captures HTTP/1.1",
        f"Host: 127.0.0.1:{server.server_address[1]}",
        f"Authorization: Bearer {ready['apiToken']}",
        "Content-Type: application/json",
        f"Content-Length: {len(body)}",
        "Connection: close",
        "",
        "",
    ]).encode("ascii")
    sock.sendall(header + body)
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        received += chunk
finally:
    sock.close()
    server.shutdown()
    server.server_close()

print(json.dumps({"response": received.decode("utf-8", "replace")}, sort_keys=True))
`)
  assert.match(parsed.response, /400/)
  assert.match(parsed.response, /INVALID_JSON/)
})

test('python fallback closes slow request headers within the configured request timeout', () => {
  const parsed = pythonOneShot(`
import json
import socket
import threading
import time
import stackprism_bridge_lib.http_server as http_server
from stackprism_bridge_lib.server_factory import create_server

http_server.DEFAULT_REQUEST_TIMEOUT_SECONDS = 0.05
server, _ready = create_server(0)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

started = time.monotonic()
received = b""
sock = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=1)
sock.settimeout(1)
try:
    sock.sendall(f"GET /health HTTP/1.1\\r\\nHost: 127.0.0.1:{server.server_address[1]}".encode("utf-8"))
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        received += chunk
finally:
    elapsed = time.monotonic() - started
    sock.close()
    server.shutdown()
    server.server_close()

print(json.dumps({"elapsed": elapsed, "response": received.decode("utf-8", "replace")}, sort_keys=True))
`)
  assert.ok(parsed.elapsed < 1, `slow headers stayed open for ${parsed.elapsed}s`)
  assert.doesNotMatch(parsed.response, /"ok": true/)
})

test('python fallback rejects connections beyond the configured active connection limit', () => {
  const parsed = pythonOneShot(`
import json
import socket
import threading
from stackprism_bridge_lib.server_factory import create_server

server, _ready = create_server(0, max_open_connections=2)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

first = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=1)
second = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=1)
third = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=1)
third.settimeout(1)
received = b""
try:
    third.sendall(f"GET /health HTTP/1.1\\r\\nHost: 127.0.0.1:{server.server_address[1]}\\r\\nConnection: close\\r\\n\\r\\n".encode("utf-8"))
    while True:
        chunk = third.recv(4096)
        if not chunk:
            break
        received += chunk
finally:
    first.close()
    second.close()
    third.close()
    server.shutdown()
    server.server_close()

print(json.dumps({"response": received.decode("utf-8", "replace")}, sort_keys=True))
`)
  assert.doesNotMatch(parsed.response, /"ok": true/)
})

test('python fallback body reader does not swallow unexpected programming errors', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.body import read_json_body

class Headers:
    def get(self, name, default=None):
        values = {
            "Content-Type": "application/json",
            "Content-Length": "2",
        }
        return values.get(name, default)

class Body:
    def read(self, _size):
        raise RuntimeError("unexpected test failure")

class Handler:
    headers = Headers()
    rfile = Body()
    failed = None
    def fail(self, status, code, message):
        self.failed = {"status": status, "code": code, "message": message}

handler = Handler()
try:
    read_json_body(handler, 1024, "REQUEST_TOO_LARGE")
    propagated = False
except RuntimeError:
    propagated = True
print(json.dumps({"propagated": propagated, "failed": handler.failed}, sort_keys=True))
`)
  assert.equal(parsed.propagated, true)
  assert.equal(parsed.failed, null)
})

test('python fallback body reader fails fast when content length exceeds limit', () => {
  const parsed = pythonOneShot(`
from stackprism_bridge_lib.body import read_json_body

class Headers:
    def get(self, name, default=None):
        values = {
            "Content-Type": "application/json",
            "Content-Length": "2048",
        }
        return values.get(name, default)

class Body:
    read_calls = 0
    def read(self, _size):
        self.read_calls += 1
        return b"x" * 16

class Handler:
    headers = Headers()
    rfile = Body()
    failed = None
    close_connection = False
    def fail(self, status, code, message):
        self.failed = {"status": status, "code": code, "message": message}

handler = Handler()
result = read_json_body(handler, 1024, "REQUEST_TOO_LARGE")
print(json.dumps({
    "result": result,
    "failed": handler.failed,
    "readCalls": handler.rfile.read_calls,
    "closeConnection": handler.close_connection,
}, sort_keys=True))
`)
  assert.equal(parsed.result, null)
  assert.deepEqual(parsed.failed, { status: 413, code: 'REQUEST_TOO_LARGE', message: 'Request body is too large.' })
  assert.equal(parsed.readCalls, 0)
  assert.equal(parsed.closeConnection, true)
})

test('python fallback rejects private, self-target, and cross-origin capture requests', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const credentialTarget = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ready.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, url: 'https://user:pass@example.com/app' })
      })
    )
    assert.equal(credentialTarget.status, 400)
    assert.equal(credentialTarget.body.error.code, 'INVALID_REQUEST')

    const invalidBooleanOption = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ready.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, options: { forceRefresh: 'true' } })
      })
    )
    assert.equal(invalidBooleanOption.status, 400)
    assert.equal(invalidBooleanOption.body.error.code, 'INVALID_REQUEST')

    const privateTarget = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ready.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, url: 'http://127.0.0.1:3000/' })
      })
    )
    assert.equal(privateTarget.status, 400)
    assert.equal(privateTarget.body.error.code, 'PRIVATE_NETWORK_TARGET_BLOCKED')

    const selfTarget = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ready.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, url: ready.baseUrl, options: { allowPrivateNetworkTarget: true } })
      })
    )
    assert.equal(selfTarget.status, 400)
    assert.equal(selfTarget.body.error.code, 'BRIDGE_SELF_TARGET_BLOCKED')

    const localhostSelfTarget = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ready.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...request,
          url: ready.baseUrl.replace('127.0.0.1', 'localhost'),
          options: { allowPrivateNetworkTarget: true }
        })
      })
    )
    assert.equal(localhostSelfTarget.status, 400)
    assert.equal(localhostSelfTarget.body.error.code, 'BRIDGE_SELF_TARGET_BLOCKED')

    const selfTargetPath = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ready.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, url: `${ready.baseUrl}/v1/captures`, options: { allowPrivateNetworkTarget: true } })
      })
    )
    assert.equal(selfTargetPath.status, 400)
    assert.equal(selfTargetPath.body.error.code, 'BRIDGE_SELF_TARGET_BLOCKED')

    const crossOrigin = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ready.apiToken}`, 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: JSON.stringify(request)
      })
    )
    assert.equal(crossOrigin.status, 403)
    assert.equal(crossOrigin.body.error.code, 'ORIGIN_NOT_ALLOWED')
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback rejects boolean numeric fields and overlong capture URLs', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const cases = [
      { body: { ...request, waitMs: true }, field: 'waitMs' },
      { body: { ...request, waitMs: null }, field: 'waitMs null' },
      { body: { ...request, viewports: null }, field: 'viewports null' },
      { body: { ...request, options: null }, field: 'options null' },
      { body: { ...request, options: false }, field: 'options boolean' },
      { body: { ...request, options: { targetMode: '' } }, field: 'targetMode empty' },
      { body: { ...request, options: { targetMode: 'reuse_or_new_tab', maxResourceUrls: true } }, field: 'maxResourceUrls' },
      { body: { ...request, viewports: [{ width: true, height: 900, deviceScaleFactor: 1 }] }, field: 'viewport width' },
      { body: { ...request, viewports: [{ name: 123, width: 1440, height: 900, deviceScaleFactor: 1 }] }, field: 'viewport name' },
      { body: { ...request, url: `https://example.com/${'a'.repeat(4100)}` }, field: 'url' }
    ]

    for (const item of cases) {
      const rejected = await readJson(
        await fetch(`${ready.baseUrl}/v1/captures`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ready.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(item.body)
        })
      )
      assert.equal(rejected.status, 400, item.field)
      assert.equal(rejected.body.error.code, 'INVALID_REQUEST', item.field)
    }
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback rejects cross-origin referer and fetch metadata', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const blockedBridge = await fetch(created.body.bridgeUrl, { headers: { Referer: 'https://attacker.example/page' } })
    const blockedBridgeText = await blockedBridge.text()
    assert.equal(blockedBridge.status, 403)
    assert.match(blockedBridgeText, /ORIGIN_NOT_ALLOWED/)
    assert.equal(blockedBridgeText.includes('spbt_'), false)

    const crossSiteCreate = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ready.apiToken}`,
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'cross-site'
        },
        body: JSON.stringify(request)
      })
    )
    assert.equal(crossSiteCreate.status, 403)
    assert.equal(crossSiteCreate.body.error.code, 'ORIGIN_NOT_ALLOWED')

    const crossSiteCancel = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ready.apiToken}`, Referer: 'https://attacker.example/page' }
      })
    )
    assert.equal(crossSiteCancel.status, 403)
    assert.equal(crossSiteCancel.body.error.code, 'ORIGIN_NOT_ALLOWED')

    const config = await loadBridgeConfig(created.body.bridgeUrl)
    assert.match(config.bridgeToken, /^spbt_[A-Za-z0-9_-]{43}$/)
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback rejects private final URLs before profile creation', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)

    const finalUrlStatus = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captureId: created.body.id,
          sessionId: config.sessionId,
          nonce: config.nonce,
          protocolVersion: 1,
          status: 'running',
          phase: 'target_loaded',
          sequence: 1,
          finalUrl: 'https://10.20.30.40/dashboard'
        })
      })
    )
    assert.equal(finalUrlStatus.status, 409)
    assert.equal(finalUrlStatus.body.error.code, 'FINAL_URL_BLOCKED')
    assert.equal(finalUrlStatus.body.error.details.reason, 'private_network_address')

    const status = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}`, {
        headers: { Authorization: `Bearer ${ready.apiToken}` }
      })
    )
    assert.equal(status.body.status, 'failed')
    assert.equal(status.body.phase, 'cleanup')
    assert.equal(status.body.error.code, 'FINAL_URL_BLOCKED')

    const lateProfile = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(profileFor(created.body.id))
      })
    )
    assert.equal(lateProfile.status, 409)
    assert.equal(lateProfile.body.error.code, 'STALE_STATUS_UPDATE')
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback rejects private browser-observed target addresses', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const status = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(created.body.id, config, {
            status: 'running',
            phase: 'target_loaded',
            sequence: 1,
            finalUrl: request.url,
            targetNetworkAddress: '127.0.0.1'
          })
        )
      })
    )
    assert.equal(status.status, 409)
    assert.equal(status.body.error.code, 'FINAL_URL_BLOCKED')
    assert.equal(status.body.error.details.reason, 'private_network_address')
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback rejects non-ip browser-observed target addresses', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)
    const status = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          statusBody(created.body.id, config, {
            status: 'running',
            phase: 'target_loaded',
            sequence: 1,
            finalUrl: request.url,
            targetNetworkAddress: 'example.com'
          })
        )
      })
    )
    assert.equal(status.status, 400)
    assert.equal(status.body.error.code, 'INVALID_REQUEST')
    assert.equal(status.body.error.details.reason, 'invalid_network_address')
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback requires accepted final URL before profile submission', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const created = await createCapture(ready)
    const config = await loadBridgeConfig(created.body.bridgeUrl)

    const missingFinalUrl = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody(created.body.id, config, { status: 'running', phase: 'target_loaded', sequence: 1 }))
      })
    )
    assert.equal(missingFinalUrl.status, 400)
    assert.equal(missingFinalUrl.body.error.code, 'INVALID_REQUEST')

    const earlyProfile = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures/${created.body.id}/profile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(profileFor(created.body.id))
      })
    )
    assert.equal(earlyProfile.status, 409)
    assert.equal(earlyProfile.body.error.code, 'INVALID_REQUEST')
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback rejects preflight and ambiguous raw request shell', async () => {
  const { child, ready } = await startPythonBridge()
  try {
    const options = await fetch(`${ready.baseUrl}/v1/captures`, { method: 'OPTIONS' })
    assert.equal(options.status, 405)
    assert.equal(options.headers.get('allow'), 'GET, POST, DELETE')
    assert.equal(options.headers.has('access-control-allow-origin'), false)

    const url = new URL(ready.baseUrl)
    const optionsWrongHost = await rawHttp(url.port, [
      'OPTIONS /v1/captures HTTP/1.1',
      `Host: localhost:${url.port}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(optionsWrongHost, /400/)
    assert.match(optionsWrongHost, /INVALID_REQUEST/)

    const wrongPortHost = await rawHttp(url.port, [
      'GET /health HTTP/1.1',
      `Host: 127.0.0.1:${Number(url.port) + 1}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(wrongPortHost, /400/)
    assert.match(wrongPortHost, /INVALID_REQUEST/)

    const missingHost = await rawHttp(url.port, ['GET /health HTTP/1.1', 'Connection: close', '', ''])
    assert.match(missingHost, /400/)
    assert.match(missingHost, /INVALID_REQUEST/)

    const ipv6Host = await rawHttp(url.port, ['GET /health HTTP/1.1', `Host: [::1]:${url.port}`, 'Connection: close', '', ''])
    assert.match(ipv6Host, /400/)
    assert.match(ipv6Host, /INVALID_REQUEST/)

    const duplicateHost = await rawHttp(url.port, [
      'GET /health HTTP/1.1',
      `Host: ${url.host}`,
      `Host: ${url.host}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(duplicateHost, /400/)
    assert.match(duplicateHost, /INVALID_REQUEST/)

    const absoluteForm = await rawHttp(url.port, [
      `GET http://127.0.0.1:${url.port}/health HTTP/1.1`,
      `Host: ${url.host}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(absoluteForm, /400/)
    assert.match(absoluteForm, /INVALID_REQUEST/)

    const authorityForm = await rawHttp(url.port, [
      `CONNECT 127.0.0.1:${url.port} HTTP/1.1`,
      `Host: ${url.host}`,
      'Connection: close',
      '',
      ''
    ])
    assert.match(authorityForm, /400/)
    assert.match(authorityForm, /INVALID_REQUEST/)

    const encodedSlashPath = await rawHttp(url.port, ['GET /v1%2fcaptures HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(encodedSlashPath, /400/)
    assert.match(encodedSlashPath, /INVALID_REQUEST/)

    const encodedBackslashPath = await rawHttp(url.port, ['GET /v1%5ccaptures HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(encodedBackslashPath, /400/)
    assert.match(encodedBackslashPath, /INVALID_REQUEST/)

    const dotSegmentPath = await rawHttp(url.port, ['GET /v1/../health HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(dotSegmentPath, /400/)
    assert.match(dotSegmentPath, /INVALID_REQUEST/)

    const emptySegmentPath = await rawHttp(url.port, ['GET /v1//captures HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(emptySegmentPath, /400/)
    assert.match(emptySegmentPath, /INVALID_REQUEST/)

    const unexpectedQuery = await rawHttp(url.port, ['GET /health?x=1 HTTP/1.1', `Host: ${url.host}`, 'Connection: close', '', ''])
    assert.match(unexpectedQuery, /400/)
    assert.match(unexpectedQuery, /INVALID_REQUEST/)

    const created = await createCapture(ready)
    const percentEncodedSession = await readJson(await fetch(percentEncodeBridgeParam(created.body.bridgeUrl, 'session')))
    assert.equal(percentEncodedSession.status, 400)
    assert.equal(percentEncodedSession.body.error.code, 'INVALID_REQUEST')
    assert.equal(JSON.stringify(percentEncodedSession.body).includes('spbt_'), false)

    const duplicateBridgeQuery = await readJson(
      await fetch(`${created.body.bridgeUrl}&session=${new URL(created.body.bridgeUrl).searchParams.get('session')}`)
    )
    assert.equal(duplicateBridgeQuery.status, 400)
    assert.equal(duplicateBridgeQuery.body.error.code, 'INVALID_REQUEST')
    assert.equal(JSON.stringify(duplicateBridgeQuery.body).includes('spbt_'), false)

    const duplicateAuthorization = await rawHttp(url.port, [
      'GET /health HTTP/1.1',
      `Host: ${url.host}`,
      'Authorization: Bearer one',
      'Authorization: Bearer two',
      'Connection: close',
      '',
      ''
    ])
    assert.match(duplicateAuthorization, /400/)
    assert.match(duplicateAuthorization, /INVALID_REQUEST/)

    const duplicateContentType = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Type: application/json',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(duplicateContentType, /400/)
    assert.match(duplicateContentType, /INVALID_REQUEST/)

    const contentLengthAndTransferEncoding = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Length: 2',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(contentLengthAndTransferEncoding, /400/)
    assert.match(contentLengthAndTransferEncoding, /INVALID_REQUEST/)

    const duplicateContentLength = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Length: 2',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(duplicateContentLength, /400/)
    assert.match(duplicateContentLength, /INVALID_REQUEST/)

    const invalidContentLength = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Length: nope',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(invalidContentLength, /400/)
    assert.match(invalidContentLength, /INVALID_REQUEST/)

    const getCollection = await readJson(
      await fetch(`${ready.baseUrl}/v1/captures`, { headers: { Authorization: `Bearer ${ready.apiToken}` } })
    )
    assert.equal(getCollection.status, 405)
    assert.equal(getCollection.headers.get('allow'), 'POST')

    const postHealth = await readJson(await fetch(`${ready.baseUrl}/health`, { method: 'POST' }))
    assert.equal(postHealth.status, 405)
    assert.equal(postHealth.headers.get('allow'), 'GET')

    const chunkedBody = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '2',
      '{}',
      '0',
      '',
      ''
    ])
    assert.match(chunkedBody, /400/)
    assert.match(chunkedBody, /UNSUPPORTED_TRANSFER_ENCODING/)

    const unsupportedTransferEncoding = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Transfer-Encoding: gzip',
      'Connection: close',
      '',
      ''
    ])
    assert.match(unsupportedTransferEncoding, /400/)
    assert.match(unsupportedTransferEncoding, /UNSUPPORTED_TRANSFER_ENCODING/)

    const unsupportedContentEncoding = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Encoding: gzip',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(unsupportedContentEncoding, /415/)
    assert.match(unsupportedContentEncoding, /UNSUPPORTED_MEDIA_TYPE/)

    const unsupportedCharset = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json; charset=latin1',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(unsupportedCharset, /415/)
    assert.match(unsupportedCharset, /UNSUPPORTED_MEDIA_TYPE/)

    const shortJsonBody = await rawHttp(url.port, [
      'POST /v1/captures HTTP/1.1',
      `Host: ${url.host}`,
      `Authorization: Bearer ${ready.apiToken}`,
      'Content-Type: application/json',
      'Content-Length: 4',
      'Connection: close',
      '',
      '{}'
    ])
    assert.match(shortJsonBody, /400/)
    assert.match(shortJsonBody, /INVALID_JSON/)
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})

test('python fallback url policy normalizes public URLs and rejects fixture-resolved private hostnames', () => {
  const script = `
import json
from stackprism_bridge_lib.url_policy import normalize_capture_request

public_request = {
    "url": ${JSON.stringify(urlPolicyCases.publicHostname.url)},
    "mode": "experience",
    "waitMs": 0,
    "include": ["tech"],
    "viewports": [],
    "options": {"targetMode": "reuse_or_new_tab"},
}
private_request = {
    "url": ${JSON.stringify(urlPolicyCases.privateHostname.url)},
    "mode": "experience",
    "waitMs": 0,
    "include": ["tech"],
    "viewports": [],
    "options": {"targetMode": "reuse_or_new_tab"},
}
mixed_request = {
    "url": ${JSON.stringify(urlPolicyCases.mixedHostname.url)},
    "mode": "experience",
    "waitMs": 0,
    "include": ["tech"],
    "viewports": [],
    "options": {"targetMode": "reuse_or_new_tab"},
}
non_global_request = {
    "url": ${JSON.stringify(urlPolicyCases.nonGlobalHostname.url)},
    "mode": "experience",
    "waitMs": 0,
    "include": ["tech"],
    "viewports": [],
    "options": {"targetMode": "reuse_or_new_tab"},
}
special_use_request = {
    "url": ${JSON.stringify(urlPolicyCases.specialUseHostname.url)},
    "mode": "experience",
    "waitMs": 0,
    "include": ["tech"],
    "viewports": [],
    "options": {"targetMode": "reuse_or_new_tab"},
}
special_use_v6_request = {
    "url": ${JSON.stringify(urlPolicyCases.specialUseIpv6Hostname.url)},
    "mode": "experience",
    "waitMs": 0,
    "include": ["tech"],
    "viewports": [],
    "options": {"targetMode": "reuse_or_new_tab"},
}
public_exception_request = {
    "url": ${JSON.stringify(urlPolicyCases.publicSpecialUseExceptionHostname.url)},
    "mode": "experience",
    "waitMs": 0,
    "include": ["tech"],
    "viewports": [],
    "options": {"targetMode": "reuse_or_new_tab"},
}
failed_lookup_request = {
    "url": "https://missing.internal.example/dashboard",
    "mode": "experience",
    "waitMs": 0,
    "include": ["tech"],
    "viewports": [],
    "options": {"targetMode": "reuse_or_new_tab"},
}
empty_lookup_request = {
    "url": "https://empty.internal.example/dashboard",
    "mode": "experience",
    "waitMs": 0,
    "include": ["tech"],
    "viewports": [],
    "options": {"targetMode": "reuse_or_new_tab"},
}

def resolver(hostname):
    if hostname == "public.example":
        return ${JSON.stringify(urlPolicyCases.publicHostname.resolvedAddresses)}
    if hostname == "mixed.internal.example":
        return ${JSON.stringify(urlPolicyCases.mixedHostname.resolvedAddresses)}
    if hostname == "rewritten.invalid":
        return ${JSON.stringify(urlPolicyCases.nonGlobalHostname.resolvedAddresses)}
    if hostname == "special-use.internal.example":
        return ${JSON.stringify(urlPolicyCases.specialUseHostname.resolvedAddresses)}
    if hostname == "special-use-v6.internal.example":
        return ${JSON.stringify(urlPolicyCases.specialUseIpv6Hostname.resolvedAddresses)}
    if hostname == "public-special-exception.example":
        return ${JSON.stringify(urlPolicyCases.publicSpecialUseExceptionHostname.resolvedAddresses)}
    return ${JSON.stringify(urlPolicyCases.privateHostname.resolvedAddresses)}

def failed_resolver(_hostname):
    raise OSError("fixture NXDOMAIN")

def empty_resolver(_hostname):
    return []

def normalize_with_single_address(request, address):
    def single_resolver(_hostname):
        return [address]
    normalized, code, details, message = normalize_capture_request(request, "http://127.0.0.1:17370", single_resolver)
    return {
        "address": address,
        "normalizedUrl": normalized["url"] if normalized else None,
        "code": code,
        "details": details,
        "message": message,
    }

public_normalized, public_code, _public_details, _public_message = normalize_capture_request(public_request, "http://127.0.0.1:17370", resolver)
private_normalized, private_code, private_details, private_message = normalize_capture_request(private_request, "http://127.0.0.1:17370", resolver)
mixed_normalized, mixed_code, mixed_details, mixed_message = normalize_capture_request(mixed_request, "http://127.0.0.1:17370", resolver)
non_global_normalized, non_global_code, non_global_details, non_global_message = normalize_capture_request(non_global_request, "http://127.0.0.1:17370", resolver)
special_use_normalized, special_use_code, special_use_details, special_use_message = normalize_capture_request(special_use_request, "http://127.0.0.1:17370", resolver)
failed_lookup_normalized, failed_lookup_code, failed_lookup_details, failed_lookup_message = normalize_capture_request(failed_lookup_request, "http://127.0.0.1:17370", failed_resolver)
empty_lookup_normalized, empty_lookup_code, empty_lookup_details, empty_lookup_message = normalize_capture_request(empty_lookup_request, "http://127.0.0.1:17370", empty_resolver)
special_use_results = [
    normalize_with_single_address(special_use_request, address)
    for address in ${JSON.stringify(urlPolicyCases.specialUseHostname.resolvedAddresses)}
] + [
    normalize_with_single_address(special_use_v6_request, address)
    for address in ${JSON.stringify(urlPolicyCases.specialUseIpv6Hostname.resolvedAddresses)}
]
public_exception_results = [
    normalize_with_single_address(public_exception_request, address)
    for address in ${JSON.stringify(urlPolicyCases.publicSpecialUseExceptionHostname.resolvedAddresses)}
]
print(json.dumps({
    "publicUrl": public_normalized["url"] if public_normalized else None,
    "publicCode": public_code,
    "privateNormalized": private_normalized,
    "privateCode": private_code,
    "privateDetails": private_details,
    "privateMessage": private_message,
    "mixedNormalized": mixed_normalized,
    "mixedCode": mixed_code,
    "mixedDetails": mixed_details,
    "mixedMessage": mixed_message,
    "nonGlobalNormalized": non_global_normalized,
    "nonGlobalCode": non_global_code,
    "nonGlobalDetails": non_global_details,
    "nonGlobalMessage": non_global_message,
    "specialUseNormalized": special_use_normalized,
    "specialUseCode": special_use_code,
    "specialUseDetails": special_use_details,
    "specialUseMessage": special_use_message,
    "failedLookupNormalized": failed_lookup_normalized,
    "failedLookupCode": failed_lookup_code,
    "failedLookupDetails": failed_lookup_details,
    "failedLookupMessage": failed_lookup_message,
    "emptyLookupNormalized": empty_lookup_normalized,
    "emptyLookupCode": empty_lookup_code,
    "emptyLookupDetails": empty_lookup_details,
    "emptyLookupMessage": empty_lookup_message,
    "specialUseResults": special_use_results,
    "publicExceptionResults": public_exception_results,
}, sort_keys=True))
`
  const result = spawnSync('python3', ['-c', script], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PYTHONPATH: 'agent-skill/stackprism-site-experience/scripts',
      PYTHONWARNINGS: 'ignore'
    },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.publicUrl, urlPolicyCases.publicHostname.normalizedUrl)
  assert.equal(parsed.publicCode, null)
  assert.equal(parsed.privateNormalized, null)
  assert.equal(parsed.privateCode, urlPolicyCases.privateHostname.errorCode)
  assert.equal(parsed.privateDetails.reason, 'private_network_address')
  assert.equal(parsed.mixedNormalized, null)
  assert.equal(parsed.mixedCode, urlPolicyCases.mixedHostname.errorCode)
  assert.equal(parsed.mixedDetails.reason, 'private_network_address')
  assert.equal(parsed.nonGlobalNormalized, null)
  assert.equal(parsed.nonGlobalCode, urlPolicyCases.nonGlobalHostname.errorCode)
  assert.equal(parsed.nonGlobalDetails.reason, 'private_network_address')
  assert.equal(parsed.specialUseNormalized, null)
  assert.equal(parsed.specialUseCode, urlPolicyCases.specialUseHostname.errorCode)
  assert.equal(parsed.specialUseDetails.reason, 'private_network_address')
  assert.equal(parsed.failedLookupNormalized, null)
  assert.equal(parsed.failedLookupCode, 'TARGET_DNS_LOOKUP_FAILED')
  assert.equal(parsed.failedLookupDetails.reason, 'dns_lookup_failed')
  assert.equal(parsed.emptyLookupNormalized, null)
  assert.equal(parsed.emptyLookupCode, 'TARGET_DNS_LOOKUP_FAILED')
  assert.equal(parsed.emptyLookupDetails.reason, 'dns_lookup_failed')
  for (const result of parsed.specialUseResults) {
    assert.equal(result.normalizedUrl, null, result.address)
    assert.equal(result.code, urlPolicyCases.specialUseHostname.errorCode, result.address)
    assert.equal(result.details.reason, 'private_network_address', result.address)
  }
  for (const result of parsed.publicExceptionResults) {
    assert.equal(result.normalizedUrl, urlPolicyCases.publicSpecialUseExceptionHostname.normalizedUrl, result.address)
    assert.equal(result.code, null, result.address)
  }
})

test('python fallback default DNS lookup has a bounded timeout', () => {
  const script = `
import json
import time
import stackprism_bridge_lib.url_policy as url_policy

url_policy.DNS_LOOKUP_TIMEOUT_SECONDS = 0.01

def slow_getaddrinfo(*_args, **_kwargs):
    time.sleep(0.2)
    return []

url_policy.socket.getaddrinfo = slow_getaddrinfo
started = time.monotonic()
try:
    url_policy.default_resolve_hostname("slow.example")
    result = {"timedOut": False}
except Exception as exc:
    result = {"timedOut": True, "type": type(exc).__name__, "elapsed": time.monotonic() - started}

print(json.dumps(result, sort_keys=True))
`
  const result = spawnSync('python3', ['-c', script], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PYTHONPATH: 'agent-skill/stackprism-site-experience/scripts',
      PYTHONWARNINGS: 'ignore'
    },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.timedOut, true)
  assert.equal(parsed.type, 'TimeoutError')
  assert.ok(parsed.elapsed < 0.1)
})

const rawHttp = (port, lines) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let data = ''
    socket.on('connect', () => socket.write(lines.join('\r\n')))
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
    })
    socket.on('error', reject)
    socket.on('end', () => resolve(data))
  })

const rawHttpSplitBody = (port, lines, body, splitAt, delayMs) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let data = ''
    socket.on('connect', () => {
      socket.write(lines.join('\r\n'))
      socket.write(body.slice(0, splitAt))
      setTimeout(() => socket.write(body.slice(splitAt)), delayMs)
    })
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
    })
    socket.on('error', reject)
    socket.on('end', () => resolve(data))
  })

const parseRawJsonResponse = raw => {
  const [head, body = '{}'] = raw.split('\r\n\r\n')
  const status = Number(/^HTTP\/1\.[01]\s+(\d+)/.exec(head)?.[1])
  const contentLength = Number(/\r\ncontent-length:\s*(\d+)\r\n/i.exec(`\r\n${head}\r\n`)?.[1])
  return { status, body: JSON.parse(Number.isFinite(contentLength) ? body.slice(0, contentLength) : body) }
}
