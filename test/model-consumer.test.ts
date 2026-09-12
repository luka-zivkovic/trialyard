import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { initExample } from "../src/cli/init.js";
import { runPlan } from "../src/core/run.js";
import { verifyBundle } from "../src/contracts/verify.js";
import type { Artifact, Event, Manifest, ModelObservation, ModelRequest, Plan, Profile } from "../src/contracts/types.js";

// The consumer below uses the public schema and native byte hashing. Expected
// reports and coverage are derived here, independently of producer model helpers.
const ajv = new Ajv2020({ strict: true, validateFormats: false });
ajv.addSchema(JSON.parse(readFileSync(new URL("../../contracts/v1.schema.json", import.meta.url), "utf8")), "wire");
const manifestSchema = ajv.compile<Manifest>({ $ref: "wire#/$defs/manifest" });
const eventSchema = ajv.compile<Event>({ $ref: "wire#/$defs/event" });
const requestSchema = ajv.compile<ModelRequest>({ $ref: "wire#/$defs/modelRequest" });
const observationSchema = ajv.compile<ModelObservation>({ $ref: "wire#/$defs/modelObservation" });
const frameSchema = ajv.compile<import("../src/contracts/types.js").Frame>({ $ref: "wire#/$defs/frame" });
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
const content = (files: Map<string, Buffer>, name: string): Buffer => { const bytes = files.get(name); assert(bytes, `Missing ${name}`); return bytes; };
const json = <T>(files: Map<string, Buffer>, name: string): T => JSON.parse(content(files, name).toString("utf8")) as T;
function safe(name: string): void {
  assert(!/[\\:\0]/.test(name) && name.split("/").every(part => part && part !== "." && part !== ".."), "Unsafe inventory path");
}
async function load(root: string, prefix = ""): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const item of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name; safe(name);
    assert(!item.isSymbolicLink(), "Symlink evidence");
    if (item.isDirectory()) for (const [key, value] of await load(root, name)) files.set(key, value);
    else { assert(item.isFile()); files.set(name, await fs.readFile(path.join(root, name))); }
  }
  return files;
}

