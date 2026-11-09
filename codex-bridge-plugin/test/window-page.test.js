import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { collaborationWindowHtml } from '../lib/window-page.js';

function harness(){
  class Element {
    constructor(){this.children=[];this.value='';this.textContent='';this.scrollHeight=100;this.scrollTop=0;this.clientHeight=100;this.classList={toggle:()=>true,add(){}};}
    append(...nodes){this.children.push(...nodes)}
    replaceChildren(...nodes){this.children=nodes}
    setAttribute(){} addEventListener(){}
  }
  const nodes=new Map();
  const document={querySelector(key){if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key)},createElement(){return new Element()}};
  let script=collaborationWindowHtml().match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function(script);
  script=script.slice(0,script.indexOf("refresh().catch(e=>timeline.replaceChildren"));
  const context=vm.createContext({document,localStorage:{getItem(){return null}},console});
  vm.runInContext(script,context);
  const read=(node)=>[node.textContent,...node.children.map(read)].join(' ');
  return {nodes,context,read,run:(code)=>vm.runInContext(code,context)};
}

test('generated page safely renders results without assuming acceptance or sender direction',()=>{
 const h=harness();
 h.run(`render([{id:'a',taskId:'t',sender:'Kimi',recipient:'Codex',direction:'codex-to-deepseek',kind:'result',status:'completed',goal:'<img onerror=alert(1)>',action:'Review complete',timestamp:'2026-10-19T10:00:00Z'}])`);
 const text=h.read(h.nodes.get('#timeline'));
 assert.match(text,/Kimi → Codex/);assert.match(text,/待验收/);assert.doesNotMatch(text,/验收通过/);assert.match(text,/<img onerror=alert\(1\)>/);
 assert.match(h.read(h.nodes.get('#taskBoard')),/已有回复 · 待验收/);
 h.run(`render([{id:'b',kind:'result',acceptanceStatus:'passed',timestamp:'2026-10-19T10:00:00Z'}])`);
 assert.match(h.read(h.nodes.get('#timeline')),/验收通过/);
});

test('participant and text filters remain usable without forcing the reader to the bottom',()=>{
 const h=harness();
 const timeline=h.nodes.get('#timeline');timeline.scrollHeight=1000;timeline.clientHeight=100;timeline.scrollTop=200;
 h.run(`render([{id:'a',sender:'Kimi',action:'alpha',timestamp:'2026-10-19'},{id:'b',sender:'OpenCode',action:'beta',timestamp:'2026-10-19'}])`);
 assert.equal(timeline.scrollTop,200);
 h.run(`participant='OpenCode';render(messageRows)`);
 assert.match(h.read(h.nodes.get('#timeline')),/beta/);assert.doesNotMatch(h.read(h.nodes.get('#timeline')),/alpha/);
 h.nodes.get('#search').value='missing';h.run('render(messageRows)');
 assert.match(h.read(h.nodes.get('#timeline')),/没有符合筛选条件/);
});

test('task band reports actual session, latest handoff and recorded boundary without invented roles or progress',()=>{
 const h=harness();
 h.run(`activeSession={task:'真实会话标题',authorized:true};render([{id:'c',sender:'OpenCode',recipient:'Codex',kind:'result',goal:'评审回执',result:'可读文件已生成',boundary:'仅 acceptance/ 可写',timestamp:'2026-10-19T10:00:00Z'}])`);
 assert.equal(h.nodes.get('#bandTitle').textContent,'真实会话标题');
 assert.match(h.read(h.nodes.get('#bandFacts')),/最近交接 · OpenCode → Codex/);
 assert.match(h.read(h.nodes.get('#bandFacts')),/待验收/);
 assert.match(h.nodes.get('#bandBoundary').textContent,/仅 acceptance\/ 可写/);
 assert.match(h.nodes.get('#bandEvidence').textContent,/评审回执 · OpenCode/);
 assert.doesNotMatch(h.read(h.nodes.get('#bandFacts')),/主责|100%|已完成/);
});
