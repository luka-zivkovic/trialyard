import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { bundleFixture } from "./fixtures.js";

// This consumer shares only the published schema and producer fixture. It does
// not import the producer's validators, replay, hashing, or filesystem helpers.
interface FileEntry { path: string; bytes: number; sha256: string; }
interface ObservedOperation {
  id: string; logicalCallId: string | null; boundary: string; owner: string;
  observed: boolean; outcome: string | null;
}
interface Bundle {
  runId: string; trialId: string; scenarioId: string; repetition: number;
  planSha256: string; scenarioSha256: string; fixtureSha256: string;
  execution: string; reason: string | null; files: FileEntry[];
  operations: ObservedOperation[];
}
interface JournalEvent {
  sequence: number; runId: string; trialId: string; kind: string;
  operationId: string | null; logicalCallId: string | null;
  payload: Record<string, unknown>;
}
const publicSchema = JSON.parse(readFileSync(new URL("../../contracts/v1.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: true, validateFormats: false });
ajv.addSchema(publicSchema, "public-contract");
const manifestShape = ajv.compile<Bundle>({ $ref: "public-contract#/$defs/manifest" });
const eventShape = ajv.compile<JournalEvent>({ $ref: "public-contract#/$defs/event" });
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const requiredFile = (files: Map<string, Buffer>, name: string): Buffer => {
  const bytes = files.get(name); assert(bytes, `Missing file: ${name}`); return bytes;
};
function relativePath(name: string): void {
  assert(!name.includes("\\") && !name.includes(":") && !name.includes("\0"), "Unsafe path");
  assert(name.split("/").every(part => part && part !== "." && part !== ".."), "Unsafe path");
}
async function readBundle(root: string, prefix = ""): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    relativePath(name); assert(!entry.isSymbolicLink(), "Symlink in bundle");
    if (entry.isDirectory()) {
      for (const [child, bytes] of await readBundle(root, name)) files.set(child, bytes);
    } else {
      assert(entry.isFile(), "Non-regular bundle file");
      files.set(name, await fs.readFile(path.join(root, name)));
    }
  }
  return files;
}
function consume(files: Map<string, Buffer>, expectedDigest: string): void {
  const rawManifest = requiredFile(files, "manifest.json");
  assert.equal(digest(rawManifest), expectedDigest, "Manifest identity");
  const manifest: unknown = JSON.parse(rawManifest.toString("utf8"));
  assert(manifestShape(manifest), "Manifest schema");
  const paths = manifest.files.map(file => file.path);
  paths.forEach(relativePath);
  assert(!paths.includes("manifest.json"), "Manifest inventories itself");
  assert.equal(new Set(paths).size, paths.length, "Duplicate inventory path");
  assert.deepEqual(paths, [...paths].sort(), "Inventory order");
  assert.deepEqual([...files.keys()].sort(), [...paths, "manifest.json"].sort(), "Inventory completeness");
  for (const file of manifest.files) {
    const bytes = requiredFile(files, file.path);
    assert.equal(bytes.length, file.bytes, "File length");
    assert.equal(digest(bytes), file.sha256, "File digest");
  }
  for (const [name, expected] of [
    ["plan.json", manifest.planSha256], ["scenario.json", manifest.scenarioSha256], ["fixture.json", manifest.fixtureSha256],
  ] as const) assert.equal(digest(requiredFile(files, name)), expected, "Input linkage");
  const scenario = JSON.parse(requiredFile(files, "scenario.json").toString("utf8")) as { id: string };
  assert.equal(scenario.id, manifest.scenarioId, "Scenario linkage");
  const log = new TextDecoder("utf-8", { fatal: true }).decode(requiredFile(files, "events.ndjson"));
  assert(log.endsWith("\n"), "Truncated event log");
  const events = log.slice(0, -1).split("\n").map((line, sequence) => {
    const event: unknown = JSON.parse(line);
    assert(eventShape(event), "Event schema");
    assert.equal(event.sequence, sequence, "Event sequence");
    assert.equal(event.runId, manifest.runId, "Event run linkage");
    assert.equal(event.trialId, manifest.trialId, "Event trial linkage");
    return event;
  });
  const first = events[0], last = events.at(-1);
  assert(first && last, "Empty event log");
  assert.equal(first.kind, "trial.started");
  assert.equal(first.payload.scenarioId, scenario.id);
  assert.equal(first.payload.repetition, manifest.repetition);
  assert.equal(last.kind, "trial.terminal");
  assert.equal(last.payload.execution, manifest.execution);
  assert.equal(last.payload.reason, manifest.reason);
  const operations = new Map<string, ObservedOperation>();
  for (const event of events) {
    if (!event.kind.startsWith("operation.")) continue;
    assert(event.operationId, "Missing operation identity");
    if (event.kind === "operation.dispatch_intent") {
      assert(!operations.has(event.operationId), "Duplicate operation");
      operations.set(event.operationId, { id: event.operationId, logicalCallId: event.logicalCallId,
        boundary: String(event.payload.boundary), owner: String(event.payload.owner), observed: false, outcome: null });
    } else {
      const operation = operations.get(event.operationId);
      assert(operation && operation.outcome === null, "Unknown or closed operation");
      assert.equal(operation.logicalCallId, event.logicalCallId, "Logical call linkage");
      if (event.kind === "operation.dispatch_observed") {
        assert(!operation.observed, "Duplicate dispatch"); operation.observed = true;
      } else {
        const outcome = String(event.payload.outcome);
        if (["known_result", "known_failure"].includes(outcome)) assert(operation.observed, "Result lacks dispatch");
        if (outcome === "not_dispatched") assert(!operation.observed, "False non-dispatch");
        operation.outcome = outcome;
      }
    }
  }
  assert([...operations.values()].every(operation => operation.outcome !== null), "Open operation");
  assert.deepEqual([...operations.values()], manifest.operations, "Operation summary linkage");
}
function changeJournal(files: Map<string, Buffer>, change: (events: JournalEvent[]) => void): void {
  const events = requiredFile(files, "events.ndjson").toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line) as JournalEvent);
  change(events);
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n");
  files.set("events.ndjson", bytes);
  const manifest = JSON.parse(requiredFile(files, "manifest.json").toString("utf8")) as Bundle;
  Object.assign(manifest.files.find(file => file.path === "events.ndjson")!, { bytes: bytes.length, sha256: digest(bytes) });
  files.set("manifest.json", encode(manifest));
}
const cases: [string, ((files: Map<string, Buffer>) => void) | null][] = [
  ["positive fixture", null],
  ["altered final state", files => files.set("final-state.json", Buffer.from("{}"))],
  ["unlisted file", files => files.set("extra.json", Buffer.from("{}"))],
  ["missing event file", files => { files.delete("events.ndjson"); }],
  ["unsafe inventory path", files => {
    const manifest = JSON.parse(requiredFile(files, "manifest.json").toString("utf8")) as Bundle;
    manifest.files[0]!.path = "../outside"; files.set("manifest.json", encode(manifest));
  }],
  ["reordered events with regenerated digests", files => changeJournal(files, events => {
    [events[2], events[3]] = [events[3]!, events[2]!];
  })],
  ["swapped event trial with regenerated digests", files => changeJournal(files, events => { events[3]!.trialId = "other"; })],
  ["external manifest digest mismatch", () => {}],
];
for (const [name, mutate] of cases) test(`independent consumer: ${name}`, async t => {
  const { root } = await bundleFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = await readBundle(root);
  if (!mutate) { consume(files, digest(requiredFile(files, "manifest.json"))); return; }
  mutate(files);
  // Updated outer digests let semantic attacks reach linkage checks; this does
  // not claim that a digest from the same source establishes authenticity.
  const expected = name === "external manifest digest mismatch" ? "0".repeat(64) : digest(requiredFile(files, "manifest.json"));
  assert.throws(() => consume(files, expected));
});
