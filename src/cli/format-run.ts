import * as path from "node:path";
import type { RunResult } from "../core/run.js";
import type { Event, RunInspection } from "../contracts/types.js";
import { verifyBundle } from "../contracts/verify.js";
import { hash, safeFile } from "../core/files.js";
import { parseJson } from "../contracts/strict-json.js";

// JSON quoting keeps repository/candidate terminal control sequences inert.
export function displayValue(value: unknown, limit = 1200): string {
  const text = (JSON.stringify(value) ?? "null").replace(/[\u007f-\u009f\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return text.length > limit ? `${text.slice(0, limit)} … [display shortened; full evidence retained]` : text;
}

/** Read-only presentation; status and observations come from verified bundles. */
export async function readableRun(result: RunResult, inspection: RunInspection): Promise<string> {
  const lines = [`Request ${displayValue(result.index.requestId)} — ${result.index.state}`, `Planned trials: ${result.index.trials.length}; allocation: ${inspection.coverage}; executor liveness: not checked`,
    "Execution evidence only. Behavioral judgment belongs to a separate evaluator.", `Evidence directory: ${displayValue(result.root)}`];
  for (const [i, slot] of result.index.trials.entries()) {
    const observed = inspection.trials[i]!;
    lines.push("", `${i + 1}. ${displayValue(slot.scenarioId)} / repetition ${slot.repetition}`, `Inspection: ${observed.state}`);
    if (!observed.bundle.verified || observed.state !== "finalized") {
      lines.push(`Execution recorded so far: ${observed.terminalExecution ?? observed.indexExecution}`, "Evidence / cleanup: not verified", `Gaps: ${displayValue(observed.gaps)}`,
        "Next: inspect the retained journal and owned resources; this view does not resume or repeat work.");
      continue;
    }
    const root = path.join(result.root, slot.path);
    const { manifest } = await verifyBundle(root, observed.bundle.sha256!);
    const read = async (name: string) => {
      const record = manifest.files.find(file => file.path === name);
      if (!record) return null;
      const bytes = await safeFile(root, name);
      if (hash(bytes) !== record.sha256 || bytes.length !== record.bytes) throw new Error("Evidence changed during presentation");
      return bytes;
    };
    lines.push(`Execution: ${manifest.execution}; evidence: ${manifest.evidence.state}; cleanup: ${manifest.cleanup}`,
      `Bundle: ${observed.bundle.sha256}`, `Boundary: ${displayValue(manifest.fidelity.boundary)}`, `Reason: ${displayValue(manifest.reason)}`,
      `Evidence gaps: ${displayValue(manifest.evidence.gaps)}`, `Inspection gaps: ${displayValue(observed.gaps)}`);
    const events = (await read("events.ndjson"))!.toString("utf8").trim().split("\n").map(line => parseJson(line) as unknown as Event);
    const firstUser = events.find(e => e.kind === "user.turn")?.sequence ?? Infinity;
    const diagnostics = events.filter(e => e.kind === "diagnostic");
    for (const event of diagnostics.slice(0, 8)) lines.push(`Diagnostic (${displayValue(event.payload.channel)}, ${event.sequence < firstUser ? "before first user turn" : "after first user turn"}; recorded process output): ${displayValue(event.payload.text)}`);
    if (diagnostics.length) lines.push(`Diagnostic source: ${displayValue(path.join(root, "events.ndjson"))}${diagnostics.length > 8 ? "; additional diagnostics retained" : ""}`);
    const turns = events.filter(e => e.kind === "user.turn" || e.kind === "assistant.turn");
    for (const event of turns.slice(0, 12)) lines.push(`${event.kind === "user.turn" ? "User" : "Assistant (candidate claim)"}: ${displayValue(event.payload.content)}`);
    if (turns.length > 12) lines.push(`${turns.length - 12} additional turns in events.ndjson.`);
    lines.push(`Recorded operation intents: ${manifest.operations.length} (${manifest.operations.filter(o => o.boundary === "tool").length} tool, ${manifest.operations.filter(o => o.boundary === "model").length} model)`);
    const intents = new Map(events.filter(e => e.kind === "operation.dispatch_intent").map(e => [e.operationId, e]));
    const outcomes = new Map(events.filter(e => e.kind === "operation.finished").map(e => [e.operationId, e]));
    for (const operation of manifest.operations.slice(0, 16)) {
      const intent = intents.get(operation.id), outcome = outcomes.get(operation.id);
      lines.push(`  ${operation.boundary} ${displayValue(intent?.payload.name)} / ${displayValue(operation.id)}: dispatch ${operation.observed ? "observed" : operation.outcome === "not_dispatched" ? "not dispatched" : "unknown"}; outcome ${operation.outcome ?? "unknown"}`);
      if (operation.boundary === "tool") lines.push(`    Arguments: ${displayValue(intent?.payload.args)}`, `    Recorded result: ${displayValue(outcome?.payload.value)}; error: ${displayValue(outcome?.payload.error)}`);
    }
    if (manifest.operations.length > 16) lines.push("  Additional operations remain in the manifest and event journal.");
    for (const name of ["initial-state.json", "final-state.json"]) {
      const bytes = await read(name);
      lines.push(`${name} (environment observation): ${bytes ? displayValue(parseJson(bytes)) : "not captured"}`);
    }
    if (manifest.cleanup !== "succeeded") lines.push("Next: inspect lease-owned cleanup diagnostics and unresolved activity before another trial.");
    else if (manifest.execution === "adapter_error") lines.push(`Next: inspect the adapter ${firstUser === Infinity ? "entrypoint, required exports and dependencies" : "diagnostics and protocol behavior"}. Repair the reported failure, rebuild and use a new request ID; retain this attempt.`);
    else if (manifest.execution === "not_started") lines.push("Next: inspect this run's preparation or prior-trial failure before starting a new request. This candidate did not run.");
    else if (manifest.evidence.state === "incomplete") lines.push("Next: review the named gaps and captured diagnostics. Repair required capture or state setup, then use a new request ID; retain this attempt.");
    else if (manifest.execution !== "finished") lines.push("Next: inspect the recorded error or cutoff. Complete evidence does not mean successful execution.");
    else lines.push("Next: assess this existing evidence against an independent criterion. No behavioral verdict has been created.");
  }
  return lines.join("\n") + "\n";
}
