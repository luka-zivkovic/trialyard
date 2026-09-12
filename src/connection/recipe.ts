import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hash, jsonBytes, writeAtomic } from "../core/files.js";
import { resolvePlan } from "../core/plan.js";
import { prepareRepository } from "../discovery/prepare.js";
import type { DiscoveryReport } from "../discovery/types.js";
import { DiscoveryError, declaredFile, fail, metadata, newDestination, publicJson, readPublic, record, repositoryRoot } from "../discovery/safe.js";
import { connectionContract, connectionPath, recipeContract, type ConnectionRecipe, type SkillManifest } from "./contracts.js";
import { loadSetupSkill } from "./skill.js";
import { verifyRebuildLineage } from "./rebuild-contract.js";

export async function verifyConnectionContents(root: string, value: unknown) {
  const recipe = recipeContract(value);
  let total = 0;
  // Check the whole inventory before payload reads, including late invalid entries.
  for (const f of recipe.files) {
    total += (await declaredFile(f.path, "check-connection", () => metadata(root, f.path, 16 * 1024 * 1024))).size;
    if (total > 64 * 1024 * 1024) fail("CONNECTION_BYTE_LIMIT");
  }
  const files = new Map<string, Buffer>();
  for (const f of recipe.files) {
    const bytes = await declaredFile(f.path, "check-connection", () => readPublic(root, f.path, 16 * 1024 * 1024));
    if (bytes.length !== f.bytes || hash(bytes) !== f.sha256) fail("CONNECTION_FILE_CHANGED", { phase: "check-connection", path: f.path, rule: "bytes differ from the retained inventory",
      action: "Restore the frozen connection. For an intentional source edit, rebuild from the source into a new connection." });
    files.set(f.path, bytes);
  }
  if (recipe.skill) {
    // The loader may only read files already declared in this connection.
    const manifestBytes = files.get("skill/package.json");
    if (!manifestBytes) return fail("MISSING_SKILL_INVENTORY");
    const manifest = connectionContract<SkillManifest>("skillManifest", publicJson(manifestBytes));
    if ([manifest.entrypoint, ...manifest.references.map(r => r.path)].some(n => !files.has(`skill/${n}`))) fail("MISSING_SKILL_INVENTORY");
    const skill = await loadSetupSkill(path.join(root, "skill"));
    if (skill.identity.sha256 !== recipe.skill.sha256) fail("CONNECTION_SKILL_CHANGED");
    for (const [name, bytes] of skill.files) if (!files.get(`skill/${name}`)?.equals(bytes)) fail("CONNECTION_FILE_CHANGED");
  }
  if (recipe.plan) {
    const prefix = path.posix.dirname(recipe.plan.path) === "." ? "" : path.posix.dirname(recipe.plan.path) + "/";
    const allowed = new Set(recipe.files.filter(f => f.path.startsWith(prefix)).map(f => f.path.slice(prefix.length)));
    const resolved = await resolvePlan(path.join(root, recipe.plan.path), allowed);
    if (resolved.inputSha256 !== recipe.plan.inputSha256) fail("CONNECTION_PLAN_CHANGED");
    for (const [name, bytes] of resolved.files) if (!files.get(prefix + name)?.equals(bytes)) fail("CONNECTION_FILE_CHANGED");
  }
  verifyRebuildLineage(files, recipe);
  const report = { schemaVersion: "trial-runner/connection-check/v1", status: recipe.plan ? "validated" : "blocked",
    plan: recipe.plan, requirements: recipe.requirements, skill: recipe.skill,
    execution: "not_run", assistant: "not_invoked", sourceVerification: "recorded_not_rechecked" };
  return { report, files };
}

export async function loadConnection(filename: string, expectedSha256?: string) {
  try {
    const root = await repositoryRoot(path.dirname(path.resolve(filename)));
    const name = path.basename(filename);
    connectionPath(name);
    if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) fail("INVALID_CONNECTION_DIGEST");
    const bytes = await readPublic(root, name);
    if (expectedSha256 !== undefined && hash(bytes) !== expectedSha256) fail("CONNECTION_DIGEST_MISMATCH");
    const recipe = recipeContract(publicJson(bytes));
    if (recipe.files.some(f => f.path.toLowerCase() === name.toLowerCase())) fail("RECURSIVE_CONNECTION_INVENTORY");
    const { report, files } = await verifyConnectionContents(root, recipe);
    const check = { ...report, recipeSha256: hash(bytes) };
    return { root, bytes, recipe, files, check: connectionContract<typeof check>("check", check) };
  } catch (error) { if (error instanceof DiscoveryError) throw error; return fail("CONNECTION_CHECK_FAILED"); }
}

export async function checkConnection(filename: string, expectedSha256?: string) {
  return (await loadConnection(filename, expectedSha256)).check;
}

export async function connectRepository(directory: string, output: string) {
  let created: string | undefined;
  try {
    const root = await repositoryRoot(directory);
    const destination = await newDestination(root, output);
    const skill = await loadSetupSkill();
    await fs.mkdir(destination, { mode: 0o700 }); created = destination;
    const preparation = await prepareRepository(root, path.join(destination, "prepared"));
    const inspection = publicJson(await readPublic(destination, "prepared/inspection.json")) as unknown as DiscoveryReport;
    const files = [...preparation.outputs.map(f => ({ ...f, path: `prepared/${f.path}` })),
      record("prepared/preparation.json", await readPublic(destination, "prepared/preparation.json"))];
    for (const [name, bytes] of skill.files) {
      await writeAtomic(path.join(destination, "skill", name), bytes);
      files.push(record(`skill/${name}`, bytes));
    }
    const recipe: ConnectionRecipe = { schemaVersion: "trial-runner/connection-recipe/v1", id: "node-function-connection", method: "prepared-plan/v1",
      skill: skill.identity, sources: preparation.sources, files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      plan: preparation.plan ? { ...preparation.plan, path: "prepared/plan.json" } : null, requirements: inspection.unresolved };
    const { report: result } = await verifyConnectionContents(destination, recipe);
    const bytes = jsonBytes(recipe);
    // Final publication marker. Earlier errors remove only this exclusively created output.
    await writeAtomic(path.join(destination, "connection.json"), bytes);
    const report = { ...result, recipe: path.join(destination, "connection.json"), recipeSha256: hash(bytes) };
    return connectionContract<typeof report>("check", report);
  } catch (error) {
    if (created) await fs.rm(created, { recursive: true, force: true });
    if (error instanceof DiscoveryError) throw error;
    return fail("CONNECTION_PREPARATION_FAILED");
  }
}
