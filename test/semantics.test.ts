import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { ProtocolLedger } from "../src/contracts/protocol.js";
import { contract, snapshotContract } from "../src/contracts/validate.js";
import { verifyEvents } from "../src/contracts/events.js";
import { verifyBundle } from "../src/contracts/verify.js";
import { assessmentInput, verifyAssessmentInput, verifyRunIndex } from "../src/contracts/handoff.js";
import { resolvePlan } from "../src/core/plan.js";
import { hash, jsonBytes } from "../src/core/files.js";
import type { Frame, Json, RunIndex } from "../src/contracts/types.js";
import { bundleFixture, event, goodEvents, limits, plan, profile, scenario } from "./fixtures.js";

function frame(kind: string, payload: Record<string, Json>, replyTo?: string): Frame {
  return { protocol: "trial-runner/process/v1", trialId: "trial", messageId: randomUUID(), kind, payload, ...(replyTo ? { replyTo } : {}) };
}
function start(ledger: ProtocolLedger): void {
  const start = frame("start", { adapterId: "agent", adapterVersion: "0.1.0", artifactSha256: "a".repeat(64), settings: {}, tools: [], limits: { ...limits }, bindings: {}, modelCapture: "not_applicable" });
  ledger.sent(start);
  ledger.received(frame("ready", { adapterId: "agent", adapterVersion: "0.1.0", capabilities: [], artifactSha256: "a".repeat(64), modelCapture: "not_applicable" }, start.messageId));
}

test("process session verifies both directions and active turn lifecycle", () => {
  const ledger = new ProtocolLedger("trial", "agent"); start(ledger);
  const turn = frame("user_turn", { turnId: "one", content: "hello" }); ledger.sent(turn);
  const call = frame("tool_call", { turnId: "one", tool: "stock", args: {}, logicalCallId: null }); ledger.received(call);
  ledger.sent(frame("tool_result", { operationId: "op", outcome: "known_result", value: {}, error: null }, call.messageId));
  ledger.received(frame("turn_finished", { turnId: "one", output: "ok", outstandingOperationIds: [] }, turn.messageId));
  const stop = frame("stop", { reason: "finished" }); ledger.sent(stop);
  ledger.received(frame("stopped", { outstandingOperationIds: [] }, stop.messageId));
  assert.throws(() => ledger.received(call));
});

test("process contract rejects wrong endpoint, correlation, duplicate ID and pre-ready work", () => {
  const call = frame("tool_call", { turnId: "one", tool: "stock", args: {}, logicalCallId: null });
  assert.throws(() => new ProtocolLedger("trial", "agent").received(call));
  const ledger = new ProtocolLedger("trial", "agent"); start(ledger);
  assert.throws(() => ledger.sent(frame("tool_result", { operationId: "op", outcome: "known_result", value: {}, error: null }, "missing")));
  assert.throws(() => ledger.sent(frame("prepare", { state: {}, settings: {}, clock: { mode: "real", instant: null }, faultPlan: [] })));
  ledger.sent(frame("user_turn", { turnId: "one", content: "hello" }));
  assert.throws(() => ledger.sent(frame("user_turn", { turnId: "two", content: "parallel" })));
  ledger.received(call); assert.throws(() => ledger.received(call));
  assert.throws(() => ledger.received(frame("turn_finished", { turnId: "one", output: "ok", outstandingOperationIds: [] }, "missing")));
});

test("environment protocol covers describe, prepare, execute, snapshot and dispose", () => {
  const ledger = new ProtocolLedger("trial", "environment");
  const pairs: [string, Record<string, Json>, string, Record<string, Json>][] = [
    ["describe", { adapterId: "env", adapterVersion: "1" }, "described", { adapterId: "env", adapterVersion: "1", capabilities: [], tools: [], faultModes: [] }],
    ["prepare", { state: {}, settings: {}, faultPlan: [], clock: { mode: "real", instant: null } }, "prepared", { leaseId: "lease", snapshot: { state: {}, stable: true, pendingOperations: [], observedAt: "2026-01-01T00:00:00Z" }, bindings: {} }],
    ["execute", { operationId: "op", tool: "stock", args: {} }, "executed", { operationId: "op", outcome: "known_failure", value: null, error: "simulated" }],
    ["snapshot", {}, "snapshotted", { snapshot: null, error: "missing" }],
    ["dispose", {}, "disposed", { status: "succeeded", resources: [] }],
  ];
  for (const [kind, payload, reply, result] of pairs) { const request = frame(kind, payload); ledger.sent(request); ledger.received(frame(reply, result, request.messageId)); }
  assert.throws(() => ledger.sent(frame("execute", { operationId: "late", tool: "stock", args: {} })));
});

