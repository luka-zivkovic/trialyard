import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkIntegration } from "../src/connection/integration.js";
import { hash, jsonBytes } from "../src/core/files.js";
import { integrationFixture } from "./integration-fixtures.js";
import { setupSkillContext, loadSetupSkill } from "../src/connection/skill.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "trial-integration-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { discovery, contract } = integrationFixture();
  const file = path.join(root, "integration-contract.json"), discoveryFile = path.join(root, "discovery.json");
  async function save() {
    const bytes = jsonBytes(discovery); await fs.writeFile(discoveryFile, bytes); contract.discovery.sha256 = hash(bytes);
    await fs.writeFile(file, jsonBytes(contract));
  }
  await save(); return { root, file, discoveryFile, discovery, contract, save };
}

test("CLI checks retained records without opening repositories or executing handoff commands", async t => {
  const f = await fixture(t), marker = path.join(f.root, "must-not-exist");
  f.contract.handoff[0]!.command = `${process.execPath} -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, "executed")'`;
  await f.save();
  const result = JSON.parse((await exec(process.execPath, [cli, "check-integration", f.file])).stdout);
  assert.equal(result.status, "consistent"); assert.equal(result.sourceVerification, "recorded_not_rechecked");
  assert.equal(result.execution, "not_run"); assert.equal(result.qualification, "not_checked"); assert.equal(result.authorization, "not_checked");
  assert.equal(result.handoffGaps.length, 5); assert.equal(result.contractSha256, hash(await fs.readFile(f.file)));
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});
test("CLI reports required questions as blocked with exit 2", async t => {
  const f = await fixture(t); f.contract.decisions = []; await f.save();
  await assert.rejects(exec(process.execPath, [cli, "check-integration", f.file]), (error: any) => {
    assert.equal(error.code, 2); const result = JSON.parse(error.stdout);
    assert.equal(result.status, "blocked"); assert.equal(result.requirements[0].subject, "scenario"); return true;
  });
});
test("unresolved entrypoint is a retained blocker rather than a fabricated finding", async t => {
  const f = await fixture(t); f.contract.entrypointFactId = null; f.contract.capabilities[0]!.state = "gap"; await f.save();
  const result = await checkIntegration(f.file);
  assert.equal(result.status, "blocked"); assert.equal(result.requirements[0]!.code, "UNESTABLISHED_ENTRYPOINT");
});
test("exact discovery and optional contract digests reject later edits", async t => {
  const f = await fixture(t), initial = await checkIntegration(f.file);
  await fs.appendFile(f.file, "\n");
  await assert.rejects(checkIntegration(f.file, initial.contractSha256), /INTEGRATION_DIGEST_MISMATCH/);
  await assert.rejects(checkIntegration(f.file, "invalid"), /INVALID_INTEGRATION_DIGEST/);
  await fs.appendFile(f.discoveryFile, "\n");
  await assert.rejects(checkIntegration(f.file), /INTEGRATION_DISCOVERY_CHANGED/);
});
test("a pair survives relocation without relying on the original conversation or source paths", async t => {
  const f = await fixture(t), moved = path.join(f.root, "moved"); await fs.mkdir(moved);
  await fs.rename(f.file, path.join(moved, "integration-contract.json")); await fs.rename(f.discoveryFile, path.join(moved, "discovery.json"));
  assert.equal((await checkIntegration(path.join(moved, "integration-contract.json"))).status, "consistent");
});
test("changed discovery repinned by a writer still must have valid references", async t => {
  const f = await fixture(t); f.discovery.facts[0]!.evidence = ["missing"]; await f.save();
  await assert.rejects(checkIntegration(f.file), /UNKNOWN_FACT_SOURCE/);
});
test("strict JSON rejects duplicate keys and oversized entry records", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, (await fs.readFile(f.file, "utf8")).replace('"id": "example"', '"id": "example", "id": "other"'));
  await assert.rejects(checkIntegration(f.file), /INVALID_MANIFEST/);
  await fs.writeFile(f.file, " ".repeat(262145));
  await assert.rejects(checkIntegration(f.file), /UNSAFE_SOURCE_FILE/);
});
for (const location of ["entry", "discovery", "parent"]) test(`checker rejects ${location} symlinks`, async t => {
  const f = await fixture(t);
  const target = location === "entry" ? f.file : f.discoveryFile;
  const actual = path.join(f.root, "actual.json"); await fs.rename(target, actual);
  if (location === "parent") {
    const directory = path.join(f.root, "actual"); await fs.mkdir(directory); await fs.rename(actual, path.join(directory, "discovery.json"));
    await fs.symlink(directory, path.join(f.root, "linked")); f.contract.discovery.path = "linked/discovery.json";
    await fs.writeFile(f.file, jsonBytes(f.contract));
  } else await fs.symlink(actual, target);
  await assert.rejects(checkIntegration(f.file), /UNSAFE_SOURCE_FILE/);
});
test("checker rejects hardlinked records and path traversal before source reads", async t => {
  const f = await fixture(t); await fs.link(f.discoveryFile, path.join(f.root, "alias.json"));
  await assert.rejects(checkIntegration(f.file), /UNSAFE_SOURCE_FILE/);
  f.contract.discovery.path = "../outside.json"; await fs.writeFile(f.file, jsonBytes(f.contract));
  await assert.rejects(checkIntegration(f.file), /UNSAFE_CONNECTION_PATH/);
});
test("skill exposes the shipped schema and guides under one immutable package identity", async () => {
  const base = await setupSkillContext(); assert.equal(base.identity.version, "0.3.2");
  for (const id of ["discovery", "qualification", "integration-schema"]) {
    const context = await setupSkillContext(id); assert.equal(context.identity.sha256, base.identity.sha256);
    assert.equal(context.references.length, 1); assert.equal(context.references[0]!.id, id);
    if (id === "integration-schema") assert.ok(JSON.parse(context.references[0]!.content).$defs.contract);
  }
  assert.ok(base.tools.some(t => t.command === "check-integration" && t.effect === "read_integration_records"));
});
for (const version of ["0.1.0", "0.2.0", "0.3.0"] as const) test(`older ${version} skill snapshots remain loadable`, async t => {
  const f = await fixture(t), skill = await loadSetupSkill(), out = path.join(f.root, "skill"); await fs.mkdir(out);
  for (const [name, bytes] of skill.files) {
    await fs.mkdir(path.dirname(path.join(out, name)), { recursive: true }); await fs.writeFile(path.join(out, name), bytes);
  }
  await fs.writeFile(path.join(out, "package.json"), jsonBytes({ ...skill.manifest, version }));
  assert.equal((await loadSetupSkill(out)).identity.version, version);
});