function consume(files: Map<string, Buffer>, expected: string): Manifest {
  assert.equal(sha(content(files, "manifest.json")), expected, "Bundle identity");
  const manifest: unknown = json(files, "manifest.json"); assert(manifestSchema(manifest), "Manifest schema");
  const names = manifest.files.map(file => file.path); names.forEach(safe);
  assert.equal(new Set(names).size, names.length); assert.deepEqual(names, [...names].sort());
  assert.deepEqual([...files.keys()].sort(), [...names, "manifest.json"].sort());
  for (const file of manifest.files) {
    assert.equal(content(files, file.path).length, file.bytes, "File length");
    assert.equal(sha(content(files, file.path)), file.sha256, "File digest");
  }
  assert.equal(sha(content(files, "plan.json")), manifest.planSha256);
  assert.equal(sha(content(files, "scenario.json")), manifest.scenarioSha256);
  assert.equal(sha(content(files, "fixture.json")), manifest.fixtureSha256);
  assert.deepEqual(json(files, "profile.json"), manifest.evidence.profile);
  assert.equal(manifest.identity.authenticity, "not_attested");
  const log = new TextDecoder("utf-8", { fatal: true }).decode(content(files, "events.ndjson"));
  assert(log.endsWith("\n"));
  const events = log.slice(0, -1).split("\n").map((line, index) => {
    const event: unknown = JSON.parse(line); assert(eventSchema(event), "Event schema");
    assert.equal(event.sequence, index); assert.equal(event.runId, manifest.runId); assert.equal(event.trialId, manifest.trialId);
    return event;
  });
  assert.equal(events[0]?.payload.scenarioId, manifest.scenarioId);
  assert.equal(events.at(-1)?.payload.execution, manifest.execution);
  const intents = events.filter(event => event.kind === "operation.dispatch_intent");
  const byId = new Map(intents.map(event => [event.operationId, event]));
  assert.equal(byId.size, intents.length, "Duplicate operation identity");
  const models = intents.filter(event => event.payload.boundary === "model");
  const gaps = new Set<string>();
  const profile = manifest.evidence.profile;
  if (profile.modelCapture !== "not_applicable" && events.some(event => event.kind === "user.turn")) {
    const ready: unknown = json(files, "agent-ready.json"); assert(frameSchema(ready), "Effective ready schema");
    const plan = json<Plan>(files, "plan.json");
    assert.equal(ready.kind, "ready"); assert.equal(ready.trialId, manifest.trialId);
    assert.equal(ready.payload.modelCapture, profile.modelCapture, "Effective model capture");
    assert.equal(ready.payload.artifactSha256, manifest.identity.agentArtifactSha256, "Effective artifact identity");
    assert.equal(ready.payload.adapterId, plan.agent.adapterId); assert.equal(ready.payload.adapterVersion, plan.agent.adapterVersion);
    for (const capability of [...plan.agent.capabilities, `model-${profile.modelCapture}`]) assert((ready.payload.capabilities as string[]).includes(capability), "Effective capability");
  }
  if (files.has("agent-stopped.json")) {
    const stopped: unknown = json(files, "agent-stopped.json"); assert(frameSchema(stopped), "Stop observation schema");
    assert.equal(stopped.kind, "stopped"); assert.equal(stopped.trialId, manifest.trialId);
    if ((stopped.payload.outstandingOperationIds as string[]).length) gaps.add("agent_reported_outstanding_work");
  }
  if (profile.modelCapture === "reported") gaps.add("model_attempts_unverified");
  if (profile.modelCapture === "not_applicable" && models.length) gaps.add("model_capture_declaration_contradicted");
  for (const turn of events.filter(event => event.kind === "user.turn")) {
    const closed = events.find(event => event.kind === "assistant.turn" && event.turnId === turn.turnId);
    const declared = closed?.payload.modelOperations;
    const recorded = models.filter(event => event.turnId === turn.turnId).map(event => event.operationId!);
    if (!Array.isArray(declared)) { if (profile.modelCapture !== "not_applicable") gaps.add("model_turn_coverage_missing"); }
    else { assert.equal(new Set(declared).size, declared.length); assert.deepEqual([...declared].sort(), [...recorded].sort(), "Exact turn model coverage"); }
  }
  const expectedProvider: { requested: unknown[] | null; observed: unknown[] | null; usage: unknown[] | null; cost: unknown[] | null } =
    models.length ? { requested: [], observed: [], usage: [], cost: [] } : { requested: null, observed: null, usage: null, cost: null };
  for (const intent of models) {
    assert.equal(intent.payload.owner, "agent"); assert.equal(intent.source, "adapter_reported");
    const request: unknown = intent.payload.args; assert(requestSchema(request), "Model request schema");
    assert(request.provider.trim() && request.model.trim(), "Empty requested model identity");
    assert.equal(intent.payload.name, request.model, "Requested model linkage");
    if (intent.parentOperationId) {
      const parent = byId.get(intent.parentOperationId); assert(parent);
      assert.equal(parent.payload.boundary, "model", "Model parent boundary"); assert.equal(parent.payload.owner, "agent");
      assert.equal(parent.turnId, intent.turnId);
    }
    const observations = events.filter(event => event.operationId === intent.operationId && event.kind === "operation.dispatch_observed");
    const endings = events.filter(event => event.operationId === intent.operationId && event.kind === "operation.finished");
    assert(observations.length <= 1); assert.equal(endings.length, 1, "Terminal model accounting");
    const end = endings[0]!;
    for (const event of [...observations, end]) {
      assert.equal(event.turnId, intent.turnId); assert.equal(event.parentOperationId, intent.parentOperationId);
      assert.equal(event.logicalCallId, intent.logicalCallId);
      assert(event.source === "adapter_reported" || (event === end && event.source === "runner_observed" && ["outcome_unknown", "not_dispatched"].includes(String(end.payload.outcome))), "Model observation provenance");
    }
    if (["known_result", "known_failure"].includes(String(end.payload.outcome))) assert.equal(observations.length, 1);
    if (end.payload.outcome === "outcome_unknown") gaps.add("model_operation_outcome_unknown");
    const metadata: unknown = end.payload.model ?? null;
    assert(metadata === null || observationSchema(metadata), "Model observation schema");
    if (metadata !== null) assert.equal(end.source, "adapter_reported", "Runner closure cannot invent adapter metadata");
    if (end.payload.outcome === "not_dispatched") { assert.equal(observations.length, 0); assert.equal(metadata, null); }
    if (metadata?.cost) assert(metadata.cost.currency.trim() && metadata.cost.pricingId.trim(), "Cost units and pricing identity");
    if (profile.required.modelUsage && end.payload.outcome !== "not_dispatched" &&
        (metadata?.usage?.inputTokens == null || metadata.usage.outputTokens == null || metadata.usage.source !== "provider_reported")) gaps.add("model_usage_missing");
    expectedProvider.requested!.push({ operationId: intent.operationId, provider: request.provider, model: request.model, settings: request.settings });
    expectedProvider.observed!.push({ operationId: intent.operationId, source: "adapter_reported", provider: metadata?.provider ?? null, model: metadata?.model ?? null,
      modelRevision: metadata?.modelRevision ?? null, requestId: metadata?.requestId ?? null });
    expectedProvider.usage!.push({ operationId: intent.operationId, value: metadata?.usage ?? null });
    expectedProvider.cost!.push({ operationId: intent.operationId, value: metadata?.cost ?? null });
  }
  assert.deepEqual(manifest.provider, expectedProvider, "Reports must equal recorded per-operation observations");
  for (const gap of gaps) assert(manifest.evidence.gaps.includes(gap), `Undeclared ${gap}`);
  assert.equal(manifest.evidence.state === "complete", manifest.evidence.gaps.length === 0);
  return manifest;
}

