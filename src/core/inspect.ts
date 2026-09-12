import * as path from "node:path";
import { contract, assertUnique, safeRelative } from "../contracts/validate.js";
import { inspectEventPrefix } from "../contracts/events.js";
import { verifyBundle } from "../contracts/verify.js";
import { verifyInspection } from "../contracts/inspection.js";
import { parseJson } from "../contracts/strict-json.js";
import type { Execution, RunIndex, RunInspection, TrialInspection } from "../contracts/types.js";
import { hash, safeFile } from "./files.js";
import { verifyAcceptance } from "./acceptance.js";

/** Read-only inspection. Neither missing observations nor a PID authorize recovery. */
export async function inspectRun(root: string, index: RunIndex, acceptanceSha256: string | null = null): Promise<RunInspection> {
  contract("run", index);
  if (acceptanceSha256) await verifyAcceptance(root, index, acceptanceSha256);
  assertUnique(index.trials.map(trial => trial.trialId), "trial ID");
  assertUnique(index.trials.map(trial => trial.path), "trial path");
  const trials: TrialInspection[] = [];
  for (const slot of index.trials) {
    safeRelative(slot.path);
    const result: TrialInspection = { trialId: slot.trialId, scenarioId: slot.scenarioId, repetition: slot.repetition,
      state: "not_observed", indexExecution: slot.execution, terminalExecution: null,
      journal: { completeEvents: 0, completeBytes: 0, trailingBytes: 0, sha256: null },
      bundle: { sha256: slot.bundleSha256, verified: false }, operations: [], gaps: [] };
    const trialRoot = path.join(root, slot.path);
    const readJournal = (bytes: Buffer): void => {
      const end = bytes.lastIndexOf(10) + 1;
      result.journal = { completeEvents: 0, completeBytes: end, trailingBytes: bytes.length - end, sha256: hash(bytes) };
      const lines = end === 0 ? [] : new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)).slice(0, -1).split("\n");
      if (lines.length > 100000) throw new Error("Journal event-count limit exceeded");
      const replay = inspectEventPrefix(lines.map(line => parseJson(line)), index.runId, slot.trialId);
      if (replay.events.length && (replay.events[0]!.payload.scenarioId !== slot.scenarioId || replay.events[0]!.payload.repetition !== slot.repetition)) throw new Error("Trial slot identity mismatch");
      result.journal.completeEvents = replay.events.length;
      const last = replay.events.at(-1);
      result.terminalExecution = last?.kind === "trial.terminal" ? last.payload.execution as Execution : null;
      result.state = "unfinished";
      result.operations = replay.operations.map(op => ({ id: op.id, logicalCallId: op.logicalCallId, boundary: op.boundary, owner: op.owner,
        dispatch: op.observed ? "observed" : op.outcome === "not_dispatched" ? "not_dispatched" : "unknown",
        recordedOutcome: op.outcome, outcome: op.outcome ?? "outcome_unknown" }));
      if (result.journal.trailingBytes) result.gaps.push("partial_journal_tail");
      if (result.terminalExecution === null) result.gaps.push("terminal_observation_missing");
      if (replay.operations.some(op => op.outcome === null)) result.gaps.push("operation_outcome_unrecorded");
      for (const event of replay.events) if (event.kind === "capture.gap") result.gaps.push(String(event.payload.reason));
    };
    try {
      // At most one bounded trial is loaded at a time; a concurrent append is just a prefix.
      const bytes = await safeFile(root, `${slot.path}/events.ndjson`, 64 * 1024 * 1024);
      readJournal(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") result.gaps.push("journal_not_observed");
      else { result.state = "invalid"; result.gaps.push("journal_invalid_or_unreadable"); }
    }
    let manifestObserved = false;
    try {
      // Detect a published manifest even if the enclosing index update was interrupted.
      await safeFile(root, `${slot.path}/manifest.json`, 8 * 1024 * 1024);
      manifestObserved = true;
      const verified = await verifyBundle(trialRoot, slot.bundleSha256 ?? undefined);
      const manifest = verified.manifest;
      if (manifest.runId !== index.runId || manifest.requestId !== index.requestId || manifest.trialId !== slot.trialId || manifest.scenarioId !== slot.scenarioId || manifest.repetition !== slot.repetition) throw new Error("Bundle slot identity mismatch");
      if (slot.bundleSha256 !== null && slot.execution !== manifest.execution) throw new Error("Index execution mismatch");
      const log = await safeFile(root, `${slot.path}/events.ndjson`);
      if (hash(log) !== manifest.files.find(file => file.path === "events.ndjson")!.sha256) throw new Error("Journal changed during inspection");
      readJournal(log);
      result.bundle = { sha256: verified.digest, verified: true };
      result.state = "finalized"; result.terminalExecution = manifest.execution;
      result.gaps = [...manifest.evidence.gaps];
      if (slot.bundleSha256 === null) result.gaps.push("index_update_missing");
    } catch (error) {
      if (!manifestObserved && (error as NodeJS.ErrnoException).code === "ENOENT" && slot.bundleSha256 === null) result.gaps.push("bundle_not_finalized");
      else { result.state = "invalid"; result.gaps.push("bundle_invalid_or_missing"); }
    }
    if (index.state === "finished" && result.state !== "finalized") { result.state = "invalid"; result.gaps.push("finalized_run_missing_evidence"); }
    result.gaps = [...new Set(result.gaps)].sort();
    trials.push(result);
  }
  return verifyInspection({ schemaVersion: "trial-runner/inspection/v1", runId: index.runId,
    requestId: index.requestId, runState: index.state, coverage: acceptanceSha256 ? "anchored" : "unverified", liveness: "not_checked", executionResumed: false, trials });
}
