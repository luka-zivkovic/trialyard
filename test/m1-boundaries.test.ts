import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { initExample } from "../src/cli/init.js";
import { runPlan } from "../src/core/run.js";
import { hash, jsonBytes, readJson } from "../src/core/files.js";
import { verifyBundle } from "../src/contracts/verify.js";
import type { Artifact, Event, Plan, Snapshot } from "../src/contracts/types.js";

interface Marker { kind: string; pid: number; at: number; }

/** Independently authored workers implement the public protocol using synthetic state. */
async function setup(t: TestContext, mode: string, change: (plan: Plan) => void = () => {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-m1-boundary-"));
  const markerFile = path.join(root, "observations.ndjson");
  const heartbeat = path.join(root, "descendant-heartbeat");
  const markers = async (): Promise<Marker[]> => {
    const text = await fs.readFile(markerFile, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line) as Marker) : [];
  };
  t.after(async () => {
    for (const pid of new Set((await markers()).map(marker => marker.pid))) {
      for (const target of [-pid, pid]) try { process.kill(target, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = await initExample(path.join(root, "example"));
  const inputRoot = path.dirname(file);
  const plan = await readJson(inputRoot, "plan.json") as Plan;
  plan.repetitions = 1;
  Object.assign(plan.limits, { prepareMs: 300000, trialMs: 2000, stopGraceMs: 50, snapshotMs: 250, cleanupMs: 250 });
  change(plan);
  await fs.writeFile(file, jsonBytes(plan));

  const common = `import { AdapterPeer } from "../src/sdk/peer.js";
import { appendFileSync, writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const markerFile = ${JSON.stringify(markerFile)};
const mark = kind => appendFileSync(markerFile, JSON.stringify({ kind, pid: process.pid, at: Date.now() }) + "\\n");
`;
  const descendant = `const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.appendFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ kind: "descendant", pid: process.pid, at: Date.now() }) + "\\n");
setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, "."), 10);`;
  const agent = `${common}
import { spawn } from "node:child_process";
mark("agent-boot");
if (mode === "stubborn-descendant") process.on("SIGTERM", () => mark("agent-ignored-term"));
const peer = new AdapterPeer(async frame => {
  if (frame.kind === "start") {
    mark("agent-start");
    if (mode === "ready-crash") process.exit(19);
    peer.reply(frame, "ready", { adapterId: mode === "agent-identity" ? "wrong-agent" : "reference.agent", adapterVersion: "0.1.0",
      artifactSha256: frame.payload.artifactSha256, capabilities: mode === "agent-capability" ? ["scripted-turns", "conversation-events"] : ["scripted-turns", "routed-tools", "conversation-events"], modelCapture: "not_applicable" });
  } else if (frame.kind === "user_turn") {
    mark("agent-turn");
    if (mode === "running-crash") process.exit(19);
    if (mode === "reported-agent-error") { peer.notify("agent_error", { message: "Synthetic candidate failure" }); return; }
    if (mode === "stubborn-descendant") { spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); return; }
    if (mode === "wrong-turn") { peer.reply(frame, "turn_finished", { turnId: "not-the-active-turn", output: "unsupported reply", outstandingOperationIds: [] }); return; }
    const result = await peer.request("tool_call", { turnId: frame.payload.turnId, tool: "stock", args: {}, logicalCallId: null });
    peer.reply(frame, "turn_finished", { turnId: frame.payload.turnId, output: JSON.stringify(result.payload), outstandingOperationIds: [] });
  } else if (frame.kind === "stop") {
    mark("agent-stop");
    if (mode !== "stubborn-descendant") peer.reply(frame, "stopped", { outstandingOperationIds: [] });
  }
});
`;
  const environment = `${common}
import { tools } from "./contract.js";
mark("environment-boot");
let state;
let unresolved = false;
const snapshot = () => ({ state, stable: !unresolved, pendingOperations: unresolved ? ["unresolved-external-operation"] : [], observedAt: "2026-01-01T00:00:00Z" });
const peer = new AdapterPeer(async frame => {
  if (frame.kind === "describe") {
    mark("environment-describe");
    peer.reply(frame, "described", { adapterId: "reference.inventory", adapterVersion: "0.1.0", capabilities: mode === "environment-capability" ? ["state-snapshot", "routed-tools", "verified-cleanup"] : ["fresh-lease", "state-snapshot", "routed-tools", "verified-cleanup"], tools, faultModes: [] });
  } else if (frame.kind === "prepare") {
    mark("environment-prepare");
    if (mode === "prepare-timeout") return;
    if (mode === "reset-io-error") {
      try { writeFileSync(process.cwd(), "reset cannot replace the workspace directory"); }
      catch (error) { peer.notify("environment_error", { message: "Reset failed: " + error.code }); return; }
    }
    state = structuredClone(frame.payload.state);
    if (mode === "invalid-initial-state") state.available = -1;
    if (mode === "unstable-initial-state") unresolved = true;
    peer.reply(frame, "prepared", { leaseId: "synthetic-lease", snapshot: snapshot(), bindings: {} });
  } else if (frame.kind === "execute") {
    mark("environment-execute");
    await peer.request("event", { kind: "operation.dispatch_observed", operationId: frame.payload.operationId, logicalCallId: null, parentOperationId: null, data: {} });
    if (mode === "unresolved-external-work") {
      unresolved = true;
      peer.reply(frame, "executed", { operationId: frame.payload.operationId, outcome: "outcome_unknown", value: null, error: "External request outcome not observed" });
    } else peer.reply(frame, "executed", { operationId: frame.payload.operationId, outcome: "known_result", value: { available: mode === "invalid-tool-result" ? "three" : state.available }, error: null });
  } else if (frame.kind === "snapshot") {
    mark("environment-snapshot");
    if (mode === "snapshot-timeout") return;
    if (mode === "invalid-final-state") state.available = -1;
    peer.reply(frame, "snapshotted", { snapshot: snapshot(), error: null });
  } else if (frame.kind === "dispose") {
    mark("environment-dispose");
    if (mode === "cleanup-timeout") return;
    peer.reply(frame, "disposed", { status: "succeeded", resources: [] });
  }
});
`;
  for (const [name, source] of [["reference/agent.js", agent], ["reference/environment.js", environment]]) {
    const bytes = Buffer.from(source!);
    await fs.writeFile(path.join(inputRoot, name!), bytes);
    for (const artifactName of ["agent-artifact.json", "environment-artifact.json"]) {
      const artifact = await readJson(inputRoot, artifactName) as Artifact;
      Object.assign(artifact.files.find(entry => entry.path === name)!, { bytes: bytes.length, sha256: hash(bytes) });
      await fs.writeFile(path.join(inputRoot, artifactName), jsonBytes(artifact));
    }
  }
  const run = async () => {
    const result = await runPlan(file, { requestId: "boundary", store: path.join(root, "store") });
    const completedAt = Date.now();
    const bundles = await Promise.all(result.index.trials.map(async slot => {
      const bundleRoot = path.join(result.root, slot.path);
      const verified = await verifyBundle(bundleRoot, slot.bundleSha256!);
      const events = (await fs.readFile(path.join(bundleRoot, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Event);
      return { ...verified, root: bundleRoot, events };
    }));
    return { result, bundles, completedAt, markers: await markers() };
  };
  return { run, heartbeat, markers, plan };
}

for (const mode of ["reset-io-error", "invalid-initial-state", "unstable-initial-state", "prepare-timeout"]) {
  test(`A03 ${mode} prevents agent launch and retains every allocated slot`, { timeout: 20000 }, async t => {
    const fixture = await setup(t, mode, plan => { plan.repetitions = 2; if (mode === "prepare-timeout") plan.limits.prepareMs = 1500; });
    const { result, bundles, markers } = await fixture.run();
    assert.equal(result.index.exitCode, 2); assert.equal(bundles.length, 2);
    assert.equal(markers.some(marker => marker.kind === "agent-boot" || marker.kind === "environment-execute"), false);
    for (const bundle of bundles) {
      assert.equal(bundle.manifest.execution, "not_started"); assert.equal(bundle.manifest.evidence.state, "incomplete");
      assert.deepEqual(bundle.manifest.operations, []); assert.equal(bundle.events.some(event => event.kind === "user.turn"), false);
    }
  });
}

test("A08 environment capability mismatch prevents preparation and all agent work", { timeout: 15000 }, async t => {
  const { bundles, markers } = await (await setup(t, "environment-capability")).run();
  assert.equal(bundles[0]!.manifest.execution, "not_started");
  assert.equal(markers.some(marker => ["environment-prepare", "agent-boot", "environment-execute"].includes(marker.kind)), false);
});

for (const mode of ["agent-capability", "agent-identity"]) test(`A08 ${mode} rejects the handshake before a user turn or tool dispatch`, { timeout: 15000 }, async t => {
  const { result, bundles, markers } = await (await setup(t, mode)).run();
  assert.equal(result.index.exitCode, 2);
  assert.equal(bundles[0]!.manifest.execution, "protocol_error");
  assert.equal(bundles[0]!.manifest.evidence.state, "incomplete");
  assert.equal(markers.some(marker => ["agent-turn", "environment-execute"].includes(marker.kind)), false);
  assert.deepEqual(bundles[0]!.manifest.operations, []);
});

for (const [mode, execution] of [["ready-crash", "adapter_error"], ["running-crash", "adapter_error"], ["wrong-turn", "protocol_error"], ["invalid-tool-result", "environment_error"]] as const) {
  test(`A10 ${mode} is attributed to the adapter or environment boundary`, { timeout: 15000 }, async t => {
    const { result, bundles, markers } = await (await setup(t, mode)).run();
    const first = bundles[0]!;
    assert.equal(result.index.exitCode, 2); assert.equal(first.manifest.execution, execution);
    assert.equal(first.manifest.evidence.state, "incomplete");
    assert.equal(first.events.some(event => event.kind === "agent.error"), false);
    if (mode === "ready-crash") assert.equal(markers.some(marker => marker.kind === "agent-turn"), false);
    if (mode === "invalid-tool-result") {
      assert.equal(first.manifest.operations.length, 1); assert.equal(first.manifest.operations[0]!.outcome, "outcome_unknown");
    }
  });
}

test("A10 an explicit candidate error retains its separate execution category and complete observations", { timeout: 15000 }, async t => {
  const { result, bundles } = await (await setup(t, "reported-agent-error")).run();
  const first = bundles[0]!;
  assert.equal(result.index.exitCode, 2); assert.equal(first.manifest.execution, "agent_error");
  assert.equal(first.manifest.evidence.state, "complete"); assert.equal(first.manifest.cleanup, "succeeded");
  assert.ok(first.events.some(event => event.kind === "agent.error" && event.payload.message === "Synthetic candidate failure"));
});

for (const mode of ["snapshot-timeout", "invalid-final-state"]) test(`A11 ${mode} retains execution and reports unavailable final state`, { timeout: 15000 }, async t => {
  const { result, bundles, markers } = await (await setup(t, mode)).run();
  const first = bundles[0]!;
  assert.equal(result.index.exitCode, 2); assert.equal(first.manifest.execution, "finished");
  assert.equal(first.manifest.evidence.state, "incomplete"); assert.equal(first.manifest.cleanup, "succeeded");
  assert.ok(first.manifest.evidence.gaps.includes("final_snapshot_unavailable"));
  assert.ok(first.manifest.evidence.gaps.includes("final_state_missing"));
  assert.equal(first.manifest.files.some(file => file.path === "final-state.json"), false);
  if (mode === "snapshot-timeout") {
    const start = markers.find(marker => marker.kind === "environment-snapshot")!.at;
    const cleanup = markers.find(marker => marker.kind === "environment-dispose")!.at;
    assert.ok(cleanup - start < 1500, "Snapshot wait must stop at its separate ceiling");
  }
});

test("A15 cleanup timeout stays unknown and prevents remaining trial dispatch", { timeout: 15000 }, async t => {
  const { result, bundles, markers, completedAt } = await (await setup(t, "cleanup-timeout", plan => { plan.repetitions = 2; })).run();
  assert.equal(result.index.exitCode, 2); assert.equal(bundles[0]!.manifest.execution, "finished");
  assert.equal(bundles[0]!.manifest.cleanup, "unknown"); assert.equal(bundles[1]!.manifest.execution, "not_started");
  assert.equal(markers.filter(marker => marker.kind === "agent-boot").length, 1);
  const disposal = markers.find(marker => marker.kind === "environment-dispose")!.at;
  assert.ok(completedAt - disposal < 2500, "Disposal wait must stop at its separate ceiling");
});

test("A11 completed conversation cannot make unresolved external work stable", { timeout: 15000 }, async t => {
  const { result, bundles } = await (await setup(t, "unresolved-external-work")).run();
  const first = bundles[0]!;
  assert.equal(result.index.exitCode, 2); assert.equal(first.manifest.execution, "finished");
  assert.equal(first.manifest.evidence.state, "incomplete"); assert.ok(first.manifest.evidence.gaps.includes("final_state_not_stable"));
  assert.ok(first.manifest.operations.every(operation => operation.observed && operation.outcome === "outcome_unknown"));
  const snapshot = await readJson(first.root, "final-state.json") as Snapshot;
  assert.equal(snapshot.stable, false); assert.deepEqual(snapshot.pendingOperations, ["unresolved-external-operation"]);
});

test("A09 local group termination stops a worker and descendant that ignore cooperative stop", { timeout: 20000 }, async t => {
  const fixture = await setup(t, "stubborn-descendant");
  const { result, bundles, markers } = await fixture.run();
  assert.equal(result.index.exitCode, 2); assert.equal(bundles[0]!.manifest.execution, "timed_out");
  assert.ok(markers.some(marker => marker.kind === "agent-stop"));
  assert.ok(markers.some(marker => marker.kind === "agent-ignored-term"));
  const descendant = markers.find(marker => marker.kind === "descendant"); assert.ok(descendant);
  const before = await fs.readFile(fixture.heartbeat); assert.ok(before.length > 0);
  await sleep(100);
  assert.deepEqual(await fs.readFile(fixture.heartbeat), before, "No descendant work continues after local group termination");
  let alive = true;
  try { process.kill(descendant.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    alive = false;
  }
  // A container's PID 1 may retain a killed orphan as a non-executing zombie.
  if (alive && process.platform === "linux") {
    const status = await fs.readFile(`/proc/${descendant.pid}/stat`, "utf8").catch(() => "");
    alive = status !== "" && status.slice(status.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  }
  assert.equal(alive, false, "Descendant must have exited or been killed");
});
