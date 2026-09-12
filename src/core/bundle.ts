import * as path from "node:path";
import type { Cleanup, Execution, Manifest, Snapshot } from "../contracts/types.js";
import { verifyEvents } from "../contracts/events.js";
import { providerSummary } from "../contracts/models.js";
import { requiredGaps, verifyBundle } from "../contracts/verify.js";
import { hash, jsonBytes, writeAtomic } from "./files.js";
import type { ResolvedPlan } from "./plan.js";
import type { Journal } from "./journal.js";

export async function finalizeBundle(root: string, resolved: ResolvedPlan, selected: ResolvedPlan["scenarios"][number], journal: Journal,
  terminal: { requestId: string; execution: Execution; reason: string | null; cleanup: Cleanup; repetition: number; initial: Snapshot | null; final: Snapshot | null; extraGaps: string[]; observations: Map<string, Buffer> }): Promise<{ digest: string; manifest: Manifest }> {
  const files = new Map<string, Buffer>([
    ["plan.json", resolved.planBytes], ["scenario.json", selected.bytes], ["fixture.json", selected.fixtureBytes],
    ["profile.json", resolved.files.get(resolved.plan.evidenceProfile)!], ["agent-artifact.json", resolved.artifacts.agent.bytes], ["environment-artifact.json", resolved.artifacts.environment.bytes],
  ]);
  // Store exact declared inputs so a consumer can verify and independently resolve them.
  for (const [name, bytes] of resolved.files) files.set(`inputs/${name}`, bytes);
  if (terminal.initial) files.set("initial-state.json", jsonBytes(terminal.initial));
  if (terminal.final) files.set("final-state.json", jsonBytes(terminal.final));
  for (const [name, bytes] of terminal.observations) files.set(name, bytes);
  for (const [name, bytes] of files) if (!journal.attachments.has(name)) await writeAtomic(path.join(root, name), bytes);
  for (const [name, bytes] of journal.attachments) files.set(name, bytes);
  const eventBytes = Buffer.from(journal.events.map(event => JSON.stringify(event)).join("\n") + "\n");
  files.set("events.ndjson", eventBytes); // Already durably written by the journal.
  const manifest: Manifest = {
    schemaVersion: "trial-runner/evidence/v1", runId: journal.runId, requestId: terminal.requestId, trialId: journal.trialId,
    scenarioId: selected.scenario.id, repetition: terminal.repetition, planSha256: hash(resolved.planBytes), scenarioSha256: hash(selected.bytes), fixtureSha256: hash(selected.fixtureBytes),
    execution: terminal.execution, reason: terminal.reason, cleanup: terminal.cleanup,
    evidence: { state: "incomplete", gaps: [], profile: resolved.profile, redactedPaths: [...journal.redactedPaths].sort() },
    identity: { runnerVersion: "0.1.0", nodeVersion: process.versions.node, agentArtifactSha256: hash(resolved.artifacts.agent.bytes), environmentArtifactSha256: hash(resolved.artifacts.environment.bytes), strength: "observed_local_artifacts", authenticity: "not_attested" },
    fidelity: { boundary: resolved.profile.captureBoundary, mode: "operator_trusted_local", modelCoverage: resolved.profile.modelCapture },
    provider: providerSummary(journal.events),
    operations: verifyEvents(journal.events, journal.runId, journal.trialId).operations,
    files: [...files].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), parentBundleSha256: null,
  };
  manifest.evidence.gaps = [...new Set([...requiredGaps(manifest, journal.events, selected.scenario, terminal.initial, terminal.final), ...terminal.extraGaps])].sort();
  manifest.evidence.state = manifest.evidence.gaps.length ? "incomplete" : "complete";
  journal.mask.assertPublic(manifest);
  await writeAtomic(path.join(root, "manifest.json"), jsonBytes(manifest));
  return verifyBundle(root);
}
