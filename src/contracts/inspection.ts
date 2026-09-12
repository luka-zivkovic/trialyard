import { contract, assertUnique } from "./validate.js";
import type { RunInspection } from "./types.js";

export function verifyInspection(value: unknown): RunInspection {
  const result = contract<RunInspection>("inspection", value);
  assertUnique(result.trials.map(trial => trial.trialId), "inspection trial ID");
  for (const trial of result.trials) {
    assertUnique(trial.operations.map(operation => operation.id), "inspection operation ID");
    if ((trial.state === "finalized") !== trial.bundle.verified) throw new Error("Inspection finalization contradicts verified evidence");
    if (trial.bundle.verified && (trial.bundle.sha256 === null || trial.terminalExecution === null)) throw new Error("Finalized inspection lacks source identity");
    if (trial.state === "finalized" && (trial.journal.sha256 === null || trial.journal.completeEvents < 2 || trial.journal.completeBytes === 0 || trial.journal.trailingBytes !== 0 || trial.operations.some(op => op.recordedOutcome === null))) throw new Error("Finalized inspection lacks a closed journal");
    for (const operation of trial.operations) {
      if (operation.outcome !== (operation.recordedOutcome ?? "outcome_unknown")) throw new Error("Inspection invented an operation outcome");
      if ((operation.dispatch === "not_dispatched") !== (operation.recordedOutcome === "not_dispatched")) throw new Error("Inspection invented non-dispatch");
      if (["known_result", "known_failure"].includes(operation.outcome) && operation.dispatch !== "observed") throw new Error("Known outcome lacks observed dispatch");
    }
  }
  return result;
}
