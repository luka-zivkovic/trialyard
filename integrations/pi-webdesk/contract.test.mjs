import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attemptIds, checkIds, validateReport, exercisePassed } from './contract.mjs';

function fixture() {
  const artifact = { path: 'identity.json', sha256: 'a'.repeat(64) };
  return {
    version: 1, kind: 'pi-webdesk-feasibility', nativeBundle: false, model: 'local-scripted-no-provider-request',
    startedAt: '2026-09-11T00:00:00Z', finishedAt: '2026-09-11T00:00:01Z', durationMs: 1000,
    identity: artifact, errors: [], attempts: attemptIds.map(id => ({
      id, execution: id === 'interrupted-write' ? 'interrupted' : 'completed', evidence: 'complete',
      operationOutcome: id === 'denied-write' ? 'blocked_before_dispatch' : id === 'interrupted-write' ? 'partial_effect_observed' : 'known_result',
      cleanup: 'verified', durationMs: 200, sessionId: id,
      checks: Object.fromEntries(checkIds.map(key => [key, true])), artifacts: [artifact], errors: [],
    })),
  };
}

test('complete feasibility evidence preserves interruption and blocked operation as distinct states', () => {
  assert.equal(exercisePassed(fixture()), true);
});
for (const [name, mutate] of [
  ['native bundle claim', r => { r.nativeBundle = true; }],
  ['unexpected field', r => { r.qualityScore = 1; }],
  ['duplicate attempt', r => { r.attempts[1].id = r.attempts[0].id; }],
  ['reused session', r => { r.attempts[1].sessionId = r.attempts[0].sessionId; }],
  ['missing session evidence', r => { r.attempts[0].checks.sessionRetained = false; }],
  ['incomplete cleanup upgraded', r => { r.attempts[0].checks.ownedProcessesGone = false; }],
  ['unobserved partial effect', r => { r.attempts[3].checks.expectedState = false; }],
  ['failed execution upgraded', r => { r.attempts[0].execution = 'failed'; }],
  ['traversing evidence path', r => { r.identity.path = 'a/../identity.json'; }],
]) test(`rejects ${name}`, () => { const r = fixture(); mutate(r); assert.throws(() => validateReport(r)); });
test('retains failed/incomplete attempt without passing the exercise', () => {
  const r = fixture(); Object.assign(r.attempts[0], { execution: 'failed', evidence: 'incomplete', operationOutcome: 'unknown', errors: ['startup timeout'] });
  assert.equal(exercisePassed(r), false);
});
test('one missing repetition or failed assertion does not pass', () => {
  const r = fixture(); r.attempts.pop(); assert.equal(exercisePassed(r), false);
  const s = fixture(); s.attempts[0].checks.expectedTrace = false; assert.equal(exercisePassed(s), false);
});
