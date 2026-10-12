import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { layoutTree, truncateToWidth } from '../web/layout.js';
import { graphViewport, clampZoom, MIN_ZOOM } from '../web/viewport.js';

// Exercise the real embedded app with a minimal host/DOM. No user plans or browser profile.
function app(saved) {
  class Element {
    constructor() { this.style={};this.attributes={};this.hidden=true;this.clientWidth=360;this.clientHeight=280;this.scrollHeight=1800;this.scrollTop=0;this.scrollLeft=0; }
    setAttribute(k,v){this.attributes[k]=v;}
    getAttribute(k){return this.attributes[k];}
    append(){}
    replaceChildren(){}
    getAnimations(){return [];}
    getBoundingClientRect(){return {height:320};}
  }
  const els=new Map(), storage=new Map(saved ? [['plan-map-view:embedded',JSON.stringify(saved)]] : []);
  const window={addEventListener(){}};
  const document={body:new Element(),getElementById(id){if(!els.has(id))els.set(id,new Element());return els.get(id);},createElementNS(){return new Element();},addEventListener(){}};
  const ctx=vm.createContext({layoutTree,truncateToWidth,graphViewport,clampZoom,MIN_ZOOM,document,window,parent:{postMessage(){}},location:{search:''},URLSearchParams,matchMedia:()=>({matches:true}),ResizeObserver:class{observe(){}},setTimeout(){return 1;},setInterval(){},clearTimeout(){},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},Option:class{}});
  vm.runInContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,''),ctx);
  return {run:code=>vm.runInContext(code,ctx),els,storage};
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
  a.els.get('fit').onclick();
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
