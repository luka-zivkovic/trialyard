import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { contract, snapshotContract } from "../contracts/validate.js";
import { parseJson } from "../contracts/strict-json.js";
import { verifyRunIndex } from "../contracts/handoff.js";
import { modelObservation, modelRequest, verifyModelTurn } from "../contracts/models.js";
import type { Cleanup, Execution, Frame, Json, Manifest, Operation, Plan, RunIndex, Snapshot } from "../contracts/types.js";
import { hash, jsonBytes, readJson, safeFile, writeAtomic } from "./files.js";
import { capabilities, resolvePlan, sameTools, type ResolvedPlan } from "./plan.js";
import { Worker, WorkerFailure, WireBudget, DeadlineError, CancelledError, before } from "./process.js";
import { Journal, CaptureLimitError } from "./journal.js";
import { finalizeBundle } from "./bundle.js";
import { verifyAcceptance } from "./acceptance.js";
import { PrivacyError, SecretContext } from "./privacy.js";

interface Options { requestId: string; store: string; signal?: AbortSignal; deadlineAt?: string; rerunOf?: string; secretEnvironment?: NodeJS.ProcessEnv; }
interface RequestRecord { requestId: string; inputSha256: string; runId: string; schemaVersion?: "trial-runner/request/v1"; acceptanceSha256?: string; }
export interface RunResult { index: RunIndex; root: string; duplicate: boolean; acceptanceSha256: string | null; }
export class AcceptedRunError extends Error {
  constructor(readonly root: string, error: unknown) { super(`Accepted run remains unfinished at ${root}: ${error instanceof Error ? error.message : "runner failure"}`); }
}

export async function showRun(store: string, requestId: string): Promise<RunResult> {
  const record = await readJson(path.resolve(store), `requests/${hash(requestId)}.json`) as RequestRecord;
  if (record?.schemaVersion !== undefined) contract("request", record);
  else if (!record || !isDeepStrictEqual(Object.keys(record).sort(), ["inputSha256", "requestId", "runId"]) || !/^[a-f0-9]{64}$/.test(record.inputSha256)) throw new Error("Invalid legacy request record");
  if (record.requestId !== requestId || !/^[a-f0-9-]{36}$/.test(record.runId)) throw new Error("Request store identity mismatch");
  const root = path.join(path.resolve(store), "runs", record.runId);
  try {
    // Check every component beneath the caller-selected store, including the run root.
    const index = contract<RunIndex>("run", parseJson(await safeFile(path.resolve(store), `runs/${record.runId}/run.json`, 8 * 1024 * 1024), 8 * 1024 * 1024));
    if (index.requestId !== requestId || index.runId !== record.runId || index.inputSha256 !== record.inputSha256) throw new Error("Run index identity mismatch");
    if (record.acceptanceSha256) await verifyAcceptance(root, index, record.acceptanceSha256);
    return { index, root, duplicate: true, acceptanceSha256: record.acceptanceSha256 ?? null };
  } catch (error) {
    // A damaged accepted run must never be mistaken for an unused request ID.
    throw new Error(`Accepted request is unreadable: ${error instanceof Error ? error.message : "invalid store"}`);
  }
}

export async function runPlan(filename: string, options: Options): Promise<RunResult> {
  let declared: Plan;
  try { declared = contract<Plan>("plan", await readJson(path.dirname(path.resolve(filename)), path.basename(filename))); }
  catch { throw new Error("Cannot read a valid run plan; check the file and run static validation"); }
  // Available values protect preflight errors; missing/rotated values never replay a prior request.
  const secrets = new SecretContext(declared.secretBindings, options.secretEnvironment, false);
  try { return await runInternal(filename, options, secrets, declared.secretBindings); }
  catch (error) {
    const message = secrets.mask.text(error instanceof Error ? error.message : "Unknown runner failure");
    if (error instanceof AcceptedRunError) throw new AcceptedRunError(secrets.mask.text(error.root), new Error(message));
    if (error instanceof CancelledError) throw new CancelledError(message);
    throw new Error(message);
  }
}

