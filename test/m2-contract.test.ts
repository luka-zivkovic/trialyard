import test from "node:test";
import assert from "node:assert/strict";
import { contract } from "../src/contracts/validate.js";
import type { Setup } from "../src/discovery/types.js";

export const setup: Setup = { schemaVersion: "trial-runner/setup/v1", template: "node-function/v1",
  agent: { entrypoint: "agent.js", files: ["agent.js"], dependencyMode: "declared-files-only", modelCapture: "not_applicable", modelCaptureReason: "Synthetic independent function, no model", requireUsage: false, secretBindings: [] },
  environment: { template: "reference-inventory/v1" }, repetitions: 2,
  scenario: { schemaVersion: "trial-runner/scenario/v1", id: "reserve", description: "Independent reservation exercise", messages: [{ id: "one", role: "user", content: "Reserve one unit" }, { id: "two", role: "user", content: "Show reservations" }], provenance: { origin: "independent-reference", exposure: "runner-development" }, externalCriterionRefs: [] } };
test("M2 setup closed schema accepts explicit connection declarations", () => { assert.deepEqual(contract("setup", setup), setup); });
for (const [name, change] of Object.entries({
  "version": (v: any) => { v.schemaVersion = "trial-runner/setup/v9"; },
  "unknown property": (v: any) => { v.agent.execute = "npm install"; },
  "unknown environment": (v: any) => { v.environment.template = "magic"; },
  "duplicate file": (v: any) => { v.agent.files.push("agent.js"); },
  "missing model declaration": (v: any) => { delete v.agent.modelCapture; },
  "secret value": (v: any) => { v.agent.secretBindings = [{ name: "KEY", value: "secret" }]; },
  "unbounded repetitions": (v: any) => { v.repetitions = 101; },
})) test(`M2 setup rejects ${name}`, () => { const value = structuredClone(setup); change(value); assert.throws(() => contract("setup", value)); });
