import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Required facts are assertions; optional signals are observations, not site-wide ground truth. */
export function evaluateBaseline(baseline, report) {
  if (report.coverage.httpStatus === null || report.coverage.httpStatus < 200 || report.coverage.httpStatus >= 300) {
    return { status: 'unobservable', reason: `Main document HTTP status: ${report.coverage.httpStatus}`, checks: [] }
  }
  const detected = new Set(report.technologies.map(technology => technology.name))
  const checks = [
    { name: 'expected_host', passed: baseline.allowedHosts.includes(new URL(report.url).hostname) },
    { name: 'main_document_headers', passed: report.coverage.responseHeaders === 'main_document' },
    ...baseline.requiredTechnologies.map(name => ({ name, passed: detected.has(name) })),
    { name: 'subresource_headers', passed: report.coverage.subresourceHeaders === 'sampled' && report.network.observedResponses > 0 },
    { name: 'bounded_capture', passed: report.network.responses.length <= report.network.responseLimit },
    {
      name: 'response_accounting',
      passed:
        report.network.observedResponses ===
        report.network.responses.length + report.network.skippedResponses + report.network.failedResponses
    }
  ]
  if (report.network.failedResponses > 0) {
    return { status: 'unobservable', reason: `${report.network.failedResponses} response header reads failed`, checks }
  }
  return { status: checks.every(check => check.passed) ? 'pass' : 'drift', checks }
}

export function formatBaselineMarkdown(run) {
  const report = run.report
  const checks = run.checks.map(check => `| ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} |`).join('\n')
  const pageNames = report?.technologies.map(technology => technology.name).join(', ') || '—'
  const networkNames =
    [...new Set(report?.network.responses.flatMap(response => response.technologies.map(technology => technology.name)) ?? [])].join(
      ', '
    ) || '—'
  const lines = [
    '# Bing live baseline',
    '',
    '## 中文',
    '',
    `状态：**${run.status}**；采样时间：${run.capturedAt}。`,
    `目标：${run.target}；最终地址：${report?.url ?? '—'}；HTTP：${report?.coverage.httpStatus ?? '—'}。`,
    `页面／主文档：${pageNames}。`,
    `子资源信号：${networkNames}。它们描述资源端点，不能直接归为主站技术。`,
    ...(run.reason ? [`原因：${run.reason}`] : []),
    '',
    '| 断言 | 结果 |',
    '| --- | --- |',
    checks,
    '',
    '## English',
    '',
    `Status: **${run.status}**; captured: ${run.capturedAt}.`,
    `Target: ${run.target}; final URL: ${report?.url ?? '—'}; HTTP: ${report?.coverage.httpStatus ?? '—'}.`,
    `Page/main document: ${pageNames}.`,
    `Subresource signals: ${networkNames}. These describe resource endpoints, not necessarily the site's stack.`,
    ...(run.reason ? [`Reason: ${run.reason}`] : []),
    '',
    '| Assertion | Result |',
    '| --- | --- |',
    checks,
    '',
    '## Capture / 采集',
    '',
    `- SDK: ${report?.engine.version ?? '—'}; rules: ${report?.rules.version ?? '—'}; SHA-256: ${report?.rules.sha256 ?? '—'}`,
    `- Environment: Node ${run.environment.node}, ${run.environment.platform}/${run.environment.arch}; installed Chrome channel`,
    `- After-load window: ${run.observationMs} ms; detection duration: ${report?.durationMs ?? '—'} ms`,
    `- Responses: observed ${report?.network.observedResponses ?? 0}; captured ${report?.network.responses.length ?? 0}; skipped ${report?.network.skippedResponses ?? 0}; failed ${report?.network.failedResponses ?? 0}`,
    '',
    '可变观察项不参与通过条件；单站点实测不代表总体准确率。',
    'Optional observations do not determine pass/fail. One live site does not establish overall accuracy.',
    ''
  ]
  return lines.join('\n')
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'executable-path': { type: 'string' } }, strict: true })
  const baseline = JSON.parse(await readFile(path.join(root, 'baselines/bing.json'), 'utf8'))
  const outdir = path.resolve(values.output ?? path.join(root, 'artifacts/bing'))
  const run = {
    baseline: baseline.id,
    capturedAt: new Date().toISOString(),
    target: baseline.url,
    observationMs: baseline.observationMs,
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch }
  }
  try {
    const { scanUrl } = await import('../packages/stackprism/dist/index.js')
    run.report = await scanUrl(baseline.url, {
      timeoutMs: baseline.timeoutMs,
      observationMs: baseline.observationMs,
      executablePath: values['executable-path']
    })
    Object.assign(run, evaluateBaseline(baseline, run.report))
  } catch (error) {
    Object.assign(run, { status: 'unobservable', reason: error.code ?? 'DETECTION_FAILED', checks: [] })
  }
  await mkdir(outdir, { recursive: true })
  await writeFile(path.join(outdir, 'report.json'), `${JSON.stringify(run, null, 2)}\n`)
  await writeFile(path.join(outdir, 'report.md'), formatBaselineMarkdown(run))
  console.log(JSON.stringify({ status: run.status, checks: run.checks, output: outdir }))
  process.exitCode = run.status === 'pass' ? 0 : run.status === 'drift' ? 1 : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => {
    console.error(JSON.stringify({ status: 'unobservable', reason: error.code ?? 'BASELINE_FAILED' }))
    process.exitCode = 2
  })
}
