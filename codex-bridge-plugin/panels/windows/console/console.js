/* Real /console page.
   The layout / collapse / edge-pull / shortcut / localStorage logic below is
   the approved mock/v4-layout.js logic kept verbatim (grid, 28px whitespace,
   collapse-to-zero, keyboard `[ i d r f 0 ?`). Data wiring, rendering, the
   /api/detail drawer, theme persistence and the inbox action are new.
   Visual standard: runtime/board_ui/mock/console-v4.html — do not redesign. */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const esc=s=>(s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const now=()=>Date.now()/1000;
const ago=s=>{s=+s||0;const d=now()-s;return d<60?'刚刚':d<3600?Math.round(d/60)+' 分钟前':d<86400?Math.round(d/3600)+' 小时前':Math.round(d/86400)+' 天前'};
const hm=s=>{if(!s)return '';const d=new Date(s*1000);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')};
const T=n=>{n=+n||0;return n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(n>=1e8?0:1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(Math.round(n))};
const num=n=>(n==null||n==='')?'—':(+n).toLocaleString('zh-CN',{maximumFractionDigits:2});
function qreset(r){if(r==null||r==='')return '';const s=String(r);let d;if(/^\d+(\.\d+)?$/.test(s)){const v=+s;d=new Date(v>1e12?v:v*1000)}else d=new Date(s);if(isNaN(d.getTime()))return String(r);return (d.getMonth()+1)+'/'+d.getDate()}
const mtag=m=>/deepseek/i.test(m)?'deepseek':/sonnet/i.test(m)?'sonnet':/opus/i.test(m)?'opus':(m||'');
async function J(u,o={}){const opts={cache:'no-store',...o,headers:{...o.headers,...(o.method==='POST'?{'x-xinshi-decision':'1'}:{})}};const r=await fetch('/codex-collab/win-api'+u.replace(/^\/api/,''),opts);const data=await r.json();if(!r.ok)throw new Error(data.error||'HTTP '+r.status);return data}
async function Jor(u,fallback){try{return await J(u)}catch(e){return fallback}}

const ST_LABEL={blocked:'受阻',done:'完成',pending:'未开始',ok:'完成',warn:'完成·有告警',bad:'失败',run:'运行中',idle:'中断',gone:'已被接替',att:'待主控验收'};
const KIND={decide:{grp:'需要你决定',dot:'att'},ms:{grp:'里程碑完成',dot:'done'},fail:{grp:'失败',dot:'bad'},done:{grp:'完成 · 待验收',dot:'done'}};
const KIND_ORDER={decide:0,ms:1,fail:2,done:3};
const STG_CLS={done:'done',run:'run',att:'att',active:'run',ok:'done',bad:'bad',blocked:'att',pending:''};
const QNAME={gpt:'GPT',dsh:'DSH'};
const QORDER={gpt:0,dsh:1};
const PERIOD={'5h':'5 小时',week:'本周',month:'本月',balance:'余额',day:'今日'};

const S={tree:{nodes:[],unassigned:[]},inbox:{items:[],counts:{}},quota:null,loaded:false,offline:false,
         selKey:null,selInbox:null,acted:new Set(),busy:new Set(),errors:{},fold:{done:true,ms:true}};

/* ---------- data ---------- */
async function loadAll(){
  const [tree,inbox,quota]=await Promise.all([
    Jor('/api/tree',null),Jor('/api/inbox',null),Jor('/api/quota',null)
  ]);
  S.offline=!(tree&&inbox);
  if(tree&&Array.isArray(tree.nodes))S.tree=tree;
  if(inbox&&Array.isArray(inbox.items)){S.inbox=inbox;S.loaded=true}
  if(!S.selKey&&S.tree.nodes&&S.tree.nodes.length)S.selKey=S.tree.nodes[0].key;
  if(quota)S.quota=quota;else S.quota=null;
  renderAll();
}
function inboxItems(){
  const arr=(S.inbox.items||[]).filter(x=>!S.acted.has(x.id)).slice();
  arr.sort((a,b)=>((KIND_ORDER[a.kind]==null?9:KIND_ORDER[a.kind])-(KIND_ORDER[b.kind]==null?9:KIND_ORDER[b.kind]))||((+b.created_at||0)-(+a.created_at||0)));
  return arr;
}
function renderAll(){renderTree();renderResources();renderInbox();renderDetail();renderHero();mm()}

/* ---------- task tree ---------- */
const folded=new Set();
function visibleTree(){
  const nodes=S.tree.nodes||[], byKey=new Map(nodes.map(n=>[n.key,n]));
  return nodes.filter(n=>{const seen=new Set();let p=n.parent;while(p&&!seen.has(p)){if(folded.has(p))return false;seen.add(p);p=byKey.get(p)?.parent}return true});
}
function treeDepth(n,nodes){const by=new Map(nodes.map(v=>[v.key,v]));let depth=0,p=n.parent;const seen=new Set();while(p&&by.has(p)&&!seen.has(p)&&depth<9){seen.add(p);depth++;p=by.get(p).parent}return depth}
function renderTree(){
  const nodes=visibleTree(), all=S.tree.nodes||[];
  $('ol').innerHTML=nodes.map(n=>{
    const depth=treeDepth(n,all);
    const hasChild=all.some(m=>m.parent===n.key);
    const tw=hasChild?(folded.has(n.key)?'▸':'▾'):'';
    const meta=n.progress?n.progress.join('/'):(ST_LABEL[n.status]||'');
    return `<div style="padding-left:${depth*14+4}px" class="n l${Math.min(depth,2)}${n.key===S.selKey?' sel':''}" data-key="${esc(n.key)}"><span class="tw"${hasChild?' data-fold-node="1"':''}>${tw}</span><i class="d ${esc(n.status||'')}"></i><span class="nm">${depth===0?'<b>'+esc(n.title)+'</b>':esc(n.title)}</span><span class="m">${esc(meta)}</span></div>`;
  }).join('')+`<div class="n unc"><span class="tw"></span><i class="d"></i><span class="nm">未归类 ${(S.tree.unassigned||[]).length} 个包</span><span class="m"></span></div>`+(S.tree.unassigned||[]).map(p=>`<div class="n l1" data-pkg="${esc(p.id)}" data-dir="${esc(p.dir)}"><span class="nm">${esc(p.title)}</span></div>`).join('');
  $('treeCount').textContent=all.length;
}
/* mind map (shown when the tree container is >= 720px) */
function mm(){
  const box=$('mm');if(!box||getComputedStyle(box).display==='none')return;
  const wrap=box.parentElement,W=wrap.clientWidth,H=Math.max(wrap.clientHeight-10,300);
  if(!W)return;
  box.style.height=H+'px';
  box.querySelectorAll('.nd').forEach(n=>n.remove());
  const nodes=visibleTree(),s=$('mmsvg');
  if(!nodes.length){s.innerHTML='';return}
  const cols=[0,Math.round(W*.32),Math.round(W*.64)];
  const step=(H-30)/Math.max(1,nodes.length-1);
  const byKey={};nodes.forEach((n,i)=>byKey[n.key]=i);
  const created=[],pos=[];
  nodes.forEach((n,i)=>{
    const depth=Math.min(cols.length-1,treeDepth(n,nodes));
    const d=document.createElement('div');
    d.className='nd'+(depth===0?' root':'')+(n.key===S.selKey?' sel':'');
    d.dataset.key=n.key;
    const meta=n.progress?n.progress.join('/'):(ST_LABEL[n.status]||'');
    d.style.top=(15+i*step)+'px';d.style.left=cols[depth]+'px';
    d.innerHTML=`<i class="d ${esc(n.status||'')}"></i>${esc(n.title)}<em>${esc(meta)}</em>`;
    box.appendChild(d);created.push(d);
  });
  created.forEach((d,i)=>{
    const depth=Math.min(cols.length-1,treeDepth(nodes[i],nodes));
    const x=Math.max(4,Math.min(cols[depth],W-d.offsetWidth-6));
    d.style.left=x+'px';pos.push([x,15+i*step]);
  });
  const parts=[];
  nodes.forEach((n,i)=>{
    if(n.parent==null)return;
    const p=byKey[n.parent];if(p==null)return;
    const x1=pos[p][0]+created[p].offsetWidth,y1=pos[p][1],x2=pos[i][0],y2=pos[i][1],m=(x1+x2)/2;
    parts.push(`<path d="M${x1} ${y1} C${m} ${y1},${m} ${y2},${x2} ${y2}" fill="none" stroke="var(--faint)" stroke-width="1.5"/>`);
  });
  s.innerHTML=parts.join('');
}
window.__mm=mm;

/* ---------- AI resources (/api/quota) ---------- */
function renderResources(){
  let rows=[];
  if(Array.isArray(S.quota))rows=S.quota.slice();
  else if(S.quota&&Array.isArray(S.quota.items))rows=S.quota.items.slice();
  rows.sort((a,b)=>(QORDER[a.key]==null?99:QORDER[a.key])-(QORDER[b.key]==null?99:QORDER[b.key]));
  if(!rows.length){$('resb').innerHTML='<div class="ag"><b>额度</b><span class="v">—</span><span class="s">暂无数据</span></div>';return}
  $('resb').innerHTML=rows.map(r=>{
    const name=QNAME[r.key]||r.agent||'—',p=r.pct_used;
    let big='—',sub='',pct=null,cls='';
    if(r.status&&r.status!=='ok'){big='未知';sub=r.reason||'暂无数据';}
    else if(r.unit==='CNY'&&r.remaining!=null){big='¥'+num(r.remaining);sub='余额';}
    else if(p!=null){big=num(p)+'%';pct=Math.max(0,Math.min(100,p));}
    else if(r.used!=null&&r.limit!=null){pct=Math.max(0,Math.min(100,Math.round(r.used/r.limit*100)));big=pct+'%';}
    else if(r.used!=null){big=num(r.used);}
    if(!sub){sub=[PERIOD[r.period]||'',qreset(r.reset_at),(r.used!=null&&r.limit!=null)?num(r.used)+' / '+num(r.limit):'',r.note||''].filter(Boolean).join(' · ');}
    if(pct!=null&&pct>=90)cls='red';else if(pct!=null&&pct>=75)cls='hot';
    const bar=pct!=null?`<div class="q"><i class="${cls}" style="width:${pct}%"></i></div>`:'';
    return `<div class="ag"><b>${esc(name)}</b><span class="v">${esc(big)}</span><span class="s">${esc(sub)}</span>${bar}</div>`;
  }).join('');
}

/* ---------- inbox ---------- */
function renderQueuedHint(){
  const q=(S.inbox.counts||{}).queued||0;
  let h=$('queuedHint');
  if(!h){h=document.createElement('span');h.id='queuedHint';
    h.style.cssText='color:var(--dim);font-size:11px;font-weight:400;letter-spacing:0';
    const lbl=document.querySelector('#inbox .lbl');
    if(lbl)lbl.insertBefore(h,lbl.querySelector('.hide'));}
  h.textContent=q>0?(q+' 条决定等主控处理'):'';
}
function renderInbox(){
  const items=inboxItems();
  renderQueuedHint();
  if(!items.some(x=>x.id===S.selInbox))S.selInbox=items.length?items[0].id:null;
  let last='',shown={};
  const cnt={};items.forEach(x=>cnt[x.kind]=(cnt[x.kind]||0)+1);
  if(!S.loaded){$('list').innerHTML=`<div class="grp">${S.offline?'看板服务暂时连不上，10 秒后自动重试':'正在读取…'}</div>`;$('inboxCount').textContent='';return}
  if(!items.length){$('list').innerHTML='<div class="grp">没有需要你处理的事</div>';$('inboxCount').textContent='0';syncAmberHint();return}
  $('list').innerHTML=items.map(x=>{
    const k=KIND[x.kind]||{grp:'其它',dot:''};
    shown[x.kind]=(shown[x.kind]||0)+1;
    const folded=S.fold[x.kind]&&cnt[x.kind]>3&&x.id!==S.selInbox;
    if(folded&&shown[x.kind]>3){if(shown[x.kind]===4)return `<button class="unfold" data-unfold="${esc(x.kind)}">还有 ${cnt[x.kind]-3} 条</button>`;return ''}
    const tools=(x.kind==='done'||x.kind==='ms')?`<span class="gt">${cnt[x.kind]>3?`<button data-fold="${esc(x.kind)}">${S.fold[x.kind]?'展开':'收起'}</button> · `:''}<button data-readall="${esc(x.kind)}">全部已读</button></span>`:'';
    const g=x.kind!==last?`<div class="grp">${esc(k.grp)} <span class="gn">${cnt[x.kind]}</span>${tools}</div>`:'';last=x.kind;
    const sel=x.id===S.selInbox;
    const opts=(x.options||[]).map(o=>`<button class="opt" data-choice="${esc(o.key)}"><b>${esc(o.key)}</b>${esc(o.label)}${o.hint?`<small>${esc(o.hint)}</small>`:''}</button>`).join('');
    const err=S.errors[x.id]?`<div class="err">发送失败：${esc(S.errors[x.id])}</div>`:'';
    return g+`<div class="it${sel?' sel':''}" data-id="${esc(x.id)}"><i class="d ${k.dot}"></i><div class="t1"><span>${esc(x.title)}</span><small>${esc(x.task_title||'')}${x.parent_title?' ‹ '+esc(x.parent_title):''}${x.who?' · '+esc(x.who):''}</small></div>
     <div class="more"><div class="ctx">${esc(x.context||'')}</div><div class="opts">${opts}</div>${x.kind==='decide'?'<input class="say" placeholder="或者直接写一句，回车发给主控" value="">':''}</div>${err}</div>`;
  }).join('');
  $('inboxCount').textContent=items.length;
  const pill=$('eT').querySelector('.pill');if(pill)pill.textContent='↓ 需要处理的事 '+items.length;
  syncAmberHint();
}
let toastTimer=null;
function toast(msg,ms){const t=$('toast');t.textContent=msg;t.classList.add('on');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('on'),ms||3000)}
const NEXT_MSG={resumed:'已交给执行者，在原会话继续',accepted:'已记下',dismissed:'已放弃',read:'已读'};
async function act(x,choice,text,row){
  if(S.busy.has(x.id))return;S.busy.add(x.id);
  if(row)row.style.pointerEvents='none';
  try{
    const d=await J('/api/inbox/act',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:x.id,version:x.version,choice:choice||null,text:text||null})});
    if(!d||d.ok===false)throw new Error((d&&d.error)||'操作未完成');
    S.acted.add(x.id);
    if(row){row.style.transition='opacity .4s';row.style.opacity='0'}
    const msg=d.next==='queued'?('已记下，'+(d.controller||'GPT')+' 下个检查点处理'):(NEXT_MSG[d.next]||'已处理');
    toast(msg,3000);
    setTimeout(renderInbox,420);
  }catch(err){
    S.busy.delete(x.id);if(row)row.style.pointerEvents='';
    const msg=err.message||'发送失败';S.errors[x.id]=msg;
    if(row){let e=row.querySelector('.err');if(!e){e=document.createElement('div');e.className='err';row.appendChild(e)}e.textContent='发送失败：'+msg}
  }
}

