import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { initExample } from "../src/cli/init.js";
import { runPlan, showRun } from "../src/core/run.js";
import { inspectRun } from "../src/core/inspect.js";
import { hash, jsonBytes, readJson } from "../src/core/files.js";
import type { Artifact, Plan } from "../src/contracts/types.js";

async function setup(t: TestContext, stage: string) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-crash-"));
  const file = await initExample(path.join(root, "example"));
  const store = path.join(root, "store"); const marker = path.join(root, "physical-call.json");
  const plan = await readJson(path.dirname(file), "plan.json") as Plan;
  Object.assign(plan.limits, { prepareMs: 300000, trialMs: 60000, stopGraceMs: 30, snapshotMs: 5000, cleanupMs: 5000 });
  await fs.writeFile(file, jsonBytes(plan));
  const environment = `import { writeFileSync } from "node:fs";
import { AdapterPeer } from "../src/sdk/peer.js";
import { tools } from "./contract.js";
let state; const snapshot = () => ({ state, stable: true, pendingOperations: [], observedAt: "2026-01-01T00:00:00Z" });
const peer = new AdapterPeer(async frame => {
  if (frame.kind === "describe") peer.reply(frame, "described", { adapterId: "reference.inventory", adapterVersion: "0.1.0", capabilities: ["fresh-lease", "state-snapshot", "routed-tools", "verified-cleanup"], tools, faultModes: [] });
  else if (frame.kind === "prepare") { state = frame.payload.state; peer.reply(frame, "prepared", { leaseId: "crash-lease", snapshot: snapshot(), bindings: {} }); }
  else if (frame.kind === "execute") {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ stage: "after-send", pid: process.pid }));
    if (${JSON.stringify(stage)} !== "after-observation") return;
    await peer.request("event", { kind: "operation.dispatch_observed", operationId: frame.payload.operationId, logicalCallId: null, parentOperationId: null, data: {} });
    state.available -= 1;
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ stage: "after-observation", pid: process.pid, available: state.available }));
  }
  else if (frame.kind === "snapshot") peer.reply(frame, "snapshotted", { snapshot: snapshot(), error: null });
  else if (frame.kind === "dispose") peer.reply(frame, "disposed", { status: "succeeded", resources: [] });
});\n`;
  const name = "reference/environment.js"; const bytes = Buffer.from(environment);
  await fs.writeFile(path.join(path.dirname(file), name), bytes);
  for (const artifactName of ["agent-artifact.json", "environment-artifact.json"]) {
    const artifact = await readJson(path.dirname(file), artifactName) as Artifact;
    Object.assign(artifact.files.find(entry => entry.path === name)!, { sha256: hash(bytes), bytes: bytes.length });
    await fs.writeFile(path.join(path.dirname(file), artifactName), jsonBytes(artifact));
  }
  const workerPids = new Set<number>(); let reached = false; let diagnostic = "";
  const child = fork(fileURLToPath(new URL("./support/crash-runner.js", import.meta.url)), [file, store, stage], { silent: true });
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  child.stderr!.on("data", (bytes: Buffer) => { diagnostic += bytes.toString(); });
  child.on("message", (message: { stage?: string; workerPid?: number }) => {
    if (message.stage === stage) reached = true;
    if (message.workerPid) workerPids.add(message.workerPid);
  });
  t.after(async () => {
    child.kill("SIGKILL"); await closed;
    for (const pid of workerPids) try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const waitForBarrier = async () => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      if (reached) return;
      try { if ((await readJson(root, "physical-call.json") as { stage: string }).stage === stage) return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Runner exited before barrier: ${diagnostic}`);
      await sleep(10);
    }
    throw new Error(`Crash barrier not reached: ${diagnostic}`);
  };
  return { root, file, store, marker, plan, child, closed, waitForBarrier };
}

for (const stage of ["before-intent", "after-intent", "after-send", "after-observation"]) test(`SIGKILL ${stage}: retained evidence stays uncertain and duplicate cannot replay`, { timeout: 45000 }, async t => {
  const run = await setup(t, stage); await run.waitForBarrier();
  run.child.kill("SIGKILL"); assert.equal((await run.closed).signal, "SIGKILL");
  const shown = await showRun(run.store, "crash");
  const result = await inspectRun(shown.root, shown.index, shown.acceptanceSha256);
  assert.equal(result.coverage, "anchored"); assert.equal(result.runState, "accepted"); assert.equal(result.executionResumed, false);
  assert.equal(result.trials.length, 2); assert.equal(result.trials[1]!.state, "not_observed");
  const trial = result.trials[0]!; assert.equal(trial.state, "unfinished"); assert.equal(trial.terminalExecution, null);
  if (stage === "before-intent") assert.deepEqual(trial.operations, []);
  else {
    assert.equal(trial.operations.length, 1); assert.equal(trial.operations[0]!.recordedOutcome, null);
    assert.equal(trial.operations[0]!.dispatch, stage === "after-observation" ? "observed" : "unknown");
    assert.equal(trial.operations[0]!.outcome, "outcome_unknown");
  }
  const marker = await fs.readFile(run.marker).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (["before-intent", "after-intent"].includes(stage)) assert.equal(marker, null, "No physical dispatch before acknowledged intent returns");
  else assert.equal(JSON.parse(marker!.toString()).stage, stage);
  const duplicate = await runPlan(run.file, { store: run.store, requestId: "crash" });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.index.runId, shown.index.runId);
  assert.deepEqual(await inspectRun(shown.root, shown.index, shown.acceptanceSha256), result);
  assert.deepEqual(await fs.readFile(run.marker).catch(() => null), marker);
  run.plan.repetitions = 1; await fs.writeFile(run.file, jsonBytes(run.plan));
  await assert.rejects(runPlan(run.file, { store: run.store, requestId: "crash" }), /conflicts/);
});

test("cancellation after durable intent records known non-dispatch at the actual send boundary", { timeout: 45000 }, async t => {
  const run = await setup(t, "cancel-before-send"); assert.equal((await run.closed).code, 0);
  const shown = await showRun(run.store, "crash"); const result = await inspectRun(shown.root, shown.index, shown.acceptanceSha256);
  const operation = result.trials[0]!.operations[0]!;
  assert.equal(operation.dispatch, "not_dispatched"); assert.equal(operation.recordedOutcome, "not_dispatched");
  assert.equal(result.trials[1]!.terminalExecution, "not_started");
  await assert.rejects(fs.stat(run.marker), { code: "ENOENT" });
});
