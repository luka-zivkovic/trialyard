import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { inspectRun } from "../src/core/inspect.js";
import { verifyInspection } from "../src/contracts/inspection.js";
import { hash, jsonBytes } from "../src/core/files.js";
import type { Event, RunIndex } from "../src/contracts/types.js";
import { bundleFixture, goodEvents } from "./fixtures.js";
import { showRun } from "../src/core/run.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-inspect-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = await bundleFixture(); await fs.rename(bundle.root, path.join(root, "trial"));
  const manifest = await fs.readFile(path.join(root, "trial", "manifest.json"));
  const index: RunIndex = { schemaVersion: "trial-runner/run/v1", runId: "run", requestId: "request", inputSha256: "a".repeat(64), state: "accepted",
    createdAt: "2026-01-01T00:00:00Z", finishedAt: null, rerunOf: null, deadlineAt: null, exitCode: null,
    trials: [{ trialId: "trial", scenarioId: "reserve", repetition: 0, execution: "not_started", bundleSha256: null, path: "trial" }] };
  return { root, index, digest: hash(manifest) };
}
const ndjson = (events: Event[]): Buffer => Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n");

test("inspection distinguishes absent, intended, observed, and recorded non-dispatch without changing files", async t => {
  const { root, index } = await fixture(t);
  await fs.rm(path.join(root, "trial", "manifest.json"));
  index.trials.push({ ...index.trials[0]!, trialId: "later", repetition: 1, path: "later" });
  for (const [count, dispatch] of [[3, "unknown"], [4, "observed"]] as const) {
    const bytes = ndjson(goodEvents().slice(0, count)); await fs.writeFile(path.join(root, "trial", "events.ndjson"), bytes);
    const result = await inspectRun(root, index);
    verifyInspection(result);
    assert.equal(result.executionResumed, false); assert.equal(result.liveness, "not_checked");
    assert.equal(result.trials[0]!.state, "unfinished"); assert.equal(result.trials[0]!.operations[0]!.dispatch, dispatch);
    assert.equal(result.trials[0]!.operations[0]!.recordedOutcome, null); assert.equal(result.trials[0]!.operations[0]!.outcome, "outcome_unknown");
    assert.equal(result.trials[1]!.state, "not_observed"); assert.equal(result.trials[1]!.operations.length, 0);
    assert.deepEqual(await fs.readFile(path.join(root, "trial", "events.ndjson")), bytes);
    const invented = structuredClone(result); invented.trials[0]!.operations[0]!.dispatch = "not_dispatched";
    assert.throws(() => verifyInspection(invented), /invented non-dispatch/);
  }
  const events = goodEvents().slice(0, 3);
  events.push({ ...goodEvents()[4]!, sequence: 3, source: "runner_observed", payload: { outcome: "not_dispatched", value: null, error: "Stopped before dispatch" } });
  await fs.writeFile(path.join(root, "trial", "events.ndjson"), ndjson(events));
  const result = await inspectRun(root, index);
  assert.equal(result.trials[0]!.operations[0]!.dispatch, "not_dispatched");
});

test("inspection retains a valid prefix and explicitly reports a partial UTF-8/JSON tail", async t => {
  const { root, index } = await fixture(t); await fs.rm(path.join(root, "trial", "manifest.json"));
  const prefix = ndjson(goodEvents().slice(0, 3)); const tail = Buffer.from([123, 34, 0xe2, 0x82]);
  const bytes = Buffer.concat([prefix, tail]); await fs.writeFile(path.join(root, "trial", "events.ndjson"), bytes);
  const result = (await inspectRun(root, index)).trials[0]!;
  assert.equal(result.state, "unfinished"); assert.equal(result.journal.completeEvents, 3);
  assert.equal(result.journal.completeBytes, prefix.length); assert.equal(result.journal.trailingBytes, tail.length);
  assert.ok(result.gaps.includes("partial_journal_tail")); assert.equal(result.operations[0]!.outcome, "outcome_unknown");
  assert.deepEqual(await fs.readFile(path.join(root, "trial", "events.ndjson")), bytes);
});

test("inspection finds a published bundle even when its index update is missing", async t => {
  const { root, index, digest } = await fixture(t);
  const result = (await inspectRun(root, index)).trials[0]!;
  assert.equal(result.state, "finalized"); assert.equal(result.bundle.sha256, digest); assert.equal(result.bundle.verified, true);
  assert.equal(result.terminalExecution, "finished"); assert.equal(result.indexExecution, "not_started");
  assert.ok(result.gaps.includes("index_update_missing")); assert.equal(result.operations[0]!.outcome, "known_result");
});

