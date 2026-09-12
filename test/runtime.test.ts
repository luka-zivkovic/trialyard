import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { initExample } from "../src/cli/init.js";
import { runPlan, showRun, type RunResult } from "../src/core/run.js";
import { readJson, jsonBytes } from "../src/core/files.js";
import { verifyBundle } from "../src/contracts/verify.js";
import type { Plan, Snapshot, Frame } from "../src/contracts/types.js";

async function setup(t: TestContext, change: (plan: Plan) => void = () => {}): Promise<{ root: string; file: string; plan: Plan; store: string }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = await initExample(path.join(root, "example"));
  const plan = await readJson(path.dirname(file), "plan.json") as Plan;
  // Preparation includes durable filesystem writes. Keep that allowance separate
  // from the short execution deadlines deliberately exercised below.
  plan.limits.prepareMs = 300000; plan.limits.trialMs = 10000; plan.limits.stopGraceMs = 30; plan.limits.snapshotMs = 5000; plan.limits.cleanupMs = 5000;
  change(plan); await fs.writeFile(file, jsonBytes(plan));
  return { root, file, plan, store: path.join(root, "store") };
}
async function bundles(result: RunResult) {
  return Promise.all(result.index.trials.map(async slot => {
    const root = path.join(result.root, slot.path);
    return { root, ...await verifyBundle(root, slot.bundleSha256!) };
  }));
}
const state = async (root: string, stage: "initial" | "final"): Promise<{ available: number; reservations: unknown[] }> =>
  (await readJson(root, `${stage}-state.json`) as Snapshot).state as { available: number; reservations: unknown[] };

for (const cleanupFailure of [false, true]) test(`an input named cleanup.json preserves finalization with cleanupFailure=${cleanupFailure}`, async t => {
  const { file, store, plan } = await setup(t, plan => {
    plan.repetitions = 1; plan.environment.settings.cleanupFailure = cleanupFailure;
  });
  const original = await fs.readFile(path.join(path.dirname(file), plan.environment.initialState));
  await fs.writeFile(path.join(path.dirname(file), "cleanup.json"), original);
  plan.environment.initialState = "cleanup.json";
  await fs.writeFile(file, jsonBytes(plan));
  const result = await runPlan(file, { requestId: "cleanup-filename", store });
  assert.equal(result.index.state, "finished");
  assert.equal(result.index.exitCode, cleanupFailure ? 2 : 0);
  const [bundle] = await bundles(result); assert.ok(bundle);
  assert.equal(bundle.manifest.execution, "finished");
  assert.equal(bundle.manifest.cleanup, cleanupFailure ? "failed" : "succeeded");
  assert.equal(bundle.manifest.evidence.state, "complete");
  assert.deepEqual(await fs.readFile(path.join(bundle.root, "inputs/cleanup.json")), original);
  const disposed = await readJson(bundle.root, "environment-disposed.json") as Frame;
  assert.equal(disposed.payload.status, bundle.manifest.cleanup);
  if (cleanupFailure) assert.ok((disposed.payload.resources as string[]).length > 0);
});

