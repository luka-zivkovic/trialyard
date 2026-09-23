import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { batches, ingestEndpoint, ironsideIngest, ironsideKey, loadIronsideSource, verifyIronsideIngest,
  type IngestEvent, type IronsideIngest, type IronsideSource } from "../src/export/ironside.js";
import { exportRedactedBundle } from "../src/export/redacted.js";
import { contract } from "../src/contracts/validate.js";
import type { Event } from "../src/contracts/types.js";
import { bundleFixture, event, goodEvents } from "./fixtures.js";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

type Body = Record<string, unknown> & { id: string; metadata: Record<string, string> };
const all = (document: IronsideIngest): IngestEvent[] => document.requests.flatMap(request => request.events);
const observation = (document: IronsideIngest, name: string): Body => {
  const found = all(document).find(item => item.type === "observation-upsert" && item.body.name === name);
  assert.ok(found, `observation ${name}`); return found.body as unknown as Body;
};
const trace = (document: IronsideIngest): Body => all(document)[0]!.body as unknown as Body;

/** Independently written from Ironside's published envelope/domain shapes; not the producer's schema. */
function assertIronsideShape(document: IronsideIngest): void {
  const isoOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const identifier = (value: unknown): void => { assert.equal(typeof value, "string"); assert.ok((value as string).trim().length > 0 && Buffer.byteLength(value as string) <= 512); };
  assert.ok(document.requests.length >= 1);
  for (const request of document.requests) {
    assert.deepEqual(Object.keys(request), ["events"]);
    assert.ok(request.events.length >= 1 && request.events.length <= 500);
    assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 10 * 1024 * 1024);
    for (const item of request.events) {
      assert.deepEqual(Object.keys(item).sort(), ["body", "type"]);
      const body = item.body as unknown as Record<string, unknown>;
      assert.equal("projectId" in body, false);
      identifier(body.id);
      for (const value of Object.values(body.metadata as Record<string, unknown>)) assert.equal(typeof value, "string");
      if (item.type === "trace-upsert") { assert.match(String(body.timestamp), isoOffset); assert.ok(Array.isArray(body.tags)); continue; }
      identifier(body.traceId); assert.match(String(body.startTime), isoOffset);
      if (body.endTime !== undefined) assert.match(String(body.endTime), isoOffset);
      if (body.parentObservationId !== undefined) identifier(body.parentObservationId);
      assert.ok(["span", "generation", "event"].includes(String(body.type)));
      assert.ok(["debug", "default", "warning", "error"].includes(String(body.level)));
      for (const value of Object.values((body.usageDetails ?? {}) as Record<string, unknown>)) assert.ok(Number.isInteger(value) && (value as number) >= 0);
      for (const value of Object.values((body.costDetails ?? {}) as Record<string, unknown>)) assert.ok(typeof value === "number" && value >= 0);
    }
  }
}

const source = (overrides: Partial<IronsideSource> = {}): IronsideSource => ({
  bundleSha256: "a".repeat(64), bundleKind: "native", parentBundleSha256: null, runId: "run", requestId: "request", trialId: "trial",
  scenarioId: "reserve", repetition: 2, execution: "finished", cleanup: "succeeded", evidenceState: "complete", gaps: [], redactedPaths: [],
  captureBoundary: "reference", agentArtifactSha256: "b".repeat(64), authenticity: "not_attested", ...overrides });
const snapshot = { state: { remaining: 2 }, stable: true, pendingOperations: [], observedAt: "2026-01-01T00:00:01Z" };