interface Variant { capture?: "accounted" | "reported"; usage?: "provider" | "missing" | "estimated"; requireUsage?: boolean; nonDispatch?: boolean; }
async function actualBundle(t: TestContext, variant: Variant = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "independent-model-consumer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = await initExample(path.join(root, "example"));
  const inputRoot = path.dirname(file);
  const plan = JSON.parse(await fs.readFile(file, "utf8")) as Plan;
  const capture = variant.capture ?? "accounted";
  plan.repetitions = 1; plan.agent.capabilities.push(`model-${capture}`);
  Object.assign(plan.limits, { prepareMs: 10000, trialMs: 10000, stopGraceMs: 30, snapshotMs: 1000, cleanupMs: 1000 });
  await fs.writeFile(file, encode(plan));
  const profileFile = path.join(inputRoot, plan.evidenceProfile);
  const profile = JSON.parse(await fs.readFile(profileFile, "utf8")) as Profile;
  profile.modelCapture = capture; profile.required.modelUsage = variant.requireUsage ?? false;
  profile.modelCaptureReason = "Synthetic adapter-visible calls; no network or model execution";
  await fs.writeFile(profileFile, encode(profile));
  const code = Buffer.from(`import { createInterface } from 'node:readline';
const pending = new Map(); let count = 0, turns = 0, trialId;
const variant = ${JSON.stringify(variant)};
const send = (kind,payload,replyTo) => { const f={protocol:'trial-runner/process/v1',trialId,messageId:'synthetic-'+(++count),kind,payload,...(replyTo?{replyTo}:{})}; process.stdout.write(JSON.stringify(f)+'\\n'); return f.messageId; };
const event = (kind,id,data) => new Promise(resolve => { const mid=send('event',{kind,operationId:id,logicalCallId:'retry-group',parentOperationId:null,data}); pending.set(mid,resolve); });
async function handle(f) {
 if(f.kind==='start') send('ready',{adapterId:'reference.agent',adapterVersion:'0.1.0',artifactSha256:f.payload.artifactSha256,capabilities:['scripted-turns','routed-tools','conversation-events','model-'+f.payload.modelCapture],modelCapture:f.payload.modelCapture},f.messageId);
 else if(f.kind==='user_turn') { const ids=[];
  if(++turns===1) for(const id of (variant.nonDispatch?['attempt-a']:['attempt-a','attempt-b'])) {
   ids.push(id); await event('operation.dispatch_intent',id,{boundary:'model',owner:'agent',name:'mutable-alias',args:{provider:'synthetic-provider',model:'mutable-alias',settings:{temperature:0},input:'Synthetic input'}});
   if(variant.nonDispatch) { await event('operation.finished',id,{outcome:'not_dispatched',value:null,error:'Synthetic pre-dispatch stop',model:null}); continue; }
   await event('operation.dispatch_observed',id,{});
   const failure=id==='attempt-a'; const usage=variant.usage==='missing'?null:{inputTokens:failure?7:13,outputTokens:failure?0:5,source:variant.usage==='estimated'?'adapter_estimated':'provider_reported'};
   await event('operation.finished',id,{outcome:failure?'known_failure':'known_result',value:failure?null:{output:'Synthetic reply'},error:failure?'Synthetic retriable model failure':null,model:{provider:'synthetic-provider',model:'mutable-alias',modelRevision:null,requestId:'request-'+id,usage,cost:failure?null:{amount:0.03,currency:'USD',source:'adapter_estimated',pricingId:'synthetic-pricing-v1'}}});
  }
  send('turn_finished',{turnId:f.payload.turnId,output:'Synthetic completed turn',outstandingOperationIds:[],modelOperations:ids},f.messageId);
 } else if(f.kind==='stop') send('stopped',{outstandingOperationIds:[]},f.messageId);
}
createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);trialId=f.trialId;if(f.replyTo){const resolve=pending.get(f.replyTo);pending.delete(f.replyTo);resolve(f);}else handle(f).catch(e=>{process.stderr.write(String(e));process.exit(1)});});
`);
  await fs.writeFile(path.join(inputRoot, "reference/agent.js"), code);
  for (const name of [plan.agent.artifactManifest, plan.environment.artifactManifest]) {
    const target = path.join(inputRoot, name); const artifact = JSON.parse(await fs.readFile(target, "utf8")) as Artifact;
    Object.assign(artifact.files.find(entry => entry.path === "reference/agent.js")!, { bytes: code.length, sha256: sha(code) });
    await fs.writeFile(target, encode(artifact));
  }
  const run = await runPlan(file, { requestId: "synthetic-model", store: path.join(root, "store") });
  const slot = run.index.trials[0]!;
  const bundleRoot = path.join(run.root, slot.path), files = await load(bundleRoot);
  return { root, files, digest: slot.bundleSha256!, exitCode: run.index.exitCode };
}