test("two turns observe one reservation, and both repetitions start fresh", async t => {
  const setupResult = await setup(t);
  const result = await runPlan(setupResult.file, { requestId: "normal", store: setupResult.store });
  assert.equal(result.index.exitCode, 0);
  assert.equal(new Set(result.index.trials.map(trial => trial.trialId)).size, 2);
  const all = await bundles(result); const leases = [];
  for (const bundle of all) {
    assert.deepEqual(await state(bundle.root, "initial"), { available: 3, reservations: [] });
    const final = await state(bundle.root, "final"); assert.equal(final.available, 2); assert.equal(final.reservations.length, 1);
    assert.equal(bundle.manifest.operations.length, 3); assert.ok(bundle.manifest.operations.every(op => op.observed && op.outcome === "known_result"));
    const lines = (await fs.readFile(path.join(bundle.root, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const followUp = JSON.parse(lines.filter(event => event.kind === "assistant.turn")[1].payload.content);
    assert.equal(followUp.value.available, 2); assert.equal(followUp.value.reservations.length, 1);
    leases.push((await readJson(bundle.root, "environment-prepared.json") as Frame).payload.leaseId);
  }
  assert.equal(new Set(leases).size, 2);
  const duplicate = await runPlan(setupResult.file, { requestId: "normal", store: setupResult.store });
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.index, result.index);
  setupResult.plan.repetitions = 1; await fs.writeFile(setupResult.file, jsonBytes(setupResult.plan));
  await assert.rejects(runPlan(setupResult.file, { requestId: "normal", store: setupResult.store }), /conflicts/);
});

for (const [variant, remaining, count, operations] of [["duplicate", 1, 2, 4], ["false-claim", 3, 0, 2]] as const) test(`complete evidence captures ${variant} without inventing a quality verdict`, async t => {
  const { file, store } = await setup(t, plan => { plan.repetitions = 1; plan.agent.settings.variant = variant; });
  const result = await runPlan(file, { requestId: variant, store });
  assert.equal(result.index.exitCode, 0);
  const [bundle] = await bundles(result); assert.ok(bundle);
  assert.equal(bundle.manifest.evidence.state, "complete"); assert.equal(bundle.manifest.operations.length, operations);
  const final = await state(bundle.root, "final"); assert.equal(final.available, remaining); assert.equal(final.reservations.length, count);
  assert.equal("verdict" in bundle.manifest, false);
});

for (const [mode, remaining, outcome] of [["error_before", 3, "known_failure"], ["lost_after", 2, "outcome_unknown"]] as const) test(`${mode} retains tool outcome and independently observed state without replay`, async t => {
  const { file, store } = await setup(t, plan => { plan.repetitions = 1; plan.environment.faultPlan = [{ tool: "reserve", invocation: 1, mode }]; });
  const result = await runPlan(file, { requestId: mode, store });
  const [bundle] = await bundles(result); assert.ok(bundle);
  assert.equal(result.index.exitCode, 0); assert.equal((await state(bundle.root, "final")).available, remaining);
  assert.equal(bundle.manifest.operations.length, 3); assert.equal(bundle.manifest.operations[1]!.outcome, outcome); assert.equal(bundle.manifest.operations[1]!.observed, true);
});

test("preparation failure prevents all agent turns and retains unstarted denominator", async t => {
  const { file, store } = await setup(t, plan => { plan.environment.settings.prepareFailure = true; });
  const result = await runPlan(file, { requestId: "prepare-fail", store });
  assert.equal(result.index.exitCode, 2); assert.equal(result.index.trials.length, 2);
  for (const bundle of await bundles(result)) {
    assert.equal(bundle.manifest.execution, "not_started"); assert.equal(bundle.manifest.evidence.state, "incomplete"); assert.equal(bundle.manifest.operations.length, 0);
    assert.equal(bundle.manifest.files.some(file => file.path === "agent-ready.json"), false);
  }
});

test("reported candidate failure is distinguished from missing evidence and a fresh later trial can run", async t => {
  const { file, store } = await setup(t, plan => { plan.agent.settings.variant = "candidate-error"; });
  const result = await runPlan(file, { requestId: "candidate-error", store });
  assert.equal(result.index.exitCode, 2);
  for (const bundle of await bundles(result)) { assert.equal(bundle.manifest.execution, "agent_error"); assert.equal(bundle.manifest.evidence.state, "complete"); assert.equal(bundle.manifest.cleanup, "succeeded"); }
});

test("hanging tool reaches deadline, retains unknown outcome and unstable final state", async t => {
  const { file, store } = await setup(t, plan => { plan.repetitions = 1; plan.limits.trialMs = 2000; plan.environment.faultPlan = [{ tool: "reserve", invocation: 1, mode: "hang" }]; });
  const result = await runPlan(file, { requestId: "hang", store });
  assert.equal(result.index.exitCode, 2);
  const [bundle] = await bundles(result); assert.ok(bundle);
  assert.equal(bundle.manifest.execution, "timed_out"); assert.equal(bundle.manifest.operations.at(-1)!.outcome, "outcome_unknown");
  assert.equal(bundle.manifest.evidence.state, "incomplete"); assert.ok(bundle.manifest.evidence.gaps.includes("final_state_not_stable"));
});

test("missing final snapshot never becomes complete because the assistant finished", async t => {
  const { file, store } = await setup(t, plan => { plan.repetitions = 1; plan.environment.settings.missingSnapshot = true; });
  const result = await runPlan(file, { requestId: "missing-state", store }); const [bundle] = await bundles(result); assert.ok(bundle);
  assert.equal(bundle.manifest.execution, "finished"); assert.equal(bundle.manifest.evidence.state, "incomplete"); assert.equal(result.index.exitCode, 2);
});

test("failed cleanup halts subsequent slots and preserves owned-resource diagnostics", async t => {
  const { file, store } = await setup(t, plan => { plan.environment.settings.cleanupFailure = true; });
  const result = await runPlan(file, { requestId: "cleanup", store }); const all = await bundles(result);
  assert.equal(result.index.exitCode, 2); assert.equal(all[0]!.manifest.cleanup, "failed"); assert.equal(all[0]!.manifest.evidence.state, "complete");
  assert.equal(all[1]!.manifest.execution, "not_started");
  const cleanup = await readJson(all[0]!.root, "environment-disposed.json") as Frame; assert.equal((cleanup.payload.resources as unknown[]).length, 1);
});

test("event budget stops capture with an explicit gap and a verifiable partial bundle", async t => {
  const { file, store } = await setup(t, plan => { plan.repetitions = 1; plan.limits.maxEvents = 10; });
  const result = await runPlan(file, { requestId: "event-cap", store }); const [bundle] = await bundles(result); assert.ok(bundle);
  assert.equal(result.index.exitCode, 2); assert.equal(bundle.manifest.evidence.state, "incomplete"); assert.ok(bundle.manifest.evidence.gaps.includes("capture_limit_exceeded"));
  const lines = (await fs.readFile(path.join(bundle.root, "events.ndjson"), "utf8")).trim().split("\n"); assert.ok(lines.length <= 10);
});

test("a concurrent duplicate returns the accepted request without launching another run", async t => {
  const { file, store } = await setup(t, plan => { plan.repetitions = 1; });
  const results = await Promise.all([runPlan(file, { requestId: "same", store }), runPlan(file, { requestId: "same", store })]);
  assert.equal(results[0]!.index.runId, results[1]!.index.runId); assert.equal(results.filter(result => result.duplicate).length, 1);
  assert.equal((await showRun(store, "same")).index.exitCode, 0);
});

test("cancellation stops a running agent and records later trials as not started", async t => {
  const { file, store } = await setup(t, plan => { plan.agent.settings.variant = "hang"; });
  const abort = new AbortController();
  const running = runPlan(file, { requestId: "cancel", store, signal: abort.signal });
  const until = Date.now() + 5000;
  try {
    while (true) {
      try {
        const current = await showRun(store, "cancel");
        const log = await fs.readFile(path.join(current.root, current.index.trials[0]!.path, "events.ndjson"), "utf8");
        if (log.includes('"kind":"user.turn"')) break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (Date.now() >= until) throw new Error("Agent did not reach first turn");
      await sleep(20);
    }
  } finally { abort.abort(); }
  const result = await running;
  assert.equal(result.index.exitCode, 130); assert.equal(result.index.trials[0]!.execution, "cancelled"); assert.equal(result.index.trials[1]!.execution, "not_started");
  await bundles(result);
});

test("caller deadline wins over longer configured agent deadline", async t => {
  const { file, store } = await setup(t, plan => { plan.agent.settings.variant = "hang"; });
  const result = await runPlan(file, { requestId: "caller-deadline", store, deadlineAt: new Date(Date.now() + 1500).toISOString() });
  assert.equal(result.index.exitCode, 2);
  // The caller ceiling may expire during filesystem preparation on a busy host.
  assert.ok(["timed_out", "not_started"].includes(result.index.trials[0]!.execution));
  assert.equal(result.index.trials[1]!.execution, "not_started");
  const all = await bundles(result); assert.equal(all[0]!.manifest.evidence.state, "incomplete");
});