test("verified native bundle maps to one Ironside trace with separate claim and observed state", async t => {
  const fixture = await bundleFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const loaded = await loadIronsideSource(fixture.root, {});
  const document = verifyIronsideIngest(ironsideIngest(loaded.source, loaded.content), loaded.source, loaded.content);
  assertIronsideShape(document);
  const events = all(document);
  assert.equal(events[0]!.type, "trace-upsert");
  assert.equal(events.filter(item => item.type === "trace-upsert").length, 1);
  assert.ok(events.slice(1).every(item => item.type === "observation-upsert" && item.body.traceId === document.traceId));
  const root = trace(document);
  assert.equal(root.id, `trialyard-${loaded.source.bundleSha256}`);
  assert.equal(root.sessionId, "trialyard-run:run");
  for (const tag of ["trialyard", "trialyard:run:run", "trialyard:scenario:reserve", "trialyard:repetition:0", `trialyard:bundle:${loaded.source.bundleSha256}`, "trialyard:evidence:complete"]) assert.ok((root.tags as string[]).includes(tag), tag);
  assert.equal(root.metadata["trialyard.bundleSha256"], loaded.source.bundleSha256);
  assert.equal(root.metadata["trialyard.unobserved"], "[]");
  assert.deepEqual(root.output, {
    candidateClaim: { source: "candidate_claim", status: "observed", content: "Reserved" },
    observedFinalState: { source: "environment_observed", status: "observed", stable: true, pendingOperations: [], observedAt: "2026-01-01T00:00:00Z", state: { remaining: 2 } },
  });
  const turn = observation(document, "turn:one");
  assert.equal(turn.input, "Reserve one item"); assert.equal(turn.output, "Reserved");
  assert.equal(turn.metadata["trialyard.output.source"], "candidate_claim");
  const tool = observation(document, "reserve");
  assert.equal(tool.parentObservationId, turn.id); assert.deepEqual(tool.output, { count: 1 });
  assert.equal(tool.metadata["trialyard.dispatch"], "observed"); assert.equal(tool.metadata["trialyard.sequences"], "2,3,4");
  assert.deepEqual(observation(document, "environment.final_state").output, { state: { remaining: 2 }, stable: true, pendingOperations: [], observedAt: "2026-01-01T00:00:00Z" });
  assert.equal(JSON.stringify(document).includes("verdict"), false);
  assert.equal(all(document).some(item => (item.type as string) === "score-upsert"), false);
  // A consumer re-derives the mapping; an upgraded copy is rejected.
  const upgraded = structuredClone(document) as IronsideIngest; upgraded.source.gaps = ["invented"];
  assert.throws(() => verifyIronsideIngest(upgraded, loaded.source, loaded.content), /differs/);
  const forged = structuredClone(document) as IronsideIngest; (forged.requests[0]!.events[0]!.body as unknown as Body).metadata["trialyard.evidenceState"] = "complete";
  (forged.requests[0]!.events[0]!.body as unknown as Body).metadata["trialyard.claimedOutcome.status"] = "verified";
  assert.throws(() => verifyIronsideIngest(forged, loaded.source, loaded.content), /differs/);
});

test("unknown outcomes, missing final state and capture gaps stay unobserved instead of fabricated", () => {
  const events: Event[] = [
    event(0, "trial.started", { scenarioId: "reserve", repetition: 2 }),
    event(1, "user.turn", { content: "Reserve one item" }, { turnId: "one", recordedAt: "2026-01-01T00:00:01Z" }),
    event(2, "operation.dispatch_intent", { boundary: "tool", owner: "runner", name: "reserve", args: { quantity: 1 } }, { operationId: "lost", turnId: "one", recordedAt: "2026-01-01T00:00:02Z" }),
    event(3, "operation.finished", { outcome: "outcome_unknown", value: null, error: "response lost" }, { operationId: "lost", turnId: "one", recordedAt: "2026-01-01T00:00:03Z" }),
    event(4, "capture.gap", { reason: "final_state_not_stable" }, { recordedAt: "2026-01-01T00:00:04Z" }),
    event(5, "runtime.error", { message: "Trial deadline exceeded", execution: "timed_out" }, { recordedAt: "2026-01-01T00:00:05Z" }),
    event(6, "trial.terminal", { execution: "timed_out", reason: "deadline" }, { recordedAt: "2026-01-01T00:00:06Z" }),
  ];
  const document = ironsideIngest(source({ execution: "timed_out", evidenceState: "incomplete", gaps: ["final_state_missing", "final_state_not_stable"] }),
    { events, initial: { ...snapshot, observedAt: "2026-01-01T00:00:00Z" }, final: null });
  assertIronsideShape(document);
  const lost = observation(document, "reserve");
  assert.equal("output" in lost, false); assert.equal(lost.level, "warning");
  assert.equal(lost.metadata["trialyard.dispatch"], "not_observed"); assert.equal(lost.metadata["trialyard.outcome"], "outcome_unknown");
  assert.equal(lost.metadata["trialyard.error"], "response lost");
  const turn = observation(document, "turn:one");
  assert.equal("output" in turn, false); assert.equal("endTime" in turn, false); assert.equal(turn.metadata["trialyard.claim"], "not_observed");
  const final = observation(document, "environment.final_state");
  assert.equal("output" in final, false); assert.equal(final.level, "warning");
  assert.equal(final.metadata["trialyard.unobserved"], "true"); assert.equal(final.metadata["trialyard.capture"], "not_captured");
  assert.equal(final.metadata["trialyard.timestampSource"], "placement:last_event");
  assert.equal(observation(document, "capture.gap").level, "warning");
  assert.equal(observation(document, "runtime.error").level, "error");
  assert.equal(observation(document, "trial.terminal").level, "warning");
  const root = trace(document);
  assert.deepEqual(root.output, { candidateClaim: { source: "candidate_claim", status: "not_observed" }, observedFinalState: { source: "environment_observed", status: "not_captured" } });
  assert.equal(root.metadata["trialyard.unobserved"], '["finalState"]');
  assert.equal(root.metadata["trialyard.evidenceState"], "incomplete");
  assert.ok((root.tags as string[]).includes("trialyard:execution:timed_out"));
});