async function readAll(kind){
  if(S.busy.has('readall'))return;S.busy.add('readall');
  try{const d=await J('/api/inbox/read_all',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind})});
    (S.inbox.items||[]).filter(y=>y.kind===kind).forEach(y=>S.acted.add(y.id));renderInbox();toast('已读 '+((d&&d.count)||0)+' 件',3000)}
  catch(e){toast('没有成功：'+(e.message||''),4000)}finally{S.busy.delete('readall')}
}

/* ---------- task detail ---------- */
function renderDetail(){
  const nodes=S.tree.nodes||[];
  let n=nodes.find(x=>x.key===S.selKey)||nodes[0];
  if(!n){$('detBody').innerHTML='<div class="dh"><h2>暂无任务</h2></div>';return}
  S.selKey=n.key;
  const parent=n.parent?nodes.find(x=>x.key===n.parent):null;
  const pkgs=n.packages||[],byId={};pkgs.forEach(p=>byId[p.id]=p);
  let stages=n.stages;
  if(!stages||!stages.length)stages=[{title:'工作包',status:'run',packages:pkgs.map(p=>p.id)}];
  const pkHtml=id=>{
    const p=byId[id]||{id:id,title:id,status:'',updated_at:0,last_action:'',dir:''};
    return `<div data-pkg="${esc(p.id)}" data-dir="${esc(p.dir||'')}" style="cursor:pointer"><i class="d ${esc(p.status||'')}"></i>${esc(p.title||p.id)}${p.last_action?' · '+esc(p.last_action):''}<em>${p.updated_at?esc(ago(p.updated_at)):''}</em></div>`;
  };
  const stageHtml=st=>{
    const cls=STG_CLS[st.status]||'',cnt=(st.packages||[]).length;
    const lbl=st.status==='done'?'已验收':(st.status==='run'||st.status==='active')?'进行中':st.status==='att'?'待主控验收':st.status==='blocked'?'受阻':'未开始';
    return `<div class="stg ${cls}"><i></i><div><div class="h"><span>${esc(st.title)}</span><em>${cnt?cnt+' 个包 · ':''}${esc(lbl)}</em></div><div class="pk">${(st.packages||[]).map(pkHtml).join('')}</div></div></div>`;
  };
  const acts=pkgs.slice().sort((a,b)=>(+b.updated_at||0)-(+a.updated_at||0)).slice(0,12)
    .map(p=>`<div><time>${p.updated_at?hm(p.updated_at):''}</time><span>${esc(p.last_action||p.title||p.id)}</span></div>`).join('');
  $('detBody').innerHTML=
   `<div class="dh"><h2>${esc(n.title)}</h2>${parent?`<small>‹ ${esc(parent.title)}</small>`:''}</div>
    ${n.note?`<p class="tree-note">${esc(n.note)}</p>`:''}<div class="own"><span>主控 <b>${esc(n.controller||'—')}</b></span><span>执行 <b>${esc(n.executor||'—')}</b></span><span>模块 <b>${esc((n.modules||[]).join('、')||'—')}</b></span><span>更新 <b>${n.updated_at?esc(ago(n.updated_at)):'—'}</b></span></div>
    <div class="det"><div>${stages.map(stageHtml).join('')}</div><div class="act"><h4>最近动作 · ${esc(n.title)}</h4>${acts||'<div style="color:var(--dim);font-size:12.5px">暂无动作</div>'}</div></div>`;
}
function renderHero(){
  const items=inboxItems(),nodes=S.tree.nodes||[];
  const runNodes=nodes.filter(n=>n.status==='run'&&n.planId).length;
  const pkgs=nodes.reduce((a,n)=>a+(n.packages||[]).filter(p=>p.status==='run').length,0);
  $('heroH').textContent=items.length?'有 '+items.length+' 件事需要你':'无需你处理';
  $('heroP').textContent=runNodes+' 个任务在推进 · '+pkgs+' 个包在跑';
}

