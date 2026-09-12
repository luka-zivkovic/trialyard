import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';

const validate = new Ajv({ strict: true }).compile(JSON.parse(readFileSync(new URL('./feasibility.schema.json', import.meta.url), 'utf8')));
export const attemptIds = ['baseline-a', 'baseline-b', 'denied-write', 'interrupted-write'];
export const checkIds = ['freshState', 'supervised', 'expectedState', 'expectedTrace', 'gateBeforeEffect', 'sessionRetained', 'ownedProcessesGone', 'leaseRemoved'];

export function validateReport(report) {
  if (!validate(report)) throw new Error(`INVALID_FEASIBILITY_REPORT: ${JSON.stringify(validate.errors)}`);
  const seen = new Set();
  for (const artifact of [report.identity, ...report.attempts.flatMap(a => a.artifacts)]) {
    if (artifact.path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('INVALID_ARTIFACT_PATH');
  }
  for (const attempt of report.attempts) {
    if (seen.has(attempt.id)) throw new Error('DUPLICATE_ATTEMPT');
    seen.add(attempt.id);
    if ((attempt.cleanup === 'verified') !== (attempt.checks.ownedProcessesGone && attempt.checks.leaseRemoved)) throw new Error('INVALID_CLEANUP_CLAIM');
    if (attempt.evidence === 'complete' && (!attempt.sessionId || !attempt.checks.sessionRetained || !attempt.artifacts.length || attempt.errors.length)) throw new Error('INVALID_EVIDENCE_CLAIM');
    if (attempt.execution === 'failed' && attempt.operationOutcome !== 'unknown') throw new Error('INVALID_FAILED_OUTCOME');
    if (attempt.execution === 'interrupted' && attempt.id !== 'interrupted-write') throw new Error('INVALID_INTERRUPTION');
    if (attempt.operationOutcome === 'blocked_before_dispatch' && attempt.id !== 'denied-write') throw new Error('INVALID_DENIAL');
    if (attempt.operationOutcome === 'partial_effect_observed' && (attempt.execution !== 'interrupted' || !attempt.checks.expectedState)) throw new Error('INVALID_PARTIAL_EFFECT');
  }
  const sessions = report.attempts.map(a => a.sessionId).filter(Boolean);
  if (new Set(sessions).size !== sessions.length) throw new Error('REUSED_SESSION');
  return report;
}

export function exercisePassed(report) {
  validateReport(report);
  return report.errors.length === 0 && report.attempts.length === attemptIds.length && report.attempts.every(a =>
    a.execution === (a.id === 'interrupted-write' ? 'interrupted' : 'completed') &&
    a.operationOutcome === (a.id === 'denied-write' ? 'blocked_before_dispatch' : a.id === 'interrupted-write' ? 'partial_effect_observed' : 'known_result') &&
    a.evidence === 'complete' && a.cleanup === 'verified' && Object.values(a.checks).every(Boolean));
}
