import { contract } from "./validate.js";
import { modelObservation, modelRequest, verifyModelTurn } from "./models.js";
import type { Event, Operation } from "./types.js";

/** Consumer-side replay of the public event contract; does not trust manifest summaries. */
export function verifyEvents(input: unknown[], runId: string, trialId: string): { events: Event[]; operations: Operation[]; turns: string[] } {
  return replay(input, runId, trialId, true);
}

/** Checks every recorded invariant without inventing closure for an unfinished log. */
export function inspectEventPrefix(input: unknown[], runId: string, trialId: string): { events: Event[]; operations: Operation[]; turns: string[] } {
  return replay(input, runId, trialId, false);
}

function replay(input: unknown[], runId: string, trialId: string, requireTerminal: boolean): { events: Event[]; operations: Operation[]; turns: string[] } {
  const operations = new Map<string, Operation>();
  const seenTurns = new Set<string>();
  const completed: string[] = [];
  const correlations = new Map<string, { turnId: string; parent: string | null }>();
  let activeTurn: string | null = null;
  let stopping = false;
  const events = input.map((entry, index) => {
    const event = contract<Event>("event", entry);
    if (event.sequence !== index || event.runId !== runId || event.trialId !== trialId) throw new Error("Event identity or order mismatch");
    if (index === 0 && event.kind !== "trial.started") throw new Error("Missing trial start");
    if (event.kind === "trial.started" && index !== 0) throw new Error("Duplicate trial start");
    if (event.kind === "trial.terminal" && index !== input.length - 1) throw new Error("Events after terminal state");
    if (!Number.isFinite(Date.parse(event.recordedAt))) throw new Error("Invalid event timestamp");
    if (event.producerTimestamp !== null && !Number.isFinite(Date.parse(event.producerTimestamp))) throw new Error("Invalid producer timestamp");
    const sources: Partial<Record<Event["kind"], Event["source"][]>> = {
      "trial.started": ["runner_observed"], "trial.terminal": ["runner_observed"], "user.turn": ["runner_observed"],
      "assistant.turn": ["candidate_claim"], "agent.error": ["runner_observed", "adapter_reported"],
      "runtime.error": ["runner_observed"], "capture.gap": ["runner_observed"], "diagnostic": ["runner_observed"],
    };
    if (sources[event.kind] && !sources[event.kind]!.includes(event.source)) throw new Error("Invalid event source");
    if (!event.kind.startsWith("operation.") && (event.operationId !== null || event.logicalCallId !== null || event.parentOperationId !== null)) throw new Error("Unexpected operation correlation");
    if ((event.kind === "trial.started" || event.kind === "trial.terminal") && event.turnId !== null) throw new Error("Unexpected trial turn correlation");
    if (event.kind === "user.turn") {
      if (stopping) throw new Error("New turn after terminal cause");
      if (!event.turnId || activeTurn || seenTurns.has(event.turnId)) throw new Error("Invalid user turn ordering");
      activeTurn = event.turnId; seenTurns.add(activeTurn);
    }
    if (event.kind === "assistant.turn") {
      if (!event.turnId || event.turnId !== activeTurn) throw new Error("Unpaired assistant turn");
      if ([...operations.values()].some(op => op.outcome === null)) throw new Error("Turn finished with open operation");
      verifyModelTurn(event.payload.modelOperations, [...operations.values()].filter(op => op.boundary === "model" && correlations.get(op.id)!.turnId === event.turnId).map(op => op.id));
      completed.push(event.turnId); activeTurn = null;
    }
    if (event.kind.startsWith("operation.")) {
      if (!event.operationId) throw new Error("Missing operation ID");
      if (event.kind === "operation.dispatch_intent") {
        if (stopping) throw new Error("New dispatch after terminal cause");
        if (operations.has(event.operationId)) throw new Error("Duplicate operation accounting");
        if (!activeTurn || event.turnId !== activeTurn) throw new Error("Operation outside active turn");
        if (event.parentOperationId && (!operations.has(event.parentOperationId) || operations.get(event.parentOperationId)!.outcome !== null)) throw new Error("Unknown or closed parent operation");
        const owner = event.payload.owner as Operation["owner"];
        if (event.payload.boundary === "model") {
          if (owner !== "agent" || modelRequest(event.payload.args).model !== event.payload.name) throw new Error("Invalid model accounting boundary");
          if (event.parentOperationId && (operations.get(event.parentOperationId)?.owner !== "agent" || operations.get(event.parentOperationId)?.boundary !== "model")) throw new Error("Invalid model parent boundary");
        } else if (owner === "agent") throw new Error("Agent cannot duplicate routed tool accounting");
        const requiredSource = owner === "runner" ? "runner_observed" : owner === "agent" ? "adapter_reported" : "environment_observed";
        if (event.source !== requiredSource) throw new Error("Operation accounting owner mismatch");
        operations.set(event.operationId, { id: event.operationId, logicalCallId: event.logicalCallId,
          boundary: event.payload.boundary as Operation["boundary"], owner, observed: false, outcome: null });
        correlations.set(event.operationId, { turnId: event.turnId, parent: event.parentOperationId });
      } else {
        const op = operations.get(event.operationId);
        if (!op || op.outcome !== null || op.logicalCallId !== event.logicalCallId) throw new Error("Unknown, closed or mismatched operation");
        const correlation = correlations.get(event.operationId)!;
        if (event.turnId !== correlation.turnId || event.parentOperationId !== correlation.parent) throw new Error("Operation correlation changed");
        const observer = op.owner === "runner" ? "environment_observed" : op.owner === "agent" ? "adapter_reported" : "environment_observed";
        if (event.source !== observer && !(event.source === "runner_observed" && event.kind === "operation.finished" && ["outcome_unknown", "not_dispatched"].includes(String(event.payload.outcome)))) throw new Error("Invalid operation observation source");
        if (event.kind === "operation.dispatch_observed") {
          if (op.observed) throw new Error("Duplicate dispatch observation");
          op.observed = true;
        } else {
          const outcome = event.payload.outcome as Operation["outcome"];
          if (outcome === "not_dispatched" && op.observed) throw new Error("Observed dispatch cannot become non-dispatch");
          if ((outcome === "known_result" || outcome === "known_failure") && !op.observed) throw new Error("Result without observed dispatch");
          if (outcome !== "known_result" && event.payload.value !== null) throw new Error("Non-result outcome contains a fabricated value");
          if (outcome === "known_result" && event.payload.error !== null) throw new Error("Result contains an error");
          if ([...operations.values()].some(child => child.outcome === null && correlations.get(child.id)?.parent === op.id)) throw new Error("Parent closed with open child operation");
          if (op.boundary === "model") {
            if (event.payload.model !== undefined) modelObservation(event.payload.model);
            if (event.source !== "adapter_reported" && event.payload.model != null) throw new Error("Runner closure cannot manufacture adapter model observations");
            if (outcome === "not_dispatched" && event.payload.model != null) throw new Error("Non-dispatch contains model observations");
          } else if (event.payload.model !== undefined) throw new Error("Model metadata on a tool operation");
          op.outcome = outcome;
        }
      }
    }
    if (event.kind === "agent.error" || event.kind === "runtime.error") stopping = true;
    if (event.kind === "trial.terminal" && event.payload.execution === "finished" && stopping) throw new Error("Finished trial contradicts terminal cause");
    return event;
  });
  const terminal = events.at(-1)?.kind === "trial.terminal";
  if (requireTerminal && !terminal) throw new Error("Missing terminal event");
  if (events.at(-1)?.payload.execution === "finished" && activeTurn !== null) throw new Error("Finished trial has an open turn");
  if ((requireTerminal || terminal) && [...operations.values()].some(op => op.outcome === null)) throw new Error("Unclosed operation accounting");
  return { events, operations: [...operations.values()], turns: completed };
}
