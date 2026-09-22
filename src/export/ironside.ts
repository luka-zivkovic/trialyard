import { isDeepStrictEqual } from "node:util";
import { verifyBundle } from "../contracts/verify.js";
import { verifyEvents } from "../contracts/events.js";
import { modelObservation, modelRequest } from "../contracts/models.js";
import { contract, snapshotContract } from "../contracts/validate.js";
import { parseJson } from "../contracts/strict-json.js";
import { hash, safeFile } from "../core/files.js";
import { verifyRedactedBundle } from "./redacted.js";
import type { Event, Execution, Cleanup, FileRecord, Json, Snapshot } from "../contracts/types.js";

/** Ironside native ingest limits (packages/shared envelope.ts and apps/api app.ts). */
export const IRONSIDE_MAX_EVENTS_PER_REQUEST = 500;
export const IRONSIDE_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const IRONSIDE_KEY_VARIABLE = "IRONSIDE_API_KEY";

export type CaptureStatus = "observed" | "observed_masked" | "redacted" | "not_captured";
export interface IronsideSource {
  bundleSha256: string; bundleKind: "native" | "redacted-derivative"; parentBundleSha256: string | null;
  runId: string; requestId: string; trialId: string; scenarioId: string; repetition: number;
  execution: Execution; cleanup: Cleanup; evidenceState: "complete" | "incomplete"; gaps: string[]; redactedPaths: string[];
  captureBoundary: string | null; agentArtifactSha256: string | null; authenticity: "not_attested";
}
type Metadata = Record<string, string>;
interface TraceBody {
  id: string; timestamp: string; name: string; sessionId: string; tags: string[]; metadata: Metadata; input?: Json; output: Json;
}
interface ObservationBody {
  id: string; traceId: string; parentObservationId?: string; type: "span" | "generation" | "event"; name: string;
  startTime: string; endTime?: string; level: "debug" | "default" | "warning" | "error"; statusMessage?: string;
  model?: string; modelParameters?: Record<string, string | number | boolean | null>; input?: Json; output?: Json;
  usageDetails?: Record<string, number>; costDetails?: Record<string, number>; metadata: Metadata;
}
export type IngestEvent = { type: "trace-upsert"; body: TraceBody } | { type: "observation-upsert"; body: ObservationBody };
export interface IronsideIngest {
  schemaVersion: "trial-runner/ironside-ingest/v1";
  target: { product: "ironside"; wire: "native-json-ingest"; endpoint: "/api/v1/ingest"; ingestSchemaVersion: 1 };
  source: IronsideSource; traceId: string; requests: { events: IngestEvent[] }[];
}
/** Retained, verified content. Absent parts are null and never replaced by empty values. */
export interface IronsideContent { events: Event[] | null; initial: Snapshot | null; final: Snapshot | null; }

const iso = (value: string): string => new Date(Date.parse(value)).toISOString();
const text = (value: unknown): string => JSON.stringify(value);

function status(file: string, retained: boolean, source: IronsideSource): CaptureStatus {
  const listed = source.redactedPaths.includes(file);
  if (retained) return listed ? "observed_masked" : "observed";
  return listed ? "redacted" : "not_captured";
}

