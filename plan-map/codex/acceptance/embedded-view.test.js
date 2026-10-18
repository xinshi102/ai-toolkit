import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { layoutTree, truncateToWidth, linkPath } from '../web/layout.js';
import { STATUS_GLYPH, ancestorPath, validParent, movedOffset, manualLayout } from '../web/interaction.js';
import { graphViewport, clampZoom, MIN_ZOOM } from '../web/viewport.js';

// Exercise the real embedded app with a minimal host/DOM. No user plans or browser profile.
function app(saved) {
  class Element {
    constructor() { this.style={setProperty(k,v){this[k]=v;}};this.attributes={};this.children=[];this.hidden=true;this.clientWidth=360;this.clientHeight=280;this.scrollHeight=1800;this.scrollTop=0;this.scrollLeft=0; }
    setAttribute(k,v){this.attributes[k]=v;}
    getAttribute(k){return this.attributes[k];}
    append(...children){for(const c of children){c.parent=this;this.children.push(c);}}
    replaceChildren(...children){this.children=[];this.append(...children);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
    add(value){this.append(value);}
    focus(){}
    select(){}
    querySelectorAll(selector){const all=[];const walk=e=>{for(const c of e.children){all.push(c);walk(c);}};walk(this);return all.filter(c=>(c.attributes.class||'').split(' ').includes(selector.slice(1)));}
    getAnimations(){return [];}
    getBoundingClientRect(){return {height:320};}
  }
  const els=new Map(), storage=new Map(saved ? [['plan-map-view:embedded',JSON.stringify(saved)]] : []);
  const window={addEventListener(){}};
  const document={body:new Element(),getElementById(id){if(!els.has(id))els.set(id,new Element());return els.get(id);},createElementNS(){return new Element();},createElement(){return new Element();},addEventListener(){}};
  const ctx=vm.createContext({layoutTree,truncateToWidth,linkPath,STATUS_GLYPH,ancestorPath,validParent,movedOffset,manualLayout,graphViewport,clampZoom,MIN_ZOOM,document,window,parent:{postMessage(){}},location:{search:''},URLSearchParams,matchMedia:()=>({matches:true}),ResizeObserver:class{observe(){}},setTimeout(){return 1;},setInterval(){},clearTimeout(){},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},Option:class{}});
  vm.runInContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''),ctx);
  return {document,run:code=>vm.runInContext(code,ctx),els,storage};
}
const plan={planId:'embedded',title:'Plan',revision:1,updatedAt:'2026-10-13',progress:{percent:0,done:0,total:2},current:[],nodes:[{id:'root',title:'Root',parent:'',status:'pending'},{id:'branch',title:'Branch',parent:'root',status:'pending'},{id:'leaf',title:'Leaf',parent:'branch',status:'pending'}]};
test('embedded first tool result restores manual collapse and direction',()=>{
  const a=app({direction:'vertical',collapsed:['branch'],collapsedTouched:true});
  a.run('render('+JSON.stringify(plan)+')');
  assert.equal(a.els.get('vertical').attributes['aria-pressed'],true);
  assert.equal(a.run('shownSet.has("branch")'),true);
  assert.equal(a.els.get('map').attributes.preserveAspectRatio,'xMidYMin meet');
});
test('plan status updates preserve scrolling while global view recenters explicitly',()=>{
  const a=app();a.run('render('+JSON.stringify(plan)+')');
  const canvas=a.els.get('canvas');canvas.scrollTop=123;canvas.scrollLeft=47;
  a.run('render('+JSON.stringify({...plan,revision:2})+')');
  assert.equal(canvas.scrollTop,123);assert.equal(canvas.scrollLeft,47);
  a.els.get('compact').onclick();
  a.els.get('fit').onclick();
  assert.equal(a.run('compact'),true);
  assert.equal(canvas.scrollLeft,0);assert.notEqual(canvas.scrollTop,123);
});
test('manual expansion stays authoritative after a resize and zoom respects bounds',()=>{
  const a=app();a.run('render('+JSON.stringify(plan)+')');a.els.get('expand').onclick();
  a.els.get('canvas').clientWidth=200;a.run('render(state)');
  assert.equal(a.run('shownSet.size'),0);
  for(let i=0;i<30;i++)a.els.get('plus').onclick();
  assert.equal(a.run('zoom'),2);
  for(let i=0;i<30;i++)a.els.get('minus').onclick();
  assert.equal(a.run('zoom'),0.7);
});