async function runInternal(filename: string, options: Options, secrets: SecretContext, bindings: Plan["secretBindings"]): Promise<RunResult> {
  if (process.versions.node !== "24.15.0" || process.platform === "win32") throw new Error("This preview requires Node 24.15.0 on macOS or Linux");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(options.requestId)) throw new Error("Invalid request ID");
  const resolved = await resolvePlan(filename);
  if (!isDeepStrictEqual(resolved.plan.secretBindings, bindings)) throw new PrivacyError("Secret bindings changed during preflight");
  if (resolved.plan.limits.maxRecordedBytes < 16384) throw new Error("Runtime preview requires at least 16384 recorded bytes");
  if (resolved.plan.limits.maxRecordedBytes > 64 * 1024 * 1024) throw new Error("Runtime preview supports at most 64 MiB of recorded payload");
  const callerDeadline = options.deadlineAt === undefined ? Infinity : Date.parse(options.deadlineAt);
  if (!Number.isFinite(callerDeadline) && callerDeadline !== Infinity) throw new Error("Invalid external deadline");
  const inputSha256 = hash(jsonBytes({ resolvedInputs: resolved.inputSha256, deadlineAt: options.deadlineAt ?? null, rerunOf: options.rerunOf ?? null }));
  const store = path.resolve(options.store);
  const requestFile = path.join(store, "requests", `${hash(options.requestId)}.json`);
  const existing = async (): Promise<RunResult | null> => {
    try {
      const result = await showRun(store, options.requestId);
      if (result.index.inputSha256 !== inputSha256) throw new Error("Request ID conflicts with different accepted inputs");
      return result;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const prior = await existing(); if (prior) return prior;
  secrets.assertComplete();
  secrets.mask.assertPublic({ filename: path.resolve(filename), store, requestId: options.requestId, rerunOf: options.rerunOf, plan: resolved.plan });
  for (const [name, bytes] of resolved.files) {
    secrets.mask.assertPublic(name); secrets.mask.assertPublicBytes(bytes);
    if (name.endsWith(".json")) {
      try { secrets.mask.assertPublic(parseJson(bytes, 16 * 1024 * 1024)); }
      catch (error) { if (error instanceof PrivacyError) throw error; }
    }
  }
  if (options.rerunOf) await showRun(store, options.rerunOf);
  if (callerDeadline <= Date.now()) throw new Error("External deadline already elapsed before acceptance");
  if (options.signal?.aborted) throw new CancelledError("Cancelled before acceptance");
  const runId = randomUUID();
  const root = path.join(store, "runs", runId);
  const index: RunIndex = {
    schemaVersion: "trial-runner/run/v1", runId, requestId: options.requestId, inputSha256, state: "accepted", createdAt: new Date().toISOString(),
    finishedAt: null, rerunOf: options.rerunOf ?? null, deadlineAt: options.deadlineAt ?? null, exitCode: null,
    trials: resolved.scenarios.flatMap(selected => Array.from({ length: resolved.plan.repetitions }, (_, repetition) => {
      const trialId = randomUUID(); return { trialId, scenarioId: selected.scenario.id, repetition, execution: "not_started" as const, bundleSha256: null, path: `trials/${trialId}` };
    })),
  };
  verifyRunIndex(index, resolved.plan, resolved.scenarios.map(s => s.scenario.id));
  secrets.mask.assertPublic(index);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const acceptance = jsonBytes(index); const acceptanceSha256 = hash(acceptance);
  await writeAtomic(path.join(root, "accepted.json"), acceptance);
  await writeAtomic(path.join(root, "run.json"), jsonBytes(index));
  await writeAtomic(path.join(root, "executor.json"), jsonBytes({ pid: process.pid, startedAt: index.createdAt }));
  for (const [name, bytes] of resolved.files) await writeAtomic(path.join(root, "inputs", name), bytes);
  try { await writeAtomic(requestFile, jsonBytes({ schemaVersion: "trial-runner/request/v1", requestId: options.requestId, inputSha256, runId, acceptanceSha256 })); }
  catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = await existing(); if (!winner) throw new Error("Accepted request disappeared"); return winner;
  }
  // The immutable request record is also the exclusive execution claim. No path replays it.
  try {
  let halt: string | null = null;
  let allSuccessful = true;
  let cancelled = false;
  for (const slot of index.trials) {
    if (options.signal?.aborted) { halt = "User cancelled before this trial"; cancelled = true; }
    if (Date.now() >= callerDeadline) halt = "External deadline reached before this trial";
    const selected = resolved.scenarios.find(s => s.scenario.id === slot.scenarioId)!;
    const trialRoot = path.join(root, slot.path);
    const workspace = path.join(root, "work", slot.trialId);
    await fs.mkdir(trialRoot, { recursive: true, mode: 0o700 });
    const journal = await Journal.create(path.join(trialRoot, "events.ndjson"), runId, slot.trialId, resolved.plan.limits, secrets.mask);
    let result: TrialResult;
    try {
      result = await executeTrial(resolved, selected, journal, workspace, callerDeadline, options.signal, halt, slot.repetition, secrets);
      await journal.append("trial.terminal", { execution: result.execution, reason: result.reason }, {}, true);
    } finally { await journal.close(); }
    const bundle = await finalizeBundle(trialRoot, resolved, selected, journal, { ...result, requestId: options.requestId, repetition: slot.repetition });
    slot.execution = bundle.manifest.execution; slot.bundleSha256 = bundle.digest;
    await writeAtomic(path.join(root, "run.json"), jsonBytes(index), true);
    if (!successful(bundle.manifest)) allSuccessful = false;
    if (result.execution === "cancelled") { cancelled = true; halt = "Cancelled run"; }
    if (result.cleanup !== "succeeded") halt = "Prior trial cleanup did not succeed";
    if (["environment_error", "adapter_error", "protocol_error", "runner_error"].includes(result.execution)) halt = "Prior trial infrastructure failure";
  }
  index.state = "finished"; index.finishedAt = new Date().toISOString(); index.exitCode = cancelled || options.signal?.aborted ? 130 : allSuccessful ? 0 : 2;
  verifyRunIndex(index, resolved.plan, resolved.scenarios.map(s => s.scenario.id));
  await writeAtomic(path.join(root, "run.json"), jsonBytes(index), true);
  return { index, root, duplicate: false, acceptanceSha256 };
  } catch (error) { throw new AcceptedRunError(root, error); }
}

