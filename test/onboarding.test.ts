import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inspectRepository } from "../src/discovery/inspect.js";
import { connectRepository, checkConnection } from "../src/connection/recipe.js";
import { connectionContract } from "../src/connection/contracts.js";
import { loadSetupSkill, setupSkillContext } from "../src/connection/skill.js";
import { rebuildConnection } from "../src/connection/rebuild.js";
import { hash, jsonBytes } from "../src/core/files.js";

const cli = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "trial-onboarding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), output = path.join(root, "connection");
  await fs.cp(fileURLToPath(new URL("../../examples/node-agent", import.meta.url)), source, { recursive: true });
  const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 30000 });
  return { root, source, output, invoke };
}

for (const command of ["connect", "run", "show", "inspect", "rebuild"]) test(`${command} supports local help without side effects`, () => {
  const result = spawnSync(process.execPath, [cli, command, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0); assert.match(result.stdout, new RegExp(`trial ${command}`));
});

test("setup diagnostics distinguish safe schema paths without echoing unrecognized values", async t => {
  const f = await fixture(t), filename = path.join(f.source, "trial-runner.setup.json");
  const original = JSON.parse(await fs.readFile(filename, "utf8"));
  for (const [value, expected] of [[{ ...original, repetitions: 0 }, /\/repetitions.*minimum/], [{ ...original, scenario: {} }, /\/scenario\/schemaVersion.*required/]] as const) {
    await fs.writeFile(filename, JSON.stringify(value));
    assert.match((await inspectRepository(f.source)).unresolved[0]!.message, expected);
  }
  await fs.writeFile(filename, JSON.stringify({ ...original, "SECRET_SENTINEL\u001b[2J": "private-sentinel" }));
  const result = JSON.stringify(await inspectRepository(f.source));
  assert.doesNotMatch(result, /SECRET_SENTINEL|private-sentinel/);
});

test("missing and changed declared files identify the public path and retain their category", async t => {
  const f = await fixture(t), file = path.join(f.source, "agent.js"), bytes = await fs.readFile(file);
  await fs.unlink(file);
  const missing = f.invoke("connect", f.source, "--out", f.output);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /SOURCE_FILE_MISSING/); assert.match(missing.stderr, /agent\.js/);
  await fs.writeFile(file, bytes); await connectRepository(f.source, f.output);
  await fs.appendFile(path.join(f.output, "prepared/candidate/agent.js"), "\n");
  const drift = f.invoke("check-connection", path.join(f.output, "connection.json"));
  assert.equal(drift.status, 1); assert.match(drift.stderr, /CONNECTION_FILE_CHANGED/); assert.match(drift.stderr, /prepared\/candidate\/agent\.js/);
});

test("connection hints keep JSON parseable and provide an explicit executable, plan and store", async t => {
  const f = await fixture(t), result = f.invoke("connect", f.source, "--out", f.output);
  assert.equal(JSON.parse(result.stdout).status, "validated");
  assert(result.stderr.includes(process.execPath)); assert(result.stderr.includes(path.join(f.output, "prepared/plan.json")));
  assert.match(result.stderr, /--store/); assert.match(result.stderr, /--format.*text/);
  const prepared = JSON.parse(await fs.readFile(path.join(f.output, "prepared/preparation.json"), "utf8"));
  assert(prepared.nextSteps.some((argv: string[]) => argv.includes("--format") && argv.includes("text")));
  await checkConnection(path.join(f.output, "connection.json"));
});

test("startup failures display captured diagnostics and direct repair to the adapter", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.source, "agent.js"), "export const other = 1;\n");
  await connectRepository(f.source, f.output);
  const store = path.join(f.root, "store"), result = f.invoke("run", path.join(f.output, "prepared/plan.json"), "--request", "bad-export", "--store", store);
  assert.equal(result.status, 2); const run = JSON.parse(result.stdout);
  const shown = f.invoke("show", "--request", "bad-export", "--store", store, "--format", "text");
  assert.equal(shown.status, 0); assert.match(shown.stdout, /requires createAgent/);
  assert.match(shown.stdout, /Diagnostic.*agent.*before first user turn/);
  assert.match(shown.stdout, /Next:.*adapter.*entrypoint/);
  assert.match(shown.stdout, /Execution: adapter_error; evidence: incomplete; cleanup: succeeded/);
  assert(result.stderr.includes(store)); assert(result.stderr.includes("bad-export"));
  // A missing index for an accepted request must stay distinguishable from an unknown request.
  await fs.unlink(path.join(run.root, "run.json"));
  const damaged = f.invoke("show", "--request", "bad-export", "--store", store);
  assert.match(damaged.stderr, /Accepted request is unreadable/); assert.doesNotMatch(damaged.stderr, /REQUEST_NOT_FOUND/);
});

test("missing requests identify the selected store and malformed options identify the command", async t => {
  const f = await fixture(t), store = path.join(f.root, "unused-store");
  const missing = f.invoke("show", "--request", "missing", "--store", store);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /REQUEST_NOT_FOUND/); assert(missing.stderr.includes(store)); assert.match(missing.stderr, /--store/);
  const option = f.invoke("connect", f.source, "--out");
  assert.match(option.stderr, /Missing value for --out/); assert.match(option.stderr, /connect --help/);
});

test("skill version update retains validation of earlier snapshots and exposes rebuild effects", async () => {
  const context = await setupSkillContext(); assert.equal(context.identity.version, "0.4.0");
  assert(context.tools.some(tool => tool.command === "rebuild" && tool.effect === "write_new_connection"));
  for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.3.1", "0.3.2", "0.4.0"]) connectionContract("skillManifest", { ...(await loadSetupSkill()).manifest, version });
  assert.throws(() => connectionContract("skillManifest", { schemaVersion: "trial-runner/skill-package/v1", id: "connect-agent", version: "9.0.0" }));
});

test("source rebuild preserves an older retained skill after the installed skill changes", async t => {
  const f = await fixture(t); await connectRepository(f.source, f.output);
  const manifestFile = path.join(f.output, "skill/package.json"), manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.version = "0.1.0"; await fs.writeFile(manifestFile, jsonBytes(manifest));
  await fs.writeFile(path.join(f.output, "skill/SKILL.md"), "# Retained earlier setup instructions\n");
  const old = await loadSetupSkill(path.join(f.output, "skill"));
  const recipeFile = path.join(f.output, "connection.json"), recipe = JSON.parse(await fs.readFile(recipeFile, "utf8"));
  recipe.skill = old.identity;
  for (const file of recipe.files) if (file.path.startsWith("skill/")) {
    const bytes = await fs.readFile(path.join(f.output, file.path)); file.bytes = bytes.length; file.sha256 = hash(bytes);
  }
  await fs.writeFile(recipeFile, jsonBytes(recipe)); await checkConnection(recipeFile);
  await fs.appendFile(path.join(f.source, "agent.js"), "\n// intentional source edit\n");
  const rebuilt = await rebuildConnection(recipeFile, f.source, path.join(f.root, "revised"));
  const checked = await checkConnection(rebuilt.recipe); assert.deepEqual(checked.skill, old.identity);
  assert.equal(await fs.readFile(path.join(f.root, "revised/skill/SKILL.md"), "utf8"), "# Retained earlier setup instructions\n");
});
