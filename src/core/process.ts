import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ProtocolLedger } from "../contracts/protocol.js";
import { parseJson } from "../contracts/strict-json.js";
import type { Adapter, Frame, Json, Limits } from "../contracts/types.js";
import { CaptureLimitError } from "./journal.js";

export class WorkerFailure extends Error {
  constructor(readonly boundary: "agent" | "environment" | "protocol", message: string, readonly candidateFailure = false) { super(message); }
}
export class DeadlineError extends Error {}
export class CancelledError extends Error {}

/** Transport amplification is bounded separately from persisted evidence payloads. */
export class WireBudget {
  private bytes = 0;
  readonly limit: number;
  constructor(limits: Limits) { this.limit = 4 * limits.maxRecordedBytes + 4 * limits.maxFrameBytes; }
  consume(count: number): void {
    this.bytes += count;
    if (this.bytes > this.limit) throw new CaptureLimitError("Shared worker wire byte limit exceeded");
  }
}

export async function before<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  // The caller may already have issued a request before discovering an elapsed ceiling.
  // Observe its eventual rejection even when this waiter returns immediately.
  void promise.catch(() => {});
  if (signal?.aborted) throw new CancelledError("User cancellation");
  if (Date.now() >= deadline) throw new DeadlineError("Deadline reached");
  let timer: NodeJS.Timeout | undefined;
  let cancel: (() => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError("Deadline reached")), Math.max(1, deadline - Date.now()));
    cancel = () => reject(new CancelledError("User cancellation"));
    signal?.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([promise, limit]); }
  finally { clearTimeout(timer); if (cancel) signal?.removeEventListener("abort", cancel); }
}

