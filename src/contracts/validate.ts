import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import { parseJson } from "./strict-json.js";
import type { Snapshot } from "./types.js";

const schema = parseJson(readFileSync(new URL("../../../contracts/v1.schema.json", import.meta.url))) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
ajv.addSchema(schema, "contracts");
const validators = new Map<string, ValidateFunction>();

export class ContractValidationError extends Error {
  constructor(name: string, readonly issue: ErrorObject | undefined) {
    super(`Invalid ${name}: ${issue?.instancePath || "/"} ${issue?.message ?? "schema mismatch"}`);
  }
}

export function contract<T>(name: string, value: unknown): T {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({ $ref: `contracts#/$defs/${name}` });
    validators.set(name, validate);
  }
  if (!validate(value)) {
    const error = validate.errors?.[0];
    throw new ContractValidationError(name, error);
  }
  return value as T;
}

/** Deliberately bounded schema subset for operator-supplied tool/fixture schemas. */
export function dataValidator(schema: unknown): ValidateFunction {
  const keywords = new Set(["$schema", "title", "description", "type", "properties", "required", "additionalProperties",
    "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "enum", "const", "anyOf", "oneOf"]);
  let nodes = 0;
  const walk = (v: unknown, depth: number): void => {
    if (++nodes > 2000 || depth > 24) throw new Error("Adapter schema complexity limit exceeded");
    if (typeof v === "boolean") return;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid adapter schema");
    for (const [key, value] of Object.entries(v)) {
      if (!keywords.has(key)) throw new Error(`Unsupported adapter schema keyword: ${key}`);
      if (key === "properties") {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid schema properties");
        for (const child of Object.values(value)) walk(child, depth + 1);
      } else if (key === "items" || (key === "additionalProperties" && typeof value !== "boolean")) walk(value, depth + 1);
      else if (key === "anyOf" || key === "oneOf") {
        if (!Array.isArray(value)) throw new Error("Invalid schema alternatives");
        for (const child of value) walk(child, depth + 1);
      }
    }
  };
  if (Buffer.byteLength(JSON.stringify(schema)) > 65536) throw new Error("Adapter schema byte limit exceeded");
  walk(schema, 0);
  return new Ajv2020({ strict: true, allErrors: false, validateFormats: false }).compile(schema as AnySchema);
}

export function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

export function snapshotContract(value: unknown): Snapshot {
  const snapshot = contract<Snapshot>("snapshot", value);
  if (!Number.isFinite(Date.parse(snapshot.observedAt)) || (snapshot.stable && snapshot.pendingOperations.length !== 0)) throw new Error("Invalid snapshot observation metadata");
  return snapshot;
}

export function safeRelative(path: string, allowDot = false): void {
  if (allowDot && path === ".") return;
  if (!path || path.includes("\\") || path.includes(":") || path.includes("\0") || path.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error("Unsafe relative path");
  }
}
