import { contract } from "./validate.js";
import type { Frame } from "./types.js";

const replies: Record<string, string> = { start: "ready", user_turn: "turn_finished", tool_call: "tool_result", stop: "stopped", event: "event_ack",
  describe: "described", prepare: "prepared", execute: "executed", snapshot: "snapshotted", dispose: "disposed" };

/** Correlation and role checks in addition to the closed frame schema. */
export class ProtocolLedger {
  private seen = new Set<string>();
  private pending = new Map<string, string>();
  private incoming = new Map<string, string>();
  private phase = "new";
  private turnId: string | null = null;
  private operationIds = new Map<string, string>();
  constructor(readonly trialId: string, readonly remote: "agent" | "environment") {}
  sent(frame: Frame): void {
    if (this.phase === "stopped") throw new Error("Frame after terminal session");
    contract("frame", frame);
    if (frame.trialId !== this.trialId || this.seen.has(frame.messageId)) throw new Error("Invalid outgoing frame identity");
    this.seen.add(frame.messageId);
    if (frame.replyTo) {
      if (this.incoming.get(frame.replyTo) !== frame.kind) throw new Error("Reply to unknown remote request");
      this.incoming.delete(frame.replyTo);
    } else {
      const legal = this.remote === "agent"
        ? ((frame.kind === "start" && this.phase === "new") || (frame.kind === "user_turn" && this.phase === "ready") || (frame.kind === "stop" && !["new", "stopping", "stopped"].includes(this.phase)))
        : ((frame.kind === "describe" && this.phase === "new") || (frame.kind === "prepare" && this.phase === "described") || (["execute", "snapshot"].includes(frame.kind) && this.phase === "prepared") || (frame.kind === "dispose" && ["described", "preparing", "prepared", "failed"].includes(this.phase)));
      if (!legal) throw new Error("Request violates endpoint lifecycle");
      if ([...this.pending.values()].includes(replies[frame.kind]!)) throw new Error("Concurrent requests of this kind are unsupported");
      const expected = replies[frame.kind];
      if (!expected) throw new Error("Outgoing request has no reply contract");
      this.pending.set(frame.messageId, expected);
      if (frame.kind === "user_turn") this.turnId = String(frame.payload.turnId);
      if (frame.kind === "execute") this.operationIds.set(frame.messageId, String(frame.payload.operationId));
      const next: Record<string, string> = { start: "starting", user_turn: "turn", stop: "stopping", describe: "describing", prepare: "preparing", dispose: "disposing" };
      this.phase = next[frame.kind] ?? this.phase;
    }
  }
  received(value: unknown): Frame {
    if (this.phase === "stopped") throw new Error("Frame after terminal session");
    const frame = contract<Frame>("frame", value);
    if (frame.trialId !== this.trialId || this.seen.has(frame.messageId)) throw new Error("Repeated or mismatched frame identity");
    this.seen.add(frame.messageId);
    if (this.seen.size > 100000) throw new Error("Protocol frame-count limit exceeded");
    if (frame.replyTo) {
      if (this.pending.get(frame.replyTo) !== frame.kind) throw new Error("Invalid reply correlation");
      if (frame.kind === "turn_finished" && (frame.payload.turnId !== this.turnId || this.incoming.size !== 0 || (frame.payload.outstandingOperationIds as unknown[]).length !== 0)) throw new Error("Turn finished with mismatched identity or open work");
      if (frame.kind === "executed" && frame.payload.operationId !== this.operationIds.get(frame.replyTo)) throw new Error("Executed operation identity mismatch");
      this.operationIds.delete(frame.replyTo);
      this.pending.delete(frame.replyTo);
      if (["ready", "turn_finished"].includes(frame.kind) && ["starting", "turn"].includes(this.phase)) this.phase = "ready";
      if (frame.kind === "turn_finished") this.turnId = null;
      if (frame.kind === "described" && this.phase === "describing") this.phase = "described";
      if (frame.kind === "prepared" && this.phase === "preparing") this.phase = "prepared";
      if (frame.kind === "disposed" || frame.kind === "stopped") this.phase = "stopped";
    } else {
      const allowed = this.remote === "agent" ? ["tool_call", "event", "agent_error"] : ["event", "environment_error"];
      if (!allowed.includes(frame.kind)) throw new Error("Unexpected remote request");
      if (["new", "stopped"].includes(this.phase)) throw new Error("Remote request outside session");
      const active = this.phase === (this.remote === "agent" ? "turn" : "prepared");
      const closingObservation = frame.kind === "event" && ["stopping", "failed", "disposing"].includes(this.phase) && frame.payload.kind !== "operation.dispatch_intent";
      if ((frame.kind === "tool_call" || frame.kind === "event") && !active && !closingObservation) throw new Error("Business activity outside active phase");
      if (frame.kind === "tool_call" && frame.payload.turnId !== this.turnId) throw new Error("Tool call turn mismatch");
      const reply = replies[frame.kind];
      if (reply) this.incoming.set(frame.messageId, reply);
      if (frame.kind === "agent_error" || frame.kind === "environment_error") this.phase = "failed";
    }
    return frame;
  }
}
