import test from 'node:test';
import assert from 'node:assert/strict';
import { graphViewport, clampZoom, MIN_ZOOM, MAX_ZOOM } from '../web/viewport.js';
import { layoutTree } from '../web/layout.js';

test('small trees are centered without enlarging cards', () => {
  const view = graphViewport({ width: 460, height: 133 }, 700);
  assert.equal(view.zoom, 1);
  assert.equal(view.width, 484);
  assert.equal(view.height, 157);
  assert.equal(view.offsetX, 108);
  assert.equal(view.overflowing, false);
  assert.equal(view.viewBox.width, 484);
});

test('a wide plan stops shrinking at the readable floor and scrolls instead', () => {
  const view = graphViewport({ width: 1600, height: 300 }, 425);
  assert.equal(view.zoom, 1);
  assert.ok(view.width > 425);
  assert.equal(view.overflowing, true);
  assert.ok(Math.abs(view.width - Math.round((1600 + 24))) <= 1);
});

test('a deep plan keeps readable zoom and scrolls vertically inside the cap', () => {
  const view = graphViewport({ width: 460, height: 1500 }, 425);
  assert.ok(view.zoom === 1); // 宽度放得下，就按宽适宽
  assert.ok(view.zoom >= MIN_ZOOM);
  assert.equal(view.canvasHeight, 520);
  assert.ok(view.height > view.canvasHeight);
  assert.equal(view.overflowing, true);
});

test('seven stages stay readable in a narrow chat and manual zoom remains available', () => {
  const nodes=[{id:'root',title:'完整项目计划',parent:''},...Array.from({length:7},(_,i)=>({id:'p'+i,parent:'root',title:'阶段 '+i+' 验证与集成'}))];
  const layout=layoutTree(nodes,{compact:true});
  const view=graphViewport(layout,360);
  assert.ok(view.zoom >= MIN_ZOOM && view.zoom <= 1);
  assert.ok(view.viewBox.width >= layout.width && view.viewBox.height >= layout.height);
  for (const p of Object.values(layout.positions)) assert.equal(p.h, 24);
  assert.equal(graphViewport(layout,360,{fit:false,zoom:1.5}).zoom,1.5);
});

test('manual zoom is clamped to the readable range', () => {
  assert.equal(clampZoom(0.1), MIN_ZOOM);
  assert.equal(clampZoom(9), MAX_ZOOM);
  assert.equal(clampZoom(1.234), 1.23);
  assert.equal(graphViewport({width:400,height:120},425,{fit:false,zoom:0.05}).zoom, MIN_ZOOM);
});
