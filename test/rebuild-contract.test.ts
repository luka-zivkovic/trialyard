import test from "node:test";
import assert from "node:assert/strict";
import type { ConnectionRecipe } from "../src/connection/contracts.js";
import { describeRebuild, rebuildContract, rebuildResultContract, REBUILD_PARENT, REBUILD_RECORD, verifyRebuildLineage, type RebuildRecord } from "../src/connection/rebuild-contract.js";
import { hash, jsonBytes } from "../src/core/files.js";
import { record } from "../src/discovery/safe.js";

function fixture() {
  const make = (source: string): ConnectionRecipe => ({
    schemaVersion: "trial-runner/connection-recipe/v1", id: "node-function-connection", method: "prepared-plan/v1", skill: null,
    sources: [record("agent.js", Buffer.from(source))],
    files: [record("prepared/plan.json", Buffer.from("plan")), record("prepared/scenario.json", Buffer.from("scenario")),
      record("prepared/agent-artifact.json", Buffer.from(source + "artifact")), record("prepared/candidate/agent.js", Buffer.from(source))],
    plan: { path: "prepared/plan.json", inputSha256: hash(Buffer.from(source)) }, requirements: [],
  });
  const parent = make("before"), current = make("after"), parentBytes = jsonBytes(parent);
  const report = describeRebuild(parentBytes, current);
  const verify = (value: unknown, parentData = parentBytes) => verifyRebuildLineage(new Map([[REBUILD_PARENT, parentData], [REBUILD_RECORD, jsonBytes(value)]]), current);
  return { parent, current, parentBytes, report, verify };
}

test("rebuild contract describes changed identities and preserved files against the exact parent bytes", () => {
  const f = fixture(); f.verify(f.report);
  assert.equal(f.report.parentRecipeSha256, hash(f.parentBytes));
  assert.deepEqual(f.report.changes.sources.map(f => f.path), ["agent.js"]);
  assert.deepEqual(f.report.changes.files.map(f => f.path), ["prepared/agent-artifact.json", "prepared/candidate/agent.js"]);
  assert.deepEqual(f.report.preservedFiles.map(f => f.path), ["prepared/plan.json", "prepared/scenario.json"]);
  const noop = describeRebuild(f.parentBytes, f.parent);
  assert.deepEqual(noop.changes, { sources: [], files: [] });
  assert.equal(noop.agentArtifact.before, noop.agentArtifact.after);
});

for (const [label, mutate] of Object.entries({
  version: (r: any) => { r.schemaVersion = "trial-runner/connection-rebuild/v2"; },
  unknown: (r: any) => { r.quality = "pass"; },
  execution: (r: any) => { r.execution = "finished"; },
  unsafe: (r: any) => { r.changes.sources[0].path = "../agent.js"; },
  duplicate: (r: any) => { r.changes.sources.push({ ...r.changes.sources[0], path: "Agent.js" }); },
  order: (r: any) => { r.changes.files.reverse(); },
  unchanged: (r: any) => { r.changes.sources[0].after = r.changes.sources[0].before; },
  empty: (r: any) => { r.changes.sources[0].before = null; r.changes.sources[0].after = null; },
})) test(`rebuild record rejects ${label}`, () => {
  const f = fixture(); mutate(f.report); assert.throws(() => rebuildContract(f.report));
});

for (const [label, mutate] of Object.entries({
  parent: (r: RebuildRecord) => { r.parentRecipeSha256 = "0".repeat(64); },
  inputs: (r: RebuildRecord) => { r.inputSha256 = "0".repeat(64); },
  artifact: (r: RebuildRecord) => { r.agentArtifact.before = "0".repeat(64); },
  sources: (r: RebuildRecord) => { r.changes.sources = []; },
  files: (r: RebuildRecord) => { r.changes.files = []; },
  preserved: (r: RebuildRecord) => { r.preservedFiles = []; },
})) test(`lineage rejects rehashed but false ${label}`, () => {
  const f = fixture(); mutate(f.report); assert.throws(() => f.verify(f.report), /REBUILD_LINEAGE_MISMATCH/);
});

test("lineage rejects a changed trial configuration and incomplete ancestry", () => {
  const f = fixture();
  f.current.files[1] = record("prepared/scenario.json", Buffer.from("different"));
  assert.throws(() => describeRebuild(f.parentBytes, f.current), /REBUILD_CONFIGURATION_CHANGED/);
  for (const name of [REBUILD_PARENT, REBUILD_RECORD]) {
    assert.throws(() => verifyRebuildLineage(new Map([[name, f.parentBytes]]), f.current), /MISSING_REBUILD_LINEAGE/);
  }
  verifyRebuildLineage(new Map(), f.current); // Original v1 connections remain valid.
});

test("result must identify the same plan as its rebuild record", () => {
  const f = fixture();
  const result = { schemaVersion: "trial-runner/connection-rebuild-result/v1", recipe: "/next/connection.json", recipeSha256: "a".repeat(64), plan: f.current.plan, record: f.report };
  rebuildResultContract(result);
  assert.throws(() => rebuildResultContract({ ...result, plan: { ...result.plan, inputSha256: "0".repeat(64) } }), /REBUILD_INPUT_MISMATCH/);
});

test("source claims cannot designate a generated wrapper as mutable", () => {
  const f = fixture();
  f.parent.sources.push(record("trial-adapter.js", Buffer.from("wrapper")));
  assert.throws(() => describeRebuild(jsonBytes(f.parent), f.current), /EXCLUDED_SOURCE_PATH/);
  f.parent.sources.pop();
  f.parent.files.push(record("prepared/candidate/trial-adapter.js", Buffer.from("old-wrapper")));
  f.current.files.push(record("prepared/candidate/trial-adapter.js", Buffer.from("new-wrapper")));
  assert.throws(() => describeRebuild(jsonBytes(f.parent), f.current), /REBUILD_CONFIGURATION_CHANGED/);
});