const successful = (manifest: Manifest): boolean => manifest.execution === "finished" && manifest.evidence.state === "complete" && manifest.cleanup === "succeeded";

interface TrialResult { execution: Execution; reason: string | null; cleanup: Cleanup; initial: Snapshot | null; final: Snapshot | null; extraGaps: string[]; observations: Map<string, Buffer>; }
async function executeTrial(resolved: ResolvedPlan, selected: ResolvedPlan["scenarios"][number], journal: Journal, workspace: string,
  callerDeadline: number, signal: AbortSignal | undefined, skip: string | null, repetition: number, secrets: SecretContext): Promise<TrialResult> {
  const { plan } = resolved;
  const result: TrialResult = { execution: "not_started", reason: skip, cleanup: "succeeded", initial: null, final: null, extraGaps: [], observations: new Map() };
  await journal.append("trial.started", { scenarioId: selected.scenario.id, repetition });
  if (skip) return result;
  let environment: Worker | null = null;
  let agent: Worker | null = null;
  let prepared = false;
  let running = false;
  let stopping = false;
  let primaryFailure: unknown;
  const wireBudget = new WireBudget(plan.limits);
  const capture = async (name: string, value: unknown): Promise<void> => {
    const bytes = jsonBytes(value); await journal.capture(name, bytes); result.observations.set(name, bytes);
  };
  const gap = async (reason: string): Promise<void> => {
    result.extraGaps.push(reason);
    if (!journal.events.some(event => event.kind === "capture.gap")) await journal.append("capture.gap", { reason }, {}, true);
  };
  const lateFailure = async (error: unknown): Promise<void> => {
    if (error === primaryFailure) return;
    if (error instanceof CancelledError || error instanceof DeadlineError) return;
    if (error instanceof CaptureLimitError) await gap("capture_limit_exceeded");
    else if (error instanceof WorkerFailure) await gap(error.boundary === "protocol" ? "protocol_error_during_stop" : "worker_failure_during_stop");
    else throw error; // A filesystem failure leaves the accepted run unfinished.
  };
  const localStop = new AbortController();
  const operationSignal = signal ? AbortSignal.any([signal, localStop.signal]) : localStop.signal;
  let turnId: string | null = null;
  let deadline = Math.min(callerDeadline, Date.now() + plan.limits.prepareMs);
  const operations = new Map<string, Operation & { turnId: string; parent?: string | null }>();
  const check = (until = deadline, cancel = signal): void => {
    if (cancel?.aborted) throw new CancelledError("User cancellation");
    if (Date.now() >= until) throw new DeadlineError("Deadline reached");
  };
  const race = <T>(dispatch: () => Promise<T>): Promise<T> => {
    check(); return before(Promise.race([dispatch(), ...(environment ? [environment.failure] : []), ...(agent && running ? [agent.failure] : [])]), deadline, signal);
  };
  const flushDiagnostics: (() => Promise<void>)[] = [];
  const diagnostic = (channel: "agent" | "environment") => {
    const stream = secrets.mask.stream();
    const write = async (result: { text: string; redacted: boolean }) => {
      if (result.redacted) journal.redactedPaths.add("events.ndjson");
      if (result.text) await journal.append("diagnostic", { channel, text: result.text });
    };
    flushDiagnostics.push(() => write(stream.end()));
    return (text: string) => write(stream.write(text));
  };
  const receive = async (worker: Worker, frame: Frame): Promise<void> => {
    if (frame.kind === "agent_error" || frame.kind === "environment_error") throw new WorkerFailure(worker.role, String(frame.payload.message), frame.kind === "agent_error");
    if (frame.kind === "event") {
      if (worker.role === "agent") {
        const kind = frame.payload.kind as "operation.dispatch_intent" | "operation.dispatch_observed" | "operation.finished";
        const id = String(frame.payload.operationId), logical = frame.payload.logicalCallId as string | null, parent = frame.payload.parentOperationId as string | null;
        const data = frame.payload.data as Record<string, Json>;
        if (resolved.profile.modelCapture === "not_applicable") throw new WorkerFailure("protocol", "Model operation contradicts declared capture capability");
        let op = operations.get(id);
        if (kind === "operation.dispatch_intent") {
          if (!running || stopping || !turnId || op || data.boundary !== "model" || data.owner !== "agent") throw new WorkerFailure("protocol", "Invalid model dispatch intent");
          check();
          try { if (modelRequest(data.args).model !== data.name) throw new Error("Model identity mismatch"); }
          catch { throw new WorkerFailure("protocol", "Invalid model request metadata"); }
          if (parent && (operations.get(parent)?.owner !== "agent" || operations.get(parent)?.outcome !== null || operations.get(parent)?.turnId !== turnId)) throw new WorkerFailure("protocol", "Unknown or closed model parent");
          op = { id, logicalCallId: logical, boundary: "model", owner: "agent", observed: false, outcome: null, turnId, parent };
          const event = await journal.append(kind, data, { source: "adapter_reported", operationId: id, logicalCallId: logical, parentOperationId: parent, turnId });
          operations.set(id, op);
          // The adapter must not dispatch before this durable acknowledgment.
          if (stopping || signal?.aborted || Date.now() >= deadline) {
            await journal.append("operation.finished", { outcome: "not_dispatched", value: null, error: "Stopped before model intent acknowledgment", model: null }, { operationId: id, logicalCallId: logical, parentOperationId: parent, turnId: op.turnId }, true);
            op.outcome = "not_dispatched"; check(); throw new CancelledError("Stopped before model acknowledgment");
          }
          worker.reply(frame, "event_ack", { sequence: event.sequence }); return;
        }
        if (!op || op.owner !== "agent" || op.outcome !== null || op.logicalCallId !== logical || (op.parent ?? null) !== parent) throw new WorkerFailure("protocol", "Unknown, closed or mismatched model operation");
        if (kind === "operation.dispatch_observed") {
          if (op.observed) throw new WorkerFailure("protocol", "Duplicate model dispatch observation");
        } else {
          if ((data.outcome === "not_dispatched" && (op.observed || data.model != null)) || (["known_result", "known_failure"].includes(String(data.outcome)) && !op.observed)) throw new WorkerFailure("protocol", "Model outcome contradicts observed dispatch");
          if ([...operations.values()].some(child => child.parent === id && child.outcome === null)) throw new WorkerFailure("protocol", "Model parent closed with open child");
          try { if (data.model !== undefined) modelObservation(data.model); } catch { throw new WorkerFailure("protocol", "Invalid model observation metadata"); }
        }
        const event = await journal.append(kind, data, { source: "adapter_reported", operationId: id, logicalCallId: logical, parentOperationId: parent, turnId: op.turnId });
        if (kind === "operation.dispatch_observed") op.observed = true; else op.outcome = data.outcome as Operation["outcome"];
        worker.reply(frame, "event_ack", { sequence: event.sequence }); return;
      }
      const op = operations.get(String(frame.payload.operationId));
      if (worker.role !== "environment" || frame.payload.kind !== "operation.dispatch_observed" || !op || op.owner !== "runner" || op.boundary !== "tool" || op.observed || op.outcome !== null || frame.payload.parentOperationId !== null || frame.payload.logicalCallId !== null) throw new WorkerFailure("protocol", "Unsupported or mismatched operation event");
      const event = await journal.append("operation.dispatch_observed", {}, { source: "environment_observed", operationId: op.id, turnId: op.turnId, logicalCallId: op.logicalCallId });
      op.observed = true;
      worker.reply(frame, "event_ack", { sequence: event.sequence });
      return;
    }
    if (worker.role !== "agent" || frame.kind !== "tool_call" || !environment || !running || stopping || frame.payload.turnId !== turnId) throw new WorkerFailure("protocol", "Unexpected business request");
    if (worker.failureCause) throw worker.failureCause;
    if (signal?.aborted) throw new CancelledError("User cancellation");
    if (Date.now() >= deadline) throw new DeadlineError("Deadline reached");
    const name = String(frame.payload.tool);
    const validate = resolved.toolInputs.get(name);
    if (!validate || !validate(frame.payload.args)) throw new WorkerFailure("protocol", "Unsupported tool or invalid arguments");
    const id = randomUUID();
    const op: Operation & { turnId: string } = { id, turnId: turnId!, logicalCallId: frame.payload.logicalCallId as string | null, boundary: "tool", owner: "runner", observed: false, outcome: null };
    await journal.append("operation.dispatch_intent", { boundary: "tool", owner: "runner", name, args: frame.payload.args! }, { operationId: id, turnId, logicalCallId: op.logicalCallId });
    operations.set(id, op);
    // Only this path dispatches tools, and it runs strictly after the durable intent append.
    if (stopping || signal?.aborted || Date.now() >= deadline) {
      await journal.append("operation.finished", { outcome: "not_dispatched", value: null, error: "Stopped before environment dispatch" }, { operationId: id, turnId: op.turnId, logicalCallId: op.logicalCallId }, true);
      op.outcome = "not_dispatched"; throw new DeadlineError("Stopped before environment dispatch");
    }
    const response = await before(environment.request("execute", { operationId: id, tool: name, args: frame.payload.args! }), deadline, operationSignal);
    if (response.payload.outcome === "known_result" && !resolved.toolOutputs.get(name)!(response.payload.value)) throw new WorkerFailure("environment", "Tool result violates pinned schema");
    if (!op.observed && ["known_result", "known_failure"].includes(String(response.payload.outcome))) throw new WorkerFailure("protocol", "Environment result lacks dispatch observation");
    if (stopping) return;
    await journal.append("operation.finished", { outcome: response.payload.outcome!, value: response.payload.value!, error: response.payload.error! }, { source: "environment_observed", operationId: id, turnId: op.turnId, logicalCallId: op.logicalCallId });
    op.outcome = response.payload.outcome as Operation["outcome"];
    worker.reply(frame, "tool_result", response.payload);
  };
  try {
    await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of resolved.files) await writeAtomic(path.join(workspace, name), bytes);
    check();
    environment = new Worker("environment", journal.trialId, plan.environment, workspace, plan.limits, receive, diagnostic("environment"), wireBudget, secrets.environment("environment"));
    const described = await race(() => environment!.request("describe", { adapterId: plan.environment.adapterId, adapterVersion: plan.environment.adapterVersion }));
    if (described.payload.adapterId !== plan.environment.adapterId || described.payload.adapterVersion !== plan.environment.adapterVersion) throw new WorkerFailure("environment", "Environment identity mismatch");
    try { capabilities(described.payload.capabilities as string[], plan.environment.capabilities, "effective environment"); sameTools(described.payload.tools, resolved.tools); }
    catch { throw new WorkerFailure("environment", "Effective environment capability or tool schema mismatch"); }
    await capture("environment-described.json", described);
    for (const fault of plan.environment.faultPlan) if (!(described.payload.faultModes as string[]).includes(fault.mode)) throw new WorkerFailure("environment", "Unsupported fault capability");
    const lease = await race(() => environment!.request("prepare", { state: selected.fixture, settings: plan.environment.settings, faultPlan: plan.environment.faultPlan as unknown as Json, clock: plan.environment.clock }));
    const initial = validSnapshot(lease.payload.snapshot, resolved);
    await journal.capture("initial-state.json", jsonBytes(initial)); result.initial = initial;
    await capture("environment-prepared.json", lease);
    if (!result.initial.stable || result.initial.pendingOperations.length) throw new WorkerFailure("environment", "Initial state is not stable");
    prepared = true;
    deadline = Math.min(callerDeadline, Date.now() + plan.limits.trialMs);
    check();
    agent = new Worker("agent", journal.trialId, plan.agent, workspace, plan.limits, receive, diagnostic("agent"), wireBudget, secrets.environment("agent"));
    const ready = await race(() => agent!.request("start", { adapterId: plan.agent.adapterId, adapterVersion: plan.agent.adapterVersion,
      artifactSha256: hash(resolved.artifacts.agent.bytes), settings: plan.agent.settings, tools: resolved.tools as unknown as Json,
      limits: { ...plan.limits }, bindings: lease.payload.bindings!, modelCapture: resolved.profile.modelCapture }));
    if (ready.payload.adapterId !== plan.agent.adapterId || ready.payload.adapterVersion !== plan.agent.adapterVersion || ready.payload.artifactSha256 !== hash(resolved.artifacts.agent.bytes) || ready.payload.modelCapture !== resolved.profile.modelCapture) throw new WorkerFailure("protocol", "Effective agent identity or capture mismatch");
    try { capabilities(ready.payload.capabilities as string[], plan.agent.capabilities, "effective agent"); }
    catch { throw new WorkerFailure("protocol", "Effective agent capability mismatch"); }
    await capture("agent-ready.json", ready);
    running = true;
    for (const message of selected.scenario.messages) {
      if (signal?.aborted) throw new CancelledError("User cancellation");
      if (Date.now() >= deadline) throw new DeadlineError("Deadline reached");
      turnId = message.id;
      await journal.append("user.turn", { content: message.content }, { turnId });
      const response = await race(() => agent!.request("user_turn", { turnId, content: message.content }));
      if ([...operations.values()].some(op => op.outcome === null)) throw new WorkerFailure("protocol", "Assistant finished with open operations");
      try { verifyModelTurn(response.payload.modelOperations, [...operations.values()].filter(op => op.boundary === "model" && op.turnId === turnId).map(op => op.id)); }
      catch { throw new WorkerFailure("protocol", "Model turn coverage differs from recorded operations"); }
      await journal.append("assistant.turn", { content: response.payload.output!, ...(response.payload.modelOperations !== undefined ? { modelOperations: response.payload.modelOperations } : {}) }, { turnId, source: "candidate_claim" });
      turnId = null;
    }
    result.execution = "finished";
  } catch (error) {
    primaryFailure = error;
    const originalMessage = error instanceof Error ? error.message : "Unknown runner failure";
    const safeMessage = secrets.mask.text(originalMessage);
    if (secrets.mask.contains(originalMessage)) journal.redactedPaths.add("events.ndjson");
    const summary = errorSummary(new Error(safeMessage));
    const message = summary.message;
    result.reason = message;
    result.execution = !prepared ? "not_started" : error instanceof CancelledError ? "cancelled" : error instanceof DeadlineError ? "timed_out"
      : error instanceof WorkerFailure ? (error.boundary === "agent" ? (running && error.candidateFailure ? "agent_error" : "adapter_error") : error.boundary === "environment" ? "environment_error" : "protocol_error")
      : error instanceof CaptureLimitError ? "protocol_error" : "runner_error";
    stopping = true;
    if (error instanceof CaptureLimitError || (error instanceof WorkerFailure && /limit/.test(message))) {
      await gap("capture_limit_exceeded");
    }
    if (summary.truncated) await gap("error_message_truncated");
    await journal.append(result.execution === "agent_error" ? "agent.error" : "runtime.error",
      result.execution === "agent_error" ? { message } : { message, execution: result.execution }, {}, true);
  } finally {
    stopping = true;
    localStop.abort();
    try {
      if (agent) {
        try {
          const stopped = await before(agent.request("stop", { reason: result.execution }), Date.now() + plan.limits.stopGraceMs);
          await capture("agent-stopped.json", stopped);
          if ((stopped.payload.outstandingOperationIds as string[]).length) await gap("agent_reported_outstanding_work");
        } catch (error) {
          if (error instanceof CaptureLimitError) await lateFailure(error);
          else if (!(error instanceof WorkerFailure || error instanceof DeadlineError || error instanceof CancelledError)) throw error;
          // Local termination below does not attest remote cancellation.
        }
        await agent.terminate(plan.limits.stopGraceMs);
      }
      if (environment) {
        if (prepared) {
          try {
            if (Date.now() >= callerDeadline) throw new DeadlineError("Caller deadline reached before final snapshot");
            const response = await before(environment.request("snapshot", {}), Math.min(callerDeadline, Date.now() + plan.limits.snapshotMs));
            if (response.payload.snapshot !== null) {
              const final = validSnapshot(response.payload.snapshot, resolved);
              await journal.capture("final-state.json", jsonBytes(final)); result.final = final;
            }
          } catch (error) {
            result.extraGaps.push("final_snapshot_unavailable");
            if (error instanceof CaptureLimitError) await lateFailure(error);
            else if (!(error instanceof WorkerFailure || error instanceof DeadlineError || error instanceof CancelledError)) throw error;
          }
        }
        try {
          const disposed = await before(environment.request("dispose", {}), Date.now() + plan.limits.cleanupMs);
          result.cleanup = disposed.payload.status as Cleanup;
          // The durable disposal frame owns cleanup metadata outside the copied
          // input workspace; candidate files may themselves be named cleanup.json.
          await capture("environment-disposed.json", disposed);
        } catch (error) {
          result.cleanup = "unknown";
          if (error instanceof CaptureLimitError) await lateFailure(error);
          else if (!(error instanceof WorkerFailure || error instanceof DeadlineError || error instanceof CancelledError)) throw error;
        }
      }
    } finally {
      // Even snapshot, cleanup or journal I/O failures must stop every owned worker.
      const workers = [agent, environment].filter((worker): worker is Worker => worker !== null);
      const terminated = await Promise.allSettled(workers.map(worker => worker.terminate(plan.limits.stopGraceMs)));
      const drained = await Promise.allSettled(workers.map(worker => worker.drain()));
      for (const outcome of [...terminated, ...drained]) if (outcome.status === "rejected") throw outcome.reason;
    }
    // Drain captured observations before assigning unknown outcomes and closing the journal.
    for (const worker of [agent, environment]) if (worker) {
      for (const failure of worker.failureCauses) await lateFailure(failure);
    }
    for (const flush of flushDiagnostics) {
      try { await flush(); } catch (error) { await lateFailure(error); }
    }
    for (const op of [...operations.values()].reverse()) if (op.outcome === null) {
      await journal.append("operation.finished", { outcome: "outcome_unknown", value: null, error: "No terminal operation response before stop" }, { operationId: op.id, turnId: op.turnId, logicalCallId: op.logicalCallId, parentOperationId: op.parent ?? null }, true);
      op.outcome = "outcome_unknown";
    }
    // Detect a worker changing a pinned artifact during its own execution.
    try {
      for (const [name, bytes] of resolved.files) if (!isDeepStrictEqual(await safeFile(workspace, name), bytes)) result.extraGaps.push("executed_input_changed");
    } catch { result.extraGaps.push("executed_input_unavailable"); }
    if (result.cleanup === "succeeded") await fs.rm(workspace, { recursive: true, force: true });
  }
  return result;
}

/** Keep both terminal summaries inside their reserved serialized bytes. */
function errorSummary(error: unknown): { message: string; truncated: boolean } {
  const raw = error instanceof Error ? error.message : "Unknown runner failure";
  if (Buffer.byteLength(JSON.stringify(raw)) <= 1024) return { message: raw, truncated: false };
  let end = Math.min(raw.length, 1024);
  while (Buffer.byteLength(JSON.stringify(raw.slice(0, end) + " [truncated]")) > 1024) end--;
  if (end && /[\uD800-\uDBFF]/.test(raw[end - 1]!)) end--;
  return { message: raw.slice(0, end) + " [truncated]", truncated: true };
}

function validSnapshot(value: unknown, resolved: ResolvedPlan): Snapshot {
  let snapshot: Snapshot;
  try { snapshot = snapshotContract(value); } catch { throw new WorkerFailure("environment", "Invalid snapshot observation metadata"); }
  if (!resolved.fixtureValidator(snapshot.state)) throw new WorkerFailure("environment", "Invalid snapshot contract");
  return parseJson(jsonBytes(snapshot)) as Snapshot;
}
