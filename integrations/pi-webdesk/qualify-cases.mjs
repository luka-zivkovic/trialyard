import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { materializeCase } from './materialize-case.mjs';
import { runPlan } from '../../dist/src/core/run.js';
import { verifyBundle } from '../../dist/src/contracts/verify.js';
import { hash } from './package-contract.mjs';
import { assessRecovery, recoveryCriterion } from './recovery-assessment.mjs';
import { toDialogue, fromDialogue } from './case-contract.mjs';
const [baseArg, outArg] = process.argv.slice(2);
if (!baseArg || !outArg) throw new Error('Usage: node qualify-cases.mjs <native-connection.json> <new-output-directory>');
const base = resolve(baseArg), out = resolve(outArg), results = [], leases = new Set(), sessions = new Set();
mkdirSync(out, { mode: 0o700 });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const startedAt = new Date().toISOString(), parentSha256 = hash(readFileSync(base));
write('freeze.json', { kind: 'pi-case-qualification/v1', startedAt, parentSha256, criterion: recoveryCriterion,
  checkerSha256: hash(readFileSync(new URL('./recovery-assessment.mjs', import.meta.url))), cases: ['direct', 'edit', 'failed'].map(mode => ({ mode, sha256: hash(readFileSync(new URL(`./cases/recovery-${mode}.json`, import.meta.url))) })),
  expected: { direct: 'satisfied', edit: 'satisfied', failed: 'violated', missingFinal: 'not_evaluable' }, provider: 'local-scripted-only', perVariantRepetitions: 2 });
try {
  for (const mode of ['direct', 'edit', 'failed']) {
    const begun = Date.now(), file = new URL(`./cases/recovery-${mode}.json`, import.meta.url), definition = read(file);
    const materialized = await materializeCase(base, file.pathname, join(out, mode), parentSha256);
    assert.deepEqual(fromDialogue(toDialogue(definition)), definition.turns);
    for (const artifact of ['agent.js', 'environment.js', 'native-extension.mjs', 'policy.mjs', 'pi-build-state.json']) assert.equal(hash(readFileSync(join(out, mode, artifact))), hash(readFileSync(join(resolve(base, '..'), artifact))));
    const result = await runPlan(materialized.plan, { requestId: mode, store: join(out, 'store') });
    write(`${mode}-run.json`, result);
    assert.equal(result.index.exitCode, 0);
    for (const slot of result.index.trials) {
      const path = join(result.root, slot.path), verified = await verifyBundle(path, slot.bundleSha256);
      const context = { manifest: verified.manifest, scenario: read(join(path, 'scenario.json')), initial: read(join(path, 'initial-state.json')), final: read(join(path, 'final-state.json')), events: readFileSync(join(path, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse) };
      assert.equal(context.manifest.cleanup, 'succeeded');
      assert.deepEqual(context.initial.state.files, definition.initialFiles);
      const state = context.final.state;
      assert.equal(existsSync(state.runtime.lease), false); assert.deepEqual(state.runtime.remaining, []);
      assert.ok(!leases.has(state.runtime.lease)); leases.add(state.runtime.lease);
      assert.ok(!sessions.has(state.runtime.sessionId)); sessions.add(state.runtime.sessionId);
      const assessment = assessRecovery(context);
      assert.equal(assessment.judgment, mode === 'failed' ? 'violated' : 'satisfied');
      assert.equal(assessRecovery({ ...context, final: null }).judgment, 'not_evaluable');
      results.push({ mode, trialId: slot.trialId, path, bundleSha256: slot.bundleSha256, execution: context.manifest.execution, evidence: context.manifest.evidence.state, cleanup: context.manifest.cleanup, assessment, finalFiles: state.files, tools: context.manifest.operations.filter(o => o.boundary === 'tool').map(o => ({ name: context.events.find(e => e.operationId === o.id && e.kind === 'operation.dispatch_intent')?.payload.name, observed: o.observed, outcome: o.outcome })), dialogue: toDialogue(definition), assistantTurns: context.events.filter(e => e.kind === 'assistant.turn').map(e => e.payload), durationMs: Date.now() - begun, materialized });
    }
    const duplicate = await runPlan(materialized.plan, { requestId: mode, store: join(out, 'store') });
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.root, result.root);
    process.stdout.write(`${mode}: ${results.filter(r => r.mode === mode).map(r => r.assessment.judgment).join(', ')}\n`);
  }
  assert.equal(hash(readFileSync(base)), parentSha256);
  write('qualification.json', { kind: 'pi-case-qualification/v1', startedAt, finishedAt: new Date().toISOString(), results, checks: { sourceAndAdapterBytesEqualAcrossCases: true, distinctLeases: leases.size, distinctSessions: sessions.size, staticDialogueRoundTrip: true, incompleteFinalIsNotEvaluable: true, duplicateNoReplay: true }, externalProviderRequests: 0 });
} catch (error) { write('failure.json', { startedAt, results, error: String(error), stack: error.stack }); throw error; }
