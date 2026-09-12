import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseJson } from "../src/contracts/strict-json.js";
import { contract, dataValidator, safeRelative } from "../src/contracts/validate.js";
import { verifyEvents } from "../src/contracts/events.js";
import { verifyBundle } from "../src/contracts/verify.js";
import { hash, jsonBytes, safeFile } from "../src/core/files.js";
import { bundleFixture, goodEvents, plan, profile, scenario } from "./fixtures.js";

test("strict JSON preserves data and rejects duplicate, overflow, depth, encoding and trailing data", () => {
  assert.deepEqual(parseJson('{"a":[true,null,"x\\\"y",-1.2e3]}'), { a: [true, null, 'x"y', -1200] });
  for (const input of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '1e999', '[1,]', '{"a":1,}', 'true false', '['.repeat(66) + '0' + ']'.repeat(66)]) assert.throws(() => parseJson(input));
  assert.throws(() => parseJson(Buffer.from([0xff])));
  assert.throws(() => parseJson('"too long"', 2));
});
test("closed plan, profile and scenario contracts accept positive examples", () => {
  contract("plan", plan); contract("profile", profile); contract("scenario", scenario);
});

for (const limit of ["bytes", "events"] as const) test(`consumer rejects evidence exceeding pinned ${limit} even when its hashes are consistent`, async t => {
  const { root, manifest } = await bundleFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const changed = structuredClone(plan);
  const update = async (name: string, bytes: Buffer) => {
    await fs.writeFile(path.join(root, name), bytes);
    Object.assign(manifest.files.find(file => file.path === name)!, { bytes: bytes.length, sha256: hash(bytes) });
  };
  if (limit === "bytes") changed.limits.maxRecordedBytes = 1024;
  else {
    changed.limits.maxEvents = 10;
    const events = goodEvents();
    events.splice(-1, 0, ...Array.from({ length: 4 }, () => ({ ...events[0]!, kind: "diagnostic" as const, payload: { channel: "agent", text: "extra captured log" } })));
    events.forEach((event, i) => { event.sequence = i; });
    await update("events.ndjson", Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n"));
  }
  const bytes = jsonBytes(changed); await update("plan.json", bytes); manifest.planSha256 = hash(bytes);
  await fs.writeFile(path.join(root, "manifest.json"), jsonBytes(manifest));
  await assert.rejects(verifyBundle(root), limit === "bytes" ? /declared byte limit/ : /declared event limit/);
});
test("closed contracts reject hidden release policy, unknown versions and invalid limits", () => {
  for (const mutate of [
    (p: Record<string, unknown>) => { p.releasePolicy = { promote: true }; },
    (p: Record<string, unknown>) => { p.schemaVersion = "trial-runner/plan/v2"; },
    (p: Record<string, unknown>) => { p.repetitions = 0; },
    (p: Record<string, unknown>) => { (p.limits as Record<string, unknown>).maxEvents = -1; },
  ]) { const p = structuredClone(plan) as unknown as Record<string, unknown>; mutate(p); assert.throws(() => contract("plan", p)); }
});
test("operator schemas are bounded data, not remote references or regex programs", () => {
  assert.equal(dataValidator({ type: "object", properties: { count: { type: "integer", minimum: 0 } }, required: ["count"], additionalProperties: false })({ count: 1 }), true);
  for (const schema of [{ $ref: "https://example.invalid/schema" }, { type: "string", pattern: "(a+)+" }, { $async: true }]) assert.throws(() => dataValidator(schema));
});
test("unsafe and ambiguous paths are rejected", () => {
  for (const p of ["../file", "/file", "a/../b", "a//b", "a\\b", "a/./b", "C:foo", "a\0b"]) assert.throws(() => safeRelative(p));
  safeRelative("a/file.json"); safeRelative(".", true);
});
test("event replay derives physical accounting and conversation independently", () => {
  const replay = verifyEvents(goodEvents(), "run", "trial");
  assert.equal(replay.operations.length, 1); assert.equal(replay.operations[0]?.observed, true); assert.deepEqual(replay.turns, ["one"]);
});
for (const [name, change] of Object.entries({
  "identity swap": (e: ReturnType<typeof goodEvents>) => { e[2]!.trialId = "other"; },
  "reordering": (e: ReturnType<typeof goodEvents>) => { e[3]!.sequence = 1; },
  "missing dispatch": (e: ReturnType<typeof goodEvents>) => { e.splice(3, 1); e.forEach((v,i) => v.sequence=i); },
  "double count": (e: ReturnType<typeof goodEvents>) => { e.splice(3,0,structuredClone(e[2]!)); e.forEach((v,i) => v.sequence=i); },
  "false non-dispatch": (e: ReturnType<typeof goodEvents>) => { e[4]!.payload.outcome = "not_dispatched"; },
  "owner laundering": (e: ReturnType<typeof goodEvents>) => { e[2]!.source = "candidate_claim"; },
  "open operation": (e: ReturnType<typeof goodEvents>) => { e.splice(4,1); e.forEach((v,i) => v.sequence=i); },
  "early terminal": (e: ReturnType<typeof goodEvents>) => { e.splice(3,0,structuredClone(e.at(-1)!)); e.forEach((v,i) => v.sequence=i); },
})) test(`consumer rejects ${name}`, () => { const e=goodEvents(); change(e); assert.throws(() => verifyEvents(e,"run","trial")); });
test("an acknowledged intent can close as unknown without becoming an observed request", () => {
  const e=goodEvents(); e.splice(3,1); e[3]!.payload={outcome:"outcome_unknown",value:null,error:"response lost"}; e.forEach((v,i) => v.sequence=i);
  assert.equal(verifyEvents(e,"run","trial").operations[0]?.observed,false);
});
test("complete artifact verifies; changed bytes and external identity mismatch are rejected", async t => {
  const {root}=await bundleFixture(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const result=await verifyBundle(root); await verifyBundle(root,result.digest);
  await assert.rejects(verifyBundle(root,"0".repeat(64)),/identity/);
  await fs.appendFile(path.join(root,"final-state.json")," "); await assert.rejects(verifyBundle(root),/digest/);
});
for (const issue of ["missing-state", "unknown-field", "inventory-path", "false-operations", "swapped-profile", "adapter-identity", "unlisted-file"] as const) {
  test(`native consumer rejects internally inconsistent ${issue}`,async t=>{
    const {root,manifest}=await bundleFixture(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
    if(issue==="missing-state"){manifest.files=manifest.files.filter(f=>f.path!=="final-state.json");await fs.rm(path.join(root,"final-state.json"));}
    if(issue==="unknown-field")(manifest as unknown as Record<string,unknown>).promote=true;
    if(issue==="inventory-path")manifest.files[0]!.path="../outside";
    if(issue==="false-operations")manifest.operations=[];
    if(issue==="swapped-profile")manifest.evidence.profile=structuredClone(profile),manifest.evidence.profile.required.finalState=false;
    if(issue==="adapter-identity")manifest.identity.agentArtifactSha256="0".repeat(64);
    if(issue==="unlisted-file")await fs.writeFile(path.join(root,"extra.json"),"{}");
    await fs.writeFile(path.join(root,"manifest.json"),jsonBytes(manifest)); await assert.rejects(verifyBundle(root));
  });
}
test("symlinks cannot escape input or bundle boundaries",async t=>{
  const {root}=await bundleFixture(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.symlink("/etc/passwd",path.join(root,"outside")); await assert.rejects(safeFile(root,"outside"),/Symlink/);
  await assert.rejects(verifyBundle(root),/Symlink/);
});
test("byte identity is exact, rather than JSON reserialization",()=>assert.notEqual(hash('{"a":1}'),hash('{ "a": 1 }')));
