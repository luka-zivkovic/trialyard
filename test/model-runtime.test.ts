import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { initExample } from "../src/cli/init.js";
import { runPlan } from "../src/core/run.js";
import { Journal } from "../src/core/journal.js";
import { hash, jsonBytes, readJson } from "../src/core/files.js";
import { verifyBundle } from "../src/contracts/verify.js";
import type { Artifact, Event, Plan, Profile } from "../src/contracts/types.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-model-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = await initExample(path.join(root, "example"), "model-accounting"), directory = path.dirname(file), store = path.join(root, "store");
  const plan = await readJson(directory, "plan.json") as Plan, profile = await readJson(directory, "profile.json") as Profile;
  plan.repetitions = 1; Object.assign(plan.limits, { prepareMs: 10000, trialMs: 5000, stopGraceMs: 30, snapshotMs: 2000, cleanupMs: 2000 });
  const save = async () => { await fs.writeFile(file, jsonBytes(plan)); await fs.writeFile(path.join(directory, "profile.json"), jsonBytes(profile)); }; await save();
  const patch = async (edit: (code: string) => string, name = "reference/model-agent.js") => {
    const previous = await fs.readFile(path.join(directory, name), "utf8"), bytes = Buffer.from(edit(previous)); assert.notEqual(bytes.toString(), previous);
    await fs.writeFile(path.join(directory, name), bytes);
    for (const artifactName of ["agent-artifact.json", "environment-artifact.json"]) {
      const artifact = await readJson(directory, artifactName) as Artifact;
      Object.assign(artifact.files.find(file => file.path === name)!, { bytes: bytes.length, sha256: hash(bytes) });
      await fs.writeFile(path.join(directory, artifactName), jsonBytes(artifact));
    }
  };
  const run = async (secretEnvironment?: NodeJS.ProcessEnv) => {
    const result = await runPlan(file, { store, requestId: "model", secretEnvironment });
    const bundle = path.join(result.root, result.index.trials[0]!.path), { manifest } = await verifyBundle(bundle);
    const events = (await fs.readFile(path.join(bundle, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Event);
    return { result, manifest, events, bundle };
  };
  return { root, file, directory, store, plan, profile, save, patch, run };
}

test("model example accounts physical retries, conversation and null provenance through the CLI", async t => {
  const f = await fixture(t); const { result, manifest, events } = await f.run();
  assert.equal(result.index.exitCode, 0); assert.equal(manifest.execution, "finished");
  const models = manifest.operations.filter(op => op.boundary === "model");
  assert.equal(models.length, 4); assert.deepEqual(models.map(op => op.outcome), ["known_failure", "known_result", "known_failure", "known_result"]);
  assert.equal(new Set(models.map(op => op.id)).size, 4); assert.equal(models[0]!.logicalCallId, models[1]!.logicalCallId);
  assert.equal((manifest.provider.observed as { modelRevision: null }[]).every(item => item.modelRevision === null), true);
  assert.equal((manifest.provider.cost as { value: null }[]).every(item => item.value === null), true);
  const requests = events.filter(e => e.kind === "operation.dispatch_intent" && e.payload.boundary === "model");
  assert.equal(((requests[2]!.payload.args as { input: unknown[] }).input).length, 3);
  const cli = path.resolve("dist/src/cli/main.js");
  const init = spawnSync(process.execPath, [cli, "init", path.join(f.root, "cli-example"), "--example", "model-accounting"], { encoding: "utf8" }); assert.equal(init.status, 0, init.stderr);
  const validate = spawnSync(process.execPath, [cli, "validate", path.join(f.root, "cli-example/plan.json")], { encoding: "utf8" }); assert.equal(validate.status, 0, validate.stderr);
});

for (const required of [false, true]) test(`missing model usage remains unknown with usage requirement=${required}`, async t => {
  const f = await fixture(t); f.profile.required.modelUsage = required; await f.save();
  await f.patch(code => code.replace('usage: { inputTokens: 3, outputTokens: 2, source: "provider_reported" }', "usage: null"));
  const { result, manifest } = await f.run(); assert.equal(result.index.exitCode, required ? 2 : 0);
  assert.equal(manifest.evidence.gaps.includes("model_usage_missing"), required);
  assert.ok((manifest.provider.usage as { value: null }[]).every(item => item.value === null));
});

test("reported capture cannot claim exact attempt coverage", async t => {
  const f = await fixture(t); f.profile.modelCapture = "reported"; f.plan.agent.capabilities = f.plan.agent.capabilities.map(c => c === "model-accounted" ? "model-reported" : c); await f.save();
  const { manifest } = await f.run(); assert.equal(manifest.execution, "finished"); assert.ok(manifest.evidence.gaps.includes("model_attempts_unverified"));
});

for (const variant of ["zero", "missing", "foreign", "open", "before-ready", "wrong-owner", "duplicate-dispatch", "after-intent", "after-observed"] as const) test(`model worker coverage/lifecycle: ${variant}`, async t => {
  const f = await fixture(t);
  if (variant === "zero") await f.patch(code => code.replace("attempt < 2", "attempt < 0"));
  if (variant === "missing") await f.patch(code => code.replace("modelOperations: recorder.completeTurn()", "modelOperations: null"));
  if (variant === "foreign") await f.patch(code => code.replace("modelOperations: recorder.completeTurn()", 'modelOperations: ["foreign"]'));
  if (variant === "open") await f.patch(code => code.replace('await recorder.finish(operation,', 'if (false) await recorder.finish(operation,').replace("modelOperations: recorder.completeTurn()", "modelOperations: []"));
  if (variant === "before-ready") await f.patch(code => code.replace('capture = String(frame.payload.modelCapture);', 'capture = String(frame.payload.modelCapture); await new ModelRecorder(peer).intent({ provider: "synthetic", model: "alias", settings: {}, input: null });'));
  if (variant === "wrong-owner") await f.patch(code => code.replace('owner: "agent"', 'owner: "runner"'), "src/sdk/models.js");
  if (variant === "duplicate-dispatch") await f.patch(code => code.replace('await recorder.observed(operation);', 'await recorder.observed(operation); await peer.request("event", {kind:"operation.dispatch_observed",operationId:operation.id,logicalCallId:operation.logicalCallId,parentOperationId:null,data:{}});'));
  if (variant === "after-intent") await f.patch(code => code.replace("const result = synthetic(attempt);", "process.exit(7); const result = synthetic(attempt);"));
  if (variant === "after-observed") { f.plan.limits.trialMs = 1000; await f.save(); await f.patch(code => code.replace('await recorder.observed(operation);', 'await recorder.observed(operation); await new Promise(() => {});')); }
  const { manifest } = await f.run();
  if (variant === "zero") { assert.equal(manifest.evidence.state, "complete"); assert.equal(manifest.operations.filter(op => op.boundary === "model").length, 0); }
  else if (variant === "missing") { assert.equal(manifest.execution, "finished"); assert.ok(manifest.evidence.gaps.includes("model_turn_coverage_missing")); }
  else if (variant === "after-intent" || variant === "after-observed") {
    assert.equal(manifest.execution, variant === "after-intent" ? "adapter_error" : "timed_out");
    assert.equal(manifest.operations[0]!.observed, variant === "after-observed"); assert.equal(manifest.operations[0]!.outcome, "outcome_unknown");
    assert.ok(manifest.evidence.gaps.includes("model_operation_outcome_unknown"));
    if (variant === "after-observed") assert.ok(manifest.evidence.gaps.includes("agent_reported_outstanding_work"));
  } else assert.equal(manifest.execution, "protocol_error");
  if (variant !== "zero") assert.equal(manifest.evidence.state, "incomplete");
});

test("model dispatch waits for durable intent acknowledgment", async t => {
  const f = await fixture(t), marker = path.join(f.root, "physical-callback");
  await f.patch(code => 'import { appendFileSync } from "node:fs";\n' + code.replace('const result = synthetic(attempt);', `appendFileSync(${JSON.stringify(marker)}, "called\\n"); const result = synthetic(attempt);`));
  const append = Journal.prototype.append; let checked = false;
  Journal.prototype.append = async function(kind, payload, extra, terminal) {
    if (!checked && kind === "operation.dispatch_intent" && payload.boundary === "model") {
      checked = true; await sleep(75); await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    }
    return append.call(this, kind, payload, extra, terminal);
  };
  try { const { result } = await f.run(); assert.equal(result.index.exitCode, 0); assert.equal((await fs.readFile(marker, "utf8")).trim().split("\n").length, 4); assert.equal(checked, true); }
  finally { Journal.prototype.append = append; }
});

test("model input, output and metadata credentials are masked before storage", async t => {
  const f = await fixture(t), secret = randomUUID() + '\\"\nΩ';
  f.plan.secretBindings = [{ name: "MODEL_TOKEN", recipient: "agent" }]; await f.save();
  await f.patch(code => code.replace('output: { next: "inspect inventory" }', 'output: { next: process.env.MODEL_TOKEN }').replace("requestId: null", "requestId: process.env.MODEL_TOKEN").replace("input: history", "input: process.env.MODEL_TOKEN"));
  const { manifest, bundle } = await f.run({ MODEL_TOKEN: secret }); assert.equal(manifest.execution, "finished"); assert.ok(manifest.evidence.redactedPaths.includes("events.ndjson"));
  for (const file of [...manifest.files, { path: "manifest.json" }]) {
    const bytes = await fs.readFile(path.join(bundle, file.path), "utf8");
    for (const value of [secret, JSON.stringify(secret).slice(1, -1), hash(secret)]) assert.equal(bytes.includes(value), false, file.path);
  }
});

test("stop acknowledgment retains outstanding activity and consumers reject its removal", async t => {
  const f = await fixture(t);
  await f.patch(code => code.replace('outstandingOperationIds: recorder?.outstandingOperations() ?? []', 'outstandingOperationIds: ["external-unknown"]'));
  const { manifest, bundle } = await f.run();
  assert.equal(manifest.execution, "finished"); assert.equal(manifest.evidence.state, "incomplete");
  assert.ok(manifest.files.some(file => file.path === "agent-stopped.json")); assert.ok(manifest.evidence.gaps.includes("agent_reported_outstanding_work"));
  manifest.evidence.gaps = []; manifest.evidence.state = "complete";
  await fs.writeFile(path.join(bundle, "manifest.json"), jsonBytes(manifest)); await assert.rejects(verifyBundle(bundle), /Outstanding adapter work/);
});

test("consumer rejects an effective model handshake downgrade even with rehashed files", async t => {
  const f = await fixture(t); const { manifest, bundle } = await f.run();
  const ready = await readJson(bundle, "agent-ready.json") as { payload: Record<string, unknown> }; ready.payload.modelCapture = "reported";
  const bytes = jsonBytes(ready); await fs.writeFile(path.join(bundle, "agent-ready.json"), bytes);
  Object.assign(manifest.files.find(file => file.path === "agent-ready.json")!, { bytes: bytes.length, sha256: hash(bytes) });
  await fs.writeFile(path.join(bundle, "manifest.json"), jsonBytes(manifest)); await assert.rejects(verifyBundle(bundle), /Effective model handshake/);
});

test("environment cannot claim observation of an agent-owned model operation", async t => {
  const f = await fixture(t);
  await f.patch(code => 'import { writeFileSync } from "node:fs";\n' + code.replace('const result = synthetic(attempt);', 'writeFileSync("model-id", operation.id); await peer.request("tool_call", { turnId: frame.payload.turnId, tool: "stock", args: {}, logicalCallId: null }); const result = synthetic(attempt);'));
  await f.patch(code => 'import { readFileSync } from "node:fs";\n' + code.replace('case "execute": {', 'case "execute": { await peer.request("event", {kind:"operation.dispatch_observed",operationId:readFileSync("model-id","utf8"),logicalCallId:null,parentOperationId:null,data:{}});'), "reference/environment.js");
  const { manifest, events } = await f.run(); assert.equal(manifest.execution, "protocol_error");
  const model = manifest.operations.find(op => op.boundary === "model")!; assert.equal(model.observed, false); assert.equal(model.outcome, "outcome_unknown");
  assert.equal(events.some(event => event.operationId === model.id && event.source === "environment_observed"), false);
});
