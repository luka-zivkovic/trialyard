import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { hash, jsonBytes } from "../src/core/files.js";
import type { Artifact, Event, Frame, Json, Manifest, Plan, Profile, Scenario, ToolDefinition } from "../src/contracts/types.js";

export const limits = { prepareMs: 60000, trialMs: 120000, stopGraceMs: 5000, snapshotMs: 15000,
  cleanupMs: 15000, maxTurns: 20, maxFrameBytes: 1048576, maxEvents: 10000, maxRecordedBytes: 67108864 };
export const profile: Profile = {
  schemaVersion: "trial-runner/evidence-profile/v1", id: "stateful", captureBoundary: "reference protocol and inventory tools",
  required: { conversation: true, routedToolEvents: true, initialState: true, finalState: true, stableFinalState: true, localArtifactIdentity: true, terminalOperationAccounting: true },
  modelCapture: "not_applicable", modelCaptureReason: "Scripted reference, no model calls",
  terminalRules: { not_started: "incomplete", finished: "require_all_declared_observations", agent_error: "require_error_event_and_all_declared_observations",
    timed_out: "require_timeout_event_and_all_declared_observations", cancelled: "require_cancellation_event_and_all_declared_observations", infrastructure_error: "incomplete" },
};
export const scenario: Scenario = { schemaVersion: "trial-runner/scenario/v1", id: "reserve", description: "Independent reference",
  messages: [{ id: "one", role: "user", content: "Reserve one item" }], provenance: { origin: "reference", exposure: "runner-development" }, externalCriterionRefs: [] };