for (const defect of ["missing-file", "invalid-log", "swapped-trial", "unsafe-path", "symlink", "missing-finalized-bundle"] as const) test(`inspection never repairs or approves ${defect}`, async t => {
  const { root, index, digest } = await fixture(t);
  if (defect === "missing-file") await fs.rm(path.join(root, "trial", "final-state.json"));
  if (defect === "invalid-log") await fs.appendFile(path.join(root, "trial", "events.ndjson"), "bad json\n");
  if (defect === "swapped-trial") index.trials[0]!.trialId = "other";
  if (defect === "unsafe-path") index.trials[0]!.path = "../outside";
  if (defect === "symlink") { await fs.rm(path.join(root, "trial", "events.ndjson")); await fs.symlink("/etc/passwd", path.join(root, "trial", "events.ndjson")); }
  if (defect === "missing-finalized-bundle") {
    index.state = "finished"; index.finishedAt = index.createdAt; index.exitCode = 0;
    index.trials[0]!.execution = "finished"; index.trials[0]!.bundleSha256 = digest;
    await fs.rm(path.join(root, "trial", "manifest.json"));
  }
  if (defect === "unsafe-path") await assert.rejects(inspectRun(root, index), /Unsafe/);
  else { const result = (await inspectRun(root, index)).trials[0]!; assert.equal(result.state, "invalid"); assert.equal(result.bundle.verified, false); }
});

test("inspection rejects an invented grade or an upgraded operation outcome", async t => {
  const { root, index } = await fixture(t); const result = await inspectRun(root, index);
  assert.throws(() => verifyInspection({ ...result, verdict: "pass" }));
  const changed = structuredClone(result); changed.trials[0]!.operations[0]!.outcome = "not_dispatched";
  assert.throws(() => verifyInspection(changed));
  const finished = structuredClone(result); finished.trials[0]!.bundle.verified = false;
  assert.throws(() => verifyInspection(finished));
  assert.equal(JSON.parse(jsonBytes(result).toString()).executionResumed, false);
  for (const corrupt of [
    (value: typeof result) => { value.trials[0]!.operations[0]!.recordedOutcome = null; value.trials[0]!.operations[0]!.outcome = "outcome_unknown"; },
    (value: typeof result) => { value.trials[0]!.journal.completeEvents = 0; },
    (value: typeof result) => { value.trials[0]!.journal.sha256 = null; },
    (value: typeof result) => { value.trials[0]!.journal.trailingBytes = 8; },
  ]) { const changed = structuredClone(result); corrupt(changed); assert.throws(() => verifyInspection(changed), /closed journal/); }
});

test("unfinished inspection carries recorded capture gaps", async t => {
  const { root, index } = await fixture(t); await fs.rm(path.join(root, "trial", "manifest.json"));
  const events = goodEvents().slice(0, 2);
  events.push({ ...events[0]!, sequence: 2, kind: "capture.gap", payload: { reason: "capture_limit_exceeded" } });
  await fs.writeFile(path.join(root, "trial", "events.ndjson"), ndjson(events));
  assert.ok((await inspectRun(root, index)).trials[0]!.gaps.includes("capture_limit_exceeded"));
});

test("accepted allocation anchors every slot and rejects removal, reorder, replacement or digest tampering", async t => {
  const { root, index } = await fixture(t);
  index.trials.push({ ...index.trials[0]!, trialId: "later", repetition: 1, path: "later" });
  const bytes = jsonBytes(index); await fs.writeFile(path.join(root, "accepted.json"), bytes);
  assert.equal((await inspectRun(root, index, hash(bytes))).coverage, "anchored");
  for (const corrupt of [
    (value: RunIndex) => { value.trials.pop(); },
    (value: RunIndex) => { value.trials.reverse(); },
    (value: RunIndex) => { value.trials[0]!.scenarioId = "changed"; },
    (value: RunIndex) => { value.createdAt = "2026-02-02T00:00:00Z"; },
  ]) { const changed = structuredClone(index); corrupt(changed); await assert.rejects(inspectRun(root, changed, hash(bytes)), /allocation/); }
  await fs.appendFile(path.join(root, "accepted.json"), " ");
  await assert.rejects(inspectRun(root, index, hash(bytes)), /digest mismatch/);
});

test("show rejects external run symlinks and a missing accepted allocation; legacy coverage is explicit", async t => {
  const { root, index } = await fixture(t);
  index.runId = "11111111-1111-4111-8111-111111111111";
  const store = path.join(root, "store"); const runRoot = path.join(store, "runs", index.runId);
  await fs.mkdir(runRoot, { recursive: true }); await fs.mkdir(path.join(store, "requests"));
  const bytes = jsonBytes(index); await fs.writeFile(path.join(runRoot, "run.json"), bytes);
  const record = { requestId: index.requestId, runId: index.runId, inputSha256: index.inputSha256 };
  const recordPath = path.join(store, "requests", `${hash(index.requestId)}.json`);
  await fs.writeFile(recordPath, jsonBytes(record));
  const legacy = await showRun(store, index.requestId);
  assert.equal((await inspectRun(legacy.root, legacy.index, legacy.acceptanceSha256)).coverage, "unverified");
  await fs.writeFile(recordPath, jsonBytes({ ...record, schemaVersion: "trial-runner/request/v1", acceptanceSha256: hash(bytes) }));
  await assert.rejects(showRun(store, index.requestId), /Accepted request is unreadable/);
  await fs.writeFile(path.join(runRoot, "accepted.json"), bytes);
  assert.equal((await showRun(store, index.requestId)).acceptanceSha256, hash(bytes));
  const moved = path.join(root, "moved"); await fs.rename(runRoot, moved); await fs.symlink(moved, runRoot);
  await assert.rejects(showRun(store, index.requestId), /Symlink/);
  await assert.rejects(inspectRun(runRoot, index, hash(bytes)), /real directory/);
});
