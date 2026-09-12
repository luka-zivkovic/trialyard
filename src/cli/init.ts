import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hash, jsonBytes, writeAtomic } from "../core/files.js";
import type { Plan, Profile, Scenario } from "../contracts/types.js";
import { agentSettingsSchema, environmentSettingsSchema, fixtureSchema, tools } from "../../reference/contract.js";

/** Materializes only shipped templates, without inspecting or executing candidate code. */
export async function exampleFiles(example: "inventory" | "model-accounting" = "inventory"): Promise<Map<string, Buffer>> {
    const source = fileURLToPath(new URL("../../", import.meta.url)); // dist/
    const names = ["reference/agent.js", "reference/model-agent.js", "reference/environment.js", "reference/contract.js", "src/sdk/peer.js", "src/sdk/models.js"];
    const runtime = new Map<string, Buffer>(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(source, name))] as const)));
    runtime.set("package.json", jsonBytes({ private: true, type: "module", engines: { node: "24.15.0" } }));
    const artifact = { schemaVersion: "trial-runner/artifact/v1", files: [...runtime].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    const limits = { prepareMs: 60000, trialMs: 120000, stopGraceMs: 500, snapshotMs: 15000, cleanupMs: 15000, maxTurns: 20, maxFrameBytes: 1048576, maxEvents: 10000, maxRecordedBytes: 67108864 };
    const plan: Plan = {
      schemaVersion: "trial-runner/plan/v1", id: "inventory-reference",
      agent: { adapterId: "reference.agent", adapterVersion: "0.1.0", argv: ["node", "reference/agent.js"], cwd: ".", artifactManifest: "agent-artifact.json", capabilities: ["scripted-turns", "routed-tools", "conversation-events"], settingsSchema: "agent-settings.schema.json", settings: { variant: "normal" } },
      environment: { adapterId: "reference.inventory", adapterVersion: "0.1.0", argv: ["node", "reference/environment.js"], cwd: ".", artifactManifest: "environment-artifact.json", capabilities: ["fresh-lease", "state-snapshot", "routed-tools", "verified-cleanup"], settingsSchema: "environment-settings.schema.json", settings: { prepareFailure: false, missingSnapshot: false, cleanupFailure: false }, initialState: "fixture.json", fixtureSchema: "fixture.schema.json", toolSchemas: "tools.json", clock: { mode: "frozen", instant: "2026-01-01T00:00:00Z" }, faultPlan: [] },
      scenarios: [{ path: "scenario.json" }], repetitions: 2, limits, evidenceProfile: "profile.json", capturePolicy: { content: "local", externalExport: "explicit" }, secretBindings: [],
    };
    const scenario: Scenario = { schemaVersion: "trial-runner/scenario/v1", id: "reserve-and-follow-up", description: "Exercise one reservation and a follow-up against fresh inventory",
      messages: [{ id: "reserve", role: "user", content: "Reserve one unit." }, { id: "follow-up", role: "user", content: "Show my reservation and remaining stock." }],
      provenance: { origin: "independent-reference", exposure: "runner-development" }, externalCriterionRefs: [] };
    const profile: Profile = { schemaVersion: "trial-runner/evidence-profile/v1", id: "reference-stateful", captureBoundary: "Scripted process conversation and runner-routed local inventory tools",
      required: { conversation: true, routedToolEvents: true, initialState: true, finalState: true, stableFinalState: true, localArtifactIdentity: true, terminalOperationAccounting: true },
      modelCapture: "not_applicable", modelCaptureReason: "This independent scripted reference makes no model calls",
      terminalRules: { not_started: "incomplete", finished: "require_all_declared_observations", agent_error: "require_error_event_and_all_declared_observations", timed_out: "require_timeout_event_and_all_declared_observations", cancelled: "require_cancellation_event_and_all_declared_observations", infrastructure_error: "incomplete" } };
    if (example === "model-accounting") {
      plan.agent.adapterId = "reference.model-agent"; plan.agent.argv[1] = "reference/model-agent.js";
      plan.agent.capabilities.push("model-accounted");
      profile.modelCapture = "accounted"; profile.required.modelUsage = true;
      profile.captureBoundary = "Synthetic local model callback attempts and runner-routed inventory tools";
      profile.modelCaptureReason = "Every local synthetic callback attempt is recorded; no real provider or hidden SDK retries";
    }
    const configuration = { "plan.json": plan, "scenario.json": scenario, "profile.json": profile, "fixture.json": { available: 3, reservations: [] }, "fixture.schema.json": fixtureSchema,
      "tools.json": tools, "agent-settings.schema.json": agentSettingsSchema, "environment-settings.schema.json": environmentSettingsSchema, "agent-artifact.json": artifact, "environment-artifact.json": artifact };
    for (const [name, value] of Object.entries(configuration)) runtime.set(name, jsonBytes(value));
    return runtime;
}

/** Copies only our shipped reference files; never inspects a customer repository. */
export async function initExample(directory: string, example: "inventory" | "model-accounting" = "inventory"): Promise<string> {
  const runtime = await exampleFiles(example);
  const root = path.resolve(directory);
  await fs.mkdir(root, { mode: 0o700 });
  try {
    for (const [name, bytes] of runtime) await writeAtomic(path.join(root, name), bytes);
    return path.join(root, "plan.json");
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}
