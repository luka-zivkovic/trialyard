import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { callbackGate } from './callback-gate.mjs';

function setup(timeoutMs = 200) {
  const events = [], effects = [], controller = new AbortController();
  let released = false;
  const gate = callbackGate({ calls: [{ id: 'one', name: 'write', arguments: { path: 'note', content: 'alpha' } }], permitted: () => released, record: (kind, data) => events.push({ kind, ...data }), timeoutMs });
  const call = { id: 'one', tool: 'write', input: { path: 'note', content: 'alpha' }, signal: controller.signal, execute: async () => { effects.push('written'); return 'original result'; } };
  return { gate, call, effects, events, controller, release: () => { released = true; } };
}
test('holds the real callback until permission and rejects a concurrent duplicate', async () => {
  const s = setup(); const pending = s.gate(s.call);
  await delay(30); assert.deepEqual(s.effects, []);
  await assert.rejects(s.gate(s.call), /repeated/); assert.deepEqual(s.effects, []);
  s.release(); assert.equal(await pending, 'original result'); assert.deepEqual(s.effects, ['written']);
  await assert.rejects(s.gate(s.call), /repeated/); assert.deepEqual(s.effects, ['written']);
});
test('withheld permission times out without dispatch or side effect', async () => {
  const s = setup(25); await assert.rejects(s.gate(s.call), /not released/);
  assert.deepEqual(s.effects, []); assert.ok(!s.events.some(e => e.kind === 'intercept.dispatch'));
});
test('abort before dispatch wins even when permission already exists', async () => {
  const s = setup(); s.release(); s.controller.abort();
  await assert.rejects(s.gate(s.call), /Aborted/); assert.deepEqual(s.effects, []);
});
test('unknown or mismatched request cannot execute the original callback', async () => {
  const s = setup(); s.release();
  for (const override of [{ id: 'foreign' }, { tool: 'bash' }, { input: { path: '../foreign', content: 'alpha' } }]) await assert.rejects(s.gate({ ...s.call, ...override }), /Unexpected/);
  assert.deepEqual(s.effects, []);
});
test('original callback failure preserves partial effect and cannot be retried under the same id', async () => {
  const s = setup(); s.release();
  s.call.execute = async () => { s.effects.push('partial'); throw new Error('interrupted'); };
  await assert.rejects(s.gate(s.call), /interrupted/); await assert.rejects(s.gate(s.call), /repeated/);
  assert.deepEqual(s.effects, ['partial']); assert.equal(s.events.at(-1).kind, 'intercept.error');
});