test("independent model consumer preserves failed attempts, aliases, null costs and explicit zero-call turns", async t => {
  const bundle = await actualBundle(t, { requireUsage: true });
  const result = consume(bundle.files, bundle.digest);
  assert.equal(bundle.exitCode, 0); assert.equal(result.evidence.state, "complete");
  assert.deepEqual(result.provider.usage, [
    { operationId: "attempt-a", value: { inputTokens: 7, outputTokens: 0, source: "provider_reported" } },
    { operationId: "attempt-b", value: { inputTokens: 13, outputTokens: 5, source: "provider_reported" } },
  ]);
  assert.deepEqual((result.provider.cost as { operationId: string; value: unknown }[])[0], { operationId: "attempt-a", value: null });
  assert((result.provider.observed as { modelRevision: unknown }[]).every(row => row.modelRevision === null));
});

for (const [name, variant, gap] of [
  ["optional unknown usage", { usage: "missing" }, null],
  ["required unknown usage", { usage: "missing", requireUsage: true }, "model_usage_missing"],
  ["optional estimated usage", { usage: "estimated" }, null],
  ["required estimated usage", { usage: "estimated", requireUsage: true }, "model_usage_missing"],
  ["reported attempts", { capture: "reported" }, "model_attempts_unverified"],
  ["known non-dispatch with required usage", { nonDispatch: true, requireUsage: true }, null],
] as const) test(`independent model consumer: ${name}`, async t => {
  const bundle = await actualBundle(t, variant); const result = consume(bundle.files, bundle.digest);
  assert.equal(result.evidence.state, gap ? "incomplete" : "complete");
  assert.equal(bundle.exitCode, gap ? 2 : 0);
  if (gap) assert(result.evidence.gaps.includes(gap));
});

