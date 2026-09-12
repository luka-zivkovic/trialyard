import { randomUUID } from "node:crypto";
import { AdapterPeer } from "../src/sdk/peer.js";
import type { Fault, Frame, Json } from "../src/contracts/types.js";
import { tools, type Inventory } from "./contract.js";

let state: Inventory | null = null;
let leaseId: string | null = null;
let faults: Fault[] = [];
let settings: Record<string, Json> = {};
let observedAt = "";
const invocations = new Map<string, number>();
const pending = new Set<string>();
const snapshot = (): Record<string, Json> => ({ state: state as unknown as Json, stable: pending.size === 0,
  pendingOperations: [...pending], observedAt: observedAt || new Date().toISOString() });

const peer = new AdapterPeer(async (frame: Frame) => {
  switch (frame.kind) {
    case "describe":
      peer.reply(frame, "described", { adapterId: "reference.inventory", adapterVersion: "0.1.0", capabilities: ["fresh-lease", "state-snapshot", "routed-tools", "verified-cleanup"], tools: tools as unknown as Json, faultModes: ["error_before", "lost_after", "hang"] }); break;
    case "prepare": {
      settings = frame.payload.settings as Record<string, Json>;
      if (settings.prepareFailure) { peer.notify("environment_error", { message: "Injected preparation failure" }); break; }
      state = structuredClone(frame.payload.state) as unknown as Inventory;
      faults = frame.payload.faultPlan as unknown as Fault[];
      const clock = frame.payload.clock as Record<string, Json>;
      observedAt = clock.mode === "frozen" ? String(clock.instant) : "";
      leaseId = randomUUID(); invocations.clear(); pending.clear();
      peer.reply(frame, "prepared", { leaseId, snapshot: snapshot(), bindings: { leaseId } }); break;
    }
    case "execute": {
      if (!state || !leaseId) throw new Error("No prepared lease");
      const operationId = String(frame.payload.operationId);
      const activeLease = leaseId;
      const tool = String(frame.payload.tool);
      const args = frame.payload.args as Record<string, Json>;
      const invocation = (invocations.get(tool) ?? 0) + 1; invocations.set(tool, invocation);
      const fault = faults.find(f => f.tool === tool && f.invocation === invocation);
      // The runner already durably wrote intent before sending execute. Ack the observation
      // before mutating the local fixture, so a lost reply cannot erase the attempt record.
      pending.add(operationId);
      await peer.request("event", { kind: "operation.dispatch_observed", operationId, logicalCallId: null, parentOperationId: null, data: {} });
      if (leaseId !== activeLease || state === null) {
        pending.delete(operationId);
        peer.reply(frame, "executed", { operationId, outcome: "known_failure", value: null, error: "Lease disposed before mutation" });
        return;
      }
      if (fault?.mode === "hang") return;
      let value: Json = null;
      let error: string | null = null;
      if (fault?.mode === "error_before") error = "Injected service failure before mutation";
      else if (tool === "stock") value = { available: state.available };
      else if (tool === "reservations") value = { reservations: structuredClone(state.reservations), available: state.available };
      else if (tool === "reserve") {
        const existing = state.reservations.find(r => r.key === args.key);
        const quantity = Number(args.quantity);
        if (existing && existing.quantity !== quantity) error = "Idempotency key conflict";
        else if (existing) value = { ...existing };
        else if (quantity > state.available) error = "Insufficient stock";
        else {
          const reservation = { id: `reservation-${state.reservations.length + 1}`, key: String(args.key), quantity };
          state.available -= quantity; state.reservations.push(reservation); value = { ...reservation };
        }
      } else throw new Error("Unsupported tool");
      pending.delete(operationId);
      if (fault?.mode === "lost_after") { peer.reply(frame, "executed", { operationId, outcome: "outcome_unknown", value: null, error: "Injected lost response after execution" }); }
      else peer.reply(frame, "executed", { operationId, outcome: error ? "known_failure" : "known_result", value, error });
      break;
    }
    case "snapshot":
      peer.reply(frame, "snapshotted", settings.missingSnapshot || state === null ? { snapshot: null, error: "Snapshot unavailable" } : { snapshot: snapshot(), error: null }); break;
    case "dispose":
      if (settings.cleanupFailure) peer.reply(frame, "disposed", { status: "failed", resources: leaseId ? [leaseId] : [] });
      else { state = null; leaseId = null; pending.clear(); peer.reply(frame, "disposed", { status: "succeeded", resources: [] }); }
      break;
    default: throw new Error("Unsupported environment request");
  }
});
