import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inspectRepository } from "../src/discovery/inspect.js";
import { prepareRepository } from "../src/discovery/prepare.js";
import { contract } from "../src/contracts/validate.js";
import { hash, jsonBytes } from "../src/core/files.js";
import { resolvePlan } from "../src/core/plan.js";
import { runPlan } from "../src/core/run.js";
import { verifyBundle } from "../src/contracts/verify.js";
import type { Setup } from "../src/discovery/types.js";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "trial-m2-setup-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.cp(fileURLToPath(new URL("../../examples/node-agent/", import.meta.url)), repo, { recursive: true });
  const setup = JSON.parse(await fs.readFile(path.join(repo, "trial-runner.setup.json"), "utf8")) as Setup;
  const save = () => fs.writeFile(path.join(repo, "trial-runner.setup.json"), jsonBytes(setup));
  return { root, repo, setup, save, out: path.join(root, "out") };
}

test("M2 prepared output pins every copied byte, source and template; source changes do not mutate prepared input", async t => {
  const f = await fixture(t);
  const inspected = await inspectRepository(f.repo);
  const result = await prepareRepository(f.repo, f.out, inspected);
  for (const item of result.sources) assert.deepEqual({ bytes: (await fs.readFile(path.join(f.repo, item.path))).length, sha256: hash(await fs.readFile(path.join(f.repo, item.path))) }, { bytes: item.bytes, sha256: item.sha256 });
  for (const item of result.outputs) assert.equal(hash(await fs.readFile(path.join(f.out, item.path))), item.sha256);
  assert.equal(result.discoverySha256, hash(jsonBytes(inspected)));
  assert.equal(result.plan?.inputSha256, (await resolvePlan(path.join(f.out, "plan.json"))).inputSha256);
  await fs.writeFile(path.join(f.repo, "agent.js"), "changed only in original source");
  assert.equal(result.plan?.inputSha256, (await resolvePlan(path.join(f.out, "plan.json"))).inputSha256);
  await fs.appendFile(path.join(f.out, "candidate", "agent.js"), "\n// changed prepared code\n");
  await assert.rejects(resolvePlan(path.join(f.out, "plan.json")), /digest mismatch/);
});

for (const [label, content] of [
  ["duplicate key", '{"type":"module","type":"commonjs"}'],
  ["invalid UTF8", Buffer.from([123, 34, 255, 34, 58, 49, 125])],
  ["deep JSON", '{"a":' + '['.repeat(25) + '1' + ']'.repeat(25) + '}'],
  ["too many values", JSON.stringify({ type: "module", data: Array(10001).fill(1) })],
  ["oversized bytes", JSON.stringify({ type: "module", data: "a".repeat(262144) })],
] as const) test(`M2 discovery rejects ${label} with bounded diagnostics`, async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.repo, "package.json"), content);
  const report = await inspectRepository(f.repo);
  assert.equal(report.status, "blocked"); assert.ok(JSON.stringify(report).length < 10000);
});

