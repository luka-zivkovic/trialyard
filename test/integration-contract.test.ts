import test from "node:test";
import assert from "node:assert/strict";
import { integrationDiscovery, integrationContract, integrationRequirements } from "../src/connection/integration-contract.js";


import { integrationFixture } from "./integration-fixtures.js";

test("integration proposal validates separately from readiness, execution and authorization", () => {
  const { discovery, contract } = integrationFixture();
  assert.equal(integrationDiscovery(discovery), discovery);
  assert.equal(integrationContract(contract, discovery), contract);
  assert.deepEqual(integrationRequirements(contract, discovery), []);
});
test("unanswered owner decisions and capability gaps remain explicit blockers", () => {
  const { discovery, contract } = integrationFixture(); contract.decisions = [];
  contract.capabilities[0]!.state = "gap";
  assert.equal(integrationContract(contract, discovery), contract);
  assert.deepEqual(integrationRequirements(contract, discovery).map(r => r.code), ["UNRESOLVED_QUESTION", "CAPABILITY_GAP"]);
});
test("optional source questions remain visible without blocking the selected scope", () => {
  const { discovery, contract } = integrationFixture();
  discovery.unknowns.push({ id: "other-entrypoint", area: "entrypoint", question: "Does an unrelated entrypoint exist?", resolution: "source", blocking: false, recommendation: null });
  integrationContract(contract, discovery); assert.deepEqual(integrationRequirements(contract, discovery), []);
});
for (const [name, mutate] of Object.entries({
  "unknown schema version": (d: any) => { d.schemaVersion = "future"; },
  "unrecognized field": (d: any) => { d.approved = true; },
  "blank claim": (d: any) => { d.facts[0].claim = "  "; },
  "unknown source": (d: any) => { d.facts[0].evidence = ["missing"]; },
  "unknown repository": (d: any) => { d.sources[0].repository = "missing"; },
  "duplicate fact": (d: any) => { d.facts.push(d.facts[0]); },
  "duplicate source path": (d: any) => { d.sources.push({ ...d.sources[0], id: "another", path: "Agent.js" }); },
  "path traversal": (d: any) => { d.sources[0].path = "../outside.js"; },
  "credential path": (d: any) => { d.sources[0].path = ".env"; },
})) test(`discovery rejects ${name}`, () => {
  const { discovery } = integrationFixture(); mutate(discovery); assert.throws(() => integrationDiscovery(discovery));
});
for (const [name, mutate] of Object.entries({
  "unknown schema version": (c: any) => { c.schemaVersion = "future"; },
  "execution claim": (c: any) => { c.execution = "passed"; },
  "inferred entrypoint": (_c: any, d: any) => { d.facts[0].certainty = "inferred"; },
  "unknown capability fact": (c: any) => { c.capabilities[0].factIds = ["missing"]; },
  "unsupported capability claim": (c: any) => { c.capabilities[0].factIds = []; },
  "missing capability": (c: any) => { c.capabilities.pop(); },
  "duplicate capability": (c: any) => { c.capabilities[1] = c.capabilities[0]; },
  "omitted required lifecycle": (c: any) => { c.capabilities[0].required = false; },
  "required but inapplicable": (c: any) => { c.capabilities[0].state = "not_applicable"; },
  "missing qualification": (c: any) => { c.qualification = c.qualification.slice(1); },
  "source question answered as owner choice": (_c: any, d: any) => { d.unknowns[0].resolution = "source"; },
  "missing decision origin": (c: any) => { c.decisions[0].reference = ""; },
  "duplicate decision": (c: any) => { c.decisions.push(c.decisions[0]); },
  "duplicate handoff": (c: any) => { c.handoff[1] = c.handoff[0]; },
  "unbounded execution": (c: any) => { c.bounds.maxTrialRuns = -1; },
  "missing provider allowance": (c: any) => { c.bounds.provider = "existing_allowance"; },
  "contradictory provider allowance": (c: any) => { c.bounds.allowanceRef = "allowance"; },
  "unsafe linked discovery": (c: any) => { c.discovery.path = "../discovery.json"; },
})) test(`integration contract rejects ${name}`, () => {
  const { discovery, contract } = integrationFixture(); mutate(contract, discovery); assert.throws(() => integrationContract(contract, discovery));
});
