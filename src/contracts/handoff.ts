import { isDeepStrictEqual } from "node:util";
import { contract, assertUnique, safeRelative } from "./validate.js";
import type { AssessmentInput, Manifest, Plan, RunIndex, Scenario } from "./types.js";

export function verifyRunIndex(value: unknown, plan: Plan, scenarioIds: string[]): RunIndex {
  const index = verifyRunState(value);
  const slots = scenarioIds.flatMap(scenarioId => Array.from({ length: plan.repetitions }, (_, repetition) => ({ scenarioId, repetition })));
  if (index.trials.length !== slots.length) throw new Error("Requested trial coverage mismatch");
  index.trials.forEach((trial, i) => {
    if (trial.scenarioId !== slots[i]!.scenarioId || trial.repetition !== slots[i]!.repetition) throw new Error("Trial slot identity mismatch");
  });
  return index;
}

export function verifyRunState(value: unknown): RunIndex {
  const index = contract<RunIndex>("run", value);
  if (!Number.isFinite(Date.parse(index.createdAt)) || (index.deadlineAt !== null && !Number.isFinite(Date.parse(index.deadlineAt)))) throw new Error("Invalid run timestamp");
  assertUnique(index.trials.map(t => t.trialId), "trial ID");
  assertUnique(index.trials.map(t => t.path), "trial path");
  index.trials.forEach(trial => {
    safeRelative(trial.path);
    if (index.state === "finished" && trial.bundleSha256 === null) throw new Error("Finalized run is missing a trial bundle");
  });
  if (index.state === "accepted" && (index.finishedAt !== null || index.exitCode !== null)) throw new Error("Accepted run has terminal metadata");
  if (index.state === "finished" && (index.finishedAt === null || !Number.isFinite(Date.parse(index.finishedAt)) || index.exitCode === null || index.exitCode === 1)) throw new Error("Invalid finalized run metadata");
  if (index.exitCode === 0 && index.trials.some(t => t.execution !== "finished")) throw new Error("Successful run has unfinished trials");
  return index;
}

export function assessmentInput(manifest: Manifest, digest: string, scenario: Scenario): AssessmentInput {
  const roles: [AssessmentInput["inputs"][number]["role"], string][] = [
    ["conversation", "events.ndjson"], ["tool-trajectory", "events.ndjson"], ["runtime-events", "events.ndjson"],
    ["initial-state", "initial-state.json"], ["final-state", "final-state.json"],
  ];
  return {
    schemaVersion: "trial-runner/assessment-input/v1", bundleSha256: digest, trialId: manifest.trialId, scenarioId: manifest.scenarioId,
    repetition: manifest.repetition, candidateArtifactSha256: manifest.identity.agentArtifactSha256, evidenceState: manifest.evidence.state,
    boundary: manifest.fidelity.boundary, authenticity: "not_attested",
    inputs: roles.flatMap(([role, name]) => { const file = manifest.files.find(f => f.path === name); return file ? [{ role, path: name, sha256: file.sha256 }] : []; }),
    gaps: [...manifest.evidence.gaps], externalCriterionRefs: [...scenario.externalCriterionRefs],
  };
}

/** Source bundle must already have passed verifyBundle; mapping cannot upgrade it. */
export function verifyAssessmentInput(value: unknown, manifest: Manifest, digest: string, scenario: Scenario): AssessmentInput {
  const input = contract<AssessmentInput>("assessment", value);
  if (!isDeepStrictEqual(input, assessmentInput(manifest, digest, scenario))) throw new Error("Assessment mapping differs from verified source");
  return input;
}
