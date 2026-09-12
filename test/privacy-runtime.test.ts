import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initExample } from "../src/cli/init.js";
import { runPlan } from "../src/core/run.js";
import { hash, jsonBytes, readJson } from "../src/core/files.js";
import { verifyBundle } from "../src/contracts/verify.js";
import type { Artifact, Plan } from "../src/contracts/types.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-private-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = await initExample(path.join(root, "example")); const directory = path.dirname(file); const store = path.join(root, "store");
  const plan = await readJson(directory, "plan.json") as Plan;
  plan.repetitions = 1; Object.assign(plan.limits, { prepareMs: 300000, trialMs: 10000, stopGraceMs: 30, snapshotMs: 5000, cleanupMs: 5000 });
  plan.secretBindings = [{ name: "AGENT_TOKEN", recipient: "agent" }, { name: "ENV_TOKEN", recipient: "environment" }];
  const environment = { AGENT_TOKEN: randomUUID() + '\\"\nΩ', ENV_TOKEN: randomUUID(), UNRELATED: randomUUID() };
  const save = () => fs.writeFile(file, jsonBytes(plan)); await save();
  const patch = async (role: "agent" | "environment", edit: (code: string) => string) => {
    const name = `reference/${role}.js`; const previous = await fs.readFile(path.join(directory, name), "utf8"); const bytes = Buffer.from(edit(previous));
    assert.notEqual(bytes.toString(), previous);
    await fs.writeFile(path.join(directory, name), bytes);
    for (const artifactName of ["agent-artifact.json", "environment-artifact.json"]) {
      const artifact = await readJson(directory, artifactName) as Artifact;
      Object.assign(artifact.files.find(file => file.path === name)!, { bytes: bytes.length, sha256: hash(bytes) });
      await fs.writeFile(path.join(directory, artifactName), jsonBytes(artifact));
    }
  };
  const run = () => runPlan(file, { requestId: "private", store, secretEnvironment: environment });
  const scan = async () => {
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else {
          const text = await fs.readFile(full, "utf8");
          for (const value of Object.values(environment)) for (const spelling of [value, JSON.stringify(value).slice(1, -1), hash(value)]) assert.equal(text.includes(spelling), false, `Secret material persisted in ${path.relative(root, full)}`);
        }
      }
    };
    await walk(store);
  };
  return { root, file, directory, store, plan, environment, patch, save, run, scan };
}

test("credential injection is recipient-specific, and missing/rotated credentials cannot replay a request", async t => {
  const f = await fixture(t);
  await f.patch("agent", code => code.replace('if (frame.kind === "start") {', 'if (frame.kind === "start") { if (!process.env.AGENT_TOKEN || process.env.ENV_TOKEN || process.env.UNRELATED) throw new Error("Incorrect credential scope");'));
  await f.patch("environment", code => code.replace('case "prepare": {', 'case "prepare": { if (!process.env.ENV_TOKEN || process.env.AGENT_TOKEN || process.env.UNRELATED) throw new Error("Incorrect credential scope");'));
  const first = await f.run(); assert.equal(first.index.exitCode, 0); await f.scan();
  const duplicate = await runPlan(f.file, { requestId: "private", store: f.store, secretEnvironment: {} });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.index.runId, first.index.runId);
  const rotated = await runPlan(f.file, { requestId: "private", store: f.store, secretEnvironment: { AGENT_TOKEN: randomUUID(), ENV_TOKEN: randomUUID() } });
  assert.equal(rotated.index.runId, first.index.runId);
});

test("invalid available credentials are rejected before a value-bearing preflight failure", async t => {
  const f = await fixture(t);
  for (const value of [randomUUID().slice(0, 7), randomUUID().repeat(120), randomUUID() + "REDACTED"]) {
    f.environment.AGENT_TOKEN = value; f.plan.evidenceProfile = value + ".json"; await f.save();
    await assert.rejects(f.run(), (error: Error) => { assert.equal(error.message.includes(value), false); return true; });
    await assert.rejects(fs.stat(f.store), { code: "ENOENT" });
  }
});

