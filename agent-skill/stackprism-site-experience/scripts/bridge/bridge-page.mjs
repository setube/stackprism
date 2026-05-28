const bridgePageStyle = `
:root{color-scheme:light;--sp-bg:#f4f8f7;--sp-panel:#ffffff;--sp-line:#c7e2db;--sp-ink:#132127;--sp-muted:#5e6c78;--sp-accent:#0f766e;--sp-soft:#e9f7f3;--sp-warn:#a45a00;--sp-danger:#b42318}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:linear-gradient(180deg,#f9fbfb 0%,var(--sp-bg) 100%);color:var(--sp-ink);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.bridge-shell{min-height:100vh;display:grid;place-items:center;padding:28px}
.bridge-card{width:min(760px,100%);overflow:hidden;border:1px solid var(--sp-line);border-radius:14px;background:var(--sp-panel);box-shadow:0 24px 60px rgba(15,118,110,.12)}
.bridge-header{display:grid;grid-template-columns:auto 1fr auto;gap:18px;align-items:center;padding:28px 30px;border-bottom:1px solid var(--sp-line);background:linear-gradient(90deg,#f3fbf8 0%,#fff 76%)}
.bridge-mark{width:54px;height:54px;border-radius:14px;display:grid;place-items:center;background:var(--sp-accent);color:#fff;font-weight:800;letter-spacing:.02em;box-shadow:0 14px 30px rgba(15,118,110,.25)}
.bridge-kicker{margin:0 0 4px;color:var(--sp-accent);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.bridge-title{margin:0;font-size:26px;line-height:1.15}
.bridge-copy{margin:8px 0 0;color:var(--sp-muted);font-size:15px}
.bridge-badge{padding:7px 13px;border:1px solid var(--sp-line);border-radius:999px;background:var(--sp-soft);color:var(--sp-accent);font-weight:700;white-space:nowrap}
.bridge-body{padding:26px 30px 30px}
.status-panel{display:grid;gap:10px;margin-bottom:24px}
.state-label{font-size:20px;font-weight:800}
.status-text{margin:0;color:var(--sp-muted)}
.progress{height:10px;overflow:hidden;border-radius:999px;background:#edf2f2}
.progress span{display:block;width:8%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#0f766e,#14b8a6);transition:width .25s ease}
.preview-panel{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,320px);gap:16px;align-items:start;margin:0 0 24px;padding:16px;border:1px solid #dce8e5;border-radius:12px;background:#fbfefe}
.preview-label{margin:0 0 6px;color:var(--sp-muted);font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.target-url{margin:0;overflow-wrap:anywhere;color:var(--sp-ink);font-weight:700}
.screenshot-frame{width:100%;min-height:150px;display:grid;place-items:center;overflow:hidden;border:1px solid #dce8e5;border-radius:10px;background:#f3f7f7;cursor:pointer;padding:0;text-align:inherit}
.screenshot-frame:disabled{cursor:not-allowed}
.screenshot-frame:focus-visible,.preview-button:focus-visible,.modal-close:focus-visible{outline:3px solid rgba(15,118,110,.35);outline-offset:2px}
.screenshot-frame img{display:none;width:100%;height:auto;max-height:220px;object-fit:cover}
.screenshot-frame.has-image img{display:block}
.screenshot-frame.has-image .screenshot-empty{display:none}
.screenshot-empty{padding:18px;color:var(--sp-muted);text-align:center}
.preview-actions{display:flex;gap:8px;margin-top:10px}
.preview-button{min-height:36px;padding:0 12px;border:1px solid #b9dcd5;border-radius:8px;background:#fff;color:var(--sp-accent);font:inherit;font-weight:700;cursor:pointer}
.preview-button:disabled{cursor:not-allowed;opacity:.55}
.screenshot-modal{position:fixed;inset:0;z-index:20;display:none;place-items:center;padding:28px;background:rgba(10,18,24,.72)}
.screenshot-modal[data-open="true"]{display:grid}
.modal-card{width:min(1180px,100%);max-height:92vh;display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;border:1px solid #25443f;border-radius:14px;background:#081311;box-shadow:0 28px 90px rgba(0,0,0,.42)}
.modal-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid #1e3934;color:#e7f7f3}
.modal-title{margin:0;font-size:15px;font-weight:800}
.modal-actions{display:flex;gap:8px;align-items:center}
.modal-close{min-height:36px;padding:0 12px;border:1px solid #35665f;border-radius:8px;background:#10211e;color:#e7f7f3;font:inherit;font-weight:700;cursor:pointer}
.modal-image{display:block;width:100%;height:100%;max-height:calc(92vh - 62px);object-fit:contain;background:#030807}
.steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}
.step{min-height:70px;padding:12px;border:1px solid #dce8e5;border-radius:10px;background:#fafdfc;color:var(--sp-muted)}
.step-index{display:inline-grid;place-items:center;width:22px;height:22px;margin-bottom:8px;border-radius:999px;background:#edf3f2;color:var(--sp-muted);font-size:12px;font-weight:700}
.step.done{border-color:#a9d8cd;background:#f2fbf8;color:var(--sp-accent)}
.step.done .step-index,.step.current .step-index{background:var(--sp-accent);color:#fff}
.step.current{border-color:var(--sp-accent);color:var(--sp-ink);box-shadow:0 0 0 2px rgba(15,118,110,.08)}
.bridge-footer{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-top:24px;padding-top:20px;border-top:1px solid #e7eeee}
.bridge-note{margin:0;color:var(--sp-muted)}
.pills{display:flex;flex-wrap:wrap;gap:8px}
.pill{padding:6px 10px;border:1px solid #d6e7e3;border-radius:999px;color:var(--sp-muted);background:#fbfefe;font-size:13px}
.bridge-card[data-status="completed"] .bridge-badge{border-color:#a9d8cd;background:#e8f8f1;color:var(--sp-accent)}
.bridge-card[data-status="failed"] .bridge-badge,.bridge-card[data-status="expired"] .bridge-badge{border-color:#f0b7b2;background:#fff5f5;color:var(--sp-danger)}
.bridge-card[data-status="cancelled"] .bridge-badge{border-color:#f0d2a8;background:#fff8ed;color:var(--sp-warn)}
@media (max-width:680px){.bridge-shell{padding:16px}.bridge-header{grid-template-columns:auto 1fr;padding:22px}.bridge-badge{grid-column:1/-1;justify-self:start}.bridge-body{padding:22px}.preview-panel{grid-template-columns:1fr}.steps{grid-template-columns:1fr}.bridge-title{font-size:22px}.screenshot-modal{padding:14px}.modal-bar{align-items:flex-start;flex-direction:column}.modal-actions{width:100%;justify-content:flex-end}}
`

