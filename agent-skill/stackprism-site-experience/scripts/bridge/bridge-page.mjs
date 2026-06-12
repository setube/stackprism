import { bridgePageScript, bridgePageStyle } from './bridge-page-assets.mjs'
import { htmlEscapeScriptJson, identifierSpecs } from './protocol.mjs'

export const renderBridgePageHtml = (cspNonce, config) => {
  if (!identifierSpecs.cspNonce.test(cspNonce)) {
    throw new Error('INVALID_CSP_NONCE')
  }
  const configJson = htmlEscapeScriptJson(config)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="stackprism-agent-bridge" content="1">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%230f766e'/%3E%3C/svg%3E">
<title>StackPrism Agent Bridge</title>
<style nonce="${cspNonce}">${bridgePageStyle}</style>
</head>
<body>
<main class="bridge-shell">
<section id="bridgeCard" class="bridge-card" data-status="waiting_extension" aria-labelledby="bridge-title" tabindex="-1">
<header class="bridge-header">
<div class="bridge-brand">
<div class="bridge-mark" aria-hidden="true">SP</div>
<div>
<p class="bridge-kicker">本机通道</p>
<h1 id="bridge-title" class="bridge-title">StackPrism Agent Bridge</h1>
<p class="bridge-copy">连接本机 Agent 与当前浏览器 profile，展示本次采集结果。</p>
</div>
</div>
<span id="statusBadge" class="bridge-badge">等待扩展连接</span>
</header>
<div class="bridge-body">
<section class="status-panel" aria-live="polite">
<div>
<div id="stateLabel" class="state-label">等待扩展连接</div>
<p id="status" class="status-text">等待 StackPrism 扩展连接。</p>
</div>
<div class="progress-row" aria-hidden="true"><div class="progress"><span id="progressBar"></span></div></div>
</section>
<section class="target-panel" aria-label="目标与可复制结果">
<div class="target-copy">
<p class="preview-label">采集目标</p>
<a id="targetUrl" class="target-url" title="" target="_blank" rel="noopener noreferrer" aria-disabled="true">等待读取目标网址</a>
<p id="targetHelper" class="target-helper">采集完成后可复制给本机 Coding Agent 使用。</p>
</div>
<div class="target-actions"><a id="openTargetUrl" class="preview-button target-open-link" target="_blank" rel="noopener noreferrer" aria-disabled="true" tabindex="-1">打开目标网页</a><button id="downloadProfile" class="preview-button profile-download-button" type="button" disabled>下载 Profile</button><button id="copyAllInfo" class="preview-button primary target-copy-button" type="button" disabled>复制全部信息</button></div>
<p id="copyStatus" class="copy-status" role="status" aria-live="polite"></p>
</section>
<section class="result-grid" aria-label="采集结果">
<section class="capture-panel" aria-label="Profile 摘要">
<div class="section-title"><span class="section-dot" aria-hidden="true"></span><h2>Profile 摘要</h2></div>
<p class="panel-copy">面向复刻任务整理技术栈、视觉结构、交互路径与资产线索。</p>
<div class="summary-grid">
<div class="summary-tile"><p>Agent 用途</p><strong>快速复刻</strong></div>
<div class="summary-tile"><p>内容范围</p><strong>技术与体验</strong></div>
<div class="summary-tile"><p>采集模式</p><strong>只读采集</strong></div>
<div class="summary-tile"><p>截图状态</p><strong id="screenshotTileValue">等待截图</strong></div>
</div>
<div class="summary-note"><p>复刻重点</p><ul><li>先看 Agent 可读内容</li><li>用截图校准首屏结构</li><li>必要时再读 raw profile</li></ul></div>
<div class="summary-handoff" aria-label="摘要包含"><p>摘要包含</p><div><span>技术栈</span><span>首屏结构</span><span>交互路径</span><span>资产线索</span></div></div>
</section>
<section class="screenshot-panel" aria-label="截图预览">
<div class="section-title"><span class="section-dot" aria-hidden="true"></span><h2>截图预览</h2><span id="screenshotStateBadge" class="state-chip" data-state="pending">等待截图</span></div>
<button id="screenshotFrame" class="screenshot-frame" type="button" disabled><img id="targetScreenshot" alt=""><span id="screenshotEmpty" class="screenshot-empty">采集完成后显示截图
未返回时仍可复制文本摘要</span></button>
<p id="screenshotMeta" class="screenshot-meta">截图可用后会显示格式与范围</p>
<div class="preview-actions"><button id="copyScreenshot" class="preview-button" type="button" disabled>复制截图</button><button id="screenshotDownload" class="preview-button" type="button" disabled>下载截图</button></div>
</section>
</section>
<section id="profileContentSection" class="content-section" hidden><div class="section-head"><div><h2>Agent 可读内容</h2><p>已转换为摘要；完整 Profile 可在本页完成后下载。</p></div></div><div id="profileContentGrid" class="content-grid"></div></section>
<section class="flow-panel" aria-label="采集流程"><div class="flow-head"><h2>采集流程</h2><div class="flow-state"><p id="stepSummary" class="step-summary" role="status" aria-live="polite">当前步骤：扩展连接</p><button id="toggleSteps" class="flow-toggle" type="button" aria-controls="captureSteps" aria-expanded="false">展开步骤</button></div></div><ol id="captureSteps" class="steps" aria-label="采集步骤" role="list"><li class="step current" data-phase="bridge_connected" aria-current="step"><span class="step-index">1</span><div>扩展连接</div></li><li class="step" data-phase="request_loaded"><span class="step-index">2</span><div>读取请求</div></li><li class="step" data-phase="target_opening"><span class="step-index">3</span><div>打开目标</div></li><li class="step" data-phase="target_loaded"><span class="step-index">4</span><div>页面加载</div></li><li class="step" data-phase="detecting_tech"><span class="step-index">5</span><div>技术识别</div></li><li class="step" data-phase="profiling_experience"><span class="step-index">6</span><div>体验分析</div></li><li class="step" data-phase="posting_profile"><span class="step-index">7</span><div>回传 Profile</div></li><li class="step" data-phase="cleanup"><span class="step-index">8</span><div>清理完成</div></li></ol></section>
<footer class="bridge-footer"><p class="bridge-note">本页只服务当前一次采集；完整 Profile 仅在本次结果未过期时下载；摘要不含 token、nonce、raw JSON 或截图 data URL。</p><div class="pills"><span class="pill">127.0.0.1</span><span class="pill">当前 profile</span><span class="pill">只读采集</span></div></footer>
</div>
</section>
</main>
<section id="screenshotModal" class="screenshot-modal" data-open="false" aria-label="截图放大预览" role="dialog" aria-modal="true"><div class="modal-card"><div class="modal-bar"><p class="modal-title">截图预览</p><div class="modal-actions"><button id="modalCopyScreenshot" class="modal-close" type="button" disabled>复制截图</button><button id="modalDownload" class="modal-close" type="button" disabled>下载截图</button><button id="modalClose" class="modal-close" type="button">关闭</button></div></div><p id="modalCopyStatus" class="modal-copy-status" role="status" aria-live="polite"></p><img id="modalScreenshot" class="modal-image" alt=""></div></section>
<script id="stackprism-agent-bridge-config" type="application/json" nonce="${cspNonce}">${configJson}</script>
<script nonce="${cspNonce}">${bridgePageScript}</script>
</body>
</html>`
}