/* ---------- /api/detail drawer (reuses calm.html's drawer code, v4 styled) ---------- */
function openDrawer(dir,pkgid){
  const d=$('drawer');$('veil').classList.add('on');d.classList.add('on');d.setAttribute('aria-hidden','false');
  $('dwT').textContent=pkgid||'工作包详情';
  if(!dir){$('dwB').innerHTML='<p class="dw-empty">示例数据：暂没有可展开的执行详情。接口就绪后，点这里会读取 /api/detail 的回复与最近动作。</p>';return}
  $('dwB').innerHTML='<p class="dw-empty">正在读取详情…</p>';
  J('/api/detail?dir='+encodeURIComponent(dir)).then(data=>{
    const g=[['状态',`<span class="dw-st-${esc(data.status)}">${esc(data.label||ST_LABEL[data.status]||data.status||'—')}</span>`],
      ['执行者',esc(data.agent||'—')+(data.model?' · '+esc(mtag(data.model)):'')],
      ['时间',esc(data.time||'—')],
      ['用量',data.usageAvailable===false?'未提供':('入 '+T(data.tokens_in)+' / 出 '+T(data.tokens_out))]];
    const acts=(data.activity||[]).map(a=>`<div><time>${a.t?hm(a.t):''}</time><span>${esc(a.what)}</span></div>`).join('');
    const files=(data.files||[]).map(f=>`<a target="_blank" href="/codex-collab/win-api/file?dir=${encodeURIComponent(data.dir||'')}&amp;name=${encodeURIComponent(f)}" rel="noopener">${esc(f)}</a>`).join('');
    $('dwB').innerHTML=`<dl class="dw-kv">${g.map(p=>`<dt>${p[0]}</dt><dd>${p[1]}</dd>`).join('')}</dl>
      ${data.reason&&data.status!=='ok'?`<div class="dw-r">${esc(data.reason)}</div>`:''}
      ${data.goal?`<div class="dw-lbl">这个包要做什么</div><p style="font-size:14px;color:var(--tx)">${esc(data.goal)}</p>`:''}
      ${acts?`<div class="dw-lbl">最近动作</div><div class="dw-act">${acts}</div>`:''}
      <div class="dw-lbl">执行者的回复</div><pre class="dw-pre">${esc(data.reply||'（无回复）')}</pre>
      <details style="margin-top:12px"><summary class="dw-lbl" style="cursor:pointer">任务说明（${(data.prompt||'').length} 字）</summary><pre class="dw-pre">${esc(data.prompt||'')}</pre></details>
      ${data.command?`<details><summary class="dw-lbl">原生 CLI 命令</summary><pre class="dw-pre">${esc(data.command)}</pre></details>`:''}<div class="dw-lnk">${files}<button data-open="${esc(data.dir||'')}">打开文件夹</button></div>
      <details><summary class="dw-lbl">工作包归属与归档</summary>
        <label>展示位置 <select id="pkgPlace"><option value="">原有归属</option>${(data.placementOptions||[]).map(n=>`<option value="${esc(n.key)}"${n.key===data.placement?' selected':''}>${esc(n.title)}</option>`).join('')}</select></label>
        <button data-assign="${esc(data.id)}">保存归属</button>
        ${data.status==='run'?'':`<button data-archive="${esc(data.id)}" data-archived="${data.archived?'0':'1'}">${data.archived?'取消归档':'归档'}</button>`}
      </details>`;
  }).catch(e=>{$('dwB').innerHTML='<p class="dw-empty">读取失败：'+esc(e.message)+'</p>'});
}
function closeDrawer(){$('drawer').classList.remove('on');$('veil').classList.remove('on');$('drawer').setAttribute('aria-hidden','true')}
async function openFolder(p){try{await J('/api/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir:p})})}catch(e){}}

/* ---------- interaction wiring ---------- */
document.addEventListener('click',e=>{
  const cl=sel=>e.target.closest?e.target.closest(sel):null;
  const opt=cl('.opt');
  if(opt){const it=opt.closest('.it');if(!it)return;const x=(S.inbox.items||[]).find(y=>y.id===it.dataset.id);if(x)act(x,opt.dataset.choice,null,it);return}
  const uf=cl('[data-unfold]');if(uf){S.fold[uf.dataset.unfold]=false;renderInbox();return}
  const fd=cl('[data-fold]');if(fd){S.fold[fd.dataset.fold]=!S.fold[fd.dataset.fold];renderInbox();saveLayout();return}
  const ra=cl('[data-readall]');if(ra){readAll(ra.dataset.readall);return}
  const it=cl('.it');
  if(it&&!cl('.opt')&&!cl('.say')){S.selInbox=it.dataset.id;renderInbox();return}
  const node=cl('[data-key]');
  if(node){const k=node.dataset.key;if(cl('[data-fold-node]')){if(folded.has(k))folded.delete(k);else folded.add(k)}else S.selKey=k;renderTree();renderDetail();mm();saveLayout();return}
  const pkg=cl('[data-pkg]');if(pkg){openDrawer(pkg.dataset.dir,pkg.dataset.pkg);return}
  if(cl('#dwX')||e.target===$('veil')){closeDrawer();return}
  const as=cl('[data-assign]');if(as){J('/api/assign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:as.dataset.assign,target:$('pkgPlace').value||null})}).then(()=>{toast('归属已保存');loadAll()}).catch(e=>toast(e.message));return}
  const ar=cl('[data-archive]');if(ar){J('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:ar.dataset.archive,archived:ar.dataset.archived==='1'})}).then(()=>{closeDrawer();loadAll();toast('归档状态已更新')}).catch(e=>toast(e.message));return}
  if(cl('#openArchive')){J('/api/archive').then(d=>{$('drawer').classList.add('on');$('veil').classList.add('on');$('drawer').setAttribute('aria-hidden','false');$('dwT').textContent='已归档工作包';$('dwB').innerHTML=d.runs.length?d.runs.map(r=>`<div><button data-pkg="${esc(r.id)}" data-dir="${esc(r.id)}">${esc(r.title)}</button></div>`).join(''):'暂无归档';}).catch(e=>toast(e.message));return}
  const o=cl('[data-open]');if(o){e.preventDefault();openFolder(o.dataset.open)}
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeDrawer();$('help').classList.remove('on');return}
  if(e.key==='Enter'&&e.target&&e.target.classList&&e.target.classList.contains('say')){
    const it=e.target.closest('.it'),text=(e.target.value||'').trim();
    if(it&&text){const x=(S.inbox.items||[]).find(y=>y.id===it.dataset.id);if(x)act(x,null,text,it)}
  }
});

/* ---------- layout (approved mock/v4-layout.js, kept verbatim) ---------- */
const sh=$('shell'),cL=$('cL'),cR=$('cR');
const DEF={lw:.19,lv:.62,rv:.30,open:{tree:1,res:1,inbox:1,det:1}};
const clone=o=>JSON.parse(JSON.stringify(o));let L=clone(DEF);
let layoutReady=false,saveTimer;
function saveLayout(){if(!layoutReady)return;clearTimeout(saveTimer);saveTimer=setTimeout(()=>J('/api/layout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...L,selected:S.selKey,folded:[...folded],inboxFold:S.fold})}).catch(()=>{}),280)}
async function restoreLayout(){const d=await Jor('/api/layout',null);if(d?.layout){const x=d.layout;L={...DEF,...x,open:{...DEF.open,...x.open}};S.selKey=x.selected;for(const k of x.folded||[])folded.add(k);S.fold={...S.fold,...x.inboxFold}}layoutReady=true;apply()}
const G='var(--gap)';
function pair(a,b,r){const A=L.open[a],B=L.open[b];
 return A&&B?`minmax(90px,${r}fr) ${G} minmax(90px,${1-r}fr)`:A?`1fr 0 0`:B?`0 0 1fr`:`0 0 0`}
/* amber hint on the top edge only when the inbox is collapsed AND it has items */
function syncAmberHint(){$('eT').classList.toggle('att',!L.open.inbox&&inboxItems().length>0)}
function apply(){const o=L.open,lOn=o.tree||o.res,rOn=o.inbox||o.det;
 sh.style.gridTemplateColumns=lOn&&rOn?`minmax(180px,${L.lw}fr) ${G} minmax(420px,${1-L.lw}fr)`:lOn?`1fr 0 0`:rOn?`0 0 1fr`:`0 0 0`;
 cL.style.gridTemplateRows=pair('tree','res',L.lv);cR.style.gridTemplateRows=pair('inbox','det',L.rv);
 ['tree','res','inbox','det'].forEach(k=>$(k).classList.toggle('gone',!o[k]));
 sh.classList.toggle('empty',!lOn&&!rOn);
 document.querySelector('[data-split=lv]').classList.toggle('off',!(o.tree&&o.res));
 document.querySelector('[data-split=rv]').classList.toggle('off',!(o.inbox&&o.det));
 document.querySelector('[data-split=lw]').classList.toggle('off',!(lOn&&rOn));
 $('eL').hidden=!!(o.tree&&o.res);$('eT').hidden=!!o.inbox;$('eB').hidden=!!o.det;
 syncAmberHint();
 $('eL').querySelector('.pill').textContent=!o.tree&&!o.res?'任务树 · AI 资源 →':!o.tree?'任务树 →':'AI 资源 →';
 saveLayout();setTimeout(()=>window.__mm&&window.__mm(),240)}
document.addEventListener('click',e=>{const h=e.target.closest&&e.target.closest('[data-hide]');if(h){L.open[h.dataset.hide]=0;apply()}});
document.querySelectorAll('.edge').forEach(ed=>ed.addEventListener('pointerdown',e=>{try{ed.setPointerCapture(e.pointerId)}catch(_){};ed.classList.add('drag');const y0=e.clientY,x0=e.clientX,k=ed.dataset.edge;
 const up=ev=>{ed.classList.remove('drag');ed.removeEventListener('pointerup',up);const dx=ev.clientX-x0,dy=ev.clientY-y0,W=innerWidth,H=innerHeight;
  if(k==='left'){L.open.tree=L.open.res=1;if(dx>8)L.lw=Math.min(.6,Math.max(.12,ev.clientX/W))}
  if(k==='inbox'){L.open.inbox=1;if(dy>8&&L.open.det)L.rv=Math.min(.85,Math.max(.12,ev.clientY/H))}
  if(k==='det'){L.open.det=1;if(dy<-8&&L.open.inbox)L.rv=Math.min(.85,Math.max(.12,ev.clientY/H))}
  apply()};ed.addEventListener('pointerup',up)}));
document.querySelectorAll('[data-split]').forEach(g=>{g.addEventListener('dblclick',()=>{L[g.dataset.split]=DEF[g.dataset.split];apply()});
 g.addEventListener('pointerdown',e=>{if(g.classList.contains('off'))return;try{g.setPointerCapture(e.pointerId)}catch(_){};const k=g.dataset.split,box=(k==='lw'?sh:g.parentElement).getBoundingClientRect();
  const mv=ev=>{if(k==='lw')L.lw=Math.min(.6,Math.max(.12,(ev.clientX-box.left)/box.width));else L[k]=Math.min(.88,Math.max(.12,(ev.clientY-box.top)/box.height));apply()};
  const up=()=>{g.removeEventListener('pointermove',mv);g.removeEventListener('pointerup',up)};g.addEventListener('pointermove',mv);g.addEventListener('pointerup',up)})});
document.addEventListener('keydown',e=>{const t=e.target;if(t&&t.matches&&t.matches('input,textarea'))return;const o=L.open;
 if(e.key==='['){const any=o.tree||o.res;o.tree=o.res=any?0:1}else if(e.key==='i')o.inbox^=1;else if(e.key==='d')o.det^=1;else if(e.key==='r')o.res^=1;
 else if(e.key==='f')L.open={tree:0,res:0,inbox:0,det:1};else if(e.key==='0')L=clone(DEF);else if(e.key==='?'){$('help').classList.toggle('on');return}else return;apply()});
$('help').onclick=()=>$('help').classList.remove('on');$('hp').onclick=()=>$('help').classList.add('on');
function setTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem('console-theme',t)}catch(e){}}
$('th').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');

/* ---------- init ---------- */
apply();
renderAll();
restoreLayout().then(loadAll);
setInterval(()=>{if(!document.hidden)loadAll()},10000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadAll()});
})();
