import { isDeepStrictEqual } from "node:util";
import { contract, assertUnique, safeRelative, snapshotContract } from "./validate.js";
import { parseJson } from "./strict-json.js";
import { verifyEvents } from "./events.js";
import { modelGaps, providerSummary } from "./models.js";
import { safeFile, fileInventory, hash } from "../core/files.js";
import { validatePlanInputs } from "../core/plan.js";
import { verifyObservations } from "./observations.js";
import type { Event, Manifest, Scenario, Snapshot } from "./types.js";

/** Policy-free requirements. Missing observations remain attributable to their source. */
export function requiredGaps(manifest: Pick<Manifest, "execution" | "evidence">, events: Event[], scenario: Scenario,
  initial: Snapshot | null, final: Snapshot | null): string[] {
  const gaps: string[] = [];
  const profile = manifest.evidence.profile;
  const req = profile.required;
  if (manifest.execution === "not_started") gaps.push("candidate_not_started");
  if (["environment_error", "adapter_error", "protocol_error", "runner_error"].includes(manifest.execution)) gaps.push("infrastructure_error");
  if (req.initialState && !initial) gaps.push("initial_state_missing");
  if (req.finalState && !final) gaps.push("final_state_missing");
  if (req.stableFinalState && (!final?.stable || final.pendingOperations.length > 0)) gaps.push("final_state_not_stable");
  if (req.conversation) {
    const user = events.filter(e => e.kind === "user.turn");
    if (user.some((e, i) => e.turnId !== scenario.messages[i]?.id || e.payload.content !== scenario.messages[i]?.content)) gaps.push("scenario_conversation_mismatch");
    if (manifest.execution === "finished" && (user.length !== scenario.messages.length || events.filter(e => e.kind === "assistant.turn").length !== scenario.messages.length)) gaps.push("conversation_incomplete");
  }
  if (manifest.execution === "agent_error" && !events.some(e => e.kind === "agent.error")) gaps.push("agent_error_not_observed");
  for (const terminal of ["timed_out", "cancelled"] as const) {
    if (manifest.execution === terminal && !events.some(e => e.kind === "runtime.error" && e.payload.execution === terminal)) gaps.push(`${terminal}_not_observed`);
  }
  gaps.push(...modelGaps(profile, events));
  if (manifest.evidence.redactedPaths.length) gaps.push("required_content_redacted");
  for (const event of events) if (event.kind === "capture.gap") gaps.push(String(event.payload.reason));
  return [...new Set(gaps)].sort();
}

