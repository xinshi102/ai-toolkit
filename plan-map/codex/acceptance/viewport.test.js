import test from 'node:test';
import assert from 'node:assert/strict';
import { graphViewport } from '../web/viewport.js';
import { layoutTree } from '../web/layout.js';

test('small trees are centered without enlarging cards', () => {
  const view = graphViewport({ width: 460, height: 133 }, 700);
  assert.equal(view.zoom, 1);
  assert.equal(view.height, 157);
  assert.equal(view.offsetX, 108);
});

test('overview fits both dimensions even for wide and tall plans', () => {
  for (const layout of [{width:1600,height:1000},{width:460,height:1500}]) {
    const view = graphViewport(layout, 425);
    assert.equal(view.width,425);
    assert.ok(view.height <= view.canvasHeight);
    assert.ok(view.canvasHeight <= 280);
    assert.ok((layout.width+24)*view.zoom <= 425);
    assert.ok((layout.height+24)*view.zoom <= 278.001);
  }
});

test('seven stages fit completely in a narrow chat and manual zoom remains available', () => {
  const nodes=[{id:'root',title:'完整项目计划',parent:''},...Array.from({length:7},(_,i)=>({id:'p'+i,parent:'root',title:'阶段 '+i+' 验证与集成'}))];
  const layout=layoutTree(nodes,{compact:true});
  const view=graphViewport(layout,360);
  for (const p of Object.values(layout.positions)) {
    assert.ok(view.offsetX+(p.x+p.w+view.padding)*view.zoom <= view.width);
    assert.ok((p.y+p.h+view.padding)*view.zoom <= view.canvasHeight);
    assert.equal(p.h,24);
  }
  assert.equal(graphViewport(layout,360,{fit:false,zoom:1.5}).zoom,1.5);
});
