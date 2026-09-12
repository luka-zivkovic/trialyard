import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { contract } from "../src/contracts/validate.js";
import { parseJson } from "../src/contracts/strict-json.js";
import { verifyBundle } from "../src/contracts/verify.js";
import type { RedactedManifest } from "../src/contracts/types.js";
import { fileInventory, hash, jsonBytes, safeFile } from "../src/core/files.js";
import { exportRedactedBundle } from "../src/export/redacted.js";
import { bundleFixture } from "./fixtures.js";

/** Independently authored from the public closed schema and ancestry contract. */
async function consumeDerivative(root: string, sourceRoot: string, expectedDigest?: string): Promise<RedactedManifest> {
  const bytes = await safeFile(root, "manifest.json", 8 * 1024 * 1024);
  if (expectedDigest !== undefined) assert.equal(hash(bytes), expectedDigest);
  const derivative = contract<RedactedManifest>("derivative", parseJson(bytes, 8 * 1024 * 1024));
  const { manifest: source, digest } = await verifyBundle(sourceRoot, derivative.parentBundleSha256);
  assert.equal(derivative.parentBundleSha256, digest);
  for (const field of ["runId", "requestId", "trialId", "scenarioId", "repetition", "execution", "cleanup"] as const) {
    assert.equal(derivative[field], source[field]);
  }
  assert.equal(derivative.authenticity, "not_attested");
  assert.equal(derivative.evidence.state, "incomplete");
  const retained = new Set(derivative.files.map(file => file.path));
  assert.equal(retained.size, derivative.files.length);
  assert.equal(retained.has("manifest.json"), false);
  const omitted = source.files.filter(file => !retained.has(file.path)).map(file => file.path);
  assert.ok(omitted.length > 0, "A derivative must omit source content");
  assert.deepEqual(derivative.files, source.files.filter(file => retained.has(file.path)));
  assert.deepEqual(derivative.evidence.gaps, [...new Set([...source.evidence.gaps, "redacted_export"])].sort());
  assert.deepEqual(derivative.evidence.redactedPaths, [...new Set([...source.evidence.redactedPaths, ...omitted])].sort());
  assert.deepEqual(await fileInventory(root), [...retained, "manifest.json"].sort());
  for (const file of derivative.files) {
    const content = await safeFile(root, file.path);
    assert.equal(content.length, file.bytes);
    assert.equal(hash(content), file.sha256);
  }
  return derivative;
}

test("independent consumer verifies a real derivative and preserves incomplete source coverage", async t => {
  const source = await bundleFixture();
  const destination = await fs.mkdtemp(path.join(tmpdir(), "trial-independent-derivative-"));
  t.after(() => Promise.all([fs.rm(source.root, { recursive: true, force: true }), fs.rm(destination, { recursive: true, force: true })]));
  source.manifest.evidence.state = "incomplete";
  source.manifest.evidence.gaps = ["independent_fixture_gap"];
  await fs.writeFile(path.join(source.root, "manifest.json"), jsonBytes(source.manifest));
  const originalBytes = await fs.readFile(path.join(source.root, "manifest.json"));
  const output = await exportRedactedBundle(source.root, path.join(destination, "valid"), {
    schemaVersion: "trial-runner/redaction/v1", omitFiles: ["events.ndjson", "final-state.json"],
  });
  const consumed = await consumeDerivative(output.root, source.root, output.digest);
  assert.deepEqual(consumed.evidence.gaps, ["independent_fixture_gap", "redacted_export"]);
  assert.notEqual(output.digest, hash(originalBytes));
  assert.deepEqual(await fs.readFile(path.join(source.root, "manifest.json")), originalBytes);
  await assert.rejects(fs.stat(path.join(output.root, "events.ndjson")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(output.root, "final-state.json")), { code: "ENOENT" });
  await assert.rejects(verifyBundle(output.root));
  await assert.rejects(consumeDerivative(output.root, source.root, "0".repeat(64)));

  const mutations: [string, (manifest: RedactedManifest, root: string) => Promise<void> | void][] = [
    ["complete coverage", manifest => { (manifest.evidence as { state: string }).state = "complete"; }],
    ["source gap removed", manifest => { manifest.evidence.gaps = ["redacted_export"]; }],
    ["omitted path hidden", manifest => { manifest.evidence.redactedPaths = ["events.ndjson"]; }],
    ["wrong ancestry", manifest => { manifest.parentBundleSha256 = "0".repeat(64); }],
    ["changed execution", manifest => { manifest.execution = "agent_error"; }],
    ["changed cleanup", manifest => { manifest.cleanup = "failed"; }],
    ["changed trial identity", manifest => { manifest.trialId = "other-trial"; }],
    ["retained bytes rehashed", async (manifest, root) => {
      const file = manifest.files.find(file => file.path === "initial-state.json")!;
      const bytes = Buffer.from("{}\n");
      await fs.writeFile(path.join(root, file.path), bytes);
      file.bytes = bytes.length; file.sha256 = hash(bytes);
    }],
    ["retained bytes changed", async (_manifest, root) => { await fs.appendFile(path.join(root, "initial-state.json"), " "); }],
    ["duplicate inventory", manifest => { manifest.files.push(structuredClone(manifest.files[0]!)); }],
    ["native manifest copied as content", async (_manifest, root) => { await fs.writeFile(path.join(root, "source-manifest.json"), originalBytes); }],
    ["omitted file restored without listing", async (_manifest, root) => {
      await fs.copyFile(path.join(source.root, "events.ndjson"), path.join(root, "events.ndjson"));
    }],
    ["nothing omitted", async (manifest, root) => {
      for (const name of ["events.ndjson", "final-state.json"]) await fs.copyFile(path.join(source.root, name), path.join(root, name));
      manifest.files = structuredClone(source.manifest.files); manifest.evidence.redactedPaths = [];
    }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const root = path.join(destination, `case-${mutations.findIndex(item => item[0] === name)}`);
    await fs.cp(output.root, root, { recursive: true });
    const manifest = structuredClone(consumed);
    await mutate(manifest, root);
    await fs.writeFile(path.join(root, "manifest.json"), jsonBytes(manifest));
    await assert.rejects(consumeDerivative(root, source.root));
  });

  await fs.appendFile(path.join(source.root, "events.ndjson"), " ");
  await assert.rejects(consumeDerivative(output.root, source.root));
});
