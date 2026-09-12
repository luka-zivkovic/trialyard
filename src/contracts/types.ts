export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Execution = "not_started" | "finished" | "agent_error" | "timed_out" | "cancelled" | "environment_error" | "adapter_error" | "protocol_error" | "runner_error";
export type Cleanup = "succeeded" | "failed" | "unknown";
export type Source = "runner_observed" | "adapter_reported" | "environment_observed" | "candidate_claim";
export type Outcome = "known_result" | "known_failure" | "outcome_unknown" | "not_dispatched";
export interface Limits {
  prepareMs: number; trialMs: number; stopGraceMs: number; snapshotMs: number; cleanupMs: number;
  maxTurns: number; maxFrameBytes: number; maxEvents: number; maxRecordedBytes: number;
}
export interface Adapter {
  adapterId: string; adapterVersion: string; argv: string[]; cwd: string; artifactManifest: string;
  capabilities: string[]; settingsSchema: string; settings: Record<string, Json>;
}
export interface Fault { tool: string; invocation: number; mode: "error_before" | "lost_after" | "hang"; }
export interface Environment extends Adapter {
  initialState: string; fixtureSchema: string; toolSchemas: string;
  clock: { mode: "frozen" | "real"; instant: string | null }; faultPlan: Fault[];
}
export interface Plan {
  schemaVersion: "trial-runner/plan/v1"; id: string; agent: Adapter; environment: Environment;
  scenarios: { path: string }[]; repetitions: number; limits: Limits; evidenceProfile: string;
  capturePolicy: { content: "local"; externalExport: "explicit" };
  secretBindings: { name: string; recipient: "agent" | "environment" }[];
}
export interface Scenario {
  schemaVersion: "trial-runner/scenario/v1"; id: string; description: string; fixture?: string;
  messages: { id: string; role: "user"; content: string }[];
  provenance: { origin: string; exposure: string }; externalCriterionRefs: string[];
}
export interface Profile {
  schemaVersion: "trial-runner/evidence-profile/v1"; id: string; captureBoundary: string;
  required: { conversation: boolean; routedToolEvents: boolean; initialState: boolean; finalState: boolean;
    stableFinalState: boolean; localArtifactIdentity: boolean; terminalOperationAccounting: boolean; modelUsage?: boolean };
  modelCapture: "not_applicable" | "reported" | "accounted"; modelCaptureReason: string;
  terminalRules: { not_started: "incomplete"; finished: "require_all_declared_observations";
    agent_error: "require_error_event_and_all_declared_observations";
    timed_out: "require_timeout_event_and_all_declared_observations";
    cancelled: "require_cancellation_event_and_all_declared_observations"; infrastructure_error: "incomplete" };
}
export interface FileRecord { path: string; bytes: number; sha256: string; }
export interface Artifact { schemaVersion: "trial-runner/artifact/v1"; files: FileRecord[]; }
export interface ToolDefinition { name: string; input: Record<string, Json>; output: Record<string, Json>; }
export interface Snapshot { state: Json; stable: boolean; pendingOperations: string[]; observedAt: string; }
export interface Event {
  schemaVersion: "trial-runner/event/v1"; sequence: number; recordedAt: string; producerTimestamp: string | null;
  runId: string; trialId: string; turnId: string | null; operationId: string | null; logicalCallId: string | null;
  parentOperationId: string | null; source: Source;
  kind: "trial.started" | "trial.terminal" | "user.turn" | "assistant.turn" | "agent.error" | "runtime.error" |
    "operation.dispatch_intent" | "operation.dispatch_observed" | "operation.finished" | "capture.gap" | "diagnostic";
  payload: Record<string, Json>;
}
export interface Frame {
  protocol: "trial-runner/process/v1"; kind: string; trialId: string; messageId: string;
  replyTo?: string; payload: Record<string, Json>;
}
export interface Operation {
  id: string; logicalCallId: string | null; boundary: "tool" | "model"; owner: "runner" | "agent" | "environment";
  observed: boolean; outcome: Outcome | null;
}
export interface ModelRequest { provider: string; model: string; settings: Record<string, Json>; input: Json; }
export interface ModelObservation {
  provider: string | null; model: string | null; modelRevision: string | null; requestId: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; source: "provider_reported" | "adapter_estimated" } | null;
  cost: { amount: number | null; currency: string; source: "provider_reported" | "adapter_estimated"; pricingId: string } | null;
}
export interface Manifest {
  schemaVersion: "trial-runner/evidence/v1"; runId: string; requestId: string; trialId: string;
  scenarioId: string; repetition: number; planSha256: string; scenarioSha256: string; fixtureSha256: string;
  execution: Execution; reason: string | null; cleanup: Cleanup;
  evidence: { state: "complete" | "incomplete"; gaps: string[]; profile: Profile; redactedPaths: string[] };
  identity: { runnerVersion: string; nodeVersion: string; agentArtifactSha256: string; environmentArtifactSha256: string;
    strength: "observed_local_artifacts"; authenticity: "not_attested" };
  fidelity: { boundary: string; mode: "operator_trusted_local"; modelCoverage: Profile["modelCapture"] };
  provider: { requested: Json; observed: Json; usage: Json; cost: Json };
  operations: Operation[]; files: FileRecord[];
  parentBundleSha256: string | null;
}
export interface RunIndex {
  schemaVersion: "trial-runner/run/v1"; runId: string; requestId: string; inputSha256: string;
  state: "accepted" | "finished"; createdAt: string; finishedAt: string | null; rerunOf: string | null;
  deadlineAt: string | null; exitCode: number | null;
  trials: { trialId: string; scenarioId: string; repetition: number; execution: Execution;
    bundleSha256: string | null; path: string }[];
}
export interface AssessmentInput {
  schemaVersion: "trial-runner/assessment-input/v1"; bundleSha256: string; trialId: string;
  scenarioId: string; repetition: number; candidateArtifactSha256: string; evidenceState: "complete" | "incomplete";
  boundary: string; authenticity: "not_attested"; inputs: { role: string; path: string; sha256: string }[];
  gaps: string[]; externalCriterionRefs: string[];
}
export interface TrialInspection {
  trialId: string; scenarioId: string; repetition: number;
  state: "not_observed" | "unfinished" | "finalized" | "invalid";
  indexExecution: Execution; terminalExecution: Execution | null;
  journal: { completeEvents: number; completeBytes: number; trailingBytes: number; sha256: string | null };
  bundle: { sha256: string | null; verified: boolean };
  operations: { id: string; logicalCallId: string | null; boundary: Operation["boundary"]; owner: Operation["owner"];
    dispatch: "observed" | "not_dispatched" | "unknown"; recordedOutcome: Outcome | null; outcome: Outcome }[];
  gaps: string[];
}
export interface RunInspection {
  coverage: "anchored" | "unverified";
  schemaVersion: "trial-runner/inspection/v1"; runId: string; requestId: string;
  runState: RunIndex["state"]; liveness: "not_checked"; executionResumed: false; trials: TrialInspection[];
}

export interface RedactionPolicy { schemaVersion: "trial-runner/redaction/v1"; omitFiles: string[]; }
export interface RedactedManifest {
  schemaVersion: "trial-runner/redacted-evidence/v1"; parentBundleSha256: string;
  runId: string; requestId: string; trialId: string; scenarioId: string; repetition: number;
  execution: Execution; cleanup: Cleanup; authenticity: "not_attested";
  evidence: { state: "incomplete"; gaps: string[]; redactedPaths: string[] };
  files: FileRecord[];
}
