import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseJson } from "../contracts/strict-json.js";
import type { FileRecord } from "../contracts/types.js";
import { hash } from "../core/files.js";
import { fail, publicPath } from "../discovery/safe.js";
import { connectionPath, distinct, recipeContract, type ConnectionRecipe } from "./contracts.js";

export const REBUILD_RECORD = "rebuild/record.json";
export const REBUILD_PARENT = "rebuild/parent.json";
type Identity = Pick<FileRecord, "bytes" | "sha256">;
export interface FileChange { path: string; before: Identity | null; after: Identity | null; }
export interface RebuildRecord {
  schemaVersion: "trial-runner/connection-rebuild/v1";
  method: "node-function/v1";
  parentRecipeSha256: string;
  parentInputSha256: string;
  inputSha256: string;
  agentArtifact: { before: string; after: string };
  changes: { sources: FileChange[]; files: FileChange[] };
  preservedFiles: FileRecord[];
  execution: "not_run";
  sourceMode: "declared-files-only";
}
export interface RebuildResult {
  schemaVersion: "trial-runner/connection-rebuild-result/v1";
  recipe: string; recipeSha256: string;
  plan: { path: string; inputSha256: string };
  record: RebuildRecord;
}

const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
ajv.addSchema(parseJson(readFileSync(new URL("../../../contracts/connection.schema.json", import.meta.url))) as object);
ajv.addSchema(parseJson(readFileSync(new URL("../../../contracts/rebuild.schema.json", import.meta.url))) as object, "rebuild");
const recordShape = ajv.compile({ $ref: "rebuild#/$defs/record" });
const resultShape = ajv.compile({ $ref: "rebuild#/$defs/result" });

export function rebuildContract(value: unknown): RebuildRecord {
  if (!recordShape(value)) fail("INVALID_REBUILD_RECORD");
  const record = value as RebuildRecord;
  for (const list of [record.changes.sources, record.changes.files, record.preservedFiles]) {
    list.forEach(file => connectionPath(file.path));
    distinct(list.map(file => file.path));
    if (!isDeepStrictEqual(list.map(file => file.path), list.map(file => file.path).sort())) fail("INVALID_REBUILD_ORDER");
  }
  for (const change of [...record.changes.sources, ...record.changes.files]) {
    if (isDeepStrictEqual(change.before, change.after)) fail("INVALID_REBUILD_CHANGE");
  }
  return record;
}

export function rebuildResultContract(value: unknown): RebuildResult {
  if (!resultShape(value)) fail("INVALID_REBUILD_RESULT");
  const result = value as RebuildResult;
  rebuildContract(result.record);
  if (result.plan.inputSha256 !== result.record.inputSha256) fail("REBUILD_INPUT_MISMATCH");
  return result;
}

const lineageFile = (name: string) => name === REBUILD_RECORD || name === REBUILD_PARENT;
const sourceCode = (file: FileRecord) => !["package.json", "trial-runner.setup.json"].includes(file.path);
function changes(before: FileRecord[], after: FileRecord[]): FileChange[] {
  const a = new Map(before.map(file => [file.path, file])), b = new Map(after.map(file => [file.path, file]));
  const identity = (file: FileRecord | undefined): Identity | null => file ? { bytes: file.bytes, sha256: file.sha256 } : null;
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap(path => {
    const before = identity(a.get(path)), after = identity(b.get(path));
    return isDeepStrictEqual(before, after) ? [] : [{ path, before, after }];
  });
}

/** Only the source inventory and its derived metadata may change on this path. */
export function describeRebuild(parentBytes: Buffer, value: ConnectionRecipe): RebuildRecord {
  const parent = recipeContract(parseJson(parentBytes, 262144)), current = recipeContract(value);
  for (const recipe of [parent, current]) {
    if (recipe.method !== "prepared-plan/v1" || recipe.plan?.path !== "prepared/plan.json" || recipe.id !== "node-function-connection") fail("UNSUPPORTED_REBUILD_CONNECTION");
    recipe.sources.filter(sourceCode).forEach(file => publicPath(file.path));
  }
  const mutable = new Set(["prepared/agent-artifact.json", "prepared/setup-provenance.json", "prepared/inspection.json", "prepared/preparation.json",
    ...[...parent.sources, ...current.sources].filter(sourceCode).map(file => `prepared/candidate/${file.path}`)]);
  const preserved = (recipe: ConnectionRecipe) => recipe.files.filter(file => !mutable.has(file.path) && !lineageFile(file.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const preservedFiles = preserved(parent);
  if (!isDeepStrictEqual(preservedFiles, preserved(current)) || !isDeepStrictEqual(parent.skill, current.skill)) fail("REBUILD_CONFIGURATION_CHANGED");
  const artifact = (recipe: ConnectionRecipe) => recipe.files.find(file => file.path === "prepared/agent-artifact.json")?.sha256 ?? fail("UNSUPPORTED_REBUILD_CONNECTION");
  return rebuildContract({ schemaVersion: "trial-runner/connection-rebuild/v1", method: "node-function/v1",
    parentRecipeSha256: hash(parentBytes), parentInputSha256: parent.plan!.inputSha256, inputSha256: current.plan!.inputSha256,
    agentArtifact: { before: artifact(parent), after: artifact(current) },
    changes: { sources: changes(parent.sources, current.sources), files: changes(parent.files.filter(file => !lineageFile(file.path)), current.files.filter(file => !lineageFile(file.path))) },
    preservedFiles, execution: "not_run", sourceMode: "declared-files-only" });
}

export function verifyRebuildLineage(files: ReadonlyMap<string, Buffer>, recipe: ConnectionRecipe): void {
  if (!files.has(REBUILD_RECORD) && !files.has(REBUILD_PARENT)) return;
  const parent = files.get(REBUILD_PARENT), bytes = files.get(REBUILD_RECORD);
  if (!parent || !bytes) return fail("MISSING_REBUILD_LINEAGE");
  const actual = rebuildContract(parseJson(bytes, 1024 * 1024));
  if (!isDeepStrictEqual(actual, describeRebuild(parent, recipe))) fail("REBUILD_LINEAGE_MISMATCH");
}