for (const [label, modify, code] of [
  ["unsupported setup version", (v: Setup) => { (v as any).schemaVersion = "trial-runner/setup/v9"; }, "UNSUPPORTED_SETUP_VERSION"],
  ["unsupported agent template", (v: Setup) => { (v as any).template = "http/v1"; }, "UNSUPPORTED_AGENT_TEMPLATE"],
  ["unsupported environment", (v: Setup) => { (v.environment as any).template = "production-crm/v1"; }, "UNSUPPORTED_ENVIRONMENT_TEMPLATE"],
  ["entrypoint omitted", (v: Setup) => { v.agent.files = ["other.js"]; }, "ENTRYPOINT_NOT_DECLARED"],
  ["ambiguous case", (v: Setup) => { v.agent.files.push("Agent.js"); }, "AMBIGUOUS_SOURCE_PATHS"],
  ["fixture override", (v: Setup) => { v.scenario.fixture = ".env"; }, "UNSUPPORTED_SCENARIO_FIXTURE"],
  ["turn ID collision", (v: Setup) => { v.scenario.messages[1]!.id = v.scenario.messages[0]!.id; }, "INVALID_SCENARIO"],
  ["usage contradiction", (v: Setup) => { v.agent.requireUsage = true; }, "CONTRADICTORY_MODEL_CAPTURE"],
  ["runtime credential", (v: Setup) => { v.agent.secretBindings = ["NODE_OPTIONS"]; }, "UNSUPPORTED_SECRET_BINDING"],
] as const) test(`M2 discovery identifies ${label} before preparation`, async t => {
  const f = await fixture(t); modify(f.setup); await f.save();
  assert.ok((await inspectRepository(f.repo)).unresolved.some(u => u.code === code));
  const result = await prepareRepository(f.repo, f.out);
  assert.equal(result.status, "blocked"); assert.equal(result.plan, null);
  await assert.rejects(fs.stat(path.join(f.out, "plan.json")), { code: "ENOENT" });
});

test("M2 source and template declarations cannot be forged through the optional report", async t => {
  const f = await fixture(t);
  for (const change of [(v: any) => { v.template.sha256 = "a".repeat(64); }, (v: any) => { v.execution = "validated"; }, (v: any) => { v.status = "ready"; }, (v: any) => { v.extra = true; }]) {
    const report = await inspectRepository(f.repo); change(report);
    await assert.rejects(prepareRepository(f.repo, f.out, report), /INSPECTION_REPORT/);
    await assert.rejects(fs.stat(f.out), { code: "ENOENT" });
  }
});

test("M2 full source inventory size is checked before payload and leaves no output", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, "large.json"), Buffer.alloc(2 * 1024 * 1024 + 1));
  f.setup.agent.files.push("large.json"); await f.save();
  await assert.rejects(prepareRepository(f.repo, f.out), /UNSAFE_SOURCE_FILE/);
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" });
});

for (const [label, code, expected] of [
  ["missing export", "export const example = 1;", "adapter_error"],
  ["missing import", "import './undeclared.js'; export function createAgent() {}", "adapter_error"],
  ["factory fails", "export function createAgent() { throw new Error('broken factory'); }", "adapter_error"],
  ["candidate fails", "export function createAgent() { return { runTurn() { throw new Error('broken candidate'); } }; }", "agent_error"],
  ["unawaited tool", "export function createAgent() { return { runTurn({tool}) { void tool('reserve', {key:'unawaited',quantity:1}); return 'premature'; } }; }", "adapter_error"],
  ["invalid output", "export function createAgent() { return { runTurn() { return {}; } }; }", "adapter_error"],
] as const) test(`M2 ${label} is first detected by explicit run with truthful outcome`, async t => {
  const f = await fixture(t); f.setup.repetitions = 1; await f.save(); await fs.writeFile(path.join(f.repo, "agent.js"), code);
  assert.equal((await inspectRepository(f.repo)).status, "declared");
  assert.equal((await prepareRepository(f.repo, f.out)).status, "prepared");
  const run = await runPlan(path.join(f.out, "plan.json"), { requestId: "failure", store: path.join(f.root, "store") });
  assert.equal(run.index.trials[0]!.execution, expected);
  const verified = await verifyBundle(path.join(run.root, run.index.trials[0]!.path));
  assert.equal(verified.manifest.execution, expected);
});

test("M2 report and preparation schemas reject unknown versions and fields", async t => {
  const f = await fixture(t); const report = await inspectRepository(f.repo); const prepared = await prepareRepository(f.repo, f.out);
  for (const [schema, value] of [["discovery", report], ["preparation", prepared]] as const) {
    assert.equal(contract(schema, value), value);
    assert.throws(() => contract(schema, { ...value, schemaVersion: "future" }));
    assert.throws(() => contract(schema, { ...value, unknown: true }));
  }
});