export async function verifyBundle(root: string, expectedDigest?: string): Promise<{ digest: string; manifest: Manifest }> {
  const bytes = await safeFile(root, "manifest.json", 8 * 1024 * 1024);
  const digest = hash(bytes);
  if (expectedDigest && digest !== expectedDigest) throw new Error("Bundle identity mismatch");
  const manifest = contract<Manifest>("manifest", parseJson(bytes, 8 * 1024 * 1024));
  const paths = manifest.files.map(file => file.path);
  paths.forEach(p => safeRelative(p)); assertUnique(paths, "evidence path");
  if (!isDeepStrictEqual(paths, [...paths].sort()) || paths.includes("manifest.json")) throw new Error("Invalid evidence inventory ordering");
  if (!isDeepStrictEqual(await fileInventory(root), [...paths, "manifest.json"].sort())) throw new Error("Unlisted or missing evidence file");
  for (const file of manifest.files) {
    const content = await safeFile(root, file.path);
    if (content.length !== file.bytes || hash(content) !== file.sha256) throw new Error("Evidence file digest mismatch");
  }
  for (const required of ["plan.json", "scenario.json", "fixture.json", "profile.json", "events.ndjson", "agent-artifact.json", "environment-artifact.json"]) {
    if (!paths.includes(required)) throw new Error(`Missing required artifact: ${required}`);
  }
  const plan = await safeFile(root, "plan.json");
  const scenarioBytes = await safeFile(root, "scenario.json");
  if (hash(plan) !== manifest.planSha256 || hash(scenarioBytes) !== manifest.scenarioSha256 || hash(await safeFile(root, "fixture.json")) !== manifest.fixtureSha256) throw new Error("Input identity mismatch");
  const retainedInputs = manifest.files.filter(file => file.path.startsWith("inputs/"));
  if (retainedInputs.length > 900 || retainedInputs.reduce((sum, file) => sum + file.bytes, 0) > 64 * 1024 * 1024) throw new Error("Resolved input limit exceeded");
  const input = async (name: string, max = 2 * 1024 * 1024): Promise<Buffer> => {
    safeRelative(name);
    if (!paths.includes(`inputs/${name}`)) throw new Error("Missing declared input");
    return safeFile(root, `inputs/${name}`, max);
  };
  const resolved = await validatePlanInputs(plan, input);
  const declaredPlan = resolved.plan;
  const payloadFiles = ["events.ndjson", "initial-state.json", "final-state.json", "environment-described.json", "environment-prepared.json", "agent-ready.json", "agent-stopped.json", "environment-disposed.json"];
  if (manifest.files.filter(file => payloadFiles.includes(file.path)).reduce((sum, file) => sum + file.bytes, 0) > declaredPlan.limits.maxRecordedBytes) throw new Error("Recorded payload exceeds declared byte limit");
  if (manifest.repetition >= declaredPlan.repetitions) throw new Error("Repetition outside declared plan");
  for (const role of ["agent", "environment"] as const) {
    const artifactBytes = await safeFile(root, `${role}-artifact.json`);
    if (!artifactBytes.equals(resolved.artifacts[role].bytes)) throw new Error("Plan adapter artifact reference mismatch");
    if (hash(artifactBytes) !== manifest.identity[`${role}ArtifactSha256`]) throw new Error("Adapter artifact identity mismatch");
  }
  const scenario = contract<Scenario>("scenario", parseJson(scenarioBytes));
  const profile = resolved.profile;
  if (!Buffer.from(await safeFile(root, "profile.json")).equals(await input(declaredPlan.evidenceProfile))) throw new Error("Plan profile reference mismatch");
  const selected = resolved.scenarios.find(item => item.bytes.equals(scenarioBytes));
  if (!selected) throw new Error("Scenario is not in declared plan");
  if (!(await safeFile(root, "fixture.json")).equals(selected.fixtureBytes)) throw new Error("Scenario fixture reference mismatch");
  if (scenario.id !== manifest.scenarioId || !isDeepStrictEqual(profile, manifest.evidence.profile)) throw new Error("Scenario or profile identity mismatch");
  const log = new TextDecoder("utf-8", { fatal: true }).decode(await safeFile(root, "events.ndjson"));
  if (!log.endsWith("\n")) throw new Error("Truncated event log");
  const replay = verifyEvents(log.slice(0, -1).split("\n").map(line => parseJson(line)), manifest.runId, manifest.trialId);
  if (replay.events.length > declaredPlan.limits.maxEvents) throw new Error("Journal exceeds declared event limit");
  if (!isDeepStrictEqual(replay.operations, manifest.operations)) throw new Error("Operation summary mismatch");
  if (!isDeepStrictEqual(providerSummary(replay.events), manifest.provider)) throw new Error("Provider summary differs from recorded model observations");
  if (replay.events[0]?.payload.scenarioId !== manifest.scenarioId || replay.events[0]?.payload.repetition !== manifest.repetition || replay.events.at(-1)?.payload.execution !== manifest.execution || replay.events.at(-1)?.payload.reason !== manifest.reason) throw new Error("Terminal or scenario identity mismatch");
  const initial = paths.includes("initial-state.json") ? snapshotContract(parseJson(await safeFile(root, "initial-state.json"))) : null;
  const final = paths.includes("final-state.json") ? snapshotContract(parseJson(await safeFile(root, "final-state.json"))) : null;
  for (const [name, snapshot] of [["initial-state.json", initial], ["final-state.json", final]] as const) {
    if (snapshot && !manifest.evidence.redactedPaths.includes(name) && !resolved.fixtureValidator(snapshot.state)) throw new Error("Snapshot state violates pinned fixture schema");
  }
  const toolNames = new Map<string, string>();
  const redactedEvents = manifest.evidence.redactedPaths.includes("events.ndjson");
  for (const event of replay.events) {
    if (event.kind === "operation.dispatch_intent" && event.payload.boundary === "tool") {
      const name = String(event.payload.name), validate = resolved.toolInputs.get(name);
      if (!validate) throw new Error("Tool is not declared in pinned environment");
      if (!redactedEvents && !validate(event.payload.args)) throw new Error("Tool arguments violate pinned schema");
      toolNames.set(event.operationId!, name);
    } else if (event.kind === "operation.finished" && event.payload.outcome === "known_result" && toolNames.has(event.operationId!)) {
      if (!redactedEvents && !resolved.toolOutputs.get(toolNames.get(event.operationId!)!)!(event.payload.value)) throw new Error("Tool result violates pinned schema");
    }
  }
  await verifyObservations(manifest, resolved, replay.events, initial, name => safeFile(root, name));
  const gaps = requiredGaps(manifest, replay.events, scenario, initial, final);
  for (const gap of gaps) if (!manifest.evidence.gaps.includes(gap)) throw new Error(`Undeclared evidence gap: ${gap}`);
  if ((manifest.evidence.gaps.length === 0) !== (manifest.evidence.state === "complete")) throw new Error("Completeness contradicts evidence gaps");
  if (manifest.fidelity.boundary !== profile.captureBoundary || manifest.fidelity.modelCoverage !== profile.modelCapture) throw new Error("Capture boundary mismatch");
  return { digest, manifest };
}
