import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

interface WireFrame {
  protocol: string; trialId: string; messageId: string; kind: string;
  replyTo?: string; payload: Record<string, unknown>;
}
interface StateView {
  state: { available: number; reservations: { id: string; key: string; quantity: number }[] };
  stable: boolean; pendingOperations: string[];
}

// Raw stdin/stdout probes deliberately bypass the runner and adapter SDK.
async function environment(t: TestContext) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../reference/environment.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const inbox: WireFrame[] = [];
  const waiting: { matches: (frame: WireFrame) => boolean; resolve: (frame: WireFrame) => void }[] = [];
  let diagnostics = "";
  child.stderr.on("data", (data: Buffer) => { diagnostics += data.toString("utf8"); });
  createInterface({ input: child.stdout }).on("line", line => {
    const frame = JSON.parse(line) as WireFrame;
    const index = waiting.findIndex(waiter => waiter.matches(frame));
    if (index === -1) inbox.push(frame);
    else waiting.splice(index, 1)[0]!.resolve(frame);
  });
  t.after(async () => { child.kill("SIGKILL"); await closed; });
  const frame = (kind: string, payload: Record<string, unknown>, replyTo?: string): WireFrame => ({
    protocol: "trial-runner/process/v1", trialId: "boundary-trial", messageId: randomUUID(), kind, payload,
    ...(replyTo ? { replyTo } : {}),
  });
  const write = (...frames: WireFrame[]): void => { child.stdin.write(frames.map(value => JSON.stringify(value)).join("\n") + "\n"); };
  const receive = (matches: (frame: WireFrame) => boolean): Promise<WireFrame> => {
    const index = inbox.findIndex(matches);
    if (index !== -1) return Promise.resolve(inbox.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Environment response timed out: ${diagnostics}`)), 3000);
      waiting.push({ matches, resolve: value => { clearTimeout(timeout); resolve(value); } });
    });
  };
  const reply = (request: WireFrame): Promise<WireFrame> => receive(value => value.replyTo === request.messageId);
  const request = async (kind: string, payload: Record<string, unknown>): Promise<WireFrame> => {
    const outgoing = frame(kind, payload); write(outgoing); return reply(outgoing);
  };
  const observe = (operationId: string): Promise<WireFrame> => receive(value => value.kind === "event" && value.payload.operationId === operationId);
  const ack = (event: WireFrame): WireFrame => frame("event_ack", { sequence: 0 }, event.messageId);
  const execute = async (key: string, quantity: number): Promise<WireFrame> => {
    const operationId = randomUUID();
    const outgoing = frame("execute", { operationId, tool: "reserve", args: { key, quantity } });
    write(outgoing); write(ack(await observe(operationId))); return reply(outgoing);
  };
  await request("describe", { adapterId: "reference.inventory", adapterVersion: "0.1.0" });
  const prepared = await request("prepare", {
    state: { available: 3, reservations: [] },
    settings: { prepareFailure: false, missingSnapshot: false, cleanupFailure: false },
    faultPlan: [], clock: { mode: "real", instant: null },
  });
  assert.deepEqual((prepared.payload.snapshot as StateView).state, { available: 3, reservations: [] });
  return { frame, write, reply, request, observe, ack, execute };
}

test("raw environment: ack and snapshot in one chunk retain the pending write", async t => {
  const peer = await environment(t);
  const execute = peer.frame("execute", { operationId: "pending-reserve", tool: "reserve", args: { key: "one", quantity: 1 } });
  peer.write(execute);
  const observed = await peer.observe("pending-reserve");
  const snapshot = peer.frame("snapshot", {});
  peer.write(peer.ack(observed), snapshot);
  const before = (await peer.reply(snapshot)).payload.snapshot as StateView;
  assert.deepEqual(before.state, { available: 3, reservations: [] });
  assert.equal(before.stable, false);
  assert.deepEqual(before.pendingOperations, ["pending-reserve"]);
  assert.equal((await peer.reply(execute)).payload.outcome, "known_result");
  const after = (await peer.request("snapshot", {})).payload.snapshot as StateView;
  assert.equal(after.state.available, 2); assert.equal(after.state.reservations.length, 1);
  assert.equal(after.stable, true); assert.deepEqual(after.pendingOperations, []);
});

test("raw environment: disposal before acknowledgment prevents delayed mutation", async t => {
  const peer = await environment(t);
  const execute = peer.frame("execute", { operationId: "disposed-reserve", tool: "reserve", args: { key: "one", quantity: 1 } });
  peer.write(execute);
  const observed = await peer.observe("disposed-reserve");
  assert.equal((await peer.request("dispose", {})).payload.status, "succeeded");
  peer.write(peer.ack(observed));
  const result = await peer.reply(execute);
  assert.equal(result.payload.outcome, "known_failure");
  assert.equal(result.payload.value, null);
  assert.equal(result.payload.error, "Lease disposed before mutation");
  assert.equal((await peer.request("snapshot", {})).payload.snapshot, null);
  assert.equal((await peer.request("dispose", {})).payload.status, "succeeded");
});

test("raw environment: identical keys reuse one reservation; conflicts and insufficient stock preserve state", async t => {
  const peer = await environment(t);
  const first = await peer.execute("same-key", 1);
  const repeated = await peer.execute("same-key", 1);
  assert.equal(first.payload.outcome, "known_result");
  assert.deepEqual(repeated.payload.value, first.payload.value);
  const conflict = await peer.execute("same-key", 2);
  assert.equal(conflict.payload.outcome, "known_failure");
  assert.equal(conflict.payload.error, "Idempotency key conflict");
  assert.equal(conflict.payload.value, null);
  const insufficient = await peer.execute("different-key", 3);
  assert.equal(insufficient.payload.outcome, "known_failure");
  assert.equal(insufficient.payload.error, "Insufficient stock");
  assert.equal(insufficient.payload.value, null);
  const final = (await peer.request("snapshot", {})).payload.snapshot as StateView;
  assert.deepEqual(final.state, { available: 2, reservations: [{ id: "reservation-1", key: "same-key", quantity: 1 }] });
  assert.equal(final.stable, true); assert.deepEqual(final.pendingOperations, []);
});
