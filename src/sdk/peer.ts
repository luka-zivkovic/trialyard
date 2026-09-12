import { randomUUID } from "node:crypto";
import type { Frame, Json } from "../contracts/types.js";

/** Minimal adapter transport. The coordinator validates every incoming frame. */
export class AdapterPeer {
  private trialId: string | null = null;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (frame: Frame) => void; reject: (error: Error) => void }>();
  constructor(private readonly handle: (frame: Frame) => Promise<void>) {
    process.stdin.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      let newline: number;
      while ((newline = this.buffer.indexOf(10)) !== -1) {
        const bytes = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1);
        if (bytes.length > 1048576) return this.fail(new Error("Frame limit exceeded"));
        try {
          const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Frame;
          if (frame.protocol !== "trial-runner/process/v1" || (this.trialId !== null && frame.trialId !== this.trialId)) throw new Error("Invalid runner frame");
          this.trialId = frame.trialId;
          if (frame.replyTo) {
            const pending = this.pending.get(frame.replyTo);
            if (!pending) throw new Error("Unknown runner reply");
            this.pending.delete(frame.replyTo); pending.resolve(frame);
          } else void this.handle(frame).catch(error => this.fail(error));
        } catch (error) { this.fail(error instanceof Error ? error : new Error("Protocol failure")); }
      }
      if (this.buffer.length > 1048576) this.fail(new Error("Frame limit exceeded"));
    });
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("error", () => process.exit(1));
    process.stdout.on("error", () => process.exit(1));
  }
  async request(kind: string, payload: Record<string, Json>): Promise<Frame> {
    const frame = this.frame(kind, payload);
    const result = new Promise<Frame>((resolve, reject) => this.pending.set(frame.messageId, { resolve, reject }));
    this.write(frame); return result;
  }
  reply(request: Frame, kind: string, payload: Record<string, Json>): void {
    this.write({ ...this.frame(kind, payload), replyTo: request.messageId });
  }
  notify(kind: string, payload: Record<string, Json>): void { this.write(this.frame(kind, payload)); }
  private frame(kind: string, payload: Record<string, Json>): Frame {
    if (this.trialId === null) throw new Error("Runner must initiate the session");
    return { protocol: "trial-runner/process/v1", trialId: this.trialId, messageId: randomUUID(), kind, payload };
  }
  private write(frame: Frame): void { process.stdout.write(JSON.stringify(frame) + "\n"); }
  private fail(error: Error): void {
    process.stderr.write(`Adapter protocol failure: ${error.message}\n`);
    for (const pending of this.pending.values()) pending.reject(error);
    process.exitCode = 1; process.stdin.destroy();
  }
}