/** Pure, policy-free mapping. It must never improve source trust or completeness. */
export function ironsideIngest(source: IronsideSource, content: IronsideContent): IronsideIngest {
  const traceId = `trialyard-${source.bundleSha256}`;
  const events = content.events ?? [];
  const capture = {
    conversation: status("events.ndjson", content.events !== null, source),
    toolActivity: status("events.ndjson", content.events !== null, source),
    initialState: status("initial-state.json", content.initial !== null, source),
    finalState: status("final-state.json", content.final !== null, source),
  };
  const first = events[0]?.recordedAt ?? content.initial?.observedAt ?? content.final?.observedAt;
  if (!first) throw new Error("IRONSIDE_EXPORT_NO_TIMESTAMP: no retained observation carries a time; nothing is fabricated");
  const timestamp = iso(first);
  const lastTime = events.length ? iso(events.at(-1)!.recordedAt) : timestamp;
  const id = (suffix: string): string => `${traceId}-${suffix}`;
  const observations: ObservationBody[] = [];
  const base = (event: Event): Metadata => ({ "trialyard.source": event.source, "trialyard.sequences": String(event.sequence),
    ...(event.producerTimestamp !== null ? { "trialyard.producerTimestamp": event.producerTimestamp } : {}) });

  const stateObservation = (name: "initial" | "final", snapshot: Snapshot | null, captured: CaptureStatus, placement: string, placementLabel: string): ObservationBody => snapshot
    ? { id: id(`state-${name}`), traceId, type: "event", name: `environment.${name}_state`, startTime: iso(snapshot.observedAt), level: "default", output: snapshot as unknown as Json,
      metadata: { "trialyard.source": "environment_observed", "trialyard.capture": captured, "trialyard.timestampSource": "snapshot.observedAt",
        "trialyard.stable": String(snapshot.stable), "trialyard.pendingOperations": text(snapshot.pendingOperations) } }
    : { id: id(`state-${name}`), traceId, type: "event", name: `environment.${name}_state`, startTime: placement, level: "warning",
      statusMessage: `${name} environment state was not observed in the exported evidence (${captured})`,
      metadata: { "trialyard.source": "environment_observed", "trialyard.capture": captured, "trialyard.unobserved": "true", "trialyard.timestampSource": placementLabel } };

  observations.push(stateObservation("initial", content.initial, capture.initialState, timestamp, "placement:trace_start"));
  const turns = new Map<string, ObservationBody>();
  const operations = new Map<string, ObservationBody>();
  for (const event of events) {
    const turnParent = event.turnId !== null ? turns.get(event.turnId)?.id : undefined;
    if (event.kind === "user.turn") {
      const turn: ObservationBody = { id: id(`turn-${event.turnId}`), traceId, type: "span", name: `turn:${event.turnId}`, startTime: iso(event.recordedAt), level: "default",
        input: event.payload.content, metadata: { ...base(event), "trialyard.turnId": event.turnId!, "trialyard.input.source": event.source, "trialyard.claim": "not_observed" } };
      turns.set(event.turnId!, turn); observations.push(turn);
    } else if (event.kind === "assistant.turn") {
      const turn = turns.get(event.turnId!)!;
      turn.endTime = iso(event.recordedAt); turn.output = event.payload.content;
      turn.metadata["trialyard.sequences"] += `,${event.sequence}`;
      turn.metadata["trialyard.claim"] = "observed"; turn.metadata["trialyard.output.source"] = event.source;
      if (event.payload.modelOperations !== undefined) turn.metadata["trialyard.modelOperations"] = text(event.payload.modelOperations);
    } else if (event.kind === "operation.dispatch_intent") {
      const operationId = event.operationId!;
      const parent = event.parentOperationId !== null ? operations.get(event.parentOperationId)?.id : turnParent;
      const metadata: Metadata = { ...base(event), "trialyard.operationId": operationId, "trialyard.owner": String(event.payload.owner),
        "trialyard.boundary": String(event.payload.boundary), "trialyard.dispatch": "not_observed", "trialyard.outcome": "not_recorded",
        ...(event.logicalCallId !== null ? { "trialyard.logicalCallId": event.logicalCallId } : {}),
        ...(event.parentOperationId !== null ? { "trialyard.parentOperationId": event.parentOperationId } : {}) };
      const observation: ObservationBody = { id: id(`op-${operationId}`), traceId, ...(parent ? { parentObservationId: parent } : {}),
        type: event.payload.boundary === "model" ? "generation" : "span", name: String(event.payload.name), startTime: iso(event.recordedAt), level: "default", metadata };
      if (event.payload.boundary === "model") {
        const request = modelRequest(event.payload.args);
        observation.model = request.model; observation.input = request.input;
        const scalars = Object.entries(request.settings).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value));
        if (scalars.length) observation.modelParameters = Object.fromEntries(scalars) as Record<string, string | number | boolean | null>;
        metadata["trialyard.requestedProvider"] = request.provider; metadata["trialyard.requestedModel"] = request.model;
        if (scalars.length !== Object.keys(request.settings).length) metadata["trialyard.requestSettings"] = text(request.settings);
      } else observation.input = event.payload.args ?? null;
      operations.set(operationId, observation); observations.push(observation);
    } else if (event.kind === "operation.dispatch_observed" || event.kind === "operation.finished") {
      const observation = operations.get(event.operationId!)!;
      observation.metadata["trialyard.sequences"] += `,${event.sequence}`;
      if (event.kind === "operation.dispatch_observed") { observation.metadata["trialyard.dispatch"] = "observed"; continue; }
      const outcome = String(event.payload.outcome);
      observation.endTime = iso(event.recordedAt);
      observation.metadata["trialyard.outcome"] = outcome; observation.metadata["trialyard.outcome.source"] = event.source;
      if (outcome === "known_result") observation.output = event.payload.value ?? null;
      else if (outcome === "known_failure") { observation.level = "error"; if (typeof event.payload.error === "string") observation.statusMessage = event.payload.error; }
      else {
        observation.level = "warning";
        observation.statusMessage = outcome === "outcome_unknown" ? "Operation outcome is unknown; no result was observed" : "Operation was known not to be dispatched";
        if (typeof event.payload.error === "string") observation.metadata["trialyard.error"] = event.payload.error;
      }
      const model = event.payload.model === undefined ? null : modelObservation(event.payload.model);
      if (model) {
        observation.metadata["trialyard.observedModel"] = text({ provider: model.provider, model: model.model, modelRevision: model.modelRevision, requestId: model.requestId });
        if (model.model !== null) observation.model = model.model;
        if (model.usage) {
          const usage: Record<string, number> = {};
          if (model.usage.inputTokens !== null) usage.input_tokens = model.usage.inputTokens;
          if (model.usage.outputTokens !== null) usage.output_tokens = model.usage.outputTokens;
          if (Object.keys(usage).length) observation.usageDetails = usage;
          observation.metadata["trialyard.usage.source"] = model.usage.source;
        } else observation.metadata["trialyard.usage.source"] = "not_reported";
        if (model.cost) {
          if (model.cost.amount !== null && model.cost.currency === "USD") observation.costDetails = { total: model.cost.amount };
          observation.metadata["trialyard.cost"] = text(model.cost);
        }
      } else if (observation.type === "generation") observation.metadata["trialyard.usage.source"] = "not_reported";
    } else {
      const level = event.kind === "agent.error" || event.kind === "runtime.error" ? "error"
        : event.kind === "capture.gap" || (event.kind === "trial.terminal" && event.payload.execution !== "finished") ? "warning"
        : event.kind === "diagnostic" ? "debug" : "default";
      const observation: ObservationBody = { id: id(`ev-${event.sequence}`), traceId, ...(turnParent ? { parentObservationId: turnParent } : {}), type: "event",
        name: event.kind, startTime: iso(event.recordedAt), level, output: event.payload, metadata: base(event) };
      if (typeof event.payload.message === "string") observation.statusMessage = event.payload.message;
      if (event.kind === "capture.gap") observation.metadata["trialyard.captureGap"] = String(event.payload.reason);
      if (event.turnId !== null) observation.metadata["trialyard.turnId"] = event.turnId;
      observations.push(observation);
    }
  }
  observations.push(stateObservation("final", content.final, capture.finalState, lastTime, content.events ? "placement:last_event" : "placement:trace_start"));

  const lastClaim = [...events].reverse().find(event => event.kind === "assistant.turn");
  const unobserved = Object.entries(capture).filter(([, value]) => value !== "observed").map(([part]) => part);
  const claimStatus = lastClaim ? "observed" : content.events === null ? capture.conversation : "not_observed";
  const stateStatus = capture.finalState;
  const tags = ["trialyard", `trialyard:run:${source.runId}`, `trialyard:scenario:${source.scenarioId}`, `trialyard:repetition:${source.repetition}`,
    `trialyard:bundle:${source.bundleSha256}`, `trialyard:evidence:${source.evidenceState}`, `trialyard:execution:${source.execution}`];
  const metadata: Metadata = {
    "trialyard.mappingVersion": "trial-runner/ironside-ingest/v1", "trialyard.runId": source.runId, "trialyard.requestId": source.requestId,
    "trialyard.trialId": source.trialId, "trialyard.scenarioId": source.scenarioId, "trialyard.repetition": String(source.repetition),
    "trialyard.bundleSha256": source.bundleSha256, "trialyard.bundleKind": source.bundleKind, "trialyard.execution": source.execution,
    "trialyard.cleanup": source.cleanup, "trialyard.evidenceState": source.evidenceState, "trialyard.evidenceGaps": text(source.gaps),
    "trialyard.redactedPaths": text(source.redactedPaths), "trialyard.authenticity": source.authenticity,
    "trialyard.capture.conversation": capture.conversation, "trialyard.capture.toolActivity": capture.toolActivity,
    "trialyard.capture.initialState": capture.initialState, "trialyard.capture.finalState": capture.finalState,
    "trialyard.unobserved": text(unobserved), "trialyard.claimedOutcome.status": claimStatus, "trialyard.observedState.status": stateStatus,
    ...(source.parentBundleSha256 !== null ? { "trialyard.parentBundleSha256": source.parentBundleSha256 } : {}),
    ...(source.captureBoundary !== null ? { "trialyard.captureBoundary": source.captureBoundary } : {}),
    ...(source.agentArtifactSha256 !== null ? { "trialyard.agentArtifactSha256": source.agentArtifactSha256 } : {}),
  };
  const userTurns = events.filter(event => event.kind === "user.turn").map(event => ({ turnId: event.turnId, content: event.payload.content }));
  const trace: TraceBody = {
    id: traceId, timestamp, name: `trialyard ${source.scenarioId} #${source.repetition}`, sessionId: `trialyard-run:${source.runId}`, tags, metadata,
    ...(content.events !== null ? { input: { source: "runner_observed", turns: userTurns } as unknown as Json } : {}),
    output: {
      candidateClaim: { source: "candidate_claim", status: claimStatus, ...(lastClaim ? { content: lastClaim.payload.content } : {}) },
      observedFinalState: { source: "environment_observed", status: stateStatus, ...(content.final ? { stable: content.final.stable,
        pendingOperations: content.final.pendingOperations, observedAt: content.final.observedAt, state: content.final.state } : {}) },
    } as unknown as Json,
  };
  const ingest: IngestEvent[] = [{ type: "trace-upsert", body: trace }, ...observations.map(body => ({ type: "observation-upsert" as const, body }))];
  return contract<IronsideIngest>("ironsideIngest", {
    schemaVersion: "trial-runner/ironside-ingest/v1",
    target: { product: "ironside", wire: "native-json-ingest", endpoint: "/api/v1/ingest", ingestSchemaVersion: 1 },
    source, traceId, requests: batches(ingest),
  });
}

