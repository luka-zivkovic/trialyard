import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkConnection, connectRepository } from "../src/connection/recipe.js";
import { rebuildConnection } from "../src/connection/rebuild.js";
import { REBUILD_PARENT, REBUILD_RECORD, rebuildResultContract } from "../src/connection/rebuild-contract.js";
import type { ConnectionRecipe } from "../src/connection/contracts.js";
import type { Setup } from "../src/discovery/types.js";
import type { RunResult } from "../src/core/run.js";
import { verifyBundle } from "../src/contracts/verify.js";
import { jsonBytes } from "../src/core/files.js";
import { record } from "../src/discovery/safe.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "trial-rebuild-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), parent = path.join(root, "parent"), out = path.join(root, "rebuilt");
  await fs.cp(fileURLToPath(new URL("../../examples/node-agent/", import.meta.url)), source, { recursive: true });
  const connection = await connectRepository(source, parent), filename = connection.recipe;
  const parentBytes = await fs.readFile(filename);
  const invoke = (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd: root, maxBuffer: 1024 * 1024 });
  const edit = async () => fs.writeFile(path.join(source, "agent.js"), (await fs.readFile(path.join(source, "agent.js"), "utf8")).replace("quantity: 1", "quantity: 2"));
  const configure = async (mutate: (setup: Setup) => void) => {
    const file = path.join(source, "trial-runner.setup.json");
    const setup = JSON.parse(await fs.readFile(file, "utf8")); mutate(setup); await fs.writeFile(file, jsonBytes(setup));
  };
  const rebuild = () => rebuildConnection(filename, source, out, connection.recipeSha256);
  const unchanged = async () => assert.deepEqual(await fs.readFile(filename), parentBytes);
  return { root, source, parent, out, filename, parentBytes, connection, invoke, edit, configure, rebuild, unchanged };
}

test("CLI rebuild freezes the source edit, preserves trial inputs, and runs under a new request", async t => {
  const f = await fixture(t), oldPlan = path.join(f.parent, f.connection.plan!.path);
  const baseline = JSON.parse((await f.invoke("run", oldPlan, "--request", "baseline")).stdout) as RunResult;
  assert.equal(baseline.index.exitCode, 0);
  await f.edit(); const edited = await fs.readFile(path.join(f.source, "agent.js"));
  const rebuilt = rebuildResultContract(JSON.parse((await f.invoke("rebuild", f.filename, "--source", f.source, "--out", f.out, "--sha256", f.connection.recipeSha256)).stdout));
  assert.equal(rebuilt.record.execution, "not_run");
  assert.equal(rebuilt.record.parentRecipeSha256, f.connection.recipeSha256);
  assert.notEqual(rebuilt.plan.inputSha256, f.connection.plan!.inputSha256);
  assert.notEqual(rebuilt.record.agentArtifact.before, rebuilt.record.agentArtifact.after);
  assert.deepEqual(rebuilt.record.changes.sources.map(f => f.path), ["agent.js"]);
  for (const file of rebuilt.record.preservedFiles) assert.deepEqual(await fs.readFile(path.join(f.parent, file.path)), await fs.readFile(path.join(f.out, file.path)));
  await f.unchanged(); assert.deepEqual(await fs.readFile(path.join(f.source, "agent.js")), edited);
  assert.deepEqual(await fs.readFile(path.join(f.out, "prepared/candidate/agent.js")), edited);
  assert.deepEqual(await fs.readFile(path.join(f.out, REBUILD_PARENT)), f.parentBytes);
  await assert.rejects(fs.stat(path.join(f.out, "staging")), { code: "ENOENT" });
  await fs.rm(f.source, { recursive: true });
  const moved = path.join(f.root, "moved"); await fs.rename(f.out, moved);
  assert.equal((await checkConnection(path.join(moved, "connection.json"), rebuilt.recipeSha256)).status, "validated");
  const nextPlan = path.join(moved, rebuilt.plan.path);
  await assert.rejects(f.invoke("run", nextPlan, "--request", "baseline"), (e: any) => e.code === 1 && /conflicts/.test(e.stderr));
  const next = JSON.parse((await f.invoke("run", nextPlan, "--request", "candidate-2")).stdout) as RunResult;
  assert.equal(next.index.exitCode, 0); assert.equal(next.index.trials.length, 2);
  const oldAgain = JSON.parse((await f.invoke("run", oldPlan, "--request", "baseline")).stdout) as RunResult;
  assert.equal(oldAgain.duplicate, true); assert.deepEqual(oldAgain.index, baseline.index);
  for (const [run, remaining] of [[baseline, 2], [next, 1]] as const) for (const trial of run.index.trials) {
    const bundle = path.join(run.root, trial.path); await verifyBundle(bundle, trial.bundleSha256!);
    const initial = JSON.parse(await fs.readFile(path.join(bundle, "initial-state.json"), "utf8"));
    const final = JSON.parse(await fs.readFile(path.join(bundle, "final-state.json"), "utf8"));
    assert.equal(initial.state.available, 3); assert.equal(final.state.available, remaining);
    assert.equal(final.state.reservations.length, 1);
  }
});

