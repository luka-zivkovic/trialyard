import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkConnection, connectRepository } from "../src/connection/recipe.js";
import { loadSetupSkill, setupSkillContext } from "../src/connection/skill.js";
import type { ConnectionRecipe } from "../src/connection/contracts.js";
import { hash, jsonBytes } from "../src/core/files.js";
import { resolvePlan } from "../src/core/plan.js";
import type { RunResult } from "../src/core/run.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "trial-connection-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "source");
  await fs.cp(fileURLToPath(new URL("../../examples/node-agent/", import.meta.url)), repo, { recursive: true });
  const out = path.join(root, "connection");
  const filename = path.join(out, "connection.json");
  const invoke = (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd: root, maxBuffer: 1024 * 1024 });
  const read = async () => JSON.parse(await fs.readFile(filename, "utf8")) as ConnectionRecipe;
  const save = async (recipe: ConnectionRecipe) => fs.writeFile(filename, jsonBytes(recipe));
  const repin = async (recipe: ConnectionRecipe, name: string) => {
    const bytes = await fs.readFile(path.join(out, name));
    const item = recipe.files.find(f => f.path === name)!; item.bytes = bytes.length; item.sha256 = hash(bytes);
  };
  return { root, repo, out, filename, invoke, read, save, repin };
}

test("skill context loads one version and only the selected reference without invoking assistance", async () => {
  const basic = await setupSkillContext();
  const selected = await setupSkillContext("manual-adapter");
  assert.equal(basic.identity.sha256, selected.identity.sha256);
  assert.equal(basic.references.length, 0); assert.equal(selected.references.length, 1);
  assert.equal(selected.references[0]!.id, "manual-adapter");
  assert.equal(basic.assistant, "not_invoked"); assert.equal(basic.execution, "not_run");
  await assert.rejects(setupSkillContext("made-up"), /UNKNOWN_SKILL_REFERENCE/);
});

test("CLI connection freezes source and skill, survives a move, and repeats without the assistant", async t => {
  const f = await fixture(t);
  const source = await fs.readFile(path.join(f.repo, "agent.js"));
  const result = JSON.parse((await f.invoke("connect", f.repo, "--out", f.out)).stdout);
  assert.equal(result.status, "validated"); assert.equal(result.execution, "not_run");
  assert.equal(result.recipeSha256, hash(await fs.readFile(f.filename)));
  assert.deepEqual(await fs.readFile(path.join(f.out, "prepared/candidate/agent.js")), source);
  await fs.rm(f.repo, { recursive: true });
  const moved = path.join(f.root, "moved"); await fs.rename(f.out, moved);
  const checked = JSON.parse((await f.invoke("check-connection", path.join(moved, "connection.json"))).stdout);
  assert.equal(checked.status, "validated"); assert.equal(checked.sourceVerification, "recorded_not_rechecked");
  const plan = path.join(moved, checked.plan.path);
  const first = JSON.parse((await f.invoke("run", plan, "--request", "first")).stdout) as RunResult;
  assert.equal(first.index.exitCode, 0); assert.equal(first.index.trials.length, 2);
  const duplicate = JSON.parse((await f.invoke("run", plan, "--request", "first")).stdout) as RunResult;
  assert.equal(duplicate.duplicate, true);
  const repeat = JSON.parse((await f.invoke("run", plan, "--request", "second", "--rerun-of", "first")).stdout) as RunResult;
  assert.equal(repeat.index.exitCode, 0); assert.notEqual(repeat.index.runId, first.index.runId);
  for (const run of [first, repeat]) for (const trial of run.index.trials) {
    await f.invoke("verify", path.join(run.root, trial.path), "--sha256", trial.bundleSha256!);
  }
});