/** Split into Ironside-sized requests without truncating any event. */
export function batches(events: IngestEvent[]): { events: IngestEvent[] }[] {
  const overhead = Buffer.byteLength(JSON.stringify({ events: [] }));
  const result: { events: IngestEvent[] }[] = [];
  let current: IngestEvent[] = [], bytes = overhead;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (overhead + size > IRONSIDE_MAX_REQUEST_BYTES) throw new Error("IRONSIDE_EVENT_TOO_LARGE: one mapped observation exceeds the Ironside request body limit");
    if (current.length === IRONSIDE_MAX_EVENTS_PER_REQUEST || bytes + size > IRONSIDE_MAX_REQUEST_BYTES) { result.push({ events: current }); current = []; bytes = overhead; }
    current.push(event); bytes += size;
  }
  if (current.length) result.push({ events: current });
  return result;
}

/** Verifies the source (native, or a derivative against its local original) and reads only retained files. */
export async function loadIronsideSource(root: string, options: { sourceRoot?: string; sha256?: string }): Promise<{ source: IronsideSource; content: IronsideContent }> {
  let source: IronsideSource, files: FileRecord[];
  if (options.sourceRoot !== undefined) {
    const { manifest, digest } = await verifyRedactedBundle(root, options.sourceRoot, options.sha256);
    files = manifest.files;
    source = { bundleSha256: digest, bundleKind: "redacted-derivative", parentBundleSha256: manifest.parentBundleSha256, runId: manifest.runId,
      requestId: manifest.requestId, trialId: manifest.trialId, scenarioId: manifest.scenarioId, repetition: manifest.repetition,
      execution: manifest.execution, cleanup: manifest.cleanup, evidenceState: manifest.evidence.state, gaps: [...manifest.evidence.gaps],
      redactedPaths: [...manifest.evidence.redactedPaths], captureBoundary: null, agentArtifactSha256: null, authenticity: "not_attested" };
  } else {
    const { manifest, digest } = await verifyBundle(root, options.sha256);
    files = manifest.files;
    source = { bundleSha256: digest, bundleKind: "native", parentBundleSha256: null, runId: manifest.runId, requestId: manifest.requestId,
      trialId: manifest.trialId, scenarioId: manifest.scenarioId, repetition: manifest.repetition, execution: manifest.execution,
      cleanup: manifest.cleanup, evidenceState: manifest.evidence.state, gaps: [...manifest.evidence.gaps], redactedPaths: [...manifest.evidence.redactedPaths],
      captureBoundary: manifest.fidelity.boundary, agentArtifactSha256: manifest.identity.agentArtifactSha256, authenticity: "not_attested" };
  }
  const read = async (name: string): Promise<Buffer | null> => {
    const record = files.find(file => file.path === name);
    if (!record) return null;
    const bytes = await safeFile(root, name);
    if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) throw new Error("Source changed after verification");
    return bytes;
  };
  const log = await read("events.ndjson");
  const events = log === null ? null : verifyEvents(new TextDecoder("utf-8", { fatal: true }).decode(log).slice(0, -1).split("\n").map(line => parseJson(line)), source.runId, source.trialId).events;
  const snapshot = async (name: string): Promise<Snapshot | null> => { const bytes = await read(name); return bytes === null ? null : snapshotContract(parseJson(bytes, 64 * 1024 * 1024)); };
  return { source, content: { events, initial: await snapshot("initial-state.json"), final: await snapshot("final-state.json") } };
}

