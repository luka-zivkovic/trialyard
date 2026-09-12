import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { initExample } from "../src/cli/init.js";
import { AcceptedRunError, runPlan, showRun } from "../src/core/run.js";
import { inspectRun } from "../src/core/inspect.js";
import { hash, jsonBytes, readJson } from "../src/core/files.js";
import { CaptureLimitError, Journal } from "../src/core/journal.js";
import { Worker, WireBudget, before } from "../src/core/process.js";
import { verifyBundle } from "../src/contracts/verify.js";
import type { Adapter, Artifact, Event, Limits, Plan } from "../src/contracts/types.js";

async function setup(t: TestContext, change: (plan: Plan) => void = () => {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-capture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = await initExample(path.join(root, "example")); const inputRoot = path.dirname(file);
  const plan = await readJson(inputRoot, "plan.json") as Plan;
  plan.repetitions = 1;
  Object.assign(plan.limits, { prepareMs: 300000, trialMs: 10000, stopGraceMs: 30, snapshotMs: 5000, cleanupMs: 5000 });
  change(plan); await fs.writeFile(file, jsonBytes(plan));
  const patch = async (role: "agent" | "environment", edit: (code: string) => string) => {
    const name = `reference/${role}.js`; const filename = path.join(inputRoot, name);
    const original = await fs.readFile(filename, "utf8"); const bytes = Buffer.from(edit(original));
    assert.notEqual(bytes.toString(), original, "Test injection must change the worker");
    await fs.writeFile(filename, bytes);
    for (const artifactName of ["agent-artifact.json", "environment-artifact.json"]) {
      const artifact = await readJson(inputRoot, artifactName) as Artifact;
      Object.assign(artifact.files.find(entry => entry.path === name)!, { bytes: bytes.length, sha256: hash(bytes) });
      await fs.writeFile(path.join(inputRoot, artifactName), jsonBytes(artifact));
    }
  };
  const run = async () => {
    const result = await runPlan(file, { requestId: "capture", store: path.join(root, "store") });
    const slot = result.index.trials[0]!; const bundleRoot = path.join(result.root, slot.path);
    const bundle = await verifyBundle(bundleRoot, slot.bundleSha256!);
    const events = (await fs.readFile(path.join(bundleRoot, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) as Event[];
    const names = ["events.ndjson", "initial-state.json", "final-state.json", "environment-described.json", "environment-prepared.json", "agent-ready.json", "environment-disposed.json"];
    const captured = bundle.manifest.files.filter(file => names.includes(file.path)).reduce((sum, file) => sum + file.bytes, 0);
    assert.ok(captured <= plan.limits.maxRecordedBytes, `${captured} exceeds ${plan.limits.maxRecordedBytes}`);
    assert.ok(events.length <= plan.limits.maxEvents);
    assert.equal(events.at(-1)!.kind, "trial.terminal");
    return { ...bundle, result, events };
  };
  return { root, file, plan, patch, run };
}

for (const variant of ["frame", "unterminated", "stderr"] as const) test(`actual worker ${variant} overflow stops with a verified capture gap`, { timeout: 20000 }, async t => {
  const fixture = await setup(t, plan => { plan.limits.maxFrameBytes = 16384; plan.limits.maxRecordedBytes = 32768; });
  await fixture.patch("agent", code => code.replace('if (frame.kind === "user_turn") {', `if (frame.kind === "user_turn") {
    process.${variant === "stderr" ? "stderr" : "stdout"}.write("x".repeat(${variant === "stderr" ? 131072 : 16384}) + ${JSON.stringify(variant === "unterminated" ? "" : "\n")});
    return;`));
  const { manifest, result } = await fixture.run();
  assert.equal(result.index.exitCode, 2); assert.equal(manifest.evidence.state, "incomplete");
  assert.ok(manifest.evidence.gaps.includes("capture_limit_exceeded"));
  assert.ok(manifest.files.some(file => file.path === "initial-state.json"), "Earlier durable state survives overflow");
});

for (const variant of ["partial-frame", "invalid-frame-utf8", "invalid-diagnostic-utf8"]) test(`${variant} is an explicit protocol failure`, { timeout: 20000 }, async t => {
  const fixture = await setup(t);
  const injection = variant === "partial-frame" ? 'process.stdout.write("{", () => process.exit(0));'
    : `process.${variant === "invalid-frame-utf8" ? "stdout" : "stderr"}.write(Buffer.from([255, 10]));`;
  await fixture.patch("agent", code => code.replace('if (frame.kind === "user_turn") {', `if (frame.kind === "user_turn") { ${injection} return;`));
  const { manifest, result } = await fixture.run();
  assert.equal(result.index.exitCode, 2); assert.equal(manifest.evidence.state, "incomplete");
  if (variant === "partial-frame" && manifest.execution === "adapter_error") assert.ok(manifest.evidence.gaps.includes("protocol_error_during_stop"));
  else assert.equal(manifest.execution, "protocol_error");
});

test("environment and agent diagnostics consume one recorded-payload allowance", { timeout: 20000 }, async t => {
  const fixture = await setup(t, plan => { plan.limits.maxRecordedBytes = 24576; });
  await fixture.patch("environment", code => code.replace('case "describe":', 'case "describe": process.stderr.write("environment:" + "e".repeat(9000));'));
  await fixture.patch("agent", code => code.replace('if (frame.kind === "user_turn") {', 'if (frame.kind === "user_turn") { process.stderr.write("agent:" + "a".repeat(9000)); await new Promise(resolve => setTimeout(resolve, 30));'));
  const { manifest, events } = await fixture.run();
  assert.ok(events.some(event => event.kind === "diagnostic" && String(event.payload.text).startsWith("environment:")));
  assert.ok(manifest.files.some(file => file.path === "initial-state.json"));
  assert.equal(manifest.evidence.state, "incomplete"); assert.ok(manifest.evidence.gaps.includes("capture_limit_exceeded"));
});

test("shutdown drains split UTF-8 diagnostics before publishing terminal evidence", { timeout: 20000 }, async t => {
  const fixture = await setup(t);
  await fixture.patch("environment", code => code.replace('case "dispose":', 'case "dispose": process.stderr.write(Buffer.from([0xe2])); await new Promise(resolve => setTimeout(resolve, 10)); process.stderr.write(Buffer.from([0x82, 0xac]));'));
  const { manifest, events } = await fixture.run();
  assert.equal(manifest.evidence.state, "complete");
  assert.equal(events.filter(event => event.kind === "diagnostic").map(event => event.payload.text).join(""), "€");
});

test("capture failure during disposal cannot be published as complete", { timeout: 20000 }, async t => {
  const fixture = await setup(t, plan => { plan.limits.maxRecordedBytes = 32768; });
  await fixture.patch("environment", code => code.replace('case "dispose":', 'case "dispose": process.stderr.write("x".repeat(131072));'));
  const { manifest, result } = await fixture.run();
  assert.equal(result.index.exitCode, 2); assert.equal(manifest.evidence.state, "incomplete");
  assert.ok(manifest.evidence.gaps.includes("capture_limit_exceeded"));
  assert.ok(manifest.files.some(file => file.path === "final-state.json"));
});

test("actual worker streams share a finite wire budget and queued diagnostics drain", async t => {
  const fixture = await setup(t);
  const limits: Limits = { ...fixture.plan.limits, maxRecordedBytes: 1024, maxFrameBytes: 256 };
  const wire = new WireBudget(limits); const captured: string[] = [];
  await fs.writeFile(path.join(fixture.root, "noisy.js"), 'process.stderr.write("x".repeat(3000)); setInterval(() => {}, 1000);');
  const adapter: Adapter = { ...fixture.plan.agent, argv: ["node", "noisy.js"], cwd: "." };
  const workers = ["agent", "environment"].map(role => new Worker(role as "agent" | "environment", "wire", adapter, fixture.root, limits, async () => {}, async text => { await sleep(30); captured.push(text); }, wire));
  t.after(async () => { for (const worker of workers) { await worker.terminate(10); await worker.drain(); } });
  await assert.rejects(before(Promise.race(workers.map(worker => worker.failure)), Date.now() + 3000), CaptureLimitError);
  for (const worker of workers) { await worker.terminate(10); await worker.drain(); }
  assert.equal(captured.join("").length, 3000); assert.ok(wire.limit < 6000);
});

test("recording the exact byte boundary preserves reserved closure capacity", async t => {
  const fixture = await setup(t);
  const limits = { ...fixture.plan.limits, maxRecordedBytes: 16384 };
  const journal = await Journal.create(path.join(fixture.root, "events.ndjson"), "run", "trial", limits);
  t.after(() => journal.close());
  await journal.append("trial.started", { scenarioId: "scenario", repetition: 0 });
  const remaining = limits.maxRecordedBytes - journal.recordedBytes - 4096;
  await journal.capture("initial-state.json", Buffer.alloc(remaining));
  await assert.rejects(journal.capture("final-state.json", Buffer.alloc(1)), CaptureLimitError);
  await journal.append("capture.gap", { reason: "capture_limit_exceeded" }, {}, true);
  await journal.append("runtime.error", { message: "Capture stopped", execution: "not_started" }, {}, true);
  await journal.append("trial.terminal", { execution: "not_started", reason: "Capture stopped" }, {}, true);
  assert.ok(journal.recordedBytes <= limits.maxRecordedBytes);
  assert.equal((await fs.readFile(path.join(fixture.root, "initial-state.json"))).length, remaining);
});

for (const extra of [0, 1]) test(`incoming frame bound includes LF: limit ${extra ? "plus one rejected" : "exactly accepted"}`, async t => {
  const fixture = await setup(t);
  await fs.writeFile(path.join(fixture.root, "frame.js"), `process.stdin.on("data", bytes => {
    const request = JSON.parse(bytes);
    const reply = { protocol: request.protocol, trialId: request.trialId, messageId: "reply", replyTo: request.messageId, kind: "described", payload: { adapterId: "test", adapterVersion: "1", capabilities: [], tools: [], faultModes: [] } };
    process.stdout.write(JSON.stringify(reply).padEnd(${511 + extra}, " ") + "\\n");
  });`);
  const worker = new Worker("environment", "frame", { ...fixture.plan.environment, argv: ["node", "frame.js"] }, fixture.root,
    { ...fixture.plan.limits, maxFrameBytes: 512 }, async () => {}, async () => {});
  t.after(async () => { await worker.terminate(10); await worker.drain(); });
  const response = before(worker.request("describe", { adapterId: "test", adapterVersion: "1" }), Date.now() + 3000);
  if (extra) await assert.rejects(response, CaptureLimitError);
  else assert.equal((await response).kind, "described");
});

test("an incoming burst cannot create an unbounded protocol callback queue", async t => {
  const fixture = await setup(t);
  await fs.writeFile(path.join(fixture.root, "burst.js"), `process.stdin.on("data", bytes => {
    const request = JSON.parse(bytes);
    process.stdout.write(Array.from({ length: 140 }, (_, i) => JSON.stringify({ protocol: request.protocol, trialId: request.trialId, messageId: "error-" + i, kind: "environment_error", payload: { message: "failure" } })).join("\\n") + "\\n");
  });`);
  const worker = new Worker("environment", "burst", { ...fixture.plan.environment, argv: ["node", "burst.js"] }, fixture.root, fixture.plan.limits,
    async () => { await sleep(100); }, async () => {});
  t.after(async () => { await worker.terminate(10); await worker.drain(); });
  await assert.rejects(before(worker.request("describe", { adapterId: "test", adapterVersion: "1" }), Date.now() + 3000), CaptureLimitError);
});

test("agent exit is observed while its routed tool is still waiting", { timeout: 20000 }, async t => {
  const fixture = await setup(t, plan => { plan.environment.faultPlan = [{ tool: "reserve", invocation: 1, mode: "hang" }]; });
  await fixture.patch("agent", code => code.replace('const result = await call("reserve",', 'setTimeout(() => process.exit(7), 50); const result = await call("reserve",'));
  const { manifest, events } = await fixture.run();
  assert.equal(manifest.execution, "adapter_error");
  assert.ok(events.some(event => event.kind === "runtime.error" && String(event.payload.message).includes("code=7")));
  assert.equal(manifest.operations.at(-1)!.outcome, "outcome_unknown");
});

test("a describe timeout still terminates the environment and publishes not-started evidence", { timeout: 20000 }, async t => {
  const fixture = await setup(t, plan => { plan.limits.prepareMs = 1000; });
  await fixture.patch("environment", code => code.replace('case "describe":', 'case "describe": return;'));
  const { manifest, events } = await fixture.run();
  assert.equal(manifest.execution, "not_started"); assert.equal(manifest.evidence.state, "incomplete");
  assert.equal(events.some(event => event.kind === "user.turn"), false);
});

test("a capture filesystem failure unconditionally terminates owned workers and preserves unfinished evidence", { timeout: 20000 }, async t => {
  const fixture = await setup(t);
  const workers = new Set<Worker>(); const request = Worker.prototype.request; const capture = Journal.prototype.capture;
  const trialRoots: string[] = [];
  Worker.prototype.request = function (...args) { workers.add(this); return request.apply(this, args); };
  Journal.prototype.capture = async function (name, bytes) {
    if (name === "final-state.json") {
      const store = path.join(fixture.root, "store"); const shown = await showRun(store, "capture");
      const trialRoot = path.join(shown.root, shown.index.trials[0]!.path); trialRoots.push(trialRoot);
      await fs.mkdir(path.join(trialRoot, name)); // Actual publication failure, not a mocked return.
    }
    return capture.call(this, name, bytes);
  };
  t.after(async () => {
    Worker.prototype.request = request; Journal.prototype.capture = capture;
    for (const worker of workers) await worker.terminate(10);
  });
  await assert.rejects(fixture.run(), AcceptedRunError);
  for (const worker of workers) await before(worker.closed, Date.now() + 1000);
  assert.equal(workers.size, 2); assert.equal(trialRoots.length, 1);
  const shown = await showRun(path.join(fixture.root, "store"), "capture");
  const inspection = await inspectRun(shown.root, shown.index, shown.acceptanceSha256);
  assert.equal(inspection.trials[0]!.state, "unfinished"); assert.equal(inspection.trials[0]!.terminalExecution, null);
});

test("escaped errors fit the serialized terminal reserve and mark truncation explicitly", { timeout: 20000 }, async t => {
  const fixture = await setup(t, plan => { plan.limits.maxRecordedBytes = 32768; });
  await fixture.patch("agent", code => code.replace('if (frame.kind === "user_turn") {', 'if (frame.kind === "user_turn") { peer.notify("agent_error", { message: "\\0".repeat(1024) }); return;'));
  const append = Journal.prototype.append;
  Journal.prototype.append = async function (kind, ...args) {
    const event = await append.call(this, kind, ...args);
    if (kind === "user.turn" && !this.attachments.has("final-state.json")) {
      // Fill the remaining regular-capture space with a valid diagnostic first.
      const overhead = 500;
      const count = fixture.plan.limits.maxRecordedBytes - this.recordedBytes - 4096 - overhead;
      if (count > 0) await append.call(this, "diagnostic", { channel: "agent", text: "x".repeat(count) });
    }
    return event;
  };
  t.after(() => { Journal.prototype.append = append; });
  const { manifest, events } = await fixture.run();
  assert.equal(manifest.execution, "agent_error");
  assert.ok(manifest.evidence.gaps.includes("error_message_truncated"));
  const message = events.find(event => event.kind === "agent.error")!.payload.message as string;
  assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 1024); assert.match(message, /\[truncated\]$/);
});

test("a delayed diagnostic I/O error remains fatal after an observed agent exit", { timeout: 20000 }, async t => {
  const fixture = await setup(t);
  await fixture.patch("agent", code => code.replace('if (frame.kind === "user_turn") {', 'if (frame.kind === "user_turn") { process.stderr.write("last diagnostic", () => process.exit(7)); return;'));
  const append = Journal.prototype.append;
  Journal.prototype.append = async function (kind, ...args) {
    if (kind === "diagnostic") {
      await sleep(100);
      await fs.writeFile(fixture.root, "cannot write over a directory");
    }
    return append.call(this, kind, ...args);
  };
  t.after(() => { Journal.prototype.append = append; });
  await assert.rejects(fixture.run(), AcceptedRunError);
  const shown = await showRun(path.join(fixture.root, "store"), "capture");
  const inspection = await inspectRun(shown.root, shown.index, shown.acceptanceSha256);
  assert.equal(inspection.trials[0]!.state, "unfinished"); assert.equal(inspection.trials[0]!.bundle.verified, false);
});