const bridgePageScript = `
const config=JSON.parse(document.getElementById('stackprism-agent-bridge-config').textContent);
const ids=['status','stateLabel','statusBadge','progressBar','bridgeCard','targetUrl','screenshotFrame','targetScreenshot','screenshotDownload','screenshotModal','modalScreenshot','modalClose','modalDownload'];
const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
const steps=[...document.querySelectorAll('[data-phase]')];
let currentScreenshot=null;
const phases=['bridge_connected','request_loaded','target_opening','target_loaded','detecting_tech','profiling_experience','posting_profile','cleanup'];
const phaseLabels={bridge_connected:'扩展已连接',request_loaded:'读取采集请求',target_opening:'打开目标页面',target_loaded:'目标页面已加载',detecting_tech:'识别技术栈',profiling_experience:'分析视觉与体验',posting_profile:'回传 Profile',cleanup:'清理采集环境'};
const statusLabels={queued:'等待扩展连接',waiting_extension:'等待扩展连接',running:'正在采集',cancel_requested:'正在取消',cancelled:'已取消',completed:'采集完成',failed:'采集失败',expired:'结果已过期'};
const finalStatuses=['completed','failed','cancelled','expired'];
const setStatus=(value)=>{el.status.textContent=value};
const screenshotExtension=()=>currentScreenshot?.mimeType==='image/png'?'png':currentScreenshot?.mimeType==='image/webp'?'webp':'jpg';
const screenshotFilename=()=>('stackprism-'+config.captureId+'-screenshot.'+screenshotExtension());
const setScreenshot=(screenshot)=>{
currentScreenshot=screenshot?.dataUrl?screenshot:null;
el.targetScreenshot.toggleAttribute('src',false);
el.modalScreenshot.toggleAttribute('src',false);
if(currentScreenshot){el.targetScreenshot.src=currentScreenshot.dataUrl;el.modalScreenshot.src=currentScreenshot.dataUrl;}
el.screenshotFrame.classList.toggle('has-image',Boolean(currentScreenshot));
el.screenshotFrame.disabled=!currentScreenshot;
el.screenshotDownload.disabled=!currentScreenshot;
el.modalDownload.disabled=!currentScreenshot;
};
const downloadScreenshot=()=>{
if(!currentScreenshot)return;
const link=document.createElement('a');
link.href=currentScreenshot.dataUrl;
link.download=screenshotFilename();
document.body.append(link);
link.click();
link.remove();
};
const openScreenshot=()=>{if(currentScreenshot){el.screenshotModal.dataset.open='true';el.modalClose.focus();}};
const closeScreenshot=()=>{el.screenshotModal.dataset.open='false';el.screenshotFrame.focus();};
const updateSteps=(phase,status)=>{
const index=status==='completed'?phases.length-1:Math.max(0,phases.indexOf(phase));
steps.forEach(step=>{
const stepIndex=phases.indexOf(step.dataset.phase);
step.classList.toggle('done',stepIndex<index||status==='completed');
step.classList.toggle('current',stepIndex===index&&!finalStatuses.includes(status));
});
el.progressBar.style.width=(status==='completed'?100:Math.max(8,Math.round(((index+1)/phases.length)*100)))+'%';
};
const render=(body)=>{
const status=body?.status||'waiting_extension';
const phase=body?.phase||'bridge_connected';
const label=statusLabels[status]||status;
const preview=body?.preview||{};
el.bridgeCard.dataset.status=status;
el.stateLabel.textContent=label;
el.statusBadge.textContent=label;
setStatus(body?.error?.code||phaseLabels[phase]||status);
el.targetUrl.textContent=preview.targetUrl||'等待读取目标网址';
setScreenshot(preview.screenshot);
updateSteps(phase,status);
};
el.screenshotFrame.addEventListener('click',openScreenshot);
el.screenshotDownload.addEventListener('click',downloadScreenshot);
el.modalDownload.addEventListener('click',downloadScreenshot);
el.modalClose.addEventListener('click',closeScreenshot);
el.screenshotModal.addEventListener('click',event=>{if(event.target===el.screenshotModal)closeScreenshot();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&el.screenshotModal.dataset.open==='true')closeScreenshot();});
const poll=async()=>{
try{
const res=await fetch('/v1/captures/'+config.captureId,{headers:{Authorization:'Bearer '+config.bridgeToken},cache:'no-store'});
const body=await res.json();
if(!res.ok){render({status:'failed',phase:'cleanup',error:{code:body?.error?.code||'Bridge request failed.'}});return;}
render(body);
if(finalStatuses.includes(body.status))return;
}catch{render({status:'failed',phase:'cleanup',error:{code:'Bridge status unavailable.'}});}
setTimeout(poll,1000);
};
poll();
`

