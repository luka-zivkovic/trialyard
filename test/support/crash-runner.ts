// Test-only barriers surround the actual durable append and process transport.
import { Journal } from "../../src/core/journal.js";
import { Worker } from "../../src/core/process.js";
import { runPlan } from "../../src/core/run.js";
import type { ChildProcess } from "node:child_process";

const [file, store, stage] = process.argv.slice(2) as [string, string, string];
const abort = new AbortController();
const barrier = async (): Promise<void> => {
  process.send?.({ stage }); await new Promise(() => {});
};
const append = Journal.prototype.append;
Journal.prototype.append = async function (kind, ...args) {
  if (kind === "operation.dispatch_intent" && stage === "before-intent") await barrier();
  const event = await append.call(this, kind, ...args);
  if (kind === "operation.dispatch_intent") {
    if (stage === "after-intent") await barrier();
    if (stage === "cancel-before-send") abort.abort();
  }
  return event;
};
const request = Worker.prototype.request;
Worker.prototype.request = function (...args) {
  process.send?.({ workerPid: (this as unknown as { child: ChildProcess }).child.pid });
  return request.apply(this, args);
};
try { await runPlan(file, { store, requestId: "crash", signal: abort.signal }); }
catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
process.disconnect?.();