test("stop is irreversible and a turn cannot hide a pending routed call", () => {
  const ledger = new ProtocolLedger("trial", "agent"); start(ledger);
  const turn = frame("user_turn", { turnId: "one", content: "hello" }); ledger.sent(turn);
  assert.throws(() => ledger.received(frame("tool_call", { turnId: "wrong", tool: "stock", args: {}, logicalCallId: null })));
  ledger.received(frame("tool_call", { turnId: "one", tool: "stock", args: {}, logicalCallId: null }));
  assert.throws(() => ledger.received(frame("turn_finished", { turnId: "one", output: "hidden", outstandingOperationIds: [] }, turn.messageId)));
  const stop = frame("stop", { reason: "cancelled" }); ledger.sent(stop);
  ledger.received(frame("stopped", { outstandingOperationIds: [] }, stop.messageId));
  assert.throws(() => ledger.received(frame("turn_finished", { turnId: "one", output: "late", outstandingOperationIds: [] }, turn.messageId)));
  assert.throws(() => ledger.sent(frame("user_turn", { turnId: "two", content: "resurrect" })));
});

test("terminal causes prohibit future dispatch or a successful terminal label", () => {
  const events = goodEvents(); events.splice(2, 0, event(2, "runtime.error", { execution: "timed_out", message: "deadline" }));
  events.forEach((event, i) => event.sequence = i);
  assert.throws(() => verifyEvents(events, "run", "trial"));
});

test("remote error stops new business activity but retains closing observations", () => {
  const ledger = new ProtocolLedger("trial", "agent"); start(ledger);
  ledger.sent(frame("user_turn", { turnId: "one", content: "hello" }));
  ledger.received(frame("agent_error", { message: "candidate failed" }));
  assert.throws(() => ledger.received(frame("tool_call", { turnId: "one", tool: "stock", args: {}, logicalCallId: null })));
  assert.throws(() => ledger.received(frame("event", { kind: "operation.dispatch_intent", operationId: "op", logicalCallId: null, parentOperationId: null, data: { boundary: "model", owner: "agent", name: "late", args: {} } })));
  ledger.received(frame("event", { kind: "operation.finished", operationId: "existing", logicalCallId: null, parentOperationId: null, data: { outcome: "outcome_unknown", value: null, error: "lost" } }));
  ledger.sent(frame("stop", { reason: "candidate failed" }));
});

test("operation payloads cannot hide fields or contradictory result/error values", () => {
  assert.throws(() => contract("frame", frame("event", { kind: "operation.finished", operationId: "op", logicalCallId: null, parentOperationId: null, data: { releasePolicy: "promote" } })));
  assert.throws(() => contract("frame", frame("tool_result", { operationId: "op", outcome: "known_result", value: {}, error: "also failed" }, "call")));
  assert.throws(() => contract("frame", frame("executed", { operationId: "op", outcome: "outcome_unknown", value: { success: true }, error: "lost" }, "call")));
});

test("snapshot observation metadata cannot claim stability with outstanding work", () => {
  const snapshot = { state: {}, stable: true, pendingOperations: [], observedAt: "2026-01-01T00:00:00Z" };
  snapshotContract(snapshot);
  assert.throws(() => snapshotContract({ ...snapshot, pendingOperations: ["pending"] }));
  assert.throws(() => snapshotContract({ ...snapshot, observedAt: "not-a-time" }));
});

for (const defect of ["source", "turn", "parent", "outside-turn"] as const) test(`independent replay rejects operation ${defect} laundering`, () => {
  const events = goodEvents();
  if (defect === "source") events[3]!.source = "candidate_claim";
  if (defect === "turn") events[3]!.turnId = "missing";
  if (defect === "parent") events[3]!.parentOperationId = "missing";
  if (defect === "outside-turn") { events.splice(1, 1); events.forEach((event, i) => event.sequence = i); }
  assert.throws(() => verifyEvents(events, "run", "trial"));
});