/** Consumer-side check: the document must equal the mapping re-derived from the verified source. */
export function verifyIronsideIngest(value: unknown, source: IronsideSource, content: IronsideContent): IronsideIngest {
  const document = contract<IronsideIngest>("ironsideIngest", value);
  if (!isDeepStrictEqual(document, ironsideIngest(source, content))) throw new Error("Ironside mapping differs from verified source");
  return document;
}

export function ingestEndpoint(base: string): URL {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("IRONSIDE_URL_INVALID: supply the Ironside deployment base URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("IRONSIDE_URL_INSECURE: use https (http is accepted only for loopback hosts)");
  if (url.username || url.password || url.search || url.hash) throw new Error("IRONSIDE_URL_INVALID: credentials, query strings and fragments are not accepted; the key comes from IRONSIDE_API_KEY");
  return new URL(`${url.pathname.replace(/\/+$/, "")}/api/v1/ingest`, url.origin);
}

export function ironsideKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[IRONSIDE_KEY_VARIABLE];
  if (!key) throw new Error(`IRONSIDE_KEY_MISSING: set ${IRONSIDE_KEY_VARIABLE} to an Ironside Ingest credential; keys are never accepted as arguments`);
  if (/[\s\0]/.test(key)) throw new Error(`IRONSIDE_KEY_INVALID: ${IRONSIDE_KEY_VARIABLE} contains whitespace or NUL`);
  return key;
}

