import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { verifyBundle } from "../src/contracts/verify.js";
import { hash, jsonBytes } from "../src/core/files.js";
import { resolvePlan } from "../src/core/plan.js";
import type { Event, Frame, Plan, Snapshot } from "../src/contracts/types.js";
import { bundleFixture } from "./fixtures.js";

async function fixture(t: TestContext) {
  const { root, manifest } = await bundleFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const read = async <T>(name: string): Promise<T> => JSON.parse(await fs.readFile(path.join(root, name), "utf8")) as T;
  const write = async (name: string, value: unknown) => fs.writeFile(path.join(root, name), jsonBytes(value));
  const remove = async (name: string) => {
    await fs.rm(path.join(root, name));
    manifest.files = manifest.files.filter(file => file.path !== name);
  };
  const journal = async (change: (events: Event[]) => void) => {
    const events = (await fs.readFile(path.join(root, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Event);
    change(events);
    await fs.writeFile(path.join(root, "events.ndjson"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  };
  // Rehash every changed payload and supply the NEW digest so failures exercise
  // semantic validation, independently of the already-tested byte integrity.
  const verify = async () => {
    for (const file of manifest.files) {
      const bytes = await fs.readFile(path.join(root, file.path));
      file.bytes = bytes.length; file.sha256 = hash(bytes);
    }
    manifest.planSha256 = hash(await fs.readFile(path.join(root, "plan.json")));
    const bytes = jsonBytes(manifest);
    await fs.writeFile(path.join(root, "manifest.json"), bytes);
    return verifyBundle(root, hash(bytes));
  };
  return { root, manifest, read, write, remove, journal, verify };
}

test("positive consumer fixture contains a resolvable plan and its complete declared input set", async t => {
  const f = await fixture(t);
  await resolvePlan(path.join(f.root, "inputs/plan.json"));
  assert.equal((await f.verify()).manifest.evidence.state, "complete");
});

for (const name of ["settings.json", "state-schema.json", "tools.json", "state.json", "agent.js"]) {
  test(`bundle verification rejects missing declared input ${name} with regenerated hashes`, async t => {
    const f = await fixture(t); await f.remove(`inputs/${name}`);
    await assert.rejects(f.verify(), /Missing (declared input|pinned adapter file)/);
  });
}

for (const stage of ["initial", "final"]) test(`bundle verification applies the pinned schema to ${stage} state`, async t => {
  const f = await fixture(t), name = `${stage}-state.json`;
  const snapshot = await f.read<Snapshot>(name); snapshot.state = { wrongSchema: true };
  await f.write(name, snapshot);
  await assert.rejects(f.verify(), /snapshot.*schema/i);
});

for (const issue of ["unknown-tool", "invalid-arguments", "invalid-result"] as const) {
  test(`bundle verification rejects ${issue} with regenerated event hashes`, async t => {
    const f = await fixture(t);
    await f.journal(events => {
      if (issue === "unknown-tool") events[2]!.payload.name = "undeclared_tool";
      if (issue === "invalid-arguments") events[2]!.payload.args = { unexpected: true };
      if (issue === "invalid-result") events[4]!.payload.value = { count: "wrong" };
    });
    await assert.rejects(f.verify(), /tool.*(declared|schema)/i);
  });
}

for (const issue of ["settings", "entrypoint", "capabilities"] as const) {
  test(`bundle verification enforces plan ${issue} invariants`, async t => {
    const f = await fixture(t), plan = await f.read<Plan>("plan.json");
    if (issue === "settings") plan.agent.settings.unexpected = true;
    if (issue === "entrypoint") plan.agent.argv[1] = "unlisted.js";
    if (issue === "capabilities") plan.agent.capabilities = [];
    await f.write("plan.json", plan); await f.write("inputs/plan.json", plan);
    await assert.rejects(f.verify(), /settings|entrypoint|capability/);
  });
}

for (const name of ["agent-ready.json", "environment-described.json", "environment-prepared.json", "environment-disposed.json"]) {
  test(`bundle verification binds ${name} to its own trial`, async t => {
    const f = await fixture(t), frame = await f.read<Frame>(name); frame.trialId = "other-trial";
    await f.write(name, frame); await assert.rejects(f.verify(), /observation|handshake/i);
  });
  test(`executed bundle cannot omit ${name} and retain complete lifecycle claims`, async t => {
    const f = await fixture(t); await f.remove(name);
    await assert.rejects(f.verify(), /observation|handshake|cleanup/i);
  });
}

for (const name of ["agent-ready.json", "environment-described.json"]) {
  test(`bundle verification checks ${name} identity with model capture disabled`, async t => {
    const f = await fixture(t), frame = await f.read<Frame>(name); frame.payload.adapterId = "different-adapter";
    await f.write(name, frame); await assert.rejects(f.verify(), /identity|handshake/i);
  });
}

test("bundle verification rejects a cleanup summary contradicting the disposal observation", async t => {
  const f = await fixture(t), frame = await f.read<Frame>("environment-disposed.json");
  frame.payload.status = "failed"; await f.write("environment-disposed.json", frame);
  await assert.rejects(f.verify(), /cleanup/i);
});

test("bundle verification compares effective environment tools and the recorded initial snapshot", async t => {
  const f = await fixture(t), described = await f.read<Frame>("environment-described.json");
  described.payload.tools = []; await f.write("environment-described.json", described);
  await assert.rejects(f.verify(), /tool schema/i);
  const tools = await f.read<Frame["payload"][string]>("inputs/tools.json");
  described.payload.tools = tools!; await f.write("environment-described.json", described);
  const prepared = await f.read<Frame>("environment-prepared.json");
  (prepared.payload.snapshot as unknown as Snapshot).state = { remaining: 99 };
  await f.write("environment-prepared.json", prepared);
  await assert.rejects(f.verify(), /initial.*observation/i);
});

test("schema-incompatible masked state stays inspectable only with explicit redaction and incompleteness", async t => {
  const f = await fixture(t), snapshot = await f.read<Snapshot>("final-state.json");
  snapshot.state = { remaining: null }; await f.write("final-state.json", snapshot);
  f.manifest.evidence.redactedPaths = ["final-state.json"];
  f.manifest.evidence.gaps = ["required_content_redacted"]; f.manifest.evidence.state = "incomplete";
  assert.equal((await f.verify()).manifest.evidence.state, "incomplete");
  f.manifest.evidence.redactedPaths = [];
  await assert.rejects(f.verify(), /snapshot.*schema/i);
});