test("independent and native model consumers reject self-consistent report and coverage tampering", async t => {
  const source = await actualBundle(t, { requireUsage: true });
  type Mutation = (manifest: Manifest, events: Event[], files: Map<string, Buffer>) => void;
  const replaceFrame = (manifest: Manifest, files: Map<string, Buffer>, name: string, mutate: (frame: import("../src/contracts/types.js").Frame) => void) => {
    const frame = json<import("../src/contracts/types.js").Frame>(files, name); mutate(frame);
    const bytes = encode(frame); files.set(name, bytes);
    Object.assign(manifest.files.find(file => file.path === name)!, { bytes: bytes.length, sha256: sha(bytes) });
  };
  const attacks: [string, Mutation][] = [
    ["untrusted aggregate", manifest => { manifest.provider.usage = { totalTokens: 0 }; }],
    ["unknown cost changed to zero", manifest => { (manifest.provider.cost as { value: unknown }[])[0]!.value = 0; }],
    ["observed provenance upgraded", manifest => { (manifest.provider.observed as { source: string }[])[0]!.source = "runner_observed"; }],
    ["provider operation identity swapped", manifest => { (manifest.provider.requested as { operationId: string }[])[0]!.operationId = "other"; }],
    ["event trial identity swapped", (_, events) => { events.find(event => event.kind === "operation.finished")!.trialId = "other"; }],
    ["missing turn coverage", (_, events) => { delete events.find(event => event.kind === "assistant.turn")!.payload.modelOperations; }],
    ["partial turn coverage", (_, events) => { events.find(event => event.kind === "assistant.turn")!.payload.modelOperations = ["attempt-a"]; }],
    ["duplicate turn coverage", (_, events) => { events.find(event => event.kind === "assistant.turn")!.payload.modelOperations = ["attempt-a", "attempt-a", "attempt-b"]; }],
    ["cross-turn coverage", (_, events) => { events.filter(event => event.kind === "assistant.turn")[1]!.payload.modelOperations = ["attempt-a"]; }],
    ["requested model identity mismatch", (_, events) => { events.find(event => event.kind === "operation.dispatch_intent")!.payload.name = "different-model"; }],
    ["candidate prose substituted for model observation", (_, events) => { events.find(event => event.kind === "operation.finished")!.source = "candidate_claim"; }],
    ["runner closure launders adapter metadata", (manifest, events) => {
      const end = events.find(event => event.kind === "operation.finished")!;
      end.source = "runner_observed"; end.payload.outcome = "outcome_unknown"; end.payload.value = null;
      manifest.operations.find(operation => operation.id === end.operationId)!.outcome = "outcome_unknown";
      manifest.evidence.gaps.push("model_operation_outcome_unknown"); manifest.evidence.state = "incomplete";
    }],
    ["effective model capture downgraded", (manifest, _, files) => replaceFrame(manifest, files, "agent-ready.json", frame => { frame.payload.modelCapture = "reported"; })],
    ["effective artifact identity swapped", (manifest, _, files) => replaceFrame(manifest, files, "agent-ready.json", frame => { frame.payload.artifactSha256 = "a".repeat(64); })],
    ["effective handshake removed", (manifest, _, files) => { files.delete("agent-ready.json"); manifest.files = manifest.files.filter(file => file.path !== "agent-ready.json"); }],
    ["outstanding stop claim discarded", (manifest, _, files) => replaceFrame(manifest, files, "agent-stopped.json", frame => { frame.payload.outstandingOperationIds = ["external-unknown"]; })],
  ];
  for (const [name, mutate] of attacks) await t.test(name, async () => {
    const files = new Map(source.files), manifest = json<Manifest>(files, "manifest.json");
    const events = content(files, "events.ndjson").toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Event);
    mutate(manifest, events, files);
    const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n"); files.set("events.ndjson", bytes);
    Object.assign(manifest.files.find(file => file.path === "events.ndjson")!, { bytes: bytes.length, sha256: sha(bytes) });
    files.set("manifest.json", encode(manifest));
    // Refresh outer identities so the attack must fail a semantic consumer check.
    const expected = sha(content(files, "manifest.json"));
    assert.throws(() => consume(files, expected));
    const destination = await fs.mkdtemp(path.join(source.root, "tampered-"));
    for (const [file, data] of files) { await fs.mkdir(path.dirname(path.join(destination, file)), { recursive: true }); await fs.writeFile(path.join(destination, file), data); }
    await assert.rejects(verifyBundle(destination, expected));
  });
});