export interface Delivery { endpoint: string; accepted: { batchId: string; received: number }[]; }

/** Posts each request in order and stops at the first rejection. Deterministic IDs make a repeat post an upsert. */
export async function postIronsideIngest(document: IronsideIngest, endpoint: URL, key: string, fetchImpl: typeof fetch = fetch): Promise<Delivery> {
  const accepted: Delivery["accepted"] = [];
  for (const [index, request] of document.requests.entries()) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(request), signal: AbortSignal.timeout(30_000), redirect: "error" });
    } catch (error) {
      throw new Error(`IRONSIDE_DELIVERY_FAILED: request ${index + 1}/${document.requests.length} was not confirmed (${error instanceof Error ? error.name : "error"}); ${accepted.length} accepted. Reposting upserts the same IDs.`);
    }
    const body = await response.text().catch(() => "");
    const reply = ((): { batchId?: unknown; received?: unknown } | null => { try { return JSON.parse(body) as { batchId?: unknown; received?: unknown }; } catch { return null; } })();
    if (response.status !== 202 || typeof reply?.batchId !== "string" || reply.received !== request.events.length) {
      throw new Error(`IRONSIDE_DELIVERY_REJECTED: request ${index + 1}/${document.requests.length} returned HTTP ${response.status} ${body.slice(0, 300).replaceAll(key, "REDACTED")}; ${accepted.length} accepted. Reposting upserts the same IDs.`);
    }
    accepted.push({ batchId: reply.batchId, received: request.events.length });
  }
  return { endpoint: endpoint.href, accepted };
}