const ev=(x,y)=>({clientX:x,clientY:y,button:0,pointerId:1,preventDefault(){},stopPropagation(){}});
test('free placement persists and automatic layout clears it without changing the plan',()=>{
 const a=app();a.run('render('+JSON.stringify(plan)+')');
 a.run('startDrag({clientX:100,clientY:100,button:0,preventDefault(){},stopPropagation(){}},"leaf")');
 a.run('pointerMove({clientX:180,clientY:145})');a.run('pointerUp({pointerId:1})');
 assert.ok(a.run('offsets.leaf.dx')>0);assert.equal(a.run('selected'),undefined);
 assert.ok(JSON.parse(a.storage.get('plan-map-view:embedded')).offsets.leaf);
 a.els.get('autoLayout').onclick();assert.equal(a.run('Object.keys(offsets).length'),0);
});
test('dropping onto another card uses the fresh revision and clears only the moved offset',async()=>{
 const a=app();const value={...plan,nodes:[...plan.nodes,{id:'sibling',title:'Sibling',parent:'root',status:'done'}]};a.run('render('+JSON.stringify(value)+')');
 a.run('globalThis.sent=[];call=async(name,args)=>{sent.push({name,args});return name==="plan_view"?{...state,revision:42}:{...state,revision:43};}');
 a.run('startDrag({clientX:100,clientY:100,button:0,preventDefault(){},stopPropagation(){}},"leaf");pointerMove({clientX:130,clientY:130});dropTarget="sibling"');
 await a.run('pointerUp({pointerId:1})');
 assert.equal(a.run('sent[1].args.parent'),'sibling');assert.equal(a.run('sent[1].args.expectedRevision'),42);assert.equal(a.run('offsets.leaf'),undefined);
 assert.equal(validParent(value.nodes,'root','leaf'),false);
});
test('inline rename submits once on Enter and Escape cancels without a write',async()=>{
 const a=app();a.run('render('+JSON.stringify(plan)+');globalThis.sent=[];call=async(name,args)=>{sent.push({name,args});return {...state,revision:42};};collapsedTouched=true;collapsed.clear();render(state);startRename("leaf")');
 const svg=a.els.get('map'),input=svg.children.at(-1).children[0];input.value='Updated';input.onkeydown({key:'Enter',stopPropagation(){},preventDefault(){}});await new Promise(r=>setImmediate(r));input.onblur();
 assert.equal(a.run('sent.filter(s=>s.name==="plan_node").length'),1);assert.equal(a.run('sent.at(-1).args.title'),'Updated');
 a.run('startRename("leaf")');const other=svg.children.at(-1).children[0];other.value='Cancelled';other.onkeydown({key:'Escape',stopPropagation(){},preventDefault(){}});other.onblur();await new Promise(r=>setImmediate(r));assert.equal(a.run('sent.filter(s=>s.name==="plan_node").length'),1);
});
test('selected ancestor path fades unrelated cards and uses rounded links/status glyphs',()=>{
 const a=app();a.run('render('+JSON.stringify({...plan,nodes:[...plan.nodes,{id:'other',title:'Other',parent:'root',status:'blocked'}]})+');selected="leaf";render(state)');
 const group=a.els.get('map').children[0];const cards=group.children.filter(x=>x.attributes['data-node']);assert.equal(cards.find(c=>c.attributes['data-node']==='other').attributes['data-dim'],'true');assert.equal(cards.find(c=>c.attributes['data-node']==='branch').attributes['data-path'],'true');
 const links=group.children.filter(x=>x.attributes.class==='pm-link');assert.ok(links.every(x=>!x.attributes.d.includes(' C ')));assert.ok(links.some(x=>x.attributes.d.includes('Q')));assert.deepEqual(STATUS_GLYPH,{pending:'○',active:'●',done:'✓',blocked:'!'});
});
test('blank-space panning changes scroll positions without moving cards',()=>{
 const a=app();a.run('render('+JSON.stringify(plan)+');startPan({clientX:100,clientY:100,button:0,preventDefault(){}});pointerMove({clientX:80,clientY:60})');assert.equal(a.els.get('canvas').scrollLeft,20);assert.ok(a.els.get('canvas').scrollTop>=40);assert.equal(a.run('Object.keys(offsets).length'),0);a.run('pointerUp({pointerId:1})');
});

test('reverse and tight free-layout links stay orthogonal without cubic fallback',()=>{
 for(const direction of ['horizontal','vertical']){
  const d=linkPath({x:120,y:120,w:100,h:24},{x:10,y:10,w:100,h:24},{direction});
  assert.ok(d.includes('Q'));assert.ok(!d.includes(' C '));
 }
});
test('a non-drag pointer release leaves the clicked card attached for click/doubleclick',async()=>{
 const a=app();a.run('render('+JSON.stringify(plan)+')');const before=a.els.get('map').children[0];
 a.run('startDrag({clientX:100,clientY:100,button:0,preventDefault(){},stopPropagation(){}},"leaf")');
 await a.run('pointerUp({pointerId:1})');assert.equal(a.els.get('map').children[0],before);
});

test('first click selects immediately without replacing the doubleclick target',()=>{
 const a=app();a.run('render('+JSON.stringify(plan)+')');a.els.get('expand').onclick();const group=a.els.get('map').children[0],card=group.children.find(c=>c.attributes['data-node']==='leaf');
 card.onclick();assert.equal(a.run('selected'),'leaf');assert.equal(card.attributes['data-selected'],'true');assert.equal(a.els.get('map').children[0],group);
 card.ondblclick({stopPropagation(){}});assert.equal(a.run('editing.id'),'leaf');
});

 test('restores full-size normal view and saved compact preference',()=>{const a=app({compact:false});a.run('render('+JSON.stringify(plan)+')');assert.equal(a.run('compact'),false);assert.equal(a.run('currentView.zoom'),1);});