test("unchanged sources preserve candidate identities and repeated rebuilds retain bounded parent metadata", async t => {
  const f = await fixture(t), first = await f.rebuild();
  assert.equal(first.plan.inputSha256, f.connection.plan!.inputSha256);
  assert.deepEqual(first.record.changes, { sources: [], files: [] });
  assert.equal(first.record.agentArtifact.before, first.record.agentArtifact.after);
  await f.edit();
  const next = await rebuildConnection(first.recipe, f.source, path.join(f.root, "next"), first.recipeSha256);
  assert.equal(next.record.parentRecipeSha256, first.recipeSha256);
  assert.notEqual(next.plan.inputSha256, first.plan.inputSha256);
  const recipe = JSON.parse(await fs.readFile(next.recipe, "utf8")) as ConnectionRecipe;
  assert.equal(recipe.files.filter(f => f.path.startsWith("rebuild/")).length, 2);
  await fs.rm(f.parent, { recursive: true }); await fs.rm(f.out, { recursive: true });
  assert.equal((await checkConnection(next.recipe)).status, "validated");
});

test("declared runtime modules can be added and removed without retaining stale copies", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "helper.js"), "export const quantity = 2;\n");
  await f.configure(s => { s.agent.files.push("helper.js"); });
  await fs.writeFile(path.join(f.source, "agent.js"), "import { quantity } from './helper.js';\n" + (await fs.readFile(path.join(f.source, "agent.js"), "utf8")).replace("quantity: 1", "quantity"));
  const first = await f.rebuild();
  assert.equal(first.record.changes.sources.find(f => f.path === "helper.js")!.before, null);
  await fs.writeFile(path.join(f.source, "agent.js"), "export const createAgent = () => ({ runTurn: async () => 'done' });\n");
  await fs.rm(path.join(f.source, "helper.js")); await f.configure(s => { s.agent.files = ["agent.js"]; });
  const second = await rebuildConnection(first.recipe, f.source, path.join(f.root, "next"));
  assert.equal(second.record.changes.sources.find(f => f.path === "helper.js")!.after, null);
  await assert.rejects(fs.stat(path.join(f.root, "next/prepared/candidate/helper.js")), { code: "ENOENT" });
  assert.equal((await checkConnection(second.recipe)).status, "validated");
});

for (const [label, change] of Object.entries({
  scenario: (s: Setup) => { s.scenario.messages[0]!.content = "A different trial"; },
  repetitions: (s: Setup) => { s.repetitions = 3; },
  capture: (s: Setup) => { s.agent.modelCapture = "reported"; },
  credentials: (s: Setup) => { s.agent.secretBindings.push("EXAMPLE_API_KEY"); },
  entrypoint: (s: Setup) => { s.agent.entrypoint = "other.js"; s.agent.files.push("other.js"); },
})) test(`rebuild rejects ${label} drift and removes its incomplete output`, async t => {
  const f = await fixture(t); await fs.copyFile(path.join(f.source, "agent.js"), path.join(f.source, "other.js"));
  await f.configure(change);
  await assert.rejects(f.rebuild(), /REBUILD_CONFIGURATION_CHANGED/);
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" }); await f.unchanged();
});

test("unsupported source environment and an unsupported parent cannot become runnable rebuilds", async t => {
  const f = await fixture(t);
  await f.configure(s => { (s.environment as any).template = "custom-environment/v1"; });
  await assert.rejects(f.rebuild(), /REBUILD_SOURCE_UNSUPPORTED/);
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" });
  const blocked = await connectRepository(f.source, path.join(f.root, "blocked"));
  await assert.rejects(rebuildConnection(blocked.recipe, f.source, f.out), /UNSUPPORTED_REBUILD_CONNECTION/);
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" }); await f.unchanged();
});

test("rebuild rejects an incorrect parent digest and tampered parent dependencies", async t => {
  const f = await fixture(t);
  await assert.rejects(rebuildConnection(f.filename, f.source, f.out, "0".repeat(64)), /CONNECTION_DIGEST_MISMATCH/);
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" });
  await fs.appendFile(path.join(f.parent, "prepared/profile.json"), "\n");
  await assert.rejects(f.rebuild(), /CONNECTION_FILE_CHANGED/);
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" }); await f.unchanged();
});

test("rebuild refuses existing and overlapping destinations, including canonical aliases", async t => {
  const f = await fixture(t); await fs.mkdir(f.out); const marker = path.join(f.out, "keep"); await fs.writeFile(marker, "keep");
  for (const [destination, code] of [[f.out, "DESTINATION_EXISTS"], [path.join(f.source, "child"), "DESTINATION_OVERLAP"], [path.join(f.parent, "child"), "DESTINATION_OVERLAP"], [f.parent, "DESTINATION_EXISTS"]]) {
    await assert.rejects(rebuildConnection(f.filename, f.source, destination!), new RegExp(code!));
  }
  await fs.symlink(f.parent, path.join(f.root, "alias"));
  await assert.rejects(rebuildConnection(f.filename, f.source, path.join(f.root, "alias/child")), /DESTINATION_OVERLAP/);
  assert.equal(await fs.readFile(marker, "utf8"), "keep"); await f.unchanged();
});