test("model operations keep unknown usage absent and non-USD cost out of costDetails", () => {
  const request = { provider: "synthetic", model: "scripted-1", settings: { temperature: 0, stop: ["x"] }, input: [{ role: "user", content: "hi" }] };
  const events: Event[] = [...goodEvents().slice(0, 2),
    event(2, "operation.dispatch_intent", { boundary: "model", owner: "agent", name: "scripted-1", args: request }, { operationId: "m1", turnId: "one", source: "adapter_reported" }),
    event(3, "operation.dispatch_observed", {}, { operationId: "m1", turnId: "one", source: "adapter_reported" }),
    event(4, "operation.finished", { outcome: "known_result", value: { text: "ok" }, error: null, model: { provider: "synthetic", model: "scripted-1-rev", modelRevision: null, requestId: "r1",
      usage: { inputTokens: 5, outputTokens: null, source: "provider_reported" }, cost: { amount: 0.5, currency: "EUR", source: "adapter_estimated", pricingId: "p1" } } },
    { operationId: "m1", turnId: "one", source: "adapter_reported" }),
    event(5, "assistant.turn", { content: "ok", modelOperations: ["m1"] }, { turnId: "one", source: "candidate_claim" }),
    event(6, "trial.terminal", { execution: "finished", reason: null })];
  const document = ironsideIngest(source(), { events, initial: snapshot, final: snapshot });
  assertIronsideShape(document);
  const generation = observation(document, "scripted-1");
  assert.equal(generation.type, "generation"); assert.equal(generation.model, "scripted-1-rev");
  assert.deepEqual(generation.modelParameters, { temperature: 0 });
  assert.deepEqual(generation.usageDetails, { input_tokens: 5 });
  assert.equal("costDetails" in generation, false);
  assert.match(generation.metadata["trialyard.cost"]!, /EUR/);
  assert.equal(generation.metadata["trialyard.usage.source"], "provider_reported");
  assert.equal(generation.metadata["trialyard.requestedModel"], "scripted-1");
});

test("requests respect Ironside batch limits without truncating events", () => {
  const body = (i: number, bytes = 10) => ({ type: "observation-upsert", body: { id: `o${i}`, traceId: "t", type: "event", name: "x".repeat(bytes), startTime: "2026-01-01T00:00:00.000Z", level: "default", metadata: {} } }) as IngestEvent;
  const split = batches(Array.from({ length: 1201 }, (_, i) => body(i)));
  assert.deepEqual(split.map(request => request.events.length), [500, 500, 201]);
  const large = batches(Array.from({ length: 4 }, (_, i) => body(i, 4 * 1024 * 1024)));
  assert.deepEqual(large.map(request => request.events.length), [2, 2]);
  assert.ok(large.every(request => Buffer.byteLength(JSON.stringify(request)) <= 10 * 1024 * 1024));
  assert.throws(() => batches([body(0, 11 * 1024 * 1024)]), /IRONSIDE_EVENT_TOO_LARGE/);
  assert.throws(() => ironsideIngest(source(), { events: null, initial: null, final: null }), /IRONSIDE_EXPORT_NO_TIMESTAMP/);
  assert.throws(() => contract("ironsideIngest", { ...ironsideIngest(source(), { events: goodEvents(), initial: snapshot, final: snapshot }), requests: [] }));
});