export const renderBridgePageHtml = (cspNonce, config) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="stackprism-agent-bridge" content="1">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>StackPrism Agent Bridge</title>
<style nonce="${cspNonce}">${bridgePageStyle}</style>
</head>
<body>
<main class="bridge-shell">
<section id="bridgeCard" class="bridge-card" data-status="waiting_extension" aria-labelledby="bridge-title">
<header class="bridge-header">
<div class="bridge-mark" aria-hidden="true">SP</div>
<div><p class="bridge-kicker">本机通道</p><h1 id="bridge-title" class="bridge-title">StackPrism Agent Bridge</h1><p class="bridge-copy">正在连接本机 Agent 与当前浏览器 profile，请保持本页打开。</p></div>
<span id="statusBadge" class="bridge-badge">等待扩展连接</span>
</header>
<div class="bridge-body">
<section class="status-panel" aria-live="polite"><div id="stateLabel" class="state-label">等待扩展连接</div><p id="status" class="status-text">等待 StackPrism 扩展连接。</p><div class="progress" aria-hidden="true"><span id="progressBar"></span></div></section>
<section class="preview-panel" aria-label="采集预览"><div><p class="preview-label">目标网址</p><p id="targetUrl" class="target-url">等待读取目标网址</p></div><div><p class="preview-label">截图预览</p><button id="screenshotFrame" class="screenshot-frame" type="button" disabled><img id="targetScreenshot" alt="目标页面截图预览"><div class="screenshot-empty">采集完成后显示可用截图</div></button><div class="preview-actions"><button id="screenshotDownload" class="preview-button" type="button" disabled>下载截图</button></div></div></section>
<ol class="steps"><li class="step current" data-phase="bridge_connected"><span class="step-index">1</span><div>扩展连接</div></li><li class="step" data-phase="request_loaded"><span class="step-index">2</span><div>读取请求</div></li><li class="step" data-phase="target_opening"><span class="step-index">3</span><div>打开目标</div></li><li class="step" data-phase="target_loaded"><span class="step-index">4</span><div>页面加载</div></li><li class="step" data-phase="detecting_tech"><span class="step-index">5</span><div>技术识别</div></li><li class="step" data-phase="profiling_experience"><span class="step-index">6</span><div>体验分析</div></li><li class="step" data-phase="posting_profile"><span class="step-index">7</span><div>回传 Profile</div></li><li class="step" data-phase="cleanup"><span class="step-index">8</span><div>清理完成</div></li></ol>
<footer class="bridge-footer"><p class="bridge-note">本页只服务当前一次采集，不需要手动填写信息。</p><div class="pills"><span class="pill">127.0.0.1</span><span class="pill">当前 profile</span><span class="pill">只读采集</span></div></footer>
</div>
</section>
</main>
<section id="screenshotModal" class="screenshot-modal" data-open="false" aria-label="截图放大预览" role="dialog" aria-modal="true"><div class="modal-card"><div class="modal-bar"><p class="modal-title">截图预览</p><div class="modal-actions"><button id="modalDownload" class="modal-close" type="button" disabled>下载截图</button><button id="modalClose" class="modal-close" type="button">关闭</button></div></div><img id="modalScreenshot" class="modal-image" alt="目标页面截图放大预览"></div></section>
<script id="stackprism-agent-bridge-config" type="application/json" nonce="${cspNonce}">${config}</script>
<script nonce="${cspNonce}">${bridgePageScript}</script>
</body>
</html>`
