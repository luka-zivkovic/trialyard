import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Event, Limits } from "../contracts/types.js";
import { contract } from "../contracts/validate.js";
import { writeAtomic } from "./files.js";
import { parseJson } from "../contracts/strict-json.js";
import { SecretMask } from "./privacy.js";

export class CaptureLimitError extends Error {}

/** Acknowledgment is returned only after write + fsync. Receive order is serialized here. */
export class Journal {
  readonly events: Event[] = [];
  readonly attachments = new Map<string, Buffer>();
  readonly redactedPaths = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private bytes = 0;
  private openOperations = 0;
  private operations = 0;
  private constructor(private readonly file: fs.FileHandle, private readonly root: string, readonly runId: string, readonly trialId: string, private readonly limits: Limits, readonly mask: SecretMask) {}
  static async create(filename: string, runId: string, trialId: string, limits: Limits, mask = new SecretMask()): Promise<Journal> {
    const file = await fs.open(filename, "wx", 0o600);
    try {
      const directory = await fs.open(path.dirname(filename), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return new Journal(file, path.dirname(filename), runId, trialId, limits, mask);
    } catch (error) { await file.close(); throw error; }
  }
  append(kind: Event["kind"], payload: Event["payload"], extra: Partial<Event> = {}, terminal = false): Promise<Event> {
    let result!: Event;
    const write = this.tail.then(async () => {
      result = contract<Event>("event", { schemaVersion: "trial-runner/event/v1", sequence: this.events.length,
        recordedAt: new Date().toISOString(), producerTimestamp: null, runId: this.runId, trialId: this.trialId,
        turnId: null, operationId: null, logicalCallId: null, parentOperationId: null, source: "runner_observed", kind, payload, ...extra });
      this.mask.assertPublic({ ...result, payload: null });
      const masked = this.mask.json(result.payload);
      if (masked.redacted) this.redactedPaths.add("events.ndjson");
      result = contract<Event>("event", { ...result, payload: masked.value });
      const bytes = Buffer.from(JSON.stringify(result) + "\n");
      const pending = this.openOperations + (kind === "operation.dispatch_intent" ? 1 : 0) - (kind === "operation.finished" ? 1 : 0);
      const reservedEvents = terminal ? 0 : 3 + pending;
      const reservedBytes = terminal ? 0 : 4096 + pending * 1024;
      if (bytes.length > 2 * 1024 * 1024 || (kind === "operation.dispatch_intent" && this.operations >= 10000) || this.events.length + 1 + reservedEvents > this.limits.maxEvents || this.bytes + bytes.length + reservedBytes > this.limits.maxRecordedBytes) throw new CaptureLimitError("Evidence capture limit exceeded");
      await this.file.writeFile(bytes); await this.file.sync();
      this.events.push(result); this.bytes += bytes.length; this.openOperations = pending;
      if (kind === "operation.dispatch_intent") this.operations++;
    });
    this.tail = write.catch(() => {});
    return write.then(() => result);
  }
  capture(name: string, input: Uint8Array): Promise<void> {
    const write = this.tail.then(async () => {
      if (!["initial-state.json", "final-state.json", "environment-described.json", "environment-prepared.json", "agent-ready.json", "agent-stopped.json", "environment-disposed.json"].includes(name) || this.attachments.has(name)) throw new Error("Invalid or duplicate capture attachment");
      const masked = this.mask.active ? this.mask.json(parseJson(input)) : { value: null, redacted: false };
      if (masked.redacted) this.redactedPaths.add(name);
      const bytes = masked.redacted ? Buffer.from(JSON.stringify(masked.value, null, 2) + "\n") : Buffer.from(input);
      if (this.bytes + bytes.length + 4096 + this.openOperations * 1024 > this.limits.maxRecordedBytes) throw new CaptureLimitError("Evidence capture limit exceeded");
      await writeAtomic(path.join(this.root, name), bytes);
      this.attachments.set(name, bytes); this.bytes += bytes.length;
    });
    this.tail = write.catch(() => {});
    return write;
  }
  async close(): Promise<void> { await this.tail; await this.file.close(); }
  get recordedBytes(): number { return this.bytes; }
}