test("connection preparation and validation never import candidate source or run package commands", async t => {
  const f = await fixture(t); const marker = path.join(f.root, "must-not-exist");
  const trigger = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`;
  await fs.writeFile(path.join(f.repo, "agent.js"), trigger);
  await fs.writeFile(path.join(f.repo, "package.json"), jsonBytes({ type: "module", scripts: { postinstall: `node agent.js` } }));
  assert.equal((await connectRepository(f.repo, f.out)).status, "validated");
  assert.equal((await checkConnection(f.filename)).status, "validated");
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("unsupported environment retains requirements, no plan and no secret file contents", async t => {
  const f = await fixture(t);
  const declaration = JSON.parse(await fs.readFile(path.join(f.repo, "trial-runner.setup.json"), "utf8"));
  declaration.environment.template = "customer-crm/v1";
  await fs.writeFile(path.join(f.repo, "trial-runner.setup.json"), jsonBytes(declaration));
  await fs.writeFile(path.join(f.repo, ".env"), "TEST_SECRET=sentinel-not-for-output");
  const result = await connectRepository(f.repo, f.out);
  assert.equal(result.status, "blocked"); assert.equal(result.plan, null);
  assert.ok(result.requirements.some(r => r.code === "UNSUPPORTED_ENVIRONMENT_TEMPLATE"));
  assert.equal((await checkConnection(f.filename)).status, "blocked");
  assert.equal(JSON.stringify(await f.read()).includes("sentinel-not-for-output"), false);
  await assert.rejects(fs.stat(path.join(f.out, "prepared/plan.json")), { code: "ENOENT" });
  await assert.rejects(f.invoke("check-connection", f.filename), (e: any) => e.code === 2);
});

test("source changes require a new connection; existing directories and overlapping destinations survive", async t => {
  const f = await fixture(t); await connectRepository(f.repo, f.out);
  const before = await fs.readFile(f.filename);
  await assert.rejects(connectRepository(f.repo, f.out), /DESTINATION_EXISTS/);
  await assert.rejects(connectRepository(f.repo, path.join(f.repo, "nested")), /DESTINATION_OVERLAP/);
  assert.deepEqual(await fs.readFile(f.filename), before);
  await fs.appendFile(path.join(f.repo, "agent.js"), "\n// candidate revision\n");
  assert.equal((await checkConnection(f.filename)).status, "validated");
  const next = await connectRepository(f.repo, path.join(f.root, "next"));
  assert.notEqual(next.recipeSha256, hash(before));
  assert.notEqual(next.plan!.inputSha256, (await f.read()).plan!.inputSha256);
});

test("changed prepared files and substituted plan identities are rejected", async t => {
  const f = await fixture(t); await connectRepository(f.repo, f.out);
  const planPath = path.join(f.out, "prepared/plan.json");
  const plan = JSON.parse(await fs.readFile(planPath, "utf8")); plan.repetitions = 1;
  await fs.writeFile(planPath, jsonBytes(plan));
  await assert.rejects(checkConnection(f.filename), /CONNECTION_FILE_CHANGED/);
  const recipe = await f.read(); await f.repin(recipe, "prepared/plan.json"); await f.save(recipe);
  await assert.rejects(checkConnection(f.filename), /CONNECTION_PLAN_CHANGED/);
});

test("a repinned skill file still must match the retained skill package identity", async t => {
  const f = await fixture(t); await connectRepository(f.repo, f.out);
  await fs.appendFile(path.join(f.out, "skill/references/manual-adapter.md"), "\nchanged instructions\n");
  const recipe = await f.read(); await f.repin(recipe, "skill/references/manual-adapter.md"); await f.save(recipe);
  await assert.rejects(checkConnection(f.filename), /CONNECTION_SKILL_CHANGED/);
});

test("unlisted plan references are rejected before opening their contents", async t => {
  const f = await fixture(t); await connectRepository(f.repo, f.out);
  const recipe = await f.read(); recipe.files = recipe.files.filter(i => i.path !== "prepared/profile.json"); await f.save(recipe);
  await assert.rejects(checkConnection(f.filename), /CONNECTION_CHECK_FAILED/);
  const allowed = new Set(recipe.files.filter(i => i.path.startsWith("prepared/")).map(i => i.path.slice(9)));
  await assert.rejects(resolvePlan(path.join(f.out, "prepared/plan.json"), allowed), /outside the connection inventory/);
});

for (const kind of ["symlink", "hardlink"] as const) test(`connection checks reject ${kind} files`, async t => {
  const f = await fixture(t); await connectRepository(f.repo, f.out);
  const file = path.join(f.out, "prepared/profile.json"); const outside = path.join(f.root, "outside.json");
  await fs.rename(file, outside);
  if (kind === "symlink") await fs.symlink(outside, file); else await fs.link(outside, file);
  await assert.rejects(checkConnection(f.filename), /UNSAFE_SOURCE_FILE/);
});

test("unsafe preparation leaves no half-published connection", async t => {
  const f = await fixture(t);
  await fs.rename(path.join(f.repo, "agent.js"), path.join(f.root, "outside.js"));
  await fs.symlink(path.join(f.root, "outside.js"), path.join(f.repo, "agent.js"));
  await assert.rejects(connectRepository(f.repo, f.out), /UNSAFE_SOURCE_FILE/);
  await assert.rejects(fs.stat(f.out), { code: "ENOENT" });
});

test("skill loader rejects ambiguous and unsafe references before reading them", async t => {
  const f = await fixture(t); const skill = await loadSetupSkill();
  const directory = path.join(f.root, "skill"); await fs.mkdir(directory);
  for (const [name, bytes] of skill.files) { await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await fs.writeFile(path.join(directory, name), bytes); }
  const manifest = structuredClone(skill.manifest);
  manifest.references.push({ id: "outside", path: "../outside.md", when: "never" });
  await fs.writeFile(path.join(directory, "package.json"), jsonBytes(manifest));
  await assert.rejects(loadSetupSkill(directory), /UNSAFE_CONNECTION_PATH/);
  manifest.references.pop(); manifest.references[1]!.id = manifest.references[0]!.id;
  await fs.writeFile(path.join(directory, "package.json"), jsonBytes(manifest));
  await assert.rejects(loadSetupSkill(directory), /DUPLICATE_CONNECTION_IDENTITY/);
});

test("recipe entry files obey the same public path policy before reading content", async t => {
  const f = await fixture(t); await connectRepository(f.repo, f.out);
  for (const name of [".env", "credentials.json", "secret.json"]) {
    await fs.copyFile(f.filename, path.join(f.out, name));
    await assert.rejects(checkConnection(path.join(f.out, name)), /UNSAFE_CONNECTION_PATH/);
  }
});

test("an externally retained recipe digest rejects any later recipe edit", async t => {
  const f = await fixture(t); const prepared = await connectRepository(f.repo, f.out);
  assert.equal((await checkConnection(f.filename, prepared.recipeSha256)).status, "validated");
  await fs.appendFile(f.filename, "\n");
  await assert.rejects(checkConnection(f.filename, prepared.recipeSha256), /CONNECTION_DIGEST_MISMATCH/);
  await assert.rejects(checkConnection(f.filename, "not-a-digest"), /INVALID_CONNECTION_DIGEST/);
});