test("a complete timeout needs a captured timeout observation", async () => {
  const { root, manifest } = await bundleFixture();
  try {
    const events = goodEvents(); events.at(-1)!.payload.execution = "timed_out";
    const bytes = Buffer.from(events.map(e => JSON.stringify(e)).join("\n") + "\n");
    manifest.execution = "timed_out";
    Object.assign(manifest.files.find(f => f.path === "events.ndjson")!, { bytes: bytes.length, sha256: hash(bytes) });
    await fs.writeFile(path.join(root, "events.ndjson"), bytes); await fs.writeFile(path.join(root, "manifest.json"), jsonBytes(manifest));
    await assert.rejects(verifyBundle(root), /timed_out_not_observed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("run index retains its requested denominator and terminal metadata", () => {
  const run: RunIndex = { schemaVersion: "trial-runner/run/v1", runId: "run", requestId: "request", inputSha256: "a".repeat(64), state: "accepted",
    createdAt: "2026-01-01T00:00:00Z", finishedAt: null, rerunOf: null, deadlineAt: null, exitCode: null,
    trials: [{ trialId: "trial", scenarioId: scenario.id, repetition: 0, execution: "not_started", bundleSha256: null, path: "trials/trial" }] };
  verifyRunIndex(run, plan, [scenario.id]);
  assert.throws(() => verifyRunIndex({ ...run, trials: [] }, plan, [scenario.id]));
  assert.throws(() => verifyRunIndex({ ...run, state: "finished", exitCode: 0 }, plan, [scenario.id]));
  assert.throws(() => verifyRunIndex({ ...run, trials: [run.trials[0], run.trials[0]] }, { ...plan, repetitions: 2 }, [scenario.id]));
});

test("assessment mapping cannot upgrade coverage, change source or add a verdict", async () => {
  const { root, manifest } = await bundleFixture();
  try {
    const { digest } = await verifyBundle(root);
    const mapped = assessmentInput(manifest, digest, scenario); verifyAssessmentInput(mapped, manifest, digest, scenario);
    assert.throws(() => verifyAssessmentInput({ ...mapped, bundleSha256: "b".repeat(64) }, manifest, digest, scenario));
    assert.throws(() => verifyAssessmentInput({ ...mapped, decision: "pass" }, manifest, digest, scenario));
    assert.throws(() => verifyAssessmentInput({ ...mapped, inputs: [] }, manifest, digest, scenario));
    manifest.evidence = { ...manifest.evidence, state: "incomplete", gaps: ["missing"] };
    assert.throws(() => verifyAssessmentInput(mapped, manifest, digest, scenario));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("offline plan pins bytes and validates schemas without executing adapter code", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-plan-"));
  const code = Buffer.from("throw new Error('must never execute validation input');\n");
  const data: Record<string, unknown> = {
    "plan.json": plan, "settings.json": { type: "object", properties: {}, additionalProperties: false },
    "state.json": { remaining: 3 }, "state-schema.json": { type: "object", properties: { remaining: { type: "integer" } }, required: ["remaining"], additionalProperties: false },
    "tools.json": [], "profile.json": profile, "scenario.json": scenario,
    "agent-files.json": { schemaVersion: "trial-runner/artifact/v1", files: [{ path: "agent.js", bytes: code.length, sha256: hash(code) }] },
    "environment-files.json": { schemaVersion: "trial-runner/artifact/v1", files: [{ path: "environment.js", bytes: code.length, sha256: hash(code) }] },
  };
  try {
    for (const [name, value] of Object.entries(data)) await fs.writeFile(path.join(root, name), jsonBytes(value));
    await fs.writeFile(path.join(root, "agent.js"), code); await fs.writeFile(path.join(root, "environment.js"), code);
    const resolved = await resolvePlan(path.join(root, "plan.json"));
    assert.equal(resolved.scenarios[0]!.fixtureBytes.toString(), jsonBytes(data["state.json"]).toString());
    await fs.writeFile(path.join(root, "scenario.json"), jsonBytes({ ...scenario, messages: [...scenario.messages, ...scenario.messages] }));
    await assert.rejects(resolvePlan(path.join(root, "plan.json")), /Duplicate turn/);
    await fs.writeFile(path.join(root, "scenario.json"), jsonBytes(scenario));
    await fs.writeFile(path.join(root, "agent.js"), "changed");
    await assert.rejects(resolvePlan(path.join(root, "plan.json")), /digest mismatch/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
