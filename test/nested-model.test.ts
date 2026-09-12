import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { initExample } from "../src/cli/init.js";
import { runPlan } from "../src/core/run.js";
import { Journal } from "../src/core/journal.js";
import { hash, jsonBytes, readJson } from "../src/core/files.js";
import { verifyBundle } from "../src/contracts/verify.js";
import type { Artifact, Event, Plan, Scenario } from "../src/contracts/types.js";

type Mode = "nested" | "premature" | "cancel" | "cancel-queued";
interface Marker { kind: string; operationId?: string; active?: number; }

// The callback is a shared-file rendezvous between real process adapters. It is
// deliberately independent of customer code, network services and model SDKs.
async function fixture(t: TestContext, mode: Mode) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-nested-model-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = await initExample(path.join(root, "example"), "model-accounting");
  const directory = path.dirname(file), store = path.join(root, "store");
  const markerFile = path.join(root, "markers.ndjson"), callbackFile = path.join(root, "callback.json"), releaseFile = path.join(root, "callback-released");
  const plan = await readJson(directory, "plan.json") as Plan;
  plan.repetitions = 1;
  Object.assign(plan.limits, { prepareMs: 10000, trialMs: 1800, stopGraceMs: 300, snapshotMs: 1000, cleanupMs: 1000 });
  await fs.writeFile(file, jsonBytes(plan));
  const scenario = await readJson(directory, "scenario.json") as Scenario;
  scenario.messages = scenario.messages.slice(0, 1);
  await fs.writeFile(path.join(directory, "scenario.json"), jsonBytes(scenario));
  const common = `import { AdapterPeer } from "../src/sdk/peer.js";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const mode = ${JSON.stringify(mode)};
const markerFile = ${JSON.stringify(markerFile)}, callbackFile = ${JSON.stringify(callbackFile)}, releaseFile = ${JSON.stringify(releaseFile)};
const mark = (kind, detail = {}) => appendFileSync(markerFile, JSON.stringify({ kind, ...detail }) + "\\n");
`;
  const agent = `${common}
import { ModelRecorder } from "../src/sdk/models.js";
let recorder, stopped = false, callbackOperation = null;
const peer = new AdapterPeer(async frame => {
  if (frame.kind === "start") {
    peer.reply(frame, "ready", { adapterId: "reference.model-agent", adapterVersion: "0.1.0", artifactSha256: frame.payload.artifactSha256,
      capabilities: ["scripted-turns", "routed-tools", "conversation-events", "model-accounted"], modelCapture: "accounted" });
  } else if (frame.kind === "user_turn") {
    recorder = new ModelRecorder(peer);
    const call = () => peer.request("tool_call", { turnId: frame.payload.turnId, tool: "stock", args: {}, logicalCallId: null });
    const first = call(); void first.catch(() => {});
    // Both tool requests are already on the wire when the nested model arrives.
    const second = mode === "nested" || mode === "cancel-queued" ? call() : null; if (second) void second.catch(() => {});
    while (!existsSync(callbackFile) && !stopped) await sleep(5);
    if (stopped) return;
    callbackOperation = JSON.parse(readFileSync(callbackFile, "utf8")).operationId;
    if (mode === "premature") {
      peer.reply(frame, "turn_finished", { turnId: frame.payload.turnId, output: "Premature completion", outstandingOperationIds: [], modelOperations: [] });
      return;
    }
    if (mode === "cancel" || mode === "cancel-queued") { mark("agent-waiting", { operationId: callbackOperation }); await first; return; }
    const operation = await recorder.intent({ provider: "local-synthetic", model: "nested-callback", settings: {}, input: "synthetic input" }, "nested-logical-call");
    if (stopped) return;
    mark("synthetic-dispatch", { operationId: operation.id }); // The actual synthetic dispatch boundary.
    await recorder.observed(operation);
    await recorder.finish(operation, "known_result", { output: "synthetic result" }, null, {
      provider: "local-synthetic", model: "nested-callback", modelRevision: null, requestId: null,
      usage: { inputTokens: 1, outputTokens: 1, source: "provider_reported" }, cost: null
    });
    writeFileSync(releaseFile, "done");
    await first; if (second) await second;
    callbackOperation = null;
    if (!stopped) peer.reply(frame, "turn_finished", { turnId: frame.payload.turnId, output: "Callback completed", outstandingOperationIds: [], modelOperations: recorder.completeTurn() });
  } else if (frame.kind === "stop") {
    stopped = true; recorder?.stop(); mark("agent-stopped");
    peer.reply(frame, "stopped", { outstandingOperationIds: [...(recorder?.outstandingOperations() ?? []), ...(callbackOperation ? [callbackOperation] : [])] });
  }
});
`;
  const environment = `${common}
import { tools } from "./contract.js";
let state, invocation = 0, disposed = false;
const pending = new Set();
const snapshot = () => ({ state, stable: pending.size === 0, pendingOperations: [...pending], observedAt: "2026-01-01T00:00:00Z" });
const peer = new AdapterPeer(async frame => {
  if (frame.kind === "describe") {
    peer.reply(frame, "described", { adapterId: "reference.inventory", adapterVersion: "0.1.0", capabilities: ["fresh-lease", "state-snapshot", "routed-tools", "verified-cleanup"], tools, faultModes: [] });
  } else if (frame.kind === "prepare") {
    state = structuredClone(frame.payload.state);
    peer.reply(frame, "prepared", { leaseId: "nested-model-lease", snapshot: snapshot(), bindings: {} });
  } else if (frame.kind === "execute") {
    const operationId = frame.payload.operationId, current = ++invocation;
    pending.add(operationId); mark("execute-enter", { operationId, active: pending.size });
    await peer.request("event", { kind: "operation.dispatch_observed", operationId, logicalCallId: null, parentOperationId: null, data: {} });
    if (current === 1) {
      writeFileSync(callbackFile, JSON.stringify({ operationId }));
      while (!existsSync(releaseFile) && !disposed) await sleep(5);
    }
    if (disposed) return;
    pending.delete(operationId); mark("execute-exit", { operationId, active: pending.size });
    peer.reply(frame, "executed", { operationId, outcome: "known_result", value: { available: state.available }, error: null });
  } else if (frame.kind === "snapshot") {
    peer.reply(frame, "snapshotted", { snapshot: snapshot(), error: null });
  } else if (frame.kind === "dispose") {
    disposed = true; pending.clear();
    peer.reply(frame, "disposed", { status: "succeeded", resources: [] });
  }
});
`;
  for (const [name, source] of [["reference/model-agent.js", agent], ["reference/environment.js", environment]] as const) {
    const bytes = Buffer.from(source); await fs.writeFile(path.join(directory, name), bytes);
    for (const artifactName of ["agent-artifact.json", "environment-artifact.json"]) {
      const artifact = await readJson(directory, artifactName) as Artifact;
      Object.assign(artifact.files.find(entry => entry.path === name)!, { bytes: bytes.length, sha256: hash(bytes) });
      await fs.writeFile(path.join(directory, artifactName), jsonBytes(artifact));
    }
  }
  const markers = async (): Promise<Marker[]> => {
    const content = await fs.readFile(markerFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    return content.trim() ? content.trim().split("\n").map(line => JSON.parse(line) as Marker) : [];
  };
  const run = async (signal?: AbortSignal) => {
    const result = await runPlan(file, { store, requestId: "nested", signal });
    const slot = result.index.trials[0]!, bundle = path.join(result.root, slot.path);
    const { manifest } = await verifyBundle(bundle, slot.bundleSha256!);
    const events = (await fs.readFile(path.join(bundle, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Event);
    return { result, manifest, events, bundle, markers: await markers() };
  };
  return { run, markers };
}

test("nested model events progress during a routed callback and queued tools remain serialized", { timeout: 15000 }, async t => {
  const f = await fixture(t, "nested");
  const { result, manifest, events, markers } = await f.run();
  assert.equal(manifest.execution, "finished", manifest.reason ?? "");
  assert.equal(result.index.exitCode, 0); assert.equal(manifest.evidence.state, "complete");
  const tools = manifest.operations.filter(op => op.boundary === "tool"), models = manifest.operations.filter(op => op.boundary === "model");
  assert.equal(tools.length, 2); assert.equal(models.length, 1);
  assert.ok(manifest.operations.every(op => op.outcome === "known_result"));
  assert.deepEqual(markers.filter(marker => marker.kind.startsWith("execute-")).map(marker => [marker.kind, marker.active]),
    [["execute-enter", 1], ["execute-exit", 0], ["execute-enter", 1], ["execute-exit", 0]]);
  const sequence = (id: string, kind: string) => events.find(event => event.operationId === id && event.kind === kind)!.sequence;
  assert.ok(sequence(tools[0]!.id, "operation.dispatch_observed") < sequence(models[0]!.id, "operation.dispatch_intent"));
  assert.ok(sequence(models[0]!.id, "operation.finished") < sequence(tools[0]!.id, "operation.finished"));
  assert.ok(sequence(tools[0]!.id, "operation.finished") < sequence(tools[1]!.id, "operation.dispatch_observed"));
  assert.deepEqual(markers.filter(marker => marker.kind === "synthetic-dispatch").map(marker => marker.operationId), [models[0]!.id]);
});

test("nested physical dispatch waits while its durable intent acknowledgment is withheld", { timeout: 15000 }, async t => {
  const f = await fixture(t, "nested"), append = Journal.prototype.append;
  let inspected = false;
  Journal.prototype.append = async function(kind, payload, extra, terminal) {
    if (!inspected && kind === "operation.dispatch_intent" && payload.boundary === "model") {
      inspected = true;
      await sleep(75);
      assert.equal((await f.markers()).some(marker => marker.kind === "synthetic-dispatch"), false);
    }
    return append.call(this, kind, payload, extra, terminal);
  };
  try {
    const { manifest, markers } = await f.run();
    assert.equal(inspected, true, "The nested intent must reach the durable journal while its tool is pending");
    assert.equal(manifest.execution, "finished");
    assert.equal(markers.filter(marker => marker.kind === "synthetic-dispatch").length, 1);
  } finally { Journal.prototype.append = append; }
});

test("premature turn completion is rejected while preserving the pending callback accounting", { timeout: 15000 }, async t => {
  const { manifest, events } = await (await fixture(t, "premature")).run();
  assert.equal(manifest.execution, "protocol_error"); assert.equal(manifest.evidence.state, "incomplete");
  assert.equal(manifest.operations.length, 1);
  assert.equal(manifest.operations[0]!.boundary, "tool"); assert.equal(manifest.operations[0]!.observed, true);
  assert.equal(manifest.operations[0]!.outcome, "outcome_unknown");
  assert.equal(events.some(event => event.kind === "assistant.turn"), false);
});

for (const mode of ["cancel", "cancel-queued"] as const) test(`cancellation retains a stopped acknowledgment while a callback is pending: ${mode}`, { timeout: 15000 }, async t => {
  const f = await fixture(t, mode), controller = new AbortController();
  const running = f.run(controller.signal); void running.catch(() => {});
  try {
    const until = Date.now() + 5000;
    while (!(await f.markers()).some(marker => marker.kind === "agent-waiting")) {
      assert.ok(Date.now() < until, "Agent never reached the pending callback"); await sleep(10);
    }
    controller.abort();
    const { result, manifest, bundle, markers } = await running;
    assert.equal(result.index.exitCode, 130); assert.equal(manifest.execution, "cancelled");
    assert.equal(manifest.cleanup, "succeeded"); assert.equal(manifest.evidence.state, "incomplete");
    assert.equal(manifest.operations.length, 1); assert.equal(manifest.operations[0]!.outcome, "outcome_unknown");
    const stopped = await readJson(bundle, "agent-stopped.json") as { payload: { outstandingOperationIds: string[] } };
    assert.deepEqual(stopped.payload.outstandingOperationIds, [manifest.operations[0]!.id]);
    assert.ok(manifest.evidence.gaps.includes("agent_reported_outstanding_work"));
    assert.equal(markers.filter(marker => marker.kind === "execute-enter").length, 1, "A queued tool must not dispatch after cancellation");
    assert.equal(markers.some(marker => marker.kind === "execute-exit"), false);
    assert.equal(markers.some(marker => marker.kind === "synthetic-dispatch"), false);
  } finally { controller.abort(); await running.catch(() => {}); }
});