for (const kind of ["symlink", "hardlink", "fifo", "missing"] as const) test(`rebuild rejects ${kind} selected source without publishing output`, async t => {
  const f = await fixture(t), agent = path.join(f.source, "agent.js"), outside = path.join(f.root, "outside.js");
  await fs.rename(agent, outside);
  if (kind === "symlink") await fs.symlink(outside, agent);
  else if (kind === "hardlink") await fs.link(outside, agent);
  else if (kind === "fifo") await exec("mkfifo", [agent]);
  await assert.rejects(f.rebuild(), kind === "missing" ? /SOURCE_FILE_MISSING/ : /UNSAFE_SOURCE_FILE/);
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" }); await f.unchanged();
});

test("rebuild never imports candidate code or invokes package scripts", async t => {
  const f = await fixture(t), marker = path.join(f.root, "must-not-exist");
  await fs.writeFile(path.join(f.source, "agent.js"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  await fs.writeFile(path.join(f.source, "package.json"), jsonBytes({ type: "module", scripts: { build: "node agent.js", postinstall: "node agent.js" } }));
  const result = await f.rebuild(); assert.equal(result.record.execution, "not_run");
  await checkConnection(result.recipe); await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

for (const kind of ["false-record", "missing-parent"] as const) test(`check-connection rejects ${kind} even after repinning the recipe`, async t => {
  const f = await fixture(t); await f.edit(); const rebuilt = await f.rebuild();
  const recipe = JSON.parse(await fs.readFile(rebuilt.recipe, "utf8")) as ConnectionRecipe;
  if (kind === "false-record") {
    const bytes = jsonBytes({ ...rebuilt.record, changes: { sources: [], files: [] } });
    await fs.writeFile(path.join(f.out, REBUILD_RECORD), bytes);
    recipe.files = recipe.files.map(file => file.path === REBUILD_RECORD ? record(REBUILD_RECORD, bytes) : file);
  } else recipe.files = recipe.files.filter(file => file.path !== REBUILD_PARENT);
  await fs.writeFile(rebuilt.recipe, jsonBytes(recipe));
  await assert.rejects(checkConnection(rebuilt.recipe), /REBUILD_LINEAGE_MISMATCH|MISSING_REBUILD_LINEAGE/);
});

test("CLI rejects missing or repeated rebuild flags before writing output", async t => {
  const f = await fixture(t);
  for (const args of [["--out", f.out], ["--source", f.source], ["--source", f.source, "--out", f.out, "--out", f.out]]) {
    await assert.rejects(f.invoke("rebuild", f.filename, ...args), (e: any) => e.code === 1);
  }
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" }); await f.unchanged();
});

test("rebuild preserves explicit limits and rejects later changes to them", async t => {
  const f = await fixture(t);
  const plan = JSON.parse(await fs.readFile(path.join(f.parent, "prepared/plan.json"), "utf8"));
  await f.configure(s => { s.limits = plan.limits; s.limits!.trialMs += 1000; });
  // An intentional new configuration starts a new connection, which can then be rebuilt.
  const parent = await connectRepository(f.source, path.join(f.root, "configured"));
  await f.edit();
  const rebuilt = await rebuildConnection(parent.recipe, f.source, f.out);
  const nextPlan = JSON.parse(await fs.readFile(path.join(f.out, rebuilt.plan.path), "utf8"));
  assert.deepEqual(nextPlan.limits, plan.limits);
  await f.configure(s => { s.limits!.trialMs += 1000; });
  await assert.rejects(rebuildConnection(rebuilt.recipe, f.source, path.join(f.root, "next")), /REBUILD_CONFIGURATION_CHANGED/);
  await assert.rejects(fs.stat(path.join(f.root, "next")), { code: "ENOENT" });
});

test("manual integration recipes cannot enter the Node-function rebuild path", async t => {
  const f = await fixture(t), recipe = JSON.parse(f.parentBytes.toString()) as ConnectionRecipe;
  recipe.method = "manual-integration/v1"; recipe.plan = null;
  recipe.requirements = [{ code: "BUILD_REQUIRED", message: "Build the application with its integration procedure." }];
  await fs.writeFile(f.filename, jsonBytes(recipe));
  await assert.rejects(rebuildConnection(f.filename, f.source, f.out), /UNSUPPORTED_REBUILD_CONNECTION/);
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" });
});

test("excluded source paths cannot overwrite the retained wrapper", async t => {
  const f = await fixture(t); await f.configure(s => { s.agent.files.push("trial-adapter.js"); });
  await fs.writeFile(path.join(f.source, "trial-adapter.js"), "throw new Error('not the wrapper');");
  await assert.rejects(f.rebuild(), /REBUILD_SOURCE_UNSUPPORTED/);
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" }); await f.unchanged();
});