test("unverified, digest-mismatched and unanchored derivative sources are refused", async t => {
  const fixture = await bundleFixture();
  const destination = await fs.mkdtemp(path.join(tmpdir(), "trial-ironside-derivative-"));
  t.after(() => Promise.all([fs.rm(fixture.root, { recursive: true, force: true }), fs.rm(destination, { recursive: true, force: true })]));
  await assert.rejects(loadIronsideSource(fixture.root, { sha256: "0".repeat(64) }), /identity mismatch/);
  const derivative = await exportRedactedBundle(fixture.root, path.join(destination, "shared"), { schemaVersion: "trial-runner/redaction/v1", omitFiles: ["events.ndjson", "final-state.json"] });
  await assert.rejects(loadIronsideSource(derivative.root, {}), "A derivative is not native evidence");
  await assert.rejects(loadIronsideSource(derivative.root, { sourceRoot: fixture.root, sha256: "0".repeat(64) }), /identity mismatch/);
  // Only retained derivative content is exported; omitted files cannot leak through the original.
  const loaded = await loadIronsideSource(derivative.root, { sourceRoot: fixture.root, sha256: derivative.digest });
  const document = ironsideIngest(loaded.source, loaded.content);
  assertIronsideShape(document);
  const text = JSON.stringify(document);
  for (const omitted of ["Reserve one item", "Reserved", "\"remaining\":2"]) assert.equal(text.includes(omitted), false, omitted);
  const root = trace(document);
  assert.equal(root.metadata["trialyard.bundleKind"], "redacted-derivative");
  assert.equal(root.metadata["trialyard.parentBundleSha256"], derivative.manifest.parentBundleSha256);
  assert.equal(root.metadata["trialyard.capture.conversation"], "redacted");
  assert.equal(root.metadata["trialyard.capture.finalState"], "redacted");
  assert.equal(root.metadata["trialyard.evidenceState"], "incomplete");
  assert.equal("trialyard.captureBoundary" in root.metadata, false);
  assert.equal("input" in root, false);
  assert.equal(observation(document, "environment.final_state").metadata["trialyard.capture"], "redacted");
  assert.equal(observation(document, "environment.initial_state").metadata["trialyard.timestampSource"], "snapshot.observedAt");
  // Tampering with a retained file after verification anchors is refused.
  await fs.appendFile(path.join(fixture.root, "events.ndjson"), "\n");
  await assert.rejects(loadIronsideSource(fixture.root, {}));
});

test("delivery configuration accepts only safe endpoints and an environment key", () => {
  assert.equal(ingestEndpoint("https://ironside.example.com/").href, "https://ironside.example.com/api/v1/ingest");
  assert.equal(ingestEndpoint("https://example.com/ironside").href, "https://example.com/ironside/api/v1/ingest");
  assert.equal(ingestEndpoint("http://127.0.0.1:3000").href, "http://127.0.0.1:3000/api/v1/ingest");
  for (const bad of ["http://ironside.example.com", "https://user:pw@example.com", "https://example.com/?key=x", "ftp://example.com", "not a url"]) assert.throws(() => ingestEndpoint(bad), /IRONSIDE_URL/);
  assert.throws(() => ironsideKey({}), /IRONSIDE_KEY_MISSING/);
  assert.throws(() => ironsideKey({ IRONSIDE_API_KEY: "has space" }), /IRONSIDE_KEY_INVALID/);
  assert.equal(ironsideKey({ IRONSIDE_API_KEY: "ironside_sc_synthetic" }), "ironside_sc_synthetic");
});

