import test from 'node:test';
import assert from 'node:assert/strict';
import { caseContract, admitCaseCall, toDialogue, fromDialogue } from './case-contract.mjs';
import { readFileSync } from 'node:fs';
const sample = () => JSON.parse(readFileSync(new URL('./cases/recovery-direct.json', import.meta.url)));
test('case round-trip retains ordered static turns', () => {
  const c = caseContract(sample()); assert.deepEqual(fromDialogue(toDialogue(c)), c.turns);
});
test('capabilities admit a different permitted trajectory without a script lookup', () => {
  const c = caseContract(sample());
  admitCaseCall(c, 'write', { path: 'result.txt', content: 'another legitimate intermediate value' });
  assert.throws(() => admitCaseCall(c, 'read', { path: '../secret' }), /OUTSIDE_CAPABILITY/);
  assert.throws(() => admitCaseCall(c, 'bash', { path: 'result.txt', command: 'true' }), /OUTSIDE_CAPABILITY/);
  assert.throws(() => admitCaseCall(c, 'write', { path: 'result.txt', content: 'x', extra: true }), /ARGUMENTS/);
});
test('case rejects unknown versions, duplicate identities, bad files and turn mismatches', () => {
  for (const mutate of [c => c.schemaVersion = 'future', c => c.allowedFiles.push(c.allowedFiles[0]), c => c.initialFiles['../secret'] = 'x', c => c.provider.turns[0].id = 'different', c => c.provider.turns[0].steps.push(c.provider.turns[0].steps[0])]) {
    const c = sample(); mutate(c); assert.throws(() => caseContract(c));
  }
});
test('interchange rejects adaptive users, injected agent output, judges and extensions', () => {
  for (const step of [{ kind: 'user', id: 'turn-1' }, { kind: 'judge' }, { kind: 'agent', content: 'pretend execution' }]) {
    const d = toDialogue(sample()); d.steps[step.kind === 'user' ? 0 : 1] = step; assert.throws(() => fromDialogue(d));
  }
  const d = toDialogue(sample()); d.cache = true; assert.throws(() => fromDialogue(d));
});
