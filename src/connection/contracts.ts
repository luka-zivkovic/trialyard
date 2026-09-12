import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { FileRecord } from "../contracts/types.js";
import { parseJson } from "../contracts/strict-json.js";
import { fail } from "../discovery/safe.js";

export interface SkillIdentity { id: "connect-agent"; version: "0.1.0" | "0.2.0" | "0.3.0" | "0.3.1" | "0.3.2" | "0.4.0"; sha256: string; }
export interface SkillManifest {
  schemaVersion: "trial-runner/skill-package/v1";
  id: "connect-agent"; version: "0.1.0" | "0.2.0" | "0.3.0" | "0.3.1" | "0.3.2" | "0.4.0";
  recipeSchemaVersion: "trial-runner/connection-recipe/v1";
  entrypoint: "SKILL.md";
  references: { id: string; path: string; when: string }[];
}
export interface Requirement { code: string; message: string; }
export interface ConnectionRecipe {
  schemaVersion: "trial-runner/connection-recipe/v1";
  id: string;
  method: "prepared-plan/v1" | "manual-integration/v1";
  skill: SkillIdentity | null;
  sources: FileRecord[];
  files: FileRecord[];
  plan: { path: string; inputSha256: string } | null;
  requirements: Requirement[];
}

const schema = parseJson(readFileSync(new URL("../../../contracts/connection.schema.json", import.meta.url)));
const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
ajv.addSchema(schema as object, "connection");
const validators = new Map<string, ValidateFunction>();
export function connectionContract<T>(name: "recipe" | "skillManifest" | "check" | "context", value: unknown): T {
  let validate = validators.get(name);
  if (!validate) { validate = ajv.compile({ $ref: `connection#/$defs/${name}` }); validators.set(name, validate); }
  if (!validate(value)) fail(name === "recipe" ? "INVALID_CONNECTION_RECIPE" : "INVALID_SKILL_PACKAGE");
  return value as T;
}

// All paths in a public connection are checked before any referenced file is opened.
export function connectionPath(name: string): void {
  if (name.length > 256 || !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(name) || name.split("/").length > 16
    || name.split("/").some(p => !p || p.startsWith(".") || /^(node_modules|vendor)$/i.test(p)
      || /(^|[._-])(env|secrets?|credentials?|passwords?|tokens?|private|id_rsa|id_ed25519)([._-]|$)/i.test(p))) fail("UNSAFE_CONNECTION_PATH");
}
export function distinct(values: string[]): void {
  if (new Set(values.map(v => v.toLowerCase())).size !== values.length) fail("DUPLICATE_CONNECTION_IDENTITY");
}
export function recipeContract(value: unknown): ConnectionRecipe {
  const recipe = connectionContract<ConnectionRecipe>("recipe", value);
  for (const files of [recipe.files, recipe.sources]) {
    for (const file of files) connectionPath(file.path);
    distinct(files.map(f => f.path));
    if (files.reduce((n, f) => n + f.bytes, 0) > 64 * 1024 * 1024) fail("CONNECTION_BYTE_LIMIT");
  }
  distinct(recipe.requirements.map(r => r.code));
  if (recipe.requirements.some(r => !r.message.trim())) fail("INVALID_CONNECTION_REQUIREMENT");
  if (recipe.plan) {
    connectionPath(recipe.plan.path);
    if (recipe.method !== "prepared-plan/v1" || recipe.requirements.length || !recipe.files.some(f => f.path === recipe.plan!.path)) fail("CONTRADICTORY_CONNECTION_STATE");
  } else if (!recipe.requirements.length) fail("MISSING_CONNECTION_REQUIREMENT");
  return recipe;
}