test("CLI writes offline ingest requests and posts the same bytes with the environment key", async t => {
  const fixture = await bundleFixture();
  const work = await fs.mkdtemp(path.join(tmpdir(), "trial-ironside-cli-"));
  const key = `ironside_sc_${Math.random().toString(36).slice(2)}synthetic`;
  const received: { authorization: string | undefined; path: string | undefined; body: unknown }[] = [];
  let reject = false;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { events: unknown[] };
      received.push({ authorization: request.headers.authorization, path: request.url, body });
      response.writeHead(reject ? 401 : 202, { "content-type": "application/json" });
      response.end(JSON.stringify(reject ? { error: `bad key ${key}` } : { batchId: `batch-${received.length}`, received: body.events.length }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => Promise.all([fs.rm(fixture.root, { recursive: true, force: true }), fs.rm(work, { recursive: true, force: true }), new Promise(resolve => server.close(resolve))]));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { ...process.env, IRONSIDE_API_KEY: key };
  const invoke = (args: string[], environment: NodeJS.ProcessEnv = env) => exec(process.execPath, [cli, ...args], { cwd: work, env: environment, maxBuffer: 16 * 1024 * 1024 });

  const offline = JSON.parse((await invoke(["export", fixture.root, "--format", "ironside", "--out", "offline.json"])).stdout) as Record<string, unknown>;
  assert.match(String(offline.notice), /no network request/);
  assert.equal(received.length, 0);
  const written = JSON.parse(await fs.readFile(path.join(work, "offline.json"), "utf8")) as IronsideIngest;
  assert.equal(written.schemaVersion, "trial-runner/ironside-ingest/v1");
  assert.equal(offline.traceId, written.traceId);
  await assert.rejects(invoke(["export", fixture.root, "--format", "ironside", "--out", "offline.json"]), "An existing export is never replaced");

  const posted = JSON.parse((await invoke(["export", fixture.root, "--format", "ironside", "--sha256", written.source.bundleSha256, "--ironside-url", url, "--out", "posted.json"])).stdout) as { delivery: { accepted: unknown[] } };
  assert.equal(posted.delivery.accepted.length, written.requests.length);
  assert.deepEqual(received.map(entry => entry.body), written.requests);
  assert.ok(received.every(entry => entry.authorization === `Bearer ${key}` && entry.path === "/api/v1/ingest"));
  assert.deepEqual(await fs.readFile(path.join(work, "posted.json")), await fs.readFile(path.join(work, "offline.json")));
  assert.equal(JSON.stringify(posted).includes(key), false);

  reject = true;
  const failed = await invoke(["export", fixture.root, "--format", "ironside", "--ironside-url", url]).then(() => null, (error: { code: number; stderr: string }) => error);
  assert.ok(failed); assert.equal(failed.code, 1); assert.match(failed.stderr, /IRONSIDE_DELIVERY_REJECTED.*HTTP 401/); assert.equal(failed.stderr.includes(key), false);
  reject = false;

  const count = received.length;
  const { IRONSIDE_API_KEY: _removed, ...withoutKey } = env;
  await assert.rejects(invoke(["export", fixture.root, "--format", "ironside", "--ironside-url", url, "--out", "no-key.json"], withoutKey), /IRONSIDE_KEY_MISSING/);
  await assert.rejects(fs.stat(path.join(work, "no-key.json")), { code: "ENOENT" });
  await assert.rejects(invoke(["export", fixture.root, "--format", "ironside", "--ironside-url", url, "--api-key", key]), /Unknown option/);
  await assert.rejects(invoke(["export", fixture.root, "--format", "ironside", "--ironside-url", "http://ironside.example.com"]), /IRONSIDE_URL_INSECURE/);
  await assert.rejects(invoke(["export", fixture.root, "--format", "ironside"]), /Missing --out or --ironside-url/);
  await assert.rejects(invoke(["export", fixture.root, "--format", "ironside", "--sha256", "0".repeat(64), "--ironside-url", url, "--out", "mismatch.json"]), /identity mismatch/);
  await assert.rejects(fs.stat(path.join(work, "mismatch.json")), { code: "ENOENT" });
  await assert.rejects(invoke(["export", fixture.root, "--format", "assessment-input", "--ironside-url", url, "--out", "a.json"]), /applies only to ironside/);
  await fs.writeFile(path.join(fixture.root, "final-state.json"), "{}\n");
  await assert.rejects(invoke(["export", fixture.root, "--format", "ironside", "--ironside-url", url, "--out", "tampered.json"]), /digest mismatch/);
  await assert.rejects(fs.stat(path.join(work, "tampered.json")), { code: "ENOENT" });
  assert.equal(received.length, count, "No refused export reaches the network");
});