export class Worker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ledger: ProtocolLedger;
  private buffer = Buffer.alloc(0);
  private queue: Promise<void> = Promise.resolve();
  private tools: Promise<void> = Promise.resolve();
  private diagnostics: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly diagnosticDecoder = new TextDecoder("utf-8", { fatal: true });
  private pending = new Map<string, { resolve: (frame: Frame) => void; reject: (error: Error) => void }>();
  private rejectFailure!: (error: Error) => void;
  readonly failure: Promise<never>;
  private failed: Error | null = null;
  private captureFailure: Error | null = null;
  private ioFailure: Error | null = null;
  private captureStopped = false;
  private termination: Promise<void> | null = null;
  private closing = false;
  private stopping = false;
  private frames = 0;
  readonly closed: Promise<void>;

  constructor(readonly role: "agent" | "environment", readonly trialId: string, adapter: Adapter, workspace: string, private readonly limits: Limits,
    private readonly onRequest: (worker: Worker, frame: Frame) => Promise<void>, onDiagnostic: (text: string) => Promise<void>, private readonly wireBudget = new WireBudget(limits), secretEnvironment: Record<string, string> = {}) {
    this.ledger = new ProtocolLedger(trialId, role);
    this.failure = new Promise((_, reject) => { this.rejectFailure = reject; });
    void this.failure.catch(() => {});
    this.child = spawn(process.execPath, [adapter.argv[1]!], { cwd: path.join(workspace, adapter.cwd), detached: true,
      env: { PATH: path.dirname(process.execPath), LANG: "C.UTF-8", TZ: "UTC", ...secretEnvironment }, stdio: ["pipe", "pipe", "pipe"] });
    this.closed = new Promise(resolve => this.child.once("close", () => resolve()));
    const account = (count: number): boolean => {
      if (this.captureStopped) return false;
      try { wireBudget.consume(count); return true; }
      catch (error) { this.fail(error as Error); return false; }
    };
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (!account(chunk.length)) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let newline: number;
      while ((newline = this.buffer.indexOf(10)) !== -1 && !this.captureStopped) {
        const bytes = Buffer.from(this.buffer.subarray(0, newline)); this.buffer = this.buffer.subarray(newline + 1);
        if (bytes.length + 1 > limits.maxFrameBytes || ++this.frames > limits.maxEvents * 4 + 100 || ++this.queued > 128) { this.fail(new CaptureLimitError("Protocol frame or queue limit exceeded")); break; }
        let deferredTool = false;
        this.queue = this.queue.then(async () => {
          if (this.captureStopped) return;
          let frame: Frame;
          try { frame = this.ledger.received(parseJson(bytes, limits.maxFrameBytes)); }
          catch { throw new WorkerFailure("protocol", "Malformed or out-of-order protocol frame"); }
          if (frame.replyTo) {
            if (this.closing) return; // A stopped waiter cannot accept a late response.
            const pending = this.pending.get(frame.replyTo);
            if (!pending) throw new WorkerFailure("protocol", "Unknown pending response");
            this.pending.delete(frame.replyTo); pending.resolve(frame);
          } else if (frame.kind === "tool_call") {
            // A tool can invoke an agent-owned model and await its durable event ACK.
            // Keep tools serial, but let ordered events and lifecycle replies proceed.
            deferredTool = true;
            this.tools = this.tools.then(async () => {
              if (!this.failed && !this.closing && !this.stopping) await this.onRequest(this, frame);
            }).catch(error => {
              // The coordinator owns deadline/cancellation closure. Do not reject
              // its pending stop acknowledgment when a tool waiter is released.
              if (error instanceof CancelledError || error instanceof DeadlineError) { this.stopping = true; return; }
              this.fail(error instanceof Error ? error : new WorkerFailure("protocol", "Tool handler failed"));
            })
              .finally(() => { this.queued--; });
          } else await this.onRequest(this, frame);
        }).catch(error => this.fail(error instanceof Error ? error : new WorkerFailure("protocol", "Protocol handler failed"))).finally(() => { if (!deferredTool) this.queued--; });
      }
      if (this.buffer.length >= limits.maxFrameBytes) this.fail(new CaptureLimitError("Unterminated frame exceeds byte limit"));
    });
    const diagnostic = (chunk?: Buffer): void => {
      let text: string;
      try { text = this.diagnosticDecoder.decode(chunk, { stream: chunk !== undefined }); }
      catch { this.fail(new WorkerFailure("protocol", "Invalid UTF-8 diagnostic stream")); return; }
      if (!text) return;
      if (++this.queued > 128) { this.fail(new CaptureLimitError("Diagnostic queue limit exceeded")); return; }
      this.diagnostics = this.diagnostics.then(() => onDiagnostic(text)).catch(error => this.fail(error)).finally(() => { this.queued--; });
    };
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (account(chunk.length)) diagnostic(chunk);
    });
    this.child.stderr.once("end", () => { if (!this.captureStopped) diagnostic(); });
    this.child.once("error", () => this.fail(new WorkerFailure(role, "Worker could not start")));
    this.child.once("exit", (code, signal) => {
      // Process death must not wait for a handler awaiting a different worker.
      if (!this.closing) this.fail(new WorkerFailure(role, `Worker exited (code=${code}, signal=${signal})`));
    });
    this.child.once("close", () => {
      if (this.buffer.length) this.fail(new WorkerFailure("protocol", "Worker closed with a partial frame"));
    });
    this.child.stdin.on("error", () => { if (!this.closing) this.fail(new WorkerFailure(role, "Worker input closed")); });
  }

  request(kind: string, payload: Record<string, Json>): Promise<Frame> {
    if (this.failed || this.closing) return Promise.reject(this.failed ?? new WorkerFailure(this.role, "Worker closing"));
    const frame = this.frame(kind, payload);
    try { this.ledger.sent(frame); if (kind === "stop") this.stopping = true; }
    catch (error) { return Promise.reject(new WorkerFailure("protocol", error instanceof Error ? error.message : "Invalid outgoing request")); }
    const pending = new Promise<Frame>((resolve, reject) => this.pending.set(frame.messageId, { resolve, reject }));
    const bytes = Buffer.from(JSON.stringify(frame) + "\n");
    try {
      if (bytes.length > this.limits.maxFrameBytes) throw new CaptureLimitError("Outgoing frame exceeds byte limit");
      this.wireBudget.consume(bytes.length); this.child.stdin.write(bytes);
    } catch (error) { this.fail(error as Error); }
    return pending;
  }
  reply(request: Frame, kind: string, payload: Record<string, Json>): void {
    if (this.closing) return; // Do not send acknowledgments after local termination begins.
    if (this.failed) throw this.failed;
    const frame = { ...this.frame(kind, payload), replyTo: request.messageId };
    this.ledger.sent(frame);
    const bytes = Buffer.from(JSON.stringify(frame) + "\n");
    if (bytes.length > this.limits.maxFrameBytes) throw new CaptureLimitError("Outgoing frame exceeds byte limit");
    this.wireBudget.consume(bytes.length);
    this.child.stdin.write(bytes);
  }
  private frame(kind: string, payload: Record<string, Json>): Frame {
    return { protocol: "trial-runner/process/v1", trialId: this.trialId, messageId: randomUUID(), kind, payload };
  }
  private fail(error: Error): void {
    // Preserve late journal/filesystem errors even when process death won the race.
    const ioFailure = !(error instanceof WorkerFailure || error instanceof CaptureLimitError || error instanceof CancelledError || error instanceof DeadlineError);
    if (ioFailure) this.ioFailure ??= error;
    if (error instanceof CaptureLimitError || (error instanceof WorkerFailure && error.boundary === "protocol")) {
      this.captureFailure ??= error; this.captureStopped = true;
      this.child.stdout.destroy(); this.child.stderr.destroy(); this.buffer = Buffer.alloc(0);
    }
    if (ioFailure) {
      this.captureStopped = true; this.child.stdout.destroy(); this.child.stderr.destroy(); this.buffer = Buffer.alloc(0);
    }
    if (this.failed) return;
    this.failed = error; this.rejectFailure(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async drain(): Promise<void> { await this.queue; await this.tools; await this.diagnostics; }
  get failureCause(): Error | null { return this.failed; }
  get failureCauses(): Error[] { return [...new Set([this.failed, this.captureFailure, this.ioFailure].filter((error): error is Error => error !== null))]; }
  terminate(graceMs: number): Promise<void> {
    return this.termination ??= this.terminateOnce(graceMs);
  }
  private async terminateOnce(graceMs: number): Promise<void> {
    this.closing = true;
    const error = new WorkerFailure(this.role, "Worker terminated");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    const signal = (name: NodeJS.Signals): void => {
      if (!this.child.pid) return;
      try { process.kill(-this.child.pid, name); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // macOS reports EPERM, not ESRCH, for a group whose members have all
        // exited but are not yet reaped; that only counts as gone once the
        // direct worker has exited.
        const exited = this.child.exitCode !== null || this.child.signalCode !== null;
        if (code !== "ESRCH" && !(code === "EPERM" && exited)) throw error;
      }
    };
    signal("SIGTERM");
    await Promise.race([this.closed, sleep(graceMs)]);
    // Group kill also covers descendants when the direct worker already exited.
    signal("SIGKILL");
    await Promise.race([this.closed, sleep(1000)]);
    // A handler may be awaiting a different worker; its caller owns cancellation.
  }
}
