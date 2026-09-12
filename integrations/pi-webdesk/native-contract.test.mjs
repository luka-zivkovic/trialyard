import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeRequest, InvocationLedger } from './native-contract.mjs';
const proposal = { version: 1, kind: 'tool.propose', invocationId: 'call-1', tool: 'write', input: { path: 'notes.txt', content: 'alpha\n' } };
test('closed versioned bridge rejects unknown kinds, fields and contradictory results', () => {
  assert.deepEqual(bridgeRequest(proposal), proposal);
  for (const bad of [{ ...proposal, version: 2 }, { ...proposal, extra: true }, { ...proposal, kind: 'execute-shell' }, { version: 1, kind: 'tool.result', invocationId: 'one', result: {}, error: 'failed' }]) assert.throws(() => bridgeRequest(bad));
});
function prepared() { const ledger = new InvocationLedger(); ledger.propose('one', 'write', { content: 'a' }); ledger.admit('one', 'write', { content: 'a' }, 'operation'); return ledger; }
test('native callback cannot dispatch before admission or acknowledged observation', async () => {
  const l = new InvocationLedger(); l.propose('one', 'write', {});
  await assert.rejects(l.dispatch('one', async () => {}));
  l.admit('one', 'write', {}, 'operation');
  let release; const pending = l.dispatch('one', () => new Promise(r => { release = r; }));
  assert.equal(l.get('one').phase, 'acknowledging');
  await assert.rejects(l.dispatch('one', async () => {})); release(); await pending;
  assert.equal(l.get('one').phase, 'dispatched'); l.finish('one', 'known_result');
  await assert.rejects(l.dispatch('one', async () => {}));
});
test('denied callback closes without a dispatch observation', () => {
  const l = prepared(); l.finish('one', 'not_dispatched'); assert.equal(l.get('one').outcome, 'not_dispatched');
  assert.throws(() => l.finish('one', 'known_result'));
});
test('changed arguments, duplicate proposal and callback result before dispatch are rejected', () => {
  const l = new InvocationLedger(); l.propose('one', 'write', { content: 'a' });
  assert.throws(() => l.propose('one', 'write', { content: 'a' }));
  assert.throws(() => l.admit('one', 'write', { content: 'b' }, 'operation'));
  assert.throws(() => l.finish('one', 'known_result'));
});
test('stop while observation acknowledgment is pending cannot release callback', async () => {
  const l = prepared(); let release;
  const pending = l.dispatch('one', () => new Promise(r => { release = r; })); l.stop(); release();
  await assert.rejects(pending, /STOPPED/); assert.equal(l.get('one').outcome, 'outcome_unknown');
});
