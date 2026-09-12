import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { contract } from "../contracts/validate.js";
import type { Plan } from "../contracts/types.js";
import { hash, jsonBytes, writeAtomic } from "../core/files.js";
import type { Preparation } from "../discovery/types.js";
import { DiscoveryError, FILE_LIMIT, fail, newDestination, publicJson, readPublic, record, repositoryRoot } from "../discovery/safe.js";
import { connectRepository, loadConnection, verifyConnectionContents } from "./recipe.js";
import { recipeContract } from "./contracts.js";
import { describeRebuild, REBUILD_PARENT, REBUILD_RECORD, rebuildResultContract, type RebuildResult } from "./rebuild-contract.js";

function supported(connection: Awaited<ReturnType<typeof loadConnection>>): void {
  // The recipe method alone does not imply compatibility with this source template.
  describeRebuild(connection.bytes, connection.recipe);
  const get = (name: string) => publicJson(connection.files.get(`prepared/${name}`) ?? fail("UNSUPPORTED_REBUILD_CONNECTION"));
  const plan = contract<Plan>("plan", get("plan.json"));
  const preparation = contract<Preparation>("preparation", get("preparation.json"));
  if (plan.agent.adapterId !== "template.node-function" || plan.agent.adapterVersion !== "1.0.0"
    || preparation.status !== "prepared" || preparation.plan?.inputSha256 !== connection.recipe.plan!.inputSha256
    || !isDeepStrictEqual(preparation.sources, connection.recipe.sources)) fail("UNSUPPORTED_REBUILD_CONNECTION");
  // Sources are byte claims, not permission to substitute a wrapper or a trial input.
  for (const file of connection.recipe.sources) {
    if (["package.json", "trial-runner.setup.json"].includes(file.path)) continue;
    const copy = connection.files.get(`prepared/candidate/${file.path}`);
    if (!copy || copy.length !== file.bytes || hash(copy) !== file.sha256) fail("REBUILD_SOURCE_MISMATCH");
  }
}

/** Refresh the declared Node runtime files while holding the trial configuration fixed. */
export async function rebuildConnection(filename: string, directory: string, output: string, expectedSha256?: string): Promise<RebuildResult> {
  let created: string | undefined;
  try {
    const parent = await loadConnection(filename, expectedSha256);
    supported(parent);
    const source = await repositoryRoot(directory);
    const destination = await newDestination(source, output);
    await newDestination(parent.root, destination);
    await fs.mkdir(destination, { mode: 0o700 }); created = destination;
    const staging = path.join(destination, "staging");
    const prepared = await connectRepository(source, staging);
    if (prepared.status !== "validated") fail("REBUILD_SOURCE_UNSUPPORTED");
    const fresh = await loadConnection(path.join(staging, "connection.json"), prepared.recipeSha256);
    supported(fresh);
    // Setup guidance is retained provenance, not candidate code. Updating the installed
    // skill must not prevent a source-only rebuild or silently replace the parent snapshot.
    for (const name of fresh.files.keys()) if (name.startsWith("skill/")) fresh.files.delete(name);
    for (const [name, bytes] of parent.files) if (name.startsWith("skill/")) fresh.files.set(name, bytes);
    fresh.recipe.skill = parent.recipe.skill;
    fresh.recipe.files = [...fresh.files].map(([name, bytes]) => record(name, bytes)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    // Regeneration is accepted only when every non-source input remains byte-identical.
    const rebuild = describeRebuild(parent.bytes, fresh.recipe);
    const recordBytes = jsonBytes(rebuild);
    const recipe = recipeContract({ ...fresh.recipe, files: [...fresh.recipe.files,
      record(REBUILD_PARENT, parent.bytes), record(REBUILD_RECORD, recordBytes)].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
    // Copy the verified bytes, never a second unbounded directory traversal.
    for (const [name, bytes] of fresh.files) await writeAtomic(path.join(destination, name), bytes);
    await writeAtomic(path.join(destination, REBUILD_PARENT), parent.bytes);
    await writeAtomic(path.join(destination, REBUILD_RECORD), recordBytes);
    await verifyConnectionContents(destination, recipe);
    await loadConnection(filename, parent.check.recipeSha256);
    for (const file of recipe.sources) {
      const bytes = await readPublic(source, file.path, FILE_LIMIT);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail("SOURCE_CHANGED");
    }
    await fs.rm(staging, { recursive: true });
    const bytes = jsonBytes(recipe);
    const result = rebuildResultContract({ schemaVersion: "trial-runner/connection-rebuild-result/v1", recipe: path.join(destination, "connection.json"),
      recipeSha256: hash(bytes), plan: recipe.plan!, record: rebuild });
    // Publish only a complete connection. Failures remove only our exclusively created output.
    await writeAtomic(result.recipe, bytes);
    return result;
  } catch (error) {
    if (created) await fs.rm(created, { recursive: true, force: true });
    if (error instanceof DiscoveryError) throw error;
    return fail("REBUILD_FAILED");
  }
}