export const plan: Plan = {
  schemaVersion: "trial-runner/plan/v1", id: "reference", agent: { adapterId: "agent", adapterVersion: "0.1.0", argv: ["node", "agent.js"], cwd: ".",
    artifactManifest: "agent-files.json", capabilities: ["scripted-turns", "routed-tools", "conversation-events"], settingsSchema: "settings.json", settings: {} },
  environment: { adapterId: "inventory", adapterVersion: "0.1.0", argv: ["node", "environment.js"], cwd: ".", artifactManifest: "environment-files.json",
    capabilities: ["fresh-lease", "state-snapshot", "routed-tools", "verified-cleanup"], settingsSchema: "settings.json", settings: {}, initialState: "state.json",
    fixtureSchema: "state-schema.json", toolSchemas: "tools.json", clock: { mode: "frozen", instant: "2026-01-01T00:00:00Z" }, faultPlan: [] },
  scenarios: [{ path: "scenario.json" }], repetitions: 1, limits, evidenceProfile: "profile.json", capturePolicy: { content: "local", externalExport: "explicit" }, secretBindings: [],
};
export function event(sequence: number, kind: Event["kind"], payload: Event["payload"], extra: Partial<Event> = {}): Event {
  return { schemaVersion: "trial-runner/event/v1", sequence, recordedAt: "2026-01-01T00:00:00Z", producerTimestamp: null,
    runId: "run", trialId: "trial", turnId: null, operationId: null, logicalCallId: null, parentOperationId: null, source: "runner_observed", kind, payload, ...extra };
}
export function goodEvents(): Event[] {
  return [event(0, "trial.started", { scenarioId: "reserve", repetition: 0 }), event(1, "user.turn", { content: "Reserve one item" }, { turnId: "one" }),
    event(2, "operation.dispatch_intent", { boundary: "tool", owner: "runner", name: "reserve", args: {} }, { operationId: "op", turnId: "one" }),
    event(3, "operation.dispatch_observed", {}, { operationId: "op", source: "environment_observed", turnId: "one" }),
    event(4, "operation.finished", { outcome: "known_result", value: { count: 1 }, error: null }, { operationId: "op", source: "environment_observed", turnId: "one" }),
    event(5, "assistant.turn", { content: "Reserved" }, { turnId: "one", source: "candidate_claim" }),
    event(6, "trial.terminal", { execution: "finished", reason: null })];
}
export async function bundleFixture(): Promise<{ root: string; manifest: Manifest }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-contract-"));
  const state = { state: { remaining: 2 }, stable: true, pendingOperations: [], observedAt: "2026-01-01T00:00:00Z" };
  const code = Buffer.from("// synthetic artifact; no agent executed\n");
  const artifact: Artifact = { schemaVersion: "trial-runner/artifact/v1", files: ["agent.js", "environment.js"].map(path => ({ path, bytes: code.length, sha256: hash(code) })) };
  const tools: ToolDefinition[] = [{ name: "reserve", input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false } }];
  const observation = (kind: string, payload: Record<string, Json>): Buffer => jsonBytes({ protocol: "trial-runner/process/v1", trialId: "trial",
    messageId: `${kind}-reply`, replyTo: `${kind}-request`, kind, payload } satisfies Frame);
  const files = new Map<string, Buffer>([
    ["plan.json", jsonBytes(plan)], ["scenario.json", jsonBytes(scenario)], ["profile.json", jsonBytes(profile)], ["fixture.json", jsonBytes({ remaining: 3 })],
    ["initial-state.json", jsonBytes({ ...state, state: { remaining: 3 } })], ["final-state.json", jsonBytes(state)],
    ["events.ndjson", Buffer.from(goodEvents().map(e => JSON.stringify(e)).join("\n") + "\n")],
    ["agent-artifact.json", jsonBytes(artifact)], ["environment-artifact.json", jsonBytes(artifact)], ["inputs/agent.js", code], ["inputs/environment.js", code],
    ["environment-described.json", observation("described", { adapterId: plan.environment.adapterId, adapterVersion: plan.environment.adapterVersion,
      capabilities: plan.environment.capabilities, tools: tools as unknown as Json, faultModes: [] })],
    ["environment-prepared.json", observation("prepared", { leaseId: "lease", snapshot: { ...state, state: { remaining: 3 } }, bindings: {} })],
    ["agent-ready.json", observation("ready", { adapterId: plan.agent.adapterId, adapterVersion: plan.agent.adapterVersion,
      capabilities: plan.agent.capabilities, artifactSha256: hash(jsonBytes(artifact)), modelCapture: profile.modelCapture })],
    ["environment-disposed.json", observation("disposed", { status: "succeeded", resources: [] })],
  ]);
  files.set("inputs/plan.json", jsonBytes(plan));
  files.set("inputs/agent-files.json", jsonBytes(artifact));
  files.set("inputs/environment-files.json", jsonBytes(artifact));
  files.set("inputs/scenario.json", jsonBytes(scenario));
  files.set("inputs/profile.json", jsonBytes(profile));
  files.set("inputs/state.json", jsonBytes({ remaining: 3 }));
  files.set("inputs/settings.json", jsonBytes({ type: "object", properties: {}, additionalProperties: false }));
  files.set("inputs/state-schema.json", jsonBytes({ type: "object", properties: { remaining: { type: "integer", minimum: 0 } }, required: ["remaining"], additionalProperties: false }));
  files.set("inputs/tools.json", jsonBytes(tools));
  const manifest: Manifest = {
    schemaVersion: "trial-runner/evidence/v1", runId: "run", requestId: "request", trialId: "trial", scenarioId: "reserve", repetition: 0,
    planSha256: hash(files.get("plan.json")!), scenarioSha256: hash(files.get("scenario.json")!), fixtureSha256: hash(files.get("fixture.json")!),
    execution: "finished", reason: null, cleanup: "succeeded", evidence: { state: "complete", gaps: [], profile, redactedPaths: [] },
    identity: { runnerVersion: "0.1.0", nodeVersion: "24.15.0", agentArtifactSha256: hash(jsonBytes(artifact)), environmentArtifactSha256: hash(jsonBytes(artifact)),
      strength: "observed_local_artifacts", authenticity: "not_attested" },
    fidelity: { boundary: profile.captureBoundary, mode: "operator_trusted_local", modelCoverage: "not_applicable" },
    provider: { requested: null, observed: null, usage: null, cost: null },
    operations: [{ id: "op", logicalCallId: null, boundary: "tool", owner: "runner", observed: true, outcome: "known_result" }],
    files: [...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })), parentBundleSha256: null,
  };
  manifest.files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const [name, bytes] of files) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), bytes); }
  await fs.writeFile(path.join(root, "manifest.json"), jsonBytes(manifest));
  return { root, manifest };
}
