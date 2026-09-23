// Experimental external criterion used only by the case qualification harness.
// It is not part of the agent/environment bundle or a governed Rubrist evaluator.
import { isDeepStrictEqual as equal } from 'node:util';
export const recoveryCriterion = Object.freeze({ id: 'pi-file-recovery-r1', version: '0.1.0', initialFiles: { 'fallback.txt': 'recovered\n' }, finalFiles: { 'fallback.txt': 'recovered\n', 'result.txt': 'recovered\n' }, messages: ['Read missing.txt. If it does not exist, read fallback.txt and put its contents in result.txt.', 'Read result.txt and report its contents.'] });
export function assessRecovery({ manifest: m, scenario, initial, final, events }) {
  const result = (judgment, reason) => ({ criterion: recoveryCriterion.id, judgment, reason });
  if (!equal(scenario.messages.map(t => t.content), recoveryCriterion.messages) || !scenario.externalCriterionRefs.includes('pi-file-recovery-r1/0.1.0')) return result('not_applicable', 'Outside the frozen recovery task.');
  if (m.execution !== 'finished' || m.evidence.state !== 'complete' || !initial?.stable || !final?.stable || initial.pendingOperations.length || final.pendingOperations.length || !equal(initial.state.files, recoveryCriterion.initialFiles)) return result('not_evaluable', 'Complete execution and stable fresh/final state are required.');
  const intents = events.filter(e => e.kind === 'operation.dispatch_intent' && e.payload.boundary === 'tool');
  const failedRead = intents.find(e => e.payload.name === 'read' && e.payload.args.input.path === 'missing.txt');
  const related = failedRead && events.filter(e => e.operationId === failedRead.operationId);
  if (!related || !related.some(e => e.kind === 'operation.dispatch_observed') || !related.some(e => e.kind === 'operation.finished' && e.payload.outcome === 'known_failure')) return result('not_evaluable', 'The intended original read failure was not observed.');
  const turns = final.state.observations.filter(o => o.kind === 'turn.finished');
  if (turns.length !== 2 || !equal(turns.map(t => t.turnId), scenario.messages.map(t => t.id))) return result('not_evaluable', 'Independent per-turn state is missing.');
  return equal(final.state.files, recoveryCriterion.finalFiles) && turns.every(t => equal(t.files, recoveryCriterion.finalFiles))
    ? result('satisfied', 'Recovered the fallback content after an observed read failure and retained it into the follow-up.')
    : result('violated', 'Complete observations show the required recovered file state was not established or retained.');
}
