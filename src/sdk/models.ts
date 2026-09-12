import { randomUUID } from "node:crypto";
import type { AdapterPeer } from "./peer.js";
import type { Json, ModelObservation, ModelRequest, Outcome } from "../contracts/types.js";

export interface ModelOperation { id: string; logicalCallId: string | null; parentOperationId: string | null; }

/** One recorder per user turn. The adapter owns the real dispatch and any retries. */
export class ModelRecorder {
  private operations = new Map<string, { operation: ModelOperation; observed: boolean; closed: boolean }>();
  private stopped = false;
  constructor(private readonly peer: AdapterPeer) {}
  stop(): void { this.stopped = true; }
  outstandingOperations(): string[] { return [...this.operations].filter(([, state]) => !state.closed).map(([id]) => id); }
  async intent(request: ModelRequest, logicalCallId: string | null = null, parentOperationId: string | null = null): Promise<ModelOperation> {
    if (this.stopped) throw new Error("Model recorder stopped");
    const operation = { id: randomUUID(), logicalCallId, parentOperationId };
    this.operations.set(operation.id, { operation, observed: false, closed: false });
    await this.event(operation, "operation.dispatch_intent", { boundary: "model", owner: "agent", name: request.model, args: request as unknown as Json });
    if (this.stopped) throw new Error("Stopped before model dispatch");
    return operation;
  }
  /** Call only after the adapter actually observes its configured dispatch boundary. */
  async observed(operation: ModelOperation): Promise<void> {
    const state = this.state(operation);
    if (state.observed) throw new Error("Duplicate model dispatch observation");
    await this.event(operation, "operation.dispatch_observed", {}); state.observed = true;
  }
  async finish(operation: ModelOperation, outcome: Outcome, value: Json, error: string | null, model: ModelObservation | null): Promise<void> {
    const state = this.state(operation);
    if ((["known_result", "known_failure"].includes(outcome) && !state.observed) || (outcome === "not_dispatched" && (state.observed || model !== null))) throw new Error("Model outcome contradicts dispatch");
    if ((outcome === "known_result" && error !== null) || (outcome !== "known_result" && value !== null)) throw new Error("Contradictory model result");
    await this.event(operation, "operation.finished", { outcome, value, error, model: model as unknown as Json }); state.closed = true;
  }
  completeTurn(): string[] {
    if ([...this.operations.values()].some(state => !state.closed)) throw new Error("Turn has open model operations");
    return [...this.operations.keys()];
  }
  private state(operation: ModelOperation) {
    const state = this.operations.get(operation.id);
    if (!state || state.operation !== operation || state.closed) throw new Error("Unknown or closed model operation");
    return state;
  }
  private async event(operation: ModelOperation, kind: string, data: Record<string, Json>): Promise<void> {
    const ack = await this.peer.request("event", { kind, operationId: operation.id, logicalCallId: operation.logicalCallId, parentOperationId: operation.parentOperationId, data });
    if (ack.kind !== "event_ack" || !Number.isInteger(ack.payload.sequence)) throw new Error("Missing durable model event acknowledgment");
  }
}
