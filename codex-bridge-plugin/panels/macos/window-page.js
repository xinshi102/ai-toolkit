export function selectCollaborationSession(rows, currentId, userSelectedSession = false) {
  const current = rows.find((row) => row.id === currentId);
  if (current && (userSelectedSession || current.authorized)) return current;
  return rows.find((row) => row.authorized) || rows[0] || null;
}

export function collaborationWindowHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>多 Harness 协作记录</title>
<style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;--ink:#24332f;--muted:#78857f;--line:#e3e8e3;--panel:#fff;--base:#FAF8F4;--blue:#2F7D6D;--blue-soft:#eaf1eb;--green:#2b7657;--bad:#af5347;--shadow:0 2px 10px #1d332505}
*{box-sizing:border-box}body{margin:0;height:100dvh;overflow:hidden;color:var(--ink);background:var(--base);font-size:13px}button,input,select{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--blue);outline-offset:3px}button:disabled{opacity:.5;cursor:wait}.topbar{height:72px;padding:0 24px;display:flex;align-items:center;gap:24px;border-bottom:1px solid var(--line);background:var(--panel)}.brand{display:flex;align-items:center;gap:12px;flex:1}.mark{height:34px;width:34px;background:var(--blue);color:white;border-radius:10px;display:grid;place-items:center;font-size:22px}.brand-title{font-weight:700;font-size:15px}.brand-sub{font-size:11px;color:var(--muted);margin-top:4px}.actions{display:flex;gap:6px;flex-wrap:wrap}.btn,.side-button{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:8px 11px;color:var(--ink);font-size:11px}.btn:hover,.side-button:hover{background:var(--blue-soft)}.btn.primary{color:var(--blue)}.shell{height:calc(100dvh - 72px);display:grid;grid-template-columns:224px minmax(0,1fr);max-width:1600px;margin:auto}.sidebar{grid-column:1;grid-row:1;overflow:auto;padding:24px 16px;border-right:1px solid var(--line)}.conversation{grid-column:2;grid-row:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--panel)}.side-title{font-size:10px;font-weight:700;letter-spacing:.1em;color:var(--muted);margin-bottom:12px}.card{margin-bottom:26px}.card-title{font-weight:650;font-size:12px}.card-copy,.footnote{font-size:11px;line-height:1.7;color:var(--muted);margin-top:8px}.select{width:100%;margin-top:10px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:9px 8px;font-size:11px}.pill{font-size:11px;line-height:1.6;margin-top:10px;color:var(--muted)}.pill.ok{color:var(--green)}.pill.bad{color:var(--bad)}.side-button{margin-top:10px}.conversation-head{padding:24px 32px 18px;display:flex;gap:20px;align-items:center}.conversation-title{font-size:21px;letter-spacing:-.04em;font-weight:700}.conversation-note{font-size:11px;color:var(--muted);margin-top:7px}.live{margin-left:auto;font-size:10px;color:var(--muted)}.toolbar{padding:0 32px 18px;display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--line)}.agents{display:flex;gap:5px;flex-wrap:wrap}.agent{display:flex;align-items:center;gap:5px;border:1px solid transparent;border-radius:7px;padding:6px 8px;background:transparent;color:var(--muted);font-size:11px}.agent.active{background:var(--blue-soft);color:var(--blue);border-color:var(--line)}.avatar,.mini-avatar{display:grid;place-items:center;border-radius:8px;width:28px;height:28px;font-size:10px;font-weight:700;background:var(--blue-soft);color:var(--blue)}.avatar{width:20px;height:20px;font-size:8px}.oc{background:#eee9f5;color:#786295}.ds{background:#e6efed;color:#428573}.cx{background:#e9edf4;color:#5c7097}.ki{background:#f4ecdf;color:#997441}.search{margin-left:auto;width:190px;min-width:80px;background:var(--base);border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--ink);font-size:11px}#timeline{flex:1;overflow:auto;padding:24px 32px 12px;overflow-anchor:none}.empty{height:100%;min-height:100px;display:grid;place-content:center;gap:8px;text-align:center;color:var(--muted);font-size:12px}.day{font-size:10px;color:var(--muted);margin-bottom:24px}.msg{display:flex;gap:13px;margin-bottom:24px;position:relative}.msg:before{content:'';position:absolute;left:13px;top:38px;bottom:-13px;width:1px;background:var(--line)}.msg:last-child:before{display:none}.mini-avatar{flex:0 0 28px}.stack{min-width:0;flex:1;max-width:960px}.meta{font-size:10px;color:var(--muted);margin:0 0 9px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.bubble{border:1px solid var(--line);border-radius:11px;padding:16px 18px;background:var(--panel);box-shadow:var(--shadow)}.goal{font-weight:650;line-height:1.6;font-size:13px}.work{display:grid;grid-template-columns:68px minmax(0,1fr);gap:8px 12px;margin-top:12px}.work-label{font-size:10px;color:var(--muted);line-height:1.8}.work-value{font-size:12px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere}.missing{color:var(--muted)}.details{margin-top:13px;padding-top:11px;border-top:1px solid var(--line)}.details summary{cursor:pointer;font-size:10px;color:var(--muted)}.detail-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.8;color:var(--muted);margin-top:10px}.state{font-size:10px;line-height:1.8;color:var(--muted);margin-top:12px;display:flex;gap:6px;flex-wrap:wrap}.status-chip{border-radius:5px;background:var(--base);padding:2px 6px}.status-chip.error{color:var(--bad)}.status-chip.accepted{color:var(--green);background:var(--blue-soft)}.task-board{display:flex;flex-direction:column;gap:6px;margin:10px 0 26px}.task-card{text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--ink);padding:10px;width:100%}.task-card.active{background:var(--panel);border-color:var(--line);box-shadow:var(--shadow)}.task-id{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-meta,.task-state{font-size:10px;color:var(--muted);margin-top:5px;line-height:1.5}.task-empty{color:var(--muted);font-size:11px;line-height:1.7}.task-command{display:flex;align-items:center;gap:8px;padding:16px 32px;border-top:1px solid var(--line);flex-wrap:wrap}.task-command-title{font-size:11px;color:var(--muted)}.task-target,.task-input{border:1px solid var(--line);border-radius:8px;background:var(--base);color:var(--ink);padding:10px;font-size:12px}.task-input{flex:1;min-width:120px}.task-send{padding:10px 16px;border:0;border-radius:8px;background:var(--blue);color:white;font-size:12px}.task-status{font-size:10px;color:var(--muted);width:100%;padding-left:46px}.shell.focus{grid-template-columns:1fr}.shell.focus .sidebar{display:none}.shell.focus .conversation{grid-column:1}
@media(prefers-color-scheme:dark){:root{--ink:#dbe5de;--muted:#93a399;--line:#303c35;--panel:#1a221d;--base:#141b17;--blue:#8bb49b;--blue-soft:#273a2e;--green:#8ebd9f;--bad:#e29c8c;--shadow:none}.mark,.task-send{color:#142219}.oc{background:#342d40;color:#bcabd4}.ds{background:#263d35;color:#9ac7b7}.cx{background:#2c3542;color:#a9bada}.ki{background:#403729;color:#d2bb91}}
@media(max-width:900px){.topbar{height:auto;min-height:72px;padding:14px 18px;gap:12px;align-items:flex-start}.actions{max-width:320px;justify-content:flex-end}.shell{height:calc(100dvh - 92px);grid-template-columns:185px minmax(0,1fr)}.conversation-head,#timeline,.task-command{padding-left:20px;padding-right:20px}.toolbar{padding-left:20px;padding-right:20px;flex-wrap:wrap}.search{width:100%;margin:0}.live{max-width:90px;line-height:1.6}}
@media(max-width:620px){.brand-sub{display:none}.actions{max-width:210px}.btn{font-size:10px;padding:6px}.shell{grid-template-columns:1fr;height:calc(100dvh - 104px)}.sidebar{display:none;position:fixed;top:104px;bottom:0;left:0;width:240px;background:var(--base);z-index:5;box-shadow:12px 0 40px #0002}.shell:not(.focus) .sidebar{display:block}.conversation{grid-column:1}.conversation-title{font-size:18px}.work{grid-template-columns:1fr;gap:3px}.work-label{margin-top:5px}.conversation-head{padding-top:18px}.task-command-title{display:none}.task-status{padding:0}.bubble{padding:12px}}
@media(prefers-reduced-motion:no-preference){button{transition:background .15s,border-color .15s}}
.task-band{margin:0 32px 18px;padding:16px 18px;border-left:3px solid var(--blue);background:var(--base);border-radius:0 9px 9px 0}.band-label{font-size:11px;color:var(--muted);margin-bottom:5px}.band-title{font-size:16px;font-weight:600;line-height:1.55;overflow-wrap:anywhere}.band-facts{display:flex;flex-wrap:wrap;gap:5px 14px;font-size:11px;color:var(--muted);line-height:1.7;margin-top:8px}.band-evidence{font-size:12px;line-height:1.7;margin-top:10px;overflow-wrap:anywhere}.band-boundary{font-size:11px;line-height:1.7;color:var(--muted);margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}@media(max-width:900px){.task-band{margin-left:20px;margin-right:20px}}

[hidden]{display:none!important}.view-tabs{display:flex;gap:8px;padding:16px 32px;border-bottom:1px solid var(--line)}.control-pane{flex:1;overflow:auto;padding:24px 32px;min-height:0;overflow-anchor:none}.control-pane .task-band{margin:0 0 24px}.cli-run{margin:0 0 18px;max-width:1100px}.model-response{font:inherit;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}.control-pane details details{margin-left:18px}.control-pane pre{max-height:460px;overflow:auto}.control-pane h2{font-size:20px;margin-top:0}
.decision-card{border-bottom:1px solid var(--line);padding:8px 0 12px}.decision-card p{margin:0 0 8px;overflow-wrap:anywhere}.decision-options{display:flex;flex-wrap:wrap;gap:6px}.decision-options .btn{text-align:left;overflow-wrap:anywhere}.decision-feedback{min-height:0;margin-top:5px;color:var(--muted);font-size:12px}
/* Windows console structure, with a genuinely black canvas on Mac. */
:root{color-scheme:dark;--ink:#f2f2f2;--muted:#a1a1a1;--line:#242424;--panel:#000;--base:#000;--blue:#eee;--blue-soft:#161616;--green:#dedede;--bad:#ffaaa3;--shadow:none}
body,.topbar,.conversation,.sidebar,.shell,.control-pane,.view-tabs{background:#000}
.topbar{height:48px;min-height:48px;padding:0 20px;gap:12px;align-items:center}.shell{height:calc(100dvh - 48px);max-width:none}.brand-sub,.mark{display:none}.brand-title{font-size:13px;letter-spacing:.02em}
.btn,.side-button{border-radius:4px}.actions .btn{color:var(--muted)}.view-tabs{padding:5px 20px;gap:16px}.view-tabs .btn{color:var(--muted);border:0;border-bottom:1px solid transparent;border-radius:0;padding:7px 1px}.view-tabs .btn.primary{color:var(--ink);border-bottom-color:#bdbdbd;background:#000}
.side-apps{display:grid;gap:6px}.side-apps .btn{text-align:left}.control-pane:has(.console-board){padding:0;overflow:hidden}
.console-board{display:grid;grid-template-columns:minmax(230px,27%) minmax(0,1fr);height:100%;min-height:0;background:#000}
.console-left,.console-right{min-width:0;overflow:auto;overscroll-behavior:contain}.console-left{padding:18px 17px;border-right:1px solid var(--line)}.console-right{padding:18px clamp(18px,3vw,44px) 32px}
.console-label{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}.console-label h2,.console-section h2{margin:0;color:var(--muted);font-size:12px;line-height:1.5;font-weight:550;letter-spacing:.04em}.console-plan-title{font-size:15px;line-height:1.55;margin:0 0 4px;overflow-wrap:anywhere}.console-meta,.overview-note,.decision-feedback{color:var(--muted);font-size:12px;line-height:1.6}.console-meta{margin:0 0 16px}
.console-tree{margin-top:8px}.console-tree ul{list-style:none;margin:0;padding:0}.console-tree ul ul{margin-left:10px;padding-left:8px;border-left:1px solid var(--line)}.console-node{display:flex;align-items:baseline;gap:7px;width:100%;text-align:left;border:0;border-radius:3px;background:none;color:var(--muted);padding:6px 7px;line-height:1.45;overflow-wrap:anywhere}.console-node:hover,.console-node[aria-pressed=true]{background:#151515;color:var(--ink)}.console-node .dot{font-size:9px;flex:none;color:#858585}.console-node.running .dot{color:#eee}.console-node.blocked .dot{color:var(--bad)}
.console-section{padding:0 0 20px;margin:0 0 20px;border-bottom:1px solid var(--line)}.console-section h2{margin-bottom:10px}.console-detail h1{font-size:clamp(19px,2.3vw,29px);font-weight:600;line-height:1.35;margin:0 0 8px;overflow-wrap:anywhere}.console-detail .detail-note{max-width:70ch;white-space:pre-wrap;overflow-wrap:anywhere;color:#c4c4c4;line-height:1.7;margin:0 0 16px}.console-detail .overview-row{padding:8px 0;border-bottom:1px solid var(--line)}
.decision-card{background:#000;border-left:1px solid #737373;border-bottom:0;padding:9px 12px;margin:0 0 8px}.decision-card p{margin:0 0 8px;line-height:1.5}.decision-options .btn{color:var(--ink);background:#0a0a0a}.decision-options .btn:hover{background:#1a1a1a;border-color:#575757}.overview-link{background:none;border:0;color:#c9c9c9;padding:5px 0;font-size:12px}.overview-link:hover{text-decoration:underline}.overview-row{display:flex;justify-content:space-between;align-items:baseline;gap:14px;line-height:1.5}.overview-row span:first-child{min-width:0;overflow-wrap:anywhere}.overview-row span:last-child{flex:none;color:var(--muted);font-size:11px}.overview-row.attention span:last-child,.overview-warn{color:var(--bad)}.overview-warn{font-size:12px;line-height:1.6}.cli-run .details{margin-top:6px}
.console-board.tree-hidden{grid-template-columns:minmax(0,1fr)}.console-board.tree-hidden .console-left{display:none}.tree-reveal{display:none}.console-board.tree-hidden .tree-reveal{display:inline-block;margin-bottom:10px}
@media(max-width:700px){.topbar{padding:0 14px}.sidebar{top:48px}.view-tabs{padding:4px 14px;gap:12px;flex-wrap:wrap}.control-pane{padding:16px}.control-pane:has(.console-board){overflow:auto}.console-board{grid-template-columns:1fr;height:auto}.console-left,.console-right{overflow:visible;padding:14px}.console-left{border-right:0;border-bottom:1px solid var(--line);max-height:44vh;overflow:auto}}
/* v4 polish: teal accent, softer cards, consistent hierarchy */
:root{--ink:#e9f1f2;--muted:#8fa4a9;--line:#223034;--panel:#0e1416;--base:#0a0f11;--blue:#35b8a6;--blue-soft:#12312e;--green:#5fd0b5;--bad:#f0928a}
body{background:radial-gradient(1100px 520px at 18% -12%,#102225 0%,#0a0f11 58%)}
.topbar{background:rgba(14,20,22,.78);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.view-tabs{border-bottom-color:var(--line)}
.view-tabs .btn.primary{color:var(--blue);border-bottom-color:var(--blue)}
.console-section h2,.control-pane h2{font-size:12px;letter-spacing:.08em;color:var(--muted)}
.console-node:hover,.console-node[aria-pressed=true]{background:#132022;border-radius:7px}
.decision-card{background:linear-gradient(180deg,#101a1c,#0c1214);border:1px solid var(--line);border-left:2px solid var(--blue);border-radius:10px;padding:12px 14px}
.decision-options .btn{background:#132022;border:1px solid var(--line);border-radius:7px}
.decision-options .btn:hover{background:#173033;border-color:var(--blue)}
.cli-run.bubble{background:#0f1719;border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.console-plan-title{font-weight:600}
.goal-form{display:flex;gap:8px;margin:0 0 10px}.goal-form input{flex:1;background:#0f1719;border:1px solid var(--line);border-radius:8px;padding:9px 11px;color:var(--ink);font-size:13px}.goal-form .btn{white-space:nowrap}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand"><div class="mark">↔</div><div><div class="brand-title">协作台</div><div class="brand-sub">信使 / AI 协作</div></div></div>
  <div class="actions"><a class="btn" href="/codex-collab/window">返回主控台</a><button id="toggleSidebar" class="btn" aria-expanded="false">连接与工具</button></div>
</header>
<main class="shell">
  <section class="conversation"><div class="conversation-head"><div><div class="conversation-title">多 Harness 协作对话</div><div id="conversationCount" class="conversation-note">正在读取协作记录…</div></div><div id="syncStatus" class="live">记录自动刷新 · 连接未验证</div></div><section id="taskBand" class="task-band" aria-label="当前任务与最近回执"><div class="band-label">当前会话</div><div id="bandTitle" class="band-title">正在读取会话…</div><div id="bandFacts" class="band-facts"></div><div id="bandEvidence" class="band-evidence"></div><div id="bandBoundary" class="band-boundary"></div></section><div class="toolbar"><div id="participants" class="agents" aria-label="按参与者筛选"></div><input id="search" class="search" type="search" placeholder="搜索消息、任务或工具" aria-label="搜索协作记录"></div><div id="timeline"><div class="empty">正在读取协作记录…</div></div><div id="taskCommand" class="task-command"><span class="task-command-title">指令</span><select id="commandTarget" class="task-target" aria-label="指令接收方"><option value="DSH">给 DSH</option><option value="Codex">给 Codex</option></select><input id="commandText" class="task-input" placeholder="交代目标与验收标准…" aria-label="指令内容" /><button id="commandSend" class="task-send">发送</button><span id="commandStatus" class="task-status">发送成功只表示投递，完成需另行验收。</span></div></section>
  <aside class="sidebar">
    <div class="side-title">当前协作</div><div class="card"><div class="card-title">会话</div><select id="session" class="select"></select><div id="auth" class="pill">正在读取授权状态…</div></div>
    <div class="side-title">任务导航</div><div id="taskBoard" class="task-board"></div><div class="side-title">连接</div><div class="card"><div class="card-title">Codex 网络</div><div class="card-copy">遵循 macOS 当前的代理与网络设置。</div><button id="network" class="side-button">重新检查</button><div id="networkStatus" class="pill">打开 Codex 前自动检查</div></div>
    <div class="side-title">打开应用</div><div class="side-apps"><button id="openDeepSeekBrowser" class="btn">浏览器版</button><button id="openDeepSeek" class="btn primary">DeepSeek 桌面版</button><button id="openCodex" class="btn">打开 Codex</button><button id="openOpenCode" class="btn">打开 OpenCode</button></div>
  </aside>
</main>
<script>
const selectCollaborationSession=${selectCollaborationSession.toString()};
const $=s=>document.querySelector(s);const timeline=$('#timeline'),session=$('#session'),auth=$('#auth'),networkStatus=$('#networkStatus'),shell=$('.shell'),toggleSidebar=$('#toggleSidebar'),conversationCount=$('#conversationCount');
let userSelectedSession=false;
async function api(path,options){const r=await fetch(path,options);const v=await r.json();if(!r.ok)throw new Error(v.error||('HTTP '+r.status));return v}
const apiRoot='/codex-collab';
const labels={persisted:'已保存',delivered:'已进入 DSH 队列',read:'已读',processing:'处理中',completed:'处理回执已记录',failed:'处理失败','delivery-failed':'投递失败',received:'Codex 已收到',queued:'已排队'};
function addWork(grid,label,value,missing){const l=document.createElement('div'),v=document.createElement('div');l.className='work-label';l.textContent=label;v.className='work-value'+(missing?' missing':'');v.textContent=value;grid.append(l,v)}
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
let messageRows=[],participant='',taskFilter='',lastRender='',activeSession=null;
function actor(r,key){return r[key]||(key==='sender'?(r.direction==='codex-to-deepseek'?'Codex':'DeepSeek'):(r.direction==='codex-to-deepseek'?'DeepSeek':'Codex'))}
function acceptance(r){return r.acceptanceStatus==='passed'||r.acceptanceStatus==='accepted'?'验收通过':r.acceptanceStatus==='failed'?'验收未通过':'待验收'}
function stage(r){return r.status==='failed'||r.status==='delivery-failed'?'失败':r.status==='processing'?'处理中':r.kind==='result'?'已有回复':r.status==='completed'?'处理结束待核验':['persisted','delivered','read','received','queued'].includes(r.status)?'尚无运行回执':'状态未记录'}
function renderTaskBand(rows){const current=taskFilter?rows.filter(r=>r.taskId===taskFilter):rows;const latest=current.at(-1);const evidence=[...current].reverse().find(r=>r.result||r.workDone||r.kind==='result');$('#bandTitle').textContent=taskFilter?(current.find(r=>r.goal)?.goal||taskFilter):(activeSession?.task||'尚未选择协作会话');const facts=$('#bandFacts');facts.replaceChildren(el('span',activeSession?.authorized?'会话授权 · 允许投递':'会话授权 · 历史只读'),el('span','运行 · '+(latest?stage(latest):'暂无记录')),el('span',latest?acceptance(latest):'待验收'));if(latest){facts.append(el('span','最近交接 · '+actor(latest,'sender')+' → '+actor(latest,'recipient')))}const evidenceNode=$('#bandEvidence');evidenceNode.textContent=evidence?'最近回执 · '+(evidence.goal||evidence.action||'协作结果')+' · '+actor(evidence,'sender')+' · '+new Date(evidence.timestamp).toLocaleString([],{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'最近回执 · 暂无返回结果';evidenceNode.title=evidence?(evidence.result||evidence.workDone||evidence.action||''):'';const boundary=[...current].reverse().find(r=>r.boundary)?.boundary;$('#bandBoundary').textContent=boundary?'已记录约束 · '+boundary:'执行范围 · 当前记录未提供具体约束';$('#bandBoundary').title=boundary||''}
function renderTasks(rows){const board=$('#taskBoard');board.replaceChildren();const groups=new Map();for(const r of rows){if(!r.taskId)continue;groups.set(r.taskId,r)}const all=el('button','全部任务','task-card'+(!taskFilter?' active':''));all.onclick=()=>{taskFilter='';render(messageRows)};board.append(all);for(const [id,r] of groups){const card=el('button',undefined,'task-card'+(taskFilter===id?' active':''));card.append(el('div',r.goal||id,'task-id'),el('div',actor(r,'sender')+' → '+actor(r,'recipient'),'task-meta'),el('div',stage(r)+' · '+acceptance(r),'task-state'));card.title=id;card.onclick=()=>{taskFilter=id;render(messageRows)};board.append(card)}}
function render(rows){messageRows=rows;renderTaskBand(rows);const filter=$('#search').value.trim().toLowerCase();const filtered=rows.filter(r=>(!participant||actor(r,'sender')===participant||actor(r,'recipient')===participant)&&(!taskFilter||r.taskId===taskFilter)&&(!filter||[r.goal,r.action,r.result,r.context,r.toolsUsed,r.taskId,actor(r,'sender'),actor(r,'recipient')].join(' ').toLowerCase().includes(filter)));const fingerprint=JSON.stringify([filtered,rows.length,participant,taskFilter]);if(lastRender===fingerprint)return;lastRender=fingerprint;const bottom=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<80,top=timeline.scrollTop;timeline.replaceChildren();conversationCount.textContent=filtered.length+' 条记录 / '+rows.length+' 条 · 投递、运行、验收分别记录';renderTasks(rows);const participants=$('#participants');participants.replaceChildren();for(const name of ['', 'Codex','DeepSeek','OpenCode','Kimi']){const button=el('button',name||'全部','agent'+(participant===name?' active':''));button.setAttribute('aria-pressed',String(participant===name));button.onclick=()=>{participant=name;render(messageRows)};participants.append(button)}if(!filtered.length){timeline.append(el('div',rows.length?'没有符合筛选条件的记录':'还没有协作记录。发出任务后，回执和结果会显示在这里。','empty'));return}let day='';for(const r of filtered){const date=new Date(r.timestamp),dateLabel=Number.isNaN(date.getTime())?'时间未记录':date.toLocaleDateString();if(day!==dateLabel){day=dateLabel;timeline.append(el('div',day,'day'))}const sender=actor(r,'sender'),receiver=actor(r,'recipient'),kind=r.kind==='result'?'回复':r.kind==='command'?'指令':'消息',wrap=el('article',undefined,'msg'),avatar=el('div',sender==='OpenCode'?'OC':sender==='Kimi'?'KI':sender==='Codex'?'CX':'DS','mini-avatar '+(sender==='OpenCode'?'oc':sender==='Kimi'?'ki':sender==='Codex'?'cx':'ds')),stack=el('div',undefined,'stack'),meta=el('div',sender+' → '+receiver+' · '+kind+' · '+(Number.isNaN(date.getTime())?'':date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})),'meta'),bubble=el('div',undefined,'bubble'),work=el('div',undefined,'work');bubble.append(el('div',r.goal||'协作消息','goal'));if(r.action)addWork(work,kind==='回复'?'回复内容':'请求内容',r.action);if(r.workDone)addWork(work,'工作进展',r.workDone);if(r.result)addWork(work,'返回结果',r.result);bubble.append(work);const state=el('div',undefined,'state');state.append(el('span','投递 · '+(labels[r.status]||r.status||'未记录'),'status-chip'),el('span','运行 · '+stage(r),'status-chip'),el('span',acceptance(r),'status-chip'+(acceptance(r)==='验收通过'?' accepted':'')));bubble.append(state);const details=el('details',undefined,'details');details.append(el('summary','任务背景与技术详情'));const body=el('div',undefined,'detail-body');body.textContent=[r.context&&'背景：'+r.context,r.boundary&&'约束：'+r.boundary,r.toolsUsed&&'工具：'+r.toolsUsed,r.returnExpected&&'预期回执：'+r.returnExpected,r.taskId&&'任务 ID / 任务卡：'+r.taskId+(r.taskCardRef?' · '+r.taskCardRef:''),'消息 #'+String(r.id||'未记录'),r.replyToMessageId&&'回复 #'+r.replyToMessageId].filter(Boolean).join('\\n');details.append(body);bubble.append(details);if(r.deliveryError)bubble.append(el('div','投递错误：'+r.deliveryError,'state'));stack.append(meta,bubble);wrap.append(avatar,stack);timeline.append(wrap)}timeline.scrollTop=bottom?timeline.scrollHeight:top}
$('#search').oninput=()=>render(messageRows);
async function refresh(){const state=await api(apiRoot+'/window-data');const current=userSelectedSession?session.value:'';session.innerHTML='';const rows=[...state.sessions].sort((a,b)=>String(b.openedAt).localeCompare(String(a.openedAt)));for(const s of rows){const o=document.createElement('option');o.value=s.id;o.textContent=(s.purpose==='test'?'[联调] ':'')+(s.authorized?'● ':'○ ')+s.task;session.append(o)}const selected=selectCollaborationSession(rows,current,userSelectedSession);activeSession=selected;session.value=selected?.id||'';auth.className='pill '+(selected?.authorized?'ok':'');commandSend.disabled=!selected?.authorized;auth.textContent=selected?(selected.authorized?'协作已授权，可以继续投递':'授权已关闭，历史只读'):'没有协作会话';$('#syncStatus').textContent='记录已同步 · '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' · 非在线状态';if(selected){const c=await api(apiRoot+'/window-data?sessionId='+encodeURIComponent(selected.id));render(c.messages)}else render([])}
async function checkNetwork(){networkStatus.className='pill';networkStatus.textContent='正在经系统代理验证美国出口…';try{const v=await api(apiRoot+'/network');const allowed=v.allowed===true&&v.location==='US';networkStatus.className='pill '+(allowed?'ok':'bad');const reasons={SYSTEM_PROXY_DISABLED:'macOS 系统代理未开启；请启用美国节点的规则模式。',SYSTEM_PROXY_UNAVAILABLE:'无法读取 macOS 系统代理（scutil --proxy）。',PROXY_CONNECTION_REFUSED:'系统代理端口拒绝连接；请检查代理服务与端口。',PROXY_CONNECTION_TIMEOUT:'连接系统代理超时；请检查代理服务与端口。',CODEX_REGION_NOT_US:'出口地区为 '+(v.location||'未知')+' · 已阻止启动 Codex',REGION_UNVERIFIED:'无法确认出口地区 · 已阻止启动 Codex',NETWORK_UNAVAILABLE:'代理网络不可用；请检查系统代理地址与端口。'};networkStatus.textContent=allowed?'美国出口 · HTTPS 探测通过；长连接需另行验证':reasons[v.reason]||'网络探测失败：'+(v.reason||'未知原因');return allowed}catch(e){networkStatus.className='pill bad';networkStatus.textContent='网络检查失败：'+e.message;return false}}
toggleSidebar.onclick=()=>{const focused=shell.classList.toggle('focus');toggleSidebar.setAttribute('aria-expanded',String(!focused));localStorage.setItem('dsh-collab-tools-v2',focused?'hidden':'shown')};if(localStorage.getItem('dsh-collab-tools-v2')!=='shown'){shell.classList.add('focus')}else toggleSidebar.setAttribute('aria-expanded','true');
$('#network').onclick=checkNetwork;$('#openDeepSeek').onclick=async()=>{try{await api(apiRoot+'/open-deepseek-desktop',{method:'POST'})}catch(e){auth.className='pill bad';auth.textContent='打开桌面版失败：'+e.message}};$('#openDeepSeekBrowser').onclick=async()=>{try{await api(apiRoot+'/open-deepseek-browser',{method:'POST'})}catch(e){auth.className='pill bad';auth.textContent='打开浏览器版失败：'+e.message}};$('#openCodex').onclick=async()=>{if(!await checkNetwork())return;try{await api(apiRoot+'/open-codex',{method:'POST'});networkStatus.textContent='网络可用 · Codex 已打开'}catch(e){networkStatus.className='pill bad';networkStatus.textContent='打开失败：'+e.message}};$('#openOpenCode').onclick=async()=>{try{await api(apiRoot+'/open-opencode',{method:'POST'});auth.className='pill ok';auth.textContent='OpenCode 已打开；消息操作仍需逐次确认'}catch(e){auth.className='pill bad';auth.textContent='打开 OpenCode 失败：'+e.message}};session.onchange=()=>{userSelectedSession=true;taskFilter='';refresh()};
refresh().catch(e=>timeline.replaceChildren(el('div','读取失败：'+e.message,'empty')));setInterval(()=>refresh().catch(()=>{$('#syncStatus').textContent='连接中断 · 显示上次记录'}),2500);
const commandTarget=$('#commandTarget'),commandText=$('#commandText'),commandSend=$('#commandSend'),commandStatus=$('#commandStatus');
async function sendCommand(){const value=commandText.value.trim();if(!value)return;if(commandSend.disabled)return;const sessionId=session.value;if(!sessionId){commandStatus.textContent='先选会话';return}const to=commandTarget.value;const body={sessionId:sessionId,sender:'信使',recipient:to,kind:'command',goal:'信使指令',action:value,boundary:'来自协作窗口任务板的指令',returnExpected:'收到后回执'};body.direction=to==='Codex'?'deepseek-to-codex':'codex-to-deepseek';commandStatus.textContent='发送中…';commandSend.disabled=true;try{const r=await api(apiRoot+'/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});commandStatus.textContent='已投递 · 等待处理与验收';commandText.value='';refresh()}catch(e){commandStatus.textContent='失败：'+e.message}finally{commandSend.disabled=false}}
commandSend.onclick=sendCommand;commandText.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!commandSend.disabled){e.preventDefault();sendCommand()}});
const controlPane=el('section',undefined,'control-pane');controlPane.id='controlPane';const viewTabs=el('nav',undefined,'view-tabs');viewTabs.setAttribute('aria-label','协作视图');const conversation=$('.conversation');conversation.prepend(viewTabs);conversation.append(controlPane);let controlView='overview',controlFingerprint='',controlSnapshot=null;
const viewButtons=new Map();for(const [id,label] of [['overview','总览'],['goals','目标'],['plan','总计划'],['cli','执行记录'],['messages','协作消息']]){const b=el('button',label,'btn');b.onclick=()=>openView(id);viewButtons.set(id,b);viewTabs.append(b)}
function openView(id){controlView=id;controlFingerprint='';controlPane.scrollTop=0;selectView();renderControl(controlSnapshot)}
function selectView(){for(const [id,b] of viewButtons){b.setAttribute('aria-pressed',String(id===controlView));b.classList.toggle('primary',id===controlView)}for(const n of [...conversation.children])if(n!==viewTabs&&n!==controlPane)n.hidden=controlView!=='messages';controlPane.hidden=controlView==='messages'}
function controlDetail(key,title,text){const d=el('details',undefined,'details');d.dataset.controlKey=key;d.append(el('summary',title),el('pre',text,'detail-body'));return d}
let consolePlanId='',consoleNodeId='',consoleTreeHidden=false;
function renderOverview(data){
  const plan=data.plan,nodes=plan?.state?.nodes||{},ordered=[...new Set([...(plan?.state?.order||[]),...Object.keys(nodes)])].filter(id=>nodes[id]);
  const parents=new Set(ordered.map(id=>nodes[id].parent)),leaves=ordered.filter(id=>!parents.has(id));
  const done=new Set(['done','completed','passed']),progress=leaves.filter(id=>done.has(nodes[id].status)).length;
  const runs=data.runs||[],pending=runs.filter(r=>r.status==='awaiting_acceptance'),blocked=leaves.filter(id=>nodes[id].status==='blocked');
  const labels={active:'进行中',running:'进行中',pending:'未开始',blocked:'受阻',done:'完成',completed:'完成',passed:'完成',awaiting_acceptance:'待主控验收',accepted:'验收通过',failed:'执行失败',rejected:'验收未通过'};
  if(consolePlanId!==(plan?.planId||'')){consolePlanId=plan?.planId||'';consoleNodeId=''}
  if(!Object.hasOwn(nodes,consoleNodeId))consoleNodeId=leaves.find(id=>['active','running','blocked'].includes(nodes[id].status))||leaves[0]||ordered[0]||'';
  const board=el('div',undefined,'console-board'),left=el('aside',undefined,'console-left'),right=el('div',undefined,'console-right');
  board.append(left,right);controlPane.append(board);
  const link=(target,title,action)=>{const b=el('button',title,'overview-link');b.onclick=action;target.append(b);return b};
  const row=(target,title,state,attention=false)=>{const node=el('div',undefined,'overview-row'+(attention?' attention':''));node.append(el('span',title),el('span',state));target.append(node)};
  const section=(title)=>{const node=el('section',undefined,'console-section');node.append(el('h2',title));right.append(node);return node};
  const header=el('div',undefined,'console-label');header.append(el('h2','任务树'));left.append(header);
  const setTree=hidden=>{consoleTreeHidden=hidden;board.classList.toggle('tree-hidden',hidden)};
  link(header,'收起',()=>setTree(true));link(right,'展开任务树 →',()=>setTree(false)).className='overview-link tree-reveal';setTree(consoleTreeHidden);
  left.append(el('p',plan?.title||'协作总览','console-plan-title'),el('p',plan?'已完成 '+progress+' / '+leaves.length+' 项任务':'还没有可显示的总计划','console-meta'));
  const tree=el('nav',undefined,'console-tree');tree.setAttribute('aria-label','任务树');left.append(tree);
  const roots=el('ul');tree.append(roots);
  if(plan)link(left,'查看完整计划 →',()=>openView('plan'));
  const goalDecisions=(data.goals||[]).filter(x=>x.status==='blocked'&&x.wake);
  const itemCount=(data.inbox||[]).filter(x=>x.status==='pending').length+goalDecisions.length;
  const inbox=section('需要你决定'+(itemCount?' · '+itemCount:''));
  if(data.inboxError)inbox.append(el('p','暂时无法读取决策收件箱。','overview-warn'));
  else {
    const items=data.inbox||[];
    if(!items.some(x=>x.status==='pending'))inbox.append(el('p','暂无待你决定的事项。','overview-note'));
    for(const item of items.slice(0,6)){
      const card=el('article',undefined,'decision-card');
      const status=el('div',undefined,'decision-feedback');status.setAttribute('aria-live','polite');
      card.append(el('p',item.question));
      if(item.status==='pending'){
        const choices=el('div',undefined,'decision-options');const buttons=[];
        for(const [key,label] of Object.entries(item.options||{})){
          const b=el('button',key+' · '+label,'btn');buttons.push(b);choices.append(b);
          b.onclick=async()=>{
            buttons.forEach(x=>x.disabled=true);
            try{
              await api(apiRoot+'/inbox/answer',{method:'POST',headers:{'content-type':'application/json','x-xinshi-decision':'1'},body:JSON.stringify({id:item.id,version:item.version,choice:key})});
              status.textContent='已记录回答，等待主控领取。';
              await refreshControl();
            }catch(e){
              status.textContent='未提交：'+(e.message==='DECISION_STALE'?'这个问题已过期，请刷新。':e.message);
              buttons.forEach(x=>x.disabled=false);
            }
          };
        }
        card.append(choices);
      }else status.textContent=item.status==='claimed'?'主控已领取 · 等待验收':'已回答 · 等待主控领取';
      card.append(status);inbox.append(card);
    }
    if(items.length>6)inbox.append(el('p','还有 '+(items.length-6)+' 项，处理当前事项后会继续显示。','overview-note'));
    for(const g of goalDecisions.slice(0,4)){
      const card=el('article',undefined,'decision-card');
      card.append(el('p',g.wake.question||g.objective));
      card.append(el('p','目标 '+g.goalId+' · 原因 '+g.wake.reason+' · 在会话里回复 A/B','console-meta'));
      inbox.append(card);
    }
  }

  if(data.errors?.length||data.ok===false)right.append(el('p','部分记录无法读取。','overview-warn'));
  const detail=el('section',undefined,'console-detail');right.append(detail);
  const nodeButtons=new Map();
  const paintDetail=()=>{
    detail.replaceChildren();
    const node=nodes[consoleNodeId],nodeRuns=runs.filter(r=>r.nodeId===consoleNodeId);
    if(node){
      const note=plan?.blockedReasons?.[consoleNodeId]||node.note;
      const n=nodeRuns[0],meta=[labels[node.status]||'未标记',n?.harness].filter(Boolean).join(' · ');
      detail.append(el('div','当前任务','console-meta'),el('h1',node.title||consoleNodeId),el('p',meta,'console-meta'));
      if(note)detail.append(el('p',note,'detail-note'));
      if(n)row(detail,n.title||n.taskId||n.runId,labels[n.status]||'状态未标记',n.status==='failed');
      else detail.append(el('p','暂无执行记录。','overview-note'));
    }else detail.append(el('h1','暂无任务'));
    if(blocked.length||pending.length)detail.append(el('p',[blocked.length?blocked.length+' 项任务受阻':'',pending.length?pending.length+' 条结果待主控验收':''].filter(Boolean).join(' · '),'console-meta'));
    if(runs.length)link(detail,'查看执行记录 →',()=>openView('cli'));
  };
  const seen=new Set(), children=new Map();
  for(const id of ordered){const parent=nodes[id].parent;if(!children.has(parent))children.set(parent,[]);children.get(parent).push(id)}
  const draw=(id,target,depth=0)=>{
    if(seen.has(id))return;seen.add(id);
    const n=nodes[id],li=el('li'),b=el('button',undefined,'console-node'+(n.status==='blocked'?' blocked':['active','running'].includes(n.status)?' running':''));
    const dot=el('span',done.has(n.status)?'✓':n.status==='blocked'?'!':'●','dot');dot.setAttribute('aria-hidden','true');
    b.append(dot,el('span',n.title||id));b.setAttribute('aria-label',(n.title||id)+' · '+(labels[n.status]||'未标记'));
    b.setAttribute('aria-pressed',String(id===consoleNodeId));nodeButtons.set(id,b);
    b.onclick=()=>{consoleNodeId=id;for(const [key,button] of nodeButtons)button.setAttribute('aria-pressed',String(key===id));paintDetail()};
    li.append(b);target.append(li);
    if(depth<12&&(children.get(id)||[]).length){const ul=el('ul');li.append(ul);for(const child of children.get(id))draw(child,ul,depth+1)}
  };
  for(const id of ordered.filter(id=>!nodes[id].parent||!Object.hasOwn(nodes,nodes[id].parent)))draw(id,roots);
  for(const id of ordered)draw(id,roots);
  paintDetail();
}
function renderGoals(data){
  const goals=data.goals||[];
  controlPane.append(el('h2','目标'));
  const form=el('div',undefined,'goal-form');
  const input=el('input');input.placeholder='一句话目标，例如：把今天的会议记录整理成待办';
  const start=el('button','开始','btn primary');
  const status=el('div','','console-meta');
  start.onclick=async()=>{const value=input.value.trim();if(!value)return;start.disabled=true;status.textContent='已提交，正在起草目标…';try{await api(apiRoot+'/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({objective:value})});input.value='';status.textContent='已开始；目标出现后会自动刷新。'}catch(e){status.textContent=(String(e.message).includes('GOAL_BUSY')?'已有目标在执行，等它完成再开始。':'启动失败：'+e.message)}finally{start.disabled=false}};
  form.append(input,start);controlPane.append(form);controlPane.append(status);
  if(!goals.length){controlPane.append(el('div','还没有目标。在上面写一句，或对主对话说“做 X”。','empty'));return}
  const labels={running:'执行中',done:'完成',blocked:'需要决定'};
  for(const g of goals){
    const card=el('article',undefined,'cli-run bubble');
    card.append(el('div',g.objective||g.goalId));
    const cost=g.cost||{};const tokens=cost.tokens?cost.tokens.total:0;
    const source=g.source==='conversation'?' · 对话登记':(g.source==='panel'?' · 面板登记':'');
    card.append(el('div',(labels[g.status]||g.status)+' · '+(g.attempts||0)+' 次 · '+(cost.wallSeconds||0)+'s · '+(tokens||0)+' tok'+(g.wake?' · 原因 '+(g.wake.reason||g.wake):'')+source,'console-meta'));
    if(g.wake&&g.wake.question)card.append(el('p',g.wake.question,'detail-note'));
    if(g.status==='blocked'){
      const again=el('button','继续（新一轮）','btn');
      again.onclick=async()=>{again.disabled=true;card.append(el('div','已提交继续…','console-meta'));try{await api(apiRoot+'/goals/continue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId:g.runId})})}catch(e){again.disabled=false;card.append(el('div',(String(e.message).includes('GOAL_BUSY')?'已有目标在执行，稍后再继续。':'继续失败：'+e.message),'console-meta'))}};
      card.append(again);
    }
    if(g.status==='running'){card.append(el('div','执行中 · 第 '+Math.max(1,(g.progress&&g.progress.attempt)||g.attempts||1)+' 轮','console-meta'))}
    controlPane.append(card);
  }
}
function renderControl(data){if(!data||controlView==='messages')return;const fingerprint=JSON.stringify([controlView,data]);if(fingerprint===controlFingerprint)return;controlFingerprint=fingerprint;const opened=new Set([...controlPane.querySelectorAll('details[open]')].map(n=>n.dataset.controlKey));const top=controlPane.scrollTop;const consoleScroll=['.console-left','.console-right'].map(x=>controlPane.querySelector?.(x)?.scrollTop||0);controlPane.replaceChildren();
if(!data.available){controlPane.append(el('div',data.error?'协作登记读取失败 · '+data.error:'尚未登记命令行协作任务。由 Codex 派发后，这里显示真实命令、响应和验收。','empty'));return}
if(controlView==='overview'){renderOverview(data);for(const [i,sel] of ['.console-left','.console-right'].entries()){const n=controlPane.querySelector?.(sel);if(n)n.scrollTop=consoleScroll[i]}controlPane.scrollTop=top;return}
if(controlView==='goals'){renderGoals(data);controlPane.scrollTop=top;return}
const policy=el('div',undefined,'task-band');policy.append(el('div','Codex 主控 · 同一总计划 · 命令行执行','band-title'),el('div','简单 / 重复任务 → OpenCode 免费模型；常规协作 → DSH Flash；Codex 负责规划、监督和最终验收；Kimi 默认不启用。','card-copy'));policy.append(controlDetail('policy','查看当前费用与分工策略',JSON.stringify(data.policy,null,2)));controlPane.append(policy);
if(data.errors?.length)controlPane.append(el('pre','部分记录读取失败：\\n'+JSON.stringify(data.errors,null,2),'detail-body'));
const plan=data.plan,nodes=plan?.state?.nodes||{},order=plan?.state?.order||Object.keys(nodes);const ordered=[...new Set([...order,...Object.keys(nodes)])].filter(id=>nodes[id]);
if(controlView==='plan'){if(!plan){controlPane.append(el('div','已登记总计划暂不可读取，请查看上方错误。','empty'));return}const leaves=ordered.filter(id=>!ordered.some(child=>nodes[child].parent===id));const done=leaves.filter(id=>['done','completed','passed'].includes(nodes[id].status)).length;controlPane.append(el('h2',plan.title),el('p','与 Codex 内嵌 Plan Map 使用同一份源 · '+plan.planId+' · 版本 '+plan.revision+' · 叶子节点 '+done+'/'+leaves.length,'card-copy'));const owners=id=>[...new Set(data.runs.filter(r=>r.nodeId===id).map(r=>r.harness))].join(' / ')||'未派发';const visited=new Set();function draw(id,target){if(visited.has(id))return;visited.add(id);const n=nodes[id],d=controlDetail('node:'+id,n.title+' · '+n.status+' · '+owners(id),[n.note,plan.blockedReasons?.[id]&&'阻塞：'+plan.blockedReasons[id]].filter(Boolean).join('\\n'));const children=ordered.filter(child=>nodes[child].parent===id);for(const child of children)draw(child,d);target.append(d)}for(const id of ordered.filter(id=>!nodes[id].parent||!nodes[nodes[id].parent]))draw(id,controlPane);for(const id of ordered)if(!visited.has(id))draw(id,controlPane);
}else{controlPane.append(el('h2','命令行协作记录'));if(!data.runs.length)controlPane.append(el('div','当前总计划还没有命令行任务。此处不会把未执行的任务显示为在线或完成。','empty'));for(const run of data.runs){const card=el('article',undefined,'cli-run bubble');const accepted=run.acceptance?.status==='passed';card.append(el('div',run.title||run.taskId||run.runId,'goal'),el('div',(run.harness||'未记录执行者')+' · '+(run.model||'模型未记录')+' · 总计划节点 '+(nodes[run.nodeId]?.title||run.nodeId||'未关联'),'meta'),el('div','运行 · '+(run.status||'未记录')+' ｜ 最终验收 · '+(accepted?'通过':run.acceptance?.status==='failed'?'未通过':run.status==='failed'?'执行失败，未进入验收':'待 Codex 验收'),'status-chip'+(accepted?' accepted':'')));card.append(el('div',run.imported===true?'既有CLI回执导入':'本次命令行派发记录','card-copy'));if(run.input!==undefined)card.append(controlDetail('input:'+run.runId,'派发内容 · 公共任务 brief（展开）',typeof run.input==='string'?run.input:JSON.stringify(run.input,null,2)));card.append(controlDetail('command:'+run.runId,'真实命令 argv / cwd / stdin（展开）','argv: '+JSON.stringify(run.command?.argv||[])+'\\ncwd: '+(run.command?.cwd||'未记录')+'\\n\\n'+(run.command?.stdin||'')));card.append(controlDetail('response:'+run.runId,'模型回复',run.response||'尚无模型响应'));if(run.events?.length)card.append(controlDetail('events:'+run.runId,'已归档工具 / 过程输出 · 最近 '+run.events.length+' 条',run.events.map(e=>[e.at,e.kind,e.tool,e.state,e.text||JSON.stringify(e)].filter(Boolean).join(' · ')).join('\\n')));card.append(controlDetail('receipt:'+run.runId,'投递回执与验收证据（回执不等于验收）',JSON.stringify({receipt:run.receipt||null,acceptance:run.acceptance||{status:'pending'}},null,2)));controlPane.append(card)}}
for(const d of controlPane.querySelectorAll('details'))if(opened.has(d.dataset.controlKey))d.open=true;controlPane.scrollTop=top}
let refreshEpoch=0;
async function refreshControl(){const epoch=++refreshEpoch;try{
  const [control,inbox]=await Promise.allSettled([api(apiRoot+'/control'),api(apiRoot+'/inbox')]);
  if(epoch!==refreshEpoch)return;
  if(control.status!=='fulfilled')throw control.reason;
  controlSnapshot={...control.value,inbox:inbox.status==='fulfilled'?inbox.value.items:[],inboxError:inbox.status!=='fulfilled'};
  renderControl(controlSnapshot)
}catch(e){if(!controlSnapshot)controlPane.replaceChildren(el('div','命令行记录读取失败 · '+e.message,'empty'))}}

selectView();refreshControl();setInterval(refreshControl,2500);

</script></body></html>`;
}
