import test from "node:test";
import assert from "node:assert/strict";
import { recipeContract, connectionContract, type ConnectionRecipe } from "../src/connection/contracts.js";

const file = { path: "prepared/plan.json", bytes: 10, sha256: "a".repeat(64) };
const fixture = (): ConnectionRecipe => ({ schemaVersion: "trial-runner/connection-recipe/v1", id: "example", method: "prepared-plan/v1", skill: null,
  sources: [], files: [{ ...file }], plan: { path: file.path, inputSha256: "b".repeat(64) }, requirements: [] });

test("connection contract accepts explicit plan and blocked manual recipe shapes", () => {
  assert.ok(recipeContract(fixture()));
  const blocked = fixture(); blocked.method = "manual-integration/v1"; blocked.plan = null;
  blocked.requirements = [{ code: "ADAPTER_REQUIRED", message: "Implement the declared environment lifecycle." }];
  assert.ok(recipeContract(blocked));
});

for (const [label, mutate] of [
  ["future version", (r: any) => { r.schemaVersion = "future"; }],
  ["unknown property", (r: any) => { r.ready = true; }],
  ["invented method", (r: any) => { r.method = "automatic-production/v1"; }],
  ["missing unresolved reason", (r: any) => { r.plan = null; }],
  ["manual plan", (r: any) => { r.method = "manual-integration/v1"; }],
  ["unresolved plan", (r: any) => { r.requirements = [{ code: "NEEDS_RESET", message: "Define reset." }]; }],
  ["unlisted plan", (r: any) => { r.plan.path = "other.json"; }],
  ["path traversal", (r: any) => { r.files[0].path = "../outside.json"; }],
  ["hidden credential", (r: any) => { r.sources = [{ ...file, path: ".env" }]; }],
  ["nested credential", (r: any) => { r.files.push({ ...file, path: "config/secret.json" }); }],
  ["case collision", (r: any) => { r.files.push({ ...file, path: "prepared/Plan.json" }); }],
  ["excess bytes", (r: any) => { r.files = Array.from({ length: 5 }, (_, i) => ({ ...file, path: `part${i}.js`, bytes: 16777216 })); }],
  ["unknown skill", (r: any) => { r.skill = { id: "other", version: "0.1.0", sha256: "a".repeat(64) }; }],
] as const) test(`connection contract rejects ${label}`, () => {
  const r = fixture(); mutate(r); assert.throws(() => recipeContract(r));
});

test("skill package contract rejects unknown fields and wire versions", () => {
  const manifest = { schemaVersion: "trial-runner/skill-package/v1", id: "connect-agent", version: "0.1.0", recipeSchemaVersion: "trial-runner/connection-recipe/v1", entrypoint: "SKILL.md", references: [] };
  assert.ok(connectionContract("skillManifest", manifest));
  assert.throws(() => connectionContract("skillManifest", { ...manifest, tools: ["arbitrary-shell"] }));
  assert.throws(() => connectionContract("skillManifest", { ...manifest, recipeSchemaVersion: "future" }));
});
