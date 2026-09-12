import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { derivativeManifest, redactionPolicy, verifyDerivativeManifest } from "../src/contracts/redaction.js";
import { bundleFixture } from "./fixtures.js";
import { hash } from "../src/core/files.js";
import { exportRedactedBundle, verifyRedactedBundle } from "../src/export/redacted.js";
import { verifyBundle } from "../src/contracts/verify.js";
import { fileInventory, jsonBytes } from "../src/core/files.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

test("redacted contract retains source identity and cannot upgrade or hide missing evidence", async t => {
  const { root, manifest } = await bundleFixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const digest = hash(await fs.readFile(path.join(root, "manifest.json")));
  const derivative = derivativeManifest(manifest, digest, { schemaVersion: "trial-runner/redaction/v1", omitFiles: ["events.ndjson", "final-state.json"] });
  assert.equal(derivative.evidence.state, "incomplete"); assert.equal(derivative.parentBundleSha256, digest);
  assert.deepEqual(verifyDerivativeManifest(derivative, manifest, digest), derivative);
  for (const change of [
    (value: any) => { value.evidence.state = "complete"; },
    (value: any) => { value.parentBundleSha256 = "0".repeat(64); },
    (value: any) => { value.evidence.redactedPaths = []; },
    (value: any) => { value.execution = "not_started"; },
    (value: any) => { value.files[0].sha256 = "0".repeat(64); },
    (value: any) => { value.verdict = "pass"; },
  ]) { const changed = structuredClone(derivative); change(changed); assert.throws(() => verifyDerivativeManifest(changed, manifest, digest)); }
  manifest.evidence.gaps = ["unknown_model_usage"]; manifest.evidence.state = "incomplete";
  assert.throws(() => verifyDerivativeManifest(derivative, manifest, digest));
});

test("redaction policy rejects empty, unknown, duplicated or unsafe file selections", () => {
  for (const omitFiles of [[], ["../outside"], ["manifest.json"], ["events.ndjson", "events.ndjson"], ["link\\escape"]]) {
    assert.throws(() => redactionPolicy({ schemaVersion: "trial-runner/redaction/v1", omitFiles }));
  }
  assert.throws(() => redactionPolicy({ schemaVersion: "trial-runner/redaction/v2", omitFiles: ["events.ndjson"] }));
  assert.throws(() => redactionPolicy({ schemaVersion: "trial-runner/redaction/v1", omitFiles: ["events.ndjson"], replace: "success" }));
});

test("export creates a separately verifiable derivative without modifying its source", async t => {
  const { root } = await bundleFixture(); const destination = root + "-export";
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(destination, { recursive: true, force: true }); });
  const original = await fs.readFile(path.join(root, "manifest.json")); const before = await fileInventory(root);
  const result = await exportRedactedBundle(root, destination, { schemaVersion: "trial-runner/redaction/v1", omitFiles: ["events.ndjson", "final-state.json"] });
  assert.equal(result.manifest.parentBundleSha256, hash(original)); assert.notEqual(result.digest, hash(original));
  assert.equal(result.manifest.evidence.state, "incomplete");
  await assert.rejects(fs.stat(path.join(destination, "events.ndjson")), { code: "ENOENT" });
  await assert.rejects(verifyBundle(destination), /Invalid manifest/);
  await verifyRedactedBundle(destination, root, result.digest);
  assert.deepEqual(await fs.readFile(path.join(root, "manifest.json")), original); assert.deepEqual(await fileInventory(root), before);
  await assert.rejects(exportRedactedBundle(root, destination, { schemaVersion: "trial-runner/redaction/v1", omitFiles: ["events.ndjson"] }), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(path.join(destination, "manifest.json")), jsonBytes(result.manifest));
});

for (const damage of ["changed-file", "unlisted-file", "symlink", "upgraded", "changed-source", "source-swap"]) test(`derivative verification rejects ${damage}`, async t => {
  const source = await bundleFixture(); const other = await bundleFixture(); const destination = source.root + "-export";
  t.after(async () => { for (const root of [source.root, other.root, destination]) await fs.rm(root, { recursive: true, force: true }); });
  const result = await exportRedactedBundle(source.root, destination, { schemaVersion: "trial-runner/redaction/v1", omitFiles: ["events.ndjson"] });
  if (damage === "changed-file") await fs.appendFile(path.join(destination, "final-state.json"), " ");
  if (damage === "unlisted-file") await fs.writeFile(path.join(destination, "extra.txt"), "unlisted");
  if (damage === "symlink") { await fs.rm(path.join(destination, "final-state.json")); await fs.symlink(path.join(source.root, "final-state.json"), path.join(destination, "final-state.json")); }
  if (damage === "upgraded") { (result.manifest.evidence as { state: string }).state = "complete"; await fs.writeFile(path.join(destination, "manifest.json"), jsonBytes(result.manifest)); }
  if (damage === "changed-source") await fs.appendFile(path.join(source.root, "events.ndjson"), " ");
  if (damage === "source-swap") {
    other.manifest.requestId = randomUUID(); await fs.writeFile(path.join(other.root, "manifest.json"), jsonBytes(other.manifest));
  }
  await assert.rejects(verifyRedactedBundle(destination, damage === "source-swap" ? other.root : source.root));
});

test("export rejects missing selections, nested destinations and symlink aliases into its source", async t => {
  const { root } = await bundleFixture(); const link = root + "-alias";
  t.after(async () => { await fs.rm(link, { force: true }); await fs.rm(root, { recursive: true, force: true }); });
  const policy = { schemaVersion: "trial-runner/redaction/v1", omitFiles: ["events.ndjson"] };
  await assert.rejects(exportRedactedBundle(root, root + "-missing", { ...policy, omitFiles: ["absent.json"] }), /absent/);
  await assert.rejects(exportRedactedBundle(root, path.join(root, "child"), policy), /outside/);
  await fs.symlink(root, link); await assert.rejects(exportRedactedBundle(root, path.join(link, "child"), policy), /outside/);
});

test("CLI creates and verifies a redacted export only against its explicit source", async t => {
  const { root } = await bundleFixture(); const destination = root + "-cli"; const policyFile = root + "-policy.json";
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(destination, { recursive: true, force: true }); await fs.rm(policyFile, { force: true }); });
  await fs.writeFile(policyFile, jsonBytes({ schemaVersion: "trial-runner/redaction/v1", omitFiles: ["events.ndjson"] }));
  const cli = fileURLToPath(new URL("../src/cli/main.js", import.meta.url)); const exec = promisify(execFile);
  const invoke = (...args: string[]) => exec(process.execPath, [cli, ...args]);
  const output = JSON.parse((await invoke("export", root, "--format", "redacted-bundle", "--redaction", policyFile, "--out", destination)).stdout);
  assert.match((await invoke("verify", destination, "--source", root, "--sha256", output.digest)).stdout, /evidence=incomplete/);
  await assert.rejects(invoke("verify", destination));
  await assert.rejects(invoke("export", destination, "--format", "assessment-input", "--out", destination + "-assessment.json"));
});
