import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationFor, createHandler } from '../lib/index.js';
const end = (kind, seq = 2) => ({ type: 'turn/end', seq, data: { turn: 1, reason: { kind } } });
const start = { type: 'step/start', data: { turn: 1 } };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('terminal outcomes only; no stopped, empty or unknown notifications', () => {
  for (const kind of ['completed', 'error', 'blocked', 'max-tokens']) assert.equal(notificationFor(end(kind), true).length, 2);
  for (const kind of ['aborted', 'interrupted', 'forked', 'unknown']) assert.equal(notificationFor(end(kind), true), undefined);
  assert.equal(notificationFor(end('completed'), false), undefined);
  assert.equal(notificationFor({ type: 'tool/result' }, true), undefined);
});
test('live events, duplicate suppression and off switch', async () => {
  const sent = []; let enabled = true;
  const handle = createHandler(m => sent.push(m), () => enabled);
  const session = { id: 'synthetic', title: 'private title' };
  handle(session, end('completed')); await tick(); assert.equal(sent.length, 0);
  handle(session, start); handle(session, end('completed')); await tick(); assert.equal(sent.length, 1);
  handle(session, start); handle(session, end('completed')); await tick(); assert.equal(sent.length, 1);
  enabled = false; handle(session, start); handle(session, end('error', 3)); await tick(); assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent).includes('private title'));
});
test('helper failure never escapes into session event handling', async () => {
  let errors = 0;
  const handle = createHandler(() => { throw Error('synthetic failure'); }, () => true, () => { errors++; });
  assert.doesNotThrow(() => handle({ id: 's' }, start));
  assert.doesNotThrow(() => handle({ id: 's' }, end('error')));
  await tick(); assert.equal(errors, 1);
});