test("raw calls use credentials while snapshots, results, nested JSON and split diagnostics are masked", async t => {
  const f = await fixture(t);
  const schema = await readJson(f.directory, "fixture.schema.json") as { properties: Record<string, unknown> };
  schema.properties.note = { type: "string" }; await fs.writeFile(path.join(f.directory, "fixture.schema.json"), jsonBytes(schema));
  await f.patch("environment", code => code.replace('state = structuredClone(frame.payload.state);', 'state = structuredClone(frame.payload.state); state.note = process.env.ENV_TOKEN;')
    .replace('bindings: { leaseId }', 'bindings: { leaseId, observedCredential: process.env.ENV_TOKEN }'));
  await f.patch("agent", code => code.replace('key: "request-1"', 'key: process.env.AGENT_TOKEN')
    .replace('output = JSON.stringify(result);', 'if (result.value.key !== process.env.AGENT_TOKEN) throw new Error("Live response was rewritten"); output = JSON.stringify(result);')
    .replace('if (frame.kind === "user_turn") {', 'if (frame.kind === "user_turn") { const secret = process.env.AGENT_TOKEN; process.stderr.write(secret.slice(0, 10)); await new Promise(resolve => setTimeout(resolve, 10)); process.stderr.write(secret.slice(10));'));
  const result = await f.run(); const slot = result.index.trials[0]!;
  const { manifest } = await verifyBundle(path.join(result.root, slot.path), slot.bundleSha256!);
  assert.equal(manifest.execution, "finished"); assert.equal(manifest.cleanup, "succeeded"); assert.equal(result.index.exitCode, 2);
  assert.equal(manifest.evidence.state, "incomplete"); assert.ok(manifest.evidence.gaps.includes("required_content_redacted"));
  assert.deepEqual(manifest.evidence.redactedPaths, ["environment-prepared.json", "events.ndjson", "final-state.json", "initial-state.json"]);
  assert.equal(manifest.operations.length, 3); assert.ok(manifest.operations.every(op => op.outcome === "known_result"));
  const events = (await fs.readFile(path.join(result.root, slot.path, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.filter(event => event.kind === "assistant.turn").every(event => event.payload.content === "REDACTED"), "Encoded credentials inside assistant JSON must not survive another decode");
  await f.scan();
});

test("cleanup evidence and retained runner metadata never contain resource credentials", async t => {
  const f = await fixture(t); f.plan.environment.settings.cleanupFailure = true; await f.save();
  await f.patch("environment", code => code.replace('resources: leaseId ? [leaseId] : []', 'resources: [process.env.ENV_TOKEN]'));
  const result = await f.run(); const slot = result.index.trials[0]!;
  const { manifest } = await verifyBundle(path.join(result.root, slot.path));
  assert.equal(manifest.cleanup, "failed"); assert.ok(manifest.evidence.redactedPaths.includes("environment-disposed.json"));
  await f.scan();
});

for (const surface of ["scenario", "source", "error", "structural-key"] as const) test(`known secret at ${surface} fails or redacts without exposing it`, async t => {
  const f = await fixture(t);
  if (surface === "scenario") {
    const scenario = await readJson(f.directory, "scenario.json") as { messages: { content: string }[] };
    scenario.messages[0]!.content = f.environment.AGENT_TOKEN; await fs.writeFile(path.join(f.directory, "scenario.json"), jsonBytes(scenario));
  } else if (surface === "source") await f.patch("agent", code => code + "\n// " + JSON.stringify(f.environment.AGENT_TOKEN));
  else if (surface === "error") await f.patch("agent", code => code.replace('if (frame.kind === "user_turn") {', 'if (frame.kind === "user_turn") { peer.notify("agent_error", { message: process.env.AGENT_TOKEN }); return;'));
  else await f.patch("agent", code => code.replace('key: "request-1", quantity: 1', '[process.env.AGENT_TOKEN]: true, quantity: 1'));
  if (surface === "scenario" || surface === "source") {
    await assert.rejects(f.run(), (error: Error) => { assert.equal(error.message.includes(f.environment.AGENT_TOKEN), false); return true; });
    await assert.rejects(fs.stat(f.store), { code: "ENOENT" });
  } else {
    const result = await f.run(); assert.equal(result.index.exitCode, 2); await f.scan();
  }
});

test("literal REDACTED error text with no credentials does not invent a redaction", async t => {
  const f = await fixture(t); f.plan.secretBindings = []; await f.save();
  await f.patch("agent", code => code.replace('if (frame.kind === "user_turn") {', 'if (frame.kind === "user_turn") { peer.notify("agent_error", { message: "REDACTED" }); return;'));
  const result = await f.run(); const { manifest } = await verifyBundle(path.join(result.root, result.index.trials[0]!.path));
  assert.equal(manifest.execution, "agent_error"); assert.equal(manifest.evidence.state, "complete"); assert.deepEqual(manifest.evidence.redactedPaths, []);
});
