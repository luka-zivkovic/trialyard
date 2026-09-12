import { test } from "node:test";
import assert from "node:assert/strict";
import { modelGaps, modelObservation, modelRequest, providerSummary } from "../src/contracts/models.js";
import { verifyEvents } from "../src/contracts/events.js";
import type { Event } from "../src/contracts/types.js";
import { event, profile } from "./fixtures.js";

function transcript(): Event[] {
  const correlation = { operationId: "model-1", turnId: "one", logicalCallId: "logical", source: "adapter_reported" as const };
  return [event(0, "trial.started", { scenarioId: "reserve", repetition: 0 }), event(1, "user.turn", { content: "Reserve" }, { turnId: "one" }),
    event(2, "operation.dispatch_intent", { boundary: "model", owner: "agent", name: "mutable-alias", args: { provider: "synthetic", model: "mutable-alias", settings: {}, input: "Reserve" } }, correlation),
    event(3, "operation.dispatch_observed", {}, correlation),
    event(4, "operation.finished", { outcome: "known_failure", value: null, error: "temporary failure", model: { provider: "synthetic", model: "mutable-alias", modelRevision: null, requestId: "response-1", usage: null, cost: null } }, correlation),
    event(5, "assistant.turn", { content: "Could not reserve", modelOperations: ["model-1"] }, { turnId: "one", source: "candidate_claim" }),
    event(6, "trial.terminal", { execution: "finished", reason: null })];
}

test("model contracts preserve failures, aliases and unknown provenance without manufactured zeros", () => {
  const events = transcript(); verifyEvents(events, "run", "trial");
  assert.deepEqual(providerSummary(events).usage, [{ operationId: "model-1", value: null }]);
  assert.deepEqual(providerSummary(events).cost, [{ operationId: "model-1", value: null }]);
  assert.deepEqual(modelGaps({ ...profile, modelCapture: "accounted" }, events), []);
  assert.deepEqual(modelGaps({ ...profile, modelCapture: "accounted", required: { ...profile.required, modelUsage: true } }, events), ["model_usage_missing"]);
  assert.deepEqual(modelGaps({ ...profile, modelCapture: "reported" }, events), ["model_attempts_unverified"]);
  assert.throws(() => modelRequest({ provider: "synthetic", model: "alias", settings: {}, input: null, hidden: true }));
  assert.throws(() => modelRequest({ provider: " ", model: "alias", settings: {}, input: null }));
  assert.throws(() => modelObservation({ provider: null, model: null, modelRevision: null, requestId: null, usage: { inputTokens: -1, outputTokens: 0, source: "provider_reported" }, cost: null }));
});

for (const defect of ["missing-dispatch", "wrong-owner", "wrong-model", "duplicate-id", "foreign-coverage", "duplicate-coverage", "missing-metadata-field", "model-on-tool"] as const) test(`model replay rejects ${defect}`, () => {
  const events = transcript();
  if (defect === "missing-dispatch") events.splice(3, 1);
  if (defect === "wrong-owner") events[2]!.payload.owner = "runner";
  if (defect === "wrong-model") events[2]!.payload.name = "other-model";
  if (defect === "duplicate-id") events.splice(3, 0, structuredClone(events[2]!));
  if (defect === "foreign-coverage") events[5]!.payload.modelOperations = ["unrecorded"];
  if (defect === "duplicate-coverage") events[5]!.payload.modelOperations = ["model-1", "model-1"];
  if (defect === "missing-metadata-field") delete (events[4]!.payload.model as Record<string, unknown>).usage;
  if (defect === "model-on-tool") { events[2]!.payload.boundary = "tool"; events[2]!.payload.owner = "runner"; events[2]!.source = "runner_observed"; events[3]!.source = events[4]!.source = "environment_observed"; }
  events.forEach((entry, index) => entry.sequence = index);
  assert.throws(() => verifyEvents(events, "run", "trial"));
});

test("explicit zero model calls differs from missing or interrupted coverage", () => {
  const events = transcript(); events.splice(2, 3); events[2]!.payload.modelOperations = [];
  events.forEach((entry, index) => entry.sequence = index); verifyEvents(events, "run", "trial");
  const declared = { ...profile, modelCapture: "accounted" as const };
  assert.deepEqual(modelGaps(declared, events), []);
  delete events[2]!.payload.modelOperations;
  assert.deepEqual(modelGaps(declared, events), ["model_turn_coverage_missing"]);
  const interrupted = transcript(); interrupted.splice(5, 1); interrupted.at(-1)!.payload.execution = "adapter_error";
  interrupted.forEach((entry, index) => entry.sequence = index);
  assert.deepEqual(modelGaps(declared, interrupted), ["model_turn_coverage_missing"]);
});
