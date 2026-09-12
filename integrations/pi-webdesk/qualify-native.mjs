import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runPlan } from '../../dist/src/core/run.js';
import { resolvePlan } from '../../dist/src/core/plan.js';
import { verifyBundle } from '../../dist/src/contracts/verify.js';
import { hash } from './package-contract.mjs';
import { seed } from './scenario.mjs';

if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node qualify-native.mjs <native-build> <new-output-directory>');
const original = resolve(process.argv[2]), out = resolve(process.argv[3]), store = join(out, 'store'), build = join(out, 'relocated');
mkdirSync(out, { mode: 0o700 }); cpSync(original, build, { recursive: true, errorOnExist: true });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const startedAt = new Date().toISOString(), results = [], checks = {}, errors = [];
async function run(name, planName, action = null) {
  process.stdout.write(`Native ${name}\n`);
  const plan = join(build, `${planName}-plan.json`), controller = new AbortController();
  const begun = Date.now(); let done = false, intervention = null;
  const execution = runPlan(plan, { requestId: name, store, signal: controller.signal });
  execution.finally(() => { done = true; }).catch(() => {});
  if (action) {
    try {
      while (!done && !intervention) {
        if (Date.now() - begun > 65000) throw new Error('Intervention boundary not reached');
        const requestPath = join(store, 'requests', `${hash(name)}.json`);
        if (existsSync(requestPath)) {
          const request = read(requestPath), runRoot = join(store, 'runs', request.runId), indexPath = join(runRoot, 'run.json');
          if (existsSync(indexPath)) {
            const slot = read(indexPath).trials[0], prepared = slot && join(runRoot, slot.path, 'environment-prepared.json');
            if (prepared && existsSync(prepared)) {
              const lease = dirname(read(prepared).payload.bindings.environmentSocket), marker = join(lease, 'repo/interrupted.txt');
              if (existsSync(marker)) {
                assert.equal(readFileSync(marker, 'utf8'), 'started\n');
                intervention = { action, at: new Date().toISOString(), lease, observedFile: 'started\n' };
                if (action === 'cancel') controller.abort();
                else {
                  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
                  const agents = rows.map(row => row.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).filter(([, , ppid, command]) => +ppid === process.pid && command === `${process.execPath} agent.js`);
                  assert.equal(agents.length, 1, 'Expected one exact owned native agent child');
                  intervention.pid = +agents[0][1]; process.kill(intervention.pid, 'SIGKILL');
                }
              }
            }
          }
        }
        await delay(20);
      }
    } catch (error) { controller.abort(); await execution; throw error; }
  }
  const result = await execution;
  write(join(out, `${name}-run.json`), result);
  const record = { name, durationMs: Date.now() - begun, root: result.root, exitCode: result.index.exitCode, intervention, trials: [] };
  results.push(record);
  for (const slot of result.index.trials) {
    const root = join(result.root, slot.path), verified = await verifyBundle(root, slot.bundleSha256), manifest = verified.manifest;
    const final = existsSync(join(root, 'final-state.json')) ? read(join(root, 'final-state.json')) : null;
    const initial = existsSync(join(root, 'initial-state.json')) ? read(join(root, 'initial-state.json')) : null;
    const events = readFileSync(join(root, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    record.trials.push({ trialId: slot.trialId, path: root, sha256: verified.digest, execution: manifest.execution, evidence: manifest.evidence.state, gaps: manifest.evidence.gaps, cleanup: manifest.cleanup, files: final?.state.files, sessionId: final?.state.session?.sessionId, operations: manifest.operations });
    assert.equal(manifest.cleanup, 'succeeded'); assert.equal(final?.stable, true);
    assert.deepEqual(initial.state.files, { 'README.md': seed }); assert.deepEqual(final.state.runtime.remaining, []);
    assert.equal(existsSync(final.state.runtime.lease), false, 'Disposable lease survives cleanup');
    const tools = manifest.operations.filter(op => op.boundary === 'tool');
    if (name === 'baseline') {
      assert.equal(manifest.execution, 'finished'); assert.equal(manifest.evidence.state, 'complete');
      assert.equal(final.state.files['notes.txt'], 'beta\n'); assert.equal(tools.length, 5); assert.ok(tools.every(op => op.observed && op.outcome === 'known_result'));
      const requests = events.filter(e => e.kind === 'operation.dispatch_intent' && e.payload.boundary === 'model');
      assert.equal(requests.length, 7);
      const context = requests.at(-1).payload.args.input;
      assert.equal(context.messages.filter(m => m.role === 'user').length, 2); assert.equal(context.messages.filter(m => m.role === 'toolResult').length, 5);
      assert.ok(final.state.session.raw.includes('first-write'));
    } else if (name === 'denied') {
      assert.equal(manifest.execution, 'finished'); assert.equal(manifest.evidence.state, 'complete');
      assert.deepEqual(final.state.files, { 'README.md': seed }); assert.equal(tools.length, 1); assert.equal(tools[0].observed, false); assert.equal(tools[0].outcome, 'not_dispatched');
      assert.ok(final.state.session.raw.includes('approval was denied'));
    } else {
      assert.ok(intervention, 'Run finished before the intended intervention');
      assert.equal(manifest.execution, name === 'cancelled' ? 'cancelled' : 'adapter_error');
      assert.equal(final.state.files['interrupted.txt'], 'started\n'); assert.equal(tools.length, 1); assert.equal(tools[0].observed, true); assert.equal(tools[0].outcome, 'outcome_unknown');
      assert.equal(manifest.evidence.state, 'incomplete');
    }
  }
  process.stdout.write(`${name}: ${record.trials.map(t => `${t.execution}/${t.evidence}/${t.cleanup}`).join(', ')}\n`);
  return result;
}
try {
  const baseline = await run('baseline', 'baseline');
  assert.equal(new Set(results[0].trials.map(t => t.sessionId)).size, 2);
  const duplicate = await runPlan(join(build, 'baseline-plan.json'), { requestId: 'baseline', store });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.root, baseline.root); checks.duplicateRequestNoReplay = true;
  await run('denied', 'denied'); await run('cancelled', 'interrupted', 'cancel'); await run('agent-crash', 'interrupted', 'kill-agent');
  const badBuild = join(out, 'tampered-build'); cpSync(build, badBuild, { recursive: true });
  const corrupt = path => { const fd = openSync(path, 'r+'), byte = Buffer.alloc(1); try { readSync(fd, byte, 0, 1, 0); byte[0] ^= 1; writeSync(fd, byte, 0, 1, 0); } finally { closeSync(fd); } };
  corrupt(join(badBuild, 'pi-runtime-0.gzpart'));
  await assert.rejects(resolvePlan(join(badBuild, 'baseline-plan.json')), /digest mismatch/); checks.tamperedPackageRejectedBeforeExecution = true;
  const badBundle = join(out, 'tampered-bundle'); cpSync(results[0].trials[0].path, badBundle, { recursive: true });
  corrupt(join(badBundle, 'inputs/pi-runtime-0.gzpart'));
  await assert.rejects(verifyBundle(badBundle, results[0].trials[0].sha256)); checks.tamperedBundleRejected = true;
  checks.relocatedBuildRuns = true;
} catch (error) { errors.push(String(error)); process.stderr.write(String(error) + '\n'); }
finally {
  write(join(out, 'qualification.json'), { version: 1, kind: 'pi-webdesk-native-qualification', startedAt, finishedAt: new Date().toISOString(), originalBuild: original, relocatedBuild: build, buildSha256: hash(readFileSync(join(build, 'build.json'))), qualifierSha256: hash(readFileSync(new URL(import.meta.url))), results, checks, errors });
}
process.exitCode = errors.length ? 1 : 0;
